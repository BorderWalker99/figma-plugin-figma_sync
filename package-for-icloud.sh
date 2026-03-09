#!/bin/bash

# ScreenSync iCloud 定制版打包脚本
# 基于主代码库生成 iCloud-only 版本，不影响 Google Drive 模式源代码

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

require_file() {
    local file_path="$1"
    local hint="$2"
    if [ ! -f "$file_path" ]; then
        echo -e "${RED}❌ 缺少文件: $file_path${NC}"
        if [ -n "$hint" ]; then
            echo -e "${YELLOW}$hint${NC}"
        fi
        exit 1
    fi
}

require_runtime_arch() {
    local bin_path="$1"
    local expected_arch="$2" # x86_64 | arm64
    if [ ! -x "$bin_path" ]; then
        echo -e "${RED}❌ 缺少可执行文件: $bin_path${NC}"
        exit 1
    fi
    local info
    info="$(file "$bin_path" 2>/dev/null || true)"
    if [[ "$info" != *"$expected_arch"* ]]; then
        echo -e "${RED}❌ 架构不匹配: $bin_path${NC}"
        echo -e "${YELLOW}   期望: $expected_arch, 实际: $info${NC}"
        exit 1
    fi
}

require_runtime_max_macos() {
    local bin_path="$1"
    local max_major="$2"
    local line minos major
    if [ ! -x "$bin_path" ]; then
        echo -e "${RED}❌ 缺少可执行文件: $bin_path${NC}"
        exit 1
    fi
    line="$(otool -l "$bin_path" 2>/dev/null | awk '/minos/{print $2; exit}')"
    if [ -z "$line" ]; then
        line="$(otool -l "$bin_path" 2>/dev/null | awk '/LC_VERSION_MIN_MACOSX/{f=1; next} f&&/version/{print $2; exit}')"
    fi
    if [ -z "$line" ]; then
        echo -e "${RED}❌ 无法解析最小系统版本: $bin_path${NC}"
        exit 1
    fi
    minos="$line"
    major="${minos%%.*}"
    if [ -z "$major" ] || [ "$major" -gt "$max_major" ]; then
        echo -e "${RED}❌ 最小系统版本不兼容: $bin_path${NC}"
        echo -e "${YELLOW}   期望支持 ≤ macOS ${max_major}.x，实际 minos=${minos}${NC}"
        exit 1
    fi
}

validate_runtime_arch_bundle() {
    local runtime_root="$1"
    local arch_dir="$2"      # intel | apple
    local expected_arch="$3" # x86_64 | arm64
    local bin_root="$runtime_root/$arch_dir/bin"

    require_file "$bin_root/node" "$arch_dir runtime/bin/node 必须存在"
    require_file "$bin_root/ffmpeg" "$arch_dir runtime/bin/ffmpeg 必须存在"
    require_file "$bin_root/ffprobe" "$arch_dir runtime/bin/ffprobe 必须存在"
    require_file "$bin_root/gifsicle" "$arch_dir runtime/bin/gifsicle 必须存在"
    if [ ! -f "$bin_root/magick" ] && [ ! -f "$bin_root/convert" ]; then
        echo -e "${RED}❌ $bin_root 下缺少 magick/convert${NC}"
        exit 1
    fi

    require_runtime_arch "$bin_root/node" "$expected_arch"
    require_runtime_arch "$bin_root/ffmpeg" "$expected_arch"
    require_runtime_arch "$bin_root/ffprobe" "$expected_arch"
    require_runtime_arch "$bin_root/gifsicle" "$expected_arch"
    if [ -f "$bin_root/magick" ]; then
        require_runtime_arch "$bin_root/magick" "$expected_arch"
    else
        require_runtime_arch "$bin_root/convert" "$expected_arch"
    fi

    require_runtime_max_macos "$bin_root/node" 13
    require_runtime_max_macos "$bin_root/ffmpeg" 13
    require_runtime_max_macos "$bin_root/ffprobe" 13
    require_runtime_max_macos "$bin_root/gifsicle" 13
    if [ -f "$bin_root/magick" ]; then
        require_runtime_max_macos "$bin_root/magick" 13
    else
        require_runtime_max_macos "$bin_root/convert" 13
    fi
}

echo -e "${BLUE}"
cat << "EOF"
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync iCloud 定制版打包工具                 ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}\n"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PACKAGE_NAME="ScreenSync_iCloud"
TEMP_DIR="/tmp/${PACKAGE_NAME}"
PROJECT_DIR="${TEMP_DIR}/项目文件"

