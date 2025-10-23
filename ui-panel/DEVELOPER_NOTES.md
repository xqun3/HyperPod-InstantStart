# EKS集群创建与依赖安装解耦优化

## 📋 项目背景

### 原始问题
- EKS集群创建流程中，依赖安装与集群创建耦合在一起
- 用户在集群创建过程中看到"完成"状态，但依赖仍在后台安装
- kubectl context切换时机不当，导致用户操作混乱
- 创建时间长，用户体验差
- WebSocket连接端口配置不合理，需要额外开放端口

## 🔧 kubectl配置自动切换优化 (2025-10-16)

### 问题背景
kubectl配置在集群切换时的自动更新存在不一致问题：
- **手动切换集群**：正常触发kubectl配置更新 ✅
- **集群创建完成自动切换**：未触发kubectl配置更新 ❌

### 问题分析

#### 手动切换集群流程
```javascript
UI切换 → handleSwitchCluster() → setActiveCluster() + switchKubectlConfig() ✅
```

**实现路径**：
```javascript
// multi-cluster-apis.js
async handleSwitchCluster(req, res) {
  this.clusterManager.setActiveCluster(clusterTag);           // 更新UI状态
  this.clusterManager.restoreClusterConfig(clusterTag);      // 恢复配置文件
  await this.switchKubectlConfig(clusterTag);                // 更新kubectl配置 ✅
}
```

#### 集群创建完成自动切换流程（修复前）
```javascript
CREATE_COMPLETE → registerCompletedCluster() → setActiveCluster() ❌ (缺少switchKubectlConfig())
```

**问题代码**：
```javascript
// index.js - registerCompletedCluster()
async function registerCompletedCluster(clusterTag, status = 'active') {
  // ... 其他逻辑
  
  // 自动设置为active cluster
  try {
    await clusterManager.setActiveCluster(clusterTag);        // 仅更新UI状态
    console.log(`Set ${clusterTag} as active cluster`);
  } catch (error) {
    console.error(`Failed to set ${clusterTag} as active cluster:`, error);
  }
  // ❌ 缺少 switchKubectlConfig() 调用
}
```

### 解决方案

#### 修复集群创建完成自动切换
在`registerCompletedCluster`函数中添加kubectl配置更新：

```javascript
// index.js - registerCompletedCluster() 修复后
async function registerCompletedCluster(clusterTag, status = 'active') {
  // ... 其他逻辑
  
  // 自动设置为active cluster并更新kubectl配置
  try {
    await clusterManager.setActiveCluster(clusterTag);
    console.log(`Set ${clusterTag} as active cluster`);
    
    // 自动更新kubectl配置
    const multiClusterAPIs = require('./multi-cluster-apis');
    const apiInstance = new multiClusterAPIs();
    await apiInstance.switchKubectlConfig(clusterTag);
    console.log(`Successfully updated kubectl config for newly created cluster: ${clusterTag}`);
  } catch (error) {
    console.error(`Failed to set ${clusterTag} as active cluster or update kubectl config:`, error);
  }
}
```

#### 统一的kubectl配置更新逻辑

**核心函数**：`switchKubectlConfig(clusterTag)`
```javascript
// multi-cluster-apis.js
async switchKubectlConfig(clusterTag) {
  // 1. 读取集群配置获取AWS_REGION和EKS集群名称
  const configDir = this.clusterManager.getClusterConfigDir(clusterTag);
  const initEnvsPath = path.join(configDir, 'init_envs');
  
  // 2. 解析环境变量
  const envContent = fs.readFileSync(initEnvsPath, 'utf8');
  const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
  const eksClusterMatch = envContent.match(/export EKS_CLUSTER_NAME=(.+)/);
  
  // 3. 执行kubectl配置更新
  const command = `aws eks update-kubeconfig --region ${awsRegion} --name ${eksClusterName}`;
  
  return new Promise((resolve, reject) => {
    exec(command, {
      timeout: 30000,
      env: { 
        ...process.env, 
        HOME: process.env.HOME || '/home/node',
        KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'
      }
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Failed to update kubectl config: ${error.message}`);
        reject(error);
      } else {
        console.log(`Successfully updated kubectl config for cluster: ${eksClusterName}`);
        resolve(stdout);
      }
    });
  });
}
```

#### 容器化环境配置

**Docker挂载配置**：
```bash
# 宿主机到容器的目录映射
/home/ubuntu/.kube:/home/node/.kube:rw     # kubectl配置同步
/home/ubuntu/.aws:/home/node/.aws:ro       # AWS凭证只读访问
```

**环境变量配置**：
```javascript
env: { 
  ...process.env, 
  HOME: process.env.HOME || '/home/node',                    # 容器内用户目录
  KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'  # kubectl配置文件路径
}
```

### 修复后的完整流程

#### 集群创建完成自动切换（修复后）
```javascript
CREATE_COMPLETE → registerCompletedCluster() → setActiveCluster() + switchKubectlConfig() ✅
```

#### 两个切换链路的统一性
1. **手动切换集群**：
   ```
   UI切换 → handleSwitchCluster() → setActiveCluster() + switchKubectlConfig() ✅
   ```

2. **集群创建完成自动切换**：
   ```
   CREATE_COMPLETE → registerCompletedCluster() → setActiveCluster() + switchKubectlConfig() ✅
   ```

**共同调用**：`switchKubectlConfig(clusterTag)` 函数

### 验证方法

#### 测试kubectl配置更新API
```bash
# 手动触发kubectl配置切换
curl -X POST http://localhost:3001/api/multi-cluster/switch-kubectl

# 验证当前kubectl上下文
kubectl config current-context
```

#### 检查容器日志
```bash
# 查看UI Panel容器日志
docker logs <container_id> --tail 20

