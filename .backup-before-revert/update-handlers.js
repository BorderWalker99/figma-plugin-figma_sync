// update-handlers.js - Server-side update checking, downloading, and installation
// Extracted from server.js for maintainability

const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');

/**
 * Factory: inject server-level dependencies.
 * @param {object} deps
 * @param {Function} deps.sendToFigma - (targetGroup, data) => boolean
 * @param {object}   deps.WebSocket   - ws module (for readyState constants)
 * @returns {object} { checkAndNotifyUpdates, handlePluginUpdate, handleServerUpdate, handleFullUpdate }
 */
module.exports = function createUpdateHandlers({ sendToFigma, WebSocket }) {

// 检查并通知更新（插件和服务器）
async function checkAndNotifyUpdates(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };
      
      https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      }).on('error', reject).on('timeout', () => {
        reject(new Error('请求超时'));
      });
    });
    
    // 获取当前版本
    const currentServerVersion = getCurrentServerVersion();
    const latestVersion = releaseInfo.tag_name.replace(/^v/, '');
    
    // 查找更新文件
    const pluginAsset = releaseInfo.assets.find(asset => 
      asset.name.includes('figma-plugin') && asset.name.endsWith('.zip')
    );
    
    // 检测当前系统架构，查找对应的服务器更新包
    const arch = process.arch; // 'arm64' for Apple Silicon, 'x64' for Intel
    const isAppleSilicon = arch === 'arm64';
    let serverAsset = null;
    
    if (isAppleSilicon) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 回退到通用包（兼容旧版本）
    if (!serverAsset) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-UserPackage') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 检查插件更新
    if (pluginAsset) {
      const currentPluginVersion = getCurrentPluginVersion();
      const pluginNeedsUpdate = !currentPluginVersion || compareVersions(latestVersion, currentPluginVersion) > 0;
      
      if (pluginNeedsUpdate) {
        sendToFigma(targetGroup, {
          type: 'plugin-update-info',
          latestVersion: latestVersion,
          updateUrl: releaseInfo.html_url,
          releaseNotes: releaseInfo.body || '',
          hasUpdate: true
        });
      }
    }
    
    // 检查服务器更新
    if (serverAsset) {
      const serverNeedsUpdate = !currentServerVersion || compareVersions(latestVersion, currentServerVersion) > 0;
      
      if (serverNeedsUpdate) {
        sendToFigma(targetGroup, {
          type: 'server-update-info',
          latestVersion: latestVersion,
          currentVersion: currentServerVersion || '未知',
          updateUrl: releaseInfo.html_url,
          releaseNotes: releaseInfo.body || '',
          hasUpdate: true,
          downloadUrl: serverAsset.browser_download_url
        });
      }
    }
    
  } catch (error) {
    console.error('   ⚠️  检查更新失败:', error.message);
  }
}

// 获取当前服务器版本
function getCurrentServerVersion() {
  try {
    const versionFile = path.join(__dirname, 'VERSION.txt');
    if (fs.existsSync(versionFile)) {
      const content = fs.readFileSync(versionFile, 'utf8');
      const match = content.match(/版本:\s*([^\n]+)/);
      return match ? match[1].trim() : null;
    }
  } catch (error) {
    // 忽略错误
  }
  return null;
}

// 获取当前插件版本
function getCurrentPluginVersion() {
  try {
    // 从 code.js 中读取 PLUGIN_VERSION 常量
    const codeFile = path.join(__dirname, 'figma-plugin', 'code.js');
    if (fs.existsSync(codeFile)) {
      const codeContent = fs.readFileSync(codeFile, 'utf8');
      // 匹配 PLUGIN_VERSION = 'x.x.x' 或 PLUGIN_VERSION = "x.x.x"
      const versionMatch = codeContent.match(/PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
      if (versionMatch && versionMatch[1]) {
        return versionMatch[1];
      }
    }
  } catch (error) {
    console.warn('⚠️ 无法读取插件版本:', error.message);
  }
  return null;
}

// 比较版本号
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);
  
  for (let i = 0; i < maxLength; i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  return 0;
}

