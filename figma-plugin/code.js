// code.js - 智能布局版本

const PLUGIN_VERSION = '1.0.1'; // 插件版本号


// 🛡️ 全局错误处理，防止切换文件时崩溃
// Figma 插件没有 window.onerror，但我们可以尽量保护关键代码
let isPluginReady = false;


figma.showUI(__html__, { 
  width: 360, 
  height: 400,
  themeColors: true 
});

let currentFrame = null;
let screenshotCount = 0;
let screenshotIndex = 0; // 截屏图片计数器
let screenRecordingIndex = 0; // 录屏计数器
let cancelGifExport = false; // GIF导出取消标志
let serverCheckTimer = null; // Server 缓存检查超时计时器

// 时间线编辑器状态
let isTimelineEditorOpen = false;
let timelineFrameId = null;
let lastTimelineLayerIds = []; // 用于检测图层顺序变化
let structuralRefreshTimer = null; // debounce 定时器

// 刷新时间线图层列表（用于检测到增删/重排序时）
// force=true 时跳过 orderChanged 检查（由 documentchange 检测触发时使用）
async function refreshTimelineLayers(frame, force) {
  if (!frame || frame.type !== 'FRAME') return;
  
  try {
    const currentLayerIds = frame.children.map(c => c.id);
    
    if (!force) {
      const orderChanged = currentLayerIds.length !== lastTimelineLayerIds.length ||
        !lastTimelineLayerIds.every((id, i) => id === currentLayerIds[i]);
      if (!orderChanged) return;
    }
    
    lastTimelineLayerIds = currentLayerIds;
    
    // 重新导出所有图层（与初始加载逻辑一致：先尝试 exportAsync，失败再降级）
    const exportPromises = frame.children.map(async (child) => {
      try {
        const bytes = await child.exportAsync({
          format: 'PNG',
          constraint: { type: 'HEIGHT', value: 800 }
        });
        
        let videoId = null;
        let isVideoLayer = false;
        let originalFilename = null;
        let gifCacheId = null;
        
        try {
          const v = child.getPluginData('videoId');
          if (v) { videoId = v; isVideoLayer = true; }
        } catch (e) {}
        try {
          const o = child.getPluginData('originalFilename');
          if (o) originalFilename = o;
        } catch (e) {}
        try {
          const c = child.getPluginData('gifCacheId');
          if (c) gifCacheId = c;
        } catch (e) {}
        if (gifCacheId) isVideoLayer = true;
        
        if (!isVideoLayer && 'fills' in child && Array.isArray(child.fills)) {
          try {
            for (const fill of child.fills) {
              if (fill.type === 'VIDEO') { isVideoLayer = true; break; }
            }
          } catch (e) { isVideoLayer = true; }
        }
        
        if (!isVideoLayer) {
          const lowerName = (child.name || '').toLowerCase();
          const videoExts = ['.gif', '.mp4', '.mov', '.webm', '.avi', '.mkv'];
          const videoKw = ['screenrecording', 'video', 'gif'];
          if (videoExts.some(ext => lowerName.endsWith(ext)) ||
              videoKw.some(kw => lowerName.includes(kw))) {
            isVideoLayer = true;
          }
        }
        
        return {
          id: child.id,
          name: child.name,
          type: child.type,
          thumbnail: figma.base64Encode(bytes),
          width: child.width,
          height: child.height,
          x: child.x,
          y: child.y,
          isVideoLayer: isVideoLayer,
          videoId: videoId,
          originalFilename: originalFilename,
          gifCacheId: gifCacheId
        };
      } catch (err) {
        let safeName = '';
        try { safeName = child.name || ''; } catch (e) { safeName = '加载中...'; }
        let fallbackVideoId = null;
        let fallbackIsVideo = false;
        let fallbackOrigFilename = null;
        let fallbackGifCacheId = null;
        try { const v = child.getPluginData('videoId'); if (v) { fallbackVideoId = v; fallbackIsVideo = true; } } catch (e) {}
        try { const o = child.getPluginData('originalFilename'); if (o) fallbackOrigFilename = o; } catch (e) {}
        try { const c = child.getPluginData('gifCacheId'); if (c) fallbackGifCacheId = c; } catch (e) {}
        if (fallbackGifCacheId) fallbackIsVideo = true;
        if (!fallbackIsVideo) {
          try {
            if ('fills' in child && Array.isArray(child.fills)) {
              fallbackIsVideo = child.fills.some(f => f.type === 'VIDEO');
            }
          } catch (e) { fallbackIsVideo = true; }
        }
        return {
          id: child.id,
          name: safeName,
          type: child.type,
          thumbnail: null,
          isVideoLayer: fallbackIsVideo,
          videoId: fallbackVideoId,
          originalFilename: fallbackOrigFilename,
          gifCacheId: fallbackGifCacheId
        };
      }
    });
    
    const processedLayers = await Promise.all(exportPromises);
    
    figma.ui.postMessage({
      type: 'timeline-layers-refresh',
      layers: processedLayers,
      frameWidth: frame.width,
      frameHeight: frame.height
    });
  } catch (e) {
    console.warn('刷新时间线图层失败:', e);
  }
}

// 缓存最近同步的文件信息（用于 Video 手动拖入后的自动关联）
// Map<文件名, 文件元数据>
// 注意：重启插件会清空此缓存，只能匹配当前会话同步的文件
const recentSyncedFiles = new Map();
const RECENT_SYNCED_FILES_MAX = 200; // 最多保留 200 条，防止内存无限增长

// 安全地添加到 recentSyncedFiles（超出上限时淘汰最旧的条目）
function addRecentSyncedFile(key, value) {
  recentSyncedFiles.set(key, value);
  if (recentSyncedFiles.size > RECENT_SYNCED_FILES_MAX) {
    // Map 迭代顺序 = 插入顺序，删除最早的条目
    const firstKey = recentSyncedFiles.keys().next().value;
    recentSyncedFiles.delete(firstKey);
  }
}

// 从画板中已有的元素初始化计数器
// 🛡️ 使用 try-catch 保护，防止切换文件时出错
function initializeCounters() {
  try {
    const frame = findFrameByName("ScreenSync Screenshots");
    if (frame && frame.children) {
      let maxScreenshotIndex = 0;
      let maxScreenRecordingIndex = 0;
      
      frame.children.forEach(child => {
        if (child.name) {
          // 匹配 Screenshot_XXX 格式
          const screenshotMatch = child.name.match(/^Screenshot_(\d+)$/);
          if (screenshotMatch) {
            const index = parseInt(screenshotMatch[1], 10);
            if (index > maxScreenshotIndex) {
              maxScreenshotIndex = index;
            }
          }
          
          // 匹配 ScreenRecording_XXX 格式
          const recordingMatch = child.name.match(/^ScreenRecording_(\d+)$/);
          if (recordingMatch) {
            const index = parseInt(recordingMatch[1], 10);         
            if (index > maxScreenRecordingIndex) {
              maxScreenRecordingIndex = index;
            }
          }
        }
      });
      
      screenshotIndex = maxScreenshotIndex;
      screenRecordingIndex = maxScreenRecordingIndex;
    }
  } catch (e) {
    // 初始化计数器时出错（可能正在切换文件）
  }
}

// 🛡️ 延迟初始化，确保 Figma 文档已完全加载
setTimeout(() => {
  try {
    initializeCounters();
    isPluginReady = true;
  } catch (e) {
    isPluginReady = true; // 即使出错也标记为就绪，允许后续操作
  }
}, 100);

// 用户自定义尺寸设置（从设置中读取）
let customSizeSettings = {
  width: null,
  height: null,
  columns: null // 每行多少张，null 表示不换行（一直横着排）
};

// 初始化时加载保存的设置
(async function() {
  try {
    const width = await figma.clientStorage.getAsync('imageWidth');
    const height = await figma.clientStorage.getAsync('imageHeight');
    const columns = await figma.clientStorage.getAsync('frameColumns');
    customSizeSettings.width = width || null;
    customSizeSettings.height = height || null;
    customSizeSettings.columns = columns || null;
  } catch (error) {
    // 加载设置失败
  }
})();

// 配置
const CONFIG = {
  imageWidth: 440,  // 默认宽度，用于布局计算
  imageHeight: 956, // 默认高度，用于布局计算
  spacing: 30,
  columns: 3,
  maxWidth: 440,   // 最大宽度限制
  maxHeight: 956   // 最大高度限制
};

// 验证画板是否存在且在当前页面
// 🛡️ 完全保护，防止切换文件时崩溃
function isFrameValid() {
  if (!currentFrame) return false;
  
  try {
    const test = currentFrame.name;
    const page = figma.currentPage;
    if (!page || !page.children) return false;
    return page.children.includes(currentFrame);
  } catch (error) {
    return false;
  }
}

