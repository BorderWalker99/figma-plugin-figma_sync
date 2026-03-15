// userConfig.js - 用户配置管理
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
      backupScreenshots: false, // 是否自动备份普通截图到本地（转换为JPEG）
      backupGif: true, // 是否自动备份 GIF 文件到本地（Google Drive 模式）- 默认开启
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
    
    // 确保旧配置也有 backupScreenshots 字段
    if (config.backupScreenshots === undefined) {
      config.backupScreenshots = false;
      writeUserConfig(config);
    }
    
    // 确保旧配置也有 backupGif 字段，默认开启
    if (config.backupGif === undefined) {
      config.backupGif = true;
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
  const absolutePath = path.resolve(__dirname);
  const isProduction = !absolutePath.includes('SourceCode');

  // 开发环境：强制使用 source code 文件夹内的 ScreenSyncImg，忽略可能存在的旧配置
  if (!isProduction) {
    const devPath = path.join(__dirname, 'ScreenSyncImg');
    console.log(`🔧 [开发环境] 使用固定路径: ${devPath}`);
    return devPath;
  }

  // 生产环境：优先使用用户配置
  const config = getOrCreateUserConfig();
  const defaultPath = getDefaultDownloadFolder();
  
  if (config.localDownloadFolder && config.localDownloadFolder.trim() !== '') {
    const customPath = config.localDownloadFolder.trim();
    
    // ✅ 自动检测项目是否被移动
    // 如果配置的路径包含 ScreenSyncImg 但不在当前项目目录下，说明项目被移动了
    if (customPath.includes('ScreenSyncImg') && !customPath.startsWith(__dirname)) {
      // 检查配置的路径是否还存在
      if (!fs.existsSync(customPath)) {
        console.log(`📂 [自动检测] 项目被移动，自动更新 ScreenSyncImg 路径`);
        console.log(`   旧路径: ${customPath}`);
        console.log(`   新路径: ${defaultPath}`);
        config.localDownloadFolder = defaultPath;
        writeUserConfig(config);
        return defaultPath;
      }
    }
    
    // 验证路径是否有效（父目录必须存在）
    const parentDir = path.dirname(customPath);
    try {
      if (fs.existsSync(parentDir)) {
        return customPath;
      } else {
        console.warn(`⚠️  配置的本地文件夹路径无效（父目录不存在）: ${customPath}`);
        console.warn(`   将使用默认路径: ${defaultPath}`);
        config.localDownloadFolder = defaultPath;
        writeUserConfig(config);
      }
    } catch (error) {
      console.warn(`⚠️  验证本地文件夹路径时出错: ${error.message}`);
    }
  }
  // 返回默认路径
  return defaultPath;
}

/**
 * 获取默认下载文件夹路径
 * 开发环境：source code 文件夹内的 ScreenSyncImg
 * 生产环境：用户主目录下的 ScreenSyncImg
 */
