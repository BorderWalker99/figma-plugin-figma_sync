const os = require('os');

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getAdaptiveRuntimeConfig(mediaTuning = {}) {
  const cfg = mediaTuning.adaptiveRuntime || {};
  return {
    mediumLoadPerCpu: num(cfg.mediumLoadPerCpu, 0.6),
    highLoadPerCpu: num(cfg.highLoadPerCpu, 0.9),
    criticalLoadPerCpu: num(cfg.criticalLoadPerCpu, 1.15),
    lowCoreCount: Math.max(2, Math.round(num(cfg.lowCoreCount, 4))),
    softUltraTriggerMb: num(cfg.softUltraTriggerMb, 90),
    criticalUltraTriggerMb: num(cfg.criticalUltraTriggerMb, 60),
    lowCoreIdleUltraTriggerMb: num(cfg.lowCoreIdleUltraTriggerMb, 75),
    baseVideoTimeoutMs: Math.max(180000, Math.round(num(cfg.baseVideoTimeoutMs, 480000))),
    highPressureVideoTimeoutMs: Math.max(240000, Math.round(num(cfg.highPressureVideoTimeoutMs, 600000))),
    criticalPressureVideoTimeoutMs: Math.max(300000, Math.round(num(cfg.criticalPressureVideoTimeoutMs, 720000))),
    exportFastMinFrames: Math.max(60, Math.round(num(cfg.exportFastMinFrames, 180))),
    exportFastMinPixels: Math.max(1000000, Math.round(num(cfg.exportFastMinPixels, 3000000))),
    lowCoreExportFastMinFrames: Math.max(60, Math.round(num(cfg.lowCoreExportFastMinFrames, 140))),
    lowCoreExportFastMinPixels: Math.max(1000000, Math.round(num(cfg.lowCoreExportFastMinPixels, 2500000)))
  };
}

function getSystemPressure(mediaTuning = {}) {
  const cfg = getAdaptiveRuntimeConfig(mediaTuning);
  const cpus = os.cpus() || [];
  const cpuCount = Math.max(1, cpus.length || 1);
  const loadavg = (typeof os.loadavg === 'function') ? os.loadavg() : [0, 0, 0];
  const load1 = Number.isFinite(loadavg[0]) ? loadavg[0] : 0;
  const loadPerCpu = cpuCount > 0 ? load1 / cpuCount : load1;

  let level = 'low';
  if (loadPerCpu >= cfg.criticalLoadPerCpu) {
    level = 'critical';
  } else if (loadPerCpu >= cfg.highLoadPerCpu) {
    level = 'high';
  } else if (loadPerCpu >= cfg.mediumLoadPerCpu) {
    level = 'medium';
  }

  let recommendedTierBump = 0;
  if (level === 'high') recommendedTierBump = 1;
  if (level === 'critical') recommendedTierBump = 2;
  if (cpuCount <= cfg.lowCoreCount && level !== 'low') {
    recommendedTierBump += 1;
  }

  const label = `${level}|load=${load1.toFixed(2)}|perCpu=${loadPerCpu.toFixed(2)}|cpu=${cpuCount}`;
  return {
    cpuCount,
    load1,
    loadPerCpu,
    level,
    label,
    lowCoreCount: cfg.lowCoreCount,
    recommendedTierBump: clamp(recommendedTierBump, 0, 3)
  };
}

