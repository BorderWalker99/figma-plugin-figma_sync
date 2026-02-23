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
    height: 500,
    minWidth: 600,
    minHeight: 500,
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
  // 获取 Installer.app 的实际路径
  // app.getAppPath() 返回 .app 内部的 Resources 路径
  let appPath = app.getAppPath();
  
  console.log('原始 appPath:', appPath);
  
  // 如果是打包后的应用（app.asar），需要特殊处理
  if (appPath.includes('.asar')) {
    // 移除 .asar 及其后的路径
    appPath = appPath.replace(/\.asar.*$/, '.asar');
  }
  
  // 打包后的路径通常是: .../ScreenSync Installer.app/Contents/Resources/app.asar
  // 我们需要向上找到 .app，然后再向上一级找到 UserPackage 根目录
  let currentPath = appPath;
  
  // 1. 先找到 .app 包
  while (currentPath !== '/' && !currentPath.endsWith('.app')) {
    currentPath = path.dirname(currentPath);
  }
  
  console.log('找到 .app 路径:', currentPath);
  
  // 2. .app 的父目录就是 UserPackage 根目录
  const userPackageRoot = path.dirname(currentPath);
  
  console.log('UserPackage 根目录:', userPackageRoot);
  
  // 3. 验证该目录下的"项目文件"子目录是否有 package.json（新结构）
  const projectFilesPath = path.join(userPackageRoot, '项目文件');
  const packageJsonPath = path.join(projectFilesPath, 'package.json');
  
  if (fs.existsSync(packageJsonPath)) {
    console.log('✅ 找到 package.json:', packageJsonPath);
    // 返回"项目文件"目录作为项目根目录
    return projectFilesPath;
  }
  
  // 兼容旧结构：检查根目录是否直接有 package.json
  const oldPackageJsonPath = path.join(userPackageRoot, 'package.json');
  if (fs.existsSync(oldPackageJsonPath)) {
    console.log('✅ 找到 package.json（旧结构）:', oldPackageJsonPath);
    return userPackageRoot;
  }
  
  console.warn('⚠️ 未在预期位置找到 package.json，尝试备用路径');
  
  // 备用方案：检查当前目录及其父目录（包括"项目文件"子目录）
  // 注意：必须排除 appPath 本身（如果它是 asar），因为 Electron fs 可能会错误地认为 asar 里的 package.json 是我们我们要找的
  const fallbackPaths = [
    // appPath, // 移除这个，防止定位到 installer 自己的 asar
    path.dirname(appPath),
    path.dirname(path.dirname(appPath)),
    path.dirname(path.dirname(path.dirname(appPath)))
  ];
  
  for (const testPath of fallbackPaths) {
    // 先检查"项目文件"子目录（新结构）
    const projectFilesTestPath = path.join(testPath, '项目文件');
    const testPackageJsonNew = path.join(projectFilesTestPath, 'package.json');
    if (fs.existsSync(testPackageJsonNew)) {
      console.log('✅ 备用路径找到 package.json（新结构）:', testPackageJsonNew);
      return projectFilesTestPath;
    }
    
    // 再检查直接路径（旧结构兼容）
    const testPackageJson = path.join(testPath, 'package.json');
    if (fs.existsSync(testPackageJson)) {
      console.log('✅ 备用路径找到 package.json（旧结构）:', testPackageJson);
      return testPath;
    }
  }
  
  // 4. 特殊处理：如果是在 DMG 中运行，尝试反向查找 DMG 文件路径
  // 例如 appPath 是 /Volumes/ScreenSync Installer/ScreenSync Installer.app
  // 则 userPackageRoot 是 /Volumes/ScreenSync Installer
  // 我们需要找到这个 Volume 对应的 DMG 镜像文件路径
  if (appPath.startsWith('/Volumes/')) {
    console.log('⚠️ 检测到在 Volume 中运行，尝试查找 DMG 源文件路径...');
    
    try {
      // 获取挂载点名称 (例如 /Volumes/ScreenSync Installer)
      const volumePath = appPath.split('.app')[0].substring(0, appPath.split('.app')[0].lastIndexOf('/'));
      console.log('挂载点:', volumePath);
      
      // 使用 hdiutil info -plist 获取挂载信息
      const infoXml = require('child_process').execSync('hdiutil info -plist', { encoding: 'utf8' });
      
      // 简单的解析逻辑 (不引入 xml2js 依赖)
      // 寻找 volumePath 附近出现的 image-path
      // 注意：这里是一个简化的解析，可能不够健壮，但在这个受控场景下通常有效
      
      // 1. 找到包含 volumePath 的 dict 块
      const volumeIndex = infoXml.indexOf(volumePath);
      if (volumeIndex !== -1) {
        // 截取相关片段，向前寻找 image-path
        // 这比较 hacky，但 hdiutil 的输出结构相对固定
        // 更好的方式是解析 plist，但为了减少依赖，我们尝试直接匹配
        
        // 尝试直接从系统挂载信息中找
        // 另一种方法：既然我们知道用户通常是从 tar 包解压的
        // 那么 DMG 文件旁边应该有 "项目文件" 文件夹
        
        // 让我们换个思路：直接解析 hdiutil info 的输出
        // hdiutil info 输出包含 image-path 和 mount-point
        
        const lines = require('child_process').execSync('hdiutil info', { encoding: 'utf8' }).split('\n');
        let dmgImagePath = '';
        
        // 找到包含 volumePath 的行的索引
        let volumeLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(volumePath)) {
            volumeLineIndex = i;
            break;
          }
        }
        
        // 从 volumePath 行向上查找最近的 image-path
        if (volumeLineIndex !== -1) {
          for (let i = volumeLineIndex; i >= 0; i--) {
            if (lines[i].startsWith('image-path')) {
              dmgImagePath = lines[i].split(': ')[1].trim();
              break;
            }
          }
        }
        
        if (dmgImagePath) {
          console.log('✅ 找到 DMG 源文件路径:', dmgImagePath);
          // DMG 文件所在的目录
          const dmgDir = path.dirname(dmgImagePath);
          const projectFilesFromDmg = path.join(dmgDir, '项目文件');
          const packageJsonFromDmg = path.join(projectFilesFromDmg, 'package.json');
          
          if (fs.existsSync(packageJsonFromDmg)) {
            console.log('✅ 通过 DMG 源路径找到 package.json:', packageJsonFromDmg);
            return projectFilesFromDmg;
          }
        }
      }
    } catch (e) {
      console.error('反向查找 DMG 路径失败:', e);
    }
  }
  
  console.error('❌ 无法找到 package.json');
  // 最后的退路：不要返回 userPackageRoot，因为这可能是只读的 Volume 根目录
  // 直接返回 null，让前端提示用户手动选择
  return null;
});

