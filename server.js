// server.js - WebSocket 服务器和 HTTP 上传接口
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const sharp = require('sharp');

// Google Drive 功能（可选）
let googleDriveEnabled = false;
let uploadBuffer = null;
let createFolder = null;
let getUserFolderId = null;
let initializeUserFolderForUpload = null;
try {
  const driveModule = require('./googleDrive');
  uploadBuffer = driveModule.uploadBuffer;
  createFolder = driveModule.createFolder;
  googleDriveEnabled = true;
  
  // 用户配置管理
  const userConfig = require('./userConfig');
  getUserFolderId = userConfig.getUserFolderId;
  
  // 为上传接口初始化用户文件夹的函数（带缓存）
  // 在 Cloud Run 上，无法访问本地配置文件，所以需要根据 userId 创建文件夹
  initializeUserFolderForUpload = async (userId) => {
    let DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
    
    // 如果环境变量未设置，尝试从 serviceAccountKey.js 读取默认值
    if (!DRIVE_FOLDER_ID) {
      try {
        const serviceAccountKey = require('./serviceAccountKey');
        if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
          DRIVE_FOLDER_ID = serviceAccountKey.defaultFolderId;
        }
      } catch (error) {
        // 忽略错误
      }
    }
    
    if (!DRIVE_FOLDER_ID) {
      throw new Error('未配置 GDRIVE_FOLDER_ID');
    }
    
    if (!userId) {
      throw new Error('未提供用户ID，无法创建用户文件夹');
    }
    
    // 检查缓存
    if (userFolderCache.has(userId)) {
      return userFolderCache.get(userId);
    }
    
    // 用户文件夹名称格式：FigmaSync-{userId}
    const userFolderName = `FigmaSync-${userId}`;
    
    // 使用 createFolder，它会自动检查文件夹是否已存在
    const { listFolderFiles } = require('./googleDrive');
    try {
      // 先快速检查缓存，如果不存在再查找
      const { files } = await listFolderFiles({
        folderId: DRIVE_FOLDER_ID,
        pageSize: 100, // 减少查询数量，只查前100个
        orderBy: 'modifiedTime desc' // 新文件夹通常在前面
      });
      
      // 查找同名的文件夹
      const existingFolder = files.find(
        file => file.name === userFolderName && 
        file.mimeType === 'application/vnd.google-apps.folder'
      );
      
      if (existingFolder) {
        userFolderCache.set(userId, existingFolder.id);
        return existingFolder.id;
      }
    } catch (error) {
      // 如果查找失败，尝试创建（createFolder 也会检查是否存在）
    }
    
    // 创建新文件夹（createFolder 内部会检查是否存在）
    const folder = await createFolder({
      folderName: userFolderName,
      parentFolderId: DRIVE_FOLDER_ID
    });
    
    // 缓存文件夹ID
    userFolderCache.set(userId, folder.id);
    return folder.id;
  };
  
  console.log('✅ Google Drive 模块已加载（可选功能）');
} catch (error) {
  console.log('ℹ️  Google Drive 模块未启用（iCloud 模式）');
}

// 阿里云 OSS 功能（可选）
let aliyunOSSEnabled = false;
let ossUploadBuffer = null;
let ossCreateFolder = null;
let ossInitializeUserFolderForUpload = null;
try {
  const ossModule = require('./aliyunOSS');
  ossUploadBuffer = ossModule.uploadBuffer;
  ossCreateFolder = ossModule.createFolder;
  aliyunOSSEnabled = true;
  
  // 用户配置管理
  if (!getUserFolderId) {
    const userConfig = require('./userConfig');
    getUserFolderId = userConfig.getUserFolderId;
  }
  
  // 为上传接口初始化用户文件夹的函数（带缓存）
  ossInitializeUserFolderForUpload = async (userId) => {
    const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync';
    
    if (!userId) {
      throw new Error('未提供用户ID，无法创建用户文件夹');
    }
    
    // 检查缓存
    if (userFolderCache.has(`oss:${userId}`)) {
      return userFolderCache.get(`oss:${userId}`);
    }
    
    // 用户文件夹名称格式：FigmaSync-{userId}
    const userFolderName = `FigmaSync-${userId}`;
    
    // 创建新文件夹（createFolder 内部会检查是否存在）
    const folder = await ossCreateFolder({
      folderName: userFolderName,
      parentFolderId: OSS_ROOT_FOLDER
    });
    
    // 缓存文件夹路径
    userFolderCache.set(`oss:${userId}`, folder.id);
    return folder.id;
  };
  
  console.log('✅ 阿里云 OSS 模块已加载（可选功能）');
} catch (error) {
  console.log('ℹ️  阿里云 OSS 模块未启用:', error.message);
}

