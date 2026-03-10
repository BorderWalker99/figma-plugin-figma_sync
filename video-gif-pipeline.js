const fs = require('fs');
const path = require('path');

const { buildComposerAttemptProfiles } = require('./adaptive-processing');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function evenDimension(value, fallback = 2) {
  const safe = Math.max(2, Math.round(Number(value) || fallback));
  return safe % 2 === 0 ? safe : safe - 1;
}

function toShellPath(filePath) {
  return String(filePath).replace(/"/g, '\\"');
}

function parseRate(raw) {
  if (!raw || typeof raw !== 'string') return 0;
  const text = raw.trim();
  if (!text) return 0;
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return num / den;
    }
    return 0;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

async function probeVideoMeta(execAsync, ffprobeBin, videoPath) {
  try {
    const { stdout } = await execAsync(
      `"${toShellPath(ffprobeBin)}" -v quiet -print_format json -show_streams -show_format "${toShellPath(videoPath)}"`,
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }
    );
    const info = JSON.parse(stdout || '{}');
    const stream = (info.streams || []).find(item => item.codec_type === 'video');
    if (!stream) return null;
    const fps = parseRate(stream.r_frame_rate || stream.avg_frame_rate || '0/1');
    return {
      fps: Number.isFinite(fps) ? fps : 0,
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      duration: parseFloat(info.format?.duration || stream.duration || '0') || 0
    };
  } catch (_) {
    return null;
  }
}

