const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class KedaManager {



  static async getKedaStatus() {
    try {
      // Check if KEDA operator is installed
      const kedaStatusCommand = 'kubectl get deployment keda-operator -n keda';
      const kedaStatus = execSync(kedaStatusCommand, { encoding: 'utf8' });

      // Get ScaledObjects
      const scaledObjectsCommand = 'kubectl get scaledobjects -o json';
      const scaledObjectsResult = execSync(scaledObjectsCommand, { encoding: 'utf8' });
      const scaledObjects = JSON.parse(scaledObjectsResult);

      return {
        success: true,
        kedaInstalled: true,
        kedaOperatorStatus: kedaStatus,
        scaledObjects: scaledObjects.items || []
      };

    } catch (error) {
      console.error('Error getting KEDA status:', error);
      return {
        success: false,
        kedaInstalled: false,
        error: error.message
      };
    }
  }

  static async deleteScaledObject(name, namespace = 'default') {
    try {
      const deleteCommand = `kubectl delete scaledobject ${name} -n ${namespace}`;
      const result = execSync(deleteCommand, { encoding: 'utf8' });

      return {
        success: true,
        message: `ScaledObject ${name} deleted successfully`,
        kubectlOutput: result
      };

    } catch (error) {
      console.error('Error deleting ScaledObject:', error);
      return {
        success: false,
        error: error.message,
        message: `Failed to delete ScaledObject ${name}`
      };
    }
  }

  static validateConfig(config) {
    const errors = [];

    if (!config.targetDeployment) {
      errors.push('Target deployment name is required');
    }

    if (config.minReplicaCount && config.maxReplicaCount &&
        config.minReplicaCount > config.maxReplicaCount) {
      errors.push('Minimum replica count cannot be greater than maximum replica count');
    }

    if (config.threshold && isNaN(parseFloat(config.threshold))) {
      errors.push('Threshold must be a valid number');
    }

    if (config.activationThreshold && isNaN(parseFloat(config.activationThreshold))) {
      errors.push('Activation threshold must be a valid number');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }


  /**
   * 获取统一扩缩容YAML模板
   * @returns {string} YAML模板字符串
   */
  static getUnifiedScalingTemplate() {
    // 使用 ${}$ 格式避免与JavaScript模板字符串冲突
    return `---
# Prometheus ConfigMap for scraping SGLang Router metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-server
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 1m
      evaluation_interval: 1m

    scrape_configs:
      - job_name: '\${ServiceName}$-prom-job'
        static_configs:
          - targets: ['\${ServiceName}$.default.svc.cluster.local:\${RouterMetricPort}$']
        scrape_interval: \${ScrapeInterval}$s
        metrics_path: /metrics

      - job_name: 'kube-state-metrics'
        static_configs:
          - targets: ['prometheus-kube-state-metrics.monitoring.svc.cluster.local:8080']
        scrape_interval: \${ScrapeInterval}$s

---
# KEDA ScaledObject for SGLang Workers
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sglang-router-scaler
  namespace: default
spec:
  scaleTargetRef:
    name: \${DeploymentName}$
  minReplicaCount: \${MinReplica}$
  maxReplicaCount: \${MaxReplica}$
  pollingInterval: \${KedaPollInterval}$
  cooldownPeriod: \${KedaCoolDownPeriod}$
  triggers:
  # Trigger 1
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-server.monitoring.svc.cluster.local:80
      # QPS per pod - divides total QPS by current number of replicas
      query: |
        (
          rate(sgl_router_requests_total{job="\${ServiceName}$-prom-job"}[1m]) /
          scalar(kube_deployment_status_replicas{deployment="\${DeploymentName}$"})
        )
      threshold: '\${KedaTrig1ValueThreshold}$'
      activationThreshold: '\${KedaTrig1ActThreshold}$'  # Activate when any pod has >1 QPS

  # Trigger 2
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-server.monitoring.svc.cluster.local:80
      query: sgl_router_job_queue_depth{job="\${ServiceName}$-prom-job"}
      threshold: '\${KedaTrig2ValueThreshold}$'
      activationThreshold: '\${KedaTrig2ActThreshold}$'


`;
  }

  /**
   * 生成统一扩缩容YAML（使用内嵌模板）
   * @param {Object} config - 配置对象
   * @returns {string} 完整的YAML内容
   */
  static generateUnifiedScalingYaml(config) {
    try {
      // 使用内嵌模板
      let template = this.getUnifiedScalingTemplate();

      // 基础变量替换 (使用新的 ${...}$ 格式)
      template = template.replace(/\$\{ServiceName\}\$/g, config.serviceName);
      template = template.replace(/\$\{RouterMetricPort\}\$/g, config.routerMetricPort);
      template = template.replace(/\$\{DeploymentName\}\$/g, config.deploymentName);
      template = template.replace(/\$\{MinReplica\}\$/g, config.minReplica);
      template = template.replace(/\$\{MaxReplica\}\$/g, config.maxReplica);
      template = template.replace(/\$\{KedaPollInterval\}\$/g, config.kedaPollInterval);
      template = template.replace(/\$\{KedaCoolDownPeriod\}\$/g, config.kedaCoolDownPeriod);
      template = template.replace(/\$\{ScrapeInterval\}\$/g, config.scrapeInterval);

      // Trigger 配置处理
      let finalYaml = template;

      // 处理 QPS Window 替换（在 query 中的 [1m] 部分）
      if (config.enabledTriggers?.includes('qps') && config.qpsWindow) {
        finalYaml = finalYaml.replace(/\[1m\]/g, `[${config.qpsWindow}]`);
      }

      // 处理 Trigger 1 (QPS per Worker)
      if (config.enabledTriggers?.includes('qps')) {
        finalYaml = finalYaml.replace(/\$\{KedaTrig1ValueThreshold\}\$/g, config.kedaTrig1ValueThreshold);
        finalYaml = finalYaml.replace(/\$\{KedaTrig1ActThreshold\}\$/g, config.kedaTrig1ActThreshold);
      } else {
        // 如果没有启用 QPS trigger，移除相关的 trigger 1 配置
        finalYaml = finalYaml.replace(/  # Trigger 1[\s\S]*?activationThreshold: '\$\{KedaTrig1ActThreshold\}\$'\s*\n/, '');
      }

      // 处理 Trigger 2 (Queue Depth)
      if (config.enabledTriggers?.includes('queue')) {
        finalYaml = finalYaml.replace(/\$\{KedaTrig2ValueThreshold\}\$/g, config.kedaTrig2ValueThreshold);
        finalYaml = finalYaml.replace(/\$\{KedaTrig2ActThreshold\}\$/g, config.kedaTrig2ActThreshold);
      } else {
        // 如果没有启用 Queue trigger，移除相关的 trigger 2 配置
        finalYaml = finalYaml.replace(/  # Trigger 2[\s\S]*?activationThreshold: '\$\{KedaTrig2ActThreshold\}\$'\s*\n?/, '');
      }

      return finalYaml;

    } catch (error) {
      console.error('Error generating unified scaling YAML:', error);
      throw new Error(`Template processing failed: ${error.message}`);
    }
  }

  /**
   * 应用统一扩缩容配置
   * @param {Object} config - 配置对象
   * @returns {Object} 部署结果
   */
  static async applyUnifiedScalingConfiguration(config) {
    try {
      // 验证配置
      const validation = this.validateUnifiedConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors
        };
      }

      const fullYaml = this.generateUnifiedScalingYaml(config);

      // 保存到 deployments/inference 目录，与其他推理组件保持一致
      const deploymentDir = path.join(__dirname, '../../deployments/inference');
      if (!fs.existsSync(deploymentDir)) {
        fs.mkdirSync(deploymentDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
      const configFilePath = path.join(deploymentDir, `keda-scaling-${config.serviceName}-${timestamp}.yaml`);

      fs.writeFileSync(configFilePath, fullYaml);
      console.log(`Unified KEDA configuration saved to: ${configFilePath}`);

      // 应用到 Kubernetes
      const applyCommand = `kubectl apply -f ${configFilePath}`;
      const result = execSync(applyCommand, { encoding: 'utf8' });

      // 异步触发 Prometheus server rollout status 检查
      setImmediate(() => {
        try {
          console.log('Checking Prometheus server rollout status...');
          const rolloutCommand = 'kubectl rollout status deployment prometheus-server -n monitoring';
          require('child_process').exec(rolloutCommand, (error, stdout, stderr) => {
            if (error) {
              console.warn('Prometheus rollout status check failed:', error.message);
            } else {
              console.log('Prometheus rollout status:', stdout);
            }
          });
        } catch (rolloutError) {
          console.warn('Error triggering Prometheus rollout status check:', rolloutError.message);
        }
      });

      return {
        success: true,
        message: 'Unified KEDA configuration applied successfully',
        yamlPath: configFilePath,
        kubectlOutput: result,
        generatedYaml: fullYaml
      };

    } catch (error) {
      console.error('Error applying unified KEDA configuration:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to apply unified KEDA configuration'
      };
    }
  }

  /**
   * 验证统一扩缩容配置
   * @param {Object} config - 配置对象
   * @returns {Object} 验证结果
   */
  static validateUnifiedConfig(config) {
    const errors = [];

    if (!config.serviceName) {
      errors.push('Service name is required');
    }

    if (!config.deploymentName) {
      errors.push('Deployment name is required');
    }

    if (!config.routerMetricPort) {
      errors.push('Router metric port is required');
    }

    if (!config.enabledTriggers || config.enabledTriggers.length === 0) {
      errors.push('At least one trigger must be enabled');
    }

    if (config.enabledTriggers?.includes('qps')) {
      if (!config.kedaTrig1ValueThreshold) {
        errors.push('QPS trigger value threshold is required');
      }
      if (!config.kedaTrig1ActThreshold) {
        errors.push('QPS trigger activation threshold is required');
      }
      if (!config.qpsWindow) {
        errors.push('QPS window length is required');
      }
    }

    if (config.enabledTriggers?.includes('queue')) {
      if (!config.kedaTrig2ValueThreshold) {
        errors.push('Queue trigger value threshold is required');
      }
      if (!config.kedaTrig2ActThreshold) {
        errors.push('Queue trigger activation threshold is required');
      }
    }

    if (config.minReplica && config.maxReplica && config.minReplica > config.maxReplica) {
      errors.push('Minimum replica count cannot be greater than maximum replica count');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 预览统一扩缩容YAML
   * @param {Object} config - 配置对象
   * @returns {Object} 预览结果
   */
  static async previewUnifiedScalingYaml(config) {
    try {
      const validation = this.validateUnifiedConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors
        };
      }

      const yaml = this.generateUnifiedScalingYaml(config);

      return {
        success: true,
        yaml: yaml,
        config: config
      };
    } catch (error) {
      console.error('Error generating preview:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = KedaManager;