const app = express();
const server = http.createServer(app);
// 增加 WebSocket payload 大小限制以支持大 GIF 文件（200MB）
const wss = new WebSocket.Server({ 
  server,
  maxPayload: 200 * 1024 * 1024 // 200MB
});

const connections = new Map();

let DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 如果环境变量未设置，尝试从 serviceAccountKey.js 读取默认值
if (!DRIVE_FOLDER_ID) {
  try {
    const serviceAccountKey = require('./serviceAccountKey');
    if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
      DRIVE_FOLDER_ID = serviceAccountKey.defaultFolderId;
      console.log('ℹ️  使用默认的 Google Drive 根文件夹ID（从 serviceAccountKey.js）');
    }
  } catch (error) {
    // 忽略错误，继续使用环境变量
  }
}

const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || null;

// 用户文件夹缓存：userId -> folderId，减少重复查找
const userFolderCache = new Map();

// ========== 上传队列管理器（控制并发和速率） ==========
class UploadQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 10; // 增加并发数到10（Google Drive API 限制：每秒100个请求）
    this.rateLimit = options.rateLimit || 50; // 提高速率限制到每秒50个（Google Drive API 限制：每秒100个请求）
    this.queue = [];
    this.processing = 0;
    this.lastProcessTime = 0;
    this.minInterval = 1000 / this.rateLimit; // 最小间隔（毫秒）
    this.processedCount = 0;
    this.lastResetTime = Date.now();
    // 正在处理中的任务集合（用于快速去重检查）
    this.processingTasks = new Set();
  }

  add(task) {
    // 优化去重逻辑：只检查正在处理中的任务，不检查队列中的任务
    // 这样可以允许队列中有多个相同文件名的任务（高频上传场景）
    const taskKey = `${task.userId || 'default'}:${task.filename}`;
    
    // 如果正在处理相同的任务，跳过（避免重复上传）
    if (this.processingTasks.has(taskKey)) {
      console.log(`⏭️  [队列] 跳过重复任务（正在处理中）: ${task.filename}`);
      return;
    }

    this.queue.push(task);
    const queueLength = this.queue.length;
    const waitTime = Date.now() - task.startTime;
    
    // 如果队列积压或等待时间过长，记录警告
    if (queueLength > 5) {
      console.log(`📋 [队列] 队列积压: ${queueLength} 个任务等待, 处理中: ${this.processing}, 等待时间: ${waitTime}ms`);
    }
    
    // 立即开始处理
    this.process();
  }

  async process() {
    // 如果已达到最大并发数，等待
    if (this.processing >= this.maxConcurrent) {
      return;
    }

    // 如果队列为空，返回
    if (this.queue.length === 0) {
      return;
    }

    // 从队列中取出任务（移除速率限制延迟，只保留并发控制，提高处理速度）
    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.processing++;
    this.lastProcessTime = Date.now();
    this.processedCount++;
    
    // 标记任务正在处理中（用于去重）
    const taskKey = `${task.userId || 'default'}:${task.filename}`;
    this.processingTasks.add(taskKey);

    // 异步处理任务（不阻塞队列处理）
    this.processTask(task).finally(() => {
      this.processing--;
      // 移除处理中标记
      this.processingTasks.delete(taskKey);
      // 立即继续处理队列中的下一个任务（不等待）
      setImmediate(() => this.process());
    });
  }

  async processTask(task) {
    const { userId, filename, data, mimeType, startTime, useOSS = false } = task;
    const processStartTime = Date.now();
    
    try {
      // 优化：先解析 Base64 字符串（只解析一次）
      let base64String = data;
      let detectedMime = mimeType;
      const dataUrlMatch = /^data:(.+);base64,(.*)$/.exec(base64String);
      if (dataUrlMatch) {
        detectedMime = detectedMime || dataUrlMatch[1];
        base64String = dataUrlMatch[2];
      }
      detectedMime = detectedMime || 'image/jpeg';
      
      // 并行处理：同时进行文件夹查找和 Base64 解码
      const [targetFolderId, buffer] = await Promise.all([
        // 1. 查找/创建用户文件夹（如果提供了用户ID）
        (async () => {
          if (useOSS) {
            // 使用阿里云 OSS
            if (userId && ossInitializeUserFolderForUpload) {
              try {
                return await ossInitializeUserFolderForUpload(userId);
              } catch (error) {
                console.error(`⚠️  [OSS上传] 创建用户文件夹失败: ${error.message}`);
                const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync';
                return OSS_ROOT_FOLDER;
              }
            }
            const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync';
            return OSS_ROOT_FOLDER;
          } else {
            // 使用 Google Drive
            if (userId && initializeUserFolderForUpload) {
              try {
                return await initializeUserFolderForUpload(userId);
              } catch (error) {
                console.error(`⚠️  [上传] 创建用户文件夹失败，使用共享文件夹: ${error.message}`);
                // 确保 DRIVE_FOLDER_ID 有值
                if (!DRIVE_FOLDER_ID) {
                  try {
                    const serviceAccountKey = require('./serviceAccountKey');
                    if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                      return serviceAccountKey.defaultFolderId;
                    }
                  } catch (e) {
                    // 忽略错误
                  }
                }
                return DRIVE_FOLDER_ID;
              }
            }
            // 确保 DRIVE_FOLDER_ID 有值
            if (!DRIVE_FOLDER_ID) {
              try {
                const serviceAccountKey = require('./serviceAccountKey');
                if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
                  return serviceAccountKey.defaultFolderId;
                }
              } catch (e) {
                // 忽略错误
              }
            }
            return DRIVE_FOLDER_ID;
          }
        })(),
        // 2. Base64 解码（CPU 密集型操作）
        // 优化：使用 setImmediate 避免阻塞事件循环，提高响应速度
        (async () => {
          return new Promise((resolve, reject) => {
            setImmediate(() => {
              try {
                resolve(Buffer.from(base64String, 'base64'));
              } catch (err) {
                reject(new Error(`Base64 解码失败: ${err.message}`));
              }
            });
          });
        })()
      ]);

      // 清理 Base64 字符串，释放内存（解码完成后不再需要）
      base64String = null;

      // 处理图片格式：检测并转换 HEIF/HEIC 格式为 JPEG
      // 因为 Google Drive 对 HEIF 格式支持有限，转换为 JPEG 更通用且文件更小
      let finalBuffer = buffer;
      let finalMimeType = detectedMime;
      let originalSize = buffer.length;
      
      try {
        // 检测是否为 HEIF/HEIC 格式（iPhone 快捷指令发送的格式）
        const isHeif = detectedMime && (
          detectedMime.toLowerCase().includes('heif') || 
          detectedMime.toLowerCase().includes('heic')
        );
        
        if (isHeif) {
          // 使用 sharp 将 HEIF 转换为 JPEG 格式
          const sharpImage = sharp(buffer);
          
          // 转换为 JPEG 格式（统一格式，减小文件大小，提高兼容性）
          finalBuffer = await sharpImage
            .resize(1920, null, {
              withoutEnlargement: true,
              fit: 'inside'
            })
            .jpeg({ quality: 85 })
            .toBuffer();
          
          finalMimeType = 'image/jpeg';
          
          const compressedSize = finalBuffer.length;
          if (compressedSize < originalSize) {
            const savedKB = ((originalSize - compressedSize) / 1024).toFixed(1);
            console.log(`   🖼️  [格式转换] HEIF → JPEG: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB (节省 ${savedKB}KB)`);
          } else {
            console.log(`   🖼️  [格式转换] HEIF → JPEG: ${(originalSize / 1024).toFixed(1)}KB → ${(compressedSize / 1024).toFixed(1)}KB`);
          }
          
          // 释放原始 buffer 内存
          buffer = null;
        }
      } catch (error) {
        // 如果图片处理失败，使用原始 buffer
        console.log(`   ⚠️  [格式转换] HEIF 处理失败，使用原始格式: ${error.message}`);
        finalBuffer = buffer;
        // 保持用户提供的 mimeType
        finalMimeType = detectedMime;
      }

      // 检查是否是视频文件
      const isVideo = finalMimeType && (
        finalMimeType.toLowerCase().startsWith('video/') ||
        filename.toLowerCase().endsWith('.mp4') ||
        filename.toLowerCase().endsWith('.mov')
      );
      
      if (isVideo) {
        console.log(`🎥 [上传] 检测到视频文件: ${filename} (${(finalBuffer.length / 1024 / 1024).toFixed(2)}MB, MIME: ${finalMimeType})`);
      }

      // 上传到 Google Drive 或阿里云 OSS
      const uploadStartTime = Date.now();
      let result;
      
      if (useOSS) {
        console.log(`📤 [OSS上传] 开始上传到 OSS: ${filename} → 文件夹 ${targetFolderId}`);
        result = await ossUploadBuffer({
          buffer: finalBuffer,
          filename,
          mimeType: finalMimeType,
          folderId: targetFolderId
        });
      } else {
        console.log(`📤 [上传] 开始上传到 Drive: ${filename} → 文件夹 ${targetFolderId}`);
        result = await uploadBuffer({
          buffer: finalBuffer,
          filename,
          mimeType: finalMimeType,
          folderId: targetFolderId
        });
      }

      const uploadDuration = Date.now() - uploadStartTime;
      const processDuration = Date.now() - processStartTime;
      const totalDuration = Date.now() - startTime;
      
      // 记录上传成功日志
      const fileSizeMB = (finalBuffer.length / 1024 / 1024).toFixed(2);
      const fileSizeKB = (finalBuffer.length / 1024).toFixed(1);
      const serviceName = useOSS ? 'OSS' : 'Drive';
      
      if (isVideo) {
        console.log(`✅ [${serviceName}上传] 视频文件上传成功: ${filename} (${fileSizeMB}MB, 处理:${processDuration}ms, 上传:${uploadDuration}ms, 总计:${totalDuration}ms, 文件ID: ${result.id || 'N/A'})`);
      } else if (uploadDuration > 2000 || processDuration > 3000 || totalDuration > 4000) {
        console.log(`✅ [${serviceName}上传] ${filename} → ${serviceName} (${fileSizeKB}KB, 处理:${processDuration}ms, 上传:${uploadDuration}ms, 总计:${totalDuration}ms, 文件ID: ${result.id || 'N/A'})`);
      } else {
        // 简短的成功日志
        console.log(`✅ [${serviceName}上传] ${filename} (${fileSizeKB}KB, 文件ID: ${result.id || 'N/A'})`);
      }
      
      // 立即释放 buffer 内存
      finalBuffer = null;
    } catch (error) {
      const serviceName = useOSS ? 'OSS上传' : '上传';
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        filename,
        userId,
        mimeType,
        folderId: targetFolderId || '未知'
      };
      console.error(`❌ [${serviceName}] ${filename} 失败:`, errorDetails);
      
      // 如果是视频文件，提供更详细的错误信息
      if (mimeType && (mimeType.toLowerCase().startsWith('video/') || filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'))) {
        console.error(`   🎥 视频文件上传失败详情:`);
        console.error(`      - 文件名: ${filename}`);
        console.error(`      - MIME类型: ${mimeType}`);
        console.error(`      - 用户ID: ${userId || '未提供'}`);
        console.error(`      - 目标文件夹ID: ${targetFolderId || '未知'}`);
        console.error(`      - 错误信息: ${error.message}`);
        if (error.stack) {
          console.error(`      - 堆栈: ${error.stack.split('\n').slice(0, 3).join('\n')}`);
        }
      }
    }
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      processedCount: this.processedCount
    };
  }
}