// 查找名为 "iPhone Screenshots" 的画板
// 🛡️ 使用 try-catch 保护，防止切换文件时出错
function findFrameByName(name) {
  try {
    const page = figma.currentPage;
    if (!page || !page.children) return null;
    for (const node of page.children) {
      if (node.type === 'FRAME' && node.name === name) {
        return node;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 确保有有效的画板
function ensureFrame() {
  // 先检查当前画板是否有效
  if (isFrameValid()) {
    return true;
  }
  
  // 尝试查找已存在的画板
  const existingFrame = findFrameByName("ScreenSync Screenshots");
  if (existingFrame) {
    currentFrame = existingFrame;
    
    // 确保画板使用 Auto Layout（如果还没有设置，或者设置不完整）
    if (currentFrame.layoutMode === 'NONE' || currentFrame.layoutMode !== 'HORIZONTAL') {
      currentFrame.layoutMode = 'HORIZONTAL';
    }
    
    // 确保 auto-layout 属性完整设置（无论是否刚启用）
    try {
      currentFrame.itemSpacing = 10;
      currentFrame.paddingLeft = 0;
      currentFrame.paddingRight = 0;
      currentFrame.paddingTop = 0;
      currentFrame.paddingBottom = 0;
      
      // 根据列数设置是否换行
      if (customSizeSettings.columns && customSizeSettings.columns > 0) {
        currentFrame.layoutWrap = 'WRAP';
        currentFrame.counterAxisSizingMode = 'AUTO';
        // 如果有子元素，根据第一个子元素的实际宽度计算；否则先使用 HUG，等第一张图片添加后再设置
        if (currentFrame.children.length > 0) {
          const firstChild = currentFrame.children[0];
          const itemWidth = firstChild.width;
          const itemSpacing = currentFrame.itemSpacing || 10;
          const frameWidth = (itemWidth * customSizeSettings.columns) + (itemSpacing * (customSizeSettings.columns - 1));
          currentFrame.layoutSizingHorizontal = 'FIXED';
          currentFrame.resize(frameWidth, currentFrame.height || 800);
        } else {
          // 还没有子元素，先使用 HUG，等第一张图片添加后再根据实际宽度设置
          currentFrame.layoutSizingHorizontal = 'HUG';
        }
      } else {
        currentFrame.layoutWrap = 'NO_WRAP';
        currentFrame.layoutSizingHorizontal = 'HUG';
      }
      
      // 高度始终自适应
      currentFrame.layoutSizingVertical = 'HUG';
    } catch (layoutError) {
      console.warn('   ⚠️  设置画板 Auto Layout 属性时出错:', layoutError.message);
      // 继续执行，不阻止使用画板
    }
    
    // 移除填充颜色
    currentFrame.fills = [];
    
    return true;
  }
  
  // 如果没有找到，创建新画板
  try {
    const frame = figma.createFrame();
    frame.name = "ScreenSync Screenshots";
    
    // 设置 Auto Layout：水平方向，间距10
    frame.layoutMode = 'HORIZONTAL';
    frame.itemSpacing = 10;
    frame.paddingLeft = 0;
    frame.paddingRight = 0;
    frame.paddingTop = 0;
    frame.paddingBottom = 0;
    
    // 如果设置了列数，启用换行
    if (customSizeSettings.columns && customSizeSettings.columns > 0) {
      frame.layoutWrap = 'WRAP';
      frame.counterAxisSizingMode = 'AUTO';
      // 创建画板时先使用 HUG 模式，等第一张图片添加后根据实际宽度设置
      // 这样可以确保画板宽度正好 hug 第一张图片的宽度
      frame.layoutSizingHorizontal = 'HUG';
    } else {
      // 不换行，一直横着排
      frame.layoutWrap = 'NO_WRAP';
      // 设置宽高自适应内容（HUG）
      frame.layoutSizingHorizontal = 'HUG';
    }
    
    // 高度始终自适应内容
    frame.layoutSizingVertical = 'HUG';
    
    // 在用户当前视图的正中间创建（初始位置，Auto Layout 会自动调整大小）
    frame.x = figma.viewport.center.x;
    frame.y = figma.viewport.center.y;
    
    // 移除填充颜色（透明背景）
    frame.fills = [];
    
    currentFrame = frame;
    figma.currentPage.appendChild(frame);
    
    return true;
  } catch (error) {
    return false;
  }
}

// 查找画板上第一个空位
function findFirstEmptyPosition() {
  if (!isFrameValid()) {
    return { col: 0, row: 0 };
  }
  
  const { imageWidth, imageHeight, spacing, columns } = CONFIG;
  
  // 获取画板内所有子节点
  const children = currentFrame.children;
  
  // 创建已占用位置的Set
  const occupiedPositions = new Set();
  
  children.forEach(child => {
    // 计算节点所在的格子位置
    const col = Math.round((child.x - spacing) / (imageWidth + spacing));
    const row = Math.round((child.y - spacing) / (imageHeight + spacing));
    
    // 检查节点是否还在画板范围内
    const isInFrame = 
      child.x >= 0 && 
      child.y >= 0 && 
      child.x < currentFrame.width && 
      child.y < currentFrame.height;
    
    if (isInFrame && col >= 0 && row >= 0) {
      occupiedPositions.add(`${col},${row}`);
    }
  });
  
  // 按行优先顺序查找第一个空位
  let maxRow = Math.ceil(children.length / columns) + 1;
  
  for (let row = 0; row < maxRow; row++) {
    for (let col = 0; col < columns; col++) {
      const posKey = `${col},${row}`;
      if (!occupiedPositions.has(posKey)) {
        return { col, row };
      }
    }
  }
  
  return { col: 0, row: maxRow };
}

// 计算位置的像素坐标
function getPixelPosition(col, row) {
  const { imageWidth, imageHeight, spacing } = CONFIG;
  return {
    x: col * (imageWidth + spacing) + spacing,
    y: row * (imageHeight + spacing) + spacing
  };
}

// 自动调整画板大小以容纳所有内容
function adjustFrameSize() {
  if (!isFrameValid()) return;
  
  const { imageWidth, imageHeight, spacing, columns } = CONFIG;
  const children = currentFrame.children;
  
  if (children.length === 0) return;
  
  let maxCol = 0;
  let maxRow = 0;
  
  children.forEach(child => {
    const col = Math.round((child.x - spacing) / (imageWidth + spacing));
    const row = Math.round((child.y - spacing) / (imageHeight + spacing));
    
    if (col > maxCol) maxCol = col;
    if (row > maxRow) maxRow = row;
  });
  
  const newWidth = Math.max(
    1200,
    (maxCol + 1) * (imageWidth + spacing) + spacing
  );
  const newHeight = Math.max(
    800,
    (maxRow + 1) * (imageHeight + spacing) + spacing
  );
  
  if (newWidth !== currentFrame.width || newHeight !== currentFrame.height) {
    currentFrame.resize(newWidth, newHeight);
  }
}

figma.ui.onmessage = async (msg) => {
  // 🛡️ 全局 try-catch 保护，防止任何消息处理错误导致插件崩溃
  try {
    if (!msg || !msg.type) {
      return;
    }
    
  
  // ✅ 处理UI返回的跳过文件缓存数据
  if (msg.type === 'skipped-file-cache-response') {
    if (msg.cacheData) {
      // 将缓存数据添加到 recentSyncedFiles，以便导出时使用
      addRecentSyncedFile(msg.filename, {
        originalFilename: msg.filename,
        gifCacheId: msg.cacheData.gifCacheId || null,
        driveFileId: msg.cacheData.driveFileId || null,
        ossFileId: msg.cacheData.ossFileId || null,
        timestamp: msg.cacheData.timestamp
      });
      
      // 如果有nodeId，说明是从documentchange监听器触发的，需要自动关联到节点
      if (msg.nodeId) {
        try {
          const node = figma.getNodeById(msg.nodeId);
          
          if (node && node.type === 'RECTANGLE') {
            node.setPluginData('originalFilename', msg.filename);
            
            if (msg.cacheData.driveFileId) {
              node.setPluginData('driveFileId', msg.cacheData.driveFileId);
            }
            
            if (msg.cacheData.ossFileId) {
              node.setPluginData('ossFileId', msg.cacheData.ossFileId);
            }
            
            if (msg.cacheData.gifCacheId) {
              node.setPluginData('gifCacheId', msg.cacheData.gifCacheId);
            }
          }
        } catch (error) {
          console.error('自动关联失败:', error);
        }
      }
    }
    return;
  }
  
  // 处理强制关闭插件（单实例限制）
  if (msg.type === 'close-plugin') {
    figma.closePlugin();
    return;
  }

  if (msg.type === 'restart-plugin') {
    figma.showUI(__html__, { width: 360, height: 400, themeColors: true });
    return;
  }

  // 处理取消GIF导出
  if (msg.type === 'cancel-gif-export') {
    cancelGifExport = true;
    return;
  }

  // ✅ 处理 Server 缓存检查结果
  if (msg.type === 'server-cache-check-result') {
    // ✅ 清除超时计时器
    if (serverCheckTimer) {
      clearTimeout(serverCheckTimer);
      serverCheckTimer = null;
    }
    let updatedCount = 0;
    
    for (const res of msg.results) {
      if (res.found && res.layerId) {
        const node = figma.getNodeById(res.layerId);
        if (node) {
          if (res.gifCacheId) node.setPluginData('gifCacheId', res.gifCacheId);
          if (res.driveFileId) node.setPluginData('driveFileId', res.driveFileId);
          if (res.ossFileId) node.setPluginData('ossFileId', res.ossFileId);
          updatedCount++;
        }
      }
    }
    
    // ✅ 只有在导出流程中才触发导出，自动关联场景不触发
    if (msg.fromExport) {
      // 重新触发导出，但跳过检查以避免死循环（如果有剩下的确实没找到）
      figma.ui.postMessage({
        type: 'trigger-export-from-code',
        skipServerCheck: true
      });
    }
    return;
  }

  // 处理导出带标注的 GIF
  if (msg.type === 'export-annotated-gif') {
    // 重置取消标志
    cancelGifExport = false;
    
    try {
      let selection = figma.currentPage.selection;
      
      // 如果传入了 frameId（来自时间线编辑），优先使用它
      if (msg.frameId) {
        const frameFromId = figma.getNodeById(msg.frameId);
        if (frameFromId && frameFromId.type === 'FRAME') {
          selection = [frameFromId];
          // 同时更新 Figma 的选择，确保一致性
          figma.currentPage.selection = selection;
        }
      }
      
      // 检查是否选中了节点
      if (!selection || selection.length === 0) {
        figma.ui.postMessage({
          type: 'export-gif-error',
          error: '请先选择包含 GIF 的 Frame'
        });
        return;
      }
      
      // 🛡️ 安全获取节点填充（避免访问无效 VIDEO 节点导致 "An invalid video was removed" 错误）
      function safeGetFills(node) {
        try {
          if (!node) return null;
          const t = node.type;
          if (t === 'VIDEO' || t === 'PAGE' || t === 'DOCUMENT') return null;
          if (!('fills' in node)) return null;
          const fills = node.fills;
          if (!fills || fills.length === 0) return null;
          return fills;
        } catch (e) {
          console.warn('⚠️ 无法安全访问节点填充:', node && node.name, e.message);
          return null;
        }
      }
      
      // 递归查找 Frame 中的所有 GIF 图层（支持嵌套结构）
      async function findAllGifLayers(node, results = []) {
        // 检查当前节点
        let filename = node.getPluginData('originalFilename');
        let isManualDrag = false;
        let isGifDetected = false;
        
        // 🛡️ 安全获取填充，避免访问无效 VIDEO 节点
        const fills = safeGetFills(node);
        
        // ✅ 优化：即使有 originalFilename，也尝试通过字节检测确认是否是 GIF
        // 这能处理文件名没有扩展名或扩展名不正确的情况
        if (fills) {
          const fill = fills[0];
          
          // 检查 IMAGE 填充（通过字节头识别 GIF）
          if (fill.type === 'IMAGE' && fill.imageHash) {
            try {
              const image = figma.getImageByHash(fill.imageHash);
              if (image) {
                const bytes = await image.getBytesAsync();
                // 检查 GIF 魔法数 (GIF89a 或 GIF87a) -> 'GIF' (0x47, 0x49, 0x46)
                if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
                  isGifDetected = true;
                }
              }
            } catch (e) {
              // Ignore error
            }
          }
        }
        
        // 如果 bytes 检测未命中，但 originalFilename 或节点名以 .gif 结尾，
        // 仍然视为 GIF（Figma 可能把静态 GIF 转成 PNG 存储）
        if (!isGifDetected && filename && filename.toLowerCase().endsWith('.gif')) {
          isGifDetected = true;
        }
        if (!isGifDetected && !filename && node.name && node.name.toLowerCase().endsWith('.gif')) {
          isGifDetected = true;
          filename = node.name;
        }
        
        if (isGifDetected) {
          const driveFileId = node.getPluginData('driveFileId');
          const ossFileId = node.getPluginData('ossFileId');
          const gifCacheId = node.getPluginData('gifCacheId');
          
          if (driveFileId || ossFileId || gifCacheId) {
            isManualDrag = false;
          } else {
            isManualDrag = true;
          }
          
          if (!filename) {
            filename = node.name;
            if (!filename.toLowerCase().endsWith('.gif')) {
              filename = filename + '.gif';
            }
          }
        }
        
        // 如果没有 originalFilename，且不是 GIF，继续检查是否是手动拖入的视频
        if (!filename && !isGifDetected && fills) {
          const fill = fills[0];
          
          // 方法 1：检查 VIDEO 填充
          if (fill.type === 'VIDEO') {
              // 可能是手动拖入的视频，也可能是手机同步的视频，也可能是已自动缓存的
              const driveFileId = node.getPluginData('driveFileId');
              const ossFileId = node.getPluginData('ossFileId');
              const gifCacheId_v = node.getPluginData('gifCacheId');
              
              if (driveFileId || ossFileId || gifCacheId_v) {
                // 已有关联数据（手机同步 或 自动缓存），不是需要手动上传的
                isManualDrag = false;
              } else {
                // 可能是手动拖入的视频，尝试从UI缓存中查找
                
                // 请求UI返回缓存数据
                figma.ui.postMessage({
                  type: 'request-skipped-file-cache',
                  filename: node.name
                });
                
                // 注意：这里是异步的，我们需要等待UI返回数据
                // 为了保持同步流程，我们先尝试从 recentSyncedFiles 缓存中查找
                
                // 打印所有缓存键值（仅调试用）
                if (recentSyncedFiles.size > 0) {
                }

                // 1. 直接匹配
                let cachedInfo = recentSyncedFiles.get(node.name) || recentSyncedFiles.get(filename);
                
                // 2. 如果没找到，尝试模糊匹配 (忽略扩展名和大小写)
                if (!cachedInfo) {
                  const targetName = node.name.toLowerCase().replace(/\.[^/.]+$/, ""); // 去后缀转小写
                  
                  for (const [key, info] of recentSyncedFiles.entries()) {
                    const keyName = key.toLowerCase().replace(/\.[^/.]+$/, "");
                    if (keyName === targetName) {
                      cachedInfo = info;
                      break;
                    }
                  }
                }
                
                if (cachedInfo) {
                  // 自动关联数据
                  node.setPluginData('driveFileId', cachedInfo.driveFileId || '');
                  node.setPluginData('ossFileId', cachedInfo.ossFileId || '');
                  node.setPluginData('gifCacheId', cachedInfo.gifCacheId || '');
                  node.setPluginData('originalFilename', cachedInfo.originalFilename);
                  
                  isManualDrag = false;
                } else {
                  isManualDrag = true;
                }
              }
              
              filename = node.name;
              
              // 尝试从图层名称推断扩展名
              if (!filename.toLowerCase().endsWith('.mp4') && !filename.toLowerCase().endsWith('.mov')) {
                filename = filename + '.mov';
              }
            }
            // 注意：IMAGE 填充的 GIF 检测已在函数开头处理
        }
        
        if (filename && (isGifDetected || filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov') || filename.toLowerCase().endsWith('.gif'))) {
          const hasValidExtension = filename.toLowerCase().endsWith('.gif') || 
                                   filename.toLowerCase().endsWith('.mov') || 
                                   filename.toLowerCase().endsWith('.mp4');
          const isScreenRecordingLayer = node.name && node.name.startsWith('ScreenRecording_');
          const filenameIndicatesRecording = filename.includes('ScreenRecording');
          
          if (hasValidExtension || isScreenRecordingLayer || filenameIndicatesRecording || isGifDetected) {
            if (isManualDrag && !node.getPluginData('originalFilename')) {
              node.setPluginData('originalFilename', filename);
            }
            
            results.push({ layer: node, filename: filename });
          }
        }
        
        // 递归检查子节点
        if ('children' in node) {
          for (const child of node.children) {
            await findAllGifLayers(child, results);
          }
        }
        
        return results;
      }

      // 1. 筛选出有效的 GIF Frame
      const validTasks = [];
      const invalidNodes = [];

      for (const node of selection) {
        if (node.type !== 'FRAME') {
          invalidNodes.push(node);
          continue;
        }

        const gifLayers = await findAllGifLayers(node);
        if (gifLayers.length > 0) {
          validTasks.push({
            frame: node,
            gifLayers: gifLayers // 所有 GIF 图层
          });
        } else {
          invalidNodes.push(node);
        }
      }

      // 2. 检查是否有可导出的内容
      if (validTasks.length === 0) {
        figma.ui.postMessage({
          type: 'export-gif-error',
          error: '没有可导出的 GIF'
        });
        return;
      }

      // 3. 检查是否有需要在导出前校验的数据来源
      // 规则：只要缺少云端 ID（drive/oss），都先走一次缓存存在性检查
      // 这样可以拦截“有 gifCacheId 但缓存已丢失/跨设备不可用”的情况，避免误进导出选项。
      const unsyncedGifs = [];
      for (const task of validTasks) {
        for (const gifLayer of task.gifLayers) {
          const driveFileId = gifLayer.layer.getPluginData('driveFileId');
          const ossFileId = gifLayer.layer.getPluginData('ossFileId');
          const gifCacheId = gifLayer.layer.getPluginData('gifCacheId');
          const originalFilename = gifLayer.layer.getPluginData('originalFilename');
          
          // 导出阶段：有 gifCacheId 说明早期检查已验证过缓存，无需重复拦截
          if (!driveFileId && !ossFileId && !gifCacheId) {
            unsyncedGifs.push({
              layerId: gifLayer.layer.id,
              layerName: gifLayer.layer.name,
              filename: originalFilename || gifLayer.layer.name,
              frameId: task.frame.id,
              frameName: task.frame.name,
              gifCacheId: null
            });
          }
        }
      }
      
      // 如果有未同步的 GIF，先尝试从服务器检查缓存
      if (unsyncedGifs.length > 0) {
        // 如果是强制跳过检查（例如已经检查过一次了），则直接请求上传
        if (msg.skipServerCheck) {
          figma.ui.postMessage({
            type: 'request-upload-gifs',
            unsyncedGifs: unsyncedGifs
          });
          return; // 停止导出流程，等待用户上传
        }

        figma.ui.postMessage({
          type: 'check-server-cache-for-unsynced',
          unsyncedGifs: unsyncedGifs
        });

        // ✅ 设置超时保护 (2秒)
        if (serverCheckTimer) clearTimeout(serverCheckTimer);
        serverCheckTimer = setTimeout(() => {
          serverCheckTimer = null;
          // 通知 UI 重新触发导出，并跳过 Server 检查
          figma.ui.postMessage({
            type: 'trigger-export-from-code',
            skipServerCheck: true
          });
        }, 2000);

        return; // 停止导出流程，等待异步检查结果
      }

      // 4. 通知 UI 开始批量导出
      figma.ui.postMessage({
        type: 'export-batch-start',
        total: validTasks.length
      });

      // 5. 依次处理每个任务
      for (let i = 0; i < validTasks.length; i++) {
        // 检查是否被取消
        if (cancelGifExport) {
          figma.ui.postMessage({ type: 'export-gif-cancelled' });
          return;
        }
        
        const task = validTasks[i];
        const { frame, gifLayers } = task;

        // 计算图层相对于顶层 Frame 的绝对坐标
        function getAbsolutePosition(node, targetFrame) {
          let absX = 0;
          let absY = 0;
          let current = node;
          
          while (current && current !== targetFrame) {
            absX += current.x;
            absY += current.y;
            current = current.parent;
          }
          
          return { x: absX, y: absY };
        }
        
        // 🖥️ GIF 导出尺寸上限：长边最大 1920px，在 Figma 端预缩放
        // 比服务端 resize 更稳定、更高效：所有 PNG 天然就是正确尺寸
        const MAX_GIF_DIMENSION = 1920;
        const frameLongerSide = Math.max(frame.width, frame.height);
        const exportScale = frameLongerSide > MAX_GIF_DIMENSION ? MAX_GIF_DIMENSION / frameLongerSide : 1;
        if (exportScale < 1) {
          console.log(`📐 尺寸超限，预缩放: ${frame.width}×${frame.height} → ${Math.round(frame.width * exportScale)}×${Math.round(frame.height * exportScale)} (${Math.round(exportScale * 100)}%)`);
        }
        
        // 收集所有 GIF 图层的信息
        const gifInfos = gifLayers.map((gif, idx) => {
          const layer = gif.layer;
          
          // 计算绝对位置
          const absolutePos = getAbsolutePosition(layer, frame);
          const bounds = {
            x: Math.round(absolutePos.x * exportScale),
            y: Math.round(absolutePos.y * exportScale),
            width: Math.round(layer.width * exportScale),
            height: Math.round(layer.height * exportScale)
          };
          
          // 获取圆角信息 (支持所有可能有圆角的节点类型)
          let cornerRadius = 0;
          if (layer.cornerRadius !== undefined) {
            // cornerRadius 可能是单个数值或者混合圆角对象
            if (typeof layer.cornerRadius === 'number') {
              cornerRadius = Math.round(layer.cornerRadius * exportScale);
            } else if (layer.topLeftRadius !== undefined) {
              // 混合圆角，取最大值作为统一圆角（简化处理）
              cornerRadius = Math.round(Math.max(
                layer.topLeftRadius || 0,
                layer.topRightRadius || 0,
                layer.bottomLeftRadius || 0,
                layer.bottomRightRadius || 0
              ) * exportScale);
            }
          }
          
          // 检测裁切：检查父容器是否开启了clipsContent
          let clipBounds = null;
          let clipCornerRadius = 0; // 新增：裁切容器的圆角
          let parent = layer.parent;
          
          // 遍历父级，包括导出的 Frame 本身（如果 Frame 开启了 Clip content）
          while (parent) {
            if (parent.clipsContent === true) {
              // 找到了裁切容器，计算裁切区域
              const parentAbsPos = getAbsolutePosition(parent, frame);
              clipBounds = {
                x: Math.round(parentAbsPos.x * exportScale),
                y: Math.round(parentAbsPos.y * exportScale),
                width: Math.round(parent.width * exportScale),
                height: Math.round(parent.height * exportScale)
              };
              
              // 获取裁切容器的圆角 (支持所有节点类型)
              if (parent.cornerRadius !== undefined) {
                if (typeof parent.cornerRadius === 'number') {
                  clipCornerRadius = Math.round(parent.cornerRadius * exportScale);
                } else if (parent.topLeftRadius !== undefined) {
                   clipCornerRadius = Math.round(Math.max(
                      parent.topLeftRadius || 0,
                      parent.topRightRadius || 0,
                      parent.bottomLeftRadius || 0,
                      parent.bottomRightRadius || 0
                    ) * exportScale);
                }
              }
              
              break; // 只取最近的裁切容器
            }
            
            // 如果已经到达导出的 Frame，停止向上遍历
            if (parent === frame) break;
            parent = parent.parent;
          }

          // 获取 Image Fill 信息（特别是针对 Crop 模式）
          // 🛡️ 使用 try-catch 保护，避免访问无效 VIDEO 节点导致错误
          let imageFillInfo = null;
          try {
            if (layer.fills && layer.fills.length > 0) {
               // 强制获取最新的 fill 信息
               const fills = layer.fills;
               for (const fill of fills) {
                  // ✅ 支持 IMAGE 和 VIDEO 类型（Video 图层也有 imageTransform！）
                  if ((fill.type === 'IMAGE' || fill.type === 'VIDEO') && fill.visible !== false) {
                     // 手动转换 Transform 对象为普通数组
                     let transformArray = null;
                     
                     if (fill.imageTransform) {
                        try {
                          transformArray = [
                             [fill.imageTransform[0][0], fill.imageTransform[0][1], fill.imageTransform[0][2]],
                             [fill.imageTransform[1][0], fill.imageTransform[1][1], fill.imageTransform[1][2]]
                          ];
                        } catch (e) {
                          // Ignore transform conversion error
                        }
                     }
                     
                     imageFillInfo = {
                        scaleMode: fill.scaleMode, // FILL, FIT, CROP, TILE
                        // 强制转为 JSON 字符串传输，避免 WebSocket/postMessage 序列化问题
                        imageTransform: transformArray ? JSON.stringify(transformArray) : null,
                        scalingFactor: fill.scalingFactor || 1
                     };
                     break;
                  }
               }
            }
          } catch (fillAccessErr) {
            console.warn('⚠️ 无法访问图层填充信息:', layer.name, fillAccessErr.message);
          }
          
          // 获取该 GIF 在 frame.children 中的索引（z-index）
          const zIndex = Array.from(frame.children).indexOf(layer);
          
          // 获取 imageHash（用于手动上传的文件查找）
          const imageHash = layer.getPluginData('imageHash');
          const driveFileId = layer.getPluginData('driveFileId');
          const ossFileId = layer.getPluginData('ossFileId');
          
          return {
            filename: gif.filename,
            cacheId: layer.getPluginData('gifCacheId'),
            imageHash: imageHash, // ✅ 传递 imageHash（手动上传文件的关键标识）
            driveFileId: driveFileId, // ✅ 传递 driveFileId
            ossFileId: ossFileId, // ✅ 传递 ossFileId
            bounds: bounds,
            cornerRadius: cornerRadius,
            clipBounds: clipBounds,
            clipCornerRadius: clipCornerRadius, // 传递裁切容器圆角
            imageFillInfo: imageFillInfo, // 传递 Fill 信息
            zIndex: zIndex, // ✅ 添加 z-index，用于正确的图层顺序合成
            layerId: layer.id // ✅ Pass layerId
          };
        });
        
        // 获取Frame的背景填充信息
        let frameBackground = null;
        if (frame.fills && frame.fills.length > 0 && frame.fills !== figma.mixed) {
          const fill = frame.fills[0];
          if (fill.type === 'SOLID' && fill.visible !== false) {
            frameBackground = {
              r: Math.round(fill.color.r * 255),
              g: Math.round(fill.color.g * 255),
              b: Math.round(fill.color.b * 255),
              a: fill.opacity !== undefined ? fill.opacity : 1
            };
          }
        }
        
        // 临时移除Frame的背景填充，避免背景色覆盖GIF
        const originalFills = frame.fills;
        frame.fills = [];
        
        // 找到所有 GIF 图层在 Frame.children 中的索引
        const gifIndices = gifLayers.map(gif => {
          const index = Array.from(frame.children).indexOf(gif.layer);
          return index;
        }).filter(idx => idx !== -1);
        
        // 找到最底层的 GIF（索引最小）
        const lowestGifIndex = Math.min(...gifIndices);
        
        // 🛡️ 安全设置/获取图层可见性
        // ✅ 关键：视频/GIF 节点不用 visible 属性，改用 opacity 隐藏
        // 原因：对视频节点设置 visible=true 会触发 Figma 内部视频数据校验，
        //       如果视频数据未完全加载或已失效，Figma 会直接删除该节点
        //       ("An invalid video was removed")。
        //       设置 opacity=0 只改变渲染透明度，不触发视频数据校验。
        
        // 收集所有 GIF/视频图层的 ID（这些节点不能用 visible 切换）
        const videoGifNodeIds = new Set();
        gifIndices.forEach(idx => {
          try {
            videoGifNodeIds.add(frame.children[idx].id);
          } catch (e) {}
        });
        // 额外检查其他可能的视频节点（不在 gifIndices 中但有 VIDEO fill）
        frame.children.forEach(child => {
          try {
            if (child.getPluginData && child.getPluginData('videoId')) {
              videoGifNodeIds.add(child.id);
            }
          } catch (e) {}
        });
        
        function safeGetVisible(child) {
          try {
            return child.visible;
          } catch (e) {
            return true;
          }
        }
        
        // 保存视频/GIF 节点的原始 opacity（用于后续恢复）
        const videoGifOriginalOpacity = new Map();
        
        function safeSetVisible(child, visible) {
          try {
            if (videoGifNodeIds.has(child.id)) {
              // 🛡️ 视频/GIF 节点：用 opacity 替代 visible
              // 避免触发 Figma 的视频验证机制
              if (!visible) {
                // 隐藏：保存原始 opacity，设为 0
                if (!videoGifOriginalOpacity.has(child.id)) {
                  videoGifOriginalOpacity.set(child.id, child.opacity);
                }
                child.opacity = 0;
              } else {
                // 恢复：还原原始 opacity
                const originalOpacity = videoGifOriginalOpacity.get(child.id);
                if (originalOpacity !== undefined) {
                  child.opacity = originalOpacity;
                  videoGifOriginalOpacity.delete(child.id);
                } else {
                  child.opacity = 1;
                }
              }
            } else {
              // 非视频节点：正常使用 visible 属性
              child.visible = visible;
            }
          } catch (e) {
            console.warn('⚠️ 无法设置图层可见性:', child && child.name);
          }
        }
        
        // 保存所有图层的原始可见性
        const allLayersVisibility = new Map();
        frame.children.forEach(child => {
          allLayersVisibility.set(child.id, safeGetVisible(child));
        });
        
        const highestGifIndex = Math.max(...gifIndices);
        
        // 🎬 判断是否有时间线编辑数据
        const hasTimelineEdits = msg.timelineData && Object.keys(msg.timelineData).length > 0 &&
                                 Object.values(msg.timelineData).some(range => range.start > 0 || range.end < 100);
        
        // 只有当 GIF 下面有图层时才导出 Bottom Layer
        let bottomLayerBytes = null;
        if (lowestGifIndex > 0 && !hasTimelineEdits) {
          // 🎬 非时间线模式：合并GIF下方所有图层为一张图（更快）
          // 隐藏 >= lowestGifIndex 的所有图层（包括 GIF 和 GIF 上面的）
          frame.children.forEach((child, index) => {
            if (index >= lowestGifIndex) {
              safeSetVisible(child, false);
            }
          });
          
          bottomLayerBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: exportScale }
          });
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            safeSetVisible(child, allLayersVisibility.get(child.id));
          });
        }
        
        // 收集所有非 GIF 图层的信息（包括它们的 z-index）
        // staticLayers: GIF 之间的图层
        // annotationLayers: GIF 之上/之下的图层（支持时间线控制）
        const staticLayers = [];
        const annotationLayers = [];
        frame.children.forEach((child, index) => {
          const isGif = gifIndices.includes(index);
          if (isGif) return; // 跳过 GIF 图层
          
          if (hasTimelineEdits) {
            // 🎬 时间线编辑模式：所有非 GIF 图层都单独导出，支持时间线控制
            // 不管在 GIF 上方还是下方，都作为独立图层
            if (index < lowestGifIndex) {
              // GIF 下方的图层 → 也作为 annotationLayers 导出（支持时间线控制）
              annotationLayers.push({
                index: index,
                name: child.name,
                type: child.type,
                layerId: child.id
              });
            } else if (index >= lowestGifIndex && index <= highestGifIndex) {
              // GIF 之间的静态图层
              staticLayers.push({
                index: index,
                name: child.name,
                type: child.type,
                layerId: child.id
              });
            } else {
              // GIF 之上的图层
              annotationLayers.push({
                index: index,
                name: child.name,
                type: child.type,
                layerId: child.id
              });
            }
          } else {
            // 非时间线模式：保持原有分类逻辑
            if (index >= lowestGifIndex && index <= highestGifIndex) {
              staticLayers.push({
                index: index,
                name: child.name,
                type: child.type,
                layerId: child.id
              });
            } else if (index > highestGifIndex) {
              annotationLayers.push({
                index: index,
                name: child.name,
                type: child.type,
                layerId: child.id
              });
            }
          }
        });
        
        // 🛡️ 安全导出单个图层（带延迟和重试，确保 visibility 切换后渲染完成）
        async function safeExportLayer(frame, layerInfo, allLayersVisibility, label) {
          // 只显示当前图层，隐藏其他所有图层
          frame.children.forEach((child, index) => {
            safeSetVisible(child, index === layerInfo.index);
          });
          
          // ✅ 关键：等待 Figma 渲染管线更新 visibility 状态
          // 快速切换 visibility 后立刻 exportAsync 可能导致导出空白内容
          await new Promise(resolve => setTimeout(resolve, 50));
          
          let layerBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: exportScale }
          });
          
          // 🛡️ 验证导出结果：PNG 文件头至少 67 字节，空白透明 PNG 通常 < 200 字节
          // 如果导出数据异常小，说明可能 visibility 没生效，重试一次
          if (!layerBytes || layerBytes.length < 200) {
            console.warn(`⚠️ ${label} "${layerInfo.name}" 导出数据过小 (${layerBytes ? layerBytes.length : 0} bytes)，等待后重试...`);
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // 重新设置 visibility 并重试
            frame.children.forEach((child, index) => {
              safeSetVisible(child, index === layerInfo.index);
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const retryBytes = await frame.exportAsync({
              format: 'PNG',
              constraint: { type: 'SCALE', value: exportScale }
            });
            
            if (retryBytes && retryBytes.length > layerBytes.length) {
              layerBytes = retryBytes;
              console.log(`   ✅ 重试成功: ${label} "${layerInfo.name}" (${retryBytes.length} bytes)`);
            }
          }
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            safeSetVisible(child, allLayersVisibility.get(child.id));
          });
          
          return layerBytes;
        }
        
        // 导出每个静态图层
        const staticLayerExports = [];
        for (const layerInfo of staticLayers) {
          const layerBytes = await safeExportLayer(frame, layerInfo, allLayersVisibility, '静态图层');
          
          staticLayerExports.push({
            index: layerInfo.index,
            name: layerInfo.name,
            bytes: Array.from(layerBytes),
            layerId: layerInfo.layerId
          });
        }
        
        // 导出每个标注图层（GIF 之上的图层，支持时间线控制）
        const annotationLayerExports = [];
        for (const layerInfo of annotationLayers) {
          const layerBytes = await safeExportLayer(frame, layerInfo, allLayersVisibility, '标注图层');
          
          annotationLayerExports.push({
            index: layerInfo.index,
            name: layerInfo.name,
            bytes: Array.from(layerBytes),
            layerId: layerInfo.layerId
          });
        }
        
        // 如果没有单独的标注图层，则使用传统的合成方式导出
        let annotationBytes = null;
        if (annotationLayerExports.length === 0) {
          // 隐藏 <= 最高 GIF 索引的所有图层（包括 GIF 和 GIF 下面的）
          frame.children.forEach((child, index) => {
            if (index <= highestGifIndex) {
              safeSetVisible(child, false);
            }
          });
          
          annotationBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: exportScale }
          });
        }
        
        // 恢复Frame的背景填充
        frame.fills = originalFills;
        
        // 恢复所有图层的可见性
        frame.children.forEach(child => {
          safeSetVisible(child, allLayersVisibility.get(child.id));
        });
        
        // 发送到服务器进行合成
        const payload = {
          type: 'compose-annotated-gif',
          frameName: frame.name,
          bottomLayerBytes: bottomLayerBytes ? Array.from(bottomLayerBytes) : null,     // 最底层 GIF 下面的图层
          staticLayers: staticLayerExports,                                              // 静态图层（按 z-index 排序）
          annotationLayers: annotationLayerExports,                                      // ✅ 标注图层（GIF 之上，支持时间线）
          annotationBytes: annotationBytes ? Array.from(annotationBytes) : null,         // 兼容：如果没有单独标注图层则使用合成
          frameBounds: {
            width: Math.round(frame.width * exportScale),
            height: Math.round(frame.height * exportScale)
          },
          frameBackground: frameBackground, // Frame的背景色
          gifInfos: gifInfos, // 所有 GIF 的信息（包含每个 GIF 的 index）
          timelineData: msg.timelineData, // ✅ Pass timeline data
          batchIndex: i,
          batchTotal: validTasks.length
        };
        
        // 关键修复：确保 payload 是纯净的 JSON 对象，去除任何可能的 Figma 内部引用
        const cleanPayload = JSON.parse(JSON.stringify(payload));
        figma.ui.postMessage(cleanPayload);
      }
      
    } catch (error) {
      console.error('❌ 导出失败:', error);
      
      // 🛡️ 确保视频/GIF 节点的 opacity 在出错时也能恢复
      // 否则用户会看到视频图层变透明
      try {
        if (typeof videoGifOriginalOpacity !== 'undefined' && videoGifOriginalOpacity && videoGifOriginalOpacity.size > 0) {
          for (const [nodeId, originalOpacity] of videoGifOriginalOpacity) {
            try {
              const node = figma.getNodeById(nodeId);
              if (node && 'opacity' in node) {
                node.opacity = originalOpacity;
              }
            } catch (restoreErr) {
              // 节点可能已被删除，忽略
            }
          }
        }
      } catch (e) {}
      
      const errorMessage = error && error.message ? error.message : String(error || '未知错误');
      figma.ui.postMessage({
        type: 'export-gif-error',
        error: '导出失败: ' + errorMessage
      });
    }
    
    return;
  }
  
  // 处理服务器修复请求
  // Figma 插件沙箱无法访问 child_process，直接通知 UI 层尝试其他方式
  if (msg.type === 'repair-server') {
    figma.ui.postMessage({
      type: 'repair-server-response',
      success: false,
      message: '请打开 ScreenSync 主应用以启动服务器'
    });
    return;
  }
  
  // 处理插件版本信息请求
  if (msg.type === 'get-plugin-version') {
    figma.ui.postMessage({
      type: 'plugin-version-info',
      version: PLUGIN_VERSION
    });
    return;
  }
  
  // 处理保存插件版本请求
  if (msg.type === 'save-plugin-version') {
    try {
      await figma.clientStorage.setAsync('pluginVersion', msg.version);
    } catch (error) {
      // 保存失败
    }
    return;
  }
  
  // 处理尺寸设置更新
  if (msg.type === 'update-size-settings') {
    customSizeSettings.width = msg.width;
    customSizeSettings.height = msg.height;
    try {
      await figma.clientStorage.setAsync('imageWidth', msg.width);
      await figma.clientStorage.setAsync('imageHeight', msg.height);
    } catch (error) {
      // 保存失败
    }
    figma.ui.postMessage({
      type: 'size-settings-updated',
      success: true
    });
    return;
  }
  
  // 处理读取尺寸设置请求
  if (msg.type === 'get-size-settings') {
    try {
      const width = await figma.clientStorage.getAsync('imageWidth');
      const height = await figma.clientStorage.getAsync('imageHeight');
      customSizeSettings.width = width || null;
      customSizeSettings.height = height || null;
      figma.ui.postMessage({
        type: 'size-settings-loaded',
        width: customSizeSettings.width,
        height: customSizeSettings.height
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'size-settings-loaded',
        width: null,
        height: null
      });
    }
    return;
  }
  
  // 处理布局设置更新
  if (msg.type === 'update-layout-settings') {
    customSizeSettings.columns = msg.columns;
    try {
      await figma.clientStorage.setAsync('frameColumns', msg.columns);
      
      if (isFrameValid()) {
        if (customSizeSettings.columns && customSizeSettings.columns > 0) {
          currentFrame.layoutWrap = 'WRAP';
          currentFrame.counterAxisSizingMode = 'AUTO';
          
          let frameWidth = 0;
          if (currentFrame.children.length > 0) {
            const firstChild = currentFrame.children[0];
            const itemWidth = firstChild.width;
            const itemSpacing = currentFrame.itemSpacing || 10;
            frameWidth = (itemWidth * customSizeSettings.columns) + (itemSpacing * (customSizeSettings.columns - 1));
          } else {
            const estimatedItemWidth = CONFIG.imageWidth || 440;
            frameWidth = (estimatedItemWidth * customSizeSettings.columns) + (10 * (customSizeSettings.columns - 1));
          }
          
          currentFrame.layoutSizingHorizontal = 'FIXED';
          currentFrame.resize(frameWidth, currentFrame.height || 800);
        } else {
          currentFrame.layoutWrap = 'NO_WRAP';
          currentFrame.layoutSizingHorizontal = 'HUG';
        }
        
        currentFrame.fills = [];
      }
    } catch (error) {
      // 保存失败
    }
    figma.ui.postMessage({
      type: 'layout-settings-updated',
      success: true
    });
    return;
  }
  
  // 处理读取布局设置请求
  if (msg.type === 'get-layout-settings') {
    try {
      const columns = await figma.clientStorage.getAsync('frameColumns');
      customSizeSettings.columns = columns || null;
      figma.ui.postMessage({
        type: 'layout-settings-loaded',
        columns: customSizeSettings.columns
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'layout-settings-loaded',
        columns: null
      });
    }
    return;
  }
  
  // 处理 GIF 算法设置
  if (msg.type === 'get-gif-algorithm') {
    try {
      const algorithm = await figma.clientStorage.getAsync('gifAlgorithm');
      figma.ui.postMessage({
        type: 'gif-algorithm-response',
        algorithm: algorithm || 'less_noise'
      });
    } catch (error) {
      console.error('🎨 [code.js] 读取算法失败:', error);
      figma.ui.postMessage({
        type: 'gif-algorithm-response',
        algorithm: 'less_noise'
      });
    }
    return;
  }
  
  if (msg.type === 'set-gif-algorithm') {
    try {
      await figma.clientStorage.setAsync('gifAlgorithm', msg.algorithm);
    } catch (error) {
      console.error('🎨 [code.js] 算法保存失败:', error);
    }
    return;
  }
  
  // 处理语言设置
  if (msg.type === 'get-language') {
    try {
      const language = await figma.clientStorage.getAsync('uiLanguage');
      figma.ui.postMessage({
        type: 'language-response',
        language: language || null,
        fromStorage: !!language
      });
    } catch (error) {
      figma.ui.postMessage({ type: 'language-response', language: null, fromStorage: false });
    }
    return;
  }
  
  if (msg.type === 'set-language') {
    try {
      await figma.clientStorage.setAsync('uiLanguage', msg.language);
    } catch (error) {
      // Save failed silently
    }
    return;
  }
  
  // 🔑 处理时间线编辑器回填 gifCacheId（确保视频图层有唯一标识，避免跨文件误匹配）
  if (msg.type === 'update-layer-cache-id') {
    try {
      if (msg.layerId && msg.gifCacheId) {
        const node = figma.getNodeById(msg.layerId);
        if (node) {
          node.setPluginData('gifCacheId', msg.gifCacheId);
        }
      }
    } catch (e) {
      console.warn('⚠️ 回填 gifCacheId 失败:', e);
    }
    return;
  }

  // 处理保存服务器路径请求
  if (msg.type === 'save-server-path') {
    try {
      if (msg.path) {
        await figma.clientStorage.setAsync('serverPath', msg.path);
      }
    } catch (error) {
      // 保存失败
    }
    return;
  }

  // 处理读取服务器路径请求
  if (msg.type === 'get-server-path') {
    try {
      const path = await figma.clientStorage.getAsync('serverPath');
      figma.ui.postMessage({
        type: 'server-path-loaded',
        path: path || null
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'server-path-loaded',
        path: null
      });
    }
    return;
  }
  
  // 处理打开更新URL请求
  if (msg.type === 'open-update-url') {
    figma.notify(`请访问以下地址下载最新版本：\n${msg.url}`, { timeout: 10000 });
    return;
  }
  
  // 处理窗口大小调整（用于最小化/恢复功能）
  if (msg.type === 'resize') {
    try {
      const width = Math.max(80, Math.min(880, msg.width || 480));
      const height = Math.max(40, Math.min(1200, msg.height || 700));
      figma.ui.resize(width, height);
    } catch (e) {
      // 调整尺寸失败
    }
    return;
  }

  if (msg.type === 'create-frame') {
    const success = ensureFrame();
    
    if (success) {
      figma.currentPage.selection = [currentFrame];
      figma.viewport.scrollAndZoomIntoView([currentFrame]);
    }
    
    figma.ui.postMessage({
      type: 'frame-created',
      message: success ? '画板创建成功' : '创建画板失败'
    });
  }

  if (msg.type === 'locate-frame') {
    // 定位画板：查找并滚动到画板位置
    // 先清空 currentFrame，强制重新查找当前页面的画板
    currentFrame = null;
    
    const frameName = "ScreenSync Screenshots";
    const frame = findFrameByName(frameName);
    
    if (frame) {
      currentFrame = frame;
      figma.currentPage.selection = [frame];
      figma.viewport.scrollAndZoomIntoView([frame]);
      
      figma.ui.postMessage({
        type: 'frame-located',
        success: true,
        message: '已定位到画板'
      });
    } else {
      const success = ensureFrame();
      
      if (success && currentFrame) {
        figma.currentPage.selection = [currentFrame];
        figma.viewport.scrollAndZoomIntoView([currentFrame]);
        
        figma.ui.postMessage({
          type: 'frame-located',
          success: true,
          message: '已创建并定位到画板'
        });
      } else {
        figma.ui.postMessage({
          type: 'frame-located',
          success: false,
          message: '无法定位画板：创建失败'
        });
      }
    }
  }
  
  if (msg.type === 'add-screenshot') {
    try {
      const { bytes, timestamp, filename, driveFileId, ossFileId, gifCacheId } = msg;
      
      // ✅ 缓存文件信息（即使后续创建失败，也要保留信息以便手动拖入后关联）
      if (filename) {
        // 同时缓存原始文件名和去除扩展名的文件名，增加匹配成功率
        addRecentSyncedFile(filename, {
          driveFileId,
          ossFileId,
          gifCacheId,
          originalFilename: filename
        });
        
        // 缓存无扩展名版本（应对 Figma 图层名可能没有扩展名的情况）
        const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");
        if (nameWithoutExt !== filename) {
          addRecentSyncedFile(nameWithoutExt, {
            driveFileId,
            ossFileId,
            gifCacheId,
            originalFilename: filename
          });
        }
        
      }
      
      if (!bytes) {
        throw new Error('缺少 bytes 数据');
      }
      
      const filenameLower = filename ? filename.toLowerCase() : '';
      const isVideo = filenameLower.endsWith('.mp4') || filenameLower.endsWith('.mov');
      const isGif = filenameLower.endsWith('.gif');
      const isScreenRecording = isVideo || isGif;
      
      let uint8Array;
      
      if (typeof bytes === 'string') {
        try {
          uint8Array = figma.base64Decode(bytes);
        } catch (error) {
          throw new Error('base64 解码失败: ' + error.message);
        }
      } else if (Array.isArray(bytes)) {
        if (bytes.length === 0) {
          throw new Error('bytes 数组为空');
        }
        uint8Array = new Uint8Array(bytes);
      } else {
        throw new Error('bytes 必须是字符串（base64）或数组，实际类型: ' + typeof bytes);
      }
      
      let mediaSize;
      let mediaHash;
      
      if (isVideo) {
        throw new Error('Figma 插件 API 不支持视频文件。请通过 Figma 界面直接拖放视频文件，或使用 GIF 格式。');
      } else {
        const image = figma.createImage(uint8Array);
        
        if (!image) {
          throw new Error('figma.createImage() 返回 undefined，可能是 GIF 格式不支持或文件损坏');
        }
        
        if (!image.hash) {
          throw new Error('图片哈希值未生成，可能是 GIF 格式不支持或文件损坏');
        }
        
        mediaHash = image.hash;
        
        try {
          mediaSize = await image.getSizeAsync();
          
          if (!mediaSize) {
            throw new Error('image.getSizeAsync() 返回 undefined，可能是 GIF 格式不支持或文件损坏');
          }
          
          if (typeof mediaSize.width !== 'number' || typeof mediaSize.height !== 'number' || 
              mediaSize.width <= 0 || mediaSize.height <= 0) {
            throw new Error(`图片尺寸无效: ${mediaSize.width}x${mediaSize.height}，可能是 GIF 格式不支持或文件损坏`);
          }
        } catch (sizeError) {
          const errorMsg = sizeError && sizeError.message ? sizeError.message : String(sizeError);
          if (isGif) {
            throw new Error(`GIF 文件无法获取尺寸: ${errorMsg}。可能是 GIF 格式不支持或文件损坏，请尝试手动拖入或使用其他格式`);
          } else {
            throw new Error(`无法获取图片尺寸: ${errorMsg}`);
          }
        }
      }
      
      let finalWidth, finalHeight;
      
      if (customSizeSettings.width || customSizeSettings.height) {
        if (customSizeSettings.width && customSizeSettings.height) {
          finalWidth = customSizeSettings.width;
          finalHeight = customSizeSettings.height;
        } else if (customSizeSettings.width) {
          const aspectRatio = mediaSize.height / mediaSize.width;
          finalWidth = customSizeSettings.width;
          finalHeight = Math.round(finalWidth * aspectRatio);
        } else if (customSizeSettings.height) {
          const aspectRatio = mediaSize.width / mediaSize.height;
          finalHeight = customSizeSettings.height;
          finalWidth = Math.round(finalHeight * aspectRatio);
        }
      } else {
        finalWidth = Math.round(mediaSize.width / 3);
        finalHeight = Math.round(mediaSize.height / 3);
      }
      
      const rect = figma.createRectangle();
      
      rect.resize(finalWidth, finalHeight);
      
      if (isVideo) {
        try {
          rect.fills = [{
            type: 'VIDEO',
            videoHash: mediaHash,
            scaleMode: 'FIT'
          }];
        } catch (fillError) {
          throw new Error('Figma 插件 API 不支持视频填充。请通过 Figma 界面直接拖放视频文件。');
        }
      } else {
        // 图片填充
        rect.fills = [{
          type: 'IMAGE',
          imageHash: mediaHash,
          scaleMode: 'FIT'
        }];
      }
      
      // 统一命名格式：类型+序号
      let rectName;
      if (isScreenRecording) {
        // 录屏：ScreenRecording_001, ScreenRecording_002, ...
        screenRecordingIndex++;
        rectName = `ScreenRecording_${String(screenRecordingIndex).padStart(3, '0')}`;
      } else {
        // 截屏：Screenshot_001, Screenshot_002, ...
        screenshotIndex++;
        rectName = `Screenshot_${String(screenshotIndex).padStart(3, '0')}`;
      }
      rect.name = rectName;
      
      // 保存文件名和唯一标识到 pluginData
      if (msg.filename) {
        rect.setPluginData('originalFilename', msg.filename);
      }
      // 🔑 无条件存储唯一标识（不受文件名/类型判断限制）
      // 这些 ID 是时间线编辑器精确定位源文件的唯一凭据
      if (msg.driveFileId) {
        rect.setPluginData('driveFileId', msg.driveFileId);
      }
      if (msg.ossFileId) {
        rect.setPluginData('ossFileId', msg.ossFileId);
      }
      if (msg.gifCacheId) {
        rect.setPluginData('gifCacheId', msg.gifCacheId);
      }
      
      const frameCreated = ensureFrame();
      
      if (isFrameValid()) {
        if (currentFrame.layoutMode === 'NONE') {
          currentFrame.layoutMode = 'HORIZONTAL';
          currentFrame.itemSpacing = 10;
          currentFrame.paddingLeft = 0;
          currentFrame.paddingRight = 0;
          currentFrame.paddingTop = 0;
          currentFrame.paddingBottom = 0;
        }
        
        // 先添加到画板，然后才能设置 layoutSizingHorizontal
        currentFrame.appendChild(rect);
        
        // 只有在 frame 有 auto-layout 时，才能设置子元素的 layoutSizing 属性
        if (currentFrame.layoutMode !== 'NONE') {
          try {
            // 如果设置了列数，需要设置子元素的宽度以实现换行
            if (customSizeSettings.columns && customSizeSettings.columns > 0) {
              // 设置子元素的宽度为固定值，这样 Auto Layout 的 WRAP 模式会根据宽度自动换行
              rect.layoutSizingHorizontal = 'FIXED';
              rect.layoutSizingVertical = 'HUG';
              // 宽度已经在上面设置了 finalWidth，不需要再设置
              
              // 根据第一张图片的实际宽度计算画板宽度
              // 如果是第一张图片（画板只有这一张），根据这张图片的宽度设置画板宽度
              const itemSpacing = currentFrame.itemSpacing || 10;
              const frameWidth = (finalWidth * customSizeSettings.columns) + (itemSpacing * (customSizeSettings.columns - 1));
              
              // 只有当这是第一张图片时，才设置画板宽度
              // 或者如果画板当前是 HUG 模式，也需要设置
              if (currentFrame.children.length === 1 || currentFrame.layoutSizingHorizontal === 'HUG') {
                currentFrame.layoutSizingHorizontal = 'FIXED';
                currentFrame.resize(frameWidth, currentFrame.height || 800);
              }
            } else {
              // 不换行，子元素可以自由扩展，画板宽度自动 hug 内容
              rect.layoutSizingHorizontal = 'HUG';
              rect.layoutSizingVertical = 'HUG';
              // 确保画板也是 HUG 模式
              if (currentFrame.layoutSizingHorizontal !== 'HUG') {
                currentFrame.layoutSizingHorizontal = 'HUG';
              }
            }
          } catch (layoutError) {
            // 如果设置 layoutSizing 失败，不抛出错误，让图片正常添加
          }
        }
        
      } else {
        rect.x = figma.viewport.center.x;
        rect.y = figma.viewport.center.y;
        figma.currentPage.appendChild(rect);
      }
      
      screenshotCount++;
      
      figma.currentPage.selection = [rect];
      figma.viewport.scrollAndZoomIntoView([rect]);
      
      figma.ui.postMessage({
        type: 'screenshot-added',
        success: true,
        count: screenshotCount,
        filename: filename || '未命名文件',
        driveFileId: driveFileId,
        ossFileId: ossFileId
      });
      
    } catch (error) {
      const errorMessage = (error && error.message) ? error.message : String(error || '未知错误');
      const isUndefinedError = !error || 
                               error.message === undefined || 
                               error.message === 'undefined' ||
                               errorMessage.toLowerCase().includes('undefined') ||
                               (errorMessage.toLowerCase().includes('gif') && (
                                 errorMessage.toLowerCase().includes('不支持') ||
                                 errorMessage.toLowerCase().includes('损坏') ||
                                 errorMessage.toLowerCase().includes('无法获取') ||
                                 errorMessage.toLowerCase().includes('返回 undefined')
                               ));
      
      if (isUndefinedError) {
        const isGif = msg.filename && msg.filename.toLowerCase().endsWith('.gif');
        const errorText = isGif 
          ? 'GIF 文件导入失败（可能是格式不支持或文件损坏），需要手动拖入'
          : '文件导入失败（undefined 错误），需要手动拖入';
        
        figma.ui.postMessage({
          type: 'file-needs-manual-drag',
          filename: msg.filename || '未命名文件',
          reason: 'undefined-error',
          error: errorText,
          driveFileId: msg.driveFileId,
          ossFileId: msg.ossFileId
        });
      } else {
        // 其他错误：正常显示错误信息
        figma.ui.postMessage({
          type: 'screenshot-added',
          success: false,
          error: errorMessage,
          driveFileId: msg.driveFileId,
          ossFileId: msg.ossFileId
        });
      }
    }
  }
  
  if (msg.type === 'cancel') {
    figma.ui.postMessage({ type: 'plugin-closing' });
    setTimeout(() => {
    figma.closePlugin('已同步 ' + screenshotCount + ' 张截图');
    }, 200);
  }
  
  if (msg.type === 'stop-realtime') {
    // 这个消息由UI发送，用于停止实时同步
    // 实际停止逻辑在服务器端，这里只是确认收到
  }
  
  // 🔄 处理自动缓存结果（Server 已找到并缓存了拖入的视频/GIF 文件）
  if (msg.type === 'auto-cache-result') {
    try {
      const { filename, gifCacheId, timestamp, success } = msg;
      
      if (!success || !gifCacheId) {
        console.log('⚠️ 自动缓存失败:', filename, msg.error || '');
        // 标记为缓存失败，导出时将走手动上传流程
        const entry = pendingDroppedFiles.find(f => f.filename === filename && f.timestamp === timestamp);
        if (entry) {
          entry.autoCaching = false;
          entry.autoCached = false;
        }
        return;
      }
      
      console.log('✅ 自动缓存成功:', filename, '→ cacheId:', gifCacheId);
      
      // 更新 pendingDroppedFiles 中的缓存 ID
      const entry = pendingDroppedFiles.find(f => f.filename === filename && f.timestamp === timestamp);
      if (entry) {
        entry.gifCacheId = gifCacheId;
        entry.autoCaching = false;
        entry.autoCached = true;
        
        // 🎯 如果 documentchange 已经找到了节点但当时 cacheId 还没到，现在回填
        if (entry.pendingNodeId) {
          try {
            const node = figma.getNodeById(entry.pendingNodeId);
            if (node) {
              node.setPluginData('gifCacheId', gifCacheId);
              node.setPluginData('originalFilename', filename);
              
              // 关联完成，移除 entry
              const idx = pendingDroppedFiles.indexOf(entry);
              if (idx >= 0) pendingDroppedFiles.splice(idx, 1);
              return;
            }
          } catch (e) {
            // 节点可能已被删除
          }
        }
      }
      
      // 🎯 尝试立即关联到已存在的节点（如果节点已经被 Figma 创建了）
      try {
        const page = figma.currentPage;
        if (page) {
          const findAndAssociate = (nodes) => {
            for (const node of nodes) {
              try {
                const existingCacheId = node.getPluginData('gifCacheId');
                if (existingCacheId) continue; // 已关联，跳过
                
                const nodeName = (node.name || '').toLowerCase();
                const targetName = filename.toLowerCase();
                const targetBase = targetName.replace(/\.[^/.]+$/, '');
                const nodeBase = nodeName.replace(/\.[^/.]+$/, '').replace(/\s+\d+$/, '');
                
                if (nodeName === targetName || nodeBase === targetBase || 
                    nodeBase.includes(targetBase) || targetBase.includes(nodeBase)) {
                  node.setPluginData('gifCacheId', gifCacheId);
                  node.setPluginData('originalFilename', filename);
                  
                  // 从 pendingDroppedFiles 中移除已关联的文件
                  if (entry) {
                    const idx = pendingDroppedFiles.indexOf(entry);
                    if (idx >= 0) pendingDroppedFiles.splice(idx, 1);
                  }
                  return true;
                }
              } catch (e) {
                // 忽略无法访问的节点
              }
            }
            return false;
          };
          
          // 搜索当前页面的所有 Frame 的直接子节点
          for (const frame of page.children) {
            if (frame.type === 'FRAME' && 'children' in frame) {
              if (findAndAssociate(frame.children)) break;
            }
          }
        }
      } catch (searchErr) {
        // 搜索失败不影响缓存结果
      }
    } catch (e) {
      console.error('处理自动缓存结果时出错:', e);
    }
    return;
  }
  
  // 处理上传完成后关联 GIF 数据
  if (msg.type === 'associate-uploaded-gif') {
    try {
      const layer = figma.getNodeById(msg.layerId);
      if (!layer) {
        figma.ui.postMessage({
          type: 'associate-gif-error',
          layerId: msg.layerId,
          error: '未找到图层'
        });
        return;
      }
      
      if (msg.driveFileId) {
        layer.setPluginData('driveFileId', msg.driveFileId);
      }
      if (msg.ossFileId) {
        layer.setPluginData('ossFileId', msg.ossFileId);
      }
      if (msg.originalFilename) {
        layer.setPluginData('originalFilename', msg.originalFilename);
      }
      if (msg.imageHash) {
        layer.setPluginData('imageHash', msg.imageHash);
      }
      if (msg.gifCacheId) {
        layer.setPluginData('gifCacheId', msg.gifCacheId);
      }
      
      figma.ui.postMessage({
        type: 'associate-gif-success',
        layerId: msg.layerId
      });
      
    } catch (error) {
      figma.ui.postMessage({
        type: 'associate-gif-error',
        layerId: msg.layerId,
        error: error.message
      });
    }
  }
  
  // Handle frame selection check (before showing export modal)
  if (msg.type === 'check-frame-selection') {
    const selection = figma.currentPage.selection;
    
    if (!selection || selection.length === 0) {
      figma.ui.postMessage({ type: 'frame-selection-result', hasValidFrame: false, hasVideoLayer: false, frameCount: 0 });
      return;
    }
    
    // 辅助函数：检查 Frame 内是否包含动态图层
    function frameHasVideoLayer(frame) {
      for (const child of frame.children) {
        try { if (child.getPluginData('gifCacheId') || child.getPluginData('videoId')) return true; } catch (e) {}
        try { if ('fills' in child && Array.isArray(child.fills) && child.fills.some(f => f.type === 'VIDEO')) return true; } catch (e) { return true; }
        const ln = child.name.toLowerCase();
        if (['.gif', '.mp4', '.mov', '.webm'].some(ext => ln.endsWith(ext)) ||
            ['screenrecording', 'video'].some(kw => ln.includes(kw))) return true;
      }
      return false;
    }
    
    // 辅助函数：收集 Frame 中未同步的 GIF/视频图层（与 export-annotated-gif 中的逻辑一致）
    function collectUnsyncedLayers(frame) {
      const unsynced = [];
      for (const child of frame.children) {
        try {
          const driveFileId = child.getPluginData('driveFileId');
          const ossFileId = child.getPluginData('ossFileId');
          const gifCacheId = child.getPluginData('gifCacheId');
          const originalFilename = child.getPluginData('originalFilename');
          
          let isMediaLayer = false;
          if (originalFilename || gifCacheId || child.getPluginData('videoId')) {
            isMediaLayer = true;
          }
          if (!isMediaLayer) {
            try {
              if ('fills' in child && Array.isArray(child.fills) && child.fills.some(f => f.type === 'VIDEO')) isMediaLayer = true;
            } catch (e) { isMediaLayer = true; }
          }
          if (!isMediaLayer) {
            const ln = child.name.toLowerCase();
            if (['.gif', '.mp4', '.mov', '.webm'].some(ext => ln.endsWith(ext)) ||
                ['screenrecording', 'video'].some(kw => ln.includes(kw))) isMediaLayer = true;
          }
          
          if (isMediaLayer && !driveFileId && !ossFileId) {
            unsynced.push({
              layerId: child.id,
              layerName: child.name,
              filename: originalFilename || child.name,
              frameId: frame.id,
              frameName: frame.name,
              gifCacheId: gifCacheId || null
            });
          }
        } catch (e) {}
      }
      return unsynced;
    }
    
    // 逐个验证所有选中节点
    let totalFrames = 0;
    let framesWithVideo = 0;
    let hasNonFrame = false;
    const invalidFrameNames = [];
    const allUnsyncedGifs = [];
    
    for (const node of selection) {
      if (node.type !== 'FRAME') {
        hasNonFrame = true;
        continue;
      }
      totalFrames++;
      if (frameHasVideoLayer(node)) {
        framesWithVideo++;
        const unsynced = collectUnsyncedLayers(node);
        allUnsyncedGifs.push(...unsynced);
      } else {
        invalidFrameNames.push(node.name);
      }
    }
    
    figma.ui.postMessage({
      type: 'frame-selection-result',
      hasValidFrame: totalFrames > 0,
      hasVideoLayer: framesWithVideo > 0,
      frameCount: totalFrames,
      framesWithVideo: framesWithVideo,
      hasNonFrame: hasNonFrame,
      invalidFrameNames: invalidFrameNames,
      unsyncedGifs: allUnsyncedGifs
    });
    return;
  }
  
  // Handle timeline layers request
  if (msg.type === 'request-timeline-layers') {
    try {
      const selection = figma.currentPage.selection;
      if (!selection || selection.length === 0 || selection[0].type !== 'FRAME') {
        return; // Or send error
      }
      
      const frame = selection[0];
      
      // 标记时间线编辑器已打开，记录 Frame ID
      isTimelineEditorOpen = true;
      timelineFrameId = frame.id;
      lastTimelineLayerIds = frame.children.map(c => c.id); // 初始化图层顺序
      
      // Parallel export for performance
      const exportPromises = frame.children.map(async (child) => {
        try {
          // Export thumbnail for preview (higher resolution for fullscreen clarity)
          const bytes = await child.exportAsync({
            format: 'PNG',
            constraint: { type: 'HEIGHT', value: 800 }
          });
          
          // Check if this is a video/GIF layer
          let videoId = null;
          let isVideoLayer = false;
          let originalFilename = null;
          
          try {
            const pluginDataStr = child.getPluginData('videoId');
            if (pluginDataStr) {
              videoId = pluginDataStr;
              isVideoLayer = true;
            }
          } catch (e) {
            // No video data
          }
          
          // 读取原始文件名（用于 server 端按文件名搜索视频）
          try {
            const origName = child.getPluginData('originalFilename');
            if (origName) originalFilename = origName;
          } catch (e) {}
          
          // 读取 gifCacheId（用于 server 端精确定位缓存文件，避免跨文件误匹配）
          let gifCacheId = null;
          try {
            const cid = child.getPluginData('gifCacheId');
            if (cid) gifCacheId = cid;
          } catch (e) {}
          if (gifCacheId) isVideoLayer = true;
          
          // Also check fills for video type
          if (!isVideoLayer && 'fills' in child && Array.isArray(child.fills)) {
            for (const fill of child.fills) {
              if (fill.type === 'VIDEO') {
                isVideoLayer = true;
                break;
              }
            }
          }
          
          // Also check by name pattern (GIF, video extensions)
          if (!isVideoLayer) {
            const lowerName = child.name.toLowerCase();
            const videoExtensions = ['.gif', '.mp4', '.mov', '.webm', '.avi', '.mkv'];
            const videoKeywords = ['screenrecording', 'video', 'gif'];
            
            if (videoExtensions.some(ext => lowerName.endsWith(ext)) ||
                videoKeywords.some(kw => lowerName.includes(kw))) {
              isVideoLayer = true;
            }
          }
          
          return {
            id: child.id,
            name: child.name,
            type: child.type,
            thumbnail: figma.base64Encode(bytes),
            width: child.width,
            height: child.height,
            x: child.x,
            y: child.y,
            isVideoLayer: isVideoLayer,
            videoId: videoId,
            originalFilename: originalFilename,
            gifCacheId: gifCacheId
          };
        } catch (err) {
          console.error(`Failed to export layer ${child.name}:`, err);
          // 即使 exportAsync 失败（视频节点常见），仍尝试从 pluginData 检测视频信息
          let fallbackVideoId = null;
          let fallbackIsVideo = false;
          let fallbackOriginalFilename = null;
          let fallbackGifCacheId = null;
          try {
            const vid = child.getPluginData('videoId');
            if (vid) { fallbackVideoId = vid; fallbackIsVideo = true; }
          } catch (e) {}
          try {
            const origName = child.getPluginData('originalFilename');
            if (origName) fallbackOriginalFilename = origName;
          } catch (e) {}
          try {
            const cid = child.getPluginData('gifCacheId');
            if (cid) fallbackGifCacheId = cid;
          } catch (e) {}
          if (fallbackGifCacheId) fallbackIsVideo = true;
          if (!fallbackIsVideo) {
            try {
              if ('fills' in child && Array.isArray(child.fills)) {
                fallbackIsVideo = child.fills.some(f => f.type === 'VIDEO');
              }
            } catch (e) { fallbackIsVideo = true; } // 访问 fills 失败通常意味着是视频节点
          }
          return {
            id: child.id,
            name: child.name,
            type: child.type,
            thumbnail: null,
            isVideoLayer: fallbackIsVideo,
            videoId: fallbackVideoId,
            originalFilename: fallbackOriginalFilename,
            gifCacheId: fallbackGifCacheId
          };
        }
      });
      
      const processedLayers = await Promise.all(exportPromises);
      
      figma.ui.postMessage({
        type: 'timeline-layers-response',
        layers: processedLayers,
        frameWidth: frame.width,
        frameHeight: frame.height,
        frameId: frame.id // 传递 Frame ID 供导出时使用
      });
    } catch (e) {
      // ignore
    }
    return;
  }

  // 处理时间线编辑器关闭
  if (msg.type === 'timeline-editor-closed') {
    isTimelineEditorOpen = false;
    timelineFrameId = null;
    lastTimelineLayerIds = [];
    if (structuralRefreshTimer) { clearTimeout(structuralRefreshTimer); structuralRefreshTimer = null; }
    return;
  }

  // 处理文件未找到错误，清除 GIF 的 pluginData 并重新触发检测
  if (msg.type === 'clear-gif-data-and-retry') {
    try {
      const selection = figma.currentPage.selection;
      if (!selection || selection.length === 0) {
        return;
      }
      
      function clearGifPluginData(node) {
        const originalFilename = node.getPluginData('originalFilename');
        if (originalFilename) {
          const hasValidExtension = originalFilename.toLowerCase().endsWith('.gif') || 
                                   originalFilename.toLowerCase().endsWith('.mov') || 
                                   originalFilename.toLowerCase().endsWith('.mp4');
          
          if (hasValidExtension) {
            const hadDriveFileId = node.getPluginData('driveFileId');
            const hadOssFileId = node.getPluginData('ossFileId');
            const hadGifCacheId = node.getPluginData('gifCacheId');
            
            if (hadDriveFileId || hadOssFileId || hadGifCacheId) {
              node.setPluginData('driveFileId', '');
              node.setPluginData('ossFileId', '');
              node.setPluginData('gifCacheId', '');
              node.setPluginData('imageHash', '');
            }
          }
        }
        
        if ('children' in node) {
          for (const child of node.children) {
            clearGifPluginData(child);
          }
        }
      }
      
      for (const node of selection) {
        clearGifPluginData(node);
      }
      
      setTimeout(() => {
        figma.ui.postMessage({ type: 'trigger-export-from-code' });
      }, 500);
      
    } catch (error) {
      // 清除失败
    }
  }
  
  } catch (globalError) {
    // 🛡️ 全局错误捕获，防止插件崩溃
    console.error('❌ 消息处理器发生错误:', globalError.message);
    console.error('   消息类型:', (msg && msg.type) ? msg.type : '未知');
  }
};

