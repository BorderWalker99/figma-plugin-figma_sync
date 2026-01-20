# iPhone截图自动同步到Figma

## 快速开始

### 一键安装（推荐）

在终端中运行：
```bash
cd ScreenSync
./install-and-run.sh
```

脚本会自动完成所有安装步骤。

### 手动安装

如果自动脚本失败，可以手动执行：
```bash
# 1. 开启"任何来源"
sudo spctl --master-disable

# 2. 安装Homebrew（如已安装可跳过）
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 3. 配置Homebrew环境变量
# Apple Silicon (M1/M2/M3):
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
# Intel Mac:
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/usr/local/bin/brew shellenv)"

# 4. 安装Node.js
brew install node

# 5. 安装依赖
npm install

# 6. 启动服务
npm start
```

## Figma插件安装

1. 打开Figma Desktop
2. 菜单：Plugins → Development → Import plugin from manifest
3. 选择：`figma-plugin/manifest.json`
4. 运行插件并开始使用

## 使用说明

1. 启动Mac端服务（运行 `npm start`）
2. 在Figma中打开插件
3. 选择同步模式（实时或手动）
4. 在iPhone上截图
5. 截图自动同步到Figma

## 系统要求

### 推荐配置（使用图形化安装器）
- **macOS 14 (Sonoma) 或更高版本**
- Apple Silicon (M1/M2/M3/M4) 或 Intel 芯片
- iCloud Drive 已启用（iCloud 模式）
- Figma Desktop 应用
- 至少 2GB 可用磁盘空间

### 最低配置
- **macOS 11 (Big Sur) 或更高版本**
- ⚠️ **macOS 11-13 用户**：Homebrew 支持有限，依赖安装时间可能较长（10-30分钟）

### 不支持的系统
- ❌ **macOS 10.15 (Catalina) 及更早版本**
- 这些系统无法使用图形化安装器
- 请查看 [手动安装指南（旧系统）](./MANUAL_INSTALL_LEGACY.md)

## 故障排除

### macOS 版本兼容性问题

**问题：** 安装器提示"Homebrew 不支持此系统版本"

**原因：** 你的 macOS 版本太旧（10.15 或更早）

**解决方案：**
1. **推荐**：升级到 macOS 14 (Sonoma) 或更高版本
2. **备选**：查看 [手动安装指南（旧系统）](./MANUAL_INSTALL_LEGACY.md)

---

**问题：** macOS 11-13 上依赖安装非常慢

**原因：** Homebrew 对这些版本仅提供有限支持，需要从源码编译

**解决方案：**
- 耐心等待（首次安装可能需要 10-30 分钟）
- 确保安装了 Xcode Command Line Tools：
  ```bash
  xcode-select --install
  ```
- 或升级到 macOS 14+

### macOS 13 用户的 Sharp 兼容性问题

**问题：** 服务器启动失败，提示 Sharp 相关错误

**原因：** Node.js 版本太新（23.x），与旧版本 Sharp 不兼容

**解决方案：**
- 本项目已升级到 Sharp 0.34.5，完全兼容 Node.js 22/23
- 重新安装依赖：
  ```bash
  rm -rf node_modules package-lock.json
  npm install
  ```

### 端口被占用

如果8888端口被占用，修改以下文件中的端口号：
- `server.js`
- `icloud-watcher.js`
- `figma-plugin/ui.html`

### 依赖安装失败
```bash
# 清除缓存重新安装
rm -rf node_modules package-lock.json
npm install
```

### 服务无法启动
```bash
# 检查Node.js版本（需要v18.17+）
node -v

# 如果版本过低，升级
brew upgrade node
```
