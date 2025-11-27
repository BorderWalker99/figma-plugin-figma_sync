// start.js - 一键启动脚本（支持动态切换模式）
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { checkUpdateAsync } = require('./update-manager');

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

// 清理端口
cleanupPort();

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

// 1. 检查依赖是否安装
console.log('🔍 检查环境...');
const nodeModulesPath = path.join(__dirname, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  console.error('❌ 错误: 未找到 node_modules 文件夹');
  console.error('   依赖可能未安装完成');
  console.error('   请运行: npm install');
  process.exit(1);
}

// 检查关键依赖
const requiredDeps = ['dotenv', 'ws', 'express', 'sharp'];
for (const dep of requiredDeps) {
  const depPath = path.join(nodeModulesPath, dep);
  if (!fs.existsSync(depPath)) {
    console.error(`❌ 错误: 缺少关键依赖 "${dep}"`);
    console.error('   请运行: npm install');
    process.exit(1);
  }
}
console.log('✅ 环境检查通过');

// 2. 启动服务器
console.log('🚀 启动WebSocket服务器...');
// 增加 Node.js 内存限制到 4GB，以支持大文件（GIF/视频）处理
// 如果系统内存不足，可以减小这个值（如 2048 表示 2GB）
const NODE_MEMORY_LIMIT = process.env.NODE_MEMORY_LIMIT || '4096';
const server = spawn('node', [`--max-old-space-size=${NODE_MEMORY_LIMIT}`, 'server.js'], {
  stdio: 'inherit',
  cwd: __dirname,
  env: { ...process.env, SYNC_MODE }
});
services.push(server);

// 监听服务器进程退出
server.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    console.error(`\n❌ 服务器异常退出 (code: ${code})`);
    console.error('   这可能是由于：');
    console.error('   1. 依赖未正确安装');
    console.error('   2. 端口 8888 被占用');
    console.error('   3. 配置文件损坏');
    console.error('\n   请检查 server-error.log 文件查看详细错误信息');
    console.error('   或尝试手动运行: npm start\n');
    
    // 记录到错误日志文件
    try {
      const errorLogPath = path.join(__dirname, 'server-error.log');
      const errorMsg = `[${new Date().toISOString()}] 服务器异常退出 (code: ${code}, signal: ${signal})\n`;
      fs.appendFileSync(errorLogPath, errorMsg, 'utf8');
    } catch (e) {
      // 忽略日志写入错误
    }
    
    // 停止所有服务并退出
    console.log('🛑 正在停止所有服务...');
    services.forEach(s => {
      if (s && s !== server) {
        try { s.kill(); } catch (e) {}
      }
    });
    
    process.exit(1);
  } else if (signal) {
    console.log(`\n⚠️  服务器被信号终止 (signal: ${signal})`);
  }
});

server.on('error', (error) => {
  console.error('\n❌ 无法启动服务器:', error.message);
  process.exit(1);
});

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
    console.log('\n🚀 启动阿里云监听器...');
    watcher = spawn('node', ['aliyun-watcher.js'], {
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