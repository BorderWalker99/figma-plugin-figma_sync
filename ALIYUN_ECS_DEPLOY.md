# 阿里云 ECS 部署指南

## 概述

为了在中国大陆网络环境下提供稳定的公网访问，建议将服务部署到阿里云 ECS（弹性计算服务）。这样可以：
- ✅ 避免 Google 服务的网络限制
- ✅ 提供稳定的公网访问地址
- ✅ 所有用户使用同一个 URL，无需配置
- ✅ 适合中国大陆用户使用

## 部署步骤

### 步骤 1：购买阿里云 ECS 实例

1. **登录阿里云控制台**
   - 访问：https://ecs.console.aliyun.com/
   - 使用阿里云账号登录

2. **创建 ECS 实例**
   - 点击 **创建实例**
   - **地域选择**：建议选择与 OSS Bucket 相同的地域
     - 如果 OSS Bucket 在 `oss-cn-beijing`，选择 **华北2（北京）**
     - 如果 OSS Bucket 在 `oss-cn-hangzhou`，选择 **华东1（杭州）**
   - **实例规格**：
     - 最低配置：1核2GB（适合测试）
     - 推荐配置：2核4GB（适合生产环境）
   - **镜像**：推荐选择 **Ubuntu 20.04** 或 **Ubuntu 22.04**（详见下方说明）
   - **网络**：选择 **专有网络 VPC**
   - **公网 IP**：选择 **分配公网 IPv4 地址**
   - **安全组**：创建新安全组或使用现有安全组

3. **配置安全组规则（端口/协议选择）**

   在创建实例时，会看到"开通IPv4端口/协议"界面，建议选择：

   **必须选择的端口：**
   - ✅ **SSH (TCP: 22)** - 必须勾选，用于 SSH 连接服务器
   - ✅ **ICMP (IPv4)** - 建议勾选，用于网络连通性测试（ping）

   **不需要选择的端口：**
   - ❌ **RDP (TCP: 3389)** - 不需要，这是 Windows 远程桌面端口（Linux 系统不需要）
   - ❌ **HTTP (TCP: 80)** - 可选，如果后续要配置域名和 Nginx 可以勾选
   - ❌ **HTTPS (TCP: 443)** - 可选，如果后续要配置 HTTPS 可以勾选

   **重要：应用端口 8888 需要手动添加**
   - 创建实例后，需要手动在安全组中添加端口 8888
   - 或创建实例时选择"自定义安全组"，然后手动配置

   **安全建议：**
   - ⚠️ SSH (22) 默认允许所有 IP 访问，存在安全风险
   - 创建实例后，建议立即修改安全组，限制 SSH 访问：
     - 只允许你的 IP 地址访问（例如：`你的IP/32`）
     - 或使用密钥对认证，禁用密码登录

4. **创建实例后配置应用端口**

   实例创建后，需要手动添加应用端口：

   - 进入 **ECS 控制台** → **实例** → 选择你的实例
   - 点击 **安全组** 标签
   - 点击安全组名称进入安全组规则
   - 点击 **添加安全组规则**
   - 配置规则：
     - **规则方向**：入方向
     - **授权策略**：允许
     - **协议类型**：自定义 TCP
     - **端口范围**：8888/8888
     - **授权对象**：0.0.0.0/0（允许所有 IP 访问，或限制为特定 IP）
     - **描述**：FigmaSync 应用端口
   - 点击 **保存**

   - 点击 **确定** 创建实例

### 步骤 1.6：管理设置配置

在创建实例时，会看到"管理设置"界面，建议配置如下：

#### 1. 登录凭证（推荐：密钥对）

**选项说明：**
- **密钥对**（推荐）：使用 SSH 密钥对登录，更安全
- **自定义密码**：使用密码登录，简单但不安全
- **创建后设置**：创建实例后再设置登录方式

**推荐选择：密钥对**

**如果选择密钥对：**
1. 点击 **创建密钥对** 按钮
2. 输入密钥对名称（例如：`figmasync-key`）
3. 选择 **自动创建密钥对**
4. 点击 **确定** 创建
5. 系统会自动下载私钥文件（`.pem` 格式），**请妥善保存**
6. 在"密钥对"下拉框中选择刚创建的密钥对

