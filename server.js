// server.js - WebSocket 服务器和 HTTP 上传接口
//更新：优化 GIF 导出速度 + 质量

// 全局错误处理（必须在最前面）
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error);
  console.error('   堆栈:', error.stack);
  // 在 Cloud Run 中，不要立即退出，让服务器尝试启动
  if (!process.env.PORT) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason);
  // 在 Cloud Run 中，不要立即退出
  if (!process.env.PORT) {
    process.exit(1);
  }
});

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const sharp = require('sharp');

// 优化 sharp 配置，减少内存占用并提高稳定性（特别是在 LaunchAgent 环境下）
sharp.cache(false); // 禁用缓存，防止内存泄漏
sharp.simd(false); // 禁用 SIMD 指令集，提高在不同 CPU 架构下的兼容性
// 限制并发数，避免在后台运行时占用过多 CPU 导致被系统限制
sharp.concurrency(1); 

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

// ✅ 跟踪每个连接的活动子进程，用于取消时终止
const activeProcesses = new Map(); // connectionId -> Set<ChildProcess>

/**
 * 可取消的 execAsync 包装函数
 * @param {string} cmd - 要执行的命令
 * @param {object} options - exec 选项
 * @param {string} connectionId - 连接 ID，用于跟踪进程
 * @returns {Promise}
 */
function execAsyncCancellable(cmd, options = {}, connectionId = null) {
  return new Promise((resolve, reject) => {
    const childProcess = exec(cmd, options, (error, stdout, stderr) => {
      // 从活动进程列表中移除
      if (connectionId) {
        const processes = activeProcesses.get(connectionId);
        if (processes) {
          processes.delete(childProcess);
        }
      }
      
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    
    // 添加到活动进程列表
    if (connectionId) {
      if (!activeProcesses.has(connectionId)) {
        activeProcesses.set(connectionId, new Set());
      }
      activeProcesses.get(connectionId).add(childProcess);
    }
  });
}

/**
 * 终止指定连接的所有活动子进程
 * @param {string} connectionId - 连接 ID
 */
function killActiveProcesses(connectionId) {
  const processes = activeProcesses.get(connectionId);
  if (processes && processes.size > 0) {
    console.log(`   🛑 正在终止 ${processes.size} 个活动子进程...`);
    for (const proc of processes) {
      // ✅ 尝试杀死 Shell 的子进程 (即实际运行的 ImageMagick/FFmpeg 命令)
      // 使用 pkill -P 杀死父进程为 proc.pid 的所有进程
      if (proc.pid) {
        try {
          require('child_process').execSync(`pkill -P ${proc.pid} || true`, { stdio: 'ignore' });
        } catch (e) {
          // 忽略错误 (例如没有子进程)
        }
      }

      try {
        // 使用 SIGKILL 强制终止进程树
        process.kill(-proc.pid, 'SIGKILL');
      } catch (e) {
        // 进程可能已经结束
        try {
          proc.kill('SIGKILL');
        } catch (e2) {
          // 忽略
        }
      }
    }
    processes.clear();
    console.log(`   ✅ 已终止所有活动子进程`);
  }
}
const crypto = require('crypto');

// Google Drive 功能（可选）
let googleDriveEnabled = false;
let uploadBuffer = null;
let createFolder = null;
let getUserFolderId = null;
let initializeUserFolderForUpload = null;
try {
  const driveModule = require('./googleDrive');
  uploadBuffer = driveModule.uploadBuffer;
  createFolder = driveModule.createFolder;
  googleDriveEnabled = true;
  
  // 用户配置管理
  const userConfig = require('./userConfig');
  getUserFolderId = userConfig.getUserFolderId;
  
  // 为上传接口初始化用户文件夹的函数（带缓存）
  // 在 Cloud Run 上，无法访问本地配置文件，所以需要根据 userId 创建文件夹
  initializeUserFolderForUpload = async (userId) => {
    let DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
    
    // 如果环境变量未设置，尝试从 serviceAccountKey.js 读取默认值
    if (!DRIVE_FOLDER_ID) {
      try {
        const serviceAccountKey = require('./serviceAccountKey');
        if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
          DRIVE_FOLDER_ID = serviceAccountKey.defaultFolderId;
        }
      } catch (error) {
        // 忽略错误
      }
    }
    
    if (!DRIVE_FOLDER_ID) {
      throw new Error('未配置 GDRIVE_FOLDER_ID');
    }
    
    if (!userId) {
      throw new Error('未提供用户ID，无法创建用户文件夹');
    }
    
    // 检查缓存
    if (userFolderCache.has(userId)) {
      return userFolderCache.get(userId);
    }
    
    // 用户文件夹名称格式：ScreenSync-{userId}
    const userFolderName = `ScreenSync-${userId}`;
    
    // 使用 createFolder，它会自动检查文件夹是否已存在
    const { listFolderFiles } = require('./googleDrive');
    try {
      // 先快速检查缓存，如果不存在再查找
      const { files } = await listFolderFiles({
        folderId: DRIVE_FOLDER_ID,
        pageSize: 100, // 减少查询数量，只查前100个
        orderBy: 'modifiedTime desc' // 新文件夹通常在前面
      });
      
      // 查找同名的文件夹
      const existingFolder = files.find(
        file => file.name === userFolderName && 
        file.mimeType === 'application/vnd.google-apps.folder'
      );
      
      if (existingFolder) {
        userFolderCache.set(userId, existingFolder.id);
        return existingFolder.id;
      }
    } catch (error) {
      // 如果查找失败，尝试创建（createFolder 也会检查是否存在）
    }
    
    // 创建新文件夹（createFolder 内部会检查是否存在）
    const folder = await createFolder({
      folderName: userFolderName,
      parentFolderId: DRIVE_FOLDER_ID
    });
    
    // 缓存文件夹ID
    userFolderCache.set(userId, folder.id);
    return folder.id;
  };
  
  console.log('✅ Google Drive 模块已加载（可选功能）');
} catch (error) {
  console.log('ℹ️  Google Drive 模块未启用（iCloud 模式）');
}

// 阿里云功能（可选）
let aliyunOSSEnabled = false;
let ossUploadBuffer = null;
let ossCreateFolder = null;
let ossInitializeUserFolderForUpload = null;
try {
  const ossModule = require('./aliyunOSS');
  ossUploadBuffer = ossModule.uploadBuffer;
  ossCreateFolder = ossModule.createFolder;
  aliyunOSSEnabled = true;
  
  // 用户配置管理
  if (!getUserFolderId) {
    const userConfig = require('./userConfig');
    getUserFolderId = userConfig.getUserFolderId;
  }
  
  // 为上传接口初始化用户文件夹的函数（带缓存）
  ossInitializeUserFolderForUpload = async (userId) => {
    const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
    
    if (!userId) {
      throw new Error('未提供用户ID，无法创建用户文件夹');
    }
    
    // 检查缓存
    if (userFolderCache.has(`oss:${userId}`)) {
      return userFolderCache.get(`oss:${userId}`);
    }
    
    // 用户文件夹名称格式：ScreenSync-{userId}
    const userFolderName = `ScreenSync-${userId}`;
    
    // 创建新文件夹（createFolder 内部会检查是否存在）
    const folder = await ossCreateFolder({
      folderName: userFolderName,
      parentFolderId: OSS_ROOT_FOLDER
    });
    
    // 缓存文件夹路径
    userFolderCache.set(`oss:${userId}`, folder.id);
    return folder.id;
  };
  
  console.log('✅ 阿里云模块已加载（可选功能）');
} catch (error) {
  console.log('ℹ️  阿里云模块未启用:', error.message);
}

// 读取同步模式配置文件（如果存在）
const fs = require('fs');
const syncModeFile = path.join(__dirname, '.sync-mode');
const userConfigFile = path.join(__dirname, '.user-config.json');
const os = require('os');

// ------------------------------------------------------------------
// iCloud 强制下载辅助函数
// ------------------------------------------------------------------
function ensureFileDownloaded(filePath) {
  try {
    // 尝试读取文件的第一个字节
    // 这会强制 macOS内核触发 iCloud 下载，否则无法返回数据
    // 这是一个阻塞操作，会直到数据可用或超时
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1);
    fs.readSync(fd, buffer, 0, 1, 0);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    // 如果文件是目录，readSync 会失败，这是预期的
    if (error.code === 'EISDIR') return true;
    
    // 忽略其他错误（如文件已被删除、权限等）
    return false;
  }
}

function recursiveDownload(folderPath) {
  try {
    if (!fs.existsSync(folderPath)) return;
    
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      if (file.startsWith('.')) continue; // 跳过隐藏文件
      
      const fullPath = path.join(folderPath, file);
      try {
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
          recursiveDownload(fullPath);
        } else if (stats.isFile()) {
          // 对文件进行预读
          ensureFileDownloaded(fullPath);
        }
      } catch (e) {
        // 忽略 stat 错误
      }
    }
  } catch (e) {
    // console.error(`[iCloud维护] 遍历失败: ${folderPath}`, e.message);
  }
}

let icloudMaintenanceTimer = null;

function startICloudMaintenance() {
  // 只有在 macOS 上才运行
  if (process.platform !== 'darwin') return;
  
  const icloudPath = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'ScreenSyncImg');

  if (icloudMaintenanceTimer) clearInterval(icloudMaintenanceTimer);
  
  const runMaintenance = () => {
    if (process.env.SYNC_MODE !== 'icloud') {
        if (icloudMaintenanceTimer) {
            clearInterval(icloudMaintenanceTimer);
            icloudMaintenanceTimer = null;
        }
        return;
    }
    
    // 1. 使用系统命令 brctl (如果可用)
    exec(`brctl download -R "${icloudPath}"`, (error) => {
      // 忽略错误
    });
    
    // 2. 使用更强力的递归预读
    setTimeout(() => {
      recursiveDownload(icloudPath);
    }, 2000);
  };
  
  // 立即运行一次
  runMaintenance();
  
  // 每 5 分钟运行一次
  icloudMaintenanceTimer = setInterval(runMaintenance, 5 * 60 * 1000);
  console.log('☁️  [iCloud] 自动维护任务已启动');
}

// 安全地加载 userConfig（Cloud Run 环境中可能不需要）
let userConfig;
try {
  userConfig = require('./userConfig');
} catch (error) {
  console.warn('⚠️  加载 userConfig 失败（Cloud Run 环境可能不需要）:', error.message);
  // 创建一个最小化的 userConfig 对象
  userConfig = {
    getUserIdentifier: () => 'cloud-run-user',
    getDriveFolderId: () => null,
    updateDriveFolderId: () => {},
    updateLocalDownloadFolder: () => {},
    getLocalDownloadFolder: () => null
  };
}

// 辅助函数：清理文件名
function sanitizeFilename(filename, mimeType) {
  // 获取扩展名
  let ext = path.extname(filename);
  if (!ext && mimeType) {
    const mimeToExt = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov'
    };
    ext = mimeToExt[mimeType.toLowerCase()] || '';
  }
  
  // 获取文件名（不含扩展名）
  const nameWithoutExt = path.basename(filename, ext);
  
  // 替换不安全字符
  const sanitized = nameWithoutExt
    .replace(/[<>"|?*\x00-\x1f]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  
  return (sanitized || 'untitled') + ext;
}

// 辅助函数：保存文件到本地
function saveFileToLocalFolder(buffer, filename, mimeType) {
  try {
    const folderPath = userConfig.getLocalDownloadFolder();
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    
    const safeFilename = sanitizeFilename(filename, mimeType);
    const filePath = path.join(folderPath, safeFilename);
    
    // 检查是否是视频或 GIF 文件
    const ext = path.extname(safeFilename).toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov' || (mimeType && mimeType.startsWith('video/'));
    const isGif = ext === '.gif' || (mimeType && mimeType === 'image/gif');
    
    // 如果是视频或 GIF 文件且已存在，直接替换；否则添加时间戳避免覆盖
    let finalPath = filePath;
    if (fs.existsSync(finalPath)) {
      if (isVideo || isGif) {
        // 视频或 GIF 文件：先删除旧文件，再写入新文件（确保直接替换）
        console.log(`   🔄 [Server] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，将替换: ${safeFilename}`);
        try {
          // 先尝试删除文件
          fs.unlinkSync(finalPath);
          // 等待一小段时间确保文件系统完成删除操作
          // 注意：由于这是同步函数，我们使用同步方式检查
          let retries = 3;
          while (fs.existsSync(finalPath) && retries > 0) {
            try {
              fs.unlinkSync(finalPath);
            } catch (retryError) {
              // 忽略重试错误
            }
            retries--;
          }
          if (!fs.existsSync(finalPath)) {
            console.log(`   🗑️  [Server] 已删除旧文件: ${safeFilename}`);
          } else {
            console.warn(`   ⚠️  [Server] 文件删除后仍存在，将直接覆盖`);
          }
        } catch (deleteError) {
          console.warn(`   ⚠️  [Server] 删除旧文件失败，将直接覆盖: ${deleteError.message}`);
        }
        finalPath = filePath; // 使用原路径
      } else {
        // 其他文件：添加时间戳避免覆盖
      const nameWithoutExt = path.basename(safeFilename, ext);
      const timestamp = Date.now();
      finalPath = path.join(folderPath, `${nameWithoutExt}_${timestamp}${ext}`);
      }
    }
    
    // 使用 writeFileSync 的覆盖模式（如果文件存在会被覆盖）
    fs.writeFileSync(finalPath, buffer, { flag: 'w' });
    console.log(`💾 [Server] 文件已保存到本地: ${finalPath}`);
    return true;
  } catch (error) {
    console.error(`❌ [Server] 保存文件到本地失败: ${error.message}`);
    return false;
  }
}

function getUserId() {
  try {
    // 1. 尝试从配置文件读取
    if (fs.existsSync(userConfigFile)) {
      const config = JSON.parse(fs.readFileSync(userConfigFile, 'utf8'));
      if (config.userId) return config.userId;
    }
  } catch (e) {
    // 忽略错误
  }

  // 2. 如果不存在，自动生成 (保持与 get-user-id.sh 逻辑一致)
  try {
    const username = os.userInfo().username;
    const hostname = os.hostname();
    const userId = `${username}@${hostname}`;
    
    // 自动创建配置文件 (可选，但有助于保持一致性)
    const config = {
        userId: userId,
        folderName: `ScreenSync-${userId}`,
        userFolderId: null,
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(userConfigFile, JSON.stringify(config, null, 2));
    
    return userId;
  } catch (e) {
    return 'unknown-user';
  }
}

function readSyncModeFromFile() {
  try {
    if (fs.existsSync && fs.existsSync(syncModeFile)) {
      const mode = fs.readFileSync(syncModeFile, 'utf8').trim();
      if (mode === 'drive' || mode === 'google' || mode === 'icloud' || mode === 'aliyun' || mode === 'oss') {
        return mode;
      }
    }
  } catch (error) {
    // 忽略错误（Cloud Run 环境中文件可能不存在）
    console.log('ℹ️  无法读取同步模式配置文件（Cloud Run 环境正常）');
  }
  return null;
}

// 递归删除文件夹的辅助函数
function removeDirRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  
  const items = fs.readdirSync(dirPath);
  for (const item of items) {
    const itemPath = path.join(dirPath, item);
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      removeDirRecursive(itemPath); // 递归删除子文件夹
    } else {
      fs.unlinkSync(itemPath); // 删除文件
    }
  }
  
  fs.rmdirSync(dirPath); // 删除空文件夹
}

