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
  return `ScreenSync-${identifier}`;
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
    console.warn('⚠️ 读取用户配置失败:', error.message);
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
      userFolderId: null, // 保留用于向后兼容
      driveFolderId: null, // Google Drive 文件夹 ID
      ossFolderId: null, // 阿里云 OSS 文件夹路径
      localDownloadFolder: null, // 本地下载文件夹路径，null 表示使用默认值
      backupGif: false, // 是否自动备份 GIF 文件到本地（Google Drive 模式）
      keepGifInIcloud: false, // 是否保留 GIF 文件在 iCloud 文件夹中（iCloud 模式）
      createdAt: new Date().toISOString()
    };
    writeUserConfig(config);
  } else {
    // 迁移旧配置：如果只有 userFolderId，根据格式判断是哪个模式
    if (config.userFolderId && !config.driveFolderId && !config.ossFolderId) {
      // 如果 userFolderId 看起来像 Google Drive ID（长字符串，不包含斜杠）
      if (config.userFolderId.length > 20 && !config.userFolderId.includes('/')) {
        config.driveFolderId = config.userFolderId;
        console.log('ℹ️  迁移配置：将 userFolderId 识别为 Google Drive 文件夹 ID');
      } else if (config.userFolderId.includes('/')) {
        // 如果包含斜杠，可能是 OSS 路径
        config.ossFolderId = config.userFolderId;
        console.log('ℹ️  迁移配置：将 userFolderId 识别为阿里云 OSS 文件夹路径');
      }
      writeUserConfig(config);
    }
    
    // 确保所有新字段存在
    if (config.driveFolderId === undefined) {
      config.driveFolderId = null;
      writeUserConfig(config);
    }
    if (config.ossFolderId === undefined) {
      config.ossFolderId = null;
      writeUserConfig(config);
    }
    
    // 确保旧配置也有 localDownloadFolder 字段
    if (config.localDownloadFolder === undefined) {
      config.localDownloadFolder = null;
      writeUserConfig(config);
    }
    
    // 确保旧配置也有 keepGifInIcloud 字段
    if (config.keepGifInIcloud === undefined) {
      config.keepGifInIcloud = false;
      writeUserConfig(config);
    }
  }
  
  return config;
}

/**
 * 更新用户文件夹ID（向后兼容，默认更新 driveFolderId）
 */
function updateUserFolderId(folderId) {
  const config = getOrCreateUserConfig();
  config.userFolderId = folderId; // 保留向后兼容
  // 根据格式判断是哪个模式
  if (folderId && folderId.length > 20 && !folderId.includes('/')) {
    config.driveFolderId = folderId;
  } else if (folderId && folderId.includes('/')) {
    config.ossFolderId = folderId;
  }
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

/**
 * 获取用户文件夹ID（向后兼容，默认返回 driveFolderId）
 */
function getUserFolderId() {
  const config = getOrCreateUserConfig();
  // 优先返回 driveFolderId（向后兼容）
  return config.driveFolderId || config.userFolderId;
}

/**
 * 更新 Google Drive 文件夹ID
 */
function updateDriveFolderId(folderId) {
  const config = getOrCreateUserConfig();
  config.driveFolderId = folderId;
  config.userFolderId = folderId; // 保留向后兼容
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

/**
 * 获取 Google Drive 文件夹ID
 */
function getDriveFolderId() {
  const config = getOrCreateUserConfig();
  return config.driveFolderId || config.userFolderId; // 向后兼容
}

/**
 * 更新阿里云 OSS 文件夹路径
 */
function updateOssFolderId(folderPath) {
  const config = getOrCreateUserConfig();
  config.ossFolderId = folderPath;
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

/**
 * 获取阿里云 OSS 文件夹路径
 */
function getOssFolderId() {
  const config = getOrCreateUserConfig();
  return config.ossFolderId;
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
        console.warn(`   将使用默认路径: ${getDefaultDownloadFolder()}`);
      }
    } catch (error) {
      console.warn(`⚠️  验证本地文件夹路径时出错: ${error.message}`);
    }
  }
  // 返回默认路径
  return getDefaultDownloadFolder();
}

/**
 * 获取默认下载文件夹路径
 * 开发环境：source code 文件夹内的 ScreenSyncImg
 * 生产环境：用户主目录下的 ScreenSyncImg
 */
function getDefaultDownloadFolder() {
  // 检测是否为开发环境（通过检查是否存在 package.json 和 .git）
  const isDevelopment = fs.existsSync(path.join(__dirname, 'package.json')) && 
                        fs.existsSync(path.join(__dirname, '.git'));
  
  if (isDevelopment) {
    // 开发环境：使用 source code 文件夹内的 ScreenSyncImg
    const devPath = path.join(__dirname, 'ScreenSyncImg');
    console.log(`🧪 [开发环境] 使用项目内的下载文件夹: ${devPath}`);
    return devPath;
  } else {
    // 生产环境：用户主目录下的 ScreenSyncImg
    return path.join(os.homedir(), 'ScreenSyncImg');
  }
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

/**
 * 更新 GIF 自动备份设置
 */
function updateBackupGif(enabled) {
  const config = getOrCreateUserConfig();
  config.backupGif = !!enabled;
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

/**
 * 获取 GIF 自动备份设置
 */
function getBackupGif() {
  const config = getOrCreateUserConfig();
  return config.backupGif === true;
}

/**
 * 更新 iCloud GIF 保留设置
 */
function updateKeepGifInIcloud(enabled) {
  const config = getOrCreateUserConfig();
  config.keepGifInIcloud = !!enabled;
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}

/**
 * 获取 iCloud GIF 保留设置
 */
function getKeepGifInIcloud() {
  const config = getOrCreateUserConfig();
  return config.keepGifInIcloud === true;
}

module.exports = {
  getUserIdentifier,
  getUserFolderName,
  getOrCreateUserConfig,
  updateUserFolderId,
  getUserFolderId,
  updateDriveFolderId,
  getDriveFolderId,
  updateOssFolderId,
  getOssFolderId,
  readUserConfig,
  writeUserConfig,
  getLocalDownloadFolder,
  updateLocalDownloadFolder,
  updateBackupGif,
  getBackupGif,
  updateKeepGifInIcloud,
  getKeepGifInIcloud
};

