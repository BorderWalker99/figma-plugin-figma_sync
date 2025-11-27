#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# 检查是否已有实例在运行
PID=$(lsof -ti :8888)
if [ ! -z "$PID" ]; then
  echo "⚠️  检测到端口 8888 已被占用 (PID: $PID)"
  echo "🔄 正在停止旧进程..."
  kill -9 $PID
  sleep 1
fi

echo "🚀 正在后台启动开发服务器..."
# 使用 nohup 在后台运行 npm start，并将输出重定向到日志文件
nohup npm start > developer_server.log 2>&1 &

echo "✅ 服务器已在后台启动 (PID: $!)"
echo "📜 日志已重定向至: $DIR/developer_server.log"
echo ""
echo "💡 提示："
echo "1. 你可以关闭此终端窗口，服务器将继续运行。"
echo "2. 要查看实时日志，请运行: tail -f developer_server.log"
echo "3. 要停止服务器，请运行: lsof -ti :8888 | xargs kill -9"

