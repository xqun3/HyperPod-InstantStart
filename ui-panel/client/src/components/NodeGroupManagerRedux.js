import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { Card, Table, Button, message, Tag, Space, Modal, InputNumber, Form, Select, Input, Typography, AutoComplete, Checkbox, Row, Col, Alert, Spin, Tooltip, Switch } from 'antd';
import { ReloadOutlined, EditOutlined, ToolOutlined, PlusOutlined, DeleteOutlined, InfoCircleOutlined, CloudServerOutlined } from '@ant-design/icons';
import EksNodeGroupCreationPanel from './EksNodeGroupCreationPanel';
import {
  fetchNodeGroups,
  createHyperPod,
  // deleteHyperPod, // 已隐藏 Delete HyperPod 功能 (2025-12-03)
  addInstanceGroup,
  scaleNodeGroup,
  deleteNodeGroup,
  checkHyperPodCreationStatus,
  clearHyperPodCreationStatus,
  clearNodeGroupOperationStatus
} from '../store/slices/nodeGroupsSlice';
import {
  selectEksNodeGroups,
  selectHyperPodGroups,
  selectNodeGroupsLoading,
  selectNodeGroupsError,
  selectHyperPodCreationStatus,
  selectHyperPodDeletionStatus,
  selectEffectiveDependenciesStatus
} from '../store/selectors';
import globalRefreshManager from '../hooks/useGlobalRefresh';

const { Text } = Typography;

