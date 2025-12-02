const { google } = require('googleapis');
const { Readable } = require('stream');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

let driveInstance = null;
let authClient = null;

function resolveServiceAccount() {
  const envEmail = process.env.GDRIVE_CLIENT_EMAIL;
  const envKey = process.env.GDRIVE_PRIVATE_KEY;

  if (envEmail && envKey) {
    return {
      client_email: envEmail,
      private_key: envKey.replace(/\\n/g, '\n')
    };
  }

  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const localKey = require('./serviceAccountKey');
    if (localKey && localKey.client_email && localKey.private_key) {
      return {
        client_email: localKey.client_email,
        private_key: localKey.private_key
      };
    }
  } catch (error) {
    // ignore missing local file
  }

  throw new Error('缺少 Google Drive Service Account 配置: 请设置环境变量或提供 serviceAccountKey.js');
}

function createDriveClient() {
  const credentials = resolveServiceAccount();

  authClient = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES
  });

  return google.drive({ version: 'v3', auth: authClient });
}

function getDriveClient() {
  if (!driveInstance) {
    driveInstance = createDriveClient();
  }
  return driveInstance;
}

async function uploadBuffer({ buffer, filename, mimeType = 'image/jpeg', folderId, supportsAllDrives = true }) {
  if (!buffer) {
    throw new Error('uploadBuffer 缺少 buffer');
  }

  if (!filename) {
    throw new Error('uploadBuffer 缺少 filename');
  }

  if (!folderId || folderId.trim() === '' || folderId === '.') {
    throw new Error(`uploadBuffer 缺少或无效的 folderId: "${folderId}"`);
  }

  const drive = getDriveClient();
  const fileSizeBytes = buffer.length;
  const fileSizeMB = fileSizeBytes / 1024 / 1024;
  const isVideo = mimeType && mimeType.toLowerCase().startsWith('video/');

  // 记录上传信息
  if (isVideo) {
    console.log(`   🎥 [Drive API] 准备上传视频: ${filename} (${fileSizeMB.toFixed(2)}MB, MIME: ${mimeType})`);
  }

  // 将 Buffer 转换为 Stream（Google Drive API 需要）
  const stream = Readable.from(buffer);

  // 检查是否是共享驱动器（以 '0A' 开头的是共享驱动器 ID）
  const isSharedDrive = folderId.startsWith('0A') || folderId.length === 33;

  // 优化：只返回必要的字段，减少响应大小和处理时间
  // 优先使用普通上传（更快），只有文件过大时才使用分块上传
  const isGif = mimeType && mimeType.toLowerCase() === 'image/gif';
  
  // 设置阈值：超过 5MB 就使用分块上传（Google 推荐 > 5MB 使用 resumable）
  // 之前设置为 100MB，导致 20MB+ 文件使用普通上传容易失败
  const USE_RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB
  const useResumable = fileSizeBytes > USE_RESUMABLE_THRESHOLD;
  
  const requestBody = {
    name: filename,
    parents: [folderId]
  };
  
  // 对于共享驱动器，确保在 requestBody 中也设置相关参数（分块上传需要）
  if (isSharedDrive || supportsAllDrives) {
    // 共享驱动器不需要额外设置，但确保 parents 正确
  }
  
  const params = {
    requestBody,
    media: {
      mimeType,
      body: stream,
      // 只有超过阈值的大文件才使用分块上传
      resumable: useResumable
    },
    fields: 'id,name' // 返回文件ID和名称，用于验证
  };

  // 对于共享驱动器，必须设置这些参数（特别是分块上传时）
  if (isSharedDrive || supportsAllDrives) {
    params.supportsAllDrives = true;
    params.supportsTeamDrives = true; // 兼容旧版 API
    // 分块上传时，确保这些参数也正确传递
    if (useResumable) {
      // 确保 requestBody 中的 parents 是数组格式
      if (!Array.isArray(requestBody.parents)) {
        requestBody.parents = [folderId];
      }
    }
  }

  try {
    // 优先速度：小文件使用普通上传，大文件使用分块上传
    // 根据文件大小和上传方式动态设置超时时间
    const isLargeFile = isVideo || isGif;
    
    // 根据文件大小和上传方式计算超时时间
    // 优化：增加大文件的超时时间，特别是对于 resumable uploads
    let timeout = 30000; // 默认30秒
    if (isLargeFile || fileSizeBytes > 5 * 1024 * 1024) {
      if (useResumable) {
        // 分块上传：每MB给30秒，最小180秒，最大1800秒（30分钟）
        // Resumable upload 可以在网络不稳定时恢复，但整个请求不能超时太快
        timeout = Math.max(180000, Math.min(1800000, fileSizeMB * 30 * 1000));
      } else {
        // 普通上传：每MB给15秒，最小90秒，最大600秒（10分钟）- 更快
        timeout = Math.max(90000, Math.min(600000, fileSizeMB * 15 * 1000));
      }
    }
    
    const uploadType = useResumable ? '分块上传' : '普通上传';
    if (isVideo) {
      console.log(`   🎥 [Drive API] 开始上传视频文件（${fileSizeMB.toFixed(2)}MB, ${uploadType}, 超时: ${timeout/1000}秒, 共享驱动器: ${isSharedDrive}）...`);
    } else if (isGif) {
      console.log(`   🎬 [Drive API] 开始上传 GIF 文件（${fileSizeMB.toFixed(2)}MB, ${uploadType}, 超时: ${timeout/1000}秒, 共享驱动器: ${isSharedDrive}）...`);
    } else if (useResumable) {
      console.log(`   📤 [Drive API] 开始分块上传大文件（${fileSizeMB.toFixed(2)}MB, 超时: ${timeout/1000}秒, 共享驱动器: ${isSharedDrive}）...`);
    }
    
    // 使用 v3 API 的 create 方法，它会自动处理 resumable uploads 的 chunking
    // googleapis 库内部会根据 media.body 的流类型和大小自动优化
    const response = await drive.files.create(params, {
      // timeout 是整个请求的超时
      timeout: timeout,
      // 对于大文件，可以设置 maxRedirects 增加稳定性
      maxRedirects: 5,
      // 重试配置
      retryConfig: {
        retry: 3,
        statusCodesToRetry: [[100, 199], [429, 429], [500, 599]],
        retryDelay: 1000
      }
    });

    if (isVideo) {
      console.log(`   ✅ [Drive API] 视频文件上传成功: ${filename} (文件ID: ${response.data.id})`);
    } else if (isGif) {
      console.log(`   ✅ [Drive API] GIF 文件上传成功: ${filename} (文件ID: ${response.data.id})`);
    }

    return response.data;
  } catch (error) {
    // 检查是否是网络相关的错误或超时
    const isNetworkError = error.code === 'ECONNRESET' || 
                          error.code === 'ETIMEDOUT' || 
                          error.code === 'EPIPE' || 
                          error.message.includes('socket hang up') ||
                          error.message.includes('timeout') ||
                          error.message.includes('Connection lost');

    // 只要是大文件（> 5MB 或 isVideo/isGif），无论之前是用普通还是分块，失败后都尝试用分块重试
    // 注意：如果之前已经是分块上传且失败了，我们依然重试一次，因为网络波动很常见
    const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5MB
    const shouldRetry = fileSizeBytes > LARGE_FILE_THRESHOLD || isGif || isVideo;
    
    if (shouldRetry) {
      console.log(`   ⚠️  [Drive API] 上传中断 (${error.code || error.message})，正在尝试重新上传...`);
      
      // 重新创建 stream（之前的 stream 可能已经消耗或损坏）
      const retryStream = Readable.from(buffer);
      
      // 使用分块上传重试
      const retryRequestBody = {
        name: filename,
        parents: [folderId]
      };
      
      const retryParams = {
        requestBody: retryRequestBody,
        media: {
          mimeType,
          body: retryStream,
          resumable: true // 强制使用分块上传
        },
        fields: 'id,name'
      };
      
      // 对于共享驱动器，确保设置正确的参数
      if (isSharedDrive || supportsAllDrives) {
        retryParams.supportsAllDrives = true;
        retryParams.supportsTeamDrives = true;
      }
      
      // 增加超时时间（分块上传需要更长时间），给重试更多机会
      const retryTimeout = Math.max(300000, Math.min(3600000, fileSizeMB * 60 * 1000)); // 最小5分钟，最大1小时
      
      try {
        const retryResponse = await drive.files.create(retryParams, {
          timeout: retryTimeout,
          retryConfig: {
            retry: 5, // 增加重试次数到 5
            statusCodesToRetry: [[100, 199], [408, 408], [429, 429], [500, 599], ['ECONNRESET', 'ETIMEDOUT']], // 尝试包含网络错误代码
            retryDelay: 2000, // 增加重试延迟
            onRetryAttempt: (err) => {
                console.log(`      Checking retry attempt: ${err.code || err.message}`);
            }
          }
        });
        
        if (isVideo) {
          console.log(`   ✅ [Drive API] 视频文件上传成功（重试后）: ${filename} (文件ID: ${retryResponse.data.id})`);
        } else if (isGif) {
          console.log(`   ✅ [Drive API] GIF 文件上传成功（重试后）: ${filename} (文件ID: ${retryResponse.data.id})`);
        } else {
           console.log(`   ✅ [Drive API] 文件上传成功（重试后）: ${filename} (文件ID: ${retryResponse.data.id})`);
        }
        
        return retryResponse.data;
      } catch (retryError) {
        console.error(`   ❌ [Drive API] 重试上传也失败: ${retryError.message}`);
        // 记录两次错误的详情，便于调试
        console.error(`      原始错误: ${error.message}`);
        // 继续抛出重试的错误
        throw retryError;
      }
    }
    
    // 提供更详细的错误信息
    const errorMessage = error.message || String(error);
    const errorCode = error.code || 'UNKNOWN';
    const statusCode = error.response?.status || 'N/A';
    const responseData = error.response?.data ? JSON.stringify(error.response.data) : 'N/A';
    
    if (isVideo) {
      console.error(`   ❌ [Drive API] 视频文件上传失败:`);
      console.error(`      - 文件名: ${filename}`);
      console.error(`      - 大小: ${fileSizeMB.toFixed(2)}MB`);
      console.error(`      - MIME类型: ${mimeType}`);
      console.error(`      - 错误消息: ${errorMessage}`);
      console.error(`      - 错误代码: ${errorCode}`);
      console.error(`      - HTTP状态码: ${statusCode}`);
      if (error.response?.data) {
        console.error(`      - 响应数据: ${responseData}`);
      }
    } else if (isGif) {
      console.error(`   ❌ [Drive API] GIF 文件上传失败:`);
      console.error(`      - 文件名: ${filename}`);
      console.error(`      - 大小: ${fileSizeMB.toFixed(2)}MB`);
      console.error(`      - MIME类型: ${mimeType}`);
      console.error(`      - 错误消息: ${errorMessage}`);
      console.error(`      - 错误代码: ${errorCode}`);
      console.error(`      - HTTP状态码: ${statusCode}`);
      if (error.response?.data) {
        console.error(`      - 响应数据: ${responseData}`);
      }
    } else {
      console.error(`   ❌ [Drive API] 文件上传失败:`);
      console.error(`      - 文件名: ${filename}`);
      console.error(`      - 大小: ${fileSizeMB.toFixed(2)}MB`);
      console.error(`      - 错误消息: ${errorMessage}`);
      console.error(`      - 错误代码: ${errorCode}`);
      console.error(`      - HTTP状态码: ${statusCode}`);
    }
    
    throw new Error(`Google Drive 上传失败: ${errorMessage} (文件: ${filename}, 大小: ${fileSizeMB.toFixed(2)}MB)`);
  }
}

