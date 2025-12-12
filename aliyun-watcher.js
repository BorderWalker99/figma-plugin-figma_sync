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
  deleteFile,
  createFolder,
  getFileInfo
} = require('./aliyunOSS');

const {
  getUserIdentifier,
  getUserFolderName,
  getOrCreateUserConfig,
  updateOssFolderId,
  getOssFolderId,
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
    'video/x-m4v': '.mov'
  };
  
  return mimeToExt[mimeType.toLowerCase()] || '';
}

/**
 * 清理文件名，移除不安全字符，并根据 MIME 类型添加扩展名
 */
function sanitizeFilename(filename, mimeType) {
  // 移除路径分隔符和其他不安全字符
  let safeName = filename.replace(/[\/\\:*?"<>|]/g, '_');
  
  // 如果文件名没有扩展名，根据 MIME 类型添加
  const ext = path.extname(safeName).toLowerCase();
  if (!ext && mimeType) {
    const mimeExt = getExtensionFromMimeType(mimeType);
    if (mimeExt) {
      safeName += mimeExt;
    }
  }
  
  return safeName;
}

/**
 * 将文件保存到本地文件夹
 */
async function saveFileToLocalFolder(buffer, filename, mimeType) {
  try {
    const folderPath = ensureLocalDownloadFolder();
    if (!folderPath) {
      return false;
    }
    
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
        console.log(`   🔄 [OSS] 检测到重名 ${isVideo ? '视频' : 'GIF'} 文件，将替换: ${safeFilename}`);
        try {
          // 先尝试删除文件
          fs.unlinkSync(finalPath);
          // 等待一小段时间确保文件系统完成删除操作
          await new Promise(resolve => setTimeout(resolve, 10));
          // 验证文件是否已删除
          if (fs.existsSync(finalPath)) {
            console.warn(`   ⚠️  [OSS] 文件删除后仍存在，尝试强制删除`);
            // 如果文件仍存在，可能是文件系统延迟，再次尝试删除
            try {
              fs.unlinkSync(finalPath);
            } catch (retryError) {
              console.warn(`   ⚠️  [OSS] 强制删除失败: ${retryError.message}`);
            }
          } else {
            console.log(`   🗑️  [OSS] 已删除旧文件: ${safeFilename}`);
          }
        } catch (deleteError) {
          console.warn(`   ⚠️  [OSS] 删除旧文件失败，将直接覆盖: ${deleteError.message}`);
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
    console.log(`   💾 文件已保存到本地: ${finalPath}`);
    return true;
  } catch (error) {
    console.error(`   ❌ 保存文件到本地失败: ${error.message}`);
    return false;
  }
}

// 阿里云根文件夹路径（从环境变量读取）
let OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';

const CONFIG = {
  wsUrl: process.env.WS_URL || 'ws://localhost:8888',
  connectionId: process.env.CONNECTION_ID || 'sync-session-1',
  rootFolder: OSS_ROOT_FOLDER,
  userFolderId: null, // 将在初始化时设置（OSS 中的用户文件夹路径）
  pollIntervalMs: Number(process.env.OSS_POLL_INTERVAL_MS || 2000), // 默认2秒轮询
  maxWidth: Number(process.env.OSS_MAX_WIDTH || 1920),
  quality: Number(process.env.OSS_IMAGE_QUALITY || 85),
  processExisting: process.env.OSS_PROCESS_EXISTING === '1',
  autoDelete: process.env.OSS_AUTO_DELETE !== '0'
};

/**
 * 初始化用户文件夹
 * 如果用户文件夹不存在，则创建
 */
async function initializeUserFolder() {
  try {
    const userFolderName = getUserFolderName();
    const expectedUserId = getUserIdentifier();
    
    console.log(`\n🔍 [OSS] 初始化用户文件夹检查`);
    console.log(`   👤 用户ID: ${expectedUserId}`);
    console.log(`   📁 期望文件夹名称: ${userFolderName}`);
    console.log(`   📂 OSS 根文件夹: ${CONFIG.rootFolder}`);
    
    // 先检查配置文件中是否有用户文件夹路径（使用 OSS 专用字段）
    let userFolderPath = getOssFolderId();
    
    if (userFolderPath) {
      console.log(`   📋 配置文件中的文件夹路径: ${userFolderPath}`);
      
      // 验证文件夹是否存在
      try {
        // 尝试列出文件夹中的文件（验证文件夹是否存在）
        await listFolderFiles({ folderId: userFolderPath, pageSize: 1 });
        console.log(`   ✅ 配置文件中的文件夹路径有效`);
        console.log(`   📂 使用现有用户文件夹: ${userFolderPath}`);
        CONFIG.userFolderId = userFolderPath;
        return userFolderPath;
      } catch (error) {
        console.log(`   ⚠️  配置文件中的文件夹路径无效: ${error.message}`);
        console.log(`   🔄 将重新创建用户文件夹`);
        userFolderPath = null;
      }
    } else {
      console.log(`   ℹ️  配置文件中没有用户文件夹路径`);
    }
    
    // 创建用户文件夹（如果不存在）
    console.log(`\n📁 [OSS] 正在创建/查找用户专属文件夹: ${userFolderName}`);
    
    // 构建完整路径：rootFolder/userFolderName
    const fullFolderPath = `${CONFIG.rootFolder}/${userFolderName}`;
    
    console.log(`   🔍 正在检查文件夹是否已存在...`);
    let folder;
    try {
      folder = await createFolder({
        folderName: userFolderName,
        parentFolderId: CONFIG.rootFolder
      });
      console.log(`   ✅ 文件夹操作成功`);
    } catch (error) {
      console.error(`   ❌ 创建/查找文件夹失败: ${error.message}`);
      throw error;
    }
    
    userFolderPath = folder.id; // OSS 中文件夹路径
    
    // 验证返回的文件夹路径
    if (!userFolderPath) {
      throw new Error('创建文件夹后未返回文件夹路径');
    }
    
    console.log(`   ✅ 用户文件夹路径: ${userFolderPath}`);
    
    // 保存到配置文件（使用 OSS 专用字段）
    updateOssFolderId(userFolderPath);
    CONFIG.userFolderId = userFolderPath;
    
    // 再次验证文件夹路径是否正确
    try {
      const { files } = await listFolderFiles({ folderId: userFolderPath, pageSize: 1 });
      console.log(`   ✅ 验证成功：文件夹存在，包含 ${files.length} 个文件`);
    } catch (error) {
      console.error(`   ⚠️  验证失败：无法访问文件夹: ${error.message}`);
      throw new Error(`用户文件夹路径验证失败: ${error.message}`);
    }
    
    console.log(`\n✅ [OSS] 用户文件夹初始化完成`);
    console.log(`   📂 用户专属文件夹路径: ${CONFIG.userFolderId}`);
    console.log(`   📁 用户专属文件夹名称: ${userFolderName}`);
    console.log(`   📂 OSS 根文件夹: ${CONFIG.rootFolder} (仅用于创建子文件夹)`);
    console.log(`   ⚠️  重要：将监听用户专属文件夹，不会监听根文件夹\n`);
    
    return userFolderPath;
  } catch (error) {
    console.error('❌ 初始化用户文件夹失败:', error.message);
    console.error('   错误堆栈:', error.stack);
    throw error;
  }
}

let ws = null;
let pollTimer = null;
let isRealTimeMode = false;

const knownFileIds = new Set();
const pendingDeletes = new Map(); // fileId -> { filename, timestamp }
const MAX_KNOWN_FILES = 10000; // 限制已知文件数量，防止内存无限增长
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 每5分钟清理一次

async function initializeKnownFiles() {
  if (!CONFIG.userFolderId) {
    throw new Error('用户文件夹未初始化');
  }
  
  if (CONFIG.processExisting) {
    console.log('ℹ️  OSS_PROCESS_EXISTING=1，将处理文件夹中现有文件');
    return;
  }

  try {
    console.log(`📂 [OSS] 初始化已知文件列表，监听文件夹: ${CONFIG.userFolderId}`);
    
    // 获取所有文件（处理分页）
    let allFiles = [];
    let nextPageToken = null;
    
    do {
      const result = await listFolderFiles({ 
        folderId: CONFIG.userFolderId, 
        pageSize: 200,
        pageToken: nextPageToken
      });
      
      if (result.files && result.files.length > 0) {
        allFiles = allFiles.concat(result.files);
      }
      
      nextPageToken = result.nextPageToken;
    } while (nextPageToken);
    
    allFiles.forEach((file) => knownFileIds.add(file.id));
    console.log(`ℹ️  已记录 ${allFiles.length} 个现有文件（不会重新同步）`);
  } catch (error) {
    console.error('⚠️  初始化 OSS 文件列表失败:', error.message);
  }
}

async function pollOSS() {
  if (!isRealTimeMode) {
    return;
  }
  
  if (!CONFIG.userFolderId) {
    console.error('❌ 用户文件夹未初始化');
    return;
  }

  try {
    // 获取所有文件（处理分页）
    let allFiles = [];
    let nextPageToken = null;
    let pageCount = 0;
    
    console.log(`🔍 [OSS] 正在轮询文件夹: ${CONFIG.userFolderId}`);
    
    do {
      const result = await listFolderFiles({ 
        folderId: CONFIG.userFolderId, 
        pageSize: 100, // 增加每页大小，减少请求次数
        orderBy: 'LastModified',
        pageToken: nextPageToken
      });
      
      if (result.files && result.files.length > 0) {
        allFiles = allFiles.concat(result.files);
        pageCount++;
        console.log(`   📄 第 ${pageCount} 页: 获取到 ${result.files.length} 个文件`);
      }
      
      nextPageToken = result.nextPageToken;
    } while (nextPageToken);
    
    if (pageCount > 1) {
      console.log(`📄 [OSS] 获取了 ${pageCount} 页文件，共 ${allFiles.length} 个文件`);
    } else if (allFiles.length > 0) {
      console.log(`📄 [OSS] 获取了 ${allFiles.length} 个文件`);
    } else {
      console.log(`📄 [OSS] 文件夹为空，没有文件`);
    }
    
    // 过滤图片和视频文件
    const imageFiles = allFiles.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      const isImageByMime = mimeType.startsWith('image/');
      const isVideoByMime = mimeType.startsWith('video/');
      const hasImageExt = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(name);
      const hasVideoExt = /\.(mp4|mov)$/i.test(name);
      
      const result = isImageByMime || isVideoByMime || hasImageExt || hasVideoExt;
      
      // 只在调试模式下打印被过滤的文件（避免日志过多）
      if (!result && file.name && allFiles.length <= 10) {
        console.log(`   ⚠️  文件被过滤: ${file.name} (MIME: ${mimeType || '未设置'}, 扩展名: ${name.split('.').pop() || '无'})`);
      }
      
      return result;
    });
    
    console.log(`🖼️  [OSS] 过滤后找到 ${imageFiles.length} 个图片/视频文件`);
    
    const newFiles = [];

    imageFiles.forEach((file) => {
      if (!knownFileIds.has(file.id)) {
        knownFileIds.add(file.id);
        newFiles.push(file);
      }
    });

    // 按创建时间排序，确保按顺序处理
    newFiles.sort((a, b) => new Date(a.createdTime || a.modifiedTime) - new Date(b.createdTime || b.modifiedTime));

    // 立即处理新文件，不等待下一个轮询周期
    if (newFiles.length > 0) {
      console.log(`🔄 [OSS] 检测到 ${newFiles.length} 个新文件，立即处理...`);
      for (const file of newFiles) {
        try {
          await handleOSSFile(file, true);
          // 文件之间短暂延迟，避免请求过快
          await sleep(100);
        } catch (fileError) {
          // 单个文件处理失败不影响其他文件
          console.error(`   ❌ 处理文件失败: ${file.name}`, fileError.message);
          // 从 knownFileIds 中移除，以便下次重试
          knownFileIds.delete(file.id);
        }
      }
    } else {
      console.log(`✅ [OSS] 没有新文件需要处理`);
    }
  } catch (error) {
    console.error('⚠️  拉取 OSS 文件失败:', error.message);
    if (error.stack) {
      console.error('   错误堆栈:', error.stack);
    }
  }
}

async function handleOSSFile(file, deleteAfterSync = false) {
  // 返回处理结果：{ success: boolean, skipped: boolean, reason?: string }
  // success: 是否成功导入到 Figma
  // skipped: 是否跳过（视频或过大的 GIF）
  // reason: 跳过的原因
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('服务器未连接');
    }

    const startTime = Date.now();
    console.log(`\n📥 [OSS] 下载文件: ${file.name} (${file.id})`);

    let originalBuffer = await downloadFileBuffer(file.id);
    const downloadTime = Date.now() - startTime;
    const downloadedSizeKB = (originalBuffer.length / 1024).toFixed(2);
    console.log(`   ⬇️  下载完成 (${downloadedSizeKB} KB, ${downloadTime}ms)`);

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
      const mimeType = (file.mimeType || '').toLowerCase();
      isVideo = mimeType.startsWith('video/') || 
                mimeType === 'video/mp4' || 
                mimeType === 'video/quicktime' ||
                mimeType === 'video/x-m4v';
    }
    
    // 检测是否为 GIF 格式
    let isGif = fileNameIsGif;
    if (!isGif) {
      const mimeType = (file.mimeType || '').toLowerCase();
      if (mimeType === 'image/gif') {
        isGif = true;
      } else {
        try {
          const sharpImage = sharp(originalBuffer);
          const metadata = await sharpImage.metadata();
          isGif = metadata.format === 'gif';
        } catch (metaError) {
          isGif = false;
        }
      }
    }
    
    // 检测是否为 HEIF 格式
    let isHeif = fileNameIsHeif;
    if (!isHeif) {
      try {
        const sharpImage = sharp(originalBuffer);
        const metadata = await sharpImage.metadata();
        isHeif = metadata.format === 'heif' || metadata.format === 'heic';
      } catch (metaError) {
        const errorMsg = metaError.message.toLowerCase();
        if (errorMsg.includes('heif') || errorMsg.includes('heic') || errorMsg.includes('codec')) {
          isHeif = true;
        }
      }
    }
    
    if (isVideo) {
      // 视频格式（MP4 或 MOV）
      const videoFormat = fileName.endsWith('.mp4') ? 'MP4' : 'MOV';
      console.log(`   🎥 检测到 ${videoFormat} 视频格式`);
      console.log(`   ⚠️  Figma 插件 API 不支持视频文件，跳过此文件`);
      console.log(`   💡 提示：请通过 Figma 界面直接拖放视频文件，或使用 GIF 格式`);
      
      // 将文件保存到本地文件夹
      const saved = await saveFileToLocalFolder(originalBuffer, file.name, file.mimeType);
      if (saved) {
        console.log(`   📂 文件已下载到本地文件夹，可直接拖入 Figma`);
        
        // 下载成功后，删除 OSS 中的文件
        try {
          console.log(`   🗑️  删除 OSS 文件: ${file.name} (路径: ${file.id})`);
          await deleteFile(file.id);
          console.log(`   ✅ 已删除`);
        } catch (error) {
          const errorMsg = error.message || String(error);
          if (errorMsg.includes('not found') || errorMsg.includes('404') || errorMsg.includes('NoSuchKey')) {
            console.log(`   ℹ️  OSS 文件已不存在（可能已被删除）: ${file.name}`);
          } else {
            console.error(`   ⚠️  删除 OSS 文件失败 (${file.name}):`, errorMsg);
          }
        }
      }
      
      // 通知 Figma 插件此文件需要手动拖入
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'file-skipped',
          filename: file.name,
          reason: 'video'
        }));
      }
      
      return { success: false, skipped: true, reason: 'video' };
    } else if (isGif) {
      // GIF 格式，检查文件大小
      console.log(`   🎬 检测到 GIF 格式...`);
      
      const originalSize = originalBuffer.length;
      const maxGifSize = 100 * 1024 * 1024; // 100MB（防止 Figma 死机）
      
      if (originalSize > maxGifSize) {
        const fileSizeMB = (originalSize / 1024 / 1024).toFixed(2);
        console.log(`   ⚠️  GIF 文件过大 (${fileSizeMB}MB)，超过限制 (100MB)`);
        console.log(`   ⚠️  为防止 Figma 死机，将保存到本地文件夹，可直接拖入 Figma`);
        
        // 将文件保存到本地文件夹
        const saved = await saveFileToLocalFolder(originalBuffer, file.name, file.mimeType);
        if (saved) {
          console.log(`   📂 文件已下载到本地文件夹`);
          
          // 下载成功后，删除 OSS 中的文件
          try {
            console.log(`   🗑️  删除 OSS 文件: ${file.name} (路径: ${file.id})`);
            await deleteFile(file.id);
            console.log(`   ✅ 已删除`);
          } catch (error) {
            const errorMsg = error.message || String(error);
            if (errorMsg.includes('not found') || errorMsg.includes('404') || errorMsg.includes('NoSuchKey')) {
              console.log(`   ℹ️  OSS 文件已不存在（可能已被删除）: ${file.name}`);
            } else {
              console.error(`   ⚠️  删除 OSS 文件失败 (${file.name}):`, errorMsg);
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
        
        return { success: false, skipped: true, reason: 'gif-too-large' };
      }
      
      // 文件大小合适，直接使用原始文件
      processedBuffer = originalBuffer;
      originalBuffer = null;
      const fileSizeKB = (processedBuffer.length / 1024).toFixed(2);
      console.log(`   ✅ 使用原始 GIF 文件: ${fileSizeKB}KB`);
    } else if (isHeif && os.platform() === 'darwin') {
      // 使用 macOS 自带的 sips 命令转换 HEIF 到 JPEG
      console.log(`   🔄 检测到 HEIF 格式，使用 sips 转换为 JPEG...`);
      
      let tempInputPath = path.join(os.tmpdir(), `heif-input-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.heic`);
      let tempOutputPath = path.join(os.tmpdir(), `jpeg-output-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`);
      
      try {
        fs.writeFileSync(tempInputPath, originalBuffer);
        
        const sipsCommand = `sips -s format jpeg "${tempInputPath}" --out "${tempOutputPath}"`;
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
        
        let convertedBuffer = fs.readFileSync(tempOutputPath);
        
        processedBuffer = await sharp(convertedBuffer)
          .resize(CONFIG.maxWidth, null, {
            withoutEnlargement: true,
            fit: 'inside'
          })
          .jpeg({ quality: CONFIG.quality })
          .toBuffer();
        
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
        
        originalBuffer = null;
        convertedBuffer = null;
      } catch (sipsError) {
        console.log(`   ❌ sips 转换失败: ${sipsError.message}`);
        if (sipsError.stack) {
          console.log(`   错误堆栈: ${sipsError.stack}`);
        }
        console.log(`   ⚠️  跳过此文件（无法转换 HEIF 格式）`);
        
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
        
        return;
      }
    } else if (isHeif) {
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
        
        originalBuffer = null;
      } catch (error) {
        console.log(`   ⚠️  压缩失败，使用原始文件: ${error.message}`);
        processedBuffer = originalBuffer;
      }
    }

    // 使用 base64 编码
    const base64String = processedBuffer.toString('base64');
    processedBuffer = null; // 立即释放内存

    const payload = {
      type: 'screenshot',
      bytes: base64String,
      timestamp: Date.now(),
      filename: file.name,
      ossFileId: file.id // 使用 ossFileId 而不是 driveFileId
    };

    const sendStartTime = Date.now();
    ws.send(JSON.stringify(payload));
    const sendTime = Date.now() - sendStartTime;
    const totalTime = Date.now() - startTime;
    console.log(`   ⬆️  已发送到 Figma 插件 (总耗时: ${totalTime}ms, 发送: ${sendTime}ms)`);

    if (deleteAfterSync && CONFIG.autoDelete) {
      const deleteTimeout = 90000; // 增加到 90 秒，给大文件（如 GIF）更多处理时间
      pendingDeletes.set(file.id, {
        filename: file.name,
        timestamp: Date.now()
      });
      console.log(`   ⏳ 等待 Figma 确认后删除 OSS 文件 (路径: ${file.id}, 超时: ${deleteTimeout/1000}秒)`);

      const timeoutId = setTimeout(() => {
        if (pendingDeletes.has(file.id)) {
          const elapsed = Date.now() - pendingDeletes.get(file.id).timestamp;
          console.log(`   ⚠️  等待确认超时（${elapsed/1000}秒），保留文件: ${file.name}`);
          console.log(`   💡 提示：如果文件已成功导入到 Figma，可能是确认消息未正确发送或接收`);
          pendingDeletes.delete(file.id);
        }
      }, deleteTimeout);
      
      // 保存 timeout ID，以便在收到确认消息时清除
      const deleteInfo = pendingDeletes.get(file.id);
      if (deleteInfo) {
        deleteInfo.timeoutId = timeoutId;
      }
    }
    
    // 成功导入到 Figma
    return { success: true, skipped: false };
  } catch (error) {
    console.error(`   ❌ 处理 OSS 文件失败 (${file.name}):`, error.message);
    throw error;
  }
}

