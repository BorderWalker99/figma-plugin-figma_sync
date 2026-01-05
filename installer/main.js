const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

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
        let currentImagePath = '';
        let foundMountPoint = false;
        
        for (const line of lines) {
          if (line.startsWith('image-path')) {
            currentImagePath = line.split(': ')[1].trim();
          }
          if (line.includes(volumePath)) {
            foundMountPoint = true;
            break;
          }
        }
        
        if (foundMountPoint && currentImagePath) {
          console.log('✅ 找到 DMG 源文件路径:', currentImagePath);
          // DMG 文件所在的目录
          const dmgDir = path.dirname(currentImagePath);
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
  // 1. 检查常见路径
  const commonPaths = [
    `/opt/homebrew/bin/${name}`, // Apple Silicon
    `/usr/local/bin/${name}`,    // Intel Mac
    path.join(os.homedir(), `.nvm/versions/node/${name}`) // NVM (简化检查)
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      // 如果找到了，把它的目录添加到 PATH 中，以便后续 exec 调用能找到
      const binDir = path.dirname(p);
      if (!process.env.PATH.includes(binDir)) {
        console.log(`Adding ${binDir} to PATH`);
        process.env.PATH = `${binDir}:${process.env.PATH}`;
      }
      return p;
    }
  }

  // 2. 尝试 'which'
  try {
    const output = require('child_process').execSync(`which ${name}`, { encoding: 'utf8' }).trim();
    if (output) return output;
  } catch (e) {}

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
    const tempScriptPath = path.join(os.tmpdir(), `temp_script_${Date.now()}.scpt`);
    fs.writeFileSync(tempScriptPath, script, 'utf8');

    // 隐藏 stderr 以避免 Electron 显示不必要的报错弹窗（除非真的是执行错误）
    exec(`osascript "${tempScriptPath}" 2>/dev/null`, (error, stdout, stderr) => {
      // 清理临时文件
      try { fs.unlinkSync(tempScriptPath); } catch (e) {}

      if (error) {
        // 只有当 error 存在且不是用户取消时才 reject
        if (!error.message.includes('User canceled')) {
          console.error('AppleScript error:', error);
        reject(error);
        } else {
           // 用户取消当作成功但不执行
           resolve('User canceled');
        }
      } else {
        resolve(stdout);
      }
    });
  });
}

ipcMain.handle('install-homebrew', async () => {
  return new Promise(async (resolve) => {
    // Homebrew 官方安装命令 (注意：双引号需要转义用于 AppleScript)
    // 原始命令: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    const installCommand = '/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\"';
    
    const appleScript = `
      tell application "Terminal"
        activate
        do script "${installCommand}"
      end tell
    `;
    
    console.log('Opening Terminal to install Homebrew...');
    
    try {
      await runAppleScript(appleScript);
      console.log('Terminal opened successfully');
      resolve({ 
        success: true, 
        message: '终端已打开，请按照提示安装 Homebrew：1. 输入密码；2. 按回车继续；3. 等待安装完成；完成后请点击"重新检测"按钮。',
        needsRestart: true
      });
    } catch (error) {
      console.error('Failed to run AppleScript:', error);
      const rawCommand = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
      resolve({ 
        success: false, 
        error: `无法打开终端: ${error.message}\n\n请手动在终端中运行以下命令:\n${rawCommand}`,
        manualCommand: rawCommand
      });
    }
  });
});

ipcMain.handle('install-node', async () => {
  return new Promise(async (resolve) => {
    const installCommand = 'brew install node';
    const appleScript = `
      tell application "Terminal"
        activate
        do script "${installCommand}"
      end tell
    `;
    
    console.log('Opening Terminal to install Node.js...');
    
    try {
      await runAppleScript(appleScript);
      console.log('Terminal opened successfully');
      resolve({ 
        success: true, 
        message: '终端已打开，正在安装 Node.js。通常需要 2-3 分钟。完成后请点击"重新检测"按钮。',
        needsRestart: true
      });
    } catch (error) {
      console.error('Failed to run AppleScript:', error);
      resolve({ 
        success: false, 
        error: `无法打开终端: ${error.message}\n\n请手动在终端中运行:\nbrew install node`
      });
    }
  });
});