// 清理所有临时文件夹（启动时调用）
function cleanupAllTempFolders() {
  try {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    
    // iCloud 路径
    const icloudPath = path.join(
      os.homedir(),
      'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
    );
    
    // 本地路径
    let localPath;
    try {
      const userConfig = require('./userConfig');
      localPath = userConfig.getLocalDownloadFolder();
    } catch (e) {
      localPath = null;
    }
    
    const foldersToCheck = [icloudPath, localPath].filter(Boolean);
    
    for (const folder of foldersToCheck) {
      if (!fs.existsSync(folder)) continue;
      
      const items = fs.readdirSync(folder);
      for (const item of items) {
        // 匹配所有临时文件夹：.temp-gif-compose-*
        if (item.startsWith('.temp-gif-compose')) {
          const itemPath = path.join(folder, item);
          try {
            // 使用递归删除
            if (fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory()) {
              removeDirRecursive(itemPath);
              console.log(`🧹 已清理旧临时文件夹: ${item}`);
            }
          } catch (cleanupError) {
            console.warn(`⚠️  清理临时文件夹失败: ${item}`, cleanupError.message);
          }
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  启动清理时出错（可忽略）:', error.message);
  }
}

// GIF 标注合成函数
async function composeAnnotatedGif({ frameName, bottomLayerBytes, staticLayers, annotationLayers, annotationBytes, frameBounds, frameBackground, gifInfos, timelineData, connectionId, shouldCancel, onProgress }) {
  const fs = require('fs');
  const path = require('path');

  // ✅ 使用可取消的 execAsync 包装函数，自动跟踪子进程
  const execAsync = (cmd, options = {}) => {
    // 在执行前检查是否已取消
    if (shouldCancel && shouldCancel()) {
      return Promise.reject(new Error('GIF_EXPORT_CANCELLED'));
    }
    return execAsyncCancellable(cmd, options, connectionId);
  };

  // 进度汇报辅助函数
  const reportProgress = (percent, message) => {
    if (onProgress) {
      onProgress(percent, message);
    }
  };

  // 取消检查辅助函数
  const checkCancelled = () => {
    if (shouldCancel && shouldCancel()) {
      throw new Error('GIF_EXPORT_CANCELLED');
    }
  };
  
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║       🎬 开始合成带标注的 GIF                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  
  // 🕐 Debug: Log timeline data
  if (timelineData && Object.keys(timelineData).length > 0) {
    console.log('🕐 [时间线] 收到时间线数据:');
    Object.entries(timelineData).forEach(([layerId, range]) => {
      console.log(`   - layerId: "${layerId}" -> start: ${range.start}%, end: ${range.end}%`);
    });
  } else {
    console.log('🕐 [时间线] 未提供时间线数据（使用默认：所有图层全程显示）');
  }
  
  // 🕐 Debug: Log gifInfos layerIds
  if (gifInfos && gifInfos.length > 0) {
    console.log('🕐 [时间线] gifInfos 中的 layerId:');
    gifInfos.forEach((gif, idx) => {
      console.log(`   - GIF ${idx + 1}: layerId="${gif.layerId}", filename="${gif.filename}"`);
    });
  }
  
  // 诊断 ImageMagick
  console.log('🔍 检查 ImageMagick 安装状态...');
  
  // 1. 定义查找路径和命令
  const searchPaths = [
    '/opt/homebrew/bin',  // Apple Silicon
    '/usr/local/bin',     // Intel Mac
    '/opt/local/bin',     // MacPorts
    '/usr/bin',
    '/bin'
  ];
  
  // 2. 尝试自动修复 PATH
  let pathModified = false;
  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath) && !process.env.PATH.includes(searchPath)) {
      process.env.PATH = `${searchPath}:${process.env.PATH}`;
      pathModified = true;
    }
  }

  if (pathModified) {
    console.log('   ℹ️  已自动修正 PATH 环境变量');
  }

  try {
    // 3. 直接验证 convert 命令可用性 (绕过 which)
    let convertPath = 'convert';
    let versionOutput = '';
    let found = false;

    // 先尝试直接运行 convert
    try {
      const result = await execAsync('convert --version');
      versionOutput = result.stdout;
      found = true;
    } catch (e) {
      // 如果直接运行失败，尝试绝对路径
      for (const searchPath of searchPaths) {
        const fullPath = path.join(searchPath, 'convert');
        if (fs.existsSync(fullPath)) {
          try {
            const result = await execAsync(`"${fullPath}" --version`);
            versionOutput = result.stdout;
            convertPath = fullPath; // 记录找到的完整路径
            // 确保这个路径在 PATH 中 (再次确认)
            if (!process.env.PATH.includes(searchPath)) {
               process.env.PATH = `${searchPath}:${process.env.PATH}`;
            }
            found = true;
            break;
          } catch (err) {
            // 忽略执行错误
          }
        }
      }
    }

    if (!found) {
      throw new Error('无法执行 convert 命令');
    }
    
    // 4. 检查是否真的是 ImageMagick
    const versionLine = versionOutput.split('\n')[0].trim();
    if (versionLine.toLowerCase().includes('imagemagick')) {
      console.log(`   ✅ ImageMagick 已就绪: ${versionLine}`);
    } else {
      console.warn('   ⚠️  警告：检测到的 convert 可能不是 ImageMagick');
      console.warn(`   版本信息: ${versionLine}`);
    }

    // 5. 验证其他必要命令 (identify, composite)
    // 既然 convert 找到了，我们假设同目录下的其他命令也能用，或者就在 PATH 里
    // 为了保险，我们可以简单测试一下 identify
    try {
      await execAsync('identify -version');
    } catch (e) {
      console.warn('   ⚠️  identify 命令执行失败，可能会影响部分功能');
    }

    console.log('');
  } catch (e) {
    console.error('\n❌ ImageMagick 未找到！');
    console.error('   错误:', e.message);
    console.error('');
    console.error('📋 快速解决方案：');
    console.error('   1. 重启服务器试试（Ctrl+C 然后 npm start）');
    console.error('   2. 或运行: brew install imagemagick');
    console.error('   3. 或运行: brew link imagemagick --force');
    console.error('');
    throw new Error('未找到 ImageMagick');
  }
  
  console.log('📋 输入信息:');
  console.log(`   Frame 名称: ${frameName || '未提供'}`);
  console.log(`   Frame 尺寸: ${frameBounds.width}x${frameBounds.height}`);
  console.log(`   GIF 数量: ${gifInfos.length}`);
  gifInfos.forEach((gif, idx) => {
    console.log(`      ${idx + 1}. ${gif.filename}`);
    console.log(`         位置: (${gif.bounds.x}, ${gif.bounds.y}), 尺寸: ${gif.bounds.width}x${gif.bounds.height}`);
  });
  
  // 1. 获取必要的配置
  const userConfig = require('./userConfig');
  const os = require('os');
  
  // 根据当前同步模式确定保存路径
  const currentMode = process.env.SYNC_MODE || 'drive';
  let downloadFolder;
  
  if (currentMode === 'icloud') {
    // iCloud 模式：保存到 iCloud/ScreenSyncImg/GIF-导出 子文件夹
    // 这样监听器只需监听 ScreenSyncImg 根目录，不会与导出的 GIF 混淆
    downloadFolder = path.join(
      os.homedir(),
      'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg/GIF-导出'
    );
    console.log(`📂 [iCloud模式] 输出路径: ${downloadFolder}`);
  } else {
    // Google Drive 或其他模式：保存到 ScreenSyncImg/GIF-导出 子文件夹
    const baseFolder = userConfig.getLocalDownloadFolder();
    downloadFolder = path.join(baseFolder, 'GIF-导出');
    console.log(`📂 [${currentMode}模式] 输出路径: ${downloadFolder}`);
  }
  
  // 确保输出文件夹存在
  if (!fs.existsSync(downloadFolder)) {
    fs.mkdirSync(downloadFolder, { recursive: true });
  }
  
  // 1.5. 生成输出文件名（使用序号命名，填补空缺）
  // 扫描文件夹找到所有现有序号
  const existingNumbers = new Set();
  try {
    const files = fs.readdirSync(downloadFolder);
    files.forEach(file => {
      const match = file.match(/^ExportedGIF_(\d+)\.gif$/);
      if (match) {
        const num = parseInt(match[1], 10);
        existingNumbers.add(num);
      }
    });
  } catch (err) {
    console.warn(`   ⚠️  扫描文件夹失败: ${err.message}`);
  }
  
  // 找到序号：优先填补空缺
  let sequenceNumber = 1;
  if (existingNumbers.size > 0) {
    const maxNumber = Math.max(...existingNumbers);
    // 从 1 开始查找第一个空缺的编号
    for (let i = 1; i <= maxNumber; i++) {
      if (!existingNumbers.has(i)) {
        sequenceNumber = i;
        break;
      }
    }
    // 如果没有空缺，使用 maxNumber + 1
    if (sequenceNumber === 1 && existingNumbers.has(1)) {
      sequenceNumber = maxNumber + 1;
    }
  }
  
  const paddedNumber = sequenceNumber.toString().padStart(3, '0');
  const outputFilename = `ExportedGIF_${paddedNumber}.gif`;
  const outputPath = path.join(downloadFolder, outputFilename);
  console.log(`   📝 导出文件名: ${outputFilename} (序号: ${paddedNumber})`);
  
  // 如果文件已存在，直接跳过所有处理
  if (fs.existsSync(outputPath)) {
    console.log(`\n⏭️  文件已存在，跳过所有处理: ${outputFilename}`);
    const stats = fs.statSync(outputPath);
    reportProgress(100, '文件已存在，已跳过');
    
    return {
      outputPath,
      filename: outputFilename,
      size: stats.size,
      skipped: true
    };
  }
  
  // 为每个导出请求创建独立的临时文件夹（避免并发冲突）
  // 使用 connectionId + 时间戳 确保唯一性
  const uniqueId = `${connectionId}_${Date.now()}`;
  const tempDir = path.join(downloadFolder, `.temp-gif-compose-${uniqueId}`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  console.log(`📁 临时文件夹: ${tempDir}`);
  
  // 2. 验证并查找所有原始 GIF/视频 文件
  console.log(`\n🔍 正在查找所有原始 GIF/视频 文件...`);
  
  // 验证 gifInfos 数据结构
  if (!gifInfos || !Array.isArray(gifInfos) || gifInfos.length === 0) {
    throw new Error('gifInfos 为空或格式不正确');
  }
  
  const gifPaths = [];
  for (let i = 0; i < gifInfos.length; i++) {
    const gif = gifInfos[i];
    
    // 验证每个 gif 对象的结构
    if (!gif) {
      console.error(`   ❌ GIF ${i + 1} 数据为空，跳过`);
      continue;
    }
    
    if (!gif.bounds) {
      console.error(`   ❌ GIF ${i + 1} 缺少 bounds 信息:`, gif);
      throw new Error(`GIF ${i + 1} (${gif.filename || '未知'}) 缺少位置信息 (bounds)`);
    }
    
    console.log(`\n   处理 GIF ${i + 1}/${gifInfos.length}: ${gif.filename}`);
    console.log(`      位置: (${gif.bounds.x}, ${gif.bounds.y}), 尺寸: ${gif.bounds.width}x${gif.bounds.height}`);
    
    let gifPath = null;
    
    // 方法 1：从缓存通过 ID 查找
    if (gif.cacheId) {
      console.log(`      1️⃣  尝试从缓存读取 (ID: ${gif.cacheId})...`);
      const cacheResult = userConfig.getGifFromCache(null, gif.cacheId);
      
      if (cacheResult) {
        gifPath = cacheResult.path;
        console.log(`      ✅ 从缓存找到 (${(cacheResult.buffer.length / 1024 / 1024).toFixed(2)} MB)`);
      }
    }
    
    // 方法 2：从缓存通过文件名查找（精确匹配）
    if (!gifPath && gif.filename) {
      console.log(`      2️⃣  尝试从缓存通过文件名查找...`);
      const cacheResult = userConfig.getGifFromCache(gif.filename, null);
      
      if (cacheResult) {
        gifPath = cacheResult.path;
        console.log(`      ✅ 从缓存找到（精确匹配）`);
      }
    }
    
    // 方法 2.5：从 userConfig 的 GIF 缓存查找
    if (!gifPath && (gif.cacheId || gif.filename)) {
      console.log(`      2.5️⃣  尝试从 GIF 缓存查找...`);
      
      // 优先使用 cacheId
      if (gif.cacheId) {
        console.log(`         使用 cacheId: ${gif.cacheId}`);
        const cacheResult = userConfig.getGifFromCache(null, gif.cacheId);
        if (cacheResult && cacheResult.path) {
          gifPath = cacheResult.path;
          console.log(`      ✅ 通过 cacheId 找到: ${cacheResult.path}`);
          
          // 验证文件是否存在且有效
          if (fs.existsSync(gifPath)) {
            const stats = fs.statSync(gifPath);
            if (stats.size === 0) {
              console.warn(`         ⚠️  缓存文件为空，将删除: ${gifPath}`);
              try {
                fs.unlinkSync(gifPath);
                // 删除对应的 meta 文件
                const metaPath = gifPath.replace(/\.(gif|mov|mp4)$/, '.meta.json');
                if (fs.existsSync(metaPath)) {
                  fs.unlinkSync(metaPath);
                }
              } catch (e) {
                console.error(`         删除损坏文件失败:`, e.message);
              }
              gifPath = null; // 重置，继续查找
            }
          } else {
            console.warn(`         ⚠️  缓存文件不存在: ${gifPath}`);
            gifPath = null;
          }
        }
      }
      
      // 备用：通过文件名匹配
      if (!gifPath && gif.filename) {
        console.log(`         通过文件名查找: ${gif.filename}`);
        // 尝试通过 Drive ID 或文件名查找
        const driveId = gif.driveFileId || gif.ossFileId;
        if (driveId) {
          const cacheResult = userConfig.getGifFromCache(driveId);
          if (cacheResult && cacheResult.path && fs.existsSync(cacheResult.path)) {
            gifPath = cacheResult.path;
            console.log(`      ✅ 通过 Drive ID 找到: ${cacheResult.path}`);
          }
        }
      }
    }
    
    // 方法 2.6：从 ScreenSyncImg 各子文件夹查找（支持手动上传的文件）
    if (!gifPath && (gif.driveFileId || gif.ossFileId || gif.filename)) {
      console.log(`      2.6️⃣  尝试通过文件ID精确查找...`);
      
      const localFolder = userConfig.getLocalDownloadFolder();
      const fileId = gif.driveFileId || gif.ossFileId;
      
      if (fileId) {
        // 定义搜索路径优先级
        const searchFolders = [
          path.join(localFolder, 'GIF-导出'), // 兼容之前的逻辑
          path.join(localFolder, '视频'),     // 手动上传的视频
          path.join(localFolder, 'GIF'),      // 手动上传的 GIF
          path.join(localFolder, '图片'),
          localFolder                         // 根目录
        ];
        
        for (const folder of searchFolders) {
          if (fs.existsSync(folder)) {
            const directPath = path.join(folder, fileId);
            if (fs.existsSync(directPath)) {
              gifPath = directPath;
              console.log(`      ✅ 通过文件ID在 [${path.basename(folder)}] 中找到: ${fileId}`);
              break;
            }
          }
        }
      }
      
      // 备用：如果还没找到，且有 filename，尝试在 GIF-导出 中模糊查找（兼容旧逻辑）
      if (!gifPath && gif.filename) {
        const gifExportFolder = path.join(localFolder, 'GIF-导出');
        if (fs.existsSync(gifExportFolder)) {
          // 列出所有文件
          const allFiles = fs.readdirSync(gifExportFolder);
          
          // 精确匹配
          if (allFiles.includes(gif.filename)) {
            gifPath = path.join(gifExportFolder, gif.filename);
            console.log(`      ✅ 精确匹配文件名: ${gif.filename}`);
          } else {
            // 模糊匹配（去除扩展名后比较）
            const targetExt = path.extname(gif.filename).toLowerCase();
            const targetName = path.basename(gif.filename, targetExt);
            
            for (const file of allFiles) {
              const fileExt = path.extname(file).toLowerCase();
              const fileName = path.basename(file, fileExt);
              
              if (fileName === targetName && ['.gif', '.mov', '.mp4'].includes(fileExt)) {
                gifPath = path.join(gifExportFolder, file);
                console.log(`      ✅ 模糊匹配文件名: ${file}`);
                break;
              }
            }
          }
        }
      }
    }
    
    // 方法 3：从 ScreenSyncImg 文件夹查找（智能匹配，支持子文件夹）
    if (!gifPath && gif.filename) {
      console.log(`      3️⃣  尝试从 ScreenSyncImg 文件夹查找...`);
      console.log(`         目标文件: ${gif.filename}`);
      
      // 获取 ScreenSyncImg 基础路径（根据当前模式自动选择）
      let baseFolder;
      if (currentMode === 'icloud') {
        baseFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
      } else {
        baseFolder = userConfig.getLocalDownloadFolder();
      }
      
      console.log(`         基础路径: ${baseFolder}`);
      
      // 定义要搜索的文件夹列表（按优先级排序）
      const searchFolders = [
        baseFolder,                            // ScreenSyncImg 根目录（兼容旧文件）
        path.join(baseFolder, '视频'),         // 视频子文件夹
        path.join(baseFolder, 'GIF'),          // GIF子文件夹
      ];
      
      console.log(`         将在以下位置搜索:`);
      searchFolders.forEach(folder => {
        console.log(`            - ${folder}`);
      });
      
      // 解析目标文件名
      const targetExt = path.extname(gif.filename).toLowerCase();
      const targetName = path.basename(gif.filename, targetExt);
      
      // 移除可能的 _1, _2, _3 等后缀（macOS 自动添加的重复文件后缀）
      const targetNameClean = targetName.replace(/_\d+$/, '');
      
      console.log(`         查找目标: ${targetNameClean} (扩展名: ${targetExt})`);
      
      // 查找匹配的文件（支持模糊匹配和扩展名变化）
      const compatibleExts = ['.mov', '.mp4', '.gif'];
      
      let matchingFile = null;
      let matchingFolder = null;
      
      // 遍历所有搜索文件夹
      for (const searchFolder of searchFolders) {
        if (!fs.existsSync(searchFolder)) {
          console.log(`         ⏭️  跳过不存在的文件夹: ${searchFolder}`);
          continue;
        }
        
        const filesInFolder = fs.readdirSync(searchFolder);
        console.log(`         📂 扫描 ${path.basename(searchFolder)}/ 文件夹，有 ${filesInFolder.length} 个文件`);
        
        matchingFile = filesInFolder.find(f => {
          // 跳过已导出的文件
          if (f.toLowerCase().includes('_exported') || f.toLowerCase().includes('导出')) return false;
          
          const fExt = path.extname(f).toLowerCase();
          const fName = path.basename(f, fExt);
          const fNameClean = fName.replace(/_\d+$/, '');
          
          // 只处理视频/GIF 文件
          if (!compatibleExts.includes(fExt)) return false;
          
          // 1. 完全匹配
          if (f === gif.filename) return true;
          
          // 2. 文件名匹配（忽略后缀和扩展名）
          if (fNameClean === targetNameClean) {
            if (compatibleExts.includes(targetExt)) {
              return true;
            }
          }
          
          // 3. 包含匹配（如果文件名很长，允许部分匹配）
          if (fNameClean.includes(targetNameClean) || targetNameClean.includes(fNameClean)) {
            if (compatibleExts.includes(targetExt)) {
              return true;
            }
          }
          
          // 4. 宽松匹配：去掉所有特殊字符后比较
          const targetSimple = targetNameClean.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const fSimple = fNameClean.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          
          if (targetSimple && fSimple && targetSimple.length > 5 && fSimple.length > 5) {
            // 如果简化后的名称有一个包含另一个
            if (targetSimple.includes(fSimple) || fSimple.includes(targetSimple)) {
              return true;
            }
          }
          
          // 5. 时间戳匹配：针对 ScreenRecording 文件
          // ScreenRecording_12-22-2025 22-27-25.mov
          const timePattern = /\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}-\d{1,2}-\d{1,2}/;
          const targetTime = targetNameClean.match(timePattern);
          const fTime = fNameClean.match(timePattern);
          
          if (targetTime && fTime && targetTime[0] === fTime[0]) {
            return true;
          }
          
          return false;
        });
        
        if (matchingFile) {
          matchingFolder = searchFolder;
          gifPath = path.join(searchFolder, matchingFile);
          console.log(`      ✅ 从 ${path.basename(searchFolder)}/ 文件夹找到: ${matchingFile}`);
          if (matchingFile !== gif.filename) {
            console.log(`         📝 注意：实际文件名与请求的文件名不同`);
            console.log(`            请求: ${gif.filename}`);
            console.log(`            实际: ${matchingFile}`);
          }
          break; // 找到就退出循环
        }
      }
      
      // 如果没找到，输出详细的调试信息
      if (!matchingFile) {
        console.log(`      ❌ 在所有文件夹中都未找到匹配的文件`);
        console.log(`         查找目标详情:`);
        console.log(`            原始文件名: ${gif.filename}`);
        console.log(`            清理后名称: ${targetNameClean}`);
        console.log(`            扩展名: ${targetExt}`);
        console.log(`\n         所有文件夹内的视频/GIF文件列表:`);
        
        for (const searchFolder of searchFolders) {
          if (!fs.existsSync(searchFolder)) continue;
          
          const filesInFolder = fs.readdirSync(searchFolder);
          const videoGifFiles = filesInFolder.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.mov', '.mp4', '.gif'].includes(ext) && !f.toLowerCase().includes('_exported');
          });
          
          console.log(`\n         📂 ${searchFolder}:`);
          if (videoGifFiles.length === 0) {
            console.log(`            ⚠️ 没有视频/GIF文件`);
          } else {
            videoGifFiles.slice(0, 10).forEach(f => {
              console.log(`            - ${f}`);
            });
            if (videoGifFiles.length > 10) {
              console.log(`            ... 还有 ${videoGifFiles.length - 10} 个文件未显示`);
            }
          }
        }
      }
    }
    
    // 方法 4：单 GIF 自动匹配 - 如果 Frame 里只有一个 GIF，自动使用文件夹中的唯一视频/GIF 文件
    if (!gifPath && gifInfos.length === 1) {
      console.log(`      4️⃣  单 GIF 模式：尝试自动匹配文件夹中的唯一视频/GIF...`);
      
      // 获取 ScreenSyncImg 基础路径
      let baseFolder;
      if (currentMode === 'icloud') {
        baseFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
      } else {
        baseFolder = userConfig.getLocalDownloadFolder();
      }
      
      // 定义要搜索的文件夹列表
      const searchFolders = [
        baseFolder,
        path.join(baseFolder, '视频'),
        path.join(baseFolder, 'GIF'),
      ];
      
      // 收集所有视频/GIF 文件
      const allVideoGifFiles = [];
      const compatibleExts = ['.mov', '.mp4', '.gif'];
      
      for (const searchFolder of searchFolders) {
        if (!fs.existsSync(searchFolder)) continue;
        
        const filesInFolder = fs.readdirSync(searchFolder);
        for (const f of filesInFolder) {
          // 跳过已导出的文件和隐藏文件
          if (f.startsWith('.')) continue;
          if (f.toLowerCase().includes('_exported') || f.toLowerCase().includes('导出')) continue;
          if (f.toLowerCase().includes('exportedgif')) continue;
          
          const fExt = path.extname(f).toLowerCase();
          if (compatibleExts.includes(fExt)) {
            allVideoGifFiles.push({
              filename: f,
              path: path.join(searchFolder, f),
              folder: searchFolder
            });
          }
        }
      }
      
      console.log(`         找到 ${allVideoGifFiles.length} 个视频/GIF 文件`);
      
      if (allVideoGifFiles.length === 1) {
        // 只有一个文件，自动使用
        gifPath = allVideoGifFiles[0].path;
        console.log(`      ✅ 单 GIF 自动匹配成功！`);
        console.log(`         文件夹中只有一个视频/GIF 文件，自动使用: ${allVideoGifFiles[0].filename}`);
        console.log(`         路径: ${gifPath}`);
      } else if (allVideoGifFiles.length > 1) {
        // 多个文件，列出来供用户参考
        console.log(`      ⚠️  文件夹中有多个视频/GIF 文件，无法自动匹配：`);
        allVideoGifFiles.slice(0, 5).forEach((f, idx) => {
          console.log(`         ${idx + 1}. ${f.filename}`);
        });
        if (allVideoGifFiles.length > 5) {
          console.log(`         ... 还有 ${allVideoGifFiles.length - 5} 个文件`);
        }
        console.log(`      💡 提示：将源文件重命名为与 Figma 图层名一致，或删除多余文件只保留一个`);
      } else {
        console.log(`      ❌ 文件夹中没有找到任何视频/GIF 文件`);
      }
    }
    
    if (!gifPath) {
      // 根据情况给出不同的错误提示
      const isSingleGif = gifInfos.length === 1;
      const errorHint = isSingleGif
        ? `\n\n💡 单 GIF 模式提示：\n• 将视频/GIF 文件放入 ScreenSyncImg 文件夹\n• 如果文件夹中只有一个视频/GIF，无需重命名\n• 如果有多个文件，请删除多余的或重命名为图层名`
        : `\n\n💡 多 GIF 模式提示：\n• 请确保每个 GIF 图层都有对应的同名源文件\n• 文件名需要与 Figma 图层名一致`;
      
      throw new Error(`未找到 GIF/视频文件: ${gif.filename}\n\n已尝试：\n• GIF 缓存 (ID: ${gif.cacheId || '无'})\n• 文件名匹配\n• 单 GIF 自动匹配\n• ScreenSyncImg 文件夹: ${downloadFolder}${errorHint}`);
    }
    
    // 再次验证 bounds 数据完整性
    if (!gif.bounds || gif.bounds.x === undefined || gif.bounds.y === undefined) {
      console.error(`      ❌ Bounds 数据不完整:`, gif.bounds);
      throw new Error(`GIF ${i + 1} (${gif.filename}) 的位置信息不完整`);
    }
    
    gifPaths.push({
      path: gifPath,
      bounds: gif.bounds,
      cornerRadius: gif.cornerRadius,
      clipBounds: gif.clipBounds,
      clipCornerRadius: gif.clipCornerRadius,
      imageFillInfo: gif.imageFillInfo, // ✅ 传递 imageFillInfo
      zIndex: gif.zIndex, // ✅ 传递 z-index
      layerId: gif.layerId // ✅ 传递 layerId 用于时间线功能
    });
    
    console.log(`      ✅ 已添加到 gifPaths，bounds: (${gif.bounds.x}, ${gif.bounds.y}), ${gif.bounds.width}x${gif.bounds.height}, zIndex: ${gif.zIndex}`);
  }
  
  console.log(`\n✅ 所有 ${gifPaths.length} 个文件已准备好`);
  console.log(`\n📋 gifPaths 数组内容:`);
  gifPaths.forEach((gp, idx) => {
    console.log(`   ${idx + 1}. path: ${gp.path}`);
    console.log(`      bounds:`, gp.bounds);
  });
  
  // 2.5. 预处理：将视频文件转换为高帧率 GIF
  console.log(`\n🎬 检查是否有视频文件需要转换...`);
  
  // 检查是否有视频文件
  const hasVideo = gifPaths.some(item => {
    const ext = path.extname(item.path).toLowerCase();
    return ext === '.mp4' || ext === '.mov';
  });
  
  // 如果有视频文件，预先检查 FFmpeg
  if (hasVideo) {
    console.log('   🔍 检测到视频文件，验证 FFmpeg...');
    try {
      await execAsync('which ffmpeg');
      const ffmpegVersion = await execAsync('ffmpeg -version 2>&1 | head -1');
      console.log(`   ✅ FFmpeg: ${ffmpegVersion.stdout.trim().split('\n')[0]}`);
    } catch (e) {
      throw new Error('未找到 FFmpeg\n\n视频转 GIF 需要 FFmpeg，请先安装:\nbrew install ffmpeg');
    }
  }
  
  // 🚀 优化：并行处理所有视频转换任务
  await Promise.all(gifPaths.map(async (item, i) => {
    const ext = path.extname(item.path).toLowerCase();
    
    if (ext === '.mp4' || ext === '.mov') {
      console.log(`\n   📹 检测到视频文件: ${path.basename(item.path)}`);
      // reportProgress(5 + (i / gifPaths.length) * 10, `正在转换视频 ${i + 1}/${gifPaths.length} 为高质量 GIF...`);
      
      // 使用 FFmpeg 两步法将视频转为高质量 GIF
      const videoGifPath = path.join(tempDir, `video_${i}.gif`);
      const palettePath = path.join(tempDir, `palette_${i}.png`);
      
      const videoW = Math.round(item.bounds.width);
      const videoH = Math.round(item.bounds.height);
      
      // 🚀 优化：检查视频转GIF缓存
      const crypto = require('crypto');
      const videoStats = fs.statSync(item.path);
      const cacheKey = crypto.createHash('md5')
        .update(`${item.path}_${videoStats.size}_${videoStats.mtime.getTime()}_${videoW}x${videoH}`)
        .digest('hex');
      
      const localFolder = userConfig.getLocalDownloadFolder();
      const videoCacheDir = path.join(localFolder, '.video_gif_cache');
      if (!fs.existsSync(videoCacheDir)) {
        fs.mkdirSync(videoCacheDir, { recursive: true });
      }
      
      const cachedGifPath = path.join(videoCacheDir, `${cacheKey}.gif`);
      
      // 检查缓存
      if (fs.existsSync(cachedGifPath)) {
        console.log(`   ⚡ 使用缓存的 GIF（跳过转换）`);
        console.log(`   📁 缓存路径: ${path.basename(cachedGifPath)}`);
        
        // 直接复制缓存的GIF
        fs.copyFileSync(cachedGifPath, videoGifPath);
        
        // 更新 gifPaths 指向转换后的 GIF
        item.path = videoGifPath;
        // gifPaths[i].path = videoGifPath; // item 是引用，已修改
        console.log(`   ✅ 缓存GIF已复制，耗时: 0秒`);
        return; // 跳过转换
      }
      
      console.log(`   🔄 首次转换此视频（${videoW}x${videoH}），将缓存结果以加速后续导出...`);
      
      // 先检测原视频的帧率和时长
      let videoDuration = 0; // 视频时长（秒）
      let videoFps = 30; // 原视频帧率
      
      try {
        // 获取视频帧率
        const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${item.path}"`;
        const probeResult = await execAsync(probeCmd, { timeout: 10000 });
        const fpsStr = probeResult.stdout.trim();
        if (fpsStr) {
          // 解析帧率，格式可能是 "30/1" 或 "30000/1001"
          const [num, den] = fpsStr.split('/').map(Number);
          videoFps = den ? num / den : num;
          console.log(`   📊 原视频帧率: ${videoFps.toFixed(2)} fps`);
        }
        
        // 获取视频时长
        const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${item.path}"`;
        const durationResult = await execAsync(durationCmd, { timeout: 10000 });
        const durationStr = durationResult.stdout.trim();
        if (durationStr && !isNaN(parseFloat(durationStr))) {
          videoDuration = parseFloat(durationStr);
          console.log(`   ⏱️  视频时长: ${videoDuration.toFixed(2)} 秒`);
        }
      } catch (probeError) {
        console.warn(`   ⚠️  无法检测视频信息，使用默认值`);
      }
      
      // 选择一个 GIF 能精确支持的帧率（延迟为整数）
      // 可用延迟：1, 2, 3, 4, 5... (对应 100fps, 50fps, 33.33fps, 25fps, 20fps...)
      // 选择最接近原视频帧率的延迟
      const idealDelay = 100 / videoFps;
      const gifDelay = Math.max(1, Math.round(idealDelay)); // 至少1/100s（最高100fps）
      const gifFps = 100 / gifDelay;
      
      console.log(`   💡 原视频: ${videoFps.toFixed(2)} fps (理想延迟 ${idealDelay.toFixed(2)}/100s)`);
      console.log(`   🎯 GIF 帧率: ${gifFps.toFixed(2)} fps (延迟 ${gifDelay}/100s)`);
      
      // 计算速度误差
      const speedRatio = gifFps / videoFps;
      const speedError = Math.abs(1 - speedRatio) * 100;
      
      if (speedError < 5) {
        console.log(`   ✅ 速度误差: ${speedError.toFixed(2)}% (可接受)`);
      } else if (speedError < 15) {
        console.log(`   ⚠️  速度误差: ${speedError.toFixed(2)}% (略有偏差，但 GIF 格式限制)`);
      } else {
        console.log(`   ⚠️  速度误差: ${speedError.toFixed(2)}% (GIF 格式限制，无法更精确)`);
      }
      
      // 关键：使用 GIF 帧率从视频中提取帧，而不是原视频帧率
      // 这样 GIF 的时长 = 帧数 × 延迟 = (时长 × GIF帧率) × (1/GIF帧率) = 时长 ✓
      const targetFps = gifFps;
      console.log(`   📐 提取策略: 按 ${targetFps.toFixed(2)} fps 从视频中重采样`);
      
      console.log(`   🎬 使用 FFmpeg 快速转换...`);
      console.log(`   📐 目标尺寸: ${videoW}x${videoH}`);
      
      // 获取原始视频尺寸用于日志
      let originalVideoW = 0, originalVideoH = 0;
      try {
        const sizeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${item.path}"`;
        const sizeResult = await execAsync(sizeCmd, { timeout: 10000 });
        const [w, h] = sizeResult.stdout.trim().split('x').map(Number);
        originalVideoW = w;
        originalVideoH = h;
        console.log(`   📹 原始视频尺寸: ${originalVideoW}x${originalVideoH}`);
        if (originalVideoW > videoW || originalVideoH > videoH) {
          console.log(`   🚀 缩放优化生效: ${originalVideoW}x${originalVideoH} → ${videoW}x${videoH} (减少 ${Math.round((1 - (videoW*videoH)/(originalVideoW*originalVideoH))*100)}% 像素)`);
        } else {
          console.log(`   ℹ️  无需缩放（目标尺寸 >= 原始尺寸）`);
        }
      } catch (e) {
        console.log(`   ⚠️  无法获取原始视频尺寸`);
      }
      
      // 🚀 优化版本：
      // -hwaccel videotoolbox: Mac 硬件加速解码，大幅减少 CPU 负载
      // scale: 先缩放到目标尺寸再生成调色板，减少处理像素量
      // flags=lanczos: 高质量缩放算法
      // 🚀 -threads 0 使用所有 CPU 核心加速
      
      // 先尝试硬件加速，失败则回退到软解
      // 🎨 最优 GIF 算法组合（无噪点 + 平滑渐变）：
      //   - dither=none: 无抖动，获得最干净的画面，无噪点
      //   - stats_mode=full: 全局调色板，分析所有帧生成最优调色板
      //   - diff_mode=rectangle: 帧间矩形差异压缩，减少文件大小和闪烁
      //   - max_colors=256: 最大色彩数，充分利用 GIF 色彩空间
      const ffmpegCmdHwAccel = `ffmpeg -hwaccel videotoolbox -threads 0 -i "${item.path}" -vf "fps=${gifFps},scale=${videoW}:${videoH}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle" -threads 0 "${videoGifPath}" -y`;
      const ffmpegCmdSoftware = `ffmpeg -threads 0 -i "${item.path}" -vf "fps=${gifFps},scale=${videoW}:${videoH}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle" -threads 0 "${videoGifPath}" -y`;
      
      let ffmpegCmd = ffmpegCmdHwAccel;
      let usedHwAccel = true;
      
      console.log(`   📝 FFmpeg 命令 (硬件加速): ${ffmpegCmd}`);
      
      const conversionStartTime = Date.now();
      
      try {
        await execAsync(ffmpegCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 600000 }); // 10分钟超时
        console.log(`   ✅ 硬件加速转换成功`);
      } catch (hwAccelError) {
        // 硬件加速失败，回退到软解
        console.log(`   ⚠️  硬件加速失败，回退到软件解码: ${hwAccelError.message}`);
        usedHwAccel = false;
        ffmpegCmd = ffmpegCmdSoftware;
        console.log(`   📝 FFmpeg 命令 (软件解码): ${ffmpegCmd}`);
        await execAsync(ffmpegCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 600000 });
      }
      
      const conversionTime = ((Date.now() - conversionStartTime) / 1000).toFixed(1);
      console.log(`   ⏱️  转换耗时: ${conversionTime}秒 ${usedHwAccel ? '(硬件加速)' : '(软件解码)'}`);
      
      console.log(`   ✅ GIF 生成完成`);
      
      try {
        
        // 🔍 验证生成的 GIF 文件是否有效
        console.log(`   🔍 验证 GIF 文件完整性...`);
        
        if (!fs.existsSync(videoGifPath)) {
          throw new Error(`GIF 文件未生成: ${videoGifPath}`);
        }
        
        const videoGifStats = fs.statSync(videoGifPath);
        if (videoGifStats.size === 0) {
          throw new Error(`GIF 文件为空: ${videoGifPath}`);
        }
        
        console.log(`   📊 GIF 文件大小: ${(videoGifStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // 使用 identify 验证 GIF 格式
        try {
          const identifyCmd = `identify "${videoGifPath}"[0]`;
          const identifyResult = await execAsync(identifyCmd, { timeout: 10000 });
          console.log(`   ✅ GIF 格式验证通过`);
          
          // 计数总帧数
          const frameCountCmd = `identify "${videoGifPath}" | wc -l`;
          const frameCountResult = await execAsync(frameCountCmd, { timeout: 10000 });
          const totalFrames = parseInt(frameCountResult.stdout.trim());
          const expectedFrames = Math.round(videoDuration * gifFps);
          
          console.log(`   📊 GIF 帧数: ${totalFrames} 帧 (预期 ${expectedFrames} 帧, ${((totalFrames/expectedFrames)*100).toFixed(1)}%)`);
          
          if (totalFrames < 5) {
            throw new Error(`GIF 帧数过少 (${totalFrames} 帧)，可能生成失败`);
          }
          
        } catch (verifyError) {
          console.error(`   ❌ GIF 验证失败: ${verifyError.message}`);
          if (verifyError.stderr) {
            console.error(`   STDERR: ${verifyError.stderr}`);
          }
          
          // 删除无效的 GIF 文件
          if (fs.existsSync(videoGifPath)) {
            fs.unlinkSync(videoGifPath);
          }
          
          throw new Error(`生成的 GIF 文件无效或损坏: ${verifyError.message}`);
        }
        
        
        // 获取生成的 GIF 文件大小
        const finalGifStats = fs.statSync(videoGifPath);
        const gifSizeMB = (finalGifStats.size / 1024 / 1024).toFixed(2);
        
        console.log(`   ✅ 视频已转换为高质量 GIF (${gifFps.toFixed(2)}fps, ${gifSizeMB}MB): ${path.basename(videoGifPath)}`);
        
        // 🚀 优化：保存到缓存以加速后续导出
        try {
          fs.copyFileSync(videoGifPath, cachedGifPath);
          console.log(`   💾 已缓存 GIF，下次导出将秒开！`);
        } catch (cacheError) {
          console.warn(`   ⚠️  缓存保存失败（不影响导出）:`, cacheError.message);
        }
        
        // 更新路径为转换后的 GIF
        item.path = videoGifPath;
        // gifPaths[i].path = videoGifPath;
        
        // 清理临时调色板文件
        try {
          if (fs.existsSync(palettePath)) {
            fs.unlinkSync(palettePath);
          }
        } catch (cleanupError) {
          console.warn(`   ⚠️  清理调色板文件失败（可忽略）: ${cleanupError.message}`);
        }
      } catch (ffmpegError) {
        console.error(`   ❌ FFmpeg GIF 生成失败: ${ffmpegError.message}`);
        if (ffmpegError.stderr) {
          console.error(`   STDERR: ${ffmpegError.stderr}`);
        }
        
        // 清理可能生成的不完整文件
        if (fs.existsSync(videoGifPath)) {
          console.log(`   🧹 清理不完整的 GIF 文件...`);
          try {
            fs.unlinkSync(videoGifPath);
          } catch (e) {
            console.warn(`   ⚠️  清理失败:`, e.message);
          }
        }
        if (fs.existsSync(palettePath)) {
          try {
            fs.unlinkSync(palettePath);
          } catch (e) {
            console.warn(`   ⚠️  清理调色板失败:`, e.message);
          }
        }
        
        throw new Error(`视频转 GIF 失败: ${ffmpegError.message}${ffmpegError.stderr ? '\nSTDERR: ' + ffmpegError.stderr : ''}\n\n请确保已安装 FFmpeg: brew install ffmpeg`);
      }
    }
  }));
  
  // 3. 保存 Bottom Layer（最底层 GIF 下面的图层）
  console.log(`\n🔍 检查 Bottom Layer 数据:`);
  console.log(`   bottomLayerBytes 是否存在: ${!!bottomLayerBytes}`);
  if (bottomLayerBytes) {
    console.log(`   bottomLayerBytes 长度: ${bottomLayerBytes.length}`);
  }
  
  let bottomLayerPath = null;
  if (bottomLayerBytes && bottomLayerBytes.length > 0) {
    bottomLayerPath = path.join(tempDir, 'bottom_layer.png');
    const bottomLayerBuffer = Buffer.from(bottomLayerBytes);
    fs.writeFileSync(bottomLayerPath, bottomLayerBuffer);
    console.log(`💾 Bottom Layer已保存: ${bottomLayerPath} (${(bottomLayerBuffer.length / 1024).toFixed(2)} KB)`);
  } else {
    console.log(`   ⏭️  跳过 Bottom Layer（数据为空）`);
  }
  
  // 4. 保存所有静态图层（Static Layers）- 用于正确的 z-order 合成
  console.log(`\n🔍 检查静态图层数据:`);
  console.log(`   staticLayers 是否存在: ${!!staticLayers}`);
  if (staticLayers) {
    console.log(`   staticLayers 类型: ${typeof staticLayers}`);
    console.log(`   staticLayers 是否为数组: ${Array.isArray(staticLayers)}`);
    console.log(`   staticLayers 数量: ${staticLayers.length}`);
  }
  
  const staticLayerPaths = [];
  if (staticLayers && staticLayers.length > 0) {
    console.log(`\n💾 保存 ${staticLayers.length} 个静态图层:`);
    for (let i = 0; i < staticLayers.length; i++) {
      const layer = staticLayers[i];
      const layerPath = path.join(tempDir, `static_layer_${i}_index${layer.index}.png`);
      const layerBuffer = Buffer.from(layer.bytes);
      fs.writeFileSync(layerPath, layerBuffer);
      
      staticLayerPaths.push({
        path: layerPath,
        index: layer.index,  // z-index in frame.children
        name: layer.name,
        layerId: layer.layerId // ✅ 传递 layerId 用于时间线功能
      });
      
      console.log(`   [${i + 1}/${staticLayers.length}] 已保存: ${layer.name}`);
      console.log(`      - z-index: ${layer.index}`);
      console.log(`      - 路径: ${layerPath}`);
      console.log(`      - 大小: ${(layerBuffer.length / 1024).toFixed(2)} KB`);
    }
    
    console.log(`\n✅ 所有静态图层已保存，将按 z-index 正确合成`);
  } else {
    console.log(`   ⏭️  跳过静态图层（数据为空）`);
  }
  
  // 4.5 保存标注图层（GIF 之上的图层，支持时间线控制）
  const annotationLayerPaths = [];
  if (annotationLayers && annotationLayers.length > 0) {
    console.log(`\n💾 保存 ${annotationLayers.length} 个标注图层（支持时间线）:`);
    for (let i = 0; i < annotationLayers.length; i++) {
      const layer = annotationLayers[i];
      const layerPath = path.join(tempDir, `annotation_layer_${i}_index${layer.index}.png`);
      const layerBuffer = Buffer.from(layer.bytes);
      fs.writeFileSync(layerPath, layerBuffer);
      
      annotationLayerPaths.push({
        path: layerPath,
        index: layer.index,  // z-index in frame.children
        name: layer.name,
        layerId: layer.layerId // ✅ 传递 layerId 用于时间线功能
      });
      
      console.log(`   [${i + 1}/${annotationLayers.length}] 已保存: ${layer.name}`);
      console.log(`      - z-index: ${layer.index}`);
      console.log(`      - layerId: ${layer.layerId}`);
      console.log(`      - 大小: ${(layerBuffer.length / 1024).toFixed(2)} KB`);
    }
    console.log(`\n✅ 所有标注图层已保存，将按时间线设置显示`);
  }
  
  // 5. 保存 Top Layer（兼容模式：如果没有单独的标注图层，使用合成的 annotationBytes）
  let annotationPath = null;
  if (annotationBytes && annotationBytes.length > 0 && annotationLayerPaths.length === 0) {
    annotationPath = path.join(tempDir, 'annotation.png');
    const annotationBuffer = Buffer.from(annotationBytes);
    fs.writeFileSync(annotationPath, annotationBuffer);
    console.log(`💾 Top Layer已保存（合成模式）: ${annotationPath} (${(annotationBuffer.length / 1024).toFixed(2)} KB)`);
  } else if (annotationLayerPaths.length > 0) {
    console.log(`   ⏭️  跳过合成 Top Layer（使用单独的标注图层）`);
  }
  
  // 4. 使用 ImageMagick 合成多个 GIF + 标注
  console.log(`\n🎨 开始合成 ${gifPaths.length} 个 GIF...`);
  console.log(`   Frame 尺寸: ${frameBounds.width}x${frameBounds.height}`);
  console.log(`\n📝 输出文件名: ${outputFilename}`);
  
  try {
    const frameW = Math.round(frameBounds.width);
    const frameH = Math.round(frameBounds.height);
    
    // 🕐 如果有时间线数据，强制使用多 GIF 模式（支持按帧控制可见性）
    const hasTimelineEdits = timelineData && Object.keys(timelineData).length > 0 && 
                             Object.values(timelineData).some(range => range.start > 0 || range.end < 100);
    
    if (gifPaths.length === 1 && !hasTimelineEdits) {
      // 单个 GIF 且没有时间线编辑：使用原有的简单逻辑
      console.log(`\n🎨 单个 GIF 模式 - 快速合成...`);
      reportProgress(10, '正在准备合成...');
      const gifInfo = gifPaths[0];
      
      // ✅ 视频转 GIF 预处理 (单文件模式)
      const ext = path.extname(gifInfo.path).toLowerCase();
      if (ext === '.mov' || ext === '.mp4') {
          console.log(`   📹 检测到视频文件，正在转换为 GIF...`);
          const tempVideoGif = path.join(tempDir, `video_converted_single.gif`);
          
          // 🎨 使用 dither=none 无噪点 + stats_mode=full 全局调色板
          // 🚀 -threads 0 使用所有 CPU 核心加速
          const ffmpegCmd = `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "fps=15,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle" -threads 0 "${tempVideoGif}" -y`;
          
          try {
              await execAsync(ffmpegCmd, { timeout: 120000 });
              // 更新路径，后续逻辑将其视为普通 GIF 处理
              gifInfo.path = tempVideoGif;
              console.log(`      ✅ 视频已转换为 GIF: ${tempVideoGif}`);
          } catch (e) {
              console.error(`      ❌ 视频转换失败:`, e);
              throw new Error(`无法转换视频文件: ${path.basename(gifInfo.path)}`);
          }
      }
      
      // 验证 gifInfo 结构
      console.log(`   验证 gifInfo:`, {
        hasPath: !!gifInfo.path,
        hasBounds: !!gifInfo.bounds,
        boundsKeys: gifInfo.bounds ? Object.keys(gifInfo.bounds) : 'null'
      });
      
      if (!gifInfo || !gifInfo.bounds) {
        console.error(`   ❌ gifInfo 结构无效:`, gifInfo);
        throw new Error('GIF 信息结构无效，缺少 bounds 数据');
      }
      
      let offsetX = Math.round(gifInfo.bounds.x);
      let offsetY = Math.round(gifInfo.bounds.y);
      let gifW = Math.round(gifInfo.bounds.width);
      let gifH = Math.round(gifInfo.bounds.height);
      const cornerRadius = gifInfo.cornerRadius || 0;
      const clipBounds = gifInfo.clipBounds;
      const clipCornerRadius = gifInfo.clipCornerRadius || 0;
      const imageFillInfo = gifInfo.imageFillInfo || { scaleMode: 'FILL' };
      
      console.log(`   GIF 位置参数: offsetX=${offsetX}, offsetY=${offsetY}, width=${gifW}, height=${gifH}, cornerRadius=${cornerRadius}px`);
      if (clipBounds) console.log(`   裁切容器: 圆角=${clipCornerRadius}px`);
      console.log(`   Image Fill Mode: ${imageFillInfo.scaleMode}`);
      console.log(`   🔍 DEBUG imageFillInfo:`, JSON.stringify(imageFillInfo, null, 2));
      
      // 修复: 分步处理，使用 imageTransform 还原用户的自定义裁剪位置
      console.log(`   步骤1: 调整GIF尺寸并应用用户裁剪...`);
      const tempResizedGif = path.join(tempDir, 'resized.gif');
      
      // 检查输入文件是否存在且不为空
      if (!fs.existsSync(gifInfo.path) || fs.statSync(gifInfo.path).size === 0) {
        throw new Error(`输入 GIF 文件不存在或为空: ${gifInfo.path}`);
      }

      // 获取原始 GIF 的尺寸
      let originalW, originalH;
      try {
        const identifyCmd = `identify -format "%w %h" "${gifInfo.path}[0]"`;
        const result = await execAsync(identifyCmd, { timeout: 10000 });
        const [w, h] = result.stdout.trim().split(' ').map(Number);
        originalW = w;
        originalH = h;
        console.log(`      原始 GIF 尺寸: ${originalW}x${originalH}`);
      } catch (e) {
        console.error(`   ❌ 无法读取 GIF 尺寸: ${e.message}`);
        
        // 检查是否是损坏的 GIF 文件
        if (e.message && e.message.includes('improper image header')) {
          console.error(`   🗑️  检测到损坏的 GIF 文件，正在删除: ${gifInfo.path}`);
          
          try {
            // 删除损坏的 GIF 文件
            if (fs.existsSync(gifInfo.path)) {
              fs.unlinkSync(gifInfo.path);
              console.log(`      ✅ 已删除损坏的 GIF 文件`);
            }
            
            // 删除对应的 meta 文件
            const metaPath = gifInfo.path.replace(/\.(gif|mov|mp4)$/, '.meta.json');
            if (fs.existsSync(metaPath)) {
              fs.unlinkSync(metaPath);
              console.log(`      ✅ 已删除对应的 meta 文件`);
            }
            
            // 如果有 cacheId，从 userConfig 清除缓存记录
            if (gifInfo.cacheId) {
              // userConfig 的缓存记录会在下次启动时自动清理不存在的文件
              console.log(`      💡 缓存记录将在下次启动时自动清理`);
            }
          } catch (deleteError) {
            console.error(`      ⚠️  删除损坏文件失败: ${deleteError.message}`);
          }
          
          // 抛出友好的错误信息
          throw new Error(`GIF 文件已损坏并已删除，请重新同步该文件: ${path.basename(gifInfo.path)}`);
        }
        
        throw e;
      }

      // 根据 scaleMode 和 imageTransform 计算缩放和裁剪参数
      let resizeCmd;
      if (imageFillInfo.scaleMode === 'FIT') {
        // FIT: 保持比例缩放以适应容器 (可能留白)
        resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${gifW}x${gifH}" -gravity center -background none -extent ${gifW}x${gifH} "${tempResizedGif}"`;
      } else if (imageFillInfo.scaleMode === 'CROP') {
        // CROP 模式：GIF 不强制填满容器，使用 imageTransform 的缩放系数
        console.log(`      CROP 模式：GIF 可能不会填满容器`);
        console.log(`      🔍 调试信息:`);
        console.log(`         - 原始 GIF: ${originalW}x${originalH}`);
        console.log(`         - 容器尺寸: ${gifW}x${gifH}`);
        
        // 解析 imageTransform
        let imageTransform = imageFillInfo.imageTransform;
        if (typeof imageTransform === 'string') {
          try {
            imageTransform = JSON.parse(imageTransform);
          } catch (e) {
            console.error('   ❌ 解析 imageTransform 失败:', e);
            imageTransform = null;
          }
        }
        
        if (imageTransform && Array.isArray(imageTransform)) {
          const transform = imageTransform;
          const a = transform[0][0] || 1;
          const d = transform[1][1] || 1;
          const tx = transform[0][2] || 0;
          const ty = transform[1][2] || 0;
          
          console.log(`         - imageTransform: [[${transform[0].join(', ')}], [${transform[1].join(', ')}]]`);
          console.log(`         - a=${a.toFixed(6)}, d=${d.toFixed(6)}`);
          console.log(`         - tx=${tx.toFixed(6)}, ty=${ty.toFixed(6)}`);
          
          // Figma 的 imageTransform: 从容器空间到图像空间的变换
          // a, d 表示容器在图像中的相对大小
          // 实际图像显示尺寸 = 容器尺寸 / a（或 d）
          const scaledW = Math.round(gifW / a);
          const scaledH = Math.round(gifH / d);
          
          console.log(`         - 修正后缩放尺寸: 容器${gifW} / ${a.toFixed(3)} = ${scaledW}, 容器${gifH} / ${d.toFixed(3)} = ${scaledH}`);
          console.log(`      ✨ Figma 里 GIF 实际显示尺寸应该是: ${scaledW}×${scaledH}`);
          
          // 计算裁剪偏移（基于缩放后的尺寸）
          const cropOffsetX = Math.round(tx * scaledW);
          const cropOffsetY = Math.round(ty * scaledH);
          
          console.log(`      裁剪偏移: (${cropOffsetX}, ${cropOffsetY})`);
          
          // 缩放 -> 裁剪 -> 放置在透明画布上
          resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${scaledW}x${scaledH}!" -crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY} +repage "${tempResizedGif}"`;
          console.log(`      缩放并裁剪: resize ${scaledW}x${scaledH} -> crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY}`);
        } else {
          // 没有 imageTransform，保持原始尺寸，居中放置
          resizeCmd = `magick "${gifInfo.path}" -coalesce -gravity center -background none -extent ${gifW}x${gifH} "${tempResizedGif}"`;
          console.log(`      无 imageTransform，保持原始尺寸并居中`);
        }
      } else {
        // FILL 模式 (默认): 使用 Cover 缩放，确保填满容器
        console.log(`      FILL 模式：Cover 缩放填满容器`);
        const scaleX = gifW / originalW;
        const scaleY = gifH / originalH;
        const scale = Math.max(scaleX, scaleY); // Cover: 取较大的缩放比例
        
        let scaledW = Math.round(originalW * scale);
        let scaledH = Math.round(originalH * scale);
        
        console.log(`      Cover 模式缩放: ${originalW}x${originalH} -> ${scaledW}x${scaledH} (比例: ${scale.toFixed(3)})`);
        
        let cropOffsetX = 0;
        let cropOffsetY = 0;
        
        // 解析 imageTransform
        let imageTransform = imageFillInfo.imageTransform;
        if (typeof imageTransform === 'string') {
          try {
            imageTransform = JSON.parse(imageTransform);
          } catch (e) {
            console.error('   ❌ 解析 imageTransform 失败:', e);
            imageTransform = null;
          }
        }
        
        if (imageTransform && Array.isArray(imageTransform)) {
          const transform = imageTransform;
          const a = transform[0][0] || 1;
          const d = transform[1][1] || 1;
          const tx = transform[0][2] || 0;
          const ty = transform[1][2] || 0;
          
          // 在 FILL 模式下，用户可能额外放大/缩小了图片
          const userScaleX = 1 / a;
          const userScaleY = 1 / d;
          
          // 重新计算缩放后的尺寸（应用用户的缩放）
          const finalScaledW = Math.round(originalW * scale * userScaleX);
          const finalScaledH = Math.round(originalH * scale * userScaleY);
          
          console.log(`      imageTransform: a=${a.toFixed(3)}, d=${d.toFixed(3)}, tx=${tx.toFixed(3)}, ty=${ty.toFixed(3)}`);
          console.log(`      用户额外缩放: X=${userScaleX.toFixed(3)}, Y=${userScaleY.toFixed(3)}`);
          console.log(`      最终缩放尺寸: ${originalW}x${originalH} -> ${finalScaledW}x${finalScaledH}`);
          
          // 计算裁剪偏移
          cropOffsetX = Math.round(tx * finalScaledW);
          cropOffsetY = Math.round(ty * finalScaledH);
          
          // 更新 scaledW 和 scaledH
          scaledW = finalScaledW;
          scaledH = finalScaledH;
          
          console.log(`      裁剪偏移: (${cropOffsetX}, ${cropOffsetY})`);
        } else {
          // 没有 imageTransform，使用居中裁剪
          cropOffsetX = Math.round((scaledW - gifW) / 2);
          cropOffsetY = Math.round((scaledH - gifH) / 2);
          console.log(`      无 imageTransform，使用居中裁剪: (${cropOffsetX}, ${cropOffsetY})`);
        }
        
        // 确保裁剪偏移在有效范围内
        cropOffsetX = Math.max(0, Math.min(cropOffsetX, scaledW - gifW));
        cropOffsetY = Math.max(0, Math.min(cropOffsetY, scaledH - gifH));
        
        // 先缩放，然后裁剪
        resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${scaledW}x${scaledH}!" -crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY} +repage "${tempResizedGif}"`;
        console.log(`      缩放并裁剪: resize ${scaledW}x${scaledH} -> crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY}`);
      }

      // 🔍 在处理前验证源 GIF 文件
      if (!fs.existsSync(gifInfo.path)) {
        throw new Error(`源 GIF 文件不存在: ${gifInfo.path}`);
      }
      
      const sourceStats = fs.statSync(gifInfo.path);
      console.log(`      源 GIF 大小: ${(sourceStats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // 🚀 优化：如果源 GIF 尺寸和目标尺寸完全相同，且不需要裁剪，直接复制文件跳过 ImageMagick 处理
      // 这对于大型 GIF（数百帧）可以节省数分钟的处理时间
      const needsProcessing = !(originalW === gifW && originalH === gifH && 
                                 imageFillInfo.scaleMode === 'FILL' && 
                                 (!imageFillInfo.imageTransform || 
                                  (typeof imageFillInfo.imageTransform === 'string' && 
                                   imageFillInfo.imageTransform === '[[1,0,0],[0,1,0]]')));
      
      if (!needsProcessing) {
        console.log(`      ⚡ 优化：源尺寸与目标尺寸相同，跳过 resize/crop，直接复制`);
        fs.copyFileSync(gifInfo.path, tempResizedGif);
      } else {
        // 对于大尺寸或大文件，增加 buffer 和超时
        // 使用容器尺寸 (gifW, gifH) 而不是 scaledW/scaledH，因为后者在某些模式下未定义
        const pixelCount = gifW * gifH;
        const isLarge = pixelCount > 2000000 || sourceStats.size > 10 * 1024 * 1024; // 2MP 或 10MB
        const bufferSize = isLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
        const timeout = isLarge ? 600000 : 300000; // 10分钟 vs 5分钟
        
        if (isLarge) {
          console.log(`      ⚠️  检测到大尺寸 GIF (${gifW}x${gifH}, ${(sourceStats.size / 1024 / 1024).toFixed(2)}MB)`);
          console.log(`      📈 增加处理资源: buffer=${(bufferSize / 1024 / 1024).toFixed(0)}MB, timeout=${(timeout / 1000).toFixed(0)}s`);
          // 为大尺寸 GIF 添加 ImageMagick 资源限制参数
          resizeCmd = resizeCmd.replace('magick "', 'magick -limit memory 4GB -limit disk 8GB -limit area 2GB -limit map 4GB -limit thread 4 "');
        }
        
        try {
          await execAsync(resizeCmd, { maxBuffer: bufferSize, timeout: timeout });
        } catch (e) {
          console.error(`   ❌ 步骤1失败: 调整尺寸错误`);
          console.error(`   命令: ${resizeCmd}`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          
          // 关键修复: 如果是文件头错误，说明缓存文件损坏，删除它以便下次重新下载
          if (e.stderr && (e.stderr.includes('improper image header') || e.stderr.includes('no decode delegate'))) {
            console.warn(`   ⚠️  检测到损坏的 GIF 缓存，正在删除: ${gifInfo.path}`);
            try {
              fs.unlinkSync(gifInfo.path);
              e.message += `\n❌ 缓存文件已损坏并被删除。请重试以重新下载文件。`;
            } catch (delErr) {
              console.error('   删除损坏文件失败:', delErr);
            }
          }
          
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      }
      
      // 如果有圆角，应用圆角遮罩
      let roundedGif = tempResizedGif;
      if (cornerRadius > 0) {
        console.log(`   步骤1.5: 应用圆角遮罩 (${cornerRadius}px)...`);
        const tempRoundedGif = path.join(tempDir, 'rounded.gif');
        const maskPath = path.join(tempDir, 'mask.png');

        // 检测源 GIF 大小以确定超时时间
        const roundSourceStats = fs.statSync(tempResizedGif);
        const roundPixelCount = gifW * gifH;
        const roundIsLarge = roundPixelCount > 2000000 || roundSourceStats.size > 10 * 1024 * 1024;
        const roundBufferSize = roundIsLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
        const roundTimeout = roundIsLarge ? 600000 : 300000; // 大文件 10 分钟 vs 5分钟
        
        if (roundIsLarge) {
          console.log(`      ⚠️  大型 GIF，增加圆角处理资源: buffer=${(roundBufferSize / 1024 / 1024).toFixed(0)}MB, timeout=${(roundTimeout / 1000).toFixed(0)}s`);
        }

        // 创建圆角遮罩
        const createMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${cornerRadius},${cornerRadius}" "${maskPath}"`;
        try {
          await execAsync(createMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
        } catch (e) {
          console.error(`   ❌ 步骤1.5失败: 创建圆角遮罩错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }

        // 应用圆角遮罩到GIF的每一帧（使用 alpha extract 确保透明区域正确处理）
        const applyMaskCmd = `magick "${tempResizedGif}" -coalesce null: \\( "${maskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempRoundedGif}"`;
        try {
          await execAsync(applyMaskCmd, { maxBuffer: roundBufferSize, timeout: roundTimeout });
          roundedGif = tempRoundedGif;
        } catch (e) {
          console.error(`   ❌ 步骤1.5失败: 应用圆角遮罩错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      }
      
      // 如果有裁切，应用裁切
      let processedGif = roundedGif;
      if (clipBounds) {
        console.log(`   步骤1.6: 应用裁切...`);
        console.log(`      GIF区域: (${offsetX}, ${offsetY}), ${gifW}x${gifH}`);
        console.log(`      裁切容器区域: (${clipBounds.x}, ${clipBounds.y}), ${clipBounds.width}x${clipBounds.height}`);
        
        // 计算GIF区域和裁切容器的交集（可见区域）
        const intersectLeft = Math.max(offsetX, clipBounds.x);
        const intersectTop = Math.max(offsetY, clipBounds.y);
        const intersectRight = Math.min(offsetX + gifW, clipBounds.x + clipBounds.width);
        const intersectBottom = Math.min(offsetY + gifH, clipBounds.y + clipBounds.height);
        
        const intersectW = Math.max(0, intersectRight - intersectLeft);
        const intersectH = Math.max(0, intersectBottom - intersectTop);
        
        console.log(`      可见区域（交集）: (${intersectLeft}, ${intersectTop}), ${intersectW}x${intersectH}`);
        
        if (intersectW === 0 || intersectH === 0) {
          console.warn(`      ⚠️  GIF完全被裁切，不可见`);
          // GIF完全被裁切掉了，创建一个1x1的透明GIF
          processedGif = roundedGif; // 保持原样，后续会被extent处理
        } else {
          // 计算交集相对于GIF的位置（裁切起点）
          const cropX = Math.round(intersectLeft - offsetX);
          const cropY = Math.round(intersectTop - offsetY);
          const cropW = Math.round(intersectW);
          const cropH = Math.round(intersectH);
          
          console.log(`      在GIF上裁切: 从(${cropX}, ${cropY})裁切${cropW}x${cropH}`);
          
          const tempClippedGif = path.join(tempDir, 'clipped.gif');
          // 使用 -crop 裁切GIF，然后 +repage 重置画布
          const clipCmd = `magick "${roundedGif}" -coalesce -crop ${cropW}x${cropH}+${cropX}+${cropY} +repage "${tempClippedGif}"`;
          try {
            await execAsync(clipCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
            processedGif = tempClippedGif;
            // 裁切后，GIF的尺寸和位置更新为交集的尺寸和位置
            gifW = cropW;
            gifH = cropH;
            offsetX = Math.round(intersectLeft);
            offsetY = Math.round(intersectTop);
            console.log(`      ✅ 裁切完成，新尺寸: ${gifW}x${gifH}, 新位置: (${offsetX}, ${offsetY})`);
            
            // 如果裁切容器有圆角，应用该圆角 (父级圆角)
            if (clipCornerRadius > 0) {
              console.log(`      应用裁切容器圆角 (${clipCornerRadius}px)...`);
              const tempClipRoundedGif = path.join(tempDir, 'clip_rounded.gif');
              const clipMaskPath = path.join(tempDir, 'clip_mask.png');
              
              // 创建父级圆角遮罩 (基于新的尺寸 gifW x gifH)
              const createClipMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${clipCornerRadius},${clipCornerRadius}" "${clipMaskPath}"`;
              await execAsync(createClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
              
              const applyClipMaskCmd = `magick "${processedGif}" -coalesce null: \\( "${clipMaskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempClipRoundedGif}"`;
              await execAsync(applyClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
              processedGif = tempClipRoundedGif;
              console.log(`      ✅ 裁切容器圆角已应用`);
            }
          } catch (e) {
            console.error(`   ❌ 步骤1.6失败: 应用裁切错误`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        }
      }
      
      console.log(`   步骤2: 创建带背景的完整尺寸GIF...`);
      
      // 🔍 验证处理后的 GIF 文件
      if (!fs.existsSync(processedGif)) {
        throw new Error(`处理后的 GIF 文件不存在: ${processedGif}`);
      }
      const processedStats = fs.statSync(processedGif);
      if (processedStats.size === 0) {
        throw new Error(`处理后的 GIF 文件为空: ${processedGif}`);
      }
      console.log(`      处理后 GIF 大小: ${(processedStats.size / 1024 / 1024).toFixed(2)} MB`);
      
      const tempPositionedGif = path.join(tempDir, 'positioned.gif');
      // 使用 -layers Composite 进行定位，这是处理动画定位最稳健的方法，避免变形
      // 1. 创建全尺寸透明画布
      // 2. 将GIF叠加到指定位置 (geometry)
      // 3. -layers Composite 会自动处理多帧动画
      
      // 对于大尺寸，增加 buffer
      const compositePixels = frameW * frameH;
      const compositeIsLarge = compositePixels > 2000000 || processedStats.size > 10 * 1024 * 1024;
      const compositeBuffer = compositeIsLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
      const compositeTimeout = compositeIsLarge ? 600000 : 300000; // 大文件 10 分钟 vs 5分钟
      
      if (compositeIsLarge) {
        console.log(`      ⚠️  大尺寸合成 (${frameW}x${frameH}, ${(processedStats.size / 1024 / 1024).toFixed(2)}MB)`);
        console.log(`      📈 buffer=${(compositeBuffer / 1024 / 1024).toFixed(0)}MB, timeout=${(compositeTimeout / 1000).toFixed(0)}s`);
      }
      
      const extentCmd = `magick -size ${frameW}x${frameH} xc:none null: \\( "${processedGif}" -coalesce \\) -geometry +${offsetX}+${offsetY} -layers Composite "${tempPositionedGif}"`;
      console.log(`      命令: ${extentCmd.length > 200 ? extentCmd.substring(0, 200) + '...' : extentCmd}`);

      try {
        await execAsync(extentCmd, { maxBuffer: compositeBuffer, timeout: compositeTimeout });
        
        // 验证生成的文件
        if (!fs.existsSync(tempPositionedGif)) {
          throw new Error(`合成后的 GIF 文件未生成: ${tempPositionedGif}`);
        }
        const positionedStats = fs.statSync(tempPositionedGif);
        console.log(`      ✅ 合成完成，大小: ${(positionedStats.size / 1024 / 1024).toFixed(2)} MB`);
        
      } catch (e) {
        console.error(`   ❌ 步骤2失败: 定位/合成错误`);
        console.error(`   命令: ${extentCmd}`);
        if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
        if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
        throw e;
      }
      
      console.log(`   步骤3: 按正确顺序合成图层 (背景 -> Bottom -> GIF -> Top)...`);
      console.log(`   💡 注意：单个 GIF 模式暂不支持静态图层在 GIF 之间（因为只有一个 GIF）`);
      reportProgress(30, '正在合成图层 (ImageMagick)...');
      
      // 构建图层合成顺序：Background -> Bottom Layer -> GIF -> Top Layer (annotation)
      let baseLayer = null;
      
      // 步骤3.1: 如果有Frame背景色，先创建背景层
      if (frameBackground && frameBackground.a > 0) {
        console.log(`      步骤3.1: 创建Frame背景层...`);
        const tempBgPath = path.join(tempDir, 'background.png');
        const bgColor = `rgba(${frameBackground.r},${frameBackground.g},${frameBackground.b},${frameBackground.a})`;
        const createBgCmd = `magick -size ${frameW}x${frameH} xc:"${bgColor}" "${tempBgPath}"`;
        try {
          await execAsync(createBgCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
          baseLayer = tempBgPath;
        } catch (e) {
          console.error(`   ❌ 步骤3.1失败: 创建背景层错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      }
      
      // 步骤3.2: 如果有 Bottom Layer，叠加到背景上（或作为第一层）
      if (bottomLayerPath) {
        console.log(`      步骤3.2: 叠加 Bottom Layer（最底层 GIF 下面的图层）...`);
        console.log(`         Bottom Layer 路径: ${bottomLayerPath}`);
        console.log(`         是否有背景层: ${!!baseLayer}`);
        const tempWithBottomPath = path.join(tempDir, 'with_bottom.png');
        if (baseLayer) {
          // 背景 + Bottom Layer -> PNG
          const bottomCmd = `magick "${baseLayer}" "${bottomLayerPath}" -composite "${tempWithBottomPath}"`;
          console.log(`         执行命令: ${bottomCmd.substring(0, 100)}...`);
          try {
            await execAsync(bottomCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
            baseLayer = tempWithBottomPath;
            console.log(`         ✅ 背景 + Bottom Layer 合成成功`);
          } catch (e) {
            console.error(`   ❌ 步骤3.2失败: 合成 Bottom Layer 错误`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        } else {
          // 没有背景，Bottom Layer 就是第一层
          baseLayer = bottomLayerPath;
          console.log(`         ✅ Bottom Layer 作为第一层（无背景）`);
        }
      } else {
        console.log(`      步骤3.2: 跳过 Bottom Layer（无 Bottom Layer 数据）`);
      }
      
      // 步骤3.3: 叠加 GIF
      console.log(`      步骤3.3: 叠加 GIF...`);
      const tempWithGifPath = path.join(tempDir, 'with_gif.gif');
      if (baseLayer) {
        // 有底层（背景或 Bottom Layer），叠加 GIF
        // ✅ 修复：添加 -coalesce 和 null: 分隔符，确保 ImageMagick 正确处理静态图+动画GIF的合成
        const gifCmd = `magick "${baseLayer}" -coalesce null: \\( "${tempPositionedGif}" -coalesce \\) -compose over -layers composite "${tempWithGifPath}"`;
        try {
          await execAsync(gifCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
          baseLayer = tempWithGifPath;
        } catch (e) {
          console.error(`   ❌ 步骤3.3失败: 合成 GIF 错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      } else {
        // 没有底层，GIF 就是第一层
        baseLayer = tempPositionedGif;
      }
      
      // 步骤3.5: 叠加 Top Layer（最顶层 GIF 上面的图层）
      console.log(`      步骤3.5: 叠加 Top Layer（最顶层 GIF 上面的图层）...`);
      
      // 检查是否有 Top Layer 需要合成
      if (annotationPath && fs.existsSync(annotationPath)) {
        // 有 Top Layer，合成到输出文件
        const compositeCmd = `magick "${baseLayer}" -coalesce null: \\( "${annotationPath}" \\) -layers composite -loop 0 "${outputPath}"`;
        console.log(`   命令: ${compositeCmd.substring(0, 150)}...`);
        try {
          await execAsync(compositeCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
        } catch (e) {
          console.error(`   ❌ 步骤3.5失败: 合成 Top Layer 错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      } else {
        // 没有 Top Layer，直接设置循环并输出
        console.log(`      ⏭️  无 Top Layer，直接输出 GIF...`);
        const outputCmd = `magick "${baseLayer}" -loop 0 "${outputPath}"`;
        try {
          await execAsync(outputCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
        } catch (e) {
          console.error(`   ❌ 步骤3.5失败: 输出 GIF 错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      }
      
      reportProgress(90, '合成完成，正在清理...');
    } else {
      // 多个 GIF 或有时间线编辑：逐帧提取和合成
      if (hasTimelineEdits && gifPaths.length === 1) {
        console.log(`\n🎨 时间线编辑模式 - 逐帧提取合成（单 GIF + 时间线）...`);
        console.log(`   🕐 检测到时间线编辑，使用逐帧合成以支持图层可见性控制`);
      } else {
        console.log(`\n🎨 多个 GIF 模式 - 逐帧提取合成...`);
      }
      reportProgress(5, '正在分析 GIF 帧结构...');
      console.log(`   ⚠️  这会需要一些时间...`);
      
      // ⏱️ 步骤计时器
      const stepTimers = {};
      const startStep = (name) => { stepTimers[name] = Date.now(); };
      const endStep = (name) => {
        const duration = ((Date.now() - stepTimers[name]) / 1000).toFixed(2);
        console.log(`   ⏱️  ${name} 耗时: ${duration} 秒`);
        return duration;
      };
      
      // 新策略：逐帧提取、合成、重组
      // 这是处理多个动画 GIF 最可靠的方法
      
      // 第一步：获取所有 GIF 的帧数和延迟时间
      startStep('Step 1 分析GIF');
      console.log(`\n   第 1 步：分析 GIF 信息...`);
      const gifInfoArray = [];
      
      for (let i = 0; i < gifPaths.length; i++) {
        checkCancelled(); // 检查是否被取消
        const gifInfo = gifPaths[i];
        
        // ✅ 视频转 GIF 预处理 (多文件模式)
        const ext = path.extname(gifInfo.path).toLowerCase();
        if (ext === '.mov' || ext === '.mp4') {
            console.log(`      📹 [GIF ${i+1}] 检测到视频文件，正在转换为 GIF...`);
            const tempVideoGif = path.join(tempDir, `video_converted_${i}.gif`);
            
            // 使用 ffmpeg 转换，优化调色板以获得更高质量
            // fps=15: 适合 VFR 视频的帧率转换（不使用 -r 输入参数，避免帧混合）
            // 必须保持原始尺寸 scale=iw:ih，否则 Figma 的 imageTransform 会失效
            // 🎨 使用 dither=none 无噪点 + stats_mode=full 全局调色板
            // 🚀 -threads 0 使用所有 CPU 核心加速
            const ffmpegCmd = `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "fps=15,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle" -threads 0 "${tempVideoGif}" -y`;
            
            try {
                await execAsync(ffmpegCmd, { timeout: 120000 });
                // 更新路径，后续逻辑将其视为普通 GIF 处理
                gifInfo.path = tempVideoGif;
                console.log(`         ✅ 视频已转换为 GIF: ${tempVideoGif}`);
            } catch (e) {
                console.error(`         ❌ 视频转换失败:`, e);
                throw new Error(`无法转换视频文件: ${path.basename(gifInfo.path)}`);
            }
        }
        
        // 获取 GIF 的帧数
        const identifyCmd = `identify -format "%n\\n" "${gifInfo.path}" | head -1`;
        const result = await execAsync(identifyCmd);
        const frameCount = parseInt(result.stdout.trim()) || 1;
        
        // 获取每一帧的延迟时间，并计算精确总时长
        // -format "%T\n" 会输出每一帧的延迟（单位 1/100 秒）
        const delayCmd = `identify -format "%T\\n" "${gifInfo.path}"`;
        const delayResult = await execAsync(delayCmd);
        
        // 解析每一帧的延迟
        const delays = delayResult.stdout.trim().split('\n')
          .map(d => parseInt(d.trim()))
          .filter(d => !isNaN(d));
          
        // 计算实际总时长（所有帧延迟之和）
        const totalDurationTicks = delays.reduce((sum, d) => sum + d, 0);
        const totalDuration = totalDurationTicks / 100;
        
        // 计算平均延迟作为参考
        const avgDelay = delays.length > 0 ? Math.round(totalDurationTicks / delays.length) : 5;
        // 如果有些帧延迟为0，通常播放器会按默认值处理（如10ms），这里我们统一修正为最小 2 ticks (20ms) 以防过快
        const safeDelay = avgDelay < 2 ? 10 : avgDelay;
        
        gifInfoArray.push({
          frameCount,
          delay: safeDelay, // 平均/主要延迟
          delays: delays,   // 保存所有帧的延迟详情
          totalDuration
        });
        
        console.log(`      GIF ${i + 1}: ${frameCount} 帧, 平均延迟: ${safeDelay}/100秒, 实际总时长: ${totalDuration.toFixed(2)}秒`);
      }
      
      // 找到最长的 GIF 时长（这将是输出GIF的总时长）
      const maxDuration = Math.max(...gifInfoArray.map(g => g.totalDuration));
      
      // 使用最小延迟作为输出延迟（确保能捕捉最快GIF的所有帧）
      // 这样可以保证所有GIF都按原速播放
      const allDelays = gifInfoArray.map(g => g.delay);
      const outputDelay = Math.min(...allDelays);
      
      // 计算需要生成的总帧数（基于最长时长和输出延迟）
      const totalOutputFrames = Math.ceil((maxDuration * 100) / outputDelay);
      
      console.log(`   所有 GIF 信息:`);
      gifInfoArray.forEach((gif, idx) => {
        console.log(`      GIF ${idx + 1}: 帧数=${gif.frameCount}, 延迟=${gif.delay}/100s, 时长=${gif.totalDuration.toFixed(2)}s`);
      });
      console.log(`   最长时长: ${maxDuration.toFixed(2)}秒 (以此作为输出GIF的总时长)`);
      console.log(`   输出帧延迟: ${outputDelay}/100秒 (使用最小延迟确保原速播放)`);
      console.log(`   输出总帧数: ${totalOutputFrames}`);
      
      // 第二步：为每个 GIF 提取帧到单独的文件夹
      endStep('Step 1 分析GIF');
      startStep('Step 2 提取帧');
      console.log(`\n   第 2 步：提取所有 GIF 的帧 (并行处理)...`);
      reportProgress(10, '正在提取 GIF 原始帧...');
      // const gifFramesDirs = [];
      
      const gifFramesDirs = await Promise.all(gifPaths.map(async (gifInfo, i) => {
        checkCancelled(); // 检查是否被取消
        const progress = 10 + Math.round((i / gifPaths.length) * 20); // 10% -> 30%
        reportProgress(progress, `正在提取第 ${i + 1}/${gifPaths.length} 个 GIF 的帧...`);
        let offsetX = Math.round(gifInfo.bounds.x);
        let offsetY = Math.round(gifInfo.bounds.y);
        let gifW = Math.round(gifInfo.bounds.width);
        let gifH = Math.round(gifInfo.bounds.height);
        const cornerRadius = gifInfo.cornerRadius || 0;
        const clipBounds = gifInfo.clipBounds;
        const clipCornerRadius = gifInfo.clipCornerRadius || 0;
        let imageFillInfo = gifInfo.imageFillInfo || { scaleMode: 'FILL' };
        const gifData = gifInfoArray[i];
        
        // 🔧 关键修复：解析 imageTransform 字符串为数组
        if (imageFillInfo.imageTransform && typeof imageFillInfo.imageTransform === 'string') {
          try {
            imageFillInfo.imageTransform = JSON.parse(imageFillInfo.imageTransform);
            console.log(`         ✅ imageTransform 已从字符串解析为数组`);
          } catch (e) {
            console.error(`         ❌ 解析 imageTransform 失败:`, e);
            imageFillInfo.imageTransform = null;
          }
        }
        
        console.log(`\n      ========== 提取 GIF ${i + 1}/${gifPaths.length} ==========`);
        console.log(`         文件: ${path.basename(gifInfo.path)}`);
        console.log(`         帧数: ${gifData.frameCount}`);
        console.log(`         📐 原始参数:`);
        console.log(`            - 尺寸: ${gifW}x${gifH}`);
        console.log(`            - 位置: (${offsetX}, ${offsetY})`);
        console.log(`            - 圆角: ${cornerRadius}px`);
        console.log(`            - 裁切: ${clipBounds ? '是' : '否'}`);
        if (clipBounds) {
          console.log(`            - 裁切容器: (${clipBounds.x}, ${clipBounds.y}), ${clipBounds.width}x${clipBounds.height}`);
          console.log(`            - 裁切圆角: ${clipCornerRadius}px`);
        }
        console.log(`         🎨 Image Fill 参数:`);
        console.log(`            - scaleMode: ${imageFillInfo.scaleMode}`);
        if (imageFillInfo.imageTransform) {
          console.log(`            - imageTransform: ${JSON.stringify(imageFillInfo.imageTransform)}`);
        } else {
          console.log(`            - imageTransform: null`);
        }
        
        const framesDir = path.join(tempDir, `gif${i}_frames`);
        if (!fs.existsSync(framesDir)) {
          fs.mkdirSync(framesDir, { recursive: true });
        }
        
        // 先调整尺寸并应用用户裁剪（基于 imageTransform）
        let sourceGif = gifInfo.path;
        let needsResize = true;
        
        // 获取原始 GIF 尺寸
        let originalW, originalH;
        try {
          const identifyCmd = `identify -format "%w %h" "${gifInfo.path}[0]"`;
          const result = await execAsync(identifyCmd, { timeout: 10000 });
          const [w, h] = result.stdout.trim().split(' ').map(Number);
          originalW = w;
          originalH = h;
          console.log(`         原始尺寸: ${originalW}x${originalH}`);
        } catch (e) {
          console.error(`   ❌ 无法读取 GIF 尺寸 (GIF ${i+1})`);
          throw e;
        }
        
        // 根据 scaleMode 和 imageTransform 调整尺寸
        const tempResizedGif = path.join(tempDir, `gif${i}_resized.gif`);
        // 检查是否是大尺寸 GIF，需要增加资源限制
        const pixelCount = gifW * gifH;
        const sourceStats = fs.statSync(gifInfo.path);
        const isLargeGif = pixelCount > 2000000 || sourceStats.size > 10 * 1024 * 1024;
        const magickPrefix = isLargeGif ? 'magick -limit memory 4GB -limit disk 8GB -limit area 2GB -limit map 4GB -limit thread 4' : 'magick';
        const execOptions = isLargeGif 
          ? { maxBuffer: 200 * 1024 * 1024, timeout: 600000 }  // 200MB buffer, 10分钟超时
          : { maxBuffer: 100 * 1024 * 1024, timeout: 120000 }; // 100MB buffer, 2分钟超时
        
        if (isLargeGif) {
          console.log(`         ⚠️  大尺寸 GIF (${gifW}x${gifH}, ${(sourceStats.size / 1024 / 1024).toFixed(2)}MB) - 增加资源限制`);
        }
        
        if (imageFillInfo.scaleMode === 'FIT') {
          // FIT 模式
          // 🚀 使用 FFmpeg 替代 ImageMagick 以避免内存溢出
          // pad filter: 宽:高:x:y:color
          console.log(`         🚀 使用 FFmpeg 处理 FIT 模式缩放...`);
          const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "scale=${gifW}:${gifH}:force_original_aspect_ratio=decrease,pad=${gifW}:${gifH}:(ow-iw)/2:(oh-ih)/2:color=black@0" -y "${tempResizedGif}"`;
          await execAsync(resizeCmd, { timeout: execOptions.timeout });
          sourceGif = tempResizedGif;
          needsResize = false;
        } else if (imageFillInfo.scaleMode === 'CROP') {
          // CROP 模式：GIF 不强制填满容器
          console.log(`         CROP 模式：GIF 可能不会填满容器`);
          console.log(`         🔍 调试信息:`);
          console.log(`            - 原始 GIF: ${originalW}x${originalH}`);
          console.log(`            - 容器尺寸: ${gifW}x${gifH}`);
          
          if (imageFillInfo.imageTransform && Array.isArray(imageFillInfo.imageTransform)) {
            const transform = imageFillInfo.imageTransform;
            const a = transform[0][0] || 1;
            const d = transform[1][1] || 1;
            const tx = transform[0][2] || 0;
            const ty = transform[1][2] || 0;
            
            console.log(`            - imageTransform: [[${transform[0].join(', ')}], [${transform[1].join(', ')}]]`);
            console.log(`            - a=${a.toFixed(6)}, d=${d.toFixed(6)}`);
            console.log(`            - tx=${tx.toFixed(6)}, ty=${ty.toFixed(6)}`);
            
            // Figma 的 imageTransform: a, d 表示容器在图像中的相对大小
            // 实际图像显示尺寸 = 容器尺寸 / a（或 d）
            const scaledW = Math.round(gifW / a);
            const scaledH = Math.round(gifH / d);
            
            console.log(`            - 修正后缩放尺寸: 容器${gifW} / ${a.toFixed(3)} = ${scaledW}, 容器${gifH} / ${d.toFixed(3)} = ${scaledH}`);
            console.log(`         ✨ Figma 里 GIF 实际显示尺寸应该是: ${scaledW}×${scaledH}`);
            
            // 计算裁剪偏移（基于缩放后的尺寸）
            const cropOffsetX = Math.round(tx * scaledW);
            const cropOffsetY = Math.round(ty * scaledH);
            
            console.log(`            - 裁剪偏移: (${cropOffsetX}, ${cropOffsetY})`);
            
            console.log(`         🚀 使用 FFmpeg 处理 CROP 模式 (带变换)...`);
            const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}" -y "${tempResizedGif}"`;
            await execAsync(resizeCmd, { timeout: execOptions.timeout });
          } else {
            console.log(`            - 无 imageTransform，保持原始尺寸并居中`);
            // 没有 imageTransform，保持原始尺寸并居中
            console.log(`         🚀 使用 FFmpeg 处理 CROP 模式 (居中)...`);
            // 逻辑: 保持原尺寸，居中裁剪或填充到目标尺寸
            const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "crop=min(iw,${gifW}):min(ih,${gifH}):(iw-ow)/2:(ih-oh)/2,pad=${gifW}:${gifH}:(ow-iw)/2:(oh-ih)/2:color=black@0" -y "${tempResizedGif}"`;
            await execAsync(resizeCmd, { timeout: execOptions.timeout });
          }
          sourceGif = tempResizedGif;
          needsResize = false;
        } else {
          // FILL 模式：Cover 缩放填满容器
          console.log(`         FILL 模式：Cover 缩放填满容器`);
          const scaleX = gifW / originalW;
          const scaleY = gifH / originalH;
          const scale = Math.max(scaleX, scaleY);
          
          let scaledW = Math.round(originalW * scale);
          let scaledH = Math.round(originalH * scale);
          
          let cropOffsetX = 0;
          let cropOffsetY = 0;
          
          if (imageFillInfo.imageTransform && Array.isArray(imageFillInfo.imageTransform)) {
            const transform = imageFillInfo.imageTransform;
            const a = transform[0][0] || 1;
            const d = transform[1][1] || 1;
            const tx = transform[0][2] || 0;
            const ty = transform[1][2] || 0;
            
            // 用户额外缩放
            const userScaleX = 1 / a;
            const userScaleY = 1 / d;
            
            const finalScaledW = Math.round(originalW * scale * userScaleX);
            const finalScaledH = Math.round(originalH * scale * userScaleY);
            
            console.log(`         imageTransform: a=${a.toFixed(3)}, d=${d.toFixed(3)}, tx=${tx.toFixed(3)}, ty=${ty.toFixed(3)}`);
            console.log(`         用户额外缩放: X=${userScaleX.toFixed(3)}, Y=${userScaleY.toFixed(3)}`);
            console.log(`         最终缩放尺寸: ${finalScaledW}x${finalScaledH}`);
            
            cropOffsetX = Math.round(tx * finalScaledW);
            cropOffsetY = Math.round(ty * finalScaledH);
            
            scaledW = finalScaledW;
            scaledH = finalScaledH;
            
            console.log(`         裁剪偏移: (${cropOffsetX}, ${cropOffsetY})`);
          } else {
            cropOffsetX = Math.round((scaledW - gifW) / 2);
            cropOffsetY = Math.round((scaledH - gifH) / 2);
          }
          
          cropOffsetX = Math.max(0, Math.min(cropOffsetX, scaledW - gifW));
          cropOffsetY = Math.max(0, Math.min(cropOffsetY, scaledH - gifH));
          
          console.log(`         🚀 使用 FFmpeg 处理 FILL 模式...`);
          const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}" -y "${tempResizedGif}"`;
          await execAsync(resizeCmd, { timeout: execOptions.timeout });
          sourceGif = tempResizedGif;
          needsResize = false;
        }
        
        // 如果有圆角，应用圆角遮罩
        if (cornerRadius > 0) {
          console.log(`         应用圆角遮罩 (${cornerRadius}px)...`);
          const tempRoundedGif = path.join(tempDir, `gif${i}_rounded.gif`);
          const maskPath = path.join(tempDir, `gif${i}_mask.png`);
          
          // 创建圆角遮罩
          const createMaskCmd = `${magickPrefix} -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${cornerRadius},${cornerRadius}" "${maskPath}"`;
          try {
            await execAsync(createMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
          } catch (e) {
            console.error(`   ❌ 创建圆角遮罩失败 (GIF ${i+1})`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
          
          // 应用圆角遮罩（使用 alpha extract 确保透明区域正确处理）
          const applyMaskCmd = `magick "${sourceGif}" -coalesce null: \\( "${maskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempRoundedGif}"`;
          try {
            await execAsync(applyMaskCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120000 });
            sourceGif = tempRoundedGif;
            console.log(`         ✅ 圆角遮罩已应用`);
          } catch (e) {
            console.error(`   ❌ 应用圆角遮罩失败 (GIF ${i+1})`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        }
        
        // 如果有裁切，应用裁切
        if (clipBounds) {
          console.log(`         应用父容器裁切...`);
          console.log(`            GIF区域: (${offsetX}, ${offsetY}), ${gifW}x${gifH}`);
          console.log(`            裁切容器区域: (${clipBounds.x}, ${clipBounds.y}), ${clipBounds.width}x${clipBounds.height}`);
          
          // 计算GIF区域和裁切容器的交集（可见区域）
          const intersectLeft = Math.max(offsetX, clipBounds.x);
          const intersectTop = Math.max(offsetY, clipBounds.y);
          const intersectRight = Math.min(offsetX + gifW, clipBounds.x + clipBounds.width);
          const intersectBottom = Math.min(offsetY + gifH, clipBounds.y + clipBounds.height);
          
          const intersectW = Math.max(0, intersectRight - intersectLeft);
          const intersectH = Math.max(0, intersectBottom - intersectTop);
          
          console.log(`            可见区域（交集）: (${intersectLeft}, ${intersectTop}), ${intersectW}x${intersectH}`);
          
          if (intersectW === 0 || intersectH === 0) {
            console.warn(`            ⚠️  GIF完全被裁切，不可见`);
            // GIF完全被裁切掉了，保持原样
          } else {
            // 计算交集相对于GIF的位置（裁切起点）
            const cropX = Math.round(intersectLeft - offsetX);
            const cropY = Math.round(intersectTop - offsetY);
            const cropW = Math.round(intersectW);
            const cropH = Math.round(intersectH);
            
            console.log(`            在GIF上裁切: 从(${cropX}, ${cropY})裁切${cropW}x${cropH}`);
            
            const tempClippedGif = path.join(tempDir, `gif${i}_clipped.gif`);
            const clipCmd = `magick "${sourceGif}" -coalesce -crop ${cropW}x${cropH}+${cropX}+${cropY} +repage "${tempClippedGif}"`;
            try {
              await execAsync(clipCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120000 });
              sourceGif = tempClippedGif;
              // 更新尺寸和位置为交集的尺寸和位置
              gifW = cropW;
              gifH = cropH;
              offsetX = Math.round(intersectLeft);
              offsetY = Math.round(intersectTop);
              console.log(`         ✅ 裁切已应用，新尺寸: ${gifW}x${gifH}, 新位置: (${offsetX}, ${offsetY})`);
              
              // 如果裁切容器有圆角，应用该圆角 (父级圆角)
              if (clipCornerRadius > 0) {
                console.log(`         应用裁切容器圆角 (${clipCornerRadius}px)...`);
                const tempClipRoundedGif = path.join(tempDir, `gif${i}_clip_rounded.gif`);
                const clipMaskPath = path.join(tempDir, `gif${i}_clip_mask.png`);
                
                // 创建父级圆角遮罩 (基于新的尺寸 gifW x gifH)
                const createClipMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${clipCornerRadius},${clipCornerRadius}" "${clipMaskPath}"`;
                await execAsync(createClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
                
                const applyClipMaskCmd = `magick "${sourceGif}" -coalesce null: \\( "${clipMaskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempClipRoundedGif}"`;
                await execAsync(applyClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
                sourceGif = tempClipRoundedGif;
                console.log(`         ✅ 裁切容器圆角已应用`);
              }
            } catch (e) {
              console.error(`   ❌ 应用裁切失败 (GIF ${i+1})`);
              if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
              if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
              throw e;
            }
          }
        }
        
        // 提取并处理每一帧（使用 PNG32 确保完整颜色和 alpha 通道）
        // 使用 -layers Composite 到透明画布，确保位置和比例绝对正确
        // 尺寸已经在前面调整好了，直接合成
        console.log(`         🎬 最终提取帧参数（应用所有变换后）:`);
        console.log(`            - 画布尺寸: ${frameW}x${frameH}`);
        console.log(`            - GIF 最终位置: (+${offsetX}, +${offsetY})`);
        console.log(`            - GIF 最终尺寸: ${gifW}x${gifH}`);
        console.log(`            - 源文件: ${path.basename(sourceGif)}`);
        
        // 🚀 使用 FFmpeg 提取帧，避免 ImageMagick 内存溢出
        // pad 语法: width:height:x:y:color
        // -start_number 0 确保从 frame_0000.png 开始
        console.log(`         🚀 使用 FFmpeg 提取帧...`);
        const extractCmd = `ffmpeg -i "${sourceGif}" -vf "pad=${frameW}:${frameH}:${offsetX}:${offsetY}:color=black@0" -start_number 0 -y "${framesDir}/frame_%04d.png"`;
        
        try {
          await execAsync(extractCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 180000 });
          console.log(`         ✅ 已提取 ${gifData.frameCount} 帧到 ${framesDir}`);
        } catch (e) {
          console.error(`   ❌ 提取帧失败 (GIF ${i+1}):`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          
          // 自动修复：删除损坏的缓存文件
          if (e.stderr && (e.stderr.includes('improper image header') || e.stderr.includes('no decode delegate'))) {
             console.warn(`   ⚠️  检测到损坏的 GIF 缓存，正在删除: ${gifInfo.path}`);
             try {
               fs.unlinkSync(gifInfo.path);
               e.message += `\n❌ 缓存文件已损坏并被删除。请重试以重新下载文件。`;
             } catch (delErr) {
               console.error('   删除损坏文件失败:', delErr);
             }
          }
          
          // 将 stderr 附加到错误消息中
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
        
        console.log(`         ✅ 已提取 ${gifData.frameCount} 帧`);
        return { 
          dir: framesDir, 
          frameCount: gifData.frameCount,
          delay: gifData.delay,
          totalDuration: gifData.totalDuration,
          zIndex: gifInfo.zIndex || 0, // ✅ 保存 GIF 的 z-index
          layerId: gifInfo.layerId, // ✅ Pass layerId
          type: 'gif' // ✅ 标记为 GIF 类型
        };
      }));
      
      // 第三步：构建完整的图层列表（按 z-index 排序）
      endStep('Step 2 提取帧');
      startStep('Step 3 构建图层');
      console.log(`\n   第 3 步：构建图层列表并按 z-index 排序...`);
      
      // 合并 GIF 和静态图层
      const allLayers = [];
      
      // 添加所有 GIF 图层
      gifFramesDirs.forEach((gifInfo, idx) => {
          allLayers.push({
            type: 'gif',
            zIndex: gifInfo.zIndex,
            gifIndex: idx,
            gifInfo: gifInfo,
            layerId: gifInfo.layerId // ✅ Pass layerId
          });
        console.log(`      添加 GIF 图层: zIndex=${gifInfo.zIndex}, gifIndex=${idx}, layerId="${gifInfo.layerId}"`);
        // 🕐 检查时间线匹配
        if (timelineData) {
          const hasMatch = timelineData[gifInfo.layerId];
          console.log(`         🕐 时间线匹配: ${hasMatch ? `✅ 找到 (${hasMatch.start}%-${hasMatch.end}%)` : '❌ 未找到'}`);
        }
      });
      
      // 添加所有静态图层
      if (staticLayerPaths && staticLayerPaths.length > 0) {
        staticLayerPaths.forEach(staticLayer => {
          allLayers.push({
            type: 'static',
            zIndex: staticLayer.index,
            path: staticLayer.path,
            name: staticLayer.name,
            layerId: staticLayer.layerId // ✅ Pass layerId
          });
          console.log(`      添加静态图层: zIndex=${staticLayer.index}, name=${staticLayer.name}, layerId=${staticLayer.layerId}`);
        });
      }
      
      // 添加所有标注图层（GIF 之上的图层，支持时间线）
      if (annotationLayerPaths && annotationLayerPaths.length > 0) {
        annotationLayerPaths.forEach(annotationLayer => {
          allLayers.push({
            type: 'annotation',
            zIndex: annotationLayer.index,
            path: annotationLayer.path,
            name: annotationLayer.name,
            layerId: annotationLayer.layerId // ✅ Pass layerId
          });
          console.log(`      添加标注图层: zIndex=${annotationLayer.index}, name=${annotationLayer.name}, layerId="${annotationLayer.layerId}"`);
          // 🕐 检查时间线匹配
          if (timelineData) {
            const hasMatch = timelineData[annotationLayer.layerId];
            console.log(`         🕐 时间线匹配: ${hasMatch ? `✅ 找到 (${hasMatch.start}%-${hasMatch.end}%)` : '❌ 未找到'}`);
          }
        });
      }
      
      // 按 z-index 排序（从小到大，即从底层到顶层）
      allLayers.sort((a, b) => a.zIndex - b.zIndex);
      
      console.log(`\n   ✅ 图层列表已构建，共 ${allLayers.length} 层，按 z-index 排序:`);
      allLayers.forEach((layer, idx) => {
        if (layer.type === 'gif') {
          console.log(`      ${idx + 1}. [zIndex=${layer.zIndex}] GIF ${layer.gifIndex + 1}`);
        } else {
          console.log(`      ${idx + 1}. [zIndex=${layer.zIndex}] 静态图层: ${layer.name}`);
        }
      });
      
      endStep('Step 3 构建图层');
      
      // 🚀🚀🚀 优化：合并 Step 4 和 Step 5，一次性完成所有层的合成
      // 原来需要处理 N 帧 × 2 步骤 = 2N 次操作
      // 现在只需要 N 帧 × 1 步骤 = N 次操作，减少 50% 的处理时间
      
      startStep('Step 4 合成帧');
      console.log(`\n   第 4 步：逐帧合成 ${totalOutputFrames} 帧（🚀 合并优化：一次性完成所有层）...`);
      reportProgress(30, '正在合成动态帧...');
      
      // 直接输出到最终目录（跳过中间目录）
      const annotatedFramesDir = path.join(tempDir, 'annotated_frames');
      if (!fs.existsSync(annotatedFramesDir)) {
        fs.mkdirSync(annotatedFramesDir, { recursive: true });
      }
      
      // 如果有Frame背景色，先创建背景层
      let backgroundPath = null;
      if (frameBackground && frameBackground.a > 0) {
        console.log(`      创建Frame背景层...`);
        backgroundPath = path.join(tempDir, 'background.png');
        const bgColor = `rgba(${frameBackground.r},${frameBackground.g},${frameBackground.b},${frameBackground.a})`;
        const createBgCmd = `magick -size ${frameW}x${frameH} xc:"${bgColor}" "${backgroundPath}"`;
        try {
          await execAsync(createBgCmd, { maxBuffer: 50 * 1024 * 1024 });
        } catch (e) {
          console.error(`   ❌ 创建背景层失败`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
        }
      }
      
      // 并行处理帧合成，限制并发数
      // 🚀 优化：根据 CPU 核心数动态调整并行数（最小 16，最大 64）
      const os = require('os');
      const cpuCount = os.cpus().length;
      const PARALLEL_LIMIT = Math.min(64, Math.max(16, cpuCount * 4));
      console.log(`      并行处理: ${PARALLEL_LIMIT} 帧/批 (CPU: ${cpuCount} 核)`);
      
      let completedFrames = 0;
      
      // 🚀🚀🚀 优化：一次性合成所有层（背景 + Bottom + GIF层 + Top）
      const processFrame = async (frameIdx) => {
        checkCancelled();
        
        // 🕐 Debug: Log timelineData availability on first frame
        if (frameIdx === 0) {
          console.log(`      🕐 [processFrame] timelineData 可用: ${!!timelineData}, 键数: ${timelineData ? Object.keys(timelineData).length : 0}`);
        }
        
        const outputFrame = path.join(annotatedFramesDir, `frame_${String(frameIdx).padStart(4, '0')}.png`);
        const currentTime = (frameIdx * outputDelay) / 100;
        
        // 收集所有图层路径（按从底到顶的顺序）
        const allLayerPaths = [];
        
        // 1. 背景层（最底层）
        if (backgroundPath) {
          allLayerPaths.push(backgroundPath);
        }
        
        // 2. Bottom Layer
        if (bottomLayerPath) {
          allLayerPaths.push(bottomLayerPath);
        }
        
        // 3. 所有 GIF 和静态图层（按 z-index 顺序）
        for (let layerIdx = 0; layerIdx < allLayers.length; layerIdx++) {
          const layer = allLayers[layerIdx];
          
          if (layer.type === 'gif') {
            const gifInfo = layer.gifInfo;
            
            // Check timeline visibility
            if (timelineData && timelineData[gifInfo.layerId]) {
                const range = timelineData[gifInfo.layerId];
                // 修复：确保最后一帧是100%（使用 totalOutputFrames - 1 作为分母）
                const progress = totalOutputFrames > 1 ? (frameIdx / (totalOutputFrames - 1)) * 100 : 0;
                // Debug: log first few frames
                if (frameIdx < 3) {
                  console.log(`         🕐 [时间线] 检查 GIF层: layerId="${gifInfo.layerId}", progress=${progress.toFixed(1)}%, range=${range.start}%-${range.end}%`);
                }
                if (progress < range.start || progress > range.end) {
                    // Debug: log when skipping
                    if (frameIdx < 3 || frameIdx === totalOutputFrames - 1) {
                      console.log(`         🕐 [时间线] GIF层 在帧${frameIdx} 被跳过`);
                    }
                    continue; // Skip this layer for this frame
                }
            } else if (timelineData && frameIdx === 0) {
                console.log(`         🕐 [时间线] GIF层 layerId="${gifInfo.layerId}" 在 timelineData 中未找到匹配`);
            }

            const gifTime = currentTime % gifInfo.totalDuration;
            const gifFrameIdx = Math.floor(gifTime / (gifInfo.delay / 100));
            const actualGifFrameIdx = Math.min(gifFrameIdx, gifInfo.frameCount - 1);
            const framePath = path.join(gifInfo.dir, `frame_${String(actualGifFrameIdx).padStart(4, '0')}.png`);
            allLayerPaths.push(framePath);
          } else if (layer.type === 'static') {
            // Check timeline visibility
            if (timelineData && timelineData[layer.layerId]) {
                const range = timelineData[layer.layerId];
                // 修复：确保最后一帧是100%
                const progress = totalOutputFrames > 1 ? (frameIdx / (totalOutputFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    continue; // Skip this layer for this frame
                }
            }
            allLayerPaths.push(layer.path);
          } else if (layer.type === 'annotation') {
            // Check timeline visibility for annotation layers
            if (timelineData && timelineData[layer.layerId]) {
                const range = timelineData[layer.layerId];
                // 修复：确保最后一帧是100%
                const progress = totalOutputFrames > 1 ? (frameIdx / (totalOutputFrames - 1)) * 100 : 0;
                // Debug: log first few frames
                if (frameIdx < 3) {
                  console.log(`         🕐 [时间线] 检查标注层: layerId="${layer.layerId}", progress=${progress.toFixed(1)}%, range=${range.start}%-${range.end}%`);
                }
                if (progress < range.start || progress > range.end) {
                    // Debug: log when skipping
                    if (frameIdx < 3 || frameIdx === totalOutputFrames - 1) {
                      console.log(`         🕐 [时间线] 标注层 "${layer.name}" 在帧${frameIdx} 被跳过`);
                    }
                    continue; // Skip this layer for this frame
                }
            } else if (timelineData && frameIdx === 0) {
                console.log(`         🕐 [时间线] 标注层 layerId="${layer.layerId}" 在 timelineData 中未找到匹配（将全程显示）`);
            }
            allLayerPaths.push(layer.path);
          }
        }
        
        // 4. Top Layer（兼容模式：如果没有单独的标注图层，使用合成的 annotationPath）
        if (annotationPath && annotationLayerPaths.length === 0) {
          allLayerPaths.push(annotationPath);
        }
        
        if (allLayerPaths.length === 0) {
          return;
        }
        
        if (allLayerPaths.length === 1) {
          // 只有一层，直接复制
          fs.copyFileSync(allLayerPaths[0], outputFrame);
        } else {
          // 🚀 使用单个 magick 命令一次性合成所有层，启用多线程
          let composeCmd = `magick -limit thread 0 "${allLayerPaths[0]}"`;
          for (let i = 1; i < allLayerPaths.length; i++) {
            composeCmd += ` "${allLayerPaths[i]}" -composite`;
          }
          composeCmd += ` "${outputFrame}"`;
          
          await execAsync(composeCmd, { maxBuffer: 100 * 1024 * 1024 });
        }
        
        completedFrames++;
        // 🚀 减少日志频率，降低 I/O 开销（每 50 帧或最后一帧报告一次）
        if (completedFrames % 50 === 0 || completedFrames === totalOutputFrames) {
          const progress = 30 + Math.round((completedFrames / totalOutputFrames) * 50);
          reportProgress(progress, `正在合成帧 ${completedFrames}/${totalOutputFrames}`);
        }
      };
      
      // 分批并行处理
      for (let i = 0; i < totalOutputFrames; i += PARALLEL_LIMIT) {
        const batch = [];
        for (let j = i; j < Math.min(i + PARALLEL_LIMIT, totalOutputFrames); j++) {
          batch.push(processFrame(j));
        }
        await Promise.all(batch);
      }
      
      console.log(`      合成进度: ${totalOutputFrames}/${totalOutputFrames}`)
      
      console.log(`   ✅ 所有帧已一次性完成合成（背景 + Bottom + GIF层 + Top）`);
      
      // 第六步：重组为 GIF
      endStep('Step 4 合成帧');
      startStep('Step 6 生成GIF');
      console.log(`\n   第 6 步：重组为 GIF...`);
      reportProgress(80, '正在生成最终 GIF...');
      console.log(`      输出延迟: ${outputDelay}/100秒 (${(outputDelay / 100).toFixed(3)}秒/帧)`);
      console.log(`      输出帧数: ${totalOutputFrames} 帧`);
      console.log(`      输出时长: ${maxDuration.toFixed(2)}秒`);
      console.log(`      理论帧率: ${(100 / outputDelay).toFixed(1)} fps`);
      
      // 合并生成和优化为一条命令，启用多线程加速
      // 🚀🚀🚀 优化：先快速生成 GIF，再用 gifsicle 优化（比 ImageMagick OptimizeFrame 快 10 倍）
      console.log(`      正在快速生成 GIF...`);
      
      // 第一步：生成 GIF
      // 🚀 优先使用 ffmpeg（更快），回退到 ImageMagick
      const tempGifPath = path.join(tempDir, 'temp_output.gif');
      
      // 计算 ffmpeg 需要的帧率 (outputDelay 是 1/100 秒)
      const outputFps = 100 / outputDelay;
      
      let usedFfmpeg = false;
      try {
        // 尝试用 ffmpeg 生成（速度更快）
        // -framerate: 输入帧率
        // 🎨 最优 GIF 算法：dither=none 无噪点 + stats_mode=full 全局调色板
        const palettePath = path.join(tempDir, 'palette.png');
        
        // 生成调色板（使用所有 CPU 核心）- stats_mode=full 全局调色板获得最优色彩
        const paletteCmd = `ffmpeg -threads 0 -y -framerate ${outputFps} -i "${annotatedFramesDir}/frame_%04d.png" -vf "palettegen=max_colors=256:stats_mode=full" -threads 0 "${palettePath}"`;
        await execAsync(paletteCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 60000 });
        
        // 使用调色板生成 GIF（使用所有 CPU 核心）- dither=none 无噪点平滑渐变
        const ffmpegGifCmd = `ffmpeg -threads 0 -y -framerate ${outputFps} -i "${annotatedFramesDir}/frame_%04d.png" -i "${palettePath}" -lavfi "paletteuse=dither=none:diff_mode=rectangle" -threads 0 -loop 0 "${tempGifPath}"`;
        await execAsync(ffmpegGifCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
        
        // 清理调色板
        if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
        usedFfmpeg = true;
        console.log(`      ✅ 使用 ffmpeg 生成 GIF (更快)`);
      } catch (ffmpegErr) {
        // ffmpeg 失败，回退到 ImageMagick
        console.log(`      ⚠️  ffmpeg 不可用，使用 ImageMagick 生成...`);
        // 使用 None 抖动，获得无噪点的平滑渐变效果（ImageMagick 回退方案）
        const generateCmd = `convert -limit thread 0 -delay ${outputDelay} -loop 0 "${annotatedFramesDir}/frame_*.png" -colors 256 -dither None "${tempGifPath}"`;
        await execAsync(generateCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
      }
      
      // 检查 gifsicle 是否可用
      let hasGifsicle = false;
      try {
        await execAsync('which gifsicle');
        hasGifsicle = true;
      } catch (e) {
        hasGifsicle = false;
      }
      
      // 获取临时 GIF 大小
      const tempStats = fs.statSync(tempGifPath);
      const tempSizeMB = (tempStats.size / 1024 / 1024).toFixed(2);
      console.log(`      临时 GIF 大小: ${tempSizeMB} MB`);
      
      if (hasGifsicle) {
        // 🚀 gifsicle 优化 - 使用较轻的优化级别，速度更快
        // -O2 比 -O3 快很多，效果差不多
        // 不使用 --lossy（有损压缩很慢）
        console.log(`      正在用 gifsicle 优化 GIF...`);
        const optimizeStartTime = Date.now();
        const optimizeCmd = `gifsicle -O2 "${tempGifPath}" -o "${outputPath}"`;
        try {
          await execAsync(optimizeCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
          const optimizeTime = ((Date.now() - optimizeStartTime) / 1000).toFixed(1);
          console.log(`      ✅ gifsicle 优化完成，耗时: ${optimizeTime}s`);
          // 删除临时文件
          if (fs.existsSync(tempGifPath)) {
            fs.unlinkSync(tempGifPath);
          }
        } catch (e) {
          console.log(`      ⚠️  gifsicle 优化失败: ${e.message}，使用原始 GIF`);
          fs.renameSync(tempGifPath, outputPath);
        }
      } else {
        // 没有 gifsicle，直接使用生成的 GIF
        console.log(`      ℹ️  未安装 gifsicle，跳过优化（可通过 brew install gifsicle 安装）`);
        fs.renameSync(tempGifPath, outputPath);
      }
      endStep('Step 6 生成GIF');
      
      console.log(`   ✅ GIF 已生成并优化`);
      
      // 获取最终文件大小
      const finalStats = fs.statSync(outputPath);
      const finalSizeMB = (finalStats.size / 1024 / 1024).toFixed(2);
      console.log(`      文件大小: ${finalSizeMB} MB`);
      
      // 清理所有临时文件
      reportProgress(95, '正在清理临时文件...');
      console.log(`\n   清理临时文件...`);
      
      // 清理原始 GIF 帧
      for (const gifFramesInfo of gifFramesDirs) {
        if (fs.existsSync(gifFramesInfo.dir)) {
          removeDirRecursive(gifFramesInfo.dir);
        }
      }
      
      // 清理标注帧（合并优化后只有这一个目录）
      if (fs.existsSync(annotatedFramesDir)) {
        removeDirRecursive(annotatedFramesDir);
      }
      
      console.log(`   ✅ 多 GIF 合成完成！`);
    }
    
    console.log(`✅ 合成成功！`);
    console.log(`📁 输出路径: ${outputPath}`);
    
    // 5. 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        removeDirRecursive(tempDir);
        console.log(`\n🧹 临时文件已清理`);
      }
    } catch (e) {
      console.log(`⚠️  清理临时文件失败（可忽略）: ${e.message}`);
    }
    
    // 6. 检查输出文件
    const stats = fs.statSync(outputPath);
    console.log(`📊 输出文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    console.log('\n✅ GIF 标注合成完成！\n');
    
    return {
      outputPath,
      filename: outputFilename,
      size: stats.size
    };
    
  } catch (error) {
    // ✅ 优先检查是否被取消 (如果是取消导致的命令失败，统一视为取消)
    if (error.message === 'GIF_EXPORT_CANCELLED' || (shouldCancel && shouldCancel())) {
      throw new Error('GIF_EXPORT_CANCELLED');
    }

    // 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        removeDirRecursive(tempDir);
      }
    } catch (e) {
      // 忽略清理错误
    }
    
    // 检查是否是因为缺少 ImageMagick
    // 只有当明确是命令未找到时，才提示安装
    const isCommandNotFound = error.code === 'ENOENT' || 
                             error.code === 127 ||
                             (error.message && error.message.includes('command not found'));

    if (isCommandNotFound) {
      console.error('❌ 系统无法找到 ImageMagick 命令');
      throw new Error('未找到 ImageMagick\n\n请先安装: brew install imagemagick');
    }
    
    // 如果是 ImageMagick 执行过程中的错误（比如参数不对，或者文件问题）
    if (error.message && (error.message.includes('convert') || error.message.includes('magick'))) {
      console.error('❌ ImageMagick 执行出错 (非缺失):', error.message);
      let detailedMsg = error.message.split('\n')[0];
      if (error.stderr) {
        console.error('   错误详情 (STDERR):', error.stderr);
        detailedMsg += `\nSTDERR: ${error.stderr}`;
      } else if (error.message.includes('STDERR:')) {
         // 如果 message 已经包含了 STDERR (在之前的步骤中添加的)
         detailedMsg = error.message;
      }
      
      // 不要吞掉原始错误，直接抛出，或者包装一下
      throw new Error(`GIF 处理失败 (ImageMagick): ${detailedMsg}`);
    }
    
    throw error;
  }
}

// 如果环境变量未设置，尝试从文件读取
if (!process.env.SYNC_MODE) {
  const fileMode = readSyncModeFromFile();
  if (fileMode) {
    process.env.SYNC_MODE = fileMode;
    console.log(`📋 从配置文件读取同步模式: ${fileMode}`);
  } else {
    // Cloud Run 环境默认使用 drive 模式
    process.env.SYNC_MODE = 'drive';
    console.log('📋 使用默认同步模式: drive');
  }
}

// 如果是 iCloud 模式，启动自动维护任务
if (process.env.SYNC_MODE === 'icloud') {
  startICloudMaintenance();
}

const app = express();
const server = http.createServer(app);

// 增加 HTTP server 的超时和连接限制以支持大文件上传
server.timeout = 600000; // 10分钟超时
server.keepAliveTimeout = 600000; // 10分钟keep-alive超时
server.headersTimeout = 600000; // 10分钟headers超时

// 增加全局请求日志中间件（在任何解析之前）
app.use((req, res, next) => {
  const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0;
  const contentLengthMB = (contentLength / 1024 / 1024).toFixed(2);
  const contentType = req.headers['content-type'] || 'unknown';
  console.log(`🔍 [Network] 收到请求: ${req.method} ${req.url} (Type: ${contentType}, Size: ${contentLengthMB}MB)`);
  next();
});

// 增加 WebSocket payload 大小限制以支持大文件（1GB）
const wss = new WebSocket.Server({ 
  server,
  maxPayload: 1024 * 1024 * 1024 // 1GB，支持大文件传输
});

const connections = new Map();
const cancelFlags = new Map(); // 跟踪每个连接的取消状态

// 用户实例映射（用于单实例限制）
// Key: connectionId, Value: { figmaWs, registeredAt }
const userInstances = new Map();

let DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 如果环境变量未设置，尝试从 serviceAccountKey.js 读取默认值
if (!DRIVE_FOLDER_ID) {
  try {
    const serviceAccountKey = require('./serviceAccountKey');
    if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
      DRIVE_FOLDER_ID = serviceAccountKey.defaultFolderId;
      console.log('ℹ️  使用默认的 Google Drive 根文件夹ID（从 serviceAccountKey.js）');
    }
  } catch (error) {
    // 忽略错误，继续使用环境变量
  }
}

const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || null;

// 用户文件夹缓存：userId -> folderId，减少重复查找
const userFolderCache = new Map();

// ========== 上传队列管理器（控制并发和速率） ==========
class UploadQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 20; // 增加并发数到20
    this.rateLimit = options.rateLimit || 100; // 提高速率限制到每秒100个
    this.queue = [];
    this.processing = 0;
    this.lastProcessTime = 0;
    this.minInterval = 1000 / this.rateLimit; // 最小间隔（毫秒）
    this.processedCount = 0;
    this.lastResetTime = Date.now();
    // 正在处理中的任务集合（用于快速去重检查）
    this.processingTasks = new Set();
  }

  add(task) {
    // 优化去重逻辑：只检查正在处理中的任务，不检查队列中的任务
    // 这样可以允许队列中有多个相同文件名的任务（高频上传场景）
    const taskKey = `${task.userId || 'default'}:${task.filename}`;
    
    // 如果正在处理相同的任务，跳过（避免重复上传）
    if (this.processingTasks.has(taskKey)) {
      console.log(`⏭️  [队列] 跳过重复任务（正在处理中）: ${task.filename}`);
      return;
    }

    // 记录大文件任务加入队列
    const isVideo = task.filename && (task.filename.toLowerCase().endsWith('.mp4') || task.filename.toLowerCase().endsWith('.mov'));
    const isGif = task.filename && task.filename.toLowerCase().endsWith('.gif');
    const dataSize = task.data ? (typeof task.data === 'string' ? task.data.length : JSON.stringify(task.data).length) : 0;
    const dataSizeMB = (dataSize / 1024 / 1024).toFixed(2);
    
    if (isVideo || isGif || dataSize > 10 * 1024 * 1024) {
      const fileType = isVideo ? '视频' : (isGif ? 'GIF' : '大文件');
      console.log(`📥 [队列] ${fileType}任务加入队列: ${task.filename}, Base64大小: ${dataSizeMB}MB, 用户ID: ${task.userId || '未提供'}`);
    }

    this.queue.push(task);
    const queueLength = this.queue.length;
    const waitTime = Date.now() - task.startTime;
    
    // 如果队列积压或等待时间过长，记录警告
    if (queueLength > 5) {
      console.log(`📋 [队列] 队列积压: ${queueLength} 个任务等待, 处理中: ${this.processing}, 等待时间: ${waitTime}ms`);
    }
    
    // 立即开始处理
    this.process();
  }

  async process() {
    // 如果已达到最大并发数，等待
    if (this.processing >= this.maxConcurrent) {
      return;
    }

    // 如果队列为空，返回
    if (this.queue.length === 0) {
      return;
    }

    // 从队列中取出任务（移除速率限制延迟，只保留并发控制，提高处理速度）
    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.processing++;
    this.lastProcessTime = Date.now();
    this.processedCount++;
    
    // 标记任务正在处理中（用于去重）
    const taskKey = `${task.userId || 'default'}:${task.filename}`;
    this.processingTasks.add(taskKey);

    // 异步处理任务（不阻塞队列处理）
    this.processTask(task).finally(() => {
      this.processing--;
      // 移除处理中标记
      this.processingTasks.delete(taskKey);
      // 立即继续处理队列中的下一个任务（不等待）
      setImmediate(() => this.process());
    });
  }

  async processTask(task) {
    const { userId, filename, data, mimeType, startTime, useOSS = false } = task;
    const processStartTime = Date.now();
    
    // 记录任务开始处理
    const isVideo = filename && (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'));
    const isGif = filename && filename.toLowerCase().endsWith('.gif');
    const dataSize = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
    const dataSizeMB = (dataSize / 1024 / 1024).toFixed(2);
    
    if (isVideo || isGif || dataSize > 10 * 1024 * 1024) {
      const fileType = isVideo ? '视频' : (isGif ? 'GIF' : '大文件');
      const waitTime = processStartTime - startTime;
      console.log(`🔄 [队列] 开始处理${fileType}任务: ${filename}, Base64大小: ${dataSizeMB}MB, 等待时间: ${waitTime}ms`);
    }
    
    // 提前声明变量，确保在 catch 块中可访问
    // 使用 var 而不是 let，确保变量在整个函数作用域内可用（包括所有嵌套块）
    var targetFolderId = null;
    var buffer = null;
    var finalFilename = filename;
    
    try {
      // 优化：先解析 Base64 字符串（只解析一次）
      let base64String = data;
      let detectedMime = mimeType;
      const dataUrlMatch = /^data:(.+);base64,(.*)$/.exec(base64String);
      if (dataUrlMatch) {
        detectedMime = detectedMime || dataUrlMatch[1];
        base64String = dataUrlMatch[2];
      }
      detectedMime = detectedMime || 'image/jpeg';
      
      // 并行处理：同时进行文件夹查找和 Base64 解码
      // 注意：使用 Promise.allSettled 而不是 Promise.all，确保即使一个失败也能获取另一个的结果
      // targetFolderId 和 buffer 已在函数开头声明
      try {
        const results = await Promise.allSettled([
          // 1. 查找/创建用户文件夹（如果提供了用户ID）
          (async () => {
          if (useOSS) {
            // 使用阿里云
            if (userId && ossInitializeUserFolderForUpload) {
              try {
                return await ossInitializeUserFolderForUpload(userId);
              } catch (error) {
                console.error(`⚠️  [OSS上传] 创建用户文件夹失败: ${error.message}`);
                const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
                return OSS_ROOT_FOLDER;
              }
            }
            const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
            return OSS_ROOT_FOLDER;
          } else {
            // 使用 Google Drive
            if (userId && initializeUserFolderForUpload) {
              try {
                return await initializeUserFolderForUpload(userId);
              } catch (error) {
                console.error(`⚠️  [上传] 创建用户文件夹失败，使用共享文件夹: ${error.message}`);
                // 确保 DRIVE_FOLDER_ID 有值
                let folderId = DRIVE_FOLDER_ID;
                if (!folderId) {
                  try {
                    const serviceAccountKey = require('./serviceAccountKey');
                    if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                      folderId = serviceAccountKey.defaultFolderId;
                    }
                  } catch (e) {
                    // 忽略错误
                  }
                }
                if (!folderId) {
                  console.error(`❌ [上传] 严重错误：无法获取 GDRIVE_FOLDER_ID (环境变量和配置文件都为空)`);
                  throw new Error('未配置 GDRIVE_FOLDER_ID，无法上传文件');
                }
                return folderId;
              }
            }
            // 确保 DRIVE_FOLDER_ID 有值
            let folderId = DRIVE_FOLDER_ID;
            if (!folderId) {
              try {
                const serviceAccountKey = require('./serviceAccountKey');
                if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                  folderId = serviceAccountKey.defaultFolderId;
                }
              } catch (e) {
                // 忽略错误
              }
            }
            if (!folderId) {
              console.error(`❌ [上传] 严重错误：无法获取 GDRIVE_FOLDER_ID (环境变量和配置文件都为空)`);
              throw new Error('未配置 GDRIVE_FOLDER_ID，无法上传文件');
            }
            return folderId;
          }
        })(),
        // 2. Base64 解码（CPU 密集型操作）
        // 优化：使用 setImmediate 避免阻塞事件循环，提高响应速度
        // 对于大文件（GIF/视频），添加超时和内存保护
        (async () => {
          return new Promise((resolve, reject) => {
            const decodeStartTime = Date.now();
            const base64Length = base64String ? base64String.length : 0;
            const estimatedSizeMB = (base64Length * 0.75 / 1024 / 1024).toFixed(2);
            const estimatedSizeBytes = Math.floor(base64Length * 0.75);
            
            // 提前检测文件大小，避免内存不足
            const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB 限制（Base64 解码后）
            if (estimatedSizeBytes > MAX_FILE_SIZE) {
              const errorMsg = `文件过大 (估算 ${estimatedSizeMB}MB)，超过限制 (${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB)。请减小文件大小或使用分块上传。`;
              console.error(`   ❌ [Base64解码] ${errorMsg}`);
              return reject(new Error(errorMsg));
            }
            
            // 动态计算超时时间：大文件需要更长时间
            // 基础超时：30秒，每MB增加1秒，最大10分钟
            const timeoutMs = Math.min(
              600000, // 最大10分钟
              Math.max(30000, estimatedSizeBytes / 1024 / 1024 * 1000) // 每MB 1秒，最小30秒
            );
            
            // 设置超时
            const timeoutId = setTimeout(() => {
              const decodeTime = Date.now() - decodeStartTime;
              const errorMsg = `Base64 解码超时 (${(timeoutMs / 1000).toFixed(0)}秒)，文件可能过大或系统资源不足。估算大小: ${estimatedSizeMB}MB`;
              console.error(`   ❌ [Base64解码] ${errorMsg} (已耗时: ${(decodeTime / 1000).toFixed(1)}秒)`);
              reject(new Error(errorMsg));
            }, timeoutMs);
            
            if (base64Length > 10 * 1024 * 1024) {
              console.log(`   🔄 [Base64解码] 开始解码大文件: 估算大小 ${estimatedSizeMB}MB, Base64长度: ${(base64Length / 1024 / 1024).toFixed(2)}MB, 超时: ${(timeoutMs / 1000).toFixed(0)}秒`);
            }
            
            // 监控内存使用（如果可用）
            let initialMemoryUsage = null;
            try {
              initialMemoryUsage = process.memoryUsage();
            } catch (e) {
              // 忽略错误
            }
            
            setImmediate(() => {
              try {
                // 检查可用内存（如果文件很大）
                if (estimatedSizeBytes > 50 * 1024 * 1024 && initialMemoryUsage) {
                  try {
                    const currentMemory = process.memoryUsage();
                    const availableHeap = currentMemory.heapTotal - currentMemory.heapUsed;
                    const requiredMemory = estimatedSizeBytes * 2; // 需要2倍空间（解码前后）
                    
                    if (availableHeap < requiredMemory) {
                      const errorMsg = `内存不足：需要约 ${(requiredMemory / 1024 / 1024).toFixed(0)}MB，但可用内存仅 ${(availableHeap / 1024 / 1024).toFixed(0)}MB。请增加 Node.js 内存限制（使用 --max-old-space-size 参数）或减小文件大小。`;
                      console.error(`   ❌ [Base64解码] ${errorMsg}`);
                      clearTimeout(timeoutId);
                      return reject(new Error(errorMsg));
                    }
                  } catch (e) {
                    // 忽略内存检查错误，继续尝试解码
                  }
                }
                
                const buffer = Buffer.from(base64String, 'base64');
                clearTimeout(timeoutId);
                const decodeTime = Date.now() - decodeStartTime;
                
                // 记录内存使用情况（如果文件很大）
                if (buffer.length > 10 * 1024 * 1024) {
                  try {
                    const finalMemory = process.memoryUsage();
                    const memoryUsedMB = ((finalMemory.heapUsed - (initialMemoryUsage?.heapUsed || 0)) / 1024 / 1024).toFixed(2);
                    console.log(`   ✅ [Base64解码] 解码完成: ${(buffer.length / 1024 / 1024).toFixed(2)}MB, 耗时: ${decodeTime}ms, 内存使用: ${memoryUsedMB}MB`);
                  } catch (e) {
                    console.log(`   ✅ [Base64解码] 解码完成: ${(buffer.length / 1024 / 1024).toFixed(2)}MB, 耗时: ${decodeTime}ms`);
                  }
                }
                
                // 对于视频文件，验证解码后的 buffer 是否有效
                const isVideo = detectedMime && detectedMime.toLowerCase().startsWith('video/');
                if (isVideo && buffer.length > 0) {
                  // 检查 MOV 文件格式（QuickTime）
                  if (detectedMime.toLowerCase() === 'video/quicktime') {
                    const fileHeader = buffer.slice(0, 12).toString('ascii');
                    const isValidMOV = fileHeader.includes('ftyp') || 
                                      fileHeader.includes('moov') || 
                                      fileHeader.includes('mdat') ||
                                      buffer.slice(4, 8).toString('ascii').includes('qt');
                    
                    if (!isValidMOV) {
                      console.log(`   ⚠️  [Base64解码] 警告：解码后的 MOV 文件可能无效`);
                      console.log(`   ⚠️  文件头（hex）: ${buffer.slice(0, 16).toString('hex')}`);
                      console.log(`   ⚠️  文件头（ASCII）: ${fileHeader}`);
                      console.log(`   ⚠️  文件大小: ${(buffer.length / 1024).toFixed(2)}KB`);
                    } else {
                      console.log(`   ✅ [Base64解码] MOV 文件格式验证通过`);
                    }
                  }
                  
                  // 检查 MP4 文件格式
                  if (detectedMime.toLowerCase() === 'video/mp4') {
                    const fileHeader = buffer.slice(0, 12).toString('ascii');
                    const isValidMP4 = fileHeader.includes('ftyp') || buffer.slice(4, 8).toString('ascii').includes('mp4');
                    
                    if (!isValidMP4) {
                      console.log(`   ⚠️  [Base64解码] 警告：解码后的 MP4 文件可能无效`);
                      console.log(`   ⚠️  文件头（hex）: ${buffer.slice(0, 16).toString('hex')}`);
                      console.log(`   ⚠️  文件头（ASCII）: ${fileHeader}`);
                    } else {
                      console.log(`   ✅ [Base64解码] MP4 文件格式验证通过`);
                    }
                  }
                }
                
                resolve(buffer);
              } catch (err) {
                clearTimeout(timeoutId);
                const decodeTime = Date.now() - decodeStartTime;
                
                // 检查是否是内存相关错误
                let errorMsg = err.message;
                if (err.message.includes('out of memory') || err.message.includes('Cannot allocate memory') || err.code === 'ERR_OUT_OF_RANGE') {
                  errorMsg = `内存不足：无法解码 ${estimatedSizeMB}MB 的文件。请增加 Node.js 内存限制（使用 --max-old-space-size=4096 参数）或减小文件大小。原始错误: ${err.message}`;
                }
                
                console.error(`   ❌ [Base64解码] 解码失败 (耗时: ${(decodeTime / 1000).toFixed(1)}秒): ${errorMsg}`);
                if (err.stack && !err.message.includes('out of memory')) {
                  console.error(`   错误堆栈:`, err.stack.split('\n').slice(0, 3).join('\n'));
                }
                reject(new Error(errorMsg));
              }
            });
          });
        })()
        ]);
        
        // 处理 Promise.allSettled 的结果
        const [folderResult, bufferResult] = results;
        
        // 处理文件夹ID结果
        if (folderResult.status === 'fulfilled') {
          targetFolderId = folderResult.value;
        } else {
          console.error(`   ❌ [上传] 获取文件夹ID失败: ${folderResult.reason?.message || folderResult.reason}`);
          // 尝试获取默认文件夹ID
          if (useOSS) {
            targetFolderId = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
          } else {
            targetFolderId = DRIVE_FOLDER_ID;
            if (!targetFolderId) {
              try {
                const serviceAccountKey = require('./serviceAccountKey');
                if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                  targetFolderId = serviceAccountKey.defaultFolderId;
                }
              } catch (e) {
                // 忽略错误
              }
            }
          }
        }
        
        // 处理Base64解码结果
        if (bufferResult.status === 'fulfilled') {
          buffer = bufferResult.value;
        } else {
          console.error(`   ❌ [上传] Base64解码失败: ${bufferResult.reason?.message || bufferResult.reason}`);
          throw new Error(`Base64 解码失败: ${bufferResult.reason?.message || bufferResult.reason}`);
        }
      } catch (promiseError) {
        // 如果 Promise.allSettled 本身失败（不应该发生，但为了安全）
        console.error(`   ❌ [上传] Promise.allSettled 异常: ${promiseError.message}`);
        
        // 确保 targetFolderId 已定义（防止 ReferenceError）
        if (typeof targetFolderId === 'undefined' || targetFolderId === null) {
          // 尝试获取默认文件夹ID
          try {
            if (useOSS) {
              targetFolderId = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
            } else {
              targetFolderId = DRIVE_FOLDER_ID;
              if (!targetFolderId) {
                try {
                  const serviceAccountKey = require('./serviceAccountKey');
                  if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                    targetFolderId = serviceAccountKey.defaultFolderId;
                  }
                } catch (e) {
                  // 忽略错误
                }
              }
            }
            // 如果仍然没有值，使用默认值
            if (typeof targetFolderId === 'undefined' || targetFolderId === null) {
              targetFolderId = useOSS ? 'ScreenSync' : '未知';
            }
          } catch (e) {
            // 如果获取失败，使用默认值
            targetFolderId = useOSS ? 'ScreenSync' : '未知';
          }
        }
        // 重新抛出错误，让外层 catch 处理
        throw promiseError;
      }

      // 验证 targetFolderId 和 buffer 都已定义
      if (!targetFolderId) {
        throw new Error('无法获取目标文件夹ID');
      }
      if (!buffer) {
        throw new Error('Base64 解码失败');
      }

      // 清理 Base64 字符串，释放内存（解码完成后不再需要）
      base64String = null;

      // 处理图片格式：检测并转换 HEIF/HEIC 格式为 JPEG
      // 因为 Google Drive 对 HEIF 格式支持有限，转换为 JPEG 更通用且文件更小
      let finalBuffer = buffer;
      let finalMimeType = detectedMime;
      let originalSize = buffer.length;
      
      try {
        // 检测是否为 HEIF/HEIC 格式（iPhone 快捷指令发送的格式）
        const isHeif = detectedMime && (
          detectedMime.toLowerCase().includes('heif') || 
          detectedMime.toLowerCase().includes('heic')
        );
        
        if (isHeif) {
          // 使用 sharp 将 HEIF 转换为 JPEG 格式
          const sharpImage = sharp(buffer);
          
          // 转换为 JPEG 格式（统一格式，减小文件大小，提高兼容性）
          finalBuffer = await sharpImage
            .resize(1920, null, {
              withoutEnlargement: true,
              fit: 'inside'
            })
            .jpeg({ quality: 85 })
            .toBuffer();
          
          finalMimeType = 'image/jpeg';
          
          const compressedSize = finalBuffer.length;
          if (compressedSize < originalSize) {
            const savedKB = ((originalSize - compressedSize) / 1024).toFixed(1);
            console.log(`   🖼️  [格式转换] HEIF → JPEG: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB (节省 ${savedKB}KB)`);
          } else {
            console.log(`   🖼️  [格式转换] HEIF → JPEG: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB`);
          }
          
          // 释放原始 buffer 内存
          buffer = null;
        }
      } catch (error) {
        // 如果图片处理失败，使用原始 buffer
        console.log(`   ⚠️  [格式转换] HEIF 处理失败，使用原始格式: ${error.message}`);
        finalBuffer = buffer;
        // 保持用户提供的 mimeType
        finalMimeType = detectedMime;
      }

      // 检查是否是视频文件
      const isVideo = finalMimeType && (
        finalMimeType.toLowerCase().startsWith('video/') ||
        filename.toLowerCase().endsWith('.mp4') ||
        filename.toLowerCase().endsWith('.mov')
      );
      
      if (isVideo) {
        console.log(`🎥 [上传] 检测到视频文件: ${filename} (${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB, MIME: ${finalMimeType})`);
      }

      // 确保文件名包含正确的扩展名（对 Google Drive 和 OSS 都适用）
      // finalFilename 已在函数开头声明，这里直接使用
      finalFilename = filename;
      const hasExtension = /\.\w+$/.test(filename);
      if (!hasExtension && finalMimeType) {
        // 根据 MIME 类型添加扩展名
        const mimeToExt = {
          'image/jpeg': '.jpg',
          'image/jpg': '.jpg',
          'image/png': '.png',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/heic': '.heic',
          'image/heif': '.heif',
          'video/mp4': '.mp4',
          'video/quicktime': '.mov',
          'video/x-m4v': '.mov'
        };
        const ext = mimeToExt[finalMimeType.toLowerCase()];
        if (ext) {
          finalFilename = filename + ext;
          const serviceName = useOSS ? 'OSS' : 'Drive';
          console.log(`   ℹ️  [${serviceName}上传] 文件名已添加扩展名: ${filename} → ${finalFilename}`);
        }
      } else if (hasExtension && isVideo) {
        // 对于视频文件，确保扩展名与 MIME 类型匹配
        const currentExt = filename.toLowerCase().substring(filename.lastIndexOf('.'));
        const mimeToExt = {
          'video/mp4': '.mp4',
          'video/quicktime': '.mov',
          'video/x-m4v': '.mov'
        };
        const expectedExt = mimeToExt[finalMimeType.toLowerCase()];
        if (expectedExt && currentExt !== expectedExt) {
          // 扩展名不匹配，修正扩展名
          const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
          finalFilename = nameWithoutExt + expectedExt;
          const serviceName = useOSS ? 'OSS' : 'Drive';
          console.log(`   ⚠️  [${serviceName}上传] 视频文件扩展名不匹配，已修正: ${filename} → ${finalFilename} (MIME: ${finalMimeType})`);
        }
      }

      // 再次验证 targetFolderId（防止在上传前被意外修改）
      if (!targetFolderId) {
        console.error(`   ⚠️  [上传] 警告：targetFolderId 在上传前为空，尝试重新获取...`);
        if (useOSS) {
          targetFolderId = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
        } else {
          targetFolderId = DRIVE_FOLDER_ID;
          if (!targetFolderId) {
            try {
              const serviceAccountKey = require('./serviceAccountKey');
              if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                targetFolderId = serviceAccountKey.defaultFolderId;
              }
            } catch (e) {
              // 忽略错误
            }
          }
        }
        if (!targetFolderId) {
          throw new Error('无法获取目标文件夹ID，无法上传文件');
        }
        console.log(`   ✅ [上传] 已重新获取 targetFolderId: ${targetFolderId}`);
      }

      // 如果是大文件（视频/GIF），先保存到本地并通知插件，提高响应速度
      // 这样用户不需要等待云端同步完成就可以开始手动导入
      if ((isVideo || isGif) && finalBuffer) {
        console.log(`   ⚡ [加速] 正在保存大文件到本地，以便快速手动导入...`);
        const saved = saveFileToLocalFolder(finalBuffer, finalFilename, finalMimeType);
        if (saved) {
          // 广播给所有 Figma 客户端
          for (const [id, group] of connections) {
            if (group.figma && group.figma.readyState === WebSocket.OPEN) {
              group.figma.send(JSON.stringify({
                type: 'file-skipped',
                filename: finalFilename,
                reason: isVideo ? 'video' : 'gif-too-large',
                timestamp: Date.now()
              }));
            }
          }
          console.log(`   📨 [加速] 已通知插件手动导入`);
        }
      }
      
      // 上传到 Google Drive 或阿里云
      const uploadStartTime = Date.now();
      let result;
      
      if (useOSS) {
        console.log(`📤 [OSS上传] 开始上传到 OSS: ${finalFilename} → 文件夹 ${targetFolderId}`);
        result = await ossUploadBuffer({
          buffer: finalBuffer,
          filename: finalFilename,
          mimeType: finalMimeType,
          folderId: targetFolderId
        });
      } else {
        console.log(`📤 [上传] 开始上传到 Drive: ${finalFilename} → 文件夹 ${targetFolderId}`);
        result = await uploadBuffer({
          buffer: finalBuffer,
          filename: finalFilename,
          mimeType: finalMimeType,
          folderId: targetFolderId
        });
      }

      const uploadDuration = Date.now() - uploadStartTime;
      const processDuration = Date.now() - processStartTime;
      const totalDuration = Date.now() - startTime;
      
      // 记录上传成功日志
      const fileSizeMB = (finalBuffer.length / 1024 / 1024).toFixed(2);
      const fileSizeKB = (finalBuffer.length / 1024).toFixed(1);
      const serviceName = useOSS ? 'OSS' : 'Drive';
      const logFilename = useOSS ? finalFilename : filename;
      
      if (isVideo) {
        console.log(`✅ [${serviceName}上传] 视频文件上传成功: ${logFilename} (${fileSizeMB}MB, 处理:${processDuration}ms, 上传:${uploadDuration}ms, 总计:${totalDuration}ms, 文件ID: ${result.id || 'N/A'})`);
      } else if (uploadDuration > 2000 || processDuration > 3000 || totalDuration > 4000) {
        console.log(`✅ [${serviceName}上传] ${logFilename} → ${serviceName} (${fileSizeKB}KB, 处理:${processDuration}ms, 上传:${uploadDuration}ms, 总计:${totalDuration}ms, 文件ID: ${result.id || 'N/A'})`);
      } else {
        // 简短的成功日志
        console.log(`✅ [${serviceName}上传] ${logFilename} (${fileSizeKB}KB, 文件ID: ${result.id || 'N/A'})`);
      }
      
      // 立即释放 buffer 内存
      finalBuffer = null;
    } catch (error) {
      // 确保 targetFolderId 有值（如果之前没有获取到）
      // 这是最后的保护措施，确保错误日志中始终有 folderId
      // 使用 typeof 检查，防止 ReferenceError
      let safeTargetFolderId;
      try {
        // 先尝试安全地访问 targetFolderId
        if (typeof targetFolderId !== 'undefined' && targetFolderId !== null) {
          safeTargetFolderId = targetFolderId;
        } else {
          // 如果未定义或为 null，尝试获取默认值
          throw new Error('targetFolderId is null or undefined');
        }
      } catch (e) {
        // 如果访问失败或值为 null/undefined，获取默认值
        try {
          if (useOSS) {
            safeTargetFolderId = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
          } else {
            safeTargetFolderId = DRIVE_FOLDER_ID;
            if (!safeTargetFolderId) {
              try {
                const serviceAccountKey = require('./serviceAccountKey');
                if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                  safeTargetFolderId = serviceAccountKey.defaultFolderId;
                }
              } catch (e2) {
                // 忽略错误
              }
            }
          }
          // 如果仍然没有值，使用默认值
          if (!safeTargetFolderId) {
            safeTargetFolderId = useOSS ? 'ScreenSync' : '未知';
          }
          // 同时更新 targetFolderId 变量（如果可能）
          try {
            targetFolderId = safeTargetFolderId;
          } catch (e3) {
            // 如果无法更新，忽略
          }
        } catch (e4) {
          // 如果获取失败，使用默认值
            safeTargetFolderId = useOSS ? 'ScreenSync' : '未知';
        }
      }
      
      const serviceName = useOSS ? 'OSS上传' : '上传';
      const errorFilename = useOSS ? (typeof finalFilename !== 'undefined' ? finalFilename : filename) : filename;
      const totalTime = Date.now() - startTime;
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        filename: errorFilename,
        userId,
        mimeType,
        folderId: safeTargetFolderId || '未知',
        totalTime: `${totalTime}ms`
      };
      console.error(`❌ [${serviceName}] ${errorFilename} 失败 (总耗时: ${totalTime}ms):`, errorDetails);
      
      // 对于大文件（视频、GIF或大于10MB），提供更详细的错误信息
      const isVideo = filename && (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'));
      const isGif = filename && filename.toLowerCase().endsWith('.gif');
      const dataSize = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
      
      if (isVideo || isGif || dataSize > 10 * 1024 * 1024) {
        const fileType = isVideo ? '视频' : (isGif ? 'GIF' : '大文件');
        console.error(`   📊 ${fileType}文件上传失败详情:`);
        console.error(`      - 文件名: ${filename}`);
        console.error(`      - MIME类型: ${mimeType || '未提供'}`);
        console.error(`      - 用户ID: ${userId || '未提供'}`);
        // 安全地访问 targetFolderId，防止 ReferenceError
        let safeFolderIdForLog = '未知';
        try {
          if (typeof targetFolderId !== 'undefined' && targetFolderId !== null) {
            safeFolderIdForLog = targetFolderId;
          } else if (typeof safeTargetFolderId !== 'undefined') {
            safeFolderIdForLog = safeTargetFolderId;
          }
        } catch (e) {
          // 忽略错误，使用默认值
        }
        console.error(`      - 目标文件夹ID: ${safeFolderIdForLog}`);
        console.error(`      - Base64数据大小: ${(dataSize / 1024 / 1024).toFixed(2)}MB`);
        console.error(`      - 总耗时: ${totalTime}ms`);
        console.error(`      - 错误信息: ${error.message}`);
        if (error.stack) {
          console.error(`      - 堆栈: ${error.stack.split('\n').slice(0, 5).join('\n')}`);
        }
      }
    }
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      processedCount: this.processedCount
    };
  }
}

// 创建上传队列实例
const uploadQueue = new UploadQueue({
  // 降低并发数以提高稳定性（特别是在 LaunchAgent 后台模式下）
  // 之前的 10 并发可能导致资源竞争或被系统限制
  maxConcurrent: 2, 
  rateLimit: 10 // 降低速率限制
});

// 添加请求日志中间件（在body parser之前，用于追踪大文件请求）
app.use((req, res, next) => {
  // 只记录POST请求，特别是上传接口
  if (req.method === 'POST' && (req.path === '/upload' || req.path === '/upload-oss')) {
    const startTime = Date.now();
    const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0;
    const contentLengthMB = (contentLength / 1024 / 1024).toFixed(2);
    const userId = req.headers['x-user-id'] || '未提供';
    
    console.log(`📨 [请求] ${req.method} ${req.path} - Content-Length: ${contentLengthMB}MB, 用户ID: ${userId}`);
    
    // 监听请求完成或错误
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      console.log(`   ✅ [请求] ${req.path} 完成 - 状态: ${res.statusCode}, 耗时: ${duration}ms`);
    });
    
    res.on('close', () => {
      const duration = Date.now() - startTime;
      if (!res.headersSent) {
        console.log(`   ⚠️  [请求] ${req.path} 连接关闭（未发送响应）- 耗时: ${duration}ms`);
      }
    });
    
    // 监听请求错误
    req.on('error', (error) => {
      console.error(`   ❌ [请求] ${req.path} 请求错误:`, error.message);
    });
  }
  next();
});

// 优化 JSON 解析：使用更快的解析器，并设置合理的超时
// 注意：Base64 编码会增加约 33% 的大小，所以需要足够大的限制
// 对于大文件，大幅增加限制以支持大视频文件（100MB视频Base64后约133MB，JSON整体可能更大）
app.use(express.json({ 
  limit: '1024mb', // 增加到 1024MB 以支持大视频文件
  strict: false, // 允许非严格 JSON（更快）
  type: ['application/json', 'text/plain', '*/*'], // 宽容模式：尝试解析所有类型的请求体为JSON
  verify: (req, res, buf, encoding) => {
    // 在解析前记录大请求
    if (buf && buf.length > 10 * 1024 * 1024) {
      const sizeMB = (buf.length / 1024 / 1024).toFixed(2);
      console.log(`   📦 [Body Parser] 开始解析大请求体: ${sizeMB}MB`);
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1024mb' }));

// 添加 raw body parser 作为后备，处理非标准 Content-Type 或 JSON 解析失败的情况
app.use((req, res, next) => {
  // 如果 body 已经被解析，跳过
  if (req.body && Object.keys(req.body).length > 0) {
    return next();
  }
  
  // 只处理 POST 请求且是上传接口
  if (req.method === 'POST' && (req.path === '/upload' || req.path === '/upload-oss')) {
    console.log('   ⚠️  [Body Parser] 尝试使用 Raw 解析器作为后备');
    
    // 手动收集数据流
    let data = [];
    let size = 0;
    
    req.on('data', (chunk) => {
      data.push(chunk);
      size += chunk.length;
    });
    
    req.on('end', () => {
      if (size === 0) return next();
      
      const buffer = Buffer.concat(data);
      const sizeMB = (size / 1024 / 1024).toFixed(2);
      console.log(`   📦 [Raw Parser] 接收到原始数据: ${sizeMB}MB`);
      
      try {
        // 尝试将 Buffer 转换为字符串并解析 JSON
        const jsonString = buffer.toString('utf8');
        req.body = JSON.parse(jsonString);
        console.log('   ✅ [Raw Parser] 成功手动解析 JSON');
      } catch (e) {
        console.error('   ❌ [Raw Parser] 手动解析 JSON 失败:', e.message);
        // 如果只是部分有效，也许可以提取关键信息（这比较危险，暂不处理）
      }
      next();
    });
    
    req.on('error', (err) => {
      console.error('   ❌ [Raw Parser] 接收数据流错误:', err.message);
      next(err);
    });
  } else {
    next();
  }
});

// 设置请求超时，大文件上传需要更长时间
app.use((req, res, next) => {
  req.setTimeout(600000); // 增加到600秒（10分钟）以支持大文件上传
  res.setTimeout(600000);
  next();
});

// 添加错误处理中间件，捕获body parser错误
app.use((err, req, res, next) => {
  // 捕获所有类型的body parser错误
  if (err.status === 400 && 'body' in err) {
    const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0;
    const contentLengthMB = (contentLength / 1024 / 1024).toFixed(2);
    const userId = req.headers['x-user-id'] || '未提供';
    
    console.error(`❌ [Body Parser] JSON解析失败: ${err.message}`);
    console.error(`   - 请求路径: ${req.path}`);
    console.error(`   - Content-Length: ${contentLengthMB}MB`);
    console.error(`   - 用户ID: ${userId}`);
    console.error(`   - 错误类型: ${err.type || err.name || 'unknown'}`);
    console.error(`   - 错误详情: ${err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : err.message}`);
    
    // 如果是大文件，提供额外提示
    if (contentLength > 10 * 1024 * 1024) {
      console.error(`   💡 提示：大文件Base64编码可能导致JSON解析失败`);
      console.error(`   💡 建议：检查iPhone快捷指令的Base64编码设置（尝试使用"有换行"模式）`);
    }
    
    return res.status(400).json({ error: 'Invalid JSON', message: err.message });
  }
  
  // 捕获其他错误
  if (err) {
    console.error(`❌ [Express错误] ${err.message}`);
    console.error(`   - 请求路径: ${req.path}`);
    console.error(`   - 错误类型: ${err.name || 'unknown'}`);
  }
  
  next(err);
});

console.log('🚀 服务器启动\n');

// 启动时清理所有旧的临时文件夹
console.log('🧹 清理旧的临时文件夹...');
cleanupAllTempFolders();
console.log('');

// 健康检查端点（Cloud Run 需要）
app.get('/health', (req, res) => {
  try {
  const queueStats = uploadQueue ? uploadQueue.getStats() : null;
    res.status(200).json({ 
    status: 'ok',
    connections: connections.size,
    googleDriveEnabled,
    uploadQueue: queueStats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 根路径也返回健康状态（Cloud Run 健康检查可能使用根路径）
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    service: 'ScreenSync Server',
    timestamp: new Date().toISOString()
  });
});

// ... rest of the file (WebSocket handlers) ...
// The previous read_file showed the WebSocket handlers, I will append them back.
// Wait, read_file didn't show the rest because it truncated? No, it showed lines 1237 onwards.
// I need to include the rest of the file from line 1022 to the end.

// 阿里云上传接口（可选）
if (aliyunOSSEnabled && ossUploadBuffer) {
  app.post('/upload-oss', async (req, res) => {
    const startTime = Date.now();
    const parseStartTime = Date.now();
    const userId = req.headers['x-user-id'] || req.body.userId || null;
    
    // ========================================
    // ✅ 安全检查：拒绝上传到根目录
    //    必须提供 userId，文件只能上传到用户专属子文件夹
    // ========================================
    if (!userId) {
      console.warn(`🚫 [OSS上传接口] 拒绝：未提供用户ID，不允许上传到根目录`);
      return res.status(403).json({ 
        error: 'User ID required. Uploads to root folder are not allowed.',
        code: 'USER_ID_REQUIRED'
      });
    }
    
    try {
      const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
      
      if (!OSS_ROOT_FOLDER) {
        return res.status(500).json({ error: 'Server not configured: missing ALIYUN_ROOT_FOLDER' });
      }

      if (UPLOAD_TOKEN) {
        const token = req.headers['x-upload-token'];
        if (token !== UPLOAD_TOKEN) {
          return res.status(401).json({ error: 'Invalid upload token' });
        }
      }

      const parseTime = Date.now() - parseStartTime;
      if (parseTime > 500) {
        console.log(`⚠️  [OSS上传] JSON 解析耗时: ${parseTime}ms`);
      }

      const body = req.body || {};
      const filename = body.filename;
      const data = body.data;
      const mimeType = body.mimeType;
      
      const isVideo = filename && (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'));
      const isGif = filename && filename.toLowerCase().endsWith('.gif');
      const isLargeFile = isVideo || isGif;
      
      if (isLargeFile) {
        const dataLength = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
        const dataSizeMB = (dataLength / 1024 / 1024).toFixed(2);
        const fileType = isVideo ? '视频' : 'GIF';
        console.log(`📥 [OSS接收] ${fileType}文件上传请求: ${filename}, 用户ID: ${userId || '未提供'}, MIME: ${mimeType || '未提供'}, Base64数据大小: ${dataSizeMB}MB`);
        
        const estimatedOriginalSizeMB = (dataLength * 0.75 / 1024 / 1024).toFixed(2);
        console.log(`   📊 估算原始文件大小: ${estimatedOriginalSizeMB}MB`);
        
        if (dataLength > 800 * 1024 * 1024) {
          console.warn(`   ⚠️  警告：Base64 数据大小 (${dataSizeMB}MB) 接近 1GB 限制，可能导致上传失败`);
        }
      }
      
      if (!filename || !data) {
        console.error(`❌ [OSS上传] 请求参数缺失: filename=${!!filename}, data=${!!data}, userId=${userId || '未提供'}, mimeType=${mimeType || '未提供'}`);
        return res.status(400).json({ error: 'Missing filename or data' });
      }

      res.json({
        success: true,
        message: 'Upload queued',
        filename: filename
      });

      const responseTime = Date.now() - startTime;
      
      if (responseTime > 100) {
        console.log(`📤 [OSS上传] ${userId || '未知用户'} - ${filename} (响应: ${responseTime}ms)`);
      }

      process.nextTick(() => {
        uploadQueue.add({
          userId,
          filename,
          data,
          mimeType: body.mimeType,
          startTime,
          useOSS: true // 标记使用 OSS
        });
      });
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`❌ [OSS上传] 处理失败 (${errorTime}ms):`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Upload failed' });
      }
    }
  });
  console.log('✅ 阿里云上传接口已启用: POST /upload-oss');
} else {
  console.log('ℹ️  阿里云上传接口未启用');
}

// Google Drive 上传接口（可选）
if (googleDriveEnabled && uploadBuffer) {
  app.post('/upload', async (req, res) => {
    const startTime = Date.now();
    const parseStartTime = Date.now();
    const userId = req.headers['x-user-id'] || req.body.userId || null;
    
    // 记录请求到达（在body解析之前）
    const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0;
    const contentLengthMB = (contentLength / 1024 / 1024).toFixed(2);
    console.log(`📥 [上传接口] 请求到达 - Content-Length: ${contentLengthMB}MB, 用户ID: ${userId || '未提供'}`);
    
    // ========================================
    // ✅ 安全检查：拒绝上传到根目录
    //    必须提供 userId，文件只能上传到用户专属子文件夹
    // ========================================
    if (!userId) {
      console.warn(`🚫 [上传接口] 拒绝：未提供用户ID，不允许上传到根目录`);
      return res.status(403).json({ 
        error: 'User ID required. Uploads to root folder are not allowed.',
        code: 'USER_ID_REQUIRED'
      });
    }
    
    // 检查请求体是否已解析
    if (!req.body || Object.keys(req.body).length === 0) {
      console.warn(`   ⚠️  [上传接口] 警告：请求体为空或未解析`);
      console.warn(`   💡 可能原因：`);
      console.warn(`      1. Body parser解析失败（检查上面的错误日志）`);
      console.warn(`      2. 请求体过大导致解析超时`);
      console.warn(`      3. iPhone快捷指令发送失败（Base64字符串过大，建议使用"有换行"模式）`);
    }
    
    try {
      // 快速验证（在返回响应之前只做必要检查，最小化验证时间）
      // 如果 DRIVE_FOLDER_ID 未设置，尝试从 serviceAccountKey.js 读取默认值
      let currentDriveFolderId = DRIVE_FOLDER_ID;
      if (!currentDriveFolderId) {
        try {
          const serviceAccountKey = require('./serviceAccountKey');
          if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
            currentDriveFolderId = serviceAccountKey.defaultFolderId;
          }
        } catch (error) {
          // 忽略错误
        }
      }
      
      if (!currentDriveFolderId) {
        return res.status(500).json({ error: 'Server not configured: missing GDRIVE_FOLDER_ID' });
      }

      if (UPLOAD_TOKEN) {
        const token = req.headers['x-upload-token'];
        if (token !== UPLOAD_TOKEN) {
          return res.status(401).json({ error: 'Invalid upload token' });
        }
      }

      // 记录 JSON 解析时间（用于诊断）
      const parseTime = Date.now() - parseStartTime;
      if (parseTime > 500) {
        console.log(`⚠️  [上传] JSON 解析耗时: ${parseTime}ms`);
      }

      // 快速检查请求体（不解析完整 JSON，只检查必要字段）
      const body = req.body || {};
      const filename = body.filename;
      const data = body.data;
      const mimeType = body.mimeType;
      
      // 记录请求信息（用于调试大文件：视频和 GIF）
      const isVideo = filename && (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'));
      const isGif = filename && filename.toLowerCase().endsWith('.gif');
      const isLargeFile = isVideo || isGif;
      
      if (isLargeFile) {
        const dataLength = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
        const dataSizeMB = (dataLength / 1024 / 1024).toFixed(2);
        const fileType = isVideo ? '视频' : 'GIF';
        console.log(`📥 [接收] ${fileType}文件上传请求: ${filename}, 用户ID: ${userId || '未提供'}, MIME: ${mimeType || '未提供'}, Base64数据大小: ${dataSizeMB}MB`);
        
        // 估算原始文件大小（Base64 编码会增加约 33%）
        const estimatedOriginalSizeMB = (dataLength * 0.75 / 1024 / 1024).toFixed(2);
        console.log(`   📊 估算原始文件大小: ${estimatedOriginalSizeMB}MB`);
        
        // 检查是否超过限制（1GB body parser限制）
        if (dataLength > 800 * 1024 * 1024) {
          console.warn(`   ⚠️  警告：Base64 数据大小 (${dataSizeMB}MB) 接近 1GB 限制，可能导致上传失败`);
        }
      }
      
      // 只做最基本的检查，立即返回
      if (!filename || !data) {
        console.error(`❌ [上传] 请求参数缺失: filename=${!!filename}, data=${!!data}, userId=${userId || '未提供'}, mimeType=${mimeType || '未提供'}`);
        return res.status(400).json({ error: 'Missing filename or data' });
      }

      // 立即返回成功响应（在 50ms 内），不等待任何处理
      // 这样 iPhone 快捷指令可以立即完成，用户感觉截屏很快
      res.json({
        success: true,
        message: 'Upload queued',
        filename: filename
      });

      // 记录响应时间（在返回响应之后）
      const responseTime = Date.now() - startTime;
      
      // 优化：减少日志输出，只在响应时间过长时记录
      if (responseTime > 100) {
        console.log(`📤 [上传] ${userId || '未知用户'} - ${filename} (响应: ${responseTime}ms)`);
      }

      // 将任务加入队列，由队列管理器控制并发和速率
      // 优化：使用 process.nextTick 确保响应已发送后再处理，避免阻塞响应
      process.nextTick(() => {
        uploadQueue.add({
          userId,
          filename,
          data,
          mimeType: body.mimeType,
          startTime
        });
      });
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`❌ [上传] 处理失败 (${errorTime}ms):`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Upload failed' });
      }
    }
  });
  console.log('✅ Google Drive 上传接口已启用: POST /upload');

  // 获取断点续传 URL 接口 (支持 iPhone 直接上传到 Google Drive)
  // 解决大文件上传内存限制问题：iPhone -> Google Drive (绕过此服务器)
  const getResumableUploadUrl = require('./googleDrive').getResumableUploadUrl;
  if (getResumableUploadUrl) {
    app.post('/upload-url', async (req, res) => {
      const startTime = Date.now();
      const userId = req.headers['x-user-id'] || req.body.userId || null;
      const filename = req.body.filename;
      const mimeType = req.body.mimeType;

      console.log(`🔗 [Upload URL] 请求获取上传链接: ${filename}, MIME: ${mimeType}, 用户ID: ${userId || '未提供'}`);
      
      // ========================================
      // ✅ 安全检查：拒绝上传到根目录
      //    必须提供 userId，文件只能上传到用户专属子文件夹
      // ========================================
      if (!userId) {
        console.warn(`🚫 [Upload URL] 拒绝：未提供用户ID，不允许上传到根目录`);
        return res.status(403).json({ 
          error: 'User ID required. Uploads to root folder are not allowed.',
          code: 'USER_ID_REQUIRED'
        });
      }
      
      // Token 验证 (保持与其他接口一致)
      if (UPLOAD_TOKEN) {
        const token = req.headers['x-upload-token'];
        if (token !== UPLOAD_TOKEN) {
          console.warn(`   ⚠️  [Upload URL] Token 验证失败: ${token ? 'Invalid token' : 'Missing token'}`);
          return res.status(401).json({ error: 'Invalid upload token' });
        }
      }

      if (!filename) {
        console.warn(`   ⚠️  [Upload URL] 缺少文件名 (Body: ${JSON.stringify(req.body).substring(0, 100)}...)`);
        return res.status(400).json({ error: 'Missing filename. Please ensure request body is JSON with "filename" field.' });
      }

      try {
        // 1. 获取目标文件夹 ID（必须使用用户专属文件夹）
        let targetFolderId = null;
        
        if (initializeUserFolderForUpload) {
          try {
            targetFolderId = await initializeUserFolderForUpload(userId);
          } catch (error) {
            console.error(`❌ [Upload URL] 创建用户文件夹失败: ${error.message}`);
            return res.status(500).json({ 
              error: 'Failed to create user folder',
              code: 'FOLDER_CREATION_FAILED'
            });
          }
        }

        if (!targetFolderId) {
          console.error(`❌ [Upload URL] 无法获取用户文件夹ID`);
          return res.status(500).json({ error: 'Failed to get user folder ID' });
        }

        // 2. 调用 Google Drive API 获取上传链接
        const uploadUrl = await getResumableUploadUrl({
          filename,
          mimeType,
          folderId: targetFolderId
        });

        // 3. 返回链接给客户端
        res.json({
          success: true,
          uploadUrl: uploadUrl,
          filename: filename,
          folderId: targetFolderId
        });
        
        console.log(`   ✅ [Upload URL] 成功生成链接 (${Date.now() - startTime}ms)`);

      } catch (error) {
        console.error(`❌ [Upload URL] 生成链接失败: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });
    console.log('✅ Google Drive 断点续传 URL 接口已启用: POST /upload-url');
  }

} else {
  console.log('ℹ️  Google Drive 上传接口未启用（使用 iCloud 模式）');
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const connectionId = params.get('id');
  const clientType = params.get('type');
  
  if (!connectionId || !clientType) {
    console.log('❌ WebSocket连接参数缺失，拒绝连接');
    ws.close();
    return;
  }
  
  if (!connections.has(connectionId)) {
    connections.set(connectionId, {});
  }
  
  const group = connections.get(connectionId);
  
  // 🔧 关键修复：如果已有相同类型的连接，先关闭旧连接
  if (group[clientType]) {
    const oldWs = group[clientType];
    if (oldWs && oldWs.readyState !== WebSocket.CLOSED) {
      console.log(`   🧹 检测到旧的 ${clientType} 连接，正在关闭...`);
      try {
        oldWs.close();
      } catch (error) {
        console.log(`   ⚠️ 关闭旧连接失败: ${error.message}`);
      }
    }
  }
  
  group[clientType] = ws;
  console.log(`🔌 WebSocket连接: ${clientType} (${connectionId})`);
  
  // 消息处理
  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      console.log('   ❌ JSON解析失败:', error.message);
      return;
    }
    
    // Ping处理
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    
    const targetGroup = connections.get(connectionId);
    
    // 插件实例注册（单实例限制）
    if (data.type === 'register-instance' && clientType === 'figma') {
      console.log(`🔒 [单实例检查] 新实例注册: ${connectionId}`);
      
      // 检查是否有旧实例
      const oldInstance = userInstances.get(connectionId);
      if (oldInstance && oldInstance.figmaWs && oldInstance.figmaWs !== ws) {
        // 如果旧实例的连接仍然有效，向其发送关闭命令
        if (oldInstance.figmaWs.readyState === 1) { // OPEN
          console.log(`   ⚠️  检测到旧实例，发送关闭命令`);
          try {
            oldInstance.figmaWs.send(JSON.stringify({ type: 'force-close' }));
          } catch (error) {
            console.log(`   ❌ 发送关闭命令失败:`, error.message);
          }
        }
      }
      
      // 注册新实例
      userInstances.set(connectionId, {
        figmaWs: ws,
        registeredAt: Date.now()
      });
      console.log(`   ✅ 新实例已注册，活跃实例数: ${userInstances.size}`);
      return;
    }
    
    // 更新检查（插件和服务器）
    if (data.type === 'check-plugin-update' || data.type === 'check-update') {
      if (targetGroup) {
        checkAndNotifyUpdates(targetGroup, connectionId);
      }
      return;
    }
    
    // 修复服务器连接
    if (data.type === 'repair-server') {
      console.log('🔧 收到修复服务器请求');
      
      // 尝试重新加载 launchd 服务
      const { exec } = require('child_process');
      const os = require('os');
      const homeDir = os.homedir();
      const plistPath = `${homeDir}/Library/LaunchAgents/com.screensync.server.plist`;
      
      // 先卸载
      exec(`launchctl unload "${plistPath}"`, (unloadError) => {
        console.log('   🗑️  卸载旧服务...');
        
        // 重新加载
        exec(`launchctl load "${plistPath}"`, (loadError) => {
          if (loadError) {
            console.error('   ❌ 加载服务失败:', loadError.message);
          } else {
            console.log('   ✅ 服务已重新加载');
          }
          
          // 启动服务
          exec(`launchctl start com.screensync.server`, (startError) => {
            if (startError) {
              console.error('   ❌ 启动服务失败:', startError.message);
            } else {
              console.log('   ✅ 服务已启动');
            }
            
            // 发送响应
            if (targetGroup && targetGroup.figma) {
              targetGroup.figma.send(JSON.stringify({
                type: 'repair-server-response',
                success: !startError,
                message: startError ? '修复失败：' + startError.message : '服务已修复并重启'
              }));
            }
          });
        });
      });
      return;
    }
    if (!targetGroup) {
      console.log('   ❌ 连接组不存在');
      return;
    }
    
    // 控制消息处理
    if (data.type === 'start-realtime' || 
        data.type === 'stop-realtime' || 
        data.type === 'manual-sync' ||
        data.type === 'manual-sync-count-files') {
      console.log(`📨 [Server] 收到控制消息: ${data.type}`);
      console.log(`   检查 Mac 端连接状态: ${targetGroup.mac ? 'exists' : 'null'}, readyState: ${targetGroup.mac ? targetGroup.mac.readyState : 'N/A'}`);
      if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
        try {
          targetGroup.mac.send(JSON.stringify(data));
          console.log(`   ✅ 已转发到 Mac 端: ${data.type}`);
        } catch (error) {
          console.log('   ❌ 发送到Mac端失败:', error.message);
        }
      } else {
        console.log(`   ⚠️  Mac 端未连接，无法转发消息`);
        // 通知Figma Mac端未连接
        if (clientType === 'figma' && targetGroup.figma && 
            targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'error',
            message: 'Mac端未连接'
          }));
        }
      }
      return;
    }
    
    // 打开文件夹
    if (data.type === 'open-folder') {
      console.log('📂 收到打开文件夹请求');
      console.log('   连接ID:', connectionId);
      console.log('   客户端类型:', clientType);
      console.log('   目标子文件夹:', data.targetFolder || '默认');
      
      const { exec } = require('child_process');
      const os = require('os');
      const path = require('path');
      
      let targetFolder;
      const subFolder = data.targetFolder || 'GIF-导出'; // 默认打开 GIF-导出 文件夹
      
      // 根据当前模式决定打开哪个文件夹
      const currentMode = process.env.SYNC_MODE || 'drive';
      if (currentMode === 'icloud') {
        // iCloud 模式：打开 ScreenSyncImg 下的子文件夹
        targetFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg',
          subFolder
        );
        console.log('   [iCloud模式] 目标文件夹:', targetFolder);
      } else {
        // Google Drive 或其他模式：打开 ScreenSyncImg 下的子文件夹
        const baseFolder = userConfig.getLocalDownloadFolder();
        targetFolder = path.join(baseFolder, subFolder);
        console.log('   [本地模式] 目标文件夹:', targetFolder);
      }
      
      if (fs.existsSync(targetFolder)) {
        console.log('   ✓ 文件夹存在，执行打开命令');
        exec(`open "${targetFolder}"`, (err) => {
          if (err) {
            console.error('   ❌ 无法打开文件夹:', err);
          } else {
            console.log('   ✅ 已成功打开文件夹');
          }
        });
      } else {
        console.warn('   ⚠️ 文件夹不存在，无法打开:', targetFolder);
        // 尝试打开父文件夹（ScreenSyncImg）
        const parentFolder = path.dirname(targetFolder);
        if (fs.existsSync(parentFolder)) {
          console.log('   ℹ️  打开父文件夹替代:', parentFolder);
          exec(`open "${parentFolder}"`, (err) => {
            if (err) {
              console.error('   ❌ 无法打开父文件夹:', err);
            } else {
              console.log('   ✅ 已打开父文件夹');
            }
          });
        }
      }
      return;
    }
    
    // 处理取消 GIF 导出请求
    if (data.type === 'cancel-gif-export') {
      console.log('🛑 收到取消 GIF 导出请求');
      console.log('   连接ID:', connectionId);
      cancelFlags.set(connectionId, true);
      
      // ✅ 立即终止所有活动的子进程（ImageMagick、FFmpeg 等）
      killActiveProcesses(connectionId);

      // 发送取消确认消息到 Figma
      const targetGroup = connections.get(connectionId);
      if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify({
          type: 'gif-compose-cancelled',
          message: '导出已取消'
        }));
        console.log('   ✅ 已发送取消确认到 Figma');
      }
      return;
    }
    
    // ✅ 处理缓存检查请求 (由 code.js 触发，用于自动关联未同步的 Video/GIF)
    if (data.type === 'check-cache-existence') {
      console.log('🔍 收到缓存检查请求');
      console.log('   文件数:', data.files ? data.files.length : 0);

      const results = [];
      const userConfig = require('./userConfig');
      const path = require('path');
      const fs = require('fs');
      
      const mappingFile = path.join(userConfig.getLocalDownloadFolder(), '.cache-mapping.json');
      let mapping = {};
      
      // 读取映射文件
      if (fs.existsSync(mappingFile)) {
        try {
          mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
          console.log(`   📖 已加载缓存映射文件，包含 ${Object.keys(mapping).length} 个条目`);
        } catch (e) {
          console.warn(`   ⚠️ 读取映射文件失败:`, e.message);
        }
      } else {
        console.log('   ⚠️ 映射文件不存在:', mappingFile);
      }

      // 遍历请求的文件
      if (data.files && Array.isArray(data.files)) {
        for (const file of data.files) {
          let found = false;
          let gifCacheId = null;

          // 1. 检查映射文件 (精确匹配)
          if (mapping[file.filename]) {
            gifCacheId = mapping[file.filename];
            found = true;
            console.log(`   ✅ [映射] 找到缓存: ${file.filename} -> ${gifCacheId}`);
          }

          // 2. 检查映射文件 (模糊匹配 - 去除扩展名和 Figma 数字后缀)
          if (!found) {
            // 处理 Figma 可能添加的后缀，如 "filename 1.mov" -> "filename"
            // 去除扩展名
            let targetName = path.basename(file.filename, path.extname(file.filename)).toLowerCase();
            // 去除末尾的 " \d+" (空格+数字)
            targetName = targetName.replace(/\s\d+$/, '');
            
            for (const [key, val] of Object.entries(mapping)) {
              const keyName = path.basename(key, path.extname(key)).toLowerCase();
              if (keyName === targetName) {
                gifCacheId = val;
                found = true;
                console.log(`   ✅ [映射-模糊] 找到缓存: ${key} -> ${file.filename} -> ${gifCacheId}`);
                break;
              }
            }
          }
          
          if (found) {
            results.push({
              filename: file.filename,
              layerId: file.layerId,
              found: true,
              gifCacheId: gifCacheId,
              driveFileId: null, // 映射文件中没有保存 driveFileId
              ossFileId: null
            });
          } else {
             console.log(`   ❌ 未找到缓存: ${file.filename}`);
          }
        }
      }

      // 发送结果回 Figma
      const targetGroup = connections.get(connectionId);
      if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify({
          type: 'cache-existence-result',
          results: results
        }));
         console.log(`   📤 已发送检查结果: 找到 ${results.length} 个文件`);
      }
      return;
    }

    // 处理保存手动拖入的视频/GIF到缓存的请求
    if (data.type === 'cache-manual-video') {
      console.log('\n📥 收到保存手动拖入文件到缓存的请求');
      console.log('   文件名:', data.filename);
      console.log('   文件大小:', data.bytes ? `${(data.bytes.length / 1024 / 1024).toFixed(2)} MB` : '未知');
      
      try {
        if (!data.filename || !data.bytes) {
          throw new Error('缺少文件名或文件数据');
        }
        
        // 将 Array 转换为 Buffer
        const fileBuffer = Buffer.from(data.bytes);
        
        // 保存到缓存
        const cacheResult = userConfig.saveGifToCache(fileBuffer, data.filename, null);
        
        if (cacheResult && cacheResult.cacheId) {
          console.log(`   ✅ 文件已保存到缓存`);
          console.log(`   缓存ID: ${cacheResult.cacheId}`);
          console.log(`   缓存路径: ${cacheResult.cachePath}`);
          
          // 返回缓存ID给Figma插件
          ws.send(JSON.stringify({
            type: 'cache-manual-video-success',
            filename: data.filename,
            cacheId: cacheResult.cacheId,
            cachePath: cacheResult.cachePath
          }));
        } else {
          throw new Error('保存到缓存失败');
        }
      } catch (error) {
        console.error('   ❌ 保存文件到缓存失败:', error.message);
        ws.send(JSON.stringify({
          type: 'cache-manual-video-error',
          filename: data.filename,
          error: error.message
        }));
      }
      return;
    }
    
    // 处理上传本地 GIF/视频 请求
    if (data.type === 'upload-local-gif') {
      const startTime = Date.now();
      console.log('\n📤 收到上传本地 GIF/视频 请求');
      console.log('   文件名:', data.filename);
      console.log('   Layer ID:', data.layerId);
      
      try {
        const filename = data.filename;
        const messageId = data.messageId;
        
        // 支持两种数据格式：base64（新）和 bytes 数组（旧）
        let bytes;
        if (data.base64) {
          console.log('   📦 数据格式: Base64');
          bytes = Buffer.from(data.base64, 'base64');
        } else if (data.bytes) {
          console.log('   📦 数据格式: 字节数组（旧格式，较慢）');
          bytes = Buffer.from(data.bytes);
        } else {
          throw new Error('缺少文件数据');
        }
        
        console.log('   📊 文件大小:', (bytes.length / 1024 / 1024).toFixed(2), 'MB');
        
        // 保存文件到临时目录
        const tempDir = path.join(os.tmpdir(), 'screensync-upload');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFilePath = path.join(tempDir, filename);
        fs.writeFileSync(tempFilePath, bytes);
        
        console.log('   ✅ 文件已保存到:', tempFilePath);
        
        // 获取原始文件扩展名
        const fileExt = path.extname(filename).toLowerCase();
        console.log('   📄 文件类型:', fileExt);
        
        // 检查文件大小，如果是视频且超过100MB，进行压缩（提高阈值以保留更多原始质量）
        const fileSizeMB = bytes.length / 1024 / 1024;
        const isVideo = ['.mov', '.mp4'].includes(fileExt);
        const needsCompression = isVideo && fileSizeMB > 100;
        
        console.log(`   📊 文件大小: ${fileSizeMB.toFixed(2)} MB`);
        
        let processedFilePath = tempFilePath;
        
        if (needsCompression) {
          console.log('   🗜️  文件较大，开始压缩视频（高质量模式）...');
          
          const compressedPath = path.join(tempDir, `compressed_${filename}`);
          
          // 使用 FFmpeg 压缩视频（高质量设置）
          // - 保持分辨率到 1080p（如果原始更高）
          // - CRF 23（高质量，范围18-28，越小越好）
          // - 码率 4M（提升至 4Mbps 以保证质量）
          // - 使用 medium 预设（平衡速度和质量）
          const ffmpegCmd = `ffmpeg -i "${tempFilePath}" -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" -c:v libx264 -preset medium -crf 23 -b:v 4M -c:a aac -b:a 128k -movflags +faststart "${compressedPath}" -y`;
          
          try {
            await execAsync(ffmpegCmd, { timeout: 180000 }); // 3分钟超时
            
            // 检查压缩后的文件大小
            const compressedStats = fs.statSync(compressedPath);
            const compressedSizeMB = compressedStats.size / 1024 / 1024;
            const compressionRatio = ((1 - compressedSizeMB / fileSizeMB) * 100).toFixed(1);
            
            console.log(`   ✅ 压缩完成: ${fileSizeMB.toFixed(2)} MB → ${compressedSizeMB.toFixed(2)} MB (节省 ${compressionRatio}%)`);
            
            // 使用压缩后的文件
            processedFilePath = compressedPath;
            
            // 删除原始临时文件
            fs.unlinkSync(tempFilePath);
          } catch (error) {
            console.error('   ⚠️  视频压缩失败，使用原始文件:', error.message);
            // 压缩失败，继续使用原始文件
            if (fs.existsSync(compressedPath)) {
              fs.unlinkSync(compressedPath);
            }
          }
        }
        
        // 🚀 优化：使用 saveGifToCache 保存到隐藏的 .gif-cache 目录
        // 这样用户不会看到这些中间临时文件，且能被 getGifFromCache 正确找到
        const timestamp = Date.now();
        const originalFilename = `manual_${timestamp}${fileExt}`;
        
        // 读取处理后的文件
        const fileBuffer = fs.readFileSync(processedFilePath);
        
        // 使用 saveGifToCache 保存（会自动生成 cacheId 和 meta 文件）
        const cacheResult = userConfig.saveGifToCache(fileBuffer, originalFilename, `manual_${timestamp}`);
        
        if (!cacheResult) {
          throw new Error('保存到缓存失败');
        }
        
        // 删除临时文件
        try {
          fs.unlinkSync(processedFilePath);
        } catch (e) {
          // 忽略删除失败
        }
        
        console.log(`   📁 已保存到缓存: ${cacheResult.cachePath}`);
        console.log(`   🔐 缓存ID: ${cacheResult.cacheId}`);
        console.log(`   💡 文件保存在隐藏缓存目录，不会干扰用户文件夹`);
        
        // 计算总耗时
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`   ⏱️  总耗时: ${totalDuration}秒`);
        
        // 发送成功响应
        // 使用 cacheId 作为文件标识，与缓存系统一致
        ws.send(JSON.stringify({
          type: 'upload-gif-result',
          messageId: messageId,
          success: true,
          driveFileId: originalFilename,      // 原始文件名
          ossFileId: originalFilename,        // 原始文件名
          originalFilename: originalFilename, // 原始文件名
          cacheId: cacheResult.cacheId,       // 缓存ID（关键）
          imageHash: `manual_${timestamp}`
        }));
        
        console.log('   ✅ 上传完成');
        
      } catch (error) {
        console.error('   ❌ 上传失败:', error);
        ws.send(JSON.stringify({
          type: 'upload-gif-result',
          messageId: data.messageId,
          success: false,
          error: error.message
        }));
      }
    }
    
    // 处理时间线预览帧提取请求
    if (data.type === 'extract-preview-frames') {
      const { layerId, layerName, videoId, frameCount = 10 } = data;
      console.log(`\n🎞️ [时间线预览] 提取帧请求: ${layerName}`);
      console.log(`   layerId: ${layerId}`);
      console.log(`   videoId: ${videoId}`);
      console.log(`   请求帧数: ${frameCount}`);
      
      try {
        // 查找视频文件路径
        let videoPath = null;
        const searchPaths = [];
        
        // 支持的视频/GIF扩展名
        const videoExtensions = ['.mp4', '.mov', '.gif', '.webm', '.avi', '.mkv', '.m4v'];
        
        // 获取用户配置的本地文件夹（和"打开文件夹"功能使用相同路径）
        const userConfig = require('./userConfig');
        const currentMode = process.env.SYNC_MODE || 'drive';
        let baseFolder;
        
        if (currentMode === 'icloud') {
          baseFolder = path.join(
            os.homedir(),
            'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
          );
        } else {
          baseFolder = userConfig.getLocalDownloadFolder();
        }
        
        console.log(`   📂 基础文件夹: ${baseFolder}`);
        
        // 1. 主要搜索路径：用户配置的文件夹及其子文件夹
        searchPaths.push({ dir: baseFolder, type: 'base' });
        searchPaths.push({ dir: path.join(baseFolder, '视频'), type: 'video' });
        searchPaths.push({ dir: path.join(baseFolder, 'GIF'), type: 'gif' });
        searchPaths.push({ dir: path.join(baseFolder, 'GIF-导出'), type: 'gif-export' });
        
        // 2. 备用搜索路径
        searchPaths.push({ dir: path.join(os.homedir(), 'Downloads'), type: 'downloads' });
        searchPaths.push({ dir: path.join(os.homedir(), 'Desktop'), type: 'desktop' });
        
        // 清理图层名，提取基本名称（去除扩展名和数字后缀）
        const layerNameNoExt = layerName.replace(/\.[^/.]+$/, '');
        const cleanName = layerNameNoExt
          .replace(/\s+\d+$/, '')   // 移除尾部空格+数字（如 " 1"）
          .replace(/_\d+$/, '');    // 移除尾部下划线+数字（如 "_1"）
        
        console.log(`   图层名(无扩展): ${layerNameNoExt}`);
        console.log(`   清理后名称: ${cleanName}`);
        
        for (const { dir, type } of searchPaths) {
          if (!fs.existsSync(dir)) {
            continue; // 静默跳过不存在的目录
          }
          
          const files = fs.readdirSync(dir);
          // 只筛选视频文件
          const videoFiles = files.filter(f => {
            if (f.startsWith('.')) return false; // 跳过隐藏文件
            const ext = path.extname(f).toLowerCase();
            return videoExtensions.includes(ext);
          });
          
          if (videoFiles.length === 0) continue;
          
          console.log(`   [${type}] 找到 ${videoFiles.length} 个视频文件`);
          
          // 精确匹配 videoId
          if (videoId) {
            for (const file of videoFiles) {
              if (file.includes(videoId) || file.startsWith(videoId)) {
                videoPath = path.join(dir, file);
                console.log(`   ✅ videoId匹配: ${videoPath}`);
                break;
              }
            }
          }
          
          // 名称匹配 - 优先精确匹配
          if (!videoPath) {
            for (const file of videoFiles) {
              const fileNoExt = file.replace(/\.[^/.]+$/, '');
              const fileLower = fileNoExt.toLowerCase();
              const layerLower = layerNameNoExt.toLowerCase();
              const cleanLower = cleanName.toLowerCase();
              
              // 精确匹配（不含扩展名）
              if (fileLower === layerLower || fileLower === cleanLower) {
                videoPath = path.join(dir, file);
                console.log(`   ✅ 精确匹配: ${videoPath}`);
                break;
              }
            }
          }
          
          // 模糊匹配 - 包含关系
          if (!videoPath) {
            for (const file of videoFiles) {
              const fileNoExt = file.replace(/\.[^/.]+$/, '');
              const fileLower = fileNoExt.toLowerCase();
              const layerLower = layerNameNoExt.toLowerCase();
              const cleanLower = cleanName.toLowerCase();
              
              // 文件名包含图层名，或图层名包含文件名（至少5个字符才算有效匹配）
              if ((fileLower.length >= 5 && layerLower.includes(fileLower)) ||
                  (cleanLower.length >= 5 && fileLower.includes(cleanLower))) {
                videoPath = path.join(dir, file);
                console.log(`   ✅ 模糊匹配: ${videoPath}`);
                break;
              }
            }
          }
          
          if (videoPath) break;
        }
        
        if (!videoPath || !fs.existsSync(videoPath)) {
          console.log(`   ⚠️ 未找到视频文件，已搜索文件夹: ${searchPaths.map(s => s.type).join(', ')}`);
          ws.send(JSON.stringify({
            type: 'preview-frames-result',
            layerId: layerId,
            success: false,
            error: '未找到视频文件'
          }));
          return;
        }
        
        console.log(`   📁 最终视频路径: ${videoPath}`);
        
        // 创建临时目录存放帧
        const tempDir = path.join(os.tmpdir(), 'screensync-preview-frames', layerId.replace(/:/g, '_'));
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // 使用 ffprobe 获取视频时长
        const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
        const { stdout: durationStr } = await execAsync(durationCmd);
        const duration = parseFloat(durationStr.trim());
        
        if (isNaN(duration) || duration <= 0) {
          throw new Error('无法获取视频时长');
        }
        
        console.log(`   ⏱️ 视频时长: ${duration.toFixed(2)}s`);
        
        // 提取帧 - 优化：一次性提取所有帧，避免多次 ffmpeg 启动开销
        const frames = [];
        const actualFrameCount = Math.min(frameCount, 150); // 最多150帧
        
        // 计算目标帧率：帧数 / 时长
        const targetFps = actualFrameCount / duration;
        console.log(`   📊 提取参数: ${actualFrameCount} 帧, 视频时长 ${duration.toFixed(2)}s, 目标帧率 ${targetFps.toFixed(2)} fps`);
        
        // 使用单个 ffmpeg 命令一次性提取所有帧（更高效）
        const extractAllCmd = `ffmpeg -y -i "${videoPath}" -vf "fps=${targetFps},scale=-1:600" "${tempDir}/frame_%03d.png"`;
        
        try {
          await execAsync(extractAllCmd, { timeout: 60000 });
        } catch (e) {
          console.warn(`   ⚠️  批量提取失败，回退到逐帧提取: ${e.message}`);
          // 回退到逐帧提取
          for (let i = 0; i < actualFrameCount; i++) {
            const timestamp = (duration * i) / (actualFrameCount - 1);
            const framePath = path.join(tempDir, `frame_${i.toString().padStart(3, '0')}.png`);
            const extractCmd = `ffmpeg -y -ss ${timestamp.toFixed(3)} -i "${videoPath}" -vframes 1 -vf "scale=-1:600" "${framePath}"`;
            await execAsync(extractCmd);
          }
        }
        
        // 读取所有提取的帧
        const frameFiles = fs.readdirSync(tempDir)
          .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
          .sort();
        
        const totalFrames = frameFiles.length;
        console.log(`   📸 实际提取帧数: ${totalFrames}`);
        
        for (let i = 0; i < totalFrames; i++) {
          const framePath = path.join(tempDir, frameFiles[i]);
          const percent = totalFrames > 1 ? (i / (totalFrames - 1)) * 100 : 0;
          
          if (fs.existsSync(framePath)) {
            const frameData = fs.readFileSync(framePath);
            frames.push({
              percent: percent,
              data: frameData.toString('base64')
            });
            // 删除临时文件
            fs.unlinkSync(framePath);
          }
        }
        
        // 清理临时目录
        try {
          fs.rmdirSync(tempDir);
        } catch (e) {
          // ignore
        }
        
        console.log(`   ✅ 成功提取 ${frames.length} 帧`);
        
        ws.send(JSON.stringify({
          type: 'preview-frames-result',
          layerId: layerId,
          success: true,
          frames: frames,
          duration: duration // 返回视频时长（秒）
        }));
        
      } catch (error) {
        console.error(`   ❌ 帧提取失败:`, error.message);
        ws.send(JSON.stringify({
          type: 'preview-frames-result',
          layerId: layerId,
          success: false,
          error: error.message
        }));
      }
    }
    
    // 处理带标注的 GIF 合成请求
    if (data.type === 'compose-annotated-gif') {
      // 重置取消标志
      cancelFlags.set(connectionId, false);
      
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🎬 收到 GIF 标注合成请求');
      console.log('   连接ID:', connectionId);
      console.log('   Frame名称:', data.frameName);
      console.log('   GIF数量:', data.gifInfos ? data.gifInfos.length : 0);
      
      // 详细检查 gifInfos 结构
      if (data.gifInfos) {
        console.log('\n   📊 详细 gifInfos 数据:');
        data.gifInfos.forEach((gif, idx) => {
          console.log(`\n      GIF ${idx + 1}:`);
          console.log(`         文件名: ${gif?.filename || 'undefined'}`);
          console.log(`         缓存ID: ${gif?.cacheId || 'undefined'}`);
          console.log(`         imageHash: ${gif?.imageHash || 'undefined'}`);
          console.log(`         driveFileId: ${gif?.driveFileId || 'undefined'}`);
          console.log(`         ossFileId: ${gif?.ossFileId || 'undefined'}`);
          console.log(`         zIndex: ${gif?.zIndex !== undefined ? gif.zIndex : 'undefined'}`);
          console.log(`         cornerRadius: ${gif?.cornerRadius !== undefined ? gif.cornerRadius : 'undefined'}`);
          console.log(`         bounds 对象:`, gif?.bounds);
          if (gif?.bounds) {
            console.log(`            - x: ${gif.bounds.x} (type: ${typeof gif.bounds.x})`);
            console.log(`            - y: ${gif.bounds.y} (type: ${typeof gif.bounds.y})`);
            console.log(`            - width: ${gif.bounds.width} (type: ${typeof gif.bounds.width})`);
            console.log(`            - height: ${gif.bounds.height} (type: ${typeof gif.bounds.height})`);
          } else {
            console.log(`            ❌ bounds 为 undefined 或 null!`);
          }
          
          // 检查 imageFillInfo
          if (gif?.imageFillInfo) {
            console.log(`         imageFillInfo:`);
            console.log(`            - scaleMode: ${gif.imageFillInfo.scaleMode || 'undefined'}`);
            console.log(`            - imageTransform: ${gif.imageFillInfo.imageTransform ? '有' : '无'}`);
            console.log(`            - scalingFactor: ${gif.imageFillInfo.scalingFactor || 'undefined'}`);
          } else {
            console.log(`         ⚠️ imageFillInfo: 无`);
          }
        });
      } else {
        console.log('   ❌ gifInfos 为空或 undefined!');
      }
      
      console.log('\n   批次:', `${data.batchIndex + 1}/${data.batchTotal}`);
      console.log('   Frame尺寸:', `${data.frameBounds?.width}x${data.frameBounds?.height}`);
      console.log('   标注数据大小:', data.annotationBytes ? data.annotationBytes.length : 0, 'bytes');
      console.log('   🔍 bottomLayerBytes 大小:', data.bottomLayerBytes ? data.bottomLayerBytes.length : 0, 'bytes');
      console.log('   🔍 middleLayerBytes 大小:', data.middleLayerBytes ? data.middleLayerBytes.length : 0, 'bytes');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      // 检查并补全缺失的 cacheId（从映射文件）
      if (data.gifInfos) {
        const mappingFile = path.join(userConfig.getLocalDownloadFolder(), '.cache-mapping.json');
        let mapping = {};
        
        if (fs.existsSync(mappingFile)) {
          try {
            mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
            console.log(`   📖 [映射] 已加载缓存映射文件，包含 ${Object.keys(mapping).length} 个条目`);
          } catch (e) {
            console.warn(`   ⚠️  [映射] 读取映射文件失败:`, e.message);
          }
        }
        
        // 补全缺失的 cacheId
        data.gifInfos.forEach((gif, idx) => {
          if (!gif.cacheId && gif.filename) {
            const cachedId = mapping[gif.filename];
            if (cachedId) {
              gif.cacheId = cachedId;
              console.log(`   🔄 [映射] GIF ${idx + 1} 从映射文件获取 cacheId: ${gif.filename} -> ${cachedId}`);
            } else {
              console.warn(`   ⚠️  [映射] GIF ${idx + 1} 未找到缓存: ${gif.filename}`);
            }
          }
        });
      }
      
      try {
        // ⏱️ 开始计时
        const exportStartTime = Date.now();
        console.log('⏱️  [计时] GIF 导出开始...');
        
        // 🕐 Debug: Log received timelineData before calling composeAnnotatedGif
        console.log(`🕐 [WebSocket] 收到 timelineData: ${data.timelineData ? JSON.stringify(data.timelineData) : 'null/undefined'}`);
        
        const result = await composeAnnotatedGif({
          frameName: data.frameName,
          bottomLayerBytes: data.bottomLayerBytes,      // ✅ Bottom Layer（最底层 GIF 下面）
          staticLayers: data.staticLayers,              // ✅ 静态图层（按 z-index 排序）
          annotationLayers: data.annotationLayers,      // ✅ 标注图层（GIF 之上，支持时间线）
          annotationBytes: data.annotationBytes,
          frameBounds: data.frameBounds,
          frameBackground: data.frameBackground,        // ✅ Frame 背景色
          gifInfos: data.gifInfos,
          timelineData: data.timelineData, // ✅ Pass timeline data
          connectionId: connectionId,
          shouldCancel: () => cancelFlags.get(connectionId) === true,
          onProgress: (percent, message) => {
            if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
              targetGroup.figma.send(JSON.stringify({
                type: 'gif-compose-progress',
                progress: percent,
                message: message,
                batchIndex: data.batchIndex,
                batchTotal: data.batchTotal
              }));
            }
          }
        });
        
        // ⏱️ 计算耗时
        const exportEndTime = Date.now();
        const exportDuration = exportEndTime - exportStartTime;
        const durationSeconds = (exportDuration / 1000).toFixed(2);
        console.log(`⏱️  [计时] GIF 导出完成，总耗时: ${durationSeconds} 秒 (${exportDuration} ms)`);
        
        if (result.skipped) {
          console.log('⏭️  GIF 已存在，跳过导出:', result.outputPath);
        } else {
          console.log('✅ GIF 合成成功:', result.outputPath);
        }
        
        // 清理上传缓存文件夹（导出成功后）
        try {
          const localFolder = userConfig.getLocalDownloadFolder();
          const uploadCacheDir = path.join(localFolder, '.gif_cache');
          const mappingFile = path.join(localFolder, '.cache-mapping.json');
          
          if (fs.existsSync(uploadCacheDir)) {
            removeDirRecursive(uploadCacheDir);
            console.log('   🗑️  已清理上传缓存文件夹');
          }
          
          if (fs.existsSync(mappingFile)) {
            fs.unlinkSync(mappingFile);
            console.log('   🗑️  已清理缓存映射文件');
          }
          
          // 🧹 清理 .gif-cache 中的 manual 手动上传文件
          const gifCacheDir = path.join(localFolder, '.gif-cache');
          if (fs.existsSync(gifCacheDir)) {
            const files = fs.readdirSync(gifCacheDir);
            let cleanedCount = 0;
            
            for (const file of files) {
              // 查找 manual 开头的文件和对应的 meta 文件
              const metaPath = path.join(gifCacheDir, file);
              
              if (file.endsWith('.meta.json')) {
                try {
                  const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                  // 检查是否是手动上传的文件（originalFilename 以 manual_ 开头）
                  if (metadata.originalFilename && metadata.originalFilename.startsWith('manual_')) {
                    // 删除对应的缓存文件
                    const cacheFilePath = path.join(gifCacheDir, `${metadata.cacheId}${metadata.ext}`);
                    if (fs.existsSync(cacheFilePath)) {
                      fs.unlinkSync(cacheFilePath);
                      cleanedCount++;
                    }
                    // 删除 meta 文件
                    fs.unlinkSync(metaPath);
                  }
                } catch (e) {
                  // 跳过无法解析的 meta 文件
                }
              }
            }
            
            if (cleanedCount > 0) {
              console.log(`   🗑️  已清理 ${cleanedCount} 个手动上传的临时文件`);
            }
          }
        } catch (cleanupError) {
          console.warn('   ⚠️  清理上传缓存失败（不影响导出）:', cleanupError.message);
        }
        
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          const successMsg = {
            type: 'gif-compose-success',
            message: result.skipped 
              ? `⏭️  文件已存在: ${result.outputPath}` 
              : `✅ 已导出到: ${result.outputPath}`,
            outputPath: result.outputPath,
            filename: data.frameName || data.originalFilename,
            skipped: result.skipped || false,
            // ⏱️ 添加导出耗时信息
            exportDuration: exportDuration,
            exportDurationSeconds: durationSeconds
          };
          console.log(result.skipped ? '   📤 发送跳过消息到 Figma' : `   📤 发送成功消息到 Figma (耗时 ${durationSeconds}s)`);
          targetGroup.figma.send(JSON.stringify(successMsg));
        } else {
          console.warn('   ⚠️ 无法发送成功消息：Figma WebSocket未连接');
        }
      } catch (error) {
        // 检查是否是取消操作
        if (error.message === 'GIF_EXPORT_CANCELLED') {
          console.log('\n🛑 GIF 导出已取消');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          
          // 发送取消消息到 Figma
          if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
            targetGroup.figma.send(JSON.stringify({
              type: 'gif-compose-cancelled',
              message: '导出已取消'
            }));
          }
          
          // 清理临时文件
          try {
            const tempDirPattern = path.join(__dirname, `.temp-gif-compose-${connectionId}_*`);
            const glob = require('glob');
            const tempDirs = glob.sync(tempDirPattern);
            for (const dir of tempDirs) {
              if (fs.existsSync(dir)) {
                removeDirRecursive(dir);
                console.log(`   🗑️  已清理取消的临时文件夹: ${path.basename(dir)}`);
              }
            }
            
            // 清理上传缓存文件夹
            const localFolder = userConfig.getLocalDownloadFolder();
            const uploadCacheDir = path.join(localFolder, '.gif_cache');
            const mappingFile = path.join(localFolder, '.cache-mapping.json');
            
            if (fs.existsSync(uploadCacheDir)) {
              removeDirRecursive(uploadCacheDir);
              console.log('   🗑️  已清理上传缓存文件夹');
            }
            
            if (fs.existsSync(mappingFile)) {
              fs.unlinkSync(mappingFile);
              console.log('   🗑️  已清理缓存映射文件');
            }
          } catch (cleanupError) {
            console.error(`   ⚠️  清理临时文件失败:`, cleanupError.message);
          }
          
          return;
        }
        
        console.error('\n❌❌❌ GIF 合成失败 ❌❌❌');
        console.error('   错误类型:', error.name);
        console.error('   错误消息:', error.message);
        console.error('   错误堆栈:', error.stack);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        
        // 清理上传缓存文件夹（导出失败后也清理）
        try {
          const localFolder = userConfig.getLocalDownloadFolder();
          const uploadCacheDir = path.join(localFolder, '.gif_cache');
          const mappingFile = path.join(localFolder, '.cache-mapping.json');
          
          if (fs.existsSync(uploadCacheDir)) {
            removeDirRecursive(uploadCacheDir);
            console.log('   🗑️  已清理上传缓存文件夹');
          }
          
          if (fs.existsSync(mappingFile)) {
            fs.unlinkSync(mappingFile);
            console.log('   🗑️  已清理缓存映射文件');
          }
        } catch (cleanupError) {
          console.warn('   ⚠️  清理上传缓存失败:', cleanupError.message);
        }
        
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          const errorMsg = {
            type: 'gif-compose-error',
            message: error.message || '未知错误',
            error: error.message || '未知错误', // 兼容旧代码
            details: error.stack
          };
          console.log('   📤 发送错误消息到 Figma');
          targetGroup.figma.send(JSON.stringify(errorMsg));
        } else {
          console.warn('   ⚠️ 无法发送错误消息：Figma WebSocket未连接');
        }
      }
      return;
    }
    
    // 同步模式切换消息处理
    if (data.type === 'switch-sync-mode' || data.type === 'get-sync-mode' || data.type === 'get-user-id' || data.type === 'get-server-info') {
      if (data.type === 'get-server-info') {
        // 总是使用当前实际路径，而不是从配置文件读取（避免移动文件夹后路径不更新的问题）
        const installPath = path.resolve(__dirname);
        
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'server-info',
            path: installPath
          }));
        }
      } else if (data.type === 'get-user-id') {
        const userId = getUserId();
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'user-id-info',
            userId: userId
          }));
        }
      } else if (data.type === 'get-sync-mode') {
        // 优先从文件读取，然后从环境变量，最后默认 'drive'
        const fileMode = readSyncModeFromFile();
        const currentMode = fileMode || process.env.SYNC_MODE || 'drive';
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'sync-mode-info',
            mode: currentMode
          }));
        }
      } else if (data.type === 'switch-sync-mode') {
        const newMode = data.mode;
        
        // 如果是切换到 iCloud，需要验证文件夹和空间
        if (newMode === 'icloud') {
          const fs = require('fs');
          const path = require('path');
          const icloudPath = path.join(
            process.env.HOME,
            'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
          );
          
          try {
            // 尝试创建文件夹
            fs.mkdirSync(icloudPath, { recursive: true });
            
            // 验证文件夹是否可写
            if (!fs.existsSync(icloudPath) || !fs.statSync(icloudPath).isDirectory()) {
              throw new Error('文件夹创建失败');
            }
            
            // 尝试设置文件夹为"始终保留下载" (Keep Downloaded)
            try {
              const { exec } = require('child_process');
              exec(`brctl download -R "${icloudPath}"`, (error) => {
                if (!error) {
                  console.log('   ✅ [Server] 已配置 iCloud 文件夹为"始终保留下载"');
                }
              });
            } catch (e) {
              // 忽略错误
            }
            
            // 测试写入权限和空间
            const testFile = path.join(icloudPath, '.test-write-space-check');
            try {
              // 尝试写入一个较大的测试文件（1MB）来检测空间
              const testData = Buffer.alloc(1024 * 1024, 'x'); // 1MB
              fs.writeFileSync(testFile, testData);
              fs.unlinkSync(testFile);
            } catch (err) {
              // 检查是否是空间不足的错误
              const errorMsg = err.message || String(err);
              if (errorMsg.includes('No space') || 
                  errorMsg.includes('ENOSPC') || 
                  errorMsg.includes('not enough space') ||
                  errorMsg.includes('磁盘空间不足') ||
                  errorMsg.includes('空间不足')) {
                throw new Error('iCloud 空间不足');
              }
              throw new Error('文件夹无写入权限或空间不足');
            }
            
          } catch (error) {
            if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
              const errorMessage = error.message || String(error);
              const isSpaceError = errorMessage.includes('空间不足') || 
                                   errorMessage.includes('No space') || 
                                   errorMessage.includes('ENOSPC');
              
              targetGroup.figma.send(JSON.stringify({
                type: 'switch-sync-mode-result',
                success: false,
                message: isSpaceError ? 'iCloud 空间不足' : ('iCloud 文件夹创建失败：' + errorMessage + '。请检查 iCloud Drive 是否启用或空间是否充足。'),
                isSpaceError: isSpaceError
              }));
            }
            return;
          }
        }
        
        // 如果是切换到 Google Drive 模式，且之前是 iCloud 模式，自动配置
        if ((newMode === 'drive' || newMode === 'google') && googleDriveEnabled) {
          const fileMode = readSyncModeFromFile();
          const previousMode = fileMode || process.env.SYNC_MODE || 'drive';
          
          // 如果之前是 iCloud 模式，且还没有配置 Google Drive 文件夹，则自动配置
          if (previousMode === 'icloud') {
            // 使用立即执行的 async 函数来处理异步操作
            (async () => {
              try {
                const userId = userConfig.getUserIdentifier();
                const driveFolderId = userConfig.getDriveFolderId();
                
                // 检查是否已经配置了 Google Drive 文件夹
                if (!driveFolderId) {
                  console.log(`\n🔧 [Server] 检测到从 iCloud 切换到 Google Drive，开始自动配置...`);
                  console.log(`   👤 用户ID: ${userId}`);
                  
                  // 1. 创建 Google Drive 用户文件夹
                  if (initializeUserFolderForUpload) {
                    try {
                      console.log(`   📁 正在创建 Google Drive 用户文件夹...`);
                      const newDriveFolderId = await initializeUserFolderForUpload(userId);
                      userConfig.updateDriveFolderId(newDriveFolderId);
                      console.log(`   ✅ Google Drive 用户文件夹已创建: ${newDriveFolderId}`);
                    } catch (error) {
                      console.error(`   ⚠️  创建 Google Drive 文件夹失败: ${error.message}`);
                      // 不阻止切换，但记录错误
                    }
                  }
                  
                  // 2. 创建本地下载文件夹（与项目文件目录同级）
                  const localDownloadFolder = path.join(__dirname, '../ScreenSyncImg');
                  try {
                    if (!fs.existsSync(localDownloadFolder)) {
                      fs.mkdirSync(localDownloadFolder, { recursive: true });
                      console.log(`   ✅ 本地下载文件夹已创建: ${localDownloadFolder}`);
                    } else {
                      console.log(`   ℹ️  本地下载文件夹已存在: ${localDownloadFolder}`);
                    }
                    // 更新配置文件
                    userConfig.updateLocalDownloadFolder(localDownloadFolder);
                    console.log(`   ✅ 本地下载文件夹配置已更新`);
                  } catch (error) {
                    console.error(`   ⚠️  创建本地下载文件夹失败: ${error.message}`);
                    // 不阻止切换，但记录错误
                  }
                  
                  console.log(`   ✅ 自动配置完成\n`);
                } else {
                  console.log(`   ℹ️  Google Drive 文件夹已配置，跳过自动配置`);
                }
              } catch (error) {
                console.error(`   ⚠️  自动配置过程中出错: ${error.message}`);
                // 不阻止切换，但记录错误
              }
            })();
          }
        }
        
        process.env.SYNC_MODE = newMode;
        
        // 如果切换到 iCloud 模式，启动自动维护
        if (newMode === 'icloud') {
          startICloudMaintenance();
        }
        
        // 写入配置文件
        const syncModeFile = path.join(__dirname, '.sync-mode');
        try {
          fs.writeFileSync(syncModeFile, newMode, 'utf8');
        } catch (error) {
          console.log('   ⚠️  写入配置文件失败:', error.message);
        }
        
        // 通知 Mac 端切换模式
        if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
          targetGroup.mac.send(JSON.stringify({
            type: 'switch-sync-mode',
            mode: newMode
          }));
        }
        
        // 通知 Figma 端切换成功
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          let modeName = '未知模式';
          if (newMode === 'drive' || newMode === 'google') {
            modeName = 'Google Drive';
          } else if (newMode === 'aliyun' || newMode === 'oss') {
            modeName = '阿里云';
          } else if (newMode === 'icloud') {
            modeName = 'iCloud';
          }
          
          targetGroup.figma.send(JSON.stringify({
            type: 'switch-sync-mode-result',
            success: true,
            mode: newMode,
            message: '储存方式已切换为 ' + modeName
          }));
          targetGroup.figma.send(JSON.stringify({
            type: 'sync-mode-changed',
            mode: newMode
          }));
        }
      }
      return;
    }
    
    // 备份设置消息处理
    if (data.type === 'get-backup-screenshot-setting' || data.type === 'update-backup-screenshot-setting') {
      const userConfig = require('./userConfig');
      
      if (data.type === 'get-backup-screenshot-setting') {
        const mode = userConfig.getBackupMode();
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'backup-screenshot-setting-info',
            mode: mode,
            enabled: mode === 'all' // 兼容旧字段
          }));
        }
      } else if (data.type === 'update-backup-screenshot-setting') {
        let mode = data.mode;
        // 兼容旧版请求
        if (!mode && typeof data.enabled !== 'undefined') {
            mode = data.enabled ? 'all' : 'none';
        }
        // 确保 mode 有效
        if (!['none', 'gif_only', 'all'].includes(mode)) {
            mode = 'none';
        }
        
        userConfig.updateBackupMode(mode);
    
        // 通知 Figma 端更新成功
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'backup-screenshot-setting-updated',
            success: true,
            mode: mode,
            enabled: mode === 'all'
          }));
        }
        
        // 通知 Mac 端更新设置
        if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
          targetGroup.mac.send(JSON.stringify({
            type: 'backup-screenshot-setting-updated',
            mode: mode,
            enabled: mode === 'all'
          }));
        }
      }
      return;
    }
    
    // 截图消息
    if (data.type === 'screenshot') {
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify(data));
      }
      return;
    }
    
    // 文件跳过消息（MP4 或大于150MB的GIF）
    if (data.type === 'file-skipped') {
          if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify(data));
      }
      return;
    }
    
    // 确认消息
    if (data.type === 'screenshot-received' || 
        data.type === 'screenshot-failed') {
      if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
        targetGroup.mac.send(JSON.stringify(data));
      }
      return;
    }
    
    // 手动同步相关消息（从Mac端转发到Figma）
    if (data.type === 'manual-sync-complete' || 
        data.type === 'manual-sync-file-count' || 
        data.type === 'manual-sync-progress' || 
        data.type === 'gif-backup-setting-updated' || 
        data.type === 'keep-gif-in-icloud-setting-updated') {
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify(data));
      }
      return;
    }
    
    // 打开本地文件夹
    if (data.type === 'open-local-folder') {
      const userConfig = require('./userConfig');
      const path = require('path');
      const fs = require('fs');
      const os = require('os');
      
      console.log('📂 收到打开本地文件夹请求');
      console.log('   目标子文件夹:', data.targetFolder || '根目录');
      
      // 根据当前同步模式确定要打开的文件夹
      const currentMode = process.env.SYNC_MODE || 'drive';
      const subFolder = data.targetFolder; // 可能是 '视频', 'GIF', '图片' 或 undefined
      let localFolderPath;
      
      if (currentMode === 'icloud') {
        // iCloud 模式：打开 iCloud 文件夹路径
        const basePath = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
        localFolderPath = subFolder ? path.join(basePath, subFolder) : basePath;
      } else {
        // Google Drive 或阿里云模式：打开桌面的本地下载文件夹
        const basePath = userConfig.getLocalDownloadFolder();
        localFolderPath = subFolder ? path.join(basePath, subFolder) : basePath;
      }
      
      console.log('   完整路径:', localFolderPath);
      
      // 根据操作系统选择打开命令
      let command;
      const platform = process.platform;
      if (platform === 'darwin') {
        // macOS
        command = `open "${localFolderPath}"`;
      } else if (platform === 'win32') {
        // Windows
        command = `explorer "${localFolderPath}"`;
      } else {
        // Linux
        command = `xdg-open "${localFolderPath}"`;
      }
      
      // 检查文件夹是否存在
      if (!fs.existsSync(localFolderPath)) {
        console.warn('   ⚠️ 目标文件夹不存在，尝试打开父文件夹');
        // 如果子文件夹不存在，打开父文件夹
        const parentPath = path.dirname(localFolderPath);
        if (fs.existsSync(parentPath)) {
          localFolderPath = parentPath;
          command = platform === 'darwin' ? `open "${localFolderPath}"` : 
                    platform === 'win32' ? `explorer "${localFolderPath}"` : 
                    `xdg-open "${localFolderPath}"`;
          console.log('   ℹ️  将打开父文件夹:', localFolderPath);
        }
      }
      
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('❌ 打开本地文件夹失败:', error.message);
          if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
            targetGroup.figma.send(JSON.stringify({
              type: 'error',
              message: '打开文件夹失败: ' + error.message
            }));
          }
        } else {
          console.log('✅ 已打开本地文件夹:', localFolderPath);
        }
      });
      return;
    }
    
    // 插件自动更新（已废弃，使用统一更新）
    if (data.type === 'update-plugin') {
      handleFullUpdate(targetGroup, connectionId);
      return;
    }
    
    // 服务器自动更新（已废弃，使用统一更新）
    if (data.type === 'update-server') {
      handleFullUpdate(targetGroup, connectionId);
      return;
    }
    
    // 统一全量更新（插件 + 服务器所有代码）
    if (data.type === 'update-full') {
      console.log(`📥 [Server] 收到全量更新请求: ${connectionId}`);
      
      // 异步执行更新，不阻塞消息处理
      handleFullUpdate(targetGroup, connectionId).catch(error => {
        console.error('❌ [Server] 处理全量更新失败:', error.message);
        // 确保发送错误消息给前端
        if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          try {
            targetGroup.figma.send(JSON.stringify({
              type: 'update-progress',
              status: 'error',
              message: `更新失败: ${error.message}`
            }));
          } catch (sendError) {
            console.error('❌ [Server] 发送错误消息失败:', sendError.message);
          }
        }
      });
      return;
    }
  });
  
  ws.on('close', () => {
    const group = connections.get(connectionId);
    if (group) {
      // 如果 Figma 插件关闭，主动通知 Mac 端停止监听
      if (clientType === 'figma' && group.mac && group.mac.readyState === WebSocket.OPEN) {
        try {
          console.log('   📤 [Server] Figma 插件已关闭，通知 Mac 端停止监听');
          group.mac.send(JSON.stringify({ type: 'stop-realtime' }));
        } catch (error) {
          console.error('   ❌ [Server] 通知 Mac 端停止监听失败:', error.message);
        }
      }
      
      // 清理单实例映射
      if (clientType === 'figma') {
        const instance = userInstances.get(connectionId);
        if (instance && instance.figmaWs === ws) {
          userInstances.delete(connectionId);
          console.log(`🔒 [单实例] 实例已注销: ${connectionId}，剩余: ${userInstances.size}`);
        }
      }
      
      delete group[clientType];
      if (!group.figma && !group.mac) {
        connections.delete(connectionId);
        // 清理取消标志和活动进程
        cancelFlags.delete(connectionId);
        killActiveProcesses(connectionId);
        activeProcesses.delete(connectionId);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket错误 (', clientType, '):', error.message);
  });
});

