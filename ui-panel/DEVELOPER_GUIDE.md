# HyperPod InstantStart Developer Guide

## 🎯 项目概览

HyperPod InstantStart 是一个基于 AWS EKS 和 SageMaker HyperPod 的机器学习平台管理系统，提供集群创建、依赖管理、模型推理和训练作业的统一管理界面。

### 核心价值
- **快速集群创建**: EKS 集群创建时间从 15-20 分钟优化到 8-12 分钟
- **解耦架构**: 集群创建与依赖配置完全分离，提升用户体验
- **统一管理**: 支持多集群管理、实时状态监控和 WebSocket 通信

## 📁 项目结构

```
HyperPod-InstantStart-BASE/
├── ui-panel/                    # 🎨 Web UI 主应用
│   ├── client/                  # React 前端
│   ├── server/                  # Node.js 后端
│   ├── templates/               # Kubernetes 模板
│   └── managed_clusters_info/   # 集群元数据存储
├── cli-min/                     # 🛠️ CloudFormation 模板
├── train-recipes/               # 🚀 训练作业模板
├── model-pool-manager/          # 🤖 模型池管理
└── resources/                   # 📚 文档资源
```

## 🏗️ 核心模块架构

### 1. Web UI 应用 (`ui-panel/`)

#### 前端架构 (`client/src/`)
```
components/
├── ClusterManagement.js         # 集群管理主界面
├── EksClusterCreationPanel.js   # EKS 集群创建
├── NodeGroupManager.js          # 节点组管理
├── TrainingHistoryPanel.js      # 训练历史和 MLflow
└── InferencePanel.js           # 模型推理管理
```

#### 后端架构 (`server/`)
```
server/
├── index.js                    # 主服务器 (231KB - 核心 API)
├── multi-cluster-apis.js       # 多集群管理 API
├── cluster-manager.js          # 集群状态管理
├── utils/                      # 工具模块
│   ├── cloudFormationManager.js
│   ├── mlflowTrackingServerManager.js
│   └── awsHelpers.js
└── templates/                  # Kubernetes 模板
```

### 2. 基础设施模板 (`cli-min/`)
```
cli-min/
├── 1-main-stack-eks-control.yaml  # EKS 控制平面 CloudFormation
└── 2-hypd-compute.yaml            # HyperPod 计算节点模板
```

### 3. 训练作业模板 (`train-recipes/`)
```
train-recipes/
├── llama-factory-project/      # LLaMA Factory 训练
├── torch-project-*/           # PyTorch 训练项目
├── verl-project/              # VERL 强化学习
└── docker-build-training-op/  # 训练容器构建
```

## 🔧 核心功能模块

### 集群管理模块

#### 功能特性
- **EKS 集群**: 创建、导入、删除、多集群切换
- **HyperPod 集群**: 创建、扩展实例组、状态监控
- **依赖管理**: 独立配置 Kubernetes 组件
- **实时状态**: 60秒定时检查 + WebSocket 通知
- **Metadata 管理**: 分阶段保存集群信息，完整生命周期跟踪

#### 关键实现文件
| 功能 | 前端组件 | 后端 API | 说明 |
|------|----------|----------|------|
| 集群创建 | `EksClusterCreationPanel.js` | `/api/cluster/create` | CloudFormation 自动化 |
| 集群导入 | `ClusterManagement.js` | `/api/cluster/import` | 现有集群接入 |
| 依赖配置 | `NodeGroupManager.js` | `/api/cluster/configure-dependencies` | 独立依赖安装 |
| 状态检查 | - | `clusterStatusCheckInterval` | 定时状态更新 |
| Metadata 管理 | - | `registerCompletedCluster()` | 集群信息保存 |

#### Metadata 保存机制

**分阶段保存策略**:
1. **创建阶段**: 点击Create Cluster时立即保存用户输入、CIDR配置、创建状态
2. **完成阶段**: CloudFormation CREATE_COMPLETE时自动保存完整集群信息和CloudFormation输出
3. **运行阶段**: 持续更新依赖状态、节点组信息、HyperPod集群关联

**保存的信息类型**:
- **用户输入信息**: 集群标签、AWS区域、自定义CIDR等表单数据
- **CIDR配置**: 自动生成的VPC和子网CIDR分配
- **CloudFormation信息**: Stack名称、ID、状态、参数、输出
- **EKS集群信息**: 集群名称、ARN、VPC ID、安全组、子网、S3存储桶等资源信息
- **HyperPod集群信息**: SageMaker API完整数据，包含Instance Groups、计算节点子网等
- **集群基本信息**: 类型、状态、创建时间、来源标识
- **依赖配置状态**: 各组件安装状态、配置历史
- **环境变量配置**: init_envs文件，包含所有必要的环境变量
- **导入集群资源**: 通过AWS CLI获取的VPC、安全组、子网等基础设施信息

**CloudFormation输出获取**:
- **触发时机**: EKS集群创建完成时自动触发
- **获取内容**: VPC ID、安全组ID、EKS集群ARN、S3存储桶名称等
- **保存位置**: 
  - `cluster_info.json`: 结构化的EKS集群信息
  - `creation_metadata.json`: 完整的CloudFormation输出数据
- **容错机制**: 获取失败不阻断集群注册流程

**导入集群资源获取**:
- **触发时机**: 集群导入过程中自动执行
- **获取方式**: 通过AWS CLI调用EKS API获取集群资源信息
- **获取内容**: VPC ID、安全组ID、子网信息、IAM角色、S3存储桶等
- **格式对齐**: 转换为与创建集群相同的CloudFormation输出格式
- **统一处理**: 使用相同的metadata结构和依赖配置链路

**HyperPod集群信息获取**:
- **触发时机**: HyperPod创建完成或集群导入时检测到HyperPod
- **获取方式**: 通过SageMaker API获取完整集群信息
- **保存内容**: 完整的SageMaker API原始数据 + 来源标识(ui-created/imported)
- **包含信息**: Instance Groups详情、计算节点子网、VPC配置、执行角色等
- **统一结构**: 创建和导入的HyperPod使用相同的数据格式

**目录结构**:
```
managed_clusters_info/
├── {clusterTag}/
│   ├── metadata/           # 核心元数据
│   │   ├── cluster_info.json          # 主要集群信息 + EKS资源 + HyperPod完整数据
│   │   ├── creation_metadata.json     # 创建过程记录 + CF输出（创建集群）
│   │   ├── import_metadata.json       # 导入过程记录（导入集群）
│   │   ├── hyperpod-config.json       # HyperPod创建配置（UI创建时）
│   │   ├── user_input.json           # 用户输入备份（创建集群）
│   │   └── cidr_configuration.json   # 网络配置（创建集群）
│   ├── config/            # 配置文件
│   │   ├── init_envs      # 环境变量配置
│   │   └── stack_envs     # CloudFormation输出环境变量（依赖配置时生成）
│   ├── logs/              # 操作日志
│   └── current/           # 当前状态
├── creating-clusters.json # 创建中集群跟踪
└── active_cluster.json    # 当前活跃集群
```

