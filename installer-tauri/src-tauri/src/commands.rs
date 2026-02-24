use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

// ─── Shared Types ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct MacOSVersion {
    version: String,
    name: String,
    supported: serde_json::Value, // true | false | "limited"
}

#[derive(Serialize, Clone)]
pub struct CheckResult {
    installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skipped: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct InstallResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
}

#[derive(Deserialize)]
pub struct DependencyStatus {
    #[serde(default)]
    homebrew: bool,
    #[serde(default)]
    node: bool,
    #[serde(default)]
    imagemagick: bool,
    #[serde(default)]
    ffmpeg: bool,
    #[serde(default)]
    gifsicle: bool,
}

#[derive(Serialize, Clone)]
struct ProgressEvent {
    dep: String,
    status: String,
    message: String,
}

#[derive(Serialize, Clone)]
struct LogEvent {
    data: String,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn screensync_bin() -> PathBuf {
    home_dir().join(".screensync").join("bin")
}

fn screensync_deps() -> PathBuf {
    home_dir().join(".screensync").join("deps")
}

fn darwin_version() -> u32 {
    Command::new("uname")
        .arg("-r")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().split('.').next().map(|v| v.to_string()))
        .and_then(|v| v.parse().ok())
        .unwrap_or(23)
}

fn is_legacy_macos() -> bool {
    darwin_version() < 23
}

/// Runtime architecture detection (works correctly even when cross-compiled).
fn is_apple_silicon() -> bool {
    Command::new("uname")
        .arg("-m")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "arm64")
        .unwrap_or(false)
}

fn run_cmd(cmd: &str) -> Result<String, String> {
    let output = Command::new("/bin/bash")
        .args(["-c", cmd])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(stderr)
    }
}

fn run_cmd_ok(cmd: &str) -> bool {
    Command::new("/bin/bash")
        .args(["-c", cmd])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Find an executable by searching ScreenSync local dirs first, then common paths.
fn find_executable(name: &str) -> Option<String> {
    // 1. ScreenSync local install (highest priority — legacy macOS mode)
    let local = screensync_bin().join(name);
    if local.exists() {
        return Some(local.to_string_lossy().to_string());
    }

    // 2. Legacy Node.js deps (node/npm/npx)
    if name == "node" || name == "npm" || name == "npx" {
        let legacy = screensync_deps().join("node").join("bin").join(name);
        if legacy.exists() {
            return Some(legacy.to_string_lossy().to_string());
        }
    }

    // 3. Homebrew paths (Apple Silicon first, then Intel)
    for dir in &["/opt/homebrew/bin", "/usr/local/bin"] {
        let full = format!("{dir}/{name}");
        if Path::new(&full).exists() {
            return Some(full);
        }
    }

    // 4. NVM (for node only)
    if name == "node" {
        let nvm = home_dir().join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm) {
            let mut versions: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                let p = nvm.join(latest).join("bin").join(name);
                if p.exists() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
    }

    // 5. System-wide `which` (lowest priority)
    if let Ok(path) = run_cmd(&format!("which {name}")) {
        if !path.is_empty() && Path::new(&path).exists() {
            return Some(path);
        }
    }

    None
}

fn send_progress(app: &AppHandle, dep: &str, status: &str, message: &str) {
    let _ = app.emit(
        "dep-install-progress",
        ProgressEvent {
            dep: dep.to_string(),
            status: status.to_string(),
            message: message.to_string(),
        },
    );
}

fn send_log(app: &AppHandle, data: &str) {
    let _ = app.emit("dep-install-log", LogEvent { data: data.to_string() });
}

fn send_log_to_event(app: &AppHandle, event_name: &str, data: &str) {
    let _ = app.emit(event_name, LogEvent { data: data.to_string() });
}

/// Stream a shell command's stdout/stderr to the frontend log.
fn run_streamed(app: &AppHandle, cmd: &str, env_extra: &[(&str, &str)]) -> Result<i32, String> {
    run_streamed_to_event(app, cmd, env_extra, "dep-install-log")
}

/// Stream a shell command's stdout/stderr to a specified event channel.
fn run_streamed_to_event(
    app: &AppHandle,
    cmd: &str,
    env_extra: &[(&str, &str)],
    event_name: &'static str,
) -> Result<i32, String> {
    let mut child_cmd = Command::new("/bin/bash");
    child_cmd
        .args(["-c", cmd])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env_extra {
        child_cmd.env(k, v);
    }
    let mut child = child_cmd.spawn().map_err(|e| e.to_string())?;

    // Stream stdout
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        let event_name = event_name;
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if !line.trim().is_empty() {
                        send_log_to_event(&app_clone, event_name, &format!("{line}\n"));
                    }
                }
            }
        });
    }
    // Stream stderr
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let event_name = event_name;
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    if !line.trim().is_empty() {
                        send_log_to_event(&app_clone, event_name, &format!("{line}\n"));
                    }
                }
            }
        });
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(1))
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_macos_version() -> MacOSVersion {
    let dv = darwin_version();
    match dv {
        25 => MacOSVersion { version: "15".into(), name: "Sequoia".into(), supported: true.into() },
        24 => MacOSVersion { version: "15".into(), name: "Sequoia".into(), supported: true.into() },
        23 => MacOSVersion { version: "14".into(), name: "Sonoma".into(), supported: true.into() },
        22 => MacOSVersion { version: "13".into(), name: "Ventura".into(), supported: "limited".into() },
        21 => MacOSVersion { version: "12".into(), name: "Monterey".into(), supported: "limited".into() },
        20 => MacOSVersion { version: "11".into(), name: "Big Sur".into(), supported: "limited".into() },
        19 => MacOSVersion { version: "10.15".into(), name: "Catalina".into(), supported: false.into() },
        18 => MacOSVersion { version: "10.14".into(), name: "Mojave".into(), supported: false.into() },
        17 => MacOSVersion { version: "10.13".into(), name: "High Sierra".into(), supported: false.into() },
        _ => MacOSVersion { version: "Unknown".into(), name: "Unknown".into(), supported: false.into() },
    }
}

