#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# ScreenSync 一键修复更新脚本
# 适用于无法自动更新的老版本用户（如还在使用 UserPackage 的旧版本）
#
# 使用方法：
#   1. 将此脚本放到 ScreenSync 项目根目录（server.js 所在目录）
#   2. 打开终端，cd 到该目录
#   3. 运行: chmod +x emergency-update.sh && ./emergency-update.sh
# ═══════════════════════════════════════════════════════════════════════════════

# macOS 默认 Bash 3.2 在 set -u + 数组展开下兼容性较差，容易出现 unbound variable。
# 为避免用户环境反复报错：Bash 4+ 使用严格模式；Bash 3.x 关闭 -u 但保留关键失败策略。
if [ "${BASH_VERSINFO:-0}" -ge 4 ] 2>/dev/null; then
  set -euo pipefail
else
  set -eo pipefail
fi

REPO="BorderWalker99/figma-plugin-figma_sync"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/.emergency-backup-$(date +%Y%m%d%H%M%S)"
TEMP_DIR="$(mktemp -d)"
HOST_ARCH="$(uname -m)"
RUNTIME_ARCH_DIR="intel"
if [ "$HOST_ARCH" = "arm64" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  RUNTIME_ARCH_DIR="apple"
fi
OFFLINE_RUNTIME_READY=0
OFFLINE_RUNTIME_NODE=""
OFFLINE_RUNTIME_NPM=""
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

get_package_root_dir() {
  # 统一：runtime 始终放在项目目录（server.js 所在目录）内
  echo "$SCRIPT_DIR"
}

get_legacy_runtime_root() {
  local parent
  parent="$(dirname "$SCRIPT_DIR")"
  if [ "$(basename "$SCRIPT_DIR")" = "项目文件" ] && [ -d "$parent/runtime" ]; then
    echo "$parent/runtime"
  fi
}

migrate_legacy_runtime_to_project_dir() {
  local target_runtime="$SCRIPT_DIR/runtime"
  local legacy_runtime
  legacy_runtime="$(get_legacy_runtime_root || true)"

  if [ -z "${legacy_runtime:-}" ] || [ ! -d "$legacy_runtime" ]; then
    return 0
  fi
  if [ "$legacy_runtime" = "$target_runtime" ]; then
    return 0
  fi

  mkdir -p "$target_runtime" 2>/dev/null || true
  rsync -a "$legacy_runtime/" "$target_runtime/" 2>/dev/null || true
  rm -rf "$legacy_runtime" 2>/dev/null || true
  echo "   ↪️  已将旧版 runtime 迁移到项目目录: $target_runtime"
}

collect_runtime_bin_dirs() {
  local package_root
  package_root="$(get_package_root_dir)"
  local dirs=(
    "$package_root/runtime/bin"
    "$package_root/runtime/$RUNTIME_ARCH_DIR/bin"
    "$SCRIPT_DIR/runtime/bin"
    "$SCRIPT_DIR/runtime/$RUNTIME_ARCH_DIR/bin"
  )
  local seen=""
  local d
  for d in "${dirs[@]}"; do
    if [ -d "$d" ]; then
      case ":$seen:" in
        *":$d:"*) ;;
        *)
          echo "$d"
          seen="$seen:$d"
          ;;
      esac
    fi
  done
}

prepend_path_once() {
  local target="$1"
  if [ -n "$target" ] && [ -d "$target" ]; then
    case ":$PATH:" in
      *":$target:"*) ;;
      *) export PATH="$target:$PATH" ;;
    esac
  fi
}

append_env_path_once() {
  local var_name="$1"
  local target="$2"
  local current
  [ -n "$var_name" ] || return 0
  [ -n "$target" ] || return 0
  [ -d "$target" ] || return 0
  current="$(eval "printf '%s' \"\${$var_name:-}\"")"
  case ":$current:" in
    *":$target:"*) ;;
    *)
      if [ -n "$current" ]; then
        eval "export $var_name=\"\$target:\$current\""
      else
        eval "export $var_name=\"\$target\""
      fi
      ;;
  esac
}

configure_runtime_imagemagick_env() {
  local runtime_bin="$1"
  local runtime_root=""
  local magick_home=""
  [ -n "$runtime_bin" ] || return 1

  runtime_root="$(dirname "$runtime_bin")"
  if [ "$(basename "$runtime_root")" != "bin" ]; then
    return 1
  fi
  magick_home="$(dirname "$runtime_root")"
  [ -d "$magick_home" ] || return 1
  [ -x "$magick_home/bin/magick" ] || [ -x "$magick_home/bin/convert" ] || return 1

  export MAGICK_HOME="$magick_home"
  prepend_path_once "$magick_home/bin"
  append_env_path_once "DYLD_LIBRARY_PATH" "$magick_home/lib"

  if [ -d "$magick_home/lib/ImageMagick/modules-Q16HDRI/coders" ]; then
    export MAGICK_CODER_MODULE_PATH="$magick_home/lib/ImageMagick/modules-Q16HDRI/coders"
  fi
  if [ -d "$magick_home/lib/ImageMagick/modules-Q16HDRI/filters" ]; then
    export MAGICK_FILTER_MODULE_PATH="$magick_home/lib/ImageMagick/modules-Q16HDRI/filters"
  fi

  local cfg_parts=""
  if [ -d "$magick_home/etc/ImageMagick-7" ]; then
    cfg_parts="$magick_home/etc/ImageMagick-7"
  fi
  if [ -d "$magick_home/lib/ImageMagick/config-Q16HDRI" ]; then
    if [ -n "$cfg_parts" ]; then
      cfg_parts="$cfg_parts:$magick_home/lib/ImageMagick/config-Q16HDRI"
    else
      cfg_parts="$magick_home/lib/ImageMagick/config-Q16HDRI"
    fi
  fi
  if [ -n "$cfg_parts" ]; then
    export MAGICK_CONFIGURE_PATH="$cfg_parts"
  fi
  return 0
}

runtime_imagemagick_healthy() {
  local runtime_bin="$1"
  local magick_cmd=""
  local tmp_dir probe_in probe_out
  [ -n "$runtime_bin" ] || return 1

  if [ -x "$runtime_bin/magick" ]; then
    magick_cmd="$runtime_bin/magick"
  elif [ -x "$runtime_bin/convert" ]; then
    magick_cmd="$runtime_bin/convert"
  else
    return 1
  fi

  configure_runtime_imagemagick_env "$runtime_bin" >/dev/null 2>&1 || true

  if ! timeout_cmd 5 "$magick_cmd" -version >/dev/null 2>&1; then
    return 1
  fi

  # 尽量做一次 PNG 读写健康检查，避免“可执行存在但 coder 模块不可用”的误判。
  if [ -x "$runtime_bin/magick" ]; then
    tmp_dir="$(mktemp -d)"
    probe_in="$tmp_dir/probe.png"
    probe_out="$tmp_dir/probe_out.png"
    if ! timeout_cmd 6 "$runtime_bin/magick" -size 2x2 xc:none "$probe_in" >/dev/null 2>&1; then
      rm -rf "$tmp_dir" 2>/dev/null || true
      return 1
    fi
    if ! timeout_cmd 6 "$runtime_bin/magick" "$probe_in" -resize 1x1 "$probe_out" >/dev/null 2>&1; then
      rm -rf "$tmp_dir" 2>/dev/null || true
      return 1
    fi
    if ! timeout_cmd 6 "$runtime_bin/magick" identify "$probe_out" >/dev/null 2>&1; then
      rm -rf "$tmp_dir" 2>/dev/null || true
      return 1
    fi
    rm -rf "$tmp_dir" 2>/dev/null || true
  fi

  return 0
}

refresh_offline_runtime_state() {
  OFFLINE_RUNTIME_READY=0
  OFFLINE_RUNTIME_NODE=""
  OFFLINE_RUNTIME_NPM=""
  local runtime_node=""
  local runtime_npm=""
  local has_ffmpeg=0
  local has_ffprobe=0
  local has_gifsicle=0
  local has_magick=0
  local magick_checked=0
  local runtime_bin

  while IFS= read -r runtime_bin; do
    [ -n "$runtime_bin" ] || continue
    prepend_path_once "$runtime_bin"

    if [ -z "$runtime_node" ] && [ -x "$runtime_bin/node" ]; then
      runtime_node="$runtime_bin/node"
    fi
    if [ -z "$runtime_npm" ] && [ -x "$runtime_bin/npm" ]; then
      runtime_npm="$runtime_bin/npm"
    fi
    if [ -x "$runtime_bin/ffmpeg" ] && timeout_cmd 5 "$runtime_bin/ffmpeg" -version >/dev/null 2>&1; then
      has_ffmpeg=1
    fi
    if [ -x "$runtime_bin/ffprobe" ] && timeout_cmd 5 "$runtime_bin/ffprobe" -version >/dev/null 2>&1; then
      has_ffprobe=1
    fi
    [ -x "$runtime_bin/gifsicle" ] && has_gifsicle=1
    if [ "$magick_checked" -eq 0 ] && { [ -x "$runtime_bin/magick" ] || [ -x "$runtime_bin/convert" ]; }; then
      magick_checked=1
      if runtime_imagemagick_healthy "$runtime_bin"; then
        has_magick=1
      else
        echo "   ⚠️  检测到 runtime 内 ImageMagick 但健康检查失败，将继续走依赖修复"
      fi
    fi
  done < <(collect_runtime_bin_dirs)

  if [ -n "$runtime_node" ] && [ -z "$runtime_npm" ]; then
    if ensure_npm_from_node "$runtime_node"; then
      runtime_npm="$(dirname "$runtime_node")/npm"
    fi
  fi

  if [ -n "$runtime_node" ] && [ -n "$runtime_npm" ] && \
     [ "$has_ffmpeg" -eq 1 ] && [ "$has_ffprobe" -eq 1 ] && [ "$has_gifsicle" -eq 1 ] && [ "$has_magick" -eq 1 ]; then
    OFFLINE_RUNTIME_READY=1
    OFFLINE_RUNTIME_NODE="$runtime_node"
    OFFLINE_RUNTIME_NPM="$runtime_npm"
  fi
}

resolve_node_bin() {
  if [ -n "$OFFLINE_RUNTIME_NODE" ] && [ -x "$OFFLINE_RUNTIME_NODE" ] && "$OFFLINE_RUNTIME_NODE" -v >/dev/null 2>&1; then
    echo "$OFFLINE_RUNTIME_NODE"
    return 0
  fi
  local runtime_bin
  while IFS= read -r runtime_bin; do
    if [ -x "$runtime_bin/node" ] && "$runtime_bin/node" -v >/dev/null 2>&1; then
      echo "$runtime_bin/node"
      return 0
    fi
  done < <(collect_runtime_bin_dirs)

  local candidates=(
    "$HOME/.screensync/deps/node/bin/node"
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ] && "$c" -v >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done

  if command -v node >/dev/null 2>&1; then
    local cmd_node
    cmd_node="$(command -v node)"
    if [ -x "$cmd_node" ] && "$cmd_node" -v >/dev/null 2>&1; then
      echo "$cmd_node"
      return 0
    fi
  fi
  return 1
}

