# ScreenSync 安装器：免终端依赖安装设计文档

## 背景与问题

ScreenSync 运行需要 5 个环境依赖：**Homebrew**、**Node.js**、**ImageMagick**、**FFmpeg**、**Gifsicle**。

旧方案通过 AppleScript 调用 `Terminal.app` 执行安装命令，存在以下卡点：

| 痛点 | 原因 |
|---|---|
| 用户被弹出到终端窗口 | AppleScript `tell application "Terminal" do script "..."` 会激活并聚焦终端 |
| 输入密码无回显 | 终端下 `sudo` 读取密码时关闭了 tty echo，用户以为卡死 |
| 安装进度不可见 | 终端里一堆滚动日志，用户无法判断当前状态 |
| 需要手动返回安装器 | 终端安装完后用户需自行切回安装器点"重新检测" |

**新方案的目标**：所有安装过程在安装器窗口内完成，用户全程只与安装器的 UI 交互。

---

## 系统版本分流

安装器启动时通过 Darwin 内核版本号判断 macOS 版本：

```javascript
const darwinVersion = parseInt(os.release().split('.')[0], 10);
const isLegacyMacOS = darwinVersion < 23; // Darwin 23 = macOS 14 (Sonoma)
```

- **macOS 14+** → Homebrew 模式（有预编译 bottle，秒级安装）
- **macOS 13 及以下** → 直接下载模式（Homebrew 在旧系统上需从源码编译，耗时 30 分钟以上甚至失败）

两条路径共享完全相同的前端 UI——渲染进程只监听 `dep-install-progress` 和 `dep-install-log` 两个 IPC 事件，对后端采用哪种安装方式无感知。

---

## 一、macOS 14+ 的 Homebrew 模式

### 1.1 为什么不需要打开终端

传统方式需要终端是因为：
- Homebrew 安装脚本需要 `sudo` 创建 `/opt/homebrew/` 目录
- `sudo` 在终端下读取密码（tty），Electron 的 `child_process` 默认没有 tty

**解决思路**：用 macOS 原生密码对话框替代终端密码输入，用 PTY 替代真实终端。

### 1.2 密码获取：osascript 原生对话框

```javascript
const dialogCmd = `osascript -e 'text returned of (display dialog "安装 Homebrew 需要管理员权限"
  & return & return & "请输入您的 Mac 登录密码："
  default answer "" with hidden answer
  with title "ScreenSync 安装器" with icon caution)'`;
