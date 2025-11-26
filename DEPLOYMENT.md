# ScreenSync 部署指南

## 🚀 快速部署

### 最常用命令（99% 的情况）

```bash
./release.sh
```

就这一个命令！用户会在 1 小时内自动收到更新。

### 脚本依赖关系

```
release.sh（一键发布脚本）
    │
    ├─ 调用 package-for-update.sh
    │     └─ 打包插件 → figma-plugin-v1.0.1.zip
    │
    └─ 调用 package-for-distribution.sh
          └─ 打包服务器 → ScreenSync-UserPackage.tar.gz
```

**重要**：不要删除 `package-for-update.sh` 和 `package-for-distribution.sh`，它们是 `release.sh` 的核心依赖！

---

## 📁 文件修改对照表

### ✅ 只需运行 `./release.sh` 的文件

| 文件/目录 | 说明 | 更新方式 |
|----------|------|---------|
| `figma-plugin/ui.html` | 插件界面 | 用户自动更新 |
| `figma-plugin/code.js` | 插件逻辑 | 用户自动更新 |
| `figma-plugin/manifest.json` | 插件配置 | 用户自动更新 |
| `server.js` 的 WebSocket 部分 | 实时通信（1-1300 行） | 用户自动更新 |
| `server.js` 的更新检测部分 | 自动更新逻辑（2200+ 行） | 用户自动更新 |
| `drive-watcher.js` | Google Drive 监听 | 用户自动更新 |
| `icloud-watcher.js` | iCloud 监听 | 用户自动更新 |
| `aliyun-watcher.js` | 阿里云监听 | 用户自动更新 |
| `googleDrive.js` | Google Drive API | 用户自动更新 |
| `aliyunOSS.js` | 阿里云 OSS API | 用户自动更新 |
| `userConfig.js` | 用户配置管理 | 用户自动更新 |
| `update-manager.js` | 更新管理器 | 用户自动更新 |
| `start.js` | 服务器启动脚本 | 用户自动更新 |
| `package.json` | 依赖配置 | 用户自动更新 |
| `installer/*` | GUI 安装器 | 用户自动更新 |
| `com.screensync.server.plist` | LaunchAgent 配置 | 用户自动更新 |

**部署命令**：
```bash
./release.sh
```

---

### ⚠️ 需要运行 `./release.sh` + `./deploy-cloud-run.sh` 的文件

| 文件 | 具体位置 | 说明 |
|-----|---------|------|
| `server.js` | 第 1259-1343 行 | `app.post('/upload-oss')` |
| `server.js` | 第 1348-1468 行 | `app.post('/upload')` |
| `server.js` | 第 1473-1550 行 | `app.post('/upload-url')` |
| `Dockerfile` | 全部 | Docker 镜像配置 |

**部署命令**：
```bash
# 步骤 1：发布到 GitHub（用户端更新）
./release.sh

# 步骤 2：部署到 Cloud Run（云端更新）
./deploy-cloud-run.sh
```

---

## 🎯 快速判断

### 方法 1：看文件名

```
修改了这些文件？只需 ./release.sh
├─ figma-plugin/ 下的任何文件
├─ *-watcher.js
├─ googleDrive.js
├─ aliyunOSS.js
├─ userConfig.js
├─ update-manager.js
├─ start.js
├─ installer/ 下的任何文件
└─ package.json

修改了这些？需要 ./release.sh + ./deploy-cloud-run.sh
├─ server.js 的 app.post('/upload*') 部分
└─ Dockerfile
```

### 方法 2：看代码行号

如果你修改的是 `server.js`，检查行号：

```bash
# 查看你修改的具体位置
git diff server.js

# 如果行号在以下范围内，需要部署 Cloud Run：
# - 1259-1343 行 (upload-oss)
# - 1348-1468 行 (upload)
# - 1473-1550 行 (upload-url)
```

### 方法 3：不确定时

**先只运行 `./release.sh`，观察用户反馈。**

如果用户反馈 iPhone 快捷指令上传失败，再运行 `./deploy-cloud-run.sh`。

---

## 📋 完整部署流程

### 第 0 步：首次发布前准备（仅首次需要）

**如果这是你第一次发布，需要先构建 GUI 安装器**：

```bash
cd installer
npm install
npm run build
cd ..
```

构建成功后会生成：
- `installer/dist/mac-arm64/ScreenSync Installer.app`（Apple Silicon）
- 或 `installer/dist/mac/ScreenSync Installer.app`（Intel）

**之后的每次发布都不需要重新构建，除非你修改了 installer 代码。**

### 第 1 步：更新版本号和代码

```bash
# 1. 修改代码
vim figma-plugin/ui.html
vim server.js

# 2. 本地测试
npm start
# 在 Figma 中测试插件功能
```

### 第 2 步：发布到 GitHub

