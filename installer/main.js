const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const { exec, spawn, execFile, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');

// 检测 macOS 版本
function getMacOSVersion() {
  try {
    const version = os.release(); // 例如: "22.6.0" 对应 macOS 13.5
    const major = parseInt(version.split('.')[0]);
    
    // macOS 版本映射 (Darwin kernel version -> macOS version)
    // 23.x = macOS 14 (Sonoma), 22.x = macOS 13 (Ventura), 21.x = macOS 12 (Monterey)
    // 20.x = macOS 11 (Big Sur), 19.x = macOS 10.15 (Catalina), 18.x = macOS 10.14 (Mojave)
    const versionMap = {
      25: { version: '15', name: 'Sequoia', supported: true },
      24: { version: '14', name: 'Sonoma', supported: true },
      23: { version: '14', name: 'Sonoma', supported: true },
      22: { version: '13', name: 'Ventura', supported: 'limited' },
      21: { version: '12', name: 'Monterey', supported: 'limited' },
      20: { version: '11', name: 'Big Sur', supported: 'limited' },
      19: { version: '10.15', name: 'Catalina', supported: false },
      18: { version: '10.14', name: 'Mojave', supported: false },
      17: { version: '10.13', name: 'High Sierra', supported: false }
    };
    
    return versionMap[major] || { version: 'Unknown', name: 'Unknown', supported: false };
  } catch (e) {
    console.error('Failed to detect macOS version:', e);
    return { version: 'Unknown', name: 'Unknown', supported: 'unknown' };
  }
}

// 允许在渲染进程中使用 remote
if (process.platform === 'darwin') {
  app.allowRendererProcessReuse = false;
}

// 全局错误处理，防止未捕获异常导致弹窗
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // 不做任何事，阻止默认的弹窗行为
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // 不做任何事，阻止默认的弹窗行为
});

// 尝试加载用户的 Shell 环境变量，确保能找到 NVM 管理的 Node
// 这对于 DMG 环境下运行至关重要，否则可能只能找到系统 Node，导致依赖不匹配
try {
  if (process.platform === 'darwin') {
    const shell = process.env.SHELL || '/bin/zsh';
    console.log('正在从 Shell 加载环境变量:', shell);
    
    // 使用 execSync 执行 Shell 命令获取环境变量
    // source ~/.zshrc (或 ~/.bash_profile) 可能会有输出，我们需要过滤掉
    const envOutput = require('child_process').execSync(`${shell} -l -c "env"`, { 
      encoding: 'utf8',
      timeout: 3000 // 3秒超时，防止 Shell 脚本卡住
    });
    
    const envLines = envOutput.split('\n');
    for (const line of envLines) {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        if (key && value && key !== '_' && key !== 'PWD' && key !== 'SHLVL') {
          // 仅更新不存在或 PATH 变量
          if (!process.env[key] || key === 'PATH') {
            process.env[key] = value;
          }
        }
      }
    }
    console.log('✅ 环境变量加载完成，当前 PATH:', process.env.PATH);
  }
} catch (error) {
  console.warn('⚠️  加载 Shell 环境变量失败:', error.message);
  // 失败不影响主流程，继续使用默认环境
}

let mainWindow;
let currentInstallPath = '';
let bundledRuntimeBinDirs = [];
const INSTALLER_MOCK = process.env.SCREENSYNC_INSTALLER_MOCK === '1';
const mockInstallerState = {
  permissionApproved: false,
  finalResult: 'success'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolvePackageRootFromInstallPath(installPath) {
  if (!installPath || typeof installPath !== 'string') return '';
  return path.resolve(installPath);
}

function getLegacyRuntimeRootFromInstallPath(installPath) {
  if (!installPath || typeof installPath !== 'string') return '';
  const normalized = path.resolve(installPath);
  if (path.basename(normalized) === '项目文件') {
    return path.join(path.dirname(normalized), 'runtime');
  }
  return '';
}

function getBundledRuntimeArchAliases() {
  return process.arch === 'arm64'
    ? ['apple', 'arm64']
    : ['intel', 'x64'];
}

function getBundledRuntimeRoots(installPath) {
  const packageRoot = resolvePackageRootFromInstallPath(installPath);
  const legacyRuntimeRoot = getLegacyRuntimeRootFromInstallPath(installPath);
  const candidates = [];

  if (packageRoot) {
    candidates.push(
      path.join(packageRoot, 'runtime'),
      path.join(packageRoot, 'embedded-runtime')
    );
  }
  if (legacyRuntimeRoot) {
    candidates.push(legacyRuntimeRoot);
  }

  return candidates.filter((dir, index) => (
    dir &&
    candidates.indexOf(dir) === index &&
    fs.existsSync(dir)
  ));
}

function ensureRuntimeInsideProject(installPath) {
  if (!installPath || typeof installPath !== 'string') return false;
  const projectRoot = path.resolve(installPath);
  const projectRuntime = path.join(projectRoot, 'runtime');
  const legacyRuntime = getLegacyRuntimeRootFromInstallPath(installPath);

  if (!legacyRuntime || !fs.existsSync(legacyRuntime) || projectRuntime === legacyRuntime) return false;

  try {
    if (!fs.existsSync(projectRuntime)) {
      try {
        fs.renameSync(legacyRuntime, projectRuntime);
        console.log('✅ 已将 runtime 迁移到项目目录:', projectRuntime);
        return true;
      } catch (_) {
        // Rename may fail跨分区，回退到复制。
      }
    }
    fs.mkdirSync(projectRuntime, { recursive: true });
    fs.cpSync(legacyRuntime, projectRuntime, { recursive: true, force: true });
    try { fs.rmSync(legacyRuntime, { recursive: true, force: true }); } catch (_) {}
    console.log('✅ 已将 legacy runtime 同步到项目目录:', projectRuntime);
    return true;
  } catch (error) {
    console.warn('⚠️ runtime 目录迁移失败，将继续使用现有路径:', error.message);
    return false;
  }
}

function collectBundledRuntimeBinDirs(installPath) {
  const runtimeRoots = getBundledRuntimeRoots(installPath);
  if (runtimeRoots.length === 0) return [];

  const candidates = [];
  for (const runtimeRoot of runtimeRoots) {
    candidates.push(
      path.join(runtimeRoot, 'bin'),
      path.join(runtimeRoot, 'node', 'bin')
    );
    for (const archName of getBundledRuntimeArchAliases()) {
      candidates.push(
        path.join(runtimeRoot, archName, 'bin'),
        path.join(runtimeRoot, archName, 'node', 'bin')
      );
    }
  }

  return candidates.filter((dir, index) => (
    candidates.indexOf(dir) === index &&
    fs.existsSync(dir)
  ));
}

function detectBundledRuntimeFolderStatus(installPath) {
  const packageRoot = resolvePackageRootFromInstallPath(installPath || currentInstallPath);
  const runtimeRoots = getBundledRuntimeRoots(installPath || currentInstallPath);
  const runtimeRoot = runtimeRoots[0] || (packageRoot ? path.join(packageRoot, 'runtime') : '');
  const bins = collectBundledRuntimeBinDirs(installPath || currentInstallPath);
  const result = {
    complete: false,
    packageRoot,
    runtimeRoot,
    runtimeRoots,
    bins,
    node: null,
    ffmpeg: null,
    ffprobe: null,
    gifsicle: null,
    magick: null,
    convert: null,
    missing: []
  };
  if (runtimeRoots.length === 0) {
    result.missing = ['runtime-folder'];
    return result;
  }

  for (const binDir of bins) {
    if (!result.node && fs.existsSync(path.join(binDir, 'node'))) result.node = path.join(binDir, 'node');
    if (!result.ffmpeg && fs.existsSync(path.join(binDir, 'ffmpeg'))) result.ffmpeg = path.join(binDir, 'ffmpeg');
    if (!result.ffprobe && fs.existsSync(path.join(binDir, 'ffprobe'))) result.ffprobe = path.join(binDir, 'ffprobe');
    if (!result.gifsicle && fs.existsSync(path.join(binDir, 'gifsicle'))) result.gifsicle = path.join(binDir, 'gifsicle');
    if (!result.convert && fs.existsSync(path.join(binDir, 'convert'))) result.convert = path.join(binDir, 'convert');
    if (!result.magick) {
      const magickCandidate = fs.existsSync(path.join(binDir, 'magick'))
        ? path.join(binDir, 'magick')
        : (fs.existsSync(path.join(binDir, 'convert')) ? path.join(binDir, 'convert') : null);
      if (magickCandidate) result.magick = magickCandidate;
    }
  }

  if (!result.node) result.missing.push('node');
  if (!result.ffmpeg) result.missing.push('ffmpeg');
  if (!result.gifsicle) result.missing.push('gifsicle');
  if (!result.magick) result.missing.push('imagemagick');
  result.complete = result.missing.length === 0;
  return result;
}

function collectBundledRuntimePermissionTargets(installPath) {
  const status = detectBundledRuntimeFolderStatus(installPath);
  const targets = new Set();

  for (const runtimeRoot of status.runtimeRoots || []) {
    targets.add(runtimeRoot);
  }
  for (const binDir of status.bins || []) {
    targets.add(binDir);
  }
  for (const executablePath of [status.node, status.ffmpeg, status.ffprobe, status.gifsicle, status.magick, status.convert]) {
    if (executablePath) targets.add(executablePath);
  }
  for (const addonPath of collectNativeNodeAddonPaths(installPath)) {
    targets.add(path.dirname(addonPath));
    targets.add(addonPath);
  }

  return Array.from(targets).filter(Boolean);
}

function collectNativeNodeAddonPaths(installPath) {
  return collectNativeNodeAddonDescriptors(installPath).map((item) => item.addonPath);
}

function collectNativeNodeAddonDescriptors(installPath) {
  const packageRoot = resolvePackageRootFromInstallPath(installPath || currentInstallPath);
  if (!packageRoot) return [];

  const nodeModulesRoot = path.join(packageRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesRoot)) return [];

  const results = [];
  const seen = new Set();
  const stack = [nodeModulesRoot];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      if (!entry || entry.name === '.bin') continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.node')) continue;
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      const owner = describeNativeAddonOwner(fullPath, nodeModulesRoot);
      results.push({
        addonPath: fullPath,
        packageRoot: owner.packageRoot,
        packageName: owner.packageName,
        label: owner.packageName
          ? `原生模块 ${owner.packageName}`
          : `原生模块 ${path.basename(fullPath)}`
      });
    }
  }

  return results;
}

function describeNativeAddonOwner(addonPath, nodeModulesRoot) {
  let currentDir = path.dirname(addonPath);
  const normalizedRoot = path.resolve(nodeModulesRoot);

  while (currentDir && currentDir.startsWith(normalizedRoot)) {
    const pkgPath = path.join(currentDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return {
          packageRoot: currentDir,
          packageName: pkg && pkg.name ? String(pkg.name) : ''
        };
      } catch (_) {
        return {
          packageRoot: currentDir,
          packageName: ''
        };
      }
    }
    if (currentDir === normalizedRoot) break;
    const parentDir = path.dirname(currentDir);
    if (!parentDir || parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return {
    packageRoot: '',
    packageName: ''
  };
}

function isLikelyGatekeeperBlock(text) {
  const normalized = String(text || '').toLowerCase();
  return [
    'developer cannot be verified',
    'apple could not verify',
    'cannot be opened because the developer cannot be verified',
    'is damaged and can\'t be opened',
    'is damaged and can’t be opened',
    'library load disallowed by system policy',
    'code signature invalid',
    'mapped file has no cdhash',
    'not valid for use in process',
    'operation not permitted',
    'spawn eperm',
    'killed: 9'
  ].some(marker => normalized.includes(marker));
}

function buildPermissionRetryGuidance(displayName, executablePath, details) {
  const failureClass = classifyRuntimeProbeFailure(executablePath, details);
  const gatekeeperHint = failureClass.needsApproval
    ? `macOS 拦截了 ${displayName} 的首次执行。`
    : `${displayName} 在安装阶段执行失败。`;

  return [
    `${gatekeeperHint}`,
    '',
    failureClass.needsApproval
      ? '请前往“系统设置 -> 隐私与安全性”，点击对应项目后的“仍要打开”，然后回到安装器重新检测。'
      : '这不是“仍要打开”授权问题，请先修复该组件或安装包内容，再重新检测。',
    failureClass.needsApproval
      ? '安装器会在安装阶段重新验证这些运行时工具，避免把权限问题拖到首次 GIF 导出或首次同步时才暴露。'
      : '安装器不会把这类运行时错误误判为已授权通过。',
    '',
    `可执行文件: ${executablePath}`,
    details ? `原始信息:\n${details}` : ''
  ].filter(Boolean).join('\n');
}

function buildPermissionBatchGuidance(failures = []) {
  const pending = failures.filter(Boolean);
  const approvalPending = pending.filter(item => item && item.needsApproval);
  const blocking = pending.filter(item => item && !item.needsApproval);
  const lines = [
    approvalPending.length > 0
      ? '请前往“系统设置 -> 隐私与安全性”，找到“安全性”分区，并依次点击下面这些项目对应的“仍要打开”。'
      : '安装器在预热运行时组件时检测到错误。',
    approvalPending.length > 0
      ? '完成后回到安装器，点击“重新检测”；只有当下面所有项目都通过预热验证后，才可以继续后续安装流程。'
      : '这些错误不是“仍要打开”授权问题，仅打开系统设置无法解决，需要先修复对应组件。',
    ''
  ];

  if (approvalPending.length > 0) {
    lines.push('待完成授权的运行时工具:');
    for (const item of approvalPending) {
      lines.push(`- ${item.label}`);
      if (item.path) {
        lines.push(`  路径: ${item.path}`);
      }
    }
    lines.push('');
    lines.push('如果“隐私与安全性”页面里暂时没有出现对应按钮，请先回到安装器重新检测一次，让 macOS 记录这些被拦截的工具。');
  }

  if (blocking.length > 0) {
    lines.push('以下项目存在非授权类错误:');
    for (const item of blocking) {
      lines.push(`- ${item.label}`);
      if (item.path) {
        lines.push(`  路径: ${item.path}`);
      }
      if (item.detail) {
        lines.push(`  详情: ${item.detail.split('\n')[0]}`);
      }
    }
  }

  const firstFailure = pending.find(item => item && item.detail);
  if (firstFailure) {
    lines.push('');
    lines.push(`最近一次失败信息（${firstFailure.label}）:`);
    lines.push(firstFailure.detail);
  }

  return lines.join('\n');
}

function hasQuarantineAttribute(targetPath) {
  if (process.platform !== 'darwin' || !targetPath || !fs.existsSync(targetPath)) return false;
  try {
    const result = spawnSync('xattr', ['-p', 'com.apple.quarantine', targetPath], {
      encoding: 'utf8',
      timeout: 5000
    });
    return result.status === 0 && String(result.stdout || '').trim().length > 0;
  } catch (_) {
    return false;
  }
}

function classifyRuntimeProbeFailure(targetPath, detail) {
  const hasQuarantine = hasQuarantineAttribute(targetPath);
  const looksLikeGatekeeper = isLikelyGatekeeperBlock(detail);
  return {
    hasQuarantine,
    looksLikeGatekeeper,
    needsApproval: hasQuarantine || looksLikeGatekeeper
  };
}

async function clearBundledRuntimeQuarantine(installPath, sendLog = () => {}) {
  const targets = collectBundledRuntimePermissionTargets(installPath);
  if (targets.length === 0) {
    sendLog('⚠️ 未找到 bundled runtime，跳过隔离属性清理。');
    return { success: false, targets: [] };
  }

  sendLog('🔐 正在清理内置运行时的隔离属性...');
  for (const target of targets) {
    try {
      await execPromise(`xattr -dr com.apple.quarantine "${target}" 2>/dev/null || true`, { timeout: 20000 });
      sendLog(`   已处理: ${target}`);
    } catch (_) {
      sendLog(`   跳过: ${target}`);
    }
  }
  return { success: true, targets };
}

function applyBundledRuntimeEnv(installPath) {
  ensureRuntimeInsideProject(installPath);
  bundledRuntimeBinDirs = collectBundledRuntimeBinDirs(installPath);
  if (bundledRuntimeBinDirs.length === 0) return false;
  for (const binDir of bundledRuntimeBinDirs.slice().reverse()) {
    if (!process.env.PATH.includes(binDir)) {
      process.env.PATH = `${binDir}:${process.env.PATH}`;
    }
  }
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 570,
    minWidth: 600,
    minHeight: 570,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    show: false
  });

  mainWindow.loadFile('index.html', {
    query: { mock: INSTALLER_MOCK ? '1' : '0' }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 开发时打开开发者工具
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // 安装器在窗口关闭后应立即退出，即使在 macOS 上也是如此
    app.quit();
});

