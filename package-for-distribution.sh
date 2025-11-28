#!/bin/bash

# ScreenSync 用户分发打包脚本（GUI 安装器版本）
# 此脚本会打包 GUI 安装器和所有必需的项目文件

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ScreenSync 用户分发打包脚本          ║${NC}"
echo -e "${BLUE}║  (GUI 安装器版本)                     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 检查 GUI 安装器是否已构建
echo -e "${YELLOW}🔍 检查 GUI 安装器...${NC}"
INSTALLER_APP=""
if [ -d "installer/dist/mac-arm64/ScreenSync Installer.app" ]; then
    INSTALLER_APP="installer/dist/mac-arm64/ScreenSync Installer.app"
elif [ -d "installer/dist/mac/ScreenSync Installer.app" ]; then
    INSTALLER_APP="installer/dist/mac/ScreenSync Installer.app"
else
    echo -e "${RED}❌ 错误：未找到 GUI 安装器${NC}"
    echo -e "${YELLOW}请先构建 GUI 安装器：${NC}"
    echo "   cd installer"
    echo "   npm install"
    echo "   npm run build"
    echo ""
    exit 1
fi
echo -e "${GREEN}✅ GUI 安装器已就绪: $INSTALLER_APP${NC}\n"

# 获取当前目录名和版本号
CURRENT_DIR=$(basename "$PWD")
VERSION=$(date +"%Y%m%d")
PACKAGE_NAME="ScreenSync-UserPackage"
TEMP_DIR="/tmp/${PACKAGE_NAME}"

# 清理临时目录
if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi
mkdir -p "$TEMP_DIR"
# 创建二级目录存放其他文件
mkdir -p "$TEMP_DIR/项目文件"

echo -e "${GREEN}📦 开始打包...${NC}\n"

# 0. 创建 README 和使用说明
echo -e "${YELLOW}📝 创建说明文档...${NC}"

# 1. 复制核心服务器文件（到二级目录）
echo -e "${YELLOW}📄 复制核心服务器文件...${NC}"
cp server.js "$TEMP_DIR/项目文件/"
cp googleDrive.js "$TEMP_DIR/项目文件/"
cp aliyunOSS.js "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  aliyunOSS.js 不存在（可选）"
cp userConfig.js "$TEMP_DIR/项目文件/"
cp serviceAccountKey.js "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  serviceAccountKey.js 不存在（可选，仅部署者需要）"
cp start.js "$TEMP_DIR/项目文件/"
cp update-manager.js "$TEMP_DIR/项目文件/"
cp icloud-watcher.js "$TEMP_DIR/项目文件/"
cp drive-watcher.js "$TEMP_DIR/项目文件/"
cp aliyun-watcher.js "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  aliyun-watcher.js 不存在（可选）"
cp com.screensync.server.plist "$TEMP_DIR/项目文件/" 2>/dev/null || echo "   ⚠️  自动启动配置文件已包含"

# 2. 复制配置文件（到二级目录）
echo -e "${YELLOW}⚙️  复制配置文件...${NC}"
cp package.json "$TEMP_DIR/项目文件/"
cp package-lock.json "$TEMP_DIR/项目文件/"
cp README.md "$TEMP_DIR/项目文件/"

# 3. 复制 GUI 安装器（必需，放在首层）
echo -e "${YELLOW}🖥️  复制 GUI 安装器...${NC}"
cp -r "$INSTALLER_APP" "$TEMP_DIR/" 2>/dev/null || {
    echo -e "${RED}❌ 复制 GUI 安装器失败${NC}"
    exit 1
}
echo "   ✅ GUI 安装器已包含（首层目录）"

# 复制 Gatekeeper 修复脚本（放在首层）
if [ -f "将此文件拖入终端运行.command" ]; then
    cp "将此文件拖入终端运行.command" "$TEMP_DIR/"
    chmod +x "$TEMP_DIR/将此文件拖入终端运行.command"
    echo "   ✅ Gatekeeper 修复脚本已包含（首层目录）"
fi

# 复制手动连接脚本（重命名后放在首层）
if [ -f "Manual_Start_Server.command" ]; then
    cp "Manual_Start_Server.command" "$TEMP_DIR/若连接断开将此文件拖入终端手动连接.command"
    chmod +x "$TEMP_DIR/若连接断开将此文件拖入终端手动连接.command"
    echo "   ✅ 手动连接脚本已包含（首层目录，已重命名）"
