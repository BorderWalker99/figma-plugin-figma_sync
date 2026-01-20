const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// Alert 弹窗控制
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
      <div style="font-size:12px;opacity:0.9;margin-bottom:8px;">无法自动定位安装包位置，请手动选择解压后的 "ScreenSync-UserPackage" 文件夹。</div>
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
  ffmpeg: null
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
  actionBtn.innerHTML = '<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> 检测中...';
  
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
      ffmpeg: null
    };
    
    // 检查 Homebrew
    const homebrewCheck = checks.children[0];
    const homebrewResult = await ipcRenderer.invoke('check-homebrew');
    dependencyStatus.homebrew = homebrewResult.installed;
    
    if (homebrewResult.installed) {
      homebrewCheck.className = 'status-item success';
      homebrewCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">Homebrew</div>
          <div class="status-detail">已安装</div>
        </div>
      `;
    } else {
      homebrewCheck.className = 'status-item error';
      homebrewCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">Homebrew</div>
          <div class="status-detail">未安装</div>
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
          <div class="status-detail">已安装</div>
        </div>
      `;
    } else {
      nodeCheck.className = 'status-item error';
      nodeCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">Node.js</div>
          <div class="status-detail">未安装</div>
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
          <div class="status-detail">已安装</div>
        </div>
      `;
    } else {
      imageMagickCheck.className = 'status-item error';
      imageMagickCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">ImageMagick</div>
          <div class="status-detail">未安装</div>
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
          <div class="status-detail">已安装</div>
        </div>
      `;
    } else {
      ffmpegCheck.className = 'status-item error';
      ffmpegCheck.innerHTML = `
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">FFmpeg</div>
          <div class="status-detail">未安装</div>
        </div>
      `;
    }
    
    // 判断是否所有依赖都已安装
    const allInstalled = dependencyStatus.homebrew && dependencyStatus.node && dependencyStatus.imagemagick && dependencyStatus.ffmpeg;
    
    actionBtn.disabled = false;
    
    if (allInstalled) {
      // 所有依赖已安装，显示下一步按钮（有 icon，恢复默认 padding）
      actionBtn.innerHTML = '下一步 <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
      actionBtn.style.padding = '10px 12px 10px 20px';
      actionBtn.onclick = window.nextStep;
      // 确保样式是 primary
      actionBtn.className = 'btn btn-primary';
    } else {
      // 有依赖未安装，显示立即安装按钮（无 icon，左右 padding 对称）
      actionBtn.innerHTML = '立即安装';
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = installMissingDependencies;
      // 保持 primary 样式，引导用户点击
      actionBtn.className = 'btn btn-primary';
    }
  } catch (error) {
    console.error('Environment check failed:', error);
    showToast('环境检查失败: ' + error.message, 'error');
    
    // 出错时允许重试
    actionBtn.disabled = false;
    actionBtn.innerHTML = '重新检测';
    actionBtn.onclick = checkSystemRequirements;
  }
}

// 移除 recheckDependencies 函数，因为逻辑已合并到 checkSystemRequirements
// 如果有其他地方调用 recheckDependencies (例如HTML onclick)，在新的 HTML 中已经去掉了
// 但为了兼容性（如果有遗漏），可以保留一个别名
window.recheckDependencies = checkSystemRequirements;