ipcMain.handle('install-imagemagick', async () => {
  return new Promise(async (resolve) => {
    const installCommand = 'brew install imagemagick';
    const appleScript = `
      tell application "Terminal"
        activate
        do script "${installCommand}"
      end tell
    `;
    
    console.log('Opening Terminal to install ImageMagick...');
    
    try {
      await runAppleScript(appleScript);
      console.log('Terminal opened successfully');
      resolve({ 
        success: true, 
        message: '终端已打开，正在安装 ImageMagick。通常需要 2-3 分钟。完成后请点击"重新检测"按钮。',
        needsRestart: true
      });
    } catch (error) {
      console.error('Failed to run AppleScript:', error);
      resolve({ 
        success: false, 
        error: `无法打开终端: ${error.message}\n\n请手动在终端中运行:\nbrew install imagemagick`
      });
    }
  });
});

ipcMain.handle('install-ffmpeg', async () => {
  return new Promise(async (resolve) => {
    const installCommand = 'brew install ffmpeg';
    const appleScript = `
      tell application "Terminal"
        activate
        do script "${installCommand}"
      end tell
    `;
    
    console.log('Opening Terminal to install FFmpeg...');
    
    try {
      await runAppleScript(appleScript);
      console.log('Terminal opened successfully');
      resolve({ 
        success: true, 
        message: '终端已打开，正在安装 FFmpeg。通常需要 2-3 分钟。完成后请点击"重新检测"按钮。',
        needsRestart: true
      });
    } catch (error) {
      console.error('Failed to run AppleScript:', error);
      resolve({ 
        success: false, 
        error: `无法打开终端: ${error.message}\n\n请手动在终端中运行:\nbrew install ffmpeg`
      });
    }
  });
});

// 一键安装所有缺失的依赖
ipcMain.handle('install-all-dependencies', async (event, dependencyStatus) => {
  return new Promise(async (resolve) => {
    console.log('📦 一键安装所有依赖，当前状态:', dependencyStatus);
    
    const commandsToRun = [];
    
    // 根据状态构建安装命令
    if (!dependencyStatus.homebrew) {
      // Homebrew 需要特殊处理，使用官方安装脚本
      commandsToRun.push('/bin/bash -c \\"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\"');
    }
    
    // 构建 brew install 命令（将所有缺失的包合并到一条命令）
    const brewPackages = [];
    if (!dependencyStatus.node) {
      brewPackages.push('node');
    }
    if (!dependencyStatus.imagemagick) {
      brewPackages.push('imagemagick');
    }
    if (!dependencyStatus.ffmpeg) {
      brewPackages.push('ffmpeg');
    }
    
    if (brewPackages.length > 0) {
      // 如果 Homebrew 需要安装，添加 && 连接符
      if (commandsToRun.length > 0) {
        commandsToRun.push('&&');
      }
      commandsToRun.push(`brew install ${brewPackages.join(' ')}`);
    }
    
    if (commandsToRun.length === 0) {
      resolve({ 
        success: false, 
        error: '所有依赖已安装，无需重复安装'
      });
      return;
    }
    
    // 合并所有命令为一条终端指令
    const finalCommand = commandsToRun.join(' ');
    
    const appleScript = `
      tell application "Terminal"
        activate
        do script "${finalCommand}"
      end tell
    `;
    
    console.log('Opening Terminal with unified install command:', finalCommand);
    
    try {
      await runAppleScript(appleScript);
      console.log('Terminal opened successfully for unified installation');
      resolve({ 
        success: true, 
        message: '终端已打开，正在安装所有缺失依赖。只需输入一次密码即可。安装完成后请点击"重新检测"按钮。',
        needsRestart: true
      });
    } catch (error) {
      console.error('Failed to run AppleScript:', error);
      resolve({ 
        success: false, 
        error: `无法打开终端: ${error.message}\n\n请手动在终端中运行:\n${finalCommand.replace(/\\"/g, '"')}`
      });
    }
  });
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
    
    // 查找 npm 路径
    const npmPath = findExecutable('npm') || 
      (process.platform === 'darwin' 
        ? (process.arch === 'arm64' ? '/opt/homebrew/bin/npm' : '/usr/local/bin/npm')
        : 'npm');
    
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
    const commandStr = `"${npmPath}" install --legacy-peer-deps --registry=https://registry.npmmirror.com --prefix "${installPath}"`;
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

    const nodePath = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? '/opt/homebrew/bin/node' : '/usr/local/bin/node')
      : 'node';
    
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
      const nodePath = findExecutable('node') || 
        (process.platform === 'darwin' 
        ? (process.arch === 'arm64' ? '/opt/homebrew/bin/node' : '/usr/local/bin/node')
          : 'node');
      
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
      
      // 替换占位符
      plistContent = plistContent
        .replace(/__NODE_PATH__/g, nodePath)
        .replace(/__INSTALL_PATH__/g, installPath);
      
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