# ========================================
# 步骤 1：构建 Electron 安装器（双架构 DMG）
# ========================================
echo -e "${YELLOW}🔨 正在构建 GUI 安装器 (Electron)...${NC}"
cd installer

if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 安装 Electron 依赖...${NC}"
    npm install
fi

rm -rf dist

echo -e "   ${YELLOW}构建双架构 DMG...${NC}"
npm run build:mac

DMG_INTEL=""
DMG_ARM=""
for dmg in dist/*.dmg; do
    [ -e "$dmg" ] || continue
    if [[ "$dmg" == *"-arm64.dmg" ]]; then
        DMG_ARM="$dmg"
    else
        DMG_INTEL="$dmg"
    fi
done

if [ -z "$DMG_INTEL" ] || [ -z "$DMG_ARM" ]; then
    echo -e "${RED}❌ 需要同时存在 Intel 和 Apple Silicon 版本的 DMG${NC}"
    exit 1
fi

cd "$SCRIPT_DIR"
DMG_INTEL="installer/$DMG_INTEL"
DMG_ARM="installer/$DMG_ARM"

echo -e "${GREEN}✅ Intel DMG: $DMG_INTEL${NC}"
echo -e "${GREEN}✅ Apple DMG: $DMG_ARM${NC}\n"

# ========================================
# 步骤 2：清理临时目录并复制源文件
# ========================================
echo -e "${YELLOW}📁 准备打包目录...${NC}"
rm -rf "$TEMP_DIR"
mkdir -p "$PROJECT_DIR"

# 核心服务器文件（不含 Google Drive 相关）
echo -e "${YELLOW}📄 复制核心文件...${NC}"
for f in server.js userConfig.js start.js setup-autostart.js gif-composer.js image-processor.js adaptive-processing.js icloud-watcher.js; do
    if [ -f "$f" ]; then
        cp "$f" "$PROJECT_DIR/"
        echo "   ✅ $f"
    fi
done

# 配置文件
cp package.json "$PROJECT_DIR/"
cp package-lock.json "$PROJECT_DIR/" 2>/dev/null || true
cp README.md "$PROJECT_DIR/" 2>/dev/null || true

# 离线 runtime（仅保留 Node.js 与工具二进制）
if [ -d "runtime" ]; then
    echo -e "${YELLOW}🧰 复制离线 runtime...${NC}"
    rsync -a "runtime/" "$PROJECT_DIR/runtime/"
fi

validate_runtime_arch_bundle "$PROJECT_DIR/runtime" "intel" "x86_64"
validate_runtime_arch_bundle "$PROJECT_DIR/runtime" "apple" "arm64"

# Figma 插件（完整目录）
echo -e "${YELLOW}🎨 复制 Figma 插件...${NC}"
mkdir -p "$PROJECT_DIR/figma-plugin"
rsync -a --exclude '.DS_Store' --exclude '*.map' --exclude 'node_modules/' \
    "figma-plugin/" "$PROJECT_DIR/figma-plugin/"

# 图片资源
if [ -d "images" ]; then
    cp -r images "$PROJECT_DIR/"
fi

# 版本信息
if [ -f "VERSION.txt" ]; then
    cp VERSION.txt "$PROJECT_DIR/"
fi

# plist 模板
cp com.screensync.server.plist "$PROJECT_DIR/" 2>/dev/null || true

# ========================================
# 步骤 3：移除 Google Drive / 更新系统相关文件
# ========================================
echo -e "${YELLOW}🧹 移除 Google Drive 和更新系统文件...${NC}"
for f in googleDrive.js drive-watcher.js aliyun-watcher.js update-handlers.js update-manager.js serviceAccountKey.js .env; do
    rm -f "$PROJECT_DIR/$f"
done
echo "   ✅ 已移除"

# ========================================
# 步骤 4：设置默认 iCloud 模式
# ========================================
echo -e "${YELLOW}⚙️  设置默认 iCloud 模式...${NC}"
echo "icloud" > "$PROJECT_DIR/.sync-mode"
echo "   ✅ .sync-mode → icloud"

# ========================================
# 步骤 5：补丁 server.js — 移除 Google Drive 依赖加载的硬失败
# ========================================
echo -e "${YELLOW}🔧 补丁 server.js...${NC}"

# 5a. 移除 check-update 消息处理中对 update-manager 的依赖（使其安全忽略）
# 5b. 移除 update-full 相关的 require('update-handlers')
# 使用 node 脚本做安全的字符串替换
node - "$PROJECT_DIR/server.js" <<'PATCH_SERVER'
const fs = require('fs');
const serverPath = process.argv[2];
let code = fs.readFileSync(serverPath, 'utf8');

// 将所有 require('./googleDrive') 调用包裹在 try-catch 中
code = code.replace(
  /require\('\.\/googleDrive'\)/g,
  `(() => { try { return require('./googleDrive'); } catch(_) { return { uploadBuffer(){}, createFolder(){}, getResumableUploadUrl(){}, listFolderFiles: async()=>({files:[]}), downloadFileBuffer: async()=>Buffer.alloc(0), trashFile: async()=>{}, getFileInfo: async()=>({}), resolveServiceAccount:()=>null }; } })()`
);

// 将 require('./update-handlers')(...) 调用包裹在 try-catch
code = code.replace(
  /require\('\.\/update-handlers'\)\(\{[^}]*\}\)/g,
  `(() => { try { return require('./update-handlers')({ sendToFigma, WebSocket }); } catch(_) { return { checkAndNotifyUpdates(){}, handlePluginUpdate(){}, handleServerUpdate(){}, handleFullUpdate(){} }; } })()`
);

// 将 require('./update-manager') 调用包裹在 try-catch
code = code.replace(
  /require\('\.\/update-manager'\)/g,
  `(() => { try { return require('./update-manager'); } catch(_) { return { checkForUpdates: async ()=>({}) }; } })()`
);

fs.writeFileSync(serverPath, code, 'utf8');
console.log('   ✅ server.js 已补丁');
PATCH_SERVER

# ========================================
# 步骤 6：补丁 start.js — 移除 drive-watcher 和 aliyun-watcher 引用
# ========================================
echo -e "${YELLOW}🔧 补丁 start.js...${NC}"
node - "$PROJECT_DIR/start.js" <<'PATCH_START'
const fs = require('fs');
const startPath = process.argv[2];
let code = fs.readFileSync(startPath, 'utf8');

// 默认同步模式改为 icloud
code = code.replace(
  "let SYNC_MODE = process.env.SYNC_MODE || 'drive';",
  "let SYNC_MODE = process.env.SYNC_MODE || 'icloud';"
);

fs.writeFileSync(startPath, code, 'utf8');
console.log('   ✅ start.js 已补丁');
PATCH_START

# ========================================
# 步骤 7：补丁 ui.html — 移除 update-banner + 模式切换
# ========================================
echo -e "${YELLOW}🔧 补丁 ui.html...${NC}"
node - "$PROJECT_DIR/figma-plugin/ui.html" <<'PATCH_UI'
const fs = require('fs');
const uiPath = process.argv[2];
let html = fs.readFileSync(uiPath, 'utf8');

// 7a. 移除 update-banner HTML 块（用简单的标记定位）
const bannerStart = html.indexOf('<!-- Update Banner -->');
const bannerEnd = html.indexOf('<!-- Minimized Toolbar');
if (bannerStart !== -1 && bannerEnd !== -1) {
  html = html.substring(0, bannerStart) + '<!-- Update Banner removed for iCloud build -->\n    \n    ' + html.substring(bannerEnd);
}

// 7b. 隐藏模式切换按钮区域：在 settings 中把 switch-sync-mode 的按钮区域设为 display:none
// 找到 Google Drive 模式开关变量并设为 false
html = html.replace(
  /\/\/ Google Drive 模式开关（默认启用）/,
  '// Google Drive 模式开关（iCloud 定制版禁用）'
);
html = html.replace(
  /const ENABLE_GOOGLE_DRIVE = true;/,
  'const ENABLE_GOOGLE_DRIVE = false;'
);

// 7c. 移除 check-update wsSend 调用
html = html.replace(
  /wsSend\('check-update'[^)]*\);/g,
  '/* check-update disabled for iCloud build */'
);

