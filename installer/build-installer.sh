#!/bin/bash

# ScreenSync GUI 安装器打包脚本

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ScreenSync GUI 安装器打包脚本        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# cd installer

# 清理旧的构建产物（重要！防止缓存旧文件）
if [ -d "dist" ]; then
    echo -e "${YELLOW}🧹 清理旧的构建产物...${NC}"
    rm -rf dist
    echo -e "${GREEN}✅ 已清理 dist/ 目录${NC}\n"
fi

# 检查是否安装了 electron 和 electron-builder
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 安装依赖...${NC}"
    npm install
fi

echo -e "${GREEN}🔨 开始打包安装器...${NC}\n"

# 打包 macOS 应用
npm run build:mac

echo -e "\n${GREEN}✅ 打包完成！${NC}"
echo -e "${YELLOW}安装器位置: installer/dist/${NC}\n"

# 自动清理重复的 .app 目录（已包含在 DMG 中）
echo -e "${YELLOW}🧹 清理重复的构建产物...${NC}"
if [ -d "dist/mac" ]; then
    rm -rf dist/mac
    echo -e "${GREEN}✅ 已删除 dist/mac/${NC}"
fi
if [ -d "dist/mac-arm64" ]; then
    rm -rf dist/mac-arm64
    echo -e "${GREEN}✅ 已删除 dist/mac-arm64/${NC}"
fi
echo -e "${GREEN}✅ 清理完成${NC}\n"

echo -e "${BLUE}📦 最终构建产物：${NC}"
ls -lh dist/*.dmg 2>/dev/null || echo "未找到 DMG 文件"
echo ""

