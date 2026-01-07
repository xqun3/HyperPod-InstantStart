/**
 * NodeGroup API Manager
 *
 * EKS 节点组管理 API 模块，从 index.js 提取
 *
 * 包含的 API:
 * - GET /nodegroups - 获取节点组列表（EKS + HyperPod）
 * - PUT /nodegroups/:name/scale - 缩放 EKS 节点组
 * - DELETE /nodegroup/:nodeGroupName - 删除 EKS 节点组
 * - POST /create-nodegroup - 创建 EKS 节点组
 * - GET /:clusterTag/nodegroup/:nodeGroupName/dependencies/status - 检查依赖状态
 *
 * 扩展点（供 Neuron 项目覆盖）:
 * - getNodeGroups(): 可被覆盖以支持不同的实例类型检测逻辑
 */

const express = require('express');
const router = express.Router();
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');

// 模块依赖 - 将在 initialize 中注入
let broadcast = null;
let clusterManager = null;
let CloudFormationManager = null;

/**
 * 初始化模块
 * @param {Function} broadcastFn - WebSocket 广播函数
 * @param {Object} clusterMgr - ClusterManager 实例
 */
function initialize(broadcastFn, clusterMgr) {
  broadcast = broadcastFn;
  clusterManager = clusterMgr;
  CloudFormationManager = require('./utils/cloudFormationManager');
  console.log('NodeGroup API Manager initialized');
}

// ==================== 节点组列表 API ====================

/**
 * GET /nodegroups
 * 获取当前集群的所有节点组（EKS + HyperPod）
 */
router.get('/nodegroups', async (req, res) => {
  try {
    const ClusterManager = require('./cluster-manager');
    const localClusterManager = new ClusterManager();
    const activeClusterName = localClusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件
    const configDir = localClusterManager.getClusterConfigDir(activeClusterName);
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
      const metadataDir = localClusterManager.getClusterMetadataDir(activeClusterName);
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
      hyperPodInstanceGroups: hyperPodGroups
    });
  } catch (error) {
    console.error('Error fetching node groups:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 缩放 EKS 节点组 API ====================

/**
 * PUT /nodegroups/:name/scale
 * 缩放 EKS 节点组
 */
router.put('/nodegroups/:name/scale', async (req, res) => {
  try {
    const { name } = req.params;
    const { minSize, maxSize, desiredSize } = req.body;

    const ClusterManager = require('./cluster-manager');
    const localClusterManager = new ClusterManager();
    const activeClusterName = localClusterManager.getActiveCluster();

    if (!activeClusterName) {
      return res.status(400).json({ error: 'No active cluster found' });
    }

    // 读取集群配置文件
    const configDir = localClusterManager.getClusterConfigDir(activeClusterName);
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
    if (broadcast) {
      broadcast({
        type: 'nodegroup_updated',
        status: 'success',
        message: `EKS node group ${name} scaling updated successfully`
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating EKS node group:', error);
    if (broadcast) {
      broadcast({
        type: 'nodegroup_updated',
        status: 'error',
        message: `Failed to update EKS node group: ${error.message}`
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==================== 删除 EKS 节点组 API ====================

/**
 * DELETE /nodegroup/:nodeGroupName
 * 删除 EKS 节点组
 */
router.delete('/nodegroup/:nodeGroupName', async (req, res) => {
  try {
    const { nodeGroupName } = req.params;

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

// ==================== 创建 EKS 节点组 API ====================

/**
 * POST /create-nodegroup
 * 创建 EKS 节点组
 */
router.post('/create-nodegroup', async (req, res) => {
  try {
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

    // 创建节点组配置 - 根据是否有 capacityReservationId 选择不同方法
    let createResult;
    if (userConfig.capacityReservationId && userConfig.capacityReservationId.trim()) {
      createResult = await CloudFormationManager.createEksNodeGroupWithCapacityBlock(
        userConfig,
        region,
        eksClusterName,
        vpcId,
        securityGroupId,
        subnetInfo
      );
    } else {
      createResult = await CloudFormationManager.createEksNodeGroup(
        userConfig,
        region,
        eksClusterName,
        vpcId,
        securityGroupId,
        subnetInfo
      );
    }

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
        if (broadcast) {
          broadcast({
            type: 'nodegroup_creation_completed',
            status: 'success',
            message: `EKS node group ${userConfig.nodeGroupName} created successfully`
          });
        }

        // 自动配置节点组依赖
        try {
          console.log(`Starting dependency configuration for node group: ${userConfig.nodeGroupName}`);

          if (broadcast) {
            broadcast({
              type: 'nodegroup_dependencies_started',
              status: 'info',
              message: `Configuring dependencies for node group: ${userConfig.nodeGroupName}`
            });
          }

          await EksNodeGroupDependencyManager.configureNodeGroupDependencies(
            activeCluster,
            userConfig.nodeGroupName,
            clusterManager
          );

          if (broadcast) {
            broadcast({
              type: 'nodegroup_dependencies_completed',
              status: 'success',
              message: `Node group dependencies configured successfully: ${userConfig.nodeGroupName}`
            });
          }

        } catch (error) {
          console.error('Error configuring node group dependencies:', error);
          if (broadcast) {
            broadcast({
              type: 'nodegroup_dependencies_failed',
              status: 'error',
              message: `Node group dependencies failed: ${error.message}`
            });
          }
        }
      } else {
        if (broadcast) {
          broadcast({
            type: 'nodegroup_creation_failed',
            status: 'error',
            message: `EKS node group creation failed: ${errorOutput}`
          });
        }
      }
    });

    // 立即返回成功响应
    if (broadcast) {
      broadcast({
        type: 'nodegroup_creation_started',
        status: 'info',
        message: `EKS node group creation started: ${userConfig.nodeGroupName}`
      });
    }

    res.json({
      success: true,
      message: 'EKS node group creation started',
      nodeGroupName: userConfig.nodeGroupName
    });

  } catch (error) {
    console.error('Error creating EKS node group:', error);

    if (broadcast) {
      broadcast({
        type: 'nodegroup_creation_failed',
        status: 'error',
        message: `EKS node group creation failed: ${error.message}`
      });
    }

    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 检查节点组依赖状态 API ====================

/**
 * GET /:clusterTag/nodegroup/:nodeGroupName/dependencies/status
 * 检查 EKS 节点组依赖配置状态
 */
router.get('/:clusterTag/nodegroup/:nodeGroupName/dependencies/status', async (req, res) => {
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

// ==================== 模块导出 ====================

module.exports = {
  router,
  initialize
};
