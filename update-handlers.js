// update-handlers.js - Server-side update checking, downloading, and installation
// Extracted from server.js for maintainability

const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, spawn, execFileSync } = require('child_process');
const os = require('os');
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * Factory: inject server-level dependencies.
 * @param {object} deps
 * @param {Function} deps.sendToFigma - (targetGroup, data) => boolean
 * @param {object}   deps.WebSocket   - ws module (for readyState constants)
 * @returns {object} { checkAndNotifyUpdates, handlePluginUpdate, handleServerUpdate, handleFullUpdate }
 */
module.exports = function createUpdateHandlers({ sendToFigma, WebSocket }) {

function fetchGitHubJson(apiPath) {
  return new Promise((resolve, reject) => {
    const apiAgent = new https.Agent({ keepAlive: true, timeout: 15000 });
    const options = {
      agent: apiAgent,
      headers: {
        'User-Agent': 'ScreenSync-Updater/1.0',
        'Accept': 'application/vnd.github.v3+json',
        'Connection': 'keep-alive'
      },
      timeout: 15000
    };

    const req = https.get(`https://api.github.com${apiPath}`, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve({ ok: true, statusCode: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            reject(new Error('解析 GitHub API 响应失败'));
          }
        } else if (res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0') {
          reject(new Error('GitHub API 请求频率限制，请稍后重试'));
        } else {
          resolve({ ok: false, statusCode: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API 请求超时')); });
  });
}

// Shared helper: fetch latest release; if repo has no published release,
// fall back to latest tag and suppress noisy 404s.
async function fetchLatestRelease(repoPath) {
  const latestRelease = await fetchGitHubJson(`/repos/${repoPath}/releases/latest`);
  if (latestRelease.ok && latestRelease.data) {
    return { ...latestRelease.data, source: 'release' };
  }

  if (latestRelease.statusCode === 404) {
    const tags = await fetchGitHubJson(`/repos/${repoPath}/tags?per_page=1`);
    if (tags.ok && Array.isArray(tags.data) && tags.data.length > 0) {
      const latestTag = tags.data[0];
      return {
        tag_name: latestTag.name,
        assets: [],
        body: '',
        html_url: `https://github.com/${repoPath}/tags`,
        source: 'tag'
      };
    }
    throw new Error('仓库尚未发布 Release 或 Tag');
  }

  throw new Error(`GitHub API 返回错误: ${latestRelease.statusCode}`);
}

// 检查并通知更新（统一更新，不区分插件/服务器）
async function checkAndNotifyUpdates(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const releaseInfo = await fetchLatestRelease(repo);
    
    // 单一版本源：统一使用 VERSION.txt 作为当前已安装版本
    const currentServerVersion = getCurrentServerVersion();
    const latestVersion = releaseInfo.tag_name.replace(/^v/, '');
    
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
    
    // 统一更新判断：仅比较 latestVersion 与 VERSION.txt
    if (serverAsset) {
      const serverNeedsUpdate = !currentServerVersion || compareVersions(latestVersion, currentServerVersion) > 0;
      
      if (serverNeedsUpdate) {
        sendToFigma(targetGroup, {
          type: 'server-update-info',
          latestVersion: latestVersion,
          currentVersion: currentServerVersion || '未知',
          updateUrl: releaseInfo.html_url,
          releaseNotes: releaseInfo.body || '',
          hasUpdate: true,
          downloadUrl: serverAsset.browser_download_url
        });
      }
    }
    
  } catch (error) {
    if (/尚未发布 Release 或 Tag/.test(error.message)) {
      console.log('   ℹ️  当前仓库尚未发布可用更新，已跳过更新提示');
    } else {
      console.error('   ⚠️  检查更新失败:', error.message);
    }
  }
}

// 获取当前服务器版本
function getCurrentServerVersion() {
  try {
    const versionFile = path.join(__dirname, 'VERSION.txt');
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf8');
      // 兼容中文/英文版本字段（历史包中可能是 Version:）
      const match = content.match(/(?:版本|Version)\s*:\s*([^\n]+)/i);
      return match ? match[1].trim() : null;
    }
  } catch (error) {
    // 忽略错误
  }
  return null;
}

// 比较版本号
function compareVersions(v1, v2) {
  const normalizeVersion = (v) => {
    if (!v) return [0, 0, 0];
    const clean = String(v).trim().replace(/^v/i, '');
    const core = clean.split('-')[0];
    return core.split('.').map((part) => {
      const m = String(part).match(/\d+/);
      return m ? Number(m[0]) : 0;
    });
  };
  const parts1 = normalizeVersion(v1);
  const parts2 = normalizeVersion(v2);
  const maxLength = Math.max(parts1.length, parts2.length);
  
  for (let i = 0; i < maxLength; i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  return 0;
}

function addLocalDepsToPath() {
  const prependPathIfExists = (p) => {
    if (!p || !fs.existsSync(p)) return;
    const segments = String(process.env.PATH || '').split(path.delimiter);
    if (!segments.includes(p)) {
      process.env.PATH = `${p}${path.delimiter}${process.env.PATH || ''}`;
    }
  };
  addBundledRuntimeToPath();
  const localBin = path.join(os.homedir(), '.screensync', 'bin');
  const localNodeBin = path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin');
  const localImBin = path.join(os.homedir(), '.screensync', 'deps', 'imagemagick', 'bin');
  for (const p of [localBin, localNodeBin, localImBin]) prependPathIfExists(p);
}

function getPackageRootDirForUpdate() {
  return path.basename(__dirname) === '项目文件' ? path.dirname(__dirname) : __dirname;
}

function getRuntimeArchDirForUpdate() {
  return process.arch === 'arm64' ? 'apple' : 'intel';
}

function collectBundledRuntimeBinDirs() {
  const packageRoot = getPackageRootDirForUpdate();
  const archDir = getRuntimeArchDirForUpdate();
  const candidates = [
    path.join(packageRoot, 'runtime', 'bin'),
    path.join(packageRoot, 'runtime', archDir, 'bin'),
    path.join(__dirname, 'runtime', 'bin'),
    path.join(__dirname, 'runtime', archDir, 'bin')
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

function addBundledRuntimeToPath() {
  const bins = collectBundledRuntimeBinDirs();
  for (const binDir of bins) {
    const segments = String(process.env.PATH || '').split(path.delimiter);
    if (!segments.includes(binDir)) {
      process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;
    }
  }
}

function detectBundledOfflineRuntime() {
  addBundledRuntimeToPath();
  const bins = collectBundledRuntimeBinDirs();
  const resolved = {
    ready: false,
    node: null,
    npm: null,
    ffmpeg: null,
    gifsicle: null,
    magick: null
  };
  for (const binDir of bins) {
    const nodePath = path.join(binDir, 'node');
    const npmPath = path.join(binDir, 'npm');
    const ffmpegPath = path.join(binDir, 'ffmpeg');
    const gifsiclePath = path.join(binDir, 'gifsicle');
    const magickPath = fs.existsSync(path.join(binDir, 'magick'))
      ? path.join(binDir, 'magick')
      : (fs.existsSync(path.join(binDir, 'convert')) ? path.join(binDir, 'convert') : null);

    if (!resolved.node && fs.existsSync(nodePath)) resolved.node = nodePath;
    if (!resolved.npm && fs.existsSync(npmPath)) resolved.npm = npmPath;
    if (!resolved.ffmpeg && fs.existsSync(ffmpegPath)) resolved.ffmpeg = ffmpegPath;
    if (!resolved.gifsicle && fs.existsSync(gifsiclePath)) resolved.gifsicle = gifsiclePath;
    if (!resolved.magick && magickPath) resolved.magick = magickPath;
  }
  if (resolved.node && resolved.npm && resolved.ffmpeg && resolved.gifsicle && resolved.magick) {
    resolved.ready = true;
  }
  return resolved;
}

function syncBundledRuntimeFromExtractedDir(extractedDir) {
  const packageRoot = getPackageRootDirForUpdate();
  const runtimeSources = [
    path.join(extractedDir, 'runtime'),
    path.join(path.dirname(extractedDir), 'runtime')
  ];
  const runtimeSource = runtimeSources.find((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  if (!runtimeSource) return false;

  const runtimeDest = path.join(packageRoot, 'runtime');
  const resolveSafe = (p) => {
    try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
  };
  const srcResolved = resolveSafe(runtimeSource);
  const destResolved = resolveSafe(runtimeDest);
  if (srcResolved === destResolved) {
    console.log('   ℹ️  runtime 源目录与目标目录相同，跳过复制');
    addBundledRuntimeToPath();
    return true;
  }
  const relToSrc = path.relative(srcResolved, destResolved);
  if (relToSrc && !relToSrc.startsWith('..') && !path.isAbsolute(relToSrc)) {
    console.warn(`   ⚠️  检测到 runtime 目标位于源目录内部，已跳过复制: ${destResolved}`);
    return false;
  }

  fs.mkdirSync(runtimeDest, { recursive: true });
  // 仅复制目录内容，避免出现 runtime/runtime 嵌套或“copy into itself”错误
  for (const entry of fs.readdirSync(runtimeSource)) {
    const srcEntry = path.join(runtimeSource, entry);
    const destEntry = path.join(runtimeDest, entry);
    fs.cpSync(srcEntry, destEntry, { recursive: true, force: true });
  }
  addBundledRuntimeToPath();
  return true;
}

function syncBundledNodeModulesFromExtractedDir(extractedDir) {
  const source = path.join(extractedDir, 'node_modules');
  const dest = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return false;
  const resolveSafe = (p) => {
    try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
  };
  const srcResolved = resolveSafe(source);
  const destResolved = resolveSafe(dest);
  if (srcResolved === destResolved) {
    console.log('   ℹ️  node_modules 源目录与目标目录相同，跳过复制');
    return true;
  }
  const relToSrc = path.relative(srcResolved, destResolved);
  if (relToSrc && !relToSrc.startsWith('..') && !path.isAbsolute(relToSrc)) {
    console.warn(`   ⚠️  检测到 node_modules 目标位于源目录内部，已跳过复制: ${destResolved}`);
    return false;
  }

  fs.mkdirSync(dest, { recursive: true });
  // 仅复制目录内容，避免出现 node_modules/node_modules 嵌套或“copy into itself”错误
  for (const entry of fs.readdirSync(source)) {
    const srcEntry = path.join(source, entry);
    const destEntry = path.join(dest, entry);
    fs.cpSync(srcEntry, destEntry, { recursive: true, force: true });
  }
  return true;
}

async function commandExists(cmd) {
  try {
    await execPromise(`command -v ${cmd}`, { timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

function escapeAppleScriptString(input) {
  return String(input).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function runWithAdminIfNeeded(command, timeout = 600000) {
  try {
    return await execPromise(command, { timeout, env: process.env, cwd: __dirname });
  } catch (error) {
    const msg = `${error && error.message ? error.message : ''}\n${error && error.stderr ? error.stderr : ''}`;
    const needAdmin = /permission denied|operation not permitted|not writable|EACCES/i.test(msg);
    if (!needAdmin || process.platform !== 'darwin') {
      throw error;
    }
    const escaped = escapeAppleScriptString(command);
    return await execPromise(`osascript -e "do shell script \\"${escaped}\\" with administrator privileges"`, { timeout });
  }
}

function resolveNodeBinaryForUpdate() {
  addLocalDepsToPath();
  const runtimeBins = collectBundledRuntimeBinDirs();
  for (const runtimeBin of runtimeBins) {
    const candidate = path.join(runtimeBin, 'node');
    if (!fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['-v'], { stdio: 'ignore' });
      return candidate;
    } catch (_) {}
  }
  const candidates = [
    process.execPath,
    path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node'
  ];

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['-v'], { stdio: 'ignore' });
      return candidate;
    } catch (_) {}
  }
  return null;
}

function resolveNpmBinaryForUpdate() {
  addLocalDepsToPath();
  const runtimeBins = collectBundledRuntimeBinDirs();
  for (const runtimeBin of runtimeBins) {
    const candidate = path.join(runtimeBin, 'npm');
    if (!fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch (_) {}
  }
  const candidates = [
    path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'npm'),
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm'
  ];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch (_) {}
  }
  return null;
}

function isLegacyBrewSkippedUser() {
  if (process.platform !== 'darwin') return false;
  const darwinVersion = parseInt(os.release().split('.')[0], 10);
  return Number.isFinite(darwinVersion) && darwinVersion < 23; // macOS 13 and below
}

async function ensureHomebrewInstalledForUpdate(sendProgress) {
  if (await commandExists('brew')) return true;

  sendProgress('installing', '正在安装 Homebrew（用于补齐运行依赖）...');
  const installCmd = [
    'set -e',
    'SCRIPT_PATH="$(mktemp /tmp/screensync-brew-install.XXXXXX.sh)"',
    'cleanup(){ rm -f "$SCRIPT_PATH" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'SOURCES=(',
    '"https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/install/raw/HEAD/install.sh"',
    '"https://mirrors.ustc.edu.cn/homebrew/install/raw/HEAD/install.sh"',
    '"https://cdn.jsdelivr.net/gh/Homebrew/install@HEAD/install.sh"',
    '"https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"',
    ')',
    'OK=0',
    'for src in "${SOURCES[@]}"; do',
    '  if curl -fL --connect-timeout 12 --max-time 45 --retry 2 --retry-all-errors "$src" -o "$SCRIPT_PATH" >/dev/null 2>&1; then',
    '    chmod +x "$SCRIPT_PATH" 2>/dev/null || true',
    '    OK=1',
    '    break',
    '  fi',
    'done',
    'if [ "$OK" -ne 1 ]; then',
    '  echo "download-homebrew-script-failed"',
    '  exit 1',
    'fi',
    'NONINTERACTIVE=1 /bin/bash "$SCRIPT_PATH"'
  ].join(' && ');

  await runWithAdminIfNeeded(installCmd, 25 * 60 * 1000);

  // Load brew env when installed to default path.
  try {
    if (fs.existsSync('/opt/homebrew/bin/brew')) {
      process.env.PATH = `/opt/homebrew/bin:${process.env.PATH}`;
    } else if (fs.existsSync('/usr/local/bin/brew')) {
      process.env.PATH = `/usr/local/bin:${process.env.PATH}`;
    }
  } catch (_) {}

  return await commandExists('brew');
}

function triggerAutostartRepairAfterUpdate() {
  const setupScript = path.join(__dirname, 'setup-autostart.js');
  if (!fs.existsSync(setupScript)) {
    return false;
  }

  const nodeBin = resolveNodeBinaryForUpdate();
  if (!nodeBin) {
    return false;
  }

  const logFile = path.join(__dirname, '.update-autostart.log');
  let logFd = null;
  try {
    logFd = fs.openSync(logFile, 'a');
  } catch (_) {}

  const child = spawn(nodeBin, [setupScript, __dirname], {
    cwd: __dirname,
    detached: true,
    stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore',
    env: { ...process.env, SCREENSYNC_UPDATE_TRIGGER: '1' }
  });
  child.unref();

  if (logFd != null) {
    try { fs.closeSync(logFd); } catch (_) {}
  }
  return true;
}

async function ensureUpdateDependencies(targetGroup) {
  addLocalDepsToPath();
  const bundledRuntime = detectBundledOfflineRuntime();
  console.log('   🔎 [UpdateDeps] 离线 runtime 探测:', bundledRuntime.ready ? '完整可用' : '不完整');
  if (bundledRuntime.node) console.log(`   • node: ${bundledRuntime.node}`);
  if (bundledRuntime.npm) console.log(`   • npm: ${bundledRuntime.npm}`);
  if (bundledRuntime.ffmpeg) console.log(`   • ffmpeg: ${bundledRuntime.ffmpeg}`);
  if (bundledRuntime.gifsicle) console.log(`   • gifsicle: ${bundledRuntime.gifsicle}`);
  if (bundledRuntime.magick) console.log(`   • magick/convert: ${bundledRuntime.magick}`);
  const sendProgress = (status, message) => {
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, { type: 'update-progress', status, message });
    }
  };

  // 1) Node.js project dependencies (for newly introduced npm deps)
  sendProgress('checking', '正在检查运行依赖...');
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  const requiredNodeDeps = ['dotenv', 'ws', 'express', 'chokidar'];
  const missingNodeDeps = requiredNodeDeps.filter(dep => !fs.existsSync(path.join(nodeModulesPath, dep)));

  if (missingNodeDeps.length > 0) {
    sendProgress('installing', `正在安装 Node 依赖（${missingNodeDeps.length} 项）...`);
    const npmBin = resolveNpmBinaryForUpdate();
    if (npmBin) {
      await runWithAdminIfNeeded(`"${npmBin}" install --production --omit=dev --legacy-peer-deps --registry=https://registry.npmmirror.com`, 10 * 60 * 1000);
    } else {
      const nodeBin = resolveNodeBinaryForUpdate();
      const npmCliCandidates = [
        path.join(os.homedir(), '.screensync', 'deps', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(os.homedir(), '.screensync', 'deps', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      ];
      const npmCli = npmCliCandidates.find(p => fs.existsSync(p));
      if (!nodeBin || !npmCli) {
        throw new Error('未找到可用 npm，无法安装 Node 依赖。请先运行安装器补齐 Node 环境。');
      }
      await runWithAdminIfNeeded(`"${nodeBin}" "${npmCli}" install --production --omit=dev --legacy-peer-deps --registry=https://registry.npmmirror.com`, 10 * 60 * 1000);
    }
    const stillMissing = requiredNodeDeps.filter(dep => !fs.existsSync(path.join(nodeModulesPath, dep)));
    if (stillMissing.length > 0) {
      throw new Error(`依赖安装不完整，缺少: ${stillMissing.join(', ')}`);
    }
  }

  // 2) Runtime binaries required by update/new features
  addLocalDepsToPath();
  if (bundledRuntime.ready) {
    sendProgress('checking', '检测到离线胖包运行时，跳过系统依赖在线安装');
    console.log('   ✅ [UpdateDeps] 命中胖包 runtime，跳过 brew 依赖补装');
    return;
  }
  const hasConvert = await commandExists('convert');
  const hasMagick = await commandExists('magick');
  const missingBinaries = [];
  if (!(hasConvert || hasMagick)) missingBinaries.push('imagemagick');
  if (!(await commandExists('ffmpeg'))) missingBinaries.push('ffmpeg');
  if (!(await commandExists('gifsicle'))) missingBinaries.push('gifsicle');

  if (missingBinaries.length > 0) {
    console.log(`   ⚠️  [UpdateDeps] 缺少系统依赖: ${missingBinaries.join(', ')}`);
    const isLegacyMode = isLegacyBrewSkippedUser();
    if (isLegacyMode) {
      // Legacy users intentionally skip Homebrew; keep update flow consistent with installer strategy.
      throw new Error(`检测到缺少运行依赖：${missingBinaries.join(', ')}。当前为 legacy 模式（跳过 Homebrew），请先通过安装器/应急脚本补齐本地依赖后再执行一键更新。`);
    }

    let hasBrew = await commandExists('brew');
    if (!hasBrew) {
      sendProgress('installing', '检测到缺少 Homebrew，正在自动安装...');
      console.log('   ↪️  [UpdateDeps] 未检测到 brew，开始自动安装');
      hasBrew = await ensureHomebrewInstalledForUpdate(sendProgress);
    }
    if (!hasBrew) {
      throw new Error(`自动安装 Homebrew 失败，无法补齐运行依赖：${missingBinaries.join(', ')}。请先手动安装 Homebrew 后重试更新。`);
    }
    sendProgress('installing', `正在安装运行依赖（${missingBinaries.join(', ')}）...`);
    console.log(`   ↪️  [UpdateDeps] brew install ${missingBinaries.join(' ')}`);
    await runWithAdminIfNeeded(`HOMEBREW_NO_AUTO_UPDATE=1 brew install ${missingBinaries.join(' ')}`, 20 * 60 * 1000);
    addLocalDepsToPath();

    const verifyConvert = await commandExists('convert');
    const verifyMagick = await commandExists('magick');
    const stillMissing = [];
    if (!(verifyConvert || verifyMagick)) stillMissing.push('imagemagick');
    if (!(await commandExists('ffmpeg'))) stillMissing.push('ffmpeg');
    if (!(await commandExists('gifsicle'))) stillMissing.push('gifsicle');
    if (stillMissing.length > 0) {
      throw new Error(`运行依赖安装失败：${stillMissing.join(', ')}`);
    }
  }
}

// Keep-alive agent for faster subsequent requests (connection reuse)
const downloadAgent = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 60000 });

// 支持重定向、进度报告、自动重试的下载函数
function downloadFileWithRedirect(url, destPath, onProgress = null, _retries = 3) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });

    const isGitHubApi = url.includes('api.github.com');
    const options = {
      agent: downloadAgent,
      headers: {
        'User-Agent': 'ScreenSync-Updater/1.0',
        'Accept': isGitHubApi ? 'application/vnd.github.v3+json' : 'application/octet-stream',
        'Connection': 'keep-alive'
      }
    };

    const request = https.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        response.resume();
        file.close();
        downloadFileWithRedirect(redirectUrl, destPath, onProgress, _retries)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        console.error(`   ❌ 下载失败: HTTP ${response.statusCode} - ${url}`);
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      let lastProgressTime = Date.now();
      let lastProgressPct = -1;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const now = Date.now();
        if (onProgress && (now - lastProgressTime > 300 || downloadedSize === totalSize)) {
          const progress = totalSize > 0 ? Math.floor((downloadedSize / totalSize) * 100) : 0;
          if (progress !== lastProgressPct) {
            onProgress(downloadedSize, totalSize, progress);
            lastProgressPct = progress;
          }
          lastProgressTime = now;
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        if (onProgress && totalSize > 0) {
          onProgress(totalSize, totalSize, 100);
        }
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) try { fs.unlinkSync(destPath); } catch (_) {}
      if (_retries > 1) {
        console.warn(`   ⚠️ 下载失败，${_retries - 1} 次重试剩余: ${err.message}`);
        setTimeout(() => {
          downloadFileWithRedirect(url, destPath, onProgress, _retries - 1)
            .then(resolve)
            .catch(reject);
        }, 1000);
      } else {
        console.error(`   ❌ 下载请求错误（已用尽重试）: ${err.message}`);
        reject(err);
      }
    });

    request.setTimeout(60000, () => {
      request.destroy();
      file.close();
      if (fs.existsSync(destPath)) try { fs.unlinkSync(destPath); } catch (_) {}
      if (_retries > 1) {
        console.warn(`   ⚠️ 下载超时，${_retries - 1} 次重试剩余`);
        setTimeout(() => {
          downloadFileWithRedirect(url, destPath, onProgress, _retries - 1)
            .then(resolve)
            .catch(reject);
        }, 1000);
      } else {
        console.error(`   ❌ 下载超时（已用尽重试）: ${url}`);
        reject(new Error('下载超时'));
      }
    });
  });
}