function getDynamicUltraTriggerMb(mediaTuning = {}, { sizeMB = 0, pressure = null } = {}) {
  const thresholds = mediaTuning.thresholds || {};
  const cfg = getAdaptiveRuntimeConfig(mediaTuning);
  const baseMb = Math.max(num(thresholds.largeVideoMb, 30), num(thresholds.ultraSpeedVideoMb, 150));
  let triggerMb = baseMb;

  if (pressure) {
    if (pressure.cpuCount <= cfg.lowCoreCount) {
      triggerMb = Math.min(triggerMb, cfg.lowCoreIdleUltraTriggerMb);
    }
    if (pressure.level === 'critical') {
      triggerMb = Math.min(triggerMb, cfg.criticalUltraTriggerMb);
    } else if (
      pressure.level === 'high' ||
      (pressure.level === 'medium' && pressure.cpuCount <= cfg.lowCoreCount)
    ) {
      triggerMb = Math.min(triggerMb, cfg.softUltraTriggerMb);
    }
  }

  if (sizeMB >= baseMb) {
    triggerMb = baseMb;
  }

  return Math.max(num(thresholds.largeVideoMb, 30), triggerMb);
}

function getAdaptiveVideoTimeoutMs(mediaTuning = {}, { fileSizeMB = 0, pressure = null } = {}) {
  const thresholds = mediaTuning.thresholds || {};
  const cfg = getAdaptiveRuntimeConfig(mediaTuning);
  const effectivePressure = pressure || getSystemPressure(mediaTuning);
  const dynamicUltraTriggerMb = getDynamicUltraTriggerMb(mediaTuning, { sizeMB: fileSizeMB, pressure: effectivePressure });
  let timeoutMs = cfg.baseVideoTimeoutMs;

  if (effectivePressure.level === 'high' || fileSizeMB >= dynamicUltraTriggerMb) {
    timeoutMs = Math.max(timeoutMs, cfg.highPressureVideoTimeoutMs);
  }
  if (effectivePressure.level === 'critical' || fileSizeMB >= num(thresholds.ultraSpeedVideoMb, 150)) {
    timeoutMs = Math.max(timeoutMs, cfg.criticalPressureVideoTimeoutMs);
  }

  return timeoutMs;
}

