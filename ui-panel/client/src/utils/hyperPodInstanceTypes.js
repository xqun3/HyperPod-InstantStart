/**
 * HyperPod 实例类型统一管理工具
 * 提供获取集群中实际可用的 ml.* 实例类型的功能
 */

import { useState, useEffect, useCallback } from 'react';

/**
 * 获取HyperPod集群中可用的实例类型
 * @returns {Promise<Array>} 返回实例类型选项数组，格式：[{ value: 'ml.g5.8xlarge', label: 'ml.g5.8xlarge (group-name) [2 nodes]' }]
 */
export const getHyperPodInstanceTypes = async () => {
  try {
    const response = await fetch('/api/cluster/cluster-available-instance');
    const data = await response.json();

    if (!response.ok || !data.success) {
      console.warn('Failed to fetch HyperPod instance types:', data.error);
      return getFallbackInstanceTypes();
    }

    // 提取HyperPod实例类型 (ml.*开头的)
    const hyperPodTypes = data.data?.hyperpod || [];

    if (hyperPodTypes.length === 0) {
      console.warn('No HyperPod instance types found in cluster');
      return getFallbackInstanceTypes();
    }

    // 转换为选项格式
    const options = hyperPodTypes.map(item => ({
      value: `${item.type}-${item.group}`, // 使用唯一标识作为value
      label: `${item.type} (${item.group}) [${item.count} nodes]`,
      disabled: false, // HyperPod集群中的节点都是可用的
      instanceType: item.type // 保留原始实例类型
    }));

    console.log(`Loaded ${options.length} HyperPod instance types from cluster`);
    return options;

  } catch (error) {
    console.error('Error fetching HyperPod instance types:', error);
    return getFallbackInstanceTypes();
  }
};

/**
 * 获取HyperPod实例类型的简化列表（仅实例类型，无额外信息）
 * @returns {Promise<Array>} 返回实例类型字符串数组：['ml.g5.8xlarge', 'ml.g6.12xlarge', ...]
 */
export const getHyperPodInstanceTypesList = async () => {
  try {
    const options = await getHyperPodInstanceTypes();
    return options.map(option => option.value);
  } catch (error) {
    console.error('Error getting HyperPod instance types list:', error);
    return getFallbackInstanceTypesList();
  }
};

/**
 * 检查指定的实例类型是否在HyperPod集群中可用
 * @param {string} instanceType - 要检查的实例类型
 * @returns {Promise<boolean>} 是否可用
 */
export const isInstanceTypeAvailable = async (instanceType) => {
  try {
    const types = await getHyperPodInstanceTypesList();
    return types.includes(instanceType);
  } catch (error) {
    console.error('Error checking instance type availability:', error);
    return false;
  }
};

/**
 * 回退选项 - 当无法从集群获取时使用的默认ml.*实例类型
 * 基于常见的HyperPod支持的实例类型
 */
const getFallbackInstanceTypes = () => {
  const fallbackTypes = [
    'ml.g5.8xlarge',
    'ml.g5.12xlarge',
    'ml.g5.24xlarge',
    'ml.g5.48xlarge',
    'ml.g6.8xlarge',
    'ml.g6.12xlarge',
    'ml.g6.24xlarge',
    'ml.g6.48xlarge',
    'ml.g6e.8xlarge',
    'ml.g6e.12xlarge',
    'ml.g6e.24xlarge',
    'ml.g6e.48xlarge',
    'ml.p4d.24xlarge',
    'ml.p5.48xlarge',
    'ml.p5en.48xlarge',
    'ml.p6-b200.48xlarge'
  ];

  return fallbackTypes.map(type => ({
    value: type,
    label: `${type} (fallback)`,
    disabled: false,
    instanceType: type // 保持与集群数据一致的格式
  }));
};

/**
 * 回退实例类型列表
 */
const getFallbackInstanceTypesList = () => {
  const fallback = getFallbackInstanceTypes();
  return fallback.map(option => option.value);
};

/**
 * 创建适用于Antd AutoComplete组件的选项
 * @returns {Promise<Array>} AutoComplete选项数组
 */
export const getAutoCompleteOptions = async () => {
  const options = await getHyperPodInstanceTypes();
  return options.map(option => ({
    value: option.value,
    label: option.label
  }));
};

/**
 * React Hook - 用于在组件中获取HyperPod实例类型
 * @param {Object} options - 配置选项
 * @param {boolean} options.autoFetch - 是否自动获取，默认true
 * @param {boolean} options.fallbackOnError - 错误时是否使用回退选项，默认true
 * @returns {Object} { instanceTypes, loading, error, refresh }
 */

export const useHyperPodInstanceTypes = (options = {}) => {
  const { autoFetch = true, fallbackOnError = true } = options;

  const [instanceTypes, setInstanceTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchInstanceTypes = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const types = await getHyperPodInstanceTypes();
      setInstanceTypes(types);
    } catch (err) {
      console.error('Error in useHyperPodInstanceTypes:', err);
      setError(err);

      if (fallbackOnError) {
        setInstanceTypes(getFallbackInstanceTypes());
      }
    } finally {
      setLoading(false);
    }
  }, [fallbackOnError]);

  useEffect(() => {
    if (autoFetch) {
      fetchInstanceTypes();
    }
  }, [autoFetch, fetchInstanceTypes]);

  return {
    instanceTypes,
    loading,
    error,
    refresh: fetchInstanceTypes
  };
};