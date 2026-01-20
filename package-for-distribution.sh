#!/bin/bash

# ScreenSync 用户分发打包脚本（双架构版本）
# 此脚本会打包两个独立的安装包：Intel 版和 Apple Silicon 版

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ScreenSync 用户分发打包脚本          ║${NC}"
echo -e "${BLUE}║  (双架构独立打包版本)                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 检查 GUI 安装器是否已构建
echo -e "${YELLOW}🔨 正在构建最新版 GUI 安装器...${NC}"
cd installer
# 清理旧的构建产物，防止使用缓存的旧文件
if [ -d "dist" ]; then
    rm -rf dist
    echo -e "   ✅ 已清理旧的 dist/ 目录"
fi
npm install
npm run build:mac
cd ..

# 查找两个版本的 DMG
DMG_INTEL=$(find installer/dist -name "*.dmg" -type f | grep -v "arm64" | sort -V | tail -1)
DMG_ARM=$(find installer/dist -name "*arm64.dmg" -type f | sort -V | tail -1)

if [ -z "$DMG_INTEL" ] || [ -z "$DMG_ARM" ]; then
    echo -e "${RED}❌ 错误：需要同时存在 Intel 和 Apple Silicon 版本的 DMG${NC}"
    echo -e "   Intel DMG: $DMG_INTEL"
    echo -e "   ARM DMG: $DMG_ARM"
    exit 1
fi

echo -e "${GREEN}✅ 找到 Intel 版本: $DMG_INTEL${NC}"
echo -e "${GREEN}✅ 找到 Apple Silicon 版本: $DMG_ARM${NC}\n"

# 获取当前目录名和版本号
CURRENT_DIR=$(basename "$PWD")
VERSION=$(date +"%Y%m%d")

# 清理不应打包的文件（日志、临时文件等）
echo -e "${YELLOW}🧹 清理临时文件和日志...${NC}"
rm -f *.log 2>/dev/null || true
rm -f server-error.log 2>/dev/null || true
rm -f .user-config.json 2>/dev/null || true
rm -f .sync-mode 2>/dev/null || true
echo "   ✅ 清理完成"

