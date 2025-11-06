#!/usr/bin/env node

const { parse } = require('shell-quote');

console.log('🔍 真实用户输入 vs 测试脚本差异验证\n');

// 模拟真实用户在UI输入框中的输入（单反斜杠）
const realUserInput = `vllm serve /s3/Qwen-Qwen3-VL-2B-Instruct \\
  --tensor-parallel-size 4 \\
  --mm-encoder-tp-mode data \\
  --enable-expert-parallel \\
  --async-scheduling \\
  --media-io-kwargs '{"video": {"num_frames": -1}}' \\
  --host 0.0.0.0 \\
  --port 22002`;

// 测试脚本中的输入（JavaScript字符串，双反斜杠）
const testScriptInput = `vllm serve /s3/Qwen-Qwen3-VL-2B-Instruct \\\\
  --tensor-parallel-size 4 \\\\
  --mm-encoder-tp-mode data \\\\
  --enable-expert-parallel \\\\
  --async-scheduling \\\\
  --media-io-kwargs '{"video": {"num_frames": -1}}' \\\\
  --host 0.0.0.0 \\\\
  --port 22002`;

function testInputDifferences() {
  console.log('📋 测试1: 真实用户输入（单反斜杠）');
  console.log('─'.repeat(60));

  console.log('🔤 原始输入:');
  console.log(JSON.stringify(realUserInput));

  // 应用当前系统的预处理逻辑
  const cleanRealInput = realUserInput
    .replace(/\\\s*\n/g, ' ')  // 处理反斜杠换行
    .replace(/\s+/g, ' ')      // 合并多个空格
    .trim();

  console.log('\n🧹 预处理后:');
  console.log(JSON.stringify(cleanRealInput));

  // Shell-Quote解析
  const parsedReal = parse(cleanRealInput);
  console.log('\n🔧 Shell-Quote解析结果:');
  parsedReal.forEach((token, i) => {
    console.log(`  [${i}] "${token}"`);
  });

  // 验证JSON参数
  const mediaIoIndex = parsedReal.findIndex(token => token === '--media-io-kwargs');
  if (mediaIoIndex >= 0 && mediaIoIndex + 1 < parsedReal.length) {
    const jsonParam = parsedReal[mediaIoIndex + 1];
    console.log(`\n✅ JSON参数: "${jsonParam}"`);
    try {
      const parsed = JSON.parse(jsonParam.replace(/^'|'$/g, ''));
      console.log(`✅ JSON验证通过`);
    } catch (e) {
      console.log(`❌ JSON验证失败: ${e.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📋 测试2: 测试脚本输入（双反斜杠）');
  console.log('─'.repeat(60));

  console.log('🔤 原始输入:');
  console.log(JSON.stringify(testScriptInput));

  const cleanTestInput = testScriptInput
    .replace(/\\\s*\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  console.log('\n🧹 预处理后:');
  console.log(JSON.stringify(cleanTestInput));

  const parsedTest = parse(cleanTestInput);
  console.log('\n🔧 Shell-Quote解析结果:');
  parsedTest.forEach((token, i) => {
    console.log(`  [${i}] "${token}"`);
  });

  // 验证JSON参数
  const testMediaIoIndex = parsedTest.findIndex(token => token === '--media-io-kwargs');
  if (testMediaIoIndex >= 0 && testMediaIoIndex + 1 < parsedTest.length) {
    const jsonParam = parsedTest[testMediaIoIndex + 1];
    console.log(`\n✅ JSON参数: "${jsonParam}"`);
    try {
      const parsed = JSON.parse(jsonParam.replace(/^'|'$/g, ''));
      console.log(`✅ JSON验证通过`);
    } catch (e) {
      console.log(`❌ JSON验证失败: ${e.message}`);
    }
  }

  // 对比结果
  console.log('\n' + '='.repeat(60));
  console.log('🔍 结果对比');
  console.log('─'.repeat(60));

  console.log(`真实用户输入解析数量: ${parsedReal.length}`);
  console.log(`测试脚本输入解析数量: ${parsedTest.length}`);

  const resultsMatch = JSON.stringify(parsedReal) === JSON.stringify(parsedTest);
  console.log(`\n🎯 解析结果一致性: ${resultsMatch ? '✅ 一致' : '❌ 不一致'}`);

  if (!resultsMatch) {
    console.log('\n🚨 发现差异:');
    for (let i = 0; i < Math.max(parsedReal.length, parsedTest.length); i++) {
      const realToken = parsedReal[i] || '<缺失>';
      const testToken = parsedTest[i] || '<缺失>';
      if (realToken !== testToken) {
        console.log(`  位置[${i}]: 真实="${realToken}" vs 测试="${testToken}"`);
      }
    }
  }
}

// 额外测试：各种换行方式
function testVariousLineBreakFormats() {
  console.log('\n\n📝 测试各种换行格式');
  console.log('='.repeat(60));

  const formats = [
    {
      name: '标准Shell换行（真实用户输入）',
      input: 'cmd arg1 \\\n  arg2 \\\n  --param value'
    },
    {
      name: 'Windows风格换行',
      input: 'cmd arg1 \\\r\n  arg2 \\\r\n  --param value'
    },
    {
      name: '空格+换行',
      input: 'cmd arg1 \\   \n  arg2 \\   \n  --param value'
    },
    {
      name: 'Tab+换行',
      input: 'cmd arg1 \\\t\n  arg2 \\\t\n  --param value'
    }
  ];

  formats.forEach((format, index) => {
    console.log(`\n${index + 1}. ${format.name}:`);
    console.log('   原始:', JSON.stringify(format.input));

    const processed = format.input
      .replace(/\\\s*\n/g, ' ')
      .replace(/\\\s*\r\n/g, ' ')  // 处理Windows换行
      .replace(/\s+/g, ' ')
      .trim();

    console.log('   处理:', JSON.stringify(processed));

    const parsed = parse(processed);
    console.log('   解析:', parsed.join(' | '));
  });
}

testInputDifferences();
testVariousLineBreakFormats();

console.log('\n🎯 结论: 验证Shell-Quote是否能够通用处理所有换行格式');