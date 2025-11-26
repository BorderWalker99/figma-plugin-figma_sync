#!/bin/bash

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_step() {
    echo -e "\n${BLUE}===================================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}===================================================${NC}\n"
}

# 清屏
clear

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 显示欢迎信息
echo -e "${GREEN}"
cat << "EOF"
╔════════════════════════════════════════════════════╗
║                                                    ║
║      iPhone截图自动同步到Figma - 安装向导         ║
║                                                    ║
╚════════════════════════════════════════════════════╝
EOF
echo -e "${NC}\n"

print_info "本脚本将自动完成以下操作："
echo "  1. 选择储存方式（Google Cloud 或 iCloud）"
echo "  2. 开启macOS \"任何来源\" 选项"
echo "  3. 安装Homebrew（如未安装）"
echo "  4. 安装Node.js和npm"
echo "  5. 安装项目依赖"
echo "  6. 配置上传环境（自动生成用户配置）"
echo "  7. 启动同步服务"
echo ""

# 储存方式选择（带重试机制）
while true; do
    print_warning "储存方式选择："
    echo "  [1] Google Cloud 上传（iCloud 无空间也可使用）"
    echo "  [2] iCloud 上传（iCloud 需要足够空间，隐私性更好，推荐）"
    echo ""
    read -p "请选择储存方式 (1/2): " SYNC_MODE

    # 检查输入是否为空
    if [ -z "$SYNC_MODE" ]; then
        print_error "请输入 1 或 2"
        echo ""
        continue
    fi

    if [ "$SYNC_MODE" = "1" ]; then
        USE_GOOGLE_DRIVE=true
        USE_ALIYUN_OSS=false
        SYNC_MODE_VALUE="drive"
        print_info "已选择：Google Cloud 储存方式"
        
        # 引导用户设置本地文件夹（用于存储无法自动导入的录屏文件）
        echo ""
        print_info "📂 配置本地文件夹（用于存储无法自动导入的录屏文件）"
        
        # 默认路径：当前安装目录下的 ScreenSyncImg
        USER_LOCAL_FOLDER="$SCRIPT_DIR/ScreenSyncImg"
        
        echo "  说明："
        echo "    - 视频文件（MP4/MOV）和过大的 GIF 文件无法自动导入 Figma"
        echo "    - 这些文件会自动下载到: $USER_LOCAL_FOLDER"
        echo "    - 您可以直接从该文件夹拖拽文件到 Figma"
        echo ""
        
        # 确保目录存在
        if [ ! -d "$USER_LOCAL_FOLDER" ]; then
            if mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null; then
                print_success "已创建本地文件夹"
            else
                print_error "创建目录失败: $USER_LOCAL_FOLDER"
                # 如果创建失败，尝试使用桌面
                USER_LOCAL_FOLDER="$HOME/Desktop/ScreenSyncImg"
                print_warning "尝试使用桌面路径: $USER_LOCAL_FOLDER"
                mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null || true
            fi
        fi
        
        # 保存到配置文件
        if [ -f "$SCRIPT_DIR/.user-config.json" ]; then
            # 使用 node 更新配置
            node -e "
                const fs = require('fs');
                const config = JSON.parse(fs.readFileSync('$SCRIPT_DIR/.user-config.json', 'utf8'));
                config.localDownloadFolder = '$USER_LOCAL_FOLDER';
                config.installPath = '$SCRIPT_DIR';
                config.updatedAt = new Date().toISOString();
                fs.writeFileSync('$SCRIPT_DIR/.user-config.json', JSON.stringify(config, null, 2), 'utf8');
            " 2>/dev/null || {
                print_warning "无法更新配置文件，将在后续步骤中设置"
            }
        else
            # 创建新配置
            node -e "
                const fs = require('fs');
                const os = require('os');
                const config = {
                    userId: os.userInfo().username + '@' + os.hostname(),
                    folderName: 'ScreenSync-' + os.userInfo().username + '@' + os.hostname(),
                    userFolderId: null,
                    localDownloadFolder: '$USER_LOCAL_FOLDER',
                    installPath: '$SCRIPT_DIR',
                    createdAt: new Date().toISOString()
                };
                fs.writeFileSync('$SCRIPT_DIR/.user-config.json', JSON.stringify(config, null, 2), 'utf8');
            " 2>/dev/null || {
                print_warning "无法创建配置文件，将在后续步骤中设置"
            }
        fi
        
        print_success "本地文件夹已设置: $USER_LOCAL_FOLDER"
        echo ""
        break
    elif [ "$SYNC_MODE" = "2" ]; then
        USE_GOOGLE_DRIVE=false
        USE_ALIYUN_OSS=false
        SYNC_MODE_VALUE="icloud"
        print_info "已选择：iCloud 储存方式"
        
        # 验证 iCloud 文件夹创建和空间
        print_info "验证 iCloud 文件夹和空间..."
        ICLOUD_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg"
        
        # 尝试创建文件夹
        if mkdir -p "$ICLOUD_PATH" 2>/dev/null; then
            # 验证文件夹是否可写
            if [ -w "$ICLOUD_PATH" ]; then
                # 测试写入权限和空间（尝试写入1MB测试文件）
                TEST_FILE="$ICLOUD_PATH/.test-write-space-check"
                if dd if=/dev/zero of="$TEST_FILE" bs=1024 count=1024 2>/dev/null; then
                    # 写入成功，删除测试文件
                    rm -f "$TEST_FILE" 2>/dev/null
                    print_success "iCloud 文件夹验证成功: $ICLOUD_PATH"
                    print_success "iCloud 空间充足"
                    break
                else
                    # 写入失败，可能是空间不足
                    rm -f "$TEST_FILE" 2>/dev/null
                    print_error "iCloud 空间不足"
                    print_warning "检测到 iCloud 云盘空间不足，无法使用 iCloud 模式"
                    echo ""
                    print_info "建议：选择 Google Cloud 储存方式（选项 1）"
                    echo ""
                    read -p "是否返回重新选择储存方式？(Y/n): " RETRY
                    RETRY=${RETRY:-Y}
                    if [[ "$RETRY" =~ ^[Yy]$ ]]; then
                        echo ""
                        continue
                    else
                        print_error "安装已取消"
                        exit 1
                    fi
                fi
            else
                print_error "iCloud 文件夹创建失败：无写入权限"
                print_warning "可能原因：iCloud Cloud 未启用或空间不足"
                echo ""
                print_info "建议：选择 Google Cloud 储存方式（选项 1）"
                echo ""
                read -p "是否返回重新选择储存方式？(Y/n): " RETRY
                RETRY=${RETRY:-Y}
                if [[ "$RETRY" =~ ^[Yy]$ ]]; then
                    echo ""
                    continue
                else
                    print_error "安装已取消"
                    exit 1
                fi
            fi
        else
            print_error "iCloud 文件夹创建失败"
            print_warning "可能原因：iCloud Cloud 未启用或空间不足"
            echo ""
            print_info "建议：选择 Google Cloud 储存方式（选项 1）"
            echo ""
            read -p "是否返回重新选择储存方式？(Y/n): " RETRY
            RETRY=${RETRY:-Y}
            if [[ "$RETRY" =~ ^[Yy]$ ]]; then
                echo ""
                continue
            else
                print_error "安装已取消"
                exit 1
            fi
        fi
    fi
