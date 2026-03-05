require('dotenv').config();
const WebSocket = require('ws');
const sharp = require('sharp');

// 优化 sharp 配置，减少内存占用并提高稳定性（特别是在 LaunchAgent 环境下）
sharp.cache(false); // 禁用缓存
sharp.simd(false); // 禁用 SIMD
sharp.concurrency(Math.max(2, Math.min(8, (require('os').cpus()?.length || 4)))); // 提升并发处理吞吐

const { exec } = require('child_process');
const { promisify } = require('util');
const _execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const os = require('os');

// 追踪所有活跃子进程，插件关闭时统一 kill
const activeChildProcesses = new Set();

let _abortAllConversions = false;

function execAsync(cmd, opts) {
  return new Promise((resolve, reject) => {
    if (_abortAllConversions) {
      return reject(Object.assign(new Error('Conversion aborted'), { code: 'CONVERSION_ABORTED' }));
    }
    const child = exec(cmd, opts, (error, stdout, stderr) => {
      activeChildProcesses.delete(child);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
    activeChildProcesses.add(child);
  });
}

function killAllChildProcesses() {
  _abortAllConversions = true;
  for (const child of activeChildProcesses) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
  activeChildProcesses.clear();
}

const {
  listFolderFiles,
  downloadFileBuffer,
  trashFile,
  deleteFileImmediately,
  removeFileFromFolder,
  createFolder,
  getFileInfo
} = require('./googleDrive');

const userConfig = require('./userConfig');
const mediaTuning = require('./media-processing-tuning');

const {
  getUserIdentifier,
  getUserFolderName,
  getOrCreateUserConfig,
  updateDriveFolderId,
  getDriveFolderId,
  getLocalDownloadFolder
} = require('./userConfig');

/**
 * 确保本地下载文件夹存在
 */
function ensureLocalDownloadFolder() {
  try {
    const folderPath = getLocalDownloadFolder();
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      console.log(`📁 已创建本地下载文件夹: ${folderPath}`);
    }
    return folderPath;
  } catch (error) {
    console.error(`❌ 创建本地下载文件夹失败: ${error.message}`);
    return null;
  }
}

/**
 * 保存文件名到 cacheId 的映射（带容量限制，防止无限增长）
 * @param {string} fileName - 文件名
 * @param {string} cacheId - 缓存ID
 */
const CACHE_MAPPING_MAX_ENTRIES = 500; // 最多保留 500 条映射
function saveCacheMapping(fileName, cacheId) {
  try {
    const mappingFile = path.join(getLocalDownloadFolder(), '.cache-mapping.json');
    let mapping = {};
    if (fs.existsSync(mappingFile)) {
      try {
        mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
      } catch (e) {
        console.warn(`   ⚠️  读取映射文件失败，将创建新文件`);
      }
    }
    mapping[fileName] = cacheId;
    
    // 超出容量上限时，删除最早的条目（对象键的插入顺序）
    const keys = Object.keys(mapping);
    if (keys.length > CACHE_MAPPING_MAX_ENTRIES) {
      const excess = keys.length - CACHE_MAPPING_MAX_ENTRIES;
      for (let i = 0; i < excess; i++) {
        delete mapping[keys[i]];
      }
    }
    
    fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
  } catch (mappingError) {
    console.error(`   ⚠️  保存映射文件失败:`, mappingError.message);
  }
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
function getExtensionFromMimeType(mimeType) {
  if (!mimeType) return '';
  
  const mimeToExt = {
    // 图片格式
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    // 视频格式
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-m4v': '.m4v',
    'video/avi': '.avi',
    'video/mov': '.mov',
  };
  
  const ext = mimeToExt[mimeType.toLowerCase()];
  return ext || '';
}

/**
 * 清理文件名，移除或替换不安全的字符
 */
function sanitizeFilename(filename, mimeType) {
  // 提取文件扩展名
  let ext = path.extname(filename);
  
  // 对于视频文件，优先使用 MIME 类型来确定扩展名，因为 MIME 类型更可靠
  // 特别是 video/quicktime 应该使用 .mov 扩展名
  if (mimeType && mimeType.toLowerCase().startsWith('video/')) {
    const mimeExt = getExtensionFromMimeType(mimeType);
    if (mimeExt) {
      ext = mimeExt; // 使用 MIME 类型确定的扩展名
    }
  } else if (!ext && mimeType) {
    // 对于非视频文件，如果没有扩展名，尝试从 MIME 类型获取
    ext = getExtensionFromMimeType(mimeType);
  }
  
  // 获取不带扩展名的文件名（使用原始扩展名，不是可能从 MIME 类型获取的）
  const originalExt = path.extname(filename);
  const nameWithoutExt = path.basename(filename, originalExt);
  
  // 替换不安全的字符：
  // - / 和 \ 替换为 - (路径分隔符，会导致创建子目录)
  // - : 替换为 - (macOS 不允许文件名包含冒号)
  // - 其他控制字符和特殊字符也替换为 -
  const sanitized = nameWithoutExt
    .replace(/[/\\]/g, '-')  // 替换路径分隔符为连字符
    .replace(/:/g, '-')  // 替换冒号为连字符（macOS 不允许）
    .replace(/[<>"|?*\x00-\x1f]/g, '-')  // 替换其他不安全字符
    .replace(/-+/g, '-')  // 将多个连字符合并为单个
    .replace(/^-+|-+$/g, '');  // 移除开头和结尾的连字符
  
  // 如果清理后的文件名为空，使用默认名称
  const finalName = sanitized || 'untitled';
  
  return finalName + ext;
}

function classifyLargeFileFailure(error) {
  const rawCode = (error && error.code ? String(error.code) : '').toUpperCase();
  const message = String((error && error.message) || error || '').toLowerCase();

  if (
    rawCode === 'ENOSPC' ||
    message.includes('enospc') ||
    message.includes('no space left') ||
    message.includes('disk full') ||
    message.includes('磁盘') ||
    message.includes('空间不足')
  ) {
    return { code: 'disk-full', detail: 'local-disk-full' };
  }

  if (
    rawCode === 'EACCES' ||
    rawCode === 'EPERM' ||
    message.includes('eacces') ||
    message.includes('eperm') ||
    message.includes('permission denied') ||
    message.includes('operation not permitted') ||
    message.includes('权限')
  ) {
    return { code: 'permission-denied', detail: 'local-permission-denied' };
  }

  if (
    rawCode === 'ETIMEDOUT' ||
    rawCode === 'ESOCKETTIMEDOUT' ||
    rawCode === 'ECONNRESET' ||
    rawCode === 'ECONNREFUSED' ||
    rawCode === 'EHOSTUNREACH' ||
    rawCode === 'ENETUNREACH' ||
    rawCode === 'ENOTFOUND' ||
    rawCode === 'EAI_AGAIN' ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('connection reset') ||
    message.includes('network') ||
    message.includes('文件下载超时')
  ) {
    return { code: 'network', detail: 'unstable-network' };
  }

  return { code: 'unknown', detail: 'unknown' };
}

/**
 * 获取文件夹中的下一个序号（填补空缺）
 */
function getNextSequenceNumber(folderPath, prefix, extensions) {
  if (!fs.existsSync(folderPath)) {
    return 1;
  }
  
  const files = fs.readdirSync(folderPath);
  const existingNumbers = new Set();
  
  files.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (extensions.includes(ext)) {
      // 匹配格式：prefix_数字.ext
      const nameWithoutExt = path.basename(file, ext);
      const match = nameWithoutExt.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (match) {
        const num = parseInt(match[1], 10);
        existingNumbers.add(num);
      }
    }
  });
  
  // 如果没有文件，返回 1
  if (existingNumbers.size === 0) {
    return 1;
  }
  
  // 找到最大编号
  const maxNumber = Math.max(...existingNumbers);
  
  // 从 1 开始查找第一个空缺的编号
  for (let i = 1; i <= maxNumber; i++) {
    if (!existingNumbers.has(i)) {
      return i; // 返回第一个空缺的编号
    }
  }
  
  // 如果没有空缺，返回 maxNumber + 1
  return maxNumber + 1;
}

/**
 * 将文件保存到本地文件夹
 */
async function saveFileToLocalFolder(buffer, filename, mimeType, isExportedGif = false) {
  try {
    if (!buffer || buffer.length === 0) {
      console.error(`   ❌ [Local] Buffer 为空，无法保存`);
      return { success: false, isNew: false };
    }

    const folderPath = ensureLocalDownloadFolder();
    if (!folderPath) {
      console.error(`   ❌ [Local] 无法获取/创建本地文件夹路径`);
      return { success: false, isNew: false };
    }
    
    // 清理文件名，移除不安全字符，并根据 MIME 类型添加扩展名
    const safeFilename = sanitizeFilename(filename, mimeType);
    const ext = path.extname(safeFilename).toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov' || (mimeType && mimeType.startsWith('video/'));
    const isGif = ext === '.gif' || (mimeType && mimeType === 'image/gif');
    
    // 确定子文件夹和文件前缀
    let subfolderName, filePrefix, extensions;
    
    if (isExportedGif) {
      // 导出的GIF
      subfolderName = 'GIF-导出';
      filePrefix = 'ScreenRecordingGIF';
      extensions = ['.gif'];
    } else if (isGif) {
      // GIF
      subfolderName = 'GIF';
      filePrefix = 'ScreenRecordingGIF';  // 修改：统一命名格式
      extensions = ['.gif'];
    } else {
      // 图片（截图）
      subfolderName = '图片';
      filePrefix = 'ScreenShot';  // 修改：统一命名格式
      extensions = ['.jpg', '.jpeg', '.png'];
    }
    
    const subfolderPath = path.join(folderPath, subfolderName);
    if (!fs.existsSync(subfolderPath)) {
      fs.mkdirSync(subfolderPath, { recursive: true });
    }
    
    // 获取下一个序号
    const sequenceNumber = getNextSequenceNumber(subfolderPath, filePrefix, extensions);
    const paddedNumber = sequenceNumber.toString().padStart(3, '0');
    const newFilename = `${filePrefix}_${paddedNumber}${ext}`;
    const finalPath = path.join(subfolderPath, newFilename);
    
    // 确保目录存在
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 写入文件
    fs.writeFileSync(finalPath, buffer, { flag: 'w' });
    return { success: true, isNew: true, filename: newFilename, error: null, errorCode: null };
  } catch (error) {
    console.error(`   ❌ [Local] 保存文件到本地失败: ${error.message}`);
    return { success: false, isNew: false, error: error.message || String(error), errorCode: error.code || null };
  }
}


// 共享驱动器根文件夹ID（从环境变量读取，如果没有则使用 serviceAccountKey.js 中的默认值）
let SHARED_DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 如果环境变量未设置或为空字符串，尝试从 serviceAccountKey.js 读取默认值
if (!SHARED_DRIVE_FOLDER_ID || SHARED_DRIVE_FOLDER_ID.trim() === '') {
  try {
    const serviceAccountKey = require('./serviceAccountKey');
    if (serviceAccountKey && serviceAccountKey.defaultFolderId && serviceAccountKey.defaultFolderId.trim() !== '') {
      SHARED_DRIVE_FOLDER_ID = serviceAccountKey.defaultFolderId;
    }
  } catch (error) {
    // 忽略错误，继续使用环境变量
  }
}

const CONFIG = {
  wsUrl: process.env.WS_URL || 'ws://localhost:8888',
  connectionId: process.env.CONNECTION_ID || 'sync-session-1',
  sharedDriveFolderId: SHARED_DRIVE_FOLDER_ID,
  userFolderId: null, // 将在初始化时设置
  pollIntervalMs: Number(process.env.DRIVE_POLL_INTERVAL_MS || 800), // 默认0.8秒轮询，提升实时响应
  maxWidth: Number(process.env.DRIVE_MAX_WIDTH || 1920),
  quality: Number(process.env.DRIVE_IMAGE_QUALITY || 85),
  processExisting: process.env.DRIVE_PROCESS_EXISTING === '1',
  autoDelete: process.env.DRIVE_AUTO_DELETE !== '0',
  get backupScreenshots() {
    return userConfig.getBackupScreenshots();
  },
  get backupGif() {
    return userConfig.getBackupGif();
  }
};
const LARGE_GIF_URL_THRESHOLD = mediaTuning.thresholds.largeGifUrlMb * 1024 * 1024;
const ULTRA_SPEED_VIDEO_THRESHOLD_BYTES = mediaTuning.thresholds.ultraSpeedVideoMb * 1024 * 1024;

/**
 * 快速探测视频元数据（fps/宽高/时长），用于跳过不必要的滤镜。
 */
async function ffprobeVideoMeta(videoPath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${videoPath}"`,
      { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout);
    const vs = (info.streams || []).find(s => s.codec_type === 'video');
    if (!vs) return null;
    const [num, den] = (vs.r_frame_rate || '0/1').split('/');
    const fps = den ? parseFloat(num) / parseFloat(den) : parseFloat(num);
    return {
      fps: Number.isFinite(fps) ? fps : null,
      width: vs.width || 0,
      height: vs.height || 0,
      duration: parseFloat(info.format?.duration || vs.duration || '0'),
      hasAudio: (info.streams || []).some(s => s.codec_type === 'audio')
    };
  } catch (_) { return null; }
}

// 更严格的验证：检查是否为空字符串或无效值
if (!CONFIG.sharedDriveFolderId || CONFIG.sharedDriveFolderId.trim() === '' || CONFIG.sharedDriveFolderId === '.') {
  console.error('❌ 未配置 GDRIVE_FOLDER_ID（共享驱动器根文件夹ID），无法启动 drive-watcher');
  console.error('   请设置环境变量 GDRIVE_FOLDER_ID 或确保 serviceAccountKey.js 中包含有效的 defaultFolderId');
  process.exit(1);
}

function parseGifDimensions(buffer) {
  if (!buffer || buffer.length < 10) return null;
  try {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    };
  } catch (_) {
    return null;
  }
}

