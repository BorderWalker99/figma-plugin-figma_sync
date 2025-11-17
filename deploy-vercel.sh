#!/bin/bash

# FigmaSync Vercel 一键部署脚本

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  FigmaSync Vercel 部署脚本           ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 配置
VERSION=$(date +"%Y%m%d-%H%M%S")
DEPLOY_DIR="./deploy-web"
GITHUB_REPO="${GITHUB_REPO:-BorderWalker99/figma-plugin-figma_sync}"  # GitHub 仓库

# 检查 Vercel CLI
if ! command -v vercel &> /dev/null; then
    echo -e "${YELLOW}📦 安装 Vercel CLI...${NC}"
    npm install -g vercel
fi

# 检查是否已登录 Vercel
if ! vercel whoami &> /dev/null; then
    echo -e "${YELLOW}🔐 请先登录 Vercel...${NC}"
    vercel login
fi

# 1. 生成部署文件
echo -e "${GREEN}📦 生成部署文件...${NC}"
./deploy-web.sh

# 2. 获取部署后的 URL
echo -e "\n${GREEN}🚀 部署到 Vercel...${NC}"
cd "$DEPLOY_DIR"

# 部署到生产环境
DEPLOY_URL=$(vercel --prod --yes 2>&1 | grep -o 'https://[^ ]*\.vercel\.app' | head -1)

if [ -z "$DEPLOY_URL" ]; then
    echo -e "${RED}❌ 部署失败，无法获取部署 URL${NC}"
    exit 1
fi

cd ..

# 3. 更新 version.json 中的 CDN URL
echo -e "${YELLOW}🔄 更新版本信息...${NC}"
sed -i.bak "s|https://your-cdn-domain.com/figmasync|${DEPLOY_URL}|g" "$DEPLOY_DIR/version.json"
rm -f "$DEPLOY_DIR/version.json.bak"

# 4. 重新部署以应用更新的 URL
echo -e "${GREEN}🔄 重新部署以应用更新...${NC}"
cd "$DEPLOY_DIR"
vercel --prod --yes > /dev/null 2>&1
cd ..

# 5. 保存插件 URL 到配置文件（供 install-and-run.sh 使用）
PLUGIN_MANIFEST_URL="${DEPLOY_URL}/figma-plugin/manifest.json"
CONFIG_FILE=".figmasync-config.json"
if command -v node &> /dev/null; then
    node -e "
        const fs = require('fs');
        const config = {
            pluginUrl: '${PLUGIN_MANIFEST_URL}',
            vercelUrl: '${DEPLOY_URL}',
            version: '${VERSION}',
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync('${CONFIG_FILE}', JSON.stringify(config, null, 2), 'utf8');
    " 2>/dev/null && echo -e "${GREEN}✅ 已保存插件 URL 到配置文件${NC}" || true
fi

# 6. 打包服务器代码
echo -e "${GREEN}📦 打包服务器代码...${NC}"
./package-for-distribution.sh

# 显示结果
echo -e "\n${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  部署完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
echo -e "${GREEN}✅ 版本: ${VERSION}${NC}"
echo -e "${GREEN}✅ 部署 URL: ${DEPLOY_URL}${NC}\n"

echo -e "${YELLOW}📋 下一步：${NC}"
echo "   1. 上传服务器包到 GitHub Releases:"
echo "      方式一（使用 GitHub CLI）:"
echo "         gh release create v${VERSION} FigmaSync-UserPackage.tar.gz"
echo ""
echo "      方式二（手动上传）:"
echo "        1. 访问: https://github.com/${GITHUB_REPO}/releases/new"
echo "        2. 创建新版本: v${VERSION}"
echo "        3. 上传文件: FigmaSync-UserPackage.tar.gz"
echo ""
echo -e "${YELLOW}👥 用户安装命令：${NC}"
echo "   curl -fsSL ${DEPLOY_URL}/install.sh | bash"
echo ""
echo -e "${YELLOW}🎨 Figma 插件 URL（在线安装，自动更新）：${NC}"
echo "   ${DEPLOY_URL}/figma-plugin/manifest.json"
echo ""
echo -e "${BLUE}💡 提示：${NC}"
echo "   - 用户运行 install-and-run.sh 时会自动使用此 URL"
echo "   - 使用在线安装后，每次打开插件都会自动使用最新版本"
echo ""

