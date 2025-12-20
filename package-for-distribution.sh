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

# 清理不应打包的文件（日志、临时文件等）
echo -e "${YELLOW}🧹 清理临时文件和日志...${NC}"
rm -f *.log 2>/dev/null || true
rm -f server-error.log 2>/dev/null || true
rm -f .user-config.json 2>/dev/null || true
rm -f .sync-mode 2>/dev/null || true
echo "   ✅ 清理完成"

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

# 优先复制 DMG 文件（压缩过的），如果不存在则复制 .app
DMG_FILE=""
# 查找最新的 arm64 DMG 文件
if [ -n "$(find installer/dist -name "*.dmg" -type f 2>/dev/null)" ]; then
    # 优先选择 arm64 版本
    DMG_FILE=$(find installer/dist -name "*arm64.dmg" -type f | sort -V | tail -1)
    # 如果没有 arm64，选择通用版本
    if [ -z "$DMG_FILE" ]; then
        DMG_FILE=$(find installer/dist -name "*.dmg" -type f | grep -v "arm64" | sort -V | tail -1)
    fi
fi

if [ -n "$DMG_FILE" ] && [ -f "$DMG_FILE" ]; then
    # 重命名 DMG 为更清晰的步骤指引
    cp "$DMG_FILE" "$TEMP_DIR/第二步_双击安装.dmg"
    DMG_NAME="第二步_双击安装.dmg"
    echo "   ✅ 已包含安装器磁盘映像: $DMG_NAME (压缩版)"
else
    # 回退到 .app 目录（如果存在）
    if [ -d "$INSTALLER_APP" ]; then
        cp -r "$INSTALLER_APP" "$TEMP_DIR/" 2>/dev/null || {
            echo -e "${RED}❌ 复制 GUI 安装器失败${NC}"
            exit 1
        }
        echo "   ✅ GUI 安装器已包含（首层目录）"
    else
        echo -e "${RED}❌ 未找到 DMG 文件或 .app 目录${NC}"
        exit 1
    fi
fi

# 复制 Gatekeeper 修复脚本（放在首层）
if [ -f "第一步_拖进终端回车运行.command" ]; then
    cp "第一步_拖进终端回车运行.command" "$TEMP_DIR/"
    chmod +x "$TEMP_DIR/第一步_拖进终端回车运行.command"
    echo "   ✅ Gatekeeper 修复脚本已包含（首层目录）"
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

# 本地下载文件夹（用户数据，位于安装目录的上级目录，与项目目录同级）
../ScreenSyncImg/
EOF

# 6. 创建使用说明文件（到二级目录）
echo -e "${YELLOW}📖 创建使用说明...${NC}"
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
1. 双击 "ScreenSync Installer.dmg" 挂载安装盘
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

⚙️ 储存方式

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
A: 请执行步骤 1 中的脚本修复。

Q: 安装器在哪里？
A: 解压后的文件夹中，名为 "ScreenSync Installer.dmg"，双击后即可看到安装器

Q: 如何找到 manifest.json？
A: 安装完成后，在安装目录下的 figma-plugin 文件夹中

Q: 服务器会自动启动吗？
A: 是的，服务器已配置为开机自动启动。

Q: 插件显示"连接断开"怎么办？
A: 这种情况极少见。如果点击插件中的"重新连接"按钮无效，请联系作者获取帮助。

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

# 7. 创建插件介绍文档（放在首层）
echo -e "${YELLOW}📋 创建插件介绍文档...${NC}"
cat > "$TEMP_DIR/README_插件介绍.txt" << 'EOF'
ScreenSync 插件 - 自动化传输并整理截图

ScreenSync 是一款为设计师打造的手机截图同步插件。手机上的截图与录屏可自动整理并即时导入 Figma，不占用本地空间，也无需依赖 AirDrop、微信等方式，让素材流转更轻量、更直接、更高效。

----------------------------------------
一、插件适用场景
----------------------------------------
1. 设计工作：需要收集竞品截图并快速放入 Figma 中参考。
2. 设计走查：用于与设计稿对比、验收和标注。
3. 汇报场景：评审或会议中需要快速补充手机截图到 Figma。
4. 日常灵感收集：将日常截图/录屏沉淀为灵感库，在 Figma 中统一整理。

----------------------------------------
二、功能介绍
----------------------------------------

【手机端功能】

