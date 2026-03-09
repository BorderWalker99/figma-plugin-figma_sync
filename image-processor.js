const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const defaultExecAsync = promisify(exec);

function prependPathOnce(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const current = process.env.PATH || '';
  if (!current.split(':').includes(dir)) {
    process.env.PATH = current ? `${dir}:${current}` : dir;
  }
}

function ensureImageRuntimeEnv() {
  const archKey = process.arch === 'arm64' ? 'apple' : 'intel';
  const runtimeBinCandidates = [
    path.join(__dirname, 'runtime', 'bin'),
    path.join(__dirname, 'runtime', archKey, 'bin'),
    path.join(__dirname, 'runtime', process.arch, 'bin'),
    path.join(os.homedir(), '.screensync', 'bin'),
    path.join(os.homedir(), '.screensync', 'deps', 'imagemagick', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ];
  for (const dir of runtimeBinCandidates.reverse()) {
    prependPathOnce(dir);
  }

  if (!process.env.MAGICK_HOME) {
    const magickHomes = [
      path.join(__dirname, 'runtime', archKey),
      path.join(__dirname, 'runtime', 'imagemagick'),
      path.join(os.homedir(), '.screensync', 'deps', 'imagemagick')
    ];
    for (const home of magickHomes) {
      if (!fs.existsSync(path.join(home, 'bin', 'magick'))) continue;
      process.env.MAGICK_HOME = home;
      const imLib = path.join(home, 'lib');
      if (fs.existsSync(imLib)) {
        process.env.DYLD_LIBRARY_PATH = imLib + (process.env.DYLD_LIBRARY_PATH ? `:${process.env.DYLD_LIBRARY_PATH}` : '');
      }
      const coderDir = path.join(home, 'lib', 'ImageMagick', 'modules-Q16HDRI', 'coders');
      if (fs.existsSync(coderDir)) {
        process.env.MAGICK_CODER_MODULE_PATH = coderDir;
      }
      const filterDir = path.join(home, 'lib', 'ImageMagick', 'modules-Q16HDRI', 'filters');
      if (fs.existsSync(filterDir)) {
        process.env.MAGICK_FILTER_MODULE_PATH = filterDir;
      }
      const etcDir = path.join(home, 'etc', 'ImageMagick-7');
      const cfgDir = path.join(home, 'lib', 'ImageMagick', 'config-Q16HDRI');
      const cfgParts = [etcDir, cfgDir].filter((dir) => fs.existsSync(dir));
      if (cfgParts.length) {
        process.env.MAGICK_CONFIGURE_PATH = cfgParts.join(':');
      }
      break;
    }
  }
}

ensureImageRuntimeEnv();

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function createTempPath(ext = '.tmp') {
  return path.join(os.tmpdir(), `screensync-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

function cleanupPaths(paths) {
  for (const filePath of paths) {
    if (!filePath) continue;
    try {
      fs.rmSync(filePath, { recursive: true, force: true });
    } catch (_) {}
  }
}

function mapMimeToFormat(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (!mime) return null;
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
  if (mime === 'image/webp') return 'webp';
  if (mime.includes('heic')) return 'heic';
  if (mime.includes('heif')) return 'heif';
  if (mime.includes('tiff')) return 'tiff';
  if (mime.includes('bmp')) return 'bmp';
  return null;
}

function mapExtToFormat(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!ext) return null;
  if (ext === '.gif') return 'gif';
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  if (ext === '.heic') return 'heic';
  if (ext === '.heif') return 'heif';
  if (ext === '.tif' || ext === '.tiff') return 'tiff';
  if (ext === '.bmp') return 'bmp';
  return null;
}

function mapFormatToExtension(format) {
  switch (format) {
    case 'gif':
      return '.gif';
    case 'png':
      return '.png';
    case 'jpeg':
      return '.jpg';
    case 'webp':
      return '.webp';
    case 'heic':
      return '.heic';
    case 'heif':
      return '.heif';
    case 'tiff':
      return '.tiff';
    case 'bmp':
      return '.bmp';
    default:
      return '.img';
  }
}

function detectFormatFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer.length >= 6) {
    const header6 = buffer.slice(0, 6).toString('ascii');
    if (header6 === 'GIF87a' || header6 === 'GIF89a') return 'gif';
  }

  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (buffer.length >= 12) {
    const riff = buffer.slice(0, 4).toString('ascii');
    const webp = buffer.slice(8, 12).toString('ascii');
    if (riff === 'RIFF' && webp === 'WEBP') return 'webp';
  }

  if (buffer.length >= 4) {
    const littleTiff = buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00;
    const bigTiff = buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a;
    if (littleTiff || bigTiff) return 'tiff';
  }

  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'bmp';
  }

  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heif', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return brand.startsWith('hei') ? 'heic' : 'heif';
    }
  }

  return null;
}

function normalizeInput(input, options = {}) {
  if (Buffer.isBuffer(input)) {
    return {
      buffer: input,
      filePath: null,
      fileName: options.fileName || '',
      mimeType: options.mimeType || ''
    };
  }

  if (typeof input === 'string') {
    return {
      buffer: null,
      filePath: input,
      fileName: options.fileName || path.basename(input),
      mimeType: options.mimeType || ''
    };
  }

  if (input && (Buffer.isBuffer(input.buffer) || typeof input.filePath === 'string')) {
    return {
      buffer: Buffer.isBuffer(input.buffer) ? input.buffer : null,
      filePath: typeof input.filePath === 'string' ? input.filePath : null,
      fileName: input.fileName || options.fileName || (input.filePath ? path.basename(input.filePath) : ''),
      mimeType: input.mimeType || options.mimeType || ''
    };
  }

  throw new Error('Unsupported image input');
}

function readHeaderBytes(filePath, size = 64) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.slice(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

async function detectImageFormat(input, options = {}) {
  const normalized = normalizeInput(input, options);
  const fromMime = mapMimeToFormat(normalized.mimeType);
  if (fromMime) return fromMime;

  const fromExt = mapExtToFormat(normalized.fileName || normalized.filePath);
  if (fromExt) return fromExt;

  const header = normalized.buffer || (normalized.filePath && fs.existsSync(normalized.filePath) ? readHeaderBytes(normalized.filePath) : null);
  return detectFormatFromBuffer(header) || 'unknown';
}

function isHeifFormat(format) {
  return format === 'heif' || format === 'heic';
}

function findExecutable(name) {
  const candidates = [];
  if (process.env.MAGICK_HOME) {
    candidates.push(path.join(process.env.MAGICK_HOME, 'bin', name));
  }

  const archKey = process.arch === 'arm64' ? 'apple' : 'intel';
  candidates.push(
    path.join(__dirname, 'runtime', 'bin', name),
    path.join(__dirname, 'runtime', archKey, 'bin', name),
    path.join(__dirname, 'runtime', process.arch, 'bin', name),
    path.join(os.homedir(), '.screensync', 'bin', name),
    path.join(os.homedir(), '.screensync', 'deps', 'imagemagick', 'bin', name),
    path.join('/opt/homebrew/bin', name),
    path.join('/usr/local/bin', name),
    path.join('/usr/bin', name),
    path.join('/bin', name)
  );

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return name;
}

async function runCommand(command, options = {}) {
  const execAsync = options.execAsync || defaultExecAsync;
  const execOptions = { ...options };
  delete execOptions.execAsync;
  return execAsync(command, execOptions);
}

async function convertHeifToJpeg(input, options = {}) {
  const normalized = normalizeInput(input, options);
  const cleanupTargets = [];
  let inputPath = normalized.filePath;

  if (!inputPath) {
    const inputExt = mapFormatToExtension(await detectImageFormat(normalized, options));
    inputPath = createTempPath(inputExt);
    fs.writeFileSync(inputPath, normalized.buffer);
    cleanupTargets.push(inputPath);
  }

  const outputPath = options.outputPath || createTempPath('.jpg');
  if (!options.outputPath) {
    cleanupTargets.push(outputPath);
  }

  await runCommand(
    `sips -s format jpeg ${shellQuote(inputPath)} --out ${shellQuote(outputPath)}`,
    {
      execAsync: options.execAsync,
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 20 * 1024 * 1024
    }
  );

  if (!fs.existsSync(outputPath)) {
    cleanupPaths(cleanupTargets);
    throw new Error('sips 转换失败: 输出文件不存在');
  }

  return {
    outputPath,
    cleanup() {
      cleanupPaths(cleanupTargets);
    }
  };
}

async function normalizeStillImageToJpeg(input, options = {}) {
  const normalized = normalizeInput(input, options);
  const cleanupTargets = [];
  let inputPath = normalized.filePath;
  let heifCleanup = null;
  let format = await detectImageFormat(normalized, options);

  if (!inputPath) {
    inputPath = createTempPath(mapFormatToExtension(format));
    fs.writeFileSync(inputPath, normalized.buffer);
    cleanupTargets.push(inputPath);
  }

  if (isHeifFormat(format)) {
    const conversion = await convertHeifToJpeg({ filePath: inputPath, fileName: normalized.fileName, mimeType: normalized.mimeType }, options);
    inputPath = conversion.outputPath;
    heifCleanup = conversion.cleanup;
    format = 'jpeg';
  }

  const magickBin = findExecutable('magick');
  const outputPath = createTempPath('.jpg');
  cleanupTargets.push(outputPath);

  const maxWidth = Number.isFinite(options.maxWidth) ? options.maxWidth : 1920;
  const quality = Number.isFinite(options.quality) ? options.quality : 85;
  const background = options.background || 'white';

  const command = `${shellQuote(magickBin)} ${shellQuote(inputPath)} -auto-orient -background ${shellQuote(background)} -alpha remove -alpha off -strip -resize "${maxWidth}x>" -quality ${quality} ${shellQuote(outputPath)}`;
  await runCommand(command, {
    execAsync: options.execAsync,
    timeout: options.timeout || 60000,
    maxBuffer: options.maxBuffer || 50 * 1024 * 1024
  });

  if (!fs.existsSync(outputPath)) {
    if (heifCleanup) heifCleanup();
    cleanupPaths(cleanupTargets);
    throw new Error('ImageMagick 转换失败: 输出文件不存在');
  }

  const buffer = fs.readFileSync(outputPath);

  if (heifCleanup) heifCleanup();
  cleanupPaths(cleanupTargets);

  return {
    buffer,
    mimeType: 'image/jpeg',
    fileExtension: '.jpg',
    format
  };
}

module.exports = {
  detectImageFormat,
  normalizeStillImageToJpeg,
  convertHeifToJpeg,
  isAnimatedGif: async (input, options = {}) => (await detectImageFormat(input, options)) === 'gif',
  isHeifFormat,
  ensureImageRuntimeEnv
};
