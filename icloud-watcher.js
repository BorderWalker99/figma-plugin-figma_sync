// icloud-watcher.js - iCloud 模式监听器（带文件分类功能）
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const sharp = require('sharp');

// 优化 sharp 配置，减少内存占用并提高稳定性（特别是在 LaunchAgent 环境下）
sharp.cache(false); // 禁用缓存
sharp.simd(false); // 禁用 SIMD
sharp.concurrency(1); // 限制并发

const { exec } = require('child_process');
const os = require('os');

// 引入用户配置
const userConfig = require('./userConfig');

// ============= 配置 =============
const CONFIG = {
  icloudPath: path.join(
    process.env.HOME,
    'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
  ),
  wsUrl: 'ws://localhost:8888',
  connectionId: 'sync-session-1',
  maxWidth: 1920,
  quality: 85,
  supportedFormats: ['.png', '.jpg', '.jpeg', '.heic', '.webp', '.gif', '.mp4', '.mov'],
  // 子文件夹配置
  subfolders: {
    image: '图片',
    video: '视频',
    gif: 'GIF',
    exportedGif: '导出的GIF'
  }
};

let ws = null;
let reconnectTimer = null;
let syncCount = 0;
let isRealTimeMode = false;
let watcher = null;

// 待删除文件队列：{filename: { filePath, subfolder }}
const pendingDeletes = new Map();

// 已处理文件缓存：防止重复同步
const processedFilesCache = new Map();
const CACHE_EXPIRY_MS = 30000; // 30秒后过期

// 定期清理过期的缓存
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [fingerprint, timestamp] of processedFilesCache.entries()) {
    if (now - timestamp > CACHE_EXPIRY_MS) {
      processedFilesCache.delete(fingerprint);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`🧹 [缓存清理] 已清理 ${cleanedCount} 个过期的文件记录`);
  }
}, CACHE_EXPIRY_MS);

// 生成文件指纹
function getFileFingerprint(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);
    return `${filename}_${stats.size}_${stats.mtimeMs}`;
  } catch (error) {
    return null;
  }
}

// 检查文件是否已处理
function isFileProcessed(filePath) {
  const fingerprint = getFileFingerprint(filePath);
  if (!fingerprint) return false;
  
  if (processedFilesCache.has(fingerprint)) {
    const timestamp = processedFilesCache.get(fingerprint);
    const ageMs = Date.now() - timestamp;
    console.log(`   🔍 [重复检测] 文件已在 ${(ageMs / 1000).toFixed(1)}秒 前处理过，跳过`);
    return true;
  }
  return false;
}

// 标记文件为已处理
function markFileAsProcessed(filePath) {
  const fingerprint = getFileFingerprint(filePath);
  if (fingerprint) {
    processedFilesCache.set(fingerprint, Date.now());
    console.log(`   ✅ [缓存] 已标记文件为已处理: ${path.basename(filePath)}`);
  }
}

// ============= 子文件夹管理 =============

/**
 * 确保所有子文件夹存在
 */
function ensureSubfolders() {
  const subfolders = Object.values(CONFIG.subfolders);
  for (const subfolder of subfolders) {
    const folderPath = path.join(CONFIG.icloudPath, subfolder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      console.log(`   📁 创建子文件夹: ${subfolder}`);
    }
  }
}

/**
 * 根据文件类型获取目标子文件夹
 */
function getTargetSubfolder(filename, isExportedGif = false) {
  if (isExportedGif) {
    return CONFIG.subfolders.exportedGif;
  }
  
  const ext = path.extname(filename).toLowerCase();
  
  if (ext === '.mp4' || ext === '.mov') {
    return CONFIG.subfolders.video;
  } else if (ext === '.gif') {
    return CONFIG.subfolders.gif;
  } else {
    return CONFIG.subfolders.image;
  }
}

/**
 * 将文件移动到对应的子文件夹
 */
