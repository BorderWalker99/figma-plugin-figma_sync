require('dotenv').config();
const WebSocket = require('ws');
const sharp = require('sharp');
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
  updateUserFolderId,
  getUserFolderId,
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
    
    // 如果文件已存在，添加时间戳避免覆盖
    let finalPath = filePath;
    if (fs.existsSync(finalPath)) {
      const ext = path.extname(safeFilename);
      const nameWithoutExt = path.basename(safeFilename, ext);
      const timestamp = Date.now();
      finalPath = path.join(folderPath, `${nameWithoutExt}_${timestamp}${ext}`);
    }
    
    // 确保目录存在（虽然应该已经存在，但以防万一）
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(finalPath, buffer);
    console.log(`   💾 文件已保存到本地: ${finalPath}`);
    return true;
  } catch (error) {
    console.error(`   ❌ 保存文件到本地失败: ${error.message}`);
    return false;
  }
}

// 阿里云 OSS 根文件夹路径（从环境变量读取）
let OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync';

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
    
    // 先检查配置文件中是否有用户文件夹路径
    let userFolderPath = getUserFolderId();
    
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
    
    // 保存到配置文件
    updateUserFolderId(userFolderPath);
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
      }
      
      nextPageToken = result.nextPageToken;
    } while (nextPageToken);
    
    if (pageCount > 1) {
      console.log(`📄 [OSS] 获取了 ${pageCount} 页文件，共 ${allFiles.length} 个文件`);
    }
    
    // 过滤图片和视频文件
    const imageFiles = allFiles.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
    });
    
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
    }
  } catch (error) {
    console.error('⚠️  拉取 OSS 文件失败:', error.message);
    if (error.stack) {
      console.error('   错误堆栈:', error.stack);
    }
  }
}

async function handleOSSFile(file, deleteAfterSync = false) {
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
      
      return;
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
        
        return;
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
      pendingDeletes.set(file.id, {
        filename: file.name,
        timestamp: Date.now()
      });
      console.log(`   ⏳ 等待 Figma 确认后删除 OSS 文件 (路径: ${file.id})`);

      setTimeout(() => {
        if (pendingDeletes.has(file.id)) {
          console.log(`   ⚠️  等待确认超时（30秒），保留文件: ${file.name}`);
          pendingDeletes.delete(file.id);
        }
      }, 30000);
    }
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
    // 获取所有文件（处理分页）
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

    console.log(`   📋 找到 ${allFiles.length} 个文件`);

    // 过滤图片和视频文件
    const imageFiles = allFiles.filter(file => {
      const mimeType = file.mimeType || '';
      const name = file.name || '';
      return mimeType.startsWith('image/') || mimeType.startsWith('video/') ||
             /\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov)$/i.test(name);
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
    
    for (const file of imageFiles) {
      // 添加到已知文件列表（如果还没有）
      const wasKnown = knownFileIds.has(file.id);
      if (!wasKnown) {
        knownFileIds.add(file.id);
      }
      
      // 处理文件（手动同步时强制处理所有文件）
      try {
        // 检查文件是否需要手动拖入（GIF过大或视频文件）
        const fileName = file.name.toLowerCase();
        const isGif = fileName.endsWith('.gif');
        const isVideo = fileName.endsWith('.mp4') || fileName.endsWith('.mov');
        
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
              continue;
            }
          } catch (checkError) {
            console.log(`   ⚠️  检查 GIF 大小失败，继续处理: ${checkError.message}`);
          }
        }
        
        // 如果是视频文件，需要手动拖入，不算成功
        if (isVideo) {
          console.log(`   ⚠️  视频文件需要手动拖入: ${file.name}`);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'file-skipped',
              filename: file.name,
              reason: 'video'
            }));
          }
          continue;
        }
        
        await handleOSSFile(file, true);
        success += 1;
        await sleep(300); // 避免请求过快
      } catch (error) {
        console.error(`   ❌ 处理文件失败: ${file.name}`, error.message);
        if (!wasKnown) {
          knownFileIds.delete(file.id);
        }
      }
    }

    console.log(`\n✅ [OSS] 手动同步完成`);
    console.log(`   ✅ 成功同步: ${success} 张截图`);
    console.log(`   📊 总计: ${imageFiles.length} 个图片文件`);

    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'manual-sync-complete',
        count: success,
        total: imageFiles.length
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
        message: error.message
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
          console.log('⚠️  [OSS] 当前是阿里云 OSS watcher，需要切换到其他模式');
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
        
        let shouldDelete = false;
        let deleteInfo = null;
        let fileIdToDelete = null;
        
        if (ossFileId) {
          if (pendingDeletes.has(ossFileId)) {
            deleteInfo = pendingDeletes.get(ossFileId);
            fileIdToDelete = ossFileId;
            shouldDelete = true;
            pendingDeletes.delete(ossFileId);
          }
        }
        
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
        
        if (shouldDelete && deleteInfo && fileIdToDelete) {
          try {
            console.log(`   🗑️  删除 OSS 文件: ${filename} (路径: ${fileIdToDelete})`);
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
          console.log(`   ℹ️  文件已标记为保留，不删除: ${filename}（可能导入失败需要手动拖入）`);
        }
        return;
      }

      if (message.type === 'start-realtime') {
        console.log('\n🎯 [OSS] 启动实时同步模式...');
        isRealTimeMode = true;
        startPolling();
        await pollOSS();
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
  console.log('║  阿里云 OSS 截图同步 - Mac 监听器     ║');
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

  await initializeKnownFiles();
  connectWebSocket();

  setInterval(cleanupCache, CLEANUP_INTERVAL_MS);
  console.log(`🧹 [缓存管理] 已启动定期清理，每 ${CLEANUP_INTERVAL_MS / 1000 / 60} 分钟执行一次`);

  process.on('SIGINT', () => {
    console.log('\n👋 [OSS] 停止服务');
    stopPolling();
    if (ws) ws.close();
    process.exit(0);
  });
}

start();

