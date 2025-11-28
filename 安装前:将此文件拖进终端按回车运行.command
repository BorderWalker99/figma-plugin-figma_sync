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

# 检查是否有 quarantine 属性
echo "🔍 检查当前安全属性..."
HAS_QUARANTINE=false
if xattr "$INSTALLER_APP" 2>/dev/null | grep -q "com.apple.quarantine"; then
    echo "   ⚠️  检测到 macOS 隔离属性（Gatekeeper 限制）"
    HAS_QUARANTINE=true
else
    echo "   ✅ 未检测到隔离属性"
fi
echo ""

# 尝试清除
echo "🔓 正在清除 macOS 安全限制..."
echo ""

# 多重方法确保清除成功
CLEARED=false

# 方法 1: 使用 xattr -cr（递归清除）
echo "   [1/4] 使用 xattr -cr 清除..."
if xattr -cr "$INSTALLER_APP" 2>/dev/null; then
    echo "        ✅ xattr -cr 执行成功"
    CLEARED=true
else
    echo "        ⚠️  xattr -cr 遇到错误"
fi

# 方法 2: 单独清除 quarantine 属性
echo ""
echo "   [2/4] 单独清除 quarantine 属性..."
xattr -d com.apple.quarantine "$INSTALLER_APP" 2>/dev/null && echo "        ✅ 已清除 quarantine" || echo "        ℹ️  无 quarantine 属性"

# 方法 3: 清除 WhereFroms 属性
echo ""
echo "   [3/4] 清除 WhereFroms 属性..."
xattr -d com.apple.metadata:kMDItemWhereFroms "$INSTALLER_APP" 2>/dev/null && echo "        ✅ 已清除 WhereFroms" || echo "        ℹ️  无 WhereFroms 属性"

# 方法 4: 递归清除 .app 内部所有文件
echo ""
echo "   [4/4] 递归清除内部所有文件..."
find "$INSTALLER_APP" -print0 2>/dev/null | xargs -0 xattr -c 2>/dev/null
echo "        ✅ 递归清除完成"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 最终验证
echo "🔍 验证清除结果..."
if xattr "$INSTALLER_APP" 2>/dev/null | grep -q "com.apple.quarantine"; then
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
    echo "   2. 【右键点击】ScreenSync Installer.app"
    echo "   3. 选择【打开】（不是双击！）"
    echo "   4. 在弹出的对话框中点击【打开】按钮"
    echo ""
    echo "备选方法（如果上述方法不行）："
    echo "   1. 尝试双击 ScreenSync Installer.app"
    echo "   2. 如果提示无法打开，去【系统设置】→【隐私与安全性】"
    echo "   3. 找到「仍要打开」按钮并点击"
    echo ""
    echo "高级方法（需要管理员密码）："
    echo "   在终端中运行："
    echo "   sudo xattr -cr \"$INSTALLER_APP\""
    echo ""
else
    echo "   ✅ 所有隔离属性已清除"
    echo ""
    
    # 显示剩余的属性（如果有）
    REMAINING_ATTRS=$(xattr "$INSTALLER_APP" 2>/dev/null)
    if [ -n "$REMAINING_ATTRS" ]; then
        echo "   ℹ️  剩余属性（这些是安全的）："
        echo "$REMAINING_ATTRS" | sed 's/^/      /'
        echo ""
    fi
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ 准备完成！"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📋 下一步："
    echo "   1. 关闭此终端窗口"
    echo "   2. 双击 'ScreenSync Installer.app' 开始安装"
    echo ""
    echo "💡 如果仍然无法打开："
    echo "   【右键点击】→ 选择【打开】→ 点击【打开】按钮"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "按回车键关闭此窗口..."