```bash
./release.sh
```

按提示输入：
- **新版本号**（如 `1.0.1`）
  - Bug 修复：`1.0.0` → `1.0.1`
  - 新增功能：`1.0.1` → `1.1.0`
  - 重大更新：`1.1.0` → `2.0.0`
- **更新说明**（如 "修复 GIF 导入问题"）

脚本会自动：
1. ✅ 更新 `figma-plugin/code.js` 版本号
2. ✅ 更新 `VERSION.txt` 版本号
3. ✅ 打包插件（`figma-plugin-v1.0.1.zip`）
4. ✅ 打包服务器（`ScreenSync-UserPackage.tar.gz`）
5. ✅ 提交代码到 GitHub
6. ✅ 创建 Git Tag（`v1.0.1`）
7. ✅ 发布到 GitHub Releases

### 第 3 步：（可选）部署 Cloud Run

**仅当修改了 HTTP 上传端点时**：

```bash
./deploy-cloud-run.sh
```

等待 5-10 分钟完成部署。

---

## ⏱ 用户收到更新的时间

```
你运行 ./release.sh
    ↓
    立即：Release 发布到 GitHub
    ↓
    0-60 分钟：用户插件自动检测到更新
    ↓
    用户点击「立即更新」
    ↓
    2-5 分钟：自动下载安装
    ↓
    ✅ 更新完成
```

**最快**：用户重启插件，立即检测到（0 分钟）
**最慢**：插件一直开着，最多 1 小时后检测到

---

## 🔍 验证部署成功

### 检查 GitHub Release

```bash
# 方法 1：命令行查看
gh release view latest

# 方法 2：网页查看
# https://github.com/BorderWalker99/figma-plugin-figma_sync/releases
```

确认：
- ✅ Tag 格式正确（`v1.0.1`，必须有 `v`）
- ✅ 标记为 latest release
- ✅ 包含 2 个文件：
  - `figma-plugin-v1.0.1.zip`
  - `ScreenSync-UserPackage.tar.gz`

### 检查 Cloud Run（如果部署了）

```bash
# 查看服务状态
gcloud run services describe figmasync-test --region asia-east2

# 查看服务 URL
gcloud run services describe figmasync-test --region asia-east2 --format 'value(status.url)'

# 测试健康检查
curl https://your-service-url.run.app/health
```

---

## 🐛 常见问题

### 问题 0：首次发布时报错

**错误信息**：
```
❌ 错误：未找到 GUI 安装器
❌ 服务器打包失败
```

**原因**：
首次发布前需要先构建 GUI 安装器

**解决方法**：
```bash
# 步骤 1：构建 GUI 安装器（仅首次需要）
cd installer
npm install
npm run build
cd ..

# 步骤 2：验证构建成功
ls -la installer/dist/mac-arm64/
# 应该看到：ScreenSync Installer.app

# 步骤 3：现在可以正常发布了
./release.sh
```

### 问题 1：插件打包失败，找不到 zip 文件

**错误信息**：
```
❌ 插件打包失败：未找到 figma-plugin-v1.0.1.zip
```

**原因**：
- `package-for-update.sh` 无法从 `code.js` 读取版本号
- `code.js` 中的版本号格式不正确

**解决方法**：
1. 检查 `figma-plugin/code.js` 第 3 行：
```javascript
const PLUGIN_VERSION = '1.0.1';  // 确保格式正确
```

2. 确保版本号与 `VERSION.txt` 一致

3. 单独测试打包脚本：
```bash
./package-for-update.sh
# 应该生成：figma-plugin-v1.0.1.zip
```

### 问题 2：用户检测不到更新

**可能原因**：
- Release 未标记为 latest
- Tag 格式不正确（缺少 `v`）
- 文件命名错误

**解决方法**：
```bash
# 1. 检查 Release
gh release view latest

# 2. 重新发布
gh release delete v1.0.1 --yes
./release.sh
```

### 问题 3：更新下载失败

**可能原因**：
- 文件过大（>100MB）
- 网络问题
- GitHub API 限流

**解决方法**：
- 用户重试更新
- 检查文件大小，优化打包
- 等待一段时间后重试

### 问题 4：iPhone 快捷指令上传失败

**可能原因**：
- Cloud Run 服务未更新
- Cloud Run 服务宕机

**解决方法**：
```bash
# 部署到 Cloud Run
./deploy-cloud-run.sh

# 检查服务状态
gcloud run services list --region asia-east2
```

### 问题 5：版本号不一致

**可能原因**：
- 手动修改了版本号但不一致

**解决方法**：
确保以下位置版本号一致：
- `figma-plugin/code.js` 第 3 行
- `VERSION.txt` 第 2 行
- Git Tag

```bash
# 查看当前版本
grep "PLUGIN_VERSION" figma-plugin/code.js
grep "版本" VERSION.txt
git tag -l | tail -1
```