// 🎯 自动缩放节点到设置的尺寸
function autoResizeNode(node) {
  try {
    // 获取用户设置的尺寸
    const targetWidth = customSizeSettings.width ? parseInt(customSizeSettings.width) : null;
    const targetHeight = customSizeSettings.height ? parseInt(customSizeSettings.height) : null;
    
    // 如果没有设置任何尺寸，不做调整
    if (!targetWidth && !targetHeight) return;
    
    // 获取节点当前尺寸
    const currentWidth = node.width;
    const currentHeight = node.height;
    
    if (currentWidth <= 0 || currentHeight <= 0) return;
    
    // 计算宽高比
    const aspectRatio = currentWidth / currentHeight;
    
    let newWidth, newHeight;
    
    if (targetWidth && targetHeight) {
      // 如果同时设置了宽高，保持宽高比，以较小的缩放比例为准
      const scaleByWidth = targetWidth / currentWidth;
      const scaleByHeight = targetHeight / currentHeight;
      const scale = Math.min(scaleByWidth, scaleByHeight);
      newWidth = currentWidth * scale;
      newHeight = currentHeight * scale;
    } else if (targetWidth) {
      // 只设置了宽度，按宽度等比缩放
      newWidth = targetWidth;
      newHeight = targetWidth / aspectRatio;
    } else {
      // 只设置了高度，按高度等比缩放
      newHeight = targetHeight;
      newWidth = targetHeight * aspectRatio;
    }
    
    // 执行缩放
    node.resize(newWidth, newHeight);
  } catch (e) {
    // 缩放失败，忽略
  }
}

