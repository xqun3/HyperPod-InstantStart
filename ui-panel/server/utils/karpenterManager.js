/**
 * Karpenter管理工具
 * 处理Karpenter自动扩缩容系统的安装、配置和管理
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const CloudFormationManager = require('./cloudFormationManager');
const AWSHelpers = require('./awsHelpers');

class KarpenterManager {
  static KARPENTER_VERSION = '1.8.1';
  static KARPENTER_NAMESPACE = 'kube-system';

  /**
   * 安装Karpenter依赖
   * @param {string} clusterTag - 集群标识
   * @param {Object} clusterManager - 集群管理器实例
   * @returns {Promise<Object>} 安装结果
   */
  static async installKarpenterDependencies(clusterTag, clusterManager) {
    const logFile = path.join(__dirname, '../../tmp', `karpenter-install-${clusterTag}.log`);
    const clusterLogDir = path.join(__dirname, '../../managed_clusters_info', clusterTag, 'logs');
    const clusterLogFile = path.join(clusterLogDir, 'karpenter-install.log');

    try {
      // 确保日志目录存在
      await fs.ensureDir(path.dirname(logFile));
      await fs.ensureDir(clusterLogDir);

      // 初始化日志
      const startLog = `=== Karpenter Installation Started at ${new Date().toISOString()} ===\n`;
      await fs.writeFile(logFile, startLog);
      await fs.writeFile(clusterLogFile, startLog);

      this.log(logFile, `Installing Karpenter for cluster: ${clusterTag}`);

      // 步骤1: 获取集群基础设施信息
      this.log(logFile, 'Step 1: Getting cluster infrastructure information...');
      const stackInfo = await this.getClusterStackInfo(clusterTag, clusterManager);
      this.log(logFile, `Stack info retrieved: VPC=${stackInfo.VPC_ID}, SG=${stackInfo.SECURITY_GROUP_ID}`);

      // 步骤2: 创建VPC Endpoints
      this.log(logFile, 'Step 2: Creating VPC Endpoints...');
      await this.createVpcEndpoints(stackInfo, logFile);

      // 步骤3: 添加Karpenter标签
      this.log(logFile, 'Step 3: Adding Karpenter discovery tags...');
      await this.addKarpenterTags(stackInfo, logFile);

      // 步骤4: 创建IAM角色和策略
      this.log(logFile, 'Step 4: Creating IAM roles and policies...');
      await this.createKarpenterIAMResources(stackInfo, logFile);

      // 步骤5: 安装Karpenter Helm Chart
      this.log(logFile, 'Step 5: Installing Karpenter Helm Chart...');
      await this.installKarpenterHelm(stackInfo, logFile);

      // 步骤6: 安装监控组件
      this.log(logFile, 'Step 6: Installing monitoring components...');
      await this.installMonitoringComponents(stackInfo, logFile);

      // 步骤7: 更新cluster metadata
      this.log(logFile, 'Step 7: Updating cluster metadata...');
      const installationDetails = {
        installed: true,
        version: this.KARPENTER_VERSION,
        installationDate: new Date().toISOString(),
        components: {
          karpenterController: 'installed',
          prometheus: 'installed',
          keda: 'installed',
          vpcEndpoints: ['ec2', 'sqs']
        },
        nodeClasses: [],
        nodePools: [],
        source: 'ui-installed'
      };

      await this.updateClusterMetadata(clusterTag, clusterManager, installationDetails);

      // 复制日志到集群目录
      await fs.copyFile(logFile, clusterLogFile);

      this.log(logFile, 'Karpenter installation completed successfully!');

      return {
        success: true,
        message: 'Karpenter installation completed successfully',
        details: installationDetails,
        logFile: clusterLogFile
      };

    } catch (error) {
      const errorMsg = `Karpenter installation failed: ${error.message}`;
      this.log(logFile, `ERROR: ${errorMsg}`);

      // 复制错误日志到集群目录
      try {
        await fs.copyFile(logFile, clusterLogFile);
      } catch (copyError) {
        console.error('Failed to copy error log:', copyError);
      }

      throw new Error(errorMsg);
    }
  }

  /**
   * 获取集群基础设施信息（从metadata获取）
   * @param {string} clusterTag - 集群标识
   * @param {Object} clusterManager - 集群管理器实例
   * @returns {Promise<Object>} 基础设施信息
   */
  static async getClusterStackInfo(clusterTag, clusterManager) {
    try {
      // 获取集群metadata
      const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (!fs.existsSync(clusterInfoPath)) {
        throw new Error(`Cluster info not found: ${clusterInfoPath}`);
      }

      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

      // 直接从metadata中获取资源信息
      let stackInfo = {
        CLUSTER_TAG: clusterTag,
        REGION: AWSHelpers.getCurrentRegion(),
        AWS_ACCOUNT_ID: AWSHelpers.getCurrentAccountId()
      };

      // 从eksCluster字段获取基本信息
      if (clusterInfo.eksCluster) {
        stackInfo.EKS_CLUSTER_NAME = clusterInfo.eksCluster.name;
        stackInfo.VPC_ID = clusterInfo.eksCluster.vpcId;
        stackInfo.SECURITY_GROUP_ID = clusterInfo.eksCluster.securityGroupId;
      }

      // 从cloudFormation outputs获取资源信息（备用）
      if (clusterInfo.cloudFormation && clusterInfo.cloudFormation.outputs) {
        const outputs = clusterInfo.cloudFormation.outputs;
        stackInfo.VPC_ID = stackInfo.VPC_ID || outputs.OutputVpcId || outputs.VPC_ID;
        stackInfo.SECURITY_GROUP_ID = stackInfo.SECURITY_GROUP_ID || outputs.OutputSecurityGroupId || outputs.SECURITY_GROUP_ID;
        stackInfo.EKS_CLUSTER_NAME = stackInfo.EKS_CLUSTER_NAME || outputs.OutputEKSClusterName || outputs.EKS_CLUSTER_NAME;
        stackInfo.SAGEMAKER_ROLE_ARN = outputs.OutputSageMakerIAMRoleArn || outputs.SAGEMAKER_ROLE_ARN;
        stackInfo.S3_BUCKET_NAME = outputs.OutputS3BucketName || outputs.S3_BUCKET_NAME;
      }

      // 验证必需信息
      const requiredFields = ['VPC_ID', 'SECURITY_GROUP_ID', 'EKS_CLUSTER_NAME'];
      for (const field of requiredFields) {
        if (!stackInfo[field]) {
          throw new Error(`Missing required field: ${field} in cluster metadata`);
        }
      }

      return stackInfo;
    } catch (error) {
      console.error('Error getting cluster stack info from metadata:', error);
      throw error;
    }
  }

  /**
   * 创建VPC Endpoints
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async createVpcEndpoints(stackInfo, logFile) {
    try {
      // 获取计算子网ID (选择第一个私有子网)
      const subnetInfo = await CloudFormationManager.fetchSubnetInfo(stackInfo.VPC_ID, stackInfo.REGION);
      const computeSubnet = subnetInfo.privateSubnets[0]?.subnetId;

      if (!computeSubnet) {
        throw new Error('No private subnet found for VPC endpoints');
      }

      this.log(logFile, `Using compute subnet: ${computeSubnet}`);

      // 创建EC2 VPC Endpoint
      this.log(logFile, 'Creating EC2 VPC Endpoint...');
      try {
        const ec2EndpointCmd = `aws ec2 create-vpc-endpoint \\
          --vpc-id ${stackInfo.VPC_ID} \\
          --service-name com.amazonaws.${stackInfo.REGION}.ec2 \\
          --vpc-endpoint-type Interface \\
          --subnet-ids ${computeSubnet} \\
          --security-group-ids ${stackInfo.SECURITY_GROUP_ID} \\
          --policy-document '{
            "Version": "2012-10-17",
            "Statement": [
              {
                "Effect": "Allow",
                "Principal": "*",
                "Action": "*",
                "Resource": "*"
              }
            ]
          }'`;

        const ec2Result = execSync(ec2EndpointCmd, { encoding: 'utf8', timeout: 60000 });
        this.log(logFile, `EC2 VPC Endpoint created: ${JSON.parse(ec2Result).VpcEndpoint.VpcEndpointId}`);
      } catch (error) {
        // VPC Endpoint可能已存在，这不是致命错误
        this.log(logFile, `EC2 VPC Endpoint creation: ${error.message} (may already exist)`);
      }

      // 创建SQS VPC Endpoint
      this.log(logFile, 'Creating SQS VPC Endpoint...');
      try {
        const sqsEndpointCmd = `aws ec2 create-vpc-endpoint \\
          --vpc-id ${stackInfo.VPC_ID} \\
          --service-name com.amazonaws.${stackInfo.REGION}.sqs \\
          --vpc-endpoint-type Interface \\
          --subnet-ids ${computeSubnet} \\
          --security-group-ids ${stackInfo.SECURITY_GROUP_ID}`;

        const sqsResult = execSync(sqsEndpointCmd, { encoding: 'utf8', timeout: 60000 });
        this.log(logFile, `SQS VPC Endpoint created: ${JSON.parse(sqsResult).VpcEndpoint.VpcEndpointId}`);
      } catch (error) {
        // VPC Endpoint可能已存在，这不是致命错误
        this.log(logFile, `SQS VPC Endpoint creation: ${error.message} (may already exist)`);
      }

    } catch (error) {
      this.log(logFile, `Error creating VPC endpoints: ${error.message}`);
      throw error;
    }
  }

  /**
   * 添加Karpenter标签
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async addKarpenterTags(stackInfo, logFile) {
    try {
      // 为集群添加标签
      this.log(logFile, 'Adding Karpenter discovery tag to EKS cluster...');
      const clusterTagCmd = `aws eks tag-resource \\
        --resource-arn arn:aws:eks:${stackInfo.REGION}:${stackInfo.AWS_ACCOUNT_ID}:cluster/${stackInfo.EKS_CLUSTER_NAME} \\
        --tags karpenter.sh/discovery=${stackInfo.EKS_CLUSTER_NAME}`;

      execSync(clusterTagCmd, { encoding: 'utf8', timeout: 30000 });
      this.log(logFile, 'EKS cluster tagged successfully');

      // 为子网添加标签
      this.log(logFile, 'Adding Karpenter discovery tags to subnets...');
      const subnetInfo = await CloudFormationManager.fetchSubnetInfo(stackInfo.VPC_ID, stackInfo.REGION);

      // 标记所有私有子网
      for (const subnet of subnetInfo.privateSubnets) {
        try {
          const subnetTagCmd = `aws ec2 create-tags \\
            --resources ${subnet.subnetId} \\
            --tags Key=karpenter.sh/discovery,Value=${stackInfo.EKS_CLUSTER_NAME}`;

          execSync(subnetTagCmd, { encoding: 'utf8', timeout: 30000 });
          this.log(logFile, `Subnet ${subnet.subnetId} tagged successfully`);
        } catch (error) {
          this.log(logFile, `Warning: Failed to tag subnet ${subnet.subnetId}: ${error.message}`);
        }
      }

      // 为安全组添加标签
      this.log(logFile, 'Adding Karpenter discovery tag to security group...');
      const sgTagCmd = `aws ec2 create-tags \\
        --resources ${stackInfo.SECURITY_GROUP_ID} \\
        --tags Key=karpenter.sh/discovery,Value=${stackInfo.EKS_CLUSTER_NAME}`;

      execSync(sgTagCmd, { encoding: 'utf8', timeout: 30000 });
      this.log(logFile, 'Security group tagged successfully');

    } catch (error) {
      this.log(logFile, `Error adding Karpenter tags: ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建Karpenter IAM资源
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async createKarpenterIAMResources(stackInfo, logFile) {
    try {
      const kptRoleName = `${stackInfo.EKS_CLUSTER_NAME}-karpenter`;

      // 下载CloudFormation模板
      this.log(logFile, 'Downloading Karpenter CloudFormation template...');
      const templateUrl = `https://raw.githubusercontent.com/aws/karpenter-provider-aws/v${this.KARPENTER_VERSION}/website/content/en/preview/getting-started/getting-started-with-karpenter/cloudformation.yaml`;
      const templatePath = '/tmp/karpenter-cloudformation.yaml';

      const downloadCmd = `curl -fsSL ${templateUrl} > ${templatePath}`;
      execSync(downloadCmd, { encoding: 'utf8', timeout: 60000 });
      this.log(logFile, 'CloudFormation template downloaded');

      // 部署CloudFormation Stack
      this.log(logFile, 'Deploying Karpenter CloudFormation stack...');
      const stackName = `Karpenter-${stackInfo.EKS_CLUSTER_NAME}`;
      const cfDeployCmd = `aws cloudformation deploy \\
        --stack-name "${stackName}" \\
        --template-file "${templatePath}" \\
        --capabilities CAPABILITY_NAMED_IAM \\
        --parameter-overrides "ClusterName=${stackInfo.EKS_CLUSTER_NAME}"`;

      execSync(cfDeployCmd, { encoding: 'utf8', timeout: 300000 }); // 5分钟超时
      this.log(logFile, 'Karpenter CloudFormation stack deployed');

      // 创建Spot服务链接角色
      this.log(logFile, 'Creating Spot service linked role...');
      try {
        const spotRoleCmd = 'aws iam create-service-linked-role --aws-service-name spot.amazonaws.com';
        execSync(spotRoleCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, 'Spot service linked role created');
      } catch (error) {
        // 角色可能已存在
        this.log(logFile, `Spot service linked role: ${error.message} (may already exist)`);
      }

      // 创建Karpenter Controller角色
      this.log(logFile, 'Creating Karpenter Controller role...');
      const trustPolicyPath = '/tmp/karpenter-trust-policy.json';
      const trustPolicy = {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Principal": {
              "Service": "pods.eks.amazonaws.com"
            },
            "Action": [
              "sts:AssumeRole",
              "sts:TagSession"
            ]
          }
        ]
      };

      fs.writeFileSync(trustPolicyPath, JSON.stringify(trustPolicy, null, 2));

      // 创建角色
      try {
        const createRoleCmd = `aws iam create-role \\
          --role-name ${kptRoleName} \\
          --assume-role-policy-document file://${trustPolicyPath}`;

        execSync(createRoleCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, `Karpenter Controller role created: ${kptRoleName}`);
      } catch (error) {
        this.log(logFile, `Karpenter Controller role: ${error.message} (may already exist)`);
      }

      // 附加策略
      try {
        const attachPolicyCmd = `aws iam attach-role-policy \\
          --role-name ${kptRoleName} \\
          --policy-arn arn:aws:iam::${stackInfo.AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${stackInfo.EKS_CLUSTER_NAME}`;

        execSync(attachPolicyCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, 'Policy attached to Karpenter Controller role');
      } catch (error) {
        this.log(logFile, `Policy attachment: ${error.message}`);
      }

      // 创建Pod Identity Association
      this.log(logFile, 'Creating Pod Identity Association...');
      try {
        const podIdentityCmd = `aws eks create-pod-identity-association \\
          --cluster-name ${stackInfo.EKS_CLUSTER_NAME} \\
          --namespace ${this.KARPENTER_NAMESPACE} \\
          --service-account karpenter \\
          --role-arn arn:aws:iam::${stackInfo.AWS_ACCOUNT_ID}:role/${kptRoleName}`;

        execSync(podIdentityCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, 'Pod Identity Association created');
      } catch (error) {
        this.log(logFile, `Pod Identity Association: ${error.message} (may already exist)`);
      }

      // 创建Access Entry
      this.log(logFile, 'Creating Access Entry...');
      try {
        const accessEntryCmd = `aws eks create-access-entry \\
          --cluster-name ${stackInfo.EKS_CLUSTER_NAME} \\
          --principal-arn arn:aws:iam::${stackInfo.AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${stackInfo.EKS_CLUSTER_NAME} \\
          --type EC2_LINUX`;

        execSync(accessEntryCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, 'Access Entry created');
      } catch (error) {
        this.log(logFile, `Access Entry: ${error.message} (may already exist)`);
      }

    } catch (error) {
      this.log(logFile, `Error creating Karpenter IAM resources: ${error.message}`);
      throw error;
    }
  }

  /**
   * 安装Karpenter Helm Chart
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async installKarpenterHelm(stackInfo, logFile) {
    try {
      // 登出Helm registry
      this.log(logFile, 'Logging out of Helm registry...');
      try {
        execSync('helm registry logout public.ecr.aws', { encoding: 'utf8', timeout: 30000 });
      } catch (error) {
        // 忽略登出错误
        this.log(logFile, `Helm logout: ${error.message} (ignored)`);
      }

      // 安装Karpenter
      this.log(logFile, 'Installing Karpenter Helm chart...');
      const helmInstallCmd = `helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \\
        --version "${this.KARPENTER_VERSION}" \\
        --namespace "${this.KARPENTER_NAMESPACE}" \\
        --create-namespace \\
        --set "settings.clusterName=${stackInfo.EKS_CLUSTER_NAME}" \\
        --set "settings.interruptionQueue=${stackInfo.EKS_CLUSTER_NAME}" \\
        --set controller.resources.requests.cpu=1 \\
        --set controller.resources.requests.memory=1Gi \\
        --set controller.resources.limits.cpu=1 \\
        --set controller.resources.limits.memory=1Gi \\
        --set replicas=1 \\
        --set affinity.podAntiAffinity=null \\
        --set topologySpreadConstraints=null \\
        --wait`;

      execSync(helmInstallCmd, { encoding: 'utf8', timeout: 300000 }); // 5分钟超时
      this.log(logFile, 'Karpenter Helm chart installed successfully');

      // 验证安装
      this.log(logFile, 'Verifying Karpenter installation...');
      const verifyCmd = `kubectl get pods -n ${this.KARPENTER_NAMESPACE} -l app.kubernetes.io/name=karpenter`;
      const verifyResult = execSync(verifyCmd, { encoding: 'utf8', timeout: 30000 });
      this.log(logFile, `Karpenter pods status:\n${verifyResult}`);

    } catch (error) {
      this.log(logFile, `Error installing Karpenter Helm chart: ${error.message}`);
      throw error;
    }
  }

  /**
   * 安装监控组件
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async installMonitoringComponents(stackInfo, logFile) {
    try {
      // 安装Prometheus
      this.log(logFile, 'Installing Prometheus...');
      try {
        const prometheusCmd = `helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && \\
          helm repo update && \\
          helm install prometheus prometheus-community/prometheus \\
            --namespace monitoring \\
            --create-namespace \\
            --set server.persistentVolume.enabled=false \\
            --set alertmanager.enabled=false \\
            --set pushgateway.enabled=false`;

        execSync(prometheusCmd, { encoding: 'utf8', timeout: 300000 });
        this.log(logFile, 'Prometheus installed successfully');
      } catch (error) {
        this.log(logFile, `Prometheus installation: ${error.message} (may already exist)`);
      }

      // 安装KEDA
      this.log(logFile, 'Installing KEDA...');
      try {
        const kedaCmd = `helm repo add kedacore https://kedacore.github.io/charts && \\
          helm repo update && \\
          helm install keda kedacore/keda \\
            --namespace keda \\
            --create-namespace`;

        execSync(kedaCmd, { encoding: 'utf8', timeout: 300000 });
        this.log(logFile, 'KEDA installed successfully');

        // 等待KEDA就绪
        const kedaWaitCmd = 'kubectl wait --for=condition=ready pod --all -n keda --timeout=120s';
        execSync(kedaWaitCmd, { encoding: 'utf8', timeout: 150000 });
        this.log(logFile, 'KEDA pods are ready');
      } catch (error) {
        this.log(logFile, `KEDA installation: ${error.message} (may already exist)`);
      }

    } catch (error) {
      this.log(logFile, `Error installing monitoring components: ${error.message}`);
      // 监控组件安装失败不应阻止整个流程
      this.log(logFile, 'Continuing with installation despite monitoring component errors...');
    }
  }

  /**
   * 更新集群metadata
   * @param {string} clusterTag - 集群标识
   * @param {Object} clusterManager - 集群管理器实例
   * @param {Object} installationDetails - 安装详情
   */
  static async updateClusterMetadata(clusterTag, clusterManager, installationDetails) {
    try {
      const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (!fs.existsSync(clusterInfoPath)) {
        throw new Error(`Cluster info not found: ${clusterInfoPath}`);
      }

      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

      // 添加Karpenter信息
      clusterInfo.karpenter = installationDetails;
      clusterInfo.lastModified = new Date().toISOString();

      // 保存更新后的metadata
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));

    } catch (error) {
      console.error('Error updating cluster metadata:', error);
      throw error;
    }
  }

  /**
   * 检查Karpenter状态
   * @param {string} eksClusterName - EKS集群名称
   * @param {string} region - AWS区域
   * @returns {Promise<Object>} Karpenter状态
   */
  static async checkKarpenterStatus(eksClusterName, region) {
    try {
      // 检查Karpenter deployment是否存在
      const deploymentCmd = `kubectl get deployment karpenter -n ${this.KARPENTER_NAMESPACE} -o json`;
      const deploymentResult = execSync(deploymentCmd, { encoding: 'utf8', timeout: 30000 });
      const deployment = JSON.parse(deploymentResult);

      const status = {
        installed: true,
        version: deployment.metadata.labels?.['app.kubernetes.io/version'] || 'unknown',
        replicas: deployment.status.replicas || 0,
        readyReplicas: deployment.status.readyReplicas || 0,
        status: deployment.status.readyReplicas === deployment.status.replicas ? 'ready' : 'not ready'
      };

      return status;
    } catch (error) {
      // Karpenter未安装
      return {
        installed: false,
        error: error.message
      };
    }
  }

  /**
   * 获取Karpenter节点
   * @param {string} eksClusterName - EKS集群名称
   * @param {string} region - AWS区域
   * @returns {Promise<Array>} Karpenter节点列表
   */
  static async getKarpenterNodes(eksClusterName, region) {
    try {
      // 获取由Karpenter管理的节点
      const nodesCmd = 'kubectl get nodes -l karpenter.sh/node-name -o json';
      const nodesResult = execSync(nodesCmd, { encoding: 'utf8', timeout: 30000 });
      const nodes = JSON.parse(nodesResult);

      return nodes.items.map(node => ({
        name: node.metadata.name,
        instanceType: node.metadata.labels?.['node.kubernetes.io/instance-type'] || 'unknown',
        zone: node.metadata.labels?.['topology.kubernetes.io/zone'] || 'unknown',
        nodePool: node.metadata.labels?.['karpenter.sh/nodepool'] || 'unknown',
        status: node.status.conditions.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
        creationTimestamp: node.metadata.creationTimestamp
      }));
    } catch (error) {
      console.error('Error getting Karpenter nodes:', error);
      return [];
    }
  }

  /**
   * 卸载Karpenter
   * @param {string} clusterTag - 集群标识
   * @param {Object} clusterManager - 集群管理器实例
   * @returns {Promise<Object>} 卸载结果
   */
  static async uninstallKarpenter(clusterTag, clusterManager) {
    const logFile = path.join(__dirname, '../../tmp', `karpenter-uninstall-${clusterTag}.log`);
    const clusterLogDir = path.join(__dirname, '../../managed_clusters_info', clusterTag, 'logs');
    const clusterLogFile = path.join(clusterLogDir, 'karpenter-uninstall.log');

    try {
      // 确保日志目录存在
      await fs.ensureDir(path.dirname(logFile));
      await fs.ensureDir(clusterLogDir);

      // 初始化日志
      const startLog = `=== Karpenter Uninstallation Started at ${new Date().toISOString()} ===\n`;
      await fs.writeFile(logFile, startLog);
      await fs.writeFile(clusterLogFile, startLog);

      this.log(logFile, `Uninstalling Karpenter for cluster: ${clusterTag}`);

      // 获取集群信息
      const stackInfo = await this.getClusterStackInfo(clusterTag, clusterManager);

      // 步骤1: Pre-cleanup - 清理手动创建的IAM依赖关系
      this.log(logFile, 'Step 1: Cleaning up manual IAM dependencies...');
      await this.cleanupManualIAMBindings(stackInfo, logFile);

      // 步骤2: 卸载Helm chart
      this.log(logFile, 'Step 2: Uninstalling Karpenter Helm chart...');
      try {
        const helmUninstallCmd = `helm uninstall karpenter -n ${this.KARPENTER_NAMESPACE}`;
        execSync(helmUninstallCmd, { encoding: 'utf8', timeout: 120000 });
        this.log(logFile, 'Karpenter Helm chart uninstalled successfully');
      } catch (error) {
        this.log(logFile, `Helm uninstall error: ${error.message}`);
      }

      // 步骤3: 删除CloudFormation stack (现在应该成功)
      this.log(logFile, 'Step 3: Deleting Karpenter CloudFormation stack...');
      try {
        const stackName = `Karpenter-${stackInfo.EKS_CLUSTER_NAME}`;
        const deleteStackCmd = `aws cloudformation delete-stack --stack-name "${stackName}"`;
        execSync(deleteStackCmd, { encoding: 'utf8', timeout: 60000 });
        this.log(logFile, 'Karpenter CloudFormation stack deletion initiated');

        // 等待CloudFormation删除完成
        this.log(logFile, 'Waiting for CloudFormation stack deletion...');
        const waitCmd = `aws cloudformation wait stack-delete-complete --stack-name "${stackName}"`;
        execSync(waitCmd, { encoding: 'utf8', timeout: 300000 }); // 5分钟超时
        this.log(logFile, 'CloudFormation stack deleted successfully');
      } catch (error) {
        this.log(logFile, `CloudFormation stack deletion error: ${error.message}`);
      }

      // 步骤4: Post-cleanup - 清理残留资源
      this.log(logFile, 'Step 4: Cleaning up remaining resources...');
      await this.cleanupRemainingResources(stackInfo, logFile);

      // 步骤5: 更新metadata
      this.log(logFile, 'Step 5: Updating cluster metadata...');
      await this.removeKarpenterFromMetadata(clusterTag, clusterManager);

      // 复制日志到集群目录
      await fs.copyFile(logFile, clusterLogFile);

      this.log(logFile, 'Karpenter uninstallation completed successfully!');

      return {
        success: true,
        message: 'Karpenter uninstallation completed successfully',
        logFile: clusterLogFile
      };

    } catch (error) {
      const errorMsg = `Karpenter uninstallation failed: ${error.message}`;
      this.log(logFile, `ERROR: ${errorMsg}`);

      // 复制错误日志到集群目录
      try {
        await fs.copyFile(logFile, clusterLogFile);
      } catch (copyError) {
        console.error('Failed to copy error log:', copyError);
      }

      throw new Error(errorMsg);
    }
  }

  /**
   * 清理手动创建的IAM依赖关系
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async cleanupManualIAMBindings(stackInfo, logFile) {
    try {
      const kptRoleName = `${stackInfo.EKS_CLUSTER_NAME}-karpenter`;
      const policyArn = `arn:aws:iam::${stackInfo.AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${stackInfo.EKS_CLUSTER_NAME}`;

      // 1. 分离Policy从Controller Role
      this.log(logFile, 'Detaching KarpenterControllerPolicy from Controller role...');
      try {
        const detachCmd = `aws iam detach-role-policy --role-name ${kptRoleName} --policy-arn ${policyArn}`;
        execSync(detachCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, 'Successfully detached KarpenterControllerPolicy from Controller role');
      } catch (error) {
        this.log(logFile, `Policy detach error: ${error.message} (may not exist or already detached)`);
      }

      // 2. 删除Pod Identity Associations
      this.log(logFile, 'Deleting Pod Identity Associations...');
      try {
        // 先获取association ID
        const listAssociationsCmd = `aws eks list-pod-identity-associations --cluster-name ${stackInfo.EKS_CLUSTER_NAME} --query 'associations[?serviceAccount==\`karpenter\` && namespace==\`${this.KARPENTER_NAMESPACE}\`].associationId' --output text`;
        const associationIds = execSync(listAssociationsCmd, { encoding: 'utf8', timeout: 30000 }).trim();

        if (associationIds && associationIds !== 'None') {
          const ids = associationIds.split('\t').filter(id => id.trim());
          for (const associationId of ids) {
            if (associationId.trim()) {
              const deletePodIdentityCmd = `aws eks delete-pod-identity-association --cluster-name ${stackInfo.EKS_CLUSTER_NAME} --association-id ${associationId.trim()}`;
              execSync(deletePodIdentityCmd, { encoding: 'utf8', timeout: 30000 });
              this.log(logFile, `Deleted Pod Identity Association: ${associationId.trim()}`);
            }
          }
        } else {
          this.log(logFile, 'No Pod Identity Associations found for Karpenter');
        }
      } catch (error) {
        this.log(logFile, `Pod Identity Association deletion error: ${error.message} (may not exist)`);
      }

      // 3. 删除Access Entry
      this.log(logFile, 'Deleting Access Entry...');
      try {
        const nodeRoleArn = `arn:aws:iam::${stackInfo.AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${stackInfo.EKS_CLUSTER_NAME}`;
        const deleteAccessEntryCmd = `aws eks delete-access-entry --cluster-name ${stackInfo.EKS_CLUSTER_NAME} --principal-arn ${nodeRoleArn}`;
        execSync(deleteAccessEntryCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, 'Access Entry deleted successfully');
      } catch (error) {
        this.log(logFile, `Access Entry deletion error: ${error.message} (may not exist)`);
      }

      // 4. 删除手动创建的Controller Role
      this.log(logFile, 'Deleting Karpenter Controller role...');
      try {
        const deleteRoleCmd = `aws iam delete-role --role-name ${kptRoleName}`;
        execSync(deleteRoleCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, `Successfully deleted Karpenter Controller role: ${kptRoleName}`);
      } catch (error) {
        this.log(logFile, `Controller role deletion error: ${error.message} (may not exist)`);
      }

    } catch (error) {
      this.log(logFile, `Error in cleanupManualIAMBindings: ${error.message}`);
      // 不抛出错误，继续后续步骤
    }
  }

  /**
   * 清理残留资源
   * @param {Object} stackInfo - 基础设施信息
   * @param {string} logFile - 日志文件路径
   */
  static async cleanupRemainingResources(stackInfo, logFile) {
    try {
      // 清理可能残留的Spot服务链接角色（通常不需要删除，但记录状态）
      this.log(logFile, 'Checking Spot service linked role...');
      try {
        const getSpotRoleCmd = 'aws iam get-role --role-name AWSServiceRoleForEC2Spot';
        execSync(getSpotRoleCmd, { encoding: 'utf8', timeout: 15000 });
        this.log(logFile, 'Spot service linked role exists (preserved for other services)');
      } catch (error) {
        this.log(logFile, 'Spot service linked role not found (normal)');
      }

      // 检查并报告VPC Endpoints状态（保留，因为可能被其他服务使用）
      this.log(logFile, 'Checking VPC Endpoints status...');
      try {
        const listEndpointsCmd = `aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=${stackInfo.VPC_ID} --query 'VpcEndpoints[?ServiceName==\`com.amazonaws.${stackInfo.REGION}.ec2\` || ServiceName==\`com.amazonaws.${stackInfo.REGION}.sqs\`].[VpcEndpointId,ServiceName,State]' --output table`;
        const endpointsResult = execSync(listEndpointsCmd, { encoding: 'utf8', timeout: 30000 });
        this.log(logFile, `VPC Endpoints status (preserved for other services):\n${endpointsResult}`);
      } catch (error) {
        this.log(logFile, `VPC Endpoints check error: ${error.message}`);
      }

      // 检查Karpenter相关的Kubernetes资源清理状态
      this.log(logFile, 'Checking Kubernetes resources cleanup...');
      try {
        const checkNodesCmd = 'kubectl get nodes -l karpenter.sh/node-name --no-headers';
        const nodesResult = execSync(checkNodesCmd, { encoding: 'utf8', timeout: 30000 });
        if (nodesResult.trim()) {
          this.log(logFile, `Warning: Karpenter nodes still exist:\n${nodesResult}`);
        } else {
          this.log(logFile, 'All Karpenter nodes have been cleaned up');
        }
      } catch (error) {
        this.log(logFile, `Kubernetes resources check: ${error.message} (normal if no nodes exist)`);
      }

    } catch (error) {
      this.log(logFile, `Error in cleanupRemainingResources: ${error.message}`);
      // 不抛出错误，这是非关键清理步骤
    }
  }

  /**
   * 从metadata中移除Karpenter信息
   * @param {string} clusterTag - 集群标识
   * @param {Object} clusterManager - 集群管理器实例
   */
  static async removeKarpenterFromMetadata(clusterTag, clusterManager) {
    try {
      const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (fs.existsSync(clusterInfoPath)) {
        const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

        // 删除Karpenter字段
        if (clusterInfo.karpenter) {
          delete clusterInfo.karpenter;
          clusterInfo.lastModified = new Date().toISOString();

          // 保存更新后的metadata
          fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
        }
      }
    } catch (error) {
      console.error('Error removing Karpenter from metadata:', error);
      throw error;
    }
  }

  // ===== NodeClass 管理方法 =====

  /**
   * 创建 NodeClass
   * @param {string} clusterTag - 集群标识
   * @param {Object} config - NodeClass 配置
   * @param {Object} clusterManager - 集群管理器实例
   * @returns {Promise<Object>} 创建结果
   */
  static async createNodeClass(clusterTag, config, clusterManager) {
    try {
      // 获取集群基础设施信息
      const stackInfo = await this.getClusterStackInfo(clusterTag, clusterManager);

      // 生成 NodeClass YAML
      const nodeClassYaml = this.generateNodeClassYaml(config, stackInfo);

      // 应用到集群
      const result = await this.applyKubernetesYaml(nodeClassYaml, 'NodeClass');

      return {
        success: true,
        message: `NodeClass ${config.nodeClassName} created successfully`,
        data: result
      };
    } catch (error) {
      throw new Error(`Failed to create NodeClass: ${error.message}`);
    }
  }

  /**
   * 获取所有 NodeClass
   * @returns {Promise<Array>} NodeClass 列表
   */
  static async getNodeClasses() {
    try {
      const cmd = 'kubectl get nodeclass -o json';
      const result = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
      const nodeClasses = JSON.parse(result);

      return nodeClasses.items.map(nc => ({
        name: nc.metadata.name,
        role: nc.spec.role,
        amiAlias: nc.spec.amiSelectorTerms?.[0]?.alias,
        volumeSize: nc.spec.blockDeviceMappings?.[0]?.ebs?.volumeSize,
        volumeType: nc.spec.blockDeviceMappings?.[0]?.ebs?.volumeType,
        encrypted: nc.spec.blockDeviceMappings?.[0]?.ebs?.encrypted,
        creationTimestamp: nc.metadata.creationTimestamp,
        status: 'Active'
      }));
    } catch (error) {
      console.error('Error getting NodeClasses:', error);
      return [];
    }
  }

  /**
   * 删除 NodeClass
   * @param {string} name - NodeClass 名称
   * @returns {Promise<Object>} 删除结果
   */
  static async deleteNodeClass(name) {
    try {
      // 检查是否有 NodePool 依赖此 NodeClass
      const nodePools = await this.getNodePools();
      const dependentPools = nodePools.filter(np => np.nodeClassRef === name);

      if (dependentPools.length > 0) {
        throw new Error(`Cannot delete NodeClass ${name}. It is referenced by NodePools: ${dependentPools.map(np => np.name).join(', ')}`);
      }

      const cmd = `kubectl delete nodeclass ${name}`;
      execSync(cmd, { encoding: 'utf8', timeout: 30000 });

      return {
        success: true,
        message: `NodeClass ${name} deleted successfully`
      };
    } catch (error) {
      throw new Error(`Failed to delete NodeClass: ${error.message}`);
    }
  }

  // ===== 统一资源创建方法 =====

  /**
   * 统一创建 NodeClass 和 NodePool（类似命令行 YAML 部署）
   * @param {string} clusterTag - 集群标识
   * @param {Object} config - 统一配置
   * @param {Object} clusterManager - 集群管理器
   * @returns {Promise<Object>} 创建结果
   */
  static async createUnifiedKarpenterResources(clusterTag, config, clusterManager) {
    try {
      // 获取集群基础设施信息
      const stackInfo = await this.getClusterStackInfo(clusterTag, clusterManager);

      // 确保 PriorityClass 存在
      await this.ensurePriorityClasses();

      // 生成统一的 YAML 内容（NodeClass + NodePool，类似命令行部署）
      const nodeClassYaml = this.generateNodeClassYaml(config, stackInfo);
      const nodePoolYaml = this.generateNodePoolYaml(config, stackInfo);

      // 组合成单个 YAML 文件，用 --- 分隔（就像命令行部署一样）
      const unifiedYaml = `${nodeClassYaml}\n---\n${nodePoolYaml}`;

      // 一次性应用所有资源
      const result = await this.applyKubernetesYaml(unifiedYaml, 'UnifiedKarpenterResources');

      return {
        success: true,
        message: `Unified Karpenter resources (${config.nodeClassName} + ${config.nodePoolName}) created successfully`,
        data: result
      };
    } catch (error) {
      throw new Error(`Failed to create unified Karpenter resources: ${error.message}`);
    }
  }

  // ===== NodePool 管理方法 =====

  /**
   * 创建 NodePool
   * @param {string} clusterTag - 集群标识
   * @param {Object} config - NodePool 配置
   * @param {Object} clusterManager - 集群管理器实例
   * @returns {Promise<Object>} 创建结果
   */
  static async createNodePool(clusterTag, config, clusterManager) {
    try {
      // 验证 NodeClass 存在
      const nodeClassExists = await this.checkNodeClassExists(config.nodeClassRef);
      if (!nodeClassExists) {
        throw new Error(`NodeClass ${config.nodeClassRef} does not exist`);
      }

      // 获取集群基础设施信息
      const stackInfo = await this.getClusterStackInfo(clusterTag, clusterManager);

      // 确保 PriorityClass 存在
      await this.ensurePriorityClasses();

      // 生成 NodePool YAML
      const nodePoolYaml = this.generateNodePoolYaml(config, stackInfo);

      // 应用到集群
      const result = await this.applyKubernetesYaml(nodePoolYaml, 'NodePool');

      return {
        success: true,
        message: `NodePool ${config.nodePoolName} created successfully`,
        data: result
      };
    } catch (error) {
      throw new Error(`Failed to create NodePool: ${error.message}`);
    }
  }

  /**
   * 获取所有 NodePool
   * @returns {Promise<Array>} NodePool 列表
   */
  static async getNodePools() {
    try {
      const cmd = 'kubectl get nodepool -o json';
      const result = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
      const nodePools = JSON.parse(result);


      return nodePools.items.map(np => ({
        name: np.metadata.name,
        nodeClassRef: np.spec.template.spec.nodeClassRef?.name || np.spec.template.spec.nodeClassRef,
        capacityTypes: np.spec.template.spec.requirements?.find(r => r.key === 'karpenter.sh/capacity-type')?.values || [],
        gpuLimit: np.spec.limits?.['nvidia.com/gpu'],
        weight: np.spec.weight,
        // 从 node.kubernetes.io/instance-type 中解析实例家族和大小
        instanceTypes: np.spec.template.spec.requirements?.find(r => r.key === 'node.kubernetes.io/instance-type')?.values || [],
        instanceFamilies: (() => {
          const instanceTypes = np.spec.template.spec.requirements?.find(r => r.key === 'node.kubernetes.io/instance-type')?.values || [];
          const families = [...new Set(instanceTypes.map(type => type.split('.')[0]))];
          return families.length > 0 ? families : [];
        })(),
        instanceSizes: (() => {
          const instanceTypes = np.spec.template.spec.requirements?.find(r => r.key === 'node.kubernetes.io/instance-type')?.values || [];
          const sizes = [...new Set(instanceTypes.map(type => type.split('.')[1]).filter(Boolean))];
          return sizes.length > 0 ? sizes : [];
        })(),
        creationTimestamp: np.metadata.creationTimestamp,
        status: 'Active'
      }));
    } catch (error) {
      console.error('Error getting NodePools:', error);
      return [];
    }
  }

  /**
   * 删除 NodePool 及其关联的 NodeClass
   * @param {string} name - NodePool 名称
   * @returns {Promise<Object>} 删除结果
   */
  static async deleteNodePool(name) {
    try {
      // 首先获取 NodePool 信息，找到关联的 NodeClass
      let nodeClassRef = null;
      try {
        const getCmd = `kubectl get nodepool ${name} -o jsonpath='{.spec.template.spec.nodeClassRef.name}'`;
        nodeClassRef = execSync(getCmd, { encoding: 'utf8', timeout: 15000 }).trim();
      } catch (error) {
        console.warn(`Could not get NodeClass reference for NodePool ${name}:`, error.message);
      }

      // 删除 NodePool
      const deleteNodePoolCmd = `kubectl delete nodepool ${name}`;
      execSync(deleteNodePoolCmd, { encoding: 'utf8', timeout: 30000 });

      // 如果有关联的 NodeClass，也删除它
      if (nodeClassRef) {
        try {
          const deleteNodeClassCmd = `kubectl delete nodeclass ${nodeClassRef}`;
          execSync(deleteNodeClassCmd, { encoding: 'utf8', timeout: 30000 });
          console.log(`Successfully deleted associated NodeClass: ${nodeClassRef}`);
        } catch (error) {
          console.warn(`NodeClass ${nodeClassRef} may have already been deleted or not found:`, error.message);
        }
      }

      return {
        success: true,
        message: nodeClassRef
          ? `NodePool ${name} and associated NodeClass ${nodeClassRef} deleted successfully`
          : `NodePool ${name} deleted successfully`
      };
    } catch (error) {
      throw new Error(`Failed to delete NodePool: ${error.message}`);
    }
  }

  // ===== YAML 模板生成方法 =====

  /**
   * 生成 NodeClass YAML
   * @param {Object} config - NodeClass 配置
   * @param {Object} stackInfo - 集群基础设施信息
   * @returns {string} NodeClass YAML 内容
   */
  static generateNodeClassYaml(config, stackInfo) {
    return `---
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: ${config.nodeClassName}
spec:
  role: "KarpenterNodeRole-${stackInfo.EKS_CLUSTER_NAME}"
  amiSelectorTerms:
    - alias: "${config.amiAlias || 'al2023@latest'}"
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "${stackInfo.EKS_CLUSTER_NAME}"
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "${stackInfo.EKS_CLUSTER_NAME}"
    - id: ${stackInfo.SECURITY_GROUP_ID}
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: ${config.volumeSize || 200}Gi
        volumeType: ${config.volumeType || 'gp3'}
        deleteOnTermination: true
        encrypted: ${config.encrypted !== false}
`;
  }

  /**
   * 生成 NodePool YAML
   * @param {Object} config - NodePool 配置
   * @param {Object} stackInfo - 集群基础设施信息
   * @returns {string} NodePool YAML 内容
   */
  static generateNodePoolYaml(config, stackInfo) {
    // 构建实例需求
    const requirements = [
      {
        key: 'kubernetes.io/arch',
        operator: 'In',
        values: ['amd64']
      }
    ];

    // 添加 capacity-type requirement
    if (config.capacityTypes && config.capacityTypes.length > 0) {
      requirements.push({
        key: 'karpenter.sh/capacity-type',
        operator: 'In',
        values: config.capacityTypes
      });
    } else {
      // 默认使用 spot
      requirements.push({
        key: 'karpenter.sh/capacity-type',
        operator: 'In',
        values: ['spot']
      });
    }

    // 如果提供了具体的实例类型列表，使用精确的 node.kubernetes.io/instance-type
    if (config.instanceTypes && config.instanceTypes.length > 0) {
      requirements.push({
        key: 'node.kubernetes.io/instance-type',
        operator: 'In',
        values: config.instanceTypes
      });
    }

    // 构建 Taints
    const taints = config.taints || [
      {
        key: 'nvidia.com/gpu',
        value: 'true',
        effect: 'NoSchedule'
      }
    ];

    const requirementsYaml = requirements.map(req => `        - key: ${req.key}
          operator: ${req.operator}
          values: [${req.values.map(v => `"${v}"`).join(', ')}]`).join('\n');

    const taintsYaml = taints.map(taint => `        - key: ${taint.key}
          value: "${taint.value}"
          effect: ${taint.effect}`).join('\n');

    // NodePool级别的权重
    const nodePoolWeight = config.nodePoolWeight || 100;

    return `---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: ${config.nodePoolName}
spec:
  template:
    metadata:
      labels:
        node-type: gpu
    spec:
      requirements:
${requirementsYaml}
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: ${config.nodeClassRef}
      taints:
${taintsYaml}
  weight: ${nodePoolWeight}
  limits:
    nvidia.com/gpu: ${config.gpuLimit || 50}
  disruption:
    consolidationPolicy: ${config.consolidationPolicy || 'WhenEmpty'}
    consolidateAfter: ${config.consolidateAfter || '30s'}
`;
  }

  /**
   * 生成 PriorityClass YAML
   * @returns {string} PriorityClass YAML 内容
   */
  static generatePriorityClassYaml() {
    return `---
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
  }

  // ===== 辅助方法 =====

  /**
   * 检查 NodeClass 是否存在
   * @param {string} name - NodeClass 名称
   * @returns {Promise<boolean>} 是否存在
   */
  static async checkNodeClassExists(name) {
    // 重试机制处理 Kubernetes 资源传播延迟
    const maxRetries = 5;
    const retryDelay = 1000; // 1秒

    for (let i = 0; i < maxRetries; i++) {
      try {
        const cmd = `kubectl get nodeclass ${name}`;
        execSync(cmd, { encoding: 'utf8', timeout: 10000 });
        console.log(`NodeClass ${name} found on attempt ${i + 1}`);
        return true;
      } catch (error) {
        if (i < maxRetries - 1) {
          console.log(`NodeClass ${name} not found on attempt ${i + 1}, retrying in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    console.error(`NodeClass ${name} not found after ${maxRetries} attempts`);
    return false;
  }

  /**
   * 确保 PriorityClass 存在
   */
  static async ensurePriorityClasses() {
    try {
      // 检查是否已存在
      const checkCmd = 'kubectl get priorityclass high-priority-ondemand medium-priority-spot';
      execSync(checkCmd, { encoding: 'utf8', timeout: 30000 });
    } catch (error) {
      // 不存在，需要创建
      const priorityClassYaml = this.generatePriorityClassYaml();
      await this.applyKubernetesYaml(priorityClassYaml, 'PriorityClass');
    }
  }

  /**
   * 应用 Kubernetes YAML
   * @param {string} yamlContent - YAML 内容
   * @param {string} resourceType - 资源类型 (用于日志)
   * @returns {Promise<Object>} 应用结果
   */
  static async applyKubernetesYaml(yamlContent, resourceType = 'Resource') {
    try {
      const tempFile = `/tmp/karpenter-${resourceType.toLowerCase()}-${Date.now()}.yaml`;

      // 写入临时文件
      fs.writeFileSync(tempFile, yamlContent);

      // 应用到集群
      const cmd = `kubectl apply -f ${tempFile}`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 60000 });

      // 清理临时文件
      fs.unlinkSync(tempFile);

      return {
        success: true,
        output: result,
        message: `${resourceType} applied successfully`
      };
    } catch (error) {
      throw new Error(`Failed to apply ${resourceType}: ${error.message}`);
    }
  }

  /**
   * 获取 Karpenter 资源状态
   * @param {string} clusterTag - 集群标识
   * @returns {Promise<Object>} 资源状态
   */
  static async getKarpenterResources(clusterTag) {
    try {
      const [nodeClasses, nodePools, nodes] = await Promise.all([
        this.getNodeClasses(),
        this.getNodePools(),
        this.getKarpenterNodes()
      ]);

      return {
        nodeClasses,
        nodePools,
        nodes,
        summary: {
          nodeClassCount: nodeClasses.length,
          nodePoolCount: nodePools.length,
          nodeCount: nodes.length
        }
      };
    } catch (error) {
      console.error('Error getting Karpenter resources:', error);
      return {
        nodeClasses: [],
        nodePools: [],
        nodes: [],
        summary: {
          nodeClassCount: 0,
          nodePoolCount: 0,
          nodeCount: 0
        }
      };
    }
  }

  /**
   * 获取Karpenter节点 (修正方法名)
   * @returns {Promise<Array>} Karpenter节点列表
   */
  static async getKarpenterNodes() {
    try {
      // 获取由Karpenter管理的节点
      const nodesCmd = 'kubectl get nodes -l karpenter.sh/node-name -o json';
      const nodesResult = execSync(nodesCmd, { encoding: 'utf8', timeout: 30000 });
      const nodes = JSON.parse(nodesResult);

      return nodes.items.map(node => ({
        name: node.metadata.name,
        instanceType: node.metadata.labels?.['node.kubernetes.io/instance-type'] || 'unknown',
        zone: node.metadata.labels?.['topology.kubernetes.io/zone'] || 'unknown',
        nodePool: node.metadata.labels?.['karpenter.sh/nodepool'] || 'unknown',
        status: node.status.conditions.find(c => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady',
        creationTimestamp: node.metadata.creationTimestamp
      }));
    } catch (error) {
      console.error('Error getting Karpenter nodes:', error);
      return [];
    }
  }

  /**
   * 记录日志
   * @param {string} logFile - 日志文件路径
   * @param {string} message - 日志消息
   */
  static log(logFile, message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    console.log(logEntry.trim());

    try {
      fs.appendFileSync(logFile, logEntry);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }
}

module.exports = KarpenterManager;