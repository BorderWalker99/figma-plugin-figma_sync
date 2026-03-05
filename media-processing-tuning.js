// media-processing-tuning.js
// 统一管理：视频/GIF 处理质量、速度、尺寸与阈值参数
// 可通过环境变量覆盖，未设置则使用默认值。

function envNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const num = Number(raw);
  return Number.isFinite(num) ? num : defaultValue;
}

function envString(name, defaultValue) {
  const raw = process.env[name];
  return (raw === undefined || raw === null || raw === '') ? defaultValue : raw;
}

/**
 * ==========================
 * 调参总入口（A / B / C）
 * ==========================
 *
 * 你后续主要改本文件即可。可选两种方式：
 * 1) 直接改下面 envNumber/envString 的默认值
 * 2) 在运行环境里设置同名环境变量覆盖默认值
 *
 * A. 极速档触发阈值（是否进入“速度优先”）
 * - ULTRA_SPEED_VIDEO_THRESHOLD_MB
 *   越小 => 越容易进入极速档（整体更快、但更多文件会降质）
 *   越大 => 越少进入极速档（整体更慢、但更多文件保质量）
 *
 * B. watcher 侧（视频 -> GIF）质量/速度参数
 * - ULTRA_SPEED_GIF_FPS
 *   越小 => 越快（流畅度下降）
 *   越大 => 越慢（流畅度更好）
 * - ULTRA_SPEED_GIF_SCALE_DIVISOR
 *   越大 => 越快（分辨率更低）
 *   越小 => 越慢（分辨率更高）
 * - ULTRA_SPEED_GIF_MAX_COLORS
 *   越小 => 越快（色彩更少）
 *   越大 => 越慢（色彩更丰富）
 * - ULTRA_SPEED_GIF_DITHER
 *   `none` 通常更快（但颗粒感/色带更明显）
 *   `bayer/sierra` 通常更慢（但观感更好）
 * - ULTRA_SPEED_GIF_TIMEOUT_MS
 *   越小 => 更容易超时退出（等待更短，但失败概率更高）
 *   越大 => 更不易超时（等待更长，但成功率更高）
 * - ULTRA_SPEED_GIF_FALLBACK_DITHER（极速回退抖动策略）
 *
 * C. server 侧（云端预压缩）质量/速度参数
 * - ULTRA_SPEED_UPLOAD_CRF
 *   越大 => 压缩越狠、文件更小、通常编码更快（画质更差）
 *   越小 => 压缩更轻、文件更大、通常编码更慢（画质更好）
 * - ULTRA_SPEED_UPLOAD_PRESET
 *   越靠前(ultrafast/veryfast) => 越快（同 CRF 下体积更大）
 *   越靠后(medium/slow) => 越慢（同 CRF 下体积更小、质量更稳）
 * - ULTRA_SPEED_UPLOAD_MAX_WIDTH / ULTRA_SPEED_UPLOAD_MAX_HEIGHT
 *   越小 => 越快（清晰度下降）
 *   越大 => 越慢（清晰度更高）
 * - ULTRA_SPEED_UPLOAD_AUDIO_BITRATE
 *   越小 => 越快/体积越小（音质下降）
 *   越大 => 越慢/体积越大（音质更好）
 *
 * 作用范围说明（非常重要）：
 * 1) B（watcher）不是“全都只给极速档”：
 *    - 对所有文件都可能生效：estimateFactor、smallTwoPass、largeSinglePass、
 *      fallbackCompressVideo、fallbackAfterCompressToGif、fallbackLossy
 *    - 只对极速档生效：ultra（ULTRA_SPEED_GIF_* 以及 ultra.* fallback 参数）
 *
 * 2) C（serverUpload）只在“上传前压缩触发后”才生效（由 UPLOAD_COMPRESS_THRESHOLD_MB 决定）：
 *    - normal：非极速档分层（50~80MB 与 80MB+）
 *    - ultra：极速档（> ULTRA_SPEED_VIDEO_THRESHOLD_MB）
 *
 * 3) A 决定“是否进入极速档”，会影响 B.ultra 和 C.ultra 是否启用。
 *
 * 其它可调参数（同样在本文件）：
 * - LARGE_GIF_URL_THRESHOLD_MB（走 gifUrl 快路径阈值）
 *   越小 => 越多文件走 URL 快路径（传输更快）
 *   越大 => 越少文件走 URL 快路径（更多走 bytes/base64）
 * - LARGE_VIDEO_THRESHOLD_MB（大文件分界）
 *   越小 => 越多文件进入“大文件单遍”策略（更快）
 *   越大 => 越少文件进入该策略（更偏质量）
 * - UPLOAD_COMPRESS_THRESHOLD_MB（上传前压缩阈值）
 *   越小 => 越多文件先压缩（上传更快但前处理更久）
 *   越大 => 越少文件先压缩（前处理更快但上传/下游更慢）
 * - WATCHER_* / SERVER_UPLOAD_*（分层策略细调）
 */

