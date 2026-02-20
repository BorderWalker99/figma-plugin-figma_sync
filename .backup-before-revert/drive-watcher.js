require('dotenv').config();
const WebSocket = require('ws');
const sharp = require('sharp');

// 优化 sharp 配置，减少内存占用并提高稳定性（特别是在 LaunchAgent 环境下）
sharp.cache(false); // 禁用缓存
sharp.simd(false); // 禁用 SIMD
sharp.concurrency(1); // 限制并发

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  listFolderFiles,
  downloadFileBuffer,
  trashFile,
  createFolder,
  getFileInfo
} = require('./googleDrive');

const userConfig = require('./userConfig');

const {
  getUserIdentifier,
  getUserFolderName,
  getOrCreateUserConfig,
  updateDriveFolderId,
  getDriveFolderId,
  getLocalDownloadFolder
} = require('./userConfig');

/**
 * 确保本地下载文件夹存在
 */
function ensureLocalDownloadFolder() {
  try {
    const folderPath = getLocalDownloadFolder();
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      console.log(`📁 已创建本地下载文件夹: ${folderPath}`);
    }
    return folderPath;
  } catch (error) {
    console.error(`❌ 创建本地下载文件夹失败: ${error.message}`);
    return null;
  }
}

/**
 * 保存文件名到 cacheId 的映射（带容量限制，防止无限增长）
 * @param {string} fileName - 文件名
 * @param {string} cacheId - 缓存ID
 */
