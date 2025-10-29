// 🎨 PREVIEW ONLY - Example API handlers for Advanced Scaling
// This file shows how to implement the backend APIs for the Advanced Scaling feature

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const AWSHelpers = require('./utils/awsHelpers');

// Example API handler for fetching AWS instance types
const handleGetInstanceTypes = async (req, res) => {
  try {
    const { families } = req.query; // e.g., "g5,g6,g6e,p4,p5,p5e,p5en,p6"

    // Get current AWS region using awsHelpers
    const currentRegion = AWSHelpers.getCurrentRegion();

    console.log(`Fetching instance types for region: ${currentRegion}`);

    // GPU instance family filters
    const familyFilter = families ? families.split(',').map(f => f.trim()) : ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6'];

    const instanceTypes = [];

    for (const family of familyFilter) {
      try {
        // AWS CLI command to get instance types for current region
        const cmd = `aws ec2 describe-instance-types --region ${currentRegion} --filters "Name=instance-type,Values=${family}.*" --query "InstanceTypes[?GpuInfo.Gpus].{InstanceType:InstanceType,VCpuInfo:VCpuInfo,MemoryInfo:MemoryInfo,GpuInfo:GpuInfo}" --output json`;

        console.log(`Executing: aws ec2 describe-instance-types --region ${currentRegion} --filters "Name=instance-type,Values=${family}.*"`);

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
        console.warn(`Failed to fetch ${family} instance types:`, error.message);
      }
    }

    if (instanceTypes.length > 0) {
      console.log(`Total instance types found: ${instanceTypes.length}`);
      res.json({
        success: true,
        region: currentRegion,
        instanceTypes: instanceTypes
      });
    } else {
      console.warn('No instance types found, returning minimal fallback');
      res.json({
        success: true,
        region: currentRegion,
        instanceTypes: getMinimalFallbackTypes(),
        fallback: true
      });
    }

  } catch (error) {
    console.error('Error fetching instance types:', error);
    res.json({
      success: false,
      error: error.message,
      instanceTypes: getMinimalFallbackTypes(),
      fallback: true
    });
  }
};

