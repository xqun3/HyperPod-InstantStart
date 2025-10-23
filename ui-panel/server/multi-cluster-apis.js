const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const ClusterManager = require('./cluster-manager');
const MultiClusterLogManager = require('./multi-cluster-log-manager');

// 多集群管理API
class MultiClusterAPIs {
  constructor() {
    this.clusterManager = new ClusterManager();
  }

  // 获取所有集群列表
  async handleGetClusters(req, res) {
    try {
      const clusters = this.clusterManager.getAllClusters();
      const activeCluster = this.clusterManager.getActiveCluster();
      
      res.json({
        success: true,
        clusters,
        activeCluster
      });
    } catch (error) {
      console.error('Error getting clusters:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 切换活跃集群
  async handleSwitchCluster(req, res) {
    try {
      const { clusterTag } = req.body;
      
      if (!clusterTag) {
        return res.status(400).json({
          success: false,
          error: 'clusterTag is required'
        });
      }

      // 验证集群是否存在
      if (!this.clusterManager.clusterExists(clusterTag)) {
        return res.status(404).json({
          success: false,
          error: 'Cluster not found'
        });
      }

      console.log(`Switching to cluster: ${clusterTag}`);

      // 设置为活跃集群
      this.clusterManager.setActiveCluster(clusterTag);
      
      // 恢复该集群的配置到 CLI 目录
      this.clusterManager.restoreClusterConfig(clusterTag);
      
      // 切换kubectl配置到新集群
      await this.switchKubectlConfig(clusterTag);
      console.log(`Successfully switched kubectl config to cluster: ${clusterTag}`);
      
      try {
        // 同步执行kubectl配置切换，确保完成后再返回
        await this.switchKubectlConfig(clusterTag);
        console.log(`Successfully switched kubectl config to cluster: ${clusterTag}`);
        
        res.json({
          success: true,
          activeCluster: clusterTag,
          message: `Successfully switched to cluster: ${clusterTag}`
        });
      } catch (kubectlError) {
        console.error(`Failed to switch kubectl config for ${clusterTag}:`, kubectlError.message);
        
        // 即使kubectl切换失败，也返回成功，但包含警告信息
        res.json({
          success: true,
          activeCluster: clusterTag,
          message: `Switched to cluster: ${clusterTag}. Warning: kubectl config switch failed - ${kubectlError.message}`,
          kubectlWarning: kubectlError.message
        });
      }
      
    } catch (error) {
      console.error('Error switching cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 切换kubectl配置到指定集群
  async switchKubectlConfig(clusterTag) {
    try {
      // 读取集群配置获取AWS_REGION和EKS集群名称
      const configDir = this.clusterManager.getClusterConfigDir(clusterTag);
      const initEnvsPath = path.join(configDir, 'init_envs');
      
      if (!fs.existsSync(initEnvsPath)) {
        console.warn(`No init_envs found for cluster ${clusterTag}, skipping kubectl config switch`);
        return;
      }

      const envContent = fs.readFileSync(initEnvsPath, 'utf8');
      
      // 提取AWS_REGION和EKS集群名称
      const awsRegionMatch = envContent.match(/export AWS_REGION=(.+)/);
      const eksClusterMatch = envContent.match(/export EKS_CLUSTER_NAME=(.+)/);
      
      if (!awsRegionMatch || !eksClusterMatch) {
        console.warn(`Missing AWS_REGION or EKS_CLUSTER_NAME in ${clusterTag} config`);
        return;
      }

      const awsRegion = awsRegionMatch[1].replace(/['"]/g, '').trim();
      let eksClusterName = eksClusterMatch[1].replace(/['"]/g, '').trim();
      
      // 如果EKS集群名称包含变量，需要替换
      if (eksClusterName.includes('$CLUSTER_TAG')) {
        eksClusterName = eksClusterName.replace('$CLUSTER_TAG', clusterTag);
      }

      console.log(`Updating kubectl config for cluster: ${eksClusterName} in region: ${awsRegion}`);

      // 执行aws eks update-kubeconfig命令
      const command = `aws eks update-kubeconfig --region ${awsRegion} --name ${eksClusterName}`;
      
      return new Promise((resolve, reject) => {
        exec(command, { 
          timeout: 30000,
          env: { 
            ...process.env, 
            HOME: process.env.HOME || '/home/node',
            KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'
          }
        }, (error, stdout, stderr) => {
          if (error) {
            console.error(`Failed to update kubectl config: ${error.message}`);
            console.error(`Command: ${command}`);
            console.error(`Stderr: ${stderr}`);
            reject(error);
          } else {
            console.log(`Successfully updated kubectl config for cluster: ${eksClusterName}`);
            console.log(`Stdout: ${stdout}`);
            resolve(stdout);
          }
        });
      });

    } catch (error) {
      console.error(`Error in switchKubectlConfig: ${error.message}`);
      throw error;
    }
  }

  // 保存集群配置（支持多集群）
  async handleSaveConfig(req, res) {
    try {
      const config = req.body;
      console.log('Saving cluster configuration:', config);

      // 读取现有的 init_envs 文件内容
      const cliInitEnvs = path.join(this.clusterManager.cliDir, 'init_envs');
      let existingContent = '';
      
      if (fs.existsSync(cliInitEnvs)) {
        existingContent = fs.readFileSync(cliInitEnvs, 'utf8');
      }

      // 更新指定的环境变量，保留其他内容
      const envContent = this.updateEnvVariables(existingContent, config);

      // 提取集群标识
      const clusterTag = config.clusterTag;
      
      // 创建集群目录结构
      this.clusterManager.createClusterDirs(clusterTag);
      
      // 保存集群专用的 init_envs
      const clusterConfigDir = this.clusterManager.getClusterConfigDir(clusterTag);
      const clusterInitEnvs = path.join(clusterConfigDir, 'init_envs');
      await fs.writeFile(clusterInitEnvs, envContent);
      
      // 更新 CLI 目录的 init_envs (用于执行脚本) - 重用已声明的变量
      
      // 备份原文件
      if (fs.existsSync(cliInitEnvs)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${cliInitEnvs}.backup.${timestamp}`;
        await fs.copy(cliInitEnvs, backupPath);
        console.log(`Backed up original init_envs to: ${backupPath}`);
      }
      
      await fs.writeFile(cliInitEnvs, envContent);
      
      // 保存集群基本信息
      this.clusterManager.saveClusterInfo(clusterTag, config);
      
      // 设置为活跃集群
      this.clusterManager.setActiveCluster(clusterTag);
      
      // 清除该集群的状态缓存
      this.clusterManager.clearClusterCache(clusterTag);
      
      console.log(`Configuration saved for cluster: ${clusterTag}`);

      res.json({
        success: true,
        message: 'Configuration saved successfully',
        clusterTag,
        backupCreated: true
      });

    } catch (error) {
      console.error('Error saving cluster configuration:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 更新环境变量，保留用户自定义内容
  updateEnvVariables(existingContent, config) {
    // 只更新前端可配置的变量
    const updates = {
      'CLUSTER_TAG': config.clusterTag,
      'AWS_REGION': config.awsRegion,
      'GPU_CAPACITY_AZ': config.gpuCapacityAz,
      'GPU_INSTANCE_TYPE': config.gpuInstanceType,
      'GPU_INSTANCE_COUNT': config.gpuInstanceCount
    };

    // 处理FTP_NAME的特殊逻辑
    if (config.enableFtp && config.ftpName) {
      updates['FTP_NAME'] = config.ftpName;
    }

    let content = existingContent;

    // 更新每个可配置的变量
    for (const [key, value] of Object.entries(updates)) {
      const regex = new RegExp(`^(#\\s*)?export\\s+${key}=.*$`, 'm');
      const newLine = `export ${key}=${value}`;
      
      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        // 如果变量不存在，添加到文件开头
        content = `${newLine}\n${content}`;
      }
    }

    // 处理FTP_NAME禁用时的注释
    if (!config.enableFtp || !config.ftpName) {
      const ftpRegex = /^export\s+FTP_NAME=.*$/m;
      if (ftpRegex.test(content)) {
        content = content.replace(ftpRegex, '# export FTP_NAME=your-ftp-name');
      }
    }

    return content;
  }

  // 从 CLI 目录自动初始化多集群结构
  async autoInitializeFromCLI() {
    try {
      // 1. 检查 CLI 目录的 init_envs 文件
      const cliInitEnvs = path.join(this.clusterManager.cliDir, 'init_envs');
      
      if (!fs.existsSync(cliInitEnvs)) {
        return {
          success: false,
          error: 'No init_envs found in CLI directory. Please save configuration first.'
        };
      }

      // 2. 提取集群标识
      const envContent = await fs.readFile(cliInitEnvs, 'utf8');
      const clusterTagMatch = envContent.match(/export CLUSTER_TAG=(.+)/);
      
      if (!clusterTagMatch) {
        return {
          success: false,
          error: 'CLUSTER_TAG not found in init_envs. Please check configuration.'
        };
      }

      const clusterTag = clusterTagMatch[1].replace(/['"]/g, '').trim();
      console.log(`Auto-initializing multi-cluster structure for: ${clusterTag}`);

      // 3. 检查是否已经初始化
      const clusterExists = this.clusterManager.clusterExists(clusterTag);
      let initialized = false;

      if (!clusterExists) {
        // 4. 创建集群目录结构
        this.clusterManager.createClusterDirs(clusterTag);
        
        // 5. 复制配置文件到集群目录
        const clusterConfigDir = this.clusterManager.getClusterConfigDir(clusterTag);
        await fs.copy(cliInitEnvs, path.join(clusterConfigDir, 'init_envs'));
        
        // 6. 复制其他已存在的配置文件
        const filesToCopy = ['stack_envs', 'mlflow-server-info.json'];
        for (const file of filesToCopy) {
          const sourcePath = path.join(this.clusterManager.cliDir, file);
          const targetPath = path.join(clusterConfigDir, file);
          
          if (fs.existsSync(sourcePath)) {
            await fs.copy(sourcePath, targetPath);
            console.log(`Copied existing ${file} to cluster directory`);
          }
        }
        
        // 7. 生成集群信息 metadata
        const config = await this.extractConfigFromInitEnvs(envContent);
        this.clusterManager.saveClusterInfo(clusterTag, config);
        
        initialized = true;
        console.log(`Initialized multi-cluster structure for: ${clusterTag}`);
      }

      // 8. 设置为活跃集群
      this.clusterManager.setActiveCluster(clusterTag);

      return {
        success: true,
        clusterTag,
        initialized
      };

    } catch (error) {
      console.error('Error in autoInitializeFromCLI:', error);
      return {
        success: false,
        error: `Failed to initialize multi-cluster structure: ${error.message}`
      };
    }
  }

  // 从 init_envs 内容提取配置信息
  async extractConfigFromInitEnvs(envContent) {
    const extractValue = (key) => {
      const match = envContent.match(new RegExp(`export ${key}=(.+)`));
      return match ? match[1].replace(/['"]/g, '').trim() : '';
    };

    return {
      clusterTag: extractValue('CLUSTER_TAG'),
      awsRegion: extractValue('AWS_REGION'),
      ftpName: extractValue('FTP_NAME'),
      gpuCapacityAz: extractValue('GPU_CAPACITY_AZ'),
      gpuInstanceType: extractValue('GPU_INSTANCE_TYPE'),
      gpuInstanceCount: parseInt(extractValue('GPU_INSTANCE_COUNT')) || 1,
      enableFtp: !!extractValue('FTP_NAME') && extractValue('FTP_NAME') !== 'your-ftp-name'
    };
  }

  // 执行集群启动 (Step 1) - 支持多集群
  async handleLaunch(req, res) {
    try {
      // 1. 自动初始化多集群结构（从 ../cli/init_envs 提取信息）
      const initResult = await this.autoInitializeFromCLI();
      
      if (!initResult.success) {
        return res.status(400).json({
          success: false,
          error: initResult.error
        });
      }

      const activeCluster = initResult.clusterTag;
      console.log(`Launching cluster (Step 1) for: ${activeCluster}`);
      
      // 2. 检查 Step 1 是否已经完成（防重复创建）
      const MultiClusterStatus = require('./multi-cluster-status');
      const statusChecker = new MultiClusterStatus();
      const step1Status = await statusChecker.checkStep1Status(activeCluster);
      
      if (step1Status.status === 'completed') {
        return res.json({
          success: true,
          message: `Step 1 already completed for cluster: ${activeCluster}. CloudFormation stack exists.`,
          clusterTag: activeCluster,
          alreadyCompleted: true,
          statusDetails: step1Status
        });
      }
      
      // 3. 清除 Step 1 缓存
      this.clusterManager.clearClusterCache(activeCluster);
      
      // 4. 创建集群专用的日志管理器
      const logManager = new MultiClusterLogManager(activeCluster);
      const logFilePath = logManager.createLogFile('launch');
      
      // 5. 执行脚本
      const cliPath = this.clusterManager.cliDir;
      const command = `cd "${cliPath}" && nohup bash -c 'echo "y" | bash 1-cluster-launch.sh' > "${logFilePath}" 2>&1 &`;
      
      exec(command, (error) => {
        if (error) {
          console.error('Failed to start launch script:', error);
        } else {
          console.log('Launch script started successfully');
          
          // 5秒后开始监控并备份生成的文件
          setTimeout(() => {
            this.clusterManager.backupGeneratedFiles(activeCluster, 'step1');
          }, 5000);
        }
      });

      res.json({
        success: true,
        message: `Step 1 launched for cluster: ${activeCluster}`,
        clusterTag: activeCluster,
        initialized: initResult.initialized
      });

    } catch (error) {
      console.error('Error launching cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 执行集群配置 (Step 2) - 支持多集群
  async handleConfigure(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.status(400).json({
          success: false,
          error: 'No active cluster. Please save configuration first.'
        });
      }

      console.log(`Configuring cluster (Step 2) for: ${activeCluster}`);
      
      // 1. 检查 Step 1 是否已完成（Step 2 的前置条件）
      const MultiClusterStatus = require('./multi-cluster-status');
      const statusChecker = new MultiClusterStatus();
      const step1Status = await statusChecker.checkStep1Status(activeCluster);
      
      if (step1Status.status !== 'completed') {
        return res.status(400).json({
          success: false,
          error: `Step 1 must be completed before Step 2. Current Step 1 status: ${step1Status.status}`,
          step1Status: step1Status
        });
      }
      
      // 2. 检查 Step 2 是否已经完成（防重复配置）
      const step2Status = await statusChecker.checkStep2Status(activeCluster);
      
      if (step2Status.status === 'completed') {
        return res.json({
          success: true,
          message: `Step 2 already completed for cluster: ${activeCluster}. All Kubernetes components are ready.`,
          clusterTag: activeCluster,
          alreadyCompleted: true,
          statusDetails: step2Status
        });
      }
      
      // 3. 清除 Step 2 缓存
      this.clusterManager.clearClusterCache(activeCluster);
      
      // 4. 创建集群专用的日志管理器
      const logManager = new MultiClusterLogManager(activeCluster);
      const logFilePath = logManager.createLogFile('configure');
      
      // 5. 执行脚本
      const cliPath = this.clusterManager.cliDir;
      const command = `cd "${cliPath}" && nohup bash -c 'echo "y" | bash 2-cluster-configs.sh' > "${logFilePath}" 2>&1 &`;
      
      exec(command, (error) => {
        if (error) {
          console.error('Failed to start configure script:', error);
        } else {
          console.log('Configure script started successfully');
          
          // 30秒后开始监控并备份生成的文件（给MLflow查询足够时间）
          setTimeout(() => {
            this.clusterManager.backupGeneratedFiles(activeCluster, 'step2');
          }, 30000);
        }
      });

      res.json({
        success: true,
        message: `Step 2 launched for cluster: ${activeCluster}`,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error configuring cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 获取日志内容 - 支持多集群
  async handleGetLogs(req, res) {
    try {
      const { step } = req.params;
      const offset = parseInt(req.query.offset) || 0;
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          data: { content: '', offset: 0, exists: false },
          message: 'No active cluster'
        });
      }

      const logManager = new MultiClusterLogManager(activeCluster);
      const result = logManager.readLogContent(step, offset);
      
      res.json({
        success: true,
        data: result,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error getting logs:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 获取历史日志列表 - 支持多集群
  async handleGetLogsHistory(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          data: [],
          message: 'No active cluster'
        });
      }

      const logManager = new MultiClusterLogManager(activeCluster);
      const logFiles = logManager.getLogHistory();
      
      res.json({
        success: true,
        data: logFiles,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error getting log history:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 手动切换kubectl配置
  async handleSwitchKubectlConfig(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.status(400).json({
          success: false,
          error: 'No active cluster'
        });
      }

      console.log(`Manually switching kubectl config for cluster: ${activeCluster}`);
      
      await this.switchKubectlConfig(activeCluster);
      
      res.json({
        success: true,
        message: `Kubectl config updated for cluster: ${activeCluster}`,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error switching kubectl config:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 导入现有集群
  async handleImportCluster(req, res) {
    try {
      const { eksClusterName, awsRegion, hyperPodClusters } = req.body;
      
      if (!eksClusterName || !awsRegion) {
        return res.status(400).json({
          success: false,
          error: 'eksClusterName and awsRegion are required'
        });
      }

      console.log(`Importing existing cluster: ${eksClusterName} in ${awsRegion}`);
      if (hyperPodClusters) {
        console.log(`User specified HyperPod clusters: ${hyperPodClusters}`);
      }

      // 1. 验证集群存在
      const clusterExists = await this.verifyClusterExists(eksClusterName, awsRegion);
      if (!clusterExists.success) {
        return res.status(400).json({
          success: false,
          error: `Cluster verification failed: ${clusterExists.error}`
        });
      }

      // 2. 确保当前EC2 role有集群访问权限
      const accessResult = await this.ensureClusterAccess(eksClusterName, awsRegion);
      
      // 3. 创建集群目录结构
      this.clusterManager.createClusterDirs(eksClusterName);
      
      // 4. 生成导入配置（先保存配置文件）
      const importConfig = {
        CLUSTER_TYPE: 'imported',
        EKS_CLUSTER_NAME: eksClusterName,
        AWS_REGION: awsRegion,
        SKIP_CLUSTER_CREATION: 'true',
        SKIP_CLOUDFORMATION: 'true'
      };
      
      // 5. 先保存基础配置（不包含检测状态）
      const hasHyperPod = hyperPodClusters && hyperPodClusters.trim();
      await this.clusterManager.saveImportConfigBasic(eksClusterName, importConfig, accessResult, hasHyperPod);

      // 6. 更新kubectl配置（现在init_envs文件已存在）
      await this.switchKubectlConfig(eksClusterName);

      // 7. 检测集群实际状态（传递用户指定的HyperPod集群）
      const detectedState = await this.detectClusterState(eksClusterName, awsRegion, hyperPodClusters);
      
      // 8. 更新配置文件包含检测状态
      await this.clusterManager.updateImportConfigWithDetectedState(eksClusterName, detectedState);
      
      // 9. 获取并保存集群资源信息（与创建集群格式对齐）
      try {
        const MetadataUtils = require('./utils/metadataUtils');
        await MetadataUtils.saveImportedClusterResources(eksClusterName, eksClusterName, awsRegion, hyperPodClusters);
        console.log(`Successfully saved imported cluster resources for: ${eksClusterName}`);
      } catch (error) {
        console.warn(`Failed to save imported cluster resources: ${error.message}`);
        // 不阻断导入流程，但记录警告
      }
      
      // 10. 设置为活跃集群
      this.clusterManager.setActiveCluster(eksClusterName);

      // 11. 获取节点数量
      const nodeCount = await this.getNodeCount();
      
      res.json({
        success: true,
        message: `Successfully imported cluster: ${eksClusterName}`,
        clusterTag: eksClusterName,
        nodeCount,
        accessInfo: accessResult,
        detectedState: detectedState
      });

    } catch (error) {
      console.error('Error importing cluster:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 测试集群连接
  async handleTestConnection(req, res) {
    try {
      const { eksClusterName, awsRegion } = req.body;
      
      if (!eksClusterName || !awsRegion) {
        return res.status(400).json({
          success: false,
          error: 'eksClusterName and awsRegion are required'
        });
      }

      const result = await this.testConnection(eksClusterName, awsRegion);
      res.json(result);

    } catch (error) {
      console.error('Error testing connection:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 验证集群存在（不测试连接）
  async verifyClusterExists(eksClusterName, awsRegion) {
    return new Promise((resolve) => {
      exec(`aws eks describe-cluster --region ${awsRegion} --name ${eksClusterName}`, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            error: `EKS cluster not found or access denied: ${error.message}`
          });
        } else {
          resolve({
            success: true,
            message: `Cluster ${eksClusterName} exists and is accessible`
          });
        }
      });
    });
  }

  // 获取节点数量（在权限配置完成后）
  async getNodeCount() {
    return new Promise((resolve) => {
      exec('kubectl get nodes --no-headers | wc -l', (error, stdout) => {
        if (error) {
          console.warn('Failed to get node count:', error.message);
          resolve(0);
        } else {
          resolve(parseInt(stdout.trim()) || 0);
        }
      });
    });
  }

  // 检测集群实际状态
  async detectClusterState(eksClusterName, awsRegion, userSpecifiedHyperPodClusters = null) {
    console.log(`Detecting state for cluster: ${eksClusterName}`);
    
    const state = {
      dependencies: await this.detectDependencies(),
      hyperPodClusters: await this.detectHyperPodClusters(eksClusterName, awsRegion, userSpecifiedHyperPodClusters),
      nodeGroups: await this.detectNodeGroups(),
      detectedAt: new Date().toISOString()
    };
    
    console.log('Detected cluster state:', JSON.stringify(state, null, 2));
    return state;
  }

  // 检测依赖组件状态
  async detectDependencies() {
    const components = {
      helmDependencies: false,
      nlbController: false,
      s3CsiDriver: false,
      kuberayOperator: false,
      certManager: false
    };

    try {
      // 检测 AWS Load Balancer Controller
      const nlbResult = await this.execCommand('kubectl get deployment -n kube-system aws-load-balancer-controller --no-headers 2>/dev/null');
      components.nlbController = nlbResult.success && nlbResult.output.includes('aws-load-balancer-controller');

      // 检测 S3 CSI Driver
      const s3Result = await this.execCommand('kubectl get daemonset -n kube-system s3-csi-node --no-headers 2>/dev/null');
      components.s3CsiDriver = s3Result.success && s3Result.output.includes('s3-csi-node');

      // 检测 KubeRay Operator
      const kuberayResult = await this.execCommand('kubectl get deployment -n kuberay-operator kuberay-operator --no-headers 2>/dev/null');
      components.kuberayOperator = kuberayResult.success && kuberayResult.output.includes('kuberay-operator');

      // 检测 Cert Manager
      const certResult = await this.execCommand('kubectl get pods -n cert-manager --no-headers 2>/dev/null');
      components.certManager = certResult.success && certResult.output.includes('cert-manager');

      // 检测 Helm 相关组件 (简化检测)
      components.helmDependencies = components.nlbController && components.s3CsiDriver;

    } catch (error) {
      console.warn('Error detecting dependencies:', error.message);
    }

    const configured = Object.values(components).filter(Boolean).length >= 3; // 至少3个组件正常
    
    return {
      configured,
      status: configured ? 'success' : 'pending',
      components,
      lastDetected: new Date().toISOString()
    };
  }

  // 检测 HyperPod 集群 - 使用用户指定的集群名称
  async detectHyperPodClusters(eksClusterName, awsRegion, userSpecifiedCluster = null) {
    try {
      const relatedClusters = [];
      
      if (userSpecifiedCluster && userSpecifiedCluster.trim()) {
        // 使用用户指定的HyperPod集群名称（单个）
        const clusterName = userSpecifiedCluster.trim();
        console.log(`Using user-specified HyperPod cluster: ${clusterName}`);
        
        try {
          // 验证HyperPod集群是否存在
          const detailResult = await this.execCommand(`aws sagemaker describe-cluster --cluster-name ${clusterName} --region ${awsRegion} --output json 2>/dev/null`);
          if (detailResult.success) {
            const clusterDetail = JSON.parse(detailResult.output);
            relatedClusters.push({
              name: clusterDetail.ClusterName,
              arn: clusterDetail.ClusterArn,
              status: clusterDetail.ClusterStatus,
              creationTime: clusterDetail.CreationTime
            });
            console.log(`Found user-specified HyperPod cluster: ${clusterName}`);
          } else {
            console.warn(`User-specified HyperPod cluster not found: ${clusterName}`);
          }
        } catch (error) {
          console.warn(`Failed to verify HyperPod cluster ${clusterName}:`, error.message);
        }
      } else {
        // 如果用户没有指定，则不检测任何HyperPod集群
        console.log('No HyperPod cluster specified by user, skipping detection');
      }
      
      return relatedClusters;
    } catch (error) {
      console.warn('Error detecting HyperPod clusters:', error.message);
    }
    return [];
  }

  // 检测节点组
  async detectNodeGroups() {
    try {
      const result = await this.execCommand('kubectl get nodes -o json 2>/dev/null');
      if (result.success) {
        const nodes = JSON.parse(result.output);
        const nodeGroups = {};
        
        nodes.items?.forEach(node => {
          const nodeGroup = node.metadata?.labels?.['eks.amazonaws.com/nodegroup'] || 'unknown';
          const instanceType = node.metadata?.labels?.['node.kubernetes.io/instance-type'] || 'unknown';
          
          if (!nodeGroups[nodeGroup]) {
            nodeGroups[nodeGroup] = {
              name: nodeGroup,
              instanceType,
              nodeCount: 0,
              nodes: []
            };
          }
          nodeGroups[nodeGroup].nodeCount++;
          nodeGroups[nodeGroup].nodes.push(node.metadata.name);
        });
        
        return Object.values(nodeGroups);
      }
    } catch (error) {
      console.warn('Error detecting node groups:', error.message);
    }
    return [];
  }

  // 重新检测集群状态
  async handleRedetectClusterState(req, res) {
    try {
      const { clusterTag } = req.params;
      
      if (!clusterTag) {
        return res.status(400).json({
          success: false,
          error: 'clusterTag is required'
        });
      }

      console.log(`Re-detecting state for cluster: ${clusterTag}`);

      // 获取集群信息
      const clusterInfo = this.clusterManager.getClusterInfo(clusterTag);
      if (!clusterInfo) {
        return res.status(404).json({
          success: false,
          error: 'Cluster not found'
        });
      }

      // 切换到目标集群
      await this.switchKubectlConfig(clusterTag);

      // 重新检测状态
      const detectedState = await this.detectClusterState(clusterTag, clusterInfo.config?.awsRegion);
      
      // 更新集群信息
      await this.clusterManager.updateClusterDetectedState(clusterTag, detectedState);
      
      res.json({
        success: true,
        message: `Successfully re-detected state for cluster: ${clusterTag}`,
        detectedState: detectedState
      });

    } catch (error) {
      console.error('Error re-detecting cluster state:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // 执行命令的辅助方法
  async execCommand(command) {
    return new Promise((resolve) => {
      exec(command, (error, stdout, stderr) => {
        resolve({
          success: !error,
          output: stdout.trim(),
          error: error?.message || stderr
        });
      });
    });
  }
  async ensureClusterAccess(eksClusterName, awsRegion) {
    try {
      // 1. 获取当前EC2的IAM role
      const identity = await this.getCurrentIdentity();
      const roleArn = this.extractRoleArn(identity.Arn);
      
      console.log(`Current EC2 role: ${roleArn}`);
      
      // 2. 检查是否已有access entry
      const hasAccess = await this.checkExistingAccess(eksClusterName, roleArn, awsRegion);
      
      if (hasAccess.exists) {
        console.log(`Access entry already exists for role: ${roleArn}`);
        return {
          action: 'existing',
          message: 'Role already has cluster access',
          roleArn,
          policies: hasAccess.policies
        };
      }
      
      // 3. 创建access entry
      await this.createAccessEntry(eksClusterName, roleArn, awsRegion);
      
      // 4. 关联cluster admin policy
      await this.associateClusterAdminPolicy(eksClusterName, roleArn, awsRegion);
      
      console.log(`Successfully granted cluster admin access to role: ${roleArn}`);
      
      return {
        action: 'created',
        message: 'Successfully granted cluster admin access',
        roleArn,
        policies: ['AmazonEKSClusterAdminPolicy']
      };
      
    } catch (error) {
      console.warn(`Failed to ensure cluster access: ${error.message}`);
      return {
        action: 'failed',
        message: `Access management failed: ${error.message}`,
        warning: 'Cluster import will continue, but you may need to manually add access permissions'
      };
    }
  }

  // 获取当前身份
  async getCurrentIdentity() {
    return new Promise((resolve, reject) => {
      exec('aws sts get-caller-identity', (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to get caller identity: ${error.message}`));
        } else {
          resolve(JSON.parse(stdout));
        }
      });
    });
  }

  // 从assumed role ARN中提取role ARN
  extractRoleArn(assumedRoleArn) {
    // 从 arn:aws:sts::account:assumed-role/role-name/session 
    // 提取为 arn:aws:iam::account:role/role-name
    const match = assumedRoleArn.match(/arn:aws:sts::(\d+):assumed-role\/([^\/]+)\//);
    if (match) {
      return `arn:aws:iam::${match[1]}:role/${match[2]}`;
    }
    throw new Error(`Invalid assumed role ARN format: ${assumedRoleArn}`);
  }

  // 检查现有访问权限
  async checkExistingAccess(eksClusterName, roleArn, awsRegion) {
    try {
      // 检查access entry是否存在
      const result = await new Promise((resolve, reject) => {
        exec(`aws eks describe-access-entry --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --region ${awsRegion}`, 
          (error, stdout) => {
            if (error) {
              if (error.message.includes('ResourceNotFoundException')) {
                resolve({ exists: false });
              } else {
                reject(error);
              }
            } else {
              resolve({ exists: true, entry: JSON.parse(stdout) });
            }
          });
      });

      if (!result.exists) {
        return { exists: false };
      }

      // 获取关联的policies
      const policies = await new Promise((resolve, reject) => {
        exec(`aws eks list-associated-access-policies --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --region ${awsRegion}`, 
          (error, stdout) => {
            if (error) {
              resolve([]);
            } else {
              const data = JSON.parse(stdout);
              resolve(data.associatedAccessPolicies || []);
            }
          });
      });

      return { 
        exists: true, 
        policies: policies.map(p => p.policyArn.split('/').pop()) 
      };

    } catch (error) {
      console.warn(`Error checking existing access: ${error.message}`);
      return { exists: false };
    }
  }

  // 创建access entry
  async createAccessEntry(eksClusterName, roleArn, awsRegion) {
    return new Promise((resolve, reject) => {
      const command = `aws eks create-access-entry --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --region ${awsRegion}`;
      exec(command, (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to create access entry: ${error.message}`));
        } else {
          console.log(`Created access entry for role: ${roleArn}`);
          resolve(JSON.parse(stdout));
        }
      });
    });
  }

  // 关联cluster admin policy
  async associateClusterAdminPolicy(eksClusterName, roleArn, awsRegion) {
    return new Promise((resolve, reject) => {
      const policyArn = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy';
      const command = `aws eks associate-access-policy --cluster-name ${eksClusterName} --principal-arn "${roleArn}" --policy-arn ${policyArn} --access-scope type=cluster --region ${awsRegion}`;
      
      exec(command, (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to associate cluster admin policy: ${error.message}`));
        } else {
          console.log(`Associated cluster admin policy for role: ${roleArn}`);
          resolve(JSON.parse(stdout));
        }
      });
    });
  }
  async testConnection(eksClusterName, awsRegion) {
    return new Promise((resolve) => {
      // 1. 测试EKS集群是否存在
      exec(`aws eks describe-cluster --region ${awsRegion} --name ${eksClusterName}`, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            error: `EKS cluster not found or access denied: ${error.message}`
          });
          return;
        }

        // 2. 保存当前kubectl配置
        exec('kubectl config current-context', (contextError, currentContext) => {
          const originalContext = currentContext ? currentContext.trim() : null;
          
          // 3. 临时更新kubectl配置进行测试
          exec(`aws eks update-kubeconfig --region ${awsRegion} --name ${eksClusterName}`, {
            env: { 
              ...process.env, 
              HOME: process.env.HOME || '/home/node',
              KUBECONFIG: process.env.KUBECONFIG || '/home/node/.kube/config'
            }
          }, (kubectlError) => {
            if (kubectlError) {
              resolve({
                success: false,
                error: `Failed to update kubectl config: ${kubectlError.message}`
              });
              return;
            }

            // 4. 测试kubectl连接
            exec('kubectl get nodes --no-headers | wc -l', (nodeError, nodeStdout) => {
              const nodeCount = nodeError ? 0 : parseInt(nodeStdout.trim()) || 0;
              
              // 5. 恢复原来的kubectl配置（如果有的话）
              if (originalContext && originalContext !== 'error') {
                exec(`kubectl config use-context ${originalContext}`, (restoreError) => {
                  if (restoreError) {
                    console.warn('Failed to restore original kubectl context:', restoreError.message);
                  }
                });
              }

              if (nodeError) {
                resolve({
                  success: false,
                  error: `Failed to connect to cluster: ${nodeError.message}`
                });
              } else {
                resolve({
                  success: true,
                  nodeCount,
                  message: `Successfully connected to cluster with ${nodeCount} nodes`,
                  warning: originalContext ? 'Kubectl context restored to original' : 'No original context to restore'
                });
              }
            });
          });
        });
      });
    });
  }

  // 清除状态缓存 - 支持多集群
  async handleClearStatusCache(req, res) {
    try {
      const activeCluster = this.clusterManager.getActiveCluster();
      
      if (!activeCluster) {
        return res.json({
          success: true,
          message: 'No active cluster'
        });
      }

      this.clusterManager.clearClusterCache(activeCluster);
      
      res.json({
        success: true,
        message: `Status cache cleared for cluster: ${activeCluster}`,
        clusterTag: activeCluster
      });

    } catch (error) {
      console.error('Error clearing status cache:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

module.exports = MultiClusterAPIs;
