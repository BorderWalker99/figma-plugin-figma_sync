# 阿里云 OSS 配置指南

## 前提条件

✅ 已完成：Bucket 创建

## 配置步骤

### 步骤 2：获取 AccessKey ID 和 Secret

#### 2.1 创建 RAM 用户（推荐）

1. **登录阿里云控制台**
   - 访问：https://ram.console.aliyun.com/
   - 使用主账号登录

2. **创建 RAM 用户**
   - 左侧导航：**用户** → **创建用户**
   - 访问方式：
     - ✅ **使用永久 AccessKey 访问**（必须勾选）
     - ❌ 控制台访问（可选，如果不需要用户登录控制台）

3. **查看或创建 AccessKey**

   **步骤 1：进入 AccessKey 页面**
   - 创建用户后，点击用户名称进入详情页
   - 点击顶部标签页中的 **AccessKey** 标签

   **步骤 2：查看现有 AccessKey（如果已有）**
   - 在 AccessKey 列表中，通常只显示 **AccessKey ID**（例如：`LTAI5txxxxxxxxxxxxx`）
   - ⚠️ **重要**：**AccessKey Secret 不会在列表中显示**，这是阿里云的安全机制
   - 如果之前创建 AccessKey 时没有保存 Secret，**无法再次查看**，只能创建新的 AccessKey
   - 如果之前已保存过 Secret，请使用保存的 Secret；如果没有保存，需要创建新的 AccessKey

   **步骤 3：创建新的 AccessKey（如果没有或无法查看 Secret）**
   - 点击页面右上角的 **创建 AccessKey** 按钮
   - 如果已有 AccessKey，系统会弹出确认对话框：
     - 标题：**确认当前 AccessKey 用于轮转**
     - 提示：当前用户已创建 AccessKey，确认本次创建的 AccessKey 仅用于轮转
     - 选择用途：选择 **"本地开发环境中使用"** 或 **"其他"**
     - 勾选：**"我确认必须创建 AccessKey"**
     - 点击 **继续创建** 按钮
   - 系统会弹出对话框显示新创建的 AccessKey ID 和 Secret
   - **重要**：Secret 只显示一次，请立即复制保存！
   - 建议：复制到安全的地方（如密码管理器或本地文件）
   - 创建成功后，可以删除旧的 AccessKey（如果不再需要）

4. **记录 AccessKey 信息**
   ```
   AccessKey ID: LTAI5txxxxxxxxxxxxx
   AccessKey Secret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   
   **提示**：
   - AccessKey Secret 不会在列表中显示，这是阿里云的安全机制
   - 如果之前创建 AccessKey 时没有保存 Secret，无法再次查看，只能创建新的 AccessKey
   - 创建新 AccessKey 时，选择用途为 **"本地开发环境中使用"** 或 **"其他"**
   - 创建新 AccessKey 后，可以删除旧的 AccessKey（如果不再需要）

#### 2.2 授权 RAM 用户 OSS 权限

1. **创建自定义策略**
   - 左侧导航：**权限管理** → **策略** → **创建策略**
   - 策略名称：`FigmaSync-OSS-FullAccess`
   - 策略内容：
   ```json
   {
     "Version": "1",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "oss:PutObject",
           "oss:GetObject",
           "oss:DeleteObject",
           "oss:ListObjects",
           "oss:ListObjectsV2",
           "oss:GetObjectMeta",
           "oss:HeadObject"
         ],
         "Resource": [
           "acs:oss:*:*:你的Bucket名称/*"
         ]
       },
       {
         "Effect": "Allow",
         "Action": [
           "oss:ListObjects",
           "oss:ListObjectsV2"
         ],
         "Resource": [
           "acs:oss:*:*:你的Bucket名称"
         ]
       }
     ]
   }
   ```
   - 点击 **确定** 创建策略

2. **授权策略给 RAM 用户**
   - 进入 RAM 用户详情页
   - 点击 **添加权限**
   - 选择刚创建的策略：`FigmaSync-OSS-FullAccess`
   - 点击 **确定**

#### 2.3 使用主账号 AccessKey（不推荐，仅测试用）

⚠️ **不推荐**：主账号 AccessKey 权限过大，存在安全风险

如果只是测试，可以使用主账号的 AccessKey：
1. 右上角头像 → **AccessKey 管理**
2. 创建 AccessKey（如果还没有）
3. 记录 AccessKey ID 和 Secret

---

### 步骤 3：获取 BUCKET 和 REGION

#### 3.1 查看 Bucket 名称

1. **登录 OSS 控制台**
   - 访问：https://oss.console.aliyun.com/
   - 在 **Bucket 列表** 中可以看到所有 Bucket
   - 记录你的 Bucket 名称（例如：`figmasync-bucket`）

#### 3.2 查看 Region（地域）

1. **查看 Bucket 详情**
   - 点击 Bucket 名称进入详情页
   - 在 **概览** 页面可以看到 **地域** 信息
   - 常见地域：
     - `oss-cn-hangzhou`（华东1-杭州）
     - `oss-cn-shanghai`（华东2-上海）
     - `oss-cn-beijing`（华北2-北京）
     - `oss-cn-shenzhen`（华南1-深圳）
     - `oss-cn-hongkong`（香港）

2. **记录 Region**
   ```
   Region: oss-cn-hangzhou
   ```

---

### 步骤 4：设置 ROOT_FOLDER

#### 4.1 理解 ROOT_FOLDER

`ROOT_FOLDER` 是 OSS 中的根文件夹名称，所有用户的文件夹都会创建在这个根文件夹下。

**文件夹结构示例：**
```
Bucket: figmasync-bucket
  └── FigmaSync/（ROOT_FOLDER）
      ├── FigmaSync-user1@mac1/（用户1的文件夹）
      ├── FigmaSync-user2@mac2/（用户2的文件夹）
      └── FigmaSync-user3@mac3/（用户3的文件夹）
