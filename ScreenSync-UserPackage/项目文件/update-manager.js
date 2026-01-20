// 更新管理器
// 集成到 start.js 中，自动检查并提示更新

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const VERSION_URL = process.env.VERSION_URL || 'https://your-cdn-domain.com/figmasync/version.json';
const CURRENT_VERSION_FILE = path.join(__dirname, 'VERSION.txt');
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24小时检查一次
const LAST_CHECK_FILE = path.join(__dirname, '.last-update-check');

function getCurrentVersion() {
  try {
    if (fs.existsSync(CURRENT_VERSION_FILE)) {
      const content = fs.readFileSync(CURRENT_VERSION_FILE, 'utf8');
      const match = content.match(/版本:\s*([^\n]+)/);
      return match ? match[1].trim() : null;
    }
  } catch (error) {
    // 忽略错误
  }
  return null;
}

function shouldCheckUpdate() {
  try {
    if (!fs.existsSync(LAST_CHECK_FILE)) {
      return true;
    }
    
    const lastCheck = parseInt(fs.readFileSync(LAST_CHECK_FILE, 'utf8'), 10);
    const now = Date.now();
    
    return (now - lastCheck) > CHECK_INTERVAL;
  } catch (error) {
    return true;
  }
}

function saveLastCheckTime() {
  try {
    fs.writeFileSync(LAST_CHECK_FILE, Date.now().toString());
  } catch (error) {
    // 忽略错误
  }
}

function checkUpdate() {
  return new Promise((resolve, reject) => {
    const url = new URL(VERSION_URL);
    const client = url.protocol === 'https:' ? https : http;
    
    const options = {
      timeout: 5000,
      headers: {
        'User-Agent': 'ScreenSync-UpdateChecker/1.0'
      }
    };
    
    client.get(VERSION_URL, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const versionInfo = JSON.parse(data);
          const currentVersion = getCurrentVersion();
          
          saveLastCheckTime();
          
          if (currentVersion && currentVersion === versionInfo.version) {
            resolve({ 
              hasUpdate: false, 
              currentVersion, 
              latestVersion: versionInfo.version 
            });
          } else {
            resolve({ 
              hasUpdate: true, 
              currentVersion, 
              latestVersion: versionInfo.version,
              downloadUrl: versionInfo.server.package,
              releaseDate: versionInfo.releaseDate
            });
          }
        } catch (error) {
          reject(new Error(`解析版本信息失败: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(new Error(`网络错误: ${error.message}`));
    }).on('timeout', () => {
      reject(new Error('请求超时'));
    });
  });
}

function displayUpdateInfo(updateInfo) {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  发现新版本！                         ║');
  console.log('╚════════════════════════════════════════╝\n');
  console.log(`   当前版本: ${updateInfo.currentVersion || '未知'}`);
  console.log(`   最新版本: ${updateInfo.latestVersion}`);
  console.log(`   发布日期: ${updateInfo.releaseDate || '未知'}\n`);
  console.log('💡 更新方法：');
  console.log(`   1. 运行: curl -fsSL ${updateInfo.downloadUrl} | tar -xz`);
  console.log('   2. 或者访问 GitHub Releases 下载最新版本\n');
}

async function checkUpdateAsync() {
  if (!shouldCheckUpdate()) {
    return;
  }
  
  try {
    const updateInfo = await checkUpdate();
    
    if (updateInfo.hasUpdate) {
      displayUpdateInfo(updateInfo);
    } else {
      console.log(`✅ 当前版本已是最新: ${updateInfo.currentVersion || '未知'}\n`);
    }
  } catch (error) {
    // 静默失败，不影响主程序运行
    // console.log(`⚠️  检查更新失败: ${error.message}`);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  checkUpdateAsync()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 检查更新失败:', error.message);
      process.exit(0);
    });
}

module.exports = { checkUpdateAsync, checkUpdate, getCurrentVersion };

