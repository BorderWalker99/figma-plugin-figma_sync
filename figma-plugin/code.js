// code.js - 智能布局版本

const PLUGIN_VERSION = '1.0.2'; // 插件版本号

console.log('🚀 Figma插件启动');
console.log('📦 插件版本:', PLUGIN_VERSION);

figma.showUI(__html__, { 
  width: 360, 
  height: 350,
  themeColors: true 
});

let currentFrame = null;
let screenshotCount = 0;
let screenshotIndex = 0; // 截屏图片计数器
let screenRecordingIndex = 0; // 录屏计数器

// 从画板中已有的元素初始化计数器
function initializeCounters() {
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
}

// 插件启动时初始化计数器
initializeCounters();

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
function isFrameValid() {
  if (!currentFrame) return false;
  
  try {
    const test = currentFrame.name;
    // 检查画板是否在当前页面
    const page = figma.currentPage;
    return page.children.includes(currentFrame);
  } catch (error) {
    console.log('画板已失效');
    return false;
  }
}

// 查找名为 "iPhone Screenshots" 的画板
function findFrameByName(name) {
  const page = figma.currentPage;
  for (const node of page.children) {
    if (node.type === 'FRAME' && node.name === name) {
      return node;
    }
  }
  return null;
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
  console.log('📬 收到UI消息:', msg.type);
  
  // 处理服务器修复请求
  if (msg.type === 'repair-server') {
    console.log('🔧 收到服务器修复请求');
    // Figma 插件无法直接执行系统命令，但可以通过 UI 显示提示
    // 实际修复由后端的 WebSocket 消息处理
    figma.ui.postMessage({
      type: 'repair-server-response',
      success: true,
      message: '正在尝试修复服务器连接...'
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
      const { bytes, timestamp, filename } = msg;
      
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
        filename: filename || '未命名文件'
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
          error: errorText
        });
      } else {
        // 其他错误：正常显示错误信息
        figma.ui.postMessage({ 
          type: 'screenshot-added',
          success: false,
          error: errorMessage
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
};

console.log('✅ 插件初始化完成');
console.log('');