/**
 * 初始化用户文件夹
 * 如果用户文件夹不存在，则创建
 */
async function initializeUserFolder() {
  try {
    const userFolderName = getUserFolderName();
    const expectedUserId = getUserIdentifier();
    
    // 先检查配置文件中是否有用户文件夹ID
    let userFolderId = getDriveFolderId();
    
    if (userFolderId) {
      // 验证文件夹是否存在，并且名称正确
      try {
        // 获取文件夹详细信息
        const folderInfo = await getFileInfo(userFolderId);
        
        // 验证文件夹名称是否匹配
        if (folderInfo.name !== userFolderName) {
          console.log(`   ⚠️  文件夹名称不匹配，将重新创建`);
          userFolderId = null;
        } else if (folderInfo.mimeType !== 'application/vnd.google-apps.folder') {
          console.log(`   ⚠️  ID指向的不是文件夹，将重新创建`);
          userFolderId = null;
        } else {
          // 验证文件夹是否可以访问
          await listFolderFiles({ folderId: userFolderId, pageSize: 1 });
          CONFIG.userFolderId = userFolderId;
          return userFolderId;
        }
      } catch (error) {
        console.log(`   ⚠️  配置文件中的文件夹ID无效: ${error.message}`);
        userFolderId = null;
      }
    }
    
    // 再次验证 sharedDriveFolderId 是否有效
    if (!CONFIG.sharedDriveFolderId || CONFIG.sharedDriveFolderId.trim() === '' || CONFIG.sharedDriveFolderId === '.') {
      throw new Error(`无效的共享驱动器根文件夹ID: "${CONFIG.sharedDriveFolderId}"。请检查 GDRIVE_FOLDER_ID 环境变量或 serviceAccountKey.js 中的 defaultFolderId`);
    }
    
    let folder;
    try {
      folder = await createFolder({
        folderName: userFolderName,
        parentFolderId: CONFIG.sharedDriveFolderId
      });
    } catch (error) {
      console.error(`   ❌ 创建/查找文件夹失败: ${error.message}`);
      console.error(`   错误详情:`, error);
      
      // 提供更详细的错误信息
      if (error.message.includes('File not found')) {
        throw new Error(`无法访问共享驱动器根文件夹 (ID: ${CONFIG.sharedDriveFolderId})。可能原因：\n   1. Service Account 没有访问权限\n   2. 文件夹ID不正确\n   3. 共享驱动器未正确配置`);
      } else if (error.message.includes('Permission')) {
        throw new Error(`Service Account 没有在共享驱动器中创建文件夹的权限。请检查：\n   1. Service Account 是否已添加到共享驱动器\n   2. Service Account 是否有"内容管理员"或"编辑者"权限`);
      } else {
        throw error;
      }
    }
    
    userFolderId = folder.id;
    
    // 验证返回的文件夹ID
    if (!userFolderId) {
      throw new Error('创建文件夹后未返回文件夹ID');
    }
    
    // 保存到配置文件
    updateDriveFolderId(userFolderId);
    CONFIG.userFolderId = userFolderId;
    
    // 再次验证文件夹ID是否正确
    try {
      await listFolderFiles({ folderId: userFolderId, pageSize: 1 });
    } catch (error) {
      console.error(`   ⚠️  验证失败：无法访问文件夹: ${error.message}`);
      throw new Error(`用户文件夹ID验证失败: ${error.message}`);
    }
    
    console.log(`\n✅ [Drive] 用户文件夹初始化完成`);
    
    return userFolderId;
  } catch (error) {
    console.error('❌ 初始化用户文件夹失败:', error.message);
    console.error('   错误堆栈:', error.stack);
    throw error;
  }
}

let ws = null;
let pollTimer = null;
let isRealTimeMode = false;

function sendProgress(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type, ...data })); } catch (_) {}
  }
}

let wasRealTimeMode = false; // 记录断开前是否是实时模式，用于重连后恢复
let isPolling = false;
let lastPollTime = null;
let realTimeStart = null;
let isSyncing = false;
let manualSyncAbortRequested = false;
let manualSyncRunId = 0;
let pendingManualSync = false;
let lastDeepCleanupAt = 0;

const knownFileIds = new Set();
const knownFileMD5s = new Map(); // md5Checksum -> { fileId, filename, createdTime } - 用于去重
const pendingDeletes = new Map(); // fileId -> { filename, timestamp }
const processingFileIds = new Set(); // 正在处理中的文件 ID — 全局互斥锁，防止同一文件被实时同步和手动同步同时处理
const realtimeVideoQueue = [];
const realtimeQueuedVideoFileIds = new Set();
let isDriveRealtimeVideoQueueRunning = false;
const MAX_KNOWN_FILES = 10000; // 限制已知文件数量，防止内存无限增长
const DEEP_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 每 6 小时做一次深度清理
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 临时文件保留 24 小时
const MANUAL_SYNC_CANCELLED_CODE = 'MANUAL_SYNC_CANCELLED';

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

// 安全的 WebSocket 消息发送函数，防止发送失败导致崩溃
function safeSend(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('⚠️  WebSocket 未连接，无法发送消息');
    return false;
  }
  
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error('❌ 发送 WebSocket 消息失败:', error.message);
    return false;
  }
}

function notifyLocalGifSaved(filename, syncSource = 'realtime') {
  safeSend({
    type: 'local-gif-saved',
    filename,
    syncSource,
    timestamp: Date.now()
  });
}

function requestManualSyncCancel() {
  if (!isSyncing) return false;
  manualSyncAbortRequested = true;
  return true;
}

function enqueueDriveRealtimeVideo(file) {
  if (!file || !file.id) return;
  if (realtimeQueuedVideoFileIds.has(file.id)) return;
  realtimeQueuedVideoFileIds.add(file.id);
  realtimeVideoQueue.push(file);
  drainDriveRealtimeVideoQueue().catch(() => {});
}

async function drainDriveRealtimeVideoQueue() {
  if (isDriveRealtimeVideoQueueRunning) return;
  isDriveRealtimeVideoQueueRunning = true;
  try {
    const VIDEO_TIMEOUT_MS = 480000; // 视频→GIF 转换(含降级策略)需要更多时间：8 分钟
    while (realtimeVideoQueue.length > 0 && isRealTimeMode) {
      const file = realtimeVideoQueue.shift();
      if (!file) continue;
      realtimeQueuedVideoFileIds.delete(file.id);
      let _timeoutId;
      const fileTimeout = new Promise((_, reject) => {
        _timeoutId = setTimeout(() => reject(new Error(`SYNC_TIMEOUT:${file.name}`)), VIDEO_TIMEOUT_MS);
      });
      try {
        await Promise.race([handleDriveFile(file, true, null, null, 'realtime'), fileTimeout]);
      } catch (fileError) {
        const msg = String(fileError && fileError.message ? fileError.message : fileError || '');
        const isTimeout = msg.startsWith('SYNC_TIMEOUT:') || msg.includes('超时');
        if (isTimeout) {
          console.warn(`   ⚠️  [Video→GIF] 视频转换超时，已保留源文件: ${file.name}`);
        } else {
          console.error(`   ❌ 实时视频处理失败: ${file.name} ${msg}`);
        }
      } finally {
        clearTimeout(_timeoutId);
      }
    }
  } finally {
    isDriveRealtimeVideoQueueRunning = false;
    if (realtimeVideoQueue.length > 0 && isRealTimeMode) {
      drainDriveRealtimeVideoQueue().catch(() => {});
    }
  }
}

// 清理文件的所有记录（从knownFileIds、knownFileMD5s、processingFileIds中移除）
function cleanupFileRecord(fileId, md5Checksum = null) {
  // 注意：不能从 knownFileIds 中删除！
  // 文件一旦被处理过，即使云端删除成功/失败，都必须保留在 knownFileIds 中，
  // 否则下次轮询会把它当"新文件"再次同步，导致无限重复。
  processingFileIds.delete(fileId);
  
  if (md5Checksum && knownFileMD5s.has(md5Checksum)) {
    const record = knownFileMD5s.get(md5Checksum);
    if (record.fileId === fileId) {
      knownFileMD5s.delete(md5Checksum);
    }
  } else if (!md5Checksum) {
    for (const [md5, record] of knownFileMD5s.entries()) {
      if (record.fileId === fileId) {
        knownFileMD5s.delete(md5);
        break;
      }
    }
  }
}