# ========================================
# 函数：创建单架构安装包
# 参数: $1 = 架构类型 (Intel/Apple), $2 = DMG 路径, $3 = 包名
# ========================================
create_package() {
    local ARCH_TYPE="$1"
    local DMG_PATH="$2"
    local PACKAGE_NAME="$3"
    local TEMP_DIR="/tmp/${PACKAGE_NAME}"
    
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}📦 正在创建 ${ARCH_TYPE} 版本安装包...${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
    
    # 清理临时目录
    if [ -d "$TEMP_DIR" ]; then
        rm -rf "$TEMP_DIR"
    fi
    mkdir -p "$TEMP_DIR"
    mkdir -p "$TEMP_DIR/项目文件"
    
    # 1. 复制核心服务器文件
    echo -e "${YELLOW}📄 复制核心服务器文件...${NC}"
    cp server.js "$TEMP_DIR/项目文件/"
    cp googleDrive.js "$TEMP_DIR/项目文件/"
    cp userConfig.js "$TEMP_DIR/项目文件/"
    cp serviceAccountKey.js "$TEMP_DIR/项目文件/" 2>/dev/null || true
    cp start.js "$TEMP_DIR/项目文件/"
    cp update-manager.js "$TEMP_DIR/项目文件/"
    cp drive-watcher.js "$TEMP_DIR/项目文件/"
    cp com.screensync.server.plist "$TEMP_DIR/项目文件/" 2>/dev/null || true
    
  # 2. 复制配置文件
  echo -e "${YELLOW}⚙️  复制配置文件...${NC}"
  cp package.json "$TEMP_DIR/项目文件/"
  cp package-lock.json "$TEMP_DIR/项目文件/"
  cp README.md "$TEMP_DIR/项目文件/"
  cp MANUAL_INSTALL_LEGACY.md "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  MANUAL_INSTALL_LEGACY.md not found (optional)"
    
    # 3. 复制对应架构的 DMG
    echo -e "${YELLOW}🖥️  复制 ${ARCH_TYPE} 安装器...${NC}"
    cp "$DMG_PATH" "$TEMP_DIR/第二步_双击安装.dmg"
    echo "   ✅ 已复制安装器 DMG"
    
    # 4. 创建针对该架构的 Gatekeeper 修复脚本
    echo -e "${YELLOW}🔧 创建安全修复脚本...${NC}"
    cat > "$TEMP_DIR/第一步_拖进终端回车运行.command" << 'SCRIPT_EOF'
#!/bin/bash

# ScreenSync 安全修复脚本
# 此脚本用于解除 macOS Gatekeeper 对下载文件的安全限制

clear

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║                                                        ║"
echo "║       ScreenSync 安全修复工具                          ║"
echo "║                                                        ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📁 检测到安装目录: $SCRIPT_DIR"
echo ""

# 检查 DMG 文件是否存在
DMG_FILE="$SCRIPT_DIR/第二步_双击安装.dmg"

if [ ! -f "$DMG_FILE" ]; then
    echo "❌ 错误：未找到安装器文件"
    echo "   请确保 第二步_双击安装.dmg 文件存在"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

echo "🔧 正在解除安全限制..."
echo ""

# 解除 DMG 的隔离属性
xattr -cr "$DMG_FILE" 2>/dev/null

# 解除项目文件夹的隔离属性
if [ -d "$SCRIPT_DIR/项目文件" ]; then
    xattr -cr "$SCRIPT_DIR/项目文件" 2>/dev/null
fi

echo "✅ 准备完成！"
echo ""
echo "现在可以双击 第二步_双击安装.dmg 开始安装了"
echo ""
read -p "按回车键关闭此窗口..."
SCRIPT_EOF
    chmod +x "$TEMP_DIR/第一步_拖进终端回车运行.command"
    echo "   ✅ 安全修复脚本已创建"
    
    # 5. 复制 Figma 插件文件
    echo -e "${YELLOW}🎨 复制 Figma 插件文件...${NC}"
    mkdir -p "$TEMP_DIR/项目文件/figma-plugin"
    cp figma-plugin/manifest.json "$TEMP_DIR/项目文件/figma-plugin/"
    cp figma-plugin/code.js "$TEMP_DIR/项目文件/figma-plugin/"
    cp figma-plugin/ui.html "$TEMP_DIR/项目文件/figma-plugin/"
    
    if [ -d "figma-plugin/images" ]; then
        cp -r figma-plugin/images "$TEMP_DIR/项目文件/figma-plugin/"
    fi
    
    if [ -f "figma-plugin/qr-codes.js" ]; then
        cp figma-plugin/qr-codes.js "$TEMP_DIR/项目文件/figma-plugin/"
    fi
    
    # 6. 创建 .gitignore
    echo -e "${YELLOW}📝 创建 .gitignore...${NC}"
    cat > "$TEMP_DIR/项目文件/.gitignore" << 'EOF'
node_modules/
package-lock.json
.env
.env.local
.user-config.json
.sync-mode
*.log
npm-debug.log*
.DS_Store
Thumbs.db
.vscode/
.idea/
*.swp
*.swo
*.tmp
*.temp
../ScreenSyncImg/
EOF
    
    # 7. 创建 README
    echo -e "${YELLOW}📖 创建说明文档...${NC}"
    cat > "$TEMP_DIR/README_请先阅读.txt" << EOF
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync 安装指南 (${ARCH_TYPE} 版本)              ║
║                                                        ║
╚════════════════════════════════════════════════════════╝

⚠️ 重要提示
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

此安装包适用于 ${ARCH_TYPE} 芯片的 Mac 电脑。

💡 如何确认您的 Mac 芯片类型？
   点击左上角  → 关于本机 → 查看处理器信息
   - 如果显示 "Intel"，请使用 ScreenSync-Intel.tar.gz
   - 如果显示 "Apple M1/M2/M3"，请使用 ScreenSync-Apple.tar.gz


📦 安装步骤
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

步骤 1：解决安全提示（必做）
   1. 打开"终端"应用
   2. 将 "第一步_拖进终端回车运行.command" 拖入终端窗口
   3. 按回车键运行
   4. 看到 "✅ 准备完成！" 后关闭终端

步骤 2：安装软件
   1. 双击 "第二步_双击安装.dmg"
   2. 在弹出的窗口中双击 "ScreenSync Installer"
   3. 按照图形界面提示完成配置

步骤 3：导入 Figma 插件
   1. 打开 Figma Desktop 应用
   2. 菜单：Plugins → Development → Import plugin from manifest
   3. 选择：项目文件/figma-plugin/manifest.json
   4. 点击确认完成导入

步骤 4：开始使用
   1. 在 Figma 中运行 "ScreenSync" 插件
   2. 按照提示在 iPhone 上配置快捷指令
   3. 开始截图，自动同步到 Figma！


🆘 遇到问题？
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Q: 提示"ScreenSync Installer 已损坏"怎么办？
A: 请确保已执行步骤 1 的安全修复脚本。

Q: 安装器打不开怎么办？
A: 右键点击安装器 → 打开 → 在弹窗中点击"打开"。

更多帮助请联系作者或查看项目文档。
EOF

    # 8. 创建使用说明
    cat > "$TEMP_DIR/项目文件/使用说明.txt" << 'EOF'
ScreenSync - iPhone截图自动同步到Figma

═══════════════════════════════════════════════════════

📦 安装步骤

⚠️ 步骤 1：解决安全提示（必做）
由于 macOS 安全机制，首次运行需要清除隔离属性：
1. 打开"终端"应用
2. 将"第一步_拖进终端回车运行.command"拖入终端窗口
3. 按回车键运行
4. 看到"✅ 准备完成！"后关闭终端

步骤 2：安装软件
1. 双击 "第二步_双击安装.dmg"
2. 在弹出的窗口中双击 "ScreenSync Installer"
3. 按照图形界面提示完成配置

步骤 3：导入 Figma 插件
1. 打开 Figma Desktop 应用
2. 菜单：Plugins → Development → Import plugin from manifest
3. 浏览并选择：{安装目录}/figma-plugin/manifest.json
4. 点击确认完成导入

步骤 4：开始使用
1. 在 Figma 中运行 "ScreenSync" 插件
2. 选择同步模式
3. 在 iPhone 上按照提示配置快捷指令
4. 开始截图，自动同步到 Figma！

═══════════════════════════════════════════════════════

🔄 自动更新

插件支持自动更新功能：
1. 打开 Figma 插件时会自动检查更新
2. 如有新版本，顶部会显示更新通知
3. 点击"立即更新"按钮，等待更新完成
4. 关闭并重新打开插件即可使用新版本

EOF

    # 9. 创建版本信息
    cat > "$TEMP_DIR/项目文件/VERSION.txt" << EOF
ScreenSync 用户分发包 (${ARCH_TYPE} 版本)
版本: ${VERSION}
打包日期: $(date +"%Y-%m-%d %H:%M:%S")
EOF

    # 10. 打包
    echo -e "${GREEN}📦 创建压缩包...${NC}"
    cd /tmp
    tar -czf "${PACKAGE_NAME}.tar.gz" "${PACKAGE_NAME}/"
    cd - > /dev/null
    
    # 11. 移动到当前目录
    mv "/tmp/${PACKAGE_NAME}.tar.gz" "./${PACKAGE_NAME}.tar.gz"
    
    # 12. 清理临时目录
    rm -rf "$TEMP_DIR"
    
    # 显示结果
    local PACKAGE_SIZE=$(du -h "${PACKAGE_NAME}.tar.gz" | cut -f1)
    echo -e "${GREEN}✅ ${ARCH_TYPE} 版本打包完成: ${PACKAGE_NAME}.tar.gz (${PACKAGE_SIZE})${NC}"
}