```

`display dialog ... with hidden answer` 调用的是 macOS 系统级密码输入框：
- 输入字符显示为 **圆点**（不是无回显）
- 用户非常熟悉这个 UI（与安装 .pkg、修改系统偏好设置时一致）
- 点击"取消"返回错误码，安装器捕获后中止流程

### 1.3 sudo 认证：PTY + 凭证缓存

Homebrew 安装脚本内部会多次调用 `sudo`。macOS 的 `sudo` 有一个 `tty_tickets` 安全策略——凭证缓存与 TTY 绑定。普通 `child_process.spawn` 创建的是管道（pipe），不是 TTY，所以 `sudo -v` 缓存的凭证在后续调用中不可用。

**解决方案**：使用 macOS 自带的 `script` 工具创建伪终端（PTY）：

```javascript
spawn('script', ['-q', '/dev/null', '/bin/bash', '-c', brewScript], { ... });
```

`script -q /dev/null` 的作用：
- 创建一个真实的 PTY（伪终端设备，例如 `/dev/ttys042`）
- 在该 PTY 中执行传入的命令
- `-q` 抑制 "Script started/done" 提示
- `/dev/null` 丢弃录制文件（我们不需要 typescript 日志）

**认证流程**（全部在同一个 PTY 会话内）：

```
1. echo '$PASSWORD' | sudo -S -v     ← 通过 stdin 管道传入密码，-v 验证并缓存凭证
2. Homebrew install.sh               ← 内部调用 sudo 时发现当前 TTY 有有效凭证，自动通过
3. sudo -k                            ← 安装完成后立即清除凭证缓存
```

关键点：步骤 1 和步骤 2 在同一个 PTY 里运行，`tty_tickets` 策略认为它们是同一个终端会话，所以凭证可以复用。密码从不写入磁盘或日志。

### 1.4 brew install：纯进程内执行

Homebrew 安装完成后，后续的 `brew install node imagemagick ffmpeg gifsicle` 不需要 `sudo`（Homebrew 安装到用户可写目录），直接用 `child_process.spawn` 执行：

```javascript
spawn(brewPath, ['install', pkg], { env: process.env });
```

stdout/stderr 通过 IPC 事件流式传输到渲染进程，逐条显示在日志区。

### 1.5 进度汇报

每个依赖的安装过程通过两个 IPC 通道实时更新 UI：

```
主进程 (main.js)                          渲染进程 (renderer.js)
─────────────                              ─────────────────────
sendProgress('node', 'installing', ...)  → 更新状态列表第 2 项：🔄 spinner + "正在安装..."
sendLog('正在下载...\n')                  → 追加日志行到滚动容器
sendProgress('node', 'done', ...)        → 更新状态列表第 2 项：✅ "已安装"
```

全部安装完成后自动调用 `checkSystemRequirements()` 重新验证，无需用户手动操作。

---

## 二、macOS 13 及以下的直接下载模式（Legacy）

### 2.1 为什么不用 Homebrew

Homebrew 对 macOS 13 (Ventura) 及更低版本仅提供"有限支持"：
- 不再发布预编译 bottle（二进制包）
- `brew install` 退化为从源码编译，单个包耗时 10-30 分钟
- 编译过程可能因缺少依赖或系统 SDK 版本不匹配而失败

### 2.2 为什么不需要密码

Legacy 模式的全部安装目标是用户主目录下的 `~/.screensync/`：

```
~/.screensync/
├── bin/              ← 所有可执行文件的入口（符号链接或 wrapper 脚本）
│   ├── node          → ../deps/node/bin/node
│   ├── npm           → ../deps/node/bin/npm
│   ├── npx           → ../deps/node/bin/npx
│   ├── ffmpeg        (直接放置的静态二进制)
│   ├── ffprobe       (直接放置的静态二进制)
│   ├── magick        (wrapper 脚本，调用 app bundle 内的二进制)
│   ├── convert       (wrapper 脚本，调用 magick convert)
│   └── gifsicle      (编译后直接复制的二进制)
└── deps/             ← 完整的依赖安装目录
    ├── node/         (Node.js 官方发行包解压)
    │   ├── bin/
    │   ├── lib/
    │   └── ...
    └── imagemagick/  (ImageMagick app bundle 或编译产物)
        ├── ImageMagick.app/
        └── ...
```

`~/.screensync/` 是当前用户的主目录子文件夹，写入不需要 `sudo`。整个流程零特权提升。

### 2.3 各依赖的安装实现

#### Node.js — 官方预编译 tarball

**来源**：`https://nodejs.org/dist/v22.13.1/node-v22.13.1-darwin-{arm64|x64}.tar.gz`

Node.js 官方为每个版本提供 macOS 预编译包，覆盖 arm64（Apple Silicon）和 x64（Intel）两种架构。这是最可靠的安装方式。

**安装步骤**：
1. `curl -L` 下载 tarball 到临时目录
2. `tar xzf` 解压到 `~/.screensync/deps/`
3. 重命名解压目录为 `node/`
4. 在 `~/.screensync/bin/` 创建符号链接指向 `node`、`npm`、`npx`
5. 验证：执行 `node --version` 确认可用
6. 清理 tarball 临时文件

npm 不是独立二进制文件——它是一个 Node.js 脚本，依赖 `lib/node_modules/npm/` 目录结构。因此必须保留完整的 Node.js 发行包，不能只复制 `node` 二进制。符号链接确保 npm 能通过相对路径找到自己的模块目录。

#### FFmpeg + FFprobe — 静态二进制

**来源**：`https://evermeet.cx/ffmpeg/getrelease/zip`（FFmpeg）、`https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip`（FFprobe）

evermeet.cx 是 FFmpeg 官方推荐的 macOS 静态构建源，提供 Intel x64 单一架构的静态链接二进制。

**为什么只提供 Intel 版本也能工作**：macOS 11+ 内置 Rosetta 2 翻译层，Intel 二进制可以在 Apple Silicon 上透明运行。evermeet.cx 的维护者明确表示"Intel 二进制在 ARM 上运行无性能损失"。

**安装步骤**：
1. 分别下载 ffmpeg.zip 和 ffprobe.zip
2. `unzip` 直接解压到 `~/.screensync/bin/`（zip 内只包含单个二进制文件）
3. `chmod +x` 赋予执行权限
4. 验证：执行 `ffmpeg -version`

"静态链接"意味着所有依赖库（libx264、libx265、libvpx 等）都编译进了单个二进制文件，没有外部动态库依赖，可以在任何 macOS 版本上直接运行。