async function getAnimatedFrameCount(execAsync, ffprobeBin, gifPath) {
  try {
    const { stdout } = await execAsync(
      `"${toShellPath(ffprobeBin)}" -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,nb_frames -of json "${toShellPath(gifPath)}"`,
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const stream = (parsed.streams && parsed.streams[0]) ? parsed.streams[0] : {};
    const frames = Number(stream.nb_read_frames) || Number(stream.nb_frames) || 0;
    return frames;
  } catch (_) {
    return 0;
  }
}

function normalizeAttemptProfile(profile, ditherMode) {
  return {
    label: profile.label || 'adaptive',
    mode: profile.mode || 'quality',
    videoFpsCap: Number.isFinite(profile.videoFpsCap) ? profile.videoFpsCap : (Number.isFinite(profile.fps) ? profile.fps : 24),
    paletteMaxColors: Number.isFinite(profile.paletteMaxColors) ? profile.paletteMaxColors : (Number.isFinite(profile.maxColors) ? profile.maxColors : 256),
    effectiveDither: profile.effectiveDither || profile.dither || ditherMode,
    lossy: Number.isFinite(profile.lossy) ? profile.lossy : 88,
    timeoutScale: Number.isFinite(profile.timeoutScale) ? profile.timeoutScale : 1,
    paletteGenTimeoutMs: Number.isFinite(profile.paletteGenTimeoutMs) ? profile.paletteGenTimeoutMs : 45000,
    paletteUseTimeoutMs: Number.isFinite(profile.paletteUseTimeoutMs) ? profile.paletteUseTimeoutMs : 120000,
    gifsicleTimeoutPerMbMs: Number.isFinite(profile.gifsicleTimeoutPerMbMs) ? profile.gifsicleTimeoutPerMbMs : 4000,
    scaleDivisor: Number.isFinite(profile.scaleDivisor) ? profile.scaleDivisor : 4
  };
}

function buildTargetDimensions({ sourceMeta, targetWidth, targetHeight, scaleDivisor, sourceScaleFactor }) {
  if (Number.isFinite(targetWidth) && Number.isFinite(targetHeight) && targetWidth > 0 && targetHeight > 0) {
    return {
      width: evenDimension(targetWidth),
      height: evenDimension(targetHeight)
    };
  }

  if (!sourceMeta || !sourceMeta.width || !sourceMeta.height) {
    return null;
  }

  const desiredFactorFromOriginal = clamp(2 / Math.max(1, scaleDivisor || 4), 0.1, 1);
  const currentFactorFromOriginal = clamp(sourceScaleFactor || 1, 0.1, 1);
  const relativeFactor = clamp(desiredFactorFromOriginal / currentFactorFromOriginal, 0.1, 1);

  if (relativeFactor >= 0.98) {
    return null;
  }

  return {
    width: evenDimension(sourceMeta.width * relativeFactor, sourceMeta.width),
    height: evenDimension(sourceMeta.height * relativeFactor, sourceMeta.height)
  };
}

async function maybeHalfScaleVideo({
  execAsync,
  ffmpegBin,
  sourcePath,
  tempDir,
  enabled,
  log
}) {
  if (!enabled) {
    return {
      sourcePath,
      applied: false,
      scaleFactorFromOriginal: 1
    };
  }

  const halfPath = path.join(tempDir, 'half-scale.mp4');
  const cmd = `"${toShellPath(ffmpegBin)}" -threads 0 -i "${toShellPath(sourcePath)}" -vf "scale='trunc(iw/2)*2':'trunc(ih/2)*2':flags=lanczos" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -an -movflags +faststart -y "${toShellPath(halfPath)}"`;
  try {
    await execAsync(cmd, { timeout: 240000, maxBuffer: 120 * 1024 * 1024 });
    if (fs.existsSync(halfPath) && fs.statSync(halfPath).size > 0) {
      log(`   ✅ 预缩放成功: ${path.basename(sourcePath)} -> ${path.basename(halfPath)}`);
      return {
        sourcePath: halfPath,
        applied: true,
        scaleFactorFromOriginal: 0.5
      };
    }
  } catch (error) {
    log(`   ⚠️  预缩放失败，回退原视频: ${error.message}`);
  }

  return {
    sourcePath,
    applied: false,
    scaleFactorFromOriginal: 1
  };
}

async function transcodeVideoToGif({
  execAsync,
  ffmpegBin,
  ffprobeBin,
  gifsicleBin,
  sourcePath,
  outputPath,
  tempDir,
  mediaTuning,
  requestedMode = 'auto',
  gifAlgorithm = 'smooth_gradient',
  decisionSizeMB = null,
  pixels = 0,
  frameCount = 0,
  hasVideoLayers = true,
  targetWidth = null,
  targetHeight = null,
  optimizeOutput = false,
  enableHalfScalePrepass = true,
  shouldCancel = null,
  onProgress = null,
  progressBase = 30,
  progressSpan = 50,
  log = () => {}
}) {
  const checkCancelled = () => {
    if (shouldCancel && shouldCancel()) {
      const err = new Error('Conversion aborted');
      err.code = 'CONVERSION_ABORTED';
      throw err;
    }
  };

  const ditherMode = gifAlgorithm === 'smooth_gradient' ? 'sierra2_4a' : 'none';
  const stats = fs.statSync(sourcePath);
  const sourceSizeMB = stats.size / 1024 / 1024;
  const plan = buildComposerAttemptProfiles(mediaTuning, {
    requestedMode,
    preSizeMB: sourceSizeMB,
    decisionSizeMB: Number.isFinite(decisionSizeMB) ? decisionSizeMB : sourceSizeMB,
    frameCount: Math.max(0, Math.round(frameCount || 0)),
    pixels: Math.max(1, Math.round(pixels || 0)),
    hasVideoLayers,
    gifAlgorithm
  });

  const progressStart = Math.max(0, Math.min(95, progressBase));
  const progressEnd = Math.max(progressStart + 1, Math.min(99, progressBase + progressSpan));
  const palettePath = path.join(tempDir, 'palette.png');
  const tempGifPath = optimizeOutput ? path.join(tempDir, 'encoded.gif') : outputPath;
  const optimizedGifPath = optimizeOutput ? outputPath : tempGifPath;

  const halfScaleResult = await maybeHalfScaleVideo({
    execAsync,
    ffmpegBin,
    sourcePath,
    tempDir,
    enabled: enableHalfScalePrepass,
    log
  });

  const conversionSourcePath = halfScaleResult.sourcePath;
  const sourceMeta = await probeVideoMeta(execAsync, ffprobeBin, conversionSourcePath);
  const sourceFps = sourceMeta?.fps || 20;
  const totalFrames = Math.max(0, Math.round(frameCount || (sourceMeta?.duration ? sourceMeta.duration * sourceFps : 0)));

  let lastError = null;
  let lastProfile = normalizeAttemptProfile(plan.profiles[plan.profiles.length - 1] || {}, ditherMode);

  const runPulse = async (runner, { stageDetail, startPercent, endPercent, approxDurationMs }) => {
    let timer = null;
    const safeStart = Math.max(progressStart, Math.min(progressEnd, Math.round(startPercent)));
    const safeEnd = Math.max(safeStart, Math.min(progressEnd, Math.round(endPercent)));
    const span = Math.max(1, safeEnd - safeStart);
    const begin = Date.now();
    const duration = Math.max(5000, Math.min(120000, Math.round(approxDurationMs || 45000)));

    if (onProgress) {
      onProgress(safeStart, { stageDetail });
    }

    try {
      if (onProgress && safeEnd > safeStart) {
        timer = setInterval(() => {
          const ratio = Math.min(0.96, (Date.now() - begin) / duration);
          const nextPercent = safeStart + Math.floor(span * ratio);
          onProgress(Math.max(safeStart, Math.min(safeEnd, nextPercent)), { stageDetail });
        }, 1500);
      }
      return await runner();
    } finally {
      if (timer) clearInterval(timer);
    }
  };

  const encodeWithProfile = async (profile) => {
    checkCancelled();

    const normalizedProfile = normalizeAttemptProfile(profile, ditherMode);
    const gifFps = Math.min(sourceFps || normalizedProfile.videoFpsCap, normalizedProfile.videoFpsCap);
    const targetDims = buildTargetDimensions({
      sourceMeta,
      targetWidth,
      targetHeight,
      scaleDivisor: normalizedProfile.scaleDivisor,
      sourceScaleFactor: halfScaleResult.scaleFactorFromOriginal
    });

    const filters = ['setpts=PTS'];
    if (sourceFps > gifFps + 0.5) {
      filters.push(`fps=${gifFps}`);
    }
    if (targetDims && sourceMeta && targetDims.width > 0 && targetDims.height > 0 &&
        (targetDims.width !== sourceMeta.width || targetDims.height !== sourceMeta.height)) {
      filters.push(`scale=${targetDims.width}:${targetDims.height}:flags=lanczos`);
    }

    const filterBase = filters.join(',');
    const effectiveDither = normalizedProfile.effectiveDither || ditherMode;
    const paletteGenCmd = `"${toShellPath(ffmpegBin)}" -threads 0 -i "${toShellPath(conversionSourcePath)}" -vf "${filterBase},palettegen=max_colors=${normalizedProfile.paletteMaxColors}:stats_mode=full" -y "${toShellPath(palettePath)}"`;
    const paletteUseFilter = `${filterBase}[v];[v][1:v]paletteuse=dither=${effectiveDither}:diff_mode=rectangle`;
    const ffmpegCmdHwAccel = `"${toShellPath(ffmpegBin)}" -hwaccel videotoolbox -vsync 0 -threads 0 -i "${toShellPath(conversionSourcePath)}" -i "${toShellPath(palettePath)}" -lavfi "${paletteUseFilter}" -threads 0 "${toShellPath(tempGifPath)}" -y`;
    const ffmpegCmdSoftware = `"${toShellPath(ffmpegBin)}" -vsync 0 -threads 0 -i "${toShellPath(conversionSourcePath)}" -i "${toShellPath(palettePath)}" -lavfi "${paletteUseFilter}" -threads 0 "${toShellPath(tempGifPath)}" -y`;

    log(`   ⚙️  共享档位 ${normalizedProfile.label}: fpsCap=${normalizedProfile.videoFpsCap} colors=${normalizedProfile.paletteMaxColors} dither=${effectiveDither} lossy=${normalizedProfile.lossy}`);

    await runPulse(
      () => execAsync(paletteGenCmd, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: Math.max(30000, normalizedProfile.paletteGenTimeoutMs)
      }),
      {
        startPercent: progressStart,
        endPercent: progressStart + Math.max(10, Math.round(progressSpan * 0.35)),
        stageDetail: `palettegen:${normalizedProfile.label}`,
        approxDurationMs: normalizedProfile.paletteGenTimeoutMs
      }
    );
    checkCancelled();

    try {
      await runPulse(
        () => execAsync(ffmpegCmdHwAccel, {
          maxBuffer: 200 * 1024 * 1024,
          timeout: Math.max(60000, normalizedProfile.paletteUseTimeoutMs)
        }),
        {
          startPercent: progressStart + Math.max(12, Math.round(progressSpan * 0.38)),
          endPercent: progressStart + Math.max(24, Math.round(progressSpan * 0.78)),
          stageDetail: `paletteuse:${normalizedProfile.label}`,
          approxDurationMs: normalizedProfile.paletteUseTimeoutMs
        }
      );
    } catch (_) {
      await runPulse(
        () => execAsync(ffmpegCmdSoftware, {
          maxBuffer: 200 * 1024 * 1024,
          timeout: Math.max(60000, normalizedProfile.paletteUseTimeoutMs)
        }),
        {
          startPercent: progressStart + Math.max(12, Math.round(progressSpan * 0.38)),
          endPercent: progressStart + Math.max(24, Math.round(progressSpan * 0.78)),
          stageDetail: `paletteuse:${normalizedProfile.label}`,
          approxDurationMs: normalizedProfile.paletteUseTimeoutMs
        }
      );
    }

    checkCancelled();
    if (!fs.existsSync(tempGifPath) || fs.statSync(tempGifPath).size < 100) {
      throw new Error('FFmpeg GIF 输出为空或过小');
    }

    const animatedFrameCount = await getAnimatedFrameCount(execAsync, ffprobeBin, tempGifPath);
    if (animatedFrameCount <= 1) {
      await execAsync(ffmpegCmdSoftware, {
        maxBuffer: 200 * 1024 * 1024,
        timeout: Math.max(60000, normalizedProfile.paletteUseTimeoutMs)
      });
    }

    checkCancelled();

    if (optimizeOutput && gifsicleBin) {
      const preStats = fs.statSync(tempGifPath);
      const gifsicleTimeout = Math.max(
        60000,
        Math.ceil(preStats.size / (1024 * 1024)) * normalizedProfile.gifsicleTimeoutPerMbMs
      );
      await runPulse(
        () => execAsync(
          `"${toShellPath(gifsicleBin)}" -O3 --lossy=${normalizedProfile.lossy} --no-conserve-memory --no-comments --no-names --no-extensions "${toShellPath(tempGifPath)}" -o "${toShellPath(optimizedGifPath)}"`,
          { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout }
        ),
        {
          startPercent: progressStart + Math.max(26, Math.round(progressSpan * 0.82)),
          endPercent: progressEnd,
          stageDetail: `gifsicle:${normalizedProfile.label}`,
          approxDurationMs: gifsicleTimeout
        }
      );
    }

    if (!optimizeOutput) {
      if (!fs.existsSync(optimizedGifPath)) {
        fs.copyFileSync(tempGifPath, optimizedGifPath);
      }
    } else if (!fs.existsSync(optimizedGifPath)) {
      fs.copyFileSync(tempGifPath, optimizedGifPath);
    }

    return normalizedProfile;
  };

  try {
    for (const profile of plan.profiles) {
      const normalizedProfile = normalizeAttemptProfile(profile, ditherMode);
      lastProfile = normalizedProfile;
      try {
        const usedProfile = await encodeWithProfile(normalizedProfile);
        const finalStats = fs.statSync(optimizedGifPath);
        return {
          outputPath: optimizedGifPath,
          sizeBytes: finalStats.size,
          plan,
          profile: usedProfile,
          sourceMeta,
          totalFrames
        };
      } catch (error) {
        lastError = error;
        try { if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath); } catch (_) {}
        try { if (fs.existsSync(tempGifPath)) fs.unlinkSync(tempGifPath); } catch (_) {}
        try { if (optimizeOutput && fs.existsSync(optimizedGifPath)) fs.unlinkSync(optimizedGifPath); } catch (_) {}
        if (error && error.code === 'CONVERSION_ABORTED') throw error;
        log(`   ⚠️  档位失败，降档重试: ${normalizedProfile.label} (${error.message})`);
      }
    }

    const fallbackVideoPath = path.join(tempDir, 'fallback-compressed.mp4');
    const fallbackCompressCmd = `"${toShellPath(ffmpegBin)}" -threads 0 -i "${toShellPath(conversionSourcePath)}" -vf "setpts=PTS" -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -an -movflags +faststart -y "${toShellPath(fallbackVideoPath)}"`;
    try {
      log('   ⚠️  主档位全部失败，尝试共享保底压缩路径...');
      await execAsync(fallbackCompressCmd, { timeout: 180000, maxBuffer: 120 * 1024 * 1024 });
      if (!fs.existsSync(fallbackVideoPath) || fs.statSync(fallbackVideoPath).size === 0) {
        throw new Error('保底压缩视频为空');
      }

      const compressedMeta = await probeVideoMeta(execAsync, ffprobeBin, fallbackVideoPath);
      const fallbackProfile = {
        ...lastProfile,
        label: `${lastProfile.label}-fallback`,
        videoFpsCap: clamp((lastProfile.videoFpsCap || 12) - 3, 8, lastProfile.videoFpsCap || 12),
        paletteMaxColors: clamp((lastProfile.paletteMaxColors || 128) - 32, 96, 256),
        effectiveDither: 'none',
        lossy: clamp((lastProfile.lossy || 94) + 8, 72, 130),
        paletteGenTimeoutMs: Math.max(20000, Math.round((lastProfile.paletteGenTimeoutMs || 45000) * 0.75)),
        paletteUseTimeoutMs: Math.max(60000, Math.round((lastProfile.paletteUseTimeoutMs || 120000) * 0.75)),
        scaleDivisor: Math.max(4, (lastProfile.scaleDivisor || 4) + 1)
      };

      const compressedSourcePath = fallbackVideoPath;
      const compressedSourceMeta = compressedMeta || await probeVideoMeta(execAsync, ffprobeBin, compressedSourcePath);
      const compressedResult = await (async () => {
        const normalizedProfile = normalizeAttemptProfile(fallbackProfile, ditherMode);
        const localTargetDims = buildTargetDimensions({
          sourceMeta: compressedSourceMeta,
          targetWidth,
          targetHeight,
          scaleDivisor: normalizedProfile.scaleDivisor,
          sourceScaleFactor: halfScaleResult.applied ? halfScaleResult.scaleFactorFromOriginal : 1
        });

        const filters = ['setpts=PTS'];
        const compressedFps = compressedSourceMeta?.fps || normalizedProfile.videoFpsCap;
        const gifFps = Math.min(compressedFps, normalizedProfile.videoFpsCap);
        if (compressedFps > gifFps + 0.5) filters.push(`fps=${gifFps}`);
        if (localTargetDims && compressedSourceMeta && (localTargetDims.width !== compressedSourceMeta.width || localTargetDims.height !== compressedSourceMeta.height)) {
          filters.push(`scale=${localTargetDims.width}:${localTargetDims.height}:flags=lanczos`);
        }
        const filterBase = filters.join(',');
        const localPalette = path.join(tempDir, 'fallback-palette.png');
        const localTempGif = optimizeOutput ? path.join(tempDir, 'fallback-encoded.gif') : outputPath;
        const localOutputGif = optimizeOutput ? outputPath : localTempGif;
        const paletteGenCmd = `"${toShellPath(ffmpegBin)}" -threads 0 -i "${toShellPath(compressedSourcePath)}" -vf "${filterBase},palettegen=max_colors=${normalizedProfile.paletteMaxColors}:stats_mode=full" -y "${toShellPath(localPalette)}"`;
        const paletteUseFilter = `${filterBase}[v];[v][1:v]paletteuse=dither=${normalizedProfile.effectiveDither}:diff_mode=rectangle`;
        const ffmpegCmdSoftware = `"${toShellPath(ffmpegBin)}" -vsync 0 -threads 0 -i "${toShellPath(compressedSourcePath)}" -i "${toShellPath(localPalette)}" -lavfi "${paletteUseFilter}" -threads 0 "${toShellPath(localTempGif)}" -y`;

        await execAsync(paletteGenCmd, { timeout: normalizedProfile.paletteGenTimeoutMs, maxBuffer: 50 * 1024 * 1024 });
        await execAsync(ffmpegCmdSoftware, { timeout: normalizedProfile.paletteUseTimeoutMs, maxBuffer: 200 * 1024 * 1024 });
        if (optimizeOutput && gifsicleBin) {
          const preStats = fs.statSync(localTempGif);
          const gifsicleTimeout = Math.max(60000, Math.ceil(preStats.size / (1024 * 1024)) * normalizedProfile.gifsicleTimeoutPerMbMs);
          await execAsync(
            `"${toShellPath(gifsicleBin)}" -O3 --lossy=${normalizedProfile.lossy} --no-conserve-memory --no-comments --no-names --no-extensions "${toShellPath(localTempGif)}" -o "${toShellPath(localOutputGif)}"`,
            { timeout: gifsicleTimeout, maxBuffer: 200 * 1024 * 1024 }
          );
        }
        if (!fs.existsSync(localOutputGif)) {
          fs.copyFileSync(localTempGif, localOutputGif);
        }
        return normalizedProfile;
      })();

      const finalStats = fs.statSync(optimizedGifPath);
      return {
        outputPath: optimizedGifPath,
        sizeBytes: finalStats.size,
        plan,
        profile: compressedResult,
        sourceMeta: compressedMeta || sourceMeta,
        totalFrames
      };
    } catch (fallbackError) {
      if (fallbackError && fallbackError.code === 'CONVERSION_ABORTED') throw fallbackError;
      if (lastError) throw lastError;
      throw fallbackError;
    }
  } finally {
    try { if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath); } catch (_) {}
  }
}

module.exports = {
  transcodeVideoToGif,
  probeVideoMeta
};
