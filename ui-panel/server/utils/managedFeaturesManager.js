const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');
const InferenceOperatorManager = require('./inferenceOperatorManager');
const { cleanInstanceGroupForUpdate } = require('./instanceGroupUtils');

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

    // 检查 Training Operator 状态
    const trainingOpStatus = await this._getTrainingOperatorStatus();

    // 检查 Container Insights 状态
    const containerInsightsStatus = await this._getContainerInsightsStatus();

    // 检查 FSx CSI Driver 状态
    const fsxCsiDriverStatus = await this._getFsxCsiDriverStatus();

    // 解析高级功能配置
    const advancedFeatures = {
      tieredStorage: this._parseTieredStorageConfig(clusterData.TieredStorageConfig),
      inferenceOperator: {
        enabled: inferenceOpStatus.installed,
        iamRoles: inferenceOpStatus.iamRoles
      },
      trainingOperator: {
        enabled: trainingOpStatus.installed,
        status: trainingOpStatus.status
      },
      containerInsights: {
        enabled: containerInsightsStatus.installed,
        status: containerInsightsStatus.status
      },
      fsxCsiDriver: {
        enabled: fsxCsiDriverStatus.installed,
        status: fsxCsiDriverStatus.status
      }
    };

    return {
      advancedFeatures,
      clusterName: hyperPodCluster.ClusterName,
      region
    };
  }

  /**
   * 获取 Training Operator 状态
   */
  async _getTrainingOperatorStatus() {
    try {
      const activeClusterName = this.clusterManager.getActiveCluster();
      const { region } = await this._getClusterInfo(activeClusterName);
      const clusterInfo = JSON.parse(fs.readFileSync(
        path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
      ));
      const eksClusterName = clusterInfo.eksCluster?.name;
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };

      const cmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-training-operator --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
      const { stdout } = await execAsync(cmd);
      const status = stdout.trim();
      return { installed: status === 'ACTIVE', status };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 更新高级功能配置
   */
  async updateAdvancedFeatures(updates) {
    const results = {
      tieredStorage: null,
      inferenceOperator: null,
      trainingOperator: null,
      containerInsights: null,
      fsxCsiDriver: null
    };

    // 1. 更新 Tiered Storage (如果有变化)
    if (updates.tieredStorage !== undefined) {
      results.tieredStorage = await this._updateTieredStorage(updates.tieredStorage);
    }

    // 2. 更新 Inference Operator (如果有变化)
    if (updates.inferenceOperator !== undefined) {
      results.inferenceOperator = await this._updateInferenceOperator(updates.inferenceOperator);
    }

    // 3. 更新 Training Operator (如果有变化)
    if (updates.trainingOperator !== undefined) {
      results.trainingOperator = await this._updateTrainingOperator(updates.trainingOperator);
    }

    // 4. 更新 Container Insights (如果有变化)
    if (updates.containerInsights !== undefined) {
      results.containerInsights = await this._updateContainerInsights(updates.containerInsights);
    }

    // 5. 更新 FSx CSI Driver (如果有变化)
    if (updates.fsxCsiDriver !== undefined) {
      results.fsxCsiDriver = await this._updateFsxCsiDriver(updates.fsxCsiDriver);
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

    // 构建更新配置（InstanceGroups 使用公共清理函数，保留 OverrideVpcConfig 等字段）
    const updateConfig = {
      ClusterName: hyperPodCluster.ClusterName,
      InstanceGroups: clusterData.InstanceGroups.map(cleanInstanceGroupForUpdate),
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
      region: clusterInfo.region,
      hyperPodCluster: clusterInfo.hyperPodCluster,
      configDir: this.clusterManager.getClusterConfigDir(activeClusterName),
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
   * 更新 Training Operator
   */
  async _updateTrainingOperator(trainingOperator) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, configDir } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getTrainingOperatorStatus();

    if (trainingOperator.enabled && !currentStatus.installed) {
      // 安装 Training Operator
      return await this._installTrainingOperator(eksClusterName, region, configDir);
    } else if (!trainingOperator.enabled && currentStatus.installed) {
      // 卸载 Training Operator
      return await this._uninstallTrainingOperator(eksClusterName, region);
    }

    return { success: true, message: 'No changes needed' };
  }

  /**
   * 安装 Training Operator（等待 cert-manager 就绪）
   */
  async _installTrainingOperator(eksClusterName, region, configDir) {
    // 等待 cert-manager 就绪
    const certCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name cert-manager --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: certStatus } = await execAsync(certCmd);
    if (certStatus.trim() !== 'ACTIVE') {
      throw new Error('cert-manager addon is not ACTIVE. Please wait for it to be ready.');
    }

    const addonName = 'amazon-sagemaker-hyperpod-training-operator';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);
    const currentStatus = status.trim();

    if (currentStatus === 'ACTIVE') {
      return { success: true, message: 'Training Operator is already installed' };
    }
    if (currentStatus === 'CREATING') {
      return { success: true, message: 'Training Operator is being installed', status: 'CREATING' };
    }

    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 30000));
    }

    await execAsync(`aws eks create-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --resolve-conflicts OVERWRITE`);
    return { success: true, message: 'Training Operator installation initiated', status: 'CREATING' };
  }

  /**
   * 卸载 Training Operator
   */
  async _uninstallTrainingOperator(eksClusterName, region) {
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-training-operator --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);

    if (status.trim() === 'NOT_FOUND') {
      return { success: true, message: 'Training Operator is not installed' };
    }

    await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name amazon-sagemaker-hyperpod-training-operator --region ${region}`);
    return { success: true, message: 'Training Operator uninstalled successfully' };
  }

  /**
   * 获取 Container Insights (CloudWatch Observability) 状态
   */
  async _getContainerInsightsStatus() {
    try {
      const activeClusterName = this.clusterManager.getActiveCluster();
      const { region } = await this._getClusterInfo(activeClusterName);
      const clusterInfo = JSON.parse(fs.readFileSync(
        path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
      ));
      const eksClusterName = clusterInfo.eksCluster?.name;
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };

      const cmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name amazon-cloudwatch-observability --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
      const { stdout } = await execAsync(cmd);
      const status = stdout.trim();
      return { installed: status === 'ACTIVE', status };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 获取 FSx CSI Driver 状态
   */
  async _getFsxCsiDriverStatus() {
    try {
      const activeClusterName = this.clusterManager.getActiveCluster();
      const { region } = await this._getClusterInfo(activeClusterName);
      const clusterInfo = JSON.parse(fs.readFileSync(
        path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
      ));
      const eksClusterName = clusterInfo.eksCluster?.name;
      if (!eksClusterName) return { installed: false, status: 'NOT_FOUND' };

      const cmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name aws-fsx-csi-driver --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
      const { stdout } = await execAsync(cmd);
      const status = stdout.trim();
      return { installed: status === 'ACTIVE', status };
    } catch (error) {
      return { installed: false, status: 'NOT_FOUND' };
    }
  }

  /**
   * 更新 FSx CSI Driver
   */
  async _updateFsxCsiDriver(fsxCsiDriver) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, configDir } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getFsxCsiDriverStatus();

    if (fsxCsiDriver.enabled && !currentStatus.installed) {
      return await this._installFsxCsiDriver(eksClusterName, region, configDir);
    } else if (!fsxCsiDriver.enabled && currentStatus.installed) {
      return await this._uninstallFsxCsiDriver(eksClusterName, region);
    }

    return { success: true, message: 'No changes needed' };
  }

  /**
   * 安装 FSx CSI Driver（创建 IAM Role + EKS Addon）
   */
  async _installFsxCsiDriver(eksClusterName, region, configDir) {
    const addonName = 'aws-fsx-csi-driver';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);
    const currentStatus = status.trim();

    if (currentStatus === 'ACTIVE') {
      return { success: true, message: 'FSx CSI Driver is already installed' };
    }
    if (currentStatus === 'CREATING') {
      return { success: true, message: 'FSx CSI Driver is being installed', status: 'CREATING' };
    }

    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 30000));
    }

    // 创建 IAM Role
    const roleName = `SM_HP_FSX_CSI_ROLE_${eksClusterName}`;
    await execAsync(`eksctl create iamserviceaccount --name fsx-csi-controller-sa --namespace kube-system --override-existing-serviceaccounts --cluster ${eksClusterName} --attach-policy-arn arn:aws:iam::aws:policy/AmazonFSxFullAccess --role-name ${roleName} --region ${region} --approve --role-only 2>/dev/null || true`);

    const { stdout: roleArn } = await execAsync(`aws iam get-role --role-name ${roleName} --query "Role.Arn" --output text`);

    await execAsync(`aws eks create-addon --name ${addonName} --cluster-name ${eksClusterName} --service-account-role-arn ${roleArn.trim()} --region ${region} --resolve-conflicts OVERWRITE`);
    return { success: true, message: 'FSx CSI Driver installation initiated', status: 'CREATING' };
  }

  /**
   * 卸载 FSx CSI Driver
   */
  async _uninstallFsxCsiDriver(eksClusterName, region) {
    const addonName = 'aws-fsx-csi-driver';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);

    if (status.trim() === 'NOT_FOUND') {
      return { success: true, message: 'FSx CSI Driver is not installed' };
    }

    await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region}`);

    // 清理 eksctl 创建的 IAM service account 及其 CloudFormation stack
    const roleName = `SM_HP_FSX_CSI_ROLE_${eksClusterName}`;
    await execAsync(`eksctl delete iamserviceaccount --name fsx-csi-controller-sa --namespace kube-system --cluster ${eksClusterName} --region ${region} 2>/dev/null || true`);

    return { success: true, message: 'FSx CSI Driver uninstalled successfully' };
  }

  /**
   * 更新 Container Insights
   */
  async _updateContainerInsights(containerInsights) {
    const activeClusterName = this.clusterManager.getActiveCluster();
    const { region, hyperPodCluster } = await this._getClusterInfo(activeClusterName);
    const clusterInfo = JSON.parse(fs.readFileSync(
      path.join(this.clusterManager.getClusterDir(activeClusterName), 'metadata', 'cluster_info.json'), 'utf8'
    ));
    const eksClusterName = clusterInfo.eksCluster?.name;
    if (!eksClusterName) throw new Error('EKS cluster not found');

    const currentStatus = await this._getContainerInsightsStatus();

    if (containerInsights.enabled && !currentStatus.installed) {
      return await this._installContainerInsights(eksClusterName, region, hyperPodCluster.ClusterName);
    } else if (!containerInsights.enabled && currentStatus.installed) {
      return await this._uninstallContainerInsights(eksClusterName, region);
    }

    return { success: true, message: 'No changes needed' };
  }

  /**
   * 安装 Container Insights (CloudWatch Observability)
   * 1. 给 HyperPod Execution Role 附加 CloudWatchAgentServerPolicy
   * 2. 安装 amazon-cloudwatch-observability EKS addon
   */
  async _installContainerInsights(eksClusterName, region, hyperPodClusterName) {
    const addonName = 'amazon-cloudwatch-observability';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);
    const currentStatus = status.trim();

    if (currentStatus === 'ACTIVE') {
      return { success: true, message: 'Container Insights is already installed' };
    }
    if (currentStatus === 'CREATING') {
      return { success: true, message: 'Container Insights is being installed', status: 'CREATING' };
    }

    // 获取 Execution Role 并附加 CloudWatch 权限
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodClusterName} --region ${region} --output json`;
    const { stdout: describeOut } = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeOut);
    const roleArn = clusterData.InstanceGroups?.[0]?.ExecutionRole;
    if (roleArn) {
      const roleName = roleArn.split('/').pop();
      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy 2>/dev/null || true`);
    }

    if (currentStatus === 'CREATE_FAILED' || currentStatus === 'DEGRADED') {
      await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} 2>/dev/null || true`);
      await new Promise(r => setTimeout(r, 30000));
    }

    await execAsync(`aws eks create-addon --addon-name ${addonName} --cluster-name ${eksClusterName} --region ${region} --resolve-conflicts OVERWRITE`);
    return { success: true, message: 'Container Insights installation initiated', status: 'CREATING' };
  }

  /**
   * 卸载 Container Insights
   */
  async _uninstallContainerInsights(eksClusterName, region) {
    const addonName = 'amazon-cloudwatch-observability';
    const statusCmd = `aws eks describe-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region} --query "addon.status" --output text 2>/dev/null || echo "NOT_FOUND"`;
    const { stdout: status } = await execAsync(statusCmd);

    if (status.trim() === 'NOT_FOUND') {
      return { success: true, message: 'Container Insights is not installed' };
    }

    await execAsync(`aws eks delete-addon --cluster-name ${eksClusterName} --addon-name ${addonName} --region ${region}`);
    return { success: true, message: 'Container Insights uninstalled successfully' };
  }
}

module.exports = ManagedFeaturesManager;