// 支持重定向和进度报告的下载函数
function downloadFileWithRedirect(url, destPath, onProgress = null) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const file = fs.createWriteStream(destPath);
    
    // 添加必要的请求头，GitHub 需要 User-Agent 和 Accept
    const options = {
      headers: {
        'User-Agent': 'ScreenSync-Updater/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    const request = https.get(url, options, (response) => {
      // 处理重定向 (HTTP 3xx)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = response.headers.location;
        file.close();
        
        // 递归调用，传递进度回调
        downloadFileWithRedirect(redirectUrl, destPath, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        console.error(`   ❌ 下载失败: HTTP ${response.statusCode} - ${url}`);
        reject(new Error(`下载失败: HTTP ${response.statusCode}`));
        return;
      }
      
      // 📊 获取文件总大小
      const totalSize = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedSize = 0;
      let lastProgressTime = Date.now();
      
      // 监听数据流，报告进度
      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        
        // 每 500ms 报告一次进度，避免过于频繁
        const now = Date.now();
        if (onProgress && (now - lastProgressTime > 500 || downloadedSize === totalSize)) {
          const progress = totalSize > 0 ? Math.floor((downloadedSize / totalSize) * 100) : 0;
          onProgress(downloadedSize, totalSize, progress);
          lastProgressTime = now;
        }
      });
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        // 最后一次进度报告（100%）
        if (onProgress && totalSize > 0) {
          onProgress(totalSize, totalSize, 100);
        }
        resolve();
      });
    });
    
    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      console.error(`   ❌ 下载请求错误: ${err.message}`);
      reject(err);
    });
    
    request.setTimeout(30000, () => {
      request.destroy();
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      console.error(`   ❌ 下载超时: ${url}`);
      reject(new Error('下载超时'));
    });
  });
}

