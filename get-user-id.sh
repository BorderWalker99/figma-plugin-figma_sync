#!/bin/bash
# get-user-id.sh - 获取用户ID脚本

echo "╔════════════════════════════════════════╗"
echo "║  获取 ScreenSync 用户ID                 ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 方法1：从配置文件读取
if [ -f ".user-config.json" ]; then
    USER_ID=$(grep -o '"userId": "[^"]*"' .user-config.json | cut -d'"' -f4)
    if [ -n "$USER_ID" ]; then
        echo "✅ 您的用户ID："
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
  "folderName": "ScreenSync-$USER_ID",
  "userFolderId": null,
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
}
EOF

echo "✅ 已创建配置文件：.user-config.json"
echo ""
echo "✅ 您的用户ID："
echo "   $USER_ID"