**密钥对的使用时机：**
- 密钥对在创建实例时选择，但**实际使用是在 SSH 连接时**
- 每次通过 SSH 连接到 ECS 实例时，都需要使用密钥对文件
- 无论是 root 还是 ecs-user，都使用同一个密钥对登录
- 密钥对文件需要保存在本地 Mac 上，用于后续所有连接

**如果选择自定义密码：**
1. 选择 **自定义密码**
2. 输入密码（建议使用强密码）
3. 确认密码

**安全建议：**
- ⚠️ 推荐使用密钥对，比密码更安全
- ⚠️ 如果使用密码，建议创建实例后立即修改
- ⚠️ 私钥文件只下载一次，请妥善保存

#### 2. 登录名

**选项说明：**
- **root**：系统管理员，拥有最高权限
- **ecs-user**：普通用户，权限受限（更安全）

**推荐选择：root（简单）或 ecs-user（更安全）**

**选择 root（简单，适合新手）：**
- ✅ 权限最高，操作方便
- ⚠️ 安全风险较高（如果密码泄露）
- 适合：测试环境或熟悉 Linux 的用户

**选择 ecs-user（更安全，推荐）：**
- ✅ 权限受限，更安全
- ⚠️ 某些操作可能需要 `sudo`
- 适合：生产环境

**建议：**
- 如果使用密钥对登录，可以选择 **root**（相对安全）
- 如果使用密码登录，建议选择 **ecs-user**（更安全）

#### 3. 标签（可选）

标签用于资源管理，可以暂时跳过，后续需要时再添加。

**配置总结：**

**推荐配置（使用密钥对）：**
```
登录凭证：密钥对
  └── 创建新密钥对或选择已有密钥对
  
登录名：root（简单）或 ecs-user（更安全）
```

**简单配置（使用密码）：**
```
登录凭证：自定义密码
  └── 设置密码
  
登录名：ecs-user（推荐，更安全）
```

### 步骤 1.5：为什么选择 Ubuntu？

**推荐 Ubuntu 的原因：**

1. **包管理简单**
   - Ubuntu 使用 `apt` 包管理器，命令简单直观
   - 软件包更新频繁，版本较新
   - 安装 Node.js 等软件更方便

2. **社区支持好**
   - Ubuntu 用户基数大，问题容易找到解决方案
   - 文档和教程丰富
   - 适合 Linux 新手

3. **Node.js 支持好**
   - NodeSource 官方提供 Ubuntu 安装脚本
   - 安装 Node.js 更简单

4. **资源占用相对较低**
   - 相比 CentOS，Ubuntu 系统资源占用更少
   - 适合小规格 ECS 实例

**其他可选操作系统：**

- **CentOS 7/8**：
  - 优点：企业级稳定性，Red Hat 兼容
  - 缺点：CentOS 8 已停止维护，CentOS 7 较老
  - 适合：熟悉 Red Hat 系列的用户

- **Alibaba Cloud Linux**：
  - 优点：阿里云优化，性能好，免费
  - 缺点：文档相对较少
  - 适合：追求性能和阿里云深度集成的用户

- **Debian**：
  - 优点：稳定、轻量
  - 缺点：软件包版本可能较旧
  - 适合：追求稳定性的用户

**建议：**
- **新手或追求简单**：选择 Ubuntu 20.04 或 22.04
- **熟悉 CentOS**：可以选择 CentOS 7（注意：CentOS 8 已停止维护）
- **追求性能**：可以选择 Alibaba Cloud Linux

### 步骤 2：连接到 ECS 实例

**重要：以下所有操作都在本地 Mac 的终端中执行**

1. **获取连接信息**
   - 在浏览器中打开阿里云 ECS 控制台
   - 找到刚创建的实例
   - 记录 **公网 IP 地址**（例如：`47.xxx.xxx.xxx`）
   - 如果使用密码登录，记录 **root 密码** 或 **ecs-user 密码**

