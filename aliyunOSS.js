const OSS = require('ali-oss');
const { Readable } = require('stream');

let ossClient = null;

/**
 * 解析阿里云配置
 */
function resolveOSSConfig() {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  const region = process.env.ALIYUN_REGION || 'oss-cn-hangzhou';
  const bucket = process.env.ALIYUN_BUCKET;
  const endpoint = process.env.ALIYUN_ENDPOINT;

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('缺少阿里云配置: 请设置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET 环境变量');
  }

  if (!bucket) {
    throw new Error('缺少阿里云 Bucket 配置: 请设置 ALIYUN_BUCKET 环境变量');
  }

  return {
    accessKeyId,
    accessKeySecret,
    region,
    bucket,
    endpoint
  };
}

/**
 * 创建 OSS 客户端
 */
function createOSSClient() {
  if (ossClient) {
    return ossClient;
  }

  const config = resolveOSSConfig();
  
  const clientConfig = {
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    region: config.region,
    bucket: config.bucket
  };

  // 如果提供了自定义 endpoint，使用自定义 endpoint
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
  }

  ossClient = new OSS(clientConfig);
  return ossClient;
}

/**
 * 获取 OSS 客户端
 */
function getOSSClient() {
  if (!ossClient) {
    ossClient = createOSSClient();
  }
  return ossClient;
}

/**
 * 上传 Buffer 到 OSS
 * @param {Object} options - 上传选项
 * @param {Buffer} options.buffer - 文件内容
 * @param {string} options.filename - 文件名
 * @param {string} options.mimeType - MIME 类型
 * @param {string} options.folderId - 文件夹路径（OSS 中的前缀路径）
 * @returns {Promise<Object>} 上传结果
 */
/**
 * 根据 MIME 类型获取文件扩展名
 */
function getExtensionFromMimeType(mimeType) {
  if (!mimeType) return '';
  
  const mimeToExt = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-m4v': '.mov'
  };
  
  return mimeToExt[mimeType.toLowerCase()] || '';
}

/**
 * 确保文件名包含扩展名
 */
function ensureFilenameExtension(filename, mimeType) {
  if (!filename) return filename;
  
  // 检查是否已有扩展名
  const hasExtension = /\.\w+$/.test(filename);
  if (hasExtension) {
    return filename;
  }
  
  // 根据 MIME 类型添加扩展名
  const ext = getExtensionFromMimeType(mimeType);
  if (ext) {
    return filename + ext;
  }
  
  return filename;
}