```

#### 4.2 设置 ROOT_FOLDER

**默认值**：`FigmaSync`

**自定义值**：可以是任何名称，例如：
- `FigmaSync`
- `MyFigmaFiles`
- `Screenshots`

**建议**：使用默认值 `FigmaSync`，除非有特殊需求。

---

## 快速配置方法

### 方法 1：使用安装脚本（推荐）

运行安装脚本，按提示输入配置信息：

```bash
cd /Users/sucao/Downloads/FigmaSync
./install-and-run.sh
```

选择模式时选择 `[2]`（阿里云 OSS 上传模式），然后按提示输入：

1. **ALIYUN_ACCESS_KEY_ID**：输入步骤 2 获取的 AccessKey ID
2. **ALIYUN_ACCESS_KEY_SECRET**：输入步骤 2 获取的 AccessKey Secret
3. **ALIYUN_BUCKET**：输入步骤 3 获取的 Bucket 名称
4. **ALIYUN_REGION**：输入步骤 3 获取的 Region（直接回车使用默认值 `oss-cn-hangzhou`）
5. **ALIYUN_ROOT_FOLDER**：输入根文件夹名称（直接回车使用默认值 `FigmaSync`）

脚本会自动创建 `.env` 文件并保存配置。

### 方法 2：手动创建 .env 文件

在项目根目录创建 `.env` 文件：

```bash
cd /Users/sucao/Downloads/FigmaSync
touch .env
```

编辑 `.env` 文件，添加以下内容：

```bash
# 阿里云 OSS 配置
ALIYUN_ACCESS_KEY_ID=LTAI5txxxxxxxxxxxxx
ALIYUN_ACCESS_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALIYUN_BUCKET=figmasync-bucket
ALIYUN_REGION=oss-cn-hangzhou
ALIYUN_ROOT_FOLDER=FigmaSync
```

**替换说明：**
- `LTAI5txxxxxxxxxxxxx` → 你的 AccessKey ID
- `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` → 你的 AccessKey Secret
- `figmasync-bucket` → 你的 Bucket 名称
- `oss-cn-hangzhou` → 你的 Region（如果不是杭州，请修改）
- `FigmaSync` → 你的根文件夹名称（可选，默认值）

---

## 验证配置

### 验证方法 1：使用测试脚本

创建测试脚本 `test-oss-config.js`：

```javascript
require('dotenv').config();
const { getOSSClient, listFolderFiles, createFolder } = require('./aliyunOSS');

