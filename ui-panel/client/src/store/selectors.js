/**
 * 全局选择器文件
 * 包含跨越多个 state slices 的复杂选择器
 */

// 集群相关选择器
export const selectActiveCluster = state => state.clusters.activeCluster;
export const selectClustersList = state => state.clusters.list;
export const selectClusterDetails = state => state.clusters.clusterDetails;
export const selectDependenciesStatus = state => state.clusters.dependencies;
export const selectClusterLoading = state => state.clusters.loading;
export const selectClusterError = state => state.clusters.error;
export const selectCreatingClusters = state => state.clusters.creatingClusters;

// 获取有效的依赖配置状态（考虑导入集群的特殊情况）
export const selectEffectiveDependenciesStatus = state => {
  const { clusterDetails, dependencies } = state.clusters;

  // 如果是导入的集群且有HyperPod，则视为已配置
  if (clusterDetails?.type === 'imported' && clusterDetails?.hyperPodCluster) {
    return true;
  }

  return dependencies?.configured || false;
};

// 节点组相关选择器
export const selectEksNodeGroups = state => state.nodeGroups.eksNodeGroups;
export const selectHyperPodGroups = state => state.nodeGroups.hyperPodGroups;
export const selectNodeGroupsLoading = state => state.nodeGroups.loading;
export const selectNodeGroupsError = state => state.nodeGroups.error;
export const selectHyperPodCreationStatus = state => state.nodeGroups.hyperPodCreationStatus;
export const selectHyperPodDeletionStatus = state => state.nodeGroups.hyperPodDeletionStatus;
export const selectInstanceGroupAdditionStatus = state => state.nodeGroups.instanceGroupAdditionStatus;
export const selectNodeGroupScalingStatus = state => state.nodeGroups.nodeGroupScalingStatus;
export const selectNodeGroupDeletionStatus = state => state.nodeGroups.nodeGroupDeletionStatus;

// 推理服务相关选择器
export const selectDeployments = state => state.inference.deployments;
export const selectServices = state => state.inference.services;
export const selectInferenceLoading = state => state.inference.loading;
export const selectInferenceError = state => state.inference.error;
export const selectDeployStatus = state => state.inference.deployStatus;
export const selectServiceStatus = state => state.inference.serviceStatus;
export const selectUndeployStatus = state => state.inference.undeployStatus;
export const selectScaleStatus = state => state.inference.scaleStatus;
export const selectTestResults = state => state.inference.testResults;
export const selectTestLoading = state => state.inference.testLoading;
export const selectTestError = state => state.inference.testError;

// 训练作业相关选择器
export const selectTrainingJobs = state => state.training.jobs;
export const selectTrainingHistory = state => state.training.history;
export const selectActiveJob = state => state.training.activeJob;
export const selectTrainingLoading = state => state.training.loading;
export const selectTrainingError = state => state.training.error;
export const selectTrainingStatus = state => state.training.trainingStatus;
export const selectDeleteStatus = state => state.training.deleteStatus;
export const selectMlflowAuthStatus = state => state.training.mlflowAuthStatus;
export const selectMlflowServerStatus = state => state.training.mlflowServerStatus;
export const selectMlflowSyncStatus = state => state.training.mlflowSyncStatus;
export const selectJobLogs = state => state.training.jobLogs;

// 选择特定作业的日志
export const selectJobLogsByName = (state, jobName) => state.training.jobLogs[jobName] || [];