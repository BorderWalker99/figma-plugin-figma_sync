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
const fs = require('fs');
const os = require('os');

// Inject ScreenSync local deps into PATH (for legacy macOS without Homebrew)
(() => {
  const dirs = [
    path.join(os.homedir(), '.screensync', 'bin'),
    path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin'),
    path.join(os.homedir(), '.screensync', 'deps', 'imagemagick', 'bin')
  ];
  for (const d of dirs) {
    if (fs.existsSync(d) && !process.env.PATH.includes(d)) {
      process.env.PATH = `${d}:${process.env.PATH}`;
    }
  }
  // Set MAGICK_HOME for compiled-from-source ImageMagick
  const imHome = path.join(os.homedir(), '.screensync', 'deps', 'imagemagick');
  if (fs.existsSync(path.join(imHome, 'bin', 'magick')) && !process.env.MAGICK_HOME) {
    process.env.MAGICK_HOME = imHome;
    const imLib = path.join(imHome, 'lib');
    if (fs.existsSync(imLib)) {
      process.env.DYLD_LIBRARY_PATH = imLib + (process.env.DYLD_LIBRARY_PATH ? ':' + process.env.DYLD_LIBRARY_PATH : '');
    }
  }
})();

// ─── WebSocket send helpers ───────────────────────────────────────────────────
// Safely send JSON via WebSocket (no-op if ws is null or not OPEN)
function wsSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

// Send to the Figma client inside a connection group
function sendToFigma(group, data) {
  return wsSend(group && group.figma, data);
}

// Send to the Mac client inside a connection group
function sendToMac(group, data) {
  return wsSend(group && group.mac, data);
}

// ─── DRIVE_FOLDER_ID fallback ─────────────────────────────────────────────────
// Centralised helper – eliminates 3+ duplicate blocks
function getEffectiveDriveFolderId(envFolderId) {
  if (envFolderId) return envFolderId;
  try {
    const sak = require('./serviceAccountKey');
    if (sak && sak.defaultFolderId) return sak.defaultFolderId;
  } catch (_) { /* ignore */ }
  return null;
}

// ─── Shared validation / resolution helpers ──────────────────────────────────
// Deduplicated from HTTP upload routes (/upload, /upload-oss, /upload-url)

function validateUserId(userId, res) {
  if (!userId) {
    console.warn('🚫 拒绝：未提供用户ID');
    res.status(403).json({ error: 'User ID required.', code: 'USER_ID_REQUIRED' });
    return false;
  }
  return true;
}

function validateUploadToken(token, res) {
  if (UPLOAD_TOKEN && token !== UPLOAD_TOKEN) {
    res.status(401).json({ error: 'Invalid upload token', code: 'INVALID_TOKEN' });
    return false;
  }
  return true;
}

function resolveDefaultFolderId(useOSS) {
  if (useOSS) {
    return process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
  }
  return getEffectiveDriveFolderId(DRIVE_FOLDER_ID);
}

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
  
  getUserFolderId = userConfig.getUserFolderId;
  
  // 为上传接口初始化用户文件夹的函数（带缓存）
  // 在 Cloud Run 上，无法访问本地配置文件，所以需要根据 userId 创建文件夹
  initializeUserFolderForUpload = async (userId) => {
    let DRIVE_FOLDER_ID = getEffectiveDriveFolderId(process.env.GDRIVE_FOLDER_ID);
    
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
  
} catch (error) {
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
  
  if (!getUserFolderId) {
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
  
} catch (error) {
}

// 读取同步模式配置文件（如果存在）
const syncModeFile = path.join(__dirname, '.sync-mode');
const userConfigFile = path.join(__dirname, '.user-config.json');

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
    
    const ext = path.extname(safeFilename).toLowerCase();
    const isGif = ext === '.gif' || (mimeType && mimeType === 'image/gif');
    
    let finalPath = filePath;
    if (fs.existsSync(finalPath)) {
      if (isGif) {
        console.log(`   🔄 [Server] 检测到重名 GIF 文件，将替换: ${safeFilename}`);
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
    // ========================================
    // 1. 清理 os.tmpdir() 下的 ScreenSync 残留
    // ========================================
    const tmpBase = os.tmpdir();
    const tmpDirsToClean = [
      'screensync-preview-frames',  // 时间线预览帧
      'screensync-upload'           // 上传临时文件
    ];
    for (const dirName of tmpDirsToClean) {
      const dirPath = path.join(tmpBase, dirName);
      if (fs.existsSync(dirPath)) {
        try {
          removeDirRecursive(dirPath);
          console.log(`   ✅ 清理 tmpdir/${dirName}`);
        } catch (e) {
          console.warn(`   ⚠️  清理 tmpdir/${dirName} 失败:`, e.message);
        }
      }
    }
    // 清理散落在 tmpdir 根目录的 HEIF 转换残留文件
    try {
      const tmpFiles = fs.readdirSync(tmpBase);
      for (const f of tmpFiles) {
        if ((f.startsWith('heif-input-') && f.endsWith('.heic')) ||
            (f.startsWith('jpeg-output-') && f.endsWith('.jpg'))) {
          try { fs.unlinkSync(path.join(tmpBase, f)); } catch (e) {}
        }
      }
    } catch (e) {}
    
    // ========================================
    // 2. 清理用户文件夹下的临时合成目录
    // ========================================
    // iCloud 路径
    const icloudPath = path.join(
      os.homedir(),
      'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
    );
    
    // 本地路径
    let localPath;
    try {
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
            }
          } catch (cleanupError) {
            console.warn(`   ⚠️  清理临时文件夹失败: ${item}`, cleanupError.message);
          }
        }
      }
      
      // ========================================
      // 3. 清理 .gif_process_cache 中超过 7 天的缓存
      // ========================================
      const processCacheDir = path.join(folder, '.gif_process_cache');
      if (fs.existsSync(processCacheDir)) {
        try {
          const cacheFiles = fs.readdirSync(processCacheDir);
          const now = Date.now();
          const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
          const MAX_CACHE_SIZE = 200; // 最多保留 200 个缓存文件
          let deletedCount = 0;
          
          // 按修改时间排序（旧的在前）
          const fileInfos = cacheFiles.map(f => {
            const fp = path.join(processCacheDir, f);
            try {
              const stat = fs.statSync(fp);
              return { name: f, path: fp, mtime: stat.mtimeMs, size: stat.size };
            } catch (e) {
              return { name: f, path: fp, mtime: 0, size: 0 };
            }
          }).sort((a, b) => a.mtime - b.mtime);
          
          // 删除超过 7 天的 + 超出数量限制的（保留最新的 MAX_CACHE_SIZE 个）
          const excessCount = Math.max(0, fileInfos.length - MAX_CACHE_SIZE);
          for (let i = 0; i < fileInfos.length; i++) {
            const info = fileInfos[i];
            const isOld = (now - info.mtime) > MAX_AGE_MS;
            const isExcess = i < excessCount;
            if (isOld || isExcess) {
              try { fs.unlinkSync(info.path); deletedCount++; } catch (e) {}
            }
          }
          
          if (deletedCount > 0) {
            console.log(`   ✅ 清理 .gif_process_cache: 删除 ${deletedCount} 个旧文件 (剩余 ${fileInfos.length - deletedCount})`);
          }
        } catch (e) {
          console.warn('   ⚠️  清理 .gif_process_cache 失败:', e.message);
        }
      }
      
      // ========================================
      // 4. 清理 .gif_cache（上传缓存）中超过 7 天的文件
      // ========================================
      const uploadCacheDir = path.join(folder, '.gif_cache');
      if (fs.existsSync(uploadCacheDir)) {
        try {
          const cacheFiles = fs.readdirSync(uploadCacheDir);
          const now = Date.now();
          const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
          let deletedCount = 0;
          let deletedSize = 0;
          for (const f of cacheFiles) {
            const fp = path.join(uploadCacheDir, f);
            try {
              const stat = fs.statSync(fp);
              if ((now - stat.mtimeMs) > MAX_AGE_MS) {
                deletedSize += stat.size;
                fs.unlinkSync(fp);
                deletedCount++;
              }
            } catch (e) {}
          }
          if (deletedCount > 0) {
            console.log(`   ✅ 清理 .gif_cache: 删除 ${deletedCount} 个旧文件 (${(deletedSize / 1024 / 1024).toFixed(2)} MB)`);
          }
          // 如果清空了，删除目录本身
          try {
            const remaining = fs.readdirSync(uploadCacheDir);
            if (remaining.length === 0) fs.rmdirSync(uploadCacheDir);
          } catch (e) {}
        } catch (e) {}
      }
      
      // ========================================
      // 5. 精简 .cache-mapping.json（保留最新 500 条）
      // ========================================
      const mappingFile = path.join(folder, '.cache-mapping.json');
      if (fs.existsSync(mappingFile)) {
        try {
          const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
          const keys = Object.keys(mapping);
          if (keys.length > 500) {
            const trimmed = {};
            const keepKeys = keys.slice(keys.length - 500); // 保留最新 500 条
            for (const k of keepKeys) {
              trimmed[k] = mapping[k];
            }
            fs.writeFileSync(mappingFile, JSON.stringify(trimmed, null, 2));
            console.log(`   ✅ 精简 .cache-mapping.json: ${keys.length} → 500 条`);
          }
        } catch (e) {
          // 如果文件损坏，直接删除
          try { fs.unlinkSync(mappingFile); } catch (e2) {}
          console.warn('   ⚠️  .cache-mapping.json 已损坏，已删除');
        }
      }
    }
  } catch (error) {
    console.warn('⚠️  启动清理时出错（可忽略）:', error.message);
  }
}