// 7d. 移除 showUpdateBanner 调用
html = html.replace(
  /showUpdateBanner\([^)]*\);/g,
  '/* update banner disabled */'
);

// 7e. 移除 update-full wsSend（可能在 if 条件中）
html = html.replace(
  /wsSend\('update-full'[^)]*\)/g,
  '(false /* update disabled for iCloud build */)'
);

// 7f. 隐藏模式切换和更新相关 UI（通过注入 CSS）
const modeHideCSS = `
    /* iCloud 定制版：隐藏模式切换和更新相关 UI */
    #modeSwitchSection, #switchToDrive, #switchToAliyun, .update-banner { display: none !important; }
`;

// 在第一个 </style> 前注入
html = html.replace('</style>', modeHideCSS + '\n    </style>');

fs.writeFileSync(uiPath, html, 'utf8');
console.log('   ✅ ui.html 已补丁');
PATCH_UI

# ========================================
# 步骤 8：补丁 installer/renderer.js — 跳过模式选择，写死 iCloud
# ========================================
echo -e "${YELLOW}🔧 补丁 installer/renderer.js...${NC}"

# 复制 installer 到打包目录
mkdir -p "$PROJECT_DIR/installer"
rsync -a --exclude '.DS_Store' --exclude 'node_modules/' --exclude 'dist/' \
    --exclude '.sync-mode' --exclude '.user-config.json' \
    "installer/" "$PROJECT_DIR/installer/"

