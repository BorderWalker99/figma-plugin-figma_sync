const { google } = require('googleapis');
const { Readable } = require('stream');

const SCOPES = ['https://www.googleapis.com/auth/drive'];

let driveInstance = null;

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

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES
  });

  return google.drive({ version: 'v3', auth });
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
  const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);
  const isVideo = mimeType && mimeType.toLowerCase().startsWith('video/');

  // 记录上传信息
  if (isVideo) {
    console.log(`   🎥 [Drive API] 准备上传视频: ${filename} (${fileSizeMB}MB, MIME: ${mimeType})`);
  }

  // 将 Buffer 转换为 Stream（Google Drive API 需要）
  const stream = Readable.from(buffer);

  // 检查是否是共享驱动器（以 '0A' 开头的是共享驱动器 ID）
  const isSharedDrive = folderId.startsWith('0A') || folderId.length === 33;

  const requestBody = {
    name: filename,
    parents: [folderId]
  };

  // 优化：只返回必要的字段，减少响应大小和处理时间
  const params = {
    requestBody,
    media: {
      mimeType,
      body: stream
    },
    fields: 'id,name' // 返回文件ID和名称，用于验证
  };

  if (isSharedDrive || supportsAllDrives) {
    params.supportsAllDrives = true;
    params.supportsTeamDrives = true; // 兼容旧版 API
  }

  try {
    // 对于大文件（>5MB），Google Drive API 会自动使用分块上传
    // 设置更长的超时时间用于视频文件
    // 大文件（视频和 GIF）需要更长的超时时间
    const isGif = mimeType && mimeType.toLowerCase() === 'image/gif';
    const isLargeFile = isVideo || isGif;
    const timeout = isLargeFile ? 120000 : 30000; // 大文件120秒，其他30秒
    
    if (isVideo) {
      console.log(`   🎥 [Drive API] 开始上传视频文件（超时: ${timeout/1000}秒）...`);
    } else if (isGif) {
      console.log(`   🎬 [Drive API] 开始上传 GIF 文件（超时: ${timeout/1000}秒）...`);
    }
    
    const response = await drive.files.create(params, {
      timeout: timeout
    });

    if (isVideo) {
      console.log(`   ✅ [Drive API] 视频文件上传成功: ${filename} (文件ID: ${response.data.id})`);
    } else if (isGif) {
      console.log(`   ✅ [Drive API] GIF 文件上传成功: ${filename} (文件ID: ${response.data.id})`);
    }

    return response.data;
  } catch (error) {
    // 提供更详细的错误信息
    const errorInfo = {
      message: error.message,
      code: error.code,
      filename,
      mimeType,
      folderId,
      fileSizeMB
    };
    
    if (isVideo) {
      console.error(`   ❌ [Drive API] 视频文件上传失败:`, errorInfo);
      if (error.response) {
        console.error(`      - 状态码: ${error.response.status}`);
        console.error(`      - 响应数据:`, JSON.stringify(error.response.data, null, 2));
      }
    }
    
    throw new Error(`Google Drive 上传失败: ${error.message} (文件: ${filename}, 大小: ${fileSizeMB}MB)`);
  }
}

async function listFolderFiles({ folderId, pageSize = 50, orderBy = 'createdTime desc', fields = 'files(id,name,mimeType,createdTime,modifiedTime,size,parents),nextPageToken', supportsAllDrives = true, pageToken = null }) {
  if (!folderId || folderId.trim() === '' || folderId === '.') {
    throw new Error(`listFolderFiles 缺少或无效的 folderId: "${folderId}"`);
  }

  const drive = getDriveClient();

  // 检查是否是共享驱动器
  const isSharedDrive = folderId.startsWith('0A') || folderId.length === 33;

  const params = {
    q: `'${folderId}' in parents and trashed = false`,
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

module.exports = {
  uploadBuffer,
  listFolderFiles,
  downloadFileBuffer,
  trashFile,
  createFolder,
  getFileInfo
};