// ─── GIF Composition Engine (extracted to gif-composer.js) ────────────────────
const composeAnnotatedGif = require('./gif-composer')({ execAsyncCancellable, removeDirRecursive, userConfig });


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
DRIVE_FOLDER_ID = getEffectiveDriveFolderId(DRIVE_FOLDER_ID);
if (DRIVE_FOLDER_ID && !process.env.GDRIVE_FOLDER_ID) {
  console.log('ℹ️  使用默认的 Google Drive 根文件夹ID（从 serviceAccountKey.js）');
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
      return;
    }

    // 记录大文件任务加入队列
    const isVideo = task.filename && (task.filename.toLowerCase().endsWith('.mp4') || task.filename.toLowerCase().endsWith('.mov'));
    const isGif = task.filename && task.filename.toLowerCase().endsWith('.gif');
    const dataSize = task.data ? (typeof task.data === 'string' ? task.data.length : JSON.stringify(task.data).length) : 0;
    const dataSizeMB = (dataSize / 1024 / 1024).toFixed(2);
    
    if (isVideo || isGif || dataSize > 10 * 1024 * 1024) {
    }

    this.queue.push(task);
    const queueLength = this.queue.length;
    const waitTime = Date.now() - task.startTime;
    
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
                let folderId = getEffectiveDriveFolderId(DRIVE_FOLDER_ID);
                if (!folderId) {
                  console.error(`❌ [上传] 严重错误：无法获取 GDRIVE_FOLDER_ID (环境变量和配置文件都为空)`);
                  throw new Error('未配置 GDRIVE_FOLDER_ID，无法上传文件');
                }
                return folderId;
              }
            }
            let folderId = getEffectiveDriveFolderId(DRIVE_FOLDER_ID);
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
                  } catch (e) {
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
                    } else {
                    }
                  }
                  
                  // 检查 MP4 文件格式
                  if (detectedMime.toLowerCase() === 'video/mp4') {
                    const fileHeader = buffer.slice(0, 12).toString('ascii');
                    const isValidMP4 = fileHeader.includes('ftyp') || buffer.slice(4, 8).toString('ascii').includes('mp4');
                    
                    if (!isValidMP4) {
                      console.log(`   ⚠️  [Base64解码] 警告：解码后的 MP4 文件可能无效`);
                    } else {
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
          targetFolderId = resolveDefaultFolderId(useOSS);
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
            targetFolderId = resolveDefaultFolderId(useOSS);
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
          } else {
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
        targetFolderId = resolveDefaultFolderId(useOSS);
        if (!targetFolderId) {
          throw new Error('无法获取目标文件夹ID，无法上传文件');
        }
      }

      // 大文件预上传压缩：>50MB 的 GIF/视频在上传到 Drive 前先压缩
      const COMPRESS_THRESHOLD = 50 * 1024 * 1024; // 50MB
      if ((isVideo || isGif) && finalBuffer && finalBuffer.length > COMPRESS_THRESHOLD) {
        const origSizeMB = (finalBuffer.length / 1024 / 1024).toFixed(1);
        const tempDir = path.join(os.tmpdir(), `screensync-compress-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });
        const tempIn = path.join(tempDir, finalFilename);
        const tempOut = path.join(tempDir, `c_${finalFilename}`);
        fs.writeFileSync(tempIn, finalBuffer);
        
        try {
          if (isGif) {
            console.log(`   🎬 [上传压缩] GIF ${origSizeMB}MB > 50MB，gifsicle 压缩中...`);
            await execAsync(`gifsicle -O3 --lossy=30 "${tempIn}" -o "${tempOut}"`, { timeout: 300000 });
          } else {
            console.log(`   🎥 [上传压缩] 视频 ${origSizeMB}MB > 50MB，FFmpeg 压缩中...`);
            await execAsync(`ffmpeg -i "${tempIn}" -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 128k -movflags +faststart -y "${tempOut}"`, { timeout: 300000 });
          }
          
          if (fs.existsSync(tempOut)) {
            const compressedBuf = fs.readFileSync(tempOut);
            const newSizeMB = (compressedBuf.length / 1024 / 1024).toFixed(1);
            const ratio = ((1 - compressedBuf.length / finalBuffer.length) * 100).toFixed(1);
            console.log(`   ✅ [上传压缩] ${origSizeMB}MB → ${newSizeMB}MB (节省 ${ratio}%)`);
            finalBuffer = compressedBuf;
          }
        } catch (compErr) {
          console.warn(`   ⚠️  [上传压缩] 压缩失败，使用原始文件: ${compErr.message}`);
        }
        
        // 清理临时文件
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }

      // GIF 大文件先保存到本地以供手动导入（视频文件不保留本地副本）
      if (isGif && finalBuffer) {
        const saved = saveFileToLocalFolder(finalBuffer, finalFilename, finalMimeType);
        if (saved) {
          for (const [id, group] of connections) {
            sendToFigma(group, {
              type: 'file-skipped',
              filename: finalFilename,
              reason: 'gif-too-large',
              timestamp: Date.now()
            });
          }
        }
      }
      
      // 上传到 Google Drive 或阿里云
      const uploadStartTime = Date.now();
      let result;
      
      if (useOSS) {
        result = await ossUploadBuffer({
          buffer: finalBuffer,
          filename: finalFilename,
          mimeType: finalMimeType,
          folderId: targetFolderId
        });
      } else {
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
          safeTargetFolderId = resolveDefaultFolderId(useOSS);
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
    
    // 监听请求完成或错误
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      console.log(`   ✅ [请求] ${req.path} 完成 - 状态: ${res.statusCode}, 耗时: ${duration}ms`);
    });
    
    res.on('close', () => {
      const duration = Date.now() - startTime;
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
      
      try {
        // 尝试将 Buffer 转换为字符串并解析 JSON
        const jsonString = buffer.toString('utf8');
        req.body = JSON.parse(jsonString);
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

// 启动时清理所有旧的临时文件夹和缓存
console.log('🧹 清理旧的临时文件夹和缓存...');
cleanupAllTempFolders();

// 清理 GIF 缓存（~/.screensync-gif-cache 或 .gif-cache）中超过 30 天的文件
try {
  const gifCacheStats = userConfig.getGifCacheStats();
  if (gifCacheStats.count > 0) {
    console.log(`   📊 GIF 缓存: ${gifCacheStats.count} 个文件, ${gifCacheStats.sizeMB} MB, 最旧 ${gifCacheStats.oldestDays} 天`);
  }
  const cleaned = userConfig.cleanOldGifCache(30);
  if (cleaned.cleaned > 0) {
    console.log(`   ✅ 清理 GIF 缓存: ${cleaned.cleaned} 个超过 30 天的文件, 释放 ${(cleaned.size / 1024 / 1024).toFixed(2)} MB`);
  }
} catch (e) {
  // 忽略（userConfig 可能未初始化）
}
console.log('');

// 定时自动清理（每 6 小时执行一次，静默运行）
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
setInterval(() => {
  try {
    cleanupAllTempFolders();
    userConfig.cleanOldGifCache(30);
  } catch (e) {
    // 静默忽略
  }
}, CLEANUP_INTERVAL_MS);

// 语言配置端点（供插件首次启动读取安装器设置的语言）
app.get('/language', (req, res) => {
  try {
    if (fs.existsSync(userConfigFile)) {
      const config = JSON.parse(fs.readFileSync(userConfigFile, 'utf8'));
      return res.json({ language: config.language || 'zh' });
    }
    res.json({ language: 'zh' });
  } catch (e) {
    res.json({ language: 'zh' });
  }
});

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
    
    if (!validateUserId(userId, res)) return;
    
    try {
      const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
      
      if (!OSS_ROOT_FOLDER) {
        return res.status(500).json({ error: 'Server not configured: missing ALIYUN_ROOT_FOLDER' });
      }

      if (!validateUploadToken(req.headers['x-upload-token'], res)) return;

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
        
        const estimatedOriginalSizeMB = (dataLength * 0.75 / 1024 / 1024).toFixed(2);
        
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
} else {
}

// Google Drive 上传接口（可选）
if (googleDriveEnabled && uploadBuffer) {
  app.post('/upload', async (req, res) => {
    const startTime = Date.now();
    const parseStartTime = Date.now();
    const userId = req.headers['x-user-id'] || req.body.userId || null;
    
    // 记录请求到达（在body解析之前）
    const contentLength = req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0;
    
    if (!validateUserId(userId, res)) return;
    
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
      let currentDriveFolderId = getEffectiveDriveFolderId(DRIVE_FOLDER_ID);
      
      if (!currentDriveFolderId) {
        return res.status(500).json({ error: 'Server not configured: missing GDRIVE_FOLDER_ID' });
      }

      if (!validateUploadToken(req.headers['x-upload-token'], res)) return;

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
        
        // 估算原始文件大小（Base64 编码会增加约 33%）
        const estimatedOriginalSizeMB = (dataLength * 0.75 / 1024 / 1024).toFixed(2);
        
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

  // 获取断点续传 URL 接口 (支持 iPhone 直接上传到 Google Drive)
  // 解决大文件上传内存限制问题：iPhone -> Google Drive (绕过此服务器)
  const getResumableUploadUrl = require('./googleDrive').getResumableUploadUrl;
  if (getResumableUploadUrl) {
    app.post('/upload-url', async (req, res) => {
      const startTime = Date.now();
      const userId = req.headers['x-user-id'] || req.body.userId || null;
      const filename = req.body.filename;
      const mimeType = req.body.mimeType;

      if (!validateUserId(userId, res)) return;
      if (!validateUploadToken(req.headers['x-upload-token'], res)) return;

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
        

      } catch (error) {
        console.error(`❌ [Upload URL] 生成链接失败: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });
    console.log('✅ Google Drive 断点续传 URL 接口已启用: POST /upload-url');
  }

} else {
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const connectionId = params.get('id');
  const clientType = params.get('type');
  
  if (!connectionId || !clientType) {
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
      try {
        oldWs.close();
      } catch (error) {
      }
    }
  }
  
  group[clientType] = ws;
  
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
      wsSend(ws, { type: 'pong' });
      return;
    }
    
    const targetGroup = connections.get(connectionId);
    
    // 插件实例注册（单实例限制）
    if (data.type === 'register-instance' && clientType === 'figma') {
      
      // 检查是否有旧实例
      const oldInstance = userInstances.get(connectionId);
      if (oldInstance && oldInstance.figmaWs && oldInstance.figmaWs !== ws) {
        // 如果旧实例的连接仍然有效，向其发送关闭命令
        if (oldInstance.figmaWs.readyState === 1) { // OPEN
          console.log(`   ⚠️  检测到旧实例，发送关闭命令`);
          try {
            wsSend(oldInstance.figmaWs, { type: 'force-close' });
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
      const homeDir = os.homedir();
      const plistPath = `${homeDir}/Library/LaunchAgents/com.screensync.server.plist`;
      
      // 先卸载
      exec(`launchctl unload "${plistPath}"`, (unloadError) => {
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
            if (targetGroup) {
              sendToFigma(targetGroup, {
                type: 'repair-server-response',
                success: !startError,
                message: startError ? '修复失败：' + startError.message : '服务已修复并重启'
              });
            }
          });
        });
      });
      return;
    }
    if (!targetGroup) {
      return;
    }
    
    // 控制消息处理
    if (data.type === 'start-realtime' || 
        data.type === 'stop-realtime' || 
        data.type === 'manual-sync' ||
        data.type === 'manual-sync-count-files' ||
        data.type === 'cancel-manual-sync') {
      if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
        try {
          sendToMac(targetGroup, data);
          console.log(`   ✅ 已转发到 Mac 端: ${data.type}`);
        } catch (error) {
          console.log('   ❌ 发送到Mac端失败:', error.message);
        }
      } else {
        // 通知Figma Mac端未连接
        if (clientType === 'figma') {
          sendToFigma(targetGroup, {
            type: 'error',
            message: 'Mac端未连接'
          });
        }
      }
      return;
    }
    
    // 打开文件夹
    if (data.type === 'open-folder') {
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
      } else {
        // Google Drive 或其他模式：打开 ScreenSyncImg 下的子文件夹
        const baseFolder = userConfig.getLocalDownloadFolder();
        targetFolder = path.join(baseFolder, subFolder);
      }
      
      if (fs.existsSync(targetFolder)) {
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
      cancelFlags.set(connectionId, true);
      
      // ✅ 立即终止所有活动的子进程（ImageMagick、FFmpeg 等）
      killActiveProcesses(connectionId);

      // 发送取消确认消息到 Figma
      const targetGroup = connections.get(connectionId);
      if (targetGroup) {
        sendToFigma(targetGroup, {
          type: 'gif-compose-cancelled',
          message: '导出已取消'
        });
        console.log('   ✅ 已发送取消确认到 Figma');
      }
      return;
    }
    
    // ✅ 处理缓存检查请求 (由 code.js 触发，用于自动关联未同步的 Video/GIF)
    if (data.type === 'check-cache-existence') {
      const results = [];
      const mappingFile = path.join(userConfig.getLocalDownloadFolder(), '.cache-mapping.json');
      let mapping = {};
      
      // 读取映射文件
      if (fs.existsSync(mappingFile)) {
        try {
          mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        } catch (e) {
          console.warn(`   ⚠️ 读取映射文件失败:`, e.message);
        }
      } else {
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
          }
        }
      }

      // 发送结果回 Figma
      const targetGroup = connections.get(connectionId);
      if (targetGroup) {
        sendToFigma(targetGroup, {
          type: 'cache-existence-result',
          results: results
        });
      }
      return;
    }

    // 处理保存手动拖入的视频/GIF到缓存的请求
    if (data.type === 'cache-manual-video') {
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
          
          // 返回缓存ID给Figma插件
          wsSend(ws, {
            type: 'cache-manual-video-success',
            filename: data.filename,
            cacheId: cacheResult.cacheId,
            cachePath: cacheResult.cachePath
          });
        } else {
          throw new Error('保存到缓存失败');
        }
      } catch (error) {
        console.error('   ❌ 保存文件到缓存失败:', error.message);
        wsSend(ws, {
          type: 'cache-manual-video-error',
          filename: data.filename,
          error: error.message
        });
      }
      return;
    }
    
    // 🔄 自动缓存：Figma 拖入视频/GIF 时，自动缓存文件
    // 两条路径：① 有 base64 数据（来自 getBytesAsync）→ 直接缓存  ② 只有文件名 → 磁盘搜索
    if (data.type === 'auto-cache-video-by-search') {
      const { filename, timestamp, base64 } = data;
      
      try {
        if (!filename) throw new Error('缺少文件名');
        let fileBuffer = null;
        
        // ✅ 路径①：有 base64 数据 → 直接解码为 Buffer（最可靠）
        if (base64) {
          fileBuffer = Buffer.from(base64, 'base64');
        }
        
        // ⚠️ 路径②：没有 base64 → 在磁盘上搜索文件
        if (!fileBuffer) {
          const currentMode = process.env.SYNC_MODE || 'drive';
          let baseFolder;
          if (currentMode === 'icloud') {
            baseFolder = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg');
          } else {
            baseFolder = userConfig.getLocalDownloadFolder();
          }
          
          const searchPaths = [
            baseFolder,
            path.join(baseFolder, '视频'),
            path.join(baseFolder, 'GIF'),
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents'),
            path.join(os.homedir(), 'Movies')
          ];
          
          const mediaExtensions = ['.mp4', '.mov', '.gif', '.webm', '.avi', '.mkv', '.m4v'];
          const nameNoExt = filename.replace(/\.[^/.]+$/, '');
          const cleanName = nameNoExt.replace(/\s+\d+$/, '').replace(/_\d+$/, '');
          
          let foundPath = null;
          
          for (const dir of searchPaths) {
            if (!fs.existsSync(dir)) continue;
            let files;
            try { files = fs.readdirSync(dir); } catch (e) { continue; }
            
            const mediaFiles = files.filter(f => !f.startsWith('.') && mediaExtensions.includes(path.extname(f).toLowerCase()));
            if (mediaFiles.length === 0) continue;
            
            // 精确匹配
            for (const file of mediaFiles) {
              if (file === filename) { foundPath = path.join(dir, file); break; }
            }
            // 模糊匹配
            if (!foundPath) {
              for (const file of mediaFiles) {
                const fileNoExt = file.replace(/\.[^/.]+$/, '');
                if (fileNoExt.toLowerCase() === nameNoExt.toLowerCase() ||
                    fileNoExt.toLowerCase() === cleanName.toLowerCase()) {
                  foundPath = path.join(dir, file); break;
                }
              }
            }
            if (foundPath) break;
          }
          
          if (foundPath && fs.existsSync(foundPath)) {
            fileBuffer = fs.readFileSync(foundPath);
          }
        }
        
        if (!fileBuffer || fileBuffer.length === 0) {
          console.log(`   ⚠️ 无法获取文件数据: ${filename}`);
          wsSend(ws, {
            type: 'auto-cache-video-result',
            filename, timestamp, success: false,
            error: '无法获取文件数据'
          });
          return;
        }
        
        // 保存到缓存
        const cacheResult = userConfig.saveGifToCache(fileBuffer, filename, null);
        
        if (cacheResult && cacheResult.cacheId) {
          // 同时更新 .cache-mapping.json
          try {
            const mappingFile = path.join(userConfig.getLocalDownloadFolder(), '.cache-mapping.json');
            let mapping = {};
            if (fs.existsSync(mappingFile)) {
              try { mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); } catch (e) {}
            }
            mapping[filename] = cacheResult.cacheId;
            fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
          } catch (mapErr) {
            console.warn('   ⚠️ 更新映射文件失败:', mapErr.message);
          }
          
          console.log(`   ✅ 自动缓存成功: cacheId=${cacheResult.cacheId}`);
          wsSend(ws, {
            type: 'auto-cache-video-result',
            filename, timestamp, success: true,
            cacheId: cacheResult.cacheId
          });
        } else {
          throw new Error('保存到缓存失败');
        }
      } catch (error) {
        console.error(`   ❌ 自动缓存失败:`, error.message);
        wsSend(ws, {
          type: 'auto-cache-video-result',
          filename, timestamp, success: false,
          error: error.message
        });
      }
      return;
    }
    
    // 处理上传本地 GIF/视频 请求
    if (data.type === 'upload-local-gif') {
      const startTime = Date.now();
      
      try {
        const filename = data.filename;
        const messageId = data.messageId;
        
        // 支持两种数据格式：base64（新）和 bytes 数组（旧）
        let bytes;
        if (data.base64) {
          bytes = Buffer.from(data.base64, 'base64');
        } else if (data.bytes) {
          bytes = Buffer.from(data.bytes);
        } else {
          throw new Error('缺少文件数据');
        }
        
        // 保存文件到临时目录
        const tempDir = path.join(os.tmpdir(), 'screensync-upload');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFilePath = path.join(tempDir, filename);
        fs.writeFileSync(tempFilePath, bytes);
        
        // 获取原始文件扩展名
        const fileExt = path.extname(filename).toLowerCase();
        
        const fileSizeMB = bytes.length / 1024 / 1024;
        const isVideo = ['.mov', '.mp4'].includes(fileExt);
        const isGif = fileExt === '.gif';
        const COMPRESS_THRESHOLD_MB = 50;
        const needsCompression = (isVideo || isGif) && fileSizeMB > COMPRESS_THRESHOLD_MB;
        
        let processedFilePath = tempFilePath;
        
        if (needsCompression) {
          const compressedPath = path.join(tempDir, `compressed_${filename}`);
          
          try {
            if (isGif) {
              // GIF: gifsicle 无损优化（保留所有帧和颜色，仅去除冗余数据）
              const gifsicleCmd = `gifsicle -O3 --lossy=30 "${tempFilePath}" -o "${compressedPath}"`;
              console.log(`   🎬 [压缩] GIF 文件 ${fileSizeMB.toFixed(1)}MB > ${COMPRESS_THRESHOLD_MB}MB，使用 gifsicle 压缩...`);
              await execAsync(gifsicleCmd, { timeout: 300000 }); // 5分钟超时
            } else {
              // 视频: FFmpeg 高质量压缩（CRF 18 近无损，保留原始帧率）
              const ffmpegCmd = `ffmpeg -i "${tempFilePath}" -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 128k -movflags +faststart -y "${compressedPath}"`;
              console.log(`   🎥 [压缩] 视频文件 ${fileSizeMB.toFixed(1)}MB > ${COMPRESS_THRESHOLD_MB}MB，使用 FFmpeg 压缩...`);
              await execAsync(ffmpegCmd, { timeout: 300000 });
            }
            
            if (fs.existsSync(compressedPath)) {
              const compressedStats = fs.statSync(compressedPath);
              const compressedSizeMB = compressedStats.size / 1024 / 1024;
              const compressionRatio = ((1 - compressedSizeMB / fileSizeMB) * 100).toFixed(1);
              
              console.log(`   ✅ 压缩完成: ${fileSizeMB.toFixed(2)}MB → ${compressedSizeMB.toFixed(2)}MB (节省 ${compressionRatio}%)`);
              processedFilePath = compressedPath;
              fs.unlinkSync(tempFilePath);
            } else {
              console.warn('   ⚠️  压缩输出文件不存在，使用原始文件');
            }
          } catch (error) {
            console.error('   ⚠️  压缩失败，使用原始文件:', error.message);
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
        
        // 计算总耗时
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`   ⏱️  总耗时: ${totalDuration}秒`);
        
        // 发送成功响应
        // 使用 cacheId 作为文件标识，与缓存系统一致
        wsSend(ws, {
          type: 'upload-gif-result',
          messageId: messageId,
          success: true,
          driveFileId: originalFilename,      // 原始文件名
          ossFileId: originalFilename,        // 原始文件名
          originalFilename: originalFilename, // 原始文件名
          cacheId: cacheResult.cacheId,       // 缓存ID（关键）
          imageHash: `manual_${timestamp}`
        });
        
        console.log('   ✅ 上传完成');
        
      } catch (error) {
        console.error('   ❌ 上传失败:', error);
        // 清理错误路径下可能残留的临时文件
        try {
          const tempDir = path.join(os.tmpdir(), 'screensync-upload');
          if (fs.existsSync(tempDir)) {
            const leftover = fs.readdirSync(tempDir);
            for (const f of leftover) {
              try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
            }
          }
        } catch (cleanupErr) {}
        wsSend(ws, {
          type: 'upload-gif-result',
          messageId: data.messageId,
          success: false,
          error: error.message
        });
      }
    }
    
    // 时间线编辑器打开时，清除所有预览帧缓存（防止跨文件 layerId 碰撞导致残留帧混入）
    if (data.type === 'clear-preview-cache') {
      const previewCacheDir = path.join(os.tmpdir(), 'screensync-preview-frames');
      try {
        if (fs.existsSync(previewCacheDir)) {
          removeDirRecursive(previewCacheDir);
        }
        // 重新创建空目录，确保后续 extract-preview-frames 不会因目录不存在而失败
        fs.mkdirSync(previewCacheDir, { recursive: true });
        console.log('🗑️ [时间线预览] 已清除所有预览帧缓存并重建目录');
      } catch (e) {
        console.warn('⚠️ 清除预览帧缓存失败:', e.message);
      }
      return;
    }
    
    // 处理时间线预览帧提取请求
    if (data.type === 'extract-preview-frames') {
      const { layerId, layerName, originalFilename, videoId, gifCacheId, frameCount = 10 } = data;
      console.log(`\n🎞️ [时间线预览] 提取帧请求: ${layerName} (gifCacheId: ${gifCacheId || '无'})`);
      if (!gifCacheId) {
        console.log(`   ⚠️ 无 gifCacheId — 该图层未绑定源文件`);
      }
      
      try {
        // 🔑 唯一查找方式：通过 gifCacheId 从缓存精确定位
        // 完全不依赖文件名匹配，避免同名文件/重命名导致的误匹配
        let videoPath = null;
        
        if (gifCacheId) {
          try {
            const cachedResult = userConfig.getGifFromCache(originalFilename || layerName, gifCacheId);
            if (cachedResult && cachedResult.path && fs.existsSync(cachedResult.path)) {
              videoPath = cachedResult.path;
            } else {
              console.log(`   ⚠️ gifCacheId 存在但缓存文件不存在（可能已被清理）`);
            }
          } catch (e) {
            console.warn(`   ⚠️ gifCacheId 查找失败:`, e.message);
          }
        }
        
        // 回退：无 gifCacheId 或缓存丢失时，尝试通过文件名查找
        if (!videoPath && (originalFilename || layerName)) {
          try {
            const fallback = userConfig.getGifFromCache(originalFilename || layerName, null);
            if (fallback && fallback.path && fs.existsSync(fallback.path)) {
              videoPath = fallback.path;
              console.log(`   🔍 通过文件名回退找到: ${fallback.path}`);
            }
          } catch (_) {}
        }
        
        if (!videoPath || !fs.existsSync(videoPath)) {
          const reason = !gifCacheId 
            ? 'no-bindingid' 
            : 'cache-missing';
          console.log(`   ⚠️ 未找到源文件 (原因: ${reason})`);
          wsSend(ws, {
            type: 'preview-frames-result',
            layerId: layerId,
            success: false,
            error: reason === 'no-bindingid' 
              ? '该图层未绑定源文件（缺少 gifCacheId）' 
              : '缓存文件已丢失，请重新同步该录屏',
            errorCode: reason
          });
          return;
        }
        
        // 创建临时目录存放帧（先清理旧文件，防止残留帧混入新结果）
        const tempDir = path.join(os.tmpdir(), 'screensync-preview-frames', layerId.replace(/:/g, '_'));
        if (fs.existsSync(tempDir)) {
          // 清除旧的残留帧文件
          try {
            const oldFiles = fs.readdirSync(tempDir);
            for (const f of oldFiles) {
              try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {}
            }
          } catch (e) {}
        } else {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const fileExt = path.extname(videoPath).toLowerCase();
        const isGifFile = fileExt === '.gif';
        
        // 获取时长：先尝试 format=duration，失败则用 frame count + frame rate 推算
        let duration = 0;
        try {
          const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
          const { stdout: durationStr } = await execAsync(durationCmd);
          duration = parseFloat(durationStr.trim());
        } catch (_) {}
        
        if (isNaN(duration) || duration <= 0) {
          // 回退：通过帧数 + 帧率推算时长
          try {
            const probeCmd = `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,r_frame_rate -of csv=p=0 "${videoPath}"`;
            const { stdout: probeStr } = await execAsync(probeCmd, { timeout: 30000 });
            const parts = probeStr.trim().split(',');
            if (parts.length >= 2) {
              const frac = parts[0].split('/');
              const fps = frac.length === 2 ? parseInt(frac[0]) / parseInt(frac[1]) : parseFloat(frac[0]);
              const nbFrames = parseInt(parts[1]);
              if (fps > 0 && nbFrames > 0) duration = nbFrames / fps;
            }
          } catch (_) {}
        }
        
        if (isNaN(duration) || duration <= 0) {
          throw new Error('无法获取文件时长');
        }
        
        console.log(`   ⏱️ ${isGifFile ? 'GIF' : '视频'}时长: ${duration.toFixed(2)}s`);
        
        const frames = [];
        const actualFrameCount = Math.min(frameCount, 150);
        
        if (isGifFile) {
          // GIF：先用 -vsync 0 提取所有原始帧（保留逐帧延迟），再均匀采样
          const allFramesDir = path.join(tempDir, 'all');
          fs.mkdirSync(allFramesDir, { recursive: true });
          const extractGifCmd = `ffmpeg -y -i "${videoPath}" -vsync 0 -vf "scale=-1:600" "${allFramesDir}/f_%04d.png"`;
          await execAsync(extractGifCmd, { timeout: 60000 });
          
          const allFiles = fs.readdirSync(allFramesDir).filter(f => f.endsWith('.png')).sort();
          const totalGifFrames = allFiles.length;
          
          if (totalGifFrames === 0) throw new Error('GIF 帧提取为空');
          
          // 均匀采样到 actualFrameCount 帧
          const step = totalGifFrames <= actualFrameCount
            ? 1
            : totalGifFrames / actualFrameCount;
          const sampleIndices = [];
          for (let i = 0; i < Math.min(totalGifFrames, actualFrameCount); i++) {
            sampleIndices.push(Math.min(Math.round(i * step), totalGifFrames - 1));
          }
          // 确保最后一帧
          if (sampleIndices[sampleIndices.length - 1] !== totalGifFrames - 1) {
            sampleIndices.push(totalGifFrames - 1);
          }
          
          for (let si = 0; si < sampleIndices.length; si++) {
            const idx = sampleIndices[si];
            const framePath = path.join(allFramesDir, allFiles[idx]);
            const percent = totalGifFrames > 1 ? (idx / (totalGifFrames - 1)) * 100 : 0;
            if (fs.existsSync(framePath)) {
              frames.push({
                percent,
                data: fs.readFileSync(framePath).toString('base64')
              });
            }
          }
          
          // 清理 all frames 目录
          for (const f of allFiles) {
            try { fs.unlinkSync(path.join(allFramesDir, f)); } catch (_) {}
          }
          try { fs.rmdirSync(allFramesDir); } catch (_) {}
        } else {
          // 视频：按目标帧率提取
          const targetFps = actualFrameCount / duration;
          const extractAllCmd = `ffmpeg -y -i "${videoPath}" -vf "fps=${targetFps},scale=-1:600" "${tempDir}/frame_%03d.png"`;
          
          try {
            await execAsync(extractAllCmd, { timeout: 60000 });
          } catch (e) {
            console.warn(`   ⚠️  批量提取失败，回退到逐帧提取: ${e.message}`);
            for (let i = 0; i < actualFrameCount; i++) {
              const timestamp = (duration * i) / (actualFrameCount - 1);
              const framePath = path.join(tempDir, `frame_${i.toString().padStart(3, '0')}.png`);
              const extractCmd = `ffmpeg -y -ss ${timestamp.toFixed(3)} -i "${videoPath}" -vframes 1 -vf "scale=-1:600" "${framePath}"`;
              await execAsync(extractCmd);
            }
          }
          
          const frameFiles = fs.readdirSync(tempDir)
            .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
            .sort();
          
          const totalFrames = frameFiles.length;
          
          for (let i = 0; i < totalFrames; i++) {
            const framePath = path.join(tempDir, frameFiles[i]);
            const percent = totalFrames > 1 ? (i / (totalFrames - 1)) * 100 : 0;
            
            if (fs.existsSync(framePath)) {
              frames.push({
                percent,
                data: fs.readFileSync(framePath).toString('base64')
              });
              fs.unlinkSync(framePath);
            }
          }
        }
        
        // 清理临时目录（可能含嵌套子目录）
        try {
          removeDirRecursive(tempDir);
        } catch (e) {
          // ignore
        }
        
        console.log(`   ✅ 成功提取 ${frames.length} 帧`);
        
        wsSend(ws, {
          type: 'preview-frames-result',
          layerId: layerId,
          success: true,
          frames: frames,
          duration: duration, // 返回视频时长（秒）
          gifCacheId: gifCacheId // 🔑 回传确认 cacheId
        });
        
      } catch (error) {
        console.error(`   ❌ 帧提取失败:`, error.message);
        // 清理可能残留的临时帧目录
        try {
          const tempDir = path.join(os.tmpdir(), 'screensync-preview-frames', layerId.replace(/:/g, '_'));
          if (fs.existsSync(tempDir)) removeDirRecursive(tempDir);
        } catch (cleanupErr) {}
        wsSend(ws, {
          type: 'preview-frames-result',
          layerId: layerId,
          success: false,
          error: error.message
        });
      }
    }
    
    // 处理带标注的 GIF 合成请求
    if (data.type === 'compose-annotated-gif') {
      // 重置取消标志
      cancelFlags.set(connectionId, false);
      
      console.log(`\n🎬 收到 GIF 导出请求: ${data.frameName || '未命名'} (${data.gifInfos?.length || 0} 个 GIF)`);
      
      // 检查并补全缺失的 cacheId（从映射文件）
      if (data.gifInfos) {
        const mappingFile = path.join(userConfig.getLocalDownloadFolder(), '.cache-mapping.json');
        let mapping = {};
        
        if (fs.existsSync(mappingFile)) {
          try {
            mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
          } catch (e) {}
        }
        
        // 补全缺失的 cacheId
        data.gifInfos.forEach((gif, idx) => {
          if (!gif.cacheId && gif.filename) {
            const cachedId = mapping[gif.filename];
            if (cachedId) {
              gif.cacheId = cachedId;
            }
          }
        });
      }
      
      try {
        const exportStartTime = Date.now();
        const receivedAlgorithm = data.gifAlgorithm || 'smooth_gradient';
        
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
          gifAlgorithm: data.gifAlgorithm || 'smooth_gradient', // ✅ GIF 算法设置
          // 🔍 验证: 确保从 UI 正确接收算法设置
          connectionId: connectionId,
          shouldCancel: () => cancelFlags.get(connectionId) === true,
          onProgress: (percent, message) => {
            sendToFigma(targetGroup, {
              type: 'gif-compose-progress',
              progress: percent,
              message: message,
              batchIndex: data.batchIndex,
              batchTotal: data.batchTotal
            });
          }
        });
        
        const exportDuration = Date.now() - exportStartTime;
        const durationSeconds = (exportDuration / 1000).toFixed(1);
        const usedAlgorithm = data.gifAlgorithm || 'smooth_gradient';
        console.log(`✅ GIF 导出完成 (${durationSeconds}s, 算法=${usedAlgorithm}): ${result.outputPath}`);
        
        // ✅ 关键：立即发送成功消息给 Figma（不要等清理操作完成）
        // 用户已经可以在文件夹里看到 GIF 了，进度条应该立即完成
        const successMsg = {
          type: 'gif-compose-success',
          message: result.skipped 
            ? `⏭️  文件已存在: ${result.outputPath}` 
            : `✅ 已导出到: ${result.outputPath}`,
          outputPath: result.outputPath,
          filename: data.frameName || data.originalFilename,
          skipped: result.skipped || false,
          exportDuration: exportDuration,
          exportDurationSeconds: durationSeconds
        };
        console.log(result.skipped ? '   📤 发送跳过消息到 Figma' : `   📤 发送成功消息到 Figma (耗时 ${durationSeconds}s)`);
        sendToFigma(targetGroup, successMsg);
        
        // 🧹 异步清理上传缓存（不阻塞用户体验）
        setImmediate(() => {
          try {
            const localFolder = userConfig.getLocalDownloadFolder();
            const uploadCacheDir = path.join(localFolder, '.gif_cache');
            const mappingFile = path.join(localFolder, '.cache-mapping.json');
            
            if (fs.existsSync(uploadCacheDir)) {
              removeDirRecursive(uploadCacheDir);
            }
            
            if (fs.existsSync(mappingFile)) {
              fs.unlinkSync(mappingFile);
            }
            
            // 清理 .gif-cache 中的 manual 手动上传文件
            const gifCacheDir = path.join(localFolder, '.gif-cache');
            if (fs.existsSync(gifCacheDir)) {
              const files = fs.readdirSync(gifCacheDir);
              let cleanedCount = 0;
              
              for (const file of files) {
                const metaPath = path.join(gifCacheDir, file);
                
                if (file.endsWith('.meta.json')) {
                  try {
                    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    if (metadata.originalFilename && metadata.originalFilename.startsWith('manual_')) {
                      const cacheFilePath = path.join(gifCacheDir, `${metadata.cacheId}${metadata.ext}`);
                      if (fs.existsSync(cacheFilePath)) {
                        fs.unlinkSync(cacheFilePath);
                        cleanedCount++;
                      }
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
            // 清理失败不影响任何功能
          }
        });
      } catch (error) {
        // 检查是否是取消操作
        if (error.message === 'GIF_EXPORT_CANCELLED') {
          console.log('\n🛑 GIF 导出已取消');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          
          // 发送取消消息到 Figma
          sendToFigma(targetGroup, {
            type: 'gif-compose-cancelled',
            message: '导出已取消'
          });
          
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
        
        // 被取消后的残余错误（进程被 kill 导致 Command failed），按取消处理
        if (cancelFlags.get(connectionId) === true) {
          console.log('\n🛑 GIF 导出已取消（残余进程错误已忽略）');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
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
        
        console.log('   📤 发送错误消息到 Figma');
        if (!sendToFigma(targetGroup, {
          type: 'gif-compose-error',
          message: error.message || '未知错误',
          error: error.message || '未知错误',
          details: error.stack
        })) {
          console.warn('   ⚠️ 无法发送错误消息：Figma WebSocket未连接');
        }
      }
      return;
    }
    
    // 同步模式切换消息处理
    if (data.type === 'switch-sync-mode' || data.type === 'get-sync-mode' || data.type === 'get-user-id' || data.type === 'get-server-info') {
      if (data.type === 'get-server-info') {
        sendToFigma(targetGroup, { type: 'server-info', path: path.resolve(__dirname) });
      } else if (data.type === 'get-user-id') {
        sendToFigma(targetGroup, { type: 'user-id-info', userId: getUserId() });
      } else if (data.type === 'get-sync-mode') {
        const fileMode = readSyncModeFromFile();
        sendToFigma(targetGroup, { type: 'sync-mode-info', mode: fileMode || process.env.SYNC_MODE || 'drive' });
      } else if (data.type === 'switch-sync-mode') {
        const newMode = data.mode;
        
        // 如果是切换到 iCloud，需要验证文件夹和空间
        if (newMode === 'icloud') {
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
            const errorMessage = error.message || String(error);
            const isSpaceError = errorMessage.includes('空间不足') || 
                                 errorMessage.includes('No space') || 
                                 errorMessage.includes('ENOSPC');
            sendToFigma(targetGroup, {
              type: 'switch-sync-mode-result',
              success: false,
              message: isSpaceError ? 'iCloud 空间不足' : ('iCloud 文件夹创建失败：' + errorMessage + '。请检查 iCloud Drive 是否启用或空间是否充足。'),
              isSpaceError: isSpaceError
            });
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
                  
                  // 1. 创建 Google Drive 用户文件夹
                  if (initializeUserFolderForUpload) {
                    try {
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
        sendToMac(targetGroup, { type: 'switch-sync-mode', mode: newMode });
        
        // 通知 Figma 端切换成功
        const modeNames = { drive: 'Google Drive', google: 'Google Drive', aliyun: '阿里云', oss: '阿里云', icloud: 'iCloud' };
        sendToFigma(targetGroup, {
          type: 'switch-sync-mode-result',
          success: true,
          mode: newMode,
          message: '储存方式已切换为 ' + (modeNames[newMode] || '未知模式')
        });
        sendToFigma(targetGroup, { type: 'sync-mode-changed', mode: newMode });
      }
      return;
    }
    
    // 备份设置消息处理
    if (data.type === 'get-backup-screenshot-setting' || data.type === 'update-backup-screenshot-setting') {
      if (data.type === 'get-backup-screenshot-setting') {
        const mode = userConfig.getBackupMode();
        sendToFigma(targetGroup, { type: 'backup-screenshot-setting-info', mode, enabled: mode === 'all' });
      } else {
        let mode = data.mode;
        if (!mode && typeof data.enabled !== 'undefined') mode = data.enabled ? 'all' : 'none';
        if (!['none', 'gif_only', 'all'].includes(mode)) mode = 'none';
        userConfig.updateBackupMode(mode);
        const payload = { type: 'backup-screenshot-setting-updated', success: true, mode, enabled: mode === 'all' };
        sendToFigma(targetGroup, payload);
        sendToMac(targetGroup, payload);
      }
      return;
    }
    
    // 截图消息
    if (data.type === 'screenshot') {
      sendToFigma(targetGroup, data);
      return;
    }
    
    // 文件跳过消息（MP4 或大于150MB的GIF）
    if (data.type === 'file-skipped') {
      sendToFigma(targetGroup, data);
      return;
    }
    
    // 确认消息 → 转发到 Mac
    if (data.type === 'screenshot-received' || data.type === 'screenshot-failed') {
      sendToMac(targetGroup, data);
      return;
    }
    
    // 同步相关消息 → 转发到 Figma
    if (['manual-sync-complete', 'manual-sync-cancelled', 'manual-sync-file-count', 'manual-sync-progress',
         'conversion-progress', 'oversized-files-cleaned',
         'gif-backup-setting-updated', 'keep-gif-in-icloud-setting-updated'].includes(data.type)) {
      sendToFigma(targetGroup, data);
      return;
    }
    
    // 打开本地文件夹
    if (data.type === 'open-local-folder') {
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
        }
      }
      
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('❌ 打开本地文件夹失败:', error.message);
          sendToFigma(targetGroup, { type: 'error', message: '打开文件夹失败: ' + error.message });
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
        sendToFigma(targetGroup, { type: 'update-progress', status: 'error', message: `更新失败: ${error.message}` });
      });
      return;
    }
  });
  
  ws.on('close', () => {
    const group = connections.get(connectionId);
    if (group) {
      // 如果 Figma 插件关闭，主动通知 Mac 端停止监听
      if (clientType === 'figma') {
        try {
          console.log('   📤 [Server] Figma 插件已关闭，通知 Mac 端停止监听');
          sendToMac(group, { type: 'stop-realtime' });
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
      delete group.figma;
      cleanedCount++;
    }
    
    // 检查 mac 连接
    if (group.mac && (group.mac.readyState === WebSocket.CLOSING || group.mac.readyState === WebSocket.CLOSED)) {
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
  
}, 30000); // 每 30 秒执行一次


// ─── Update System (extracted to update-handlers.js) ─────────────────────────
const { checkAndNotifyUpdates, handlePluginUpdate, handleServerUpdate, handleFullUpdate } = require('./update-handlers')({ sendToFigma, WebSocket });


const PORT = process.env.PORT || 8888;
const HOST = process.env.HOST || '0.0.0.0';

// 启动服务器，添加错误处理
try {
server.listen(PORT, HOST, () => {
  console.log('✅ 服务器运行在: http://' + HOST + ':' + PORT);
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