**自动触发机制**:
- **定时检查**: 每60秒检查CloudFormation状态
- **状态转换**: CREATE_COMPLETE时自动调用注册函数
- **输出获取**: 自动获取并保存CloudFormation输出到metadata
- **kubectl集成**: 完成后自动更新kubectl配置
- **WebSocket通知**: 实时通知前端状态变化

#### 🚨 关键问题解决

##### 1. kubectl 配置自动切换问题 (2025-10-16)
**问题**: 集群创建完成后 kubectl 配置未自动更新，导致用户操作混乱
**根因**: 手动切换和自动切换使用不同的代码路径

```javascript
// 问题代码 - registerCompletedCluster() 缺少 kubectl 更新
async function registerCompletedCluster(clusterTag, status = 'active') {
  await clusterManager.setActiveCluster(clusterTag);        // 仅更新UI状态
  // ❌ 缺少 switchKubectlConfig() 调用
}

// 修复方案 - 统一调用 switchKubectlConfig
async function registerCompletedCluster(clusterTag, status = 'active') {
  await clusterManager.setActiveCluster(clusterTag);
  
  // 自动更新kubectl配置
  const multiClusterAPIs = require('./multi-cluster-apis');
  const apiInstance = new multiClusterAPIs();
  await apiInstance.switchKubectlConfig(clusterTag);
  console.log(`Successfully updated kubectl config for newly created cluster: ${clusterTag}`);
}
```

**容器化环境配置**:
```javascript
// Docker 挂载配置
/home/ubuntu/.kube:/home/node/.kube:rw     # kubectl配置同步
/home/ubuntu/.aws:/home/node/.aws:ro       # AWS凭证只读访问

// 环境变量配置
env: { 
  HOME: process.env.HOME || '/home/node',
  KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'
}
```

##### 2. HyperPod 创建完成显示问题 (2025-10-16)
**问题**: HyperPod 创建完成后状态显示错乱，从 creating → not exist → 显示
**根因**: 时序竞争条件，清理状态在 metadata 更新前执行

```javascript
// 问题流程 - 竞争条件
updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');  // 1. 立即清理创建状态
await registerCompletedHyperPod(clusterTag);            // 2. 异步更新metadata（需要几秒）
broadcast('hyperpod_creation_completed');               // 3. 立即广播消息
// 前端收到消息后立即刷新，但metadata可能还没更新完成

// 修复方案 - 调整执行顺序
await registerCompletedHyperPod(clusterTag);            // 先更新metadata
updateCreatingHyperPodStatus(clusterTag, 'COMPLETED'); // 后清理状态
broadcast('hyperpod_creation_completed');
```

**前端 WebSocket 订阅增强**:
```javascript
// NodeGroupManager.js - 专门的HyperPod创建完成处理
operationRefreshManager.subscribe('hyperpod-create', async (data) => {
  if (data.type === 'hyperpod_creation_completed') {
    console.log('🎉 HyperPod creation completed, refreshing node groups...');
    await fetchNodeGroups();
    await checkHyperPodCreationStatus();
  }
});
```

##### 3. 实时状态检查机制 (2025-10-22)
**问题**: 用户需要手动刷新才能看到创建完成状态
**解决**: 新增主动定时检查机制，每60秒自动检测 CloudFormation 状态

```javascript
// EKS集群检测实现 - ui-panel/server/index.js
const clusterStatusCheckInterval = setInterval(async () => {
  // 1. 读取creating-clusters.json中的所有EKS集群
  // 2. 遍历所有创建中的EKS集群
  // 3. 调用CloudFormation API检查状态
  // 4. CREATE_COMPLETE时自动注册集群并广播消息
}, 60000);

// HyperPod集群检测实现
const hyperPodStatusCheckInterval = setInterval(async () => {
  // 1. 读取creating-hyperpod-clusters.json中的所有HyperPod集群
  // 2. 遍历所有创建中的HyperPod集群  
  // 3. 调用CloudFormation API检查状态
  // 4. CREATE_COMPLETE时自动注册HyperPod集群并广播消息
}, 60000);
```

**技术优势**:
- ✅ **实时性**: 最多60秒延迟，大幅提升响应速度
- ✅ **自动化**: 无需用户干预，系统自动处理状态转换
- ✅ **双重保障**: 定时检查 + 手动刷新两种机制并存

##### 4. 集群导入执行顺序问题 (2025-10-16)
**问题**: 导入集群时 kubectl 配置更新在 `init_envs` 文件创建前被调用
**修复**: 调整执行顺序，先保存配置文件，再更新 kubectl

```javascript
// 修复前的错误顺序
await this.switchKubectlConfig(eksClusterName);  // 第4步 - 文件不存在
await this.clusterManager.saveImportConfig(...); // 第6步 - 创建文件

// 修复后的正确顺序  
await this.clusterManager.saveImportConfigBasic(...); // 第5步：先保存配置
await this.switchKubectlConfig(eksClusterName);        // 第6步：再更新kubectl
```

#### 设计要点
- **解耦架构**: 集群创建与依赖配置分离，创建时间减少40%
- **状态管理**: `managed_clusters_info/` 目录存储集群元数据
- **实时通信**: WebSocket 端口 3098 专用于日志流
- **容错机制**: kubectl 更新失败不阻断集群注册流程
- **分阶段保存**: 创建时保存基础信息，完成后保存完整metadata
- **自动注册**: 完成后自动注册到可用集群列表并更新kubectl配置
- **生命周期跟踪**: 从创建到删除的完整状态记录和历史追溯
- **导入集群支持**: 完整支持现有集群导入，metadata格式与创建集群对齐
- **统一依赖管理**: 创建集群和导入集群使用相同的依赖配置链路
- **HyperPod信息统一**: 保存SageMaker API完整数据，包含Instance Groups和计算节点子网
- **metadata优化**: 从metadata获取基础设施信息，兼容创建和导入集群

#### 依赖检测系统
**检测的 Kubernetes 组件**:

1. **AWS Load Balancer Controller** (`aws-load-balancer-controller`)
   - **命名空间**: `kube-system`
   - **用途**: EKS 负载均衡管理
   - **检测方式**: `kubectl get deployment aws-load-balancer-controller -n kube-system`

2. **S3 CSI Driver** (`s3-csi-node`)
   - **命名空间**: `kube-system`  
   - **用途**: S3 存储挂载支持
   - **检测方式**: `kubectl get daemonset s3-csi-node -n kube-system`

3. **KubeRay Operator** (`kuberay-operator`)
   - **命名空间**: `kuberay-operator`
   - **用途**: Ray 分布式计算框架
   - **检测方式**: `kubectl get deployment kuberay-operator -n kuberay-operator`

4. **Cert Manager** (`cert-manager`)
   - **命名空间**: `cert-manager`
   - **用途**: TLS 证书自动管理
   - **检测方式**: `kubectl get deployment cert-manager -n cert-manager`

5. **Helm Dependencies**
   - **基于前述组件的综合状态**
   - **判断逻辑**: 至少需要3个组件正常才认为配置完成
   - **检测方式**: 综合前4个组件的状态

