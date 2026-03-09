#!/bin/bash

# ScreenSync 用户分发打包脚本（双架构版本）
# 此脚本会打包两个独立的安装包：Intel 版和 Apple Silicon 版

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ScreenSync 用户分发打包脚本          ║${NC}"
echo -e "${BLUE}║  (双架构独立打包版本)                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

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
    local max_major="$2" # e.g. 13
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
        # 某些二进制可能不含 minos 字段，保守起见直接失败，避免发布不兼容包
        echo -e "${RED}❌ 无法解析最小系统版本: $bin_path${NC}"
        echo -e "${YELLOW}   请替换为明确支持 macOS ${max_major} 的二进制。${NC}"
        exit 1
    fi

    minos="$line"
    major="${minos%%.*}"
    if [ -z "$major" ]; then
        echo -e "${RED}❌ 无法解析最小系统版本: $bin_path (minos=$minos)${NC}"
        exit 1
    fi
    if [ "$major" -gt "$max_major" ]; then
        echo -e "${RED}❌ 最小系统版本不兼容: $bin_path${NC}"
        echo -e "${YELLOW}   期望支持 ≤ macOS ${max_major}.x，实际 minos=${minos}${NC}"
        exit 1
    fi
}

resolve_runtime_source() {
    local arch="$1" # intel / apple
    local candidates=()
    if [ "$arch" = "intel" ]; then
        candidates+=(
            "./runtime/intel"
            "./runtime/x64"
            "./offline-runtime/intel"
            "./offline-runtime/x64"
        )
    else
        candidates+=(
            "./runtime/apple"
            "./runtime/arm64"
            "./offline-runtime/apple"
            "./offline-runtime/arm64"
        )
    fi

    for d in "${candidates[@]}"; do
        if [ -d "$d" ] && [ -d "$d/bin" ]; then
            echo "$d"
            return 0
        fi
    done
    return 1
}

# 构建 Electron 安装器 (双架构 DMG)
echo -e "${YELLOW}🔨 正在构建最新版 GUI 安装器 (Electron)...${NC}"
cd installer

# 确保依赖已安装
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 安装 Electron 依赖...${NC}"
    npm install
fi

# 清理旧构建
rm -rf dist

echo -e "   ${YELLOW}构建双架构 DMG...${NC}"
npm run build:mac

# 定位构建产物（dist 已清空重建，按文件名后缀识别架构）
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
    echo -e "${RED}❌ 错误：需要同时存在 Intel 和 Apple Silicon 版本的 DMG${NC}"
    echo -e "   Intel DMG: ${DMG_INTEL:-未找到}"
    echo -e "   ARM DMG: ${DMG_ARM:-未找到}"
    exit 1
fi

cd ..

echo -e "${GREEN}✅ Intel DMG: installer/$DMG_INTEL${NC}"
echo -e "${GREEN}✅ Apple Silicon DMG: installer/$DMG_ARM${NC}\n"

# 从这里开始引用相对路径前缀
DMG_INTEL="installer/$DMG_INTEL"
DMG_ARM="installer/$DMG_ARM"

# 获取当前目录名和版本号
CURRENT_DIR=$(basename "$PWD")
VERSION=$(date +"%Y%m%d")

# 清理不应打包的文件（日志、临时文件等）
echo -e "${YELLOW}🧹 清理临时文件和日志...${NC}"
rm -f *.log 2>/dev/null || true
rm -f server-error.log 2>/dev/null || true
rm -f .user-config.json 2>/dev/null || true
rm -f .sync-mode 2>/dev/null || true
echo "   ✅ 清理完成"

