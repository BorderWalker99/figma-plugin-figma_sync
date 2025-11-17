#!/bin/bash

# FigmaSync 用户分发打包脚本
# 此脚本会打包所有用户需要的文件，排除部署相关文件

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  FigmaSync 用户分发打包脚本          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 获取当前目录名和版本号
CURRENT_DIR=$(basename "$PWD")
VERSION=$(date +"%Y%m%d")
PACKAGE_NAME="FigmaSync-UserPackage"
TEMP_DIR="/tmp/${PACKAGE_NAME}"

# 清理临时目录
if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi
mkdir -p "$TEMP_DIR"

echo -e "${GREEN}📦 开始打包...${NC}\n"

# 1. 复制核心服务器文件
echo -e "${YELLOW}📄 复制核心服务器文件...${NC}"
cp server.js "$TEMP_DIR/"
cp googleDrive.js "$TEMP_DIR/"
cp userConfig.js "$TEMP_DIR/"
cp serviceAccountKey.js "$TEMP_DIR/"
cp start.js "$TEMP_DIR/"
cp update-manager.js "$TEMP_DIR/"
cp icloud-watcher.js "$TEMP_DIR/"
cp drive-watcher.js "$TEMP_DIR/"

# 2. 复制配置文件
echo -e "${YELLOW}⚙️  复制配置文件...${NC}"
cp package.json "$TEMP_DIR/"
cp package-lock.json "$TEMP_DIR/"
cp README.md "$TEMP_DIR/"

# 3. 复制安装和工具脚本
echo -e "${YELLOW}🔧 复制安装脚本...${NC}"
cp install-and-run.sh "$TEMP_DIR/"
cp get-user-id.sh "$TEMP_DIR/"

# 4. 复制 Figma 插件文件（排除 node_modules）
echo -e "${YELLOW}🎨 复制 Figma 插件文件...${NC}"
mkdir -p "$TEMP_DIR/figma-plugin"
cp figma-plugin/manifest.json "$TEMP_DIR/figma-plugin/"
cp figma-plugin/code.js "$TEMP_DIR/figma-plugin/"
cp figma-plugin/ui.html "$TEMP_DIR/figma-plugin/"

# 复制插件图片资源
if [ -d "figma-plugin/images" ]; then
    cp -r figma-plugin/images "$TEMP_DIR/figma-plugin/"
fi

# 复制 qr-codes.js（如果存在）
if [ -f "figma-plugin/qr-codes.js" ]; then
    cp figma-plugin/qr-codes.js "$TEMP_DIR/figma-plugin/"
fi

# 5. 创建 .gitignore（用于用户自己的版本控制）
echo -e "${YELLOW}📝 创建 .gitignore...${NC}"
cat > "$TEMP_DIR/.gitignore" << 'EOF'
# 依赖
node_modules/
package-lock.json

# 环境变量
.env
.env.local

# 日志
*.log
npm-debug.log*

# 系统文件
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# 临时文件
*.tmp
*.temp
EOF

# 6. 创建使用说明文件
echo -e "${YELLOW}📖 创建使用说明...${NC}"
cat > "$TEMP_DIR/使用说明.txt" << 'EOF'
FigmaSync - iPhone截图自动同步到Figma

═══════════════════════════════════════════════════════

📦 快速开始

1. 解压此文件包
2. 打开终端，进入解压后的文件夹
3. 运行安装脚本：
   ./install-and-run.sh

脚本会自动完成所有安装步骤。

═══════════════════════════════════════════════════════

📱 Figma插件安装

1. 打开 Figma Desktop 应用
2. 菜单：Plugins → Development → Import plugin from manifest
3. 选择：figma-plugin/manifest.json
4. 运行插件并开始使用

═══════════════════════════════════════════════════════

🚀 使用流程

1. 启动服务：npm start
2. 在 Figma 中打开插件
3. 选择同步模式（实时或手动）
4. 在 iPhone 上截图
5. 截图自动同步到 Figma

═══════════════════════════════════════════════════════

💡 提示

- 首次使用需要选择同步模式（iCloud 或 Google Drive）
- Google Drive 模式需要配置用户ID，查看 .user-config.json 中的 userId
- 详细说明请查看 README.md

═══════════════════════════════════════════════════════
EOF

# 7. 创建版本信息文件
echo -e "${YELLOW}📋 创建版本信息...${NC}"
cat > "$TEMP_DIR/VERSION.txt" << EOF
FigmaSync 用户分发包
版本: ${VERSION}
打包日期: $(date +"%Y-%m-%d %H:%M:%S")
EOF

# 8. 打包成 tar.gz
echo -e "\n${GREEN}📦 创建压缩包...${NC}"
cd /tmp
tar -czf "${PACKAGE_NAME}.tar.gz" "${PACKAGE_NAME}/"
cd - > /dev/null

# 9. 移动到当前目录
mv "/tmp/${PACKAGE_NAME}.tar.gz" "./${PACKAGE_NAME}.tar.gz"

# 10. 清理临时目录
rm -rf "$TEMP_DIR"

# 显示结果
PACKAGE_SIZE=$(du -h "${PACKAGE_NAME}.tar.gz" | cut -f1)

echo -e "\n${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  打包完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
echo -e "${GREEN}✅ 文件包: ${PACKAGE_NAME}.tar.gz${NC}"
echo -e "${GREEN}✅ 大小: ${PACKAGE_SIZE}${NC}\n"
echo -e "${YELLOW}📦 包含内容：${NC}"
echo "   - 核心服务器文件"
echo "   - Figma 插件文件"
echo "   - 安装脚本"
echo "   - 使用说明"
echo ""
echo -e "${YELLOW}❌ 已排除：${NC}"
echo "   - Dockerfile（部署相关）"
echo "   - deploy.sh（部署相关）"
echo "   - node_modules（依赖，用户需自行安装）"
echo "   - .env（敏感信息）"
echo ""
echo -e "${BLUE}💡 提示：用户解压后运行 ./install-and-run.sh 即可开始使用${NC}\n"