async function testOSSConfig() {
  console.log('🔍 开始验证 OSS 配置...\n');
  
  try {
    // 1. 检查环境变量
    console.log('1️⃣ 检查环境变量...');
    const requiredVars = [
      'ALIYUN_ACCESS_KEY_ID',
      'ALIYUN_ACCESS_KEY_SECRET',
      'ALIYUN_BUCKET',
      'ALIYUN_REGION'
    ];
    
    const missingVars = requiredVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      console.error('❌ 缺少环境变量:', missingVars.join(', '));
      console.error('   请检查 .env 文件或环境变量配置');
      return;
    }
    
    console.log('   ✅ ALIYUN_ACCESS_KEY_ID:', process.env.ALIYUN_ACCESS_KEY_ID.substring(0, 10) + '...');
    console.log('   ✅ ALIYUN_ACCESS_KEY_SECRET:', '***' + process.env.ALIYUN_ACCESS_KEY_SECRET.substring(process.env.ALIYUN_ACCESS_KEY_SECRET.length - 4));
    console.log('   ✅ ALIYUN_BUCKET:', process.env.ALIYUN_BUCKET);
    console.log('   ✅ ALIYUN_REGION:', process.env.ALIYUN_REGION);
    console.log('   ✅ ALIYUN_ROOT_FOLDER:', process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync (默认)');
    
    // 2. 测试 OSS 连接
    console.log('\n2️⃣ 测试 OSS 连接...');
    const client = getOSSClient();
    console.log('   ✅ OSS 客户端创建成功');
    
    // 3. 测试列出文件（测试权限）
    console.log('\n3️⃣ 测试列出文件（测试权限）...');
    const rootFolder = process.env.ALIYUN_ROOT_FOLDER || 'FigmaSync';
    try {
      const result = await listFolderFiles({ folderId: rootFolder, pageSize: 5 });
      console.log(`   ✅ 成功访问根文件夹: ${rootFolder}`);
      console.log(`   📁 文件夹中的文件数量: ${result.files.length}`);
      if (result.files.length > 0) {
        console.log('   📄 示例文件:');
        result.files.slice(0, 3).forEach(file => {
          console.log(`      - ${file.name}`);
        });
      }
    } catch (error) {
      if (error.message.includes('NoSuchKey') || error.message.includes('404')) {
        console.log(`   ⚠️  根文件夹不存在，将尝试创建...`);
        try {
          await createFolder({ folderName: rootFolder, parentFolderId: '' });
          console.log(`   ✅ 根文件夹创建成功: ${rootFolder}`);
        } catch (createError) {
          console.error('   ❌ 创建根文件夹失败:', createError.message);
          throw createError;
        }
      } else {
        throw error;
      }
    }
    
    // 4. 测试创建用户文件夹
    console.log('\n4️⃣ 测试创建用户文件夹...');
    const testUserId = 'test-user@test-mac';
    const testFolderName = `FigmaSync-${testUserId}`;
    try {
      const folder = await createFolder({
        folderName: testFolderName,
        parentFolderId: rootFolder
      });
      console.log(`   ✅ 用户文件夹创建成功: ${folder.id}`);
      console.log(`   📂 文件夹路径: ${folder.id}`);
    } catch (error) {
      console.error('   ❌ 创建用户文件夹失败:', error.message);
      throw error;
    }
    
    console.log('\n✅ 所有测试通过！OSS 配置正确。\n');
    console.log('📝 配置摘要:');
    console.log(`   - Bucket: ${process.env.ALIYUN_BUCKET}`);
    console.log(`   - Region: ${process.env.ALIYUN_REGION}`);
    console.log(`   - Root Folder: ${rootFolder}`);
    console.log(`   - 用户文件夹格式: ${rootFolder}/FigmaSync-{userId}/`);
    
  } catch (error) {
    console.error('\n❌ 配置验证失败！');
    console.error('   错误信息:', error.message);
    if (error.code) {
      console.error('   错误代码:', error.code);
    }
    console.error('\n💡 常见问题:');
    console.error('   1. 检查 AccessKey ID 和 Secret 是否正确');
    console.error('   2. 检查 RAM 用户是否有 OSS 权限');
    console.error('   3. 检查 Bucket 名称是否正确');
    console.error('   4. 检查 Region 是否正确');
    console.error('   5. 检查网络连接是否正常');
    process.exit(1);
  }
}

