#!/bin/bash

# FigmaSync Web 部署脚本
# 一键部署到静态托管，支持自动更新

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  FigmaSync Web 部署脚本               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 配置
DEPLOY_DIR="./deploy-web"
VERSION=$(date +"%Y%m%d-%H%M%S")
# 如果设置了 VERCEL_URL，自动使用 Vercel 地址
if [ -n "$VERCEL_URL" ]; then
    CDN_BASE_URL="https://${VERCEL_URL}"
else
    CDN_BASE_URL="${CDN_BASE_URL:-https://your-cdn-domain.com/figmasync}"  # 修改为你的 CDN 地址
fi
GITHUB_REPO="${GITHUB_REPO:-BorderWalker99/figma-plugin-figma_sync}"  # GitHub 仓库

# 检查必要的文件
if [ ! -d "figma-plugin" ]; then
    echo -e "${RED}❌ 未找到 figma-plugin 目录${NC}"
    exit 1
fi

# 创建部署目录
if [ -d "$DEPLOY_DIR" ]; then
    rm -rf "$DEPLOY_DIR"
fi
mkdir -p "$DEPLOY_DIR"

echo -e "${GREEN}📦 开始打包...${NC}\n"

# 1. 复制 Figma 插件文件
echo -e "${YELLOW}🎨 复制 Figma 插件文件...${NC}"
mkdir -p "$DEPLOY_DIR/figma-plugin"
cp figma-plugin/manifest.json "$DEPLOY_DIR/figma-plugin/"
cp figma-plugin/code.js "$DEPLOY_DIR/figma-plugin/"

# 注意：图片资源现在直接从 GitHub 加载，不再需要复制本地 images 文件夹
# 所有图片 URL 已在 ui.html 中使用 GitHub raw URL


# 2. 创建版本信息文件
echo -e "${YELLOW}📋 创建版本信息...${NC}"
cat > "$DEPLOY_DIR/version.json" << EOF
{
  "version": "${VERSION}",
  "releaseDate": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "plugin": {
    "manifest": "${CDN_BASE_URL}/figma-plugin/manifest.json",
    "code": "${CDN_BASE_URL}/figma-plugin/code.js",
    "ui": "${CDN_BASE_URL}/figma-plugin/ui.html"
  },
  "server": {
    "package": "https://github.com/${GITHUB_REPO}/releases/latest/download/FigmaSync-UserPackage.tar.gz",
    "installScript": "${CDN_BASE_URL}/install.sh"
  }
}
EOF

# 3. 创建在线安装脚本
echo -e "${YELLOW}🔧 创建在线安装脚本...${NC}"
cat > "$DEPLOY_DIR/install.sh" << 'INSTALL_EOF'
#!/bin/bash

# FigmaSync 在线安装脚本
# 自动下载并安装最新版本

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  FigmaSync 在线安装                   ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"

# 获取版本信息
VERSION_URL="${CDN_BASE_URL:-https://your-cdn-domain.com/figmasync}/version.json"
echo -e "${YELLOW}📥 获取最新版本信息...${NC}"

if command -v curl &> /dev/null; then
    VERSION_INFO=$(curl -s "$VERSION_URL")
elif command -v wget &> /dev/null; then
    VERSION_INFO=$(wget -qO- "$VERSION_URL")
else
    echo -e "${RED}❌ 需要 curl 或 wget 来下载文件${NC}"
    exit 1
fi

VERSION=$(echo "$VERSION_INFO" | grep -o '"version": "[^"]*' | cut -d'"' -f4)
echo -e "${GREEN}✅ 最新版本: ${VERSION}${NC}\n"

# 下载服务器包
DOWNLOAD_URL=$(echo "$VERSION_INFO" | grep -o '"package": "[^"]*' | cut -d'"' -f4)
TEMP_DIR=$(mktemp -d)
PACKAGE_FILE="$TEMP_DIR/figmasync.tar.gz"

echo -e "${YELLOW}📥 下载服务器包...${NC}"
if command -v curl &> /dev/null; then
    curl -L -o "$PACKAGE_FILE" "$DOWNLOAD_URL"
elif command -v wget &> /dev/null; then
    wget -O "$PACKAGE_FILE" "$DOWNLOAD_URL"
fi

# 解压并安装
INSTALL_DIR="$HOME/FigmaSync"
echo -e "${YELLOW}📦 解压到 ${INSTALL_DIR}...${NC}"
mkdir -p "$INSTALL_DIR"
tar -xzf "$PACKAGE_FILE" -C "$INSTALL_DIR" --strip-components=1

# 运行安装脚本
echo -e "${YELLOW}🔧 运行安装脚本...${NC}"
cd "$INSTALL_DIR"
chmod +x install-and-run.sh
./install-and-run.sh

# 清理临时文件
rm -rf "$TEMP_DIR"

echo -e "\n${GREEN}✅ 安装完成！${NC}"
echo -e "${BLUE}💡 提示：Figma 插件可以通过以下 URL 安装：${NC}"
PLUGIN_URL=$(echo "$VERSION_INFO" | grep -o '"manifest": "[^"]*' | cut -d'"' -f4)
echo -e "${YELLOW}   ${PLUGIN_URL}${NC}\n"
INSTALL_EOF

chmod +x "$DEPLOY_DIR/install.sh"

