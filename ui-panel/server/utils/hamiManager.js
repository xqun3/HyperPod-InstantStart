const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class HAMiManager {
  /**
   * 写入日志到文件
   */
  static writeLog(message) {
    const logDir = path.join(__dirname, '../../tmp');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'hami-install.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
    console.log(message);
  }

  /**
   * 获取 Kubernetes 版本
   */
  static getKubeVersion() {
    try {
      const cmd = `kubectl version -o json | jq -r '.serverVersion.gitVersion' | cut -d'-' -f1`;
      return execSync(cmd, { encoding: 'utf8' }).trim();
    } catch (error) {
      this.writeLog(`Failed to get kube version: ${error.message}`);
      throw error;
    }
  }

  /**
   * 重启 S3 CSI controller（确保与 HAMi 兼容）
   */
  static restartS3CsiController() {
    try {
      this.writeLog('Restarting S3 CSI controller for HAMi compatibility...');
      const cmd = `kubectl delete pod -n kube-system -l app=s3-csi-controller`;
      execSync(cmd, { encoding: 'utf8' });
      this.writeLog('S3 CSI controller restarted successfully');
      return { success: true };
    } catch (error) {
      this.writeLog(`Warning: Failed to restart S3 CSI controller: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 安装/更新 HAMi
   */
  static async installHAMi(config) {
    const { splitCount, nodePolicy, gpuPolicy, nodeName } = config;
    
    this.writeLog('='.repeat(80));
    this.writeLog('Starting HAMi installation');
    this.writeLog(`Config: ${JSON.stringify(config, null, 2)}`);
    
    const kubeVersion = this.getKubeVersion();
    this.writeLog(`Kubernetes version: ${kubeVersion}`);

    // 步骤1: 给指定节点打标签
    if (nodeName) {
      this.writeLog(`Step 1: Labeling node ${nodeName}...`);
      try {
        const labelCmd = `kubectl label nodes ${nodeName} gpu=on --overwrite`;
        this.writeLog(`Executing: ${labelCmd}`);
        const result = execSync(labelCmd, { encoding: 'utf8' });
        this.writeLog(`Label command output: ${result}`);
        this.writeLog(`Successfully labeled node: ${nodeName}`);
      } catch (error) {
        this.writeLog(`ERROR: Failed to label node ${nodeName}: ${error.message}`);
        throw new Error(`Failed to label node: ${error.message}`);
      }
    } else {
      this.writeLog('WARNING: nodeName is not provided, skipping node labeling');
    }

    // 步骤2: 添加 Helm repo（幂等）
    this.writeLog('Step 2: Adding Helm repository...');
    try {
      execSync('helm repo add hami-charts https://project-hami.github.io/HAMi/', { encoding: 'utf8' });
      execSync('helm repo update', { encoding: 'utf8' });
      this.writeLog('Helm repo added/updated successfully');
    } catch (error) {
      this.writeLog(`Helm repo operation: ${error.message}`);
    }

    // 步骤3: 安装/升级 HAMi
    this.writeLog('Step 3: Installing HAMi via Helm...');
    const helmCmd = `helm upgrade --install hami hami-charts/hami --set scheduler.kubeScheduler.imageTag=${kubeVersion} --set devicePlugin.deviceSplitCount=${splitCount} --set scheduler.defaultSchedulerPolicy.nodeSchedulerPolicy=${nodePolicy} --set scheduler.defaultSchedulerPolicy.gpuSchedulerPolicy=${gpuPolicy} --set scheduler.kubeScheduler.image.registry=registry.k8s.io --set scheduler.kubeScheduler.image.repository=kube-scheduler --set devicePlugin.image.registry=docker.io --set devicePlugin.image.repository=projecthami/hami -n kube-system --create-namespace --wait`;

    this.writeLog('Executing HAMi installation...');
    const result = execSync(helmCmd, { encoding: 'utf8', timeout: 300000 });
    this.writeLog(`Helm output: ${result}`);
    this.writeLog('HAMi installation completed successfully');
    
    // 步骤4: 重启 S3 CSI controller
    this.writeLog('Step 4: Restarting S3 CSI controller...');
    this.restartS3CsiController();
    
    this.writeLog('='.repeat(80));

    return {
      success: true,
      message: 'HAMi installed successfully',
      output: result
    };
  }

  /**
   * 检查 HAMi 状态
   */
  static checkStatus() {
    try {
      const cmd = `kubectl get pods -n kube-system -l app=hami -o json`;
      const result = execSync(cmd, { encoding: 'utf8' });
      const pods = JSON.parse(result);
      
      return {
        installed: pods.items && pods.items.length > 0,
        pods: pods.items || []
      };
    } catch (error) {
      return { installed: false, pods: [] };
    }
  }

  /**
   * 保存配置到 metadata
   */
  static saveConfig(clusterTag, config, clusterManager) {
    try {
      const metadataDir = clusterManager.getClusterMetadataDir(clusterTag);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');

      if (fs.existsSync(clusterInfoPath)) {
        const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
        
        clusterInfo.hami = {
          installed: true,
          config: config,
          lastUpdated: new Date().toISOString()
        };

        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInfo, null, 2));
        console.log(`HAMi config saved to metadata for cluster: ${clusterTag}`);
      }
    } catch (error) {
      console.error('Failed to save HAMi config to metadata:', error);
    }
  }

  /**
   * 重置节点的 HAMi 配置
   */
  static async resetNodeHAMi(nodeName) {
    this.writeLog('='.repeat(80));
    this.writeLog(`Resetting HAMi for node: ${nodeName}`);
    
    try {
      // 步骤1: 删除 gpu=on 标签
      this.writeLog('Step 1: Removing gpu=on label...');
      try {
        const result = execSync(`kubectl label nodes ${nodeName} gpu- 2>&1`, { encoding: 'utf8' });
        this.writeLog(`Label removal output: ${result}`);
        this.writeLog('Label removed successfully');
      } catch (error) {
        this.writeLog('Label not found or already removed');
      }

      // 步骤2: 删除该节点上的 nvidia device plugin pods
      this.writeLog('Step 2: Deleting nvidia device plugin pods...');
      
      // 获取该节点上的 nvidia device plugin pods
      const getPodsCmd = `kubectl get pods -n kube-system -o json --field-selector spec.nodeName=${nodeName}`;
      const podsResult = execSync(getPodsCmd, { encoding: 'utf8' });
      const pods = JSON.parse(podsResult);
      
      const podsToDelete = [];
      for (const pod of pods.items) {
        const podName = pod.metadata.name;
        // 匹配 hyperpod-dependencies-nvidia-device-plugin-* 或 nvidia-device-plugin-daemonset-*
        if (podName.includes('nvidia-device-plugin')) {
          podsToDelete.push(podName);
        }
      }

      if (podsToDelete.length > 0) {
        this.writeLog(`Found ${podsToDelete.length} nvidia device plugin pods to delete`);
        for (const podName of podsToDelete) {
          try {
            execSync(`kubectl delete pod ${podName} -n kube-system`, { encoding: 'utf8' });
            this.writeLog(`Deleted pod: ${podName}`);
          } catch (error) {
            this.writeLog(`Failed to delete pod ${podName}: ${error.message}`);
          }
        }
      } else {
        this.writeLog('No nvidia device plugin pods found on this node');
      }

      this.writeLog(`Node ${nodeName} reset completed successfully`);
      
      // 重启 S3 CSI controller
      this.writeLog('Restarting S3 CSI controller after reset...');
      this.restartS3CsiController();
      
      this.writeLog('='.repeat(80));

      return {
        success: true,
        message: `Node ${nodeName} reset successfully`,
        deletedPods: podsToDelete
      };
    } catch (error) {
      this.writeLog(`ERROR: Failed to reset node: ${error.message}`);
      this.writeLog('='.repeat(80));
      throw new Error(`Failed to reset node: ${error.message}`);
    }
  }
}

module.exports = HAMiManager;
