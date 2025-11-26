# ScreenSync GUI 安装器

图形化安装界面，让用户无需使用终端即可完成安装。

## 功能特性

- 🖥️ **图形化界面**：现代化的 UI 设计，操作简单直观
- 📦 **自动检测**：自动检测系统环境（Homebrew、Node.js）
- 🔧 **自动安装**：自动安装缺失的依赖
- ⚙️ **配置向导**：引导用户完成所有配置步骤
- 🚀 **一键启动**：安装完成后自动启动服务器

## 开发

### 安装依赖

```bash
cd installer
npm install
```

### 运行开发版本

```bash
npm start
```

### 打包应用

```bash
./build-installer.sh
```

打包完成后，应用会在 `installer/dist/` 目录下。

## 使用说明

### 对于开发者

1. 开发时运行：
   ```bash
   cd installer
   npm install
   npm start
   ```

2. 打包发布：
   ```bash
   ./build-installer.sh
   ```

### 对于用户

1. 解压 ScreenSync 安装包
2. 打开 `installer` 文件夹
3. 双击 `ScreenSync Installer.app` 或 `ScreenSync Installer.dmg`
4. 按照界面提示完成安装

## 安装步骤

安装器会引导用户完成以下步骤：

1. **选择安装目录**：选择解压后的 ScreenSync 文件夹
2. **选择储存方式**：Google Cloud 或 iCloud
3. **系统环境检查**：检查并安装 Homebrew、Node.js
4. **安装依赖**：自动运行 `npm install`
5. **配置设置**：自动配置系统设置和用户配置
6. **完成安装**：启动服务器并显示完成信息

## 技术栈

- **Electron**：跨平台桌面应用框架
- **Node.js**：后端逻辑处理
- **HTML/CSS/JavaScript**：前端界面

## 注意事项

- 需要 macOS 10.14 或更高版本
- 某些步骤需要管理员权限（会弹出密码输入框）
- 首次安装 Homebrew 可能需要较长时间

