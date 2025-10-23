import React, { useState, useEffect } from 'react';
import { Card, Table, Button, message, Tag, Space, Modal, InputNumber, Form, Select, Input, Typography, AutoComplete } from 'antd';
import { ReloadOutlined, EditOutlined, ToolOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import globalRefreshManager from '../hooks/useGlobalRefresh';
import operationRefreshManager from '../hooks/useOperationRefresh';
import EksNodeGroupCreationPanel from './EksNodeGroupCreationPanel';

const { Text } = Typography;

const NodeGroupManager = ({ dependenciesConfigured = false, activeCluster, onDependencyStatusChange, onRefreshClusterDetails, refreshTrigger, cluster }) => {
  const [loading, setLoading] = useState(false);
  const [scaleLoading, setScaleLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [eksDeleteLoading, setEksDeleteLoading] = useState(false);
  const [eksDeleteTarget, setEksDeleteTarget] = useState(null);
  const [addInstanceGroupLoading, setAddInstanceGroupLoading] = useState(false);
  const [eksNodeGroups, setEksNodeGroups] = useState([]);
  const [hyperPodGroups, setHyperPodGroups] = useState([]);
  const [hyperPodCreationStatus, setHyperPodCreationStatus] = useState(null);
  const [hyperPodDeletionStatus, setHyperPodDeletionStatus] = useState(null);
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

  // 计算有效的依赖配置状态
  const getEffectiveDependenciesStatus = () => {
    // 对于导入的EKS+HyperPod集群，不受依赖配置约束
    if (cluster?.type === 'imported' && cluster?.hyperPodCluster) {
      return true;
    }
    
    // 如果cluster对象存在且有dependencies信息，优先使用
    if (cluster?.dependencies) {
      return cluster.dependencies.configured;  // 统一使用configured字段
    }
    // 兼容旧的简单状态
    return dependenciesConfigured;
  };

  const effectiveDependenciesConfigured = getEffectiveDependenciesStatus();

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

  const checkHyperPodCreationStatus = async () => {
    try {
      console.log('🔍 Checking HyperPod creation status...');
      
      // 先获取当前活跃集群
      const clusterInfoResponse = await fetch('/api/cluster/info');
      const clusterInfo = await clusterInfoResponse.json();
      const activeCluster = clusterInfo.activeCluster;
      
      console.log('📋 Active cluster:', activeCluster);
      
      if (!activeCluster) {
        console.log('❌ No active cluster found');
        setHyperPodCreationStatus(null);
        return;
      }
      
      const response = await fetch('/api/cluster/creating-hyperpod-clusters');
      const result = await response.json();
      
      console.log('📊 Creating clusters response:', result);
      
      if (response.ok && result.data) {
        const status = result.data[activeCluster];
        
        console.log('🎯 Status for active cluster:', status);
        
        // 如果状态被清理了（null），清除本地状态
        if (!status) {
          console.log('✅ No creation status, clearing local state');
          setHyperPodCreationStatus(null);
        } else {
          console.log('🚀 Setting creation status:', status);
          setHyperPodCreationStatus(status);
        }
      }
    } catch (error) {
      console.error('Error checking HyperPod creation status:', error);
    }
  };

  const handleDeleteHyperPod = async () => {
    Modal.confirm({
      title: 'Delete HyperPod Cluster',
      content: 'Are you sure you want to delete the HyperPod cluster? This action cannot be undone.',
      okText: 'Yes, Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setHyperPodDeletionStatus('deleting');
          
          const response = await fetch(`/api/cluster/${activeCluster}/hyperpod`, {
            method: 'DELETE'
          });
          
          const result = await response.json();
          if (!response.ok) {
            message.error(`Failed to delete HyperPod: ${result.error}`);
            setHyperPodDeletionStatus(null);
          }
        } catch (error) {
          message.error('Error deleting HyperPod cluster');
          setHyperPodDeletionStatus(null);
        }
      }
    });
  };

  const handleAddInstanceGroup = async () => {
    try {
      setAddInstanceGroupLoading(true);
      const values = await instanceGroupForm.validateFields();
      
      const response = await fetch('/api/cluster/hyperpod/add-instance-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userConfig: values })
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        message.error(`Failed to add instance group: ${result.error || result.message || 'Unknown error'}`);
      } else {
        message.success('Instance group addition initiated successfully');
        // 成功后关闭Modal并重置表单
        setAddInstanceGroupModalVisible(false);
        instanceGroupForm.resetFields();
        // 刷新数据
        await fetchNodeGroups();
      }
    } catch (error) {
      console.error('Error adding instance group:', error);
      message.error(`Error adding instance group: ${error.message || 'Unknown error'}`);
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
      
      const response = await fetch('/api/cluster/create-hyperpod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userConfig: values })
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        message.error(`Failed to create HyperPod cluster: ${result.error}`);
      }
      // 成功情况下不做任何操作，等待WebSocket消息处理
    } catch (error) {
      message.error(`Error creating HyperPod cluster: ${error.message}`);
    }
  };

  const fetchNodeGroups = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/cluster/nodegroups');
      const data = await response.json();
      
      if (response.ok) {
        setEksNodeGroups(data.eksNodeGroups || []);
        setHyperPodGroups(data.hyperPodInstanceGroups || []);
      } else {
        message.error(`Failed to fetch node groups: ${data.error}`);
      }

      // 同时检查依赖状态
      if (onDependencyStatusChange && activeCluster) {
        try {
          const depResponse = await fetch(`/api/cluster/${activeCluster}/dependencies/status`);
          const depResult = await depResponse.json();
          if (depResult.success) {
            onDependencyStatusChange(depResult.dependencies?.configured || false);
          }
        } catch (error) {
          console.error('Failed to fetch dependency status:', error);
          onDependencyStatusChange(false);
        }
      }
      
    } catch (error) {
      message.error(`Error fetching node groups: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNodeGroups();
    fetchClusterInfo();
    checkHyperPodCreationStatus();

    // 注册到全局刷新系统
    globalRefreshManager.subscribe('nodegroup-manager', async () => {
      // 同步顺序执行，确保数据一致性
      await fetchNodeGroups();
      await checkHyperPodCreationStatus();
    }, {
      priority: 7
    });

    // 注册到操作刷新系统
    operationRefreshManager.subscribe('nodegroup-manager', async () => {
      // 同步顺序执行，确保数据一致性
      await fetchNodeGroups();
      await checkHyperPodCreationStatus();
    });

    // 监听HyperPod创建完成的WebSocket消息
    operationRefreshManager.subscribe('hyperpod-create', async (data) => {
      if (data.type === 'hyperpod_creation_completed') {
        console.log('🎉 HyperPod creation completed, refreshing node groups...');
        await fetchNodeGroups();
        await checkHyperPodCreationStatus();
      }
    });

    // 监听HyperPod删除相关的WebSocket消息
    operationRefreshManager.subscribe('hyperpod-delete', async (data) => {
      if (data.type === 'hyperpod_deletion_started') {
        setHyperPodDeletionStatus('deleting');
      } else if (data.type === 'hyperpod_deletion_completed') {
        setHyperPodDeletionStatus(null);
        setHyperPodGroups([]);
        await fetchNodeGroups();
      } else if (data.type === 'hyperpod_deletion_failed') {
        setHyperPodDeletionStatus(null);
      }
    });

    return () => {
      globalRefreshManager.unsubscribe('nodegroup-manager');
      operationRefreshManager.unsubscribe('nodegroup-manager');
      operationRefreshManager.unsubscribe('hyperpod-create');
      operationRefreshManager.unsubscribe('hyperpod-delete');
    };
  }, []);

  // 响应外部刷新触发器
  useEffect(() => {
    if (refreshTrigger > 0) {
      fetchNodeGroups();
      fetchClusterInfo();
      checkHyperPodCreationStatus();
    }
  }, [refreshTrigger]);

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
      
      const endpoint = scaleTarget.type === 'eks' 
        ? `/api/cluster/nodegroups/${scaleTarget.name}/scale`
        : `/api/cluster/hyperpod/instances/${scaleTarget.name}/scale`;
      
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });

      if (response.ok) {
        message.success(`${scaleTarget.type === 'eks' ? 'Node group' : 'Instance group'} scaling updated successfully`);
        setScaleModalVisible(false);
        form.resetFields();
        await fetchNodeGroups();
      } else {
        const error = await response.json();
        message.error(`Failed to update scaling: ${error.error || error.message || 'Unknown error'}`);
      }
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
          const response = await fetch('/api/cluster/hyperpod/delete-instance-group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceGroupName: record.name })
          });

          if (response.ok) {
            message.success(`Instance group "${record.name}" deletion initiated successfully`);
            await fetchNodeGroups();
          } else {
            const error = await response.json();
            message.error(`Failed to delete instance group: ${error.error || error.message || 'Unknown error'}`);
          }
        } catch (error) {
          console.error('Error deleting instance group:', error);
          message.error(`Error deleting instance group: ${error.message || 'Unknown error'}`);
        } finally {
          setDeleteLoading(false);
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
        await fetchNodeGroups(); // 确保fetchNodeGroups完成
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
          
          const response = await fetch(`/api/cluster/nodegroup/${nodeGroupName}`, {
            method: 'DELETE'
          });
          
          const result = await response.json();
          
          if (result.success) {
            message.success(`NodeGroup ${nodeGroupName} deletion started`);
            await fetchNodeGroups();
          } else {
            message.error(`Failed to delete nodegroup: ${result.error}`);
          }
        } catch (error) {
          message.error(`Error deleting nodegroup: ${error.message}`);
        } finally {
          setEksDeleteLoading(false);
          setEksDeleteTarget(null);
        }
      }
    });
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
    if (hyperPodGroups.length === 0) return null;
    
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
    { title: 'Capacity Type', dataIndex: 'capacityType', key: 'capacityType' },
    { title: 'Min/Max/Desired', key: 'scaling', render: renderScaling },
    { title: 'Actions', key: 'actions', render: renderEKSActions }
  ];

  const hyperPodColumns = [
    { title: 'Instance Group Name', dataIndex: 'name', key: 'name' },
    { title: 'Status', dataIndex: 'status', key: 'status', render: renderStatus },
    { title: 'Instance Type', dataIndex: 'instanceType', key: 'instanceType' },
    { title: 'Current/Target', key: 'count', render: renderCount },
    { title: 'Actions', key: 'actions', render: renderHyperPodActions }
  ];

  return (
    <div style={{ height: '100%' }}>
      <div style={{ marginBottom: '16px', textAlign: 'right' }}>
        <Button 
          icon={<ReloadOutlined />} 
          onClick={async () => {
            // 同步顺序执行，确保数据一致性
            await fetchNodeGroups();
            await checkHyperPodCreationStatus();
            if (onRefreshClusterDetails) {
              onRefreshClusterDetails();
            }
          }}
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
                !effectiveDependenciesConfigured ||   // 依赖未配置时禁用
                !!hyperPodCreationStatus ||  // 创建中时禁用
                !!hyperPodDeletionStatus ||  // 删除中时禁用
                hyperPodGroups.length === 0 ||   // 没有HyperPod时禁用
                addInstanceGroupLoading      // 添加中时禁用
              }
              loading={addInstanceGroupLoading}
              title={
                !effectiveDependenciesConfigured 
                  ? "Dependencies must be configured first"
                  : hyperPodCreationStatus 
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
            {hyperPodGroups.length > 0 && (() => {
              // 检查是否为导入的EKS+HyperPod集群
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
                    isImportedWithHyperPod  // 导入的EKS+HyperPod集群禁用删除
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
            })()}
          </Space>
        }
      >
        {hyperPodCreationStatus && (
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
        />
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
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </div>

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
            name="trainingPlanArn" 
            label="Training Plan ARN (Optional)"
            extra="Provide Training Plan ARN if already in valid state."
          >
            <Input placeholder="arn:aws:sagemaker:region:account:training-plan/..." />
          </Form.Item>
        </Form>
      </Modal>

      {/* EKS Node Group Creation Modal */}
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
            fetchNodeGroups();
          }}
        />
      </Modal>
    </div>
  );
};

export default NodeGroupManager;