# ========================================
# 函数：创建单架构安装包
# 参数: $1 = 架构类型 (Intel/Apple), $2 = DMG 路径, $3 = 包名
# ========================================
create_package() {
    local ARCH_TYPE="$1"
    local DMG_PATH="$2"
    local PACKAGE_NAME="$3"
    local ARCH_KEY="$4"
    local TEMP_DIR="/tmp/${PACKAGE_NAME}"
    
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}📦 正在创建 ${ARCH_TYPE} 版本安装包...${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
    
    # 清理临时目录
    if [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
    mkdir -p "$TEMP_DIR"
    mkdir -p "$TEMP_DIR/项目文件"
    mkdir -p "$TEMP_DIR/runtime"
    
    # 1. 复制核心服务器文件
    echo -e "${YELLOW}📄 复制核心服务器文件...${NC}"
    cp server.js "$TEMP_DIR/项目文件/"
    cp googleDrive.js "$TEMP_DIR/项目文件/"
    cp userConfig.js "$TEMP_DIR/项目文件/"
    cp serviceAccountKey.js "$TEMP_DIR/项目文件/" 2>/dev/null || true
    cp start.js "$TEMP_DIR/项目文件/"
    cp setup-autostart.js "$TEMP_DIR/项目文件/"
    cp update-manager.js "$TEMP_DIR/项目文件/"
    cp update-handlers.js "$TEMP_DIR/项目文件/"
    cp gif-composer.js "$TEMP_DIR/项目文件/"
    cp image-processor.js "$TEMP_DIR/项目文件/"
    cp adaptive-processing.js "$TEMP_DIR/项目文件/"
    cp drive-watcher.js "$TEMP_DIR/项目文件/"
    cp icloud-watcher.js "$TEMP_DIR/项目文件/" 2>/dev/null || true
    cp media-processing-tuning.js "$TEMP_DIR/项目文件/" 2>/dev/null || true
    cp com.screensync.server.plist "$TEMP_DIR/项目文件/" 2>/dev/null || true
    
  # 2. 复制配置文件
  echo -e "${YELLOW}⚙️  复制配置文件...${NC}"
  cp package.json "$TEMP_DIR/项目文件/"
  cp package-lock.json "$TEMP_DIR/项目文件/"
  cp README.md "$TEMP_DIR/项目文件/"
  cp MANUAL_INSTALL_LEGACY.md "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  MANUAL_INSTALL_LEGACY.md not found (optional)"

    # 2.1 复制预置 node_modules（胖包核心）
    echo -e "${YELLOW}📦 复制预置 node_modules...${NC}"
    if [ ! -d "node_modules" ]; then
        echo -e "${RED}❌ 未找到 node_modules，无法构建离线胖包${NC}"
        echo -e "${YELLOW}请先在项目根目录执行: npm install${NC}"
        exit 1
    fi
    rsync -a \
      --exclude '.cache/' \
      --exclude '*.log' \
      "node_modules/" "$TEMP_DIR/项目文件/node_modules/"
    if command -v npm >/dev/null 2>&1; then
        echo "   🧹 校验预置 node_modules，仅保留 package.json 中声明的生产依赖..."
        npm prune --omit=dev --prefix "$TEMP_DIR/项目文件" >/dev/null 2>&1 || \
          echo "   ⚠️  npm prune 失败，继续使用当前 node_modules 副本"
    fi

    # 2.2 复制离线运行时 runtime（按架构）
    echo -e "${YELLOW}🧰 复制离线 runtime (${ARCH_TYPE})...${NC}"
    local runtime_src
    runtime_src="$(resolve_runtime_source "$ARCH_KEY" || true)"
    if [ -z "$runtime_src" ]; then
        echo -e "${RED}❌ 未找到 ${ARCH_TYPE} 对应 runtime 目录${NC}"
        echo -e "${YELLOW}请准备以下任一目录（含 bin 子目录）:${NC}"
        if [ "$ARCH_KEY" = "intel" ]; then
            echo -e "${YELLOW}  ./runtime/intel  或 ./runtime/x64  或 ./offline-runtime/intel  或 ./offline-runtime/x64${NC}"
        else
            echo -e "${YELLOW}  ./runtime/apple  或 ./runtime/arm64 或 ./offline-runtime/apple  或 ./offline-runtime/arm64${NC}"
        fi
        exit 1
    fi
    rsync -a "$runtime_src/" "$TEMP_DIR/runtime/"
    # 仅保留当前安装包所需 runtime，避免误带另一架构目录
    rm -rf "$TEMP_DIR/runtime/apple" "$TEMP_DIR/runtime/arm64" \
           "$TEMP_DIR/runtime/intel" "$TEMP_DIR/runtime/x64" 2>/dev/null || true

    if [ "$ARCH_KEY" = "intel" ]; then
        if [ -d "$TEMP_DIR/runtime/apple" ] || [ -d "$TEMP_DIR/runtime/arm64" ]; then
            echo -e "${RED}❌ Intel 安装包包含了 Apple runtime 目录，已中止${NC}"
            exit 1
        fi
    else
        if [ -d "$TEMP_DIR/runtime/intel" ] || [ -d "$TEMP_DIR/runtime/x64" ]; then
            echo -e "${RED}❌ Apple 安装包包含了 Intel runtime 目录，已中止${NC}"
            exit 1
        fi
    fi

    require_file "$TEMP_DIR/runtime/bin/node" "runtime/bin/node 必须存在"
    require_file "$TEMP_DIR/runtime/bin/ffmpeg" "runtime/bin/ffmpeg 必须存在"
    require_file "$TEMP_DIR/runtime/bin/ffprobe" "runtime/bin/ffprobe 必须存在"
    require_file "$TEMP_DIR/runtime/bin/gifsicle" "runtime/bin/gifsicle 必须存在"
    if [ ! -f "$TEMP_DIR/runtime/bin/magick" ] && [ ! -f "$TEMP_DIR/runtime/bin/convert" ]; then
        echo -e "${RED}❌ runtime/bin 下缺少 magick/convert${NC}"
        exit 1
    fi
    local expected_bin_arch="arm64"
    if [ "$ARCH_KEY" = "intel" ]; then
        expected_bin_arch="x86_64"
    fi
    require_runtime_arch "$TEMP_DIR/runtime/bin/node" "$expected_bin_arch"
    require_runtime_arch "$TEMP_DIR/runtime/bin/ffmpeg" "$expected_bin_arch"
    require_runtime_arch "$TEMP_DIR/runtime/bin/ffprobe" "$expected_bin_arch"
    require_runtime_arch "$TEMP_DIR/runtime/bin/gifsicle" "$expected_bin_arch"
    if [ -f "$TEMP_DIR/runtime/bin/magick" ]; then
        require_runtime_arch "$TEMP_DIR/runtime/bin/magick" "$expected_bin_arch"
    else
        require_runtime_arch "$TEMP_DIR/runtime/bin/convert" "$expected_bin_arch"
    fi
    # 强约束：胖包依赖必须可在 macOS 13 使用，避免低版本用户导出失败
    require_runtime_max_macos "$TEMP_DIR/runtime/bin/node" 13
    require_runtime_max_macos "$TEMP_DIR/runtime/bin/ffmpeg" 13
    require_runtime_max_macos "$TEMP_DIR/runtime/bin/ffprobe" 13
    require_runtime_max_macos "$TEMP_DIR/runtime/bin/gifsicle" 13
    if [ -f "$TEMP_DIR/runtime/bin/magick" ]; then
        require_runtime_max_macos "$TEMP_DIR/runtime/bin/magick" 13
    else
        require_runtime_max_macos "$TEMP_DIR/runtime/bin/convert" 13
    fi

    # 3. 复制对应架构的 DMG (不再需要 .command 脚本, 安装器内部自动清除隔离)
    echo -e "${YELLOW}🖥️  复制 ${ARCH_TYPE} 安装器...${NC}"
    cp "$DMG_PATH" "$TEMP_DIR/双击安装.dmg"
    echo "   ✅ 已复制安装器 DMG"
    
    # 5. 复制 Figma 插件文件（整目录同步，避免遗漏新资源）
    echo -e "${YELLOW}🎨 复制 Figma 插件文件（完整目录）...${NC}"
    mkdir -p "$TEMP_DIR/项目文件/figma-plugin"
    rsync -a \
      --exclude '.DS_Store' \
      --exclude '*.map' \
      --exclude 'node_modules/' \
      "figma-plugin/" "$TEMP_DIR/项目文件/figma-plugin/"
    
    # 6. 复制 images 文件夹（logo 和 QR 码）
    if [ -d "images" ]; then
        echo -e "${YELLOW}🖼️  复制图片资源...${NC}"
        cp -r images "$TEMP_DIR/项目文件/"
    fi
    
    # 6. 创建 .gitignore
    echo -e "${YELLOW}📝 创建 .gitignore...${NC}"
    cat > "$TEMP_DIR/项目文件/.gitignore" << 'EOF'
node_modules/
package-lock.json
.env
.env.local
.user-config.json
.sync-mode
*.log
npm-debug.log*
.DS_Store
Thumbs.db
.vscode/
.idea/
*.swp
*.swo
*.tmp
*.temp
../ScreenSyncImg/
EOF
    
    # 7. 创建 README（全新无终端版本）
    echo -e "${YELLOW}📖 创建说明文档...${NC}"
    cat > "$TEMP_DIR/README_请先阅读.txt" << EOF
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync 安装指南 (${ARCH_TYPE} 版本)              ║
║                                                        ║
╚════════════════════════════════════════════════════════╝

⚠️ 重要提示
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

此安装包适用于 ${ARCH_TYPE} 芯片的 Mac 电脑。

💡 如何确认您的 Mac 芯片类型？
   点击左上角  → 关于本机 → 查看处理器信息
   - 如果显示 "Intel"，请使用 ScreenSync-Intel.tar.gz
   - 如果显示 "Apple M1/M2/M3"，请使用 ScreenSync-Apple.tar.gz


📦 安装步骤（全程无需打开终端）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

步骤 1：打开安装器
   1. 双击 "双击安装.dmg"
   2. 在弹出的窗口中双击 "ScreenSync Installer" 图标
   3. 如果被拦截：系统设置 → 隐私与安全性 → 仍要打开

步骤 2：跟随安装向导
   安装器会自动完成所有配置，包括：
   - 离线运行时校验（Node.js、ImageMagick、FFmpeg、Gifsicle 已内置）
   - 项目配置
   - 开机自启动设置

步骤 3：导入 Figma 插件
   1. 打开 Figma Desktop 应用
   2. 菜单：Plugins → Development → Import plugin from manifest
   3. 选择：项目文件/figma-plugin/manifest.json
   4. 点击确认完成导入

步骤 4：开始使用
   1. 在 Figma 中运行 "ScreenSync" 插件
   2. 按照提示在 iPhone 上配置快捷指令
   3. 开始截图，自动同步到 Figma！


🆘 遇到问题？
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Q: 提示 "无法验证开发者" 或被拦截怎么办？
A: 前往 系统设置 → 隐私与安全性 → 找到被拦截的提示
   → 点击"仍要打开" → 输入密码确认即可。
   （首次打开需要此操作，之后不再需要）

更多帮助请联系作者或查看项目文档。
EOF

    # 8. 创建使用说明
    cat > "$TEMP_DIR/项目文件/使用说明.txt" << 'EOF'
ScreenSync - iPhone截图自动同步到Figma

═══════════════════════════════════════════════════════

📦 安装步骤（全程无需打开终端）

步骤 1：运行安装器
1. 双击 "双击安装.dmg"
2. 在弹出的窗口中双击 "ScreenSync Installer"
3. 如果被拦截：系统设置 → 隐私与安全性 → 仍要打开
4. 跟随安装向导完成所有配置

步骤 2：导入 Figma 插件
1. 打开 Figma Desktop 应用
2. 菜单：Plugins → Development → Import plugin from manifest
3. 浏览并选择：{安装目录}/figma-plugin/manifest.json
4. 点击确认完成导入

步骤 3：开始使用
1. 在 Figma 中运行 "ScreenSync" 插件
2. 选择同步模式
3. 在 iPhone 上按照提示配置快捷指令
4. 开始截图，自动同步到 Figma！

═══════════════════════════════════════════════════════

🔄 自动更新

插件支持自动更新功能：
1. 打开 Figma 插件时会自动检查更新
2. 如有新版本，顶部会显示更新通知
3. 点击"立即更新"按钮，等待更新完成
4. 关闭并重新打开插件即可使用新版本

EOF

    # 9. 复制版本信息（使用源目录的 VERSION.txt 保持版本一致）
    if [ -f "VERSION.txt" ]; then
        cp VERSION.txt "$TEMP_DIR/项目文件/"
        echo "   ✅ 已复制 VERSION.txt"
    else
        # 如果没有 VERSION.txt，创建一个
        cat > "$TEMP_DIR/项目文件/VERSION.txt" << EOF
ScreenSync 服务器版本
版本: ${NEW_VERSION:-1.0.0}
更新日期: $(date +"%Y-%m-%d")

更新说明:
- 支持 Google Cloud、iCloud 两种储存方式
- 支持插件和服务器自动更新
EOF
        echo "   ✅ 已创建 VERSION.txt"
    fi

    # 10. 生成更新清单（用于全量更新精确同步，避免遗漏/多余）
    echo -e "${YELLOW}🧾 生成 update-manifest.json...${NC}"
    node - "$TEMP_DIR/项目文件" <<'EOF'
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
      if (item.name === 'node_modules') continue;
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
if (!files.includes('update-manifest.json')) {
  files.push('update-manifest.json');
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  files
};
fs.writeFileSync(path.join(base, 'update-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
EOF

    # 11. 打包
    echo -e "${GREEN}📦 创建压缩包...${NC}"
    cd /tmp
    tar -czf "${PACKAGE_NAME}.tar.gz" "${PACKAGE_NAME}/"
    cd - > /dev/null
    
    # 12. 移动到当前目录
    mv "/tmp/${PACKAGE_NAME}.tar.gz" "./${PACKAGE_NAME}.tar.gz"
    
    # 13. 清理临时目录
    rm -rf "$TEMP_DIR"
    
    # 显示结果
    local PACKAGE_SIZE=$(du -h "${PACKAGE_NAME}.tar.gz" | cut -f1)
    echo -e "${GREEN}✅ ${ARCH_TYPE} 版本打包完成: ${PACKAGE_NAME}.tar.gz (${PACKAGE_SIZE})${NC}"
}

# ========================================
# 主流程：创建两个独立的安装包
# ========================================

echo -e "${GREEN}📦 开始打包...${NC}"

# 创建 Intel 版本
create_package "Intel" "$DMG_INTEL" "ScreenSync-Intel" "intel"

# 创建 Apple Silicon 版本
create_package "Apple" "$DMG_ARM" "ScreenSync-Apple" "apple"

# 显示最终结果
echo -e "\n${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    打包全部完成！                      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}\n"

INTEL_SIZE=$(du -h "ScreenSync-Intel.tar.gz" | cut -f1)
APPLE_SIZE=$(du -h "ScreenSync-Apple.tar.gz" | cut -f1)

echo -e "${BLUE}📦 生成的安装包：${NC}"
echo -e "   ${GREEN}✅ ScreenSync-Intel.tar.gz${NC} (${INTEL_SIZE}) - Intel 芯片 Mac"
echo -e "   ${GREEN}✅ ScreenSync-Apple.tar.gz${NC} (${APPLE_SIZE}) - Apple 芯片 Mac (M1/M2/M3)"
echo ""
echo -e "${YELLOW}📋 发布说明：${NC}"
echo -e "   - Intel 芯片用户下载 ScreenSync-Intel.tar.gz"
echo -e "   - Apple 芯片用户下载 ScreenSync-Apple.tar.gz"
echo -e "   - 用户可通过  → 关于本机 查看芯片类型"
echo ""