module.exports = {
  // A. 全局阈值（触发策略）
  thresholds: {
    // 超过该值(MB)进入“极速档”策略
    ultraSpeedVideoMb: envNumber('ULTRA_SPEED_VIDEO_THRESHOLD_MB', 150),
    // 超过该值(MB)优先走 gifUrl/createImageAsync 快路径
    largeGifUrlMb: envNumber('LARGE_GIF_URL_THRESHOLD_MB', 2),
    // 大文件分界（视频->GIF）
    largeVideoMb: envNumber('LARGE_VIDEO_THRESHOLD_MB', 30),
    // 上传前压缩触发阈值
    // 优先无损链路：仅在更大体积时再启用上传前压缩
    uploadCompressMb: envNumber('UPLOAD_COMPRESS_THRESHOLD_MB', 120),
    // 服务端普通压缩分层阈值
    uploadTier80Mb: envNumber('UPLOAD_TIER_80_MB', 80),
    // 手动同步小图极速直通阈值（<=该值时可跳过 sharp 压缩，直传到 Figma）
    manualImageFastPassKb: envNumber('MANUAL_IMAGE_FAST_PASS_KB', 1024),

    // ── 分块上传参数（手机→服务器的切片策略）──
    // 值越大 → 越少的 HTTP 往返 → 上传越快，但单次失败重传代价更大
    chunkRecommendedMb: envNumber('CHUNK_RECOMMENDED_MB', 8),
    // 服务端允许的单个 chunk 最大尺寸（需 >= recommended）
    chunkMaxMb: envNumber('CHUNK_MAX_MB', 32)
  },

  // B. watcher 侧转换参数（drive/icloud 共用）
  watcher: {
    // 预计耗时估算系数（仅用于进度展示）
    estimateFactor: {
      ultra: envNumber('WATCHER_ESTIMATE_FACTOR_ULTRA', 0.8),
      large: envNumber('WATCHER_ESTIMATE_FACTOR_LARGE', 1.2),
      normal: envNumber('WATCHER_ESTIMATE_FACTOR_NORMAL', 2.0)
    },

    // 主策略：大文件单遍
    largeSinglePass: {
      // 非极速档提升帧率还原（默认 10 -> 16），减少“掉帧卡顿”观感
      fps: envNumber('WATCHER_LARGE_SINGLEPASS_FPS', 16),
      scaleDivisor: envNumber('WATCHER_LARGE_SINGLEPASS_SCALE_DIV', 4),
      maxColors: envNumber('WATCHER_LARGE_SINGLEPASS_MAX_COLORS', 192),
      dither: envString('WATCHER_LARGE_SINGLEPASS_DITHER', 'bayer:bayer_scale=3'),
      timeoutMs: envNumber('WATCHER_LARGE_SINGLEPASS_TIMEOUT_MS', 300000)
    },

    // 主策略：小文件两遍
    smallTwoPass: {
      // 非极速档提升帧率还原（默认 15 -> 20），优先保证流畅度
      fps: envNumber('WATCHER_SMALL_TWOPASS_FPS', 20),
      scaleDivisor: envNumber('WATCHER_SMALL_TWOPASS_SCALE_DIV', 4),
      pass1TimeoutMs: envNumber('WATCHER_SMALL_TWOPASS_PASS1_TIMEOUT_MS', 30000),
      pass2TimeoutMs: envNumber('WATCHER_SMALL_TWOPASS_PASS2_TIMEOUT_MS', 180000)
    },

    // 回退策略1：先压视频再转
    fallbackCompressVideo: {
      // 仅用于兼容旧逻辑保留；当前压缩阶段默认不主动降帧，以避免“慢动作感”
      fps: envNumber('WATCHER_FALLBACK_COMPRESS_FPS', 12),
      maxWidth: envNumber('WATCHER_FALLBACK_COMPRESS_MAX_WIDTH', 960),
      crf: envNumber('WATCHER_FALLBACK_COMPRESS_CRF', 30),
      preset: envString('WATCHER_FALLBACK_COMPRESS_PRESET', 'ultrafast'),
      timeoutMs: envNumber('WATCHER_FALLBACK_COMPRESS_TIMEOUT_MS', 120000)
    },
    fallbackAfterCompressToGif: {
      // 建议 >=12，避免低帧率造成“速度变慢”的主观观感
      fps: envNumber('WATCHER_FALLBACK_CONVERT_FPS', 12),
      scaleDivisor: envNumber('WATCHER_FALLBACK_CONVERT_SCALE_DIV', 2),
      maxColors: envNumber('WATCHER_FALLBACK_CONVERT_MAX_COLORS', 128),
      dither: envString('WATCHER_FALLBACK_CONVERT_DITHER', 'bayer:bayer_scale=3'),
      timeoutMs: envNumber('WATCHER_FALLBACK_CONVERT_TIMEOUT_MS', 180000)
    },

    // 回退策略2：有损保底
    fallbackLossy: {
      // 建议 >=12，避免低帧率造成“速度变慢”的主观观感
      fps: envNumber('WATCHER_FALLBACK_LOSSY_FPS', 12),
      scaleDivisor: envNumber('WATCHER_FALLBACK_LOSSY_SCALE_DIV', 2),
      maxColors: envNumber('WATCHER_FALLBACK_LOSSY_MAX_COLORS', 96),
      dither: envString('WATCHER_FALLBACK_LOSSY_DITHER', 'bayer:bayer_scale=5'),
      timeoutMs: envNumber('WATCHER_FALLBACK_LOSSY_TIMEOUT_MS', 180000)
    },

    // 极速档（> ultraSpeedVideoMb）
    ultra: {
      // 极速档优先通过“降帧”换速度：在保留颜色/清晰度前提下显著提速
      // （如需更丝滑可升高；如需更快可再降低）
      fps: envNumber('ULTRA_SPEED_GIF_FPS', 15),
      scaleDivisor: envNumber('ULTRA_SPEED_GIF_SCALE_DIVISOR', 5),
      maxColors: envNumber('ULTRA_SPEED_GIF_MAX_COLORS', 144),
      dither: envString('ULTRA_SPEED_GIF_DITHER', 'bayer:bayer_scale=2'),
      timeoutMs: envNumber('ULTRA_SPEED_GIF_TIMEOUT_MS', 210000),

      // 极速回退参数
      fallbackDither: envString('ULTRA_SPEED_GIF_FALLBACK_DITHER', 'bayer:bayer_scale=4'),
      fallbackMinFps: envNumber('ULTRA_SPEED_FALLBACK_MIN_FPS', 15),
      fallbackScaleDivisorMin: envNumber('ULTRA_SPEED_FALLBACK_SCALE_DIV_MIN', 4),
      fallbackMinColors: envNumber('ULTRA_SPEED_FALLBACK_MIN_COLORS', 96),
      fallbackTimeoutFloorMs: envNumber('ULTRA_SPEED_FALLBACK_TIMEOUT_FLOOR_MS', 150000),
      fallbackTimeoutReduceMs: envNumber('ULTRA_SPEED_FALLBACK_TIMEOUT_REDUCE_MS', 30000)
    }
  },

  // B2. 时间线编辑器导出参数（gif-composer 使用）
  // videoFpsCap 决定导出 GIF 的最大帧率（源视频 fps 与此值取较小值）
  //   越大 => 越流畅（文件越大、编码越慢）
  //   越小 => 越掉帧（文件越小、编码越快）
  composer: {
    // 默认帧率上限（小文件 / 低分辨率）
    fpsCap: envNumber('COMPOSER_FPS_CAP', 60),
    // 中等文件（>20MB 或像素量 >250万）帧率上限
    fpsCapMedium: envNumber('COMPOSER_FPS_CAP_MEDIUM', 50),
    // 大文件（>40MB 或像素量 >600万）帧率上限
    fpsCapLarge: envNumber('COMPOSER_FPS_CAP_LARGE', 30),
    // 超大文件（>80MB 或像素量 >1200万）帧率上限
    fpsCapXLarge: envNumber('COMPOSER_FPS_CAP_XLARGE', 15)
  },

  // B2.1 时间线导出模式参数（FFmpeg-first）
  // auto 模式下：达到 ultraTrigger 条件则切 fast，否则走 quality。
  composerExport: {
    ultraTrigger: {
      // 默认与全局 ULTRA_SPEED_VIDEO_THRESHOLD_MB 对齐
      minVideoMb: envNumber('COMPOSER_ULTRA_TRIGGER_MB', 150),
      minPixels: envNumber('COMPOSER_ULTRA_TRIGGER_PIXELS', 3500000),
      minFrames: envNumber('COMPOSER_ULTRA_TRIGGER_FRAMES', 220),
      minScore: envNumber('COMPOSER_ULTRA_TRIGGER_SCORE', 12000000)
    },
    fast: {
      fpsCap: envNumber('COMPOSER_FAST_FPS_CAP', 24),
      fpsCapMedium: envNumber('COMPOSER_FAST_FPS_CAP_MEDIUM', 20),
      fpsCapLarge: envNumber('COMPOSER_FAST_FPS_CAP_LARGE', 16),
      fpsCapXLarge: envNumber('COMPOSER_FAST_FPS_CAP_XLARGE', 12),
      lossyBase: envNumber('COMPOSER_FAST_LOSSY_BASE', 94),
      lossyMedium: envNumber('COMPOSER_FAST_LOSSY_MEDIUM', 100),
      lossyLarge: envNumber('COMPOSER_FAST_LOSSY_LARGE', 106),
      lossyXLarge: envNumber('COMPOSER_FAST_LOSSY_XLARGE', 110),
      timeoutScale: envNumber('COMPOSER_FAST_TIMEOUT_SCALE', 0.65),
      pipelinePerFrameMs: envNumber('COMPOSER_FAST_PIPELINE_PER_FRAME_MS', 3500),
      paletteGenTimeoutMs: envNumber('COMPOSER_FAST_PALETTEGEN_TIMEOUT_MS', 45000),
      paletteUseTimeoutMs: envNumber('COMPOSER_FAST_PALETTEUSE_TIMEOUT_MS', 90000),
      gifsicleTimeoutPerMbMs: envNumber('COMPOSER_FAST_GIFSICLE_TIMEOUT_PER_MB_MS', 3200)
    },
    quality: {
      fpsCap: envNumber('COMPOSER_QUALITY_FPS_CAP', 60),
      fpsCapMedium: envNumber('COMPOSER_QUALITY_FPS_CAP_MEDIUM', 50),
      fpsCapLarge: envNumber('COMPOSER_QUALITY_FPS_CAP_LARGE', 30),
      fpsCapXLarge: envNumber('COMPOSER_QUALITY_FPS_CAP_XLARGE', 15),
      lossyBase: envNumber('COMPOSER_QUALITY_LOSSY_BASE', 80),
      lossyMedium: envNumber('COMPOSER_QUALITY_LOSSY_MEDIUM', 88),
      lossyLarge: envNumber('COMPOSER_QUALITY_LOSSY_LARGE', 94),
      lossyXLarge: envNumber('COMPOSER_QUALITY_LOSSY_XLARGE', 102),
      timeoutScale: envNumber('COMPOSER_QUALITY_TIMEOUT_SCALE', 1.0),
      pipelinePerFrameMs: envNumber('COMPOSER_QUALITY_PIPELINE_PER_FRAME_MS', 5000),
      paletteGenTimeoutMs: envNumber('COMPOSER_QUALITY_PALETTEGEN_TIMEOUT_MS', 60000),
      paletteUseTimeoutMs: envNumber('COMPOSER_QUALITY_PALETTEUSE_TIMEOUT_MS', 120000),
      gifsicleTimeoutPerMbMs: envNumber('COMPOSER_QUALITY_GIFSICLE_TIMEOUT_PER_MB_MS', 5000)
    }
  },

  // B3. 时间线编辑器预览帧提取参数（server.js extract-preview-frames 使用）
  // 目标：更激进提升长视频预览帧还原，同时通过分辨率分层保护加载速度
  composerPreview: {
    minFrames: envNumber('COMPOSER_PREVIEW_MIN_FRAMES', 160),
    maxFrames: envNumber('COMPOSER_PREVIEW_MAX_FRAMES', 640),
    shortDurationSec: envNumber('COMPOSER_PREVIEW_SHORT_SEC', 20),
    mediumDurationSec: envNumber('COMPOSER_PREVIEW_MEDIUM_SEC', 60),
    longDurationSec: envNumber('COMPOSER_PREVIEW_LONG_SEC', 180),
    targetFpsShort: envNumber('COMPOSER_PREVIEW_TARGET_FPS_SHORT', 18),
    targetFpsMedium: envNumber('COMPOSER_PREVIEW_TARGET_FPS_MEDIUM', 14),
    targetFpsLong: envNumber('COMPOSER_PREVIEW_TARGET_FPS_LONG', 12),
    targetFpsXL: envNumber('COMPOSER_PREVIEW_TARGET_FPS_XL', 10),
    denseFrameThreshold: envNumber('COMPOSER_PREVIEW_DENSE_FRAME_THRESHOLD', 300),
    ultraDenseFrameThreshold: envNumber('COMPOSER_PREVIEW_ULTRA_DENSE_FRAME_THRESHOLD', 480),
    scaleHeightNormal: envNumber('COMPOSER_PREVIEW_SCALE_HEIGHT_NORMAL', 560),
    scaleHeightDense: envNumber('COMPOSER_PREVIEW_SCALE_HEIGHT_DENSE', 460),
    scaleHeightUltraDense: envNumber('COMPOSER_PREVIEW_SCALE_HEIGHT_ULTRA_DENSE', 380),
    // 分辨率分层保护：高分辨率视频自动降低 maxFrames，避免内存/解码压力失控
    hiResPixels: envNumber('COMPOSER_PREVIEW_HIRES_PIXELS', 3500000),          // ~2K
    ultraResPixels: envNumber('COMPOSER_PREVIEW_ULTRARES_PIXELS', 7000000),    // ~4K
    maxFramesHiRes: envNumber('COMPOSER_PREVIEW_MAX_FRAMES_HIRES', 520),
    maxFramesUltraRes: envNumber('COMPOSER_PREVIEW_MAX_FRAMES_ULTRARES', 380)
  },

  // C. server 侧上传压缩参数
  serverUpload: {
    // 普通分层（50~80 / 80+）
    normal: {
      crf50to80: envNumber('SERVER_UPLOAD_CRF_50_TO_80', 18),
      crf80plus: envNumber('SERVER_UPLOAD_CRF_80_PLUS', 23),
      preset50to80: envString('SERVER_UPLOAD_PRESET_50_TO_80', 'medium'),
      preset80plus: envString('SERVER_UPLOAD_PRESET_80_PLUS', 'fast'),
      maxWidth: envNumber('SERVER_UPLOAD_MAX_WIDTH_NORMAL', 1920),
      maxHeight: envNumber('SERVER_UPLOAD_MAX_HEIGHT_NORMAL', 1080),
      audioBitrate: envString('SERVER_UPLOAD_AUDIO_BITRATE_NORMAL', '128k')
    },
    // 极速档（> ultraSpeedVideoMb）
    ultra: {
      crf: envNumber('ULTRA_SPEED_UPLOAD_CRF', 20),
      preset: envString('ULTRA_SPEED_UPLOAD_PRESET', 'fast'),
      maxWidth: envNumber('ULTRA_SPEED_UPLOAD_MAX_WIDTH', 1600),
      maxHeight: envNumber('ULTRA_SPEED_UPLOAD_MAX_HEIGHT', 900),
      audioBitrate: envString('ULTRA_SPEED_UPLOAD_AUDIO_BITRATE', '112k')
    }
  }
};
