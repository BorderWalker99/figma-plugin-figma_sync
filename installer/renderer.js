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
    btn_copy: '一键复制',
    step2_title: '环境检查',
    step2_desc: '检查系统环境是否满足运行要求',
    step3_title: '安装依赖',
    step3_desc: '安装项目所需的依赖包，请保持网络畅通',
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
    log_copied: '日志已复制',
    error_detail_title: '失败详情',
    error_detail_subtitle: '请复制发给开发者',
    alert_title: '提示',
    all_installed_next: '所有依赖已安装',
    install_missing: '安装缺失依赖',
    downloading_deps: '正在下载依赖包...',
  },
  en: {
    welcome_subtitle: 'Automate screenshot transfer & organization',
    btn_start_install: 'Start Install',
    btn_next: 'Next',
    btn_done: 'Got it',
    btn_checking: 'Checking...',
    btn_copy: 'Copy',
    step2_title: 'Environment Check',
    step2_desc: 'Verify system requirements are met',
    step3_title: 'Install Dependencies',
    step3_desc: 'Installing required packages, keep network connected',
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
    log_copied: 'Log copied',
    error_detail_title: 'Error Details',
    error_detail_subtitle: 'Please copy and send to the developer',
    alert_title: 'Notice',
    all_installed_next: 'All dependencies installed',
    install_missing: 'Install missing dependencies',
    downloading_deps: 'Downloading dependencies...',
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
    // ====== 首先检查 macOS 版本 ======
    const macosInfo = await ipcRenderer.invoke('get-macos-version');
    console.log('macOS 版本:', macosInfo);
    
    // 显示 macOS 版本警告（如果需要）
    if (macosInfo.supported === false) {
      // macOS 10.15 或更早：完全不支持
      const oldSystemWarning = `⚠️ 检测到 macOS ${macosInfo.version} (${macosInfo.name})

Homebrew 不支持此系统版本，自动安装将会失败。

📋 手动安装方案：
1. Node.js：访问 nodejs.org 下载官方 .pkg 安装包
2. ImageMagick：下载官方二进制包或使用 MacPorts
3. FFmpeg：从 evermeet.cx 下载静态编译版本

💡 或者，强烈建议升级到 macOS 14 (Sonoma) 或更高版本。`;
      
      showToast(oldSystemWarning, 'error');
      
      // 存储系统信息供后续使用
      window.macosInfo = macosInfo;
    } else if (macosInfo.supported === 'limited') {
      // macOS 11-13：有限支持
      const limitedWarning = `⚠️ 检测到 macOS ${macosInfo.version} (${macosInfo.name})

Homebrew 对此版本仅提供有限支持。

⏱️ 预期情况：
- 依赖安装可能需要从源码编译
- 首次安装可能需要 10-30 分钟
- 需要安装 Xcode Command Line Tools

✅ 可以继续使用 Homebrew 安装（推荐）
📋 或查看手动安装方案（见文档）

推荐升级到 macOS 14+ 以获得最佳体验。`;
      
      showToast(limitedWarning, 'warning');
      
      // 存储系统信息供后续使用
      window.macosInfo = macosInfo;
    }
    // macOS 14+ 不显示警告
    
    // 重置状态
    dependencyStatus = {
      homebrew: null,
      node: null,
      imagemagick: null,
      ffmpeg: null,
      gifsicle: null
    };
    
    // 检查 Homebrew
    const homebrewCheck = checks.children[0];
    const homebrewResult = await ipcRenderer.invoke('check-homebrew');
    dependencyStatus.homebrew = homebrewResult.installed;
    
    if (homebrewResult.skipped) {
      // Legacy macOS: Homebrew not needed, direct download mode
      homebrewCheck.className = 'status-item success';
      homebrewCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">Homebrew</div>
          <div class="status-detail" style="color: var(--text-tertiary);">${t('no_homebrew')}</div>
        </div>
      `;
    } else if (homebrewResult.installed) {
      homebrewCheck.className = 'status-item success';
      homebrewCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">Homebrew</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else {
      homebrewCheck.className = 'status-item error';
      homebrewCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">Homebrew</div>
          <div class="status-detail" style="color: var(--danger);">${t('not_installed')}</div>
        </div>
      `;
    }
    
    // 检查 Node.js
    const nodeCheck = checks.children[1];
    const nodeResult = await ipcRenderer.invoke('check-node');
    dependencyStatus.node = nodeResult.installed;
    
    if (nodeResult.installed) {
      nodeCheck.className = 'status-item success';
      nodeCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">Node.js</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else {
      nodeCheck.className = 'status-item error';
      nodeCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">Node.js</div>
          <div class="status-detail" style="color: var(--danger);">${t('not_installed')}</div>
        </div>
      `;
    }
    
    // 检查 ImageMagick
    const imageMagickCheck = checks.children[2];
    const imageMagickResult = await ipcRenderer.invoke('check-imagemagick');
    dependencyStatus.imagemagick = imageMagickResult.installed;
    
    if (imageMagickResult.installed) {
      imageMagickCheck.className = 'status-item success';
      imageMagickCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">ImageMagick</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else {
      imageMagickCheck.className = 'status-item error';
      imageMagickCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">ImageMagick</div>
          <div class="status-detail" style="color: var(--danger);">${t('not_installed')}</div>
        </div>
      `;
    }
    
    // 检查 FFmpeg
    const ffmpegCheck = checks.children[3];
    const ffmpegResult = await ipcRenderer.invoke('check-ffmpeg');
    dependencyStatus.ffmpeg = ffmpegResult.installed;
    
    if (ffmpegResult.installed) {
      ffmpegCheck.className = 'status-item success';
      ffmpegCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">FFmpeg</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else {
      ffmpegCheck.className = 'status-item error';
      ffmpegCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">FFmpeg</div>
          <div class="status-detail" style="color: var(--danger);">${t('not_installed')}</div>
        </div>
      `;
    }
    
    // 检查 Gifsicle
    const gifsicleCheck = checks.children[4];
    const gifsicleResult = await ipcRenderer.invoke('check-gifsicle');
    dependencyStatus.gifsicle = gifsicleResult.installed;
    
    if (gifsicleResult.installed) {
      gifsicleCheck.className = 'status-item success';
      gifsicleCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">Gifsicle</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else {
      gifsicleCheck.className = 'status-item error';
      gifsicleCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">Gifsicle</div>
          <div class="status-detail" style="color: var(--danger);">${t('not_installed')}</div>
        </div>
      `;
    }
    
    // 判断是否所有依赖都已安装
    const allInstalled = dependencyStatus.homebrew && dependencyStatus.node && dependencyStatus.imagemagick && dependencyStatus.ffmpeg && dependencyStatus.gifsicle;
    
    actionBtn.disabled = false;
    
    if (allInstalled) {
      actionBtn.innerHTML = `${t('btn_next')} <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
      actionBtn.style.padding = '10px 12px 10px 20px';
      actionBtn.onclick = window.nextStep;
      actionBtn.className = 'btn btn-primary';
    } else {
      actionBtn.innerHTML = t('install_missing');
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = installMissingDependencies;
      actionBtn.className = 'btn btn-primary';
    }
  } catch (error) {
    console.error('Environment check failed:', error);
    showToast(error.message, 'error');
    
    actionBtn.disabled = false;
    actionBtn.innerHTML = t('btn_checking');
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

  // Mark uninstalled deps as "waiting"
  const depsToInstall = [];
  if (!dependencyStatus.homebrew) depsToInstall.push('homebrew');
  if (!dependencyStatus.node) depsToInstall.push('node');
  if (!dependencyStatus.imagemagick) depsToInstall.push('imagemagick');
  if (!dependencyStatus.ffmpeg) depsToInstall.push('ffmpeg');
  if (!dependencyStatus.gifsicle) depsToInstall.push('gifsicle');

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
      item.className = 'status-item success';
      item.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">${displayNames[dep]}</div>
          <div class="status-detail" style="color: var(--success);">${t('installed')}</div>
        </div>
      `;
    } else if (status === 'error') {
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
    const result = await ipcRenderer.invoke('install-all-dependencies', dependencyStatus);

    // Delay listener removal — IPC send is async, progress messages may still be in flight
    await new Promise(r => setTimeout(r, 300));
    ipcRenderer.removeListener('dep-install-progress', progressHandler);
    ipcRenderer.removeListener('dep-install-log', logHandler);

    if (result.success) {
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
      actionBtn.innerHTML = t('retry_install');
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
    actionBtn.innerHTML = t('retry_install');
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
  
  // 创建日志显示区域（默认隐藏，出错时显示）
  let logOutput = '';
  
  let currentProgress = 10;
  
  const updateUi = (progress, message) => {
    if (progress > currentProgress) {
      currentProgress = Math.min(progress, 95);
      progressBar.style.width = `${currentProgress}%`;
    }
    if (message && statusLabel) {
      statusLabel.textContent = message;
    }
  };
  
  // 监听安装输出
  ipcRenderer.on('install-output', (event, data) => {
    logOutput += data.data;
    // 实时更新进度（基于输出行数估算）
    const lines = logOutput.split('\n').length;
    // 提高灵敏度：每2行增加1%，上限90%
    const progress = 10 + (lines / 2);
    updateUi(progress);
  });
  
  // 监听心跳 (处理长时间无输出的情况)
  ipcRenderer.on('install-heartbeat', (event, data) => {
    // 只要未完成（< 95%），就让进度条缓慢蠕动，让用户知道没死机
    if (currentProgress < 95) {
      // 进度越接近95，移动越慢
      const increment = currentProgress < 50 ? 0.5 : 0.1;
      updateUi(currentProgress + increment, data.message);
    } else {
      updateUi(currentProgress, data.message);
    }
  });
  
  const result = await ipcRenderer.invoke('install-dependencies', installPath);
  
  // 移除监听器
  ipcRenderer.removeAllListeners('install-output');
  ipcRenderer.removeAllListeners('install-heartbeat');
  
  if (result.success) {
    progressBar.style.width = '100%';
    progressBar.classList.add('success');
    const statusLabel = document.getElementById('installStatusLabel');
    if (statusLabel) {
      statusLabel.textContent = t('deps_installed');
    }
    document.getElementById('step3Next').disabled = false;
  } else {
    logOutput += '\n--- 错误信息 ---\n' + (result.error || '未知错误');
    progressBar.style.width = '0%';
    if (statusLabel) {
      statusLabel.innerHTML = `<span style="color: var(--danger);">${t('install_failed')}</span><span style="display: inline-block; width: 12px;"></span><a id="viewErrorLink" href="#" style="color: var(--accent); font-size: 12px; text-decoration: underline; cursor: pointer;">${t('view_detail')}</a>`;
      document.getElementById('viewErrorLink').addEventListener('click', (e) => {
        e.preventDefault();
        showErrorDetailModal(logOutput);
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

// Error detail modal
function showErrorDetailModal(logText) {
  const overlay = document.getElementById('errorDetailOverlay');
  const content = document.getElementById('errorDetailContent');
  content.textContent = logText || '（无日志）';
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
      const text = document.getElementById('errorDetailContent').textContent;
      await ipcRenderer.invoke('copy-to-clipboard', text);
      showToast(t('log_copied'), 'success');
    });
  }

  const success = await detectProjectRoot();
});