async function listFolderFiles({ folderId, pageSize = 50, orderBy = 'createdTime desc', fields = 'files(id,name,mimeType,createdTime,modifiedTime,size,parents),nextPageToken', supportsAllDrives = true, pageToken = null, customQuery = null }) {
  if (!folderId || folderId.trim() === '' || folderId === '.') {
    throw new Error(`listFolderFiles 缺少或无效的 folderId: "${folderId}"`);
  }

  const drive = getDriveClient();

  // 检查是否是共享驱动器
  const isSharedDrive = folderId.startsWith('0A') || folderId.length === 33;

  let q = `'${folderId}' in parents and trashed = false`;
  if (customQuery) {
    q += ` and (${customQuery})`;
  }

  const params = {
    q,
    orderBy,
    pageSize,
    fields
  };

  // 如果提供了 pageToken，用于获取下一页（分页支持）
  if (pageToken) {
    params.pageToken = pageToken;
  }

  if (isSharedDrive || supportsAllDrives) {
    params.supportsAllDrives = true;
    params.includeItemsFromAllDrives = true;
    params.corpora = 'allDrives';
    params.supportsTeamDrives = true; // 兼容旧版 API
  }

  const response = await drive.files.list(params);

  return {
    files: response.data.files || [],
    nextPageToken: response.data.nextPageToken || null
  };
}