// 插件自动更新功能
async function handlePluginUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    
    // 通知用户开始更新
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    });
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const releaseInfo = await fetchLatestRelease(repo);
    
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
    
    // 通知用户正在下载
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'downloading',
      message: `正在下载 ${pluginAsset.name}...`
    });
    
    // 下载插件文件
    const downloadUrl = pluginAsset.browser_download_url;
    const pluginDir = path.join(__dirname, 'figma-plugin');
    const tempFile = path.join(__dirname, '.plugin-update-temp.zip');
    
    // 下载文件
    await downloadFileWithRedirect(downloadUrl, tempFile);
    console.log(`   ✅ 下载完成`);
    
    // 通知用户正在安装
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'installing',
      message: '正在安装更新...'
    });
    
    // 解压并覆盖插件文件（使用 Node.js 内置方法或 child_process）
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
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'completed',
      message: '更新完成！请重启插件以使用新版本',
      version: releaseInfo.tag_name
    });
    
    console.log(`   ✅ 插件更新完成: ${releaseInfo.tag_name}\n`);
    
  } catch (error) {
    console.error(`   ❌ 插件更新失败: ${error.message}`);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, {
        type: 'plugin-update-progress',
        status: 'error',
        message: `更新失败: ${error.message}`
      });
    }
  }
}