// 创建上传队列实例
const uploadQueue = new UploadQueue({
  maxConcurrent: 10, // 增加并发数到10（Google Drive API 限制：每秒100个请求）
  rateLimit: 50 // 提高速率限制到每秒50个（Google Drive API 限制：每秒100个请求）
});

// 优化 JSON 解析：使用更快的解析器，并设置合理的超时
// 注意：Base64 编码会增加约 33% 的大小，所以 200MB 限制可以支持约 150MB 的原始文件
app.use(express.json({ 
  limit: '200mb', // 增加到 200MB 以支持大视频和 GIF 文件
  strict: false, // 允许非严格 JSON（更快）
  type: 'application/json'
}));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// 设置请求超时（120秒），大文件上传需要更长时间
app.use((req, res, next) => {
  req.setTimeout(120000); // 120秒超时（大文件上传需要更长时间）
  res.setTimeout(120000);
  next();
});

console.log('🚀 服务器启动\n');

app.get('/health', (req, res) => {
  const queueStats = uploadQueue ? uploadQueue.getStats() : null;
  res.json({ 
    status: 'ok',
    connections: connections.size,
    googleDriveEnabled,
    uploadQueue: queueStats,
    timestamp: new Date().toISOString()
  });
});

// 阿里云 OSS 上传接口（可选）
if (aliyunOSSEnabled && ossUploadBuffer) {
  app.post('/upload-oss', async (req, res) => {
    const startTime = Date.now();
    const parseStartTime = Date.now();
    const userId = req.headers['x-user-id'] || req.body.userId || null;
    
    try {
      const OSS_ROOT_FOLDER = process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync';
      
      if (!OSS_ROOT_FOLDER) {
        return res.status(500).json({ error: 'Server not configured: missing ALIYUN_ROOT_FOLDER' });
      }

      if (UPLOAD_TOKEN) {
        const token = req.headers['x-upload-token'];
        if (token !== UPLOAD_TOKEN) {
          return res.status(401).json({ error: 'Invalid upload token' });
        }
      }

      const parseTime = Date.now() - parseStartTime;
      if (parseTime > 500) {
        console.log(`⚠️  [OSS上传] JSON 解析耗时: ${parseTime}ms`);
      }

      const body = req.body || {};
      const filename = body.filename;
      const data = body.data;
      const mimeType = body.mimeType;
      
      const isVideo = filename && (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'));
      const isGif = filename && filename.toLowerCase().endsWith('.gif');
      const isLargeFile = isVideo || isGif;
      
      if (isLargeFile) {
        const dataLength = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
        const dataSizeMB = (dataLength / 1024 / 1024).toFixed(2);
        const fileType = isVideo ? '视频' : 'GIF';
        console.log(`📥 [OSS接收] ${fileType}文件上传请求: ${filename}, 用户ID: ${userId || '未提供'}, MIME: ${mimeType || '未提供'}, Base64数据大小: ${dataSizeMB}MB`);
        
        const estimatedOriginalSizeMB = (dataLength * 0.75 / 1024 / 1024).toFixed(2);
        console.log(`   📊 估算原始文件大小: ${estimatedOriginalSizeMB}MB`);
        
        if (dataLength > 200 * 1024 * 1024) {
          console.warn(`   ⚠️  警告：Base64 数据大小 (${dataSizeMB}MB) 超过 200MB 限制，可能导致上传失败`);
        }
      }
      
      if (!filename || !data) {
        console.error(`❌ [OSS上传] 请求参数缺失: filename=${!!filename}, data=${!!data}, userId=${userId || '未提供'}, mimeType=${mimeType || '未提供'}`);
        return res.status(400).json({ error: 'Missing filename or data' });
      }

      res.json({
        success: true,
        message: 'Upload queued',
        filename: filename
      });

      const responseTime = Date.now() - startTime;
      
      if (responseTime > 100) {
        console.log(`📤 [OSS上传] ${userId || '未知用户'} - ${filename} (响应: ${responseTime}ms)`);
      }

      process.nextTick(() => {
        uploadQueue.add({
          userId,
          filename,
          data,
          mimeType: body.mimeType,
          startTime,
          useOSS: true // 标记使用 OSS
        });
      });
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`❌ [OSS上传] 处理失败 (${errorTime}ms):`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Upload failed' });
      }
    }
  });
  console.log('✅ 阿里云 OSS 上传接口已启用: POST /upload-oss');
} else {
  console.log('ℹ️  阿里云 OSS 上传接口未启用');
}

