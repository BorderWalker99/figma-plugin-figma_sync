// code.js - 智能布局版本

const PLUGIN_VERSION = '1.0.2'; // 插件版本号

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

// 刷新时间线图层列表（用于检测到增删/重排序时）
async function refreshTimelineLayers(frame) {
  if (!frame || frame.type !== 'FRAME') return;
  
  try {
    // 获取当前图层ID顺序
    const currentLayerIds = frame.children.map(c => c.id);
    
    // 检查顺序是否变化
    const orderChanged = lastTimelineLayerIds.length !== currentLayerIds.length ||
      !lastTimelineLayerIds.every((id, i) => id === currentLayerIds[i]);
    
    if (!orderChanged) return; // 没有变化，不需要刷新
    
    lastTimelineLayerIds = currentLayerIds;
    
    // 重新导出所有图层
    const exportPromises = frame.children.map(async (child) => {
      try {
        const bytes = await child.exportAsync({
          format: 'PNG',
          constraint: { type: 'HEIGHT', value: 800 }
        });
        
        let videoId = null;
        let isVideoLayer = false;
        
        try {
          const pluginDataStr = child.getPluginData('videoId');
          if (pluginDataStr) {
            videoId = pluginDataStr;
            isVideoLayer = true;
          }
        } catch (e) {}
        
        if (!isVideoLayer && 'fills' in child && Array.isArray(child.fills)) {
          for (const fill of child.fills) {
            if (fill.type === 'VIDEO') {
              isVideoLayer = true;
              break;
            }
          }
        }
        
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
          videoId: videoId
        };
      } catch (err) {
        return {
          id: child.id,
          name: child.name,
          type: child.type,
          thumbnail: null,
          isVideoLayer: false,
          videoId: null
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
      recentSyncedFiles.set(msg.filename, {
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
          console.log('🕐 [导出] 使用时间线编辑的 Frame:', frameFromId.name);
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
      
      // 递归查找 Frame 中的所有 GIF 图层（支持嵌套结构）
      async function findAllGifLayers(node, results = []) {
        // 检查当前节点
        let filename = node.getPluginData('originalFilename');
        let isManualDrag = false;
        let isGifDetected = false;
        
        // ✅ 优化：即使有 originalFilename，也尝试通过字节检测确认是否是 GIF
        // 这能处理文件名没有扩展名或扩展名不正确的情况
        if (node.type === 'RECTANGLE' && node.fills && node.fills.length > 0) {
          const fill = node.fills[0];
          
          // 检查 IMAGE 填充（通过字节头识别 GIF）
          if (fill.type === 'IMAGE' && fill.imageHash) {
            try {
              const image = figma.getImageByHash(fill.imageHash);
              if (image) {
                const bytes = await image.getBytesAsync();
                // 检查 GIF 魔法数 (GIF89a 或 GIF87a) -> 'GIF' (0x47, 0x49, 0x46)
                if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
                  isGifDetected = true;
                  
                  // 检查是否有关联数据（用于判断是手动拖入还是手机同步）
                  const driveFileId = node.getPluginData('driveFileId');
                  const ossFileId = node.getPluginData('ossFileId');
                  
                  if (driveFileId || ossFileId) {
                    isManualDrag = false;
                  } else {
                    isManualDrag = true;
                  }
                  
                  // 如果没有 filename，使用节点名称
                  if (!filename) {
                    filename = node.name;
                    if (!filename.toLowerCase().endsWith('.gif')) {
                      filename = filename + '.gif';
                    }
                  }
                }
              }
            } catch (e) {
              // Ignore error
            }
          }
        }
        
        // 如果没有 originalFilename，且不是 GIF，继续检查是否是手动拖入的视频
        if (!filename && !isGifDetected) {
          // 检查填充类型是否是 VIDEO 或 IMAGE
          if (node.type === 'RECTANGLE' && node.fills && node.fills.length > 0) {
            const fill = node.fills[0];
            
            // 方法 1：检查 VIDEO 填充
            if (fill.type === 'VIDEO') {
              // 可能是手动拖入的视频，也可能是手机同步的视频
              // 先检查是否有 driveFileId 或 ossFileId（手机同步的会有）
              const driveFileId = node.getPluginData('driveFileId');
              const ossFileId = node.getPluginData('ossFileId');
              
              if (driveFileId || ossFileId) {
                // 这是手机同步的视频，不是手动拖入
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

      // 3. 检查是否有未同步的 GIF（缺少原始数据）
      const unsyncedGifs = [];
      for (const task of validTasks) {
        for (const gifLayer of task.gifLayers) {
          const driveFileId = gifLayer.layer.getPluginData('driveFileId');
          const ossFileId = gifLayer.layer.getPluginData('ossFileId');
          const originalFilename = gifLayer.layer.getPluginData('originalFilename');
          
          // 如果既没有 driveFileId 也没有 ossFileId，说明这个 GIF 没有原始数据
          if (!driveFileId && !ossFileId) {
            unsyncedGifs.push({
              layerId: gifLayer.layer.id,
              layerName: gifLayer.layer.name,
              filename: originalFilename || gifLayer.layer.name,
              frameId: task.frame.id,
              frameName: task.frame.name
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
          figma.ui.postMessage({
            type: 'export-gif-cancelled'
          });
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
        
        // 收集所有 GIF 图层的信息
        const gifInfos = gifLayers.map((gif, idx) => {
          const layer = gif.layer;
          
          // 计算绝对位置
          const absolutePos = getAbsolutePosition(layer, frame);
          const bounds = {
            x: absolutePos.x,
            y: absolutePos.y,
            width: layer.width,
            height: layer.height
          };
          
          // 获取圆角信息 (支持所有可能有圆角的节点类型)
          let cornerRadius = 0;
          if (layer.cornerRadius !== undefined) {
            // cornerRadius 可能是单个数值或者混合圆角对象
            if (typeof layer.cornerRadius === 'number') {
              cornerRadius = layer.cornerRadius;
            } else if (layer.topLeftRadius !== undefined) {
              // 混合圆角，取最大值作为统一圆角（简化处理）
              cornerRadius = Math.max(
                layer.topLeftRadius || 0,
                layer.topRightRadius || 0,
                layer.bottomLeftRadius || 0,
                layer.bottomRightRadius || 0
              );
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
                x: parentAbsPos.x,
                y: parentAbsPos.y,
                width: parent.width,
                height: parent.height
              };
              
              // 获取裁切容器的圆角 (支持所有节点类型)
              if (parent.cornerRadius !== undefined) {
                if (typeof parent.cornerRadius === 'number') {
                  clipCornerRadius = parent.cornerRadius;
                } else if (parent.topLeftRadius !== undefined) {
                   clipCornerRadius = Math.max(
                      parent.topLeftRadius || 0,
                      parent.topRightRadius || 0,
                      parent.bottomLeftRadius || 0,
                      parent.bottomRightRadius || 0
                    );
                }
              }
              
              break; // 只取最近的裁切容器
            }
            
            // 如果已经到达导出的 Frame，停止向上遍历
            if (parent === frame) break;
            parent = parent.parent;
          }

          // 获取 Image Fill 信息（特别是针对 Crop 模式）
          let imageFillInfo = null;
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
                      scalingFactor: fill.scalingFactor || 1,
                      _debug_test: "TEST_VALUE_FROM_PLUGIN" // 添加一个测试字段
                   };
                   break;
                }
             }
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
        
        // 保存所有图层的原始可见性
        const allLayersVisibility = new Map();
        frame.children.forEach(child => {
          allLayersVisibility.set(child.id, child.visible);
        });
        
        const highestGifIndex = Math.max(...gifIndices);
        
        // 只有当 GIF 下面有图层时才导出 Bottom Layer
        let bottomLayerBytes = null;
        if (lowestGifIndex > 0) {
          // 隐藏 >= lowestGifIndex 的所有图层（包括 GIF 和 GIF 上面的）
          frame.children.forEach((child, index) => {
            if (index >= lowestGifIndex) {
              child.visible = false;
            }
          });
          
          bottomLayerBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 1 }
          });
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            child.visible = allLayersVisibility.get(child.id);
          });
        }
        
        // 收集所有非 GIF 图层的信息（包括它们的 z-index）
        // staticLayers: GIF 之间的图层
        // annotationLayers: GIF 之上的图层（支持时间线控制）
        const staticLayers = [];
        const annotationLayers = [];
        frame.children.forEach((child, index) => {
          const isGif = gifIndices.includes(index);
          if (!isGif && index >= lowestGifIndex && index <= highestGifIndex) {
            // GIF 之间的静态图层
            staticLayers.push({
              index: index,
              name: child.name,
              type: child.type,
              layerId: child.id // ✅ Pass layerId
            });
          } else if (!isGif && index > highestGifIndex) {
            // GIF 之上的标注图层（新增：支持时间线）
            annotationLayers.push({
              index: index,
              name: child.name,
              type: child.type,
              layerId: child.id // ✅ Pass layerId
            });
          }
        });
        
        // 导出每个静态图层
        const staticLayerExports = [];
        for (const layerInfo of staticLayers) {
          // 只显示当前图层，隐藏其他所有图层
          frame.children.forEach((child, index) => {
            child.visible = (index === layerInfo.index);
          });
          
          const layerBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 1 }
          });
          
          staticLayerExports.push({
            index: layerInfo.index,
            name: layerInfo.name,
            bytes: Array.from(layerBytes),
            layerId: layerInfo.layerId // ✅ Pass layerId
          });
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            child.visible = allLayersVisibility.get(child.id);
          });
        }
        
        // 导出每个标注图层（GIF 之上的图层，支持时间线控制）
        const annotationLayerExports = [];
        for (const layerInfo of annotationLayers) {
          // 只显示当前图层，隐藏其他所有图层
          frame.children.forEach((child, index) => {
            child.visible = (index === layerInfo.index);
          });
          
          const layerBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 1 }
          });
          
          annotationLayerExports.push({
            index: layerInfo.index,
            name: layerInfo.name,
            bytes: Array.from(layerBytes),
            layerId: layerInfo.layerId // ✅ Pass layerId
          });
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            child.visible = allLayersVisibility.get(child.id);
          });
        }
        
        // 如果没有单独的标注图层，则使用传统的合成方式导出
        let annotationBytes = null;
        if (annotationLayerExports.length === 0) {
          // 隐藏 <= 最高 GIF 索引的所有图层（包括 GIF 和 GIF 下面的）
          frame.children.forEach((child, index) => {
            if (index <= highestGifIndex) {
              child.visible = false;
            }
          });
          
          annotationBytes = await frame.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 1 }
          });
        }
        
        // 恢复Frame的背景填充
        frame.fills = originalFills;
        
        // 恢复所有图层的可见性
        frame.children.forEach(child => {
          child.visible = allLayersVisibility.get(child.id);
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
            width: frame.width,
            height: frame.height
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
      const errorMessage = error && error.message ? error.message : String(error || '未知错误');
      figma.ui.postMessage({
        type: 'export-gif-error',
        error: '导出失败: ' + errorMessage
      });
    }
    
    return;
  }
  
  // 处理服务器修复请求
  if (msg.type === 'repair-server') {
    try {
      const { exec } = require('child_process');
      const installPath = msg.installPath || '/Applications/ScreenSync - SourceCode';
      
      exec('launchctl start com.screensync.server 2>&1', (error, stdout, stderr) => {
        if (error) {
          const startCommand = `cd "${installPath}" && npm start > /dev/null 2>&1 &`;
          exec(startCommand, (error2, stdout2, stderr2) => {
            if (error2) {
              figma.ui.postMessage({
                type: 'repair-server-response',
                success: false,
                message: '自动启动失败，请手动启动服务器'
              });
            } else {
              figma.ui.postMessage({
                type: 'repair-server-response',
                success: true,
                message: '服务器已自动启动，正在重新连接...'
              });
            }
          });
        } else {
          figma.ui.postMessage({
            type: 'repair-server-response',
            success: true,
            message: '服务器已自动启动，正在重新连接...'
          });
        }
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'repair-server-response',
        success: false,
        message: '自动修复失败: ' + error.message
      });
    }
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
        recentSyncedFiles.set(filename, {
          driveFileId,
          ossFileId,
          gifCacheId,
          originalFilename: filename
        });
        
        // 缓存无扩展名版本（应对 Figma 图层名可能没有扩展名的情况）
        const nameWithoutExt = filename.replace(/\.[^/.]+$/, "");
        if (nameWithoutExt !== filename) {
          recentSyncedFiles.set(nameWithoutExt, {
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
      
      // 保存文件名到 pluginData，用于后续识别
      if (msg.filename) {
        rect.setPluginData('originalFilename', msg.filename);
        
        const filenameLower = msg.filename.toLowerCase();
        const isGifOrVideo = filenameLower.endsWith('.gif') || 
                             filenameLower.endsWith('.mov') || 
                             filenameLower.endsWith('.mp4');
        const filenameIndicatesRecording = msg.filename.includes('ScreenRecording');
        
        if (isGifOrVideo || filenameIndicatesRecording) {
          if (msg.driveFileId) {
            rect.setPluginData('driveFileId', msg.driveFileId);
          }
          if (msg.ossFileId) {
            rect.setPluginData('ossFileId', msg.ossFileId);
          }
          if (msg.gifCacheId) {
            rect.setPluginData('gifCacheId', msg.gifCacheId);
          }
        }
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
    figma.ui.postMessage({ 
      type: 'plugin-closing'
    });
    setTimeout(() => {
    figma.closePlugin('已同步 ' + screenshotCount + ' 张截图');
    }, 200);
  }
  
  if (msg.type === 'stop-realtime') {
    // 这个消息由UI发送，用于停止实时同步
    // 实际停止逻辑在服务器端，这里只是确认收到
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
    const hasValidFrame = selection && selection.length > 0 && selection[0].type === 'FRAME';
    figma.ui.postMessage({
      type: 'frame-selection-result',
      hasValidFrame: hasValidFrame
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
          
          try {
            const pluginDataStr = child.getPluginData('videoId');
            if (pluginDataStr) {
              videoId = pluginDataStr;
              isVideoLayer = true;
            }
          } catch (e) {
            // No video data
          }
          
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
          
          const hasVideoFill = child.fills && Array.isArray(child.fills) && child.fills.some(f => f.type === 'VIDEO');
          console.log('Timeline layer: ' + child.name + ', isVideoLayer: ' + isVideoLayer + ', hasVideoFill: ' + hasVideoFill + ', videoId: ' + videoId);
          
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
            videoId: videoId
          };
        } catch (err) {
          console.error(`Failed to export layer ${child.name}:`, err);
          return {
            id: child.id,
            name: child.name,
            type: child.type,
            thumbnail: null,
            isVideoLayer: false,
            videoId: null
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
    lastTimelineLayerIds = []; // 重置图层顺序缓存
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
            
            if (hadDriveFileId || hadOssFileId) {
              node.setPluginData('driveFileId', '');
              node.setPluginData('ossFileId', '');
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
        figma.ui.postMessage({
          type: 'trigger-export-from-code'
        });
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

// ✅ 监听拖放事件，记录原始文件名
figma.on('drop', (event) => {
  try {
    if (event.files && event.files.length > 0) {
      for (const file of event.files) {
        const filename = file.name;
        const ext = filename.toLowerCase().split('.').pop();
        
        if (['mov', 'mp4', 'gif'].includes(ext)) {
          pendingDroppedFiles.push({
            filename: filename,
            timestamp: Date.now()
          });
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
      // 位置变化 - 只更新位置
      const positionOnlyProperties = ['x', 'y'];
      // 尺寸变化 - 需要更新位置和缩略图（缩放会改变外观）
      const sizeProperties = ['width', 'height'];
      // 样式变化 - 需要重新导出缩略图
      const styleProperties = ['fills', 'strokes', 'effects', 'opacity', 'blendMode', 'cornerRadius', 'rotation', 'visible'];
      // 所有需要监听的属性
      const allProperties = [...positionOnlyProperties, ...sizeProperties, ...styleProperties];
      
      const propertyChanges = event.documentChanges.filter(change => 
        change.type === 'PROPERTY_CHANGE' && 
        change.properties.some(p => allProperties.includes(p))
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
                  
                  // 检查是否有样式或尺寸变化，需要更新缩略图
                  const needsThumbnailUpdate = change.properties.some(p => 
                    styleProperties.includes(p) || sizeProperties.includes(p)
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
            
            // 异步更新缩略图
            if (thumbnailUpdates.length > 0) {
              (async () => {
                const thumbResults = [];
                for (const item of thumbnailUpdates) {
                  try {
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
      const structuralChanges = event.documentChanges.filter(change => 
        change.type === 'CREATE' || change.type === 'DELETE'
      );
      
      if (structuralChanges.length > 0) {
        const frame = figma.getNodeById(timelineFrameId);
        if (frame && frame.type === 'FRAME') {
          // 检查是否有涉及此 Frame 子图层的变化
          let needsRefresh = false;
          
          for (const change of structuralChanges) {
            try {
              if (change.type === 'CREATE') {
                // 新建的节点如果父级是此 Frame，则需要刷新
                const node = change.node;
                if (node && node.parent && node.parent.id === timelineFrameId) {
                  needsRefresh = true;
                  break;
                }
              } else if (change.type === 'DELETE') {
                // 删除事件：通知 UI 检查并移除对应图层
                needsRefresh = true;
                break;
              }
            } catch (e) {
              // 节点可能已被删除，忽略
            }
          }
          
          if (needsRefresh) {
            // 重新获取当前图层列表并发送给 UI
            refreshTimelineLayers(frame);
          }
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
        if (!node || typeof node.type === 'undefined') continue;
        
        // 只处理矩形节点（GIF 通常是矩形）
        if (node.type !== 'RECTANGLE') continue;
        
        // ⚠️ 只处理 GIF 文件，完全跳过视频文件
        // 访问视频节点可能导致 Figma 内部验证失败
        const nodeName = node.name || '';
        const nameLower = nodeName.toLowerCase();
        
        // 如果名称看起来像视频文件，完全跳过
        const looksLikeVideo = nameLower.endsWith('.mov') || 
                              nameLower.endsWith('.mp4') ||
                              nameLower.includes('screenrecording');
        
        if (looksLikeVideo) {
          // 视频文件：只记录原始文件名，不做任何其他处理
          if (pendingDroppedFiles.length > 0) {
            const now = Date.now();
            pendingDroppedFiles = pendingDroppedFiles.filter(f => now - f.timestamp < 5000);
            if (pendingDroppedFiles.length > 0) {
              // 🔑 智能匹配：根据文件名相似度找到最佳匹配，而不是简单取队列头部
              const nodeNameClean = nodeName.replace(/\.(mov|mp4|gif)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
              
              let bestMatch = null;
              let bestMatchIndex = -1;
              let bestScore = 0;
              
              for (let i = 0; i < pendingDroppedFiles.length; i++) {
                const f = pendingDroppedFiles[i];
                const fileNameClean = f.filename.replace(/\.(mov|mp4|gif)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
                
                // 计算相似度分数
                let score = 0;
                
                // 完全匹配
                if (fileNameClean === nodeNameClean) {
                  score = 100;
                }
                // 包含匹配
                else if (fileNameClean.includes(nodeNameClean) || nodeNameClean.includes(fileNameClean)) {
                  score = 50;
                }
                // 提取数字序号匹配（如 ScreenRecording_003 vs ScreenRecordingVid_003）
                else {
                  const nodeNumbers = nodeNameClean.match(/\d+/g);
                  const fileNumbers = fileNameClean.match(/\d+/g);
                  if (nodeNumbers && fileNumbers) {
                    // 检查最后一个数字是否匹配（通常是序号）
                    const nodeLastNum = nodeNumbers[nodeNumbers.length - 1];
                    const fileLastNum = fileNumbers[fileNumbers.length - 1];
                    if (nodeLastNum === fileLastNum) {
                      score = 30;
                    }
                  }
                }
                
                if (score > bestScore) {
                  bestScore = score;
                  bestMatch = f;
                  bestMatchIndex = i;
                }
              }
              
              // 如果找到匹配，使用它；否则使用队列第一个（兼容单文件情况）
              const droppedFile = bestMatch || pendingDroppedFiles[0];
              const removeIndex = bestMatchIndex >= 0 ? bestMatchIndex : 0;
              pendingDroppedFiles.splice(removeIndex, 1);
              
              // 延迟更久再修改节点，给 Figma 充足时间加载视频
              const nodeId = node.id;
              const originalFilename = droppedFile.filename;
              setTimeout(() => {
                try {
                  const n = figma.getNodeById(nodeId);
                  if (n && n.type === 'RECTANGLE') {
                    // 只保存文件名，不做其他操作
                    n.setPluginData('originalFilename', originalFilename);
                    // 重命名图层（帮助用户识别）
                    if (n.name !== originalFilename) {
                      n.name = originalFilename;
                    }
                    // 🎯 自动缩放到设置的尺寸
                    autoResizeNode(n);
                  }
                } catch (e) {
                  // 忽略错误
                }
              }, 1500); // 延迟 1.5 秒
            }
          } else {
            // 没有 pendingDroppedFiles，但仍需自动缩放
            const nodeId = node.id;
            setTimeout(() => {
              try {
                const n = figma.getNodeById(nodeId);
                if (n && n.type === 'RECTANGLE') {
                  autoResizeNode(n);
                }
              } catch (e) {
                // 忽略错误
              }
            }, 1500);
          }
          continue; // 跳过后续处理
        }
        
        // 只处理 GIF 文件
        const mightBeGif = nameLower.endsWith('.gif') || nameLower.includes('gif');
        
        if (mightBeGif) {
          nodeIdsToProcess.push(node.id);
        }
      } catch (e) {
        // 🛡️ 切换文件时节点可能无效，忽略错误
        continue;
      }
    }
    
    if (nodeIdsToProcess.length === 0) return;
    
    // ⏰ 延迟 1 秒再处理 GIF，让 Figma 完成内部加载
    setTimeout(() => {
      for (const nodeId of nodeIdsToProcess) {
        try {
          const node = figma.getNodeById(nodeId);
          if (!node || node.type !== 'RECTANGLE') continue;
          
          // 再次检查节点是否有效（可能已被删除）
          let fills;
          try {
            fills = node.fills;
          } catch (e) {
            continue; // 无法访问 fills，跳过
          }
          
          if (!fills || fills.length === 0) continue;
          
          const fill = fills[0];
          
          // ⚠️ 只处理 IMAGE 填充（GIF 是 IMAGE 类型）
          // 如果是 VIDEO 填充，完全跳过
          if (fill.type !== 'IMAGE') continue;
          
          const nodeName = node.name || '';
          
          // 🔑 检查是否有待处理的拖入文件（使用智能匹配）
          let originalFilename = nodeName;
          
          const now = Date.now();
          pendingDroppedFiles = pendingDroppedFiles.filter(f => now - f.timestamp < 5000);
          
          if (pendingDroppedFiles.length > 0) {
            // 🔑 智能匹配：根据文件名相似度找到最佳匹配
            const nodeNameClean = nodeName.replace(/\.(mov|mp4|gif)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
            
            let bestMatch = null;
            let bestMatchIndex = -1;
            let bestScore = 0;
            
            for (let i = 0; i < pendingDroppedFiles.length; i++) {
              const f = pendingDroppedFiles[i];
              const fileNameClean = f.filename.replace(/\.(mov|mp4|gif)$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
              
              let score = 0;
              if (fileNameClean === nodeNameClean) {
                score = 100;
              } else if (fileNameClean.includes(nodeNameClean) || nodeNameClean.includes(fileNameClean)) {
                score = 50;
              } else {
                const nodeNumbers = nodeNameClean.match(/\d+/g);
                const fileNumbers = fileNameClean.match(/\d+/g);
                if (nodeNumbers && fileNumbers) {
                  const nodeLastNum = nodeNumbers[nodeNumbers.length - 1];
                  const fileLastNum = fileNumbers[fileNumbers.length - 1];
                  if (nodeLastNum === fileLastNum) {
                    score = 30;
                  }
                }
              }
              
              if (score > bestScore) {
                bestScore = score;
                bestMatch = f;
                bestMatchIndex = i;
              }
            }
            
            const droppedFile = bestMatch || pendingDroppedFiles[0];
            const removeIndex = bestMatchIndex >= 0 ? bestMatchIndex : 0;
            pendingDroppedFiles.splice(removeIndex, 1);
            
            originalFilename = droppedFile.filename;
            
            if (nodeName !== originalFilename) {
              node.name = originalFilename;
            }
          }
          
          // 🔑 自动保存原始文件名
          const existingFilename = node.getPluginData('originalFilename');
          if (!existingFilename && originalFilename) {
            node.setPluginData('originalFilename', originalFilename);
          }
          
          // 🎯 自动缩放到设置的尺寸
          autoResizeNode(node);
          
          // 检查是否已有关联数据
          const hasExistingData = node.getPluginData('driveFileId') || 
                                  node.getPluginData('ossFileId') ||
                                  node.getPluginData('gifCacheId');
          
          if (hasExistingData) {
            continue;
          }
          
          // 请求UI返回缓存的元数据
          figma.ui.postMessage({
            type: 'request-skipped-file-cache-for-node',
            filename: nodeName,
            nodeId: node.id
          });
        } catch (e) {
          // 节点可能已被删除或无法访问，忽略错误
        }
      }
    }, 1000); // GIF 延迟 1 秒
  } catch (e) {
    // 🛡️ 切换文件时可能触发各种错误，忽略它们
  }
});