async function performManualSync() {
  console.log('\n📦 [OSS] 执行手动同步...');
  
  if (!CONFIG.userFolderId) {
    console.error('❌ [OSS] 用户文件夹未初始化，无法执行手动同步');
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
    console.error('❌ [OSS] WebSocket 未连接，无法执行手动同步');
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

  try {
    console.log(`   🔍 正在获取文件列表...`);
    
    // 添加超时保护
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('获取文件列表超时（超过40秒）')), 40000);
    });
    
    // 获取所有文件（处理分页）
    const listPromise = (async () => {
      let allFiles = [];
      let nextPageToken = null;
      
      do {
        const result = await listFolderFiles({ 
          folderId: CONFIG.userFolderId, 
          pageSize: 200, 
          orderBy: 'LastModified',
          pageToken: nextPageToken
        });
        
        if (result.files && result.files.length > 0) {
          allFiles = allFiles.concat(result.files);
        }
        
        nextPageToken = result.nextPageToken;
      } while (nextPageToken);
      
      return allFiles;
    })();
    
    const allFiles = await Promise.race([listPromise, timeoutPromise]);

    console.log(`   📋 找到 ${allFiles.length} 个文件`);

    // 调试：打印所有文件信息
    if (allFiles.length > 0) {
      console.log(`   🔍 文件详情：`);
      allFiles.forEach((file, index) => {
        console.log(`      ${index + 1}. ${file.name || '(无文件名)'}`);
        console.log(`         - MIME类型: ${file.mimeType || '(未设置)'}`);
        console.log(`         - 大小: ${file.size ? (file.size / 1024).toFixed(2) + ' KB' : '(未知)'}`);
        console.log(`         - ID: ${file.id || '(无ID)'}`);
      });
    }

    // 过滤图片和视频文件
    // 优先根据 MIME 类型判断，即使没有扩展名也能识别
    const imageFiles = allFiles.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      
      // 根据 MIME 类型判断（最可靠）
      const isImageByMime = mimeType.startsWith('image/');
      const isVideoByMime = mimeType.startsWith('video/');
      
      // 根据文件扩展名判断（作为补充）
      const hasImageExt = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(name);
      const hasVideoExt = /\.(mp4|mov)$/i.test(name);
      
      // 如果 MIME 类型是 application/octet-stream，尝试从文件名推断
      const isOctetStream = mimeType === 'application/octet-stream' || !mimeType;
      const inferredFromName = hasImageExt || hasVideoExt;
      
      const result = isImageByMime || isVideoByMime || (isOctetStream && inferredFromName);
      
      if (!result && file.name) {
        console.log(`   ⚠️  文件被过滤: ${file.name} (MIME: ${mimeType || '未设置'}, 扩展名: ${name.split('.').pop() || '无'})`);
      }
      
      return result;
    });
    
    console.log(`   🖼️  其中 ${imageFiles.length} 个是媒体文件`);

    if (imageFiles.length === 0) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'manual-sync-complete',
          count: 0,
          total: 0,
          message: '文件夹中没有图片文件'
        }));
      }
      return;
    }

    let success = 0;
    // 收集所有处理过程中的错误
    const processingErrors = [];
    
    for (const file of imageFiles) {
      // 添加到已知文件列表（如果还没有）
      const wasKnown = knownFileIds.has(file.id);
      if (!wasKnown) {
        knownFileIds.add(file.id);
      }
      
      // 处理文件（手动同步时强制处理所有文件）
      try {
        // 调用 handleOSSFile 处理文件（会自动处理视频和过大的 GIF）
        const result = await handleOSSFile(file, true);
        
        // 根据处理结果决定是否计入成功
        if (result && result.success && !result.skipped) {
          // 成功导入到 Figma，计入成功
          success += 1;
        } else if (result && result.skipped) {
          // 文件被跳过（视频或过大的 GIF），已保存到本地并删除云端，不计入成功
          console.log(`   ℹ️  文件已处理（${result.reason}），不计入成功计数: ${file.name}`);
        }
        await sleep(300); // 避免请求过快
      } catch (error) {
        console.error(`   ❌ 处理文件失败: ${file.name}`, error.message);
        // 收集详细错误信息
        processingErrors.push({
          filename: file.name,
          error: error.message,
          stack: error.stack
        });
        if (!wasKnown) {
          knownFileIds.delete(file.id);
        }
      }
    }

    console.log(`\n✅ [OSS] 手动同步完成`);
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
      ws.send(JSON.stringify(message));
    }
  } catch (error) {
    console.error('❌ 手动同步失败:', error.message);
    console.error('   错误堆栈:', error.stack);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'manual-sync-complete',
        count: 0,
        total: 0,
        message: error.message,
        errors: [{ filename: '系统错误', error: error.message }]
      }));
    }
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollOSS();
  pollTimer = setInterval(pollOSS, CONFIG.pollIntervalMs);
  const intervalSeconds = (CONFIG.pollIntervalMs / 1000).toFixed(1);
  console.log(`🕒 [OSS] 开始轮询，每 ${intervalSeconds} 秒检查一次（已立即执行首次检查）`);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🛑 [OSS] 停止轮询');
  }
}

