const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { exec, spawn, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');
const https = require('https');
const http = require('http');
const { parse } = require('shell-quote');

// 加载 user.env 配置文件
require('dotenv').config({ path: path.join(__dirname, '../client/user.env') });

// 引入工具模块
const HyperPodDependencyManager = require('./utils/hyperPodDependencyManager');
const { getCurrentRegion } = require('./utils/awsHelpers');
const AWSHelpers = require('./utils/awsHelpers');
const MetadataUtils = require('./utils/metadataUtils');
const EKSServiceHelper = require('./utils/eksServiceHelper');
const NetworkManager = require('./utils/networkManager');
const AWSInstanceTypeManager = require('./utils/awsInstanceTypeManager');

// 引入集群状态V2模块
const { 
  handleClusterStatusV2, 
  handleClearCache, 
  handleCacheStatus 
} = require('./clusterStatusV2');

// 引入应用状态V2模块
const {
  handlePodsV2,
  handleServicesV2,
  handleAppStatusV2,
  handleClearAppCache,
  handleAppCacheStatus
} = require('./appStatusV2');

// 引入 HyperPod API 管理模块
const hyperpodApiManager = require('./hyperpodApiManager');

// 引入 NodeGroup API 管理模块
const nodeGroupApiManager = require('./nodeGroupApiManager');

// 引入日志流管理模块
const logStreamManager = require('./logStreamManager');

// 引入 MLflow API 管理模块
const mlflowApiManager = require('./mlflowApiManager');

// 引入 EKS Creation 管理模块
const eksCreationManager = require('./eksCreationManager');

// 引入 Training Job 管理模块
const trainingJobManager = require('./trainingJobManager');

const app = express();
const PORT = process.env.API_PORT || 3001;
const WS_PORT = process.env.REACT_APP_WS_PORT || 3098; // WebSocket独立端口

app.use(cors());
app.use(express.json());

// WebSocket服务器使用独立端口
const wss = new WebSocket.Server({ port: WS_PORT });

// 日志存储配置 - 简化路径结构
const LOGS_BASE_DIR = path.join(__dirname, '..', 'logs');

// 确保日志目录存在 - 简化版本，直接使用任务名
function ensureLogDirectory(jobName, podName) {
  const jobLogDir = path.join(LOGS_BASE_DIR, jobName);
  if (!fs.existsSync(jobLogDir)) {
    fs.mkdirSync(jobLogDir, { recursive: true });
  }
  return path.join(jobLogDir, `${podName}.log`);
}

// 优化错误消息的函数
function optimizeErrorMessage(errorMessage) {
  if (!errorMessage) return 'Unknown error';
  
  // 如果是获取hyperpodpytorchjob但资源类型不存在，这是正常情况
  if (errorMessage.includes(`doesn't have a resource type "hyperpodpytorchjob"`)) {
    return 'No HyperPod training jobs found (HyperPod operator may not be installed)';
  }
  // 如果是获取rayjob但资源类型不存在
  if (errorMessage.includes(`doesn't have a resource type "rayjob"`)) {
    return 'No RayJobs found (Ray operator may not be installed)';
  }
  // 如果是资源不存在，使用更友好的消息
  if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
    return 'Resource not found - this may be normal if no resources have been created yet';
  }
  // 如果是连接问题
  if (errorMessage.includes('connection refused') || errorMessage.includes('unable to connect')) {
    return 'Unable to connect to Kubernetes cluster. Please check if the cluster is accessible.';
  }
  
  return errorMessage;
}

// 执行kubectl命令的辅助函数 - 简化版错误优化
function executeKubectl(command, timeout = 30000) { // 默认30秒超时
  return new Promise((resolve, reject) => {
    console.log(`Executing kubectl command: kubectl ${command}`);
    
    const child = exec(`kubectl ${command}`, { timeout }, (error, stdout, stderr) => {
      if (error) {
        console.error(`kubectl command failed: kubectl ${command}`);
        console.error(`Error details:`, error);
        console.error(`Stderr:`, stderr);
        
        if (error.code === 'ETIMEDOUT') {
          console.error(`kubectl command timed out after ${timeout}ms: ${command}`);
          reject(new Error(`Command timed out after ${timeout/1000} seconds. The cluster may be slow to respond.`));
        } else {
          const errorMessage = error.message || stderr || 'Unknown kubectl error';
          
          // 针对特定情况优化错误消息
          let optimizedMessage = errorMessage;
          
          // 如果是获取hyperpodpytorchjob但资源类型不存在，这是正常情况
          if (command.includes('get hyperpodpytorchjob') && 
              errorMessage.includes(`doesn't have a resource type "hyperpodpytorchjob"`)) {
            optimizedMessage = 'No HyperPod training jobs found (HyperPod operator may not be installed)';
          }
          // 如果是资源不存在，使用更友好的消息
          else if (errorMessage.includes('not found') || errorMessage.includes('NotFound')) {
            optimizedMessage = 'Resource not found - this may be normal if no resources have been created yet';
          }
          // 如果是连接问题
          else if (errorMessage.includes('connection refused') || errorMessage.includes('unable to connect')) {
            optimizedMessage = 'Unable to connect to Kubernetes cluster. Please check if the cluster is accessible.';
          }
          
          console.error(`Optimized error message: ${optimizedMessage}`);
          reject(new Error(optimizedMessage));
        }
      } else {
        // 优化日志输出：JSON 响应只打印摘要
        if (command.includes('-o json') && stdout.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(stdout);
            const itemCount = parsed.items?.length ?? (parsed.metadata?.name ? 1 : 0);
            const kind = parsed.kind || 'Resource';
            console.log(`kubectl succeeded: kubectl ${command} → ${kind} (${itemCount} items)`);
          } catch {
            // 解析失败时打印截断的输出
            console.log(`kubectl succeeded: kubectl ${command}`);
            console.log(`Output (truncated): ${stdout.substring(0, 200)}...`);
          }
        } else {
          // 非 JSON 命令打印完整输出（通常较短）
          console.log(`kubectl succeeded: kubectl ${command}`);
          if (stdout.trim()) {
            console.log(`Output: ${stdout.trim().substring(0, 500)}${stdout.length > 500 ? '...' : ''}`);
          }
        }
        resolve(stdout);
      }
    });
    
    // 额外的超时保护
    const timeoutId = setTimeout(() => {
      child.kill('SIGTERM');
      console.error(`Force killing kubectl command after ${timeout}ms: ${command}`);
    }, timeout);
    
    child.on('exit', () => {
      clearTimeout(timeoutId);
    });
  });
}

// shouldUseThreadsPerCore2 函数已迁移至 hyperpodApiManager.js
// generateModelTag 函数已迁移至 s3-storage-manager.js

// 生成NLB注解的函数
function generateNLBAnnotations(isExternal) {
  if (isExternal) {
    return `
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"`;
  } else {
    return `
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"
    service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"`;
  }
}

// 简化的命令解析函数 - 移除GPU自动解析逻辑
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

// 改进的HTTP请求代理函数
function makeHttpRequest(url, payload, method = 'POST') {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
      const isGetRequest = method.toUpperCase() === 'GET';
      const postData = isGetRequest ? '' : JSON.stringify(payload);
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method.toUpperCase(),
        headers: {
          'User-Agent': 'Model-Deployment-UI/1.0'
        },
        timeout: 30000 // 30秒超时
      };
      
      // 只有POST请求才需要Content-Type和Content-Length
      if (!isGetRequest) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }
      
      console.log(`HTTP ${method} → ${url}`);

      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          console.log(`HTTP ${method} ← ${res.statusCode} (${data.length} bytes)`);
          
          // 处理不同的响应状态
          if (res.statusCode >= 200 && res.statusCode < 300) {
            // 成功响应
            try {
              const jsonData = JSON.parse(data);
              resolve({
                success: true,
                status: res.statusCode,
                data: jsonData
              });
            } catch (parseError) {
              // 如果不是JSON，返回原始文本
              console.log('Response is not JSON, returning as text');
              resolve({
                success: true,
                status: res.statusCode,
                data: data,
                isText: true
              });
            }
          } else {
            // 错误响应
            try {
              const errorData = JSON.parse(data);
              resolve({
                success: false,
                status: res.statusCode,
                error: errorData.error || `HTTP ${res.statusCode}`,
                data: errorData
              });
            } catch (parseError) {
              resolve({
                success: false,
                status: res.statusCode,
                error: `HTTP ${res.statusCode}: ${data}`,
                data: data
              });
            }
          }
        });
      });
      
      req.on('error', (error) => {
        console.error('HTTP request error:', error);
        reject({
          success: false,
          error: `Network error: ${error.message}`
        });
      });
      
      req.on('timeout', () => {
        console.error('HTTP request timeout');
        req.destroy();
        reject({
          success: false,
          error: 'Request timeout (30s)'
        });
      });
      
      // 只有非GET请求才写入payload
      if (!isGetRequest && postData) {
        req.write(postData);
      }
      req.end();
      
    } catch (error) {
      console.error('HTTP request setup error:', error);
      reject({
        success: false,
        error: `Request setup error: ${error.message}`
      });
    }
  });
}

// 获取Pending GPU统计
app.get('/api/pending-gpus', async (req, res) => {
  try {
    const pendingPodsOutput = await executeKubectl('get pods --field-selector status.phase=Pending -o json');
    const pendingPodsData = JSON.parse(pendingPodsOutput);
    
    let pendingGPUs = 0;
    if (pendingPodsData.items && Array.isArray(pendingPodsData.items)) {
      pendingGPUs = pendingPodsData.items.reduce((sum, pod) => {
        if (pod.spec?.containers) {
          return sum + pod.spec.containers.reduce((containerSum, container) => {
            const gpuRequest = container.resources?.requests?.['nvidia.com/gpu'];
            return containerSum + (parseInt(gpuRequest) || 0);
          }, 0);
        }
        return sum;
      }, 0);
    }
    
    res.json({ pendingGPUs });
  } catch (error) {
    console.error('Error fetching pending GPUs:', error);
    res.status(500).json({ error: error.message, pendingGPUs: 0 });
  }
});

// 获取集群节点GPU使用情况 - V2优化版本
app.get('/api/cluster-status', handleClusterStatusV2);

// 集群状态缓存管理API
app.post('/api/cluster-status/clear-cache', handleClearCache);
app.get('/api/cluster-status/cache-status', handleCacheStatus);

// 统一日志流管理 - 避免冲突
const unifiedLogStreams = new Map(); // 统一管理所有日志流

// 启动统一日志流（支持自动收集和WebSocket流式传输）
function startUnifiedLogStream(jobName, podName, options = {}) {
  const streamKey = `${jobName}-${podName}`;
  const { ws = null, autoCollection = false } = options;
  
  // 如果已经有该pod的日志流，添加WebSocket连接但不重启进程
  if (unifiedLogStreams.has(streamKey)) {
    const existing = unifiedLogStreams.get(streamKey);
    if (ws && !existing.webSockets.has(ws)) {
      existing.webSockets.add(ws);
      console.log(`Added WebSocket to existing log stream for ${streamKey}`);
      
      // 发送连接成功消息
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'log_stream_started',
          jobName: jobName,
          podName: podName,
          timestamp: new Date().toISOString()
        }));
      }
    }
    return;
  }
  
  console.log(`🚀 Starting unified log stream for pod: ${podName} in job: ${jobName} (auto: ${autoCollection})`);
  
  // 创建日志文件路径
  const logFilePath = ensureLogDirectory(jobName, podName);
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  
  // 启动kubectl logs命令
  const logProcess = spawn('kubectl', ['logs', '-f', podName], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  // 创建WebSocket集合
  const webSockets = new Set();
  if (ws) {
    webSockets.add(ws);
  }
  
  // 存储统一的日志流信息
  unifiedLogStreams.set(streamKey, {
    process: logProcess,
    logStream: logStream,
    webSockets: webSockets,
    jobName: jobName,
    podName: podName,
    autoCollection: autoCollection,
    startTime: new Date().toISOString()
  });
  
  // 处理标准输出
  logProcess.stdout.on('data', (data) => {
    const logLine = data.toString();
    const timestamp = new Date().toISOString();
    
    // 写入文件（带时间戳）
    logStream.write(`[${timestamp}] ${logLine}`);
    
    // 发送到所有连接的WebSocket
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_data',
          jobName: jobName,
          podName: podName,
          data: logLine,
          timestamp: timestamp
        }));
      }
    });
  });
  
  // 处理错误输出
  logProcess.stderr.on('data', (data) => {
    const errorLine = data.toString();
    const timestamp = new Date().toISOString();
    
    // 写入文件
    logStream.write(`[${timestamp}] ERROR: ${errorLine}`);
    
    // 发送错误到WebSocket
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_error',
          jobName: jobName,
          podName: podName,
          error: errorLine,
          timestamp: timestamp
        }));
      }
    });
  });
  
  // 处理进程退出
  logProcess.on('close', (code) => {
    console.log(`Unified log stream for ${podName} exited with code ${code}`);
    logStream.end();
    
    // 通知所有WebSocket连接
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_stream_closed',
          jobName: jobName,
          podName: podName,
          timestamp: new Date().toISOString()
        }));
      }
    });
    
    unifiedLogStreams.delete(streamKey);
  });
  
  // 处理进程错误
  logProcess.on('error', (error) => {
    console.error(`Unified log stream error for ${podName}:`, error);
    logStream.end();
    
    // 通知所有WebSocket连接
    webSockets.forEach(socket => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'log_stream_error',
          jobName: jobName,
          podName: podName,
          error: error.message,
          timestamp: new Date().toISOString()
        }));
      }
    });
    
    unifiedLogStreams.delete(streamKey);
  });
  
  // 发送启动成功消息
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'log_stream_started',
      jobName: jobName,
      podName: podName,
      timestamp: new Date().toISOString()
    }));
  }
}

// 从统一日志流中移除WebSocket连接
function removeWebSocketFromLogStream(ws, jobName, podName) {
  const streamKey = `${jobName}-${podName}`;
  const stream = unifiedLogStreams.get(streamKey);
  
  if (stream) {
    stream.webSockets.delete(ws);
    console.log(`Removed WebSocket from log stream ${streamKey}, remaining: ${stream.webSockets.size}`);
    
    // 如果没有WebSocket连接且不是自动收集，停止日志流
    if (stream.webSockets.size === 0 && !stream.autoCollection) {
      console.log(`No more WebSocket connections for ${streamKey}, stopping log stream`);
      stream.process.kill();
      stream.logStream.end();
      unifiedLogStreams.delete(streamKey);
    }
  }
}

// 为训练任务自动开始日志收集
async function startAutoLogCollectionForJob(jobName) {
  try {
    console.log(`🔍 Starting auto log collection for training job: ${jobName}`);
    
    // 获取该训练任务的所有pods
    const output = await executeKubectl('get pods -o json');
    const result = JSON.parse(output);
    
    const jobPods = result.items.filter(pod => {
      const labels = pod.metadata.labels || {};
      const ownerReferences = pod.metadata.ownerReferences || [];
      
      return labels['training-job-name'] === jobName || 
             labels['app'] === jobName ||
             ownerReferences.some(ref => ref.name === jobName) ||
             pod.metadata.name.includes(jobName);
    });
    
    // 为每个运行中的pod开始自动日志收集
    jobPods.forEach(pod => {
      if (pod.status.phase === 'Running' || pod.status.phase === 'Pending') {
        startUnifiedLogStream(jobName, pod.metadata.name, { autoCollection: true });
      }
    });
    
    console.log(`✅ Started auto log collection for ${jobPods.length} pods in job ${jobName}`);
  } catch (error) {
    console.error(`❌ Failed to start auto log collection for job ${jobName}:`, error);
  }
}

// 修改原有的startLogStream函数，使用统一管理
function startLogStream(ws, jobName, podName) {
  startUnifiedLogStream(jobName, podName, { ws: ws });
}

// 修改原有的stopLogStream函数
function stopLogStream(ws, jobName, podName) {
  removeWebSocketFromLogStream(ws, jobName, podName);
  
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'log_stream_stopped',
      jobName: jobName,
      podName: podName,
      timestamp: new Date().toISOString()
    }));
  }
}

// 应用状态V2 API - 优化版本
app.get('/api/v2/pods', handlePodsV2);
app.get('/api/v2/services', handleServicesV2);
app.get('/api/v2/app-status', handleAppStatusV2);
app.post('/api/v2/app-status/clear-cache', handleClearAppCache);
app.get('/api/v2/app-status/cache-status', handleAppCacheStatus);