// 插件自动更新功能
async function handlePluginUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    
    // 通知用户开始更新
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    });
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    
    console.log(`   📥 从 GitHub API 获取最新版本: ${apiUrl}`);
    
    // 使用 https 模块获取 GitHub API 数据
    const https = require('https');
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Plugin-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };
      
      https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      }).on('error', reject).on('timeout', () => {
        reject(new Error('请求超时'));
      });
    });
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 查找插件文件（优先查找包含 figma-plugin 的 zip 文件）
    let pluginAsset = releaseInfo.assets.find(asset => 
      asset.name.includes('figma-plugin') && asset.name.endsWith('.zip')
    );
    
    if (!pluginAsset) {
      // 如果没有找到，尝试查找任何 zip 文件
      pluginAsset = releaseInfo.assets.find(asset => asset.name.endsWith('.zip'));
    }
    
    if (!pluginAsset) {
      throw new Error('未找到插件文件，请确保 Release 中包含 .zip 格式的插件文件');
    }
    
    console.log(`   📦 找到插件文件: ${pluginAsset.name} (${(pluginAsset.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // 通知用户正在下载
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'downloading',
      message: `正在下载 ${pluginAsset.name}...`
    });
    
    // 下载插件文件
    const downloadUrl = pluginAsset.browser_download_url;
    const pluginDir = path.join(__dirname, 'figma-plugin');
    const tempFile = path.join(__dirname, '.plugin-update-temp.zip');
    
    console.log(`   📥 下载地址: ${downloadUrl}`);
    
    // 下载文件
    await downloadFileWithRedirect(downloadUrl, tempFile);
          console.log(`   ✅ 下载完成: ${tempFile}`);
    
    // 通知用户正在安装
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'installing',
      message: '正在安装更新...'
    });
    
    // 解压并覆盖插件文件（使用 Node.js 内置方法或 child_process）
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // 确保插件目录存在
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
    }
    
    // 备份现有文件（可选）
    const backupDir = path.join(__dirname, '.plugin-backup');
    if (fs.existsSync(pluginDir)) {
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
      fs.mkdirSync(backupDir, { recursive: true });
      const files = fs.readdirSync(pluginDir);
      files.forEach(file => {
        const src = path.join(pluginDir, file);
        const dest = path.join(backupDir, file);
        try {
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, dest);
          }
        } catch (e) {
          // 忽略备份错误
        }
      });
      console.log(`   💾 已备份现有插件文件到: ${backupDir}`);
    }
    
    // 解压 zip 文件（使用 unzip 命令，如果没有则提示用户安装）
    try {
      // 尝试使用 unzip 命令
      // 注意：zip 包包含 'figma-plugin' 顶层目录，所以解压到 __dirname
      await execPromise(`unzip -o "${tempFile}" -d "${__dirname}"`);
      console.log(`   ✅ 插件文件已更新到: ${pluginDir}`);
    } catch (unzipError) {
      // 如果 unzip 不可用，尝试使用 Node.js 方法
      try {
        // 简单的 zip 解压（仅支持基本格式）
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(__dirname, true);
        console.log(`   ✅ 插件文件已更新到: ${pluginDir}`);
      } catch (zipError) {
        throw new Error('无法解压插件文件，请确保系统已安装 unzip 或 adm-zip 模块');
      }
    }
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    
    // 通知用户更新完成
    sendToFigma(targetGroup, {
      type: 'plugin-update-progress',
      status: 'completed',
      message: '更新完成！请重启插件以使用新版本',
      version: releaseInfo.tag_name
    });
    
    console.log(`   ✅ 插件更新完成: ${releaseInfo.tag_name}\n`);
    
  } catch (error) {
    console.error(`   ❌ 插件更新失败: ${error.message}`);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, {
        type: 'plugin-update-progress',
        status: 'error',
        message: `更新失败: ${error.message}`
      });
    }
  }
}

// 服务器自动更新功能
async function handleServerUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  try {
    
    // 通知用户开始更新
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    });
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const https = require('https');
    
    console.log(`   📥 从 GitHub API 获取最新版本: ${apiUrl}`);
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Server-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        },
        timeout: 10000
      };
      
      https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      }).on('error', reject).on('timeout', () => {
        reject(new Error('请求超时'));
      });
    });
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 检测当前系统架构，查找对应的服务器更新包
    const arch = process.arch;
    const isAppleSilicon = arch === 'arm64';
    console.log(`   🖥️  系统架构: ${arch} (${isAppleSilicon ? 'Apple Silicon' : 'Intel'})`);
    
    let serverAsset = null;
    if (isAppleSilicon) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 回退到通用包
    if (!serverAsset) {
      serverAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-UserPackage') && asset.name.endsWith('.tar.gz')
      );
    }
    
    if (!serverAsset) {
      throw new Error(`未找到适合 ${isAppleSilicon ? 'Apple Silicon' : 'Intel'} 的服务器包，请确保 Release 中包含 ScreenSync-Apple.tar.gz 或 ScreenSync-Intel.tar.gz`);
    }
    
    console.log(`   📦 找到服务器包: ${serverAsset.name} (${(serverAsset.size / 1024 / 1024).toFixed(2)} MB)`);
    
    // 通知用户正在下载
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'downloading',
      message: `正在下载 ${serverAsset.name}...`
    });
    
    // 下载服务器包
    const downloadUrl = serverAsset.browser_download_url;
    const tempFile = path.join(__dirname, '.server-update-temp.tar.gz');
    const updateDir = path.join(__dirname, '.server-update');
    
    console.log(`   📥 下载地址: ${downloadUrl}`);
    
    // 下载文件
    await downloadFileWithRedirect(downloadUrl, tempFile);
          console.log(`   ✅ 下载完成: ${tempFile}`);
    
    // 通知用户正在安装
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'installing',
      message: '正在安装更新...'
    });
    
    // 解压到临时目录
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    fs.mkdirSync(updateDir, { recursive: true });
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // 解压 tar.gz
    await execPromise(`tar -xzf "${tempFile}" -C "${updateDir}"`);
    console.log(`   ✅ 解压完成到: ${updateDir}`);
    
    // 备份现有文件
    const backupDir = path.join(__dirname, '.server-backup');
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(backupDir, { recursive: true });
    
    // 需要更新的服务器文件列表
    const serverFiles = [
      'server.js',
      'googleDrive.js',
      'aliyunOSS.js',
      'userConfig.js',
      'start.js',
      'update-manager.js',
      'icloud-watcher.js',
      'drive-watcher.js',
      'aliyun-watcher.js',
      'package.json'
    ];
    
    // 备份并更新文件
    // 动态查找解压后的目录（支持 ScreenSync-Apple、ScreenSync-Intel 或 ScreenSync-UserPackage）
    let extractedDir = null;
    const possibleDirs = ['ScreenSync-Apple', 'ScreenSync-Intel', 'ScreenSync-UserPackage'];
    for (const dirName of possibleDirs) {
      const testDir = path.join(updateDir, dirName);
      if (fs.existsSync(testDir)) {
        extractedDir = testDir;
        console.log(`   📂 找到解压目录: ${dirName}`);
        break;
      }
    }
    
    // 如果没有找到预期的目录，尝试查找包含 server.js 的目录
    if (!extractedDir) {
      const updateDirContents = fs.readdirSync(updateDir);
      for (const item of updateDirContents) {
        const itemPath = path.join(updateDir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          // 检查是否包含 server.js
          if (fs.existsSync(path.join(itemPath, 'server.js'))) {
            extractedDir = itemPath;
            console.log(`   📂 找到项目目录: ${item}`);
            break;
          }
          // 检查子目录 项目文件/
          const projectFilesDir = path.join(itemPath, '项目文件');
          if (fs.existsSync(projectFilesDir) && fs.existsSync(path.join(projectFilesDir, 'server.js'))) {
            extractedDir = projectFilesDir;
            console.log(`   📂 找到项目文件目录: ${item}/项目文件`);
            break;
          }
        }
      }
    }
    
    if (!extractedDir) {
      throw new Error('无法找到解压后的项目目录');
    }
    
    for (const file of serverFiles) {
      const srcPath = path.join(extractedDir, file);
      const destPath = path.join(__dirname, file);
      const backupPath = path.join(backupDir, file);
      
      if (fs.existsSync(srcPath)) {
        // 备份现有文件
        if (fs.existsSync(destPath)) {
          fs.copyFileSync(destPath, backupPath);
        }
        // 更新文件
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✅ 已更新: ${file}`);
      }
    }
    
    // 更新插件文件（如果存在）
    const pluginSrcDir = path.join(extractedDir, 'figma-plugin');
    const pluginDestDir = path.join(__dirname, 'figma-plugin');
    if (fs.existsSync(pluginSrcDir) && fs.existsSync(pluginDestDir)) {
      const pluginFiles = ['manifest.json', 'code.js', 'ui.html'];
      for (const file of pluginFiles) {
        const srcPath = path.join(pluginSrcDir, file);
        const destPath = path.join(pluginDestDir, file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, destPath);
          console.log(`   ✅ 已更新插件: ${file}`);
        }
      }
    }
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    
    // 通知用户更新完成
    sendToFigma(targetGroup, {
      type: 'server-update-progress',
      status: 'completed',
      message: '更新完成！请重启服务器以使用新版本',
      version: releaseInfo.tag_name
    });
    
    console.log(`   ✅ 服务器更新完成: ${releaseInfo.tag_name}`);
    console.log(`   💡 请运行 'npm install' 安装新依赖（如有）`);
    console.log(`   💡 然后重启服务器\n`);
    
  } catch (error) {
    console.error(`   ❌ 服务器更新失败: ${error.message}`);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, {
        type: 'server-update-progress',
        status: 'error',
        message: `更新失败: ${error.message}`
      });
    }
  }
}

