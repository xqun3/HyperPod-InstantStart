/**
 * HyperPod API Manager
 *
 * 管理 HyperPod 集群的所有 API，包括：
 * - 集群生命周期（创建、删除、状态查询）
 * - Instance Group 管理（扩缩容、添加、删除）
 * - 节点操作（重启、替换）
 * - 软件更新和高级特性
 *
 * 扩展点：
 * - shouldUseThreadsPerCore2(): 可被覆盖以支持不同的实例类型判断逻辑
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// 依赖模块
const ClusterManager = require('./clusterManager');
const CloudFormationManager = require('./utils/cloudFormationManager');
const HyperPodDependencyManager = require('./utils/hyperPodDependencyManager');
const MetadataUtils = require('./utils/metadataUtils');
const SubnetManager = require('./utils/subnetManager');
const NetworkManager = require('./utils/networkManager');

// 常量
const MANAGED_CLUSTERS_DIR = path.join(__dirname, '../managed_clusters_info');
const CREATING_HYPERPOD_CLUSTERS_FILE = path.join(MANAGED_CLUSTERS_DIR, 'creating-hyperpod-clusters.json');

// 模块级变量
let broadcastFn = null;
let clusterManager = null;

/**
 * 初始化模块
 * @param {Function} broadcast - WebSocket 广播函数
 * @param {ClusterManager} cm - 集群管理器实例
 */
function initialize(broadcast, cm) {
  broadcastFn = broadcast;
  clusterManager = cm || new ClusterManager();
}

/**
 * 广播消息
 */
function broadcast(data) {
  if (broadcastFn) {
    broadcastFn(data);
  }
}

// ============================================================
// 扩展点：实例类型相关逻辑
// ============================================================

/**
 * 判断是否需要 ThreadsPerCore=2
 * 扩展点：Neuron 项目可以覆盖此函数
 *
 * @param {string} instanceType - 实例类型
 * @param {string} trainingPlanArn - Training Plan ARN
 * @returns {boolean}
 */
function shouldUseThreadsPerCore2(instanceType, trainingPlanArn) {
  if (trainingPlanArn) return true;
  if (!instanceType) return false;
  const type = instanceType.toLowerCase();
  // HyperPod GPU 实例需要 ThreadsPerCore=2
  return type.startsWith('ml.p4') || type.startsWith('ml.p5') || type.startsWith('ml.p6');
}

// ============================================================
// 辅助函数：创建状态管理
// ============================================================

/**
 * 获取正在创建的 HyperPod 集群
 */
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

/**
 * 更新创建中的 HyperPod 状态
 */