function moveFileToSubfolder(filePath, isExportedGif = false) {
  const filename = path.basename(filePath);
  const subfolder = getTargetSubfolder(filename, isExportedGif);
  const targetDir = path.join(CONFIG.icloudPath, subfolder);
  const targetPath = path.join(targetDir, filename);
  
  // 确保目标文件夹存在
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  
  // 如果文件已经在目标文件夹中，直接返回
  if (filePath === targetPath) {
    return { moved: false, newPath: filePath, subfolder };
  }
  
  // 处理同名文件：直接覆盖（替换旧文件）
  if (fs.existsSync(targetPath)) {
    try {
      fs.unlinkSync(targetPath);
      console.log(`   🔄 [iCloud] 已删除旧文件: ${subfolder}/${filename}`);
    } catch (deleteError) {
      console.warn(`   ⚠️  [iCloud] 删除旧文件失败: ${deleteError.message}`);
    }
  }
  
  // 移动文件
  try {
    fs.renameSync(filePath, targetPath);
    console.log(`   📂 [iCloud] 文件已分类: ${filename} → ${subfolder}/`);
    return { moved: true, newPath: targetPath, subfolder };
  } catch (moveError) {
    console.warn(`   ⚠️  [iCloud] 移动文件失败: ${moveError.message}`);
    return { moved: false, newPath: filePath, subfolder };
  }
}

/**
 * 根据备份模式判断是否应该清理文件
 * 备份模式对应关系（与 Google Drive 模式保持一致）：
 * - 'none': 仅视频 → 只保留视频子文件夹，清理图片和GIF
 * - 'gif_only': 视频+GIF → 保留视频和GIF子文件夹，清理图片
 * - 'all': 视频+GIF+图片 → 三个子文件夹都保留，不清理
 */
function shouldCleanupFile(subfolder) {
  const backupMode = userConfig.getBackupMode ? userConfig.getBackupMode() : 'gif_only';
  
  // 视频始终保留
  if (subfolder === CONFIG.subfolders.video) {
    return false; // 不清理
  }
  
  // 导出的 GIF 始终保留
  if (subfolder === CONFIG.subfolders.exportedGif) {
    return false; // 不清理
  }
  
  // GIF 子文件夹
  if (subfolder === CONFIG.subfolders.gif) {
    // 只有在 'none' 模式下才清理 GIF
    return backupMode === 'none';
  }
  
  // 图片子文件夹
  if (subfolder === CONFIG.subfolders.image) {
    // 只有在 'all' 模式下才不清理图片
    return backupMode !== 'all';
  }
  
  // 默认清理
  return true;
}