// IPC 处理函数
ipcMain.handle('get-installer-env', async () => ({
  mock: INSTALLER_MOCK,
  mockState: { ...mockInstallerState },
  version: app.getVersion()
}));

ipcMain.handle('set-installer-mock-state', async (event, patch = {}) => {
  if (!INSTALLER_MOCK || !patch || typeof patch !== 'object') {
    return { success: false, mockState: { ...mockInstallerState } };
  }
  if (typeof patch.permissionApproved === 'boolean') {
    mockInstallerState.permissionApproved = patch.permissionApproved;
  }
  if (patch.finalResult === 'success' || patch.finalResult === 'error') {
    mockInstallerState.finalResult = patch.finalResult;
  }
  if (patch.reset === true) {
    mockInstallerState.permissionApproved = false;
    mockInstallerState.finalResult = 'success';
  }
  return { success: true, mockState: { ...mockInstallerState } };
});

// 自动检测项目根目录
ipcMain.handle('get-project-root', async () => {
  if (INSTALLER_MOCK) {
    return path.resolve(__dirname, '..');
  }
  let appPath = app.getAppPath();
  console.log('原始 appPath:', appPath);

  if (appPath.includes('.asar')) {
    appPath = appPath.replace(/\.asar.*$/, '.asar');
  }

  // 找到 .app 包路径
  let dotAppPath = appPath;
  while (dotAppPath !== '/' && !dotAppPath.endsWith('.app')) {
    dotAppPath = path.dirname(dotAppPath);
  }
  console.log('.app 路径:', dotAppPath);

  // 辅助: 在指定目录查找含 start.js 的项目根
  // 优先检查 项目文件/ 子目录（分发结构），其次直接检查目录本身
  function findProjectFiles(dir) {
    if (!dir || dir === '/') return null;
    const sub = path.join(dir, '项目文件');
    if (fs.existsSync(path.join(sub, 'package.json')) && fs.existsSync(path.join(sub, 'start.js'))) {
      return sub;
    }
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'start.js'))) {
      return dir;
    }
    return null;
  }

  // ====== 策略 0: 开发模式（未打包，没有 .app 包） ======
  if (dotAppPath === '/') {
    console.log('开发模式检测: 未找到 .app 包，从 appPath 向上搜索');
    let devDir = appPath;
    for (let i = 0; i < 5; i++) {
      const found = findProjectFiles(devDir);
      if (found) {
        console.log('✅ 开发模式: 找到项目根目录:', found);
        currentInstallPath = found;
        applyBundledRuntimeEnv(currentInstallPath);
        return found;
      }
      const parent = path.dirname(devDir);
      if (parent === devDir) break;
      devDir = parent;
    }
  }

  // ====== 策略 1: DMG 回溯（JSON 方式，最可靠） ======
  // 分发结构: ScreenSync-Apple/双击安装.dmg + ScreenSync-Apple/项目文件/
  // 用 hdiutil info -plist → JSON 找到 DMG 源文件路径
  try {
    const { execSync } = require('child_process');
    const jsonStr = execSync('hdiutil info -plist | plutil -convert json -r -o - -',
      { encoding: 'utf8', timeout: 8000 });
    const hdiInfo = JSON.parse(jsonStr);
    const images = hdiInfo.images || [];
    console.log('DMG 回溯: 发现', images.length, '个挂载的磁盘映像');

    for (const img of images) {
      const imagePath = img['image-path'];
      const entities = img['system-entities'] || [];
      for (const entity of entities) {
        const mountPoint = entity['mount-point'];
        if (!mountPoint) continue;
        console.log('  检查挂载点:', mountPoint, '← DMG:', imagePath);
        if (dotAppPath.startsWith(mountPoint + '/') || dotAppPath === mountPoint) {
          console.log('  ✓ 匹配当前 app 所在卷');
          const dmgDir = path.dirname(imagePath);
          // 在 DMG 同级目录查找
          const found = findProjectFiles(dmgDir);
          if (found) {
            console.log('✅ 通过 DMG 回溯找到项目:', found);
            currentInstallPath = found;
            applyBundledRuntimeEnv(currentInstallPath);
            return found;
          }
          // DMG 可能嵌套一层，查父目录
          const parentFound = findProjectFiles(path.dirname(dmgDir));
          if (parentFound) {
            console.log('✅ 通过 DMG 父目录找到项目:', parentFound);
            currentInstallPath = parentFound;
            applyBundledRuntimeEnv(currentInstallPath);
            return parentFound;
          }
          console.warn('  ✗ DMG 目录中未找到项目文件:', dmgDir);
        }
      }
    }
  } catch (e) {
    console.warn('DMG 回溯(JSON)失败:', e.message);
  }

  // ====== 策略 2: 直接从 .app 父目录查找 ======
  const parentDir = path.dirname(dotAppPath);
  const directFound = findProjectFiles(parentDir);
  if (directFound) {
    console.log('✅ 从 .app 父目录找到项目:', directFound);
    currentInstallPath = directFound;
    applyBundledRuntimeEnv(currentInstallPath);
    return directFound;
  }

  // ====== 策略 3: 向上遍历最多 3 级父目录 ======
  let searchDir = parentDir;
  for (let i = 0; i < 3; i++) {
    searchDir = path.dirname(searchDir);
    if (searchDir === '/') break;
    const upFound = findProjectFiles(searchDir);
    if (upFound) {
      console.log('✅ 从祖先目录找到项目:', upFound);
      currentInstallPath = upFound;
      applyBundledRuntimeEnv(currentInstallPath);
      return upFound;
    }
  }

  // ====== 策略 4: 搜索用户常见目录 ======
  const homeDir = os.homedir();
  const searchRoots = [
    path.join(homeDir, 'Downloads'),
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Documents'),
  ];
  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root);
      for (const entry of entries) {
        if (!entry.startsWith('ScreenSync')) continue;
        const candidate = path.join(root, entry);
        const stat = fs.statSync(candidate);
        if (!stat.isDirectory()) continue;
        const found = findProjectFiles(candidate);
        if (found) {
          console.log('✅ 在常见目录中找到项目:', found);
          currentInstallPath = found;
          applyBundledRuntimeEnv(currentInstallPath);
          return found;
        }
      }
    } catch (e) {
      // ignore permission errors
    }
  }

  console.error('❌ 所有策略均未找到项目文件 (appPath:', appPath, ', dotAppPath:', dotAppPath, ')');
  return null;
});

// 手动选择项目根目录
ipcMain.handle('select-project-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 ScreenSync 安装包文件夹',
    properties: ['openDirectory'],
    message: '请选择解压后的 ScreenSync-Apple 或 ScreenSync-Intel 文件夹，或者其中的"项目文件"文件夹'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, error: '用户取消选择' };
  }

  const selectedPath = result.filePaths[0];
  
  // 检查 1: 直接是项目根目录（包含 package.json）
  if (fs.existsSync(path.join(selectedPath, 'package.json'))) {
    console.log('✅ 手动选择的路径有效:', selectedPath);
    currentInstallPath = selectedPath;
    applyBundledRuntimeEnv(currentInstallPath);
    return { success: true, path: selectedPath };
  }
  
  // 检查 2: 是安装包根目录（包含 "项目文件/package.json"）
  const projectFilesPath = path.join(selectedPath, '项目文件');
  if (fs.existsSync(path.join(projectFilesPath, 'package.json'))) {
    console.log('✅ 手动选择的是安装包根目录，自动定位到项目文件:', projectFilesPath);
    currentInstallPath = projectFilesPath;
    applyBundledRuntimeEnv(currentInstallPath);
    return { success: true, path: projectFilesPath };
  }

  return { 
    success: false, 
    error: '选择的文件夹不正确。\n\n请选择包含 "package.json" 的文件夹，或者解压后的 "ScreenSync-Apple" / "ScreenSync-Intel" 文件夹。' 
  };
});

ipcMain.handle('set-install-path', async (event, installPath) => {
  if (INSTALLER_MOCK) {
    currentInstallPath = installPath || path.resolve(__dirname, '..');
    return { success: true, runtimeApplied: true, runtimeBinDirs: [] };
  }
  if (!installPath || typeof installPath !== 'string') {
    return { success: false, error: 'invalid-install-path' };
  }
  currentInstallPath = installPath;
  const runtimeApplied = applyBundledRuntimeEnv(currentInstallPath);
  return { success: true, runtimeApplied, runtimeBinDirs: bundledRuntimeBinDirs };
});

// 辅助函数：查找可执行文件并更新 PATH
function findExecutable(name) {
  if (currentInstallPath) {
    applyBundledRuntimeEnv(currentInstallPath);
  }

  for (const binDir of bundledRuntimeBinDirs) {
    const fullPath = path.join(binDir, name);
    if (fs.existsSync(fullPath)) {
      if (!process.env.PATH.includes(binDir)) {
        process.env.PATH = `${binDir}:${process.env.PATH}`;
      }
      return fullPath;
    }
  }

  // 1. 优先使用 'which' 命令查找（最准确的方式）
  try {
    const output = require('child_process').execSync(`which ${name}`, { encoding: 'utf8', timeout: 3000 }).trim();
    if (output && fs.existsSync(output)) {
      console.log(`Found ${name} via 'which': ${output}`);
      // 添加到 PATH
      const binDir = path.dirname(output);
      if (!process.env.PATH.includes(binDir)) {
        console.log(`Adding ${binDir} to PATH`);
        process.env.PATH = `${binDir}:${process.env.PATH}`;
      }
      return output;
    }
  } catch (e) {
    console.log(`'which ${name}' failed, trying common paths...`);
  }

  // 2. 回退到检查常见路径（按优先级排序）
  const commonPaths = [
    `/usr/local/bin/${name}`,    // 官网安装（Intel 和 Apple Silicon 通用）
    `/opt/homebrew/bin/${name}`, // Homebrew Apple Silicon
    `/usr/local/Cellar`,         // Homebrew Intel（检查是否有 Cellar 目录）
    path.join(os.homedir(), `.nvm/versions/node`), // NVM
  ];

  // 特殊处理：优先检查 ScreenSync 本地安装目录 (legacy macOS)，然后是常见路径
  const localBin = path.join(os.homedir(), '.screensync', 'bin');
  for (const p of [localBin, '/usr/local/bin', '/opt/homebrew/bin']) {
    const fullPath = path.join(p, name);
    if (fs.existsSync(fullPath)) {
      console.log(`Found ${name} at: ${fullPath}`);
      if (!process.env.PATH.includes(p)) {
        console.log(`Adding ${p} to PATH`);
        process.env.PATH = `${p}:${process.env.PATH}`;
      }
      return fullPath;
    }
  }

  // 3. 检查 ScreenSync 本地安装的 Node.js（legacy macOS）
  if (name === 'node') {
    const localNodePath = path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'node');
    if (fs.existsSync(localNodePath)) {
      console.log(`Found ${name} via ScreenSync local deps: ${localNodePath}`);
      const localNodeBin = path.dirname(localNodePath);
      if (!process.env.PATH.includes(localNodeBin)) {
        process.env.PATH = `${localNodeBin}:${process.env.PATH}`;
      }
      return localNodePath;
    }
  }

  // 4. 检查 NVM 安装的 Node.js（如果是 node）
  if (name === 'node') {
    const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
      try {
        const versions = fs.readdirSync(nvmDir);
        if (versions.length > 0) {
          // 使用最新版本
          const latestVersion = versions.sort().reverse()[0];
          const nvmNodePath = path.join(nvmDir, latestVersion, 'bin', 'node');
          if (fs.existsSync(nvmNodePath)) {
            console.log(`Found ${name} via NVM: ${nvmNodePath}`);
            return nvmNodePath;
          }
        }
      } catch (e) {
        console.log('Failed to check NVM directory:', e.message);
      }
    }
  }

  return null;
}