function connectWebSocket() {
  console.log('🔌 [OSS] 正在连接服务器...');

  ws = new WebSocket(`${CONFIG.wsUrl}?id=${CONFIG.connectionId}&type=mac`);

  ws.on('open', () => {
    console.log('✅ [OSS] 已连接到服务器');
  });

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'switch-sync-mode') {
        console.log('\n🔄 [OSS] 收到模式切换消息');
        console.log('   目标模式:', message.mode);
        if (message.mode !== 'aliyun' && message.mode !== 'oss') {
          console.log('⚠️  [OSS] 当前是阿里云 watcher，需要切换到其他模式');
          console.log('   正在退出，请等待 start.js 重启正确的 watcher...\n');
          stopPolling();
          if (ws) {
            ws.close();
          }
          setTimeout(() => {
            process.exit(0);
          }, 1000);
        }
        return;
      }

      if (message.type === 'screenshot-failed') {
        const filename = message.filename;
        const ossFileId = message.ossFileId || message.fileId;
        const keepFile = message.keepFile === true;
        
        if (keepFile) {
          console.log(`   ⚠️  文件导入失败，保留源文件: ${filename}`);
          
          let removed = false;
          if (ossFileId && pendingDeletes.has(ossFileId)) {
            pendingDeletes.delete(ossFileId);
            console.log(`   ✅ 已取消删除计划: ${filename} (路径: ${ossFileId})`);
            removed = true;
          } else {
            for (const [fileId, info] of pendingDeletes.entries()) {
              if (info.filename === filename) {
                pendingDeletes.delete(fileId);
                console.log(`   ✅ 已取消删除计划: ${filename} (路径: ${fileId})`);
                removed = true;
                break;
              }
            }
          }
          
          if (!removed) {
            console.log(`   ℹ️  文件不在待删除列表中: ${filename}（可能已经处理或未计划删除）`);
          }
        }
        return;
      }

      if (message.type === 'screenshot-received') {
        const filename = message.filename;
        const ossFileId = message.ossFileId || message.fileId;
        
        console.log(`   ✅ [OSS] 收到 Figma 确认消息: ${filename}`);
        if (ossFileId) {
          console.log(`      OSS 文件ID: ${ossFileId}`);
        } else {
          console.log(`      ⚠️  警告：确认消息中未包含 ossFileId，将尝试通过文件名匹配`);
        }
        
        let shouldDelete = false;
        let deleteInfo = null;
        let fileIdToDelete = null;
        
        if (ossFileId) {
          if (pendingDeletes.has(ossFileId)) {
            deleteInfo = pendingDeletes.get(ossFileId);
            fileIdToDelete = ossFileId;
            shouldDelete = true;
            // 清除超时定时器
            if (deleteInfo.timeoutId) {
              clearTimeout(deleteInfo.timeoutId);
            }
            pendingDeletes.delete(ossFileId);
            console.log(`      ✅ 通过 OSS 文件ID 匹配到待删除记录`);
          }
        }
        
        if (!deleteInfo) {
          for (const [fileId, info] of pendingDeletes.entries()) {
            if (info.filename === filename) {
              deleteInfo = info;
              fileIdToDelete = fileId;
              shouldDelete = true;
              // 清除超时定时器
              if (info.timeoutId) {
                clearTimeout(info.timeoutId);
              }
              pendingDeletes.delete(fileId);
              console.log(`      ✅ 通过文件名匹配到待删除记录: ${fileId}`);
              break;
            }
          }
        }
        
        if (shouldDelete && deleteInfo && fileIdToDelete) {
          try {
            const elapsed = Date.now() - deleteInfo.timestamp;
            console.log(`   🗑️  删除 OSS 文件: ${filename} (路径: ${fileIdToDelete}, 等待时间: ${(elapsed/1000).toFixed(1)}秒)`);
            await deleteFile(fileIdToDelete);
            console.log(`   ✅ 已删除`);
          } catch (error) {
            const errorMsg = error.message || String(error);
            if (errorMsg.includes('not found') || errorMsg.includes('404') || errorMsg.includes('NoSuchKey')) {
              console.log(`   ℹ️  OSS 文件已不存在（可能已被删除）: ${filename}`);
            } else {
              console.error(`   ⚠️  删除 OSS 文件失败 (${filename}):`, errorMsg);
            }
          }
        } else {
          console.log(`   ℹ️  文件不在待删除列表中: ${filename}`);
          console.log(`      💡 可能原因：1) 文件已超时被移除 2) 文件从未被标记为删除 3) 文件ID不匹配`);
          if (pendingDeletes.size > 0) {
            console.log(`      📋 当前待删除列表 (${pendingDeletes.size} 个):`);
            for (const [id, info] of pendingDeletes.entries()) {
              const age = ((Date.now() - info.timestamp) / 1000).toFixed(1);
              console.log(`         - ${info.filename} (ID: ${id}, 等待: ${age}秒)`);
            }
          }
        }
        return;
      }

      if (message.type === 'start-realtime') {
        console.log('\n🎯 [OSS] 启动实时同步模式...');
        // 先确保已知文件列表已初始化，避免处理已有文件
        if (knownFileIds.size === 0) {
          console.log('📂 [OSS] 初始化已知文件列表（避免处理已有文件）...');
          await initializeKnownFiles();
        }
        isRealTimeMode = true;
        startPolling();
        // 注意：startPolling() 会立即执行一次 pollOSS()，但此时 knownFileIds 已经初始化
        // 所以不会处理已有文件，只会处理新文件
        return;
      }

      if (message.type === 'stop-realtime') {
        console.log('\n⏸️  [OSS] 停止实时同步模式');
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
    console.log('⚠️  [OSS] 服务器连接断开，5秒后重连');
    isRealTimeMode = false;
    stopPolling();
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (error) => {
    console.error('❌ [OSS] WebSocket 错误:', error.message);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupCache() {
  if (knownFileIds.size > MAX_KNOWN_FILES) {
    const toRemove = knownFileIds.size - MAX_KNOWN_FILES;
    const idsArray = Array.from(knownFileIds);
    for (let i = 0; i < Math.floor(toRemove / 2); i++) {
      knownFileIds.delete(idsArray[i]);
    }
    console.log(`🧹 [缓存清理] 已清理 ${Math.floor(toRemove / 2)} 个旧文件ID，当前: ${knownFileIds.size}`);
  }
  
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
  
  if (global.gc) {
    global.gc();
    const used = process.memoryUsage();
    console.log(`📊 [内存] RSS: ${(used.rss / 1024 / 1024).toFixed(2)} MB, Heap: ${(used.heapUsed / 1024 / 1024).toFixed(2)}/${(used.heapTotal / 1024 / 1024).toFixed(2)} MB`);
  }
}

async function start() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  阿里云截图同步 - Mac 监听器     ║');
  console.log('╚════════════════════════════════════════╝\n');

  // 初始化用户文件夹
  try {
    console.log('📋 [OSS] 开始初始化用户文件夹...');
    const userFolderPath = await initializeUserFolder();
    if (!userFolderPath) {
      throw new Error('用户文件夹路径为空');
    }
    if (!CONFIG.userFolderId) {
      throw new Error('用户文件夹路径未设置');
    }
    console.log(`\n✅ [OSS] 确认：将监听用户专属文件夹`);
    const localFolderPath = getLocalDownloadFolder();
    console.log(`\n📂 [本地文件夹] 无法自动导入的文件将保存到: ${localFolderPath}`);
    console.log(`   💡 提示：视频文件（MP4/MOV）和过大的 GIF 文件会自动下载到此文件夹，可直接拖入 Figma`);
    console.log(`   📂 用户专属文件夹路径: ${CONFIG.userFolderId}`);
    console.log(`   ⚠️  不会监听根文件夹\n`);
  } catch (error) {
    console.error('\n❌ 初始化用户文件夹失败，无法启动');
    console.error(`   错误信息: ${error.message}`);
    if (error.stack) {
      console.error(`   错误堆栈:\n${error.stack}`);
    }
    console.error('\n💡 可能的解决方案：');
    console.error('   1. 检查 ALIYUN_ACCESS_KEY_ID 环境变量是否正确');
    console.error('   2. 检查 ALIYUN_ACCESS_KEY_SECRET 环境变量是否正确');
    console.error('   3. 检查 ALIYUN_BUCKET 环境变量是否正确');
    console.error('   4. 检查 ALIYUN_REGION 环境变量是否正确（可选，默认 oss-cn-hangzhou）');
    console.error('   5. 检查 .user-config.json 中的 userId 是否正确\n');
    process.exit(1);
  }

  if (!CONFIG.userFolderId) {
    console.error('❌ 用户文件夹路径未设置，无法继续');
    process.exit(1);
  }

  // 不再在启动时初始化已知文件列表
  // 改为在实时模式首次启动时初始化，这样手动模式可以同步所有历史文件
  // await initializeKnownFiles();
  connectWebSocket();

  setInterval(cleanupCache, CLEANUP_INTERVAL_MS);
  console.log(`🧹 [缓存管理] 已启动定期清理，每 ${CLEANUP_INTERVAL_MS / 1000 / 60} 分钟执行一次`);
  
  // 显示本地下载文件夹路径
  const localFolderPath = getLocalDownloadFolder();
  console.log(`\n📂 [本地文件夹] 无法自动导入的文件将保存到: ${localFolderPath}`);
  console.log(`   💡 提示：视频文件（MP4/MOV）和过大的 GIF 文件会自动下载到此文件夹，可直接拖入 Figma`);

  process.on('SIGINT', () => {
    console.log('\n👋 [OSS] 停止服务');
    stopPolling();
    if (ws) ws.close();
    process.exit(0);
  });
}

start();