2. **在 Mac 终端中 SSH 连接到实例**

   **打开 Mac 终端：**
   - 按 `Command + 空格` 打开 Spotlight
   - 输入 `终端` 或 `Terminal`
   - 回车打开终端应用

   **在 Mac 终端中执行以下命令：**

   **如果使用密钥对登录：**
   ```bash
   # 1. 进入密钥文件所在目录（例如：Downloads）
   cd ~/Downloads
   
   # 2. 设置密钥文件权限（必须，否则无法连接）
   chmod 400 你的密钥文件.pem
   
   # 3. 连接到 ECS 实例
   # 如果登录名是 root：
   ssh -i 你的密钥文件.pem root@你的ECS公网IP
   
   # 如果登录名是 ecs-user：
   ssh -i 你的密钥文件.pem ecs-user@你的ECS公网IP
   ```
   
   **示例：**
   ```bash
   # 假设密钥文件在 Downloads 文件夹，文件名为 figmasync-key.pem
   # ECS 公网 IP 是 47.96.123.45
   cd ~/Downloads
   chmod 400 figmasync-key.pem
   ssh -i figmasync-key.pem root@47.96.123.45
   ```
   
   **密钥对使用说明：**
   - 密钥对在 **每次 SSH 连接时** 使用
   - 无论是 root 还是 ecs-user，都使用同一个密钥对
   - 密钥对文件（`.pem`）需要保存在本地 Mac 上
   - 每次连接时，SSH 会自动使用密钥对进行身份验证
   - 不需要输入密码，比密码登录更安全

   **如果使用密码登录：**
   ```bash
   # 连接到实例（如果登录名是 root）
   ssh root@你的ECS公网IP
   # 终端会提示输入密码，输入后回车
   
   # 或连接到实例（如果登录名是 ecs-user）
   ssh ecs-user@你的ECS公网IP
   # 终端会提示输入密码，输入后回车
   ```

   **连接成功后的提示：**
   - 如果连接成功，终端会显示类似：
     ```
     Welcome to Ubuntu 20.04.6 LTS (GNU/Linux 5.4.0-xxx-generic x86_64)
     ...
     root@iZxxx:~#
     ```
   - 此时你已经登录到 ECS 实例，可以执行 Linux 命令了

   **注意：**
   - 所有 SSH 命令都在 **本地 Mac 终端** 中执行
   - 如果使用密钥对，必须设置密钥文件权限为 400
   - 如果使用 ecs-user 登录，某些操作需要 `sudo`
   - 连接成功后，后续的命令都在 ECS 实例上执行（不是本地 Mac）

### 步骤 3：在 ECS 上安装环境

**重要：以下命令在 ECS 实例上执行（SSH 连接成功后）**

1. **更新系统**

   **如果使用 root 登录：**
   ```bash
   # Ubuntu/Debian
   apt update && apt upgrade -y
   
   # CentOS/Alibaba Cloud Linux
   yum update -y
   ```

   **如果使用 ecs-user 登录（需要使用 sudo）：**
   ```bash
   # Ubuntu/Debian
   sudo apt update && sudo apt upgrade -y
   
   # CentOS/Alibaba Cloud Linux
   sudo yum update -y
   ```

   **常见错误：**
   - 如果看到 `Permission denied` 错误，说明需要使用 `sudo`
   - 如果使用 root 登录仍然报错，检查是否真的是 root 用户：`whoami`
   - 如果显示 `root`，应该不需要 sudo；如果显示其他用户名，需要使用 sudo

2. **安装 Node.js**

   **Ubuntu/Debian（推荐）：**

   **如果使用 root 登录：**
   ```bash
   # 使用 NodeSource 安装 Node.js 18
   curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
   apt install -y nodejs
   
   # 验证安装
   node -v
   npm -v
   ```

   **如果使用 ecs-user 登录：**
   ```bash
   # 使用 NodeSource 安装 Node.js 18
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
   sudo apt install -y nodejs
   
   # 验证安装
   node -v
   npm -v
   ```

   **CentOS/Alibaba Cloud Linux：**

   **如果使用 root 登录：**
   ```bash
   # 使用 NodeSource 安装 Node.js 18
   curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
   yum install -y nodejs
   
   # 验证安装
   node -v
   npm -v
   ```

   **如果使用 ecs-user 登录：**
   ```bash
   # 使用 NodeSource 安装 Node.js 18
   curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
   sudo yum install -y nodejs
   
   # 验证安装
   node -v
   npm -v
   ```

3. **安装 Git（如果需要）**

   **如果使用 root 登录：**
   ```bash
   apt install -y git
   ```

   **如果使用 ecs-user 登录：**
   ```bash
   sudo apt install -y git
   ```

### 步骤 4：部署应用

**⚠️ 重要提示：如果 SSH 连接断开**

如果遇到 "Connection closed by remote host" 或连接断开的情况：

