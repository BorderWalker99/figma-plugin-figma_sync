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
echo "📂 工作目录: $SCRIPT_DIR"
echo ""

# 查找安装器（DMG 或 .app）
INSTALLER_PATH=""
INSTALLER_NAME=""

# 优先检查 DMG（压缩版）
if [ -f "$SCRIPT_DIR/ScreenSync Installer.dmg" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/ScreenSync Installer.dmg"
    INSTALLER_NAME="ScreenSync Installer.dmg"
elif [ -f "$SCRIPT_DIR/ScreenSync Installer-1.0.0.dmg" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/ScreenSync Installer-1.0.0.dmg"
    INSTALLER_NAME="ScreenSync Installer-1.0.0.dmg"
# 兼容检查 arm64 DMG
elif [ -f "$SCRIPT_DIR/ScreenSync Installer-1.0.0-arm64.dmg" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/ScreenSync Installer-1.0.0-arm64.dmg"
    INSTALLER_NAME="ScreenSync Installer-1.0.0-arm64.dmg"
# 回退检查 .app（旧版或解压版）
elif [ -d "$SCRIPT_DIR/ScreenSync Installer.app" ]; then
    INSTALLER_PATH="$SCRIPT_DIR/ScreenSync Installer.app"
    INSTALLER_NAME="ScreenSync Installer.app"
fi

if [ -z "$INSTALLER_PATH" ]; then
    echo "❌ 错误: 未找到安装器 (ScreenSync Installer.dmg 或 .app)"
    echo "   请确保此脚本与安装器在同一目录下"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

echo "🔍 找到安装器: $INSTALLER_NAME"
echo ""

# 检查是否有 quarantine 属性
echo "🔍 检查当前安全属性..."
HAS_QUARANTINE=false
if xattr "$INSTALLER_PATH" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "   ⚠️  检测到 macOS 隔离属性（Gatekeeper 限制）"
    HAS_QUARANTINE=true
else
    echo "   ✅ 未检测到隔离属性"
fi
echo ""

# 尝试清除
echo "🔓 正在清除 macOS 安全限制..."
echo ""

# 方法 1: 使用 xattr -cr
echo "   [1/3] 使用 xattr -cr 清除..."
if xattr -cr "$INSTALLER_PATH" 2>/dev/null; then
    echo "        ✅ xattr -cr 执行成功"
else
    echo "        ⚠️  xattr -cr 遇到错误（如果是 DMG，这是正常的，继续尝试其他方法）"
    # DMG 可能不支持递归清除，尝试非递归
    xattr -c "$INSTALLER_PATH" 2>/dev/null
fi

# 方法 2: 单独清除 quarantine 属性
echo ""
echo "   [2/3] 单独清除 quarantine 属性..."
xattr -d com.apple.quarantine "$INSTALLER_PATH" 2>/dev/null && echo "        ✅ 已清除 quarantine" || echo "        ℹ️  无 quarantine 属性"

# 方法 3: 清除 WhereFroms 属性
echo ""
echo "   [3/3] 清除 WhereFroms 属性..."
xattr -d com.apple.metadata:kMDItemWhereFroms "$INSTALLER_PATH" 2>/dev/null && echo "        ✅ 已清除 WhereFroms" || echo "        ℹ️  无 WhereFroms 属性"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 最终验证
echo "🔍 验证清除结果..."
if xattr "$INSTALLER_PATH" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "   ⚠️  quarantine 属性仍然存在"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⚠️  需要手动操作"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "脚本已尽力清除，但可能需要您手动操作："
    echo ""
    echo "✅ 推荐方法（最简单）："
    echo "   1. 关闭此窗口"
    echo "   2. 【右键点击】$INSTALLER_NAME"
    echo "   3. 选择【打开】（不是双击！）"
    echo "   4. 在弹出的对话框中点击【打开】按钮"
    echo ""
    echo "高级方法（需要管理员密码）："
    echo "   在终端中运行："
    echo "   sudo xattr -c \"$INSTALLER_PATH\""
    echo ""
else
    echo "   ✅ 所有隔离属性已清除"
    echo ""
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ 准备完成！"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 下一步："
    echo "   1. 关闭此终端窗口"
    if [[ "$INSTALLER_NAME" == *.dmg ]]; then
        echo "   2. 双击 '$INSTALLER_NAME' 挂载安装盘"
        echo "   3. 在弹出的窗口中双击 'ScreenSync Installer' 图标"
    else
        echo "   2. 双击 '$INSTALLER_NAME' 开始安装"
    fi
    echo ""
    echo "💡 如果仍然无法打开："
    echo "   【右键点击】→ 选择【打开】→ 点击【打开】按钮"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "按回车键关闭此窗口..."