const CACHE_MAPPING_MAX_ENTRIES = 500; // 最多保留 500 条映射
function saveCacheMapping(fileName, cacheId) {
  try {
    const mappingFile = path.join(getLocalDownloadFolder(), '.cache-mapping.json');
    let mapping = {};
    if (fs.existsSync(mappingFile)) {
      try {
        mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
      } catch (e) {
        console.warn(`   ⚠️  读取映射文件失败，将创建新文件`);
      }
    }
    mapping[fileName] = cacheId;
    
    // 超出容量上限时，删除最早的条目（对象键的插入顺序）
    const keys = Object.keys(mapping);
    if (keys.length > CACHE_MAPPING_MAX_ENTRIES) {
      const excess = keys.length - CACHE_MAPPING_MAX_ENTRIES;
      for (let i = 0; i < excess; i++) {
        delete mapping[keys[i]];
      }
    }
    
    fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
    console.log(`   💾 [映射] 已保存文件名映射: ${fileName} -> ${cacheId} (共 ${Object.keys(mapping).length} 条)`);
  } catch (mappingError) {
    console.error(`   ⚠️  保存映射文件失败:`, mappingError.message);
  }
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
function getExtensionFromMimeType(mimeType) {
  if (!mimeType) return '';
  
  const mimeToExt = {
    // 图片格式
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    // 视频格式
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-m4v': '.m4v',
    'video/avi': '.avi',
    'video/mov': '.mov',
  };
  
  const ext = mimeToExt[mimeType.toLowerCase()];
  return ext || '';
}

/**
 * 清理文件名，移除或替换不安全的字符
 */
function sanitizeFilename(filename, mimeType) {
  // 提取文件扩展名
  let ext = path.extname(filename);
  
  // 对于视频文件，优先使用 MIME 类型来确定扩展名，因为 MIME 类型更可靠
  // 特别是 video/quicktime 应该使用 .mov 扩展名
  if (mimeType && mimeType.toLowerCase().startsWith('video/')) {
    const mimeExt = getExtensionFromMimeType(mimeType);
    if (mimeExt) {
      ext = mimeExt; // 使用 MIME 类型确定的扩展名
    }
  } else if (!ext && mimeType) {
    // 对于非视频文件，如果没有扩展名，尝试从 MIME 类型获取
    ext = getExtensionFromMimeType(mimeType);
  }
  
  // 获取不带扩展名的文件名（使用原始扩展名，不是可能从 MIME 类型获取的）
  const originalExt = path.extname(filename);
  const nameWithoutExt = path.basename(filename, originalExt);
  
  // 替换不安全的字符：
  // - / 和 \ 替换为 - (路径分隔符，会导致创建子目录)
  // - : 替换为 - (macOS 不允许文件名包含冒号)
  // - 其他控制字符和特殊字符也替换为 -
  const sanitized = nameWithoutExt
    .replace(/[/\\]/g, '-')  // 替换路径分隔符为连字符
    .replace(/:/g, '-')  // 替换冒号为连字符（macOS 不允许）
    .replace(/[<>"|?*\x00-\x1f]/g, '-')  // 替换其他不安全字符
    .replace(/-+/g, '-')  // 将多个连字符合并为单个
    .replace(/^-+|-+$/g, '');  // 移除开头和结尾的连字符
  
  // 如果清理后的文件名为空，使用默认名称
  const finalName = sanitized || 'untitled';
  
  return finalName + ext;
}

/**
 * 获取文件夹中的下一个序号（填补空缺）
 */
function getNextSequenceNumber(folderPath, prefix, extensions) {
  if (!fs.existsSync(folderPath)) {
    return 1;
  }
  
  const files = fs.readdirSync(folderPath);
  const existingNumbers = new Set();
  
  files.forEach(file => {
    const ext = path.extname(file).toLowerCase();
    if (extensions.includes(ext)) {
      // 匹配格式：prefix_数字.ext
      const nameWithoutExt = path.basename(file, ext);
      const match = nameWithoutExt.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (match) {
        const num = parseInt(match[1], 10);
        existingNumbers.add(num);
      }
    }
  });
  
  // 如果没有文件，返回 1
  if (existingNumbers.size === 0) {
    return 1;
  }
  
  // 找到最大编号
  const maxNumber = Math.max(...existingNumbers);
  
  // 从 1 开始查找第一个空缺的编号
  for (let i = 1; i <= maxNumber; i++) {
    if (!existingNumbers.has(i)) {
      return i; // 返回第一个空缺的编号
    }
  }
  
  // 如果没有空缺，返回 maxNumber + 1
  return maxNumber + 1;
}

/**
 * 将文件保存到本地文件夹
 */
async function saveFileToLocalFolder(buffer, filename, mimeType, isExportedGif = false) {
  try {
    console.log(`   💾 [Local] 准备保存文件: ${filename}, 大小: ${buffer ? buffer.length : 0} 字节`);
    
    if (!buffer || buffer.length === 0) {
      console.error(`   ❌ [Local] Buffer 为空，无法保存`);
      return { success: false, isNew: false };
    }

    const folderPath = ensureLocalDownloadFolder();
    if (!folderPath) {
      console.error(`   ❌ [Local] 无法获取/创建本地文件夹路径`);
      return { success: false, isNew: false };
    }
    console.log(`   📂 [Local] 目标文件夹: ${folderPath}`);
    
    // 清理文件名，移除不安全字符，并根据 MIME 类型添加扩展名
    const safeFilename = sanitizeFilename(filename, mimeType);
    const ext = path.extname(safeFilename).toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov' || (mimeType && mimeType.startsWith('video/'));
    const isGif = ext === '.gif' || (mimeType && mimeType === 'image/gif');
    
    // 确定子文件夹和文件前缀
    let subfolderName, filePrefix, extensions;
    
    if (isExportedGif) {
      // 导出的GIF
      subfolderName = 'GIF-导出';
      filePrefix = 'ScreenRecordingGIF';  // 修改：统一命名格式
      extensions = ['.gif'];
    } else if (isVideo) {
      // 视频
      subfolderName = '视频';
      filePrefix = 'ScreenRecordingVid';  // 修改：统一命名格式
      extensions = ['.mp4', '.mov'];
    } else if (isGif) {
      // GIF
      subfolderName = 'GIF';
      filePrefix = 'ScreenRecordingGIF';  // 修改：统一命名格式
      extensions = ['.gif'];
    } else {
      // 图片（截图）
      subfolderName = '图片';
      filePrefix = 'ScreenShot';  // 修改：统一命名格式
      extensions = ['.jpg', '.jpeg', '.png'];
    }
    
    const subfolderPath = path.join(folderPath, subfolderName);
    if (!fs.existsSync(subfolderPath)) {
      fs.mkdirSync(subfolderPath, { recursive: true });
    }
    
    // 获取下一个序号
    const sequenceNumber = getNextSequenceNumber(subfolderPath, filePrefix, extensions);
    const paddedNumber = sequenceNumber.toString().padStart(3, '0');
    const newFilename = `${filePrefix}_${paddedNumber}${ext}`;
    const finalPath = path.join(subfolderPath, newFilename);
    
    console.log(`   📝 [Local] 新文件名: ${newFilename} (序号: ${paddedNumber})`);
    
    // 确保目录存在
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 写入文件
    fs.writeFileSync(finalPath, buffer, { flag: 'w' });
    console.log(`   ✅ [Local] 文件已成功写入: ${finalPath}`);
    return { success: true, isNew: true, filename: newFilename };
  } catch (error) {
    console.error(`   ❌ [Local] 保存文件到本地失败: ${error.message}`);
    return { success: false, isNew: false };
  }
}


// 共享驱动器根文件夹ID（从环境变量读取，如果没有则使用 serviceAccountKey.js 中的默认值）
let SHARED_DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 如果环境变量未设置或为空字符串，尝试从 serviceAccountKey.js 读取默认值
if (!SHARED_DRIVE_FOLDER_ID || SHARED_DRIVE_FOLDER_ID.trim() === '') {
  try {
    const serviceAccountKey = require('./serviceAccountKey');
    if (serviceAccountKey && serviceAccountKey.defaultFolderId && serviceAccountKey.defaultFolderId.trim() !== '') {
      SHARED_DRIVE_FOLDER_ID = serviceAccountKey.defaultFolderId;
      console.log('ℹ️  使用默认的 Google Drive 根文件夹ID（从 serviceAccountKey.js）');
    }
  } catch (error) {
    // 忽略错误，继续使用环境变量
  }
}

const CONFIG = {
  wsUrl: process.env.WS_URL || 'ws://localhost:8888',
  connectionId: process.env.CONNECTION_ID || 'sync-session-1',
  sharedDriveFolderId: SHARED_DRIVE_FOLDER_ID,
  userFolderId: null, // 将在初始化时设置
  pollIntervalMs: Number(process.env.DRIVE_POLL_INTERVAL_MS || 2000), // 默认2秒轮询，更快检测新文件
  maxWidth: Number(process.env.DRIVE_MAX_WIDTH || 1920),
  quality: Number(process.env.DRIVE_IMAGE_QUALITY || 85),
  processExisting: process.env.DRIVE_PROCESS_EXISTING === '1',
  autoDelete: process.env.DRIVE_AUTO_DELETE !== '0',
  get backupScreenshots() {
    return userConfig.getBackupScreenshots();
  },
  get backupGif() {
    return userConfig.getBackupGif();
  }
};

// 更严格的验证：检查是否为空字符串或无效值
if (!CONFIG.sharedDriveFolderId || CONFIG.sharedDriveFolderId.trim() === '' || CONFIG.sharedDriveFolderId === '.') {
  console.error('❌ 未配置 GDRIVE_FOLDER_ID（共享驱动器根文件夹ID），无法启动 drive-watcher');
  console.error('   请设置环境变量 GDRIVE_FOLDER_ID 或确保 serviceAccountKey.js 中包含有效的 defaultFolderId');
  process.exit(1);
}

/**
 * 初始化用户文件夹
 * 如果用户文件夹不存在，则创建
 */
async function initializeUserFolder() {
  try {
    const userFolderName = getUserFolderName();
    const expectedUserId = getUserIdentifier();
    
    console.log(`\n🔍 [Drive] 初始化用户文件夹检查`);
    console.log(`   👤 用户ID: ${expectedUserId}`);
    console.log(`   📁 期望文件夹名称: ${userFolderName}`);
    console.log(`   📂 共享驱动器ID: ${CONFIG.sharedDriveFolderId}`);
    
    // 先检查配置文件中是否有用户文件夹ID
    let userFolderId = getDriveFolderId();
    
    if (userFolderId) {
      console.log(`   📋 配置文件中的文件夹ID: ${userFolderId}`);
      
      // 验证文件夹是否存在，并且名称正确
      try {
        // 获取文件夹详细信息
        const folderInfo = await getFileInfo(userFolderId);
        
        console.log(`   📂 文件夹名称: ${folderInfo.name}`);
        console.log(`   📂 文件夹类型: ${folderInfo.mimeType}`);
        console.log(`   📂 文件夹链接: ${folderInfo.webViewLink || 'N/A'}`);
        
        // 验证文件夹名称是否匹配
        if (folderInfo.name !== userFolderName) {
          console.log(`   ⚠️  文件夹名称不匹配！`);
          console.log(`      期望: ${userFolderName}`);
          console.log(`      实际: ${folderInfo.name}`);
          console.log(`   🔄 将重新创建正确的用户文件夹`);
          userFolderId = null;
        } else if (folderInfo.mimeType !== 'application/vnd.google-apps.folder') {
          console.log(`   ⚠️  ID指向的不是文件夹！`);
          console.log(`   🔄 将重新创建用户文件夹`);
          userFolderId = null;
        } else {
          // 验证文件夹是否可以访问
          await listFolderFiles({ folderId: userFolderId, pageSize: 1 });
          console.log(`   ✅ 配置文件中的文件夹ID有效且名称正确`);
          console.log(`   📂 使用现有用户文件夹: ${userFolderId}`);
          CONFIG.userFolderId = userFolderId;
          return userFolderId;
        }
      } catch (error) {
        console.log(`   ⚠️  配置文件中的文件夹ID无效: ${error.message}`);
        console.log(`   🔄 将重新创建用户文件夹`);
        userFolderId = null;
      }
    } else {
      console.log(`   ℹ️  配置文件中没有用户文件夹ID`);
    }
    
    // 创建用户文件夹（如果不存在）
    console.log(`\n📁 [Drive] 正在创建/查找用户专属文件夹: ${userFolderName}`);
    
    // 再次验证 sharedDriveFolderId 是否有效
    if (!CONFIG.sharedDriveFolderId || CONFIG.sharedDriveFolderId.trim() === '' || CONFIG.sharedDriveFolderId === '.') {
      throw new Error(`无效的共享驱动器根文件夹ID: "${CONFIG.sharedDriveFolderId}"。请检查 GDRIVE_FOLDER_ID 环境变量或 serviceAccountKey.js 中的 defaultFolderId`);
    }
    
    console.log(`   🔍 正在检查文件夹是否已存在...`);
    let folder;
    try {
      folder = await createFolder({
        folderName: userFolderName,
        parentFolderId: CONFIG.sharedDriveFolderId
      });
      console.log(`   ✅ 文件夹操作成功`);
    } catch (error) {
      console.error(`   ❌ 创建/查找文件夹失败: ${error.message}`);
      console.error(`   错误详情:`, error);
      
      // 提供更详细的错误信息
      if (error.message.includes('File not found')) {
        throw new Error(`无法访问共享驱动器根文件夹 (ID: ${CONFIG.sharedDriveFolderId})。可能原因：\n   1. Service Account 没有访问权限\n   2. 文件夹ID不正确\n   3. 共享驱动器未正确配置`);
      } else if (error.message.includes('Permission')) {
        throw new Error(`Service Account 没有在共享驱动器中创建文件夹的权限。请检查：\n   1. Service Account 是否已添加到共享驱动器\n   2. Service Account 是否有"内容管理员"或"编辑者"权限`);
      } else {
        throw error;
      }
    }
    
    userFolderId = folder.id;
    
    // 验证返回的文件夹ID
    if (!userFolderId) {
      throw new Error('创建文件夹后未返回文件夹ID');
    }
    
    console.log(`   ✅ 用户文件夹ID: ${userFolderId}`);
    console.log(`   📂 文件夹链接: ${folder.webViewLink || 'N/A'}`);
    
    // 保存到配置文件
    updateDriveFolderId(userFolderId);
    CONFIG.userFolderId = userFolderId;
    
    // 再次验证文件夹ID是否正确
    try {
      const { files } = await listFolderFiles({ folderId: userFolderId, pageSize: 1 });
      console.log(`   ✅ 验证成功：文件夹存在，包含 ${files.length} 个文件`);
    } catch (error) {
      console.error(`   ⚠️  验证失败：无法访问文件夹: ${error.message}`);
      throw new Error(`用户文件夹ID验证失败: ${error.message}`);
    }
    
    console.log(`\n✅ [Drive] 用户文件夹初始化完成`);
    console.log(`   📂 用户专属文件夹ID: ${CONFIG.userFolderId}`);
    console.log(`   📁 用户专属文件夹名称: ${userFolderName}`);
    console.log(`   📂 共享驱动器根文件夹ID: ${CONFIG.sharedDriveFolderId} (仅用于创建子文件夹)`);
    console.log(`   ⚠️  重要：将监听用户专属文件夹，不会监听共享文件夹根目录\n`);
    
    return userFolderId;
  } catch (error) {
    console.error('❌ 初始化用户文件夹失败:', error.message);
    console.error('   错误堆栈:', error.stack);
    throw error;
  }
}

let ws = null;
let pollTimer = null;
let isRealTimeMode = false;
let wasRealTimeMode = false; // 记录断开前是否是实时模式，用于重连后恢复
let isPolling = false;
let lastPollTime = null;
let realTimeStart = null;
let isSyncing = false; // 防止重复触发手动同步

const knownFileIds = new Set();
const knownFileMD5s = new Map(); // md5Checksum -> { fileId, filename, createdTime } - 用于去重
const pendingDeletes = new Map(); // fileId -> { filename, timestamp }
const MAX_KNOWN_FILES = 10000; // 限制已知文件数量，防止内存无限增长

// 安全的 WebSocket 消息发送函数，防止发送失败导致崩溃
function safeSend(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('⚠️  WebSocket 未连接，无法发送消息');
    return false;
  }
  
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error('❌ 发送 WebSocket 消息失败:', error.message);
    return false;
  }
}

// 清理文件的所有记录（从knownFileIds和knownFileMD5s中移除）
function cleanupFileRecord(fileId, md5Checksum = null) {
  // 从knownFileIds中移除
  if (knownFileIds.has(fileId)) {
    knownFileIds.delete(fileId);
  }
  
  // 从knownFileMD5s中移除（如果提供了MD5）
  if (md5Checksum && knownFileMD5s.has(md5Checksum)) {
    const record = knownFileMD5s.get(md5Checksum);
    // 只有当记录的fileId匹配时才删除（防止误删新文件的记录）
    if (record.fileId === fileId) {
      knownFileMD5s.delete(md5Checksum);
    }
  } else if (!md5Checksum) {
    // 如果没有提供MD5，尝试从knownFileMD5s中找到并删除
    for (const [md5, record] of knownFileMD5s.entries()) {
      if (record.fileId === fileId) {
        knownFileMD5s.delete(md5);
        break;
      }
    }
  }
}
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 每5分钟清理一次

async function initializeKnownFiles() {
  if (!CONFIG.userFolderId) {
    throw new Error('用户文件夹未初始化');
  }
  
  // 初始化时间基准
  realTimeStart = new Date();
  // 查询时间回退1分钟，作为缓冲
  const queryStart = new Date(realTimeStart.getTime() - 60000);
  lastPollTime = queryStart.toISOString();
  
  console.log(`🕒 [Drive] 实时模式启动时间: ${realTimeStart.toISOString()}`);
  console.log(`   (查询起始时间: ${lastPollTime})`);
  
  // 清空已知文件列表
  knownFileIds.clear();
  
  console.log('📂 [Drive] 正在扫描现有文件，标记为"已知"...');
  
  try {
    // 获取所有现有的图片文件
    const { files } = await listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 500, // 增大页面大小以获取更多文件
      orderBy: 'createdTime desc' // 按创建时间倒序
    });
    
    // 过滤图片和视频文件，并标记为已知
    const imageFiles = files.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
     // 将所有现有文件标记为"已知"，并记录MD5用于去重
     for (const file of imageFiles) {
       knownFileIds.add(file.id);
       // 记录MD5以便去重（如果文件有MD5）
       if (file.md5Checksum) {
         knownFileMD5s.set(file.md5Checksum, {
           fileId: file.id,
           filename: file.name,
           createdTime: file.createdTime
         });
       }
     }
     
     console.log(`✅ [Drive] 已标记 ${knownFileIds.size} 个现有文件为"已知"，实时模式将只处理新文件`);
     console.log(`   📋 已记录 ${knownFileMD5s.size} 个文件的MD5指纹，用于去重检测`);
     console.log('ℹ️  启动后上传的文件将自动同步到 Figma');

     // 通知用户已存在的现有文件数量，提示使用手动同步
     if (knownFileIds.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
       safeSend({
         type: 'toast',
         message: `实时模式已启动 (忽略 ${knownFileIds.size} 个现有文件，如需同步请使用"手动同步")`,
         duration: 5000,
         level: 'info'
       });
     }
  } catch (error) {
    console.warn(`⚠️  扫描现有文件时出错: ${error.message}`);
    console.warn('   将继续启动实时模式，但可能会同步一些旧文件');
  }
}

