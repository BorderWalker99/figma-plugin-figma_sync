#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_ARCH="${1:-all}" # intel | apple | all

INTEL_BIN="$ROOT_DIR/runtime/intel/bin"
APPLE_BIN="$ROOT_DIR/runtime/apple/bin"

mkdir -p "$INTEL_BIN" "$APPLE_BIN"

pick_bin() {
  local name="$1"
  shift || true
  for p in "$@"; do
    if [ -n "${p:-}" ] && [ -x "$p" ]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

copy_one() {
  local src="$1"
  local dst="$2"
  if [ -x "$src" ]; then
    cp "$src" "$dst"
    chmod +x "$dst"
    echo "   ✅ $(basename "$dst") <= $src"
    return 0
  fi
  return 1
}

is_arch_compatible() {
  local bin_path="$1"
  local target_arch="$2" # intel | apple
  if [ ! -x "$bin_path" ]; then
    return 1
  fi
  local info
  info="$(file "$bin_path" 2>/dev/null || true)"
  if [ "$target_arch" = "intel" ]; then
    echo "$info" | grep -q "x86_64" && return 0
    return 1
  fi
  if [ "$target_arch" = "apple" ]; then
    echo "$info" | grep -q "arm64" && return 0
    return 1
  fi
  return 1
}

copy_one_for_arch() {
  local src="$1"
  local dst="$2"
  local target_arch="$3"
  if ! is_arch_compatible "$src" "$target_arch"; then
    return 1
  fi
  copy_one "$src" "$dst"
}

fill_arch() {
  local arch="$1"
  local out_dir="$2"
  echo ""
  echo "== Preparing $arch runtime =="

  local node_bin npm_bin npx_bin ffmpeg_bin ffprobe_bin gifsicle_bin magick_bin convert_bin

  node_bin="$(pick_bin node \
    "$HOME/.screensync/deps/node/bin/node" \
    "/usr/local/bin/node" \
    "/opt/homebrew/bin/node" \
    "$(command -v node 2>/dev/null || true)")" || true

  npm_bin="$(pick_bin npm \
    "$HOME/.screensync/deps/node/bin/npm" \
    "$HOME/.screensync/bin/npm" \
    "/usr/local/bin/npm" \
    "/opt/homebrew/bin/npm" \
    "$(command -v npm 2>/dev/null || true)")" || true

  npx_bin="$(pick_bin npx \
    "$HOME/.screensync/deps/node/bin/npx" \
    "$HOME/.screensync/bin/npx" \
    "/usr/local/bin/npx" \
    "/opt/homebrew/bin/npx" \
    "$(command -v npx 2>/dev/null || true)")" || true

  ffmpeg_bin="$(pick_bin ffmpeg \
    "$HOME/.screensync/bin/ffmpeg" \
    "/usr/local/bin/ffmpeg" \
    "/opt/homebrew/bin/ffmpeg" \
    "$(command -v ffmpeg 2>/dev/null || true)")" || true

  ffprobe_bin="$(pick_bin ffprobe \
    "$HOME/.screensync/bin/ffprobe" \
    "/usr/local/bin/ffprobe" \
    "/opt/homebrew/bin/ffprobe" \
    "$(command -v ffprobe 2>/dev/null || true)")" || true

  gifsicle_bin="$(pick_bin gifsicle \
    "$HOME/.screensync/bin/gifsicle" \
    "/usr/local/bin/gifsicle" \
    "/opt/homebrew/bin/gifsicle" \
    "$(command -v gifsicle 2>/dev/null || true)")" || true

  magick_bin="$(pick_bin magick \
    "$HOME/.screensync/bin/magick" \
    "/usr/local/bin/magick" \
    "/opt/homebrew/bin/magick" \
    "$(command -v magick 2>/dev/null || true)")" || true

  convert_bin="$(pick_bin convert \
    "$HOME/.screensync/bin/convert" \
    "/usr/local/bin/convert" \
    "/opt/homebrew/bin/convert" \
    "$(command -v convert 2>/dev/null || true)")" || true

  [ -n "${node_bin:-}" ] && copy_one_for_arch "$node_bin" "$out_dir/node" "$arch" || true
  [ -n "${npm_bin:-}" ] && copy_one "$npm_bin" "$out_dir/npm" || true
  [ -n "${npx_bin:-}" ] && copy_one "$npx_bin" "$out_dir/npx" || true
  [ -n "${ffmpeg_bin:-}" ] && copy_one_for_arch "$ffmpeg_bin" "$out_dir/ffmpeg" "$arch" || true
  [ -n "${ffprobe_bin:-}" ] && copy_one_for_arch "$ffprobe_bin" "$out_dir/ffprobe" "$arch" || true
  [ -n "${gifsicle_bin:-}" ] && copy_one_for_arch "$gifsicle_bin" "$out_dir/gifsicle" "$arch" || true

  if [ -n "${magick_bin:-}" ]; then
    copy_one_for_arch "$magick_bin" "$out_dir/magick" "$arch" || true
  elif [ -n "${convert_bin:-}" ]; then
    copy_one_for_arch "$convert_bin" "$out_dir/convert" "$arch" || true
  fi

  local missing=0
  [ -x "$out_dir/node" ] || { echo "   ❌ missing: node"; missing=1; }
  [ -x "$out_dir/ffmpeg" ] || { echo "   ❌ missing: ffmpeg"; missing=1; }
  [ -x "$out_dir/gifsicle" ] || { echo "   ❌ missing: gifsicle"; missing=1; }
  if [ ! -x "$out_dir/magick" ] && [ ! -x "$out_dir/convert" ]; then
    echo "   ❌ missing: magick/convert"
    missing=1
  fi

  if [ "$missing" -eq 0 ]; then
    echo "   🎉 $arch runtime is ready."
  else
    echo "   ⚠️  $arch runtime incomplete; please fill missing binaries manually."
  fi
}

case "$TARGET_ARCH" in
  intel)
    fill_arch "intel" "$INTEL_BIN"
    ;;
  apple)
    fill_arch "apple" "$APPLE_BIN"
    ;;
  all)
    fill_arch "intel" "$INTEL_BIN"
    fill_arch "apple" "$APPLE_BIN"
    ;;
  *)
    echo "Usage: bash prepare-offline-runtime.sh [intel|apple|all]"
    exit 1
    ;;
esac

echo ""
echo "Done. Runtime folders:"
echo " - $INTEL_BIN"
echo " - $APPLE_BIN"

