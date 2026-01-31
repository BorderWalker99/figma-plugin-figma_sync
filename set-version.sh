#!/bin/bash

# ScreenSync 版本号一键修改脚本
# 用法: ./set-version.sh 1.0.2

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查参数
if [ -z "$1" ]; then
    echo -e "${YELLOW}用法: ./set-version.sh <版本号>${NC}"
    echo -e "${YELLOW}示例: ./set-version.sh 1.0.2${NC}"
    echo ""
    
    # 显示当前版本
    CURRENT=$(grep -o "版本: [^ ]*" VERSION.txt | awk '{print $2}')
    echo -e "${BLUE}当前版本: ${GREEN}v${CURRENT}${NC}"
    exit 1
fi

NEW_VERSION="$1"

# 验证版本号格式
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}❌ 版本号格式错误，应为 x.y.z（如 1.0.1）${NC}"
    exit 1
fi

# 显示当前版本
CURRENT=$(grep -o "版本: [^ ]*" VERSION.txt | awk '{print $2}')
echo -e "${BLUE}当前版本: ${GREEN}v${CURRENT}${NC}"
echo -e "${BLUE}目标版本: ${GREEN}v${NEW_VERSION}${NC}"
echo ""

# 更新所有文件
echo -e "${YELLOW}正在更新版本号...${NC}"

# 1. VERSION.txt
sed -i '' "s/版本: .*/版本: ${NEW_VERSION}/g" VERSION.txt
sed -i '' "s/更新日期: .*/更新日期: $(date +"%Y-%m-%d")/g" VERSION.txt
echo -e "   ${GREEN}✅ VERSION.txt${NC}"

# 2. package.json
sed -i '' "1,10s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" package.json
echo -e "   ${GREEN}✅ package.json${NC}"

# 3. installer/package.json
sed -i '' "1,10s/\"version\": \"[^\"]*\"/\"version\": \"${NEW_VERSION}\"/" installer/package.json
echo -e "   ${GREEN}✅ installer/package.json${NC}"

# 4. figma-plugin/code.js
sed -i '' "s/PLUGIN_VERSION = '[^']*'/PLUGIN_VERSION = '${NEW_VERSION}'/g" figma-plugin/code.js
echo -e "   ${GREEN}✅ figma-plugin/code.js${NC}"

# 5. installer/index.html
sed -i '' "s/v[0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}/v${NEW_VERSION}/g" installer/index.html
echo -e "   ${GREEN}✅ installer/index.html${NC}"

echo ""
echo -e "${GREEN}✅ 所有文件版本号已更新为 v${NEW_VERSION}${NC}"
