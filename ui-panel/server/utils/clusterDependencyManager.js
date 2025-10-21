const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class ClusterDependencyManager {
  
  /**
   * 执行非阻塞命令
   */
  static async executeNonBlocking(command, options = {}) {
    return new Promise((resolve, reject) => {
      // 添加日志头部
      const logFile = '/app/tmp/cluster-dependency.log';
      const timestamp = new Date().toISOString();
      const logHeader = `\n=== ${timestamp} ===\nExecuting: ${command.substring(0, 100)}...\n`;
      
      try {
        fs.appendFileSync(logFile, logHeader);
      } catch (err) {
        console.error('Failed to write log header:', err);
      }
      
      const child = spawn('bash', ['-c', `${command} >> ${logFile} 2>&1`], {
        stdio: 'pipe',
        ...options
      });
      
      child.on('close', (code) => {
        const logFooter = `\n--- Command completed with exit code: ${code} ---\n`;
        try {
          fs.appendFileSync(logFile, logFooter);
        } catch (err) {
          console.error('Failed to write log footer:', err);
        }
        
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });
      
      child.on('error', (error) => {
        const errorLog = `\n!!! Command execution error: ${error.message} !!!\n`;
        try {
          fs.appendFileSync(logFile, errorLog);
        } catch (err) {
          console.error('Failed to write error log:', err);
        }
        reject(error);
      });
    });
  }
  
  /**
   * 获取CloudFormation Stack的输出信息
   */
  static async fetchCloudFormationOutputs(clusterConfigDir) {
    console.log('Fetching CloudFormation outputs...');
    
    const fetchCmd = `cd ${clusterConfigDir} && bash -c 'source init_envs && 
aws cloudformation describe-stacks --stack-name $CLOUD_FORMATION_FULL_STACK_NAME --region $AWS_REGION --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" --output text | 
while read -r key value; do
  case $key in
    "OutputEKSClusterName") echo "export EKS_CLUSTER_NAME=$value" ;;
    "OutputEKSClusterArn") echo "export EKS_CLUSTER_ARN=$value" ;;
    "OutputS3BucketName") echo "export LIFECYCLE_S3_BUCKET_NAME=$value" ;;
    "OutputSageMakerIAMRoleArn") echo "export EXECUTION_ROLE=$value" ;;
    "OutputVpcId") echo "export VPC_ID=$value" ;;
    "OutputPrivateSubnetIds") echo "export PRIVATE_SUBNET_ID=$value" ;;
    "OutputSecurityGroupId") echo "export SECURITY_GROUP_ID=$value" ;;
    "OutputHyperPodClusterName") echo "export HP_CLUSTER_NAME=$value" ;;
    "OutputHyperPodClusterArn") echo "export HP_CLUSTER_ARN=$value" ;;
  esac
done > stack_envs'`;
    
    await this.executeNonBlocking(fetchCmd);
    
    // 验证stack_envs文件是否创建成功
    const stackEnvsPath = path.join(clusterConfigDir, 'stack_envs');
    if (!fs.existsSync(stackEnvsPath)) {
      throw new Error('Failed to create stack_envs file');
    }
    
    return stackEnvsPath;
  }

  /**
   * 配置kubectl和OIDC provider
   */
  static async configureKubectlAndOIDC(clusterConfigDir) {
    console.log('Configuring kubectl and OIDC...');
    
    const kubectlCmd = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 
echo "=== Configuring kubectl for cluster: $EKS_CLUSTER_NAME ===" &&
aws eks update-kubeconfig --name $EKS_CLUSTER_NAME --region $AWS_REGION &&
echo "=== Associating IAM OIDC provider ===" &&
eksctl utils associate-iam-oidc-provider --region $AWS_REGION --cluster $EKS_CLUSTER_NAME --approve &&
echo "=== kubectl and OIDC configuration completed ==="'`;
    
    await this.executeNonBlocking(kubectlCmd);
  }

  /**
   * 安装Helm依赖
   */
  static async installHelmDependencies(clusterConfigDir) {
    console.log('Installing helm dependencies...');
    
    // 分步执行，便于调试和错误处理
    await this.setupHelmRepos(clusterConfigDir);
    await this.cloneHyperPodCLI(clusterConfigDir);
    await this.createNamespaces(clusterConfigDir);
    await this.installHyperPodChart(clusterConfigDir);
  }

  /**
   * 设置Helm仓库
   */
  static async setupHelmRepos(clusterConfigDir) {
    console.log('Setting up helm repositories...');
    
    const repoCmd = `cd ${clusterConfigDir} && 
echo "=== Setting up Helm repositories ===" &&
helm repo add eks https://aws.github.io/eks-charts --debug &&
helm repo add nvidia https://nvidia.github.io/k8s-device-plugin --debug &&
echo "=== Updating Helm repositories ===" &&
helm repo update --debug &&
echo "=== Helm repositories setup completed ==="`;
    
    await this.executeNonBlocking(repoCmd);
  }

  /**
   * 克隆HyperPod CLI仓库
   */
  static async cloneHyperPodCLI(clusterConfigDir) {
    console.log('Cloning SageMaker HyperPod CLI repository...');
    
    const cloneCmd = `cd ${clusterConfigDir} && 
if [ ! -d "./sagemaker-hyperpod-cli" ]; then
  echo "Cloning SageMaker HyperPod CLI repository..."
  git clone https://github.com/aws/sagemaker-hyperpod-cli.git
else
  echo "SageMaker HyperPod CLI repository already exists, skipping clone..."
fi`;
    
    await this.executeNonBlocking(cloneCmd);
  }

  /**
   * 创建必要的命名空间
   */
  static async createNamespaces(clusterConfigDir) {
    console.log('Creating namespaces...');
    
    const namespaceCmd = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 
kubectl create namespace aws-hyperpod --dry-run=client -o yaml | kubectl apply -f -'`;
    
    await this.executeNonBlocking(namespaceCmd);
  }

  /**
   * 安装HyperPod Helm Chart
   */
  static async installHyperPodChart(clusterConfigDir) {
    console.log('Installing HyperPod helm chart...');
    
    const installCmd = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 
echo "=== Building HyperPod Helm Chart dependencies ===" &&
helm dependency build sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart --debug &&
echo "=== Installing HyperPod Helm Chart ===" &&
echo "Cluster: $EKS_CLUSTER_NAME" &&
echo "Region: $AWS_REGION" &&
helm upgrade --install hyperpod-dependencies ./sagemaker-hyperpod-cli/helm_chart/HyperPodHelmChart \\
  --kube-context arn:aws:eks:$AWS_REGION:$(aws sts get-caller-identity --query Account --output text):cluster/$EKS_CLUSTER_NAME \\
  --namespace kube-system \\
  --set neuron-device-plugin.devicePlugin.enabled=false \\
  --set nvidia-device-plugin.devicePlugin.enabled=true \\
  --set aws-efa-k8s-device-plugin.devicePlugin.enabled=true \\
  --set aws-efa-k8s-device-plugin.image.tag="v0.5.12" \\
  --set health-monitoring-agent.enabled=true \\
  --set hyperpod-patching.enabled=true \\
  --set mpi-operator.enabled=true \\
  --set trainingOperators.enabled=true \\
  --set deep-health-check.enabled=false \\
  --set job-auto-restart.enabled=false \\
  --timeout=10m &&
echo "=== HyperPod Helm Chart installation completed ==="'`;
    
    await this.executeNonBlocking(installCmd);
  }


  static async installGeneralDependencies(clusterConfigDir) {
    console.log('Installing EKS general dependencies...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 
    
    # 安装S3 CSI驱动程序
    echo "=== Installing S3 CSI Driver ==="
    
    # 获取账户ID
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    ROLE_NAME=SM_HP_S3_CSI_ROLE_$EKS_CLUSTER_NAME
    
    # 创建IAM服务账户和角色
    echo "Creating IAM service account for S3 CSI driver..."
    eksctl create iamserviceaccount \\
        --name s3-csi-driver-sa \\
        --namespace kube-system \\
        --override-existing-serviceaccounts \\
        --cluster $EKS_CLUSTER_NAME \\
        --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess \\
        --role-name $ROLE_NAME \\
        --approve \\
        --role-only || echo "S3 CSI service account already exists"
    
    # 获取角色ARN
    ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --query "Role.Arn" --output text)
    
    # 安装S3 CSI驱动程序addon
    echo "Installing S3 CSI driver addon..."
    eksctl create addon \\
        --name aws-mountpoint-s3-csi-driver \\
        --cluster $EKS_CLUSTER_NAME \\
        --service-account-role-arn $ROLE_ARN \\
        --force || echo "S3 CSI driver addon already exists"
    
    echo "S3 CSI Driver installation completed"
        
    echo "EKS general dependencies installation completed"
    '`;
    
    await this.executeNonBlocking(commands);
  }

  static async installnlbDependencies(clusterConfigDir) {
    console.log('Installing NLB dependencies...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 
    
    # 下载ALB IAM策略
    curl -o /tmp/alb-iam-policy.json https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.13.0/docs/install/iam_policy.json

    # 检查并处理IAM策略
    echo "Checking IAM policy status..."
    POLICY_ARN="arn:aws:iam::\$ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy"
    
    if aws iam get-policy --policy-arn "\$POLICY_ARN" >/dev/null 2>&1; then
        echo "Policy already exists, skipping creation"
    else
        echo "Creating IAM policy..."
        aws iam create-policy \\
            --policy-name AWSLoadBalancerControllerIAMPolicy \\
            --policy-document file:///tmp/alb-iam-policy.json || echo "Policy creation failed"
    fi

    # 删除现有的AWS Load Balancer Controller（如果存在）
    echo "Removing existing AWS Load Balancer Controller..."
    helm uninstall aws-load-balancer-controller -n kube-system >> /app/tmp/dependency-install.log 2>&1 || echo "No existing controller found"
    
    # 等待清理完成
    echo "Waiting for cleanup to complete..."
    sleep 10
    
    # 等待webhook service完全清理
    while kubectl get service aws-load-balancer-webhook-service -n kube-system >/dev/null 2>&1; do
        echo "Waiting for webhook service to be removed..."
        sleep 5
    done

    # 创建IAM服务账户（先删除再创建确保干净状态）
    echo "Ensuring clean ServiceAccount state..."
    eksctl delete iamserviceaccount --cluster=\$EKS_CLUSTER_NAME --namespace=kube-system --name=aws-load-balancer-controller >> /app/tmp/dependency-install.log 2>&1 || echo "ServiceAccount not found, proceeding..."
    
    # 使用短的角色名称避免64字符限制
    ROLE_NAME="ALB-\$EKS_CLUSTER_NAME"
    
    echo "Creating ServiceAccount for AWS Load Balancer Controller..."
    eksctl create iamserviceaccount \\
      --cluster=\$EKS_CLUSTER_NAME \\
      --namespace=kube-system \\
      --name=aws-load-balancer-controller \\
      --role-name=\$ROLE_NAME \\
      --attach-policy-arn=arn:aws:iam::\$ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy \\
      --region=\$AWS_REGION \\
      --approve
    
    # 验证ServiceAccount创建成功
    if ! kubectl get serviceaccount aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
        echo "❌ Failed to create ServiceAccount"
        exit 1
    fi
    echo "✅ ServiceAccount created successfully"

    # 获取公有子网并添加ELB标签
    echo "Tagging public subnets for ELB..."
    PUBLIC_SUBNETS=\$(aws ec2 describe-subnets \\
        --filters "Name=vpc-id,Values=\${VPC_ID}" "Name=map-public-ip-on-launch,Values=true" \\
        --query "Subnets[*].SubnetId" \\
        --output text)
    
    for SUBNET_ID in \$PUBLIC_SUBNETS; do
        echo "Tagging public subnet: \$SUBNET_ID"
        aws ec2 create-tags --resources \$SUBNET_ID --tags Key=kubernetes.io/role/elb,Value=1 >> /app/tmp/dependency-install.log 2>&1 || echo "Failed to tag \$SUBNET_ID"
    done

    # 安装AWS Load Balancer Controller
    echo "Installing AWS Load Balancer Controller..."
    helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \\
      -n kube-system \\
      --set clusterName=\$EKS_CLUSTER_NAME \\
      --set serviceAccount.create=false \\
      --set serviceAccount.name=aws-load-balancer-controller \\
      --set vpcId=\$VPC_ID \\
      --set region=\$AWS_REGION \\
      --timeout=300s

    # 验证Controller安装状态（不等待Pod就绪）
    echo "Checking AWS Load Balancer Controller installation..."
    helm list -n kube-system | grep aws-load-balancer-controller || echo "Controller not found in helm list"

    # 最终状态检查
    echo "Final status check..."
    if kubectl get deployment aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
        echo "✅ AWS Load Balancer Controller deployment exists"
    else
        echo "⚠️  AWS Load Balancer Controller deployment not found"
    fi
    
    if kubectl get serviceaccount aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
        echo "✅ ServiceAccount exists"
    else
        echo "⚠️  ServiceAccount not found"
    fi

    echo "NLB dependencies installation completed"
    '`;
    
    await this.executeNonBlocking(commands);
  }

    // # 确保ServiceAccount有正确的IAM角色注解
    // kubectl annotate serviceaccount aws-load-balancer-controller -n kube-system \\
    //   eks.amazonaws.com/role-arn=arn:aws:iam::\$ACCOUNT_ID:role/eksctl-\$EKS_CLUSTER_NAME-addon-iamserviceaccount-kube-system-aws-load-balancer-controller \\
    //   --overwrite || echo "Failed to annotate service account"

  static async installCertificationDependency(clusterConfigDir) {
    console.log('Installing certification dependencies...');
    
    const commands = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 

    # 提取SageMaker执行角色名称
    EXEC_ROLE_NAME=\${EXECUTION_ROLE##*/}
    echo "Using execution role: \$EXEC_ROLE_NAME"

    # 1. 为SageMaker执行角色添加DescribeClusterNode权限
    echo "Adding SageMaker DescribeClusterNode policy..."
    aws iam put-role-policy \\
        --role-name \$EXEC_ROLE_NAME \\
        --policy-name SageMakerDescribeClusterNode \\
        --policy-document '"'"'{
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": [
                "sagemaker:DescribeClusterNode"
              ],
              "Resource": "*"
            }
          ]
        }'"'"'

    # 2. 更新角色信任策略，允许EKS Pod Identity
    echo "Updating assume role policy for EKS Pod Identity..."
    aws iam update-assume-role-policy \\
        --role-name \$EXEC_ROLE_NAME \\
        --policy-document '"'"'{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {
                    "Service": "sagemaker.amazonaws.com"
                },
                "Action": "sts:AssumeRole"
            },
            {
                "Sid": "AllowEksAuthToAssumeRoleForPodIdentity",
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
    }'"'"'

    # 3. 创建EKS Pod Identity Agent addon
    echo "Creating EKS Pod Identity Agent addon..."
    aws eks create-addon \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --addon-name eks-pod-identity-agent \\
        --region \$AWS_REGION \\
        --resolve-conflicts OVERWRITE >> /app/tmp/dependency-install.log 2>&1 || echo "Pod Identity Agent addon already exists"

    # 4. 创建Pod Identity Association
    echo "Creating Pod Identity Association..."
    aws eks create-pod-identity-association \\
        --cluster-name \$EKS_CLUSTER_NAME \\
        --role-arn \$EXECUTION_ROLE \\
        --namespace aws-hyperpod \\
        --service-account hp-training-operator-controller-manager \\
        --region \$AWS_REGION >> /app/tmp/dependency-install.log 2>&1 || echo "Pod Identity Association already exists"

    '`;
    
    await this.executeNonBlocking(commands);
  }

  /**
   * EKS集群基础依赖配置流程（不包含HyperPod专用依赖）
   */
  static async configureClusterDependencies(clusterTag, clusterManager) {
    try {
      console.log(`Configuring EKS cluster dependencies for: ${clusterTag}`);
      
      // 获取集群配置目录
      const clusterDir = clusterManager.getClusterDir(clusterTag);
      const configDir = path.join(clusterDir, 'config');
      
      // 验证配置目录存在
      if (!fs.existsSync(configDir)) {
        throw new Error(`Cluster config directory not found: ${configDir}`);
      }
      
      await this.fetchCloudFormationOutputs(configDir);
      
      await this.configureKubectlAndOIDC(configDir);
      
      await this.installHelmDependencies(configDir);

      await this.installnlbDependencies(configDir);

      await this.installCertificationDependency(configDir);
      
      await this.installGeneralDependencies(configDir);
      
      console.log(`Successfully configured EKS cluster dependencies for: ${clusterTag}`);
      return { success: true };
      
    } catch (error) {
      console.error(`Error configuring EKS cluster dependencies for ${clusterTag}:`, error);
      throw error;
    }
  }

  /**
   * 检查依赖配置状态
   */
  static async checkDependencyStatus(clusterConfigDir) {
    try {
      // 检查stack_envs文件是否存在
      const stackEnvsPath = path.join(clusterConfigDir, 'stack_envs');
      const hasStackEnvs = fs.existsSync(stackEnvsPath);
      
      // 检查helm chart是否安装
      const helmCheckCmd = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && helm list -n kube-system | grep hyperpod-dependencies'`;
      let hasHelmChart = false;
      
      try {
        execSync(helmCheckCmd, { stdio: 'pipe' });
        hasHelmChart = true;
      } catch (error) {
        hasHelmChart = false;
      }
      
      return {
        hasStackEnvs,
        hasHelmChart,
        isConfigured: hasStackEnvs && hasHelmChart
      };
      
    } catch (error) {
      console.error('Error checking dependency status:', error);
      return {
        hasStackEnvs: false,
        hasHelmChart: false,
        isConfigured: false,
        error: error.message
      };
    }
  }

  /**
   * 清理依赖配置（用于重新配置或错误恢复）
   */
  static async cleanupDependencies(clusterConfigDir) {
    try {
      console.log('Cleaning up cluster dependencies...');
      
      // 卸载helm chart
      const uninstallCmd = `cd ${clusterConfigDir} && bash -c 'source init_envs && source stack_envs && 
helm uninstall hyperpod-dependencies -n kube-system || true'`;
      
      execSync(uninstallCmd, { stdio: 'inherit' });
      
      // 删除stack_envs文件
      const stackEnvsPath = path.join(clusterConfigDir, 'stack_envs');
      if (fs.existsSync(stackEnvsPath)) {
        fs.unlinkSync(stackEnvsPath);
      }
      
      // 删除克隆的仓库
      const repoPath = path.join(clusterConfigDir, 'sagemaker-hyperpod-cli');
      if (fs.existsSync(repoPath)) {
        execSync(`rm -rf ${repoPath}`, { stdio: 'inherit' });
      }
      
      console.log('Successfully cleaned up dependencies');
      return { success: true };
      
    } catch (error) {
      console.error('Error cleaning up dependencies:', error);
      throw error;
    }
  }
}

module.exports = ClusterDependencyManager;
