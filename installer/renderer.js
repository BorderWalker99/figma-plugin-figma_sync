const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// ========================================
// i18n — Internationalization
// ========================================
let currentLang = 'zh';
let installerMockMode = new URLSearchParams(window.location.search).get('mock') === '1';
let installerMockState = {
  permissionApproved: false,
  finalResult: 'success'
};

const i18n = {
  zh: {
    welcome_subtitle: '',
    welcome_task_hint: '确认语言后点击开始安装；如果安装器没有自动识别安装包，再选择文件夹即可。',
    btn_start_install: '开始安装',
    btn_next: '下一步',
    btn_continue_install: '继续安装',
    btn_done: '完成安装',
    btn_checking: '检测中...',
    recheck: '重新检测',
    btn_copy: '一键复制',
    step2_title: '确认安装包可用',
    step2_desc: '',
    step2_task_hint: '这一页只是在确认安装包可直接使用，你无需手动处理每个组件。',
    step3_title: '准备运行环境',
    step3_desc: '',
    step3_task_hint: '此过程可能需要几分钟，请保持安装器打开。',
    step3_ready_bundled: '内置运行环境已准备完成',
    step3_ready_generic: '运行环境已准备完成',
    step4_title: '设置本地工作区',
    step4_desc: '正在保存本机配置',
    step4_task_hint: '安装器会自动完成本地文件夹、语言和同步配置。',
    step4_result_folder: '已准备本地文件夹',
    step4_result_settings: '',
    step5_title: '完成系统授权',
    step5_desc: '完成后回到安装器',
    step5_waiting_title: '正在检查系统授权',
    step5_waiting_detail: '正在验证组件',
    step5_pending_title: '请到系统设置完成授权',
    step5_pending_detail: '系统设置 → 隐私与安全性 → 安全性：点按所有“仍要打开”',
    step5_ready_title: '授权已完成',
    step5_ready_detail: '已完成授权，继续安装中',
    step5_instruction_hint: '回到安装器后点“重新检测”',
    btn_open_security: '打开隐私与安全性',
    btn_continue_server: '继续安装',
    step6_title: 'ScreenSync 已安装',
    step6_starting_title: '正在启动 ScreenSync',
    step6_detail_starting: '请稍候',
    step6_detail_success: '已在后台运行',
    step6_detail_error: '请查看失败详情',
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
    config_done: '本地设置已完成',
    config_failed: '本地设置失败',
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
    package_missing_detail: '安装资源校验失败',
    dep_label_package: '安装资源',
    dep_label_node: 'Node.js',
    dep_label_imagemagick: '图片处理组件',
    dep_label_ffmpeg: '视频处理组件',
    dep_label_gifsicle: 'GIF 压缩组件',
    mock_permission_pending: '权限待授权',
    mock_permission_ready: '权限已授权',
    mock_final_success: '最终成功',
    mock_final_error: '最终失败',
    mock_reset: '重置'
  },
  en: {
    welcome_subtitle: '',
    welcome_task_hint: 'Confirm the language, then start installation. If the package is not detected automatically, just choose the folder manually.',
    btn_start_install: 'Start Install',
    btn_next: 'Next',
    btn_continue_install: 'Continue',
    btn_done: 'Finish',
    btn_checking: 'Checking...',
    recheck: 'Recheck',
    btn_copy: 'Copy',
    step2_title: 'Confirm the installer is ready',
    step2_desc: '',
    step2_task_hint: 'You do not need to inspect each component manually. This page only confirms the package is ready to install.',
    step3_title: 'Prepare the runtime',
    step3_desc: '',
    step3_task_hint: 'This may take a few minutes. Please keep the installer open.',
    step3_ready_bundled: 'Bundled runtime is ready',
    step3_ready_generic: 'Runtime is ready',
    step4_title: 'Set up your workspace',
    step4_desc: 'Saving this device configuration',
    step4_task_hint: 'The installer will finish the local folder and sync setup automatically.',
    step4_result_folder: 'Local folder is ready',
    step4_result_settings: '',
    step5_title: 'Complete Security Approval',
    step5_desc: 'Return to the installer when done',
    step5_waiting_title: 'Checking security approval',
    step5_waiting_detail: 'Verifying components',
    step5_pending_title: 'Finish approval in System Settings',
    step5_pending_detail: 'System Settings > Privacy & Security > Security: click every “Open Anyway”',
    step5_ready_title: 'Approval complete',
    step5_ready_detail: 'Approval complete. Continuing',
    step5_instruction_hint: 'Then click “Recheck”',
    btn_open_security: 'Open Privacy & Security',
    btn_continue_server: 'Continue',
    step6_title: 'ScreenSync Is Ready',
    step6_starting_title: 'Starting ScreenSync',
    step6_detail_starting: 'Please wait',
    step6_detail_success: 'Running in the background',
    step6_detail_error: 'Review the error details',
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
    config_done: 'Local setup complete',
    config_failed: 'Local setup failed',
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
    package_missing_detail: 'Installation resource validation failed',
    dep_label_package: 'Installation files',
    dep_label_node: 'Node.js',
    dep_label_imagemagick: 'Image processing',
    dep_label_ffmpeg: 'Video processing',
    dep_label_gifsicle: 'GIF compression',
    mock_permission_pending: 'Permission pending',
    mock_permission_ready: 'Permission approved',
    mock_final_success: 'Final success',
    mock_final_error: 'Final error',
    mock_reset: 'Reset'
  }
};

