const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const AWSHelpers = require('./awsHelpers');

/**
 * HyperPod Karpenter 安装管理器
 */
class HyperPodKarpenterInstaller {
  
  /**
   * 安装 HyperPod Karpenter
   */
  static async installHyperPodKarpenter(clusterTag, hyperPodClusterName) {
    const logFile = path.join('/app/managed_clusters_info', clusterTag, 'logs', 'hyperpod-karpenter-install.log');
    
    try {
      // 确保日志目录存在
      await fs.ensureDir(path.dirname(logFile));
      
      // 写入日志头
      const timestamp = new Date().toISOString();
      await fs.appendFile(logFile, `\n=== HyperPod Karpenter Installation Started at ${timestamp} ===\n`);
      await fs.appendFile(logFile, `Cluster Tag: ${clusterTag}\n`);
      await fs.appendFile(logFile, `HyperPod Cluster: ${hyperPodClusterName}\n\n`);
      
      // 检查是否已安装
      const existingStatus = await this.getInstallationStatus(clusterTag);
      if (existingStatus.installed) {
        await fs.appendFile(logFile, `Already installed, skipping...\n`);
        return {
          success: true,
          message: 'HyperPod Karpenter already installed',
          roleName: existingStatus.roleName,
          roleArn: existingStatus.roleArn,
          alreadyInstalled: true
        };
      }
      
      // 获取 AWS 信息
      const region = await AWSHelpers.getCurrentRegion();
      const accountId = await AWSHelpers.getCurrentAccountId();
      
      await fs.appendFile(logFile, `Region: ${region}\n`);
      await fs.appendFile(logFile, `Account ID: ${accountId}\n\n`);
      
      // 1. 创建 IAM Role
      const roleName = `hyperpod-karpenter-role-${clusterTag}`;
      await fs.appendFile(logFile, `Step 1: Creating IAM Role: ${roleName}\n`);
      
      const trustPolicy = {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "hyperpod.sagemaker.amazonaws.com" },
          Action: "sts:AssumeRole"
        }]
      };
      
      const createRoleCmd = `aws iam create-role --role-name "${roleName}" --assume-role-policy-document '${JSON.stringify(trustPolicy)}' --region ${region}`;
      
      try {
        const roleOutput = execSync(createRoleCmd, { encoding: 'utf8' });
        await fs.appendFile(logFile, `Role created successfully\n${roleOutput}\n\n`);
      } catch (error) {
        if (error.message.includes('EntityAlreadyExists')) {
          await fs.appendFile(logFile, `Role already exists, continuing...\n\n`);
        } else {
          throw error;
        }
      }
      
      // 2. 添加 Inline Policy
      await fs.appendFile(logFile, `Step 2: Adding inline policy\n`);
      
      const policyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "sagemaker:BatchAddClusterNodes",
              "sagemaker:BatchDeleteClusterNodes"
            ],
            Resource: "arn:aws:sagemaker:*:*:cluster/*",
            Condition: {
              StringEquals: {
                "aws:ResourceAccount": "${aws:PrincipalAccount}"
              }
            }
          },
          {
            Effect: "Allow",
            Action: [
              "kms:CreateGrant",
              "kms:DescribeKey"
            ],
            Resource: "arn:aws:kms:*:*:key/*",
            Condition: {
              StringLike: {
                "kms:ViaService": "sagemaker.*.amazonaws.com"
              },
              Bool: {
                "kms:GrantIsForAWSResource": "true"
              },
              "ForAllValues:StringEquals": {
                "kms:GrantOperations": [
                  "CreateGrant",
                  "Decrypt",
                  "DescribeKey",
                  "GenerateDataKeyWithoutPlaintext",
                  "ReEncryptTo",
                  "ReEncryptFrom",
                  "RetireGrant"
                ]
              }
            }
          }
        ]
      };
      
      const putPolicyCmd = `aws iam put-role-policy --role-name "${roleName}" --policy-name "${roleName}-Karpenter-Policy" --policy-document '${JSON.stringify(policyDocument)}' --region ${region}`;
      
      const policyOutput = execSync(putPolicyCmd, { encoding: 'utf8' });
      await fs.appendFile(logFile, `Policy added successfully\n${policyOutput}\n\n`);
      
      // 3. 添加 Tag
      await fs.appendFile(logFile, `Step 3: Adding tag to role\n`);
      
      const tagCmd = `aws iam tag-role --role-name "${roleName}" --tags Key=aws-sagemaker-hyperpod-prerequisite,Value="${roleName}" --region ${region}`;
      
      const tagOutput = execSync(tagCmd, { encoding: 'utf8' });
      await fs.appendFile(logFile, `Tag added successfully\n${tagOutput}\n\n`);
      
      // 4. Update Cluster
      const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
      await fs.appendFile(logFile, `Step 4: Updating HyperPod cluster with Karpenter\n`);
      await fs.appendFile(logFile, `Role ARN: ${roleArn}\n`);
      
      const updateClusterCmd = `aws sagemaker update-cluster --cluster-name "${hyperPodClusterName}" --auto-scaling Mode=Enable,AutoScalerType=Karpenter --cluster-role "${roleArn}" --node-recovery Automatic --region ${region}`;
      
      try {
        const updateOutput = execSync(updateClusterCmd, { encoding: 'utf8' });
        await fs.appendFile(logFile, `Cluster updated successfully\n${updateOutput}\n\n`);
      } catch (error) {
        // 如果错误是"没有变化"，说明集群已经配置好了
        if (error.message.includes('no changes') || error.message.includes('ValidationException')) {
          await fs.appendFile(logFile, `Cluster already configured with Karpenter, skipping update\n\n`);
        } else {
          throw error;
        }
      }
      
      // 5. 更新 metadata
      await this.updateMetadata(clusterTag, {
        installed: true,
        roleName: roleName,
        roleArn: roleArn,
        installationDate: new Date().toISOString()
      });
      
      await fs.appendFile(logFile, `=== Installation completed successfully ===\n`);
      
      return {
        success: true,
        message: 'HyperPod Karpenter installed successfully',
        roleName: roleName,
        roleArn: roleArn
      };
      
    } catch (error) {
      await fs.appendFile(logFile, `\n!!! Installation failed: ${error.message} !!!\n`);
      await fs.appendFile(logFile, `Stack trace: ${error.stack}\n`);
      throw error;
    }
  }
  
  /**
   * 更新集群 metadata
   */
  static async updateMetadata(clusterTag, karpenterInfo) {
    const metadataFile = path.join('/app/managed_clusters_info', clusterTag, 'metadata', 'cluster_info.json');
    
    try {
      const metadata = await fs.readJson(metadataFile);
      
      // 添加 hyperpodKarpenter 字段
      metadata.hyperpodKarpenter = karpenterInfo;
      metadata.lastModified = new Date().toISOString();
      
      await fs.writeJson(metadataFile, metadata, { spaces: 2 });
      
      console.log(`Updated metadata for cluster ${clusterTag}`);
    } catch (error) {
      console.error('Failed to update metadata:', error);
      throw error;
    }
  }
  
  /**
   * 检查 HyperPod Karpenter 安装状态
   */
  static async getInstallationStatus(clusterTag) {
    const metadataFile = path.join('/app/managed_clusters_info', clusterTag, 'metadata', 'cluster_info.json');
    
    try {
      const metadata = await fs.readJson(metadataFile);
      return metadata.hyperpodKarpenter || { installed: false };
    } catch (error) {
      return { installed: false };
    }
  }
}

module.exports = HyperPodKarpenterInstaller;