**依赖状态显示逻辑**:
```javascript
if (isImported) {
  if (cluster.hasHyperPod) {
    return <Tag color="default">N/A</Tag>;           // EKS+HyperPod导入
  } else {
    return <Tag color="warning">Not Configured</Tag>; // 纯EKS导入，需要配置
  }
} else {
  // 创建的集群正常显示配置状态
  return <Tag color={configured ? "success" : "error"}>{status}</Tag>;
}
```

**cluster_info.json 依赖状态结构**:
```json
{
  "dependencies": {
    "configured": false,        // 是否通过UI配置过（纯EKS导入时存在）
    "detected": true,           // 是否检测过
    "effectiveStatus": false,   // 有效状态
    "components": {
      "helmDependencies": false,
      "nlbController": false,
      "s3CsiDriver": false,
      "kuberayOperator": false,
      "certManager": false
    }
  }
}
```

#### 集群导入完整链路

**功能概述**: 支持导入现有 EKS 集群，自动检测关联资源，生成与创建集群对齐的 metadata

**完整导入流程**:
1. **用户输入验证**: EKS集群名称、AWS区域、可选的HyperPod集群名称
2. **集群存在性验证**: 通过AWS CLI验证EKS集群是否存在
3. **访问权限配置**: 自动配置当前身份的集群访问权限
4. **目录结构创建**: 创建与创建集群相同的目录结构
5. **基础配置保存**: 生成init_envs文件和基础metadata
6. **kubectl配置更新**: 更新kubectl配置指向导入的集群
7. **集群状态检测**: 检测依赖组件、节点组、HyperPod集群状态
8. **检测状态保存**: 更新cluster_info.json包含检测结果
9. **资源信息获取**: 通过AWS CLI获取VPC、安全组、子网等资源信息
10. **HyperPod信息获取**: 如果指定HyperPod，通过SageMaker API获取完整集群数据
11. **metadata格式对齐**: 将资源信息保存为与创建集群相同的格式
12. **设置活跃集群**: 自动切换到导入的集群

**集群分类**:
1. **创建的 EKS 集群**: 通过 UI 创建，完整的依赖管理
2. **导入的 EKS+HyperPod 集群**: 用户指定了 HyperPod 集群名称
3. **导入的纯 EKS 集群**: 用户未指定 HyperPod 集群名称

**资源信息获取**:
- **VPC ID**: 从EKS集群配置中获取
- **安全组ID**: 集群安全组ID
- **子网信息**: 集群关联的子网列表
- **IAM角色**: 当前身份的角色ARN
- **S3存储桶**: 检测cluster-mount-{clusterName}存储桶（可选）
- **EKS集群ARN**: 集群的完整ARN

**生成的Metadata文件**:
```
{clusterTag}/
├── metadata/
│   ├── cluster_info.json          # 主要集群信息（与创建集群格式对齐）
│   └── import_metadata.json       # 导入过程记录
├── config/
│   └── init_envs                  # 环境变量配置
```

**dependency配置支持**:
- **完全支持**: 导入集群支持完整的依赖配置功能
- **统一链路**: 使用与创建集群相同的配置逻辑
- **资源复用**: 从metadata生成stack_envs，无需重复API调用

**HyperPod 检测策略**:
- **导入集群**: 使用用户指定的 HyperPod 集群名称，避免自动检测不相关集群
- **创建集群**: 通过 UI 创建的 HyperPod 集群自动记录到 `userCreated` 字段
- **显示优先级**: `userCreated` > `detected`

**数据结构**:
```json
{
  "hyperPodCluster": {
    "ClusterName": "hp-cluster-xxx",
    "ClusterArn": "arn:aws:sagemaker:...",
    "ClusterStatus": "InService",
    "VpcConfig": {
      "SecurityGroupIds": ["sg-xxx"],
      "Subnets": ["subnet-hp1", "subnet-hp2"]
    },
    "InstanceGroups": [{
      "InstanceGroupName": "accelerated-group-1",
      "InstanceType": "ml.g5.8xlarge",
      "CurrentCount": 2
    }],
    "ExecutionRole": "arn:aws:iam::...",
    "source": "ui-created"
  },
  "cloudFormation": {
    "stackName": null,
    "stackId": null,
    "outputs": {
      "OutputVpcId": "vpc-xxx",
      "OutputEKSClusterName": "eks-cluster-name",
      "OutputSecurityGroupId": "sg-xxx"
    }
  },
  "eksCluster": {
    "name": "eks-cluster-name",
    "vpcId": "vpc-xxx",
    "securityGroupId": "sg-xxx"
  }
}

### 模型推理模块

#### 功能特性
- **多引擎支持**: vLLM、SGLang、Ollama
- **动态端口**: 支持自定义推理服务端口 (2025-10-17)
- **模型池管理**: 独立的 Model Pool Manager 系统
- **测试集成**: 自动生成 cURL 测试命令

#### 关键实现文件
| 功能 | 前端组件 | 模板文件 | 说明 |
|------|----------|----------|------|
| 推理部署 | `InferencePanel.js` | `vllm-sglang-template.yaml` | 标准推理服务 |
| 模型池部署 | `InferencePanel.js` | `vllm-sglang-model-pool-template.yaml` | 共享模型池 |
| 端口配置 | `ConfigPanel` | `PORT_NUMBER` 占位符 | 动态端口替换 |
| 测试功能 | `TestPanel` | - | 自动适配端口 |
| 模型池管理 | - | `model-pool-manager/` | 独立脚本系统 |

#### 🚨 关键问题解决

##### 1. 推理服务端口配置与测试优化 (2025-10-17)
**问题**: 用户需要自定义推理服务端口，但 Model Testing 无法自动适配不同端口
**解决**: 实现动态端口配置和自动适配机制

**前端端口配置**:
```javascript
// InferencePanel.js - 端口输入框
<Form.Item label="Port" name="port">
  <InputNumber 
    min={1} 
    max={65535} 
    defaultValue={8000}
    placeholder="8000"
  />
</Form.Item>
```

**模板文件支持**:
```yaml
# vllm-sglang-template.yaml & vllm-sglang-model-pool-template.yaml
ports:
  - containerPort: PORT_NUMBER  # 容器端口占位符
    name: http
---
spec:
  ports:
    - port: PORT_NUMBER         # 服务端口占位符
      protocol: TCP
      targetPort: http
```

**后端处理逻辑**:
```javascript
// server/index.js - 模板替换
const { port = 8000 } = req.body;

newYamlContent = templateContent
  .replace(/PORT_NUMBER/g, port || 8000)  // 数字类型，非字符串
  // ... 其他替换
```

**Model Testing 动态端口适配**:
```javascript
// TestPanel.js - 核心机制
const getServiceUrl = (service) => {
  if (!service) return '';
  
  // 获取LoadBalancer外部访问
  const ingress = service.status?.loadBalancer?.ingress?.[0];
  if (ingress) {
    const host = ingress.hostname || ingress.ip;
    const port = service.spec.ports?.[0]?.port || 8000;  // 动态获取端口
    return `http://${host}:${port}`;
  }
  
  // 回退到ClusterIP内部访问
  const clusterIP = service.spec.clusterIP;
  const port = service.spec.ports?.[0]?.port || 8000;
  return `http://${clusterIP}:${port}`;
};
```

**自动化流程**:
1. **用户配置**: 在 ConfigPanel 中设置自定义端口（如8080）
2. **服务部署**: 系统使用用户指定端口创建 Kubernetes Service
3. **测试适配**: TestPanel 自动从 Service 配置中读取实际端口
4. **cURL 生成**: 生成包含正确端口的测试命令

#### Model Pool Manager 系统

**独立脚本系统** (`model-pool-manager/`):
- **部署模型池**: 创建无服务的 Pod 池
- **创建业务服务**: 部署动态选择 Pod 的服务
- **管理 Pod 关联**: 分配/取消分配 Pod 到不同业务服务

**核心脚本**:
```bash
# 部署模型池
./scripts/deploy-pool.sh --name qwen-pool --replicas 3

