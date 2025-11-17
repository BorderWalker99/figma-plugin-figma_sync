#!/bin/bash

# 一键上传本地代码到 GitHub 仓库

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  一键上传代码到 GitHub                ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# GitHub 仓库配置
GITHUB_REPO="BorderWalker99/figma-plugin-figma_sync"
GITHUB_URL="https://github.com/${GITHUB_REPO}.git"

# 检查是否在项目目录
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ 错误：未找到 package.json${NC}"
    echo -e "${YELLOW}💡 请确保在项目根目录运行此脚本${NC}"
    exit 1
fi

# 1. 初始化 Git 仓库（如果还没有）
if [ ! -d ".git" ]; then
    echo -e "${YELLOW}📦 初始化 Git 仓库...${NC}"
    git init
    echo -e "${GREEN}✅ Git 仓库已初始化${NC}\n"
else
    echo -e "${GREEN}✅ Git 仓库已存在${NC}\n"
fi

# 2. 检查远程仓库
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

if [ -z "$REMOTE_URL" ]; then
    echo -e "${YELLOW}🔗 添加远程仓库...${NC}"
    git remote add origin "$GITHUB_URL"
    echo -e "${GREEN}✅ 远程仓库已添加: ${GITHUB_URL}${NC}\n"
else
    if [ "$REMOTE_URL" != "$GITHUB_URL" ]; then
        echo -e "${YELLOW}🔄 更新远程仓库地址...${NC}"
        git remote set-url origin "$GITHUB_URL"
        echo -e "${GREEN}✅ 远程仓库地址已更新${NC}\n"
    else
        echo -e "${GREEN}✅ 远程仓库已配置: ${GITHUB_URL}${NC}\n"
    fi
fi

# 3. 创建 .gitignore（如果不存在）
if [ ! -f ".gitignore" ]; then
    echo -e "${YELLOW}📝 创建 .gitignore 文件...${NC}"
    cat > .gitignore << 'EOF'
# 依赖
node_modules/
package-lock.json

# 环境变量和配置
.env
.env.local
.serviceAccountKey.js
serviceAccountKey.js

# 用户配置
.user-config.json
.figmasync-config.json
.sync-mode

# 日志
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# 系统文件
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# 部署文件
deploy-web/
FigmaSync-UserPackage.tar.gz

# 临时文件
*.tmp
*.bak
EOF
    echo -e "${GREEN}✅ .gitignore 已创建${NC}\n"
else
    echo -e "${GREEN}✅ .gitignore 已存在${NC}\n"
fi

# 4. 添加所有文件
echo -e "${YELLOW}📦 添加文件到 Git...${NC}"
git add .

# 5. 检查是否有变更
if git diff --cached --quiet 2>/dev/null && git diff --quiet 2>/dev/null; then
    echo -e "${YELLOW}ℹ️  没有需要提交的变更${NC}"
    echo -e "${YELLOW}💡 所有文件已经是最新的${NC}\n"
else
    # 6. 提交变更
    echo -e "${YELLOW}💾 提交变更...${NC}"
    COMMIT_MSG="Update source code - $(date +'%Y-%m-%d %H:%M:%S')"
    git commit -m "$COMMIT_MSG" || {
        echo -e "${YELLOW}⚠️  提交失败，可能需要先配置 Git 用户信息${NC}"
        echo -e "${YELLOW}💡 请运行以下命令配置 Git：${NC}"
        echo "   git config --global user.name \"你的名字\""
        echo "   git config --global user.email \"你的邮箱\""
        echo ""
        read -p "是否现在配置 Git 用户信息？(Y/n): " CONFIGURE_GIT
        CONFIGURE_GIT=${CONFIGURE_GIT:-Y}
        if [[ "$CONFIGURE_GIT" =~ ^[Yy]$ ]]; then
            read -p "请输入你的名字: " GIT_NAME
            read -p "请输入你的邮箱: " GIT_EMAIL
            git config --global user.name "$GIT_NAME"
            git config --global user.email "$GIT_EMAIL"
            echo -e "${GREEN}✅ Git 用户信息已配置${NC}\n"
            git commit -m "$COMMIT_MSG"
        else
            echo -e "${RED}❌ 已取消，请手动配置 Git 后重新运行${NC}"
            exit 1
        fi
    }
    echo -e "${GREEN}✅ 变更已提交${NC}\n"
fi

# 7. 获取远程分支信息
echo -e "${YELLOW}🔄 获取远程仓库信息...${NC}"
git fetch origin 2>/dev/null || echo -e "${YELLOW}ℹ️  无法获取远程信息（可能是新仓库）${NC}"

# 8. 推送代码
echo -e "${YELLOW}🚀 推送代码到 GitHub...${NC}"
echo -e "${BLUE}仓库: ${GITHUB_URL}${NC}"
echo ""

# 检查是否有 main 分支
BRANCH=$(git branch --show-current 2>/dev/null || echo "main")

if [ -z "$BRANCH" ]; then
    BRANCH="main"
    git checkout -b main 2>/dev/null || true
fi

# 尝试推送到 main 分支
if git push -u origin "$BRANCH" 2>&1; then
    echo -e "\n${GREEN}✅ 代码已成功推送到 GitHub！${NC}"
    echo -e "${GREEN}📦 仓库地址: https://github.com/${GITHUB_REPO}${NC}\n"
else
    echo -e "\n${YELLOW}⚠️  推送可能需要身份验证${NC}"
    echo -e "${YELLOW}💡 如果使用 HTTPS，可能需要：${NC}"
    echo "   1. 使用 Personal Access Token（推荐）"
    echo "   2. 或配置 SSH 密钥"
    echo ""
    echo -e "${YELLOW}💡 如果使用 SSH，请运行：${NC}"
    echo "   git remote set-url origin git@github.com:${GITHUB_REPO}.git"
    echo ""
    echo -e "${YELLOW}💡 或者手动推送：${NC}"
    echo "   git push -u origin $BRANCH"
    echo ""
fi

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  上传完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
