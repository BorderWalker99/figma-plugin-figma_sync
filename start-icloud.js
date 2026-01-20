// start-icloud.js - iCloud 专用启动脚本（默认 iCloud 模式）
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// 检查并清理端口 8888
function cleanupPort() {
  if (process.platform === 'win32') return;
  
  try {
    const pid = execSync("lsof -i :8888 | grep LISTEN | awk '{print $2}'").toString().trim();
    
    if (pid) {
      console.log(`🧹 发现端口 8888 被占用 (PID: ${pid})，正在清理...`);
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
      execSync('sleep 1');
    }
  } catch (error) {
    // 忽略
  }
}

// 检查并清理旧的 watcher 进程
function cleanupWatcherProcesses() {
  if (process.platform === 'win32') return;
  
  try {
    const result = execSync("ps aux | grep -E 'icloud-watcher\\.js' | grep -v grep | awk '{print $2}'").toString().trim();
    
    if (result) {
      console.log(`🧹 发现旧的 watcher 进程，正在清理...`);
      const pids = result.split('\n');
      for (const pid of pids) {
        if (pid) {
          try {
            process.kill(parseInt(pid), 'SIGTERM');
            console.log(`   ✅ 已终止旧 watcher 进程 PID: ${pid}`);
          } catch (e) {
            console.log(`   ⚠️  无法终止进程 ${pid}: ${e.message}`);
          }
        }
      }
      execSync('sleep 1');
    }
  } catch (error) {
    // 忽略
  }
}

// 清理端口和旧进程
cleanupPort();
cleanupWatcherProcesses();

// 固定为 iCloud 模式
const SYNC_MODE = 'icloud';

// 写入模式配置文件
const SYNC_MODE_FILE = path.join(__dirname, '.sync-mode');
try {
  fs.writeFileSync(SYNC_MODE_FILE, SYNC_MODE, 'utf8');
} catch (error) {
  // 忽略
}

console.clear();
console.log('╔════════════════════════════════════════════╗');
console.log('║  ScreenSync iCloud 版 - 启动中...          ║');
console.log('║  截图将通过 iCloud 云盘同步                ║');
console.log('╚════════════════════════════════════════════╝\n');

const services = [];
let watcher = null;
let server = null;
let serverRestartCount = 0;
const MAX_RESTART_ATTEMPTS = 3;

// 检查环境
function checkEnvironment() {
  console.log('🔍 检查环境...');
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.warn('⚠️  警告: 未找到 node_modules 文件夹');
    console.log('   🔧 正在尝试自动安装依赖...');
    
    try {
      execSync('npm install --production', {
        cwd: __dirname,
        stdio: 'inherit',
        timeout: 300000
      });
      console.log('✅ 依赖安装成功！');
      
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

  // 检查关键依赖（iCloud 模式只需要这些）
  const requiredDeps = ['ws', 'express', 'sharp', 'chokidar'];
  for (const dep of requiredDeps) {
    const depPath = path.join(nodeModulesPath, dep);
    if (!fs.existsSync(depPath)) {
      console.error(`❌ 错误: 缺少关键依赖 "${dep}"`);
      console.log('   请运行: npm install');
      return false;
    }
  }
  console.log('✅ 环境检查通过');
  return true;
}

// 启动服务器
function startServer() {
  console.log('🚀 启动WebSocket服务器...');
  
  const NODE_MEMORY_LIMIT = process.env.NODE_MEMORY_LIMIT || '4096';
  server = spawn(process.execPath, [`--max-old-space-size=${NODE_MEMORY_LIMIT}`, 'server.js'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env, SYNC_MODE }
  });
  
  server.on('exit', (code, signal) => {
    const index = services.indexOf(server);
    if (index > -1) services.splice(index, 1);
    
    if (code !== 0 && code !== null) {
      console.error(`\n❌ 服务器异常退出 (code: ${code})`);
      
      if (serverRestartCount < MAX_RESTART_ATTEMPTS) {
        serverRestartCount++;
        console.log(`\n🔄 尝试自动重启服务器 (${serverRestartCount}/${MAX_RESTART_ATTEMPTS})...`);
        setTimeout(() => startServer(), 3000);
      } else {
        console.error('\n❌ 服务器重启次数超过限制');
        process.exit(1);
      }
    } else {
      serverRestartCount = 0;
    }
  });

  server.on('error', (error) => {
    console.error('\n❌ 无法启动服务器:', error.message);
  });
  
  services.push(server);
}

// 启动 iCloud 监听器
function startWatcher() {
  if (watcher) {
    watcher.kill();
    watcher = null;
  }
  
  console.log('\n🚀 启动 iCloud 监听器...');
  console.log('   📂 监听文件夹: ~/Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg');
  
  watcher = spawn(process.execPath, ['icloud-watcher.js'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env, SYNC_MODE }
  });
  
  watcher.on('exit', (code) => {
    console.log(`\n⚠️  iCloud 监听器已退出 (code: ${code})`);
    watcher = null;
    
    // 自动重启
    console.log(`🔄 监听器意外退出，3秒后重启...`);
    setTimeout(() => startWatcher(), 3000);
  });
  
  services.push(watcher);
}

// 主启动流程
if (!checkEnvironment()) {
  process.exit(1);
}

// 启动服务器
startServer();

// 延迟启动监听器
setTimeout(() => {
  startWatcher();
  
  console.log('\n✅ 所有服务已启动！');
  console.log('\n📱 iCloud 模式使用步骤：');
  console.log('   1. 在 iPhone 上配置快捷指令，保存截图到 iCloud 的 ScreenSyncImg 文件夹');
  console.log('   2. 在 Figma Desktop 中运行 ScreenSync 插件');
  console.log('   3. 点击"开始同步"按钮');
  console.log('   4. 截图将自动同步到 Figma！\n');
}, 2000);

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n\n👋 正在停止所有服务...');
  services.forEach(s => {
    try { s.kill(); } catch (e) {}
  });
  try {
    if (fs.existsSync(SYNC_MODE_FILE)) {
      fs.unlinkSync(SYNC_MODE_FILE);
    }
  } catch (error) {}
  process.exit(0);
});