// Example API handler for deploying advanced scaling stack
const handleDeployAdvancedScaling = async (req, res) => {
  try {
    const config = req.body;
    console.log('Received advanced scaling config:', JSON.stringify(config, null, 2));

    // 1. Generate Karpenter configuration
    const karpenterYaml = generateKarpenterYaml(config.karpenter);

    // 2. Generate SGLang Router configuration
    const routerYaml = generateSGLangRouterYaml(config.sglangRouter);

    // 3. Generate Model Deployment configuration
    const modelYaml = generateModelDeploymentYaml(config.modelDeployment, config.sglangRouter);

    // 4. Write YAML files to temp directory
    const tempDir = path.join(__dirname, '../tmp/advanced-scaling');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const karpenterFile = path.join(tempDir, `karpenter-${timestamp}.yaml`);
    const routerFile = path.join(tempDir, `sglang-router-${timestamp}.yaml`);
    const modelFile = path.join(tempDir, `model-deployment-${timestamp}.yaml`);

    fs.writeFileSync(karpenterFile, karpenterYaml);
    fs.writeFileSync(routerFile, routerYaml);
    fs.writeFileSync(modelFile, modelYaml);

    // 5. Apply configurations with kubectl
    try {
      execSync(`kubectl apply -f ${karpenterFile}`, { encoding: 'utf8' });
      console.log('✅ Karpenter configuration applied');

      execSync(`kubectl apply -f ${routerFile}`, { encoding: 'utf8' });
      console.log('✅ SGLang Router deployed');

      execSync(`kubectl apply -f ${modelFile}`, { encoding: 'utf8' });
      console.log('✅ Model deployment created');

      res.json({
        success: true,
        message: 'Advanced scaling stack deployed successfully',
        deployedComponents: {
          karpenter: true,
          sglangRouter: true,
          modelDeployment: true
        },
        files: {
          karpenter: karpenterFile,
          router: routerFile,
          model: modelFile
        }
      });

    } catch (kubectlError) {
      console.error('kubectl error:', kubectlError.message);
      res.json({
        success: false,
        error: `Deployment failed: ${kubectlError.message}`,
        files: {
          karpenter: karpenterFile,
          router: routerFile,
          model: modelFile
        }
      });
    }

  } catch (error) {
    console.error('Error deploying advanced scaling:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
};

// Helper function to generate Karpenter YAML
const generateKarpenterYaml = (karpenterConfig) => {
  const { instanceTypes, onDemandWeight, spotWeight } = karpenterConfig;

  let yaml = `---
# Karpenter NodeClass
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-nodeclass-advanced
spec:
  role: "KarpenterNodeRole-\${CLUSTER_NAME}"
  amiSelectorTerms:
    - alias: "al2023@latest"
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "\${CLUSTER_NAME}"
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "\${CLUSTER_NAME}"
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        deleteOnTermination: true
        encrypted: true

---
# Priority Classes
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority-ondemand
value: 1000
globalDefault: false
description: "High priority for pods on on-demand nodes"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: medium-priority-spot
value: 800
globalDefault: false
description: "Medium priority for pods on spot nodes"
`;

  // Add NodePools based on weights
  if (onDemandWeight > 0) {
    yaml += `
---
# On-Demand NodePool
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-nodepool-ondemand-advanced
spec:
  template:
    metadata:
      labels:
        node-type: gpu
        capacity-type: on-demand
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-type
          operator: In
          values: [${instanceTypes.map(t => `"${t}"`).join(', ')}]
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu-nodeclass-advanced
      taints:
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule
  limits:
    nvidia.com/gpu: 20
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30s
  weight: ${onDemandWeight}`;
  }

  if (spotWeight > 0) {
    yaml += `
---
# Spot NodePool
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-nodepool-spot-advanced
spec:
  template:
    metadata:
      labels:
        node-type: gpu
        capacity-type: spot
    spec:
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-type
          operator: In
          values: [${instanceTypes.map(t => `"${t}"`).join(', ')}]
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu-nodeclass-advanced
      taints:
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule
  limits:
    nvidia.com/gpu: 50
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30s
  weight: ${spotWeight}`;
  }

  return yaml;
};

// Helper function to generate SGLang Router YAML
const generateSGLangRouterYaml = (routerConfig) => {
  const { routingPolicy, routerPort, metricsPort } = routerConfig;

  return `---
# ServiceAccount for Router
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sglang-router-advanced
  namespace: default

---
# ClusterRole for Pod discovery
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sglang-router-advanced
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]

---
# ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sglang-router-advanced
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: sglang-router-advanced
subjects:
- kind: ServiceAccount
  name: sglang-router-advanced
  namespace: default

---
# Router Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sglang-router-advanced
  labels:
    app: sglang-router-advanced
    model-type: "sglang-router"
    service-type: "router"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sglang-router-advanced
  template:
    metadata:
      labels:
        app: sglang-router-advanced
        model-type: "sglang-router"
        service-type: "router"
    spec:
      serviceAccountName: sglang-router-advanced
      priorityClassName: high-priority-ondemand

      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: capacity-type
                operator: NotIn
                values: ["spot"]

      tolerations:
        - key: "nvidia.com/gpu"
          value: "true"
          operator: "Equal"
          effect: "NoSchedule"

      containers:
        - name: sglang-router
          image: lmsysorg/sglang:latest
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "4"
              memory: 8Gi
          command: ["python3", "-m", "sglang_router.launch_router"]
          args:
            - "--service-discovery"
            - "--selector"
            - "app=sglang-model-advanced"
            - "--service-discovery-port"
            - "8000"
            - "--policy"
            - "${routingPolicy}"
            - "--host"
            - "0.0.0.0"
            - "--port"
            - "${routerPort}"
            - "--prometheus-port"
            - "${metricsPort}"
          ports:
            - containerPort: ${routerPort}
              name: http
            - containerPort: ${metricsPort}
              name: metrics
          env:
            - name: RUST_LOG
              value: "info"

---
# Router Service
apiVersion: v1
kind: Service
metadata:
  name: sglang-router-advanced-service
  labels:
    app: sglang-router-advanced
    model-type: "sglang-router"
    service-type: "router"
spec:
  type: ClusterIP
  selector:
    app: sglang-router-advanced
  ports:
  - name: http
    port: ${routerPort}
    targetPort: ${routerPort}
    protocol: TCP
  - name: metrics
    port: ${metricsPort}
    targetPort: ${metricsPort}
    protocol: TCP`;
};

// Helper function to generate Model Deployment YAML
const generateModelDeploymentYaml = (modelConfig, routerConfig) => {
  const {
    image = 'lmsysorg/sglang:latest',
    modelPath = '/s3/model/',
    port = 8000,
    replicas = 3,
    tpSize = 1,
    cpuRequest = 4,
    memoryRequest = 16,
    additionalArgs = ''
  } = modelConfig;

  const spotWeight = routerConfig.spotWeight || 0;
  const onDemandWeight = routerConfig.onDemandWeight || 0;

  // Determine priority class based on weights
  const priorityClass = spotWeight > onDemandWeight ? 'medium-priority-spot' : 'high-priority-ondemand';

  return `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sglang-model-advanced
  labels:
    app: sglang-model-advanced
    model-type: "sglang"
    service-type: "inference"
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: sglang-model-advanced
  template:
    metadata:
      labels:
        app: sglang-model-advanced
        model-type: "sglang"
        service-type: "inference"
    spec:
      priorityClassName: ${priorityClass}

      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          ${spotWeight > onDemandWeight ? `
          - weight: 1000
            preference:
              matchExpressions:
              - key: capacity-type
                operator: In
                values: ["spot"]
          - weight: 800
            preference:
              matchExpressions:
              - key: capacity-type
                operator: In
                values: ["on-demand"]` : `
          - weight: 1000
            preference:
              matchExpressions:
              - key: capacity-type
                operator: In
                values: ["on-demand"]
          - weight: 800
            preference:
              matchExpressions:
              - key: capacity-type
                operator: In
                values: ["spot"]`}

          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: node-type
                operator: In
                values: ["gpu"]
              - key: nvidia.com/gpu.present
                operator: In
                values: ["true"]

      containers:
        - name: sglang
          image: ${image}
          resources:
            requests:
              cpu: "${cpuRequest}"
              memory: ${memoryRequest}Gi
              nvidia.com/gpu: 1
            limits:
              cpu: "${cpuRequest * 2}"
              memory: ${memoryRequest * 2}Gi
              nvidia.com/gpu: 1
          command:
            - "python3"
            - "-m"
            - "sglang.launch_server"
            - "--model-path"
            - "${modelPath}"
            - "--tp-size"
            - "${tpSize}"
            - "--host"
            - "0.0.0.0"
            - "--port"
            - "${port}"
            - "--trust-remote-code"
            ${additionalArgs ? `- "${additionalArgs}"` : ''}
          ports:
            - containerPort: ${port}
              name: http
          volumeMounts:
            - name: persistent-storage-s3
              mountPath: /s3
              readOnly: true
            - name: local-cache
              mountPath: /root/.cache
            - name: shm
              mountPath: /dev/shm
          env:
            - name: TRANSFORMERS_CACHE
              value: "/root/.cache/huggingface"
          securityContext:
            capabilities:
              add:
                - IPC_LOCK

      volumes:
        - name: persistent-storage-s3
          persistentVolumeClaim:
            claimName: s3-claim
        - name: local-cache
          hostPath:
            path: /opt/dlami/nvme/.cache
            type: DirectoryOrCreate
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 2Gi

      tolerations:
        - key: "nvidia.com/gpu"
          value: "true"
          operator: "Equal"
          effect: "NoSchedule"`;
};

// Helper function for minimal fallback instance types (based on actual AWS API results)
const getMinimalFallbackTypes = () => {
  return [
    // G5 系列 - NVIDIA A10G (实际可用的实例类型)
    { value: 'g5.xlarge', label: 'g5.xlarge', family: 'g5', vcpu: 4, memory: 16, gpu: '1x A10G' },
    { value: 'g5.2xlarge', label: 'g5.2xlarge', family: 'g5', vcpu: 8, memory: 32, gpu: '1x A10G' },
    { value: 'g5.4xlarge', label: 'g5.4xlarge', family: 'g5', vcpu: 16, memory: 64, gpu: '1x A10G' },
    { value: 'g5.8xlarge', label: 'g5.8xlarge', family: 'g5', vcpu: 32, memory: 128, gpu: '1x A10G' },
    { value: 'g5.12xlarge', label: 'g5.12xlarge', family: 'g5', vcpu: 48, memory: 192, gpu: '4x A10G' },
    { value: 'g5.16xlarge', label: 'g5.16xlarge', family: 'g5', vcpu: 64, memory: 256, gpu: '1x A10G' },
    { value: 'g5.24xlarge', label: 'g5.24xlarge', family: 'g5', vcpu: 96, memory: 384, gpu: '4x A10G' },
    { value: 'g5.48xlarge', label: 'g5.48xlarge', family: 'g5', vcpu: 192, memory: 768, gpu: '8x A10G' },

    // G6 系列 - NVIDIA L4 (实际可用的实例类型)
    { value: 'g6.xlarge', label: 'g6.xlarge', family: 'g6', vcpu: 4, memory: 16, gpu: '1x L4' },
    { value: 'g6.2xlarge', label: 'g6.2xlarge', family: 'g6', vcpu: 8, memory: 32, gpu: '1x L4' },
    { value: 'g6.4xlarge', label: 'g6.4xlarge', family: 'g6', vcpu: 16, memory: 64, gpu: '1x L4' },
    { value: 'g6.8xlarge', label: 'g6.8xlarge', family: 'g6', vcpu: 32, memory: 128, gpu: '1x L4' },
    { value: 'g6.12xlarge', label: 'g6.12xlarge', family: 'g6', vcpu: 48, memory: 192, gpu: '4x L4' },
    { value: 'g6.16xlarge', label: 'g6.16xlarge', family: 'g6', vcpu: 64, memory: 256, gpu: '1x L4' },
    { value: 'g6.24xlarge', label: 'g6.24xlarge', family: 'g6', vcpu: 96, memory: 384, gpu: '4x L4' },
    { value: 'g6.48xlarge', label: 'g6.48xlarge', family: 'g6', vcpu: 192, memory: 768, gpu: '8x L4' },

    // P4d 系列 - NVIDIA A100 (注意：可能不是所有region都有)
    { value: 'p4d.24xlarge', label: 'p4d.24xlarge', family: 'p4', vcpu: 96, memory: 1152, gpu: '8x A100' },

    // P5 系列 - NVIDIA H100 (实际可用的实例类型)
    { value: 'p5.4xlarge', label: 'p5.4xlarge', family: 'p5', vcpu: 16, memory: 256, gpu: '1x H100' },
    { value: 'p5.48xlarge', label: 'p5.48xlarge', family: 'p5', vcpu: 192, memory: 2048, gpu: '8x H100' },

    // P5e 系列 - NVIDIA H200 (实际测试结果)
    { value: 'p5e.48xlarge', label: 'p5e.48xlarge', family: 'p5e', vcpu: 192, memory: 2048, gpu: '8x H200' },

    // P5en 系列 - NVIDIA H200 (Enhanced networking)
    { value: 'p5en.48xlarge', label: 'p5en.48xlarge', family: 'p5en', vcpu: 192, memory: 2048, gpu: '8x H200' }

    // 注意：P6系列和G6e系列在某些region可能不可用，因此不包含在fallback中
  ];
};

module.exports = {
  handleGetInstanceTypes,
  handleDeployAdvancedScaling
};

// Example of how to add these to your express app:
/*
app.get('/api/aws/instance-types', handleGetInstanceTypes);
app.post('/api/deploy-advanced-scaling', handleDeployAdvancedScaling);
*/