# 创建业务服务
./scripts/deploy-service.sh --name service-a --business biz-a --model-id qwen-pool-xxx

# 管理 Pod 分配
./scripts/manage-pods.sh assign --pod qwen-pool-abc123 --business biz-a
```

**工作流程**:
1. **部署模型池**: Pod 标记为 `business=unassigned`
2. **创建服务**: 基于 `model-id` 和 `business` 标签选择 Pod
3. **动态分配**: 通过标签更新实现 Pod 与服务的动态关联

#### 设计要点
- **模板化**: 使用占位符实现动态配置替换
- **端口灵活性**: 支持1-65535范围内的自定义端口
- **测试集成**: 自动生成正确的测试 URL 和 cURL 命令
- **容错机制**: 端口获取失败时有合理默认值
- **模型池解耦**: 独立的脚本系统管理 Pod 池和服务关联

#### 🚨 关键问题解决

##### 1. 推理服务端口配置与测试优化 (2025-10-17)
**问题**: 用户需要自定义推理服务端口，但 Model Testing 无法自动适配不同端口
**解决**: 实现动态端口配置和自动适配机制

**前端端口配置**:
```javascript
// InferencePanel.js - 端口输入框
<Form.Item label="Port" name="port">
  <InputNumber 
    min={1} 
    max={65535} 
    defaultValue={8000}
    placeholder="8000"
  />
</Form.Item>
```

**模板文件支持**:
```yaml
# vllm-sglang-template.yaml
ports:
  - containerPort: PORT_NUMBER  # 容器端口占位符
    name: http
---
spec:
  ports:
    - port: PORT_NUMBER         # 服务端口占位符
      protocol: TCP
      targetPort: http
```

**后端处理逻辑**:
```javascript
// server/index.js - 模板替换
const { port = 8000 } = req.body;

newYamlContent = templateContent
  .replace(/PORT_NUMBER/g, port || 8000)  // 数字类型，非字符串
  // ... 其他替换
```

**Model Testing 动态端口适配**:
```javascript
// TestPanel.js - 核心机制
const getServiceUrl = (service) => {
  if (!service) return '';
  
  // 获取LoadBalancer外部访问
  const ingress = service.status?.loadBalancer?.ingress?.[0];
  if (ingress) {
    const host = ingress.hostname || ingress.ip;
    const port = service.spec.ports?.[0]?.port || 8000;  // 动态获取端口
    return `http://${host}:${port}`;
  }
  
  // 回退到ClusterIP内部访问
  const clusterIP = service.spec.clusterIP;
  const port = service.spec.ports?.[0]?.port || 8000;
  return `http://${clusterIP}:${port}`;
};
```

**自动化流程**:
1. **用户配置**: 在 ConfigPanel 中设置自定义端口（如8080）
2. **服务部署**: 系统使用用户指定端口创建 Kubernetes Service
3. **测试适配**: TestPanel 自动从 Service 配置中读取实际端口
4. **cURL 生成**: 生成包含正确端口的测试命令

**技术特点**:
- ✅ **实时获取**: 从 Kubernetes Service 实时读取端口配置
- ✅ **智能回退**: 无法获取时使用默认端口8000
- ✅ **自动适配**: 无需手动配置，测试功能自动适应端口变化
- ✅ **双重支持**: 同时支持外部 LoadBalancer 和内部 ClusterIP 访问

#### 设计要点
- **模板化**: 使用占位符实现动态配置替换
- **端口灵活性**: 支持1-65535范围内的自定义端口
- **测试集成**: 自动生成正确的测试 URL 和 cURL 命令
- **容错机制**: 端口获取失败时有合理默认值

### 训练作业模块

#### 功能特性
- **多框架支持**: PyTorch、LLaMA Factory、VERL、TorchTitan
- **MLflow 集成**: 自动认证配置和实验跟踪 (2025-10-16)
- **作业监控**: 实时日志流和状态更新
- **模板化**: 预定义训练配置模板

#### 关键实现文件
| 功能 | 前端组件 | 后端 API | 模板目录 |
|------|----------|----------|----------|
| 训练提交 | `TrainingHistoryPanel.js` | `/api/training/submit` | `templates/training/` |
| MLflow 配置 | `TrainingHistoryPanel.js` | `/api/configure-mlflow-auth` | - |
| 日志监控 | `TrainingMonitorPanel.js` | WebSocket 3098 | `logs/` |
| 历史查询 | `TrainingHistoryPanel.js` | `/api/training/history` | - |

#### 🚨 关键问题解决

##### 1. MLflow 认证配置集成 (2025-10-16)
**问题**: 训练作业需要复杂的 MLflow 认证配置，用户配置门槛高
**解决**: 提供一键式 MLflow 认证配置，自动创建所需的 AWS 和 Kubernetes 资源

**后端实现** (`mlflowTrackingServerManager.js`):
```javascript
// 配置MLflow认证 - 集成到现有管理器
async configureAuthentication() {
  // 1. 创建Kubernetes service account
  await this.createServiceAccount();
  
  // 2. 获取EKS OIDC信息
  const oidcInfo = await this.getOIDCInfo(eksClusterName, region);
  
  // 3. 创建IAM角色和策略
  await this.createIAMRoleAndPolicy(accountId, region, oidcInfo.oidcId, clusterTag);
  
  // 4. 绑定角色到service account
  await this.bindRoleToServiceAccount(accountId, clusterTag);
}
```

**AWS 资源统一获取**:
```javascript
// 使用awsHelpers统一获取AWS资源信息
const { getCurrentRegion, getCurrentAccountId, getDevAdminRoleArn } = require('./awsHelpers');

// 统一的参数获取
const region = await getCurrentRegion();
const accountId = await getCurrentAccountId();  // 新增
const s3Bucket = getCurrentS3Bucket();
const iamRoleArn = await getDevAdminRoleArn();
```

**前端集成** (`TrainingHistoryPanel.js`):
```javascript
// 在MLflow配置窗口中间添加认证配置区域
<div style={{ 
  backgroundColor: '#fff7e6',
  border: '1px solid #ffd591',
  borderRadius: '8px'
}}>
  <Typography.Title level={5}>
    Config MLFlow Authentications for Cluster
  </Typography.Title>
  
  <Button 
    type="primary" 
    loading={configAuthLoading}
    onClick={configureMLflowAuth}
  >
    Configure Authentication
  </Button>
