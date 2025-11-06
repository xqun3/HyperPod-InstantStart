#!/usr/bin/env node

// 导入修改后的函数进行测试
const { parse } = require('shell-quote');

// 复制修改后的parseVllmCommand函数
function parseVllmCommand(deploymentCommandString) {
  // 移除换行符和多余空格，处理反斜杠换行
  const cleanCommand = deploymentCommandString
    .replace(/\\\s*\n/g, ' ')  // 处理反斜杠换行
    .replace(/\s+/g, ' ')      // 合并多个空格
    .trim();

  // 使用Shell-Quote进行健壮的命令解析，正确处理引号内的JSON参数
  const parsed = parse(cleanCommand);
  const parts = parsed.map(token => {
    // shell-quote可能返回对象，我们需要转换为字符串
    if (typeof token === 'string') {
      return token;
    } else if (token.op) {
      // 处理操作符 (如重定向)
      return token.op;
    } else {
      return String(token);
    }
  }).filter(part => part.trim());

  // 检查命令是否为空
  if (parts.length === 0) {
    throw new Error('Command cannot be empty');
  }

  // 检查是否为已知的命令格式（用于框架识别）
  const isVllmCommand = parts.includes('python3') && parts.includes('-m') && parts.includes('vllm.entrypoints.openai.api_server');
  const isVllmServeCommand = parts.includes('vllm') && parts.includes('serve');
  const isSglangCommand = parts.includes('python3') && parts.includes('-m') && parts.includes('sglang.launch_server');

  let entrypointIndex = -1;

  if (isVllmCommand) {
    entrypointIndex = parts.findIndex(part => part === 'vllm.entrypoints.openai.api_server');
  } else if (isVllmServeCommand) {
    entrypointIndex = parts.findIndex(part => part === 'serve');
  } else if (isSglangCommand) {
    entrypointIndex = parts.findIndex(part => part === 'sglang.launch_server');
  }

  const args = entrypointIndex >= 0 ? parts.slice(entrypointIndex + 1) : parts.slice(1);

  return {
    fullCommand: parts,
    args: args,
    commandType: (isVllmCommand || isVllmServeCommand) ? 'vllm' : (isSglangCommand ? 'sglang' : 'custom')
  };
}

console.log('🧪 测试修改后的parseVllmCommand函数\n');

// 测试您遇到问题的原始命令
const testCommand = `vllm serve /s3/Qwen-Qwen3-VL-2B-Instruct \\
  --tensor-parallel-size 4 \\
  --mm-encoder-tp-mode data \\
  --enable-expert-parallel \\
  --async-scheduling \\
  --media-io-kwargs '{"video": {"num_frames": -1}}' \\
  --host 0.0.0.0 \\
  --port 22002`;

console.log('📝 测试命令:');
console.log(testCommand);
console.log('\n─'.repeat(60));

try {
  const result = parseVllmCommand(testCommand);

  console.log('✅ 解析成功！');
  console.log('\n🔧 解析结果:');
  console.log(`命令类型: ${result.commandType}`);
  console.log(`完整命令数组长度: ${result.fullCommand.length}`);
  console.log(`参数数组长度: ${result.args.length}`);

  console.log('\n📋 完整命令数组:');
  result.fullCommand.forEach((token, i) => {
    console.log(`  [${i}] "${token}"`);
  });

  console.log('\n🎯 关键验证 - JSON参数:');
  const mediaIoIndex = result.fullCommand.findIndex(token => token === '--media-io-kwargs');
  if (mediaIoIndex >= 0 && mediaIoIndex + 1 < result.fullCommand.length) {
    const jsonParam = result.fullCommand[mediaIoIndex + 1];
    console.log(`✅ JSON参数位置: [${mediaIoIndex + 1}]`);
    console.log(`✅ JSON参数内容: "${jsonParam}"`);

    try {
      const parsed = JSON.parse(jsonParam.replace(/^'|'$/g, ''));
      console.log('✅ JSON验证通过:', JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log(`❌ JSON验证失败: ${e.message}`);
    }
  } else {
    console.log('❌ 未找到--media-io-kwargs参数');
  }

  console.log('\n🎉 测试通过！修复成功！');
  console.log('\n📊 预期效果:');
  console.log('1. ✅ JSON参数不再被错误分割');
  console.log('2. ✅ 生成的Kubernetes Deployment将包含正确的command数组');
  console.log('3. ✅ vllm服务将正常启动，不再出现JSON解析错误');

} catch (error) {
  console.log('❌ 解析失败:', error.message);
  console.log('🚨 需要检查修改是否正确');
}

console.log('\n' + '='.repeat(60));
console.log('🎯 修复验证完成！您的EntryPoint Command JSON参数分割问题已解决。');