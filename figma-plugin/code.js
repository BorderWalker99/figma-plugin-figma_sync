// code.js - 智能布局版本

const PLUGIN_VERSION = '1.0.1'; // 插件版本号

// 🛡️ 全局错误处理，防止切换文件时崩溃
// Figma 插件没有 window.onerror，但我们可以尽量保护关键代码
let isPluginReady = false;

console.log('🚀🚀🚀 Figma插件启动 - 纯净载荷版本！🚀🚀🚀');
console.log('📦 插件版本:', PLUGIN_VERSION);
console.log('🔍 将输出详细的 imageTransform 检查日志');

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
      
      if (maxScreenshotIndex > 0 || maxScreenRecordingIndex > 0) {
        console.log(`📊 从画板初始化计数器: Screenshot=${screenshotIndex}, ScreenRecording=${screenRecordingIndex}`);
      }
    }
  } catch (e) {
    console.log('⚠️ 初始化计数器时出错（可能正在切换文件）:', e.message);
  }
}

// 🛡️ 延迟初始化，确保 Figma 文档已完全加载
// 这可以防止在切换文件时发生的闪退
setTimeout(() => {
  try {
    initializeCounters();
    isPluginReady = true;
    console.log('✅ 插件已准备就绪');
  } catch (e) {
    console.log('⚠️ 初始化时出错:', e.message);
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
    if (customSizeSettings.width || customSizeSettings.height || customSizeSettings.columns) {
      console.log('📖 已加载保存的设置:', customSizeSettings);
    }
  } catch (error) {
    console.error('❌ 加载设置失败:', error);
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
    // 检查画板是否在当前页面
    const page = figma.currentPage;
    if (!page || !page.children) return false;
    return page.children.includes(currentFrame);
  } catch (error) {
    console.log('画板已失效');
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
    console.log('⚠️ 查找画板时出错:', e.message);
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
    console.log('✅ 找到已存在的画板: ScreenSync Screenshots');
    currentFrame = existingFrame;
    
    // 确保画板使用 Auto Layout（如果还没有设置，或者设置不完整）
    if (currentFrame.layoutMode === 'NONE' || currentFrame.layoutMode !== 'HORIZONTAL') {
      currentFrame.layoutMode = 'HORIZONTAL';
      console.log('   🔄 为画板启用 Auto Layout（水平布局）');
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
  console.log('🖼️ 自动创建画板...');
  
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
    
    console.log('✅ 画板自动创建成功（Auto Layout 水平布局）');
    return true;
  } catch (error) {
    console.error('❌ 创建画板失败:', error);
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
  
  console.log('📊 已占用位置:', Array.from(occupiedPositions));
  
  // 按行优先顺序查找第一个空位
  let maxRow = Math.ceil(children.length / columns) + 1;
  
  for (let row = 0; row < maxRow; row++) {
    for (let col = 0; col < columns; col++) {
      const posKey = `${col},${row}`;
      if (!occupiedPositions.has(posKey)) {
        console.log(`✅ 找到空位: 第${row + 1}行, 第${col + 1}列`);
        return { col, row };
      }
    }
  }
  
  // 如果没有找到空位，返回新的行
  console.log('📍 所有位置已占用，使用新行');
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
    // 🛡️ 检查插件是否就绪，避免在初始化期间处理消息
    if (!msg || !msg.type) {
      console.log('⚠️ 收到无效消息，忽略');
      return;
    }
    
    console.log('📬 收到UI消息:', msg.type);
  
  // ✅ 处理UI返回的跳过文件缓存数据
  if (msg.type === 'skipped-file-cache-response') {
    console.log('📥 收到UI缓存响应:', msg.filename);
    if (msg.cacheData) {
      console.log('   gifCacheId:', msg.cacheData.gifCacheId || '无');
      console.log('   driveFileId:', msg.cacheData.driveFileId || '无');
      console.log('   ossFileId:', msg.cacheData.ossFileId || '无');
      
      // 将缓存数据添加到 recentSyncedFiles，以便导出时使用
      recentSyncedFiles.set(msg.filename, {
        originalFilename: msg.filename,
        gifCacheId: msg.cacheData.gifCacheId || null,
        driveFileId: msg.cacheData.driveFileId || null,
        ossFileId: msg.cacheData.ossFileId || null,
        timestamp: msg.cacheData.timestamp
      });
      
      console.log('   ✅ 已添加到 recentSyncedFiles 缓存');
      
      // 如果有nodeId，说明是从documentchange监听器触发的，需要自动关联到节点
      if (msg.nodeId) {
        console.log('   🔗 自动关联缓存数据到节点:', msg.nodeId);
        
        try {
          const node = figma.getNodeById(msg.nodeId);
          
          if (node && node.type === 'RECTANGLE') {
            // 保存文件名
            node.setPluginData('originalFilename', msg.filename);
            console.log('      ✅ 已保存 originalFilename:', msg.filename);
            
            // 保存driveFileId
            if (msg.cacheData.driveFileId) {
              node.setPluginData('driveFileId', msg.cacheData.driveFileId);
              console.log('      ✅ 已保存 driveFileId:', msg.cacheData.driveFileId);
            }
            
            // 保存ossFileId
            if (msg.cacheData.ossFileId) {
              node.setPluginData('ossFileId', msg.cacheData.ossFileId);
              console.log('      ✅ 已保存 ossFileId:', msg.cacheData.ossFileId);
            }
            
            // 保存gifCacheId（最重要！用于导出时查找原始文件）
            if (msg.cacheData.gifCacheId) {
              node.setPluginData('gifCacheId', msg.cacheData.gifCacheId);
              console.log('      ✅ 已保存 gifCacheId:', msg.cacheData.gifCacheId);
              console.log('      💡 导出时会自动从缓存读取原始Video（无需手动上传）');
            }
            
            console.log('   🎉 自动关联完成！此Video导出时无需手动上传');
          } else {
            console.warn('   ⚠️  节点不存在或类型不是RECTANGLE');
          }
        } catch (error) {
          console.error('   ❌ 自动关联失败:', error);
        }
      }
    }
    return;
  }
  
  // 处理强制关闭插件（单实例限制）
  if (msg.type === 'close-plugin') {
    console.log('🔒 收到关闭插件请求（检测到其他实例）');
    figma.closePlugin();
    return;
  }

  // 处理取消GIF导出
  if (msg.type === 'cancel-gif-export') {
    console.log('🛑 收到取消GIF导出请求');
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
    console.log(`📥 收到 Server 缓存检查结果: ${msg.results.length} 个文件, fromExport: ${msg.fromExport}`);
    
    let updatedCount = 0;
    
    for (const res of msg.results) {
      if (res.found && res.layerId) {
        const node = figma.getNodeById(res.layerId);
        if (node) {
          console.log(`   ✅ 自动关联 Server 缓存: ${node.name}`);
          if (res.gifCacheId) node.setPluginData('gifCacheId', res.gifCacheId);
          if (res.driveFileId) node.setPluginData('driveFileId', res.driveFileId);
          if (res.ossFileId) node.setPluginData('ossFileId', res.ossFileId);
          updatedCount++;
        }
      }
    }
    
    console.log(`   🎉 已自动修复 ${updatedCount} 个图层的关联数据`);
    
    // ✅ 只有在导出流程中才触发导出，自动关联场景不触发
    if (msg.fromExport) {
      // 重新触发导出，但跳过检查以避免死循环（如果有剩下的确实没找到）
      figma.ui.postMessage({
        type: 'trigger-export-from-code',
        skipServerCheck: true
      });
    } else {
      console.log('   ℹ️  非导出流程，跳过触发导出');
    }
    return;
  }

  // 处理导出带标注的 GIF
  if (msg.type === 'export-annotated-gif') {
    console.log('🎬 开始导出带标注的 GIF');
    
    // 重置取消标志
    cancelGifExport = false;
    
    try {
      const selection = figma.currentPage.selection;
      console.log('   选中的节点数量:', selection ? selection.length : 'selection is null/undefined');
      
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
        
        console.log(`   🔎 正在检查节点: ${node.name} (type: ${node.type})`);
        console.log(`      originalFilename (pluginData): ${filename || '无'}`);
        
        // ✅ 优化：即使有 originalFilename，也尝试通过字节检测确认是否是 GIF
        // 这能处理文件名没有扩展名或扩展名不正确的情况
        if (node.type === 'RECTANGLE' && node.fills && node.fills.length > 0) {
          const fill = node.fills[0];
          console.log(`      填充类型: ${fill.type}`);
          
          // 检查 IMAGE 填充（通过字节头识别 GIF）
          if (fill.type === 'IMAGE' && fill.imageHash) {
            try {
              const image = figma.getImageByHash(fill.imageHash);
              if (image) {
                const bytes = await image.getBytesAsync();
                // 检查 GIF 魔法数 (GIF89a 或 GIF87a) -> 'GIF' (0x47, 0x49, 0x46)
                if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
                  console.log(`   🎨 [ByteCheck] 检测到 GIF 格式图片: ${node.name}`);
                  isGifDetected = true;
                  
                  // 检查是否有关联数据（用于判断是手动拖入还是手机同步）
                  const driveFileId = node.getPluginData('driveFileId');
                  const ossFileId = node.getPluginData('ossFileId');
                  
                  if (driveFileId || ossFileId) {
                    console.log(`   📱 检测到手机同步的 GIF 图层: ${node.name}`);
                    isManualDrag = false;
                  } else {
                    console.log(`   🎬 检测到手动拖入的 GIF 图层: ${node.name}`);
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
              console.error('Failed to read image bytes:', e);
            }
          }
        }
        
        // 如果没有 originalFilename，且不是 GIF，继续检查是否是手动拖入的视频
        if (!filename && !isGifDetected) {
          console.log('      没有 originalFilename，检查填充类型...');
          // 检查填充类型是否是 VIDEO 或 IMAGE
          if (node.type === 'RECTANGLE' && node.fills && node.fills.length > 0) {
            const fill = node.fills[0];
            // 填充类型已在上面打印过
            
            // 方法 1：检查 VIDEO 填充
            if (fill.type === 'VIDEO') {
              // 可能是手动拖入的视频，也可能是手机同步的视频
              // 先检查是否有 driveFileId 或 ossFileId（手机同步的会有）
              const driveFileId = node.getPluginData('driveFileId');
              const ossFileId = node.getPluginData('ossFileId');
              
              console.log(`      检查 driveFileId: ${driveFileId || '无'}`);
              console.log(`      检查 ossFileId: ${ossFileId || '无'}`);
              
              if (driveFileId || ossFileId) {
                // 这是手机同步的视频，不是手动拖入
                console.log(`      ✅ 这是手机同步的视频（有 fileId）`);
                isManualDrag = false;
              } else {
                // 可能是手动拖入的视频，尝试从UI缓存中查找
                console.log(`      🔄 可能是手动拖入的视频，尝试从UI缓存查找: ${node.name}`);
                
                // 请求UI返回缓存数据
                figma.ui.postMessage({
                  type: 'request-skipped-file-cache',
                  filename: node.name
                });
                
                // 注意：这里是异步的，我们需要等待UI返回数据
                // 为了保持同步流程，我们先尝试从 recentSyncedFiles 缓存中查找
                console.log(`      🔄 尝试在缓存中查找: ${node.name} (当前缓存 ${recentSyncedFiles.size} 个文件)`);
                
                // 打印所有缓存键值（仅调试用）
                if (recentSyncedFiles.size > 0) {
                  console.log(`         缓存列表:`, Array.from(recentSyncedFiles.keys()));
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
                      console.log(`         ✨ 模糊匹配成功: ${key} -> ${node.name}`);
                      break;
                    }
                  }
                }
                
                if (cachedInfo) {
                  console.log(`      ✅ 匹配成功! 原始文件: ${cachedInfo.originalFilename}`);
                  
                  // 自动关联数据
                  node.setPluginData('driveFileId', cachedInfo.driveFileId || '');
                  node.setPluginData('ossFileId', cachedInfo.ossFileId || '');
                  node.setPluginData('gifCacheId', cachedInfo.gifCacheId || '');
                  node.setPluginData('originalFilename', cachedInfo.originalFilename);
                  
                  isManualDrag = false;
                } else {
                  // 确实是无数据的，需要手动上传
                  console.log(`      ⚠️  未在缓存中找到匹配文件，需要手动上传`);
                  isManualDrag = true;
                }
              }
              
              filename = node.name;
              
              // 尝试从图层名称推断扩展名
              if (!filename.toLowerCase().endsWith('.mp4') && !filename.toLowerCase().endsWith('.mov')) {
                // 如果图层名称没有扩展名，添加 .mov（视频默认格式）
                filename = filename + '.mov';
                console.log(`      推断文件名（添加 .mov）: ${filename}`);
              } else {
                console.log(`      使用图层名称作为文件名: ${filename}`);
              }
            }
            // 注意：IMAGE 填充的 GIF 检测已在函数开头处理
          }
        }
        
        if (filename && (isGifDetected || filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov') || filename.toLowerCase().endsWith('.gif'))) {
          console.log(`      最终 filename: ${filename}`);
          
          // 检查 1：文件扩展名
          const hasValidExtension = filename.toLowerCase().endsWith('.gif') || 
                                   filename.toLowerCase().endsWith('.mov') || 
                                   filename.toLowerCase().endsWith('.mp4');
          
          // 检查 2：图层名称（兼容没有扩展名的情况）
          const isScreenRecordingLayer = node.name && node.name.startsWith('ScreenRecording_');
          
          // 检查 3：文件名包含 ScreenRecording（兼容没有扩展名的情况）
          const filenameIndicatesRecording = filename.includes('ScreenRecording');
          
          console.log(`      hasValidExtension: ${hasValidExtension}`);
          console.log(`      isScreenRecordingLayer: ${isScreenRecordingLayer}`);
          console.log(`      filenameIndicatesRecording: ${filenameIndicatesRecording}`);
          
          if (hasValidExtension || isScreenRecordingLayer || filenameIndicatesRecording || isGifDetected) {
            console.log(`      ✅ 图层符合条件，添加到结果列表`);
            
            // 如果是手动拖入的，保存文件名到 pluginData（以便下次识别）
            if (isManualDrag && !node.getPluginData('originalFilename')) {
              node.setPluginData('originalFilename', filename);
              console.log(`      💾 已保存文件名到 pluginData: ${filename}`);
            }
            
            results.push({ layer: node, filename: filename });
          } else {
            console.log(`      ⏭️  图层不符合条件，跳过`);
          }
        } else {
          console.log(`      ⏭️  无 filename 或非 GIF/Video，跳过此节点`);
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

      console.log(`✅ 找到 ${validTasks.length} 个可导出的 GIF 任务`);

      // 3. 检查是否有未同步的 GIF（缺少原始数据）
      const unsyncedGifs = [];
      for (const task of validTasks) {
        for (const gifLayer of task.gifLayers) {
          const driveFileId = gifLayer.layer.getPluginData('driveFileId');
          const ossFileId = gifLayer.layer.getPluginData('ossFileId');
          const gifCacheId = gifLayer.layer.getPluginData('gifCacheId');
          const originalFilename = gifLayer.layer.getPluginData('originalFilename');
          
          // 🔍 详细调试信息
          console.log('\n   🔍 检查图层: ' + gifLayer.layer.name);
          console.log('      类型: ' + gifLayer.layer.type);
          
          // 安全地获取填充类型
          let fillType = '无';
          try {
            if (gifLayer.layer.fills && gifLayer.layer.fills.length > 0) {
              fillType = gifLayer.layer.fills[0].type || '无';
            }
          } catch (e) {
            fillType = '错误';
          }
          console.log('      填充类型: ' + fillType);
          
          console.log('      originalFilename: ' + (originalFilename || '无'));
          console.log('      driveFileId: ' + (driveFileId || '无'));
          console.log('      ossFileId: ' + (ossFileId || '无'));
          console.log('      gifCacheId: ' + (gifCacheId || '无'));
          
          // 如果既没有 driveFileId 也没有 ossFileId，说明这个 GIF 没有原始数据
          if (!driveFileId && !ossFileId) {
            console.log('   ⚠️  检测到未同步的 GIF: ' + gifLayer.layer.name + ' (文件名: ' + (originalFilename || '未知') + ')');
            unsyncedGifs.push({
              layerId: gifLayer.layer.id,
              layerName: gifLayer.layer.name,
              filename: originalFilename || gifLayer.layer.name,
              frameId: task.frame.id,
              frameName: task.frame.name
            });
          } else {
            console.log('   ✅ 图层有完整同步数据，可以直接导出');
          }
        }
      }
      
      // 如果有未同步的 GIF，先尝试从服务器检查缓存
      if (unsyncedGifs.length > 0) {
        // 如果是强制跳过检查（例如已经检查过一次了），则直接请求上传
        if (msg.skipServerCheck) {
          console.log(`   🔔 发现 ${unsyncedGifs.length} 个未同步的 GIF (Server已检查)，请求用户上传`);
          figma.ui.postMessage({
            type: 'request-upload-gifs',
            unsyncedGifs: unsyncedGifs
          });
          return; // 停止导出流程，等待用户上传
        }

        console.log(`   🔍 发现 ${unsyncedGifs.length} 个未同步的 GIF，先尝试从 Server 检查缓存...`);
        figma.ui.postMessage({
          type: 'check-server-cache-for-unsynced',
          unsyncedGifs: unsyncedGifs
        });

        // ✅ 设置超时保护 (3秒)
        if (serverCheckTimer) clearTimeout(serverCheckTimer);
        serverCheckTimer = setTimeout(() => {
          console.warn('⚠️ Server 缓存检查超时 (2s)，自动切换到手动上传模式');
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
          console.log('🛑 检测到取消信号，停止导出');
          figma.ui.postMessage({
            type: 'export-gif-cancelled'
          });
          return;
        }
        
        const task = validTasks[i];
        const { frame, gifLayers } = task;
        
        console.log(`\n🚀 处理第 ${i + 1}/${validTasks.length} 个任务`);
        console.log(`   Frame: ${frame.name}`);
        console.log(`   包含 ${gifLayers.length} 个 GIF 图层:`);
        gifLayers.forEach((gif, idx) => {
          console.log(`      ${idx + 1}. ${gif.layer.name} (${gif.filename})`);
        });

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
              
              console.log(`      🔍 检测到裁切容器: ${parent.name}, 类型: ${parent.type}`);
              console.log(`         裁切区域: (${clipBounds.x}, ${clipBounds.y}), ${clipBounds.width}x${clipBounds.height}`);
              console.log(`         裁切圆角: ${clipCornerRadius}px`);
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
                   
                   // 详细调试日志
                   console.log(`      🔍 检查图层 "${layer.name}" 的 ${fill.type} Fill:`);
                   console.log(`         - scaleMode: ${fill.scaleMode}`);
                   console.log(`         - imageTransform (原始类型): ${typeof fill.imageTransform}`);
                   
                   if (fill.imageTransform) {
                      console.log(`         - imageTransform (原始值):`, fill.imageTransform);
                      try {
                        transformArray = [
                           [fill.imageTransform[0][0], fill.imageTransform[0][1], fill.imageTransform[0][2]],
                           [fill.imageTransform[1][0], fill.imageTransform[1][1], fill.imageTransform[1][2]]
                        ];
                        console.log(`         - imageTransform (转换成功):`, JSON.stringify(transformArray));
                      } catch (e) {
                        console.error(`         ❌ 转换 imageTransform 失败:`, e);
                      }
                   } else {
                      console.warn(`         ⚠️ imageTransform 为空或 undefined!`);
                      // 如果是 CROP 模式但没有 imageTransform，这很不正常
                      if (fill.scaleMode === 'CROP' || fill.scaleMode === 'FILL') {
                         console.warn(`         ⚠️ CROP/FILL 模式下缺少 imageTransform，尝试从 PluginData 获取...`);
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
          
          if (!imageFillInfo) {
             console.error(`❌ 严重错误: GIF ${idx + 1} 没有找到 Image Fill 信息！`);
          } else {
             console.log(`✅ 最终 imageFillInfo (GIF ${idx + 1}):`, JSON.stringify(imageFillInfo));
          }
          
          console.log(`   收集 GIF ${idx + 1} 信息:`);
          console.log(`      图层名: ${layer.name}`);
          console.log(`      文件名: ${gif.filename}`);
          console.log(`      相对位置: (${layer.x}, ${layer.y})`);
          console.log(`      绝对位置: (${bounds.x}, ${bounds.y})`);
          console.log(`      尺寸: ${bounds.width}x${bounds.height}`);
          console.log(`      圆角: ${cornerRadius}px`);
          console.log(`      裁切: ${clipBounds ? '是' : '否'}`);
          
          // 验证数据完整性
          if (bounds.x === undefined || bounds.y === undefined) {
            console.error(`      ⚠️ 警告：位置数据缺失！`);
          }
          if (!bounds.width || !bounds.height) {
            console.error(`      ⚠️ 警告：尺寸数据无效！`);
          }
          
          // 获取该 GIF 在 frame.children 中的索引（z-index）
          const zIndex = Array.from(frame.children).indexOf(layer);
          
          // 获取 imageHash（用于手动上传的文件查找）
          const imageHash = layer.getPluginData('imageHash');
          const driveFileId = layer.getPluginData('driveFileId');
          const ossFileId = layer.getPluginData('ossFileId');
          
          console.log(`      imageHash: ${imageHash || '无'}`);
          console.log(`      driveFileId: ${driveFileId || '无'}`);
          console.log(`      ossFileId: ${ossFileId || '无'}`);
          
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
            zIndex: zIndex // ✅ 添加 z-index，用于正确的图层顺序合成
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
            console.log(`   📋 Frame背景色: rgba(${frameBackground.r}, ${frameBackground.g}, ${frameBackground.b}, ${frameBackground.a})`);
          }
        }
        
        // 临时移除Frame的背景填充，避免背景色覆盖GIF
        const originalFills = frame.fills;
        frame.fills = [];
        
        // 找到所有 GIF 图层在 Frame.children 中的索引
        const gifIndices = gifLayers.map(gif => {
          const index = Array.from(frame.children).indexOf(gif.layer);
          console.log(`   📌 GIF图层 "${gif.layer.name}" 在 Frame.children 中的索引: ${index}`);
          return index;
        }).filter(idx => idx !== -1);
        
        // 找到最底层的 GIF（索引最小）
        const lowestGifIndex = Math.min(...gifIndices);
        console.log(`   📌 最底层 GIF 索引: ${lowestGifIndex}`);
        
        // 保存所有图层的原始可见性
        const allLayersVisibility = new Map();
        frame.children.forEach(child => {
          allLayersVisibility.set(child.id, child.visible);
        });
        
        // ========== 1. 导出 Bottom Layer（最底层 GIF 下面的图层）==========
        console.log('   🔽 开始导出 Bottom Layer（最底层 GIF 下面的图层）...');
        console.log(`   📊 最底层 GIF 下面有 ${lowestGifIndex} 个图层`);
        console.log(`   💡 提示：frame.children[0] 是最底层，frame.children[${frame.children.length - 1}] 是最顶层`);
        
        // 打印所有图层的顺序（便于调试）
        console.log('   📋 Frame 的所有图层（从底到顶）:');
        frame.children.forEach((child, index) => {
          const isGif = gifIndices.includes(index);
          console.log(`      [${index}] ${child.name} (${child.type})${isGif ? ' ← GIF' : ''}`);
        });
        
        const highestGifIndex = Math.max(...gifIndices);
        console.log(`   📌 GIF 索引范围: [${lowestGifIndex}, ${highestGifIndex}]`);
        
        if (lowestGifIndex === 0) {
          console.log('   ⚠️  没有图层在最底层 GIF 下面');
        }
        
        // 只有当 GIF 下面有图层时才导出 Bottom Layer
        let bottomLayerBytes = null;
        if (lowestGifIndex > 0) {
          console.log('   ✅ 将导出以下图层作为 Bottom Layer:');
          frame.children.forEach((child, index) => {
            if (index < lowestGifIndex) {
              console.log(`      - 索引${index}: "${child.name}" (${child.type})`);
            }
          });
          
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
          
          console.log(`   ✅ Bottom Layer 已导出 (${(bottomLayerBytes.length / 1024).toFixed(2)} KB)`);
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            child.visible = allLayersVisibility.get(child.id);
          });
        } else {
          console.log(`   ⏭️  跳过 Bottom Layer 导出（最底层 GIF 是最底层图层）`);
        }
        
        // ========== 2. 导出每个非 GIF 图层（用于正确的 z-order 合成）==========
        console.log('   🔄 开始导出非 GIF 图层（用于正确的 z-order 合成）...');
        
        // 收集所有非 GIF 图层的信息（包括它们的 z-index）
        const staticLayers = [];
        frame.children.forEach((child, index) => {
          const isGif = gifIndices.includes(index);
          if (!isGif && index >= lowestGifIndex && index <= highestGifIndex) {
            staticLayers.push({
              index: index,
              name: child.name,
              type: child.type
            });
          }
        });
        
        // 导出每个静态图层
        const staticLayerExports = [];
        for (const layerInfo of staticLayers) {
          console.log(`   📤 导出静态图层 [${layerInfo.index}]: "${layerInfo.name}" (${layerInfo.type})`);
          
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
            bytes: Array.from(layerBytes)
          });
          
          console.log(`      ✅ 已导出 (${(layerBytes.length / 1024).toFixed(2)} KB)`);
          
          // 恢复所有图层的可见性
          frame.children.forEach(child => {
            child.visible = allLayersVisibility.get(child.id);
          });
        }
        
        if (staticLayerExports.length > 0) {
          console.log(`   ✅ 共导出 ${staticLayerExports.length} 个静态图层用于正确的 z-order 合成`);
        } else {
          console.log(`   ⏭️  没有需要导出的静态图层（GIF 之间没有其他图层）`);
        }
        
        // ========== 3. 导出 Top Layer（最顶层 GIF 上面的图层）==========
        console.log('   🔼 开始导出 Top Layer（最顶层 GIF 上面的图层）...');
        
        // 隐藏 <= 最高 GIF 索引的所有图层（包括 GIF 和 GIF 下面的）
        frame.children.forEach((child, index) => {
          if (index <= highestGifIndex) {
            child.visible = false;
          }
        });
        
        const annotationBytes = await frame.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: 1 }
        });
        
        console.log(`   ✅ Top Layer 已导出 (${(annotationBytes.length / 1024).toFixed(2)} KB)`);
        
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
          annotationBytes: Array.from(annotationBytes),                                  // 最顶层 GIF 上面的图层
          frameBounds: {
            width: frame.width,
            height: frame.height
          },
          frameBackground: frameBackground, // Frame的背景色
          gifInfos: gifInfos, // 所有 GIF 的信息（包含每个 GIF 的 index）
          batchIndex: i,
          batchTotal: validTasks.length
        };
        
        console.log(`   ✅ Payload ready (${gifInfos.length} GIFs), sending to UI`);
        if (payload.bottomLayerBytes) {
          console.log(`   🔍 Payload.bottomLayerBytes 长度: ${payload.bottomLayerBytes.length}`);
        } else {
          console.log(`   🔍 Payload.bottomLayerBytes: null（无底层图层）`);
        }
        if (payload.staticLayers && payload.staticLayers.length > 0) {
          console.log(`   🔍 Payload.staticLayers: ${payload.staticLayers.length} 个静态图层`);
          payload.staticLayers.forEach(layer => {
            console.log(`      - [${layer.index}] ${layer.name}: ${layer.bytes.length} bytes`);
          });
        } else {
          console.log(`   🔍 Payload.staticLayers: []（无静态图层）`);
        }
        
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
    console.log('🔧 收到服务器修复请求');
    
    // 尝试通过 AppleScript 启动服务器
    try {
      const { exec } = require('child_process');
      const installPath = msg.installPath || '/Applications/ScreenSync - SourceCode';
      
      console.log('   📂 安装路径:', installPath);
      console.log('   🚀 尝试启动服务器...');
      
      // 方法 1: 尝试使用 launchctl 启动 LaunchAgent
      exec('launchctl start com.screensync.server 2>&1', (error, stdout, stderr) => {
        if (error) {
          console.log('   ⚠️  LaunchAgent 启动失败，尝试直接启动...');
          
          // 方法 2: 直接启动 Node.js 进程
          const startCommand = `cd "${installPath}" && npm start > /dev/null 2>&1 &`;
          exec(startCommand, (error2, stdout2, stderr2) => {
            if (error2) {
              console.log('   ❌ 直接启动失败:', error2.message);
              figma.ui.postMessage({
                type: 'repair-server-response',
                success: false,
                message: '自动启动失败，请手动启动服务器'
              });
            } else {
              console.log('   ✅ 服务器启动成功');
              figma.ui.postMessage({
                type: 'repair-server-response',
                success: true,
                message: '服务器已自动启动，正在重新连接...'
              });
            }
          });
        } else {
          console.log('   ✅ LaunchAgent 启动成功');
          figma.ui.postMessage({
            type: 'repair-server-response',
            success: true,
            message: '服务器已自动启动，正在重新连接...'
          });
        }
      });
    } catch (error) {
      console.error('   ❌ 修复失败:', error);
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
      console.log('✅ 插件版本已保存:', msg.version);
    } catch (error) {
      console.error('❌ 保存插件版本失败:', error);
    }
    return;
  }
  
  // 处理尺寸设置更新
  if (msg.type === 'update-size-settings') {
    customSizeSettings.width = msg.width;
    customSizeSettings.height = msg.height;
    // 保存到 clientStorage
    try {
      await figma.clientStorage.setAsync('imageWidth', msg.width);
      await figma.clientStorage.setAsync('imageHeight', msg.height);
      console.log('✅ 尺寸设置已更新并保存:', customSizeSettings);
    } catch (error) {
      console.error('❌ 保存尺寸设置失败:', error);
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
      console.log('📖 读取尺寸设置:', customSizeSettings);
      figma.ui.postMessage({
        type: 'size-settings-loaded',
        width: customSizeSettings.width,
        height: customSizeSettings.height
      });
    } catch (error) {
      console.error('❌ 读取尺寸设置失败:', error);
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
    // 保存到 clientStorage
    try {
      await figma.clientStorage.setAsync('frameColumns', msg.columns);
      console.log('✅ 布局设置已更新并保存:', customSizeSettings);
      
      // 更新现有画板的布局设置
      if (isFrameValid()) {
        if (customSizeSettings.columns && customSizeSettings.columns > 0) {
          currentFrame.layoutWrap = 'WRAP';
          currentFrame.counterAxisSizingMode = 'AUTO';
          
          // 根据实际子元素宽度计算画板宽度，避免右边空隙
          let frameWidth = 0;
          if (currentFrame.children.length > 0) {
            // 使用第一个子元素的实际宽度
            const firstChild = currentFrame.children[0];
            const itemWidth = firstChild.width;
            const itemSpacing = currentFrame.itemSpacing || 10;
            frameWidth = (itemWidth * customSizeSettings.columns) + (itemSpacing * (customSizeSettings.columns - 1));
          } else {
            // 如果没有子元素，使用估算值
            const estimatedItemWidth = CONFIG.imageWidth || 440;
            frameWidth = (estimatedItemWidth * customSizeSettings.columns) + (10 * (customSizeSettings.columns - 1));
          }
          
          currentFrame.layoutSizingHorizontal = 'FIXED';
          currentFrame.resize(frameWidth, currentFrame.height || 800);
          console.log(`   🔄 画板已设置为每行 ${customSizeSettings.columns} 张，宽度 ${frameWidth}px`);
        } else {
          currentFrame.layoutWrap = 'NO_WRAP';
          currentFrame.layoutSizingHorizontal = 'HUG';
          console.log('   🔄 画板已设置为不换行（一直横着排）');
        }
        
        // 确保移除填充颜色
        currentFrame.fills = [];
      }
    } catch (error) {
      console.error('❌ 保存布局设置失败:', error);
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
      console.log('📖 读取布局设置:', customSizeSettings);
      figma.ui.postMessage({
        type: 'layout-settings-loaded',
        columns: customSizeSettings.columns
      });
    } catch (error) {
      console.error('❌ 读取布局设置失败:', error);
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
        console.log('✅ 服务器路径已保存:', msg.path);
      }
    } catch (error) {
      console.error('❌ 保存服务器路径失败:', error);
    }
    return;
  }

  // 处理读取服务器路径请求
  if (msg.type === 'get-server-path') {
    try {
      const path = await figma.clientStorage.getAsync('serverPath');
      console.log('📖 读取服务器路径:', path);
      figma.ui.postMessage({
        type: 'server-path-loaded',
        path: path || null
      });
    } catch (error) {
      console.error('❌ 读取服务器路径失败:', error);
      figma.ui.postMessage({
        type: 'server-path-loaded',
        path: null
      });
    }
    return;
  }
  
  // 处理打开更新URL请求
  if (msg.type === 'open-update-url') {
    // Figma 插件无法直接打开外部链接，但可以显示提示
    figma.notify(`请访问以下地址下载最新版本：\n${msg.url}`, { timeout: 10000 });
    console.log('🔗 更新地址:', msg.url);
    return;
  }
  
  // 处理窗口大小调整（用于最小化/恢复功能）
  if (msg.type === 'resize') {
    try {
      // 允许最小宽度为 80px（用于最小化状态），最大宽度为 880px
      const width = Math.max(80, Math.min(880, msg.width || 480));
      // 增加最大高度限制，以适应 update banner
      const height = Math.max(40, Math.min(1200, msg.height || 700));
      figma.ui.resize(width, height);
      console.log(`🪟 已调整UI尺寸: ${width}x${height}`);
    } catch (e) {
      console.warn('调整UI尺寸失败:', e);
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
      // 找到画板，选中并滚动到视图中心
      currentFrame = frame;
      figma.currentPage.selection = [frame];
      figma.viewport.scrollAndZoomIntoView([frame]);
      console.log('✅ 已定位到画板: ScreenSync Screenshots');
      
      figma.ui.postMessage({
        type: 'frame-located',
        success: true,
        message: '已定位到画板'
      });
    } else {
      // 没有找到画板，尝试创建
      console.log('📍 当前页面未找到画板，尝试创建...');
      const success = ensureFrame();
      
      if (success && currentFrame) {
        figma.currentPage.selection = [currentFrame];
        figma.viewport.scrollAndZoomIntoView([currentFrame]);
        console.log('✅ 已创建并定位到画板: ScreenSync Screenshots');
        
        figma.ui.postMessage({
          type: 'frame-located',
          success: true,
          message: '已创建并定位到画板'
        });
      } else {
        console.error('❌ 无法定位画板：创建失败');
        
        figma.ui.postMessage({
          type: 'frame-located',
          success: false,
          message: '无法定位画板：创建失败'
        });
      }
    }
  }
  
  if (msg.type === 'add-screenshot') {
    console.log('📸 开始处理媒体文件...');
    console.log('   文件名:', msg.filename || '未命名');
    console.log('   时间戳:', msg.timestamp || '未提供');
    
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
        
        console.log(`   💾 已缓存同步文件信息: ${filename} (Cache Size: ${recentSyncedFiles.size})`);
      }
      
      if (!bytes) {
        throw new Error('缺少 bytes 数据');
      }
      
      // 检测文件类型（根据文件名）
      const filenameLower = filename ? filename.toLowerCase() : '';
      const isVideo = filenameLower.endsWith('.mp4') || filenameLower.endsWith('.mov');
      const isGif = filenameLower.endsWith('.gif');
      const isScreenRecording = isVideo || isGif; // 录屏：视频文件或 GIF 文件
      
      let uint8Array;
      
      // 支持两种格式：base64 字符串（新）或数组（旧）
      if (typeof bytes === 'string') {
        // 新格式：base64 字符串
        console.log('   1️⃣ 解码 base64 字符串...');
        console.log('      base64 长度:', bytes.length);
        try {
          uint8Array = figma.base64Decode(bytes);
          console.log('      Uint8Array 长度:', uint8Array.length);
        } catch (error) {
          throw new Error('base64 解码失败: ' + error.message);
        }
      } else if (Array.isArray(bytes)) {
        // 旧格式：数组
        console.log('   1️⃣ 转换字节数组...');
        console.log('      数组长度:', bytes.length);
        if (bytes.length === 0) {
          throw new Error('bytes 数组为空');
        }
        uint8Array = new Uint8Array(bytes);
        console.log('      Uint8Array 长度:', uint8Array.length);
      } else {
        throw new Error('bytes 必须是字符串（base64）或数组，实际类型: ' + typeof bytes);
      }
      
      let mediaSize;
      let mediaHash;
      
      if (isVideo) {
        // Figma 插件 API 目前不支持视频文件
        // 跳过视频文件并给出提示
        console.log('   ⚠️  检测到视频文件，但 Figma 插件 API 不支持视频');
        console.log('   💡 提示：请通过 Figma 界面直接拖放视频文件，或使用 GIF 格式');
        throw new Error('Figma 插件 API 不支持视频文件。请通过 Figma 界面直接拖放视频文件，或使用 GIF 格式。');
      } else {
        // 图片文件
        console.log('   2️⃣ 创建Figma图片...');
        const image = figma.createImage(uint8Array);
        
        // 检查 image 是否为 undefined 或 null
        if (!image) {
          throw new Error('figma.createImage() 返回 undefined，可能是 GIF 格式不支持或文件损坏');
        }
        
        // 检查 image.hash 是否存在
        if (!image.hash) {
          throw new Error('图片哈希值未生成，可能是 GIF 格式不支持或文件损坏');
        }
        
        console.log('      图片哈希:', image.hash);
        mediaHash = image.hash;
        
        // 获取图片实际尺寸
        console.log('   2.5️⃣ 获取图片实际尺寸...');
        try {
          mediaSize = await image.getSizeAsync();
          
          // 检查 mediaSize 是否为 undefined 或 null
          if (!mediaSize) {
            throw new Error('image.getSizeAsync() 返回 undefined，可能是 GIF 格式不支持或文件损坏');
          }
          
          // 检查尺寸值是否有效
          if (typeof mediaSize.width !== 'number' || typeof mediaSize.height !== 'number' || 
              mediaSize.width <= 0 || mediaSize.height <= 0) {
            throw new Error(`图片尺寸无效: ${mediaSize.width}x${mediaSize.height}，可能是 GIF 格式不支持或文件损坏`);
          }
          
          console.log('      原始尺寸:', mediaSize.width, 'x', mediaSize.height);
        } catch (sizeError) {
          // getSizeAsync 失败，可能是 GIF 格式问题
          const errorMsg = sizeError && sizeError.message ? sizeError.message : String(sizeError);
          if (isGif) {
            throw new Error(`GIF 文件无法获取尺寸: ${errorMsg}。可能是 GIF 格式不支持或文件损坏，请尝试手动拖入或使用其他格式`);
          } else {
            throw new Error(`无法获取图片尺寸: ${errorMsg}`);
          }
        }
      }
      
      // 计算最终尺寸
      let finalWidth, finalHeight;
      
      // 如果用户设置了自定义尺寸，使用自定义尺寸
      if (customSizeSettings.width || customSizeSettings.height) {
        if (customSizeSettings.width && customSizeSettings.height) {
          // 两个都设置了，直接使用
          finalWidth = customSizeSettings.width;
          finalHeight = customSizeSettings.height;
          console.log('      使用自定义尺寸:', finalWidth, 'x', finalHeight);
        } else if (customSizeSettings.width) {
          // 只设置了宽度，高度按比例计算
          const aspectRatio = mediaSize.height / mediaSize.width;
          finalWidth = customSizeSettings.width;
          finalHeight = Math.round(finalWidth * aspectRatio);
          console.log('      使用自定义宽度，高度自动计算:', finalWidth, 'x', finalHeight);
        } else if (customSizeSettings.height) {
          // 只设置了高度，宽度按比例计算
          const aspectRatio = mediaSize.width / mediaSize.height;
          finalHeight = customSizeSettings.height;
          finalWidth = Math.round(finalHeight * aspectRatio);
          console.log('      使用自定义高度，宽度自动计算:', finalWidth, 'x', finalHeight);
        }
      } else {
        // 没有自定义设置，使用实际尺寸的1/3
        finalWidth = Math.round(mediaSize.width / 3);
        finalHeight = Math.round(mediaSize.height / 3);
        
        console.log('      使用实际尺寸的1/3:', finalWidth, 'x', finalHeight);
      }
      
      console.log('   3️⃣ 创建容器...');
      const rect = figma.createRectangle();
      
      rect.resize(finalWidth, finalHeight);
      
      if (isVideo) {
        // 视频填充 - 检查 API 是否支持
        try {
          rect.fills = [{
            type: 'VIDEO',
            videoHash: mediaHash,
            scaleMode: 'FIT'
          }];
        } catch (fillError) {
          // 如果 VIDEO 类型不支持，尝试使用图片方式（显示视频的第一帧）
          console.log('      ⚠️  VIDEO 填充类型不支持，尝试使用图片方式');
          // 注意：这不会真正显示视频，但至少不会报错
          // 用户需要通过 Figma 界面手动拖放视频文件
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
      console.log('      命名:', rectName);
      
      // 保存文件名到 pluginData，用于后续识别
      if (msg.filename) {
        rect.setPluginData('originalFilename', msg.filename);
        
        // 只有当文件名包含 ScreenRecording 或 .gif/.mov/.mp4 时才认为是 GIF 录屏
        const filenameLower = msg.filename.toLowerCase();
        const isGifOrVideo = filenameLower.endsWith('.gif') || 
                             filenameLower.endsWith('.mov') || 
                             filenameLower.endsWith('.mp4');
        const filenameIndicatesRecording = msg.filename.includes('ScreenRecording');
        
        // 🔍 调试信息：显示接收到的所有数据
        console.log('      📦 接收到的消息数据:');
        console.log('         filename:', msg.filename);
        console.log('         driveFileId:', msg.driveFileId || '无');
        console.log('         ossFileId:', msg.ossFileId || '无');
        console.log('         gifCacheId:', msg.gifCacheId || '无');
        console.log('         isGifOrVideo:', isGifOrVideo);
        console.log('         filenameIndicatesRecording:', filenameIndicatesRecording);
        
        // 额外的判断：如果是 GIF 或视频，保存更详细的信息
        if (isGifOrVideo || filenameIndicatesRecording) {
          console.log('      🎥 检测到 GIF/视频文件，保存元数据...');
          
          // 保存文件ID，用于回溯源文件（如果存在）
          if (msg.driveFileId) {
            rect.setPluginData('driveFileId', msg.driveFileId);
            console.log('      ✅ 已保存 driveFileId:', msg.driveFileId);
          } else {
            console.log('      ⚠️  msg.driveFileId 为空，未保存');
          }
          if (msg.ossFileId) {
            rect.setPluginData('ossFileId', msg.ossFileId);
            console.log('      ✅ 已保存 ossFileId:', msg.ossFileId);
          } else {
            console.log('      ⚠️  msg.ossFileId 为空，未保存');
          }
          
          // 保存 gifCacheId (MD5 Hash)，用于在本地缓存查找
          // 这个 ID 应该由 drive-watcher.js 在处理文件时生成并传递过来
          if (msg.gifCacheId) {
            rect.setPluginData('gifCacheId', msg.gifCacheId);
            console.log('      ✅ 已保存 gifCacheId:', msg.gifCacheId);
            console.log('      💡 导出时会自动从缓存读取原始 GIF（无需本地文件）');
          } else {
            console.log('      ⚠️  msg.gifCacheId 为空，未保存');
          }
        }
      }
      
      console.log('   4️⃣ 查找最佳位置...');
      
      // 确保画板存在
      const frameCreated = ensureFrame();
      console.log('      画板状态:', frameCreated ? '已创建/存在' : '创建失败');
      
      if (isFrameValid()) {
        // 确保 frame 有 auto-layout（如果还没有）
        if (currentFrame.layoutMode === 'NONE') {
          console.log('   🔄 为画板启用 Auto Layout...');
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
            // 如果设置 layoutSizing 失败，记录错误但继续执行
            console.warn('   ⚠️  设置 layoutSizing 属性失败（可能 frame 的 auto-layout 未完全初始化）:', layoutError.message);
            // 不抛出错误，让图片正常添加
          }
        }
        
        console.log(`   📍 已添加到画板（Auto Layout 自动排列）`);
        
      } else {
        console.log('   ⚠️  画板无效，添加到页面中心');
        // 没有画板，直接添加到页面
        rect.x = figma.viewport.center.x;
        rect.y = figma.viewport.center.y;
        figma.currentPage.appendChild(rect);
      }
      
      screenshotCount++;
      
      console.log('   5️⃣ 选中并居中显示...');
      figma.currentPage.selection = [rect];
      figma.viewport.scrollAndZoomIntoView([rect]);
      
      console.log('✅ 截图添加成功！(总数: ' + screenshotCount + ')');
      console.log('');
      
      figma.ui.postMessage({ 
        type: 'screenshot-added',
        success: true,
        count: screenshotCount,
        filename: filename || '未命名文件',
        driveFileId: driveFileId,
        ossFileId: ossFileId
      });
      
    } catch (error) {
      console.error('❌ 添加截图失败:');
      console.error('   错误类型:', (error && error.name) || typeof error);
      console.error('   错误消息:', (error && error.message) || String(error));
      console.error('   错误堆栈:', (error && error.stack) || '无堆栈信息');
      console.error('   接收到的数据:', {
        hasBytes: !!msg.bytes,
        bytesType: typeof msg.bytes,
        bytesIsArray: Array.isArray(msg.bytes),
        bytesLength: msg.bytes ? msg.bytes.length : 0,
        filename: msg.filename,
        timestamp: msg.timestamp
      });
      console.error('');
      
      // 检查是否是 undefined 错误或 GIF 格式问题
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
        // undefined 错误或 GIF 格式问题：需要手动拖入，保留源文件
        console.error('   ⚠️  检测到 undefined 错误或 GIF 格式问题，文件需要手动拖入');
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
    console.log('👋 关闭插件');
    // 通知UI停止实时同步（如果正在运行）
    figma.ui.postMessage({ 
      type: 'plugin-closing'
    });
    // 延迟关闭，确保停止命令有时间发送
    setTimeout(() => {
    figma.closePlugin('已同步 ' + screenshotCount + ' 张截图');
    }, 200);
  }
  
  if (msg.type === 'stop-realtime') {
    // 这个消息由UI发送，用于停止实时同步
    // 实际停止逻辑在服务器端，这里只是确认收到
    console.log('⏸️  收到停止实时同步请求');
  }
  
  // 处理上传完成后关联 GIF 数据
  if (msg.type === 'associate-uploaded-gif') {
    console.log('🔗 关联上传的 GIF 数据:', msg.layerId);
    
    try {
      // 查找图层
      const layer = figma.getNodeById(msg.layerId);
      if (!layer) {
        console.error('   ❌ 未找到图层:', msg.layerId);
        figma.ui.postMessage({
          type: 'associate-gif-error',
          layerId: msg.layerId,
          error: '未找到图层'
        });
        return;
      }
      
      // 保存数据到 pluginData
      if (msg.driveFileId) {
        layer.setPluginData('driveFileId', msg.driveFileId);
        console.log('   ✅ 已保存 driveFileId:', msg.driveFileId);
      }
      if (msg.ossFileId) {
        layer.setPluginData('ossFileId', msg.ossFileId);
        console.log('   ✅ 已保存 ossFileId:', msg.ossFileId);
      }
      if (msg.originalFilename) {
        layer.setPluginData('originalFilename', msg.originalFilename);
        console.log('   ✅ 已保存 originalFilename:', msg.originalFilename);
      }
      if (msg.imageHash) {
        layer.setPluginData('imageHash', msg.imageHash);
        console.log('   ✅ 已保存 imageHash:', msg.imageHash);
      }
      if (msg.gifCacheId) {
        layer.setPluginData('gifCacheId', msg.gifCacheId);
        console.log('   ✅ 已保存 gifCacheId:', msg.gifCacheId);
      }
      
      figma.ui.postMessage({
        type: 'associate-gif-success',
        layerId: msg.layerId
      });
      
    } catch (error) {
      console.error('   ❌ 关联失败:', error);
      figma.ui.postMessage({
        type: 'associate-gif-error',
        layerId: msg.layerId,
        error: error.message
      });
    }
  }
  
  // 处理文件未找到错误，清除 GIF 的 pluginData 并重新触发检测
  if (msg.type === 'clear-gif-data-and-retry') {
    console.log('🔄 收到清除 GIF 数据并重试的请求');
    
    try {
      const selection = figma.currentPage.selection;
      if (!selection || selection.length === 0) {
        console.warn('   ⚠️  没有选中的节点');
        return;
      }
      
      // 递归查找所有 GIF 图层并清除它们的 pluginData
      function clearGifPluginData(node) {
        // 检查是否是 GIF/视频图层
        const originalFilename = node.getPluginData('originalFilename');
        if (originalFilename) {
          const hasValidExtension = originalFilename.toLowerCase().endsWith('.gif') || 
                                   originalFilename.toLowerCase().endsWith('.mov') || 
                                   originalFilename.toLowerCase().endsWith('.mp4');
          
          if (hasValidExtension) {
            // 清除与文件关联相关的 pluginData，保留 originalFilename
            const hadDriveFileId = node.getPluginData('driveFileId');
            const hadOssFileId = node.getPluginData('ossFileId');
            
            if (hadDriveFileId || hadOssFileId) {
              node.setPluginData('driveFileId', '');
              node.setPluginData('ossFileId', '');
              node.setPluginData('imageHash', '');
              console.log(`   🗑️  已清除 GIF 图层的关联数据: ${node.name} (文件: ${originalFilename})`);
            }
          }
        }
        
        // 递归检查子节点
        if ('children' in node) {
          for (const child of node.children) {
            clearGifPluginData(child);
          }
        }
      }
      
      for (const node of selection) {
        clearGifPluginData(node);
      }
      
      console.log('   ✅ 已清除所有 GIF 图层的关联数据');
      console.log('   🔄 重新触发导出流程...');
      
      // 延迟一点，然后重新触发导出（这次会检测到未同步的 GIF）
      setTimeout(() => {
        figma.ui.postMessage({
          type: 'trigger-export-from-code'
        });
      }, 500);
      
    } catch (error) {
      console.error('   ❌ 清除 GIF 数据失败:', error);
    }
  }
  
  } catch (globalError) {
    // 🛡️ 全局错误捕获，防止插件崩溃
    console.error('❌ 消息处理器发生错误:', globalError.message);
    console.error('   消息类型:', (msg && msg.type) ? msg.type : '未知');
  }
};

