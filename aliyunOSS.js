const OSS = require('ali-oss');
const { Readable } = require('stream');

let ossClient = null;

/**
 * 解析阿里云 OSS 配置
 */
function resolveOSSConfig() {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  const region = process.env.ALIYUN_REGION || 'oss-cn-hangzhou';
  const bucket = process.env.ALIYUN_BUCKET;
  const endpoint = process.env.ALIYUN_ENDPOINT;

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('缺少阿里云 OSS 配置: 请设置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET 环境变量');
  }

  if (!bucket) {
    throw new Error('缺少阿里云 OSS Bucket 配置: 请设置 ALIYUN_BUCKET 环境变量');
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
async function uploadBuffer({ buffer, filename, mimeType = 'image/jpeg', folderId = '' }) {
  if (!buffer) {
    throw new Error('uploadBuffer 缺少 buffer');
  }

  if (!filename) {
    throw new Error('uploadBuffer 缺少 filename');
  }

  const client = getOSSClient();
  const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);
  const isVideo = mimeType && mimeType.toLowerCase().startsWith('video/');
  const isGif = mimeType && mimeType.toLowerCase() === 'image/gif';

  // 记录上传信息
  if (isVideo) {
    console.log(`   🎥 [OSS] 准备上传视频: ${filename} (${fileSizeMB}MB, MIME: ${mimeType})`);
  } else if (isGif) {
    console.log(`   🎬 [OSS] 准备上传 GIF: ${filename} (${fileSizeMB}MB, MIME: ${mimeType})`);
  }

  // 构建 OSS 对象路径
  // folderId 在 OSS 中作为前缀路径使用
  const objectName = folderId ? `${folderId}/${filename}` : filename;

  // 将 Buffer 转换为 Stream
  const stream = Readable.from(buffer);

  try {
    // 大文件（视频和 GIF）需要更长的超时时间
    const isLargeFile = isVideo || isGif;
    const timeout = isLargeFile ? 120000 : 30000; // 大文件120秒，其他30秒

    if (isVideo) {
      console.log(`   🎥 [OSS] 开始上传视频文件（超时: ${timeout/1000}秒）...`);
    } else if (isGif) {
      console.log(`   🎬 [OSS] 开始上传 GIF 文件（超时: ${timeout/1000}秒）...`);
    }

    const result = await client.put(objectName, stream, {
      mime: mimeType,
      timeout: timeout
    });

    if (isVideo) {
      console.log(`   ✅ [OSS] 视频文件上传成功: ${filename} (对象名: ${result.name})`);
    } else if (isGif) {
      console.log(`   ✅ [OSS] GIF 文件上传成功: ${filename} (对象名: ${result.name})`);
    } else {
      console.log(`   ✅ [OSS] 文件上传成功: ${filename} (对象名: ${result.name})`);
    }

    return {
      id: result.name, // OSS 使用对象名作为 ID
      name: filename,
      url: result.url
    };
  } catch (error) {
    const errorInfo = {
      message: error.message,
      code: error.code,
      filename,
      mimeType,
      objectName,
      fileSizeMB
    };

    if (isVideo) {
      console.error(`   ❌ [OSS] 视频文件上传失败:`, errorInfo);
    } else {
      console.error(`   ❌ [OSS] 文件上传失败:`, errorInfo);
    }

    throw new Error(`阿里云 OSS 上传失败: ${error.message} (文件: ${filename}, 大小: ${fileSizeMB}MB)`);
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
async function listFolderFiles({ folderId = '', pageSize = 50, orderBy = 'LastModified' }) {
  const client = getOSSClient();
  
  // OSS 使用前缀来列出文件夹中的文件
  const prefix = folderId ? `${folderId}/` : '';
  
  try {
    const result = await client.list({
      prefix: prefix,
      'max-keys': pageSize,
      'marker': null // 分页标记，这里简化处理，只获取第一页
    });

    // 转换 OSS 格式到统一格式
    const files = (result.objects || []).map(obj => ({
      id: obj.name, // OSS 对象名作为 ID
      name: obj.name.split('/').pop(), // 从路径中提取文件名
      mimeType: obj.mime || 'application/octet-stream',
      createdTime: obj.lastModified, // OSS 没有创建时间，使用修改时间
      modifiedTime: obj.lastModified,
      size: obj.size,
      url: obj.url
    }));

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