resolve_npm_bin() {
  if [ -n "$OFFLINE_RUNTIME_NPM" ] && [ -x "$OFFLINE_RUNTIME_NPM" ] && "$OFFLINE_RUNTIME_NPM" --version >/dev/null 2>&1; then
    echo "$OFFLINE_RUNTIME_NPM"
    return 0
  fi
  local runtime_bin
  while IFS= read -r runtime_bin; do
    if [ -x "$runtime_bin/npm" ] && "$runtime_bin/npm" --version >/dev/null 2>&1; then
      echo "$runtime_bin/npm"
      return 0
    fi
  done < <(collect_runtime_bin_dirs)

  local candidates=(
    "$HOME/.screensync/deps/node/bin/npm"
    "/usr/local/bin/npm"
    "/opt/homebrew/bin/npm"
  )
  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ] && "$c" --version >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done

  if command -v npm >/dev/null 2>&1; then
    local cmd_npm
    cmd_npm="$(command -v npm)"
    if [ -x "$cmd_npm" ] && "$cmd_npm" --version >/dev/null 2>&1; then
      echo "$cmd_npm"
      return 0
    fi
  fi
  return 1
}

ensure_npm_from_node() {
  local node_bin="$1"
  if [ -z "${node_bin:-}" ] || [ ! -x "$node_bin" ]; then
    return 1
  fi

  local node_root
  node_root="$(cd "$(dirname "$node_bin")/.." && pwd 2>/dev/null || true)"
  if [ -z "$node_root" ]; then
    return 1
  fi

  local npm_cli=""
  local npx_cli=""
  if [ -f "$node_root/lib/node_modules/npm/bin/npm-cli.js" ]; then
    npm_cli="$node_root/lib/node_modules/npm/bin/npm-cli.js"
  elif [ -f "$node_root/node_modules/npm/bin/npm-cli.js" ]; then
    npm_cli="$node_root/node_modules/npm/bin/npm-cli.js"
  fi

  if [ -f "$node_root/lib/node_modules/npm/bin/npx-cli.js" ]; then
    npx_cli="$node_root/lib/node_modules/npm/bin/npx-cli.js"
  elif [ -f "$node_root/node_modules/npm/bin/npx-cli.js" ]; then
    npx_cli="$node_root/node_modules/npm/bin/npx-cli.js"
  fi

  if [ -z "$npm_cli" ]; then
    return 1
  fi

  mkdir -p "$node_root/bin" 2>/dev/null || true
  cat > "$node_root/bin/npm" <<EOF
#!/bin/bash
exec "$node_bin" "$npm_cli" "\$@"
EOF
  chmod +x "$node_root/bin/npm" 2>/dev/null || true

  if [ -n "$npx_cli" ]; then
    cat > "$node_root/bin/npx" <<EOF
#!/bin/bash
exec "$node_bin" "$npx_cli" "\$@"
EOF
    chmod +x "$node_root/bin/npx" 2>/dev/null || true
  fi

  if [ -x "$node_root/bin/npm" ] && "$node_root/bin/npm" --version >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

install_local_node_with_npm_fallback() {
  local arch node_arch tmp_dir install_root latest_html tar_name version node_url alt_url
  arch="$(uname -m)"
  node_arch="x64"
  if [ "$arch" = "arm64" ]; then
    node_arch="arm64"
  fi

  tmp_dir="$(mktemp -d)"
  install_root="$HOME/.screensync/deps/node"
  latest_html="$(curl -fsSL --connect-timeout 15 --max-time 30 "https://nodejs.org/dist/latest-v20.x/" 2>/dev/null || true)"
  tar_name="$(echo "$latest_html" | grep -oE "node-v[0-9]+\\.[0-9]+\\.[0-9]+-darwin-${node_arch}\\.tar\\.gz" | head -1)"
  if [ -z "$tar_name" ]; then
    tar_name="node-v20.19.0-darwin-${node_arch}.tar.gz"
  fi

  version="$(echo "$tar_name" | sed -E 's/^node-v([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/')"
  node_url="https://nodejs.org/dist/latest-v20.x/$tar_name"
  alt_url="https://nodejs.org/dist/v${version}/$tar_name"

  if ! curl -fL --connect-timeout 20 --max-time 180 -o "$tmp_dir/node.tar.gz" "$node_url"; then
    if ! curl -fL --connect-timeout 20 --max-time 180 -o "$tmp_dir/node.tar.gz" "$alt_url"; then
      rm -rf "$tmp_dir"
      return 1
    fi
  fi

  rm -rf "${install_root}.tmp" 2>/dev/null || true
  mkdir -p "${install_root}.tmp"
  if ! tar -xzf "$tmp_dir/node.tar.gz" -C "${install_root}.tmp" --strip-components=1; then
    rm -rf "$tmp_dir" "${install_root}.tmp"
    return 1
  fi

  rm -rf "$install_root" 2>/dev/null || true
  mv "${install_root}.tmp" "$install_root"
  chmod +x "$install_root/bin/node" "$install_root/bin/npm" 2>/dev/null || true
  rm -rf "$tmp_dir"
  ensure_local_bins_path

  if [ -x "$install_root/bin/node" ] && [ -x "$install_root/bin/npm" ] && "$install_root/bin/npm" --version >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

has_required_node_modules() {
  local node_bin="$1"
  local project_dir="$2"
  if [ -z "${node_bin:-}" ] || [ ! -x "$node_bin" ]; then
    return 1
  fi
  if [ ! -f "$project_dir/package.json" ]; then
    return 1
  fi

  "$node_bin" -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies || {}).filter((dep) => dep !== "sharp");
for (const dep of deps) {
  require.resolve(dep, { paths: [root] });
}
' "$project_dir" >/dev/null 2>&1
}

get_host_npm_cpu() {
  local arch
  arch="$(uname -m)"
  if [ "$arch" = "arm64" ]; then
    echo "arm64"
  else
    echo "x64"
  fi
}

check_sharp_runtime_health() {
  local node_bin="$1"
  local project_dir="$2"
  if [ -z "${node_bin:-}" ] || [ ! -x "$node_bin" ]; then
    return 1
  fi
  if [ ! -f "$project_dir/node_modules/sharp/package.json" ]; then
    return 1
  fi
  "$node_bin" -e "process.chdir(process.argv[1]);try{require('sharp');process.exit(0);}catch(e){process.exit(1);}" \
    "$project_dir" >/dev/null 2>&1
}

collect_sharp_vendor_node_modules_dirs() {
  local package_root
  package_root="$(get_package_root_dir)"
  # 兼容旧安装包：历史版本会在 runtime/sharp-vendor 下内置 sharp 预编译产物。
  # 新胖包已不再分发该目录，因此这里只作为最后兜底来源，不再作为主修复路径。
  local dirs=(
    "$package_root/runtime/sharp-vendor/node_modules"
    "$package_root/runtime/$RUNTIME_ARCH_DIR/sharp-vendor/node_modules"
    "$SCRIPT_DIR/runtime/sharp-vendor/node_modules"
    "$SCRIPT_DIR/runtime/$RUNTIME_ARCH_DIR/sharp-vendor/node_modules"
  )
  local seen=""
  local d
  for d in "${dirs[@]}"; do
    if [ -d "$d" ]; then
      case ":$seen:" in
        *":$d:"*) ;;
        *)
          echo "$d"
          seen="$seen:$d"
          ;;
      esac
    fi
  done
}

restore_bundled_sharp_for_current_arch() {
  local project_dir="$1"
  local cpu source_root vendor_root
  cpu="$(get_host_npm_cpu)"
  source_root=""

  while IFS= read -r vendor_root; do
    [ -n "$vendor_root" ] || continue
    if [ -d "$vendor_root/sharp" ] && \
       [ -d "$vendor_root/detect-libc" ] && \
       [ -d "$vendor_root/semver" ] && \
       [ -d "$vendor_root/@img/colour" ] && \
       [ -d "$vendor_root/@img/sharp-darwin-$cpu" ] && \
       [ -d "$vendor_root/@img/sharp-libvips-darwin-$cpu" ]; then
      source_root="$vendor_root"
      break
    fi
  done < <(collect_sharp_vendor_node_modules_dirs)

  [ -n "$source_root" ] || return 1

  mkdir -p "$project_dir/node_modules/@img"
  rm -rf \
    "$project_dir/node_modules/sharp" \
    "$project_dir/node_modules/detect-libc" \
    "$project_dir/node_modules/semver" \
    "$project_dir/node_modules/@img/sharp-darwin-$cpu" \
    "$project_dir/node_modules/@img/sharp-libvips-darwin-$cpu" 2>/dev/null || true

  rsync -a "$source_root/sharp" "$project_dir/node_modules/" || return 1
  rsync -a "$source_root/detect-libc" "$project_dir/node_modules/" || return 1
  rsync -a "$source_root/semver" "$project_dir/node_modules/" || return 1
  rsync -a "$source_root/@img/colour" "$project_dir/node_modules/@img/" || return 1
  rsync -a "$source_root/@img/sharp-darwin-$cpu" "$project_dir/node_modules/@img/" || return 1
  rsync -a "$source_root/@img/sharp-libvips-darwin-$cpu" "$project_dir/node_modules/@img/" || return 1
  return 0
}

strip_packaged_sharp_artifacts() {
  local project_dir="$1"
  [ -n "${project_dir:-}" ] || return 0

  # 新方案要求 sharp 始终按当前机器架构现装。
  # 即使远端 release 资产暂时仍携带了旧的 sharp/node_modules，这里也先剥离，
  # 后续再统一走 check_sharp_runtime_health + repair_sharp_for_current_arch。
  rm -rf \
    "$project_dir/node_modules/sharp" \
    "$project_dir/node_modules/@img" \
    "$project_dir/runtime/sharp-vendor" \
    "$project_dir/runtime/apple/sharp-vendor" \
    "$project_dir/runtime/intel/sharp-vendor" 2>/dev/null || true
}