1. **重新连接 ECS 实例**（在本地 Mac 终端执行）：
   ```bash
   # 如果使用密钥对
   ssh -i ~/.ssh/你的密钥文件名.pem ecs-user@你的ECS公网IP
   # 或
   ssh -i ~/.ssh/你的密钥文件名.pem root@你的ECS公网IP
   
   # 如果使用密码登录
   ssh ecs-user@你的ECS公网IP
   # 或
   ssh root@你的ECS公网IP
   ```

2. **检查之前的部署进度**：
   ```bash
   # 检查项目是否已克隆
   ls -la ~/figma-plugin-figma_sync
   # 或
   ls -la /opt/figma-plugin-figma_sync
   
   # 检查项目目录内容（重要：确认 package.json 存在）
   ls -la ~/figma-plugin-figma_sync/package.json
   # 如果文件不存在，说明克隆不完整或目录错误
   
   # 检查依赖是否已安装
   ls -la ~/figma-plugin-figma_sync/node_modules
   
   # 检查 .env 文件是否存在
   ls -la ~/figma-plugin-figma_sync/.env
   ```

3. **从断点继续**：
   - 如果项目已克隆，直接进入项目目录继续后续步骤
   - 如果依赖已安装，跳过 `npm install` 步骤
   - 如果 .env 已配置，检查配置是否正确

---

1. **上传项目文件**

   **方法 A：使用 Git（推荐）**

   **重要说明：**
   - `git clone` 是克隆整个仓库的源代码（包括所有文件）
   - 不是克隆 GitHub Releases 的某个版本
   - GitHub Releases 是打包好的服务器代码（.tar.gz），用于用户安装，不是用于 git clone
   - 仓库 URL 格式：`https://github.com/用户名/仓库名.git`

   **克隆仓库：**
   
   **⚠️ 重要：请将下面的 `你的GitHub用户名` 替换为你的实际 GitHub 用户名**
   
   **权限问题解决方案：**
   
   `/opt` 目录需要 root 权限，如果使用 `ecs-user` 登录，有以下几种方法：
   
   **方法 1：克隆到用户目录（推荐，最简单）**
   ```bash
   cd ~
   git clone https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   cd figma-plugin-figma_sync
   ```
   
   **方法 2：使用 sudo 克隆到 /opt（如果使用 ecs-user 登录）**
   ```bash
   cd /opt
   sudo git clone https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   sudo chown -R ecs-user:ecs-user figma-plugin-figma_sync
   cd figma-plugin-figma_sync
   ```
   
   **方法 3：切换到 root 用户（如果使用 ecs-user 登录）**
   ```bash
   sudo su -
   cd /opt
   git clone https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   cd figma-plugin-figma_sync
   ```
   
   **方法 4：修改 /opt 目录权限（不推荐，安全性较低）**
   ```bash
   sudo chmod 777 /opt  # 不推荐，仅用于测试
   cd /opt
   git clone https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   cd figma-plugin-figma_sync
   ```
   
   **示例（如果你的 GitHub 用户名是 `yourusername`，使用用户目录）：**
   ```bash
   cd ~
   git clone https://github.com/yourusername/figma-plugin-figma_sync.git
   cd figma-plugin-figma_sync
   ```

   **如果仓库是私有的，需要使用 SSH 方式：**
   ```bash
   # 先配置 SSH 密钥（如果还没有）
   # 在本地 Mac 上生成 SSH 密钥对，然后将公钥添加到 GitHub
   
   # 在 ECS 上使用 SSH 方式克隆
   git clone git@github.com:你的GitHub用户名/figma-plugin-figma_sync.git
   ```

   **克隆特定分支（如果需要）：**
   ```bash
   git clone -b main https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   # 或
   git clone -b master https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   ```
   
   **如何找到你的 GitHub 仓库 URL：**
   1. 打开你的 GitHub 仓库页面
   2. 点击绿色的 "Code" 按钮
   3. 复制 HTTPS 或 SSH URL
   4. 例如：`https://github.com/你的用户名/仓库名.git`

   **方法 B：使用 SCP 上传（如果不想使用 Git）**
   ```bash
   # 在本地 Mac 上执行
   scp -r /Users/sucao/Downloads/FigmaSync root@你的ECS公网IP:/opt/figmasync
   # 或使用 ecs-user
   scp -r /Users/sucao/Downloads/FigmaSync ecs-user@你的ECS公网IP:/opt/figmasync
   ```

