// start.js - 一键启动脚本（支持动态切换模式）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { checkUpdateAsync } = require('./update-manager');

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

// 1. 启动服务器
console.log('🚀 启动WebSocket服务器...');
const server = spawn('node', ['server.js'], {
  stdio: 'inherit',
  cwd: __dirname,
  env: { ...process.env, SYNC_MODE }
});
services.push(server);

// 启动监听器
function startWatcher() {
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
    watcher = spawn('node', ['drive-watcher.js'], {
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
        setTimeout(() => {
          startWatcher();
        }, 1000);
      } else {
        // 即使模式没变，也尝试重启（可能是意外退出）
        console.log(`🔄 监听器意外退出，正在重启...`);
        setTimeout(() => {
          startWatcher();
        }, 2000);
      }
    });
  } else if (SYNC_MODE === 'aliyun' || SYNC_MODE === 'oss') {
    console.log('\n🚀 启动阿里云 OSS 监听器...');
    watcher = spawn('node', ['aliyun-watcher.js'], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, SYNC_MODE }
    });
    
    watcher.on('exit', (code) => {
      console.log(`\n⚠️  阿里云 OSS 监听器已退出 (code: ${code})`);
      watcher = null;
      
      // 检查模式是否改变
      const newMode = readSyncMode();
      if (newMode !== SYNC_MODE) {
        console.log(`🔄 检测到模式切换: ${SYNC_MODE} -> ${newMode}`);
        setTimeout(() => {
          startWatcher();
        }, 1000);
      } else {
        // 即使模式没变，也尝试重启（可能是意外退出）
        console.log(`🔄 监听器意外退出，正在重启...`);
        setTimeout(() => {
          startWatcher();
        }, 2000);
      }
    });
  } else {
    console.log('\n🚀 启动iCloud监听器...');
    watcher = spawn('node', ['icloud-watcher.js'], {
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
        setTimeout(() => {
          startWatcher();
        }, 1000);
      } else {
        // 即使模式没变，也尝试重启（可能是意外退出）
        console.log(`🔄 监听器意外退出，正在重启...`);
        setTimeout(() => {
          startWatcher();
        }, 2000);
      }
    });
  }
  
  services.push(watcher);
}

// 定期检查模式文件变化（每3秒检查一次）
let modeCheckInterval = null;
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

// 2. 延迟启动监听器
setTimeout(() => {
  startWatcher();
  startModeCheck(); // 启动模式检查
  
  console.log('\n✅ 所有服务已启动！');
  console.log('\n📱 下一步：在Figma Desktop中运行插件');
  console.log('   Plugins → Development → Import plugin from manifest\n');
}, 2000);

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n👋 正在停止所有服务...');
  if (modeCheckInterval) {
    clearInterval(modeCheckInterval);
  }
  services.forEach(s => s.kill());
  // 清理配置文件
  try {
    if (fs.existsSync(SYNC_MODE_FILE)) {
      fs.unlinkSync(SYNC_MODE_FILE);
    }
  } catch (error) {
    // 忽略错误
  }
  process.exit(0);
});