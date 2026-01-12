// icloud-watcher.js - 完全修复版（单一消息监听器）
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
  keepGifInIcloud: true // 默认始终保留 GIF 在 iCloud 文件夹
};

let ws = null;
let reconnectTimer = null;
let syncCount = 0;
let isRealTimeMode = false;
let watcher = null;

// 待删除文件队列：{filename: filePath}
const pendingDeletes = new Map();

// 已处理文件缓存：防止重复同步
// 格式：{ fingerprint: timestamp }
// fingerprint = filename + fileSize + mtime
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
}, CACHE_EXPIRY_MS); // 每30秒清理一次

// 生成文件指纹
function getFileFingerprint(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);
    // 文件指纹 = 文件名 + 大小 + 修改时间（毫秒）
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
      
      // 打印所有接收到的消息（用于调试）
      console.log(`📨 [iCloud Watcher] 收到消息: ${message.type}`, message.connectionId ? `(from ${message.connectionId})` : '(from server)');
      
      // 处理文件导入失败消息（需要手动拖入，保留源文件）
      if (message.type === 'screenshot-failed') {
        const filename = message.filename;
        const keepFile = message.keepFile === true;
        
        if (keepFile) {
          console.log(`   ⚠️  文件导入失败，保留源文件: ${filename}`);
          
          // 从 pendingDeletes 中移除，不删除文件
          let removed = false;
          if (pendingDeletes.has(filename)) {
            pendingDeletes.delete(filename);
            console.log(`   ✅ 已取消删除计划: ${filename}`);
            removed = true;
          }
          
          if (!removed) {
            console.log(`   ℹ️  文件不在待删除列表中: ${filename}（可能已经处理或未计划删除）`);
          }
          console.log('');
        }
        return;
      }
      
      // 处理Figma确认消息
      if (message.type === 'screenshot-received') {
        const filename = message.filename;
        console.log(`   ✅ 收到Figma确认: ${filename}`);
        
        // 检查文件是否已经被标记为保留（通过 screenshot-failed 消息）
        // 如果文件不在 pendingDeletes 中，说明已经被标记为保留，不应该删除
        if (pendingDeletes.has(filename)) {
          const filePath = pendingDeletes.get(filename);
          pendingDeletes.delete(filename);
          
          if (fs.existsSync(filePath)) {
            deleteFile(filePath);
          } else {
            console.log(`   ⚠️  文件已不存在: ${filename}`);
          }
          console.log('');
        } else {
          // 文件不在 pendingDeletes 中，说明已经被标记为保留（通过 screenshot-failed）
          console.log(`   ℹ️  文件已标记为保留，不删除: ${filename}（可能导入失败需要手动拖入）`);
          console.log('');
        }
        return;
      }
      
      if (message.type === 'figma-connected') {
        console.log('✅ Figma插件已连接\n');
      } else if (message.type === 'start-realtime') {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('🎯 收到 start-realtime 指令');
        console.log('   当前状态:');
        console.log(`   • isRealTimeMode: ${isRealTimeMode}`);
        console.log(`   • watcher 存在: ${watcher ? '是' : '否'}`);
        console.log(`   • iCloud 路径: ${CONFIG.icloudPath}`);
        console.log(`   • 路径存在: ${fs.existsSync(CONFIG.icloudPath) ? '是' : '否'}`);
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
          // 停止监听
          stopWatching();
          // 关闭 WebSocket
          if (ws) {
            ws.close();
          }
          // 退出进程，让 start.js 重启正确的 watcher
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
  
  const startTime = new Date();
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎯 [iCloud] 实时监听器初始化`);
  console.log(`   启动时间: ${startTime.toISOString()}`);
  console.log(`   监听路径: ${CONFIG.icloudPath}`);
  console.log(`   支持格式: ${CONFIG.supportedFormats.join(', ')}`);
  console.log(`   忽略文件夹: GIF-导出/ (导出的 GIF 存放位置)`);
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
    console.log(`📊 [iCloud] 当前文件夹中有 ${existingFiles.length} 个文件将被标记为"已存在"（ignoreInitial）`);
    if (existingFiles.length > 0 && existingFiles.length <= 10) {
      existingFiles.forEach(file => console.log(`   - ${file}`));
    } else if (existingFiles.length > 10) {
      console.log(`   前3个: ${existingFiles.slice(0, 3).join(', ')} ...`);
    }
    console.log(`ℹ️  [iCloud] 实时模式将只处理监听启动后新添加的文件\n`);

    // 通知用户已存在的现有文件数量，提示使用手动同步
    if (existingFiles.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: 'toast',
          message: `实时模式已启动 (忽略 ${existingFiles.length} 个现有文件，如需同步请使用"手动同步")`,
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
      '**/.temp-*/**',      // 忽略临时文件夹
      '**/.*',              // 忽略隐藏文件（以点开头）
      '**/.DS_Store',       // 忽略 macOS 系统文件
      '**/Thumbs.db',       // 忽略 Windows 系统文件
      '**/GIF-导出',       // 忽略 GIF-导出 文件夹本身
      '**/GIF-导出/**'     // 忽略 GIF-导出 文件夹内的所有内容
    ],
    awaitWriteFinish: {
      stabilityThreshold: 3500,  // 增加到 3.5 秒，确保大文件写入完成
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

    // 双重保险：即使 chokidar ignored 配置失效，也在这里再次检查
    if (relativePath.startsWith('GIF-导出' + path.sep) || relativePath === 'GIF-导出') {
      console.log(`🚫 [iCloud] 忽略 GIF-导出 文件夹内容: ${relativePath}\n`);
      return;
    }
    
    // 忽略 ImageMagick 的临时文件
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
      console.log(`⏸️  实时模式已关闭，忽略文件: ${path.basename(filePath)}\n`);
      return;
    }
    
    // 额外检查：确保文件已完全写入（文件大小 > 0 且稳定）
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        console.log(`⏭️  [iCloud] 跳过空文件（可能还在写入）: ${filename}`);
        return;
      }
      // 对于 GIF，如果文件太小（< 500 字节），可能是不完整的
      if (filename.toLowerCase().endsWith('.gif') && stats.size < 500) {
        console.log(`⏭️  [iCloud] 跳过不完整的 GIF（${stats.size} bytes）: ${filename}`);
        return;
      }
    } catch (statError) {
      console.warn(`⚠️  [iCloud] 无法读取文件状态，跳过: ${filename}`);
      return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    if (CONFIG.supportedFormats.includes(ext)) {
      const filename = path.basename(filePath);
      const isGif = ext === '.gif';
      const isVideo = ext === '.mp4' || ext === '.mov';
      
      // 🔍 检查是否重复处理
      if (isFileProcessed(filePath)) {
        console.log(`\n⏭️  [实时模式] 跳过重复文件: ${filename}`);
        return;
      }
      
      // 处理重名文件：如果是视频或 GIF，检查是否有同名文件，如果有则删除旧文件
      if (isVideo || isGif) {
        const nameWithoutExt = path.basename(filename, ext);
        const folderPath = path.dirname(filePath);
        
        // 检查文件名是否包含 -2, -3 等后缀（macOS 自动添加的）
        const duplicateMatch = nameWithoutExt.match(/^(.+)-(\d+)$/);
        if (duplicateMatch) {
          const originalName = duplicateMatch[1];
          const originalFilePath = path.join(folderPath, `${originalName}${ext}`);
          
          // 如果原始文件存在，删除它（因为新文件会替换它）
          if (fs.existsSync(originalFilePath)) {
            try {
              fs.unlinkSync(originalFilePath);
              console.log(`   🔄 [iCloud] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，已删除旧文件: ${originalName}${ext}`);
              
              // 重命名新文件为原始文件名（去掉 -2 后缀）
              const newFilePath = path.join(folderPath, `${originalName}${ext}`);
              fs.renameSync(filePath, newFilePath);
              console.log(`   ✅ [iCloud] 已重命名新文件: ${filename} → ${originalName}${ext}`);
              
              // 更新 filePath 为新的路径
              filePath = newFilePath;
            } catch (renameError) {
              console.warn(`   ⚠️  [iCloud] 处理重名文件失败: ${renameError.message}`);
            }
          }
        } else {
          // 文件名不包含后缀，检查是否有带后缀的同名文件（旧文件）
          // 例如：如果新文件是 file.gif，检查是否有 file-2.gif, file-3.gif 等
          let foundDuplicate = false;
          for (let i = 2; i <= 10; i++) {
            const duplicatePath = path.join(folderPath, `${nameWithoutExt}-${i}${ext}`);
            if (fs.existsSync(duplicatePath)) {
              try {
                fs.unlinkSync(duplicatePath);
                console.log(`   🔄 [iCloud] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，已删除旧文件: ${path.basename(duplicatePath)}`);
                foundDuplicate = true;
              } catch (deleteError) {
                console.warn(`   ⚠️  [iCloud] 删除旧文件失败: ${deleteError.message}`);
              }
            }
          }
        }
      }
      
      // 检查文件是否需要手动拖入（GIF过大或视频文件）
      if (isVideo) {
        // 视频文件需要手动拖入，不调用 syncScreenshot
        console.log(`\n🎥 [实时模式] 检测到视频文件: ${filename}`);
        console.log(`   ⚠️  视频文件需要手动拖入 Figma`);
        
        // 自动缓存视频文件（用于导出带标注的 GIF 功能）
        try {
          const fileBuffer = fs.readFileSync(filePath);
          const userConfig = require('./userConfig');
          const cacheResult = userConfig.saveGifToCache(fileBuffer, filename, null);
          if (cacheResult && cacheResult.cacheId) {
            console.log(`   💾 [GIF Cache] 视频已自动缓存 (ID: ${cacheResult.cacheId})`);
            console.log(`   💡 导出时可以直接从缓存读取`);
          }
        } catch (cacheError) {
          console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
        }
        
        // 发送 file-skipped 消息
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: filename,
            reason: 'video'
          }));
        }
        return; // 不调用 syncScreenshot，不删除文件
      } else if (isGif) {
        // 检查 GIF 大小
        try {
          const stats = fs.statSync(filePath);
          const fileSize = stats.size;
          const maxGifSize = 100 * 1024 * 1024; // 100MB
          
          if (fileSize > maxGifSize) {
            // GIF 过大，需要手动拖入，不调用 syncScreenshot
            console.log(`\n🎬 [实时模式] 检测到 GIF 文件: ${filename}`);
            console.log(`   ⚠️  GIF 文件过大 (${(fileSize / 1024 / 1024).toFixed(2)}MB)，需要手动拖入`);
            
            // 自动缓存大 GIF 文件（用于导出带标注的 GIF 功能）
            try {
              const fileBuffer = fs.readFileSync(filePath);
              const userConfig = require('./userConfig');
              const cacheResult = userConfig.saveGifToCache(fileBuffer, filename, null);
              if (cacheResult && cacheResult.cacheId) {
                console.log(`   💾 [GIF Cache] 大GIF已自动缓存 (ID: ${cacheResult.cacheId})`);
                console.log(`   💡 导出时可以直接从缓存读取`);
              }
            } catch (cacheError) {
              console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
            }
            
            // 发送 file-skipped 消息
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'file-skipped',
                filename: filename,
                reason: 'gif-too-large'
              }));
            }
            return; // 不调用 syncScreenshot，不删除文件
          }
        } catch (checkError) {
          // 如果检查失败，继续正常处理流程
          console.log(`   ⚠️  检查 GIF 大小失败，继续处理: ${checkError.message}`);
        }
      }
      
      // 文件可以正常处理，调用 syncScreenshot
      console.log(`\n📸 [实时模式] 检测到新截图: ${filename}`);
      
      // 立即对新文件触发下载
      try {
        exec(`brctl download "${filePath}"`);
      } catch (e) {
        // 忽略
      }
      
      syncScreenshot(filePath, true).catch(err => {
        console.error(`❌ 处理文件失败: ${filename}`, err.message);
      });
    }
  };
  
  console.log(`📝 注册 'add' 事件监听器...`);
  watcher.on('add', handleFileEvent);
  console.log(`📝 注册 'change' 事件监听器...`);
  watcher.on('change', handleFileEvent);
  console.log(`✅ 事件监听器已注册\n`);
  
  console.log(`⏳ 等待 watcher 'ready' 事件...\n`);
  watcher.on('ready', () => {
    const readyTime = new Date();
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ [iCloud] 实时监听已就绪`);
    console.log(`   时间: ${readyTime.toISOString()}`);
    console.log(`   状态: isRealTimeMode = ${isRealTimeMode}`);
    console.log(`   路径: ${CONFIG.icloudPath}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`ℹ️  从现在开始，新添加的文件将自动同步到 Figma\n`);
    
    // 尝试设置文件夹为"始终保留下载" (Keep Downloaded)
    try {
      console.log('☁️  正在配置 iCloud 文件夹为"始终保留下载"...');
      exec(`brctl download -R "${CONFIG.icloudPath}"`, (error) => {
        if (error) {
          // brctl 可能会因为权限或路径问题报错，但不应阻止主流程
          console.log('   ⚠️  配置"始终保留下载"失败 (这不影响基本功能):', error.message);
        } else {
          console.log('   ✅ 已配置 iCloud 文件夹为"始终保留下载"');
        }
      });
    } catch (e) {
      // 忽略同步执行错误
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
    const files = fs.readdirSync(CONFIG.icloudPath);
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      const filePath = path.join(CONFIG.icloudPath, file);
      
      // 忽略 GIF-导出 子文件夹
      if (file === 'GIF-导出' && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        return false;
      }
      
      // 忽略子文件夹（截图、GIF、视频）
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        return false;
      }
      
      return CONFIG.supportedFormats.includes(ext);
    });
    
    console.log(`   📋 找到 ${files.length} 个文件`);
    console.log(`   🖼️  其中 ${imageFiles.length} 个是媒体文件\n`);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-file-count',
        count: imageFiles.length
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
  
  const files = fs.readdirSync(CONFIG.icloudPath);
  const imageFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    const filePath = path.join(CONFIG.icloudPath, file);
    
    // 忽略 GIF-导出 子文件夹
    if (file === 'GIF-导出' && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      console.log(`🙈 [手动同步] 忽略 GIF-导出 子文件夹`);
      return false;
    }
    
    // 忽略子文件夹（截图、GIF、视频）
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      return false;
    }
    
    return CONFIG.supportedFormats.includes(ext);
  });
  
  if (imageFiles.length === 0) {
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
  
  console.log(`📦 [手动模式] 找到 ${imageFiles.length} 张截图，开始同步...\n`);
  
  let successCount = 0;
  let gifCount = 0; // ✅ 统计 GIF 数量
  let videoCount = 0; // ✅ 统计视频数量
  // 收集处理过程中的错误
  const processingErrors = [];
  
  for (const file of imageFiles) {
    let filePath = path.join(CONFIG.icloudPath, file);
    
    try {
      // 检查文件是否需要手动拖入（GIF过大或视频文件）
      const ext = path.extname(filePath).toLowerCase();
      const isGif = ext === '.gif';
      const isVideo = ext === '.mp4' || ext === '.mov';
      
      // 处理重名文件：如果是视频或 GIF，检查是否有同名文件，如果有则删除旧文件
      if (isVideo || isGif) {
        const nameWithoutExt = path.basename(file, ext);
        const folderPath = CONFIG.icloudPath;
        
        // 检查文件名是否包含 -2, -3 等后缀（macOS 自动添加的）
        const duplicateMatch = nameWithoutExt.match(/^(.+)-(\d+)$/);
        if (duplicateMatch) {
          const originalName = duplicateMatch[1];
          const originalFilePath = path.join(folderPath, `${originalName}${ext}`);
          
          // 如果原始文件存在，删除它（因为新文件会替换它）
          if (fs.existsSync(originalFilePath)) {
            try {
              fs.unlinkSync(originalFilePath);
              console.log(`   🔄 [iCloud] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，已删除旧文件: ${originalName}${ext}`);
              
              // 重命名新文件为原始文件名（去掉 -2 后缀）
              const newFilePath = path.join(folderPath, `${originalName}${ext}`);
              fs.renameSync(filePath, newFilePath);
              console.log(`   ✅ [iCloud] 已重命名新文件: ${file} → ${originalName}${ext}`);
              
              // 更新 filePath 为新的路径
              filePath = newFilePath;
            } catch (renameError) {
              console.warn(`   ⚠️  [iCloud] 处理重名文件失败: ${renameError.message}`);
            }
          }
        } else {
          // 文件名不包含后缀，检查是否有带后缀的同名文件（旧文件）
          // 例如：如果新文件是 file.gif，检查是否有 file-2.gif, file-3.gif 等
          for (let i = 2; i <= 10; i++) {
            const duplicatePath = path.join(folderPath, `${nameWithoutExt}-${i}${ext}`);
            if (fs.existsSync(duplicatePath)) {
              try {
                fs.unlinkSync(duplicatePath);
                console.log(`   🔄 [iCloud] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，已删除旧文件: ${path.basename(duplicatePath)}`);
              } catch (deleteError) {
                console.warn(`   ⚠️  [iCloud] 删除旧文件失败: ${deleteError.message}`);
              }
            }
          }
        }
      }
      
      // 如果是 GIF，先检查文件是否可读，然后检查大小
      if (isGif) {
        try {
          // 🔍 确保文件已完全从 iCloud 下载（与 syncScreenshot 中的逻辑一致）
          console.log(`   🎬 检测到 GIF 文件: ${file}`);
          console.log(`   🔍 检查文件是否已从 iCloud 下载...`);
          try {
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(8);
            fs.readSync(fd, buffer, 0, 8, 0);
            fs.closeSync(fd);
            console.log(`   ✅ 文件可读，继续处理`);
          } catch (readError) {
            console.log(`   ⚠️  文件预读取失败 (可能是 iCloud 尚未下载完成)`);
            console.log(`   📋 错误: ${readError.message} (errno: ${readError.errno || readError.code})`);
            
            // 尝试使用 brctl download 强制下载
            try {
              console.log(`   ☁️  尝试使用 brctl 强制下载...`);
              exec(`brctl download "${filePath}"`);
            } catch (e) {
              // 忽略 brctl 错误
            }

            console.log(`   ⏳ 等待 5 秒后重试...`);
            await sleep(5000);
            
            // 再次尝试读取
            try {
              const fd = fs.openSync(filePath, 'r');
              const buffer = Buffer.alloc(8);
              fs.readSync(fd, buffer, 0, 8, 0);
              fs.closeSync(fd);
              console.log(`   ✅ 重试成功，文件已可读`);
            } catch (retryError) {
              const errorMsg = `GIF 文件尚未从 iCloud 下载完成。\n\n请在 iCloud 云盘中找到 ScreenSyncImg 文件夹，点击文件旁的云朵图标下载，或右键选择"始终保留在此 Mac 上"。\n\n(系统错误: ${retryError.message})`;
              console.error(`   ❌ ${errorMsg}`);
              throw new Error(errorMsg);
            }
          }
          
          // 检查文件大小
          const stats = fs.statSync(filePath);
          const fileSize = stats.size;
          const maxGifSize = 100 * 1024 * 1024; // 100MB
          
          if (fileSize > maxGifSize) {
            // GIF 过大，需要手动拖入，不算成功
            console.log(`   ⚠️  GIF 文件过大，需要手动拖入: ${file}`);
            
            // 自动缓存大 GIF 文件（用于导出带标注的 GIF 功能）
            try {
              const fileBuffer = fs.readFileSync(filePath);
              const userConfig = require('./userConfig');
              const cacheResult = userConfig.saveGifToCache(fileBuffer, file, null);
              if (cacheResult && cacheResult.cacheId) {
                console.log(`   💾 [GIF Cache] 大GIF已自动缓存 (ID: ${cacheResult.cacheId})`);
              }
            } catch (cacheError) {
              console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
            }
            
            // 发送 file-skipped 消息（syncScreenshot 中也会发送，但这里提前发送确保消息顺序）
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'file-skipped',
                filename: file,
                reason: 'gif-too-large'
              }));
            }
            // ✅ 统计大GIF数量（即使被skipped也算）
            gifCount++;
            // 跳过此文件，不增加成功计数
            continue;
          }
        } catch (checkError) {
          // 如果检查失败，记录错误并跳过此文件
          console.error(`   ❌ GIF 文件检查失败: ${checkError.message}`);
          processingErrors.push({
            filename: file,
            error: checkError.message,
            stack: checkError.stack
          });
          continue;
        }
      }
      
      // 如果是视频文件，需要手动拖入，不算成功
      if (isVideo) {
        console.log(`   🎥 检测到视频文件: ${file}`);
        console.log(`   ⚠️  视频文件需要手动拖入`);
        
        // 🔍 确保文件已完全从 iCloud 下载后再缓存
        try {
          console.log(`   🔍 检查文件是否已从 iCloud 下载...`);
          try {
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(8);
            fs.readSync(fd, buffer, 0, 8, 0);
            fs.closeSync(fd);
            console.log(`   ✅ 文件可读，继续缓存`);
          } catch (readError) {
            console.log(`   ⚠️  文件预读取失败 (可能是 iCloud 尚未下载完成)`);
            console.log(`   📋 错误: ${readError.message} (errno: ${readError.errno || readError.code})`);
            
            // 尝试使用 brctl download 强制下载
            try {
              console.log(`   ☁️  尝试使用 brctl 强制下载...`);
              exec(`brctl download "${filePath}"`);
            } catch (e) {
              // 忽略 brctl 错误
            }

            console.log(`   ⏳ 等待 5 秒后重试...`);
            await sleep(5000);
            
            // 再次尝试读取
            try {
              const fd = fs.openSync(filePath, 'r');
              const buffer = Buffer.alloc(8);
              fs.readSync(fd, buffer, 0, 8, 0);
              fs.closeSync(fd);
              console.log(`   ✅ 重试成功，文件已可读`);
            } catch (retryError) {
              const errorMsg = `视频文件尚未从 iCloud 下载完成。请在 iCloud 云盘中找到 ScreenSyncImg 文件夹，点击文件旁的云朵图标下载。\n\n(系统错误: ${retryError.message})`;
              console.error(`   ❌ ${errorMsg}`);
              throw new Error(errorMsg);
            }
          }
          
          // 自动缓存视频文件（用于导出带标注的 GIF 功能）
          const fileBuffer = fs.readFileSync(filePath);
          const userConfig = require('./userConfig');
          const cacheResult = userConfig.saveGifToCache(fileBuffer, file, null);
          if (cacheResult && cacheResult.cacheId) {
            console.log(`   💾 [GIF Cache] 视频已自动缓存 (ID: ${cacheResult.cacheId})`);
          }
        } catch (cacheError) {
          console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
          // 即使缓存失败，也不阻止继续（视频文件本来就需要手动拖入）
        }
        
        // 发送 file-skipped 消息
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: file,
            reason: 'video'
          }));
        }
        // ✅ 统计视频数量（即使被skipped也算，因为已保存到本地）
        videoCount++;
        // 跳过此文件，不增加成功计数
        continue;
      }
      
      await syncScreenshot(filePath, true);
      successCount++;
      
      // ✅ 统计 GIF 数量
      if (isGif) {
        gifCount++;
      }
      
      await sleep(300);
    } catch (error) {
      console.error(`❌ 同步失败: ${file}`, error.message);
      processingErrors.push({
        filename: file,
        error: error.message,
        stack: error.stack
      });
    }
  }
  
  console.log(`\n✅ [手动模式] 同步完成！成功: ${successCount}/${imageFiles.length}\n`);
  if (processingErrors.length > 0) {
    console.log(`   ❌ 失败: ${processingErrors.length} 个`);
  }
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'manual-sync-complete',
      count: successCount,
      gifCount: gifCount,
      videoCount: videoCount, // ✅ 添加视频数量
      errors: processingErrors
    }));
  }
}

// ============= 同步截图（简化版，不再注册监听器）=============
async function syncScreenshot(filePath, deleteAfterSync = false) {
  const startTime = Date.now();
  const filename = path.basename(filePath);
  
  // 🔍 第一步：检查是否重复处理
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
    
    // 检测文件格式
    const ext = path.extname(filePath).toLowerCase();
    const isHeif = ext === '.heif' || ext === '.heic';
    const isGif = ext === '.gif';
    const isVideo = ext === '.mp4' || ext === '.mov';
    
    let imageBuffer;
    
    if (isVideo) {
      // 视频格式（MP4 或 MOV）- Figma 插件 API 不支持视频文件，跳过处理
      const videoFormat = ext === '.mp4' ? 'MP4' : 'MOV';
      console.log(`   🎥 检测到 ${videoFormat} 视频格式`);
      console.log(`   ⚠️  Figma 插件 API 不支持视频文件，跳过此文件`);
      console.log(`   💡 提示：请通过 Figma 界面直接拖放视频文件，或使用 GIF 格式`);
      console.log(`   📌 源文件已保留，未删除（因为无法同步到 Figma）`);
      
      // 通知 Figma 插件此文件需要手动拖入
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'file-skipped',
          filename: filename,
          reason: 'video' // 统一使用 video，包含 mp4 和 mov
        }));
      }
      
      // 不删除文件，因为无法同步到 Figma，保留文件让用户手动处理
      // 跳过此文件，不发送到 Figma
      return;
    } else if (isGif) {
      // GIF 格式，检查文件大小
      console.log(`   🎬 检测到 GIF 格式...`);
      
      // 🔍 确保文件已完全从 iCloud 下载
      // 读取文件的前几个字节来触发 iCloud 下载并验证文件可读
      try {
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(8);
        fs.readSync(fd, buffer, 0, 8, 0);
        fs.closeSync(fd);
        console.log(`   ✅ 文件可读，继续处理`);
      } catch (readError) {
        console.log(`   ⚠️  文件预读取失败 (可能是 iCloud 尚未下载完成): ${readError.message}`);
        console.log(`   📋 系统错误码: ${readError.errno || readError.code}`);
        
        // 尝试使用 brctl download 强制下载
        try {
          console.log(`   ☁️  尝试使用 brctl 强制下载...`);
          exec(`brctl download "${filePath}"`);
        } catch (e) {
          // 忽略 brctl 错误
        }

        console.log(`   ⏳ 等待 5 秒后重试...`);
        await sleep(5000);
        
        // 再次尝试读取，如果失败则抛出更明确的错误
        try {
          const fd = fs.openSync(filePath, 'r');
          const buffer = Buffer.alloc(8);
          fs.readSync(fd, buffer, 0, 8, 0);
          fs.closeSync(fd);
          console.log(`   ✅ 重试成功，文件已可读`);
        } catch (retryError) {
          throw new Error(`GIF 文件尚未从 iCloud 下载完成。\n\n请在 iCloud 云盘中找到 ScreenSyncImg 文件夹，点击文件旁的云朵图标下载，或右键选择"始终保留在此 Mac 上"。\n\n(系统错误: ${retryError.message})`);
        }
      }
      
      // 读取完整的GIF文件
      imageBuffer = fs.readFileSync(filePath);
      const originalSize = imageBuffer.length;
      const maxGifSize = 100 * 1024 * 1024; // 100MB（防止 Figma 死机）
      
      // 检查文件大小
      if (originalSize > maxGifSize) {
        const fileSizeMB = (originalSize / 1024 / 1024).toFixed(2);
        console.log(`   ⚠️  GIF 文件过大 (${fileSizeMB}MB)，超过限制 (100MB)`);
        console.log(`   ⚠️  为防止 Figma 死机，跳过此文件（文件过大可能导致传输失败）`);
        console.log(`   📌 源文件已保留，未删除（因为无法同步到 Figma）`);
        
        // 通知 Figma 插件此文件需要手动拖入
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: filename,
            reason: 'gif-too-large'
          }));
        }
        
        // 不删除文件，保留文件让用户手动处理
        return;
      }
      
      // 文件大小合适，直接使用原始文件
      const fileSizeKB = (imageBuffer.length / 1024).toFixed(2);
      console.log(`   ✅ 使用原始 GIF 文件: ${fileSizeKB}KB`);
    } else if (isHeif && os.platform() === 'darwin') {
      // 使用 macOS 自带的 sips 命令转换 HEIF 到 JPEG
      console.log(`   🔄 检测到 HEIF 格式，使用 sips 转换为 JPEG...`);
      
      let tempInputPath = filePath; // 直接使用原文件路径
      let tempOutputPath = path.join(os.tmpdir(), `jpeg-output-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
      
      try {
        // 确保文件已完全从 iCloud 下载
        // 读取文件的前几个字节来触发 iCloud 下载并验证文件可读
        try {
          const fd = fs.openSync(filePath, 'r');
          const buffer = Buffer.alloc(8);
          fs.readSync(fd, buffer, 0, 8, 0);
          fs.closeSync(fd);
        } catch (readError) {
          console.log(`   ⚠️  文件预读取失败 (可能是 iCloud 尚未下载完成): ${readError.message}`);
          
          // 尝试使用 brctl download 强制下载 (macOS 私有命令，可能不可用，但值得一试)
          try {
            console.log(`   ☁️  尝试使用 brctl 强制下载...`);
            exec(`brctl download "${filePath}"`);
          } catch (e) {
            // 忽略 brctl 错误
          }

          console.log(`   ⏳ 等待 3 秒后重试...`);
          await sleep(3000);
          
          // 再次尝试读取，如果失败则抛出更明确的错误
          try {
            const fd = fs.openSync(filePath, 'r');
            fs.closeSync(fd);
          } catch (retryError) {
            throw new Error(`文件尚未从 iCloud 下载完成，请在 iCloud 云盘中找到名为 ScreenSyncImg 的文件夹并点击云朵图标下载。\n(系统错误: ${retryError.message})`);
          }
        }

        // 使用 sips 转换为 JPEG
        const sipsCommand = `sips -s format jpeg "${tempInputPath}" --out "${tempOutputPath}"`;
        
        await new Promise((resolve, reject) => {
          exec(sipsCommand, 
            { maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
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
        
        // 读取转换后的 JPEG 文件
        let convertedBuffer = fs.readFileSync(tempOutputPath);
        
        // 使用 sharp 对转换后的 JPEG 进行压缩和调整大小
        imageBuffer = await sharp(convertedBuffer)
          .resize(CONFIG.maxWidth, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: CONFIG.quality })
          .toBuffer();
        
        // 清理临时文件
        try {
          fs.unlinkSync(tempOutputPath);
        } catch (cleanupError) {
          // 忽略清理错误
        }
        
        const compressedSize = (imageBuffer.length / 1024).toFixed(2);
        console.log(`   📦 ${originalSize}KB → ${compressedSize}KB (HEIF → JPEG)`);
      } catch (sipsError) {
        console.log(`   ❌ sips 转换失败: ${sipsError.message}`);
        console.log(`   ⚠️  跳过此文件（无法转换 HEIF 格式）`);
        throw new Error(`HEIF 转换失败: ${sipsError.message}`);
      }
    } else if (isHeif) {
      // 非 macOS 系统，无法使用 sips
      console.log(`   ❌ 检测到 HEIF 格式，但当前系统不支持 sips 转换`);
      console.log(`   ⚠️  跳过此文件（无法转换 HEIF 格式）`);
      throw new Error('HEIF 格式需要 macOS 系统支持');
    } else {
      // 非 HEIF 格式，使用 sharp 正常处理
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
    
    // 使用 base64 编码，避免 Array.from 创建巨大数组占用内存（与 drive-watcher.js 保持一致）
    const base64String = imageBuffer.toString('base64');
    imageBuffer = null; // 立即释放内存
    
    // 检查是否是 GIF 且开启了保留设置
    const keptInIcloud = isGif && CONFIG.keepGifInIcloud;
    
    const payload = {
      type: 'screenshot',
      bytes: base64String, // 直接使用 base64 字符串，Figma 端需要解码
      timestamp: Date.now(),
      filename: filename,
      keptInIcloud: keptInIcloud || false // 通知 Figma 插件文件已保留在 iCloud
    };
    
    ws.send(JSON.stringify(payload));
    
    syncCount++;
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`   ✅ 同步完成 (${duration}秒)`);
    console.log(`   📊 已同步: ${syncCount} 张`);
    
    // ✅ 标记文件为已处理，防止重复同步
    markFileAsProcessed(filePath);
    
    if (deleteAfterSync) {
      // 如果是 GIF 且开启了保留设置，不删除源文件
      if (isGif && CONFIG.keepGifInIcloud) {
        console.log('   📌 GIF 保留设置已启用，源文件将保留在 iCloud 文件夹中');
        console.log('');
      } else {
      // 添加到待删除队列，等待Figma确认
      pendingDeletes.set(filename, filePath);
      console.log('   ⏳ 等待Figma确认...');
      
      // 设置超时兜底删除（10秒）
      setTimeout(() => {
        if (pendingDeletes.has(filename)) {
          console.log(`   ⚠️  等待确认超时（10秒），强制删除: ${filename}`);
          const path = pendingDeletes.get(filename);
          pendingDeletes.delete(filename);
          
          if (fs.existsSync(path)) {
            deleteFile(path);
          }
          console.log('');
        }
      }, 10000);
      }
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
  // 不退出进程，保持 Watcher 运行
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [警告] 未处理的 Promise 拒绝:', reason);
});

// ============= 启动 =============
function start() {
  console.clear();
  console.log('╔════════════════════════════════════════╗');
  console.log('║  iPhone截图同步 - Mac端监听器         ║');
  console.log('║  支持实时同步和手动同步两种模式       ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  connectWebSocket();
  
  console.log('📍 同步文件夹:', CONFIG.icloudPath);
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