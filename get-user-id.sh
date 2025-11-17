#!/bin/bash
# get-user-id.sh - 获取用户ID脚本

echo "╔════════════════════════════════════════╗"
echo "║  获取 FigmaSync 用户ID                 ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 方法1：从配置文件读取
if [ -f ".user-config.json" ]; then
    USER_ID=$(grep -o '"userId": "[^"]*"' .user-config.json | cut -d'"' -f4)
    if [ -n "$USER_ID" ]; then
        echo "✅ 从配置文件读取用户ID："
        echo "   $USER_ID"
        echo ""
        echo "📋 复制以下内容到 iPhone 快捷指令的 x-user-id 请求头："
        echo "   $USER_ID"
        exit 0
    fi
fi

# 方法2：手动生成
USERNAME=$(whoami)
HOSTNAME=$(hostname)
USER_ID="${USERNAME}@${HOSTNAME}"

echo "ℹ️  配置文件不存在，自动生成用户ID："
echo "   $USER_ID"
echo ""

# 创建配置文件
cat > .user-config.json <<EOF
{
  "userId": "$USER_ID",
  "folderName": "FigmaSync-$USER_ID",
  "userFolderId": null,
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
}
EOF

echo "✅ 已创建配置文件：.user-config.json"
echo ""
echo "📋 复制以下内容到 iPhone 快捷指令的 x-user-id 请求头："
echo "   $USER_ID"
echo ""
echo "💡 提示："
echo "   1. 在 iPhone 快捷指令中添加请求头：x-user-id"
echo "   2. 值设置为：$USER_ID"
echo "   3. 保存快捷指令后测试上传"

