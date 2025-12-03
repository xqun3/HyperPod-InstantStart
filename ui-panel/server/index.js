const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { exec, spawn, execSync } = require('child_process');
const fs = require('fs-extra');
const YAML = require('yaml');
const path = require('path');
const https = require('https');
const http = require('http');
const { parse } = require('shell-quote');

// 引入工具模块
const HyperPodDependencyManager = require('./utils/hyperPodDependencyManager');
const { getCurrentRegion } = require('./utils/awsHelpers');
const AWSHelpers = require('./utils/awsHelpers');
const MetadataUtils = require('./utils/metadataUtils');
const EKSServiceHelper = require('./utils/eksServiceHelper');

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

const app = express();
const PORT = 3001;
const WS_PORT = 3098; // WebSocket独立端口

app.use(cors());
app.use(express.json());

// WebSocket服务器使用独立端口
const wss = new WebSocket.Server({ port: WS_PORT });

// 存储活跃的日志流
const activeLogStreams = new Map();

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

// 广播消息给所有连接的客户端
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
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
        console.log(`kubectl command succeeded: kubectl ${command}`);
        console.log(`Output:`, stdout);
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

// 判断是否需要ThreadsPerCore=2（有TrainingPlan或使用p4/p5/p6实例）
function shouldUseThreadsPerCore2(instanceType, trainingPlanArn) {
  if (trainingPlanArn) return true;
  if (!instanceType) return false;
  const type = instanceType.toLowerCase();
  return type.startsWith('ml.p4') || type.startsWith('ml.p5') || type.startsWith('ml.p6');
}

// 简化的模型标签生成函数（用于模型下载）
function generateModelTag(modelId) {
  if (!modelId) return 'model';
  return modelId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'model';
}

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
      
      console.log(`Making HTTP ${method} request to: ${url}`);
      console.log(`Request options:`, JSON.stringify(options, null, 2));
      if (!isGetRequest) {
        console.log(`Payload:`, postData);
      }
      
      const req = httpModule.request(options, (res) => {
        let data = '';
        
        console.log(`Response status: ${res.statusCode}`);
        console.log(`Response headers:`, JSON.stringify(res.headers, null, 2));
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          console.log(`Response data:`, data);
          
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
    
    console.log(`Proxying ${method} request to: ${url}`);
    if (method.toUpperCase() !== 'GET') {
      console.log(`Payload:`, JSON.stringify(payload, null, 2));
    }
    
    const result = await makeHttpRequest(url, payload, method);
    
    console.log('Proxy result:', JSON.stringify(result, null, 2));
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
    
    console.log(`Proxying ${method} request to: ${url}`);
    if (method.toUpperCase() !== 'GET') {
      console.log(`Payload:`, JSON.stringify(payload, null, 2));
    }
    
    const result = await makeHttpRequest(url, payload, method);
    
    console.log('Proxy result:', JSON.stringify(result, null, 2));
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
      memoryRequest = -1  // 内存请求，默认-1（不设置限制）
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
      port
    });

    // 生成带时间戳的唯一标签（符合Kubernetes命名规范）
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')     // 替换冒号和点号为连字符
      .replace('T', '-')         // 替换T为连字符
      .slice(0, 19);             // 截取到秒级
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

      // HyperPod 节点选择器条件
      if (hyperpodTypes.length > 0) {
        nodeSelectorTerms.push(`            # 选项1：HyperPod 节点
            - matchExpressions:
              - key: sagemaker.amazonaws.com/compute-type
                operator: In
                values: ["hyperpod"]
              - key: node.kubernetes.io/instance-type
                operator: In
                values: [${hyperpodTypes.map(t => `"${t}"`).join(', ')}]`);
      }

      // EC2 节点选择器条件 (EKS NodeGroup + Karpenter)
      if (gpuTypes.length > 0) {
        nodeSelectorTerms.push(`            # 选项2：EC2 GPU 节点 (EKS NodeGroup + Karpenter)
            - matchExpressions:
              - key: node.kubernetes.io/instance-type
                operator: In
                values: [${gpuTypes.map(t => `"${t}"`).join(', ')}]`);
      }

      return nodeSelectorTerms.join('\n');
    };

    const hybridNodeSelectorTerms = generateHybridNodeSelectorTerms(instanceTypes);
    console.log('Generated hybrid node selector terms:', hybridNodeSelectorTerms);

    // 处理Container部署（移除了Ollama支持）
    {
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

// 统一的训练YAML部署函数
async function deployTrainingYaml(recipeType, jobName, yamlContent) {
  try {
    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingsDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingsDir)) {
      fs.mkdirSync(trainingsDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    const tempFileName = `${recipeType}-${jobName}-${Date.now()}.yaml`;
    const tempFilePath = path.join(tempDir, tempFileName);
    await fs.writeFile(tempFilePath, yamlContent);

    // 写入永久文件（用于记录）
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const permanentFileName = `${recipeType}_${timestamp}.yaml`;
    const permanentFilePath = path.join(trainingsDir, permanentFileName);
    await fs.writeFile(permanentFilePath, yamlContent);

    console.log(`${recipeType} training YAML saved to: ${permanentFilePath}`);

    // 应用YAML配置
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`);
    console.log(`${recipeType} training kubectl apply output:`, applyOutput);

    // 清理临时文件
    fs.unlinkSync(tempFilePath);

    // 发送WebSocket广播
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched ${recipeType} training job: ${jobName}`,
      output: applyOutput
    });

    return {
      success: true,
      permanentFileName,
      permanentFilePath,
      applyOutput
    };

  } catch (error) {
    // 发送错误广播
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `${recipeType} training launch failed: ${error.message}`
    });

    throw error;
  }
}

