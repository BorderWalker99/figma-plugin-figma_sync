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

const {
  getUserIdentifier,
  getUserFolderName,
  getOrCreateUserConfig,
  updateDriveFolderId,
  getDriveFolderId,
  getLocalDownloadFolder,
  getBackupGif,
  updateBackupGif
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
 * 将文件保存到本地文件夹
 */
async function saveFileToLocalFolder(buffer, filename, mimeType) {
  try {
    console.log(`   💾 [Local] 准备保存文件: ${filename}, 大小: ${buffer ? buffer.length : 0} 字节`);
    
    if (!buffer || buffer.length === 0) {
      console.error(`   ❌ [Local] Buffer 为空，无法保存`);
      return false;
    }

    const folderPath = ensureLocalDownloadFolder();
    if (!folderPath) {
      console.error(`   ❌ [Local] 无法获取/创建本地文件夹路径`);
      return false;
    }
    console.log(`   📂 [Local] 目标文件夹: ${folderPath}`);
    
    // 清理文件名，移除不安全字符，并根据 MIME 类型添加扩展名
    const safeFilename = sanitizeFilename(filename, mimeType);
    const filePath = path.join(folderPath, safeFilename);
    
    // 检查是否是视频或 GIF 文件
    const ext = path.extname(safeFilename).toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov' || (mimeType && mimeType.startsWith('video/'));
    const isGif = ext === '.gif' || (mimeType && mimeType === 'image/gif');
    
    // 如果是视频或 GIF 文件且已存在，直接替换；否则添加时间戳避免覆盖
    let finalPath = filePath;
    if (fs.existsSync(finalPath)) {
      if (isVideo || isGif) {
        // 视频或 GIF 文件：先删除旧文件，再写入新文件（确保直接替换）
        console.log(`   🔄 [Local] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，将替换: ${safeFilename}`);
        try {
          // 先尝试删除文件
          fs.unlinkSync(finalPath);
          // 等待一小段时间确保文件系统完成删除操作
          await new Promise(resolve => setTimeout(resolve, 10));
          // 验证文件是否已删除
          if (fs.existsSync(finalPath)) {
            console.warn(`   ⚠️  [Local] 文件删除后仍存在，尝试强制删除`);
            // 如果文件仍存在，可能是文件系统延迟，再次尝试删除
            try {
              fs.unlinkSync(finalPath);
            } catch (retryError) {
              console.warn(`   ⚠️  [Local] 强制删除失败: ${retryError.message}`);
            }
          } else {
            console.log(`   🗑️  [Local] 已删除旧文件: ${safeFilename}`);
          }
        } catch (deleteError) {
          console.warn(`   ⚠️  [Local] 删除旧文件失败，将直接覆盖: ${deleteError.message}`);
        }
        finalPath = filePath; // 使用原路径
      } else {
        // 其他文件：添加时间戳避免覆盖
      const nameWithoutExt = path.basename(safeFilename, ext);
      const timestamp = Date.now();
      finalPath = path.join(folderPath, `${nameWithoutExt}_${timestamp}${ext}`);
      }
    }
    
    // 确保目录存在（虽然应该已经存在，但以防万一）
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 使用 writeFileSync 的覆盖模式（如果文件存在会被覆盖）
    fs.writeFileSync(finalPath, buffer, { flag: 'w' });
    console.log(`   ✅ [Local] 文件已成功写入: ${finalPath}`);
    return true;
  } catch (error) {
    console.error(`   ❌ [Local] 保存文件到本地失败: ${error.message}`);
    return false;
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
  backupGif: getBackupGif()
};

// 监听 GIF 备份设置更新
const { getBackupGif: getBackupGifFromConfig } = require('./userConfig');
setInterval(() => {
  const currentBackupGif = getBackupGifFromConfig();
  if (CONFIG.backupGif !== currentBackupGif) {
    CONFIG.backupGif = currentBackupGif;
    console.log(`🔄 [Config] GIF 备份设置已更新为: ${CONFIG.backupGif}`);
  }
}, 2000);

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
let isPolling = false;
let lastPollTime = null;
let realTimeStart = null;

const knownFileIds = new Set();
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
  console.log('ℹ️  使用增量查询模式，不再全量扫描旧文件');
  
  // 清空已知文件列表（因为我们依赖时间戳过滤，不需要保留旧ID）
  knownFileIds.clear();
}

async function pollDrive() {
  if (!isRealTimeMode) return;
  if (isPolling) {
    console.log('⏳ [Drive] 上次轮询尚未结束，跳过本次轮询');
    return;
  }
  if (!CONFIG.userFolderId) {
    console.error('❌ 用户文件夹未初始化');
    return;
  }

  isPolling = true;
  const pollStart = new Date();

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
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    const newFiles = [];
    for (const file of imageFiles) {
      // 1. 去重
      if (knownFileIds.has(file.id)) continue;
      
      // 2. 严格时间过滤（只处理启动后创建的文件）
      const fileTime = new Date(file.createdTime);
      if (realTimeStart && fileTime < realTimeStart) {
        knownFileIds.add(file.id); // 标记为已知，下次不再处理
        continue;
      }
      
      knownFileIds.add(file.id);
      newFiles.push(file);
    }

    if (newFiles.length > 0) {
      console.log(`🔄 [Drive] 检测到 ${newFiles.length} 个新文件，并发处理...`);
      
      // 并发处理新文件（提高多图同步速度）
      const promises = newFiles.map(async (file) => {
        try {
          // 为每个文件添加 60 秒超时保护
          const fileTimeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`处理文件超时（${file.name}）`)), 60000);
          });
          
          await Promise.race([
            handleDriveFile(file, true),
            fileTimeout
          ]);
        } catch (fileError) {
          console.error(`   ❌ 处理文件失败: ${file.name}`, fileError.message);
          // 失败时移除，以便重试
          knownFileIds.delete(file.id);
        }
      });
      
      // 为整个并发处理添加总体超时（最多3分钟）
      const allTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('批量处理超时（超过3分钟）')), 180000);
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
  } finally {
    isPolling = false;
    if (isRealTimeMode && pollTimer) {
      pollTimer = setTimeout(pollDrive, CONFIG.pollIntervalMs);
    }
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
      
      // 将文件保存到本地文件夹，方便用户手动拖入
      const saved = await saveFileToLocalFolder(originalBuffer, file.name, file.mimeType);
      if (saved) {
        console.log(`   📂 文件已下载到本地文件夹，可直接拖入 Figma`);
        
        // 下载成功后，删除 Drive 中的文件
        try {
          console.log(`   🗑️  删除 Drive 文件: ${file.name} (ID: ${file.id})`);
          await trashFile(file.id);
          console.log(`   ✅ 已移至回收站`);
        } catch (error) {
          const errorMsg = error.message || String(error);
          if (errorMsg.includes('not found') || errorMsg.includes('404')) {
            console.log(`   ℹ️  Drive 文件已不存在（可能已被删除）: ${file.name}`);
          } else {
            console.error(`   ⚠️  删除 Drive 文件失败 (${file.name}):`, errorMsg);
          }
        }
      } else {
        console.log(`   ⚠️  文件保存失败，保留 Drive 文件以便重试`);
      }
      
      // 通知 Figma 插件此文件需要手动拖入（可选，因为视频文件不会发送到 Figma）
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'file-skipped',
          filename: file.name,
          reason: 'video' // 统一使用 video，包含 mp4 和 mov
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
        
        // 将文件保存到本地文件夹
        const saved = await saveFileToLocalFolder(originalBuffer, file.name, file.mimeType);
        if (saved) {
          console.log(`   📂 文件已下载到本地文件夹`);
          
          // 下载成功后，删除 Drive 中的文件
          try {
            console.log(`   🗑️  删除 Drive 文件: ${file.name} (ID: ${file.id})`);
            await trashFile(file.id);
            console.log(`   ✅ 已移至回收站`);
          } catch (error) {
            const errorMsg = error.message || String(error);
            if (errorMsg.includes('not found') || errorMsg.includes('404')) {
              console.log(`   ℹ️  Drive 文件已不存在（可能已被删除）: ${file.name}`);
            } else {
              console.error(`   ⚠️  删除 Drive 文件失败 (${file.name}):`, errorMsg);
            }
          }
        }
        
        // 通知 Figma 插件此文件需要手动拖入
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'file-skipped',
            filename: file.name,
            reason: 'gif-too-large'
          }));
        }
        
        // 跳过此文件，不发送到 Figma
        return;
      }
      
      // 文件大小合适，直接使用原始文件
      processedBuffer = originalBuffer;
      
      // 如果启用了 GIF 备份，保存副本到本地
      if (CONFIG.backupGif) {
        console.log(`   💾 [备份] 正在保存 GIF 副本到本地...`);
        // 使用 originalBuffer 确保使用未被清空的 buffer
        const saved = await saveFileToLocalFolder(processedBuffer, file.name, file.mimeType);
        backedUpLocally = saved || false; // 确保是 boolean
      } else {
        backedUpLocally = false; // 如果未启用备份，初始化为 false
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

    // 使用 base64 编码，避免 Array.from 创建巨大数组占用内存
    const base64String = processedBuffer.toString('base64');
    processedBuffer = null; // 立即释放内存

    const payload = {
      type: 'screenshot',
      bytes: base64String, // 直接使用 base64 字符串，Figma 端需要解码
      timestamp: Date.now(),
      filename: file.name,
      driveFileId: file.id,
      backedUpLocally: backedUpLocally || false // 确保 backedUpLocally 始终有值
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

async function performManualSync() {
  console.log('\n📦 [Drive] 执行手动同步...');
  console.log(`   ⏰ 开始时间: ${new Date().toLocaleTimeString()}`);
  
  if (!CONFIG.userFolderId) {
    console.error('❌ [Drive] 用户文件夹未初始化，无法执行手动同步');
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-complete',
        count: 0,
        total: 0,
        message: '用户文件夹未初始化'
      }));
    }
    return;
  }
  
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.error('❌ [Drive] WebSocket 未连接，无法执行手动同步');
    console.error(`   WebSocket 状态: ${ws ? ws.readyState : 'null'}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-complete',
        count: 0,
        total: 0,
        message: 'WebSocket 未连接'
      }));
    }
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
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
    console.log(`   🖼️  其中 ${imageFiles.length} 个是媒体文件`);
    
    if (imageFiles.length === 0) {
      console.log(`   ℹ️  用户专属文件夹中没有图片文件`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'manual-sync-complete',
          count: 0,
          total: 0,
          message: '文件夹中没有图片文件',
          errors: []
        }));
      }
      return;
    }

    let success = 0;
    // 收集所有处理过程中的错误
    const processingErrors = [];
    
    // 手动同步时，强制同步所有图片文件（不检查 knownFileIds）
    // 因为手动同步的目的就是同步残留的图片
    console.log(`   🔄 手动同步模式：将并发处理所有 ${imageFiles.length} 个图片文件`);
    
    // 使用并发处理提升性能，但限制并发数避免过载
    const CONCURRENT_LIMIT = 3; // 同时处理3个文件
    const results = [];
    
    for (let i = 0; i < imageFiles.length; i += CONCURRENT_LIMIT) {
      const batch = imageFiles.slice(i, i + CONCURRENT_LIMIT);
      console.log(`   📦 处理批次 ${Math.floor(i / CONCURRENT_LIMIT) + 1}/${Math.ceil(imageFiles.length / CONCURRENT_LIMIT)} (${batch.length} 个文件)`);
      
      const batchPromises = batch.map(async (file) => {
        const wasKnown = knownFileIds.has(file.id);
        if (!wasKnown) {
          knownFileIds.add(file.id);
        }
        
        // 为每个文件添加 60秒 超时保护
        const fileTimeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`处理文件超时（超过60秒）: ${file.name}`)), 60000);
        });
        
        const fileProcessing = (async () => {
          try {
            // 检查文件是否需要手动拖入（GIF过大或视频文件）
            const fileName = file.name.toLowerCase();
            const isGif = fileName.endsWith('.gif');
            
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
                  return { success: false, skipped: true, file };
                }
              } catch (checkError) {
                console.log(`   ⚠️  检查 GIF 大小失败，继续处理: ${checkError.message}`);
              }
            }
            
            // 调用通用处理函数
            await handleDriveFile(file, true);
            return { success: true, file };
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
      
      // 统计本批次结果
      batchResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value.success) {
          success += 1;
        }
      });
      
      results.push(...batchResults);
      
      // 批次间短暂延迟，避免过载
      if (i + CONCURRENT_LIMIT < imageFiles.length) {
        await sleep(200);
      }
    }

    console.log(`\n✅ [Drive] 手动同步完成`);
    console.log(`   ✅ 成功同步: ${success} 张截图`);
    console.log(`   📊 总计: ${imageFiles.length} 个图片文件`);
    if (processingErrors.length > 0) {
      console.log(`   ❌ 失败: ${processingErrors.length} 个`);
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'manual-sync-complete',
        count: success,
        total: imageFiles.length,
        errors: processingErrors // 发送错误列表
      };
      console.log(`   📤 发送完成消息: count=${success}, total=${imageFiles.length}, errors=${processingErrors.length}`);
      ws.send(JSON.stringify(message));
    }
  })(); // 结束 syncTask async 函数
  
  // 使用 Promise.race 应用总体超时
  try {
    await Promise.race([syncTask, overallTimeout]);
  } catch (error) {
    console.error('❌ 手动同步失败:', error.message);
    console.error('   错误堆栈:', error.stack);
    if (ws && ws.readyState === WebSocket.OPEN) {
      safeSend({
        type: 'manual-sync-complete',
        count: 0,
        total: 0,
        message: error.message,
        errors: [{ filename: '系统错误', error: error.message }]
      });
    }
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
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

      if (message.type === 'update-gif-backup-setting') {
        CONFIG.backupGif = !!message.enabled;
        updateBackupGif(CONFIG.backupGif);
        console.log(`📝 [Drive] GIF 自动备份已${CONFIG.backupGif ? '启用' : '禁用'}`);
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'gif-backup-setting-updated',
            enabled: CONFIG.backupGif
          }));
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
          } catch (error) {
            // 如果文件不存在，可能是已经被删除或不存在，这是正常的
            const errorMsg = error.message || String(error);
            if (errorMsg.includes('File not found') || 
                errorMsg.includes('not found') || 
                errorMsg.includes('404') ||
                errorMsg.includes('does not exist')) {
              console.log(`   ℹ️  Drive 文件已不存在（可能已被删除）: ${filename}`);
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
        // 先确保已知文件列表已初始化，避免处理已有文件
        console.log(`📊 [Drive] 当前 knownFileIds 数量: ${knownFileIds.size}`);
        if (knownFileIds.size === 0) {
          console.log('📂 [Drive] 初始化已知文件列表（避免处理已有文件）...');
          await initializeKnownFiles();
          console.log(`✅ [Drive] 初始化完成，已记录 ${knownFileIds.size} 个现有文件`);
        } else {
          console.log(`ℹ️  [Drive] 已知文件列表已存在，跳过初始化`);
        }
        isRealTimeMode = true;
        startPolling();
        // 注意：startPolling() 会立即执行一次 pollDrive()，但此时 knownFileIds 已经初始化
        // 所以不会处理已有文件，只会处理新文件
        return;
      }

      if (message.type === 'stop-realtime') {
        console.log('\n⏸️  [Drive] 停止实时同步模式');
        isRealTimeMode = false;
        stopPolling();
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
    console.error('\n❌ 初始化用户文件夹失败，无法启动');
    console.error(`   错误信息: ${error.message}`);
    if (error.stack) {
      console.error(`   错误堆栈:\n${error.stack}`);
    }
    console.error('\n💡 可能的解决方案：');
    console.error('   1. 检查 GDRIVE_FOLDER_ID 环境变量是否正确');
    console.error('   2. 检查 serviceAccountKey.js 中的 defaultFolderId 是否正确');
    console.error('   3. 确认 Service Account 有访问共享驱动器的权限');
    console.error('   4. 确认 Service Account 有在共享驱动器中创建文件夹的权限');
    console.error('   5. 检查 .user-config.json 中的 userId 是否正确\n');
    process.exit(1);
  }

  // 验证用户文件夹ID已设置
  if (!CONFIG.userFolderId) {
    console.error('❌ 用户文件夹ID未设置，无法继续');
    process.exit(1);
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