2. **安装依赖**
   
   **⚠️ 重要：先确认 package.json 文件存在**
   
   ```bash
   # 检查当前目录
   pwd
   
   # 检查 package.json 是否存在
   ls -la package.json
   
   # 如果文件不存在，检查项目目录内容
   ls -la
   ```
   
   **如果 package.json 不存在，可能的原因：**
   1. 项目未正确克隆（目录为空或不完整）
   2. 进入了错误的目录
   3. GitHub 仓库中没有 package.json（需要确认仓库内容）
   
   **解决方法：**
   
   **方法 1：重新克隆项目（推荐）**
   ```bash
   # 删除不完整的项目目录
   cd ~
   rm -rf figma-plugin-figma_sync
   
   # 重新克隆
   git clone https://github.com/你的GitHub用户名/figma-plugin-figma_sync.git
   cd figma-plugin-figma_sync
   
   # 确认 package.json 存在
   ls -la package.json
   
   # 然后安装依赖
   npm install --production
   ```
   
   **方法 2：检查并进入正确的目录**
   ```bash
   # 查找 package.json 文件
   find ~ -name "package.json" -type f 2>/dev/null
   
   # 如果找到，进入该目录
   cd $(dirname $(find ~ -name "package.json" -type f 2>/dev/null | head -1))
   ```
   
   **根据你选择的克隆位置，进入对应的目录：**
   
   **如果克隆到用户目录（~）：**
   ```bash
   cd ~/figma-plugin-figma_sync
   # 确认 package.json 存在
   ls -la package.json
   # 如果存在，安装依赖
   npm install --production
   # 或使用新语法（推荐）
   npm install --omit=dev
   ```
   
   **如果克隆到 /opt：**
   ```bash
   cd /opt/figma-plugin-figma_sync
   # 确认 package.json 存在
   ls -la package.json
   # 如果存在，安装依赖
   npm install --production
   # 或使用新语法（推荐）
   npm install --omit=dev
   ```
   
   **如果使用 SCP 上传到 /opt/figmasync：**
   ```bash
   cd /opt/figmasync
   # 确认 package.json 存在
   ls -la package.json
   # 如果存在，安装依赖
   npm install --production
   # 或使用新语法（推荐）
   npm install --omit=dev
   ```
   
   **注意：npm 警告说明**
   - `npm warn config production Use '--omit=dev' instead` 是警告，不是错误
   - 可以使用 `npm install --omit=dev` 替代 `npm install --production`
   - 两者功能相同，新语法更推荐

3. **配置环境变量**
   ```bash
   # 创建 .env 文件
   nano .env
   ```
   
   添加以下内容：
   ```bash
   ALIYUN_ACCESS_KEY_ID=你的AccessKey_ID
   ALIYUN_ACCESS_KEY_SECRET=你的AccessKey_Secret
   ALIYUN_BUCKET=你的Bucket名称
   ALIYUN_REGION=oss-cn-beijing
   ALIYUN_ROOT_FOLDER=FigmaSync
   ```

4. **安装 PM2（进程管理器）**

   **如果使用 root 登录：**
   ```bash
   npm install -g pm2
   ```

   **如果使用 ecs-user 登录：**
   ```bash
   sudo npm install -g pm2
   ```

5. **启动服务**
   
   **根据你的项目路径，进入对应目录后启动：**
   
   **如果项目在用户目录（~）：**
   ```bash
   cd ~/figma-plugin-figma_sync
   pm2 start server.js --name figmasync
   ```
   
   **如果项目在 /opt：**
   ```bash
   cd /opt/figma-plugin-figma_sync
   pm2 start server.js --name figmasync
   ```
   
   **如果使用 SCP 上传到 /opt/figmasync：**
   ```bash
   cd /opt/figmasync
   pm2 start server.js --name figmasync
   ```
   
   **设置开机自启：**
   ```bash
   pm2 startup
   pm2 save
   ```

6. **验证服务运行**
   ```bash
   # 查看服务状态
   pm2 status
   
   # 查看日志
   pm2 logs figmasync
   
   # 测试健康检查
   curl http://localhost:8888/health
   ```

### 步骤 5：配置域名（可选，推荐）

1. **购买域名**
   - 在阿里云域名服务购买域名
   - 或使用已有域名