// 生成并部署HyperPod Torch训练任务 - 专门用于Torch训练
app.post('/api/launch-torch-training', async (req, res) => {
  try {
    console.log('Raw torch training request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 16,
      entryPythonScriptPath,
      pythonScriptParameters,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Torch training launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      entryPythonScriptPath,
      pythonScriptParameters,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!entryPythonScriptPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Python Script Path is required'
      });
    }

    if (!pythonScriptParameters) {
      return res.status(400).json({
        success: false,
        error: 'Python Script Parameters are required'
      });
    }

    // 读取Torch训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-torch-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 处理日志监控配置
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      // 添加适当的缩进
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }
    
    // 处理Python脚本参数 - 确保多行参数在YAML中正确格式化
    let formattedPythonParams = pythonScriptParameters;
    if (pythonScriptParameters.includes('\\')) {
      // 如果包含反斜杠换行符，将其转换为单行格式
      formattedPythonParams = pythonScriptParameters
        .replace(/\\\s*\n\s*/g, ' ')  // 将反斜杠换行替换为空格
        .replace(/\s+/g, ' ')         // 合并多个空格
        .trim();
    }
    
    // 根据MLFlow URI决定serviceAccount配置
    let serviceAccountConfig = '';
    if (mlflowTrackingUri && mlflowTrackingUri.trim() !== '') {
      serviceAccountConfig = 'serviceAccountName: mlflow-service-account';
    }
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/TORCH_RECIPE_PYPATH_PH/g, entryPythonScriptPath)
      .replace(/TORCH_RECIPE_PYPARAMS_PH/g, formattedPythonParams)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/SERVICE_ACCOUNT_CONFIG/g, serviceAccountConfig)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    console.log('Generated torch training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `torch-training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成部署文件名（保存到deployments/trainings/目录）
    const deploymentFileName = `torch_${timestamp}.yaml`;
    const deploymentFilePath = path.join(__dirname, '../deployments/trainings', deploymentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Torch training YAML written to temp file: ${tempFilePath}`);

    // 写入部署文件（保存到deployments/trainings/目录）
    await fs.writeFile(deploymentFilePath, newYamlContent);
    console.log(`Torch training YAML saved to deployments: ${deploymentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('Torch training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched torch training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Torch training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: deploymentFileName,
      savedTemplatePath: deploymentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Torch training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Torch training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 生成并部署SageMaker训练任务
app.post('/api/launch-sagemaker-job', async (req, res) => {
  try {
    console.log('Raw SageMaker job request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      smJobDir,
      entryPythonScriptPath,
      pythonScriptParameters,
      enableSpotTraining = false,
      maxWaitTimeInSeconds = 1800
    } = req.body;

    console.log('SageMaker job launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      smJobDir,
      entryPythonScriptPath,
      pythonScriptParameters
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!smJobDir) {
      return res.status(400).json({
        success: false,
        error: 'SageMaker Job Dir is required'
      });
    }

    if (!entryPythonScriptPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Python Script Path is required'
      });
    }

    if (!pythonScriptParameters) {
      return res.status(400).json({
        success: false,
        error: 'Python Script Parameters are required'
      });
    }

    // 读取SageMaker作业模板
    const templatePath = path.join(__dirname, '../templates/sagemaker-job-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');

    // 动态获取AWS资源信息
    const awsHelpers = require('./utils/awsHelpers');
    const bucketName = awsHelpers.getCurrentS3Bucket();
    const devAdminRoleArn = await awsHelpers.getDevAdminRoleArn();

    console.log('Dynamic AWS resources:', { bucketName, devAdminRoleArn });

    // 处理Python脚本参数
    let formattedPythonParams = pythonScriptParameters;
    if (pythonScriptParameters.includes('\\')) {
      formattedPythonParams = pythonScriptParameters
        .replace(/\\\s*\n\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 替换模板中的占位符
    let newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/NUM_REPLICAS/g, `"${replicas.toString()}"`)
      .replace(/SAGEMAKER_JOB_DIR/g, smJobDir)
      .replace(/ENTRY_PYTHON_PATH/g, entryPythonScriptPath)
      .replace(/GPU_PER_NODE/g, `"${nprocPerNode.toString()}"`)
      .replace(/PYTHON_SCRIPT_PARAMS/g, formattedPythonParams)
      .replace(/FUSE_S3_PATH/g, bucketName)
      .replace(/SAGEMAKER_DEV_ROLE/g, devAdminRoleArn)
      .replace(/SPOT_TRAINING_ENABLED/g, enableSpotTraining.toString())
      .replace(/SPOT_MAX_WAIT_TIME/g, maxWaitTimeInSeconds.toString());

    console.log('Generated SageMaker job YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `sagemaker-job-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到deployments/trainings/目录）
    const permanentFileName = `sagemaker_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../deployments/trainings', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`SageMaker job YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到deployments/trainings/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`SageMaker job YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('SageMaker job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播SageMaker作业启动状态更新
    broadcast({
      type: 'sagemaker_launch',
      status: 'success',
      message: `Successfully launched SageMaker job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `SageMaker job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('SageMaker job launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'sagemaker_launch',
      status: 'error',
      message: `SageMaker job launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 生成并部署HyperPod训练任务 - 专门用于LlamaFactory训练任务
app.post('/api/launch-training', async (req, res) => {
  try {
    console.log('Raw request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = 'pytorch/pytorch:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 0,
      lmfRecipeRunPath,
      lmfRecipeYamlFile,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Training launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      lmfRecipeRunPath,
      lmfRecipeYamlFile,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!lmfRecipeRunPath) {
      return res.status(400).json({
        success: false,
        error: 'LlamaFactory Recipe Run Path is required'
      });
    }

    if (!lmfRecipeYamlFile) {
      return res.status(400).json({
        success: false,
        error: 'LlamaFactory Config YAML File Name is required'
      });
    }

    // 读取训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-lmf-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 处理日志监控配置
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      // 添加适当的缩进
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }
    
    // 根据MLFlow URI决定serviceAccount配置
    let serviceAccountConfig = '';
    if (mlflowTrackingUri && mlflowTrackingUri.trim() !== '') {
      serviceAccountConfig = 'serviceAccountName: mlflow-service-account';
    }
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/LMF_RECIPE_RUNPATH_PH/g, lmfRecipeRunPath)
      .replace(/LMF_RECIPE_YAMLFILE_PH/g, lmfRecipeYamlFile)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/SERVICE_ACCOUNT_CONFIG/g, serviceAccountConfig)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    console.log('Generated training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成部署文件名（保存到deployments/trainings/目录）
    const deploymentFileName = `lma_${timestamp}.yaml`;
    const deploymentFilePath = path.join(__dirname, '../deployments/trainings', deploymentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保deployments/trainings目录存在
    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Training YAML written to temp file: ${tempFilePath}`);

    // 写入部署文件（保存到deployments/trainings/目录）
    await fs.writeFile(deploymentFilePath, newYamlContent);
    console.log(`Training YAML saved to deployments: ${deploymentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('Training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: deploymentFileName,
      savedTemplatePath: deploymentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 启动MS-Swift训练
app.post('/api/launch-msswift-training', async (req, res) => {
  try {
    console.log('MS-Swift training launch request:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = 'pytorch/pytorch:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 0,
      msswiftRecipeRunPath,
      msswiftCommandType,
      msswiftRecipeYamlFile,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!msswiftRecipeRunPath) {
      return res.status(400).json({
        success: false,
        error: 'MS-Swift Recipe Run Path is required'
      });
    }

    if (!msswiftCommandType) {
      return res.status(400).json({
        success: false,
        error: 'MS-Swift Command Type is required'
      });
    }

    if (!msswiftRecipeYamlFile) {
      return res.status(400).json({
        success: false,
        error: 'MS-Swift Config YAML File Name is required'
      });
    }

    const templatePath = path.join(__dirname, '../templates/hyperpod-training-msswift-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }

    let serviceAccountConfig = '';
    if (mlflowTrackingUri && mlflowTrackingUri.trim() !== '') {
      serviceAccountConfig = 'serviceAccountName: mlflow-service-account';
    }

    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/MSSWIFT_RECIPE_RUNPATH_PH/g, msswiftRecipeRunPath)
      .replace(/MSSWIFT_COMMAND_TYPE_PH/g, msswiftCommandType)
      .replace(/MSSWIFT_RECIPE_YAMLFILE_PH/g, msswiftRecipeYamlFile)
      .replace(/MSSWIFT_RECIPE_YAMLFILE_PH/g, msswiftRecipeYamlFile)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/SERVICE_ACCOUNT_CONFIG/g, serviceAccountConfig)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    const timestamp = Date.now();
    
    const tempFileName = `training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    const deploymentFileName = `msswift_${timestamp}.yaml`;
    const deploymentFilePath = path.join(__dirname, '../deployments/trainings', deploymentFileName);

    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const trainingDeploymentDir = path.join(__dirname, '../deployments/trainings');
    if (!fs.existsSync(trainingDeploymentDir)) {
      fs.mkdirSync(trainingDeploymentDir, { recursive: true });
    }

    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`MS-Swift training YAML written to temp file: ${tempFilePath}`);

    await fs.writeFile(deploymentFilePath, newYamlContent);
    console.log(`MS-Swift training YAML saved to deployments: ${deploymentFilePath}`);

    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000);
    console.log('MS-Swift training job apply output:', applyOutput);

    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      console.log(`Temp file deleted: ${tempFilePath}`);
    }

    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `MS-Swift training job ${trainingJobName} launched successfully`
    });

    res.json({
      success: true,
      message: `MS-Swift training job ${trainingJobName} launched successfully`,
      jobName: trainingJobName,
      savedTemplate: deploymentFileName,
      savedTemplatePath: deploymentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('MS-Swift training launch error:', error);
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `MS-Swift training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 保存LlamaFactory配置
app.post('/api/llamafactory-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/llamafactory-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('LlamaFactory config saved:', config);
    
    res.json({
      success: true,
      message: 'LlamaFactory configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving training config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载LlamaFactory配置
app.get('/api/llamafactory-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/llamafactory-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'lmf-v1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op-v2:latest',
        instanceType: 'ml.g6.12xlarge',
        nprocPerNode: 4,
        replicas: 1,
        efaCount: 1,
        lmfRecipeRunPath: '/s3/train-recipes/llama-factory-project/',
        lmfRecipeYamlFile: 'qwen_full_dist_template.yaml',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('LlamaFactory config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading training config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存MS-Swift配置
app.post('/api/msswift-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/msswift-config.json');
    
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('MS-Swift config saved:', config);
    
    res.json({
      success: true,
      message: 'MS-Swift configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving MS-Swift config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载MS-Swift配置
app.get('/api/msswift-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/msswift-config.json');
    
    if (!fs.existsSync(configPath)) {
      const defaultConfig = {
        trainingJobName: 'msswift-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op-v2:latest',
        instanceType: 'ml.g6.12xlarge',
        nprocPerNode: 4,
        replicas: 1,
        efaCount: 1,
        msswiftRecipeRunPath: '/s3/train-recipes/ms-swift-project/',
        msswiftRecipeYamlFile: 'yaml_template.yaml',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('MS-Swift config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading MS-Swift config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取MS-Swift命令列表
app.get('/api/msswift-commands', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/msswift-commands.json');
    
    if (!fs.existsSync(configPath)) {
      return res.json({
        success: true,
        commands: {
          "megatron rlhf": "swift.cli._megatron.rlhf",
          "swift sft": "swift.cli.sft"
        }
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    res.json({
      success: true,
      commands: config.commands
    });
  } catch (error) {
    console.error('Error loading MS-Swift commands:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存Script配置
app.post('/api/script-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/script-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Script config saved:', config);
    
    res.json({
      success: true,
      message: 'Script configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving script config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载Script配置
app.get('/api/script-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/script-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'hypd-recipe-script-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        projectPath: '/s3/training_code/my-training-project/',
        entryPath: 'train.py',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('Script config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading script config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 生成并部署HyperPod Script训练任务 - 专门用于Script训练
app.post('/api/launch-script-training', async (req, res) => {
  try {
    console.log('Raw script training request body:', JSON.stringify(req.body, null, 2));
    
    const {
      trainingJobName,
      dockerImage = '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
      instanceType = 'ml.g5.12xlarge',
      nprocPerNode = 1,
      replicas = 1,
      efaCount = 16,
      projectPath,
      entryPath,
      mlflowTrackingUri = '',
      logMonitoringConfig
    } = req.body;

    console.log('Script training launch request parsed:', { 
      trainingJobName,
      dockerImage,
      instanceType,
      nprocPerNode,
      replicas,
      efaCount,
      projectPath,
      entryPath,
      mlflowTrackingUri,
      logMonitoringConfig: logMonitoringConfig ? 'present' : 'empty'
    });

    // 验证必需参数
    if (!trainingJobName) {
      return res.status(400).json({
        success: false,
        error: 'Training job name is required'
      });
    }

    if (!projectPath) {
      return res.status(400).json({
        success: false,
        error: 'Project Path is required'
      });
    }

    if (!entryPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry Script Path is required'
      });
    }

    // 读取Script训练任务模板
    const templatePath = path.join(__dirname, '../templates/hyperpod-training-script-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 处理日志监控配置
    let logMonitoringConfigYaml = '';
    if (logMonitoringConfig && logMonitoringConfig.trim() !== '') {
      // 添加适当的缩进
      const indentedConfig = logMonitoringConfig
        .split('\n')
        .map(line => line.trim() ? `    ${line}` : line)
        .join('\n');
      logMonitoringConfigYaml = `
    logMonitoringConfiguration: 
${indentedConfig}`;
    }
    
    // 根据MLFlow URI决定serviceAccount配置
    let serviceAccountConfig = '';
    if (mlflowTrackingUri && mlflowTrackingUri.trim() !== '') {
      serviceAccountConfig = 'serviceAccountName: mlflow-service-account';
    }
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/TRAINING_JOB_NAME/g, trainingJobName)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/NPROC_PER_NODE/g, nprocPerNode.toString())
      .replace(/REPLICAS_COUNT/g, replicas.toString())
      .replace(/EFA_PER_NODE/g, efaCount.toString())
      .replace(/SCRIPT_RECIPE_PROJECTPATH_PH/g, projectPath)
      .replace(/SCRIPT_RECIPE_ENTRYPATH_PH/g, entryPath)
      .replace(/SM_MLFLOW_ARN/g, mlflowTrackingUri)
      .replace(/SERVICE_ACCOUNT_CONFIG/g, serviceAccountConfig)
      .replace(/LOG_MONITORING_CONFIG/g, logMonitoringConfigYaml);

    console.log('Generated script training YAML content:', newYamlContent);

    // 生成时间戳
    const timestamp = Date.now();
    
    // 生成临时文件名（用于kubectl apply）
    const tempFileName = `script-training-${trainingJobName}-${timestamp}.yaml`;
    const tempFilePath = path.join(__dirname, '../temp', tempFileName);

    // 生成永久保存的文件名（保存到templates/training/目录）
    const permanentFileName = `script_${timestamp}.yaml`;
    const permanentFilePath = path.join(__dirname, '../templates/training', permanentFileName);

    // 确保temp目录存在
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // 确保templates/training目录存在
    const trainingTemplateDir = path.join(__dirname, '../templates/training');
    if (!fs.existsSync(trainingTemplateDir)) {
      fs.mkdirSync(trainingTemplateDir, { recursive: true });
    }

    // 写入临时文件（用于kubectl apply）
    await fs.writeFile(tempFilePath, newYamlContent);
    console.log(`Script training YAML written to temp file: ${tempFilePath}`);

    // 写入永久文件（保存到templates/training/目录）
    await fs.writeFile(permanentFilePath, newYamlContent);
    console.log(`Script training YAML saved permanently to: ${permanentFilePath}`);

    // 应用YAML配置 - 训练任务可能需要更长时间
    const applyOutput = await executeKubectl(`apply -f ${tempFilePath}`, 60000); // 60秒超时
    console.log('Script training job apply output:', applyOutput);

    // 清理临时文件
    try {
      await fs.unlink(tempFilePath);
      console.log(`Temporary file deleted: ${tempFilePath}`);
    } catch (cleanupError) {
      console.warn(`Failed to delete temporary file: ${cleanupError.message}`);
    }

    // 广播训练任务启动状态更新
    broadcast({
      type: 'training_launch',
      status: 'success',
      message: `Successfully launched script training job: ${trainingJobName}`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: `Script training job "${trainingJobName}" launched successfully`,
      trainingJobName: trainingJobName,
      savedTemplate: permanentFileName,
      savedTemplatePath: permanentFilePath,
      output: applyOutput
    });

  } catch (error) {
    console.error('Script training launch error details:', {
      message: error.message,
      stack: error.stack,
      error: error
    });
    
    const errorMessage = error.message || error.toString() || 'Unknown error occurred';
    
    broadcast({
      type: 'training_launch',
      status: 'error',
      message: `Script training launch failed: ${errorMessage}`
    });
    
    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// 保存Torch配置
app.post('/api/torch-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/torch-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('Torch config saved:', config);
    
    res.json({
      success: true,
      message: 'Torch configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving torch config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载Torch配置
app.get('/api/torch-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/torch-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'hypd-recipe-torch-1',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        efaCount: 16,
        entryPythonScriptPath: '/s3/training_code/model-training-with-hyperpod-training-operator/torch-training.py',
        pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
        mlflowTrackingUri: '',
        logMonitoringConfig: ''
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('Torch config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading torch config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存SageMaker配置
app.post('/api/sagemaker-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/sagemaker-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('SageMaker config saved:', config);
    
    res.json({
      success: true,
      message: 'SageMaker configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving SageMaker config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载SageMaker配置
app.get('/api/sagemaker-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/sagemaker-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        trainingJobName: 'sagemaker-job',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest',
        instanceType: 'ml.g5.12xlarge',
        nprocPerNode: 1,
        replicas: 1,
        smJobDir: 'sample-job-1',
        entryPythonScriptPath: 'codes/launcher.py',
        pythonScriptParameters: '--learning_rate 1e-5 \\\n--batch_size 1',
        enableSpotTraining: false,
        maxWaitTimeInSeconds: 1800
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('SageMaker config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading SageMaker config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存verl配置
app.post('/api/verl-config/save', async (req, res) => {
  try {
    const config = req.body;
    const configPath = path.join(__dirname, '../config/verl-config.json');
    
    // 确保config目录存在
    const configDir = path.join(__dirname, '../config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log('VERL config saved:', config);
    
    res.json({
      success: true,
      message: 'VERL configuration saved successfully'
    });
  } catch (error) {
    console.error('Error saving VERL config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 加载verl配置
app.get('/api/verl-config/load', async (req, res) => {
  try {
    const configPath = path.join(__dirname, '../config/verl-config.json');
    
    if (!fs.existsSync(configPath)) {
      // 返回默认配置
      const defaultConfig = {
        jobName: 'verl-training-a1',
        instanceType: 'ml.g5.12xlarge',
        entryPointPath: 'verl-project/src/qwen-3b-grpo-kuberay.sh',
        dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/hypd-verl:latest',
        workerReplicas: 1,
        gpuPerNode: 4,
        efaPerNode: 1
      };
      
      return res.json({
        success: true,
        config: defaultConfig,
        isDefault: true
      });
    }
    
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    console.log('VERL config loaded:', config);
    
    res.json({
      success: true,
      config: config,
      isDefault: false
    });
  } catch (error) {
    console.error('Error loading VERL config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 生成并部署VERL训练任务 - 专门用于VERL训练
app.post('/api/launch-verl-training', async (req, res) => {
  try {
    console.log('Raw VERL training request body:', JSON.stringify(req.body, null, 2));
    
    const {
      jobName,
      instanceType = 'ml.g5.12xlarge',
      entryPointPath,
      dockerImage,
      workerReplicas = 1,
      gpuPerNode = 4,
      efaPerNode = 1,
      recipeType
    } = req.body;

    console.log('VERL training launch request parsed:', { 
      jobName,
      instanceType,
      entryPointPath,
      dockerImage,
      workerReplicas,
      gpuPerNode,
      efaPerNode,
      recipeType
    });

    // 验证必需参数
    if (!jobName) {
      return res.status(400).json({
        success: false,
        error: 'Job name is required'
      });
    }

    if (!entryPointPath) {
      return res.status(400).json({
        success: false,
        error: 'Entry point path is required'
      });
    }

    if (!dockerImage) {
      return res.status(400).json({
        success: false,
        error: 'Docker image is required'
      });
    }

    // 读取VERL训练任务模板
    const templatePath = path.join(__dirname, '../templates/verl-training-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    
    // 替换模板中的占位符
    const newYamlContent = templateContent
      .replace(/JOB_NAME/g, jobName)
      .replace(/INSTANCE_TYPE/g, instanceType)
      .replace(/ENTRY_POINT_PATH/g, entryPointPath)
      .replace(/DOCKER_IMAGE/g, dockerImage)
      .replace(/WORKER_REPLICAS/g, workerReplicas.toString())
      .replace(/MAX_REPLICAS/g, Math.max(3, workerReplicas + 2).toString())
      .replace(/GPU_PER_NODE/g, gpuPerNode.toString())
      .replace(/EFA_PER_NODE/g, efaPerNode.toString());

    console.log('Generated VERL YAML content preview:', newYamlContent.substring(0, 500) + '...');

    // 使用统一的部署函数
    const deployResult = await deployTrainingYaml('verl', jobName, newYamlContent);

    res.json({
      success: true,
      message: `VERL training job "${jobName}" launched successfully`,
      jobName: jobName,
      templateUsed: 'verl-training-template.yaml',
      savedTemplate: deployResult.permanentFileName,
      savedTemplatePath: deployResult.permanentFilePath,
      output: deployResult.applyOutput
    });

  } catch (error) {
    console.error('VERL training launch error:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Unknown error occurred'
    });
  }
});

// 获取所有RayJob
app.get('/api/rayjobs', async (req, res) => {
  try {
    const output = await executeKubectl('get rayjobs -o json');
    const rayjobs = JSON.parse(output);
    // 🔄 返回与前端期望匹配的格式
    res.json({
      items: rayjobs.items || [],
      kind: 'RayJobList',
      apiVersion: rayjobs.apiVersion || 'ray.io/v1'
    });
  } catch (error) {
    console.error('RayJobs fetch error:', error);
    // 返回空列表而不是空数组，保持格式一致
    res.json({
      items: [],
      kind: 'RayJobList',
      apiVersion: 'ray.io/v1'
    });
  }
});

// 删除指定的RayJob
app.delete('/api/rayjobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Deleting RayJob: ${jobName}`);
    
    const output = await executeKubectl(`delete rayjob ${jobName}`);
    console.log('RayJob delete output:', output);
    
    // 发送WebSocket广播
    broadcast({
      type: 'rayjob_deleted',
      status: 'success',
      message: `RayJob "${jobName}" deleted successfully`,
      jobName: jobName
    });
    
    res.json({
      success: true,
      message: `RayJob "${jobName}" deleted successfully`,
      output: output
    });
  } catch (error) {
    console.error('Error deleting RayJob:', error);
    
    broadcast({
      type: 'rayjob_deleted',
      status: 'error',
      message: `Failed to delete RayJob: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取指定 RayJob 的 pods
app.get('/api/rayjobs/:jobName/pods', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Fetching pods for RayJob: ${jobName}`);

    // 首先获取RayJob信息来找到对应的RayCluster名称
    const rayjobOutput = await executeKubectl(`get rayjob ${jobName} -o json`);
    const rayJob = JSON.parse(rayjobOutput);
    const rayClusterName = rayJob.status?.rayClusterName;

    let allPods = [];

    // 获取属于该RayCluster的所有pods（如果RayCluster存在）
    if (rayClusterName) {
      const rayClusterPodsOutput = await executeKubectl(`get pods -l ray.io/cluster=${rayClusterName} -o json`);
      const rayClusterResult = JSON.parse(rayClusterPodsOutput);

      const rayClusterPods = rayClusterResult.items.map(pod => ({
        name: pod.metadata.name,
        status: pod.status.phase,
        ready: pod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
        restartCount: pod.status.containerStatuses?.[0]?.restartCount || 0,
        creationTimestamp: pod.metadata.creationTimestamp,
        node: pod.spec.nodeName,
        type: pod.metadata.labels?.['ray.io/node-type'] || 'ray-node'
      }));

      allPods.push(...rayClusterPods);
      console.log(`Found ${rayClusterPods.length} RayCluster pods for ${jobName} (cluster: ${rayClusterName})`);
    }

    // 获取Job submitter pod（使用job-name标签）
    try {
      const jobPodsOutput = await executeKubectl(`get pods -l job-name=${jobName} -o json`);
      const jobResult = JSON.parse(jobPodsOutput);

      const jobSubmitterPods = jobResult.items.map(pod => ({
        name: pod.metadata.name,
        status: pod.status.phase,
        ready: pod.status.conditions?.find(c => c.type === 'Ready')?.status === 'True',
        restartCount: pod.status.containerStatuses?.[0]?.restartCount || 0,
        creationTimestamp: pod.metadata.creationTimestamp,
        node: pod.spec.nodeName,
        type: 'job-submitter'
      }));

      allPods.push(...jobSubmitterPods);
      console.log(`Found ${jobSubmitterPods.length} job submitter pods for ${jobName}`);
    } catch (jobError) {
      console.log(`No job submitter pods found for ${jobName}: ${jobError.message}`);
    }

    console.log(`Total ${allPods.length} pods found for RayJob ${jobName}`);

    res.json({
      success: true,
      pods: allPods
    });
  } catch (error) {
    console.error('Error fetching RayJob pods:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      pods: []
    });
  }
});

// 统一的训练作业 API - 合并 HyperPod 和 RayJob
app.get('/api/training-jobs', async (req, res) => {
  try {
    console.log('🔍 [API Call] /api/training-jobs requested from:', req.ip || req.connection.remoteAddress);

    const allJobs = [];

    // 获取 HyperPod 作业
    let hyperpodJobs = [];
    try {
      const hyperpodOutput = await executeKubectl('get hyperpodpytorchjob -o json');
      const hyperpodResult = JSON.parse(hyperpodOutput);
      hyperpodJobs = hyperpodResult.items.map(job => ({
        name: job.metadata.name,
        namespace: job.metadata.namespace || 'default',
        creationTimestamp: job.metadata.creationTimestamp,
        status: job.status || {},
        type: 'hyperpod',
        spec: {
          replicas: job.spec?.replicaSpecs?.[0]?.replicas || 0,
          nprocPerNode: job.spec?.nprocPerNode || 0
        }
      }));
    } catch (error) {
      console.log('No HyperPod jobs found:', error.message);
    }

    // 获取 RayJob 作业
    let rayJobs = [];
    try {
      const rayjobOutput = await executeKubectl('get rayjobs -o json');
      const rayjobResult = JSON.parse(rayjobOutput);
      rayJobs = rayjobResult.items.map(rayJob => {
        const workerReplicas = rayJob.spec?.rayClusterSpec?.workerGroupSpecs?.reduce((total, group) =>
          total + (group.replicas || 0), 0) || 0;
        const totalReplicas = workerReplicas + 1; // head + workers

        return {
          name: rayJob.metadata.name,
          namespace: rayJob.metadata.namespace || 'default',
          creationTimestamp: rayJob.metadata.creationTimestamp,
          status: rayJob.status || {},
          type: 'rayjob',
          spec: {
            replicas: totalReplicas
          }
        };
      });
    } catch (error) {
      console.log('No RayJobs found:', error.message);
    }

    // 合并所有作业
    allJobs.push(...hyperpodJobs, ...rayJobs);

    console.log(`Aggregated ${allJobs.length} training jobs:`, allJobs.map(j => `${j.name} (${j.type})`));

    res.json({
      success: true,
      jobs: allJobs
    });
  } catch (error) {
    console.error('Test aggregation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取所有HyperPod训练任务
// ❌ 已删除混合的 /api/training-jobs API，使用专门的 /api/hyperpod-jobs 和 /api/rayjobs

// 🔄 获取纯HyperPod训练任务（不包括RayJob）
app.get('/api/hyperpod-jobs', async (req, res) => {
  try {
    console.log('Fetching HyperPod PytorchJobs only...');

    // 只获取HyperPod PytorchJob
    let hyperpodJobs = [];
    try {
      const hyperpodOutput = await executeKubectl('get hyperpodpytorchjob -o json');
      const hyperpodResult = JSON.parse(hyperpodOutput);
      hyperpodJobs = hyperpodResult.items.map(job => ({
        name: job.metadata.name,
        namespace: job.metadata.namespace || 'default',
        creationTimestamp: job.metadata.creationTimestamp,
        status: job.status || {},
        type: 'hyperpod',
        spec: {
          replicas: job.spec?.replicaSpecs?.[0]?.replicas || 0,
          nprocPerNode: job.spec?.nprocPerNode || 0
        }
      }));
    } catch (error) {
      const optimizedMessage = optimizeErrorMessage(error.message);
      console.log('No HyperPod PytorchJobs found or error:', optimizedMessage);
    }

    console.log(`Found ${hyperpodJobs.length} HyperPod training jobs:`,
                hyperpodJobs.map(j => j.name));

    res.json({
      success: true,
      jobs: hyperpodJobs
    });
  } catch (error) {
    console.error('Error fetching HyperPod jobs:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      jobs: []
    });
  }
});

// 🔄 删除指定的HyperPod训练任务
app.delete('/api/hyperpod-jobs/:jobName', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Deleting training job: ${jobName}`);
    
    const output = await executeKubectl(`delete hyperpodpytorchjob ${jobName}`);
    console.log('Delete output:', output);
    
    // 广播删除状态更新
    broadcast({
      type: 'training_job_deleted',
      status: 'success',
      message: `Training job "${jobName}" deleted successfully`,
      jobName: jobName
    });
    
    res.json({
      success: true,
      message: `Training job "${jobName}" deleted successfully`,
      output: output
    });
  } catch (error) {
    console.error('Error deleting training job:', error);
    
    broadcast({
      type: 'training_job_deleted',
      status: 'error',
      message: `Failed to delete training job: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// MLflow配置管理

const CONFIG_FILE = path.join(__dirname, '../config/mlflow-metric-config.json');

// 确保配置目录存在
const configDir = path.dirname(CONFIG_FILE);
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 默认MLflow配置
const DEFAULT_MLFLOW_CONFIG = {
  tracking_uri: '',
  experiment_id: '',
  sync_configs: {}
};

// 读取MLflow配置
function readMlflowConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const configData = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(configData);
    }
  } catch (error) {
    console.error('Error reading MLflow config:', error);
  }
  return DEFAULT_MLFLOW_CONFIG;
}

// 保存MLflow配置
function saveMlflowConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving MLflow config:', error);
    return false;
  }
}

// 获取MLflow配置
app.get('/api/mlflow-metric-config', (req, res) => {
  try {
    const config = readMlflowConfig();
    res.json({
      success: true,
      config: config
    });
  } catch (error) {
    console.error('Error fetching MLflow config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 保存MLflow配置
app.post('/api/mlflow-metric-config', (req, res) => {
  try {
    const { tracking_uri } = req.body;
    
    if (!tracking_uri) {
      return res.status(400).json({
        success: false,
        error: 'tracking_uri is required'
      });
    }

    const config = { tracking_uri };
    
    if (saveMlflowConfig(config)) {
      console.log('MLflow config saved:', config);
      res.json({
        success: true,
        config: config
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to save configuration'
      });
    }
  } catch (error) {
    console.error('Error saving MLflow config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 测试MLflow连接
app.post('/api/mlflow-metric-config/test', async (req, res) => {
  try {
    const { tracking_uri } = req.body;
    
    if (!tracking_uri) {
      return res.status(400).json({
        success: false,
        error: 'tracking_uri is required'
      });
    }

    console.log(`Testing MLflow connection to: ${tracking_uri}`);
    
    const { spawn } = require('child_process');
    
    // 创建测试脚本
    const testScript = `#!/usr/bin/env python3
import mlflow
import sys
import json

try:
    tracking_uri = "${tracking_uri}"
    mlflow.set_tracking_uri(tracking_uri)
    
    # 尝试获取实验列表来测试连接
    experiments = mlflow.search_experiments()
    
    result = {
        "success": True,
        "experiments_count": len(experiments),
        "message": f"Successfully connected to MLflow. Found {len(experiments)} experiments."
    }
    
    print(json.dumps(result))
    sys.exit(0)
    
except Exception as e:
    result = {
        "success": False,
        "error": str(e)
    }
    print(json.dumps(result))
    sys.exit(1)
`;
    
    const tempScriptPath = path.join(__dirname, '../temp/test_mlflow_connection.py');
    
    // 确保temp目录存在
    const tempDir = path.dirname(tempScriptPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(tempScriptPath, testScript);
    
    const pythonPath = 'python3'; // 使用系统Python
    const pythonProcess = spawn(pythonPath, [tempScriptPath], {
      cwd: __dirname,
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      // 清理临时文件
      try {
        fs.unlinkSync(tempScriptPath);
      } catch (e) {
        console.warn('Failed to cleanup temp file:', e);
      }
      
      if (stderr) {
        console.log('Python test script stderr:', stderr);
      }
      
      try {
        const result = JSON.parse(stdout);
        if (result.success) {
          res.json(result);
        } else {
          res.status(400).json(result);
        }
      } catch (parseError) {
        console.error('Failed to parse test result:', parseError);
        console.error('Raw output:', stdout);
        res.status(500).json({
          success: false,
          error: 'Failed to test MLflow connection',
          details: stdout || stderr
        });
      }
    });
    
    pythonProcess.on('error', (error) => {
      console.error('Failed to start Python test script:', error);
      res.status(500).json({
        success: false,
        error: `Failed to start test script: ${error.message}`
      });
    });
    
  } catch (error) {
    console.error('MLflow connection test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// MLflow跨账户同步API
app.post('/api/mlflow-sync', async (req, res) => {
  try {
    const { sync_config, experiment_name, experiment_id } = req.body;
    
    // 支持两种参数格式以保持兼容性
    const experimentIdentifier = experiment_name || experiment_id;
    
    // 验证必需字段
    if (!sync_config || !experimentIdentifier) {
      return res.status(400).json({
        success: false,
        error: 'sync_config and experiment_name (or experiment_id) are required'
      });
    }

    // 验证JSON配置
    let configObj;
    try {
      configObj = JSON.parse(sync_config);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid JSON format in sync_config'
      });
    }

    // 验证必需的配置字段
    const requiredFields = ['contributor_name', 'source_mlflow_arn', 'shared_account_id', 'shared_aws_region', 'cross_account_role_arn', 'shared_mlflow_arn'];
    const missingFields = requiredFields.filter(field => !configObj[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields in sync_config: ${missingFields.join(', ')}`
      });
    }

    // 验证source和destination ARN不能相同
    if (configObj.source_mlflow_arn === configObj.shared_mlflow_arn) {
      return res.status(400).json({
        success: false,
        error: 'Source MLflow ARN and Shared MLflow ARN cannot be the same. Please ensure you are syncing to a different MLflow server.'
      });
    }

    // 添加时间戳
    configObj.setup_date = new Date().toISOString();

    console.log(`Starting MLflow sync for experiment ${experimentIdentifier}...`);
    
    // 1. 保存配置到mlflow-metric-config.json
    const currentConfig = readMlflowConfig();
    const updatedConfig = {
      ...currentConfig,
      experiment_name: experimentIdentifier,  // 改为experiment_name
      sync_configs: {
        ...configObj,
        last_sync: new Date().toISOString()
      }
    };
    
    if (!saveMlflowConfig(updatedConfig)) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save sync configuration'
      });
    }

    // 2. 创建临时配置文件供Python脚本使用
    const tempConfigPath = path.join(__dirname, '../temp/sync-config-temp.json');
    
    // 确保temp目录存在
    const tempDir = path.dirname(tempConfigPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    fs.writeFileSync(tempConfigPath, JSON.stringify(configObj, null, 2));

    // 3. 调用Python同步脚本
    const { spawn } = require('child_process');
    const pythonPath = 'python3'; // 使用系统Python
    const syncScriptPath = path.join(__dirname, '../mlflow/cross_account_sync.py');
    
    const pythonProcess = spawn(pythonPath, [
      syncScriptPath,
      '--config-file', tempConfigPath,
      '--experiment-name', experimentIdentifier
    ], {
      cwd: __dirname,
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      // 清理临时配置文件
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (e) {
        console.warn('Failed to cleanup temp config file:', e);
      }
      
      if (code === 0) {
        console.log('MLflow sync completed successfully');
        console.log('Sync output:', stdout);
        
        res.json({
          success: true,
          message: 'Successfully synced experiment to shared MLflow server',
          output: stdout,
          experiment_id: experimentIdentifier,
          contributor: configObj.contributor_name
        });
      } else {
        console.error('MLflow sync failed with code:', code);
        console.error('Sync stderr:', stderr);
        console.error('Sync stdout:', stdout);
        
        res.status(500).json({
          success: false,
          error: 'MLflow sync failed',
          details: stderr || stdout,
          exit_code: code
        });
      }
    });
    
    pythonProcess.on('error', (error) => {
      console.error('Failed to start MLflow sync script:', error);
      
      // 清理临时配置文件
      try {
        fs.unlinkSync(tempConfigPath);
      } catch (e) {
        console.warn('Failed to cleanup temp config file:', e);
      }
      
      res.status(500).json({
        success: false,
        error: `Failed to start sync script: ${error.message}`
      });
    });
    
  } catch (error) {
    console.error('MLflow sync API error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 配置MLflow认证 API
app.post('/api/configure-mlflow-auth', async (req, res) => {
  try {
    const MLflowTrackingServerManager = require('./utils/mlflowTrackingServerManager');
    const mlflowManager = new MLflowTrackingServerManager();
    
    // 配置MLflow认证
    const result = await mlflowManager.configureAuthentication();
    
    // 广播配置成功消息
    broadcast({
      type: 'mlflow_auth_configured',
      status: 'success',
      message: result.message
    });
    
    res.json({
      success: true,
      message: result.message
    });
    
  } catch (error) {
    console.error('Error configuring MLflow authentication:', error);
    
    // 广播配置失败消息
    broadcast({
      type: 'mlflow_auth_configured',
      status: 'error',
      message: `Failed to configure MLflow authentication: ${error.message}`
    });
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 创建MLflow Tracking Server API
app.post('/api/create-mlflow-tracking-server', async (req, res) => {
  try {
    const { mlflowServerName, trackingServerSize = 'Small' } = req.body;
    
    const MLflowTrackingServerManager = require('./utils/mlflowTrackingServerManager');
    const mlflowManager = new MLflowTrackingServerManager();
    
    // 验证输入参数
    mlflowManager.validateServerName(mlflowServerName);
    mlflowManager.validateServerSize(trackingServerSize);
    
    // 创建tracking server
    const result = await mlflowManager.createTrackingServer(mlflowServerName, trackingServerSize);
    
    // 广播创建成功消息
    broadcast({
      type: 'mlflow_tracking_server_created',
      status: 'success',
      message: result.message,
      serverName: mlflowServerName
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('Error creating MLflow tracking server:', error);
    
    // 广播创建失败消息
    broadcast({
      type: 'mlflow_tracking_server_created',
      status: 'error',
      message: error.message
    });
    
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 获取训练历史数据（从MLflow）
app.get('/api/training-history', async (req, res) => {
  try {
    console.log('Fetching training history from MLflow...');
    
    // 读取当前MLflow配置
    const mlflowConfig = readMlflowConfig();
    console.log('Using MLflow URI:', mlflowConfig.tracking_uri);
    
    const { spawn } = require('child_process');
    const path = require('path');
    
    // 使用系统Python执行脚本，传递配置参数
    const pythonPath = 'python3'; // 使用系统Python
    const scriptPath = path.join(__dirname, '../mlflow/get_training_history.py');
    
    const pythonProcess = spawn(pythonPath, [scriptPath, mlflowConfig.tracking_uri], {
      cwd: __dirname,
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    
    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    let responseHandled = false;
    
    pythonProcess.on('close', (code) => {
      if (responseHandled) return;
      
      if (stderr) {
        console.log('Python script stderr:', stderr);
      }
      
      if (code !== 0) {
        console.error(`Python script exited with code ${code}`);
        responseHandled = true;
        return res.status(500).json({ 
          success: false, 
          error: `Failed to fetch training history: exit code ${code}`,
          stderr: stderr
        });
      }
      
      try {
        const result = JSON.parse(stdout);
        console.log(`Training history fetched: ${result.total} records`);
        responseHandled = true;
        res.json(result);
      } catch (parseError) {
        console.error('Failed to parse Python script output:', parseError);
        console.error('Raw output:', stdout);
        responseHandled = true;
        res.status(500).json({ 
          success: false, 
          error: 'Failed to parse training history data',
          raw_output: stdout
        });
      }
    });
    
    pythonProcess.on('error', (error) => {
      if (responseHandled) return;
      
      console.error('Failed to start Python script:', error);
      responseHandled = true;
      res.status(500).json({ 
        success: false, 
        error: `Failed to start Python script: ${error.message}`
      });
    });
    
  } catch (error) {
    console.error('Training history fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 🔄 获取HyperPod训练任务关联的pods
app.get('/api/hyperpod-jobs/:jobName/pods', async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`Fetching pods for training job: ${jobName}`);
    
    // 获取所有pods，然后筛选出属于该训练任务的pods
    const output = await executeKubectl('get pods -o json');
    const result = JSON.parse(output);
    
    // 筛选出属于该训练任务的pods
    const trainingPods = result.items.filter(pod => {
      const labels = pod.metadata.labels || {};
      const ownerReferences = pod.metadata.ownerReferences || [];
      
      // 检查是否通过标签或ownerReferences关联到训练任务
      return labels['training-job-name'] === jobName || 
             labels['app'] === jobName ||
             ownerReferences.some(ref => ref.name === jobName) ||
             pod.metadata.name.includes(jobName);
    });
    
    const pods = trainingPods.map(pod => ({
      name: pod.metadata.name,
      namespace: pod.metadata.namespace || 'default',
      status: pod.status.phase,
      creationTimestamp: pod.metadata.creationTimestamp,
      nodeName: pod.spec.nodeName,
      containerStatuses: pod.status.containerStatuses || []
    }));
    
    console.log(`Found ${pods.length} pods for training job ${jobName}:`, pods.map(p => p.name));
    
    res.json({
      success: true,
      pods: pods
    });
  } catch (error) {
    console.error('Error fetching training job pods:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      pods: []
    });
  }
});

// 获取完整日志文件
app.get('/api/logs/:jobName/:podName', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = path.join(LOGS_BASE_DIR, jobName, `${podName}.log`);
    
    if (fs.existsSync(logFilePath)) {
      res.sendFile(path.resolve(logFilePath));
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Log file not found',
        path: logFilePath
      });
    }
  } catch (error) {
    console.error('Error serving log file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 下载完整日志文件
app.get('/api/logs/:jobName/:podName/download', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = path.join(LOGS_BASE_DIR, jobName, `${podName}.log`);
    
    if (fs.existsSync(logFilePath)) {
      res.download(logFilePath, `${podName}.log`, (err) => {
        if (err) {
          console.error('Error downloading log file:', err);
          res.status(500).json({ 
            success: false, 
            error: 'Failed to download log file' 
          });
        }
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Log file not found',
        path: logFilePath
      });
    }
  } catch (error) {
    console.error('Error downloading log file:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 获取日志文件信息
app.get('/api/logs/:jobName/:podName/info', (req, res) => {
  try {
    const { jobName, podName } = req.params;
    const logFilePath = path.join(LOGS_BASE_DIR, jobName, `${podName}.log`);
    
    if (fs.existsSync(logFilePath)) {
      const stats = fs.statSync(logFilePath);
      res.json({
        success: true,
        info: {
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime,
          path: logFilePath
        }
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Log file not found' 
      });
    }
  } catch (error) {
    console.error('Error getting log file info:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

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

    // 获取所有deployment
    const deploymentsOutput = await executeKubectl('get deployments -o json');
    const deployments = JSON.parse(deploymentsOutput);

    // 获取所有service
    const servicesOutput = await executeKubectl('get services -o json');
    const services = JSON.parse(servicesOutput);

    // 显示所有deployment，不进行过滤（包含Router）
    const allDeployments = deployments.items;

    // 为每个部署匹配对应的service
    const deploymentList = allDeployments.map(deployment => {
      const appLabel = deployment.metadata.labels?.app;
      const labels = deployment.metadata.labels || {};
      const deploymentName = deployment.metadata.name;

      // 检测部署类型：优先通过service-type标签识别Router
      const serviceType = labels['service-type'];
      const deploymentType = labels['deployment-type'] || labels['model-type'];

      let finalDeploymentType;
      if (serviceType === 'router') {
        finalDeploymentType = 'Router';
      } else if (deploymentType) {
        finalDeploymentType = deploymentType;
      } else {
        finalDeploymentType = 'Others';
      }

      // 匹配对应的service
      const matchingService = services.items.find(service => {
        // Router的service匹配逻辑：查找包含deployment名称的service
        if (finalDeploymentType === 'Router') {
          return service.metadata.name.includes(deploymentName) ||
                 service.spec.selector?.app === appLabel;
        }
        // 普通模型deployment的service匹配逻辑
        return service.spec.selector?.app === appLabel;
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
        isRouter: finalDeploymentType === 'Router'
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
    const fs = require('fs');
    const path = require('path');
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
    const creatingClusters = getCreatingHyperPodClusters();
    
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.stackName && clusterInfo.region) {
        try {
          const checkCmd = `aws cloudformation describe-stacks --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region} --query 'Stacks[0].StackStatus' --output text`;
          const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();
          
          if (stackStatus === 'CREATE_COMPLETE') {
            console.log(`[Auto-Check] HyperPod cluster ${clusterTag} creation completed, registering...`);
            await registerCompletedHyperPod(clusterTag);
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
            
            broadcast({
              type: 'hyperpod_creation_completed',
              status: 'success',
              message: `HyperPod cluster created successfully: ${clusterInfo.stackName}`,
              clusterTag: clusterTag
            });
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
  
  // 清理活跃的日志流
  if (activeLogStreams && activeLogStreams.size > 0) {
    console.log(`🧹 Cleaning up ${activeLogStreams.size} active log streams...`);
    activeLogStreams.clear();
    console.log('✅ Log streams cleaned up');
  }
  
  console.log('✅ Graceful shutdown completed');
  
  // 给一些时间让清理完成，然后退出
  setTimeout(() => {
    process.exit(signal === 'uncaughtException' || signal === 'unhandledRejection' ? 1 : 0);
  }, 1000);
}

// 启动pod日志流
function startLogStream(ws, jobName, podName) {
  const streamKey = `${jobName}-${podName}`;
  
  // 如果已经有该pod的日志流，先停止它
  if (activeLogStreams.has(streamKey)) {
    stopLogStream(ws, jobName, podName);
  }
  
  console.log(`Starting log stream for pod: ${podName} in job: ${jobName}`);
  
  // 创建日志文件路径
  const logFilePath = ensureLogDirectory(jobName, podName);
  const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  
  // 启动kubectl logs命令
  const logProcess = spawn('kubectl', ['logs', '-f', podName], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  // 存储进程引用和文件流
  activeLogStreams.set(streamKey, {
    process: logProcess,
    logStream: logStream,
    ws: ws,
    jobName: jobName,
    podName: podName
  });
  
  // 处理标准输出
  logProcess.stdout.on('data', (data) => {
    const logLine = data.toString();
    const timestamp = new Date().toISOString();
    
    // 写入文件（带时间戳）
    logStream.write(`[${timestamp}] ${logLine}`);
    
    // 发送到前端
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_data',
        jobName: jobName,
        podName: podName,
        data: logLine,
        timestamp: timestamp
      }));
    }
  });
  
  // 处理标准错误
  logProcess.stderr.on('data', (data) => {
    const errorLine = data.toString();
    const timestamp = new Date().toISOString();
    
    console.error(`Log stream error for ${podName}:`, errorLine);
    
    // 写入错误到文件
    logStream.write(`[${timestamp}] ERROR: ${errorLine}`);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_error',
        jobName: jobName,
        podName: podName,
        error: errorLine,
        timestamp: timestamp
      }));
    }
  });
  
  // 处理进程退出
  logProcess.on('close', (code) => {
    console.log(`Log stream for ${podName} closed with code: ${code}`);
    
    // 关闭文件流
    logStream.end();
    activeLogStreams.delete(streamKey);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_closed',
        jobName: jobName,
        podName: podName,
        code: code,
        timestamp: new Date().toISOString()
      }));
    }
  });
  
  // 处理进程错误
  logProcess.on('error', (error) => {
    console.error(`Log stream process error for ${podName}:`, error);
    
    // 关闭文件流
    logStream.end();
    activeLogStreams.delete(streamKey);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_error',
        jobName: jobName,
        podName: podName,
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  });
}

// 停止特定pod的日志流
function stopLogStream(ws, jobName, podName) {
  const streamKey = `${jobName}-${podName}`;
  const streamInfo = activeLogStreams.get(streamKey);
  
  if (streamInfo) {
    console.log(`Stopping log stream for pod: ${podName}`);
    streamInfo.process.kill('SIGTERM');
    
    // 关闭文件流
    if (streamInfo.logStream) {
      streamInfo.logStream.end();
    }
    
    activeLogStreams.delete(streamKey);
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'log_stream_stopped',
        jobName: jobName,
        podName: podName,
        timestamp: new Date().toISOString()
      }));
    }
  }
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
app.get('/api/s3-storage-defaults', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    let defaultBucket = '';
    
    // 从容器中的 /s3-workspace-metadata 路径读取默认bucket
    try {
      const metadataPath = '/s3-workspace-metadata';
      const bucketInfoPath = path.join(metadataPath, 'CURRENT_BUCKET_INFO');

      if (fs.existsSync(bucketInfoPath)) {
        const bucketInfoContent = fs.readFileSync(bucketInfoPath, 'utf8');
        const bucketInfo = JSON.parse(bucketInfoContent);
        defaultBucket = bucketInfo.bucketName;
        console.log('Successfully read bucket info from CURRENT_BUCKET_INFO:', bucketInfo.bucketName);
      } else {
        console.log('CURRENT_BUCKET_INFO file not found at:', bucketInfoPath);
      }
    } catch (error) {
      console.log('Could not read s3-workspace-metadata:', error.message);
    }
    
    res.json({
      success: true,
      defaults: {
        name: 's3-claim',
        bucketName: defaultBucket,
        region: 'us-west-2'
      }
    });
  } catch (error) {
    console.error('Error getting S3 storage defaults:', error);
    res.json({
      success: false,
      error: error.message,
      defaults: {
        name: 's3-claim',
        bucketName: '',
        region: 'us-west-2'
      }
    });
  }
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
  try {
    const { modelId, hfToken, resources, s3Storage } = req.body;
    
    if (!modelId) {
      return res.json({ success: false, error: 'Model ID is required' });
    }

    console.log(`🚀 Starting enhanced model download: ${modelId}`);
    console.log(`📊 Resources: CPU=${resources.cpu}, Memory=${resources.memory}GB`);
    console.log(`💾 S3 Storage: ${s3Storage}`);

    // 生成增强的下载Job
    const jobResult = await s3StorageManager.generateEnhancedDownloadJob({
      modelId,
      hfToken,
      resources,
      s3Storage
    });

    if (!jobResult.success) {
      return res.json({ success: false, error: jobResult.error });
    }

    // 确保deployments目录存在
    const deploymentsDir = path.join(__dirname, '..', 'deployments');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    
    // 保存生成的YAML文件到deployments目录
    const modelTag = modelId.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const deploymentFile = path.join(deploymentsDir, `enhanced-model-download-${modelTag}-${timestamp}.yaml`);
    await fs.writeFile(deploymentFile, jobResult.yamlContent);
    
    console.log(`📁 Saved deployment template: ${deploymentFile}`);

    // 应用Job到Kubernetes
    const tempFile = `/tmp/enhanced-download-job-${Date.now()}.yaml`;
    fs.writeFileSync(tempFile, jobResult.yamlContent);

    exec(`kubectl apply -f ${tempFile}`, (error, stdout, stderr) => {
      fs.removeSync(tempFile);
      
      if (error) {
        console.error('❌ Failed to create enhanced download job:', stderr);
        broadcast({
          type: 'model_download',
          status: 'error',
          message: `Failed to start enhanced model download: ${stderr}`
        });
        return res.json({ success: false, error: stderr });
      }

      console.log('✅ Enhanced model download job created successfully');
      broadcast({
        type: 'model_download',
        status: 'success',
        message: `Enhanced model download started: ${modelId}`,
        jobName: jobResult.jobName
      });

      res.json({ 
        success: true, 
        message: 'Enhanced model download job created successfully',
        jobName: jobResult.jobName,
        deploymentFile: path.basename(deploymentFile)
      });
    });

  } catch (error) {
    console.error('❌ Error in enhanced model download:', error);
    res.json({ success: false, error: error.message });
  }
});

// 模型下载API
app.post('/api/download-model', async (req, res) => {
  try {
    const { modelId, hfToken } = req.body;
    
    if (!modelId) {
      return res.json({ success: false, error: 'Model ID is required' });
    }
    
    console.log(`Starting model download for: ${modelId}`);
    
    // 读取HF下载模板
    const templatePath = path.join(__dirname, '..', 'templates', 'hf-download-template.yaml');
    let template = await fs.readFile(templatePath, 'utf8');
    
    // 生成模型标签
    const modelTag = generateModelTag(modelId);
    
    // 替换基本变量
    const replacements = {
      'HF_MODEL_ID': modelId,
      'MODEL_TAG': modelTag
    };
    
    // 处理HF Token环境变量
    if (hfToken && hfToken.trim()) {
      const tokenEnv = `
        - name: HF_TOKEN
          value: "${hfToken.trim()}"`;
      template = template.replace('env:HF_TOKEN_ENV', `env:${tokenEnv}`);
      
      // 同时在hf download命令中启用token
      template = template.replace('#  --token=$HF_TOKEN', '          --token=$HF_TOKEN \\');
    } else {
      // 移除HF_TOKEN_ENV占位符，保留其他环境变量
      template = template.replace('      env:HF_TOKEN_ENV', '      env:');
    }
    
    // 替换其他变量
    Object.keys(replacements).forEach(key => {
      const regex = new RegExp(key, 'g');
      template = template.replace(regex, replacements[key]);
    });
    
    // 确保deployments目录存在
    const deploymentsDir = path.join(__dirname, '..', 'deployments');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }
    
    // 保存生成的YAML文件
    const deploymentFile = path.join(deploymentsDir, `model-download-${modelTag}.yaml`);
    await fs.writeFile(deploymentFile, template);
    
    console.log(`Generated deployment file: ${deploymentFile}`);
    
    // 应用到Kubernetes
    try {
      const result = await executeKubectl(`apply -f "${deploymentFile}"`);
      console.log('kubectl apply result:', result);
      
      // 广播部署状态更新
      broadcast({
        type: 'model_download',
        status: 'success',
        message: `Model download started for ${modelId}`,
        modelId: modelId,
        modelTag: modelTag
      });
      
      res.json({ 
        success: true, 
        message: `Model download initiated for ${modelId}`,
        modelTag: modelTag
      });
      
    } catch (kubectlError) {
      console.error('kubectl apply error:', kubectlError);
      res.json({ 
        success: false, 
        error: `Failed to apply deployment: ${kubectlError.error || kubectlError}` 
      });
    }
    
  } catch (error) {
    console.error('Model download error:', error);
    res.json({ success: false, error: error.message });
  }
});

// S3存储信息API - 从s3-pv PersistentVolume获取桶信息
app.get('/api/s3-storage', async (req, res) => {
  try {
    const { storage } = req.query;
    console.log(`📦 Fetching S3 storage content for: ${storage || 'default'}`);
    
    // 获取存储配置
    const storageResult = await s3StorageManager.getStorages();
    if (!storageResult.success) {
      return res.json({ success: false, error: 'Failed to get storage configurations' });
    }
    
    // 找到对应的存储配置
    const selectedStorage = storageResult.storages.find(s => s.pvcName === storage) || 
                           storageResult.storages.find(s => s.pvcName === 's3-claim') ||
                           storageResult.storages[0];
    
    if (!selectedStorage) {
      return res.json({ 
        success: true, 
        data: [], 
        bucketInfo: { bucket: 'No storage configured', region: 'Unknown' }
      });
    }
    
    console.log(`📦 Using storage: ${selectedStorage.name} -> ${selectedStorage.bucketName}`);
    
    // 使用AWS CLI获取S3内容
    let s3Data = [];
    const region = selectedStorage.region || 'us-west-2';
    const awsCommand = `aws s3 ls s3://${selectedStorage.bucketName}/ --region ${region}`;
    
    console.log(`🔍 Executing: ${awsCommand}`);
    
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      const { stdout, stderr } = await execAsync(awsCommand);
      
      if (stderr) {
        console.warn('AWS CLI stderr:', stderr);
      }
      
      console.log('AWS CLI stdout:', stdout);
      
      if (stdout) {
        const lines = stdout.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          if (trimmed.startsWith('PRE ')) {
            // 文件夹格式: "PRE folder-name/"
            const folderName = trimmed.substring(4); // 去掉 "PRE "
            s3Data.push({
              key: folderName,
              type: 'folder',
              size: null,
              lastModified: new Date().toISOString()
            });
          } else {
            // 文件格式: "2025-08-15 09:18:57 0 filename"
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 4) {
              const date = parts[0];
              const time = parts[1];
              const size = parts[2];
              const name = parts.slice(3).join(' ');
              
              s3Data.push({
                key: name,
                type: 'file',
                size: parseInt(size) || 0,
                lastModified: new Date(`${date} ${time}`).toISOString(),
                storageClass: 'STANDARD'
              });
            }
          }
        }
      }
      
      console.log(`📊 Found ${s3Data.length} items in S3`);
      
    } catch (awsError) {
      console.error('AWS CLI error:', awsError);
      throw new Error(`Failed to list S3 contents: ${awsError.message}`);
    }
    
    res.json({
      success: true,
      data: s3Data,
      bucketInfo: {
        bucket: selectedStorage.bucketName,
        region: selectedStorage.region || 'Unknown',
        pvcName: selectedStorage.pvcName
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching S3 storage:', error);
    res.json({ success: false, error: error.message });
  }
});
app.get('/api/cluster/mlflow-info', (req, res) => {
  try {
    // 使用多集群管理器获取活跃集群的MLflow信息
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeCluster = clusterManager.getActiveCluster();
    
    if (!activeCluster) {
      return res.json({
        success: false,
        error: 'No active cluster found'
      });
    }

    // 从活跃集群的配置目录读取MLflow信息
    const configDir = clusterManager.getClusterConfigDir(activeCluster);
    const mlflowInfoPath = path.join(configDir, 'mlflow-server-info.json');
    
    if (fs.existsSync(mlflowInfoPath)) {
      const fileContent = fs.readFileSync(mlflowInfoPath, 'utf8').trim();
      
      // 检查文件是否为空
      if (!fileContent) {
        return res.json({
          success: true,
          data: {
            status: 'not_found',
            error: 'MLflow server info file is empty',
            clusterTag: activeCluster
          }
        });
      }
      
      let mlflowInfo;
      try {
        mlflowInfo = JSON.parse(fileContent);
      } catch (parseError) {
        return res.json({
          success: true,
          data: {
            status: 'error',
            error: 'Invalid JSON in MLflow server info file',
            clusterTag: activeCluster
          }
        });
      }
      
      // 检查解析后的对象是否为空或无效
      if (!mlflowInfo || Object.keys(mlflowInfo).length === 0) {
        return res.json({
          success: true,
          data: {
            status: 'not_found',
            error: 'MLflow server info is empty',
            clusterTag: activeCluster
          }
        });
      }
      
      // 返回前端期望的数据结构
      res.json({
        success: true,
        data: {
          status: 'found',
          trackingServerArn: mlflowInfo.TrackingServerArn,
          trackingServerName: mlflowInfo.TrackingServerName,
          trackingServerUrl: mlflowInfo.TrackingServerUrl,
          trackingServerStatus: mlflowInfo.TrackingServerStatus,
          isActive: mlflowInfo.IsActive,
          mlflowVersion: mlflowInfo.MlflowVersion,
          artifactStoreUri: mlflowInfo.ArtifactStoreUri,
          trackingServerSize: mlflowInfo.TrackingServerSize,
          roleArn: mlflowInfo.RoleArn,
          creationTime: mlflowInfo.CreationTime,
          clusterTag: activeCluster,
          rawData: mlflowInfo // 保留原始数据以备调试
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          status: 'not_found',
          error: `MLflow server info not found for cluster: ${activeCluster}`,
          clusterTag: activeCluster
        }
      });
    }
  } catch (error) {
    console.error('Error reading MLflow server info:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
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
        karpenter: []
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

    // 3. 获取 Karpenter NodePool 实例类型
    try {
      const nodePoolsJson = execSync('kubectl get nodepool -o json', { encoding: 'utf8', timeout: 10000 });
      const nodePoolsData = JSON.parse(nodePoolsJson);

      nodePoolsData.items.forEach(nodePool => {
        const nodePoolName = nodePool.metadata.name;
        const requirements = nodePool.spec.template.spec.requirements || [];

        // 查找instance-type requirement
        const instanceTypeReq = requirements.find(req =>
          req.key === 'node.kubernetes.io/instance-type'
        );

        if (instanceTypeReq && instanceTypeReq.values) {
          instanceTypeReq.values.forEach(instanceType => {
            if (!instanceType.startsWith('ml.')) {
              result.data.karpenter.push({
                type: instanceType,
                nodePool: nodePoolName,
                available: true
              });
            }
          });
        }
      });

      console.log(`Found ${result.data.karpenter.length} Karpenter instance types`);
    } catch (error) {
      console.warn('Error fetching Karpenter instance types:', error.message);
    }

    console.log('Cluster available instance types result:', JSON.stringify(result, null, 2));
    res.json(result);

  } catch (error) {
    console.error('Error fetching cluster available instance types:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 清除状态缓存 API

// 获取 Step 1 状态 API

// 获取日志内容 API
// 旧的日志API - 已被多集群API替代
/*
app.get('/api/cluster/logs/:step', (req, res) => {
  try {
    const { step } = req.params;
    const { offset = 0 } = req.query;
    
    const logContent = logManager.getCurrentLogContent(step);
    const statusFile = path.join(logManager.metadataDir, `${step}_status.json`);
    
    let status = { status: 'idle' };
    if (fs.existsSync(statusFile)) {
      status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    }

    // 支持增量读取（从指定偏移量开始）
    const newContent = logContent.slice(parseInt(offset));
    
    res.json({
      success: true,
      data: {
        content: newContent,
        fullContent: logContent,
        totalLength: logContent.length,
        status: status.status,
        timestamp: status.timestamp,
        logId: status.logId
      }
    });

  } catch (error) {
    console.error('Error reading logs:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});
*/

// 获取历史日志列表
app.get('/api/cluster/logs-history', (req, res) => {
  try {
    const logFiles = fs.readdirSync(logManager.logsDir)
      .filter(file => file.endsWith('.log'))
      .map(file => {
        const filePath = path.join(logManager.logsDir, file);
        const stats = fs.statSync(filePath);
        const [timestamp, step] = file.replace('.log', '').split('_');
        
        return {
          filename: file,
          step: step,
          timestamp: timestamp.replace(/_/g, 'T').replace(/-/g, ':'),
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      success: true,
      data: logFiles
    });

  } catch (error) {
    console.error('Error getting log history:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// 获取 CloudFormation 堆栈状态 - 从 init_envs 自动读取堆栈名称
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

// 节点组管理API
app.get('/api/cluster/nodegroups', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');
    const path = require('path');
    
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration file not found' });
    }

    // 解析init_envs文件 - 使用shell source方式
    const getEnvVar = async (varName) => {
      const cmd = `source ${initEnvsPath} && echo $${varName}`;
      const result = await execAsync(cmd, { shell: '/bin/bash' });
      return result.stdout.trim();
    };
    
    const clusterName = await getEnvVar('EKS_CLUSTER_NAME') || activeClusterName;
    const region = await getEnvVar('AWS_REGION') || 'us-west-2';
    
    // 获取EKS节点组
    const eksCmd = `aws eks list-nodegroups --cluster-name ${clusterName} --region ${region} --output json`;
    const eksResult = await execAsync(eksCmd);
    const eksData = JSON.parse(eksResult.stdout);
    
    const eksNodeGroups = [];
    for (const nodegroupName of eksData.nodegroups || []) {
      const detailCmd = `aws eks describe-nodegroup --cluster-name ${clusterName} --nodegroup-name ${nodegroupName} --region ${region} --output json`;
      const detailResult = await execAsync(detailCmd);
      const nodegroup = JSON.parse(detailResult.stdout).nodegroup;
      
      // 获取实例类型，如果为null则从Launch Template获取
      let instanceTypes = nodegroup.instanceTypes;
      if (!instanceTypes || instanceTypes.length === 0) {
        try {
          if (nodegroup.launchTemplate && nodegroup.launchTemplate.id) {
            const ltCmd = `aws ec2 describe-launch-template-versions --launch-template-id ${nodegroup.launchTemplate.id} --region ${region} --query 'LaunchTemplateVersions[0].LaunchTemplateData.InstanceType' --output json`;
            const ltResult = await execAsync(ltCmd);
            const instanceType = JSON.parse(ltResult.stdout);
            if (instanceType) {
              instanceTypes = [instanceType];
            }
          }
        } catch (ltError) {
          console.warn('Failed to get instance type from launch template:', ltError.message);
        }
      }
      
      eksNodeGroups.push({
        name: nodegroup.nodegroupName,
        status: nodegroup.status,
        instanceTypes: instanceTypes || [],
        capacityType: nodegroup.capacityType,
        scalingConfig: nodegroup.scalingConfig,
        amiType: nodegroup.amiType,
        subnets: nodegroup.subnets,
        nodeRole: nodegroup.nodeRole
      });
    }
    
    // 获取HyperPod实例组 - 优先使用userCreated，然后使用detected
    const hyperPodGroups = [];
    
    try {
      // 从metadata中获取HyperPod集群信息
      const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
      
      if (fs.existsSync(clusterInfoPath)) {
        const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
        
        // 使用新的hyperPodCluster结构，动态获取最新状态
        if (clusterInfo.hyperPodCluster) {
          const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
          console.log(`Found HyperPod cluster: ${hpClusterName}, fetching latest status...`);
          
          try {
            // 使用AWS Helper动态获取最新的HyperPod集群状态
            const AWSHelpers = require('./utils/awsHelpers');
            const hpData = await AWSHelpers.describeHyperPodCluster(hpClusterName, region);
            
            for (const instanceGroup of hpData.InstanceGroups || []) {
              // 判断 Capacity Type: 如果有 CapacityRequirements.Spot 则为 Spot，否则为 On-Demand
              let capacityType = 'on-demand';
              if (instanceGroup.CapacityRequirements?.Spot) {
                capacityType = 'spot';
              }
              
              hyperPodGroups.push({
                clusterName: hpData.ClusterName,
                clusterArn: hpData.ClusterArn,
                clusterStatus: hpData.ClusterStatus, // 添加集群级别状态
                name: instanceGroup.InstanceGroupName,
                status: instanceGroup.Status,
                instanceType: instanceGroup.InstanceType,
                capacityType: capacityType, // 添加容量类型
                currentCount: instanceGroup.CurrentCount,
                targetCount: instanceGroup.TargetCount,
                executionRole: instanceGroup.ExecutionRole
              });
            }
          } catch (hpError) {
            console.warn(`Failed to get latest HyperPod cluster status for ${hpClusterName}:`, hpError.message);
          }
        } else {
          console.log('No HyperPod cluster found in metadata');
        }
      } else {
        console.log('No cluster metadata found, no HyperPod clusters available');
      }
      
    } catch (hpError) {
      console.log('Error reading HyperPod cluster metadata:', hpError.message);
    }
    
    console.log(`Returning ${hyperPodGroups.length} HyperPod instance groups`);
    
    res.json({
      eksNodeGroups,
      hyperPodGroups: hyperPodGroups
    });
  } catch (error) {
    console.error('Error fetching node groups:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/cluster/nodegroups/:name/scale', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');
    const path = require('path');
    
    const { name } = req.params;
    const { minSize, maxSize, desiredSize } = req.body;
    
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration file not found' });
    }

    // 解析init_envs文件 - 使用shell source方式
    const getEnvVar = async (varName) => {
      const cmd = `source ${initEnvsPath} && echo $${varName}`;
      const result = await execAsync(cmd, { shell: '/bin/bash' });
      return result.stdout.trim();
    };
    
    const clusterName = await getEnvVar('EKS_CLUSTER_NAME') || activeClusterName;
    const region = await getEnvVar('AWS_REGION') || 'us-west-2';
    
    const cmd = `aws eks update-nodegroup-config --cluster-name ${clusterName} --nodegroup-name ${name} --scaling-config minSize=${minSize},maxSize=${maxSize},desiredSize=${desiredSize} --region ${region}`;
    
    await execAsync(cmd);
    
    // WebSocket通知
    broadcast({
      type: 'nodegroup_updated',
      status: 'success',
      message: `EKS node group ${name} scaling updated successfully`
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating EKS node group:', error);
    broadcast({
      type: 'nodegroup_updated',
      status: 'error',
      message: `Failed to update EKS node group: ${error.message}`
    });
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/cluster/hyperpod/instances/:name/scale', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');
    const path = require('path');
    
    const { name } = req.params;
    const { targetCount } = req.body;
    
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration file not found' });
    }

    // 解析init_envs文件 - 使用shell source方式
    const getEnvVar = async (varName) => {
      const cmd = `source ${initEnvsPath} && echo $${varName}`;
      const result = await execAsync(cmd, { shell: '/bin/bash' });
      return result.stdout.trim();
    };
    
    const region = await getEnvVar('AWS_REGION') || 'us-west-2';
    
    // 从 cluster_info.json 中获取实际的 HyperPod 集群名称
    const clusterInfo = await clusterManager.getClusterInfo(activeClusterName);
    if (!clusterInfo) {
      return res.status(400).json({ error: 'Cluster info not found' });
    }
    
    // 使用新的hyperPodCluster结构
    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found for this EKS cluster' });
    }
    
    const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
    
    // 动态获取当前实例组的完整配置
    const getCmd = `aws sagemaker describe-cluster --cluster-name ${hpClusterName} --region ${region}`;
    const getResult = await execAsync(getCmd);
    const clusterData = JSON.parse(getResult.stdout);
    
    // 找到要更新的实例组
    const instanceGroup = clusterData.InstanceGroups.find(ig => ig.InstanceGroupName === name);
    if (!instanceGroup) {
      throw new Error(`Instance group ${name} not found`);
    }
    
    // 根据AWS CLI文档，update-cluster支持的字段
    const allowedFields = [
      'InstanceCount', 'InstanceGroupName', 'InstanceType', 'LifeCycleConfig',
      'ExecutionRole', 'ThreadsPerCore', 'InstanceStorageConfigs', 
      'OnStartDeepHealthChecks', 'TrainingPlanArn', 'OverrideVpcConfig', 
      'ScheduledUpdateConfig', 'ImageId'
    ];
    
    // 构建更新配置，只保留允许的字段
    const updateInstanceGroup = {};
    allowedFields.forEach(field => {
      if (instanceGroup.hasOwnProperty(field)) {
        updateInstanceGroup[field] = instanceGroup[field];
      }
    });
    
    // 修改InstanceCount为目标值
    updateInstanceGroup.InstanceCount = targetCount;
    
    const cmd = `aws sagemaker update-cluster --cluster-name ${hpClusterName} --instance-groups '${JSON.stringify(updateInstanceGroup)}' --region ${region}`;
    
    console.log('Executing HyperPod scaling command:', cmd);
    console.log('Update instance group object:', JSON.stringify(updateInstanceGroup, null, 2));
    
    await execAsync(cmd);
    
    // WebSocket通知
    broadcast({
      type: 'nodegroup_updated',
      status: 'success',
      message: `HyperPod instance group ${name} scaling updated successfully`
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating HyperPod instance group:', error);
    broadcast({
      type: 'nodegroup_updated',
      status: 'error',
      message: `Failed to update HyperPod instance group: ${error.message}`
    });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cluster/hyperpod/update-software', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');
    const path = require('path');
    
    const { clusterArn } = req.body;
    
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件获取region
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration file not found' });
    }

    // 解析init_envs文件 - 使用shell source方式
    const getEnvVar = async (varName) => {
      const cmd = `source ${initEnvsPath} && echo $${varName}`;
      const result = await execAsync(cmd, { shell: '/bin/bash' });
      return result.stdout.trim();
    };
    
    const region = await getEnvVar('AWS_REGION') || 'us-west-2';

    // 执行update-cluster-software命令
    const updateCmd = `aws sagemaker update-cluster-software --cluster-name ${clusterArn} --region ${region}`;
    
    await execAsync(updateCmd);
    
    broadcast({
      type: 'hyperpod_software_update',
      status: 'success',
      message: '✅ HyperPod cluster software update started successfully',
      clusterArn: clusterArn
    });

    res.json({ success: true, message: 'Cluster software update initiated successfully' });
  } catch (error) {
    console.error('Error updating HyperPod cluster software:', error);
    
    broadcast({
      type: 'hyperpod_software_update',
      status: 'error',
      message: `❌ HyperPod software update failed: ${error.message}`
    });

    res.status(500).json({ error: error.message });
  }
});

// 添加实例组到现有HyperPod集群
app.post('/api/cluster/hyperpod/add-instance-group', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');
    const path = require('path');
    
    const { userConfig } = req.body;
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration not found' });
    }

    // 解析环境变量
    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
    const region = awsRegionMatch ? awsRegionMatch[1] : 'us-west-2';

    // 从metadata中获取HyperPod集群信息
    const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      return res.status(400).json({ error: 'Cluster metadata not found' });
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    // 使用新的hyperPodCluster结构
    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found' });
    }

    const hyperPodCluster = clusterInfo.hyperPodCluster;
    
    // 获取现有集群的详细信息
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`;
    const describeResult = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeResult.stdout);

    // 清理现有实例组的运行时字段，只保留配置字段
    const cleanInstanceGroup = (instanceGroup) => {
      const cleaned = {
        InstanceCount: instanceGroup.TargetCount, // 使用TargetCount作为期望数量
        InstanceGroupName: instanceGroup.InstanceGroupName,
        InstanceType: instanceGroup.InstanceType,
        LifeCycleConfig: instanceGroup.LifeCycleConfig,
        ExecutionRole: instanceGroup.ExecutionRole,
        ThreadsPerCore: instanceGroup.ThreadsPerCore,
        InstanceStorageConfigs: instanceGroup.InstanceStorageConfigs
      };

      // 如果有TrainingPlanArn，保留它
      if (instanceGroup.TrainingPlanArn) {
        cleaned.TrainingPlanArn = instanceGroup.TrainingPlanArn;
      }

      return cleaned;
    };

    // 构建新的实例组配置
    const newInstanceGroup = {
      InstanceCount: userConfig.instanceCount,
      InstanceGroupName: userConfig.instanceGroupName,
      InstanceType: userConfig.instanceType,
      LifeCycleConfig: clusterData.InstanceGroups[0]?.LifeCycleConfig,
      ExecutionRole: clusterData.InstanceGroups[0]?.ExecutionRole,
      ThreadsPerCore: shouldUseThreadsPerCore2(userConfig.instanceType, userConfig.trainingPlanArn) ? 2 : 1,
      InstanceStorageConfigs: [
        {
          EbsVolumeConfig: {
            VolumeSizeInGB: userConfig.volumeSize,
            RootVolume: false
          }
        }
      ]
    };

    // 如果是 Spot 实例，添加 CapacityRequirements
    if (userConfig.isSpot) {
      newInstanceGroup.CapacityRequirements = { Spot: {} };
    }

    // 如果指定了 subnet，添加 OverrideVpcConfig
    if (userConfig.subnetId) {
      // 获取 SecurityGroupId
      const securityGroupId = clusterData.VpcConfig?.SecurityGroupIds?.[0] || 
                             clusterInfo.eksCluster?.securityGroupId;
      
      newInstanceGroup.OverrideVpcConfig = {
        SecurityGroupIds: [securityGroupId],
        Subnets: [userConfig.subnetId]
      };
    }

    // 如果有TrainingPlanArn，添加到新实例组配置中
    if (userConfig.trainingPlanArn) {
      newInstanceGroup.TrainingPlanArn = userConfig.trainingPlanArn;
    }

    // 构建完整的实例组配置（现有的 + 新的）
    const instanceGroupConfig = {
      ClusterName: hyperPodCluster.ClusterName,
      InstanceGroups: [
        ...clusterData.InstanceGroups.map(cleanInstanceGroup), // 现有的实例组
        newInstanceGroup // 新的实例组
      ]
    };

    console.log('Generated instance group config:', JSON.stringify(instanceGroupConfig, null, 2));

    // 创建临时配置文件
    const tempConfigPath = path.join(configDir, 'temp-instance-group-config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(instanceGroupConfig, null, 2));

    // 调用AWS CLI添加实例组
    const addCmd = `aws sagemaker update-cluster --cli-input-json file://${tempConfigPath} --region ${region}`;
    const addResult = await execAsync(addCmd);

    // 清理临时文件
    fs.unlinkSync(tempConfigPath);

    console.log('Instance group addition result:', addResult.stdout);

    res.json({ 
      success: true, 
      message: 'Instance group addition initiated successfully',
      config: instanceGroupConfig
    });

  } catch (error) {
    console.error('Error adding instance group:', error);
    res.status(500).json({ error: error.message });
  }
});

// 删除HyperPod集群的实例组
app.post('/api/cluster/hyperpod/delete-instance-group', async (req, res) => {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const fs = require('fs');
    const path = require('path');
    
    const { instanceGroupName } = req.body;
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    if (!instanceGroupName) {
      return res.status(400).json({ error: 'Instance group name is required' });
    }

    // 读取集群配置文件
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration not found' });
    }

    // 解析环境变量
    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
    const region = awsRegionMatch ? awsRegionMatch[1] : 'us-west-2';

    // 从metadata中获取HyperPod集群信息
    const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      return res.status(400).json({ error: 'Cluster metadata not found' });
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    // 使用新的hyperPodCluster结构
    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found' });
    }

    const hyperPodCluster = clusterInfo.hyperPodCluster;
    
    console.log(`Deleting instance group "${instanceGroupName}" from cluster "${hyperPodCluster.ClusterName}"`);

    // 调用AWS CLI删除实例组
    const deleteCmd = `aws sagemaker update-cluster --cluster-name ${hyperPodCluster.ClusterName} --instance-groups-to-delete ${instanceGroupName} --region ${region}`;
    const deleteResult = await execAsync(deleteCmd);

    console.log('Instance group deletion result:', deleteResult.stdout);

    res.json({ 
      success: true, 
      message: `Instance group "${instanceGroupName}" deletion initiated successfully`
    });

  } catch (error) {
    console.error('Error deleting instance group:', error);
    res.status(500).json({ error: error.message });
  }
});

console.log('Multi-cluster management APIs loaded');

// 引入CIDR生成工具
const CidrGenerator = require('./utils/cidrGenerator');
const CloudFormationManager = require('./utils/cloudFormationManager');
const ClusterDependencyManager = require('./utils/clusterDependencyManager');
const ClusterManager = require('./cluster-manager');
const clusterManager = new ClusterManager();

// CIDR生成相关API
app.get('/api/cluster/generate-cidr', async (req, res) => {
  try {
    const { region, excludeCidr } = req.query;
    
    if (!region) {
      return res.status(400).json({ error: 'AWS region is required' });
    }
    
    const cidr = await CidrGenerator.generateUniqueCidr(region, excludeCidr);
    
    res.json({
      success: true,
      cidr,
      region,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error generating CIDR:', error);
    res.status(500).json({ error: error.message });
  }
});

// 生成完整CIDR配置
app.post('/api/cluster/generate-cidr-config', async (req, res) => {
  try {
    const { region, customVpcCidr } = req.body;
    
    if (!region) {
      return res.status(400).json({ error: 'AWS region is required' });
    }
    
    const cidrConfig = await CidrGenerator.generateFullCidrConfiguration(region, customVpcCidr);
    
    res.json({
      success: true,
      ...cidrConfig
    });
  } catch (error) {
    console.error('Error generating CIDR configuration:', error);
    res.status(500).json({ error: error.message });
  }
});

// 验证CIDR格式和冲突
app.post('/api/cluster/validate-cidr', async (req, res) => {
  try {
    const { cidr, region } = req.body;
    
    if (!cidr || !region) {
      return res.status(400).json({ error: 'CIDR and region are required' });
    }
    
    // 验证格式
    const isValidFormat = CidrGenerator.validateCidrFormat(cidr);
    if (!isValidFormat) {
      return res.json({
        success: false,
        valid: false,
        error: 'Invalid CIDR format'
      });
    }
    
    // 检查冲突
    const hasConflict = await CidrGenerator.checkCidrConflict(cidr, region);
    
    res.json({
      success: true,
      valid: !hasConflict,
      conflict: hasConflict,
      message: hasConflict ? 'CIDR conflicts with existing VPC' : 'CIDR is available'
    });
  } catch (error) {
    console.error('Error validating CIDR:', error);
    res.status(500).json({ error: error.message });
  }
});

console.log('CIDR generation APIs loaded');

// EKS集群创建相关API
app.post('/api/cluster/create-eks', async (req, res) => {
  try {
    const { clusterTag, awsRegion, customVpcCidr, cidrConfig: userCidrConfig } = req.body;
    
    // 验证必填字段
    if (!clusterTag || !awsRegion) {
      return res.status(400).json({ error: 'Missing required fields: clusterTag and awsRegion' });
    }
    
    // 使用用户提供的 CIDR 配置，或自动生成
    let cidrConfig;
    if (userCidrConfig && userCidrConfig.vpcCidr) {
      // 用户提供了完整的 CIDR 配置，直接使用
      console.log('Using user-provided CIDR configuration:', userCidrConfig);
      cidrConfig = userCidrConfig;
    } else {
      // 自动生成 CIDR 配置（向后兼容）
      console.log('Auto-generating CIDR configuration for region:', awsRegion);
      cidrConfig = await CidrGenerator.generateFullCidrConfiguration(awsRegion, customVpcCidr);
    }
    
    // 立即创建集群目录和状态记录（在CloudFormation调用前）
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const stackName = `full-stack-${clusterTag}-${timestamp}`;
    
    const clusterConfig = {
      clusterTag,
      awsRegion,
      customVpcCidr: customVpcCidr || 'auto-generated'
    };
    
    // 创建集群目录结构
    clusterManager.createClusterDirs(clusterTag);
    
    // 立即保存用户输入和CIDR配置
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const fs = require('fs');
    const path = require('path');
    
    // 添加到creating-clusters跟踪文件
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    let creatingClusters = {};
    if (fs.existsSync(creatingClustersPath)) {
      creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    }
    creatingClusters[clusterTag] = {
      type: 'eks',
      status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(),
      stackName: stackName,
      region: awsRegion
    };
    fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));
    
    // 保存用户输入信息
    fs.writeFileSync(
      path.join(metadataDir, 'user_input.json'),
      JSON.stringify({
        clusterTag,
        awsRegion,
        customVpcCidr: customVpcCidr || null,
        inputAt: new Date().toISOString()
      }, null, 2)
    );
    
    // 保存CIDR配置
    fs.writeFileSync(
      path.join(metadataDir, 'cidr_configuration.json'),
      JSON.stringify(cidrConfig, null, 2)
    );
    
    // 保存创建状态
    fs.writeFileSync(
      path.join(metadataDir, 'creation_status.json'),
      JSON.stringify({
        status: 'IN_PROGRESS',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        stackName: stackName,
        region: awsRegion,
        phase: 'CLOUDFORMATION_CREATING'
      }, null, 2)
    );
    
    // 创建CloudFormation Stack
    const stackResult = await CloudFormationManager.createEKSStack({
      clusterTag,
      awsRegion,
      stackName
    }, cidrConfig);
    
    // 更新创建状态，添加Stack ID
    fs.writeFileSync(
      path.join(metadataDir, 'creation_status.json'),
      JSON.stringify({
        status: 'IN_PROGRESS',
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        stackName: stackName,
        stackId: stackResult.stackId,
        region: awsRegion,
        phase: 'CLOUDFORMATION_IN_PROGRESS'
      }, null, 2)
    );
    
    // 更新creating-clusters跟踪文件
    creatingClusters[clusterTag].stackId = stackResult.stackId;
    creatingClusters[clusterTag].phase = 'CLOUDFORMATION_IN_PROGRESS';
    creatingClusters[clusterTag].lastUpdated = new Date().toISOString();
    fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));
    
    await clusterManager.saveCreationConfig(clusterTag, clusterConfig, cidrConfig, stackResult);
    
    // 发送WebSocket通知
    broadcast({
      type: 'cluster_creation_started',
      status: 'success',
      message: `EKS cluster creation started: ${clusterTag}`,
      clusterTag,
      stackName: stackResult.stackName
    });
    
    res.json({
      success: true,
      clusterTag,
      stackName: stackResult.stackName,
      stackId: stackResult.stackId,
      cidrConfig,
      message: 'EKS cluster creation started successfully'
    });
  } catch (error) {
    console.error('Error creating EKS cluster:', error);
    
    broadcast({
      type: 'cluster_creation_started',
      status: 'error',
      message: `Failed to create EKS cluster: ${error.message}`
    });
    
    res.status(500).json({ error: error.message });
  }
});

// HyperPod创建状态管理
const CREATING_HYPERPOD_CLUSTERS_FILE = path.join(__dirname, '../managed_clusters_info/creating-hyperpod-clusters.json');

function getCreatingHyperPodClusters() {
  try {
    if (fs.existsSync(CREATING_HYPERPOD_CLUSTERS_FILE)) {
      return JSON.parse(fs.readFileSync(CREATING_HYPERPOD_CLUSTERS_FILE, 'utf8'));
    }
    return {};
  } catch (error) {
    console.error('Error reading creating HyperPod clusters file:', error);
    return {};
  }
}

function updateCreatingHyperPodStatus(clusterTag, statusUpdate) {
  try {
    const creatingClusters = getCreatingHyperPodClusters();
    
    if (statusUpdate === 'COMPLETED') {
      // 移除已完成的集群
      delete creatingClusters[clusterTag];
    } else {
      // 更新或添加集群状态
      creatingClusters[clusterTag] = {
        ...creatingClusters[clusterTag],
        ...statusUpdate,
        lastUpdated: new Date().toISOString()
      };
    }
    
    fs.writeFileSync(CREATING_HYPERPOD_CLUSTERS_FILE, JSON.stringify(creatingClusters, null, 2));
  } catch (error) {
    console.error('Error updating creating HyperPod clusters status:', error);
  }
}

async function registerCompletedHyperPod(clusterTag) {
  try {
    console.log(`HyperPod cluster ${clusterTag} creation completed`);
    
    // 配置HyperPod自定义依赖
    await HyperPodDependencyManager.configureHyperPodDependencies(clusterTag, clusterManager);
    
    // 将创建的HyperPod集群信息添加到metadata
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      
      // 获取HyperPod集群名称（使用命名约定）
      const hyperPodClusterName = `hp-cluster-${clusterTag}`;
      
      // 获取HyperPod集群详细信息
      try {
        const region = clusterInfo.region || 'us-west-2';
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        const hpCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodClusterName} --region ${region} --output json`;
        const hpResult = await execAsync(hpCmd);
        const hpData = JSON.parse(hpResult.stdout);
        
        // 添加来源标识到原始数据
        hpData.source = 'ui-created';
        
        // 保存完整的HyperPod集群信息（替换旧的结构）
        clusterInfo.hyperPodCluster = hpData;
        clusterInfo.lastModified = new Date().toISOString();
        
        // 保存更新后的metadata
        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
        console.log(`Saved complete HyperPod cluster info for ${clusterTag} (ui-created)`);
        
      } catch (error) {
        console.warn('Failed to get HyperPod cluster details for metadata:', error.message);
      }
    }
    
  } catch (error) {
    console.error('Error registering completed HyperPod:', error);
    // 不抛出错误，避免影响主流程
  }
}

// 辅助函数：更新creating-clusters状态
function updateCreatingClustersStatus(clusterTag, status, additionalData = {}) {
  const fs = require('fs');
  const path = require('path');
  const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
  
  console.log(`🔄 Updating creating status for ${clusterTag}: ${status}`);
  
  let creatingClusters = {};
  if (fs.existsSync(creatingClustersPath)) {
    creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
  }
  
  if (status === 'COMPLETED') {
    // 完成时删除记录
    delete creatingClusters[clusterTag];
    console.log(`✅ Removed ${clusterTag} from creating-clusters (completed)`);
  } else {
    // 更新状态和附加数据
    if (creatingClusters[clusterTag]) {
      creatingClusters[clusterTag] = {
        ...creatingClusters[clusterTag],
        status: status,
        lastUpdated: new Date().toISOString(),
        ...additionalData
      };
    }
  }
  
  fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));
}

// 获取正在创建的集群列表
app.get('/api/cluster/creating-clusters', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    
    if (!fs.existsSync(creatingClustersPath)) {
      return res.json({ success: true, clusters: {} });
    }
    
    const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    
    // 检查状态并处理完成的集群
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.type === 'eks' && clusterInfo.stackName) {
        try {
          const stackStatus = await CloudFormationManager.getStackStatus(clusterInfo.stackName, clusterInfo.region);
          clusterInfo.currentStackStatus = stackStatus.stackStatus;
          
          // 如果EKS集群创建完成，注册基础集群（不自动配置依赖）
          if (stackStatus.stackStatus === 'CREATE_COMPLETE' && 
              clusterInfo.currentStackStatus !== 'COMPLETED') {
            console.log(`EKS cluster ${clusterTag} creation completed, registering basic cluster...`);
            
            // 注册基础集群（dependencies.configured = false）
            await registerCompletedCluster(clusterTag, 'active');
            
            // 清理creating状态
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
            
            // 广播集群创建完成
            broadcast({
              type: 'cluster_creation_completed',
              status: 'success',
              message: `EKS cluster ${clusterTag} created successfully. Configure dependencies in Cluster Information.`,
              clusterTag: clusterTag
            });
            
          } else if (stackStatus.stackStatus.includes('FAILED') || stackStatus.stackStatus.includes('ROLLBACK')) {
            // 创建失败，清理状态
            console.log(`EKS cluster ${clusterTag} creation failed, cleaning up...`);
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
          }
          
        } catch (error) {
          console.error(`Error checking status for cluster ${clusterTag}:`, error);
          clusterInfo.currentStackStatus = 'UNKNOWN';
          
          // 如果stack不存在，清理状态
          if (error.message && error.message.includes('does not exist')) {
            console.log(`Stack for ${clusterTag} does not exist, cleaning up...`);
            updateCreatingClustersStatus(clusterTag, 'COMPLETED');
          }
        }
      }
    }
    
    res.json({ success: true, clusters: creatingClusters });
  } catch (error) {
    console.error('Error getting creating clusters:', error);
    res.status(500).json({ error: error.message });
  }
});

// 防止并发配置的互斥锁
const configurationMutex = new Set();

// 配置集群依赖（helm等）
async function configureClusterDependencies(clusterTag) {
  // 检查是否已经在配置中
  if (configurationMutex.has(clusterTag)) {
    console.log(`Dependencies configuration already in progress for ${clusterTag}, skipping...`);
    return;
  }
  
  // 添加到互斥锁
  configurationMutex.add(clusterTag);
  
  try {
    console.log(`Configuring dependencies for cluster: ${clusterTag}`);
    
    // 1. 更新状态为配置依赖中
    updateCreatingClustersStatus(clusterTag, 'IN_PROGRESS', { 
      phase: 'CONFIGURING_DEPENDENCIES',
      currentStackStatus: 'CONFIGURING_DEPENDENCIES'
    });
    
    // 2. 先注册基础集群信息（让集群立即出现在列表中）
    await registerCompletedCluster(clusterTag, 'configuring');
    
    // 3. 广播依赖配置开始
    broadcast({
      type: 'cluster_dependencies_started',
      status: 'info',
      message: `Configuring dependencies for cluster: ${clusterTag}`,
      clusterTag: clusterTag
    });
    
    // 4. 配置依赖
    await ClusterDependencyManager.configureClusterDependencies(clusterTag, clusterManager);
    
    console.log(`Successfully configured dependencies for cluster: ${clusterTag}`);
    
    // 5. 更新集群状态为active
    await updateClusterStatus(clusterTag, 'active');
    
    // 6. 最后清理creating状态
    updateCreatingClustersStatus(clusterTag, 'COMPLETED');
    
    // 7. 广播完成
    broadcast({
      type: 'cluster_creation_completed',
      status: 'success',
      message: `Cluster ${clusterTag} is now ready and available`,
      clusterTag: clusterTag
    });
    
  } catch (error) {
    console.error(`Error configuring dependencies for cluster ${clusterTag}:`, error);
    
    // 即使依赖配置失败，也要注册集群（让用户能看到集群）
    console.log(`Registering cluster ${clusterTag} despite dependency configuration failure`);
    try {
      await registerCompletedCluster(clusterTag, 'active'); // 即使失败也设为active
    } catch (registerError) {
      console.error(`Failed to register cluster ${clusterTag}:`, registerError);
    }
    
    // 清除creating状态
    updateCreatingClustersStatus(clusterTag, 'COMPLETED');
    
    // 广播依赖配置失败
    broadcast({
      type: 'cluster_dependencies_failed',
      status: 'warning',
      message: `Dependencies configuration failed for cluster: ${clusterTag}, but cluster is still available`,
      clusterTag: clusterTag
    });
    
  } finally {
    // 移除互斥锁
    configurationMutex.delete(clusterTag);
  }
}

// 更新已存在集群的状态
async function updateClusterStatus(clusterTag, status) {
  const fs = require('fs');
  const path = require('path');
  
  try {
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      clusterInfo.status = status;
      clusterInfo.lastModified = new Date().toISOString();
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      console.log(`Updated cluster ${clusterTag} status to: ${status}`);
    }
  } catch (error) {
    console.error(`Failed to update cluster status for ${clusterTag}:`, error);
  }
}

// 注册完成的集群到可选列表
async function registerCompletedCluster(clusterTag, status = 'active') {
  try {
    console.log(`Registering completed cluster: ${clusterTag}`);
    
    const fs = require('fs');
    const path = require('path');
    
    // 读取创建时的metadata
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const creationMetadataPath = path.join(metadataDir, 'creation_metadata.json');
    
    console.log(`Looking for creation metadata at: ${creationMetadataPath}`);
    
    if (!fs.existsSync(creationMetadataPath)) {
      console.error(`Creation metadata not found for cluster: ${clusterTag}`);
      console.log(`Metadata directory contents:`, fs.existsSync(metadataDir) ? fs.readdirSync(metadataDir) : 'Directory does not exist');
      throw new Error(`Creation metadata not found for cluster: ${clusterTag}`);
    }
    
    const creationMetadata = JSON.parse(fs.readFileSync(creationMetadataPath, 'utf8'));
    
    // 获取CloudFormation Stack输出
    let stackOutputs = {};
    try {
      const stackStatus = await CloudFormationManager.getStackStatus(
        creationMetadata.cloudFormation.stackName,
        creationMetadata.userConfig.awsRegion
      );
      
      if (stackStatus.outputs && stackStatus.outputs.length > 0) {
        // 将输出数组转换为键值对对象
        stackOutputs = stackStatus.outputs.reduce((acc, output) => {
          acc[output.OutputKey] = output.OutputValue;
          return acc;
        }, {});
        console.log(`Retrieved CloudFormation outputs for ${clusterTag}:`, Object.keys(stackOutputs));
      }
    } catch (error) {
      console.error(`Failed to get CloudFormation outputs for ${clusterTag}:`, error);
    }
    
    // 生成cluster_info.json（兼容现有格式 + 新增dependencies字段）
    const clusterInfo = {
      clusterTag: clusterTag,
      region: creationMetadata.userConfig.awsRegion,
      status: status, // 使用传入的状态
      type: 'created',
      createdAt: creationMetadata.createdAt,
      lastModified: new Date().toISOString(),
      source: 'ui-panel-creation',
      dependencies: {
        configured: false,
        status: 'pending',
        lastAttempt: null,
        lastSuccess: null,
        components: {
          helmDependencies: false,
          nlbController: false,
          s3CsiDriver: false,
          kuberayOperator: false,
          certManager: false
        }
      },
      cloudFormation: {
        stackName: creationMetadata.cloudFormation.stackName,
        stackId: creationMetadata.cloudFormation.stackId,
        outputs: stackOutputs
      },
      eksCluster: {
        name: stackOutputs.OutputEKSClusterName || `eks-cluster-${clusterTag}`,
        arn: stackOutputs.OutputEKSClusterArn || null,
        vpcId: stackOutputs.OutputVpcId || null,
        securityGroupId: stackOutputs.OutputSecurityGroupId || null,
        privateSubnetIds: stackOutputs.OutputPrivateSubnetIds || null,
        s3BucketName: stackOutputs.OutputS3BucketName || null,
        sageMakerRoleArn: stackOutputs.OutputSageMakerIAMRoleArn || null
      }
    };
    
    // 保存cluster_info.json
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
    
    // 更新creation_metadata.json，添加CloudFormation输出
    if (Object.keys(stackOutputs).length > 0) {
      creationMetadata.cloudFormation.outputs = stackOutputs;
      creationMetadata.cloudFormation.outputsRetrievedAt = new Date().toISOString();
      fs.writeFileSync(creationMetadataPath, JSON.stringify(creationMetadata, null, 2));
      console.log(`Updated creation_metadata.json with CloudFormation outputs for ${clusterTag}`);
    }
    
    console.log(`Successfully registered cluster: ${clusterTag}`);
    
    // 不自动切换 active cluster，让用户在 Cluster Information 页面手动选择
    // 用户可以通过刷新集群列表后手动切换到新创建的集群
    
    // 发送WebSocket通知
    broadcast({
      type: 'cluster_creation_completed',
      status: 'success',
      message: `EKS cluster created and registered: ${clusterTag}. Please select it in Cluster Information to use.`,
      clusterTag: clusterTag
    });
    
  } catch (error) {
    console.error(`Failed to register completed cluster ${clusterTag}:`, error);
  }
}

// 独立依赖配置API - 针对当前active集群
app.post('/api/cluster/configure-dependencies', async (req, res) => {
  try {
    // 获取当前active集群
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ error: 'No active cluster selected' });
    }

    // 检查集群是否存在
    const clusterInfo = await getClusterInfo(activeCluster);
    if (!clusterInfo) {
      return res.status(400).json({ error: 'Active cluster not found' });
    }

    // 检查是否为导入的EKS+HyperPod集群（不需要配置依赖）
    // 注释掉：导入的集群现在也可以配置依赖
    // if (clusterInfo.hyperPodCluster && clusterInfo.type === 'imported') {
    //   return res.status(400).json({ 
    //     error: 'Dependencies configuration not needed for imported clusters with HyperPod' 
    //   });
    // }

    // 检查是否已配置或正在配置中
    if (clusterInfo.dependencies?.configured) {
      return res.status(400).json({ error: 'Dependencies already configured' });
    }

    if (clusterInfo.dependencies?.status === 'configuring') {
      return res.status(400).json({ error: 'Dependencies configuration already in progress' });
    }

    // 更新状态为配置中
    await updateDependencyStatus(activeCluster, 'configuring');

    // 异步执行配置
    process.nextTick(() => {
      configureDependenciesForActiveCluster(activeCluster).catch(error => {
        console.error(`Dependency configuration failed for ${activeCluster}:`, error);
        updateDependencyStatus(activeCluster, 'failed', { error: error.message });
      });
    });

    res.json({ 
      success: true, 
      message: `Dependency configuration started for cluster: ${activeCluster}`,
      clusterTag: activeCluster
    });

  } catch (error) {
    console.error('Error starting dependency configuration:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取依赖配置状态
app.get('/api/cluster/:clusterTag/dependencies/status', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const clusterInfo = await getClusterInfo(clusterTag);

    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster not found' });
    }

    res.json({
      success: true,
      clusterTag: clusterTag,
      dependencies: clusterInfo.dependencies || { 
        configured: false, 
        status: 'pending',
        components: {}
      }
    });

  } catch (error) {
    console.error('Error getting dependency status:', error);
    res.status(500).json({ error: error.message });
  }
});

// 取消集群创建
app.post('/api/cluster/cancel-creation/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    
    // 1. 获取创建状态信息
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    if (!fs.existsSync(creatingClustersPath)) {
      return res.status(404).json({ error: 'No creating clusters found' });
    }
    
    const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
    const clusterInfo = creatingClusters[clusterTag];
    
    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster creation not found' });
    }
    
    console.log(`Canceling creation for cluster: ${clusterTag}`);
    
    // 2. 删除CloudFormation Stack（异步触发）
    if (clusterInfo.stackName && clusterInfo.region) {
      process.nextTick(() => {
        try {
          const deleteCmd = `aws cloudformation delete-stack --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region}`;
          execSync(deleteCmd, { stdio: 'inherit' });
          console.log(`CloudFormation stack deletion triggered: ${clusterInfo.stackName}`);
          
          // 广播删除开始
          broadcast({
            type: 'cluster_creation_cancelled',
            status: 'info',
            message: `CloudFormation stack deletion started: ${clusterInfo.stackName}`,
            clusterTag: clusterTag
          });
        } catch (error) {
          console.error(`Failed to delete CloudFormation stack: ${error.message}`);
          broadcast({
            type: 'cluster_creation_cancel_failed',
            status: 'error',
            message: `Failed to delete CloudFormation stack: ${error.message}`,
            clusterTag: clusterTag
          });
        }
      });
    }
    
    // 3. 清理metadata
    cleanupCreatingMetadata(clusterTag);
    
    res.json({ 
      success: true, 
      message: `Cluster creation cancelled: ${clusterTag}`,
      clusterTag: clusterTag
    });
    
  } catch (error) {
    console.error('Error canceling cluster creation:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取集群信息
async function getClusterInfo(clusterTag) {
  try {
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (fs.existsSync(clusterInfoPath)) {
      return JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    }
    return null;
  } catch (error) {
    console.error(`Error getting cluster info for ${clusterTag}:`, error);
    return null;
  }
}

// 更新依赖配置状态
async function updateDependencyStatus(clusterTag, status, additionalData = {}) {
  try {
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      
      clusterInfo.dependencies = {
        ...clusterInfo.dependencies,
        status: status,
        lastAttempt: new Date().toISOString(),
        ...(status === 'success' && { 
          configured: true, 
          lastSuccess: new Date().toISOString() 
        }),
        ...additionalData
      };
      
      clusterInfo.lastModified = new Date().toISOString();
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      console.log(`Updated dependency status for ${clusterTag}: ${status}`);
    }
  } catch (error) {
    console.error(`Error updating dependency status for ${clusterTag}:`, error);
  }
}

// 针对当前active集群配置依赖
async function configureDependenciesForActiveCluster(clusterTag) {
  try {
    console.log(`Configuring dependencies for active cluster: ${clusterTag}`);
    
    // 广播开始配置
    broadcast({
      type: 'cluster_dependencies_started',
      status: 'info',
      message: `Configuring dependencies for cluster: ${clusterTag}`,
      clusterTag: clusterTag
    });
    
    // 使用现有的ClusterDependencyManager进行配置
    await ClusterDependencyManager.configureClusterDependencies(clusterTag, clusterManager);
    
    console.log(`Successfully configured dependencies for cluster: ${clusterTag}`);
    
    // 更新状态为成功
    await updateDependencyStatus(clusterTag, 'success', {
      components: {
        helmDependencies: true,
        nlbController: true,
        s3CsiDriver: true,
        kuberayOperator: true,
        certManager: true
      }
    });
    
    // 广播完成
    broadcast({
      type: 'cluster_dependencies_completed',
      status: 'success',
      message: `Dependencies configured successfully for cluster: ${clusterTag}`,
      clusterTag: clusterTag
    });
    
  } catch (error) {
    console.error(`Error configuring dependencies for cluster ${clusterTag}:`, error);
    
    // 更新状态为失败
    await updateDependencyStatus(clusterTag, 'failed', { 
      error: error.message,
      failedAt: new Date().toISOString()
    });
    
    // 广播失败
    broadcast({
      type: 'cluster_dependencies_failed',
      status: 'error',
      message: `Dependencies configuration failed for cluster: ${clusterTag}`,
      clusterTag: clusterTag,
      error: error.message
    });
  }
}

function cleanupCreatingMetadata(clusterTag) {
  const fs = require('fs');
  const path = require('path');
  
  try {
    console.log(`Cleaning up creating metadata for: ${clusterTag}`);
    
    // 从creating-clusters.json中移除
    const creatingClustersPath = path.join(__dirname, '../managed_clusters_info/creating-clusters.json');
    if (fs.existsSync(creatingClustersPath)) {
      const creatingClusters = JSON.parse(fs.readFileSync(creatingClustersPath, 'utf8'));
      delete creatingClusters[clusterTag];
      fs.writeFileSync(creatingClustersPath, JSON.stringify(creatingClusters, null, 2));
    }
    
    // 删除集群目录（恢复到空白状态）
    const clusterDir = path.join(__dirname, '../managed_clusters_info', clusterTag);
    if (fs.existsSync(clusterDir)) {
      fs.rmSync(clusterDir, { recursive: true, force: true });
      console.log(`Removed cluster directory: ${clusterDir}`);
    }
    
    console.log(`Successfully cleaned up metadata for cluster: ${clusterTag}`);
    
  } catch (error) {
    console.error(`Error cleaning up metadata for cluster ${clusterTag}:`, error);
  }
}

// 检查集群依赖配置状态
app.get('/api/cluster/dependency-status/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    
    const clusterDir = clusterManager.getClusterDir(clusterTag);
    const configDir = path.join(clusterDir, 'config');
    
    if (!fs.existsSync(configDir)) {
      return res.status(404).json({ error: 'Cluster not found' });
    }
    
    const status = await ClusterDependencyManager.checkDependencyStatus(configDir);
    
    res.json({
      success: true,
      clusterTag,
      dependencyStatus: status
    });
    
  } catch (error) {
    console.error('Error checking dependency status:', error);
    res.status(500).json({ error: error.message });
  }
});

// 手动重新配置集群依赖（用于调试）
app.post('/api/cluster/reconfigure-dependencies/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    
    console.log(`Manual reconfiguration requested for cluster: ${clusterTag}`);
    
    // 先清理现有配置
    const clusterDir = clusterManager.getClusterDir(clusterTag);
    const configDir = path.join(clusterDir, 'config');
    
    await ClusterDependencyManager.cleanupDependencies(configDir);
    
    // 重新配置
    await ClusterDependencyManager.configureClusterDependencies(clusterTag, clusterManager);
    
    res.json({
      success: true,
      message: `Successfully reconfigured dependencies for cluster: ${clusterTag}`
    });
    
  } catch (error) {
    console.error('Error reconfiguring dependencies:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取集群创建状态
app.get('/api/cluster/creation-status/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const fs = require('fs');
    const path = require('path');
    
    // 读取创建metadata获取region和stack信息
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const creationStatusPath = path.join(metadataDir, 'creation_status.json');
    
    if (!fs.existsSync(creationStatusPath)) {
      return res.status(404).json({ error: 'Creation status not found' });
    }
    
    const creationStatus = JSON.parse(fs.readFileSync(creationStatusPath, 'utf8'));
    const stackName = creationStatus.stackName;
    const region = creationStatus.region;
    
    if (!stackName || !region) {
      return res.status(400).json({ error: 'Missing stack name or region in metadata' });
    }
    
    const stackStatus = await CloudFormationManager.getStackStatus(stackName, region);
    
    res.json({
      success: true,
      clusterTag,
      stackName,
      region,
      ...stackStatus
    });
  } catch (error) {
    console.error('Error getting cluster creation status:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取集群创建日志
app.get('/api/cluster/creation-logs/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    
    // 读取集群配置
    const clusterInfo = await clusterManager.getClusterInfo(clusterTag);
    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster not found' });
    }
    
    const stackName = `full-stack-${clusterTag}`;
    const events = await CloudFormationManager.getStackEvents(stackName, clusterInfo.awsRegion);
    
    res.json({
      success: true,
      clusterTag,
      stackName,
      events
    });
  } catch (error) {
    console.error('Error getting cluster creation logs:', error);
    res.status(500).json({ error: error.message });
  }
});

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
  try {
    const { execSync } = require('child_process');
    const { region } = req.query;
    if (!region) {
      return res.status(400).json({ success: false, error: 'Region parameter required' });
    }
    
    const command = `aws ec2 describe-availability-zones --region ${region} --query 'AvailabilityZones[*].{ZoneName:ZoneName,ZoneId:ZoneId}' --output json`;
    const result = execSync(command, { encoding: 'utf8' });
    const zones = JSON.parse(result);
    
    res.json({
      success: true,
      zones
    });
  } catch (error) {
    console.error('Error getting availability zones:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// HyperPod集群创建API
app.post('/api/cluster/create-hyperpod', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);
    const path = require('path');
    
    const { userConfig } = req.body;
    
    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    console.log('Active cluster:', activeCluster);
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    // 检查kubectl连通性
    try {
      console.log('Testing kubectl connectivity...');
      const kubectlResult = execSync('kubectl cluster-info', { encoding: 'utf8', timeout: 15000 });
      console.log('kubectl cluster-info result:', kubectlResult);
    } catch (error) {
      console.error('kubectl connectivity test failed:', error.message);
      console.error('kubectl error details:', error);
      return res.status(400).json({ 
        success: false, 
        error: `EKS cluster not accessible via kubectl: ${error.message}` 
      });
    }
    
    // 获取EKS集群信息 - 从metadata获取（兼容创建和导入的集群）
    const MetadataUtils = require('./utils/metadataUtils');
    
    // 获取EKS集群基本信息
    const eksClusterInfo = MetadataUtils.getEKSClusterInfo(activeCluster);
    const region = MetadataUtils.getClusterRegion(activeCluster);
    
    if (!eksClusterInfo || !region) {
      return res.status(400).json({ 
        success: false, 
        error: 'EKS cluster information not found in metadata' 
      });
    }
    
    console.log('EKS cluster info from metadata:', eksClusterInfo);
    
    // 获取NAT Gateway ID（动态获取）
    const ClusterDependencyManager = require('./utils/clusterDependencyManager');
    const natGatewayId = await ClusterDependencyManager.getNatGatewayId(eksClusterInfo.vpcId, region);
    
    // 从SageMaker角色ARN中提取角色名称
    const sageMakerRoleName = eksClusterInfo.sageMakerRoleArn ? 
      eksClusterInfo.sageMakerRoleArn.split('/').pop() : null;
    
    // 构建EKS基础设施信息（从metadata获取，与CloudFormationManager.fetchStackInfo格式对齐）
    const eksInfrastructureInfo = {
      VPC_ID: eksClusterInfo.vpcId,
      SECURITY_GROUP_ID: eksClusterInfo.securityGroupId,
      PRIVATE_SUBNET_ID: eksClusterInfo.privateSubnetIds,
      EKS_CLUSTER_NAME: eksClusterInfo.name,
      SAGEMAKER_ROLE_ARN: eksClusterInfo.sageMakerRoleArn,
      SAGEMAKER_ROLE_NAME: sageMakerRoleName,
      S3_BUCKET_NAME: eksClusterInfo.s3BucketName,
      NAT_GATEWAY_ID: natGatewayId
    };
    
    // 生成HyperPod配置
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const clusterTag = userConfig.clusterTag;
    const hyperPodStackName = `hyperpod-${clusterTag}-${timestamp}`;
    
    // 使用EKS集群标识作为HyperPod集群名称，保持命名一致性
    const eksClusterTag = activeCluster; // 使用EKS集群的标识
    const hyperPodClusterName = `hp-cluster-${eksClusterTag}`;
    
    // 获取可用区ID
    const azCommand = `aws ec2 describe-availability-zones --region ${region} --query "AvailabilityZones[?ZoneName=='${userConfig.availabilityZone}'].ZoneId" --output text`;
    const azResult = execSync(azCommand, { encoding: 'utf8' });
    const availabilityZoneId = azResult.trim();
    
    // 🔑 确保目标 AZ 有 Public Subnet（2025-11-23）
    console.log(`\n🔍 Ensuring public subnet exists in ${userConfig.availabilityZone}...`);
    const SubnetManager = require('./utils/subnetManager');
    try {
      const publicSubnetResult = await SubnetManager.ensurePublicSubnet({
        vpcId: eksInfrastructureInfo.VPC_ID,
        availabilityZone: userConfig.availabilityZone,
        clusterTag: activeCluster,
        region: region
      });
      
      console.log(`✅ Public subnet ready: ${publicSubnetResult.subnetId} (${publicSubnetResult.subnetName})`);
      if (publicSubnetResult.created) {
        console.log(`   Created new subnet with CIDR: ${publicSubnetResult.cidrBlock}`);
      }
    } catch (subnetError) {
      console.error('❌ Failed to ensure public subnet:', subnetError);
      return res.status(500).json({ 
        success: false, 
        error: `Failed to ensure public subnet in ${userConfig.availabilityZone}: ${subnetError.message}` 
      });
    }
    
    // 验证必需的基础设施信息
    if (!eksInfrastructureInfo.VPC_ID || !eksInfrastructureInfo.SECURITY_GROUP_ID) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required EKS infrastructure information (VPC or Security Group)' 
      });
    }
    
    // 从 metadata 读取已保存的 CIDR 配置
    const metadataDir = clusterManager.getClusterMetadataDir(activeCluster);
    const cidrConfigPath = path.join(metadataDir, 'cidr_configuration.json');
    
    let hyperPodPrivateSubnetCidr;
    
    if (fs.existsSync(cidrConfigPath)) {
      // 优先使用已保存的 CIDR 配置
      const savedCidrConfig = JSON.parse(fs.readFileSync(cidrConfigPath, 'utf8'));
      hyperPodPrivateSubnetCidr = savedCidrConfig.hyperPodPrivateSubnetCidr;
      console.log('Using saved HyperPod CIDR from metadata:', hyperPodPrivateSubnetCidr);
    } else {
      // 如果 metadata 不存在，重新生成（向后兼容）
      console.log('CIDR metadata not found, generating new CIDR config');
      const cidrResponse = await fetch('http://localhost:3001/api/cluster/generate-cidr-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: region })
      });
      const cidrConfig = await cidrResponse.json();
      hyperPodPrivateSubnetCidr = cidrConfig.hyperPodPrivateSubnetCidr;
      console.log('Generated new HyperPod CIDR:', hyperPodPrivateSubnetCidr);
    }
    
    if (!hyperPodPrivateSubnetCidr) {
      throw new Error('Failed to get HyperPod private subnet CIDR');
    }
    
    // 记录创建状态
    updateCreatingHyperPodStatus(activeCluster, {
      type: 'hyperpod',
      status: 'IN_PROGRESS',
      phase: 'CREATING_STACK',
      stackName: hyperPodStackName,
      region: region,
      createdAt: new Date().toISOString()
    });
    
    // 构建HyperPod配置
    const hyperPodConfig = {
      ResourceNamePrefix: clusterTag,
      AvailabilityZoneId: availabilityZoneId,
      PrivateSubnet1CIDR: hyperPodPrivateSubnetCidr,
      HyperPodClusterName: hyperPodClusterName,
      NodeRecovery: 'None',
      UseContinuousNodeProvisioningMode: 'false',
      CreateAcceleratedInstanceGroup: 'true',
      AcceleratedInstanceGroupName: `accelerated-${clusterTag}`,
      AcceleratedInstanceType: userConfig.AcceleratedInstanceType,
      AcceleratedInstanceCount: userConfig.AcceleratedInstanceCount,
      AcceleratedEBSVolumeSize: userConfig.AcceleratedEBSVolumeSize,
      AcceleratedTrainingPlanArn: userConfig.AcceleratedTrainingPlanArn || '',
      // 自动设置threads per core：有training plan或使用p4/p5/p6实例时为2，否则为1
      AcceleratedThreadsPerCore: shouldUseThreadsPerCore2(userConfig.AcceleratedInstanceType, userConfig.AcceleratedTrainingPlanArn) ? 2 : 1,
      EnableInstanceStressCheck: 'false',
      EnableInstanceConnectivityCheck: 'false'
    };
    
    const stackResult = await CloudFormationManager.createHyperPodStack(
      hyperPodStackName,
      region,
      eksInfrastructureInfo,
      hyperPodConfig
    );
    
    // 保存配置到metadata
    await clusterManager.saveHyperPodConfig(activeCluster, {
      stackName: hyperPodStackName,
      stackId: stackResult.stackId,
      region: region,
      userConfig: userConfig,
      infrastructureInfo: eksInfrastructureInfo,  // 从metadata构建的EKS基础设施信息
      createdAt: new Date().toISOString()
    });
    
    // 发送WebSocket通知
    broadcast({
      type: 'hyperpod_creation_started',
      status: 'success',
      message: `HyperPod cluster creation started: ${hyperPodStackName}`,
      clusterTag: activeCluster,
      stackName: hyperPodStackName
    });
    
    res.json({
      success: true,
      stackName: hyperPodStackName,
      stackId: stackResult.stackId,
      message: 'HyperPod cluster creation started'
    });
    
  } catch (error) {
    console.error('Error creating HyperPod cluster:', error);
    
    // 更新失败状态
    const activeCluster = clusterManager.getActiveCluster();
    if (activeCluster) {
      updateCreatingHyperPodStatus(activeCluster, {
        status: 'FAILED',
        error: error.message,
        failedAt: new Date().toISOString()
      });
    }
    
    broadcast({
      type: 'hyperpod_creation_failed',
      status: 'error',
      message: `HyperPod creation failed: ${error.message}`
    });
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// HyperPod集群删除API
app.delete('/api/cluster/:clusterTag/hyperpod', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const { clusterTag } = req.params;
    
    // 读取HyperPod配置获取stackId
    const hyperPodConfigPath = path.join(__dirname, '../managed_clusters_info', clusterTag, 'metadata/hyperpod-config.json');
    
    if (!fs.existsSync(hyperPodConfigPath)) {
      return res.status(404).json({ success: false, error: 'HyperPod configuration not found' });
    }
    
    const hyperPodConfig = JSON.parse(fs.readFileSync(hyperPodConfigPath, 'utf8'));
    const stackName = hyperPodConfig.hyperPodCluster.stackName;
    const region = hyperPodConfig.hyperPodCluster.region;
    
    // 记录删除状态
    updateCreatingHyperPodStatus(clusterTag, {
      type: 'hyperpod',
      status: 'DELETING',
      phase: 'DELETING_STACK',
      stackName: stackName,
      region: region,
      deletedAt: new Date().toISOString()
    });
    
    // 使用AWS CLI删除CloudFormation Stack
    const deleteCommand = `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`;
    execSync(deleteCommand, { encoding: 'utf8', timeout: 30000 });
    
    // WebSocket广播删除开始
    broadcast({
      type: 'hyperpod_deletion_started',
      clusterTag,
      stackName,
      message: 'HyperPod cluster deletion started'
    });
    
    res.json({ success: true, message: 'HyperPod deletion started' });
  } catch (error) {
    console.error('Error deleting HyperPod cluster:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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

// 删除EKS节点组
app.delete('/api/cluster/nodegroup/:nodeGroupName', async (req, res) => {
  try {
    const { nodeGroupName } = req.params;
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);
    
    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    // 获取EKS集群名称
    const initEnvsPath = path.join(__dirname, '../managed_clusters_info', activeCluster, 'config/init_envs');
    const cmd = `source ${initEnvsPath} && echo $EKS_CLUSTER_NAME`;
    const result = await execAsync(cmd, { shell: '/bin/bash' });
    const eksClusterName = result.stdout.trim();
    
    if (!eksClusterName) {
      return res.status(400).json({ success: false, error: 'EKS cluster name not found' });
    }
    
    // 使用CloudFormationManager删除nodegroup
    const deleteResult = await CloudFormationManager.deleteEksNodeGroup(nodeGroupName, eksClusterName);
    
    res.json(deleteResult);
    
  } catch (error) {
    console.error('Error deleting nodegroup:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// 创建EKS节点组
app.post('/api/cluster/create-nodegroup', async (req, res) => {
  try {
    const { promisify } = require('util');
    const execAsync = promisify(require('child_process').exec);
    const { spawn } = require('child_process');
    const path = require('path');
    const EksNodeGroupDependencyManager = require('./utils/eksNodeGroupDependencyManager');
    
    const { userConfig } = req.body;
    
    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }
    
    // 直接从集群metadata获取所有必要信息
    const clusterInfo = await clusterManager.getClusterInfo(activeCluster);
    if (!clusterInfo || !clusterInfo.cloudFormation || !clusterInfo.cloudFormation.outputs) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cluster metadata not found. Please ensure the cluster was properly created or imported.' 
      });
    }
    
    const eksClusterName = clusterInfo.cloudFormation.outputs.OutputEKSClusterName;
    const region = clusterInfo.region;
    const vpcId = clusterInfo.cloudFormation.outputs.OutputVpcId;
    const securityGroupId = clusterInfo.cloudFormation.outputs.OutputSecurityGroupId;
    
    // 获取子网信息
    const subnetInfo = await CloudFormationManager.fetchSubnetInfo(vpcId, region);
    
    // 创建节点组配置
    const createResult = await CloudFormationManager.createEksNodeGroup(
      userConfig, 
      region, 
      eksClusterName,
      vpcId,
      securityGroupId,
      subnetInfo
    );

    // 异步执行eksctl命令
    const childProcess = spawn('eksctl', ['create', 'nodegroup', '-f', createResult.configFile], {
      stdio: 'pipe'
    });
    
    let output = '';
    let errorOutput = '';
    
    childProcess.stdout.on('data', (data) => {
      output += data.toString();
      console.log('eksctl stdout:', data.toString());
    });
    
    childProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.log('eksctl stderr:', data.toString());
    });
    
    childProcess.on('close', async (code) => {
      // 清理临时文件
      require('fs').unlinkSync(createResult.configFile);
      
      if (code === 0) {
        broadcast({
          type: 'nodegroup_creation_completed',
          status: 'success',
          message: `EKS node group ${userConfig.nodeGroupName} created successfully`
        });
        
        // 自动配置节点组依赖
        try {
          console.log(`Starting dependency configuration for node group: ${userConfig.nodeGroupName}`);
          
          broadcast({
            type: 'nodegroup_dependencies_started',
            status: 'info',
            message: `Configuring dependencies for node group: ${userConfig.nodeGroupName}`
          });
          
          await EksNodeGroupDependencyManager.configureNodeGroupDependencies(
            activeCluster, 
            userConfig.nodeGroupName, 
            clusterManager
          );
          
          broadcast({
            type: 'nodegroup_dependencies_completed',
            status: 'success',
            message: `Node group dependencies configured successfully: ${userConfig.nodeGroupName}`
          });
          
        } catch (error) {
          console.error('Error configuring node group dependencies:', error);
          broadcast({
            type: 'nodegroup_dependencies_failed',
            status: 'error',
            message: `Node group dependencies failed: ${error.message}`
          });
        }
      } else {
        broadcast({
          type: 'nodegroup_creation_failed',
          status: 'error',
          message: `EKS node group creation failed: ${errorOutput}`
        });
      }
    });
    
    // 立即返回成功响应
    broadcast({
      type: 'nodegroup_creation_started',
      status: 'info',
      message: `EKS node group creation started: ${userConfig.nodeGroupName}`
    });
    
    res.json({
      success: true,
      message: 'EKS node group creation started',
      nodeGroupName: userConfig.nodeGroupName
    });
    
  } catch (error) {
    console.error('Error creating EKS node group:', error);
    
    broadcast({
      type: 'nodegroup_creation_failed',
      status: 'error',
      message: `EKS node group creation failed: ${error.message}`
    });
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// 检查EKS节点组依赖状态
app.get('/api/cluster/:clusterTag/nodegroup/:nodeGroupName/dependencies/status', async (req, res) => {
  try {
    const { clusterTag, nodeGroupName } = req.params;
    const EksNodeGroupDependencyManager = require('./utils/eksNodeGroupDependencyManager');
    
    const clusterDir = clusterManager.getClusterDir(clusterTag);
    const configDir = path.join(clusterDir, 'config');
    
    const status = await EksNodeGroupDependencyManager.checkDependencyStatus(configDir, nodeGroupName);
    res.json(status);
    
  } catch (error) {
    console.error('Error checking node group dependency status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 检查HyperPod依赖配置状态
app.get('/api/cluster/:clusterTag/hyperpod/dependencies/status', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    
    const clusterDir = clusterManager.getClusterDir(clusterTag);
    const configDir = path.join(clusterDir, 'config');
    
    if (!fs.existsSync(configDir)) {
      return res.status(404).json({ error: 'Cluster not found' });
    }
    
    const status = await HyperPodDependencyManager.checkHyperPodDependencyStatus(configDir);
    
    res.json({
      success: true,
      clusterTag,
      hyperPodDependencyStatus: status
    });
    
  } catch (error) {
    console.error('Error checking HyperPod dependency status:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取HyperPod创建状态
app.get('/api/cluster/hyperpod-creation-status/:clusterTag', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const { clusterTag } = req.params;
    const creatingClusters = getCreatingHyperPodClusters();
    const status = creatingClusters[clusterTag];
    
    if (!status) {
      return res.json({ success: true, status: null });
    }
    
    // 检查CloudFormation状态
    if (status.stackName && status.region) {
      try {
        const checkCmd = `aws cloudformation describe-stacks --stack-name ${status.stackName} --region ${status.region} --query 'Stacks[0].StackStatus' --output text`;
        const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();
        
        if (stackStatus === 'CREATE_COMPLETE') {
          // 创建完成，先注册HyperPod信息，再清理状态
          await registerCompletedHyperPod(clusterTag);
          updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          
          broadcast({
            type: 'hyperpod_creation_completed',
            status: 'success',
            message: `HyperPod cluster created successfully: ${status.stackName}`,
            clusterTag: clusterTag
          });
          
          return res.json({ success: true, status: { ...status, cfStatus: 'CREATE_COMPLETE' } });
        } else if (stackStatus.includes('FAILED') || stackStatus.includes('ROLLBACK') || stackStatus.includes('DELETE')) {
          // 创建失败，自动清理记录
          console.log(`Auto-cleaning failed HyperPod creation: ${clusterTag}, status: ${stackStatus}`);
          updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          
          broadcast({
            type: 'hyperpod_creation_failed',
            status: 'error',
            message: `HyperPod creation failed and cleaned up: ${stackStatus}`,
            clusterTag: clusterTag
          });
          
          return res.json({ success: true, status: null }); // 返回null表示已清理
        }
        
        status.cfStatus = stackStatus;
      } catch (error) {
        // Stack不存在，清理记录
        if (error.message.includes('does not exist')) {
          console.log(`Auto-cleaning non-existent HyperPod stack: ${clusterTag}`);
          updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          return res.json({ success: true, status: null });
        }
        console.error(`Error checking CloudFormation status: ${error.message}`);
      }
    }
    
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error getting HyperPod creation status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取正在创建的HyperPod集群列表
app.get('/api/cluster/creating-hyperpod-clusters', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    const creatingClusters = getCreatingHyperPodClusters();
    
    // 检查所有创建中集群的状态，自动清理失败/不存在的记录
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.stackName && clusterInfo.region) {
        try {
          // 检查CloudFormation stack状态
          const checkCmd = `aws cloudformation describe-stacks --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region} --query 'Stacks[0].StackStatus' --output text`;
          const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();
          
          if (stackStatus === 'CREATE_COMPLETE') {
            await registerCompletedHyperPod(clusterTag);
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          } else if (stackStatus === 'DELETE_COMPLETE') {
            // 删除完成，清理metadata文件和状态
            console.log(`HyperPod deletion completed: ${clusterTag}`);

            // 删除metadata文件
            const hyperPodConfigPath = path.join(__dirname, '../managed_clusters_info', clusterTag, 'metadata/hyperpod-config.json');
            if (fs.existsSync(hyperPodConfigPath)) {
              fs.unlinkSync(hyperPodConfigPath);
            }

            // 清理cluster_info.json中的hyperPodCluster字段
            const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
            const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
            if (fs.existsSync(clusterInfoPath)) {
              try {
                const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

                // 删除hyperPodCluster字段
                if (clusterInfo.hyperPodCluster) {
                  delete clusterInfo.hyperPodCluster;
                  clusterInfo.lastModified = new Date().toISOString();

                  // 保存更新后的metadata
                  fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
                  console.log(`Removed hyperPodCluster field from cluster_info.json for ${clusterTag}`);
                }
              } catch (error) {
                console.error(`Error cleaning hyperPodCluster metadata for ${clusterTag}:`, error);
              }
            }

            // 清理状态
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
            
            // 广播删除完成
            broadcast({
              type: 'hyperpod_deletion_completed',
              clusterTag,
              message: 'HyperPod cluster deleted successfully'
            });
          } else if (stackStatus.includes('FAILED') || stackStatus.includes('ROLLBACK')) {
            // 自动清理失败的记录
            console.log(`Auto-cleaning failed HyperPod operation: ${clusterTag}, status: ${stackStatus}`);
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED'); // 移除记录
            
            // 如果是删除失败，广播失败消息
            if (clusterInfo.status === 'DELETING') {
              broadcast({
                type: 'hyperpod_deletion_failed',
                clusterTag,
                message: `HyperPod deletion failed: ${stackStatus}`
              });
            }
          }
        } catch (error) {
          // Stack不存在或其他错误，清理记录
          if (error.message.includes('does not exist')) {
            console.log(`Stack does not exist for ${clusterTag}, checking if it was being deleted...`);
            
            // 如果是删除状态且stack不存在，说明删除成功
            if (clusterInfo.status === 'DELETING') {
              console.log(`HyperPod deletion completed (stack removed): ${clusterTag}`);
              
              // 删除metadata文件
              const hyperPodConfigPath = path.join(__dirname, '../managed_clusters_info', clusterTag, 'metadata/hyperpod-config.json');
              if (fs.existsSync(hyperPodConfigPath)) {
                fs.unlinkSync(hyperPodConfigPath);
              }
              
              // 广播删除完成
              broadcast({
                type: 'hyperpod_deletion_completed',
                clusterTag,
                message: 'HyperPod cluster deleted successfully'
              });
            } else {
              console.log(`Auto-cleaning non-existent HyperPod stack: ${clusterTag}`);
            }
            
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED'); // 移除记录
          } else {
            console.error(`Error checking status for ${clusterTag}:`, error.message);
          }
        }
      }
    }
    
    // 返回清理后的状态
    const updatedClusters = getCreatingHyperPodClusters();
    res.json({ success: true, data: updatedClusters });
  } catch (error) {
    console.error('Error getting creating HyperPod clusters:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 取消集群创建
app.post('/api/cluster/cancel-creation/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    
    // 读取集群配置
    const clusterInfo = await clusterManager.getClusterInfo(clusterTag);
    if (!clusterInfo) {
      return res.status(404).json({ error: 'Cluster not found' });
    }
    
    const stackName = `full-stack-${clusterTag}`;
    const result = await CloudFormationManager.cancelStackCreation(stackName, clusterInfo.awsRegion);
    
    // 发送WebSocket通知
    broadcast({
      type: 'cluster_creation_cancelled',
      status: 'success',
      message: `Cluster creation cancelled: ${clusterTag}`,
      clusterTag
    });
    
    res.json({
      success: true,
      clusterTag,
      ...result
    });
  } catch (error) {
    console.error('Error cancelling cluster creation:', error);
    
    broadcast({
      type: 'cluster_creation_cancelled',
      status: 'error',
      message: `Failed to cancel cluster creation: ${error.message}`
    });
    
    res.status(500).json({ error: error.message });
  }
});

console.log('EKS cluster creation APIs loaded');

// 🎨 AWS Instance Types API for Advanced Scaling (Cache-based, no fallbacks)
app.get('/api/aws/instance-types', async (req, res) => {
  try {
    // Get current active cluster
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    // Try to get cached instance types
    const cachedData = MetadataUtils.getInstanceTypesCache(activeClusterName);

    if (cachedData && !cachedData.error) {
      console.log(`Returning cached instance types for cluster: ${activeClusterName} (last updated: ${cachedData.lastUpdated})`);
      return res.json({
        success: true,
        region: cachedData.region,
        instanceTypes: cachedData.instanceTypes,
        lastUpdated: cachedData.lastUpdated,
        cached: true
      });
    }

    // No cache or cache has error - return error and ask user to refresh
    if (cachedData && cachedData.error) {
      return res.status(500).json({
        success: false,
        error: `Instance types cache has error: ${cachedData.error}`,
        lastUpdated: cachedData.lastUpdated,
        needsRefresh: true
      });
    }

    // No cache at all
    return res.status(200).json({
      success: false,
      error: 'Instance types not cached yet. Please click refresh to fetch from AWS.',
      needsRefresh: true
    });

  } catch (error) {
    console.error('Error accessing instance types cache:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🎨 AWS Instance Types Refresh API (Manual cache update)
app.post('/api/aws/instance-types/refresh', async (req, res) => {
  try {
    // Get current active cluster
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    // Get current AWS region
    const currentRegion = AWSHelpers.getCurrentRegion();
    console.log(`Refreshing instance types for cluster: ${activeClusterName}, region: ${currentRegion}`);

    const { families } = req.body;
    const familyFilter = families && families.length > 0 ? families : ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'];

    const instanceTypes = [];
    const errors = [];

    for (const family of familyFilter) {
      try {
        // 特殊处理 p6 家族的命名格式
        let filterPattern;
        if (family === 'p6') {
          filterPattern = 'p6-b200.*'; // p6 实例使用 p6-b200.* 格式
        } else {
          filterPattern = `${family}.*`; // 其他家族使用标准格式
        }

        // AWS CLI command to get instance types for current region
        const cmd = `aws ec2 describe-instance-types --region ${currentRegion} --filters "Name=instance-type,Values=${filterPattern}" --query "InstanceTypes[?GpuInfo.Gpus].{InstanceType:InstanceType,VCpuInfo:VCpuInfo,MemoryInfo:MemoryInfo,GpuInfo:GpuInfo}" --output json`;

        console.log(`Executing: aws ec2 describe-instance-types --region ${currentRegion} --filters "Name=instance-type,Values=${filterPattern}"`);

        const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
        const awsInstanceTypes = JSON.parse(output);

        // Transform AWS data to our format
        const transformedTypes = awsInstanceTypes
          .filter(type => type.GpuInfo && type.GpuInfo.Gpus && type.GpuInfo.Gpus.length > 0)
          .map(type => {
            const gpuInfo = type.GpuInfo.Gpus[0];
            const gpuCount = type.GpuInfo.Gpus.reduce((sum, gpu) => sum + (gpu.Count || 1), 0);
            const gpuName = gpuInfo.Name || 'GPU';

            return {
              value: type.InstanceType,
              label: type.InstanceType,
              family: family,
              vcpu: type.VCpuInfo.DefaultVCpus,
              memory: Math.round(type.MemoryInfo.SizeInMiB / 1024), // Convert to GB
              gpu: gpuCount > 1 ? `${gpuCount}x ${gpuName}` : `1x ${gpuName}`
            };
          })
          .sort((a, b) => {
            // Sort by instance size: xlarge < 2xlarge < 4xlarge etc.
            const getSize = (instanceType) => {
              const match = instanceType.match(/(\d*)xlarge/);
              return match ? (match[1] ? parseInt(match[1]) : 1) : 0;
            };
            return getSize(a.value) - getSize(b.value);
          });

        instanceTypes.push(...transformedTypes);
        console.log(`Found ${transformedTypes.length} ${family} instance types`);
      } catch (error) {
        const errorMsg = `Failed to fetch ${family} instance types: ${error.message}`;
        console.error(errorMsg);
        errors.push(errorMsg);
      }
    }

    // Prepare cache data
    const cacheData = {
      region: currentRegion,
      lastUpdated: new Date().toISOString(),
      instanceTypes: instanceTypes,
      error: errors.length > 0 ? errors.join('; ') : null,
      familiesRequested: ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'],
      totalFound: instanceTypes.length
    };

    // Save to cache
    const saved = MetadataUtils.saveInstanceTypesCache(activeClusterName, cacheData);

    if (!saved) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save instance types to cache'
      });
    }

    // Return result
    if (instanceTypes.length > 0) {
      console.log(`Successfully refreshed ${instanceTypes.length} instance types for cluster: ${activeClusterName}`);
      res.json({
        success: true,
        region: currentRegion,
        instanceTypes: instanceTypes,
        lastUpdated: cacheData.lastUpdated,
        totalFound: instanceTypes.length,
        errors: errors.length > 0 ? errors : null
      });
    } else {
      const errorMessage = errors.length > 0 ? errors.join('; ') : 'No GPU instance types found in this region';
      console.error(`No instance types found for cluster: ${activeClusterName}, errors: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage,
        region: currentRegion
      });
    }

  } catch (error) {
    console.error('Error refreshing instance types:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 🎨 Subnet-aware Instance Types API (基于子网的实例类型获取)
app.post('/api/aws/instance-types/by-subnet', async (req, res) => {
  try {
    const { subnetId } = req.body;

    if (!subnetId) {
      return res.status(400).json({
        success: false,
        error: 'subnetId is required'
      });
    }

    // Get current active cluster
    const ClusterManager = require('./cluster-manager');
    const clusterManager = new ClusterManager();
    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({
        success: false,
        error: 'No active cluster configured. Please select a cluster first.'
      });
    }

    console.log(`Fetching instance types for subnet: ${subnetId}, cluster: ${activeClusterName}`);

    // Get subnet's availability zone
    const getSubnetAZCmd = `aws ec2 describe-subnets --subnet-ids ${subnetId} --query "Subnets[0].AvailabilityZone" --output text`;
    const availabilityZone = execSync(getSubnetAZCmd, { encoding: 'utf8', timeout: 10000 }).trim();

    if (!availabilityZone || availabilityZone === 'None') {
      return res.status(400).json({
        success: false,
        error: `Subnet ${subnetId} not found or invalid`
      });
    }

    console.log(`Subnet ${subnetId} is in availability zone: ${availabilityZone}`);

    // Get current AWS region
    const currentRegion = AWSHelpers.getCurrentRegion();

    let instanceTypes = [];
    let errors = [];

    try {
      console.log(`🔍 Optimized fetch: Getting all GPU instances available in ${availabilityZone}`);

      // Step 1: 一次性获取该AZ所有可用的GPU实例类型 (更高效！)
      const azCmd = `aws ec2 describe-instance-type-offerings --location-type availability-zone --filters "Name=location,Values=${availabilityZone}" --query "InstanceTypeOfferings[?starts_with(InstanceType, 'g5.') || starts_with(InstanceType, 'g6.') || starts_with(InstanceType, 'g6e.') || starts_with(InstanceType, 'p4.') || starts_with(InstanceType, 'p5.') || starts_with(InstanceType, 'p5e.') || starts_with(InstanceType, 'p5en.') || starts_with(InstanceType, 'p6-b200.')].InstanceType" --region ${currentRegion} --output json`;

      const azOutput = execSync(azCmd, { encoding: 'utf8', timeout: 15000 });
      const availableInstanceTypeNames = JSON.parse(azOutput);

      console.log(`📊 Found ${availableInstanceTypeNames.length} GPU instance types available in ${availabilityZone}`);
      if (availableInstanceTypeNames.length > 0) {
        console.log(`🎯 Sample instances:`, availableInstanceTypeNames.slice(0, 5).join(', ') + (availableInstanceTypeNames.length > 5 ? '...' : ''));
      }

      if (availableInstanceTypeNames.length === 0) {
        console.warn(`⚠️ No GPU instance types found in ${availabilityZone}`);
        instanceTypes = [];
      } else {
        // Step 2: 获取这些实例类型的详细信息 (批量查询更高效)
        console.log(`📋 Getting detailed info for ${availableInstanceTypeNames.length} instance types...`);
        const detailsCmd = `aws ec2 describe-instance-types --region ${currentRegion} --instance-types ${availableInstanceTypeNames.join(' ')} --query "InstanceTypes[?GpuInfo.Gpus].{InstanceType:InstanceType,VCpuInfo:VCpuInfo,MemoryInfo:MemoryInfo,GpuInfo:GpuInfo}" --output json`;

        const detailsOutput = execSync(detailsCmd, { encoding: 'utf8', timeout: 25000 });
        const instanceDetails = JSON.parse(detailsOutput);

        // Step 3: 转换为我们的格式
        instanceTypes = instanceDetails
          .filter(type => type.GpuInfo && type.GpuInfo.Gpus && type.GpuInfo.Gpus.length > 0)
          .map(type => {
            const gpuInfo = type.GpuInfo.Gpus[0];
            const gpuCount = type.GpuInfo.Gpus.reduce((sum, gpu) => sum + (gpu.Count || 1), 0);
            const gpuName = gpuInfo.Name || 'GPU';

            // 确定实例系列
            let family = 'other';
            if (type.InstanceType.startsWith('g5.')) family = 'g5';
            else if (type.InstanceType.startsWith('g6e.')) family = 'g6e';
            else if (type.InstanceType.startsWith('g6.')) family = 'g6';
            else if (type.InstanceType.startsWith('p4.')) family = 'p4';
            else if (type.InstanceType.startsWith('p5en.')) family = 'p5en';
            else if (type.InstanceType.startsWith('p5e.')) family = 'p5e';
            else if (type.InstanceType.startsWith('p5.')) family = 'p5';
            else if (type.InstanceType.startsWith('p6-b200.')) family = 'p6';

            return {
              value: type.InstanceType,
              label: type.InstanceType,
              family: family,
              vcpu: type.VCpuInfo.DefaultVCpus,
              memory: Math.round(type.MemoryInfo.SizeInMiB / 1024), // Convert to GB
              gpu: gpuCount > 1 ? `${gpuCount}x ${gpuName}` : `1x ${gpuName}`,
              availabilityZone: availabilityZone,
              subnetId: subnetId
            };
          })
          .sort((a, b) => {
            // 先按系列排序，再按大小排序
            if (a.family !== b.family) {
              const familyOrder = ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'];
              return familyOrder.indexOf(a.family) - familyOrder.indexOf(b.family);
            }

            // 同系列内按实例大小排序
            const getSize = (instanceType) => {
              const match = instanceType.match(/(\d*)xlarge/);
              return match ? (match[1] ? parseInt(match[1]) : 1) : 0;
            };
            return getSize(a.value) - getSize(b.value);
          });

        console.log(`✅ Successfully processed ${instanceTypes.length} GPU instance types for ${availabilityZone}`);

        // 按系列统计
        const familyCount = {};
        instanceTypes.forEach(it => familyCount[it.family] = (familyCount[it.family] || 0) + 1);
        console.log(`📈 Instance distribution:`, Object.entries(familyCount).map(([family, count]) => `${family}:${count}`).join(', '));
      }
    } catch (error) {
      console.error(`❌ Error in optimized fetch for ${availabilityZone}:`, error.message);
      instanceTypes = [];
      errors = [error.message];
    }

    // Save to metadata cache with subnet key
    const MetadataUtils = require('./utils/metadataUtils');
    const cacheData = {
      subnetId: subnetId,
      availabilityZone: availabilityZone,
      region: currentRegion,
      lastUpdated: new Date().toISOString(),
      instanceTypes: instanceTypes,
      error: errors.length > 0 ? errors.join('; ') : null,
      familiesRequested: ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'],
      totalFound: instanceTypes.length
    };

    // Save to subnet-specific cache file
    const saved = MetadataUtils.saveSubnetInstanceTypesCache(activeClusterName, subnetId, cacheData);

    if (instanceTypes.length > 0) {
      console.log(`Successfully fetched ${instanceTypes.length} instance types for subnet: ${subnetId}`);
      res.json({
        success: true,
        subnetId: subnetId,
        availabilityZone: availabilityZone,
        region: currentRegion,
        instanceTypes: instanceTypes,
        lastUpdated: cacheData.lastUpdated,
        totalFound: instanceTypes.length,
        cached: saved,
        errors: errors.length > 0 ? errors : null
      });
    } else {
      const errorMessage = errors.length > 0 ? errors.join('; ') : `No GPU instance types found in subnet ${subnetId} (${availabilityZone})`;
      console.error(`No instance types found for subnet: ${subnetId}, errors: ${errorMessage}`);
      res.status(404).json({
        success: false,
        error: errorMessage,
        subnetId: subnetId,
        availabilityZone: availabilityZone,
        region: currentRegion
      });
    }

  } catch (error) {
    console.error('Error fetching instance types by subnet:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

console.log('AWS Instance Types API loaded');

// ==========================================
// Karpenter Management APIs
// ==========================================

const KarpenterManager = require('./utils/karpenterManager');

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

// ================================
// ==========================================
// HAMi GPU Virtualization APIs
// ==========================================

const HAMiManager = require('./utils/hamiManager');

// 安装/更新 HAMi
app.post('/api/cluster/hami/install', async (req, res) => {
  try {
    const { splitCount, nodePolicy, gpuPolicy, nodeName } = req.body;
    const activeCluster = clusterManager.getActiveCluster();

    console.log(`Installing HAMi for cluster: ${activeCluster}`);

    const result = await HAMiManager.installHAMi({
      splitCount,
      nodePolicy,
      gpuPolicy,
      nodeName
    });

    // 保存配置到 metadata
    HAMiManager.saveConfig(activeCluster, {
      splitCount,
      nodePolicy,
      gpuPolicy,
      nodeName
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

// 检查 HAMi 状态
app.get('/api/cluster/hami/status', async (req, res) => {
  try {
    const status = HAMiManager.checkStatus();
    res.json(status);
  } catch (error) {
    console.error('HAMi status check error:', error);
    res.status(500).json({ 
      installed: false, 
      error: error.message 
    });
  }
});

// 重置节点的 HAMi 配置
app.post('/api/cluster/hami/reset', async (req, res) => {
  try {
    const { nodeName } = req.body;
    
    if (!nodeName) {
      return res.status(400).json({
        success: false,
        message: 'Node name is required'
      });
    }

    console.log(`Resetting HAMi for node: ${nodeName}`);
    const result = await HAMiManager.resetNodeHAMi(nodeName);
    
    res.json(result);
  } catch (error) {
    console.error('HAMi reset error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// KEDA Auto Scaling APIs
// ================================

const KedaManager = require('./utils/kedaManager');

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

// 删除 ScaledObject
app.delete('/api/keda/scaledobject/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { namespace = 'default' } = req.query;

    const result = await KedaManager.deleteScaledObject(name, namespace);

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

// 获取可用的 Deployments
app.get('/api/deployments', async (req, res) => {
  try {
    const { execSync } = require('child_process');

    // 获取所有 deployments
    const deploymentCmd = 'kubectl get deployments --all-namespaces -o json';
    const result = execSync(deploymentCmd, { encoding: 'utf8' });
    const deployments = JSON.parse(result);

    const formattedDeployments = deployments.items.map(deployment => ({
      name: deployment.metadata.name,
      namespace: deployment.metadata.namespace,
      replicas: deployment.status.replicas || 0,
      readyReplicas: deployment.status.readyReplicas || 0,
      creationTime: deployment.metadata.creationTimestamp
    }));

    res.json({
      success: true,
      deployments: formattedDeployments
    });
  } catch (error) {
    console.error('Error getting deployments:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      deployments: []
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