function getDefaultDownloadFolder() {
  // 无论开发还是生产环境，都使用当前包内的 ScreenSyncImg 文件夹
  // 开发环境：source code/ScreenSyncImg
  // 生产环境：User-package/ScreenSyncImg
  return path.join(__dirname, 'ScreenSyncImg');
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
 * 获取备份模式
 * @returns {string} 'gif_only' | 'all'
 */
function getBackupMode() {
  const config = getOrCreateUserConfig();
  if (config.backupMode === 'gif_only' || config.backupMode === 'all') {
    return config.backupMode;
  }
  // 向后兼容：如果启用了截图备份，则默认为'all'；否则默认为 'gif_only'
  if (config.backupScreenshots) {
    return 'all';
  }
  return 'gif_only';
}

/**
 * 更新备份模式
 * @param {string} mode 'gif_only' | 'all'
 */
function updateBackupMode(mode) {
  const config = getOrCreateUserConfig();
  if (['gif_only', 'all'].includes(mode)) {
    config.backupMode = mode;
    // 更新旧字段以保持向后兼容
    config.backupScreenshots = (mode === 'all');
    config.updatedAt = new Date().toISOString();
    writeUserConfig(config);
  }
  return config;
}

/**
 * 获取截图备份设置
 */
function getBackupScreenshots() {
  // 截图仅在 'all' 模式下备份
  return getBackupMode() === 'all';
}

/**
 * 更新截图备份设置（兼容旧接口）
 */
function updateBackupScreenshots(enabled) {
  return updateBackupMode(enabled ? 'all' : 'gif_only');
}

/**
 * 获取 GIF 备份设置
 */
function getBackupGif() {
  // GIF 在 'gif_only' 或 'all' 模式下备份
  const mode = getBackupMode();
  return mode === 'gif_only' || mode === 'all';
}


/**
 * 更新 GIF 备份设置
 */
function updateBackupGif(enabled) {
  const config = getOrCreateUserConfig();
  config.backupGif = !!enabled;
  config.updatedAt = new Date().toISOString();
  writeUserConfig(config);
  return config;
}


// ============================================
// GIF 缓存管理（用于导出带标注的 GIF 功能）
// ============================================

/**
 * 获取 GIF 缓存目录路径
 * 独立于用户的"保留在文件夹"设置
 */
function getGifCachePath() {
  const isProduction = !__dirname.includes('SourceCode');
  
  if (isProduction) {
    // 生产环境：用户目录下的隐藏文件夹
    return path.join(os.homedir(), '.screensync-gif-cache');
  } else {
    // 开发环境：项目目录下
    return path.join(__dirname, '.gif-cache');
  }
}

/**
 * 确保 GIF 缓存目录存在
 */
function ensureGifCacheDir() {
  const cachePath = getGifCachePath();
  if (!fs.existsSync(cachePath)) {
    try {
      fs.mkdirSync(cachePath, { recursive: true });
      console.log(`✅ [GIF Cache] 创建缓存目录: ${cachePath}`);
    } catch (error) {
      console.error(`❌ [GIF Cache] 创建缓存目录失败:`, error.message);
      return null;
    }
  }
  return cachePath;
}

/**
 * 生成文件的唯一缓存 ID
 * 使用文件名 + Drive ID + 时间戳的哈希值
 */
function generateCacheId(filename, driveFileId, timestamp) {
  const data = `${filename}-${driveFileId || ''}-${timestamp || Date.now()}`;
  return crypto.createHash('md5').update(data).digest('hex');
}

function writeGifCacheMetadata(cachePath, cacheId, originalFilename, driveFileId, size, ext) {
  const metaPath = path.join(cachePath, `${cacheId}.meta.json`);
  const metadata = {
    cacheId,
    originalFilename,
    driveFileId,
    timestamp: Date.now(),
    size,
    ext
  };
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
}

/**
 * 保存 GIF 到缓存目录
 * @param {Buffer} buffer - 文件 buffer
 * @param {string} originalFilename - 原始文件名
 * @param {string} driveFileId - Drive 文件 ID
 * @returns {object|null} - { cacheId, cachePath, originalFilename }
 */
function saveGifToCache(buffer, originalFilename, driveFileId) {
  try {
    const cachePath = ensureGifCacheDir();
    if (!cachePath) return null;
    
    const cacheId = generateCacheId(originalFilename, driveFileId, Date.now());
    const ext = path.extname(originalFilename) || '.gif';
    const cacheFilename = `${cacheId}${ext}`;
    const cacheFilePath = path.join(cachePath, cacheFilename);
    
    // 保存文件
    fs.writeFileSync(cacheFilePath, buffer);
    
    writeGifCacheMetadata(cachePath, cacheId, originalFilename, driveFileId, buffer.length, ext);
    
    console.log(`✅ [GIF Cache] 已缓存: ${originalFilename} → ${cacheId}${ext} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    
    return {
      cacheId,
      cachePath: cacheFilePath,
      originalFilename
    };
  } catch (error) {
    console.error(`❌ [GIF Cache] 保存失败:`, error.message);
    return null;
  }
}

/**
 * 直接从现有文件复制到缓存目录，避免先整文件读入 Buffer。
 * @param {string} sourcePath - 源文件路径
 * @param {string} originalFilename - 原始文件名
 * @param {string} driveFileId - Drive 文件 ID
 * @returns {object|null} - { cacheId, cachePath, originalFilename }
 */
function saveGifFileToCache(sourcePath, originalFilename, driveFileId) {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error('源文件不存在');
    }
    const cachePath = ensureGifCacheDir();
    if (!cachePath) return null;

    const cacheId = generateCacheId(originalFilename, driveFileId, Date.now());
    const ext = path.extname(originalFilename) || path.extname(sourcePath) || '.gif';
    const cacheFilename = `${cacheId}${ext}`;
    const cacheFilePath = path.join(cachePath, cacheFilename);
    fs.copyFileSync(sourcePath, cacheFilePath);
    const size = fs.statSync(cacheFilePath).size;
    writeGifCacheMetadata(cachePath, cacheId, originalFilename, driveFileId, size, ext);

    console.log(`✅ [GIF Cache] 已按文件缓存: ${originalFilename} → ${cacheId}${ext} (${(size / 1024 / 1024).toFixed(2)} MB)`);
    return {
      cacheId,
      cachePath: cacheFilePath,
      originalFilename
    };
  } catch (error) {
    console.error(`❌ [GIF Cache] 文件缓存失败:`, error.message);
    return null;
  }
}

/**
 * 从缓存中获取 GIF 文件
 * 尝试多种方式查找：完整文件名、去扩展名、cacheId
 */
function getGifFromCache(originalFilename, cacheId) {
  try {
    const cachePath = getGifCachePath();
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    
    // 方法 1：如果有 cacheId，直接查找
    if (cacheId) {
      const files = fs.readdirSync(cachePath);
      const cacheFile = files.find(f => f.startsWith(cacheId) && !f.endsWith('.meta.json'));
      if (cacheFile) {
        const filePath = path.join(cachePath, cacheFile);
        console.log(`✅ [GIF Cache] 通过 cacheId 找到: ${cacheFile}`);
        return {
          path: filePath,
          buffer: fs.readFileSync(filePath)
        };
      }
    }
    
    // 方法 2：通过原始文件名查找元数据
    if (originalFilename) {
      const metaFiles = fs.readdirSync(cachePath).filter(f => f.endsWith('.meta.json'));
      
      for (const metaFile of metaFiles) {
        try {
          const metaPath = path.join(cachePath, metaFile);
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          
          // 文件名匹配（完整或去扩展名）
          const filenameMatch = metadata.originalFilename === originalFilename ||
                               path.parse(metadata.originalFilename).name === path.parse(originalFilename).name;
          
          if (filenameMatch) {
            const cacheFilePath = path.join(cachePath, `${metadata.cacheId}${metadata.ext}`);
            if (fs.existsSync(cacheFilePath)) {
              console.log(`✅ [GIF Cache] 通过文件名找到: ${originalFilename} → ${metadata.cacheId}${metadata.ext}`);
              return {
                path: cacheFilePath,
                buffer: fs.readFileSync(cacheFilePath),
                metadata
              };
            }
          }
        } catch (e) {
          // 跳过损坏的元数据文件
          continue;
        }
      }
    }
    
    console.log(`⚠️  [GIF Cache] 未找到缓存: ${originalFilename || cacheId}`);
    return null;
  } catch (error) {
    console.error(`❌ [GIF Cache] 查找失败:`, error.message);
    return null;
  }
}

/**
 * 清理超过指定天数的缓存文件
 * @param {number} days - 天数，默认 30 天
 */
function cleanOldGifCache(days = 30) {
  try {
    const cachePath = getGifCachePath();
    if (!fs.existsSync(cachePath)) {
      return { cleaned: 0, size: 0 };
    }
    
    const now = Date.now();
    const maxAge = days * 24 * 60 * 60 * 1000; // 天数转毫秒
    
    const allFiles = fs.readdirSync(cachePath);
    const metaFiles = allFiles.filter(f => f.endsWith('.meta.json'));
    let cleanedCount = 0;
    let cleanedSize = 0;
    
    // 记录所有 meta 文件引用的缓存文件名（用于孤儿检测）
    const referencedFiles = new Set();
    
    for (const metaFile of metaFiles) {
      try {
        const metaPath = path.join(cachePath, metaFile);
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const cacheFileName = `${metadata.cacheId}${metadata.ext}`;
        referencedFiles.add(metaFile); // meta 自身
        referencedFiles.add(cacheFileName); // 对应的缓存文件
        
        // 检查文件年龄
        const age = now - metadata.timestamp;
        if (age > maxAge) {
          const cacheFilePath = path.join(cachePath, cacheFileName);
          
          // 删除缓存文件
          if (fs.existsSync(cacheFilePath)) {
            const stats = fs.statSync(cacheFilePath);
            fs.unlinkSync(cacheFilePath);
            cleanedSize += stats.size;
            cleanedCount++;
          }
          
          // 删除元数据文件
          fs.unlinkSync(metaPath);
          referencedFiles.delete(metaFile);
          referencedFiles.delete(cacheFileName);
          
          console.log(`🧹 [GIF Cache] 已清理: ${metadata.originalFilename} (${Math.floor(age / 1000 / 60 / 60 / 24)} 天前)`);
        }
      } catch (e) {
        // 损坏的 meta 文件：直接删除
        try {
          const metaPath = path.join(cachePath, metaFile);
          fs.unlinkSync(metaPath);
          cleanedCount++;
          console.log(`🧹 [GIF Cache] 已清理损坏的元数据: ${metaFile}`);
        } catch (e2) {}
        continue;
      }
    }
    
    // 清理孤儿文件：缓存目录中存在但没有对应 meta.json 引用的文件
    // 这些文件可能是 meta.json 被删除/损坏后遗留的大文件
    for (const file of allFiles) {
      if (file.startsWith('.')) continue; // 跳过隐藏文件
      if (referencedFiles.has(file)) continue; // 有对应 meta，跳过
      if (file.endsWith('.meta.json')) continue; // 已处理过的 meta
      
      // 这是一个孤儿文件（没有 meta 引用）
      const orphanPath = path.join(cachePath, file);
      try {
        const stats = fs.statSync(orphanPath);
        // 只清理超过 maxAge 的孤儿文件（通过文件修改时间判断）
        if ((now - stats.mtimeMs) > maxAge) {
          fs.unlinkSync(orphanPath);
          cleanedSize += stats.size;
          cleanedCount++;
          console.log(`🧹 [GIF Cache] 已清理孤儿文件: ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        }
      } catch (e) {}
    }
    
    if (cleanedCount > 0) {
      console.log(`✅ [GIF Cache] 清理完成: ${cleanedCount} 个文件, ${(cleanedSize / 1024 / 1024).toFixed(2)} MB`);
    }
    
    return { cleaned: cleanedCount, size: cleanedSize };
  } catch (error) {
    console.error(`❌ [GIF Cache] 清理失败:`, error.message);
    return { cleaned: 0, size: 0 };
  }
}