</div>
```

**API 端点** (`server/index.js`):
```javascript
// 新增MLflow认证配置API
app.post('/api/configure-mlflow-auth', async (req, res) => {
  const mlflowManager = new MLflowTrackingServerManager();
  const result = await mlflowManager.configureAuthentication();
  
  // WebSocket广播配置结果
  broadcast({
    type: 'mlflow_auth_configured',
    status: 'success',
    message: result.message
  });
});
```

**自动创建的资源**:
- **Kubernetes Service Account**: `mlflow-service-account`
- **IAM 角色**: `EKS-MLflow-ServiceAccount-Role-{clusterTag}`
- **IAM 策略**: `EKS-MLflow-Policy-{clusterTag}`
- **角色绑定**: 通过 annotation 绑定到 service account

##### 2. SageMaker TrainingJob Kubernetes Operator 集成
**功能**: 通过 Kubernetes CRD 调用 SageMaker TrainingJob，实现云原生训练作业管理
**实现位置**: `smtj-op/` 目录

**ACK Controller 安装**:
```bash
# 安装 SageMaker ACK Controller
./smtj-op/install-ack-controller-idempotent.sh

# 验证安装
kubectl get pods -n ack-sagemaker-controller
```

**TrainingJob CRD 使用**:
```yaml
# smtj-op/job-1.yaml - 示例配置
apiVersion: sagemaker.services.k8s.aws/v1alpha1
kind: TrainingJob
metadata:
  name: pytorch-training-job
spec:
  trainingJobName: pytorch-training-job-20250919
  roleARN: "arn:aws:iam::account:role/SageMakerExecutionRole"
  
  algorithmSpecification:
    trainingImage: "763104351884.dkr.ecr.us-west-2.amazonaws.com/pytorch-training:2.8.0-gpu"
    trainingInputMode: File
    
  resourceConfig:
    instanceType: ml.p3.2xlarge
    instanceCount: 2
    volumeSizeInGB: 100
    
  outputDataConfig:
    s3OutputPath: s3://my-bucket/output/
    
  stoppingCondition:
    maxRuntimeInSeconds: 86400
```

**作业管理脚本** (`job-manager.sh`):
```bash
# 查看作业状态
./smtj-op/job-manager.sh my-training-job status

# 获取训练日志
./smtj-op/job-manager.sh my-training-job logs

# 删除作业
./smtj-op/job-manager.sh my-training-job delete

# 列出所有作业
./smtj-op/job-manager.sh - list
```

**核心参数配置** (详见 `TRAININGJOB_PARAMS.md`):
- **必需参数**: `algorithmSpecification`, `outputDataConfig`, `resourceConfig`, `roleARN`, `stoppingCondition`
- **可选参数**: `inputDataConfig`, `hyperParameters`, `environment`, `checkpointConfig`, `vpcConfig`
- **高级功能**: Spot 实例、分布式训练、调试配置、实验管理

**与 UI 集成**:
- 前端提交训练作业 → 生成 TrainingJob YAML → kubectl apply
- 实时状态监控 → kubectl get trainingjob → 更新 UI 状态
- 日志获取 → AWS CloudWatch Logs API → WebSocket 流式传输

##### 3. 训练日志流式显示系统
**问题**: 训练作业运行时间长，用户需要实时查看训练日志和进度
**解决**: 基于 WebSocket 的流式日志显示系统

**WebSocket 服务器配置** (`server/index.js`):
```javascript
const WS_PORT = 3098; // WebSocket独立端口

// WebSocket服务器使用独立端口
const wss = new WebSocket.Server({ port: WS_PORT });

// 处理日志流请求
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    const request = JSON.parse(message);
    
    if (request.type === 'subscribe_training_logs') {
      startLogStreaming(ws, request.jobName);
    }
  });
});

// 日志流式传输
function startLogStreaming(ws, jobName) {
  // 1. 获取 SageMaker 作业名称
  const sagemakerJobName = getSageMakerJobName(jobName);
  
  // 2. 获取 CloudWatch 日志流
  const logStreams = getLogStreams(sagemakerJobName);
  
  // 3. 实时推送日志
  const interval = setInterval(() => {
    getLatestLogs(logStreams).then(logs => {
      ws.send(JSON.stringify({
        type: 'training_logs',
        jobName: jobName,
        logs: logs,
        timestamp: new Date().toISOString()
      }));
    });
  }, 2000); // 每2秒更新
}
```

**前端日志显示** (`TrainingMonitorPanel.js`):
```javascript
// WebSocket 连接
const ws = new WebSocket('ws://localhost:3098');

// 订阅训练日志
const subscribeToLogs = (jobName) => {
  ws.send(JSON.stringify({
    type: 'subscribe_training_logs',
    jobName: jobName
  }));
};

// 处理日志消息
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'training_logs') {
    // 实时更新日志显示
    setLogs(prevLogs => [...prevLogs, ...data.logs]);
    
    // 自动滚动到底部
    logContainerRef.current?.scrollToBottom();
  }
};

// 日志显示组件
<div className="log-container" ref={logContainerRef}>
  {logs.map((log, index) => (
    <div key={index} className="log-line">
      <span className="timestamp">{log.timestamp}</span>
      <span className="message">{log.message}</span>
    </div>
  ))}
</div>
```

**日志获取流程**:
1. **作业提交** → TrainingJob CRD 创建 → SageMaker 作业启动
2. **日志生成** → SageMaker 写入 CloudWatch Logs
3. **实时获取** → 后端定时调用 CloudWatch API
4. **WebSocket 推送** → 实时传输到前端
5. **UI 显示** → 流式更新日志面板

**CloudWatch 日志集成**:
```javascript
// 获取日志流
const getLogStreams = async (jobName) => {
  const params = {
    logGroupName: '/aws/sagemaker/TrainingJobs',
    logStreamNamePrefix: jobName
  };
  
  const result = await cloudWatchLogs.describeLogStreams(params).promise();
  return result.logStreams;
};

// 获取最新日志
const getLatestLogs = async (logStreams) => {
  const logs = [];
  
  for (const stream of logStreams) {
    const params = {
      logGroupName: '/aws/sagemaker/TrainingJobs',
      logStreamName: stream.logStreamName,
      startTime: lastLogTime,
      limit: 100
    };
    
    const events = await cloudWatchLogs.getLogEvents(params).promise();
    logs.push(...events.events);
  }
  
  return logs.sort((a, b) => a.timestamp - b.timestamp);
};
```

**技术特点**:
- ✅ **实时性**: 2秒间隔的日志更新
- ✅ **多作业支持**: 同时监控多个训练作业
- ✅ **自动滚动**: 新日志自动滚动到可视区域
- ✅ **状态同步**: 作业状态与日志同步更新
- ✅ **错误处理**: 网络断开自动重连机制

##### 2. 训练框架模板系统
**支持的训练框架**:

| 框架 | 目录 | 特点 |
|------|------|------|
| PyTorch | `torch-project-*` | 分布式训练、FSDP 支持 |
| LLaMA Factory | `llama-factory-project/` | 预训练和微调 |
| VERL | `verl-project/` | 强化学习训练 |
| TorchTitan | `torchtitan-project/` | 大规模模型训练 |

**训练容器构建** (`docker-build-training-op/`):
```bash
# 构建训练容器
./build-and-push.sh

