#!/bin/bash

# Figma 插件自动更新打包脚本
# 此脚本专门用于打包插件文件，供自动更新功能使用

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Figma 插件自动更新打包脚本            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 获取版本号（从 VERSION.txt 统一字段读取，与服务器/插件一致）
if [ -f "VERSION.txt" ]; then
    VERSION=$(grep -E '^(版本|Version)\s*:\s*' VERSION.txt | head -1 | sed -E 's/^(版本|Version)[[:space:]]*:[[:space:]]*//' | tr -d '\r\n')
    if [ -z "$VERSION" ]; then
        echo -e "${RED}❌ 错误: 无法从 VERSION.txt 中解析版本号${NC}"
        echo -e "${YELLOW}请确保 VERSION.txt 包含一行: 版本: x.y.z 或 Version: x.y.z${NC}"
        exit 1
    fi
else
    echo -e "${RED}❌ 错误: VERSION.txt 不存在${NC}"
    exit 1
fi

PACKAGE_NAME="figma-plugin-v${VERSION}"
PLUGIN_ZIP="${PACKAGE_NAME}.zip"

# 检查 figma-plugin 目录是否存在
if [ ! -d "figma-plugin" ]; then
    echo -e "${RED}❌ 错误: figma-plugin 目录不存在${NC}"
    exit 1
fi

echo -e "${GREEN}📦 开始打包插件...${NC}\n"
echo -e "${YELLOW}📋 版本: ${VERSION}${NC}\n"

# 创建临时目录
TEMP_DIR="/tmp/${PACKAGE_NAME}"
if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi
mkdir -p "$TEMP_DIR/figma-plugin"

# 复制插件文件（整目录同步，避免遗漏新资源/脚本）
echo -e "${YELLOW}📄 复制插件文件（完整目录）...${NC}"
if [ ! -f "figma-plugin/manifest.json" ] || [ ! -f "figma-plugin/code.js" ] || [ ! -f "figma-plugin/ui.html" ]; then
    echo -e "${RED}❌ 错误: figma-plugin 缺少必要文件（manifest.json / code.js / ui.html）${NC}"
    exit 1
fi

rsync -a \
  --exclude '.DS_Store' \
  --exclude '*.map' \
  --exclude 'node_modules/' \
  "figma-plugin/" "$TEMP_DIR/figma-plugin/"

# 打包成 zip
echo -e "\n${GREEN}📦 创建压缩包...${NC}"
cd "$TEMP_DIR"
zip -r "${PLUGIN_ZIP}" figma-plugin/ > /dev/null
cd - > /dev/null

# 移动到当前目录
mv "$TEMP_DIR/${PLUGIN_ZIP}" "./${PLUGIN_ZIP}"

# 清理临时目录
rm -rf "$TEMP_DIR"

# 显示结果
PACKAGE_SIZE=$(du -h "${PLUGIN_ZIP}" | cut -f1)

echo -e "\n${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  打包完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
echo -e "${GREEN}✅ 文件包: ${PLUGIN_ZIP}${NC}"
echo -e "${GREEN}✅ 大小: ${PACKAGE_SIZE}${NC}\n"
echo -e "${YELLOW}📦 包含内容：${NC}"
echo "   - figma-plugin/ (完整目录)"
echo ""
echo -e "${BLUE}💡 下一步：${NC}"
echo "   1. 上传此文件到 GitHub Releases"
echo "   2. 确保文件名包含 'figma-plugin'（如: ${PLUGIN_ZIP}）"
echo "   3. 用户点击更新按钮即可自动更新\n"

