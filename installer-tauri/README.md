# ScreenSync Installer (Tauri)

Tauri 2.x 版安装器，替代 Electron 版。安装包体积从 ~150MB 缩小到 ~10MB。

## 前置条件

```bash
# 1. 安装 Rust (如果网络慢，使用镜像)
export RUSTUP_DIST_SERVER="https://mirrors.tuna.tsinghua.edu.cn/rustup"
export RUSTUP_UPDATE_ROOT="https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. 添加 Universal Binary 目标 (支持 Intel + Apple Silicon)
rustup target add x86_64-apple-darwin
rustup target add aarch64-apple-darwin

# 3. 安装 Tauri CLI
cargo install tauri-cli

# 4. (可选) 配置 Cargo 镜像加速
cat > ~/.cargo/config.toml << 'EOF'
[source.crates-io]
replace-with = 'tuna'

[source.tuna]
registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
EOF
```

## 开发

```bash
cd installer-tauri
cargo tauri dev
```

## 构建

```bash
# 构建当前架构
cargo tauri build

# 构建 Universal Binary (Intel + Apple Silicon 通用)
cargo tauri build --target universal-apple-darwin
```

产物位于 `src-tauri/target/release/bundle/dmg/`

## 项目结构

```
installer-tauri/
├── src/                    # 前端 (HTML/CSS/JS)
│   ├── index.html         # UI (从 Electron 版迁移，Liquid Glass 设计)
│   └── renderer.js        # 前端逻辑 (Tauri invoke/listen API)
├── src-tauri/
│   ├── Cargo.toml         # Rust 依赖
│   ├── tauri.conf.json    # Tauri 配置 (窗口、权限、构建)
│   └── src/
│       ├── main.rs        # 入口
│       └── commands.rs    # 18 个命令 (对应 Electron 的 18 个 IPC handler)
└── README.md
```

## 对比 Electron 版

| 项目 | Electron | Tauri |
|------|----------|-------|
| 安装包 | ~150MB | ~10MB |
| 系统调用 | Node.js child_process | Rust std::process::Command |
| sudo | SUDO_ASKPASS + script PTY (有 bug) | SUDO_ASKPASS 直接可用 |
| 最低系统 | macOS 10.13 | macOS 10.13 (WKWebView) |
| 进程流式输出 | Node.js Stream (竞态) | Rust BufReader (无竞态) |
