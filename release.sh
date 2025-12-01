#!/bin/bash

# ScreenSync 一键发布脚本
# 自动完成版本更新、打包、发布到 GitHub Releases

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

clear

echo -e "${BLUE}"
cat << "EOF"
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync 一键发布工具                          ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}\n"

# 检查 GitHub CLI
if ! command -v gh &> /dev/null; then
    echo -e "${RED}❌ 未检测到 GitHub CLI (gh)${NC}"
    echo -e "${YELLOW}请先安装：brew install gh${NC}"
    echo -e "${YELLOW}然后登录：gh auth login${NC}\n"
    exit 1
fi

# 获取当前版本
CURRENT_PLUGIN_VERSION=$(grep -o "PLUGIN_VERSION = '[^']*'" figma-plugin/code.js | cut -d"'" -f2)
CURRENT_SERVER_VERSION=$(grep -o "版本: [^ ]*" VERSION.txt | awk '{print $2}')

echo -e "${BLUE}📦 当前版本信息：${NC}"
echo -e "   插件版本: ${GREEN}v${CURRENT_PLUGIN_VERSION}${NC}"
echo -e "   服务器版本: ${GREEN}v${CURRENT_SERVER_VERSION}${NC}\n"

# 提示输入新版本号
echo -e "${YELLOW}请输入新版本号（格式: x.y.z，如 1.0.1）：${NC}"
read -p "新版本: " NEW_VERSION

if [ -z "$NEW_VERSION" ]; then
    echo -e "${RED}❌ 版本号不能为空${NC}"
    exit 1
fi

# 验证版本号格式
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}❌ 版本号格式错误，应为 x.y.z（如 1.0.1）${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}请输入更新说明（按 Ctrl+D 结束输入）：${NC}"
echo -e "${YELLOW}示例：${NC}"
echo -e "  - 新增功能 A"
echo -e "  - 修复 Bug B"
echo -e "  - 优化性能 C"
echo ""
RELEASE_NOTES=$(cat)

if [ -z "$RELEASE_NOTES" ]; then
    RELEASE_NOTES="- 版本更新至 v${NEW_VERSION}"
fi

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}即将执行以下操作：${NC}"
echo -e "  1. 更新版本号：${GREEN}v${NEW_VERSION}${NC}"
echo -e "  2. 打包插件和服务器"
echo -e "  3. 提交代码到 GitHub"
echo -e "  4. 创建 Git Tag: ${GREEN}v${NEW_VERSION}${NC}"
echo -e "  5. 发布到 GitHub Releases"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"

read -p "确认继续？(Y/n): " CONFIRM
CONFIRM=${CONFIRM:-Y}

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}已取消发布${NC}"
    exit 0
fi

echo ""

# ==================== 步骤 1: 更新版本号 ====================
echo -e "${BLUE}📝 步骤 1/5: 更新版本号...${NC}"

# 更新插件版本号
sed -i '' "s/PLUGIN_VERSION = '[^']*'/PLUGIN_VERSION = '${NEW_VERSION}'/g" figma-plugin/code.js
echo -e "   ${GREEN}✅ 插件版本号已更新: v${NEW_VERSION}${NC}"

# 更新服务器版本号
sed -i '' "s/版本: .*/版本: ${NEW_VERSION}/g" VERSION.txt
sed -i '' "s/更新日期: .*/更新日期: $(date +"%Y-%m-%d")/g" VERSION.txt
echo -e "   ${GREEN}✅ 服务器版本号已更新: v${NEW_VERSION}${NC}"

# ==================== 步骤 2: 打包 ====================
echo -e "\n${BLUE}📦 步骤 2/5: 打包插件和服务器...${NC}"

# 打包插件
echo -e "   ${YELLOW}正在打包插件...${NC}"
if ./package-for-update.sh > /dev/null 2>&1; then
    PLUGIN_ZIP="figma-plugin-v${NEW_VERSION}.zip"
    if [ -f "$PLUGIN_ZIP" ]; then
        PLUGIN_SIZE=$(du -h "$PLUGIN_ZIP" | cut -f1)
        echo -e "   ${GREEN}✅ 插件打包完成: ${PLUGIN_ZIP} (${PLUGIN_SIZE})${NC}"
    else
        echo -e "   ${RED}❌ 插件打包失败：未找到 ${PLUGIN_ZIP}${NC}"
        exit 1
    fi
else
    echo -e "   ${RED}❌ 插件打包失败${NC}"
    exit 1
fi

# 打包服务器
echo -e "   ${YELLOW}正在打包服务器...${NC}"
if ./package-for-distribution.sh > /dev/null 2>&1; then
    SERVER_TAR="ScreenSync-UserPackage.tar.gz"
    if [ -f "$SERVER_TAR" ]; then
        SERVER_SIZE=$(du -h "$SERVER_TAR" | cut -f1)
        echo -e "   ${GREEN}✅ 服务器打包完成: ${SERVER_TAR} (${SERVER_SIZE})${NC}"
    else
        echo -e "   ${RED}❌ 服务器打包失败：未找到 ${SERVER_TAR}${NC}"
        exit 1
    fi
else
    echo -e "   ${RED}❌ 服务器打包失败${NC}"
    exit 1
fi

# ==================== 步骤 3: 提交代码 ====================
echo -e "\n${BLUE}📤 步骤 3/5: 提交代码到 GitHub...${NC}"

# 检查是否有未提交的更改
if [[ -n $(git status -s) ]]; then
    git add .
    git commit -m "chore: release v${NEW_VERSION}

${RELEASE_NOTES}" > /dev/null 2>&1
    echo -e "   ${GREEN}✅ 代码已提交${NC}"
else
    echo -e "   ${YELLOW}⚠️  没有需要提交的更改${NC}"
