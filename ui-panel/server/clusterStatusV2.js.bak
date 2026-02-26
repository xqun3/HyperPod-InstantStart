const { exec } = require('child_process');

/**
 * 集群状态服务 V2 - 优化版本
 * 主要改进：
 * 1. 并行处理节点查询
 * 2. 添加超时机制
 * 3. 实现缓存策略
 * 4. 更高效的GPU信息获取
 * 5. 更好的错误处理
 */

class ClusterStatusV2 {
  constructor() {
    this.cache = {
      data: null,
      timestamp: 0,
      ttl: 30000 // 30秒缓存
    };
    this.defaultTimeout = 30000; // 30秒默认超时
  }

  /**
   * 带超时的kubectl执行函数
   */
  executeKubectlWithTimeout(command, timeout = this.defaultTimeout) {
    return new Promise((resolve, reject) => {
      const child = exec(`kubectl ${command}`, (error, stdout, stderr) => {
        if (error) {
          console.error(`kubectl error: ${error.message}`);
          reject({ error: error.message, stderr, command });
        } else {
          resolve(stdout.trim());
        }
      });

      // 设置超时
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timeout after ${timeout}ms: kubectl ${command}`));
      }, timeout);

      child.on('exit', () => {
        clearTimeout(timer);
      });
    });
  }

  /**
   * 获取单个节点的GPU信息（优化版本）
   */
  async getNodeGPUInfo(node, hyperPodCapacityTypeMap = {}) {
    const nodeName = node.metadata.name;
    const nodeReady = node.status?.conditions?.find(c => c.type === 'Ready')?.status === 'True';
    
    // 获取节点实例类型（通常在labels中）
    const instanceType = node.metadata?.labels?.['node.kubernetes.io/instance-type'] || 
                        node.metadata?.labels?.['beta.kubernetes.io/instance-type'] ||
                        'Unknown';
    
    // 获取节点标签信息用于分类
    const labels = node.metadata?.labels || {};
    
    // 获取 HyperPod 节点的 capacity type
    let capacityType = null;
    if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') {
      const instanceGroupName = labels['sagemaker.amazonaws.com/instance-group-name'];
      if (instanceGroupName && hyperPodCapacityTypeMap[instanceGroupName]) {
        capacityType = hyperPodCapacityTypeMap[instanceGroupName];
      }
    }
    
    try {
      // 并行获取节点信息，使用更高效的查询
      const [capacityInfo, allocatableInfo, podsInfo] = await Promise.all([
        // 获取节点GPU容量
        this.executeKubectlWithTimeout(
          `get node ${nodeName} -o "jsonpath={.status.capacity['nvidia\\.com/gpu']}"`, 
          10000
        ).catch(() => '0'),
        
        // 获取节点GPU可分配数量
        this.executeKubectlWithTimeout(
          `get node ${nodeName} -o "jsonpath={.status.allocatable['nvidia\\.com/gpu']}"`, 
          10000
        ).catch(() => '0'),
        
        // 获取该节点上所有已调度的 Pod（不限制 phase）
        this.executeKubectlWithTimeout(
          `get pods --field-selector spec.nodeName=${nodeName} -o json`,
          15000
        ).catch(() => '{"items":[]}')
      ]);

      const totalGPU = parseInt(capacityInfo) || 0;
      const allocatableGPU = parseInt(allocatableInfo) || 0;
      
      // 计算已使用的GPU - 统计所有已调度且未完成的 Pod
      let usedGPU = 0;
      let pendingGPU = 0;
      
      try {
        const podsData = JSON.parse(podsInfo);
        if (podsData.items && Array.isArray(podsData.items)) {
          // 统计已调度且未完成的 Pod（排除 Succeeded 和 Failed）
          usedGPU = podsData.items
            .filter(pod => !['Succeeded', 'Failed'].includes(pod.status?.phase))
            .reduce((sum, pod) => {
              if (pod.spec?.containers) {
                return sum + pod.spec.containers.reduce((containerSum, container) => {
                  const gpuRequest = container.resources?.requests?.['nvidia.com/gpu'];
                  return containerSum + (parseInt(gpuRequest) || 0);
                }, 0);
              }
              return sum;
            }, 0);
        }
        
        // 统计未调度的 Pending Pod（没有 nodeName 的）
        const allPendingPodsInfo = await this.executeKubectlWithTimeout(
          `get pods --field-selector status.phase=Pending -o json`,
          10000
        ).catch(() => '{"items":[]}');
        
        const allPendingPodsData = JSON.parse(allPendingPodsInfo);
        if (allPendingPodsData.items && Array.isArray(allPendingPodsData.items)) {
          // 只统计未调度且 nodeSelector 匹配当前节点的 Pending Pod
          pendingGPU = allPendingPodsData.items
            .filter(pod => !pod.spec?.nodeName)
            .filter(pod => {
              const selector = pod.spec?.nodeSelector;
              if (!selector) return true;
              return Object.entries(selector).every(([k, v]) => labels[k] === v);
            })
            .reduce((sum, pod) => {
              if (pod.spec?.containers) {
                return sum + pod.spec.containers.reduce((containerSum, container) => {
                  const gpuRequest = container.resources?.requests?.['nvidia.com/gpu'];
                  return containerSum + (parseInt(gpuRequest) || 0);
                }, 0);
              }
              return sum;
            }, 0);
        }
      } catch (parseError) {
        console.warn(`Failed to parse pods JSON for node ${nodeName}:`, parseError.message);
        usedGPU = 0;
        pendingGPU = 0;
      }

      return {
        nodeName,
        instanceType,
        labels, // 添加标签信息
        capacityType, // HyperPod 节点的 capacity type
        totalGPU,
        usedGPU,
        availableGPU: Math.max(0, allocatableGPU - usedGPU),
        allocatableGPU,
        pendingGPU, // 新增：Pending状态Pod请求的GPU数量（用于调试）
        nodeReady,
        fetchTime: Date.now()
      };
    } catch (error) {
      console.error(`Error fetching GPU info for node ${nodeName}:`, error.message);
      return {
        nodeName,
        instanceType: 'Unknown',
        labels, // 添加标签信息
        capacityType: null,
        totalGPU: 0,
        usedGPU: 0,
        availableGPU: 0,
        allocatableGPU: 0,
        pendingGPU: 0,
        nodeReady,
        error: error.message || 'Unable to fetch GPU info',
        fetchTime: Date.now()
      };
    }
  }

  /**
   * 并行获取所有节点的GPU信息
   */
  async getAllNodesGPUInfo(nodes, hyperPodCapacityTypeMap = {}) {
    console.log(`Fetching GPU info for ${nodes.length} nodes in parallel...`);
    
    // 创建所有节点的查询Promise
    const nodePromises = nodes.map(node => this.getNodeGPUInfo(node, hyperPodCapacityTypeMap));
    
    // 使用Promise.allSettled确保即使部分节点失败也能返回结果
    const results = await Promise.allSettled(nodePromises);
    
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        console.error(`Failed to fetch info for node ${nodes[index]?.metadata?.name}:`, result.reason);
        return {
          nodeName: nodes[index]?.metadata?.name || 'unknown',
          instanceType: 'Unknown',
          capacityType: null,
          totalGPU: 0,
          usedGPU: 0,
          availableGPU: 0,
          allocatableGPU: 0,
          pendingGPU: 0,
          nodeReady: false,
          error: 'Failed to fetch node info',
          fetchTime: Date.now()
        };
      }
    });
  }

  /**
   * 检查缓存是否有效
   */
  isCacheValid() {
    const now = Date.now();
    return this.cache.data && (now - this.cache.timestamp) < this.cache.ttl;
  }

  /**
   * 更新缓存
   */
  updateCache(data) {
    this.cache = {
      data: { ...data, cached: false },
      timestamp: Date.now(),
      ttl: 30000
    };
  }

  /**
   * 获取缓存数据
   */
  getCachedData() {
    return { ...this.cache.data, cached: true };
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cache = {
      data: null,
      timestamp: 0,
      ttl: 30000
    };
    console.log('Cluster status cache cleared');
  }

  /**
   * 获取 HyperPod 实例组的 Capacity Type 映射
   */
  async getHyperPodCapacityTypeMap() {
    try {
      const ClusterManager = require('./clusterManager');
      const AWSHelpers = require('./utils/awsHelpers');
      const fs = require('fs');
      const path = require('path');
      
      const clusterManager = new ClusterManager();
      const activeClusterName = clusterManager.getActiveCluster();
      
      if (!activeClusterName) {
        return {};
      }

      // 从 metadata 获取 HyperPod 集群信息
      const metadataDir = clusterManager.getClusterMetadataDir(activeClusterName);
      const clusterInfoPath = path.join(metadataDir, 'cluster_info.json');
      
      if (!fs.existsSync(clusterInfoPath)) {
        return {};
      }

      const clusterInfo = JSON.parse(fs.readFileSync(clusterInfoPath, 'utf8'));
      
      if (!clusterInfo.hyperPodCluster) {
        return {};
      }

      const hpClusterName = clusterInfo.hyperPodCluster.ClusterName;
      const region = await AWSHelpers.getCurrentRegion();
      
      // 获取最新的 HyperPod 集群状态
      const hpData = await AWSHelpers.describeHyperPodCluster(hpClusterName, region);
      
      // 构建 instance group name -> capacity type 的映射
      const capacityTypeMap = {};
      for (const ig of hpData.InstanceGroups || []) {
        const capacityType = ig.CapacityRequirements?.Spot ? 'spot' : 'on-demand';
        capacityTypeMap[ig.InstanceGroupName] = capacityType;
      }
      
      console.log('HyperPod capacity type map:', capacityTypeMap);
      return capacityTypeMap;
    } catch (error) {
      console.warn('Failed to get HyperPod capacity type map:', error.message);
      return {};
    }
  }

  /**
   * 主要的集群状态获取方法
   */
  async getClusterStatus(forceRefresh = false) {
    const startTime = Date.now();
    
    // 检查缓存（除非强制刷新）
    if (!forceRefresh && this.isCacheValid()) {
      console.log('Returning cached cluster status');
      return this.getCachedData();
    }

    try {
      console.log('Fetching fresh cluster status...');
      
      // 获取所有节点信息
      const nodesOutput = await this.executeKubectlWithTimeout('get nodes -o json', 15000);
      const nodesData = JSON.parse(nodesOutput);
      
      if (!nodesData.items || nodesData.items.length === 0) {
        console.log('No nodes found in cluster, returning empty result');
        return { nodes: [], fetchTime: Date.now() - startTime, timestamp: Date.now(), nodeCount: 0, version: 'v2' };
      }

      // 获取 HyperPod capacity type 映射
      const hyperPodCapacityTypeMap = await this.getHyperPodCapacityTypeMap();

      // 并行获取所有节点的GPU信息
      const gpuUsage = await this.getAllNodesGPUInfo(nodesData.items, hyperPodCapacityTypeMap);
      
      const fetchTime = Date.now() - startTime;
      const result = {
        nodes: gpuUsage,
        fetchTime,
        timestamp: Date.now(),
        nodeCount: gpuUsage.length,
        version: 'v2'
      };
      
      // 更新缓存
      this.updateCache(result);
      
      console.log(`Cluster status V2 fetched in ${fetchTime}ms: ${gpuUsage.length} nodes`);
      return result;
      
    } catch (error) {
      console.error('Cluster status V2 error:', error);
      throw {
        error: error.message || 'Failed to fetch cluster status',
        timestamp: Date.now(),
        fetchTime: Date.now() - startTime,
        version: 'v2'
      };
    }
  }

  /**
   * 获取集群统计信息
   */
  async getClusterStats(nodes) {
    // 计算节点相关的统计
    const nodeStats = nodes.reduce((stats, node) => ({
      totalNodes: stats.totalNodes + 1,
      readyNodes: stats.readyNodes + (node.nodeReady ? 1 : 0),
      totalGPUs: stats.totalGPUs + node.totalGPU,
      usedGPUs: stats.usedGPUs + node.usedGPU,
      availableGPUs: stats.availableGPUs + node.availableGPU,
      allocatableGPUs: stats.allocatableGPUs + node.allocatableGPU,
      errorNodes: stats.errorNodes + (node.error ? 1 : 0)
    }), {
      totalNodes: 0,
      readyNodes: 0,
      totalGPUs: 0,
      usedGPUs: 0,
      availableGPUs: 0,
      allocatableGPUs: 0,
      errorNodes: 0
    });

    // 单独计算全局Pending GPU（与节点无关）
    let pendingGPUs = 0;
    try {
      const allPendingPodsInfo = await this.executeKubectlWithTimeout(
        `get pods --field-selector status.phase=Pending -o json`,
        10000
      );
      
      const allPendingPodsData = JSON.parse(allPendingPodsInfo);
      if (allPendingPodsData.items && Array.isArray(allPendingPodsData.items)) {
        pendingGPUs = allPendingPodsData.items.reduce((sum, pod) => {
          if (pod.spec?.containers) {
            return sum + pod.spec.containers.reduce((containerSum, container) => {
              const gpuRequest = container.resources?.requests?.['nvidia.com/gpu'];
              return containerSum + (parseInt(gpuRequest) || 0);
            }, 0);
          }
          return sum;
        }, 0);
      }
    } catch (error) {
      console.warn('Failed to get pending pods:', error.message);
      pendingGPUs = 0;
    }

    return {
      ...nodeStats,
      pendingGPUs
    };
  }
}

// 创建单例实例
const clusterStatusV2 = new ClusterStatusV2();

// Express路由处理函数
const handleClusterStatusV2 = async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const result = await clusterStatusV2.getClusterStatus(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Cluster status API error:', error);
    res.status(500).json(error);
  }
};

// 清除缓存的路由处理函数
const handleClearCache = (req, res) => {
  clusterStatusV2.clearCache();
  res.json({ 
    success: true, 
    message: 'Cluster status cache cleared',
    timestamp: Date.now()
  });
};

// 获取缓存状态的路由处理函数
const handleCacheStatus = (req, res) => {
  const isValid = clusterStatusV2.isCacheValid();
  res.json({
    cached: isValid,
    timestamp: clusterStatusV2.cache.timestamp,
    ttl: clusterStatusV2.cache.ttl,
    age: Date.now() - clusterStatusV2.cache.timestamp
  });
};

module.exports = {
  ClusterStatusV2,
  clusterStatusV2,
  handleClusterStatusV2,
  handleClearCache,
  handleCacheStatus
};