# ========================================
# 主流程：创建两个独立的安装包
# ========================================

echo -e "${GREEN}📦 开始打包...${NC}"

# 创建 Intel 版本
create_package "Intel" "$DMG_INTEL" "ScreenSync-Intel"

# 创建 Apple Silicon 版本
create_package "Apple" "$DMG_ARM" "ScreenSync-Apple"

# 显示最终结果
echo -e "\n${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    打包全部完成！                      ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}\n"

INTEL_SIZE=$(du -h "ScreenSync-Intel.tar.gz" | cut -f1)
APPLE_SIZE=$(du -h "ScreenSync-Apple.tar.gz" | cut -f1)

echo -e "${BLUE}📦 生成的安装包：${NC}"
echo -e "   ${GREEN}✅ ScreenSync-Intel.tar.gz${NC} (${INTEL_SIZE}) - Intel 芯片 Mac"
echo -e "   ${GREEN}✅ ScreenSync-Apple.tar.gz${NC} (${APPLE_SIZE}) - Apple 芯片 Mac (M1/M2/M3)"
echo ""
echo -e "${YELLOW}📋 发布说明：${NC}"
echo -e "   - Intel 芯片用户下载 ScreenSync-Intel.tar.gz"
echo -e "   - Apple 芯片用户下载 ScreenSync-Apple.tar.gz"
echo -e "   - 用户可通过  → 关于本机 查看芯片类型"
echo ""