fi

# 推送到 GitHub
if git push origin main > /dev/null 2>&1; then
    echo -e "   ${GREEN}✅ 代码已推送到 GitHub${NC}"
else
    echo -e "   ${RED}❌ 推送失败，可能需要先 pull${NC}"
    echo -e "   ${YELLOW}请运行：git pull --rebase origin main${NC}"
    exit 1
fi

# ==================== 步骤 4: 创建 Git Tag ====================
echo -e "\n${BLUE}🏷️  步骤 4/5: 创建 Git Tag...${NC}"

# 检查 Tag 是否已存在
if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
    echo -e "   ${YELLOW}⚠️  Tag v${NEW_VERSION} 已存在，尝试推送...${NC}"
    if git push origin "v${NEW_VERSION}" 2>&1; then
        echo -e "   ${GREEN}✅ Git Tag v${NEW_VERSION} 已推送${NC}"
    else
        # 如果推送失败（可能是已经存在于远程），我们尝试继续，让 gh 命令处理
        echo -e "   ${YELLOW}⚠️  Tag 推送警告（可能已存在于远程），继续尝试发布...${NC}"
    fi
else
    if git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}" 2>&1; then
        if git push origin "v${NEW_VERSION}" 2>&1; then
            echo -e "   ${GREEN}✅ Git Tag v${NEW_VERSION} 已创建并推送${NC}"
        else
            echo -e "   ${RED}❌ Tag 推送失败${NC}"
            exit 1
        fi
    else
        echo -e "   ${RED}❌ Tag 创建失败${NC}"
        exit 1
    fi
fi

# ==================== 步骤 5: 发布到 GitHub Releases ====================
echo -e "\n${BLUE}🚀 步骤 5/5: 发布到 GitHub Releases...${NC}"

# 检查 Release 是否已存在
if gh release view "v${NEW_VERSION}" >/dev/null 2>&1; then
    echo -e "   ${YELLOW}⚠️  Release v${NEW_VERSION} 已存在${NC}"
    read -p "   是否删除并重新创建？(y/N): " RECREATE
    RECREATE=${RECREATE:-N}
    
    if [[ "$RECREATE" =~ ^[Yy]$ ]]; then
        gh release delete "v${NEW_VERSION}" --yes > /dev/null 2>&1
        echo -e "   ${GREEN}✅ 已删除旧 Release${NC}"
    else
        echo -e "   ${YELLOW}已取消发布${NC}"
        exit 0
    fi
fi

# 创建 Release
RELEASE_TITLE="v${NEW_VERSION} - ScreenSync"
RELEASE_BODY="## 🎉 更新内容

${RELEASE_NOTES}

---

## 📦 下载说明

### 📥 下载指南 (必读)
**请仅下载 \`ScreenSync-UserPackage.tar.gz\` (macOS)**

*   ✅ **ScreenSync-UserPackage.tar.gz**: 包含安装器和所有文件的完整包，新用户请下载此文件。
*   ⚠️ **figma-plugin-v${NEW_VERSION}.zip**: 无需下载，这是供软件自动更新功能使用的内部文件。
*   ⚠️ **Source code**: 无需下载，项目源码。

### 🔄 如何更新
*   **已有用户**: 直接在 Figma 插件设置中点击「检查更新」即可自动升级，无需手动下载任何文件。
*   **新用户**: 下载上方的完整包，解压后运行安装器。

---

发布时间: $(date +"%Y-%m-%d %H:%M:%S")
"

    echo -e "   ${YELLOW}正在上传到 GitHub Releases...${NC}"
    
    # 显示上传进度
    if gh release create "v${NEW_VERSION}" \
        "$PLUGIN_ZIP" \
        "$SERVER_TAR" \
        --title "$RELEASE_TITLE" \
        --notes "$RELEASE_BODY"; then
        echo -e "   ${GREEN}✅ Release v${NEW_VERSION} 发布成功${NC}"
    else
        echo -e "   ${RED}❌ Release 发布失败${NC}"
        exit 1
    fi

# ==================== 完成 ====================
echo -e "\n${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                        ║${NC}"
echo -e "${GREEN}║  🎉 发布完成！                                         ║${NC}"
echo -e "${GREEN}║                                                        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}\n"

echo -e "${BLUE}📦 版本信息：${NC}"
echo -e "   版本号: ${GREEN}v${NEW_VERSION}${NC}"
echo -e "   插件包: ${PLUGIN_ZIP} (${PLUGIN_SIZE})"
echo -e "   服务器包: ${SERVER_TAR} (${SERVER_SIZE})"
echo ""

echo -e "${BLUE}🔗 查看 Release：${NC}"
REPO="BorderWalker99/figma-plugin-figma_sync"
echo -e "   ${YELLOW}https://github.com/${REPO}/releases/tag/v${NEW_VERSION}${NC}"
echo ""

echo -e "${BLUE}💡 后续步骤：${NC}"
echo -e "   1. 通知用户有新版本可用"
echo -e "   2. 用户在插件设置中点击「更新」即可自动更新"
echo -e "   3. 新用户下载 ${SERVER_TAR} 进行安装"
echo ""

# 清理临时文件（可选）
read -p "是否清理本地打包文件？(y/N): " CLEANUP
CLEANUP=${CLEANUP:-N}

if [[ "$CLEANUP" =~ ^[Yy]$ ]]; then
    rm -f "$PLUGIN_ZIP" "$SERVER_TAR"
    echo -e "${GREEN}✅ 本地打包文件已清理${NC}\n"
else
    echo -e "${YELLOW}⚠️  本地打包文件已保留${NC}\n"
fi

echo -e "${GREEN}🎊 发布流程全部完成！${NC}\n"

