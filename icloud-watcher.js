// icloud-watcher.js - iCloud 模式监听器（带文件分类功能）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const { exec } = require('child_process');
const { promisify } = require('util');
const _execAsync = promisify(exec);
const os = require('os');
const { detectImageFormat, normalizeStillImageToJpeg } = require('./image-processor');

// 追踪所有活跃子进程，插件关闭时统一 kill
const activeChildProcesses = new Set();

let _abortAllConversions = false; // set true to reject any new execAsync immediately
const WATCHER_LOCK_DIR = path.join(os.tmpdir(), 'screensync-locks');
const WATCHER_LOCK_FILE = path.join(
  WATCHER_LOCK_DIR,
  `icloud-watcher-${crypto.createHash('md5').update(__dirname).digest('hex')}.lock`
);
let watcherLockAcquired = false;

function getProcessCommand(pid) {
  try {
    return require('child_process').execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 3000 }).trim();
  } catch (_) {
    return '';
  }
}

function getProcessCwd(pid) {
  try {
    const output = require('child_process').execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: 'utf8', timeout: 3000 });
    const line = output.split('\n').find(entry => entry.startsWith('n'));
    return line ? line.slice(1).trim() : '';
  } catch (_) {
    return '';
  }
}

function isRepoScriptProcess(pid, scriptName, command) {
  const cmd = command || getProcessCommand(pid);
  if (!cmd) return false;
  if (cmd.includes(path.join(__dirname, scriptName))) return true;
  if (!new RegExp(`(^|\\s|/)${scriptName}(\\s|$)`).test(cmd)) return false;
  return getProcessCwd(pid) === __dirname;
}

function isMatchingProcessAlive(pid, scriptName) {
  if (!pid || !Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }
  return isRepoScriptProcess(pid, scriptName);
}

function releaseWatcherLock() {
  if (!watcherLockAcquired) return;
  try {
    const raw = fs.readFileSync(WATCHER_LOCK_FILE, 'utf8');
    const lockInfo = JSON.parse(raw);
    if (lockInfo && lockInfo.pid === process.pid) {
      fs.rmSync(WATCHER_LOCK_FILE, { force: true });
    }
  } catch (_) {}
  watcherLockAcquired = false;
}

function acquireWatcherLockOrExit() {
  try {
    fs.mkdirSync(WATCHER_LOCK_DIR, { recursive: true });
  } catch (_) {}

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(WATCHER_LOCK_FILE, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        script: path.join(__dirname, 'icloud-watcher.js'),
        createdAt: Date.now()
      }));
      fs.closeSync(fd);
      watcherLockAcquired = true;
      process.on('exit', releaseWatcherLock);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') break;
      try {
        const raw = fs.readFileSync(WATCHER_LOCK_FILE, 'utf8');
        const lockInfo = JSON.parse(raw);
        if (isMatchingProcessAlive(Number(lockInfo && lockInfo.pid), 'icloud-watcher.js')) {
          console.log(`🛑 检测到同目录已有 iCloud watcher 在运行 (PID: ${lockInfo.pid})，当前实例退出`);
          process.exit(0);
        }
      } catch (_) {}
      try { fs.rmSync(WATCHER_LOCK_FILE, { force: true }); } catch (_) {}
    }
  }
  return true;
}

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

// 引入用户配置
const userConfig = require('./userConfig');
const mediaTuning = require('./media-processing-tuning');
const {
  getSystemPressure,
  getDynamicUltraTriggerMb,
  buildWatcherAttemptProfiles
} = require('./adaptive-processing');

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
const LARGE_GIF_URL_THRESHOLD = mediaTuning.thresholds.largeGifUrlMb * 1024 * 1024;
const ULTRA_SPEED_VIDEO_THRESHOLD_BYTES = mediaTuning.thresholds.ultraSpeedVideoMb * 1024 * 1024;

let ws = null;
let reconnectTimer = null;
let syncCount = 0;
let isRealTimeMode = false;
let watcher = null;
let isSyncing = false;
let manualSyncAbortRequested = false;
let manualSyncRunId = 0;
let pendingManualSync = false;
const MANUAL_SYNC_CANCELLED_CODE = 'MANUAL_SYNC_CANCELLED';

// 待删除文件队列：{filename: { filePath, subfolder }}
const pendingDeletes = new Map();
const processingFilePaths = new Set(); // 正在处理中的文件路径 — 全局互斥锁，防止同一文件被实时同步和手动同步同时处理
const realtimeImageQueue = [];
const realtimeVideoQueue = [];
const realtimeQueuedFilePaths = new Set();
const realtimeRetryTimers = new Set();
const realtimeInflightAcks = new Map(); // Map<taskId, { task, filePath, subfolder, filename, timer }>
let isRealtimeImageQueueRunning = false;
let isRealtimeVideoQueueRunning = false;
const REALTIME_IMAGE_MAX_RETRIES = 8;
const REALTIME_IMAGE_WORKERS = Math.max(2, Math.min(8, Number(process.env.ICLOUD_REALTIME_IMAGE_CONCURRENCY || 4)));
const MANUAL_IMAGE_CONCURRENCY = Math.max(2, Math.min(8, Number(process.env.ICLOUD_MANUAL_IMAGE_CONCURRENCY || 6)));
const REALTIME_VIDEO_MAX_RETRIES = 3;
const REALTIME_RETRY_BASE_DELAY_MS = 800;
const REALTIME_ACK_TIMEOUT_MS = 15000;
const ENABLE_REALTIME_RECONCILE = false; // ACK 状态机开启后，默认关闭兜底对账
const REALTIME_RECONCILE_DELAY_MS = 1500;
const REALTIME_RECONCILE_WINDOW_BACK_MS = 15000;
let realtimeReconcileTimer = null;
let realtimeSessionStartedAt = 0;

// 已处理文件缓存：防止重复同步
const processedFilesCache = new Map();
const CACHE_EXPIRY_MS = 30000; // 30秒后过期