function t(key) {
  return (i18n[currentLang] && i18n[currentLang][key]) || i18n.zh[key] || key;
}

function getDependencyDisplayNames() {
  return {
    homebrew: t('dep_label_package'),
    node: t('dep_label_node'),
    imagemagick: t('dep_label_imagemagick'),
    ffmpeg: t('dep_label_ffmpeg'),
    gifsicle: t('dep_label_gifsicle')
  };
}

function applyLanguage() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const source = i18n[currentLang] || {};
    if (Object.prototype.hasOwnProperty.call(source, key) || Object.prototype.hasOwnProperty.call(i18n.zh, key)) {
      el.textContent = t(key);
    }
  });
}

function syncMockBar() {
  if (!installerMockMode) return;
  const mockBar = document.getElementById('mockBar');
  const permissionBtn = document.getElementById('mockPermissionToggle');
  const finalBtn = document.getElementById('mockFinalToggle');
  const resetBtn = document.getElementById('mockResetBtn');
  if (!mockBar || !permissionBtn || !finalBtn || !resetBtn) return;

  mockBar.classList.add('show');
  permissionBtn.textContent = installerMockState.permissionApproved
    ? t('mock_permission_ready')
    : t('mock_permission_pending');
  permissionBtn.classList.toggle('active', installerMockState.permissionApproved);

  finalBtn.textContent = installerMockState.finalResult === 'error'
    ? t('mock_final_error')
    : t('mock_final_success');
  finalBtn.classList.toggle('active', installerMockState.finalResult === 'success');
  resetBtn.textContent = t('mock_reset');

  document.querySelectorAll('[data-mock-step]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.mockStep) === currentStep);
  });
}

async function updateInstallerMockState(patch) {
  if (!installerMockMode) return;
  try {
    const result = await ipcRenderer.invoke('set-installer-mock-state', patch);
    if (result && result.mockState) {
      installerMockState = { ...installerMockState, ...result.mockState };
    }
  } catch (_) {}
  syncMockBar();
}

function jumpToMockStep(step) {
  if (!installerMockMode) return;
  step6HasStarted = false;
  isFinishingInstallation = false;
  if (permissionAutoAdvanceTimer) {
    clearTimeout(permissionAutoAdvanceTimer);
    permissionAutoAdvanceTimer = null;
  }
  showStep(step);
}

async function hydrateInstallerEnv() {
  try {
    const env = await ipcRenderer.invoke('get-installer-env');
    installerMockMode = !!(env && env.mock);
    if (env && env.mockState) {
      installerMockState = { ...installerMockState, ...env.mockState };
    }
    const versionEl = document.getElementById('footerVersion');
    if (versionEl && env && env.version) {
      versionEl.textContent = `v${String(env.version).replace(/^v/, '')}`;
    }
  } catch (_) {}
}

