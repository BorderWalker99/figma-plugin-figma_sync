const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// 允许在渲染进程中使用 remote
if (process.platform === 'darwin') {
  app.allowRendererProcessReuse = false;
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
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
  const fallbackPaths = [
    appPath,
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
  
  console.error('❌ 无法找到 package.json');
  // 最后的退路：返回 UserPackage 根目录（即使没有验证）
  return userPackageRoot;
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

    exec(`osascript "${tempScriptPath}"`, (error, stdout, stderr) => {
      // 清理临时文件
      try { fs.unlinkSync(tempScriptPath); } catch (e) {}

      if (error) {
        reject(error);
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
        message: '终端已打开，请按照提示完成 Homebrew 安装。\n\n安装步骤：\n1. 按 RETURN 继续\n2. 输入密码\n3. 等待安装完成\n\n完成后请点击"重新检测"按钮。',
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
        message: '终端已打开，正在安装 Node.js。\n\n通常需要 2-3 分钟。\n完成后请点击"重新检测"按钮。',
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

ipcMain.handle('install-dependencies', async (event, installPath) => {
  return new Promise((resolve) => {
    console.log('📦 开始安装依赖...');
    console.log('📂 安装路径:', installPath);
    
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
    if (fs.existsSync(lockFilePath)) {
      try {
        fs.unlinkSync(lockFilePath);
        console.log('🗑️  已删除旧的 package-lock.json');
      } catch (err) {
        console.warn('⚠️  无法删除 package-lock.json:', err.message);
      }
    }
    
    // 查找 npm 路径
    const npmPath = findExecutable('npm') || 
      (process.platform === 'darwin' 
        ? (process.arch === 'arm64' ? '/opt/homebrew/bin/npm' : '/usr/local/bin/npm')
        : 'npm');
    
    console.log('📦 npm 路径:', npmPath);
    
    // 使用 --legacy-peer-deps 避免依赖冲突，并使用淘宝镜像加速
    const child = spawn(npmPath, ['install', '--legacy-peer-deps', '--no-audit', '--registry=https://registry.npmmirror.com', '--verbose'], {
      cwd: installPath,
      stdio: 'pipe',
      shell: true
    });
    
    let output = '';
    let errorOutput = '';
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.log('[npm stdout]', text);
      event.sender.send('install-output', { type: 'stdout', data: text });
    });
    
    child.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      console.log('[npm stderr]', text);
      event.sender.send('install-output', { type: 'stderr', data: text });
    });
    
    child.on('close', (code) => {
      console.log('📦 npm install 完成，退出码:', code);
      
      if (code === 0) {
        // 验证 node_modules 是否存在且包含关键依赖
        const nodeModulesPath = path.join(installPath, 'node_modules');
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
        
        console.log('✅ 依赖安装验证成功');
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
        localDownloadFolder: localFolder || path.join(installPath, 'ScreenSyncImg'),
        installPath: installPath,
        createdAt: new Date().toISOString()
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      fs.writeFileSync(syncModePath, syncMode, 'utf8');
      
      // 创建本地文件夹
      if (localFolder && !fs.existsSync(localFolder)) {
        fs.mkdirSync(localFolder, { recursive: true });
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
    
    // 等待几秒检查服务器是否正常启动
    setTimeout(async () => {
      // 检查进程是否还在运行
      try {
        process.kill(child.pid, 0); // 检查进程是否存在
        resolve({ success: true, pid: child.pid });
      } catch (error) {
        // 进程退出了，再次检查端口，也许是刚才启动成功了但脱离了子进程，或者被自动重启管理接管了
        const isRunningNow = await checkPort(8888);
        if (isRunningNow) {
           resolve({ success: true, message: '服务器已启动' });
        } else {
           resolve({ success: false, error: '服务器启动失败' });
        }
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
      const nodePath = process.platform === 'darwin'
        ? (process.arch === 'arm64' ? '/opt/homebrew/bin/node' : '/usr/local/bin/node')
        : 'node';
      
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
      exec(`launchctl unload "${plistPath}"`, () => {
        // 加载新服务
        exec(`launchctl load "${plistPath}"`, (loadError, stdout, stderr) => {
          // 即使有 stderr，如果服务已经加载也是正常的
          if (loadError && !stderr.includes('already loaded')) {
            console.error('Launchctl load error:', loadError, stderr);
            // 尝试继续启动，也许只是加载警告
          }
          
          // 立即启动服务
          exec(`launchctl start com.screensync.server`, (startError, startStdout, startStderr) => {
            if (startError) {
              console.error('⚠️  启动服务失败:', startError.message);
              console.error('   stdout:', startStdout);
              console.error('   stderr:', startStderr);
            }
            
            // 等待2秒后检查服务是否真的在运行
            setTimeout(() => {
              // 检查端口 8888 是否在监听
              exec(`lsof -i :8888 | grep LISTEN`, (checkError, checkStdout) => {
                if (checkError || !checkStdout) {
                  console.error('❌ 服务器启动验证失败');
                  console.error('   端口 8888 未监听');
                  
                  // 读取错误日志（如果存在）
                  const errorLogPath = path.join(installPath, 'server-error.log');
                  let errorDetails = '';
                  if (fs.existsSync(errorLogPath)) {
                    try {
                      const errorLog = fs.readFileSync(errorLogPath, 'utf8');
                      // 只取最后500字符
                      errorDetails = errorLog.slice(-500);
                    } catch (e) {
                      // 忽略
                    }
                  }
                  
                  resolve({ 
                    success: false, 
                    error: '服务器启动失败\n\n可能原因：\n1. 依赖未完全安装\n2. 端口被占用\n\n请查看安装目录下的 server-error.log 文件' + (errorDetails ? '\n\n最近的错误：\n' + errorDetails : '')
                  });
                } else {
                  console.log('✅ 服务器运行验证成功');
                  console.log('   端口 8888 正在监听');
                  resolve({ 
                    success: true, 
                    message: '服务器已配置为开机自动启动并已成功运行' 
                  });
                }
              });
            }, 2000);
          });
        });
      });
      
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
});

