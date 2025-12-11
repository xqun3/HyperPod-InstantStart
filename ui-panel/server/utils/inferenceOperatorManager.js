const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');

/**
 * HyperPod Inference Operator Manager
 * 管理 Inference Operator 的安装、卸载和状态检查
 */
class InferenceOperatorManager {
  constructor(clusterManager) {
    this.clusterManager = clusterManager;
  }

  /**
   * 检查 Inference Operator 状态
   */
  async checkStatus() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    // 检查 Helm release
    const helmInstalled = await this._checkHelmRelease();

    // 检查 IAM Roles
    const iamRoles = await this._checkIAMRoles(activeClusterName);

    return {
      installed: helmInstalled,
      iamRoles,
      namespace: 'hyperpod-inference-system',
      helmRelease: 'hyperpod-inference-operator'
    };
  }

  /**
   * 安装 Inference Operator
   */
  async install() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    const { region, eksClusterName, accountId, oidcId, vpcId, configDir, metadataDir } = 
      await this._getClusterInfo(activeClusterName);

    console.log('Installing Inference Operator...');

    // 1. 创建 IAM Roles
    console.log('Step 1: Creating IAM Roles...');
    const inferenceRoleArn = await this._createInferenceRole(activeClusterName, accountId, region, oidcId);
    const kedaRoleArn = await this._createKedaRole(activeClusterName, accountId, region, oidcId);

    // 2. 获取 HyperPod 集群 ARN
    const hyperPodClusterArn = await this._getHyperPodClusterArn(activeClusterName);

    // 3. 获取 S3 Bucket (用于 TLS 证书)
    const s3Bucket = await this._getS3Bucket(activeClusterName);

    // 4. 获取 S3 CSI Role ARN (如果存在)
    const s3CsiRoleArn = await this._getS3CsiRoleArn(activeClusterName);

    // 5. Helm install
    console.log('Step 2: Installing Helm chart...');
    const helmChartPath = path.join(configDir, 'sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart/charts/inference-operator');
    
    await this._helmInstall(helmChartPath, {
      region,
      eksClusterName,
      hyperPodClusterArn,
      inferenceRoleArn,
      kedaRoleArn,
      vpcId,
      s3Bucket
    });

    // 6. 保存到 metadata
    console.log('Step 3: Saving to metadata...');
    await this._saveToMetadata(metadataDir, {
      inferenceRoleArn,
      kedaRoleArn,
      s3CsiRoleArn
    });

    console.log('Inference Operator installed successfully');

    return {
      success: true,
      message: 'Inference Operator installed successfully',
      iamRoles: {
        inferenceRole: inferenceRoleArn,
        kedaRole: kedaRoleArn
      }
    };
  }

  /**
   * 卸载 Inference Operator
   * 保证幂等：即使资源不存在也不会报错
   */
  async uninstall() {
    const activeClusterName = this.clusterManager.getActiveCluster();
    if (!activeClusterName) {
      throw new Error('No active cluster found');
    }

    const { metadataDir } = await this._getClusterInfo(activeClusterName);

    console.log('Uninstalling Inference Operator...');

    // 1. Helm uninstall
    console.log('Step 1: Uninstalling Helm chart...');
    await this._helmUninstall();

    // 2. 删除 IAM Roles（不依赖 metadata，根据命名规则直接尝试删除）
    console.log('Step 2: Deleting IAM Roles...');
    await this._deleteIAMRoles(activeClusterName);

    // 3. 清理 metadata
    console.log('Step 3: Cleaning metadata...');
    await this._cleanMetadata(metadataDir);

    console.log('Inference Operator uninstalled successfully');

    return {
      success: true,
      message: 'Inference Operator uninstalled successfully'
    };
  }

  /**
   * 获取集群基本信息
   */
  async _getClusterInfo(activeClusterName) {
    const configDir = this.clusterManager.getClusterConfigDir(activeClusterName);
    const metadataDir = this.clusterManager.getClusterMetadataDir(activeClusterName);
    
    const initEnvsPath = path.join(configDir, 'init_envs');
    if (!fs.existsSync(initEnvsPath)) {
      throw new Error('Cluster configuration not found');
    }

    const envContent = fs.readFileSync(initEnvsPath, 'utf8');
    const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
    const region = awsRegionMatch ? awsRegionMatch[1] : 'us-west-2';

    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    if (!fs.existsSync(clusterInfoPath)) {
      throw new Error('Cluster metadata not found');
    }

    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    const eksClusterName = clusterInfo.eksCluster?.name;

    if (!eksClusterName) {
      throw new Error('EKS cluster name not found in metadata');
    }

    // 获取 Account ID
    const accountIdCmd = `aws sts get-caller-identity --query 'Account' --output text`;
    const { stdout: accountId } = await execAsync(accountIdCmd);

    // 获取 OIDC ID
    const oidcCmd = `aws eks describe-cluster --name ${eksClusterName} --region ${region} --query "cluster.identity.oidc.issuer" --output text`;
    const { stdout: oidcUrl } = await execAsync(oidcCmd);
    const oidcId = oidcUrl.trim().split('/').pop();

    // 获取 VPC ID
    const vpcCmd = `aws eks describe-cluster --name ${eksClusterName} --region ${region} --query 'cluster.resourcesVpcConfig.vpcId' --output text`;
    const { stdout: vpcId } = await execAsync(vpcCmd);

    return {
      region: region.trim(),
      eksClusterName: eksClusterName.trim(),
      accountId: accountId.trim(),
      oidcId: oidcId.trim(),
      vpcId: vpcId.trim(),
      configDir,
      metadataDir
    };
  }

  /**
   * 检查 Helm release 是否已安装
   */
  async _checkHelmRelease() {
    try {
      const cmd = `helm list -n hyperpod-inference-system -o json`;
      const { stdout } = await execAsync(cmd);
      const releases = JSON.parse(stdout);
      const release = releases.find(r => r.name === 'hyperpod-inference-operator');
      
      // 只有 deployed 状态才算安装成功
      return release && release.status === 'deployed';
    } catch (error) {
      return false;
    }
  }

  /**
   * 检查 IAM Roles
   */
  async _checkIAMRoles(clusterName) {
    const roles = {
      inferenceRole: null,
      kedaRole: null
    };

    try {
      const inferenceRoleName = `HyperpodInferenceRole-${clusterName}`;
      const cmd = `aws iam get-role --role-name ${inferenceRoleName} --query 'Role.Arn' --output text`;
      const { stdout } = await execAsync(cmd);
      roles.inferenceRole = stdout.trim();
    } catch (error) {
      // Role 不存在
    }

    try {
      const kedaRoleName = `keda-operator-role-${clusterName}`;
      const cmd = `aws iam get-role --role-name ${kedaRoleName} --query 'Role.Arn' --output text`;
      const { stdout } = await execAsync(cmd);
      roles.kedaRole = stdout.trim();
    } catch (error) {
      // Role 不存在
    }

    return roles;
  }

  /**
   * 创建 Inference Role
   */
  async _createInferenceRole(clusterName, accountId, region, oidcId) {
    const roleName = `HyperpodInferenceRole-${clusterName}`;
    const policyName = `HyperpodInferenceAccessPolicy-${clusterName}`;

    // 检查是否已存在
    try {
      const checkCmd = `aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`;
      const { stdout } = await execAsync(checkCmd);
      console.log(`Inference Role already exists: ${stdout.trim()}`);
      return stdout.trim();
    } catch (error) {
      // Role 不存在，继续创建
    }

    // 创建 Trust Policy
    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: ["sagemaker.amazonaws.com"] },
          Action: "sts:AssumeRole"
        },
        {
          Effect: "Allow",
          Principal: {
            Federated: `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}`
          },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringLike: {
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: "sts.amazonaws.com",
              [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: "system:serviceaccount:*:*"
            }
          }
        }
      ]
    };

    // 创建 Permission Policy
    const permissionPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "S3Access",
          Effect: "Allow",
          Action: ["s3:Get*", "s3:List*", "s3:Describe*", "s3:PutObject"],
          Resource: ["*"]
        },
        {
          Sid: "ECRAccess",
          Effect: "Allow",
          Action: [
            "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"
          ],
          Resource: ["*"]
        },
        {
          Sid: "SageMakerAccess",
          Effect: "Allow",
          Action: ["sagemaker:*"],
          Resource: ["*"]
        },
        {
          Sid: "EKSAccess",
          Effect: "Allow",
          Action: ["eks:Describe*", "eks:List*", "eks:AccessKubernetesApi"],
          Resource: ["*"]
        }
      ]
    };

    const tmpDir = '/tmp';
    const trustPolicyPath = path.join(tmpDir, `inference-trust-policy-${Date.now()}.json`);
    const permissionPolicyPath = path.join(tmpDir, `inference-permission-policy-${Date.now()}.json`);

    fs.writeFileSync(trustPolicyPath, JSON.stringify(trustPolicy));
    fs.writeFileSync(permissionPolicyPath, JSON.stringify(permissionPolicy));

    try {
      // 创建 Role
      await execAsync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPolicyPath}`);

      // 创建并附加 Policy
      const { stdout: policyArn } = await execAsync(
        `aws iam create-policy --policy-name ${policyName} --policy-document file://${permissionPolicyPath} --query 'Policy.Arn' --output text`
      );

      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${policyArn.trim()}`);

      // 获取 Role ARN
      const { stdout: roleArn } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`);

      return roleArn.trim();
    } finally {
      // 清理临时文件
      fs.unlinkSync(trustPolicyPath);
      fs.unlinkSync(permissionPolicyPath);
    }
  }

  /**
   * 创建 KEDA Role
   */
  async _createKedaRole(clusterName, accountId, region, oidcId) {
    const roleName = `keda-operator-role-${clusterName}`;
    const policyName = `KedaOperatorPolicy-${clusterName}`;

    // 检查是否已存在
    try {
      const checkCmd = `aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`;
      const { stdout } = await execAsync(checkCmd);
      console.log(`KEDA Role already exists: ${stdout.trim()}`);
      return stdout.trim();
    } catch (error) {
      // Role 不存在，继续创建
    }

    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: {
          Federated: `arn:aws:iam::${accountId}:oidc-provider/oidc.eks.${region}.amazonaws.com/id/${oidcId}`
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringLike: {
            [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:sub`]: "system:serviceaccount:kube-system:keda-operator",
            [`oidc.eks.${region}.amazonaws.com/id/${oidcId}:aud`]: "sts.amazonaws.com"
          }
        }
      }]
    };

    const permissionPolicy = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: [
          "cloudwatch:GetMetricData",
          "cloudwatch:GetMetricStatistics",
          "cloudwatch:ListMetrics"
        ],
        Resource: "*"
      }]
    };

    const tmpDir = '/tmp';
    const trustPolicyPath = path.join(tmpDir, `keda-trust-policy-${Date.now()}.json`);
    const permissionPolicyPath = path.join(tmpDir, `keda-permission-policy-${Date.now()}.json`);

    fs.writeFileSync(trustPolicyPath, JSON.stringify(trustPolicy));
    fs.writeFileSync(permissionPolicyPath, JSON.stringify(permissionPolicy));

    try {
      await execAsync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${trustPolicyPath}`);

      const { stdout: policyArn } = await execAsync(
        `aws iam create-policy --policy-name ${policyName} --policy-document file://${permissionPolicyPath} --query 'Policy.Arn' --output text`
      );

      await execAsync(`aws iam attach-role-policy --role-name ${roleName} --policy-arn ${policyArn.trim()}`);

      const { stdout: roleArn } = await execAsync(`aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`);

      return roleArn.trim();
    } finally {
      fs.unlinkSync(trustPolicyPath);
      fs.unlinkSync(permissionPolicyPath);
    }
  }

  /**
   * 获取 HyperPod 集群 ARN
   */
  async _getHyperPodClusterArn(clusterName) {
    const metadataDir = this.clusterManager.getClusterMetadataDir(clusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    return clusterInfo.hyperPodCluster?.ClusterArn || '';
  }

  /**
   * 获取 S3 Bucket (从 HyperPod LifeCycleConfig)
   */
  async _getS3Bucket(clusterName) {
    const metadataDir = this.clusterManager.getClusterMetadataDir(clusterName);
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
    
    // 从 HyperPod LifeCycleConfig 获取 S3 URI
    const s3Uri = clusterInfo.hyperPodCluster?.InstanceGroups?.[0]?.LifeCycleConfig?.SourceS3Uri;
    
    if (!s3Uri) {
      throw new Error('S3 bucket not found in HyperPod configuration');
    }
    
    // 提取 bucket 名称 (s3://bucket-name/... -> bucket-name)
    const bucketName = s3Uri.replace('s3://', '').split('/')[0];
    return bucketName;
  }

  /**
   * 获取 S3 CSI Role ARN
   */
  async _getS3CsiRoleArn(clusterName) {
    try {
      const roleName = `SM_HP_S3_CSI_ROLE-${clusterName}`;
      const cmd = `aws iam get-role --role-name ${roleName} --query 'Role.Arn' --output text`;
      const { stdout } = await execAsync(cmd);
      return stdout.trim();
    } catch (error) {
      return '';
    }
  }

  /**
   * Helm install
   */
  async _helmInstall(chartPath, config) {
    const {
      region,
      eksClusterName,
      hyperPodClusterArn,
      inferenceRoleArn,
      kedaRoleArn,
      vpcId,
      s3Bucket
    } = config;

    // 添加 Helm 仓库
    console.log('Adding Helm repositories...');
    const repos = [
      { name: 'aws-s3-csi', url: 'https://awslabs.github.io/mountpoint-s3-csi-driver/' },
      { name: 'metrics-server', url: 'https://kubernetes-sigs.github.io/metrics-server/' },
      { name: 'aws-fsx-csi', url: 'https://kubernetes-sigs.github.io/aws-fsx-csi-driver' },
      { name: 'eks-charts', url: 'https://aws.github.io/eks-charts' },
      { name: 'jetstack', url: 'https://charts.jetstack.io' },
      { name: 'kedacore', url: 'https://kedacore.github.io/charts' }
    ];

    for (const repo of repos) {
      try {
        await execAsync(`helm repo add ${repo.name} ${repo.url}`, { timeout: 30000 });
      } catch (error) {
        // 仓库可能已存在，忽略错误
        console.log(`Repo ${repo.name} already exists or failed to add`);
      }
    }

    // 更新仓库
    console.log('Updating Helm repositories...');
    await execAsync('helm repo update', { timeout: 60000 });

    // 构建依赖（下载子 charts）
    console.log('Building Helm chart dependencies...');
    try {
      await execAsync(`helm dependency build ${chartPath}`, { timeout: 120000 });
    } catch (error) {
      console.error('Helm dependency build failed:', error.message);
      throw new Error(`Failed to build Helm dependencies: ${error.message}`);
    }

    // 检查是否存在残留的 release（幂等处理）
    console.log('Checking for existing Helm release...');
    try {
      const { stdout } = await execAsync(`helm list -n hyperpod-inference-system -o json`);
      const releases = JSON.parse(stdout);
      const existingRelease = releases.find(r => r.name === 'hyperpod-inference-operator');

      if (existingRelease) {
        if (existingRelease.status === 'deployed') {
          console.log('Inference Operator already installed and deployed, skipping installation');
          return;
        }
        // failed 或其他异常状态，先清理再安装
        console.log(`Found existing release with status "${existingRelease.status}", cleaning up...`);
        await this._helmUninstall();
      }
    } catch (error) {
      // namespace 不存在或其他错误，继续正常安装
      console.log('No existing release found, proceeding with installation');
    }

    // 预创建 namespace 并带上 Helm 管理标签
    // 原因：chart 模板中包含 kind: Namespace，Helm 会尝试管理它
    // 如果用 --create-namespace，会与模板中的 Namespace 冲突
    // 如果不创建，Helm 又找不到 namespace
    // 解决方案：预创建带 Helm 标签的 namespace，让 Helm 能接管它
    console.log('Creating namespace with Helm labels...');
    try {
      await execAsync(`kubectl create namespace hyperpod-inference-system --dry-run=client -o yaml | kubectl apply -f -`);
      await execAsync(`kubectl label namespace hyperpod-inference-system app.kubernetes.io/managed-by=Helm --overwrite`);
      await execAsync(`kubectl annotate namespace hyperpod-inference-system meta.helm.sh/release-name=hyperpod-inference-operator meta.helm.sh/release-namespace=hyperpod-inference-system --overwrite`);
      console.log('Namespace prepared with Helm labels');
    } catch (error) {
      console.log(`Namespace preparation: ${error.message}`);
    }

    // 构建 Helm 安装命令
    let helmCmd = `helm install hyperpod-inference-operator ${chartPath} \
      -n hyperpod-inference-system \
      --set region=${region} \
      --set eksClusterName=${eksClusterName} \
      --set executionRoleArn=${inferenceRoleArn} \
      --set tlsCertificateS3Bucket=s3://${s3Bucket} \
      --set alb.enabled=true \
      --set alb.region=${region} \
      --set alb.clusterName=${eksClusterName} \
      --set alb.vpcId=${vpcId} \
      --set cert-manager.enabled=false \
      --set s3.enabled=false \
      --set keda.enabled=true \
      --set keda.podIdentity.aws.irsa.roleArn=${kedaRoleArn} \
      --set metrics.enabled=true \
      --set fsx.enabled=true`;

    if (hyperPodClusterArn) {
      helmCmd += ` --set hyperpodClusterArn=${hyperPodClusterArn}`;
    }

    console.log('Installing Helm chart...');
    await execAsync(helmCmd, { timeout: 300000 });
  }

  /**
   * Helm uninstall
   */
  async _helmUninstall() {
    try {
      await execAsync(`helm uninstall hyperpod-inference-operator -n hyperpod-inference-system`);
      console.log('Helm chart uninstalled');
    } catch (error) {
      console.log('Helm chart not found or already uninstalled');
    }

    // 强制删除 namespace
    try {
      console.log('Deleting namespace...');
      await execAsync(`kubectl delete namespace hyperpod-inference-system --timeout=10s`, { timeout: 15000 });
    } catch (error) {
      console.log('Namespace deletion timeout, forcing cleanup...');
      
      // 如果超时，强制移除 finalizers
      try {
        await execAsync(`kubectl get namespace hyperpod-inference-system -o json | jq '.spec.finalizers = []' | kubectl replace --raw /api/v1/namespaces/hyperpod-inference-system/finalize -f -`, { timeout: 10000 });
        console.log('Namespace finalizers removed');
      } catch (finalizerError) {
        console.log('Finalizer removal failed or namespace already gone');
      }
    }

    // 等待 namespace 完全删除
    let retries = 5;
    while (retries > 0) {
      try {
        await execAsync(`kubectl get namespace hyperpod-inference-system`);
        console.log('Waiting for namespace deletion...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        retries--;
      } catch (error) {
        // Namespace 不存在了，删除成功
        console.log('Namespace deleted successfully');
        break;
      }
    }
  }

  /**
   * 删除 IAM Roles
   * 不依赖 metadata，直接根据命名规则尝试删除，保证幂等
   */
  async _deleteIAMRoles(clusterName) {
    // 获取 Account ID
    let accountId;
    try {
      const { stdout } = await execAsync(`aws sts get-caller-identity --query 'Account' --output text`);
      accountId = stdout.trim();
    } catch (error) {
      console.log('Failed to get account ID, skipping IAM cleanup');
      return;
    }

    // 删除 Inference Role
    const inferenceRoleName = `HyperpodInferenceRole-${clusterName}`;
    const inferencePolicyName = `HyperpodInferenceAccessPolicy-${clusterName}`;
    const inferencePolicyArn = `arn:aws:iam::${accountId}:policy/${inferencePolicyName}`;

    try {
      await execAsync(`aws iam detach-role-policy --role-name ${inferenceRoleName} --policy-arn ${inferencePolicyArn}`);
      console.log(`Detached policy from ${inferenceRoleName}`);
    } catch (error) {
      // Policy 未附加或 Role 不存在，忽略
    }

    try {
      await execAsync(`aws iam delete-policy --policy-arn ${inferencePolicyArn}`);
      console.log(`Deleted policy: ${inferencePolicyName}`);
    } catch (error) {
      // Policy 不存在，忽略
    }

    try {
      await execAsync(`aws iam delete-role --role-name ${inferenceRoleName}`);
      console.log(`Deleted role: ${inferenceRoleName}`);
    } catch (error) {
      // Role 不存在，忽略
    }

    // 删除 KEDA Role
    const kedaRoleName = `keda-operator-role-${clusterName}`;
    const kedaPolicyName = `KedaOperatorPolicy-${clusterName}`;
    const kedaPolicyArn = `arn:aws:iam::${accountId}:policy/${kedaPolicyName}`;

    try {
      await execAsync(`aws iam detach-role-policy --role-name ${kedaRoleName} --policy-arn ${kedaPolicyArn}`);
      console.log(`Detached policy from ${kedaRoleName}`);
    } catch (error) {
      // Policy 未附加或 Role 不存在，忽略
    }

    try {
      await execAsync(`aws iam delete-policy --policy-arn ${kedaPolicyArn}`);
      console.log(`Deleted policy: ${kedaPolicyName}`);
    } catch (error) {
      // Policy 不存在，忽略
    }

    try {
      await execAsync(`aws iam delete-role --role-name ${kedaRoleName}`);
      console.log(`Deleted role: ${kedaRoleName}`);
    } catch (error) {
      // Role 不存在，忽略
    }
  }

  /**
   * 保存到 metadata
   */
  async _saveToMetadata(metadataDir, iamRoles) {
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

    clusterInfo.inferenceOperator = {
      installed: true,
      installationDate: new Date().toISOString(),
      iamRoles: {
        inferenceRole: iamRoles.inferenceRoleArn,
        kedaRole: iamRoles.kedaRoleArn,
        s3CsiRole: iamRoles.s3CsiRoleArn || null
      },
      helmRelease: 'hyperpod-inference-operator',
      namespace: 'hyperpod-inference-system'
    };

    fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
  }

  /**
   * 读取 metadata
   */
  async _readMetadata(metadataDir) {
    const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
    if (!fs.existsSync(clusterInfoPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
  }

  /**
   * 清理 metadata
   * 保证幂等：即使文件不存在或字段不存在也不会报错
   */
  async _cleanMetadata(metadataDir) {
    try {
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
      if (!fs.existsSync(clusterInfoPath)) {
        console.log('Metadata file not found, skipping cleanup');
        return;
      }

      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));

      if (clusterInfo.inferenceOperator) {
        delete clusterInfo.inferenceOperator;
        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
        console.log('Cleaned inferenceOperator from metadata');
      } else {
        console.log('No inferenceOperator in metadata, skipping');
      }
    } catch (error) {
      console.log(`Failed to clean metadata: ${error.message}`);
    }
  }
}

module.exports = InferenceOperatorManager;