node - "$PROJECT_DIR/installer/renderer.js" <<'PATCH_RENDERER'
const fs = require('fs');
const rendererPath = process.argv[2];
let code = fs.readFileSync(rendererPath, 'utf8');

// 将默认模式改为 icloud
code = code.replace(
  /let selectedMode = 'drive';/,
  `let selectedMode = 'icloud';`
);

// 在 showStep 函数中，跳过 step 1（封面/模式选择页），直接从 step 2 开始
// 把 currentStep 初始值改为 2
code = code.replace(
  /let currentStep = 1;/,
  `let currentStep = 2;`
);

// 修改页面初始化：直接显示 step 2
code = code.replace(
  /showStep\(1\)/g,
  `showStep(2)`
);

fs.writeFileSync(rendererPath, code, 'utf8');
console.log('   ✅ installer/renderer.js 已补丁');
PATCH_RENDERER

# 同时补丁 installer/main.js — 强制 iCloud 模式
node - "$PROJECT_DIR/installer/main.js" <<'PATCH_MAIN'
const fs = require('fs');
const mainPath = process.argv[2];
let code = fs.readFileSync(mainPath, 'utf8');

// 在 setup-config handler 函数体开头插入 syncMode 覆盖
code = code.replace(
  "ipcMain.handle('setup-config', async (event, installPath, syncMode, localFolder) => {\n  return new Promise((resolve) => {\n    try {",
  "ipcMain.handle('setup-config', async (event, installPath, _syncMode, localFolder) => {\n  const syncMode = 'icloud'; // forced for iCloud build\n  return new Promise((resolve) => {\n    try {"
);

fs.writeFileSync(mainPath, code, 'utf8');
console.log('   ✅ installer/main.js 已补丁');
PATCH_MAIN

# 补丁 installer/index.html — 隐藏 step1（模式选择页）
node - "$PROJECT_DIR/installer/index.html" <<'PATCH_INDEX'
const fs = require('fs');
const indexPath = process.argv[2];
let html = fs.readFileSync(indexPath, 'utf8');

// 隐藏 step1（模式选择页）
html = html.replace(
  /class="step active" id="step1"/,
  `class="step" id="step1" style="display:none"`
);

// 让 step2 成为初始 active 页
html = html.replace(
  /class="step" id="step2"/,
  `class="step active" id="step2"`
);

// 隐藏 header 中的第一个 dot（对应 step1）
// 通过 CSS 注入
const hideStep1CSS = `
    <style>
      /* iCloud build: hide mode selection step */
      .dot:first-child { display: none !important; }
    </style>
`;
html = html.replace('</head>', hideStep1CSS + '\n  </head>');

fs.writeFileSync(indexPath, html, 'utf8');
console.log('   ✅ installer/index.html 已补丁');
PATCH_INDEX

# ========================================
# 步骤 9：创建 .gitignore
# ========================================
cat > "$PROJECT_DIR/.gitignore" << 'EOF'
node_modules/
package-lock.json
.env
.env.local
.user-config.json
.sync-mode
*.log
.DS_Store
.gif-cache/
EOF

# ========================================
# 步骤 10：创建 README
# ========================================
cat > "$TEMP_DIR/README_请先阅读.txt" << 'EOF'
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync 安装指南 (iCloud 定制版)              ║
║                                                        ║
╚════════════════════════════════════════════════════════╝

⚠️ 重要提示
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

此版本使用 iCloud 进行文件同步，无需 Google Drive 账号。
请确保您的 Mac 已登录 iCloud 且有足够的存储空间。


📦 安装步骤（全程无需打开终端）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

步骤 1：打开安装器
   1. 双击 "双击安装.dmg"
   2. 在弹出的窗口中双击 "ScreenSync Installer" 图标
   3. 如果被拦截：系统设置 → 隐私与安全性 → 仍要打开

