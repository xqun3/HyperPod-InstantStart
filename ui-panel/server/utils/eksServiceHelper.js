/**
 * EKS Service Helper - 动态生成不同类型的Kubernetes Service YAML
 */

class EKSServiceHelper {
  /**
   * 生成External LoadBalancer Service YAML
   * @param {string} servEngine - 服务引擎名称 (vllm, sglang, custom)
   * @param {string} modelTag - 模型标签
   * @param {number} port - 端口号
   * @param {string} nlbAnnotations - NLB注解
   * @returns {string} Service YAML字符串
   */
  static generateExternalService(servEngine, modelTag, port, nlbAnnotations) {
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
    - port: ${port}
      protocol: TCP
      targetPort: http
  selector:
    app: ${servEngine}-${modelTag}-inference
  type: LoadBalancer`;
  }

  /**
   * 生成ClusterIP Service YAML
   * @param {string} servEngine - 服务引擎名称 (vllm, sglang, custom)
   * @param {string} modelTag - 模型标签
   * @param {number} port - 端口号
   * @returns {string} Service YAML字符串
   */
  static generateClusterIPService(servEngine, modelTag, port) {
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
  - name: http
    port: ${port}
    targetPort: ${port}
    protocol: TCP`;
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
        console.warn(`Unknown service type: ${serviceType}, defaulting to external`);
        return this.generateExternalService(servEngine, modelTag, port, nlbAnnotations);
    }
  }
}

module.exports = EKSServiceHelper;