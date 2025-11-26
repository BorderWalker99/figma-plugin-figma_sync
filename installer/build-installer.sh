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

cd installer

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