fi

# 4. 复制 Figma 插件文件（排除 node_modules，到二级目录）
echo -e "${YELLOW}🎨 复制 Figma 插件文件...${NC}"
mkdir -p "$TEMP_DIR/项目文件/figma-plugin"
cp figma-plugin/manifest.json "$TEMP_DIR/项目文件/figma-plugin/"
cp figma-plugin/code.js "$TEMP_DIR/项目文件/figma-plugin/"
cp figma-plugin/ui.html "$TEMP_DIR/项目文件/figma-plugin/"

# 复制插件图片资源
if [ -d "figma-plugin/images" ]; then
    cp -r figma-plugin/images "$TEMP_DIR/项目文件/figma-plugin/"
fi

# 复制 qr-codes.js（如果存在）
if [ -f "figma-plugin/qr-codes.js" ]; then
    cp figma-plugin/qr-codes.js "$TEMP_DIR/项目文件/figma-plugin/"
fi

# 5. 创建 .gitignore（用于用户自己的版本控制，到二级目录）
echo -e "${YELLOW}📝 创建 .gitignore...${NC}"
cat > "$TEMP_DIR/项目文件/.gitignore" << 'EOF'
# 依赖
node_modules/
package-lock.json

# 环境变量
.env
.env.local

# 配置文件（用户特定）
.user-config.json
.sync-mode

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

# 本地下载文件夹（用户数据）
ScreenSyncImg/
EOF

# 6. 创建使用说明文件（到二级目录）
echo -e "${YELLOW}📖 创建使用说明...${NC}"
cat > "$TEMP_DIR/项目文件/使用说明.txt" << 'EOF'
ScreenSync - iPhone截图自动同步到Figma

═══════════════════════════════════════════════════════

📦 安装步骤

⚠️ 步骤 1：第一次运行（解决安全提示）
如果双击 ScreenSync Installer.app 提示"无法打开"或"已损坏"：
1. 打开"终端"应用（可在启动台中搜索"终端"）
2. 将"将此文件拖入终端运行.command"拖入终端窗口
3. 按回车键运行脚本
4. 看到"✅ 准备完成！"后关闭终端

步骤 2：配置安装
1. 双击 "ScreenSync Installer.app"
2. 安装器启动后，按照图形界面提示完成以下配置：
   - 选择储存方式（Google Cloud 或 iCloud）
   - 自动检测并安装 Homebrew 和 Node.js
   - 自动安装项目依赖
   - 自动配置并启动服务
   
   ⚠️ 注意：服务器会自动启动，无需手动操作终端

步骤 2：导入 Figma 插件
1. 打开 Figma Desktop 应用
2. 菜单：Plugins → Development → Import plugin from manifest
3. 浏览并选择：{安装目录}/figma-plugin/manifest.json
4. 点击确认完成导入

步骤 3：开始使用
1. 在 Figma 中运行 "ScreenSync" 插件
2. 选择同步模式（实时同步或手动同步）
3. 在 iPhone 上按照提示配置快捷指令
4. 开始截图，自动同步到 Figma！

═══════════════════════════════════════════════════════

⚙️ 储存方式

支持三种储存方式：

1. Google Cloud 储存（推荐）
   - iCloud 无空间也可使用
   - 支持 GIF 自动下载到本地备份
   - 设置中可开启"GIF 保存到本地"开关
   - 需要在 iPhone 快捷指令中配置 User ID

2. iCloud 储存
   - 使用本地 iCloud Drive 文件夹
   - 隐私性更好，数据不经过第三方服务器
   - 支持 GIF 保留在文件夹
   - 设置中可开启"GIF 保留在文件夹"开关
   - 需要 iCloud 有足够可用空间
   - 安装时会自动检测空间是否充足

3. 阿里云 OSS 储存
   - 适合中国大陆用户
   - 需要自行配置阿里云 OSS（参考 ALIYUN_OSS_SETUP.md）

═══════════════════════════════════════════════════════

🎬 GIF 和视频文件处理

- 视频文件（MP4/MOV）和过大的 GIF 文件无法自动导入 Figma
- 这些文件会自动保存到本地文件夹，可手动拖入 Figma
- Google Cloud 模式：可在设置中开启"GIF 保存到本地"
- iCloud 模式：可在设置中开启"GIF 保留在文件夹"
- 重名文件会自动替换，不会保留多个副本