async function downloadFileBuffer(fileId) {
  if (!fileId || fileId.trim() === '' || fileId === '.') {
    throw new Error(`downloadFileBuffer 缺少或无效的 fileId: "${fileId}"`);
  }

  const drive = getDriveClient();
  // 使用 alt: 'media' 下载原始文件内容，不进行任何转换
  // 对于 GIF 文件，这确保下载的是原始未压缩版本
  // 注意：Google Drive 可能会在上传时对某些文件进行优化，导致下载的文件与原始文件不同
  // 如果发现 GIF 质量下降，可能是 Google Drive 在上传时进行了处理
  const response = await drive.files.get(
    { 
      fileId, 
      alt: 'media'
      // 不添加任何转换参数，确保下载原始文件
    }, 
    { 
      responseType: 'arraybuffer'
    }
  );
  const buffer = Buffer.from(response.data);
  return buffer;
}

async function trashFile(fileId, supportsAllDrives = true) {
  if (!fileId || fileId.trim() === '' || fileId === '.') {
    throw new Error(`trashFile 缺少或无效的 fileId: "${fileId}"`);
  }

  const drive = getDriveClient();
  
  const params = {
    fileId,
    requestBody: { trashed: true }
  };
  
  // 如果是共享驱动器，需要设置 supportsAllDrives
  if (supportsAllDrives) {
    params.supportsAllDrives = true;
    params.supportsTeamDrives = true; // 兼容旧版 API
  }
  
  try {
    await drive.files.update(params);
    return true;
  } catch (error) {
    // 如果文件不存在，抛出更明确的错误
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('File not found') || 
        errorMsg.includes('not found') || 
        errorMsg.includes('404') ||
        errorMsg.includes('does not exist')) {
      throw new Error(`File not found: ${fileId}`);
    }
    throw error;
  }
}

