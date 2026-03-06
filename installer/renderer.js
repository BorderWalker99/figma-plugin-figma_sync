const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// ========================================
// i18n — Internationalization
// ========================================
let currentLang = 'zh';

const i18n = {
  zh: {
    welcome_subtitle: '自动化传输并整理截图',
    btn_start_install: '开始安装',
    btn_next: '下一步',
    btn_done: '我知道了',
    btn_checking: '检测中...',
    recheck: '重新检测',
    btn_copy: '一键复制',
    step2_title: '安装检查',
    step2_desc: '检查安装文件是否完整',
    step3_title: '安装准备',
    step3_desc: '正在完成安装前准备',
    step4_title: '系统配置',
    step4_desc: '应用配置并设置本地环境',
    step5_title: '安装完成',
    installing: '正在安装...',
    configuring: '配置中...',
    setting_permissions: '正在设置权限和文件夹...',
    checking: '检查中...',
    installed: '已安装',
    not_installed: '未安装',
    install_failed: '安装失败',
    view_detail: '查看详情',
    waiting_install: '等待安装...',
    verifying: '正在验证...',
    retry_install: '重试安装',
    reinstall: '重新安装',
    all_deps_installed: '所有依赖安装完成',
    cancelled: '已取消安装',
    deps_installed: '依赖安装完成',
    no_homebrew: '无需安装（直接下载模式）',
    starting_server: '正在启动服务器...',
    configuring_icloud: '正在配置 iCloud 文件夹...',
    configuring_autostart: '正在配置自启动...',
    config_done: '配置完成',
    config_failed: '配置失败',
    server_started: '服务器启动成功',
    server_start_failed: '服务器启动失败',
    autostart_done: '自启动已配置',
    autostart_failed: '自启动配置失败',
    log_copied: '已成功复制',
    error_detail_title: '失败详情',
    error_detail_subtitle: '请复制发给开发者',
    alert_title: '提示',
    all_installed_next: '所有依赖已安装',
    install_missing: '安装缺失依赖',
    downloading_deps: '正在下载依赖包...',
    builtin_env_ready: '已检测到内置环境，可直接继续',
    package_invalid: '安装资源不完整，请重新下载安装包后重试',
    package_missing_detail: '安装资源校验失败'
  },
  en: {
    welcome_subtitle: 'Automate screenshot transfer & organization',
    btn_start_install: 'Start Install',
    btn_next: 'Next',
    btn_done: 'Got it',
    btn_checking: 'Checking...',
    recheck: 'Recheck',
    btn_copy: 'Copy',
    step2_title: 'Installation Check',
    step2_desc: 'Verify installation files are complete',
    step3_title: 'Setup Preparation',
    step3_desc: 'Preparing required components',
    step4_title: 'System Configuration',
    step4_desc: 'Apply settings and configure local environment',
    step5_title: 'Installation Complete',
    installing: 'Installing...',
    configuring: 'Configuring...',
    setting_permissions: 'Setting permissions and folders...',
    checking: 'Checking...',
    installed: 'Installed',
    not_installed: 'Not installed',
    install_failed: 'Install failed',
    view_detail: 'Details',
    waiting_install: 'Waiting...',
    verifying: 'Verifying...',
    retry_install: 'Retry',
    reinstall: 'Reinstall',
    all_deps_installed: 'All dependencies installed',
    cancelled: 'Installation cancelled',
    deps_installed: 'Dependencies installed',
    no_homebrew: 'Not needed (direct download)',
    starting_server: 'Starting server...',
    configuring_icloud: 'Configuring iCloud folder...',
    configuring_autostart: 'Configuring autostart...',
    config_done: 'Configuration complete',
    config_failed: 'Configuration failed',
    server_started: 'Server started',
    server_start_failed: 'Server failed to start',
    autostart_done: 'Autostart configured',
    autostart_failed: 'Autostart configuration failed',
    log_copied: 'Copied successfully',
    error_detail_title: 'Error Details',
    error_detail_subtitle: 'Please copy and send to the developer',
    alert_title: 'Notice',
    all_installed_next: 'All dependencies installed',
    install_missing: 'Install missing dependencies',
    downloading_deps: 'Downloading dependencies...',
    builtin_env_ready: 'Built-in environment is ready, you can continue',
    package_invalid: 'Installation package is incomplete. Please re-download and try again',
    package_missing_detail: 'Installation resource validation failed'
  }
};

function t(key) {
  return (i18n[currentLang] && i18n[currentLang][key]) || i18n.zh[key] || key;
}

