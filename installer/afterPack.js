const fs = require('fs');
const path = require('path');

// 只保留的语言
const keepLanguages = ['en', 'en_GB', 'zh_CN', 'zh_TW'];

exports.default = async function(context) {
  const appOutDir = context.appOutDir;
  const electronFrameworkPath = path.join(
    appOutDir,
    'ScreenSync Installer.app',
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources'
  );

  if (!fs.existsSync(electronFrameworkPath)) {
    console.log('Electron Framework Resources not found, skipping language cleanup');
    return;
  }

  console.log('🧹 Cleaning up unnecessary language packs...');
  
  const items = fs.readdirSync(electronFrameworkPath);
  let removedCount = 0;
  let removedSize = 0;

  for (const item of items) {
    if (item.endsWith('.lproj')) {
      const langCode = item.replace('.lproj', '');
      if (!keepLanguages.includes(langCode)) {
        const lprojPath = path.join(electronFrameworkPath, item);
        try {
          const stats = fs.statSync(lprojPath);
          if (stats.isDirectory()) {
            // 计算目录大小
            const files = fs.readdirSync(lprojPath);
            for (const file of files) {
              const filePath = path.join(lprojPath, file);
              const fileStats = fs.statSync(filePath);
              removedSize += fileStats.size;
            }
          }
          fs.rmSync(lprojPath, { recursive: true, force: true });
          removedCount++;
        } catch (e) {
          console.warn(`  Failed to remove ${item}: ${e.message}`);
        }
      }
    }
  }

  console.log(`  ✅ Removed ${removedCount} language packs (${(removedSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  ✅ Kept: ${keepLanguages.join(', ')}`);
};