// Google Drive 上传接口（可选）
if (googleDriveEnabled && uploadBuffer) {
  app.post('/upload', async (req, res) => {
    const startTime = Date.now();
    const parseStartTime = Date.now();
    const userId = req.headers['x-user-id'] || req.body.userId || null;
    
    try {
      // 快速验证（在返回响应之前只做必要检查，最小化验证时间）
      // 如果 DRIVE_FOLDER_ID 未设置，尝试从 serviceAccountKey.js 读取默认值
      let currentDriveFolderId = DRIVE_FOLDER_ID;
      if (!currentDriveFolderId) {
        try {
          const serviceAccountKey = require('./serviceAccountKey');
          if (serviceAccountKey && serviceAccountKey.defaultFolderId) {
            currentDriveFolderId = serviceAccountKey.defaultFolderId;
          }
        } catch (error) {
          // 忽略错误
        }
      }
      
      if (!currentDriveFolderId) {
        return res.status(500).json({ error: 'Server not configured: missing GDRIVE_FOLDER_ID' });
      }

      if (UPLOAD_TOKEN) {
        const token = req.headers['x-upload-token'];
        if (token !== UPLOAD_TOKEN) {
          return res.status(401).json({ error: 'Invalid upload token' });
        }
      }

      // 记录 JSON 解析时间（用于诊断）
      const parseTime = Date.now() - parseStartTime;
      if (parseTime > 500) {
        console.log(`⚠️  [上传] JSON 解析耗时: ${parseTime}ms`);
      }

      // 快速检查请求体（不解析完整 JSON，只检查必要字段）
      const body = req.body || {};
      const filename = body.filename;
      const data = body.data;
      const mimeType = body.mimeType;
      
      // 记录请求信息（用于调试大文件：视频和 GIF）
      const isVideo = filename && (filename.toLowerCase().endsWith('.mp4') || filename.toLowerCase().endsWith('.mov'));
      const isGif = filename && filename.toLowerCase().endsWith('.gif');
      const isLargeFile = isVideo || isGif;
      
      if (isLargeFile) {
        const dataLength = data ? (typeof data === 'string' ? data.length : JSON.stringify(data).length) : 0;
        const dataSizeMB = (dataLength / 1024 / 1024).toFixed(2);
        const fileType = isVideo ? '视频' : 'GIF';
        console.log(`📥 [接收] ${fileType}文件上传请求: ${filename}, 用户ID: ${userId || '未提供'}, MIME: ${mimeType || '未提供'}, Base64数据大小: ${dataSizeMB}MB`);
        
        // 估算原始文件大小（Base64 编码会增加约 33%）
        const estimatedOriginalSizeMB = (dataLength * 0.75 / 1024 / 1024).toFixed(2);
        console.log(`   📊 估算原始文件大小: ${estimatedOriginalSizeMB}MB`);
        
        // 检查是否超过限制
        if (dataLength > 200 * 1024 * 1024) {
          console.warn(`   ⚠️  警告：Base64 数据大小 (${dataSizeMB}MB) 超过 200MB 限制，可能导致上传失败`);
        }
      }
      
      // 只做最基本的检查，立即返回
      if (!filename || !data) {
        console.error(`❌ [上传] 请求参数缺失: filename=${!!filename}, data=${!!data}, userId=${userId || '未提供'}, mimeType=${mimeType || '未提供'}`);
        return res.status(400).json({ error: 'Missing filename or data' });
      }

      // 立即返回成功响应（在 50ms 内），不等待任何处理
      // 这样 iPhone 快捷指令可以立即完成，用户感觉截屏很快
      res.json({
        success: true,
        message: 'Upload queued',
        filename: filename
      });

      // 记录响应时间（在返回响应之后）
      const responseTime = Date.now() - startTime;
      
      // 优化：减少日志输出，只在响应时间过长时记录
      if (responseTime > 100) {
        console.log(`📤 [上传] ${userId || '未知用户'} - ${filename} (响应: ${responseTime}ms)`);
      }

      // 将任务加入队列，由队列管理器控制并发和速率
      // 优化：使用 process.nextTick 确保响应已发送后再处理，避免阻塞响应
      process.nextTick(() => {
        uploadQueue.add({
          userId,
          filename,
          data,
          mimeType: body.mimeType,
          startTime
        });
      });
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`❌ [上传] 处理失败 (${errorTime}ms):`, error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || 'Upload failed' });
      }
    }
  });
  console.log('✅ Google Drive 上传接口已启用: POST /upload');
} else {
  console.log('ℹ️  Google Drive 上传接口未启用（使用 iCloud 模式）');
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const connectionId = params.get('id');
  const clientType = params.get('type');
  
  if (!connectionId || !clientType) {
    console.log('❌ WebSocket连接参数缺失，拒绝连接');
    ws.close();
    return;
  }
  
  if (!connections.has(connectionId)) {
    connections.set(connectionId, {});
  }
  
  const group = connections.get(connectionId);
  group[clientType] = ws;
  console.log(`🔌 WebSocket连接: ${clientType} (${connectionId})`);
  
  // 消息处理
  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      console.log('   ❌ JSON解析失败:', error.message);
      return;
    }
    
    // Ping处理
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    
    const targetGroup = connections.get(connectionId);
    if (!targetGroup) {
      console.log('   ❌ 连接组不存在');
      return;
    }
    
    // 控制消息处理
    if (data.type === 'start-realtime' || 
        data.type === 'stop-realtime' || 
        data.type === 'manual-sync') {
      if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
        try {
          targetGroup.mac.send(JSON.stringify(data));
        } catch (error) {
          console.log('   ❌ 发送到Mac端失败:', error.message);
        }
      } else {
        // 通知Figma Mac端未连接
        if (clientType === 'figma' && targetGroup.figma && 
            targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'error',
            message: 'Mac端未连接'
          }));
        }
      }
      return;
    }
    
    // 同步模式切换消息处理
    if (data.type === 'switch-sync-mode' || data.type === 'get-sync-mode') {
      if (data.type === 'get-sync-mode') {
        const currentMode = process.env.SYNC_MODE || 'drive';
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          targetGroup.figma.send(JSON.stringify({
            type: 'sync-mode-info',
            mode: currentMode
          }));
        }
      } else if (data.type === 'switch-sync-mode') {
        const newMode = data.mode;
        
        // 如果是切换到 iCloud，需要验证文件夹
        if (newMode === 'icloud') {
          const fs = require('fs');
          const path = require('path');
          const icloudPath = path.join(
            process.env.HOME,
            'Library/Mobile Documents/com~apple~CloudDocs/FigmaSyncImg'
          );
          
          try {
            // 尝试创建文件夹
            fs.mkdirSync(icloudPath, { recursive: true });
            
            // 验证文件夹是否可写
            if (!fs.existsSync(icloudPath) || !fs.statSync(icloudPath).isDirectory()) {
              throw new Error('文件夹创建失败');
            }
            
            // 测试写入权限
            const testFile = path.join(icloudPath, '.test-write');
            try {
              fs.writeFileSync(testFile, 'test');
              fs.unlinkSync(testFile);
            } catch (err) {
              throw new Error('文件夹无写入权限');
            }
            
          } catch (error) {
            if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
              targetGroup.figma.send(JSON.stringify({
                type: 'switch-sync-mode-result',
                success: false,
                message: 'iCloud 文件夹创建失败：' + error.message + '。请检查 iCloud Drive 是否启用或空间是否充足。'
              }));
            }
            return;
          }
        }
        
        process.env.SYNC_MODE = newMode;
        
        // 写入配置文件
        const fs = require('fs');
        const path = require('path');
        const syncModeFile = path.join(__dirname, '.sync-mode');
        try {
          fs.writeFileSync(syncModeFile, newMode, 'utf8');
        } catch (error) {
          console.log('   ⚠️  写入配置文件失败:', error.message);
        }
        
        // 通知 Mac 端切换模式
        if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
          targetGroup.mac.send(JSON.stringify({
            type: 'switch-sync-mode',
            mode: newMode
          }));
        }
        
        // 通知 Figma 端切换成功
        if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
          let modeName = '未知模式';
          if (newMode === 'drive' || newMode === 'google') {
            modeName = 'Google Drive';
          } else if (newMode === 'aliyun' || newMode === 'oss') {
            modeName = '阿里云 OSS';
          } else if (newMode === 'icloud') {
            modeName = 'iCloud';
          }
          
          targetGroup.figma.send(JSON.stringify({
            type: 'switch-sync-mode-result',
            success: true,
            mode: newMode,
            message: '上传模式已切换为 ' + modeName
          }));
          targetGroup.figma.send(JSON.stringify({
            type: 'sync-mode-changed',
            mode: newMode
          }));
        }
      }
      return;
    }
    
    // 截图消息
    if (data.type === 'screenshot') {
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify(data));
      }
      return;
    }
    
    // 文件跳过消息（MP4 或大于150MB的GIF）
    if (data.type === 'file-skipped') {
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify(data));
      }
      return;
    }
    
    // 确认消息
    if (data.type === 'screenshot-received' || data.type === 'screenshot-failed') {
      if (targetGroup.mac && targetGroup.mac.readyState === WebSocket.OPEN) {
        targetGroup.mac.send(JSON.stringify(data));
      }
      return;
    }
    
    // 手动同步完成
    if (data.type === 'manual-sync-complete') {
      if (targetGroup.figma && targetGroup.figma.readyState === WebSocket.OPEN) {
        targetGroup.figma.send(JSON.stringify(data));
      }
      return;
    }
  });
  
  ws.on('close', () => {
    const group = connections.get(connectionId);
    if (group) {
      delete group[clientType];
      if (!group.figma && !group.mac) {
        connections.delete(connectionId);
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket错误 (', clientType, '):', error.message);
  });
});

const PORT = process.env.PORT || 8888;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('✅ 服务器运行在: http://' + HOST + ':' + PORT);
  console.log('📊 健康检查: http://' + HOST + ':' + PORT + '/health');
  console.log('⏳ 等待连接...\n');
});

process.on('SIGINT', () => {
  console.log('\n\n👋 关闭服务器...');
  server.close(() => process.exit(0));
});