async function deleteDriveSourceFileWithFallback(fileId, filename, md5Checksum = null) {
  if (!fileId) return false;

  const folderId = CONFIG.userFolderId;
  const ops = [
    // 最优先：从监控文件夹中移除（Service Account Editor 权限即可操作）
    folderId
      ? { name: 'removeFromFolder', fn: () => removeFileFromFolder(fileId, folderId) }
      : null,
    { name: 'trash(allDrives)', fn: () => trashFile(fileId, true) },
    { name: 'trash(singleDrive)', fn: () => trashFile(fileId, false) },
    { name: 'delete(allDrives)', fn: () => deleteFileImmediately(fileId, true) },
    { name: 'delete(singleDrive)', fn: () => deleteFileImmediately(fileId, false) }
  ].filter(Boolean);

  let lastErr = null;
  for (const op of ops) {
    try {
      await op.fn();
      cleanupFileRecord(fileId, md5Checksum);
      console.log(`   🗑️  已从云端清理源文件: ${filename} (${op.name})`);
      return true;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg.includes('File not found') || msg.includes('not found') || msg.includes('404') || msg.includes('does not exist')) {
        cleanupFileRecord(fileId, md5Checksum);
        console.log(`   ℹ️  云端文件已不存在，视为已清理: ${filename}`);
        return true;
      }
      lastErr = err;
      console.warn(`   ⚠️  清理尝试失败 (${op.name}): ${filename} (${msg})`);
    }
  }

  if (lastErr) {
    throw lastErr;
  }
  return false;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 每5分钟清理一次

async function initializeKnownFiles() {
  if (!CONFIG.userFolderId) {
    throw new Error('用户文件夹未初始化');
  }
  
  // 初始化时间基准
  realTimeStart = new Date();
  // 查询时间回退1分钟，作为缓冲
  const queryStart = new Date(realTimeStart.getTime() - 60000);
  lastPollTime = queryStart.toISOString();
  
  // 清空已知文件列表和处理锁
  knownFileIds.clear();
  processingFileIds.clear();
  realtimeVideoQueue.length = 0;
  realtimeQueuedVideoFileIds.clear();
  isDriveRealtimeVideoQueueRunning = false;
  
  try {
    // 获取所有现有的图片文件
    const { files } = await listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 500, // 增大页面大小以获取更多文件
      orderBy: 'createdTime desc' // 按创建时间倒序
    });
    
    // 过滤图片和视频文件，并标记为已知
    const imageFiles = files.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
     // 将所有现有文件标记为"已知"，并记录MD5用于去重
     for (const file of imageFiles) {
       knownFileIds.add(file.id);
       // 记录MD5以便去重（如果文件有MD5）
       if (file.md5Checksum) {
         knownFileMD5s.set(file.md5Checksum, {
           fileId: file.id,
           filename: file.name,
           createdTime: file.createdTime
         });
       }
     }
     
     console.log(`✅ [Drive] 已标记 ${knownFileIds.size} 个现有文件为"已知"，只处理新文件`);

     // 通知用户已存在的现有文件数量，提示使用手动同步
     if (knownFileIds.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
       safeSend({
         type: 'toast',
         message: `实时模式已启动 (忽略 ${knownFileIds.size} 个现有文件，如需同步请使用"手动同步")`,
         duration: 5000,
         level: 'info'
       });
     }
  } catch (error) {
    console.warn(`⚠️  扫描现有文件时出错: ${error.message}，可能会同步一些旧文件`);
  }
}

async function pollDrive() {
  if (!isRealTimeMode) {
    // 静默跳过，不打印日志（避免日志刷屏）
    return;
  }
  if (isPolling) {
    return;
  }
  if (!CONFIG.userFolderId) {
    console.error('❌ 用户文件夹未初始化，跳过轮询');
    return;
  }

  isPolling = true;
  const pollStart = new Date();

  try {
    // 构造增量查询条件
    const customQuery = lastPollTime ? `createdTime > '${lastPollTime}'` : null;
    
    // 只获取一页（增量模式下通常文件很少）
      const result = await listFolderFiles({ 
        folderId: CONFIG.userFolderId, 
      pageSize: 100, 
      orderBy: 'createdTime asc', // 按创建时间正序，先处理旧的
      customQuery
    });
    
    const allFiles = result.files || [];
    
    // 过滤图片和视频文件
    const imageFiles = allFiles.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      // 忽略 _exported 结尾的文件（这是服务器自己生成的导出 GIF）
      // 移除末尾的点检查，以兼容 "xxx_exported 2.gif" 这种冲突重命名的情况
      if (name.toLowerCase().includes('_exported')) {
        return false;
      }

      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    const newFiles = [];
    for (const file of imageFiles) {
      // 1. 去重
      if (knownFileIds.has(file.id)) {
        continue;
      }
      
      // 2. 严格时间过滤（只处理启动后创建的文件）
      const fileTime = new Date(file.createdTime);
      if (realTimeStart && fileTime < realTimeStart) {
        knownFileIds.add(file.id); // 标记为已知，下次不再处理
        continue;
      }
      
      // 3. ✅ MD5去重检测：只查重当前云端存在的文件
      if (file.md5Checksum && knownFileMD5s.has(file.md5Checksum)) {
        const existingFile = knownFileMD5s.get(file.md5Checksum);
        
        // 检查已存在的文件是否还在云端（通过检查knownFileIds）
        if (knownFileIds.has(existingFile.fileId)) {
          // 文件仍在云端，确实是重复文件
          try {
            await trashFile(file.id);
          } catch (deleteError) {
            console.error(`   ❌ 删除重复文件失败:`, deleteError.message);
          }
          
          // 标记为已知，避免重复处理
          knownFileIds.add(file.id);
          continue;
        } else {
          // 旧文件已不在云端（已被同步并清理），更新MD5记录为新文件
          // 继续处理，不跳过
        }
      }
      
        knownFileIds.add(file.id);
        // 记录MD5，用于后续去重
        if (file.md5Checksum) {
          knownFileMD5s.set(file.md5Checksum, {
            fileId: file.id,
            filename: file.name,
            createdTime: file.createdTime
          });
        }
        newFiles.push(file);
      }

    if (newFiles.length > 0) {
      console.log(`🔄 [Drive] 检测到 ${newFiles.length} 个新文件，并发处理...`);
      
      // 并发处理新文件（提高多图同步速度）
      const IMAGE_TIMEOUT_MS = 60000; // 图片 60 秒
      const downloadFailedFiles = []; // 记录失败明细（保留云端）
      
      // 分类：图片优先即时同步，录屏异步进入转换队列
      const imageFiles = [];
      const videoFiles = [];
      for (const file of newFiles) {
        const fName = (file.name || '').toLowerCase();
        const fMime = (file.mimeType || '').toLowerCase();
        const isVideoFile = fName.endsWith('.mp4') || fName.endsWith('.mov') || fMime.startsWith('video/');
        (isVideoFile ? videoFiles : imageFiles).push(file);
      }
      
      if (imageFiles.length > 0) {
        console.log(`   📸 ${imageFiles.length} 张图片即时同步...`);
      }
      if (videoFiles.length > 0) {
        console.log(`   🎬 ${videoFiles.length} 段录屏进入后台转换队列（不阻塞图片同步）...`);
      }
      
      const processFile = async (file, timeoutMs) => {
        let _fileTimeoutId;
        const fileTimeout = new Promise((_, reject) => {
          _fileTimeoutId = setTimeout(() => reject(new Error(`SYNC_TIMEOUT:${file.name}`)), timeoutMs);
        });
        try {
          await Promise.race([handleDriveFile(file, true, null, null, 'realtime'), fileTimeout]);
        } catch (fileError) {
          const isTimeout = fileError.message.startsWith('SYNC_TIMEOUT:') || fileError.message.includes('超时');
          if (isTimeout) {
            const fNameLower = (file.name || '').toLowerCase();
            const isVideoFile = fNameLower.endsWith('.mp4') || fNameLower.endsWith('.mov');
            if (isVideoFile) {
              console.warn(`   ⚠️  [Video→GIF] 视频转换超时，已保留源文件: ${file.name}`);
            } else {
              downloadFailedFiles.push({
                filename: file.name,
                reasonCode: 'network',
                detail: 'sync-timeout'
              });
              console.warn(`   ⚠️  [大文件] 下载/处理超时，保留云端文件避免丢失: ${file.name}`);
            }
          } else {
            console.error(`   ❌ 处理文件失败: ${file.name}`, fileError.message);
            const reason = classifyLargeFileFailure(fileError);
            if (reason.code !== 'unknown') {
              downloadFailedFiles.push({
                filename: file.name,
                reasonCode: reason.code,
                detail: reason.detail
              });
            }
          }
        } finally {
          clearTimeout(_fileTimeoutId);
        }
      };
      
      // 图片优先：先并发完成图片；视频进入后台队列，避免阻塞后续图片同步
      try {
        if (imageFiles.length > 0) {
          await Promise.all(imageFiles.map(f => processFile(f, IMAGE_TIMEOUT_MS)));
        }
        if (videoFiles.length > 0) {
          for (const vf of videoFiles) enqueueDriveRealtimeVideo(vf);
        }
      } catch (timeoutError) {
        console.error('⚠️  批量处理超时，部分文件可能未处理完成');
      }
      
      // 通知 Figma 插件：超大文件下载失败（云端文件已保留）
      if (downloadFailedFiles.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        const reasonCount = downloadFailedFiles.reduce((acc, f) => {
          acc[f.reasonCode] = (acc[f.reasonCode] || 0) + 1;
          return acc;
        }, {});
        const primaryReason = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0][0];
        ws.send(JSON.stringify({
          type: 'large-file-download-failed',
          reason: 'network-timeout',
          count: downloadFailedFiles.length,
          primaryReason,
          filenames: downloadFailedFiles.map(f => f.filename),
          failures: downloadFailedFiles
        }));
        console.log(`   📨 已通知插件：${downloadFailedFiles.length} 个超时文件下载失败（云端已保留）`);
      }
    }
    
    // 更新 lastPollTime
    // 推进查询游标：使用本次轮询开始时间 - 1分钟（安全缓冲）
    const nextQueryTime = new Date(pollStart.getTime() - 60000);
    lastPollTime = nextQueryTime.toISOString();
    
  } catch (error) {
    console.error('⚠️  轮询失败:', error.message);
    console.error('   错误详情:', error.stack || error);
    // 即使失败，也确保下次轮询能继续
  } finally {
    isPolling = false;
  }
}

