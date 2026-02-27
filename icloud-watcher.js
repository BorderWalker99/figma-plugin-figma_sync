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
const { promisify } = require('util');
const execAsync = promisify(exec);
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
  supportedFormats: ['.png', '.jpg', '.jpeg', '.heic', '.heif', '.webp', '.gif', '.mp4', '.mov'],
  // 子文件夹配置
  subfolders: {
    image: '图片',
    gif: 'GIF',
    exportedGif: '导出的GIF'
  }
};

let ws = null;
let reconnectTimer = null;
let syncCount = 0;
let isRealTimeMode = false;
let watcher = null;
let isSyncing = false;
let manualSyncAbortRequested = false;
let manualSyncRunId = 0;
const MANUAL_SYNC_CANCELLED_CODE = 'MANUAL_SYNC_CANCELLED';

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
    return true;
  }
  return false;
}

// 标记文件为已处理
function markFileAsProcessed(filePath) {
  const fingerprint = getFileFingerprint(filePath);
  if (fingerprint) {
    processedFilesCache.set(fingerprint, Date.now());
  }
}

function createManualSyncCancelledError() {
  const error = new Error('手动同步已取消');
  error.code = MANUAL_SYNC_CANCELLED_CODE;
  return error;
}

function isManualSyncCancelledError(error) {
  if (!error) return false;
  if (error.code === MANUAL_SYNC_CANCELLED_CODE) return true;
  const msg = String(error.message || '');
  return msg.includes('手动同步已取消') || msg.includes(MANUAL_SYNC_CANCELLED_CODE);
}

function requestManualSyncCancel() {
  if (!isSyncing) return false;
  manualSyncAbortRequested = true;
  return true;
}

function safeSend(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(message)); return true; } catch (_) { return false; }
}

function sendProgress(type, data) {
  safeSend({ type, ...data });
}

