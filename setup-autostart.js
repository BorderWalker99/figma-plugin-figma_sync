#!/usr/bin/env node
/**
 * setup-autostart.js
 * Configure ScreenSync LaunchAgent using Node.js (Electron-like flow).
 *
 * Usage:
 *   node setup-autostart.js <installPath>
 *
 * Output:
 *   JSON only on stdout:
 *   { success: boolean, message?: string, error?: string }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function shQuote(input) {
  return `'${String(input).replace(/'/g, `'\"'\"'`)}'`;
}

function run(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: (out || '').trim() };
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    const stdout = (e.stdout || '').toString().trim();
    const message = stderr || stdout || e.message || 'unknown error';
    return { ok: false, out: message };
  }
}

function sleepSec(sec) {
  run(`sleep ${Math.max(1, sec)}`);
}

function portReady() {
  return run('lsof -i :8888 -sTCP:LISTEN').ok;
}

function buildPlist(nodePath, installPath, comprehensivePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.screensync.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${installPath}/start.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${installPath}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${comprehensivePath}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/screensync-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/screensync-server-error.log</string>
</dict>
</plist>`;
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main() {
  const installPath = process.argv[2];
  if (!installPath || !fs.existsSync(installPath)) {
    output({ success: false, error: `无效安装路径: ${installPath || '(empty)'}` });
    process.exit(1);
  }

  const nodePath = process.execPath;
  const startScript = path.join(installPath, 'start.js');
  if (!fs.existsSync(startScript)) {
    output({ success: false, error: `未找到 start.js: ${startScript}` });
    process.exit(1);
  }

  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir, { recursive: true });

  const plistName = 'com.screensync.server.plist';
  const plistPath = path.join(launchAgentsDir, plistName);
  const templatePath = path.join(installPath, plistName);

  const comprehensivePath = [
    path.join(os.homedir(), '.screensync', 'bin'),
    path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');

  let plistContent = '';
  if (fs.existsSync(templatePath)) {
    plistContent = fs.readFileSync(templatePath, 'utf8')
      .replace(/__NODE_PATH__/g, nodePath)
      .replace(/__INSTALL_PATH__/g, installPath)
      .replace(
        /\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/g,
        comprehensivePath
      );
  } else {
    plistContent = buildPlist(nodePath, installPath, comprehensivePath);
  }

  fs.writeFileSync(plistPath, plistContent, 'utf8');

  // Ensure no stale process keeps port 8888.
  run('lsof -ti :8888 | xargs kill -9 2>/dev/null');
  sleepSec(1);

  const label = 'com.screensync.server';
  const uidRes = run('id -u');
  let loaded = false;

  if (uidRes.ok && uidRes.out) {
    const domain = `gui/${uidRes.out}`;
    run(`launchctl bootout ${domain}/${label} 2>/dev/null`);
    sleepSec(1);
    const bootstrap = run(`launchctl bootstrap ${domain} ${shQuote(plistPath)}`);
    if (bootstrap.ok) {
      run(`launchctl enable ${domain}/${label} 2>/dev/null`);
      run(`launchctl kickstart -k ${domain}/${label} 2>/dev/null`);
      loaded = true;
    }
  }

  if (!loaded) {
    run(`launchctl unload ${shQuote(plistPath)} 2>/dev/null`);
    sleepSec(1);
    const loadRes = run(`launchctl load ${shQuote(plistPath)}`);
    loaded = loadRes.ok;
  }

  if (!loaded) {
    output({ success: false, error: 'LaunchAgent 加载失败（bootstrap/load 均失败）' });
    process.exit(1);
  }

  for (let i = 0; i < 12; i++) {
    sleepSec(1);
    if (portReady()) {
      output({ success: true, message: '服务器已启动并配置为开机自动启动' });
      process.exit(0);
    }
  }

  // Fallback: directly spawn start.js once.
  run(`${shQuote(nodePath)} ${shQuote(startScript)} >/tmp/screensync-server.log 2>/tmp/screensync-server-error.log &`);
  for (let i = 0; i < 5; i++) {
    sleepSec(1);
    if (portReady()) {
      output({ success: true, message: '服务器已启动（直接启动模式），自启动已配置' });
      process.exit(0);
    }
  }

  output({ success: false, error: '自启动已配置，但服务器未成功监听 8888 端口（请查看 /tmp/screensync-server-error.log）' });
  process.exit(1);
}

main();