// 🔧 定期清理僵死的 WebSocket 连接（每 30 秒检查一次）
setInterval(() => {
  let cleanedCount = 0;
  for (const [connectionId, group] of connections.entries()) {
    // 检查 figma 连接
    if (group.figma && (group.figma.readyState === WebSocket.CLOSING || group.figma.readyState === WebSocket.CLOSED)) {
      console.log(`🧹 [清理] 移除僵死的 figma 连接: ${connectionId}`);
      delete group.figma;
      cleanedCount++;
    }
    
    // 检查 mac 连接
    if (group.mac && (group.mac.readyState === WebSocket.CLOSING || group.mac.readyState === WebSocket.CLOSED)) {
      console.log(`🧹 [清理] 移除僵死的 mac 连接: ${connectionId}`);
      delete group.mac;
      cleanedCount++;
    }
    
    // 如果组为空，删除整个组
    if (!group.figma && !group.mac) {
      connections.delete(connectionId);
      cancelFlags.delete(connectionId);
      killActiveProcesses(connectionId);
      activeProcesses.delete(connectionId);
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 [清理] 已清理 ${cleanedCount} 个僵死连接，当前活跃连接: ${connections.size}`);
  }
}, 30000); // 每 30 秒执行一次

// 检查并通知更新（插件和服务器）
async function checkAndNotifyUpdates(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const https = require('https');
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };
      
      https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      }).on('error', reject).on('timeout', () => {
        reject(new Error('请求超时'));
      });
    });
    
    // 获取当前版本
    const currentServerVersion = getCurrentServerVersion();
    const latestVersion = releaseInfo.tag_name.replace(/^v/, '');
    
    // 查找更新文件
    const pluginAsset = releaseInfo.assets.find(asset => 
      asset.name.includes('figma-plugin') && asset.name.endsWith('.zip')
    );
    
    // 检测当前系统架构，查找对应的服务器更新包
    const arch = process.arch; // 'arm64' for Apple Silicon, 'x64' for Intel
    const isAppleSilicon = arch === 'arm64';
    let serverAsset = null;
    
    if (isAppleSilicon) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 回退到通用包（兼容旧版本）
    if (!serverAsset) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-UserPackage') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 检查插件更新
    if (pluginAsset) {
      const currentPluginVersion = getCurrentPluginVersion();
      const pluginNeedsUpdate = !currentPluginVersion || compareVersions(latestVersion, currentPluginVersion) > 0;
      
      if (pluginNeedsUpdate) {
        targetGroup.figma.send(JSON.stringify({
          type: 'plugin-update-info',
          latestVersion: latestVersion,
          updateUrl: releaseInfo.html_url,
          releaseNotes: releaseInfo.body || '',
          hasUpdate: true
        }));
      }
    }
    
    // 检查服务器更新
    if (serverAsset) {
      const serverNeedsUpdate = !currentServerVersion || compareVersions(latestVersion, currentServerVersion) > 0;
      
      if (serverNeedsUpdate) {
        targetGroup.figma.send(JSON.stringify({
          type: 'server-update-info',
          latestVersion: latestVersion,
          currentVersion: currentServerVersion || '未知',
          updateUrl: releaseInfo.html_url,
          releaseNotes: releaseInfo.body || '',
          hasUpdate: true,
          downloadUrl: serverAsset.browser_download_url
        }));
      }
    }
    
  } catch (error) {
    console.error('   ⚠️  检查更新失败:', error.message);
  }
}

// 获取当前服务器版本
function getCurrentServerVersion() {
  try {
    const versionFile = path.join(__dirname, 'VERSION.txt');
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf8');
      const match = content.match(/版本:\s*([^\n]+)/);
      return match ? match[1].trim() : null;
    }
  } catch (error) {
    // 忽略错误
  }
  return null;
}

// 获取当前插件版本
function getCurrentPluginVersion() {
  try {
    // 从 code.js 中读取 PLUGIN_VERSION 常量
    const codeFile = path.join(__dirname, 'figma-plugin', 'code.js');
    if (fs.existsSync(codeFile)) {
      const codeContent = fs.readFileSync(codeFile, 'utf8');
      // 匹配 PLUGIN_VERSION = 'x.x.x' 或 PLUGIN_VERSION = "x.x.x"
      const versionMatch = codeContent.match(/PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (versionMatch && versionMatch[1]) {
        return versionMatch[1];
      }
    }
  } catch (error) {
    console.warn('⚠️ 无法读取插件版本:', error.message);
  }
  return null;
}

// 比较版本号
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);
  
  for (let i = 0; i < maxLength; i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  return 0;
}

// 支持重定向和进度报告的下载函数
function downloadFileWithRedirect(url, destPath, onProgress = null) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const file = fs.createWriteStream(destPath);
    
    // 添加必要的请求头，GitHub 需要 User-Agent 和 Accept
    const options = {
      headers: {
        'User-Agent': 'ScreenSync-Updater/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    const request = https.get(url, options, (response) => {
      // 处理重定向 (HTTP 3xx)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        file.close();
        
        // 递归调用，传递进度回调
        downloadFileWithRedirect(redirectUrl, destPath, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        console.error(`   ❌ 下载失败: HTTP ${response.statusCode} - ${url}`);
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }
      
      // 📊 获取文件总大小
      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      let lastProgressTime = Date.now();
      
      // 监听数据流，报告进度
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        
        // 每 500ms 报告一次进度，避免过于频繁
        const now = Date.now();
        if (onProgress && (now - lastProgressTime > 500 || downloadedSize === totalSize)) {
          const progress = totalSize > 0 ? Math.floor((downloadedSize / totalSize) * 100) : 0;
          onProgress(downloadedSize, totalSize, progress);
          lastProgressTime = now;
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        // 最后一次进度报告（100%）
        if (onProgress && totalSize > 0) {
          onProgress(totalSize, totalSize, 100);
        }
        resolve();
      });
    });
    
    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      console.error(`   ❌ 下载请求错误: ${err.message}`);
      reject(err);
    });
    
    request.setTimeout(30000, () => {
      request.destroy();
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      console.error(`   ❌ 下载超时: ${url}`);
      reject(new Error('下载超时'));
    });
  });
}

// 插件自动更新功能
async function handlePluginUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    console.log('   ❌ Figma 客户端未连接，无法更新插件');
    return;
  }
  
  try {
    console.log('\n🔄 [Plugin Update] 开始自动更新插件...');
    
    // 通知用户开始更新
    targetGroup.figma.send(JSON.stringify({
      type: 'plugin-update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    }));
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    
    console.log(`   📥 从 GitHub API 获取最新版本: ${apiUrl}`);
    
    // 使用 https 模块获取 GitHub API 数据
    const https = require('https');
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Plugin-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };
      
      https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      }).on('error', reject).on('timeout', () => {
        reject(new Error('请求超时'));
      });
    });
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 查找插件文件（优先查找包含 figma-plugin 的 zip 文件）
    let pluginAsset = releaseInfo.assets.find(asset => 
      asset.name.includes('figma-plugin') && asset.name.endsWith('.zip')
    );
    
    if (!pluginAsset) {
      // 如果没有找到，尝试查找任何 zip 文件
      pluginAsset = releaseInfo.assets.find(asset => asset.name.endsWith('.zip'));
    }
    
    if (!pluginAsset) {
      throw new Error('未找到插件文件，请确保 Release 中包含 .zip 格式的插件文件');
    }
    
    console.log(`   📦 找到插件文件: ${pluginAsset.name} (${(pluginAsset.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // 通知用户正在下载
    targetGroup.figma.send(JSON.stringify({
      type: 'plugin-update-progress',
      status: 'downloading',
      message: `正在下载 ${pluginAsset.name}...`
    }));
    
    // 下载插件文件
    const downloadUrl = pluginAsset.browser_download_url;
    const pluginDir = path.join(__dirname, 'figma-plugin');
    const tempFile = path.join(__dirname, '.plugin-update-temp.zip');
    
    console.log(`   📥 下载地址: ${downloadUrl}`);
    
    // 下载文件
    await downloadFileWithRedirect(downloadUrl, tempFile);
          console.log(`   ✅ 下载完成: ${tempFile}`);
    
    // 通知用户正在安装
    targetGroup.figma.send(JSON.stringify({
      type: 'plugin-update-progress',
      status: 'installing',
      message: '正在安装更新...'
    }));
    
    // 解压并覆盖插件文件（使用 Node.js 内置方法或 child_process）
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // 确保插件目录存在
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }
    
    // 备份现有文件（可选）
    const backupDir = path.join(__dirname, '.plugin-backup');
    if (fs.existsSync(pluginDir)) {
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
      fs.mkdirSync(backupDir, { recursive: true });
      const files = fs.readdirSync(pluginDir);
      files.forEach(file => {
        const src = path.join(pluginDir, file);
        const dest = path.join(backupDir, file);
        try {
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dest);
          }
        } catch (e) {
          // 忽略备份错误
        }
      });
      console.log(`   💾 已备份现有插件文件到: ${backupDir}`);
    }
    
    // 解压 zip 文件（使用 unzip 命令，如果没有则提示用户安装）
    try {
      // 尝试使用 unzip 命令
      // 注意：zip 包包含 'figma-plugin' 顶层目录，所以解压到 __dirname
      await execPromise(`unzip -o "${tempFile}" -d "${__dirname}"`);
      console.log(`   ✅ 插件文件已更新到: ${pluginDir}`);
    } catch (unzipError) {
      // 如果 unzip 不可用，尝试使用 Node.js 方法
      try {
        // 简单的 zip 解压（仅支持基本格式）
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(__dirname, true);
        console.log(`   ✅ 插件文件已更新到: ${pluginDir}`);
      } catch (zipError) {
        throw new Error('无法解压插件文件，请确保系统已安装 unzip 或 adm-zip 模块');
      }
    }
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    
    // 通知用户更新完成
    targetGroup.figma.send(JSON.stringify({
      type: 'plugin-update-progress',
      status: 'completed',
      message: '更新完成！请重启插件以使用新版本',
      version: releaseInfo.tag_name
    }));
    
    console.log(`   ✅ 插件更新完成: ${releaseInfo.tag_name}\n`);
    
  } catch (error) {
    console.error(`   ❌ 插件更新失败: ${error.message}`);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      targetGroup.figma.send(JSON.stringify({
        type: 'plugin-update-progress',
        status: 'error',
        message: `更新失败: ${error.message}`
      }));
    }
  }
}

// 服务器自动更新功能
async function handleServerUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    console.log('   ❌ Figma 客户端未连接，无法更新服务器');
    return;
  }
  
  try {
    console.log('\n🔄 [Server Update] 开始自动更新服务器...');
    
    // 通知用户开始更新
    targetGroup.figma.send(JSON.stringify({
      type: 'server-update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    }));
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const https = require('https');
    
    console.log(`   📥 从 GitHub API 获取最新版本: ${apiUrl}`);
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Server-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };
      
      https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      }).on('error', reject).on('timeout', () => {
        reject(new Error('请求超时'));
      });
    });
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 检测当前系统架构，查找对应的服务器更新包
    const arch = process.arch;
    const isAppleSilicon = arch === 'arm64';
    console.log(`   🖥️  系统架构: ${arch} (${isAppleSilicon ? 'Apple Silicon' : 'Intel'})`);
    
    let serverAsset = null;
    if (isAppleSilicon) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 回退到通用包
    if (!serverAsset) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-UserPackage') && asset.name.endsWith('.tar.gz')
      );
    }
    
    if (!serverAsset) {
      throw new Error(`未找到适合 ${isAppleSilicon ? 'Apple Silicon' : 'Intel'} 的服务器包，请确保 Release 中包含 ScreenSync-Apple.tar.gz 或 ScreenSync-Intel.tar.gz`);
    }
    
    console.log(`   📦 找到服务器包: ${serverAsset.name} (${(serverAsset.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // 通知用户正在下载
    targetGroup.figma.send(JSON.stringify({
      type: 'server-update-progress',
      status: 'downloading',
      message: `正在下载 ${serverAsset.name}...`
    }));
    
    // 下载服务器包
    const downloadUrl = serverAsset.browser_download_url;
    const tempFile = path.join(__dirname, '.server-update-temp.tar.gz');
    const updateDir = path.join(__dirname, '.server-update');
    
    console.log(`   📥 下载地址: ${downloadUrl}`);
    
    // 下载文件
    await downloadFileWithRedirect(downloadUrl, tempFile);
          console.log(`   ✅ 下载完成: ${tempFile}`);
    
    // 通知用户正在安装
    targetGroup.figma.send(JSON.stringify({
      type: 'server-update-progress',
      status: 'installing',
      message: '正在安装更新...'
    }));
    
    // 解压到临时目录
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    fs.mkdirSync(updateDir, { recursive: true });
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // 解压 tar.gz
    await execPromise(`tar -xzf "${tempFile}" -C "${updateDir}"`);
    console.log(`   ✅ 解压完成到: ${updateDir}`);
    
    // 备份现有文件
    const backupDir = path.join(__dirname, '.server-backup');
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(backupDir, { recursive: true });
    
    // 需要更新的服务器文件列表
    const serverFiles = [
      'server.js',
      'googleDrive.js',
      'aliyunOSS.js',
      'userConfig.js',
      'start.js',
      'update-manager.js',
      'icloud-watcher.js',
      'drive-watcher.js',
      'aliyun-watcher.js',
      'package.json'
    ];
    
    // 备份并更新文件
    // 动态查找解压后的目录（支持 ScreenSync-Apple、ScreenSync-Intel 或 ScreenSync-UserPackage）
    let extractedDir = null;
    const possibleDirs = ['ScreenSync-Apple', 'ScreenSync-Intel', 'ScreenSync-UserPackage'];
    for (const dirName of possibleDirs) {
      const testDir = path.join(updateDir, dirName);
      if (fs.existsSync(testDir)) {
        extractedDir = testDir;
        console.log(`   📂 找到解压目录: ${dirName}`);
        break;
      }
    }
    
    // 如果没有找到预期的目录，尝试查找包含 server.js 的目录
    if (!extractedDir) {
      const updateDirContents = fs.readdirSync(updateDir);
      for (const item of updateDirContents) {
        const itemPath = path.join(updateDir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          // 检查是否包含 server.js
          if (fs.existsSync(path.join(itemPath, 'server.js'))) {
            extractedDir = itemPath;
            console.log(`   📂 找到项目目录: ${item}`);
            break;
          }
          // 检查子目录 项目文件/
          const projectFilesDir = path.join(itemPath, '项目文件');
          if (fs.existsSync(projectFilesDir) && fs.existsSync(path.join(projectFilesDir, 'server.js'))) {
            extractedDir = projectFilesDir;
            console.log(`   📂 找到项目文件目录: ${item}/项目文件`);
            break;
          }
        }
      }
    }
    
    if (!extractedDir) {
      throw new Error('无法找到解压后的项目目录');
    }
    
    for (const file of serverFiles) {
      const srcPath = path.join(extractedDir, file);
      const destPath = path.join(__dirname, file);
      const backupPath = path.join(backupDir, file);
      
      if (fs.existsSync(srcPath)) {
        // 备份现有文件
        if (fs.existsSync(destPath)) {
          fs.copyFileSync(destPath, backupPath);
        }
        // 更新文件
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✅ 已更新: ${file}`);
      }
    }
    
    // 更新插件文件（如果存在）
    const pluginSrcDir = path.join(extractedDir, 'figma-plugin');
    const pluginDestDir = path.join(__dirname, 'figma-plugin');
    if (fs.existsSync(pluginSrcDir) && fs.existsSync(pluginDestDir)) {
      const pluginFiles = ['manifest.json', 'code.js', 'ui.html'];
      for (const file of pluginFiles) {
        const srcPath = path.join(pluginSrcDir, file);
        const destPath = path.join(pluginDestDir, file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`   ✅ 已更新插件: ${file}`);
        }
      }
    }
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    
    // 通知用户更新完成
    targetGroup.figma.send(JSON.stringify({
      type: 'server-update-progress',
      status: 'completed',
      message: '更新完成！请重启服务器以使用新版本',
      version: releaseInfo.tag_name
    }));
    
    console.log(`   ✅ 服务器更新完成: ${releaseInfo.tag_name}`);
    console.log(`   💡 请运行 'npm install' 安装新依赖（如有）`);
    console.log(`   💡 然后重启服务器\n`);
    
  } catch (error) {
    console.error(`   ❌ 服务器更新失败: ${error.message}`);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      targetGroup.figma.send(JSON.stringify({
        type: 'server-update-progress',
        status: 'error',
        message: `更新失败: ${error.message}`
      }));
    }
  }
}