function isUsableNodeBinary(nodePath) {
  if (!nodePath || typeof nodePath !== 'string') return false;
  try {
    if (!path.isAbsolute(nodePath) || !fs.existsSync(nodePath)) return false;
    require('child_process').execSync(`"${nodePath}" -v`, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (_) {
    return false;
  }
}

function resolveNodeBinary(installPath = currentInstallPath) {
  const candidates = [];

  try {
    const runtimeStatus = detectBundledRuntimeFolderStatus(installPath);
    if (runtimeStatus && runtimeStatus.node) {
      candidates.push(runtimeStatus.node);
    }
  } catch (_) {}

  try {
    const runtimeBins = collectBundledRuntimeBinDirs(installPath);
    for (const binDir of runtimeBins) {
      candidates.push(path.join(binDir, 'node'));
    }
  } catch (_) {}

  const found = findExecutable('node');
  if (found) candidates.push(found);

  candidates.push(
    path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node'
  );

  // NVM: choose latest available version
  try {
    const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        candidates.push(path.join(nvmDir, v, 'bin', 'node'));
      }
    }
  } catch (_) {}

  // Login shell lookup (handles users who only have node in shell profile)
  try {
    const shellNode = require('child_process')
      .execSync(`${process.env.SHELL || '/bin/zsh'} -l -c "command -v node"`, { encoding: 'utf8', timeout: 5000 })
      .trim()
      .split('\n')[0]
      .trim();
    if (shellNode) candidates.unshift(shellNode);
  } catch (_) {}

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isUsableNodeBinary(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isUsableNpmBinary(npmPath) {
  if (!npmPath || typeof npmPath !== 'string') return false;
  try {
    if (!path.isAbsolute(npmPath) || !fs.existsSync(npmPath)) return false;
    require('child_process').execSync(`"${npmPath}" --version`, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (_) {
    return false;
  }
}

function resolveNpmBinary() {
  const candidates = [];
  candidates.push(
    path.join(os.homedir(), '.screensync', 'bin', 'npm'),
    path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'npm'),
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm'
  );
  const found = findExecutable('npm');
  if (found) candidates.push(found);

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isUsableNpmBinary(candidate)) return candidate;
  }
  return null;
}

function getRequiredDependencies(installPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {});
  } catch (_) {
    return ['dotenv', 'ws', 'express', 'googleapis', 'chokidar'];
  }
}

function hasRequiredDependencies(installPath) {
  try {
    for (const dep of getRequiredDependencies(installPath)) {
      require.resolve(dep, { paths: [installPath] });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function ensureNpmShimFromNode(nodePath) {
  if (!isUsableNodeBinary(nodePath)) return false;
  try {
    const nodeRoot = path.resolve(path.dirname(nodePath), '..');
    const candidates = [
      path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ];
    const npxCandidates = [
      path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
      path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    ];
    const npmCli = candidates.find((p) => fs.existsSync(p));
    const npxCli = npxCandidates.find((p) => fs.existsSync(p));
    if (!npmCli) return false;

    fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
    const npmShim = path.join(LEGACY_BIN_DIR, 'npm');
    fs.writeFileSync(npmShim, `#!/bin/bash\nexec "${nodePath}" "${npmCli}" "$@"\n`, { mode: 0o755 });

    if (npxCli) {
      const npxShim = path.join(LEGACY_BIN_DIR, 'npx');
      fs.writeFileSync(npxShim, `#!/bin/bash\nexec "${nodePath}" "${npxCli}" "$@"\n`, { mode: 0o755 });
    }

    if (!process.env.PATH.includes(LEGACY_BIN_DIR)) {
      process.env.PATH = `${LEGACY_BIN_DIR}:${process.env.PATH}`;
    }
    return isUsableNpmBinary(npmShim);
  } catch (_) {
    return false;
  }
}

ipcMain.handle('check-homebrew', async (event, installPath = null) => {
  if (installPath) {
    currentInstallPath = installPath;
    applyBundledRuntimeEnv(currentInstallPath);
  }
  const bundledRuntime = await detectBundledOfflineRuntime(currentInstallPath);
  if (bundledRuntime && bundledRuntime.available) {
    return { installed: true, skipped: true, bundled: true };
  }
  const darwinVersion = parseInt(os.release().split('.')[0], 10);
  const isLegacyMacOS = darwinVersion < 23;
  if (isLegacyMacOS) {
    return { installed: true, skipped: true };
  }

  const brewPath = findExecutable('brew');
  if (!brewPath) {
    console.log('Check Homebrew: not found');
    return { installed: false };
  }

  // Verify brew actually works (catches stale binaries from incomplete uninstalls)
  try {
    require('child_process').execSync(`"${brewPath}" --version`, { encoding: 'utf8', timeout: 10000 });
    console.log('Check Homebrew: verified at', brewPath);
    return { installed: true };
  } catch (e) {
    console.log('Check Homebrew: binary found but broken at', brewPath, e.message);
    return { installed: false };
  }
});

ipcMain.handle('check-fat-runtime', async (event, installPath = null) => {
  if (INSTALLER_MOCK) {
    await sleep(220);
    return {
      complete: true,
      mock: true,
      bins: [path.join(path.resolve(__dirname, '..'), 'runtime', 'bin')]
    };
  }
  if (installPath) {
    currentInstallPath = installPath;
    applyBundledRuntimeEnv(currentInstallPath);
  }
  return detectBundledRuntimeFolderStatus(currentInstallPath);
});

ipcMain.handle('check-node', async (event, installPath = null) => {
  if (installPath) {
    currentInstallPath = installPath;
    applyBundledRuntimeEnv(currentInstallPath);
  }
  return new Promise((resolve) => {
    const nodePath = resolveNodeBinary(installPath);
    
    if (nodePath) {
      exec(`"${nodePath}" -v`, (error, version) => {
        resolve({ 
          installed: !error, 
          version: version ? version.trim() : 'unknown' 
        });
      });
    } else {
      resolve({ installed: false });
    }
  });
});

async function detectBundledOfflineRuntime(installPath) {
  const runtimeDetected = applyBundledRuntimeEnv(installPath || currentInstallPath);
  if (!runtimeDetected) {
    return { available: false };
  }

  const nodePath = resolveNodeBinary();
  const ffmpegPath = findExecutable('ffmpeg');
  const gifsiclePath = findExecutable('gifsicle');
  const magickPath = findExecutable('magick') || findExecutable('convert');

  const hasNode = !!nodePath;
  const hasFfmpeg = !!ffmpegPath;
  const hasGifsicle = !!gifsiclePath;
  let hasImageMagick = !!magickPath;
  if (hasImageMagick) {
    const health = await verifyImageMagickPngHealth(magickPath);
    hasImageMagick = !!health.ok;
  }

  return {
    available: hasNode && hasFfmpeg && hasGifsicle && hasImageMagick,
    runtimeDetected,
    nodePath,
    ffmpegPath,
    gifsiclePath,
    magickPath
  };
}

async function warmupBundledRuntimeExecutables(installPath, sendLog = () => {}, options = {}) {
  currentInstallPath = installPath || currentInstallPath;
  applyBundledRuntimeEnv(currentInstallPath);
  const collectAllFailures = !!options.collectAllFailures;

  const runtimeStatus = detectBundledRuntimeFolderStatus(currentInstallPath);
  if (!runtimeStatus.complete) {
    const missing = (runtimeStatus.missing || []).join(', ') || 'unknown';
    return {
      success: false,
      failedTool: 'runtime',
      error: `安装资源不完整，缺少运行时组件：${missing}`
    };
  }

  const toolChecks = [
    {
      key: 'node',
      label: 'Node.js',
      path: runtimeStatus.node || resolveNodeBinary(currentInstallPath),
      run: async (executablePath) => {
        await execFilePromise(executablePath, ['-v'], { timeout: 10000 });
      }
    },
    {
      key: 'ffmpeg',
      label: 'FFmpeg',
      path: runtimeStatus.ffmpeg || findExecutable('ffmpeg'),
      run: async (executablePath) => {
        const { stdout, stderr } = await execFilePromise(executablePath, ['-version'], { timeout: 10000 });
        const combined = `${stdout || ''}${stderr || ''}`;
        if (!combined.includes('ffmpeg version')) {
          throw new Error('ffmpeg -version 输出异常');
        }
      }
    },
    {
      key: 'gifsicle',
      label: 'Gifsicle',
      path: runtimeStatus.gifsicle || findExecutable('gifsicle'),
      run: async (executablePath) => {
        const { stdout, stderr } = await execFilePromise(executablePath, ['--version'], { timeout: 10000 });
        const combined = `${stdout || ''}${stderr || ''}`;
        if (!combined.toLowerCase().includes('gifsicle')) {
          throw new Error('gifsicle --version 输出异常');
        }
      }
    },
    {
      key: 'imagemagick',
      label: 'ImageMagick',
      path: runtimeStatus.magick || runtimeStatus.convert || findExecutable('magick') || findExecutable('convert'),
      run: async (executablePath) => {
        await execFilePromise(executablePath, ['-version'], { timeout: 10000 });
        const health = await verifyImageMagickPngHealth(executablePath);
        if (!health.ok) {
          throw new Error(health.details || health.reason || 'PNG 健康检查失败');
        }
      }
    }
  ];
  const nativeAddons = collectNativeNodeAddonDescriptors(currentInstallPath);
  const nodeBinary = runtimeStatus.node || resolveNodeBinary(currentInstallPath);

  for (const addon of nativeAddons) {
    toolChecks.push({
      key: `native:${addon.packageName || path.basename(addon.addonPath)}`,
      label: addon.label,
      path: addon.addonPath,
      run: async () => {
        if (!nodeBinary) {
          throw new Error('未找到 Node.js，无法预热原生模块');
        }
        await execFilePromise(nodeBinary, [
          '-e',
          [
            'const requireTarget = process.argv[1];',
            'const addonPath = process.argv[2];',
            'try {',
            '  require(requireTarget || addonPath);',
            '} catch (error) {',
            '  const detail = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);',
            '  process.stderr.write(detail);',
            '  process.exit(1);',
            '}'
          ].join('\n'),
          addon.packageRoot || addon.addonPath,
          addon.addonPath
        ], {
          cwd: currentInstallPath,
          timeout: 10000
        });
      }
    });
  }

  sendLog('🧪 正在预热并验证内置运行时...');
  const failures = [];
  const verifiedTools = [];
  for (const check of toolChecks) {
    if (!check.path) {
      const failure = {
        key: check.key,
        label: check.label,
        path: '',
        detail: `未找到 ${check.label} 可执行文件，安装资源可能不完整。`
      };
      failures.push(failure);
      sendLog(`   ❌ ${check.label} 缺失`);
      if (!collectAllFailures) {
        return {
          success: false,
          failedTool: check.key,
          failures,
          error: failure.detail
        };
      }
      continue;
    }
    sendLog(`   验证 ${check.label}...`);
    try {
      await check.run(check.path);
      sendLog(`   ✅ ${check.label} 验证通过`);
      verifiedTools.push(check.key);
    } catch (error) {
      const detail = String(error?.stderr || error?.stdout || error?.message || error || '');
      const failureClass = classifyRuntimeProbeFailure(check.path, detail);
      const failure = {
        key: check.key,
        label: check.label,
        path: check.path,
        detail,
        needsApproval: failureClass.needsApproval
      };
      failures.push(failure);
      sendLog(`   ❌ ${check.label} 验证失败`);
      if (!collectAllFailures) {
        return {
          success: false,
          failedTool: check.key,
          failures,
          error: buildPermissionRetryGuidance(check.label, check.path, detail)
        };
      }
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      failedTool: failures[0].key,
      failures,
      verifiedTools,
      error: buildPermissionBatchGuidance(failures)
    };
  }

  return { success: true, verifiedTools };
}

async function verifyImageMagickPngHealth(magickPath) {
  if (!magickPath || !fs.existsSync(magickPath)) {
    return { ok: false, reason: 'magick-not-found' };
  }
  const tmpDir = path.join(os.tmpdir(), `screensync_magick_health_${Date.now()}`);
  const pngPath = path.join(tmpDir, 'probe.png');
  const outPath = path.join(tmpDir, 'probe_out.png');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await execPromise(`"${magickPath}" -version`, { timeout: 10000 });
    // 先写后读：同时校验 encode/decode delegate 可用性
    await execPromise(`"${magickPath}" -size 2x2 xc:none "${pngPath}"`, { timeout: 15000 });
    await execPromise(`"${magickPath}" "${pngPath}" -resize 1x1 "${outPath}"`, { timeout: 15000 });
    await execPromise(`"${magickPath}" identify "${outPath}"`, { timeout: 10000 });
    return { ok: true };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || '');
    if (msg.toLowerCase().includes('no decode delegate')) {
      return { ok: false, reason: 'png-decode-delegate-missing', details: msg };
    }
    return { ok: false, reason: 'magick-runtime-error', details: msg };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

ipcMain.handle('check-imagemagick', async (event, installPath = null) => {
  if (installPath) {
    currentInstallPath = installPath;
    applyBundledRuntimeEnv(currentInstallPath);
  }
  const magickPath = findExecutable('magick') || findExecutable('convert');
  if (!magickPath) return { installed: false };

  const health = await verifyImageMagickPngHealth(magickPath);
  if (!health.ok) {
    return { installed: false, reason: health.reason };
  }

  try {
    const { stdout, stderr } = await execPromise(`"${magickPath}" -version`, { timeout: 10000 });
    const combined = `${stdout || ''}${stderr || ''}`;
    const versionMatch = combined.match(/Version: ImageMagick ([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    return { installed: true, version: version };
  } catch (_) {
    return { installed: true, version: 'unknown' };
  }
});

ipcMain.handle('check-ffmpeg', async (event, installPath = null) => {
  if (installPath) {
    currentInstallPath = installPath;
    applyBundledRuntimeEnv(currentInstallPath);
  }
  return new Promise((resolve) => {
    const ffmpegPath = findExecutable('ffmpeg');
    
    if (ffmpegPath) {
      exec(`"${ffmpegPath}" -version`, (error, output) => {
        if (!error && output.includes('ffmpeg version')) {
          // 提取版本号
          const versionMatch = output.match(/ffmpeg version ([\d.]+)/);
          const version = versionMatch ? versionMatch[1] : 'unknown';
          resolve({ installed: true, version: version });
        } else {
          resolve({ installed: false });
        }
      });
    } else {
      resolve({ installed: false });
    }
  });
});

ipcMain.handle('check-gifsicle', async (event, installPath = null) => {
  if (installPath) {
    currentInstallPath = installPath;
    applyBundledRuntimeEnv(currentInstallPath);
  }
  return new Promise((resolve) => {
    const gifsiclePath = findExecutable('gifsicle');
    
    if (gifsiclePath) {
      exec(`"${gifsiclePath}" --version`, (error, output) => {
        if (!error && output.includes('Gifsicle')) {
          // 提取版本号
          const versionMatch = output.match(/Gifsicle ([\d.]+)/);
          const version = versionMatch ? versionMatch[1] : 'unknown';
          resolve({ installed: true, version: version });
        } else {
          resolve({ installed: false });
        }
      });
    } else {
      resolve({ installed: false });
    }
  });
});

ipcMain.handle('warmup-runtime-permissions', async (event, installPath = null) => {
  if (INSTALLER_MOCK) {
    await sleep(260);
    if (mockInstallerState.permissionApproved) {
      return { success: true, verifiedTools: ['Node.js', 'FFmpeg', 'Gifsicle', 'ImageMagick'], requiresManualApproval: false, blockingFailures: [] };
    }
    return {
      success: false,
      pendingTools: ['Node.js', 'FFmpeg', 'Gifsicle', 'ImageMagick'],
      requiresManualApproval: true,
      blockingFailures: [],
      guidance: 'mock pending'
    };
  }
  const targetPath = installPath || currentInstallPath;
  if (targetPath) {
    currentInstallPath = targetPath;
  }

  const logs = [];
  const sendLog = (message) => {
    const text = cleanPtyOutput(String(message || '')).trim();
    if (text) logs.push(text);
  };

  const result = await warmupBundledRuntimeExecutables(targetPath, sendLog, { collectAllFailures: true });
  const failures = Array.isArray(result.failures) ? result.failures : [];
  const approvalFailures = failures.filter(item => item && item.needsApproval);
  const blockingFailures = failures.filter(item => item && !item.needsApproval);
  return {
    ...result,
    pendingTools: approvalFailures.map(item => item.label),
    requiresManualApproval: approvalFailures.length > 0,
    blockingFailures,
    detail: logs.join('\n')
  };
});

ipcMain.handle('open-security-settings', async () => {
  if (INSTALLER_MOCK) {
    mockInstallerState.permissionApproved = true;
    return { success: true, mock: true };
  }
  try {
    const attempts = [
      {
        label: 'privacy-security-extension',
        run: () => execFilePromise('/usr/bin/open', ['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension'], { timeout: 10000 })
      },
      {
        label: 'security-privacy-tab',
        run: () => execFilePromise('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy'], { timeout: 10000 })
      },
      {
        label: 'security-pane',
        run: () => execFilePromise('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security'], { timeout: 10000 })
      },
      {
        label: 'security-prefpane',
        run: () => execFilePromise('/usr/bin/open', ['/System/Library/PreferencePanes/Security.prefPane'], { timeout: 10000 })
      }
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        await attempt.run();
        return { success: true, target: attempt.label };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      success: false,
      error: lastError && lastError.message ? lastError.message : 'Failed to open Privacy & Security settings'
    };
  } catch (error) {
    return {
      success: false,
      error: error && error.message ? error.message : String(error)
    };
  }
});

ipcMain.handle('check-icloud-space', async () => {
  if (INSTALLER_MOCK) {
    return { available: true, mock: true };
  }
  const icloudPath = path.join(
    os.homedir(),
    'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
  );
  
  return new Promise((resolve) => {
    // 尝试创建文件夹
    fs.mkdirSync(icloudPath, { recursive: true });
    
    // 检查写入权限
    if (!fs.existsSync(icloudPath)) {
      resolve({ available: false, error: '无法创建 iCloud 文件夹' });
      return;
    }
    
    // 尝试写入测试文件（1MB）
    const testFile = path.join(icloudPath, '.test-write-space-check');
    const testData = Buffer.alloc(1024 * 1024, 'x');
    
    try {
      fs.writeFileSync(testFile, testData);
      fs.unlinkSync(testFile);
      resolve({ available: true });
    } catch (error) {
      try {
        if (fs.existsSync(testFile)) {
          fs.unlinkSync(testFile);
        }
      } catch (e) {}
      
      const errorMsg = error.message || String(error);
      const isSpaceError = errorMsg.includes('No space') || 
                          errorMsg.includes('ENOSPC') || 
                          errorMsg.includes('not enough space') ||
                          errorMsg.includes('磁盘空间不足') ||
                          errorMsg.includes('空间不足');
      
      resolve({ 
        available: false, 
        error: isSpaceError ? 'iCloud 空间不足' : 'iCloud 文件夹无写入权限'
      });
    }
  });
});

ipcMain.handle('enable-anywhere', async () => {
  return {
    success: false,
    skipped: true,
    message: '安装器已不再通过 spctl --master-disable 全局关闭 Gatekeeper。'
  };
});

// 辅助函数：运行 AppleScript
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    // 使用临时文件，但使用更好的错误处理
    const tempScriptPath = path.join(os.tmpdir(), `screensync_${Date.now()}.scpt`);
    
    try {
      fs.writeFileSync(tempScriptPath, script, 'utf8');
      console.log('AppleScript written to:', tempScriptPath);
      console.log('AppleScript content:', script);
    } catch (writeError) {
      console.error('Failed to write AppleScript:', writeError);
      reject(writeError);
      return;
    }

    // 执行 AppleScript，给予更长的超时时间
    exec(`osascript "${tempScriptPath}"`, { timeout: 10000 }, (error, stdout, stderr) => {
      // 清理临时文件
      try { 
        fs.unlinkSync(tempScriptPath);
        console.log('Cleaned up temp script file');
      } catch (e) {
        console.warn('Failed to cleanup temp file:', e);
      }

      if (error) {
        // 只有当 error 存在且不是用户取消时才 reject
        if (!error.message.includes('User canceled')) {
          console.error('AppleScript error:', error);
          console.error('stderr:', stderr);
          reject(error);
        } else {
          // 用户取消当作成功但不执行
          console.log('User canceled AppleScript');
          resolve('User canceled');
        }
      } else {
        console.log('AppleScript executed successfully');
        if (stdout) console.log('stdout:', stdout);
        resolve(stdout);
      }
    });
  });
}

// 获取 macOS 版本信息
ipcMain.handle('get-macos-version', async () => {
  return getMacOSVersion();
});

// Escape single quotes for embedding in bash single-quoted strings
function escapeForBash(str) {
  return str.replace(/'/g, "'\"'\"'");
}

// Strip PTY control characters from output
function cleanPtyOutput(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

// Execute shell command as Promise
function execPromise(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function execFilePromise(filePath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(filePath, args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// ============================================================
// Legacy macOS (13 and below) — direct binary download approach
// ============================================================
const LEGACY_DEPS_DIR = path.join(os.homedir(), '.screensync', 'deps');
const LEGACY_BIN_DIR = path.join(os.homedir(), '.screensync', 'bin');
const LEGACY_NODE_VERSION = '22.13.1';

function ensureLegacyBinInShellProfiles(sendLog) {
  const profilePaths = [
    path.join(os.homedir(), '.zprofile'),
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bash_profile')
  ];
  const marker = '# ScreenSync legacy deps PATH';
  const exportLine = 'export PATH="$HOME/.screensync/bin:$HOME/.screensync/deps/node/bin:$PATH"';

  for (const profilePath of profilePaths) {
    try {
      let content = '';
      if (fs.existsSync(profilePath)) {
        content = fs.readFileSync(profilePath, 'utf8');
      }
      if (content.includes(marker) || content.includes(exportLine)) {
        continue;
      }
      const appendText = `${content && !content.endsWith('\n') ? '\n' : ''}${marker}\n${exportLine}\n`;
      fs.appendFileSync(profilePath, appendText, 'utf8');
      if (typeof sendLog === 'function') {
        sendLog(`   ✅ 已更新 Shell PATH: ${profilePath}\n`);
      }
    } catch (e) {
      if (typeof sendLog === 'function') {
        sendLog(`   ⚠️ 更新 Shell PATH 失败 (${profilePath}): ${e.message}\n`);
      }
    }
  }
}

function getLegacyNodeUrl() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `https://nodejs.org/dist/v${LEGACY_NODE_VERSION}/node-v${LEGACY_NODE_VERSION}-darwin-${arch}.tar.gz`;
}

// Download file via curl, report progress
function downloadFile(url, destPath, sendLog, maxTimeSec = 300) {
  return new Promise((resolve, reject) => {
    sendLog(`   下载: ${url}\n`);
    const child = spawn('curl', [
      '-L', '-o', destPath, '--progress-bar', '-f',
      '--connect-timeout', '30',
      '--max-time', String(maxTimeSec),
      '--retry', '2', '--retry-delay', '3',
      url
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.includes('%')) sendLog(text);
    });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(destPath)) resolve();
      else reject(new Error(`下载失败: ${url}`));
    });
    child.on('error', reject);
  });
}

