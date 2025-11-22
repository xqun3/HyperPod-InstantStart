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
  Alert,
  Input,
  Modal
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
  InfoCircleOutlined,
  ThunderboltOutlined,      // 新增：用于VLLM部署类型
  GlobalOutlined,           // 新增：用于外部访问
  LockOutlined,             // 新增：用于内部访问
  CodeOutlined,             // 新增：用于扩缩容按钮
  ExperimentOutlined,       // 新增：用于训练任务
  SyncOutlined,             // 新增：用于Running状态图标（匹配原始HyperPodJobManager）
  CloseCircleOutlined       // 新增：用于Failed状态图标（匹配原始HyperPodJobManager）
} from '@ant-design/icons';

// Redux imports
import { refreshAllAppStatus } from '../store/slices/appStatusSlice';
import {
  selectAppPods,
  selectAppServices,
  selectAppRayJobs,
  selectAppBindingServices,
  selectAppDeployments,        // 新增
  selectAppTrainingJobs,       // 新增
  selectAppStatusLoading,
  selectAppStatusError,
  selectAppStats
} from '../store/selectors';
import { CONFIG } from '../config/constants';

// 新的事件总线
import resourceEventBus from '../utils/resourceEventBus';

const { TabPane } = Tabs;
const { Text } = Typography;
const { Option } = Select;

