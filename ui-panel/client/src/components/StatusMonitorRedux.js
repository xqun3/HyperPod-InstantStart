import React, { useEffect, useCallback, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Tabs,
  Table,
  Tag,
  Space,
  Badge,
  Button,
  Typography,
  message,
  Popconfirm,
  Select,
  Tooltip,
  Alert
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
  LoadingOutlined,
  ReloadOutlined,
  ApiOutlined,
  ContainerOutlined,
  DeleteOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';

// Redux imports
import { refreshAllAppStatus } from '../store/slices/appStatusSlice';
import {
  selectAppPods,
  selectAppServices,
  selectAppRayJobs,
  selectAppBusinessServices,
  selectAppStatusLoading,
  selectAppStatusError,
  selectAppStats
} from '../store/selectors';
import { CONFIG } from '../config/constants';

const { TabPane } = Tabs;
const { Text } = Typography;
const { Option } = Select;

const StatusMonitorRedux = ({ activeTab }) => {
  const dispatch = useDispatch();

  // Redux 状态
  const pods = useSelector(selectAppPods);
  const services = useSelector(selectAppServices);
  const rayJobs = useSelector(selectAppRayJobs);
  const businessServices = useSelector(selectAppBusinessServices);
  const loading = useSelector(selectAppStatusLoading);
  const error = useSelector(selectAppStatusError);
  const appStats = useSelector(selectAppStats);

  // 本地状态（操作相关）
  const [assigningPods, setAssigningPods] = useState(new Set());
  const [deletingServices, setDeletingServices] = useState(new Set());
  const [deletingRayJob, setDeletingRayJob] = useState(false);

  // 初始化时获取数据（只执行一次）
  useEffect(() => {
    dispatch(refreshAllAppStatus());
  }, [dispatch]); // 只依赖dispatch，避免无限循环

  // 手动刷新
  const handleRefresh = useCallback(async () => {
    try {
      await dispatch(refreshAllAppStatus()).unwrap();
      message.success('App status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing app status:', error);
      message.error('Failed to refresh app status: ' + (error.message || error));
    }
  }, [dispatch]);

  // 处理Service删除
  const handleServiceDelete = async (serviceName) => {
    setDeletingServices(prev => new Set([...prev, serviceName]));

    try {
      const response = await fetch(`/api/delete-service/${serviceName}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Service ${serviceName} deleted successfully`);
        // 触发刷新
        await dispatch(refreshAllAppStatus());
      } else {
        message.error(`Failed to delete service: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting service:', error);
      message.error('Failed to delete service');
    } finally {
      setDeletingServices(prev => {
        const newSet = new Set(prev);
        newSet.delete(serviceName);
        return newSet;
      });
    }
  };

  // 检查是否为模型池Pod
  const isPoolPod = (pod) => {
    const labels = pod.metadata?.labels || {};
    return labels['model-id'] &&
      labels.business !== undefined &&
      labels['deployment-type'] === 'model-pool';
  };

  // 处理Pod分配
  const handlePodAssign = async (podName, businessTag) => {
    const pod = pods.find(p => p.metadata.name === podName);
    if (!pod) return;

    const modelId = pod.metadata.labels?.['model-id'];
    if (!modelId) {
      message.error('Pod model-id information not found');
      return;
    }

    setAssigningPods(prev => new Set([...prev, podName]));

    try {
      const response = await fetch('/api/assign-pod', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          podName,
          businessTag,
          modelId
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Pod ${podName} assigned to ${businessTag}`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
      } else {
        message.error(result.error || 'Assignment failed');
      }
    } catch (error) {
      console.error('Pod assignment error:', error);
      message.error('Failed to assign pod');
    } finally {
      setAssigningPods(prev => {
        const newSet = new Set(prev);
        newSet.delete(podName);
        return newSet;
      });
    }
  };

  // 删除RayJob
  const handleDeleteRayJob = async (jobName) => {
    try {
      setDeletingRayJob(true);
      const response = await fetch(`/api/rayjobs/${jobName}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        message.success(`RayJob ${jobName} deletion initiated`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
      } else {
        const error = await response.json();
        message.error(`Failed to delete RayJob: ${error.error}`);
      }
    } catch (error) {
      console.error('Error deleting RayJob:', error);
      message.error('Failed to delete RayJob');
    } finally {
      setDeletingRayJob(false);
    }
  };

  // Pod状态相关函数
  const getPodStatus = (pod) => {
    const phase = pod.status?.phase;
    const conditions = pod.status?.conditions || [];
    const containerStatuses = pod.status?.containerStatuses || [];

    // 检查容器状态，优先显示容器的实际状态
    for (const containerStatus of containerStatuses) {
      if (containerStatus.state?.waiting) {
        return containerStatus.state.waiting.reason?.toLowerCase() || 'waiting';
      }
      if (containerStatus.state?.terminated) {
        return containerStatus.state.terminated.reason?.toLowerCase() || 'terminated';
      }
    }

    if (phase === 'Running') {
      const readyCondition = conditions.find(c => c.type === 'Ready');
      return readyCondition?.status === 'True' ? 'running' : 'not-ready';
    }

    return phase?.toLowerCase() || 'unknown';
  };

  const getPodStatusColor = (status) => {
    switch (status) {
      case 'running': return 'success';
      case 'succeeded': return 'success';
      case 'completed': return 'success';
      case 'failed': return 'error';
      case 'error': return 'error';
      case 'imagepullbackoff': return 'error';
      case 'errimagepull': return 'error';
      case 'crashloopbackoff': return 'error';
      case 'not-ready': return 'warning';
      case 'terminating': return 'warning';
      default: return 'processing';
    }
  };

  const getPodStatusIcon = (status) => {
    switch (status) {
      case 'running': return <CheckCircleOutlined />;
      case 'succeeded': return <CheckCircleOutlined />;
      case 'completed': return <CheckCircleOutlined />;
      case 'failed': return <ExclamationCircleOutlined />;
      case 'error': return <ExclamationCircleOutlined />;
      case 'imagepullbackoff': return <ExclamationCircleOutlined />;
      case 'errimagepull': return <ExclamationCircleOutlined />;
      case 'crashloopbackoff': return <ExclamationCircleOutlined />;
      case 'not-ready': return <ExclamationCircleOutlined />;
      case 'terminating': return <LoadingOutlined />;
      default: return <LoadingOutlined />;
    }
  };

  // 计算Service关联的Pod数量
  const getServicePodCount = (service) => {
    const selector = service.spec?.selector || {};
    if (Object.keys(selector).length === 0) {
      return 0;
    }

    return pods.filter(pod => {
      const podLabels = pod.metadata?.labels || {};
      return Object.entries(selector).every(([key, value]) =>
        podLabels[key] === value
      );
    }).length;
  };

  // Pod表格列定义
  const podColumns = [
    {
      title: 'Pod Name',
      dataIndex: ['metadata', 'name'],
      key: 'name',
      render: (text) => (
        <Space>
          <ContainerOutlined />
          <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{text}</span>
        </Space>
      ),
      ellipsis: true,
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, pod) => {
        const status = getPodStatus(pod);
        return (
          <Tag
            color={getPodStatusColor(status)}
            icon={getPodStatusIcon(status)}
          >
            {status.toUpperCase()}
          </Tag>
        );
      },
    },
    {
      title: 'Business',
      key: 'business',
      render: (_, pod) => {
        if (!isPoolPod(pod)) {
          return <Text type="secondary">N/A</Text>;
        }

        const currentBusiness = pod.metadata.labels?.business || 'unassigned';
        const podName = pod.metadata.name;
        const isAssigning = assigningPods.has(podName);

        return (
          <Select
            value={currentBusiness}
            onChange={(value) => handlePodAssign(podName, value)}
            style={{ width: 140 }}
            size="small"
            loading={isAssigning}
            disabled={isAssigning}
          >
            <Option value="unassigned">
              <Text type="secondary">Unassigned</Text>
            </Option>
            {businessServices.map(service => (
              <Option key={service.businessTag} value={service.businessTag}>
                <Text>{service.displayName}</Text>
              </Option>
            ))}
          </Select>
        );
      },
    },
    {
      title: 'Ready',
      key: 'ready',
      render: (_, pod) => {
        const containerStatuses = pod.status?.containerStatuses || [];
        const readyCount = containerStatuses.filter(c => c.ready).length;
        const totalCount = containerStatuses.length;

        return (
          <Badge
            count={`${readyCount}/${totalCount}`}
            style={{
              backgroundColor: readyCount === totalCount ? '#52c41a' : '#faad14'
            }}
          />
        );
      },
    },
    {
      title: 'Restarts',
      key: 'restarts',
      render: (_, pod) => {
        const containerStatuses = pod.status?.containerStatuses || [];
        const totalRestarts = containerStatuses.reduce((sum, c) => sum + (c.restartCount || 0), 0);

        return (
          <Badge
            count={totalRestarts}
            showZero={true}
            style={{
              backgroundColor: totalRestarts === 0 ? '#52c41a' : '#ff4d4f'
            }}
          />
        );
      },
    },
    {
      title: 'Age',
      key: 'age',
      render: (_, pod) => {
        const creationTime = new Date(pod.metadata.creationTimestamp);
        const now = new Date();
        const ageMs = now - creationTime;
        const ageMinutes = Math.floor(ageMs / 60000);

        if (ageMinutes < 60) {
          return `${ageMinutes}m`;
        } else if (ageMinutes < 1440) {
          return `${Math.floor(ageMinutes / 60)}h`;
        } else {
          return `${Math.floor(ageMinutes / 1440)}d`;
        }
      },
    },
  ];

  // Service表格列定义
  const serviceColumns = [
    {
      title: 'Service Name',
      dataIndex: ['metadata', 'name'],
      key: 'name',
      render: (text) => (
        <Space>
          <ApiOutlined />
          <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{text}</span>
        </Space>
      ),
      ellipsis: true,
    },
    {
      title: 'Type',
      dataIndex: ['spec', 'type'],
      key: 'type',
      render: (type) => (
        <Tag color={type === 'LoadBalancer' ? 'blue' : 'default'}>
          {type}
        </Tag>
      ),
    },
    {
      title: 'Pods',
      key: 'pods',
      render: (_, service) => {
        const podCount = getServicePodCount(service);
        return (
          <Badge
            count={podCount}
            style={{
              backgroundColor: podCount > 0 ? '#52c41a' : '#d9d9d9',
              color: podCount > 0 ? 'white' : '#666'
            }}
          />
        );
      },
    },
    {
      title: 'Cluster IP',
      dataIndex: ['spec', 'clusterIP'],
      key: 'clusterIP',
      render: (ip) => <Text code>{ip}</Text>,
    },
    {
      title: 'External IP',
      key: 'externalIP',
      render: (_, service) => {
        const ingress = service.status?.loadBalancer?.ingress;
        if (ingress && ingress.length > 0) {
          const externalIP = ingress[0].hostname || ingress[0].ip;
          return <Text code>{externalIP}</Text>;
        }

        if (service.spec.type === 'LoadBalancer') {
          return <Text type="secondary">Pending...</Text>;
        }

        return <Text type="secondary">-</Text>;
      },
    },
    {
      title: 'Ports',
      key: 'ports',
      render: (_, service) => {
        const ports = service.spec?.ports || [];
        return (
          <Space wrap>
            {ports.map((port, index) => (
              <Tag key={index} color="geekblue">
                {port.port}:{port.targetPort}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 80,
      render: (_, service) => {
        // 系统Service不显示删除按钮
        const isSystemService = service.metadata.name === 'kubernetes' ||
          service.metadata.namespace === 'kube-system' ||
          service.metadata.labels?.['kubernetes.io/managed-by'];

        if (isSystemService) {
          return <Text type="secondary">System Service</Text>;
        }

        return (
          <Popconfirm
            title="Delete Service"
            description={`Are you sure you want to delete service ${service.metadata.name}?`}
            onConfirm={() => handleServiceDelete(service.metadata.name)}
            okText="Yes"
            cancelText="No"
            placement="left"
          >
            <Button
              type="primary"
              danger
              size="small"
              icon={<DeleteOutlined />}
              loading={deletingServices.has(service.metadata.name)}
            >
              Delete
            </Button>
          </Popconfirm>
        );
      }
    },
  ];

  // RayJob表格列定义
  const rayJobColumns = [
    {
      title: 'Job Name',
      dataIndex: ['metadata', 'name'],
      key: 'name',
      render: (name) => <Text strong>{name}</Text>
    },
    {
      title: 'Job Status',
      dataIndex: ['status', 'jobStatus'],
      key: 'jobStatus',
      render: (status) => {
        const statusConfig = {
          'RUNNING': { color: 'processing', icon: <LoadingOutlined /> },
          'SUCCEEDED': { color: 'success', icon: <CheckCircleOutlined /> },
          'FAILED': { color: 'error', icon: <ExclamationCircleOutlined /> },
          'PENDING': { color: 'warning', icon: <ClockCircleOutlined /> }
        };
        const config = statusConfig[status] || { color: 'default', icon: null };
        return <Tag color={config.color} icon={config.icon}>{status || 'Unknown'}</Tag>;
      }
    },
    {
      title: 'Ray Cluster',
      dataIndex: ['status', 'rayClusterName'],
      key: 'rayClusterName',
      render: (name) => <Text code>{name}</Text>
    },
    {
      title: 'Start Time',
      dataIndex: ['status', 'startTime'],
      key: 'startTime',
      render: (time) => time ? new Date(time).toLocaleString() : 'N/A'
    },
    {
      title: 'Age',
      dataIndex: ['metadata', 'creationTimestamp'],
      key: 'age',
      render: (timestamp) => {
        if (!timestamp) return 'N/A';
        const age = Date.now() - new Date(timestamp).getTime();
        const minutes = Math.floor(age / 60000);
        const hours = Math.floor(minutes / 60);
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m`;
      }
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Popconfirm
          title="Delete RayJob"
          description={`Are you sure you want to delete "${record.metadata.name}"?`}
          onConfirm={() => handleDeleteRayJob(record.metadata.name)}
          okText="Yes"
          cancelText="No"
        >
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingRayJob}
          >
            Delete
          </Button>
        </Popconfirm>
      )
    }
  ];

  // 统计信息
  const podStats = {
    total: pods.length,
    running: pods.filter(p => getPodStatus(p) === 'running').length,
    pending: pods.filter(p => getPodStatus(p) === 'pending').length,
    failed: pods.filter(p => getPodStatus(p) === 'failed').length,
  };

  const serviceStats = {
    total: services.length,
    loadBalancer: services.filter(s => s.spec.type === 'LoadBalancer').length,
    ready: services.filter(s => s.status?.loadBalancer?.ingress?.length > 0).length,
  };

  // 渲染统计卡片
  const renderStatsCard = (stats, type) => {
    if (type === 'pods') {
      return (
        <div style={{
          marginBottom: 16,
          padding: 12,
          backgroundColor: '#f5f5f5',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-around'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
              {stats.total}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
              {stats.running}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Running</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#faad14' }}>
              {stats.pending}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Pending</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ff4d4f' }}>
              {stats.failed}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Failed</div>
          </div>
        </div>
      );
    }

    if (type === 'services') {
      return (
        <div style={{
          marginBottom: 16,
          padding: 12,
          backgroundColor: '#f5f5f5',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-around'
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
              {stats.total}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#722ed1' }}>
              {stats.loadBalancer}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>LoadBalancer</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#52c41a' }}>
              {stats.ready}
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>Ready</div>
          </div>
        </div>
      );
    }

    return null;
  };

  // 通用刷新按钮
  const refreshButton = (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '16px'
    }}>
      <div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={handleRefresh}
        >
          Refresh
        </Button>
      </div>
    </div>
  );

  // 如果指定了activeTab，只显示对应的内容
  if (activeTab) {
    if (activeTab === 'pods') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              action={
                <Button size="small" type="primary" onClick={handleRefresh}>
                  Retry
                </Button>
              }
            />
          )}
          {refreshButton}
          {renderStatsCard(podStats, 'pods')}
          <Table
            columns={podColumns}
            dataSource={pods}
            rowKey={(pod) => pod.metadata.uid}
            size="small"
            pagination={false}
            scroll={{ y: 200 }}
            loading={loading}
            locale={{
              emptyText: 'No pods found'
            }}
          />
        </div>
      );
    }

    if (activeTab === 'services') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          {renderStatsCard(serviceStats, 'services')}
          <Table
            columns={serviceColumns}
            dataSource={services}
            rowKey={(service) => service.metadata.uid}
            size="small"
            pagination={false}
            scroll={{ y: 200 }}
            loading={loading}
            locale={{
              emptyText: 'No services found'
            }}
          />
        </div>
      );
    }

    if (activeTab === 'rayjobs') {
      return (
        <div>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={rayJobColumns}
            dataSource={rayJobs}
            rowKey={(job) => job.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
        </div>
      );
    }

    return <div>Unsupported tab: {activeTab}</div>;
  }

  // 完整的Tabs视图（当没有指定activeTab时）
  return (
    <Tabs defaultActiveKey="pods" size="small">
      <TabPane
        tab={
          <Space>
            <ContainerOutlined />
            Pods
            <Badge count={pods.length} style={{ backgroundColor: '#1890ff' }} />
          </Space>
        }
        key="pods"
      >
        <div style={{ padding: '16px' }}>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={podColumns}
            dataSource={pods}
            rowKey={(pod) => pod.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
        </div>
      </TabPane>

      <TabPane
        tab={
          <Space>
            <ApiOutlined />
            Services
            <Badge count={services.length} style={{ backgroundColor: '#52c41a' }} />
          </Space>
        }
        key="services"
      >
        <div style={{ padding: '16px' }}>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={serviceColumns}
            dataSource={services}
            rowKey={(service) => service.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
        </div>
      </TabPane>

      <TabPane
        tab={
          <Space>
            <ApiOutlined />
            RayJobs
            <Badge count={rayJobs.length} style={{ backgroundColor: '#722ed1' }} />
          </Space>
        }
        key="rayjobs"
      >
        <div style={{ padding: '16px' }}>
          {error && (
            <Alert
              message="App Status Error"
              description={error}
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
          {refreshButton}
          <Table
            columns={rayJobColumns}
            dataSource={rayJobs}
            rowKey={(job) => job.metadata.uid}
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
          />
        </div>
      </TabPane>
    </Tabs>
  );
};

export default StatusMonitorRedux;