// screenshot-stitcher.js - 使用 Qwen2-VL 识别可拼接的长截图
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * 使用 Qwen2-VL 判断两张截图是否可以拼接
 * @param {Buffer|string} image1 - 第一张图片（Buffer 或 base64）
 * @param {Buffer|string} image2 - 第二张图片（Buffer 或 base64）
 * @returns {Promise<Object>} - { canStitch: boolean, overlap: number, reason: string }
 */
async function canStitchScreenshots(image1, image2) {
  try {
    // 转换为 base64（如果是 Buffer）
    const img1Base64 = Buffer.isBuffer(image1) ? image1.toString('base64') : image1;
    const img2Base64 = Buffer.isBuffer(image2) ? image2.toString('base64') : image2;

    const prompt = `你是一个专业的UI截图分析助手。请判断以下两张截图是否来自同一页面的连续滚动，并能否拼接成长截图。

判断规则：
1. 页面一致性：分辨率、方向、导航栏、底部栏、布局结构是否属于同一页面体系
2. 导航栏/底部栏容错：它们可能有透明度变化、状态变化、出现/消失，仅用于判断是否同一页面
3. 关键：在主内容区域（排除导航栏与底部栏）寻找重叠内容：
   - 顶部/底部是否出现相同的文字、卡片、分割线、图片或结构
   - 是否仅发生垂直平移（无缩放/旋转/明显横向位移）
4. 横向一致性：水平偏移不应超过 1-2 像素
5. 可接受：轻微动画、时间变化、轻微色差、图标状态变化
6. 不可接受：跨页面、组件布局变化、列表重排、广告插入

请输出 JSON 格式：
{
  "canStitch": true/false,
  "confidence": 0-100,
  "overlapPixels": 估计的重叠像素数,
  "overlapPosition": "第一张图底部与第二张图顶部",
  "reason": "详细理由"
}`;

    // 检测使用哪个 API
    const dashscopeKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
    const togetherKey = process.env.TOGETHER_API_KEY;
    
    if (!dashscopeKey && !togetherKey) {
      console.warn('⚠️  未设置 AI API Key，长截图识别功能将不可用');
      console.warn('   请设置以下任一环境变量：');
      console.warn('   - DASHSCOPE_API_KEY（阿里云，完全免费）');
      console.warn('   - TOGETHER_API_KEY（Together AI，首月 $5 免费额度）');
      return { canStitch: false, reason: 'API Key 未配置' };
    }

    let response;
    
    // 优先使用阿里云 DashScope（完全免费）
    if (dashscopeKey) {
      console.log('🇨🇳 使用阿里云 DashScope API（完全免费）');
      response = await axios.post(
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        {
          model: 'qwen-vl-plus',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  { text: prompt },
                  { image: `data:image/jpeg;base64,${img1Base64}` },
                  { image: `data:image/jpeg;base64,${img2Base64}` }
                ]
              }
            ]
          },
          parameters: {
            result_format: 'message'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${dashscopeKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      
      // 解析阿里云响应
      const content = response.data.output.choices[0].message.content;
      // 从文本中提取 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const result = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
      
      return {
        canStitch: result.canStitch,
        confidence: result.confidence || 0,
        overlapPixels: result.overlapPixels || 0,
        overlapPosition: result.overlapPosition || '',
        reason: result.reason || ''
      };
    } 
    // 否则使用 Together AI
    else {
      console.log('🌐 使用 Together AI API（首月 $5 免费额度）');
      response = await axios.post(
        'https://api.together.xyz/v1/chat/completions',
        {
          model: 'Qwen/Qwen2-VL-7B-Instruct',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { 
                  type: 'image_url', 
                  image_url: { url: `data:image/jpeg;base64,${img1Base64}` }
                },
                { 
                  type: 'image_url', 
                  image_url: { url: `data:image/jpeg;base64,${img2Base64}` }
                }
              ]
            }
          ],
          max_tokens: 512,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        },
        {
          headers: {
            'Authorization': `Bearer ${togetherKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      
      const result = JSON.parse(response.data.choices[0].message.content);
      
      console.log('🤖 AI 判断结果:', {
        canStitch: result.canStitch,
        confidence: result.confidence,
        overlap: result.overlapPixels
      });
      
      return {
        canStitch: result.canStitch,
        confidence: result.confidence || 0,
        overlapPixels: result.overlapPixels || 0,
        overlapPosition: result.overlapPosition || '',
        reason: result.reason || ''
      };
    }

  } catch (error) {
    console.error('❌ AI 判断失败:', error.message);
    if (error.response) {
      console.error('   API 响应:', error.response.data);
    }
    return { 
      canStitch: false, 
      error: error.message,
      reason: 'AI 分析失败'
    };
  }
}

/**
 * 分析一组截图，找出所有可拼接的序列
 * @param {Array<{id: string, buffer: Buffer, name: string}>} screenshots - 截图数组
 * @returns {Promise<Array<Array<string>>>} - 可拼接的截图组（每组是截图 ID 数组）
 */
async function findStitchableGroups(screenshots) {
  console.log(`\n📊 开始分析 ${screenshots.length} 张截图...`);
  
  if (screenshots.length < 2) {
    console.log('   截图数量不足，无需分析');
    return [];
  }

  const groups = [];
  const processed = new Set();

  // 按名称或时间排序（假设截图名称包含时间戳）
  const sorted = screenshots.sort((a, b) => a.name.localeCompare(b.name));

  for (let i = 0; i < sorted.length - 1; i++) {
    if (processed.has(sorted[i].id)) continue;

    const currentGroup = [sorted[i].id];
    let currentIndex = i;

    // 尝试向后连续匹配
    for (let j = i + 1; j < sorted.length; j++) {
      if (processed.has(sorted[j].id)) continue;

      console.log(`   🔍 比较截图 ${currentIndex + 1} 和 ${j + 1}...`);
      
      const result = await canStitchScreenshots(
        sorted[currentIndex].buffer,
        sorted[j].buffer
      );

      if (result.canStitch && result.confidence > 60) {
        console.log(`   ✅ 可拼接！置信度: ${result.confidence}%`);
        currentGroup.push(sorted[j].id);
        processed.add(sorted[j].id);
        currentIndex = j;
      } else {
        console.log(`   ❌ 不可拼接。原因: ${result.reason}`);
        break; // 序列中断
      }
    }

    if (currentGroup.length > 1) {
      groups.push(currentGroup);
      currentGroup.forEach(id => processed.add(id));
      console.log(`   ✨ 发现可拼接组: ${currentGroup.length} 张截图`);
    }
  }

  console.log(`\n✅ 分析完成！共发现 ${groups.length} 组可拼接截图\n`);
  return groups;
}

/**
 * 使用传统图像处理方法进行快速预筛选（可选）
 * 在调用 AI 前先用简单的规则过滤，节省 API 调用
 */
function quickPrefilter(image1Info, image2Info) {
  // 1. 分辨率检查
  if (image1Info.width !== image2Info.width) {
    return { pass: false, reason: '宽度不一致' };
  }

  // 2. 方向检查（竖屏 vs 横屏）
  const isPortrait1 = image1Info.height > image1Info.width;
  const isPortrait2 = image2Info.height > image2Info.width;
  if (isPortrait1 !== isPortrait2) {
    return { pass: false, reason: '方向不一致' };
  }

  // 3. 时间间隔检查（如果有时间戳）
  if (image1Info.timestamp && image2Info.timestamp) {
    const timeDiff = Math.abs(image1Info.timestamp - image2Info.timestamp);
    if (timeDiff > 60000) { // 超过 1 分钟
      return { pass: false, reason: '时间间隔过长' };
    }
  }

  return { pass: true };
}

module.exports = {
  canStitchScreenshots,
  findStitchableGroups,
  quickPrefilter
};