/**
 * 在指定父文件夹中创建子文件夹
 * @param {string} folderName - 文件夹名称
 * @param {string} parentFolderId - 父文件夹ID
 * @param {boolean} supportsAllDrives - 是否支持共享驱动器
 * @returns {Promise<Object>} 创建的文件夹信息
 */
async function createFolder({ folderName, parentFolderId, supportsAllDrives = true }) {
  if (!folderName) {
    throw new Error('createFolder 缺少 folderName');
  }
  if (!parentFolderId || parentFolderId.trim() === '' || parentFolderId === '.') {
    throw new Error(`createFolder 缺少或无效的 parentFolderId: "${parentFolderId}"`);
  }

  const drive = getDriveClient();

  // 检查是否是共享驱动器
  const isSharedDrive = parentFolderId.startsWith('0A') || parentFolderId.length === 33;

  // 先检查文件夹是否已存在
  const params = {
    q: `name='${folderName.replace(/'/g, "\\'")}' and '${parentFolderId}' in parents and trashed = false and mimeType='application/vnd.google-apps.folder'`,
    fields: 'files(id, name)'
  };

  if (isSharedDrive || supportsAllDrives) {
    params.supportsAllDrives = true;
    params.includeItemsFromAllDrives = true;
    params.corpora = 'allDrives';
    params.supportsTeamDrives = true;
  }

  let existingFiles;
  try {
    existingFiles = await drive.files.list(params);
  } catch (error) {
    // 如果查询失败，可能是权限问题或文件夹ID无效
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('File not found') || errorMsg.includes('not found') || errorMsg.includes('404')) {
      throw new Error(`无法访问父文件夹 (ID: ${parentFolderId})。可能原因：\n   1. 文件夹ID不正确\n   2. Service Account 没有访问权限\n   3. 共享驱动器未正确配置`);
    } else if (errorMsg.includes('Permission') || errorMsg.includes('403')) {
      throw new Error(`Service Account 没有访问父文件夹的权限 (ID: ${parentFolderId})。请检查 Service Account 是否已添加到共享驱动器`);
    }
    throw error;
  }

  // 如果文件夹已存在，返回现有文件夹
  if (existingFiles.data.files && existingFiles.data.files.length > 0) {
    return existingFiles.data.files[0];
  }

  // 创建新文件夹
  const requestBody = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId]
  };

  const createParams = {
    requestBody,
    fields: 'id, name, webViewLink'
  };

  if (isSharedDrive || supportsAllDrives) {
    createParams.supportsAllDrives = true;
    createParams.supportsTeamDrives = true;
  }

  try {
    const response = await drive.files.create(createParams);
    return response.data;
  } catch (error) {
    // 如果创建失败，提供更详细的错误信息
    const errorMsg = error.message || String(error);
    if (errorMsg.includes('Permission') || errorMsg.includes('403')) {
      throw new Error(`Service Account 没有在共享驱动器中创建文件夹的权限。请检查：\n   1. Service Account 是否已添加到共享驱动器\n   2. Service Account 是否有"内容管理员"或"编辑者"权限\n   3. 共享驱动器是否允许 Service Account 创建文件夹`);
    } else if (errorMsg.includes('File not found') || errorMsg.includes('not found') || errorMsg.includes('404')) {
      throw new Error(`无法访问父文件夹 (ID: ${parentFolderId})。可能原因：\n   1. 文件夹ID不正确\n   2. Service Account 没有访问权限`);
    }
    throw error;
  }
}

