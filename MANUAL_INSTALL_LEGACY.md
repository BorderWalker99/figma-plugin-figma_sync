# ScreenSync 手动安装指南（旧系统版本）

本指南适用于 **macOS 10.15 (Catalina) 及更早版本**的用户。

由于 Homebrew 不支持这些旧系统，你需要手动安装依赖。

---

## 系统要求

- **最低要求**：macOS 10.13 或更高
- **推荐**：升级到 macOS 14 (Sonoma) 或更高版本以获得最佳体验
- 磁盘空间：至少 2GB 可用空间

---

## 步骤 1：安装 Node.js

### 方法 A：使用官方安装包（推荐）

1. 访问 Node.js 官方网站：https://nodejs.org/
2. 下载 **LTS 版本**的 macOS 安装包（.pkg 文件）
   - Intel Mac：下载 x64 版本
   - Apple Silicon Mac：下载 ARM64 版本
3. 双击 .pkg 文件，按照提示安装
4. 验证安装：
   ```bash
   node --version
   npm --version
   ```

### 推荐版本

- **Node.js 20.x LTS**（最稳定）
- 或 Node.js 22.x LTS

**下载链接：**
- LTS: https://nodejs.org/en/download/

---

## 步骤 2：安装 ImageMagick

### 方法 A：使用预编译二进制包

1. 访问 ImageMagick 官方下载页面：
   https://imagemagick.org/script/download.php

2. 下载适合你系统的二进制包：
   - Intel Mac: `ImageMagick-x86_64-apple-darwin*.tar.gz`
   - Apple Silicon Mac: `ImageMagick-arm64-apple-darwin*.tar.gz`

3. 解压并安装：
   ```bash
   # 解压
   tar xvzf ImageMagick-*.tar.gz
   
   # 移动到 /usr/local
   sudo mkdir -p /usr/local/imagemagick
   sudo mv ImageMagick-*/* /usr/local/imagemagick/
   
   # 创建符号链接
   sudo ln -s /usr/local/imagemagick/bin/magick /usr/local/bin/magick
   sudo ln -s /usr/local/imagemagick/bin/convert /usr/local/bin/convert
   sudo ln -s /usr/local/imagemagick/bin/identify /usr/local/bin/identify
   ```

4. 验证安装：
   ```bash
   magick -version
   ```

### 方法 B：使用 MacPorts（如果已安装）

```bash
sudo port install ImageMagick
```

---

## 步骤 3：安装 FFmpeg

### 方法 A：使用静态编译版本（推荐）

1. 访问 Evermeet FFmpeg 下载页：
   https://evermeet.cx/ffmpeg/

2. 下载最新版本：
   - Intel Mac: 下载 `ffmpeg-*.7z` (Intel)
   - Apple Silicon Mac: 下载 ARM64 版本

3. 解压并安装：
   ```bash
   # 如果需要 7z 工具，先安装：
   # 从 https://www.7-zip.org/ 下载
   
   # 解压 FFmpeg
   7z x ffmpeg-*.7z
   
   # 移动到系统路径
   sudo mv ffmpeg /usr/local/bin/
   sudo chmod +x /usr/local/bin/ffmpeg
   
   # 解除隔离属性
   sudo xattr -dr com.apple.quarantine /usr/local/bin/ffmpeg
   ```

4. 验证安装：
   ```bash
   ffmpeg -version
   ```

### 替代下载源

- **OSXExperts.net**: https://www.osxexperts.net/
- **Martin Riedl**: https://ffmpeg.martin-riedl.de/

---

## 步骤 4：安装 ScreenSync

1. 下载 ScreenSync 用户包：
   - Intel Mac: `ScreenSync-Intel.tar.gz`
   - Apple Silicon Mac: `ScreenSync-Apple.tar.gz`

2. 解压安装包：
   ```bash
   tar -xzf ScreenSync-*.tar.gz
   cd ScreenSync-*/项目文件
   ```

3. 安装 Node.js 依赖：
   ```bash
   npm install --production
   ```

4. 启动服务器：
   ```bash
   node start.js
   ```

5. 如果服务器成功启动，配置自启动：
   ```bash
   # 编辑 plist 文件，替换路径
   nano com.screensync.server.plist
   
   # 将文件复制到 LaunchAgents
   cp com.screensync.server.plist ~/Library/LaunchAgents/
   
   # 加载服务
   launchctl load ~/Library/LaunchAgents/com.screensync.server.plist
   ```

---

## 步骤 5：导入 Figma 插件

1. 打开 Figma Desktop 应用
2. 菜单：`Plugins → Development → Import plugin from manifest`
3. 选择：`项目文件/figma-plugin/manifest.json`
4. 点击确认完成导入

---

## 故障排除

### Node.js 相关

**问题：** `node: command not found`

**解决：** 确保 Node.js 已正确安装并添加到 PATH：
```bash
export PATH="/usr/local/bin:$PATH"
```

### ImageMagick 相关

**问题：** `convert: command not found`

**解决：** 创建符号链接：
```bash
sudo ln -s /usr/local/imagemagick/bin/magick /usr/local/bin/magick
sudo ln -s /usr/local/imagemagick/bin/convert /usr/local/bin/convert
```

### FFmpeg 相关

**问题：** `"ffmpeg" cannot be opened because the developer cannot be verified`

**解决：** 解除隔离属性：
```bash
sudo xattr -dr com.apple.quarantine /usr/local/bin/ffmpeg
```

### 权限问题

**问题：** `Permission denied`

**解决：** 添加执行权限：
```bash
chmod +x /path/to/binary
```

---

## 版本兼容性

| 组件 | 推荐版本 | 最低版本 |
|------|----------|----------|
| Node.js | 20.x LTS | 18.17.0 |
| ImageMagick | 7.x | 7.0.0 |
| FFmpeg | 6.x / 7.x | 4.4.0 |

---

## 获取帮助

如果遇到问题：

1. 查看 GitHub Issues
2. 加入用户社区
3. 提交问题报告时，请附上：
   - macOS 版本
   - Node.js 版本 (`node --version`)
   - 错误日志

---

## 推荐：升级 macOS

为了获得最佳体验，我们强烈建议升级到 macOS 14 (Sonoma) 或更高版本：

- ✅ 自动化安装流程
- ✅ 更好的性能和稳定性
- ✅ 更快的依赖安装速度
- ✅ 完整的技术支持

---

最后更新：2026-01-20