async function uploadBuffer({ buffer, filename, mimeType = 'image/jpeg', folderId = '' }) {
  if (!buffer) {
    throw new Error('uploadBuffer 缺少 buffer');
  }

  if (!filename) {
    throw new Error('uploadBuffer 缺少 filename');
  }

  // 确保文件名包含扩展名
  const finalFilename = ensureFilenameExtension(filename, mimeType);
  
  const client = getOSSClient();
  const fileSizeBytes = buffer.length;
  const fileSizeMB = fileSizeBytes / 1024 / 1024;
  const isVideo = mimeType && mimeType.toLowerCase().startsWith('video/');
  const isGif = mimeType && mimeType.toLowerCase() === 'image/gif';

  // 记录上传信息
  if (isVideo) {
    console.log(`   🎥 [OSS] 准备上传视频: ${filename} (${fileSizeMB.toFixed(2)}MB, MIME: ${mimeType})`);
  } else if (isGif) {
    console.log(`   🎬 [OSS] 准备上传 GIF: ${filename} (${fileSizeMB.toFixed(2)}MB, MIME: ${mimeType})`);
  }

  // 构建 OSS 对象路径
  // folderId 在 OSS 中作为前缀路径使用
  // 注意：createFolder 返回的 folderId 可能包含尾部斜杠，需要去掉
  let cleanFolderId = folderId;
  if (cleanFolderId && cleanFolderId.endsWith('/')) {
    cleanFolderId = cleanFolderId.slice(0, -1);
  }
  const objectName = cleanFolderId ? `${cleanFolderId}/${finalFilename}` : finalFilename;

  // 将 Buffer 转换为 Stream
  const stream = Readable.from(buffer);

  // 优先速度：小文件使用普通上传，大文件使用分片上传
  // 设置阈值：超过 100MB 才使用分片上传（优先速度，与 Google Drive 模式一致）
  const USE_MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
  const useMultipart = fileSizeBytes > USE_MULTIPART_THRESHOLD;

  try {
    // 根据文件大小和上传方式动态设置超时时间
    const isLargeFile = isVideo || isGif;
    let timeout = 30000; // 默认30秒
    if (isLargeFile || fileSizeBytes > 5 * 1024 * 1024) {
      if (useMultipart) {
        // 分片上传：每MB给20秒，最小120秒，最大900秒（15分钟）
        timeout = Math.max(120000, Math.min(900000, fileSizeMB * 20 * 1000));
      } else {
        // 普通上传：每MB给10秒，最小60秒，最大300秒（5分钟）- 更快
        timeout = Math.max(60000, Math.min(300000, fileSizeMB * 10 * 1000));
      }
    }

    const uploadType = useMultipart ? '分片上传' : '普通上传';
    if (isVideo) {
      console.log(`   🎥 [OSS] 开始上传视频文件（${fileSizeMB.toFixed(2)}MB, ${uploadType}, 超时: ${timeout/1000}秒）...`);
    } else if (isGif) {
      console.log(`   🎬 [OSS] 开始上传 GIF 文件（${fileSizeMB.toFixed(2)}MB, ${uploadType}, 超时: ${timeout/1000}秒）...`);
    }
    
    // 如果文件名被修改（添加了扩展名），记录日志
    if (finalFilename !== filename) {
      console.log(`   ℹ️  [OSS] 文件名已添加扩展名: ${filename} → ${finalFilename}`);
    }

    let result;
    if (useMultipart) {
      // 使用分片上传（multipartUpload）
      result = await client.multipartUpload(objectName, stream, {
        mime: mimeType,
        timeout: timeout,
        partSize: 5 * 1024 * 1024, // 每片5MB
        progress: (p, c, total) => {
          // 可选：显示上传进度
          if (p === 1) {
            // 上传完成
          }
        }
      });
    } else {
      // 使用普通上传（put）
      result = await client.put(objectName, stream, {
        mime: mimeType,
        timeout: timeout
      });
    }

    // multipartUpload 和 put 返回格式略有不同，统一处理
    const resultName = result.name || result.bucket || objectName;
    const resultUrl = result.url || (result.res && result.res.requestUrls && result.res.requestUrls[0]) || null;
    
    if (isVideo) {
      console.log(`   ✅ [OSS] 视频文件上传成功: ${finalFilename} (对象名: ${resultName})`);
    } else if (isGif) {
      console.log(`   ✅ [OSS] GIF 文件上传成功: ${finalFilename} (对象名: ${resultName})`);
    } else {
      console.log(`   ✅ [OSS] 文件上传成功: ${finalFilename} (对象名: ${resultName})`);
    }

    return {
      id: objectName, // OSS 使用对象名作为 ID
      name: finalFilename,
      url: resultUrl
    };
  } catch (error) {
    // 如果普通上传失败且文件较大，尝试使用分片上传重试
    const isTimeoutError = error.message && (
      error.message.includes('timeout') || 
      error.message.includes('ETIMEDOUT') ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'TimeoutError'
    );
    // 只有超过100MB的文件在普通上传失败时才使用分片上传重试（与 Google Drive 模式一致）
    const isLargeFileError = fileSizeBytes > USE_MULTIPART_THRESHOLD && !useMultipart;
    
    // 如果是超时错误且文件较大，且之前没有使用分片上传，则重试使用分片上传
    if (isTimeoutError && isLargeFileError) {
      console.log(`   ⚠️  [OSS] 普通上传超时，尝试使用分片上传重试...`);
      
      // 重新创建 stream（之前的 stream 可能已经消耗）
      const retryStream = Readable.from(buffer);
      
      // 增加超时时间（分片上传需要更长时间）
      const retryTimeout = Math.max(120000, Math.min(900000, fileSizeMB * 20 * 1000));
      
      try {
        const retryResult = await client.multipartUpload(objectName, retryStream, {
          mime: mimeType,
          timeout: retryTimeout,
          partSize: 5 * 1024 * 1024 // 每片5MB
        });
        
        const retryResultName = retryResult.name || retryResult.bucket || objectName;
        const retryResultUrl = retryResult.url || (retryResult.res && retryResult.res.requestUrls && retryResult.res.requestUrls[0]) || null;
        
        if (isVideo) {
          console.log(`   ✅ [OSS] 视频文件上传成功（分片上传重试）: ${finalFilename} (对象名: ${retryResultName})`);
        } else if (isGif) {
          console.log(`   ✅ [OSS] GIF 文件上传成功（分片上传重试）: ${finalFilename} (对象名: ${retryResultName})`);
        }
        
        return {
          id: objectName,
          name: finalFilename,
          url: retryResultUrl
        };
      } catch (retryError) {
        console.error(`   ❌ [OSS] 分片上传重试也失败: ${retryError.message}`);
        // 继续抛出原始错误
      }
    }
    
    const errorInfo = {
      message: error.message,
      code: error.code,
      filename,
      mimeType,
      objectName,
      fileSizeMB: fileSizeMB.toFixed(2)
    };

    if (isVideo) {
      console.error(`   ❌ [OSS] 视频文件上传失败:`, errorInfo);
    } else if (isGif) {
      console.error(`   ❌ [OSS] GIF 文件上传失败:`, errorInfo);
    } else {
      console.error(`   ❌ [OSS] 文件上传失败:`, errorInfo);
    }

    throw new Error(`阿里云上传失败: ${error.message} (文件: ${filename}, 大小: ${fileSizeMB.toFixed(2)}MB)`);
  }
}