# 支持的运行脚本
torch_recipe_dist_run.sh      # PyTorch 分布式
lmf_recipe_dist_run.sh        # LLaMA Factory
torchtitan_recipe_dist_run.sh # TorchTitan
```

**MLflow 集成脚本**:
```python
# set_mlflow_tags.py - 自动设置 MLflow 标签
# lmf_process_train_yaml.py - 处理训练配置
# torch_process_train_args.py - 处理 PyTorch 参数
```

#### WebSocket 消息类型
```javascript
'mlflow_auth_configured'         // MLflow认证配置完成
'mlflow_tracking_server_created' // MLflow Tracking Server创建完成
'training_job_started'           // 训练作业开始
'training_job_completed'         // 训练作业完成
'training_log_update'            // 训练日志更新
```

#### 设计要点
- **一键配置**: MLflow 认证自动化，降低用户配置门槛
- **模板化**: 预定义多种训练框架的配置模板
- **实时监控**: WebSocket 实时日志流和状态更新
- **权限安全**: 基于 OIDC 的安全访问控制
- **统一管理**: 集成到现有的集群管理系统

## 🔄 关键数据流

### 集群创建流程
```
用户提交 → 立即保存基础metadata → CloudFormation 创建 → 定时检查状态 → 自动注册集群 → 保存完整metadata → WebSocket 通知 → UI 更新
```

### 集群导入流程
```
用户输入 → 验证集群存在 → 配置访问权限 → 保存基础配置 → 检测集群状态 → 获取资源信息 → metadata格式对齐 → 设置活跃集群
```

### Metadata保存流程
```
创建阶段: 用户输入 + CIDR配置 + 创建状态 → 完成阶段: CloudFormation输出 + 集群信息 + EKS资源信息 → 运行阶段: 依赖状态 + 节点组信息
```

### 依赖配置流程
```
用户触发 → 后台安装组件 → 状态更新 → WebSocket 广播 → 按钮状态变化
```

### 训练日志流式显示流程
```
作业提交 → SageMaker 启动 → CloudWatch 日志 → 定时获取 → WebSocket 推送 → UI 实时显示
```

### 实时状态检查
```javascript
// server/index.js - 每60秒检查
const clusterStatusCheckInterval = setInterval(async () => {
  // 检查 creating-clusters.json 中的集群
  // 调用 CloudFormation API 获取状态
  // CREATE_COMPLETE 时自动注册并广播
}, 60000);
```

## 🛠️ 网络与安全配置

### WebSocket 架构优化 (2025-10-17)
**问题**: 原系统 WebSocket 与 API 混用同一端口，需要额外开放端口
**解决**: WebSocket 独立端口配置，简化网络架构

**端口配置优化**:
```javascript
// 优化前
- 3099：前端UI端口
- 3001：后端API端口  
- 8081：WebSocket端口（需要额外开放）

// 优化后
- 3099：前端UI端口
- 3001：后端API端口（内部使用）
- 3098：WebSocket独立端口（日志流专用）
```

**WebSocket 服务器配置** (`server/index.js`):
```javascript
const PORT = 3001;
const WS_PORT = 3098; // WebSocket独立端口

// WebSocket服务器使用独立端口
const wss = new WebSocket.Server({ port: WS_PORT });
```

**前端连接配置**:
```javascript
// TrainingMonitorPanel.js 和 App.js
const ws = new WebSocket('ws://localhost:3098');
```

**安全组配置**:
- **需要开放**: 3099（UI访问）、3098（WebSocket日志流）
- **内部端口**: 3001（容器内部API通信，通过代理访问）

### EKS NodeGroup Security Group 统一优化 (2025-10-22)
**问题**: EKS NodeGroup 与 HyperPod 使用不同安全组，网络配置不一致
**解决**: 统一安全组获取架构，确保网络配置一致性

**问题分析**:
```javascript
// 修改前 (sg-ng) - 3个安全组
1. sg-039d36a44cf14a5e3 - eksctl自动创建的EFA安全组 ❌
2. sg-004ebec23283d206d - EKS控制平面安全组 ✅  
3. sg-0aa83046c1438614e - HyperPod安全组 ✅

// 修改后 (sg-ng2) - 2个安全组
1. sg-004ebec23283d206d - EKS控制平面安全组 ✅
2. sg-0aa83046c1438614e - HyperPod安全组 ✅
```

**统一安全组获取架构**:
```javascript
// CloudFormation模板架构统一
SecurityGroupStack:
  Type: AWS::CloudFormation::Stack
  Condition: CreateSecurityGroupStack
  
EKSClusterStack:
  SecurityGroupId: !If
    - CreateSecurityGroupStack
    - !GetAtt SecurityGroupStack.Outputs.SecurityGroupId  # 统一来源
    - !Ref SecurityGroupId

Outputs:
  OutputSecurityGroupId:
    Value: !GetAtt SecurityGroupStack.Outputs.SecurityGroupId
```

**统一获取方式**:
| 信息类型 | 获取方式 | 实现位置 |
|---------|---------|---------|
| EKS Cluster Name | 环境变量文件 | `index.js` |
| Region | 环境变量文件 | `index.js` |
| VPC ID | **CloudFormation输出** | `CloudFormationManager.fetchStackInfo()` |
| **Security Group** | **CloudFormation输出** | **`CloudFormationManager.fetchStackInfo()`** |
| 子网信息 | AWS API调用 | `CloudFormationManager.fetchSubnetInfo()` |

**eksctl 配置优化** (`utils/cloudFormationManager.js`):
```javascript
// 使用CloudFormation输出的Security Group（与HyperPod相同）
console.log(`Using security group: ${securityGroupId}`);

const eksctlConfig = `
managedNodeGroups:
  - name: ${nodeGroupConfig.nodeGroupName}
    efaEnabled: ${efaSupported}           # 保留EFA功能
    privateNetworking: true
    securityGroups:
      attachIDs: ["${securityGroupId}"]   # 使用统一的安全组
      withShared: false                   # 禁用额外安全组创建
`;
```

**前端显示优化** (`EksNodeGroupCreationPanel.js`):
```javascript
// /api/cluster/subnets API返回统一的安全组信息
{
  "eksClusterName": "eks-cluster-xxx",
  "region": "us-west-2", 
  "vpcId": "vpc-xxx",
  "securityGroupId": "sg-0aa83046c1438614e",  // 从CloudFormation获取
  "hyperPodSecurityGroup": "sg-0aa83046c1438614e" // 验证一致性
}

// UI显示
<Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
  <Text type="secondary">
    <strong>EKS Cluster:</strong> {clusterInfo?.eksClusterName || 'Loading...'}
  </Text>
  <Text type="secondary">
    <strong>Security Group:</strong> {eksSecurityGroup || 'Loading...'}
  </Text>
</Space>
```

**验证结果**:
```bash
# 修改前 (sg-ng)
aws ec2 describe-instances --instance-ids i-09152cc465c58bc09 \
  --query 'Reservations[0].Instances[0].SecurityGroups[*].GroupId'
# 输出: ["sg-039d36a44cf14a5e3", "sg-004ebec23283d206d", "sg-0aa83046c1438614e"]