function initMockUI() {
  if (!installerMockMode) return;
  document.body.classList.add('mock-mode');
  document.querySelectorAll('.dot').forEach((dot, index) => {
    dot.classList.add('mock-jump');
    dot.addEventListener('click', () => jumpToMockStep(index + 1));
  });
  document.querySelectorAll('[data-mock-step]').forEach(btn => {
    btn.addEventListener('click', () => jumpToMockStep(Number(btn.dataset.mockStep)));
  });
  const permissionBtn = document.getElementById('mockPermissionToggle');
  const finalBtn = document.getElementById('mockFinalToggle');
  const resetBtn = document.getElementById('mockResetBtn');
  if (permissionBtn) {
    permissionBtn.addEventListener('click', async () => {
      await updateInstallerMockState({ permissionApproved: !installerMockState.permissionApproved });
      if (currentStep === 5) {
        runPermissionWarmupCheck();
      }
    });
  }
  if (finalBtn) {
    finalBtn.addEventListener('click', async () => {
      await updateInstallerMockState({
        finalResult: installerMockState.finalResult === 'success' ? 'error' : 'success'
      });
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await updateInstallerMockState({ reset: true });
      jumpToMockStep(1);
    });
  }
  syncMockBar();
}

function setFinalStepVisualState(state) {
  const titleEl = document.getElementById('step6Title');
  const detailEl = document.getElementById('step6Detail');
  const badgeEl = document.getElementById('step6IconBadge');
  const iconEl = document.getElementById('step6Icon');
  if (!titleEl || !detailEl || !badgeEl || !iconEl) return;

  let titleKey = 'step6_starting_title';
  let detailKey = 'step6_detail_starting';
  let badgeClass = 'loading';
  let iconSvg = `
    <svg class="spinner" viewBox="0 0 24 24" fill="none">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
    </svg>
  `;

  if (state === 'success') {
    titleKey = 'step6_title';
    detailKey = 'step6_detail_success';
    badgeClass = 'success';
    iconSvg = `
      <svg viewBox="0 0 24 24" fill="none">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    `;
  } else if (state === 'error') {
    titleKey = 'install_failed';
    detailKey = 'step6_detail_error';
    badgeClass = 'error';
    iconSvg = `
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" fill="none" stroke="white"/>
        <path d="M12 7.5v6"/>
        <path d="M12 16.5v.5"/>
      </svg>
    `;
  }

  titleEl.setAttribute('data-i18n', titleKey);
  titleEl.textContent = t(titleKey);
  detailEl.setAttribute('data-i18n', detailKey);
  detailEl.textContent = t(detailKey);
  badgeEl.className = `completion-badge ${badgeClass}`.trim();
  iconEl.innerHTML = iconSvg.trim();
}

function setFinalStepButtonVisible(visible) {
  const actionsEl = document.getElementById('step6Actions');
  if (actionsEl) {
    actionsEl.style.display = visible ? 'flex' : 'none';
  }
}