// 定期清理过期的缓存
const cacheCleanupInterval = setInterval(() => {
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

function cleanupOriginalVideo(videoPath, gifPath, displayFilename) {
  try {
    if (videoPath && fs.existsSync(videoPath) && videoPath !== gifPath) {
      fs.unlinkSync(videoPath);
      console.log(`   🗑️  已删除原始视频: ${displayFilename}`);
    }
  } catch (delErr) {
    console.warn(`   ⚠️  删除原始视频失败: ${delErr.message}`);
  }
}

function runPostVideoOps(result, keepGif, displayFilename, syncSource = 'realtime') {
  try {
    if (keepGif) {
      try {
        const wasExisting = fs.existsSync(result.gifPath);
        fs.writeFileSync(result.gifPath, result.gifBuffer);
        if (!wasExisting) notifyLocalGifSaved(result.gifFilename, syncSource);
      } catch (_) {}
      console.log(`   📌 根据备份设置，保留 GIF: ${result.gifFilename}`);
    }
    cleanupOriginalVideo(result.sourceVideoPath, result.gifPath, displayFilename);
  } catch (_) {}
}

function schedulePostVideoOps(result, keepGif, displayFilename, syncSource = 'realtime') {
  setImmediate(() => runPostVideoOps(result, keepGif, displayFilename, syncSource));
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

function notifyLocalGifSaved(filename, syncSource = 'realtime') {
  safeSend({
    type: 'local-gif-saved',
    filename,
    syncSource,
    timestamp: Date.now()
  });
}

function clearRealtimeRetryTimers() {
  for (const t of realtimeRetryTimers) {
    try { clearTimeout(t); } catch (_) {}
  }
  realtimeRetryTimers.clear();
}

function buildRealtimeTaskId(filePath) {
  const now = Date.now();
  const safeBase = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  try {
    const st = fs.statSync(filePath);
    return `rt_${now}_${safeBase}_${st.size}_${Math.floor(st.mtimeMs)}`;
  } catch (_) {
    return `rt_${now}_${safeBase}`;
  }
}

function clearRealtimeInflightAcks() {
  for (const entry of realtimeInflightAcks.values()) {
    if (entry && entry.timer) {
      try { clearTimeout(entry.timer); } catch (_) {}
    }
  }
  realtimeInflightAcks.clear();
}

function registerRealtimeInflightAck(task, filePath, subfolder, filename) {
  if (!task || !task.taskId) return;
  const existing = realtimeInflightAcks.get(task.taskId);
  if (existing && existing.timer) {
    try { clearTimeout(existing.timer); } catch (_) {}
  }
  const timer = setTimeout(() => {
    const current = realtimeInflightAcks.get(task.taskId);
    if (!current) return;
    realtimeInflightAcks.delete(task.taskId);
    console.warn(`⏱️  [实时模式] ACK 超时，重试: ${filename}`);
    scheduleRealtimeRetry(task, 'ACK_TIMEOUT');
  }, REALTIME_ACK_TIMEOUT_MS);
  realtimeInflightAcks.set(task.taskId, { task, filePath, subfolder, filename, timer });
}

function consumeRealtimeInflightAck(taskId) {
  if (!taskId) return null;
  const entry = realtimeInflightAcks.get(taskId);
  if (!entry) return null;
  if (entry.timer) {
    try { clearTimeout(entry.timer); } catch (_) {}
  }
  realtimeInflightAcks.delete(taskId);
  return entry;
}

function clearRealtimeReconcileTimer() {
  if (!realtimeReconcileTimer) return;
  try { clearTimeout(realtimeReconcileTimer); } catch (_) {}
  realtimeReconcileTimer = null;
}

function listRealtimeReconcileCandidates() {
  const candidates = [];
  const minMtimeMs = realtimeSessionStartedAt > 0
    ? (realtimeSessionStartedAt - REALTIME_RECONCILE_WINDOW_BACK_MS)
    : (Date.now() - REALTIME_RECONCILE_WINDOW_BACK_MS);
  const targetSubfolders = [CONFIG.subfolders.image, CONFIG.subfolders.gif];

  for (const subfolder of targetSubfolders) {
    const subfolderPath = path.join(CONFIG.icloudPath, subfolder);
    if (!fs.existsSync(subfolderPath)) continue;
    let files = [];
    try {
      files = fs.readdirSync(subfolderPath);
    } catch (_) {
      continue;
    }

    for (const file of files) {
      const finalPath = path.join(subfolderPath, file);
      const ext = path.extname(file).toLowerCase();
      if (!CONFIG.supportedFormats.includes(ext)) continue;
      if (ext === '.mp4' || ext === '.mov') continue;
      if (file.toLowerCase().includes('.tmp')) continue;

      let stats = null;
      try {
        stats = fs.statSync(finalPath);
      } catch (_) {
        continue;
      }
      if (!stats || stats.isDirectory()) continue;
      if (stats.mtimeMs < minMtimeMs) continue;
      if (stats.size <= 0) continue;
      if (ext === '.gif' && stats.size < 500) continue;

      candidates.push({
        finalPath,
        displayFilename: file,
        subfolder,
        isVideo: false,
        attempt: 0
      });
    }
  }

  return candidates;
}

function scheduleRealtimeReconcile(reason = 'idle') {
  if (!ENABLE_REALTIME_RECONCILE) return;
  if (!isRealTimeMode) return;
  if (realtimeReconcileTimer) return;
  realtimeReconcileTimer = setTimeout(() => {
    realtimeReconcileTimer = null;
    performRealtimeReconcile(reason).catch(() => {});
  }, REALTIME_RECONCILE_DELAY_MS);
}

async function performRealtimeReconcile(reason = 'idle') {
  if (!ENABLE_REALTIME_RECONCILE) return;
  if (!isRealTimeMode) return;
  if (isRealtimeImageQueueRunning || isRealtimeVideoQueueRunning) return;
  if (realtimeImageQueue.length > 0 || realtimeVideoQueue.length > 0) return;

  const candidates = listRealtimeReconcileCandidates();
  let recovered = 0;
  for (const task of candidates) {
    if (!task || !task.finalPath) continue;
    if (processingFilePaths.has(task.finalPath)) continue;
    if (realtimeQueuedFilePaths.has(task.finalPath)) continue;
    if (isFileProcessed(task.finalPath)) continue;
    enqueueRealtimeSyncTask(task);
    recovered++;
  }

  if (recovered > 0) {
    console.log(`🔁 [实时对账] 补入队 ${recovered} 张图片 (${reason})`);
  }
}

function scheduleRealtimeRetry(task, reason = 'retry') {
  if (!task || !task.finalPath) return;
  const nextAttempt = Number(task.attempt || 0) + 1;
  const maxRetries = task.isVideo ? REALTIME_VIDEO_MAX_RETRIES : REALTIME_IMAGE_MAX_RETRIES;
  if (nextAttempt > maxRetries) {
    console.warn(`⚠️  [实时模式] 重试上限，放弃: ${task.displayFilename} (${reason})`);
    return;
  }

  const delay = REALTIME_RETRY_BASE_DELAY_MS * Math.min(nextAttempt, 5);
  const retryTask = { ...task, attempt: nextAttempt };
  const timer = setTimeout(() => {
    realtimeRetryTimers.delete(timer);
    if (realtimeQueuedFilePaths.has(retryTask.finalPath)) return;
    realtimeQueuedFilePaths.add(retryTask.finalPath);
    if (retryTask.isVideo) {
      realtimeVideoQueue.push(retryTask);
      drainRealtimeVideoQueue().catch(() => {});
    } else {
      realtimeImageQueue.unshift(retryTask); // 图片重试继续优先
      drainRealtimeImageQueue().catch(() => {});
    }
  }, delay);
  realtimeRetryTimers.add(timer);
}

async function processRealtimeSyncTask(task) {
  const { finalPath, displayFilename, subfolder, isVideo } = task;

  // 互斥锁：防止同一文件被实时同步和手动同步同时处理
  if (processingFilePaths.has(finalPath)) {
    throw new Error(`BUSY_RETRY:${displayFilename}`);
  }
  processingFilePaths.add(finalPath);

  try {
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

        const gifSubfolder = subfolder || CONFIG.subfolders.gif;
        const keepGif = !shouldCleanupFile(gifSubfolder);

        emitProgress('importing', 90, { isVideo: true });

        const gifDims = parseGifDimensions(result.gifBuffer);
        const useGifUrl = !!(result.gifCacheId && result.gifBuffer.length > LARGE_GIF_URL_THRESHOLD);
        const gifUrl = useGifUrl
          ? `http://localhost:8888/gif-temp/${encodeURIComponent(result.gifCacheId)}?filename=${encodeURIComponent(result.gifFilename)}`
          : null;
        const base64String = useGifUrl ? null : result.gifBuffer.toString('base64');
        safeSend({
          type: 'screenshot',
          bytes: base64String,
          gifUrl,
          timestamp: Date.now(),
          filename: result.gifFilename,
          isGif: true,
          gifCacheId: result.gifCacheId || null,
          imageWidth: gifDims ? gifDims.width : null,
          imageHeight: gifDims ? gifDims.height : null,
          keptInIcloud: keepGif,
          syncSource: 'realtime'
        });

        syncCount++;
        markFileAsProcessed(finalPath);
        emitProgress('done', 100, { isVideo: true });
        schedulePostVideoOps(result, keepGif, displayFilename, 'realtime');
        console.log(`   ✅ 视频转 GIF 完成并已同步到 Figma`);
      } catch (convErr) {
        console.error(`   ❌ [Video→GIF] 转换失败: ${convErr.message}`);
        try {
          const fileBuffer = fs.readFileSync(finalPath);
          const cacheResult = userConfig.saveGifToCache(fileBuffer, displayFilename, null);
          if (cacheResult && cacheResult.cacheId) {
            console.log(`   💾 [GIF Cache] 视频已缓存 (ID: ${cacheResult.cacheId})`);
          }
        } catch (_) {}
        safeSend({ type: 'file-skipped', filename: displayFilename, reason: 'video' });
      }
      return true;
    }

    try {
      execAsync(`brctl download "${finalPath}"`, { timeout: 10000 }).catch(() => {});
    } catch (e) {}

    const synced = await syncScreenshot(finalPath, true, subfolder, 'realtime', task);
    if (!synced) {
      throw new Error(`SYNC_NOT_CONFIRMED:${displayFilename}`);
    }
    return true;
  } finally {
    processingFilePaths.delete(finalPath);
  }
}

function enqueueRealtimeSyncTask(task) {
  if (!task || !task.finalPath) return;
  const normalizedTask = {
    ...task,
    attempt: Number(task.attempt || 0),
    taskId: task.taskId || buildRealtimeTaskId(task.finalPath)
  };
  if (realtimeQueuedFilePaths.has(task.finalPath)) {
    return;
  }
  realtimeQueuedFilePaths.add(normalizedTask.finalPath);
  if (normalizedTask.isVideo) {
    realtimeVideoQueue.push(normalizedTask);
    drainRealtimeVideoQueue().catch(() => {});
  } else {
    realtimeImageQueue.push(normalizedTask);
    drainRealtimeImageQueue().catch(() => {});
  }
}

function maybeScheduleRealtimeReconcileWhenIdle(reason = 'queue-drained') {
  if (isRealtimeImageQueueRunning || isRealtimeVideoQueueRunning) return;
  if (realtimeImageQueue.length > 0 || realtimeVideoQueue.length > 0) return;
  scheduleRealtimeReconcile(reason);
}

async function drainRealtimeImageQueue() {
  if (isRealtimeImageQueueRunning) return;
  isRealtimeImageQueueRunning = true;
  try {
    const worker = async () => {
      while (realtimeImageQueue.length > 0) {
        const task = realtimeImageQueue.shift();
        if (!task) continue;
        realtimeQueuedFilePaths.delete(task.finalPath);
        try {
          await processRealtimeSyncTask(task);
        } catch (err) {
          const msg = String(err && err.message ? err.message : err || '');
          console.warn(`⚠️  [实时模式] 同步失败，准备重试: ${task.displayFilename} (${msg})`);
          scheduleRealtimeRetry(task, msg);
        }
      }
    };

    const workers = [];
    for (let i = 0; i < REALTIME_IMAGE_WORKERS; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  } finally {
    isRealtimeImageQueueRunning = false;
    if (realtimeImageQueue.length > 0) {
      drainRealtimeImageQueue().catch(() => {});
    } else {
      maybeScheduleRealtimeReconcileWhenIdle('image-queue-drained');
    }
  }
}

async function drainRealtimeVideoQueue() {
  if (isRealtimeVideoQueueRunning) return;
  isRealtimeVideoQueueRunning = true;
  try {
    while (realtimeVideoQueue.length > 0) {
      const task = realtimeVideoQueue.shift();
      if (!task) continue;
      realtimeQueuedFilePaths.delete(task.finalPath);
      try {
        await processRealtimeSyncTask(task);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err || '');
        console.warn(`⚠️  [实时模式] 同步失败，准备重试: ${task.displayFilename} (${msg})`);
        scheduleRealtimeRetry(task, msg);
      }
      // 让出事件循环，避免视频连续处理影响图片队列时效
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    isRealtimeVideoQueueRunning = false;
    if (realtimeVideoQueue.length > 0) {
      drainRealtimeVideoQueue().catch(() => {});
    } else {
      maybeScheduleRealtimeReconcileWhenIdle('video-queue-drained');
    }
  }
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
 * 快速探测视频元数据（fps/宽高/时长），用于跳过不必要的滤镜。
 * 失败时返回 null，调用方退化为保守处理。
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

/**
 * 将视频转换为 GIF
 * 小文件 (<30MB)：高质量两遍调色板
 * 大/超大文件 (>=30MB)：优化两遍（消除 split 帧缓冲瓶颈，内存 O(1)）
 *
 * 无损提速策略：
 *  1) 大/超大文件从 split 单遍改为两遍：消除 palettegen 导致的全帧内存缓冲
 *  2) -an：跳过音频解码，节省 CPU
 *  3) -nostdin -v warning：减少 I/O 开销
 *  4) ffprobe 预探测：源 fps <= 目标 fps 时跳过 fps 滤镜
 *  5) reserve_transparent=0：跳过透明色保留
 */
async function convertVideoToGif(videoPath, displayFilename, progressCb) {
  const stats = fs.statSync(videoPath);
  const videoSizeBytes = stats.size;
  const videoSizeMBNum = videoSizeBytes / 1024 / 1024;
  const videoSizeMB = videoSizeMBNum.toFixed(1);
  const convStartTime = Date.now();
  const isLargeFile = videoSizeBytes >= mediaTuning.thresholds.largeVideoMb * 1024 * 1024;
  const pressure = getSystemPressure(mediaTuning);
  const dynamicUltraTriggerMb = getDynamicUltraTriggerMb(mediaTuning, {
    sizeMB: videoSizeMBNum,
    pressure
  });
  const adaptivePlan = buildWatcherAttemptProfiles(mediaTuning, {
    videoSizeMB: videoSizeMBNum,
    isLargeFile,
    pressure
  });
  const isUltraLargeFile = videoSizeBytes >= ULTRA_SPEED_VIDEO_THRESHOLD_BYTES || videoSizeMBNum >= dynamicUltraTriggerMb;
  console.log(`   🎬 [Video→GIF] 开始转换 ${displayFilename} (${videoSizeMB}MB) [${isUltraLargeFile ? '自适应极速' : (isLargeFile ? '大文件两遍' : '小文件两遍')}] (${pressure.label}, trigger=${dynamicUltraTriggerMb.toFixed(1)}MB)...`);

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
  if (progressCb) progressCb('converting', 25, { estimatedSec, isVideo: true });

  const tempDir = path.join(os.tmpdir(), `screensync-v2g-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const tempPalette = path.join(tempDir, 'palette.png');
  const tempGifOut = path.join(tempDir, 'output.gif');
  const tempCompressedVideo = path.join(tempDir, 'compressed.mp4');
  const tempHalfVideo = path.join(tempDir, 'half-scale.mp4');

  const isAborted = () => _abortAllConversions;
  const throwIfAborted = () => { if (isAborted()) throw Object.assign(new Error('Conversion aborted'), { code: 'CONVERSION_ABORTED' }); };

  const FF_OPT = '-nostdin -v warning';
  let conversionSourceVideo = videoPath;
  if (progressCb) progressCb('converting', 18, { estimatedSec, isVideo: true, stageDetail: 'downscale-half-before-gif' });
  const halfScaleCmd = `ffmpeg -hwaccel auto ${FF_OPT} -threads 0 -i "${videoPath}" -vf "setpts=PTS,scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=lanczos" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -an -movflags +faststart -y "${tempHalfVideo}"`;
  try {
    await execAsync(halfScaleCmd, { timeout: 240000, maxBuffer: 120 * 1024 * 1024 });
    if (fs.existsSync(tempHalfVideo) && fs.statSync(tempHalfVideo).size > 0) {
      conversionSourceVideo = tempHalfVideo;
    }
  } catch (scaleErr) {
    console.warn(`   ⚠️  预缩放失败，回退原视频继续转换: ${scaleErr.message}`);
  }

  const meta = await ffprobeVideoMeta(conversionSourceVideo);
  const sourceFps = meta?.fps || 999;

  const buildFilterChain = (targetFps, scaleDivisor = 1) => {
    const parts = ['setpts=PTS'];
    if (sourceFps > targetFps + 0.5) parts.push(`fps=${targetFps}`);
    if (scaleDivisor > 1) {
      parts.push(`scale='max(2,trunc(iw/${scaleDivisor}/2)*2)':'max(2,trunc(ih/${scaleDivisor}/2)*2)':flags=lanczos`);
    }
    return parts.join(',');
  };

  try {
    // 大/超大文件专用两遍法：消除 split 帧缓冲，内存从 O(n_frames) 降至 O(1)
    const runLargeTwoPass = async (sourceVideoPath, profile) => {
      const filterBase = buildFilterChain(profile.fps, profile.scaleDivisor);
      const totalTimeout = profile.timeoutMs;
      const pass1Timeout = Math.ceil(totalTimeout * 0.45);
      const pass2Timeout = Math.ceil(totalTimeout * 0.7);
      const pass1Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -vf "${filterBase},palettegen=max_colors=${profile.maxColors}:stats_mode=diff:reserve_transparent=0" -y "${tempPalette}"`;
      await execAsync(pass1Cmd, { timeout: pass1Timeout, maxBuffer: 50 * 1024 * 1024 });
      throwIfAborted();
      if (progressCb) progressCb('converting', 50, { estimatedSec, isVideo: true });
      const pass2Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -i "${tempPalette}" -lavfi "${filterBase}[v];[v][1:v]paletteuse=dither=${profile.dither}:diff_mode=rectangle" -loop 0 -y "${tempGifOut}"`;
      await execAsync(pass2Cmd, { timeout: pass2Timeout, maxBuffer: 200 * 1024 * 1024 });
    };

    const runSmallTwoPass = async (sourceVideoPath, profile) => {
      const filterBase = buildFilterChain(profile.fps, profile.scaleDivisor);
      const pass1Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -vf "${filterBase},palettegen=max_colors=${profile.maxColors}:stats_mode=full:reserve_transparent=0" -y "${tempPalette}"`;
      await execAsync(pass1Cmd, { timeout: profile.pass1TimeoutMs, maxBuffer: 50 * 1024 * 1024 });
      throwIfAborted();
      if (progressCb) progressCb('converting', 55, { estimatedSec, isVideo: true });
      const pass2Cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -i "${tempPalette}" -lavfi "${filterBase}[v];[v][1:v]paletteuse=dither=${profile.dither}:diff_mode=rectangle" -loop 0 -y "${tempGifOut}"`;
      await execAsync(pass2Cmd, { timeout: profile.pass2TimeoutMs, maxBuffer: 200 * 1024 * 1024 });
    };

    // 回退用单遍（已压缩过的小源文件，split 缓冲压力可接受）
    const runFallbackSinglePass = async (sourceVideoPath, profile) => {
      const baseFilter = buildFilterChain(profile.fps, profile.scaleDivisor);
      const cmd = `ffmpeg -hwaccel auto -an ${FF_OPT} -threads 0 -i "${sourceVideoPath}" -lavfi "${baseFilter},split[s0][s1];[s0]palettegen=max_colors=${profile.maxColors}:stats_mode=diff:reserve_transparent=0[p];[s1][p]paletteuse=dither=${profile.dither}:diff_mode=rectangle" -loop 0 -y "${tempGifOut}"`;
      await execAsync(cmd, { timeout: profile.timeoutMs, maxBuffer: 200 * 1024 * 1024 });
    };

    const isTimeoutLike = (err) => {
      if (!err) return false;
      const msg = String(err.message || '');
      return Boolean(err.killed || err.signal === 'SIGTERM' || msg.includes('timed out') || msg.includes('ETIMEDOUT'));
    };

    let converted = false;
    let primaryError = null;
    // ── 主策略 ──
    try {
      let lastAdaptiveProfile = adaptivePlan.profiles[Math.max(0, adaptivePlan.profiles.length - 1)];
      for (let attemptIndex = 0; attemptIndex < adaptivePlan.profiles.length; attemptIndex++) {
        const profile = adaptivePlan.profiles[attemptIndex];
        lastAdaptiveProfile = profile;
        if (progressCb) {
          progressCb('converting', 30, {
            estimatedSec,
            isVideo: true,
            stageDetail: `adaptive-profile:${profile.label}`
          });
        }
        console.log(`   ⚙️  [Video→GIF] 尝试档位 ${attemptIndex + 1}/${adaptivePlan.profiles.length}: ${profile.label} fps=${profile.fps} scale=${profile.scaleDivisor} colors=${profile.maxColors}`);
        if (profile.strategy === 'smallTwoPass') {
          await runSmallTwoPass(conversionSourceVideo, profile);
        } else {
          await runLargeTwoPass(conversionSourceVideo, profile);
        }
        converted = true;
        if (converted) {
          adaptivePlan.lastProfile = profile;
          break;
        }
      }
    } catch (err) {
      if (err.code === 'CONVERSION_ABORTED') throw err;
      primaryError = err;
      const reason = isTimeoutLike(err) ? 'progress-stalled-at-5' : 'primary-conversion-failed';
      console.warn(`   ⚠️  [Video→GIF] 主转换失败，触发降级策略 (${reason}): ${err.message}`);
      if (progressCb) progressCb('converting', 12, { estimatedSec, isVideo: true, degraded: true, reason });
    }

    // ── 回退策略 1：先压缩视频再转 GIF ──
    if (!converted && !isUltraLargeFile) {
      throwIfAborted();
      try {
        if (progressCb) progressCb('converting', 20, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'compressing-video' });
        const compressCmd = `ffmpeg -hwaccel auto ${FF_OPT} -threads 0 -i "${conversionSourceVideo}" -vf "setpts=PTS" -c:v libx264 -preset ${mediaTuning.watcher.fallbackCompressVideo.preset} -crf ${mediaTuning.watcher.fallbackCompressVideo.crf} -pix_fmt yuv420p -an -movflags +faststart -y "${tempCompressedVideo}"`;
        await execAsync(compressCmd, { timeout: mediaTuning.watcher.fallbackCompressVideo.timeoutMs, maxBuffer: 120 * 1024 * 1024 });
        throwIfAborted();

        if (!fs.existsSync(tempCompressedVideo) || fs.statSync(tempCompressedVideo).size === 0) {
          throw new Error('视频压缩输出为空');
        }

        if (progressCb) progressCb('converting', 35, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'converting-compressed-video' });
        const fallbackProfile = adaptivePlan.lastProfile || adaptivePlan.profiles[Math.max(0, adaptivePlan.profiles.length - 1)];
        await runFallbackSinglePass(tempCompressedVideo, {
          fps: Math.min(fallbackProfile.fps, mediaTuning.watcher.fallbackAfterCompressToGif.fps),
          scaleDivisor: Math.max(fallbackProfile.scaleDivisor, mediaTuning.watcher.fallbackAfterCompressToGif.scaleDivisor || 2),
          maxColors: Math.min(fallbackProfile.maxColors, mediaTuning.watcher.fallbackAfterCompressToGif.maxColors),
          dither: fallbackProfile.dither === 'none' ? 'none' : mediaTuning.watcher.fallbackAfterCompressToGif.dither,
          timeoutMs: mediaTuning.watcher.fallbackAfterCompressToGif.timeoutMs
        });
        converted = true;
      } catch (fallbackErr) {
        if (fallbackErr.code === 'CONVERSION_ABORTED') throw fallbackErr;
        console.warn(`   ⚠️  [Video→GIF] 回退策略1失败: ${fallbackErr.message}`);
      }
    }

    // ── 回退策略 2：直接有损转 GIF（保底） ──
    if (!converted) {
      throwIfAborted();
      if (progressCb) progressCb('converting', 45, { estimatedSec, isVideo: true, degraded: true, stageDetail: 'lossy-gif-fallback' });
      const lossySource = fs.existsSync(tempCompressedVideo) ? tempCompressedVideo : conversionSourceVideo;
      const fallbackProfile = adaptivePlan.lastProfile || adaptivePlan.profiles[Math.max(0, adaptivePlan.profiles.length - 1)];
      await runFallbackSinglePass(lossySource, {
        fps: isUltraLargeFile
          ? Math.max(mediaTuning.watcher.ultra.fallbackMinFps, fallbackProfile.fps - 1)
          : Math.min(fallbackProfile.fps, mediaTuning.watcher.fallbackLossy.fps),
        scaleDivisor: isUltraLargeFile
          ? Math.max(mediaTuning.watcher.ultra.fallbackScaleDivisorMin, fallbackProfile.scaleDivisor + 1)
          : Math.max(fallbackProfile.scaleDivisor, mediaTuning.watcher.fallbackLossy.scaleDivisor || 2),
        maxColors: isUltraLargeFile
          ? Math.max(mediaTuning.watcher.ultra.fallbackMinColors, fallbackProfile.maxColors - 16)
          : Math.min(fallbackProfile.maxColors, mediaTuning.watcher.fallbackLossy.maxColors),
        dither: isUltraLargeFile ? mediaTuning.watcher.ultra.fallbackDither : mediaTuning.watcher.fallbackLossy.dither,
        timeoutMs: isUltraLargeFile
          ? Math.max(mediaTuning.watcher.ultra.fallbackTimeoutFloorMs, fallbackProfile.timeoutMs - mediaTuning.watcher.ultra.fallbackTimeoutReduceMs)
          : mediaTuning.watcher.fallbackLossy.timeoutMs
      });
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
 * 处理视频文件：转换为 GIF 并写入缓存，尽快返回用于同步到 Figma。
 * 注意：磁盘持久化/源视频删除由调用方按备份策略处理，减少 80→100 阶段阻塞。
 * @returns {{ gifBuffer, gifPath, gifFilename, gifCacheId, sourceVideoPath }} 或 null（失败时）
 */
async function processVideoFile(videoPath, displayFilename, subfolder, progressCb) {
  let waitProgressTimer = null;
  if (progressCb) {
    let waitingPct = 10;
    progressCb('downloading', waitingPct, { isVideo: true, stageDetail: 'icloud-download-wait' });
    // 无损优化：iCloud 大文件等待阶段平滑推进，避免进度长时间卡住
    waitProgressTimer = setInterval(() => {
      waitingPct = Math.min(24, waitingPct + 1);
      progressCb('downloading', waitingPct, { isVideo: true, stageDetail: 'icloud-download-wait' });
    }, 1200);
  }
  let downloaded = false;
  try {
    downloaded = await waitForICloudDownload(videoPath, 300000); // 视频文件给 5 分钟下载时间
  } finally {
    if (waitProgressTimer) {
      clearInterval(waitProgressTimer);
      waitProgressTimer = null;
    }
  }
  if (!downloaded) {
    console.log(`   ⚠️  视频可能未完全下载，尝试继续转换...`);
  }

  const gifBuffer = await convertVideoToGif(videoPath, displayFilename, progressCb);

  const gifFilename = displayFilename.replace(/\.(mp4|mov)$/i, '.gif');
  const gifPath = path.join(path.dirname(videoPath), gifFilename);

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

  return { gifBuffer, gifPath, gifFilename, gifCacheId, sourceVideoPath: videoPath };
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
  
  try {
    await execAsync(`brctl download "${filePath}"`, { timeout: 5000 });
  } catch (e) {}
  
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
    const sipsCommand = `sips -s format jpeg "${filePath}" --out "${tempOutputPath}"`;
    await execAsync(sipsCommand, { maxBuffer: 10 * 1024 * 1024 });
    if (!fs.existsSync(tempOutputPath)) {
      throw new Error('sips 转换失败: 输出文件不存在');
    }
    
    const newFilename = path.basename(filePath, ext) + '.jpg';
    const newPath = path.join(path.dirname(filePath), newFilename);
    
    // 尝试进一步压缩，如果失败则直接使用 sips 转换结果
    try {
      const convertedBuffer = fs.readFileSync(tempOutputPath);
      const normalizedImage = await normalizeStillImageToJpeg(
        { buffer: convertedBuffer, fileName: newFilename, mimeType: 'image/jpeg' },
        { maxWidth: CONFIG.maxWidth, quality: CONFIG.quality, execAsync, timeout: 60000 }
      );
      
      // 写入压缩后的 JPEG
      fs.writeFileSync(newPath, normalizedImage.buffer);
    } catch (normalizeError) {
      console.log(`   ⚠️ [iCloud] JPEG 压缩失败，使用原始转换结果: ${normalizeError.message}`);
      // 压缩失败时，直接复制 sips 转换的结果
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
 * 根据备份模式判断是否应该清理文件（iCloud 模式）
 * iCloud 仅使用 ScreenSyncImg 下的「图片 / GIF / 导出的GIF」，不使用视频子文件夹：
 * - 'gif_only': 同步后保留「GIF」，清理「图片」
 * - 'all': 同步后保留「图片」和「GIF」
 * - 导出的GIF：始终保留
 */
function shouldCleanupFile(subfolder) {
  const backupMode = userConfig.getBackupMode ? userConfig.getBackupMode() : 'gif_only';
  
  // 导出的 GIF 始终保留
  if (subfolder === CONFIG.subfolders.exportedGif) {
    return false;
  }
  
  // GIF 子文件夹
  if (subfolder === CONFIG.subfolders.gif) {
    return false;
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
        const taskId = message.taskId;

        if (taskId) {
          const inflight = consumeRealtimeInflightAck(taskId);
          if (inflight && !keepFile) {
            console.warn(`   ⚠️  收到失败 ACK，准备重试: ${inflight.filename}`);
            scheduleRealtimeRetry(inflight.task, 'FIGMA_FAILED');
          }
        }
        
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
        const taskId = message.taskId;

        if (taskId) {
          const inflight = consumeRealtimeInflightAck(taskId);
          if (inflight) {
            markFileAsProcessed(inflight.filePath);
            syncCount++;
            console.log(`   ✅ 收到Figma确认: ${inflight.filename}`);
            console.log(`   📊 已同步: ${syncCount} 张`);
            if (shouldCleanupFile(inflight.subfolder)) {
              if (fs.existsSync(inflight.filePath)) {
                deleteFile(inflight.filePath);
              } else {
                console.log(`   ⚠️  文件已不存在: ${inflight.filename}`);
              }
            } else {
              console.log(`   📌 根据备份设置，保留文件: ${inflight.filename} (${inflight.subfolder})`);
            }
            console.log('');
            return;
          }
        }
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
        realtimeSessionStartedAt = Date.now();
        clearRealtimeReconcileTimer();
        _abortAllConversions = false;
        if (!watcher) {
          startWatching();
        }
      } else if (message.type === 'stop-realtime') {
        console.log('\n⏸️  停止实时同步模式\n');
        isRealTimeMode = false;
        releaseRuntimeResources({ preserveProcessedCache: true });
        realtimeSessionStartedAt = 0;
        manualSyncAbortRequested = true;
      } else if (message.type === 'manual-sync-count-files') {
        console.log('\n📊 统计文件数量...\n');
        countFilesForManualSync();
      } else if (message.type === 'manual-sync') {
        console.log('\n📦 执行手动同步...\n');
        performManualSync();
      } else if (message.type === 'cancel-manual-sync') {
        pendingManualSync = false;
        const accepted = requestManualSyncCancel();
        if (accepted) {
          console.log('🛑 [iCloud] 收到取消手动同步请求，正在停止...');
          killAllChildProcesses();
        }
      } else if (message.type === 'force-save-gif') {
        const cacheId = message.gifCacheId;
        const filename = message.filename || 'unknown.gif';
        console.log(`💾 [iCloud] 收到强制保存 GIF 请求: ${filename} (cacheId: ${cacheId})`);
        try {
          const cached = userConfig.getGifFromCache(filename, cacheId);
          if (cached && cached.path && fs.existsSync(cached.path)) {
            const gifSub = path.join(CONFIG.icloudPath, CONFIG.subfolders.gif);
            if (!fs.existsSync(gifSub)) fs.mkdirSync(gifSub, { recursive: true });
            const destPath = path.join(gifSub, filename);
            const wasExisting = fs.existsSync(destPath);
            fs.copyFileSync(cached.path, destPath);
            console.log(`   ✅ 已保存到本地: ${destPath}`);
            if (!wasExisting) notifyLocalGifSaved(filename, 'realtime');
            safeSend({ type: 'force-save-gif-done', filename, success: true });
          } else {
            console.warn(`   ⚠️  缓存中找不到 GIF: ${filename}`);
            safeSend({ type: 'force-save-gif-done', filename, success: false });
          }
        } catch (err) {
          console.error(`   ❌ 强制保存 GIF 失败: ${err.message}`);
          safeSend({ type: 'force-save-gif-done', filename, success: false });
        }
      } else if (message.type === 'switch-sync-mode') {
        console.log('\n🔄 收到模式切换消息');
        console.log('   目标模式:', message.mode);
        if (message.mode !== 'icloud') {
          console.log('⚠️  当前是 iCloud watcher，需要切换到其他模式');
          console.log('   正在退出，请等待 start.js 重启正确的 watcher...\n');
          releaseRuntimeResources({ preserveProcessedCache: false });
          clearInterval(cacheCleanupInterval);
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
    releaseRuntimeResources({ preserveProcessedCache: true });
    realtimeSessionStartedAt = 0;
    manualSyncAbortRequested = true;
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
    
    // 实时模式按队列执行：图片/GIF优先，视频后处理，避免视频耗时影响图片进度
    enqueueRealtimeSyncTask({
      finalPath,
      displayFilename,
      subfolder,
      isVideo
    });
    return;
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
      execAsync(`brctl download -R "${CONFIG.icloudPath}"`, { timeout: 30000 }).then(() => {
        console.log('   ✅ 已配置 iCloud 文件夹为"始终保留下载"');
      }).catch((error) => {
        console.log('   ⚠️  配置失败 (不影响基本功能):', error.message);
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

function releaseRuntimeResources(options = {}) {
  const preserveProcessedCache = options.preserveProcessedCache === true;
  killAllChildProcesses();
  stopWatching();
  clearRealtimeRetryTimers();
  clearRealtimeInflightAcks();
  clearRealtimeReconcileTimer();
  realtimeImageQueue.length = 0;
  realtimeVideoQueue.length = 0;
  realtimeQueuedFilePaths.clear();
  pendingDeletes.clear();
  processingFilePaths.clear();
  isRealtimeImageQueueRunning = false;
  isRealtimeVideoQueueRunning = false;
  manualSyncAbortRequested = false;
  pendingManualSync = false;
  if (!preserveProcessedCache) {
    processedFilesCache.clear();
  }
}

// ============= 手动同步模式 =============
function countFilesForManualSync() {
  if (!fs.existsSync(CONFIG.icloudPath)) {
    console.log('❌ 同步文件夹不存在\n');
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-file-count',
        count: 0
      });
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
      safeSend({
        type: 'manual-sync-file-count',
        count: totalCount
      });
    }
  } catch (error) {
    console.error('❌ [iCloud] 统计文件失败:', error.message);
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-file-count',
        count: 0
      });
    }
  }
}

async function performManualSync() {
  if (isSyncing) {
    console.log('⏳ [iCloud] 上一次同步尚未结束，正在强制终止...');
    manualSyncAbortRequested = true;
    killAllChildProcesses();
    const waitStart = Date.now();
    while (isSyncing && Date.now() - waitStart < 3000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (isSyncing) {
      console.warn('⚠️  [iCloud] 旧同步未在 3 秒内结束，强制重置状态');
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

  sendProgress('manual-sync-progress', {
    total: 0, completed: 0, percent: 0,
    fileIndex: 0, filename: '', filePercent: 0, stage: 'listing'
  });

  try {
    if (!fs.existsSync(CONFIG.icloudPath)) {
      console.log('❌ 同步文件夹不存在\n');
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        totalFiles: 0,
        imageCount: 0,
        gifCount: 0,
        videoCount: 0,
        savedGifCount: 0,
        savedVideoCount: 0,
        message: '同步文件夹不存在'
      });
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
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        totalFiles: 0,
        imageCount: 0,
        gifCount: 0,
        videoCount: 0,
        savedGifCount: 0,
        savedVideoCount: 0
      });
      return;
    }

    const imageBatch = [];
    const videoBatch = [];
    for (const item of allFiles) {
      const ext = path.extname(item.filePath).toLowerCase();
      const isVideoItem = ext === '.mp4' || ext === '.mov';
      (isVideoItem ? videoBatch : imageBatch).push(item);
    }
    const orderedFiles = [...imageBatch, ...videoBatch];
    const totalFiles = orderedFiles.length;
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

    const processManualItem = async ({ filePath, subfolder }, fileOrder) => {
      const file = path.basename(filePath);

      // 跳过正在被实时同步处理的文件
      if (processingFilePaths.has(filePath)) {
        console.log(`   ⏭️  [手动同步-去重] 跳过正在处理中的文件: ${file}`);
        return { skipped: true, file, fileOrder };
      }

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

            const gifSub = subfolder || CONFIG.subfolders.gif;
            const keepGif = !shouldCleanupFile(gifSub);
            fileProgressCb('importing', 90);
            const gifDims = parseGifDimensions(result.gifBuffer);
            const useGifUrl = !!(result.gifCacheId && result.gifBuffer.length > LARGE_GIF_URL_THRESHOLD);
            const gifUrl = useGifUrl
              ? `http://localhost:8888/gif-temp/${encodeURIComponent(result.gifCacheId)}?filename=${encodeURIComponent(result.gifFilename)}`
              : null;
            const base64String = useGifUrl ? null : result.gifBuffer.toString('base64');
            safeSend({
              type: 'screenshot',
              bytes: base64String,
              gifUrl,
              timestamp: Date.now(),
              filename: result.gifFilename,
              isGif: true,
              gifCacheId: result.gifCacheId || null,
              imageWidth: gifDims ? gifDims.width : null,
              imageHeight: gifDims ? gifDims.height : null,
              keptInIcloud: keepGif,
              syncSource: 'manual'
            });
            markFileAsProcessed(filePath);
            runPostVideoOps(result, keepGif, file, 'manual');
            return { success: true, isGif: true, isVideo: true, file, fileOrder };
          } catch (convErr) {
            if (isManualSyncCancelledError(convErr) || (convErr && convErr.code === 'CONVERSION_ABORTED')) {
              return { cancelled: true, file, fileOrder };
            }
            console.error(`   ❌ [Video→GIF] 转换失败: ${convErr.message}`);
            try {
              const buf = fs.readFileSync(filePath);
              userConfig.saveGifToCache(buf, file, null);
            } catch (_) {}
            safeSend({ type: 'file-skipped', filename: file, reason: 'video' });
            return { success: false, isVideo: true, file, fileOrder, error: convErr.message };
          }
        }

        fileProgressCb('importing', 50);
        await syncScreenshot(filePath, true, subfolder, 'manual');
        return { success: true, isGif, isVideo: false, file, fileOrder };
      } catch (error) {
        if (isManualSyncCancelledError(error) || (error && error.code === 'CONVERSION_ABORTED')) {
          return { cancelled: true, file, fileOrder };
        }
        console.error(`❌ 同步失败: ${file}`, error.message);
        return { success: false, isGif: false, isVideo: false, file, fileOrder, error: error.message };
      }
    };

    const applyManualResult = (result) => {
      if (!result) return;
      if (result.cancelled) { cancelled = true; return; }
      if (result.skipped) {
        completedCount++;
      } else {
        if (result.success) {
          successCount++;
          if (result.isGif) gifCount++;
        } else if (result.isVideo) {
          videoCount++;
        }
        if (!result.success && result.error) {
          processingErrors.push({ filename: result.file, error: result.error });
        }
        completedCount++;
      }

      const pct = totalFiles > 0 ? Math.round((result.fileOrder / totalFiles) * 100) : 100;
      sendProgress('manual-sync-progress', {
        total: totalFiles, completed: completedCount, percent: pct,
        fileIndex: result.fileOrder, filename: '', filePercent: 100, stage: 'file-done'
      });
    };

    // 图片并发批处理
    for (let start = 0; start < imageBatch.length; start += MANUAL_IMAGE_CONCURRENCY) {
      if (shouldAbort()) { cancelled = true; break; }
      const chunk = imageBatch.slice(start, start + MANUAL_IMAGE_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map((item, idx) => processManualItem(item, start + idx + 1))
      );
      for (const result of chunkResults) {
        applyManualResult(result);
        if (cancelled) break;
      }
      if (cancelled) break;
    }

    // 视频串行处理
    if (!cancelled) {
      for (let i = 0; i < videoBatch.length; i++) {
        if (shouldAbort()) { cancelled = true; break; }
        const result = await processManualItem(videoBatch[i], imageBatch.length + i + 1);
        applyManualResult(result);
        if (cancelled) break;
      }
    }

    if (cancelled) {
      console.log(`\n🛑 [手动模式] 同步已取消 (已完成 ${completedCount}/${totalFiles})\n`);
      safeSend({
        type: 'manual-sync-cancelled',
        count: successCount, totalFiles,
        imageCount: Math.max(0, successCount - gifCount),
        gifCount, completed: completedCount
      });
      return;
    }

    console.log(`\n✅ [手动模式] 同步完成！成功: ${successCount}/${totalFiles}\n`);
    if (processingErrors.length > 0) {
      console.log(`   ❌ 失败: ${processingErrors.length} 个`);
    }

    const imageCount = Math.max(0, successCount - gifCount);
    const savedGifCount = gifCount;
    safeSend({
      type: 'manual-sync-complete',
      count: successCount,
      totalFiles,
      imageCount,
      gifCount,
      videoCount,
      savedGifCount,
      savedVideoCount: 0,
      errors: processingErrors
    });

  } finally {
    manualSyncAbortRequested = false;
    isSyncing = false;
    if (pendingManualSync) {
      pendingManualSync = false;
      console.log('🔄 [iCloud] 执行排队中的手动同步...');
      performManualSync();
    }
  }
}

