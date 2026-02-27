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
pkill -f "node.*server\.js" 2>/dev/null || true
pkill -f "node.*start\.js" 2>/dev/null || true
sleep 1
echo -e "${GREEN}✅ 服务器进程已停止${NC}"

# ─── 3. 检测系统架构 ─────────────────────────────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  ASSET_NAME="ScreenSync-Apple.tar.gz"
  ARCH_LABEL="Apple Silicon (M系列芯片)"
else
  ASSET_NAME="ScreenSync-Intel.tar.gz"
  ARCH_LABEL="Intel"
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
  if [ -f "$EXTRACT_DIR/$dir_name/server.js" ]; then
    SOURCE_DIR="$EXTRACT_DIR/$dir_name"
    break
  fi
done

if [ -z "$SOURCE_DIR" ]; then
  # 尝试在子目录中查找
  SOURCE_DIR=$(find "$EXTRACT_DIR" -name "server.js" -maxdepth 3 -exec dirname {} \; | head -1)
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
echo -e "${YELLOW}💾 正在备份现有文件到 ${BACKUP_DIR}...${NC}"
mkdir -p "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR/figma-plugin"

for f in server.js start.js update-handlers.js update-manager.js gif-composer.js \
         googleDrive.js aliyunOSS.js userConfig.js drive-watcher.js aliyun-watcher.js \
         icloud-watcher.js setup-autostart.js package.json package-lock.json \
         VERSION.txt; do
  if [ -f "$SCRIPT_DIR/$f" ]; then
    cp "$SCRIPT_DIR/$f" "$BACKUP_DIR/$f" 2>/dev/null || true
  fi
done

for f in manifest.json code.js ui.html; do
  if [ -f "$SCRIPT_DIR/figma-plugin/$f" ]; then
    cp "$SCRIPT_DIR/figma-plugin/$f" "$BACKUP_DIR/figma-plugin/$f" 2>/dev/null || true
  fi
done

echo -e "${GREEN}✅ 备份完成${NC}"

# ─── 8. 更新所有文件 ──────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🚀 正在更新文件...${NC}"

UPDATED=0
SKIPPED=0

# 如果有 update-manifest.json，按清单更新；否则遍历所有文件
if [ -f "$SOURCE_DIR/update-manifest.json" ]; then
  # 按 manifest 更新
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
  # 遍历解压目录中的所有文件
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

echo -e "${GREEN}✅ 已更新 ${UPDATED} 个文件${NC}"

# ─── 9. 安装/更新 Node.js 依赖 ───────────────────────────────────────────────
echo ""
echo -e "${YELLOW}📦 正在安装 Node.js 依赖...${NC}"

if command -v npm &>/dev/null; then
  cd "$SCRIPT_DIR"
  npm install --production --omit=dev --legacy-peer-deps 2>&1 | tail -5
  echo -e "${GREEN}✅ Node.js 依赖安装完成${NC}"
else
  echo -e "${RED}⚠️  未找到 npm，请确保 Node.js 已安装${NC}"
fi

# ─── 10. 检查系统依赖 ─────────────────────────────────────────────────────────
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

# ─── 11. 显示更新前后版本 ─────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

# 读取旧版本
OLD_VERSION="未知"
if [ -f "$BACKUP_DIR/VERSION.txt" ]; then
  OLD_VERSION=$(cat "$BACKUP_DIR/VERSION.txt" | tr -d '[:space:]')
fi

# 读取新版本
NEW_VERSION="未知"
if [ -f "$SCRIPT_DIR/VERSION.txt" ]; then
  NEW_VERSION=$(cat "$SCRIPT_DIR/VERSION.txt" | tr -d '[:space:]')
fi

echo -e "${GREEN}✅ 更新完成！${NC}"
echo ""
echo -e "   旧版本: ${RED}${OLD_VERSION}${NC}"
echo -e "   新版本: ${GREEN}${NEW_VERSION}${NC}"
echo -e "   备份位置: ${BACKUP_DIR}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# ─── 12. 重启服务器 ──────────────────────────────────────────────────────────
echo -e "${YELLOW}🔄 正在启动服务器...${NC}"

# 检查 launchd
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
