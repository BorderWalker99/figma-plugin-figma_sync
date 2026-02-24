// Tauri API (withGlobalTauri enabled in tauri.conf.json)
let invoke, listen;
try {
  invoke = window.__TAURI__.core.invoke;
  listen = window.__TAURI__.event.listen;
} catch (e) {
  // Tauri API not yet available — try alternative paths
  try {
    invoke = window.__TAURI__.invoke;
    listen = window.__TAURI__.event.listen;
  } catch (e2) {
    document.title = 'JS Error: ' + e.message;
  }
}

// Alert
window.showAlert = function(message, title = '提示') {
  const overlay = document.getElementById('overlay');
  const titleEl = document.getElementById('modalTitle');
  const messageEl = document.getElementById('modalMessage');
  if (overlay && titleEl && messageEl) {
    titleEl.textContent = title;
    messageEl.textContent = message;
  }
};

window.closeAlert = function() {
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.classList.remove('show');
};

let currentStep = 1;
let installPath = '';
let selectedMode = 'drive';
let userId = '';

function showStep(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step${step}`).classList.add('active');

  const header = document.querySelector('.header');
  if (header) header.style.display = step === 1 ? 'none' : 'flex';

  document.querySelectorAll('.dot').forEach((dot, index) => {
    dot.classList.remove('active', 'completed');
    if (index + 1 < step) dot.classList.add('completed');
    else if (index + 1 === step) dot.classList.add('active');
  });

  currentStep = step;

  if (step === 2) checkSystemRequirements();
  else if (step === 3) installDependencies();
  else if (step === 4) setupConfiguration();
}

window.nextStep = function() {
  try {
    if (currentStep === 1 && !installPath) {
      showToast('请先选择项目文件夹', 'error');
      return;
    }
    if (currentStep < 5) showStep(currentStep + 1);
  } catch (err) {
    showToast('步骤切换失败: ' + err.message, 'error');
  }
};

window.prevStep = function() {
  if (currentStep > 1) showStep(currentStep - 1);
};

async function detectProjectRoot() {
  try {
    const detectedPath = await invoke('get_project_root');
    if (detectedPath) {
      installPath = detectedPath;
      return true;
    }
    showManualSelectionUI();
    return false;
  } catch {
    installPath = '';
    showManualSelectionUI();
    return false;
  }
}

function showManualSelectionUI() {
  const step1 = document.getElementById('step1');
  const nextBtn = document.getElementById('step1Next');
  const existingAlert = document.getElementById('pathAlert');
  if (existingAlert) existingAlert.remove();

  // Disable the "开始安装" button until a path is selected
  if (nextBtn) nextBtn.disabled = true;

  const alertDiv = document.createElement('div');
  alertDiv.id = 'pathAlert';
  alertDiv.className = 'alert alert-error';
  alertDiv.style.marginBottom = '20px';
  alertDiv.innerHTML = `
    <div class="alert-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 8v5M12 16.5v.5" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div style="flex:1">
      <div style="font-weight:600;margin-bottom:4px;">未找到项目文件</div>
      <div style="font-size:12px;opacity:0.9;margin-bottom:8px;">无法自动定位安装包位置，请手动选择解压后的 ScreenSync 安装包文件夹（如 ScreenSync-Apple 或 ScreenSync-Intel）。</div>
      <button id="selectPathBtn" class="btn btn-secondary" style="background:rgba(255,255,255,0.9);color:#333;font-size:12px;padding:4px 12px;">选择文件夹</button>
    </div>
  `;
  step1.insertBefore(alertDiv, step1.firstChild);

  document.getElementById('selectPathBtn').onclick = async () => {
    try {
      const result = await invoke('select_project_root');
      if (result.success && result.path) {
        installPath = result.path;
        showToast('已选择项目目录: ' + result.path.split('/').pop(), 'success');
        alertDiv.remove();
        if (nextBtn) nextBtn.disabled = false;
      } else if (result.error) {
        showToast(result.error, 'error');
      }
    } catch (err) {
      showToast('选择失败: ' + err, 'error');
    }
  };
}

window.selectMode = function(mode) {
  selectedMode = mode;
  const cards = document.querySelectorAll('.feature-card');
  cards.forEach(card => card.classList.remove('selected'));
  if (mode === 'drive' && cards[0]) cards[0].classList.add('selected');
  else if (mode === 'icloud' && cards[1]) cards[1].classList.add('selected');
  if (mode === 'icloud') checkIcloudSpace();
  else {
    icloudSpaceAvailable = null;
    const nextBtn = document.getElementById('step1Next');
    if (nextBtn) nextBtn.disabled = false;
    const checkResult = document.getElementById('icloudCheckResult');
    if (checkResult) checkResult.style.display = 'none';
  }
};

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const iconEl = toast.querySelector('.toast-icon');
  const messageEl = toast.querySelector('.toast-message');
  if (type === 'success') {
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M16.5 9.5l-5.5 5.5-3-3" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    toast.className = 'toast success';
  } else if (type === 'error') {
    iconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 8v5M12 16.5v.5" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    toast.className = 'toast error';
  } else {
    iconEl.innerHTML = '';
    toast.className = 'toast';
  }
  messageEl.textContent = message;
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => toast.classList.remove('show'), 3000);
}

let icloudSpaceAvailable = null;

async function checkIcloudSpace() {
  const result = await invoke('check_icloud_space');
  icloudSpaceAvailable = result.available;
  if (result.available) {
    document.getElementById('step1Next').disabled = false;
  } else {
    document.getElementById('step1Next').disabled = true;
  }
}

let dependencyStatus = { homebrew: null, node: null, imagemagick: null, ffmpeg: null, gifsicle: null };

async function checkSystemRequirements() {
  const checks = document.getElementById('systemChecks');
  const step2Buttons = document.getElementById('step2Buttons');
  const actionBtn = document.getElementById('step2ActionBtn');
  step2Buttons.style.display = 'flex';
  actionBtn.disabled = true;
  actionBtn.innerHTML = '<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> 检测中...';

  try {
    const macosInfo = await invoke('get_macos_version');

    if (macosInfo.supported === false) {
      showToast(`⚠️ 检测到 macOS ${macosInfo.version} (${macosInfo.name})，旧系统使用直接下载模式安装依赖。`, 'error');
      window.macosInfo = macosInfo;
    } else if (macosInfo.supported === 'limited') {
      showToast(`⚠️ 检测到 macOS ${macosInfo.version} (${macosInfo.name})，将使用直接下载模式安装依赖。`, 'warning');
      window.macosInfo = macosInfo;
    }

    dependencyStatus = { homebrew: null, node: null, imagemagick: null, ffmpeg: null, gifsicle: null };

    const depChecks = [
      { key: 'homebrew', cmd: 'check_homebrew', label: 'Homebrew', idx: 0 },
      { key: 'node', cmd: 'check_node', label: 'Node.js', idx: 1 },
      { key: 'imagemagick', cmd: 'check_imagemagick', label: 'ImageMagick', idx: 2 },
      { key: 'ffmpeg', cmd: 'check_ffmpeg', label: 'FFmpeg', idx: 3 },
      { key: 'gifsicle', cmd: 'check_gifsicle', label: 'Gifsicle', idx: 4 },
    ];

    for (const { key, cmd, label, idx } of depChecks) {
      const item = checks.children[idx];
      const result = await invoke(cmd);
      dependencyStatus[key] = result.installed;

      if (result.skipped) {
        item.className = 'status-item success';
        item.innerHTML = `<div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
          <div class="status-content"><div class="status-label">${label}</div><div class="status-detail" style="color: var(--text-tertiary);">无需安装（直接下载模式）</div></div>`;
      } else if (result.installed) {
        item.className = 'status-item success';
        item.innerHTML = `<div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
          <div class="status-content"><div class="status-label">${label}</div><div class="status-detail" style="color: var(--success);">已安装${result.version ? ' (' + result.version + ')' : ''}</div></div>`;
      } else {
        item.className = 'status-item error';
        item.innerHTML = `<div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
          <div class="status-content"><div class="status-label">${label}</div><div class="status-detail" style="color: var(--danger);">未安装</div></div>`;
      }
    }

    const allInstalled = Object.values(dependencyStatus).every(Boolean);
    actionBtn.disabled = false;

    if (allInstalled) {
      actionBtn.innerHTML = '下一步 <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      actionBtn.style.padding = '10px 12px 10px 20px';
      actionBtn.onclick = window.nextStep;
    } else {
      actionBtn.innerHTML = '立即安装';
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = installMissingDependencies;
    }
  } catch (error) {
    showToast('环境检查失败: ' + error, 'error');
    actionBtn.disabled = false;
    actionBtn.innerHTML = '重新检测';
    actionBtn.onclick = checkSystemRequirements;
  }
}

window.recheckDependencies = checkSystemRequirements;

async function installMissingDependencies() {
  const actionBtn = document.getElementById('step2ActionBtn');
  const checks = document.getElementById('systemChecks');
  const logContainer = document.getElementById('step2Log');

  actionBtn.disabled = true;
  actionBtn.classList.add('keep-raised');
  actionBtn.innerHTML = '<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> 正在安装...';

  logContainer.style.display = 'block';
  logContainer.innerHTML = '';

  const depIndices = { homebrew: 0, node: 1, imagemagick: 2, ffmpeg: 3, gifsicle: 4 };
  const displayNames = { homebrew: 'Homebrew', node: 'Node.js', imagemagick: 'ImageMagick', ffmpeg: 'FFmpeg', gifsicle: 'Gifsicle' };

  const depsToInstall = [];
  for (const dep of ['homebrew', 'node', 'imagemagick', 'ffmpeg', 'gifsicle']) {
    if (!dependencyStatus[dep]) depsToInstall.push(dep);
  }

  for (const dep of depsToInstall) {
    const item = checks.children[depIndices[dep]];
    if (item) {
      item.className = 'status-item checking';
      item.innerHTML = `<div class="status-icon"><svg class="spinner" viewBox="0 0 24 24" style="opacity:0.3"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>
        <div class="status-content"><div class="status-label">${displayNames[dep]}</div><div class="status-detail" style="color: var(--text-tertiary);">等待安装...</div></div>`;
    }
  }

  // Tauri events — listen returns an unlisten function
  const unlistenProgress = await listen('dep-install-progress', (event) => {
    const { dep, status, message } = event.payload;
    const item = checks.children[depIndices[dep]];
    if (!item) return;

    if (status === 'installing' || status === 'password') {
      item.className = 'status-item checking';
      item.innerHTML = `<div class="status-icon"><svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>
        <div class="status-content"><div class="status-label">${displayNames[dep]}</div><div class="status-detail" style="color: var(--accent);">${message}</div></div>`;
    } else if (status === 'done') {
      item.className = 'status-item success';
      item.innerHTML = `<div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content"><div class="status-label">${displayNames[dep]}</div><div class="status-detail" style="color: var(--success);">已安装</div></div>`;
    } else if (status === 'error') {
      item.className = 'status-item error';
      item.innerHTML = `<div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content"><div class="status-label">${displayNames[dep]}</div><div class="status-detail" style="color: var(--danger);">${message}</div></div>`;
    }
  });

  const unlistenLog = await listen('dep-install-log', (event) => {
    const lines = event.payload.data.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const logLine = document.createElement('div');
      logLine.style.cssText = 'padding: 1px 0; word-break: break-all; white-space: pre-wrap;';
      logLine.textContent = line;
      logContainer.appendChild(logLine);
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  });

  try {
    const result = await invoke('install_all_dependencies', { dependencyStatus });

    await new Promise(r => setTimeout(r, 300));
    unlistenProgress();
    unlistenLog();

    if (result.success) {
      showToast('所有依赖安装完成', 'success');
      actionBtn.innerHTML = '<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> 正在验证...';
      setTimeout(() => { logContainer.style.display = 'none'; checkSystemRequirements(); }, 1500);
    } else {
      if (result.cancelled) showToast('已取消安装', 'error');
      else showToast(result.error || '安装失败', 'error');
      actionBtn.disabled = false;
      actionBtn.classList.remove('keep-raised');
      actionBtn.innerHTML = '重试安装';
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = installMissingDependencies;
    }
  } catch (error) {
    await new Promise(r => setTimeout(r, 300));
    unlistenProgress();
    unlistenLog();
    showToast('安装失败: ' + error, 'error');
    actionBtn.disabled = false;
    actionBtn.classList.remove('keep-raised');
    actionBtn.innerHTML = '重试安装';
    actionBtn.style.padding = '10px 20px';
    actionBtn.onclick = installMissingDependencies;
  }
}