done
echo ""

# 保存储存方式选择到配置文件
SYNC_MODE_FILE="$SCRIPT_DIR/.sync-mode"
echo "$SYNC_MODE_VALUE" > "$SYNC_MODE_FILE"
print_success "已保存储存方式配置: $SYNC_MODE_VALUE"

# ==================== 步骤1：开启"任何来源" ====================
if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_step "步骤 1/6: 开启macOS \"任何来源\" 选项"
else
    print_step "步骤 1/6: 开启macOS \"任何来源\" 选项"
fi

print_info "这需要管理员权限，请输入密码..."
if sudo spctl --master-disable 2>/dev/null; then
    print_success "\"任何来源\" 已开启"
else
    print_warning "开启失败或已经开启，继续..."
fi

# ==================== 步骤2：安装Homebrew ====================
if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_step "步骤 2/6: 检查并安装Homebrew"
else
    print_step "步骤 2/6: 检查并安装Homebrew"
fi

if command -v brew &> /dev/null; then
    print_success "Homebrew已安装: $(brew --version | head -n 1)"
else
    print_info "Homebrew未安装，开始安装..."
    print_warning "这可能需要几分钟时间，请耐心等待..."
    
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    
    # 配置环境变量
    if [[ $(uname -m) == 'arm64' ]]; then
        # Apple Silicon (M1/M2/M3)
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/opt/homebrew/bin/brew shellenv)"
        print_success "Homebrew已安装并配置（Apple Silicon）"
    else
        # Intel
        echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile
        eval "$(/usr/local/bin/brew shellenv)"
        print_success "Homebrew已安装并配置（Intel）"
    fi
fi

# ==================== 步骤3：安装Node.js ====================
if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_step "步骤 3/6: 检查并安装Node.js"
else
    print_step "步骤 3/6: 检查并安装Node.js"