/**
 * 获取缓存统计信息
 */
function getGifCacheStats() {
  try {
    const cachePath = getGifCachePath();
    if (!fs.existsSync(cachePath)) {
      return { count: 0, size: 0, oldestDays: 0 };
    }
    
    const metaFiles = fs.readdirSync(cachePath).filter(f => f.endsWith('.meta.json'));
    let totalSize = 0;
    let oldestTimestamp = Date.now();
    
    for (const metaFile of metaFiles) {
      try {
        const metaPath = path.join(cachePath, metaFile);
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        
        const cacheFilePath = path.join(cachePath, `${metadata.cacheId}${metadata.ext}`);
        if (fs.existsSync(cacheFilePath)) {
          const stats = fs.statSync(cacheFilePath);
          totalSize += stats.size;
          
          if (metadata.timestamp < oldestTimestamp) {
            oldestTimestamp = metadata.timestamp;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    const oldestDays = Math.floor((Date.now() - oldestTimestamp) / 1000 / 60 / 60 / 24);
    
    return {
      count: metaFiles.length,
      size: totalSize,
      sizeMB: (totalSize / 1024 / 1024).toFixed(2),
      oldestDays
    };
  } catch (error) {
    console.error(`❌ [GIF Cache] 获取统计失败:`, error.message);
    return { count: 0, size: 0, sizeMB: '0.00', oldestDays: 0 };
  }
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
  // 备份设置
  getBackupScreenshots,
  updateBackupScreenshots,
  getBackupGif,
  updateBackupGif,
  getBackupMode,
  updateBackupMode,
  // GIF 缓存管理
  getGifCachePath,
  saveGifToCache,
  saveGifFileToCache,
  getGifFromCache,
  cleanOldGifCache,
  getGifCacheStats
};