repair_sharp_for_current_arch() {
  local node_bin="$1"
  local npm_bin="$2"
  local project_dir="$3"
  local cpu
  cpu="$(get_host_npm_cpu)"

  if [ -z "${node_bin:-}" ] || [ ! -x "$node_bin" ]; then
    return 1
  fi
  if [ -z "${npm_bin:-}" ] || [ ! -x "$npm_bin" ]; then
    return 1
  fi

  echo "   ↪️  检测到 sharp 缺失或与当前系统架构不兼容，正在修复（darwin-$cpu）..."

  local sharp_env="npm_config_os=darwin npm_config_cpu=$cpu npm_config_loglevel=warn npm_config_strict_ssl=false"
  local registries=("https://registry.npmmirror.com" "https://registry.npmjs.org")

  # Strategy 1: npm install sharp (cd into project dir instead of --prefix)
  rm -rf "$project_dir/node_modules/sharp" "$project_dir/node_modules/@img" 2>/dev/null || true
  local reg
  for reg in "${registries[@]}"; do
    set +e
    (cd "$project_dir" && env $sharp_env \
      "$npm_bin" install --no-save --no-audit --no-fund --include=optional --legacy-peer-deps \
        sharp --registry="$reg" >/dev/null 2>&1)
    local rc=$?
    set -e
    if [ "$rc" -eq 0 ] && check_sharp_runtime_health "$node_bin" "$project_dir"; then
      echo "   ✅ sharp 运行时修复成功（darwin-$cpu）"
      return 0
    fi
  done

  # Strategy 2: explicitly install platform binding packages
  echo "   ↪️  尝试显式安装平台包 @img/sharp-darwin-$cpu..."
  rm -rf "$project_dir/node_modules/sharp" "$project_dir/node_modules/@img" 2>/dev/null || true
  for reg in "${registries[@]}"; do
    set +e
    (cd "$project_dir" && env $sharp_env \
      "$npm_bin" install --no-save --no-audit --no-fund --legacy-peer-deps \
        sharp "@img/sharp-darwin-$cpu" "@img/sharp-libvips-darwin-$cpu" \
        --registry="$reg" >/dev/null 2>&1)
    local rc2=$?
    set -e
    if [ "$rc2" -eq 0 ] && check_sharp_runtime_health "$node_bin" "$project_dir"; then
      echo "   ✅ sharp 显式平台包安装成功（darwin-$cpu）"
      return 0
    fi
  done

  # Strategy 3: npm rebuild
  echo "   ↪️  尝试 npm rebuild sharp..."
  set +e
  (cd "$project_dir" && env $sharp_env \
    "$npm_bin" rebuild sharp --include=optional >/dev/null 2>&1)
  set -e
  if check_sharp_runtime_health "$node_bin" "$project_dir"; then
    echo "   ✅ sharp rebuild 成功（darwin-$cpu）"
    return 0
  fi

  # Strategy 4: legacy bundled sharp-vendor (last resort)
  if restore_bundled_sharp_for_current_arch "$project_dir"; then
    echo "   ↪️  检测到旧版 sharp-vendor，尝试用历史离线包兜底恢复"
    if check_sharp_runtime_health "$node_bin" "$project_dir"; then
      echo "   ✅ sharp 已通过历史离线包恢复（darwin-$cpu）"
      return 0
    fi
    echo "   ⚠️  历史 sharp-vendor 恢复后仍不可用"
  fi

  echo "   ⚠️  sharp 所有修复策略均已尝试，仍无法加载"
  return 1
}

print_startup_logs() {
  echo ""
  echo -e "${YELLOW}📄 启动失败诊断（最近日志）${NC}"
  if [ -f "$SCRIPT_DIR/server-error.log" ]; then
    echo "---- $SCRIPT_DIR/server-error.log (tail -40) ----"
    tail -40 "$SCRIPT_DIR/server-error.log" 2>/dev/null || true
  fi
  if [ -f "/tmp/screensync-server-error.log" ]; then
    echo "---- /tmp/screensync-server-error.log (tail -40) ----"
    tail -40 /tmp/screensync-server-error.log 2>/dev/null || true
  fi
  echo "--------------------------------------------------"
}

ensure_local_bins_path() {
  local local_bin="$HOME/.screensync/bin"
  local local_node_bin="$HOME/.screensync/deps/node/bin"
  mkdir -p "$local_bin" "$HOME/.screensync/deps" 2>/dev/null || true
  migrate_legacy_runtime_to_project_dir
  prepend_path_once "$local_bin"
  prepend_path_once "$local_node_bin"
  refresh_offline_runtime_state
}

install_ffmpeg_fallback() {
  local local_bin="$HOME/.screensync/bin"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local arch
  arch="$(uname -m)"
  local ff_arch="amd64"
  if [ "$arch" = "arm64" ]; then ff_arch="arm64"; fi
  local ffmpeg_zip="$tmp_dir/ffmpeg.zip"
  local ffprobe_zip="$tmp_dir/ffprobe.zip"

  echo "   ↪️  尝试本地安装 FFmpeg（非 Homebrew）..."
  if ! curl -fL --connect-timeout 20 --max-time 120 \
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/${ff_arch}/release/ffmpeg.zip" \
    -o "$ffmpeg_zip"; then
    echo "   ⚠️  主下载源失败，尝试备用源..."
    curl -fL --connect-timeout 20 --max-time 120 \
      "https://evermeet.cx/ffmpeg/getrelease/zip" \
      -o "$ffmpeg_zip" || { rm -rf "$tmp_dir"; return 1; }
  fi

  if ! curl -fL --connect-timeout 20 --max-time 120 \
    "https://ffmpeg.martin-riedl.de/redirect/latest/macos/${ff_arch}/release/ffprobe.zip" \
    -o "$ffprobe_zip"; then
    echo "   ⚠️  FFprobe 主下载源失败，尝试备用源..."
    curl -fL --connect-timeout 20 --max-time 120 \
      "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" \
      -o "$ffprobe_zip" || { rm -rf "$tmp_dir"; return 1; }
  fi

  unzip -o "$ffmpeg_zip" -d "$local_bin" >/dev/null 2>&1 || { rm -rf "$tmp_dir"; return 1; }
  unzip -o "$ffprobe_zip" -d "$local_bin" >/dev/null 2>&1 || { rm -rf "$tmp_dir"; return 1; }
  chmod +x "$local_bin/ffmpeg" "$local_bin/ffprobe" 2>/dev/null || true
  rm -rf "$tmp_dir"
  command -v ffmpeg >/dev/null 2>&1
}

