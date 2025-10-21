# VeRL项目 KubeRay 迁移指南

## 文件说明

### 核心文件
- **`kuberay_helper.py`** - KubeRay辅助类，使用kubectl CLI与Kubernetes交互
- **`kuberay_entrypoint.py`** - Kubernetes环境下的训练入口脚本
- **`deploy_kuberay.sh`** - 部署和管理脚本（主要工具）

### 配置文件
- **`kuberay-cluster.yaml`** - Ray集群配置（独立部署）
- **`verl-training-job.yaml`** - Ray训练任务配置（包含集群+任务）

### 训练脚本
- **`qwen-3b-grpo-kuberay.sh`** - 适配KubeRay的训练脚本

## 快速开始

### 1. 检查环境
确保KubeRay Operator已安装并运行：
```bash
kubectl get pods -n kube-system | grep kuberay
```

### 2. 部署Ray集群
```bash
# 部署独立的Ray集群
./deploy_kuberay.sh deploy-cluster

# 检查集群状态
./deploy_kuberay.sh status
```

### 3. 运行训练任务
```bash
# 方式1：使用RayJob（推荐）
./deploy_kuberay.sh deploy-job

# 方式2：在现有集群上运行
kubectl exec -it <head-pod-name> -- python /opt/ml/code/kuberay_entrypoint.py
```

### 4. 监控和调试
```bash
# 查看训练日志
./deploy_kuberay.sh logs

# 访问Ray Dashboard
./deploy_kuberay.sh dashboard
# 然后访问 http://localhost:8265
```

### 5. 清理资源
```bash
./deploy_kuberay.sh cleanup
```

## 部署脚本命令

| 命令 | 功能 |
|------|------|
| `deploy-cluster` | 部署Ray集群 |
| `deploy-job` | 部署训练任务 |
| `status` | 查看集群/任务状态 |
| `logs` | 获取训练日志 |
| `cleanup` | 清理所有资源 |
| `dashboard` | 端口转发Ray Dashboard |

## 与原版本的区别

### 原版本（基于SageMaker/手动Ray）
- 使用环境变量 `SM_RESOURCE_CONFIG` 发现节点
- 手动启动Ray集群
- 依赖主机名解析

### KubeRay版本
- 使用Kubernetes Service Discovery
- KubeRay自动管理Ray集群
- 通过kubectl CLI交互

## 配置调整

### 资源配置
在 `kuberay-cluster.yaml` 中调整：
```yaml
resources:
  limits:
    nvidia.com/gpu: 4  # GPU数量
    memory: 32Gi       # 内存
```

### 多节点训练
修改 `workerGroupSpecs.replicas`：
```yaml
workerGroupSpecs:
- replicas: 3  # worker节点数量
```

## 故障排除

### 常见问题
1. **集群启动失败** - 检查GPU资源是否足够
2. **连接超时** - 确保Service正确创建
3. **训练脚本找不到** - 检查hostPath挂载路径

### 调试命令
```bash
# 查看Pod详情
kubectl describe pod <pod-name>

# 查看集群事件
kubectl get events --sort-by=.metadata.creationTimestamp

# 进入Pod调试
kubectl exec -it <pod-name> -- /bin/bash
```

## 注意事项

1. **存储**: 当前使用hostPath，生产环境建议使用PVC
2. **网络**: 确保Pod间网络通信正常
3. **资源**: 根据实际GPU节点调整资源配置
4. **权限**: 确保有足够的Kubernetes权限操作资源