function dedupeProfiles(profiles) {
  const seen = new Set();
  const output = [];
  for (const profile of profiles) {
    const key = [
      profile.strategy,
      profile.fps,
      profile.scaleDivisor,
      profile.maxColors,
      profile.dither,
      profile.timeoutMs,
      profile.pass1TimeoutMs,
      profile.pass2TimeoutMs,
      profile.lossy
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(profile);
  }
  return output;
}

function normalizeScaleDivisor(value, fallback = 1) {
  return Math.max(1, Math.round(num(value, fallback)));
}

function buildWatcherAttemptProfiles(mediaTuning = {}, { videoSizeMB = 0, isLargeFile = false, pressure = null } = {}) {
  const watcher = mediaTuning.watcher || {};
  const thresholds = mediaTuning.thresholds || {};
  const effectivePressure = pressure || getSystemPressure(mediaTuning);
  const dynamicUltraTriggerMb = getDynamicUltraTriggerMb(mediaTuning, { sizeMB: videoSizeMB, pressure: effectivePressure });
  const shouldPreferFastStart = videoSizeMB >= dynamicUltraTriggerMb;

  const smallBase = {
    label: 'small-balanced',
    strategy: 'smallTwoPass',
    fps: num((watcher.smallTwoPass || {}).fps, 20),
    scaleDivisor: normalizeScaleDivisor((watcher.smallTwoPass || {}).scaleDivisor, 4),
    maxColors: 256,
    dither: 'sierra2_4a',
    pass1TimeoutMs: num((watcher.smallTwoPass || {}).pass1TimeoutMs, 30000),
    pass2TimeoutMs: num((watcher.smallTwoPass || {}).pass2TimeoutMs, 180000)
  };

  const largeCfg = shouldPreferFastStart ? (watcher.ultra || {}) : (watcher.largeSinglePass || {});
  const largeBase = {
    label: shouldPreferFastStart ? 'smart-ultra' : 'large-balanced',
    strategy: shouldPreferFastStart ? 'largeTwoPass' : 'largeSinglePass',
    fps: num(largeCfg.fps, shouldPreferFastStart ? 15 : 16),
    scaleDivisor: normalizeScaleDivisor(largeCfg.scaleDivisor, shouldPreferFastStart ? 5 : 4),
    maxColors: Math.round(num(largeCfg.maxColors, shouldPreferFastStart ? 144 : 192)),
    dither: largeCfg.dither || (shouldPreferFastStart ? 'bayer:bayer_scale=2' : 'bayer:bayer_scale=3'),
    timeoutMs: num(largeCfg.timeoutMs, shouldPreferFastStart ? 210000 : 300000)
  };

  const baseProfile = (isLargeFile || shouldPreferFastStart) ? largeBase : smallBase;
  const ultraCfg = watcher.ultra || {};
  const fallbackDither = ultraCfg.fallbackDither || 'none';
  const tierSeed = clamp(
    effectivePressure.recommendedTierBump + (shouldPreferFastStart ? 1 : 0) + (videoSizeMB >= num(thresholds.ultraSpeedVideoMb, 150) ? 1 : 0),
    0,
    3
  );

  const profiles = [];
  for (let tier = tierSeed; tier <= 3; tier++) {
    if (baseProfile.strategy === 'smallTwoPass') {
      const fps = clamp(baseProfile.fps - tier * 3, 8, baseProfile.fps);
      const colorTier = Math.max(0, tier - 1);
      const clarityTier = Math.max(0, tier - 2);
      const scaleDivisor = normalizeScaleDivisor(baseProfile.scaleDivisor + clarityTier, baseProfile.scaleDivisor);
      const maxColors = clamp(baseProfile.maxColors - colorTier * 32, 64, 256);
      profiles.push({
        label: tier === 0 ? baseProfile.label : `small-degraded-${tier}`,
        strategy: 'smallTwoPass',
        fps,
        scaleDivisor,
        maxColors,
        dither: tier >= 2 ? 'none' : (tier === 1 ? fallbackDither : baseProfile.dither),
        pass1TimeoutMs: Math.max(20000, Math.round(baseProfile.pass1TimeoutMs * (tier >= 2 ? 0.7 : tier === 1 ? 0.85 : 1))),
        pass2TimeoutMs: Math.max(60000, Math.round(baseProfile.pass2TimeoutMs * (tier >= 2 ? 0.7 : tier === 1 ? 0.85 : 1)))
      });
      continue;
    }

    const fps = clamp(baseProfile.fps - tier * 3, 8, baseProfile.fps);
    const colorTier = Math.max(0, tier - 1);
    const clarityTier = Math.max(0, tier - 2);
    const scaleDivisor = normalizeScaleDivisor(baseProfile.scaleDivisor + clarityTier, baseProfile.scaleDivisor);
    const maxColors = clamp(baseProfile.maxColors - colorTier * 24, 64, 256);
    profiles.push({
      label: tier === 0 ? baseProfile.label : `large-degraded-${tier}`,
      strategy: baseProfile.strategy,
      fps,
      scaleDivisor,
      maxColors,
      dither: tier >= 2 ? 'none' : (tier === 1 ? fallbackDither : baseProfile.dither),
      timeoutMs: Math.max(90000, Math.round(baseProfile.timeoutMs * (tier >= 2 ? 0.7 : tier === 1 ? 0.85 : 1)))
    });
  }

  return {
    pressure: effectivePressure,
    dynamicUltraTriggerMb,
    shouldPreferFastStart,
    profiles: dedupeProfiles(profiles)
  };
}

function buildComposerAttemptProfiles(mediaTuning = {}, {
  requestedMode = 'auto',
  preSizeMB = 0,
  decisionSizeMB = null,
  frameCount = 0,
  pixels = 0,
  hasVideoLayers = false,
  gifAlgorithm = 'smooth_gradient'
} = {}) {
  const thresholds = mediaTuning.thresholds || {};
  const ct = mediaTuning.composer || {};
  const exportCfg = mediaTuning.composerExport || {};
  const triggerCfg = exportCfg.ultraTrigger || {};
  const effectivePressure = getSystemPressure(mediaTuning);
  const modeSizeMB = Number.isFinite(decisionSizeMB) ? decisionSizeMB : preSizeMB;
  const dynamicUltraTriggerMb = getDynamicUltraTriggerMb(mediaTuning, { sizeMB: modeSizeMB, pressure: effectivePressure });
  const minPixels = num(triggerCfg.minPixels, 3500000);
  const minFrames = num(triggerCfg.minFrames, 220);
  const minScore = num(triggerCfg.minScore, 12000000);
  const runtimeCfg = getAdaptiveRuntimeConfig(mediaTuning);
  const isLowCoreMachine = effectivePressure.cpuCount <= runtimeCfg.lowCoreCount;
  const lowCoreFastTriggerMb = Math.min(runtimeCfg.softUltraTriggerMb, runtimeCfg.lowCoreIdleUltraTriggerMb);
  const isLegacyIntelMac = process.platform === 'darwin' && process.arch === 'x64';

  let score = pixels;
  if (frameCount > 0) score *= Math.min(6, Math.max(1, frameCount / 120));
  if (hasVideoLayers) score *= 1.15;

  let autoFast =
    modeSizeMB >= dynamicUltraTriggerMb ||
    pixels >= minPixels ||
    frameCount >= minFrames ||
    score >= minScore;

  if (!autoFast && (effectivePressure.level !== 'low' || isLowCoreMachine)) {
    autoFast =
      modeSizeMB >= (isLowCoreMachine ? lowCoreFastTriggerMb : runtimeCfg.softUltraTriggerMb) ||
      frameCount >= (isLowCoreMachine ? runtimeCfg.lowCoreExportFastMinFrames : runtimeCfg.exportFastMinFrames) ||
      pixels >= (isLowCoreMachine ? runtimeCfg.lowCoreExportFastMinPixels : runtimeCfg.exportFastMinPixels);
  }

  if (!autoFast && isLegacyIntelMac) {
    autoFast =
      modeSizeMB >= Math.max(45, lowCoreFastTriggerMb - 10) ||
      frameCount >= Math.max(120, runtimeCfg.lowCoreExportFastMinFrames - 20) ||
      pixels >= Math.max(1600000, runtimeCfg.lowCoreExportFastMinPixels - 600000);
  }

  const normalizedRequestedMode = (requestedMode === 'fast' || requestedMode === 'quality') ? requestedMode : 'auto';
  const baseMode = normalizedRequestedMode === 'auto' ? (autoFast ? 'fast' : 'quality') : normalizedRequestedMode;

  const makeProfile = (mode, tierBump = 0) => {
    const modeCfg = (mode === 'fast' ? exportCfg.fast : exportCfg.quality) || {};
    let videoFpsCap = num(modeCfg.fpsCap, num(ct.fpsCap, mode === 'fast' ? 24 : 60));
    if (score > 12000000 || modeSizeMB > 80) videoFpsCap = num(modeCfg.fpsCapXLarge, num(ct.fpsCapXLarge, mode === 'fast' ? 12 : 15));
    else if (score > 6000000 || modeSizeMB > 40) videoFpsCap = num(modeCfg.fpsCapLarge, num(ct.fpsCapLarge, mode === 'fast' ? 16 : 30));
    else if (score > 2500000 || modeSizeMB > 20) videoFpsCap = num(modeCfg.fpsCapMedium, num(ct.fpsCapMedium, mode === 'fast' ? 20 : 50));

    let lossy = num(modeCfg.lossyBase, mode === 'fast' ? 94 : 80);
    if (score > 12000000 || modeSizeMB > 80) lossy = num(modeCfg.lossyXLarge, mode === 'fast' ? 110 : 102);
    else if (score > 6000000 || modeSizeMB > 40) lossy = num(modeCfg.lossyLarge, mode === 'fast' ? 106 : 94);
    else if (score > 2500000 || modeSizeMB > 20) lossy = num(modeCfg.lossyMedium, mode === 'fast' ? 100 : 88);
    else if (score < 1200000 && modeSizeMB < 8 && mode !== 'fast') lossy = Math.min(lossy, 72);

    if (gifAlgorithm === 'less_noise') lossy -= 8;
    if (gifAlgorithm === 'smooth_gradient') lossy += 4;

    const timeoutScale = num(modeCfg.timeoutScale, mode === 'fast' ? 0.65 : 1.0);
    const pipelinePerFrameMs = num(modeCfg.pipelinePerFrameMs, mode === 'fast' ? 3500 : 5000);
    const paletteGenTimeoutMs = num(modeCfg.paletteGenTimeoutMs, mode === 'fast' ? 45000 : 60000);
    const paletteUseTimeoutMs = num(modeCfg.paletteUseTimeoutMs, mode === 'fast' ? 90000 : 120000);
    const gifsicleTimeoutPerMbMs = num(modeCfg.gifsicleTimeoutPerMbMs, mode === 'fast' ? 3200 : 5000);
    const colorTier = Math.max(0, tierBump - 1);

    return {
      mode,
      label: `${mode}-tier-${tierBump}`,
      // 有损优先级：帧率 > 颜色/压缩强度；导出阶段默认不主动降目标尺寸
      videoFpsCap: clamp(videoFpsCap - tierBump * 3, 8, videoFpsCap),
      lossy: clamp(Math.round(lossy + colorTier * 6), 60, 130),
      timeoutScale: clamp(timeoutScale - tierBump * 0.08, 0.4, 1.2),
      pipelinePerFrameMs: Math.max(1800, Math.round(pipelinePerFrameMs * (tierBump >= 2 ? 0.7 : tierBump === 1 ? 0.82 : 1))),
      paletteGenTimeoutMs: Math.max(20000, Math.round(paletteGenTimeoutMs * (tierBump >= 2 ? 0.7 : tierBump === 1 ? 0.82 : 1))),
      paletteUseTimeoutMs: Math.max(45000, Math.round(paletteUseTimeoutMs * (tierBump >= 2 ? 0.7 : tierBump === 1 ? 0.82 : 1))),
      gifsicleTimeoutPerMbMs: Math.max(2000, Math.round(gifsicleTimeoutPerMbMs * (tierBump >= 2 ? 0.75 : tierBump === 1 ? 0.85 : 1))),
      paletteMaxColors: clamp((mode === 'fast' ? 240 : 256) - colorTier * 32, 112, 256),
      effectiveDither: tierBump >= 2 ? 'none' : null
    };
  };

  const compatibilityTierBump =
    isLegacyIntelMac && (modeSizeMB >= 45 || frameCount >= 160 || pixels >= 1800000) ? 1 : 0;
  const lowCoreLargeVideoBump =
    isLowCoreMachine && modeSizeMB >= 90 ? 1 : 0;
  const tierSeed = clamp(
    effectivePressure.recommendedTierBump + compatibilityTierBump + lowCoreLargeVideoBump,
    0,
    2
  );
  const profiles = [];
  if (baseMode === 'quality') {
    profiles.push(makeProfile('quality', tierSeed));
    profiles.push(makeProfile('fast', tierSeed));
  } else {
    profiles.push(makeProfile('fast', tierSeed));
  }
  profiles.push(makeProfile('fast', tierSeed + 1));
  profiles.push(makeProfile('fast', tierSeed + 2));

  return {
    pressure: effectivePressure,
    dynamicUltraTriggerMb,
    baseMode,
    autoFast,
    score,
    profiles: dedupeProfiles(profiles)
  };
}

module.exports = {
  getSystemPressure,
  getDynamicUltraTriggerMb,
  getAdaptiveVideoTimeoutMs,
  buildWatcherAttemptProfiles,
  buildComposerAttemptProfiles
};
