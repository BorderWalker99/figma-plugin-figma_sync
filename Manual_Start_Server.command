#!/bin/bash

# ScreenSync 手动启动脚本
# 用途：在自动启动失败时，手动启动服务器

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ScreenSync 手动启动"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📂 工作目录: $SCRIPT_DIR"
echo ""

# 检查是否在正确的目录
if [ ! -f "$SCRIPT_DIR/server.js" ]; then
    echo "❌ 错误: 未找到 server.js"
    echo "   请确保此脚本在 ScreenSync 安装目录下运行"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

# 检查 node 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js"
    echo "   请先完成安装程序中的环境配置步骤"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

echo "🔍 检查服务器状态..."

# 检查端口 8888 是否已被占用
if lsof -i :8888 | grep LISTEN > /dev/null 2>&1; then
    echo "⚠️  端口 8888 已被占用"
    echo ""
    echo "服务器可能已经在运行中。"
    echo "如果 Figma 插件仍然无法连接，请尝试："
    echo "  1. 关闭 Figma 并重新打开"
    echo "  2. 或者先停止现有服务，然后重新启动"
    echo ""
    read -p "是否要停止现有服务并重启？(y/N): " -n 1 -r
    echo ""
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🛑 正在停止现有服务..."
        # 查找并终止占用端口的进程
        PIDS=$(lsof -i :8888 | grep LISTEN | awk '{print $2}' | sort -u)
        for PID in $PIDS; do
            if [ ! -z "$PID" ]; then
                kill -9 "$PID" 2>/dev/null && echo "   ✅ 已终止进程 $PID"
            fi
        done
        sleep 2
    else
        echo "取消操作"
        read -p "按回车键退出..."
        exit 0
    fi
fi

echo ""
echo "🚀 正在启动 ScreenSync 服务器..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "⚠️  请保持此窗口打开"
echo "   关闭窗口将停止服务器"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 进入工作目录
cd "$SCRIPT_DIR"

# 启动服务器
npm start

# 如果服务器退出
echo ""
echo "⚠️  服务器已停止"
echo ""
read -p "按回车键退出..."