// 🎯 记录拖入的原始文件名，用于修复 Figma 的重命名问题
let pendingDroppedFiles = []; // { filename, timestamp }

// ✅ 监听拖放事件，记录原始文件名并自动缓存到 Server
// 核心：通过 getBytesAsync() 读取文件真实数据，确保无论文件来自何处都能缓存
// ⚡ 优化：drop 回调仅做轻量记录，将文件读取和编码延迟到后台执行，确保用户立即看到图层出现在画布上
figma.on('drop', (event) => {
  try {
    if (event.files && event.files.length > 0) {
      // 清理超过 120 秒的旧记录（给大文件的读取+传输留充足时间）
      const now = Date.now();
      pendingDroppedFiles = pendingDroppedFiles.filter(
        drop => now - drop.timestamp < 120000
      );
      
      for (const file of event.files) {
        const filename = file.name;
        const ext = filename.toLowerCase().split('.').pop();
        
        if (['mov', 'mp4', 'gif', 'webm'].includes(ext)) {
          const dropEntry = {
            filename: filename,
            timestamp: Date.now(),
            gifCacheId: null,
            autoCaching: true,
            autoCached: false
          };
          pendingDroppedFiles.push(dropEntry);
          
          // 🔄 延迟执行文件读取，让 Figma 先完成图层渲染
          // getBytesAsync() 在 drop 回调返回后仍然有效
          const fileRef = file; // 保留文件引用
          setTimeout(() => {
            fileRef.getBytesAsync().then(bytes => {
              // 再次延迟，让 base64 编码和大消息发送不阻塞画布交互
              setTimeout(() => {
                try {
                  const base64 = figma.base64Encode(bytes);
                  figma.ui.postMessage({
                    type: 'auto-cache-dropped-video',
                    filename: filename,
                    timestamp: dropEntry.timestamp,
                    base64: base64
                  });
                } catch (encodeErr) {
                  console.warn('⚠️ [自动缓存] 编码失败，回退到文件名搜索:', filename, encodeErr);
                  figma.ui.postMessage({
                    type: 'auto-cache-dropped-video',
                    filename: filename,
                    timestamp: dropEntry.timestamp,
                    base64: null
                  });
                }
              }, 100);
            }).catch(err => {
              console.warn('⚠️ [自动缓存] 读取文件字节失败，回退到文件名搜索:', filename, err);
              // 回退：只发文件名，让 Server 在磁盘上搜索
              figma.ui.postMessage({
                type: 'auto-cache-dropped-video',
                filename: filename,
                timestamp: dropEntry.timestamp,
                base64: null
              });
            });
          }, 800); // 延迟 800ms，确保 Figma 已将图层渲染到画布
        }
      }
    }
  } catch (e) {
    // 拖放处理出错
  }
});