1. 特殊手势截图（即传即空）
绑定一个独立的手势触发截图。截图会直接上传到云端，不会进入相册，也不会影响系统原生截图方式。适合低频截图（约 10 秒以上间隔）。连续快速截图可能出现轻微延迟。

2. 系统截图 → 多张预览一并上传
适合快速、高频、多张截图。使用 iOS 系统自带截图方式后，在左下角的预览界面即可多选上传，也可以选择不保存到相册。

3. 相册选择上传（支持录屏）
可进入相册，从已有截图或录屏中多选上传。录屏可自动转换为 GIF。本模式仅处理截图和录屏，不会处理普通照片或视频，避免误选。

【电脑端功能】

1. 实时同步
需保持插件开启。手机截图后能立即同步进 Figma，适合工作场景。

2. 手动同步
插件无需持续开启。日常使用中可随时截图，进入插件后一次性同步自上次以来的所有文件。

----------------------------------------
三、安装步骤
----------------------------------------

1. 前往最新版发布页下载：
https://github.com/BorderWalker99/figma-plugin-figma_sync/releases/latest

下载文件：ScreenSync-UserPackage.tar.gz

2. 安装插件
(1) 打开终端，将安装包中的 "第一步_拖进终端回车运行.command" 拖入终端并回车执行。
(2) 双击 ${DMG_NAME} 进行安装。
(3) 在 Figma 中，通过 Import from manifest 导入：
ScreenSync-UserPackage/figma-plugin/manifest.json

----------------------------------------
四、配置手机快捷指令
----------------------------------------

1. 使用手机扫描插件右上角提供的两个二维码，安装两条快捷指令。
若使用 Google Cloud 模式，需要将插件提供的 User ID 填入快捷指令中的文本框。

2. 绑定截图触发方式（三选一）
a. 操作按钮（iPhone 15+ 推荐）：最稳定的物理触发方式，不易误触。
b. 双击背面触发：可能存在误触情况。
c. 辅助触控触发：稳定可靠，但可能截到辅助控件。

3. 将相册选择功能置顶
打开相册 → 任意截图 → 分享 → 编辑操作 → 将 ScreenSync - Album 加入个人收藏。

----------------------------------------
五、使用说明
----------------------------------------

1. 打开插件后选择同步模式（实时或手动）。
2. 所有导入图片会自动加入 Auto Layout，方便整理，可在设置中调整是否自动换行。
3. 默认保持真实机型尺寸，可在设置中写死尺寸，便于多机型对比。
4. 视频文件无法自动导入 Figma，插件会提示需手动导入并跳转到对应文件夹。
5. 若开启“保存 GIF”，GIF 导入 Figma 后不会被删除，并会提示“已保存 X 段 GIF”，点击可查看本地保存的 GIF 文件。
6. 可点击右上角按钮将插件界面最小化。

----------------------------------------
六、更新说明
----------------------------------------
若有版本更新，打开插件时会自动提示，可一键完成升级。

----------------------------------------
七、常见问题
----------------------------------------

1. 是否支持安卓？
目前仅支持 iOS。安卓需自行实现类似的触发方式或等待后续版本。

2. iCloud 用户注意事项
iOS 系统截图通常为 HEIC，如需其他格式可在快捷指令中转换为 JPEG 或 PNG。

3. Google Cloud 用户须知
连接海外网络可显著提升上传速度。

----------------------------------------
END
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
echo "   ✅ 第一步_拖进终端回车运行.command（Gatekeeper 修复）"
echo "   ✅ 第二步_双击安装.dmg（图形化安装器）"
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
echo -e "${BLUE}║     将"安装前:将此文件拖进终端按回车运行"拖入终端并回车   ║${NC}"
echo -e "${BLUE}║  4. 双击 ScreenSync Installer.dmg 运行安装器              ║${NC}"
echo -e "${BLUE}║  5. 按照图形界面完成安装                                   ║${NC}"
echo -e "${BLUE}║  6. 在 Figma 中导入插件：                                  ║${NC}"
echo -e "${BLUE}║     Plugins → Development → Import plugin from manifest   ║${NC}"
echo -e "${BLUE}║  7. 选择：{安装目录}/项目文件/figma-plugin/manifest.json   ║${NC}"
echo -e "${BLUE}║                                                            ║${NC}"
echo -e "${BLUE}║  💡 若连接断开（极少见）：                                 ║${NC}"
echo -e "${BLUE}║     优先使用插件内"点击重连"按钮                           ║${NC}"
echo -e "${BLUE}║     或联系作者获取帮助                                     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}\n"

