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
echo "请选择启动模式："
echo ""
echo "  [1] 前台运行（默认）- 可查看日志，关闭终端会停止服务"
echo "  [2] 后台运行 - 服务持续运行，关闭终端也不影响"
echo "  [3] 重新配置自动启动 - 修复自动启动服务（推荐）"
echo ""
read -p "请选择 (1/2/3，默认1): " -n 1 -r MODE
echo ""
echo ""

# 进入工作目录
cd "$SCRIPT_DIR"

if [[ $MODE == "3" ]]; then
    # 重新配置自动启动
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  重新配置自动启动服务"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "🔄 正在重新配置 launchd 服务..."
    echo ""
    
    # 检查 plist 文件是否存在
    if [ ! -f "$SCRIPT_DIR/com.screensync.server.plist" ]; then
        echo "❌ 错误: 未找到 com.screensync.server.plist"
        echo "   请确保完整安装了 ScreenSync"
        echo ""
        read -p "按回车键退出..."
        exit 1
    fi
    
    # 查找 node 路径
    NODE_PATH=$(which node)
    if [ -z "$NODE_PATH" ]; then
        # 尝试常见位置
        if [ -f "/opt/homebrew/bin/node" ]; then
            NODE_PATH="/opt/homebrew/bin/node"
        elif [ -f "/usr/local/bin/node" ]; then
            NODE_PATH="/usr/local/bin/node"
        else
            echo "❌ 错误: 未找到 Node.js"
            echo "   请确保 Node.js 已正确安装"
            echo ""
            read -p "按回车键退出..."
            exit 1
        fi
    fi
    
    echo "📍 检测到 Node.js 路径: $NODE_PATH"
    
    # 准备 plist 文件
    PLIST_CONTENT=$(cat "$SCRIPT_DIR/com.screensync.server.plist")
    PLIST_CONTENT="${PLIST_CONTENT//__NODE_PATH__/$NODE_PATH}"
    PLIST_CONTENT="${PLIST_CONTENT//__INSTALL_PATH__/$SCRIPT_DIR}"
    
    # 写入到用户的 LaunchAgents
    LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
    PLIST_PATH="$LAUNCH_AGENTS_DIR/com.screensync.server.plist"
    
    mkdir -p "$LAUNCH_AGENTS_DIR"
    echo "$PLIST_CONTENT" > "$PLIST_PATH"
    
    echo "✅ plist 文件已创建: $PLIST_PATH"
    echo ""
    
    # 卸载旧服务（忽略错误）
    echo "🗑️  卸载旧服务..."
    launchctl unload "$PLIST_PATH" 2>/dev/null
    
    # 加载新服务
    echo "📥 加载新服务..."
    if launchctl load "$PLIST_PATH" 2>&1; then
        echo "✅ 服务加载成功"
    else
        echo "⚠️  服务加载可能失败，尝试继续..."
    fi
    
    echo ""
    echo "🚀 启动服务..."
    launchctl start com.screensync.server
    
    # 等待服务启动
    echo "⏳ 等待服务启动（3秒）..."
    sleep 3
    
    # 检查服务状态
    echo ""
    echo "🔍 检查服务状态..."
    if lsof -i :8888 | grep LISTEN > /dev/null 2>&1; then
        echo "✅ 服务器正在运行（端口 8888 已监听）"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  ✅ 配置完成！"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "服务器已配置为开机自动启动，并且现在正在后台运行。"
        echo "您可以关闭此终端窗口，服务器会持续运行。"
        echo ""
        echo "💡 查看服务状态："
        echo "   launchctl list | grep screensync"
        echo ""
        echo "💡 查看日志："
        echo "   tail -f $SCRIPT_DIR/server.log"
        echo "   tail -f $SCRIPT_DIR/server-error.log"
    else
        echo "⚠️  服务可能未成功启动"
        echo ""
        echo "请查看错误日志："
        echo "   cat $SCRIPT_DIR/server-error.log"
        echo ""
        echo "或尝试前台运行查看详细错误："
        echo "   重新运行此脚本并选择选项 [1]"
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    read -p "按回车键关闭此窗口..."
    
elif [[ $MODE == "2" ]]; then
    # 后台模式
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  后台启动模式"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "🔄 正在启动服务（后台运行）..."
    
    # 使用 nohup 在后台运行，输出到日志文件
    nohup npm start > "$SCRIPT_DIR/manual-server.log" 2>&1 &
    SERVER_PID=$!
    
    # 等待2秒检查服务是否启动成功
    sleep 2
    
    if ps -p $SERVER_PID > /dev/null 2>&1; then
        echo "✅ 服务器已在后台启动！"
        echo ""
        echo "📋 服务信息："
        echo "   进程 ID: $SERVER_PID"
        echo "   日志文件: $SCRIPT_DIR/manual-server.log"
        echo ""
        echo "🔍 检查服务状态："
        if lsof -i :8888 | grep LISTEN > /dev/null 2>&1; then
            echo "   ✅ 端口 8888 正在监听"
        else
            echo "   ⚠️  端口 8888 未监听（可能正在启动）"
        fi
        echo ""
        echo "💡 如需查看日志："
        echo "   tail -f $SCRIPT_DIR/manual-server.log"
        echo ""
        echo "💡 如需停止服务："
        echo "   kill $SERVER_PID"
        echo "   或终端运行: lsof -i :8888 | grep LISTEN | awk '{print \$2}' | xargs kill"
        echo ""
        echo "✅ 您现在可以关闭此终端窗口"
        echo "   服务器将继续在后台运行"
    else
        echo "❌ 服务器启动失败"
        echo "   请查看日志文件: $SCRIPT_DIR/manual-server.log"
        cat "$SCRIPT_DIR/manual-server.log"
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    read -p "按回车键关闭此窗口..."
    
else
    # 前台模式（默认）
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  前台运行模式"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "⚠️  请保持此窗口打开"
    echo "   关闭窗口将停止服务器"
    echo ""
    echo "💡 提示：如果需要关闭终端但保持服务运行，"
    echo "   请重新运行此脚本并选择「后台运行」模式"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # 启动服务器
    npm start
    
    # 如果服务器退出
    echo ""
    echo "⚠️  服务器已停止"
    echo ""
    read -p "按回车键退出..."
fi