// 手动选择项目根目录
ipcMain.handle('select-project-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 ScreenSync-UserPackage 文件夹',
    properties: ['openDirectory'],
    message: '请选择解压后的 ScreenSync-UserPackage 文件夹，或者其中的"项目文件"文件夹'
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
  
  // 检查 2: 是 UserPackage 根目录（包含 "项目文件/package.json"）
  const projectFilesPath = path.join(selectedPath, '项目文件');
  if (fs.existsSync(path.join(projectFilesPath, 'package.json'))) {
    console.log('✅ 手动选择的是 UserPackage，自动定位到项目文件:', projectFilesPath);
    return { success: true, path: projectFilesPath };
  }

  return { 
    success: false, 
    error: '选择的文件夹不正确。\n\n请选择包含 "package.json" 的文件夹，或者解压后的 "ScreenSync-UserPackage" 文件夹。' 
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

ipcMain.handle('check-homebrew', async () => {
  return new Promise((resolve) => {
    const brewPath = findExecutable('brew');
    console.log('Check Homebrew:', brewPath);
    resolve({ installed: !!brewPath });
  });
});

ipcMain.handle('check-node', async () => {
  return new Promise((resolve) => {
    const nodePath = findExecutable('node');
    
    if (nodePath) {
      exec('node -v', (error, version) => {
        resolve({ 
          installed: true, 
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
    const convertPath = findExecutable('convert');
    
    if (convertPath) {
      exec('convert -version', (error, output) => {
        if (!error && output.includes('ImageMagick')) {
          // 提取版本号
          const versionMatch = output.match(/Version: ImageMagick ([\d.]+)/);
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

function getLegacyNodeUrl() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `https://nodejs.org/dist/v${LEGACY_NODE_VERSION}/node-v${LEGACY_NODE_VERSION}-darwin-${arch}.tar.gz`;
}

// Download file via curl, report progress
function downloadFile(url, destPath, sendLog) {
  return new Promise((resolve, reject) => {
    sendLog(`   下载: ${url}\n`);
    const child = spawn('curl', ['-L', '-o', destPath, '--progress-bar', '-f', '--connect-timeout', '30', url], {
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
  sendProgress('node', 'installing', '正在下载 Node.js...');
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
  sendProgress('ffmpeg', 'installing', '正在下载 FFmpeg...');
  sendLog('\n📦 正在安装 FFmpeg...\n');

  fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
  const tmpDir = path.join(os.tmpdir(), `screensync_ffmpeg_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // evermeet.cx provides Intel x64 static builds; on ARM they run via Rosetta 2
    const ffmpegZip = path.join(tmpDir, 'ffmpeg.zip');
    const ffprobeZip = path.join(tmpDir, 'ffprobe.zip');

    await downloadFile('https://evermeet.cx/ffmpeg/getrelease/zip', ffmpegZip, sendLog);
    await downloadFile('https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip', ffprobeZip, sendLog);

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
async function installLegacyImageMagick(sendProgress, sendLog) {
  sendProgress('imagemagick', 'installing', '正在安装 ImageMagick...');
  sendLog('\n📦 正在安装 ImageMagick...\n');

  fs.mkdirSync(LEGACY_BIN_DIR, { recursive: true });
  const imDir = path.join(LEGACY_DEPS_DIR, 'imagemagick');
  const tmpDir = path.join(os.tmpdir(), `screensync_im_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Strategy 1: Download standalone macOS build from mendelson.org (universal binary, notarized)
    const dmgPath = path.join(tmpDir, 'ImageMagick.dmg');
    const mountPoint = path.join(tmpDir, 'im_mount');
    let installed = false;

    sendLog('   尝试下载 ImageMagick macOS 独立版...\n');
    try {
      await downloadFile('https://mendelson.org/imagemagick.dmg', dmgPath, sendLog);

      sendLog('   正在挂载 DMG...\n');
      fs.mkdirSync(mountPoint, { recursive: true });
      await execPromise(`hdiutil attach "${dmgPath}" -nobrowse -readonly -mountpoint "${mountPoint}"`, { timeout: 30000 });

      // Find the .app inside the DMG
      const dmgContents = fs.readdirSync(mountPoint);
      const appName = dmgContents.find(f => f.endsWith('.app') && f.toLowerCase().includes('magick'));

      if (appName) {
        // Copy entire app bundle to deps directory
        if (fs.existsSync(imDir)) fs.rmSync(imDir, { recursive: true, force: true });
        fs.mkdirSync(imDir, { recursive: true });
        const appDest = path.join(imDir, appName);
        await execPromise(`cp -R "${path.join(mountPoint, appName)}" "${appDest}"`);

        // Create wrapper scripts that invoke the binary inside the app bundle
        const magickBin = path.join(appDest, 'Contents', 'MacOS', 'magick');
        if (fs.existsSync(magickBin)) {
          for (const cmd of ['magick', 'convert']) {
            const wrapperPath = path.join(LEGACY_BIN_DIR, cmd);
            fs.writeFileSync(wrapperPath, `#!/bin/bash\nexec "${magickBin}" ${cmd === 'convert' ? 'convert' : ''} "$@"\n`, { mode: 0o755 });
          }
          installed = true;
        }
      }

      // Unmount
      try { await execPromise(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch (e) {}
    } catch (e) {
      sendLog(`   ⚠️ 独立版下载失败: ${e.message}\n`);
      try { await execPromise(`hdiutil detach "${mountPoint}" -force`, { timeout: 10000 }); } catch (e2) {}
    }

    // Strategy 2: Compile from source if Xcode CLT is available
    if (!installed) {
      sendLog('   尝试从源码编译 ImageMagick...\n');
      try {
        await execPromise('xcode-select -p', { timeout: 5000 });
        sendProgress('imagemagick', 'installing', '正在编译 ImageMagick（需要几分钟）...');

        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        if (fs.existsSync(imDir)) fs.rmSync(imDir, { recursive: true, force: true });
        fs.mkdirSync(imDir, { recursive: true });

        await execPromise(`curl -L "https://imagemagick.org/archive/ImageMagick.tar.gz" | tar xz -C "${srcDir}" --strip-components=1`, { timeout: 300000 });
        const ncpu = os.cpus().length;
        await execPromise(`cd "${srcDir}" && ./configure --prefix="${imDir}" --disable-docs --without-modules --without-perl --disable-openmp --with-quantum-depth=16 CFLAGS="-O2" 2>&1`, { timeout: 120000 });
        await execPromise(`cd "${srcDir}" && make -j${ncpu} 2>&1`, { timeout: 600000 });
        await execPromise(`cd "${srcDir}" && make install 2>&1`, { timeout: 60000 });

        const compiledMagick = path.join(imDir, 'bin', 'magick');
        if (fs.existsSync(compiledMagick)) {
          for (const cmd of ['magick', 'convert']) {
            const dest = path.join(LEGACY_BIN_DIR, cmd);
            try { fs.unlinkSync(dest); } catch (e) {}
            fs.symlinkSync(compiledMagick, dest);
          }
          installed = true;
        }
      } catch (e) {
        sendLog(`   ⚠️ 源码编译失败: ${e.message}\n`);
        if (!installed) {
          sendLog('   💡 请手动安装: 访问 https://imagemagick.org 下载 macOS 版本\n');
          sendLog('      或安装 Xcode Command Line Tools 后重试: xcode-select --install\n');
        }
      }
    }

    if (installed) {
      try {
        const { stdout } = await execPromise(`"${path.join(LEGACY_BIN_DIR, 'magick')}" --version`);
        const ver = stdout.split('\n')[0];
        sendLog(`   ✅ ${ver}\n`);
      } catch (e) {
        sendLog('   ✅ ImageMagick 已安装\n');
      }
      sendProgress('imagemagick', 'done', '安装完成');
    } else {
      sendProgress('imagemagick', 'error', '安装失败（可手动安装）');
      throw new Error('ImageMagick 安装失败。请手动安装后重试。');
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---- Legacy Gifsicle ----
async function installLegacyGifsicle(sendProgress, sendLog) {
  sendProgress('gifsicle', 'installing', '正在安装 Gifsicle...');
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
async function installLegacyDeps(event, dependencyStatus) {
  console.log('📦 Legacy macOS: 使用直接下载方式安装依赖');

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

  try {
    if (!dependencyStatus.node) await installLegacyNode(sendProgress, sendLog);
    if (!dependencyStatus.ffmpeg) await installLegacyFFmpeg(sendProgress, sendLog);
    if (!dependencyStatus.imagemagick) await installLegacyImageMagick(sendProgress, sendLog);
    if (!dependencyStatus.gifsicle) await installLegacyGifsicle(sendProgress, sendLog);

    // Inject into current process PATH
    if (!process.env.PATH.includes(LEGACY_BIN_DIR)) {
      process.env.PATH = `${LEGACY_BIN_DIR}:${process.env.PATH}`;
    }
    const legacyNodeBin = path.join(LEGACY_DEPS_DIR, 'node', 'bin');
    if (fs.existsSync(legacyNodeBin) && !process.env.PATH.includes(legacyNodeBin)) {
      process.env.PATH = `${legacyNodeBin}:${process.env.PATH}`;
    }

    return { success: true, message: '所有依赖安装完成' };
  } catch (error) {
    sendLog(`\n❌ ${error.message}\n`);
    return { success: false, error: error.message };
  }
}

// In-app dependency installation (no Terminal.app needed)
ipcMain.handle('install-all-dependencies', async (event, dependencyStatus) => {
  // Detect macOS version — use legacy direct-download mode for macOS 13 and below
  const darwinVersion = parseInt(os.release().split('.')[0], 10);
  const isLegacyMacOS = darwinVersion < 23; // Darwin 23 = macOS 14

  if (isLegacyMacOS) {
    return await installLegacyDeps(event, dependencyStatus);
  }
  console.log('📦 开始应用内安装依赖，当前状态:', dependencyStatus);

  const needsHomebrew = !dependencyStatus.homebrew;
  const brewPackages = [];
  if (!dependencyStatus.node) brewPackages.push('node');
  if (!dependencyStatus.imagemagick) brewPackages.push('imagemagick');
  if (!dependencyStatus.ffmpeg) brewPackages.push('ffmpeg');
  if (!dependencyStatus.gifsicle) brewPackages.push('gifsicle');
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

  try {
    // ===== Phase 1: Install Homebrew =====
    if (needsHomebrew) {
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

      sendProgress('homebrew', 'installing', '正在安装 Homebrew...');
      sendLog('📦 正在安装 Homebrew...\n');

      const isAppleSilicon = process.arch === 'arm64';
      const brewBin = isAppleSilicon ? '/opt/homebrew/bin' : '/usr/local/bin';
      const escapedPass = escapeForBash(password);

      // Build the install script:
      // 1. Pre-authenticate sudo via password pipe (credentials cached for this PTY session)
      // 2. Run Homebrew installer non-interactively
      // 3. Configure PATH for Apple Silicon
      const brewScript = [
        `echo '${escapedPass}' | sudo -S -v 2>/dev/null`,
        `if [ $? -ne 0 ]; then echo "SUDO_AUTH_FAILED"; exit 1; fi`,
        `echo "✅ 密码验证成功"`,
        `export NONINTERACTIVE=1`,
        `export CI=1`,
        `echo "📦 正在下载并安装 Homebrew（可能需要几分钟）..."`,
        `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`,
        `BREW_EXIT=$?`,
        `sudo -k 2>/dev/null || true`,
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
        // Use 'script' utility to create a PTY — required for sudo tty_tickets
        const child = spawn('script', ['-q', '/dev/null', '/bin/bash', '-c', brewScript], {
          env: { ...process.env, NONINTERACTIVE: '1', CI: '1' }
        });

        const timeout = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch (e) {}
          reject(new Error('Homebrew 安装超时（15分钟）'));
        }, 15 * 60 * 1000);

        let sudoFailed = false;

        child.stdout.on('data', (data) => {
          const text = cleanPtyOutput(data.toString());
          if (text.includes('SUDO_AUTH_FAILED')) {
            sudoFailed = true;
            sendProgress('homebrew', 'error', '密码错误');
          }
          if (text.trim()) sendLog(text);
        });

        child.stderr.on('data', (data) => {
          const text = cleanPtyOutput(data.toString());
          if (text.trim()) sendLog(text);
        });

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (sudoFailed) {
            reject(new Error('密码验证失败，请重试'));
          } else if (code === 0) {
            sendProgress('homebrew', 'done', '安装完成');
            sendLog('\n✅ Homebrew 安装完成\n');
            // Update PATH so findExecutable works for subsequent brew calls
            if (fs.existsSync(path.join(brewBin, 'brew'))) {
              process.env.PATH = `${brewBin}:${process.env.PATH}`;
            }
            resolve();
          } else {
            sendProgress('homebrew', 'error', '安装失败');
            reject(new Error(`Homebrew 安装失败 (exit code: ${code})`));
          }
        });

        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
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
        const name = displayNames[pkg] || pkg;
        sendProgress(pkg, 'installing', `正在安装 ${name}...`);
        sendLog(`\n📦 正在安装 ${name}...\n`);

        await new Promise((resolve, reject) => {
          const child = spawn(brewPath, ['install', pkg], {
            env: process.env
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
    return { success: false, error: error.message };
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
          message: '正在下载依赖包' 
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

    const nodePath = findExecutable('node')
      || (process.arch === 'arm64' ? '/opt/homebrew/bin/node' : '/usr/local/bin/node');
    
    const startScript = path.join(installPath, 'start.js');
    
    if (!fs.existsSync(startScript)) {
      resolve({ success: false, error: '未找到 start.js 文件' });
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
      // 使用 findExecutable 找到正确的 node 路径，确保与 install-dependencies 阶段使用的环境一致
      // 避免出现"依赖是用 Node A 安装的，但 LaunchAgent 用 Node B 启动"导致的原生模块(sharp)崩溃
      let nodePath = findExecutable('node');
      
      // 如果 findExecutable 失败，尝试回退路径（按优先级）
      if (!nodePath) {
        console.warn('⚠️  findExecutable("node") 返回 null，尝试回退路径...');
        
        const fallbackPaths = [
          path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'node'),
          '/usr/local/bin/node',
          '/opt/homebrew/bin/node',
          'node'
        ];
        
        for (const fallback of fallbackPaths) {
          if (fallback === 'node' || fs.existsSync(fallback)) {
            nodePath = fallback;
            console.log(`   使用回退路径: ${nodePath}`);
            break;
          }
        }
      }
      
      if (!nodePath) {
        throw new Error('无法找到 Node.js 可执行文件。请确保 Node.js 已正确安装。');
      }
      
      console.log('🚀 配置自启动，使用 Node 路径:', nodePath);
      
      const homeDir = require('os').homedir();
      const launchAgentsDir = path.join(homeDir, 'Library', 'LaunchAgents');
      const plistName = 'com.screensync.server.plist';
      const plistPath = path.join(launchAgentsDir, plistName);
      const templatePath = path.join(installPath, plistName);
      
      // 确保 LaunchAgents 目录存在
      if (!fs.existsSync(launchAgentsDir)) {
        fs.mkdirSync(launchAgentsDir, { recursive: true });
      }
      
      // 读取模板文件
      let plistContent = fs.readFileSync(templatePath, 'utf8');
      
      // 构建包含所有可能 Node.js 路径的 PATH
      const comprehensivePath = [
        path.join(os.homedir(), '.screensync', 'bin'),          // ScreenSync 本地安装 (legacy macOS)
        path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin'), // 本地 Node.js
        '/usr/local/bin',           // 官网安装
        '/opt/homebrew/bin',        // Homebrew Apple Silicon
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        path.join(os.homedir(), '.nvm/versions/node/*/bin')  // NVM (glob pattern)
      ].join(':');
      
      // 替换占位符
      plistContent = plistContent
        .replace(/__NODE_PATH__/g, nodePath)
        .replace(/__INSTALL_PATH__/g, installPath)
        // 也更新 PATH 环境变量，确保包含所有可能的位置
        .replace(/\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/g, comprehensivePath);
      
      console.log('📝 LaunchAgent PATH:', comprehensivePath);
      
      // 写入到 LaunchAgents 目录
      fs.writeFileSync(plistPath, plistContent, 'utf8');
      
      // 卸载旧的服务（忽略错误）
      exec(`launchctl unload "${plistPath}" 2>/dev/null`, () => {
        // 等待 1 秒确保卸载完成
        setTimeout(() => {
          // 加载新服务（RunAtLoad 为 true，会自动启动）
        exec(`launchctl load "${plistPath}"`, (loadError, stdout, stderr) => {
            // 检查是否加载成功
          if (loadError && !stderr.includes('already loaded')) {
              console.error('❌ Launchctl load 失败:', loadError.message);
              console.error('   stderr:', stderr);
              resolve({ 
                success: false, 
                error: `配置自动启动失败\n${stderr || loadError.message}` 
              });
              return;
            }
            
            console.log('✅ LaunchAgent 已加载');
            console.log('   正在验证服务是否成功启动...');
            
            // 等待 5 秒后验证服务是否真的在运行
            setTimeout(async () => {
              const isRunning = await checkPort(8888);
              if (isRunning) {
                console.log('✅ 服务器运行验证成功');
                console.log('   服务已配置为开机自动启动');
                  resolve({ 
                  success: true, 
                  message: '服务器已配置为开机自动启动' 
                  });
                } else {
                console.warn('⚠️  LaunchAgent 已配置，但服务未运行');
                console.warn('   开机后将自动启动');
                  resolve({ 
                    success: true, 
                  message: '服务器已配置为开机自动启动（当前未运行，开机后自动启动）' 
                  });
                }
            }, 5000);
          });
        }, 1000);
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

