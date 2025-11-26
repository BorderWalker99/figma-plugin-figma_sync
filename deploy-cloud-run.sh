#!/bin/bash

# ============================================
# Google Cloud Run 部署脚本
# ============================================
# 用途：更新 server 相关代码后，运行此脚本重新部署到 Cloud Run
# 使用方法：./deploy-cloud-run.sh
# ============================================

set -e  # 遇到错误立即退出

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
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# 配置信息
PROJECT_ID="figmasync-477511"
SERVICE_NAME="figmasync-test"
REGION="asia-east2"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

print_step "开始部署到 Google Cloud Run"

# ==================== 步骤1：检查前置条件 ====================
print_info "步骤 1/5: 检查前置条件"

# 1.1 检查 serviceAccountKey.js
if [ ! -f "serviceAccountKey.js" ]; then
    print_error "未找到 serviceAccountKey.js 文件"
    print_warning "此文件包含 Google Drive API 的 Service Account 凭证，部署需要此文件"
    exit 1
fi
print_success "找到 serviceAccountKey.js"

# 1.2 检查 gcloud CLI
if ! command -v gcloud &> /dev/null; then
    print_error "未找到 gcloud CLI"
    print_info "请先安装 Google Cloud SDK:"
    echo "   brew install --cask google-cloud-sdk"
    exit 1
fi
print_success "gcloud CLI 已安装: $(gcloud version --format='value(Google Cloud SDK)' 2>/dev/null || echo '已安装')"

# 1.3 检查 Docker
if ! command -v docker &> /dev/null; then
    print_error "未找到 Docker"
    print_info "请先安装 Docker Desktop 或 Colima"
    exit 1
fi

if ! docker info &> /dev/null 2>&1; then
    print_error "Docker 未运行"
    print_info "请启动 Docker Desktop 或运行: colima start"
    exit 1
fi
print_success "Docker 已运行"

# ==================== 步骤2：配置 Google Cloud ====================
print_info "步骤 2/5: 配置 Google Cloud"

# 2.1 检查登录状态
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
if [ -z "$ACTIVE_ACCOUNT" ]; then
    print_warning "需要登录 Google Cloud"
    print_info "将打开浏览器进行登录..."
    gcloud auth login
    ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
    if [ -z "$ACTIVE_ACCOUNT" ]; then
        print_error "Google Cloud 登录失败"
        exit 1
    fi
fi
print_success "已登录: $ACTIVE_ACCOUNT"

# 2.2 设置项目
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
if [ "$CURRENT_PROJECT" != "$PROJECT_ID" ]; then
    print_info "设置 Google Cloud 项目: $PROJECT_ID"
    gcloud config set project $PROJECT_ID
fi
print_success "项目已设置: $PROJECT_ID"

# 2.3 启用 API
print_info "启用 Cloud Run API..."
gcloud services enable run.googleapis.com --quiet 2>/dev/null || true

# 2.4 配置 Docker 认证
print_info "配置 Docker 认证..."
gcloud auth configure-docker --quiet 2>/dev/null || true

# ==================== 步骤3：构建 Docker 镜像 ====================
print_info "步骤 3/5: 构建 Docker 镜像"

print_info "构建镜像（AMD64 架构，Cloud Run 要求）..."
print_info "镜像名称: $IMAGE_NAME"
echo ""

if docker build --platform linux/amd64 -t ${IMAGE_NAME} .; then
    print_success "Docker 镜像构建完成"
else
    print_error "Docker 镜像构建失败"
    exit 1
fi

# ==================== 步骤4：推送镜像 ====================
print_info "步骤 4/5: 推送镜像到 Google Container Registry"

print_info "推送镜像..."
if docker push ${IMAGE_NAME}; then
    print_success "镜像推送完成"
else
    print_error "镜像推送失败"
    exit 1
fi

# ==================== 步骤5：部署到 Cloud Run ====================
print_info "步骤 5/5: 部署到 Cloud Run"

print_info "部署配置："
echo "  服务名称: $SERVICE_NAME"
echo "  区域: $REGION"
echo "  内存: 512Mi"
echo "  超时: 300秒"
echo "  最大实例数: 10"
echo ""

print_info "正在部署..."
if gcloud run deploy ${SERVICE_NAME} \
    --image ${IMAGE_NAME} \
    --platform managed \
    --region ${REGION} \
    --allow-unauthenticated \
    --port 8080 \
    --memory 512Mi \
    --timeout 300 \
    --max-instances 10 \
    --min-instances 0; then
    print_success "部署完成！"
else
    print_error "部署失败"
    exit 1
fi

# ==================== 获取服务信息 ====================
echo ""
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)' 2>/dev/null || echo "")

if [ -n "$SERVICE_URL" ]; then
    print_success "服务已部署"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "服务 URL: $SERVICE_URL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    print_warning "⚠️  重要提示："
    echo ""
    echo "如果这是首次部署或更新了环境变量，需要在 Cloud Run 控制台设置环境变量："
    echo ""
    echo "访问: https://console.cloud.google.com/run/detail/${REGION}/${SERVICE_NAME}/variables"
    echo ""
    echo "需要设置的环境变量："
    echo "  - GDRIVE_FOLDER_ID: 你的 Google Drive 文件夹 ID"
    
    # 提取 CLIENT_EMAIL
    CLIENT_EMAIL=$(grep -o "client_email: '[^']*'" serviceAccountKey.js | sed "s/client_email: '//" | sed "s/'//" || echo "")
    if [ -n "$CLIENT_EMAIL" ]; then
        echo "  - GDRIVE_CLIENT_EMAIL: $CLIENT_EMAIL"
    else
        echo "  - GDRIVE_CLIENT_EMAIL: (从 serviceAccountKey.js 获取)"
    fi
    echo "  - GDRIVE_PRIVATE_KEY: (从 serviceAccountKey.js 复制 private_key 字段)"
    echo "  - UPLOAD_TOKEN: (可选) 上传接口令牌"
    echo ""
    
    print_info "查看日志:"
    echo "  gcloud run services logs read ${SERVICE_NAME} --region ${REGION} --limit 50"
    echo ""
    echo "  gcloud run services logs tail ${SERVICE_NAME} --region ${REGION}"
    echo ""
else
    print_warning "无法获取服务 URL，请检查部署状态"
fi

print_success "部署流程完成！"

