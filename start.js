// start.js - 一键启动脚本（支持动态切换模式）
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { checkUpdateAsync } = require('./update-manager');
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
    // 查找旧的 drive-watcher.js 和 aliyun-watcher.js 进程
    const result = execSync("ps aux | grep -E '(drive-watcher|aliyun-watcher|icloud-watcher)\\.js' | grep -v grep | awk '{print $2}'").toString().trim();
    
    if (result) {
      console.log(`🧹 发现旧的 watcher 进程，正在清理...`);
      const pids = result.split('\n');
      for (const pid of pids) {
        if (pid) {
          try {
            process.kill(parseInt(pid), 'SIGTERM'); // 使用 SIGTERM 让进程优雅退出
            console.log(`   ✅ 已终止旧 watcher 进程 PID: ${pid}`);
          } catch (e) {
            console.log(`   ⚠️  无法终止进程 ${pid}: ${e.message}`);
          }
        }
      }
      
      // 等待进程退出
      execSync('sleep 1');
    }
  } catch (error) {
    // 忽略错误（通常表示没有找到旧进程）
  }
}

// 清理端口和旧进程
cleanupPort();
cleanupWatcherProcesses();

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
let server = null;
let serverRestartCount = 0;
const MAX_RESTART_ATTEMPTS = 3;

// 检查环境（只在启动时检查一次）
function checkEnvironment() {
  console.log('🔍 检查环境...');
  const nodeModulesPath = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.warn('⚠️  警告: 未找到 node_modules 文件夹');
    console.log('   🔧 正在尝试自动安装依赖...');
    
    try {
      // 尝试自动安装依赖
      execSync('npm install --production', {
        cwd: __dirname,
        stdio: 'inherit',
        timeout: 300000 // 5 分钟超时
      });
      
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
  const requiredDeps = ['dotenv', 'ws', 'express', 'sharp'];
  for (const dep of requiredDeps) {
    const depPath = path.join(nodeModulesPath, dep);
    if (!fs.existsSync(depPath)) {
      console.error(`❌ 错误: 缺少关键依赖 "${dep}"`);
      console.log('   🔧 正在尝试重新安装依赖...');
      
      try {
        execSync('npm install --production', {
          cwd: __dirname,
          stdio: 'inherit',
          timeout: 300000
        });
        
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
      
      // 尝试自动重启
      if (serverRestartCount < MAX_RESTART_ATTEMPTS) {
        serverRestartCount++;
        console.log(`\n🔄 尝试自动重启服务器 (${serverRestartCount}/${MAX_RESTART_ATTEMPTS})...`);
        setTimeout(() => {
          startServer();
        }, 3000); // 等待3秒后重启
      } else {
        console.error('\n❌ 服务器重启次数超过限制');
        console.error('   这可能是由于：');
        console.error('   1. 依赖未正确安装');
        console.error('   2. 端口 8888 被占用');
        console.error('   3. 配置文件损坏');
        console.error('\n   请检查 server-error.log 文件查看详细错误信息');
        console.error('   或使用 Manual_Start_Server.command 手动启动\n');
        
        // 停止所有服务并退出
        console.log('🛑 正在停止所有服务...');
        services.forEach(s => {
          try { s.kill(); } catch (e) {}
        });
        process.exit(1);
      }
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
    return true;
  }
  
  if (envCheckAttempts < MAX_ENV_CHECK_ATTEMPTS) {
    console.warn(`\n⚠️  环境检查失败（第 ${envCheckAttempts}/${MAX_ENV_CHECK_ATTEMPTS} 次）`);
    console.log(`   将在 10 秒后重试...\n`);
    
    setTimeout(() => {
      if (!checkEnvironmentWithRetry()) {
        console.error('\n❌ 环境检查多次失败，无法启动服务');
        console.error('   请查看日志文件或联系作者获取帮助\n');
        process.exit(1);
      } else {
        // 环境检查通过，继续启动
        continueStartup();
      }
    }, 10000);
    
    return false; // 等待重试
  }
  
  console.error('\n❌ 环境检查失败，已达到最大重试次数');
  console.error('   请查看日志文件或联系作者获取帮助\n');
  process.exit(1);
  return false;
}

if (!checkEnvironmentWithRetry()) {
  // 正在重试，退出当前流程
  return;
}

// 环境检查通过，继续启动
function continueStartup() {
  // 启动服务器
  startServer();

  // 监听 server.js 变化实现自动重启
  if (chokidar) {
    const serverWatcher = chokidar.watch(path.join(__dirname, 'server.js'), {
      persistent: true,
      ignoreInitial: true
    });

    serverWatcher.on('change', (filePath) => {
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
      setTimeout(() => {
        cleanupPort(); // 确保端口已清理
        startServer();
      }, 2000); // 增加等待时间到 2 秒
    });
    
    // 将 watcher 加入 services 以便清理
    // chokidar watcher 有 close 方法，这里简单处理，进程退出时不需要显式 kill watcher
  }
  
  // 延迟启动监听器，避免重复启动
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
}

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

// 调用 continueStartup 启动服务
continueStartup();