async function installDependencies() {
  const progressBar = document.getElementById('installProgress');
  const errorAlert = document.getElementById('installErrorAlert');
  const statusLabel = document.getElementById('installStatusLabel');

  errorAlert.style.display = 'none';
  errorAlert.innerHTML = '';
  progressBar.classList.remove('success');
  progressBar.style.width = '10%';
  if (statusLabel) statusLabel.textContent = '正在安装依赖...';

  let currentProgress = 10;

  const unlistenOutput = await listen('install-output', (event) => {
    const lines = (event.payload.data || '').split('\n').length;
    const progress = 10 + (lines / 2);
    if (progress > currentProgress) {
      currentProgress = Math.min(progress, 95);
      progressBar.style.width = `${currentProgress}%`;
    }
  });

  const result = await invoke('install_dependencies', { installPath });
  unlistenOutput();

  if (result.success) {
    progressBar.style.width = '100%';
    progressBar.classList.add('success');
    if (statusLabel) statusLabel.textContent = '依赖安装完成';
    document.getElementById('step3Next').disabled = false;
  } else {
    errorAlert.innerHTML = `
      <div class="alert alert-error">
        <div class="alert-icon" style="flex-shrink: 0; color: var(--danger);">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 8v5M12 16.5v.5" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div>
          <div style="font-weight: 600; margin-bottom: 4px;">依赖安装失败</div>
          <div style="opacity: 0.9; font-size: 12px; white-space: pre-wrap;">${result.error}</div>
        </div>
      </div>`;
    errorAlert.style.display = 'block';
    progressBar.style.width = '0%';
    if (statusLabel) statusLabel.textContent = '安装失败';
  }

  document.getElementById('step3Buttons').style.display = 'flex';
}