function saveCacheMapping(fileName, cacheId) {
  try {
    const localFolder = userConfig.getLocalDownloadFolder();
    const mappingFile = path.join(localFolder, '.cache-mapping.json');
    let mapping = {};
    if (fs.existsSync(mappingFile)) {
      try { mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8')); } catch (_) {}
    }
    mapping[fileName] = cacheId;
    const keys = Object.keys(mapping);
    if (keys.length > 500) {
      for (let i = 0; i < keys.length - 500; i++) delete mapping[keys[i]];
    }
    fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
  } catch (_) {}
}

/**
 * 将视频转换为 GIF（两遍调色板算法，与 Google Drive 模式完全一致）
 */
async function convertVideoToGif(videoPath, displayFilename, progressCb) {
  const stats = fs.statSync(videoPath);
  const videoSizeMB = (stats.size / 1024 / 1024).toFixed(1);
  const convStartTime = Date.now();
  console.log(`   🎬 [Video→GIF] 开始转换 ${displayFilename} (${videoSizeMB}MB)...`);

  const estimatedSec = Math.max(5, Math.ceil(parseFloat(videoSizeMB) * 2));
  if (progressCb) progressCb('converting', 25, { estimatedSec, isVideo: true });

  const tempDir = path.join(os.tmpdir(), `screensync-v2g-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const tempPalette = path.join(tempDir, 'palette.png');
  const tempGifOut = path.join(tempDir, 'output.gif');
  const tempCompressedVideo = path.join(tempDir, 'compressed.mp4');

  try {
    const runTwoPass = async (sourceVideoPath, scaleFilter, pass1Timeout, pass2Timeout) => {
      const pass1Cmd = `ffmpeg -hwaccel auto -threads 0 -i "${sourceVideoPath}" -vf "${scaleFilter},palettegen=max_colors=256:stats_mode=full" -y "${tempPalette}"`;
      await execAsync(pass1Cmd, { timeout: pass1Timeout, maxBuffer: 50 * 1024 * 1024 });

      if (progressCb) progressCb('converting', 55, { estimatedSec, isVideo: true });

      const pass2Cmd = `ffmpeg -hwaccel auto -threads 0 -i "${sourceVideoPath}" -i "${tempPalette}" -lavfi "${scaleFilter}[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -threads 0 -loop 0 -y "${tempGifOut}"`;
      await execAsync(pass2Cmd, { timeout: pass2Timeout, maxBuffer: 200 * 1024 * 1024 });
    };

    const isTimeoutLike = (err) => {
      if (!err) return false;
      const msg = String(err.message || '');
      return Boolean(err.killed || err.signal === 'SIGTERM' || msg.includes('timed out') || msg.includes('ETIMEDOUT'));
    };

    let converted = false;
    let primaryError = null;

    const MAX_GIF_SIZE_BEFORE_DEGRADE = 80 * 1024 * 1024; // 80MB — 超过此值触发降级

    // 主策略：高质量两遍调色板（保持原策略）
    try {
      const primaryScaleFilter = `fps=15,scale='trunc(iw/4)*2':'trunc(ih/4)*2':flags=lanczos`;
      await runTwoPass(videoPath, primaryScaleFilter, 30000, 180000);
      converted = true;

      // 主策略成功但输出过大 → 丢弃结果，进入降级策略以缩减体积
      if (fs.existsSync(tempGifOut)) {
        const primarySize = fs.statSync(tempGifOut).size;
        if (primarySize > MAX_GIF_SIZE_BEFORE_DEGRADE) {
          console.warn(`   ⚠️  [Video→GIF] 主策略输出过大 (${(primarySize / 1024 / 1024).toFixed(1)}MB)，触发降级策略以缩减体积`);
          converted = false;
          try { fs.unlinkSync(tempGifOut); } catch (_) {}
          try { fs.unlinkSync(tempPalette); } catch (_) {}
          if (progressCb) progressCb('converting', 12, { estimatedSec, isVideo: true, degraded: true, reason: 'output-too-large' });
        }
      }
    } catch (err) {
      primaryError = err;
      const reason = isTimeoutLike(err) ? 'progress-stalled-at-5' : 'primary-conversion-failed';
      console.warn(`   ⚠️  [Video→GIF] 主转换失败，触发降级策略 (${reason}): ${err.message}`);
      if (progressCb) progressCb('converting', 12, { estimatedSec, isVideo: true, degraded: true, reason });
    }

    // 回退策略 1：先压缩视频，再两遍转换
    if (!converted) {
      try {
        if (progressCb) progressCb('converting', 20, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'compressing-video' });
        const compressCmd = `ffmpeg -hwaccel auto -threads 0 -i "${videoPath}" -vf "fps=10,scale='min(960,iw)':-2:flags=lanczos" -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -an -movflags +faststart -y "${tempCompressedVideo}"`;
        await execAsync(compressCmd, { timeout: 120000, maxBuffer: 120 * 1024 * 1024 });

        if (!fs.existsSync(tempCompressedVideo) || fs.statSync(tempCompressedVideo).size === 0) {
          throw new Error('视频压缩输出为空');
        }

        if (progressCb) progressCb('converting', 35, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'converting-compressed-video' });
        const degradedScaleFilter = `fps=10,scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=bicubic`;
        await runTwoPass(tempCompressedVideo, degradedScaleFilter, 90000, 180000);
        converted = true;
      } catch (fallbackErr) {
        console.warn(`   ⚠️  [Video→GIF] 回退策略1失败: ${fallbackErr.message}`);
      }
    }

    // 回退策略 2：直接有损转换 GIF（尽量保底产出）
    if (!converted) {
      if (progressCb) progressCb('converting', 45, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'lossy-gif-fallback' });
      const lossySource = fs.existsSync(tempCompressedVideo) ? tempCompressedVideo : videoPath;
      const lossyCmd = `ffmpeg -hwaccel auto -threads 0 -i "${lossySource}" -lavfi "fps=8,scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=bicubic,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" -loop 0 -y "${tempGifOut}"`;
      await execAsync(lossyCmd, { timeout: 180000, maxBuffer: 200 * 1024 * 1024 });
      converted = true;
    }

    if (!converted && primaryError) {
      throw primaryError;
    }

    if (!fs.existsSync(tempGifOut) || fs.statSync(tempGifOut).size === 0) {
      throw new Error('转换输出为空');
    }

    if (progressCb) progressCb('converting', 80, { isVideo: true });

    const gifBuffer = fs.readFileSync(tempGifOut);
    const gifSizeMB = (gifBuffer.length / 1024 / 1024).toFixed(1);
    const convTime = ((Date.now() - convStartTime) / 1000).toFixed(1);
    console.log(`   ✅ [Video→GIF] ${videoSizeMB}MB → ${gifSizeMB}MB GIF (${convTime}秒)`);

    return gifBuffer;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 处理视频文件：转换为 GIF，保存到 iCloud GIF 子文件夹，替换原视频，同步到 Figma
 * @returns {{ gifBuffer, gifPath, gifFilename, gifCacheId }} 或 null（失败时）
 */
async function processVideoFile(videoPath, displayFilename, subfolder, progressCb) {
  const downloaded = await waitForICloudDownload(videoPath, 300000); // 视频文件给 5 分钟下载时间
  if (!downloaded) {
    console.log(`   ⚠️  视频可能未完全下载，尝试继续转换...`);
  }

  const gifBuffer = await convertVideoToGif(videoPath, displayFilename, progressCb);

  const gifFilename = displayFilename.replace(/\.(mp4|mov)$/i, '.gif');
  const gifPath = path.join(path.dirname(videoPath), gifFilename);
  fs.writeFileSync(gifPath, gifBuffer);

  // 删除原始视频
  try {
    if (fs.existsSync(videoPath) && videoPath !== gifPath) {
      fs.unlinkSync(videoPath);
      console.log(`   🗑️  已删除原始视频: ${displayFilename}`);
    }
  } catch (delErr) {
    console.warn(`   ⚠️  删除原始视频失败: ${delErr.message}`);
  }

  // 保存到 GIF 缓存
  let gifCacheId = null;
  try {
    const cacheResult = userConfig.saveGifToCache(gifBuffer, gifFilename, null);
    if (cacheResult && cacheResult.cacheId) {
      gifCacheId = cacheResult.cacheId;
      saveCacheMapping(gifFilename, gifCacheId);
      console.log(`   💾 [GIF Cache] 已缓存 (ID: ${gifCacheId})`);
    }
  } catch (cacheErr) {
    console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheErr.message);
  }

  return { gifBuffer, gifPath, gifFilename, gifCacheId };
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
 * 获取文件夹中的下一个序号
 */
