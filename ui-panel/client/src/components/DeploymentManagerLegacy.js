import React, { useState, useEffect } from 'react';
import { 
  Table, 
  Button, 
  Space, 
  Tag, 
  Popconfirm,
  message,
  Card,
  Select,
  Tooltip,
  Modal,
  Input
} from 'antd';
import { 
  DeleteOutlined, 
  ReloadOutlined,
  InfoCircleOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  ThunderboltOutlined,
  GlobalOutlined,
  LockOutlined
} from '@ant-design/icons';
import globalRefreshManager from '../hooks/useGlobalRefresh';
import operationRefreshManager from '../hooks/useOperationRefresh';

const { Option } = Select;

const DeploymentManager = () => {
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState({});
  const [scaleLoading, setScaleLoading] = useState({});
  const [scaleModalVisible, setScaleModalVisible] = useState(false);
  const [scaleTarget, setScaleTarget] = useState(null);
  const [targetReplicas, setTargetReplicas] = useState(1);

  const fetchDeployments = async (showMessage = true) => {
    // 如果是从全局刷新管理器调用，不显示loading状态（避免冲突）
    const isGlobalRefresh = showMessage === undefined;
    
    if (!isGlobalRefresh) {
      setLoading(true);
    }
    
    try {
      const response = await fetch('/api/deployments');
      const data = await response.json();
      setDeployments(data);
    } catch (error) {
      console.error('Error fetching deployments:', error);
      if (!isGlobalRefresh) {
        message.error('Failed to fetch deployments');
      }
      throw error; // 重新抛出错误给全局刷新管理器处理
    } finally {
      if (!isGlobalRefresh) {
        setLoading(false);
      }
    }
  };

  // 注册到全局刷新管理器，替代useAutoRefresh
  useEffect(() => {
    const componentId = 'deployment-manager';
    
    globalRefreshManager.subscribe(componentId, fetchDeployments, {
      priority: 7 // 高优先级
    });

    // 注册到操作刷新管理器
    operationRefreshManager.subscribe(componentId, fetchDeployments);

    // 初始加载
    fetchDeployments();

    return () => {
      globalRefreshManager.unsubscribe(componentId);
      operationRefreshManager.unsubscribe(componentId);
    };
  }, []);

  const handleUndeploy = async (modelTag) => {
    setDeleteLoading(prev => ({ ...prev, [modelTag]: true }));
    
    try {
      const response = await fetch('/api/undeploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelTag,
          deleteType: 'all'
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        // 🚀 触发操作刷新 - 替代直接调用fetchDeployments
        operationRefreshManager.triggerOperationRefresh('model-undeploy', {
          modelTag,
          timestamp: new Date().toISOString()
        });
      } else {
        message.error(`Failed to undeploy: ${result.error}`);
      }
    } catch (error) {
      console.error('Error undeploying:', error);
      message.error('Failed to undeploy model');
    } finally {
      setDeleteLoading(prev => ({ ...prev, [modelTag]: false }));
    }
  };

  // 显示Scale确认对话框
  const showScaleModal = (deployment) => {
    setScaleTarget(deployment);
    setTargetReplicas(deployment.replicas);
    setScaleModalVisible(true);
  };

  // 执行Scale操作
  const handleScale = async () => {
    if (!scaleTarget) return;
    
    const deploymentName = scaleTarget.modelTag;
    setScaleLoading(prev => ({ ...prev, [deploymentName]: true }));
    
    try {
      const response = await fetch('/api/scale-deployment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deploymentName,
          replicas: targetReplicas,
          isModelPool: scaleTarget.deploymentType === 'model-pool'
        }),
      });

      const result = await response.json();
      
      if (result.success) {
        message.success(`Deployment ${deploymentName} scaled to ${targetReplicas} replicas`);
        setScaleModalVisible(false);
        fetchDeployments(); // 刷新数据
      } else {
        message.error(`Scale failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Scale error:', error);
      message.error('Scale operation failed');
    } finally {
      setScaleLoading(prev => ({ ...prev, [deploymentName]: false }));
    }
  };

  const showDeleteConfirmation = (record) => {
    Modal.confirm({
      title: `Delete ${record.modelTag} deployment`,
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>This will permanently delete both the deployment and service for <strong>{record.modelTag}</strong> ({record.deploymentType}).</p>
          <p>All running pods will be terminated and GPU resources will be freed.</p>
          <div style={{ marginTop: 16, padding: 12, backgroundColor: '#fff2e8', borderRadius: 6, border: '1px solid #ffbb96' }}>
            <div style={{ fontSize: '12px', color: '#d46b08' }}>
              <strong>⚠️ This action cannot be undone</strong>
            </div>
          </div>
        </div>
      ),
      okText: 'Delete Everything',
      okType: 'danger',
      cancelText: 'Cancel',
      width: 450,
      onOk() {
        handleUndeploy(record.modelTag);
      },
      onCancel() {
        console.log('Delete cancelled');
      },
    });
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'Ready':
        return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
      case 'Pending':
        return <ClockCircleOutlined style={{ color: '#faad14' }} />;
      default:
        return <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'Ready': return 'success';
      case 'Pending': return 'processing';
      default: return 'error';
    }
  };

  const getTypeIcon = (type) => {
    switch (type) {
      case 'VLLM':
        return <CodeOutlined />;
      case 'Ollama':
        return <ThunderboltOutlined />;
      default:
        return <InfoCircleOutlined />;
    }
  };

  const getTypeColor = (type) => {
    switch (type) {
      case 'VLLM': return 'blue';
      case 'Ollama': return 'green';
      default: return 'default';
    }
  };

  const getAccessIcon = (isExternal) => {
    return isExternal ? <GlobalOutlined /> : <LockOutlined />;
  };

  const getAccessColor = (isExternal) => {
    return isExternal ? 'orange' : 'purple';
  };

  const columns = [
    {
      title: 'Model Tag',
      dataIndex: 'modelTag',
      key: 'modelTag',
      render: (text) => <strong>{text}</strong>,
    },
    {
      title: 'Type',
      dataIndex: 'deploymentType',
      key: 'deploymentType',
      render: (type) => (
        <Tag color={getTypeColor(type)} icon={getTypeIcon(type)}>
          {type}
        </Tag>
      ),
    },
    {
      title: 'Access',
      key: 'access',
      render: (_, record) => (
        <Tag 
          color={getAccessColor(record.isExternal)} 
          icon={getAccessIcon(record.isExternal)}
        >
          {record.isExternal ? 'External' : 'Internal'}
        </Tag>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status, record) => (
        <Space>
          {getStatusIcon(status)}
          <Tag color={getStatusColor(status)}>
            {status}
          </Tag>
          <span style={{ fontSize: '12px', color: '#666' }}>
            {record.readyReplicas}/{record.replicas}
          </span>
        </Space>
      ),
    },
    {
      title: 'Deployment',
      dataIndex: 'deploymentName',
      key: 'deploymentName',
      render: (text) => (
        <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>
          {text}
        </span>
      ),
    },
    {
      title: 'Service',
      key: 'service',
      render: (_, record) => (
        <div>
          <div style={{ fontFamily: 'monospace', fontSize: '12px' }}>
            {record.serviceName}
          </div>
          {record.hasService && (
            <Tag color="blue" size="small">
              {record.serviceType}
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'External Access',
      dataIndex: 'externalIP',
      key: 'externalIP',
      render: (ip, record) => {
        if (!record.isExternal) {
          return <Tag color="purple">Internal Only</Tag>;
        }
        
        if (ip === 'Pending') {
          return <Tag color="orange">Pending</Tag>;
        }
        if (ip === 'N/A' || !record.hasService) {
          return <Tag color="default">No Service</Tag>;
        }
        
        // 根据部署类型确定端口
        const port = record.deploymentType === 'VLLM' ? '8000' : '11434';
        
        return (
          <Tooltip title={`http://${ip}:${port}`}>
            <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>
              {ip.length > 20 ? `${ip.substring(0, 20)}...` : ip}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (timestamp) => {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        
        let ageText;
        if (diffDays > 0) {
          ageText = `${diffDays}d ago`;
        } else if (diffHours > 0) {
          ageText = `${diffHours}h ago`;
        } else {
          ageText = `${diffMins}m ago`;
        }
        
        return (
          <Tooltip title={date.toLocaleString()}>
            <span style={{ fontSize: '12px', color: '#666' }}>
              {ageText}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button
            type="default"
            size="small"
            icon={<ThunderboltOutlined />}
            loading={scaleLoading[record.modelTag]}
            onClick={() => showScaleModal(record)}
          >
            Scale
          </Button>
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deleteLoading[record.modelTag]}
            onClick={() => showDeleteConfirmation(record)}
          >
            Delete
          </Button>
        </Space>
      ),
    },
  ];

  // 统计不同类型的部署
  const deploymentStats = deployments.reduce((acc, deployment) => {
    acc.total++;
    if (deployment.deploymentType === 'VLLM') acc.vllm++;
    if (deployment.deploymentType === 'Ollama') acc.ollama++;
    if (deployment.status === 'Ready') acc.ready++;
    if (deployment.isExternal) acc.external++;
    return acc;
  }, { total: 0, vllm: 0, ollama: 0, ready: 0, external: 0 });

  return (
    <Card 
      title={
        <Space>
          <span>Deployment Management</span>
          <Tag color="blue">{deploymentStats.total} total</Tag>
          <Tag color="blue" icon={<CodeOutlined />}>{deploymentStats.vllm} VLLM</Tag>
          <Tag color="green" icon={<ThunderboltOutlined />}>{deploymentStats.ollama} Ollama</Tag>
          <Tag color="success">{deploymentStats.ready} ready</Tag>
          <Tag color="orange" icon={<GlobalOutlined />}>{deploymentStats.external} external</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />} 
            onClick={() => fetchDeployments(true)}
            loading={loading}
            size="small"
          >
            Refresh
          </Button>
        </Space>
      }
    >
      {deployments.length === 0 && !loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
          <InfoCircleOutlined style={{ fontSize: '48px', marginBottom: '16px' }} />
          <div>No model deployments found</div>
          <div style={{ fontSize: '12px', marginTop: '8px' }}>
            Deploy a model using the configuration panel to see it here
          </div>
        </div>
      ) : (
        <Table
          columns={columns}
          dataSource={deployments}
          rowKey="modelTag"
          loading={loading}
          size="small"
          pagination={false}
          scroll={{ x: 1000 }}
        />
      )}
      
      <div style={{ marginTop: 16, padding: 12, backgroundColor: '#f6f8fa', borderRadius: 6 }}>
        <div style={{ fontSize: '12px', color: '#666', marginBottom: 8 }}>
          <strong>💡 Tips:</strong>
        </div>
        <div style={{ fontSize: '11px', color: '#888' }}>
          • <strong>VLLM</strong>: OpenAI-compatible API on port 8000<br/>
          • <strong>Ollama</strong>: Native Ollama API on port 11434<br/>
          • <strong>External</strong>: Internet-facing LoadBalancer (internet-facing)<br/>
          • <strong>Internal</strong>: Internal-only LoadBalancer (internal scheme)<br/>
          • Click <strong>Delete</strong> to remove both deployment and service completely
        </div>
      </div>
      
      {/* Scale Modal */}
      <Modal
        title={`Scale Deployment: ${scaleTarget?.modelTag}`}
        open={scaleModalVisible}
        onOk={handleScale}
        onCancel={() => setScaleModalVisible(false)}
        confirmLoading={scaleTarget && scaleLoading[scaleTarget.modelTag]}
        okText="Scale"
      >
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Current Replicas:</strong> {scaleTarget?.replicas}
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>Deployment Type:</strong> {scaleTarget?.deploymentType}
          </div>
          {scaleTarget?.deploymentType === 'model-pool' && (
            <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#f6f8fa', borderRadius: 4 }}>
              <div style={{ fontSize: '12px', color: '#666' }}>
                <strong>Model Pool Scale Rules:</strong><br/>
                • Scale Up: New pods will be <code>unassigned</code><br/>
                • Scale Down: Only <code>unassigned</code> pods will be removed
              </div>
            </div>
          )}
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <strong>Target Replicas:</strong>
          </label>
          <Input
            type="number"
            min={0}
            max={20}
            value={targetReplicas}
            onChange={(e) => setTargetReplicas(parseInt(e.target.value) || 0)}
            style={{ width: '100%' }}
          />
        </div>
      </Modal>
    </Card>
  );
};

export default DeploymentManager;