function updateCreatingHyperPodStatus(clusterTag, statusUpdate) {
  try {
    const creatingClusters = getCreatingHyperPodClusters();

    if (statusUpdate === 'COMPLETED') {
      delete creatingClusters[clusterTag];
    } else {
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

/**
 * 注册已完成的 HyperPod 集群
 */
async function registerCompletedHyperPod(clusterTag) {
  try {
    console.log(`HyperPod cluster ${clusterTag} creation completed`);

    // 配置 HyperPod 自定义依赖
    await HyperPodDependencyManager.configureHyperPodDependencies(clusterTag, clusterManager);

    // 将创建的 HyperPod 集群信息添加到 metadata
    const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (fs.existsSync(clusterInfoPath)) {
      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

      // 获取 HyperPod 集群名称（使用命名约定）
      const hyperPodClusterName = `hp-cluster-${clusterTag}`;

      try {
        const region = clusterInfo.region || 'us-west-2';

        const hpCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodClusterName} --region ${region} --output json`;
        const hpResult = await execAsync(hpCmd);
        const hpData = JSON.parse(hpResult.stdout);

        // 添加来源标识
        hpData.source = 'ui-created';

        // 保存完整的 HyperPod 集群信息
        clusterInfo.hyperPodCluster = hpData;
        clusterInfo.lastModified = new Date().toISOString();

        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
        console.log(`Saved complete HyperPod cluster info for ${clusterTag} (ui-created)`);

      } catch (error) {
        console.warn('Failed to get HyperPod cluster details for metadata:', error.message);
      }
    }

  } catch (error) {
    console.error('Error registering completed HyperPod:', error);
  }
}

// ============================================================
// API 路由
// ============================================================

/**
 * 创建 HyperPod 集群
 * POST /api/cluster/create-hyperpod
 */
router.post('/create-hyperpod', async (req, res) => {
  try {
    const { userConfig } = req.body;

    // 获取当前活跃集群信息
    const activeCluster = clusterManager.getActiveCluster();
    console.log('Active cluster:', activeCluster);
    if (!activeCluster) {
      return res.status(400).json({ success: false, error: 'No active cluster selected' });
    }

    // 检查 kubectl 连通性
    try {
      console.log('Testing kubectl connectivity...');
      const kubectlResult = execSync('kubectl cluster-info', { encoding: 'utf8', timeout: 15000 });
      console.log('kubectl cluster-info result:', kubectlResult);
    } catch (error) {
      console.error('kubectl connectivity test failed:', error.message);
      return res.status(400).json({
        success: false,
        error: `EKS cluster not accessible via kubectl: ${error.message}`
      });
    }

    // 获取 EKS 集群信息
    const eksClusterInfo = MetadataUtils.getEKSClusterInfo(activeCluster);
    const region = MetadataUtils.getClusterRegion(activeCluster);

    if (!eksClusterInfo || !region) {
      return res.status(400).json({
        success: false,
        error: 'EKS cluster information not found in metadata'
      });
    }

    console.log('EKS cluster info from metadata:', eksClusterInfo);

    // 获取 NAT Gateway ID
    const ClusterDependencyManager = require('./utils/clusterDependencyManager');
    const natGatewayId = await ClusterDependencyManager.getNatGatewayId(eksClusterInfo.vpcId, region);

    // 从 SageMaker 角色 ARN 中提取角色名称
    const sageMakerRoleName = eksClusterInfo.sageMakerRoleArn ?
      eksClusterInfo.sageMakerRoleArn.split('/').pop() : null;

    // 构建 EKS 基础设施信息
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

    // 生成 HyperPod 配置
    const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
    const clusterTag = userConfig.clusterTag;
    const hyperPodStackName = `hyperpod-${clusterTag}-${timestamp}`;
    const eksClusterTag = activeCluster;
    const hyperPodClusterName = `hp-cluster-${eksClusterTag}`;

    // 获取可用区 ID
    const azCommand = `aws ec2 describe-availability-zones --region ${region} --query "AvailabilityZones[?ZoneName=='${userConfig.availabilityZone}'].ZoneId" --output text`;
    const azResult = execSync(azCommand, { encoding: 'utf8' });
    const availabilityZoneId = azResult.trim();

    // 确保目标 AZ 有 Public Subnet
    // 注释掉自动创建，避免 CIDR 冲突问题
    // console.log(`\n🔍 Ensuring public subnet exists in ${userConfig.availabilityZone}...`);
    // try {
    //   const publicSubnetResult = await SubnetManager.ensurePublicSubnet({
    //     vpcId: eksInfrastructureInfo.VPC_ID,
    //     availabilityZone: userConfig.availabilityZone,
    //     clusterTag: activeCluster,
    //     region: region
    //   });

    //   console.log(`✅ Public subnet ready: ${publicSubnetResult.subnetId} (${publicSubnetResult.subnetName})`);
    //   if (publicSubnetResult.created) {
    //     console.log(`   Created new subnet with CIDR: ${publicSubnetResult.cidrBlock}`);
    //   }
    // } catch (subnetError) {
    //   console.error('❌ Failed to ensure public subnet:', subnetError);
    //   return res.status(500).json({
    //     success: false,
    //     error: `Failed to ensure public subnet in ${userConfig.availabilityZone}: ${subnetError.message}`
    //   });
    // }

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
      const savedCidrConfig = JSON.parse(fs.readFileSync(cidrConfigPath, 'utf8'));
      hyperPodPrivateSubnetCidr = savedCidrConfig.hyperPodPrivateSubnetCidr;
      console.log('Using saved HyperPod CIDR from metadata:', hyperPodPrivateSubnetCidr);
    } else {
      console.log('CIDR metadata not found, generating new CIDR config');
      const cidrResult = await NetworkManager.generateCidrConfig(region);
      hyperPodPrivateSubnetCidr = cidrResult.hyperPodPrivateSubnetCidr;
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

    // 构建 HyperPod 配置
    const hyperPodConfig = {
      ResourceNamePrefix: clusterTag,
      AvailabilityZoneId: availabilityZoneId,
      PrivateSubnet1CIDR: hyperPodPrivateSubnetCidr,
      HyperPodClusterName: hyperPodClusterName,
      NodeRecovery: 'None',
      UseContinuousNodeProvisioningMode: 'true',
      CreateAcceleratedInstanceGroup: 'true',
      AcceleratedInstanceGroupName: `hpig-${clusterTag}`,
      AcceleratedInstanceType: userConfig.AcceleratedInstanceType,
      AcceleratedInstanceCount: userConfig.AcceleratedInstanceCount,
      AcceleratedEBSVolumeSize: userConfig.AcceleratedEBSVolumeSize,
      AcceleratedTrainingPlanArn: userConfig.AcceleratedTrainingPlanArn || '',
      AcceleratedThreadsPerCore: shouldUseThreadsPerCore2(userConfig.AcceleratedInstanceType, userConfig.AcceleratedTrainingPlanArn) ? 2 : 1,
      EnableInstanceStressCheck: 'false',
      EnableInstanceConnectivityCheck: 'false'
    };

    // 确定使用的 compute subnet：用户指定 > 自动检测已存在的 > CF 自动创建
    if (userConfig.computeSubnetId) {
      // 用户明确指定了 subnet
      hyperPodConfig.ExistingPrivateSubnetId = userConfig.computeSubnetId;
      console.log(`Using user-specified compute subnet: ${userConfig.computeSubnetId}`);
    } else if (userConfig.availabilityZone) {
      // 检测 hp-compute-{az} 是否已存在
      const existingSubnet = await NetworkManager.findComputeSubnet(
        eksInfrastructureInfo.VPC_ID, userConfig.availabilityZone, region
      );
      if (existingSubnet) {
        hyperPodConfig.ExistingPrivateSubnetId = existingSubnet.subnetId;
        console.log(`Using existing compute subnet: ${existingSubnet.subnetId} (hp-compute-${userConfig.availabilityZone})`);
      }
    }

    const stackResult = await CloudFormationManager.createHyperPodStack(
      hyperPodStackName,
      region,
      eksInfrastructureInfo,
      hyperPodConfig
    );

    // 保存配置到 metadata
    await clusterManager.saveHyperPodConfig(activeCluster, {
      stackName: hyperPodStackName,
      stackId: stackResult.stackId,
      region: region,
      userConfig: userConfig,
      infrastructureInfo: eksInfrastructureInfo,
      createdAt: new Date().toISOString()
    });

    // 发送 WebSocket 通知
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

/**
 * 删除 HyperPod 集群
 * DELETE /api/cluster/:clusterTag/hyperpod
 */
router.delete('/:clusterTag/hyperpod', async (req, res) => {
  try {
    const { clusterTag } = req.params;

    // 读取 HyperPod 配置获取 stackId
    const hyperPodConfigPath = path.join(MANAGED_CLUSTERS_DIR, clusterTag, 'metadata/hyperpod-config.json');

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

    // 使用 AWS CLI 删除 CloudFormation Stack
    const deleteCommand = `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`;
    execSync(deleteCommand, { encoding: 'utf8', timeout: 30000 });

    // WebSocket 广播删除开始
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

/**
 * 扩缩容 HyperPod Instance Group
 * PUT /api/cluster/hyperpod/instances/:name/scale
 */
router.put('/hyperpod/instances/:name/scale', async (req, res) => {
  try {
    const { name } = req.params;
    const { targetCount } = req.body;

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

    // 解析 init_envs 文件
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

    // 根据 AWS CLI 文档，update-cluster 支持的字段
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

    // 修改 InstanceCount 为目标值
    updateInstanceGroup.InstanceCount = targetCount;

    const cmd = `aws sagemaker update-cluster --cluster-name ${hpClusterName} --instance-groups '${JSON.stringify(updateInstanceGroup)}' --region ${region}`;

    console.log('Executing HyperPod scaling command:', cmd);
    console.log('Update instance group object:', JSON.stringify(updateInstanceGroup, null, 2));

    await execAsync(cmd);

    // WebSocket 通知
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

/**
 * 添加 Instance Group
 * POST /api/cluster/hyperpod/add-instance-group
 */
router.post('/hyperpod/add-instance-group', async (req, res) => {
  try {
    const { userConfig } = req.body;
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

    // 从 metadata 中获取 HyperPod 集群信息
    const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (!fs.existsSync(clusterInfoPath)) {
      return res.status(400).json({ error: 'Cluster metadata not found' });
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found' });
    }

    const hyperPodCluster = clusterInfo.hyperPodCluster;

    // 获取现有集群的详细信息
    const describeCmd = `aws sagemaker describe-cluster --cluster-name ${hyperPodCluster.ClusterName} --region ${region} --output json`;
    const describeResult = await execAsync(describeCmd);
    const clusterData = JSON.parse(describeResult.stdout);

    // 清理现有实例组的运行时字段
    const cleanInstanceGroup = (instanceGroup) => {
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

    // 如果是 Spot 实例
    if (userConfig.isSpot) {
      newInstanceGroup.CapacityRequirements = { Spot: {} };
    }

    // Compute Subnet 选择优先级：用户指定 > 自动检测已存在 > 自动创建
    if (userConfig.subnetId || userConfig.availabilityZone) {
      const vpcId = clusterData.VpcConfig?.Subnets?.[0] ?
        (() => {
          const subnetCmd = `aws ec2 describe-subnets --region ${region} --subnet-ids ${clusterData.VpcConfig.Subnets[0]} --query "Subnets[0].VpcId" --output text`;
          return execSync(subnetCmd, { encoding: 'utf8' }).trim();
        })() : clusterInfo.cloudFormation?.outputs?.OutputVpcId;

      const securityGroupId = clusterData.VpcConfig?.SecurityGroupIds?.[0] ||
                             clusterInfo.eksCluster?.securityGroupId;

      let computeSubnetId;

      if (userConfig.subnetId) {
        // 用户明确指定
        computeSubnetId = userConfig.subnetId;
        console.log(`Using user-specified compute subnet: ${computeSubnetId}`);
      } else {
        // 自动检测/创建
        const eksClusterName = clusterInfo.cloudFormation?.outputs?.OutputEKSClusterName || activeClusterName;
        const result = await NetworkManager.ensureComputeSubnet(
          vpcId, userConfig.availabilityZone, region, eksClusterName
        );
        computeSubnetId = result.subnetId;
        console.log(`Using compute subnet: ${computeSubnetId} (created: ${result.created})`);
      }

      newInstanceGroup.OverrideVpcConfig = {
        SecurityGroupIds: [securityGroupId],
        Subnets: [computeSubnetId]
      };
    }

    // 如果有 TrainingPlanArn
    if (userConfig.trainingPlanArn) {
      newInstanceGroup.TrainingPlanArn = userConfig.trainingPlanArn;
    }

    // 构建完整的实例组配置
    const instanceGroupConfig = {
      ClusterName: hyperPodCluster.ClusterName,
      InstanceGroups: [
        ...clusterData.InstanceGroups.map(cleanInstanceGroup),
        newInstanceGroup
      ]
    };

    console.log('Generated instance group config:', JSON.stringify(instanceGroupConfig, null, 2));

    // 创建临时配置文件
    const tempConfigPath = path.join(configDir, 'temp-instance-group-config.json');
    fs.writeFileSync(tempConfigPath, JSON.stringify(instanceGroupConfig, null, 2));

    // 调用 AWS CLI 添加实例组
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

/**
 * 删除 Instance Group
 * POST /api/cluster/hyperpod/delete-instance-group
 */
router.post('/hyperpod/delete-instance-group', async (req, res) => {
  try {
    const { instanceGroupName } = req.body;
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

    // 从 metadata 中获取 HyperPod 集群信息
    const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

    if (!fs.existsSync(clusterInfoPath)) {
      return res.status(400).json({ error: 'Cluster metadata not found' });
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

    if (!clusterInfo.hyperPodCluster) {
      return res.status(400).json({ error: 'No HyperPod cluster found' });
    }

    const hyperPodCluster = clusterInfo.hyperPodCluster;

    console.log(`Deleting instance group "${instanceGroupName}" from cluster "${hyperPodCluster.ClusterName}"`);

    // 调用 AWS CLI 删除实例组
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

/**
 * 更新软件
 * POST /api/cluster/hyperpod/update-software
 */
router.post('/hyperpod/update-software', async (req, res) => {
  try {
    const { clusterArn } = req.body;

    const activeClusterName = clusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置
    const configDir = clusterManager.getClusterConfigDir(activeClusterName);
    const initEnvsPath = path.join(configDir, 'init_envs');

    if (!fs.existsSync(initEnvsPath)) {
      return res.status(400).json({ error: 'Cluster configuration file not found' });
    }

    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
    const region = awsRegionMatch ? awsRegionMatch[1] : 'us-west-2';

    // 使用 AWS CLI 更新软件
    const updateCmd = `aws sagemaker update-cluster-software --cluster-identifier "${clusterArn}" --region ${region}`;
    const result = await execAsync(updateCmd);

    console.log('Update software result:', result.stdout);

    broadcast({
      type: 'hyperpod_software_update',
      status: 'success',
      message: 'HyperPod software update initiated'
    });

    res.json({ success: true, message: 'Software update initiated' });
  } catch (error) {
    console.error('Error updating HyperPod software:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取高级特性配置
 * GET /api/cluster/hyperpod/advanced-features
 */
router.get('/hyperpod/advanced-features', async (req, res) => {
  try {
    const ManagedFeaturesManager = require('./utils/managedFeaturesManager');
    const manager = new ManagedFeaturesManager(clusterManager);
    const result = await manager.getAdvancedFeatures();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error getting advanced features:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 设置高级特性配置
 * POST /api/cluster/hyperpod/advanced-features
 */
router.post('/hyperpod/advanced-features', async (req, res) => {
  try {
    const ManagedFeaturesManager = require('./utils/managedFeaturesManager');
    const manager = new ManagedFeaturesManager(clusterManager);
    const result = await manager.updateAdvancedFeatures(req.body);
    res.json(result);
  } catch (error) {
    console.error('Error setting advanced features:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取 HyperPod 创建状态
 * GET /api/cluster/hyperpod-creation-status/:clusterTag
 */
router.get('/hyperpod-creation-status/:clusterTag', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const creatingClusters = getCreatingHyperPodClusters();
    const status = creatingClusters[clusterTag];

    if (!status) {
      return res.json({ success: true, status: null });
    }

    // 检查 CloudFormation 状态
    if (status.stackName && status.region) {
      try {
        const checkCmd = `aws cloudformation describe-stacks --stack-name ${status.stackName} --region ${status.region} --query 'Stacks[0].StackStatus' --output text`;
        const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();

        if (stackStatus === 'CREATE_COMPLETE') {
          status.cfStatus = 'CREATE_COMPLETE';
          return res.json({ success: true, status: { ...status, cfStatus: 'CREATE_COMPLETE' } });
        } else if (stackStatus.includes('FAILED') || stackStatus.includes('ROLLBACK') || stackStatus.includes('DELETE')) {
          console.log(`Auto-cleaning failed HyperPod creation: ${clusterTag}, status: ${stackStatus}`);
          updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');

          broadcast({
            type: 'hyperpod_creation_failed',
            status: 'error',
            message: `HyperPod creation failed and cleaned up: ${stackStatus}`,
            clusterTag: clusterTag
          });

          return res.json({ success: true, status: null });
        }

        status.cfStatus = stackStatus;
      } catch (error) {
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

/**
 * 获取正在创建的 HyperPod 集群列表
 * GET /api/cluster/creating-hyperpod-clusters
 */
router.get('/creating-hyperpod-clusters', async (req, res) => {
  try {
    const creatingClusters = getCreatingHyperPodClusters();

    // 检查所有创建中集群的状态
    for (const [clusterTag, clusterInfo] of Object.entries(creatingClusters)) {
      if (clusterInfo.stackName && clusterInfo.region) {
        try {
          const checkCmd = `aws cloudformation describe-stacks --stack-name ${clusterInfo.stackName} --region ${clusterInfo.region} --query 'Stacks[0].StackStatus' --output text`;
          const stackStatus = execSync(checkCmd, { encoding: 'utf8', timeout: 10000 }).trim();

          if (stackStatus === 'CREATE_COMPLETE') {
            clusterInfo.cfStatus = 'CREATE_COMPLETE';
          } else if (stackStatus === 'DELETE_COMPLETE') {
            console.log(`HyperPod deletion completed: ${clusterTag}`);

            // 删除 metadata 文件
            const hyperPodConfigPath = path.join(MANAGED_CLUSTERS_DIR, clusterTag, 'metadata/hyperpod-config.json');
            if (fs.existsSync(hyperPodConfigPath)) {
              fs.unlinkSync(hyperPodConfigPath);
            }

            // 清理 cluster_info.json 中的 hyperPodCluster 字段
            const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
            const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
            if (fs.existsSync(clusterInfoPath)) {
              try {
                const clusterInfoData = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
                if (clusterInfoData.hyperPodCluster) {
                  delete clusterInfoData.hyperPodCluster;
                  clusterInfoData.lastModified = new Date().toISOString();
                  fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfoData, null, 2));
                  console.log(`Removed hyperPodCluster field from cluster_info.json for ${clusterTag}`);
                }
              } catch (error) {
                console.error(`Error cleaning hyperPodCluster metadata for ${clusterTag}:`, error);
              }
            }

            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');

            broadcast({
              type: 'hyperpod_deletion_completed',
              clusterTag,
              message: 'HyperPod cluster deleted successfully'
            });
          } else if (stackStatus.includes('FAILED') || stackStatus.includes('ROLLBACK')) {
            console.log(`Auto-cleaning failed HyperPod operation: ${clusterTag}, status: ${stackStatus}`);
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');

            if (clusterInfo.status === 'DELETING') {
              broadcast({
                type: 'hyperpod_deletion_failed',
                clusterTag,
                message: `HyperPod deletion failed: ${stackStatus}`
              });
            }
          } else {
            clusterInfo.cfStatus = stackStatus;
          }
        } catch (error) {
          if (error.message.includes('does not exist')) {
            console.log(`Stack does not exist, cleaning up: ${clusterTag}`);
            updateCreatingHyperPodStatus(clusterTag, 'COMPLETED');
          } else {
            console.error(`Error checking HyperPod status for ${clusterTag}:`, error.message);
          }
        }
      }
    }

    res.json({ success: true, data: getCreatingHyperPodClusters() });
  } catch (error) {
    console.error('Error getting creating HyperPod clusters:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取 HyperPod 依赖状态
 * GET /api/cluster/:clusterTag/hyperpod/dependencies/status
 */
router.get('/:clusterTag/hyperpod/dependencies/status', async (req, res) => {
  try {
    const { clusterTag } = req.params;
    const status = await HyperPodDependencyManager.getDependenciesStatus(clusterTag, clusterManager);
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error getting HyperPod dependencies status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 重启 HyperPod 节点
 * POST /api/cluster/hyperpod/node/reboot
 */
router.post('/hyperpod/node/reboot', async (req, res) => {
  try {
    const { nodeId } = req.body;

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'Node ID is required'
      });
    }

    console.log(`Rebooting HyperPod node: ${nodeId}`);

    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        message: 'No active cluster selected'
      });
    }

    const clusterInfo = await clusterManager.getClusterInfo(activeCluster);
    if (!clusterInfo || !clusterInfo.hyperPodCluster) {
      return res.status(400).json({
        success: false,
        message: 'No HyperPod cluster found'
      });
    }

    // 使用 kubectl 标签方式触发 reboot
    const cmd = `kubectl label nodes ${nodeId} sagemaker.amazonaws.com/node-health-status=UnschedulablePendingReboot --overwrite`;

    const result = execSync(cmd, { encoding: 'utf8' });
    console.log('Reboot label result:', result);

    broadcast({
      type: 'hyperpod_node_reboot',
      status: 'success',
      nodeId: nodeId,
      message: `Node ${nodeId} reboot initiated`
    });

    res.json({
      success: true,
      message: 'Node reboot initiated successfully',
      nodeId: nodeId
    });
  } catch (error) {
    console.error('HyperPod node reboot error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * 替换 HyperPod 节点
 * POST /api/cluster/hyperpod/node/replace
 */
router.post('/hyperpod/node/replace', async (req, res) => {
  try {
    const { nodeId } = req.body;

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        message: 'Node ID is required'
      });
    }

    console.log(`Replacing HyperPod node: ${nodeId}`);

    const activeCluster = clusterManager.getActiveCluster();
    if (!activeCluster) {
      return res.status(400).json({
        success: false,
        message: 'No active cluster selected'
      });
    }

    const clusterInfo = await clusterManager.getClusterInfo(activeCluster);
    if (!clusterInfo || !clusterInfo.hyperPodCluster) {
      return res.status(400).json({
        success: false,
        message: 'No HyperPod cluster found'
      });
    }

    // 使用 kubectl 标签方式触发 replace
    const cmd = `kubectl label nodes ${nodeId} sagemaker.amazonaws.com/node-health-status=UnschedulablePendingReplacement --overwrite`;

    const result = execSync(cmd, { encoding: 'utf8' });
    console.log('Replace label result:', result);

    broadcast({
      type: 'hyperpod_node_replace',
      status: 'success',
      nodeId: nodeId,
      message: `Node ${nodeId} replacement initiated`
    });

    res.json({
      success: true,
      message: 'Node replacement initiated successfully',
      nodeId: nodeId
    });
  } catch (error) {
    console.error('HyperPod node replace error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ============================================================
// 导出
// ============================================================

module.exports = {
  router,
  initialize,

  // 导出辅助函数供其他模块使用
  getCreatingHyperPodClusters,
  updateCreatingHyperPodStatus,
  registerCompletedHyperPod,

  // 导出扩展点函数
  shouldUseThreadsPerCore2
};