// ---- Legacy Node.js ----
async function installLegacyNode(sendProgress, sendLog) {
  sendProgress('node', 'installing', '正在安装...');
  sendLog('\n📦 正在安装 Node.js...\n');

  const nodeDir = path.join(LEGACY_DEPS_DIR, 'node');
  const tarPath = path.join(os.tmpdir(), `screensync_node_${Date.now()}.tar.gz`);

  try {
    await downloadFile(getLegacyNodeUrl(), tarPath, sendLog);

    sendLog('   正在解压...\n');
    // Clean old installation
    if (fs.existsSync(nodeDir)) fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.mkdirSync(LEGACY_DEPS_DIR, { recursive: true });

    await execPromise(`tar xzf "${tarPath}" -C "${LEGACY_DEPS_DIR}"`);
    // Rename extracted folder (node-v22.13.1-darwin-arm64 → node)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const extractedName = `node-v${LEGACY_NODE_VERSION}-darwin-${arch}`;
    const extractedPath = path.join(LEGACY_DEPS_DIR, extractedName);
    if (fs.existsSync(extractedPath)) {
      fs.renameSync(extractedPath, nodeDir);
    }

    // Symlink binaries
    fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
    for (const bin of ['node', 'npm', 'npx']) {
      const src = path.join(nodeDir, 'bin', bin);
      const dest = path.join(LEGACY_BIN_DIR, bin);
      try { fs.unlinkSync(dest); } catch (e) {}
      if (fs.existsSync(src)) fs.symlinkSync(src, dest);
    }

    // Verify
    const { stdout } = await execPromise(`"${path.join(LEGACY_BIN_DIR, 'node')}" --version`);
    sendLog(`   ✅ Node.js ${stdout.trim()} 安装完成\n`);
    sendProgress('node', 'done', '安装完成');
  } finally {
    try { fs.unlinkSync(tarPath); } catch (e) {}
  }
}