// 服务器自动更新功能
async function handleServerUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    
    // 通知用户开始更新
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    });
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const releaseInfo = await fetchLatestRelease(repo);
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 检测当前系统架构，查找对应的服务器更新包
    const arch = process.arch;
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
    
    if (!serverAsset) {
      throw new Error(`未找到适合 ${isAppleSilicon ? 'Apple Silicon' : 'Intel'} 的服务器包，请确保 Release 中包含 ScreenSync-Apple.tar.gz 或 ScreenSync-Intel.tar.gz`);
    }
    
    // 通知用户正在下载
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'downloading',
      message: `正在下载 ${serverAsset.name}...`
    });
    
    // 下载服务器包
    const downloadUrl = serverAsset.browser_download_url;
    const tempFile = path.join(__dirname, '.server-update-temp.tar.gz');
    const updateDir = path.join(__dirname, '.server-update');
    
    // 下载文件
    await downloadFileWithRedirect(downloadUrl, tempFile);
    console.log(`   ✅ 下载完成`);
    
    // 通知用户正在安装
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'installing',
      message: '正在安装更新...'
    });
    
    // 解压到临时目录
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    fs.mkdirSync(updateDir, { recursive: true });
    
    // 解压 tar.gz
    await execPromise(`tar -xzf "${tempFile}" -C "${updateDir}"`);
    console.log(`   ✅ 解压完成`);
    
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
      'update-handlers.js',
      'gif-composer.js',
      'image-processor.js',
      'icloud-watcher.js',
      'drive-watcher.js',
      'aliyun-watcher.js',
      'package.json'
    ];
    
    // 备份并更新文件
    // 动态查找解压后的目录（支持 ScreenSync-Apple、ScreenSync-Intel）
    let extractedDir = null;
    const possibleDirs = ['ScreenSync-Apple', 'ScreenSync-Intel'];
    for (const dirName of possibleDirs) {
      const testDir = path.join(updateDir, dirName);
      if (fs.existsSync(testDir)) {
        extractedDir = testDir;
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
            break;
          }
          // 检查子目录 项目文件/
          const projectFilesDir = path.join(itemPath, '项目文件');
          if (fs.existsSync(projectFilesDir) && fs.existsSync(path.join(projectFilesDir, 'server.js'))) {
            extractedDir = projectFilesDir;
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
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'completed',
      message: '更新完成！请重启服务器以使用新版本',
      version: releaseInfo.tag_name
    });
    
    console.log(`   ✅ 服务器更新完成: ${releaseInfo.tag_name}`);
    console.log(`   💡 请运行 'npm install' 安装新依赖（如有）`);
    console.log(`   💡 然后重启服务器\n`);
    
  } catch (error) {
    console.error(`   ❌ 服务器更新失败: ${error.message}`);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, {
        type: 'server-update-progress',
        status: 'error',
        message: `更新失败: ${error.message}`
      });
    }
  }
}

