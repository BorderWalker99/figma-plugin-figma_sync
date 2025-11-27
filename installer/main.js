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
  // 获取应用资源路径
  let appPath = app.getAppPath();
  
  // 如果是打包后的应用（app.asar），需要特殊处理
  if (appPath.includes('.asar')) {
    // 在 asar 中，需要找到实际的资源目录
    appPath = appPath.replace(/\.asar.*$/, '');
  }
  
  // 如果安装器在 installer/ 子目录中，向上查找项目根目录
  // 检查当前目录是否有 package.json
  if (fs.existsSync(path.join(appPath, 'package.json'))) {
    return appPath;
  }
  
  // 检查父目录是否有 package.json（安装器在 installer/ 子目录中）
  const parentPath = path.dirname(appPath);
  if (fs.existsSync(path.join(parentPath, 'package.json'))) {
    return parentPath;
  }
  
  // 如果都没找到，尝试向上查找最多 3 层
  let currentPath = appPath;
  for (let i = 0; i < 3; i++) {
    currentPath = path.dirname(currentPath);
    if (fs.existsSync(path.join(currentPath, 'package.json'))) {
      return currentPath;
    }
  }
  
  // 如果还是找不到，返回父目录（用户解压的位置）
  // 这通常发生在用户从解压后的目录运行安装器时
  return parentPath;
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
    const npmPath = process.platform === 'darwin' 
      ? (process.arch === 'arm64' ? '/opt/homebrew/bin/npm' : '/usr/local/bin/npm')
      : 'npm';
    
    const child = spawn(npmPath, ['install'], {
      cwd: installPath,
      stdio: 'pipe',
      shell: true
    });
    
    let output = '';
    let errorOutput = '';
    
    child.stdout.on('data', (data) => {
      output += data.toString();
      event.sender.send('install-output', { type: 'stdout', data: data.toString() });
    });
    
    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
      event.sender.send('install-output', { type: 'stderr', data: data.toString() });
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: errorOutput || `退出码: ${code}` });
      }
    });
    
    child.on('error', (error) => {
      resolve({ success: false, error: error.message });
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
          exec(`launchctl start com.screensync.server`, (startError) => {
             // 无论启动是否成功（可能已经在运行），只要 plist 写入成功就算配置完成
             // 返回 success: true 以便安装器能正常结束
             resolve({ 
               success: true, 
               message: '服务器已配置为开机自动启动' 
             });
          });
        });
      });
      
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
});