步骤 2：跟随安装向导
   安装器会自动完成所有配置，包括：
   - 环境依赖安装（Node.js、FFmpeg 等）
   - iCloud 文件夹配置
   - 开机自启动设置

步骤 3：导入 Figma 插件
   1. 打开 Figma Desktop 应用
   2. 菜单：Plugins → Development → Import plugin from manifest
   3. 选择：项目文件/figma-plugin/manifest.json

步骤 4：开始使用
   1. 在 Figma 中运行 "ScreenSync" 插件
   2. 在 iPhone 上保存截图/录屏到 iCloud
   3. 文件自动同步到 Figma（录屏自动转为 GIF）

EOF

# ========================================
# 步骤 11：生成 update-manifest.json
# ========================================
echo -e "${YELLOW}🧾 生成 update-manifest.json...${NC}"
node - "$PROJECT_DIR" <<'MANIFEST'
const fs = require('fs');
const path = require('path');
const base = process.argv[2];
const files = [];

function walk(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name === '.DS_Store') continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'dist') continue;
      walk(full);
      continue;
    }
    if (!item.isFile()) continue;
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (!rel) continue;
    files.push(rel);
  }
}

walk(base);
files.sort();
if (!files.includes('update-manifest.json')) files.push('update-manifest.json');
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  variant: 'icloud',
  files
};
fs.writeFileSync(path.join(base, 'update-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
MANIFEST
echo "   ✅ update-manifest.json 已生成"

# ========================================
# 步骤 12：创建双架构安装包
# ========================================
create_icloud_package() {
    local ARCH_TYPE="$1"
    local DMG_PATH="$2"
    local PKG_SUFFIX="$3"
    local PKG_NAME="${PACKAGE_NAME}"
    local PKG_DIR="/tmp/${PKG_NAME}_${PKG_SUFFIX}"

    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}📦 创建 ${ARCH_TYPE} 版本 iCloud 安装包...${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"

    rm -rf "$PKG_DIR"
    mkdir -p "$PKG_DIR"

    # 复制项目文件
    cp -R "$PROJECT_DIR" "$PKG_DIR/项目文件"

    # 复制安装器 DMG
    cp "$DMG_PATH" "$PKG_DIR/双击安装.dmg"
    echo "   ✅ 已复制 ${ARCH_TYPE} 安装器"

    # 复制 README
    cp "$TEMP_DIR/README_请先阅读.txt" "$PKG_DIR/"

    # 打包
    local ARCHIVE_NAME="${PKG_NAME}-${PKG_SUFFIX}.tar.gz"
    cd /tmp
    tar -czf "${ARCHIVE_NAME}" "$(basename "$PKG_DIR")/"
    cd "$SCRIPT_DIR"
    mv "/tmp/${ARCHIVE_NAME}" "./${ARCHIVE_NAME}"
    rm -rf "$PKG_DIR"

    local PKG_SIZE
    PKG_SIZE=$(du -h "${ARCHIVE_NAME}" | cut -f1)
    echo -e "${GREEN}✅ ${ARCH_TYPE} iCloud 版本: ${ARCHIVE_NAME} (${PKG_SIZE})${NC}"
}

echo -e "\n${GREEN}📦 开始打包 iCloud 定制版...${NC}"

create_icloud_package "Intel" "$DMG_INTEL" "Intel"
create_icloud_package "Apple" "$DMG_ARM" "Apple"

# 清理
rm -rf "$TEMP_DIR"

# ========================================
# 完成
# ========================================
echo -e "\n${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           iCloud 定制版打包全部完成！                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}\n"

INTEL_SIZE=$(du -h "ScreenSync_iCloud-Intel.tar.gz" 2>/dev/null | cut -f1)
APPLE_SIZE=$(du -h "ScreenSync_iCloud-Apple.tar.gz" 2>/dev/null | cut -f1)

echo -e "${BLUE}📦 生成的安装包：${NC}"
echo -e "   ${GREEN}✅ ScreenSync_iCloud-Intel.tar.gz${NC} (${INTEL_SIZE}) - Intel 芯片 Mac"
echo -e "   ${GREEN}✅ ScreenSync_iCloud-Apple.tar.gz${NC} (${APPLE_SIZE}) - Apple 芯片 Mac (M1/M2/M3/M4)"
echo ""
echo -e "${YELLOW}📋 说明：${NC}"
echo -e "   - 此版本使用 iCloud 同步，无需 Google Drive"
echo -e "   - 不包含自动更新功能"
echo -e "   - 录屏会自动转换为 GIF"
echo -e "   - 安装器会跳过模式选择，直接使用 iCloud"
echo ""
