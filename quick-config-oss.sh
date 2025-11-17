#!/bin/bash

# 阿里云 OSS 快速配置脚本
# 用于快速配置 .env 文件中的 OSS 相关环境变量

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印函数
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_step() {
    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
}

# 获取脚本所在目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

print_step "阿里云 OSS 快速配置"

# 检查 .env 文件
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    print_info "创建 .env 文件..."
    touch "$ENV_FILE"
fi

# 配置 AccessKey ID
echo ""
print_info "步骤 1/5: 配置 AccessKey ID"
print_warning "提示：在阿里云 RAM 控制台创建 RAM 用户并获取 AccessKey"
read -p "请输入 ALIYUN_ACCESS_KEY_ID: " ACCESS_KEY_ID
if [ -z "$ACCESS_KEY_ID" ]; then
    print_error "AccessKey ID 不能为空"
    exit 1
fi

# 更新或添加配置
if grep -q "ALIYUN_ACCESS_KEY_ID" "$ENV_FILE" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ALIYUN_ACCESS_KEY_ID=.*|ALIYUN_ACCESS_KEY_ID=$ACCESS_KEY_ID|" "$ENV_FILE"
    else
        sed -i "s|^ALIYUN_ACCESS_KEY_ID=.*|ALIYUN_ACCESS_KEY_ID=$ACCESS_KEY_ID|" "$ENV_FILE"
    fi
    print_success "已更新 ALIYUN_ACCESS_KEY_ID"
else
    echo "ALIYUN_ACCESS_KEY_ID=$ACCESS_KEY_ID" >> "$ENV_FILE"
    print_success "已添加 ALIYUN_ACCESS_KEY_ID"
fi

# 配置 AccessKey Secret
echo ""
print_info "步骤 2/5: 配置 AccessKey Secret"
print_warning "提示：AccessKey Secret 只显示一次，请妥善保存"
read -p "请输入 ALIYUN_ACCESS_KEY_SECRET: " ACCESS_KEY_SECRET
if [ -z "$ACCESS_KEY_SECRET" ]; then
    print_error "AccessKey Secret 不能为空"
    exit 1
fi

# 更新或添加配置
if grep -q "ALIYUN_ACCESS_KEY_SECRET" "$ENV_FILE" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ALIYUN_ACCESS_KEY_SECRET=.*|ALIYUN_ACCESS_KEY_SECRET=$ACCESS_KEY_SECRET|" "$ENV_FILE"
    else
        sed -i "s|^ALIYUN_ACCESS_KEY_SECRET=.*|ALIYUN_ACCESS_KEY_SECRET=$ACCESS_KEY_SECRET|" "$ENV_FILE"
    fi
    print_success "已更新 ALIYUN_ACCESS_KEY_SECRET"
else
    echo "ALIYUN_ACCESS_KEY_SECRET=$ACCESS_KEY_SECRET" >> "$ENV_FILE"
    print_success "已添加 ALIYUN_ACCESS_KEY_SECRET"
fi

# 配置 Bucket
echo ""
print_info "步骤 3/5: 配置 Bucket 名称"
print_warning "提示：在 OSS 控制台查看 Bucket 列表获取名称"
read -p "请输入 ALIYUN_BUCKET: " BUCKET_NAME
if [ -z "$BUCKET_NAME" ]; then
    print_error "Bucket 名称不能为空"
    exit 1
fi

# 更新或添加配置
if grep -q "ALIYUN_BUCKET" "$ENV_FILE" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ALIYUN_BUCKET=.*|ALIYUN_BUCKET=$BUCKET_NAME|" "$ENV_FILE"
    else
        sed -i "s|^ALIYUN_BUCKET=.*|ALIYUN_BUCKET=$BUCKET_NAME|" "$ENV_FILE"
    fi
    print_success "已更新 ALIYUN_BUCKET"
else
    echo "ALIYUN_BUCKET=$BUCKET_NAME" >> "$ENV_FILE"
    print_success "已添加 ALIYUN_BUCKET"
fi

# 配置 Region
echo ""
print_info "步骤 4/5: 配置 Region（地域）"
print_warning "提示：常见地域：oss-cn-hangzhou, oss-cn-shanghai, oss-cn-beijing, oss-cn-shenzhen"
read -p "请输入 ALIYUN_REGION [oss-cn-hangzhou]: " REGION
REGION=${REGION:-oss-cn-hangzhou}

# 更新或添加配置
if grep -q "ALIYUN_REGION" "$ENV_FILE" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ALIYUN_REGION=.*|ALIYUN_REGION=$REGION|" "$ENV_FILE"
    else
        sed -i "s|^ALIYUN_REGION=.*|ALIYUN_REGION=$REGION|" "$ENV_FILE"
    fi
    print_success "已更新 ALIYUN_REGION"
else
    echo "ALIYUN_REGION=$REGION" >> "$ENV_FILE"
    print_success "已添加 ALIYUN_REGION"
fi

# 配置 Root Folder
echo ""
print_info "步骤 5/5: 配置 Root Folder（根文件夹）"
print_warning "提示：所有用户的文件夹将创建在此根文件夹下"
read -p "请输入 ALIYUN_ROOT_FOLDER [FigmaSync]: " ROOT_FOLDER
ROOT_FOLDER=${ROOT_FOLDER:-FigmaSync}

# 更新或添加配置
if grep -q "ALIYUN_ROOT_FOLDER" "$ENV_FILE" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|^ALIYUN_ROOT_FOLDER=.*|ALIYUN_ROOT_FOLDER=$ROOT_FOLDER|" "$ENV_FILE"
    else
        sed -i "s|^ALIYUN_ROOT_FOLDER=.*|ALIYUN_ROOT_FOLDER=$ROOT_FOLDER|" "$ENV_FILE"
    fi
    print_success "已更新 ALIYUN_ROOT_FOLDER"
else
    echo "ALIYUN_ROOT_FOLDER=$ROOT_FOLDER" >> "$ENV_FILE"
    print_success "已添加 ALIYUN_ROOT_FOLDER"
fi

# 完成
echo ""
print_step "配置完成"
print_success "所有配置已保存到 .env 文件"
echo ""
print_info "配置摘要:"
echo "   - AccessKey ID: ${ACCESS_KEY_ID:0:10}..."
echo "   - Bucket: $BUCKET_NAME"
echo "   - Region: $REGION"
echo "   - Root Folder: $ROOT_FOLDER"
echo ""
print_info "下一步:"
echo "   1. 运行验证脚本: node test-oss-config.js"
echo "   2. 启动服务: npm start"
echo "   3. 配置 iPhone 快捷指令使用 /upload-oss 接口"
echo ""