// 安装缺失的依赖
async function installMissingDependencies() {
  const actionBtn = document.getElementById('step2ActionBtn');
  
  // 设置按钮为安装中状态
  actionBtn.disabled = true;
  actionBtn.classList.add('keep-raised');
  actionBtn.innerHTML = '<svg class="spinner" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> 正在安装...';
  
  try {
    // 调用一键安装所有缺失的依赖
    const result = await ipcRenderer.invoke('install-all-dependencies', dependencyStatus);
    
    if (result.success) {
      // 显示后端返回的详细消息
      showToast(result.message || '安装已启动', 'success');
      
      // 显示重新检测按钮，让用户在安装完成后点击（无 icon，左右 padding 对称）
      actionBtn.disabled = false;
      actionBtn.classList.remove('keep-raised');
      actionBtn.innerHTML = '重新检测';
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = checkSystemRequirements;
    } else {
      // 显示错误信息（已处理"已取消安装"的情况）
      showToast(result.error || '安装失败', 'error');
      
      // 恢复按钮状态（无 icon，左右 padding 对称）
      actionBtn.disabled = false;
      actionBtn.classList.remove('keep-raised');
      actionBtn.innerHTML = '立即安装';
      actionBtn.style.padding = '10px 20px';
      actionBtn.onclick = installMissingDependencies;
    }
  } catch (error) {
    console.error('安装依赖失败:', error);
    showToast('安装失败: ' + error.message, 'error');
    
    // 恢复按钮状态（无 icon，左右 padding 对称）
    actionBtn.disabled = false;
    actionBtn.classList.remove('keep-raised');
    actionBtn.innerHTML = '立即安装';
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
    statusLabel.textContent = '正在安装依赖...';
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
      statusLabel.textContent = '依赖安装完成';
    }
    document.getElementById('step3Next').disabled = false;
  } else {
    // 显示红色错误通知栏
    errorAlert.innerHTML = `
      <div class="alert alert-error">
        <div class="alert-icon" style="flex-shrink: 0; color: var(--danger);">
          <svg viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="currentColor"/>
            <path d="M12 8v5M12 16.5v.5" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div>
          <div style="font-weight: 600; margin-bottom: 4px;">依赖安装失败</div>
          <div style="opacity: 0.9; font-size: 12px; white-space: pre-wrap; word-break: break-word;">${result.error}</div>
        </div>
      </div>`;
    errorAlert.style.display = 'block';
    
    // 重置进度条
    progressBar.style.width = '0%';
    if (statusLabel) {
      statusLabel.textContent = '安装失败';
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
  
  const configResult = await ipcRenderer.invoke('setup-config', installPath, selectedMode, localFolder);
  
  if (configResult.success) {
    userId = configResult.userId;
    
    // 根据模式决定是否显示用户ID
    // 配置完成后，不再显示 User ID（简化界面）
    configStatus.innerHTML = `
      <div class="status-item success">
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">配置完成</div>
        </div>
      </div>
    `;
    document.getElementById('step4Next').disabled = false;
  } else {
    configStatus.innerHTML = `
      <div class="status-item error">
        <div class="status-icon"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></div>
        <div class="status-content">
          <div class="status-label">配置失败</div>
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
    button.textContent = '正在启动服务器';
    
    // 步骤 1：先手动启动服务器（确保依赖已安装且服务正常）
    const startResult = await ipcRenderer.invoke('start-server', installPath);
    
    if (!startResult.success) {
      // 启动失败
      button.classList.remove('keep-raised');
      button.disabled = false;
      button.textContent = originalText;
      showToast('服务器启动失败', 'error');
      console.error('服务器启动失败:', startResult.error);
      return; // 提前返回，不配置自启动
    }
    
    // 步骤 2：如果是 iCloud 模式，配置文件夹为"始终保留下载"
    if (selectedMode === 'icloud') {
      button.textContent = '正在配置 iCloud 文件夹';
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
    button.textContent = '正在配置自启动';
    const autostartResult = await ipcRenderer.invoke('setup-autostart', installPath);
    
    if (autostartResult.success) {
      // 配置成功
      button.textContent = '配置完成';
      showToast('服务自启动已配置完成', 'success');
      
      // 延迟1.5秒后关闭，让用户看到成功消息
      setTimeout(() => {
        ipcRenderer.invoke('quit-app');
      }, 1500);
    } else {
      // 配置自启动失败，但服务器已启动
      console.warn('自启动配置失败:', autostartResult.error);
      button.textContent = '启动成功（自启失败）';
      showToast('服务器已启动', 'warning');
      
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
    showToast('配置失败', 'error');
    console.error('配置自启动失败:', err);
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 立即显示第一步（封面页），确保 Header 隐藏
  showStep(1);
  
  // 自动检测项目根目录（后台运行，不阻塞 UI）
  const success = await detectProjectRoot();
});