# 修改后 (sg-ng2)  
aws ec2 describe-instances --instance-ids i-0032dfb9025e958a3 \
  --query 'Reservations[0].Instances[0].SecurityGroups[*].GroupId'
# 输出: ["sg-004ebec23283d206d", "sg-0aa83046c1438614e"]
```

**优化成果**:
- ✅ **架构统一**: 所有安全组信息统一从 CloudFormation 输出获取
- ✅ **配置简化**: EKS NodeGroup 和 HyperPod 使用完全相同的安全组
- ✅ **性能提升**: 减少不必要的 AWS API 调用
- ✅ **资源优化**: 避免创建额外的 EFA 安全组
- ✅ **网络一致**: 确保 EKS 和 HyperPod 节点网络配置完全一致

## 🚀 高级功能模块

### HyperPod 实例组动态扩展
**功能**: 向现有 HyperPod 集群添加实例组，支持动态扩展计算资源
**实现时间**: 2025-10-22

#### 功能特性
- **Add Instance Group 按钮**: 位于 "Create HyperPod" 按钮之前
- **启用条件**: 依赖已配置 + 存在 HyperPod 集群 + 无创建/删除操作进行中
- **支持的实例类型**: 与 Create HyperPod 完全对齐

**支持的实例类型**:
```javascript
ml.g5.8xlarge, ml.g5.12xlarge, ml.g5.24xlarge, ml.g5.48xlarge
ml.g6.8xlarge, ml.g6.12xlarge, ml.g6.24xlarge, ml.g6.48xlarge
ml.g6e.8xlarge, ml.g6e.12xlarge, ml.g6e.24xlarge, ml.g6e.48xlarge
ml.p4d.24xlarge, ml.p5.48xlarge, ml.p5en.48xlarge, ml.p6-b200.48xlarge
```

#### 后端实现
**API 端点**: `POST /api/cluster/hyperpod/add-instance-group`

**处理逻辑**:
```javascript
// 1. 集群信息获取
const activeClusterName = clusterManager.getActiveCluster();

// 从 cluster_info.json 读取 HyperPod 集群信息
const userCreatedClusters = clusterInfo.hyperPodClusters?.userCreated || [];
const detectedClusters = clusterInfo.hyperPodClusters?.detected || [];

// 2. 现有集群配置获取
const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.name}`;
const clusterData = JSON.parse(describeResult.stdout);

// 3. 配置生成
{
  "ClusterName": "hp-cluster-hypd-1016-e26e",
  "InstanceGroups": [
    {
      "InstanceCount": 1,
      "InstanceGroupName": "compute-group-new",
      "InstanceType": "ml.g5.2xlarge",
      "LifeCycleConfig": {
        "SourceS3Uri": "s3://actual-bucket/lifecycle-scripts/",
        "OnCreate": "on_create.sh"
      },
      "ExecutionRole": "arn:aws:iam::account:role/actual-role",
      "ThreadsPerCore": 1,
      "InstanceStorageConfigs": [
        {
          "EbsVolumeConfig": {
            "VolumeSizeInGB": 300,
            "RootVolume": false
          }
        }
      ]
    }
  ]
}

// 4. 智能配置逻辑
- LifeCycleConfig: 从现有集群的第一个实例组获取
- ExecutionRole: 从现有集群的第一个实例组获取
- ThreadsPerCore: 如果提供 TrainingPlanArn 则为 2，否则为 1
- RootVolume: 固定为 false

// 5. AWS CLI 调用
const addCmd = `aws sagemaker update-cluster --cli-input-json file://${tempConfigPath}`;
```

#### 前端实现
**组件状态管理**:
```javascript
const [addInstanceGroupModalVisible, setAddInstanceGroupModalVisible] = useState(false);
const [instanceGroupForm] = Form.useForm();
```

**按钮控制逻辑**:
```javascript
disabled={
  !effectiveDependenciesConfigured ||   // 依赖未配置时禁用
  !!hyperPodCreationStatus ||           // 创建中时禁用
  !!hyperPodDeletionStatus ||           // 删除中时禁用
  hyperPodGroups.length === 0           // 没有HyperPod时禁用
}
```

**表单处理**:
```javascript
const handleAddInstanceGroup = async () => {
  const values = await instanceGroupForm.validateFields();
  const response = await fetch('/api/cluster/hyperpod/add-instance-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userConfig: values })
  });
  // 成功后刷新实例组列表
  await fetchNodeGroups();
};
```

**用户输入表单**:
- **Instance Group Name** (必填): 新实例组的名称
- **Instance Type** (必填): AutoComplete 组件，支持输入和选择
- **Instance Count** (必填): 实例数量 (1-100)
- **EBS Volume Size** (必填): 存储卷大小 (100-16000 GB)
- **Training Plan ARN** (可选): 训练计划 ARN

#### 技术特点
- **配置继承**: 新实例组自动继承现有集群的核心配置
- **动态扩展**: 支持在运行时向集群添加新的计算资源
- **类型安全**: 完整的表单验证和错误处理
- **API 集成**: 直接调用 AWS SageMaker API 进行集群更新
- **状态同步**: 操作完成后自动刷新 UI 状态

### EKS NodeGroup 删除功能 (2025-10-22)
**功能**: 完善 EKS NodeGroup 生命周期管理，支持 UI 直接删除

#### 实现方案
**CloudFormationManager 增强**:
```javascript
// utils/cloudFormationManager.js
static async deleteEksNodeGroup(nodeGroupName, clusterName) {
  const deleteCommand = `aws eks delete-nodegroup --cluster-name ${clusterName} --nodegroup-name ${nodeGroupName}`;
  const result = execSync(deleteCommand, { encoding: 'utf8', timeout: 30000 });
  
  return {
    success: true,
    message: `NodeGroup ${nodeGroupName} deletion started`,
    output: result
  };
}
```

**API 端点**: `DELETE /api/cluster/nodegroup/:nodeGroupName`

**前端 UI 实现**:
- **删除按钮**: 在 Scale 按钮后添加红色 Delete 按钮
- **状态管理**: EKS 和 HyperPod 使用独立的 loading 状态
- **用户反馈**: 立即显示 "deletion started" 消息

**用户操作流程**:
1. **点击删除** → 显示 loading 状态
2. **API 调用** → AWS CLI 执行删除命令  
3. **立即响应** → 显示 "deletion started" 消息
4. **状态更新** → NodeGroup 状态变为 "DELETING"
5. **手动刷新** → 用户可查看删除进度
6. **删除完成** → NodeGroup 从列表中消失

#### 架构优势
- **模块化设计**: 删除逻辑封装在 CloudFormationManager 中
- **状态隔离**: EKS 和 HyperPod 删除状态完全独立  
- **异步处理**: 避免 UI 阻塞，提升用户体验
- **实时反馈**: 动态状态获取确保信息准确性

### 环境配置

#### 前置要求
- Node.js 16+
- Docker
- AWS CLI 配置
- kubectl 访问权限

#### 启动开发环境
```bash
cd ui-panel
npm install
npm run dev          # 前端开发服务器
npm run server       # 后端 API 服务器
```

#### Docker 部署
```bash
./start-docker.sh    # 启动容器化环境
```

### 核心配置文件

#### 网络配置
- **前端**: 端口 3099
- **后端 API**: 端口 3001 (内部)
- **WebSocket**: 端口 3098 (日志流)

#### 数据存储
- **集群元数据**: `managed_clusters_info/{clusterTag}/`
- **模板文件**: `templates/`
- **日志文件**: `logs/` 和 `tmp/`

## 🔍 故障排查

### 常见问题

#### 集群创建失败
**问题定位**:
- 检查 CloudFormation 日志: AWS Console → CloudFormation → Stack Events
- 查看后端日志: `server/server.log`
- 验证权限配置: IAM 角色和策略

**日志位置**:
```bash
# 后端主日志
tail -f ui-panel/server/server.log