#[tauri::command]
pub fn get_project_root() -> Option<String> {
    let exe = env::current_exe().ok()?;

    // Walk up from .app/Contents/MacOS/screensync-installer to find the .app bundle
    let mut app_dir = exe.to_path_buf();
    loop {
        if app_dir.extension().and_then(|e| e.to_str()) == Some("app") {
            break;
        }
        app_dir = app_dir.parent()?.to_path_buf();
        if app_dir == Path::new("/") {
            return None;
        }
    }
    // app_dir is now e.g. /Volumes/ScreenSync Installer/ScreenSync Installer.app
    // or /Users/.../ScreenSync-Apple/ScreenSync Installer.app
    let parent = app_dir.parent()?;

    // Helper: when we find the project root, strip quarantine so all files work.
    let found = |p: String| -> Option<String> {
        strip_quarantine(&p);
        Some(p)
    };

    // Strategy 1: Check for "项目文件/package.json" in sibling (current distribution structure)
    let project_files = parent.join("项目文件");
    if project_files.join("package.json").exists() {
        return found(project_files.to_string_lossy().to_string());
    }

    // Strategy 2: Check if parent itself has package.json (legacy flat structure)
    if parent.join("package.json").exists() {
        return found(parent.to_string_lossy().to_string());
    }

    // Strategy 3: Running from mounted DMG — find the DMG source path
    // and look for 项目文件/ next to the DMG file on disk
    let parent_str = parent.to_string_lossy();
    if parent_str.starts_with("/Volumes/") {
        if let Some(dmg_dir) = find_dmg_source_dir(&parent_str) {
            let project_from_dmg = Path::new(&dmg_dir).join("项目文件");
            if project_from_dmg.join("package.json").exists() {
                return found(project_from_dmg.to_string_lossy().to_string());
            }
            if Path::new(&dmg_dir).join("package.json").exists() {
                return found(dmg_dir);
            }
        }
    }

    // Strategy 4: Walk up and check each level for 项目文件/ or package.json
    let mut search = parent.to_path_buf();
    for _ in 0..3 {
        search = search.parent()?.to_path_buf();
        let pf = search.join("项目文件");
        if pf.join("package.json").exists() {
            return found(pf.to_string_lossy().to_string());
        }
        if search.join("package.json").exists() {
            return found(search.to_string_lossy().to_string());
        }
    }

    // Strategy 5: Scan common extraction locations (~/Downloads, ~/Desktop)
    let home = home_dir();
    for base in &["Downloads", "Desktop"] {
        let base_dir = home.join(base);
        if let Ok(entries) = fs::read_dir(&base_dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("ScreenSync") && entry.file_type().map_or(false, |t| t.is_dir()) {
                    let pf = entry.path().join("项目文件");
                    if pf.join("package.json").exists() {
                        return found(pf.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}

/// Strip macOS quarantine attributes from a directory tree.
/// This replaces the old "第一步_拖进终端回车运行.command" script,
/// allowing users to never touch Terminal at all.
fn strip_quarantine(dir: &str) {
    let _ = Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine", dir])
        .output();
}

/// Given a Volume mount point (e.g. "/Volumes/ScreenSync Installer"),
/// use `hdiutil info` to find the original DMG file path on disk,
/// and return the directory containing that DMG.
fn find_dmg_source_dir(volume_path: &str) -> Option<String> {
    let output = Command::new("hdiutil")
        .args(["info"])
        .output()
        .ok()?;
    let info = String::from_utf8_lossy(&output.stdout);

    // hdiutil info outputs blocks per image. We need to match the block that
    // contains our volume mount point. Each block starts with "====" and has
    // "image-path" near the top and mount entries at the bottom.
    let mut image_path: Option<String> = None;

    for line in info.lines() {
        let trimmed = line.trim();
        // Reset on block boundary
        if trimmed.starts_with("====") {
            image_path = None;
            continue;
        }
        if trimmed.starts_with("image-path") {
            // Format: "image-path      : /path/to/file.dmg"
            // Split on first colon only to handle paths with colons
            if let Some(idx) = trimmed.find(':') {
                let p = trimmed[idx + 1..].trim();
                if !p.is_empty() {
                    image_path = Some(p.to_string());
                }
            }
        }
        // Check if this line contains our mount point
        if trimmed.contains(volume_path) {
            if let Some(ref dmg_path) = image_path {
                return Path::new(dmg_path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn select_project_root(app: AppHandle) -> Result<HashMap<String, serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    match folder {
        Some(fp) => {
            let p = fp.to_string();
            let selected = Path::new(&p);

            // Case 1: selected folder directly has package.json
            if selected.join("package.json").exists() {
                strip_quarantine(&p);
                let mut map = HashMap::new();
                map.insert("success".into(), true.into());
                map.insert("path".into(), p.into());
                return Ok(map);
            }

            // Case 2: selected the distribution root (ScreenSync-Apple/ etc.)
            // which contains 项目文件/package.json
            let project_files = selected.join("项目文件");
            if project_files.join("package.json").exists() {
                let resolved = project_files.to_string_lossy().to_string();
                strip_quarantine(&resolved);
                let mut map = HashMap::new();
                map.insert("success".into(), true.into());
                map.insert("path".into(), resolved.into());
                return Ok(map);
            }

            let mut map = HashMap::new();
            map.insert("success".into(), false.into());
            map.insert("error".into(), "选择的文件夹不正确。\n\n请选择解压后的 ScreenSync 安装包文件夹，或其中的「项目文件」文件夹。".into());
            Ok(map)
        }
        None => {
            let mut map = HashMap::new();
            map.insert("success".into(), false.into());
            map.insert("error".into(), "未选择文件夹".into());
            Ok(map)
        }
    }
}

#[tauri::command]
pub fn check_homebrew() -> CheckResult {
    if is_legacy_macos() {
        return CheckResult { installed: true, version: None, skipped: Some(true) };
    }
    if let Some(path) = find_executable("brew") {
        if run_cmd(&format!("\"{path}\" --version")).is_ok() {
            return CheckResult { installed: true, version: None, skipped: None };
        }
    }
    CheckResult { installed: false, version: None, skipped: None }
}

#[tauri::command]
pub fn check_node() -> CheckResult {
    if let Some(path) = find_executable("node") {
        if let Ok(ver) = run_cmd(&format!("\"{path}\" -v")) {
            return CheckResult { installed: true, version: Some(ver), skipped: None };
        }
    }
    CheckResult { installed: false, version: None, skipped: None }
}

#[tauri::command]
pub fn check_imagemagick() -> CheckResult {
    // Try `magick` first, then `convert`
    for name in &["magick", "convert"] {
        if let Some(path) = find_executable(name) {
            if let Ok(out) = run_cmd(&format!("\"{path}\" -version")) {
                if out.contains("ImageMagick") {
                    let ver = out
                        .lines()
                        .find(|l| l.contains("Version:"))
                        .and_then(|l| l.split_whitespace().nth(2))
                        .map(|s| s.to_string());
                    return CheckResult { installed: true, version: ver, skipped: None };
                }
            }
        }
    }
    CheckResult { installed: false, version: None, skipped: None }
}

#[tauri::command]
pub fn check_ffmpeg() -> CheckResult {
    if let Some(path) = find_executable("ffmpeg") {
        if let Ok(out) = run_cmd(&format!("\"{path}\" -version")) {
            if out.contains("ffmpeg version") {
                let ver = out.lines().next()
                    .and_then(|l| l.split_whitespace().nth(2))
                    .map(|s| s.to_string());
                return CheckResult { installed: true, version: ver, skipped: None };
            }
        }
    }
    CheckResult { installed: false, version: None, skipped: None }
}

#[tauri::command]
pub fn check_gifsicle() -> CheckResult {
    if let Some(path) = find_executable("gifsicle") {
        if let Ok(out) = run_cmd(&format!("\"{path}\" --version")) {
            if out.contains("Gifsicle") {
                let ver = out.lines().next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .map(|s| s.to_string());
                return CheckResult { installed: true, version: ver, skipped: None };
            }
        }
    }
    CheckResult { installed: false, version: None, skipped: None }
}

#[tauri::command]
pub fn check_icloud_space() -> HashMap<String, serde_json::Value> {
    let icloud = home_dir()
        .join("Library/Mobile Documents/com~apple~CloudDocs");
    let mut map = HashMap::new();
    if !icloud.exists() {
        map.insert("available".into(), false.into());
        map.insert("error".into(), "iCloud Drive 未启用".into());
        return map;
    }
    // Check 500MB free
    if let Ok(out) = run_cmd(&format!("df -k \"{}\"", icloud.display())) {
        let available_kb: u64 = out.lines().nth(1)
            .and_then(|l| l.split_whitespace().nth(3))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        map.insert("available".into(), (available_kb > 500_000).into());
        map.insert("freeGB".into(), serde_json::json!(available_kb as f64 / 1_048_576.0));
    } else {
        map.insert("available".into(), true.into());
    }
    map
}

#[tauri::command]
pub fn enable_anywhere() -> HashMap<String, bool> {
    let ok = run_cmd("osascript -e 'do shell script \"spctl --master-disable\" with administrator privileges'").is_ok();
    let mut map = HashMap::new();
    map.insert("success".into(), ok);
    map
}

// ─── Dependency Installation ─────────────────────────────────────────────────

const LEGACY_NODE_VERSION: &str = "22.13.1";

fn install_legacy_node(app: &AppHandle) -> Result<(), String> {
    send_progress(app, "node", "installing", "正在下载 Node.js...");
    send_log(app, "\n📦 正在安装 Node.js...\n");

    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let url = format!("https://nodejs.org/dist/v{LEGACY_NODE_VERSION}/node-v{LEGACY_NODE_VERSION}-darwin-{arch}.tar.gz");
    let deps = screensync_deps();
    let bin = screensync_bin();
    fs::create_dir_all(&deps).map_err(|e| e.to_string())?;
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;

    let tar_path = env::temp_dir().join(format!("screensync_node_{}.tar.gz", std::process::id()));

    // Download
    send_log(app, &format!("   下载: {url}\n"));
    let code = run_streamed(app, &format!(
        "curl -L -o \"{}\" --progress-bar -f --connect-timeout 30 \"{url}\"",
        tar_path.display()
    ), &[])?;
    if code != 0 { return Err("Node.js 下载失败".into()); }

    // Extract
    send_log(app, "   正在解压...\n");
    run_cmd(&format!("tar xzf \"{}\" -C \"{}\"", tar_path.display(), deps.display()))
        .map_err(|_| "解压失败")?;

    let extracted = deps.join(format!("node-v{LEGACY_NODE_VERSION}-darwin-{arch}"));
    let node_dir = deps.join("node");
    if node_dir.exists() { let _ = fs::remove_dir_all(&node_dir); }
    fs::rename(&extracted, &node_dir).map_err(|e| e.to_string())?;

    // Symlinks
    for name in &["node", "npm", "npx"] {
        let dest = bin.join(name);
        let _ = fs::remove_file(&dest);
        std::os::unix::fs::symlink(node_dir.join("bin").join(name), &dest)
            .map_err(|e| e.to_string())?;
    }

    let ver = run_cmd(&format!("\"{}\" --version", bin.join("node").display()))
        .unwrap_or_default();
    send_log(app, &format!("   ✅ Node.js {ver}\n"));
    send_progress(app, "node", "done", "安装完成");

    let _ = fs::remove_file(&tar_path);
    Ok(())
}

fn install_legacy_ffmpeg(app: &AppHandle) -> Result<(), String> {
    send_progress(app, "ffmpeg", "installing", "正在下载 FFmpeg...");
    send_log(app, "\n📦 正在安装 FFmpeg...\n");

    let bin = screensync_bin();
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let tmp = env::temp_dir().join(format!("screensync_ffmpeg_{}", std::process::id()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };

    let downloads: Vec<(&str, String, String, &str)> = vec![
        ("FFmpeg",
         format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch}/release/ffmpeg.zip"),
         "https://evermeet.cx/ffmpeg/getrelease/zip".to_string(),
         "ffmpeg.zip"),
        ("FFprobe",
         format!("https://ffmpeg.martin-riedl.de/redirect/latest/macos/{arch}/release/ffprobe.zip"),
         "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip".to_string(),
         "ffprobe.zip"),
    ];
    for (label, primary, fallback, zip_name) in &downloads {
        let dest = tmp.join(zip_name);
        let ok = run_streamed(app, &format!(
            "curl -L -o \"{}\" --progress-bar -f --connect-timeout 15 \"{}\"",
            dest.display(), primary
        ), &[]).unwrap_or(1);
        if ok != 0 {
            send_log(app, &format!("   ⚠️ {} 主下载源失败，尝试备用源...\n", label));
            let ok2 = run_streamed(app, &format!(
                "curl -L -o \"{}\" --progress-bar -f --connect-timeout 30 \"{}\"",
                dest.display(), fallback
            ), &[]).unwrap_or(1);
            if ok2 != 0 { return Err(format!("{} 下载失败", label)); }
        }
    }

    send_log(app, "   正在解压...\n");
    run_cmd(&format!("unzip -o \"{}\" -d \"{}\"", tmp.join("ffmpeg.zip").display(), bin.display()))
        .map_err(|_| "ffmpeg 解压失败")?;
    run_cmd(&format!("unzip -o \"{}\" -d \"{}\"", tmp.join("ffprobe.zip").display(), bin.display()))
        .map_err(|_| "ffprobe 解压失败")?;
    run_cmd(&format!("chmod +x \"{}\" \"{}\"",
        bin.join("ffmpeg").display(), bin.join("ffprobe").display()))?;

    let ver = run_cmd(&format!("\"{}\" -version", bin.join("ffmpeg").display()))
        .unwrap_or_default();
    let first_line = ver.lines().next().unwrap_or("");
    send_log(app, &format!("   ✅ {first_line}\n"));
    send_progress(app, "ffmpeg", "done", "安装完成");

    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}

fn install_legacy_imagemagick(app: &AppHandle) -> Result<(), String> {
    send_progress(app, "imagemagick", "installing", "正在安装 ImageMagick...");
    send_log(app, "\n📦 正在安装 ImageMagick...\n");

    let bin = screensync_bin();
    let im_dir = screensync_deps().join("imagemagick");
    let tmp = env::temp_dir().join(format!("screensync_im_{}", std::process::id()));
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let mut installed = false;

    // Strategy 1: DMG from mendelson.org
    send_log(app, "   尝试下载 ImageMagick macOS 独立版...\n");
    let dmg_path = tmp.join("ImageMagick.dmg");
    let mount_point = tmp.join("im_mount");
    fs::create_dir_all(&mount_point).ok();

    if run_streamed(app, &format!(
        "curl -L -o \"{}\" --progress-bar -f --connect-timeout 30 \"https://mendelson.org/imagemagick.dmg\"",
        dmg_path.display()
    ), &[]).unwrap_or(1) == 0 {
        send_log(app, "   正在挂载 DMG...\n");
        if run_cmd(&format!("hdiutil attach \"{}\" -nobrowse -readonly -mountpoint \"{}\"",
            dmg_path.display(), mount_point.display())).is_ok()
        {
            if let Ok(entries) = fs::read_dir(&mount_point) {
                let app_name = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .find(|n| n.ends_with(".app") && n.to_lowercase().contains("magick"));

                if let Some(app_name) = app_name {
                    if im_dir.exists() { let _ = fs::remove_dir_all(&im_dir); }
                    fs::create_dir_all(&im_dir).ok();
                    let app_dest = im_dir.join(&app_name);
                    if run_cmd(&format!("cp -R \"{}\" \"{}\"",
                        mount_point.join(&app_name).display(), app_dest.display())).is_ok()
                    {
                        let magick_bin = app_dest.join("Contents/MacOS/magick");
                        if magick_bin.exists() {
                            for (cmd, extra) in [("magick", ""), ("convert", "convert")] {
                                let wrapper = bin.join(cmd);
                                let content = format!(
                                    "#!/bin/bash\nexec \"{}\" {extra} \"$@\"\n",
                                    magick_bin.display()
                                );
                                fs::write(&wrapper, content).ok();
                                run_cmd(&format!("chmod +x \"{}\"", wrapper.display())).ok();
                            }
                            installed = true;
                        }
                    }
                }
            }
            let _ = run_cmd(&format!("hdiutil detach \"{}\" -force", mount_point.display()));
        }
    }

    // Strategy 2: Compile from source
    if !installed {
        send_log(app, "   尝试从源码编译 ImageMagick...\n");
        if run_cmd("xcode-select -p").is_ok() {
            send_progress(app, "imagemagick", "installing", "正在编译 ImageMagick（需要几分钟）...");
            let src = tmp.join("src");
            fs::create_dir_all(&src).ok();
            if im_dir.exists() { let _ = fs::remove_dir_all(&im_dir); }
            fs::create_dir_all(&im_dir).ok();

            let ncpu = num_cpus();
            let compile_script = format!(
                "curl -L 'https://imagemagick.org/archive/ImageMagick.tar.gz' | tar xz -C '{}' --strip-components=1 && \
                 cd '{}' && ./configure --prefix='{}' --disable-docs --without-modules --without-perl --disable-openmp --with-quantum-depth=16 CFLAGS='-O2' 2>&1 && \
                 make -j{ncpu} 2>&1 && make install 2>&1",
                src.display(), src.display(), im_dir.display()
            );
            if run_streamed(app, &compile_script, &[]).unwrap_or(1) == 0 {
                let compiled = im_dir.join("bin/magick");
                if compiled.exists() {
                    for cmd in &["magick", "convert"] {
                        let dest = bin.join(cmd);
                        let _ = fs::remove_file(&dest);
                        std::os::unix::fs::symlink(&compiled, &dest).ok();
                    }
                    installed = true;
                }
            }
        } else {
            send_log(app, "   ⚠️ 未安装 Xcode Command Line Tools，跳过编译\n");
        }
    }

    let _ = fs::remove_dir_all(&tmp);

    if installed {
        let ver = run_cmd(&format!("\"{}\" --version", bin.join("magick").display()))
            .unwrap_or_default();
        let first_line = ver.lines().next().unwrap_or("ImageMagick 已安装");
        send_log(app, &format!("   ✅ {first_line}\n"));
        send_progress(app, "imagemagick", "done", "安装完成");
        Ok(())
    } else {
        send_progress(app, "imagemagick", "error", "安装失败（可手动安装）");
        Err("ImageMagick 安装失败".into())
    }
}

fn install_legacy_gifsicle(app: &AppHandle) -> Result<(), String> {
    send_progress(app, "gifsicle", "installing", "正在安装 Gifsicle...");
    send_log(app, "\n📦 正在安装 Gifsicle...\n");

    let bin = screensync_bin();
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;

    if !run_cmd_ok("cc --version") {
        send_log(app, "   ⚠️ 未找到 C 编译器，跳过 Gifsicle（不影响基本功能）\n");
        send_progress(app, "gifsicle", "done", "已跳过（可选组件）");
        return Ok(());
    }

    let tmp = env::temp_dir().join(format!("screensync_gifsicle_{}", std::process::id()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let ncpu = num_cpus();
    let script = format!(
        "curl -L 'https://www.lcdf.org/gifsicle/gifsicle-1.96.tar.gz' | tar xz -C '{}' --strip-components=1 && \
         cd '{}' && ./configure --disable-gifview 2>&1 && make -j{ncpu} 2>&1",
        tmp.display(), tmp.display()
    );

    if run_streamed(app, &script, &[]).unwrap_or(1) == 0 {
        let src_bin = tmp.join("src/gifsicle");
        if src_bin.exists() {
            let dest = bin.join("gifsicle");
            let _ = fs::remove_file(&dest);
            fs::copy(&src_bin, &dest).map_err(|e| e.to_string())?;
            run_cmd(&format!("chmod +x \"{}\"", dest.display())).ok();
            let ver = run_cmd(&format!("\"{}\" --version", dest.display())).unwrap_or_default();
            send_log(app, &format!("   ✅ {}\n", ver.lines().next().unwrap_or("")));
            send_progress(app, "gifsicle", "done", "安装完成");
        } else {
            send_log(app, "   ⚠️ Gifsicle 编译失败（不影响基本功能）\n");
            send_progress(app, "gifsicle", "done", "已跳过（可选组件）");
        }
    } else {
        send_log(app, "   ⚠️ Gifsicle 编译失败（不影响基本功能）\n");
        send_progress(app, "gifsicle", "done", "已跳过（可选组件）");
    }

    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}

fn install_homebrew(app: &AppHandle, password: &str) -> Result<(), String> {
    send_progress(app, "homebrew", "installing", "正在验证密码...");
    send_log(app, "📦 正在安装 Homebrew...\n");

    let escaped = password.replace('\'', "'\"'\"'");
    let askpass_dir = env::temp_dir().join(format!("screensync_askpass_{}", std::process::id()));
    fs::create_dir_all(&askpass_dir).map_err(|e| e.to_string())?;
    let askpass_path = askpass_dir.join("askpass.sh");
    fs::write(&askpass_path, format!("#!/bin/bash\necho '{escaped}'\n"))
        .map_err(|e| e.to_string())?;
    run_cmd(&format!("chmod 700 \"{}\"", askpass_path.display())).ok();

    // Validate password
    send_log(app, "   正在验证密码...\n");
    let askpass_str = askpass_path.to_string_lossy().to_string();
    let validate = Command::new("/usr/bin/sudo")
        .args(["-A", "-v"])
        .env("SUDO_ASKPASS", &askpass_str)
        .output();

    match validate {
        Ok(o) if o.status.success() => send_log(app, "   ✅ 密码验证成功\n"),
        _ => {
            let _ = fs::remove_dir_all(&askpass_dir);
            send_progress(app, "homebrew", "error", "密码错误");
            return Err("密码验证失败，请检查密码后重试".into());
        }
    }

    // Install Homebrew
    send_progress(app, "homebrew", "installing", "正在安装 Homebrew...");

    let brew_script = r#"
INSTALL_SCRIPT=$(curl -fsSL --connect-timeout 10 https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/install/raw/HEAD/install.sh 2>/dev/null)
if [ -z "$INSTALL_SCRIPT" ]; then
  echo "⚠️ 镜像源不可用，尝试 GitHub..."
  INSTALL_SCRIPT=$(curl -fsSL --connect-timeout 15 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)
fi
if [ -z "$INSTALL_SCRIPT" ]; then echo "❌ 无法下载 Homebrew 安装脚本"; exit 1; fi
/bin/bash -c "$INSTALL_SCRIPT"
BREW_EXIT=$?
/usr/bin/sudo -k 2>/dev/null || true
exit $BREW_EXIT
"#;

    let code = run_streamed(app, brew_script, &[
        ("NONINTERACTIVE", "1"),
        ("CI", "1"),
        ("SUDO_ASKPASS", &askpass_str),
        ("HOMEBREW_BREW_GIT_REMOTE", "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git"),
        ("HOMEBREW_CORE_GIT_REMOTE", "https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git"),
        ("HOMEBREW_API_DOMAIN", "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"),
        ("HOMEBREW_BOTTLE_DOMAIN", "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"),
    ]).unwrap_or(1);

    let _ = fs::remove_dir_all(&askpass_dir);

    if code == 0 {
        send_progress(app, "homebrew", "done", "安装完成");
        send_log(app, "\n✅ Homebrew 安装完成\n");

        // Configure PATH for Apple Silicon
        if is_apple_silicon() {
            if Path::new("/opt/homebrew/bin/brew").exists() {
                let _ = run_cmd("echo 'eval \"$(/opt/homebrew/bin/brew shellenv)\"' >> ~/.zprofile");
            }
        }
        Ok(())
    } else {
        send_progress(app, "homebrew", "error", "安装失败");
        Err(format!("Homebrew 安装失败 (exit code: {code})"))
    }
}

fn install_brew_package(app: &AppHandle, pkg: &str, display_name: &str) -> Result<(), String> {
    send_progress(app, pkg, "installing", &format!("正在安装 {display_name}..."));
    send_log(app, &format!("\n📦 正在安装 {display_name}...\n"));

    let brew_path = find_executable("brew")
        .unwrap_or_else(|| {
            if is_apple_silicon() { "/opt/homebrew/bin/brew".into() }
            else { "/usr/local/bin/brew".into() }
        });

    let code = run_streamed(app, &format!("\"{}\" install {pkg}", brew_path), &[
        ("HOMEBREW_API_DOMAIN", "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"),
        ("HOMEBREW_BOTTLE_DOMAIN", "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"),
    ]).unwrap_or(1);

    if code == 0 {
        send_progress(app, pkg, "done", "安装完成");
        send_log(app, &format!("✅ {display_name} 安装完成\n"));
        Ok(())
    } else {
        send_progress(app, pkg, "error", "安装失败");
        Err(format!("{display_name} 安装失败"))
    }
}

#[tauri::command]
pub async fn install_all_dependencies(app: AppHandle, dependency_status: DependencyStatus) -> InstallResult {
    if is_legacy_macos() {
        return install_legacy_deps(&app, &dependency_status);
    }

    // Homebrew mode
    let needs_homebrew = !dependency_status.homebrew;
    let mut brew_packages = Vec::new();
    if !dependency_status.node { brew_packages.push(("node", "Node.js")); }
    if !dependency_status.imagemagick { brew_packages.push(("imagemagick", "ImageMagick")); }
    if !dependency_status.ffmpeg { brew_packages.push(("ffmpeg", "FFmpeg")); }
    if !dependency_status.gifsicle { brew_packages.push(("gifsicle", "Gifsicle")); }

    if !needs_homebrew && brew_packages.is_empty() {
        return InstallResult { success: true, message: Some("所有依赖已安装".into()), error: None, cancelled: None };
    }

    if needs_homebrew {
        send_progress(&app, "homebrew", "password", "等待输入密码...");

        // Native macOS password dialog via osascript
        let dialog_cmd = r#"osascript -e 'text returned of (display dialog "安装 Homebrew 需要管理员权限" & return & return & "请输入您的 Mac 登录密码：" default answer "" with hidden answer with title "ScreenSync 安装器" with icon caution)'"#;
        match run_cmd(dialog_cmd) {
            Ok(password) => {
                if let Err(e) = install_homebrew(&app, &password) {
                    return InstallResult { success: false, message: None, error: Some(e), cancelled: None };
                }
            }
            Err(_) => {
                send_progress(&app, "homebrew", "error", "已取消");
                return InstallResult { success: false, message: None, error: Some("已取消密码输入".into()), cancelled: Some(true) };
            }
        }
    }

    for (pkg, name) in &brew_packages {
        if let Err(e) = install_brew_package(&app, pkg, name) {
            return InstallResult { success: false, message: None, error: Some(e), cancelled: None };
        }
    }

    InstallResult { success: true, message: Some("所有依赖安装完成".into()), error: None, cancelled: None }
}

fn install_legacy_deps(app: &AppHandle, status: &DependencyStatus) -> InstallResult {
    if !status.homebrew {
        send_progress(app, "homebrew", "done", "无需安装（直接下载模式）");
    }

    let steps: Vec<(&str, Box<dyn Fn(&AppHandle) -> Result<(), String>>)> = vec![
        ("node", Box::new(|a| install_legacy_node(a))),
        ("ffmpeg", Box::new(|a| install_legacy_ffmpeg(a))),
        ("imagemagick", Box::new(|a| install_legacy_imagemagick(a))),
        ("gifsicle", Box::new(|a| install_legacy_gifsicle(a))),
    ];

    let skip = [status.node, status.ffmpeg, status.imagemagick, status.gifsicle];

    for (i, (_name, installer)) in steps.into_iter().enumerate() {
        if skip[i] { continue; }
        if let Err(e) = installer(app) {
            send_log(app, &format!("\n❌ {e}\n"));
            return InstallResult { success: false, message: None, error: Some(e), cancelled: None };
        }
    }

    // Inject PATH for current process
    inject_local_path();

    InstallResult { success: true, message: Some("所有依赖安装完成".into()), error: None, cancelled: None }
}

fn inject_local_path() {
    let paths = [
        screensync_bin().to_string_lossy().to_string(),
        screensync_deps().join("node/bin").to_string_lossy().to_string(),
    ];
    if let Ok(current) = env::var("PATH") {
        let mut parts: Vec<&str> = current.split(':').collect();
        for p in &paths {
            if Path::new(p).exists() && !parts.contains(&p.as_str()) {
                parts.insert(0, p);
            }
        }
        env::set_var("PATH", parts.join(":"));
    }
}

fn num_cpus() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

// ─── npm install ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn install_dependencies(app: AppHandle, install_path: String) -> InstallResult {
    inject_local_path();

    let install_dir = Path::new(&install_path);
    if !install_dir.join("package.json").exists() {
        return InstallResult {
            success: false, message: None,
            error: Some(format!("未找到 package.json: {install_path}")),
            cancelled: None,
        };
    }

    // Detect read-only directory early (common when user selected mounted DMG path).
    let write_probe = install_dir.join(".screensync_write_test");
    if std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&write_probe)
        .is_err()
    {
        let is_volume_path = install_path.starts_with("/Volumes/");
        let hint = if is_volume_path {
            "当前目录在只读 DMG 挂载盘中。请先解压 tar.gz 到本地目录，再从解压目录运行安装器。"
        } else {
            "当前目录不可写，请确认对项目目录有读写权限。"
        };
        return InstallResult {
            success: false,
            message: None,
            error: Some(format!("无法写入项目目录：{install_path}\n{hint}")),
            cancelled: None,
        };
    }
    let _ = fs::remove_file(&write_probe);

    let npm_path = find_executable("npm")
        .unwrap_or_else(|| {
            if is_apple_silicon() { "/opt/homebrew/bin/npm".into() }
            else { "/usr/local/bin/npm".into() }
        });

    let cmd_mirror = format!(
        "\"{}\" install --legacy-peer-deps --omit=dev --registry=https://registry.npmmirror.com --prefix \"{}\"",
        npm_path, install_path
    );
    let cmd_official = format!(
        "\"{}\" install --legacy-peer-deps --omit=dev --prefix \"{}\"",
        npm_path, install_path
    );

    let _ = app.emit("install-output", serde_json::json!({
        "type": "stdout",
        "data": format!("正在安装依赖包...\n项目目录: {install_path}\n使用 npm: {npm_path}\n")
    }));

    let code_mirror = run_streamed_to_event(&app, &cmd_mirror, &[], "install-output").unwrap_or(1);
    if code_mirror == 0 {
        return InstallResult {
            success: true,
            message: Some("依赖安装完成".into()),
            error: None,
            cancelled: None,
        };
    }

    let _ = app.emit("install-output", serde_json::json!({
        "type": "stderr",
        "data": format!("\n镜像源安装失败（退出码 {code_mirror}），正在切换官方源重试...\n")
    }));
    let code_official = run_streamed_to_event(&app, &cmd_official, &[], "install-output").unwrap_or(1);

    if code_official == 0 {
        InstallResult {
            success: true,
            message: Some("依赖安装完成".into()),
            error: None,
            cancelled: None,
        }
    } else {
        InstallResult {
            success: false,
            message: None,
            error: Some(format!(
                "npm install 失败（镜像源退出码 {code_mirror}，官方源退出码 {code_official}）。请查看上方日志定位具体错误。"
            )),
            cancelled: None,
        }
    }
}

// ─── Configuration ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn setup_config(install_path: String, sync_mode: String, local_folder: String) -> HashMap<String, serde_json::Value> {
    let mut result = HashMap::new();

    // Create local folder
    fs::create_dir_all(&local_folder).ok();

    // Generate userId
    let user_id = format!("user_{}", &uuid_simple()[..8]);

    // Write userConfig.js
    let config_path = Path::new(&install_path).join("userConfig.js");
    let config_content = format!(
        r#"module.exports = {{
  syncMode: '{sync_mode}',
  localFolder: '{local_folder}',
  userId: '{user_id}',
}};"#
    );
    match fs::write(&config_path, config_content) {
        Ok(_) => {
            result.insert("success".into(), true.into());
            result.insert("userId".into(), user_id.into());
        }
        Err(e) => {
            result.insert("success".into(), false.into());
            result.insert("error".into(), e.to_string().into());
        }
    }
    result
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{:x}{:x}", t.as_secs(), t.subsec_nanos())
}

// ─── Server Start ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn start_server(install_path: String) -> InstallResult {
    inject_local_path();

    // Check if already running
    if run_cmd_ok("lsof -i :8888 -sTCP:LISTEN") {
        return InstallResult { success: true, message: Some("服务器已在运行".into()), error: None, cancelled: None };
    }

    let node_path = find_executable("node")
        .unwrap_or_else(|| {
            if is_apple_silicon() { "/opt/homebrew/bin/node".into() }
            else { "/usr/local/bin/node".into() }
        });

    let start_script = Path::new(&install_path).join("start.js");
    if !start_script.exists() {
        return InstallResult { success: false, message: None, error: Some("未找到 start.js".into()), cancelled: None };
    }

    // Start detached
    let result = Command::new(&node_path)
        .arg(start_script.to_string_lossy().to_string())
        .current_dir(&install_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    match result {
        Ok(_) => {
            // Wait a moment and check
            std::thread::sleep(std::time::Duration::from_secs(3));
            if run_cmd_ok("lsof -i :8888 -sTCP:LISTEN") {
                InstallResult { success: true, message: Some("服务器已启动".into()), error: None, cancelled: None }
            } else {
                InstallResult { success: true, message: Some("服务器已启动（端口检测待确认）".into()), error: None, cancelled: None }
            }
        }
        Err(e) => {
            InstallResult { success: false, message: None, error: Some(e.to_string()), cancelled: None }
        }
    }
}

// ─── Clipboard ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn copy_to_clipboard(text: String) -> bool {
    run_cmd(&format!("printf '%s' '{}' | pbcopy", text.replace('\'', "'\"'\"'"))).is_ok()
}

// ─── Autostart (LaunchAgent) ─────────────────────────────────────────────────

#[tauri::command]
pub fn setup_autostart(install_path: String) -> InstallResult {
    inject_local_path();

    let node_path = find_executable("node")
        .unwrap_or_else(|| {
            if is_apple_silicon() { "/opt/homebrew/bin/node".into() }
            else { "/usr/local/bin/node".into() }
        });

    let home = home_dir();
    let agents_dir = home.join("Library/LaunchAgents");
    fs::create_dir_all(&agents_dir).ok();

    let plist_name = "com.screensync.server.plist";

    // Try to use template from install path
    let template_path = Path::new(&install_path).join(plist_name);
    let comprehensive_path = format!(
        "{}:{}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        screensync_bin().display(),
        screensync_deps().join("node/bin").display()
    );

    let plist_content = if template_path.exists() {
        let mut content = fs::read_to_string(&template_path).unwrap_or_default();
        content = content.replace("__NODE_PATH__", &node_path);
        content = content.replace("__INSTALL_PATH__", &install_path);
        content = content.replace(
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            &comprehensive_path,
        );
        content
    } else {
        format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.screensync.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>{node_path}</string>
        <string>{install_path}/start.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{install_path}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{comprehensive_path}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/screensync-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/screensync-server-error.log</string>
</dict>
</plist>"#)
    };

    let plist_path = agents_dir.join(plist_name);
    if let Err(e) = fs::write(&plist_path, &plist_content) {
        return InstallResult { success: false, message: None, error: Some(e.to_string()), cancelled: None };
    }

    // Unload, wait, load
    let _ = run_cmd(&format!("launchctl unload \"{}\" 2>/dev/null", plist_path.display()));
    std::thread::sleep(std::time::Duration::from_secs(1));
    let load_result = run_cmd(&format!("launchctl load \"{}\"", plist_path.display()));

    if load_result.is_ok() {
        std::thread::sleep(std::time::Duration::from_secs(3));
        InstallResult { success: true, message: Some("服务器已配置为开机自动启动".into()), error: None, cancelled: None }
    } else {
        InstallResult { success: false, message: None, error: Some("LaunchAgent 加载失败".into()), cancelled: None }
    }
}

// ─── iCloud Keep Downloaded ──────────────────────────────────────────────────

#[tauri::command]
pub fn setup_icloud_keep_downloaded() -> InstallResult {
    let icloud_sync = home_dir().join("Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg");
    if !icloud_sync.exists() {
        fs::create_dir_all(&icloud_sync).ok();
    }
    // brctl download to pin files
    let _ = run_cmd(&format!("brctl download \"{}\"", icloud_sync.display()));
    InstallResult { success: true, message: Some("iCloud 文件夹已配置".into()), error: None, cancelled: None }
}

// ─── Home Dir ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_home_dir() -> String {
    home_dir().to_string_lossy().to_string()
}

// ─── Quit ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
