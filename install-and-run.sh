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
echo "  1. 选择上传模式（Google Drive、阿里云 OSS 或 iCloud）"
echo "  2. 开启macOS \"任何来源\" 选项"
echo "  3. 安装Homebrew（如未安装）"
echo "  4. 安装Node.js和npm"
echo "  5. 安装项目依赖"
echo "  6. 配置上传环境（自动生成用户配置）"
echo "  7. 启动同步服务"
echo ""

# 上传模式选择（带重试机制）
while true; do
    print_warning "上传模式选择："
    echo "  [1] Google Drive 上传（推荐，无需 iCloud，速度快）"
    echo "  [2] 阿里云 OSS 上传（适合中国大陆用户，网络更稳定）"
    echo "  [3] iCloud 上传（需要 iCloud Drive，需要足够空间）"
    echo ""
    read -p "请选择上传模式 (1/2/3，默认1): " SYNC_MODE
    SYNC_MODE=${SYNC_MODE:-1}

    if [ "$SYNC_MODE" = "1" ]; then
        USE_GOOGLE_DRIVE=true
        USE_ALIYUN_OSS=false
        SYNC_MODE_VALUE="drive"
        print_info "已选择：Google Drive 上传模式"
        
        # 引导用户设置本地文件夹（用于存储无法自动导入的录屏文件）
        echo ""
        print_info "📂 设置本地文件夹（用于存储无法自动导入的录屏文件）"
        echo ""
        echo "  说明："
        echo "    - 视频文件（MP4/MOV）和过大的 GIF 文件无法自动导入 Figma"
        echo "    - 这些文件会自动下载到您设置的本地文件夹"
        echo "    - 您可以直接从该文件夹拖拽文件到 Figma"
        echo ""
        DEFAULT_LOCAL_FOLDER="$HOME/Desktop/FigmaSyncImg"
        echo "  默认路径: $DEFAULT_LOCAL_FOLDER"
        echo ""
        echo "  💡 提示：您可以直接将文件夹拖入终端窗口来设置路径"
        echo ""
        read -p "请输入本地文件夹路径（直接回车使用默认路径，或拖入自定义文件夹）: " USER_LOCAL_FOLDER
        
        # 如果用户输入为空，使用默认路径
        if [ -z "$USER_LOCAL_FOLDER" ]; then
            USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
        else
            # 处理拖拽的路径（去除可能的引号和空格）
            USER_LOCAL_FOLDER=$(echo "$USER_LOCAL_FOLDER" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//" | sed "s/^['\"]//;s/['\"]$//")
            
            # 展开 ~ 符号
            if [[ "$USER_LOCAL_FOLDER" == ~* ]]; then
                USER_LOCAL_FOLDER="${USER_LOCAL_FOLDER/#\~/$HOME}"
            fi
            
            # 检查用户输入的是文件还是文件夹
            if [ -f "$USER_LOCAL_FOLDER" ]; then
                # 如果是文件，使用其所在目录
                USER_LOCAL_FOLDER=$(dirname "$USER_LOCAL_FOLDER")
                print_info "检测到文件路径，将使用其所在目录: $USER_LOCAL_FOLDER"
            elif [ -d "$USER_LOCAL_FOLDER" ]; then
                # 如果是文件夹，直接使用
                USER_LOCAL_FOLDER="$USER_LOCAL_FOLDER"
            else
                # 如果路径不存在，检查是否是想要创建的新文件夹
                PARENT_DIR=$(dirname "$USER_LOCAL_FOLDER")
                if [ -d "$PARENT_DIR" ]; then
                    # 父目录存在，可以创建新文件夹
                    print_info "将创建新文件夹: $USER_LOCAL_FOLDER"
                else
                    # 父目录不存在，提示错误
                    print_error "路径不存在: $USER_LOCAL_FOLDER"
                    echo ""
                    read -p "是否创建此目录？(Y/n): " CREATE_DIR
                    CREATE_DIR=${CREATE_DIR:-Y}
                    if [[ "$CREATE_DIR" =~ ^[Yy]$ ]]; then
                        if mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null; then
                            print_success "已创建目录: $USER_LOCAL_FOLDER"
                        else
                            print_error "创建目录失败，将使用默认路径"
                            USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
                        fi
                    else
                        print_warning "将使用默认路径: $DEFAULT_LOCAL_FOLDER"
                        USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
                    fi
                fi
            fi
            
            # 转换为绝对路径
            if [ -d "$USER_LOCAL_FOLDER" ] || [ -f "$USER_LOCAL_FOLDER" ]; then
                USER_LOCAL_FOLDER=$(cd "$(dirname "$USER_LOCAL_FOLDER")" 2>/dev/null && pwd)/$(basename "$USER_LOCAL_FOLDER") || USER_LOCAL_FOLDER="$USER_LOCAL_FOLDER"
            else
                # 路径不存在，尝试转换为绝对路径（基于父目录）
                PARENT_DIR=$(dirname "$USER_LOCAL_FOLDER")
                if [ -d "$PARENT_DIR" ]; then
                    ABS_PARENT=$(cd "$PARENT_DIR" 2>/dev/null && pwd || echo "$PARENT_DIR")
                    USER_LOCAL_FOLDER="$ABS_PARENT/$(basename "$USER_LOCAL_FOLDER")"
                fi
            fi
        fi
        
        # 确保目录存在
        if [ ! -d "$USER_LOCAL_FOLDER" ]; then
            if mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null; then
                print_success "已创建目录: $USER_LOCAL_FOLDER"
            else
                print_error "创建目录失败: $USER_LOCAL_FOLDER"
                print_warning "将使用默认路径: $DEFAULT_LOCAL_FOLDER"
                USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
                mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null || true
            fi
        fi
        
        # 保存到配置文件
        SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
        if [ -f "$SCRIPT_DIR/.user-config.json" ]; then
            # 使用 node 更新配置
            node -e "
                const fs = require('fs');
                const config = JSON.parse(fs.readFileSync('$SCRIPT_DIR/.user-config.json', 'utf8'));
                config.localDownloadFolder = '$USER_LOCAL_FOLDER';
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
                    folderName: 'FigmaSync-' + os.userInfo().username + '@' + os.hostname(),
                    userFolderId: null,
                    localDownloadFolder: '$USER_LOCAL_FOLDER',
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
        USE_ALIYUN_OSS=true
        SYNC_MODE_VALUE="aliyun"
        print_info "已选择：阿里云 OSS 上传模式"
        
        # 引导用户设置本地文件夹（用于存储无法自动导入的录屏文件）
        echo ""
        print_info "📂 设置本地文件夹（用于存储无法自动导入的录屏文件）"
        echo ""
        echo "  说明："
        echo "    - 视频文件（MP4/MOV）和过大的 GIF 文件无法自动导入 Figma"
        echo "    - 这些文件会自动下载到您设置的本地文件夹"
        echo "    - 您可以直接从该文件夹拖拽文件到 Figma"
        echo ""
        DEFAULT_LOCAL_FOLDER="$HOME/Desktop/FigmaSyncImg"
        echo "  默认路径: $DEFAULT_LOCAL_FOLDER"
        echo ""
        echo "  💡 提示：您可以直接将文件夹拖入终端窗口来设置路径"
        echo ""
        read -p "请输入本地文件夹路径（直接回车使用默认路径，或拖入自定义文件夹）: " USER_LOCAL_FOLDER
        
        # 如果用户输入为空，使用默认路径
        if [ -z "$USER_LOCAL_FOLDER" ]; then
            USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
        else
            # 处理拖拽的路径（去除可能的引号和空格）
            USER_LOCAL_FOLDER=$(echo "$USER_LOCAL_FOLDER" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//" | sed "s/^['\"]//;s/['\"]$//")
            
            # 展开 ~ 符号
            if [[ "$USER_LOCAL_FOLDER" == ~* ]]; then
                USER_LOCAL_FOLDER="${USER_LOCAL_FOLDER/#\~/$HOME}"
            fi
            
            # 检查用户输入的是文件还是文件夹
            if [ -f "$USER_LOCAL_FOLDER" ]; then
                # 如果是文件，使用其所在目录
                USER_LOCAL_FOLDER=$(dirname "$USER_LOCAL_FOLDER")
                print_info "检测到文件路径，将使用其所在目录: $USER_LOCAL_FOLDER"
            elif [ -d "$USER_LOCAL_FOLDER" ]; then
                # 如果是文件夹，直接使用
                USER_LOCAL_FOLDER="$USER_LOCAL_FOLDER"
            else
                # 如果路径不存在，检查是否是想要创建的新文件夹
                PARENT_DIR=$(dirname "$USER_LOCAL_FOLDER")
                if [ -d "$PARENT_DIR" ]; then
                    # 父目录存在，可以创建新文件夹
                    print_info "将创建新文件夹: $USER_LOCAL_FOLDER"
                else
                    # 父目录不存在，提示错误
                    print_error "路径不存在: $USER_LOCAL_FOLDER"
                    echo ""
                    read -p "是否创建此目录？(Y/n): " CREATE_DIR
                    CREATE_DIR=${CREATE_DIR:-Y}
                    if [[ "$CREATE_DIR" =~ ^[Yy]$ ]]; then
                        if mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null; then
                            print_success "已创建目录: $USER_LOCAL_FOLDER"
                        else
                            print_error "创建目录失败，将使用默认路径"
                            USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
                        fi
                    else
                        print_warning "将使用默认路径: $DEFAULT_LOCAL_FOLDER"
                        USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
                    fi
                fi
            fi
            
            # 转换为绝对路径
            if [ -d "$USER_LOCAL_FOLDER" ] || [ -f "$USER_LOCAL_FOLDER" ]; then
                USER_LOCAL_FOLDER=$(cd "$(dirname "$USER_LOCAL_FOLDER")" 2>/dev/null && pwd)/$(basename "$USER_LOCAL_FOLDER") || USER_LOCAL_FOLDER="$USER_LOCAL_FOLDER"
            else
                # 路径不存在，尝试转换为绝对路径（基于父目录）
                PARENT_DIR=$(dirname "$USER_LOCAL_FOLDER")
                if [ -d "$PARENT_DIR" ]; then
                    ABS_PARENT=$(cd "$PARENT_DIR" 2>/dev/null && pwd || echo "$PARENT_DIR")
                    USER_LOCAL_FOLDER="$ABS_PARENT/$(basename "$USER_LOCAL_FOLDER")"
                fi
            fi
        fi
        
        # 确保目录存在
        if [ ! -d "$USER_LOCAL_FOLDER" ]; then
            if mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null; then
                print_success "已创建目录: $USER_LOCAL_FOLDER"
            else
                print_error "创建目录失败: $USER_LOCAL_FOLDER"
                print_warning "将使用默认路径: $DEFAULT_LOCAL_FOLDER"
                USER_LOCAL_FOLDER="$DEFAULT_LOCAL_FOLDER"
                mkdir -p "$USER_LOCAL_FOLDER" 2>/dev/null || true
            fi
        fi
        
        # 保存到配置文件
        SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
        if [ -f "$SCRIPT_DIR/.user-config.json" ]; then
            # 使用 node 更新配置
            node -e "
                const fs = require('fs');
                const config = JSON.parse(fs.readFileSync('$SCRIPT_DIR/.user-config.json', 'utf8'));
                config.localDownloadFolder = '$USER_LOCAL_FOLDER';
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
                    folderName: 'FigmaSync-' + os.userInfo().username + '@' + os.hostname(),
                    userFolderId: null,
                    localDownloadFolder: '$USER_LOCAL_FOLDER',
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
    else
        USE_GOOGLE_DRIVE=false
        USE_ALIYUN_OSS=false
        SYNC_MODE_VALUE="icloud"
        print_info "已选择：iCloud 上传模式"
        
        # 验证 iCloud 文件夹创建
        print_info "验证 iCloud 文件夹..."
        ICLOUD_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/FigmaSyncImg"
        
        # 尝试创建文件夹
        if mkdir -p "$ICLOUD_PATH" 2>/dev/null; then
            # 验证文件夹是否可写
            if [ -w "$ICLOUD_PATH" ]; then
                print_success "iCloud 文件夹验证成功: $ICLOUD_PATH"
                break
            else
                print_error "iCloud 文件夹创建失败：无写入权限"
                print_warning "可能原因：iCloud Drive 未启用或空间不足"
                echo ""
                read -p "是否重试选择同步方式？(Y/n): " RETRY
                RETRY=${RETRY:-Y}
                if [[ ! "$RETRY" =~ ^[Yy]$ ]]; then
                    print_error "安装已取消"
                    exit 1
                fi
                echo ""
            fi
        else
            print_error "iCloud 文件夹创建失败"
            print_warning "可能原因：iCloud Drive 未启用或空间不足"
            echo ""
            print_info "建议：使用 Google Drive 同步（选项 1）"
            echo ""
            read -p "是否重试选择同步方式？(Y/n): " RETRY
            RETRY=${RETRY:-Y}
            if [[ ! "$RETRY" =~ ^[Yy]$ ]]; then
                print_error "安装已取消"
                exit 1
            fi
            echo ""
        fi
    fi
done
echo ""

# 保存上传模式选择到配置文件
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SYNC_MODE_FILE="$SCRIPT_DIR/.sync-mode"
echo "$SYNC_MODE_VALUE" > "$SYNC_MODE_FILE"
print_success "已保存上传模式配置: $SYNC_MODE_VALUE"

read -p "按回车键继续安装，或按 Ctrl+C 取消..." 

# ==================== 步骤1：开启"任何来源" ====================
if [ "$USE_GOOGLE_DRIVE" = true ] || [ "$USE_ALIYUN_OSS" = true ]; then
    print_step "步骤 1/7: 开启macOS \"任何来源\" 选项"
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
if [ "$USE_GOOGLE_DRIVE" = true ] || [ "$USE_ALIYUN_OSS" = true ]; then
    print_step "步骤 2/7: 检查并安装Homebrew"
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
if [ "$USE_GOOGLE_DRIVE" = true ] || [ "$USE_ALIYUN_OSS" = true ]; then
    print_step "步骤 3/7: 检查并安装Node.js"
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
        brew upgrade node
    fi
else
    print_info "Node.js未安装，开始安装..."
    brew install node
    print_success "Node.js安装完成: $(node -v)"
fi

print_success "npm版本: $(npm -v)"

# ==================== 步骤4：进入项目目录并安装依赖 ====================
if [ "$USE_GOOGLE_DRIVE" = true ] || [ "$USE_ALIYUN_OSS" = true ]; then
    print_step "步骤 4/7: 安装项目依赖"
else
    print_step "步骤 4/6: 安装项目依赖"
fi

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
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
    print_step "步骤 5/7: 配置 Google Drive 同步环境"
    
    # 5.1 检查并安装 gcloud CLI
    print_info "检查 Google Cloud SDK..."
    if ! command -v gcloud &> /dev/null; then
        # 尝试添加到 PATH
        if [ -d "/opt/homebrew/share/google-cloud-sdk/bin" ]; then
            export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
        elif [ -d "$HOME/google-cloud-sdk/bin" ]; then
            export PATH="$HOME/google-cloud-sdk/bin:$PATH"
        fi
    fi
    
    if ! command -v gcloud &> /dev/null; then
        # 检查 Xcode 许可证是否已接受（安装 Google Cloud SDK 需要）
        print_info "检查 Xcode 许可证状态..."
        
        # 检查 Xcode 是否安装
        if ! command -v xcodebuild &> /dev/null; then
            print_warning "未检测到 Xcode，某些功能可能需要 Xcode"
        else
            # 尝试检查许可证状态
            # 如果许可证未接受，xcodebuild 会输出错误信息
            LICENSE_CHECK_OUTPUT=$(xcodebuild -license check 2>&1)
            if echo "$LICENSE_CHECK_OUTPUT" | grep -qi "license"; then
                # 如果输出包含 "license" 相关错误，说明需要接受许可证
                if echo "$LICENSE_CHECK_OUTPUT" | grep -qiE "(not agreed|not accepted|agree)"; then
                    print_warning "检测到 Xcode 许可证未接受，正在自动接受..."
                    print_info "这需要管理员权限，请输入密码..."
                    if sudo xcodebuild -license accept 2>/dev/null; then
                        print_success "Xcode 许可证已接受"
                    else
                        print_error "无法自动接受 Xcode 许可证"
                        print_warning "请手动运行以下命令后重试："
                        echo "   sudo xcodebuild -license accept"
                        echo ""
                        read -p "是否已手动接受 Xcode 许可证？(Y/n): " LICENSE_ACCEPTED
                        LICENSE_ACCEPTED=${LICENSE_ACCEPTED:-Y}
                        if [[ ! "$LICENSE_ACCEPTED" =~ ^[Yy]$ ]]; then
                            print_error "安装已取消"
                            exit 1
                        fi
                    fi
                else
                    print_success "Xcode 许可证已接受"
                fi
            else
                # 如果检查命令成功，许可证应该已接受
                print_success "Xcode 许可证已接受"
            fi
        fi
        
        print_info "安装 Google Cloud SDK..."
        BREW_OUTPUT=$(brew install --cask google-cloud-sdk 2>&1)
        BREW_EXIT_CODE=$?
        
        # 检查输出中是否有 Xcode 许可证错误
        if echo "$BREW_OUTPUT" | grep -qiE "(xcode.*license|agree.*xcode|You have not agreed)"; then
            print_warning "检测到 Xcode 许可证问题，正在自动处理..."
            print_info "这需要管理员权限，请输入密码..."
            if sudo xcodebuild -license accept 2>/dev/null; then
                print_success "Xcode 许可证已接受，重新尝试安装..."
                if brew install --cask google-cloud-sdk; then
                    # 添加到 PATH
                    if [ -d "/opt/homebrew/share/google-cloud-sdk/bin" ]; then
                        export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
                        echo 'export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"' >> ~/.zprofile
                    fi
                    print_success "Google Cloud SDK 已安装"
                else
                    print_error "Google Cloud SDK 安装失败"
                    exit 1
                fi
            else
                print_error "无法自动接受 Xcode 许可证"
                print_warning "请手动运行以下命令后重新运行安装脚本："
                echo "   sudo xcodebuild -license accept"
                exit 1
            fi
        elif [ $BREW_EXIT_CODE -eq 0 ]; then
            # 安装成功
            # 添加到 PATH
            if [ -d "/opt/homebrew/share/google-cloud-sdk/bin" ]; then
                export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"
                echo 'export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"' >> ~/.zprofile
            fi
            print_success "Google Cloud SDK 已安装"
        else
            # 安装失败，但不是 Xcode 许可证问题
            print_error "Google Cloud SDK 安装失败"
            echo "$BREW_OUTPUT" | tail -10
            print_warning "可能原因："
            echo "   1. Xcode 许可证未接受（请运行: sudo xcodebuild -license accept）"
            echo "   2. 网络连接问题"
            echo "   3. Homebrew 配置问题"
            echo ""
            read -p "是否继续安装？（可能会影响 Google Drive 模式的使用）(y/N): " CONTINUE_INSTALL
            CONTINUE_INSTALL=${CONTINUE_INSTALL:-N}
            if [[ ! "$CONTINUE_INSTALL" =~ ^[Yy]$ ]]; then
                print_error "安装已取消"
                exit 1
            fi
        fi
    else
        print_success "Google Cloud SDK 已安装: $(gcloud version --format='value(Google Cloud SDK)' 2>/dev/null || echo '已安装')"
    fi
    
    # 5.2 检查 Service Account 配置
    print_info "检查 Service Account 配置..."
    CAN_DEPLOY=false
    
    if [ -f "serviceAccountKey.js" ]; then
        print_success "找到 Service Account 配置文件"
        
        # 提取配置信息
        CLIENT_EMAIL=$(grep -o "client_email: '[^']*'" serviceAccountKey.js | sed "s/client_email: '//" | sed "s/'//" || echo "")
        
        if [ -n "$CLIENT_EMAIL" ]; then
            print_success "Service Account: $CLIENT_EMAIL"
            CAN_DEPLOY=true
        else
            print_warning "无法从 serviceAccountKey.js 读取配置"
        fi
    else
        print_warning "未找到 serviceAccountKey.js 文件"
        print_info "普通用户不需要此文件，可以直接使用 Cloud Run 服务"
        print_info "只有部署者需要此文件来部署到 Cloud Run"
    fi
    
    # 5.3 询问是否部署到 Cloud Run（只有部署者需要）
    if [ "$CAN_DEPLOY" = true ]; then
        echo ""
        read -p "是否要部署到 Cloud Run？（只有项目维护者需要，普通用户选 N）(y/N): " DEPLOY_NOW
        DEPLOY_NOW=${DEPLOY_NOW:-N}
        
        if [[ "$DEPLOY_NOW" =~ ^[Yy]$ ]]; then
            # 只有部署时才需要 Docker
            print_info "检查 Docker 环境（部署需要）..."
            DOCKER_AVAILABLE=false
            
            # 检查 Docker Desktop
            if command -v docker &> /dev/null && docker info &> /dev/null 2>&1; then
                DOCKER_AVAILABLE=true
                print_success "Docker Desktop 正在运行"
            # 检查 Colima
            elif command -v colima &> /dev/null && colima status 2>/dev/null | grep -q "Running"; then
                DOCKER_AVAILABLE=true
                print_success "Colima 正在运行"
            else
                print_warning "Docker 未运行，尝试安装 Colima（Docker Desktop 的轻量级替代）..."
                
                if ! command -v colima &> /dev/null; then
                    brew install colima docker docker-compose
                fi
                
                if ! colima status 2>/dev/null | grep -q "Running"; then
                    print_info "启动 Colima（首次启动可能需要几分钟）..."
                    colima start
                fi
                
                if docker info &> /dev/null 2>&1; then
                    DOCKER_AVAILABLE=true
                    print_success "Colima 已启动，Docker 可用"
                else
                    print_error "Docker 环境配置失败"
                    print_warning "无法部署到 Cloud Run"
                    DOCKER_AVAILABLE=false
                fi
            fi
        else
            print_info "跳过部署（普通用户不需要部署）"
            DOCKER_AVAILABLE=false
        fi
    else
        print_info "跳过部署步骤（普通用户不需要）"
        DOCKER_AVAILABLE=false
    fi
    
    # 5.4 配置 Google Cloud 登录（只有部署时需要）
    if [ "$DOCKER_AVAILABLE" = true ]; then
        print_info "配置 Google Cloud 登录..."
        
        # 检查是否已登录
        ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
        
        if [ -z "$ACTIVE_ACCOUNT" ]; then
            print_warning "需要登录 Google Cloud"
            print_info "将打开浏览器进行登录..."
            echo ""
            gcloud auth login
            
            # 再次检查
            ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
            if [ -z "$ACTIVE_ACCOUNT" ]; then
                print_error "Google Cloud 登录失败"
                print_warning "将跳过 Cloud Run 部署"
                DOCKER_AVAILABLE=false
            else
                print_success "已登录: $ACTIVE_ACCOUNT"
            fi
        else
            print_success "已登录: $ACTIVE_ACCOUNT"
        fi
        
        # 5.5 设置项目
        PROJECT_ID="figmasync-477511"
        CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
        
        if [ "$CURRENT_PROJECT" != "$PROJECT_ID" ]; then
            print_info "设置 Google Cloud 项目: $PROJECT_ID"
            gcloud config set project $PROJECT_ID
        fi
        
        # 启用 API
        print_info "启用 Cloud Run API..."
        gcloud services enable run.googleapis.com --quiet 2>/dev/null || true
        
        # 配置 Docker 认证
        print_info "配置 Docker 认证..."
        gcloud auth configure-docker --quiet 2>/dev/null || true
        
        # 5.6 部署到 Cloud Run
        if [ "$DOCKER_AVAILABLE" = true ]; then
            print_step "步骤 6/7: 部署到 Google Cloud Run"
            
            SERVICE_NAME="figmasync-test"
            REGION="asia-east2"
            IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
            
            print_info "构建 Docker 镜像（AMD64 架构，Cloud Run 要求）..."
            docker build --platform linux/amd64 -t ${IMAGE_NAME} . 2>&1 | grep -E "(Step|Successfully|ERROR)" || true
            
            print_info "推送镜像到 Google Container Registry..."
            docker push ${IMAGE_NAME} 2>&1 | tail -3 || true
            
            print_info "部署到 Cloud Run..."
            gcloud run deploy ${SERVICE_NAME} \
                --image ${IMAGE_NAME} \
                --platform managed \
                --region ${REGION} \
                --allow-unauthenticated \
                --port 8080 \
                --memory 512Mi \
                --timeout 300 \
                --max-instances 10 \
                --min-instances 0 \
                2>&1 | tail -10 || true
            
            SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)' 2>/dev/null || echo "")
            
            if [ -n "$SERVICE_URL" ]; then
                print_success "部署完成！"
                echo ""
                print_info "服务 URL: $SERVICE_URL"
                echo ""
                print_warning "⚠️  重要：还需要在 Cloud Run 控制台设置环境变量："
                echo "   访问: https://console.cloud.google.com/run/detail/${REGION}/${SERVICE_NAME}/variables"
                echo ""
                echo "   需要设置："
                echo "   - GDRIVE_FOLDER_ID: 你的 Google Drive 文件夹 ID"
                echo "   - GDRIVE_CLIENT_EMAIL: $CLIENT_EMAIL"
                echo "   - GDRIVE_PRIVATE_KEY: 从 serviceAccountKey.js 复制 private_key 字段"
                echo "   - UPLOAD_TOKEN: (可选) 上传接口令牌"
                echo ""
                print_info "详细说明请查看: SETUP_ENV_VARS.md"
                echo ""
            else
                print_warning "部署可能未完成，请检查错误信息"
            fi
        fi
    fi
    
    echo ""
    print_success "Google Drive 环境配置完成！"
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
  "folderName": "FigmaSync-$USER_ID",
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
elif [ "$USE_ALIYUN_OSS" = true ]; then
    print_step "步骤 5/7: 配置阿里云 OSS 同步环境"
    
    print_info "配置阿里云 OSS 环境变量..."
    echo ""
    print_warning "需要配置以下环境变量："
    echo "  - ALIYUN_ACCESS_KEY_ID: 阿里云 AccessKey ID"
    echo "  - ALIYUN_ACCESS_KEY_SECRET: 阿里云 AccessKey Secret"
    echo "  - ALIYUN_BUCKET: OSS Bucket 名称"
    echo "  - ALIYUN_REGION: OSS 地域（可选，默认 oss-cn-hangzhou）"
    echo "  - ALIYUN_ROOT_FOLDER: OSS 根文件夹（可选，默认 FigmaSync）"
    echo ""
    
    # 检查是否已有 .env 文件
    ENV_FILE=".env"
    RECONFIGURE="N"
    
    if [ -f "$ENV_FILE" ]; then
        # 检查是否已配置阿里云相关变量
        if grep -q "ALIYUN_ACCESS_KEY_ID" "$ENV_FILE" && grep -q "ALIYUN_ACCESS_KEY_SECRET" "$ENV_FILE" && grep -q "ALIYUN_BUCKET" "$ENV_FILE"; then
            print_success "阿里云 OSS 配置已存在"
            echo ""
            print_info "📝 说明："
            echo "   - OSS 配置（AccessKey、Bucket 等）是共享的，所有用户使用同一配置"
            echo "   - 每个用户通过 userId 区分，自动创建自己的文件夹"
            echo "   - 当前配置将用于所有使用此服务的用户"
            echo ""
            read -p "是否要重新配置 OSS？（通常不需要，直接回车跳过）(y/N): " RECONFIGURE
            RECONFIGURE=${RECONFIGURE:-N}
            if [[ ! "$RECONFIGURE" =~ ^[Yy]$ ]]; then
                print_success "使用现有 OSS 配置，跳过配置步骤"
                echo ""
                # 设置标志，跳过所有配置步骤
                SKIP_OSS_CONFIG=true
            else
                # 重新配置
                print_info "开始重新配置 OSS..."
                echo ""
                SKIP_OSS_CONFIG=false
            fi
        else
            print_warning ".env 文件存在但缺少阿里云 OSS 配置"
            echo ""
            print_info "📝 说明："
            echo "   - OSS 配置（AccessKey、Bucket 等）是共享的，只需配置一次"
            echo "   - 配置完成后，所有用户都可以使用，无需重复配置"
            echo ""
            read -p "是否要添加阿里云 OSS 配置？(Y/n): " ADD_CONFIG
            ADD_CONFIG=${ADD_CONFIG:-Y}
            if [[ ! "$ADD_CONFIG" =~ ^[Yy]$ ]]; then
                print_error "必须配置阿里云 OSS 才能使用此模式"
                exit 1
            fi
            SKIP_OSS_CONFIG=false
        fi
    else
        print_info "创建 .env 文件..."
        touch "$ENV_FILE"
        print_info "📝 说明："
        echo "   - OSS 配置（AccessKey、Bucket 等）是共享的，只需配置一次"
        echo "   - 配置完成后，所有用户都可以使用，无需重复配置"
        echo ""
        SKIP_OSS_CONFIG=false
    fi
    
    # 如果跳过配置，直接跳到用户配置生成
    if [ "$SKIP_OSS_CONFIG" = true ]; then
        print_info "跳过 OSS 配置步骤，使用现有配置"
        echo ""
    else
        # 配置 AccessKey ID
        if [[ "$RECONFIGURE" =~ ^[Yy]$ ]] || ! grep -q "ALIYUN_ACCESS_KEY_ID" "$ENV_FILE" 2>/dev/null; then
            echo ""
            print_info "请输入阿里云 AccessKey ID："
            read -p "ALIYUN_ACCESS_KEY_ID: " ACCESS_KEY_ID
            if [ -z "$ACCESS_KEY_ID" ]; then
                print_error "AccessKey ID 不能为空"
                exit 1
            fi
            
            # 更新或添加配置
            if grep -q "ALIYUN_ACCESS_KEY_ID" "$ENV_FILE" 2>/dev/null; then
                # 更新现有配置
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    # macOS
                    sed -i '' "s|^ALIYUN_ACCESS_KEY_ID=.*|ALIYUN_ACCESS_KEY_ID=$ACCESS_KEY_ID|" "$ENV_FILE"
                else
                    # Linux
                    sed -i "s|^ALIYUN_ACCESS_KEY_ID=.*|ALIYUN_ACCESS_KEY_ID=$ACCESS_KEY_ID|" "$ENV_FILE"
                fi
            else
                # 添加新配置
                echo "ALIYUN_ACCESS_KEY_ID=$ACCESS_KEY_ID" >> "$ENV_FILE"
            fi
        fi
        
        # 配置 AccessKey Secret
        if [[ "$RECONFIGURE" =~ ^[Yy]$ ]] || ! grep -q "ALIYUN_ACCESS_KEY_SECRET" "$ENV_FILE" 2>/dev/null; then
            echo ""
            print_info "请输入阿里云 AccessKey Secret："
            read -p "ALIYUN_ACCESS_KEY_SECRET: " ACCESS_KEY_SECRET
            if [ -z "$ACCESS_KEY_SECRET" ]; then
                print_error "AccessKey Secret 不能为空"
                exit 1
            fi
            
            # 更新或添加配置
            if grep -q "ALIYUN_ACCESS_KEY_SECRET" "$ENV_FILE" 2>/dev/null; then
                # 更新现有配置
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    # macOS
                    sed -i '' "s|^ALIYUN_ACCESS_KEY_SECRET=.*|ALIYUN_ACCESS_KEY_SECRET=$ACCESS_KEY_SECRET|" "$ENV_FILE"
                else
                    # Linux
                    sed -i "s|^ALIYUN_ACCESS_KEY_SECRET=.*|ALIYUN_ACCESS_KEY_SECRET=$ACCESS_KEY_SECRET|" "$ENV_FILE"
                fi
            else
                # 添加新配置
                echo "ALIYUN_ACCESS_KEY_SECRET=$ACCESS_KEY_SECRET" >> "$ENV_FILE"
            fi
        fi
        
        # 配置 Bucket
        if [[ "$RECONFIGURE" =~ ^[Yy]$ ]] || ! grep -q "ALIYUN_BUCKET" "$ENV_FILE" 2>/dev/null; then
            echo ""
            print_info "请输入 OSS Bucket 名称："
            read -p "ALIYUN_BUCKET: " BUCKET_NAME
            if [ -z "$BUCKET_NAME" ]; then
                print_error "Bucket 名称不能为空"
                exit 1
            fi
            
            # 更新或添加配置
            if grep -q "ALIYUN_BUCKET" "$ENV_FILE" 2>/dev/null; then
                # 更新现有配置
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    # macOS
                    sed -i '' "s|^ALIYUN_BUCKET=.*|ALIYUN_BUCKET=$BUCKET_NAME|" "$ENV_FILE"
                else
                    # Linux
                    sed -i "s|^ALIYUN_BUCKET=.*|ALIYUN_BUCKET=$BUCKET_NAME|" "$ENV_FILE"
                fi
            else
                # 添加新配置
                echo "ALIYUN_BUCKET=$BUCKET_NAME" >> "$ENV_FILE"
            fi
        fi
        
        # 配置 Region（可选）
        if [[ "$RECONFIGURE" =~ ^[Yy]$ ]] || ! grep -q "ALIYUN_REGION" "$ENV_FILE" 2>/dev/null; then
            echo ""
            print_info "请输入 OSS 地域（可选，直接回车使用默认值 oss-cn-hangzhou）："
            read -p "ALIYUN_REGION [oss-cn-hangzhou]: " REGION
            REGION=${REGION:-oss-cn-hangzhou}
            
            # 更新或添加配置
            if grep -q "ALIYUN_REGION" "$ENV_FILE" 2>/dev/null; then
                # 更新现有配置
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    # macOS
                    sed -i '' "s|^ALIYUN_REGION=.*|ALIYUN_REGION=$REGION|" "$ENV_FILE"
                else
                    # Linux
                    sed -i "s|^ALIYUN_REGION=.*|ALIYUN_REGION=$REGION|" "$ENV_FILE"
                fi
            else
                # 添加新配置
                echo "ALIYUN_REGION=$REGION" >> "$ENV_FILE"
            fi
        fi
        
        # 配置 Root Folder（可选）
        if [[ "$RECONFIGURE" =~ ^[Yy]$ ]] || ! grep -q "ALIYUN_ROOT_FOLDER" "$ENV_FILE" 2>/dev/null; then
            echo ""
            print_info "请输入 OSS 根文件夹名称（可选，直接回车使用默认值 FigmaSync）："
            read -p "ALIYUN_ROOT_FOLDER [FigmaSync]: " ROOT_FOLDER
            ROOT_FOLDER=${ROOT_FOLDER:-FigmaSync}
            
            # 更新或添加配置
            if grep -q "ALIYUN_ROOT_FOLDER" "$ENV_FILE" 2>/dev/null; then
                # 更新现有配置
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    # macOS
                    sed -i '' "s|^ALIYUN_ROOT_FOLDER=.*|ALIYUN_ROOT_FOLDER=$ROOT_FOLDER|" "$ENV_FILE"
                else
                    # Linux
                    sed -i "s|^ALIYUN_ROOT_FOLDER=.*|ALIYUN_ROOT_FOLDER=$ROOT_FOLDER|" "$ENV_FILE"
                fi
            else
                # 添加新配置
                echo "ALIYUN_ROOT_FOLDER=$ROOT_FOLDER" >> "$ENV_FILE"
            fi
        fi
        
        print_success "阿里云 OSS 配置完成！"
    fi
    
    # 配置说明（无论是否跳过配置都显示）
    echo ""
    print_info "📝 配置说明："
    echo "   - OSS 配置已保存到 .env 文件（共享配置）"
    echo "   - 请确保 AccessKey 有 OSS 的读写权限"
    echo "   - 建议使用 RAM 子账号的 AccessKey，并只授予必要的权限"
    echo "   - 所有用户共享此 OSS 配置，每个用户通过 userId 区分文件夹"
    echo ""
    
    # 询问是否部署到云服务（可选，用于公共 URL 访问）
    echo ""
    print_info "💡 为了在中国大陆网络环境下提供稳定的公网访问，建议部署到阿里云服务"
    echo ""
    echo "  选项说明："
    echo "  [1] 部署到阿里云 ECS（推荐，适合中国大陆用户）"
    echo "      - 使用阿里云云服务器，网络稳定快速"
    echo "      - 需要购买 ECS 实例，有公网 IP"
    echo "      - 适合长期运行的服务"
    echo ""
    echo "  [2] 部署到 Google Cloud Run（不推荐，可能受网络限制）"
    echo "      - 使用 Google 服务，在中国大陆可能不稳定"
    echo "      - 适合海外用户"
    echo ""
    echo "  [3] 本地运行（仅测试用）"
    echo "      - iPhone 和 Mac 需要在同一网络"
    echo "      - 不适合生产环境"
    echo ""
    read -p "请选择部署方式 [1/2/3，直接回车跳过部署]: " DEPLOY_CHOICE
    DEPLOY_CHOICE=${DEPLOY_CHOICE:-3}
    
    if [ "$DEPLOY_CHOICE" = "1" ]; then
        # 部署到阿里云 ECS
        print_step "步骤 6/7: 部署到阿里云 ECS"
        echo ""
        print_info "📝 阿里云 ECS 部署说明："
        echo ""
        echo "  1. 购买阿里云 ECS 实例："
        echo "     - 访问: https://ecs.console.aliyun.com/"
        echo "     - 选择地域：建议选择与 OSS Bucket 相同的地域（如：华北2-北京）"
        echo "     - 实例规格：建议 1核2GB 或更高（根据并发需求）"
        echo "     - 操作系统：Ubuntu 20.04 或 CentOS 7+"
        echo "     - 网络：选择"专有网络 VPC"，分配公网 IP"
        echo ""
        echo "  2. 配置安全组："
        echo "     - 开放端口：8888（HTTP API）"
        echo "     - 开放端口：8080（可选，用于健康检查）"
        echo ""
        echo "  3. 在 ECS 上部署应用："
        echo "     - 连接到 ECS 实例（SSH）"
        echo "     - 安装 Node.js 和 npm"
        echo "     - 上传项目文件或使用 Git 克隆"
        echo "     - 配置环境变量（.env 文件）"
        echo "     - 使用 PM2 或 systemd 运行服务"
        echo ""
        echo "  4. 获取公网访问地址："
        echo "     - ECS 实例的公网 IP 地址"
        echo "     - 或绑定域名（需要备案）"
        echo ""
        print_warning "⚠️  详细部署文档请参考: ALIYUN_ECS_DEPLOY.md"
        echo ""
        print_info "💡 提示："
        echo "   - 部署完成后，iPhone 快捷指令 URL: http://你的ECS公网IP:8888/upload-oss"
        echo "   - 建议使用域名 + Nginx 反向代理，配置 HTTPS"
        echo ""
        SERVICE_URL=""  # ECS 没有自动生成的 URL
    elif [ "$DEPLOY_CHOICE" = "2" ]; then
        # 部署到 Google Cloud Run（不推荐，但保留选项）
        print_warning "⚠️  注意：Google Cloud Run 在中国大陆可能受网络限制，不推荐使用"
        echo ""
        read -p "确认要继续部署到 Google Cloud Run？(y/N): " CONFIRM_GOOGLE
        CONFIRM_GOOGLE=${CONFIRM_GOOGLE:-N}
        
        if [[ "$CONFIRM_GOOGLE" =~ ^[Yy]$ ]]; then
            # 检查 Docker 环境
            print_info "检查 Docker 环境（部署需要）..."
            DOCKER_AVAILABLE=false
            
            if command -v docker &> /dev/null && docker info &> /dev/null 2>&1; then
                DOCKER_AVAILABLE=true
                print_success "Docker Desktop 正在运行"
            elif command -v colima &> /dev/null && colima status 2>/dev/null | grep -q "Running"; then
                DOCKER_AVAILABLE=true
                print_success "Colima 正在运行"
            else
                print_warning "Docker 未运行，需要 Docker 才能部署到 Cloud Run"
                print_info "可以稍后手动部署，或选择本地运行模式"
                DOCKER_AVAILABLE=false
            fi
            
            if [ "$DOCKER_AVAILABLE" = true ]; then
                # 检查 gcloud CLI
                if ! command -v gcloud &> /dev/null; then
                    print_warning "未安装 Google Cloud SDK，无法部署到 Cloud Run"
                    print_info "可以稍后手动部署，或选择本地运行模式"
                    DOCKER_AVAILABLE=false
                else
                    # 配置 Google Cloud 登录
                    print_info "配置 Google Cloud 登录..."
                    ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
                    
                    if [ -z "$ACTIVE_ACCOUNT" ]; then
                        print_warning "需要登录 Google Cloud"
                        print_info "将打开浏览器进行登录..."
                        gcloud auth login
                    fi
                    
                    # 设置项目
                    PROJECT_ID="figmasync-477511"
                    CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
                    
                    if [ "$CURRENT_PROJECT" != "$PROJECT_ID" ]; then
                        print_info "设置 Google Cloud 项目: $PROJECT_ID"
                        gcloud config set project $PROJECT_ID
                    fi
                    
                    # 启用 API
                    gcloud services enable run.googleapis.com --quiet 2>/dev/null || true
                    gcloud auth configure-docker --quiet 2>/dev/null || true
                    
                    # 部署到 Cloud Run
                    print_step "步骤 6/7: 部署到 Google Cloud Run"
                    
                    SERVICE_NAME="figmasync-oss"
                    REGION="asia-east2"
                    IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
                    
                    print_info "构建 Docker 镜像（AMD64 架构，Cloud Run 要求）..."
                    docker build --platform linux/amd64 -t ${IMAGE_NAME} . 2>&1 | grep -E "(Step|Successfully|ERROR)" || true
                    
                    print_info "推送镜像到 Google Container Registry..."
                    docker push ${IMAGE_NAME} 2>&1 | tail -3 || true
                    
                    print_info "部署到 Cloud Run..."
                    gcloud run deploy ${SERVICE_NAME} \
                        --image ${IMAGE_NAME} \
                        --platform managed \
                        --region ${REGION} \
                        --allow-unauthenticated \
                        --port 8080 \
                        --memory 512Mi \
                        --timeout 300 \
                        --max-instances 10 \
                        --min-instances 0 \
                        2>&1 | tail -10 || true
                    
                    SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)' 2>/dev/null || echo "")
                    
                    if [ -n "$SERVICE_URL" ]; then
                        print_success "部署完成！"
                        echo ""
                        print_info "服务 URL: $SERVICE_URL"
                        echo ""
                        print_warning "⚠️  重要：还需要在 Cloud Run 控制台设置环境变量："
                        echo "   访问: https://console.cloud.google.com/run/detail/${REGION}/${SERVICE_NAME}/variables"
                        echo ""
                        echo "   需要设置："
                        echo "   - ALIYUN_ACCESS_KEY_ID: 你的阿里云 AccessKey ID"
                        echo "   - ALIYUN_ACCESS_KEY_SECRET: 你的阿里云 AccessKey Secret"
                        echo "   - ALIYUN_BUCKET: 你的 OSS Bucket 名称"
                        echo "   - ALIYUN_REGION: 你的 OSS Region（例如：oss-cn-beijing）"
                        echo "   - ALIYUN_ROOT_FOLDER: OSS 根文件夹（可选，默认 FigmaSync）"
                        echo ""
                        print_info "设置环境变量后，iPhone 快捷指令可以使用以下 URL："
                        echo "   ${SERVICE_URL}/upload-oss"
                        echo ""
                    else
                        print_warning "部署可能未完成，请检查错误信息"
                    fi
                fi
            fi
        else
            print_info "已取消 Google Cloud Run 部署"
            SERVICE_URL=""
        fi
    else
        print_info "跳过云服务部署，将使用本地运行模式"
        print_info "iPhone 和 Mac 需要在同一网络才能使用"
        SERVICE_URL=""
    fi
    
    # 自动生成用户ID和配置文件
    print_info "生成用户配置..."
    if [ ! -f ".user-config.json" ]; then
        USERNAME=$(whoami)
        HOSTNAME=$(hostname)
        USER_ID="${USERNAME}@${HOSTNAME}"
        
        cat > .user-config.json <<EOF
{
  "userId": "$USER_ID",
  "folderName": "FigmaSync-$USER_ID",
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
        print_warning "⚠️  重要：iPhone 快捷指令需要使用 /upload-oss 接口"
        echo "   上传 URL: http://你的服务器地址:8888/upload-oss"
        echo ""
    else
        USER_ID=$(grep -o '"userId": "[^"]*"' .user-config.json | cut -d'"' -f4)
        print_success "用户配置文件已存在"
        print_info "用户ID: $USER_ID"
        echo ""
    fi
else
    # iCloud 模式
    print_step "步骤 5/6: 创建 iCloud 上传文件夹"
    print_info "创建iCloud上传文件夹..."
ICLOUD_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/FigmaSyncImg"
    
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
                print_warning "可能原因：iCloud Drive 未启用或空间不足"
                echo ""
                print_info "建议切换到 Google Drive 上传模式（选项 1）"
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

# ==================== 步骤6/7：启动服务 ====================
if [ "$USE_GOOGLE_DRIVE" = true ] || [ "$USE_ALIYUN_OSS" = true ]; then
    print_step "步骤 7/7: 启动同步服务"
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

if [ "$USE_GOOGLE_DRIVE" = true ] || [ "$USE_ALIYUN_OSS" = true ]; then
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
    
    if [ "$USE_GOOGLE_DRIVE" = true ]; then
        echo "  2. 配置 iPhone 快捷指令（Google Drive 上传模式）"
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
    elif [ "$USE_ALIYUN_OSS" = true ]; then
        echo "  2. 配置 iPhone 快捷指令（阿里云 OSS 上传模式）"
        echo ""
        echo "     📱 快捷指令配置步骤："
        echo "     ① 打开「快捷指令」App"
        echo "     ② 创建新快捷指令"
        echo "     ③ 添加操作："
        echo "        - 「获取最新截图」"
        echo "        - 「Base64编码」（编码：仅Base64）"
        echo "        - 「获取URL内容」（方法：POST）"
        echo "     ④ 设置URL（⚠️ 注意：使用 /upload-oss 接口）："
        
        # 检查是否有云服务 URL
        if [ -n "$SERVICE_URL" ]; then
            echo "        ${SERVICE_URL}/upload-oss"
            echo ""
            print_success "✅ 使用云服务公共 URL"
            echo "   - iPhone 和 Mac 不需要在同一网络"
            echo "   - 所有用户可以使用同一个 URL"
        elif [ "$DEPLOY_CHOICE" = "1" ]; then
            echo "        http://你的ECS公网IP:8888/upload-oss"
            echo ""
            print_info "💡 提示："
            echo "   - 部署到阿里云 ECS 后，使用 ECS 的公网 IP 地址"
            echo "   - 建议绑定域名并配置 HTTPS（需要备案）"
            echo "   - 详细部署步骤请参考: ALIYUN_ECS_DEPLOY.md"
        else
            echo "        http://localhost:8888/upload-oss（本地运行）"
            echo "        或：http://你的Mac地址:8888/upload-oss（本地网络）"
            echo ""
            print_info "💡 提示："
            echo "   - 本地运行：iPhone 和 Mac 需要在同一网络"
            echo "   - 获取 Mac IP 地址：系统设置 → 网络 → 查看 IP 地址"
            echo "   - 推荐：部署到阿里云 ECS 以获得稳定的公网访问"
        fi
        
        echo "     ⑤ 添加请求头："
        echo "        x-user-id: $USER_ID"
        echo "     ⑥ 请求体：JSON"
        echo "        {"
        echo "          \"filename\": \"截图\${当前日期}\","
        echo "          \"data\": \"\${Base64编码结果}\","
        echo "          \"mimeType\": \"image/heif\""
        echo "        }"
        echo "     注意：服务器会使用 macOS 的 sips 命令自动将 HEIF 格式转换为 JPEG"
    fi
    echo ""
    echo "  3. 开始使用"
    echo "     - 在Figma插件中选择「实时同步模式」或「手动同步模式」"
    echo "     - 在iPhone上截图，截图会自动同步到Figma！"
else
    echo "  2. 在iPhone上设置快捷指令（iCloud 上传模式）"
    echo ""
    echo "     📱 快捷指令配置步骤："
    echo "     ① 打开「快捷指令」App"
    echo "     ② 创建新快捷指令"
    echo "     ③ 添加操作："
    echo "        - 「获取最新截图」"
    echo "        - 「存储文件」（位置：iCloud Drive/FigmaSyncImg/）"
echo ""
echo "  3. 开始使用"
    echo "     - 在Figma插件中选择「实时同步模式」或「手动同步模式」"
    echo "     - 在iPhone上截图，截图会自动同步到Figma！"
fi
echo ""

read -p "按回车键启动服务..." 

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
    print_info "上传模式: Google Drive"
    echo ""
    npm start
elif [ "$USE_ALIYUN_OSS" = true ]; then
    print_info "启动阿里云 OSS 上传服务..."
    print_info "上传模式: 阿里云 OSS"
    echo ""
    npm start
else
    print_info "启动 iCloud 上传服务..."
    print_info "上传模式: iCloud"
    echo ""
npm start
fi