/**
 * 列出文件夹中的文件
 * @param {Object} options - 列表选项
 * @param {string} options.folderId - 文件夹路径（OSS 中的前缀路径）
 * @param {number} options.pageSize - 每页数量
 * @param {string} options.orderBy - 排序方式
 * @returns {Promise<Object>} 文件列表
 */
async function listFolderFiles({ folderId = '', pageSize = 50, orderBy = 'LastModified', pageToken = null }) {
  const client = getOSSClient();
  
  // 如果 folderId 为空，使用 ROOT_FOLDER 作为根目录
  const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'ScreenSync';
  const actualFolderId = folderId || OSS_ROOT_FOLDER;
  
  // OSS 使用前缀来列出文件夹中的文件
  // 注意：folderId 可能包含尾部斜杠，需要统一处理
  let cleanFolderId = actualFolderId;
  if (cleanFolderId && cleanFolderId.endsWith('/')) {
    cleanFolderId = cleanFolderId.slice(0, -1);
  }
  const prefix = cleanFolderId ? `${cleanFolderId}/` : '';
  
  try {
    const result = await client.list({
      prefix: prefix,
      'max-keys': pageSize,
      'marker': pageToken || null, // 使用传入的分页标记
      'delimiter': '/' // 使用分隔符，只列出直接子项，不递归
    });

    // 处理文件和文件夹
    const files = [];
    
    // 处理文件（objects）
    if (result.objects) {
      // 批量获取文件元数据（如果 list API 返回的 MIME 类型不准确）
      const filesToCheck = [];
      const fileMap = new Map();
      
      result.objects.forEach(obj => {
        // 只处理直接在该文件夹下的文件（路径深度检查）
        const relativePath = obj.name.replace(prefix, '');
        if (relativePath && !relativePath.includes('/')) {
          // 如果 list API 返回的 MIME 类型是 application/octet-stream，需要进一步检查
          const listMimeType = obj.mime || 'application/octet-stream';
          
          // 先尝试从扩展名推断
          let inferredMimeType = listMimeType;
          let needsHeadCheck = false;
          
          if (listMimeType === 'application/octet-stream') {
            if (relativePath) {
              const ext = relativePath.split('.').pop()?.toLowerCase();
              const extToMime = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'heic': 'image/heic',
                'heif': 'image/heif',
                'mp4': 'video/mp4',
                'mov': 'video/quicktime'
              };
              if (ext && extToMime[ext]) {
                inferredMimeType = extToMime[ext];
              } else {
                // 如果扩展名也无法推断，使用 head API 获取正确的 MIME 类型
                needsHeadCheck = true;
                filesToCheck.push(obj.name);
              }
            } else {
              // 没有文件名，使用 head API 获取
              needsHeadCheck = true;
              filesToCheck.push(obj.name);
            }
          }
          
          fileMap.set(obj.name, {
            id: obj.name, // OSS 对象名作为 ID
            name: relativePath, // 文件名
            mimeType: inferredMimeType,
            createdTime: obj.lastModified, // OSS 没有创建时间，使用修改时间
            modifiedTime: obj.lastModified,
            size: obj.size,
            url: obj.url,
            needsHeadCheck: needsHeadCheck
          });
        }
      });
      
      // 对于需要检查的文件，使用 head API 获取正确的 MIME 类型
      if (filesToCheck.length > 0) {
        console.log(`   🔍 [OSS] 检测到 ${filesToCheck.length} 个文件需要获取完整元数据...`);
        await Promise.all(filesToCheck.map(async (objectName) => {
          try {
            const headResult = await client.head(objectName);
            
            // 调试：打印 head API 返回的完整结构
            if (!headResult) {
              console.warn(`   ⚠️  [OSS] 获取 ${objectName} 元数据失败: head API 返回 null`);
              return;
            }
            
            // 检查不同的可能字段名
            let correctMimeType = null;
            
            // 尝试多种可能的字段路径（根据 ali-oss SDK 文档）
            // head API 返回的格式可能是：result.res.headers['content-type'] 或 result.meta['content-type']
            if (headResult.res && headResult.res.headers) {
              correctMimeType = headResult.res.headers['content-type'] || 
                                headResult.res.headers['Content-Type'];
            }
            
            // 尝试 meta 字段
            if (!correctMimeType && headResult.meta) {
              correctMimeType = headResult.meta['content-type'] || 
                                headResult.meta['Content-Type'] || 
                                headResult.meta['ContentType'];
            }
            
            // 如果 meta 中没有，尝试直接访问
            if (!correctMimeType) {
              correctMimeType = headResult['content-type'] || 
                               headResult['Content-Type'] ||
                               headResult.contentType;
            }
            
            // 如果还是找不到，打印调试信息
            if (!correctMimeType) {
              console.warn(`   ⚠️  [OSS] 无法从 head API 获取 MIME 类型: ${objectName}`);
              console.warn(`      headResult 结构:`, JSON.stringify(Object.keys(headResult || {}), null, 2));
              if (headResult.meta) {
                console.warn(`      meta 结构:`, JSON.stringify(Object.keys(headResult.meta), null, 2));
              }
              // 即使获取不到，也尝试从扩展名推断
              const fileInfo = fileMap.get(objectName);
              if (fileInfo && fileInfo.name) {
                const ext = fileInfo.name.split('.').pop()?.toLowerCase();
                const extToMime = {
                  'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                  'gif': 'image/gif', 'webp': 'image/webp', 'heic': 'image/heic',
                  'heif': 'image/heif', 'mp4': 'video/mp4', 'mov': 'video/quicktime'
                };
                if (ext && extToMime[ext]) {
                  fileInfo.mimeType = extToMime[ext];
                  console.log(`   ✅ [OSS] 从扩展名推断 ${fileInfo.name} 的 MIME 类型: ${extToMime[ext]}`);
                }
              }
              return;
            }
            
            const fileInfo = fileMap.get(objectName);
            if (fileInfo && correctMimeType !== 'application/octet-stream') {
              fileInfo.mimeType = correctMimeType;
              console.log(`   ✅ [OSS] 已获取 ${fileInfo.name} 的正确 MIME 类型: ${correctMimeType}`);
            } else if (fileInfo) {
              // 如果 head API 返回的也是 application/octet-stream，尝试从扩展名推断
              const ext = fileInfo.name.split('.').pop()?.toLowerCase();
              const extToMime = {
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                'gif': 'image/gif', 'webp': 'image/webp', 'heic': 'image/heic',
                'heif': 'image/heif', 'mp4': 'video/mp4', 'mov': 'video/quicktime'
              };
              if (ext && extToMime[ext]) {
                fileInfo.mimeType = extToMime[ext];
                console.log(`   ✅ [OSS] 从扩展名推断 ${fileInfo.name} 的 MIME 类型: ${extToMime[ext]}`);
              }
            }
          } catch (error) {
            console.warn(`   ⚠️  [OSS] 获取 ${objectName} 元数据失败: ${error.message}`);
            // 即使 head API 失败，也尝试从扩展名推断
            const fileInfo = fileMap.get(objectName);
            if (fileInfo && fileInfo.name) {
              const ext = fileInfo.name.split('.').pop()?.toLowerCase();
              const extToMime = {
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                'gif': 'image/gif', 'webp': 'image/webp', 'heic': 'image/heic',
                'heif': 'image/heif', 'mp4': 'video/mp4', 'mov': 'video/quicktime'
              };
              if (ext && extToMime[ext]) {
                fileInfo.mimeType = extToMime[ext];
                console.log(`   ✅ [OSS] 从扩展名推断 ${fileInfo.name} 的 MIME 类型: ${extToMime[ext]}`);
              }
            }
          }
        }));
      }
      
      // 将所有文件添加到结果数组
      fileMap.forEach(fileInfo => {
        files.push(fileInfo);
      });
    }
    
    // 处理文件夹（commonPrefixes）- 如果需要的话，可以在这里处理子文件夹
    // 但当前我们只关注文件，所以暂时不处理文件夹

    // 根据 orderBy 排序
    if (orderBy === 'LastModified' || orderBy.includes('modifiedTime')) {
      files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
    } else if (orderBy.includes('createdTime')) {
      files.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    }

    return {
      files: files,
      nextPageToken: result.nextMarker || null
    };
  } catch (error) {
    throw new Error(`列出 OSS 文件失败: ${error.message}`);
  }
}

