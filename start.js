// start.js - 一键启动脚本
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { checkUpdateAsync } = require('./update-manager');

// Inject bundled runtime/local deps into PATH.
(() => {
  const prependPathOnce = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    const current = process.env.PATH || '';
    if (!current.split(':').includes(dir)) {
      process.env.PATH = current ? `${dir}:${current}` : dir;
    }
  };

  const archKey = process.arch === 'arm64' ? 'apple' : 'intel';
  const runtimeCandidates = [
    path.join(__dirname, 'runtime', 'bin'),
    path.join(__dirname, 'runtime', archKey, 'bin'),
    path.join(__dirname, 'runtime', process.arch, 'bin'),
    path.join(__dirname, 'runtime', 'node', 'bin'),
    path.join(__dirname, 'runtime', archKey, 'node', 'bin'),
    path.join(__dirname, 'runtime', process.arch, 'node', 'bin')
  ];

  // runtime 优先，确保胖包依赖被优先使用。
  for (const p of runtimeCandidates.reverse()) prependPathOnce(p);

  const localBin = path.join(os.homedir(), '.screensync', 'bin');
  const localNodeBin = path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin');
  const localImBin = path.join(os.homedir(), '.screensync', 'deps', 'imagemagick', 'bin');
  for (const p of [localBin, localNodeBin, localImBin].reverse()) prependPathOnce(p);

  if (!process.env.MAGICK_HOME) {
    const archKeyLocal = process.arch === 'arm64' ? 'apple' : 'intel';
    const candidates = [
      path.join(__dirname, 'runtime', archKeyLocal),
      path.join(__dirname, 'runtime', 'imagemagick'),
      path.join(os.homedir(), '.screensync', 'deps', 'imagemagick')
    ];
    for (const imHome of candidates) {
      if (fs.existsSync(path.join(imHome, 'bin', 'magick'))) {
        process.env.MAGICK_HOME = imHome;
        const imLib = path.join(imHome, 'lib');
        if (fs.existsSync(imLib)) {
          process.env.DYLD_LIBRARY_PATH = imLib + (process.env.DYLD_LIBRARY_PATH ? ':' + process.env.DYLD_LIBRARY_PATH : '');
        }
        const coderDir = path.join(imHome, 'lib', 'ImageMagick', 'modules-Q16HDRI', 'coders');
        if (fs.existsSync(coderDir)) {
          process.env.MAGICK_CODER_MODULE_PATH = coderDir;
        }
        const filterDir = path.join(imHome, 'lib', 'ImageMagick', 'modules-Q16HDRI', 'filters');
        if (fs.existsSync(filterDir)) {
          process.env.MAGICK_FILTER_MODULE_PATH = filterDir;
        }
        const etcDir = path.join(imHome, 'etc', 'ImageMagick-7');
        const cfgDir = path.join(imHome, 'lib', 'ImageMagick', 'config-Q16HDRI');
        const cfgParts = [etcDir, cfgDir].filter(d => fs.existsSync(d));
        if (cfgParts.length) {
          process.env.MAGICK_CONFIGURE_PATH = cfgParts.join(':');
        }
        break;
      }
    }
  }
})();

const LOCK_DIR = path.join(os.tmpdir(), 'screensync-locks');
const START_LOCK_FILE = path.join(
  LOCK_DIR,
  `start-${crypto.createHash('md5').update(__dirname).digest('hex')}.lock`
);
let startLockAcquired = false;

function getProcessCommand(pid) {
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 3000 }).trim();
  } catch (_) {
    return '';
  }
}

function getProcessCwd(pid) {
  try {
    const output = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: 'utf8', timeout: 3000 });
    const line = output.split('\n').find(entry => entry.startsWith('n'));
    return line ? line.slice(1).trim() : '';
  } catch (_) {
    return '';
  }
}

function isRepoScriptProcess(pid, scriptName, command) {
  const cmd = command || getProcessCommand(pid);
  if (!cmd) return false;
  if (cmd.includes(path.join(__dirname, scriptName))) return true;
  if (!new RegExp(`(^|\\s|/)${scriptName}(\\s|$)`).test(cmd)) return false;
  return getProcessCwd(pid) === __dirname;
}

function isMatchingProcessAlive(pid, scriptName) {
  if (!pid || !Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }
  return isRepoScriptProcess(pid, scriptName);
}

