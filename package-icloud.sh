#!/bin/bash

# ScreenSync 双模式版本打包脚本
# 此版本支持 Google Drive 和 iCloud 模式自由切换
# 默认使用 Google Drive 模式，模式切换功能隐藏（可通过 console 开启）

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ScreenSync 双模式版本打包脚本         ║${NC}"
echo -e "${BLUE}║  支持 Google Drive / iCloud 自由切换   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 检查 Apple 芯片版本的 DMG 是否存在
DMG_ARM=$(find installer/dist -name "*arm64.dmg" -type f 2>/dev/null | sort -V | tail -1)

if [ -z "$DMG_ARM" ] || [ ! -f "$DMG_ARM" ]; then
    echo -e "${YELLOW}🔨 未找到 Apple Silicon DMG，正在构建...${NC}"
    cd installer
    if [ -d "dist" ]; then
        rm -rf dist
        echo -e "   ✅ 已清理旧的 dist/ 目录"
    fi
    npm install
    npm run build:mac
    cd ..
    DMG_ARM=$(find installer/dist -name "*arm64.dmg" -type f | sort -V | tail -1)
    
    if [ -z "$DMG_ARM" ] || [ ! -f "$DMG_ARM" ]; then
        echo -e "${RED}❌ 错误：无法找到或构建 Apple Silicon DMG${NC}"
        exit 1
    fi
fi

echo -e "${GREEN}✅ 找到 Apple Silicon 版本: $DMG_ARM${NC}\n"

# 检查必要文件是否存在
if [ ! -f "icloud-watcher.js" ]; then
    echo -e "${RED}❌ 错误：icloud-watcher.js 不存在${NC}"
    exit 1
fi

if [ ! -f "drive-watcher.js" ]; then
    echo -e "${RED}❌ 错误：drive-watcher.js 不存在${NC}"
    exit 1
fi

if [ ! -f "start.js" ]; then
    echo -e "${RED}❌ 错误：start.js 不存在${NC}"
    exit 1
fi

# 获取版本号
VERSION=$(date +"%Y%m%d")
PACKAGE_NAME="ScreenSync-iCloud"
TEMP_DIR="/tmp/${PACKAGE_NAME}"

echo -e "${GREEN}📦 开始打包 iCloud 专用版本...${NC}\n"

# 清理临时目录
if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi
mkdir -p "$TEMP_DIR"
mkdir -p "$TEMP_DIR/项目文件"

# 清理临时文件和日志
echo -e "${YELLOW}🧹 清理临时文件和日志...${NC}"
rm -f *.log 2>/dev/null || true
rm -f server-error.log 2>/dev/null || true
rm -f .user-config.json 2>/dev/null || true
rm -f .sync-mode 2>/dev/null || true
echo "   ✅ 清理完成"

# 1. 复制核心文件（支持双模式）
echo -e "${YELLOW}📄 复制核心文件（双模式版本）...${NC}"
cp server.js "$TEMP_DIR/项目文件/"
cp userConfig.js "$TEMP_DIR/项目文件/"
cp start.js "$TEMP_DIR/项目文件/"
cp update-manager.js "$TEMP_DIR/项目文件/"
# Google Drive 模式需要的文件
cp drive-watcher.js "$TEMP_DIR/项目文件/"
cp googleDrive.js "$TEMP_DIR/项目文件/" 2>/dev/null || true
# iCloud 模式需要的文件
cp icloud-watcher.js "$TEMP_DIR/项目文件/"
cp com.screensync.server.plist "$TEMP_DIR/项目文件/" 2>/dev/null || true
echo "   ✅ 核心文件已复制（支持 Google Drive 和 iCloud 双模式）"

# 2. 复制配置文件
echo -e "${YELLOW}⚙️  复制配置文件...${NC}"
cp package.json "$TEMP_DIR/项目文件/"
cp package-lock.json "$TEMP_DIR/项目文件/"
cp README.md "$TEMP_DIR/项目文件/"
cp MANUAL_INSTALL_LEGACY.md "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  MANUAL_INSTALL_LEGACY.md not found (optional)"

# 3. 创建 .sync-mode 文件，默认 Google Drive 模式
echo "drive" > "$TEMP_DIR/项目文件/.sync-mode"
echo "   ✅ 默认模式已设置为 Google Drive"

# 3. 复制 Apple Silicon DMG
echo -e "${YELLOW}🖥️  复制 Apple Silicon 安装器...${NC}"
cp "$DMG_ARM" "$TEMP_DIR/第二步_双击安装.dmg"
echo "   ✅ 已复制安装器 DMG"

# 4. 创建安全修复脚本
echo -e "${YELLOW}🔧 创建安全修复脚本...${NC}"
cat > "$TEMP_DIR/第一步_拖进终端回车运行.command" << 'SCRIPT_EOF'
#!/bin/bash

# ScreenSync 安全修复脚本 (双模式版)
# 此脚本用于解除 macOS Gatekeeper 对下载文件的安全限制