// ============= 同步截图 =============
async function syncScreenshot(filePath, deleteAfterSync = false, subfolder = null, syncSource = 'realtime', realtimeTask = null) {
  const startTime = Date.now();
  const filename = path.basename(filePath);
  
  if (isFileProcessed(filePath)) {
    return true;
  }
  
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('⏸️  等待服务器连接...');
      throw new Error('服务器未连接');
    }
    
    if (!fs.existsSync(filePath)) {
      console.log('   ⚠️  文件不存在，可能已被删除');
      return false;
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
      return false;
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
        await execAsync(sipsCommand, { maxBuffer: 10 * 1024 * 1024 });
        if (!fs.existsSync(tempOutputPath)) {
          throw new Error('sips 转换失败: 输出文件不存在');
        }
        
        let convertedBuffer = fs.readFileSync(tempOutputPath);
        const manualFastPassBytes = mediaTuning.thresholds.manualImageFastPassKb * 1024;
        const isManualSmallHeif = syncSource === 'manual' && stats.size <= manualFastPassBytes;

        if (isManualSmallHeif) {
          // 小 HEIF 手动同步极速直通：sips 转 JPEG 后直接发送，跳过二次压缩
          imageBuffer = convertedBuffer;
        } else {
          const normalizedImage = await normalizeStillImageToJpeg(
            { buffer: convertedBuffer, fileName: filename.replace(/\.(heic|heif)$/i, '.jpg'), mimeType: 'image/jpeg' },
            { maxWidth: CONFIG.maxWidth, quality: CONFIG.quality, execAsync, timeout: 60000 }
          );
          imageBuffer = normalizedImage.buffer;
        }
        
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
      const manualFastPassBytes = mediaTuning.thresholds.manualImageFastPassKb * 1024;
      const isManualSmallRaster =
        syncSource === 'manual' &&
        !isGif &&
        !isVideo &&
        !isHeif &&
        stats.size <= manualFastPassBytes &&
        (ext === '.jpg' || ext === '.jpeg' || ext === '.png');

      if (isManualSmallRaster) {
        // 小图手动同步极速直通：跳过压缩，直接传给 Figma
        imageBuffer = fs.readFileSync(filePath);
      } else {
        try {
          const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
          const normalizedImage = await normalizeStillImageToJpeg(
            { filePath, fileName: filename, mimeType },
            { maxWidth: CONFIG.maxWidth, quality: CONFIG.quality, execAsync, timeout: 60000 }
          );
          imageBuffer = normalizedImage.buffer;
          
          const compressedSize = (imageBuffer.length / 1024).toFixed(2);
          console.log(`   📦 ${originalSize}KB → ${compressedSize}KB`);
          
        } catch (error) {
          console.log('   ⚠️  压缩失败，使用原文件');
          imageBuffer = fs.readFileSync(filePath);
        }
      }
    }
    
    // 确定文件类型（复用上面已声明的 ext、isGif、isVideo 变量）
    const fileIsGif = isGif;
    const fileIsVideo = isVideo;
    const fileIsImage = !fileIsGif && !fileIsVideo;

    let gifCacheId = null;
    if (fileIsGif) {
      try {
        const cacheResult = userConfig.saveGifToCache(imageBuffer, filename, null);
        if (cacheResult && cacheResult.cacheId) {
          gifCacheId = cacheResult.cacheId;
          saveCacheMapping(filename, gifCacheId);
        }
      } catch (_) {}
    }

    const gifDims = fileIsGif ? parseGifDimensions(imageBuffer) : null;
    const useGifUrl = !!(fileIsGif && gifCacheId && imageBuffer.length > LARGE_GIF_URL_THRESHOLD);
    const gifUrl = useGifUrl
      ? `http://localhost:8888/gif-temp/${encodeURIComponent(gifCacheId)}?filename=${encodeURIComponent(filename)}`
      : null;
    const base64String = useGifUrl ? null : imageBuffer.toString('base64');
    imageBuffer = null;
    
    // 如果没有提供 subfolder，自动检测
    if (!subfolder) {
      subfolder = getTargetSubfolder(filename);
    }
    
    const payload = {
      type: 'screenshot',
      bytes: base64String,
      gifUrl,
      timestamp: Date.now(),
      filename: filename,
      keptInIcloud: !shouldCleanupFile(subfolder), // 根据备份设置判断
      isGif: fileIsGif,
      gifCacheId,
      imageWidth: gifDims ? gifDims.width : null,
      imageHeight: gifDims ? gifDims.height : null,
      isVideo: fileIsVideo,
      isImage: fileIsImage,
      syncSource
    };
    if (syncSource === 'realtime' && realtimeTask && realtimeTask.taskId) {
      payload.taskId = realtimeTask.taskId;
    }
    
    ws.send(JSON.stringify(payload));

    const shouldWaitAck = syncSource === 'realtime' && realtimeTask && realtimeTask.taskId;
    if (shouldWaitAck) {
      markFileAsProcessed(filePath);
      if (deleteAfterSync && shouldCleanupFile(subfolder)) {
        if (fs.existsSync(filePath)) {
          deleteFile(filePath);
        }
      } else if (deleteAfterSync) {
        console.log(`   📌 根据备份设置，保留文件: ${filename}`);
      }
      registerRealtimeInflightAck(realtimeTask, filePath, subfolder, filename);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`   📤 已发送，等待 Figma ACK (${duration}秒)`);
      return true;
    }

    syncCount++;
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`   ✅ 同步完成 (${duration}秒)`);
    console.log(`   📊 已同步: ${syncCount} 张`);

    markFileAsProcessed(filePath);

    if (deleteAfterSync && shouldCleanupFile(subfolder)) {
      if (fs.existsSync(filePath)) {
        deleteFile(filePath);
      }
    } else if (deleteAfterSync) {
      console.log(`   📌 根据备份设置，保留文件: ${filename}`);
    } else {
      console.log('');
    }
    return true;
    
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
  acquireWatcherLockOrExit();
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
  
  const shutdown = (signal) => {
    console.log(`\n\n👋 停止服务 (${signal})...`);
    console.log(`📊 总共同步了 ${syncCount} 张截图`);
    console.log(`📋 待删除队列: ${pendingDeletes.size} 个文件\n`);
    clearInterval(cacheCleanupInterval);
    releaseRuntimeResources({ preserveProcessedCache: false });
    if (ws) ws.close();
    releaseWatcherLock();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();