window.selectLanguage = function(lang) {
  currentLang = lang;
  document.querySelectorAll('.lang-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById(lang === 'zh' ? 'langCardZh' : 'langCardEn');
  if (card) card.classList.add('selected');
  applyLanguage();
  syncMockBar();
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
let step6HasStarted = false;
let isFinishingInstallation = false;
let permissionCheckInFlight = false;
let permissionValidationPassed = false;
let permissionNeedsApproval = false;
let permissionFocusRetryTimer = null;
let permissionSettingsAutoOpened = false;

function setPermissionButtonsState({ checking = false, canContinue = false } = {}) {
  const openBtn = document.getElementById('step5OpenSecurity');
  const retryBtn = document.getElementById('step5Retry');
  const nextBtn = document.getElementById('step5Next');
  const spacer = document.getElementById('step5ButtonsSpacer');
  if (openBtn) openBtn.disabled = checking;
  if (retryBtn) {
    retryBtn.disabled = checking;
    retryBtn.innerHTML = checking ? `<span>${t('btn_checking')}</span>` : `<span>${t('recheck')}</span>`;
  }
  if (nextBtn) {
    nextBtn.disabled = checking || !canContinue;
    nextBtn.style.display = canContinue ? 'inline-flex' : 'none';
  }
  if (spacer) {
    spacer.style.display = canContinue ? 'flex' : 'none';
  }
  if (openBtn) {
    openBtn.style.display = canContinue ? 'none' : 'inline-flex';
  }
  if (retryBtn) {
    retryBtn.style.display = canContinue ? 'none' : 'inline-flex';
  }
}

function renderPermissionGuide(pendingTools = []) {
  return Array.isArray(pendingTools) ? pendingTools : [];
}

function renderPermissionStatus({ state = 'checking', detail = '', pendingTools = [] } = {}) {
  const statusEl = document.getElementById('step5Status');
  const titleEl = document.getElementById('step5Title');
  const descEl = document.getElementById('step5Desc');
  if (!statusEl) return;

  let statusClass = 'checking';
  let titleText = t('step5_waiting_title');
  let detailText = detail || t('step5_waiting_detail');
  if (state === 'pending') {
    statusClass = 'error';
    titleText = t('step5_pending_title');
    detailText = detail || t('step5_pending_detail');
  } else if (state === 'ready') {
    statusClass = 'success';
    titleText = t('step5_ready_title');
    detailText = detail || t('step5_ready_detail');
  }

  const toolList = renderPermissionGuide(pendingTools);
  const toolListMarkup = toolList.length > 0
    ? `<div class="status-detail" style="margin-top: 4px; color: var(--text-secondary);">${toolList.join('、')}</div>`
    : '';

  if (titleEl) titleEl.textContent = titleText;
  // Keep the path guidance only once (step subtitle).
  // Do not repeat "System Settings -> Privacy & Security" in status lines.
  if (descEl) descEl.textContent = t('step5_desc');

  statusEl.innerHTML = `
    <div class="status-item ${statusClass}">
      <div class="status-icon">
        ${state === 'ready'
          ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17L4 12"/></svg>'
          : state === 'pending'
            ? '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'
            : '<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>'
        }
      </div>
      <div class="status-content">
        <div>
          <div class="status-label">${detailText}</div>
          ${toolListMarkup}
        </div>
      </div>
    </div>
  `;
}

async function runPermissionWarmupCheck({ triggeredByFocus = false } = {}) {
  if (permissionCheckInFlight) return;
  permissionCheckInFlight = true;
  permissionValidationPassed = false;
  setPermissionButtonsState({ checking: true, canContinue: false });
  renderPermissionStatus({ state: 'checking' });

  try {
    const result = await ipcRenderer.invoke('warmup-runtime-permissions', installPath);
    if (result && result.success) {
      permissionValidationPassed = true;
      permissionNeedsApproval = false;
      renderPermissionStatus({ state: 'ready' });
      setPermissionButtonsState({ checking: false, canContinue: true });
      if (!triggeredByFocus) {
        showToast(t('step5_ready_title'), 'success');
      }
      return;
    }

    permissionNeedsApproval = true;
    renderPermissionStatus({
      state: 'pending',
      detail: t('step5_pending_detail'),
      pendingTools: result && Array.isArray(result.pendingTools) ? result.pendingTools : []
    });
    setPermissionButtonsState({ checking: false, canContinue: false });
    if (!permissionSettingsAutoOpened && !triggeredByFocus) {
      permissionSettingsAutoOpened = true;
      window.openSecuritySettings({ silent: true });
    }
  } catch (error) {
    permissionNeedsApproval = true;
    renderPermissionStatus({
      state: 'pending',
      detail: error && error.message ? error.message : t('install_failed')
    });
    setPermissionButtonsState({ checking: false, canContinue: false });
    if (!permissionSettingsAutoOpened && !triggeredByFocus) {
      permissionSettingsAutoOpened = true;
      window.openSecuritySettings({ silent: true });
    }
  } finally {
    permissionCheckInFlight = false;
  }
}

function initPermissionStep() {
  permissionValidationPassed = false;
  permissionNeedsApproval = false;
  permissionSettingsAutoOpened = false;
  renderPermissionStatus({ state: 'checking' });
  setPermissionButtonsState({ checking: true, canContinue: false });
  if (permissionFocusRetryTimer) {
    clearTimeout(permissionFocusRetryTimer);
    permissionFocusRetryTimer = null;
  }
  runPermissionWarmupCheck();
}

// 步骤管理
function showStep(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step${step}`).classList.add('active');
  
  // 第一步（封面页）隐藏顶部栏，其他步骤显示
  const header = document.querySelector('.header');
  if (header) {
    header.style.display = step === 1 ? 'none' : 'flex';
  }
  
  // 更新步骤指示器
  document.querySelectorAll('.dot').forEach((dot, index) => {
    dot.classList.remove('active', 'completed');
    if (index + 1 < step) {
      dot.classList.add('completed');
    } else if (index + 1 === step) {
      dot.classList.add('active');
    }
  });
  
  currentStep = step;
  syncMockBar();
  permissionValidationPassed = false;
  if (permissionFocusRetryTimer) {
    clearTimeout(permissionFocusRetryTimer);
    permissionFocusRetryTimer = null;
  }
  // 执行步骤特定的初始化
  if (step === 2) {
    checkSystemRequirements();
  } else if (step === 3) {
    installDependencies();
  } else if (step === 4) {
    setupConfiguration();
  } else if (step === 5) {
    initPermissionStep();
  } else if (step === 6) {
    setFinalStepVisualState('loading');
    setFinalStepButtonVisible(false);
    if (!step6HasStarted) {
      step6HasStarted = true;
      setTimeout(() => {
        window.finishInstallation();
      }, 0);
    }
  }
}

// 暴露到全局，供 HTML onclick 调用
window.nextStep = function() {
  console.log('nextStep called, currentStep:', currentStep, 'selectedMode:', selectedMode);
  // iCloud 模式检查已移除，因为默认使用 Google 模式
  
  if (currentStep < 6) {
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
      <div style="font-weight:600;margin-bottom:4px;">请选择安装包文件夹</div>
      <div style="font-size:12px;opacity:0.9;margin-bottom:8px;">请选择包含“项目文件”的 ScreenSync 文件夹。</div>
      <button id="selectPathBtn" class="btn btn-secondary" style="background:rgba(255,255,255,0.9);color:#333;font-size:12px;padding:4px 12px;">选择安装包文件夹</button>
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
    const displayNames = getDependencyDisplayNames();

    dependencyStatus = {
      homebrew: ok,
      node: ok,
      imagemagick: ok,
      ffmpeg: ok,
      gifsicle: ok
    };

    const labels = [
      displayNames.homebrew,
      displayNames.node,
      displayNames.imagemagick,
      displayNames.ffmpeg,
      displayNames.gifsicle
    ];
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
      actionBtn.innerHTML = `${t('btn_continue_install')} <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
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
  const displayNames = getDependencyDisplayNames();
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
  const nextBtn = document.getElementById('step3Next');
  
  // 重置状态
  errorAlert.style.display = 'none';
  errorAlert.innerHTML = '';
  progressBar.classList.remove('success');
  progressBar.style.width = '10%';
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.onclick = window.nextStep;
    nextBtn.innerHTML = `<span>${t('btn_continue_install')}</span><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
  }
  if (statusLabel) {
    statusLabel.textContent = t('installing');
  }

  const result = await ipcRenderer.invoke('install-dependencies', installPath);
  if (result && result.success) {
    progressBar.style.width = '100%';
    progressBar.classList.add('success');
    if (statusLabel) {
      statusLabel.textContent = result.bundled
        ? t('step3_ready_bundled')
        : t('step3_ready_generic');
    }
    if (nextBtn) nextBtn.disabled = false;
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
    if (nextBtn) {
      nextBtn.disabled = false;
      nextBtn.onclick = installDependencies;
      nextBtn.innerHTML = `<span>${t('retry_install')}</span><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.34-5.66M4 4v6h6"/></svg>`;
    }
  }
  
  document.getElementById('step3Buttons').style.display = 'flex';
}

