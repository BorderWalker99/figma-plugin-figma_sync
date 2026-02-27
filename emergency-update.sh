#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ScreenSync 一键修复更新脚本
# 适用于无法自动更新的老版本用户（如还在使用 UserPackage 的旧版本）
#
# 使用方法：
#   1. 将此脚本放到 ScreenSync 项目根目录（server.js 所在目录）
#   2. 打开终端，cd 到该目录
#   3. 运行: chmod +x emergency-update.sh && ./emergency-update.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -e

REPO="BorderWalker99/figma-plugin-figma_sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/.emergency-backup-$(date +%Y%m%d%H%M%S)"
TEMP_DIR="$(mktemp -d)"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

cleanup() {
  rm -rf "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}       ScreenSync 一键修复更新脚本${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# ─── 1. 验证当前目录 ─────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/server.js" ] && [ ! -f "$SCRIPT_DIR/start.js" ]; then
  echo -e "${RED}❌ 错误：请将此脚本放到 ScreenSync 项目根目录（server.js 所在目录）后运行${NC}"
  echo "   当前目录: $SCRIPT_DIR"
  exit 1
fi
echo -e "${GREEN}✅ 项目目录确认: $SCRIPT_DIR${NC}"

# ─── 2. 停止正在运行的服务器 ──────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔄 正在停止现有服务器进程...${NC}"
# 先卸载 launchd 服务
PLIST_PATH="$HOME/Library/LaunchAgents/com.screensync.server.plist"
if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi
pkill -f "node.*server\.js" 2>/dev/null || true
pkill -f "node.*start\.js" 2>/dev/null || true
sleep 1
echo -e "${GREEN}✅ 服务器进程已停止${NC}"

# ─── 3. 检测系统架构 ─────────────────────────────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  ASSET_NAME="ScreenSync-Apple.tar.gz"
  ARCH_LABEL="Apple Silicon (M系列芯片)"
  NEW_PACKAGE_NAME="ScreenSync-Apple"
else
  ASSET_NAME="ScreenSync-Intel.tar.gz"
  ARCH_LABEL="Intel"
  NEW_PACKAGE_NAME="ScreenSync-Intel"
fi
echo ""
echo -e "${GREEN}✅ 系统架构: ${ARCH_LABEL} → 将下载 ${ASSET_NAME}${NC}"

# ─── 4. 获取最新 Release 信息 ────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔍 正在获取最新版本信息...${NC}"

RELEASE_JSON="$TEMP_DIR/release.json"
HTTP_CODE=$(curl -sL -w "%{http_code}" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "User-Agent: ScreenSync-EmergencyUpdate" \
  --connect-timeout 15 --max-time 30 \
  "https://api.github.com/repos/$REPO/releases/latest" \
  -o "$RELEASE_JSON")

if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${RED}❌ 无法获取版本信息 (HTTP $HTTP_CODE)${NC}"
  echo "   请检查网络连接，或尝试使用代理"
  exit 1
fi

LATEST_TAG=$(python3 -c "import json; d=json.load(open('$RELEASE_JSON')); print(d['tag_name'])")
echo -e "${GREEN}✅ 最新版本: ${LATEST_TAG}${NC}"