clear

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║                                                        ║"
echo "║       ScreenSync 安全修复工具 (双模式版)               ║"
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
echo "📱 双模式版说明："
echo "   - 默认使用 Google Drive 模式"
echo "   - 支持切换到 iCloud 模式（通过设置）"
echo "   - 模式切换后永久保存，无需重复设置"
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
cat > "$TEMP_DIR/README_请先阅读.txt" << 'EOF'
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync 安装指南 (双模式版)                   ║
║                                                        ║
╚════════════════════════════════════════════════════════╝

⚠️ 重要提示
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

此安装包支持 Google Drive 和 iCloud 双模式，适用于 Apple 芯片 Mac。
📱 默认使用 Google Drive 模式
🌥️ 可切换到 iCloud 模式（模式切换功能隐藏，见下方说明）


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

步骤 4：配置 iPhone 快捷指令
   1. 在 iPhone 上打开快捷指令 App
   2. 扫描插件中显示的对应模式二维码
   3. 按照提示完成配置


🔄 如何切换模式
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

模式切换功能默认隐藏。如需切换到 iCloud 模式：

1. 在 Figma 中打开 ScreenSync 插件
2. 打开浏览器开发者工具 (右键 → 检查 或 F12)
3. 在 Console 中输入以下代码并回车：
   
   document.getElementById('modeSwitchSection').style.display = ''
   
4. 现在可以在设置中看到模式切换选项
5. 点击 iCloud 图标切换到 iCloud 模式
6. 切换后会永久保存，无需重复设置


📱 使用方法
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 在 Figma 中打开 ScreenSync 插件
2. 点击中间的"实时同步"按钮开启监听
3. 在 iPhone 上截图或使用快捷指令
4. 截图会自动同步到 Figma！


📂 iCloud 模式特性
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✨ 文件自动分类：
   - 图片文件自动分类到 "图片" 子文件夹
   - 视频文件自动分类到 "视频" 子文件夹
   - GIF 文件自动分类到 "GIF" 子文件夹
   - 导出的 GIF 保存到 "导出的GIF" 子文件夹

✨ 选择性清理：
   通过插件设置中的"备份到本地"选项控制哪些文件在导入后保留

💡 iCloud 模式的截图保存路径：
   ~/Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg/


🆘 遇到问题？
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Q: 提示"ScreenSync Installer 已损坏"怎么办？
A: 请确保已执行步骤 1 的安全修复脚本。

Q: 如何从 iCloud 切回 Google Drive？
A: 使用同样的方法显示模式切换区域，点击 Google Cloud 图标即可。

Q: 插件显示"等待连接"怎么办？
A: 确保服务已启动。可以在终端中运行 start.js 手动启动。

更多帮助请联系作者或查看项目文档。
EOF

# 8. 创建使用说明
cat > "$TEMP_DIR/项目文件/使用说明.txt" << 'EOF'
ScreenSync - iPhone截图自动同步到Figma (双模式版)

═══════════════════════════════════════════════════════

📱 双模式版说明

此版本支持 Google Drive 和 iCloud 两种模式自由切换！
- 默认使用 Google Drive 模式
- 可切换到 iCloud 模式（模式切换功能隐藏）
- 切换后永久保存设置

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

═══════════════════════════════════════════════════════

🔄 如何切换模式

模式切换功能默认隐藏。如需切换：
1. 在 Figma 中打开 ScreenSync 插件
2. 打开开发者工具 (右键 → 检查)
3. 在 Console 中输入：
   document.getElementById('modeSwitchSection').style.display = ''
4. 现在可以在设置中看到模式切换选项

═══════════════════════════════════════════════════════

📂 iCloud 模式文件自动分类

iCloud 模式会自动将文件分类到子文件夹：
- 图片 → "图片" 文件夹
- 视频 → "视频" 文件夹
- GIF → "GIF" 文件夹
- 导出的GIF → "导出的GIF" 文件夹

EOF

# 9. 创建版本信息
cat > "$TEMP_DIR/项目文件/VERSION.txt" << EOF
ScreenSync 用户分发包 (双模式版)
版本: ${VERSION}
打包日期: $(date +"%Y-%m-%d %H:%M:%S")
特性: 
  - 支持 Google Drive / iCloud 双模式
  - 模式切换后永久保存
  - iCloud 模式支持文件自动分类
  - iCloud 模式支持选择性清理
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
PACKAGE_SIZE=$(du -h "${PACKAGE_NAME}.tar.gz" | cut -f1)

echo -e "\n${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    打包完成！                          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}\n"

echo -e "${BLUE}📦 生成的安装包：${NC}"
echo -e "   ${GREEN}✅ ${PACKAGE_NAME}.tar.gz${NC} (${PACKAGE_SIZE})"
echo ""
echo -e "${YELLOW}📋 双模式版特性：${NC}"
echo -e "   - 📱 默认 Google Drive 模式"
echo -e "   - 🌥️  支持切换到 iCloud 模式"
echo -e "   - 💾 模式切换后永久保存设置"
echo -e "   - 🔒 模式切换功能隐藏（可通过 console 开启）"
echo ""
echo -e "${BLUE}💡 使用说明：${NC}"
echo -e "   1. 解压后默认为 Google Drive 模式"
echo -e "   2. 如需切换到 iCloud 模式，见 README_请先阅读.txt"
echo -e "   3. 切换后永久保存，无需重复设置"
echo ""
