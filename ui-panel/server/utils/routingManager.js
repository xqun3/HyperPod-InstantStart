const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class RoutingManager {
  static generateRouterYaml(config) {
    const {
      deploymentName = 'sglang-router',
      routingPolicy = 'cache_aware',
      routerPort = 30000,
      metricsPort = 29000,
      serviceType = 'external'
    } = config;

    // Generate timestamp for unique naming
    const timestamp = Date.now();
    const resourceName = `${deploymentName}-${timestamp}`;

    // Determine Service type
    const k8sServiceType = serviceType === 'external' ? 'LoadBalancer' : 'ClusterIP';

    return `---
# ServiceAccount for Router
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${resourceName}
  namespace: default

---
# ClusterRole for Pod discovery
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${resourceName}
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]

---
# ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${resourceName}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${resourceName}
subjects:
- kind: ServiceAccount
  name: ${resourceName}
  namespace: default

---
# Router Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${resourceName}
  labels:
    app: ${resourceName}
    deployment-name: "${deploymentName}"
    model-type: "sglang-router"
    service-type: "router"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${resourceName}
  template:
    metadata:
      labels:
        app: ${resourceName}
        deployment-name: "${deploymentName}"
        model-type: "sglang-router"
        service-type: "router"
    spec:
      serviceAccountName: ${resourceName}
      containers:
        - name: sglang-router
          image: lmsysorg/sglang:latest
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
            limits:
              cpu: "4"
              memory: 8Gi
          command: ["python3", "-m", "sglang_router.launch_router"]
          args:
            - "--service-discovery"
            - "--selector"
            - "deployment-name=${deploymentName}"
            - "--service-discovery-port"
            - "8000"
            - "--policy"
            - "${routingPolicy}"
            - "--host"
            - "0.0.0.0"
            - "--port"
            - "${routerPort}"
            - "--prometheus-port"
            - "${metricsPort}"
          ports:
            - containerPort: ${routerPort}
              name: http
            - containerPort: ${metricsPort}
              name: metrics
          env:
            - name: RUST_LOG
              value: "info"

---
# Router Service
apiVersion: v1
kind: Service
metadata:
  name: ${resourceName}-service
  labels:
    app: ${resourceName}
    deployment-name: "${deploymentName}"
    model-type: "sglang-router"
    service-type: "router"
spec:
  type: ${k8sServiceType}
  selector:
    app: ${resourceName}
  ports:
  - name: http
    port: ${routerPort}
    targetPort: ${routerPort}
    protocol: TCP
  - name: metrics
    port: ${metricsPort}
    targetPort: ${metricsPort}
    protocol: TCP`;
  }

  static async applyRouterConfiguration(config) {
    try {
      const yaml = this.generateRouterYaml(config);

      // Create deployments/inference directory if it doesn't exist
      const deploymentDir = path.join(__dirname, '../../deployments/inference');
      if (!fs.existsSync(deploymentDir)) {
        fs.mkdirSync(deploymentDir, { recursive: true });
      }

      // Save YAML file with timestamp
      const timestamp = new Date().toISOString().replace(/[-:.T]/g, '').slice(0, 14);
      const yamlPath = path.join(deploymentDir, `sglang-router-${timestamp}.yaml`);

      fs.writeFileSync(yamlPath, yaml);
      console.log(`SGLang Router YAML saved to: ${yamlPath}`);

      // Apply to Kubernetes
      const applyCommand = `kubectl apply -f ${yamlPath}`;
      const result = execSync(applyCommand, { encoding: 'utf8' });

      return {
        success: true,
        message: 'SGLang Router deployed successfully',
        yamlPath: yamlPath,
        kubectlOutput: result,
        generatedYaml: yaml
      };

    } catch (error) {
      console.error('Error applying SGLang Router configuration:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to deploy SGLang Router'
      };
    }
  }

  static async getRouterStatus() {
    try {
      // Check SGLang Router deployment
      const deploymentCmd = 'kubectl get deployment sglang-router -o json';
      const deploymentResult = execSync(deploymentCmd, { encoding: 'utf8' });
      const deployment = JSON.parse(deploymentResult);

      // Check SGLang Router service
      const serviceCmd = 'kubectl get service sglang-router-service -o json';
      const serviceResult = execSync(serviceCmd, { encoding: 'utf8' });
      const service = JSON.parse(serviceResult);

      // Check pods
      const podsCmd = 'kubectl get pods -l app=sglang-router -o json';
      const podsResult = execSync(podsCmd, { encoding: 'utf8' });
      const pods = JSON.parse(podsResult);

      return {
        success: true,
        deployment: {
          name: deployment.metadata.name,
          replicas: deployment.status.replicas || 0,
          readyReplicas: deployment.status.readyReplicas || 0,
          creationTime: deployment.metadata.creationTimestamp
        },
        service: {
          name: service.metadata.name,
          type: service.spec.type,
          clusterIP: service.spec.clusterIP,
          externalIP: service.status?.loadBalancer?.ingress?.[0]?.ip || 'Pending',
          ports: service.spec.ports
        },
        pods: pods.items.map(pod => ({
          name: pod.metadata.name,
          status: pod.status.phase,
          ready: pod.status.containerStatuses?.[0]?.ready || false,
          restarts: pod.status.containerStatuses?.[0]?.restartCount || 0,
          creationTime: pod.metadata.creationTimestamp
        }))
      };

    } catch (error) {
      console.error('Error getting SGLang Router status:', error);
      return {
        success: false,
        error: error.message,
        routerInstalled: false
      };
    }
  }

  static async deleteRouter() {
    try {
      // Delete all SGLang Router resources
      const commands = [
        'kubectl delete deployment sglang-router',
        'kubectl delete service sglang-router-service',
        'kubectl delete clusterrolebinding sglang-router',
        'kubectl delete clusterrole sglang-router',
        'kubectl delete serviceaccount sglang-router'
      ];

      const results = [];
      for (const cmd of commands) {
        try {
          const result = execSync(cmd, { encoding: 'utf8' });
          results.push(`${cmd}: ${result.trim()}`);
        } catch (error) {
          // Some resources might not exist, that's OK
          results.push(`${cmd}: ${error.message}`);
        }
      }

      return {
        success: true,
        message: 'SGLang Router resources deleted',
        results: results
      };

    } catch (error) {
      console.error('Error deleting SGLang Router:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to delete SGLang Router'
      };
    }
  }

  static validateConfig(config) {
    const errors = [];

    if (!config) {
      errors.push('Configuration is required');
      return { valid: false, errors };
    }

    if (!config.deploymentName || config.deploymentName.trim() === '') {
      errors.push('Deployment name is required');
    } else if (!/^[a-z0-9-]+$/.test(config.deploymentName)) {
      errors.push('Deployment name must contain only lowercase letters, numbers and hyphens');
    }

    if (config.routerPort && (config.routerPort < 1000 || config.routerPort > 65535)) {
      errors.push('Router port must be between 1000 and 65535');
    }

    if (config.metricsPort && (config.metricsPort < 1000 || config.metricsPort > 65535)) {
      errors.push('Metrics port must be between 1000 and 65535');
    }

    if (config.routerPort && config.metricsPort && config.routerPort === config.metricsPort) {
      errors.push('Router port and metrics port cannot be the same');
    }

    if (config.serviceType && !['external', 'clusterip'].includes(config.serviceType)) {
      errors.push('Service type must be either "external" or "clusterip"');
    }

    if (config.routingPolicy && !['cache_aware', 'round_robin', 'least_loaded'].includes(config.routingPolicy)) {
      errors.push('Routing policy must be one of: cache_aware, round_robin, least_loaded');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  static getDefaultConfig() {
    return {
      deploymentName: 'sglang-router',
      routingPolicy: 'cache_aware',
      routerPort: 30000,
      metricsPort: 29000,
      serviceType: 'external'
    };
  }

  static async previewYaml(config) {
    try {
      const validation = this.validateConfig(config);
      if (!validation.valid) {
        return {
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors
        };
      }

      const yaml = this.generateRouterYaml(config);

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

module.exports = RoutingManager;