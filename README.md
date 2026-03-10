# ScreenSync

ScreenSync 用于把 iPhone 截图、录屏和 GIF 更快地同步到 Figma。当前版本同时覆盖两条主链路：

- 自动同步：手机素材进入云端后，Mac 端自动拉取、处理并导入 Figma
- 手动导入 / GIF 导出：在插件内手动触发同步，或直接导出 GIF

当前自动同步与导出链路已经统一到同一套视频转 GIF 处理管线，目标是更小体积、更稳定画质和更可控的总耗时。

## 当前能力

- 支持 `Google Drive` 和 `iCloud` 两种储存方式
- 支持 `实时模式` 与 `手动模式`
- 支持录屏自动转 GIF，并导入到 Figma
- 支持在插件内直接导出 GIF
- 支持插件内检查更新与一键更新
- 支持 Apple Silicon 与 Intel 两种 macOS 架构安装包
- 安装器会在安装阶段提前处理 `node`、`ffmpeg`、`gifsicle`、`ImageMagick` 的权限预热与验证

## 适用环境

- macOS 11 及以上
- Figma Desktop
- 至少 2GB 可用磁盘空间
- 使用 `iCloud` 模式时，需要已开启 iCloud Drive

更推荐：

- macOS 14 或以上
- 直接使用图形化安装器

不支持：

- macOS 10.15 及以下图形化安装
- 如需兼容旧系统，请参考 `MANUAL_INSTALL_LEGACY.md`

## 用户安装

### 方式 1：使用发布包安装

1. 从 GitHub Releases 下载与你芯片对应的安装包。
2. 解压后打开 `installer`。
3. 运行 `ScreenSync Installer`。
4. 按安装器步骤完成：
   - 确认安装包
   - 准备运行环境
   - 设置本地工作区
   - 完成系统授权
   - 启动 ScreenSync

如果 macOS 在安装阶段提示“仍要打开”，按安装器引导前往：

`系统设置 -> 隐私与安全性 -> 安全性`

点击对应项目后的“仍要打开”即可。

### 方式 2：紧急修复更新

如果用户当前版本过旧，或自动更新失败，可在项目根目录运行：

```bash
chmod +x emergency-update.sh
./emergency-update.sh
```

`emergency-update.sh` 会根据当前机器架构拉取正确的最新发布包，并补齐核心文件与离线运行时。

## Figma 插件接入

1. 打开 Figma Desktop
2. 进入 `Plugins -> Development -> Import plugin from manifest`
3. 选择 `figma-plugin/manifest.json`
4. 运行 `ScreenSync`

## 日常使用

### 1. 选择储存方式

- `Google Drive`：无需 iCloud，适合常规同步
- `iCloud`：适合 Apple 生态设备协同

### 2. 选择同步模式

- `实时模式`：手机内容进入云端后自动同步到 Figma
- `手动模式`：按需拉取并批量处理历史文件

### 3. GIF 处理

- 自动同步中的视频素材会自动走共享 GIF 管线
- 插件内 GIF 导出与自动同步已使用一致的处理逻辑
- 在保持原视频内容表现稳定的前提下，优先追求更小体积和更可控耗时

## 更新机制

- 插件会定期检查新版本
- 顶部 `update-banner` 可直接触发完整更新
- 更新流程会完成版本比对、资源下载、文件替换、依赖补齐和服务重启
- 如果更新后的新运行时工具仍被 macOS 拦截，插件会在更新完成后弹出引导弹窗，提示前往 `系统设置 -> 隐私与安全性 -> 安全性` 完成“仍要打开”

## 本地开发

### 启动主服务

```bash
npm start
```

### 常用命令

```bash
npm start
npm run server
npm run watch
npm run drive-watch
```

### 安装器开发

```bash
cd installer
npm install
npm start
```

## 仓库结构

- `figma-plugin/`: Figma 插件 UI 与插件逻辑
- `installer/`: 图形化安装器
- `start.js`: 主启动入口
- `server.js`: 本地服务与 WebSocket 通信
- `drive-watcher.js`: Google Drive 监听
- `icloud-watcher.js`: iCloud 监听
- `gif-composer.js`: 插件导出 GIF 相关逻辑
- `video-gif-pipeline.js`: 自动同步与导出的共享 GIF 处理管线
- `update-handlers.js`: 更新检查、下载、替换与重启
- `release.sh`: 发布脚本
- `emergency-update.sh`: 老版本/异常版本的应急更新脚本

## 发布说明

发布使用仓库根目录的 `release.sh`：

```bash
./release.sh
```

当前发布规则：

- 版本号从 `1.0.0` 开始按序管理
- 覆盖同一版本时，不再二次确认，脚本会直接删除旧 Release 与 Tag 后重建
- 如果发布的是更低版本，脚本会自动删除 GitHub 上所有高于该版本的 Release 与对应 Tag
- 发布完成后，GitHub 默认展示的 README 就是当前仓库根目录这份 `README.md`

## 故障排查

### 安装器卡在权限验证

前往：

`系统设置 -> 隐私与安全性 -> 安全性`

点击所有与 ScreenSync 相关项目的“仍要打开”，再回到安装器重新检测。

### 插件显示已更新，但仍提示授权

说明新运行时工具仍被 Gatekeeper 拦截。按插件弹窗提示前往：

`系统设置 -> 隐私与安全性 -> 安全性`

完成“仍要打开”后重启插件。

### 自动更新失败

优先使用插件内更新；若当前版本过旧或更新中断，执行：

```bash
chmod +x emergency-update.sh
./emergency-update.sh
```

### 服务无法启动

先检查 Node 版本：

```bash
node -v
```

项目要求 `>= 18.17.0`。

### 依赖安装失败

```bash
rm -rf node_modules package-lock.json
npm install
```
