// gif-composer.js - GIF annotation composition engine
// Extracted from server.js for maintainability

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mediaTuning = require('./media-processing-tuning');

// 🔒 并发导出序号锁：防止多个导出同时扫描文件夹时拿到相同序号
const _reservedExportNumbers = new Set();

/**
 * Factory: inject server-level dependencies and return the composer function.
 * @param {object} deps
 * @param {Function} deps.execAsyncCancellable - Cancellable exec wrapper
 * @param {Function} deps.removeDirRecursive  - Recursive directory removal
 * @param {object}   deps.userConfig          - User configuration module
 * @returns {Function} composeAnnotatedGif
 */
module.exports = function createComposer({ execAsyncCancellable, removeDirRecursive, userConfig }) {

async function composeAnnotatedGif({ frameName, bottomLayerBytes, staticLayers, annotationLayers, annotationBytes, frameBounds, frameBackground, gifInfos, timelineData, gifAlgorithm, exportMode, connectionId, shouldCancel, onProgress }) {
  // 🎨 根据 gifAlgorithm 设置选择抖动算法
  // ═══════════════════════════════════════════════════════════════════════════
  // less_noise (更少噪点): 
  //   - FFmpeg: dither=none - 完全无抖动，画面最干净，但渐变可能有色带
  //   - ImageMagick: -dither None
  //   - 适合: 纯色、图标、UI界面、文字
  //
  // smooth_gradient (更丝滑渐变):
  //   - FFmpeg: dither=bayer:bayer_scale=3 - 有序抖动，产生细腻的抖动图案
  //   - ImageMagick: -dither Riemersma（比 FloydSteinberg 更适合渐变）
  //   - 适合: 照片、渐变背景、复杂色彩
  // ═══════════════════════════════════════════════════════════════════════════
  // sierra2_4a: 最佳 GIF 抖动算法，渐变过渡自然无色带，LZW 压缩率更高
  const ditherMode = gifAlgorithm === 'smooth_gradient' ? 'sierra2_4a' : 'none';
  const imageMagickDither = gifAlgorithm === 'smooth_gradient' ? 'FloydSteinberg' : 'None';
  console.log(`\n🎨 GIF算法: ${gifAlgorithm || 'smooth_gradient'} → FFmpeg dither=${ditherMode}, ImageMagick dither=${imageMagickDither}\n`);
  

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

  // 导出前视频预处理：先等比缩小到 1/2（偶数尺寸）再进入 GIF 转换
  const buildHalfScaleVideo = async (sourcePath, tag) => {
    const halfPath = path.join(tempDir, `half_${tag}.mp4`);
    const cmd = `ffmpeg -threads 0 -i "${sourcePath}" -vf "scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=lanczos" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -an -movflags +faststart -y "${halfPath}"`;
    try {
      await execAsync(cmd, { timeout: 240000, maxBuffer: 120 * 1024 * 1024 });
      if (fs.existsSync(halfPath) && fs.statSync(halfPath).size > 0) {
        return halfPath;
      }
    } catch (e) {
      console.warn(`   ⚠️  预缩放失败，回退原视频: ${path.basename(sourcePath)} - ${e.message}`);
    }
    return sourcePath;
  };

  // 导出安全阀：确保结果不是“仅首帧静图”
  const getGifFrameCount = async (gifPath) => {
    try {
      const result = await execAsync(`identify "${gifPath}"`, { timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
      return String(result.stdout || '').split('\n').filter(Boolean).length;
    } catch (_) {
      return 0;
    }
  };

  const parseFfprobeRate = (raw) => {
    if (!raw || typeof raw !== 'string') return 0;
    const s = raw.trim();
    if (!s) return 0;
    if (s.includes('/')) {
      const [n, d] = s.split('/').map(Number);
      if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n / d;
      return 0;
    }
    const v = Number(s);
    return Number.isFinite(v) ? v : 0;
  };

  // 优先使用 ffprobe 获取 GIF 元数据（更快）；失败再回退 identify。
  const getGifMetadataFast = async (gifPath, { needTiming = true } = {}) => {
    const fallbackIdentify = async () => {
      const whResult = await execAsync(`identify -format "%w %h" "${gifPath}[0]"`, { timeout: 10000 });
      const [width, height] = String(whResult.stdout || '').trim().split(' ').map(Number);
      if (!needTiming) {
        return { width: width || 1, height: height || 1, frameCount: 1, totalDuration: 0, exactFps: 20, delay: 5, source: 'identify-size' };
      }
      const delayResult = await execAsync(`identify -format "%T\\n" "${gifPath}"`, { timeout: 15000 });
      const delays = String(delayResult.stdout || '').trim().split('\n').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d) && d > 0);
      const frameCount = delays.length || 1;
      const totalDurationTicks = delays.reduce((a, b) => a + b, 0);
      const totalDuration = totalDurationTicks / 100;
      const exactFps = (frameCount > 0 && totalDurationTicks > 0) ? (frameCount * 100) / totalDurationTicks : 20;
      const delay = Math.max(2, Math.round(totalDurationTicks / frameCount) || 5);
      return { width: width || 1, height: height || 1, frameCount, totalDuration, exactFps, delay, source: 'identify-full' };
    };

    try {
      const probeCmd = `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration -of json "${gifPath}"`;
      const probe = await execAsync(probeCmd, { timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
      const parsed = JSON.parse(probe.stdout || '{}');
      const stream = (parsed.streams && parsed.streams[0]) ? parsed.streams[0] : {};

      const width = Math.max(1, Number(stream.width) || 1);
      const height = Math.max(1, Number(stream.height) || 1);
      if (!needTiming) {
        return { width, height, frameCount: 1, totalDuration: 0, exactFps: 20, delay: 5, source: 'ffprobe-size' };
      }

      const frameCount = Math.max(
        1,
        Number(stream.nb_read_frames) || Number(stream.nb_frames) || 0
      );
      const fps = parseFfprobeRate(stream.avg_frame_rate) || parseFfprobeRate(stream.r_frame_rate) || 20;
      const durationFromProbe = Number(stream.duration);
      const totalDuration = Number.isFinite(durationFromProbe) && durationFromProbe > 0
        ? durationFromProbe
        : (frameCount / Math.max(0.1, fps));
      const totalDurationTicks = Math.max(1, Math.round(totalDuration * 100));
      const exactFps = (frameCount * 100) / totalDurationTicks;
      const delay = Math.max(2, Math.round(totalDurationTicks / frameCount) || 5);
      return { width, height, frameCount, totalDuration: totalDurationTicks / 100, exactFps, delay, source: 'ffprobe' };
    } catch (_) {
      return fallbackIdentify();
    }
  };

  const isMagickCacheExhausted = (err) => {
    const msg = String((err && err.message) || '');
    const stderr = String((err && err.stderr) || '');
    const combined = `${msg}\n${stderr}`.toLowerCase();
    return combined.includes('cache resources exhausted') || combined.includes('openpixelcache');
  };

  const isMagickDecodeDelegateMissing = (err) => {
    const msg = String((err && err.message) || '');
    const stderr = String((err && err.stderr) || '');
    const combined = `${msg}\n${stderr}`.toLowerCase();
    return combined.includes('no decode delegate for this image format') || combined.includes('no decode delegate');
  };

  const composeGifWithOverlayViaFfmpeg = async ({ baseGifPath, overlayPath, outputGifPath }) => {
    const filter = `[0:v][1:v]overlay=0:0:format=auto,split[o1][o2];[o1]palettegen=reserve_transparent=0:stats_mode=full[p];[o2][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
    const cmd = `ffmpeg -v warning -i "${baseGifPath}" -i "${overlayPath}" -filter_complex "${filter}" -loop 0 -y "${outputGifPath}"`;
    await execAsync(cmd, { timeout: 300000, maxBuffer: 200 * 1024 * 1024 });
    return outputGifPath;
  };

  // 使用 FFmpeg 合成静态图层为单张 PNG（无损），失败时回退 ImageMagick。
  const mergeStaticLayersToPng = async ({ layerPaths, outputPath, width, height }) => {
    const inputs = (Array.isArray(layerPaths) ? layerPaths : []).filter(Boolean);
    if (inputs.length === 0) {
      const transparentCmd = `ffmpeg -v warning -f lavfi -i "color=c=black@0.0:s=${width}x${height},format=rgba" -frames:v 1 -y "${outputPath}"`;
      await execAsync(transparentCmd, { timeout: 30000, maxBuffer: 50 * 1024 * 1024 });
      return outputPath;
    }
    if (inputs.length === 1) {
      fs.copyFileSync(inputs[0], outputPath);
      return outputPath;
    }

    try {
      const ffInputs = inputs.map((p) => `-i "${p}"`).join(' ');
      const filterParts = [];
      let prev = '0:v';
      for (let i = 1; i < inputs.length; i++) {
        const out = `m${i}`;
        filterParts.push(`[${prev}][${i}:v]overlay=0:0:format=auto[${out}]`);
        prev = out;
      }
      filterParts.push(`[${prev}]format=rgba[out]`);
      const ffCmd = `ffmpeg -v warning -threads 0 ${ffInputs} -filter_complex "${filterParts.join(';')}" -map "[out]" -frames:v 1 -y "${outputPath}"`;
      await execAsync(ffCmd, { timeout: 60000, maxBuffer: 100 * 1024 * 1024 });
      return outputPath;
    } catch (_) {
      let magickCmd = `magick "${inputs[0]}"`;
      for (let i = 1; i < inputs.length; i++) magickCmd += ` "${inputs[i]}" -composite`;
      magickCmd += ` "${outputPath}"`;
      await execAsync(magickCmd, { timeout: 60000, maxBuffer: 100 * 1024 * 1024 });
      return outputPath;
    }
  };

  const parseImageTransform = (imageTransform) => {
    if (!imageTransform) return null;
    if (Array.isArray(imageTransform)) return imageTransform;
    if (typeof imageTransform === 'string') {
      try { return JSON.parse(imageTransform); } catch (_) { return null; }
    }
    return null;
  };

  const buildResizeVfForImageFill = ({ imageFillInfo, originalW, originalH, gifW, gifH }) => {
    const fillInfo = imageFillInfo || { scaleMode: 'FILL' };
    const transform = parseImageTransform(fillInfo.imageTransform);

    if (fillInfo.scaleMode === 'FIT') {
      return `scale=${gifW}:${gifH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${gifW}:${gifH}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
    }

    if (fillInfo.scaleMode === 'CROP') {
      if (transform && Array.isArray(transform)) {
        const a = transform[0][0] || 1;
        const d = transform[1][1] || 1;
        const tx = transform[0][2] || 0;
        const ty = transform[1][2] || 0;
        const scaledW = Math.round(gifW / a);
        const scaledH = Math.round(gifH / d);
        const cropOffsetX = Math.max(0, Math.round(tx * scaledW));
        const cropOffsetY = Math.max(0, Math.round(ty * scaledH));
        return `scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}`;
      }
      const cropW = Math.min(originalW, gifW);
      const cropH = Math.min(originalH, gifH);
      const cropX = Math.max(0, Math.round((originalW - cropW) / 2));
      const cropY = Math.max(0, Math.round((originalH - cropH) / 2));
      const padX = Math.max(0, Math.round((gifW - cropW) / 2));
      const padY = Math.max(0, Math.round((gifH - cropH) / 2));
      return `crop=${cropW}:${cropH}:${cropX}:${cropY},pad=${gifW}:${gifH}:${padX}:${padY}:color=black@0`;
    }

    // FILL 模式：Cover 缩放填满容器
    const scaleX = gifW / originalW;
    const scaleY = gifH / originalH;
    const scale = Math.max(scaleX, scaleY);
    let scaledW = Math.round(originalW * scale);
    let scaledH = Math.round(originalH * scale);
    let cropOffsetX = 0;
    let cropOffsetY = 0;

    if (transform && Array.isArray(transform)) {
      const a = transform[0][0] || 1;
      const d = transform[1][1] || 1;
      const tx = transform[0][2] || 0;
      const ty = transform[1][2] || 0;
      scaledW = Math.round(originalW * scale * (1 / a));
      scaledH = Math.round(originalH * scale * (1 / d));
      cropOffsetX = Math.round(tx * scaledW);
      cropOffsetY = Math.round(ty * scaledH);
    } else {
      cropOffsetX = Math.round((scaledW - gifW) / 2);
      cropOffsetY = Math.round((scaledH - gifH) / 2);
    }

    cropOffsetX = Math.max(0, Math.min(cropOffsetX, Math.max(0, scaledW - gifW)));
    cropOffsetY = Math.max(0, Math.min(cropOffsetY, Math.max(0, scaledH - gifH)));
    return `scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}`;
  };

  const normalizedRequestedMode = (exportMode === 'fast' || exportMode === 'quality') ? exportMode : 'auto';
  let _exportModeLogged = false;

  // 自适应导出参数：自动按阈值切换 fast/quality，确保超大导出进入极速档。
  const getAdaptiveProfile = ({ preSizeMB = 0, decisionSizeMB = null, frameCount = 0, hasVideoLayers = false } = {}) => {
    const fw = Math.max(1, Math.round((frameBounds && frameBounds.width) || 1));
    const fh = Math.max(1, Math.round((frameBounds && frameBounds.height) || 1));
    const pixels = fw * fh;

    let score = pixels;
    if (frameCount > 0) score *= Math.min(6, Math.max(1, frameCount / 120));
    if (hasVideoLayers) score *= 1.15;

    const thresholds = mediaTuning.thresholds || {};
    const exportCfg = mediaTuning.composerExport || {};
    const triggerCfg = exportCfg.ultraTrigger || {};
    const globalUltraMb = Number.isFinite(thresholds.ultraSpeedVideoMb) ? thresholds.ultraSpeedVideoMb : 150;
    const minVideoMb = Number.isFinite(triggerCfg.minVideoMb) ? triggerCfg.minVideoMb : globalUltraMb;
    const minPixels = Number.isFinite(triggerCfg.minPixels) ? triggerCfg.minPixels : 3500000;
    const minFrames = Number.isFinite(triggerCfg.minFrames) ? triggerCfg.minFrames : 220;
    const minScore = Number.isFinite(triggerCfg.minScore) ? triggerCfg.minScore : 12000000;

    const modeSizeMB = Number.isFinite(decisionSizeMB) ? decisionSizeMB : preSizeMB;
    const autoFast = modeSizeMB >= minVideoMb || pixels >= minPixels || frameCount >= minFrames || score >= minScore;
    const effectiveMode = normalizedRequestedMode === 'auto'
      ? (autoFast ? 'fast' : 'quality')
      : normalizedRequestedMode;

    const ct = mediaTuning.composer || {};
    const modeCfg = (effectiveMode === 'fast' ? exportCfg.fast : exportCfg.quality) || {};
    let videoFpsCap = modeCfg.fpsCap || ct.fpsCap || 24;
    if (score > 12_000_000 || modeSizeMB > 80) videoFpsCap = modeCfg.fpsCapXLarge || ct.fpsCapXLarge || 16;
    else if (score > 6_000_000 || modeSizeMB > 40) videoFpsCap = modeCfg.fpsCapLarge || ct.fpsCapLarge || 20;
    else if (score > 2_500_000 || modeSizeMB > 20) videoFpsCap = modeCfg.fpsCapMedium || ct.fpsCapMedium || 22;

    let lossy = modeCfg.lossyBase || 80;
    if (score > 12_000_000 || modeSizeMB > 80) lossy = modeCfg.lossyXLarge || 102;
    else if (score > 6_000_000 || modeSizeMB > 40) lossy = modeCfg.lossyLarge || 94;
    else if (score > 2_500_000 || modeSizeMB > 20) lossy = modeCfg.lossyMedium || 88;
    else if (score < 1_200_000 && modeSizeMB < 8 && effectiveMode !== 'fast') lossy = Math.min(lossy, 72);

    if (gifAlgorithm === 'less_noise') lossy -= 8;
    if (gifAlgorithm === 'smooth_gradient') lossy += 4;
    lossy = Math.max(60, Math.min(110, Math.round(lossy)));

    const timeoutScale = Number.isFinite(modeCfg.timeoutScale) ? modeCfg.timeoutScale : 1.0;
    const pipelinePerFrameMs = Number.isFinite(modeCfg.pipelinePerFrameMs) ? modeCfg.pipelinePerFrameMs : 5000;
    const paletteGenTimeoutMs = Number.isFinite(modeCfg.paletteGenTimeoutMs) ? modeCfg.paletteGenTimeoutMs : 60000;
    const paletteUseTimeoutMs = Number.isFinite(modeCfg.paletteUseTimeoutMs) ? modeCfg.paletteUseTimeoutMs : 120000;
    const gifsicleTimeoutPerMbMs = Number.isFinite(modeCfg.gifsicleTimeoutPerMbMs) ? modeCfg.gifsicleTimeoutPerMbMs : 5000;

    if (!_exportModeLogged) {
      const reason = normalizedRequestedMode === 'auto'
        ? `auto(sourceSize=${modeSizeMB.toFixed(1)}MB,pixels=${pixels},frames=${frameCount},score=${Math.round(score)})`
        : `manual(${normalizedRequestedMode})`;
      console.log(`   ⚙️ 导出模式: ${effectiveMode.toUpperCase()} [${reason}]`);
      _exportModeLogged = true;
    }

    return {
      videoFpsCap,
      lossy,
      mode: effectiveMode,
      timeoutScale,
      pipelinePerFrameMs,
      paletteGenTimeoutMs,
      paletteUseTimeoutMs,
      gifsicleTimeoutPerMbMs
    };
  };
  
  console.log('🎬 开始合成 GIF...');
  
  // 1. 定义查找路径和命令
  const archKey = process.arch === 'arm64' ? 'apple' : 'intel';
  const searchPaths = [
    path.join(__dirname, 'runtime', 'bin'),
    path.join(__dirname, 'runtime', archKey, 'bin'),
    path.join(__dirname, 'runtime', process.arch, 'bin'),
    path.join(__dirname, 'runtime', 'node', 'bin'),
    path.join(__dirname, 'runtime', archKey, 'node', 'bin'),
    path.join(__dirname, 'runtime', process.arch, 'node', 'bin'),
    path.join(os.homedir(), '.screensync', 'bin'), // ScreenSync 本地安装 (legacy macOS)
    path.join(os.homedir(), '.screensync', 'deps', 'imagemagick', 'bin'),
    '/opt/homebrew/bin',  // Apple Silicon
    '/usr/local/bin',     // Intel Mac
    '/opt/local/bin',     // MacPorts
    '/usr/bin',
    '/bin'
  ];
  
  // 2. 尝试自动修复 PATH
  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath) && !process.env.PATH.includes(searchPath)) {
      process.env.PATH = `${searchPath}:${process.env.PATH}`;
    }
  }

  if (!process.env.MAGICK_HOME) {
    const runtimeImHome = path.join(__dirname, 'runtime', 'imagemagick');
    const localImHome = path.join(os.homedir(), '.screensync', 'deps', 'imagemagick');
    const imHome = fs.existsSync(path.join(runtimeImHome, 'bin', 'magick')) ? runtimeImHome : localImHome;
    if (fs.existsSync(path.join(imHome, 'bin', 'magick'))) {
      process.env.MAGICK_HOME = imHome;
    }
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
    if (!versionLine.toLowerCase().includes('imagemagick')) {
      console.warn('⚠️ convert 可能不是 ImageMagick');
    }

    // 5. 验证 identify 命令
    try {
      await execAsync('identify -version');
    } catch (e) {
      // 静默处理
    }
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
  
  // 1. 获取必要的配置 (userConfig injected via factory)
  
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
  } else {
    // Google Drive 或其他模式：保存到 ScreenSyncImg/GIF-导出 子文件夹
    const baseFolder = userConfig.getLocalDownloadFolder();
    downloadFolder = path.join(baseFolder, 'GIF-导出');
  }
  
  // 确保输出文件夹存在
  if (!fs.existsSync(downloadFolder)) {
    fs.mkdirSync(downloadFolder, { recursive: true });
  }
  
  // 1.5. 生成输出文件名（使用序号命名，填补空缺）
  // 扫描文件夹找到所有现有序号 + 并发锁中已预留的序号
  const occupiedNumbers = new Set(_reservedExportNumbers); // 复制已预留序号
  try {
    const files = fs.readdirSync(downloadFolder);
    files.forEach(file => {
      const match = file.match(/^ExportedGIF_(\d+)\.gif$/);
      if (match) {
        occupiedNumbers.add(parseInt(match[1], 10));
      }
    });
  } catch (err) {
    console.warn(`   ⚠️  扫描文件夹失败: ${err.message}`);
  }
  
  // 找到第一个未被占用的序号（磁盘 + 并发预留均跳过）
  let sequenceNumber = 1;
  while (occupiedNumbers.has(sequenceNumber)) {
    sequenceNumber++;
  }
  
  // 🔒 立即预留该序号，防止并发导出拿到同一个
  _reservedExportNumbers.add(sequenceNumber);
  
  const paddedNumber = sequenceNumber.toString().padStart(3, '0');
  const outputFilename = `ExportedGIF_${paddedNumber}.gif`;
  const outputPath = path.join(downloadFolder, outputFilename);
  
  // 如果文件已存在，直接跳过所有处理
  if (fs.existsSync(outputPath)) {
    console.log(`\n⏭️  文件已存在，跳过所有处理: ${outputFilename}`);
    const stats = fs.statSync(outputPath);
    reportProgress(100, '文件已存在，已跳过');
    _reservedExportNumbers.delete(sequenceNumber); // 🔒 释放预留序号
    
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
  // 2. 验证并查找所有原始 GIF/视频 文件
  
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
    
    
    let gifPath = null;
    
    // 方法 1：从缓存通过 ID 查找
    if (gif.cacheId) {
      const cacheResult = userConfig.getGifFromCache(null, gif.cacheId);
      
      if (cacheResult) {
        gifPath = cacheResult.path;
      }
    }
    
    // 方法 2：从缓存通过文件名查找
    if (!gifPath && gif.filename) {
      const cacheResult = userConfig.getGifFromCache(gif.filename, null);
      
      if (cacheResult) {
        gifPath = cacheResult.path;
      }
    }
    
    // 方法 2.5：从 GIF 缓存查找
    if (!gifPath && (gif.cacheId || gif.filename)) {
      if (gif.cacheId) {
        const cacheResult = userConfig.getGifFromCache(null, gif.cacheId);
        if (cacheResult && cacheResult.path) {
          gifPath = cacheResult.path;
          
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
        const driveId = gif.driveFileId || gif.ossFileId;
        if (driveId) {
          const cacheResult = userConfig.getGifFromCache(driveId);
          if (cacheResult && cacheResult.path && fs.existsSync(cacheResult.path)) {
            gifPath = cacheResult.path;
          }
        }
      }
    }
    
    // 方法 2.6：从 ScreenSyncImg 各子文件夹查找
    if (!gifPath && (gif.driveFileId || gif.ossFileId || gif.filename)) {
      
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
          } else {
            // 模糊匹配（去除扩展名后比较）
            const targetExt = path.extname(gif.filename).toLowerCase();
            const targetName = path.basename(gif.filename, targetExt);
            
            for (const file of allFiles) {
              const fileExt = path.extname(file).toLowerCase();
              const fileName = path.basename(file, fileExt);
              
              if (fileName === targetName && ['.gif', '.mov', '.mp4'].includes(fileExt)) {
                gifPath = path.join(gifExportFolder, file);
                break;
              }
            }
          }
        }
      }
    }
    
    // 方法 3：从 ScreenSyncImg 文件夹查找
    if (!gifPath && gif.filename) {
      let baseFolder;
      if (currentMode === 'icloud') {
        baseFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
      } else {
        baseFolder = userConfig.getLocalDownloadFolder();
      }
      
      const searchFolders = [
        baseFolder,
        path.join(baseFolder, '视频'),
        path.join(baseFolder, 'GIF'),
      ];
      
      const targetExt = path.extname(gif.filename).toLowerCase();
      const targetName = path.basename(gif.filename, targetExt);
      const targetNameClean = targetName.replace(/_\d+$/, '');
      
      // 查找匹配的文件（支持模糊匹配和扩展名变化）
      const compatibleExts = ['.mov', '.mp4', '.gif'];
      
      let matchingFile = null;
      let matchingFolder = null;
      
      // 遍历所有搜索文件夹
      for (const searchFolder of searchFolders) {
        if (!fs.existsSync(searchFolder)) {
          continue;
        }
        
        const filesInFolder = fs.readdirSync(searchFolder);
        
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
          break; // 找到就退出循环
        }
      }
      
      // 如果没找到，输出详细的调试信息
    }
    
    // 方法 4：单 GIF 自动匹配
    if (!gifPath && gifInfos.length === 1) {
      let baseFolder;
      if (currentMode === 'icloud') {
        baseFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
      } else {
        baseFolder = userConfig.getLocalDownloadFolder();
      }
      
      const searchFolders = [
        baseFolder,
        path.join(baseFolder, '视频'),
        path.join(baseFolder, 'GIF'),
      ];
      
      const allVideoGifFiles = [];
      const compatibleExts = ['.mov', '.mp4', '.gif'];
      
      for (const searchFolder of searchFolders) {
        if (!fs.existsSync(searchFolder)) continue;
        
        const filesInFolder = fs.readdirSync(searchFolder);
        for (const f of filesInFolder) {
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
      
      if (allVideoGifFiles.length === 1) {
        gifPath = allVideoGifFiles[0].path;
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
    
    let sourceSizeMB = 0;
    try {
      sourceSizeMB = fs.statSync(gifPath).size / (1024 * 1024);
    } catch (_) {}

    gifPaths.push({
      path: gifPath,
      sourcePath: gifPath,
      sourceSizeMB,
      bounds: gif.bounds,
      cornerRadius: gif.cornerRadius,
      clipBounds: gif.clipBounds,
      clipCornerRadius: gif.clipCornerRadius,
      imageFillInfo: gif.imageFillInfo, // ✅ 传递 imageFillInfo
      zIndex: gif.zIndex, // ✅ 传递 z-index
      layerId: gif.layerId // ✅ 传递 layerId 用于时间线功能
    });
    
  }
  
  
  // 2.5. 预处理：将视频文件转换为高帧率 GIF
  
  // 检查是否有视频文件
  const hasVideo = gifPaths.some(item => {
    const ext = path.extname(item.path).toLowerCase();
    return ext === '.mp4' || ext === '.mov';
  });
  
  // 如果有视频文件，预先检查 FFmpeg
  if (hasVideo) {
    try {
      await execAsync('which ffmpeg');
    } catch (e) {
      throw new Error('未找到 FFmpeg\n\n视频转 GIF 需要 FFmpeg，请先安装:\nbrew install ffmpeg');
    }
  }
  
  // 🚀 优化：并行处理所有视频转换任务
  // 说明：GIF 在后续统一帧合成与最终编码阶段会再次走调色板+压缩，
  // 这里不再做一次“预重编码”，避免重复计算造成导出变慢。
  await Promise.all(gifPaths.map(async (item, i) => {
    const ext = path.extname(item.path).toLowerCase();
    
    if (ext === '.mp4' || ext === '.mov') {
      const processedGifPath = path.join(tempDir, `processed_${i}.gif`);
      const palettePath = path.join(tempDir, `palette_${i}.png`);
      
      const targetW = Math.round(item.bounds.width);
      const targetH = Math.round(item.bounds.height);
      const videoSourceForGif = await buildHalfScaleVideo(item.path, `pre_${i}`);
      
      // 🚀 缓存：源视频→GIF 的转换结果（包含目标尺寸+抖动算法+当前帧率上限配置）
      // 这个缓存是安全的，因为它只缓存源视频/GIF 文件本身的转换，
      // 不影响后续的帧合成步骤（帧合成每次都会重新读取所有图层）
      const fileStats = fs.statSync(videoSourceForGif);
      const adaptive = getAdaptiveProfile({
        preSizeMB: fileStats.size / (1024 * 1024),
        decisionSizeMB: Number.isFinite(item.sourceSizeMB) ? item.sourceSizeMB : null,
        hasVideoLayers: true
      });
      const composerCfg = mediaTuning.composer || {};
      const exportCfg = mediaTuning.composerExport || {};
      const fastCfg = exportCfg.fast || {};
      const qualityCfg = exportCfg.quality || {};
      const composerSig = [
        `c${composerCfg.fpsCap || 24}_${composerCfg.fpsCapMedium || 22}_${composerCfg.fpsCapLarge || 20}_${composerCfg.fpsCapXLarge || 16}`,
        `f${fastCfg.fpsCap || 24}_${fastCfg.fpsCapMedium || 20}_${fastCfg.fpsCapLarge || 16}_${fastCfg.fpsCapXLarge || 12}`,
        `q${qualityCfg.fpsCap || 60}_${qualityCfg.fpsCapMedium || 50}_${qualityCfg.fpsCapLarge || 30}_${qualityCfg.fpsCapXLarge || 15}`
      ].join('_');
      // v8: 导出模式参数签名纳入缓存键，避免极速/高质切换误命中旧缓存
      const cacheKey = crypto.createHash('md5')
        .update(`v8_half_${videoSourceForGif}_${fileStats.size}_${fileStats.mtime.getTime()}_${targetW}x${targetH}_dither_${ditherMode}_vf${adaptive.videoFpsCap}_${composerSig}`)
        .digest('hex');
      
      const localFolder = userConfig.getLocalDownloadFolder();
      const processCacheDir = path.join(localFolder, '.gif_process_cache');
      if (!fs.existsSync(processCacheDir)) {
        fs.mkdirSync(processCacheDir, { recursive: true });
      }
      
      const cachedGifPath = path.join(processCacheDir, `${cacheKey}.gif`);
      
      if (fs.existsSync(cachedGifPath)) {
        fs.copyFileSync(cachedGifPath, processedGifPath);
        item.path = processedGifPath;
        console.log(`   ⚡ 命中缓存，跳过转换 (${targetW}x${targetH})`);
        return;
      }
      
      const isVideo = true;
      console.log(`   🔄 ${isVideo ? '转换视频' : '重新处理 GIF'} (${targetW}x${targetH}, dither=${ditherMode})...`);
      
      // 根据文件类型选择不同的处理方式
      let sourceFps = 15; // 默认帧率
      
      if (isVideo) {
        // 视频文件：检测帧率
        try {
          const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${videoSourceForGif}"`;
          const probeResult = await execAsync(probeCmd, { timeout: 10000 });
          const fpsStr = probeResult.stdout.trim();
          if (fpsStr) {
            const [num, den] = fpsStr.split('/').map(Number);
            sourceFps = den ? num / den : num;
          }
        } catch (probeError) {
          // 静默处理
        }
      }
      
      let gifFps = Math.min(sourceFps, adaptive.videoFpsCap);
      
      // 🚀 两阶段调色板生成（替代单命令 split 方案）
      // 优势：① 内存占用大幅降低（无需缓冲所有帧）② 大文件更稳定
      // 阶段 1：分析所有帧 → 生成最优全局调色板
      // 阶段 2：用调色板 + 抖动渲染最终 GIF
      //
      // stats_mode=full: 分析所有帧的所有像素，色彩最准确
      // diff_mode=rectangle: 帧差分 + 脏矩形裁剪（核心压缩手段，体积降 50-70%）
      // sierra2_4a: 最佳抖动算法，渐变过渡自然无色带
      const scaleFilter = isVideo
        ? `fps=${gifFps},scale=${targetW}:${targetH}:flags=lanczos`
        : `scale=${targetW}:${targetH}:flags=lanczos`;
      
      // 阶段 1：生成全局最优调色板（轻量级，只输出一张 PNG）
      const paletteGenCmd = `ffmpeg -threads 0 -i "${videoSourceForGif}" -vf "${scaleFilter},palettegen=max_colors=256:stats_mode=full" -y "${palettePath}"`;
      await execAsync(paletteGenCmd, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: Math.max(30000, adaptive.paletteGenTimeoutMs)
      });
      
      // 阶段 2：用调色板渲染 GIF（尝试硬件加速解码）
      const paletteUseFilter = `${scaleFilter}[v];[v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle`;
      const ffmpegCmdHwAccel = `ffmpeg -hwaccel videotoolbox -vsync 0 -threads 0 -i "${videoSourceForGif}" -i "${palettePath}" -lavfi "${paletteUseFilter}" -threads 0 "${processedGifPath}" -y`;
      const ffmpegCmdSoftware = `ffmpeg -vsync 0 -threads 0 -i "${videoSourceForGif}" -i "${palettePath}" -lavfi "${paletteUseFilter}" -threads 0 "${processedGifPath}" -y`;
      
      let ffmpegCmd = ffmpegCmdHwAccel;
      const conversionStartTime = Date.now();
      
      try {
        await execAsync(ffmpegCmd, {
          maxBuffer: 200 * 1024 * 1024,
          timeout: Math.max(60000, Math.ceil(600000 * adaptive.timeoutScale))
        });
      } catch (hwAccelError) {
        ffmpegCmd = ffmpegCmdSoftware;
        await execAsync(ffmpegCmd, {
          maxBuffer: 200 * 1024 * 1024,
          timeout: Math.max(60000, Math.ceil(600000 * adaptive.timeoutScale))
        });
      }

      // 若出现仅首帧，自动使用软件编码重试一次（兼容部分硬件解码时间戳异常）
      const frameCount = await getGifFrameCount(processedGifPath);
      if (frameCount <= 1) {
        await execAsync(ffmpegCmdSoftware, {
          maxBuffer: 200 * 1024 * 1024,
          timeout: Math.max(60000, Math.ceil(600000 * adaptive.timeoutScale))
        });
      }
      
      const conversionTime = ((Date.now() - conversionStartTime) / 1000).toFixed(1);
      console.log(`   ✅ ${isVideo ? '视频转GIF' : 'GIF重新处理'}完成 (${conversionTime}s, dither=${ditherMode})`);
      
      try {
        // 快速验证：文件存在且非空即可（FFmpeg 出错时会抛异常，不需要再 identify）
        if (!fs.existsSync(processedGifPath) || fs.statSync(processedGifPath).size < 100) {
          throw new Error(`GIF 文件未生成或为空`);
        }
        
        // 🚀 保存到缓存
        try {
          fs.copyFileSync(processedGifPath, cachedGifPath);
        } catch (cacheErr) {
          // 缓存保存失败不影响导出
        }
        
        // 更新路径为处理后的 GIF
        item.path = processedGifPath;
        
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
        if (fs.existsSync(processedGifPath)) {
          try {
            fs.unlinkSync(processedGifPath);
          } catch (e) {
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
  
  // 3. 保存 Bottom Layer
  let bottomLayerPath = null;
  if (bottomLayerBytes && bottomLayerBytes.length > 0) {
    bottomLayerPath = path.join(tempDir, 'bottom_layer.png');
    const bottomLayerBuffer = Buffer.from(bottomLayerBytes);
    fs.writeFileSync(bottomLayerPath, bottomLayerBuffer);
  }
  
  // 4. 保存静态图层
  const staticLayerPaths = [];
  if (staticLayers && staticLayers.length > 0) {
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
      
    }
  }
  
  // 4.5 保存标注图层（GIF 之上的图层，支持时间线控制）
  const annotationLayerPaths = [];
  if (annotationLayers && annotationLayers.length > 0) {
    for (let i = 0; i < annotationLayers.length; i++) {
      const layer = annotationLayers[i];
      const layerPath = path.join(tempDir, `annotation_layer_${i}_index${layer.index}.png`);
      const layerBuffer = Buffer.from(layer.bytes);
      fs.writeFileSync(layerPath, layerBuffer);
      
      annotationLayerPaths.push({
        path: layerPath,
        index: layer.index,
        name: layer.name,
        layerId: layer.layerId
      });
    }
  }
  
  // 5. 保存 Top Layer
  let annotationPath = null;
  if (annotationBytes && annotationBytes.length > 0 && annotationLayerPaths.length === 0) {
    annotationPath = path.join(tempDir, 'annotation.png');
    const annotationBuffer = Buffer.from(annotationBytes);
    fs.writeFileSync(annotationPath, annotationBuffer);
  }
  
  try {
    // 📐 尺寸上限已在 Figma 端（code.js）通过 exportScale 预缩放完成
    // frameBounds、gifInfo.bounds、clipBounds、cornerRadius 以及所有 PNG 图层
    // 都已经是缩放后的尺寸，服务端无需再做任何 resize
    const frameW = Math.round(frameBounds.width);
    const frameH = Math.round(frameBounds.height);
    
    // 🕐 如果有时间线数据，强制使用多 GIF 模式（支持按帧控制可见性）
    const hasTimelineEdits = timelineData && Object.keys(timelineData).length > 0 &&
                             Object.values(timelineData).some(range => range.start > 0 || range.end < 100);

    // 仅基于“参与导出的图层 + 真正被编辑的区间”计算时间线覆盖范围，
    // 避免 timelineData 中默认 0-100 图层把裁剪范围拉回全长，导致无图层段黑屏。
    const getEffectiveTimelineTrimPercent = () => {
      if (!hasTimelineEdits || !timelineData) {
        return { start: 0, end: 100, hasEditedCoverage: false };
      }

      const exportLayerIds = new Set();
      if (gifPaths && Array.isArray(gifPaths)) {
        gifPaths.forEach(g => { if (g && g.layerId) exportLayerIds.add(g.layerId); });
      }
      if (staticLayerPaths && Array.isArray(staticLayerPaths)) {
        staticLayerPaths.forEach(l => { if (l && l.layerId) exportLayerIds.add(l.layerId); });
      }
      if (annotationLayerPaths && Array.isArray(annotationLayerPaths)) {
        annotationLayerPaths.forEach(l => { if (l && l.layerId) exportLayerIds.add(l.layerId); });
      }

      const editedRanges = [];
      for (const [layerId, rawRange] of Object.entries(timelineData)) {
        if (!rawRange) continue;
        if (exportLayerIds.size > 0 && !exportLayerIds.has(layerId)) continue;

        const startNum = Number(rawRange.start);
        const endNum = Number(rawRange.end);
        if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) continue;

        const start = Math.max(0, Math.min(100, startNum));
        const end = Math.max(0, Math.min(100, endNum));
        if (end <= start) continue;

        // 只看实际编辑过的区间，默认 0-100 不参与裁剪覆盖计算
        if (start > 0 || end < 100) {
          editedRanges.push({ start, end });
        }
      }

      if (editedRanges.length === 0) {
        return { start: 0, end: 100, hasEditedCoverage: false };
      }

      return {
        start: Math.min(...editedRanges.map(r => r.start)),
        end: Math.max(...editedRanges.map(r => r.end)),
        hasEditedCoverage: true
      };
    };
    
    if (gifPaths.length === 1) {
      // 单个 GIF：使用 FFmpeg 管道优化（支持时间线编辑 via enable 表达式）
      reportProgress(10, '正在准备合成...');
      const gifInfo = gifPaths[0];
      
      // ✅ 视频/GIF 预处理 (单文件模式)
      // ⚠️ 跳过已在前面 Promise.all 中处理过的文件
      const alreadyProcessedSingle = gifInfo.path.startsWith(tempDir);
      const ext = path.extname(gifInfo.path).toLowerCase();
      if (!alreadyProcessedSingle && (ext === '.mov' || ext === '.mp4')) {
          const tempProcessedGif = path.join(tempDir, `processed_single.gif`);
          const tempPaletteSingle = path.join(tempDir, `palette_single.png`);
          const singleVideoSource = await buildHalfScaleVideo(gifInfo.path, 'single');
          const videoStatsSingle = fs.statSync(singleVideoSource);
          const adaptiveSingle = getAdaptiveProfile({
            preSizeMB: videoStatsSingle.size / (1024 * 1024),
            decisionSizeMB: Number.isFinite(gifInfo.sourceSizeMB) ? gifInfo.sourceSizeMB : null,
            hasVideoLayers: true
          });
          
          // 🚀 两阶段调色板（与主预处理流程一致）
          try {
              const vfBase = `fps=${adaptiveSingle.videoFpsCap},`;
              // 阶段 1：生成调色板
              await execAsync(`ffmpeg -threads 0 -i "${singleVideoSource}" -vf "${vfBase}palettegen=max_colors=256:stats_mode=full" -y "${tempPaletteSingle}"`, {
                timeout: Math.max(30000, adaptiveSingle.paletteGenTimeoutMs)
              });
              // 阶段 2：渲染 GIF
              const lavfi = `fps=${adaptiveSingle.videoFpsCap}[v];[v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle`;
              await execAsync(`ffmpeg -vsync 0 -threads 0 -i "${singleVideoSource}" -i "${tempPaletteSingle}" -lavfi "${lavfi}" -threads 0 "${tempProcessedGif}" -y`, {
                timeout: Math.max(60000, adaptiveSingle.paletteUseTimeoutMs)
              });
              const singleFrames = await getGifFrameCount(tempProcessedGif);
              if (singleFrames <= 1) {
                await execAsync(`ffmpeg -vsync 0 -threads 0 -i "${singleVideoSource}" -i "${tempPaletteSingle}" -lavfi "${lavfi}" -threads 0 "${tempProcessedGif}" -y`, {
                  timeout: Math.max(60000, adaptiveSingle.paletteUseTimeoutMs)
                });
              }
              if (fs.existsSync(tempPaletteSingle)) fs.unlinkSync(tempPaletteSingle);
              gifInfo.path = tempProcessedGif;
          } catch (e) {
              throw new Error(`无法处理文件: ${path.basename(gifInfo.path)}`);
          }
      }
      
      // 验证 gifInfo 结构
      
      if (!gifInfo || !gifInfo.bounds) {
        console.error(`   ❌ gifInfo 结构无效:`, gifInfo);
        throw new Error('GIF 信息结构无效，缺少 bounds 数据');
      }
      
      // 🚀🚀🚀 FFmpeg 管道优化（单 GIF 模式）
      // 对比 ImageMagick 逐步合成：
      //   旧: 3-6 次 magick 命令（每次 coalesce 解码+重编码所有帧）= O(5N × pixels)
      //   新: 1 次 FFmpeg 命令，所有操作在滤镜图中流式完成 = O(N × pixels)
      // 典型提速: 3-5 倍（200 帧 GIF 从 ~60s 降到 ~15s）
      let singleGifPipelineSucceeded = false;
      
      try {
        checkCancelled();
        
        let pipeOffsetX = Math.round(gifInfo.bounds.x);
        let pipeOffsetY = Math.round(gifInfo.bounds.y);
        const pipeGifW = Math.round(gifInfo.bounds.width);
        const pipeGifH = Math.round(gifInfo.bounds.height);
        const pipeCornerRadius = gifInfo.cornerRadius || 0;
        const pipeClipBounds = gifInfo.clipBounds;
        const pipeClipCornerRadius = gifInfo.clipCornerRadius || 0;
        const pipeImageFillInfo = gifInfo.imageFillInfo || { scaleMode: 'FILL' };
        
        // 检查源文件
        if (!fs.existsSync(gifInfo.path) || fs.statSync(gifInfo.path).size === 0) {
          throw new Error('源 GIF 文件不存在或为空');
        }
        
        // 优先 ffprobe 快速读取 GIF 元数据（失败才回退 identify）
        const pipeMeta = await getGifMetadataFast(gifInfo.path, { needTiming: true });
        const pipeOrigW = pipeMeta.width;
        const pipeOrigH = pipeMeta.height;
        let pipeTotalFrames = pipeMeta.frameCount || 1;
        let pipeOutputFps = pipeMeta.exactFps || 20;
        
        reportProgress(15, '正在构建 FFmpeg 合成管道...');

        // 基于有效时间线覆盖裁掉头尾无图层段，避免导出黑屏
        let pipeTrimStartFrame = 0;
        let pipeTrimEndFrame = Math.max(0, (pipeTotalFrames || 1) - 1);
        let applyPipeTrim = false;
        if (pipeTotalFrames > 1) {
          const effectiveTrim = getEffectiveTimelineTrimPercent();
          if (effectiveTrim.hasEditedCoverage) {
            const den = Math.max(1, pipeTotalFrames - 1);
            // 与 enable=between 的边界保持一致：start 用 ceil，end 用 floor
            // 避免 end 向上取整多带出一帧“全图层不可见”的黑屏尾帧
            const sf = Math.max(0, Math.ceil((effectiveTrim.start / 100) * den));
            const ef = Math.min(pipeTotalFrames - 1, Math.floor((effectiveTrim.end / 100) * den));
            if (ef >= sf) {
              pipeTrimStartFrame = sf;
              pipeTrimEndFrame = ef;
              applyPipeTrim = true;
            }
          }
        }
        const pipeOutputFrames = applyPipeTrim
          ? (pipeTrimEndFrame - pipeTrimStartFrame + 1)
          : pipeTotalFrames;

        const pipeSourceStats = fs.existsSync(gifInfo.path) ? fs.statSync(gifInfo.path) : null;
        const adaptivePipeMode = getAdaptiveProfile({
          preSizeMB: pipeSourceStats ? (pipeSourceStats.size / (1024 * 1024)) : 0,
          decisionSizeMB: Number.isFinite(gifInfo.sourceSizeMB) ? gifInfo.sourceSizeMB : null,
          frameCount: pipeOutputFrames || pipeTotalFrames || 0,
          hasVideoLayers: hasVideo
        });
        pipeOutputFps = Math.max(1, Math.min(pipeOutputFps, adaptivePipeMode.videoFpsCap));
        
        // ── 构建 FFmpeg 滤镜图 ──────────────────────────────────────
        const ffInputs = [];
        const filterParts = [];
        let inputIdx = 0;
        
        // 1. 准备底层（背景 + bottomLayer 合并为一张 PNG）
        const pipeBaseLayerPaths = [];
        if (frameBackground && frameBackground.a > 0) {
          const pipeBgPath = path.join(tempDir, 'pipe_bg.png');
          const bgColor = `rgba(${frameBackground.r},${frameBackground.g},${frameBackground.b},${frameBackground.a})`;
          await execAsync(`magick -size ${frameW}x${frameH} xc:"${bgColor}" "${pipeBgPath}"`, { timeout: 30000 });
          pipeBaseLayerPaths.push(pipeBgPath);
        }
        if (bottomLayerPath) pipeBaseLayerPaths.push(bottomLayerPath);
        
        const pipeBaseMergedPath = path.join(tempDir, 'pipe_base.png');
        await mergeStaticLayersToPng({
          layerPaths: pipeBaseLayerPaths,
          outputPath: pipeBaseMergedPath,
          width: frameW,
          height: frameH
        });
        
        // Input 0: 底层（循环静态图）
        ffInputs.push(`-loop 1 -framerate ${pipeOutputFps} -i "${pipeBaseMergedPath}"`);
        let prevStream = `${inputIdx}:v`;
        inputIdx++;
        
        // Input 1: GIF
        ffInputs.push(`-ignore_loop 0 -i "${gifInfo.path}"`);
        const gIdx = inputIdx++;
        
        // ── GIF 滤镜链：缩放 → 圆角 → 裁切 → 定位 ──
        let gifStream = `${gIdx}:v`;
        
        // 解析 imageTransform
        let pipeImageTransform = pipeImageFillInfo.imageTransform;
        if (typeof pipeImageTransform === 'string') {
          try { pipeImageTransform = JSON.parse(pipeImageTransform); } catch { pipeImageTransform = null; }
        }
        
        // 缩放/裁剪（基于 scaleMode）
        const pipeScaleFilters = [];
        
        if (pipeImageFillInfo.scaleMode === 'FIT') {
          pipeScaleFilters.push(`scale=${pipeGifW}:${pipeGifH}:force_original_aspect_ratio=decrease:flags=lanczos`);
          pipeScaleFilters.push(`pad=${pipeGifW}:${pipeGifH}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`);
        } else if (pipeImageFillInfo.scaleMode === 'CROP' && pipeImageTransform && Array.isArray(pipeImageTransform)) {
          const a = pipeImageTransform[0][0] || 1;
          const d = pipeImageTransform[1][1] || 1;
          const tx = pipeImageTransform[0][2] || 0;
          const ty = pipeImageTransform[1][2] || 0;
          const sw = Math.round(pipeGifW / a);
          const sh = Math.round(pipeGifH / d);
          const cx = Math.max(0, Math.round(tx * sw));
          const cy = Math.max(0, Math.round(ty * sh));
          pipeScaleFilters.push(`scale=${sw}:${sh}:flags=lanczos`);
          pipeScaleFilters.push(`crop=${pipeGifW}:${pipeGifH}:${cx}:${cy}`);
        } else {
          // FILL 模式
          const scaleX = pipeGifW / pipeOrigW;
          const scaleY = pipeGifH / pipeOrigH;
          const scale = Math.max(scaleX, scaleY);
          let sw = Math.round(pipeOrigW * scale);
          let sh = Math.round(pipeOrigH * scale);
          let cx, cy;
          
          if (pipeImageTransform && Array.isArray(pipeImageTransform)) {
            const a = pipeImageTransform[0][0] || 1;
            const d = pipeImageTransform[1][1] || 1;
            const tx = pipeImageTransform[0][2] || 0;
            const ty = pipeImageTransform[1][2] || 0;
            sw = Math.round(pipeOrigW * scale * (1 / a));
            sh = Math.round(pipeOrigH * scale * (1 / d));
            cx = Math.max(0, Math.min(Math.round(tx * sw), Math.max(0, sw - pipeGifW)));
            cy = Math.max(0, Math.min(Math.round(ty * sh), Math.max(0, sh - pipeGifH)));
          } else {
            cx = Math.max(0, Math.round((sw - pipeGifW) / 2));
            cy = Math.max(0, Math.round((sh - pipeGifH) / 2));
          }
          
          if (sw !== pipeOrigW || sh !== pipeOrigH || cx !== 0 || cy !== 0 || sw !== pipeGifW || sh !== pipeGifH) {
            pipeScaleFilters.push(`scale=${sw}:${sh}:flags=lanczos`);
            if (sw !== pipeGifW || sh !== pipeGifH) {
              pipeScaleFilters.push(`crop=${pipeGifW}:${pipeGifH}:${cx}:${cy}`);
            }
          }
        }
        
        // 构建 GIF 滤镜表达式
        let gifFilterExpr = pipeScaleFilters.length > 0 ? pipeScaleFilters.join(',') + ',' : '';
        gifFilterExpr += 'format=rgba';
        
        // 圆角遮罩
        let effectiveGifW = pipeGifW;
        let effectiveGifH = pipeGifH;
        
        if (pipeCornerRadius > 0) {
          const pipeMaskPath = path.join(tempDir, 'pipe_cr_mask.png');
          await execAsync(`magick -size ${pipeGifW}x${pipeGifH} xc:none -fill white -draw "roundrectangle 0,0 ${pipeGifW-1},${pipeGifH-1} ${pipeCornerRadius},${pipeCornerRadius}" "${pipeMaskPath}"`, { timeout: 30000 });
          
          ffInputs.push(`-loop 1 -framerate ${pipeOutputFps} -i "${pipeMaskPath}"`);
          const maskIdx = inputIdx++;
          
          filterParts.push(`[${gifStream}]${gifFilterExpr}[g_rgba]`);
          filterParts.push(`[${maskIdx}:v]alphaextract[cr_alpha]`);
          filterParts.push(`[g_rgba][cr_alpha]alphamerge[g_rounded]`);
          gifStream = 'g_rounded';
        } else {
          filterParts.push(`[${gifStream}]${gifFilterExpr}[g_rgba]`);
          gifStream = 'g_rgba';
        }
        
        // 裁切（clipBounds）
        if (pipeClipBounds) {
          const iL = Math.max(pipeOffsetX, pipeClipBounds.x);
          const iT = Math.max(pipeOffsetY, pipeClipBounds.y);
          const iR = Math.min(pipeOffsetX + effectiveGifW, pipeClipBounds.x + pipeClipBounds.width);
          const iB = Math.min(pipeOffsetY + effectiveGifH, pipeClipBounds.y + pipeClipBounds.height);
          const iW = Math.max(1, Math.round(iR - iL));
          const iH = Math.max(1, Math.round(iB - iT));
          const cX = Math.max(0, Math.round(iL - pipeOffsetX));
          const cY = Math.max(0, Math.round(iT - pipeOffsetY));
          
          if (iW > 0 && iH > 0) {
            filterParts.push(`[${gifStream}]crop=${iW}:${iH}:${cX}:${cY}[g_clipped]`);
            gifStream = 'g_clipped';
            
            if (pipeClipCornerRadius > 0) {
              const clipMaskPath = path.join(tempDir, 'pipe_clip_mask.png');
              await execAsync(`magick -size ${iW}x${iH} xc:none -fill white -draw "roundrectangle 0,0 ${iW-1},${iH-1} ${pipeClipCornerRadius},${pipeClipCornerRadius}" "${clipMaskPath}"`, { timeout: 30000 });
              
              ffInputs.push(`-loop 1 -framerate ${pipeOutputFps} -i "${clipMaskPath}"`);
              const clipMaskIdx = inputIdx++;
              filterParts.push(`[${clipMaskIdx}:v]alphaextract[clip_alpha]`);
              filterParts.push(`[${gifStream}][clip_alpha]alphamerge[g_clip_masked]`);
              gifStream = 'g_clip_masked';
            }
            
            pipeOffsetX = Math.round(iL);
            pipeOffsetY = Math.round(iT);
            effectiveGifW = iW;
            effectiveGifH = iH;
          }
        }
        
        // 定位到画布（pad）
        filterParts.push(`[${gifStream}]pad=${frameW}:${frameH}:${pipeOffsetX}:${pipeOffsetY}:color=black@0.0[g_pos]`);
        gifStream = 'g_pos';
        
        // Overlay GIF 到底层（支持时间线 enable）
        let gifEnableExpr = '';
        if (hasTimelineEdits && timelineData && timelineData[gifInfo.layerId] && pipeTotalFrames > 1) {
          const gifRange = timelineData[gifInfo.layerId];
          if (gifRange.start > 0 || gifRange.end < 100) {
            const pipeDen = Math.max(1, pipeTotalFrames - 1);
            const gsf = Math.max(0, Math.ceil((gifRange.start / 100) * pipeDen));
            const gef = Math.min(pipeTotalFrames - 1, Math.floor((gifRange.end / 100) * pipeDen));
            // 预计算帧区间，避免每帧做除法表达式导致性能下降
            gifEnableExpr = gef >= gsf
              ? `:enable='between(n\\,${gsf}\\,${gef})'`
              : `:enable='0'`;
          }
        }
        filterParts.push(`[${prevStream}][${gifStream}]overlay=0:0${gifEnableExpr}[composited]`);
        prevStream = 'composited';
        
        // 3. 顶层（staticLayers + annotationLayers + annotation，支持时间线控制）
        // 🕐 有时间线的图层需要单独作为 FFmpeg 输入（enable 表达式控制可见性）
        //    无时间线的图层合并为一张 PNG（减少 FFmpeg 输入数）
        const pipeHasTimelineOnLayer = (layerId) => {
          if (!hasTimelineEdits || !timelineData || !timelineData[layerId]) return false;
          const range = timelineData[layerId];
          return range.start > 0 || range.end < 100;
        };
        
        const pipeTopNoTimeline = [];
        const pipeTopWithTimeline = [];
        
        if (staticLayerPaths) {
          for (const sl of staticLayerPaths) {
            if (!fs.existsSync(sl.path)) continue;
            if (pipeHasTimelineOnLayer(sl.layerId)) {
              pipeTopWithTimeline.push(sl);
            } else {
              pipeTopNoTimeline.push(sl.path);
            }
          }
        }
        if (annotationLayerPaths) {
          for (const al of annotationLayerPaths) {
            if (!fs.existsSync(al.path)) continue;
            if (pipeHasTimelineOnLayer(al.layerId)) {
              pipeTopWithTimeline.push(al);
            } else {
              pipeTopNoTimeline.push(al.path);
            }
          }
        }
        if (annotationPath && fs.existsSync(annotationPath) && annotationLayerPaths.length === 0) {
          pipeTopNoTimeline.push(annotationPath);
        }
        
        // 先叠加无时间线的图层（合并为一张 PNG 后一次性 overlay）
        if (pipeTopNoTimeline.length > 0) {
          let pipeTopPath;
          if (pipeTopNoTimeline.length === 1) {
            pipeTopPath = pipeTopNoTimeline[0];
          } else {
            pipeTopPath = path.join(tempDir, 'pipe_top.png');
            let cmd = `magick -size ${frameW}x${frameH} xc:none`;
            for (const ol of pipeTopNoTimeline) cmd += ` "${ol}" -composite`;
            cmd += ` "${pipeTopPath}"`;
            await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
          }
          
          ffInputs.push(`-loop 1 -framerate ${pipeOutputFps} -i "${pipeTopPath}"`);
          const topIdx = inputIdx++;
          filterParts.push(`[${prevStream}][${topIdx}:v]overlay=0:0[with_top]`);
          prevStream = 'with_top';
        }
        
        // 再逐一叠加有时间线的图层（每层独立 FFmpeg 输入 + enable 表达式）
        for (let tli = 0; tli < pipeTopWithTimeline.length; tli++) {
          const tlLayer = pipeTopWithTimeline[tli];
          ffInputs.push(`-loop 1 -framerate ${pipeOutputFps} -i "${tlLayer.path}"`);
          const tlIdx = inputIdx++;
          
          const tlRange = timelineData[tlLayer.layerId];
          const pipeDen = Math.max(1, pipeTotalFrames - 1);
          const sf = Math.max(0, Math.ceil((tlRange.start / 100) * pipeDen));
          const ef = Math.min(pipeTotalFrames - 1, Math.floor((tlRange.end / 100) * pipeDen));
          const enableExpr = ef >= sf
            ? `:enable='between(n\\,${sf}\\,${ef})'`
            : `:enable='0'`;
          
          const next = `tl${tli}`;
          filterParts.push(`[${prevStream}][${tlIdx}:v]overlay=0:0${enableExpr}[${next}]`);
          prevStream = next;
          
        }
        
        if (applyPipeTrim) {
          const trimEndExclusive = pipeTrimEndFrame + 1;
          filterParts.push(`[${prevStream}]trim=start_frame=${pipeTrimStartFrame}:end_frame=${trimEndExclusive},setpts=PTS-STARTPTS[trimmed]`);
          prevStream = 'trimmed';
        }

        // 🚀 三步走：消除 split 内存瓶颈
        // 旧方案: split 缓冲全部帧到内存（178帧×860×1864×4×2 ≈ 2.3GB），导致超慢
        // 新方案: 合成→PNG序列（流式O(1)内存）→ 两阶段调色板 → GIF
        
        // ── Step 1: 合成滤镜图 → PNG 序列（流式，逐帧输出）──────────
        const filterComplex = filterParts.join(';');
        const pipeFramesDir = path.join(tempDir, 'pipe_frames');
        if (!fs.existsSync(pipeFramesDir)) fs.mkdirSync(pipeFramesDir, { recursive: true });
        const pipeTempGifPath = path.join(tempDir, 'pipe_output.gif');
        const framesArg = pipeOutputFrames > 0 ? `-frames:v ${pipeOutputFrames}` : '';
        const pipelineTimeout = Math.max(120000, (pipeOutputFrames || 200) * adaptivePipeMode.pipelinePerFrameMs);
        
        const pipeCompositeCmd = `ffmpeg -threads 0 ${ffInputs.join(' ')} -filter_complex "${filterComplex}" -map "[${prevStream}]" ${framesArg} -threads 0 -start_number 0 -y "${pipeFramesDir}/frame_%04d.png"`;
        
        console.log(`   🚀 单 GIF 管道 Step 1/2: ${ffInputs.length} 输入, ${pipeOutputFrames || '?'} 帧 → PNG 序列`);
        reportProgress(20, `正在合成帧 (流式)...`);
        await execAsync(pipeCompositeCmd, { maxBuffer: 200 * 1024 * 1024, timeout: pipelineTimeout });
        
        // ── Step 2: 两阶段调色板 → GIF ──────────────────────────────
        reportProgress(70, '正在生成调色板并编码 GIF...');
        const pipePalPath = path.join(tempDir, 'pipe_palette.png');
        
        await execAsync(`ffmpeg -threads 0 -framerate ${pipeOutputFps} -i "${pipeFramesDir}/frame_%04d.png" -vf "palettegen=max_colors=256:stats_mode=full" -threads 0 -y "${pipePalPath}"`,
          { maxBuffer: 50 * 1024 * 1024, timeout: Math.max(30000, adaptivePipeMode.paletteGenTimeoutMs) });
        
        await execAsync(`ffmpeg -threads 0 -framerate ${pipeOutputFps} -i "${pipeFramesDir}/frame_%04d.png" -i "${pipePalPath}" -lavfi "[0:v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle" -threads 0 -loop 0 -y "${pipeTempGifPath}"`,
          { maxBuffer: 200 * 1024 * 1024, timeout: Math.max(60000, adaptivePipeMode.paletteUseTimeoutMs) });
        
        // 异步清理临时 PNG
        setImmediate(() => { try { removeDirRecursive(pipeFramesDir); } catch(e){} });
        if (fs.existsSync(pipePalPath)) try { fs.unlinkSync(pipePalPath); } catch(e){}
        
        // 验证输出
        if (!fs.existsSync(pipeTempGifPath) || fs.statSync(pipeTempGifPath).size < 100) {
          throw new Error('FFmpeg 管道输出文件为空或过小');
        }
        
        reportProgress(85, '正在压缩优化...');
        
        // 🗜️ gifsicle 深度优化
        try {
          await execAsync('which gifsicle');
          const pipePreStats = fs.statSync(pipeTempGifPath);
          const gifsicleTimeout = Math.max(60000, Math.ceil(pipePreStats.size / (1024 * 1024)) * adaptivePipeMode.gifsicleTimeoutPerMbMs);
          const adaptivePipe = getAdaptiveProfile({
            preSizeMB: pipePreStats.size / (1024 * 1024),
            decisionSizeMB: Number.isFinite(gifInfo.sourceSizeMB) ? gifInfo.sourceSizeMB : null,
            frameCount: pipeOutputFrames || 0,
            hasVideoLayers: hasVideo
          });
          
          await execAsync(`gifsicle -O3 --lossy=${adaptivePipe.lossy} --no-conserve-memory --no-comments --no-names --no-extensions "${pipeTempGifPath}" -o "${outputPath}"`,
            { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
          
          if (fs.existsSync(pipeTempGifPath)) fs.unlinkSync(pipeTempGifPath);
          
          const pipePostStats = fs.statSync(outputPath);
          console.log(`   🗜️  gifsicle: ${(pipePreStats.size / 1024 / 1024).toFixed(2)} MB → ${(pipePostStats.size / 1024 / 1024).toFixed(2)} MB (节省 ${((1 - pipePostStats.size / pipePreStats.size) * 100).toFixed(1)}%)`);
        } catch (e) {
          if (!fs.existsSync(outputPath)) {
            fs.renameSync(pipeTempGifPath, outputPath);
          } else if (fs.existsSync(pipeTempGifPath)) {
            fs.unlinkSync(pipeTempGifPath);
          }
        }
        
        singleGifPipelineSucceeded = true;
        
      } catch (pipelineErr) {
        if (pipelineErr.message === 'GIF_EXPORT_CANCELLED' || (shouldCancel && shouldCancel())) {
          throw pipelineErr;
        }
        console.log(`   ⚠️  单 GIF FFmpeg 管道失败，回退到 ImageMagick: ${pipelineErr.message}`);
        if (pipelineErr.stderr) console.log(`   STDERR: ${pipelineErr.stderr.substring(0, 500)}`);
      }
      
      if (!singleGifPipelineSucceeded) {
      
      let offsetX = Math.round(gifInfo.bounds.x);
      let offsetY = Math.round(gifInfo.bounds.y);
      let gifW = Math.round(gifInfo.bounds.width);
      let gifH = Math.round(gifInfo.bounds.height);
      const cornerRadius = gifInfo.cornerRadius || 0;
      const clipBounds = gifInfo.clipBounds;
      const clipCornerRadius = gifInfo.clipCornerRadius || 0;
      const imageFillInfo = gifInfo.imageFillInfo || { scaleMode: 'FILL' };
      
      // 修复: 分步处理，使用 imageTransform 还原用户的自定义裁剪位置
      const tempResizedGif = path.join(tempDir, 'resized.gif');
      
      // 检查输入文件是否存在且不为空
      if (!fs.existsSync(gifInfo.path) || fs.statSync(gifInfo.path).size === 0) {
        throw new Error(`输入 GIF 文件不存在或为空: ${gifInfo.path}`);
      }

      // 获取原始 GIF 的尺寸
      let originalW, originalH;
      try {
        const meta = await getGifMetadataFast(gifInfo.path, { needTiming: false });
        originalW = meta.width;
        originalH = meta.height;
      } catch (e) {
        // 检查是否是损坏的 GIF 文件
        if (e.message && e.message.includes('improper image header')) {
          try {
            if (fs.existsSync(gifInfo.path)) fs.unlinkSync(gifInfo.path);
            const metaPath = gifInfo.path.replace(/\.(gif|mov|mp4)$/, '.meta.json');
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
          } catch (deleteError) {}
          throw new Error(`GIF 文件已损坏，请重新同步: ${path.basename(gifInfo.path)}`);
        }
        throw e;
      }

      // 根据 scaleMode 和 imageTransform 计算缩放和裁剪参数
      let resizeCmd;
      if (imageFillInfo.scaleMode === 'FIT') {
        // FIT: 保持比例缩放以适应容器 (可能留白)
        resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${gifW}x${gifH}" -gravity center -background none -extent ${gifW}x${gifH} "${tempResizedGif}"`;
      } else if (imageFillInfo.scaleMode === 'CROP') {
        // CROP 模式：使用 imageTransform 的缩放系数
        let imageTransform = imageFillInfo.imageTransform;
        if (typeof imageTransform === 'string') {
          try {
            imageTransform = JSON.parse(imageTransform);
          } catch (e) {
            imageTransform = null;
          }
        }
        
        if (imageTransform && Array.isArray(imageTransform)) {
          const transform = imageTransform;
          const a = transform[0][0] || 1;
          const d = transform[1][1] || 1;
          const tx = transform[0][2] || 0;
          const ty = transform[1][2] || 0;
          
          // Figma 的 imageTransform: 从容器空间到图像空间的变换
          // a, d 表示容器在图像中的相对大小
          // 实际图像显示尺寸 = 容器尺寸 / a（或 d）
          const scaledW = Math.round(gifW / a);
          const scaledH = Math.round(gifH / d);
          
          // 计算裁剪偏移（基于缩放后的尺寸）
          const cropOffsetX = Math.round(tx * scaledW);
          const cropOffsetY = Math.round(ty * scaledH);
          
          // 缩放 -> 裁剪 -> 放置在透明画布上
          resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${scaledW}x${scaledH}!" -crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY} +repage "${tempResizedGif}"`;
        } else {
          // 没有 imageTransform，保持原始尺寸，居中放置
          resizeCmd = `magick "${gifInfo.path}" -coalesce -gravity center -background none -extent ${gifW}x${gifH} "${tempResizedGif}"`;
        }
      } else {
        // FILL 模式 (默认): 使用 Cover 缩放，确保填满容器
        const scaleX = gifW / originalW;
        const scaleY = gifH / originalH;
        const scale = Math.max(scaleX, scaleY); // Cover: 取较大的缩放比例
        
        let scaledW = Math.round(originalW * scale);
        let scaledH = Math.round(originalH * scale);
        
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
          
          // 计算裁剪偏移
          cropOffsetX = Math.round(tx * finalScaledW);
          cropOffsetY = Math.round(ty * finalScaledH);
          
          // 更新 scaledW 和 scaledH
          scaledW = finalScaledW;
          scaledH = finalScaledH;
        } else {
          // 没有 imageTransform，使用居中裁剪
          cropOffsetX = Math.round((scaledW - gifW) / 2);
          cropOffsetY = Math.round((scaledH - gifH) / 2);
        }
        
        // 确保裁剪偏移在有效范围内
        cropOffsetX = Math.max(0, Math.min(cropOffsetX, scaledW - gifW));
        cropOffsetY = Math.max(0, Math.min(cropOffsetY, scaledH - gifH));
        
        // 先缩放，然后裁剪
        resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${scaledW}x${scaledH}!" -crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY} +repage "${tempResizedGif}"`;
      }

      // 🔍 在处理前验证源 GIF 文件
      if (!fs.existsSync(gifInfo.path)) {
        throw new Error(`源 GIF 文件不存在: ${gifInfo.path}`);
      }
      
      const sourceStats = fs.statSync(gifInfo.path);
      
      // 🚀 优化：如果源 GIF 尺寸和目标尺寸完全相同，且不需要裁剪，直接复制文件跳过 ImageMagick 处理
      // 这对于大型 GIF（数百帧）可以节省数分钟的处理时间
      const needsProcessing = !(originalW === gifW && originalH === gifH && 
                                 imageFillInfo.scaleMode === 'FILL' && 
                                 (!imageFillInfo.imageTransform || 
                                  (typeof imageFillInfo.imageTransform === 'string' && 
                                   imageFillInfo.imageTransform === '[[1,0,0],[0,1,0]]')));
      
      if (!needsProcessing) {
        fs.copyFileSync(gifInfo.path, tempResizedGif);
      } else {
        // 对于大尺寸或大文件，增加 buffer 和超时
        // 使用容器尺寸 (gifW, gifH) 而不是 scaledW/scaledH，因为后者在某些模式下未定义
        const pixelCount = gifW * gifH;
        const isLarge = pixelCount > 2000000 || sourceStats.size > 10 * 1024 * 1024; // 2MP 或 10MB
        const bufferSize = isLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
        const timeout = isLarge ? 600000 : 300000; // 10分钟 vs 5分钟
        
        if (isLarge) {
          resizeCmd = resizeCmd.replace('magick "', 'magick -limit memory 4GB -limit disk 8GB -limit area 2GB -limit map 4GB -limit thread 4 "');
        }
        
        try {
          await execAsync(resizeCmd, { maxBuffer: bufferSize, timeout: timeout });
        } catch (e) {
          console.error(`   ❌ 步骤1失败: 调整尺寸错误`);
          console.error(`   命令: ${resizeCmd}`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);

          // 关键降级：ImageMagick 在超大 GIF 上可能触发 cache resources exhausted。
          // 此时自动回退到 FFmpeg 两阶段调色板 resize，避免直接失败。
          if (isMagickCacheExhausted(e)) {
            console.warn('   ⚠️  检测到 ImageMagick 缓存耗尽，自动切换 FFmpeg 降级处理...');
            const fallbackVf = buildResizeVfForImageFill({
              imageFillInfo,
              originalW,
              originalH,
              gifW,
              gifH
            });
            const fallbackPalette = path.join(tempDir, `resize_fallback_palette_${Date.now()}.png`);
            try {
              await execAsync(
                `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "${fallbackVf},palettegen=max_colors=256:stats_mode=full" -y "${fallbackPalette}"`,
                { maxBuffer: 80 * 1024 * 1024, timeout: timeout }
              );
              await execAsync(
                `ffmpeg -vsync 0 -threads 0 -i "${gifInfo.path}" -i "${fallbackPalette}" -lavfi "${fallbackVf}[v];[v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle" -y "${tempResizedGif}"`,
                { maxBuffer: 220 * 1024 * 1024, timeout: timeout }
              );
              try { if (fs.existsSync(fallbackPalette)) fs.unlinkSync(fallbackPalette); } catch (_) {}
              console.log('   ✅ FFmpeg 降级 resize 成功，已绕过 ImageMagick 缓存瓶颈');
              // 降级成功，不再抛错
              e = null;
            } catch (fallbackErr) {
              try { if (fs.existsSync(fallbackPalette)) fs.unlinkSync(fallbackPalette); } catch (_) {}
              if (fallbackErr.stderr) {
                fallbackErr.message += `\nFFmpeg STDERR: ${fallbackErr.stderr}`;
              }
              throw fallbackErr;
            }
          }

          if (!e) {
            // 已通过 FFmpeg 降级成功
          } else {
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
      }
      
      // 如果有圆角，应用圆角遮罩
      let roundedGif = tempResizedGif;
      if (cornerRadius > 0) {
        const tempRoundedGif = path.join(tempDir, 'rounded.gif');
        const maskPath = path.join(tempDir, 'mask.png');

        // 检测源 GIF 大小以确定超时时间
        const roundSourceStats = fs.statSync(tempResizedGif);
        const roundPixelCount = gifW * gifH;
        const roundIsLarge = roundPixelCount > 2000000 || roundSourceStats.size > 10 * 1024 * 1024;
        const roundBufferSize = roundIsLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
        const roundTimeout = roundIsLarge ? 600000 : 300000; // 大文件 10 分钟 vs 5分钟
        
        if (roundIsLarge) {
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
        
        // 计算GIF区域和裁切容器的交集（可见区域）
        const intersectLeft = Math.max(offsetX, clipBounds.x);
        const intersectTop = Math.max(offsetY, clipBounds.y);
        const intersectRight = Math.min(offsetX + gifW, clipBounds.x + clipBounds.width);
        const intersectBottom = Math.min(offsetY + gifH, clipBounds.y + clipBounds.height);
        
        const intersectW = Math.max(0, intersectRight - intersectLeft);
        const intersectH = Math.max(0, intersectBottom - intersectTop);
        
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
            
            // 如果裁切容器有圆角，应用该圆角 (父级圆角)
            if (clipCornerRadius > 0) {
              const tempClipRoundedGif = path.join(tempDir, 'clip_rounded.gif');
              const clipMaskPath = path.join(tempDir, 'clip_mask.png');
              
              // 创建父级圆角遮罩 (基于新的尺寸 gifW x gifH)
              const createClipMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${clipCornerRadius},${clipCornerRadius}" "${clipMaskPath}"`;
              await execAsync(createClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
              
              const applyClipMaskCmd = `magick "${processedGif}" -coalesce null: \\( "${clipMaskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempClipRoundedGif}"`;
              await execAsync(applyClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
              processedGif = tempClipRoundedGif;
            }
          } catch (e) {
            console.error(`   ❌ 步骤1.6失败: 应用裁切错误`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        }
      }
      
      
      const tempPositionedGif = path.join(tempDir, 'positioned.gif');
      
      const extentCmd = `magick -size ${frameW}x${frameH} xc:none null: \\( "${processedGif}" -coalesce \\) -geometry +${offsetX}+${offsetY} -layers Composite "${tempPositionedGif}"`;

      try {
        await execAsync(extentCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      } catch (e) {
        console.error(`   ❌ 步骤2失败: 定位/合成错误`);
        console.error(`   命令: ${extentCmd}`);
        if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
        if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
        throw e;
      }
      
      reportProgress(30, '正在合成图层 (ImageMagick)...');
      
      // 🚀 合成所有图层：收集所有需要叠加的静态 PNG 层，一次性合成到 GIF
      // 避免逐层 magick 调用（每次都要解码+重编码整个 GIF）
      let baseLayer = tempPositionedGif;
      
      // 收集所有需要在 GIF 下面的静态层（背景色 + bottomLayer）
      const underLayers = [];
      if (frameBackground && frameBackground.a > 0) {
        const tempBgPath = path.join(tempDir, 'background.png');
        const bgColor = `rgba(${frameBackground.r},${frameBackground.g},${frameBackground.b},${frameBackground.a})`;
        await execAsync(`magick -size ${frameW}x${frameH} xc:"${bgColor}" "${tempBgPath}"`, { maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
        underLayers.push(tempBgPath);
      }
      if (bottomLayerPath) {
        underLayers.push(bottomLayerPath);
      }
      
      // 如果有下层，合并为一张底图后一次叠加到 GIF
      if (underLayers.length > 0) {
        const tempWithGifPath = path.join(tempDir, 'with_gif.gif');
        // 先合并所有底层为单张 PNG（避免对 GIF 做多次解码-重编码）
        let basePng;
        if (underLayers.length === 1) {
          basePng = underLayers[0];
        } else {
          basePng = path.join(tempDir, 'base_merged.png');
          let mergeCmd = `magick "${underLayers[0]}"`;
          for (let i = 1; i < underLayers.length; i++) mergeCmd += ` "${underLayers[i]}" -composite`;
          mergeCmd += ` "${basePng}"`;
          await execAsync(mergeCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
        }
        // 一次性合成底图 + GIF
        const gifCmd = `magick "${basePng}" -coalesce null: \\( "${tempPositionedGif}" -coalesce \\) -compose over -layers composite "${tempWithGifPath}"`;
        await execAsync(gifCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
        baseLayer = tempWithGifPath;
      }
      
      // 收集所有需要在 GIF 上面的静态层
      const overLayers = [];
      if (staticLayerPaths) {
        for (const sl of staticLayerPaths) {
          if (fs.existsSync(sl.path)) overLayers.push(sl.path);
        }
      }
      if (annotationLayerPaths) {
        for (const al of annotationLayerPaths) {
          if (fs.existsSync(al.path)) overLayers.push(al.path);
        }
      }
      if (annotationPath && fs.existsSync(annotationPath) && annotationLayerPaths.length === 0) {
        overLayers.push(annotationPath);
      }
      
      // 如果有上层，先合并为单张 PNG，再一次叠加到 GIF
      if (overLayers.length > 0) {
        let topPng;
        if (overLayers.length === 1) {
          topPng = overLayers[0];
        } else {
          // 合并所有上层为一张透明 PNG
          topPng = path.join(tempDir, 'top_merged.png');
          await mergeStaticLayersToPng({
            layerPaths: overLayers,
            outputPath: topPng,
            width: frameW,
            height: frameH
          });
        }
        const compositeCmd = `magick "${baseLayer}" -coalesce null: \\( "${topPng}" \\) -layers composite -loop 0 "${outputPath}"`;
        try {
          await execAsync(compositeCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
        } catch (e) {
          if (isMagickDecodeDelegateMissing(e)) {
            console.warn(`   ⚠️  ImageMagick 缺少解码 delegate，回退 FFmpeg 叠层合成: ${e.message}`);
            await composeGifWithOverlayViaFfmpeg({
              baseGifPath: baseLayer,
              overlayPath: topPng,
              outputGifPath: outputPath
            });
          } else {
            throw e;
          }
        }
      } else {
        // 没有上层，直接设置循环并输出
        const outputCmd = `magick "${baseLayer}" -loop 0 "${outputPath}"`;
        await execAsync(outputCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      }
      
      // 🗜️ GIF 压缩优化（仅 gifsicle）
      // 预处理阶段已完成 FFmpeg 帧差分编码（stats_mode=full + diff_mode=rectangle）
      // 这里只需 gifsicle 做像素级透明 + LZW 优化，不再重复 FFmpeg 重编码
      reportProgress(90, '正在压缩优化...');
      
      try {
        await execAsync('which gifsicle');
        const preStats = fs.statSync(outputPath);
        const preSizeMB = (preStats.size / 1024 / 1024).toFixed(2);
        const adaptiveFinal = getAdaptiveProfile({
          preSizeMB: preStats.size / (1024 * 1024),
          decisionSizeMB: Number.isFinite(gifInfo.sourceSizeMB) ? gifInfo.sourceSizeMB : null,
          frameCount: typeof totalOutputFrames === 'number' ? totalOutputFrames : 0,
          hasVideoLayers: hasVideo
        });
        const gifsicleTimeout = Math.max(60000, Math.ceil(preStats.size / (1024 * 1024)) * adaptiveFinal.gifsicleTimeoutPerMbMs);
        
        const tempGifsicle = outputPath + '.gsopt.gif';
        await execAsync(`gifsicle -O3 --lossy=${adaptiveFinal.lossy} --no-conserve-memory --no-comments --no-names --no-extensions "${outputPath}" -o "${tempGifsicle}"`, 
          { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
        
        const postStats = fs.statSync(tempGifsicle);
        if (postStats.size < preStats.size) {
          fs.unlinkSync(outputPath);
          fs.renameSync(tempGifsicle, outputPath);
          console.log(`   🗜️  gifsicle: ${preSizeMB} MB → ${(postStats.size / 1024 / 1024).toFixed(2)} MB (节省 ${((1 - postStats.size / preStats.size) * 100).toFixed(1)}%)`);
        } else {
          fs.unlinkSync(tempGifsicle);
        }
      } catch (e) {
        // gifsicle 不可用，跳过
      }
      
      // 单 GIF 路径的 100% 已在 composeAnnotatedGif 返回前通过 reportProgress(100) 发送
      } // end of if (!singleGifPipelineSucceeded) — ImageMagick 回退路径
    } else {
      // 多个 GIF：逐帧提取和合成（单 GIF 已在上方分支通过 FFmpeg 管道处理）
      console.log(`\n🎨 多 GIF 模式 - 逐帧提取合成 (${gifPaths.length} 个 GIF)...`);
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
        // ⚠️ 跳过已在前面 Promise.all 中处理过的文件（路径在 tempDir 内说明已经处理过了）
        const alreadyProcessed = gifInfo.path.startsWith(tempDir);
        const ext = path.extname(gifInfo.path).toLowerCase();
        if (!alreadyProcessed && (ext === '.mov' || ext === '.mp4')) {
            const tempProcessedGif = path.join(tempDir, `processed_multi_${i}.gif`);
            const multiVideoSource = await buildHalfScaleVideo(gifInfo.path, `multi_${i}`);
            const videoStatsMulti = fs.statSync(multiVideoSource);
            const adaptiveMulti = getAdaptiveProfile({
              preSizeMB: videoStatsMulti.size / (1024 * 1024),
              decisionSizeMB: Number.isFinite(gifInfo.sourceSizeMB) ? gifInfo.sourceSizeMB : null,
              hasVideoLayers: true
            });
            
            // 🚀 两阶段调色板（与主预处理流程一致）
            const tempPaletteMulti = path.join(tempDir, `palette_multi_${i}.png`);
            try {
                const vfBase = `fps=${adaptiveMulti.videoFpsCap},`;
                await execAsync(`ffmpeg -threads 0 -i "${multiVideoSource}" -vf "${vfBase}palettegen=max_colors=256:stats_mode=full" -y "${tempPaletteMulti}"`, {
                  timeout: Math.max(30000, adaptiveMulti.paletteGenTimeoutMs)
                });
                const lavfi = `fps=${adaptiveMulti.videoFpsCap}[v];[v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle`;
                await execAsync(`ffmpeg -vsync 0 -threads 0 -i "${multiVideoSource}" -i "${tempPaletteMulti}" -lavfi "${lavfi}" -threads 0 "${tempProcessedGif}" -y`, {
                  timeout: Math.max(60000, adaptiveMulti.paletteUseTimeoutMs)
                });
                if (fs.existsSync(tempPaletteMulti)) fs.unlinkSync(tempPaletteMulti);
                gifInfo.path = tempProcessedGif;
            } catch (e) {
                throw new Error(`无法处理文件: ${path.basename(gifInfo.path)}`);
            }
        }
        
        const gifMeta = await getGifMetadataFast(gifInfo.path, { needTiming: true });
        const frameCount = gifMeta.frameCount || 1;
        const totalDuration = gifMeta.totalDuration || 0;
        const exactFps = gifMeta.exactFps || 20;
        // 内部帧索引用的整数延迟（仅用于帧采样计算，不影响输出 fps）
        const intDelay = gifMeta.delay || 5;
        
        gifInfoArray.push({
          frameCount,
          delay: intDelay,
          exactFps,
          totalDuration
        });
        
        
      }
      
      // 找到最长的 GIF 时长（这将是输出GIF的总时长）
      const maxDuration = Math.max(...gifInfoArray.map(g => g.totalDuration));
      
      // 使用最高精确 fps 对应的延迟（确保能捕捉最快 GIF 的所有帧）
      const maxExactFps = Math.max(...gifInfoArray.map(g => g.exactFps));
      const outputDelay = Math.max(2, Math.round(100 / maxExactFps));
      
      // 计算需要生成的总帧数（基于最长时长和输出延迟）
      const totalSourceFrames = Math.ceil((maxDuration * 100) / outputDelay);
      
      // 🎬 时间线裁剪：只导出所有图层覆盖范围内的帧
      // 找到所有图层中最早的 start 和最晚的 end
      let trimStartPercent = 0;
      let trimEndPercent = 100;
      
      if (hasTimelineEdits && timelineData) {
        const effectiveTrim = getEffectiveTimelineTrimPercent();
        if (effectiveTrim.hasEditedCoverage) {
          trimStartPercent = effectiveTrim.start;
          trimEndPercent = effectiveTrim.end;
        }
      }
      
      // 将百分比转换为帧索引
      // 与图层 enable 逻辑保持一致，避免尾帧越界导致黑屏
      const trimStartFrame = Math.ceil((trimStartPercent / 100) * (totalSourceFrames - 1));
      const trimEndFrame = Math.floor((trimEndPercent / 100) * (totalSourceFrames - 1));
      const totalOutputFrames = Math.max(1, trimEndFrame - trimStartFrame + 1);
      
      const exportSourceTotalBytes = gifPaths.reduce((acc, info) => acc + ((Number(info.sourceSizeMB) || 0) * 1024 * 1024), 0);
      const exportAdaptiveProfile = getAdaptiveProfile({
        preSizeMB: exportSourceTotalBytes / (1024 * 1024),
        decisionSizeMB: exportSourceTotalBytes / (1024 * 1024),
        frameCount: totalOutputFrames,
        hasVideoLayers: hasVideo
      });
      const exportOutputFps = Math.max(1, Math.min(maxExactFps, exportAdaptiveProfile.videoFpsCap));

      // 裁剪后的实际时长
      const trimmedDuration = (totalOutputFrames * outputDelay) / 100;
      
      console.log(`   输出: ${totalOutputFrames} 帧, 延迟=${outputDelay}/100s, 时长=${trimmedDuration.toFixed(2)}s, 目标FPS=${exportOutputFps}${trimStartPercent > 0 || trimEndPercent < 100 ? ` (裁剪 ${trimStartPercent.toFixed(0)}-${trimEndPercent.toFixed(0)}%)` : ''}`);
      
      // 第二步：为每个 GIF 提取帧到单独的文件夹
      endStep('Step 1 分析GIF');
      startStep('Step 2 提取帧');
      console.log(`\n   第 2 步：提取所有 GIF 的帧 (并行处理)...`);
      reportProgress(10, '正在提取 GIF 原始帧...');
      
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
          } catch (e) {
            imageFillInfo.imageTransform = null;
          }
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
          const meta = await getGifMetadataFast(gifInfo.path, { needTiming: false });
          originalW = meta.width;
          originalH = meta.height;
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
        
        
        
        // 🚀 根据 scaleMode 构建缩放滤镜，然后统一使用两阶段调色板执行
        // 旧方案: FFmpeg 默认 GIF 编码器无帧差分 → resize 后体积膨胀 3-4x（25MB→90MB）
        // 新方案: 两阶段调色板 + diff_mode=rectangle → resize 后体积不膨胀
        let resizeVf = null;
        
        if (imageFillInfo.scaleMode === 'FIT') {
          resizeVf = `scale=${gifW}:${gifH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${gifW}:${gifH}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
        } else if (imageFillInfo.scaleMode === 'CROP') {
          if (imageFillInfo.imageTransform && Array.isArray(imageFillInfo.imageTransform)) {
            const transform = imageFillInfo.imageTransform;
            const a = transform[0][0] || 1;
            const d = transform[1][1] || 1;
            const tx = transform[0][2] || 0;
            const ty = transform[1][2] || 0;
            const scaledW = Math.round(gifW / a);
            const scaledH = Math.round(gifH / d);
            const cropOffsetX = Math.max(0, Math.round(tx * scaledW));
            const cropOffsetY = Math.max(0, Math.round(ty * scaledH));
            resizeVf = `scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}`;
          } else {
            const cropW = Math.min(originalW, gifW);
            const cropH = Math.min(originalH, gifH);
            const cropX = Math.max(0, Math.round((originalW - cropW) / 2));
            const cropY = Math.max(0, Math.round((originalH - cropH) / 2));
            const padX = Math.max(0, Math.round((gifW - cropW) / 2));
            const padY = Math.max(0, Math.round((gifH - cropH) / 2));
            resizeVf = `crop=${cropW}:${cropH}:${cropX}:${cropY},pad=${gifW}:${gifH}:${padX}:${padY}:color=black@0`;
          }
        } else {
          // FILL 模式：Cover 缩放填满容器
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
            scaledW = Math.round(originalW * scale * (1 / a));
            scaledH = Math.round(originalH * scale * (1 / d));
            cropOffsetX = Math.round(tx * scaledW);
            cropOffsetY = Math.round(ty * scaledH);
          } else {
            cropOffsetX = Math.round((scaledW - gifW) / 2);
            cropOffsetY = Math.round((scaledH - gifH) / 2);
          }
          
          cropOffsetX = Math.max(0, Math.min(cropOffsetX, Math.max(0, scaledW - gifW)));
          cropOffsetY = Math.max(0, Math.min(cropOffsetY, Math.max(0, scaledH - gifH)));
          resizeVf = `scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}`;
        }
        
        // 无变换无缩放时跳过 resize（避免重复二次调色板编码）
        const hasImageTransform = !!(imageFillInfo.imageTransform && Array.isArray(imageFillInfo.imageTransform));
        if (!hasImageTransform && originalW === gifW && originalH === gifH) {
          resizeVf = null;
        }

        // 🚀 统一执行两阶段调色板 resize
        // 阶段 1: 分析帧间差异生成最优调色板（1 palette entry 保留透明色）
        // 阶段 2: 用调色板 + 帧差分编码渲染 GIF（diff_mode=rectangle 只编码变化区域）
        if (resizeVf) {
          const rpPath = path.join(tempDir, `gif${i}_rpal.png`);
          try {
            await execAsync(`ffmpeg -threads 0 -i "${gifInfo.path}" -vf "${resizeVf},palettegen=max_colors=256:stats_mode=full" -y "${rpPath}"`,
              { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
            await execAsync(`ffmpeg -vsync 0 -threads 0 -i "${gifInfo.path}" -i "${rpPath}" -lavfi "${resizeVf}[v];[v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle" -y "${tempResizedGif}"`,
              { maxBuffer: 200 * 1024 * 1024, timeout: execOptions.timeout });
            if (fs.existsSync(rpPath)) try { fs.unlinkSync(rpPath); } catch(e){}
            console.log(`      ✅ GIF ${i+1} resize 两阶段调色板完成`);
          } catch (palErr) {
            console.warn(`      ⚠️  两阶段 resize 失败，回退单步: ${palErr.message}`);
            await execAsync(`ffmpeg -threads 0 -i "${gifInfo.path}" -vf "${resizeVf}" -y "${tempResizedGif}"`,
              { maxBuffer: 200 * 1024 * 1024, timeout: execOptions.timeout });
          }
          sourceGif = tempResizedGif;
          needsResize = false;
        }
        
        // 如果有圆角，应用圆角遮罩
        if (cornerRadius > 0) {
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
          } catch (e) {
            console.error(`   ❌ 应用圆角遮罩失败 (GIF ${i+1})`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        }
        
        // 如果有裁切，应用裁切
        if (clipBounds) {
          
          // 计算GIF区域和裁切容器的交集（可见区域）
          const intersectLeft = Math.max(offsetX, clipBounds.x);
          const intersectTop = Math.max(offsetY, clipBounds.y);
          const intersectRight = Math.min(offsetX + gifW, clipBounds.x + clipBounds.width);
          const intersectBottom = Math.min(offsetY + gifH, clipBounds.y + clipBounds.height);
          
          const intersectW = Math.max(0, intersectRight - intersectLeft);
          const intersectH = Math.max(0, intersectBottom - intersectTop);
          
          
          
          if (intersectW === 0 || intersectH === 0) {
            console.warn(`            ⚠️  GIF完全被裁切，不可见`);
            // GIF完全被裁切掉了，保持原样
          } else {
            // 计算交集相对于GIF的位置（裁切起点）
            const cropX = Math.round(intersectLeft - offsetX);
            const cropY = Math.round(intersectTop - offsetY);
            const cropW = Math.round(intersectW);
            const cropH = Math.round(intersectH);
            
            
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
              
              // 如果裁切容器有圆角，应用该圆角 (父级圆角)
              if (clipCornerRadius > 0) {
                const tempClipRoundedGif = path.join(tempDir, `gif${i}_clip_rounded.gif`);
                const clipMaskPath = path.join(tempDir, `gif${i}_clip_mask.png`);
                
                // 创建父级圆角遮罩 (基于新的尺寸 gifW x gifH)
                const createClipMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${clipCornerRadius},${clipCornerRadius}" "${clipMaskPath}"`;
                await execAsync(createClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
                
                const applyClipMaskCmd = `magick "${sourceGif}" -coalesce null: \\( "${clipMaskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempClipRoundedGif}"`;
                await execAsync(applyClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
                sourceGif = tempClipRoundedGif;
              }
            } catch (e) {
              console.error(`   ❌ 应用裁切失败 (GIF ${i+1})`);
              if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
              if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
              throw e;
            }
          }
        }
        
        // 🚀 使用 FFmpeg 提取帧并定位到画布
        // pad 语法: width:height:x:y:color
        // -start_number 0 确保从 frame_0000.png 开始
        const extractCmd = `ffmpeg -i "${sourceGif}" -vf "pad=${frameW}:${frameH}:${offsetX}:${offsetY}:color=black@0" -start_number 0 -y "${framesDir}/frame_%04d.png"`;
        
        try {
          await execAsync(extractCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 180000 });
        } catch (e) {
          
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
        
        return { 
          dir: framesDir, 
          sourceGifPath: sourceGif,    // 🚀 处理后的 GIF 路径（用于 FFmpeg 管道优化）
          finalOffsetX: offsetX,       // 🚀 最终画布偏移（裁切后可能变化）
          finalOffsetY: offsetY,
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
        });
      }
      
      // 按 z-index 排序（从小到大，即从底层到顶层）
      allLayers.sort((a, b) => a.zIndex - b.zIndex);
      
      console.log(`   ✅ 图层: ${allLayers.length} 层`);
      
      endStep('Step 3 构建图层');
      
      // 🎨 创建背景层 (两条路径都需要，提前创建)
      let backgroundPath = null;
      if (frameBackground && frameBackground.a > 0) {
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
      
      // 🚀🚀🚀 FFmpeg 管道优化：将 Step 4（逐帧合成）+ Step 6（GIF 编码）合并为单条 FFmpeg 命令
      // 对比逐帧 ImageMagick 方案：
      //   旧: N 次 magick 进程启动 + N 次 PNG 读/写 + 单独 FFmpeg 编码 = O(5N × pixels)
      //   新: 1 次 FFmpeg 进程, 静态层只读 1 次, 无中间 PNG = O(2N × pixels)
      // 对 2 倍尺寸导出，将耗时从约 4x 降低到约 2x
      
      let ffmpegPipelineSucceeded = false;
      
      try {
        startStep('Step 4 FFmpeg管道合成');
        reportProgress(20, '正在构建 FFmpeg 合成管道...');
        
        const outputFps = exportOutputFps;
        
        // ── 1. 分离图层组 ──────────────────────────────────────────────
        // 将所有图层分为三组: base (GIF 下方), mid (GIF 层 + 穿插的静态层), top (GIF 上方)
        const gifLayers = allLayers.filter(l => l.type === 'gif');
        const lowestGifZ = Math.min(...gifLayers.map(l => l.zIndex));
        const highestGifZ = Math.max(...gifLayers.map(l => l.zIndex));
        
        // 检查 top 层是否有时间线编辑（如果有则不能预合并，需要单独作为 FFmpeg 输入）
        const hasTimelineOnLayer = (layerId) => {
          if (!hasTimelineEdits || !timelineData || !timelineData[layerId]) return false;
          const range = timelineData[layerId];
          return range.start > 0 || range.end < 100;
        };
        
        // base: bg + bottom + static below GIF (无时间线的)
        const basePaths = [];
        if (backgroundPath) basePaths.push(backgroundPath);
        if (bottomLayerPath) basePaths.push(bottomLayerPath);
        
        // top: static/annotation above GIF + legacy annotation (无时间线的)
        const topPaths = [];
        
        // 有时间线的 static/annotation 层需要单独处理
        const timelineStaticLayers = [];
        
        for (const layer of allLayers) {
          if (layer.type === 'gif') continue;
          
          const hasTimeline = hasTimelineOnLayer(layer.layerId);
          
          if (layer.zIndex < lowestGifZ) {
            if (hasTimeline) {
              timelineStaticLayers.push(layer);
            } else {
              basePaths.push(layer.path);
            }
          } else if (layer.zIndex > highestGifZ) {
            if (hasTimeline) {
              timelineStaticLayers.push(layer);
            } else {
              topPaths.push(layer.path);
            }
          } else {
            // 在 GIF 层之间的静态层，总是作为单独输入
            timelineStaticLayers.push(layer);
          }
        }
        
        // Legacy annotation (兼容模式)
        if (annotationPath && (!annotationLayers || annotationLayers.length === 0)) {
          topPaths.push(annotationPath);
        }
        
        // ── 2. 预合并 base 层和 top 层 ─────────────────────────────────
        const baseMergedPath = path.join(tempDir, 'ffpipe_base.png');
        await mergeStaticLayersToPng({
          layerPaths: basePaths,
          outputPath: baseMergedPath,
          width: frameW,
          height: frameH
        });
        
        let topMergedPath = null;
        if (topPaths.length > 0) {
          topMergedPath = path.join(tempDir, 'ffpipe_top.png');
          await mergeStaticLayersToPng({
            layerPaths: topPaths,
            outputPath: topMergedPath,
            width: frameW,
            height: frameH
          });
        }
        
        // ── 3. 构建 FFmpeg 滤镜图 ──────────────────────────────────────
        const ffInputs = [];
        const filterParts = [];
        let inputIdx = 0;
        
        // Input 0: base merged (循环静态图)
        ffInputs.push(`-loop 1 -framerate ${outputFps} -i "${baseMergedPath}"`);
        let prevStream = `${inputIdx}:v`;
        inputIdx++;
        
        // 按 z-index 顺序添加 mid 层 (GIF 层 + 穿插的静态/标注层)
        const midLayers = allLayers.filter(l => {
          if (l.type === 'gif') return true;
          return timelineStaticLayers.includes(l);
        }).sort((a, b) => a.zIndex - b.zIndex);
        
        for (const layer of midLayers) {
          if (layer.type === 'gif') {
            const gifInfo = gifFramesDirs[layer.gifIndex];
            
            // GIF 输入: 使用处理后的 GIF 文件, -ignore_loop 0 自动循环
            ffInputs.push(`-ignore_loop 0 -i "${gifInfo.sourceGifPath}"`);
            const gIdx = inputIdx++;
            
            // fps 转换 + 定位到画布 (pad)
            filterParts.push(`[${gIdx}:v]fps=${outputFps},pad=${frameW}:${frameH}:${gifInfo.finalOffsetX}:${gifInfo.finalOffsetY}:color=black@0.0[g${gIdx}]`);
            
            // Overlay + 可选的时间线 enable
            let enableExpr = '';
            if (hasTimelineOnLayer(layer.layerId)) {
              const range = timelineData[layer.layerId];
              const den = Math.max(1, totalSourceFrames - 1);
              const sfRaw = Math.ceil((range.start / 100) * den);
              const efRaw = Math.floor((range.end / 100) * den);
              const sf = Math.max(0, sfRaw - trimStartFrame);
              const ef = Math.min(totalOutputFrames - 1, efRaw - trimStartFrame);
              enableExpr = ef >= sf
                ? `:enable='between(n\\,${sf}\\,${ef})'`
                : `:enable='0'`;
            }
            
            const next = `p${inputIdx}`;
            filterParts.push(`[${prevStream}][g${gIdx}]overlay=0:0${enableExpr}[${next}]`);
            prevStream = next;
            
          } else {
            // 静态/标注层 (有时间线或在 GIF 之间)
            ffInputs.push(`-loop 1 -framerate ${outputFps} -i "${layer.path}"`);
            const sIdx = inputIdx++;
            
            let enableExpr = '';
            if (hasTimelineOnLayer(layer.layerId)) {
              const range = timelineData[layer.layerId];
              const den = Math.max(1, totalSourceFrames - 1);
              const sfRaw = Math.ceil((range.start / 100) * den);
              const efRaw = Math.floor((range.end / 100) * den);
              const sf = Math.max(0, sfRaw - trimStartFrame);
              const ef = Math.min(totalOutputFrames - 1, efRaw - trimStartFrame);
              enableExpr = ef >= sf
                ? `:enable='between(n\\,${sf}\\,${ef})'`
                : `:enable='0'`;
            }
            
            const next = `p${inputIdx}`;
            filterParts.push(`[${prevStream}][${sIdx}:v]overlay=0:0${enableExpr}[${next}]`);
            prevStream = next;
          }
        }
        
        // Top merged (如果有)
        if (topMergedPath) {
          ffInputs.push(`-loop 1 -framerate ${outputFps} -i "${topMergedPath}"`);
          const tIdx = inputIdx++;
          const next = `p${inputIdx}`;
          filterParts.push(`[${prevStream}][${tIdx}:v]overlay=0:0[${next}]`);
          prevStream = next;
        }
        
        // 🚀 三步走：消除 split 内存瓶颈
        // 旧方案: split[ps0][ps1] → palettegen → paletteuse
        //   → 缓冲全部帧到内存（178帧×860×1864×4×2 ≈ 2.3GB+），8分钟+零输出
        // 新方案: 合成→PNG序列（流式O(1)）→ 两阶段调色板 → GIF
        //   → 内存恒定，边合成边写盘，每帧可见进度
        
        const multiSourceTotalBytes = gifPaths.reduce((acc, info) => acc + ((Number(info.sourceSizeMB) || 0) * 1024 * 1024), 0);
        const adaptiveMultiExport = getAdaptiveProfile({
          preSizeMB: multiSourceTotalBytes / (1024 * 1024),
          decisionSizeMB: multiSourceTotalBytes / (1024 * 1024),
          frameCount: totalOutputFrames,
          hasVideoLayers: hasVideo
        });

        const filterComplex = filterParts.join(';');
        const multiPipeFramesDir = path.join(tempDir, 'pipe_frames');
        if (!fs.existsSync(multiPipeFramesDir)) fs.mkdirSync(multiPipeFramesDir, { recursive: true });
        const tempGifPath = path.join(tempDir, 'temp_output.gif');
        
        // ── Step 1: 合成滤镜图 → PNG 序列（流式，逐帧输出）──────────
        const pipelineTimeout = Math.max(180000, totalOutputFrames * adaptiveMultiExport.pipelinePerFrameMs);
        const compositeCmd = `ffmpeg -threads 0 ${ffInputs.join(' ')} -filter_complex "${filterComplex}" -map "[${prevStream}]" -frames:v ${totalOutputFrames} -threads 0 -start_number 0 -y "${multiPipeFramesDir}/frame_%04d.png"`;
        
        console.log(`   🚀 FFmpeg 管道 Step 1/2: ${ffInputs.length} 输入, ${totalOutputFrames} 帧 → PNG 序列 (流式，无内存瓶颈)`);
        
        reportProgress(30, `正在合成 ${totalOutputFrames} 帧...`);
        await execAsync(compositeCmd, { maxBuffer: 200 * 1024 * 1024, timeout: pipelineTimeout });
        
        // ── Step 2: 两阶段调色板 → GIF ──────────────────────────────
        reportProgress(70, '正在生成调色板并编码 GIF...');
        const multiPipePalettePath = path.join(tempDir, 'pipe_palette.png');
        
        // 阶段 1: 分析全部帧生成最优调色板
        await execAsync(`ffmpeg -threads 0 -framerate ${outputFps} -i "${multiPipeFramesDir}/frame_%04d.png" -vf "palettegen=max_colors=256:stats_mode=full" -threads 0 -y "${multiPipePalettePath}"`,
          { maxBuffer: 50 * 1024 * 1024, timeout: Math.max(30000, adaptiveMultiExport.paletteGenTimeoutMs) });
        
        // 阶段 2: 用调色板 + 抖动渲染最终 GIF
        await execAsync(`ffmpeg -threads 0 -framerate ${outputFps} -i "${multiPipeFramesDir}/frame_%04d.png" -i "${multiPipePalettePath}" -lavfi "[0:v][1:v]paletteuse=dither=${ditherMode}:diff_mode=rectangle" -threads 0 -loop 0 -y "${tempGifPath}"`,
          { maxBuffer: 200 * 1024 * 1024, timeout: Math.max(60000, adaptiveMultiExport.paletteUseTimeoutMs) });
        
        // 异步清理临时 PNG 和调色板
        setImmediate(() => { try { removeDirRecursive(multiPipeFramesDir); } catch(e){} });
        if (fs.existsSync(multiPipePalettePath)) try { fs.unlinkSync(multiPipePalettePath); } catch(e){}
        
        console.log(`   🚀 FFmpeg 管道 Step 2/2: 两阶段调色板编码完成`);
        
        // 验证输出
        if (!fs.existsSync(tempGifPath) || fs.statSync(tempGifPath).size < 100) {
          throw new Error('FFmpeg 管道输出文件为空或过小');
        }
        
        reportProgress(85, '正在压缩优化...');
        
        // ── 5. gifsicle 优化 ───────────────────────────────────────────
        try {
          await execAsync('which gifsicle');
          const tempStats = fs.statSync(tempGifPath);
          const gifsicleTimeout = Math.max(60000, Math.ceil(tempStats.size / (1024 * 1024)) * adaptiveMultiExport.gifsicleTimeoutPerMbMs);
          
          await execAsync(`gifsicle -O3 --lossy=${adaptiveMultiExport.lossy} --no-conserve-memory --no-comments --no-names --no-extensions "${tempGifPath}" -o "${outputPath}"`, 
            { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
          
          if (fs.existsSync(tempGifPath)) fs.unlinkSync(tempGifPath);
          
          const optimizedStats = fs.statSync(outputPath);
          console.log(`   🗜️  gifsicle: ${(tempStats.size / 1024 / 1024).toFixed(2)} MB → ${(optimizedStats.size / 1024 / 1024).toFixed(2)} MB`);
        } catch (e) {
          if (!fs.existsSync(outputPath)) {
            fs.renameSync(tempGifPath, outputPath);
          } else if (fs.existsSync(tempGifPath)) {
            fs.unlinkSync(tempGifPath);
          }
        }
        
        endStep('Step 4 FFmpeg管道合成');
        ffmpegPipelineSucceeded = true;
        
        // 异步清理帧目录（pipeline 模式下这些目录仍然存在但不再需要）
        setImmediate(() => {
          try {
            for (const gifFramesInfo of gifFramesDirs) {
              if (fs.existsSync(gifFramesInfo.dir)) {
                removeDirRecursive(gifFramesInfo.dir);
              }
            }
          } catch (e) {}
        });
        
      } catch (pipelineErr) {
        if (pipelineErr.message === 'GIF_EXPORT_CANCELLED' || (shouldCancel && shouldCancel())) {
          throw pipelineErr; // 取消操作直接抛出，不回退
        }
        console.log(`   ⚠️  FFmpeg 管道失败，回退到逐帧模式: ${pipelineErr.message}`);
        if (pipelineErr.stderr) console.log(`   STDERR: ${pipelineErr.stderr.substring(0, 500)}`);
      }
      
      // ════════════════════════════════════════════════════════════════════
      // 回退路径：逐帧 ImageMagick 合成（仅当 FFmpeg 管道失败时执行）
      // ════════════════════════════════════════════════════════════════════
      if (!ffmpegPipelineSucceeded) {
      
      // 🚀🚀🚀 优化：合并 Step 4 和 Step 5，一次性完成所有层的合成
      // 原来需要处理 N 帧 × 2 步骤 = 2N 次操作
      // 现在只需要 N 帧 × 1 步骤 = N 次操作，减少 50% 的处理时间
      
      startStep('Step 4 合成帧');
      reportProgress(30, '正在合成动态帧...');
      
      // 直接输出到最终目录（跳过中间目录）
      const annotatedFramesDir = path.join(tempDir, 'annotated_frames');
      if (!fs.existsSync(annotatedFramesDir)) {
        fs.mkdirSync(annotatedFramesDir, { recursive: true });
      }
      
      // backgroundPath 已在 FFmpeg 管道优化前创建
      
      // 并行处理帧合成，限制并发数
      // 🚀 优化：根据 CPU 核心数动态调整并行数（最小 16，最大 64）
      const cpuCount = os.cpus().length;
      const PARALLEL_LIMIT = Math.min(64, Math.max(16, cpuCount * 4));
      let completedFrames = 0;
      
      // 🚀🚀🚀 优化：一次性合成所有层（背景 + Bottom + GIF层 + Top）
      // 🎬 processFrame 接收两个参数：
      //   sourceFrameIdx: 源帧索引（用于计算时间线进度和GIF帧映射）
      //   outputIdx: 输出帧序号（用于文件命名，从0开始连续递增）
      const processFrame = async (sourceFrameIdx, outputIdx) => {
        checkCancelled();
        
        // 🎬 输出帧使用连续编号（outputIdx），确保 FFmpeg 能正确读取
        const outputFrame = path.join(annotatedFramesDir, `frame_${String(outputIdx).padStart(4, '0')}.png`);
        // 🎬 时间计算基于源帧索引，确保GIF帧映射正确
        const currentTime = (sourceFrameIdx * outputDelay) / 100;
        // 🎬 用于时间线进度判断（sourceFrameIdx 相对于 totalSourceFrames）
        const frameIdx = sourceFrameIdx;
        
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
                // 🎬 进度基于 totalSourceFrames（源帧总数），不是裁剪后的输出帧数
                const progress = totalSourceFrames > 1 ? (frameIdx / (totalSourceFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    // 时间线裁剪：GIF 层在此帧被跳过
                    continue; // Skip this layer for this frame
                }
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
                // 🎬 进度基于 totalSourceFrames
                const progress = totalSourceFrames > 1 ? (frameIdx / (totalSourceFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    continue; // Skip this layer for this frame
                }
            }
            allLayerPaths.push(layer.path);
          } else if (layer.type === 'annotation') {
            // Check timeline visibility for annotation layers
            if (timelineData && timelineData[layer.layerId]) {
                const range = timelineData[layer.layerId];
                // 🎬 进度基于 totalSourceFrames
                const progress = totalSourceFrames > 1 ? (frameIdx / (totalSourceFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    continue; // Skip this layer for this frame
                }
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
      
      // 🎬 分批并行处理（使用裁剪后的帧范围）
      // sourceFrameIdx: 源帧（trimStartFrame ~ trimEndFrame），用于GIF帧映射和时间线进度
      // outputIdx: 输出帧（0 ~ totalOutputFrames-1），用于文件连续编号
      for (let batchStart = 0; batchStart < totalOutputFrames; batchStart += PARALLEL_LIMIT) {
        const batch = [];
        for (let offset = 0; offset < PARALLEL_LIMIT && (batchStart + offset) < totalOutputFrames; offset++) {
          const outIdx = batchStart + offset;
          const srcIdx = trimStartFrame + outIdx;
          batch.push(processFrame(srcIdx, outIdx));
        }
        await Promise.all(batch);
      }
      
      console.log(`   ✅ 所有帧已一次性完成合成（背景 + Bottom + GIF层 + Top）`);
      
      // 第六步：重组为 GIF
      endStep('Step 4 合成帧');
      startStep('Step 6 生成GIF');
      console.log(`\n   第 6 步：重组为 GIF...`);
      reportProgress(80, '正在生成最终 GIF...');
      // 合并生成和优化为一条命令，启用多线程加速
      // 🚀🚀🚀 优化：先快速生成 GIF，再用 gifsicle 优化（比 ImageMagick OptimizeFrame 快 10 倍）
      
      // 第一步：生成 GIF
      // 🚀 优先使用 ffmpeg（更快），回退到 ImageMagick
      const tempGifPath = path.join(tempDir, 'temp_output.gif');
      
      const outputFps = exportOutputFps;
      
      let usedFfmpeg = false;
      try {
        // 尝试用 ffmpeg 生成（速度更快）
        // -framerate: 输入帧率
        // 🎨 根据用户设置使用相应的抖动算法
        const palettePath = path.join(tempDir, 'palette.png');
        
        // 🗜️ 剪映级 GIF 压缩流水线 - 第 1 阶段：FFmpeg 帧差分编码
        //
        // 技术 ①：帧差分 + 脏矩形裁剪 (diff_mode=rectangle)
        //   → 每帧只存储相对于前帧变化的矩形区域，未变化像素设为透明
        //   → LZW 对大面积透明像素（连续游程）压缩率极高
        //   → 单项可贡献 50-70% 体积降低
        //
        // 技术 ②：帧间差异调色板 (stats_mode=full)
        //   → 调色板颜色集中分配给帧间变化的像素（而非全局均匀分配）
        //   → 变化区域获得更精准的色彩表达
        //
        // 技术 ③：感知抖动 (dither=floyd_steinberg/bayer)
        //   → 用误差扩散模拟更多颜色，减少色带
        //   → 抖动噪声的结构性反而有利于 LZW 编码
        //
        // max_colors=256：保留最大色彩精度，让后续 gifsicle 做更精准的 LZW 优化
        const paletteCmd = `ffmpeg -threads 0 -y -framerate ${outputFps} -i "${annotatedFramesDir}/frame_%04d.png" -vf "palettegen=max_colors=256:stats_mode=full" -threads 0 "${palettePath}"`;
        await execAsync(paletteCmd, {
          maxBuffer: 100 * 1024 * 1024,
          timeout: Math.max(30000, exportAdaptiveProfile.paletteGenTimeoutMs)
        });
        
        const ffmpegGifCmd = `ffmpeg -threads 0 -y -framerate ${outputFps} -i "${annotatedFramesDir}/frame_%04d.png" -i "${palettePath}" -lavfi "paletteuse=dither=${ditherMode}:diff_mode=rectangle" -threads 0 -loop 0 "${tempGifPath}"`;
        await execAsync(ffmpegGifCmd, {
          maxBuffer: 200 * 1024 * 1024,
          timeout: Math.max(60000, exportAdaptiveProfile.paletteUseTimeoutMs)
        });
        
        // 清理调色板
        if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
        usedFfmpeg = true;
        console.log(`      ✅ 使用 ffmpeg 生成 GIF (更快, dither=${ditherMode})`);
      } catch (ffmpegErr) {
        // ffmpeg 失败，回退到 ImageMagick
        console.log(`      ⚠️  ffmpeg 不可用，使用 ImageMagick 生成...`);
        // 根据用户设置使用相应的抖动算法（ImageMagick 回退方案）
        const generateCmd = `convert -limit thread 0 -delay ${outputDelay} -loop 0 "${annotatedFramesDir}/frame_*.png" -colors 256 -dither ${imageMagickDither} "${tempGifPath}"`;
        await execAsync(generateCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
      }
      
      // 🗜️ 剪映级 GIF 压缩流水线 - 第 2 阶段：gifsicle 深度优化
      //
      // FFmpeg 已完成：帧差分 + 脏矩形裁剪 + 调色板优化
      // gifsicle 负责 FFmpeg 做不了的事：
      //
      // 技术 ④：像素级透明优化 (-O3)
      //   → FFmpeg 的 diff_mode=rectangle 只裁切到矩形框
      //   → gifsicle -O3 在矩形框内部进一步将未变化的单个像素设为透明
      //   → LZW 对透明连续游程压缩率极高
      //
      // 技术 ⑤：LZW 编码优化 (-O3)
      //   → 尝试所有压缩方法并选择最优结果
      //   → 优化码表管理策略，延迟清空 LZW 码表让长匹配串积累
      //   → 自动选择最优最小码字长度 (min LZW code size)
      //
      // 技术 ⑥：有损 LZW 扰动 (--lossy=80)
      //   → 在编码时引入人眼不敏感的轻微噪声
      //   → 使相邻像素值更规律，产生更长的 LZW 匹配串
      //   → 额外减小 20-40% 体积，视觉几乎无损
      //
      // gifsicle 深度优化：像素级透明 + LZW + 有损扰动
      try {
        await execAsync('which gifsicle');
        const tempStats = fs.statSync(tempGifPath);
        const gifsicleTimeout = Math.max(60000, Math.ceil(tempStats.size / (1024 * 1024)) * exportAdaptiveProfile.gifsicleTimeoutPerMbMs);
        
        await execAsync(`gifsicle -O3 --lossy=${exportAdaptiveProfile.lossy} --no-conserve-memory --no-comments --no-names --no-extensions "${tempGifPath}" -o "${outputPath}"`, 
          { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
        
        if (fs.existsSync(tempGifPath)) fs.unlinkSync(tempGifPath);
        
        const optimizedStats = fs.statSync(outputPath);
        console.log(`      🗜️  gifsicle: ${(tempStats.size / 1024 / 1024).toFixed(2)} MB → ${(optimizedStats.size / 1024 / 1024).toFixed(2)} MB`);
      } catch (e) {
        // gifsicle 不可用或失败，直接使用 FFmpeg 输出
        if (!fs.existsSync(outputPath)) {
          fs.renameSync(tempGifPath, outputPath);
        } else if (fs.existsSync(tempGifPath)) {
          fs.unlinkSync(tempGifPath);
        }
      }
      endStep('Step 6 生成GIF');
      
      // 异步清理帧目录（不阻塞导出结果返回）
      setImmediate(() => {
        try {
          for (const gifFramesInfo of gifFramesDirs) {
            if (fs.existsSync(gifFramesInfo.dir)) {
              removeDirRecursive(gifFramesInfo.dir);
            }
          }
          if (fs.existsSync(annotatedFramesDir)) {
            removeDirRecursive(annotatedFramesDir);
          }
        } catch (e) {
          // 忽略清理错误
        }
      });
      
      } // end of fallback: if (!ffmpegPipelineSucceeded)
    }
    
    
    // 5. GIF 已生成，立即报告 100%（不要等清理完再报告）
    const stats = fs.statSync(outputPath);
    reportProgress(100, '导出完成');
    
    // 6. 异步清理临时文件（不阻塞导出结果返回）
    setImmediate(() => {
      try {
        if (fs.existsSync(tempDir)) {
          removeDirRecursive(tempDir);
        }
      } catch (e) {
        // 忽略清理错误
      }
    });
    
    _reservedExportNumbers.delete(sequenceNumber); // 🔒 释放预留序号
    
    return {
      outputPath,
      filename: outputFilename,
      size: stats.size
    };
    
  } catch (error) {
    _reservedExportNumbers.delete(sequenceNumber); // 🔒 释放预留序号
    
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

return composeAnnotatedGif;
};
