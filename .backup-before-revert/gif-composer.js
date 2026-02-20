// gif-composer.js - GIF annotation composition engine
// Extracted from server.js for maintainability

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 🔒 并发导出序号锁：防止多个导出同时扫描文件夹时拿到相同序号
const _reservedExportNumbers = new Set();

/**
 * Factory: inject server-level dependencies and return the composer function.
 * @param {object} deps
 * @param {Function} deps.execAsyncCancellable - Cancellable exec wrapper
 * @param {Function} deps.removeDirRecursive  - Recursive directory removal
 * @param {object}   deps.userConfig          - User configuration module
 * @returns {Function} composeAnnotatedGif
 */
module.exports = function createComposer({ execAsyncCancellable, removeDirRecursive, userConfig }) {

async function composeAnnotatedGif({ frameName, bottomLayerBytes, staticLayers, annotationLayers, annotationBytes, frameBounds, frameBackground, gifInfos, timelineData, gifAlgorithm, connectionId, shouldCancel, onProgress }) {
  // 🎨 根据 gifAlgorithm 设置选择抖动算法
  // ═══════════════════════════════════════════════════════════════════════════
  // less_noise (更少噪点): 
  //   - FFmpeg: dither=none - 完全无抖动，画面最干净，但渐变可能有色带
  //   - ImageMagick: -dither None
  //   - 适合: 纯色、图标、UI界面、文字
  //
  // smooth_gradient (更丝滑渐变):
  //   - FFmpeg: dither=bayer:bayer_scale=3 - 有序抖动，产生细腻的抖动图案
  //   - ImageMagick: -dither Riemersma（比 FloydSteinberg 更适合渐变）
  //   - 适合: 照片、渐变背景、复杂色彩
  // ═══════════════════════════════════════════════════════════════════════════
  const ditherMode = gifAlgorithm === 'smooth_gradient' ? 'bayer:bayer_scale=3' : 'none';
  const imageMagickDither = gifAlgorithm === 'smooth_gradient' ? 'Riemersma' : 'None';
  console.log(`\n🎨 GIF算法: ${gifAlgorithm || 'smooth_gradient'} → FFmpeg dither=${ditherMode}, ImageMagick dither=${imageMagickDither}\n`);
  

  // ✅ 使用可取消的 execAsync 包装函数，自动跟踪子进程
  const execAsync = (cmd, options = {}) => {
    // 在执行前检查是否已取消
    if (shouldCancel && shouldCancel()) {
      return Promise.reject(new Error('GIF_EXPORT_CANCELLED'));
    }
    return execAsyncCancellable(cmd, options, connectionId);
  };

  // 进度汇报辅助函数
  const reportProgress = (percent, message) => {
    if (onProgress) {
      onProgress(percent, message);
    }
  };

  // 取消检查辅助函数
  const checkCancelled = () => {
    if (shouldCancel && shouldCancel()) {
      throw new Error('GIF_EXPORT_CANCELLED');
    }
  };
  
  console.log('🎬 开始合成 GIF...');
  
  // 1. 定义查找路径和命令
  const searchPaths = [
    '/opt/homebrew/bin',  // Apple Silicon
    '/usr/local/bin',     // Intel Mac
    '/opt/local/bin',     // MacPorts
    '/usr/bin',
    '/bin'
  ];
  
  // 2. 尝试自动修复 PATH
  let pathModified = false;
  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath) && !process.env.PATH.includes(searchPath)) {
      process.env.PATH = `${searchPath}:${process.env.PATH}`;
      pathModified = true;
    }
  }


  try {
    // 3. 直接验证 convert 命令可用性 (绕过 which)
    let convertPath = 'convert';
    let versionOutput = '';
    let found = false;

    // 先尝试直接运行 convert
    try {
      const result = await execAsync('convert --version');
      versionOutput = result.stdout;
      found = true;
    } catch (e) {
      // 如果直接运行失败，尝试绝对路径
      for (const searchPath of searchPaths) {
        const fullPath = path.join(searchPath, 'convert');
        if (fs.existsSync(fullPath)) {
          try {
            const result = await execAsync(`"${fullPath}" --version`);
            versionOutput = result.stdout;
            convertPath = fullPath; // 记录找到的完整路径
            // 确保这个路径在 PATH 中 (再次确认)
            if (!process.env.PATH.includes(searchPath)) {
               process.env.PATH = `${searchPath}:${process.env.PATH}`;
            }
            found = true;
            break;
          } catch (err) {
            // 忽略执行错误
          }
        }
      }
    }

    if (!found) {
      throw new Error('无法执行 convert 命令');
    }
    
    // 4. 检查是否真的是 ImageMagick
    const versionLine = versionOutput.split('\n')[0].trim();
    if (!versionLine.toLowerCase().includes('imagemagick')) {
      console.warn('⚠️ convert 可能不是 ImageMagick');
    }

    // 5. 验证 identify 命令
    try {
      await execAsync('identify -version');
    } catch (e) {
      // 静默处理
    }
  } catch (e) {
    console.error('\n❌ ImageMagick 未找到！');
    console.error('   错误:', e.message);
    console.error('');
    console.error('📋 快速解决方案：');
    console.error('   1. 重启服务器试试（Ctrl+C 然后 npm start）');
    console.error('   2. 或运行: brew install imagemagick');
    console.error('   3. 或运行: brew link imagemagick --force');
    console.error('');
    throw new Error('未找到 ImageMagick');
  }
  
  console.log('📋 输入信息:');
  console.log(`   Frame: ${frameName || '未命名'} (${frameBounds.width}x${frameBounds.height}), ${gifInfos.length} 个 GIF`);
  
  // 1. 获取必要的配置 (userConfig injected via factory)
  
  // 根据当前同步模式确定保存路径
  const currentMode = process.env.SYNC_MODE || 'drive';
  let downloadFolder;
  
  if (currentMode === 'icloud') {
    // iCloud 模式：保存到 iCloud/ScreenSyncImg/GIF-导出 子文件夹
    // 这样监听器只需监听 ScreenSyncImg 根目录，不会与导出的 GIF 混淆
    downloadFolder = path.join(
      os.homedir(),
      'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg/GIF-导出'
    );
  } else {
    // Google Drive 或其他模式：保存到 ScreenSyncImg/GIF-导出 子文件夹
    const baseFolder = userConfig.getLocalDownloadFolder();
    downloadFolder = path.join(baseFolder, 'GIF-导出');
  }
  
  // 确保输出文件夹存在
  if (!fs.existsSync(downloadFolder)) {
    fs.mkdirSync(downloadFolder, { recursive: true });
  }
  
  // 1.5. 生成输出文件名（使用序号命名，填补空缺）
  // 扫描文件夹找到所有现有序号 + 并发锁中已预留的序号
  const occupiedNumbers = new Set(_reservedExportNumbers); // 复制已预留序号
  try {
    const files = fs.readdirSync(downloadFolder);
    files.forEach(file => {
      const match = file.match(/^ExportedGIF_(\d+)\.gif$/);
      if (match) {
        occupiedNumbers.add(parseInt(match[1], 10));
      }
    });
  } catch (err) {
    console.warn(`   ⚠️  扫描文件夹失败: ${err.message}`);
  }
  
  // 找到第一个未被占用的序号（磁盘 + 并发预留均跳过）
  let sequenceNumber = 1;
  while (occupiedNumbers.has(sequenceNumber)) {
    sequenceNumber++;
  }
  
  // 🔒 立即预留该序号，防止并发导出拿到同一个
  _reservedExportNumbers.add(sequenceNumber);
  
  const paddedNumber = sequenceNumber.toString().padStart(3, '0');
  const outputFilename = `ExportedGIF_${paddedNumber}.gif`;
  const outputPath = path.join(downloadFolder, outputFilename);
  
  // 如果文件已存在，直接跳过所有处理
  if (fs.existsSync(outputPath)) {
    console.log(`\n⏭️  文件已存在，跳过所有处理: ${outputFilename}`);
    const stats = fs.statSync(outputPath);
    reportProgress(100, '文件已存在，已跳过');
    _reservedExportNumbers.delete(sequenceNumber); // 🔒 释放预留序号
    
    return {
      outputPath,
      filename: outputFilename,
      size: stats.size,
      skipped: true
    };
  }
  
  // 为每个导出请求创建独立的临时文件夹（避免并发冲突）
  // 使用 connectionId + 时间戳 确保唯一性
  const uniqueId = `${connectionId}_${Date.now()}`;
  const tempDir = path.join(downloadFolder, `.temp-gif-compose-${uniqueId}`);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  // 2. 验证并查找所有原始 GIF/视频 文件
  
  // 验证 gifInfos 数据结构
  if (!gifInfos || !Array.isArray(gifInfos) || gifInfos.length === 0) {
    throw new Error('gifInfos 为空或格式不正确');
  }
  
  const gifPaths = [];
  for (let i = 0; i < gifInfos.length; i++) {
    const gif = gifInfos[i];
    
    // 验证每个 gif 对象的结构
    if (!gif) {
      console.error(`   ❌ GIF ${i + 1} 数据为空，跳过`);
      continue;
    }
    
    if (!gif.bounds) {
      console.error(`   ❌ GIF ${i + 1} 缺少 bounds 信息:`, gif);
      throw new Error(`GIF ${i + 1} (${gif.filename || '未知'}) 缺少位置信息 (bounds)`);
    }
    
    
    let gifPath = null;
    
    // 方法 1：从缓存通过 ID 查找
    if (gif.cacheId) {
      const cacheResult = userConfig.getGifFromCache(null, gif.cacheId);
      
      if (cacheResult) {
        gifPath = cacheResult.path;
      }
    }
    
    // 方法 2：从缓存通过文件名查找
    if (!gifPath && gif.filename) {
      const cacheResult = userConfig.getGifFromCache(gif.filename, null);
      
      if (cacheResult) {
        gifPath = cacheResult.path;
      }
    }
    
    // 方法 2.5：从 GIF 缓存查找
    if (!gifPath && (gif.cacheId || gif.filename)) {
      if (gif.cacheId) {
        const cacheResult = userConfig.getGifFromCache(null, gif.cacheId);
        if (cacheResult && cacheResult.path) {
          gifPath = cacheResult.path;
          
          // 验证文件是否存在且有效
          if (fs.existsSync(gifPath)) {
            const stats = fs.statSync(gifPath);
            if (stats.size === 0) {
              console.warn(`         ⚠️  缓存文件为空，将删除: ${gifPath}`);
              try {
                fs.unlinkSync(gifPath);
                // 删除对应的 meta 文件
                const metaPath = gifPath.replace(/\.(gif|mov|mp4)$/, '.meta.json');
                if (fs.existsSync(metaPath)) {
                  fs.unlinkSync(metaPath);
                }
              } catch (e) {
                console.error(`         删除损坏文件失败:`, e.message);
              }
              gifPath = null; // 重置，继续查找
            }
          } else {
            console.warn(`         ⚠️  缓存文件不存在: ${gifPath}`);
            gifPath = null;
          }
        }
      }
      
      // 备用：通过文件名匹配
      if (!gifPath && gif.filename) {
        const driveId = gif.driveFileId || gif.ossFileId;
        if (driveId) {
          const cacheResult = userConfig.getGifFromCache(driveId);
          if (cacheResult && cacheResult.path && fs.existsSync(cacheResult.path)) {
            gifPath = cacheResult.path;
          }
        }
      }
    }
    
    // 方法 2.6：从 ScreenSyncImg 各子文件夹查找
    if (!gifPath && (gif.driveFileId || gif.ossFileId || gif.filename)) {
      
      const localFolder = userConfig.getLocalDownloadFolder();
      const fileId = gif.driveFileId || gif.ossFileId;
      
      if (fileId) {
        // 定义搜索路径优先级
        const searchFolders = [
          path.join(localFolder, 'GIF-导出'), // 兼容之前的逻辑
          path.join(localFolder, '视频'),     // 手动上传的视频
          path.join(localFolder, 'GIF'),      // 手动上传的 GIF
          path.join(localFolder, '图片'),
          localFolder                         // 根目录
        ];
        
        for (const folder of searchFolders) {
          if (fs.existsSync(folder)) {
            const directPath = path.join(folder, fileId);
            if (fs.existsSync(directPath)) {
              gifPath = directPath;
              break;
            }
          }
        }
      }
      
      // 备用：如果还没找到，且有 filename，尝试在 GIF-导出 中模糊查找（兼容旧逻辑）
      if (!gifPath && gif.filename) {
        const gifExportFolder = path.join(localFolder, 'GIF-导出');
        if (fs.existsSync(gifExportFolder)) {
          // 列出所有文件
          const allFiles = fs.readdirSync(gifExportFolder);
          
          // 精确匹配
          if (allFiles.includes(gif.filename)) {
            gifPath = path.join(gifExportFolder, gif.filename);
          } else {
            // 模糊匹配（去除扩展名后比较）
            const targetExt = path.extname(gif.filename).toLowerCase();
            const targetName = path.basename(gif.filename, targetExt);
            
            for (const file of allFiles) {
              const fileExt = path.extname(file).toLowerCase();
              const fileName = path.basename(file, fileExt);
              
              if (fileName === targetName && ['.gif', '.mov', '.mp4'].includes(fileExt)) {
                gifPath = path.join(gifExportFolder, file);
                console.log(`      ✅ 模糊匹配文件名: ${file}`);
                break;
              }
            }
          }
        }
      }
    }
    
    // 方法 3：从 ScreenSyncImg 文件夹查找
    if (!gifPath && gif.filename) {
      let baseFolder;
      if (currentMode === 'icloud') {
        baseFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
      } else {
        baseFolder = userConfig.getLocalDownloadFolder();
      }
      
      const searchFolders = [
        baseFolder,
        path.join(baseFolder, '视频'),
        path.join(baseFolder, 'GIF'),
      ];
      
      const targetExt = path.extname(gif.filename).toLowerCase();
      const targetName = path.basename(gif.filename, targetExt);
      const targetNameClean = targetName.replace(/_\d+$/, '');
      
      // 查找匹配的文件（支持模糊匹配和扩展名变化）
      const compatibleExts = ['.mov', '.mp4', '.gif'];
      
      let matchingFile = null;
      let matchingFolder = null;
      
      // 遍历所有搜索文件夹
      for (const searchFolder of searchFolders) {
        if (!fs.existsSync(searchFolder)) {
          continue;
        }
        
        const filesInFolder = fs.readdirSync(searchFolder);
        
        matchingFile = filesInFolder.find(f => {
          // 跳过已导出的文件
          if (f.toLowerCase().includes('_exported') || f.toLowerCase().includes('导出')) return false;
          
          const fExt = path.extname(f).toLowerCase();
          const fName = path.basename(f, fExt);
          const fNameClean = fName.replace(/_\d+$/, '');
          
          // 只处理视频/GIF 文件
          if (!compatibleExts.includes(fExt)) return false;
          
          // 1. 完全匹配
          if (f === gif.filename) return true;
          
          // 2. 文件名匹配（忽略后缀和扩展名）
          if (fNameClean === targetNameClean) {
            if (compatibleExts.includes(targetExt)) {
              return true;
            }
          }
          
          // 3. 包含匹配（如果文件名很长，允许部分匹配）
          if (fNameClean.includes(targetNameClean) || targetNameClean.includes(fNameClean)) {
            if (compatibleExts.includes(targetExt)) {
              return true;
            }
          }
          
          // 4. 宽松匹配：去掉所有特殊字符后比较
          const targetSimple = targetNameClean.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          const fSimple = fNameClean.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          
          if (targetSimple && fSimple && targetSimple.length > 5 && fSimple.length > 5) {
            // 如果简化后的名称有一个包含另一个
            if (targetSimple.includes(fSimple) || fSimple.includes(targetSimple)) {
              return true;
            }
          }
          
          // 5. 时间戳匹配：针对 ScreenRecording 文件
          // ScreenRecording_12-22-2025 22-27-25.mov
          const timePattern = /\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}-\d{1,2}-\d{1,2}/;
          const targetTime = targetNameClean.match(timePattern);
          const fTime = fNameClean.match(timePattern);
          
          if (targetTime && fTime && targetTime[0] === fTime[0]) {
            return true;
          }
          
          return false;
        });
        
        if (matchingFile) {
          matchingFolder = searchFolder;
          gifPath = path.join(searchFolder, matchingFile);
          console.log(`      ✅ 从 ${path.basename(searchFolder)}/ 文件夹找到: ${matchingFile}`);
          if (matchingFile !== gif.filename) {
            console.log(`         📝 注意：实际文件名与请求的文件名不同`);
            console.log(`            请求: ${gif.filename}`);
            console.log(`            实际: ${matchingFile}`);
          }
          break; // 找到就退出循环
        }
      }
      
      // 如果没找到，输出详细的调试信息
    }
    
    // 方法 4：单 GIF 自动匹配
    if (!gifPath && gifInfos.length === 1) {
      let baseFolder;
      if (currentMode === 'icloud') {
        baseFolder = path.join(
          os.homedir(),
          'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg'
        );
      } else {
        baseFolder = userConfig.getLocalDownloadFolder();
      }
      
      const searchFolders = [
        baseFolder,
        path.join(baseFolder, '视频'),
        path.join(baseFolder, 'GIF'),
      ];
      
      const allVideoGifFiles = [];
      const compatibleExts = ['.mov', '.mp4', '.gif'];
      
      for (const searchFolder of searchFolders) {
        if (!fs.existsSync(searchFolder)) continue;
        
        const filesInFolder = fs.readdirSync(searchFolder);
        for (const f of filesInFolder) {
          if (f.startsWith('.')) continue;
          if (f.toLowerCase().includes('_exported') || f.toLowerCase().includes('导出')) continue;
          if (f.toLowerCase().includes('exportedgif')) continue;
          
          const fExt = path.extname(f).toLowerCase();
          if (compatibleExts.includes(fExt)) {
            allVideoGifFiles.push({
              filename: f,
              path: path.join(searchFolder, f),
              folder: searchFolder
            });
          }
        }
      }
      
      if (allVideoGifFiles.length === 1) {
        gifPath = allVideoGifFiles[0].path;
      }
    }
    
    if (!gifPath) {
      // 根据情况给出不同的错误提示
      const isSingleGif = gifInfos.length === 1;
      const errorHint = isSingleGif
        ? `\n\n💡 单 GIF 模式提示：\n• 将视频/GIF 文件放入 ScreenSyncImg 文件夹\n• 如果文件夹中只有一个视频/GIF，无需重命名\n• 如果有多个文件，请删除多余的或重命名为图层名`
        : `\n\n💡 多 GIF 模式提示：\n• 请确保每个 GIF 图层都有对应的同名源文件\n• 文件名需要与 Figma 图层名一致`;
      
      throw new Error(`未找到 GIF/视频文件: ${gif.filename}\n\n已尝试：\n• GIF 缓存 (ID: ${gif.cacheId || '无'})\n• 文件名匹配\n• 单 GIF 自动匹配\n• ScreenSyncImg 文件夹: ${downloadFolder}${errorHint}`);
    }
    
    // 再次验证 bounds 数据完整性
    if (!gif.bounds || gif.bounds.x === undefined || gif.bounds.y === undefined) {
      console.error(`      ❌ Bounds 数据不完整:`, gif.bounds);
      throw new Error(`GIF ${i + 1} (${gif.filename}) 的位置信息不完整`);
    }
    
    gifPaths.push({
      path: gifPath,
      bounds: gif.bounds,
      cornerRadius: gif.cornerRadius,
      clipBounds: gif.clipBounds,
      clipCornerRadius: gif.clipCornerRadius,
      imageFillInfo: gif.imageFillInfo, // ✅ 传递 imageFillInfo
      zIndex: gif.zIndex, // ✅ 传递 z-index
      layerId: gif.layerId // ✅ 传递 layerId 用于时间线功能
    });
    
  }
  
  
  // 2.5. 预处理：将视频文件转换为高帧率 GIF
  
  // 检查是否有视频文件
  const hasVideo = gifPaths.some(item => {
    const ext = path.extname(item.path).toLowerCase();
    return ext === '.mp4' || ext === '.mov';
  });
  
  // 如果有视频文件，预先检查 FFmpeg
  if (hasVideo) {
    try {
      await execAsync('which ffmpeg');
    } catch (e) {
      throw new Error('未找到 FFmpeg\n\n视频转 GIF 需要 FFmpeg，请先安装:\nbrew install ffmpeg');
    }
  }
  
  // 🚀 优化：并行处理所有视频/GIF 转换任务
  // 🎨 GIF 文件也需要重新处理以应用用户选择的抖动算法
  await Promise.all(gifPaths.map(async (item, i) => {
    const ext = path.extname(item.path).toLowerCase();
    
    if (ext === '.mp4' || ext === '.mov' || ext === '.gif') {
      const processedGifPath = path.join(tempDir, `processed_${i}.gif`);
      const palettePath = path.join(tempDir, `palette_${i}.png`);
      
      const targetW = Math.round(item.bounds.width);
      const targetH = Math.round(item.bounds.height);
      
      // 🚀 缓存：源视频→GIF 的转换结果（只基于源文件属性+目标尺寸+抖动算法）
      // 这个缓存是安全的，因为它只缓存源视频/GIF 文件本身的转换，
      // 不影响后续的帧合成步骤（帧合成每次都会重新读取所有图层）
      const fileStats = fs.statSync(item.path);
      // v2: 加入 stats_mode=diff 标记，使 stats_mode=full 的旧缓存自动失效
      const cacheKey = crypto.createHash('md5')
        .update(`v2_${item.path}_${fileStats.size}_${fileStats.mtime.getTime()}_${targetW}x${targetH}_dither_${ditherMode}_diff`)
        .digest('hex');
      
      const localFolder = userConfig.getLocalDownloadFolder();
      const processCacheDir = path.join(localFolder, '.gif_process_cache');
      if (!fs.existsSync(processCacheDir)) {
        fs.mkdirSync(processCacheDir, { recursive: true });
      }
      
      const cachedGifPath = path.join(processCacheDir, `${cacheKey}.gif`);
      
      if (fs.existsSync(cachedGifPath)) {
        fs.copyFileSync(cachedGifPath, processedGifPath);
        item.path = processedGifPath;
        console.log(`   ⚡ 命中缓存，跳过转换 (${targetW}x${targetH})`);
        return;
      }
      
      const isVideo = ext === '.mp4' || ext === '.mov';
      console.log(`   🔄 ${isVideo ? '转换视频' : '重新处理 GIF'} (${targetW}x${targetH}, dither=${ditherMode})...`);
      
      // 根据文件类型选择不同的处理方式
      let sourceFps = 15; // 默认帧率
      
      if (isVideo) {
        // 视频文件：检测帧率
        try {
          const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${item.path}"`;
          const probeResult = await execAsync(probeCmd, { timeout: 10000 });
          const fpsStr = probeResult.stdout.trim();
          if (fpsStr) {
            const [num, den] = fpsStr.split('/').map(Number);
            sourceFps = den ? num / den : num;
          }
        } catch (probeError) {
          // 静默处理
        }
      }
      
      const idealDelay = 100 / sourceFps;
      const gifDelay = Math.max(1, Math.round(idealDelay));
      const gifFps = 100 / gifDelay;
      
      // 构建 FFmpeg 命令
      // 对于 GIF：保持原帧率，只重新生成调色板和应用抖动
      // 对于视频：转换帧率并缩放
      // stats_mode=diff: 帧间差异调色板（体积更小，但保持变化区域色彩精度）
      // diff_mode=rectangle: 帧差分 + 脏矩形裁剪（核心压缩手段）
      let vfFilters;
      if (isVideo) {
        vfFilters = `fps=${gifFps},scale=${targetW}:${targetH}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=${ditherMode}:diff_mode=rectangle`;
      } else {
        // GIF 文件：缩放到目标尺寸 + 重新处理调色板和抖动
        // ⚠️ 必须也做 scale，否则尺寸上限缩放后 GIF 源文件仍是原始分辨率，
        //    导致后续合成处理远超需要的像素量（耗时增加、文件变大）
        vfFilters = `scale=${targetW}:${targetH}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=${ditherMode}:diff_mode=rectangle`;
      }
      
      const ffmpegCmdHwAccel = `ffmpeg -hwaccel videotoolbox -threads 0 -i "${item.path}" -vf "${vfFilters}" -threads 0 "${processedGifPath}" -y`;
      const ffmpegCmdSoftware = `ffmpeg -threads 0 -i "${item.path}" -vf "${vfFilters}" -threads 0 "${processedGifPath}" -y`;
      
      let ffmpegCmd = ffmpegCmdHwAccel;
      const conversionStartTime = Date.now();
      
      try {
        await execAsync(ffmpegCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 600000 });
      } catch (hwAccelError) {
        ffmpegCmd = ffmpegCmdSoftware;
        await execAsync(ffmpegCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 600000 });
      }
      
      const conversionTime = ((Date.now() - conversionStartTime) / 1000).toFixed(1);
      console.log(`   ✅ ${isVideo ? '视频转GIF' : 'GIF重新处理'}完成 (${conversionTime}s, dither=${ditherMode})`);
      
      try {
        // 快速验证：文件存在且非空即可（FFmpeg 出错时会抛异常，不需要再 identify）
        if (!fs.existsSync(processedGifPath) || fs.statSync(processedGifPath).size < 100) {
          throw new Error(`GIF 文件未生成或为空`);
        }
        
        // 🚀 保存到缓存
        try {
          fs.copyFileSync(processedGifPath, cachedGifPath);
        } catch (cacheErr) {
          // 缓存保存失败不影响导出
        }
        
        // 更新路径为处理后的 GIF
        item.path = processedGifPath;
        
        // 清理临时调色板文件
        try {
          if (fs.existsSync(palettePath)) {
            fs.unlinkSync(palettePath);
          }
        } catch (cleanupError) {
          console.warn(`   ⚠️  清理调色板文件失败（可忽略）: ${cleanupError.message}`);
        }
      } catch (ffmpegError) {
        console.error(`   ❌ FFmpeg GIF 生成失败: ${ffmpegError.message}`);
        if (ffmpegError.stderr) {
          console.error(`   STDERR: ${ffmpegError.stderr}`);
        }
        
        // 清理可能生成的不完整文件
        if (fs.existsSync(processedGifPath)) {
          try {
            fs.unlinkSync(processedGifPath);
          } catch (e) {
          }
        }
        if (fs.existsSync(palettePath)) {
          try {
            fs.unlinkSync(palettePath);
          } catch (e) {
            console.warn(`   ⚠️  清理调色板失败:`, e.message);
          }
        }
        
        throw new Error(`视频转 GIF 失败: ${ffmpegError.message}${ffmpegError.stderr ? '\nSTDERR: ' + ffmpegError.stderr : ''}\n\n请确保已安装 FFmpeg: brew install ffmpeg`);
      }
    }
  }));
  
  // 3. 保存 Bottom Layer
  let bottomLayerPath = null;
  if (bottomLayerBytes && bottomLayerBytes.length > 0) {
    bottomLayerPath = path.join(tempDir, 'bottom_layer.png');
    const bottomLayerBuffer = Buffer.from(bottomLayerBytes);
    fs.writeFileSync(bottomLayerPath, bottomLayerBuffer);
  }
  
  // 4. 保存静态图层
  const staticLayerPaths = [];
  if (staticLayers && staticLayers.length > 0) {
    for (let i = 0; i < staticLayers.length; i++) {
      const layer = staticLayers[i];
      const layerPath = path.join(tempDir, `static_layer_${i}_index${layer.index}.png`);
      const layerBuffer = Buffer.from(layer.bytes);
      fs.writeFileSync(layerPath, layerBuffer);
      
      staticLayerPaths.push({
        path: layerPath,
        index: layer.index,  // z-index in frame.children
        name: layer.name,
        layerId: layer.layerId // ✅ 传递 layerId 用于时间线功能
      });
      
    }
  }
  
  // 4.5 保存标注图层（GIF 之上的图层，支持时间线控制）
  const annotationLayerPaths = [];
  if (annotationLayers && annotationLayers.length > 0) {
    for (let i = 0; i < annotationLayers.length; i++) {
      const layer = annotationLayers[i];
      const layerPath = path.join(tempDir, `annotation_layer_${i}_index${layer.index}.png`);
      const layerBuffer = Buffer.from(layer.bytes);
      fs.writeFileSync(layerPath, layerBuffer);
      
      annotationLayerPaths.push({
        path: layerPath,
        index: layer.index,
        name: layer.name,
        layerId: layer.layerId
      });
    }
  }
  
  // 5. 保存 Top Layer
  let annotationPath = null;
  if (annotationBytes && annotationBytes.length > 0 && annotationLayerPaths.length === 0) {
    annotationPath = path.join(tempDir, 'annotation.png');
    const annotationBuffer = Buffer.from(annotationBytes);
    fs.writeFileSync(annotationPath, annotationBuffer);
  }
  
  try {
    // 📐 尺寸上限已在 Figma 端（code.js）通过 exportScale 预缩放完成
    // frameBounds、gifInfo.bounds、clipBounds、cornerRadius 以及所有 PNG 图层
    // 都已经是缩放后的尺寸，服务端无需再做任何 resize
    const frameW = Math.round(frameBounds.width);
    const frameH = Math.round(frameBounds.height);
    
    // 🕐 如果有时间线数据，强制使用多 GIF 模式（支持按帧控制可见性）
    const hasTimelineEdits = timelineData && Object.keys(timelineData).length > 0 && 
                             Object.values(timelineData).some(range => range.start > 0 || range.end < 100);
    
    if (gifPaths.length === 1 && !hasTimelineEdits) {
      // 单个 GIF 且没有时间线编辑：使用原有的简单逻辑
      reportProgress(10, '正在准备合成...');
      const gifInfo = gifPaths[0];
      
      // ✅ 视频/GIF 预处理 (单文件模式)
      // ⚠️ 跳过已在前面 Promise.all 中处理过的文件
      const alreadyProcessedSingle = gifInfo.path.startsWith(tempDir);
      const ext = path.extname(gifInfo.path).toLowerCase();
      if (!alreadyProcessedSingle && (ext === '.mov' || ext === '.mp4' || ext === '.gif')) {
          const tempProcessedGif = path.join(tempDir, `processed_single.gif`);
          const isGif = ext === '.gif';
          
          // 🎨 根据用户设置使用相应的抖动算法
          let ffmpegCmd;
          if (isGif) {
            ffmpegCmd = `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=${ditherMode}" -threads 0 "${tempProcessedGif}" -y`;
          } else {
            ffmpegCmd = `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "fps=15,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=${ditherMode}" -threads 0 "${tempProcessedGif}" -y`;
          }
          
          try {
              await execAsync(ffmpegCmd, { timeout: 180000 });
              gifInfo.path = tempProcessedGif;
          } catch (e) {
              throw new Error(`无法处理文件: ${path.basename(gifInfo.path)}`);
          }
      }
      
      // 验证 gifInfo 结构
      
      if (!gifInfo || !gifInfo.bounds) {
        console.error(`   ❌ gifInfo 结构无效:`, gifInfo);
        throw new Error('GIF 信息结构无效，缺少 bounds 数据');
      }
      
      let offsetX = Math.round(gifInfo.bounds.x);
      let offsetY = Math.round(gifInfo.bounds.y);
      let gifW = Math.round(gifInfo.bounds.width);
      let gifH = Math.round(gifInfo.bounds.height);
      const cornerRadius = gifInfo.cornerRadius || 0;
      const clipBounds = gifInfo.clipBounds;
      const clipCornerRadius = gifInfo.clipCornerRadius || 0;
      const imageFillInfo = gifInfo.imageFillInfo || { scaleMode: 'FILL' };
      
      // 修复: 分步处理，使用 imageTransform 还原用户的自定义裁剪位置
      const tempResizedGif = path.join(tempDir, 'resized.gif');
      
      // 检查输入文件是否存在且不为空
      if (!fs.existsSync(gifInfo.path) || fs.statSync(gifInfo.path).size === 0) {
        throw new Error(`输入 GIF 文件不存在或为空: ${gifInfo.path}`);
      }

      // 获取原始 GIF 的尺寸
      let originalW, originalH;
      try {
        const identifyCmd = `identify -format "%w %h" "${gifInfo.path}[0]"`;
        const result = await execAsync(identifyCmd, { timeout: 10000 });
        const [w, h] = result.stdout.trim().split(' ').map(Number);
        originalW = w;
        originalH = h;
      } catch (e) {
        // 检查是否是损坏的 GIF 文件
        if (e.message && e.message.includes('improper image header')) {
          try {
            if (fs.existsSync(gifInfo.path)) fs.unlinkSync(gifInfo.path);
            const metaPath = gifInfo.path.replace(/\.(gif|mov|mp4)$/, '.meta.json');
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
          } catch (deleteError) {}
          throw new Error(`GIF 文件已损坏，请重新同步: ${path.basename(gifInfo.path)}`);
        }
        throw e;
      }

      // 根据 scaleMode 和 imageTransform 计算缩放和裁剪参数
      let resizeCmd;
      if (imageFillInfo.scaleMode === 'FIT') {
        // FIT: 保持比例缩放以适应容器 (可能留白)
        resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${gifW}x${gifH}" -gravity center -background none -extent ${gifW}x${gifH} "${tempResizedGif}"`;
      } else if (imageFillInfo.scaleMode === 'CROP') {
        // CROP 模式：使用 imageTransform 的缩放系数
        let imageTransform = imageFillInfo.imageTransform;
        if (typeof imageTransform === 'string') {
          try {
            imageTransform = JSON.parse(imageTransform);
          } catch (e) {
            imageTransform = null;
          }
        }
        
        if (imageTransform && Array.isArray(imageTransform)) {
          const transform = imageTransform;
          const a = transform[0][0] || 1;
          const d = transform[1][1] || 1;
          const tx = transform[0][2] || 0;
          const ty = transform[1][2] || 0;
          
          // Figma 的 imageTransform: 从容器空间到图像空间的变换
          // a, d 表示容器在图像中的相对大小
          // 实际图像显示尺寸 = 容器尺寸 / a（或 d）
          const scaledW = Math.round(gifW / a);
          const scaledH = Math.round(gifH / d);
          
          // 计算裁剪偏移（基于缩放后的尺寸）
          const cropOffsetX = Math.round(tx * scaledW);
          const cropOffsetY = Math.round(ty * scaledH);
          
          // 缩放 -> 裁剪 -> 放置在透明画布上
          resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${scaledW}x${scaledH}!" -crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY} +repage "${tempResizedGif}"`;
          console.log(`      缩放并裁剪: resize ${scaledW}x${scaledH} -> crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY}`);
        } else {
          // 没有 imageTransform，保持原始尺寸，居中放置
          resizeCmd = `magick "${gifInfo.path}" -coalesce -gravity center -background none -extent ${gifW}x${gifH} "${tempResizedGif}"`;
        }
      } else {
        // FILL 模式 (默认): 使用 Cover 缩放，确保填满容器
        const scaleX = gifW / originalW;
        const scaleY = gifH / originalH;
        const scale = Math.max(scaleX, scaleY); // Cover: 取较大的缩放比例
        
        let scaledW = Math.round(originalW * scale);
        let scaledH = Math.round(originalH * scale);
        
        let cropOffsetX = 0;
        let cropOffsetY = 0;
        
        // 解析 imageTransform
        let imageTransform = imageFillInfo.imageTransform;
        if (typeof imageTransform === 'string') {
          try {
            imageTransform = JSON.parse(imageTransform);
          } catch (e) {
            console.error('   ❌ 解析 imageTransform 失败:', e);
            imageTransform = null;
          }
        }
        
        if (imageTransform && Array.isArray(imageTransform)) {
          const transform = imageTransform;
          const a = transform[0][0] || 1;
          const d = transform[1][1] || 1;
          const tx = transform[0][2] || 0;
          const ty = transform[1][2] || 0;
          
          // 在 FILL 模式下，用户可能额外放大/缩小了图片
          const userScaleX = 1 / a;
          const userScaleY = 1 / d;
          
          // 重新计算缩放后的尺寸（应用用户的缩放）
          const finalScaledW = Math.round(originalW * scale * userScaleX);
          const finalScaledH = Math.round(originalH * scale * userScaleY);
          
          // 计算裁剪偏移
          cropOffsetX = Math.round(tx * finalScaledW);
          cropOffsetY = Math.round(ty * finalScaledH);
          
          // 更新 scaledW 和 scaledH
          scaledW = finalScaledW;
          scaledH = finalScaledH;
        } else {
          // 没有 imageTransform，使用居中裁剪
          cropOffsetX = Math.round((scaledW - gifW) / 2);
          cropOffsetY = Math.round((scaledH - gifH) / 2);
        }
        
        // 确保裁剪偏移在有效范围内
        cropOffsetX = Math.max(0, Math.min(cropOffsetX, scaledW - gifW));
        cropOffsetY = Math.max(0, Math.min(cropOffsetY, scaledH - gifH));
        
        // 先缩放，然后裁剪
        resizeCmd = `magick "${gifInfo.path}" -coalesce -resize "${scaledW}x${scaledH}!" -crop ${gifW}x${gifH}+${cropOffsetX}+${cropOffsetY} +repage "${tempResizedGif}"`;
      }

      // 🔍 在处理前验证源 GIF 文件
      if (!fs.existsSync(gifInfo.path)) {
        throw new Error(`源 GIF 文件不存在: ${gifInfo.path}`);
      }
      
      const sourceStats = fs.statSync(gifInfo.path);
      
      // 🚀 优化：如果源 GIF 尺寸和目标尺寸完全相同，且不需要裁剪，直接复制文件跳过 ImageMagick 处理
      // 这对于大型 GIF（数百帧）可以节省数分钟的处理时间
      const needsProcessing = !(originalW === gifW && originalH === gifH && 
                                 imageFillInfo.scaleMode === 'FILL' && 
                                 (!imageFillInfo.imageTransform || 
                                  (typeof imageFillInfo.imageTransform === 'string' && 
                                   imageFillInfo.imageTransform === '[[1,0,0],[0,1,0]]')));
      
      if (!needsProcessing) {
        fs.copyFileSync(gifInfo.path, tempResizedGif);
      } else {
        // 对于大尺寸或大文件，增加 buffer 和超时
        // 使用容器尺寸 (gifW, gifH) 而不是 scaledW/scaledH，因为后者在某些模式下未定义
        const pixelCount = gifW * gifH;
        const isLarge = pixelCount > 2000000 || sourceStats.size > 10 * 1024 * 1024; // 2MP 或 10MB
        const bufferSize = isLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
        const timeout = isLarge ? 600000 : 300000; // 10分钟 vs 5分钟
        
        if (isLarge) {
          resizeCmd = resizeCmd.replace('magick "', 'magick -limit memory 4GB -limit disk 8GB -limit area 2GB -limit map 4GB -limit thread 4 "');
        }
        
        try {
          await execAsync(resizeCmd, { maxBuffer: bufferSize, timeout: timeout });
        } catch (e) {
          console.error(`   ❌ 步骤1失败: 调整尺寸错误`);
          console.error(`   命令: ${resizeCmd}`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          
          // 关键修复: 如果是文件头错误，说明缓存文件损坏，删除它以便下次重新下载
          if (e.stderr && (e.stderr.includes('improper image header') || e.stderr.includes('no decode delegate'))) {
            console.warn(`   ⚠️  检测到损坏的 GIF 缓存，正在删除: ${gifInfo.path}`);
            try {
              fs.unlinkSync(gifInfo.path);
              e.message += `\n❌ 缓存文件已损坏并被删除。请重试以重新下载文件。`;
            } catch (delErr) {
              console.error('   删除损坏文件失败:', delErr);
            }
          }
          
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      }
      
      // 如果有圆角，应用圆角遮罩
      let roundedGif = tempResizedGif;
      if (cornerRadius > 0) {
        const tempRoundedGif = path.join(tempDir, 'rounded.gif');
        const maskPath = path.join(tempDir, 'mask.png');

        // 检测源 GIF 大小以确定超时时间
        const roundSourceStats = fs.statSync(tempResizedGif);
        const roundPixelCount = gifW * gifH;
        const roundIsLarge = roundPixelCount > 2000000 || roundSourceStats.size > 10 * 1024 * 1024;
        const roundBufferSize = roundIsLarge ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
        const roundTimeout = roundIsLarge ? 600000 : 300000; // 大文件 10 分钟 vs 5分钟
        
        if (roundIsLarge) {
        }

        // 创建圆角遮罩
        const createMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${cornerRadius},${cornerRadius}" "${maskPath}"`;
        try {
          await execAsync(createMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
        } catch (e) {
          console.error(`   ❌ 步骤1.5失败: 创建圆角遮罩错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }

        // 应用圆角遮罩到GIF的每一帧（使用 alpha extract 确保透明区域正确处理）
        const applyMaskCmd = `magick "${tempResizedGif}" -coalesce null: \\( "${maskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempRoundedGif}"`;
        try {
          await execAsync(applyMaskCmd, { maxBuffer: roundBufferSize, timeout: roundTimeout });
          roundedGif = tempRoundedGif;
        } catch (e) {
          console.error(`   ❌ 步骤1.5失败: 应用圆角遮罩错误`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
      }
      
      // 如果有裁切，应用裁切
      let processedGif = roundedGif;
      if (clipBounds) {
        
        // 计算GIF区域和裁切容器的交集（可见区域）
        const intersectLeft = Math.max(offsetX, clipBounds.x);
        const intersectTop = Math.max(offsetY, clipBounds.y);
        const intersectRight = Math.min(offsetX + gifW, clipBounds.x + clipBounds.width);
        const intersectBottom = Math.min(offsetY + gifH, clipBounds.y + clipBounds.height);
        
        const intersectW = Math.max(0, intersectRight - intersectLeft);
        const intersectH = Math.max(0, intersectBottom - intersectTop);
        
        console.log(`      可见区域（交集）: (${intersectLeft}, ${intersectTop}), ${intersectW}x${intersectH}`);
        
        if (intersectW === 0 || intersectH === 0) {
          console.warn(`      ⚠️  GIF完全被裁切，不可见`);
          // GIF完全被裁切掉了，创建一个1x1的透明GIF
          processedGif = roundedGif; // 保持原样，后续会被extent处理
        } else {
          // 计算交集相对于GIF的位置（裁切起点）
          const cropX = Math.round(intersectLeft - offsetX);
          const cropY = Math.round(intersectTop - offsetY);
          const cropW = Math.round(intersectW);
          const cropH = Math.round(intersectH);
          
          
          const tempClippedGif = path.join(tempDir, 'clipped.gif');
          // 使用 -crop 裁切GIF，然后 +repage 重置画布
          const clipCmd = `magick "${roundedGif}" -coalesce -crop ${cropW}x${cropH}+${cropX}+${cropY} +repage "${tempClippedGif}"`;
          try {
            await execAsync(clipCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
            processedGif = tempClippedGif;
            // 裁切后，GIF的尺寸和位置更新为交集的尺寸和位置
            gifW = cropW;
            gifH = cropH;
            offsetX = Math.round(intersectLeft);
            offsetY = Math.round(intersectTop);
            
            // 如果裁切容器有圆角，应用该圆角 (父级圆角)
            if (clipCornerRadius > 0) {
              const tempClipRoundedGif = path.join(tempDir, 'clip_rounded.gif');
              const clipMaskPath = path.join(tempDir, 'clip_mask.png');
              
              // 创建父级圆角遮罩 (基于新的尺寸 gifW x gifH)
              const createClipMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${clipCornerRadius},${clipCornerRadius}" "${clipMaskPath}"`;
              await execAsync(createClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
              
              const applyClipMaskCmd = `magick "${processedGif}" -coalesce null: \\( "${clipMaskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempClipRoundedGif}"`;
              await execAsync(applyClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
              processedGif = tempClipRoundedGif;
            }
          } catch (e) {
            console.error(`   ❌ 步骤1.6失败: 应用裁切错误`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        }
      }
      
      
      const tempPositionedGif = path.join(tempDir, 'positioned.gif');
      
      const extentCmd = `magick -size ${frameW}x${frameH} xc:none null: \\( "${processedGif}" -coalesce \\) -geometry +${offsetX}+${offsetY} -layers Composite "${tempPositionedGif}"`;

      try {
        await execAsync(extentCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      } catch (e) {
        console.error(`   ❌ 步骤2失败: 定位/合成错误`);
        console.error(`   命令: ${extentCmd}`);
        if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
        if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
        throw e;
      }
      
      reportProgress(30, '正在合成图层 (ImageMagick)...');
      
      // 🚀 合成所有图层：收集所有需要叠加的静态 PNG 层，一次性合成到 GIF
      // 避免逐层 magick 调用（每次都要解码+重编码整个 GIF）
      let baseLayer = tempPositionedGif;
      
      // 收集所有需要在 GIF 下面的静态层（背景色 + bottomLayer）
      const underLayers = [];
      if (frameBackground && frameBackground.a > 0) {
        const tempBgPath = path.join(tempDir, 'background.png');
        const bgColor = `rgba(${frameBackground.r},${frameBackground.g},${frameBackground.b},${frameBackground.a})`;
        await execAsync(`magick -size ${frameW}x${frameH} xc:"${bgColor}" "${tempBgPath}"`, { maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
        underLayers.push(tempBgPath);
      }
      if (bottomLayerPath) {
        underLayers.push(bottomLayerPath);
      }
      
      // 如果有下层，合并为一张底图后一次叠加到 GIF
      if (underLayers.length > 0) {
        const tempWithGifPath = path.join(tempDir, 'with_gif.gif');
        // 先合并所有底层为单张 PNG（避免对 GIF 做多次解码-重编码）
        let basePng;
        if (underLayers.length === 1) {
          basePng = underLayers[0];
        } else {
          basePng = path.join(tempDir, 'base_merged.png');
          let mergeCmd = `magick "${underLayers[0]}"`;
          for (let i = 1; i < underLayers.length; i++) mergeCmd += ` "${underLayers[i]}" -composite`;
          mergeCmd += ` "${basePng}"`;
          await execAsync(mergeCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
        }
        // 一次性合成底图 + GIF
        const gifCmd = `magick "${basePng}" -coalesce null: \\( "${tempPositionedGif}" -coalesce \\) -compose over -layers composite "${tempWithGifPath}"`;
        await execAsync(gifCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
        baseLayer = tempWithGifPath;
      }
      
      // 收集所有需要在 GIF 上面的静态层
      const overLayers = [];
      if (staticLayerPaths) {
        for (const sl of staticLayerPaths) {
          if (fs.existsSync(sl.path)) overLayers.push(sl.path);
        }
      }
      if (annotationLayerPaths) {
        for (const al of annotationLayerPaths) {
          if (fs.existsSync(al.path)) overLayers.push(al.path);
        }
      }
      if (annotationPath && fs.existsSync(annotationPath) && annotationLayerPaths.length === 0) {
        overLayers.push(annotationPath);
      }
      
      // 如果有上层，先合并为单张 PNG，再一次叠加到 GIF
      if (overLayers.length > 0) {
        let topPng;
        if (overLayers.length === 1) {
          topPng = overLayers[0];
        } else {
          // 合并所有上层为一张透明 PNG
          topPng = path.join(tempDir, 'top_merged.png');
          let mergeCmd = `magick -size ${frameW}x${frameH} xc:none`;
          for (const ol of overLayers) mergeCmd += ` "${ol}" -composite`;
          mergeCmd += ` "${topPng}"`;
          await execAsync(mergeCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
        }
        const compositeCmd = `magick "${baseLayer}" -coalesce null: \\( "${topPng}" \\) -layers composite -loop 0 "${outputPath}"`;
        await execAsync(compositeCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      } else {
        // 没有上层，直接设置循环并输出
        const outputCmd = `magick "${baseLayer}" -loop 0 "${outputPath}"`;
        await execAsync(outputCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 300000 });
      }
      
      // 🗜️ GIF 压缩优化（仅 gifsicle）
      // 预处理阶段已完成 FFmpeg 帧差分编码（stats_mode=diff + diff_mode=rectangle）
      // 这里只需 gifsicle 做像素级透明 + LZW 优化，不再重复 FFmpeg 重编码
      reportProgress(90, '正在压缩优化...');
      
      try {
        await execAsync('which gifsicle');
        const preStats = fs.statSync(outputPath);
        const preSizeMB = (preStats.size / 1024 / 1024).toFixed(2);
        const gifsicleTimeout = Math.max(60000, Math.ceil(preStats.size / (1024 * 1024)) * 2000);
        
        const tempGifsicle = outputPath + '.gsopt.gif';
        await execAsync(`gifsicle -O3 --lossy=80 --no-conserve-memory "${outputPath}" -o "${tempGifsicle}"`, 
          { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
        
        const postStats = fs.statSync(tempGifsicle);
        if (postStats.size < preStats.size) {
          fs.unlinkSync(outputPath);
          fs.renameSync(tempGifsicle, outputPath);
          console.log(`   🗜️  gifsicle: ${preSizeMB} MB → ${(postStats.size / 1024 / 1024).toFixed(2)} MB (节省 ${((1 - postStats.size / preStats.size) * 100).toFixed(1)}%)`);
        } else {
          fs.unlinkSync(tempGifsicle);
        }
      } catch (e) {
        // gifsicle 不可用，跳过
      }
      
      // 单 GIF 路径的 100% 已在 composeAnnotatedGif 返回前通过 reportProgress(100) 发送
    } else {
      // 多个 GIF 或有时间线编辑：逐帧提取和合成
      if (hasTimelineEdits && gifPaths.length === 1) {
        console.log(`\n🎨 时间线编辑模式 - 逐帧提取合成（单 GIF + 时间线）...`);
      } else {
        console.log(`\n🎨 多个 GIF 模式 - 逐帧提取合成...`);
      }
      reportProgress(5, '正在分析 GIF 帧结构...');
      console.log(`   ⚠️  这会需要一些时间...`);
      
      // ⏱️ 步骤计时器
      const stepTimers = {};
      const startStep = (name) => { stepTimers[name] = Date.now(); };
      const endStep = (name) => {
        const duration = ((Date.now() - stepTimers[name]) / 1000).toFixed(2);
        console.log(`   ⏱️  ${name} 耗时: ${duration} 秒`);
        return duration;
      };
      
      // 新策略：逐帧提取、合成、重组
      // 这是处理多个动画 GIF 最可靠的方法
      
      // 第一步：获取所有 GIF 的帧数和延迟时间
      startStep('Step 1 分析GIF');
      console.log(`\n   第 1 步：分析 GIF 信息...`);
      const gifInfoArray = [];
      
      for (let i = 0; i < gifPaths.length; i++) {
        checkCancelled(); // 检查是否被取消
        const gifInfo = gifPaths[i];
        
        // ✅ 视频转 GIF 预处理 (多文件模式)
        // ⚠️ 跳过已在前面 Promise.all 中处理过的文件（路径在 tempDir 内说明已经处理过了）
        const alreadyProcessed = gifInfo.path.startsWith(tempDir);
        const ext = path.extname(gifInfo.path).toLowerCase();
        if (!alreadyProcessed && (ext === '.mov' || ext === '.mp4' || ext === '.gif')) {
            const tempProcessedGif = path.join(tempDir, `processed_multi_${i}.gif`);
            const isGif = ext === '.gif';
            
            // 🎨 根据用户设置使用相应的抖动算法
            let ffmpegCmd;
            if (isGif) {
              ffmpegCmd = `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=${ditherMode}" -threads 0 "${tempProcessedGif}" -y`;
            } else {
              ffmpegCmd = `ffmpeg -threads 0 -i "${gifInfo.path}" -vf "fps=15,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full[p];[s1][p]paletteuse=dither=${ditherMode}" -threads 0 "${tempProcessedGif}" -y`;
            }
            
            try {
                await execAsync(ffmpegCmd, { timeout: 180000 });
                gifInfo.path = tempProcessedGif;
            } catch (e) {
                throw new Error(`无法处理文件: ${path.basename(gifInfo.path)}`);
            }
        }
        
        // 一次性获取所有帧的延迟（同时可得帧数）
        const delayCmd = `identify -format "%T\\n" "${gifInfo.path}"`;
        const delayResult = await execAsync(delayCmd, { timeout: 15000 });
        const delays = delayResult.stdout.trim().split('\n')
          .map(d => parseInt(d.trim()))
          .filter(d => !isNaN(d));
        const frameCount = delays.length || 1;
          
        // 计算实际总时长（所有帧延迟之和）
        const totalDurationTicks = delays.reduce((sum, d) => sum + d, 0);
        const totalDuration = totalDurationTicks / 100;
        
        // 计算平均延迟作为参考
        const avgDelay = delays.length > 0 ? Math.round(totalDurationTicks / delays.length) : 5;
        // 如果有些帧延迟为0，通常播放器会按默认值处理（如10ms），这里我们统一修正为最小 2 ticks (20ms) 以防过快
        const safeDelay = avgDelay < 2 ? 10 : avgDelay;
        
        gifInfoArray.push({
          frameCount,
          delay: safeDelay, // 平均/主要延迟
          delays: delays,   // 保存所有帧的延迟详情
          totalDuration
        });
        
        
      }
      
      // 找到最长的 GIF 时长（这将是输出GIF的总时长）
      const maxDuration = Math.max(...gifInfoArray.map(g => g.totalDuration));
      
      // 使用最小延迟作为输出延迟（确保能捕捉最快GIF的所有帧）
      // 这样可以保证所有GIF都按原速播放
      const allDelays = gifInfoArray.map(g => g.delay);
      const outputDelay = Math.min(...allDelays);
      
      // 计算需要生成的总帧数（基于最长时长和输出延迟）
      const totalSourceFrames = Math.ceil((maxDuration * 100) / outputDelay);
      
      // 🎬 时间线裁剪：只导出所有图层覆盖范围内的帧
      // 找到所有图层中最早的 start 和最晚的 end
      let trimStartPercent = 0;
      let trimEndPercent = 100;
      
      if (hasTimelineEdits && timelineData) {
        const allStarts = [];
        const allEnds = [];
        Object.values(timelineData).forEach(range => {
          if (range && typeof range.start === 'number' && typeof range.end === 'number') {
            allStarts.push(range.start);
            allEnds.push(range.end);
          }
        });
        if (allStarts.length > 0) {
          trimStartPercent = Math.min(...allStarts);
          trimEndPercent = Math.max(...allEnds);
        }
      }
      
      // 将百分比转换为帧索引
      const trimStartFrame = Math.floor((trimStartPercent / 100) * (totalSourceFrames - 1));
      const trimEndFrame = Math.ceil((trimEndPercent / 100) * (totalSourceFrames - 1));
      const totalOutputFrames = trimEndFrame - trimStartFrame + 1;
      
      // 裁剪后的实际时长
      const trimmedDuration = (totalOutputFrames * outputDelay) / 100;
      
      console.log(`   输出: ${totalOutputFrames} 帧, 延迟=${outputDelay}/100s, 时长=${trimmedDuration.toFixed(2)}s${trimStartPercent > 0 || trimEndPercent < 100 ? ` (裁剪 ${trimStartPercent.toFixed(0)}-${trimEndPercent.toFixed(0)}%)` : ''}`);
      
      // 第二步：为每个 GIF 提取帧到单独的文件夹
      endStep('Step 1 分析GIF');
      startStep('Step 2 提取帧');
      console.log(`\n   第 2 步：提取所有 GIF 的帧 (并行处理)...`);
      reportProgress(10, '正在提取 GIF 原始帧...');
      // const gifFramesDirs = [];
      
      const gifFramesDirs = await Promise.all(gifPaths.map(async (gifInfo, i) => {
        checkCancelled(); // 检查是否被取消
        const progress = 10 + Math.round((i / gifPaths.length) * 20); // 10% -> 30%
        reportProgress(progress, `正在提取第 ${i + 1}/${gifPaths.length} 个 GIF 的帧...`);
        let offsetX = Math.round(gifInfo.bounds.x);
        let offsetY = Math.round(gifInfo.bounds.y);
        let gifW = Math.round(gifInfo.bounds.width);
        let gifH = Math.round(gifInfo.bounds.height);
        const cornerRadius = gifInfo.cornerRadius || 0;
        const clipBounds = gifInfo.clipBounds;
        const clipCornerRadius = gifInfo.clipCornerRadius || 0;
        let imageFillInfo = gifInfo.imageFillInfo || { scaleMode: 'FILL' };
        const gifData = gifInfoArray[i];
        
        // 🔧 关键修复：解析 imageTransform 字符串为数组
        if (imageFillInfo.imageTransform && typeof imageFillInfo.imageTransform === 'string') {
          try {
            imageFillInfo.imageTransform = JSON.parse(imageFillInfo.imageTransform);
          } catch (e) {
            imageFillInfo.imageTransform = null;
          }
        }
        
        console.log(`\n      GIF ${i + 1}/${gifPaths.length}: ${path.basename(gifInfo.path)} (${gifData.frameCount} 帧)`);
        
        const framesDir = path.join(tempDir, `gif${i}_frames`);
        if (!fs.existsSync(framesDir)) {
          fs.mkdirSync(framesDir, { recursive: true });
        }
        
        // 先调整尺寸并应用用户裁剪（基于 imageTransform）
        let sourceGif = gifInfo.path;
        let needsResize = true;
        
        // 获取原始 GIF 尺寸
        let originalW, originalH;
        try {
          const identifyCmd = `identify -format "%w %h" "${gifInfo.path}[0]"`;
          const result = await execAsync(identifyCmd, { timeout: 10000 });
          const [w, h] = result.stdout.trim().split(' ').map(Number);
          originalW = w;
          originalH = h;
        } catch (e) {
          console.error(`   ❌ 无法读取 GIF 尺寸 (GIF ${i+1})`);
          throw e;
        }
        
        // 根据 scaleMode 和 imageTransform 调整尺寸
        const tempResizedGif = path.join(tempDir, `gif${i}_resized.gif`);
        // 检查是否是大尺寸 GIF，需要增加资源限制
        const pixelCount = gifW * gifH;
        const sourceStats = fs.statSync(gifInfo.path);
        const isLargeGif = pixelCount > 2000000 || sourceStats.size > 10 * 1024 * 1024;
        const magickPrefix = isLargeGif ? 'magick -limit memory 4GB -limit disk 8GB -limit area 2GB -limit map 4GB -limit thread 4' : 'magick';
        const execOptions = isLargeGif 
          ? { maxBuffer: 200 * 1024 * 1024, timeout: 600000 }  // 200MB buffer, 10分钟超时
          : { maxBuffer: 100 * 1024 * 1024, timeout: 120000 }; // 100MB buffer, 2分钟超时
        
        
        
        if (imageFillInfo.scaleMode === 'FIT') {
          // FIT 模式
          // 🚀 使用 FFmpeg 替代 ImageMagick 以避免内存溢出
          // pad filter: 宽:高:x:y:color
          const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "scale=${gifW}:${gifH}:force_original_aspect_ratio=decrease,pad=${gifW}:${gifH}:(ow-iw)/2:(oh-ih)/2:color=black@0" -y "${tempResizedGif}"`;
          await execAsync(resizeCmd, { timeout: execOptions.timeout });
          sourceGif = tempResizedGif;
          needsResize = false;
        } else if (imageFillInfo.scaleMode === 'CROP') {
          // CROP 模式
          if (imageFillInfo.imageTransform && Array.isArray(imageFillInfo.imageTransform)) {
            const transform = imageFillInfo.imageTransform;
            const a = transform[0][0] || 1;
            const d = transform[1][1] || 1;
            const tx = transform[0][2] || 0;
            const ty = transform[1][2] || 0;
            
            const scaledW = Math.round(gifW / a);
            const scaledH = Math.round(gifH / d);
            const cropOffsetX = Math.round(tx * scaledW);
            const cropOffsetY = Math.round(ty * scaledH);
            
            const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}" -y "${tempResizedGif}"`;
            await execAsync(resizeCmd, { timeout: execOptions.timeout });
          } else {
            // 没有 imageTransform，保持原始尺寸并居中
            // 逻辑: 保持原尺寸，居中裁剪或填充到目标尺寸
            const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "crop=min(iw,${gifW}):min(ih,${gifH}):(iw-ow)/2:(ih-oh)/2,pad=${gifW}:${gifH}:(ow-iw)/2:(oh-ih)/2:color=black@0" -y "${tempResizedGif}"`;
            await execAsync(resizeCmd, { timeout: execOptions.timeout });
          }
          sourceGif = tempResizedGif;
          needsResize = false;
        } else {
          // FILL 模式：Cover 缩放填满容器
          const scaleX = gifW / originalW;
          const scaleY = gifH / originalH;
          const scale = Math.max(scaleX, scaleY);
          
          let scaledW = Math.round(originalW * scale);
          let scaledH = Math.round(originalH * scale);
          
          let cropOffsetX = 0;
          let cropOffsetY = 0;
          
          if (imageFillInfo.imageTransform && Array.isArray(imageFillInfo.imageTransform)) {
            const transform = imageFillInfo.imageTransform;
            const a = transform[0][0] || 1;
            const d = transform[1][1] || 1;
            const tx = transform[0][2] || 0;
            const ty = transform[1][2] || 0;
            
            // 用户额外缩放
            const userScaleX = 1 / a;
            const userScaleY = 1 / d;
            
            const finalScaledW = Math.round(originalW * scale * userScaleX);
            const finalScaledH = Math.round(originalH * scale * userScaleY);
            
            cropOffsetX = Math.round(tx * finalScaledW);
            cropOffsetY = Math.round(ty * finalScaledH);
            scaledW = finalScaledW;
            scaledH = finalScaledH;
          } else {
            cropOffsetX = Math.round((scaledW - gifW) / 2);
            cropOffsetY = Math.round((scaledH - gifH) / 2);
          }
          
          cropOffsetX = Math.max(0, Math.min(cropOffsetX, scaledW - gifW));
          cropOffsetY = Math.max(0, Math.min(cropOffsetY, scaledH - gifH));
          
          const resizeCmd = `ffmpeg -i "${gifInfo.path}" -vf "scale=${scaledW}:${scaledH}:flags=lanczos,crop=${gifW}:${gifH}:${cropOffsetX}:${cropOffsetY}" -y "${tempResizedGif}"`;
          await execAsync(resizeCmd, { timeout: execOptions.timeout });
          sourceGif = tempResizedGif;
          needsResize = false;
        }
        
        // 如果有圆角，应用圆角遮罩
        if (cornerRadius > 0) {
          const tempRoundedGif = path.join(tempDir, `gif${i}_rounded.gif`);
          const maskPath = path.join(tempDir, `gif${i}_mask.png`);
          
          // 创建圆角遮罩
          const createMaskCmd = `${magickPrefix} -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${cornerRadius},${cornerRadius}" "${maskPath}"`;
          try {
            await execAsync(createMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
          } catch (e) {
            console.error(`   ❌ 创建圆角遮罩失败 (GIF ${i+1})`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
          
          // 应用圆角遮罩（使用 alpha extract 确保透明区域正确处理）
          const applyMaskCmd = `magick "${sourceGif}" -coalesce null: \\( "${maskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempRoundedGif}"`;
          try {
            await execAsync(applyMaskCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120000 });
            sourceGif = tempRoundedGif;
          } catch (e) {
            console.error(`   ❌ 应用圆角遮罩失败 (GIF ${i+1})`);
            if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
            if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
            throw e;
          }
        }
        
        // 如果有裁切，应用裁切
        if (clipBounds) {
          
          // 计算GIF区域和裁切容器的交集（可见区域）
          const intersectLeft = Math.max(offsetX, clipBounds.x);
          const intersectTop = Math.max(offsetY, clipBounds.y);
          const intersectRight = Math.min(offsetX + gifW, clipBounds.x + clipBounds.width);
          const intersectBottom = Math.min(offsetY + gifH, clipBounds.y + clipBounds.height);
          
          const intersectW = Math.max(0, intersectRight - intersectLeft);
          const intersectH = Math.max(0, intersectBottom - intersectTop);
          
          
          
          if (intersectW === 0 || intersectH === 0) {
            console.warn(`            ⚠️  GIF完全被裁切，不可见`);
            // GIF完全被裁切掉了，保持原样
          } else {
            // 计算交集相对于GIF的位置（裁切起点）
            const cropX = Math.round(intersectLeft - offsetX);
            const cropY = Math.round(intersectTop - offsetY);
            const cropW = Math.round(intersectW);
            const cropH = Math.round(intersectH);
            
            
            const tempClippedGif = path.join(tempDir, `gif${i}_clipped.gif`);
            const clipCmd = `magick "${sourceGif}" -coalesce -crop ${cropW}x${cropH}+${cropX}+${cropY} +repage "${tempClippedGif}"`;
            try {
              await execAsync(clipCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120000 });
              sourceGif = tempClippedGif;
              // 更新尺寸和位置为交集的尺寸和位置
              gifW = cropW;
              gifH = cropH;
              offsetX = Math.round(intersectLeft);
              offsetY = Math.round(intersectTop);
              
              // 如果裁切容器有圆角，应用该圆角 (父级圆角)
              if (clipCornerRadius > 0) {
                const tempClipRoundedGif = path.join(tempDir, `gif${i}_clip_rounded.gif`);
                const clipMaskPath = path.join(tempDir, `gif${i}_clip_mask.png`);
                
                // 创建父级圆角遮罩 (基于新的尺寸 gifW x gifH)
                const createClipMaskCmd = `magick -size ${gifW}x${gifH} xc:none -fill white -draw "roundrectangle 0,0 ${gifW-1},${gifH-1} ${clipCornerRadius},${clipCornerRadius}" "${clipMaskPath}"`;
                await execAsync(createClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
                
                const applyClipMaskCmd = `magick "${sourceGif}" -coalesce null: \\( "${clipMaskPath}" -alpha extract \\) -compose CopyOpacity -layers composite "${tempClipRoundedGif}"`;
                await execAsync(applyClipMaskCmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 });
                sourceGif = tempClipRoundedGif;
              }
            } catch (e) {
              console.error(`   ❌ 应用裁切失败 (GIF ${i+1})`);
              if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
              if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
              throw e;
            }
          }
        }
        
        // 🚀 使用 FFmpeg 提取帧并定位到画布
        // pad 语法: width:height:x:y:color
        // -start_number 0 确保从 frame_0000.png 开始
        const extractCmd = `ffmpeg -i "${sourceGif}" -vf "pad=${frameW}:${frameH}:${offsetX}:${offsetY}:color=black@0" -start_number 0 -y "${framesDir}/frame_%04d.png"`;
        
        try {
          await execAsync(extractCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 180000 });
        } catch (e) {
          
          // 自动修复：删除损坏的缓存文件
          if (e.stderr && (e.stderr.includes('improper image header') || e.stderr.includes('no decode delegate'))) {
             console.warn(`   ⚠️  检测到损坏的 GIF 缓存，正在删除: ${gifInfo.path}`);
             try {
               fs.unlinkSync(gifInfo.path);
               e.message += `\n❌ 缓存文件已损坏并被删除。请重试以重新下载文件。`;
             } catch (delErr) {
               console.error('   删除损坏文件失败:', delErr);
             }
          }
          
          // 将 stderr 附加到错误消息中
          if (e.stderr) e.message += `\nSTDERR: ${e.stderr}`;
          throw e;
        }
        
        return { 
          dir: framesDir, 
          sourceGifPath: sourceGif,    // 🚀 处理后的 GIF 路径（用于 FFmpeg 管道优化）
          finalOffsetX: offsetX,       // 🚀 最终画布偏移（裁切后可能变化）
          finalOffsetY: offsetY,
          frameCount: gifData.frameCount,
          delay: gifData.delay,
          totalDuration: gifData.totalDuration,
          zIndex: gifInfo.zIndex || 0, // ✅ 保存 GIF 的 z-index
          layerId: gifInfo.layerId, // ✅ Pass layerId
          type: 'gif' // ✅ 标记为 GIF 类型
        };
      }));
      
      // 第三步：构建完整的图层列表（按 z-index 排序）
      endStep('Step 2 提取帧');
      startStep('Step 3 构建图层');
      console.log(`\n   第 3 步：构建图层列表并按 z-index 排序...`);
      
      // 合并 GIF 和静态图层
      const allLayers = [];
      
      // 添加所有 GIF 图层
      gifFramesDirs.forEach((gifInfo, idx) => {
          allLayers.push({
            type: 'gif',
            zIndex: gifInfo.zIndex,
            gifIndex: idx,
            gifInfo: gifInfo,
            layerId: gifInfo.layerId // ✅ Pass layerId
          });
        console.log(`      添加 GIF 图层: zIndex=${gifInfo.zIndex}, gifIndex=${idx}, layerId="${gifInfo.layerId}"`);
        // 🕐 检查时间线匹配
        if (timelineData) {
          const hasMatch = timelineData[gifInfo.layerId];
          console.log(`         🕐 时间线匹配: ${hasMatch ? `✅ 找到 (${hasMatch.start}%-${hasMatch.end}%)` : '❌ 未找到'}`);
        }
      });
      
      // 添加所有静态图层
      if (staticLayerPaths && staticLayerPaths.length > 0) {
        staticLayerPaths.forEach(staticLayer => {
          allLayers.push({
            type: 'static',
            zIndex: staticLayer.index,
            path: staticLayer.path,
            name: staticLayer.name,
            layerId: staticLayer.layerId // ✅ Pass layerId
          });
          console.log(`      添加静态图层: zIndex=${staticLayer.index}, name=${staticLayer.name}, layerId=${staticLayer.layerId}`);
        });
      }
      
      // 添加所有标注图层（GIF 之上的图层，支持时间线）
      if (annotationLayerPaths && annotationLayerPaths.length > 0) {
        annotationLayerPaths.forEach(annotationLayer => {
          allLayers.push({
            type: 'annotation',
            zIndex: annotationLayer.index,
            path: annotationLayer.path,
            name: annotationLayer.name,
            layerId: annotationLayer.layerId // ✅ Pass layerId
          });
          console.log(`      添加标注图层: zIndex=${annotationLayer.index}, name=${annotationLayer.name}, layerId="${annotationLayer.layerId}"`);
          // 🕐 检查时间线匹配
          if (timelineData) {
            const hasMatch = timelineData[annotationLayer.layerId];
            console.log(`         🕐 时间线匹配: ${hasMatch ? `✅ 找到 (${hasMatch.start}%-${hasMatch.end}%)` : '❌ 未找到'}`);
          }
        });
      }
      
      // 按 z-index 排序（从小到大，即从底层到顶层）
      allLayers.sort((a, b) => a.zIndex - b.zIndex);
      
      console.log(`   ✅ 图层: ${allLayers.length} 层`);
      allLayers.forEach((layer, idx) => {
        if (false) { // 调试时可改为 true
        }
      });
      
      endStep('Step 3 构建图层');
      
      // 🎨 创建背景层 (两条路径都需要，提前创建)
      let backgroundPath = null;
      if (frameBackground && frameBackground.a > 0) {
        backgroundPath = path.join(tempDir, 'background.png');
        const bgColor = `rgba(${frameBackground.r},${frameBackground.g},${frameBackground.b},${frameBackground.a})`;
        const createBgCmd = `magick -size ${frameW}x${frameH} xc:"${bgColor}" "${backgroundPath}"`;
        try {
          await execAsync(createBgCmd, { maxBuffer: 50 * 1024 * 1024 });
        } catch (e) {
          console.error(`   ❌ 创建背景层失败`);
          if (e.stderr) console.error(`   STDERR: ${e.stderr}`);
        }
      }
      
      // 🚀🚀🚀 FFmpeg 管道优化：将 Step 4（逐帧合成）+ Step 6（GIF 编码）合并为单条 FFmpeg 命令
      // 对比逐帧 ImageMagick 方案：
      //   旧: N 次 magick 进程启动 + N 次 PNG 读/写 + 单独 FFmpeg 编码 = O(5N × pixels)
      //   新: 1 次 FFmpeg 进程, 静态层只读 1 次, 无中间 PNG = O(2N × pixels)
      // 对 2 倍尺寸导出，将耗时从约 4x 降低到约 2x
      
      let ffmpegPipelineSucceeded = false;
      
      try {
        startStep('Step 4 FFmpeg管道合成');
        reportProgress(20, '正在构建 FFmpeg 合成管道...');
        
        const outputFps = 100 / outputDelay;
        
        // ── 1. 分离图层组 ──────────────────────────────────────────────
        // 将所有图层分为三组: base (GIF 下方), mid (GIF 层 + 穿插的静态层), top (GIF 上方)
        const gifLayers = allLayers.filter(l => l.type === 'gif');
        const lowestGifZ = Math.min(...gifLayers.map(l => l.zIndex));
        const highestGifZ = Math.max(...gifLayers.map(l => l.zIndex));
        
        // 检查 top 层是否有时间线编辑（如果有则不能预合并，需要单独作为 FFmpeg 输入）
        const hasTimelineOnLayer = (layerId) => {
          if (!hasTimelineEdits || !timelineData || !timelineData[layerId]) return false;
          const range = timelineData[layerId];
          return range.start > 0 || range.end < 100;
        };
        
        // base: bg + bottom + static below GIF (无时间线的)
        const basePaths = [];
        if (backgroundPath) basePaths.push(backgroundPath);
        if (bottomLayerPath) basePaths.push(bottomLayerPath);
        
        // top: static/annotation above GIF + legacy annotation (无时间线的)
        const topPaths = [];
        
        // 有时间线的 static/annotation 层需要单独处理
        const timelineStaticLayers = [];
        
        for (const layer of allLayers) {
          if (layer.type === 'gif') continue;
          
          const hasTimeline = hasTimelineOnLayer(layer.layerId);
          
          if (layer.zIndex < lowestGifZ) {
            if (hasTimeline) {
              timelineStaticLayers.push(layer);
            } else {
              basePaths.push(layer.path);
            }
          } else if (layer.zIndex > highestGifZ) {
            if (hasTimeline) {
              timelineStaticLayers.push(layer);
            } else {
              topPaths.push(layer.path);
            }
          } else {
            // 在 GIF 层之间的静态层，总是作为单独输入
            timelineStaticLayers.push(layer);
          }
        }
        
        // Legacy annotation (兼容模式)
        if (annotationPath && (!annotationLayers || annotationLayers.length === 0)) {
          topPaths.push(annotationPath);
        }
        
        // ── 2. 预合并 base 层和 top 层 ─────────────────────────────────
        const baseMergedPath = path.join(tempDir, 'ffpipe_base.png');
        if (basePaths.length === 0) {
          await execAsync(`magick -size ${frameW}x${frameH} xc:none "${baseMergedPath}"`, { maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
        } else if (basePaths.length === 1) {
          fs.copyFileSync(basePaths[0], baseMergedPath);
        } else {
          let cmd = `magick "${basePaths[0]}"`;
          for (let i = 1; i < basePaths.length; i++) cmd += ` "${basePaths[i]}" -composite`;
          cmd += ` "${baseMergedPath}"`;
          await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
        }
        
        let topMergedPath = null;
        if (topPaths.length > 0) {
          topMergedPath = path.join(tempDir, 'ffpipe_top.png');
          if (topPaths.length === 1) {
            fs.copyFileSync(topPaths[0], topMergedPath);
          } else {
            let cmd = `magick -size ${frameW}x${frameH} xc:none`;
            for (const tp of topPaths) cmd += ` "${tp}" -composite`;
            cmd += ` "${topMergedPath}"`;
            await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 });
          }
        }
        
        // ── 3. 构建 FFmpeg 滤镜图 ──────────────────────────────────────
        const ffInputs = [];
        const filterParts = [];
        let inputIdx = 0;
        
        // Input 0: base merged (循环静态图)
        ffInputs.push(`-loop 1 -framerate ${outputFps} -i "${baseMergedPath}"`);
        let prevStream = `${inputIdx}:v`;
        inputIdx++;
        
        // 按 z-index 顺序添加 mid 层 (GIF 层 + 穿插的静态/标注层)
        const midLayers = allLayers.filter(l => {
          if (l.type === 'gif') return true;
          return timelineStaticLayers.includes(l);
        }).sort((a, b) => a.zIndex - b.zIndex);
        
        for (const layer of midLayers) {
          if (layer.type === 'gif') {
            const gifInfo = gifFramesDirs[layer.gifIndex];
            
            // GIF 输入: 使用处理后的 GIF 文件, -ignore_loop 0 自动循环
            ffInputs.push(`-ignore_loop 0 -i "${gifInfo.sourceGifPath}"`);
            const gIdx = inputIdx++;
            
            // fps 转换 + 定位到画布 (pad)
            filterParts.push(`[${gIdx}:v]fps=${outputFps},pad=${frameW}:${frameH}:${gifInfo.finalOffsetX}:${gifInfo.finalOffsetY}:color=black@0.0[g${gIdx}]`);
            
            // Overlay + 可选的时间线 enable
            let enableExpr = '';
            if (hasTimelineOnLayer(layer.layerId)) {
              const range = timelineData[layer.layerId];
              const sf = Math.max(0, Math.floor((range.start / 100) * (totalSourceFrames - 1)) - trimStartFrame);
              const ef = Math.min(totalOutputFrames - 1, Math.ceil((range.end / 100) * (totalSourceFrames - 1)) - trimStartFrame);
              enableExpr = `:enable='gte(n\\,${sf})*lte(n\\,${ef})'`;
            }
            
            const next = `p${inputIdx}`;
            filterParts.push(`[${prevStream}][g${gIdx}]overlay=0:0${enableExpr}[${next}]`);
            prevStream = next;
            
          } else {
            // 静态/标注层 (有时间线或在 GIF 之间)
            ffInputs.push(`-loop 1 -framerate ${outputFps} -i "${layer.path}"`);
            const sIdx = inputIdx++;
            
            let enableExpr = '';
            if (hasTimelineOnLayer(layer.layerId)) {
              const range = timelineData[layer.layerId];
              const sf = Math.max(0, Math.floor((range.start / 100) * (totalSourceFrames - 1)) - trimStartFrame);
              const ef = Math.min(totalOutputFrames - 1, Math.ceil((range.end / 100) * (totalSourceFrames - 1)) - trimStartFrame);
              enableExpr = `:enable='gte(n\\,${sf})*lte(n\\,${ef})'`;
            }
            
            const next = `p${inputIdx}`;
            filterParts.push(`[${prevStream}][${sIdx}:v]overlay=0:0${enableExpr}[${next}]`);
            prevStream = next;
          }
        }
        
        // Top merged (如果有)
        if (topMergedPath) {
          ffInputs.push(`-loop 1 -framerate ${outputFps} -i "${topMergedPath}"`);
          const tIdx = inputIdx++;
          const next = `p${inputIdx}`;
          filterParts.push(`[${prevStream}][${tIdx}:v]overlay=0:0[${next}]`);
          prevStream = next;
        }
        
        // 调色板生成 + 编码 (直接在管道中完成, 省去中间 PNG)
        filterParts.push(`[${prevStream}]split[ps0][ps1]`);
        filterParts.push(`[ps0]palettegen=max_colors=256:stats_mode=diff[pal]`);
        filterParts.push(`[ps1][pal]paletteuse=dither=${ditherMode}:diff_mode=rectangle[out]`);
        
        const filterComplex = filterParts.join(';');
        const tempGifPath = path.join(tempDir, 'temp_output.gif');
        
        // ── 4. 执行 FFmpeg 管道 ────────────────────────────────────────
        const pipelineTimeout = Math.max(300000, totalOutputFrames * 2000); // 至少 5 分钟或每帧 2 秒
        const ffmpegCmd = `ffmpeg -threads 0 ${ffInputs.join(' ')} -filter_complex "${filterComplex}" -map "[out]" -frames:v ${totalOutputFrames} -loop 0 -threads 0 -y "${tempGifPath}"`;
        
        console.log(`   🚀 FFmpeg 管道: ${ffInputs.length} 输入, ${totalOutputFrames} 帧, fps=${outputFps}`);
        
        reportProgress(30, `正在合成 ${totalOutputFrames} 帧 (FFmpeg 管道)...`);
        await execAsync(ffmpegCmd, { maxBuffer: 200 * 1024 * 1024, timeout: pipelineTimeout });
        
        // 验证输出
        if (!fs.existsSync(tempGifPath) || fs.statSync(tempGifPath).size < 100) {
          throw new Error('FFmpeg 管道输出文件为空或过小');
        }
        
        reportProgress(85, '正在压缩优化...');
        
        // ── 5. gifsicle 优化 ───────────────────────────────────────────
        try {
          await execAsync('which gifsicle');
          const tempStats = fs.statSync(tempGifPath);
          const gifsicleTimeout = Math.max(60000, Math.ceil(tempStats.size / (1024 * 1024)) * 2000);
          
          await execAsync(`gifsicle -O3 --lossy=80 --no-conserve-memory "${tempGifPath}" -o "${outputPath}"`, 
            { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
          
          if (fs.existsSync(tempGifPath)) fs.unlinkSync(tempGifPath);
          
          const optimizedStats = fs.statSync(outputPath);
          console.log(`   🗜️  gifsicle: ${(tempStats.size / 1024 / 1024).toFixed(2)} MB → ${(optimizedStats.size / 1024 / 1024).toFixed(2)} MB`);
        } catch (e) {
          if (!fs.existsSync(outputPath)) {
            fs.renameSync(tempGifPath, outputPath);
          } else if (fs.existsSync(tempGifPath)) {
            fs.unlinkSync(tempGifPath);
          }
        }
        
        endStep('Step 4 FFmpeg管道合成');
        ffmpegPipelineSucceeded = true;
        
        // 异步清理帧目录（pipeline 模式下这些目录仍然存在但不再需要）
        setImmediate(() => {
          try {
            for (const gifFramesInfo of gifFramesDirs) {
              if (fs.existsSync(gifFramesInfo.dir)) {
                removeDirRecursive(gifFramesInfo.dir);
              }
            }
          } catch (e) {}
        });
        
      } catch (pipelineErr) {
        if (pipelineErr.message === 'GIF_EXPORT_CANCELLED' || (shouldCancel && shouldCancel())) {
          throw pipelineErr; // 取消操作直接抛出，不回退
        }
        console.log(`   ⚠️  FFmpeg 管道失败，回退到逐帧模式: ${pipelineErr.message}`);
        if (pipelineErr.stderr) console.log(`   STDERR: ${pipelineErr.stderr.substring(0, 500)}`);
      }
      
      // ════════════════════════════════════════════════════════════════════
      // 回退路径：逐帧 ImageMagick 合成（仅当 FFmpeg 管道失败时执行）
      // ════════════════════════════════════════════════════════════════════
      if (!ffmpegPipelineSucceeded) {
      
      // 🚀🚀🚀 优化：合并 Step 4 和 Step 5，一次性完成所有层的合成
      // 原来需要处理 N 帧 × 2 步骤 = 2N 次操作
      // 现在只需要 N 帧 × 1 步骤 = N 次操作，减少 50% 的处理时间
      
      startStep('Step 4 合成帧');
      reportProgress(30, '正在合成动态帧...');
      
      // 直接输出到最终目录（跳过中间目录）
      const annotatedFramesDir = path.join(tempDir, 'annotated_frames');
      if (!fs.existsSync(annotatedFramesDir)) {
        fs.mkdirSync(annotatedFramesDir, { recursive: true });
      }
      
      // backgroundPath 已在 FFmpeg 管道优化前创建
      
      // 并行处理帧合成，限制并发数
      // 🚀 优化：根据 CPU 核心数动态调整并行数（最小 16，最大 64）
      const cpuCount = os.cpus().length;
      const PARALLEL_LIMIT = Math.min(64, Math.max(16, cpuCount * 4));
      console.log(`      并行处理: ${PARALLEL_LIMIT} 帧/批 (CPU: ${cpuCount} 核)`);
      
      let completedFrames = 0;
      
      // 🚀🚀🚀 优化：一次性合成所有层（背景 + Bottom + GIF层 + Top）
      // 🎬 processFrame 接收两个参数：
      //   sourceFrameIdx: 源帧索引（用于计算时间线进度和GIF帧映射）
      //   outputIdx: 输出帧序号（用于文件命名，从0开始连续递增）
      const processFrame = async (sourceFrameIdx, outputIdx) => {
        checkCancelled();
        
        // 🕐 Debug: Log timelineData availability on first frame
        if (outputIdx === 0) {
          console.log(`      🕐 [processFrame] timelineData 可用: ${!!timelineData}, 键数: ${timelineData ? Object.keys(timelineData).length : 0}`);
          if (trimStartFrame > 0 || trimEndFrame < totalSourceFrames - 1) {
            console.log(`      🎬 [processFrame] 裁剪范围: 源帧 ${trimStartFrame}~${trimEndFrame}, 输出帧 0~${totalOutputFrames - 1}`);
          }
        }
        
        // 🎬 输出帧使用连续编号（outputIdx），确保 FFmpeg 能正确读取
        const outputFrame = path.join(annotatedFramesDir, `frame_${String(outputIdx).padStart(4, '0')}.png`);
        // 🎬 时间计算基于源帧索引，确保GIF帧映射正确
        const currentTime = (sourceFrameIdx * outputDelay) / 100;
        // 🎬 用于时间线进度判断（sourceFrameIdx 相对于 totalSourceFrames）
        const frameIdx = sourceFrameIdx;
        
        // 收集所有图层路径（按从底到顶的顺序）
        const allLayerPaths = [];
        
        // 1. 背景层（最底层）
        if (backgroundPath) {
          allLayerPaths.push(backgroundPath);
        }
        
        // 2. Bottom Layer
        if (bottomLayerPath) {
          allLayerPaths.push(bottomLayerPath);
        }
        
        // 3. 所有 GIF 和静态图层（按 z-index 顺序）
        for (let layerIdx = 0; layerIdx < allLayers.length; layerIdx++) {
          const layer = allLayers[layerIdx];
          
          if (layer.type === 'gif') {
            const gifInfo = layer.gifInfo;
            
            // Check timeline visibility
            if (timelineData && timelineData[gifInfo.layerId]) {
                const range = timelineData[gifInfo.layerId];
                // 🎬 进度基于 totalSourceFrames（源帧总数），不是裁剪后的输出帧数
                const progress = totalSourceFrames > 1 ? (frameIdx / (totalSourceFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    // 时间线裁剪：GIF 层在此帧被跳过
                    continue; // Skip this layer for this frame
                }
            }

            const gifTime = currentTime % gifInfo.totalDuration;
            const gifFrameIdx = Math.floor(gifTime / (gifInfo.delay / 100));
            const actualGifFrameIdx = Math.min(gifFrameIdx, gifInfo.frameCount - 1);
            const framePath = path.join(gifInfo.dir, `frame_${String(actualGifFrameIdx).padStart(4, '0')}.png`);
            allLayerPaths.push(framePath);
          } else if (layer.type === 'static') {
            // Check timeline visibility
            if (timelineData && timelineData[layer.layerId]) {
                const range = timelineData[layer.layerId];
                // 🎬 进度基于 totalSourceFrames
                const progress = totalSourceFrames > 1 ? (frameIdx / (totalSourceFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    continue; // Skip this layer for this frame
                }
            }
            allLayerPaths.push(layer.path);
          } else if (layer.type === 'annotation') {
            // Check timeline visibility for annotation layers
            if (timelineData && timelineData[layer.layerId]) {
                const range = timelineData[layer.layerId];
                // 🎬 进度基于 totalSourceFrames
                const progress = totalSourceFrames > 1 ? (frameIdx / (totalSourceFrames - 1)) * 100 : 0;
                if (progress < range.start || progress > range.end) {
                    continue; // Skip this layer for this frame
                }
            }
            allLayerPaths.push(layer.path);
          }
        }
        
        // 4. Top Layer（兼容模式：如果没有单独的标注图层，使用合成的 annotationPath）
        if (annotationPath && annotationLayerPaths.length === 0) {
          allLayerPaths.push(annotationPath);
        }
        
        // 首帧日志
        if (outputIdx === 0) {
          console.log(`      首帧: ${allLayerPaths.length} 层`);
        }
        
        if (allLayerPaths.length === 0) {
          return;
        }
        
        if (allLayerPaths.length === 1) {
          // 只有一层，直接复制
          fs.copyFileSync(allLayerPaths[0], outputFrame);
        } else {
          // 🚀 使用单个 magick 命令一次性合成所有层，启用多线程
          let composeCmd = `magick -limit thread 0 "${allLayerPaths[0]}"`;
          for (let i = 1; i < allLayerPaths.length; i++) {
            composeCmd += ` "${allLayerPaths[i]}" -composite`;
          }
          composeCmd += ` "${outputFrame}"`;
          
          await execAsync(composeCmd, { maxBuffer: 100 * 1024 * 1024 });
        }
        
        completedFrames++;
        // 🚀 减少日志频率，降低 I/O 开销（每 50 帧或最后一帧报告一次）
        if (completedFrames % 50 === 0 || completedFrames === totalOutputFrames) {
          const progress = 30 + Math.round((completedFrames / totalOutputFrames) * 50);
          reportProgress(progress, `正在合成帧 ${completedFrames}/${totalOutputFrames}`);
        }
      };
      
      // 🎬 分批并行处理（使用裁剪后的帧范围）
      // sourceFrameIdx: 源帧（trimStartFrame ~ trimEndFrame），用于GIF帧映射和时间线进度
      // outputIdx: 输出帧（0 ~ totalOutputFrames-1），用于文件连续编号
      for (let batchStart = 0; batchStart < totalOutputFrames; batchStart += PARALLEL_LIMIT) {
        const batch = [];
        for (let offset = 0; offset < PARALLEL_LIMIT && (batchStart + offset) < totalOutputFrames; offset++) {
          const outIdx = batchStart + offset;
          const srcIdx = trimStartFrame + outIdx;
          batch.push(processFrame(srcIdx, outIdx));
        }
        await Promise.all(batch);
      }
      
      console.log(`      合成进度: ${totalOutputFrames}/${totalOutputFrames}`)
      
      console.log(`   ✅ 所有帧已一次性完成合成（背景 + Bottom + GIF层 + Top）`);
      
      // 第六步：重组为 GIF
      endStep('Step 4 合成帧');
      startStep('Step 6 生成GIF');
      console.log(`\n   第 6 步：重组为 GIF...`);
      reportProgress(80, '正在生成最终 GIF...');
      console.log(`      输出延迟: ${outputDelay}/100秒 (${(outputDelay / 100).toFixed(3)}秒/帧)`);
      console.log(`      输出帧数: ${totalOutputFrames} 帧`);
      console.log(`      输出时长: ${trimmedDuration.toFixed(2)}秒${trimStartPercent > 0 || trimEndPercent < 100 ? ` (裁剪自 ${maxDuration.toFixed(2)}秒)` : ''}`);
      console.log(`      理论帧率: ${(100 / outputDelay).toFixed(1)} fps`);
      
      // 合并生成和优化为一条命令，启用多线程加速
      // 🚀🚀🚀 优化：先快速生成 GIF，再用 gifsicle 优化（比 ImageMagick OptimizeFrame 快 10 倍）
      
      // 第一步：生成 GIF
      // 🚀 优先使用 ffmpeg（更快），回退到 ImageMagick
      const tempGifPath = path.join(tempDir, 'temp_output.gif');
      
      // 计算 ffmpeg 需要的帧率 (outputDelay 是 1/100 秒)
      const outputFps = 100 / outputDelay;
      
      let usedFfmpeg = false;
      try {
        // 尝试用 ffmpeg 生成（速度更快）
        // -framerate: 输入帧率
        // 🎨 根据用户设置使用相应的抖动算法
        const palettePath = path.join(tempDir, 'palette.png');
        
        // 🗜️ 剪映级 GIF 压缩流水线 - 第 1 阶段：FFmpeg 帧差分编码
        //
        // 技术 ①：帧差分 + 脏矩形裁剪 (diff_mode=rectangle)
        //   → 每帧只存储相对于前帧变化的矩形区域，未变化像素设为透明
        //   → LZW 对大面积透明像素（连续游程）压缩率极高
        //   → 单项可贡献 50-70% 体积降低
        //
        // 技术 ②：帧间差异调色板 (stats_mode=diff)
        //   → 调色板颜色集中分配给帧间变化的像素（而非全局均匀分配）
        //   → 变化区域获得更精准的色彩表达
        //
        // 技术 ③：感知抖动 (dither=floyd_steinberg/bayer)
        //   → 用误差扩散模拟更多颜色，减少色带
        //   → 抖动噪声的结构性反而有利于 LZW 编码
        //
        // max_colors=256：保留最大色彩精度，让后续 gifsicle 做更精准的 LZW 优化
        const paletteCmd = `ffmpeg -threads 0 -y -framerate ${outputFps} -i "${annotatedFramesDir}/frame_%04d.png" -vf "palettegen=max_colors=256:stats_mode=diff" -threads 0 "${palettePath}"`;
        await execAsync(paletteCmd, { maxBuffer: 100 * 1024 * 1024, timeout: 60000 });
        
        const ffmpegGifCmd = `ffmpeg -threads 0 -y -framerate ${outputFps} -i "${annotatedFramesDir}/frame_%04d.png" -i "${palettePath}" -lavfi "paletteuse=dither=${ditherMode}:diff_mode=rectangle" -threads 0 -loop 0 "${tempGifPath}"`;
        await execAsync(ffmpegGifCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
        
        // 清理调色板
        if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
        usedFfmpeg = true;
        console.log(`      ✅ 使用 ffmpeg 生成 GIF (更快, dither=${ditherMode})`);
      } catch (ffmpegErr) {
        // ffmpeg 失败，回退到 ImageMagick
        console.log(`      ⚠️  ffmpeg 不可用，使用 ImageMagick 生成...`);
        // 根据用户设置使用相应的抖动算法（ImageMagick 回退方案）
        const generateCmd = `convert -limit thread 0 -delay ${outputDelay} -loop 0 "${annotatedFramesDir}/frame_*.png" -colors 256 -dither ${imageMagickDither} "${tempGifPath}"`;
        await execAsync(generateCmd, { maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
      }
      
      // 🗜️ 剪映级 GIF 压缩流水线 - 第 2 阶段：gifsicle 深度优化
      //
      // FFmpeg 已完成：帧差分 + 脏矩形裁剪 + 调色板优化
      // gifsicle 负责 FFmpeg 做不了的事：
      //
      // 技术 ④：像素级透明优化 (-O3)
      //   → FFmpeg 的 diff_mode=rectangle 只裁切到矩形框
      //   → gifsicle -O3 在矩形框内部进一步将未变化的单个像素设为透明
      //   → LZW 对透明连续游程压缩率极高
      //
      // 技术 ⑤：LZW 编码优化 (-O3)
      //   → 尝试所有压缩方法并选择最优结果
      //   → 优化码表管理策略，延迟清空 LZW 码表让长匹配串积累
      //   → 自动选择最优最小码字长度 (min LZW code size)
      //
      // 技术 ⑥：有损 LZW 扰动 (--lossy=80)
      //   → 在编码时引入人眼不敏感的轻微噪声
      //   → 使相邻像素值更规律，产生更长的 LZW 匹配串
      //   → 额外减小 20-40% 体积，视觉几乎无损
      //
      // gifsicle 深度优化：像素级透明 + LZW + 有损扰动
      try {
        await execAsync('which gifsicle');
        const tempStats = fs.statSync(tempGifPath);
        const gifsicleTimeout = Math.max(60000, Math.ceil(tempStats.size / (1024 * 1024)) * 2000);
        
        await execAsync(`gifsicle -O3 --lossy=80 --no-conserve-memory "${tempGifPath}" -o "${outputPath}"`, 
          { maxBuffer: 200 * 1024 * 1024, timeout: gifsicleTimeout });
        
        if (fs.existsSync(tempGifPath)) fs.unlinkSync(tempGifPath);
        
        const optimizedStats = fs.statSync(outputPath);
        console.log(`      🗜️  gifsicle: ${(tempStats.size / 1024 / 1024).toFixed(2)} MB → ${(optimizedStats.size / 1024 / 1024).toFixed(2)} MB`);
      } catch (e) {
        // gifsicle 不可用或失败，直接使用 FFmpeg 输出
        if (!fs.existsSync(outputPath)) {
          fs.renameSync(tempGifPath, outputPath);
        } else if (fs.existsSync(tempGifPath)) {
          fs.unlinkSync(tempGifPath);
        }
      }
      endStep('Step 6 生成GIF');
      
      // 异步清理帧目录（不阻塞导出结果返回）
      setImmediate(() => {
        try {
          for (const gifFramesInfo of gifFramesDirs) {
            if (fs.existsSync(gifFramesInfo.dir)) {
              removeDirRecursive(gifFramesInfo.dir);
            }
          }
          if (fs.existsSync(annotatedFramesDir)) {
            removeDirRecursive(annotatedFramesDir);
          }
        } catch (e) {
          // 忽略清理错误
        }
      });
      
      } // end of fallback: if (!ffmpegPipelineSucceeded)
    }
    
    
    // 5. GIF 已生成，立即报告 100%（不要等清理完再报告）
    const stats = fs.statSync(outputPath);
    reportProgress(100, '导出完成');
    
    // 6. 异步清理临时文件（不阻塞导出结果返回）
    setImmediate(() => {
      try {
        if (fs.existsSync(tempDir)) {
          removeDirRecursive(tempDir);
        }
      } catch (e) {
        // 忽略清理错误
      }
    });
    
    _reservedExportNumbers.delete(sequenceNumber); // 🔒 释放预留序号
    
    return {
      outputPath,
      filename: outputFilename,
      size: stats.size
    };
    
  } catch (error) {
    _reservedExportNumbers.delete(sequenceNumber); // 🔒 释放预留序号
    
    // ✅ 优先检查是否被取消 (如果是取消导致的命令失败，统一视为取消)
    if (error.message === 'GIF_EXPORT_CANCELLED' || (shouldCancel && shouldCancel())) {
      throw new Error('GIF_EXPORT_CANCELLED');
    }

    // 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        removeDirRecursive(tempDir);
      }
    } catch (e) {
      // 忽略清理错误
    }
    
    // 检查是否是因为缺少 ImageMagick
    // 只有当明确是命令未找到时，才提示安装
    const isCommandNotFound = error.code === 'ENOENT' || 
                             error.code === 127 ||
                             (error.message && error.message.includes('command not found'));

    if (isCommandNotFound) {
      console.error('❌ 系统无法找到 ImageMagick 命令');
      throw new Error('未找到 ImageMagick\n\n请先安装: brew install imagemagick');
    }
    
    // 如果是 ImageMagick 执行过程中的错误（比如参数不对，或者文件问题）
    if (error.message && (error.message.includes('convert') || error.message.includes('magick'))) {
      console.error('❌ ImageMagick 执行出错 (非缺失):', error.message);
      let detailedMsg = error.message.split('\n')[0];
      if (error.stderr) {
        console.error('   错误详情 (STDERR):', error.stderr);
        detailedMsg += `\nSTDERR: ${error.stderr}`;
      } else if (error.message.includes('STDERR:')) {
         // 如果 message 已经包含了 STDERR (在之前的步骤中添加的)
         detailedMsg = error.message;
      }
      
      // 不要吞掉原始错误，直接抛出，或者包装一下
      throw new Error(`GIF 处理失败 (ImageMagick): ${detailedMsg}`);
    }
    
    throw error;
  }
}

return composeAnnotatedGif;
};