# 期望看到的日志
[0] Updating kubectl config for cluster: eks-cluster-xxx in region: us-west-2
[0] Successfully updated kubectl config for cluster: eks-cluster-xxx
[0] Stdout: Updated context arn:aws:eks:us-west-2:xxx:cluster/eks-cluster-xxx in /home/node/.kube/config
```

### API端点

**集群切换API**：
```
POST /api/multi-cluster/switch
Body: {"clusterTag": "cluster-name"}
```

**手动kubectl配置更新API**：
```
POST /api/multi-cluster/switch-kubectl
```

### 技术细节

#### 文件路径映射
- **容器内配置文件**：`/home/node/.kube/config`
- **宿主机配置文件**：`/home/ubuntu/.kube/config`
- **同步机制**：Docker bind mount实时同步

#### 权限配置
- **AWS凭证**：容器内只读访问宿主机的`~/.aws`
- **kubectl配置**：容器内读写访问宿主机的`~/.kube`
- **环境变量**：正确设置HOME和KUBECONFIG路径

#### 错误处理
```javascript
try {
  await apiInstance.switchKubectlConfig(clusterTag);
  console.log(`Successfully updated kubectl config for newly created cluster: ${clusterTag}`);
} catch (error) {
  console.error(`Failed to update kubectl config:`, error.message);
  // 不阻断集群注册流程，仅记录警告
}
```

### 向后兼容性
- 保持现有手动切换功能不变
- 新增的自动kubectl配置更新不影响现有流程
- 错误处理确保即使kubectl更新失败也不影响集群注册

---

## 🔧 HyperPod创建完成后显示问题修复 (2025-10-16)

### 问题背景
HyperPod集群创建完成后，在HyperPod Instance Groups中点击刷新，集群没有显示，反而从creating状态变成了not exist的状态。

### 根本原因分析
**时序竞争条件**：CloudFormation CREATE_COMPLETE后的处理顺序问题
```javascript
// 问题流程
updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');  // 1. 立即清理创建状态
await registerCompletedHyperPod(clusterTag);            // 2. 异步更新metadata（需要几秒）
broadcast('hyperpod_creation_completed');               // 3. 立即广播消息
// 前端收到消息后立即刷新，但metadata可能还没更新完成
```

### 解决方案

#### 1. 后端执行顺序调整
**文件**: `ui-panel/server/index.js`

**修复关键点**：
```javascript
// 修复前：先清理状态，后更新metadata（竞争条件）
updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
await registerCompletedHyperPod(clusterTag);

// 修复后：先更新metadata，后清理状态
await registerCompletedHyperPod(clusterTag);
updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
```

**涉及位置**：
- `/api/cluster/hyperpod-creation-status/:clusterTag` (第6495行)
- `/api/cluster/creating-hyperpod-clusters` (第6555行)

#### 2. 前端WebSocket订阅增强
**文件**: `ui-panel/client/src/components/NodeGroupManager.js`

**新增专门的HyperPod创建完成处理**：
```javascript
operationRefreshManager.subscribe('hyperpod-create', async (data) => {
  if (data.type === 'hyperpod_creation_completed') {
    console.log('🎉 HyperPod creation completed, refreshing node groups...');
    await fetchNodeGroups();
    await checkHyperPodCreationStatus();
  }
});
```

#### 3. 错误处理和代码清理
- 修复`registerCompletedHyperPod`函数中的重复代码
- 增强错误处理，确保AWS API调用失败不影响主流程
- 添加详细日志追踪整个注册过程

### 修复后的完整流程
```
CloudFormation CREATE_COMPLETE 
→ registerCompletedHyperPod() (更新metadata到cluster_info.json)
→ updateCreatingHyperPodStatus('COMPLETED') (清理creating状态)
→ broadcast('hyperpod_creation_completed')
→ 前端收到WebSocket消息
→ 触发专门的hyperpod-create刷新逻辑
→ fetchNodeGroups() + checkHyperPodCreationStatus()
→ 正确显示HyperPod Instance Groups
```

### 验证结果
- ✅ 消除"creating" → "not exist" → "显示"的状态跳跃
- ✅ HyperPod创建完成后立即正确显示
- ✅ 手动刷新和自动刷新都能正常工作
- ✅ 集群切换不影响显示状态

---

## 🔧 集群导入与依赖管理优化 (2025-10-16)

### 问题背景
1. **导入集群时kubectl配置更新失败**：导入过程中`switchKubectlConfig()`在`init_envs`文件创建前被调用
2. **HyperPod集群显示混乱**：检测逻辑会显示所有区域内的HyperPod集群，包括不相关的集群
3. **依赖状态显示不合理**：导入集群和创建集群的依赖管理逻辑混淆

### 解决方案

#### 1. 修复导入集群的执行顺序
**问题**：kubectl配置更新在配置文件创建前执行
```javascript
// 修复前的错误顺序
await this.switchKubectlConfig(eksClusterName);  // 第4步
await this.clusterManager.saveImportConfig(...); // 第6步

