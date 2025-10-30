#!/usr/bin/env node

/**
 * SGLang Router 配置测试脚本
 * 测试新的路由策略和模式配置功能
 */

const RoutingManager = require('./server/utils/routingManager');

console.log('🧪 SGLang Router Configuration Test\n');

// 测试 1: Kubernetes 模式 + Cache-Aware 策略
console.log('Test 1: Kubernetes Mode + Cache-Aware Policy');
console.log('=' .repeat(50));

const kubernetesConfig = {
  deploymentName: 'test-router',
  routerMode: 'kubernetes',
  routingPolicy: 'cache_aware',
  routerPort: 30000,
  metricsPort: 29000,
  serviceType: 'external',
  podSelector: 'app=sglang-worker,version=v1',
  discoveryPort: 8000,
  checkInterval: 120,
  cacheThreshold: 0.7,
  balanceAbsThreshold: 50,
  balanceRelThreshold: 1.2,
  evictionIntervalSecs: 45,
  maxTreeSize: 15000
};

console.log('Config:', JSON.stringify(kubernetesConfig, null, 2));

const kubernetesValidation = RoutingManager.validateConfig(kubernetesConfig);
console.log('Validation Result:', kubernetesValidation);

if (kubernetesValidation.valid) {
  console.log('\n📋 Generated YAML:');
  const kubernetesYaml = RoutingManager.generateRouterYaml(kubernetesConfig);
  console.log(kubernetesYaml);
}

console.log('\n' + '=' .repeat(60) + '\n');

// 测试 2: OpenAI 模式 + Round Robin 策略
console.log('Test 2: OpenAI Mode + Round Robin Policy');
console.log('=' .repeat(50));

const openaiConfig = {
  deploymentName: 'openai-router',
  routerMode: 'openai',
  routingPolicy: 'round_robin',
  routerPort: 31000,
  metricsPort: 30000,
  serviceType: 'clusterip',
  workerUrls: [
    'http://vllm-service:8000/v1',
    'http://tgi-service:80/v1',
    'http://ollama-service:11434/v1'
  ]
};

console.log('Config:', JSON.stringify(openaiConfig, null, 2));

const openaiValidation = RoutingManager.validateConfig(openaiConfig);
console.log('Validation Result:', openaiValidation);

if (openaiValidation.valid) {
  console.log('\n📋 Generated YAML:');
  const openaiYaml = RoutingManager.generateRouterYaml(openaiConfig);
  console.log(openaiYaml);
}

console.log('\n' + '=' .repeat(60) + '\n');

// 测试 3: Random 策略
console.log('Test 3: Random Policy');
console.log('=' .repeat(50));

const randomConfig = {
  deploymentName: 'random-router',
  routerMode: 'kubernetes',
  routingPolicy: 'random',
  routerPort: 32000,
  metricsPort: 31000,
  serviceType: 'external',
  podSelector: 'deployment-name=random-worker',
  discoveryPort: 8000,
  checkInterval: 90
};

console.log('Config:', JSON.stringify(randomConfig, null, 2));

const randomValidation = RoutingManager.validateConfig(randomConfig);
console.log('Validation Result:', randomValidation);

if (randomValidation.valid) {
  console.log('\n📋 Generated YAML:');
  const randomYaml = RoutingManager.generateRouterYaml(randomConfig);
  console.log(randomYaml);
}

console.log('\n' + '=' .repeat(60) + '\n');

// 测试 4: 配置验证错误测试
console.log('Test 4: Configuration Validation Errors');
console.log('=' .repeat(50));

const invalidConfig = {
  deploymentName: 'INVALID-NAME',  // 大写字母不允许
  routerMode: 'invalid-mode',      // 无效模式
  routingPolicy: 'invalid-policy', // 无效策略
  routerPort: 99999,              // 端口超出范围
  metricsPort: 30000,             // 与router port冲突
  routerPort: 30000               // 重复定义会覆盖上面的值
};

console.log('Invalid Config:', JSON.stringify(invalidConfig, null, 2));

const invalidValidation = RoutingManager.validateConfig(invalidConfig);
console.log('Validation Result:', invalidValidation);

console.log('\n' + '=' .repeat(60) + '\n');

// 测试 5: 默认配置
console.log('Test 5: Default Configuration');
console.log('=' .repeat(50));

const defaultConfig = RoutingManager.getDefaultConfig();
console.log('Default Config:', JSON.stringify(defaultConfig, null, 2));

const defaultValidation = RoutingManager.validateConfig(defaultConfig);
console.log('Validation Result:', defaultValidation);

console.log('\n✅ All tests completed!');