function releaseStartLock() {
  if (!startLockAcquired) return;
  try {
    const raw = fs.readFileSync(START_LOCK_FILE, 'utf8');
    const lockInfo = JSON.parse(raw);
    if (lockInfo && lockInfo.pid === process.pid) {
      fs.rmSync(START_LOCK_FILE, { force: true });
    }
  } catch (_) {}
  startLockAcquired = false;
}

function acquireStartLockOrExit() {
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  } catch (_) {}

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(START_LOCK_FILE, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        script: path.join(__dirname, 'start.js'),
        createdAt: Date.now()
      }));
      fs.closeSync(fd);
      startLockAcquired = true;
      process.on('exit', releaseStartLock);
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') break;
      try {
        const raw = fs.readFileSync(START_LOCK_FILE, 'utf8');
        const lockInfo = JSON.parse(raw);
        if (isMatchingProcessAlive(Number(lockInfo && lockInfo.pid), 'start.js')) {
          console.log(`🛑 检测到同目录已有运行中的启动器 (PID: ${lockInfo.pid})，当前进程退出以避免重复启动`);
          process.exit(0);
        }
      } catch (_) {}
      try { fs.rmSync(START_LOCK_FILE, { force: true }); } catch (_) {}
    }
  }
  return true;
}

function getRequiredNodeDeps() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {});
  } catch (_) {
    return ['dotenv', 'ws', 'express', 'googleapis', 'chokidar'];
  }
}

function hasRequiredNodeDeps(rootDir) {
  try {
    for (const dep of getRequiredNodeDeps()) {
      require.resolve(dep, { paths: [rootDir] });
    }
    return true;
  } catch (_) {
    return false;
  }
}

let chokidar;
try {
  chokidar = require('chokidar');
} catch (e) {
  // 忽略错误，将在环境检查中处理
}

// 检查并清理端口 8888
function cleanupPort() {
  if (process.platform === 'win32') {
    // Windows 平台清理逻辑 (可选)
    return;
  }
  
  try {
    // 查找占用 8888 端口的进程
    // 使用 lsof 查找 LISTEN 状态的端口
    const pid = execSync("lsof -i :8888 | grep LISTEN | awk '{print $2}'").toString().trim();
    
    if (pid) {
      console.log(`🧹 发现端口 8888 被占用 (PID: ${pid})，正在清理...`);
      
      // 处理可能有多个 PID 的情况
      const pids = pid.split('\n');
      for (const p of pids) {
        if (p) {
          try {
            process.kill(parseInt(p), 'SIGKILL');
            console.log(`   ✅ 已终止进程 ${p}`);
          } catch (e) {
            console.log(`   ⚠️  无法终止进程 ${p}: ${e.message}`);
          }
        }
      }
      
      // 等待端口释放
      execSync('sleep 1');
    }
  } catch (error) {
    // lsof 返回非 0 状态码表示没有找到进程，忽略
  }
}

// 检查并清理旧的 watcher 进程
function cleanupWatcherProcesses() {
  if (process.platform === 'win32') {
    return;
  }
  
  try {
    const output = execSync('ps -axo pid=,command=', { encoding: 'utf8', timeout: 3000 });
    const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
    const targetPids = [];

    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isFinite(pid) || pid === process.pid) continue;

      if (
        isRepoScriptProcess(pid, 'drive-watcher.js', command) ||
        isRepoScriptProcess(pid, 'icloud-watcher.js', command) ||
        isRepoScriptProcess(pid, 'aliyun-watcher.js', command)
      ) {
        targetPids.push(pid);
      }
    }

    if (targetPids.length > 0) {
      console.log(`🧹 发现旧的 watcher 进程，正在清理...`);
      for (const pid of targetPids) {
        try {
          process.kill(pid, 'SIGTERM'); // 使用 SIGTERM 让进程优雅退出
          console.log(`   ✅ 已终止旧 watcher 进程 PID: ${pid}`);
        } catch (e) {
          console.log(`   ⚠️  无法终止进程 ${pid}: ${e.message}`);
        }
      }
      
      // 等待进程退出
      execSync('sleep 1');
    }
  } catch (error) {
    // 忽略错误（通常表示没有找到旧进程）
  }
}