// 统一全量更新功能（插件 + 服务器所有代码）
async function handleFullUpdate(targetGroup, connectionId) {
  if (!targetGroup || !targetGroup.figma || targetGroup.figma.readyState !== WebSocket.OPEN) {
    return;
  }
  
  // 为整个更新流程添加总体超时（10分钟）
  const overallTimeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('更新超时（超过10分钟），请检查网络连接或稍后重试')), 600000);
  });
  
  const updateTask = (async () => {
    
    // 通知用户开始更新
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'downloading',
      message: '正在下载最新版本...'
    });
    
    // 获取 GitHub Releases 最新版本信息
    const repo = 'BorderWalker99/figma-plugin-figma_sync';
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const https = require('https');
    
    const releaseInfo = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'ScreenSync-Full-Updater/1.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      };
      
      const req = https.get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              console.log(`   ✅ 成功获取 Release 信息`);
              resolve(parsed);
            } catch (e) {
              console.error(`   ❌ JSON 解析失败:`, e.message);
              reject(new Error('解析 GitHub API 响应失败'));
            }
          } else {
            console.error(`   ❌ GitHub API 错误: ${res.statusCode}`);
            reject(new Error(`GitHub API 返回错误: ${res.statusCode}`));
          }
        });
      });
      
      // 正确设置超时
      req.setTimeout(30000, () => {
        req.destroy();
        console.error(`   ❌ GitHub API 请求超时（30秒）`);
        reject(new Error('GitHub API 请求超时（30秒）'));
      });
      
      req.on('error', (error) => {
        console.error(`   ❌ 网络请求错误:`, error.message);
        reject(error);
      });
    });
    
    console.log(`   ✅ 获取到最新版本: ${releaseInfo.tag_name}`);
    
    // 🔧 关键修复：必须使用 Release Assets 中的完整 UserPackage
    // GitHub 的 tarball_url 只是源码快照，不包含编译后的插件和完整文件结构
    let downloadUrl;
    let updateFilename;
    let updateSize = 0;
    
    console.log(`   📦 正在查找完整更新包...`);
    console.log(`   Available assets:`, releaseInfo.assets.map(a => a.name).join(', '));
    
    // 检测当前系统架构
    const arch = process.arch; // 'arm64' for Apple Silicon, 'x64' for Intel
    const isAppleSilicon = arch === 'arm64';
    console.log(`   🖥️  系统架构: ${arch} (${isAppleSilicon ? 'Apple Silicon' : 'Intel'})`);
    
    // 查找对应架构的更新包，优先使用新命名格式
    let updateAsset = null;
    
    if (isAppleSilicon) {
      // Apple Silicon: 优先找 ScreenSync-Apple，其次找 UserPackage
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Apple') && asset.name.endsWith('.tar.gz')
      );
    } else {
      // Intel: 优先找 ScreenSync-Intel，其次找 UserPackage
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-Intel') && asset.name.endsWith('.tar.gz')
      );
    }
    
    // 如果没找到架构特定的包，尝试找通用的 UserPackage
    if (!updateAsset) {
      updateAsset = releaseInfo.assets.find(asset => 
        asset.name.includes('ScreenSync-UserPackage') && asset.name.endsWith('.tar.gz')
      );
    }
    
    if (!updateAsset) {
      console.error(`   ❌ 未找到更新包`);
      console.error(`   Available assets:`, releaseInfo.assets.map(a => a.name));
      throw new Error(`未找到适合 ${isAppleSilicon ? 'Apple Silicon' : 'Intel'} 的更新包。请确保 Release 中已上传 ScreenSync-Apple.tar.gz 或 ScreenSync-Intel.tar.gz。`);
    }
    
    downloadUrl = updateAsset.browser_download_url;
    updateFilename = updateAsset.name;
    updateSize = updateAsset.size;
    console.log(`   ✅ 找到完整更新包: ${updateFilename}`);
    console.log(`   📦 文件大小: ${(updateSize / 1024 / 1024).toFixed(2)} MB`);
    
    // 通知用户正在下载
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'downloading',
      message: '正在下载更新包...'
    });
    
    // 下载更新包
    // const downloadUrl = updateAsset.browser_download_url; // 已定义
    const tempFile = path.join(__dirname, '.full-update-temp.tar.gz');
    const updateDir = path.join(__dirname, '.full-update');
    
    console.log(`   📥 下载地址: ${downloadUrl}`);
    console.log(`   📦 文件大小: ${(updateSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   ⏳ 开始下载...`);
    
    // 下载文件（带进度报告和超时保护）
    const downloadTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('下载超时（超过5分钟）')), 300000);
    });
    
    // 进度回调函数
    const onDownloadProgress = (downloaded, total, percent) => {
      const downloadedMB = (downloaded / 1024 / 1024).toFixed(2);
      const totalMB = (total / 1024 / 1024).toFixed(2);
      console.log(`   📥 下载进度: ${percent}% (${downloadedMB}MB / ${totalMB}MB)`);
      
      // 通知 Figma 插件下载进度
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        sendToFigma(targetGroup, {
          type: 'update-progress',
          status: 'downloading',
          message: `正在下载... ${percent}%`,
          progress: percent
        });
      }
    };
    
    await Promise.race([
      downloadFileWithRedirect(downloadUrl, tempFile, onDownloadProgress),
      downloadTimeout
    ]);
    
    const downloadedSize = fs.statSync(tempFile).size;
    console.log(`   ✅ 下载完成: ${tempFile}`);
    console.log(`   📦 实际大小: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`);
    
    // 通知用户正在解压
    console.log(`   📦 开始解压文件...`);
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'extracting',
      message: '正在解压更新包...'
    });
    
    // 解压到临时目录
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    fs.mkdirSync(updateDir, { recursive: true });
    
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    
    // 解压 tar.gz
    console.log(`   📦 开始解压 tar.gz 文件...`);
    await execPromise(`tar -xzf "${tempFile}" -C "${updateDir}"`);
    console.log(`   ✅ 解压完成到: ${updateDir}`);
    
    // 通知用户正在检查文件
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'checking',
      message: '正在检查文件变化...'
    });
    
    // 查找解压后的内容目录
    // 策略：递归查找 server.js 所在的目录（支持深层目录结构如 项目文件/）
    const findServerJs = (dir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth) return null;
      
      try {
        const items = fs.readdirSync(dir);
        // 忽略隐藏文件
        const visibleItems = items.filter(item => !item.startsWith('.'));
        
        // 检查当前目录是否包含 server.js 和 package.json
        if (visibleItems.includes('server.js') && visibleItems.includes('package.json')) {
          console.log(`   ✅ 在深度 ${depth} 找到项目文件: ${dir}`);
          return dir;
        }
        
        // 递归搜索子目录
        for (const item of visibleItems) {
          const itemPath = path.join(dir, item);
          try {
            if (fs.statSync(itemPath).isDirectory()) {
              const result = findServerJs(itemPath, depth + 1, maxDepth);
              if (result) return result;
            }
          } catch (e) {
            // 忽略无法访问的目录
          }
        }
      } catch (e) {
        // 忽略无法读取的目录
      }
      return null;
    };
    
    console.log(`   🔍 开始搜索项目文件目录...`);
    let extractedDir = findServerJs(updateDir);
    
    if (!extractedDir) {
        console.log('   ⚠️  未自动定位到根目录，尝试使用解压根目录');
        // 如果解压出来只有一个文件夹，进入该文件夹
        const extractedItems = fs.readdirSync(updateDir).filter(item => !item.startsWith('.'));
        console.log(`   Extracted items:`, extractedItems);
        
        if (extractedItems.length === 1 && fs.statSync(path.join(updateDir, extractedItems[0])).isDirectory()) {
          extractedDir = path.join(updateDir, extractedItems[0]);
          // 再次尝试在这个目录中查找
          const nestedDir = findServerJs(extractedDir);
          if (nestedDir) {
            extractedDir = nestedDir;
          }
        } else {
          extractedDir = updateDir;
        }
    }
    
    console.log(`   📂 最终内容目录: ${extractedDir}`);
    
    // 🔧 验证目录结构
    const requiredFiles = ['server.js', 'package.json'];
    const requiredDirs = ['figma-plugin'];
    const missingItems = [];
    
    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(extractedDir, file))) {
        missingItems.push(file);
      }
    }
    
    for (const dir of requiredDirs) {
      if (!fs.existsSync(path.join(extractedDir, dir))) {
        missingItems.push(dir + '/');
      }
    }
    
    if (missingItems.length > 0) {
      console.error(`   ❌ 更新包不完整，缺少以下文件/目录:`, missingItems);
      console.error(`   ❌ 目录内容:`, fs.readdirSync(extractedDir));
      throw new Error(`更新包不完整，缺少必需的文件: ${missingItems.join(', ')}`);
    }
    
    console.log(`   ✅ 目录结构验证通过`);
    
    // 备份现有文件
    const backupDir = path.join(__dirname, '.full-backup');
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    fs.mkdirSync(backupDir, { recursive: true });
    
    // 需要更新的所有文件列表
    const allFiles = [
      // 服务器核心文件
      'server.js',
      'start.js',
      // Google Drive 相关
      'googleDrive.js',
      'drive-watcher.js',
      // 阿里云 OSS 相关
      'aliyunOSS.js',
      'aliyun-watcher.js',
      // iCloud 相关
      'icloud-watcher.js',
      // 配置和工具
      'userConfig.js',
      'update-manager.js',
      'package.json',
      'VERSION.txt'
    ];
    
    // 🚀 增量更新：只更新有变化的文件
    const crypto = require('crypto');
    
    // 计算文件 hash
    const getFileHash = (filePath) => {
      try {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
      } catch (error) {
        return null;
      }
    };
    
    // 备份并更新服务器文件
    let updatedCount = 0;
    let skippedCount = 0;
    let newFilesCount = 0;
    
    console.log(`   🔍 开始对比文件变化...`);
    
    for (const file of allFiles) {
      const srcPath = path.join(extractedDir, file);
      const destPath = path.join(__dirname, file);
      const backupPath = path.join(backupDir, file);
      
      if (!fs.existsSync(srcPath)) {
        console.log(`   ⚠️  源文件不存在，跳过: ${file}`);
        continue;
      }
      
      // 检查目标文件是否存在
      const destExists = fs.existsSync(destPath);
      
      if (!destExists) {
        // 新文件，直接复制
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✅ [新增] ${file}`);
        newFilesCount++;
        updatedCount++;
        continue;
      }
      
      // 对比文件内容
      const srcHash = getFileHash(srcPath);
      const destHash = getFileHash(destPath);
      
      if (srcHash === destHash) {
        // 文件内容相同，跳过
        console.log(`   ⏭️  [跳过] ${file} (无变化)`);
        skippedCount++;
        continue;
      }
      
      // 文件有变化，备份并更新
      fs.copyFileSync(destPath, backupPath);
      fs.copyFileSync(srcPath, destPath);
      console.log(`   ✅ [更新] ${file}`);
      updatedCount++;
    }
    
    console.log(`\n   📊 更新统计:`);
    console.log(`      • 更新文件: ${updatedCount} 个`);
    console.log(`      • 新增文件: ${newFilesCount} 个`);
    console.log(`      • 跳过文件: ${skippedCount} 个 (无变化)`);
    console.log(`      • 总计节省: ${skippedCount} 个文件的复制操作\n`);
    
    // 通知用户更新统计
    sendToFigma(targetGroup, {
      type: 'update-progress',
      status: 'installing',
      message: `正在更新文件... (${updatedCount} 个文件需要更新)`
    });
    
    // 🚀 增量更新插件文件
    const pluginSrcDir = path.join(extractedDir, 'figma-plugin');
    const pluginDestDir = path.join(__dirname, 'figma-plugin');
    
    if (fs.existsSync(pluginSrcDir) && fs.existsSync(pluginDestDir)) {
      const pluginFiles = ['manifest.json', 'code.js', 'ui.html'];
      const pluginBackupDir = path.join(backupDir, 'figma-plugin');
      fs.mkdirSync(pluginBackupDir, { recursive: true });
      
      console.log(`   🔍 开始对比插件文件变化...`);
      let pluginUpdated = 0;
      let pluginSkipped = 0;
      
      for (const file of pluginFiles) {
        const srcPath = path.join(pluginSrcDir, file);
        const destPath = path.join(pluginDestDir, file);
        const backupPath = path.join(pluginBackupDir, file);
        
        if (!fs.existsSync(srcPath)) {
          console.log(`   ⚠️  源文件不存在，跳过: figma-plugin/${file}`);
          continue;
        }
        
        const destExists = fs.existsSync(destPath);
        
        if (!destExists) {
          // 新文件
          fs.copyFileSync(srcPath, destPath);
          console.log(`   ✅ [新增] figma-plugin/${file}`);
          pluginUpdated++;
          updatedCount++;
          continue;
        }
        
        // 对比文件内容
        const srcHash = getFileHash(srcPath);
        const destHash = getFileHash(destPath);
        
        if (srcHash === destHash) {
          // 文件内容相同，跳过
          console.log(`   ⏭️  [跳过] figma-plugin/${file} (无变化)`);
          pluginSkipped++;
          skippedCount++;
          continue;
        }
        
        // 备份并更新
        fs.copyFileSync(destPath, backupPath);
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✅ [更新] figma-plugin/${file}`);
        pluginUpdated++;
        updatedCount++;
      }
      
      console.log(`\n   📊 插件更新统计:`);
      console.log(`      • 更新文件: ${pluginUpdated} 个`);
      console.log(`      • 跳过文件: ${pluginSkipped} 个 (无变化)\n`);
    }
    
    // 清理临时文件
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(updateDir)) {
      fs.rmSync(updateDir, { recursive: true, force: true });
    }
    
    console.log(`\n✅ [Full Update] 全量更新完成！`);
    console.log(`   ✅ 成功更新 ${updatedCount} 个文件`);
    console.log(`   📦 备份位置: ${backupDir}`);
    console.log(`   🔄 准备自动重启服务器以应用更新...\n`);
    
    // 通知用户更新完成（在重启前发送）
    if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      sendToFigma(targetGroup, {
        type: 'update-progress',
        status: 'completed',
        message: `更新完成！服务器将自动重启...`,
        updatedCount: updatedCount,
        latestVersion: releaseInfo.tag_name // 发送最新版本号
      });
    }
    
    // 延迟 2 秒后自动重启服务器（让前端收到消息）
    setTimeout(() => {
      console.log(`\n🔄 [Full Update] 正在重启服务器以应用更新...`);
      
      // 如果是通过 launchd 运行的，直接退出进程，launchd 会自动重启
      if (process.env.LAUNCHED_BY_LAUNCHD || fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents/com.screensync.server.plist'))) {
        console.log('   ✅ 检测到 launchd 服务，进程退出后将自动重启');
        process.exit(0); // 正常退出，launchd 会自动重启
      } else {
        // 手动运行的情况，使用 spawn 重启
        console.log('   ✅ 手动重启服务器进程');
        const { spawn } = require('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        process.exit(0);
      }
    }, 2000);
    
    console.log(`   ⏱️  总耗时: ${((Date.now() - Date.now()) / 1000).toFixed(2)}秒`);
  })(); // 结束 updateTask
  
  // 应用总体超时
  try {
    await Promise.race([updateTask, overallTimeout]);
  } catch (error) {
    console.error(`   ❌ 全量更新失败: ${error.message}`);
    console.error('   错误堆栈:', error.stack);
    if (targetGroup && targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
      try {
        sendToFigma(targetGroup, {
          type: 'update-progress',
          status: 'error',
          message: `更新失败: ${error.message}`
        });
      } catch (sendError) {
        console.error('   ❌ 发送错误消息失败:', sendError.message);
      }
    }
  }
}


return { checkAndNotifyUpdates, getCurrentServerVersion, getCurrentPluginVersion, compareVersions, downloadFileWithRedirect, handlePluginUpdate, handleServerUpdate, handleFullUpdate };
};
