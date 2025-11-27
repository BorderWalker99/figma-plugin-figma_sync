#!/bin/bash

# ScreenSync 安装前准备脚本
# 用途：清除 macOS Gatekeeper 的 quarantine 属性，允许运行未签名的应用

# 获取脚本所在的目录（UserPackage 根目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ScreenSync 安装前准备"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📂 工作目录: $SCRIPT_DIR"
echo ""

# 查找 ScreenSync Installer.app
INSTALLER_APP="$SCRIPT_DIR/ScreenSync Installer.app"

if [ ! -d "$INSTALLER_APP" ]; then
    echo "❌ 错误: 未找到 ScreenSync Installer.app"
    echo "   请确保此脚本与 ScreenSync Installer.app 在同一目录下"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

echo "🔍 找到安装器: ScreenSync Installer.app"
echo ""
echo "🔓 正在清除 macOS 安全限制..."
echo ""

# 清除 Installer.app 的 quarantine 属性
if xattr -cr "$INSTALLER_APP" 2>/dev/null; then
    echo "✅ 已成功清除安全限制"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ 准备完成！"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 下一步："
    echo "   1. 关闭此终端窗口"
    echo "   2. 双击 'ScreenSync Installer.app' 开始安装"
    echo ""
else
    echo "⚠️  部分清除失败，但可以继续尝试"
    echo ""
    echo "如果仍然无法运行安装器，请尝试："
    echo "   系统设置 → 隐私与安全性 → 点击「仍要打开」"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "按回车键关闭此窗口..."

