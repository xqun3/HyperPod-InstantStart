const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class KedaManager {
  static generatePrometheusConfigMap(config) {
    const targets = config.prometheusTargets || ['sglang-router-service.default.svc.cluster.local:29000'];
    const scrapeInterval = config.scrapeInterval || '10s';

    return `---
# Prometheus ConfigMap for scraping SGLang Router metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-server
  namespace: ${config.prometheusNamespace || 'monitoring'}
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    scrape_configs:
      - job_name: 'sglang-router'
        static_configs:
          - targets: ${JSON.stringify(targets)}
        scrape_interval: ${scrapeInterval}
        metrics_path: /metrics`;
  }

  static generateScaledObjectYaml(config) {
    const {
      // Basic ScaledObject Configuration
      scaledObjectName = 'sglang-worker-scaler',
      namespace = 'default',
      targetDeployment,

      // Scaling Configuration
      minReplicaCount = 1,
      maxReplicaCount = 10,
      pollingInterval = 5,
      cooldownPeriod = 300,

      // Prometheus Configuration
      prometheusServer = 'http://prometheus-server.monitoring.svc.cluster.local:80',
      prometheusQuery,
      threshold = '2',
      activationThreshold = '1'
    } = config;

    // Generate default Prometheus query if not provided
    const defaultQuery = prometheusQuery || `(
  rate(sgl_router_requests_total[1m]) /
  kube_deployment_status_replicas{deployment="${targetDeployment}"}
)`;

    return `---
# KEDA ScaledObject for SGLang Workers
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ${scaledObjectName}
  namespace: ${namespace}
spec:
  scaleTargetRef:
    name: ${targetDeployment}
  minReplicaCount: ${minReplicaCount}
  maxReplicaCount: ${maxReplicaCount}
  pollingInterval: ${pollingInterval}
  cooldownPeriod: ${cooldownPeriod}
  triggers:
  - type: prometheus
    metadata:
      serverAddress: ${prometheusServer}
      query: |${defaultQuery.split('\n').map(line => '        ' + line).join('\n')}
      threshold: '${threshold}'
      activationThreshold: '${activationThreshold}'`;
  }

  static generateFullKedaYaml(config) {
    const prometheusConfigMap = this.generatePrometheusConfigMap(config);
    const scaledObject = this.generateScaledObjectYaml(config);

    return `${prometheusConfigMap}

${scaledObject}`;
  }

  static async applyKedaConfiguration(config) {
    try {
      const fullYaml = this.generateFullKedaYaml(config);

      // Save to temporary file
      const tempDir = path.join(__dirname, '../../tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tempFilePath = path.join(tempDir, `keda-config-${timestamp}.yaml`);

      fs.writeFileSync(tempFilePath, fullYaml);
      console.log(`KEDA configuration saved to: ${tempFilePath}`);

      // Apply to Kubernetes
      const applyCommand = `kubectl apply -f ${tempFilePath}`;
      const result = execSync(applyCommand, { encoding: 'utf8' });

      return {
        success: true,
        message: 'KEDA configuration applied successfully',
        yamlPath: tempFilePath,
        kubectlOutput: result,
        generatedYaml: fullYaml
      };

    } catch (error) {
      console.error('Error applying KEDA configuration:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to apply KEDA configuration'
      };
    }
  }

  static async getKedaStatus() {
    try {
      // Check if KEDA operator is installed
      const kedaStatusCommand = 'kubectl get deployment keda-operator -n keda-system';
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

  static getDefaultConfig() {
    return {
      // ScaledObject Configuration
      scaledObjectName: 'sglang-worker-scaler',
      namespace: 'default',
      targetDeployment: '',

      // Scaling Configuration
      minReplicaCount: 1,
      maxReplicaCount: 10,
      pollingInterval: 5,
      cooldownPeriod: 300,

      // Prometheus Configuration
      prometheusServer: 'http://prometheus-server.monitoring.svc.cluster.local:80',
      threshold: '2',
      activationThreshold: '1',

      // Prometheus ConfigMap Configuration
      prometheusNamespace: 'monitoring',
      prometheusTargets: ['sglang-router-service.default.svc.cluster.local:29000'],
      scrapeInterval: '10s'
    };
  }
}

module.exports = KedaManager;