═══════════════════════════════════════════════════════

🔄 自动更新

- 插件会自动检测新版本
- 在设置中可一键更新插件和服务器
- 无需手动下载或重新安装

═══════════════════════════════════════════════════════

💡 常见问题

Q: 提示"ScreenSync Installer 已损坏"怎么办？
A: 这是 macOS 安全机制。解决方法：
   1. 将"将此文件拖入终端运行.command"拖入终端窗口
   2. 按回车键运行
   3. 完成后再双击 ScreenSync Installer.app
   
   或者右键点击应用 → 选择"打开" → 点击"打开"

Q: 安装器在哪里？
A: 解压后的文件夹中，名为 "ScreenSync Installer.app"

Q: 如何找到 manifest.json？
A: 安装完成后，在安装目录下的 figma-plugin 文件夹中

Q: Google Cloud 模式的 User ID 在哪里？
A: 安装完成后会显示，也可在安装目录下的 .user-config.json 文件中查看

Q: 服务器会自动启动吗？
A: 是的，服务器已配置为：
   - 开机自动启动
   - 崩溃自动恢复（最多3次）
   - 打开 Figma 插件时应该已经在后台运行

Q: 插件显示"连接断开"怎么办？
A: 这种情况极少见，但如果发生：
   
   方法1（推荐）：点击插件中的"重新连接"按钮
   - 插件会自动尝试重新连接
   - 如果连接失败，会自动修复服务
   - 完全在 Figma 界面内完成，无需终端操作
   
   方法2（备选）：使用手动启动脚本
   1. 将 "Manual_Start_Server.command" 拖入终端
   2. 选择模式 [3] 重新配置自动启动
   
   方法3（高级）：终端运行：launchctl restart com.screensync.server

Q: 如何检查服务器是否在运行？
A: 终端运行：lsof -i :8888
   如果有输出，说明服务器正在运行

Q: 如何停止服务？
A: 终端运行：launchctl stop com.screensync.server
   （服务器会在下次开机时自动启动）

Q: 如何更换储存方式？
A: 在 Figma 插件的设置中可以直接切换

═══════════════════════════════════════════════════════
EOF

# 7. 创建快速开始指南（放在首层）
echo -e "${YELLOW}📋 创建快速开始指南...${NC}"
cat > "$TEMP_DIR/README_请先阅读.txt" << 'EOF'
╔════════════════════════════════════════════════════════╗
║                                                        ║
║       ScreenSync - iPhone 截图自动同步到 Figma        ║
║                                                        ║
╚════════════════════════════════════════════════════════╝


📖 快速开始指南
═══════════════════════════════════════════════════════

⚠️ 第一次打开必须这样做（解决 macOS 安全提示）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

由于应用未经 Apple 公证，直接双击可能会被 macOS 阻止。

如果双击 ScreenSync Installer.app 提示"无法打开"或"已损坏"：

方法一（推荐）：使用修复脚本
1. 打开"终端"应用（在启动台中搜索"终端"）
2. 将文件"将此文件拖入终端运行.command"拖入终端窗口
3. 按回车键运行脚本
4. 看到"✅ 准备完成！"后关闭终端

方法二：手动操作
1. 【右键点击】"ScreenSync Installer.app"
2. 选择【打开】，然后在弹窗中点击【打开】

✅ 之后您可以正常双击打开 "ScreenSync Installer.app" 进行安装。


第二步：完成安装
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 按照图形界面提示完成安装：
   ✓ 选择储存方式（Google Cloud 或 iCloud）
   ✓ 自动安装依赖（Homebrew、Node.js）
   ✓ 自动配置并启动服务
   
   ⚠️ 注意：服务器已配置为开机自动启动，打开插件时服务器已在后台运行


第三步：导入 Figma 插件
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 打开 Figma Desktop 应用
2. 点击菜单：Plugins → Development → Import plugin from manifest
3. 选择文件：{安装目录}/项目文件/figma-plugin/manifest.json
4. 完成导入


第四步：开始使用
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 在 Figma 中运行 "ScreenSync" 插件
2. 选择同步模式（实时同步或手动同步）
3. 在 iPhone 上配置快捷指令（插件中有详细说明）
4. 开始截图，自动同步到 Figma！


═══════════════════════════════════════════════════════

💡 提示

