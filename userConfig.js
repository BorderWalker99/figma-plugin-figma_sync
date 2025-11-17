// userConfig.js - 用户配置管理
const fs = require('fs');
const path = require('path');
const os = require('os');

// 用户配置文件路径
const USER_CONFIG_FILE = path.join(__dirname, '.user-config.json');

/**
 * 获取用户唯一标识
 * 使用：用户名 + 机器名
 */
function getUserIdentifier() {
  const username = os.userInfo().username;
  const hostname = os.hostname();
  return `${username}@${hostname}`;
}

/**
 * 获取用户文件夹名称
 */
function getUserFolderName() {
  const identifier = getUserIdentifier();
  return `FigmaSync-${identifier}`;
}

/**
 * 读取用户配置
 */
function readUserConfig() {
  try {
    if (fs.existsSync(USER_CONFIG_FILE)) {
      const content = fs.readFileSync(USER_CONFIG_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn('⚠️  读取用户配置失败:', error.message);
  }
  return null;
}

/**
 * 写入用户配置
 */
function writeUserConfig(config) {
  try {
    fs.writeFileSync(USER_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('❌ 写入用户配置失败:', error.message);
    return false;
  }
}

/**
 * 获取或创建用户配置
 */
function getOrCreateUserConfig() {
  let config = readUserConfig();
  
  if (!config) {
    config = {
      userId: getUserIdentifier(),
      folderName: getUserFolderName(),
      userFolderId: null,
      localDownloadFolder: null, // 本地下载文件夹路径，null 表示使用默认值
      createdAt: new Date().toISOString()
    };
    writeUserConfig(config);
  } else {
    // 确保旧配置也有 localDownloadFolder 字段
    if (config.localDownloadFolder === undefined) {
      config.localDownloadFolder = null;
      writeUserConfig(config);
    }
  }
  
  return config;
}

/**
 * 更新用户文件夹ID
 */
function updateUserFolderId(folderId) {
  const config = getOrCreateUserConfig();
  config.userFolderId = folderId;
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

/**
 * 获取用户文件夹ID
 */
function getUserFolderId() {
  const config = getOrCreateUserConfig();
  return config.userFolderId;
}

/**
 * 获取本地下载文件夹路径
 * 如果用户未设置，返回默认路径
 */
function getLocalDownloadFolder() {
  const config = getOrCreateUserConfig();
  if (config.localDownloadFolder && config.localDownloadFolder.trim() !== '') {
    const customPath = config.localDownloadFolder.trim();
    // 验证路径是否有效（父目录必须存在）
    const parentDir = path.dirname(customPath);
    try {
      if (fs.existsSync(parentDir)) {
        return customPath;
      } else {
        console.warn(`⚠️  配置的本地文件夹路径无效（父目录不存在）: ${customPath}`);
        console.warn(`   将使用默认路径: ${path.join(os.homedir(), 'FigmaSyncImg')}`);
      }
    } catch (error) {
      console.warn(`⚠️  验证本地文件夹路径时出错: ${error.message}`);
    }
  }
  // 默认路径：用户主目录下的 FigmaSyncImg
  return path.join(os.homedir(), 'FigmaSyncImg');
}

/**
 * 更新本地下载文件夹路径
 */
function updateLocalDownloadFolder(folderPath) {
  const config = getOrCreateUserConfig();
  config.localDownloadFolder = folderPath;
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

module.exports = {
  getUserIdentifier,
  getUserFolderName,
  getOrCreateUserConfig,
  updateUserFolderId,
  getUserFolderId,
  readUserConfig,
  writeUserConfig,
  getLocalDownloadFolder,
  updateLocalDownloadFolder
};

