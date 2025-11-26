#!/bin/bash

# Figma 插件自动更新打包脚本
# 此脚本专门用于打包插件文件，供自动更新功能使用

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  Figma 插件自动更新打包脚本            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 获取版本号（从 code.js 读取）
if [ -f "figma-plugin/code.js" ]; then
    VERSION=$(grep -o "PLUGIN_VERSION = '[^']*'" figma-plugin/code.js | cut -d"'" -f2)
    if [ -z "$VERSION" ]; then
        echo -e "${RED}❌ 错误: 无法从 code.js 中读取版本号${NC}"
        echo -e "${YELLOW}请确保 code.js 第3行包含: const PLUGIN_VERSION = 'x.y.z';${NC}"
        exit 1
    fi
else
    echo -e "${RED}❌ 错误: figma-plugin/code.js 不存在${NC}"
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

# 复制插件文件
echo -e "${YELLOW}📄 复制插件文件...${NC}"

# 必需文件
cp figma-plugin/manifest.json "$TEMP_DIR/figma-plugin/" 2>/dev/null || echo "   ⚠️  manifest.json 不存在"
cp figma-plugin/code.js "$TEMP_DIR/figma-plugin/" 2>/dev/null || echo "   ⚠️  code.js 不存在"
cp figma-plugin/ui.html "$TEMP_DIR/figma-plugin/" 2>/dev/null || echo "   ⚠️  ui.html 不存在"

# 图片资源
if [ -d "figma-plugin/images" ]; then
    echo "   📷 复制图片资源..."
    cp -r figma-plugin/images "$TEMP_DIR/figma-plugin/"
fi

# qr-codes.js（如果存在）
if [ -f "figma-plugin/qr-codes.js" ]; then
    echo "   📄 复制 qr-codes.js..."
    cp figma-plugin/qr-codes.js "$TEMP_DIR/figma-plugin/"
fi

# 其他可能的资源文件
if [ -d "figma-plugin/assets" ]; then
    echo "   📦 复制 assets 资源..."
    cp -r figma-plugin/assets "$TEMP_DIR/figma-plugin/"
fi

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
echo "   - manifest.json"
echo "   - code.js"
echo "   - ui.html"
if [ -d "figma-plugin/images" ]; then
    echo "   - images/ (图片资源)"
fi
if [ -f "figma-plugin/qr-codes.js" ]; then
    echo "   - qr-codes.js"
fi
echo ""
echo -e "${BLUE}💡 下一步：${NC}"
echo "   1. 上传此文件到 GitHub Releases"
echo "   2. 确保文件名包含 'figma-plugin'（如: ${PLUGIN_ZIP}）"
echo "   3. 用户点击更新按钮即可自动更新\n"