const StatusMonitorRedux = ({ activeTab }) => {
  const dispatch = useDispatch();

  // Redux 状态
  const pods = useSelector(selectAppPods);
  const services = useSelector(selectAppServices);
  const rayJobs = useSelector(selectAppRayJobs);
  const businessServices = useSelector(selectAppBindingServices);
  const deployments = useSelector(selectAppDeployments);          // 新增
  const trainingJobs = useSelector(selectAppTrainingJobs);        // 新增
  const loading = useSelector(selectAppStatusLoading);
  const error = useSelector(selectAppStatusError);
  const appStats = useSelector(selectAppStats);

  // 本地状态（操作相关）
  const [assigningPods, setAssigningPods] = useState(new Set());
  const [deletingServices, setDeletingServices] = useState(new Set());
  const [deletingRayJob, setDeletingRayJob] = useState(false);
  const [deletingDeployments, setDeletingDeployments] = useState(new Set());    // 新增
  const [scalingDeployments, setScalingDeployments] = useState(new Set());      // 新增
  const [deletingTrainingJobs, setDeletingTrainingJobs] = useState(new Set());  // 新增

  // 🔄 Badge同步状态 - 确保Badge数字与表格数据完全同步
  const [localRefreshTrigger, setLocalRefreshTrigger] = useState(0);
  const [badgeCounts, setBadgeCounts] = useState({ pods: 0, services: 0 });

  // Scale Modal 状态 - 继承原部署管理功能
  const [scaleModalVisible, setScaleModalVisible] = useState(false);
  const [scaleTarget, setScaleTarget] = useState(null);
  const [targetReplicas, setTargetReplicas] = useState(1);

  // 初始化时获取数据（只执行一次）
  useEffect(() => {
    // 只在首次挂载时刷新，避免每次切换 Tab 都触发
    const hasData = pods.length > 0 || services.length > 0;
    if (!hasData) {
      dispatch(refreshAllAppStatus());
    }

    // 订阅资源变化事件
    const refreshCallback = async (eventType) => {
      console.log('[AppStatus] Refreshing for event:', eventType);
      await dispatch(refreshAllAppStatus());
      // 强制触发 Badge 更新
      setLocalRefreshTrigger(prev => prev + 1);
    };
    
    resourceEventBus.subscribe('app-status', refreshCallback);

    // 清理订阅
    return () => {
      resourceEventBus.unsubscribe('app-status');
    };
  }, [dispatch]); // 只依赖dispatch，避免无限循环

  // Badge同步监听：当数据更新时强制重新渲染
  useEffect(() => {
    console.log('[StatusMonitor] Data changed - Pods:', pods.length, 'Services:', services.length, 'Deployments:', deployments.length);
    console.log('[StatusMonitor] Pods data:', pods.map(p => p.metadata?.name || 'unknown'));
    console.log('[StatusMonitor] Services data:', services.map(s => s.metadata?.name || 'unknown'));
    console.log('[StatusMonitor] Updating badgeCounts to:', { pods: pods.length, services: services.length });
    setBadgeCounts({ pods: pods.length, services: services.length });
    setLocalRefreshTrigger(prev => prev + 1);
  }, [pods.length, services.length, deployments.length, loading]);

  // 手动刷新
  const handleRefresh = useCallback(async () => {
    try {
      console.log('[StatusMonitor] Manual refresh triggered');
      await dispatch(refreshAllAppStatus()).unwrap();
      console.log('[StatusMonitor] Refresh completed - Pods:', pods.length, 'Services:', services.length);
      // 🔄 强制Badge重新渲染，确保与表格数据同步
      setLocalRefreshTrigger(prev => prev + 1);
      message.success('App status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing app status:', error);
      message.error('Failed to refresh app status: ' + (error.message || error));
    }
  }, [dispatch, pods.length, services.length]);

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
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
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
        // 🚀 触发统一刷新机制更新所有数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
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
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
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

  // 统一删除部署（支持Router和模型）
  const handleDeploymentDelete = async (deploymentName, deploymentType, isRouter) => {
    setDeletingDeployments(prev => new Set([...prev, deploymentName]));

    try {
      let response;

      // 根据类型选择不同的删除API
      if (isRouter || deploymentType === 'Router') {
        // Router删除：使用Router专用API
        console.log(`Deleting Router deployment: ${deploymentName}`);
        response = await fetch(`/api/routers/${deploymentName}`, {
          method: 'DELETE'
        });
      } else {
        // 模型删除：使用原有的undeploy逻辑
        console.log(`Deleting model deployment: ${deploymentName}`);
        response = await fetch('/api/undeploy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            modelTag: deploymentName, // 后端仍期望 modelTag 字段
            deleteType: 'all'
          }),
        });
      }

      const result = await response.json();

      if (result.success) {
        message.success(`${deploymentType} deployment "${deploymentName}" deleted successfully`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);

        console.log(`Deployment deletion successful:`, result);
      } else {
        message.error(`Failed to delete ${deploymentType} deployment: ${result.error || result.message}`);
      }
    } catch (error) {
      console.error('Error deleting deployment:', error);
      message.error(`Failed to delete ${deploymentType || 'deployment'}: ${error.message}`);
    } finally {
      setDeletingDeployments(prev => {
        const newSet = new Set(prev);
        newSet.delete(deploymentName);
        return newSet;
      });
    }
  };

  // 扩缩容部署
  const handleDeploymentScale = async (deployment, targetReplicas) => {
    const deploymentName = deployment.deploymentName;
    setScalingDeployments(prev => new Set([...prev, deploymentName]));

    try {
      const response = await fetch('/api/scale-deployment', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          deploymentName: deploymentName,
          replicas: targetReplicas,
          isModelPool: deployment.deploymentType === 'model-pool'
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Deployment ${deploymentName} scaled to ${targetReplicas} replicas`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Scale failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Scale error:', error);
      message.error('Scale operation failed');
    } finally {
      setScalingDeployments(prev => {
        const newSet = new Set(prev);
        newSet.delete(deploymentName);
        return newSet;
      });
    }
  };

  // 删除训练任务
  const handleTrainingJobDelete = async (jobName) => {
    setDeletingTrainingJobs(prev => new Set([...prev, jobName]));

    try {
      const response = await fetch(`/api/hyperpod-jobs/${jobName}`, {
        method: 'DELETE'
      });

      const result = await response.json();

      if (result.success) {
        message.success(`Training job ${jobName} deleted successfully`);
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Failed to delete training job: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting training job:', error);
      message.error('Failed to delete training job');
    } finally {
      setDeletingTrainingJobs(prev => {
        const newSet = new Set(prev);
        newSet.delete(jobName);
        return newSet;
      });
    }
  };

  // Scale Modal 功能 - 继承原部署管理功能
  const showScaleModal = (deployment) => {
    setScaleTarget(deployment);
    setTargetReplicas(deployment.replicas);
    setScaleModalVisible(true);
  };

  // 执行Scale操作 - 继承原部署管理功能
  const handleScale = async () => {
    if (!scaleTarget) return;

    const deploymentName = scaleTarget.deploymentName;
    setScalingDeployments(prev => new Set([...prev, deploymentName]));

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
        // 刷新数据
        await dispatch(refreshAllAppStatus());
        // 🔄 强制Badge重新渲染
        setLocalRefreshTrigger(prev => prev + 1);
      } else {
        message.error(`Scale failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Scale error:', error);
      message.error('Scale operation failed');
    } finally {
      setScalingDeployments(prev => {
        const newSet = new Set(prev);
        newSet.delete(deploymentName);
        return newSet;
      });
    }
  };

  // Delete Confirmation Modal - 继承原部署管理功能
  const showDeleteConfirmation = (record) => {
    Modal.confirm({
      title: `Delete ${record.deploymentName} deployment`,
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>This will permanently delete both the deployment and service for <strong>{record.deploymentName}</strong> ({record.deploymentType}).</p>
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
        handleDeploymentDelete(record.deploymentName, record.deploymentType, record.isRouter);
      },
      onCancel() {
        console.log('Delete cancelled');
      },
    });
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
      width: 300, // 设置固定宽度替代ellipsis
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
      width: 300, // 设置固定宽度替代ellipsis
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

  // Deployment表格列定义 - 优化后去掉重复的Model Tag列
  const deploymentColumns = [
    {
      title: 'Deployment Name',
      dataIndex: 'deploymentName',
      key: 'deploymentName',
      render: (text) => (
        <strong style={{ fontFamily: 'monospace', fontSize: '12px' }}>
          {text}
        </strong>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'deploymentType',
      key: 'deploymentType',
      render: (type) => {
        // 继承原部署管理的图标和颜色
        const getTypeIcon = (type) => {
          switch (type) {
            case 'VLLM':
              return <CodeOutlined />;
            case 'SGLang':
              return <ThunderboltOutlined />;
            case 'Router':
              return <ApiOutlined />;
            default:
              return <InfoCircleOutlined />;
          }
        };

        const getTypeColor = (type) => {
          switch (type) {
            case 'VLLM': return 'blue';
            case 'SGLang': return 'green';
            case 'Router': return 'purple';
            default: return 'default';
          }
        };

        return (
          <Tag color={getTypeColor(type)} icon={getTypeIcon(type)}>
            {type}
          </Tag>
        );
      }
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status, record) => {
        // 继承原部署管理的状态图标和颜色
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

        return (
          <Space>
            {getStatusIcon(status)}
            <Tag color={getStatusColor(status)}>
              {status}
            </Tag>
            <span style={{ fontSize: '12px', color: '#666' }}>
              {record.readyReplicas}/{record.replicas}
            </span>
          </Space>
        );
      }
    },
    {
      title: 'Service',
      key: 'service',
      width: 150,
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
      title: 'Container Port',
      key: 'containerPorts',
      width: 120,
      render: (_, record) => (
        <div>
          {record.containerPorts && record.containerPorts.length > 0 ? (
            record.containerPorts.map((port, index) => (
              <Tag key={index} color="cyan" size="small" style={{ margin: '1px' }}>
                {port.containerPort}
                {port.protocol && port.protocol !== 'TCP' && `/${port.protocol}`}
              </Tag>
            ))
          ) : (
            <Tag size="small" color="default">N/A</Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Access & URL',
      dataIndex: 'externalIP',
      key: 'externalIP',
      width: 200,
      render: (ip, record) => {
        // 访问类型标签的图标和颜色函数
        const getAccessIcon = (isExternal) => {
          return isExternal ? <GlobalOutlined /> : <LockOutlined />;
        };

        const getAccessColor = (isExternal) => {
          return isExternal ? 'orange' : 'purple';
        };

        // 内部访问或无服务的情况
        if (!record.isExternal) {
          return (
            <Tag
              color={getAccessColor(false)}
              icon={getAccessIcon(false)}
            >
              Internal Only
            </Tag>
          );
        }

        // 外部访问但状态为 Pending
        if (ip === 'Pending') {
          return (
            <Space direction="vertical" size="small">
              <Tag
                color={getAccessColor(true)}
                icon={getAccessIcon(true)}
              >
                External
              </Tag>
              <Tag color="orange">Pending</Tag>
            </Space>
          );
        }

        // 外部访问但无服务
        if (ip === 'N/A' || !record.hasService) {
          return (
            <Space direction="vertical" size="small">
              <Tag
                color={getAccessColor(true)}
                icon={getAccessIcon(true)}
              >
                External
              </Tag>
              <Tag color="default">No Service</Tag>
            </Space>
          );
        }

        // 外部访问且有有效的 URL
        const port = record.port || '8000';
        const fullUrl = `http://${ip}:${port}`;

        return (
          <div style={{ width: '180px' }}>
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Tag
                color={getAccessColor(true)}
                icon={getAccessIcon(true)}
                size="small"
              >
                External
              </Tag>
              <Tooltip title={fullUrl}>
                <Text
                  copyable={{ text: fullUrl }}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    wordBreak: 'break-all',
                    width: '100%'
                  }}
                >
                  {ip.length > 12 ? `${ip.substring(0, 12)}...` : ip}:{port}
                </Text>
              </Tooltip>
            </Space>
          </div>
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
            loading={scalingDeployments.has(record.deploymentName)}
            onClick={() => showScaleModal(record)}
          >
            Scale
          </Button>
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingDeployments.has(record.deploymentName)}
            onClick={() => showDeleteConfirmation(record)}
          >
            Delete
          </Button>
        </Space>
      )
    }
  ];

  // Training Jobs表格列定义
  const trainingJobColumns = [
    {
      title: 'Job Name',
      dataIndex: 'name',
      key: 'name',
      render: (name) => (
        <Space>
          <ExperimentOutlined style={{ color: '#1890ff' }} />
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (statusObj) => {
        // 完全匹配原始HyperPodJobManager的状态处理逻辑
        let status = 'Unknown';

        if (typeof statusObj === 'string') {
          status = statusObj;
        } else if (statusObj && typeof statusObj === 'object') {
          // 从状态对象中提取状态信息
          if (statusObj.conditions && Array.isArray(statusObj.conditions)) {
            const lastCondition = statusObj.conditions[statusObj.conditions.length - 1];
            if (lastCondition && lastCondition.type) {
              status = lastCondition.type;
            }
          } else if (statusObj.phase) {
            status = statusObj.phase;
          } else if (statusObj.state) {
            status = statusObj.state;
          }
        }

        // 完全匹配原始HyperPodJobManager的状态配置
        const statusConfig = {
          'Running': { color: 'processing', icon: <SyncOutlined /> },
          'Succeeded': { color: 'success', icon: <CheckCircleOutlined /> },
          'Failed': { color: 'error', icon: <CloseCircleOutlined /> },
          'Pending': { color: 'warning', icon: <ClockCircleOutlined /> },
          'Unknown': { color: 'default', icon: <ClockCircleOutlined /> },
          'Created': { color: 'default', icon: <ClockCircleOutlined /> },
          'Completed': { color: 'success', icon: <CheckCircleOutlined /> }
        };

        const config = statusConfig[status] || statusConfig['Unknown'];

        return (
          <Tag color={config.color} icon={config.icon}>
            {status}
          </Tag>
        );
      },
    },
    {
      title: 'Created',
      dataIndex: 'creationTimestamp',
      key: 'creationTimestamp',
      render: (timestamp) => {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return (
          <Tooltip title={date.toLocaleString()}>
            <Text type="secondary">
              {date.toLocaleDateString()} {date.toLocaleTimeString()}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'Duration',
      key: 'duration',
      render: (_, record) => {
        if (!record.creationTimestamp) return '-';

        const startTime = new Date(record.creationTimestamp);
        const now = new Date();
        const diffMs = now - startTime;

        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
          return <Text type="secondary">{hours}h {minutes}m</Text>;
        } else if (minutes > 0) {
          return <Text type="secondary">{minutes}m</Text>;
        } else {
          return <Text type="secondary">{'< 1m'}</Text>;
        }
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Popconfirm
          title="Delete Training Job"
          description={`Are you sure you want to delete "${record.name}"?`}
          onConfirm={() => handleTrainingJobDelete(record.name)}
          okText="Yes"
          cancelText="No"
        >
          <Button
            type="primary"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deletingTrainingJobs.has(record.name)}
          >
            Delete
          </Button>
        </Popconfirm>
      ),
    },
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

  // 🔄 刷新按钮现在移到了全局App Status tab行，各个tab内不再显示
  const refreshButton = activeTab ? null : (
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

    if (activeTab === 'deployments') {
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
            columns={deploymentColumns}
            dataSource={deployments}
            rowKey="deploymentName"
            size="small"
            pagination={{ pageSize: 10 }}
            loading={loading}
            locale={{
              emptyText: 'No deployments found'
            }}
          />

          {/* Scale Modal - 继承原部署管理功能 */}
          <Modal
            title={`Scale Deployment: ${scaleTarget?.deploymentName}`}
            open={scaleModalVisible}
            onOk={handleScale}
            onCancel={() => setScaleModalVisible(false)}
            confirmLoading={scaleTarget && scalingDeployments.has(scaleTarget.deploymentName)}
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
        </div>
      );
    }

    if (activeTab === 'jobs') {
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

          {/* 始终显示Table，与RayJobs保持一致 */}
          <Table
            columns={trainingJobColumns}
            dataSource={trainingJobs}
            rowKey="name"
            loading={loading}
            size="small"
            pagination={{
              pageSize: 5,
              showSizeChanger: false,
              showQuickJumper: false,
              showTotal: (total) => `Total ${total} jobs`
            }}
            scroll={{ y: 200 }}
          />
        </div>
      );
    }

    return <div>Unsupported tab: {activeTab}</div>;
  }

  // 完整的Tabs视图（当没有指定activeTab时）

  return (
    <div style={{ padding: '0 16px' }}>
      <Tabs defaultActiveKey="pods" size="small">
        <TabPane
          tab={
            <Space>
              <ContainerOutlined />
              Pods
              <Badge
                count={badgeCounts.pods}
                style={{ backgroundColor: '#1890ff' }}
                showZero
              />
            </Space>
          }
          key="pods"
        >
          <div style={{ paddingTop: '16px' }}>
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
            <Badge
              count={badgeCounts.services}
              style={{ backgroundColor: '#52c41a' }}
              showZero
            />
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
    </div>
  );
};

export default StatusMonitorRedux;