testOSSConfig();
```

运行测试：

```bash
cd /Users/sucao/Downloads/FigmaSync
node test-oss-config.js
```

### 验证方法 2：启动服务测试

1. **启动服务**
   ```bash
   cd /Users/sucao/Downloads/FigmaSync
   npm start
   ```

2. **检查启动日志**
   如果配置正确，会看到类似输出：
   ```
   ✅ 阿里云 OSS 模块已加载（可选功能）
   ✅ 阿里云 OSS 上传接口已启用: POST /upload-oss
   ```

3. **测试上传**
   - 使用 iPhone 快捷指令上传一张截图
   - 检查服务器日志，应该看到：
     ```
     📤 [OSS上传] 开始上传到 OSS: 截图.jpg → 文件夹 FigmaSync/FigmaSync-user1@mac1/
     ✅ [OSS上传] 截图.jpg (文件ID: FigmaSync/FigmaSync-user1@mac1/截图.jpg)
     ```

### 验证方法 3：检查 .env 文件

```bash
cd /Users/sucao/Downloads/FigmaSync
cat .env
```

应该看到类似内容：
```bash
ALIYUN_ACCESS_KEY_ID=LTAI5txxxxxxxxxxxxx
ALIYUN_ACCESS_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALIYUN_BUCKET=figmasync-bucket
ALIYUN_REGION=oss-cn-hangzhou
ALIYUN_ROOT_FOLDER=FigmaSync
```

---

## 常见问题

### 1. AccessKey 权限不足

**错误信息：**
```
AccessDenied: You are not authorized to perform this operation
```

**解决方法：**
- 检查 RAM 用户是否已授权 OSS 权限策略
- 检查策略中的 Bucket 名称是否正确
- 检查策略中的权限是否包含所需的操作

### 2. Bucket 不存在

**错误信息：**
```
NoSuchBucket: The specified bucket does not exist
```

**解决方法：**
- 检查 Bucket 名称是否正确（区分大小写）
- 检查 Bucket 是否在正确的 Region

### 3. Region 不匹配

**错误信息：**
```
The bucket you are attempting to access must be addressed using the specified endpoint
```

**解决方法：**
- 检查 Region 是否正确
- 确保 Bucket 和 Region 匹配

### 4. 环境变量未加载

**错误信息：**
```
缺少阿里云 OSS 配置: 请设置 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET 环境变量
```

**解决方法：**
- 确保 `.env` 文件在项目根目录
- 确保安装了 `dotenv` 包：`npm install dotenv`
- 检查 `.env` 文件格式是否正确（每行一个变量，无空格）

---

## 下一步

配置完成后，可以：

1. **启动服务**
   ```bash
   npm start
   ```

2. **配置 iPhone 快捷指令**
   - 使用 `/upload-oss` 接口
   - 添加 `x-user-id` 请求头

3. **在 Figma 插件中选择阿里云 OSS 模式**
   - 打开 Figma 插件
   - 进入设置
   - 选择「阿里云 OSS 上传」模式

---

## 配置检查清单

- [ ] 已创建 RAM 用户
- [ ] 已创建 AccessKey 并保存 ID 和 Secret
- [ ] 已授权 RAM 用户 OSS 权限
- [ ] 已记录 Bucket 名称
- [ ] 已记录 Region
- [ ] 已设置 ROOT_FOLDER（或使用默认值）
- [ ] 已创建 `.env` 文件并填写配置
- [ ] 已运行验证测试并通过
- [ ] 已启动服务并测试上传功能

---

## 安全建议

1. **使用 RAM 子账号**：不要使用主账号 AccessKey
2. **最小权限原则**：只授予必要的 OSS 权限
3. **定期轮换 AccessKey**：建议每 90 天更换一次
4. **保护 AccessKey Secret**：不要将 Secret 提交到代码仓库
5. **使用 .env 文件**：将敏感信息保存在 `.env` 文件中，并添加到 `.gitignore`

