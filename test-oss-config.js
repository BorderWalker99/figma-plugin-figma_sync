#!/usr/bin/env node

/**
 * 阿里云 OSS 配置验证脚本
 * 用于验证 .env 文件中的 OSS 配置是否正确
 */

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
      console.error('   参考文档: ALIYUN_OSS_SETUP.md');
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
    console.log('\n💡 下一步:');
    console.log('   1. 运行 npm start 启动服务');
    console.log('   2. 配置 iPhone 快捷指令使用 /upload-oss 接口');
    console.log('   3. 在 Figma 插件中选择「阿里云 OSS 上传」模式');
    
  } catch (error) {
    console.error('\n❌ 配置验证失败！');
    console.error('   错误信息:', error.message);
    if (error.code) {
      console.error('   错误代码:', error.code);
    }
    if (error.stack) {
      console.error('\n   错误堆栈:');
      console.error(error.stack.split('\n').slice(0, 5).join('\n'));
    }
    console.error('\n💡 常见问题排查:');
    console.error('   1. 检查 AccessKey ID 和 Secret 是否正确');
    console.error('   2. 检查 RAM 用户是否有 OSS 权限');
    console.error('   3. 检查 Bucket 名称是否正确（区分大小写）');
    console.error('   4. 检查 Region 是否正确');
    console.error('   5. 检查网络连接是否正常');
    console.error('   6. 参考文档: ALIYUN_OSS_SETUP.md');
    process.exit(1);
  }
}

testOSSConfig();