// Step 3: 配置
async function setupConfiguration() {
  const configStatus = document.getElementById('configStatus');
  const nextBtn = document.getElementById('step4Next');
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.onclick = window.nextStep;
    nextBtn.innerHTML = `<span>${t('btn_continue_install')}</span><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
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
          <div>
            <div class="status-label">${t('config_done')}</div>
            <div class="status-detail">${t('step4_result_folder')}: ${localFolder}</div>
          </div>
        </div>
      </div>
    `;
    if (nextBtn) nextBtn.disabled = false;
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
    if (nextBtn) {
      nextBtn.disabled = false;
      nextBtn.onclick = setupConfiguration;
      nextBtn.innerHTML = `<span>${t('retry_install')}</span><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.34-5.66M4 4v6h6"/></svg>`;
    }
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

window.acknowledgeInstallation = function() {
  ipcRenderer.invoke('quit-app');
};

window.openSecuritySettings = async function(options = {}) {
  const result = await ipcRenderer.invoke('open-security-settings');
  if ((!result || !result.success) && !options.silent) {
    showToast((result && result.error) || t('install_failed'), 'error');
    return;
  }
  if (installerMockMode && !options.silent) {
    showToast(t('btn_open_security'), 'success');
    setTimeout(() => {
      runPermissionWarmupCheck();
    }, 280);
  }
};

window.recheckRuntimePermissions = function() {
  runPermissionWarmupCheck();
};

// Step 6: 完成
// 自动进入最后一步并开始配置服务器
window.finishInstallation = async function() {
  if (isFinishingInstallation) {
    return;
  }
  isFinishingInstallation = true;

  try {
    // 安装最后一步：完成剩余配置，并以自启动拉起服务器作为最终验收。
    setFinalStepVisualState('loading');
    setFinalStepButtonVisible(false);
    
    // 步骤 1：如果是 iCloud 模式，配置文件夹为"始终保留下载"
    if (selectedMode === 'icloud') {
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
    
    // 步骤 2：安装最后一步，前置处理运行时权限并验证自启动。
    const finalizeResult = await ipcRenderer.invoke('finalize-installation', installPath, { skipWarmup: true });
    
    if (finalizeResult.success) {
      // 配置成功：显示成功图标和确认按钮，等待用户确认关闭
      setFinalStepVisualState('success');
      setFinalStepButtonVisible(true);
    } else {
      // 自启动失败即视为安装失败，直接展示错误详情。
      console.warn('安装最后一步失败:', finalizeResult.error);
      setFinalStepVisualState('error');
      setFinalStepButtonVisible(true);
      showErrorDetailModal(finalizeResult.detail || finalizeResult.error || '', t('install_failed'));
    }
  } catch (err) {
    // 出错时同样展示失败态和详情弹窗
    setFinalStepVisualState('error');
    setFinalStepButtonVisible(true);
    console.error('配置自启动失败:', err);
    showErrorDetailModal(err && err.message ? err.message : String(err), t('install_failed'));
  } finally {
    isFinishingInstallation = false;
  }
}

function extractErrorLog(logText) {
  const source = (logText || '').replace(/\r\n/g, '\n');
  if (
    source.includes('系统设置 -> 隐私与安全性 -> 安全性') ||
    source.includes('Open Anyway') ||
    source.includes('可执行文件:')
  ) {
    return source.trim() || '（无日志）';
  }
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
  await hydrateInstallerEnv();
  applyLanguage();
  initMockUI();
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

  await detectProjectRoot();
});

window.addEventListener('focus', () => {
  if (currentStep === 5 && permissionNeedsApproval && !permissionCheckInFlight) {
    permissionFocusRetryTimer = setTimeout(() => {
      runPermissionWarmupCheck({ triggeredByFocus: true });
    }, 400);
  }
});
