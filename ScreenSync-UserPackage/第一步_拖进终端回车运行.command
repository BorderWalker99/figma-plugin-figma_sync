#!/bin/bash

# ScreenSync 安装前准备脚本
# 用途：清除 macOS Gatekeeper 的 quarantine 属性，允许运行未签名的应用

# 获取脚本所在的目录（UserPackage 根目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ScreenSync 安装前准备"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 本脚本用途："
echo "   清除 macOS Gatekeeper 安全限制，允许运行未签名的应用"
echo ""
echo "💡 提示："
echo "   所有依赖（Homebrew、Node.js、ImageMagick、FFmpeg）"
echo "   将在安装器中自动检查和安装"
echo ""
echo "📂 工作目录: $SCRIPT_DIR"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 清除安装器的隔离属性
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  清除 macOS 安全限制"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 查找安装器（DMG 或 .app）
INSTALLER_PATH=""
INSTALLER_NAME=""

# 优先检查新的统一命名 DMG
if [ -f "$SCRIPT_DIR/第二步_双击安装.dmg" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/第二步_双击安装.dmg"
    INSTALLER_NAME="第二步_双击安装.dmg"
# 兼容旧版本的命名
elif [ -f "$SCRIPT_DIR/ScreenSync Installer.dmg" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/ScreenSync Installer.dmg"
    INSTALLER_NAME="ScreenSync Installer.dmg"
# 查找任何版本的 arm64 DMG（优先）
elif ls "$SCRIPT_DIR"/ScreenSync\ Installer-*-arm64.dmg 1> /dev/null 2>&1; then
    INSTALLER_PATH=$(ls "$SCRIPT_DIR"/ScreenSync\ Installer-*-arm64.dmg | head -1)
    INSTALLER_NAME=$(basename "$INSTALLER_PATH")
# 查找任何版本的通用 DMG
elif ls "$SCRIPT_DIR"/ScreenSync\ Installer-*.dmg 1> /dev/null 2>&1; then
    INSTALLER_PATH=$(ls "$SCRIPT_DIR"/ScreenSync\ Installer-*.dmg | grep -v "arm64" | head -1)
    INSTALLER_NAME=$(basename "$INSTALLER_PATH")
# 回退检查 .app（旧版或解压版）
elif [ -d "$SCRIPT_DIR/ScreenSync Installer.app" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/ScreenSync Installer.app"
    INSTALLER_NAME="ScreenSync Installer.app"
fi

if [ -z "$INSTALLER_PATH" ]; then
    echo "   ❌ 错误：未找到安装器"
    echo ""
    echo "   正在查找："
    echo "      • 第二步_双击安装.dmg"
    echo "      • ScreenSync Installer.dmg"
    echo "      • ScreenSync Installer.app"
    echo ""
    echo "   请确保此脚本与安装器在同一目录下"
    echo ""
    read -p "   按回车键退出..."
    exit 1
fi

echo "   📦 安装器：$INSTALLER_NAME"
echo ""

# 检查是否有 quarantine 属性
HAS_QUARANTINE=false
if xattr "$INSTALLER_PATH" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "   ⚠️  检测到 Gatekeeper 隔离属性"
    HAS_QUARANTINE=true
else
    echo "   ✅ 无隔离属性"
fi
echo ""

# 尝试清除
echo "   🔧 清除安全限制..."
echo ""

# 方法 1: 使用 xattr -cr
echo "      [1/3] xattr -cr..."
if xattr -cr "$INSTALLER_PATH" 2>/dev/null; then
    echo "            ✅ 成功"
else
    echo "            ⚠️  失败（DMG 文件正常，继续尝试）"
    xattr -c "$INSTALLER_PATH" 2>/dev/null
fi

# 方法 2: 单独清除 quarantine 属性
echo ""
echo "      [2/3] 清除 quarantine..."
xattr -d com.apple.quarantine "$INSTALLER_PATH" 2>/dev/null && echo "            ✅ 成功" || echo "            ℹ️  无此属性"

# 方法 3: 清除 WhereFroms 属性
echo ""
echo "      [3/3] 清除 WhereFroms..."
xattr -d com.apple.metadata:kMDItemWhereFroms "$INSTALLER_PATH" 2>/dev/null && echo "            ✅ 成功" || echo "            ℹ️  无此属性"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 最终验证
echo "   🔍 验证清除结果..."
echo ""
if xattr "$INSTALLER_PATH" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "   ⚠️  隔离属性仍然存在"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠️  需要手动操作"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "自动清除未完全成功，请手动操作："
    echo ""
    echo "✅ 推荐方法（最简单）："
    echo "   1. 关闭此窗口"
    echo "   2. 右键点击 '$INSTALLER_NAME'"
    echo "   3. 选择「打开」（不是双击！）"
    echo "   4. 在弹窗中点击「打开」按钮"
    echo ""
    echo "高级方法（需要密码）："
    echo "   sudo xattr -c \"$INSTALLER_PATH\""
    echo ""
else
    echo "   ✅ 清除成功"
    echo ""
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ 准备完成"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 下一步："
    if [[ "$INSTALLER_NAME" == *.dmg ]]; then
        echo "   1. 关闭此窗口"
        echo "   2. 双击 '$INSTALLER_NAME'"
        echo "   3. 在弹出窗口中双击 'ScreenSync Installer' 图标"
    else
        echo "   1. 关闭此窗口"
        echo "   2. 双击 '$INSTALLER_NAME' 开始安装"
    fi
    echo ""
    echo "💡 提示："
    echo "   • 安装器将自动检查和安装所有必需的依赖"
    echo "   • 如果安装器无法打开，右键点击 → 选择「打开」"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "按回车键关闭..."