// ✅ 监听文档变化，自动关联手动拖入的 GIF 的缓存元数据
// ⚠️ 重要：不要处理 VIDEO 类型！访问视频节点的属性可能导致 Figma 报错 "An invalid video was removed"
// 🛡️ 使用 try-catch 包裹整个监听器，防止切换文件时崩溃
figma.on('documentchange', (event) => {
  try {
    // 🎬 时间线编辑器：检测图层位置变化并实时更新预览
    if (isTimelineEditorOpen && timelineFrameId) {
      // 位置变化 - 只更新位置不更新缩略图
      const positionOnlyProperties = ['x', 'y'];
      // 尺寸变化 - 需要更新位置和缩略图
      const sizeProperties = ['width', 'height'];
      // 名称变化 - 只更新名称标签
      const nameProperties = ['name'];
      // 非视觉属性 - 不需要任何更新
      const nonVisualProperties = ['pluginData', 'sharedPluginData', 'constraints', 'exportSettings', 'guides', 'layoutGrids', 'reactions'];
      
      // 接受所有 PROPERTY_CHANGE，由后续逻辑按属性分类处理
      const propertyChanges = event.documentChanges.filter(change => 
        change.type === 'PROPERTY_CHANGE'
      );
      
      if (propertyChanges.length > 0) {
        // 检查是否是时间线编辑中的 Frame 的子图层
        const frame = figma.getNodeById(timelineFrameId);
        if (frame && frame.type === 'FRAME') {
          const childIds = new Set(frame.children.map(c => c.id));
          const relevantChanges = propertyChanges.filter(change => childIds.has(change.id));
          
          if (relevantChanges.length > 0) {
            // 收集更新的图层位置信息
            const updates = [];
            const thumbnailUpdates = [];
            
            const nameUpdates = [];
            
            for (const change of relevantChanges) {
              try {
                const node = figma.getNodeById(change.id);
                if (node && 'x' in node) {
                  updates.push({
                    id: node.id,
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height
                  });
                  
                  // 检查名称变化
                  if (change.properties.includes('name')) {
                    nameUpdates.push({
                      id: node.id,
                      name: node.name
                    });
                  }
                  
                  // 任何非"仅位置"、非"仅名称"、非"非视觉"的属性变化都重新导出缩略图
                  const needsThumbnailUpdate = change.properties.some(p => 
                    !positionOnlyProperties.includes(p) && !nameProperties.includes(p) && !nonVisualProperties.includes(p)
                  );
                  if (needsThumbnailUpdate && 'exportAsync' in node) {
                    thumbnailUpdates.push({
                      id: node.id,
                      node: node
                    });
                  }
                }
              } catch (e) {
                // 忽略无法访问的节点
              }
            }
            
            if (updates.length > 0) {
              figma.ui.postMessage({
                type: 'timeline-layer-positions-updated',
                updates: updates,
                frameWidth: frame.width,
                frameHeight: frame.height
              });
            }
            
            // 发送名称更新
            if (nameUpdates.length > 0) {
              figma.ui.postMessage({
                type: 'timeline-layer-names-updated',
                updates: nameUpdates
              });
            }
            
            // 异步更新缩略图
            if (thumbnailUpdates.length > 0) {
              (async () => {
                const thumbResults = [];
                for (const item of thumbnailUpdates) {
                  try {
                    // 🛡️ 跳过视频节点的缩略图导出（避免触发 Figma 视频验证）
                    const nodeName = (item.node.name || '').toLowerCase();
                    const isVideoNode = nodeName.endsWith('.mp4') || nodeName.endsWith('.mov') || 
                                        nodeName.endsWith('.webm') || nodeName.includes('screenrecording');
                    let hasVideoFill = false;
                    try {
                      if ('fills' in item.node && Array.isArray(item.node.fills)) {
                        hasVideoFill = item.node.fills.some(f => f.type === 'VIDEO');
                      }
                    } catch (e) { hasVideoFill = true; }
                    
                    if (isVideoNode || hasVideoFill) continue;
                    
                    const bytes = await item.node.exportAsync({
                      format: 'PNG',
                      constraint: { type: 'HEIGHT', value: 800 }
                    });
                    thumbResults.push({
                      id: item.id,
                      thumbnail: figma.base64Encode(bytes)
                    });
                  } catch (e) {
                    console.warn('缩略图导出失败:', item.id, e);
                  }
                }
                if (thumbResults.length > 0) {
                  figma.ui.postMessage({
                    type: 'timeline-layer-thumbnails-updated',
                    updates: thumbResults
                  });
                }
              })();
            }
          }
        }
      }
      
      // 🎬 时间线编辑器：检测图层增删和重排序
      // 每次 documentchange 都检查 frame.children 是否与缓存不同，
      // 比仅依赖 CREATE/DELETE 事件类型更可靠
      const frame_sc = figma.getNodeById(timelineFrameId);
      if (frame_sc && frame_sc.type === 'FRAME') {
        const currentChildIds = frame_sc.children.map(c => c.id);
        const structurallyChanged = currentChildIds.length !== lastTimelineLayerIds.length ||
          !currentChildIds.every((id, i) => id === lastTimelineLayerIds[i]);
        
        if (structurallyChanged) {
          // 先计算新增图层，再更新缓存
          const prevIds = new Set(lastTimelineLayerIds);
          const newIds = currentChildIds.filter(id => !prevIds.has(id));
          
          // 立即更新缓存，防止同一变化多次触发刷新
          lastTimelineLayerIds = [...currentChildIds];
          let hasVideoCreate = false;
          for (const id of newIds) {
            try {
              const n = figma.getNodeById(id);
              if (n) {
                const nm = (n.name || '').toLowerCase();
                if (nm.endsWith('.mp4') || nm.endsWith('.mov') || nm.endsWith('.webm') || nm.includes('screenrecording')) {
                  hasVideoCreate = true;
                  break;
                }
              }
            } catch (e) { hasVideoCreate = true; break; }
          }
          
          // 用 debounce 防止快速连续的变化触发多次刷新
          if (structuralRefreshTimer) clearTimeout(structuralRefreshTimer);
          const delay = hasVideoCreate ? 3000 : 800;
          structuralRefreshTimer = setTimeout(() => {
            structuralRefreshTimer = null;
            const f = figma.getNodeById(timelineFrameId);
            if (f && f.type === 'FRAME') {
              refreshTimelineLayers(f, true);
            }
          }, delay);
        }
      }
    }
    
    // 只处理节点创建事件
    const nodeChanges = event.documentChanges.filter(change => change.type === 'CREATE');
    
    if (nodeChanges.length === 0) return;
    
    // 收集需要处理的节点ID（延迟处理，避免干扰 Figma 的加载）
    const nodeIdsToProcess = [];
    
    for (const change of nodeChanges) {
      try {
        const node = change.node;
        
        // 🛡️ 检查节点是否有效
        if (!node) continue;
        
        // 🛡️ 第一步：只获取节点 ID，不访问任何其他属性
        // 这样可以避免在视频加载期间触发 Figma 验证错误
        let nodeId;
        try {
          nodeId = node.id;
        } catch (idErr) {
          continue; // 无法获取 ID，跳过
        }
        
        // 🛡️ 延迟处理，等待 Figma 完成节点加载
        // 视频节点需要较长时间才能被安全访问
        // 使用两轮检测：2秒（快速命中）+ 5秒（兜底，覆盖慢加载的情况）
        const tryProcessNode = (delayMs) => {
          setTimeout(() => {
            try {
              const delayedNode = figma.getNodeById(nodeId);
              if (!delayedNode) return;
              
              // 🛡️ 安全获取节点类型和名称
              let nodeType, nodeName;
              try {
                nodeType = delayedNode.type;
                nodeName = delayedNode.name || '';
              } catch (accessErr) {
                return;
              }
              
              // ✅ 放宽类型限制：Figma 拖入视频可能创建 RECTANGLE、VIDEO 等多种类型
              // 只排除明显不相关的容器类型
              const containerTypes = ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'PAGE', 'DOCUMENT', 'SECTION'];
              if (containerTypes.includes(nodeType)) return;
              
              const nameLower = nodeName.toLowerCase();
              
              // 检查文件类型
              const looksLikeVideo = nameLower.endsWith('.mov') || 
                                    nameLower.endsWith('.mp4') ||
                                    nameLower.endsWith('.webm') ||
                                    nameLower.endsWith('.avi') ||
                                    nameLower.endsWith('.mkv') ||
                                    nameLower.includes('screenrecording');
              
              let looksLikeGif = nameLower.endsWith('.gif');
              
              // Figma 会自动去掉拖入文件的扩展名（e.g. "录屏.gif" → "录屏"）
              // 当扩展名检测失败时，回退到与 pendingDroppedFiles 做模糊匹配
              let matchedDropFilename = null;
              if (!looksLikeVideo && !looksLikeGif && pendingDroppedFiles.length > 0) {
                const nodeNameClean = nodeName.replace(/\.[^/.]+$/i, '').replace(/[^a-z0-9\u4e00-\u9fff]/gi, '').toLowerCase();
                for (const f of pendingDroppedFiles) {
                  const dropNameClean = f.filename.replace(/\.[^/.]+$/i, '').replace(/[^a-z0-9\u4e00-\u9fff]/gi, '').toLowerCase();
                  if (dropNameClean && nodeNameClean && (dropNameClean === nodeNameClean || dropNameClean.includes(nodeNameClean) || nodeNameClean.includes(dropNameClean))) {
                    const dropExt = f.filename.toLowerCase().split('.').pop();
                    if (dropExt === 'gif') looksLikeGif = true;
                    matchedDropFilename = f.filename;
                    break;
                  }
                }
              }
              
              if (!looksLikeVideo && !looksLikeGif) return;
              
              // 🎯 自动缩放：仅对视频/GIF 文件生效（只执行一次）
              const alreadyResized = delayedNode.getPluginData('autoResized');
              if (!alreadyResized && (looksLikeVideo || looksLikeGif)) {
                try {
                  autoResizeNode(delayedNode);
                  delayedNode.setPluginData('autoResized', 'true');
                } catch (resizeErr) {
                  // 忽略缩放错误
                }
              }
              
              // 🔄 自动缓存关联：每轮都尝试（因为 cacheId 可能在第一轮后才到达）
              if (looksLikeGif || looksLikeVideo) {
                processDroppedMediaNode(delayedNode, matchedDropFilename || nodeName);
              }
            } catch (e) {
              // 忽略错误
            }
          }, delayMs);
        };
        
        // 第一轮：2秒后尝试（大部分文件此时已加载完成）
        tryProcessNode(2000);
        // 第二轮：5秒后兜底（覆盖大文件或网络慢的情况）
        tryProcessNode(5000);
        // 第三轮：15秒后最终兜底（覆盖大文件自动缓存完成后的回填）
        tryProcessNode(15000);
        
      } catch (e) {
        // 忽略错误
      }
    }
  } catch (e) {
    // 🛡️ 全局异常处理，防止切换文件时崩溃
  }
});