const NodeGroupManagerRedux = ({ activeCluster, refreshTrigger, cluster }) => {
  // Redux state
  const dispatch = useDispatch();
  const eksNodeGroupsFromStore = useSelector(selectEksNodeGroups);
  const eksNodeGroups = Array.isArray(eksNodeGroupsFromStore) ? eksNodeGroupsFromStore : [];
  const hyperPodGroupsFromStore = useSelector(selectHyperPodGroups);
  const hyperPodGroups = Array.isArray(hyperPodGroupsFromStore) ? hyperPodGroupsFromStore : [];
  const loading = useSelector(selectNodeGroupsLoading);
  // const error = useSelector(selectNodeGroupsError); // Unused
  const hyperPodCreationStatus = useSelector(selectHyperPodCreationStatus);
  const hyperPodDeletionStatus = useSelector(selectHyperPodDeletionStatus);
  const effectiveDependenciesConfigured = useSelector(selectEffectiveDependenciesStatus);

  // Local state for UI
  const [scaleLoading, setScaleLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [eksDeleteLoading, setEksDeleteLoading] = useState(false);
  const [eksDeleteTarget, setEksDeleteTarget] = useState(null);
  const [addInstanceGroupLoading, setAddInstanceGroupLoading] = useState(false);
  const [clusterInfo, setClusterInfo] = useState({ eksClusterName: '', region: '' });
  const [availabilityZones, setAvailabilityZones] = useState([]);
  const [scaleModalVisible, setScaleModalVisible] = useState(false);
  const [createHyperPodModalVisible, setCreateHyperPodModalVisible] = useState(false);
  const [createEksNodeGroupModalVisible, setCreateEksNodeGroupModalVisible] = useState(false);
  const [addInstanceGroupModalVisible, setAddInstanceGroupModalVisible] = useState(false);
  const [scaleTarget, setScaleTarget] = useState(null);
  const [form] = Form.useForm();
  const [hyperPodForm] = Form.useForm();
  const [instanceGroupForm] = Form.useForm();

  // Karpenter 相关状态
  const [karpenterStatus, setKarpenterStatus] = useState(null);
  const [karpenterInstalling, setKarpenterInstalling] = useState(false);
  const [karpenterUninstalling, setKarpenterUninstalling] = useState(false);

  // Karpenter NodeClass/NodePool 相关状态
  const [karpenterResources, setKarpenterResources] = useState({
    nodeClasses: [],
    nodePools: [],
    nodes: []
  });
  const [karpenterResourcesLoading, setKarpenterResourcesLoading] = useState(true);
  const [nodeClassModalVisible, setNodeClassModalVisible] = useState(false);
  const [createKarpenterResourceLoading, setCreateKarpenterResourceLoading] = useState(false);
  const [karpenterResourceForm] = Form.useForm();

  // HyperPod Karpenter 相关状态
  const [hyperpodKarpenterResources, setHyperpodKarpenterResources] = useState({
    nodeClasses: [],
    nodePools: [],
    managedInstanceGroups: []
  });
  const [hyperpodKarpenterLoading, setHyperpodKarpenterLoading] = useState(true);
  const [hyperpodKarpenterStatus, setHyperpodKarpenterStatus] = useState({ installed: false });
  const [hyperpodKarpenterInstalling, setHyperpodKarpenterInstalling] = useState(false);
  const [hyperpodKarpenterResourceModalVisible, setHyperpodKarpenterResourceModalVisible] = useState(false);
  const [hyperpodKarpenterResourceCreating, setHyperpodKarpenterResourceCreating] = useState(false);
  const [selectedInstanceGroups, setSelectedInstanceGroups] = useState([]);
  const [deletingNodePool, setDeletingNodePool] = useState(null); // 新增：记录正在删除的 NodePool

  // 动态实例类型相关状态
  const [instanceTypesLoading, setInstanceTypesLoading] = useState(false);
  const [availableInstanceTypes, setAvailableInstanceTypes] = useState([]);
  const [cacheInfo, setCacheInfo] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [isAutoFetching, setIsAutoFetching] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  // HyperPod子网相关状态
  const [hyperPodSubnets, setHyperPodSubnets] = useState([]);
  const [subnetsLoading, setSubnetsLoading] = useState(false);
  
  // Subnets for Add Instance Group
  const [subnets, setSubnets] = useState({ publicSubnets: [], privateSubnets: [], hyperPodSubnets: [] });

  // 子网感知的实例类型状态
  const [selectedSubnet, setSelectedSubnet] = useState(null);
  const [filteredInstanceTypes, setFilteredInstanceTypes] = useState([]);
  const [subnetInstanceTypesCache, setSubnetInstanceTypesCache] = useState({});
  const [isLoadingSubnetTypes, setIsLoadingSubnetTypes] = useState(false);

  // GPU实例类型配置
  const gpuInstanceFamilies = {
    g5: { name: 'G5', description: 'NVIDIA A10G GPUs' },
    g6: { name: 'G6', description: 'NVIDIA L4 GPUs' },
    g6e: { name: 'G6e', description: 'NVIDIA L40S GPUs' },
    p4: { name: 'P4d', description: 'NVIDIA A100 GPUs' },
    p5: { name: 'P5', description: 'NVIDIA H100 GPUs' },
    p5e: { name: 'P5e', description: 'NVIDIA H100 GPUs' },
    p5en: { name: 'P5en', description: 'NVIDIA H100 GPUs' },
    p6: { name: 'P6-B200', description: 'NVIDIA B200 GPUs' }
  };

  const fetchClusterInfo = async () => {
    try {
      const response = await fetch('/api/cluster/info');
      const data = await response.json();
      if (response.ok) {
        setClusterInfo({
          eksClusterName: data.eksClusterName || '',
          region: data.region || ''
        });

        // 获取真实的可用区列表
        if (data.region) {
          const azResponse = await fetch(`/api/cluster/availability-zones?region=${data.region}`);
          const azData = await azResponse.json();
          if (azResponse.ok) {
            setAvailabilityZones(azData.zones || []);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching cluster info:', error);
    }
  };

  // Delete HyperPod 功能已隐藏 (2025-12-03)
  /* const handleDeleteHyperPod = () => {
    Modal.confirm({
      title: 'Delete HyperPod Cluster',
      content: 'Are you sure you want to delete the HyperPod cluster? This action cannot be undone.',
      okText: 'Yes, Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await dispatch(deleteHyperPod(activeCluster)).unwrap();
          message.success('HyperPod deletion initiated successfully');
        } catch (error) {
          message.error(`Failed to delete HyperPod: ${error}`);
        }
      }
    });
  }; */

  // Karpenter 相关函数
  const fetchKarpenterStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/cluster/karpenter/status');
      const data = await response.json();
      if (response.ok) {
        setKarpenterStatus(data);
      } else {
        console.error('Failed to fetch Karpenter status:', data.error);
        // 即使出错也要设置状态，避免一直加载
        setKarpenterStatus({ installed: false, error: data.error });
      }
    } catch (error) {
      console.error('Error fetching Karpenter status:', error);
      // 网络错误时也要设置状态
      setKarpenterStatus({ installed: false, error: error.message });
    }
  }, []);


  // 动态获取AWS实例类型（从缓存，如果无缓存则自动刷新）
  const fetchAvailableInstanceTypes = useCallback(async (autoRefreshOnMissing = true) => {
    setInstanceTypesLoading(true);
    setRefreshError(null);

    try {
      const response = await fetch('/api/aws/instance-types');
      const data = await response.json();

      if (response.ok && data.success) {
        // 成功获取缓存数据
        setAvailableInstanceTypes(data.instanceTypes);
        setCacheInfo({
          region: data.region,
          lastUpdated: data.lastUpdated,
          cached: data.cached,
          totalFound: data.instanceTypes.length
        });
        console.log(`Loaded ${data.instanceTypes.length} instance types from cache (last updated: ${data.lastUpdated})`);
      } else if (autoRefreshOnMissing && (response.status === 404 || data.needsRefresh)) {
        // 缓存不存在或需要刷新，显示需要手动刷新的状态
        console.log('No cache found, user needs to refresh manually');
        setAvailableInstanceTypes([]);
        setCacheInfo(null);
        setRefreshError('Instance types cache not found. Please click "Fetch from AWS" to load instance types.');
        console.warn('Instance types cache not available, manual refresh required');
      } else {
        // 其他错误情况
        setAvailableInstanceTypes([]);
        setCacheInfo(null);
        setRefreshError(data.error || 'Failed to load instance types');
        console.warn('Instance types not available:', data.error);
      }
    } catch (error) {
      setAvailableInstanceTypes([]);
      setCacheInfo(null);
      setRefreshError(`Network error: ${error.message}`);
      console.error('Failed to fetch instance types:', error);
    } finally {
      setInstanceTypesLoading(false);
    }
  }, []);

  // 手动刷新实例类型（从AWS获取并更新缓存）
  const refreshInstanceTypes = useCallback(async () => {
    setInstanceTypesLoading(true);
    setRefreshError(null);
    setIsManualRefreshing(true);

    try {
      const response = await fetch('/api/aws/instance-types/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          families: ['g5', 'g6', 'g6e', 'p4', 'p5', 'p5e', 'p5en', 'p6']
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // 刷新成功
        setAvailableInstanceTypes(data.instanceTypes);
        setCacheInfo({
          region: data.region,
          lastUpdated: data.lastUpdated,
          cached: false,
          totalFound: data.totalFound
        });
        setRefreshError(null);
        setIsAutoFetching(false);
        setIsManualRefreshing(false);
        console.log(`Successfully refreshed ${data.totalFound} instance types`);

        if (data.errors) {
          console.warn('Some instance families had errors:', data.errors);
        }
      } else {
        // 刷新失败
        setAvailableInstanceTypes([]);
        setCacheInfo(null);
        setRefreshError(data.error || 'Failed to refresh instance types');
        setIsAutoFetching(false);
        setIsManualRefreshing(false);
        console.error('Failed to refresh instance types:', data.error);
      }
    } catch (error) {
      setAvailableInstanceTypes([]);
      setCacheInfo(null);
      setRefreshError(`Network error: ${error.message}`);
      setIsAutoFetching(false);
      setIsManualRefreshing(false);
      console.error('Failed to refresh instance types:', error);
    } finally {
      setInstanceTypesLoading(false);
    }
  }, []);

  // 子网选择变化处理函数
  const handleSubnetChangeForInstanceTypes = useCallback(async (subnetId) => {
    setSelectedSubnet(subnetId);

    if (!subnetId) {
      setFilteredInstanceTypes([]);
      return;
    }

    // 检查是否有该子网的缓存
    if (subnetInstanceTypesCache[subnetId]) {
      console.log(`Using cached instance types for subnet: ${subnetId}`);
      setFilteredInstanceTypes(subnetInstanceTypesCache[subnetId]);
      return;
    }

    // 从后端获取该子网的实例类型
    setInstanceTypesLoading(true);
    setIsLoadingSubnetTypes(true);
    setRefreshError(null);

    try {
      console.log(`🔍 Fetching instance types for subnet: ${subnetId}`);
      const response = await fetch('/api/aws/instance-types/by-subnet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnetId })
      });

      const data = await response.json();
      console.log(`📡 API Response:`, {
        status: response.status,
        success: data.success,
        instanceCount: data.instanceTypes?.length || 0,
        error: data.error,
        availabilityZone: data.availabilityZone
      });

      if (response.ok && data.success) {
        setFilteredInstanceTypes(data.instanceTypes);

        // 更新缓存
        setSubnetInstanceTypesCache(prev => ({
          ...prev,
          [subnetId]: data.instanceTypes
        }));

        console.log(`✅ Loaded ${data.instanceTypes.length} instance types for subnet: ${subnetId} (AZ: ${data.availabilityZone})`);
      } else {
        console.error(`❌ API Error:`, data);
        throw new Error(data.error || 'Failed to fetch subnet instance types');
      }
    } catch (error) {
      console.error('Error fetching subnet instance types:', error);
      setRefreshError(`Failed to load instance types for selected subnet: ${error.message}`);
      setFilteredInstanceTypes([]);
    } finally {
      setInstanceTypesLoading(false);
      setIsLoadingSubnetTypes(false);
    }
  }, [subnetInstanceTypesCache]);

  // 获取HyperPod子网
  const fetchHyperPodSubnets = useCallback(async () => {
    setSubnetsLoading(true);
    try {
      const response = await fetch('/api/cluster/karpenter/hyperpod-subnets');
      const data = await response.json();

      if (response.ok && data.success) {
        setHyperPodSubnets(data.data.subnets);
        console.log(`Loaded ${data.data.count} HyperPod subnets`);
      } else {
        console.warn('No HyperPod subnets found or failed to fetch');
        setHyperPodSubnets([]);
      }
    } catch (error) {
      console.error('Error fetching HyperPod subnets:', error);
      setHyperPodSubnets([]);
    } finally {
      setSubnetsLoading(false);
    }
  }, []);

  // 获取所有子网（用于 Add Instance Group）
  const fetchSubnets = useCallback(async () => {
    try {
      const response = await fetch('/api/cluster/subnets');
      const result = await response.json();
      
      if (result.success) {
        setSubnets({
          publicSubnets: result.data.publicSubnets || [],
          privateSubnets: result.data.privateSubnets || [],
          hyperPodSubnets: result.data.hyperPodSubnets || []
        });
      }
    } catch (error) {
      console.error('Error fetching subnets:', error);
    }
  }, []);

  // 渲染实例类型复选框
  const renderInstanceTypeCheckboxes = () => {
    if (instanceTypesLoading) {
      return (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <Spin size="large" />
          <div style={{ marginTop: '16px' }}>
            <Typography.Text type="secondary">
              {isLoadingSubnetTypes
                ? 'Fetching instance types for selected subnet...'
                : isManualRefreshing
                ? 'Refreshing instance types from AWS...'
                : isAutoFetching
                  ? 'Auto-fetching instance types from AWS...'
                  : 'Loading cached instance types...'}
            </Typography.Text>
          </div>
        </div>
      );
    }

    // 根据是否选择了子网决定显示哪些实例类型
    const displayInstanceTypes = selectedSubnet ? filteredInstanceTypes : availableInstanceTypes;

    // Show error state if no instance types and there's an error
    if (displayInstanceTypes.length === 0 && refreshError) {
      return (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <Alert
            type="warning"
            message="Instance Types Not Available"
            description={
              <div>
                <p>{refreshError}</p>
                <Button
                  type="primary"
                  icon={<ReloadOutlined />}
                  onClick={selectedSubnet ? () => handleSubnetChangeForInstanceTypes(selectedSubnet) : refreshInstanceTypes}
                  style={{ marginTop: '16px' }}
                >
                  {selectedSubnet ? 'Retry for Subnet' : 'Fetch from AWS'}
                </Button>
              </div>
            }
            showIcon
          />
        </div>
      );
    }

    // Show subnet-specific info or cache info
    const infoDisplay = selectedSubnet ? (
      <div style={{
        marginBottom: '16px',
        padding: '8px 12px',
        backgroundColor: '#f6ffed',
        border: '1px solid #b7eb8f',
        borderRadius: '4px',
        fontSize: '12px'
      }}>
        <Typography.Text type="secondary">
          📍 Showing {displayInstanceTypes.length} instance types available in selected subnet
          {selectedSubnet && ` (${hyperPodSubnets.find(s => s.subnetId === selectedSubnet)?.availabilityZone})`}
        </Typography.Text>
      </div>
    ) : cacheInfo && (
      <div style={{
        marginBottom: '16px',
        padding: '8px 12px',
        backgroundColor: '#f0f9ff',
        border: '1px solid #bae6fd',
        borderRadius: '4px',
        fontSize: '12px'
      }}>
        <Typography.Text type="secondary">
          Region: {cacheInfo.region} •
          Found: {cacheInfo.totalFound} types •
          Updated: {new Date(cacheInfo.lastUpdated).toLocaleString()}
          {cacheInfo.cached && ' (cached)'}
        </Typography.Text>
      </div>
    );

    // 按实例系列分组
    const groupedTypes = displayInstanceTypes.reduce((acc, type) => {
      if (!acc[type.family]) {
        acc[type.family] = [];
      }
      acc[type.family].push(type);
      return acc;
    }, {});

    return (
      <div>
        {infoDisplay}
        <div
          className="instance-types-scrollable"
          style={{
            maxHeight: '320px',
            overflowY: 'scroll',
            border: '2px solid #e8e8e8',
            borderRadius: '8px',
            padding: '16px',
            backgroundColor: '#fafafa',
            scrollbarWidth: 'auto', // Firefox
            scrollbarColor: '#bfbfbf #f5f5f5' // Firefox
          }}
        >
        <style>{`
          .instance-types-scrollable::-webkit-scrollbar {
            width: 8px;
          }
          .instance-types-scrollable::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 4px;
          }
          .instance-types-scrollable::-webkit-scrollbar-thumb {
            background: #c1c1c1;
            border-radius: 4px;
          }
          .instance-types-scrollable::-webkit-scrollbar-thumb:hover {
            background: #a8a8a8;
          }
        `}</style>

        <Form.Item name="instanceTypes" noStyle>
          <Checkbox.Group>
            {Object.entries(groupedTypes).map(([family, types]) => (
              <div key={family} style={{ marginBottom: '20px' }}>
                <div style={{
                  marginBottom: '12px',
                  borderBottom: '2px solid #d9d9d9',
                  paddingBottom: '6px',
                  backgroundColor: '#ffffff',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.1)'
                }}>
                  <Typography.Text strong style={{ fontSize: '14px', color: '#1890ff' }}>
                    {gpuInstanceFamilies[family]?.name || family.toUpperCase()}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ marginLeft: '8px', fontSize: '12px' }}>
                    {gpuInstanceFamilies[family]?.description}
                  </Typography.Text>
                </div>
                <Row gutter={[6, 6]}>
                  {types.map(type => (
                    <Col span={8} key={type.value} style={{ minWidth: '160px', maxWidth: '200px' }}>
                      <div style={{
                        border: '1px solid #e0e0e0',
                        borderRadius: '4px',
                        padding: '8px',
                        backgroundColor: '#ffffff',
                        transition: 'all 0.2s',
                        cursor: 'pointer'
                      }}>
                        <Checkbox value={type.value} style={{ width: '100%' }}>
                          <div style={{ marginLeft: '4px' }}>
                            <div style={{
                              fontSize: '13px',
                              fontWeight: '600',
                              color: '#262626',
                              marginBottom: '2px',
                              lineHeight: '1.2'
                            }}>
                              {type.label}
                            </div>
                            <div style={{
                              fontSize: '11px',
                              color: '#8c8c8c',
                              lineHeight: '1.2'
                            }}>
                              {type.vcpu}vCPU • {type.memory}GB
                            </div>
                            <div style={{
                              fontSize: '11px',
                              color: '#52c41a',
                              fontWeight: '500',
                              lineHeight: '1.2'
                            }}>
                              {type.gpu}
                            </div>
                          </div>
                        </Checkbox>
                      </div>
                    </Col>
                  ))}
                </Row>
              </div>
            ))}
          </Checkbox.Group>
        </Form.Item>
        </div>
      </div>
    );
  };

  // 获取 Karpenter 资源 (NodeClass/NodePool)
  const fetchKarpenterResources = useCallback(async () => {
    setKarpenterResourcesLoading(true);
    try {
      const response = await fetch('/api/cluster/karpenter/resources');
      const data = await response.json();
      if (response.ok) {
        setKarpenterResources(data.data);
      } else {
        console.error('Failed to fetch Karpenter resources:', data.error);
        setKarpenterResources({
          nodeClasses: [],
          nodePools: [],
          nodes: []
        });
      }
    } catch (error) {
      console.error('Error fetching Karpenter resources:', error);
      setKarpenterResources({
        nodeClasses: [],
        nodePools: [],
        nodes: []
      });
    } finally {
      setKarpenterResourcesLoading(false);
    }
  }, []);

  // 获取 HyperPod Karpenter 资源
  const fetchHyperPodKarpenterResources = useCallback(async () => {
    setHyperpodKarpenterLoading(true);
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/resources');
      const data = await response.json();
      if (response.ok) {
        setHyperpodKarpenterResources(data.data);
      } else {
        console.error('Failed to fetch HyperPod Karpenter resources:', data.error);
        setHyperpodKarpenterResources({
          nodeClasses: [],
          nodePools: []
        });
      }
    } catch (error) {
      console.error('Error fetching HyperPod Karpenter resources:', error);
      setHyperpodKarpenterResources({
        nodeClasses: [],
        nodePools: []
      });
    } finally {
      setHyperpodKarpenterLoading(false);
    }
  }, []);

  // 获取 HyperPod Karpenter 安装状态
  const fetchHyperPodKarpenterStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/status');
      const data = await response.json();
      if (response.ok) {
        setHyperpodKarpenterStatus(data.data);
      }
    } catch (error) {
      console.error('Error fetching HyperPod Karpenter status:', error);
      setHyperpodKarpenterStatus({ installed: false });
    }
  }, []);

  // 安装 HyperPod Karpenter
  const handleInstallHyperPodKarpenter = async () => {
    if (hyperPodGroups.length === 0) {
      message.error('No HyperPod cluster found');
      return;
    }

    const hyperPodClusterName = hyperPodGroups[0].clusterName;
    
    setHyperpodKarpenterInstalling(true);
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clusterTag: activeCluster,
          hyperPodClusterName: hyperPodClusterName
        })
      });

      const result = await response.json();
      
      if (result.success) {
        message.success('HyperPod Karpenter installed successfully');
        await fetchHyperPodKarpenterStatus();
      } else {
        message.error(`Installation failed: ${result.error}`);
      }
    } catch (error) {
      message.error('Failed to install HyperPod Karpenter');
      console.error('Installation error:', error);
    } finally {
      setHyperpodKarpenterInstalling(false);
    }
  };

  // 创建 HyperPod Karpenter 资源
  const handleCreateHyperPodKarpenterResource = async () => {
    if (selectedInstanceGroups.length === 0) {
      message.error('Please select at least one instance group');
      return;
    }

    setHyperpodKarpenterResourceCreating(true);
    try {
      const response = await fetch('/api/cluster/hyperpod-karpenter/create-resource', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceGroups: selectedInstanceGroups
        })
      });

      const result = await response.json();
      
      if (result.success) {
        message.success('HyperPod Karpenter resource created successfully');
        setHyperpodKarpenterResourceModalVisible(false);
        setSelectedInstanceGroups([]);
        await fetchHyperPodKarpenterResources();
      } else {
        message.error(`Creation failed: ${result.error}`);
      }
    } catch (error) {
      message.error('Failed to create HyperPod Karpenter resource');
      console.error('Creation error:', error);
    } finally {
      setHyperpodKarpenterResourceCreating(false);
    }
  };

  // 创建 Karpenter 资源 (NodeClass + NodePool)
  const handleCreateKarpenterResource = async (values) => {
    setCreateKarpenterResourceLoading(true);
    try {
      // 检查是否选择了实例类型
      if (!values.instanceTypes || values.instanceTypes.length === 0) {
        message.error('Please select at least one instance type');
        setCreateKarpenterResourceLoading(false);
        return;
      }

      // 使用用户输入的资源名称
      const baseName = values.resourceName;
      const nodeClassName = `${baseName}-nodeclass`;


      const nodePoolName = `${baseName}-nodepool`;

      // 根据用户选择的capacity type确定配置
      const capacityTypes = [];
      if (values.capacityType === 'spot') {
        capacityTypes.push('spot');
      } else if (values.capacityType === 'on-demand') {
        capacityTypes.push('on-demand');
      } else if (values.capacityType === 'both') {
        capacityTypes.push('spot', 'on-demand');
      }

      // 统一创建 NodeClass + NodePool（就像命令行 YAML 部署一样）
      const unifiedConfig = {
        nodeClassName,
        nodePoolName,
        nodeClassRef: nodeClassName, // NodePool 需要引用 NodeClass 的名称
        instanceTypes: values.instanceTypes, // 直接使用选中的实例类型
        capacityTypes: capacityTypes, // 支持的容量类型
        nodePoolWeight: values.nodePoolWeight || 100, // NodePool级别的权重
        gpuLimit: values.gpuLimit, // 用户指定的GPU限制
        volumeSize: values.volumeSize || 200,
        volumeType: 'gp3', // 固定使用 gp3
        amiAlias: 'al2023@latest', // 固定使用 al2023
        encrypted: false, // 不开启加密
        consolidationPolicy: 'WhenEmpty',
        consolidateAfter: '30s'
      };

      const response = await fetch('/api/cluster/karpenter/unified-resources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(unifiedConfig)
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to create Karpenter resources: ${error.error}`);
      }

      message.success(`Karpenter resources created successfully: ${nodeClassName} and ${nodePoolName}`);
      setNodeClassModalVisible(false);
      karpenterResourceForm.resetFields();

      // 重置子网相关状态
      setSelectedSubnet(null);
      setFilteredInstanceTypes([]);
      setIsLoadingSubnetTypes(false);

      await fetchKarpenterResources();

    } catch (error) {
      console.error('Error creating Karpenter resources:', error);
      message.error(`Error creating Karpenter resources: ${error.message}`);
    } finally {
      setCreateKarpenterResourceLoading(false);
    }
  };


  // 删除 NodeClass
  // NodeClass 现在作为 NodePool 的一部分统一管理，删除时一起删除

  // 删除 NodePool
  const handleDeleteNodePool = async (name) => {
    Modal.confirm({
      title: 'Delete Karpenter Resources',
      content: `Are you sure you want to delete NodePool "${name}" and its associated NodeClass? This action cannot be undone.`,
      okText: 'Yes, Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const response = await fetch(`/api/cluster/karpenter/nodepool/${name}`, {
            method: 'DELETE'
          });

          const data = await response.json();
          if (response.ok) {
            message.success(`NodePool ${name} deleted successfully`);
            await fetchKarpenterResources();
          } else {
            message.error(`Failed to delete NodePool: ${data.error}`);
          }
        } catch (error) {
          console.error('Error deleting NodePool:', error);
          message.error(`Error deleting NodePool: ${error.message}`);
        }
      }
    });
  };

  const handleInstallKarpenter = async () => {
    try {
      setKarpenterInstalling(true);

      const response = await fetch('/api/cluster/karpenter/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterTag: activeCluster })
      });

      const data = await response.json();

      if (response.ok) {
        message.success('Karpenter installation started successfully');
        // 安装开始后刷新状态
        setTimeout(() => {
          fetchKarpenterStatus();
        }, 2000);
        // 注意：不在这里设置 setKarpenterInstalling(false)
        // 等待 WebSocket 消息或状态检查来确定安装完成
      } else {
        message.error(`Failed to start Karpenter installation: ${data.error}`);
        setKarpenterInstalling(false); // 只有在启动失败时才重置状态
      }
    } catch (error) {
      message.error(`Error starting Karpenter installation: ${error.message}`);
      setKarpenterInstalling(false); // 只有在请求失败时才重置状态
    }
  };

  const handleUninstallKarpenter = () => {
    Modal.confirm({
      title: 'Uninstall Karpenter',
      content: 'Are you sure you want to uninstall Karpenter? This will remove all Karpenter resources and managed nodes.',
      okText: 'Yes, Uninstall',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setKarpenterUninstalling(true);

          const response = await fetch('/api/cluster/karpenter/uninstall', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clusterTag: activeCluster })
          });

          const data = await response.json();

          if (response.ok) {
            message.success('Karpenter uninstallation started successfully');
            // 卸载开始后刷新状态
            setTimeout(() => {
              fetchKarpenterStatus();
            }, 2000);
            // 注意：不在这里设置 setKarpenterUninstalling(false)
            // 等待 WebSocket 消息来确定卸载完成
          } else {
            message.error(`Failed to start Karpenter uninstallation: ${data.error}`);
            setKarpenterUninstalling(false); // 只有在启动失败时才重置状态
          }
        } catch (error) {
          message.error(`Error starting Karpenter uninstallation: ${error.message}`);
          setKarpenterUninstalling(false); // 只有在请求失败时才重置状态
        }
      }
    });
  };

  const handleAddInstanceGroup = async () => {
    try {
      setAddInstanceGroupLoading(true);
      const values = await instanceGroupForm.validateFields();

      await dispatch(addInstanceGroup(values)).unwrap();

      message.success('Instance group addition initiated successfully');
      // 成功后关闭Modal并重置表单
      setAddInstanceGroupModalVisible(false);
      instanceGroupForm.resetFields();

    } catch (error) {
      console.error('Error adding instance group:', error);
      message.error(`Error adding instance group: ${error}`);
    } finally {
      setAddInstanceGroupLoading(false);
    }
  };

  const handleCreateHyperPod = async () => {
    try {
      const values = await hyperPodForm.validateFields();

      // 立即关闭Modal
      setCreateHyperPodModalVisible(false);
      hyperPodForm.resetFields();

      await dispatch(createHyperPod({ userConfig: values })).unwrap();
      
      // 立即获取完整的创建状态，避免显示空字段
      await dispatch(checkHyperPodCreationStatus());
      
      message.success('HyperPod creation initiated successfully');
    } catch (error) {
      message.error(`Error creating HyperPod cluster: ${error}`);
    }
  };

  const handleScale = (record, type) => {
    setScaleTarget({ ...record, type });

    if (type === 'eks') {
      form.setFieldsValue({
        minSize: record.scalingConfig.minSize,
        maxSize: record.scalingConfig.maxSize,
        desiredSize: record.scalingConfig.desiredSize
      });
    } else {
      form.setFieldsValue({
        targetCount: record.targetCount
      });
    }

    setScaleModalVisible(true);
  };

  const handleScaleSubmit = async () => {
    if (scaleLoading) return; // 防止重复点击

    try {
      setScaleLoading(true);
      const values = await form.validateFields();

      if (scaleTarget.type === 'eks') {
        await dispatch(scaleNodeGroup({
          name: scaleTarget.name,
          count: values.desiredSize,
          minSize: values.minSize,
          maxSize: values.maxSize
        })).unwrap();
      } else {
        const response = await fetch(`/api/cluster/hyperpod/instances/${scaleTarget.name}/scale`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values)
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || error.message || 'Unknown error');
        }
      }

      message.success(`${scaleTarget.type === 'eks' ? 'Node group' : 'Instance group'} scaling updated successfully`);
      setScaleModalVisible(false);
      form.resetFields();
      dispatch(fetchNodeGroups());

    } catch (error) {
      console.error('Error updating scaling:', error);
      message.error(`Error updating scaling: ${error.message || 'Unknown error'}`);
    } finally {
      setScaleLoading(false);
    }
  };

  const handleDeleteInstanceGroup = async (record) => {
    Modal.confirm({
      title: 'Delete Instance Group',
      content: `Are you sure you want to delete instance group "${record.name}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setDeleteLoading(true);
          setDeleteTarget(record.name);

          const response = await fetch('/api/cluster/hyperpod/delete-instance-group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceGroupName: record.name })
          });

          if (response.ok) {
            message.success(`Instance group "${record.name}" deletion initiated successfully`);
            dispatch(fetchNodeGroups());
          } else {
            const error = await response.json();
            message.error(`Failed to delete instance group: ${error.error || error.message || 'Unknown error'}`);
          }
        } catch (error) {
          console.error('Error deleting instance group:', error);
          message.error(`Error deleting instance group: ${error.message || 'Unknown error'}`);
        } finally {
          setDeleteLoading(false);
          setDeleteTarget(null);
        }
      }
    });
  };

  const handleUpdateSoftware = async (record) => {
    try {
      const response = await fetch('/api/cluster/hyperpod/update-software', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterArn: record.clusterArn })
      });

      if (response.ok) {
        message.success('HyperPod cluster software update initiated successfully');
        dispatch(fetchNodeGroups());
      } else {
        const error = await response.json();
        message.error(`Failed to update cluster software: ${error.error || error.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error in handleUpdateSoftware:', error);
      message.error(`Error updating cluster software: ${error.message || 'Unknown error'}`);
    }
  };

  const handleDeleteEksNodeGroup = async (nodeGroupName) => {
    Modal.confirm({
      title: 'Delete EKS Node Group',
      content: `Are you sure you want to delete the node group "${nodeGroupName}"? This action cannot be undone.`,
      okText: 'Yes, Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setEksDeleteLoading(true);
          setEksDeleteTarget(nodeGroupName);

          await dispatch(deleteNodeGroup(nodeGroupName)).unwrap();
          message.success(`NodeGroup ${nodeGroupName} deletion started`);

        } catch (error) {
          message.error(`Error deleting nodegroup: ${error}`);
        } finally {
          setEksDeleteLoading(false);
          setEksDeleteTarget(null);
        }
      }
    });
  };

  // 统一的完整刷新函数（包含必需的创建状态恢复） - fixed useCallback import
  const handleCompleteRefresh = useCallback(async () => {
    try {
      // 并行执行节点组刷新、创建状态恢复和Karpenter状态刷新
      await Promise.all([
        dispatch(fetchNodeGroups()),
        dispatch(checkHyperPodCreationStatus()), // 必需：恢复创建状态显示
        fetchKarpenterStatus(), // 加载Karpenter状态
        fetchKarpenterResources(), // 加载NodeClass/NodePool资源
        fetchHyperPodKarpenterStatus(), // 加载HyperPod Karpenter状态
        fetchHyperPodKarpenterResources(), // 加载HyperPod Karpenter资源
        fetchAvailableInstanceTypes(), // 加载实例类型
        fetchHyperPodSubnets(), // 加载HyperPod子网
        fetchSubnets() // 加载所有子网（用于 Add Instance Group）
      ]);
    } catch (error) {
      console.error('Error in complete refresh:', error);
    }
  }, [dispatch, fetchKarpenterStatus, fetchKarpenterResources, fetchHyperPodKarpenterStatus, fetchHyperPodKarpenterResources, fetchAvailableInstanceTypes, fetchHyperPodSubnets, fetchSubnets]);

  // 注册到全局刷新管理器
  useEffect(() => {
    const componentId = 'node-group-manager-redux';

    globalRefreshManager.subscribe(componentId, handleCompleteRefresh, {
      priority: 6
    });

    return () => {
      globalRefreshManager.unsubscribe(componentId);
    };
  }, [handleCompleteRefresh]);

  // 移除错误的 globalRefreshManager 订阅
  // Karpenter 状态应该通过用户主动刷新来获取，而不是 WebSocket 推送
  // globalRefreshManager 只用于管理前端组件的刷新，不用于集群资源状态订阅

  // Initial data loading
  // 使用 ref 来跟踪是否已经执行过初始加载
  const hasInitiallyLoaded = useRef(false);

  // 初始加载 - 只在组件挂载时执行一次
  useEffect(() => {
    if (!hasInitiallyLoaded.current) {
      hasInitiallyLoaded.current = true;
      handleCompleteRefresh();
    }
  }, []); // 完全空的依赖数组

  // Response to external triggers
  useEffect(() => {
    if (refreshTrigger > 0) {
      handleCompleteRefresh(); // 使用完整刷新链路
    }
  }, [refreshTrigger, handleCompleteRefresh]);

  // Response to activeCluster changes
  useEffect(() => {
    if (activeCluster) {
      handleCompleteRefresh(); // 使用完整刷新链路

      // Reset operation statuses
      dispatch(clearHyperPodCreationStatus());
      dispatch(clearNodeGroupOperationStatus());
    }
  }, [activeCluster, handleCompleteRefresh, dispatch]);

  const renderStatus = (status) => {
    const statusColors = {
      'ACTIVE': 'green',
      'InService': 'green',
      'CREATING': 'blue',
      'UPDATING': 'orange',
      'DELETING': 'red',
      'CREATE_FAILED': 'red',
      'DELETE_FAILED': 'red'
    };
    return <Tag color={statusColors[status] || 'default'}>{status}</Tag>;
  };

  const renderScaling = (record) => {
    const { minSize, maxSize, desiredSize } = record.scalingConfig || {};
    return `${minSize}/${maxSize}/${desiredSize}`;
  };

  const renderCount = (record) => {
    return `${record.currentCount}/${record.targetCount}`;
  };

  const renderEKSActions = (record) => (
    <Space>
      <Button
        size="small"
        icon={<EditOutlined />}
        onClick={() => handleScale(record, 'eks')}
      >
        Scale
      </Button>
      <Button
        size="small"
        danger
        icon={<DeleteOutlined />}
        loading={eksDeleteLoading && eksDeleteTarget === record.name}
        onClick={() => handleDeleteEksNodeGroup(record.name)}
      >
        Delete
      </Button>
    </Space>
  );

  const renderHyperPodActions = (record) => (
    <Space>
      <Button
        size="small"
        icon={<EditOutlined />}
        onClick={() => handleScale(record, 'hyperpod')}
      >
        Scale
      </Button>
      <Button
        size="small"
        icon={<DeleteOutlined />}
        danger
        loading={deleteLoading && deleteTarget === record.name}
        onClick={() => handleDeleteInstanceGroup(record)}
      >
        Delete
      </Button>
    </Space>
  );

  // 渲染HyperPod集群级操作按钮
  const renderHyperPodClusterActions = () => {
    // 只有当HyperPod存在且没有创建状态时才显示集群级操作
    if (hyperPodGroups.length === 0 || hyperPodCreationStatus) return null;

    // 获取第一个Instance Group的集群信息（所有Instance Group属于同一个集群）
    const clusterInfo = hyperPodGroups[0];

    return (
      <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#fafafa', border: '1px solid #d9d9d9', borderRadius: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Text strong>HyperPod Cluster: {clusterInfo.clusterName}</Text>
            <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
              Cluster-level operations affect all instance groups
            </div>
          </div>
          <Space>
            <Button
              icon={<ToolOutlined />}
              onClick={() => handleUpdateSoftware(clusterInfo)}
            >
              Update Cluster Software
            </Button>
          </Space>
        </div>
      </div>
    );
  };

  const eksColumns = [
    { title: 'Node Group Name', dataIndex: 'name', key: 'name' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: renderStatus },
    { title: 'Instance Types', dataIndex: 'instanceTypes', key: 'instanceTypes', render: types => types?.join(', ') },
    { 
      title: 'Capacity Type', 
      dataIndex: 'capacityType', 
      key: 'capacityType',
      render: (capacityType) => {
        if (!capacityType) return <Tag color="orange">Spot</Tag>;
        const type = capacityType.toLowerCase();
        return (
          <Tag color={type === 'on_demand' || type === 'on-demand' ? 'green' : 'orange'}>
            {type === 'on_demand' || type === 'on-demand' ? 'OD' : 'Spot'}
          </Tag>
        );
      }
    },
    { title: 'Min/Max/Desired', key: 'scaling', render: renderScaling },
    { title: 'Actions', key: 'actions', render: renderEKSActions }
  ];

  const hyperPodColumns = [
    { title: 'Instance Group Name', dataIndex: 'name', key: 'name' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: renderStatus },
    { title: 'Instance Type', dataIndex: 'instanceType', key: 'instanceType' },
    { 
      title: 'Capacity Type', 
      dataIndex: 'capacityType', 
      key: 'capacityType',
      render: (capacityType, record) => {
        const type = capacityType ? capacityType.toLowerCase() : 'on-demand';
        const isManaged = hyperpodKarpenterResources.managedInstanceGroups && 
                         hyperpodKarpenterResources.managedInstanceGroups.includes(record.name);
        
        return (
          <Space>
            <Tag color={type === 'spot' ? 'orange' : 'green'}>
              {type === 'spot' ? 'Spot' : 'OD'}
            </Tag>
            {isManaged && (
              <Tag color="blue">Karpenter</Tag>
            )}
          </Space>
        );
      }
    },
    { title: 'Current/Target', key: 'count', render: renderCount },
    { title: 'Actions', key: 'actions', render: renderHyperPodActions }
  ];

  return (
    <div style={{ height: '100%' }}>
      <div style={{ marginBottom: '16px', textAlign: 'right' }}>
        <Button
          icon={<ReloadOutlined />}
          onClick={handleCompleteRefresh}
          loading={loading}
          size="small"
        >
          Refresh Node Groups
        </Button>
      </div>

      <Card
        title="HyperPod Instance Groups"
        style={{ marginBottom: '16px' }}
        size="small"
        extra={
          <Space>
            <Button
              type="default"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => {
                setAddInstanceGroupModalVisible(true);
                fetchClusterInfo(); // 确保获取最新信息
              }}
              disabled={
                !!hyperPodCreationStatus ||  // 创建中时禁用
                !!hyperPodDeletionStatus ||  // 删除中时禁用
                hyperPodGroups.length === 0 ||   // 没有HyperPod时禁用
                addInstanceGroupLoading      // 添加中时禁用
              }
              loading={addInstanceGroupLoading}
              title={
                hyperPodCreationStatus
                  ? "HyperPod creation in progress"
                  : hyperPodDeletionStatus
                    ? "HyperPod deletion in progress"
                    : hyperPodGroups.length === 0
                      ? "No HyperPod cluster exists"
                      : addInstanceGroupLoading
                        ? "Adding instance group..."
                        : "Add instance group to existing HyperPod cluster"
              }
            >
              Add Instance Group
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              size="small"
              onClick={() => {
                setCreateHyperPodModalVisible(true);
                fetchClusterInfo(); // 确保获取最新信息
              }}
              disabled={
                !effectiveDependenciesConfigured ||   // 依赖未配置时禁用
                !!hyperPodCreationStatus ||  // 创建中时禁用
                !!hyperPodDeletionStatus ||  // 删除中时禁用
                hyperPodGroups.length > 0    // 已存在HyperPod时禁用
              }
              loading={hyperPodCreationStatus === 'creating'}
              title={
                !effectiveDependenciesConfigured
                  ? "Dependencies must be configured first"
                  : hyperPodCreationStatus
                    ? "HyperPod creation in progress"
                    : hyperPodDeletionStatus
                      ? "HyperPod deletion in progress"
                      : hyperPodGroups.length > 0
                        ? "HyperPod cluster already exists in this EKS cluster"
                        : "Create HyperPod cluster"
              }
            >
              Create HyperPod
            </Button>
            {/* Delete HyperPod 按钮已隐藏 (2025-12-03) - 后端 API 仍保留: DELETE /api/cluster/:clusterTag/hyperpod */}
            {/* {hyperPodGroups.length > 0 && (() => {
              const isImportedWithHyperPod = cluster?.type === 'imported' && cluster?.hasHyperPod;
              return (
                <Button
                  type="default"
                  danger
                  size="small"
                  loading={hyperPodDeletionStatus === 'deleting'}
                  onClick={handleDeleteHyperPod}
                  disabled={
                    !!hyperPodCreationStatus ||
                    !!hyperPodDeletionStatus ||
                    isImportedWithHyperPod
                  }
                  title={
                    isImportedWithHyperPod
                      ? "Cannot delete HyperPod cluster from imported EKS+HyperPod setup"
                      : "Delete HyperPod cluster and all instance groups"
                  }
                >
                  Delete HyperPod
                </Button>
              );
            })()} */}
          </Space>
        }
      >
        {hyperPodCreationStatus && typeof hyperPodCreationStatus === 'object' && hyperPodCreationStatus.stackName && (
          <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: '6px' }}>
            <Space>
              <Tag color="processing">Creating</Tag>
              <span>HyperPod Cluster: {hyperPodCreationStatus.stackName}</span>
              <span>Phase: {hyperPodCreationStatus.phase}</span>
              <span>Status: {hyperPodCreationStatus.cfStatus || hyperPodCreationStatus.status}</span>
            </Space>
          </div>
        )}

        {/* HyperPod集群级操作 */}
        {renderHyperPodClusterActions()}

        {hyperPodGroups.length === 0 && !hyperPodCreationStatus && (
          <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: '#fff7e6', border: '1px solid #ffd591', borderRadius: '6px' }}>
            <Space>
              <Tag color="orange">Not Found</Tag>
              <span>No HyperPod cluster exists in this EKS cluster</span>
            </Space>
          </div>
        )}
        <Table
          columns={hyperPodColumns}
          dataSource={hyperPodGroups}
          rowKey="name"
          loading={loading}
          size="small"
          pagination={false}
          locale={{ emptyText: 'No HyperPod and Instance groups' }}
          style={{ minHeight: hyperPodGroups.length === 0 ? '60px' : 'auto' }}
        />
      </Card>

      {/* HyperPod Karpenter Resources */}
      <Card
        title="HyperPod Karpenter Resources"
        size="small"
        style={{ marginTop: 16, marginBottom: 16 }}
        extra={
          <Space>
            {hyperpodKarpenterStatus.installed && (
              <Button
                type="default"
                size="small"
                icon={<PlusOutlined />}
                disabled={hyperPodGroups.length === 0}
                onClick={() => setHyperpodKarpenterResourceModalVisible(true)}
                title="Add HyperPod Karpenter Resource"
              >
                Add Resource
              </Button>
            )}
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              loading={hyperpodKarpenterInstalling}
              disabled={hyperPodGroups.length === 0 || hyperpodKarpenterInstalling || hyperpodKarpenterStatus.installed}
              onClick={handleInstallHyperPodKarpenter}
              title={
                hyperpodKarpenterStatus.installed
                  ? "HyperPod Karpenter already installed"
                  : hyperPodGroups.length === 0
                    ? "HyperPod cluster must exist"
                    : "Install HyperPod Karpenter"
              }
            >
              Install HyperPod Karpenter
            </Button>
          </Space>
        }
      >
        <Table
          dataSource={hyperpodKarpenterResources.nodePools}
          columns={[
            {
              title: 'NodePool',
              dataIndex: 'name',
              key: 'name',
              render: (text) => <Text strong>{text}</Text>
            },
            {
              title: 'HyperpodNodeClass',
              dataIndex: 'nodeClassRef',
              key: 'nodeClassRef',
              render: (text) => <Text>{text}</Text>
            },
            {
              title: 'Status',
              dataIndex: 'status',
              key: 'status',
              render: (status) => (
                <Tag color={status === 'Ready' ? 'success' : 'default'}>
                  {status}
                </Tag>
              )
            },
            {
              title: 'Instance Group',
              dataIndex: 'nodeClassRef',
              key: 'instanceGroup',
              render: (nodeClassRef) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                return nodeClass && nodeClass.instanceGroups.length > 0 ? (
                  <Text>{nodeClass.instanceGroups.join(', ')}</Text>
                ) : '-';
              }
            },
            {
              title: 'Instance Types',
              dataIndex: 'nodeClassRef',
              key: 'instanceTypes',
              render: (nodeClassRef) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                if (!nodeClass || nodeClass.instanceTypes.length === 0) return '-';
                return <Text>{nodeClass.instanceTypes.join(', ')}</Text>;
              }
            },
            {
              title: 'Capacity Type',
              dataIndex: 'nodeClassRef',
              key: 'capacityType',
              render: (nodeClassRef) => {
                const nodeClass = hyperpodKarpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                if (!nodeClass) return '-';
                const capacityType = nodeClass.capacityType;
                return (
                  <Tag color={capacityType === 'on-demand' ? 'green' : 'orange'}>
                    {capacityType === 'on-demand' ? 'OD' : 'Spot'}
                  </Tag>
                );
              }
            },
            {
              title: 'Actions',
              key: 'actions',
              width: 80,
              render: (_, record) => (
                <Button
                  size="small"
                  danger
                  loading={deletingNodePool === record.name}
                  disabled={deletingNodePool !== null}
                  onClick={async () => {
                    setDeletingNodePool(record.name);
                    try {
                      const response = await fetch(`/api/cluster/hyperpod-karpenter/nodepool/${record.name}`, {
                        method: 'DELETE'
                      });
                      const data = await response.json();
                      
                      if (response.ok) {
                        message.success(`NodePool ${record.name} deleted`);
                        await fetchHyperPodKarpenterResources();
                      } else {
                        message.error(`Failed to delete: ${data.error || 'Unknown error'}`);
                      }
                    } catch (error) {
                      console.error('Error deleting NodePool:', error);
                      message.error(`Error: ${error.message}`);
                    } finally {
                      setDeletingNodePool(null);
                    }
                  }}
                >
                  Delete
                </Button>
              )
            }
          ]}
          rowKey="name"
          size="small"
          pagination={false}
          loading={hyperpodKarpenterLoading}
          locale={{ emptyText: 'No HyperPod Karpenter Resources' }}
          style={{ minHeight: hyperpodKarpenterResources.nodePools.length === 0 ? '60px' : 'auto' }}
        />
      </Card>

      <Card
        title="EKS Node Groups"
        size="small"
        extra={
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => setCreateEksNodeGroupModalVisible(true)}
            disabled={!effectiveDependenciesConfigured}
            title={
              !effectiveDependenciesConfigured
                ? "Dependencies must be configured first"
                : "Create Node Group"
            }
          >
            Create Node Group
          </Button>
        }
        style={{ display: process.env.REACT_APP_DEMO_EKSNG === 'false' ? 'none' : 'block' }}
      >
        <Table
          columns={eksColumns}
          dataSource={eksNodeGroups}
          rowKey="name"
          loading={loading}
          size="small"
          pagination={false}
          locale={{ emptyText: eksNodeGroups.length === 0 ? 'No EKS node groups' : 'No data' }}
          style={{ minHeight: eksNodeGroups.length === 0 ? '60px' : 'auto' }}
        />
      </Card>

      <Card
        title="EC2 Karpenter Resources"
        size="small"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            {/* 未安装时显示安装按钮 */}
            {karpenterStatus && !karpenterStatus.installed && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                size="small"
                loading={karpenterInstalling}
                disabled={hyperPodGroups.length === 0 || karpenterInstalling}
                onClick={handleInstallKarpenter}
                title={
                  hyperPodGroups.length === 0
                    ? "HyperPod cluster must exist to install Karpenter"
                    : karpenterInstalling
                      ? "Installing Karpenter..."
                      : "Install Karpenter auto-scaling system"
                }
              >
                Install Karpenter
              </Button>
            )}

            {/* 已安装时显示管理按钮 */}
            {karpenterStatus?.installed && (
              <>
                <Button
                  size="small"
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => {
                    setNodeClassModalVisible(true);
                    fetchHyperPodSubnets();

                    // 确保每次打开时都是干净状态
                    setSelectedSubnet(null);
                    setFilteredInstanceTypes([]);
                    setIsLoadingSubnetTypes(false);
                  }}
                  title="Create EC2 Node Definition (NodeClass and NodePool)"
                >
                  Create EC2 Node Definition
                </Button>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    fetchKarpenterResources();
                  }}
                  title="Refresh Karpenter resources"
                >
                  Refresh
                </Button>
                <Button
                  size="small"
                  type="default"
                  danger
                  onClick={handleUninstallKarpenter}
                  loading={karpenterUninstalling}
                  title="Uninstall Karpenter"
                >
                  Uninstall
                </Button>
              </>
            )}
          </Space>
        }
      >
        {/* 未安装状态 Banner - 只有当 karpenterStatus 已加载且未安装时才显示 */}
        {karpenterStatus && !karpenterStatus.installed && (
          <div style={{
            backgroundColor: '#fff7e6',
            border: '1px solid #ffd591',
            borderRadius: '8px',
            padding: '12px',
            marginBottom: '16px'
          }}>
            <Space align="center">
              <ToolOutlined style={{ color: '#fa8c16' }} />
              <Text>Karpenter auto-scaling is not installed</Text>
            </Space>
            {hyperPodGroups.length === 0 && (
              <div style={{
                marginTop: '8px',
                fontSize: '12px',
                color: '#8c8c8c'
              }}>
                Please create a HyperPod cluster first before installing Karpenter
              </div>
            )}
          </div>
        )}

        {/* 已安装状态 - Karpenter 资源管理 */}
        {karpenterStatus && !karpenterResourcesLoading && (
          <div>
            {/* Karpenter NodePool 展示区域（包含 NodeClass 信息作为列）*/}
            <div style={{ marginTop: 16 }}>
              <Table
                dataSource={karpenterStatus.installed ? karpenterResources.nodePools : []}
                columns={[
                    {
                      title: 'Node Pool',
                      dataIndex: 'name',
                      key: 'name',
                      render: (text) => <Text strong>{text}</Text>
                    },
                    {
                      title: 'Ec2NodeClass',
                      dataIndex: 'nodeClassRef',
                      key: 'nodeClassRef',
                      render: (nodeClassRef) => (
                        <Tag color="blue">{nodeClassRef}</Tag>
                      )
                    },
                    {
                      title: 'Instance Types',
                      dataIndex: 'instanceTypes',
                      key: 'instanceTypes',
                      render: (instanceTypes) => (
                        <div>
                          {instanceTypes && instanceTypes.length > 0 ? (
                            <div>
                              {instanceTypes.slice(0, 3).map(type => (
                                <Tag key={type} size="small">{type}</Tag>
                              ))}
                              {instanceTypes.length > 3 && (
                                <Tag size="small">+{instanceTypes.length - 3} more</Tag>
                              )}
                            </div>
                          ) : (
                            <Text type="secondary">Any</Text>
                          )}
                        </div>
                      )
                    },
                    {
                      title: 'Capacity Type',
                      dataIndex: 'capacityTypes',
                      key: 'capacityTypes',
                      render: (capacityTypes) => (
                        <div>
                          {capacityTypes && capacityTypes.length > 0 ? (
                            // 确保显示顺序：先Spot，再OD
                            [...capacityTypes].sort((a, b) => {
                              if (a === 'spot' && b === 'on-demand') return -1;
                              if (a === 'on-demand' && b === 'spot') return 1;
                              return 0;
                            }).map(type => (
                              <Tag key={type} color={type === 'on-demand' ? 'green' : 'orange'} style={{ marginRight: 4, marginBottom: 2 }}>
                                {type === 'on-demand' ? 'OD' : 'Spot'}
                              </Tag>
                            ))
                          ) : (
                            <Tag color="orange">Spot</Tag>
                          )}
                        </div>
                      )
                    },
                    {
                      title: 'EBS Volume',
                      dataIndex: 'nodeClassRef',
                      key: 'ebsVolume',
                      render: (nodeClassRef) => {
                        // 查找对应的 NodeClass 详细信息
                        const nodeClass = karpenterResources.nodeClasses.find(nc => nc.name === nodeClassRef);
                        return nodeClass ? `${nodeClass.volumeSize}` : 'N/A';
                      }
                    },
                    {
                      title: 'Max GPU Limit',
                      dataIndex: 'gpuLimit',
                      key: 'gpuLimit',
                      render: (text) => text || 'Not Set'
                    },
                    {
                      title: 'Weight',
                      dataIndex: 'weight',
                      key: 'weight',
                      render: (text) => text || 100
                    },
                    {
                      title: 'Actions',
                      key: 'actions',
                      width: 80,
                      render: (_, record) => (
                        <Button
                          size="small"
                          danger
                          onClick={() => handleDeleteNodePool(record.name)}
                          title="Delete NodePool"
                        >
                          Delete
                        </Button>
                      )
                    }
                  ]}
                  rowKey="name"
                  size="small"
                  pagination={false}
                  locale={{ emptyText: 'No EC2 Karpenter Resources' }}
                  style={{ minHeight: karpenterResources.nodePools.length === 0 ? '60px' : 'auto' }}
                />
            </div>
          </div>
        )}

        {/* 当 karpenterStatus 正在加载或 karpenterResources 正在加载时显示 loading */}
        {(!karpenterStatus || karpenterResourcesLoading) && (
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Spin tip="Loading Karpenter information..." />
          </div>
        )}
      </Card>

      <Modal
        title={`Scale ${scaleTarget?.type === 'eks' ? 'EKS Node Group' : 'HyperPod Instance Group'}: ${scaleTarget?.name}`}
        open={scaleModalVisible}
        onOk={handleScaleSubmit}
        onCancel={() => {
          if (scaleLoading) return; // 防止loading时关闭
          setScaleModalVisible(false);
          form.resetFields();
        }}
        okText="Update"
        confirmLoading={scaleLoading}
        cancelButtonProps={{ disabled: scaleLoading }}
      >
        <Form form={form} layout="vertical">
          {scaleTarget?.type === 'eks' ? (
            <>
              <Form.Item
                name="minSize"
                label="Minimum Size"
                rules={[{ required: true, message: 'Please input minimum size' }]}
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="maxSize"
                label="Maximum Size"
                rules={[{ required: true, message: 'Please input maximum size' }]}
              >
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="desiredSize"
                label="Desired Size"
                rules={[{ required: true, message: 'Please input desired size' }]}
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </>
          ) : (
            <Form.Item
              name="targetCount"
              label="Target Count"
              rules={[{ required: true, message: 'Please input target count' }]}
            >
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title="Create HyperPod Cluster"
        open={createHyperPodModalVisible}
        onOk={handleCreateHyperPod}
        onCancel={() => {
          setCreateHyperPodModalVisible(false);
          hyperPodForm.resetFields();
        }}
        okText="Create"
        width={700}
      >
        <Form form={hyperPodForm} layout="vertical">
          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item
              label="EKS Cluster Name"
              style={{ flex: 1 }}
            >
              <Input value={clusterInfo.eksClusterName} disabled />
            </Form.Item>

            <Form.Item
              label="Region"
              style={{ flex: 1 }}
            >
              <Input value={clusterInfo.region} disabled />
            </Form.Item>
          </div>

          <Form.Item
            name="clusterTag"
            label="Cluster Tag"
            rules={[{ required: true, message: 'Please input cluster tag' }]}
            extra="Used for resource naming (stack, cluster, node groups)"
          >
            <Input placeholder="my-hyperpod" />
          </Form.Item>

          <Form.Item
            name="AcceleratedInstanceType"
            label="Instance Type"
            initialValue="ml.g5.8xlarge"
            rules={[{ required: true, message: 'Please select or input instance type' }]}
          >
            <AutoComplete
              placeholder="Select or type instance type"
              options={[
                { value: 'ml.g5.8xlarge', label: 'ml.g5.8xlarge' },
                { value: 'ml.g5.12xlarge', label: 'ml.g5.12xlarge' },
                { value: 'ml.g5.24xlarge', label: 'ml.g5.24xlarge' },
                { value: 'ml.g5.48xlarge', label: 'ml.g5.48xlarge' },
                { value: 'ml.g6.8xlarge', label: 'ml.g6.8xlarge' },
                { value: 'ml.g6.12xlarge', label: 'ml.g6.12xlarge' },
                { value: 'ml.g6.24xlarge', label: 'ml.g6.24xlarge' },
                { value: 'ml.g6.48xlarge', label: 'ml.g6.48xlarge' },
                { value: 'ml.g6e.8xlarge', label: 'ml.g6e.8xlarge' },
                { value: 'ml.g6e.12xlarge', label: 'ml.g6e.12xlarge' },
                { value: 'ml.g6e.24xlarge', label: 'ml.g6e.24xlarge' },
                { value: 'ml.g6e.48xlarge', label: 'ml.g6e.48xlarge' },
                { value: 'ml.p4d.24xlarge', label: 'ml.p4d.24xlarge' },
                { value: 'ml.p5.48xlarge', label: 'ml.p5.48xlarge' },
                { value: 'ml.p5en.48xlarge', label: 'ml.p5en.48xlarge' },
                { value: 'ml.p6-b200.48xlarge', label: 'ml.p6-b200.48xlarge' }
              ]}
              filterOption={(inputValue, option) =>
                option.value.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
              }
            />
          </Form.Item>

          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item
              name="AcceleratedInstanceCount"
              label="Instance Count"
              initialValue={1}
              rules={[{ required: true, message: 'Please input instance count' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>

            <Form.Item
              name="AcceleratedEBSVolumeSize"
              label="EBS Volume Size (GB)"
              initialValue={500}
              rules={[{ required: true, message: 'Please input EBS volume size' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={100} max={10000} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item
            name="availabilityZone"
            label="Availability Zone"
            rules={[{ required: true, message: 'Please select availability zone' }]}
          >
            <Select placeholder="Select availability zone">
              {availabilityZones.map(zone => (
                <Select.Option key={zone.ZoneName} value={zone.ZoneName}>
                  {zone.ZoneName} ({zone.ZoneId})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="AcceleratedTrainingPlanArn"
            label="Flexible Training Plan ARN (Optional)"
            extra="Leave empty if not using flexible training plan"
          >
            <Input placeholder="arn:aws:sagemaker:region:account:training-plan/..." />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Add Instance Group"
        open={addInstanceGroupModalVisible}
        onOk={handleAddInstanceGroup}
        onCancel={() => {
          if (addInstanceGroupLoading) return; // 防止loading时关闭
          setAddInstanceGroupModalVisible(false);
          instanceGroupForm.resetFields();
        }}
        okText="Add Instance Group"
        confirmLoading={addInstanceGroupLoading}
        cancelButtonProps={{ disabled: addInstanceGroupLoading }}
        width={700}
      >
        <Form form={instanceGroupForm} layout="vertical">
          <Form.Item
            name="instanceGroupName"
            label="Instance Group Name"
            rules={[{ required: true, message: 'Please input instance group name' }]}
            extra="Name for the new instance group"
          >
            <Input placeholder="compute-group-new" />
          </Form.Item>

          <div style={{ display: 'flex', gap: '16px' }}>
            <Form.Item
              name="instanceType"
              label="Instance Type"
              rules={[{ required: true, message: 'Please select or input instance type' }]}
              style={{ flex: 1 }}
            >
              <AutoComplete
                placeholder="Select or type instance type"
                options={[
                  { value: 'ml.g5.8xlarge', label: 'ml.g5.8xlarge' },
                  { value: 'ml.g5.12xlarge', label: 'ml.g5.12xlarge' },
                  { value: 'ml.g5.24xlarge', label: 'ml.g5.24xlarge' },
                  { value: 'ml.g5.48xlarge', label: 'ml.g5.48xlarge' },
                  { value: 'ml.g6.8xlarge', label: 'ml.g6.8xlarge' },
                  { value: 'ml.g6.12xlarge', label: 'ml.g6.12xlarge' },
                  { value: 'ml.g6.24xlarge', label: 'ml.g6.24xlarge' },
                  { value: 'ml.g6.48xlarge', label: 'ml.g6.48xlarge' },
                  { value: 'ml.g6e.8xlarge', label: 'ml.g6e.8xlarge' },
                  { value: 'ml.g6e.12xlarge', label: 'ml.g6e.12xlarge' },
                  { value: 'ml.g6e.24xlarge', label: 'ml.g6e.24xlarge' },
                  { value: 'ml.g6e.48xlarge', label: 'ml.g6e.48xlarge' },
                  { value: 'ml.p4d.24xlarge', label: 'ml.p4d.24xlarge' },
                  { value: 'ml.p5.48xlarge', label: 'ml.p5.48xlarge' },
                  { value: 'ml.p5en.48xlarge', label: 'ml.p5en.48xlarge' },
                  { value: 'ml.p6-b200.48xlarge', label: 'ml.p6-b200.48xlarge' }
                ]}
                filterOption={(inputValue, option) =>
                  option.value.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
                }
              />
            </Form.Item>

            <Form.Item
              name="instanceCount"
              label="Instance Count"
              initialValue={1}
              rules={[{ required: true, message: 'Please input instance count' }]}
              style={{ flex: 1 }}
            >
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item
            name="subnetId"
            label="Subnet"
            rules={[{ required: true, message: 'Please select subnet' }]}
            extra="Select the subnet for this instance group"
          >
            <Select placeholder="Select subnet" loading={!subnets.privateSubnets.length}>
              {subnets.privateSubnets.map(subnet => (
                <Select.Option key={subnet.subnetId} value={subnet.subnetId}>
                  {subnet.name} ({subnet.isHyperPodSubnet ? 'HyperPod' : 'Private'}) - {subnet.availabilityZone} - {subnet.cidrBlock}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            name="volumeSize"
            label="EBS Volume Size (GB)"
            initialValue={300}
            rules={[{ required: true, message: 'Please input volume size' }]}
            extra="EBS volume size in GB"
          >
            <InputNumber min={100} max={16000} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            name="isSpot"
            label="Use HyperPod Spot Instances"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="trainingPlanArn"
            label="Training Plan ARN (Optional)"
            extra="Provide Training Plan ARN if already in valid state."
          >
            <Input placeholder="arn:aws:sagemaker:region:account:training-plan/..." />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Create EKS Node Group"
        open={createEksNodeGroupModalVisible}
        onCancel={() => setCreateEksNodeGroupModalVisible(false)}
        footer={null}
        width={600}
      >
        <EksNodeGroupCreationPanel
          onCreated={() => {
            setCreateEksNodeGroupModalVisible(false);
            dispatch(fetchNodeGroups());
          }}
        />
      </Modal>

      {/* Karpenter 资源创建模态框 */}
      <Modal
        title="Create EC2 Node Definition"
        open={nodeClassModalVisible}
        onOk={() => karpenterResourceForm.submit()}
        onCancel={() => {
          if (createKarpenterResourceLoading) return;
          setNodeClassModalVisible(false);
          karpenterResourceForm.resetFields();

          // 重置子网相关状态
          setSelectedSubnet(null);
          setFilteredInstanceTypes([]);
          setIsLoadingSubnetTypes(false);
        }}
        okText="Create Resource"
        confirmLoading={createKarpenterResourceLoading}
        cancelButtonProps={{ disabled: createKarpenterResourceLoading }}
        width={800}
      >
        <Form
          form={karpenterResourceForm}
          layout="vertical"
          onFinish={handleCreateKarpenterResource}
          initialValues={{
            capacityType: 'spot',
            nodePoolWeight: 100,
            gpuLimit: 50,
            volumeSize: 200
          }}
        >
          {/* Karpenter Node Configuration 区域 */}
          <Card
            title={
              <Space>
                <CloudServerOutlined />
                <span>Karpenter Node Configuration</span>
              </Space>
            }
            style={{ marginBottom: 16 }}
          >
            {/* 资源名称输入 */}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={24}>
                <Form.Item
                  name="resourceName"
                  label="Resource Name"
                  rules={[
                    { required: true, message: 'Please input resource name' },
                    { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Name must be lowercase alphanumeric with hyphens' }
                  ]}
                  extra="This will be used as the base name for both NodeClass and NodePool"
                >
                  <Input placeholder="e.g., my-gpu-nodes" />
                </Form.Item>
              </Col>
            </Row>

            {/* Subnet Selection - 移到实例类型之前 */}
            <Row gutter={16}>
              <Col span={24}>
                <Form.Item
                  label={
                    <Space>
                      <span>Subnet Selection</span>
                      <Tooltip title="Choose a specific subnet for Karpenter nodes. Select HyperPod subnet for better network locality">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="specificSubnet"
                  rules={[{ required: true, message: 'Please select a subnet' }]}
                >
                  <Select
                    placeholder="Select a subnet"
                    allowClear
                    loading={subnetsLoading}
                    disabled={subnetsLoading}
                    onChange={handleSubnetChangeForInstanceTypes}
                  >
                    {hyperPodSubnets.map(subnet => (
                      <Select.Option key={subnet.subnetId} value={subnet.subnetId}>
                        {subnet.name} (HyperPod) - {subnet.availabilityZone}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            {/* Instance Types - 现在基于选中的子网显示 */}
            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={24}>
                <Form.Item
                  label={
                    <Space>
                      <span>Available GPU Instance Types</span>
                      <Tooltip title="Select instance types available in the selected subnet">
                        <InfoCircleOutlined />
                      </Tooltip>
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={selectedSubnet ? () => handleSubnetChangeForInstanceTypes(selectedSubnet) : refreshInstanceTypes}
                        loading={instanceTypesLoading}
                        type={refreshError ? "primary" : "default"}
                        disabled={!selectedSubnet}
                      >
                        {refreshError ? 'Fetch from AWS' : 'Refresh'}
                      </Button>
                    </Space>
                  }
                >
                  {selectedSubnet ? (
                    renderInstanceTypeCheckboxes()
                  ) : (
                    <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                      <InfoCircleOutlined style={{ fontSize: '24px', marginBottom: '8px' }} />
                      <div>Please select a subnet first to view available instance types</div>
                    </div>
                  )}
                </Form.Item>
              </Col>
            </Row>

            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={12}>
                <Form.Item
                  label={
                    <Space>
                      <span>Capacity Type</span>
                      <Tooltip title="Choose instance capacity type for this NodePool">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="capacityType"
                  rules={[{ required: true, message: 'Please select capacity type' }]}
                >
                  <Select placeholder="Select capacity type">
                    <Select.Option value="spot">Spot Only (Cost-optimized)</Select.Option>
                    <Select.Option value="on-demand">On-Demand Only (Reliable)</Select.Option>
                    <Select.Option value="both">Both (Spot preferred)</Select.Option>
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={
                    <Space>
                      <span>NodePool Weight</span>
                      <Tooltip title="Higher weight means higher priority when multiple NodePools are available">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="nodePoolWeight"
                  rules={[{ required: true, message: 'Please input NodePool weight' }]}
                >
                  <InputNumber
                    min={1}
                    max={100}
                    style={{ width: '100%' }}
                    placeholder="100"
                  />
                </Form.Item>
              </Col>
            </Row>


            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={12}>
                <Form.Item
                  label={
                    <Space>
                      <span>Max GPU Limit</span>
                      <Tooltip title="Maximum number of GPUs that this NodePool can provision">
                        <InfoCircleOutlined />
                      </Tooltip>
                    </Space>
                  }
                  name="gpuLimit"
                  rules={[{ required: true, message: 'Please input GPU limit' }]}
                >
                  <InputNumber
                    min={1}
                    max={1000}
                    style={{ width: '100%' }}
                    placeholder="e.g., 50"
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="volumeSize"
                  label="EBS Volume Size (GB)"
                  rules={[{ required: true, message: 'Please input volume size' }]}
                  extra="Root volume size for each node"
                >
                  <InputNumber min={20} max={1000} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
          </Card>

        </Form>
      </Modal>

      {/* HyperPod Karpenter Resource Modal */}
      <Modal
        title="Add HyperPod Karpenter Resource"
        open={hyperpodKarpenterResourceModalVisible}
        onOk={handleCreateHyperPodKarpenterResource}
        onCancel={() => {
          setHyperpodKarpenterResourceModalVisible(false);
          setSelectedInstanceGroups([]);
        }}
        confirmLoading={hyperpodKarpenterResourceCreating}
        width={600}
      >
        <div style={{ marginBottom: 16 }}>
          <Text>Select HyperPod Instance Groups (On-Demand only):</Text>
        </div>
        <Checkbox.Group
          value={selectedInstanceGroups}
          onChange={setSelectedInstanceGroups}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {hyperPodGroups
              .filter(group => group.capacityType === 'on-demand')
              .map(group => (
                <Checkbox key={group.name} value={group.name}>
                  <Space>
                    <Text strong>{group.name}</Text>
                    <Tag>{group.instanceType}</Tag>
                    <Tag color="green">OD</Tag>
                    <Text type="secondary">({group.currentCount} nodes)</Text>
                  </Space>
                </Checkbox>
              ))}
          </Space>
        </Checkbox.Group>
        {hyperPodGroups.filter(g => g.capacityType === 'on-demand').length === 0 && (
          <Text type="secondary">No On-Demand instance groups available</Text>
        )}
      </Modal>

    </div>
  );
};

export default NodeGroupManagerRedux;