install_gifsicle_fallback() {
  local local_bin="$HOME/.screensync/bin"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  local npm_bin=""
  local npm_proj="$tmp_dir/npm-gifsicle"
  local npm_candidate=""

  echo "   ↪️  尝试本地安装 Gifsicle（预编译二进制）..."
  npm_bin="$(resolve_npm_bin || true)"
  if [ -n "$npm_bin" ]; then
    mkdir -p "$npm_proj"
    printf '{\n  "name": "screensync-gifsicle-fallback",\n  "private": true\n}\n' > "$npm_proj/package.json"
    if (cd "$npm_proj" && "$npm_bin" install gifsicle --omit=dev --no-audit --no-fund --silent >/dev/null 2>&1); then
      for candidate in \
        "$npm_proj/node_modules/gifsicle/vendor/gifsicle" \
        "$npm_proj/node_modules/.bin/gifsicle"; do
        if [ -x "$candidate" ]; then
          npm_candidate="$candidate"
          break
        fi
      done
      if [ -n "$npm_candidate" ]; then
        cp "$npm_candidate" "$local_bin/gifsicle" 2>/dev/null || true
        chmod +x "$local_bin/gifsicle" 2>/dev/null || true
      fi
    fi
  fi

  if ! command -v gifsicle >/dev/null 2>&1; then
    echo "   ⚠️  预编译二进制安装失败，尝试源码编译..."
    command -v cc >/dev/null 2>&1 || { rm -rf "$tmp_dir"; return 1; }
    command -v make >/dev/null 2>&1 || { rm -rf "$tmp_dir"; return 1; }
    curl -fL --connect-timeout 20 --max-time 180 \
      "https://www.lcdf.org/gifsicle/gifsicle-1.96.tar.gz" | tar xz -C "$tmp_dir" --strip-components=1 || { rm -rf "$tmp_dir"; return 1; }
    (cd "$tmp_dir" && ./configure --disable-gifview >/dev/null 2>&1 && make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" >/dev/null 2>&1) || { rm -rf "$tmp_dir"; return 1; }
    [ -f "$tmp_dir/src/gifsicle" ] || { rm -rf "$tmp_dir"; return 1; }
    cp "$tmp_dir/src/gifsicle" "$local_bin/gifsicle" || { rm -rf "$tmp_dir"; return 1; }
    chmod +x "$local_bin/gifsicle" 2>/dev/null || true
  fi

  rm -rf "$tmp_dir"
  command -v gifsicle >/dev/null 2>&1
}

install_imagemagick_fallback() {
  local local_bin="$HOME/.screensync/bin"
  local im_dir="$HOME/.screensync/deps/imagemagick"
  local tmp_dir install_budget start_ts now_ts elapsed
  tmp_dir="$(mktemp -d)"
  install_budget="${IMAGEMAGICK_INSTALL_MAX_SEC:-210}"
  start_ts="$(date +%s)"
  mkdir -p "$im_dir" "$local_bin"

  within_install_budget() {
    now_ts="$(date +%s)"
    elapsed=$((now_ts - start_ts))
    [ "$elapsed" -lt "$install_budget" ]
  }

  echo "   ↪️  尝试本地安装 ImageMagick（便携 DMG）..."
  if within_install_budget && \
     (install_imagemagick_from_dmg "https://mendelson.org/imagemagick.dmg" "$tmp_dir" "$im_dir" "$local_bin" || \
      install_imagemagick_from_dmg "https://mendelson.org/PortableImageMagickInstaller.dmg" "$tmp_dir" "$im_dir" "$local_bin"); then
    ensure_local_bins_path
    if verify_imagemagick_health; then
      rm -rf "$tmp_dir"
      return 0
    fi
    echo "   ⚠️  DMG 安装成功但健康检查失败，继续尝试其他方案..."
  fi

  if [ "$(uname -m)" = "x86_64" ]; then
    echo "   ↪️  尝试 Intel 预编译包安装 ImageMagick..."
    if within_install_budget && install_imagemagick_from_tarball \
      "https://download.imagemagick.org/archive/binaries/ImageMagick-x86_64-apple-darwin20.1.0.tar.gz" \
      "$tmp_dir" "$im_dir" "$local_bin"; then
      ensure_local_bins_path
      if verify_imagemagick_health; then
        rm -rf "$tmp_dir"
        return 0
      fi
      echo "   ⚠️  预编译包安装后健康检查失败，继续尝试源码编译..."
    fi

    # 新增保底：从官方 archive/binaries 索引自动挑选可用 Intel 包
    if within_install_budget; then
      echo "   ↪️  尝试官方归档索引自动匹配 Intel 安装包..."
      if install_imagemagick_from_archive_index "$tmp_dir" "$im_dir" "$local_bin"; then
        ensure_local_bins_path
        if verify_imagemagick_health; then
          rm -rf "$tmp_dir"
          return 0
        fi
        echo "   ⚠️  归档索引安装后健康检查失败"
      fi
    fi
  fi

  if [ "${ENABLE_IMAGEMAGICK_SOURCE_BUILD:-0}" = "1" ]; then
    if ! within_install_budget; then
      echo "   ⏭️  安装超时预算已用尽（>${install_budget}s），跳过源码编译"
      rm -rf "$tmp_dir"
      return 1
    fi
    echo "   ↪️  尝试源码编译 ImageMagick（最后兜底）..."
    if install_imagemagick_from_source "$tmp_dir" "$im_dir" "$local_bin"; then
      ensure_local_bins_path
      if verify_imagemagick_health; then
        rm -rf "$tmp_dir"
        return 0
      fi
      echo "   ⚠️  源码编译完成但健康检查失败"
    fi
  else
    echo "   ⏭️  已跳过源码编译兜底（默认快速模式）"
    echo "      如需启用，可用: ENABLE_IMAGEMAGICK_SOURCE_BUILD=1 bash $0"
  fi

  rm -rf "$tmp_dir"
  return 1
}

install_imagemagick_from_archive_index() {
  local tmp_dir="$1"
  local im_dir="$2"
  local local_bin="$3"
  local index_file urls_file
  index_file="$tmp_dir/im_archive_index.html"
  urls_file="$tmp_dir/im_archive_urls.txt"

  rm -f "$index_file" "$urls_file" 2>/dev/null || true

  # 多源拉取目录索引，减少单一域名失败概率
  if ! curl -fL --connect-timeout 8 --max-time 25 \
      --retry 2 --retry-delay 1 --retry-all-errors \
      "https://download.imagemagick.org/archive/binaries/" -o "$index_file" 2>/dev/null; then
    curl -fL --connect-timeout 8 --max-time 25 \
      --retry 2 --retry-delay 1 --retry-all-errors \
      "https://imagemagick.org/archive/binaries/" -o "$index_file" 2>/dev/null || return 1
  fi

  python3 - "$index_file" "$urls_file" <<'PY'
import re, sys
index_path, out_path = sys.argv[1], sys.argv[2]
text = open(index_path, "r", encoding="utf-8", errors="ignore").read()
matches = re.findall(r'ImageMagick-x86_64-apple-darwin[0-9.]+\.tar\.gz', text, flags=re.I)
seen = set()
ordered = []
for m in matches:
    if m not in seen:
        seen.add(m)
        ordered.append(m)
ordered = ordered[:5]
with open(out_path, "w", encoding="utf-8") as f:
    for name in ordered:
        f.write("https://download.imagemagick.org/archive/binaries/" + name + "\n")
        f.write("https://imagemagick.org/archive/binaries/" + name + "\n")
PY

  [ -s "$urls_file" ] || return 1
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    echo "      - 尝试: $(basename "$url")"
    if install_imagemagick_from_tarball "$url" "$tmp_dir" "$im_dir" "$local_bin"; then
      return 0
    fi
  done < "$urls_file"
  return 1
}

install_imagemagick_from_dmg() {
  local dmg_url="$1"
  local tmp_dir="$2"
  local im_dir="$3"
  local local_bin="$4"
  local dmg_path mount_point app_name magick_bin

  dmg_path="$tmp_dir/imagemagick.dmg"
  mount_point="$tmp_dir/im_mount"
  rm -f "$dmg_path" 2>/dev/null || true
  rm -rf "$mount_point" 2>/dev/null || true

  curl -fL --connect-timeout 8 --max-time 45 \
    --retry 2 --retry-delay 1 --retry-all-errors \
    --speed-time 15 --speed-limit 1024 \
    --progress-bar "$dmg_url" -o "$dmg_path" 2>&1 || return 1
  mkdir -p "$mount_point"
  timeout_cmd 15 hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_point" >/dev/null 2>&1 || return 1

  app_name="$(python3 -c "import os,re; p='$mount_point'; apps=[n for n in os.listdir(p) if n.lower().endswith('.app') and re.search(r'magick', n, re.I)]; print(apps[0] if apps else '')" 2>/dev/null)"
  if [ -z "$app_name" ]; then
    timeout_cmd 10 hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true
    return 1
  fi

  rm -rf "$im_dir" 2>/dev/null || true
  mkdir -p "$im_dir"
  cp -R "$mount_point/$app_name" "$im_dir/" >/dev/null 2>&1 || { timeout_cmd 10 hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true; return 1; }
  timeout_cmd 10 hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true

  magick_bin="$im_dir/$app_name/Contents/MacOS/magick"
  [ -x "$magick_bin" ] || return 1
  xattr -rd com.apple.quarantine "$im_dir/$app_name" >/dev/null 2>&1 || true
  printf '#!/bin/bash\nexec "%s" "$@"\n' "$magick_bin" > "$local_bin/magick"
  printf '#!/bin/bash\nexec "%s" convert "$@"\n' "$magick_bin" > "$local_bin/convert"
  chmod +x "$local_bin/magick" "$local_bin/convert" 2>/dev/null || true
  return 0
}

install_imagemagick_from_tarball() {
  local tar_url="$1"
  local tmp_dir="$2"
  local im_dir="$3"
  local local_bin="$4"
  local tar_path extract_dir magick_bin

  tar_path="$tmp_dir/imagemagick.tar.gz"
  extract_dir="$tmp_dir/im_extract"
  rm -f "$tar_path" 2>/dev/null || true
  rm -rf "$extract_dir" 2>/dev/null || true
  mkdir -p "$extract_dir"

  curl -fL --connect-timeout 8 --max-time 70 \
    --retry 2 --retry-delay 1 --retry-all-errors \
    --speed-time 20 --speed-limit 1024 \
    --progress-bar "$tar_url" -o "$tar_path" 2>&1 || return 1
  timeout_cmd 30 tar xzf "$tar_path" -C "$extract_dir" >/dev/null 2>&1 || return 1
  magick_bin="$(python3 -c "import os; p='$extract_dir'; out='';\
for r,_,fs in os.walk(p):\
  if 'magick' in fs: out=os.path.join(r,'magick'); break;\
print(out)" 2>/dev/null)"
  [ -n "$magick_bin" ] && [ -f "$magick_bin" ] || return 1

  rm -rf "$im_dir" 2>/dev/null || true
  mkdir -p "$im_dir"
  cp -R "$extract_dir/." "$im_dir/" >/dev/null 2>&1 || return 1
  magick_bin="$(python3 -c "import os; p='$im_dir'; out='';\
for r,_,fs in os.walk(p):\
  if 'magick' in fs: out=os.path.join(r,'magick'); break;\
print(out)" 2>/dev/null)"
  [ -n "$magick_bin" ] && [ -f "$magick_bin" ] || return 1

  chmod +x "$magick_bin" >/dev/null 2>&1 || true
  xattr -rd com.apple.quarantine "$im_dir" >/dev/null 2>&1 || true
  printf '#!/bin/bash\nexec "%s" "$@"\n' "$magick_bin" > "$local_bin/magick"
  printf '#!/bin/bash\nexec "%s" convert "$@"\n' "$magick_bin" > "$local_bin/convert"
  chmod +x "$local_bin/magick" "$local_bin/convert" 2>/dev/null || true
  return 0
}

install_imagemagick_from_source() {
  local tmp_dir="$1"
  local im_dir="$2"
  local local_bin="$3"
  local src_dir magick_bin build_threads configure_log make_log install_log

  command -v cc >/dev/null 2>&1 || return 1
  command -v make >/dev/null 2>&1 || return 1
  xcode-select -p >/dev/null 2>&1 || return 1

  src_dir="$tmp_dir/im_src"
  rm -rf "$src_dir" 2>/dev/null || true
  mkdir -p "$src_dir"
  curl -fL --connect-timeout 20 --max-time 300 \
    "https://imagemagick.org/archive/ImageMagick.tar.gz" | tar xz -C "$src_dir" --strip-components=1 >/dev/null 2>&1 || return 1

  rm -rf "$im_dir" 2>/dev/null || true
  mkdir -p "$im_dir"
  build_threads="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  configure_log="$tmp_dir/im_configure.log"
  make_log="$tmp_dir/im_make.log"
  install_log="$tmp_dir/im_install.log"

  echo "      - 配置编译参数（最多 3 分钟）..."
  if ! run_with_timeout 180 "cd \"$src_dir\" && ./configure --prefix=\"$im_dir\" --disable-docs --without-modules --without-perl --disable-openmp --with-quantum-depth=16 CFLAGS='-O2' >\"$configure_log\" 2>&1"; then
    echo "      ❌ configure 失败或超时，最近日志:"
    python3 -c "from pathlib import Path; p=Path('$configure_log'); print(''.join(p.read_text(errors='ignore').splitlines(True)[-40:]) if p.exists() else '(无日志)')"
    return 1
  fi

  echo "      - 开始编译（最多 12 分钟，期间会持续输出心跳）..."
  if ! run_with_timeout 720 "cd \"$src_dir\" && make -j\"$build_threads\" >\"$make_log\" 2>&1"; then
    echo "      ❌ make 失败或超时，最近日志:"
    python3 -c "from pathlib import Path; p=Path('$make_log'); print(''.join(p.read_text(errors='ignore').splitlines(True)[-40:]) if p.exists() else '(无日志)')"
    return 1
  fi

  echo "      - 安装编译产物（最多 3 分钟）..."
  if ! run_with_timeout 180 "cd \"$src_dir\" && make install >\"$install_log\" 2>&1"; then
    echo "      ❌ make install 失败或超时，最近日志:"
    python3 -c "from pathlib import Path; p=Path('$install_log'); print(''.join(p.read_text(errors='ignore').splitlines(True)[-40:]) if p.exists() else '(无日志)')"
    return 1
  fi

  magick_bin="$im_dir/bin/magick"
  [ -x "$magick_bin" ] || return 1
  printf '#!/bin/bash\nexec "%s" "$@"\n' "$magick_bin" > "$local_bin/magick"
  printf '#!/bin/bash\nexec "%s" convert "$@"\n' "$magick_bin" > "$local_bin/convert"
  chmod +x "$local_bin/magick" "$local_bin/convert" 2>/dev/null || true
  return 0
}

run_with_timeout() {
  local timeout_sec="$1"
  shift
  local cmd="$*"
  local pid start now elapsed last_beat

  bash -lc "$cmd" &
  pid=$!
  start="$(date +%s)"
  last_beat=0

  while kill -0 "$pid" 2>/dev/null; do
    sleep 2
    now="$(date +%s)"
    elapsed=$((now - start))
    if [ $((elapsed - last_beat)) -ge 20 ]; then
      echo "        ...仍在执行（${elapsed}s）"
      last_beat="$elapsed"
    fi
    if [ "$elapsed" -ge "$timeout_sec" ]; then
      echo "        ⏱️ 命令超时（>${timeout_sec}s），正在终止..."
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
  done

  wait "$pid"
  return $?
}

verify_imagemagick_health() {
  local mode tmp_dir probe_in probe_out magick_path convert_path identify_path
  local write_cmd identify_cmd
  local cache_file cache_ttl
  mode="${1:-full}"
  cache_file="$HOME/.screensync/deps/imagemagick/.health-ok"
  cache_ttl="${IMAGEMAGICK_HEALTH_CACHE_TTL_SEC:-86400}"

  is_cache_fresh() {
    local f="$1"
    local ttl="$2"
    local now ts
    [ -f "$f" ] || return 1
    now="$(date +%s)"
    ts="$(stat -f %m "$f" 2>/dev/null || echo 0)"
    [ "$ts" -gt 0 ] || return 1
    [ $((now - ts)) -le "$ttl" ]
  }

  magick_path="$(command -v magick 2>/dev/null || true)"
  if [ -n "$magick_path" ] && [ -x "$magick_path" ]; then
    write_cmd="$magick_path"
    identify_cmd="$magick_path identify"
  else
    convert_path="$(command -v convert 2>/dev/null || true)"
    identify_path="$(command -v identify 2>/dev/null || true)"
    if [ -n "$convert_path" ] && [ -x "$convert_path" ] && [ -n "$identify_path" ] && [ -x "$identify_path" ]; then
      write_cmd="$convert_path"
      identify_cmd="$identify_path"
    else
      return 1
    fi
  fi

  # 快速检测：用于“检查系统依赖”阶段，避免在异常机型上长时间卡住。
  if [ "$mode" = "quick" ]; then
    if is_cache_fresh "$cache_file" "$cache_ttl"; then
      return 0
    fi
    timeout_cmd 3 "$write_cmd" -version >/dev/null 2>&1
    return $?
  fi

  tmp_dir="$(mktemp -d)"
  probe_in="$tmp_dir/probe.png"
  probe_out="$tmp_dir/probe_out.png"

  if ! timeout_cmd 5 "$write_cmd" -version >/dev/null 2>&1; then
    rm -f "$cache_file" 2>/dev/null || true
    rm -rf "$tmp_dir"; return 1
  fi
  if ! timeout_cmd 5 "$write_cmd" -size 2x2 xc:none "$probe_in" >/dev/null 2>&1; then
    rm -f "$cache_file" 2>/dev/null || true
    rm -rf "$tmp_dir"; return 1
  fi
  if ! timeout_cmd 5 "$write_cmd" "$probe_in" -resize 1x1 "$probe_out" >/dev/null 2>&1; then
    rm -f "$cache_file" 2>/dev/null || true
    rm -rf "$tmp_dir"; return 1
  fi
  if ! timeout_cmd 5 $identify_cmd "$probe_out" >/dev/null 2>&1; then
    rm -f "$cache_file" 2>/dev/null || true
    rm -rf "$tmp_dir"; return 1
  fi

  mkdir -p "$(dirname "$cache_file")" 2>/dev/null || true
  date +%s > "$cache_file" 2>/dev/null || true
  rm -rf "$tmp_dir"
  return 0
}

timeout_cmd() {
  local secs="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
  fi
}

cleanup() {
  rm -rf "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}       ScreenSync 一键修复更新脚本${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# ─── 1. 验证当前目录 ─────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/server.js" ] && [ ! -f "$SCRIPT_DIR/start.js" ]; then
  echo -e "${RED}❌ 错误：请将此脚本放到 ScreenSync 项目根目录（server.js 所在目录）后运行${NC}"
  echo "   当前目录: $SCRIPT_DIR"
  exit 1
fi
echo -e "${GREEN}✅ 项目目录确认: $SCRIPT_DIR${NC}"

# ─── 2. 停止正在运行的服务器 ──────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔄 正在停止现有服务器进程...${NC}"
# 先卸载 launchd 服务
PLIST_PATH="$HOME/Library/LaunchAgents/com.screensync.server.plist"
if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi
pkill -f "node.*server\.js" 2>/dev/null || true
pkill -f "node.*start\.js" 2>/dev/null || true
sleep 1
echo -e "${GREEN}✅ 服务器进程已停止${NC}"

# ─── 3. 检测系统架构（兼容 Rosetta）───────────────────────────────────────────
ARCH="$(uname -m)"
IS_ARM64_MAC="0"
# 在 Apple Silicon 机器上，即使终端跑在 Rosetta，hw.optional.arm64 仍为 1
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  IS_ARM64_MAC="1"
fi

if [ "$ARCH" = "arm64" ] || [ "$IS_ARM64_MAC" = "1" ]; then
  ASSET_NAME="ScreenSync-Apple.tar.gz"
  if [ "$ARCH" = "x86_64" ]; then
    ARCH_LABEL="Apple Silicon (M系列芯片，检测到 Rosetta 终端)"
  else
    ARCH_LABEL="Apple Silicon (M系列芯片)"
  fi
  NEW_PACKAGE_NAME="ScreenSync-Apple"
else
  ASSET_NAME="ScreenSync-Intel.tar.gz"
  ARCH_LABEL="Intel"
  NEW_PACKAGE_NAME="ScreenSync-Intel"
fi
echo ""
echo -e "${GREEN}✅ 系统架构: ${ARCH_LABEL} → 将下载 ${ASSET_NAME}${NC}"

# ─── 4. 获取最新 Release 信息 ────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔍 正在获取最新版本信息...${NC}"

RELEASE_JSON="$TEMP_DIR/release.json"
LATEST_TAG=""
DOWNLOAD_URL=""

if [ -n "${GITHUB_TOKEN:-}" ]; then
  HTTP_CODE=$(curl -sL -w "%{http_code}" \
    -H "Accept: application/vnd.github.v3+json" \
    -H "User-Agent: ScreenSync-EmergencyUpdate" \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    --connect-timeout 15 --max-time 30 \
    "https://api.github.com/repos/$REPO/releases/latest" \
    -o "$RELEASE_JSON")
else
  HTTP_CODE=$(curl -sL -w "%{http_code}" \
    -H "Accept: application/vnd.github.v3+json" \
    -H "User-Agent: ScreenSync-EmergencyUpdate" \
    --connect-timeout 15 --max-time 30 \
    "https://api.github.com/repos/$REPO/releases/latest" \
    -o "$RELEASE_JSON")
fi

if [ "$HTTP_CODE" = "200" ]; then
  LATEST_TAG=$(python3 -c "import json; d=json.load(open('$RELEASE_JSON')); print(d['tag_name'])" 2>/dev/null)
  DOWNLOAD_URL=$(python3 -c "
import json
d = json.load(open('$RELEASE_JSON'))
for a in d.get('assets', []):
    if '$ASSET_NAME' in a['name']:
        print(a['browser_download_url'])
        break
" 2>/dev/null)
fi

if [ -z "$LATEST_TAG" ] || [ -z "$DOWNLOAD_URL" ]; then
  echo -e "${YELLOW}⚠️  GitHub API 受限 (HTTP $HTTP_CODE)，正在使用备用方式获取版本信息...${NC}"
  REDIRECT_URL=$(curl -sI -o /dev/null -w "%{redirect_url}" \
    -H "User-Agent: ScreenSync-EmergencyUpdate" \
    --connect-timeout 15 --max-time 15 \
    "https://github.com/$REPO/releases/latest" 2>/dev/null)

  if [ -n "$REDIRECT_URL" ]; then
    LATEST_TAG=$(echo "$REDIRECT_URL" | grep -oE '[^/]+$')
  fi

  if [ -z "$LATEST_TAG" ]; then
    LATEST_TAG=$(curl -sL --max-time 15 \
      -H "User-Agent: ScreenSync-EmergencyUpdate" \
      "https://github.com/$REPO/releases/latest" 2>/dev/null \
      | grep -oE '/releases/tag/[^"]+' | head -1 | grep -oE '[^/]+$')
  fi

  if [ -z "$LATEST_TAG" ]; then
    echo -e "${RED}❌ 无法获取版本信息${NC}"
    echo "   GitHub API 限流或网络异常，请稍后重试"
    echo "   也可设置环境变量后重试: GITHUB_TOKEN=your_token bash $0"
    exit 1
  fi

  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET_NAME"
fi

echo -e "${GREEN}✅ 最新版本: ${LATEST_TAG}${NC}"

if [ -z "$DOWNLOAD_URL" ]; then
  echo -e "${RED}❌ 未找到 ${ASSET_NAME} 的下载地址${NC}"
  exit 1
fi

echo -e "${GREEN}✅ 下载地址已获取${NC}"

# ─── 5. 下载更新包 ───────────────────────────────────────────────────────────
TAR_FILE="$TEMP_DIR/$ASSET_NAME"
echo ""
echo -e "${YELLOW}📥 正在下载 ${ASSET_NAME}...${NC}"

MAX_RETRIES=3
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
  if curl -fL --progress-bar \
    -H "User-Agent: ScreenSync-EmergencyUpdate" \
    --connect-timeout 30 --max-time 300 \
    -o "$TAR_FILE" "$DOWNLOAD_URL"; then
    break
  fi
  RETRY=$((RETRY + 1))
  if [ $RETRY -lt $MAX_RETRIES ]; then
    echo -e "${YELLOW}   ⚠️  下载失败，${RETRY}/${MAX_RETRIES} 次重试...${NC}"
    sleep 2
  fi
done

if [ ! -f "$TAR_FILE" ] || [ ! -s "$TAR_FILE" ]; then
  echo -e "${RED}❌ 下载失败，请检查网络${NC}"
  exit 1
fi

FILE_SIZE=$(ls -lh "$TAR_FILE" | awk '{print $5}')
echo -e "${GREEN}✅ 下载完成 (${FILE_SIZE})${NC}"

# ─── 6. 解压 ─────────────────────────────────────────────────────────────────
EXTRACT_DIR="$TEMP_DIR/extracted"
mkdir -p "$EXTRACT_DIR"
echo ""
echo -e "${YELLOW}📦 正在解压...${NC}"
tar -xzf "$TAR_FILE" -C "$EXTRACT_DIR"

# 查找解压后的项目根目录（包含 server.js 的目录）
SOURCE_DIR=""
for dir_name in "ScreenSync-Apple" "ScreenSync-Intel"; do
  # 新包结构: ScreenSync-Apple/项目文件/server.js
  if [ -f "$EXTRACT_DIR/$dir_name/项目文件/server.js" ]; then
    SOURCE_DIR="$EXTRACT_DIR/$dir_name/项目文件"
    SOURCE_PACKAGE_DIR="$EXTRACT_DIR/$dir_name"
    break
  fi
  # 也兼容平铺结构: ScreenSync-Apple/server.js
  if [ -f "$EXTRACT_DIR/$dir_name/server.js" ]; then
    SOURCE_DIR="$EXTRACT_DIR/$dir_name"
    SOURCE_PACKAGE_DIR="$EXTRACT_DIR/$dir_name"
    break
  fi
done

if [ -z "$SOURCE_DIR" ]; then
  SOURCE_DIR=$(find "$EXTRACT_DIR" -name "server.js" -maxdepth 4 -exec dirname {} \; | head -1)
  if [ -n "$SOURCE_DIR" ]; then
    SOURCE_PACKAGE_DIR=$(dirname "$SOURCE_DIR")
    # 如果 server.js 直接在解压根目录
    if [ "$SOURCE_PACKAGE_DIR" = "$EXTRACT_DIR" ]; then
      SOURCE_PACKAGE_DIR="$SOURCE_DIR"
    fi
  fi
fi

if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/server.js" ]; then
  echo -e "${RED}❌ 解压后未找到 server.js，请联系开发者${NC}"
  echo "   解压目录内容:"
  ls -la "$EXTRACT_DIR"
  exit 1
fi

echo -e "${GREEN}✅ 解压完成${NC}"

# ─── 6.5 尝试接入胖包 runtime（优先离线运行时）────────────────────────────────
echo ""
echo -e "${YELLOW}🧱 正在检查胖包 runtime...${NC}"
PACKAGE_ROOT_NOW="$(get_package_root_dir)"
TARGET_RUNTIME_ROOT="$PACKAGE_ROOT_NOW/runtime"
SOURCE_RUNTIME_ROOT=""
LEGACY_RUNTIME_ROOT="$(dirname "$SCRIPT_DIR")/runtime"
if [ "$(basename "$SCRIPT_DIR")" != "项目文件" ]; then
  LEGACY_RUNTIME_ROOT=""
fi
for candidate in \
  "$SOURCE_PACKAGE_DIR/runtime" \
  "$SOURCE_DIR/runtime" \
  "$LEGACY_RUNTIME_ROOT"; do
  if [ -d "$candidate/bin" ] || [ -d "$candidate/$RUNTIME_ARCH_DIR/bin" ]; then
    SOURCE_RUNTIME_ROOT="$candidate"
    break
  fi
done

if [ -n "$SOURCE_RUNTIME_ROOT" ]; then
  mkdir -p "$TARGET_RUNTIME_ROOT"
  rsync -a --delete "$SOURCE_RUNTIME_ROOT/" "$TARGET_RUNTIME_ROOT/" 2>/dev/null || true
  echo -e "${GREEN}✅ 已同步离线 runtime 到: $TARGET_RUNTIME_ROOT${NC}"
  if [ "$SOURCE_RUNTIME_ROOT" = "$LEGACY_RUNTIME_ROOT" ] && [ "$LEGACY_RUNTIME_ROOT" != "$TARGET_RUNTIME_ROOT" ]; then
    rm -rf "$LEGACY_RUNTIME_ROOT" 2>/dev/null || true
    echo -e "${GREEN}✅ 已将旧路径 runtime 迁移到项目目录${NC}"
  fi
else
  echo -e "${YELLOW}⚠️  更新包未携带 runtime，将回退本地/在线依赖策略${NC}"
fi
ensure_local_bins_path
if [ "$OFFLINE_RUNTIME_READY" -eq 1 ]; then
  echo -e "${GREEN}✅ 检测到完整胖包运行时（Node/FFmpeg/FFprobe/Gifsicle/ImageMagick）${NC}"
  [ -n "$OFFLINE_RUNTIME_NODE" ] && echo "   • node: $OFFLINE_RUNTIME_NODE"
  [ -n "$OFFLINE_RUNTIME_NPM" ] && echo "   • npm : $OFFLINE_RUNTIME_NPM"
  command -v ffmpeg >/dev/null 2>&1 && echo "   • ffmpeg: $(command -v ffmpeg)"
  command -v ffprobe >/dev/null 2>&1 && echo "   • ffprobe: $(command -v ffprobe)"
  command -v gifsicle >/dev/null 2>&1 && echo "   • gifsicle: $(command -v gifsicle)"
  command -v magick >/dev/null 2>&1 && echo "   • magick: $(command -v magick)"
else
  echo -e "${YELLOW}⚠️  未检测到完整胖包运行时，后续按缺失依赖补装${NC}"
fi

# ─── 7. 备份现有文件 ──────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}💾 正在备份现有文件...${NC}"
mkdir -p "$BACKUP_DIR"

# 备份整个项目目录（排除 node_modules 和缓存）
rsync -a --exclude 'node_modules' --exclude '.gif-cache' \
  --exclude 'ScreenSyncImg' --exclude '.emergency-backup-*' \
  "$SCRIPT_DIR/" "$BACKUP_DIR/" 2>/dev/null || true

OLD_VERSION="未知"
if [ -f "$BACKUP_DIR/VERSION.txt" ]; then
  OLD_VERSION=$(cat "$BACKUP_DIR/VERSION.txt" | tr -d '[:space:]')
fi

echo -e "${GREEN}✅ 备份完成 → ${BACKUP_DIR}${NC}"

# ─── 8. 清理老旧文件 ─────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🧹 正在清理老旧文件...${NC}"

CLEANED=0

# 8a. 清理项目目录内不再需要的老代码文件
OLD_FILES=(
  "第一步_拖进终端回车运行.command"
  "Developer_清除隔离.command"
  "package-icloud.sh"
  "set-version.sh"
  "aliyunOSS.js"
  "aliyun-watcher.js"
)
for old_file in "${OLD_FILES[@]}"; do
  if [ -f "$SCRIPT_DIR/$old_file" ]; then
    rm -f "$SCRIPT_DIR/$old_file"
    echo "   🗑️  删除: $old_file"
    CLEANED=$((CLEANED + 1))
  fi
done

# 8b. 清理项目目录内不再需要的老目录
OLD_DIRS=(
  ".backup-before-revert"
  "docs"
  "备用"
  ".plugin-update"
  ".server-update"
  ".full-update"
  ".plugin-backup"
  ".server-backup"
  ".full-backup"
)
for old_dir in "${OLD_DIRS[@]}"; do
  if [ -d "$SCRIPT_DIR/$old_dir" ]; then
    rm -rf "$SCRIPT_DIR/$old_dir"
    echo "   🗑️  删除目录: $old_dir/"
    CLEANED=$((CLEANED + 1))
  fi
done

# 8c. 清理老旧的 .command 文件和打包产物
find "$SCRIPT_DIR" -maxdepth 1 -name "*.command" -delete 2>/dev/null && CLEANED=$((CLEANED + 1)) || true
find "$SCRIPT_DIR" -maxdepth 1 -name "*.tar.gz" -delete 2>/dev/null || true
find "$SCRIPT_DIR" -maxdepth 1 -name "*.backup.js" -delete 2>/dev/null || true

# 8d. 清理安装包根目录（项目文件的父目录）的老文件
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_BASENAME="$(basename "$PACKAGE_ROOT")"

# 只在确认是安装包结构时清理父目录（父目录名含 ScreenSync 或 UserPackage）
if echo "$PACKAGE_BASENAME" | grep -qiE 'screensync|userpackage|figma'; then
  echo "   📂 检测到安装包根目录: $PACKAGE_ROOT"
  
  # 清理安装包根目录的老文件
  PACKAGE_OLD_FILES=(
    "第一步_拖进终端回车运行.command"
    "Developer_清除隔离.command"
  )
  for old_file in "${PACKAGE_OLD_FILES[@]}"; do
    if [ -f "$PACKAGE_ROOT/$old_file" ]; then
      rm -f "$PACKAGE_ROOT/$old_file"
      echo "   🗑️  删除安装包根: $old_file"
      CLEANED=$((CLEANED + 1))
    fi
  done
  find "$PACKAGE_ROOT" -maxdepth 1 -name "*.command" -delete 2>/dev/null || true

  # 复制新的安装包根文件（README 等）
  if [ -f "$SOURCE_PACKAGE_DIR/README_请先阅读.txt" ]; then
    cp "$SOURCE_PACKAGE_DIR/README_请先阅读.txt" "$PACKAGE_ROOT/" 2>/dev/null || true
    echo "   📄 更新: README_请先阅读.txt"
  fi
fi

if [ $CLEANED -gt 0 ]; then
  echo -e "${GREEN}✅ 已清理 ${CLEANED} 个老旧文件/目录${NC}"
else
  echo -e "${GREEN}✅ 无需清理${NC}"
fi

# ─── 9. 同步更新所有代码文件 ─────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🚀 正在同步最新代码文件...${NC}"

UPDATED=0

if [ -f "$SOURCE_DIR/update-manifest.json" ]; then
  MANIFEST_FILES=$(python3 -c "
import json
m = json.load(open('$SOURCE_DIR/update-manifest.json'))
for f in m.get('files', []):
    print(f)
")
  for file in $MANIFEST_FILES; do
    src="$SOURCE_DIR/$file"
    dest="$SCRIPT_DIR/$file"
    if [ -f "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      cp "$src" "$dest"
      UPDATED=$((UPDATED + 1))
    fi
  done
else
  cd "$SOURCE_DIR"
  find . -type f ! -name ".*" ! -path "*/node_modules/*" ! -path "*/.git/*" | while read -r file; do
    rel_path="${file#./}"
    src="$SOURCE_DIR/$rel_path"
    dest="$SCRIPT_DIR/$rel_path"
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  done
  UPDATED=$(find . -type f ! -name ".*" ! -path "*/node_modules/*" ! -path "*/.git/*" | wc -l | tr -d ' ')
  cd "$SCRIPT_DIR"
fi

# 反向清理：删除本地存在但新版本中不存在的代码文件（精确同步）
if [ -f "$SOURCE_DIR/update-manifest.json" ]; then
  echo ""
  echo -e "${YELLOW}🔍 正在检查多余的旧代码文件...${NC}"
  EXTRA_REMOVED=0

  # 获取新版本的文件清单
  MANIFEST_SET="$TEMP_DIR/manifest_set.txt"
  python3 -c "
import json
m = json.load(open('$SOURCE_DIR/update-manifest.json'))
for f in m.get('files', []):
    print(f)
" > "$MANIFEST_SET"

  # 检查本地的 .js 文件（根目录）
  for local_file in "$SCRIPT_DIR"/*.js; do
    [ -f "$local_file" ] || continue
    basename_file="$(basename "$local_file")"
    # 跳过不在清单中但属于运行时生成的文件
    if echo "$basename_file" | grep -qE '^(serviceAccountKey|\.)'  ; then
      continue
    fi
    if ! grep -qx "$basename_file" "$MANIFEST_SET" 2>/dev/null; then
      # 不在新版本清单中，但可能是用户自定义文件，只删已知过时的
      case "$basename_file" in
        aliyunOSS.js|aliyun-watcher.js)
          rm -f "$local_file"
          echo "   🗑️  删除多余代码: $basename_file"
          EXTRA_REMOVED=$((EXTRA_REMOVED + 1))
          ;;
      esac
    fi
  done

  if [ $EXTRA_REMOVED -gt 0 ]; then
    echo -e "${GREEN}✅ 已清理 ${EXTRA_REMOVED} 个多余的旧代码文件${NC}"
  else
    echo -e "${GREEN}✅ 无多余文件${NC}"
  fi
fi

echo -e "${GREEN}✅ 已同步 ${UPDATED} 个代码文件${NC}"

# 同步胖包内置 node_modules（若存在），避免每次都全量 npm install
if [ -d "$SOURCE_DIR/node_modules" ]; then
  echo ""
  echo -e "${YELLOW}📚 正在同步内置 Node.js 依赖（node_modules）...${NC}"
  mkdir -p "$SCRIPT_DIR/node_modules"
  rsync -a --delete "$SOURCE_DIR/node_modules/" "$SCRIPT_DIR/node_modules/" 2>/dev/null || true
  strip_packaged_sharp_artifacts "$SCRIPT_DIR"
  echo -e "${GREEN}✅ 已同步内置 node_modules${NC}"
fi

# 关键文件兜底校验：确保最新必需代码一定落地（防止旧包/异常同步导致缺失）
echo ""
echo -e "${YELLOW}🧩 正在校验关键必需文件...${NC}"
REQUIRED_FILES=(
  "server.js"
  "start.js"
  "setup-autostart.js"
  "drive-watcher.js"
  "icloud-watcher.js"
  "gif-composer.js"
  "adaptive-processing.js"
  "media-processing-tuning.js"
  "figma-plugin/manifest.json"
  "update-manifest.json"
  "README.md"
)

MISSING_REQUIRED=0
for req in "${REQUIRED_FILES[@]}"; do
  src="$SOURCE_DIR/$req"
  dest="$SCRIPT_DIR/$req"
  if [ ! -f "$dest" ]; then
    if [ -f "$src" ]; then
      mkdir -p "$(dirname "$dest")"
      cp "$src" "$dest"
      echo "   ♻️  已补齐: $req"
    fi
  fi
  if [ ! -f "$dest" ]; then
    echo "   ❌ 缺失必需文件: $req"
    MISSING_REQUIRED=1
  fi
done

if [ "$MISSING_REQUIRED" -ne 0 ]; then
  echo -e "${RED}❌ 更新包不完整或同步异常：关键必需文件缺失，已中止更新${NC}"
  echo "   请重新下载最新安装包后重试，或联系开发者。"
  exit 1
fi
echo -e "${GREEN}✅ 关键必需文件校验通过${NC}"

# ─── 10. 安装包目录重命名 ────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}📁 检查安装包目录名称...${NC}"

PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
PACKAGE_BASENAME="$(basename "$PACKAGE_ROOT")"
PACKAGE_PARENT="$(dirname "$PACKAGE_ROOT")"
RENAMED=false

# 检查是否需要重命名（老名称 → 新架构名称）
if echo "$PACKAGE_BASENAME" | grep -qiE 'userpackage'; then
  NEW_PACKAGE_PATH="$PACKAGE_PARENT/$NEW_PACKAGE_NAME"

  if [ -d "$NEW_PACKAGE_PATH" ]; then
    echo -e "${YELLOW}⚠️  目标目录已存在: $NEW_PACKAGE_PATH${NC}"
    echo "   跳过重命名，当前目录继续使用"
  else
    echo "   重命名: $PACKAGE_BASENAME → $NEW_PACKAGE_NAME"
    mv "$PACKAGE_ROOT" "$NEW_PACKAGE_PATH"
    RENAMED=true
    PACKAGE_ROOT="$NEW_PACKAGE_PATH"

    # 更新 SCRIPT_DIR 指向新路径
    if [ "$(basename "$SCRIPT_DIR")" = "项目文件" ]; then
      SCRIPT_DIR="$NEW_PACKAGE_PATH/项目文件"
    else
      SCRIPT_DIR="$NEW_PACKAGE_PATH"
    fi

    echo -e "${GREEN}✅ 安装包已重命名为: $NEW_PACKAGE_NAME${NC}"
  fi
else
  echo -e "${GREEN}✅ 目录名称正常，无需重命名${NC}"
fi

# ─── 11. 安装/更新 Node.js 依赖 ──────────────────────────────────────────────
echo ""
echo -e "${YELLOW}📦 正在安装 Node.js 依赖...${NC}"

NODE_BIN="$(resolve_node_bin || true)"
NPM_BIN="$(resolve_npm_bin || true)"

if [ -n "$NODE_BIN" ] && [ -z "$NPM_BIN" ]; then
  echo -e "${YELLOW}   ⚠️  检测到 Node 但未检测到 npm，正在尝试自动修复...${NC}"
  if ensure_npm_from_node "$NODE_BIN"; then
    NPM_BIN="$(resolve_npm_bin || true)"
  fi
fi

if [ -n "$NODE_BIN" ] && [ -z "$NPM_BIN" ]; then
  echo -e "${YELLOW}   ↪️  本地 Node 缺少 npm，正在下载完整 Node 运行时（含 npm）...${NC}"
  if install_local_node_with_npm_fallback; then
    NODE_BIN="$(resolve_node_bin || true)"
    NPM_BIN="$(resolve_npm_bin || true)"
  fi
fi

if [ -n "$NODE_BIN" ]; then
  echo "   Node: $NODE_BIN"
fi
if [ -n "$NPM_BIN" ]; then
  echo "   npm : $NPM_BIN"
fi

if [ -n "$NPM_BIN" ]; then
  if [ -n "$NODE_BIN" ] && has_required_node_modules "$NODE_BIN" "$SCRIPT_DIR"; then
    if check_sharp_runtime_health "$NODE_BIN" "$SCRIPT_DIR"; then
      echo -e "${GREEN}✅ Node.js 依赖已完整，跳过 npm 安装${NC}"
    else
      echo -e "${YELLOW}⚠️  检测到 sharp 与当前系统架构不兼容，执行自动修复...${NC}"
      if repair_sharp_for_current_arch "$NODE_BIN" "$NPM_BIN" "$SCRIPT_DIR"; then
        echo -e "${GREEN}✅ sharp 已修复，跳过全量 npm 安装${NC}"
      else
        echo -e "${YELLOW}⚠️  sharp 自动修复失败，改为执行全量 npm 安装...${NC}"
        cd "$SCRIPT_DIR"
        "$NPM_BIN" install --production --omit=dev --legacy-peer-deps
      fi
    fi
  else
    cd "$SCRIPT_DIR"
    "$NPM_BIN" install --production --omit=dev --legacy-peer-deps
  fi
  if ! check_sharp_runtime_health "$NODE_BIN" "$SCRIPT_DIR"; then
    echo -e "${YELLOW}⚠️  npm 安装后 sharp 仍不可用，正在进行架构定向修复...${NC}"
    if ! repair_sharp_for_current_arch "$NODE_BIN" "$NPM_BIN" "$SCRIPT_DIR"; then
      echo -e "${RED}❌ sharp 修复失败（当前架构: darwin-$(get_host_npm_cpu)）${NC}"
      echo "   请检查网络后重试 emergency-update.sh。"
      exit 1
    fi
  fi
  echo -e "${GREEN}✅ Node.js 依赖安装完成${NC}"
else
  if [ -n "$NODE_BIN" ] && has_required_node_modules "$NODE_BIN" "$SCRIPT_DIR"; then
    if check_sharp_runtime_health "$NODE_BIN" "$SCRIPT_DIR"; then
      echo -e "${YELLOW}⚠️  未找到 npm，但检测到依赖已就绪，跳过安装步骤${NC}"
    else
      echo -e "${RED}❌ 未找到 npm，且 sharp 与当前系统架构不兼容，无法自动修复${NC}"
      echo "   请先补齐 npm（或运行安装器）后重试。"
      exit 1
    fi
  else
    echo -e "${RED}❌ 未找到 npm，且依赖不完整，无法继续${NC}"
    echo "   已尝试本地自动修复（含下载完整 Node+npm）仍失败。"
    echo "   请检查网络后重试，或手动安装 Node LTS（建议 20.x）后重试。"
    exit 1
  fi
fi

# ─── 12. 检查系统依赖（快速模式，绝不阻塞更新）──────────────────────────────
echo ""
echo -e "${YELLOW}🔍 正在检查系统依赖...${NC}"
ensure_local_bins_path

if [ "$OFFLINE_RUNTIME_READY" -eq 1 ]; then
  if verify_imagemagick_health quick 2>/dev/null && verify_imagemagick_health 2>/dev/null; then
    echo -e "${GREEN}✅ 已启用胖包 runtime，跳过系统依赖在线安装${NC}"
    echo "   Node     : $OFFLINE_RUNTIME_NODE"
    echo "   npm      : $OFFLINE_RUNTIME_NPM"
    if command -v ffmpeg >/dev/null 2>&1; then
      echo "   ffmpeg   : $(command -v ffmpeg)"
    fi
    if command -v gifsicle >/dev/null 2>&1; then
      echo "   gifsicle : $(command -v gifsicle)"
    fi
    if command -v magick >/dev/null 2>&1; then
      echo "   magick   : $(command -v magick)"
    fi
  else
    echo -e "${YELLOW}⚠️  runtime 中 ImageMagick 健康检查失败，改为执行依赖修复${NC}"
    OFFLINE_RUNTIME_READY=0
  fi
fi

if [ "$OFFLINE_RUNTIME_READY" -ne 1 ]; then

check_dep_quick() {
  local cmd="$1"
  if [ "$cmd" = "magick" ]; then
    verify_imagemagick_health quick 2>/dev/null
  else
    command -v "$cmd" &>/dev/null
  fi
}

try_install_dep() {
  local dep="$1"
  case "$dep" in
    ffmpeg)      install_ffmpeg_fallback ;;
    gifsicle)    install_gifsicle_fallback ;;
    imagemagick) install_imagemagick_fallback ;;
  esac
}

MISSING_DEPS=""
for cmd in ffmpeg gifsicle magick; do
  printf "   检查 %-12s " "$cmd"
  if check_dep_quick "$cmd"; then
    echo -e "${GREEN}✅${NC}"
  else
    echo -e "${YELLOW}缺失${NC}"
    case "$cmd" in
      magick) MISSING_DEPS="$MISSING_DEPS imagemagick" ;;
      *)      MISSING_DEPS="$MISSING_DEPS $cmd" ;;
    esac
  fi
done

if [ -n "$MISSING_DEPS" ]; then
  echo -e "${YELLOW}⚠️  缺少:${MISSING_DEPS}${NC}"

  # 尝试 Homebrew（带 5 分钟总超时）
  if command -v brew &>/dev/null; then
    echo -e "${YELLOW}📦 Homebrew 安装（最多 5 分钟）...${NC}"
    set +e
    timeout_cmd 300 brew install $MISSING_DEPS 2>&1 | tail -10
    set -e
    ensure_local_bins_path
  fi

  # 复检 + 本地兜底（每个依赖独立处理）
  STILL_MISSING=""
  MAGICK_SKIPPED="0"
  for dep in $MISSING_DEPS; do
    dep_cmd="$dep"
    [ "$dep" = "imagemagick" ] && dep_cmd="magick"

    # 对 ImageMagick 先做一次深度检测，避免“快速检测误判”导致重复下载/安装。
    if [ "$dep" = "imagemagick" ] && check_dep_quick "magick"; then
      set +e
      if verify_imagemagick_health; then
        echo -e "   ${GREEN}✅ $dep 已可用（深度检测通过）${NC}"
        set -e
        continue
      fi
      set -e
    fi

    if ! check_dep_quick "$dep_cmd"; then
      echo "   ↪️  本地安装 $dep ..."
      set +e
      if try_install_dep "$dep"; then
        ensure_local_bins_path
        if check_dep_quick "$dep_cmd"; then
          echo -e "   ${GREEN}✅ $dep 安装成功${NC}"
        else
          if [ "$dep" = "imagemagick" ] && [ "${ALLOW_SKIP_MAGICK_ON_FAILURE:-0}" = "1" ]; then
            MAGICK_SKIPPED="1"
            echo -e "   ${YELLOW}⚠️  $dep 仍不可用，已按策略跳过（后续 GIF 将回退 FFmpeg）${NC}"
          else
            STILL_MISSING="$STILL_MISSING $dep"
          fi
        fi
      else
        if [ "$dep" = "imagemagick" ] && [ "${ALLOW_SKIP_MAGICK_ON_FAILURE:-0}" = "1" ]; then
          MAGICK_SKIPPED="1"
          echo -e "   ${YELLOW}⚠️  $dep 安装失败，已按策略跳过（后续 GIF 将回退 FFmpeg）${NC}"
        else
          STILL_MISSING="$STILL_MISSING $dep"
        fi
      fi
      set -e
    else
      echo -e "   ${GREEN}✅ $dep 已可用${NC}"
    fi
  done

  if [ -z "$STILL_MISSING" ]; then
    if [ "$MAGICK_SKIPPED" = "1" ]; then
      echo -e "${YELLOW}⚠️  ImageMagick 已跳过，其它系统依赖已补齐${NC}"
      echo "   可稍后单独修复：ENABLE_IMAGEMAGICK_SOURCE_BUILD=1 bash $0"
    else
      echo -e "${GREEN}✅ 系统依赖已补齐${NC}"
    fi
  else
    echo -e "${YELLOW}⚠️  以下依赖安装失败（不阻塞更新，运行时有兜底）:${STILL_MISSING}${NC}"
    echo "   GIF 导出会自动回退 FFmpeg，功能基本不受影响。"
  fi
else
  echo -e "${GREEN}✅ 系统依赖完整${NC}"
fi
fi

# ─── 12.5 最终 ImageMagick 硬校验（默认强制）──────────────────────────────────
if [ "${ALLOW_SKIP_MAGICK_ON_FAILURE:-0}" = "1" ]; then
  echo -e "${YELLOW}⚠️  已启用 ALLOW_SKIP_MAGICK_ON_FAILURE=1，跳过最终 ImageMagick 硬校验${NC}"
else
  echo ""
  echo -e "${YELLOW}🧪 正在执行最终 ImageMagick 硬校验...${NC}"
  ensure_local_bins_path
  if verify_imagemagick_health; then
    echo -e "${GREEN}✅ ImageMagick 最终校验通过${NC}"
  else
    echo -e "${RED}❌ ImageMagick 最终校验失败：更新已中止，避免出现“更新成功但导出失败”${NC}"
    echo "   当前命令解析："
    command -v magick >/dev/null 2>&1 && echo "   • magick : $(command -v magick)" || echo "   • magick : 未找到"
    command -v convert >/dev/null 2>&1 && echo "   • convert: $(command -v convert)" || echo "   • convert: 未找到"
    command -v identify >/dev/null 2>&1 && echo "   • identify: $(command -v identify)" || echo "   • identify: 未找到"
    echo "   请重新运行 emergency-update.sh，或改用安装器完整安装。"
    exit 1
  fi
fi

# ─── 13. 更新 launchd 服务配置 ───────────────────────────────────────────────
echo ""
echo -e "${YELLOW}🔄 正在更新开机自启动配置...${NC}"

PLIST_PATH="$HOME/Library/LaunchAgents/com.screensync.server.plist"

if [ -f "$PLIST_PATH" ] && [ "$RENAMED" = true ]; then
  # 目录已重命名，需要更新 plist 中的路径
  echo "   更新 launchd plist 中的路径..."

  # 用 node 安全地重写 plist（避免 sed 处理 XML 的问题）
  node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$PLIST_PATH', 'utf8');
    // 替换所有旧路径引用为新路径
    const oldPatterns = [
      /ScreenSync[-_]?UserPackage/gi,
      /FigmaSync[-_]?UserPackage/gi
    ];
    for (const pat of oldPatterns) {
      content = content.replace(pat, '$NEW_PACKAGE_NAME');
    }
    fs.writeFileSync('$PLIST_PATH', content, 'utf8');
    console.log('   ✅ plist 路径已更新');
  " 2>/dev/null || echo "   ⚠️  plist 更新失败，将重新生成"
fi

# 如果可用 node 且有 setup-autostart.js，重新注册 launchd 以确保路径正确
if [ -n "$NODE_BIN" ] && [ -f "$SCRIPT_DIR/setup-autostart.js" ]; then
  echo "   重新注册 launchd 服务..."
  "$NODE_BIN" "$SCRIPT_DIR/setup-autostart.js" "$SCRIPT_DIR" 2>/dev/null || true
  echo -e "${GREEN}✅ 开机自启动已更新${NC}"
else
  echo -e "${YELLOW}⚠️  未找到可用 Node，跳过 setup-autostart 重新注册${NC}"
fi

# ─── 13.5 确认启动入口 ───────────────────────────────────────────────────────
START_ENTRY=""
if [ -f "$SCRIPT_DIR/start.js" ]; then
  START_ENTRY="start.js"
elif [ -f "$SCRIPT_DIR/server.js" ]; then
  START_ENTRY="server.js"
else
  echo -e "${RED}❌ 更新后未找到启动文件（start.js/server.js）${NC}"
  exit 1
fi

# ─── 14. 显示更新结果 ────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"

NEW_VERSION="未知"
if [ -f "$SCRIPT_DIR/VERSION.txt" ]; then
  NEW_VERSION=$(cat "$SCRIPT_DIR/VERSION.txt" | tr -d '[:space:]')
fi

echo -e "${GREEN}✅ 更新完成！${NC}"
echo ""
echo -e "   旧版本: ${RED}${OLD_VERSION}${NC}"
echo -e "   新版本: ${GREEN}${NEW_VERSION}${NC}"
if [ "$RENAMED" = true ]; then
  echo -e "   安装包: ${GREEN}已重命名为 ${NEW_PACKAGE_NAME}${NC}"
fi
echo -e "   项目路径: ${GREEN}${SCRIPT_DIR}${NC}"
echo -e "   备份位置: ${BACKUP_DIR}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""

# ─── 15. 重启服务器 ──────────────────────────────────────────────────────────
echo -e "${YELLOW}🔄 正在启动服务器...${NC}"

if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN="$(resolve_node_bin || true)"
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo -e "${RED}❌ 未找到可用 Node.js，无法启动服务器${NC}"
  exit 1
fi

PLIST_PATH="$HOME/Library/LaunchAgents/com.screensync.server.plist"
if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  sleep 1
  if launchctl load "$PLIST_PATH" 2>/dev/null; then
    sleep 2
    if launchctl list | grep -q "com.screensync.server"; then
      echo -e "${GREEN}✅ 服务器已通过 launchd 重启${NC}"
    else
      echo -e "${YELLOW}⚠️  launchd 已加载但服务未出现，改用直接启动${NC}"
      cd "$SCRIPT_DIR"
      nohup "$NODE_BIN" "$START_ENTRY" > /tmp/screensync-server.log 2>/tmp/screensync-server-error.log &
      SERVER_PID="$!"
      sleep 2
      if kill -0 "$SERVER_PID" 2>/dev/null; then
        echo -e "${GREEN}✅ 服务器已启动 (PID: $SERVER_PID, 入口: $START_ENTRY)${NC}"
      else
        echo -e "${RED}❌ 服务器启动失败，请检查日志或手动运行: node $START_ENTRY${NC}"
        print_startup_logs
        exit 1
      fi
    fi
  else
    echo -e "${YELLOW}⚠️  launchd 重启失败，改用直接启动${NC}"
    cd "$SCRIPT_DIR"
    nohup "$NODE_BIN" "$START_ENTRY" > /tmp/screensync-server.log 2>/tmp/screensync-server-error.log &
    SERVER_PID="$!"
    sleep 2
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      echo -e "${GREEN}✅ 服务器已启动 (PID: $SERVER_PID, 入口: $START_ENTRY)${NC}"
    else
      echo -e "${RED}❌ 服务器启动失败，请检查日志或手动运行: node $START_ENTRY${NC}"
      print_startup_logs
      exit 1
    fi
  fi
else
  cd "$SCRIPT_DIR"
  nohup "$NODE_BIN" "$START_ENTRY" > /tmp/screensync-server.log 2>/tmp/screensync-server-error.log &
  SERVER_PID="$!"
  sleep 2
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${GREEN}✅ 服务器已启动 (PID: $SERVER_PID, 入口: $START_ENTRY)${NC}"
  else
    echo -e "${RED}❌ 服务器启动失败，请检查日志或手动运行: node $START_ENTRY${NC}"
    print_startup_logs
    exit 1
  fi
fi

# 最终端口兜底校验，避免“进程存在但 8888 未监听”
sleep 1
if ! lsof -i :8888 -sTCP:LISTEN >/dev/null 2>&1; then
  echo -e "${RED}❌ 服务器进程已启动但 8888 端口未监听${NC}"
  print_startup_logs
  exit 1
fi

echo ""
echo -e "${GREEN}🎉 全部完成！请回到 Figma 插件，功能已恢复到最新版本。${NC}"
echo -e "${GREEN}   之后的版本更新可以直接在插件内一键完成。${NC}"
echo ""