// ============= WebSocket连接 =============
function connectWebSocket() {
  console.log('🔌 正在连接服务器...');
  
  ws = new WebSocket(`${CONFIG.wsUrl}?id=${CONFIG.connectionId}&type=mac`);
  
  ws.on('open', () => {
    console.log('✅ 已连接到服务器\n');
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      console.log(`📨 [iCloud Watcher] 收到消息: ${message.type}`, message.connectionId ? `(from ${message.connectionId})` : '(from server)');
      
      // 处理文件导入失败消息（需要手动拖入，保留源文件）
      if (message.type === 'screenshot-failed') {
        const filename = message.filename;
        const keepFile = message.keepFile === true;
        
        if (keepFile) {
          console.log(`   ⚠️  文件导入失败，保留源文件: ${filename}`);
          
          if (pendingDeletes.has(filename)) {
            pendingDeletes.delete(filename);
            console.log(`   ✅ 已取消删除计划: ${filename}`);
          }
          console.log('');
        }
        return;
      }
      
      // 处理Figma确认消息
      if (message.type === 'screenshot-received') {
        const filename = message.filename;
        console.log(`   ✅ 收到Figma确认: ${filename}`);
        
        if (pendingDeletes.has(filename)) {
          const { filePath, subfolder } = pendingDeletes.get(filename);
          pendingDeletes.delete(filename);
          
          // 根据备份模式判断是否清理
          if (shouldCleanupFile(subfolder)) {
            if (fs.existsSync(filePath)) {
              deleteFile(filePath);
            } else {
              console.log(`   ⚠️  文件已不存在: ${filename}`);
            }
          } else {
            console.log(`   📌 根据备份设置，保留文件: ${filename} (${subfolder})`);
          }
          console.log('');
        } else {
          console.log(`   ℹ️  文件不在待删除列表中: ${filename}`);
          console.log('');
        }
        return;
      }
      
      if (message.type === 'figma-connected') {
        console.log('✅ Figma插件已连接\n');
      } else if (message.type === 'start-realtime') {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎯 收到 start-realtime 指令');
        console.log(`   iCloud 路径: ${CONFIG.icloudPath}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        isRealTimeMode = true;
        startWatching();
      } else if (message.type === 'stop-realtime') {
        console.log('\n⏸️  停止实时同步模式\n');
        isRealTimeMode = false;
        stopWatching();
      } else if (message.type === 'manual-sync-count-files') {
        console.log('\n📊 统计文件数量...\n');
        countFilesForManualSync();
      } else if (message.type === 'manual-sync') {
        console.log('\n📦 执行手动同步...\n');
        performManualSync();
      } else if (message.type === 'switch-sync-mode') {
        console.log('\n🔄 收到模式切换消息');
        console.log('   目标模式:', message.mode);
        if (message.mode !== 'icloud') {
          console.log('⚠️  当前是 iCloud watcher，需要切换到其他模式');
          console.log('   正在退出，请等待 start.js 重启正确的 watcher...\n');
          stopWatching();
          if (ws) {
            ws.close();
          }
          setTimeout(() => {
            process.exit(0);
          }, 1000);
        }
        return;
      }
      
    } catch (error) {
      console.error('消息解析错误:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('⚠️  服务器连接断开');
    isRealTimeMode = false;
    stopWatching();
    pendingDeletes.clear();
    scheduleReconnect();
  });
  
  ws.on('error', (error) => {
    console.error('❌ 连接错误:', error.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  
  console.log('⏰ 3秒后重新连接...\n');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, 3000);
}

// ============= 实时监听模式 =============
function startWatching() {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🚀 [startWatching] 函数被调用`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  
  if (watcher) {
    console.log('⚠️  检测到旧的监听器，正在停止...');
    stopWatching();
  }
  
  if (!fs.existsSync(CONFIG.icloudPath)) {
    console.log(`📁 iCloud 文件夹不存在，正在创建: ${CONFIG.icloudPath}`);
    fs.mkdirSync(CONFIG.icloudPath, { recursive: true });
    console.log(`✅ 文件夹创建成功\n`);
  } else {
    console.log(`✅ iCloud 文件夹已存在: ${CONFIG.icloudPath}\n`);
  }
  
  // 确保子文件夹存在
  ensureSubfolders();
  
  const startTime = new Date();
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎯 [iCloud] 实时监听器初始化`);
  console.log(`   启动时间: ${startTime.toISOString()}`);
  console.log(`   监听路径: ${CONFIG.icloudPath}`);
  console.log(`   支持格式: ${CONFIG.supportedFormats.join(', ')}`);
  console.log(`   子文件夹: ${Object.values(CONFIG.subfolders).join(', ')}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  // 扫描当前已存在的文件（用于日志记录）
  try {
    const existingFiles = fs.readdirSync(CONFIG.icloudPath).filter(file => {
      const filePath = path.join(CONFIG.icloudPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) return false;
      const ext = path.extname(file).toLowerCase();
      return CONFIG.supportedFormats.includes(ext);
    });
    console.log(`📊 [iCloud] 根目录有 ${existingFiles.length} 个待分类文件`);
    console.log(`ℹ️  [iCloud] 实时模式将只处理新添加的文件\n`);

    if (existingFiles.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'toast',
          message: `实时模式已启动 (${existingFiles.length} 个现有文件，如需同步请使用"手动同步")`,
          duration: 5000,
          level: 'info'
        }));
      } catch (e) {
        console.warn('   ⚠️ 发送通知失败:', e.message);
      }
    }

  } catch (error) {
    console.warn('   ⚠️  扫描现有文件失败，继续启动监听');
  }
  
  console.log(`\n🔧 正在创建 chokidar watcher...`);
  watcher = chokidar.watch(CONFIG.icloudPath, {
    persistent: true,
    ignoreInitial: true,
    ignored: [
      '**/.temp-*/**',
      '**/.*',
      '**/.DS_Store',
      '**/Thumbs.db',
      `**/${CONFIG.subfolders.exportedGif}`,
      `**/${CONFIG.subfolders.exportedGif}/**`
    ],
    awaitWriteFinish: {
      stabilityThreshold: 3500,
      pollInterval: 100
    }
  });
  console.log(`✅ chokidar watcher 已创建\n`);
  
  const handleFileEvent = (filePath) => {
    const filename = path.basename(filePath);
    const relativePath = path.relative(CONFIG.icloudPath, filePath);
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 [iCloud Watcher] 检测到文件变更`);
    console.log(`   文件: ${relativePath}`);
    console.log(`   时间: ${new Date().toISOString()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // 忽略导出的GIF文件夹
    if (relativePath.startsWith(CONFIG.subfolders.exportedGif + path.sep) || relativePath === CONFIG.subfolders.exportedGif) {
      console.log(`🚫 [iCloud] 忽略导出的GIF文件夹内容\n`);
      return;
    }
    
    // 忽略临时文件
    const lowerFilename = filename.toLowerCase();
    if (lowerFilename.startsWith('magick-') || 
        lowerFilename.endsWith('.miff') || 
        lowerFilename.endsWith('.cache') ||
        lowerFilename.includes('.tmp')) {
        console.log(`🙈 [iCloud] 忽略临时文件: ${filename}\n`);
        return;
    }

    console.log(`   检查实时模式状态: ${isRealTimeMode ? '✅ 已开启' : '❌ 已关闭'}`);
    if (!isRealTimeMode) {
      console.log(`⏸️  实时模式已关闭，忽略文件\n`);
      return;
    }
    
    // 检查文件是否有效
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        console.log(`⏭️  [iCloud] 跳过空文件: ${filename}`);
        return;
      }
      if (filename.toLowerCase().endsWith('.gif') && stats.size < 500) {
        console.log(`⏭️  [iCloud] 跳过不完整的 GIF: ${filename}`);
        return;
      }
    } catch (statError) {
      console.warn(`⚠️  [iCloud] 无法读取文件状态，跳过: ${filename}`);
      return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    if (CONFIG.supportedFormats.includes(ext)) {
      const isGif = ext === '.gif';
      const isVideo = ext === '.mp4' || ext === '.mov';
      
      // 检查是否重复处理
      if (isFileProcessed(filePath)) {
        console.log(`\n⏭️  [实时模式] 跳过重复文件: ${filename}`);
        return;
      }
      
      // 移动文件到对应子文件夹
      const { moved, newPath, subfolder } = moveFileToSubfolder(filePath);
      const finalPath = moved ? newPath : filePath;
      
      // 处理视频文件
      if (isVideo) {
        console.log(`\n🎥 [实时模式] 检测到视频文件: ${filename}`);
        console.log(`   ⚠️  视频文件需要手动拖入 Figma`);
        console.log(`   📂 已分类到: ${subfolder}/`);
        
        // 缓存视频文件
        try {
          const fileBuffer = fs.readFileSync(finalPath);
          const cacheResult = userConfig.saveGifToCache(fileBuffer, filename, null);
          if (cacheResult && cacheResult.cacheId) {
            console.log(`   💾 [GIF Cache] 视频已自动缓存 (ID: ${cacheResult.cacheId})`);
          }
        } catch (cacheError) {
          console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: filename,
            reason: 'video'
          }));
        }
        return;
      }
      
      // 处理大GIF文件
      if (isGif) {
        try {
          const stats = fs.statSync(finalPath);
          const maxGifSize = 100 * 1024 * 1024; // 100MB
          
          if (stats.size > maxGifSize) {
            console.log(`\n🎬 [实时模式] 检测到大 GIF 文件: ${filename}`);
            console.log(`   ⚠️  GIF 文件过大，需要手动拖入`);
            console.log(`   📂 已分类到: ${subfolder}/`);
            
            try {
              const fileBuffer = fs.readFileSync(finalPath);
              const cacheResult = userConfig.saveGifToCache(fileBuffer, filename, null);
              if (cacheResult && cacheResult.cacheId) {
                console.log(`   💾 [GIF Cache] 大GIF已自动缓存 (ID: ${cacheResult.cacheId})`);
              }
            } catch (cacheError) {
              console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'file-skipped',
                filename: filename,
                reason: 'gif-too-large'
              }));
            }
            return;
          }
        } catch (checkError) {
          console.log(`   ⚠️  检查 GIF 大小失败，继续处理`);
        }
      }
      
      console.log(`\n📸 [实时模式] 检测到新截图: ${filename}`);
      console.log(`   📂 分类到: ${subfolder}/`);
      
      // 尝试强制下载
      try {
        exec(`brctl download "${finalPath}"`);
      } catch (e) {
        // 忽略
      }
      
      syncScreenshot(finalPath, true, subfolder).catch(err => {
        console.error(`❌ 处理文件失败: ${filename}`, err.message);
      });
    }
  };
  
  console.log(`📝 注册事件监听器...`);
  watcher.on('add', handleFileEvent);
  watcher.on('change', handleFileEvent);
  console.log(`✅ 事件监听器已注册\n`);
  
  watcher.on('ready', () => {
    const readyTime = new Date();
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ [iCloud] 实时监听已就绪`);
    console.log(`   时间: ${readyTime.toISOString()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`ℹ️  从现在开始，新添加的文件将自动同步到 Figma\n`);
    
    // 配置 iCloud 文件夹为"始终保留下载"
    try {
      console.log('☁️  正在配置 iCloud 文件夹为"始终保留下载"...');
      exec(`brctl download -R "${CONFIG.icloudPath}"`, (error) => {
        if (error) {
          console.log('   ⚠️  配置失败 (不影响基本功能):', error.message);
        } else {
          console.log('   ✅ 已配置 iCloud 文件夹为"始终保留下载"');
        }
      });
    } catch (e) {
      // 忽略
    }
  });
  
  watcher.on('error', (error) => {
    console.error('❌ 监听错误:', error);
  });
}

