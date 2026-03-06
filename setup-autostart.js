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

/**
 * Resolve the Node path that the user would use when running `npm start` manually.
 * Prefer the login shell's `which node` so we match nvm/homebrew in ~/.zshrc.
 * This avoids LaunchAgent using a different node than manual runs (e.g. firewall
 * or native module mismatch).
 */
function resolveNodePath(installPath) {
  const runtimeArch = process.arch === 'arm64' ? 'apple' : 'intel';
  const runtimeNodeCandidates = installPath ? [
    path.join(installPath, 'runtime', runtimeArch, 'node', 'bin', 'node'),
    path.join(installPath, 'runtime', process.arch, 'node', 'bin', 'node'),
    path.join(installPath, 'runtime', 'node', 'bin', 'node'),
    path.join(installPath, 'runtime', runtimeArch, 'bin', 'node'),
    path.join(installPath, 'runtime', process.arch, 'bin', 'node'),
    path.join(installPath, 'runtime', 'bin', 'node')
  ] : [];
  const candidates = [
    ...runtimeNodeCandidates.map((p) => () => (fs.existsSync(p) ? { ok: true, out: p } : { ok: false, out: '' })),
    () => run('bash -l -c "which node"'),
    () => run('bash -c "which node"'),
    () => ({ ok: true, out: process.execPath }),
    () => run('test -x /opt/homebrew/bin/node && echo /opt/homebrew/bin/node'),
    () => run('test -x /usr/local/bin/node && echo /usr/local/bin/node'),
    () => {
      const local = path.join(os.homedir(), '.screensync', 'deps', 'node', 'bin', 'node');
      return fs.existsSync(local) ? { ok: true, out: local } : { ok: false, out: '' };
    },
  ];
  for (const fn of candidates) {
    try {
      const r = fn();
      if (r.ok && r.out && r.out.trim().length > 0) {
        return r.out.trim().split('\n')[0].trim();
      }
    } catch (_) {}
  }
  return process.execPath;
}

/**
 * Unload and remove any old ScreenSync-related LaunchAgents to avoid conflicts
 * with previous Electron installs or stale plists.
 */
function cleanOldLaunchAgents() {
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (!fs.existsSync(agentsDir)) return;

  const uidRes = run('id -u');
  const domain = uidRes.ok && uidRes.out ? `gui/${uidRes.out}` : null;

  const files = fs.readdirSync(agentsDir);
  for (const f of files) {
    if (!f.toLowerCase().includes('screensync')) continue;
    const plistPath = path.join(agentsDir, f);
    if (!fs.statSync(plistPath).isFile()) continue;

    const label = f.replace(/\.plist$/, '');
    run(`launchctl unload ${shQuote(plistPath)} 2>/dev/null`);
    if (domain) {
      run(`launchctl bootout ${domain}/${label} 2>/dev/null`);
    }
    try {
      fs.unlinkSync(plistPath);
    } catch (_) {}
  }
  sleepSec(1);
}

function main() {
  const installPath = process.argv[2];
  if (!installPath || !fs.existsSync(installPath)) {
    output({ success: false, error: `无效安装路径: ${installPath || '(empty)'}` });
    process.exit(1);
  }

  const nodePath = resolveNodePath(installPath);
  const startScript = path.join(installPath, 'start.js');
  if (!fs.existsSync(startScript)) {
    output({ success: false, error: `未找到 start.js: ${startScript}` });
    process.exit(1);
  }

  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgentsDir, { recursive: true });

  // Clean up any old ScreenSync LaunchAgents (e.g. from Electron) to avoid conflicts
  cleanOldLaunchAgents();

  const plistName = 'com.screensync.server.plist';
  const plistPath = path.join(launchAgentsDir, plistName);
  const templatePath = path.join(installPath, plistName);

  const comprehensivePath = [
    path.join(installPath, 'runtime', process.arch, 'node', 'bin'),
    path.join(installPath, 'runtime', process.arch, 'bin'),
    path.join(installPath, 'runtime', process.arch === 'arm64' ? 'apple' : 'intel', 'node', 'bin'),
    path.join(installPath, 'runtime', process.arch === 'arm64' ? 'apple' : 'intel', 'bin'),
    path.join(installPath, 'runtime', 'node', 'bin'),
    path.join(installPath, 'runtime', 'bin'),
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

  const label = 'com.screensync.server';
  const uidRes = run('id -u');
  let loaded = false;

  // Re-enable the label in case a previous install disabled it
  if (uidRes.ok && uidRes.out) {
    const domain = `gui/${uidRes.out}`;
    run(`launchctl enable ${domain}/${label} 2>/dev/null`);
  }

  // Kill any stale server so the LaunchAgent can start cleanly (no port conflict)
  run('lsof -ti :8888 | xargs kill -9 2>/dev/null');
  sleepSec(1);

  // Clear old log files so diagnostic only shows errors from this run
  const logPaths = [
    path.join(installPath, 'server.log'),
    path.join(installPath, 'server-error.log'),
    '/tmp/screensync-server.log',
    '/tmp/screensync-server-error.log',
  ];
  for (const lp of logPaths) {
    try { fs.writeFileSync(lp, '', 'utf8'); } catch (_) {}
  }

  // Unload old agent, then load the new plist (RunAtLoad will start the server)
  run(`launchctl unload ${shQuote(plistPath)} 2>/dev/null`);
  sleepSec(1);
  const loadRes = run(`launchctl load ${shQuote(plistPath)}`);
  if (loadRes.ok || (loadRes.out && loadRes.out.includes('already loaded'))) {
    loaded = true;
  }

  if (!loaded && uidRes.ok && uidRes.out) {
    const domain = `gui/${uidRes.out}`;
    run(`launchctl bootout ${domain}/${label} 2>/dev/null`);
    sleepSec(1);
    const bootstrap = run(`launchctl bootstrap ${domain} ${shQuote(plistPath)}`);
    if (bootstrap.ok) {
      loaded = true;
    }
  }

  if (!loaded) {
    output({ success: false, error: 'LaunchAgent 加载失败（load/bootstrap 均失败）' });
    process.exit(1);
  }

  if (uidRes.ok && uidRes.out) {
    const domain = `gui/${uidRes.out}`;
    run(`launchctl kickstart -k ${domain}/${label} 2>/dev/null`);
  } else {
    run(`launchctl start ${label} 2>/dev/null`);
  }

  // Poll for server to be ready (LaunchAgent's RunAtLoad starts it)
  for (let i = 0; i < 20; i++) {
    sleepSec(1);
    if (portReady()) {
      output({ success: true, message: '服务器已启动并配置为开机自动启动' });
      process.exit(0);
    }
  }

  // Fallback: LaunchAgent didn't bring up the server; spawn directly
  run(`${shQuote(nodePath)} ${shQuote(startScript)} >/tmp/screensync-server.log 2>/tmp/screensync-server-error.log &`);
  for (let i = 0; i < 8; i++) {
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