• 详细使用说明请查看"项目文件/使用说明.txt"
• 支持一键自动更新（插件设置中）
• Google Cloud 模式的 User ID 在安装完成时会显示
• 若连接断开（极少见），优先点击插件内"点击重连"按钮

═══════════════════════════════════════════════════════
EOF

# 8. 创建版本信息文件（到二级目录）
echo -e "${YELLOW}📋 创建版本信息...${NC}"
cat > "$TEMP_DIR/项目文件/VERSION.txt" << EOF
ScreenSync 用户分发包
版本: ${VERSION}
打包日期: $(date +"%Y-%m-%d %H:%M:%S")
EOF

# 9. 打包成 tar.gz
echo -e "\n${GREEN}📦 创建压缩包...${NC}"
cd /tmp
tar -czf "${PACKAGE_NAME}.tar.gz" "${PACKAGE_NAME}/"
cd - > /dev/null

# 10. 移动到当前目录
mv "/tmp/${PACKAGE_NAME}.tar.gz" "./${PACKAGE_NAME}.tar.gz"

# 11. 清理临时目录
rm -rf "$TEMP_DIR"

# 显示结果
PACKAGE_SIZE=$(du -h "${PACKAGE_NAME}.tar.gz" | cut -f1)

echo -e "\n${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  打包完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
echo -e "${GREEN}✅ 文件包: ${PACKAGE_NAME}.tar.gz${NC}"
echo -e "${GREEN}✅ 大小: ${PACKAGE_SIZE}${NC}\n"
echo -e "${YELLOW}📦 包含内容：${NC}"
echo ""
echo -e "${GREEN}首层目录（用户直接看到）：${NC}"
echo "   ✅ README_请先阅读.txt"
echo "   ✅ 将此文件拖入终端运行.command（Gatekeeper 修复）"
echo "   ✅ ScreenSync Installer.app（图形化安装器）"
echo "   ✅ 若连接断开将此文件拖入终端手动连接.command（备用连接方案）"
echo ""
echo -e "${BLUE}项目文件/目录（安装所需的所有文件）：${NC}"
echo "   ✅ 核心服务器文件（server.js, start.js, update-manager.js）"
echo "   ✅ 监听器文件（drive-watcher.js, icloud-watcher.js, aliyun-watcher.js）"
echo "   ✅ 云服务集成（googleDrive.js, aliyunOSS.js）"
echo "   ✅ 配置文件（userConfig.js, package.json）"
echo "   ✅ Figma 插件文件（figma-plugin/完整插件代码和资源）"
echo "   ✅ 使用说明和文档（使用说明.txt, VERSION.txt）"
echo ""
echo -e "${YELLOW}❌ 已排除：${NC}"
echo "   - 安装脚本（已替换为 GUI 安装器）"
echo "   - Dockerfile（部署相关）"
echo "   - deploy-*.sh（部署相关脚本）"
echo "   - installer 源码（已编译为 .app）"
echo "   - node_modules（依赖由安装器自动安装）"
echo "   - .env（敏感信息）"
echo "   - serviceAccountKey.js（可选，仅部署者需要）"
echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  用户使用流程（认知负担最轻）：                            ║${NC}"
echo -e "${BLUE}║  1. 解压文件包                                             ║${NC}"
echo -e "${BLUE}║  2. 阅读 README_请先阅读.txt                               ║${NC}"
echo -e "${BLUE}║  3. 如提示安全问题：                                       ║${NC}"
echo -e "${BLUE}║     将"将此文件拖入终端运行.command"拖入终端并按回车      ║${NC}"
echo -e "${BLUE}║  4. 双击 ScreenSync Installer.app 运行安装器              ║${NC}"
echo -e "${BLUE}║  5. 按照图形界面完成安装                                   ║${NC}"
echo -e "${BLUE}║  6. 在 Figma 中导入插件：                                  ║${NC}"
echo -e "${BLUE}║     Plugins → Development → Import plugin from manifest   ║${NC}"
echo -e "${BLUE}║  7. 选择：{安装目录}/项目文件/figma-plugin/manifest.json   ║${NC}"
echo -e "${BLUE}║                                                            ║${NC}"
echo -e "${BLUE}║  💡 若连接断开（极少见）：                                 ║${NC}"
echo -e "${BLUE}║     优先使用插件内"点击重连"按钮                           ║${NC}"
echo -e "${BLUE}║     或将"若连接断开..."文件拖入终端                        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}\n"