/**
 * 下载文件 Buffer
 * @param {string} objectName - OSS 对象名（文件路径）
 * @returns {Promise<Buffer>} 文件内容
 */
async function downloadFileBuffer(objectName) {
  if (!objectName || objectName.trim() === '' || objectName === '.') {
    throw new Error(`downloadFileBuffer 缺少或无效的 objectName: "${objectName}"`);
  }

  const client = getOSSClient();
  
  try {
    const result = await client.get(objectName);
    return Buffer.from(result.content);
  } catch (error) {
    throw new Error(`下载 OSS 文件失败: ${error.message}`);
  }
}

/**
 * 删除文件（移动到回收站或直接删除）
 * @param {string} objectName - OSS 对象名（文件路径）
 * @returns {Promise<boolean>} 是否成功
 */
async function deleteFile(objectName) {
  if (!objectName || objectName.trim() === '' || objectName === '.') {
    throw new Error(`deleteFile 缺少或无效的 objectName: "${objectName}"`);
  }

  const client = getOSSClient();
  
  try {
    await client.delete(objectName);
    return true;
  } catch (error) {
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('NoSuchKey') || errorMsg.includes('404')) {
      throw new Error(`File not found: ${objectName}`);
    }
    throw error;
  }
}

/**
 * 创建文件夹（在 OSS 中，文件夹实际上是一个空对象，以 / 结尾）
 * @param {Object} options - 创建选项
 * @param {string} options.folderName - 文件夹名称
 * @param {string} options.parentFolderId - 父文件夹路径
 * @returns {Promise<Object>} 文件夹信息
 */
