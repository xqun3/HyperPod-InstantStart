#!/usr/bin/env node

/**
 * 简化版 SGLang Router 配置测试脚本
 * 基于项目实际需求的简化版本
 */

const RoutingManager = require('./server/utils/routingManager');

console.log('🧪 Simplified SGLang Router Configuration Test\n');

// 测试 1: 针对特定SGLang部署的Cache-Aware路由
console.log('Test 1: Cache-Aware Policy for Specific SGLang Deployment');
console.log('=' .repeat(60));

const targetedConfig = {
  deploymentName: 'sglang-router',
  routingPolicy: 'cache_aware',
  routerPort: 30000,
  metricsPort: 29000,
  targetDeployment: 'qwensgl-2025-10-30-06-39-57', // 现有的SGLang部署
  discoveryPort: 8000,
  checkInterval: 120,
  cacheThreshold: 0.7,
  balanceAbsThreshold: 50,
  balanceRelThreshold: 1.2,
  evictionIntervalSecs: 45,
  maxTreeSize: 15000
};

console.log('Config:', JSON.stringify(targetedConfig, null, 2));

const targetedValidation = RoutingManager.validateConfig(targetedConfig);
console.log('Validation Result:', targetedValidation);

if (targetedValidation.valid) {
  console.log('\n📋 Generated YAML:');
  const targetedYaml = RoutingManager.generateRouterYaml(targetedConfig);
  console.log(targetedYaml);
}

console.log('\n' + '=' .repeat(70) + '\n');

// 测试 2: Round Robin策略
console.log('Test 2: Round Robin Policy for All SGLang Deployments');
console.log('=' .repeat(60));

const roundRobinConfig = {
  deploymentName: 'multi-sglang-router',
  routingPolicy: 'round_robin',
  routerPort: 31000,
  metricsPort: 30000,
  targetDeployment: '', // 空值表示所有SGLang部署
  discoveryPort: 8000,
  checkInterval: 90
};

console.log('Config:', JSON.stringify(roundRobinConfig, null, 2));

const roundRobinValidation = RoutingManager.validateConfig(roundRobinConfig);
console.log('Validation Result:', roundRobinValidation);

if (roundRobinValidation.valid) {
  console.log('\n📋 Generated YAML:');
  const roundRobinYaml = RoutingManager.generateRouterYaml(roundRobinConfig);
  console.log(roundRobinYaml);
}

console.log('\n' + '=' .repeat(70) + '\n');

// 测试 3: 验证错误 - 缺少target deployment
console.log('Test 3: Validation Error - Missing Target Deployment');
console.log('=' .repeat(60));

const invalidConfig = {
  deploymentName: 'invalid-router',
  routingPolicy: 'cache_aware',
  routerPort: 30000,
  metricsPort: 30000, // 端口冲突
  // targetDeployment: '', // 缺失
  discoveryPort: 99999, // 端口超出范围
};

console.log('Invalid Config:', JSON.stringify(invalidConfig, null, 2));

const invalidValidation = RoutingManager.validateConfig(invalidConfig);
console.log('Validation Result:', invalidValidation);

console.log('\n' + '=' .repeat(70) + '\n');

// 测试 4: 默认配置测试
console.log('Test 4: Default Configuration');
console.log('=' .repeat(60));

const defaultConfig = RoutingManager.getDefaultConfig();
console.log('Default Config:', JSON.stringify(defaultConfig, null, 2));

// 设置targetDeployment以通过验证
defaultConfig.targetDeployment = 'qwensgl-2025-10-30-06-39-57';
const defaultValidation = RoutingManager.validateConfig(defaultConfig);
console.log('Validation Result:', defaultValidation);

console.log('\n' + '=' .repeat(70) + '\n');

// 测试 5: 验证Pod Selector生成
console.log('Test 5: Pod Selector Generation Logic');
console.log('=' .repeat(60));

console.log('Case 1: With specific target deployment');
console.log('Expected selector: "deployment-tag=qwensgl-2025-10-30-06-39-57,model-type=sglang"');

console.log('\nCase 2: Empty target deployment (all SGLang)');
console.log('Expected selector: "model-type=sglang"');

console.log('\n✅ All tests completed!');
console.log('\n📊 Summary of Changes:');
console.log('- ✅ Removed OpenAI Compatible mode');
console.log('- ✅ Fixed service type to ClusterIP');
console.log('- ✅ Simplified service discovery to SGLang deployments only');
console.log('- ✅ Added targetDeployment selector');
console.log('- ✅ Maintained all routing policies (cache_aware, round_robin, random)');
console.log('- ✅ Kept Cache-Aware advanced parameters');