#### ImageMagick — 双重降级策略

ImageMagick 是最复杂的依赖，因为：
- 官方 GitHub Releases 只提供 Windows 可移植版本，没有 macOS 版
- macOS 上的 `magick` 二进制依赖大量动态库（libpng、libjpeg、libwebp 等），无法做真正的静态链接

**策略 1（首选）：mendelson.org 独立版**

mendelson.org 提供一个经过 Apple 公证（notarized）的通用二进制（Universal Binary，同时支持 Intel 和 ARM）App Bundle。

安装步骤：
1. 下载 `.dmg` 文件
2. `hdiutil attach` 挂载 DMG（无需 GUI 交互，纯命令行）
3. 遍历挂载点内容，找到 `*.app` 文件
4. `cp -R` 复制整个 App Bundle 到 `~/.screensync/deps/imagemagick/`
5. `hdiutil detach` 卸载 DMG
6. 在 `~/.screensync/bin/` 创建 **wrapper 脚本**（不是符号链接）

为什么用 wrapper 脚本而非符号链接：App Bundle 内的 `magick` 二进制通过 `@loader_path` 相对路径查找同 bundle 内的动态库。如果创建符号链接，`@loader_path` 会解析到符号链接所在的目录（`~/.screensync/bin/`），找不到库文件。Wrapper 脚本通过 `exec` 直接执行 bundle 内的原始路径，保证 `@loader_path` 正确解析：

```bash
#!/bin/bash
exec ~/.screensync/deps/imagemagick/ImageMagick.app/Contents/MacOS/magick "$@"
```

**策略 2（降级）：从源码编译**

如果 mendelson.org 不可达（网络问题、URL 变更等），检查系统是否安装了 Xcode Command Line Tools：

```javascript
await execPromise('xcode-select -p');  // 如果 CLT 未安装会抛出异常
```

如果有编译器：
1. 下载 ImageMagick 源码 tarball
2. `./configure --prefix=~/.screensync/deps/imagemagick --without-modules --disable-docs`
3. `make -j$(nproc)` 并行编译
4. `make install` 安装到指定前缀目录
5. 在 `~/.screensync/bin/` 创建符号链接

编译安装的 ImageMagick 需要额外的环境变量：
- `MAGICK_HOME`：指向安装前缀目录，用于查找 `policy.xml` 等配置文件
- `DYLD_LIBRARY_PATH`：指向 `lib/` 目录，用于查找编译产生的动态库

这些环境变量在 `server.js` 和 `start.js` 启动时自动注入。

#### Gifsicle — 源码编译（可选）

Gifsicle 是一个非常小的纯 C 项目（约 15 个 .c 文件），编译只需几秒钟。

**安装步骤**：
1. 检查 `cc` 编译器是否可用
2. 如果不可用，直接跳过（标记为"已跳过（可选组件）"）
3. 如果可用：下载源码 → `./configure` → `make` → 复制 `src/gifsicle` 到 `~/.screensync/bin/`

Gifsicle 是可选的，因为代码中所有使用 gifsicle 的地方都用 `try/catch` 包裹：

```javascript
try {
  await execAsync('which gifsicle');
  // ... 执行 gifsicle 优化
} catch (e) {
  // gifsicle 不可用，跳过优化步骤，使用未优化的 GIF
}
```

没有 gifsicle，GIF 导出仍然正常工作，只是文件体积会大 20-40%。

---

## 三、路径重定位

### 3.1 问题

Homebrew 安装的二进制位于 `/opt/homebrew/bin/`（ARM）或 `/usr/local/bin/`（Intel）。Legacy 模式的二进制在 `~/.screensync/bin/`。服务端代码（`server.js`、`gif-composer.js`）通过 `which ffmpeg`、`which gifsicle`、绝对路径遍历等方式查找二进制。如果不做路径注入，Legacy 安装的二进制将不可见。

### 3.2 注入点

路径注入在 **5 个位置** 实施，确保无论何种启动方式都能找到 Legacy 二进制：

