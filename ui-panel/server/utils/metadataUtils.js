const fs = require('fs');
const path = require('path');

/**
 * Metadata工具类 - 统一处理集群元数据的读取和转换
 */
class MetadataUtils {
  /**
   * 获取集群的metadata目录路径
   */
  static getMetadataDir(clusterTag) {
    return path.join(__dirname, '../../managed_clusters_info', clusterTag, 'metadata');
  }

  /**
   * 读取cluster_info.json
   */
  static getClusterInfo(clusterTag) {
    try {
      const clusterInfoPath = path.join(this.getMetadataDir(clusterTag), 'cluster_info.json');
      if (fs.existsSync(clusterInfoPath)) {
        return JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading cluster_info.json for ${clusterTag}:`, error);
      return null;
    }
  }

  /**
   * 读取creation_metadata.json
   */
  static getCreationMetadata(clusterTag) {
    try {
      const metadataPath = path.join(this.getMetadataDir(clusterTag), 'creation_metadata.json');
      if (fs.existsSync(metadataPath)) {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading creation_metadata.json for ${clusterTag}:`, error);
      return null;
    }
  }

  /**
   * 从metadata获取CloudFormation输出
   */
  static getCloudFormationOutputs(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    if (clusterInfo && clusterInfo.cloudFormation && clusterInfo.cloudFormation.outputs) {
      return clusterInfo.cloudFormation.outputs;
    }

    const creationMetadata = this.getCreationMetadata(clusterTag);
    if (creationMetadata && creationMetadata.cloudFormation && creationMetadata.cloudFormation.outputs) {
      return creationMetadata.cloudFormation.outputs;
    }

    return {};
  }

  /**
   * 从metadata生成stack_envs内容
   */
  static generateStackEnvsFromMetadata(clusterTag) {
    const outputs = this.getCloudFormationOutputs(clusterTag);
    
    let content = '#!/bin/bash\n\n';
    content += '# Stack environment variables - Generated from metadata\n';
    
    // 从EKS集群ARN或SageMaker角色ARN中提取账户ID
    let accountId = null;
    if (outputs.OutputEKSClusterArn) {
      const arnParts = outputs.OutputEKSClusterArn.split(':');
      if (arnParts.length >= 5) {
        accountId = arnParts[4];
      }
    } else if (outputs.OutputSageMakerIAMRoleArn) {
      const arnParts = outputs.OutputSageMakerIAMRoleArn.split(':');
      if (arnParts.length >= 5) {
        accountId = arnParts[4];
      }
    }
    
    // 添加账户ID环境变量
    if (accountId) {
      content += `export ACCOUNT_ID="${accountId}"\n`;
    }
    
    // 映射CloudFormation输出到环境变量
    const outputMapping = {
      'OutputVpcId': 'VPC_ID',
      'OutputPrivateSubnetIds': 'PRIVATE_SUBNET_ID',
      'OutputSecurityGroupId': 'SECURITY_GROUP_ID',
      'OutputHyperPodClusterName': 'HP_CLUSTER_NAME',
      'OutputHyperPodClusterArn': 'HP_CLUSTER_ARN',
      'OutputEKSClusterName': 'EKS_CLUSTER_NAME_FROM_CF',
      'OutputEKSClusterArn': 'EKS_CLUSTER_ARN',
      'OutputS3BucketName': 'S3_BUCKET_NAME',
      'OutputSageMakerIAMRoleArn': 'SAGEMAKER_ROLE_ARN'
    };

    Object.entries(outputMapping).forEach(([outputKey, envVar]) => {
      if (outputs[outputKey]) {
        content += `export ${envVar}="${outputs[outputKey]}"\n`;
      }
    });

    content += `\n# Generated from metadata on ${new Date().toISOString()}\n`;
    
    return content;
  }

