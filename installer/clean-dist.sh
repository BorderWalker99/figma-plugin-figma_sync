#!/bin/bash

# 清理 installer/dist 目录的脚本
# 用途：确保只保留最新版本的 DMG 文件

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}🧹 清理 installer/dist 目录...${NC}\n"

cd "$(dirname "$0")"

if [ -d "dist" ]; then
    echo "📋 当前 dist 目录内容："
    du -sh dist/* 2>/dev/null || echo "   (空目录)"
    echo ""
    
    echo -e "${RED}⚠️  即将删除整个 dist 目录${NC}"
    echo -e "${YELLOW}按 Ctrl+C 取消，或按回车继续...${NC}"
    read -r
    
    rm -rf dist
    echo -e "${GREEN}✅ 已清理 dist/ 目录${NC}"
    echo -e "${YELLOW}💡 下次运行 npm run build:mac 将创建新的构建${NC}"
else
    echo -e "${GREEN}✅ dist/ 目录不存在，无需清理${NC}"
fi

echo ""
echo -e "${GREEN}清理完成！${NC}"