function cleanupLocalRepoProcesses() {
  if (process.platform === 'win32') {
    return;
  }

  try {
    const output = execSync('ps -axo pid=,command=', { encoding: 'utf8' });
    const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
    const targetPids = [];

    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isFinite(pid) || pid === process.pid) continue;
      if (
        !isRepoScriptProcess(pid, 'start.js', command) &&
        !isRepoScriptProcess(pid, 'server.js', command) &&
        !isRepoScriptProcess(pid, 'drive-watcher.js', command) &&
        !isRepoScriptProcess(pid, 'icloud-watcher.js', command) &&
        !isRepoScriptProcess(pid, 'aliyun-watcher.js', command)
      ) {
        continue;
      }
      targetPids.push(pid);
    }

    if (targetPids.length > 0) {
      console.log(`🧹 发现同目录旧服务进程，正在清理...`);
      for (const pid of targetPids) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`   ✅ 已终止旧进程 PID: ${pid}`);
        } catch (e) {
          console.log(`   ⚠️  无法终止进程 ${pid}: ${e.message}`);
        }
      }
      execSync('sleep 1');
    }
  } catch (_) {
    // 忽略错误（通常表示没有找到旧进程）
  }
}

// 从环境变量读取同步模式，默认 Google Drive
let SYNC_MODE = process.env.SYNC_MODE || 'drive';

// 同步模式配置文件路径
const SYNC_MODE_FILE = path.join(__dirname, '.sync-mode');

// 读取配置文件中的模式（如果存在）
function readSyncMode() {
  try {
    if (fs.existsSync(SYNC_MODE_FILE)) {
      const mode = fs.readFileSync(SYNC_MODE_FILE, 'utf8').trim();
      if (mode === 'drive' || mode === 'google' || mode === 'icloud' || mode === 'aliyun' || mode === 'oss') {
        return mode;
      }
    }
  } catch (error) {
    // 忽略错误
  }
  return SYNC_MODE;
}

function getExpectedWatcherScript(mode) {
  if (mode === 'icloud') return 'icloud-watcher.js';
  if (mode === 'aliyun' || mode === 'oss') return 'aliyun-watcher.js';
  return 'drive-watcher.js';
}

function hasHealthyExistingServiceStack(mode) {
  if (process.platform === 'win32') {
    return false;
  }

  const expectedWatcher = getExpectedWatcherScript(mode);
  let hasServer = false;
  let hasWatcher = false;

  try {
    const output = execSync('ps -axo pid=,command=', { encoding: 'utf8', timeout: 3000 });
    const lines = output.split('\n').map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isFinite(pid) || pid === process.pid) continue;

      if (isRepoScriptProcess(pid, 'server.js', command)) {
        hasServer = true;
      }
      if (isRepoScriptProcess(pid, expectedWatcher, command)) {
        hasWatcher = true;
      }

      if (hasServer && hasWatcher) {
        return true;
      }
    }
  } catch (_) {}

  return false;
}

// 写入配置文件
function writeSyncMode(mode) {
  try {
    fs.writeFileSync(SYNC_MODE_FILE, mode, 'utf8');
  } catch (error) {
    console.error('⚠️  写入同步模式配置失败:', error.message);
  }
}

// 初始化配置文件
SYNC_MODE = readSyncMode();
writeSyncMode(SYNC_MODE);

// 如果同目录服务已经健康运行，则直接退出，避免二次启动打断现有连接。
acquireStartLockOrExit();
if (hasHealthyExistingServiceStack(SYNC_MODE)) {
  console.log('🛑 检测到当前安装目录的服务已在运行，跳过重复启动');
  releaseStartLock();
  process.exit(0);
}
cleanupLocalRepoProcesses();
cleanupPort();
cleanupWatcherProcesses();

console.clear();
console.log('╔════════════════════════════════════════════╗');
console.log('║  iPhone截图自动同步Figma - 启动中...      ║');
console.log('╚════════════════════════════════════════════╝\n');

// 检查更新（异步，不阻塞启动）
checkUpdateAsync().catch(() => {
  // 静默失败
});

const services = [];
let watcher = null;
let server = null;
let serverRestartCount = 0;
const MAX_RESTART_BACKOFF_MS = 60000;
let startupContinued = false;
let modeCheckInterval = null;
let shuttingDown = false;
let serverFileWatcher = null;
const pendingTimeouts = new Set();