function stopWatching() {
  if (watcher) {
    console.log('🛑 正在停止文件监听器...');
    
    try {
      watcher.close();
      watcher = null;
      console.log('✅ 文件监听器已停止\n');
    } catch (error) {
      console.error('❌ 停止监听器失败:', error);
      watcher = null;
    }
  }
}

// ============= 手动同步模式 =============
function countFilesForManualSync() {
  console.log('📊 [iCloud] 统计文件数量...');
  
  if (!fs.existsSync(CONFIG.icloudPath)) {
    console.log('❌ 同步文件夹不存在\n');
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-file-count',
        count: 0
      }));
    }
    return;
  }
  
  try {
    let totalCount = 0;
    
    // 统计根目录文件
    const rootFiles = fs.readdirSync(CONFIG.icloudPath).filter(file => {
      const filePath = path.join(CONFIG.icloudPath, file);
      const stats = fs.statSync(filePath);
      if (stats.isDirectory()) return false;
      const ext = path.extname(file).toLowerCase();
      return CONFIG.supportedFormats.includes(ext);
    });
    totalCount += rootFiles.length;
    
    // 统计子文件夹中的文件（排除导出的GIF）
    const subfolders = [CONFIG.subfolders.image, CONFIG.subfolders.video, CONFIG.subfolders.gif];
    for (const subfolder of subfolders) {
      const subfolderPath = path.join(CONFIG.icloudPath, subfolder);
      if (fs.existsSync(subfolderPath)) {
        const subFiles = fs.readdirSync(subfolderPath).filter(file => {
          const filePath = path.join(subfolderPath, file);
          const stats = fs.statSync(filePath);
          if (stats.isDirectory()) return false;
          const ext = path.extname(file).toLowerCase();
          return CONFIG.supportedFormats.includes(ext);
        });
        totalCount += subFiles.length;
      }
    }
    
    console.log(`   🖼️  共 ${totalCount} 个媒体文件\n`);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-file-count',
        count: totalCount
      }));
    }
  } catch (error) {
    console.error('❌ [iCloud] 统计文件失败:', error.message);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-file-count',
        count: 0
      }));
    }
  }
}