// V1 API - 已废弃，使用 V2 API 替代 (2025-11-25)
// app.get('/api/pods', async (req, res) => {
//   try {
//     console.log('Fetching pods...');
//     const output = await executeKubectl('get pods -o json');
//     const pods = JSON.parse(output);
//     console.log('Pods fetched:', pods.items.length, 'pods');
//     res.json(pods.items);
//   } catch (error) {
//     console.error('Pods fetch error:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

// V1 API - 已废弃，使用 V2 API 替代 (2025-11-25)
// app.get('/api/services', async (req, res) => {
//   try {
//     console.log('Fetching services...');
//     const output = await executeKubectl('get services -o json');
//     const services = JSON.parse(output);
//     console.log('Services fetched:', services.items.length, 'services');
//     res.json(services.items);
//   } catch (error) {
//     console.error('Services fetch error:', error);
//     res.status(500).json({ error: error.message });
//   }
// });

// 代理HTTP请求到模型服务
app.post('/api/proxy-request', async (req, res) => {
  try {
    const { url, payload, method = 'POST' } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing url'
      });
    }
    
    // GET请求不需要payload
    if (method.toUpperCase() !== 'GET' && payload === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing payload for non-GET request'
      });
    }
    
    console.log(`Proxy ${method} → ${url}`);

    const result = await makeHttpRequest(url, payload, method);

    console.log(`Proxy ${method} ← ${result.success ? 'OK' : 'FAIL'}`);
    res.json(result);
    
  } catch (error) {
    console.error('Proxy request error:', error);
    res.json({
      success: false,
      error: error.error || error.message || 'Request failed'
    });
  }
});

// 新增：代理HTTP请求到模型服务（Port-Forward模式）
app.post('/api/proxy-request-portforward', async (req, res) => {
  const portForwardManager = require('./port-forward-manager');
  let requestId = null;
  
  try {
    const { url, payload, method = 'POST', portForward } = req.body;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing url'
      });
    }
    
    if (!portForward || !portForward.enabled) {
      return res.status(400).json({
        success: false,
        error: 'Port-forward configuration required'
      });
    }
    
    const { serviceName, namespace, servicePort, localPort } = portForward;
    
    console.log(`[Port-Forward Mode] Starting for ${serviceName}...`);
    
    // 启动 port-forward
    const pfResult = await portForwardManager.startTemporary(
      serviceName,
      namespace,
      servicePort,
      localPort
    );
    
    requestId = pfResult.requestId;
    console.log(`[Port-Forward] Started: ${requestId}`);
    
    // 等待 port-forward 完全就绪
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log(`Proxy ${method} → ${url}`);

    const result = await makeHttpRequest(url, payload, method);

    console.log(`Proxy ${method} ← ${result.success ? 'OK' : 'FAIL'}`);
    res.json(result);
    
  } catch (error) {
    console.error('Proxy request error:', error);
    res.json({
      success: false,
      error: error.error || error.message || 'Request failed'
    });
  } finally {
    // 请求完成后立即关闭 port-forward
    if (requestId) {
      portForwardManager.stop(requestId);
      console.log(`[Port-Forward] Stopped: ${requestId}`);
    }
  }
});