function getNextSequenceNumber(folderPath, prefix, extensions) {
  if (!fs.existsSync(folderPath)) {
    return 1;
  }
  
  const files = fs.readdirSync(folderPath);
  let maxNumber = 0;
  
  files.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (extensions.includes(ext)) {
      // 匹配格式：prefix_数字.ext
      const nameWithoutExt = path.basename(file, ext);
      const match = nameWithoutExt.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    }
  });
  
  return maxNumber + 1;
}

/**
 * 等待 iCloud 文件完全下载
 */
async function waitForICloudDownload(filePath, maxWaitMs = 30000) {
  const startTime = Date.now();
  
  // 先尝试触发下载
  try {
    await new Promise((resolve) => {
      exec(`brctl download "${filePath}"`, { timeout: 5000 }, () => resolve());
    });
  } catch (e) {
    // 忽略
  }
  
  // 等待文件可读
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const stats = fs.statSync(filePath);
      // 检查文件大小是否合理（占位符文件通常很小）
      if (stats.size > 100) {
        // 尝试读取文件头部来确认文件可读
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(16);
        const bytesRead = fs.readSync(fd, buffer, 0, 16, 0);
        fs.closeSync(fd);
        if (bytesRead > 0) {
          return true; // 文件已下载
        }
      }
    } catch (e) {
      // 文件可能还在下载中
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return false; // 超时
}

/**
 * 将 HEIF/HEIC 文件转换为 JPEG
 */