// 🎯 处理拖入的视频/GIF 节点的缓存关联（包括自动缓存完成后的 cacheId 写入）
function processDroppedMediaNode(node, nodeName) {
  try {
    const nameLower = nodeName.toLowerCase();
    
    // 检查是否是视频/GIF 文件
    const mediaExtensions = ['.gif', '.mov', '.mp4', '.webm', '.avi', '.mkv'];
    const isMedia = mediaExtensions.some(ext => nameLower.endsWith(ext)) || 
                    nameLower.includes('screenrecording');
    if (!isMedia) return;
    
    // 检查是否有待匹配的文件
    if (pendingDroppedFiles.length === 0) return;
    
    const now = Date.now();
    pendingDroppedFiles = pendingDroppedFiles.filter(f => now - f.timestamp < 60000);
    
    if (pendingDroppedFiles.length === 0) return;
    
    // 🔑 智能匹配：根据文件名相似度找到最佳匹配
    const nodeNameClean = nodeName.replace(/\.[^/.]+$/i, '').replace(/[^a-z0-9\u4e00-\u9fff]/gi, '').toLowerCase();
    
    let bestMatch = null;
    let bestMatchIndex = -1;
    let bestScore = 0;
    
    for (let i = 0; i < pendingDroppedFiles.length; i++) {
      const f = pendingDroppedFiles[i];
      const fileNameClean = f.filename.replace(/\.[^/.]+$/i, '').replace(/[^a-z0-9\u4e00-\u9fff]/gi, '').toLowerCase();
      
      let score = 0;
      if (fileNameClean === nodeNameClean) {
        score = 100;
      } else if (fileNameClean.includes(nodeNameClean) || nodeNameClean.includes(fileNameClean)) {
        score = 50;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = f;
        bestMatchIndex = i;
      }
    }
    
    if (bestMatch && bestScore >= 50) {
      // 设置 pluginData
      try {
        node.setPluginData('originalFilename', bestMatch.filename);
        if (bestMatch.driveFileId) {
          node.setPluginData('driveFileId', bestMatch.driveFileId);
        }
        if (bestMatch.ossFileId) {
          node.setPluginData('ossFileId', bestMatch.ossFileId);
        }
        if (bestMatch.gifCacheId) {
          node.setPluginData('gifCacheId', bestMatch.gifCacheId);
        }
        
        // 如果自动缓存尚未完成（Server 还在处理），先记录 nodeId 以便后续回填
        if (bestMatch.autoCaching && !bestMatch.gifCacheId) {
          bestMatch.pendingNodeId = node.id;
          // 不移除 entry，等缓存完成后由 auto-cache-result 处理
          return;
        }
      } catch (setErr) {
        // 忽略设置错误
      }
      
      // 移除已匹配的、已完成缓存的文件（仍在缓存中的不移除）
      if (!bestMatch.autoCaching) {
        pendingDroppedFiles.splice(bestMatchIndex, 1);
      }
    }
  } catch (e) {
    // 忽略错误
  }
}