  /**
   * 获取EKS集群基本信息
   */
  static getEKSClusterInfo(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    if (clusterInfo?.eksCluster) {
      return clusterInfo.eksCluster;
    }

    // 从CloudFormation输出中提取
    const outputs = this.getCloudFormationOutputs(clusterTag);
    return {
      name: outputs.OutputEKSClusterName || `eks-cluster-${clusterTag}`,
      arn: outputs.OutputEKSClusterArn || null,
      vpcId: outputs.OutputVpcId || null,
      securityGroupId: outputs.OutputSecurityGroupId || null,
      privateSubnetIds: outputs.OutputPrivateSubnetIds || null,
      s3BucketName: outputs.OutputS3BucketName || null,
      sageMakerRoleArn: outputs.OutputSageMakerIAMRoleArn || null
    };
  }

  /**
   * 获取集群类型（created/imported）
   */
  static getClusterType(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    return clusterInfo?.type || 'unknown';
  }

  /**
   * 检查集群是否为创建的集群（非导入）
   */
  static isCreatedCluster(clusterTag) {
    return this.getClusterType(clusterTag) === 'created';
  }

  /**
   * 获取集群的AWS区域
   */
  static getClusterRegion(clusterTag) {
    const clusterInfo = this.getClusterInfo(clusterTag);
    return clusterInfo?.region || null;
  }

  /**
   * 获取实例类型缓存文件路径
   */
  static getInstanceTypesCachePath(clusterTag) {
    return path.join(this.getMetadataDir(clusterTag), 'instance_types_cache.json');
  }

  /**
   * 读取实例类型缓存
   */
  static getInstanceTypesCache(clusterTag) {
    try {
      const cachePath = this.getInstanceTypesCachePath(clusterTag);
      if (fs.existsSync(cachePath)) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error(`Error reading instance types cache for ${clusterTag}:`, error);
      return null;
    }
  }

  /**
   * 保存实例类型缓存
   */
  static saveInstanceTypesCache(clusterTag, cacheData) {
    try {
      const cachePath = this.getInstanceTypesCachePath(clusterTag);

      // 确保metadata目录存在
      const metadataDir = this.getMetadataDir(clusterTag);
      if (!fs.existsSync(metadataDir)) {
        fs.mkdirSync(metadataDir, { recursive: true });
      }

      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      console.log(`Instance types cache saved for cluster: ${clusterTag}`);
      return true;
    } catch (error) {
      console.error(`Error saving instance types cache for ${clusterTag}:`, error);
      return false;
    }
  }
  /**
   * 通过AWS CLI获取导入集群的资源信息（包含HyperPod子网）
   */
  static async fetchImportedClusterResources(eksClusterName, awsRegion, hyperPodClusters = null) {
    const { execSync } = require('child_process');
    
    try {
      console.log(`Fetching resources for imported cluster: ${eksClusterName}`);
      
      // 获取EKS集群基本信息
      const clusterCmd = `aws eks describe-cluster --name ${eksClusterName} --region ${awsRegion} --output json`;
      const clusterResult = JSON.parse(execSync(clusterCmd, { encoding: 'utf8' }));
      const cluster = clusterResult.cluster;
      
      // 获取账户ID和当前角色
      const accountId = execSync('aws sts get-caller-identity --query Account --output text', { encoding: 'utf8' }).trim();
      const roleArn = execSync('aws sts get-caller-identity --query Arn --output text', { encoding: 'utf8' }).trim();
      const roleName = roleArn.split('/').pop();
      
      // 获取HyperPod计算节点信息（容错处理）
      let hyperPodClusterData = null;
      if (hyperPodClusters) {
        try {
          const hyperPodNames = hyperPodClusters.split(',').map(name => name.trim());
          // 只取第一个HyperPod集群（一个EKS只能有一个HyperPod）
          const hpClusterName = hyperPodNames[0];
          
          const hpCmd = `aws sagemaker describe-cluster --cluster-name ${hpClusterName} --region ${awsRegion} --output json`;
          const hpResult = execSync(hpCmd, { encoding: 'utf8' });
          hyperPodClusterData = JSON.parse(hpResult);
          
          // 添加来源标识
          hyperPodClusterData.source = 'imported';
          
          console.log(`Found imported HyperPod cluster: ${hpClusterName}`);
        } catch (error) {
          console.warn('Error fetching HyperPod cluster info (continuing import):', error.message);
        }
      }
      
      // 构建与创建集群格式对齐的资源信息
      const resources = {
        OutputVpcId: cluster.resourcesVpcConfig.vpcId,
        OutputEKSClusterName: cluster.name,
        OutputEKSClusterArn: cluster.arn,
        OutputSecurityGroupId: cluster.resourcesVpcConfig.clusterSecurityGroupId,
        OutputSageMakerIAMRoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
        // EKS集群关联的子网（对应CloudFormation的OutputPrivateSubnetIds）
        OutputPrivateSubnetIds: cluster.resourcesVpcConfig.subnetIds ? cluster.resourcesVpcConfig.subnetIds.join(',') : null
      };
      
      // 返回EKS资源信息和HyperPod集群数据
      const result = {
        cloudFormationOutputs: resources,
        hyperPodCluster: hyperPodClusterData // 完整的HyperPod集群数据或null
      };
      
      // 尝试获取专用S3存储桶（可能不存在）
      try {
        const bucketName = `cluster-mount-${eksClusterName}`;
        execSync(`aws s3api head-bucket --bucket ${bucketName} --region ${awsRegion}`, { encoding: 'utf8' });
        resources.OutputS3BucketName = bucketName;
      } catch (error) {
        console.log(`S3 bucket cluster-mount-${eksClusterName} not found, skipping`);
        resources.OutputS3BucketName = null;
      }
      
      console.log('Fetched imported cluster resources:', Object.keys(result.cloudFormationOutputs));
      if (result.hyperPodCluster) {
        console.log('Fetched HyperPod cluster:', result.hyperPodCluster.ClusterName);
      }
      return result;
      
    } catch (error) {
      console.error('Error fetching imported cluster resources:', error);
      throw new Error(`Failed to fetch cluster resources: ${error.message}`);
    }
  }

