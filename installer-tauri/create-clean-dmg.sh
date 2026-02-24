#!/bin/bash
# Create a clean DMG containing ONLY the installer app (no Applications folder).
# Usage: ./create-clean-dmg.sh <path-to-.app> <output.dmg> [background.png]
#
# This replaces Tauri's built-in DMG bundler to give us full control over layout.

set -euo pipefail

APP_PATH="$1"
OUTPUT_DMG="$2"
BG_IMAGE="${3:-src-tauri/dmg-resources/background.png}"
VOL_NAME="ScreenSync Installer"
DMG_SIZE="200m"

APP_NAME=$(basename "$APP_PATH")

if [ ! -d "$APP_PATH" ]; then
    echo "Error: $APP_PATH not found"
    exit 1
fi

echo "Creating clean DMG: $OUTPUT_DMG"

# ── 1. Create a temporary read-write DMG ──
TEMP_DMG="/tmp/screensync_rw_$$.dmg"
rm -f "$TEMP_DMG"
hdiutil create -size "$DMG_SIZE" -fs HFS+ -volname "$VOL_NAME" -ov "$TEMP_DMG"

# ── 2. Mount it ──
MOUNT_DIR="/Volumes/$VOL_NAME"
# Detach if already mounted from a prior failed run
hdiutil detach "$MOUNT_DIR" 2>/dev/null || true
hdiutil attach "$TEMP_DMG" -readwrite -noverify -noautoopen
if [ ! -d "$MOUNT_DIR" ]; then
    echo "Error: mount point $MOUNT_DIR does not exist"
    exit 1
fi
echo "Mounted at: $MOUNT_DIR"

# ── 3. Copy the .app and ad-hoc sign it ──
# Ad-hoc signing is CRITICAL: without it macOS reports "damaged" and the app
# cannot be opened at all (no "Open Anyway" in System Settings either).
# With ad-hoc signing the error changes to "cannot verify developer" and
# System Settings → Privacy & Security shows the "Open Anyway" button.
cp -R "$APP_PATH" "$MOUNT_DIR/"
echo "Ad-hoc signing the app..."
codesign --sign - --force --deep "$MOUNT_DIR/$APP_NAME"
echo "   ✅ App signed (ad-hoc)"

# ── 4. Copy background image into a hidden folder ──
mkdir -p "$MOUNT_DIR/.background"
cp "$BG_IMAGE" "$MOUNT_DIR/.background/background.png"

# ── 5. Set DMG window properties via AppleScript ──
# Use multiple retries because Finder can be slow to recognize the volume
sleep 1
osascript <<'APPLESCRIPT'
tell application "Finder"
    set volName to "ScreenSync Installer"
    tell disk volName
        open
        delay 2
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 200, 860, 600}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 96
        try
            set background picture of viewOptions to file ".background:background.png"
        end try
        delay 1
        close
        open
        delay 1
        try
            set background picture of the icon view options of container window to file ".background:background.png"
        end try
    end tell
    -- Position the app icon in center
    try
        set position of item "ScreenSync Installer.app" of disk volName to {330, 210}
    end try
    delay 0.5
    tell disk volName
        close
    end tell
end tell
APPLESCRIPT
echo "   ✅ DMG window configured"

# ── 6. Finalize: set permissions, unmount ──
chmod -Rf go-w "$MOUNT_DIR" 2>/dev/null || true
sync
sleep 1
hdiutil detach "$MOUNT_DIR"

# ── 7. Convert to compressed read-only DMG ──
rm -f "$OUTPUT_DMG"
hdiutil convert "$TEMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUTPUT_DMG"
rm -f "$TEMP_DMG"

echo "✅ Created: $OUTPUT_DMG"
ls -lh "$OUTPUT_DMG"
