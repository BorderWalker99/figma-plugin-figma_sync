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

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 步骤 1: 检查并安装 ImageMagick
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  第一步：检查 ImageMagick 依赖"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 ImageMagick 是 GIF 导出功能的必需依赖"
echo ""

# 检查 ImageMagick 是否已安装
if command -v convert >/dev/null 2>&1 && command -v identify >/dev/null 2>&1 && command -v composite >/dev/null 2>&1; then
    echo "✅ ImageMagick 已安装"
    VERSION=$(convert --version 2>&1 | head -1)
    echo "   版本: $VERSION"
    echo ""
else
    echo "⚠️  ImageMagick 未安装"
    echo ""
    
    # 检查 Homebrew 是否已安装
    if command -v brew >/dev/null 2>&1; then
        echo "✅ 检测到 Homebrew 包管理器"
        echo ""
        echo "🔄 正在安装 ImageMagick..."
        echo "   （这可能需要几分钟时间，请耐心等待）"
        echo ""
        
        # 安装 ImageMagick
        if brew install imagemagick; then
            echo ""
            echo "✅ ImageMagick 安装成功！"
            VERSION=$(convert --version 2>&1 | head -1)
            echo "   版本: $VERSION"
            echo ""
        else
            echo ""
            echo "❌ ImageMagick 自动安装失败"
            echo ""
            echo "📋 请手动安装："
            echo "   打开终端，运行以下命令："
            echo "   brew install imagemagick"
            echo ""
            echo "⚠️  如果没有安装 Homebrew，请先安装："
            echo "   访问 https://brew.sh"
            echo "   或运行："
            echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            echo ""
            read -p "按回车键继续安装（GIF 导出功能将不可用）..."
        fi
    else
        echo "❌ 未检测到 Homebrew 包管理器"
        echo ""
        echo "📋 ImageMagick 需要 Homebrew 来安装"
        echo ""
        echo "请按照以下步骤操作："
        echo ""
        echo "1️⃣ 安装 Homebrew（如果尚未安装）："
        echo "   访问: https://brew.sh"
        echo "   或在终端运行:"
        echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        echo ""
        echo "2️⃣ 安装 ImageMagick:"
        echo "   brew install imagemagick"
        echo ""
        echo "⚠️  跳过 ImageMagick 安装将导致 GIF 导出功能不可用"
        echo ""
        read -p "按回车键继续安装（GIF 导出功能将不可用）..."
    fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 步骤 1.5: 检查并安装 FFmpeg
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  第一点五步：检查 FFmpeg 依赖"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 FFmpeg 是视频导出为 GIF 功能的必需依赖"
echo ""

# 检查 FFmpeg 是否已安装
if command -v ffmpeg >/dev/null 2>&1; then
    echo "✅ FFmpeg 已安装"
    VERSION=$(ffmpeg -version 2>&1 | head -1)
    echo "   版本: $VERSION"
    echo ""
else
    echo "⚠️  FFmpeg 未安装"
    echo ""
    
    # 检查 Homebrew 是否已安装
    if command -v brew >/dev/null 2>&1; then
        echo "✅ 检测到 Homebrew 包管理器"
        echo ""
        echo "🔄 正在安装 FFmpeg..."
        echo "   （这可能需要几分钟时间，请耐心等待）"
        echo ""
        
        # 安装 FFmpeg
        if brew install ffmpeg; then
            echo ""
            echo "✅ FFmpeg 安装成功！"
            VERSION=$(ffmpeg -version 2>&1 | head -1)
            echo "   版本: $VERSION"
            echo ""
        else
            echo ""
            echo "❌ FFmpeg 自动安装失败"
            echo ""
            echo "📋 请手动安装："
            echo "   打开终端，运行以下命令："
            echo "   brew install ffmpeg"
            echo ""
            echo "⚠️  如果没有安装 Homebrew，请先安装："
            echo "   访问 https://brew.sh"
            echo "   或运行："
            echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
            echo ""
            read -p "按回车键继续安装（视频导出功能将不可用）..."
        fi
    else
        echo "❌ 未检测到 Homebrew 包管理器"
        echo ""
        echo "📋 FFmpeg 需要 Homebrew 来安装"
        echo ""
        echo "请按照以下步骤操作："
        echo ""
        echo "1️⃣ 安装 Homebrew（如果尚未安装）："
        echo "   访问: https://brew.sh"
        echo "   或在终端运行:"
        echo "   /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        echo ""
        echo "2️⃣ 安装 FFmpeg:"
        echo "   brew install ffmpeg"
        echo ""
        echo "⚠️  跳过 FFmpeg 安装将导致视频导出功能不可用"
        echo ""
        read -p "按回车键继续安装（视频导出功能将不可用）..."
    fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 步骤 2: 清除安装器的隔离属性
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  第二步：准备安装器"
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
    echo "❌ 错误: 未找到安装器"
    echo "   正在查找: 第二步_双击安装.dmg 或 ScreenSync Installer.dmg/.app"
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
    echo "✅ 依赖检查完成"
    if command -v convert >/dev/null 2>&1; then
        echo "   • ImageMagick: 已安装 ✓"
    else
        echo "   • ImageMagick: 未安装 ⚠️ (GIF导出功能将不可用)"
    fi
    if command -v ffmpeg >/dev/null 2>&1; then
        echo "   • FFmpeg: 已安装 ✓"
    else
        echo "   • FFmpeg: 未安装 ⚠️ (视频导出功能将不可用)"
    fi
    echo ""
    echo "📋 下一步："
    echo "   1. 关闭此终端窗口"
    if [[ "$INSTALLER_NAME" == *.dmg ]]; then
        echo "   2. 【如果你已经打开了安装器窗口，请先将其关闭并弹出】"
        echo "   3. 重新双击 '$INSTALLER_NAME' 挂载安装盘"
        echo "   4. 在弹出的窗口中双击 'ScreenSync Installer' 图标"
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