# 查找对应架构的下载链接
DOWNLOAD_URL=$(python3 -c "
import json
d = json.load(open('$RELEASE_JSON'))
for a in d.get('assets', []):
    if '$ASSET_NAME' in a['name']:
        print(a['browser_download_url'])
        break
")

if [ -z "$DOWNLOAD_URL" ]; then
  echo -e "${RED}❌ 未找到 ${ASSET_NAME}，可用的 Assets:${NC}"
  python3 -c "import json; d=json.load(open('$RELEASE_JSON')); [print('   •', a['name']) for a in d.get('assets', [])]"
  exit 1
fi

echo -e "${GREEN}✅ 下载地址已获取${NC}"

# ─── 5. 下载更新包 ───────────────────────────────────────────────────────────
TAR_FILE="$TEMP_DIR/$ASSET_NAME"
echo ""
echo -e "${YELLOW}📥 正在下载 ${ASSET_NAME}...${NC}"

MAX_RETRIES=3
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
  if curl -L --progress-bar \
    -H "User-Agent: ScreenSync-EmergencyUpdate" \
    --connect-timeout 30 --max-time 300 \
    -o "$TAR_FILE" "$DOWNLOAD_URL"; then
    break
  fi
  RETRY=$((RETRY + 1))
  if [ $RETRY -lt $MAX_RETRIES ]; then
    echo -e "${YELLOW}   ⚠️  下载失败，${RETRY}/${MAX_RETRIES} 次重试...${NC}"
    sleep 2
  fi
done

if [ ! -f "$TAR_FILE" ] || [ ! -s "$TAR_FILE" ]; then
  echo -e "${RED}❌ 下载失败，请检查网络${NC}"
  exit 1
fi

FILE_SIZE=$(ls -lh "$TAR_FILE" | awk '{print $5}')
echo -e "${GREEN}✅ 下载完成 (${FILE_SIZE})${NC}"

# ─── 6. 解压 ─────────────────────────────────────────────────────────────────
EXTRACT_DIR="$TEMP_DIR/extracted"
mkdir -p "$EXTRACT_DIR"
echo ""
echo -e "${YELLOW}📦 正在解压...${NC}"
tar -xzf "$TAR_FILE" -C "$EXTRACT_DIR"

# 查找解压后的项目根目录（包含 server.js 的目录）
SOURCE_DIR=""
for dir_name in "ScreenSync-Apple" "ScreenSync-Intel"; do
  # 新包结构: ScreenSync-Apple/项目文件/server.js
  if [ -f "$EXTRACT_DIR/$dir_name/项目文件/server.js" ]; then
    SOURCE_DIR="$EXTRACT_DIR/$dir_name/项目文件"
    SOURCE_PACKAGE_DIR="$EXTRACT_DIR/$dir_name"
    break
  fi
  # 也兼容平铺结构: ScreenSync-Apple/server.js
  if [ -f "$EXTRACT_DIR/$dir_name/server.js" ]; then
    SOURCE_DIR="$EXTRACT_DIR/$dir_name"
    SOURCE_PACKAGE_DIR="$EXTRACT_DIR/$dir_name"
    break
  fi
done

if [ -z "$SOURCE_DIR" ]; then
  SOURCE_DIR=$(find "$EXTRACT_DIR" -name "server.js" -maxdepth 4 -exec dirname {} \; | head -1)
  if [ -n "$SOURCE_DIR" ]; then
    SOURCE_PACKAGE_DIR=$(dirname "$SOURCE_DIR")
    # 如果 server.js 直接在解压根目录
    if [ "$SOURCE_PACKAGE_DIR" = "$EXTRACT_DIR" ]; then
      SOURCE_PACKAGE_DIR="$SOURCE_DIR"
    fi
  fi
fi

if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/server.js" ]; then
  echo -e "${RED}❌ 解压后未找到 server.js，请联系开发者${NC}"
  echo "   解压目录内容:"
  ls -la "$EXTRACT_DIR"
  exit 1
fi

echo -e "${GREEN}✅ 解压完成${NC}"

# ─── 7. 备份现有文件 ──────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}💾 正在备份现有文件...${NC}"
mkdir -p "$BACKUP_DIR"

# 备份整个项目目录（排除 node_modules 和缓存）
rsync -a --exclude 'node_modules' --exclude '.gif-cache' \
  --exclude 'ScreenSyncImg' --exclude '.emergency-backup-*' \
  "$SCRIPT_DIR/" "$BACKUP_DIR/" 2>/dev/null || true

OLD_VERSION="未知"
if [ -f "$BACKUP_DIR/VERSION.txt" ]; then
  OLD_VERSION=$(cat "$BACKUP_DIR/VERSION.txt" | tr -d '[:space:]')
fi

echo -e "${GREEN}✅ 备份完成 → ${BACKUP_DIR}${NC}"

# ─── 8. 清理老旧文件 ─────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🧹 正在清理老旧文件...${NC}"

CLEANED=0

# 8a. 清理项目目录内不再需要的老代码文件
OLD_FILES=(
  "第一步_拖进终端回车运行.command"
  "Developer_清除隔离.command"
  "package-icloud.sh"
  "set-version.sh"
  "aliyunOSS.js"
  "aliyun-watcher.js"
)
for old_file in "${OLD_FILES[@]}"; do
  if [ -f "$SCRIPT_DIR/$old_file" ]; then
    rm -f "$SCRIPT_DIR/$old_file"
    echo "   🗑️  删除: $old_file"
    CLEANED=$((CLEANED + 1))
  fi
done

# 8b. 清理项目目录内不再需要的老目录
OLD_DIRS=(
  ".backup-before-revert"
  "docs"
  "备用"
  ".plugin-update"
  ".server-update"
  ".full-update"
  ".plugin-backup"
  ".server-backup"
  ".full-backup"
)
for old_dir in "${OLD_DIRS[@]}"; do
  if [ -d "$SCRIPT_DIR/$old_dir" ]; then
    rm -rf "$SCRIPT_DIR/$old_dir"
    echo "   🗑️  删除目录: $old_dir/"
    CLEANED=$((CLEANED + 1))
  fi
done

# 8c. 清理老旧的 .command 文件和打包产物
find "$SCRIPT_DIR" -maxdepth 1 -name "*.command" -delete 2>/dev/null && CLEANED=$((CLEANED + 1)) || true
find "$SCRIPT_DIR" -maxdepth 1 -name "*.tar.gz" -delete 2>/dev/null || true
find "$SCRIPT_DIR" -maxdepth 1 -name "*.backup.js" -delete 2>/dev/null || true

# 8d. 清理安装包根目录（项目文件的父目录）的老文件
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_BASENAME="$(basename "$PACKAGE_ROOT")"

# 只在确认是安装包结构时清理父目录（父目录名含 ScreenSync 或 UserPackage）
if echo "$PACKAGE_BASENAME" | grep -qiE 'screensync|userpackage|figma'; then
  echo "   📂 检测到安装包根目录: $PACKAGE_ROOT"
  
  # 清理安装包根目录的老文件
  PACKAGE_OLD_FILES=(
    "第一步_拖进终端回车运行.command"
    "Developer_清除隔离.command"
  )
  for old_file in "${PACKAGE_OLD_FILES[@]}"; do
    if [ -f "$PACKAGE_ROOT/$old_file" ]; then
      rm -f "$PACKAGE_ROOT/$old_file"
      echo "   🗑️  删除安装包根: $old_file"
      CLEANED=$((CLEANED + 1))
    fi
  done
  find "$PACKAGE_ROOT" -maxdepth 1 -name "*.command" -delete 2>/dev/null || true

  # 复制新的安装包根文件（README 等）
  if [ -f "$SOURCE_PACKAGE_DIR/README_请先阅读.txt" ]; then
    cp "$SOURCE_PACKAGE_DIR/README_请先阅读.txt" "$PACKAGE_ROOT/" 2>/dev/null || true
    echo "   📄 更新: README_请先阅读.txt"
  fi
fi

if [ $CLEANED -gt 0 ]; then
  echo -e "${GREEN}✅ 已清理 ${CLEANED} 个老旧文件/目录${NC}"
else
  echo -e "${GREEN}✅ 无需清理${NC}"
fi

# ─── 9. 同步更新所有代码文件 ─────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🚀 正在同步最新代码文件...${NC}"

UPDATED=0

if [ -f "$SOURCE_DIR/update-manifest.json" ]; then
  MANIFEST_FILES=$(python3 -c "
import json
m = json.load(open('$SOURCE_DIR/update-manifest.json'))
for f in m.get('files', []):
    print(f)
")
  for file in $MANIFEST_FILES; do
    src="$SOURCE_DIR/$file"
    dest="$SCRIPT_DIR/$file"
    if [ -f "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      cp "$src" "$dest"
      UPDATED=$((UPDATED + 1))
    fi
  done
else
  cd "$SOURCE_DIR"
  find . -type f ! -name ".*" ! -path "*/node_modules/*" ! -path "*/.git/*" | while read -r file; do
    rel_path="${file#./}"
    src="$SOURCE_DIR/$rel_path"
    dest="$SCRIPT_DIR/$rel_path"
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  done
  UPDATED=$(find . -type f ! -name ".*" ! -path "*/node_modules/*" ! -path "*/.git/*" | wc -l | tr -d ' ')
  cd "$SCRIPT_DIR"
fi

# 反向清理：删除本地存在但新版本中不存在的代码文件（精确同步）
if [ -f "$SOURCE_DIR/update-manifest.json" ]; then
  echo ""
  echo -e "${YELLOW}🔍 正在检查多余的旧代码文件...${NC}"
  EXTRA_REMOVED=0

  # 获取新版本的文件清单
  MANIFEST_SET="$TEMP_DIR/manifest_set.txt"
  python3 -c "
import json
m = json.load(open('$SOURCE_DIR/update-manifest.json'))
for f in m.get('files', []):
    print(f)
" > "$MANIFEST_SET"

  # 检查本地的 .js 文件（根目录）
  for local_file in "$SCRIPT_DIR"/*.js; do
    [ -f "$local_file" ] || continue
    basename_file="$(basename "$local_file")"
    # 跳过不在清单中但属于运行时生成的文件
    if echo "$basename_file" | grep -qE '^(serviceAccountKey|\.)'  ; then
      continue
    fi
    if ! grep -qx "$basename_file" "$MANIFEST_SET" 2>/dev/null; then
      # 不在新版本清单中，但可能是用户自定义文件，只删已知过时的
      case "$basename_file" in
        aliyunOSS.js|aliyun-watcher.js)
          rm -f "$local_file"
          echo "   🗑️  删除多余代码: $basename_file"
          EXTRA_REMOVED=$((EXTRA_REMOVED + 1))
          ;;
      esac
    fi
  done

  if [ $EXTRA_REMOVED -gt 0 ]; then
    echo -e "${GREEN}✅ 已清理 ${EXTRA_REMOVED} 个多余的旧代码文件${NC}"
  else
    echo -e "${GREEN}✅ 无多余文件${NC}"
  fi
fi

echo -e "${GREEN}✅ 已同步 ${UPDATED} 个代码文件${NC}"

# ─── 10. 安装包目录重命名 ────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}📁 检查安装包目录名称...${NC}"

PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_BASENAME="$(basename "$PACKAGE_ROOT")"
PACKAGE_PARENT="$(dirname "$PACKAGE_ROOT")"
RENAMED=false

# 检查是否需要重命名（老名称 → 新架构名称）
if echo "$PACKAGE_BASENAME" | grep -qiE 'userpackage'; then
  NEW_PACKAGE_PATH="$PACKAGE_PARENT/$NEW_PACKAGE_NAME"

  if [ -d "$NEW_PACKAGE_PATH" ]; then
    echo -e "${YELLOW}⚠️  目标目录已存在: $NEW_PACKAGE_PATH${NC}"
    echo "   跳过重命名，当前目录继续使用"
  else
    echo "   重命名: $PACKAGE_BASENAME → $NEW_PACKAGE_NAME"
    mv "$PACKAGE_ROOT" "$NEW_PACKAGE_PATH"
    RENAMED=true
    PACKAGE_ROOT="$NEW_PACKAGE_PATH"

    # 更新 SCRIPT_DIR 指向新路径
    if [ "$(basename "$SCRIPT_DIR")" = "项目文件" ]; then
      SCRIPT_DIR="$NEW_PACKAGE_PATH/项目文件"
    else
      SCRIPT_DIR="$NEW_PACKAGE_PATH"
    fi

    echo -e "${GREEN}✅ 安装包已重命名为: $NEW_PACKAGE_NAME${NC}"
  fi
else
  echo -e "${GREEN}✅ 目录名称正常，无需重命名${NC}"
fi

# ─── 11. 安装/更新 Node.js 依赖 ──────────────────────────────────────────────
echo ""
echo -e "${YELLOW}📦 正在安装 Node.js 依赖...${NC}"

if command -v npm &>/dev/null; then
  cd "$SCRIPT_DIR"
  npm install --production --omit=dev --legacy-peer-deps 2>&1 | tail -5
  echo -e "${GREEN}✅ Node.js 依赖安装完成${NC}"
else
  echo -e "${RED}⚠️  未找到 npm，请确保 Node.js 已安装${NC}"
fi

# ─── 12. 检查系统依赖 ────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔍 正在检查系统依赖...${NC}"

MISSING_DEPS=""
for cmd in ffmpeg gifsicle magick; do
  if ! command -v "$cmd" &>/dev/null; then
    case "$cmd" in
      magick) MISSING_DEPS="$MISSING_DEPS imagemagick" ;;
      *)      MISSING_DEPS="$MISSING_DEPS $cmd" ;;
    esac
  fi
done

if [ -n "$MISSING_DEPS" ]; then
  echo -e "${YELLOW}⚠️  缺少系统依赖:${MISSING_DEPS}${NC}"
  if command -v brew &>/dev/null; then
    echo -e "${YELLOW}📦 正在通过 Homebrew 安装...${NC}"
    brew install $MISSING_DEPS 2>&1 | tail -5
    echo -e "${GREEN}✅ 系统依赖安装完成${NC}"
  else
    echo -e "${YELLOW}⚠️  未找到 Homebrew，部分功能可能受限${NC}"
    echo "   可运行以下命令安装 Homebrew:"
    echo '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo "   安装后运行: brew install$MISSING_DEPS"
  fi
else
  echo -e "${GREEN}✅ 系统依赖完整${NC}"
fi

# ─── 13. 更新 launchd 服务配置 ───────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔄 正在更新开机自启动配置...${NC}"

PLIST_PATH="$HOME/Library/LaunchAgents/com.screensync.server.plist"

if [ -f "$PLIST_PATH" ] && [ "$RENAMED" = true ]; then
  # 目录已重命名，需要更新 plist 中的路径
  echo "   更新 launchd plist 中的路径..."

  # 用 node 安全地重写 plist（避免 sed 处理 XML 的问题）
  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$PLIST_PATH', 'utf8');
    // 替换所有旧路径引用为新路径
    const oldPatterns = [
      /ScreenSync[-_]?UserPackage/gi,
      /FigmaSync[-_]?UserPackage/gi
    ];
    for (const pat of oldPatterns) {
      content = content.replace(pat, '$NEW_PACKAGE_NAME');
    }
    fs.writeFileSync('$PLIST_PATH', content, 'utf8');
    console.log('   ✅ plist 路径已更新');
  " 2>/dev/null || echo "   ⚠️  plist 更新失败，将重新生成"
fi

# 如果安装了 node 并且有 setup-autostart.js，重新注册 launchd 以确保路径正确
if command -v node &>/dev/null && [ -f "$SCRIPT_DIR/setup-autostart.js" ]; then
  echo "   重新注册 launchd 服务..."
  node "$SCRIPT_DIR/setup-autostart.js" "$SCRIPT_DIR" 2>/dev/null || true
  echo -e "${GREEN}✅ 开机自启动已更新${NC}"
else
  echo -e "${GREEN}✅ launchd 配置无需更新${NC}"
fi

# ─── 14. 显示更新结果 ────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

NEW_VERSION="未知"
if [ -f "$SCRIPT_DIR/VERSION.txt" ]; then
  NEW_VERSION=$(cat "$SCRIPT_DIR/VERSION.txt" | tr -d '[:space:]')
fi

echo -e "${GREEN}✅ 更新完成！${NC}"
echo ""
echo -e "   旧版本: ${RED}${OLD_VERSION}${NC}"
echo -e "   新版本: ${GREEN}${NEW_VERSION}${NC}"
if [ "$RENAMED" = true ]; then
  echo -e "   安装包: ${GREEN}已重命名为 ${NEW_PACKAGE_NAME}${NC}"
fi
echo -e "   项目路径: ${GREEN}${SCRIPT_DIR}${NC}"
echo -e "   备份位置: ${BACKUP_DIR}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# ─── 15. 重启服务器 ──────────────────────────────────────────────────────────
echo -e "${YELLOW}🔄 正在启动服务器...${NC}"

PLIST_PATH="$HOME/Library/LaunchAgents/com.screensync.server.plist"
if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  sleep 1
  launchctl load "$PLIST_PATH" 2>/dev/null || true
  echo -e "${GREEN}✅ 服务器已通过 launchd 重启${NC}"
else
  cd "$SCRIPT_DIR"
  nohup node start.js > /dev/null 2>&1 &
  echo -e "${GREEN}✅ 服务器已启动 (PID: $!)${NC}"
fi

echo ""
echo -e "${GREEN}🎉 全部完成！请回到 Figma 插件，功能已恢复到最新版本。${NC}"
echo -e "${GREEN}   之后的版本更新可以直接在插件内一键完成。${NC}"
echo ""