// 修复后的正确顺序  
await this.clusterManager.saveImportConfigBasic(...); // 第5步：先保存配置
await this.switchKubectlConfig(eksClusterName);        // 第6步：再更新kubectl
```

#### 2. 优化HyperPod集群检测与显示

**检测策略改进**：
- **导入集群**：使用用户指定的HyperPod集群名称，避免自动检测不相关集群
- **创建集群**：通过UI创建的HyperPod集群自动记录到`userCreated`字段
- **显示优先级**：`userCreated` > `detected`

**数据结构**：
```json
{
  "hyperPodClusters": {
    "userCreated": [/* 通过UI创建的HyperPod集群 */],
    "detected": [/* 导入时用户指定的HyperPod集群 */]
  }
}
```

**API优化**：
```javascript
// 移除命名约定的回退逻辑，完全依赖metadata
const userCreatedClusters = clusterInfo.hyperPodClusters?.userCreated || [];
const detectedClusters = clusterInfo.hyperPodClusters?.detected || [];
const allClusters = [...userCreatedClusters, ...detectedClusters];
```

#### 3. 集群类型与依赖管理逻辑

**集群分类**：
1. **创建的EKS集群**：通过UI创建，完整的依赖管理
2. **导入的EKS+HyperPod集群**：用户指定了HyperPod集群名称
3. **导入的纯EKS集群**：用户未指定HyperPod集群名称

**依赖状态显示逻辑**：
```javascript
if (isImported) {
  if (cluster.hasHyperPod) {
    return <Tag color="default">N/A</Tag>;           // EKS+HyperPod导入
  } else {
    return <Tag color="warning">Not Configured</Tag>; // 纯EKS导入，需要配置
  }
} else {
  // 创建的集群正常显示配置状态
}
```

**HyperPod创建权限**：
- **EKS+HyperPod导入**：禁用创建按钮（已有HyperPod）
- **纯EKS导入**：需要先配置依赖才能创建HyperPod
- **创建的EKS**：配置依赖后可创建HyperPod

### 依赖检测内容

系统检测以下Kubernetes组件：

1. **AWS Load Balancer Controller** (`aws-load-balancer-controller`)
   - 命名空间：`kube-system`
   - 用途：EKS负载均衡管理

2. **S3 CSI Driver** (`s3-csi-node`)
   - 命名空间：`kube-system`  
   - 用途：S3存储挂载支持

3. **KubeRay Operator** (`kuberay-operator`)
   - 命名空间：`kuberay-operator`
   - 用途：Ray分布式计算框架

4. **Cert Manager** (`cert-manager`)
   - 命名空间：`cert-manager`
   - 用途：TLS证书自动管理

5. **Helm Dependencies**
   - 基于前述组件的综合状态
   - 至少需要3个组件正常才认为配置完成

### UI导入表单增强

**新增字段**：
```html
<Form.Item
  label="HyperPod Cluster Names (Optional)"
  name="hyperPodClusters"
  extra="Enter HyperPod cluster names associated with this EKS cluster, separated by commas"
>
  <Input.TextArea placeholder="hp-cluster-1, hp-cluster-2" rows={2} />
</Form.Item>
```

### 文件结构变化

**metadata目录结构**：
```
managed_clusters_info/{clusterTag}/
├── metadata/
│   ├── cluster_info.json      # 集群状态和检测信息
│   └── import_metadata.json   # 导入相关元数据
├── config/
│   └── init_envs             # 环境变量配置
├── logs/                     # 日志目录
└── current/                  # 当前状态目录
```

**cluster_info.json新增字段**：
```json
{
  "hasHyperPod": true,          // 是否包含HyperPod集群
  "type": "imported",           // 集群类型：imported/created
  "dependencies": {
    "configured": false,        // 是否通过UI配置过（纯EKS导入时存在）
    "detected": true,           // 是否检测过
    "effectiveStatus": false    // 有效状态
  }
}
```

### 性能优化

1. **减少不必要的检测**：导入的EKS+HyperPod集群不进行依赖检测
2. **精确的集群关联**：使用用户指定而非自动检测，避免误关联
3. **优化API调用**：只对相关集群进行AWS API调用

### 测试场景

1. **导入EKS+HyperPod集群**：
   - 输入EKS集群名称和HyperPod集群名称
   - 验证Dependencies显示"N/A"
   - 验证HyperPod Instance Groups正确显示

2. **导入纯EKS集群**：
   - 只输入EKS集群名称
   - 验证Dependencies显示"Not Configured"
   - 配置依赖后可创建HyperPod

3. **创建EKS集群**：
   - 通过UI创建完整流程
   - 验证依赖配置和HyperPod创建
   - 验证metadata正确记录

### 向后兼容性

- 保持对现有集群metadata的兼容
- 通过`registerCompletedHyperPod`自动补充缺失的HyperPod信息
- 兼容旧的依赖状态字段结构

---

### 核心目标
**架构分离**：将EKS集群创建与依赖配置完全解耦，提供清晰的用户控制流程
**端口优化**：简化网络配置，减少需要开放的端口数量
**MLflow集成**：提供一键式MLflow认证配置，简化训练作业的MLflow访问

## 🌐 网络架构优化

### 端口配置优化
**优化前**：
- 3099：前端UI端口
- 3001：后端API端口
- 8081：WebSocket端口（需要额外开放）

**优化后**：
- 3099：前端UI端口
- 3001：后端API端口（内部使用）
- 3098：WebSocket独立端口（日志流专用）

### 安全组配置
**需要开放的端口**：
- 3099：用户访问UI界面
- 3098：WebSocket实时日志流

**内部端口**：
- 3001：容器内部API通信，通过代理访问

### WebSocket服务器配置
**文件**: `ui-panel/server/index.js`

```javascript
const PORT = 3001;
const WS_PORT = 3098; // WebSocket独立端口