async function pollDrive() {
  if (!isRealTimeMode) {
    // 静默跳过，不打印日志（避免日志刷屏）
    return;
  }
  if (isPolling) {
    console.log('⏳ [Drive] 上次轮询尚未结束，跳过本次轮询');
    return;
  }
  if (!CONFIG.userFolderId) {
    console.error('❌ 用户文件夹未初始化，跳过轮询');
    return;
  }

  isPolling = true;
  const pollStart = new Date();
  console.log(`\n🔍 [Drive] 开始轮询 (${pollStart.toLocaleTimeString()})`);

  try {
    // 构造增量查询条件
    const customQuery = lastPollTime ? `createdTime > '${lastPollTime}'` : null;
    
    // 只获取一页（增量模式下通常文件很少）
      const result = await listFolderFiles({ 
        folderId: CONFIG.userFolderId, 
      pageSize: 100, 
      orderBy: 'createdTime asc', // 按创建时间正序，先处理旧的
      customQuery
    });
    
    const allFiles = result.files || [];
    
    // 过滤图片和视频文件
    const imageFiles = allFiles.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      // 忽略 _exported 结尾的文件（这是服务器自己生成的导出 GIF）
      // 移除末尾的点检查，以兼容 "xxx_exported 2.gif" 这种冲突重命名的情况
      if (name.toLowerCase().includes('_exported')) {
        // console.log(`🙈 [Drive] 忽略已导出的 GIF: ${name}`); // 可选日志
        return false;
      }

      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    const newFiles = [];
    for (const file of imageFiles) {
      // 1. 去重
      if (knownFileIds.has(file.id)) {
        console.log(`   ⏭️  跳过已知文件: ${file.name}`);
        continue;
      }
      
      // 2. 严格时间过滤（只处理启动后创建的文件）
      const fileTime = new Date(file.createdTime);
      if (realTimeStart && fileTime < realTimeStart) {
        console.log(`   ⏭️  跳过旧文件: ${file.name} (创建于 ${fileTime.toLocaleString()})`);
        knownFileIds.add(file.id); // 标记为已知，下次不再处理
        continue;
      }
      
      // 3. ✅ MD5去重检测：只查重当前云端存在的文件
      if (file.md5Checksum && knownFileMD5s.has(file.md5Checksum)) {
        const existingFile = knownFileMD5s.get(file.md5Checksum);
        
        // 检查已存在的文件是否还在云端（通过检查knownFileIds）
        if (knownFileIds.has(existingFile.fileId)) {
          // 文件仍在云端，确实是重复文件
          console.log(`   🔄 检测到重复文件: ${file.name} (MD5: ${file.md5Checksum.substring(0, 8)}...)`);
          console.log(`   💡 已存在相同内容的文件: ${existingFile.filename} (${new Date(existingFile.createdTime).toLocaleString()})`);
          console.log(`   🗑️  正在删除重复文件: ${file.name}`);
          
          try {
            await trashFile(file.id);
            console.log(`   ✅ 重复文件已删除`);
          } catch (deleteError) {
            console.error(`   ❌ 删除重复文件失败:`, deleteError.message);
          }
          
          // 标记为已知，避免重复处理
          knownFileIds.add(file.id);
          continue;
        } else {
          // 旧文件已不在云端（已被同步并清理），更新MD5记录为新文件
          console.log(`   🔄 检测到相同MD5，但旧文件已清理，保留新文件: ${file.name}`);
          console.log(`   📝 更新MD5记录: ${existingFile.filename} → ${file.name}`);
          // 继续处理，不跳过
        }
      }
      
      console.log(`   ✅ 发现新文件: ${file.name} (创建于 ${fileTime.toLocaleString()})`);
        knownFileIds.add(file.id);
        // 记录MD5，用于后续去重
        if (file.md5Checksum) {
          knownFileMD5s.set(file.md5Checksum, {
            fileId: file.id,
            filename: file.name,
            createdTime: file.createdTime
          });
          console.log(`      📋 MD5: ${file.md5Checksum.substring(0, 16)}...`);
        } else {
          console.log(`      ⚠️  该文件无MD5指纹，无法进行内容去重`);
        }
        newFiles.push(file);
      }

    console.log(`📊 [Drive] 轮询结果: 总文件 ${allFiles.length}，图片/视频 ${imageFiles.length}，新文件 ${newFiles.length}`);

    if (newFiles.length > 0) {
      console.log(`🔄 [Drive] 检测到 ${newFiles.length} 个新文件，并发处理...`);
      
      // 并发处理新文件（提高多图同步速度）
      const promises = newFiles.map(async (file) => {
        try {
          // 检测文件类型，如果是 GIF，给予更长的超时时间
          const isGif = file.name.toLowerCase().endsWith('.gif') || (file.mimeType && file.mimeType.toLowerCase() === 'image/gif');
          // GIF 文件给予 5 分钟超时，普通图片 60 秒
          const timeoutMs = isGif ? 300000 : 60000;

          // 为每个文件添加超时保护
          const fileTimeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`处理文件超时（${file.name}）`)), timeoutMs);
          });
          
          await Promise.race([
            handleDriveFile(file, true),
            fileTimeout
          ]);
        } catch (fileError) {
          console.error(`   ❌ 处理文件失败: ${file.name}`, fileError.message);
          // 失败时移除，以便重试
          // 但如果是超时错误，暂不移除，防止因后台仍在运行导致重复处理
          if (!fileError.message.includes('超时')) {
            knownFileIds.delete(file.id);
          } else {
            console.warn(`   ⚠️  文件处理超时，保留在已知列表中防止重复处理: ${file.name}`);
          }
        }
      });
      
      // 为整个并发处理添加总体超时（最多10分钟）
      const allTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('批量处理超时（超过10分钟）')), 600000);
      });
      
      try {
        await Promise.race([
          Promise.all(promises),
          allTimeout
        ]);
      } catch (timeoutError) {
        console.error('⚠️  批量处理超时，部分文件可能未处理完成');
      }
    }
    
    // 更新 lastPollTime
    // 推进查询游标：使用本次轮询开始时间 - 1分钟（安全缓冲）
    const nextQueryTime = new Date(pollStart.getTime() - 60000);
    lastPollTime = nextQueryTime.toISOString();
    
  } catch (error) {
    console.error('⚠️  轮询失败:', error.message);
    console.error('   错误详情:', error.stack || error);
    // 即使失败，也确保下次轮询能继续
  } finally {
    isPolling = false;
    // 注意：不需要在这里手动调度下次轮询，因为 startPolling() 已经设置了 setInterval
    // 这个 finally 块只负责清理状态
    console.log(`   ⏱️  轮询完成 (耗时 ${(new Date() - pollStart) / 1000} 秒)`);
  }
}

