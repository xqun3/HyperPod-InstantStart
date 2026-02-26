/**
 * Deployment Manager
 *
 * 管理推理服务部署相关的 API：
 * - 部署/卸载/扩缩容
 * - 部署详情查询
 * - Service 管理
 * - 模型测试
 *
 * 从 index.js 迁移，Phase 1.2
 * 创建日期: 2025-01-07
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const {
  generateNLBAnnotations,
  parseInferenceCommand,
  makeHttpRequest,
  generateDeploymentTag,
  generateHybridNodeSelectorTerms,
  generateResourcesSection
} = require('./utils/inferenceUtils');
const EKSServiceHelper = require('./utils/eksServiceHelper');

// 依赖注入
let broadcast = null;
let executeKubectl = null;

/**
 * 初始化模块依赖
 */
function initialize(deps) {
  broadcast = deps.broadcast;
  executeKubectl = deps.executeKubectl;
}

// ============================================================
// API 路由
// ============================================================

/**
 * POST /api/test-model
 * 生成测试模型的 curl 命令
 */
router.post('/test-model', async (req, res) => {
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

/**
 * GET /api/binding-services
 * 获取所有绑定 Service 列表
 */
router.get('/binding-services', async (req, res) => {
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

/**
 * POST /api/undeploy
 * 卸载部署（Deployment + 关联的 Service）
 */
router.post('/undeploy', async (req, res) => {
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
      const knownEngines = ['vllm', 'sglang', 'hypd-custom'];
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

/**
 * POST /api/scale-deployment
 * 扩缩容 Deployment
 */
router.post('/scale-deployment', async (req, res) => {
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

/**
 * POST /api/assign-pod
 * Pod 分配管理 - 将 Pod 分配给业务标签
 */
router.post('/assign-pod', async (req, res) => {
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

/**
 * DELETE /api/delete-service/:serviceName
 * 删除 Service 并重置关联 Pod 的 business 标签
 */
router.delete('/delete-service/:serviceName', async (req, res) => {
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

/**
 * GET /api/deployments
 * 获取所有 Deployment 列表（包括 Router）
 */
router.get('/deployments', async (req, res) => {
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
      // KEDA 未安装时静默处理
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

/**
 * POST /api/deploy-service
 * 部署绑定 Service（将业务 Service 绑定到 Model Pool）
 */
router.post('/deploy-service', async (req, res) => {
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

/**
 * GET /api/inference-endpoints
 * 获取所有 InferenceEndpointConfig 资源
 */
router.get('/inference-endpoints', async (req, res) => {
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
      console.log('No InferenceEndpointConfig found or error:', error.message);

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

/**
 * DELETE /api/inference-endpoints/:name
 * 删除指定的 InferenceEndpointConfig
 */
router.delete('/inference-endpoints/:name', async (req, res) => {
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

/**
 * GET /api/sglang-deployments
 * 获取所有 SGLang 类型的 Deployment（用于 Router 配置）
 */
router.get('/sglang-deployments', async (req, res) => {
  try {
    // 获取所有SGLang类型的deployment
    const deployResult = await executeKubectl('get deployments -l model-type=sglang -o json');
    const deployments = JSON.parse(deployResult);

    // 获取所有SGLang类型的service
    const serviceResult = await executeKubectl('get services -l model-type=sglang -o json');
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

// ============================================================
// Container 部署 API (vLLM/SGLang/Custom)
// ============================================================

/**
 * POST /api/deploy/container
 * Container 推理部署 (vLLM/SGLang/Custom)
 *
 * 支持 serviceType: external, clusterip, modelpool
 * 支持混合调度: HyperPod + EKS NodeGroup + Karpenter
 */
router.post('/deploy/container', async (req, res) => {
  try {
    const {
      replicas,
      huggingFaceToken,
      deploymentCommand,
      gpuCount,
      gpuMemory = -1,
      instanceTypes = [],
      serviceType = 'external',
      deploymentName,
      dockerImage = 'vllm/vllm-openai:latest',
      port = 8000,
      cpuRequest = -1,
      memoryRequest = -1
    } = req.body;

    console.log('Container deployment request:', {
      deploymentName,
      replicas,
      instanceTypes,
      serviceType,
      dockerImage,
      gpuCount,
      gpuMemory,
      cpuRequest,
      memoryRequest,
      port
    });

    // 生成带时间戳的唯一标签
    const finalDeploymentTag = generateDeploymentTag(deploymentName || 'model');
    console.log(`Generated deployment tag: "${finalDeploymentTag}"`);

    // 根据 serviceType 确定访问类型
    const isExternal = serviceType === 'external';
    const deployAsPool = serviceType === 'modelpool';

    // 生成 NLB 注解
    const nlbAnnotations = generateNLBAnnotations(isExternal);

    // 生成混合调度节点选择器
    const hybridNodeSelectorTerms = generateHybridNodeSelectorTerms(instanceTypes);
    console.log('Generated hybrid node selector terms');

    // 处理部署命令
    let parsedCommand = null;
    let servEngine = 'hypd-custom';
    let commandYaml = '# Using image default ENTRYPOINT/CMD';

    if (deploymentCommand && deploymentCommand.trim()) {
      // 有命令：解析并生成 command 字段
      parsedCommand = parseInferenceCommand(deploymentCommand);
      console.log('Parsed command:', parsedCommand);

      // 确定服务引擎类型
      if (parsedCommand.commandType === 'sglang') {
        servEngine = 'sglang';
      } else if (parsedCommand.commandType === 'vllm') {
        servEngine = 'vllm';
      } else {
        servEngine = 'hypd-custom';
      }

      // 生成 command YAML
      commandYaml = `command: ${JSON.stringify(parsedCommand.fullCommand)}`;
    } else {
      // 无命令：使用镜像默认 ENTRYPOINT/CMD
      console.log('No command specified, using image default ENTRYPOINT/CMD');
    }
    console.log(`Using service engine: ${servEngine}`);

    // 加载并解析模板
    const templatePath = path.join(__dirname, '../templates/inference-container-hybrid-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');
    const YAML = require('yaml');
    const deployment = YAML.parse(templateContent);

    // 基本信息（对象操作）
    const appName = `${servEngine}-${finalDeploymentTag}-inference`;
    deployment.metadata.name = appName;
    deployment.metadata.labels.app = appName;
    deployment.metadata.labels['model-type'] = servEngine;
    deployment.metadata.labels['deployment-tag'] = finalDeploymentTag;
    
    deployment.spec.selector.matchLabels.app = appName;
    deployment.spec.replicas = replicas;

    // Pod 模板 labels
    const podLabels = deployment.spec.template.metadata.labels;
    podLabels.app = appName;
    podLabels['model-type'] = servEngine;

    // HAMi label（按需添加）
    if (gpuMemory === -1) {
      podLabels['hami.io/webhook'] = 'ignore';
    }

    // Container 配置
    const container = deployment.spec.template.spec.containers[0];
    container.name = servEngine;
    container.image = dockerImage;
    container.ports[0].containerPort = port || 8000;

    // Resources（对象操作）
    container.resources = generateResourcesSection({ gpuCount, gpuMemory, cpuRequest, memoryRequest });

    // Command（按需添加）
    if (parsedCommand) {
      container.command = parsedCommand.fullCommand;
    }

    // HuggingFace Token（按需添加）
    if (huggingFaceToken?.trim()) {
      container.env.unshift({
        name: 'HUGGING_FACE_HUB_TOKEN',
        value: huggingFaceToken
      });
    }

    // NodeSelector Terms（对象操作）
    const nodeSelectorTerms = generateHybridNodeSelectorTerms(instanceTypes);
    deployment.spec.template.spec.affinity.nodeAffinity
      .requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms = nodeSelectorTerms;

    // Model Pool 标签（按需添加）
    if (deployAsPool) {
      deployment.metadata.labels['model-id'] = finalDeploymentTag;
      deployment.metadata.labels['deployment-type'] = 'model-pool';
      
      podLabels['model-id'] = finalDeploymentTag;
      podLabels['business'] = 'unassigned';
      podLabels['deployment-type'] = 'model-pool';
    }

    let newYamlContent = YAML.stringify(deployment, { blockQuote: 'literal', lineWidth: 0 });

    // 生成 Service YAML (非 modelpool 模式)
    if (!deployAsPool) {
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
      }
    }

    // 保存 YAML 文件
    const deploymentsDir = path.join(__dirname, '../deployments/inference');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const accessType = isExternal ? 'external' : 'internal';
    const poolType = deployAsPool ? 'pool' : 'standard';
    const tempYamlPath = path.join(deploymentsDir, `${finalDeploymentTag}-${servEngine}-${poolType}-${accessType}.yaml`);
    await fs.writeFile(tempYamlPath, newYamlContent);
    console.log(`Generated YAML saved to: ${tempYamlPath}`);

    // 执行 kubectl apply
    const applyOutput = await executeKubectl(`apply -f ${tempYamlPath}`);

    // 广播部署状态
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
      message: 'Container deployment successful',
      output: applyOutput,
      yamlPath: tempYamlPath,
      generatedYaml: newYamlContent,
      deploymentType: servEngine,
      deploymentTag: finalDeploymentTag,
      accessType
    });

  } catch (error) {
    console.error('Container deployment error:', error);

    broadcast({
      type: 'deployment',
      status: 'error',
      message: `Container deployment failed: ${error.message}`
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// Managed Inference 部署 API (Inference Operator)
// ============================================================

/**
 * POST /api/deploy/managed-inference
 * Managed Inference 部署 (SageMaker Inference Operator CRD)
 *
 * 支持 serviceType: external, internal
 * 支持: KV Cache, Intelligent Routing, Auto-Scaling
 */
router.post('/deploy/managed-inference', async (req, res) => {
  try {
    const {
      replicas,
      gpuCount,
      gpuMemory = -1,
      serviceType = 'external',
      deploymentName,
      dockerImage,
      port = 8000,
      cpuRequest = -1,
      memoryRequest = -1,
      // Managed Inference 专用字段
      instanceType,
      s3BucketName,
      s3Region,
      modelLocation,
      workerCommand,
      // KV Cache and Intelligent Routing
      kvCache,
      intelligentRouting,
      // Auto-Scaling
      autoScaling
    } = req.body;

    console.log('Managed Inference deployment request:', {
      deploymentName,
      instanceType,
      replicas,
      serviceType,
      dockerImage,
      gpuCount,
      s3BucketName,
      modelLocation,
      kvCache: kvCache ? 'configured' : 'none',
      intelligentRouting: intelligentRouting?.enabled ? 'enabled' : 'disabled',
      autoScaling: autoScaling?.enabled ? 'enabled' : 'disabled'
    });

    // 验证必需字段
    if (!deploymentName || !instanceType || !s3BucketName || !s3Region || !modelLocation) {
      throw new Error('Missing required fields: deploymentName, instanceType, s3BucketName, s3Region, modelLocation');
    }

    // 生成带时间戳的唯一标签
    const finalDeploymentTag = generateDeploymentTag(deploymentName);
    console.log(`Generated deployment tag: "${finalDeploymentTag}"`);

    // 根据 serviceType 确定访问类型
    const isExternal = serviceType === 'external';

    // 生成 NLB 注解
    const nlbAnnotations = generateNLBAnnotations(isExternal);

    // 加载模板
    const templatePath = path.join(__dirname, '../templates/managed-inference-template.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf8');

    // 解析 workerCommand
    const parsedCommand = parseInferenceCommand(workerCommand);
    console.log('Parsed managed inference command:', parsedCommand);

    // 生成 worker args YAML
    let workerArgsYaml = '';
    let argsToUse = [];
    if (parsedCommand.commandType === 'vllm') {
      argsToUse = parsedCommand.args || [];
      console.log('Using args only for vLLM (ENTRYPOINT exists)');
    } else {
      argsToUse = parsedCommand.fullCommand || [];
      console.log('Using full command for non-vLLM');
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
    let cpuRequestYaml = '';
    let memoryRequestYaml = '';
    if (cpuRequest && cpuRequest !== -1 && cpuRequest > 0) {
      cpuRequestYaml = `\n        cpu: "${cpuRequest}"`;
    }
    if (memoryRequest && memoryRequest !== -1 && memoryRequest > 0) {
      memoryRequestYaml = `\n        memory: ${memoryRequest}Gi`;
    }

    // HAMi label 不适用于 Managed Inference
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
        const l2Backend = kvCache.l2CacheBackend || 'tieredstorage';
        kvCacheSpecYaml += `\n      l2CacheBackend: "${l2Backend}"`;
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

    // 处理 Session Key 环境变量
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

    // 替换模板占位符
    let newYamlContent = templateContent
      .replace(/DEPLOYMENT_NAME/g, finalDeploymentTag)
      .replace(/MODEL_NAME/g, deploymentName)
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
    if (isExternal) {
      const serviceYaml = EKSServiceHelper.generateManagedInferenceService(
        finalDeploymentTag,
        serviceType,
        port,
        nlbAnnotations
      );
      newYamlContent += serviceYaml;
      console.log('Generated external Service for managed inference');
    } else {
      console.log('Internal mode: using Inference Operator routing-service');
    }

    const servEngine = 'managed-inf';

    // 保存 YAML 文件
    const deploymentsDir = path.join(__dirname, '../deployments/inference');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const accessType = isExternal ? 'external' : 'internal';
    const tempYamlPath = path.join(deploymentsDir, `${finalDeploymentTag}-${servEngine}-standard-${accessType}.yaml`);
    await fs.writeFile(tempYamlPath, newYamlContent);
    console.log(`Generated YAML saved to: ${tempYamlPath}`);

    // 执行 kubectl apply
    const applyOutput = await executeKubectl(`apply -f ${tempYamlPath}`);

    // 广播部署状态
    broadcast({
      type: 'deployment',
      status: 'success',
      message: `Successfully deployed managed inference: ${finalDeploymentTag} (${accessType} access)`,
      output: applyOutput
    });

    res.json({
      success: true,
      message: 'Managed inference deployment successful',
      output: applyOutput,
      yamlPath: tempYamlPath,
      generatedYaml: newYamlContent,
      deploymentType: servEngine,
      deploymentTag: finalDeploymentTag,
      accessType
    });

  } catch (error) {
    console.error('Managed inference deployment error:', error);

    broadcast({
      type: 'deployment',
      status: 'error',
      message: `Managed inference deployment failed: ${error.message}`
    });

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = {
  router,
  initialize
};