2. **域名解析**
   - 进入 **域名解析** 控制台
   - 添加 **A 记录**：
     - 主机记录：`@` 或 `api`（根据需求）
     - 记录值：你的 ECS 公网 IP
     - TTL：10分钟

3. **域名备案**（如果使用中国大陆服务器）
   - 访问：https://beian.aliyun.com/
   - 按照流程完成备案（通常需要 7-20 个工作日）

4. **配置 Nginx 反向代理（推荐）**
   ```bash
   # 安装 Nginx
   apt install -y nginx
   
   # 配置 Nginx
   nano /etc/nginx/sites-available/figmasync
   ```
   
   添加配置：
   ```nginx
   server {
       listen 80;
       server_name 你的域名.com;
       
       location / {
           proxy_pass http://localhost:8888;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```
   
   启用配置：
   ```bash
   ln -s /etc/nginx/sites-available/figmasync /etc/nginx/sites-enabled/
   nginx -t
   systemctl reload nginx
   ```

5. **配置 HTTPS（推荐）**
   ```bash
   # 安装 Certbot
   apt install -y certbot python3-certbot-nginx
   
   # 申请 SSL 证书
   certbot --nginx -d 你的域名.com
   ```

### 步骤 6：获取公网访问地址

部署完成后，你可以使用以下地址：

1. **使用 ECS 公网 IP**（简单，但不够专业）
   ```
   http://你的ECS公网IP:8888/upload-oss
   ```

2. **使用域名**（推荐，更专业）
   ```
   http://你的域名.com/upload-oss
   ```
   或配置 HTTPS：
   ```
   https://你的域名.com/upload-oss
   ```

### 步骤 7：配置 iPhone 快捷指令

在 iPhone 快捷指令中，使用以下 URL：

```
http://你的ECS公网IP:8888/upload-oss
```
或
```
https://你的域名.com/upload-oss
```

## 服务管理

### 查看服务状态
```bash
pm2 status
```

### 查看日志
```bash
pm2 logs figmasync
```

### 重启服务
```bash
pm2 restart figmasync
```

### 停止服务
```bash
pm2 stop figmasync
```

### 更新应用
```bash
cd /opt/figmasync
git pull  # 如果使用 Git
npm install --production
pm2 restart figmasync
```

## 成本估算

### ECS 实例费用
- **1核2GB**：约 ¥50-100/月（按量付费）或 ¥300-500/年（包年包月）
- **2核4GB**：约 ¥100-200/月（按量付费）或 ¥600-1000/年（包年包月）

### 网络费用
- 公网带宽：按流量计费，约 ¥0.8/GB
- 或选择固定带宽：¥23/月起（1Mbps）

### 总成本
- 最低配置：约 ¥50-100/月
- 推荐配置：约 ¥100-200/月

## 优势

✅ **网络稳定**：阿里云在中国大陆有多个数据中心，网络稳定快速  
✅ **无网络限制**：不依赖 Google 服务，避免 VPN 等问题  
✅ **成本可控**：按需付费，成本透明  
✅ **易于管理**：可以使用 PM2、Docker 等工具管理服务  
✅ **可扩展**：可以根据需求升级实例规格  

## 注意事项

1. **安全组配置**：确保只开放必要的端口
2. **防火墙设置**：配置系统防火墙规则
3. **定期备份**：定期备份配置文件和数据库
4. **监控告警**：配置云监控，及时发现问题
5. **域名备案**：如果使用中国大陆服务器，必须完成备案

## 故障排查

### 服务无法访问
1. 检查安全组规则是否开放 8888 端口
2. 检查服务是否运行：`pm2 status`
3. 检查日志：`pm2 logs figmasync`
4. 检查防火墙：`ufw status` 或 `iptables -L`

### 服务启动失败
1. 检查环境变量配置：`cat .env`
2. 检查 Node.js 版本：`node -v`（需要 14+）
3. 检查依赖安装：`npm list`
4. 查看详细错误：`pm2 logs figmasync --err`

## 下一步

部署完成后：
1. 在 iPhone 快捷指令中配置公网 URL
2. 在 Figma 插件中选择「阿里云 OSS 上传」模式
3. 测试上传功能

---

**参考文档：**
- 阿里云 ECS 文档：https://help.aliyun.com/product/25365.html
- PM2 文档：https://pm2.keymetrics.io/
- Nginx 文档：https://nginx.org/en/docs/