async function performManualSync() {
  if (!fs.existsSync(CONFIG.icloudPath)) {
    console.log('❌ 同步文件夹不存在\n');
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-complete',
        count: 0,
        total: 0,
        gifCount: 0,
        videoCount: 0,
        message: '同步文件夹不存在'
      }));
    }
    return;
  }
  
  // 确保子文件夹存在
  ensureSubfolders();
  
  // 收集所有待同步文件（根目录 + 子文件夹）
  const allFiles = [];
  
  // 收集根目录文件并分类
  const rootFiles = fs.readdirSync(CONFIG.icloudPath).filter(file => {
    const filePath = path.join(CONFIG.icloudPath, file);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) return false;
    const ext = path.extname(file).toLowerCase();
    return CONFIG.supportedFormats.includes(ext);
  });
  
  // 先将根目录文件分类到子文件夹
  console.log(`📂 [手动同步] 正在分类根目录中的 ${rootFiles.length} 个文件...`);
  for (const file of rootFiles) {
    const filePath = path.join(CONFIG.icloudPath, file);
    const { newPath, subfolder } = moveFileToSubfolder(filePath);
    allFiles.push({ filePath: newPath, subfolder });
  }
  
  // 收集子文件夹中的文件
  const subfolders = [CONFIG.subfolders.image, CONFIG.subfolders.video, CONFIG.subfolders.gif];
  for (const subfolder of subfolders) {
    const subfolderPath = path.join(CONFIG.icloudPath, subfolder);
    if (fs.existsSync(subfolderPath)) {
      const subFiles = fs.readdirSync(subfolderPath).filter(file => {
        const filePath = path.join(subfolderPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) return false;
        const ext = path.extname(file).toLowerCase();
        return CONFIG.supportedFormats.includes(ext);
      });
      
      for (const file of subFiles) {
        const filePath = path.join(subfolderPath, file);
        // 检查是否已经在 allFiles 中（避免重复）
        if (!allFiles.some(f => f.filePath === filePath)) {
          allFiles.push({ filePath, subfolder });
        }
      }
    }
  }
  
  if (allFiles.length === 0) {
    console.log('📭 文件夹为空，没有截图需要同步\n');
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0
      }));
    }
    return;
  }
  
  console.log(`📦 [手动模式] 找到 ${allFiles.length} 个文件，开始同步...\n`);
  
  let successCount = 0;
  let gifCount = 0;
  let videoCount = 0;
  const processingErrors = [];
  
  for (const { filePath, subfolder } of allFiles) {
    const file = path.basename(filePath);
    
    try {
      const ext = path.extname(filePath).toLowerCase();
      const isGif = ext === '.gif';
      const isVideo = ext === '.mp4' || ext === '.mov';
      
      // 处理视频文件
      if (isVideo) {
        console.log(`   🎥 检测到视频文件: ${file}`);
        console.log(`   ⚠️  视频文件需要手动拖入`);
        
        // 缓存视频
        try {
          const fileBuffer = fs.readFileSync(filePath);
          const cacheResult = userConfig.saveGifToCache(fileBuffer, file, null);
          if (cacheResult && cacheResult.cacheId) {
            console.log(`   💾 [GIF Cache] 视频已自动缓存 (ID: ${cacheResult.cacheId})`);
          }
        } catch (cacheError) {
          console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: file,
            reason: 'video'
          }));
        }
        videoCount++;
        continue;
      }
      
      // 处理大GIF
      if (isGif) {
        try {
          const stats = fs.statSync(filePath);
          const maxGifSize = 100 * 1024 * 1024;
          
          if (stats.size > maxGifSize) {
            console.log(`   ⚠️  GIF 文件过大，需要手动拖入: ${file}`);
            
            try {
              const fileBuffer = fs.readFileSync(filePath);
              const cacheResult = userConfig.saveGifToCache(fileBuffer, file, null);
              if (cacheResult && cacheResult.cacheId) {
                console.log(`   💾 [GIF Cache] 大GIF已自动缓存 (ID: ${cacheResult.cacheId})`);
              }
            } catch (cacheError) {
              console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
            }
            
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'file-skipped',
                filename: file,
                reason: 'gif-too-large'
              }));
            }
            gifCount++;
            continue;
          }
        } catch (checkError) {
          console.error(`   ❌ GIF 文件检查失败: ${checkError.message}`);
          processingErrors.push({ filename: file, error: checkError.message });
          continue;
        }
      }
      
      await syncScreenshot(filePath, true, subfolder);
      successCount++;
      
      if (isGif) {
        gifCount++;
      }
      
      await sleep(300);
    } catch (error) {
      console.error(`❌ 同步失败: ${file}`, error.message);
      processingErrors.push({ filename: file, error: error.message });
    }
  }
  
  console.log(`\n✅ [手动模式] 同步完成！成功: ${successCount}/${allFiles.length}\n`);
  if (processingErrors.length > 0) {
    console.log(`   ❌ 失败: ${processingErrors.length} 个`);
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'manual-sync-complete',
      count: successCount,
      gifCount: gifCount,
      videoCount: videoCount,
      errors: processingErrors
    }));
  }
}