async function convertHeifToJpeg(filePath) {
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext !== '.heif' && ext !== '.heic') {
    return { converted: false, newPath: filePath };
  }
  
  console.log(`   🔄 [iCloud] 检测到 HEIF 格式，正在转换为 JPEG...`);
  
  // 等待 iCloud 文件完全下载
  console.log(`   ☁️  等待 iCloud 文件下载完成...`);
  const downloaded = await waitForICloudDownload(filePath);
  if (!downloaded) {
    console.log(`   ⚠️  文件可能未完全下载，尝试继续转换...`);
  }
  
  const tempOutputPath = path.join(os.tmpdir(), `heif-convert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
  
  try {
    // 使用 sips 转换 (macOS 原生支持)
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
    
    // 创建新的 JPEG 文件路径（在同一目录）
    const newFilename = path.basename(filePath, ext) + '.jpg';
    const newPath = path.join(path.dirname(filePath), newFilename);
    
    // 尝试使用 sharp 压缩，如果失败则直接使用 sips 转换结果
    try {
      const convertedBuffer = fs.readFileSync(tempOutputPath);
      const compressedBuffer = await sharp(convertedBuffer)
        .resize(CONFIG.maxWidth, null, {
          withoutEnlargement: true,
          fit: 'inside'
        })
        .jpeg({ quality: CONFIG.quality })
        .toBuffer();
      
      // 写入压缩后的 JPEG
      fs.writeFileSync(newPath, compressedBuffer);
    } catch (sharpError) {
      console.log(`   ⚠️ [iCloud] sharp 压缩失败，使用原始转换结果: ${sharpError.message}`);
      // sharp 失败时，直接复制 sips 转换的结果
      fs.copyFileSync(tempOutputPath, newPath);
    }
    
    // 删除临时文件
    try {
      fs.unlinkSync(tempOutputPath);
    } catch (e) {
      // 忽略
    }
    
    // 删除原始 HEIF 文件
    try {
      fs.unlinkSync(filePath);
      console.log(`   ✅ [iCloud] HEIF → JPEG 转换完成: ${newFilename}`);
    } catch (e) {
      console.log(`   ⚠️ [iCloud] 无法删除原始 HEIF 文件: ${e.message}`);
    }
    
    return { converted: true, newPath: newPath };
  } catch (error) {
    console.error(`   ❌ [iCloud] HEIF 转换失败: ${error.message}`);
    // 清理临时文件
    try {
      if (fs.existsSync(tempOutputPath)) {
        fs.unlinkSync(tempOutputPath);
      }
    } catch (e) {
      // 忽略
    }
    return { converted: false, newPath: filePath };
  }
}

/**
 * 根据文件类型获取目标子文件夹和文件前缀
 */
function getTargetSubfolderAndPrefix(filename, isExportedGif = false) {
  const ext = path.extname(filename).toLowerCase();
  
  if (isExportedGif) {
    return {
      subfolder: CONFIG.subfolders.exportedGif,
      filePrefix: 'ScreenRecordingGIF',
      extensions: ['.gif']
    };
  }
  
  if (ext === '.mp4' || ext === '.mov') {
    return {
      subfolder: CONFIG.subfolders.gif,
      filePrefix: 'ScreenRecordingGIF',
      extensions: ['.gif']
    };
  } else if (ext === '.gif') {
    return {
      subfolder: CONFIG.subfolders.gif,
      filePrefix: 'ScreenRecordingGIF',
      extensions: ['.gif']
    };
  } else {
    return {
      subfolder: CONFIG.subfolders.image,
      filePrefix: 'ScreenShot',
      extensions: ['.jpg', '.jpeg', '.png']
    };
  }
}

/**
 * 根据文件类型获取目标子文件夹（兼容旧调用）
 */
function getTargetSubfolder(filename, isExportedGif = false) {
  return getTargetSubfolderAndPrefix(filename, isExportedGif).subfolder;
}

/**
 * 将文件移动到对应的子文件夹（带自动命名和 HEIF 转换）
 * @returns {Object} { moved, newPath, subfolder, newFilename, heifConverted }
 */
async function moveFileToSubfolder(filePath, isExportedGif = false) {
  let currentPath = filePath;
  let filename = path.basename(currentPath);
  let ext = path.extname(filename).toLowerCase();
  let heifConverted = false;
  
  // 如果是 HEIF/HEIC，先转换为 JPEG
  if (ext === '.heif' || ext === '.heic') {
    const conversionResult = await convertHeifToJpeg(currentPath);
    if (conversionResult.converted) {
      currentPath = conversionResult.newPath;
      filename = path.basename(currentPath);
      ext = path.extname(filename).toLowerCase();
      heifConverted = true;
    }
  }
  
  const { subfolder, filePrefix, extensions } = getTargetSubfolderAndPrefix(filename, isExportedGif);
  const targetDir = path.join(CONFIG.icloudPath, subfolder);
  
  // 确保目标文件夹存在
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  
  // 获取下一个序号并生成新文件名
  const sequenceNumber = getNextSequenceNumber(targetDir, filePrefix, extensions);
  const paddedNumber = sequenceNumber.toString().padStart(3, '0');
  const newFilename = `${filePrefix}_${paddedNumber}${ext}`;
  const targetPath = path.join(targetDir, newFilename);
  
  // 如果文件已经在目标位置且文件名相同，直接返回
  if (currentPath === targetPath) {
    return { moved: false, newPath: currentPath, subfolder, newFilename: filename, heifConverted };
  }
  
  // 移动并重命名文件
  try {
    fs.renameSync(currentPath, targetPath);
    return { moved: true, newPath: targetPath, subfolder, newFilename, heifConverted };
  } catch (moveError) {
    console.warn(`   ⚠️  [iCloud] 移动文件失败: ${moveError.message}`);
    return { moved: false, newPath: currentPath, subfolder, newFilename: filename, heifConverted };
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
  
  // 导出的 GIF 始终保留
  if (subfolder === CONFIG.subfolders.exportedGif) {
    return false;
  }
  
  // GIF 子文件夹
  if (subfolder === CONFIG.subfolders.gif) {
    return backupMode === 'none';
  }
  
  // 图片子文件夹
  if (subfolder === CONFIG.subfolders.image) {
    return backupMode !== 'all';
  }
  
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
        // 注意：watcher 现在在启动时就已初始化，这里不需要重新启动
        // 但如果 watcher 意外关闭了，可以在这里重启
        if (!watcher) {
          startWatching();
        }
      } else if (message.type === 'stop-realtime') {
        console.log('\n⏸️  停止实时同步模式（文件分类整理仍在后台运行）\n');
        isRealTimeMode = false;
        // 注意：不再停止 watcher，保持文件整理功能
        // stopWatching(); 
      } else if (message.type === 'manual-sync-count-files') {
        console.log('\n📊 统计文件数量...\n');
        countFilesForManualSync();
      } else if (message.type === 'manual-sync') {
        console.log('\n📦 执行手动同步...\n');
        performManualSync();
      } else if (message.type === 'cancel-manual-sync') {
        const accepted = requestManualSyncCancel();
        if (accepted) {
          console.log('🛑 [iCloud] 收到取消手动同步请求，正在停止...');
        }
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
  if (watcher) {
    console.log('⚠️  检测到旧的监听器，正在停止...');
    stopWatching();
  }
  
  if (!fs.existsSync(CONFIG.icloudPath)) {
    console.log(`📁 iCloud 文件夹不存在，正在创建: ${CONFIG.icloudPath}`);
    fs.mkdirSync(CONFIG.icloudPath, { recursive: true });
    console.log(`✅ 文件夹创建成功\n`);
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
  
  // ========================================
  // ✅ 启动时自动整理根目录中的现有文件
  //    （分类、重命名、HEIF 转换）
  //    使用立即执行的异步函数，不阻塞 watcher 启动
  // ========================================
  (async () => {
    try {
      const existingFiles = fs.readdirSync(CONFIG.icloudPath).filter(file => {
        const filePath = path.join(CONFIG.icloudPath, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isDirectory()) return false;
          const ext = path.extname(file).toLowerCase();
          return CONFIG.supportedFormats.includes(ext);
        } catch (e) {
          return false;
        }
      });
      
      if (existingFiles.length > 0) {
        console.log(`\n📁 [自动整理] 发现根目录有 ${existingFiles.length} 个待整理文件`);
        console.log(`   正在执行分类、重命名和格式转换...\n`);
        
        let organizedCount = 0;
        let heifConvertedCount = 0;
        
        for (const file of existingFiles) {
          const filePath = path.join(CONFIG.icloudPath, file);
          try {
            const result = await moveFileToSubfolder(filePath);
            if (result.moved) {
              organizedCount++;
              console.log(`   ✅ ${file} → ${result.subfolder}/${result.newFilename}`);
              if (result.heifConverted) {
                heifConvertedCount++;
              }
            }
          } catch (moveError) {
            console.warn(`   ⚠️  整理失败: ${file} - ${moveError.message}`);
          }
        }
        
        console.log(`\n📊 [自动整理] 完成！`);
        console.log(`   ✅ 已分类: ${organizedCount} 个文件`);
        if (heifConvertedCount > 0) {
          console.log(`   🔄 HEIF→JPEG: ${heifConvertedCount} 个文件`);
        }
        console.log(`   ℹ️  如需同步到 Figma，请使用"手动同步"\n`);
        
        // 发送通知到插件
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'toast',
              message: `已自动整理 ${organizedCount} 个文件，如需同步请使用"手动同步"`,
              duration: 5000,
              level: 'info'
            }));
          } catch (e) {
            console.warn('   ⚠️ 发送通知失败:', e.message);
          }
        }
      } else {
        console.log(`📊 [iCloud] 根目录没有待整理文件\n`);
      }

    } catch (error) {
      console.warn('   ⚠️  扫描现有文件失败，继续启动监听:', error.message);
    }
  })();
  
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
  
  const handleFileEvent = async (filePath) => {
    const filename = path.basename(filePath);
    const relativePath = path.relative(CONFIG.icloudPath, filePath);
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 [iCloud Watcher] 检测到文件变更`);
    console.log(`   文件: ${relativePath}`);
    console.log(`   时间: ${new Date().toISOString()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // 忽略导出的GIF文件夹
    if (relativePath.startsWith(CONFIG.subfolders.exportedGif + path.sep) || relativePath === CONFIG.subfolders.exportedGif) {
      return;
    }
    
    // 忽略已经在子文件夹中的文件（避免处理已分类的文件触发的 change 事件）
    const isInSubfolder = relativePath.startsWith(CONFIG.subfolders.image + path.sep) ||
                          relativePath.startsWith(CONFIG.subfolders.gif + path.sep);
    
    // 忽略临时文件
    const lowerFilename = filename.toLowerCase();
    if (lowerFilename.startsWith('magick-') || 
        lowerFilename.endsWith('.miff') || 
        lowerFilename.endsWith('.cache') ||
        lowerFilename.includes('.tmp')) {
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
    if (!CONFIG.supportedFormats.includes(ext)) {
      return;
    }
    
    // ========================================
    // ✅ 第一步：立即执行文件分类、重命名和 HEIF 转换
    //    这些操作不依赖插件连接，文件一到达就执行
    // ========================================
    
    // 只对根目录的文件执行分类（已在子文件夹中的文件跳过分类步骤）
    let finalPath = filePath;
    let displayFilename = filename;
    let subfolder = null;
    
    if (!isInSubfolder) {
      try {
        const result = await moveFileToSubfolder(filePath);
        finalPath = result.moved ? result.newPath : filePath;
        displayFilename = result.newFilename || filename;
        subfolder = result.subfolder;
        
        
      } catch (moveError) {
        console.error(`   ❌ 自动整理失败: ${moveError.message}`);
        // 失败时继续使用原路径
        finalPath = filePath;
        displayFilename = filename;
      }
    } else {
      // 已在子文件夹中：提取子文件夹名
      subfolder = relativePath.split(path.sep)[0];
    }
    
    // 重新检测文件类型（可能已经从 HEIF 转换为 JPEG）
    const finalExt = path.extname(finalPath).toLowerCase();
    const isGif = finalExt === '.gif';
    const isVideo = finalExt === '.mp4' || finalExt === '.mov';
    
    // ========================================
    // ✅ 第二步：检查是否需要同步到 Figma
    //    只有这部分需要插件连接
    // ========================================
    
    if (!isRealTimeMode) {
      console.log(`⏸️  文件已整理完成，但实时同步未开启（插件未连接）\n`);
      return;
    }
    
    // 检查是否重复处理（同步阶段）
    if (isFileProcessed(finalPath)) {
      console.log(`\n⏭️  [实时模式] 跳过已同步文件: ${displayFilename}`);
      return;
    }
    
    // 处理视频文件 → 自动转换为 GIF
    if (isVideo) {
      console.log(`\n🎬 [实时模式] 视频文件: ${displayFilename}，开始转换 GIF...`);

      try {
        const emitProgress = (stage, percent, extra = {}) => {
          sendProgress('conversion-progress', {
            filename: displayFilename, stage, percent, isVideo: true, ...extra
          });
        };

        emitProgress('converting', 10, { isVideo: true });

        const result = await processVideoFile(finalPath, displayFilename, subfolder, emitProgress);

        if (result.gifBuffer.length > 100 * 1024 * 1024) {
          console.warn(`   ⚠️  转换后 GIF 过大，需手动导入`);
          safeSend({ type: 'file-skipped', filename: result.gifFilename, reason: 'gif-too-large', gifCacheId: result.gifCacheId });
          markFileAsProcessed(result.gifPath);
          return;
        }

        emitProgress('importing', 90, { isVideo: true });

        const base64String = result.gifBuffer.toString('base64');
        safeSend({
          type: 'screenshot',
          bytes: base64String,
          timestamp: Date.now(),
          filename: result.gifFilename,
          isGif: true,
          gifCacheId: result.gifCacheId || null,
          keptInIcloud: !shouldCleanupFile(subfolder || CONFIG.subfolders.gif)
        });

        syncCount++;
        markFileAsProcessed(result.gifPath);
        emitProgress('done', 100, { isVideo: true });

        pendingDeletes.set(result.gifFilename, { filePath: result.gifPath, subfolder: subfolder || CONFIG.subfolders.gif });
        console.log(`   ✅ 视频转 GIF 完成并已同步到 Figma`);
      } catch (convErr) {
        console.error(`   ❌ [Video→GIF] 转换失败: ${convErr.message}`);
        // 转换失败时，缓存原始视频以便手动操作
        try {
          const fileBuffer = fs.readFileSync(finalPath);
          const cacheResult = userConfig.saveGifToCache(fileBuffer, displayFilename, null);
          if (cacheResult && cacheResult.cacheId) {
            console.log(`   💾 [GIF Cache] 视频已缓存 (ID: ${cacheResult.cacheId})`);
          }
        } catch (_) {}
        safeSend({ type: 'file-skipped', filename: displayFilename, reason: 'video' });
      }
      return;
    }
    
    // 处理大GIF文件
    if (isGif) {
      try {
        const stats = fs.statSync(finalPath);
        const maxGifSize = 100 * 1024 * 1024; // 100MB
        
        if (stats.size > maxGifSize) {
          console.log(`\n🎬 [实时模式] 大 GIF 文件: ${displayFilename}`);
          console.log(`   ⚠️  GIF 文件过大，需要手动拖入`);
          
          try {
            const fileBuffer = fs.readFileSync(finalPath);
            const cacheResult = userConfig.saveGifToCache(fileBuffer, displayFilename, null);
            if (cacheResult && cacheResult.cacheId) {
              console.log(`   💾 [GIF Cache] 大GIF已自动缓存 (ID: ${cacheResult.cacheId})`);
            }
          } catch (cacheError) {
            console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
          }
          
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'file-skipped',
              filename: displayFilename,
              reason: 'gif-too-large'
            }));
          }
          return;
        }
      } catch (checkError) {
        console.log(`   ⚠️  检查 GIF 大小失败，继续处理`);
      }
    }
    
    // 尝试强制下载
    try {
      exec(`brctl download "${finalPath}"`);
    } catch (e) {
      // 忽略
    }
    
    syncScreenshot(finalPath, true, subfolder).catch(err => {
      console.error(`❌ 处理文件失败: ${displayFilename}`, err.message);
    });
  };
  
  watcher.on('add', handleFileEvent);
  watcher.on('change', handleFileEvent);
  
  watcher.on('ready', () => {
    const readyTime = new Date();
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ [iCloud] 文件整理服务已就绪`);
    console.log(`   时间: ${readyTime.toISOString()}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`ℹ️  自动整理：新文件将自动分类、重命名并转换 HEIF`);
    console.log(`ℹ️  实时同步：需连接 Figma 插件\n`);
    
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
    
    // ========================================
    // ✅ 定期轮询检测新文件（补充 chokidar 可能遗漏的 iCloud 同步文件）
    // ========================================
    const pollInterval = setInterval(async () => {
      try {
        if (!fs.existsSync(CONFIG.icloudPath)) return;
        
        const files = fs.readdirSync(CONFIG.icloudPath).filter(file => {
          const filePath = path.join(CONFIG.icloudPath, file);
          try {
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) return false;
            const ext = path.extname(file).toLowerCase();
            return CONFIG.supportedFormats.includes(ext);
          } catch (e) {
            return false;
          }
        });
        
        if (files.length > 0) {
          for (const file of files) {
            const filePath = path.join(CONFIG.icloudPath, file);
            try {
              await moveFileToSubfolder(filePath);
            } catch (e) {
              console.warn(`   ⚠️  整理失败: ${file} - ${e.message}`);
            }
          }
        }
      } catch (e) {
        // 忽略轮询错误
      }
    }, 5000); // 每 5 秒检测一次
    
    // 保存定时器引用，以便停止时清理
    watcher._pollInterval = pollInterval;
  });
  
  watcher.on('error', (error) => {
    console.error('❌ 监听错误:', error);
  });
}

function stopWatching() {
  if (watcher) {
    console.log('🛑 正在停止文件监听器...');
    
    // 清理轮询定时器
    if (watcher._pollInterval) {
      clearInterval(watcher._pollInterval);
      watcher._pollInterval = null;
    }
    
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
    const subfolders = [CONFIG.subfolders.image, CONFIG.subfolders.gif];
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
  if (isSyncing) {
    console.warn('⚠️  [iCloud] 手动同步正在进行中，跳过本次请求');
    safeSend({ type: 'manual-sync-complete', count: 0, gifCount: 0, videoCount: 0, message: '同步正在进行中' });
    return;
  }

  isSyncing = true;
  manualSyncAbortRequested = false;
  const currentRunId = ++manualSyncRunId;
  const shouldAbort = () => manualSyncAbortRequested || currentRunId !== manualSyncRunId;

  try {
    if (!fs.existsSync(CONFIG.icloudPath)) {
      console.log('❌ 同步文件夹不存在\n');
      safeSend({ type: 'manual-sync-complete', count: 0, total: 0, gifCount: 0, videoCount: 0, message: '同步文件夹不存在' });
      return;
    }

    ensureSubfolders();

    // 收集所有待同步文件
    const allFiles = [];

    const rootFiles = fs.readdirSync(CONFIG.icloudPath).filter(file => {
      const fp = path.join(CONFIG.icloudPath, file);
      try {
        const st = fs.statSync(fp);
        if (st.isDirectory()) return false;
        return CONFIG.supportedFormats.includes(path.extname(file).toLowerCase());
      } catch (_) { return false; }
    });

    for (const file of rootFiles) {
      if (shouldAbort()) break;
      const filePath = path.join(CONFIG.icloudPath, file);
      const { newPath, subfolder } = await moveFileToSubfolder(filePath);
      allFiles.push({ filePath: newPath, subfolder });
    }

    const subfolders = [CONFIG.subfolders.image, CONFIG.subfolders.gif];
    for (const sf of subfolders) {
      const sfPath = path.join(CONFIG.icloudPath, sf);
      if (!fs.existsSync(sfPath)) continue;
      const subFiles = fs.readdirSync(sfPath).filter(file => {
        const fp = path.join(sfPath, file);
        try {
          const st = fs.statSync(fp);
          if (st.isDirectory()) return false;
          return CONFIG.supportedFormats.includes(path.extname(file).toLowerCase());
        } catch (_) { return false; }
      });
      for (const file of subFiles) {
        const filePath = path.join(sfPath, file);
        if (!allFiles.some(f => f.filePath === filePath)) {
          allFiles.push({ filePath, subfolder: sf });
        }
      }
    }

    if (allFiles.length === 0) {
      console.log('📭 文件夹为空，没有截图需要同步\n');
      safeSend({ type: 'manual-sync-complete', count: 0, gifCount: 0, videoCount: 0 });
      return;
    }

    const totalFiles = allFiles.length;
    console.log(`📦 [手动模式] 找到 ${totalFiles} 个文件，开始同步...\n`);

    sendProgress('manual-sync-progress', {
      total: totalFiles, completed: 0, percent: 0,
      fileIndex: 0, filename: '', filePercent: 0, stage: 'counting'
    });

    let successCount = 0;
    let gifCount = 0;
    let videoCount = 0;
    let completedCount = 0;
    const processingErrors = [];
    let cancelled = false;

    for (let i = 0; i < allFiles.length; i++) {
      if (shouldAbort()) { cancelled = true; break; }

      const { filePath, subfolder } = allFiles[i];
      const file = path.basename(filePath);
      const fileOrder = i + 1;

      const fileProgressCb = (stage, percent, extra = {}) => {
        if (shouldAbort()) throw createManualSyncCancelledError();
        const filePct = Math.max(0, Math.min(100, Math.round(percent || 0)));
        const overallPct = totalFiles > 0
          ? Math.min(99, Math.round((((fileOrder - 1) + (filePct / 100)) / totalFiles) * 100))
          : 0;
        sendProgress('manual-sync-progress', {
          total: totalFiles, completed: completedCount, percent: overallPct,
          fileIndex: fileOrder, filename: file, filePercent: filePct, stage
        });
      };

      try {
        const ext = path.extname(filePath).toLowerCase();
        const isGif = ext === '.gif';
        const isVideo = ext === '.mp4' || ext === '.mov';

        fileProgressCb('downloading', 5);

        if (isVideo) {
          console.log(`   🎬 [手动同步] 视频文件: ${file}，开始转换 GIF...`);

          try {
            const result = await processVideoFile(filePath, file, subfolder, fileProgressCb);

            if (result.gifBuffer.length > 100 * 1024 * 1024) {
              safeSend({ type: 'file-skipped', filename: result.gifFilename, reason: 'gif-too-large', gifCacheId: result.gifCacheId });
              videoCount++;
            } else {
              fileProgressCb('importing', 90);
              const base64String = result.gifBuffer.toString('base64');
              safeSend({
                type: 'screenshot',
                bytes: base64String,
                timestamp: Date.now(),
                filename: result.gifFilename,
                isGif: true,
                gifCacheId: result.gifCacheId || null,
                keptInIcloud: !shouldCleanupFile(subfolder || CONFIG.subfolders.gif)
              });
              successCount++;
              gifCount++;
              markFileAsProcessed(result.gifPath);
            }
          } catch (convErr) {
            if (isManualSyncCancelledError(convErr)) { cancelled = true; break; }
            console.error(`   ❌ [Video→GIF] 转换失败: ${convErr.message}`);
            // 转换失败时缓存原始视频
            try {
              const buf = fs.readFileSync(filePath);
              userConfig.saveGifToCache(buf, file, null);
            } catch (_) {}
            safeSend({ type: 'file-skipped', filename: file, reason: 'video' });
            videoCount++;
          }
        } else if (isGif) {
          try {
            const st = fs.statSync(filePath);
            if (st.size > 100 * 1024 * 1024) {
              try {
                const buf = fs.readFileSync(filePath);
                const cr = userConfig.saveGifToCache(buf, file, null);
                if (cr && cr.cacheId) saveCacheMapping(file, cr.cacheId);
              } catch (_) {}
              safeSend({ type: 'file-skipped', filename: file, reason: 'gif-too-large' });
              gifCount++;
            } else {
              fileProgressCb('importing', 50);
              await syncScreenshot(filePath, true, subfolder);
              successCount++;
              gifCount++;
            }
          } catch (checkErr) {
            processingErrors.push({ filename: file, error: checkErr.message });
          }
        } else {
          fileProgressCb('importing', 50);
          await syncScreenshot(filePath, true, subfolder);
          successCount++;
        }

        completedCount++;
        const pct = totalFiles > 0 ? Math.round((fileOrder / totalFiles) * 100) : 100;
        sendProgress('manual-sync-progress', {
          total: totalFiles, completed: completedCount, percent: pct,
          fileIndex: fileOrder, filename: '', filePercent: 100, stage: 'file-done'
        });

      } catch (error) {
        if (isManualSyncCancelledError(error)) { cancelled = true; break; }
        console.error(`❌ 同步失败: ${file}`, error.message);
        processingErrors.push({ filename: file, error: error.message });
        completedCount++;
      }
    }

    if (cancelled) {
      console.log(`\n🛑 [手动模式] 同步已取消 (已完成 ${completedCount}/${totalFiles})\n`);
      safeSend({
        type: 'manual-sync-cancelled',
        count: successCount, totalFiles,
        imageCount: successCount - gifCount - videoCount,
        gifCount, completed: completedCount
      });
      return;
    }

    console.log(`\n✅ [手动模式] 同步完成！成功: ${successCount}/${totalFiles}\n`);
    if (processingErrors.length > 0) {
      console.log(`   ❌ 失败: ${processingErrors.length} 个`);
    }

    safeSend({
      type: 'manual-sync-complete',
      count: successCount,
      totalFiles,
      gifCount,
      videoCount,
      errors: processingErrors
    });

  } finally {
    manualSyncAbortRequested = false;
    isSyncing = false;
  }
}

// ============= 同步截图 =============
async function syncScreenshot(filePath, deleteAfterSync = false, subfolder = null) {
  const startTime = Date.now();
  const filename = path.basename(filePath);
  
  if (isFileProcessed(filePath)) {
    return;
  }
  
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('⏸️  等待服务器连接...');
      throw new Error('服务器未连接');
    }
    
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
      
    } else if (isHeif && os.platform() === 'darwin') {
      console.log(`   🔄 检测到 HEIF 格式，使用 sips 转换为 JPEG...`);
      
      // 等待 iCloud 文件完全下载
      console.log(`   ☁️  等待 iCloud 文件下载完成...`);
      const downloaded = await waitForICloudDownload(filePath);
      if (!downloaded) {
        console.log(`   ⚠️  文件可能未完全下载，尝试继续转换...`);
      }
      
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
    
    // 确定文件类型（复用上面已声明的 ext、isGif、isVideo 变量）
    const fileIsGif = isGif;
    const fileIsVideo = isVideo;
    const fileIsImage = !fileIsGif && !fileIsVideo;
    
    const payload = {
      type: 'screenshot',
      bytes: base64String,
      timestamp: Date.now(),
      filename: filename,
      keptInIcloud: !shouldCleanupFile(subfolder), // 根据备份设置判断
      isGif: fileIsGif,
      isVideo: fileIsVideo,
      isImage: fileIsImage
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
  console.log('⏳ 等待Figma插件连接...\n');
  
  // ✅ 无论是否连接插件，都立即启动文件监听器（用于自动整理）
  startWatching();
  
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