// 生成并部署YAML配置 - 仅用于推理部署（Container部署）
app.post('/api/deploy', async (req, res) => {
  try {
    const {
      replicas,
      huggingFaceToken,
      deploymentType,
      deploymentCommand,
      // ollamaModelId - 已移除Ollama支持
      gpuCount,
      gpuMemory = -1,  // 新增：GPU内存配置（MB），默认-1表示忽略HAMi
      instanceTypes = [],  // 新增：多选实例类型数组
      serviceType = 'external',  // 新增：服务类型 ('external', 'clusterip', 'modelpool')
      deploymentName,  // 用户输入的部署名称
      dockerImage = 'vllm/vllm-openai:latest',
      port = 8000,  // 端口配置，默认8000
      cpuRequest = -1,  // CPU请求，默认-1（不设置限制）
      memoryRequest = -1,  // 内存请求，默认-1（不设置限制）
      // Managed Inference specific fields
      modelName,  // 模型名称
      instanceType,  // 单个实例类型 (ml.*)
      s3BucketName,  // S3 存储桶名称
      s3Region,  // S3 区域
      modelLocation,  // S3 中的模型路径
      workerCommand,  // Worker 命令（bash 风格字符串，与 ConfigPanel 格式相同）
      // KV Cache and Intelligent Routing
      kvCache,  // { enableL1Cache, enableL2Cache, l2CacheUrl }
      intelligentRouting,  // { enabled, strategy, sessionKey }
      // Auto-Scaling
      autoScaling  // { enabled, minReplicaCount, maxReplicaCount, pollingInterval, cooldownPeriod, prometheusTrigger }
    } = req.body;

    console.log('Inference deployment request:', {
      deploymentType,
      deploymentName,
      // ollamaModelId - 已移除
      replicas,
      instanceTypes,
      serviceType,
      dockerImage,
      gpuMemory,
      cpuRequest,
      memoryRequest,
      port,
      kvCache,
      intelligentRouting,
      autoScaling
    });

    // 生成带时间戳的唯一标签（符合Kubernetes命名规范）
    // 格式: 251222-021347 (YYMMDD-HHMMSS)
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${yy}${mm}${dd}-${hh}${min}${ss}`;
    const finalDeploymentTag = deploymentName ? `${deploymentName}-${timestamp}` : `model-${timestamp}`;

    console.log(`Generated deployment tag: "${finalDeploymentTag}"`);

    // 根据serviceType确定是否为模型池部署
    const deployAsPool = (serviceType === 'modelpool');
    console.log(`Deploy as pool: ${deployAsPool} (serviceType: ${serviceType})`);

    let templatePath, newYamlContent, servEngine;

    // 生成NLB注解 - 基于serviceType判断是否需要外部访问
    const isExternal = serviceType === 'external';
    const nlbAnnotations = generateNLBAnnotations(isExternal);
    console.log(`Generated NLB annotations (external: ${isExternal}):`, nlbAnnotations);

    // 生成混合调度节点选择器条件
    const generateHybridNodeSelectorTerms = (selectedInstanceTypes) => {
      if (!selectedInstanceTypes || selectedInstanceTypes.length === 0) {
        console.warn('No instance types selected, using default ml.g6.12xlarge');
        selectedInstanceTypes = ['ml.g6.12xlarge'];
      }

      const hyperpodTypes = selectedInstanceTypes.filter(t => t.startsWith('ml.'));
      const gpuTypes = selectedInstanceTypes.filter(t => !t.startsWith('ml.'));

      let nodeSelectorTerms = [];

      // HyperPod 节点选择器（原生 + Karpenter 都有 sagemaker.amazonaws.com/compute-type 标签）
      if (hyperpodTypes.length > 0) {
        nodeSelectorTerms.push(`            # HyperPod 节点（原生 + Karpenter）
            - matchExpressions:
              - key: sagemaker.amazonaws.com/compute-type
                operator: In
                values: ["hyperpod"]
              - key: node.kubernetes.io/instance-type
                operator: In
                values: [${hyperpodTypes.map(t => `"${t}"`).join(', ')}]`);
      }

      // EC2 节点选择器条件 (EKS NodeGroup + Karpenter EC2)
      if (gpuTypes.length > 0) {
        nodeSelectorTerms.push(`            # EC2 GPU 节点 (EKS NodeGroup + Karpenter)
            - matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: [${gpuTypes.map(t => `"${t}"`).join(', ')}]`);
      }

      return nodeSelectorTerms.join('\n');
    };

    const hybridNodeSelectorTerms = generateHybridNodeSelectorTerms(instanceTypes);
    console.log('Generated hybrid node selector terms:', hybridNodeSelectorTerms);

    // 处理 Managed Inference 部署
    if (deploymentType === 'managed-inference') {
      console.log('Processing managed-inference deployment');

      // 使用 deploymentName 作为 modelName
      const effectiveModelName = deploymentName;

      // 验证必需字段
      if (!deploymentName || !instanceType || !s3BucketName || !s3Region || !modelLocation) {
        throw new Error('Missing required fields for managed inference deployment');
      }

      const templatePath = path.join(__dirname, '../templates/managed-inference-template.yaml');
      const templateContent = await fs.readFile(templatePath, 'utf8');

      // 使用 parseVllmCommand 解析命令（复用 ConfigPanel 的解析逻辑）
      const parsedCommand = parseVllmCommand(workerCommand);
      console.log('Parsed managed inference command:', parsedCommand);

      // 转换为 YAML 数组格式
      // 对于 vLLM (vllm serve)，只使用参数部分（args），因为镜像已有 ENTRYPOINT
      // 对于 SGLang 等其他命令，使用完整命令（fullCommand）
      let workerArgsYaml = '';
      let argsToUse = [];

      if (parsedCommand.commandType === 'vllm') {
        // vLLM: 镜像有 ENTRYPOINT ["vllm", "serve"]，只需要参数
        argsToUse = parsedCommand.args || [];
        console.log('Using args only for vLLM (ENTRYPOINT exists):', argsToUse);
      } else {
        // SGLang/Custom: 需要完整命令
        argsToUse = parsedCommand.fullCommand || [];
        console.log('Using full command for non-vLLM:', argsToUse);
      }

      if (argsToUse.length > 0) {
        workerArgsYaml = argsToUse.map(arg => `\n      - "${arg}"`).join('');
      }

      // 处理 GPU Memory (HAMi)
      let gpuMemoryYaml = '';
      if (gpuMemory && gpuMemory !== -1 && gpuMemory > 0) {
        gpuMemoryYaml = `\n        nvidia.com/gpumem: ${gpuMemory}`;
      }

      // 处理 CPU 和 Memory 请求
      // -1 表示不设置限制，不填充到模板中（空字符串）
      let cpuRequestYaml = '';
      let memoryRequestYaml = '';
      if (cpuRequest && cpuRequest !== -1 && cpuRequest > 0) {
        cpuRequestYaml = `\n        cpu: "${cpuRequest}"`;
      }
      if (memoryRequest && memoryRequest !== -1 && memoryRequest > 0) {
        memoryRequestYaml = `\n        memory: ${memoryRequest}Gi`;
      }

      // HAMi label 不适用于 Managed Inference（CRD 不支持 Pod labels）
      const hamiLabel = '';

      // 处理 KV Cache 配置
      let kvCacheSpecYaml = '';
      if (kvCache && (kvCache.enableL1Cache || kvCache.enableL2Cache)) {
        kvCacheSpecYaml = '\n\n  kvCacheSpec:';
        if (kvCache.enableL1Cache) {
          kvCacheSpecYaml += '\n    enableL1Cache: true';
        }
        if (kvCache.enableL2Cache) {
          kvCacheSpecYaml += '\n    enableL2Cache: true';
          kvCacheSpecYaml += '\n    l2CacheSpec:';
          // 支持 tieredstorage 和 redis 两种后端
          const l2Backend = kvCache.l2CacheBackend || 'tieredstorage';
          kvCacheSpecYaml += `\n      l2CacheBackend: "${l2Backend}"`;
          // 只有 redis 后端才需要 l2CacheLocalUrl
          if (l2Backend === 'redis' && kvCache.l2CacheUrl) {
            kvCacheSpecYaml += `\n      l2CacheLocalUrl: "${kvCache.l2CacheUrl}"`;
          }
        }
      }

      // 处理 Intelligent Routing 配置
      let intelligentRoutingSpecYaml = '';
      if (intelligentRouting && intelligentRouting.enabled) {
        intelligentRoutingSpecYaml = '\n  intelligentRoutingSpec:';
        intelligentRoutingSpecYaml += '\n    enabled: true';
        intelligentRoutingSpecYaml += `\n    routingStrategy: ${intelligentRouting.strategy}`;
      }

      // 处理 Session Key 环境变量（仅在 session 或 kvaware 策略时添加）
      let sessionKeyEnvYaml = '';
      if (intelligentRouting && intelligentRouting.enabled && 
          (intelligentRouting.strategy === 'session' || intelligentRouting.strategy === 'kvaware') &&
          intelligentRouting.sessionKey) {
        sessionKeyEnvYaml = `\n      - name: SESSION_KEY\n        value: "${intelligentRouting.sessionKey}"`;
      }

      // 处理 Auto-Scaling 配置
      let autoScalingSpecYaml = '';
      if (autoScaling && autoScaling.enabled) {
        autoScalingSpecYaml = '\n\n  autoScalingSpec:';
        autoScalingSpecYaml += `\n    minReplicaCount: ${autoScaling.minReplicaCount}`;
        autoScalingSpecYaml += `\n    maxReplicaCount: ${autoScaling.maxReplicaCount}`;
        autoScalingSpecYaml += `\n    pollingInterval: ${autoScaling.pollingInterval || 30}`;
        autoScalingSpecYaml += `\n    cooldownPeriod: ${autoScaling.cooldownPeriod || 120}`;
        autoScalingSpecYaml += `\n    scaleDownStabilizationTime: ${autoScaling.scaleDownStabilizationTime || 60}`;
        autoScalingSpecYaml += `\n    scaleUpStabilizationTime: ${autoScaling.scaleUpStabilizationTime || 0}`;
        
        // Prometheus Trigger
        if (autoScaling.prometheusTrigger) {
          const prom = autoScaling.prometheusTrigger;
          autoScalingSpecYaml += '\n    prometheusTrigger:';
          autoScalingSpecYaml += `\n      serverAddress: "${prom.serverAddress}"`;
          autoScalingSpecYaml += `\n      query: "${prom.query}"`;
          autoScalingSpecYaml += `\n      targetValue: ${prom.targetValue}`;
          if (prom.activationTargetValue !== undefined) {
            autoScalingSpecYaml += `\n      activationTargetValue: ${prom.activationTargetValue}`;
          }
        }
      }

      // 替换模板中的占位符
      newYamlContent = templateContent
        .replace(/DEPLOYMENT_NAME/g, finalDeploymentTag)
        .replace(/MODEL_NAME/g, effectiveModelName)
        .replace(/INSTANCE_TYPE/g, instanceType)
        .replace(/REPLICAS_COUNT/g, replicas.toString())
        .replace(/AUTOSCALING_SPEC/g, autoScalingSpecYaml)
        .replace(/S3_BUCKET_NAME/g, s3BucketName)
        .replace(/AWS_REGION/g, s3Region)
        .replace(/MODEL_LOCATION/g, modelLocation)
        .replace(/DOCKER_IMAGE/g, dockerImage)
        .replace(/WORKER_ARGS/g, workerArgsYaml)
        .replace(/PORT_NUMBER/g, port.toString())
        .replace(/CPU_REQUEST/g, cpuRequestYaml)
        .replace(/MEMORY_REQUEST/g, memoryRequestYaml)
        .replace(/GPU_COUNT/g, gpuCount.toString())
        .replace(/GPU_MEMORY/g, gpuMemoryYaml)
        .replace(/HAMI_LABEL/g, hamiLabel)
        .replace(/KV_CACHE_SPEC/g, kvCacheSpecYaml)
        .replace(/INTELLIGENT_ROUTING_SPEC/g, intelligentRoutingSpecYaml)
        .replace(/SESSION_KEY_ENV/g, sessionKeyEnvYaml);

      // 生成 Service YAML（仅在 external 模式下）
      // internal 模式使用 Inference Operator 自动创建的 routing-service
      if (serviceType === 'external') {
        const serviceYaml = EKSServiceHelper.generateManagedInferenceService(
          finalDeploymentTag,
          serviceType,
          port,
          nlbAnnotations
        );
        newYamlContent += serviceYaml;
        console.log('Generated external Service for managed inference');
      } else {
        console.log('Internal mode: using Inference Operator routing-service, no additional Service generated');
      }

      servEngine = 'managed-inf';
      console.log('Generated managed inference YAML with service type:', serviceType);
    }
    // 处理Container部署（移除了Ollama支持）
    else {
      // 处理VLLM/SGLang/Custom部署
      const parsedCommand = parseVllmCommand(deploymentCommand);
      console.log('Parsed command:', parsedCommand);
      
      // 根据命令类型确定服务引擎前缀
      if (parsedCommand.commandType === 'sglang') {
        servEngine = 'sglang';
      } else if (parsedCommand.commandType === 'vllm') {
        servEngine = 'vllm';
      } else {
        servEngine = 'custom';  // 自定义命令使用custom前缀
      }
      console.log(`Using service engine: ${servEngine} for command type: ${parsedCommand.commandType}`);

      // 统一使用混合调度模板
      const templatePath = path.join(__dirname, '../templates/inference-container-hybrid-template.yaml');
      console.log('Using unified hybrid scheduling template for all deployment types');
      
      const templateContent = await fs.readFile(templatePath, 'utf8');
      
      // 生成HuggingFace token环境变量（如果提供了token）
      let hfTokenEnv = '';
      if (huggingFaceToken && huggingFaceToken.trim() !== '') {
        hfTokenEnv = `
            - name: HUGGING_FACE_HUB_TOKEN
              value: "${huggingFaceToken}"`;
      }
      
      // 替换模板中的占位符 - 使用混合调度和Service类型
      // 动态生成resources部分
      const generateResourcesSection = (cpuRequest, memoryRequest, gpuCount, gpuMemory) => {
        const limits = [`nvidia.com/gpu: ${gpuCount}`];
        const requests = [`nvidia.com/gpu: ${gpuCount}`];
        
        // 如果设置了 GPU 内存（不是 -1），添加 HAMi GPU 内存配置
        if (gpuMemory > 0) {
          limits.push(`nvidia.com/gpumem: ${gpuMemory}`);
          requests.push(`nvidia.com/gpumem: ${gpuMemory}`);
        }
        
        if (cpuRequest > 0) {
          limits.push(`cpu: "${cpuRequest}"`);
          requests.push(`cpu: "${cpuRequest}"`);
        }
        
        if (memoryRequest > 0) {
          limits.push(`memory: ${memoryRequest}Gi`);
          requests.push(`memory: ${memoryRequest}Gi`);
        }
        
        return `resources:
            limits:
              ${limits.join('\n              ')}
            requests:
              ${requests.join('\n              ')}`;
      };

      const resourcesSection = generateResourcesSection(cpuRequest, memoryRequest, gpuCount, gpuMemory);
      
      // 生成 HAMi webhook ignore label（如果 gpuMemory 是 -1）
      const hamiLabel = gpuMemory === -1 
        ? '\n        hami.io/webhook: ignore' 
        : '';

      newYamlContent = templateContent
        .replace(/SERVENGINE/g, servEngine)
        .replace(/MODEL_TAG/g, finalDeploymentTag)
        .replace(/REPLICAS_COUNT/g, replicas.toString())
        .replace(/GPU_COUNT/g, gpuCount.toString())
        .replace(/HYBRID_NODE_SELECTOR_TERMS/g, hybridNodeSelectorTerms)
        .replace(/HF_TOKEN_ENV/g, hfTokenEnv)
        .replace(/ENTRY_CMD/g, JSON.stringify(parsedCommand.fullCommand))
        .replace(/DOCKER_IMAGE/g, dockerImage)
        .replace(/PORT_NUMBER/g, port || 8000)
        .replace(/RESOURCES_SECTION/g, resourcesSection)
        .replace(/NLB_ANNOTATIONS/g, nlbAnnotations)
        .replace(/HAMI_LABEL/g, hamiLabel);

      // 在标准标签后面添加 Model Pool 标签
      if (serviceType === 'modelpool') {
        // 在 deployment metadata labels 的 deployment-tag 后添加
        newYamlContent = newYamlContent.replace(
          /(\s+deployment-tag: "[^"]+"\n)/,
          `$1    model-id: "${finalDeploymentTag}"\n    deployment-type: "model-pool"\n`
        );
        
        // 在 template metadata labels 的 model-type 后添加
        newYamlContent = newYamlContent.replace(
          /(\s+model-type: "[^"]+"\n)(\s+spec:)/,
          `$1        model-id: "${finalDeploymentTag}"\n        business: "unassigned"\n        deployment-type: "model-pool"\n$2`
        );
      }

      // 使用EKSServiceHelper生成Service YAML
      if (serviceType !== 'modelpool') {
        const serviceYaml = EKSServiceHelper.generateServiceYaml(
          serviceType,
          servEngine,
          finalDeploymentTag,
          port || 8000,
          nlbAnnotations
        );

        if (serviceYaml) {
          newYamlContent += '\n' + serviceYaml;
          console.log(`Generated ${serviceType} Service YAML`);
        } else {
          console.log('No Service generated (Model Pool mode)');
        }
      }
    }
    
    // 保存到项目目录中的deployments/inference文件夹
    const deploymentsDir = path.join(__dirname, '../deployments/inference');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    
    const accessType = isExternal ? 'external' : 'internal';
    const poolType = deployAsPool ? 'pool' : 'standard';
    // 使用实际的引擎类型：container使用解析出的servEngine
    const actualEngineType = servEngine;
    const tempYamlPath = path.join(deploymentsDir, `${finalDeploymentTag}-${actualEngineType}-${poolType}-${accessType}.yaml`);
    await fs.writeFile(tempYamlPath, newYamlContent);
    
    console.log(`Generated YAML saved to: ${tempYamlPath}`);
    
    // 执行kubectl apply
    const applyOutput = await executeKubectl(`apply -f ${tempYamlPath}`);
    
    // 广播部署状态更新
    const deploymentMessage = deployAsPool 
      ? `Successfully deployed model pool: ${finalDeploymentTag}` 
      : `Successfully deployed: ${finalDeploymentTag} (${accessType} access)`;
      
    broadcast({
      type: 'deployment',
      status: 'success',
      message: deploymentMessage,
      output: applyOutput
    });
    
    res.json({
      success: true,
      message: 'Deployment successful',
      output: applyOutput,
      yamlPath: tempYamlPath,
      generatedYaml: newYamlContent,
      deploymentType: servEngine,
      deploymentTag: finalDeploymentTag,
      accessType
    });
    
  } catch (error) {
    console.error('Deployment error:', error);
    
    broadcast({
      type: 'deployment',
      status: 'error',
      message: `Deployment failed: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 部署绑定Service
app.post('/api/deploy-service', async (req, res) => {
  try {
    const {
      serviceName,
      modelPool,
      serviceType = 'external'
    } = req.body;

    console.log('Binding service deployment request:', { 
      serviceName, 
      modelPool, 
      serviceType
    });

    // 获取 deployment 信息以提取 model-type 和端口
    const deploymentOutput = await executeKubectl(`get deployment ${modelPool} -o json`);
    const deployment = JSON.parse(deploymentOutput);
    
    // 从 deployment 标签中获取 model-type 和 model-id
    const labels = deployment.metadata.labels || {};
    const modelType = labels['model-type'] || 'unknown';
    const modelId = labels['deployment-tag'] || modelPool;
    
    // 从 deployment 的容器配置中获取端口
    const containers = deployment.spec.template.spec.containers || [];
    const mainContainer = containers[0];
    const containerPorts = mainContainer?.ports || [];
    const port = containerPorts.find(p => p.name === 'http')?.containerPort || 8000;
    
    console.log(`Extracted from deployment ${modelPool}:`, { modelType, modelId, port });

    // 使用 EKSServiceHelper 生成 Service YAML
    const EKSServiceHelper = require('./utils/eksServiceHelper');
    const isExternal = serviceType === 'external';
    const nlbAnnotations = isExternal ? generateNLBAnnotations(true) : '';
    
    const serviceYaml = EKSServiceHelper.generateBindingService(
      serviceName,
      modelId,
      modelType,
      serviceType,
      port,
      nlbAnnotations
    );
    
    // 保存到 deployments/inference 目录
    const deploymentsDir = path.join(__dirname, '../deployments/inference');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    
    const tempYamlPath = path.join(deploymentsDir, `${serviceName}-binding-${serviceType}.yaml`);
    await fs.writeFile(tempYamlPath, serviceYaml);
    
    console.log(`Generated binding service YAML saved to: ${tempYamlPath}`);
    
    // 执行kubectl apply
    const applyOutput = await executeKubectl(`apply -f ${tempYamlPath}`);
    
    // 广播部署状态更新
    broadcast({
      type: 'service_deployment',
      status: 'success',
      message: `Successfully deployed binding service: ${serviceName}`,
      output: applyOutput
    });
    
    res.json({
      success: true,
      message: `Binding service ${serviceName} deployed successfully`,
      serviceName,
      modelId,
      modelType,
      serviceType
    });
    
  } catch (error) {
    console.error('Service deployment error:', error);
    
    broadcast({
      type: 'service_deployment',
      status: 'error',
      message: `Service deployment failed: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ========== Training APIs 已迁移至 trainingJobManager.js ==========
// 包括: launch-*-training, *-config/save|load, training-jobs, hyperpod-jobs, rayjobs 等

// 🔄 获取所有 InferenceEndpointConfig 资源
app.get('/api/inference-endpoints', async (req, res) => {
  try {
    console.log('Fetching InferenceEndpointConfig resources...');

    let inferenceEndpoints = [];
    try {
      const output = await executeKubectl('get inferenceendpointconfig -A -o json');
      const result = JSON.parse(output);
      inferenceEndpoints = result.items.map(endpoint => ({
        name: endpoint.metadata.name,
        namespace: endpoint.metadata.namespace || 'default',
        creationTimestamp: endpoint.metadata.creationTimestamp,
        modelName: endpoint.spec?.modelName || '-',
        instanceType: endpoint.spec?.instanceType || '-',
        replicas: endpoint.spec?.replicas || 0,
        s3Bucket: endpoint.spec?.modelSourceConfig?.s3Storage?.bucketName || '-',
        s3Region: endpoint.spec?.modelSourceConfig?.s3Storage?.region || '-',
        modelLocation: endpoint.spec?.modelSourceConfig?.modelLocation || '-',
        status: endpoint.status || {},
        state: endpoint.status?.state || 'Unknown',
        deploymentStatus: endpoint.status?.deploymentStatus?.deploymentObjectOverallState || 'Unknown',
        availableReplicas: endpoint.status?.deploymentStatus?.status?.availableReplicas || 0,
        totalReplicas: endpoint.status?.deploymentStatus?.status?.replicas || 0
      }));
    } catch (error) {
      const optimizedMessage = optimizeErrorMessage(error.message);
      console.log('No InferenceEndpointConfig found or error:', optimizedMessage);

      // 如果是资源类型不存在，返回友好提示
      if (error.message.includes(`doesn't have a resource type "inferenceendpointconfig"`)) {
        return res.json({
          success: true,
          endpoints: [],
          message: 'No InferenceEndpointConfig found (Inference Operator may not be installed)'
        });
      }
    }

    console.log(`Found ${inferenceEndpoints.length} inference endpoints:`,
                inferenceEndpoints.map(e => e.name));

    res.json({
      success: true,
      endpoints: inferenceEndpoints
    });
  } catch (error) {
    console.error('Error fetching inference endpoints:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      endpoints: []
    });
  }
});

// 🔄 删除指定的 InferenceEndpointConfig
app.delete('/api/inference-endpoints/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { namespace } = req.query; // 从 query 获取 namespace，默认为 default
    const ns = namespace || 'default';

    console.log(`Deleting InferenceEndpointConfig: ${name} in namespace: ${ns}`);

    const output = await executeKubectl(`delete inferenceendpointconfig ${name} -n ${ns}`);
    console.log('Delete output:', output);

    // 广播删除状态更新
    broadcast({
      type: 'inference_endpoint_deleted',
      status: 'success',
      message: `Inference endpoint "${name}" deleted successfully`,
      endpointName: name,
      namespace: ns
    });

    res.json({
      success: true,
      message: `Inference endpoint "${name}" deleted successfully`,
      output: output
    });
  } catch (error) {
    console.error('Error deleting inference endpoint:', error);

    broadcast({
      type: 'inference_endpoint_deleted',
      status: 'error',
      message: `Failed to delete inference endpoint: ${error.message}`
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Pod 日志 API 已迁移至 logStreamManager.js

// 删除部署 - 改进版本
app.post('/api/undeploy', async (req, res) => {
  try {
    const { modelTag, deleteType } = req.body;
    
    if (!modelTag) {
      return res.status(400).json({
        success: false,
        error: 'Model tag is required'
      });
    }
    
    console.log(`Undeploying deployment: ${modelTag}, type: ${deleteType}`);
    
    let results = [];
    let actuallyDeleted = 0;
    
    // 删除Deployment
    if (deleteType === 'all' || deleteType === 'deployment') {
      try {
        console.log(`Executing: kubectl delete deployment ${modelTag}`);
        const output = await executeKubectl(`delete deployment ${modelTag}`);
        console.log(`Delete deployment output: ${output}`);
        
        results.push({
          resource: 'deployment',
          name: modelTag,
          success: true,
          output: output.trim()
        });
        actuallyDeleted++;
      } catch (error) {
        console.error(`Failed to delete deployment ${modelTag}:`, error);
        results.push({
          resource: 'deployment',
          name: modelTag,
          success: false,
          error: error.message
        });
      }
    }
    
    // 删除对应的Service
    if (deleteType === 'all' || deleteType === 'service') {
      // 解析modelTag，提取servEngine和原始deploymentTag
      // modelTag格式: "sglang-sssr-2025-10-30-08-35-05-inference"
      // 需要提取: servEngine="sglang", originalTag="sssr-2025-10-30-08-35-05"

      const possibleServices = [];

      // 尝试解析 servEngine (vllm, sglang, 等)
      const knownEngines = ['vllm', 'sglang', 'custom'];
      let servEngine = null;
      let originalTag = null;

      for (const engine of knownEngines) {
        if (modelTag.startsWith(`${engine}-`)) {
          servEngine = engine;
          // 去掉前缀和后缀获得原始tag
          let remaining = modelTag.substring(engine.length + 1); // 去掉 "sglang-"
          if (remaining.endsWith('-inference')) {
            originalTag = remaining.substring(0, remaining.length - 10); // 去掉 "-inference"
          } else if (remaining.endsWith('-pool')) {
            originalTag = remaining.substring(0, remaining.length - 5); // 去掉 "-pool"
          } else {
            originalTag = remaining;
          }
          break;
        }
      }

      if (servEngine && originalTag) {
        // 使用EKSServiceHelper的命名规律
        possibleServices.push(
          `${servEngine}-${originalTag}-nlb`,      // External LoadBalancer
          `${servEngine}-${originalTag}-service`   // ClusterIP Service
        );
        console.log(`Parsed service names for deletion: servEngine=${servEngine}, originalTag=${originalTag}`);
      } else {
        console.error(`Failed to parse modelTag: ${modelTag}. Expected format: {engine}-{tag}-{suffix}`);
        return res.status(400).json({
          success: false,
          error: `Invalid modelTag format: ${modelTag}. Cannot determine service names for deletion.`
        });
      }
      
      for (const serviceName of possibleServices) {
        try {
          console.log(`Executing: kubectl delete service ${serviceName}`);
          const output = await executeKubectl(`delete service ${serviceName} --ignore-not-found=true`);
          console.log(`Delete service output: ${output}`);
          
          if (!output.includes('not found')) {
            results.push({
              resource: 'service',
              name: serviceName,
              success: true,
              output: output.trim()
            });
            actuallyDeleted++;
          }
        } catch (error) {
          console.error(`Failed to delete service ${serviceName}:`, error);
        }
      }
    }
    
    // 广播删除状态更新
    broadcast({
      type: 'undeployment',
      status: 'success',
      message: `Successfully deleted ${actuallyDeleted} resource(s) for ${modelTag}`,
      results: results
    });
    
    res.json({
      success: true,
      message: `Successfully deleted ${actuallyDeleted} resource(s)`,
      results: results,
      modelTag: modelTag,
      actuallyDeleted: actuallyDeleted
    });
    
  } catch (error) {
    console.error('Undeploy error:', error);
    
    broadcast({
      type: 'undeployment',
      status: 'error',
      message: `Failed to undeploy ${req.body.modelTag}: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取部署详细信息（包含模型元数据）
app.get('/api/deployment-details', async (req, res) => {
  try {
    console.log('Fetching deployment details with metadata...');
    
    // 获取所有deployment
    const deploymentsOutput = await executeKubectl('get deployments -o json');
    const deployments = JSON.parse(deploymentsOutput);
    
    // 获取所有service
    const servicesOutput = await executeKubectl('get services -o json');
    const services = JSON.parse(servicesOutput);
    
    // 过滤出模型相关的部署并提取元数据
    const modelDeployments = deployments.items
      .filter(deployment => 
        deployment.metadata.name.includes('vllm') || 
        deployment.metadata.name.includes('olm') ||
        deployment.metadata.name.includes('inference')
      )
      .map(deployment => {
        const labels = deployment.metadata.labels || {};
        const appLabel = labels.app;
        
        // 查找对应的service
        const matchingService = services.items.find(service => 
          service.spec.selector?.app === appLabel
        );
        
        // 从标签中提取模型信息
        const modelType = labels['model-type'] || 'unknown';
        const encodedModelId = labels['model-id'] || 'unknown';
        const modelTag = labels['model-tag'] || 'unknown';
        
        // 确定最终的模型ID - 优先从容器命令中提取原始ID
        let modelId = 'unknown';
        
        // 对于VLLM部署，从容器命令中提取原始模型ID
        if (modelType === 'vllm') {
          try {
            const containers = deployment.spec?.template?.spec?.containers || [];
            const vllmContainer = containers.find(c => c.name === 'vllm-openai');
            if (vllmContainer && vllmContainer.command) {
              const command = vllmContainer.command;
              
              // 1. 优先检查新的 vllm serve 格式
              const serveIndex = command.findIndex(arg => arg === 'serve');
              if (serveIndex !== -1 && serveIndex + 1 < command.length) {
                // 检查前一个参数是否是 vllm 相关
                if (serveIndex > 0 && command[serveIndex - 1].includes('vllm')) {
                  const modelPath = command[serveIndex + 1];
                  // 确保不是以 -- 开头的参数
                  if (!modelPath.startsWith('--')) {
                    modelId = modelPath;
                  }
                }
              }
              
              // 2. 如果没找到，检查传统的 --model 参数
              if (modelId === 'unknown') {
                const modelIndex = command.findIndex(arg => arg === '--model');
                if (modelIndex !== -1 && modelIndex + 1 < command.length) {
                  modelId = command[modelIndex + 1]; // 获取--model参数后的值
                }
              }
            }
          } catch (error) {
            console.log('Failed to extract model ID from VLLM command:', error.message);
          }
        }
        
        // 移除了Ollama特定的模型ID提取逻辑
        
        // 对于无法提取的情况，使用解码逻辑
        if (modelId === 'unknown' && encodedModelId !== 'unknown') {
          modelId = decodeModelIdFromLabel(encodedModelId);
        }
        
        // 获取服务URL
        let serviceUrl = '';
        if (matchingService) {
          const ingress = matchingService.status?.loadBalancer?.ingress?.[0];
          if (ingress) {
            const host = ingress.hostname || ingress.ip;
            const port = matchingService.spec.ports?.[0]?.port || 8000;
            serviceUrl = `http://${host}:${port}`;
          }
        }
        
        return {
          deploymentName: deployment.metadata.name,
          serviceName: matchingService?.metadata.name || 'N/A',
          modelType: modelType,
          modelId: modelId,
          modelTag: modelTag,
          serviceUrl: serviceUrl,
          status: deployment.status.readyReplicas === deployment.spec.replicas ? 'Ready' : 'Pending',
          replicas: deployment.spec.replicas,
          readyReplicas: deployment.status.readyReplicas || 0,
          hasService: !!matchingService,
          isExternal: matchingService?.metadata?.annotations?.['service.beta.kubernetes.io/aws-load-balancer-scheme'] === 'internet-facing'
        };
      });
    
    console.log('Deployment details fetched:', modelDeployments.length, 'deployments');
    res.json(modelDeployments);
    
  } catch (error) {
    console.error('Deployment details fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pod分配管理API
app.post('/api/assign-pod', async (req, res) => {
  try {
    const { podName, businessTag, modelId } = req.body;
    
    console.log('Pod assignment request:', { podName, businessTag, modelId });
    
    // 验证参数
    if (!podName || !businessTag || !modelId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required parameters: podName, businessTag, modelId' 
      });
    }
    
    // 验证Pod存在且属于指定模型
    const podCheckCmd = `get pod ${podName} -o json`;
    const podResult = await executeKubectl(podCheckCmd);
    const pod = JSON.parse(podResult);
    
    if (!pod.metadata.labels?.['model-id'] || pod.metadata.labels['model-id'] !== modelId) {
      return res.status(400).json({ 
        success: false, 
        error: `Pod model-id '${pod.metadata.labels?.['model-id']}' does not match expected '${modelId}'` 
      });
    }
    
    // 执行Pod标签修改
    const labelCmd = `label pod ${podName} business=${businessTag} --overwrite`;
    await executeKubectl(labelCmd);
    
    console.log(`Pod ${podName} assigned to business: ${businessTag}`);
    
    // 广播Pod分配更新
    broadcast({
      type: 'pod_assigned',
      status: 'success',
      message: `Pod ${podName} assigned to ${businessTag}`,
      podName,
      businessTag,
      modelId
    });
    
    res.json({ 
      success: true, 
      message: `Pod ${podName} successfully assigned to ${businessTag}`,
      podName,
      businessTag
    });
    
  } catch (error) {
    console.error('Pod assignment error:', error);
    
    broadcast({
      type: 'pod_assigned',
      status: 'error',
      message: `Failed to assign pod: ${error.message}`
    });
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Service删除API
app.delete('/api/delete-service/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    
    console.log(`Deleting service: ${serviceName}`);
    
    // 1. 获取Service信息，确定对应的business标签
    let businessTag = null;
    try {
      const serviceInfoCmd = `get service ${serviceName} -o json`;
      const serviceInfo = await executeKubectl(serviceInfoCmd);
      const service = JSON.parse(serviceInfo);
      businessTag = service.metadata?.labels?.business;
      console.log(`Service ${serviceName} has business tag: ${businessTag}`);
    } catch (error) {
      console.log(`Could not get service info for ${serviceName}, proceeding with deletion`);
    }
    
    // 2. 删除Service
    const deleteCmd = `delete service ${serviceName}`;
    await executeKubectl(deleteCmd);
    
    // 3. 如果有business标签，将所有相关Pod重置为unassigned
    if (businessTag && businessTag !== 'unassigned') {
      try {
        console.log(`Resetting pods with business=${businessTag} to unassigned`);
        
        // 获取所有带有该business标签的Pod
        const getPodsCmd = `get pods -l business=${businessTag} -o json`;
        const podsResult = await executeKubectl(getPodsCmd);
        const pods = JSON.parse(podsResult);
        
        // 重置每个Pod的business标签
        for (const pod of pods.items) {
          const podName = pod.metadata.name;
          console.log(`Resetting pod ${podName} to unassigned`);
          const labelCmd = `label pod ${podName} business=unassigned --overwrite`;
          await executeKubectl(labelCmd);
        }
        
        console.log(`Reset ${pods.items.length} pods to unassigned`);
      } catch (error) {
        console.error(`Error resetting pods for business ${businessTag}:`, error);
        // 不阻止Service删除，只记录错误
      }
    }
    
    console.log(`Service ${serviceName} deleted successfully`);
    
    // 广播Service删除更新
    broadcast({
      type: 'service_deleted',
      status: 'success',
      message: `Service ${serviceName} deleted successfully`,
      serviceName,
      businessTag,
      resetPods: businessTag ? true : false
    });
    
    res.json({ 
      success: true, 
      message: `Service ${serviceName} deleted successfully`,
      serviceName,
      resetPods: businessTag ? true : false
    });
    
  } catch (error) {
    console.error('Service deletion error:', error);
    
    // 广播删除失败
    broadcast({
      type: 'service_deleted',
      status: 'error',
      message: `Failed to delete service: ${error.message}`,
      serviceName: req.params.serviceName
    });
    
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Deployment Scale API
app.post('/api/scale-deployment', async (req, res) => {
  try {
    const { deploymentName, replicas, isModelPool } = req.body;

    console.log(`Scaling deployment ${deploymentName} to ${replicas} replicas (Model Pool: ${isModelPool})`);

    if (isModelPool) {
      // Model Pool 的前置检查：如果是缩容且所有 pod 都已分配，则阻止操作
      const deploymentInfo = await executeKubectl(`get deployment ${deploymentName} -o json`);
      const deployment = JSON.parse(deploymentInfo);
      const currentReplicas = deployment.spec.replicas;

      if (replicas < currentReplicas) {
        // 缩容操作，需要检查 pod 分配状态
        const modelId = deployment.metadata.labels?.['model-id'];
        if (modelId) {
          const podsResult = await executeKubectl(`get pods -l model-id=${modelId} --no-headers -o custom-columns="NAME:.metadata.name,BUSINESS:.metadata.labels.business"`);
          const podLines = podsResult.trim().split('\n').filter(line => line.trim());

          // 计算 unassigned 和 assigned pods
          let unassignedCount = 0;
          let assignedCount = 0;

          podLines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            const business = parts[1];
            if (!business || business === 'unassigned' || business === '<none>') {
              unassignedCount++;
            } else {
              assignedCount++;
            }
          });

          const podsToRemove = currentReplicas - replicas;

          if (unassignedCount < podsToRemove) {
            // 没有足够的 unassigned pod 可以删除
            throw new Error(`Cannot scale down: ${assignedCount} pods are assigned to service bindings. Please unassign services before scaling down.`);
          }

          console.log(`Scale down check passed: ${unassignedCount} unassigned pods available, need to remove ${podsToRemove} pods`);
        }
      }
    }

    // 统一使用标准的 kubectl scale 命令
    const scaleCmd = `scale deployment ${deploymentName} --replicas=${replicas}`;
    await executeKubectl(scaleCmd);

    console.log(`Deployment ${deploymentName} scaled successfully`);

    // 广播Scale更新
    broadcast({
      type: 'deployment_scaled',
      status: 'success',
      message: `Deployment ${deploymentName} scaled to ${replicas} replicas`,
      deploymentName,
      replicas,
      isModelPool
    });

    res.json({
      success: true,
      message: `Deployment ${deploymentName} scaled to ${replicas} replicas`,
      deploymentName,
      replicas
    });

  } catch (error) {
    console.error('Deployment scale error:', error);

    broadcast({
      type: 'deployment_scaled',
      status: 'error',
      message: `Failed to scale deployment: ${error.message}`,
      deploymentName: req.body.deploymentName
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Model Pool智能Scale处理函数 (已废弃，改用统一的kubectl scale + 前置检查)
/*
async function handleModelPoolScale(deploymentName, targetReplicas) {
  // 获取当前Deployment信息
  const deploymentInfo = await executeKubectl(`get deployment ${deploymentName} -o json`);
  const deployment = JSON.parse(deploymentInfo);
  const currentReplicas = deployment.spec.replicas;
  
  console.log(`Current replicas: ${currentReplicas}, Target: ${targetReplicas}`);
  
  if (targetReplicas > currentReplicas) {
    // Scale Up: 直接增加副本数，新Pod会自动带unassigned标签
    console.log(`Scaling up from ${currentReplicas} to ${targetReplicas}`);
    const scaleCmd = `scale deployment ${deploymentName} --replicas=${targetReplicas}`;
    await executeKubectl(scaleCmd);
  } else if (targetReplicas < currentReplicas) {
    // Scale Down: 优先删除unassigned的Pod
    console.log(`Scaling down from ${currentReplicas} to ${targetReplicas}`);
    
    const podsToRemove = currentReplicas - targetReplicas;
    console.log(`Need to remove ${podsToRemove} pods`);
    
    // 获取所有相关Pod
    const modelId = deployment.metadata.labels?.['model-id'];
    if (!modelId) {
      throw new Error('Cannot find model-id label in deployment');
    }
    
    const podsResult = await executeKubectl(`get pods -l model-id=${modelId} -o json`);
    const pods = JSON.parse(podsResult);
    
    // 分类Pod：unassigned和assigned
    const unassignedPods = pods.items.filter(pod => 
      pod.metadata.labels?.business === 'unassigned'
    );
    const assignedPods = pods.items.filter(pod => 
      pod.metadata.labels?.business !== 'unassigned'
    );
    
    console.log(`Found ${unassignedPods.length} unassigned pods, ${assignedPods.length} assigned pods`);
    
    if (unassignedPods.length >= podsToRemove) {
      // 有足够的unassigned Pod可以删除
      for (let i = 0; i < podsToRemove; i++) {
        const podName = unassignedPods[i].metadata.name;
        console.log(`Deleting unassigned pod: ${podName}`);
        await executeKubectl(`delete pod ${podName}`);
      }
      
      // 更新Deployment副本数
      const scaleCmd = `scale deployment ${deploymentName} --replicas=${targetReplicas}`;
      await executeKubectl(scaleCmd);
    } else {
      // unassigned Pod不够，需要删除assigned Pod
      const assignedToRemove = podsToRemove - unassignedPods.length;
      
      // 删除所有unassigned Pod
      for (const pod of unassignedPods) {
        const podName = pod.metadata.name;
        console.log(`Deleting unassigned pod: ${podName}`);
        await executeKubectl(`delete pod ${podName}`);
      }
      
      // 警告用户需要删除assigned Pod
      console.log(`Warning: Need to remove ${assignedToRemove} assigned pods`);
      
      // 删除assigned Pod (按创建时间排序，删除最新的)
      const sortedAssignedPods = assignedPods.sort((a, b) => 
        new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp)
      );
      
      for (let i = 0; i < assignedToRemove; i++) {
        const podName = sortedAssignedPods[i].metadata.name;
        const business = sortedAssignedPods[i].metadata.labels?.business;
        console.log(`Deleting assigned pod: ${podName} (business: ${business})`);
        await executeKubectl(`delete pod ${podName}`);
      }
      
      // 更新Deployment副本数
      const scaleCmd = `scale deployment ${deploymentName} --replicas=${targetReplicas}`;
      await executeKubectl(scaleCmd);
    }
  }
  // targetReplicas === currentReplicas 时不需要操作
}
*/

// 业务Service列表API
app.get('/api/binding-services', async (req, res) => {
  try {
    console.log('Fetching binding services...');

    // 获取所有Service
    const servicesOutput = await executeKubectl('get services -o json');
    const services = JSON.parse(servicesOutput);

    // 过滤绑定Service
    const businessServices = services.items
      .filter(service => service.metadata.labels?.['service-type'] === 'binding-service')
      .map(service => ({
        name: service.metadata.name,
        businessTag: service.metadata.labels.business,
        displayName: service.metadata.labels.business || service.metadata.name,
        modelId: service.metadata.labels['model-id']
      }));
    
    console.log('Business services found:', businessServices.length);
    res.json(businessServices);
    
  } catch (error) {
    console.error('Business services fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/api/deployments', async (req, res) => {
  try {
    console.log('Fetching deployments (including Routers)...');

    // 获取 default namespace 的 deployment
    const deploymentsOutput = await executeKubectl('get deployments -o json');
    const defaultDeployments = JSON.parse(deploymentsOutput);

    // 获取 hyperpod-inference-system namespace 的 deployment（只要 router）
    let hyperpodDeployments = [];
    try {
      const hyperpodDeploymentsOutput = await executeKubectl('get deployments -n hyperpod-inference-system -o json');
      const hyperpodDeploymentsData = JSON.parse(hyperpodDeploymentsOutput);
      hyperpodDeployments = (hyperpodDeploymentsData.items || []).filter(dep => 
        dep.metadata?.name?.endsWith('-default-router')
      );
      console.log(`Found ${hyperpodDeployments.length} hyperpod router deployments`);
    } catch (error) {
      console.log('No hyperpod router deployments found:', error.message);
    }

    // 合并两个 namespace 的 deployments
    const allDeploymentsItems = [...defaultDeployments.items, ...hyperpodDeployments];

    // 获取 default namespace 的 service
    const servicesOutput = await executeKubectl('get services -o json');
    const defaultServices = JSON.parse(servicesOutput);

    // 获取 hyperpod-inference-system namespace 的 routing service
    let hyperpodServices = [];
    try {
      const hyperpodServicesOutput = await executeKubectl('get services -n hyperpod-inference-system -o json');
      const hyperpodServicesData = JSON.parse(hyperpodServicesOutput);
      hyperpodServices = (hyperpodServicesData.items || []).filter(svc => 
        svc.metadata?.name?.endsWith('-default-routing-service')
      );
      console.log(`Found ${hyperpodServices.length} hyperpod routing services`);
    } catch (error) {
      console.log('No hyperpod routing services found:', error.message);
    }

    // 合并两个 namespace 的 services
    const allServices = [...defaultServices.items, ...hyperpodServices];

    // 获取所有 ScaledObject
    let scaledObjects = [];
    try {
      const scaledObjectsOutput = await executeKubectl('get scaledobjects.keda.sh --all-namespaces -o json');
      const scaledObjectsData = JSON.parse(scaledObjectsOutput);
      scaledObjects = scaledObjectsData.items || [];
      console.log(`Found ${scaledObjects.length} ScaledObjects`);
    } catch (error) {
      console.log('No ScaledObjects found or KEDA not installed:', error.message);
    }

    // 显示所有deployment，不进行过滤（包含Router和hyperpod router）
    const allDeployments = allDeploymentsItems;

    // 为每个部署匹配对应的service和ScaledObject
    const deploymentList = allDeployments.map(deployment => {
      const appLabel = deployment.metadata.labels?.app;
      const labels = deployment.metadata.labels || {};
      const deploymentName = deployment.metadata.name;
      const deploymentNamespace = deployment.metadata.namespace;

      // 检测部署类型：优先通过service-type标签识别Router
      const serviceType = labels['service-type'];
      const deploymentType = labels['deployment-type'] || labels['model-type'];
      const deployingService = labels['deploying-service'];

      let finalDeploymentType;
      if (serviceType === 'router') {
        finalDeploymentType = 'Router';
      } else if (deployingService === 'hyperpod-inference' || deploymentName.endsWith('-default-router')) {
        finalDeploymentType = 'InferenceOperator';
      } else if (deploymentType) {
        finalDeploymentType = deploymentType;
      } else {
        finalDeploymentType = 'Others';
      }

      // 匹配对应的service
      const matchingService = allServices.find(service => {
        // Router的service匹配逻辑：查找包含deployment名称的service
        if (finalDeploymentType === 'Router') {
          return service.metadata.name.includes(deploymentName) ||
                 service.spec.selector?.app === appLabel;
        }
        // 普通模型deployment的service匹配逻辑
        return service.spec.selector?.app === appLabel;
      });

      // 匹配对应的 ScaledObject
      const matchingScaledObject = scaledObjects.find(so => {
        const targetName = so.spec?.scaleTargetRef?.name;
        const targetNamespace = so.metadata?.namespace;
        return targetName === deploymentName && targetNamespace === deploymentNamespace;
      });

      // 使用deployment名称作为modelTag
      const modelTag = deploymentName;

      // 检查是否为external访问
      const isExternal = matchingService?.metadata?.annotations?.['service.beta.kubernetes.io/aws-load-balancer-scheme'] === 'internet-facing';

      // 提取container port信息
      const containers = deployment.spec.template.spec.containers || [];
      const containerPorts = [];

      containers.forEach(container => {
        if (container.ports && container.ports.length > 0) {
          container.ports.forEach(port => {
            containerPorts.push({
              containerPort: port.containerPort,
              protocol: port.protocol || 'TCP',
              name: port.name || 'http'
            });
          });
        }
      });

      return {
        modelTag,
        deploymentType: finalDeploymentType,  // Router | VLLM | Others 等
        deploymentName: deployment.metadata.name,
        serviceName: matchingService?.metadata.name || 'N/A',
        replicas: deployment.spec.replicas,
        readyReplicas: deployment.status.readyReplicas || 0,
        status: deployment.status.readyReplicas === deployment.spec.replicas ? 'Ready' : 'Pending',
        createdAt: deployment.metadata.creationTimestamp,
        hasService: !!matchingService,
        serviceType: matchingService?.spec.type || 'N/A',
        isExternal: isExternal,
        externalIP: matchingService?.status?.loadBalancer?.ingress?.[0]?.hostname ||
                   matchingService?.status?.loadBalancer?.ingress?.[0]?.ip || 'Pending',
        port: matchingService?.spec?.ports?.[0]?.port || '8000',  // Service端口
        containerPorts: containerPorts,  // 新增：container端口信息
        labels: labels,  // 添加标签信息供前端使用
        // Router专用字段
        isRouter: finalDeploymentType === 'Router',
        // ScaledObject 信息
        scaledObject: matchingScaledObject ? {
          name: matchingScaledObject.metadata.name,
          namespace: matchingScaledObject.metadata.namespace,
          minReplicas: matchingScaledObject.spec.minReplicaCount,
          maxReplicas: matchingScaledObject.spec.maxReplicaCount,
          ready: matchingScaledObject.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True',
          active: matchingScaledObject.status?.conditions?.find(c => c.type === 'Active')?.status === 'True'
        } : null
      };
    });
    
    console.log('Deployments fetched:', deploymentList.length, 'deployments (including Routers)');
    res.json(deploymentList);
    
  } catch (error) {
    console.error('Deployments fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 测试模型API（生成cURL命令）
app.post('/api/test-model', async (req, res) => {
  const { serviceUrl, payload } = req.body;
  
  try {
    let parsedPayload;
    
    try {
      parsedPayload = JSON.parse(payload);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    
    const curlCommand = `curl -X POST "${serviceUrl}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(parsedPayload, null, 2)}'`;
    
    res.json({
      curlCommand,
      fullUrl: serviceUrl,
      message: 'Use the curl command to test your model'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket连接处理 - 优化版本，减少日志污染
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  // 发送状态更新的函数
  const sendStatusUpdate = async () => {
    try {
      const [pods, services] = await Promise.all([
        executeKubectl('get pods -o json').then(output => JSON.parse(output).items),
        executeKubectl('get services -o json').then(output => JSON.parse(output).items)
      ]);
      
      const statusData = {
        type: 'status_update',
        pods,
        services,
        timestamp: new Date().toISOString()
      };
      
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(statusData));
        console.log(`📡 Status update sent: ${pods.length} pods, ${services.length} services`);
      }
    } catch (error) {
      console.error('❌ Error fetching status for WebSocket:', error);
    }
  };
  
  // 🚀 优化：只在连接时发送一次初始状态，不再定时发送
  sendStatusUpdate();
  
  // 存储WebSocket连接，用于按需广播
  ws.isAlive = true;
  ws.lastActivity = Date.now();
  
  // 处理WebSocket消息
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      ws.lastActivity = Date.now();
      
      // 🎯 按需处理不同类型的消息
      switch (data.type) {
        case 'request_status_update':
          // 客户端主动请求状态更新
          console.log('📡 Client requested status update');
          sendStatusUpdate();
          break;
          
        case 'start_log_stream':
          console.log(`🔄 Starting log stream for ${data.jobName}/${data.podName}`);
          startLogStream(ws, data.jobName, data.podName);
          break;
          
        case 'stop_log_stream':
          console.log(`⏹️ Stopping log stream for ${data.jobName}/${data.podName}`);
          stopLogStream(ws, data.jobName, data.podName);
          break;
          
        case 'stop_all_log_streams':
          console.log('⏹️ Stopping all log streams');
          stopAllLogStreams(ws);
          break;
          
        case 'ping':
          // 心跳检测
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          }
          break;
          
        default:
          console.log('📨 Received WebSocket message:', data.type);
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });
  
  // 心跳检测
  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastActivity = Date.now();
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
    // 清理该连接的所有日志流
    stopAllLogStreams(ws);
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    // 清理该连接的所有日志流
    stopAllLogStreams(ws);
  });
});

// 🚀 广播函数 - 向所有连接的客户端发送消息
function broadcast(message) {
  const messageStr = JSON.stringify({
    ...message,
    timestamp: new Date().toISOString()
  });
  
  let sentCount = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
      sentCount++;
    }
  });
  
  if (sentCount > 0) {
    console.log(`📡 Broadcast sent to ${sentCount} clients:`, message.type);
  }
}

// 🔄 按需状态更新广播
function broadcastStatusUpdate() {
  const message = {
    type: 'request_status_update_broadcast',
    source: 'server'
  };
  broadcast(message);
}

// 🔄 定时检查创建中的集群状态 - 每60秒检查一次
const clusterStatusCheckInterval = setInterval(async () => {
  try {
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    
    if (!fs.existsSync(creatingClustersPath)) return;
    
    const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.type === 'eks' && clusterInfo.stackName && clusterInfo.currentStackStatus !== 'COMPLETED') {
        try {
          const stackStatus = await CloudFormationManager.getStackStatus(clusterInfo.stackName, clusterInfo.region);
          
          if (stackStatus.stackStatus === 'CREATE_COMPLETE') {
            console.log(`[Auto-Check] EKS cluster ${clusterTag} creation completed, registering...`);
            await registerCompletedCluster(clusterTag, 'active');
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
            
            broadcast({
              type: 'cluster_creation_completed',
              status: 'success',
              message: `EKS cluster ${clusterTag} created successfully. Configure dependencies in Cluster Information.`,
              clusterTag: clusterTag
            });
          }
        } catch (error) {
          console.error(`[Auto-Check] Error checking cluster ${clusterTag}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('[Auto-Check] Error in cluster status check:', error);
  }
}, 60000);

// 🔄 定时检查创建中的HyperPod集群状态 - 每60秒检查一次
const hyperPodStatusCheckInterval = setInterval(async () => {
  try {
    const { execSync } = require('child_process');
    const creatingClusters = hyperpodApiManager.getCreatingHyperPodClusters();
    
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.stackName && clusterInfo.region) {
        try {
          // 检查是否已经在配置依赖
          if (clusterInfo.phase === 'CONFIGURING_DEPENDENCIES') {
            console.log(`[Auto-Check] ${clusterTag} is already configuring dependencies, skipping...`);
            continue;
          }
          
          const checkCmd = `aws cloudformation describe-stacks --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region} --query 'Stacks[0].StackStatus' --output text`;
          const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();
          
          if (stackStatus === 'CREATE_COMPLETE') {
            console.log(`[Auto-Check] HyperPod cluster ${clusterTag} creation completed, starting dependency configuration...`);

            // 立即更新状态为"配置中"，防止重复触发
            hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, {
              ...clusterInfo,
              phase: 'CONFIGURING_DEPENDENCIES',
              dependencyConfigStartedAt: new Date().toISOString()
            });

            // 执行依赖配置
            try {
              await hyperpodApiManager.registerCompletedHyperPod(clusterTag);

              // 配置成功，删除记录
              hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
              
              broadcast({
                type: 'hyperpod_creation_completed',
                status: 'success',
                message: `HyperPod cluster created successfully: ${clusterInfo.stackName}`,
                clusterTag: clusterTag
              });
            } catch (error) {
              console.error(`[Auto-Check] Failed to configure dependencies for ${clusterTag}:`, error);

              // 配置失败，更新状态（保留记录，允许重试）
              hyperpodApiManager.updateCreatingHyperPodStatus(clusterTag, {
                ...clusterInfo,
                phase: 'DEPENDENCY_CONFIG_FAILED',
                error: error.message,
                lastAttempt: new Date().toISOString()
              });
              
              broadcast({
                type: 'hyperpod_creation_failed',
                status: 'error',
                message: `Failed to configure HyperPod dependencies: ${error.message}`,
                clusterTag: clusterTag
              });
            }
          }
        } catch (error) {
          console.error(`[Auto-Check] Error checking HyperPod ${clusterTag}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('[Auto-Check] Error in HyperPod status check:', error);
  }
}, 60000);

// ❤️ WebSocket心跳检测 - 每30秒检查一次连接状态
const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  let activeConnections = 0;
  
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      // 检查连接是否活跃（5分钟内有活动）
      if (now - ws.lastActivity < 300000) {
        ws.ping();
        activeConnections++;
      } else {
        console.log('🔌 Terminating inactive WebSocket connection');
        ws.terminate();
      }
    }
  });
  
  // 只在有连接时输出心跳日志
  if (activeConnections > 0) {
    console.log(`❤️ WebSocket heartbeat: ${activeConnections} active connections`);
  }
}, 30000);

// 🧹 进程清理函数 - 优化版本
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM signal - Server shutting down gracefully...');
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT signal (Ctrl+C) - Server shutting down gracefully...');
  gracefulShutdown('SIGINT');
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// 优雅关闭函数
function gracefulShutdown(signal) {
  console.log(`🔄 Starting graceful shutdown (signal: ${signal})...`);
  
  // 清理WebSocket心跳检测
  if (typeof heartbeatInterval !== 'undefined') {
    clearInterval(heartbeatInterval);
    console.log('✅ WebSocket heartbeat interval cleared');
  }
  
  // 关闭WebSocket服务器
  if (wss) {
    console.log(`📡 Closing WebSocket server (${wss.clients.size} active connections)...`);
    wss.close(() => {
      console.log('✅ WebSocket server closed');
    });
  }
  
  // 清理活跃的日志流 (使用 unifiedLogStreams)
  if (unifiedLogStreams && unifiedLogStreams.size > 0) {
    console.log(`🧹 Cleaning up ${unifiedLogStreams.size} active log streams...`);
    // 终止所有日志流进程
    unifiedLogStreams.forEach((stream, key) => {
      if (stream.process) {
        stream.process.kill('SIGTERM');
      }
      if (stream.logStream) {
        stream.logStream.end();
      }
    });
    unifiedLogStreams.clear();
    console.log('✅ Log streams cleaned up');
  }
  
  console.log('✅ Graceful shutdown completed');
  
  // 给一些时间让清理完成，然后退出
  setTimeout(() => {
    process.exit(signal === 'uncaughtException' || signal === 'unhandledRejection' ? 1 : 0);
  }, 1000);
}

// 停止某个WebSocket连接的所有日志流
function stopAllLogStreams(ws) {
  const streamsToStop = [];
  
  // 从统一日志流中移除该WebSocket连接
  unifiedLogStreams.forEach((stream, streamKey) => {
    if (stream.webSockets.has(ws)) {
      const [jobName, podName] = streamKey.split('-');
      streamsToStop.push({ jobName, podName });
    }
  });
  
  // 移除WebSocket连接
  streamsToStop.forEach(({ jobName, podName }) => {
    removeWebSocketFromLogStream(ws, jobName, podName);
  });
  
  if (streamsToStop.length > 0) {
    console.log(`🧹 Cleaned up ${streamsToStop.length} log streams for disconnected WebSocket`);
  }
}

const S3StorageManager = require('./s3-storage-manager');
const s3StorageManager = new S3StorageManager();

// S3存储管理API
app.get('/api/s3-storages', async (req, res) => {
  const result = await s3StorageManager.getStorages();
  res.json(result);
});

// 获取S3存储默认值
app.get('/api/s3-storage-defaults', (req, res) => {
  const result = s3StorageManager.getStorageDefaults();
  res.json(result);
});

app.post('/api/s3-storages', async (req, res) => {
  const result = await s3StorageManager.createStorage(req.body);
  if (result.success) {
    broadcast({
      type: 's3_storage_created',
      status: 'success',
      message: `S3 storage ${req.body.name} created successfully`
    });
  }
  res.json(result);
});

app.delete('/api/s3-storages/:name', async (req, res) => {
  const result = await s3StorageManager.deleteStorage(req.params.name);
  if (result.success) {
    broadcast({
      type: 's3_storage_deleted',
      status: 'success',
      message: `S3 storage ${req.params.name} deleted successfully`
    });
  }
  res.json(result);
});

// 增强的模型下载API
app.post('/api/download-model-enhanced', async (req, res) => {
  const { modelId } = req.body;

  if (!modelId) {
    return res.json({ success: false, error: 'Model ID is required' });
  }

  const result = await s3StorageManager.applyEnhancedDownloadJob(req.body);

  // 广播结果
  broadcast({
    type: 'model_download',
    status: result.success ? 'success' : 'error',
    message: result.success
      ? `Enhanced model download started: ${modelId}`
      : `Failed to start enhanced model download: ${result.error}`,
    jobName: result.jobName
  });

  res.json(result);
});

// S3存储信息API - 从s3-pv PersistentVolume获取桶信息
app.get('/api/s3-storage', async (req, res) => {
  const { storage } = req.query;
  const result = await s3StorageManager.listStorageContent(storage);
  res.json(result);
});

// 获取集群可用实例类型 API
app.get('/api/cluster/cluster-available-instance', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const AWSHelpers = require('./utils/awsHelpers');

    console.log('Fetching cluster available instance types...');

    // 初始化结果数据结构
    const result = {
      success: true,
      data: {
        hyperpod: [],
        eksNodeGroup: [],
        karpenter: [],
        karpenterHyperPod: []  // 新增：Karpenter HyperPod 实例类型
      }
    };

    // 获取当前区域
    const region = AWSHelpers.getCurrentRegion();

    // 1. 获取 HyperPod 实例类型
    try {
      const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf8', timeout: 10000 });
      const nodesData = JSON.parse(nodesJson);

      // 过滤HyperPod节点并统计实例类型
      const hyperPodNodes = nodesData.items.filter(node =>
        node.metadata.labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod'
      );

      const hyperPodTypeMap = new Map();
      hyperPodNodes.forEach(node => {
        const instanceType = node.metadata.labels['node.kubernetes.io/instance-type'];
        const instanceGroup = node.metadata.labels['sagemaker.amazonaws.com/instance-group-name'];

        if (instanceType && instanceType.startsWith('ml.')) {
          const key = `${instanceType}-${instanceGroup}`;
          if (!hyperPodTypeMap.has(key)) {
            hyperPodTypeMap.set(key, {
              type: instanceType,
              group: instanceGroup,
              count: 0
            });
          }
          hyperPodTypeMap.get(key).count++;
        }
      });

      result.data.hyperpod = Array.from(hyperPodTypeMap.values());
      console.log(`Found ${result.data.hyperpod.length} HyperPod instance types`);
    } catch (error) {
      console.warn('Error fetching HyperPod instance types:', error.message);
    }

    // 2. 获取 EKS NodeGroup 实例类型
    try {
      const nodesJson = execSync('kubectl get nodes -o json', { encoding: 'utf8', timeout: 10000 });
      const nodesData = JSON.parse(nodesJson);

      // 过滤EKS NodeGroup节点
      const eksNodes = nodesData.items.filter(node =>
        node.metadata.labels['alpha.eksctl.io/nodegroup-name'] &&
        !node.metadata.labels['sagemaker.amazonaws.com/compute-type']
      );

      const eksTypeMap = new Map();
      eksNodes.forEach(node => {
        const instanceType = node.metadata.labels['node.kubernetes.io/instance-type'];
        const nodeGroup = node.metadata.labels['alpha.eksctl.io/nodegroup-name'];

        if (instanceType && !instanceType.startsWith('ml.')) {
          const key = `${instanceType}-${nodeGroup}`;
          if (!eksTypeMap.has(key)) {
            eksTypeMap.set(key, {
              type: instanceType,
              nodeGroup: nodeGroup,
              count: 0
            });
          }
          eksTypeMap.get(key).count++;
        }
      });

      result.data.eksNodeGroup = Array.from(eksTypeMap.values());
      console.log(`Found ${result.data.eksNodeGroup.length} EKS NodeGroup instance types`);
    } catch (error) {
      console.warn('Error fetching EKS NodeGroup instance types:', error.message);
    }

    // 3. 获取 Karpenter NodePool 实例类型（分离 EC2 和 HyperPod）
    try {
      const nodePoolsJson = execSync('kubectl get nodepool -o json', { encoding: 'utf8', timeout: 10000 });
      const nodePoolsData = JSON.parse(nodePoolsJson);

      nodePoolsData.items.forEach(nodePool => {
        const nodePoolName = nodePool.metadata.name;
        const nodeClassRef = nodePool.spec?.template?.spec?.nodeClassRef;
        
        // 检查是否是 HyperpodNodeClass
        if (nodeClassRef?.kind === 'HyperpodNodeClass') {
          // 从 HyperpodNodeClass 获取实例类型
          try {
            const nodeClassName = nodeClassRef.name;
            const nodeClassJson = execSync(`kubectl get hyperpodnodeclass ${nodeClassName} -o json`, { encoding: 'utf8', timeout: 5000 });
            const nodeClassData = JSON.parse(nodeClassJson);
            
            // 从 status.instanceGroups 获取实例类型
            const statusInstanceGroups = nodeClassData.status?.instanceGroups || [];
            statusInstanceGroups.forEach(ig => {
              const instanceTypes = ig.instanceTypes || [];
              instanceTypes.forEach(instanceType => {
                result.data.karpenterHyperPod.push({
                  type: instanceType,
                  nodePool: nodePoolName,
                  available: true
                });
              });
            });
          } catch (ncError) {
            console.warn(`Failed to get HyperpodNodeClass for NodePool ${nodePoolName}:`, ncError.message);
          }
        } else {
          // EC2 Karpenter - 从 requirements 获取实例类型
          const requirements = nodePool.spec.template.spec.requirements || [];
          const instanceTypeReq = requirements.find(req =>
            req.key === 'node.kubernetes.io/instance-type'
          );

          if (instanceTypeReq && instanceTypeReq.values) {
            instanceTypeReq.values.forEach(instanceType => {
              result.data.karpenter.push({
                type: instanceType,
                nodePool: nodePoolName,
                available: true
              });
            });
          }
        }
      });

      console.log(`Found ${result.data.karpenter.length} Karpenter EC2 instance types`);
      console.log(`Found ${result.data.karpenterHyperPod.length} Karpenter HyperPod instance types`);
    } catch (error) {
      console.warn('Error fetching Karpenter instance types:', error.message);
    }

    // 只打印摘要，不打印完整 JSON
    console.log('Cluster available instance types fetched:', {
      hyperpod: result.data?.hyperpod?.length || 0,
      eksNodeGroup: result.data?.eksNodeGroup?.length || 0,
      karpenter: result.data?.karpenter?.length || 0,
      karpenterHyperPod: result.data?.karpenterHyperPod?.length || 0
    });
    res.json(result);

  } catch (error) {
    console.error('Error fetching cluster available instance types:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 集群创建日志 API 已由 multiClusterAPIs 模块处理（见下方 /api/cluster/logs/:step 和 /api/cluster/logs-history）
// ==================== 多集群管理 API ====================
// 引入多集群管理模块
const MultiClusterAPIs = require('./multi-cluster-apis');
const MultiClusterStatus = require('./multi-cluster-status');

const multiClusterAPIs = new MultiClusterAPIs();
const multiClusterStatus = new MultiClusterStatus();

// 多集群管理API
app.get('/api/multi-cluster/list', (req, res) => multiClusterAPIs.handleGetClusters(req, res));
app.post('/api/multi-cluster/switch', (req, res) => multiClusterAPIs.handleSwitchCluster(req, res));
app.post('/api/multi-cluster/switch-kubectl', (req, res) => multiClusterAPIs.handleSwitchKubectlConfig(req, res));

// 集群导入API
app.post('/api/cluster/import', (req, res) => multiClusterAPIs.handleImportCluster(req, res));
app.post('/api/cluster/test-connection', (req, res) => multiClusterAPIs.handleTestConnection(req, res));
app.post('/api/cluster/:clusterTag/redetect-state', (req, res) => multiClusterAPIs.handleRedetectClusterState(req, res));

// 重写现有的集群API以支持多集群
app.post('/api/cluster/save-config', (req, res) => multiClusterAPIs.handleSaveConfig(req, res));
app.post('/api/cluster/launch', (req, res) => multiClusterAPIs.handleLaunch(req, res));
app.post('/api/cluster/configure', (req, res) => multiClusterAPIs.handleConfigure(req, res));
app.get('/api/cluster/logs/:step', (req, res) => multiClusterAPIs.handleGetLogs(req, res));
app.get('/api/cluster/logs-history', (req, res) => multiClusterAPIs.handleGetLogsHistory(req, res));
app.post('/api/cluster/clear-status-cache', (req, res) => multiClusterAPIs.handleClearStatusCache(req, res));

// 重写状态检查API以支持多集群
app.get('/api/cluster/step1-status', (req, res) => multiClusterStatus.handleStep1Status(req, res));
app.get('/api/cluster/step2-status', (req, res) => multiClusterStatus.handleStep2Status(req, res));
app.get('/api/cluster/cloudformation-status', (req, res) => multiClusterStatus.handleCloudFormationStatus(req, res));

// 节点组管理 API 已迁移至 nodeGroupApiManager.js

// HyperPod 实例管理 API 已迁移至 hyperpodApiManager.js

console.log('Multi-cluster management APIs loaded');

// 引入集群管理工具
const CloudFormationManager = require('./utils/cloudFormationManager');
const ClusterDependencyManager = require('./utils/clusterDependencyManager');
const ClusterManager = require('./cluster-manager');
const clusterManager = new ClusterManager();

// 初始化 HyperPod API 管理模块
hyperpodApiManager.initialize(broadcast, clusterManager);

// 注册 HyperPod API 路由
// 路由前缀: /api/cluster (与原有路径保持一致)
app.use('/api/cluster', hyperpodApiManager.router);

console.log('HyperPod API Manager loaded');

// 初始化 NodeGroup API 管理模块
nodeGroupApiManager.initialize(broadcast, clusterManager);

// 注册 NodeGroup API 路由
// 路由前缀: /api/cluster (与原有路径保持一致)
app.use('/api/cluster', nodeGroupApiManager.router);

console.log('NodeGroup API Manager loaded');

// 注册日志流管理路由
// 路由前缀: /api/logs
app.use('/api/logs', logStreamManager.router);

console.log('Log Stream Manager loaded');

// 初始化 MLflow API 管理模块
mlflowApiManager.initialize({ broadcast });

// 注册 MLflow API 路由
// 路由前缀: /api (保持原有路径)
app.use('/api', mlflowApiManager.router);

console.log('MLflow API Manager loaded');

// 初始化 EKS Creation 管理模块
eksCreationManager.initialize({
  broadcast,
  clusterManager,
  CloudFormationManager,
  ClusterDependencyManager,
  NetworkManager
});

// 注册 EKS Creation API 路由
// 路由前缀: /api/cluster (与原有路径保持一致)
app.use('/api/cluster', eksCreationManager.router);

console.log('EKS Creation Manager loaded');

// 初始化 Training Job 管理模块
trainingJobManager.initialize({
  broadcast,
  executeKubectl
});

// 注册 Training Job API 路由
// 路由前缀: /api (保持原有路径)
app.use('/api', trainingJobManager.router);

console.log('Training Job Manager loaded');

// CIDR生成相关API
app.get('/api/cluster/generate-cidr', async (req, res) => {
  const { region, excludeCidr } = req.query;
  const result = await NetworkManager.generateUniqueCidr(region, excludeCidr);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'AWS region is required' ? 400 : 500).json({ error: result.error });
  }
});

// 生成完整CIDR配置
app.post('/api/cluster/generate-cidr-config', async (req, res) => {
  const { region, customVpcCidr } = req.body;
  const result = await NetworkManager.generateCidrConfig(region, customVpcCidr);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'AWS region is required' ? 400 : 500).json({ error: result.error });
  }
});

// 验证CIDR格式和冲突
app.post('/api/cluster/validate-cidr', async (req, res) => {
  const { cidr, region } = req.body;
  const result = await NetworkManager.validateCidr(cidr, region);

  if (result.error === 'CIDR and region are required') {
    res.status(400).json({ error: result.error });
  } else if (result.success || result.valid === false) {
    // Both success=true and format validation failure (valid=false) return normally
    res.json(result);
  } else {
    res.status(500).json({ error: result.error });
  }
});

console.log('CIDR generation APIs loaded');

// 获取集群信息API
app.get('/api/cluster/info', async (req, res) => {
  try {
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);
    
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    const initEnvsPath = path.join(__dirname, '../managed_clusters_info', activeCluster, 'config/init_envs');
    const stackEnvsPath = path.join(__dirname, '../managed_clusters_info', activeCluster, 'config/stack_envs');
    
    const getEnvVar = async (varName, filePath = initEnvsPath) => {
      try {
        const cmd = `source ${filePath} && echo $${varName}`;
        const result = await execAsync(cmd, { shell: '/bin/bash' });
        return result.stdout.trim();
      } catch (error) {
        return null;
      }
    };
    
    const eksClusterName = await getEnvVar('EKS_CLUSTER_NAME');
    const region = await getEnvVar('AWS_REGION');
    
    // 优先从metadata获取VPC ID（适用于创建的集群）
    const MetadataUtils = require('./utils/metadataUtils');
    let vpcId = null;
    
    if (MetadataUtils.isCreatedCluster(activeCluster)) {
      const eksInfo = MetadataUtils.getEKSClusterInfo(activeCluster);
      vpcId = eksInfo.vpcId;
      console.log(`Retrieved VPC ID from metadata for created cluster ${activeCluster}: ${vpcId}`);
    }
    
    // 如果metadata中没有，尝试从stack_envs获取
    if (!vpcId) {
      vpcId = await getEnvVar('VPC_ID', stackEnvsPath);
    }
    
    // 如果仍然获取不到（导入的集群），通过AWS API获取
    if (!vpcId && eksClusterName && region) {
      try {
        const cmd = `aws eks describe-cluster --name ${eksClusterName} --region ${region} --query 'cluster.resourcesVpcConfig.vpcId' --output text`;
        const result = await execAsync(cmd);
        vpcId = result.stdout.trim();
        console.log(`Retrieved VPC ID via AWS API for cluster ${eksClusterName}: ${vpcId}`);
      } catch (error) {
        console.warn(`Failed to get VPC ID for cluster ${eksClusterName}:`, error.message);
        vpcId = null;
      }
    }
    
    res.json({
      success: true,
      activeCluster,
      eksClusterName,
      region,
      vpcId
    });
  } catch (error) {
    console.error('Error getting cluster info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取S3存储桶列表（用于模型存储）
app.get('/api/cluster/s3-buckets', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.json({
        success: true,
        buckets: [],
        clusterBucket: null
      });
    }

    let clusterBucket = null;

    // 使用 s3StorageManager 获取模型存储的 S3 bucket（从 S3 CSI PV/PVC 中检测）
    try {
      const storageResult = await s3StorageManager.getStorages();

      if (storageResult.success && storageResult.storages.length > 0) {
        // 优先选择名为 's3-claim' 的存储（通常是主要的模型存储）
        let selectedStorage = storageResult.storages.find(s => s.pvcName === 's3-claim');

        // 如果没有 s3-claim，使用第一个存储
        if (!selectedStorage) {
          selectedStorage = storageResult.storages[0];
        }

        clusterBucket = {
          name: selectedStorage.bucketName,
          region: selectedStorage.region || 'us-west-2'
        };
        console.log(`Got S3 model storage bucket from s3StorageManager: ${selectedStorage.bucketName} (PVC: ${selectedStorage.pvcName})`);
      }
    } catch (error) {
      console.warn('Failed to get S3 bucket from s3StorageManager:', error.message);
    }

    const buckets = clusterBucket ? [clusterBucket] : [];

    res.json({
      success: true,
      buckets: buckets,
      clusterBucket: clusterBucket
    });
  } catch (error) {
    console.error('Error getting S3 buckets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取当前AWS配置的region
app.get('/api/aws/current-region', async (req, res) => {
  try {
    const region = await getCurrentRegion();
    res.json({
      success: true,
      region
    });
  } catch (error) {
    console.error('Failed to get current AWS region:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      region: 'us-west-1' // 提供默认值
    });
  }
});

// 获取可用区列表API
app.get('/api/cluster/availability-zones', async (req, res) => {
  const { region } = req.query;
  const result = await NetworkManager.getAvailabilityZones(region);

  if (result.success) {
    res.json(result);
  } else {
    res.status(result.error === 'Region parameter required' ? 400 : 500)
      .json({ success: false, error: result.error });
  }
});

// HyperPod 集群创建/删除 API 已迁移至 hyperpodApiManager.js

// 获取EKS节点组创建所需的子网信息
app.get('/api/cluster/subnets', async (req, res) => {
  try {
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);
    
    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    // 从metadata获取集群信息
    const MetadataUtils = require('./utils/metadataUtils');
    const clusterInfo = MetadataUtils.getClusterInfo(activeCluster);
    
    if (!clusterInfo) {
      return res.status(400).json({ success: false, error: 'Cluster metadata not found' });
    }
    
    // 从metadata获取基本信息
    const eksClusterName = clusterInfo.eksCluster.name;
    const region = clusterInfo.region;
    const vpcId = clusterInfo.eksCluster.vpcId;
    const securityGroupId = clusterInfo.eksCluster.securityGroupId;
    
    if (!vpcId) {
      return res.status(400).json({ success: false, error: 'VPC ID not found in metadata' });
    }
    
    // 获取子网信息（仍需要动态获取，因为子网信息不在metadata中）
    const subnetInfo = await CloudFormationManager.fetchSubnetInfo(vpcId, region);
    
    // 获取HyperPod使用的子网和Security Group
    let hyperPodSubnets = [];
    let hyperPodSecurityGroup = null;
    try {
      // 从metadata获取实际的HyperPod集群名称
      if (clusterInfo.hyperPodCluster && clusterInfo.hyperPodCluster.ClusterName) {
        const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
        
        // 使用兼容的查询命令获取计算节点子网
        const hpCmd = `aws sagemaker describe-cluster --cluster-name ${hpClusterName} --region ${region} --query 'InstanceGroups[0].OverrideVpcConfig.Subnets[] || VpcConfig.Subnets[]' --output text`;
        const hpResult = await execAsync(hpCmd);
        const subnetText = hpResult.stdout.trim();
        if (subnetText) {
          hyperPodSubnets = subnetText.split(/\s+/).filter(s => s.length > 0);
        }
        console.log('Found HyperPod compute subnets:', hyperPodSubnets);
        
        // 获取HyperPod Security Groups
        const hyperPodSecurityGroups = await CloudFormationManager.getHyperPodSecurityGroups(eksClusterName, region);
        if (hyperPodSecurityGroups.length > 0) {
          hyperPodSecurityGroup = hyperPodSecurityGroups[0];
        }
      } else {
        console.log('No HyperPod cluster found in metadata');
      }
    } catch (error) {
      console.log('Error fetching HyperPod compute subnet info:', error.message);
    }
    
    // 标记HyperPod使用的子网
    const markedSubnets = {
      publicSubnets: subnetInfo.publicSubnets,
      privateSubnets: subnetInfo.privateSubnets.map(subnet => ({
        ...subnet,
        isHyperPodSubnet: hyperPodSubnets.includes(subnet.subnetId)
      })),
      hyperPodSubnets: hyperPodSubnets
    };
    
    res.json({
      success: true,
      data: {
        eksClusterName,
        region,
        vpcId,
        securityGroupId,
        hyperPodSecurityGroup,
        ...markedSubnets
      }
    });
    
  } catch (error) {
    console.error('Error fetching subnets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// EKS 节点组删除/创建/依赖状态 API 已迁移至 nodeGroupApiManager.js

// HyperPod 状态检查 API 已迁移至 hyperpodApiManager.js

// 🎨 AWS Instance Types API for Advanced Scaling (Cache-based, no fallbacks)
app.get('/api/aws/instance-types', async (req, res) => {
  try {
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();

    const result = AWSInstanceTypeManager.getCachedInstanceTypes(activeClusterName);

    if (result.success) {
      return res.json({ success: true, ...result.data });
    } else {
      const statusCode = result.needsRefresh ? 200 : 500;
      return res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('Error accessing instance types cache:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🎨 AWS Instance Types Refresh API (Manual cache update)
app.post('/api/aws/instance-types/refresh', async (req, res) => {
  try {
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    const { families } = req.body;
    const result = await AWSInstanceTypeManager.refreshInstanceTypes(activeClusterName, families);

    if (result.success) {
      res.json({ success: true, ...result.data });
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Error refreshing instance types:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🎨 Subnet-aware Instance Types API (基于子网的实例类型获取)
app.post('/api/aws/instance-types/by-subnet', async (req, res) => {
  try {
    const { subnetId } = req.body;

    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    const result = await AWSInstanceTypeManager.getInstanceTypesBySubnet(activeClusterName, subnetId);

    if (result.success) {
      res.json({ success: true, ...result.data });
    } else {
      const statusCode = result.error?.includes('not found') ? 404 : 400;
      res.status(statusCode).json(result);
    }
  } catch (error) {
    console.error('Error fetching instance types by subnet:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

console.log('AWS Instance Types API loaded');

// ==========================================
// Karpenter Management APIs
// ==========================================

const KarpenterManager = require('./utils/karpenterManager');
const HyperPodKarpenterManager = require('./utils/hyperpodKarpenterManager');
const HyperPodKarpenterInstaller = require('./utils/hyperpodKarpenterInstaller');

// 安装 Karpenter
app.post('/api/cluster/karpenter/install', async (req, res) => {
  try {
    const { clusterTag } = req.body;
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();

    // 如果没有提供clusterTag，使用活跃集群
    const targetCluster = clusterTag || clusterManager.getActiveCluster();

    if (!targetCluster) {
      return res.status(400).json({
        success: false,
        error: 'No cluster specified and no active cluster found'
      });
    }

    console.log(`Installing Karpenter for cluster: ${targetCluster}`);

    // 异步安装Karpenter，避免请求超时
    setTimeout(async () => {
      try {
        await KarpenterManager.installKarpenterDependencies(targetCluster, clusterManager);

        // 广播安装完成消息
        broadcast({
          type: 'karpenter_installation_completed',
          clusterTag: targetCluster,
          message: 'Karpenter installation completed successfully',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Karpenter installation failed:', error);

        // 广播安装失败消息
        broadcast({
          type: 'karpenter_installation_failed',
          clusterTag: targetCluster,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }, 1000);

    // 立即返回开始安装的响应
    res.json({
      success: true,
      message: 'Karpenter installation started',
      clusterTag: targetCluster,
      status: 'installing'
    });

  } catch (error) {
    console.error('Error starting Karpenter installation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 检查 Karpenter 状态
app.get('/api/cluster/karpenter/status', async (req, res) => {
  try {
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();

    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster found'
      });
    }

    // 从metadata中获取安装状态
    const metadataDir = clusterManager.getClusterMetadataDir(activeCluster);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    let karpenterInfo = null;
    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      karpenterInfo = clusterInfo.karpenter;
    }

    // 如果metadata中显示已安装，验证实际状态
    if (karpenterInfo?.installed) {
      try {
        // 获取集群基本信息用于状态检查
        const configDir = clusterManager.getClusterConfigDir(activeCluster);
        const initEnvsPath = path.join(configDir, 'init_envs');

        if (fs.existsSync(initEnvsPath)) {
          const envContent = fs.readFileSync(initEnvsPath, 'utf8');
          const eksClusterMatch = envContent.match(/export EKS_CLUSTER_NAME=(.+)/);
          const regionMatch = envContent.match(/export AWS_REGION=(.+)/);

          const eksClusterName = eksClusterMatch ? eksClusterMatch[1] : null;
          const region = regionMatch ? regionMatch[1] : 'us-west-2';

          if (eksClusterName) {
            const runtimeStatus = await KarpenterManager.checkKarpenterStatus(eksClusterName, region);

            res.json({
              success: true,
              installed: karpenterInfo.installed,
              version: karpenterInfo.version,
              installationDate: karpenterInfo.installationDate,
              components: karpenterInfo.components,
              runtimeStatus: runtimeStatus,
              clusterTag: activeCluster
            });
            return;
          }
        }
      } catch (error) {
        console.warn('Failed to get runtime status:', error.message);
      }
    }

    // 返回metadata状态或未安装状态
    res.json({
      success: true,
      installed: karpenterInfo?.installed || false,
      version: karpenterInfo?.version || null,
      installationDate: karpenterInfo?.installationDate || null,
      components: karpenterInfo?.components || null,
      clusterTag: activeCluster
    });

  } catch (error) {
    console.error('Error checking Karpenter status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 Karpenter 节点
app.get('/api/cluster/karpenter/nodes', async (req, res) => {
  try {
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();

    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster found'
      });
    }

    // 获取集群基本信息
    const configDir = clusterManager.getClusterConfigDir(activeCluster);
    const initEnvsPath = path.join(configDir, 'init_envs');

    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({
        success: false,
        error: 'Cluster configuration not found'
      });
    }

    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const eksClusterMatch = envContent.match(/export EKS_CLUSTER_NAME=(.+)/);
    const regionMatch = envContent.match(/export AWS_REGION=(.+)/);

    const eksClusterName = eksClusterMatch ? eksClusterMatch[1] : null;
    const region = regionMatch ? regionMatch[1] : 'us-west-2';

    if (!eksClusterName) {
      return res.status(400).json({
        success: false,
        error: 'EKS cluster name not found in configuration'
      });
    }

    const nodes = await KarpenterManager.getKarpenterNodes(eksClusterName, region);

    res.json({
      success: true,
      nodes: nodes,
      total: nodes.length,
      clusterTag: activeCluster,
      eksClusterName: eksClusterName
    });

  } catch (error) {
    console.error('Error getting Karpenter nodes:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 卸载 Karpenter
app.delete('/api/cluster/karpenter/uninstall', async (req, res) => {
  try {
    const { clusterTag } = req.body;
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();

    // 如果没有提供clusterTag，使用活跃集群
    const targetCluster = clusterTag || clusterManager.getActiveCluster();

    if (!targetCluster) {
      return res.status(400).json({
        success: false,
        error: 'No cluster specified and no active cluster found'
      });
    }

    console.log(`Uninstalling Karpenter for cluster: ${targetCluster}`);

    // 异步卸载Karpenter
    setTimeout(async () => {
      try {
        await KarpenterManager.uninstallKarpenter(targetCluster, clusterManager);

        // 广播卸载完成消息
        broadcast({
          type: 'karpenter_uninstallation_completed',
          clusterTag: targetCluster,
          message: 'Karpenter uninstallation completed successfully',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Karpenter uninstallation failed:', error);

        // 广播卸载失败消息
        broadcast({
          type: 'karpenter_uninstallation_failed',
          clusterTag: targetCluster,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }, 1000);

    // 立即返回开始卸载的响应
    res.json({
      success: true,
      message: 'Karpenter uninstallation started',
      clusterTag: targetCluster,
      status: 'uninstalling'
    });

  } catch (error) {
    console.error('Error starting Karpenter uninstallation:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== Karpenter NodeClass 管理 API =====

// 创建 NodeClass
app.post('/api/cluster/karpenter/nodeclass', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster selected'
      });
    }

    const config = req.body;

    // 验证必需字段
    if (!config.nodeClassName) {
      return res.status(400).json({
        success: false,
        error: 'NodeClass name is required'
      });
    }

    console.log(`Creating NodeClass: ${config.nodeClassName} for cluster: ${activeCluster}`);

    const result = await KarpenterManager.createNodeClass(activeCluster, config, clusterManager);

    // 广播创建成功消息
    broadcast({
      type: 'karpenter_nodeclass_created',
      clusterTag: activeCluster,
      nodeClassName: config.nodeClassName,
      message: result.message,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (error) {
    console.error('Error creating NodeClass:', error);

    // 广播创建失败消息
    broadcast({
      type: 'karpenter_nodeclass_create_failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取所有 NodeClass
app.get('/api/cluster/karpenter/nodeclass', async (req, res) => {
  try {
    const nodeClasses = await KarpenterManager.getNodeClasses();

    res.json({
      success: true,
      data: nodeClasses
    });
  } catch (error) {
    console.error('Error getting NodeClasses:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

// 删除 NodeClass
app.delete('/api/cluster/karpenter/nodeclass/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const activeCluster = clusterManager.getActiveCluster();

    console.log(`Deleting NodeClass: ${name} from cluster: ${activeCluster}`);

    const result = await KarpenterManager.deleteNodeClass(name);

    // 广播删除成功消息
    broadcast({
      type: 'karpenter_nodeclass_deleted',
      clusterTag: activeCluster,
      nodeClassName: name,
      message: result.message,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (error) {
    console.error('Error deleting NodeClass:', error);

    // 广播删除失败消息
    broadcast({
      type: 'karpenter_nodeclass_delete_failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== Karpenter NodePool 管理 API =====

// 创建 NodePool
app.post('/api/cluster/karpenter/nodepool', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster selected'
      });
    }

    const config = req.body;

    // 验证必需字段
    if (!config.nodePoolName) {
      return res.status(400).json({
        success: false,
        error: 'NodePool name is required'
      });
    }

    if (!config.nodeClassRef) {
      return res.status(400).json({
        success: false,
        error: 'NodeClass reference is required'
      });
    }

    console.log(`Creating NodePool: ${config.nodePoolName} for cluster: ${activeCluster}`);

    const result = await KarpenterManager.createNodePool(activeCluster, config, clusterManager);

    // 广播创建成功消息
    broadcast({
      type: 'karpenter_nodepool_created',
      clusterTag: activeCluster,
      nodePoolName: config.nodePoolName,
      message: result.message,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (error) {
    console.error('Error creating NodePool:', error);

    // 广播创建失败消息
    broadcast({
      type: 'karpenter_nodepool_create_failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取所有 NodePool
app.get('/api/cluster/karpenter/nodepool', async (req, res) => {
  try {
    const nodePools = await KarpenterManager.getNodePools();

    res.json({
      success: true,
      data: nodePools
    });
  } catch (error) {
    console.error('Error getting NodePools:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: []
    });
  }
});

// 删除 NodePool
app.delete('/api/cluster/karpenter/nodepool/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const activeCluster = clusterManager.getActiveCluster();

    console.log(`Deleting NodePool: ${name} from cluster: ${activeCluster}`);

    const result = await KarpenterManager.deleteNodePool(name);

    // 广播删除成功消息
    broadcast({
      type: 'karpenter_nodepool_deleted',
      clusterTag: activeCluster,
      nodePoolName: name,
      message: result.message,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (error) {
    console.error('Error deleting NodePool:', error);

    // 广播删除失败消息
    broadcast({
      type: 'karpenter_nodepool_delete_failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===== Karpenter 综合资源状态 API =====

// 统一创建 Karpenter 资源 (NodeClass + NodePool)
app.post('/api/cluster/karpenter/unified-resources', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster selected'
      });
    }

    const config = req.body;

    // 验证必需字段
    if (!config.nodeClassName || !config.nodePoolName) {
      return res.status(400).json({
        success: false,
        error: 'NodeClass name and NodePool name are required'
      });
    }

    console.log(`Creating unified Karpenter resources for cluster: ${activeCluster}`);
    console.log(`NodeClass: ${config.nodeClassName}, NodePool: ${config.nodePoolName}`);

    const result = await KarpenterManager.createUnifiedKarpenterResources(activeCluster, config, clusterManager);

    // 广播创建成功消息
    broadcast({
      type: 'karpenter_unified_resources_created',
      clusterTag: activeCluster,
      nodeClassName: config.nodeClassName,
      nodePoolName: config.nodePoolName,
      message: result.message,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (error) {
    console.error('Error creating unified Karpenter resources:', error);

    // 广播创建失败消息
    broadcast({
      type: 'karpenter_unified_resources_create_failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 HyperPod 计算节点所在的子网
app.get('/api/cluster/karpenter/hyperpod-subnets', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const subnets = await KarpenterManager.getHyperPodComputeSubnets(activeCluster, clusterManager);

    // 获取子网的详细信息（名称和AZ）
    const subnetDetails = [];
    if (subnets && subnets.length > 0) {
      for (const subnetId of subnets) {
        try {
          const cmd = `aws ec2 describe-subnets --subnet-ids ${subnetId} --query 'Subnets[0].[SubnetId,AvailabilityZone,Tags[?Key==\`Name\`].Value|[0]]' --output text`;
          const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
          const [id, az, name] = result.split('\t');
          subnetDetails.push({
            subnetId: id,
            availabilityZone: az,
            name: name || `subnet-${az}`,
            displayName: `${name || id} (${az})`
          });
        } catch (error) {
          console.warn(`Failed to get details for subnet ${subnetId}:`, error.message);
          subnetDetails.push({
            subnetId: subnetId,
            availabilityZone: 'unknown',
            name: subnetId,
            displayName: `${subnetId} (unknown AZ)`
          });
        }
      }
    }

    res.json({
      success: true,
      data: {
        subnets: subnetDetails,
        count: subnetDetails.length
      }
    });
  } catch (error) {
    console.error('Error getting HyperPod compute subnets:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        subnets: [],
        count: 0
      }
    });
  }
});

// 获取所有 Karpenter 资源
app.get('/api/cluster/karpenter/resources', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const resources = await KarpenterManager.getKarpenterResources(activeCluster);

    res.json({
      success: true,
      data: resources
    });
  } catch (error) {
    console.error('Error getting Karpenter resources:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        nodeClasses: [],
        nodePools: [],
        nodes: [],
        summary: {
          nodeClassCount: 0,
          nodePoolCount: 0,
          nodeCount: 0
        }
      }
    });
  }
});

console.log('Karpenter NodeClass/NodePool Management APIs loaded');
console.log('Karpenter Management APIs loaded');

// ==========================================
// HyperPod Karpenter Management APIs
// ==========================================

// 获取 HyperPod Karpenter 资源
app.get('/api/cluster/hyperpod-karpenter/resources', async (req, res) => {
  try {
    const resources = await HyperPodKarpenterManager.getHyperPodKarpenterResources();
    
    res.json({
      success: true,
      data: resources
    });
  } catch (error) {
    console.error('Error getting HyperPod Karpenter resources:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        nodeClasses: [],
        nodePools: []
      }
    });
  }
});

// 删除 HyperPod Karpenter NodePool
app.delete('/api/cluster/hyperpod-karpenter/nodepool/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await HyperPodKarpenterManager.deleteNodePool(name);
    
    res.json(result);
  } catch (error) {
    console.error('Error deleting HyperPod Karpenter NodePool:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 删除 HyperpodNodeClass
app.delete('/api/cluster/hyperpod-karpenter/nodeclass/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await HyperPodKarpenterManager.deleteNodeClass(name);
    
    res.json(result);
  } catch (error) {
    console.error('Error deleting HyperpodNodeClass:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 安装 HyperPod Karpenter
app.post('/api/cluster/hyperpod-karpenter/install', async (req, res) => {
  try {
    const { clusterTag, hyperPodClusterName } = req.body;
    
    console.log(`Installing HyperPod Karpenter for cluster: ${clusterTag}, HyperPod: ${hyperPodClusterName}`);
    
    const result = await HyperPodKarpenterInstaller.installHyperPodKarpenter(clusterTag, hyperPodClusterName);
    
    res.json(result);
  } catch (error) {
    console.error('Error installing HyperPod Karpenter:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 HyperPod Karpenter 安装状态
app.get('/api/cluster/hyperpod-karpenter/status', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const status = await HyperPodKarpenterInstaller.getInstallationStatus(activeCluster);
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Error getting HyperPod Karpenter status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      data: { installed: false }
    });
  }
});

// 创建 HyperPod Karpenter 资源
app.post('/api/cluster/hyperpod-karpenter/create-resource', async (req, res) => {
  try {
    const { instanceGroups } = req.body;
    
    if (!instanceGroups || instanceGroups.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Instance groups are required'
      });
    }
    
    const result = await HyperPodKarpenterManager.createHyperPodKarpenterResource(instanceGroups);
    
    res.json(result);
  } catch (error) {
    console.error('Error creating HyperPod Karpenter resource:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

console.log('HyperPod Karpenter Management APIs loaded');

// ================================
// ==========================================
// HAMi GPU Virtualization APIs
// ==========================================

const HAMiManager = require('./utils/hamiManager');

// 安装/更新 HAMi
// HAMi GPU Virtualization APIs
// ================================

// 全局安装/配置 HAMi（幂等操作）
app.post('/api/cluster/hami/install', async (req, res) => {
  try {
    const { splitCount, nodePolicy, gpuPolicy } = req.body;
    const activeCluster = clusterManager.getActiveCluster();

    console.log(`Installing/Configuring HAMi for cluster: ${activeCluster}`);

    const result = await HAMiManager.installHAMi({
      splitCount,
      nodePolicy,
      gpuPolicy
    });

    // 保存配置到 metadata
    HAMiManager.saveConfig(activeCluster, {
      splitCount,
      nodePolicy,
      gpuPolicy
    }, clusterManager);

    res.json(result);
  } catch (error) {
    console.error('HAMi installation error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 卸载 HAMi
app.delete('/api/cluster/hami/uninstall', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    console.log(`Uninstalling HAMi for cluster: ${activeCluster}`);

    const result = await HAMiManager.uninstallHAMi();

    // 清除 metadata
    HAMiManager.clearConfig(activeCluster, clusterManager);

    res.json(result);
  } catch (error) {
    console.error('HAMi uninstallation error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 检查 HAMi 状态
app.get('/api/cluster/hami/status', async (req, res) => {
  try {
    const activeCluster = clusterManager.getActiveCluster();
    const status = await HAMiManager.checkStatus(activeCluster, clusterManager);
    res.json(status);
  } catch (error) {
    console.error('HAMi status check error:', error);
    res.status(500).json({ 
      installed: false, 
      error: error.message 
    });
  }
});

// 启用节点（打标签）
app.post('/api/cluster/hami/node/enable', async (req, res) => {
  try {
    const { nodeName } = req.body;
    
    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

    console.log(`Enabling HAMi for node: ${nodeName}`);
    const result = await HAMiManager.enableNode(nodeName);
    
    res.json(result);
  } catch (error) {
    console.error('HAMi node enable error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 禁用节点（删除标签 + 清理 pods）
app.post('/api/cluster/hami/node/disable', async (req, res) => {
  try {
    const { nodeName } = req.body;
    
    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

    console.log(`Disabling HAMi for node: ${nodeName}`);
    const result = await HAMiManager.disableNode(nodeName);
    
    res.json(result);
  } catch (error) {
    console.error('HAMi node disable error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// HyperPod 节点 Reboot/Replace API 已迁移至 hyperpodApiManager.js

// 获取 AMP Workspace URL
app.get('/api/cluster/amp-workspace', async (req, res) => {
  try {
    const InferenceOperatorManager = require('./utils/inferenceOperatorManager');
    const inferenceOpManager = new InferenceOperatorManager(clusterManager);
    const result = await inferenceOpManager.getAmpWorkspace();
    res.json(result);
  } catch (error) {
    console.error('Error fetching AMP workspace:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// KEDA Auto Scaling APIs
// ================================

const KedaManager = require('./utils/kedaManager');
const ManagedScalingManager = require('./utils/managedScalingManager');

// 预览 KEDA YAML 配置 - TODO: 需要实现缺失的方法
app.post('/api/keda/preview', async (req, res) => {
  try {
    const config = req.body;

    // 验证配置
    const validation = KedaManager.validateConfig(config);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration',
        errors: validation.errors
      });
    }

    // TODO: KedaManager.generateFullKedaYaml 方法不存在，需要实现或使用替代方案
    res.status(501).json({
      success: false,
      error: 'Method KedaManager.generateFullKedaYaml is not implemented',
      message: 'This API endpoint needs the missing generateFullKedaYaml method'
    });
  } catch (error) {
    console.error('Error generating KEDA preview:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 部署 KEDA 配置
app.post('/api/deploy-keda-scaling', async (req, res) => {
  try {
    const config = req.body;
    console.log('Deploying KEDA scaling with config:', config);

    // 验证配置
    const validation = KedaManager.validateConfig(config);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration',
        errors: validation.errors
      });
    }

    // TODO: KedaManager.applyKedaConfiguration 方法不存在，需要实现或使用替代方案
    // 暂时返回错误，提示需要实现缺失的方法
    const result = {
      success: false,
      error: 'Method KedaManager.applyKedaConfiguration is not implemented',
      message: 'This API endpoint needs the missing applyKedaConfiguration method'
    };

    if (result.success) {
      // 广播成功消息
      broadcast({
        type: 'keda_deployment',
        status: 'success',
        message: 'KEDA scaling configuration deployed successfully',
        yamlPath: result.yamlPath,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        yamlPath: result.yamlPath,
        generatedYaml: result.generatedYaml
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }
  } catch (error) {
    console.error('Error deploying KEDA scaling:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 统一扩缩容 - 预览 YAML
app.post('/api/keda/unified/preview', async (req, res) => {
  try {
    const config = req.body;
    console.log('Generating unified KEDA preview for service:', config.serviceName);

    const result = await KedaManager.previewUnifiedScalingYaml(config);

    if (result.success) {
      res.json({
        success: true,
        yaml: result.yaml,
        config: result.config
      });
    } else {
      console.log('Preview validation failed:', result.errors);
      res.status(400).json({
        success: false,
        error: result.error,
        errors: result.errors
      });
    }
  } catch (error) {
    console.error('Error generating unified KEDA preview:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 统一扩缩容 - 部署配置
app.post('/api/deploy-keda-scaling-unified', async (req, res) => {
  try {
    const config = req.body;
    console.log('Deploying unified KEDA scaling with config:', config);

    const result = await KedaManager.applyUnifiedScalingConfiguration(config);

    if (result.success) {
      // 广播成功消息
      broadcast({
        type: 'keda_unified_deployment',
        status: 'success',
        message: 'Unified KEDA scaling configuration deployed successfully',
        serviceName: config.serviceName,
        deploymentName: config.deploymentName,
        enabledTriggers: config.enabledTriggers,
        yamlPath: result.yamlPath,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        yamlPath: result.yamlPath,
        generatedYaml: result.generatedYaml
      });
    } else {
      // 广播错误消息
      broadcast({
        type: 'keda_unified_deployment',
        status: 'error',
        message: result.message,
        error: result.error,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message,
        errors: result.errors
      });
    }
  } catch (error) {
    console.error('Error deploying unified KEDA scaling:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取 KEDA 状态
app.get('/api/keda/status', async (req, res) => {
  try {
    const status = await KedaManager.getKedaStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting KEDA status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      kedaInstalled: false
    });
  }
});

// 获取 HyperPod Inference Operator 部署列表
app.get('/api/inference-operator/deployments', async (req, res) => {
  try {
    const { stdout } = await execAsync(
      `kubectl get deployments -A -l deploying-service=hyperpod-inference -o json`
    );
    const result = JSON.parse(stdout);
    
    const deployments = result.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      replicas: item.spec.replicas,
      availableReplicas: item.status.availableReplicas || 0,
      creationTimestamp: item.metadata.creationTimestamp
    }));
    
    res.json({ success: true, deployments });
  } catch (error) {
    console.error('Error fetching inference operator deployments:', error);
    res.status(500).json({ success: false, error: error.message, deployments: [] });
  }
});

// Get available metrics for Inference Operator deployment
app.get('/api/inference-operator/deployment/:name/metrics', async (req, res) => {
  try {
    const { name } = req.params;
    const InferenceOperatorMetricsManager = require('./utils/inferenceOperatorMetricsManager');
    const result = await InferenceOperatorMetricsManager.getDeploymentMetrics(name);
    res.json(result);
  } catch (error) {
    console.error('Error fetching deployment metrics:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      businessMetrics: [],
      vllmMetrics: []
    });
  }
});

// Managed Inference Scaling - Preview ScaledObject YAML
app.post('/api/keda/preview-scaledobject', async (req, res) => {
  try {
    const config = req.body;
    const result = await ManagedScalingManager.previewScaledObject(config);
    res.json(result);
  } catch (error) {
    console.error('Error generating ScaledObject preview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Managed Inference Scaling - Deploy ScaledObject
app.post('/api/keda/deploy-scaledobject', async (req, res) => {
  try {
    const config = req.body;
    const result = await ManagedScalingManager.deployScaledObject(config);
    res.json(result);
  } catch (error) {
    console.error('Error deploying ScaledObject:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 删除 ScaledObject
app.delete('/api/keda/scaledobject/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { namespace = 'default' } = req.query;

    const result = await ManagedScalingManager.deleteScaledObject(name, namespace);

    if (result.success) {
      broadcast({
        type: 'keda_scaledobject_deleted',
        status: 'success',
        message: result.message,
        scaledObjectName: name,
        namespace: namespace,
        timestamp: new Date().toISOString()
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error deleting ScaledObject:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

console.log('KEDA Auto Scaling APIs loaded');

// ================================
// Advanced Scaling (SGLang Router) API
// ================================

const RoutingManager = require('./utils/routingManager');

// 获取可用的SGLang部署列表 (用于Router配置)
app.get('/api/sglang-deployments', async (req, res) => {
  try {
    const { execSync } = require('child_process');

    // 获取所有SGLang类型的deployment
    const deployCmd = 'kubectl get deployments -l model-type=sglang -o json';
    const deployResult = execSync(deployCmd, { encoding: 'utf8' });
    const deployments = JSON.parse(deployResult);

    // 获取所有SGLang类型的service
    const serviceCmd = 'kubectl get services -l model-type=sglang -o json';
    const serviceResult = execSync(serviceCmd, { encoding: 'utf8' });
    const services = JSON.parse(serviceResult);

    // 匹配deployment和service，只返回ClusterIP类型的
    const availableDeployments = [];

    deployments.items.forEach(deployment => {
      const deploymentTag = deployment.metadata.labels['deployment-tag'];
      if (!deploymentTag) return;

      // 找到对应的service
      const matchingService = services.items.find(service =>
        service.metadata.labels['deployment-tag'] === deploymentTag
      );

      if (matchingService && matchingService.spec.type === 'ClusterIP') {
        const port = matchingService.spec.ports[0]?.port || 8000;

        availableDeployments.push({
          deploymentTag,
          name: deployment.metadata.name,
          serviceName: matchingService.metadata.name,
          port: port,
          ready: deployment.status.readyReplicas || 0,
          total: deployment.status.replicas || 0,
          status: (deployment.status.readyReplicas === deployment.status.replicas &&
                   deployment.status.readyReplicas > 0) ? 'Ready' : 'NotReady',
          creationTime: deployment.metadata.creationTimestamp
        });
      }
    });

    // 按创建时间排序，最新的在前面
    availableDeployments.sort((a, b) => new Date(b.creationTime) - new Date(a.creationTime));

    res.json({
      success: true,
      deployments: availableDeployments,
      total: availableDeployments.length
    });

  } catch (error) {
    console.error('Error fetching SGLang deployments:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      deployments: []
    });
  }
});

// 部署 Advanced Scaling 配置
app.post('/api/deploy-advanced-scaling', async (req, res) => {
  try {
    const config = req.body;
    console.log('Deploying SGLang Router with config:', config);

    // 验证配置
    const validation = RoutingManager.validateConfig(config.sglangRouter);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration',
        errors: validation.errors
      });
    }

    // 使用 RoutingManager 部署
    const result = await RoutingManager.applyRouterConfiguration(config.sglangRouter);

    if (result.success) {
      // 广播成功消息
      broadcast({
        type: 'sglang_router_deployment',
        status: 'success',
        message: result.message,
        yamlPath: result.yamlPath,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        yamlPath: result.yamlPath,
        generatedYaml: result.generatedYaml,
        kubectlOutput: result.kubectlOutput
      });
    } else {
      broadcast({
        type: 'sglang_router_deployment',
        status: 'error',
        message: result.message,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        success: false,
        error: result.error,
        message: result.message
      });
    }

  } catch (error) {
    console.error('Error deploying SGLang Router:', error);

    broadcast({
      type: 'sglang_router_deployment',
      status: 'error',
      message: `SGLang Router deployment failed: ${error.message}`,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取Router部署列表
app.get('/api/routers', async (req, res) => {
  try {
    console.log('Getting Router deployments list');

    const routers = await RoutingManager.getRouterDeployments();

    res.json({
      success: true,
      routers: routers,
      count: routers.length
    });

  } catch (error) {
    console.error('Error getting Router deployments:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to get Router deployments'
    });
  }
});

// 获取Router Services列表（用于KEDA配置）
app.get('/api/router-services', async (req, res) => {
  try {
    console.log('Getting Router services list');
    const services = await RoutingManager.getRouterServices();
    res.json({
      success: true,
      services: services,
      count: services.length
    });
  } catch (error) {
    console.error('Error getting Router services:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to get Router services'
    });
  }
});

// 删除指定Router部署
app.delete('/api/routers/:deploymentName', async (req, res) => {
  try {
    const { deploymentName } = req.params;
    console.log(`Deleting Router deployment: ${deploymentName}`);

    if (!deploymentName) {
      return res.status(400).json({
        success: false,
        error: 'Deployment name is required'
      });
    }

    const result = await RoutingManager.deleteRouter(deploymentName);

    if (result.success) {
      // 广播删除完成消息
      broadcast({
        type: 'sglang_router_deletion',
        status: 'success',
        message: result.message,
        deploymentName: deploymentName,
        deletedCount: result.totalDeleted,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: result.message,
        processedInstances: result.processedInstances,
        totalDeleted: result.totalDeleted,
        results: result.results
      });
    } else {
      // 广播删除失败消息
      broadcast({
        type: 'sglang_router_deletion',
        status: 'error',
        message: result.message,
        deploymentName: deploymentName,
        error: result.error,
        timestamp: new Date().toISOString()
      });

      res.status(400).json(result);
    }

  } catch (error) {
    console.error('Error deleting Router deployment:', error);

    broadcast({
      type: 'sglang_router_deletion',
      status: 'error',
      message: 'Failed to delete Router deployment',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to delete Router deployment'
    });
  }
});

// 删除所有Router部署（管理员功能）
app.delete('/api/routers', async (req, res) => {
  try {
    console.log('Deleting all Router deployments');

    const result = await RoutingManager.deleteAllRouters();

    if (result.success) {
      broadcast({
        type: 'sglang_router_deletion_all',
        status: 'success',
        message: result.message,
        timestamp: new Date().toISOString()
      });

      res.json(result);
    } else {
      broadcast({
        type: 'sglang_router_deletion_all',
        status: 'error',
        message: result.message,
        error: result.error,
        timestamp: new Date().toISOString()
      });

      res.status(400).json(result);
    }

  } catch (error) {
    console.error('Error deleting all Router deployments:', error);

    broadcast({
      type: 'sglang_router_deletion_all',
      status: 'error',
      message: 'Failed to delete all Router deployments',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to delete all Router deployments'
    });
  }
});

console.log('Advanced Scaling (SGLang Router) API loaded');

app.listen(PORT, () => {
  console.log('🚀 ========================================');
  console.log('🚀 HyperPod InstantStart Server Started');
  console.log('🚀 ========================================');
  console.log(`📡 HTTP Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket Server: ws://localhost:${WS_PORT}`);
  console.log(`🌐 Multi-cluster management: enabled`);
  console.log(`⏰ Server started at: ${new Date().toISOString()}`);
  console.log(`🖥️  Node.js version: ${process.version}`);
  console.log(`💾 Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('🚀 ========================================');
  console.log('✅ Server is ready to accept connections');
});