// 统一全量更新功能（插件 + 服务器所有代码）
async function handleFullUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    console.log('   ❌ Figma 客户端未连接，无法执行更新');
    return;
  }
  
  // 为整个更新流程添加总体超时（10分钟）
  const overallTimeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('更新超时（超过10分钟），请检查网络连接或稍后重试')), 600000);
  });
  
  const updateTask = (async () => {
    console.log('\n🔄 [Full Update] 开始全量更新（插件 + 服务器）...');
    console.log(`   📋 连接ID: ${connectionId}`);
    console.log(`   ⏰ 开始时间: ${new Date().toLocaleTimeString()}`);
    
    // 通知用户开始更新
    targetGroup.figma.send(JSON.stringify({
      type: 'update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    }));
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const https = require('https');
    
    console.log(`   📥 从 GitHub API 获取最新版本: ${apiUrl}`);
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Full-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      console.log(`   🌐 正在请求 GitHub API...`);
      const req = https.get(apiUrl, options, (res) => {
        console.log(`   📡 GitHub API 响应状态: ${res.statusCode}`);
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              console.log(`   ✅ 成功获取 Release 信息`);
              resolve(parsed);
            } catch (e) {
              console.error(`   ❌ JSON 解析失败:`, e.message);
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            console.error(`   ❌ GitHub API 错误: ${res.statusCode}`);
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      });
      
      // 正确设置超时
      req.setTimeout(30000, () => {
        req.destroy();
        console.error(`   ❌ GitHub API 请求超时（30秒）`);
        reject(new Error('GitHub API 请求超时（30秒）'));
      });
      
      req.on('error', (error) => {
        console.error(`   ❌ 网络请求错误:`, error.message);
        reject(error);
      });
    });
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 🔧 关键修复：必须使用 Release Assets 中的完整 UserPackage
    // GitHub 的 tarball_url 只是源码快照，不包含编译后的插件和完整文件结构
    let downloadUrl;
    let updateFilename;
    let updateSize = 0;
    
    console.log(`   📦 正在查找完整更新包...`);
    console.log(`   Available assets:`, releaseInfo.assets.map(a => a.name).join(', '));
    
    // 检测当前系统架构
    const arch = process.arch; // 'arm64' for Apple Silicon, 'x64' for Intel
    const isAppleSilicon = arch === 'arm64';
    console.log(`   🖥️  系统架构: ${arch} (${isAppleSilicon ? 'Apple Silicon' : 'Intel'})`);
    
    // 查找对应架构的更新包，优先使用新命名格式
    let updateAsset = null;
    
    if (isAppleSilicon) {
      // Apple Silicon: 优先找 ScreenSync-Apple，其次找 UserPackage
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      // Intel: 优先找 ScreenSync-Intel，其次找 UserPackage
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 如果没找到架构特定的包，尝试找通用的 UserPackage
    if (!updateAsset) {
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-UserPackage') && asset.name.endsWith('.tar.gz')
      );
    }
    
    if (!updateAsset) {
      console.error(`   ❌ 未找到更新包`);
      console.error(`   Available assets:`, releaseInfo.assets.map(a => a.name));
      throw new Error(`未找到适合 ${isAppleSilicon ? 'Apple Silicon' : 'Intel'} 的更新包。请确保 Release 中已上传 ScreenSync-Apple.tar.gz 或 ScreenSync-Intel.tar.gz。`);
    }
    
    downloadUrl = updateAsset.browser_download_url;
    updateFilename = updateAsset.name;
    updateSize = updateAsset.size;
    console.log(`   ✅ 找到完整更新包: ${updateFilename}`);
    console.log(`   📦 文件大小: ${(updateSize / 1024 / 1024).toFixed(2)} MB`);
    
    // 通知用户正在下载
    targetGroup.figma.send(JSON.stringify({
      type: 'update-progress',
      status: 'downloading',
      message: '正在下载更新包...'
    }));
    
    // 下载更新包
    // const downloadUrl = updateAsset.browser_download_url; // 已定义
    const tempFile = path.join(__dirname, '.full-update-temp.tar.gz');
    const updateDir = path.join(__dirname, '.full-update');
    
    console.log(`   📥 下载地址: ${downloadUrl}`);
    console.log(`   📦 文件大小: ${(updateSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   ⏳ 开始下载...`);
    
    // 下载文件（带进度报告和超时保护）
    const downloadTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('下载超时（超过5分钟）')), 300000);
    });
    
    // 进度回调函数
    const onDownloadProgress = (downloaded, total, percent) => {
      const downloadedMB = (downloaded / 1024 / 1024).toFixed(2);
      const totalMB = (total / 1024 / 1024).toFixed(2);
      console.log(`   📥 下载进度: ${percent}% (${downloadedMB}MB / ${totalMB}MB)`);
      
      // 通知 Figma 插件下载进度
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify({
          type: 'update-progress',
          status: 'downloading',
          message: `正在下载... ${percent}%`,
          progress: percent
        }));
      }
    };
    
    await Promise.race([
      downloadFileWithRedirect(downloadUrl, tempFile, onDownloadProgress),
      downloadTimeout
    ]);
    
    const downloadedSize = fs.statSync(tempFile).size;
    console.log(`   ✅ 下载完成: ${tempFile}`);
    console.log(`   📦 实际大小: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`);
    
    // 通知用户正在解压
    console.log(`   📦 开始解压文件...`);
    targetGroup.figma.send(JSON.stringify({
      type: 'update-progress',
      status: 'extracting',
      message: '正在解压更新包...'
    }));
    
    // 解压到临时目录
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    fs.mkdirSync(updateDir, { recursive: true });
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // 解压 tar.gz
    console.log(`   📦 开始解压 tar.gz 文件...`);
    await execPromise(`tar -xzf "${tempFile}" -C "${updateDir}"`);
    console.log(`   ✅ 解压完成到: ${updateDir}`);
    
    // 通知用户正在检查文件
    targetGroup.figma.send(JSON.stringify({
      type: 'update-progress',
      status: 'checking',
      message: '正在检查文件变化...'
    }));
    
    // 查找解压后的内容目录
    // 策略：递归查找 server.js 所在的目录（支持深层目录结构如 项目文件/）
    const findServerJs = (dir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth) return null;
      
      try {
        const items = fs.readdirSync(dir);
        // 忽略隐藏文件
        const visibleItems = items.filter(item => !item.startsWith('.'));
        
        // 检查当前目录是否包含 server.js 和 package.json
        if (visibleItems.includes('server.js') && visibleItems.includes('package.json')) {
          console.log(`   ✅ 在深度 ${depth} 找到项目文件: ${dir}`);
          return dir;
        }
        
        // 递归搜索子目录
        for (const item of visibleItems) {
          const itemPath = path.join(dir, item);
          try {
            if (fs.statSync(itemPath).isDirectory()) {
              const result = findServerJs(itemPath, depth + 1, maxDepth);
              if (result) return result;
            }
          } catch (e) {
            // 忽略无法访问的目录
          }
        }
      } catch (e) {
        // 忽略无法读取的目录
      }
      return null;
    };
    
    console.log(`   🔍 开始搜索项目文件目录...`);
    let extractedDir = findServerJs(updateDir);
    
    if (!extractedDir) {
        console.log('   ⚠️  未自动定位到根目录，尝试使用解压根目录');
        // 如果解压出来只有一个文件夹，进入该文件夹
        const extractedItems = fs.readdirSync(updateDir).filter(item => !item.startsWith('.'));
        console.log(`   Extracted items:`, extractedItems);
        
        if (extractedItems.length === 1 && fs.statSync(path.join(updateDir, extractedItems[0])).isDirectory()) {
          extractedDir = path.join(updateDir, extractedItems[0]);
          // 再次尝试在这个目录中查找
          const nestedDir = findServerJs(extractedDir);
          if (nestedDir) {
            extractedDir = nestedDir;
          }
        } else {
          extractedDir = updateDir;
        }
    }
    
    console.log(`   📂 最终内容目录: ${extractedDir}`);
    
    // 🔧 验证目录结构
    const requiredFiles = ['server.js', 'package.json'];
    const requiredDirs = ['figma-plugin'];
    const missingItems = [];
    
    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(extractedDir, file))) {
        missingItems.push(file);
      }
    }
    
    for (const dir of requiredDirs) {
      if (!fs.existsSync(path.join(extractedDir, dir))) {
        missingItems.push(dir + '/');
      }
    }
    
    if (missingItems.length > 0) {
      console.error(`   ❌ 更新包不完整，缺少以下文件/目录:`, missingItems);
      console.error(`   ❌ 目录内容:`, fs.readdirSync(extractedDir));
      throw new Error(`更新包不完整，缺少必需的文件: ${missingItems.join(', ')}`);
    }
    
    console.log(`   ✅ 目录结构验证通过`);
    
    // 备份现有文件
    const backupDir = path.join(__dirname, '.full-backup');
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(backupDir, { recursive: true });
    
    // 需要更新的所有文件列表
    const allFiles = [
      // 服务器核心文件
      'server.js',
      'start.js',
      // Google Drive 相关
      'googleDrive.js',
      'drive-watcher.js',
      // 阿里云 OSS 相关
      'aliyunOSS.js',
      'aliyun-watcher.js',
      // iCloud 相关
      'icloud-watcher.js',
      // 配置和工具
      'userConfig.js',
      'update-manager.js',
      'package.json',
      'VERSION.txt'
    ];
    
    // 🚀 增量更新：只更新有变化的文件
    const crypto = require('crypto');
    
    // 计算文件 hash
    const getFileHash = (filePath) => {
      try {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
      } catch (error) {
        return null;
      }
    };
    
    // 备份并更新服务器文件
    let updatedCount = 0;
    let skippedCount = 0;
    let newFilesCount = 0;
    
    console.log(`   🔍 开始对比文件变化...`);
    
    for (const file of allFiles) {
      const srcPath = path.join(extractedDir, file);
      const destPath = path.join(__dirname, file);
      const backupPath = path.join(backupDir, file);
      
      if (!fs.existsSync(srcPath)) {
        console.log(`   ⚠️  源文件不存在，跳过: ${file}`);
        continue;
      }
      
      // 检查目标文件是否存在
      const destExists = fs.existsSync(destPath);
      
      if (!destExists) {
        // 新文件，直接复制
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✅ [新增] ${file}`);
        newFilesCount++;
        updatedCount++;
        continue;
      }
      
      // 对比文件内容
      const srcHash = getFileHash(srcPath);
      const destHash = getFileHash(destPath);
      
      if (srcHash === destHash) {
        // 文件内容相同，跳过
        console.log(`   ⏭️  [跳过] ${file} (无变化)`);
        skippedCount++;
        continue;
      }
      
      // 文件有变化，备份并更新
      fs.copyFileSync(destPath, backupPath);
      fs.copyFileSync(srcPath, destPath);
      console.log(`   ✅ [更新] ${file}`);
      updatedCount++;
    }
    
    console.log(`\n   📊 更新统计:`);
    console.log(`      • 更新文件: ${updatedCount} 个`);
    console.log(`      • 新增文件: ${newFilesCount} 个`);
    console.log(`      • 跳过文件: ${skippedCount} 个 (无变化)`);
    console.log(`      • 总计节省: ${skippedCount} 个文件的复制操作\n`);
    
    // 通知用户更新统计
    targetGroup.figma.send(JSON.stringify({
      type: 'update-progress',
      status: 'installing',
      message: `正在更新文件... (${updatedCount} 个文件需要更新)`
    }));
    
    // 🚀 增量更新插件文件
    const pluginSrcDir = path.join(extractedDir, 'figma-plugin');
    const pluginDestDir = path.join(__dirname, 'figma-plugin');
    
    if (fs.existsSync(pluginSrcDir) && fs.existsSync(pluginDestDir)) {
      const pluginFiles = ['manifest.json', 'code.js', 'ui.html'];
      const pluginBackupDir = path.join(backupDir, 'figma-plugin');
      fs.mkdirSync(pluginBackupDir, { recursive: true });
      
      console.log(`   🔍 开始对比插件文件变化...`);
      let pluginUpdated = 0;
      let pluginSkipped = 0;
      
      for (const file of pluginFiles) {
        const srcPath = path.join(pluginSrcDir, file);
        const destPath = path.join(pluginDestDir, file);
        const backupPath = path.join(pluginBackupDir, file);
        
        if (!fs.existsSync(srcPath)) {
          console.log(`   ⚠️  源文件不存在，跳过: figma-plugin/${file}`);
          continue;
        }
        
        const destExists = fs.existsSync(destPath);
        
        if (!destExists) {
          // 新文件
          fs.copyFileSync(srcPath, destPath);
          console.log(`   ✅ [新增] figma-plugin/${file}`);
          pluginUpdated++;
          updatedCount++;
          continue;
        }
        
        // 对比文件内容
        const srcHash = getFileHash(srcPath);
        const destHash = getFileHash(destPath);
        
        if (srcHash === destHash) {
          // 文件内容相同，跳过
          console.log(`   ⏭️  [跳过] figma-plugin/${file} (无变化)`);
          pluginSkipped++;
          skippedCount++;
          continue;
        }
        
        // 备份并更新
        fs.copyFileSync(destPath, backupPath);
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✅ [更新] figma-plugin/${file}`);
        pluginUpdated++;
        updatedCount++;
      }
      
      console.log(`\n   📊 插件更新统计:`);
      console.log(`      • 更新文件: ${pluginUpdated} 个`);
      console.log(`      • 跳过文件: ${pluginSkipped} 个 (无变化)\n`);
    }
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    
    console.log(`\n✅ [Full Update] 全量更新完成！`);
    console.log(`   ✅ 成功更新 ${updatedCount} 个文件`);
    console.log(`   📦 备份位置: ${backupDir}`);
    console.log(`   🔄 准备自动重启服务器以应用更新...\n`);
    
    // 通知用户更新完成（在重启前发送）
    if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      targetGroup.figma.send(JSON.stringify({
        type: 'update-progress',
        status: 'completed',
        message: `更新完成！服务器将自动重启...`,
        updatedCount: updatedCount,
        latestVersion: releaseInfo.tag_name // 发送最新版本号
      }));
    }
    
    // 延迟 2 秒后自动重启服务器（让前端收到消息）
    setTimeout(() => {
      console.log(`\n🔄 [Full Update] 正在重启服务器以应用更新...`);
      
      // 如果是通过 launchd 运行的，直接退出进程，launchd 会自动重启
      if (process.env.LAUNCHED_BY_LAUNCHD || fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents/com.screensync.server.plist'))) {
        console.log('   ✅ 检测到 launchd 服务，进程退出后将自动重启');
        process.exit(0); // 正常退出，launchd 会自动重启
      } else {
        // 手动运行的情况，使用 spawn 重启
        console.log('   ✅ 手动重启服务器进程');
        const { spawn } = require('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        process.exit(0);
      }
    }, 2000);
    
    console.log(`   ⏱️  总耗时: ${((Date.now() - Date.now()) / 1000).toFixed(2)}秒`);
  })(); // 结束 updateTask
  
  // 应用总体超时
  try {
    await Promise.race([updateTask, overallTimeout]);
  } catch (error) {
    console.error(`   ❌ 全量更新失败: ${error.message}`);
    console.error('   错误堆栈:', error.stack);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      try {
        targetGroup.figma.send(JSON.stringify({
          type: 'update-progress',
          status: 'error',
          message: `更新失败: ${error.message}`
        }));
      } catch (sendError) {
        console.error('   ❌ 发送错误消息失败:', sendError.message);
      }
    }
  }
}

const PORT = process.env.PORT || 8888;
const HOST = process.env.HOST || '0.0.0.0';

// 启动服务器，添加错误处理
try {
server.listen(PORT, HOST, () => {
  console.log('✅ 服务器运行在: http://' + HOST + ':' + PORT);
  console.log('📊 健康检查: http://' + HOST + ':' + PORT + '/health');
  console.log('⏳ 等待连接...\n');
    
    // Cloud Run 环境检测
    if (process.env.PORT) {
      console.log('🌐 Cloud Run 环境检测到，服务已就绪');
      console.log('   PORT:', process.env.PORT);
      console.log('   HOST:', HOST);
    }
  });
  
  // 处理服务器启动错误
  server.on('error', (error) => {
    console.error('❌ 服务器启动失败:', error.message);
    if (error.code === 'EADDRINUSE') {
      console.error('   端口已被占用');
    }
    process.exit(1);
  });
} catch (error) {
  console.error('❌ 启动服务器时发生错误:', error);
  process.exit(1);
}

process.on('SIGINT', () => {
  console.log('\n\n👋 关闭服务器...');
  server.close(() => process.exit(0));
});