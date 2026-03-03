const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
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

  mainWindow.loadFile('index.html');

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
// 自动检测项目根目录
ipcMain.handle('get-project-root', async () => {
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
            return found;
          }
          // DMG 可能嵌套一层，查父目录
          const parentFound = findProjectFiles(path.dirname(dmgDir));
          if (parentFound) {
            console.log('✅ 通过 DMG 父目录找到项目:', parentFound);
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
    return { success: true, path: selectedPath };
  }
  
  // 检查 2: 是安装包根目录（包含 "项目文件/package.json"）
  const projectFilesPath = path.join(selectedPath, '项目文件');
  if (fs.existsSync(path.join(projectFilesPath, 'package.json'))) {
    console.log('✅ 手动选择的是安装包根目录，自动定位到项目文件:', projectFilesPath);
    return { success: true, path: projectFilesPath };
  }

  return { 
    success: false, 
    error: '选择的文件夹不正确。\n\n请选择包含 "package.json" 的文件夹，或者解压后的 "ScreenSync-Apple" / "ScreenSync-Intel" 文件夹。' 
  };
});

// 辅助函数：查找可执行文件并更新 PATH
function findExecutable(name) {
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

function resolveNodeBinary() {
  const candidates = [];

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

ipcMain.handle('check-homebrew', async () => {
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

ipcMain.handle('check-node', async () => {
  return new Promise((resolve) => {
    const nodePath = resolveNodeBinary();
    
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

ipcMain.handle('check-imagemagick', async () => {
  return new Promise((resolve) => {
    // ImageMagick 7 uses 'magick' as the primary binary; 'convert' is legacy/deprecated.
    const magickPath = findExecutable('magick');
    if (magickPath) {
      exec(`"${magickPath}" -version`, (error, stdout, stderr) => {
        const combined = (stdout || '') + (stderr || '');
        if (!error && combined.includes('ImageMagick')) {
          const versionMatch = combined.match(/Version: ImageMagick ([\d.]+)/);
          const version = versionMatch ? versionMatch[1] : 'unknown';
          resolve({ installed: true, version: version });
        } else {
          // magick found but -version failed, try convert as fallback
          tryConvertFallback(resolve);
        }
      });
    } else {
      tryConvertFallback(resolve);
    }

    function tryConvertFallback(res) {
      const convertPath = findExecutable('convert');
      if (convertPath) {
        exec(`"${convertPath}" -version`, (error, stdout, stderr) => {
          const combined = (stdout || '') + (stderr || '');
          if (!error && combined.includes('ImageMagick')) {
            const versionMatch = combined.match(/Version: ImageMagick ([\d.]+)/);
            const version = versionMatch ? versionMatch[1] : 'unknown';
            res({ installed: true, version: version });
          } else {
            res({ installed: false });
          }
        });
      } else {
        res({ installed: false });
      }
    }
  });
});

ipcMain.handle('check-ffmpeg', async () => {
  return new Promise((resolve) => {
    const ffmpegPath = findExecutable('ffmpeg');
    
    if (ffmpegPath) {
      exec('ffmpeg -version', (error, output) => {
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

ipcMain.handle('check-gifsicle', async () => {
  return new Promise((resolve) => {
    const gifsiclePath = findExecutable('gifsicle');
    
    if (gifsiclePath) {
      exec('gifsicle --version', (error, output) => {
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

ipcMain.handle('check-icloud-space', async () => {
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
  return new Promise((resolve) => {
    // 使用 AppleScript 获取管理员权限执行命令
    const command = "spctl --master-disable";
    const script = `do shell script "${command}" with administrator privileges`;
    
    exec(`osascript -e '${script}'`, (error) => {
      // 即使用户取消或失败，我们也继续，不阻塞安装流程
      resolve({ success: !error });
    });
  });
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
      try {
        const { stdout } = await execPromise(`"${path.join(LEGACY_BIN_DIR, 'magick')}" -version`);
        const ver = stdout.split('\n')[0];
        sendLog(`   ✅ ${ver}\n`);
        sendProgress('imagemagick', 'done', '安装完成');
      } catch (e) {
        sendLog(`   ⚠️ ImageMagick 二进制文件已安装但无法执行: ${e.message}\n`);
        sendLog('   可能需要移除 macOS 隔离属性，正在尝试...\n');
        try {
          await execPromise(`xattr -rd com.apple.quarantine "${path.join(LEGACY_DEPS_DIR, 'imagemagick')}" 2>/dev/null || true`);
          await execPromise(`xattr -rd com.apple.quarantine "${LEGACY_BIN_DIR}/magick" 2>/dev/null || true`);
          await execPromise(`xattr -rd com.apple.quarantine "${LEGACY_BIN_DIR}/convert" 2>/dev/null || true`);
          const { stdout: retryOut } = await execPromise(`"${path.join(LEGACY_BIN_DIR, 'magick')}" -version`);
          sendLog(`   ✅ ${retryOut.split('\n')[0]}\n`);
          sendProgress('imagemagick', 'done', '安装完成');
        } catch (e2) {
          sendLog(`   ❌ ImageMagick 安装后仍无法运行: ${e2.message}\n`);
          installed = false;
        }
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
    // Check if C compiler is available
    try { await execPromise('cc --version', { timeout: 5000 }); } catch (e) {
      sendLog('   ⚠️ 未找到 C 编译器，跳过 Gifsicle（不影响基本功能）\n');
      sendProgress('gifsicle', 'done', '已跳过（可选组件）');
      return;
    }

    sendLog('   正在下载源码...\n');
    await execPromise(`curl -L "https://www.lcdf.org/gifsicle/gifsicle-1.96.tar.gz" | tar xz -C "${tmpDir}" --strip-components=1`, { timeout: 60000 });

    sendLog('   正在编译...\n');
    await execPromise(`cd "${tmpDir}" && ./configure --disable-gifview --prefix="${LEGACY_DEPS_DIR}/gifsicle" 2>&1`, { timeout: 60000 });
    await execPromise(`cd "${tmpDir}" && make -j${os.cpus().length} 2>&1`, { timeout: 120000 });

    const srcBin = path.join(tmpDir, 'src', 'gifsicle');
    if (fs.existsSync(srcBin)) {
      const dest = path.join(LEGACY_BIN_DIR, 'gifsicle');
      try { fs.unlinkSync(dest); } catch (e) {}
      fs.copyFileSync(srcBin, dest);
      fs.chmodSync(dest, 0o755);

      const { stdout } = await execPromise(`"${dest}" --version`);
      sendLog(`   ✅ ${stdout.split('\n')[0]}\n`);
      sendProgress('gifsicle', 'done', '安装完成');
    } else {
      throw new Error('编译产物未找到');
    }
  } catch (e) {
    sendLog(`   ⚠️ Gifsicle 安装失败: ${e.message}（不影响基本功能）\n`);
    sendProgress('gifsicle', 'done', '已跳过（可选组件）');
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

  const needsHomebrew = shouldInstall('homebrew');
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

      if (!brewPath || !fs.existsSync(brewPath)) {
        return { success: false, error: '未找到 Homebrew，无法安装依赖包' };
      }

      const displayNames = { node: 'Node.js', imagemagick: 'ImageMagick', ffmpeg: 'FFmpeg', gifsicle: 'Gifsicle' };

      for (const pkg of brewPackages) {
        failedDep = pkg;
        const name = displayNames[pkg] || pkg;
        sendProgress(pkg, 'installing', '正在安装...');
        sendLog(`\n📦 正在安装 ${name}...\n`);

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
              sendProgress(pkg, 'error', '安装失败');
              reject(new Error(`${name} 安装失败`));
            }
          });

          child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
      }
    }

    return { success: true, message: '所有依赖安装完成' };
  } catch (error) {
    sendLog(`\n❌ ${error.message}\n`);
    return { success: false, error: error.message, failedDep: failedDep || null };
  }
});

ipcMain.handle('install-dependencies', async (event, installPath) => {
  return new Promise((resolve) => {
    console.log('📦 开始安装依赖...');
    console.log('📂 安装路径:', installPath);
    
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
    
    // 清理可能的冲突文件
    const lockFilePath = path.join(installPath, 'package-lock.json');
    const nodeModulesPath = path.join(installPath, 'node_modules');
    
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
    
    const npmPath = findExecutable('npm')
      || (process.arch === 'arm64' ? '/opt/homebrew/bin/npm' : '/usr/local/bin/npm');
    
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
    const commandStr = `"${npmPath}" install --legacy-peer-deps --omit=dev --registry=https://registry.npmmirror.com --prefix "${installPath}"`;
    console.log(`[DEBUG] Executing command: ${commandStr}`);

    // 重要：将 cwd 设置为 /tmp，避免 ENOTDIR
    const child = exec(commandStr, {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        npm_config_loglevel: 'info',
        npm_config_strict_ssl: 'false',
        // 确保 PATH 包含 npm 所在的目录
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
        const criticalDeps = ['ws', 'express', 'sharp', 'chokidar'];
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
  });
});

ipcMain.handle('save-language', async (event, installPath, language) => {
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
    // 1. 先检查服务是否已经在运行 (端口 8888)
    const isRunning = await checkPort(8888);
    if (isRunning) {
      console.log('Server already running on port 8888');
      resolve({ success: true, message: '服务器已在运行' });
      return;
    }

    const nodePath = resolveNodeBinary();
    
    const startScript = path.join(installPath, 'start.js');
    
    if (!fs.existsSync(startScript)) {
      resolve({ success: false, error: '未找到 start.js 文件' });
      return;
    }

    if (!nodePath) {
      resolve({ success: false, error: '未找到可用的 Node.js 可执行文件（请检查 Node 安装）' });
      return;
    }
    
    const child = spawn(nodePath, [startScript], {
      cwd: installPath,
      stdio: 'pipe',
      detached: true,
      shell: false
    });
    
    let output = '';
    
    child.stdout.on('data', (data) => {
      output += data.toString();
      event.sender.send('server-output', { data: data.toString() });
    });
    
    child.stderr.on('data', (data) => {
      output += data.toString();
      event.sender.send('server-output', { data: data.toString() });
    });
    
    // 等待几秒并多次检查服务器是否正常启动（最多 30 秒）
    let checkAttempts = 0;
    const maxCheckAttempts = 10;
    const checkInterval = setInterval(async () => {
      checkAttempts++;
      
      const isRunning = await checkPort(8888);
      if (isRunning) {
        clearInterval(checkInterval);
        console.log(`✅ 服务器启动验证成功（第 ${checkAttempts} 次检查）`);
        resolve({ success: true, pid: child.pid });
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
        
        resolve({ 
          success: false, 
          error: `服务器启动失败\n端口 8888 在 30 秒内未响应\n\n${errorDetails ? '错误日志:\n' + errorDetails : ''}` 
        });
      } else {
        console.log(`   检查服务器状态... (${checkAttempts}/${maxCheckAttempts})`);
      }
    }, 3000);
    
    child.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });
  });
});

ipcMain.handle('copy-to-clipboard', async (event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

// 配置服务器自动启动（LaunchAgent）
ipcMain.handle('setup-autostart', async (event, installPath) => {
  return new Promise((resolve) => {
    try {
      const nodePath = resolveNodeBinary();
      if (!nodePath) {
        throw new Error('无法找到 Node.js 可执行文件。请确保 Node.js 已正确安装。');
      }
      console.log('🚀 配置自启动，使用 Node 路径:', nodePath);

      // 复用更健壮的 setup-autostart.js（含 load/bootstrap 双路径、端口验证、直接启动兜底）
      const scriptPath = path.join(installPath, 'setup-autostart.js');
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`未找到 setup-autostart.js: ${scriptPath}`);
      }

      exec(`"${nodePath}" "${scriptPath}" "${installPath}"`, (error, stdout, stderr) => {
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
});

// 配置 iCloud 文件夹为"始终保留下载"
ipcMain.handle('setup-icloud-keep-downloaded', async () => {
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
  console.log('收到退出请求，正在退出应用...');
  app.quit();
});