// ✅ 监听文档变化，自动关联手动拖入的Video/GIF的缓存元数据
// 🛡️ 使用 try-catch 包裹整个监听器，防止切换文件时崩溃
figma.on('documentchange', (event) => {
  try {
    // 只处理节点创建事件
    const nodeChanges = event.documentChanges.filter(change => change.type === 'CREATE');
    
    if (nodeChanges.length === 0) return;
    
    // 收集需要处理的节点ID（延迟处理，避免干扰 Figma 的视频加载）
    const nodeIdsToProcess = [];
    
    for (const change of nodeChanges) {
      try {
        const node = change.node;
        
        // 🛡️ 检查节点是否有效
        if (!node || typeof node.type === 'undefined') continue;
        
        // 只处理矩形节点（Video/GIF通常是矩形）
        if (node.type !== 'RECTANGLE') continue;
        
        // 先只根据节点名称判断是否可能是 Video/GIF
        // ⚠️ 不要立即访问 fills，避免干扰 Figma 的视频处理
        const nodeName = node.name || '';
        const nameLower = nodeName.toLowerCase();
        const mightBeVideo = nameLower.endsWith('.mov') || 
                             nameLower.endsWith('.mp4') ||
                             nameLower.includes('video') ||
                             nameLower.includes('recording') ||
                             nameLower.includes('screenrecording');
        const mightBeGif = nameLower.endsWith('.gif') ||
                           nameLower.includes('gif');
        
        if (mightBeVideo || mightBeGif) {
          nodeIdsToProcess.push(node.id);
        }
      } catch (e) {
        // 🛡️ 切换文件时节点可能无效，忽略错误
        continue;
      }
    }
    
    if (nodeIdsToProcess.length === 0) return;
    
    // ⏰ 延迟 500ms 再处理，让 Figma 完成视频/GIF 的内部加载
    setTimeout(() => {
      for (const nodeId of nodeIdsToProcess) {
        try {
          const node = figma.getNodeById(nodeId);
          if (!node || node.type !== 'RECTANGLE') continue;
          
          // 现在安全地访问 fills
          if (!node.fills || node.fills.length === 0) continue;
          
          const fill = node.fills[0];
          
          // 只处理VIDEO和IMAGE填充（GIF也是IMAGE类型）
          if (fill.type !== 'VIDEO' && fill.type !== 'IMAGE') continue;
          
          const nodeName = node.name || '';
          const nameLower = nodeName.toLowerCase();
          const isLikelyVideo = fill.type === 'VIDEO' || 
                                nameLower.endsWith('.mov') || 
                                nameLower.endsWith('.mp4') ||
                                nameLower.includes('video') ||
                                nameLower.includes('recording');
          const isLikelyGif = fill.type === 'IMAGE' && (
                              nameLower.endsWith('.gif') ||
                              nameLower.includes('gif') ||
                              nameLower.includes('recording'));
          
          if (!isLikelyVideo && !isLikelyGif) continue;
          
          console.log(`\n🔍 [自动关联] 检测到新增的Video/GIF图层: ${nodeName}`);
          
          // 检查是否已有关联数据
          const hasExistingData = node.getPluginData('driveFileId') || 
                                  node.getPluginData('ossFileId') ||
                                  node.getPluginData('gifCacheId');
          
          if (hasExistingData) {
            console.log(`   ✅ 已有关联数据，跳过自动关联`);
            continue;
          }
          
          // 请求UI返回缓存的元数据
          console.log(`   📤 请求UI返回缓存数据...`);
          figma.ui.postMessage({
            type: 'request-skipped-file-cache-for-node',
            filename: nodeName,
            nodeId: node.id
          });
        } catch (e) {
          // 节点可能已被删除或无法访问，忽略错误
          console.log(`   ⚠️ 节点处理出错，可能已被删除: ${e.message}`);
        }
      }
    }, 500);
  } catch (e) {
    // 🛡️ 切换文件时可能触发各种错误，忽略它们
    console.log(`⚠️ documentchange 处理出错（可能正在切换文件）: ${e.message}`);
  }
});

console.log('✅ 插件初始化完成');
console.log('📡 文档变化监听器已启动，将自动关联Video/GIF元数据');
console.log('');
