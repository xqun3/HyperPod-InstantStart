/**
 * EKS Service Helper - 动态生成不同类型的Kubernetes Service YAML
 */

class EKSServiceHelper {
  /**
   * 生成External LoadBalancer Service YAML
   * @param {string} servEngine - 服务引擎名称 (vllm, sglang, custom)
   * @param {string} modelTag - 模型标签
   * @param {number|Object} port - 端口号或端口配置对象 {http: 8000, metrics: 9000}
   * @param {string} nlbAnnotations - NLB注解
   * @returns {string} Service YAML字符串
   */
  static generateExternalService(servEngine, modelTag, port, nlbAnnotations) {
    // 支持多端口配置
    let portsSection;
    if (typeof port === 'object' && port !== null) {
      // 多端口模式 (Router等)
      portsSection = Object.entries(port).map(([name, portNum]) =>
        `    - name: ${name}
      port: ${portNum}
      targetPort: ${portNum}
      protocol: TCP`
      ).join('\n');
    } else {
      // 单端口模式 (普通推理服务)
      portsSection = `    - port: ${port}
      protocol: TCP
      targetPort: http`;
    }

    return `---
apiVersion: v1
kind: Service
metadata:
  name: ${servEngine}-${modelTag}-nlb
  labels:
    app: ${servEngine}-${modelTag}-inference
    model-type: "${servEngine}"
    deployment-tag: "${modelTag}"
  annotations:${nlbAnnotations}
spec:
  ports:
${portsSection}
  selector:
    app: ${servEngine}-${modelTag}-inference
  type: LoadBalancer`;
  }

  /**
   * 生成ClusterIP Service YAML
   * @param {string} servEngine - 服务引擎名称 (vllm, sglang, custom)
   * @param {string} modelTag - 模型标签
   * @param {number|Object} port - 端口号或端口配置对象 {http: 8000, metrics: 9000}
   * @returns {string} Service YAML字符串
   */
  static generateClusterIPService(servEngine, modelTag, port) {
    // 支持多端口配置
    let portsSection;
    if (typeof port === 'object' && port !== null) {
      // 多端口模式 (Router等)
      portsSection = Object.entries(port).map(([name, portNum]) =>
        `  - name: ${name}
    port: ${portNum}
    targetPort: ${portNum}
    protocol: TCP`
      ).join('\n');
    } else {
      // 单端口模式 (普通推理服务)
      portsSection = `  - name: http
    port: ${port}
    targetPort: ${port}
    protocol: TCP`;
    }

    return `---
apiVersion: v1
kind: Service
metadata:
  name: ${servEngine}-${modelTag}-service
  labels:
    app: ${servEngine}-${modelTag}-inference
    model-type: "${servEngine}"
    deployment-tag: "${modelTag}"
spec:
  type: ClusterIP
  selector:
    app: ${servEngine}-${modelTag}-inference
  ports:
${portsSection}`;
  }

  /**
   * 生成Binding Service YAML
   * @param {string} serviceName - 服务名称
   * @param {string} modelId - 模型ID
   * @param {string} modelType - 模型类型 (vllm, sglang, ollama)
   * @param {string} serviceType - 服务类型 ('external', 'clusterip')
   * @param {number} port - 端口号
   * @param {string} nlbAnnotations - NLB注解 (仅external类型需要)
   * @returns {string} Service YAML字符串
   */
  static generateBindingService(serviceName, modelId, modelType, serviceType, port = 8000, nlbAnnotations = '') {
    const isExternal = serviceType === 'external';
    const serviceTypeName = isExternal ? 'LoadBalancer' : 'ClusterIP';
    const serviceSuffix = isExternal ? '-nlb' : '-service';
    
    return `---
apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}${serviceSuffix}
  labels:
    business: "${serviceName}"
    model-id: "${modelId}"
    model-type: "${modelType}"
    service-type: "binding-service"${isExternal ? `
  annotations:${nlbAnnotations}` : ''}
spec:
  selector:
    model-id: "${modelId}"
    business: "${serviceName}"
  type: ${serviceTypeName}
  ports:
    - port: ${port}
      protocol: TCP
      targetPort: http
      name: http`;
  }

  /**
   * 生成 Managed Inference Service YAML
   * @param {string} deploymentName - InferenceEndpointConfig 的名称
   * @param {string} serviceType - 服务类型 ('external', 'clusterip')
   * @param {number} port - 对外暴露的端口
   * @param {string} nlbAnnotations - NLB注解 (仅external类型需要)
   * @returns {string} Service YAML字符串
   */
  static generateManagedInferenceService(deploymentName, serviceType, port, nlbAnnotations = '') {
    const isExternal = serviceType === 'external';
    const serviceName = isExternal ? `${deploymentName}-nlb` : `${deploymentName}-service`;
    const serviceTypeName = isExternal ? 'LoadBalancer' : 'ClusterIP';
    const sidecarPort = 8081; // Inference Operator sidecar-reverse-proxy 固定端口

    return `---
apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  labels:
    app: ${deploymentName}${isExternal ? `
  annotations:${nlbAnnotations}` : ''}
spec:
  type: ${serviceTypeName}
  selector:
    app: ${deploymentName}
  ports:
    - name: http-proxy
      port: ${port}
      targetPort: ${sidecarPort}
      protocol: TCP`;
  }

  /**
   * 根据服务类型生成对应的Service YAML
   * @param {string} serviceType - 服务类型 ('external', 'clusterip', 'modelpool')
   * @param {string} servEngine - 服务引擎名称
   * @param {string} modelTag - 模型标签
   * @param {number} port - 端口号
   * @param {string} nlbAnnotations - NLB注解 (仅external类型需要)
   * @returns {string} Service YAML字符串，如果是modelpool则返回空字符串
   */
  static generateServiceYaml(serviceType, servEngine, modelTag, port, nlbAnnotations = '') {
    switch (serviceType) {
      case 'external':
        return this.generateExternalService(servEngine, modelTag, port, nlbAnnotations);

      case 'clusterip':
        return this.generateClusterIPService(servEngine, modelTag, port);

      case 'modelpool':
        return ''; // Model Pool不需要Service

      default:
        console.warn(`Unknown service type: ${serviceType}, defaulting to clusterip`);
        return this.generateClusterIPService(servEngine, modelTag, port);
    }
  }
}

module.exports = EKSServiceHelper;