| 文件 | 注入方式 | 作用 |
|---|---|---|
| `installer/main.js` → `findExecutable()` | 在搜索路径列表头部加入 `~/.screensync/bin/` | 安装器检测依赖时能发现 Legacy 安装的工具 |
| `installer/main.js` → LaunchAgent PATH | plist 模板的 `EnvironmentVariables.PATH` 加入两个本地路径 | 开机自启动时 `server.js` 进程能找到工具 |
| `gif-composer.js` → `searchPaths[]` | 数组首位插入 `~/.screensync/bin/` | GIF 合成引擎查找 `convert`/`magick` 时优先检查本地目录 |
| `server.js` 顶部 IIFE | 检查目录是否存在，存在则 prepend 到 `process.env.PATH` | 服务器进程调用 `ffmpeg`、`ffprobe` 时能通过 `which` 找到 |
| `start.js` 顶部 | 同上（`start.js` 是 `server.js` 的父进程，env 会继承） | 确保 `server.js` 继承正确的 PATH |

`gif-composer.js` 的搜索路径会自动同步到 PATH：

```javascript
const searchPaths = [
  path.join(os.homedir(), '.screensync', 'bin'),  // ← Legacy macOS 优先
  '/opt/homebrew/bin',   // Homebrew ARM
  '/usr/local/bin',      // Homebrew Intel
  '/opt/local/bin',      // MacPorts
  '/usr/bin',
  '/bin'
];

// 自动将存在的路径注入到 process.env.PATH
for (const searchPath of searchPaths) {
  if (fs.existsSync(searchPath) && !process.env.PATH.includes(searchPath)) {
    process.env.PATH = `${searchPath}:${process.env.PATH}`;
  }
}
```

这意味着 `which ffmpeg` 和 `which gifsicle` 也能正确解析到 Legacy 路径。

### 3.3 ImageMagick 特殊处理

从源码编译的 ImageMagick 还需要两个额外环境变量（DMG 独立版不需要，因为 App Bundle 内部自包含了所有资源）：

```javascript
// server.js 和 start.js 启动时
const imHome = path.join(os.homedir(), '.screensync', 'deps', 'imagemagick');
if (fs.existsSync(path.join(imHome, 'bin', 'magick')) && !process.env.MAGICK_HOME) {
  process.env.MAGICK_HOME = imHome;                    // 配置文件搜索路径
  process.env.DYLD_LIBRARY_PATH = imHome + '/lib';     // 动态库搜索路径
}
```

---

## 四、UI 统一性

两条安装路径对前端完全透明。渲染进程（`renderer.js`）的 `installMissingDependencies()` 函数只做三件事：

1. 监听 `dep-install-progress` → 更新 5 个状态项（Homebrew / Node.js / ImageMagick / FFmpeg / Gifsicle）的图标和文字
2. 监听 `dep-install-log` → 逐行追加到滚动日志容器
3. 收到最终结果后 → 自动调用 `checkSystemRequirements()` 重新检测

| macOS 14+ 用户看到的 | macOS 13- 用户看到的 |
|---|---|
| Homebrew: 🔄 等待输入密码... → (原生密码对话框) → 🔄 正在安装... → ✅ 安装完成 | Homebrew: ✅ 无需安装（直接下载模式） |
| Node.js: 🔄 正在安装... → ✅ 已安装 | Node.js: 🔄 正在下载... → ✅ 已安装 |
| ImageMagick: 🔄 正在安装... → ✅ 已安装 | ImageMagick: 🔄 正在安装... → ✅ 已安装 |
| FFmpeg: 🔄 正在安装... → ✅ 已安装 | FFmpeg: 🔄 正在下载... → ✅ 已安装 |
| Gifsicle: 🔄 正在安装... → ✅ 已安装 | Gifsicle: 🔄 正在编译... → ✅ 已安装（或"已跳过"） |

底部日志区实时滚动显示 curl 下载进度、brew 输出、编译日志等。安装完成后日志区自动隐藏，页面恢复为依赖检测结果。

---

## 五、安全性

| 关注点 | 处理方式 |
|---|---|
| 密码存储 | 密码仅在 Homebrew 模式使用，存在 JS 变量中，仅传入 bash 脚本的 stdin 管道，不写入磁盘或日志。安装完成后变量随函数作用域销毁。 |
| sudo 凭证 | 安装完成后立即执行 `sudo -k` 清除凭证缓存。 |
| Legacy 无 sudo | 全部写入 `~/.screensync/`（用户目录），不涉及系统目录，无特权提升。 |
| 二进制来源 | Node.js 来自 nodejs.org 官方；FFmpeg 来自 evermeet.cx（FFmpeg 官方推荐源）；ImageMagick 来自 Apple 公证的发行版或官方源码。 |
| DMG 挂载 | 使用 `-readonly` 标志挂载，安装完成后立即 `detach`。 |