function applyLanguage() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text) el.textContent = text;
  });
}

window.selectLanguage = function(lang) {
  currentLang = lang;
  document.querySelectorAll('.lang-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(lang === 'zh' ? 'langCardZh' : 'langCardEn');
  if (card) card.classList.add('selected');
  applyLanguage();
};

// Alert 弹窗控制
window.showAlert = function(message, title) {
  title = title || t('alert_title');
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
  if (overlay) {
    overlay.classList.remove('show');
  }
};

let currentStep = 1; // 从 Step 1 (封面) 开始
let installPath = '';
let selectedMode = 'drive'; // 默认 Google 模式
let userId = '';

// 步骤管理
function showStep(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step${step}`).classList.add('active');
  
  // 第一步（封面页）隐藏顶部栏，其他步骤显示
  const header = document.querySelector('.header');
  if (header) {
    header.style.display = step === 1 ? 'none' : 'flex';
  }
  
  // 更新步骤指示器（现在只有 5 步）
  document.querySelectorAll('.dot').forEach((dot, index) => {
    dot.classList.remove('active', 'completed');
    if (index + 1 < step) {
      dot.classList.add('completed');
    } else if (index + 1 === step) {
      dot.classList.add('active');
    }
  });
  
  currentStep = step;
  
  // 执行步骤特定的初始化
  if (step === 2) {
    checkSystemRequirements();
  } else if (step === 3) {
    installDependencies();
  } else if (step === 4) {
    setupConfiguration();
  }
}

// 暴露到全局，供 HTML onclick 调用
window.nextStep = function() {
  console.log('nextStep called, currentStep:', currentStep, 'selectedMode:', selectedMode);
  // iCloud 模式检查已移除，因为默认使用 Google 模式
  
  if (currentStep < 5) {
    showStep(currentStep + 1);
  }
}

// 暴露到全局，供 HTML onclick 调用
window.prevStep = function() {
  console.log('prevStep called');
  if (currentStep > 1) {
    showStep(currentStep - 1);
  }
};

// 自动检测项目根目录
async function detectProjectRoot() {
  try {
    const detectedPath = await ipcRenderer.invoke('get-project-root');
    // 必须存在 package.json 才算有效
    if (detectedPath && fs.existsSync(path.join(detectedPath, 'package.json'))) {
      installPath = detectedPath;
      await ipcRenderer.invoke('set-install-path', installPath).catch(() => {});
      console.log('✅ 自动检测到项目目录:', installPath);
      return true;
    } else {
      console.warn('⚠️ 未找到 package.json，使用检测到的路径:', detectedPath);
      installPath = ''; // 清空，防止使用无效路径
      showManualSelectionUI();
      return false;
    }
  } catch (error) {
    console.error('❌ 检测项目目录失败:', error);
    installPath = '';
    showManualSelectionUI();
    return false;
  }
}

// 显示手动选择 UI
function showManualSelectionUI() {
  // 在 Step 1 顶部插入提示
  const step1 = document.getElementById('step1');
  const existingAlert = document.getElementById('pathAlert');
  if (existingAlert) existingAlert.remove();

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
    const result = await ipcRenderer.invoke('select-project-root');
    if (result.success && result.path) {
      installPath = result.path;
      await ipcRenderer.invoke('set-install-path', installPath).catch(() => {});
      showToast('已选择项目目录', 'success');
      // 移除警告
      alertDiv.remove();
      // 重新检查环境（可选，但通常 Step 1 只是选择模式）
    } else if (result.error) {
      showToast(result.error, 'error');
    }
  };
  
  // 禁用下一步按钮，直到选择有效路径
  const nextBtn = document.getElementById('step1Next');
  if (nextBtn) {
    // 保存原有的 onclick，包裹一层检查
    const originalOnClick = nextBtn.onclick;
    nextBtn.onclick = (e) => {
      if (!installPath) {
        showToast('请先选择项目文件夹', 'error');
        return;
      }
      if (originalOnClick) originalOnClick.call(nextBtn, e);
    };
  }
}

// Step 1: 选择储存方式
// 使用 window.selectMode 确保在全局作用域，供 HTML onclick 调用
window.selectMode = function(mode) {
  console.log('selectMode called with:', mode);
  selectedMode = mode;
  
  // 更新 UI - 使用 feature-card 选择器
  const cards = document.querySelectorAll('.feature-card');
  
  // 移除所有选中状态
  cards.forEach(card => {
    card.classList.remove('selected');
  });
  
  // 找到对应的卡片并选中
  if (mode === 'drive' && cards[0]) {
    cards[0].classList.add('selected');
  } else if (mode === 'icloud' && cards[1]) {
    cards[1].classList.add('selected');
  }
  
  // 如果是 iCloud 模式，检查空间
  if (mode === 'icloud') {
    checkIcloudSpace();
  } else {
    // Google Cloud 模式：重置 iCloud 空间检测结果，启用下一步按钮
    icloudSpaceAvailable = null;
    const nextBtn = document.getElementById('step1Next');
    if (nextBtn) {
      nextBtn.disabled = false;
    }
    const checkResult = document.getElementById('icloudCheckResult');
    if (checkResult) {
      checkResult.style.display = 'none';
    }
  }
};


// 显示 Toast 通知
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const iconEl = toast.querySelector('.toast-icon');
  const messageEl = toast.querySelector('.toast-message');
  
  // 设置图标（统一的圆形背景 + 白色图标设计）
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
  
  // 显示
  setTimeout(() => toast.classList.add('show'), 10);
  
  // 3秒后隐藏
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

let icloudSpaceAvailable = null; // 存储 iCloud 空间检测结果

async function checkIcloudSpace() {
  const result = await ipcRenderer.invoke('check-icloud-space');
  icloudSpaceAvailable = result.available;
  
  if (result.available) {
    // 空间充足：不弹出 toast，只启用下一步按钮
    document.getElementById('step1Next').disabled = false;
  } else {
    // 空间不足：禁用下一步按钮，但不弹出 toast（在点击下一步时弹出）
    document.getElementById('step1Next').disabled = true;
  }
}

// 存储依赖检查结果
let dependencyStatus = {
  homebrew: null,
  node: null,
  imagemagick: null,
  ffmpeg: null,
  gifsicle: null
};
let lastFailedDependency = null;

// Step 2: 统一的系统检查（自动开始）
async function checkSystemRequirements() {
  const checks = document.getElementById('systemChecks');
  const step2Buttons = document.getElementById('step2Buttons');
  const actionBtn = document.getElementById('step2ActionBtn');
  
  // 立即显示按钮区域
  step2Buttons.style.display = 'flex';
  
  // 设置为加载状态
  actionBtn.disabled = true;
  actionBtn.innerHTML = `<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> ${t('btn_checking')}`;
  
  try {
    const fat = await ipcRenderer.invoke('check-fat-runtime', installPath);
    const ok = !!(fat && fat.complete);

    dependencyStatus = {
      homebrew: ok,
      node: ok,
      imagemagick: ok,
      ffmpeg: ok,
      gifsicle: ok
    };

    const labels = ['Homebrew', 'Node.js', 'ImageMagick', 'FFmpeg', 'Gifsicle'];
    labels.forEach((label, idx) => {
      const item = checks.children[idx];
      if (!item) return;
      if (ok) {
        item.className = 'status-item success';
        item.innerHTML = `
          <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
          <div class="status-content">
            <div class="status-label">${label}</div>
            <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
          </div>
        `;
      } else {
        item.className = 'status-item error';
        item.innerHTML = `
          <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
          <div class="status-content">
            <div class="status-label">${label}</div>
            <div class="status-detail" style="color: var(--danger);">${t('not_installed')}</div>
          </div>
        `;
      }
    });

    actionBtn.disabled = false;
    if (ok) {
      lastFailedDependency = null;
      actionBtn.innerHTML = `${t('btn_next')} <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
      actionBtn.style.padding = '10px 12px 10px 20px';
      actionBtn.onclick = window.nextStep;
      actionBtn.className = 'btn btn-primary';
    } else {
      showToast(t('package_invalid'), 'error');
      actionBtn.innerHTML = t('recheck');
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = checkSystemRequirements;
      actionBtn.className = 'btn btn-secondary';
    }
  } catch (error) {
    console.error('Environment check failed:', error);
    showToast(error.message, 'error');
    
    actionBtn.disabled = false;
    actionBtn.innerHTML = t('recheck');
    actionBtn.onclick = checkSystemRequirements;
  }
}