# 4. 创建更新检查脚本（供服务器代码使用）
echo -e "${YELLOW}🔄 创建更新检查脚本...${NC}"
cat > "$DEPLOY_DIR/check-update.js" << 'UPDATE_EOF'
// 更新检查脚本
// 在服务器启动时检查是否有新版本

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const VERSION_URL = process.env.VERSION_URL || 'https://your-cdn-domain.com/figmasync/version.json';
const CURRENT_VERSION_FILE = path.join(__dirname, 'VERSION.txt');

function getCurrentVersion() {
  try {
    if (fs.existsSync(CURRENT_VERSION_FILE)) {
      const content = fs.readFileSync(CURRENT_VERSION_FILE, 'utf8');
      const match = content.match(/版本:\s*([^\n]+)/);
      return match ? match[1].trim() : null;
    }
  } catch (error) {
    // 忽略错误
  }
  return null;
}

function checkUpdate() {
  return new Promise((resolve, reject) => {
    const url = new URL(VERSION_URL);
    const client = url.protocol === 'https:' ? https : http;
    
    client.get(VERSION_URL, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const versionInfo = JSON.parse(data);
          const currentVersion = getCurrentVersion();
          
          if (currentVersion && currentVersion === versionInfo.version) {
            console.log(`✅ 当前版本已是最新: ${currentVersion}`);
            resolve({ hasUpdate: false, currentVersion, latestVersion: versionInfo.version });
          } else {
            console.log(`🔄 发现新版本: ${versionInfo.version} (当前: ${currentVersion || '未知'})`);
            console.log(`   下载地址: ${versionInfo.server.package}`);
            resolve({ 
              hasUpdate: true, 
              currentVersion, 
              latestVersion: versionInfo.version,
              downloadUrl: versionInfo.server.package
            });
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

// 如果直接运行此脚本
if (require.main === module) {
  checkUpdate()
    .then((result) => {
      if (result.hasUpdate) {
        console.log('\n💡 提示：运行以下命令更新：');
        console.log(`   curl -L ${result.downloadUrl} | tar -xz`);
        process.exit(1);
      } else {
        process.exit(0);
      }
    })
    .catch((error) => {
      console.error('❌ 检查更新失败:', error.message);
      process.exit(0); // 更新检查失败不影响运行
    });
}

module.exports = { checkUpdate, getCurrentVersion };
UPDATE_EOF

# 5. 创建 README
echo -e "${YELLOW}📖 创建部署说明...${NC}"
cat > "$DEPLOY_DIR/README.md" << 'README_EOF'
# FigmaSync Web 部署

## 部署步骤

### 1. 配置 CDN 地址

编辑 `deploy-web.sh`，修改以下变量：
- `CDN_BASE_URL`: 你的 CDN 基础地址
- `GITHUB_REPO`: 你的 GitHub 仓库地址

### 2. 部署到静态托管

#### 选项 A: GitHub Pages

```bash
# 1. 创建 gh-pages 分支
git checkout -b gh-pages

# 2. 复制部署文件
cp -r deploy-web/* .

# 3. 提交并推送
git add .
git commit -m "Deploy version ${VERSION}"
git push origin gh-pages
```

#### 选项 B: Vercel

```bash
# 安装 Vercel CLI
npm i -g vercel

# 部署
cd deploy-web
vercel --prod
```

#### 选项 C: Netlify

```bash
# 安装 Netlify CLI
npm i -g netlify-cli

# 部署
cd deploy-web
netlify deploy --prod
```

### 3. 上传服务器包到 GitHub Releases

```bash
# 打包服务器代码
./package-for-distribution.sh

# 创建 GitHub Release 并上传
gh release create v${VERSION} FigmaSync-UserPackage.tar.gz --title "Version ${VERSION}"
```

## 用户使用

### 在线安装

用户只需运行：

```bash
curl -fsSL https://your-cdn-domain.com/figmasync/install.sh | bash
```

### Figma 插件安装

1. 打开 Figma Desktop
2. Plugins → Development → Import plugin from manifest
3. 输入 URL: `https://your-cdn-domain.com/figmasync/figma-plugin/manifest.json`

## 自动更新

服务器代码会在启动时自动检查更新。如果发现新版本，会在控制台提示用户更新。
README_EOF

# 6. 显示部署信息
echo -e "\n${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  打包完成！                            ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}\n"
echo -e "${GREEN}✅ 版本: ${VERSION}${NC}"
echo -e "${GREEN}✅ 部署目录: ${DEPLOY_DIR}${NC}\n"

echo -e "${YELLOW}📦 包含内容：${NC}"
echo "   - Figma 插件文件（可在线安装）"
echo "   - version.json（版本信息）"
echo "   - install.sh（在线安装脚本）"
echo "   - check-update.js（更新检查脚本）"
echo ""

echo -e "${BLUE}🚀 下一步：${NC}"
echo "   1. 将 ${DEPLOY_DIR} 目录部署到静态托管（GitHub Pages/Vercel/Netlify）"
echo "   2. 运行 ./package-for-distribution.sh 打包服务器代码"
echo "   3. 上传服务器包到 GitHub Releases"
echo "   4. 更新 deploy-web.sh 中的 CDN_BASE_URL 和 GITHUB_REPO"
echo ""

echo -e "${YELLOW}💡 用户安装命令：${NC}"
echo "   curl -fsSL ${CDN_BASE_URL}/install.sh | bash"
echo ""