fi

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    print_success "Node.js已安装: $NODE_VERSION"
    
    # 检查版本是否满足要求（需要14+）
    NODE_MAJOR_VERSION=$(node -v | cut -d'.' -f1 | sed 's/v//')
    if [ "$NODE_MAJOR_VERSION" -lt 14 ]; then
        print_warning "Node.js版本过低（需要v14+），正在升级..."
        if brew upgrade node; then
            print_success "Node.js升级完成"
            # 重新加载 PATH（Homebrew 可能更新了路径）
            if [ -f "/opt/homebrew/bin/brew" ]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [ -f "/usr/local/bin/brew" ]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
        else
            print_error "Node.js升级失败"
            exit 1
        fi
    fi
else
    print_info "Node.js未安装，开始安装..."
    if brew install node; then
        print_success "Node.js安装完成"
        # 重新加载 PATH（确保 node 和 npm 可用）
        if [ -f "/opt/homebrew/bin/brew" ]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [ -f "/usr/local/bin/brew" ]; then
            eval "$(/usr/local/bin/brew shellenv)"
        fi
        
        # 验证安装是否成功
        if command -v node &> /dev/null; then
            print_success "Node.js版本: $(node -v)"
        else
            print_error "Node.js安装后无法找到，请检查 PATH 配置"
            print_info "请手动运行: brew install node"
            exit 1
        fi
    else
        print_error "Node.js安装失败"
        print_info "请手动运行: brew install node"
        exit 1
    fi
fi

# 验证 npm 是否可用
if command -v npm &> /dev/null; then
    print_success "npm版本: $(npm -v)"
else
    print_error "npm 不可用，Node.js 安装可能不完整"
    print_info "请手动运行: brew install node"
    exit 1
fi

# ==================== 步骤4：进入项目目录并安装依赖 ====================
if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_step "步骤 4/6: 安装项目依赖"
else
    print_step "步骤 4/6: 安装项目依赖"
fi

# 进入脚本所在目录
cd "$SCRIPT_DIR"

print_info "当前目录: $SCRIPT_DIR"

# 检查是否有package.json
if [ ! -f "package.json" ]; then
    print_error "未找到package.json文件"
    print_error "请确保在项目根目录运行此脚本"
    exit 1
fi

print_info "安装依赖包..."
print_warning "这可能需要几分钟，尤其是首次安装时..."

if npm install; then
    print_success "依赖安装完成"
else
    print_error "依赖安装失败"
    print_info "请尝试手动运行: npm install"
    exit 1
fi

# ==================== 步骤5：配置同步方式 ====================
if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_step "步骤 5/6: 配置 Google Drive 同步环境"
    
    print_info "📝 说明："
    echo "   - 服务器已在 Cloud Run 运行，无需本地配置"
    echo "   - 普通用户直接使用即可，无需部署"
    echo "   - 如需部署或更新 Cloud Run 服务，请查看: CLOUD_RUN_DEPLOY.md"
    echo ""
    
    # 自动生成用户ID和配置文件
    print_info "生成用户配置..."
    if [ ! -f ".user-config.json" ]; then
        USERNAME=$(whoami)
        HOSTNAME=$(hostname)
        USER_ID="${USERNAME}@${HOSTNAME}"
        
        cat > .user-config.json <<EOF
{
  "userId": "$USER_ID",
  "folderName": "ScreenSync-$USER_ID",
  "userFolderId": null,
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
}
EOF
        print_success "已创建用户配置文件"
        print_info "用户ID: $USER_ID"
        echo ""
        print_warning "⚠️  重要：请将此用户ID配置到 iPhone 快捷指令中"
        echo "   在快捷指令的 HTTP 请求中添加请求头："
        echo "   名称: x-user-id"
        echo "   值: $USER_ID"
        echo ""
    else
        USER_ID=$(grep -o '"userId": "[^"]*"' .user-config.json | cut -d'"' -f4)
        print_success "用户配置文件已存在"
        print_info "用户ID: $USER_ID"
        echo ""
    fi
    
    print_info "📝 说明："
    echo "   - 服务器已在 Cloud Run 运行，无需本地 Docker"
    echo "   - 普通用户无需部署，直接使用即可"
    echo ""
else
    # iCloud 模式
    print_step "步骤 5/6: 创建 iCloud 上传文件夹"
    print_info "创建iCloud上传文件夹..."
ICLOUD_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg"
    
    # 重试机制
    RETRY_COUNT=0
    MAX_RETRIES=3
    
    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if mkdir -p "$ICLOUD_PATH" 2>/dev/null && [ -w "$ICLOUD_PATH" ]; then
