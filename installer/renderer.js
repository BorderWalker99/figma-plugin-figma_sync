const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

let currentStep = 1;
let installPath = '';
let selectedMode = '';
let userId = '';

// 步骤管理
function showStep(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step${step}`).classList.add('active');
  
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
  // 如果是 Step 1 且选择了 iCloud 模式，检查空间
  if (currentStep === 1 && selectedMode === 'icloud') {
    if (icloudSpaceAvailable === false) {
      // 空间不足，弹出错误 toast
      showToast('iCloud 空间不足，建议选择 Google Cloud 模式', 'error');
      return; // 阻止进入下一步
    }
  }
  
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
    if (detectedPath && fs.existsSync(path.join(detectedPath, 'package.json'))) {
      installPath = detectedPath;
      console.log('✅ 自动检测到项目目录:', installPath);
      return true;
    } else {
      console.warn('⚠️ 未找到 package.json，使用检测到的路径:', detectedPath);
      installPath = detectedPath;
      return false;
    }
  } catch (error) {
    console.error('❌ 检测项目目录失败:', error);
    return false;
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

// Step 1: 系统检查（自动开始）
async function checkSystemRequirements() {
  const checks = document.getElementById('systemChecks');
  
  // 检查 Homebrew
  const homebrewCheck = checks.children[0];
  const homebrewResult = await ipcRenderer.invoke('check-homebrew');
  
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
    // 添加安装按钮
    const installBtn = document.createElement('button');
    installBtn.className = 'btn btn-secondary';
    installBtn.textContent = '安装 Homebrew';
    installBtn.style.marginLeft = '12px';
    installBtn.onclick = async () => {
      installBtn.disabled = true;
      installBtn.textContent = '正在打开终端...';
      const result = await ipcRenderer.invoke('install-homebrew');
      if (result.success) {
        if (result.needsRestart) {
          // 终端已打开，用户需要完成安装
          showToast(result.message || '终端已打开，请按照提示完成安装', 'loading');
          
          // 更新按钮文本
          installBtn.textContent = '重新检测';
          installBtn.disabled = false;
          installBtn.onclick = async () => {
            // 重新检查 Homebrew
            const checkResult = await ipcRenderer.invoke('check-homebrew');
            if (checkResult.installed) {
              homebrewCheck.className = 'status-item success';
              homebrewCheck.innerHTML = `
                <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
                <div class="status-content">
                  <div class="status-label">Homebrew</div>
                  <div class="status-detail">已安装</div>
                </div>
              `;
              showToast('Homebrew 安装成功！', 'success');
              checkSystemRequirements(); // 重新检查所有依赖
            } else {
              showToast('Homebrew 尚未安装完成，请在终端中完成安装后再检测', 'error');
            }
          };
        } else {
          homebrewCheck.className = 'status-item success';
          homebrewCheck.innerHTML = `
            <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
            <div class="status-content">
              <div class="status-label">Homebrew</div>
              <div class="status-detail">已安装</div>
            </div>
          `;
          checkSystemRequirements(); // 重新检查
        }
      } else {
        showToast(result.error || '无法打开终端安装 Homebrew', 'error');
        if (result.manualCommand) {
          // 显示手动安装命令
          showToast('请手动在终端中运行此命令安装 Homebrew', 'error');
        }
        installBtn.disabled = false;
        installBtn.textContent = '安装 Homebrew';
      }
    };
    homebrewCheck.appendChild(installBtn);
  }
  
  // 检查 Node.js
  const nodeCheck = checks.children[1];
  const nodeResult = await ipcRenderer.invoke('check-node');
  
  if (nodeResult.installed) {
    nodeCheck.className = 'status-item success';
    nodeCheck.innerHTML = `
      <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
      <div class="status-content">
        <div class="status-label">Node.js</div>
        <div class="status-detail">${nodeResult.version}</div>
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
    // 添加安装按钮
    const installBtn = document.createElement('button');
    installBtn.className = 'btn btn-secondary';
    installBtn.textContent = '安装 Node.js';
    installBtn.style.marginLeft = '12px';
    installBtn.onclick = async () => {
      installBtn.disabled = true;
      installBtn.textContent = '正在打开终端...';
      const result = await ipcRenderer.invoke('install-node');
      if (result.success) {
        if (result.needsRestart) {
          // 终端已打开，用户需要等待安装完成
          showToast(result.message || '终端已打开，请等待 Node.js 安装完成', 'loading');
          
          // 更新按钮文本
          installBtn.textContent = '重新检测';
          installBtn.disabled = false;
          installBtn.onclick = async () => {
            // 重新检查 Node.js
            const checkResult = await ipcRenderer.invoke('check-node');
            if (checkResult.installed) {
              nodeCheck.className = 'status-item success';
              nodeCheck.innerHTML = `
                <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
                <div class="status-content">
                  <div class="status-label">Node.js</div>
                  <div class="status-detail">已安装 ${checkResult.version || ''}</div>
                </div>
              `;
              showToast('Node.js 安装成功！', 'success');
              checkSystemRequirements(); // 重新检查所有依赖
            } else {
              showToast('Node.js 尚未安装完成，请在终端中完成安装后再检测', 'error');
            }
          };
        } else {
          nodeCheck.className = 'status-item success';
          nodeCheck.innerHTML = `
            <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
            <div class="status-content">
              <div class="status-label">Node.js</div>
              <div class="status-detail">已安装</div>
            </div>
          `;
          checkSystemRequirements(); // 重新检查
        }
      } else {
        showToast(result.error || '无法打开终端安装 Node.js', 'error');
        installBtn.disabled = false;
        installBtn.textContent = '安装 Node.js';
      }
    };
    nodeCheck.appendChild(installBtn);
  }
  
  // 显示下一步按钮
  document.getElementById('step2Buttons').style.display = 'flex';
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
    statusLabel.textContent = '正在安装依赖（可能需要几分钟）';
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
    // 如果卡在初期，假装动一下进度条，让用户知道没死机
    if (currentProgress < 25) {
      updateUi(currentProgress + 0.5, data.message);
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
    ? path.join(installPath, 'ScreenSyncImg')
    : path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/ScreenSyncImg');
  
  const configResult = await ipcRenderer.invoke('setup-config', installPath, selectedMode, localFolder);
  
  if (configResult.success) {
    userId = configResult.userId;
    
    // 根据模式决定是否显示用户ID
    let userIdDisplay = '';
    if (selectedMode === 'drive') {
      // Google模式：显示用户ID和复制按钮
      userIdDisplay = `
        <div class="status-detail" style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
          <span>您的 User ID：${userId}</span>
          <button onclick="copyUserId('${userId}')" style="background: transparent; border: none; cursor: pointer; padding: 4px; display: flex; align-items: center; color: var(--text-secondary); transition: color 0.2s;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-secondary)'" title="复制User ID">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px;" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>`;
    }
    // iCloud模式：不显示用户ID
    
    configStatus.innerHTML = `
      <div class="status-item success">
        <div class="status-icon"><svg viewBox="0 0 24 24"><polyline points="20 7 9 18 4 13"></polyline></svg></div>
        <div class="status-content">
          <div class="status-label">配置完成</div>
          ${userIdDisplay}
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
    showToast('User ID 已复制到剪贴板', 'success');
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
    // 显示配置中状态
    button.disabled = true;
    button.textContent = '正在配置自动启动...';
    
    // 配置服务器自动启动
    const result = await ipcRenderer.invoke('setup-autostart', installPath);
    
    if (result.success) {
      // 配置成功
      button.textContent = '配置完成！';
      showToast(result.message || '服务器已配置为自动启动', 'success');
      
      // 延迟1.5秒后关闭，让用户看到成功消息
      setTimeout(() => {
        window.close();
      }, 1500);
    } else {
      // 配置失败，尝试手动启动服务器作为备选
      console.warn('自动启动配置失败:', result.error);
      button.textContent = '正在启动服务器...';
      
      const startResult = await ipcRenderer.invoke('start-server', installPath);
      
      if (startResult.success) {
        button.textContent = '启动成功！';
        showToast('服务器已启动（本次会话）', 'success');
        setTimeout(() => {
          window.close();
        }, 1500);
      } else {
        // 两种方式都失败
        button.disabled = false;
        button.textContent = originalText;
        showToast('配置失败，请在重启后手动启动', 'error');
        console.error('服务器启动失败:', startResult.error);
      }
    }
  } catch (err) {
    // 出错，恢复按钮状态
    button.disabled = false;
    button.textContent = originalText;
    showToast('配置失败，请重试或重启电脑', 'error');
    console.error('配置自动启动失败:', err);
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 自动检测项目根目录
  await detectProjectRoot();
  
  // 从步骤 1 开始（选择同步模式）
  showStep(1);
});