---

## 💡 最佳实践

### 1. 定期发布

- 每周或每两周发布一次
- 不要累积太多更改
- 紧急 Bug 可立即发布

### 2. 清晰的更新说明

```markdown
## 新增功能
- 添加 iCloud 空间检测

## Bug 修复
- 修复 GIF 导入失败问题

## 性能优化
- 优化图片处理速度
```

### 3. 测试后再发布

```bash
# 1. 本地测试
npm start

# 2. Figma 中测试所有功能
# 3. 确认无误后发布
./release.sh
```

### 4. 版本号递增规则

| 修改类型 | 示例 | 说明 |
|---------|------|------|
| Bug 修复 | `1.0.0` → `1.0.1` | 修订号 +1 |
| 新增功能 | `1.0.1` → `1.1.0` | 次版本 +1，修订号归 0 |
| 重大更新 | `1.1.0` → `2.0.0` | 主版本 +1，其他归 0 |

---

## 🏗 架构说明（了解即可）

### 双服务器架构

```
┌────────────────────────────────────────────┐
│          本地服务器（用户电脑）              │
│                                            │
│  • WebSocket 实时通信                      │
│  • 文件监听                                │
│  • 图片处理                                │
│  • 自动更新                                │
│                                            │
│  运行方式：LaunchAgent 自动启动             │
│  更新方式：用户一键更新（自动）             │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│      Cloud Run 服务器（Google Cloud）       │
│                                            │
│  • HTTP 上传端点                           │
│  • iPhone 快捷指令上传                     │
│  • 无状态请求处理                          │
│                                            │
│  运行方式：Cloud Run 自动管理               │
│  更新方式：开发者手动部署                   │
└────────────────────────────────────────────┘
```

**为什么有两个服务器？**

1. **本地服务器**：处理需要持久连接的功能（WebSocket、文件监听）
2. **Cloud Run**：处理无状态的 HTTP 请求（iPhone 上传）

**99% 的代码在本地服务器，只有 HTTP 上传端点在 Cloud Run。**

---

## 📞 需要帮助？

### 快速检查清单

- [ ] 版本号是否一致？
- [ ] Release 是否发布成功？
- [ ] 文件是否都上传了？
- [ ] Tag 格式是否正确？
- [ ] 是否标记为 latest？

### 手动操作（不推荐）

如果 `release.sh` 失败，可以手动操作：

```bash
# 1. 更新版本号
vim figma-plugin/code.js  # 修改第 3 行
vim VERSION.txt            # 修改第 2 行

# 2. 打包
./package-for-update.sh
./package-for-distribution.sh

# 3. 提交代码
git add .
git commit -m "chore: release v1.0.1"
git push

# 4. 创建 Release
git tag v1.0.1
git push --tags
gh release create v1.0.1 \
  --title "v1.0.1" \
  --notes "更新说明" \
  --latest \
  figma-plugin-v1.0.1.zip \
  ScreenSync-UserPackage.tar.gz
```

---

## 🔧 脚本说明

项目包含以下部署脚本，**都必须保留**：

| 脚本文件 | 作用 | 何时使用 | 是否必需 |
|---------|------|---------|---------|
| `release.sh` | 一键发布（调用下面两个脚本） | 每次发布 | ✅ 必需 |
| `package-for-update.sh` | 打包插件 → `figma-plugin-v*.zip` | 被 release.sh 调用 | ✅ 必需 |
| `package-for-distribution.sh` | 打包服务器 → `ScreenSync-UserPackage.tar.gz` | 被 release.sh 调用 | ✅ 必需 |
| `deploy-cloud-run.sh` | 部署到 Google Cloud Run | 仅修改 HTTP 上传端点时 | ⚠️ 特殊情况 |

**依赖关系**：
```
release.sh
    ├─ package-for-update.sh（打包插件）
    └─ package-for-distribution.sh（打包服务器）

deploy-cloud-run.sh（独立使用）
```

**重要**：不要删除前三个脚本，否则 `release.sh` 无法正常工作！

---

## ✅ 总结

### 记住这三点

1. **99% 的情况**：只需运行 `./release.sh`
2. **修改文件**：看文件名判断是否需要 Cloud Run
3. **不确定时**：先只运行 `./release.sh`，观察反馈

### 核心命令

```bash
# 常规部署（99%）
./release.sh

# Cloud Run 部署（1%）
./release.sh && ./deploy-cloud-run.sh
```

### 必需的脚本文件

```bash
# 这三个脚本必须保留，不要删除！
release.sh                    # 主脚本
package-for-update.sh         # 依赖：打包插件
package-for-distribution.sh   # 依赖：打包服务器

# 这个脚本仅特殊情况使用
deploy-cloud-run.sh          # Cloud Run 部署
```

**就这么简单！** 🎉