async function setupConfiguration() {
  const configStatus = document.getElementById('configStatus');

  try { await invoke('enable_anywhere'); } catch {}

  const localFolder = selectedMode === 'drive'
    ? installPath.replace(/[^/]+$/, '') + 'ScreenSyncImg'
    : (await getHomeDir()) + '/Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg';

  const configResult = await invoke('setup_config', { installPath, syncMode: selectedMode, localFolder });

  if (configResult.success) {
    userId = configResult.userId;
    configStatus.innerHTML = `
      <div class="status-item success">
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content"><div class="status-label">配置完成</div></div>
      </div>`;
    document.getElementById('step4Next').disabled = false;
  } else {
    configStatus.innerHTML = `
      <div class="status-item error">
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content"><div class="status-label">配置失败</div><div class="status-detail">${configResult.error}</div></div>
      </div>`;
  }

  document.getElementById('step4Buttons').style.display = 'flex';
}

async function getHomeDir() {
  return await invoke('get_home_dir');
}

async function copyUserId(userId) {
  try {
    await invoke('copy_to_clipboard', { text: userId });
    showToast('User ID 已复制', 'success');
  } catch { showToast('复制失败', 'error'); }
}

window.finishInstallation = async function() {
  const button = document.getElementById('step5Finish');
  if (!button) return;
  const originalText = button.textContent;

  try {
    button.classList.add('keep-raised');
    button.disabled = true;
    button.textContent = '正在启动服务器';

    const startResult = await invoke('start_server', { installPath });
    if (!startResult.success) {
      button.classList.remove('keep-raised');
      button.disabled = false;
      button.textContent = originalText;
      showToast('服务器启动失败', 'error');
      return;
    }

    if (selectedMode === 'icloud') {
      button.textContent = '正在配置 iCloud 文件夹';
      await invoke('setup_icloud_keep_downloaded');
    }

    button.textContent = '正在配置自启动';
    const autostartResult = await invoke('setup_autostart', { installPath });

    if (autostartResult.success) {
      button.textContent = '配置完成';
      showToast('服务自启动已配置完成', 'success');
      setTimeout(() => invoke('quit_app'), 1500);
    } else {
      button.textContent = '启动成功（自启失败）';
      showToast('服务器已启动', 'warning');
      setTimeout(() => invoke('quit_app'), 2000);
    }
  } catch (err) {
    button.classList.remove('keep-raised');
    button.disabled = false;
    button.textContent = originalText;
    showToast('配置失败', 'error');
  }
};

window.onerror = function(msg, src, line, col, err) {
  document.title = `Error: ${msg} (${src}:${line})`;
};

document.addEventListener('DOMContentLoaded', async () => {
  showStep(1);

  // Tauri 2.x injects a CSP nonce which silently disables 'unsafe-inline',
  // so all event handlers MUST be attached via addEventListener.
  const bind = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  };

  bind('step1Next', () => window.nextStep());
  bind('step3Next', () => window.nextStep());
  bind('step4Next', () => window.nextStep());
  bind('step5Finish', () => window.finishInstallation());
  bind('alertCloseBtn', () => window.closeAlert());

  try {
    await detectProjectRoot();
  } catch (err) {
    showToast('初始化失败: ' + err.message, 'error');
  }
});