// 统一全量更新功能（插件 + 服务器所有代码）
async function handleFullUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  // 为整个更新流程添加总体超时（10分钟）
  const overallTimeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('更新超时（超过10分钟），请检查网络连接或稍后重试')), 600000);
  });
  
  const updateTask = (async () => {
    const updateStartTime = Date.now();
    // 通知用户开始更新
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    });
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const releaseInfo = await fetchLatestRelease(repo);
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 必须使用 Release Assets 中的架构包（ScreenSync-Apple / ScreenSync-Intel）
    let downloadUrl;
    let updateFilename;
    let updateSize = 0;
    
    // 检测当前系统架构
    const arch = process.arch; // 'arm64' for Apple Silicon, 'x64' for Intel
    const isAppleSilicon = arch === 'arm64';
    
    let updateAsset = null;
    
    if (isAppleSilicon) {
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
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
    
    // 通知用户正在下载
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'downloading',
      message: '正在下载更新包...'
    });
    
    // 下载更新包
    // const downloadUrl = updateAsset.browser_download_url; // 已定义
    const tempFile = path.join(__dirname, '.full-update-temp.tar.gz');
    const updateDir = path.join(__dirname, '.full-update');
    
    // 进度回调函数
    const onDownloadProgress = (downloaded, total, percent) => {
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        sendToFigma(targetGroup, {
          type: 'update-progress',
          status: 'downloading',
          message: `正在下载... ${percent}%`,
          progress: percent
        });
      }
    };

    await downloadFileWithRedirect(downloadUrl, tempFile, onDownloadProgress);
    
    const downloadedSize = fs.statSync(tempFile).size;
    console.log(`   ✅ 下载完成: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`);
    
    // 通知用户正在解压
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'extracting',
      message: '正在解压更新包...'
    });
    
    // 解压到临时目录
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    fs.mkdirSync(updateDir, { recursive: true });
    
    // 解压 tar.gz
    await execPromise(`tar -xzf "${tempFile}" -C "${updateDir}"`);
    console.log(`   ✅ 解压完成`);
    
    // 通知用户正在检查文件
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'checking',
      message: '正在检查文件变化...'
    });
    
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
    
    let extractedDir = findServerJs(updateDir);
    
    if (!extractedDir) {
        console.log('   ⚠️  未自动定位到根目录，尝试使用解压根目录');
        // 如果解压出来只有一个文件夹，进入该文件夹
        const extractedItems = fs.readdirSync(updateDir).filter(item => !item.startsWith('.'));
        
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

    const runtimeSynced = syncBundledRuntimeFromExtractedDir(extractedDir);
    if (runtimeSynced) {
      console.log('   ✅ 已同步离线 runtime（胖包）');
    } else {
      console.log('   ℹ️  更新包未携带 runtime，保留当前本地运行时');
    }
    const nodeModulesSynced = syncBundledNodeModulesFromExtractedDir(extractedDir);
    if (nodeModulesSynced) {
      console.log('   ✅ 已同步离线 node_modules');
    }
    
    // 备份现有文件
    const backupDir = path.join(__dirname, '.full-backup');
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(backupDir, { recursive: true });
    
    // 读取更新清单（由打包脚本生成），确保“打包什么就更新什么”
    const manifestPath = path.join(extractedDir, 'update-manifest.json');
    let allFiles = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest && Array.isArray(manifest.files)) {
          allFiles = manifest.files.filter((f) => {
            if (typeof f !== 'string' || !f) return false;
            if (f.includes('..')) return false;
            if (path.isAbsolute(f)) return false;
            return true;
          });
        }
      } catch (manifestError) {
        console.warn(`   ⚠️  update-manifest.json 解析失败，回退到内置清单: ${manifestError.message}`);
      }
    }

    // 兼容旧包：没有 update-manifest.json 时使用内置清单
    if (allFiles.length === 0) {
      allFiles = [
        'server.js',
        'start.js',
        'media-processing-tuning.js',
        'gif-composer.js',
        'image-processor.js',
        'googleDrive.js',
        'drive-watcher.js',
        'aliyunOSS.js',
        'aliyun-watcher.js',
        'icloud-watcher.js',
        'userConfig.js',
        'setup-autostart.js',
        'update-manager.js',
        'update-handlers.js',
        'com.screensync.server.plist',
        'package.json',
        'package-lock.json',
        'README.md',
        'MANUAL_INSTALL_LEGACY.md',
        'VERSION.txt',
        'figma-plugin/manifest.json',
        'figma-plugin/code.js',
        'figma-plugin/ui.html'
      ];
    }
    
    // 🚀 增量更新：只更新有变化的文件
    const crypto = require('crypto');

    const getFileHash = (filePath) => {
      try {
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      } catch (_) {
        return null;
      }
    };

    let updatedCount = 0;
    let skippedCount = 0;
    let newFilesCount = 0;

    for (const file of allFiles) {
      const srcPath = path.join(extractedDir, file);
      const destPath = path.join(__dirname, file);
      const backupPath = path.join(backupDir, file);

      let srcStat;
      try { srcStat = fs.statSync(srcPath); } catch (_) { continue; }
      if (!srcStat.isFile()) continue;

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });

      let destStat;
      try { destStat = fs.statSync(destPath); } catch (_) { destStat = null; }

      if (!destStat) {
        fs.copyFileSync(srcPath, destPath);
        newFilesCount++;
        updatedCount++;
        continue;
      }

      // Fast path: different size → must be different
      if (srcStat.size !== destStat.size) {
        fs.copyFileSync(destPath, backupPath);
        fs.copyFileSync(srcPath, destPath);
        updatedCount++;
        continue;
      }

      // Same size → hash compare
      if (getFileHash(srcPath) === getFileHash(destPath)) {
        skippedCount++;
        continue;
      }
      
      // 文件有变化，备份并更新
      fs.copyFileSync(destPath, backupPath);
      fs.copyFileSync(srcPath, destPath);
      updatedCount++;
    }
    
    console.log(`\n   📊 更新统计:`);
    console.log(`      • 更新文件: ${updatedCount} 个`);
    console.log(`      • 新增文件: ${newFilesCount} 个`);
    console.log(`      • 跳过文件: ${skippedCount} 个 (无变化)`);
    console.log(`      • 总计节省: ${skippedCount} 个文件的复制操作\n`);
    
    // 通知用户更新统计
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'installing',
      message: `正在更新文件... (${updatedCount} 个文件需要更新)`
    });

    // 在完成更新前自动补齐新增运行依赖（不打开终端）
    await ensureUpdateDependencies(targetGroup);
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    
    console.log(`\n✅ [Full Update] 全量更新完成！`);
    console.log(`   ✅ 成功更新 ${updatedCount} 个文件`);
    console.log(`   🔄 准备自动重启服务器以应用更新...\n`);
    
    // 通知用户更新完成（在重启前发送）
    if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, {
        type: 'update-progress',
        status: 'completed',
        message: `正在重连服务器(3-8秒)`,
        updatedCount: updatedCount,
        latestVersion: releaseInfo.tag_name // 发送最新版本号
      });
    }
    
    // 延迟 2 秒后自动重启服务器（让前端收到消息）
    setTimeout(() => {
      console.log(`\n🔄 [Full Update] 正在重启服务器以应用更新...`);

      // 优先走 setup-autostart 自修复：重建 launchd + 校验 8888 + 失败时直接拉起兜底
      const autostartTriggered = triggerAutostartRepairAfterUpdate();
      if (autostartTriggered) {
        console.log('   ✅ 已触发 setup-autostart 自修复任务（后台执行）');
        process.exit(0);
      }

      // 兜底：setup-autostart 不可用时，按原逻辑重启
      if (process.env.LAUNCHED_BY_LAUNCHD || fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents/com.screensync.server.plist'))) {
        console.log('   ✅ 检测到 launchd 服务，进程退出后将自动重启');
        process.exit(0);
      }

      console.log('   ✅ 手动重启服务器进程（兜底）');
      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      process.exit(0);
    }, 2000);
    
    console.log(`   ⏱️  总耗时: ${((Date.now() - updateStartTime) / 1000).toFixed(2)}秒`);
  })(); // 结束 updateTask
  
  // 应用总体超时
  try {
    await Promise.race([updateTask, overallTimeout]);
  } catch (error) {
    console.error(`   ❌ 全量更新失败: ${error.message}`);
    console.error('   错误堆栈:', error.stack);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      try {
        sendToFigma(targetGroup, {
          type: 'update-progress',
          status: 'error',
          message: `更新失败: ${error.message}`
        });
      } catch (sendError) {
        console.error('   ❌ 发送错误消息失败:', sendError.message);
      }
    }
  }
}


return { checkAndNotifyUpdates, getCurrentServerVersion, compareVersions, downloadFileWithRedirect, handlePluginUpdate, handleServerUpdate, handleFullUpdate };
};