async function handleDriveFile(file, deleteAfterSync = false, progressCb = null, shouldAbort = null, syncSource = 'realtime') {
  // 全局互斥：同一个文件 ID 不允许并发处理
  if (processingFileIds.has(file.id)) {
    console.log(`   ⏭️  [去重] 文件正在处理中，跳过: ${file.name} (${file.id})`);
    return; // 静默跳过，不抛异常
  }
  processingFileIds.add(file.id);
  
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('服务器未连接');
    }
    const throwIfAborted = () => {
      if (typeof shouldAbort === 'function' && shouldAbort()) {
        throw createManualSyncCancelledError();
      }
    };
    throwIfAborted();

    const startTime = Date.now();
    const emitProgress = (stage, percent, extra = {}) => {
      throwIfAborted();
      if (progressCb) progressCb(stage, percent, extra);
      sendProgress('conversion-progress', {
        filename: file.name,
        fileId: file.id,
        stage, percent,
        elapsed: Date.now() - startTime,
        ...extra
      });
    };

    // 预判文件类型（基于元数据，用于进度显示）
    const fileNameLower = (file.name || '').toLowerCase();
    const fileMimeLower = (file.mimeType || '').toLowerCase();
    const looksLikeVideo = fileNameLower.endsWith('.mp4') || fileNameLower.endsWith('.mov') || fileMimeLower.startsWith('video/');
    
    emitProgress('downloading', 5, looksLikeVideo ? { isVideo: true } : {});
    let downloadProgressTimer = null;
    if (looksLikeVideo) {
      let downloadingPct = 5;
      // 无损优化：下载阶段平滑推进，避免大文件长时间停在 5%
      downloadProgressTimer = setInterval(() => {
        try {
          downloadingPct = Math.min(19, downloadingPct + 1);
          emitProgress('downloading', downloadingPct, { isVideo: true, stageDetail: 'downloading-large-video' });
        } catch (_) {}
      }, 1200);
    }
    let backedUpLocally = false;
    let localSaveFailureReason = null;
    let gifCacheId = null;
    let deferredLocalBackup = null;
    const downloadTimeout = looksLikeVideo ? 300000 : 60000; // 视频 5 分钟，图片 60 秒
    let originalBuffer;
    try {
      originalBuffer = await downloadFileBuffer(file.id, downloadTimeout);
    } finally {
      if (downloadProgressTimer) {
        clearInterval(downloadProgressTimer);
        downloadProgressTimer = null;
      }
    }
    throwIfAborted();
    const downloadedSizeKB = (originalBuffer.length / 1024).toFixed(2);
    emitProgress('downloading', 20, { sizeKB: parseFloat(downloadedSizeKB), ...(looksLikeVideo ? { isVideo: true } : {}) });
    
    let processedBuffer = originalBuffer;
    let backupImageFilename = null;
    let backupImageMimeType = null;
    const processStartTime = Date.now();
    
    // 检测文件格式
    const fileName = file.name.toLowerCase();
    const fileNameIsHeif = fileName.endsWith('.heif') || fileName.endsWith('.heic');
    const fileNameIsGif = fileName.endsWith('.gif');
    const fileNameIsVideo = fileName.endsWith('.mp4') || fileName.endsWith('.mov');
    
    // 检测是否为视频格式（MP4 或 MOV）
    let isVideo = fileNameIsVideo;
    if (!isVideo) {
      // 尝试检测 MIME 类型
      const mimeType = (file.mimeType || '').toLowerCase();
      // 视频文件的 MIME 类型通常是 video/mp4 或 video/quicktime
      isVideo = mimeType.startsWith('video/') || 
                mimeType === 'video/mp4' || 
                mimeType === 'video/quicktime' ||
                mimeType === 'video/x-m4v';
    }
    
    // 检测是否为 GIF / HEIF（视频文件直接跳过 sharp 元数据探测，减少无损耗时）
    let isGif = fileNameIsGif;
    let isHeif = fileNameIsHeif;
    if (!isVideo) {
      if (!isGif) {
        const mimeType = (file.mimeType || '').toLowerCase();
        if (mimeType === 'image/gif') {
          isGif = true;
        } else {
          try {
            const sharpImage = sharp(originalBuffer);
            const metadata = await sharpImage.metadata();
            isGif = metadata.format === 'gif';
          } catch (metaError) {
            isGif = false;
          }
        }
      }

      if (!isHeif) {
        try {
          const sharpImage = sharp(originalBuffer);
          const metadata = await sharpImage.metadata();
          isHeif = metadata.format === 'heif' || metadata.format === 'heic';
        } catch (metaError) {
          const errorMsg = metaError.message.toLowerCase();
          if (errorMsg.includes('heif') || errorMsg.includes('heic') || errorMsg.includes('codec')) {
            isHeif = true;
          }
        }
      }
    }
    
    let conversionOk = false; // 标记视频→GIF 转换是否成功
    
    if (isVideo) {
      const videoSizeBytes = originalBuffer.length;
      const videoSizeMB = (videoSizeBytes / 1024 / 1024).toFixed(1);
      const isLargeFile = videoSizeBytes >= mediaTuning.thresholds.largeVideoMb * 1024 * 1024;
      const isUltraLargeFile = videoSizeBytes >= ULTRA_SPEED_VIDEO_THRESHOLD_BYTES;
      const convStartTime = Date.now();
      console.log(`   🎬 [Video→GIF] 开始转换 ${file.name} (${videoSizeMB}MB) [${isUltraLargeFile ? '极速两遍' : (isLargeFile ? '大文件两遍' : '小文件两遍')}]...`);
      
      const estimatedSec = Math.max(
        5,
        Math.ceil(
          parseFloat(videoSizeMB) * (
            isUltraLargeFile
              ? mediaTuning.watcher.estimateFactor.ultra
              : (isLargeFile ? mediaTuning.watcher.estimateFactor.large : mediaTuning.watcher.estimateFactor.normal)
          )
        )
      );
      emitProgress('converting', 25, { estimatedSec, isVideo: true });
      
      const tempDir = path.join(os.tmpdir(), `screensync-v2g-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      
      const videoExt = fileName.endsWith('.mov') ? '.mov' : '.mp4';
      const tempVideoPath = path.join(tempDir, `input${videoExt}`);
      const tempGifOut = path.join(tempDir, 'output.gif');
      
      try {
        throwIfAborted();
        fs.writeFileSync(tempVideoPath, originalBuffer);
        emitProgress('converting', 28, { estimatedSec, isVideo: true, stageDetail: 'downscale-half-before-gif' });
        const FF_OPT = '-nostdin -v warning';
        const tempHalfVideo = path.join(tempDir, 'half-scale.mp4');
        let conversionSourceVideo = tempVideoPath;
        const halfScaleCmd = `ffmpeg -hwaccel auto ${FF_OPT} -threads 0 -i "${tempVideoPath}" -vf "setpts=PTS,scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=lanczos" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -an -movflags +faststart -y "${tempHalfVideo}"`;
        try {
          await execAsync(halfScaleCmd, { timeout: 240000, maxBuffer: 120 * 1024 * 1024 });
          if (fs.existsSync(tempHalfVideo) && fs.statSync(tempHalfVideo).size > 0) {
            conversionSourceVideo = tempHalfVideo;
          }
        } catch (scaleErr) {
          console.warn(`   ⚠️  [Video→GIF] 预缩放失败，回退原视频: ${scaleErr.message}`);
        }

        const _meta = await ffprobeVideoMeta(conversionSourceVideo);
        const _sourceFps = _meta?.fps || 999;
        emitProgress('converting', 30, { estimatedSec, isVideo: true });

        const buildFilterChain = (targetFps) => {
          const parts = ['setpts=PTS'];
          if (_sourceFps > targetFps + 0.5) parts.push(`fps=${targetFps}`);
          return parts.join(',');
        };
        
        // 并行：缓存原始视频到 GIF 缓存（用于后续导出），但不保留本地视频文件
        const cachePromise = (async () => {
          if (isUltraLargeFile) {
            // >100MB 优先让出 CPU/IO 给转换主流程，缓存延后处理
            return;
          }
          try {
            const r = userConfig.saveGifToCache(originalBuffer, file.name, file.id);
            if (r) gifCacheId = r.cacheId;
          } catch (_) {}
          originalBuffer = null;
        })();
        
        const tempPalette = path.join(tempDir, 'palette.png');
        const tempCompressedVideo = path.join(tempDir, 'compressed.mp4');
        const isTimeoutLike = (err) => {
          if (!err) return false;
          const msg = String(err.message || '');
          return Boolean(err.killed || err.signal === 'SIGTERM' || msg.includes('timed out') || msg.includes('ETIMEDOUT'));
        };
        const isAbortError = (err) => err && err.code === 'CONVERSION_ABORTED';

        // 大/超大文件专用两遍法：消除 split 帧缓冲，内存从 O(n_frames) 降至 O(1)
        const runLargeTwoPass = async (sourceVideoPath, targetFps, maxColors, dither, totalTimeout) => {
          const filterBase = buildFilterChain(targetFps);
          const pass1Timeout = Math.ceil(totalTimeout * 0.45);
          const pass2Timeout = Math.ceil(totalTimeout * 0.7);
          const pass1Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -vf "${filterBase},palettegen=max_colors=${maxColors}:stats_mode=diff:reserve_transparent=0" -y "${tempPalette}"`;
          await execAsync(pass1Cmd, { timeout: pass1Timeout, maxBuffer: 50 * 1024 * 1024 });
          throwIfAborted();
          emitProgress('converting', 50, { estimatedSec, isVideo: true });
          const pass2Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -i "${tempPalette}" -lavfi "${filterBase}[v];[v][1:v]paletteuse=dither=${dither}:diff_mode=rectangle" -loop 0 -y "${tempGifOut}"`;
          await execAsync(pass2Cmd, { timeout: pass2Timeout, maxBuffer: 200 * 1024 * 1024 });
        };

        // 小文件两遍（保留 lanczos 高质量 + sierra2_4a 抖动）
        const runSmallTwoPass = async (sourceVideoPath, targetFps, pass1Timeout, pass2Timeout) => {
          const filterBase = buildFilterChain(targetFps);
          const pass1Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -vf "${filterBase},palettegen=max_colors=256:stats_mode=full:reserve_transparent=0" -y "${tempPalette}"`;
          await execAsync(pass1Cmd, { timeout: pass1Timeout, maxBuffer: 50 * 1024 * 1024 });
          throwIfAborted();
          emitProgress('converting', 55, { estimatedSec, isVideo: true });
          const pass2Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -i "${tempPalette}" -lavfi "${filterBase}[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 -y "${tempGifOut}"`;
          await execAsync(pass2Cmd, { timeout: pass2Timeout, maxBuffer: 200 * 1024 * 1024 });
        };

        // 回退用单遍（已压缩过的小源文件，split 缓冲压力可接受）
        const runFallbackSinglePass = async (sourceVideoPath, fps, maxColors, dither, timeout) => {
          const baseFilter = buildFilterChain(fps);
          const cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -lavfi "${baseFilter},split[s0][s1];[s0]palettegen=max_colors=${maxColors}:stats_mode=diff:reserve_transparent=0[p];[s1][p]paletteuse=dither=${dither}:diff_mode=rectangle" -loop 0 -y "${tempGifOut}"`;
          await execAsync(cmd, { timeout, maxBuffer: 200 * 1024 * 1024 });
        };

        let converted = false;
        try {
          if (isUltraLargeFile) {
            await runLargeTwoPass(
              conversionSourceVideo,
              mediaTuning.watcher.ultra.fps,
              mediaTuning.watcher.ultra.maxColors,
              mediaTuning.watcher.ultra.dither,
              mediaTuning.watcher.ultra.timeoutMs
            );
          } else if (isLargeFile) {
            await runLargeTwoPass(
              conversionSourceVideo,
              mediaTuning.watcher.largeSinglePass.fps,
              mediaTuning.watcher.largeSinglePass.maxColors,
              mediaTuning.watcher.largeSinglePass.dither,
              mediaTuning.watcher.largeSinglePass.timeoutMs
            );
          } else {
            await runSmallTwoPass(
              conversionSourceVideo,
              mediaTuning.watcher.smallTwoPass.fps,
              mediaTuning.watcher.smallTwoPass.pass1TimeoutMs,
              mediaTuning.watcher.smallTwoPass.pass2TimeoutMs
            );
          }
          converted = true;
        } catch (primaryErr) {
          if (isAbortError(primaryErr)) throw primaryErr;
          const reason = isTimeoutLike(primaryErr) ? 'progress-stalled-at-5' : 'primary-conversion-failed';
          console.warn(`   ⚠️  [Video→GIF] 主转换失败，触发降级策略 (${reason}): ${primaryErr.message}`);
          emitProgress('converting', 12, { estimatedSec, isVideo: true, degraded: true, reason });
        }

        if (!converted && !isUltraLargeFile) {
          throwIfAborted();
          try {
            emitProgress('converting', 20, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'compressing-video' });
            const compressCmd = `ffmpeg -hwaccel auto ${FF_OPT} -threads 0 -i "${conversionSourceVideo}" -vf "setpts=PTS" -c:v libx264 -preset ${mediaTuning.watcher.fallbackCompressVideo.preset} -crf ${mediaTuning.watcher.fallbackCompressVideo.crf} -pix_fmt yuv420p -an -movflags +faststart -y "${tempCompressedVideo}"`;
            await execAsync(compressCmd, { timeout: mediaTuning.watcher.fallbackCompressVideo.timeoutMs, maxBuffer: 120 * 1024 * 1024 });
            throwIfAborted();
            if (!fs.existsSync(tempCompressedVideo) || fs.statSync(tempCompressedVideo).size === 0) {
              throw new Error('视频压缩输出为空');
            }
            emitProgress('converting', 35, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'converting-compressed-video' });
            await runFallbackSinglePass(
              tempCompressedVideo,
              mediaTuning.watcher.fallbackAfterCompressToGif.fps,
              mediaTuning.watcher.fallbackAfterCompressToGif.maxColors,
              mediaTuning.watcher.fallbackAfterCompressToGif.dither,
              mediaTuning.watcher.fallbackAfterCompressToGif.timeoutMs
            );
            converted = true;
          } catch (fallbackErr) {
            if (isAbortError(fallbackErr)) throw fallbackErr;
            console.warn(`   ⚠️  [Video→GIF] 回退策略1失败: ${fallbackErr.message}`);
          }
        }

        if (!converted) {
          throwIfAborted();
          emitProgress('converting', 45, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'lossy-gif-fallback' });
          const lossySource = fs.existsSync(tempCompressedVideo) ? tempCompressedVideo : conversionSourceVideo;
          await runFallbackSinglePass(
            lossySource,
            isUltraLargeFile
              ? Math.max(mediaTuning.watcher.ultra.fallbackMinFps, mediaTuning.watcher.ultra.fps - 1)
              : mediaTuning.watcher.fallbackLossy.fps,
            isUltraLargeFile
              ? Math.max(mediaTuning.watcher.ultra.fallbackMinColors, mediaTuning.watcher.ultra.maxColors - 16)
              : mediaTuning.watcher.fallbackLossy.maxColors,
            isUltraLargeFile ? mediaTuning.watcher.ultra.fallbackDither : mediaTuning.watcher.fallbackLossy.dither,
            isUltraLargeFile
              ? Math.max(mediaTuning.watcher.ultra.fallbackTimeoutFloorMs, mediaTuning.watcher.ultra.timeoutMs - mediaTuning.watcher.ultra.fallbackTimeoutReduceMs)
              : mediaTuning.watcher.fallbackLossy.timeoutMs
          );
          converted = true;
        }

        // 等待转换和缓存并行完成
        await cachePromise;
        throwIfAborted();
        
        if (!fs.existsSync(tempGifOut) || fs.statSync(tempGifOut).size === 0) {
          throw new Error('转换输出为空');
        }
        
        emitProgress('converting', 80, { isVideo: true });
        
        const gifBuffer = fs.readFileSync(tempGifOut);
        const gifSizeMB = (gifBuffer.length / 1024 / 1024).toFixed(1);
        const convTime = ((Date.now() - convStartTime) / 1000).toFixed(1);
        console.log(`   ✅ [Video→GIF] ${videoSizeMB}MB → ${gifSizeMB}MB GIF (${convTime}秒)`);
        
        processedBuffer = gifBuffer;
        file.name = file.name.replace(/\.(mov|mp4)$/i, '.gif');
        file.mimeType = 'image/gif';
        isVideo = false;
        isGif = true;
        conversionOk = true;
        
        // 保存转换后的 GIF 到缓存 + 本地备份（轻量操作，串行即可）
        try {
          const gifCacheResult = userConfig.saveGifToCache(processedBuffer, file.name, file.id);
          if (gifCacheResult) gifCacheId = gifCacheResult.cacheId;
        } catch (_) {}
        
        const backupMode = userConfig.getBackupMode();
        if (backupMode === 'gif_only' || backupMode === 'all') {
          if (processedBuffer.length > LARGE_GIF_URL_THRESHOLD) {
            const bufForBackup = processedBuffer;
            const nameForBackup = file.name;
            deferredLocalBackup = async () => {
              try {
                const sr = await saveFileToLocalFolder(bufForBackup, nameForBackup, 'image/gif');
                if (sr && sr.success && sr.isNew) {
                  notifyLocalGifSaved(nameForBackup, syncSource);
                  return true;
                }
                if (sr && !sr.success) {
                  localSaveFailureReason = classifyLargeFileFailure({ code: sr.errorCode, message: sr.error });
                }
              } catch (_) {}
              return false;
            };
            backedUpLocally = false;
          } else {
            const sr = await saveFileToLocalFolder(processedBuffer, file.name, 'image/gif');
            backedUpLocally = (sr && sr.success && sr.isNew) || false;
            if (backedUpLocally) notifyLocalGifSaved(file.name, syncSource);
            if (!backedUpLocally && sr && !sr.success) {
              localSaveFailureReason = classifyLargeFileFailure({ code: sr.errorCode, message: sr.error });
            }
          }
        }
        
      } catch (convErr) {
        if (isManualSyncCancelledError(convErr) || (convErr && convErr.code === 'CONVERSION_ABORTED')) {
          throw convErr;
        }
        console.error(`   ❌ [Video→GIF] 转换失败 (${((Date.now() - convStartTime) / 1000).toFixed(1)}秒): ${convErr.message}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'file-skipped', filename: file.name, reason: 'video', gifCacheId, driveFileId: file.id }));
        }
        // 降级策略仍失败时，保留云端源文件，避免“自动清理”导致用户无法手动处理
        console.warn(`   ⚠️  [Video→GIF] 已保留源视频（未自动清理）: ${file.name}`);
        return;
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
    
    if (conversionOk) {
      // 视频→GIF 转换完成，processedBuffer 已设好，跳过所有格式处理直接进入发送
    } else if (isGif) {
      // 原始 GIF 文件处理
      // 原始 GIF：统一走自动导入流程（不再按 100MB 强制手动）
      processedBuffer = originalBuffer;
      
      // 自动保存 GIF 到缓存（用于导出带标注的 GIF 功能）
      try {
        const cacheResult = userConfig.saveGifToCache(processedBuffer, file.name, file.id);
        if (cacheResult) {
          gifCacheId = cacheResult.cacheId;
        }
      } catch (cacheError) {
        console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
      }
      
      const backupMode = userConfig.getBackupMode();
      const shouldBackupGif = (backupMode === 'gif_only' || backupMode === 'all');

      if (shouldBackupGif) {
        const saveResult = await saveFileToLocalFolder(processedBuffer, file.name, file.mimeType);
        backedUpLocally = (saveResult && saveResult.success && saveResult.isNew) || false;
        if (backedUpLocally) notifyLocalGifSaved(file.name, syncSource);
        if (!backedUpLocally && saveResult && !saveResult.success) {
          localSaveFailureReason = classifyLargeFileFailure({ code: saveResult.errorCode, message: saveResult.error });
        }
      } else {
        backedUpLocally = false;
      }

      originalBuffer = null;
    } else if (isHeif && os.platform() === 'darwin') {
      // 在 try 块外定义变量，确保 catch 块可以访问
      let tempInputPath = path.join(os.tmpdir(), `heif-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.heic`);
      let tempOutputPath = path.join(os.tmpdir(), `jpeg-output-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
      
      try {
        throwIfAborted();
        // 写入临时文件
        fs.writeFileSync(tempInputPath, originalBuffer);
        
        const sipsCommand = `sips -s format jpeg "${tempInputPath}" --out "${tempOutputPath}"`;
        const outputPath = tempOutputPath;
        
        await execAsync(sipsCommand, { maxBuffer: 10 * 1024 * 1024 });
        if (!fs.existsSync(outputPath)) {
          throw new Error('sips 转换失败: 输出文件不存在');
        }
        
        // 读取转换后的 JPEG 文件
        let convertedBuffer = fs.readFileSync(outputPath);
        throwIfAborted();
        
        const manualFastPassBytes = mediaTuning.thresholds.manualImageFastPassKb * 1024;
        const isManualSmallHeif = syncSource === 'manual' && originalBuffer && originalBuffer.length <= manualFastPassBytes;

        if (isManualSmallHeif) {
          // 小 HEIF 手动同步极速直通：sips 转 JPEG 后直接发送，跳过 sharp 二次处理
          processedBuffer = convertedBuffer;
          backupImageFilename = file.name.replace(/\.(heic|heif)$/i, '.jpg');
          backupImageMimeType = 'image/jpeg';
        } else {
          // 使用 sharp 对转换后的 JPEG 进行压缩和调整大小
          processedBuffer = await sharp(convertedBuffer)
            .resize(CONFIG.maxWidth, null, {
              withoutEnlargement: true,
              fit: 'inside'
            })
            .jpeg({ quality: CONFIG.quality })
            .toBuffer();
        }
        
        // 清理临时文件
        try {
          fs.unlinkSync(tempInputPath);
          fs.unlinkSync(tempOutputPath);
        } catch (cleanupError) {
          // 忽略清理错误
        }
        
        // 释放原始 buffer 内存
        originalBuffer = null;
        convertedBuffer = null;
      } catch (sipsError) {
        if (isManualSyncCancelledError(sipsError)) {
          throw sipsError;
        }
        console.error(`   ❌ sips 转换失败: ${sipsError.message}`);
        // 清理临时文件（如果存在）
        try {
          if (tempInputPath && fs.existsSync(tempInputPath)) {
            fs.unlinkSync(tempInputPath);
          }
          if (tempOutputPath && fs.existsSync(tempOutputPath)) {
            fs.unlinkSync(tempOutputPath);
          }
        } catch (cleanupError) {
          // 忽略清理错误
        }
        
        // 跳过此文件，不发送到 Figma
        return;
      }
    } else if (isHeif) {
      return;
    } else {
      // 非 HEIF 格式，使用 sharp 正常处理
      const manualFastPassBytes = mediaTuning.thresholds.manualImageFastPassKb * 1024;
      const isManualSmallRaster =
        syncSource === 'manual' &&
        !isGif &&
        !isVideo &&
        !isHeif &&
        originalBuffer &&
        originalBuffer.length <= manualFastPassBytes &&
        (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png') || fileMimeLower === 'image/jpeg' || fileMimeLower === 'image/png');

      if (isManualSmallRaster) {
        // 小图手动同步极速直通：跳过 sharp 压缩，直接传给 Figma
        processedBuffer = originalBuffer;
        backupImageFilename = file.name;
        backupImageMimeType = file.mimeType || (fileName.endsWith('.png') ? 'image/png' : 'image/jpeg');
      } else {
        try {
          const sharpImage = sharp(originalBuffer);
          processedBuffer = await sharpImage
            .resize(CONFIG.maxWidth, null, {
              withoutEnlargement: true,
              fit: 'inside'
            })
            .jpeg({ quality: CONFIG.quality })
            .toBuffer();
          
          // 立即释放原始buffer内存
          originalBuffer = null;
        } catch (error) {
          processedBuffer = originalBuffer;
        }
      }
    }

    // 如果启用了截图备份，保存副本到本地（转换为JPEG格式）
    // 注意：变量 backupMode 在上面已经获取过，但为了安全起见重新获取（如果作用域不同）
    // 或者重用上面定义的 backupMode? 上面是在 if(isGif) 块里定义的。
    // 这里是 if (isHeif) ... else ... 块之后。
    // 所以这里需要重新获取。
    const backupModeForImage = userConfig.getBackupMode();
    if (backupModeForImage === 'all' && !isGif && !isVideo) {
      try {
        const outFilename = backupImageFilename || file.name.replace(/\.(png|heic|heif|webp)$/i, '.jpg');
        const outMime = backupImageMimeType || 'image/jpeg';
        const saveResult = await saveFileToLocalFolder(processedBuffer, outFilename, outMime);
        if (saveResult && saveResult.success) {
          backedUpLocally = true;
        } else if (saveResult && !saveResult.success) {
          localSaveFailureReason = classifyLargeFileFailure({ code: saveResult.errorCode, message: saveResult.error });
        }
      } catch (backupError) {
        console.error(`   ⚠️  [备份] 保存截图失败: ${backupError.message}`);
        localSaveFailureReason = classifyLargeFileFailure(backupError);
      }
    }

    emitProgress('importing', 90, looksLikeVideo ? { isVideo: true } : {});
    throwIfAborted();
    
    const gifDims = isGif ? parseGifDimensions(processedBuffer) : null;
    const useGifUrl = !!(isGif && gifCacheId && processedBuffer.length > LARGE_GIF_URL_THRESHOLD);
    const gifUrl = useGifUrl
      ? `http://localhost:8888/gif-temp/${encodeURIComponent(gifCacheId)}?filename=${encodeURIComponent(file.name)}`
      : null;
    const base64String = useGifUrl ? null : processedBuffer.toString('base64');
    processedBuffer = null;

    const payload = {
      type: 'screenshot',
      bytes: base64String,
      timestamp: Date.now(),
      filename: file.name,
      driveFileId: file.id,
      backedUpLocally: backedUpLocally || false,
      isGif: !!isGif,
      gifCacheId: gifCacheId || null,
      gifUrl,
      imageWidth: gifDims ? gifDims.width : null,
      imageHeight: gifDims ? gifDims.height : null,
      syncSource
    };

    throwIfAborted();
    if (deleteAfterSync && file && file.id) {
      pendingDeletes.set(file.id, {
        filename: file.name,
        timestamp: Date.now(),
        md5Checksum: file.md5Checksum || null
      });
    }
    ws.send(JSON.stringify(payload));
    emitProgress('done', 100, looksLikeVideo ? { isVideo: true } : {});
    // 非删除模式下仍执行延迟本地备份
    if (!deleteAfterSync && deferredLocalBackup) {
      setImmediate(() => { deferredLocalBackup(); });
    }

    if (deleteAfterSync) {
      if (deferredLocalBackup) {
        try {
          const deferredSaved = await deferredLocalBackup();
          if (deferredSaved) backedUpLocally = true;
        } catch (_) {}
        deferredLocalBackup = null;
      }
      try {
        await deleteDriveSourceFileWithFallback(file.id, file.name, file.md5Checksum);
        pendingDeletes.delete(file.id);
      } catch (delErr) {
        console.warn(`   ⚠️  云端源文件删除失败 (${file.name}): ${delErr.message || delErr}`);
      }
    }
  } catch (error) {
    if (isManualSyncCancelledError(error) || (error && error.code === 'CONVERSION_ABORTED')) {
      throw error;
    }
    console.error(`   ❌ 处理 Drive 文件失败 (${file.name}):`, error.message);
    throw error;
  } finally {
    processingFileIds.delete(file.id);
  }
}