function scheduleTimeout(fn, delayMs) {
  const id = setTimeout(() => {
    pendingTimeouts.delete(id);
    if (shuttingDown) return;
    try { fn(); } catch (_) {}
  }, delayMs);
  pendingTimeouts.add(id);
  return id;
}

function clearPendingTimeouts() {
  for (const id of pendingTimeouts) {
    try { clearTimeout(id); } catch (_) {}
  }
  pendingTimeouts.clear();
}

function cleanupSyncModeFile() {
  try {
    if (fs.existsSync(SYNC_MODE_FILE)) {
      fs.unlinkSync(SYNC_MODE_FILE);
    }
  } catch (_) {}
}

function shutdown(reason = 'SIGINT') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n\n👋 正在停止所有服务... (${reason})`);
  clearPendingTimeouts();

  if (modeCheckInterval) {
    clearInterval(modeCheckInterval);
    modeCheckInterval = null;
  }
  if (serverFileWatcher) {
    try { serverFileWatcher.close(); } catch (_) {}
    serverFileWatcher = null;
  }

  try {
    services.forEach((s) => {
      if (!s) return;
      if (typeof s.kill === 'function') {
        try { s.kill(); } catch (_) {}
      } else if (typeof s.close === 'function') {
        try { s.close(); } catch (_) {}
      }
    });
  } catch (_) {}
  cleanupSyncModeFile();
  releaseStartLock();
  process.exit(0);
}

// 检查环境（只在启动时检查一次）
function checkEnvironment() {
  console.log('🔍 检查环境...');
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  const installProductionDeps = () => execSync('npm install --production', {
    cwd: __dirname,
    stdio: 'inherit',
    timeout: 300000
  });
  if (!fs.existsSync(nodeModulesPath) || !hasRequiredNodeDeps(__dirname)) {
    console.warn('⚠️  警告: 未找到 node_modules 文件夹');
    console.log('   🔧 正在尝试自动安装依赖...');
    
    try {
      // 尝试自动安装依赖
      installProductionDeps();
      
      console.log('✅ 依赖安装成功！');
      
      // 再次检查
      if (!fs.existsSync(nodeModulesPath)) {
        console.error('❌ 错误: 依赖安装后仍未找到 node_modules');
        return false;
      }
    } catch (error) {
      console.error('❌ 自动安装依赖失败:', error.message);
      console.error('   请手动运行: npm install');
    return false;
    }
  }

  // 检查关键依赖
  const requiredDeps = getRequiredNodeDeps();
  for (const dep of requiredDeps) {
    const depPath = path.join(nodeModulesPath, dep);
    if (!fs.existsSync(depPath)) {
      console.error(`❌ 错误: 缺少关键依赖 "${dep}"`);
      console.log('   🔧 正在尝试重新安装依赖...');
      
      try {
        installProductionDeps();
        
        // 再次检查
        if (!fs.existsSync(depPath)) {
          console.error(`❌ 重新安装后仍缺少 "${dep}"`);
          return false;
        }
        
        console.log(`✅ 依赖 "${dep}" 已安装`);
      } catch (error) {
        console.error(`❌ 安装依赖 "${dep}" 失败:`, error.message);
      return false;
      }
    }
  }

  console.log('✅ 环境检查通过');
  return true;
}

// 启动服务器（支持自动重启）
function startServer() {
  if (shuttingDown) return;
  console.log('🚀 启动WebSocket服务器...');
  
  // 增加 Node.js 内存限制到 4GB，以支持大文件（GIF/视频）处理
  const NODE_MEMORY_LIMIT = process.env.NODE_MEMORY_LIMIT || '4096';
  // 使用 process.execPath 确保使用与当前脚本相同的 node 解释器，避免 PATH 问题
  server = spawn(process.execPath, [`--max-old-space-size=${NODE_MEMORY_LIMIT}`, 'server.js'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env, SYNC_MODE }
  });
  
  // 监听服务器进程退出
  server.on('exit', (code, signal) => {
    // 从 services 数组中移除
    const index = services.indexOf(server);
    if (index > -1) {
      services.splice(index, 1);
    }
    
    if (code !== 0 && code !== null) {
      console.error(`\n❌ 服务器异常退出 (code: ${code})`);
      
      // 记录到错误日志文件
      try {
        const errorLogPath = path.join(__dirname, 'server-error.log');
        const errorMsg = `[${new Date().toISOString()}] 服务器异常退出 (code: ${code}, signal: ${signal})\n`;
        fs.appendFileSync(errorLogPath, errorMsg, 'utf8');
      } catch (e) {
        // 忽略日志写入错误
      }
      
      // 持续自动重启：指数退避，避免在登录项场景下“永久掉线”
      serverRestartCount++;
      const retryDelay = Math.min(MAX_RESTART_BACKOFF_MS, 3000 * Math.pow(2, Math.min(serverRestartCount - 1, 5)));
      console.log(`\n🔄 尝试自动重启服务器（第 ${serverRestartCount} 次，${Math.round(retryDelay / 1000)} 秒后）...`);
      scheduleTimeout(() => {
        cleanupPort(); // 防止端口被僵尸进程占用导致反复失败
        startServer();
      }, retryDelay);
    } else if (signal) {
      console.log(`\n⚠️  服务器被信号终止 (signal: ${signal})`);
      // 被信号终止通常是用户主动操作，不自动重启
    } else {
      // 正常退出 (code === 0)，重置重启计数
      serverRestartCount = 0;
    }
  });

  server.on('error', (error) => {
    console.error('\n❌ 无法启动服务器:', error.message);
    // 不立即退出，让 exit 事件处理重启逻辑
  });
  
  services.push(server);
}

// 初始环境检查（带重试机制）
let envCheckAttempts = 0;
const MAX_ENV_CHECK_ATTEMPTS = 3;

function checkEnvironmentWithRetry() {
  envCheckAttempts++;
  
  if (checkEnvironment()) {
    envCheckAttempts = 0;
    return true;
  }
  
  if (envCheckAttempts < MAX_ENV_CHECK_ATTEMPTS) {
    console.warn(`\n⚠️  环境检查失败（第 ${envCheckAttempts}/${MAX_ENV_CHECK_ATTEMPTS} 次）`);
    console.log(`   将在 10 秒后重试...\n`);
    
    scheduleTimeout(() => {
      if (!checkEnvironmentWithRetry()) {
        console.error('\n❌ 环境检查多次失败，保持后台重试...');
        console.error('   请检查依赖安装状态，服务将在 30 秒后再次尝试\n');
        scheduleTimeout(() => {
          if (checkEnvironmentWithRetry() && !startupContinued) {
            startupContinued = true;
            continueStartup();
          }
        }, 30000);
      } else {
        // 环境检查通过，继续启动
        if (!startupContinued) {
          startupContinued = true;
          continueStartup();
        }
      }
    }, 10000);
    
    return false; // 等待重试
  }
  
  console.error('\n❌ 环境检查失败，已达到最大重试次数');
  console.error('   将在后台继续重试，不退出进程\n');
  scheduleTimeout(() => {
    if (checkEnvironmentWithRetry() && !startupContinued) {
      startupContinued = true;
      continueStartup();
    }
  }, 30000);
  return false;
}

if (!checkEnvironmentWithRetry()) {
  // 正在重试，退出当前流程
  return;
}

startupContinued = true;

// 环境检查通过，继续启动
function continueStartup() {
  // 启动服务器
  startServer();

  // 监听 server.js 变化实现自动重启
  if (chokidar) {
    serverFileWatcher = chokidar.watch(path.join(__dirname, 'server.js'), {
      persistent: true,
      ignoreInitial: true
    });

    serverFileWatcher.on('change', (filePath) => {
      if (shuttingDown) return;
      console.log(`\n🔄 检测到服务器文件变化: ${path.basename(filePath)}`);
      console.log('   正在重启服务器...');
      
      if (server) {
        // 移除 exit 监听器，防止触发异常退出后的自动重启逻辑
        server.removeAllListeners('exit');
        
        // 从 services 中移除
        const index = services.indexOf(server);
        if (index > -1) {
          services.splice(index, 1);
        }

        try {
          server.kill();
        } catch (e) {
          console.error('   ⚠️ 停止旧服务器进程失败:', e.message);
        }
        server = null;
      }
      
      // 稍等一下再重启，确保文件写入完成和端口释放
      scheduleTimeout(() => {
        cleanupPort(); // 确保端口已清理
        startServer();
      }, 2000); // 增加等待时间到 2 秒
    });
    
    // 将 watcher 加入 services 以便清理
    // chokidar watcher 有 close 方法，这里简单处理，进程退出时不需要显式 kill watcher
  }
  
  // 延迟启动监听器，避免重复启动
  scheduleTimeout(() => {
    startWatcher();
    startModeCheck(); // 启动模式检查
    
    console.log('\n✅ 所有服务已启动！');
    console.log('\n📱 下一步：在Figma Desktop中运行插件');
    console.log('   Plugins → Development → Import plugin from manifest\n');
  }, 2000);
  
  // 优雅退出
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 启动监听器
function startWatcher() {
  if (shuttingDown) return;
  // 读取最新的模式
  const currentMode = readSyncMode();
  
  // 如果模式没有改变且 watcher 正在运行，不需要重启
  if (watcher && currentMode === SYNC_MODE) {
    return;
  }
  
  // 更新 SYNC_MODE
  SYNC_MODE = currentMode;
  
  // 如果已有 watcher，先停止
  if (watcher) {
    console.log(`\n🔄 检测到模式切换，正在重启监听器...`);
    watcher.kill();
    watcher = null;
  }
  
  // 启动新的 watcher
  if (SYNC_MODE === 'drive' || SYNC_MODE === 'google') {
    console.log('\n🚀 启动Google Drive监听器...');
    watcher = spawn(process.execPath, ['drive-watcher.js'], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, SYNC_MODE }
    });
    
    watcher.on('exit', (code) => {
      console.log(`\n⚠️  Google Drive监听器已退出 (code: ${code})`);
      watcher = null;
      
      // 检查模式是否改变
      const newMode = readSyncMode();
      if (newMode !== SYNC_MODE) {
        console.log(`🔄 检测到模式切换: ${SYNC_MODE} -> ${newMode}`);
        scheduleTimeout(() => {
          startWatcher();
        }, 1000);
      } else {
        // 即使模式没变，也尝试重启（可能是意外退出）
        console.log(`🔄 监听器意外退出，正在重启...`);
        scheduleTimeout(() => {
          startWatcher();
        }, 2000);
      }
    });
  } else if (SYNC_MODE === 'aliyun' || SYNC_MODE === 'oss') {
    console.log('\n🚀 启动阿里云监听器...');
    watcher = spawn(process.execPath, ['aliyun-watcher.js'], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, SYNC_MODE }
    });
    
    watcher.on('exit', (code) => {
      console.log(`\n⚠️  阿里云监听器已退出 (code: ${code})`);
      watcher = null;
      
      // 检查模式是否改变
      const newMode = readSyncMode();
      if (newMode !== SYNC_MODE) {
        console.log(`🔄 检测到模式切换: ${SYNC_MODE} -> ${newMode}`);
        scheduleTimeout(() => {
          startWatcher();
        }, 1000);
      } else {
        // 即使模式没变，也尝试重启（可能是意外退出）
        console.log(`🔄 监听器意外退出，正在重启...`);
        scheduleTimeout(() => {
          startWatcher();
        }, 2000);
      }
    });
  } else {
    console.log('\n🚀 启动iCloud监听器...');
    watcher = spawn(process.execPath, ['icloud-watcher.js'], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, SYNC_MODE }
    });
    
    watcher.on('exit', (code) => {
      console.log(`\n⚠️  iCloud监听器已退出 (code: ${code})`);
      watcher = null;
      
      // 检查模式是否改变
      const newMode = readSyncMode();
      if (newMode !== SYNC_MODE) {
        console.log(`🔄 检测到模式切换: ${SYNC_MODE} -> ${newMode}`);
        scheduleTimeout(() => {
          startWatcher();
        }, 1000);
      } else {
        // 即使模式没变，也尝试重启（可能是意外退出）
        console.log(`🔄 监听器意外退出，正在重启...`);
        scheduleTimeout(() => {
          startWatcher();
        }, 2000);
      }
    });
  }
  
  services.push(watcher);
}

// 定期检查模式文件变化（每3秒检查一次）
function startModeCheck() {
  if (modeCheckInterval) {
    clearInterval(modeCheckInterval);
  }
  
  modeCheckInterval = setInterval(() => {
    const fileMode = readSyncMode();
    if (fileMode !== SYNC_MODE) {
      console.log(`\n🔄 检测到模式文件变化: ${SYNC_MODE} -> ${fileMode}`);
      startWatcher();
    }
  }, 3000);
}

// 调用 continueStartup 启动服务
continueStartup();