/**
 * 获取文件夹信息
 * @param {string} fileId - 文件夹ID
 * @param {boolean} supportsAllDrives - 是否支持共享驱动器
 * @returns {Promise<Object>} 文件夹信息
 */
async function getFileInfo(fileId, supportsAllDrives = true) {
  if (!fileId || fileId.trim() === '' || fileId === '.') {
    throw new Error(`getFileInfo 缺少或无效的 fileId: "${fileId}"`);
  }

  const drive = getDriveClient();
  
  // 检查是否是共享驱动器
  const isSharedDrive = fileId.startsWith('0A') || fileId.length === 33;
  
  const params = {
    fileId,
    fields: 'id, name, mimeType, parents, webViewLink'
  };
  
  if (isSharedDrive || supportsAllDrives) {
    params.supportsAllDrives = true;
    params.supportsTeamDrives = true;
  }
  
  const response = await drive.files.get(params);
  return response.data;
}

/**
 * 获取断点续传上传链接 (Resumable Upload URL)
 * @param {Object} params
 * @param {string} params.filename - 文件名
 * @param {string} params.mimeType - 文件类型
 * @param {string} params.folderId - 目标文件夹ID
 * @param {boolean} params.supportsAllDrives - 是否支持共享驱动器
 * @returns {Promise<string>} 上传链接 (session URI)
 */
async function getResumableUploadUrl({ filename, mimeType, folderId, supportsAllDrives = true }) {
  if (!filename || !folderId) {
    throw new Error('getResumableUploadUrl 缺少 filename 或 folderId');
  }

  const drive = getDriveClient();
  
  // 获取 Access Token
  // 确保 authClient 已初始化
  if (!authClient) {
     // 如果 driveInstance 已经存在但 authClient 为空（极少见情况），重新初始化
     createDriveClient();
  }
  
  if (!authClient) {
    throw new Error('Google Drive Auth Client 未初始化');
  }

  // 使用 authorize() 确保已连接，然后获取 token
  // JWT 客户端使用 authorize() 而不是 getAccessToken()
  const credentials = await authClient.authorize();
  const token = credentials.access_token;
  
  if (!token) {
    throw new Error('无法获取 Google Access Token');
  }

  // 检查是否是共享驱动器
  const isSharedDrive = folderId.startsWith('0A') || folderId.length === 33;

  // 构造元数据
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: mimeType || 'application/octet-stream'
  };

  // 构造请求 URL
  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
  if (isSharedDrive || supportsAllDrives) {
    url += '&supportsAllDrives=true&supportsTeamDrives=true';
  }

  // 发起初始化请求
  // 注意：这里使用 fetch 手动发起请求，因为我们需要获取 Header 中的 Location
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream'
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`初始化断点续传失败: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // 获取上传链接
  const uploadUrl = response.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('Google Drive API 未返回 Location Header');
  }

  console.log(`   🔗 [Drive API] 已生成断点续传链接: ${filename}`);
  return uploadUrl;
}

module.exports = {
  uploadBuffer,
  listFolderFiles,
  downloadFileBuffer,
  trashFile,
  createFolder,
  getFileInfo,
  getResumableUploadUrl
};