  /**
   * 为导入集群保存资源信息到metadata（与创建集群格式对齐）
   */
  static async saveImportedClusterResources(clusterTag, eksClusterName, awsRegion, hyperPodClusters = null) {
    try {
      // 获取资源信息（包含HyperPod集群数据）
      const resourceData = await this.fetchImportedClusterResources(eksClusterName, awsRegion, hyperPodClusters);
      const resources = resourceData.cloudFormationOutputs;
      const hyperPodCluster = resourceData.hyperPodCluster;
      
      // 读取现有的cluster_info.json
      const clusterInfo = this.getClusterInfo(clusterTag);
      if (!clusterInfo) {
        throw new Error(`Cluster info not found for: ${clusterTag}`);
      }
      
      // 添加CloudFormation输出格式的资源信息（不包含HyperPod子网）
      clusterInfo.cloudFormation = {
        stackName: null, // 导入集群没有CF Stack
        stackId: null,
        outputs: resources
      };
      
      // 添加结构化的EKS集群信息
      clusterInfo.eksCluster = {
        name: resources.OutputEKSClusterName,
        arn: resources.OutputEKSClusterArn,
        vpcId: resources.OutputVpcId,
        securityGroupId: resources.OutputSecurityGroupId,
        privateSubnetIds: resources.OutputPrivateSubnetIds,
        s3BucketName: resources.OutputS3BucketName,
        sageMakerRoleArn: resources.OutputSageMakerIAMRoleArn
      };
      
      // 如果有HyperPod集群，保存完整的集群数据
      if (hyperPodCluster) {
        clusterInfo.hyperPodCluster = hyperPodCluster;
        console.log(`Saved complete HyperPod cluster data for ${clusterTag} (imported)`);
      }
      
      clusterInfo.lastModified = new Date().toISOString();
      
      // 保存更新后的cluster_info.json
      const fs = require('fs');
      const clusterInfoPath = path.join(this.getMetadataDir(clusterTag), 'cluster_info.json');
      fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
      
      console.log(`Saved imported cluster resources for: ${clusterTag}`);
      return resources;
      
    } catch (error) {
      console.error(`Error saving imported cluster resources for ${clusterTag}:`, error);
      throw error;
    }
  }
}

module.exports = MetadataUtils;