print_success "iCloud文件夹已创建: $ICLOUD_PATH"
            break
        else
            RETRY_COUNT=$((RETRY_COUNT + 1))
            if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
                print_warning "iCloud文件夹创建失败，重试中 ($RETRY_COUNT/$MAX_RETRIES)..."
                sleep 2
            else
                print_error "iCloud文件夹创建失败"
                print_warning "可能原因：iCloud Cloud 未启用或空间不足"
                echo ""
                print_info "建议切换到 Google Cloud 储存方式（选项 1）"
                echo ""
                read -p "是否继续安装？(y/N): " CONTINUE
                CONTINUE=${CONTINUE:-N}
                if [[ ! "$CONTINUE" =~ ^[Yy]$ ]]; then
                    print_error "安装已取消"
                    exit 1
                fi
            fi
        fi
    done
fi

# ==================== 步骤6：启动服务 ====================
if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_step "步骤 6/6: 启动同步服务"
else
    print_step "步骤 6/6: 启动同步服务"
fi

echo ""
print_success "安装完成！"
echo ""

# 尝试获取插件 URL（优先顺序：环境变量 > 配置文件 > 默认说明）
PLUGIN_MANIFEST_URL=""

# 1. 尝试从环境变量读取
if [ -n "$FIGMASYNC_PLUGIN_URL" ]; then
    PLUGIN_MANIFEST_URL="$FIGMASYNC_PLUGIN_URL"
elif [ -n "$VERCEL_URL" ]; then
    # 如果 VERCEL_URL 不包含协议，添加 https://
    if [[ "$VERCEL_URL" != http* ]]; then
        PLUGIN_MANIFEST_URL="https://${VERCEL_URL}/figma-plugin/manifest.json"
    else
        PLUGIN_MANIFEST_URL="${VERCEL_URL}/figma-plugin/manifest.json"
    fi
fi

