const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const InferenceOperatorManager = require('./inferenceOperatorManager');

/**
 * HyperPod Managed Features Manager
 * 管理 HyperPod 集群的高级功能配置（Tiered Storage, Inference Operator 等）
 */
class ManagedFeaturesManager {
  constructor(clusterManager) {
    this.clusterManager = clusterManager;
    this.inferenceOpManager = new InferenceOperatorManager(clusterManager);
  }

  /**
   * 获取当前集群的高级功能配置（从 AWS API 实时读取）
   */
  async getAdvancedFeatures() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    
    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    // 获取集群基本信息
    const { region, hyperPodCluster } = await this._getClusterInfo(activeClusterName);

    // 从 AWS API 获取实时集群配置
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`;
    const describeResult = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeResult.stdout);

    // 检查 Inference Operator 状态
    const inferenceOpStatus = await this.inferenceOpManager.checkStatus();

    // 解析高级功能配置
    const advancedFeatures = {
      tieredStorage: this._parseTieredStorageConfig(clusterData.TieredStorageConfig),
      inferenceOperator: {
        enabled: inferenceOpStatus.installed,
        iamRoles: inferenceOpStatus.iamRoles
      }
    };

    return {
      advancedFeatures,
      clusterName: hyperPodCluster.ClusterName,
      region
    };
  }

  /**
   * 更新高级功能配置
   */
  async updateAdvancedFeatures(updates) {
    const results = {
      tieredStorage: null,
      inferenceOperator: null
    };

    // 1. 更新 Tiered Storage (如果有变化)
    if (updates.tieredStorage !== undefined) {
      results.tieredStorage = await this._updateTieredStorage(updates.tieredStorage);
    }

    // 2. 更新 Inference Operator (如果有变化)
    if (updates.inferenceOperator !== undefined) {
      results.inferenceOperator = await this._updateInferenceOperator(updates.inferenceOperator);
    }

    return {
      success: true,
      message: 'Advanced features updated successfully',
      results
    };
  }

  /**
   * 更新 Tiered Storage
   */
  async _updateTieredStorage(tieredStorage) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, hyperPodCluster, configDir } = await this._getClusterInfo(activeClusterName);

    // 获取现有集群详细信息
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`;
    const describeResult = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeResult.stdout);

    // 检查是否有变化
    const currentConfig = this._parseTieredStorageConfig(clusterData.TieredStorageConfig);
    const hasChange = 
      currentConfig.enabled !== tieredStorage.enabled ||
      (tieredStorage.enabled && 
       currentConfig.configMode !== tieredStorage.configMode) ||
      (tieredStorage.configMode === 'custom' && 
       currentConfig.percentage !== tieredStorage.percentage);

    if (!hasChange) {
      console.log('No changes in Tiered Storage configuration, skipping update');
      return { success: true, message: 'No changes detected', skipped: true };
    }

    // 构建更新配置（必须包含 InstanceGroups）
    const updateConfig = {
      ClusterName: hyperPodCluster.ClusterName,
      InstanceGroups: clusterData.InstanceGroups.map(this._cleanInstanceGroup),
      TieredStorageConfig: this._buildTieredStorageConfig(tieredStorage)
    };

    console.log('Updating Tiered Storage:', JSON.stringify(updateConfig.TieredStorageConfig, null, 2));

    // 创建临时配置文件
    const tempConfigPath = path.join(configDir, 'temp-tiered-storage-config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(updateConfig, null, 2));

    try {
      const updateCmd = `aws sagemaker update-cluster --cli-input-json file://${tempConfigPath} --region ${region}`;
      const updateResult = await execAsync(updateCmd);
      return { success: true, result: JSON.parse(updateResult.stdout) };
    } finally {
      if (fs.existsSync(tempConfigPath)) {
        fs.unlinkSync(tempConfigPath);
      }
    }
  }

  /**
   * 更新 Inference Operator
   */
  async _updateInferenceOperator(inferenceOperator) {
    if (inferenceOperator.enabled) {
      // 安装
      return await this.inferenceOpManager.install();
    } else {
      // 卸载
      return await this.inferenceOpManager.uninstall();
    }
  }

  /**
   * 获取集群基本信息（内部方法）
   */
  async _getClusterInfo(activeClusterName) {
    const configDir = this.clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');
    
    if (!fs.existsSync(initEnvsPath)) {
      throw new Error('Cluster configuration not found');
    }

    // 解析 region
    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
    const region = awsRegionMatch ? awsRegionMatch[1] : 'us-west-2';

    // 读取 metadata
    const metadataDir = this.clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    
    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error('Cluster metadata not found');
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    if (!clusterInfo.hyperPodCluster) {
      throw new Error('No HyperPod cluster found');
    }

    return {
      region,
      hyperPodCluster: clusterInfo.hyperPodCluster,
      configDir,
      metadataDir
    };
  }

  /**
   * 解析 TieredStorageConfig
   */
  _parseTieredStorageConfig(config) {
    if (!config) {
      return {
        enabled: false,
        configMode: 'default',
        percentage: null
      };
    }

    return {
      enabled: config.Mode === 'Enable',
      configMode: config.InstanceMemoryAllocationPercentage ? 'custom' : 'default',
      percentage: config.InstanceMemoryAllocationPercentage || null
    };
  }

  /**
   * 构建 TieredStorageConfig
   */
  _buildTieredStorageConfig(tieredStorage) {
    if (!tieredStorage.enabled) {
      return { Mode: 'Disable' };
    }

    const config = { Mode: 'Enable' };

    if (tieredStorage.configMode === 'custom' && tieredStorage.percentage) {
      config.InstanceMemoryAllocationPercentage = tieredStorage.percentage;
    }

    return config;
  }

  /**
   * 清理实例组配置（移除运行时字段）
   */
  _cleanInstanceGroup(instanceGroup) {
    const cleaned = {
      InstanceCount: instanceGroup.TargetCount,
      InstanceGroupName: instanceGroup.InstanceGroupName,
      InstanceType: instanceGroup.InstanceType,
      LifeCycleConfig: instanceGroup.LifeCycleConfig,
      ExecutionRole: instanceGroup.ExecutionRole,
      ThreadsPerCore: instanceGroup.ThreadsPerCore,
      InstanceStorageConfigs: instanceGroup.InstanceStorageConfigs
    };

    if (instanceGroup.TrainingPlanArn) {
      cleaned.TrainingPlanArn = instanceGroup.TrainingPlanArn;
    }

    return cleaned;
  }
}

module.exports = ManagedFeaturesManager;