// WebSocket服务器使用独立端口
const wss = new WebSocket.Server({ port: WS_PORT });
```

**前端连接配置**：
```javascript
// TrainingMonitorPanel.js 和 App.js
const ws = new WebSocket('ws://localhost:3098');
```

## 🎯 解决方案设计

### 新架构流程
```
旧流程: 集群创建 → 自动依赖配置 → 完成
新流程: 集群创建 → 完成 | 用户手动配置依赖
```

### 核心设计原则
1. **快速集群创建** - CloudFormation完成后立即注册基础集群
2. **独立依赖配置** - 用户主动触发，支持重试
3. **状态透明化** - 清晰的UI状态显示和按钮控制
4. **统一刷新机制** - 集成到现有的刷新系统

## 🔧 实现阶段

### 阶段1: 简化EKS创建流程
**目标**: 移除自动依赖配置，实现快速集群创建

#### 后端修改
**文件**: `ui-panel/server/index.js`

**关键修改**:
```javascript
// 移除自动依赖配置调用
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
}
```

**cluster_info.json结构更新**:
```json
{
  "dependencies": {
    "configured": false,
    "status": "pending",
    "lastAttempt": null,
    "lastSuccess": null,
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

#### 前端修改
**文件**: `ui-panel/client/src/components/EksClusterCreationPanel.js`

**简化步骤显示**:
```javascript
const steps = [
  { title: 'Validating Parameters', description: 'Ready to validate cluster configuration' },
  { title: 'Creating CloudFormation Stack', description: 'Ready to create infrastructure' },
  { title: 'Cluster Created', description: 'Ready to register cluster' }
];
```

### 阶段2: 添加独立依赖配置功能

#### 后端API
**文件**: `ui-panel/server/index.js`

**新增API端点**:
```javascript
// 配置依赖
app.post('/api/cluster/configure-dependencies', async (req, res) => {
  // 独立的依赖配置流程
});

// 查询依赖状态
app.get('/api/cluster/:clusterTag/dependencies/status', async (req, res) => {
  // 返回依赖配置状态
});

// 取消集群创建
app.post('/api/cluster/cancel-creation/:clusterTag', async (req, res) => {
  // 删除CloudFormation Stack + 清理metadata
});
```

#### 前端组件
**文件**: `ui-panel/client/src/components/ClusterManagement.js`

**依赖配置按钮组件**:
```javascript
const DependencyConfigButton = ({ clusterTag }) => {
  const getButtonProps = () => {
    switch (depStatus.status) {
      case 'pending': return { text: 'Configure Dependencies', disabled: false, type: 'primary' };
      case 'configuring': return { text: 'Configuring...', disabled: true, type: 'primary' };
      case 'success': return { text: 'Dependencies Configured', disabled: true, type: 'default' };
      case 'failed': return { text: 'Retry Configuration', disabled: false, type: 'default' };
    }
  };
};
```

### 阶段3: MLflow认证配置集成
**目标**: 提供一键式MLflow认证配置，简化训练作业的MLflow访问

#### 后端实现
**文件**: `ui-panel/server/utils/mlflowTrackingServerManager.js`

**新增认证配置方法**:
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

**AWS资源统一获取**:
```javascript
// 使用awsHelpers统一获取AWS资源信息
const { getCurrentRegion, getCurrentAccountId, getDevAdminRoleArn } = require('./awsHelpers');

// 统一的参数获取
const region = await getCurrentRegion();
const accountId = await getCurrentAccountId();  // 新增
const s3Bucket = getCurrentS3Bucket();
const iamRoleArn = await getDevAdminRoleArn();
```

#### 前端集成
**文件**: `ui-panel/client/src/components/TrainingHistoryPanel.js`

**配置窗口增强**:
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

#### API端点
**文件**: `ui-panel/server/index.js`

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

#### 配置验证
**自动创建的资源**:
- Kubernetes Service Account: `mlflow-service-account`
- IAM角色: `EKS-MLflow-ServiceAccount-Role-{clusterTag}`
- IAM策略: `EKS-MLflow-Policy-{clusterTag}`
- 角色绑定: 通过annotation绑定到service account

**权限范围**:
- SageMaker MLflow相关权限
- S3读写权限
- 基于OIDC的安全访问控制

### 阶段4: 状态管理与UI集成

#### 按钮控制逻辑
**文件**: `ui-panel/client/src/components/NodeGroupManager.js`

**依赖状态检查**:
```javascript
const NodeGroupManager = ({ dependenciesConfigured, activeCluster, onDependencyStatusChange }) => {
  const fetchNodeGroups = async () => {
    // 获取Node Groups
    // 同时检查依赖状态
    if (onDependencyStatusChange && activeCluster) {
      const depResponse = await fetch(`/api/cluster/${activeCluster}/dependencies/status`);
      const depResult = await depResponse.json();
      if (depResult.success) {
        onDependencyStatusChange(depResult.dependencies?.configured || false);
      }
    }
  };
};
```

**按钮禁用逻辑**:
```javascript
// Create HyperPod按钮
disabled={
  !dependenciesConfigured ||   // 依赖未配置时禁用
  !!hyperPodCreationStatus ||  // 创建中时禁用
  hyperPodGroups.length > 0    // 已存在HyperPod时禁用
}

// Create Node Group按钮
disabled={!dependenciesConfigured}
```

#### Cluster Details集成
**UI布局优化**:
```
Cluster Details:
├── Custom Tag: pil-06              │ AWS Region: us-west-2
├── EKS Cluster Name: eks-...       │ Computer Node VPC: vpc-xxx
├── Creation Type: Created          │ Dependencies: [Configured]
```

## 📁 涉及文件清单

### 后端文件
- `ui-panel/server/index.js` - 主要API修改
- `ui-panel/server/utils/clusterDependencyManager.js` - 依赖管理逻辑
- `ui-panel/server/utils/hyperPodDependencyManager.js` - HyperPod依赖
- `ui-panel/server/utils/mlflowTrackingServerManager.js` - MLflow服务器和认证管理
- `ui-panel/server/utils/awsHelpers.js` - AWS资源统一获取工具
- `ui-panel/server/utils/dependencyLogManager.js` - 日志管理（可选）

### 前端文件
- `ui-panel/client/src/components/ClusterManagement.js` - 主要UI组件
- `ui-panel/client/src/components/NodeGroupManager.js` - 节点组管理
- `ui-panel/client/src/components/EksClusterCreationPanel.js` - 集群创建面板
- `ui-panel/client/src/components/TrainingHistoryPanel.js` - 训练历史和MLflow配置
- `ui-panel/client/src/App.js` - WebSocket消息处理

### 配置文件
- `managed_clusters_info/{clusterTag}/cluster_info.json` - 集群元数据
- `managed_clusters_info/creating-clusters.json` - 创建状态跟踪

## 🔄 数据流程图

### 集群创建流程

#### EKS集群创建Pipeline
```
1. 用户填写表单 → 提交创建请求
2. 后端创建CloudFormation Stack → 记录到creating-clusters.json
3. CloudFormation后台执行创建 (8-12分钟)
4. 定时检查器每60秒检查CloudFormation状态
5. 检测到CREATE_COMPLETE → 自动注册基础集群
6. 清理creating状态 → WebSocket广播完成消息
7. 前端实时收到通知 → UI显示创建成功
```

#### HyperPod集群创建Pipeline (2025-10-22新增)
```
1. 用户配置依赖 → 点击Create HyperPod
2. 后端创建CloudFormation Stack → 记录到creating-hyperpod-clusters.json
3. CloudFormation后台执行创建 (10-15分钟)
4. HyperPod定时检查器每60秒检查CloudFormation状态
5. 检测到CREATE_COMPLETE → 自动注册HyperPod集群
6. 清理creating状态 → WebSocket广播完成消息
7. 前端实时收到通知 → UI显示HyperPod创建成功
```

#### 状态检测机制 (2025-10-22优化)

**问题背景**: 原系统采用被动检测，只有用户手动刷新才会检查CloudFormation状态，导致创建完成后需要多次点击刷新才能获取成功状态。

**解决方案**: 新增主动定时检查机制

**EKS集群检测实现**: `ui-panel/server/index.js`
```javascript
// 🔄 定时检查创建中的EKS集群状态 - 每60秒检查一次
const clusterStatusCheckInterval = setInterval(async () => {
  // 检查creating-clusters.json中的所有EKS集群
  // 调用CloudFormation API获取最新状态
  // CREATE_COMPLETE时自动注册集群并广播消息
}, 60000);
```

**HyperPod集群检测实现**: `ui-panel/server/index.js` (2025-10-22新增)
```javascript
// 🔄 定时检查创建中的HyperPod集群状态 - 每60秒检查一次
const hyperPodStatusCheckInterval = setInterval(async () => {
  // 检查creating-hyperpod-clusters.json中的所有HyperPod集群
  // 调用CloudFormation API获取最新状态
  // CREATE_COMPLETE时自动注册HyperPod集群并广播消息
}, 60000);
```

**双重检测机制**:
- **EKS集群**: 检查`creating-clusters.json`，注册到`cluster_info.json`
- **HyperPod集群**: 检查`creating-hyperpod-clusters.json`，更新`hyperPodClusters.userCreated`

**优化效果**:
- ✅ **实时响应**: CloudFormation完成后最多60秒内自动通知
- ✅ **用户体验**: 无需手动刷新，状态自动更新
- ✅ **双重保障**: 定时检查 + 手动刷新两种机制并存
- ✅ **统一管理**: EKS和HyperPod使用相同的检测模式

**检测触发条件**:
1. **主动检测**: 每60秒定时检查 (新增)
2. **被动检测**: 用户点击刷新按钮或调用API (原有)

### 依赖配置流程
```
用户点击Configure Dependencies → 调用API → 后台执行安装 → 
更新状态 → WebSocket广播 → UI实时更新 → 按钮状态变化
```

### MLflow认证配置流程
```
用户点击Configure Authentication → 调用API → 创建Service Account → 
获取OIDC信息 → 创建IAM角色和策略 → 绑定角色 → WebSocket广播结果 → 
UI显示完成并关闭配置窗口
```

### 刷新机制
```
用户点击Refresh → fetchNodeGroups() → 获取依赖状态 → 
回调更新父组件 → 按钮状态自动更新
```

## 🎨 用户体验改进

### 创建体验
- **快速反馈**: 集群创建完成后立即可见
- **清晰状态**: 3步简化流程，状态明确
- **操作控制**: 用户主动选择何时配置依赖

### 按钮状态
```
Dependencies: Not Configured → 按钮禁用 + tooltip提示
Dependencies: Configuring... → 按钮禁用 + 进度显示  
Dependencies: Configured → 按钮启用 ✅
Dependencies: Failed → 按钮启用 + 重试选项
```

### 专业化改进
- **按钮持久化**: Configure Dependencies按钮不再消失，状态变化清晰
- **统一颜色**: Dependencies标签使用绿色，与Creation Type保持一致
- **全面刷新**: Refresh按钮同时更新所有相关状态

## 🛠️ 技术特性

### 状态检测机制 (2025-10-22新增)
**主动定时检查**: 每60秒自动检查创建中集群的CloudFormation状态

**EKS集群检测**:
```javascript
// 实现位置: ui-panel/server/index.js
const clusterStatusCheckInterval = setInterval(async () => {
  // 1. 读取creating-clusters.json
  // 2. 遍历所有创建中的EKS集群
  // 3. 调用CloudFormation API检查状态
  // 4. CREATE_COMPLETE时自动注册并广播
}, 60000);
```

**HyperPod集群检测** (2025-10-22新增):
```javascript
// 实现位置: ui-panel/server/index.js
const hyperPodStatusCheckInterval = setInterval(async () => {
  // 1. 读取creating-hyperpod-clusters.json
  // 2. 遍历所有创建中的HyperPod集群
  // 3. 调用CloudFormation API检查状态
  // 4. CREATE_COMPLETE时自动注册并广播
}, 60000);
```

**技术优势**:
- **实时性**: 最多60秒延迟，大幅提升响应速度
- **自动化**: 无需用户干预，系统自动处理状态转换
- **可靠性**: 定时检查 + 手动刷新双重保障
- **资源优化**: 仅检查创建中的集群，避免不必要的API调用
- **统一架构**: EKS和HyperPod使用相同的检测模式

### 日志管理
**简化实现**: 直接修改shell命令重定向
```bash
# 原来
command 2>/dev/null

# 修改后  
command >> /app/tmp/dependency-install.log 2>&1
```

**日志位置**:
- 容器内: `/app/tmp/dependency-install.log`
- 宿主机: `./tmp/dependency-install.log`

### 错误处理
- **取消创建**: 删除CloudFormation Stack + 清理metadata
- **重试机制**: 失败后可重新配置依赖
- **状态恢复**: 页面刷新后自动恢复创建状态

### WebSocket集成
**新增消息类型**:
```javascript
'cluster_creation_completed'     // 集群创建完成
'cluster_dependencies_completed' // 依赖配置完成
'cluster_dependencies_failed'    // 依赖配置失败
'cluster_creation_cancelled'     // 创建取消
'mlflow_auth_configured'         // MLflow认证配置完成
'mlflow_tracking_server_created' // MLflow Tracking Server创建完成
```

## 📊 性能优化

### 创建速度提升
- **原流程**: ~15-20分钟（包含依赖安装）
- **新流程**: ~8-12分钟（仅CloudFormation）
- **提升**: 约40-50%的时间节省

### 网络优化
- **端口数量减少**: 从3个端口减少到2个对外端口
- **安全组简化**: 只需开放3099和3098端口
- **连接稳定性**: WebSocket独立端口，避免与API混合

### 资源利用
- **并行处理**: 多个集群可同时创建
- **按需配置**: 依赖仅在需要时安装
- **状态缓存**: 减少重复API调用
- **实时通信**: WebSocket提供低延迟的日志流传输

## 🔮 未来扩展

### 可能的增强
1. **批量操作**: 支持多集群依赖配置
2. **配置模板**: 预定义依赖配置方案
3. **健康检查**: 定期验证依赖状态
4. **回滚机制**: 依赖配置失败时的回滚选项

### 架构考虑
- **微服务化**: 依赖管理可独立为服务
- **事件驱动**: 基于事件的状态管理
- **配置中心**: 集中化的依赖配置管理

## ✅ 验收标准

### 功能验收
- [x] 集群创建速度提升40%以上
- [x] 依赖配置可独立执行和重试
- [x] UI状态显示准确且实时更新
- [x] 按钮控制逻辑正确
- [x] 日志记录完整可查
- [x] WebSocket连接稳定，Log Monitor显示"Ready"状态
- [x] 实时日志流功能正常工作
- [x] MLflow认证一键配置功能正常
- [x] MLflow Tracking Server创建功能集成
- [x] AWS资源获取统一化（awsHelpers）

### 网络配置验收
- [x] 端口配置优化，减少对外暴露端口
- [x] WebSocket独立端口配置正确
- [x] 安全组配置简化（仅需3099和3098端口）
- [x] 前后端通信正常，API代理工作正常

### 用户体验验收
- [x] 创建流程清晰明了
- [x] 错误处理友好
- [x] 状态反馈及时
- [x] 操作引导明确
- [x] 实时日志查看体验良好

## 📝 总结

本次优化成功实现了EKS集群创建与依赖安装的完全解耦，通过架构分离、状态管理优化和用户体验改进，显著提升了系统的可用性和用户满意度。新架构不仅解决了原有的时序问题，还为未来的功能扩展奠定了良好基础。

### 主要成果

1. **集群创建优化**: 实现了快速集群创建和独立依赖配置的完全解耦
2. **状态检测机制优化** (2025-10-22): 
   - 新增主动定时检查机制，每60秒自动检测CloudFormation状态
   - 解决了创建完成后需要多次手动刷新的用户体验问题
   - 实现实时状态通知，最多60秒延迟自动更新UI
3. **网络架构简化**: 优化端口配置，减少对外暴露端口数量
4. **MLflow集成增强**: 
   - 一键式MLflow认证配置，自动创建Service Account和IAM角色
   - 统一的MLflow Tracking Server管理
   - 完整的权限配置和安全控制
5. **代码架构优化**: 
   - AWS资源获取统一化（awsHelpers）
   - 功能模块合理整合，减少代码重复
   - 完善的错误处理和用户反馈机制

新架构为训练作业提供了完整的MLflow访问能力，简化了用户的配置流程，提升了整体的开发和运维效率。

---

## 🔧 推理服务端口配置与测试优化 (2025-10-17)

### 功能背景
为了支持用户自定义推理服务端口，新增了端口配置功能，并确保Model Testing能够自动适配不同的端口配置。

### 端口配置功能

#### 1. **前端配置界面**
在Inference的Model Configuration中新增Port输入框：
- **默认值**: 8000
- **范围**: 1-65535
- **位置**: Docker Image字段之后
- **图标**: GlobalOutlined

#### 2. **模板文件支持**
模板文件使用`PORT_NUMBER`占位符：
```yaml
# vllm-sglang-template.yaml & vllm-sglang-model-pool-template.yaml
ports:
  - containerPort: PORT_NUMBER  # 容器端口
    name: http
---
spec:
  ports:
    - port: PORT_NUMBER         # 服务端口
      protocol: TCP
      targetPort: http
```

#### 3. **后端处理逻辑**
```javascript
// 请求参数解构
const { port = 8000 } = req.body;

// 模板替换
newYamlContent = templateContent
  .replace(/PORT_NUMBER/g, port || 8000)  // 数字类型，非字符串
  // ... 其他替换
```

### Model Testing动态端口适配

#### 核心机制
Model Testing通过`getServiceUrl`函数动态获取端口：

```javascript
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

#### 自动化流程
1. **用户配置**: 在ConfigPanel中设置自定义端口（如8080）
2. **服务部署**: 系统使用用户指定端口创建Kubernetes Service
3. **测试适配**: TestPanel自动从Service配置中读取实际端口
4. **cURL生成**: 生成包含正确端口的测试命令

#### 技术特点
- **实时获取**: 从Kubernetes Service实时读取端口配置
- **智能回退**: 无法获取时使用默认端口8000
- **自动适配**: 无需手动配置，测试功能自动适应端口变化
- **双重支持**: 同时支持外部LoadBalancer和内部ClusterIP访问

### 用户体验
- **配置简单**: 一个输入框即可自定义端口
- **测试无缝**: Model Testing自动使用正确端口
- **cURL准确**: 生成的测试命令包含实际服务端口
- **错误容错**: 端口获取失败时有合理默认值

### 验证方法
```bash
# 1. 部署自定义端口服务（如8080）
# 2. 检查Kubernetes Service配置
kubectl get svc <service-name> -o yaml

# 3. 验证TestPanel显示的Base URL
# 应显示: http://<host>:8080

# 4. 生成的cURL命令应包含正确端口
curl -X POST "http://<host>:8080/v1/chat/completions" ...
```

---

## 🔧 EKS NodeGroup Security Group统一优化 (2025-10-22)

### 功能背景
为了确保EKS NodeGroup与HyperPod计算节点使用相同的Security Group，实现网络安全配置的统一管理，避免不必要的安全组创建。

### 问题分析

#### 原始问题
- **多余安全组**: eksctl默认会创建额外的EFA安全组，导致NodeGroup有3个安全组
- **配置不一致**: EKS NodeGroup和HyperPod使用不同的安全组获取方式
- **架构混乱**: 部分信息从CloudFormation输出获取，部分通过AWS API调用

#### 安全组配置对比

**修改前 (sg-ng)**:
```
1. sg-039d36a44cf14a5e3 - eksctl自动创建的EFA安全组 ❌
2. sg-004ebec23283d206d - EKS控制平面安全组 ✅  
3. sg-0aa83046c1438614e - HyperPod安全组 ✅
```

**修改后 (sg-ng2)**:
```
1. sg-004ebec23283d206d - EKS控制平面安全组 ✅
2. sg-0aa83046c1438614e - HyperPod安全组 ✅
```

### 解决方案

#### 1. 统一安全组获取架构

**CloudFormation模板架构**:
```yaml
# 1-main-stack-eks-control.yaml
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

#### 2. eksctl配置优化

**文件**: `utils/cloudFormationManager.js`

**关键配置**:
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

**核心优化**:
- ✅ **统一来源**: Security Group直接从CloudFormation输出获取
- ✅ **保留EFA**: `efaEnabled: ${efaSupported}` 保持EFA功能
- ✅ **禁用额外SG**: `withShared: false` 阻止eksctl创建额外安全组

#### 3. 前端显示优化

**文件**: `client/src/components/EksNodeGroupCreationPanel.js`

**API增强**:
```javascript
// /api/cluster/subnets API返回统一的安全组信息
{
  "eksClusterName": "eks-cluster-xxx",
  "region": "us-west-2", 
  "vpcId": "vpc-xxx",
  "securityGroupId": "sg-0aa83046c1438614e",  // 从CloudFormation获取
  "hyperPodSecurityGroup": "sg-0aa83046c1438614e" // 验证一致性
}
```

**UI显示**:
```javascript
<Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
  <Text type="secondary">
    <strong>EKS Cluster:</strong> {clusterInfo?.eksClusterName || 'Loading...'}
  </Text>
  <Text type="secondary">
    <strong>Region:</strong> {clusterInfo?.region || 'Loading...'}
  </Text>
  <Text type="secondary">
    <strong>VPC:</strong> {clusterInfo?.vpcId || 'Loading...'}
  </Text>
  <Text type="secondary">
    <strong>Security Group:</strong> {eksSecurityGroup || 'Loading...'}
  </Text>
</Space>
```

### 技术实现

#### 后端API修改
**文件**: `server/index.js`

```javascript
// 获取CloudFormation输出信息
const stackInfo = await CloudFormationManager.fetchStackInfo(eksStackName, region);
const vpcId = stackInfo.VPC_ID;
const securityGroupId = stackInfo.SECURITY_GROUP_ID;  // 统一获取

// 验证HyperPod使用相同安全组
const hyperPodSecurityGroups = await CloudFormationManager.getHyperPodSecurityGroups(eksClusterName, region);
const hyperPodSecurityGroup = hyperPodSecurityGroups[0];

// 返回统一信息
res.json({
  success: true,
  data: {
    eksClusterName,
    region,
    vpcId,
    securityGroupId,           // EKS安全组（从CF输出）
    hyperPodSecurityGroup,     // HyperPod安全组（验证用）
    ...markedSubnets
  }
});
```

#### CloudFormationManager优化
**文件**: `utils/cloudFormationManager.js`

```javascript
static async createEksNodeGroup(nodeGroupConfig, region, clusterName, vpcId, securityGroupId, allSubnets) {
  // 直接使用传入的securityGroupId，无需额外API调用
  console.log(`Using security group: ${securityGroupId}`);
  
  // eksctl配置中禁用额外安全组创建
  const eksctlConfig = `
    securityGroups:
      attachIDs: ["${securityGroupId}"]
      withShared: false                    # 关键配置
  `;
}
```

### 验证结果

#### 创建前后对比
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

#### API测试
```bash
curl -s http://localhost:3001/api/cluster/subnets | \
  grep -o '"securityGroupId":"[^"]*"\|"hyperPodSecurityGroup":"[^"]*"'
# 输出: 
# "securityGroupId":"sg-0aa83046c1438614e"
# "hyperPodSecurityGroup":"sg-0aa83046c1438614e"
```

### 优化成果

1. **架构统一**: 所有安全组信息统一从CloudFormation输出获取
2. **配置简化**: EKS NodeGroup和HyperPod使用完全相同的安全组
3. **性能提升**: 减少不必要的AWS API调用
4. **资源优化**: 避免创建额外的EFA安全组
5. **网络一致**: 确保EKS和HyperPod节点网络配置完全一致

### 向后兼容性

- 保持现有EFA功能不变
- 兼容现有的CloudFormation模板结构  
- 前端UI保持用户友好的信息显示
- 不影响现有集群的正常运行

---

### 功能背景
为了支持 HyperPod 集群的动态扩展需求，新增了向现有 HyperPod 集群添加实例组的功能，允许用户在不重新创建集群的情况下增加计算资源。

### 功能特性

#### 1. **Add Instance Group 按钮**
- **位置**：位于 "Create HyperPod" 按钮之前
- **启用条件**：
  - ✅ 依赖已配置 (`dependenciesConfigured = true`)
  - ✅ 存在 HyperPod 集群 (`hyperPodGroups.length > 0`)
  - ❌ 无 HyperPod 创建/删除操作进行中
- **禁用条件**：
  - ❌ 依赖未配置时禁用
  - ❌ 没有 HyperPod 集群时禁用
  - ❌ HyperPod 创建/删除进行中时禁用

#### 2. **用户输入表单**
Modal 表单包含以下字段：
- **Instance Group Name** (必填)：新实例组的名称
- **Instance Type** (必填)：AutoComplete 组件，支持输入和选择
- **Instance Count** (必填)：实例数量 (1-100)
- **EBS Volume Size** (必填)：存储卷大小 (100-16000 GB)
- **Training Plan ARN** (可选)：训练计划 ARN

#### 3. **支持的实例类型**
与 Create HyperPod 完全对齐：
```javascript
ml.g5.8xlarge, ml.g5.12xlarge, ml.g5.24xlarge, ml.g5.48xlarge
ml.g6.8xlarge, ml.g6.12xlarge, ml.g6.24xlarge, ml.g6.48xlarge
ml.g6e.8xlarge, ml.g6e.12xlarge, ml.g6e.24xlarge, ml.g6e.48xlarge
ml.p4d.24xlarge, ml.p5.48xlarge, ml.p5en.48xlarge, ml.p6-b200.48xlarge
```

### 后端实现

#### API 端点
```
POST /api/cluster/hyperpod/add-instance-group
```

#### 处理逻辑
1. **集群信息获取**：
   ```javascript
   // 获取当前活跃集群
   const activeClusterName = clusterManager.getActiveCluster();
   
   // 从 cluster_info.json 读取 HyperPod 集群信息
   const userCreatedClusters = clusterInfo.hyperPodClusters?.userCreated || [];
   const detectedClusters = clusterInfo.hyperPodClusters?.detected || [];
   ```

2. **现有集群配置获取**：
   ```javascript
   // 调用 AWS API 获取现有集群详细信息
   const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.name}`;
   const clusterData = JSON.parse(describeResult.stdout);
   ```

3. **配置生成**：
   ```json
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
   ```

4. **智能配置逻辑**：
   - **LifeCycleConfig**: 从现有集群的第一个实例组获取
   - **ExecutionRole**: 从现有集群的第一个实例组获取
   - **ThreadsPerCore**: 如果提供 TrainingPlanArn 则为 2，否则为 1
   - **RootVolume**: 固定为 false

5. **AWS CLI 调用**：
   ```javascript
   // 创建临时配置文件并调用 AWS CLI
   const addCmd = `aws sagemaker update-cluster --cli-input-json file://${tempConfigPath}`;
   ```

### 前端实现

#### 组件状态管理
```javascript
const [addInstanceGroupModalVisible, setAddInstanceGroupModalVisible] = useState(false);
const [instanceGroupForm] = Form.useForm();
```

#### 按钮控制逻辑
```javascript
disabled={
  !effectiveDependenciesConfigured ||   // 依赖未配置时禁用
  !!hyperPodCreationStatus ||           // 创建中时禁用
  !!hyperPodDeletionStatus ||           // 删除中时禁用
  hyperPodGroups.length === 0           // 没有HyperPod时禁用
}
```

#### 表单处理
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

### 用户体验优化

#### 1. **实时反馈**
- 表单验证确保所有必填字段都已填写
- 提交后立即关闭 Modal 并清空表单
- 成功后显示成功消息并自动刷新实例组列表
- 错误处理显示具体错误信息

#### 2. **一致性设计**
- AutoComplete 组件与 Create HyperPod 保持一致
- 支持用户输入自定义实例类型
- 机型列表完全对齐，确保用户体验统一

#### 3. **智能配置**
- 自动继承现有集群的生命周期配置和执行角色
- 根据是否提供 Training Plan ARN 智能设置 ThreadsPerCore
- 合理的默认值设置（实例数量=1，存储=300GB）

### 技术特点

1. **配置继承**：新实例组自动继承现有集群的核心配置
2. **动态扩展**：支持在运行时向集群添加新的计算资源
3. **类型安全**：完整的表单验证和错误处理
4. **API 集成**：直接调用 AWS SageMaker API 进行集群更新
5. **状态同步**：操作完成后自动刷新 UI 状态

### 前置要求

1. **集群状态**：必须存在活跃的 HyperPod 集群
2. **依赖配置**：EKS 集群依赖必须已配置完成
3. **权限要求**：需要 SageMaker 集群更新权限
4. **网络配置**：确保 EKS 集群与 SageMaker 网络连通

### 使用场景

- **计算资源扩展**：训练任务需要更多计算节点
- **异构计算**：添加不同类型的实例以支持不同工作负载
- **弹性伸缩**：根据业务需求动态调整集群规模
- **成本优化**：按需添加实例，避免资源浪费

---

## 🔧 EKS NodeGroup 删除功能实现 (2025-10-22)

### 功能背景
为了完善EKS NodeGroup的生命周期管理，新增了删除功能，允许用户通过UI直接删除不需要的NodeGroup，提供完整的创建-扩缩容-删除管理流程。

### 实现方案

#### 1. **后端API实现**

**CloudFormationManager增强**:
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

**API端点**:
```javascript
// server/index.js
DELETE /api/cluster/nodegroup/:nodeGroupName
```

#### 2. **前端UI实现**

**删除按钮**: 在Scale按钮后添加红色Delete按钮
**状态管理**: EKS和HyperPod使用独立的loading状态
**用户反馈**: 立即显示"deletion started"消息

#### 3. **技术特点**

- **异步删除**: 使用`aws eks delete-nodegroup`实现立即响应
- **状态实时同步**: 通过`describe-nodegroup`动态获取删除状态
- **模块化设计**: 删除逻辑封装在CloudFormationManager中

### 用户操作流程

1. **点击删除** → 显示loading状态
2. **API调用** → AWS CLI执行删除命令  
3. **立即响应** → 显示"deletion started"消息
4. **状态更新** → NodeGroup状态变为"DELETING"
5. **手动刷新** → 用户可查看删除进度
6. **删除完成** → NodeGroup从列表中消失

### 架构优势

- **模块化设计**: 删除逻辑封装在CloudFormationManager中
- **状态隔离**: EKS和HyperPod删除状态完全独立  
- **异步处理**: 避免UI阻塞，提升用户体验
- **实时反馈**: 动态状态获取确保信息准确性