# 2. 尝试从本地配置文件读取（如果用户之前部署过）
if [ -z "$PLUGIN_MANIFEST_URL" ] && [ -f "$SCRIPT_DIR/.figmasync-config.json" ]; then
    if command -v node &> /dev/null; then
        PLUGIN_MANIFEST_URL=$(node -e "
            try {
                const fs = require('fs');
                const config = JSON.parse(fs.readFileSync('$SCRIPT_DIR/.figmasync-config.json', 'utf8'));
                if (config.pluginUrl) {
                    console.log(config.pluginUrl);
                }
            } catch (e) {}
        " 2>/dev/null)
    fi
fi

# 3. 尝试从部署的 version.json 读取（如果存在）
if [ -z "$PLUGIN_MANIFEST_URL" ] && [ -f "$SCRIPT_DIR/../deploy-web/version.json" ]; then
    if command -v node &> /dev/null; then
        PLUGIN_MANIFEST_URL=$(node -e "
            try {
                const fs = require('fs');
                const version = JSON.parse(fs.readFileSync('$SCRIPT_DIR/../deploy-web/version.json', 'utf8'));
                if (version.plugin && version.plugin.manifest) {
                    console.log(version.plugin.manifest);
                }
            } catch (e) {}
        " 2>/dev/null)
    elif command -v grep &> /dev/null; then
        PLUGIN_MANIFEST_URL=$(grep -o '"manifest": "[^"]*' "$SCRIPT_DIR/../deploy-web/version.json" 2>/dev/null | cut -d'"' -f4)
    fi
fi

print_info "接下来的步骤："
echo "  1. 在Figma Desktop中打开插件"
echo "     Plugins → Development → Import plugin from manifest"
echo ""

if [ -n "$PLUGIN_MANIFEST_URL" ]; then
    # 找到了插件 URL，使用在线安装
    echo "     ✅ 使用在线安装（自动更新）："
    echo -e "     ${BLUE}输入 URL: ${PLUGIN_MANIFEST_URL}${NC}"
    echo ""
    echo "     💡 提示：使用在线安装后，每次打开插件都会自动使用最新版本"
    echo ""
    
    # 保存到配置文件，方便下次使用
    if command -v node &> /dev/null; then
        node -e "
            const fs = require('fs');
            const config = { pluginUrl: '$PLUGIN_MANIFEST_URL', updatedAt: new Date().toISOString() };
            fs.writeFileSync('$SCRIPT_DIR/.figmasync-config.json', JSON.stringify(config, null, 2), 'utf8');
        " 2>/dev/null || true
    fi
else
    # 没有找到 URL，提供说明
    echo "     ⚠️  未找到 Vercel 部署 URL，请选择以下方式之一："
    echo ""
    echo "     方式一（推荐 - 在线安装，自动更新）："
    echo "       1. 运行部署脚本获取插件 URL："
    echo "          ./deploy-vercel.sh"
    echo "       2. 复制输出的「Figma 插件 URL」"
    echo "       3. 在 Figma 中输入该 URL"
    echo ""
    echo "     方式二（本地安装，需手动更新）："
    echo -e "       选择本地文件: ${YELLOW}$SCRIPT_DIR/figma-plugin/manifest.json${NC}"
    echo ""
    echo "     💡 提示：在线安装可以自动获得最新版本，推荐使用方式一"
    echo ""
fi
echo ""

if [ "$USE_GOOGLE_DRIVE" = true ]; then
    # 确保 USER_ID 已定义
    if [ -z "$USER_ID" ]; then
        if [ -f ".user-config.json" ]; then
            USER_ID=$(grep -o '"userId": "[^"]*"' .user-config.json | cut -d'"' -f4)
        else
            USERNAME=$(whoami)
            HOSTNAME=$(hostname)
            USER_ID="${USERNAME}@${HOSTNAME}"
        fi
    fi
    
    echo "  2. 配置 iPhone 快捷指令（Google Cloud 储存方式）"
    echo ""
    echo "     📱 快捷指令配置步骤："
    echo "     ① 打开「快捷指令」App"
    echo "     ② 创建新快捷指令"
    echo "     ③ 添加操作："
    echo "        - 「获取最新截图」"
    echo "        - 「Base64编码」（编码：仅Base64）"
    echo "        - 「获取URL内容」（方法：POST）"
    echo "     ④ 设置URL："
    echo "        https://figmasync-test-928723349780.asia-east2.run.app/upload"
    echo "     ⑤ 添加请求头："
    echo "        x-user-id: $USER_ID"
    echo "     ⑥ 请求体：JSON"
    echo "        {"
    echo "          \"filename\": \"截图\${当前日期}\","
    echo "          \"data\": \"\${Base64编码结果}\","
    echo "          \"mimeType\": \"image/heif\""
    echo "        }"
    echo "     注意：服务器会使用 macOS 的 sips 命令自动将 HEIF 格式转换为 JPEG"
    echo ""
    echo "  3. 开始使用"
    echo "     - 在Figma插件中选择「实时同步模式」或「手动同步模式」"
    echo "     - 在iPhone上截图，截图会自动同步到Figma！"
else
    echo "  2. 在iPhone上设置快捷指令（iCloud 储存方式）"
    echo ""
    echo "     📱 快捷指令配置步骤："
    echo "     ① 打开「快捷指令」App"
    echo "     ② 创建新快捷指令"
    echo "     ③ 添加操作："
    echo "        - 「获取最新截图」"
    echo "        - 「存储文件」（位置：iCloud Cloud/ScreenSyncImg/）"
echo ""
echo "  3. 开始使用"
    echo "     - 在Figma插件中选择「实时同步模式」或「手动同步模式」"
    echo "     - 在iPhone上截图，截图会自动同步到Figma！"
fi
echo ""

print_info "正在启动服务..."
print_warning "保持此终端窗口打开，按 Ctrl+C 停止服务"
echo ""

# 检查端口是否被占用
print_info "检查端口 8888..."
if lsof -ti:8888 > /dev/null 2>&1; then
    print_warning "端口 8888 已被占用"
    echo ""
    read -p "是否终止占用端口的进程并继续？(Y/n): " KILL_PORT
    KILL_PORT=${KILL_PORT:-Y}
    if [[ "$KILL_PORT" =~ ^[Yy]$ ]]; then
        kill -9 $(lsof -ti:8888) 2>/dev/null || true
        sleep 1
        if lsof -ti:8888 > /dev/null 2>&1; then
            print_error "无法释放端口 8888，请手动处理"
            exit 1
        else
            print_success "端口已释放"
        fi
    else
        print_error "安装已取消"
        exit 1
    fi
else
    print_success "端口 8888 可用"
fi
echo ""

# 设置环境变量并启动服务
export SYNC_MODE="$SYNC_MODE_VALUE"

if [ "$USE_GOOGLE_DRIVE" = true ]; then
    print_info "启动 Google Drive 上传服务..."
    print_info "储存方式: Google Drive"
    echo ""
    npm start
else
    print_info "启动 iCloud 上传服务..."
    print_info "储存方式: iCloud"
    echo ""
npm start
fi