// 移除 recheckDependencies 函数，因为逻辑已合并到 checkSystemRequirements
// 如果有其他地方调用 recheckDependencies (例如HTML onclick)，在新的 HTML 中已经去掉了
// 但为了兼容性（如果有遗漏），可以保留一个别名
window.recheckDependencies = checkSystemRequirements;

// 安装缺失的依赖（应用内可视化安装，无需打开终端）
async function installMissingDependencies() {
  const actionBtn = document.getElementById('step2ActionBtn');
  const checks = document.getElementById('systemChecks');

  // Disable button, show spinner
  actionBtn.disabled = true;
  actionBtn.classList.add('keep-raised');
  actionBtn.innerHTML = `<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> ${t('installing')}`;

  let step2LogBuffer = '';

  const depIndices = { homebrew: 0, node: 1, imagemagick: 2, ffmpeg: 3, gifsicle: 4 };
  const displayNames = { homebrew: 'Homebrew', node: 'Node.js', imagemagick: 'ImageMagick', ffmpeg: 'FFmpeg', gifsicle: 'Gifsicle' };
  const depOrder = ['homebrew', 'node', 'imagemagick', 'ffmpeg', 'gifsicle'];
  const restartIndex = depOrder.indexOf(lastFailedDependency);

  // Mark uninstalled deps as "waiting"
  const depsToInstall = [];
  depOrder.forEach((dep, index) => {
    if (restartIndex >= 0 && index < restartIndex) return;
    if (!dependencyStatus[dep]) depsToInstall.push(dep);
  });

  for (const dep of depsToInstall) {
    const item = checks.children[depIndices[dep]];
    if (item) {
      item.className = 'status-item checking';
      item.innerHTML = `
        <div class="status-icon"><svg class="spinner" viewBox="0 0 24 24" style="opacity:0.3"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>
        <div class="status-content">
          <div class="status-label">${displayNames[dep]}</div>
          <div class="status-detail" style="color: var(--text-tertiary);">${t('waiting_install')}</div>
        </div>
      `;
    }
  }

  // Real-time progress updates
  const progressHandler = (event, data) => {
    const { dep, status, message } = data;
    const item = checks.children[depIndices[dep]];
    if (!item) return;

    if (status === 'installing' || status === 'password') {
      item.className = 'status-item checking';
      item.innerHTML = `
        <div class="status-icon"><svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>
        <div class="status-content">
          <div class="status-label">${displayNames[dep]}</div>
          <div class="status-detail" style="color: var(--accent);">${t('installing')}</div>
        </div>
      `;
    } else if (status === 'done') {
      dependencyStatus[dep] = true;
      item.className = 'status-item success';
      item.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">${displayNames[dep]}</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else if (status === 'error') {
      dependencyStatus[dep] = false;
      lastFailedDependency = dep;
      item.className = 'status-item error';
      item.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">${displayNames[dep]}</div>
          <div class="status-detail" style="color: var(--danger);">${t('install_failed')}<span style="display: inline-block; width: 12px;"></span><a href="#" class="view-error-link" style="color: var(--accent); font-size: 12px; text-decoration: underline; cursor: pointer;">${t('view_detail')}</a></div>
        </div>
      `;
      const link = item.querySelector('.view-error-link');
      if (link) {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          showErrorDetailModal(step2LogBuffer);
        });
      }
    }
  };

  // Collect log output silently (no visible terminal)
  const logHandler = (event, data) => {
    step2LogBuffer += data.data;
  };

  ipcRenderer.on('dep-install-progress', progressHandler);
  ipcRenderer.on('dep-install-log', logHandler);

  try {
    const result = await ipcRenderer.invoke(
      'install-all-dependencies',
      dependencyStatus,
      { restartFrom: lastFailedDependency || null }
    );
    if (result && result.failedDep) {
      lastFailedDependency = result.failedDep;
    }

    // Delay listener removal — IPC send is async, progress messages may still be in flight
    await new Promise(r => setTimeout(r, 300));
    ipcRenderer.removeListener('dep-install-progress', progressHandler);
    ipcRenderer.removeListener('dep-install-log', logHandler);

    if (result.success) {
      lastFailedDependency = null;
      showToast(t('all_deps_installed'), 'success');

      actionBtn.innerHTML = `<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> ${t('verifying')}`;

      setTimeout(() => {
        checkSystemRequirements();
      }, 1500);
    } else {
      if (result.cancelled) {
        showToast(t('cancelled'), 'error');
      } else {
        showToast(result.error || t('install_failed'), 'error');
      }

      actionBtn.disabled = false;
      actionBtn.classList.remove('keep-raised');
      actionBtn.innerHTML = t('reinstall');
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = installMissingDependencies;
    }
  } catch (error) {
    await new Promise(r => setTimeout(r, 300));
    ipcRenderer.removeListener('dep-install-progress', progressHandler);
    ipcRenderer.removeListener('dep-install-log', logHandler);

    console.error('Install failed:', error);
    showToast(t('install_failed') + ': ' + error.message, 'error');

    actionBtn.disabled = false;
    actionBtn.classList.remove('keep-raised');
    actionBtn.innerHTML = t('reinstall');
    actionBtn.style.padding = '10px 20px';
    actionBtn.onclick = installMissingDependencies;
  }
}

// Step 2: 安装依赖
async function installDependencies() {
  const progressBar = document.getElementById('installProgress');
  const errorAlert = document.getElementById('installErrorAlert');
  const statusLabel = document.getElementById('installStatusLabel');
  
  // 重置状态
  errorAlert.style.display = 'none';
  errorAlert.innerHTML = '';
  progressBar.classList.remove('success');
  progressBar.style.width = '10%';
  if (statusLabel) {
    statusLabel.textContent = t('installing');
  }

  const result = await ipcRenderer.invoke('install-dependencies', installPath);
  if (result && result.success) {
    progressBar.style.width = '100%';
    progressBar.classList.add('success');
    if (statusLabel) {
      statusLabel.textContent = result.bundled
        ? t('builtin_env_ready')
        : t('all_deps_installed');
    }
    document.getElementById('step3Next').disabled = false;
  } else {
    progressBar.style.width = '0%';
    const detail = (result && result.error) || t('install_failed');
    if (statusLabel) {
      statusLabel.innerHTML = `<span style="color: var(--danger);">${t('install_failed')}</span><span style="display: inline-block; width: 12px;"></span><a id="viewErrorLink" href="#" style="color: var(--accent); font-size: 12px; text-decoration: underline; cursor: pointer;">${t('view_detail')}</a>`;
      document.getElementById('viewErrorLink').addEventListener('click', (e) => {
        e.preventDefault();
        showErrorDetailModal(detail);
      });
    }
  }
  
  document.getElementById('step3Buttons').style.display = 'flex';
}

// Step 3: 配置
async function setupConfiguration() {
  const configStatus = document.getElementById('configStatus');
  
  // 启用"任何来源"
  try {
    const enableResult = await ipcRenderer.invoke('enable-anywhere');
  } catch (e) {
    console.warn('Enable anywhere failed:', e);
  }
  
  // 创建配置
  const os = require('os');
  const localFolder = selectedMode === 'drive' 
    ? path.join(installPath, '../ScreenSyncImg')
    : path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg');
  
  // Save language preference
  await ipcRenderer.invoke('save-language', installPath, currentLang);

  const configResult = await ipcRenderer.invoke('setup-config', installPath, selectedMode, localFolder);
  
  if (configResult.success) {
    userId = configResult.userId;
    
    // 根据模式决定是否显示用户ID
    // 配置完成后，不再显示 User ID（简化界面）
    configStatus.innerHTML = `
      <div class="status-item success">
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">${t('config_done')}</div>
        </div>
      </div>
    `;
    document.getElementById('step4Next').disabled = false;
  } else {
    configStatus.innerHTML = `
      <div class="status-item error">
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">${t('config_failed')}</div>
          <div class="status-detail">${configResult.error}</div>
        </div>
      </div>
    `;
  }
  
  document.getElementById('step4Buttons').style.display = 'flex';
}

// 复制User ID到剪贴板
async function copyUserId(userId) {
  try {
    await ipcRenderer.invoke('copy-to-clipboard', userId);
    // 显示复制成功的提示
    showToast('User ID 已复制', 'success');
  } catch (error) {
    console.error('复制失败:', error);
    showToast('复制失败', 'error');
  }
}

// Step 5: 完成
// 暴露到全局，供 HTML onclick 调用
window.finishInstallation = async function() {
  console.log('finishInstallation called');
  const button = document.querySelector('#step5 .btn-primary');
  if (!button) {
    console.error('finishInstallation button not found');
    return;
  }
  const originalText = button.textContent;
  
  try {
    // 显示启动中状态
    button.classList.add('keep-raised'); // 保持凸起样式
    button.disabled = true;
    button.textContent = t('starting_server');
    
    // 步骤 1：先手动启动服务器（确保依赖已安装且服务正常）
    const startResult = await ipcRenderer.invoke('start-server', installPath);
    
    if (!startResult.success) {
      // 启动失败
      button.classList.remove('keep-raised');
      button.disabled = false;
      button.textContent = originalText;
      showToast(t('server_start_failed'), 'error');
      console.error('服务器启动失败:', startResult.error);
      showErrorDetailModal(startResult.error || '', t('server_start_failed'));
      return; // 提前返回，不配置自启动
    }
    
    // 步骤 2：如果是 iCloud 模式，配置文件夹为"始终保留下载"
    if (selectedMode === 'icloud') {
      button.textContent = t('configuring_icloud');
      console.log('📁 检测到 iCloud 模式，配置文件夹为"始终保留下载"...');
      const icloudResult = await ipcRenderer.invoke('setup-icloud-keep-downloaded');
      if (icloudResult.success) {
        console.log('✅ iCloud 文件夹配置成功');
        if (icloudResult.warning) {
          console.warn('⚠️ ', icloudResult.warning);
        }
      } else {
        console.warn('⚠️  iCloud 文件夹配置失败（不影响使用）');
      }
    }
    
    // 步骤 3：服务器启动成功后，配置自启动
    button.textContent = t('configuring_autostart');
    const autostartResult = await ipcRenderer.invoke('setup-autostart', installPath);
    
    if (autostartResult.success) {
      // 配置成功
      button.textContent = t('config_done');
      showToast(t('autostart_done'), 'success');
      
      // 延迟1.5秒后关闭，让用户看到成功消息
      setTimeout(() => {
        ipcRenderer.invoke('quit-app');
      }, 1500);
    } else {
      // 配置自启动失败，但服务器已启动
      console.warn('自启动配置失败:', autostartResult.error);
      button.textContent = t('server_started');
      showToast(t('autostart_failed'), 'warning');
      
      // 仍然关闭安装器，因为服务器已经在运行
        setTimeout(() => {
        ipcRenderer.invoke('quit-app');
      }, 2000);
    }
  } catch (err) {
    // 出错，恢复按钮状态
    button.classList.remove('keep-raised');
    button.disabled = false;
    button.textContent = originalText;
    showToast(t('config_failed'), 'error');
    console.error('配置自启动失败:', err);
  }
}

function extractErrorLog(logText) {
  const source = (logText || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const errorLikeRegex = /(❌|⚠️|\berror\b|\bfailed\b|\btimeout\b|exit code|curl:\s*\(\d+\)|无法|失败|不可用|网络|超时|镜像源)/i;
  const keep = [];
  let includeNextLine = 0;

  for (const line of lines) {
    const text = line || '';
    if (errorLikeRegex.test(text)) {
      keep.push(text);
      includeNextLine = 1;
      continue;
    }
    if (includeNextLine > 0 && text.trim().length > 0) {
      keep.push(text);
      includeNextLine -= 1;
    }
  }

  const compact = keep
    .map(line => line.trimEnd())
    .filter((line, index, arr) => {
      if (!line && (index === 0 || !arr[index - 1])) return false;
      return true;
    });

  if (compact.length > 0) {
    return compact.join('\n');
  }

  const fallback = lines
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .slice(-30)
    .join('\n');
  return fallback || '（无日志）';
}

// Error detail modal
function showErrorDetailModal(logText, titleText = t('error_detail_title')) {
  const overlay = document.getElementById('errorDetailOverlay');
  const titleEl = document.getElementById('errorDetailTitle');
  const subtitleEl = document.getElementById('errorDetailSubtitle');
  const content = document.getElementById('errorDetailContent');
  const errorLog = extractErrorLog(logText);
  if (titleEl) {
    titleEl.textContent = titleText || t('error_detail_title');
  }
  if (subtitleEl) {
    subtitleEl.textContent = t('error_detail_subtitle');
  }
  content.textContent = errorLog;
  content.dataset.copyText = errorLog;
  overlay.classList.add('show');
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  showStep(1);

  // Error detail overlay
  const errorDetailCloseBtn = document.getElementById('errorDetailCloseBtn');
  if (errorDetailCloseBtn) {
    errorDetailCloseBtn.addEventListener('click', () => {
      document.getElementById('errorDetailOverlay').classList.remove('show');
    });
  }
  const errorDetailCopyBtn = document.getElementById('errorDetailCopyBtn');
  if (errorDetailCopyBtn) {
    errorDetailCopyBtn.addEventListener('click', async () => {
      const contentEl = document.getElementById('errorDetailContent');
      const text = (contentEl && contentEl.dataset.copyText) || (contentEl && contentEl.textContent) || '';
      await ipcRenderer.invoke('copy-to-clipboard', text);
      showToast(t('log_copied'), 'success');
    });
  }

  const success = await detectProjectRoot();
});