async function handleDriveFile(file, deleteAfterSync = false) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('服务器未连接');
    }

    const startTime = Date.now();
    console.log(`\n📥 [Drive] 下载文件: ${file.name} (${file.id})`);

    let backedUpLocally = false;
    let gifCacheId = null; // GIF 缓存 ID（统一变量，避免作用域问题）
    let originalBuffer = await downloadFileBuffer(file.id);
    const downloadTime = Date.now() - startTime;
    const downloadedSizeKB = (originalBuffer.length / 1024).toFixed(2);
    console.log(`   ⬇️  下载完成 (${downloadedSizeKB} KB, ${downloadTime}ms)`);
    
    // 对于 GIF 文件，记录文件大小以便诊断质量问题
    // 如果下载的文件大小与 Drive 中显示的大小不一致，可能是 Google Drive 进行了处理
    if (file.name.toLowerCase().endsWith('.gif') && file.size) {
      const driveSizeKB = (parseInt(file.size) / 1024).toFixed(2);
      const sizeDiff = Math.abs(originalBuffer.length - parseInt(file.size));
      if (sizeDiff > 1024) {
        console.log(`   ⚠️  注意：下载的 GIF 大小 (${downloadedSizeKB}KB) 与 Drive 显示的大小 (${driveSizeKB}KB) 不一致`);
        console.log(`   💡 提示：Google Drive 可能在上传时对 GIF 进行了优化，这可能导致质量下降`);
        console.log(`   💡 建议：如需保持 GIF 原始质量，请使用 iCloud 模式`);
      }
    }

    let processedBuffer = originalBuffer;
    const processStartTime = Date.now();
    
    // 检测文件格式
    const fileName = file.name.toLowerCase();
    const fileNameIsHeif = fileName.endsWith('.heif') || fileName.endsWith('.heic');
    const fileNameIsGif = fileName.endsWith('.gif');
    const fileNameIsVideo = fileName.endsWith('.mp4') || fileName.endsWith('.mov');
    
    // 检测是否为视频格式（MP4 或 MOV）
    let isVideo = fileNameIsVideo;
    if (!isVideo) {
      // 尝试检测 MIME 类型
      const mimeType = (file.mimeType || '').toLowerCase();
      // 视频文件的 MIME 类型通常是 video/mp4 或 video/quicktime
      isVideo = mimeType.startsWith('video/') || 
                mimeType === 'video/mp4' || 
                mimeType === 'video/quicktime' ||
                mimeType === 'video/x-m4v';
    }
    
    // 检测是否为 GIF 格式
    let isGif = fileNameIsGif;
    if (!isGif) {
      // 先检查 MIME 类型
      const mimeType = (file.mimeType || '').toLowerCase();
      if (mimeType === 'image/gif') {
        isGif = true;
      } else {
        // 尝试使用 sharp 检测格式
        try {
          const sharpImage = sharp(originalBuffer);
          const metadata = await sharpImage.metadata();
          isGif = metadata.format === 'gif';
        } catch (metaError) {
          // 如果检测失败，根据文件名判断
          isGif = false;
        }
      }
    }
    
    // 检测是否为 HEIF 格式
    let isHeif = fileNameIsHeif;
    if (!isHeif) {
      // 尝试使用 sharp 检测格式（如果失败，根据错误信息判断）
      try {
        const sharpImage = sharp(originalBuffer);
        const metadata = await sharpImage.metadata();
        isHeif = metadata.format === 'heif' || metadata.format === 'heic';
      } catch (metaError) {
        // 如果错误信息包含 HEIF 相关错误，也标记为 HEIF
        const errorMsg = metaError.message.toLowerCase();
        if (errorMsg.includes('heif') || errorMsg.includes('heic') || errorMsg.includes('codec')) {
          isHeif = true;
        }
      }
    }
    
    if (isVideo) {
      // 视频格式（MP4 或 MOV）- Figma 插件 API 不支持视频文件，跳过处理
      const videoFormat = fileName.endsWith('.mp4') ? 'MP4' : 'MOV';
      console.log(`   🎥 检测到 ${videoFormat} 视频格式`);
      
      // 验证下载的文件大小
      if (file.size) {
        const driveSizeKB = (parseInt(file.size) / 1024).toFixed(2);
        const downloadedSizeKB = (originalBuffer.length / 1024).toFixed(2);
        const sizeDiff = Math.abs(originalBuffer.length - parseInt(file.size));
        if (sizeDiff > 1024) {
          console.log(`   ⚠️  警告：下载的文件大小 (${downloadedSizeKB}KB) 与 Drive 显示的大小 (${driveSizeKB}KB) 不一致`);
          console.log(`   ⚠️  差异: ${(sizeDiff / 1024).toFixed(2)}KB`);
        } else {
          console.log(`   ✅ 文件大小验证通过: ${downloadedSizeKB}KB`);
        }
      }
      
      // 验证 MOV 文件格式（检查文件头）
      if (videoFormat === 'MOV') {
        const fileHeader = originalBuffer.slice(0, 12).toString('ascii');
        const isValidMOV = fileHeader.includes('ftyp') || 
                          fileHeader.includes('moov') || 
                          fileHeader.includes('mdat') ||
                          originalBuffer.slice(4, 8).toString('ascii').includes('qt');
        
        if (!isValidMOV && originalBuffer.length > 0) {
          console.log(`   ⚠️  警告：下载的文件可能不是有效的 MOV 格式`);
          console.log(`   ⚠️  文件头: ${originalBuffer.slice(0, 16).toString('hex')}`);
          console.log(`   ⚠️  文件头（ASCII）: ${fileHeader}`);
          console.log(`   💡 提示：Google Drive 可能对文件进行了处理，导致文件格式不兼容`);
        } else {
          console.log(`   ✅ MOV 文件格式验证通过`);
        }
      }
      
      console.log(`   ⚠️  Figma 插件 API 不支持视频文件，跳过此文件`);
      console.log(`   💡 提示：请通过 Figma 界面直接拖放视频文件，或使用 GIF 格式`);
      
      // 自动保存到缓存（用于导出带标注的 GIF 功能）
      try {
        const cacheResult = userConfig.saveGifToCache(originalBuffer, file.name, file.id);
        if (cacheResult) {
          gifCacheId = cacheResult.cacheId;
          console.log(`   💾 [GIF Cache] 视频已自动缓存 (ID: ${gifCacheId})`);
        }
      } catch (cacheError) {
        console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
      }
      
      // 将文件保存到本地文件夹，方便用户手动拖入
      const saved = await saveFileToLocalFolder(originalBuffer, file.name, file.mimeType);
      if (saved) {
        console.log(`   📂 文件已下载到本地文件夹，可直接拖入 Figma`);
        
        // 保存文件名和 cacheId 的映射关系
        if (gifCacheId) {
          saveCacheMapping(file.name, gifCacheId);
        }
        
        // 下载成功后，删除 Drive 中的文件
        try {
          console.log(`   🗑️  删除 Drive 文件: ${file.name} (ID: ${file.id})`);
          await trashFile(file.id);
          console.log(`   ✅ 已移至回收站`);
          // 清理文件记录
          cleanupFileRecord(file.id, file.md5Checksum);
        } catch (error) {
          const errorMsg = error.message || String(error);
          if (errorMsg.includes('not found') || errorMsg.includes('404')) {
            console.log(`   ℹ️  Drive 文件已不存在（可能已被删除）: ${file.name}`);
            // 文件已不存在，也清理记录
            cleanupFileRecord(file.id, file.md5Checksum);
          } else {
            console.error(`   ⚠️  删除 Drive 文件失败 (${file.name}):`, errorMsg);
          }
        }
      } else {
        console.log(`   ⚠️  文件保存失败，保留 Drive 文件以便重试`);
      }
      
      // 通知 Figma 插件此文件需要手动拖入，并传递缓存信息以便自动关联
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'file-skipped',
          filename: file.name,
          reason: 'video', // 统一使用 video，包含 mp4 和 mov
          gifCacheId: gifCacheId, // ✅ 传递缓存ID，用于导出时自动查找
          driveFileId: file.id     // ✅ 传递Drive文件ID
        }));
      }
      
      // 跳过此文件，不发送到 Figma
      return;
    } else if (isGif) {
      // GIF 格式，检查文件大小
      console.log(`   🎬 检测到 GIF 格式...`);
      
      const originalSize = originalBuffer.length;
      const maxGifSize = 100 * 1024 * 1024; // 100MB（防止 Figma 死机）
      
      // 检查文件大小
      if (originalSize > maxGifSize) {
        const fileSizeMB = (originalSize / 1024 / 1024).toFixed(2);
        console.log(`   ⚠️  GIF 文件过大 (${fileSizeMB}MB)，超过限制 (100MB)`);
        console.log(`   ⚠️  为防止 Figma 死机，将保存到本地文件夹，可直接拖入 Figma`);
        
        // 自动保存到缓存（用于导出带标注的 GIF 功能）
        try {
          const cacheResult = userConfig.saveGifToCache(originalBuffer, file.name, file.id);
          if (cacheResult) {
            gifCacheId = cacheResult.cacheId;
            console.log(`   💾 [GIF Cache] 大GIF已自动缓存 (ID: ${gifCacheId})`);
          }
        } catch (cacheError) {
          console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
        }
        
        // 将文件保存到本地文件夹
        const saved = await saveFileToLocalFolder(originalBuffer, file.name, file.mimeType);
        if (saved) {
          console.log(`   📂 文件已下载到本地文件夹`);
          
          // 保存文件名和 cacheId 的映射关系
          if (gifCacheId) {
            saveCacheMapping(file.name, gifCacheId);
          }
          
          // 下载成功后，删除 Drive 中的文件
          try {
            console.log(`   🗑️  删除 Drive 文件: ${file.name} (ID: ${file.id})`);
            await trashFile(file.id);
            console.log(`   ✅ 已移至回收站`);
            // 清理文件记录
            cleanupFileRecord(file.id, file.md5Checksum);
          } catch (error) {
            const errorMsg = error.message || String(error);
            if (errorMsg.includes('not found') || errorMsg.includes('404')) {
              console.log(`   ℹ️  Drive 文件已不存在（可能已被删除）: ${file.name}`);
              // 文件已不存在，也清理记录
              cleanupFileRecord(file.id, file.md5Checksum);
            } else {
              console.error(`   ⚠️  删除 Drive 文件失败 (${file.name}):`, errorMsg);
            }
          }
        }
        
        // 通知 Figma 插件此文件需要手动拖入，并传递缓存信息以便自动关联
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: file.name,
            reason: 'gif-too-large',
            gifCacheId: gifCacheId, // ✅ 传递缓存ID，用于导出时自动查找
            driveFileId: file.id     // ✅ 传递Drive文件ID
          }));
          console.log(`   📤 发送 file-skipped 消息: ${file.name}, gifCacheId: ${gifCacheId || '无'}`);
        }
        
        // 跳过此文件，不发送到 Figma
        return;
      }
      
      // 文件大小合适，直接使用原始文件
      processedBuffer = originalBuffer;
      
      // 自动保存 GIF 到缓存（用于导出带标注的 GIF 功能）
      try {
        const cacheResult = userConfig.saveGifToCache(processedBuffer, file.name, file.id);
        if (cacheResult) {
          gifCacheId = cacheResult.cacheId;
          console.log(`   💾 [GIF Cache] 已自动缓存 (ID: ${gifCacheId})`);
        }
      } catch (cacheError) {
        console.error(`   ⚠️  [GIF Cache] 缓存失败:`, cacheError.message);
      }
      
      // 获取备份模式
      const backupMode = userConfig.getBackupMode();
      const shouldBackupGif = (backupMode === 'gif_only' || backupMode === 'all');

      // 如果启用了 GIF 备份，保存副本到本地（用户可见的文件夹）
      if (shouldBackupGif) {
        console.log(`   💾 [备份] 正在保存 GIF 副本到本地文件夹...`);
        const saveResult = await saveFileToLocalFolder(processedBuffer, file.name, file.mimeType);
        // 只有当成功保存且是新文件时才标记为已备份
        backedUpLocally = (saveResult && saveResult.success && saveResult.isNew) || false;
        if (saveResult && saveResult.success && !saveResult.isNew) {
          console.log(`   ⏭️  [备份] 文件已存在，已替换但不计入备份数`);
        }
      } else {
        backedUpLocally = false;
      }

      originalBuffer = null;
      const fileSizeKB = (processedBuffer.length / 1024).toFixed(2);
      console.log(`   ✅ 使用原始 GIF 文件: ${fileSizeKB}KB`);
    } else if (isHeif && os.platform() === 'darwin') {
      // 使用 macOS 自带的 sips 命令转换 HEIF 到 JPEG
      console.log(`   🔄 检测到 HEIF 格式，使用 sips 转换为 JPEG...`);
      
      // 在 try 块外定义变量，确保 catch 块可以访问
      let tempInputPath = path.join(os.tmpdir(), `heif-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.heic`);
      let tempOutputPath = path.join(os.tmpdir(), `jpeg-output-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
      
      try {
        // 写入临时文件
        fs.writeFileSync(tempInputPath, originalBuffer);
        
        // 使用 sips 转换为 JPEG
        const sipsCommand = `sips -s format jpeg "${tempInputPath}" --out "${tempOutputPath}"`;
        
        // 保存路径到局部变量，避免闭包问题
        const inputPath = tempInputPath;
        const outputPath = tempOutputPath;
        
        await new Promise((resolve, reject) => {
          exec(sipsCommand, 
            { maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) {
                reject(new Error(`sips 转换失败: ${err.message}${stderr ? ' - ' + stderr : ''}`));
              } else {
                if (!fs.existsSync(outputPath)) {
                  reject(new Error(`sips 转换失败: 输出文件不存在`));
                } else {
                  resolve();
                }
              }
            });
        });
        
        // 读取转换后的 JPEG 文件
        let convertedBuffer = fs.readFileSync(outputPath);
        
        // 使用 sharp 对转换后的 JPEG 进行压缩和调整大小
        processedBuffer = await sharp(convertedBuffer)
          .resize(CONFIG.maxWidth, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: CONFIG.quality })
          .toBuffer();
        
        // 清理临时文件
        try {
          fs.unlinkSync(tempInputPath);
          fs.unlinkSync(tempOutputPath);
        } catch (cleanupError) {
          // 忽略清理错误
        }
        
        const processTime = Date.now() - processStartTime;
        const originalSize = (originalBuffer.length / 1024).toFixed(2);
        const compressedSize = (processedBuffer.length / 1024).toFixed(2);
        console.log(`   ✅ HEIF → JPEG 转换完成 (sips): ${originalSize} KB → ${compressedSize} KB (${processTime}ms)`);
        
        // 释放原始 buffer 内存
        originalBuffer = null;
        convertedBuffer = null;
      } catch (sipsError) {
        console.log(`   ❌ sips 转换失败: ${sipsError.message}`);
        if (sipsError.stack) {
          console.log(`   错误堆栈: ${sipsError.stack}`);
        }
        console.log(`   ⚠️  跳过此文件（无法转换 HEIF 格式）`);
        
        // 清理临时文件（如果存在）
        try {
          if (tempInputPath && fs.existsSync(tempInputPath)) {
            fs.unlinkSync(tempInputPath);
          }
          if (tempOutputPath && fs.existsSync(tempOutputPath)) {
            fs.unlinkSync(tempOutputPath);
          }
        } catch (cleanupError) {
          // 忽略清理错误
        }
        
        // 跳过此文件，不发送到 Figma
        return;
      }
    } else if (isHeif) {
      // 非 macOS 系统，无法使用 sips
      console.log(`   ❌ 检测到 HEIF 格式，但当前系统不支持 sips 转换`);
      console.log(`   ⚠️  跳过此文件（无法转换 HEIF 格式）`);
      return;
    } else {
      // 非 HEIF 格式，使用 sharp 正常处理
      try {
        const sharpImage = sharp(originalBuffer);
        processedBuffer = await sharpImage
          .resize(CONFIG.maxWidth, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: CONFIG.quality })
          .toBuffer();
        
        const processTime = Date.now() - processStartTime;
        const originalSize = (originalBuffer.length / 1024).toFixed(2);
        const compressedSize = (processedBuffer.length / 1024).toFixed(2);
        console.log(`   🖼️  压缩完成: ${originalSize} KB → ${compressedSize} KB (${processTime}ms)`);
        
        // 立即释放原始buffer内存
        originalBuffer = null;
      } catch (error) {
        console.log(`   ⚠️  压缩失败，使用原始文件: ${error.message}`);
        processedBuffer = originalBuffer;
      }
    }

    // 如果启用了截图备份，保存副本到本地（转换为JPEG格式）
    // 注意：变量 backupMode 在上面已经获取过，但为了安全起见重新获取（如果作用域不同）
    // 或者重用上面定义的 backupMode? 上面是在 if(isGif) 块里定义的。
    // 这里是 if (isHeif) ... else ... 块之后。
    // 所以这里需要重新获取。
    const backupModeForImage = userConfig.getBackupMode();
    if (backupModeForImage === 'all' && !isGif && !isVideo) {
      try {
        console.log(`   💾 [备份] 正在保存截图副本到本地（JPEG格式）...`);
        // 为备份文件生成 JPEG 文件名
        const jpegFilename = file.name.replace(/\.(png|heic|heif|webp)$/i, '.jpg');
        const saveResult = await saveFileToLocalFolder(processedBuffer, jpegFilename, 'image/jpeg');
        if (saveResult && saveResult.success && saveResult.isNew) {
          console.log(`   ✅ [备份] 截图已保存到本地`);
        } else if (saveResult && saveResult.success && !saveResult.isNew) {
          console.log(`   ⏭️  [备份] 文件已存在，已替换`);
        }
      } catch (backupError) {
        console.error(`   ⚠️  [备份] 保存截图失败: ${backupError.message}`);
      }
    }

    // 使用 base64 编码，避免 Array.from 创建巨大数组占用内存
    const base64String = processedBuffer.toString('base64');
    processedBuffer = null; // 立即释放内存

    const payload = {
      type: 'screenshot',
      bytes: base64String, // 直接使用 base64 字符串，Figma 端需要解码
      timestamp: Date.now(),
      filename: file.name,
      driveFileId: file.id,
      backedUpLocally: backedUpLocally || false, // 确保 backedUpLocally 始终有值
      gifCacheId: gifCacheId || null // GIF 缓存 ID（用于导出带标注的 GIF）
    };

    const sendStartTime = Date.now();
    ws.send(JSON.stringify(payload));
    const sendTime = Date.now() - sendStartTime;
    const totalTime = Date.now() - startTime;
    console.log(`   ⬆️  已发送到 Figma 插件 (总耗时: ${totalTime}ms, 发送: ${sendTime}ms)`);

    if (deleteAfterSync && CONFIG.autoDelete) {
      // 使用文件 ID 作为键，更可靠（文件名可能重复）
      pendingDeletes.set(file.id, {
        filename: file.name,
        timestamp: Date.now()
      });
      console.log(`   ⏳ 等待 Figma 确认后删除 Drive 文件 (ID: ${file.id})`);

      // 设置超时，如果 120 秒内没有收到确认，保留文件
      // 增加超时时间以适应批量上传场景（Figma 处理队列可能较慢）
      const confirmTimeout = 120000;
      setTimeout(() => {
        if (pendingDeletes.has(file.id)) {
          console.log(`   ⚠️  等待确认超时（${confirmTimeout / 1000}秒），保留文件: ${file.name}`);
          pendingDeletes.delete(file.id);
        }
      }, confirmTimeout);
    }
  } catch (error) {
    console.error(`   ❌ 处理 Drive 文件失败 (${file.name}):`, error.message);
    // 重新抛出异常，让调用者知道处理失败
    throw error;
  }
}

async function countFilesForManualSync() {
  console.log('\n📊 [Drive] 统计云端文件数量...');
  
  // Check if user folder is initialized
  if (!CONFIG.userFolderId) {
    console.log('⚠️  [Drive] 用户文件夹未初始化');
    return;
  }
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('❌ [Drive] WebSocket 未连接，无法返回文件统计结果');
    return;
  }
  
  try {
    console.log(`   🔍 正在获取文件列表...`);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('获取文件列表超时')), 40000);
    });
    
    const listPromise = listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 200, 
      orderBy: 'createdTime asc' 
    });
    
    const { files } = await Promise.race([listPromise, timeoutPromise]);
    
    // Filter media files
    const imageFiles = files.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      // Ignore _exported files
      if (name.toLowerCase().includes('_exported')) {
        return false;
      }
      
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    console.log(`   📋 找到 ${files.length} 个文件`);
    console.log(`   🖼️  其中 ${imageFiles.length} 个是媒体文件`);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-file-count',
        count: imageFiles.length
      });
    }
  } catch (error) {
    console.error('❌ [Drive] 统计文件失败:', error.message);
  }
}

async function performManualSync() {
  console.log('\n📦 [Drive] 执行手动同步...');
  console.log(`   ⏰ 开始时间: ${new Date().toLocaleTimeString()}`);
  
  // 防止重复触发
  if (isSyncing) {
    console.warn('⚠️  [Drive] 手动同步正在进行中，跳过本次请求');
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
        message: '同步正在进行中，请勿重复触发'
      });
    }
    return;
  }
  
  isSyncing = true; // 标记为正在同步
  
  // 如果用户文件夹未初始化，尝试重新初始化（可能是第一次使用，用户刚上传文件）
  if (!CONFIG.userFolderId) {
    console.log('⚠️  [Drive] 用户文件夹未初始化，尝试重新初始化...');
    try {
      const userFolderId = await initializeUserFolder();
      if (userFolderId) {
        console.log(`✅ [Drive] 重新初始化成功，用户文件夹ID: ${userFolderId}`);
      } else {
        throw new Error('重新初始化失败，返回的文件夹ID为空');
      }
    } catch (error) {
      console.error(`❌ [Drive] 重新初始化失败: ${error.message}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
        safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
          message: `用户文件夹未初始化。${error.message.includes('未找到') ? '请先在手机端上传至少一个文件。' : '请检查网络连接并重试。'}`
        });
    }
      isSyncing = false; // 重置标志
    return;
    }
  }
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('❌ [Drive] WebSocket 未连接，无法执行手动同步');
    console.error(`   WebSocket 状态: ${ws ? ws.readyState : 'null'}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
        message: 'WebSocket 未连接'
      });
    }
    isSyncing = false; // 重置标志
    return;
  }
  
  // 为整个手动同步添加总体超时保护（5分钟）
  const overallTimeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('手动同步总体超时（超过5分钟），请检查网络连接或减少待同步文件数量')), 300000);
  });
  
  const syncTask = (async () => {
    console.log(`📂 [Drive] 正在同步用户专属文件夹: ${CONFIG.userFolderId}`);
    console.log(`   🔍 正在获取文件列表...`);
    
    // 添加额外的超时保护
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('获取文件列表超时（超过40秒）')), 40000);
    });
    
    const listPromise = listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 200, 
      orderBy: 'createdTime asc' 
    });
    
    const { files } = await Promise.race([listPromise, timeoutPromise]);

    console.log(`   📋 找到 ${files.length} 个文件`);
    
    // 过滤图片和视频文件
    const imageFiles = files.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      // 忽略 _exported 结尾的文件（这是服务器自己生成的导出 GIF）
      if (name.toLowerCase().includes('_exported')) {
        // console.log(`🙈 [手动同步] 忽略已导出的 GIF: ${name}`);
        return false;
      }
      
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    console.log(`   🖼️  其中 ${imageFiles.length} 个是媒体文件`);
    
    // ✅ 手动同步前先进行MD5去重检测
    console.log(`   🔍 开始检测重复文件...`);
    const md5Map = new Map(); // 临时MD5映射，用于本次手动同步
    let duplicateCount = 0;
    let filesWithMD5 = 0;
    let filesWithoutMD5 = 0;
    
    for (const file of imageFiles) {
      if (file.md5Checksum) {
        filesWithMD5++;
        if (md5Map.has(file.md5Checksum)) {
          // 发现重复文件
          const existingFile = md5Map.get(file.md5Checksum);
          const existingTime = new Date(existingFile.createdTime);
          const currentTime = new Date(file.createdTime);
          
          // 保留较早上传的文件，删除较晚的
          let fileToDelete, fileToKeep;
          if (currentTime < existingTime) {
            fileToDelete = existingFile;
            fileToKeep = file;
            md5Map.set(file.md5Checksum, file); // 更新映射
          } else {
            fileToDelete = file;
            fileToKeep = existingFile;
          }
          
          console.log(`   🔄 发现重复文件:`);
          console.log(`      保留: ${fileToKeep.name} (${new Date(fileToKeep.createdTime).toLocaleString()})`);
          console.log(`      删除: ${fileToDelete.name} (${new Date(fileToDelete.createdTime).toLocaleString()})`);
          console.log(`      MD5: ${file.md5Checksum.substring(0, 16)}...`);
          
          try {
            await trashFile(fileToDelete.id);
            duplicateCount++;
            console.log(`      ✅ 重复文件已删除`);
          } catch (deleteError) {
            console.error(`      ❌ 删除失败:`, deleteError.message);
          }
        } else {
          md5Map.set(file.md5Checksum, file);
        }
      } else {
        filesWithoutMD5++;
      }
    }
    
    console.log(`   📊 去重统计: 共 ${imageFiles.length} 个文件，${filesWithMD5} 个有MD5指纹，${filesWithoutMD5} 个无MD5`);
    if (duplicateCount > 0) {
      console.log(`   ✨ 已清理 ${duplicateCount} 个重复文件`);
    } else {
      console.log(`   ✅ 未发现重复文件`);
    }
    
    if (filesWithoutMD5 > 0) {
      console.log(`   ⚠️  注意: ${filesWithoutMD5} 个文件没有MD5指纹，无法进行内容去重`);
      console.log(`   💡 提示: Google Drive可能正在处理这些文件，或文件类型不支持MD5`);
    }
    
    // 重新获取文件列表（去重后）
    const refreshResult = await listFolderFiles({ 
      folderId: CONFIG.userFolderId, 
      pageSize: 500,
      orderBy: 'createdTime desc'
    });
    
    const refreshedFiles = (refreshResult.files || []).filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      if (name.toLowerCase().includes('_exported')) return false;
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    console.log(`   📋 去重后剩余 ${refreshedFiles.length} 个文件`);
    
    if (refreshedFiles.length === 0) {
      console.log(`   ℹ️  没有文件需要同步`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        safeSend({
          type: 'manual-sync-complete',
          count: 0,
          gifCount: 0,
          videoCount: 0
        });
      }
      return;
    }

    let success = 0;
    let imageCount = 0; // ✅ 统计成功导入的纯图片数量
    let gifCount = 0; // ✅ 统计 GIF 数量（包括成功导入的和跳过的）
    let videoCount = 0; // ✅ 统计视频数量（全部跳过保存到本地）
    // 收集所有处理过程中的错误
    const processingErrors = [];
    
    // ✅ 获取当前备份模式，用于判断 GIF/视频是否真的被保存到本地
    const backupMode = userConfig.getBackupMode();
    const shouldBackupGif = (backupMode === 'gif_only' || backupMode === 'all');
    console.log(`   📋 当前备份模式: ${backupMode}, 备份GIF: ${shouldBackupGif}`);
    
    // 手动同步时，强制同步所有图片文件（不检查 knownFileIds）
    // 因为手动同步的目的就是同步残留的图片
    console.log(`   🔄 手动同步模式：将并发处理所有 ${refreshedFiles.length} 个图片文件`);
    
    // 使用并发处理提升性能，但限制并发数避免过载
    const CONCURRENT_LIMIT = 10; // ⚡ 提高并发：同时处理10个文件
    const results = [];
    
    for (let i = 0; i < refreshedFiles.length; i += CONCURRENT_LIMIT) {
      const batch = refreshedFiles.slice(i, i + CONCURRENT_LIMIT);
      console.log(`   📦 处理批次 ${Math.floor(i / CONCURRENT_LIMIT) + 1}/${Math.ceil(refreshedFiles.length / CONCURRENT_LIMIT)} (${batch.length} 个文件)`);
      
      const batchPromises = batch.map(async (file) => {
      const wasKnown = knownFileIds.has(file.id);
      if (!wasKnown) {
        knownFileIds.add(file.id);
      }
      
        // 检测文件类型，如果是 GIF，给予更长的超时时间
        const isGif = file.name.toLowerCase().endsWith('.gif') || (file.mimeType && file.mimeType.toLowerCase() === 'image/gif');
        // GIF 文件给予 5 分钟超时，普通图片 60 秒
        const timeoutMs = isGif ? 300000 : 60000;
        
        // 为每个文件添加超时保护
        const fileTimeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`处理文件超时（超过${timeoutMs/1000}秒）: ${file.name}`)), timeoutMs);
        });
        
        const fileProcessing = (async () => {
      try {
        // 检查文件类型
        const fileName = file.name.toLowerCase();
        const mimeType = (file.mimeType || '').toLowerCase();
        const isGif = fileName.endsWith('.gif') || mimeType === 'image/gif';
        const isVideo = fileName.endsWith('.mp4') || fileName.endsWith('.mov') ||
                        mimeType.startsWith('video/') ||
                        mimeType === 'video/mp4' ||
                        mimeType === 'video/quicktime';
        
        // ✅ 视频文件：处理后标记为 skipped（保存到本地但不导入 Figma）
        if (isVideo) {
          await handleDriveFile(file, true);
          return { success: false, skipped: true, isVideo: true, file };
        }
        
        // 如果是 GIF，先检查大小
        if (isGif) {
          try {
            const originalBuffer = await downloadFileBuffer(file.id);
            const originalSize = originalBuffer.length;
            const maxGifSize = 100 * 1024 * 1024; // 100MB
            
            if (originalSize > maxGifSize) {
              console.log(`   ⚠️  GIF 文件过大，需要手动拖入: ${file.name}`);
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'file-skipped',
                  filename: file.name,
                  reason: 'gif-too-large'
                }));
              }
              // 大 GIF 也要调用 handleDriveFile 保存到本地
              await handleDriveFile(file, true);
              return { success: false, skipped: true, isGif: true, file };
            }
          } catch (checkError) {
            console.log(`   ⚠️  检查 GIF 大小失败，继续处理: ${checkError.message}`);
          }
        }
        
        // 调用通用处理函数
        await handleDriveFile(file, true);
        // 普通图片或小 GIF 成功导入 Figma
        return { success: true, isGif: isGif, file };
      } catch (error) {
        console.error(`   ❌ 处理文件失败: ${file.name}`, error.message);
            processingErrors.push({
              filename: file.name,
              error: error.message,
              stack: error.stack
            });
        if (!wasKnown) {
          knownFileIds.delete(file.id);
        }
            return { success: false, error, file };
          }
        })();
        
        // 使用 Promise.race 实现超时
        try {
          return await Promise.race([fileProcessing, fileTimeout]);
        } catch (timeoutError) {
          console.error(`   ⏱️  ${timeoutError.message}`);
          processingErrors.push({
            filename: file.name,
            error: timeoutError.message
          });
          if (!wasKnown) {
            knownFileIds.delete(file.id);
          }
          return { success: false, timeout: true, file };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      // ✅ 统计本批次结果（分类统计图片、GIF、视频）
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          const value = result.value;
          const wasSuccess = value.success === true;
          
          if (value.isVideo) {
            // 视频文件（全部跳过保存到本地）
            videoCount++;
          } else if (value.isGif) {
            // GIF 文件（无论成功导入还是跳过都计入 gifCount）
            gifCount++;
            if (wasSuccess) success++;
          } else if (value.file) {
            // 普通图片
            if (wasSuccess) {
              imageCount++;
              success++;
            }
          }
        }
      });
      
      results.push(...batchResults);
      
      // 批次间短暂延迟，避免过载
      if (i + CONCURRENT_LIMIT < refreshedFiles.length) {
        await sleep(50); // ⚡ 减少批次间延迟：从200ms降到50ms
      }
    }

    console.log(`\n✅ [Drive] 手动同步完成`);
    console.log(`   ✅ 成功导入 Figma: ${success} 个文件`);
    console.log(`   🖼️  图片数量: ${imageCount} 张`);
    console.log(`   🎞️  GIF数量: ${gifCount} 段`);
    console.log(`   🎥 视频数量: ${videoCount} 段`);
    console.log(`   📊 总计处理: ${refreshedFiles.length} 个媒体文件`);
    if (processingErrors.length > 0) {
      console.log(`   ❌ 失败: ${processingErrors.length} 个`);
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      // ✅ 计算实际被保存到本地的数量
      // - 视频始终会被保存到本地（Figma 不支持导入）
      // - GIF 只有在备份模式为 'gif_only' 或 'all' 时才会被保存
      const savedGifCount = shouldBackupGif ? gifCount : 0;
      const savedVideoCount = videoCount; // 视频始终保存到本地
      
      const message = {
        type: 'manual-sync-complete',
        count: success, // 成功导入 Figma 的总数（图片 + 小 GIF）
        imageCount: imageCount, // ✅ 纯图片数量
        gifCount: gifCount, // ✅ GIF 数量（包括成功导入的和跳过的）
        videoCount: videoCount, // ✅ 视频数量（全部跳过保存到本地）
        savedGifCount: savedGifCount, // ✅ 实际保存到本地的 GIF 数量
        savedVideoCount: savedVideoCount, // ✅ 实际保存到本地的视频数量
        errors: processingErrors
      };
      console.log(`   📤 发送完成消息: imageCount=${imageCount}, gifCount=${gifCount}(saved:${savedGifCount}), videoCount=${videoCount}, errors=${processingErrors.length}`);
      ws.send(JSON.stringify(message));
    }
  })(); // 结束 syncTask async 函数
  
  // 使用 Promise.race 应用总体超时
  try {
    await Promise.race([syncTask, overallTimeout]);
  } catch (error) {
    console.error('❌ 手动同步失败:', error.message);
    console.error('   错误代码:', error.code || 'N/A');
    console.error('   错误堆栈:', error.stack);
    
    // 提取更友好的错误信息
    let userMessage = error.message;
    if (error.message.includes('request to https://www.googleapis.com')) {
      userMessage = '无法连接到 Google Drive API，请检查网络连接。\n原始错误: ' + error.message;
    } else if (error.code === 'ENOTFOUND') {
      userMessage = 'DNS 解析失败，请检查网络连接或 DNS 设置。';
    } else if (error.code === 'ETIMEDOUT') {
      userMessage = '连接超时，请检查网络连接或稍后重试。';
    }
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        gifCount: 0,
        videoCount: 0,
        message: userMessage,
        errors: [{ filename: '系统错误', error: userMessage }]
      });
    }
  } finally {
    // 无论成功还是失败，都要重置同步标志
    isSyncing = false;
    console.log('   🔓 手动同步标志已重置');
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // 注意：不立即执行轮询，因为启动实时模式时已经初始化了 knownFileIds
  // 立即执行可能会处理一些在初始化后、启动前新增的文件，但这是可以接受的
  // 如果用户希望完全只处理启动后的新文件，可以注释掉下面这行
  pollDrive();
  pollTimer = setInterval(pollDrive, CONFIG.pollIntervalMs);
  const intervalSeconds = (CONFIG.pollIntervalMs / 1000).toFixed(1);
  console.log(`🕒 [Drive] 开始轮询，每 ${intervalSeconds} 秒检查一次（已立即执行首次检查）`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🛑 [Drive] 停止轮询');
  }
}

function connectWebSocket() {
  console.log('🔌 [Drive] 正在连接服务器...');

  ws = new WebSocket(`${CONFIG.wsUrl}?id=${CONFIG.connectionId}&type=mac`);

  ws.on('open', () => {
    console.log('✅ [Drive] 已连接到服务器');
    
    // 如果之前是实时模式，重连后自动恢复
    if (wasRealTimeMode && !isRealTimeMode) {
      console.log('🔄 [Drive] 检测到之前是实时模式，自动恢复...');
      isRealTimeMode = true;
      startPolling();
    }
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'switch-sync-mode') {
        console.log('\n🔄 [Drive] 收到模式切换消息');
        console.log('   目标模式:', message.mode);
        if (message.mode !== 'drive' && message.mode !== 'google') {
          console.log('⚠️  [Drive] 当前是 Google Drive watcher，需要切换到其他模式');
          console.log('   正在退出，请等待 start.js 重启正确的 watcher...\n');
          // 停止轮询
          stopPolling();
          // 关闭 WebSocket
          if (ws) {
            ws.close();
          }
          // 退出进程，让 start.js 重启正确的 watcher
          setTimeout(() => {
            process.exit(0);
          }, 1000);
        }
        return;
      }


      if (message.type === 'screenshot-failed') {
        // 文件导入失败，如果标记了 keepFile，则保留源文件
        const filename = message.filename;
        const driveFileId = message.driveFileId || message.fileId;
        const keepFile = message.keepFile === true;
        
        if (keepFile) {
          console.log(`   ⚠️  文件导入失败，保留源文件: ${filename}`);
          
          // 从 pendingDeletes 中移除，不删除文件
          let removed = false;
          if (driveFileId && pendingDeletes.has(driveFileId)) {
            pendingDeletes.delete(driveFileId);
            console.log(`   ✅ 已取消删除计划: ${filename} (ID: ${driveFileId})`);
            removed = true;
          } else {
            // 尝试用文件名查找
            for (const [fileId, info] of pendingDeletes.entries()) {
              if (info.filename === filename) {
                pendingDeletes.delete(fileId);
                console.log(`   ✅ 已取消删除计划: ${filename} (ID: ${fileId})`);
                removed = true;
                break;
              }
            }
          }
          
          if (!removed) {
            console.log(`   ℹ️  文件不在待删除列表中: ${filename}（可能已经处理或未计划删除）`);
          }
        } else {
          // 如果没有标记 keepFile，正常处理失败（可能会删除文件，取决于配置）
          console.log(`   ⚠️  文件导入失败: ${filename}（未标记保留，将按配置处理）`);
        }
        return;
      }

      if (message.type === 'screenshot-received') {
        const filename = message.filename;
        const driveFileId = message.driveFileId || message.fileId;
        
        // 检查文件是否已经被标记为保留（通过 screenshot-failed 消息）
        // 如果文件不在 pendingDeletes 中，说明已经被标记为保留，不应该删除
        let shouldDelete = false;
        let deleteInfo = null;
        let fileIdToDelete = null;
        
        if (driveFileId) {
          if (pendingDeletes.has(driveFileId)) {
            deleteInfo = pendingDeletes.get(driveFileId);
            fileIdToDelete = driveFileId;
            shouldDelete = true;
            pendingDeletes.delete(driveFileId);
          }
        }
        
        // 如果没找到，尝试用文件名查找（兼容旧版本）
        if (!deleteInfo) {
          for (const [fileId, info] of pendingDeletes.entries()) {
            if (info.filename === filename) {
              deleteInfo = info;
              fileIdToDelete = fileId;
              shouldDelete = true;
              pendingDeletes.delete(fileId);
              break;
            }
          }
        }
        
        // 只有在 pendingDeletes 中找到文件时才删除（说明没有被标记为保留）
        if (shouldDelete && deleteInfo && fileIdToDelete) {
          try {
            console.log(`   🗑️  删除 Drive 文件: ${filename} (ID: ${fileIdToDelete})`);
            await trashFile(fileIdToDelete);
            console.log(`   ✅ 已移至回收站`);
            // 清理文件记录
            cleanupFileRecord(fileIdToDelete);
          } catch (error) {
            // 如果文件不存在，可能是已经被删除或不存在，这是正常的
            const errorMsg = error.message || String(error);
            if (errorMsg.includes('File not found') || 
                errorMsg.includes('not found') || 
                errorMsg.includes('404') ||
                errorMsg.includes('does not exist')) {
              console.log(`   ℹ️  Drive 文件已不存在（可能已被删除）: ${filename}`);
              // 文件已不存在，也清理记录
              cleanupFileRecord(fileIdToDelete);
            } else {
              console.error(`   ⚠️  删除 Drive 文件失败 (${filename}):`, errorMsg);
            }
          }
        } else {
          // 文件不在 pendingDeletes 中，说明已经被标记为保留（通过 screenshot-failed）
          console.log(`   ℹ️  文件已标记为保留，不删除: ${filename}（可能导入失败需要手动拖入）`);
        }
        return;
      }

      if (message.type === 'start-realtime') {
        console.log('\n🎯 [Drive] 启动实时同步模式...');
        console.log(`📊 [Drive] 之前 knownFileIds 数量: ${knownFileIds.size}`);
        
        // 每次开启都重新初始化，以"开启的那一刻"作为新的时间基准
        // 这样可以确保只同步开启后上传的文件，而不是关闭期间上传的文件
        console.log('📂 [Drive] 重新初始化实时模式时间基准...');
          await initializeKnownFiles();
        console.log(`✅ [Drive] 初始化完成，时间基准: ${realTimeStart.toISOString()}`);
        
        isRealTimeMode = true;
        wasRealTimeMode = true; // 记录状态
        startPolling();
        // 注意：startPolling() 会立即执行一次 pollDrive()，但此时 knownFileIds 已经初始化
        // 所以不会处理已有文件，只会处理新文件
        return;
      }

      if (message.type === 'stop-realtime') {
        console.log('\n⏸️  [Drive] 停止实时同步模式');
        isRealTimeMode = false;
        wasRealTimeMode = false; // 用户主动停止，清除记录
        stopPolling();
        return;
      }

      if (message.type === 'manual-sync-count-files') {
        await countFilesForManualSync();
        return;
      }

      if (message.type === 'manual-sync') {
        await performManualSync();
        return;
      }
    } catch (error) {
      console.error('⚠️  解析消息失败:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('⚠️  [Drive] 服务器连接断开，5秒后重连');
    // 记录断开前的实时模式状态
    wasRealTimeMode = isRealTimeMode;
    if (wasRealTimeMode) {
      console.log('   📝 已记录实时模式状态，重连后将自动恢复');
    }
    // 暂停实时模式（重连后会自动恢复）
    isRealTimeMode = false;
    stopPolling();
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('❌ [Drive] WebSocket 错误:', error.message);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 清理过期的缓存数据，防止内存无限增长
 */
function cleanupCache() {
  // 清理 knownFileIds（如果超过限制，保留最新的）
  if (knownFileIds.size > MAX_KNOWN_FILES) {
    const toRemove = knownFileIds.size - MAX_KNOWN_FILES;
    const idsArray = Array.from(knownFileIds);
    // 移除最旧的一半（简单策略）
    for (let i = 0; i < Math.floor(toRemove / 2); i++) {
      knownFileIds.delete(idsArray[i]);
    }
    console.log(`🧹 [缓存清理] 已清理 ${Math.floor(toRemove / 2)} 个旧文件ID，当前: ${knownFileIds.size}`);
  }
  
  // 清理 knownFileMD5s（如果超过限制，保留最新的）
  if (knownFileMD5s.size > MAX_KNOWN_FILES) {
    const toRemove = knownFileMD5s.size - MAX_KNOWN_FILES;
    const md5Array = Array.from(knownFileMD5s.entries());
    // 按创建时间排序，移除最旧的
    md5Array.sort((a, b) => new Date(a[1].createdTime) - new Date(b[1].createdTime));
    for (let i = 0; i < Math.floor(toRemove / 2); i++) {
      knownFileMD5s.delete(md5Array[i][0]);
    }
    console.log(`🧹 [缓存清理] 已清理 ${Math.floor(toRemove / 2)} 个旧MD5记录，当前: ${knownFileMD5s.size}`);
  }
  
  // 清理过期的 pendingDeletes（超过5分钟未确认的）
  const now = Date.now();
  const expiredTimeout = 5 * 60 * 1000; // 5分钟
  let cleanedDeletes = 0;
  for (const [fileId, info] of pendingDeletes.entries()) {
    if (now - info.timestamp > expiredTimeout) {
      pendingDeletes.delete(fileId);
      cleanedDeletes++;
    }
  }
  if (cleanedDeletes > 0) {
    console.log(`🧹 [缓存清理] 已清理 ${cleanedDeletes} 个过期的待删除记录`);
  }
  
  // 输出内存使用情况
  if (global.gc) {
    global.gc();
    const used = process.memoryUsage();
    console.log(`📊 [内存] RSS: ${(used.rss / 1024 / 1024).toFixed(2)} MB, Heap: ${(used.heapUsed / 1024 / 1024).toFixed(2)}/${(used.heapTotal / 1024 / 1024).toFixed(2)} MB`);
  }
}

async function start() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  Google Drive 截图同步 - Mac 监听器   ║');
  console.log('╚════════════════════════════════════════╝\n');

  // 清理旧的 GIF 缓存（30天前的文件）
  try {
    const stats = userConfig.getGifCacheStats();
    if (stats.count > 0) {
      console.log(`📊 [GIF Cache] 当前缓存: ${stats.count} 个文件, ${stats.sizeMB} MB, 最旧 ${stats.oldestDays} 天`);
    }
    
    const cleaned = userConfig.cleanOldGifCache(30);
    if (cleaned.cleaned > 0) {
      console.log(`🧹 [GIF Cache] 已清理 ${cleaned.cleaned} 个超过 30 天的缓存文件\n`);
    }
  } catch (cacheError) {
    console.warn(`⚠️  [GIF Cache] 清理失败:`, cacheError.message);
  }

  // 初始化用户文件夹
  try {
    console.log('📋 [Drive] 开始初始化用户文件夹...');
    const userFolderId = await initializeUserFolder();
    if (!userFolderId) {
      throw new Error('用户文件夹ID为空');
    }
    // initializeUserFolder 内部已经输出了详细信息，这里只做确认
    if (!CONFIG.userFolderId) {
      throw new Error('用户文件夹ID未设置');
    }
    console.log(`\n✅ [Drive] 确认：将监听用户专属文件夹`);
    const localFolderPath = getLocalDownloadFolder();
    console.log(`\n📂 [本地文件夹] 无法自动导入的文件将保存到: ${localFolderPath}`);
    console.log(`   💡 提示：视频文件（MP4/MOV）和过大的 GIF 文件会自动下载到此文件夹，可直接拖入 Figma`);
    console.log(`   📂 用户专属文件夹ID: ${CONFIG.userFolderId}`);
    console.log(`   ⚠️  不会监听共享文件夹根目录\n`);
  } catch (error) {
    console.warn('\n⚠️  初始化用户文件夹失败（可能是第一次使用，用户还未上传文件）');
    console.warn(`   错误信息: ${error.message}`);
    console.warn('\n💡 解决方案：');
    console.warn('   1. 如果是第一次使用，请先在手机端上传至少一个文件');
    console.warn('   2. 上传后，手动同步会自动重新初始化文件夹');
    console.warn('   3. 如果问题持续，请检查：');
    console.warn('      - GDRIVE_FOLDER_ID 环境变量是否正确');
    console.warn('      - serviceAccountKey.js 中的 defaultFolderId 是否正确');
    console.warn('      - Service Account 是否有访问和创建文件夹的权限\n');
    console.warn('   ℹ️  服务将继续运行，等待用户上传文件后重新初始化\n');
    // 不退出进程，继续运行，等待用户上传文件后在 performManualSync 中重新初始化
  }

  // 验证用户文件夹ID已设置（如果初始化失败则跳过）
  if (!CONFIG.userFolderId) {
    console.warn('⚠️  用户文件夹ID未设置，将在手动同步时重新初始化\n');
  }

  // 不再在启动时初始化已知文件列表
  // 改为在实时模式首次启动时初始化，这样手动模式可以同步所有历史文件
  // await initializeKnownFiles();
  connectWebSocket();

  // 启动定期缓存清理
  setInterval(cleanupCache, CLEANUP_INTERVAL_MS);
  console.log(`🧹 [缓存管理] 已启动定期清理，每 ${CLEANUP_INTERVAL_MS / 1000 / 60} 分钟执行一次`);

  process.on('SIGINT', () => {
    console.log('\n👋 [Drive] 停止服务');
    stopPolling();
    if (ws) ws.close();
    process.exit(0);
  });
}

start();