// ============= 同步截图 =============
async function syncScreenshot(filePath, deleteAfterSync = false, subfolder = null) {
  const startTime = Date.now();
  const filename = path.basename(filePath);
  
  if (isFileProcessed(filePath)) {
    console.log(`   ⏭️  跳过重复文件: ${filename}`);
    return;
  }
  
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('⏸️  等待服务器连接...');
      throw new Error('服务器未连接');
    }
    
    console.log('   ⬆️  正在上传...');
    
    if (!fs.existsSync(filePath)) {
      console.log('   ⚠️  文件不存在，可能已被删除');
      return;
    }
    
    const stats = fs.statSync(filePath);
    const originalSize = (stats.size / 1024).toFixed(2);
    
    const ext = path.extname(filePath).toLowerCase();
    const isHeif = ext === '.heif' || ext === '.heic';
    const isGif = ext === '.gif';
    const isVideo = ext === '.mp4' || ext === '.mov';
    
    let imageBuffer;
    
    if (isVideo) {
      // 视频文件不应该到达这里，但作为安全检查
      console.log(`   ⚠️  视频文件不支持自动导入 Figma`);
      return;
    } else if (isGif) {
      console.log(`   🎬 检测到 GIF 格式...`);
      imageBuffer = fs.readFileSync(filePath);
      
      // 缓存 GIF
      try {
        const cacheResult = userConfig.saveGifToCache(imageBuffer, filename, null);
        if (cacheResult && cacheResult.cacheId) {
          console.log(`   💾 [GIF Cache] 已自动缓存 (ID: ${cacheResult.cacheId})`);
        }
      } catch (cacheError) {
        console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
      }
      
      const fileSizeKB = (imageBuffer.length / 1024).toFixed(2);
      console.log(`   ✅ 使用原始 GIF 文件: ${fileSizeKB}KB`);
    } else if (isHeif && os.platform() === 'darwin') {
      console.log(`   🔄 检测到 HEIF 格式，使用 sips 转换为 JPEG...`);
      
      let tempOutputPath = path.join(os.tmpdir(), `jpeg-output-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
      
      try {
        const sipsCommand = `sips -s format jpeg "${filePath}" --out "${tempOutputPath}"`;
        
        await new Promise((resolve, reject) => {
          exec(sipsCommand, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
              reject(new Error(`sips 转换失败: ${err.message}${stderr ? ' - ' + stderr : ''}`));
            } else {
              if (!fs.existsSync(tempOutputPath)) {
                reject(new Error(`sips 转换失败: 输出文件不存在`));
              } else {
                resolve();
              }
            }
          });
        });
        
        let convertedBuffer = fs.readFileSync(tempOutputPath);
        
        imageBuffer = await sharp(convertedBuffer)
          .resize(CONFIG.maxWidth, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: CONFIG.quality })
          .toBuffer();
        
        try {
          fs.unlinkSync(tempOutputPath);
        } catch (cleanupError) {
          // 忽略
        }
        
        const compressedSize = (imageBuffer.length / 1024).toFixed(2);
        console.log(`   📦 ${originalSize}KB → ${compressedSize}KB (HEIF → JPEG)`);
      } catch (sipsError) {
        console.log(`   ❌ sips 转换失败: ${sipsError.message}`);
        throw new Error(`HEIF 转换失败: ${sipsError.message}`);
      }
    } else if (isHeif) {
      console.log(`   ❌ 检测到 HEIF 格式，但当前系统不支持 sips 转换`);
      throw new Error('HEIF 格式需要 macOS 系统支持');
    } else {
      try {
        imageBuffer = await sharp(filePath)
          .resize(CONFIG.maxWidth, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: CONFIG.quality })
          .toBuffer();
        
        const compressedSize = (imageBuffer.length / 1024).toFixed(2);
        console.log(`   📦 ${originalSize}KB → ${compressedSize}KB`);
        
      } catch (error) {
        console.log('   ⚠️  压缩失败，使用原文件');
        imageBuffer = fs.readFileSync(filePath);
      }
    }
    
    const base64String = imageBuffer.toString('base64');
    imageBuffer = null;
    
    // 如果没有提供 subfolder，自动检测
    if (!subfolder) {
      subfolder = getTargetSubfolder(filename);
    }
    
    const payload = {
      type: 'screenshot',
      bytes: base64String,
      timestamp: Date.now(),
      filename: filename,
      keptInIcloud: !shouldCleanupFile(subfolder) // 根据备份设置判断
    };
    
    ws.send(JSON.stringify(payload));
    
    syncCount++;
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`   ✅ 同步完成 (${duration}秒)`);
    console.log(`   📊 已同步: ${syncCount} 张`);
    
    markFileAsProcessed(filePath);
    
    if (deleteAfterSync) {
      // 添加到待删除队列，等待 Figma 确认
      pendingDeletes.set(filename, { filePath, subfolder });
      console.log('   ⏳ 等待Figma确认...');
      
      // 设置超时兜底
      setTimeout(() => {
        if (pendingDeletes.has(filename)) {
          console.log(`   ⚠️  等待确认超时（10秒），检查是否清理: ${filename}`);
          const { filePath: fp, subfolder: sf } = pendingDeletes.get(filename);
          pendingDeletes.delete(filename);
          
          if (fs.existsSync(fp) && shouldCleanupFile(sf)) {
            deleteFile(fp);
          } else if (!shouldCleanupFile(sf)) {
            console.log(`   📌 根据备份设置，保留文件: ${filename}`);
          }
          console.log('');
        }
      }, 10000);
    } else {
      console.log('');
    }
    
  } catch (error) {
    console.error(`   ❌ 同步失败: ${error.message}\n`);
    throw error;
  }
}

function deleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    console.log(`   🗑️  已删除源文件: ${path.basename(filePath)}`);
    return true;
  } catch (deleteError) {
    console.error(`   ⚠️  删除失败: ${deleteError.message}`);
    return false;
  }
}

// ============= 工具函数 =============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============= 全局错误处理 =============
process.on('uncaughtException', (err) => {
  console.error('🔥 [严重] 未捕获的异常:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [警告] 未处理的 Promise 拒绝:', reason);
});

// ============= 启动 =============
function start() {
  console.clear();
  console.log('╔════════════════════════════════════════╗');
  console.log('║  iPhone截图同步 - Mac端监听器 (iCloud) ║');
  console.log('║  支持文件自动分类和选择性清理          ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  connectWebSocket();
  
  console.log('📍 同步文件夹:', CONFIG.icloudPath);
  console.log('📂 子文件夹:', Object.values(CONFIG.subfolders).join(', '));
  console.log('⏳ 等待Figma插件选择同步模式...\n');
  
  process.on('SIGINT', () => {
    console.log('\n\n👋 停止服务...');
    console.log(`📊 总共同步了 ${syncCount} 张截图`);
    console.log(`📋 待删除队列: ${pendingDeletes.size} 个文件\n`);
    stopWatching();
    if (ws) ws.close();
    process.exit(0);
  });
}

start();
