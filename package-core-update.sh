#!/bin/bash

# ScreenSync 核心代码更新包打包脚本
# 仅包含服务器核心代码和插件代码，体积小，用于快速更新

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ScreenSync 核心代码更新包打包脚本     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 获取版本号（从 package.json 读取）
if [ -f "package.json" ]; then
    VERSION=$(grep -o "\"version\": \"[^\"]*\"" package.json | head -1 | cut -d"\"" -f4)
    if [ -z "$VERSION" ]; then
        echo -e "${RED}❌ 错误: 无法从 package.json 中读取版本号${NC}"
        exit 1
    fi
else
    echo -e "${RED}❌ 错误: package.json 不存在${NC}"
    exit 1
fi

PACKAGE_NAME="ScreenSync-UpdatePackage-v${VERSION}"
UPDATE_TAR="${PACKAGE_NAME}.tar.gz"

echo -e "${GREEN}📦 开始打包核心代码...${NC}\n"
echo -e "${YELLOW}📋 版本: ${VERSION}${NC}\n"

# 创建临时目录
TEMP_DIR="/tmp/${PACKAGE_NAME}"
if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi
mkdir -p "$TEMP_DIR"

# 复制核心文件
echo -e "${YELLOW}📄 复制核心代码文件...${NC}"

FILES_TO_COPY=(
    "server.js"
    "start.js"
    "googleDrive.js"
    "drive-watcher.js"
    "icloud-watcher.js"
    "aliyun-watcher.js"
    "package.json"
    "VERSION.txt"
    "README_插件介绍.txt"
)

for file in "${FILES_TO_COPY[@]}"; do
    if [ -f "$file" ]; then
        cp "$file" "$TEMP_DIR/"
        echo "   ✅ $file"
    else
        echo -e "   ${YELLOW}⚠️  $file 不存在 (跳过)${NC}"
    fi
done

# 复制插件目录
if [ -d "figma-plugin" ]; then
    echo "   ✅ figma-plugin/ (完整目录)"
    cp -r figma-plugin "$TEMP_DIR/"
    # 清理不需要的文件（如 .DS_Store）
    find "$TEMP_DIR/figma-plugin" -name ".DS_Store" -delete
else
    echo -e "   ${RED}❌ figma-plugin 目录不存在${NC}"
    exit 1
fi

# 打包成 tar.gz
echo -e "\n${GREEN}📦 创建压缩包...${NC}"
cd /tmp
tar -czf "${UPDATE_TAR}" "${PACKAGE_NAME}/"
cd - > /dev/null
mv "/tmp/${UPDATE_TAR}" "./${UPDATE_TAR}"

# 清理临时目录
rm -rf "$TEMP_DIR"

# 显示结果
PACKAGE_SIZE=$(du -h "${UPDATE_TAR}" | cut -f1)

echo -e "\n${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  打包完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
echo -e "${GREEN}✅ 更新包: ${UPDATE_TAR}${NC}"
echo -e "${GREEN}✅ 大小: ${PACKAGE_SIZE}${NC}\n"
echo -e "${BLUE}💡 说明：${NC}"
echo "   此包仅包含核心代码文件，体积极小，用于服务器自动更新下载。"
echo ""