async function createFolder({ folderName, parentFolderId = '' }) {
  if (!folderName) {
    throw new Error('createFolder 缺少 folderName');
  }

  const client = getOSSClient();
  
  // 构建文件夹路径（OSS 中文件夹以 / 结尾）
  const folderPath = parentFolderId 
    ? `${parentFolderId}/${folderName}/`
    : `${folderName}/`;

  try {
    // 先检查文件夹是否已存在
    try {
      const result = await client.list({
        prefix: folderPath,
        'max-keys': 1
      });
      
      // 如果已经有文件或文件夹存在，返回现有路径
      if (result.objects && result.objects.length > 0) {
        return {
          id: folderPath,
          name: folderName
        };
      }
    } catch (checkError) {
      // 如果检查失败，继续创建
    }

    // 创建文件夹（在 OSS 中创建一个空对象，以 / 结尾）
    await client.put(folderPath, Buffer.from(''), {
      mime: 'application/x-directory'
    });

    return {
      id: folderPath,
      name: folderName
    };
  } catch (error) {
    throw new Error(`创建 OSS 文件夹失败: ${error.message}`);
  }
}

/**
 * 获取文件信息
 * @param {string} objectName - OSS 对象名（文件路径）
 * @returns {Promise<Object>} 文件信息
 */
async function getFileInfo(objectName) {
  if (!objectName || objectName.trim() === '' || objectName === '.') {
    throw new Error(`getFileInfo 缺少或无效的 objectName: "${objectName}"`);
  }

  const client = getOSSClient();
  
  try {
    const result = await client.head(objectName);
    return {
      id: objectName,
      name: objectName.split('/').pop(),
      mimeType: result.meta['content-type'] || 'application/octet-stream',
      size: result.size,
      lastModified: result.lastModified
    };
  } catch (error) {
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('NoSuchKey') || errorMsg.includes('404')) {
      throw new Error(`File not found: ${objectName}`);
    }
    throw error;
  }
}

module.exports = {
  uploadBuffer,
  listFolderFiles,
  downloadFileBuffer,
  deleteFile,
  createFolder,
  getFileInfo,
  getOSSClient
};