# 集群创建状态
cat ui-panel/managed_clusters_info/creating-clusters.json

# 特定集群日志
ls ui-panel/managed_clusters_info/{clusterTag}/logs/
```

#### 依赖配置失败
**问题定位**:
- 查看安装日志: `tmp/dependency-install.log`
- 检查 kubectl 连接: `kubectl cluster-info`
- 验证网络配置: 安全组和子网

**详细日志**:
```bash
# 依赖安装完整日志
tail -f ui-panel/tmp/dependency-install.log

# 集群依赖日志
tail -f ui-panel/tmp/cluster-dependency.log

# HyperPod 依赖日志
tail -f ui-panel/tmp/hypd-dependency.log
```

**组件检测命令**:
```bash
# 检查各个组件状态
kubectl get deployment aws-load-balancer-controller -n kube-system
kubectl get daemonset s3-csi-node -n kube-system
kubectl get deployment kuberay-operator -n kuberay-operator
kubectl get deployment cert-manager -n cert-manager
```

#### WebSocket 连接问题
**问题定位**:
- 确认端口开放: 3098
- 检查防火墙设置
- 查看浏览器控制台错误

**连接测试**:
```bash
# 测试 WebSocket 端口
telnet localhost 3098

# 检查 WebSocket 服务状态
netstat -tlnp | grep 3098

# 查看 WebSocket 连接日志
grep "WebSocket" ui-panel/server/server.log
```

#### kubectl 配置问题
**问题定位**:
- 检查 kubectl 上下文: `kubectl config current-context`
- 验证配置文件: `~/.kube/config`
- 确认容器挂载: Docker volume 映射

**容器化环境调试**:
```bash
# 检查容器内 kubectl 配置
docker exec -it <container_id> kubectl config view

# 验证文件挂载
docker exec -it <container_id> ls -la /home/node/.kube/

# 检查环境变量
docker exec -it <container_id> env | grep KUBE
```

#### HyperPod 显示问题
**问题定位**:
- 检查集群元数据: `managed_clusters_info/{clusterTag}/metadata/cluster_info.json`
- 验证 HyperPod 集群状态: `aws sagemaker describe-cluster`
- 查看创建状态文件: `creating-hyperpod-clusters.json`

**状态检查**:
```bash
# 检查 HyperPod 集群信息
cat ui-panel/managed_clusters_info/{clusterTag}/metadata/cluster_info.json | jq '.hyperPodClusters'

# 验证 AWS 中的 HyperPod 集群
aws sagemaker list-clusters --name-contains {clusterTag}

# 检查创建状态
cat ui-panel/managed_clusters_info/creating-hyperpod-clusters.json
```

### 日志位置汇总
**系统日志**:
- **后端主日志**: `server/server.log`
- **依赖安装**: `tmp/dependency-install.log`
- **集群依赖**: `tmp/cluster-dependency.log`
- **HyperPod 依赖**: `tmp/hypd-dependency.log`

**训练日志**:
- **训练作业日志**: `logs/{job-name}/`
- **WebSocket 日志**: 浏览器开发者工具 → Network → WS

**集群元数据**:
- **集群信息**: `managed_clusters_info/{cluster}/metadata/cluster_info.json`
- **创建状态**: `managed_clusters_info/creating-clusters.json`
- **HyperPod 创建**: `managed_clusters_info/creating-hyperpod-clusters.json`
- **活跃集群**: `managed_clusters_info/active_cluster.json`

### 性能监控
**创建时间对比**:
- **原流程**: ~15-20分钟（包含依赖安装）
- **新流程**: ~8-12分钟（仅CloudFormation）
- **提升**: 约40-50%的时间节省

**资源利用**:
- **并行处理**: 多个集群可同时创建
- **按需配置**: 依赖仅在需要时安装
- **状态缓存**: 减少重复API调用
- **实时通信**: WebSocket提供低延迟的日志流传输

**网络优化**:
- **端口数量减少**: 从3个端口减少到2个对外端口
- **安全组简化**: 只需开放3099和3098端口
- **连接稳定性**: WebSocket独立端口，避免与API混合

## 🔍 故障排查

### 常见问题

#### 集群创建失败
- 检查 CloudFormation 日志: AWS Console
- 查看后端日志: `server/server.log`
- 验证权限配置: IAM 角色和策略

#### 依赖配置失败
- 查看安装日志: `tmp/dependency-install.log`
- 检查 kubectl 连接: `kubectl cluster-info`
- 验证网络配置: 安全组和子网

#### WebSocket 连接问题
- 确认端口开放: 3098
- 检查防火墙设置
- 查看浏览器控制台错误

### 日志位置
- **后端日志**: `server/server.log`
- **依赖安装**: `tmp/dependency-install.log`
- **训练日志**: `logs/{job-name}/`
- **集群元数据**: `managed_clusters_info/{cluster}/`

## 📚 重要设计决策

### 架构解耦 (2025-10-16)
- **问题**: 集群创建与依赖安装耦合，用户体验差
- **解决**: 完全分离创建和配置流程，用户主动控制
- **影响**: 创建时间减少 40%，用户体验显著提升

### 实时状态检查 (2025-10-22)
- **问题**: 用户需要手动刷新才能看到创建完成状态
- **解决**: 新增 60 秒定时检查机制
- **影响**: 自动状态更新，无需用户干预

### 网络配置优化 (2025-10-17)
- **问题**: 需要开放多个端口，配置复杂
- **解决**: WebSocket 独立端口，减少端口暴露
- **影响**: 简化安全组配置，提升网络安全

## 🚀 未来扩展方向

### 短期目标
- **批量操作**: 支持多集群依赖配置
- **健康检查**: 定期验证依赖状态
- **配置模板**: 预定义依赖配置方案

### 长期规划
- **微服务化**: 依赖管理独立为服务
- **事件驱动**: 基于事件的状态管理
- **配置中心**: 集中化的依赖配置管理

---

## 📖 相关文档

- [原始优化分析](KUBECTL_OPTIMIZATION_ANALYSIS.md) - 详细的技术实现记录
- [CloudFormation 模板](cli-min/) - 基础设施即代码
- [训练作业示例](train-recipes/) - 各种训练框架的使用示例
- [API 文档](ui-panel/server/) - 后端 API 接口说明

---

*本文档作为项目的快速索引和开发指南，帮助开发者快速理解项目架构和核心功能实现。*