async function countFilesForManualSync() {
  if (!CONFIG.userFolderId) {
    return;
  }
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('❌ [Drive] WebSocket 未连接，无法返回文件统计结果');
    return;
  }
  
  let _countTimeoutId;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      _countTimeoutId = setTimeout(() => reject(new Error('获取文件列表超时')), 40000);
    });
    
    const listPromise = listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 200, 
      orderBy: 'createdTime asc' 
    });
    
    const { files } = await Promise.race([listPromise, timeoutPromise]);
    clearTimeout(_countTimeoutId);
    
    const imageFiles = files.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      // Ignore _exported files
      if (name.toLowerCase().includes('_exported')) {
        return false;
      }
      
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-file-count',
        count: imageFiles.length
      });
    }
  } catch (error) {
    clearTimeout(_countTimeoutId);
    console.error('❌ [Drive] 统计文件失败:', error.message);
  }
}

async function performManualSync() {
  console.log('\n📦 [Drive] 执行手动同步...');
  
  if (isSyncing) {
    console.log('⏳ [Drive] 上一次同步尚未结束，正在强制终止...');
    manualSyncAbortRequested = true;
    killAllChildProcesses();
    const waitStart = Date.now();
    while (isSyncing && Date.now() - waitStart < 3000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (isSyncing) {
      console.warn('⚠️  [Drive] 旧同步未在 3 秒内结束，强制重置状态');
      isSyncing = false;
      manualSyncAbortRequested = false;
    }
  }
  
  isSyncing = true;
  pendingManualSync = false;
  manualSyncAbortRequested = false;
  _abortAllConversions = false;
  const currentRunId = ++manualSyncRunId;
  const shouldAbort = () => manualSyncAbortRequested || currentRunId !== manualSyncRunId;
  const throwIfManualSyncAborted = () => {
    if (shouldAbort()) throw createManualSyncCancelledError();
  };
  
  sendProgress('manual-sync-progress', {
    total: 0, completed: 0, percent: 0,
    fileIndex: 0, filename: '', filePercent: 0, stage: 'listing'
  });
  
  // 如果用户文件夹未初始化，尝试重新初始化（可能是第一次使用，用户刚上传文件）
  if (!CONFIG.userFolderId) {
    console.log('⚠️  [Drive] 用户文件夹未初始化，尝试重新初始化...');
    try {
      const userFolderId = await initializeUserFolder();
      if (userFolderId) {
      } else {
        throw new Error('重新初始化失败，返回的文件夹ID为空');
      }
    } catch (error) {
      console.error(`❌ [Drive] 重新初始化失败: ${error.message}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
        safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
          message: `用户文件夹未初始化。${error.message.includes('未找到') ? '请先在手机端上传至少一个文件。' : '请检查网络连接并重试。'}`
        });
    }
      isSyncing = false; // 重置标志
    return;
    }
  }
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('❌ [Drive] WebSocket 未连接，无法执行手动同步');
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
        message: 'WebSocket 未连接'
      });
    }
    isSyncing = false; // 重置标志
    return;
  }
  
  let _overallTimeoutId, _listTimeoutId;
  const overallTimeout = new Promise((_, reject) => {
    _overallTimeoutId = setTimeout(() => reject(new Error('手动同步总体超时（超过10分钟），请检查网络连接或减少待同步文件数量')), 600000);
  });
  
  const syncTask = (async () => {
    throwIfManualSyncAborted();
    const timeoutPromise = new Promise((_, reject) => {
      _listTimeoutId = setTimeout(() => reject(new Error('获取文件列表超时（超过30秒）')), 30000);
    });
    
    const listPromise = listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 500, 
      orderBy: 'createdTime desc',
      fields: 'files(id,name,mimeType,createdTime,modifiedTime,size,parents,md5Checksum),nextPageToken'
    });
    
    const { files } = await Promise.race([listPromise, timeoutPromise]);
    clearTimeout(_listTimeoutId);
    throwIfManualSyncAborted();

    // 手动同步：只做媒体过滤，不做 MD5 去重
    // 原因：用户期望“云端有多少文件就同步多少文件”，即使内容相同也要全部计入
    const refreshedFiles = [];
    
    for (const file of files) {
      throwIfManualSyncAborted();
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      if (name.toLowerCase().includes('_exported')) continue;
      
      const isMedia = mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
                      /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
      if (!isMedia) continue;
      
      refreshedFiles.push(file);
    }
    
    if (refreshedFiles.length === 0) {
      console.log(`   ℹ️  没有文件需要同步`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        safeSend({
          type: 'manual-sync-complete',
          count: 0,
          gifCount: 0,
          videoCount: 0
        });
      }
      return;
    }

    let success = 0;
    let imageCount = 0;
    let gifCount = 0;
    const processingErrors = [];
    let completedCount = 0;
    const totalFiles = refreshedFiles.length;
    
    // 分类统计
    const videoFileCount = refreshedFiles.filter(f => {
      const n = (f.name || '').toLowerCase();
      const m = (f.mimeType || '').toLowerCase();
      return n.endsWith('.mp4') || n.endsWith('.mov') || m.startsWith('video/');
    }).length;
    const imageFileCount = totalFiles - videoFileCount;
    
    // 发送初始信息（含总文件数，UI 显示 "共 N 个文件"）
    sendProgress('manual-sync-progress', {
      total: totalFiles, completed: 0, percent: 0,
      fileIndex: 0, filename: '', filePercent: 0, stage: 'counting'
    });
    
    const results = [];
    
    // 分类：图片/GIF 和 视频
    const imageBatch = [];
    const videoBatch = [];
    for (const file of refreshedFiles) {
      const fName = (file.name || '').toLowerCase();
      const fMime = (file.mimeType || '').toLowerCase();
      const isVideoItem = fName.endsWith('.mp4') || fName.endsWith('.mov') || fMime.startsWith('video/');
      (isVideoItem ? videoBatch : imageBatch).push(file);
    }
    
    // 统一的单文件处理函数（按固定序号发送进度，避免 X/Y 跳动）
    const processOneFile = async (file, myIndex) => {
      if (shouldAbort()) {
        return { success: false, cancelled: true, file };
      }
      // 跳过正在被实时同步处理的文件
      if (processingFileIds.has(file.id)) {
        console.log(`   ⏭️  [手动同步-去重] 跳过正在处理中的文件: ${file.name}`);
        return { success: false, skipped: true, duplicate: true, file };
      }
      
      const wasKnown = knownFileIds.has(file.id);
      if (!wasKnown) knownFileIds.add(file.id);
      
      const fName = file.name.toLowerCase();
      const fMime = (file.mimeType || '').toLowerCase();
      const isVideoItem = fName.endsWith('.mp4') || fName.endsWith('.mov') || fMime.startsWith('video/');
      const timeoutMs = isVideoItem ? 480000 : 60000;
      
      const fileProgressCb = (stage, percent) => {
        if (shouldAbort()) {
          throw createManualSyncCancelledError();
        }
        const filePct = Math.max(0, Math.min(100, Math.round(percent || 0)));
        // 总进度按文件序号线性推进：第1/4在0-25%，第2/4在25-50%
        const overallPct = totalFiles > 0
          ? Math.min(99, Math.max(0, Math.round((((myIndex - 1) + (filePct / 100)) / totalFiles) * 100)))
          : 0;
        sendProgress('manual-sync-progress', {
          total: totalFiles, completed: completedCount,
          percent: overallPct,
          fileIndex: myIndex, filename: file.name,
          filePercent: filePct, stage
        });
      };
      fileProgressCb('downloading', 0);
      
      let _manualFileTimeoutId;
      const fileTimeout = new Promise((_, reject) => {
        _manualFileTimeoutId = setTimeout(() => reject(new Error(`SYNC_TIMEOUT:${file.name}`)), timeoutMs);
      });
      
      const fileProcessing = (async () => {
        try {
          const fileName = file.name.toLowerCase();
          const mimeType = (file.mimeType || '').toLowerCase();
          const isGif = fileName.endsWith('.gif') || mimeType === 'image/gif';
          const isVideo = fileName.endsWith('.mp4') || fileName.endsWith('.mov') ||
                          mimeType.startsWith('video/') ||
                          mimeType === 'video/mp4' ||
                          mimeType === 'video/quicktime';
          
          if (isVideo) {
            await handleDriveFile(file, true, fileProgressCb, shouldAbort, 'manual');
            return { success: true, isGif: true, file };
          }
          
          await handleDriveFile(file, true, fileProgressCb, shouldAbort, 'manual');
          return { success: true, isGif: isGif, file };
        } catch (error) {
          if (isManualSyncCancelledError(error) || (error && error.code === 'CONVERSION_ABORTED') || shouldAbort()) {
            return { success: false, cancelled: true, file };
          }
          console.error(`   ❌ 处理文件失败: ${file.name}`, error.message);
          processingErrors.push({ filename: file.name, error: error.message, stack: error.stack });
          const reason = classifyLargeFileFailure(error);
          return {
            success: false,
            error,
            file,
            downloadFailed: reason.code !== 'unknown',
            failureReasonCode: reason.code,
            failureReasonDetail: reason.detail
          };
        }
      })();
      
      try {
        const result = await Promise.race([fileProcessing, fileTimeout]);
        clearTimeout(_manualFileTimeoutId);
        return result;
      } catch (timeoutError) {
        clearTimeout(_manualFileTimeoutId);
        if (isManualSyncCancelledError(timeoutError) || (timeoutError && timeoutError.code === 'CONVERSION_ABORTED') || shouldAbort()) {
          return { success: false, cancelled: true, file };
        }
        const isTimeout = timeoutError.message.startsWith('SYNC_TIMEOUT:') || timeoutError.message.includes('超时');
        processingErrors.push({ filename: file.name, error: timeoutError.message });
        if (isTimeout) {
          const fNameLower2 = (file.name || '').toLowerCase();
          const isVideoFile2 = fNameLower2.endsWith('.mp4') || fNameLower2.endsWith('.mov');
          if (!isVideoFile2) {
            console.warn(`   ⚠️  [大文件] 手动同步下载/处理超时，保留云端文件: ${file.name}`);
          } else {
            console.warn(`   ⚠️  [Video→GIF] 手动同步视频转换超时，已保留源文件: ${file.name}`);
          }
        }
        return {
          success: false,
          timeout: true,
          file,
          downloadFailed: isTimeout && !(file.name || '').toLowerCase().match(/\.(mp4|mov)$/),
          failureReasonCode: isTimeout ? 'network' : 'unknown',
          failureReasonDetail: isTimeout ? 'sync-timeout' : 'unknown'
        };
      }
    };
    
    let skippedDuplicates = 0;
    let cancelled = false;

    const manualImageConcurrency = Math.max(2, Math.min(8, Number(process.env.DRIVE_MANUAL_IMAGE_CONCURRENCY || 6)));
    const handleManualFileResult = (value, fileOrder, fileName) => {
      results.push({ status: 'fulfilled', value });

      if (value && value.duplicate) {
        skippedDuplicates++;
        completedCount++;
        const dupPct = totalFiles > 0 ? Math.round((fileOrder / totalFiles) * 100) : 100;
        sendProgress('manual-sync-progress', {
          total: totalFiles, completed: completedCount, percent: dupPct,
          fileIndex: fileOrder, filename: fileName, filePercent: 100, stage: 'file-done'
        });
        return;
      }

      const wasSuccess = value && value.success === true;
      if (value && value.isGif) {
        gifCount++;
        if (wasSuccess) success++;
      } else if (value && value.file) {
        if (wasSuccess) { imageCount++; success++; }
      }

      completedCount++;
      const pct = totalFiles > 0 ? Math.round((fileOrder / totalFiles) * 100) : 100;
      sendProgress('manual-sync-progress', {
        total: totalFiles, completed: completedCount, percent: pct,
        fileIndex: fileOrder, filename: '', filePercent: 100, stage: 'file-done'
      });
    };

    // 图片并发批处理（显著提升小图手动同步速度）
    for (let start = 0; start < imageBatch.length; start += manualImageConcurrency) {
      if (shouldAbort()) { cancelled = true; break; }
      const chunk = imageBatch.slice(start, start + manualImageConcurrency);
      const chunkResults = await Promise.all(
        chunk.map((file, idx) => processOneFile(file, start + idx + 1))
      );
      for (let idx = 0; idx < chunkResults.length; idx++) {
        const value = chunkResults[idx];
        const fileOrder = start + idx + 1;
        const fileName = chunk[idx] && chunk[idx].name ? chunk[idx].name : '';
        if (value && value.cancelled) { cancelled = true; break; }
        handleManualFileResult(value, fileOrder, fileName);
      }
      if (cancelled) break;
    }

    // 视频继续串行，避免转 GIF 抢占过多资源
    if (!cancelled) {
      for (let i = 0; i < videoBatch.length; i++) {
        if (shouldAbort()) { cancelled = true; break; }
        const file = videoBatch[i];
        const fileOrder = imageBatch.length + i + 1;
        const value = await processOneFile(file, fileOrder);
        if (value && value.cancelled) { cancelled = true; break; }
        handleManualFileResult(value, fileOrder, file.name);
      }
    }

    if (cancelled) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'manual-sync-cancelled',
          count: success,
          totalFiles,
          imageCount,
          gifCount,
          completed: completedCount
        }));
      }
      return;
    }

    // 收集超时导致下载失败的文件（云端保留）
    const downloadFailedFiles = results
      .filter(r => r.status === 'fulfilled' && r.value && r.value.downloadFailed)
      .map(r => ({
        filename: r.value.file.name,
        reasonCode: r.value.failureReasonCode || 'unknown',
        detail: r.value.failureReasonDetail || 'unknown'
      }));
    
    if (downloadFailedFiles.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      const reasonCount = downloadFailedFiles.reduce((acc, f) => {
        acc[f.reasonCode] = (acc[f.reasonCode] || 0) + 1;
        return acc;
      }, {});
      const primaryReason = Object.entries(reasonCount).sort((a, b) => b[1] - a[1])[0][0];
      ws.send(JSON.stringify({
        type: 'large-file-download-failed',
        reason: 'network-timeout',
        count: downloadFailedFiles.length,
        primaryReason,
        filenames: downloadFailedFiles.map(f => f.filename),
        failures: downloadFailedFiles
      }));
      console.log(`   📨 已通知插件：${downloadFailedFiles.length} 个超时文件下载失败（云端已保留）`);
    }

    console.log(`\n✅ [Drive] 手动同步完成: ${success}/${refreshedFiles.length} 成功 (图片:${imageCount}, GIF:${gifCount}${processingErrors.length > 0 ? `, 失败:${processingErrors.length}` : ''}${downloadFailedFiles.length > 0 ? `, 下载失败:${downloadFailedFiles.length}` : ''})`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      const backupModeForCount = userConfig.getBackupMode();
      const savedGifCount = (backupModeForCount !== 'none') ? gifCount : 0;
      
      const message = {
        type: 'manual-sync-complete',
        count: success,
        totalFiles: totalFiles,
        imageCount: imageCount,
        gifCount: gifCount,
        videoCount: 0,
        savedGifCount: savedGifCount,
        savedVideoCount: 0,
        errors: processingErrors
      };
      ws.send(JSON.stringify(message));
    }
  })(); // 结束 syncTask async 函数
  
  // 使用 Promise.race 应用总体超时
  try {
    await Promise.race([syncTask, overallTimeout]);
  } catch (error) {
    if (isManualSyncCancelledError(error) || (error && error.code === 'CONVERSION_ABORTED')) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        safeSend({
          type: 'manual-sync-cancelled',
          count: 0,
          totalFiles: 0,
          imageCount: 0,
          gifCount: 0,
          completed: 0
        });
      }
      return;
    }
    console.error('❌ 手动同步失败:', error.message);
    console.error('   错误代码:', error.code || 'N/A');
    console.error('   错误堆栈:', error.stack);
    
    // 提取更友好的错误信息
    let userMessage = error.message;
    if (error.message.includes('request to https://www.googleapis.com')) {
      userMessage = '无法连接到 Google Drive API，请检查网络连接。\n原始错误: ' + error.message;
    } else if (error.code === 'ENOTFOUND') {
      userMessage = 'DNS 解析失败，请检查网络连接或 DNS 设置。';
    } else if (error.code === 'ETIMEDOUT') {
      userMessage = '连接超时，请检查网络连接或稍后重试。';
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
        message: userMessage,
        errors: [{ filename: '系统错误', error: userMessage }]
      });
    }
  } finally {
    clearTimeout(_overallTimeoutId);
    clearTimeout(_listTimeoutId);
    manualSyncAbortRequested = false;
    isSyncing = false;
    if (pendingManualSync) {
      pendingManualSync = false;
      console.log('🔄 [Drive] 执行排队中的手动同步...');
      performManualSync();
    }
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // 注意：不立即执行轮询，因为启动实时模式时已经初始化了 knownFileIds
  // 立即执行可能会处理一些在初始化后、启动前新增的文件，但这是可以接受的
  // 如果用户希望完全只处理启动后的新文件，可以注释掉下面这行
  pollDrive();
  pollTimer = setInterval(pollDrive, CONFIG.pollIntervalMs);
  const intervalSeconds = (CONFIG.pollIntervalMs / 1000).toFixed(1);
  console.log(`🕒 [Drive] 开始轮询，每 ${intervalSeconds} 秒检查一次（已立即执行首次检查）`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🛑 [Drive] 停止轮询');
  }
}

function connectWebSocket() {
  console.log('🔌 [Drive] 正在连接服务器...');

  ws = new WebSocket(`${CONFIG.wsUrl}?id=${CONFIG.connectionId}&type=mac`);

  ws.on('open', () => {
    console.log('✅ [Drive] 已连接到服务器');
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'switch-sync-mode') {
        if (message.mode !== 'drive' && message.mode !== 'google') {
          console.log('🔄 [Drive] 切换到其他模式，退出当前 watcher...');
          killAllChildProcesses();
          stopPolling();
          if (ws) {
            ws.close();
          }
          setTimeout(() => {
            process.exit(0);
          }, 1000);
        }
        return;
      }


      if (message.type === 'screenshot-failed') {
        // 文件导入失败，如果标记了 keepFile，则保留源文件
        const filename = message.filename;
        const driveFileId = message.driveFileId || message.fileId;
        const keepFile = message.keepFile === true;
        
        if (keepFile) {
          // 从 pendingDeletes 中移除，不删除文件
          if (driveFileId && pendingDeletes.has(driveFileId)) {
            pendingDeletes.delete(driveFileId);
          } else {
            for (const [fileId, info] of pendingDeletes.entries()) {
              if (info.filename === filename) {
                pendingDeletes.delete(fileId);
                break;
              }
            }
          }
          console.log(`   ⚠️  文件导入失败，保留源文件: ${filename}`);
        }
        return;
      }

      if (message.type === 'screenshot-received') {
        const filename = message.filename;
        const driveFileId = message.driveFileId || message.fileId;
        
        // 检查文件是否已经被标记为保留（通过 screenshot-failed 消息）
        // 如果文件不在 pendingDeletes 中，说明已经被标记为保留，不应该删除
        let shouldDelete = false;
        let deleteInfo = null;
        let fileIdToDelete = null;
        
        if (driveFileId) {
          if (pendingDeletes.has(driveFileId)) {
            deleteInfo = pendingDeletes.get(driveFileId);
            fileIdToDelete = driveFileId;
            shouldDelete = true;
            pendingDeletes.delete(driveFileId);
          }
        }
        
        // 如果没找到，尝试用文件名查找（兼容旧版本）
        if (!deleteInfo) {
          for (const [fileId, info] of pendingDeletes.entries()) {
            if (info.filename === filename) {
              deleteInfo = info;
              fileIdToDelete = fileId;
              shouldDelete = true;
              pendingDeletes.delete(fileId);
              break;
            }
          }
        }
        
        if (shouldDelete && deleteInfo && fileIdToDelete) {
          try {
            await deleteDriveSourceFileWithFallback(fileIdToDelete, filename, deleteInfo.md5Checksum || null);
          } catch (error) {
            console.error(`   ⚠️  删除 Drive 文件失败 (${filename}):`, error.message || error);
          }
        }
        return;
      }

      if (message.type === 'start-realtime') {
        console.log('\n🎯 [Drive] 启动实时同步模式...');
        
          await initializeKnownFiles();
        
        isRealTimeMode = true;
        _abortAllConversions = false;
        wasRealTimeMode = true; // 记录状态
        startPolling();
        // 注意：startPolling() 会立即执行一次 pollDrive()，但此时 knownFileIds 已经初始化
        // 所以不会处理已有文件，只会处理新文件
        return;
      }

      if (message.type === 'stop-realtime') {
        console.log('\n⏸️  [Drive] 停止实时同步模式');
        isRealTimeMode = false;
        wasRealTimeMode = false;
        pendingManualSync = false;
        killAllChildProcesses();
        processingFileIds.clear();
        realtimeVideoQueue.length = 0;
        realtimeQueuedVideoFileIds.clear();
        isDriveRealtimeVideoQueueRunning = false;
        stopPolling();
        return;
      }

      if (message.type === 'manual-sync-count-files') {
        countFilesForManualSync().catch(err => {
          console.error('❌ [Drive] countFilesForManualSync 异常:', err.message);
        });
        return;
      }

      if (message.type === 'manual-sync') {
        await performManualSync();
        return;
      }

      if (message.type === 'cancel-manual-sync') {
        pendingManualSync = false;
        const accepted = requestManualSyncCancel();
        if (accepted) {
          console.log('🛑 [Drive] 收到取消手动同步请求，正在停止...');
          killAllChildProcesses();
        }
        return;
      }

      if (message.type === 'force-save-gif') {
        const cacheId = message.gifCacheId;
        const filename = message.filename || 'unknown.gif';
        console.log(`💾 [Drive] 收到强制保存 GIF 请求: ${filename} (cacheId: ${cacheId})`);
        try {
          const cached = userConfig.getGifFromCache(filename, cacheId);
          if (cached && cached.path && fs.existsSync(cached.path)) {
            const saveResult = await saveFileToLocalFolder(fs.readFileSync(cached.path), filename, 'image/gif');
            if (saveResult && saveResult.success) {
              if (saveResult.isNew) notifyLocalGifSaved(filename, 'realtime');
              console.log(`   ✅ 已保存到本地: ${saveResult.filename}`);
              safeSend({ type: 'force-save-gif-done', filename, success: true });
            } else {
              console.warn(`   ⚠️  保存到本地失败`);
              safeSend({ type: 'force-save-gif-done', filename, success: false });
            }
          } else {
            console.warn(`   ⚠️  缓存中找不到 GIF: ${filename}`);
            safeSend({ type: 'force-save-gif-done', filename, success: false });
          }
        } catch (err) {
          console.error(`   ❌ 强制保存 GIF 失败: ${err.message}`);
          safeSend({ type: 'force-save-gif-done', filename, success: false });
        }
        return;
      }
    } catch (error) {
      console.error('⚠️  解析消息失败:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('⚠️  [Drive] 服务器连接断开，5秒后重连');
    wasRealTimeMode = isRealTimeMode;
    isRealTimeMode = false;
    killAllChildProcesses();
    processingFileIds.clear();
    realtimeVideoQueue.length = 0;
    realtimeQueuedVideoFileIds.clear();
    isDriveRealtimeVideoQueueRunning = false;
    stopPolling();
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('❌ [Drive] WebSocket 错误:', error.message);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupStaleWatcherTempFiles() {
  let removed = 0;
  const now = Date.now();
  const tmpBase = os.tmpdir();
  const filePrefixes = ['heif-input-', 'jpeg-output-'];
  const dirPrefixes = ['screensync-v2g-'];
  try {
    const entries = fs.readdirSync(tmpBase);
    for (const entry of entries) {
      const fullPath = path.join(tmpBase, entry);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch (_) {
        continue;
      }
      if ((now - stat.mtimeMs) <= STALE_TEMP_MAX_AGE_MS) {
        continue;
      }
      if (stat.isDirectory() && dirPrefixes.some(prefix => entry.startsWith(prefix))) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        } catch (_) {}
        continue;
      }
      if (stat.isFile() && filePrefixes.some(prefix => entry.startsWith(prefix))) {
        try {
          fs.unlinkSync(fullPath);
          removed++;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return removed;
}

function pruneStaleCacheMappingEntries() {
  let removed = 0;
  try {
    const localFolder = getLocalDownloadFolder();
    const mappingFile = path.join(localFolder, '.cache-mapping.json');
    if (!fs.existsSync(mappingFile)) return removed;
    const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
    const cacheDirs = [
      path.join(localFolder, '.gif-cache'),
      path.join(localFolder, '.gif_cache')
    ];
    const existingIds = new Set();
    for (const cacheDir of cacheDirs) {
      if (!fs.existsSync(cacheDir)) continue;
      let files = [];
      try {
        files = fs.readdirSync(cacheDir);
      } catch (_) {
        continue;
      }
      for (const file of files) {
        const cacheId = path.parse(file).name;
        if (cacheId) existingIds.add(cacheId);
      }
    }
    let changed = false;
    for (const [fileName, cacheId] of Object.entries(mapping)) {
      if (!cacheId || !existingIds.has(cacheId)) {
        delete mapping[fileName];
        removed++;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
    }
  } catch (_) {}
  return removed;
}

/**
 * 清理过期的缓存数据，防止内存无限增长
 */
function cleanupCache() {
  // 清理 knownFileIds（如果超过限制，保留最新的）
  if (knownFileIds.size > MAX_KNOWN_FILES) {
    const toRemove = knownFileIds.size - MAX_KNOWN_FILES;
    const idsArray = Array.from(knownFileIds);
    // 移除最旧的一半（简单策略）
    for (let i = 0; i < Math.floor(toRemove / 2); i++) {
      knownFileIds.delete(idsArray[i]);
    }
    console.log(`🧹 [缓存清理] 已清理 ${Math.floor(toRemove / 2)} 个旧文件ID，当前: ${knownFileIds.size}`);
  }
  
  // 清理 knownFileMD5s（如果超过限制，保留最新的）
  if (knownFileMD5s.size > MAX_KNOWN_FILES) {
    const toRemove = knownFileMD5s.size - MAX_KNOWN_FILES;
    const md5Array = Array.from(knownFileMD5s.entries());
    // 按创建时间排序，移除最旧的
    md5Array.sort((a, b) => new Date(a[1].createdTime) - new Date(b[1].createdTime));
    for (let i = 0; i < Math.floor(toRemove / 2); i++) {
      knownFileMD5s.delete(md5Array[i][0]);
    }
    console.log(`🧹 [缓存清理] 已清理 ${Math.floor(toRemove / 2)} 个旧MD5记录，当前: ${knownFileMD5s.size}`);
  }
  
  // 清理过期的 pendingDeletes（超过5分钟未确认的）
  const now = Date.now();
  const expiredTimeout = 5 * 60 * 1000; // 5分钟
  let cleanedDeletes = 0;
  for (const [fileId, info] of pendingDeletes.entries()) {
    if (now - info.timestamp > expiredTimeout) {
      pendingDeletes.delete(fileId);
      cleanedDeletes++;
    }
  }
  if (cleanedDeletes > 0) {
    console.log(`🧹 [缓存清理] 已清理 ${cleanedDeletes} 个过期的待删除记录`);
  }

  // 每 6 小时执行一次深度清理，避免本地长期运行后产生历史垃圾
  if ((now - lastDeepCleanupAt) >= DEEP_CLEANUP_INTERVAL_MS) {
    lastDeepCleanupAt = now;
    const removedTemps = cleanupStaleWatcherTempFiles();
    const removedMappings = pruneStaleCacheMappingEntries();
    let cleanedGifCacheCount = 0;
    try {
      const cleaned = userConfig.cleanOldGifCache(30);
      cleanedGifCacheCount = cleaned && cleaned.cleaned ? cleaned.cleaned : 0;
    } catch (_) {}
    if (removedTemps > 0 || removedMappings > 0 || cleanedGifCacheCount > 0) {
      console.log(`🧹 [深度清理] 临时文件:${removedTemps} 映射:${removedMappings} GIF缓存:${cleanedGifCacheCount}`);
    }
  }
  
  // 输出内存使用情况
  if (global.gc) {
    global.gc();
    const used = process.memoryUsage();
  }
}

async function start() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  Google Drive 截图同步 - Mac 监听器   ║');
  console.log('╚════════════════════════════════════════╝\n');

  // 清理旧的 GIF 缓存（30天前的文件）
  try {
    const stats = userConfig.getGifCacheStats();
    if (stats.count > 0) {
    }
    
    const cleaned = userConfig.cleanOldGifCache(30);
    if (cleaned.cleaned > 0) {
      console.log(`🧹 [GIF Cache] 已清理 ${cleaned.cleaned} 个超过 30 天的缓存文件\n`);
    }
  } catch (cacheError) {
    console.warn(`⚠️  [GIF Cache] 清理失败:`, cacheError.message);
  }

  // 初始化用户文件夹
  try {
    const userFolderId = await initializeUserFolder();
    if (!userFolderId) {
      throw new Error('用户文件夹ID为空');
    }
    // initializeUserFolder 内部已经输出了详细信息，这里只做确认
    if (!CONFIG.userFolderId) {
      throw new Error('用户文件夹ID未设置');
    }
    console.log(`\n✅ [Drive] 确认：将监听用户专属文件夹`);
    const localFolderPath = getLocalDownloadFolder();
    console.log(`📂 [本地文件夹] 无法自动导入的文件将保存到: ${localFolderPath}`);
  } catch (error) {
    console.warn(`\n⚠️  初始化用户文件夹失败: ${error.message}`);
    console.warn('   如果是第一次使用，请先在手机端上传文件，否则请检查 GDRIVE_FOLDER_ID 和 Service Account 配置');
    console.warn('   服务将继续运行，手动同步时会重新初始化\n');
    // 不退出进程，继续运行，等待用户上传文件后在 performManualSync 中重新初始化
  }

  // 验证用户文件夹ID已设置（如果初始化失败则跳过）
  if (!CONFIG.userFolderId) {
    console.warn('⚠️  用户文件夹ID未设置，将在手动同步时重新初始化\n');
  }

  // 不再在启动时初始化已知文件列表
  // 改为在实时模式首次启动时初始化，这样手动模式可以同步所有历史文件
  // await initializeKnownFiles();
  connectWebSocket();

  // 启动定期缓存清理
  const _cacheCleanupTimer = setInterval(cleanupCache, CLEANUP_INTERVAL_MS);
  console.log(`🧹 [缓存管理] 已启动定期清理，每 ${CLEANUP_INTERVAL_MS / 1000 / 60} 分钟执行一次`);

  process.on('SIGINT', () => {
    console.log('\n👋 [Drive] 停止服务');
    killAllChildProcesses();
    clearInterval(_cacheCleanupTimer);
    stopPolling();
    if (ws) ws.close();
    process.exit(0);
  });
}

start();