// ---- Legacy FFmpeg + FFprobe ----
async function installLegacyFFmpeg(sendProgress, sendLog) {
  sendProgress('ffmpeg', 'installing', '正在安装...');
  sendLog('\n📦 正在安装 FFmpeg...\n');

  fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
  const tmpDir = path.join(os.tmpdir(), `screensync_ffmpeg_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const ffmpegZip = path.join(tmpDir, 'ffmpeg.zip');
    const ffprobeZip = path.join(tmpDir, 'ffprobe.zip');

    // martin-riedl.de: signed & notarized static builds with native ARM64 + Intel
    const primaryUrls = [
      [`https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffmpeg.zip`, ffmpegZip, 'FFmpeg'],
      [`https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffprobe.zip`, ffprobeZip, 'FFprobe']
    ];
    // evermeet.cx as fallback (Intel x64 only; runs via Rosetta 2 on ARM)
    const fallbackUrls = [
      ['https://evermeet.cx/ffmpeg/getrelease/zip', ffmpegZip, 'FFmpeg'],
      ['https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip', ffprobeZip, 'FFprobe']
    ];

    for (let i = 0; i < primaryUrls.length; i++) {
      const [primaryUrl, dest, label] = primaryUrls[i];
      const [fallbackUrl] = fallbackUrls[i];
      try {
        await downloadFile(primaryUrl, dest, sendLog);
      } catch (e) {
        sendLog(`   ⚠️ ${label} 主下载源失败，尝试备用源...\n`);
        await downloadFile(fallbackUrl, dest, sendLog);
      }
    }

    sendLog('   正在解压...\n');
    await execPromise(`unzip -o "${ffmpegZip}" -d "${LEGACY_BIN_DIR}"`);
    await execPromise(`unzip -o "${ffprobeZip}" -d "${LEGACY_BIN_DIR}"`);
    await execPromise(`chmod +x "${path.join(LEGACY_BIN_DIR, 'ffmpeg')}" "${path.join(LEGACY_BIN_DIR, 'ffprobe')}"`);

    // Verify
    const { stdout } = await execPromise(`"${path.join(LEGACY_BIN_DIR, 'ffmpeg')}" -version`);
    const ver = stdout.split('\n')[0];
    sendLog(`   ✅ ${ver}\n`);
    sendProgress('ffmpeg', 'done', '安装完成');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---- Legacy ImageMagick ----

// Helper: try to install ImageMagick from a DMG URL
async function tryInstallFromDmg(dmgUrl, dmgPath, mountPoint, imDir, sendLog) {
  try { fs.unlinkSync(dmgPath); } catch (_) {}
  await downloadFile(dmgUrl, dmgPath, sendLog);

  sendLog('   正在挂载 DMG...\n');
  fs.mkdirSync(mountPoint, { recursive: true });
  await execPromise(`hdiutil attach "${dmgPath}" -nobrowse -readonly -mountpoint "${mountPoint}"`, { timeout: 30000 });

  try {
    const dmgContents = fs.readdirSync(mountPoint);
    const appName = dmgContents.find(f => f.endsWith('.app') && f.toLowerCase().includes('magick'));

    if (appName) {
      if (fs.existsSync(imDir)) fs.rmSync(imDir, { recursive: true, force: true });
      fs.mkdirSync(imDir, { recursive: true });
      const appDest = path.join(imDir, appName);
      await execPromise(`cp -R "${path.join(mountPoint, appName)}" "${appDest}"`);

      const magickBin = path.join(appDest, 'Contents', 'MacOS', 'magick');
      if (fs.existsSync(magickBin)) {
        // Verify binary actually runs on this CPU architecture before committing
        try {
          await execPromise(`"${magickBin}" -version`, { timeout: 10000 });
        } catch (archErr) {
          sendLog(`   ⚠️ DMG 中的二进制不兼容当前 CPU 架构: ${archErr.message}\n`);
          return false;
        }
        for (const cmd of ['magick', 'convert']) {
          const wrapperPath = path.join(LEGACY_BIN_DIR, cmd);
          fs.writeFileSync(wrapperPath, `#!/bin/bash\nexec "${magickBin}" ${cmd === 'convert' ? 'convert' : ''} "$@"\n`, { mode: 0o755 });
        }
        return true;
      }
    }
  } finally {
    try { await execPromise(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch (_) {}
  }
  return false;
}

// Helper: try to install ImageMagick from official macOS tarball
async function tryInstallFromTarball(tarUrl, tarPath, imDir, sendLog) {
  try { fs.unlinkSync(tarPath); } catch (_) {}
  await downloadFile(tarUrl, tarPath, sendLog);

  const extractDir = tarPath + '_extract';
  fs.mkdirSync(extractDir, { recursive: true });
  await execPromise(`tar xzf "${tarPath}" -C "${extractDir}"`, { timeout: 60000 });

  // Find the magick binary inside extracted contents
  const { stdout } = await execPromise(`find "${extractDir}" -name "magick" -type f 2>/dev/null | head -1`, { timeout: 10000 });
  const foundBin = stdout.trim();
  if (foundBin && fs.existsSync(foundBin)) {
    if (fs.existsSync(imDir)) fs.rmSync(imDir, { recursive: true, force: true });
    fs.mkdirSync(imDir, { recursive: true });

    // Copy the entire extracted tree into imDir
    await execPromise(`cp -R "${extractDir}/"* "${imDir}/"`, { timeout: 30000 });

    // Re-locate magick inside the new location
    const { stdout: newBin } = await execPromise(`find "${imDir}" -name "magick" -type f 2>/dev/null | head -1`, { timeout: 10000 });
    const magickBin = newBin.trim();
    if (magickBin && fs.existsSync(magickBin)) {
      await execPromise(`chmod +x "${magickBin}"`);
      // Verify binary actually runs on this CPU architecture before committing
      try {
        await execPromise(`"${magickBin}" -version`, { timeout: 10000 });
      } catch (archErr) {
        sendLog(`   ⚠️ Tarball 中的二进制不兼容当前 CPU 架构: ${archErr.message}\n`);
        return false;
      }
      for (const cmd of ['magick', 'convert']) {
        const dest = path.join(LEGACY_BIN_DIR, cmd);
        try { fs.unlinkSync(dest); } catch (_) {}
        fs.writeFileSync(dest, `#!/bin/bash\nexec "${magickBin}" ${cmd === 'convert' ? 'convert' : ''} "$@"\n`, { mode: 0o755 });
      }
      return true;
    }
  }
  return false;
}

async function installLegacyImageMagick(sendProgress, sendLog) {
  sendProgress('imagemagick', 'installing', '正在安装...');
  sendLog('\n📦 正在安装 ImageMagick...\n');

  fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
  const imDir = path.join(LEGACY_DEPS_DIR, 'imagemagick');
  const tmpDir = path.join(os.tmpdir(), `screensync_im_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const dmgPath = path.join(tmpDir, 'ImageMagick.dmg');
  const mountPoint = path.join(tmpDir, 'im_mount');
  let installed = false;

  try {
    // Strategy 1: mendelson.org DMG (universal binary, notarized) — with retry
    const dmgUrls = [
      'https://mendelson.org/imagemagick.dmg',
      'https://mendelson.org/PortableImageMagickInstaller.dmg'
    ];
    for (const dmgUrl of dmgUrls) {
      if (installed) break;
      for (let attempt = 1; attempt <= 2; attempt++) {
        sendLog(`   尝试下载 ImageMagick DMG (${attempt}/2): ${dmgUrl}\n`);
        try {
          installed = await tryInstallFromDmg(dmgUrl, dmgPath, mountPoint, imDir, sendLog);
          if (installed) break;
        } catch (e) {
          sendLog(`   ⚠️ 下载失败: ${e.message}\n`);
          try { await execPromise(`hdiutil detach "${mountPoint}" -force`, { timeout: 10000 }); } catch (_) {}
          if (attempt < 2) {
            sendLog('   等待 3 秒后重试...\n');
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }
    }

    // Strategy 2: Official pre-built macOS tarball (Intel x86_64)
    if (!installed && process.arch !== 'arm64') {
      sendLog('   尝试下载 ImageMagick 官方 macOS 预编译包...\n');
      const tarPath = path.join(tmpDir, 'ImageMagick-macos.tar.gz');
      try {
        installed = await tryInstallFromTarball(
          'https://download.imagemagick.org/archive/binaries/ImageMagick-x86_64-apple-darwin20.1.0.tar.gz',
          tarPath, imDir, sendLog
        );
      } catch (e) {
        sendLog(`   ⚠️ 官方预编译包安装失败: ${e.message}\n`);
      }
    }

    // Strategy 3: Auto-install Xcode CLT + compile from source
    if (!installed) {
      sendLog('   尝试从源码编译 ImageMagick...\n');
      let hasXcodeClt = false;
      try {
        await execPromise('xcode-select -p', { timeout: 5000 });
        hasXcodeClt = true;
      } catch (_) {
        sendLog('   未检测到 Xcode Command Line Tools，正在安装...\n');
        sendProgress('imagemagick', 'installing', '安装 Xcode CLT...');
        try {
          // Trigger the macOS CLT install dialog; touch the sentinel file to request install
          await execPromise('touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress');
          // Find the CLT package name from softwareupdate
          const { stdout: suList } = await execPromise('softwareupdate -l 2>&1', { timeout: 60000 });
          const cltMatch = suList.match(/\*\s+(Label:\s+)?(Command Line Tools[^\n]*)/);
          if (cltMatch) {
            const label = cltMatch[2].replace(/^Label:\s*/, '').trim();
            sendLog(`   找到 CLT 安装包: ${label}，正在安装（可能需要几分钟）...\n`);
            await execPromise(`softwareupdate -i "${label}" --verbose 2>&1`, { timeout: 600000 });
          } else {
            // Fallback: xcode-select --install triggers GUI dialog
            sendLog('   正在弹出 Xcode CLT 安装对话框，请在弹窗中点击"安装"...\n');
            await execPromise('xcode-select --install 2>/dev/null || true');
            // Poll for completion (max 10 minutes)
            for (let i = 0; i < 60; i++) {
              await new Promise(r => setTimeout(r, 10000));
              try {
                await execPromise('xcode-select -p', { timeout: 5000 });
                break;
              } catch (_) {}
            }
          }
          try { fs.unlinkSync('/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress'); } catch (_) {}

          // Verify
          await execPromise('xcode-select -p', { timeout: 5000 });
          hasXcodeClt = true;
          sendLog('   ✅ Xcode Command Line Tools 安装完成\n');
        } catch (cltErr) {
          sendLog(`   ⚠️ Xcode CLT 自动安装失败: ${cltErr.message}\n`);
          sendLog('   💡 请手动运行: xcode-select --install\n');
          try { fs.unlinkSync('/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress'); } catch (_) {}
        }
      }

      if (hasXcodeClt) {
        try {
          sendProgress('imagemagick', 'installing', '编译中...');
          const srcDir = path.join(tmpDir, 'src');
          fs.mkdirSync(srcDir, { recursive: true });
          if (fs.existsSync(imDir)) fs.rmSync(imDir, { recursive: true, force: true });
          fs.mkdirSync(imDir, { recursive: true });

          sendLog('   下载 ImageMagick 源码...\n');
          await execPromise(`curl -L "https://imagemagick.org/archive/ImageMagick.tar.gz" | tar xz -C "${srcDir}" --strip-components=1`, { timeout: 300000 });
          const ncpu = os.cpus().length;
          sendLog('   配置编译选项...\n');
          await execPromise(`cd "${srcDir}" && ./configure --prefix="${imDir}" --disable-docs --without-modules --without-perl --disable-openmp --with-quantum-depth=16 CFLAGS="-O2" 2>&1`, { timeout: 120000 });
          sendLog('   正在编译（可能需要几分钟）...\n');
          await execPromise(`cd "${srcDir}" && make -j${ncpu} 2>&1`, { timeout: 600000 });
          await execPromise(`cd "${srcDir}" && make install 2>&1`, { timeout: 60000 });

          const compiledMagick = path.join(imDir, 'bin', 'magick');
          if (fs.existsSync(compiledMagick)) {
            for (const cmd of ['magick', 'convert']) {
              const dest = path.join(LEGACY_BIN_DIR, cmd);
              try { fs.unlinkSync(dest); } catch (_) {}
              fs.symlinkSync(compiledMagick, dest);
            }
            installed = true;
          }
        } catch (e) {
          sendLog(`   ⚠️ 源码编译失败: ${e.message}\n`);
        }
      }
    }

    if (installed) {
      const legacyMagick = path.join(LEGACY_BIN_DIR, 'magick');
      let health = await verifyImageMagickPngHealth(legacyMagick);
      if (!health.ok) {
        sendLog(`   ⚠️ ImageMagick 健康检查失败: ${health.reason || 'unknown'}\n`);
        sendLog('   正在尝试移除隔离属性并重新校验...\n');
        try {
          await execPromise(`xattr -rd com.apple.quarantine "${path.join(LEGACY_DEPS_DIR, 'imagemagick')}" 2>/dev/null || true`);
          await execPromise(`xattr -rd com.apple.quarantine "${LEGACY_BIN_DIR}/magick" 2>/dev/null || true`);
          await execPromise(`xattr -rd com.apple.quarantine "${LEGACY_BIN_DIR}/convert" 2>/dev/null || true`);
          health = await verifyImageMagickPngHealth(legacyMagick);
        } catch (_) {}
      }

      if (health.ok) {
        try {
          const { stdout } = await execPromise(`"${legacyMagick}" -version`);
          const ver = stdout.split('\n')[0];
          sendLog(`   ✅ ${ver}\n`);
        } catch (_) {
          sendLog('   ✅ ImageMagick 健康检查通过\n');
        }
        sendProgress('imagemagick', 'done', '安装完成');
      } else {
        sendLog(`   ❌ ImageMagick 安装后健康检查仍失败: ${health.reason || 'unknown'}\n`);
        installed = false;
      }
    }
    
    if (!installed) {
      sendLog('   💡 请手动安装 ImageMagick:\n');
      sendLog('      方法1: 安装 Homebrew 后运行 brew install imagemagick\n');
      sendLog('      方法2: 访问 https://imagemagick.org 下载 macOS 版本\n');
      sendProgress('imagemagick', 'error', '安装失败（可手动安装）');
      throw new Error('ImageMagick 安装失败。请手动安装后重试。');
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---- Legacy Gifsicle ----
async function installLegacyGifsicle(sendProgress, sendLog) {
  sendProgress('gifsicle', 'installing', '正在安装...');
  sendLog('\n📦 正在安装 Gifsicle...\n');

  fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
  const tmpDir = path.join(os.tmpdir(), `screensync_gifsicle_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Strategy 1: npm prebuilt binary (no compiler required)
    let installed = false;
    const npmPath = findExecutable('npm')
      || path.join(LEGACY_BIN_DIR, 'npm')
      || path.join(LEGACY_DEPS_DIR, 'node', 'bin', 'npm');
    const npmProj = path.join(tmpDir, 'npm-gifsicle');
    const dest = path.join(LEGACY_BIN_DIR, 'gifsicle');

    if (npmPath && fs.existsSync(npmPath)) {
      try {
        sendLog('   尝试通过 npm 预编译包安装...\n');
        fs.mkdirSync(npmProj, { recursive: true });
        fs.writeFileSync(path.join(npmProj, 'package.json'), JSON.stringify({
          name: 'screensync-gifsicle-fallback',
          private: true
        }, null, 2));
        await execPromise(`cd "${npmProj}" && "${npmPath}" install gifsicle --omit=dev --no-audit --no-fund --silent`, { timeout: 180000 });

        const candidates = [
          path.join(npmProj, 'node_modules', 'gifsicle', 'vendor', 'gifsicle'),
          path.join(npmProj, 'node_modules', '.bin', 'gifsicle')
        ];
        const prebuilt = candidates.find(p => fs.existsSync(p));
        if (prebuilt) {
          try { fs.unlinkSync(dest); } catch (_) {}
          fs.copyFileSync(prebuilt, dest);
          fs.chmodSync(dest, 0o755);
          const { stdout } = await execPromise(`"${dest}" --version`, { timeout: 10000 });
          sendLog(`   ✅ ${stdout.split('\n')[0]}\n`);
          sendProgress('gifsicle', 'done', '安装完成');
          installed = true;
        }
      } catch (e) {
        sendLog(`   ⚠️ npm 预编译安装失败: ${e.message}\n`);
      }
    }

    // Strategy 2: source build fallback
    if (!installed) {
      sendLog('   预编译方式失败，尝试源码编译...\n');
      await execPromise('cc --version', { timeout: 5000 });
      await execPromise(`curl -L "https://www.lcdf.org/gifsicle/gifsicle-1.96.tar.gz" | tar xz -C "${tmpDir}" --strip-components=1`, { timeout: 60000 });
      await execPromise(`cd "${tmpDir}" && ./configure --disable-gifview --prefix="${LEGACY_DEPS_DIR}/gifsicle" 2>&1`, { timeout: 60000 });
      await execPromise(`cd "${tmpDir}" && make -j${os.cpus().length} 2>&1`, { timeout: 120000 });

      const srcBin = path.join(tmpDir, 'src', 'gifsicle');
      if (!fs.existsSync(srcBin)) {
        throw new Error('编译产物未找到');
      }
      try { fs.unlinkSync(dest); } catch (_) {}
      fs.copyFileSync(srcBin, dest);
      fs.chmodSync(dest, 0o755);
      const { stdout } = await execPromise(`"${dest}" --version`);
      sendLog(`   ✅ ${stdout.split('\n')[0]}\n`);
      sendProgress('gifsicle', 'done', '安装完成');
    }
  } catch (e) {
    sendLog(`   ❌ Gifsicle 安装失败: ${e.message}\n`);
    sendProgress('gifsicle', 'error', '安装失败');
    throw new Error(`Gifsicle 安装失败：${e.message}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// Full legacy installation orchestrator
async function installLegacyDeps(event, dependencyStatus, options = {}) {
  console.log('📦 Legacy macOS: 使用直接下载方式安装依赖');
  const depOrder = ['homebrew', 'node', 'imagemagick', 'ffmpeg', 'gifsicle'];
  const restartFrom = options && options.restartFrom;
  const restartIndex = depOrder.includes(restartFrom) ? depOrder.indexOf(restartFrom) : -1;
  const shouldInstall = (dep) => {
    const isMissing = !dependencyStatus[dep];
    if (!isMissing) return false;
    if (restartIndex < 0) return true;
    return depOrder.indexOf(dep) >= restartIndex;
  };

  const sendProgress = (dep, status, message) => {
    try { event.sender.send('dep-install-progress', { dep, status, message }); } catch (e) {}
  };
  const sendLog = (data) => {
    try { event.sender.send('dep-install-log', { data }); } catch (e) {}
  };

  fs.mkdirSync(LEGACY_DEPS_DIR, { recursive: true });
  fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });

  // Homebrew is not needed for direct downloads; mark it as handled if absent
  if (!dependencyStatus.homebrew) {
    sendProgress('homebrew', 'done', '无需安装（直接下载模式）');
  }

  let failedDep = null;
  try {
    if (shouldInstall('node')) {
      failedDep = 'node';
      await installLegacyNode(sendProgress, sendLog);
    }
    if (shouldInstall('imagemagick')) {
      failedDep = 'imagemagick';
      await installLegacyImageMagick(sendProgress, sendLog);
    }
    if (shouldInstall('ffmpeg')) {
      failedDep = 'ffmpeg';
      await installLegacyFFmpeg(sendProgress, sendLog);
    }
    if (shouldInstall('gifsicle')) {
      failedDep = 'gifsicle';
      await installLegacyGifsicle(sendProgress, sendLog);
    }

    // Inject into current process PATH
    if (!process.env.PATH.includes(LEGACY_BIN_DIR)) {
      process.env.PATH = `${LEGACY_BIN_DIR}:${process.env.PATH}`;
    }
    const legacyNodeBin = path.join(LEGACY_DEPS_DIR, 'node', 'bin');
    if (fs.existsSync(legacyNodeBin) && !process.env.PATH.includes(legacyNodeBin)) {
      process.env.PATH = `${legacyNodeBin}:${process.env.PATH}`;
    }
    ensureLegacyBinInShellProfiles(sendLog);

    return { success: true, message: '所有依赖安装完成' };
  } catch (error) {
    sendLog(`\n❌ ${error.message}\n`);
    return { success: false, error: error.message, failedDep: failedDep || null };
  }
}

// In-app dependency installation (no Terminal.app needed)
ipcMain.handle('install-all-dependencies', async (event, dependencyStatus, options = {}) => {
  const fatRuntimeStatus = detectBundledRuntimeFolderStatus(currentInstallPath);
  if (fatRuntimeStatus && fatRuntimeStatus.complete) {
    const sendProgress = (dep, status, message) => {
      try { event.sender.send('dep-install-progress', { dep, status, message }); } catch (_) {}
    };
    sendProgress('homebrew', 'done', '已跳过（Fat Package）');
    sendProgress('node', 'done', '已跳过（Fat Package）');
    sendProgress('imagemagick', 'done', '已跳过（Fat Package）');
    sendProgress('ffmpeg', 'done', '已跳过（Fat Package）');
    sendProgress('gifsicle', 'done', '已跳过（Fat Package）');
    return { success: true, message: 'Fat Package runtime 完整，跳过传统依赖安装', bundled: true, fatPackage: true };
  }

  const bundledRuntime = await detectBundledOfflineRuntime(currentInstallPath);
  if (bundledRuntime && bundledRuntime.available) {
    const sendProgress = (dep, status, message) => {
      try { event.sender.send('dep-install-progress', { dep, status, message }); } catch (_) {}
    };
    sendProgress('homebrew', 'done', '无需安装（离线运行时）');
    sendProgress('node', 'done', '已使用离线运行时');
    sendProgress('imagemagick', 'done', '已使用离线运行时');
    sendProgress('ffmpeg', 'done', '已使用离线运行时');
    sendProgress('gifsicle', 'done', '已使用离线运行时');
    return { success: true, message: '已使用离线运行时，跳过依赖安装', bundled: true };
  }

  // Detect macOS version — use legacy direct-download mode for macOS 13 and below
  const darwinVersion = parseInt(os.release().split('.')[0], 10);
  const isLegacyMacOS = darwinVersion < 23; // Darwin 23 = macOS 14

  if (isLegacyMacOS) {
    return await installLegacyDeps(event, dependencyStatus, options);
  }
  console.log('📦 开始应用内安装依赖，当前状态:', dependencyStatus);

  const depOrder = ['homebrew', 'node', 'imagemagick', 'ffmpeg', 'gifsicle'];
  const restartFrom = options && options.restartFrom;
  const restartIndex = depOrder.includes(restartFrom) ? depOrder.indexOf(restartFrom) : -1;
  const shouldInstall = (dep) => {
    const isMissing = !dependencyStatus[dep];
    if (!isMissing) return false;
    if (restartIndex < 0) return true;
    return depOrder.indexOf(dep) >= restartIndex;
  };

  // 非 Tier1 机器上 Homebrew 可能不可用/不可构建，不将其作为硬前置依赖
  const needsHomebrew = false;
  const brewPackages = [];
  if (shouldInstall('node')) brewPackages.push('node');
  if (shouldInstall('imagemagick')) brewPackages.push('imagemagick');
  if (shouldInstall('ffmpeg')) brewPackages.push('ffmpeg');
  if (shouldInstall('gifsicle')) brewPackages.push('gifsicle');
  const needsPackages = brewPackages.length > 0;

  if (!needsHomebrew && !needsPackages) {
    return { success: true, message: '所有依赖已安装' };
  }

  const sendProgress = (dep, status, message) => {
    try { event.sender.send('dep-install-progress', { dep, status, message }); } catch (e) {}
  };
  const sendLog = (data) => {
    try { event.sender.send('dep-install-log', { data }); } catch (e) {}
  };

  const displayNames = { node: 'Node.js', imagemagick: 'ImageMagick', ffmpeg: 'FFmpeg', gifsicle: 'Gifsicle' };
  const fallbackInstallers = {
    node: installLegacyNode,
    imagemagick: installLegacyImageMagick,
    ffmpeg: installLegacyFFmpeg,
    gifsicle: installLegacyGifsicle
  };
  const installViaFallback = async (pkg, reason = '') => {
    const installer = fallbackInstallers[pkg];
    const name = displayNames[pkg] || pkg;
    if (!installer) throw new Error(`${name} 无可用 fallback 安装器`);
    sendLog(`   ⚠️ ${name} Homebrew 安装失败${reason ? `: ${reason}` : ''}，切换到本地安装模式...\n`);
    await installer(sendProgress, sendLog);
  };

  let failedDep = null;
  try {
    // ===== Phase 1: Install Homebrew =====
    if (needsHomebrew) {
      failedDep = 'homebrew';
      sendProgress('homebrew', 'password', '等待输入密码...');

      // Native macOS password dialog
      let password;
      try {
        password = await new Promise((resolve, reject) => {
          const dialogCmd = `osascript -e 'text returned of (display dialog "安装 Homebrew 需要管理员权限" & return & return & "请输入您的 Mac 登录密码：" default answer "" with hidden answer with title "ScreenSync 安装器" with icon caution)'`;
          exec(dialogCmd, { timeout: 120000 }, (err, stdout) => {
            if (err) reject(new Error('cancelled'));
            else resolve(stdout.trim());
          });
        });
      } catch (e) {
        sendProgress('homebrew', 'error', '已取消');
        return { success: false, error: '已取消密码输入', cancelled: true };
      }

      sendProgress('homebrew', 'installing', '正在安装...');
      sendLog('📦 正在安装 Homebrew...\n');

      const isAppleSilicon = process.arch === 'arm64';
      const brewBin = isAppleSilicon ? '/opt/homebrew/bin' : '/usr/local/bin';
      const escapedPass = escapeForBash(password);

      // Create a temporary SUDO_ASKPASS helper script.
      // Homebrew's install.sh natively checks for SUDO_ASKPASS and adds -A flag.
      // When no TTY is available (Electron spawn), sudo also auto-uses askpass.
      // This eliminates the need for the `script` PTY utility entirely.
      const askpassDir = path.join(os.tmpdir(), `screensync_askpass_${Date.now()}`);
      fs.mkdirSync(askpassDir, { recursive: true });
      const askpassPath = path.join(askpassDir, 'askpass.sh');
      fs.writeFileSync(askpassPath, `#!/bin/bash\necho '${escapedPass}'\n`, { mode: 0o700 });

      try {
        // Step 1: Validate password before starting long install
        sendLog('   正在验证密码...\n');
        try {
          await execPromise(`SUDO_ASKPASS="${askpassPath}" /usr/bin/sudo -A -v`, { timeout: 15000 });
          sendLog('   ✅ 密码验证成功\n');
        } catch (e) {
          sendProgress('homebrew', 'error', '密码错误');
          throw new Error('密码验证失败，请检查密码后重试');
        }

        // Step 2: Download and run Homebrew installer
        sendProgress('homebrew', 'installing', '正在安装...');

        const brewScript = [
          `echo "📦 正在下载并安装 Homebrew（可能需要几分钟）..."`,
          `INSTALL_SCRIPT_PATH="$(mktemp /tmp/screensync-brew-install.XXXXXX.sh)"`,
          `cleanup_install_script() { rm -f "$INSTALL_SCRIPT_PATH" 2>/dev/null || true; }`,
          `trap cleanup_install_script EXIT`,
          `DOWNLOAD_OK=0`,
          `SOURCES=("https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/install/raw/HEAD/install.sh" "https://mirrors.ustc.edu.cn/homebrew/install/raw/HEAD/install.sh" "https://cdn.jsdelivr.net/gh/Homebrew/install@HEAD/install.sh" "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh")`,
          `for src in "\${SOURCES[@]}"; do`,
          `  echo "   尝试下载源: $src"`,
          `  for attempt in 1 2; do`,
          `    if curl -fL --connect-timeout 12 --max-time 45 --retry 2 --retry-all-errors --retry-delay 1 "$src" -o "$INSTALL_SCRIPT_PATH" >/dev/null 2>&1; then`,
          `      if [ -s "$INSTALL_SCRIPT_PATH" ]; then`,
          `        chmod +x "$INSTALL_SCRIPT_PATH" 2>/dev/null || true`,
          `        DOWNLOAD_OK=1`,
          `        break`,
          `      fi`,
          `    fi`,
          `    echo "   下载失败（第$attempt次），重试中..."`,
          `  done`,
          `  if [ "$DOWNLOAD_OK" -eq 1 ]; then break; fi`,
          `done`,
          `if [ "$DOWNLOAD_OK" -ne 1 ]; then`,
          `  echo "❌ 无法下载 Homebrew 安装脚本（所有下载源均不可用）"`,
          `  exit 1`,
          `fi`,
          `/bin/bash "$INSTALL_SCRIPT_PATH"`,
          `BREW_EXIT=$?`,
          `/usr/bin/sudo -k 2>/dev/null || true`,
          isAppleSilicon ? [
            `if [ -f /opt/homebrew/bin/brew ]; then`,
            `  eval "$(/opt/homebrew/bin/brew shellenv)"`,
            `  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile 2>/dev/null || true`,
            `  echo "✅ Homebrew PATH 已配置"`,
            `fi`
          ].join('\n') : '',
          `exit $BREW_EXIT`
        ].filter(Boolean).join('\n');

        await new Promise((resolve, reject) => {
          const child = spawn('/bin/bash', ['-c', brewScript], {
            env: {
              ...process.env,
              NONINTERACTIVE: '1',
              CI: '1',
              SUDO_ASKPASS: askpassPath,
              HOMEBREW_BREW_GIT_REMOTE: 'https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git',
              HOMEBREW_CORE_GIT_REMOTE: 'https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git',
              HOMEBREW_API_DOMAIN: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api',
              HOMEBREW_BOTTLE_DOMAIN: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles'
            }
          });

          const timeout = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (e) {}
            reject(new Error('Homebrew 安装超时（15分钟）'));
          }, 15 * 60 * 1000);

          let allOutput = '';
          let stdoutEnded = false;
          let exitCode = null;

          const tryFinish = () => {
            if (!stdoutEnded || exitCode === null) return;
            clearTimeout(timeout);

            if (exitCode === 0) {
              sendProgress('homebrew', 'done', '安装完成');
              sendLog('\n✅ Homebrew 安装完成\n');
              if (fs.existsSync(path.join(brewBin, 'brew'))) {
                process.env.PATH = `${brewBin}:${process.env.PATH}`;
              }
              resolve();
            } else {
              const hint = allOutput.includes('curl') || allOutput.includes('Failed to connect')
                ? '（网络连接失败，请检查网络或使用代理）' : '';
              sendProgress('homebrew', 'error', `安装失败${hint}`);
              sendLog(`\n❌ exit code: ${exitCode}\n`);
              reject(new Error(`Homebrew 安装失败 (exit code: ${exitCode})${hint}`));
            }
          };

          child.stdout.on('data', (data) => {
            const text = data.toString();
            allOutput += text;
            if (text.trim()) sendLog(text);
          });

          child.stderr.on('data', (data) => {
            const text = data.toString();
            allOutput += text;
            if (text.trim()) sendLog(text);
          });

          child.stdout.on('end', () => { stdoutEnded = true; tryFinish(); });
          child.on('close', (code) => { exitCode = code; tryFinish(); });
          child.on('error', (err) => { clearTimeout(timeout); reject(err); });
        });
      } finally {
        // Securely clean up askpass script (contains password)
        try { fs.rmSync(askpassDir, { recursive: true, force: true }); } catch (e) {}
      }
    }

    // ===== Phase 2: Install brew packages =====
    if (needsPackages) {
      const brewPath = findExecutable('brew')
        || (process.arch === 'arm64' ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew');

      // 如果 brew 不可用，直接走 fallback 本地安装（~/.screensync）
      if (!brewPath || !fs.existsSync(brewPath)) {
        sendLog('⚠️ 未找到可用 Homebrew，改用本地安装模式...\n');
        for (const pkg of brewPackages) {
          failedDep = pkg;
          await installViaFallback(pkg, '未检测到 brew');
        }
        return { success: true, message: '依赖已通过本地安装完成' };
      }
      for (const pkg of brewPackages) {
        failedDep = pkg;
        const name = displayNames[pkg] || pkg;
        sendProgress(pkg, 'installing', '正在安装...');
        sendLog(`\n📦 正在安装 ${name}...\n`);
        try {
          await new Promise((resolve, reject) => {
            const child = spawn(brewPath, ['install', pkg], {
              env: {
                ...process.env,
                HOMEBREW_API_DOMAIN: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api',
                HOMEBREW_BOTTLE_DOMAIN: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles'
              }
            });

            const timeout = setTimeout(() => {
              try { child.kill('SIGTERM'); } catch (e) {}
              reject(new Error(`${name} 安装超时（10分钟）`));
            }, 10 * 60 * 1000);

            child.stdout.on('data', (data) => {
              const text = data.toString();
              if (text.trim()) sendLog(text);
            });

            child.stderr.on('data', (data) => {
              const text = data.toString();
              if (text.trim()) sendLog(text);
            });

            child.on('close', (code) => {
              clearTimeout(timeout);
              if (code === 0) {
                sendProgress(pkg, 'done', '安装完成');
                sendLog(`✅ ${name} 安装完成\n`);
                resolve();
              } else {
                reject(new Error(`${name} 安装失败 (brew exit ${code})`));
              }
            });

            child.on('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });
          if (pkg === 'imagemagick') {
            const magickPath = findExecutable('magick') || findExecutable('convert');
            const health = await verifyImageMagickPngHealth(magickPath);
            if (!health.ok) {
              sendLog(`   ⚠️ Homebrew 安装的 ImageMagick 健康检查失败: ${health.reason || 'unknown'}，改用本地安装模式...\n`);
              await installViaFallback(pkg, `health-check-failed:${health.reason || 'unknown'}`);
            }
          }
        } catch (brewErr) {
          await installViaFallback(pkg, brewErr.message);
        }
      }
    }

    return { success: true, message: '所有依赖安装完成' };
  } catch (error) {
    sendLog(`\n❌ ${error.message}\n`);
    return { success: false, error: error.message, failedDep: failedDep || null };
  }
});

ipcMain.handle('install-dependencies', async (event, installPath) => {
  if (INSTALLER_MOCK) {
    await sleep(700);
    return { success: true, bundled: true, mock: true };
  }
  return new Promise(async (resolve) => {
    console.log('📦 开始安装依赖...');
    console.log('📂 安装路径:', installPath);
    currentInstallPath = installPath || currentInstallPath;
    applyBundledRuntimeEnv(currentInstallPath);
    
    // 严格检查 installPath
    if (!installPath || typeof installPath !== 'string') {
      console.error('❌ 无效的安装路径:', installPath);
      resolve({ 
        success: false, 
        error: `无效的安装路径: ${installPath}\n请尝试重新选择项目文件夹。` 
      });
      return;
    }
    
    try {
      if (!fs.statSync(installPath).isDirectory()) {
        console.error('❌ 安装路径不是目录:', installPath);
        resolve({ 
          success: false, 
          error: `安装路径不是一个有效的目录:\n${installPath}\n请选择包含 package.json 的文件夹。` 
        });
        return;
      }
    } catch (e) {
      console.error('❌ 无法访问安装路径:', e);
       resolve({ 
        success: false, 
        error: `无法访问安装路径:\n${installPath}\n${e.message}` 
      });
      return;
    }
    
    // 验证 package.json 是否存在
    const packageJsonPath = path.join(installPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      console.error('❌ 未找到 package.json:', packageJsonPath);
      resolve({ 
        success: false, 
        error: `未找到 package.json 文件\n路径: ${packageJsonPath}\n请确保安装路径正确。` 
      });
      return;
    }
    
    console.log('✅ 找到 package.json');
    
    const nodeModulesPath = path.join(installPath, 'node_modules');
    const lockFilePath = path.join(installPath, 'package-lock.json');
    const nodeBinForHealth = resolveNodeBinary(installPath);
    if (nodeBinForHealth) {
      try { ensureNpmShimFromNode(nodeBinForHealth); } catch (_) {}
    }

    const fatRuntimeStatus = detectBundledRuntimeFolderStatus(installPath);
    if (fatRuntimeStatus && fatRuntimeStatus.complete && fs.existsSync(nodeModulesPath)) {
      const fatCoreDepsReady = hasRequiredDependencies(installPath);
      if (fatCoreDepsReady) {
        console.log('✅ Fat Package runtime 完整，核心依赖齐全，跳过 npm install');
        resolve({ success: true, bundled: true, fatPackage: true, skippedNpmInstall: true });
        return;
      }
      console.warn('⚠️ Fat Package 核心依赖不完整，将继续走完整依赖安装流程');
    }

    // 离线胖包模式：若已包含完整依赖且可运行，直接跳过 npm install
    const bundledRuntimeQuickCheck = bundledRuntimeBinDirs.length > 0 &&
      !!resolveNodeBinary(installPath) &&
      !!(findExecutable('magick') || findExecutable('convert')) &&
      !!findExecutable('ffmpeg') &&
      !!findExecutable('gifsicle');
    const existingNodeModules = fs.existsSync(nodeModulesPath);
    const existingCoreDepsReady = existingNodeModules && hasRequiredDependencies(installPath);
    if (bundledRuntimeQuickCheck && existingCoreDepsReady) {
      console.log('✅ 检测到离线胖包运行时 + 预置核心 node_modules，跳过在线 npm 安装');
      resolve({ success: true, bundled: true, skippedNpmInstall: true });
      return;
    }

    // 清理可能的冲突文件
    if (fs.existsSync(lockFilePath)) {
      try {
        fs.unlinkSync(lockFilePath);
        console.log('🗑️  已删除旧的 package-lock.json');
      } catch (err) {
        console.warn('⚠️  无法删除 package-lock.json:', err.message);
      }
    }
    
    // 清理旧的 node_modules（避免缓存问题）
    if (fs.existsSync(nodeModulesPath)) {
      try {
        fs.rmSync(nodeModulesPath, { recursive: true, force: true });
        console.log('🗑️  已删除旧的 node_modules');
      } catch (err) {
        console.warn('⚠️  无法删除 node_modules:', err.message);
      }
    }
    
    const darwinVersion = parseInt(os.release().split('.')[0], 10);
    const isLegacyMacOS = darwinVersion < 23; // Homebrew skipped mode
    let npmPath = resolveNpmBinary()
      || (process.arch === 'arm64' ? '/opt/homebrew/bin/npm' : '/usr/local/bin/npm');

    if (isLegacyMacOS && !isUsableNpmBinary(npmPath)) {
      const legacyNode = resolveNodeBinary(installPath);
      if (legacyNode && ensureNpmShimFromNode(legacyNode)) {
        npmPath = resolveNpmBinary() || npmPath;
        event.sender.send('install-output', { type: 'stdout', data: '🔧 已从本地 Node 自动修复 npm\n' });
      }
    }

    if (isLegacyMacOS && !isUsableNpmBinary(npmPath)) {
      const sendProgress = (dep, status, message) => {
        try { event.sender.send('dep-install-progress', { dep, status, message }); } catch (_) {}
      };
      const sendLog = (data) => {
        try { event.sender.send('dep-install-log', { data }); } catch (_) {}
      };
      sendLog('⚠️ Legacy 模式下未检测到可用 npm，正在补装本地 Node 运行时...\n');
      installLegacyNode(sendProgress, sendLog).then(() => {
        npmPath = resolveNpmBinary() || npmPath;
      }).catch((e) => {
        event.sender.send('install-output', { type: 'stderr', data: `❌ 自动补装 Node 失败: ${e.message}\n` });
      }).finally(() => {
        proceedWithNpmInstall();
      });
      return;
    }
    proceedWithNpmInstall();

    function proceedWithNpmInstall() {
    console.log('📦 npm 路径:', npmPath);

    // 调试：打印详细的路径信息
    try {
        const installStat = fs.statSync(installPath);
        console.log(`[DEBUG] installPath: ${installPath}, isDirectory: ${installStat.isDirectory()}`);
        
        // 尝试解析 npmPath 的真实路径（处理软链接）
        let realNpmPath = npmPath;
        if (fs.existsSync(npmPath)) {
            realNpmPath = fs.realpathSync(npmPath);
            console.log(`[DEBUG] npmPath resolved: ${realNpmPath}`);
        } else {
            console.warn(`[DEBUG] npmPath does not exist: ${npmPath}`);
        }
    } catch(e) {
        console.error('[DEBUG] stat error:', e);
    }

    // 终极调试：如果 spawn 失败，尝试使用 exec (更宽松)
    // 很多时候 spawn 对 PATH 的处理比 exec 严格
    // 且 spawn 需要可执行文件路径，exec 可以直接运行命令字符串
    
    // 设置超时定时器（5分钟）
    let installTimeout = setTimeout(() => {
      console.error('❌ npm install 超时（5分钟）');
      try {
        child.kill('SIGTERM');
      } catch (e) {}
      resolve({ 
        success: false, 
        error: 'npm 安装超时（5分钟）\n可能原因：\n1. 网络连接缓慢\n2. npm 镜像源响应慢' 
      });
    }, 5 * 60 * 1000);
    
    // 改用 exec 尝试规避 spawn ENOTDIR 问题
    // spawn 需要一个文件作为第一个参数，如果 npmPath 是个复杂的脚本或者环境有问题容易挂
    // exec 直接在 shell 中执行字符串，兼容性更好
    // 使用 --prefix 来规避 cwd 在只读卷下的问题
    // 添加 --omit=dev 以跳过开发依赖，加快安装速度
    const installPathQ = JSON.stringify(installPath).slice(1, -1);
    const commandStr = `(cd ${JSON.stringify(installPath)} && "${npmPath}" install --legacy-peer-deps --omit=dev --include=optional --no-audit --no-fund --registry=https://registry.npmmirror.com || "${npmPath}" install --legacy-peer-deps --omit=dev --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org)`;
    console.log(`[DEBUG] Executing command: ${commandStr}`);

    const child = exec(commandStr, {
      cwd: installPath,
      env: {
        ...process.env,
        npm_config_loglevel: 'info',
        npm_config_strict_ssl: 'false',
        PATH: `${path.dirname(npmPath)}:${process.env.PATH}`
      }
    });
    
    /* 
    // 原 spawn 代码保留作为参考
    const child = spawn(npmPath, ['install', '--legacy-peer-deps', '--registry=https://registry.npmmirror.com'], {
      cwd: installPath,
      // ...
    });
    */
    
    let output = '';
    let errorOutput = '';
    let lastProgressUpdate = Date.now();
    
    // 定期发送心跳，模拟进度更新
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - lastProgressUpdate;
      if (elapsed > 3000) { // 如果超过3秒没有输出
        event.sender.send('install-heartbeat', { 
          message: '正在下载依赖包...' 
        });
      }
    }, 3000);
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      lastProgressUpdate = Date.now();
      console.log('[npm stdout]', text);
      event.sender.send('install-output', { type: 'stdout', data: text });
    });
    
    child.stderr.on('data', (data) => {
      const text = data.toString();
      // npm 的很多信息输出到 stderr，不一定是错误
      errorOutput += text;
      lastProgressUpdate = Date.now();
      console.log('[npm stderr]', text);
      event.sender.send('install-output', { type: 'stderr', data: text });
    });
    
    child.on('close', (code) => {
      clearTimeout(installTimeout);
      clearInterval(progressInterval);
      console.log('📦 npm install 完成，退出码:', code);
      
      if (code === 0) {
        // 验证 node_modules 是否存在且包含关键依赖
        const dotenvPath = path.join(nodeModulesPath, 'dotenv');
        const wsPath = path.join(nodeModulesPath, 'ws');
        
        if (!fs.existsSync(nodeModulesPath)) {
          console.error('❌ node_modules 未创建');
          resolve({ 
            success: false, 
            error: 'node_modules 文件夹未创建，安装可能失败。\n请检查网络连接和磁盘空间。' 
          });
          return;
        }
        
        if (!fs.existsSync(dotenvPath)) {
          console.error('❌ 关键依赖 dotenv 未安装');
          resolve({ 
            success: false, 
            error: '关键依赖安装不完整。\n请检查网络连接，或尝试重新安装。' 
          });
          return;
        }
        
        // 额外验证关键依赖
        const criticalDeps = ['ws', 'express', 'chokidar'];
        for (const dep of criticalDeps) {
          const depPath = path.join(nodeModulesPath, dep);
          if (!fs.existsSync(depPath)) {
            console.error(`❌ 关键依赖 ${dep} 未安装`);
            resolve({ 
              success: false, 
              error: `关键依赖 ${dep} 安装失败。\n请检查网络连接，或尝试重新安装。` 
            });
            return;
          }
        }
        
        console.log('✅ 依赖安装验证成功（所有关键依赖已确认）');
        resolve({ success: true });
      } else {
        console.error('❌ npm install 失败');
        resolve({ 
          success: false, 
          error: errorOutput || `npm 安装失败（退出码: ${code}）\n\n${output.slice(-500)}` 
        });
      }
    });
    
    child.on('error', (error) => {
      clearTimeout(installTimeout);
      clearInterval(progressInterval);
      console.error('❌ 启动 npm 失败:', error);
      resolve({ 
        success: false, 
        error: `无法启动 npm: ${error.message}\n请确保 Node.js 和 npm 已正确安装。` 
      });
    });
    }
  });
});

ipcMain.handle('save-language', async (event, installPath, language) => {
  if (INSTALLER_MOCK) {
    return { success: true, mock: true };
  }
  try {
    const configPath = path.join(installPath, '.user-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    config.language = language || 'zh';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    console.warn('Save language failed:', e.message);
    return { success: false };
  }
});

ipcMain.handle('setup-config', async (event, installPath, syncMode, localFolder) => {
  if (INSTALLER_MOCK) {
    await sleep(420);
    return { success: true, userId: 'mock@screensync.local', mock: true };
  }
  return new Promise((resolve) => {
    try {
      const configPath = path.join(installPath, '.user-config.json');
      const syncModePath = path.join(installPath, '.sync-mode');
      
      // 创建用户配置
      const username = os.userInfo().username;
      const hostname = os.hostname();
      const userId = `${username}@${hostname}`;
      
      const config = {
        userId: userId,
        folderName: `ScreenSync-${userId}`,
        userFolderId: null,
        localDownloadFolder: localFolder || path.join(installPath, '../ScreenSyncImg'),
        installPath: installPath,
        createdAt: new Date().toISOString()
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      fs.writeFileSync(syncModePath, syncMode, 'utf8');
      
      // 创建本地文件夹
      if (localFolder && !fs.existsSync(localFolder)) {
        fs.mkdirSync(localFolder, { recursive: true });
      }
      
      // 如果是 iCloud 模式，配置该文件夹为"始终保留下载"
      if (syncMode === 'icloud' && localFolder) {
        try {
          console.log('正在配置 iCloud 文件夹为"始终保留下载"...');
          exec(`brctl download -R "${localFolder}"`);
        } catch (e) {
          console.warn('配置始终保留下载失败:', e.message);
        }
      }
      
      resolve({ success: true, userId: userId });
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
});

// 辅助函数：检查端口是否被占用
function checkPort(port) {
  return new Promise((resolve) => {
    exec(`lsof -i :${port} -sTCP:LISTEN`, (error, stdout) => {
      resolve(!!stdout);
    });
  });
}

ipcMain.handle('start-server', async (event, installPath) => {
  return new Promise(async (resolve) => {
    currentInstallPath = installPath || currentInstallPath;
    applyBundledRuntimeEnv(currentInstallPath);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // 1. 先检查服务是否已经在运行 (端口 8888)
    const isRunning = await checkPort(8888);
    if (isRunning) {
      console.log('Server already running on port 8888');
      finish({ success: true, message: '服务器已在运行' });
      return;
    }

    const nodePath = resolveNodeBinary(installPath);
    
    const startScript = path.join(installPath, 'start.js');
    
    if (!fs.existsSync(startScript)) {
      finish({ success: false, error: '未找到 start.js 文件' });
      return;
    }

    if (!nodePath) {
      finish({ success: false, error: '未找到可用的 Node.js 可执行文件（请检查 Node 安装）' });
      return;
    }

    // Remove stale start.js lock file so the new process won't exit(0) immediately.
    // Also kill any orphaned start.js that might still be holding the lock.
    try {
      const lockDir = path.join(os.tmpdir(), 'screensync-locks');
      const lockHash = require('crypto').createHash('md5').update(installPath).digest('hex');
      const lockFile = path.join(lockDir, `start-${lockHash}.lock`);
      if (fs.existsSync(lockFile)) {
        try {
          const lockInfo = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
          if (lockInfo && lockInfo.pid) {
            try { process.kill(lockInfo.pid, 'SIGKILL'); } catch (_) {}
          }
        } catch (_) {}
        try { fs.unlinkSync(lockFile); } catch (_) {}
      }
    } catch (_) {}

    const child = spawn(nodePath, [startScript], {
      cwd: installPath,
      stdio: 'pipe',
      detached: true,
      shell: false,
      env: { ...process.env }
    });
    
    let output = '';
    let exitSummary = '';
    
    child.stdout.on('data', (data) => {
      output += data.toString();
      event.sender.send('server-output', { data: data.toString() });
    });
    
    child.stderr.on('data', (data) => {
      output += data.toString();
      event.sender.send('server-output', { data: data.toString() });
    });

    child.on('exit', (code, signal) => {
      exitSummary = `server exited early (code=${code}, signal=${signal || 'none'})`;
    });
    
    // 等待几秒并多次检查服务器是否正常启动（最多 60 秒，兼容较慢的 Intel 机器）
    let checkAttempts = 0;
    const maxCheckAttempts = 20;
    const checkInterval = setInterval(async () => {
      if (settled) {
        clearInterval(checkInterval);
        return;
      }
      checkAttempts++;
      
      const isRunning = await checkPort(8888);
      if (isRunning) {
        clearInterval(checkInterval);
        console.log(`✅ 服务器启动验证成功（第 ${checkAttempts} 次检查）`);
        finish({ success: true, pid: child.pid });
        return;
      }

      if (exitSummary) {
        clearInterval(checkInterval);
        const outputTail = output.trim().slice(-2000);
        finish({
          success: false,
          error: `服务器启动失败\n${exitSummary}\n\n${outputTail ? '启动输出:\n' + outputTail : ''}`
        });
        return;
      }
      
      if (checkAttempts >= maxCheckAttempts) {
        clearInterval(checkInterval);
        console.error(`❌ 服务器启动验证失败（检查了 ${checkAttempts} 次）`);
        
        // 读取错误日志
        const errorLogPath = path.join(installPath, 'server-error.log');
        let errorDetails = '';
        if (fs.existsSync(errorLogPath)) {
          try {
            const errorLog = fs.readFileSync(errorLogPath, 'utf8');
            errorDetails = errorLog.slice(-500);
          } catch (e) {
            // 忽略
          }
        }
        const outputTail = output.trim().slice(-2000);
        
        finish({ 
          success: false, 
          error: `服务器启动失败\n端口 8888 在 60 秒内未响应\n\n${outputTail ? '启动输出:\n' + outputTail + '\n\n' : ''}${errorDetails ? '错误日志:\n' + errorDetails : ''}` 
        });
      } else {
        console.log(`   检查服务器状态... (${checkAttempts}/${maxCheckAttempts})`);
      }
    }, 3000);
    
    child.on('error', (error) => {
      clearInterval(checkInterval);
      finish({ success: false, error: error.message });
    });
  });
});

ipcMain.handle('copy-to-clipboard', async (event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

function setupAutostartInternal(installPath) {
  return new Promise((resolve) => {
    try {
      const nodePath = resolveNodeBinary(installPath);
      if (!nodePath) {
        throw new Error('无法找到 Node.js 可执行文件。请确保 Node.js 已正确安装。');
      }
      console.log('🚀 配置自启动，使用 Node 路径:', nodePath);

      // 安装器最后一步需要严格校验自启动是否真的可用，不把直接启动兜底视为成功。
      const scriptPath = path.join(installPath, 'setup-autostart.js');
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`未找到 setup-autostart.js: ${scriptPath}`);
      }

      exec(`"${nodePath}" "${scriptPath}" "${installPath}"`, {
        env: {
          ...process.env,
          SCREENSYNC_INSTALLER_STRICT_AUTOSTART: '1'
        }
      }, (error, stdout, stderr) => {
        let parsed = null;
        try {
          const line = (stdout || '').trim().split('\n').filter(Boolean).pop();
          parsed = line ? JSON.parse(line) : null;
        } catch (_) {}

        if (parsed && parsed.success) {
          resolve({
            success: true,
            message: parsed.message || '服务器已配置为开机自动启动'
          });
          return;
        }

        const detail = (parsed && (parsed.error || parsed.message))
          || (stderr || stdout || (error && error.message) || '未知错误');
        resolve({
          success: false,
          error: `配置自动启动失败\n${detail}`
        });
      });
      
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
}

// 配置服务器自动启动（LaunchAgent）
ipcMain.handle('setup-autostart', async (event, installPath) => {
  return setupAutostartInternal(installPath);
});

ipcMain.handle('finalize-installation', async (event, installPath, options = {}) => {
  if (INSTALLER_MOCK) {
    await sleep(900);
    if (mockInstallerState.finalResult === 'error') {
      return {
        success: false,
        error: 'Mock final step failed',
        detail: 'Mock 模式：模拟了最后一步失败。\n\n可在底部 Mock 工具栏切换为“最终成功”后重新进入最后一步。'
      };
    }
    return { success: true, mock: true, message: 'Mock success' };
  }
  const targetPath = installPath || currentInstallPath;
  if (!targetPath || typeof targetPath !== 'string') {
    return { success: false, error: '无效的安装路径。' };
  }

  currentInstallPath = targetPath;
  applyBundledRuntimeEnv(currentInstallPath);

  const logs = [];
  const sendLog = (message) => {
    const text = cleanPtyOutput(String(message || '')).trim();
    if (text) logs.push(text);
  };

  const appendDetail = (detail) => {
    const text = cleanPtyOutput(String(detail || '')).trim();
    if (text) logs.push(text);
  };

  try {
    if (!options.skipWarmup) {
      const warmupResult = await warmupBundledRuntimeExecutables(currentInstallPath, sendLog);
      if (!warmupResult.success) {
        appendDetail(warmupResult.error);
        return {
          success: false,
          error: warmupResult.error,
          failedTool: warmupResult.failedTool || null,
          detail: logs.join('\n')
        };
      }
    } else {
      sendLog('⏭️ 已完成权限验证，跳过重复预热。');
    }

    sendLog('🚀 正在配置开机自启动并验证服务器启动...');
    const autostartResult = await setupAutostartInternal(currentInstallPath);
    if (!autostartResult.success) {
      appendDetail(autostartResult.error);
      return {
        success: false,
        error: autostartResult.error,
        failedTool: 'autostart',
        detail: logs.join('\n')
      };
    }

    sendLog('✅ 安装阶段权限预热与服务器配置完成。');
    return {
      success: true,
      message: autostartResult.message || '安装成功',
      detail: logs.join('\n')
    };
  } catch (error) {
    appendDetail(error && error.message ? error.message : String(error));
    return {
      success: false,
      error: error && error.message ? error.message : String(error),
      detail: logs.join('\n')
    };
  }
});

// 配置 iCloud 文件夹为"始终保留下载"
ipcMain.handle('setup-icloud-keep-downloaded', async () => {
  if (INSTALLER_MOCK) {
    await sleep(180);
    return { success: true, mock: true };
  }
  return new Promise((resolve) => {
    try {
      const icloudPath = path.join(
        os.homedir(),
        'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
      );
      
      console.log('☁️  配置 iCloud 文件夹为"始终保留下载"...');
      console.log('   路径:', icloudPath);
      
      // 确保文件夹存在
      if (!fs.existsSync(icloudPath)) {
        console.log('   📁 文件夹不存在，正在创建...');
        fs.mkdirSync(icloudPath, { recursive: true });
        console.log('   ✅ 文件夹已创建');
      }
      
      // 使用 brctl 命令设置文件夹为"始终保留下载"
      // -R 表示递归（包括子文件夹和文件）
      const command = `brctl download -R "${icloudPath}"`;
      
      exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          console.warn('   ⚠️  brctl 命令执行失败（这不影响基本功能）:', error.message);
          if (stderr) {
            console.warn('   stderr:', stderr);
          }
          // 即使失败也返回成功，因为这不是关键功能
          resolve({ 
            success: true, 
            warning: 'brctl 命令执行失败，但不影响基本功能',
            message: error.message
          });
        } else {
          console.log('   ✅ iCloud 文件夹已配置为"始终保留下载"');
          if (stdout) {
            console.log('   输出:', stdout.trim());
          }
          resolve({ success: true });
        }
      });
      
    } catch (error) {
      console.error('❌ 配置 iCloud 文件夹失败:', error.message);
      // 即使失败也返回成功，因为这不是关键功能
      resolve({ 
        success: true, 
        warning: '配置失败，但不影响基本功能',
        message: error.message
      });
    }
  });
});

// 退出应用
ipcMain.handle('quit-app', () => {
  if (INSTALLER_MOCK) {
    return { success: true, mock: true };
  }
  console.log('收到退出请求，正在退出应用...');
  app.quit();
});

