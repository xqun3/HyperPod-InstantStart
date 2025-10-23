import React, { useState, useEffect, useRef } from 'react';
import { 
  Card, 
  Form, 
  Input, 
  Button, 
  Steps, 
  Space, 
  Switch, 
  InputNumber, 
  Alert, 
  Divider,
  Row,
  Col,
  Typography,
  Tag,
  Spin,
  message,
  Select,
  Tooltip,
  Modal,
  Drawer,
  Tabs
} from 'antd';
import { 
  CloudServerOutlined, 
  SettingOutlined, 
  ReloadOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  DownOutlined,
  CopyOutlined,
  ExclamationCircleOutlined,
  ClusterOutlined,
  PlusOutlined,
  ImportOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import globalRefreshManager from '../hooks/useGlobalRefresh';
import operationRefreshManager from '../hooks/useOperationRefresh';
import NodeGroupManager from './NodeGroupManager';
import EksClusterCreationPanel from './EksClusterCreationPanel';
import CreateClusterDeprecated from './CreateClusterDeprecated';

const { Title, Text } = Typography;
const { Step } = Steps;
const { Option } = Select;

// 依赖配置状态显示组件（增强版）
const DependencyStatus = ({ cluster, dependenciesConfigured }) => {
  // 获取状态显示
  const getDependencyStatusDisplay = () => {
    if (dependenciesConfigured === undefined && !cluster?.dependencies) {
      return <Text type="secondary">Loading...</Text>;
    }
    
    // 优先使用cluster对象中的详细状态信息
    if (cluster?.dependencies) {
      const deps = cluster.dependencies;
      const isImported = cluster.type === 'imported';
      
      if (isImported) {
        // 导入的集群：区分有无HyperPod
        if (cluster.hyperPodCluster) {
          // 有HyperPod的导入集群：显示N/A
          return <Tag color="default">N/A</Tag>;
        } else {
          // 纯EKS导入集群：检查是否配置过依赖
          if (deps.configured !== undefined) {
            // 用户曾经配置过依赖，显示配置状态
            if (deps.configured) {
              return <Tag color="green">Configured</Tag>;
            } else {
              return <Tag color="warning">Not Configured</Tag>;
            }
          } else {
            // 从未配置过依赖，显示Not Configured（需要配置）
            return <Tag color="warning">Not Configured</Tag>;
          }
        }
      } else {
        // 创建的集群：显示配置状态
        if (deps.configured) {
          return <Tag color="green">Configured</Tag>;
        } else if (deps.detected && deps.effectiveStatus) {
          return <Tag color="blue">Detected</Tag>;
        } else {
          return <Tag color="warning">Not Configured</Tag>;
        }
      }
    }
    
    // 兼容旧的简单状态
    if (dependenciesConfigured) {
      return <Tag color="green">Configured</Tag>;
    } else {
      return <Tag color="warning">Not Configured</Tag>;
    }
  };

  return getDependencyStatusDisplay();
};

// 依赖配置按钮组件
const DependencyConfigButton = ({ clusterTag, refreshTrigger, currentCluster }) => {
  const [depStatus, setDepStatus] = useState(null);
  const [configuring, setConfiguring] = useState(false);
  const [loading, setLoading] = useState(true);

  // 获取依赖状态
  const fetchDependencyStatus = async () => {
    try {
      const response = await fetch(`/api/cluster/${clusterTag}/dependencies/status`);
      const result = await response.json();
      if (result.success) {
        setDepStatus(result.dependencies);
      }
    } catch (error) {
      console.error('Failed to fetch dependency status:', error);
    } finally {
      setLoading(false);
    }
  };

  // 配置依赖
  const configureDependencies = async () => {
    setConfiguring(true);
    try {
      const response = await fetch('/api/cluster/configure-dependencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const result = await response.json();
      if (result.success) {
        message.success('Dependency configuration started');
        setDepStatus(prev => ({ ...prev, status: 'configuring' }));
        // 开始轮询状态
        pollDependencyStatus();
      } else {
        message.error(result.error || 'Failed to start dependency configuration');
      }
    } catch (error) {
      message.error('Failed to start dependency configuration');
    } finally {
      setConfiguring(false);
    }
  };

  // 轮询状态
  const pollDependencyStatus = () => {
    const interval = setInterval(async () => {
      await fetchDependencyStatus();
      if (depStatus?.status !== 'configuring') {
        clearInterval(interval);
      }
    }, 3000);
  };

  useEffect(() => {
    if (clusterTag) {
      fetchDependencyStatus();
    }
  }, [clusterTag]);

  // 响应外部刷新触发
  useEffect(() => {
    if (refreshTrigger > 0 && clusterTag) {
      fetchDependencyStatus();
    }
  }, [refreshTrigger]);

  // 获取按钮文本和状态
  const getButtonProps = () => {
    if (loading) {
      return {
        text: 'Loading...',
        disabled: true,
        type: 'default',
        icon: <SettingOutlined />
      };
    }

    // 检查是否为导入的EKS+HyperPod集群（不需要配置依赖）
    if (currentCluster?.hyperPodCluster && currentCluster?.type === 'imported') {
      return {
        text: 'Dependencies N/A',
        disabled: true,
        type: 'default',
        icon: <CheckCircleOutlined />
      };
    }

    if (!depStatus) {
      return {
        text: 'Configure Dependencies',
        disabled: true,
        type: 'default',
        icon: <SettingOutlined />
      };
    }

    switch (depStatus.status) {
      case 'pending':
        return {
          text: 'Configure Dependencies',
          disabled: false,
          type: 'primary',
          icon: <SettingOutlined />
        };
      case 'configuring':
        return {
          text: 'Configuring...',
          disabled: true,
          type: 'primary',
          icon: <SettingOutlined />
        };
      case 'success':
        return {
          text: 'Dependencies Configured',
          disabled: true,
          type: 'default',
          icon: <CheckCircleOutlined />
        };
      case 'failed':
        return {
          text: 'Retry Configuration',
          disabled: false,
          type: 'default',
          icon: <ReloadOutlined />
        };
      default:
        return {
          text: 'Configure Dependencies',
          disabled: true,
          type: 'default',
          icon: <SettingOutlined />
        };
    }
  };

  const buttonProps = getButtonProps();

  return (
    <Button 
      type={buttonProps.type}
      loading={configuring}
      disabled={buttonProps.disabled}
      onClick={configureDependencies}
      icon={buttonProps.icon}
    >
      {buttonProps.text}
    </Button>
  );
};

const ClusterManagement = () => {
  // 多集群状态管理
  const [clusters, setClusters] = useState([]);
  const [activeCluster, setActiveCluster] = useState(null);
  const [clustersLoading, setClustersLoading] = useState(false);
  const [clusterDetails, setClusterDetails] = useState(null);
  const [dependenciesConfigured, setDependenciesConfigured] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  
  // 导入现有集群状态
  const [showImportModal, setShowImportModal] = useState(false);
  const [importForm] = Form.useForm();
  const [importLoading, setImportLoading] = useState(false);
  
  // 标签页状态
  const [activeTab, setActiveTab] = useState('manage');
  // 自定义滚动条样式 - 深色主题
  const customScrollbarStyle = `
    .custom-scrollbar::-webkit-scrollbar {
      width: 8px;
    }
    
    .custom-scrollbar::-webkit-scrollbar-track {
      background: #2a2a2a;
      border-radius: 4px;
    }
    
    .custom-scrollbar::-webkit-scrollbar-thumb {
      background: #555;
      border-radius: 4px;
      border: 1px solid #333;
    }
    
    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
      background: #666;
    }
    
    .custom-scrollbar::-webkit-scrollbar-thumb:active {
      background: #777;
    }
    
    .custom-scrollbar::-webkit-scrollbar-corner {
      background: #2a2a2a;
    }
  `;

  // 默认配置值 - 基于新的 init_envs 结构 - 移到最前面
  const defaultConfig = {
    clusterTag: 'hypd-instrt-0801',
    awsRegion: 'us-west-2',
    ftpName: '',
    gpuCapacityAz: 'us-west-2c',
    gpuInstanceType: 'ml.g6.12xlarge',
    gpuInstanceCount: 2
  };

  const [form] = Form.useForm();
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [step1Status, setStep1Status] = useState('wait'); // wait, process, finish, error
  const [step2Status, setStep2Status] = useState('wait');
  const [step1Result, setStep1Result] = useState(null);
  const [step2Result, setStep2Result] = useState(null);
  const [enableFtp, setEnableFtp] = useState(false);
  const [cloudFormationStatus, setCloudFormationStatus] = useState(null);
  
  // 新增状态管理
  const [step1Details, setStep1Details] = useState(null);
  const [step2Details, setStep2Details] = useState(null);
  const [mlflowInfo, setMlflowInfo] = useState(null);
  const [logs, setLogs] = useState({ launch: '', configure: '' });
  const [logOffset, setLogOffset] = useState({ launch: 0, configure: 0 });
  const [activeLogTab, setActiveLogTab] = useState('launch');
  
  // 添加日志容器的 ref，用于自动滚动
  const logContainerRef = useRef(null);
  
  // 切换日志标签的函数，包含自动滚动
  const switchLogTab = (tab) => {
    setActiveLogTab(tab);
    // 切换后自动滚动到底部
    setTimeout(() => {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
    }, 100);
  };

  // 导入现有集群
  const importExistingCluster = async (values) => {
    setImportLoading(true);
    try {
      const response = await fetch('/api/cluster/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Successfully imported cluster: ${values.eksClusterName}`);
        setShowImportModal(false);
        importForm.resetFields();
        
        // 刷新集群列表
        await fetchClusters();
        
        // 设置为活跃集群
        setActiveCluster(values.eksClusterName);
        
        // 刷新状态
        setTimeout(() => {
          refreshAllStatus(false);
        }, 2000);
        
      } else {
        message.error(`Failed to import cluster: ${result.error}`);
      }
    } catch (error) {
      console.error('Error importing cluster:', error);
      message.error(`Error importing cluster: ${error.message}`);
    } finally {
      setImportLoading(false);
    }
  };

  // 测试集群连接
  const testClusterConnection = async () => {
    const values = importForm.getFieldsValue();
    if (!values.eksClusterName || !values.awsRegion) {
      message.warning('Please fill in EKS Cluster Name and AWS Region first');
      return;
    }
    
    setImportLoading(true);
    try {
      const response = await fetch('/api/cluster/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      const result = await response.json();
      if (result.success) {
        message.success(`Connection successful! Found ${result.nodeCount || 0} nodes`);
      } else {
        message.error(`Connection failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error testing connection:', error);
      message.error(`Error testing connection: ${error.message}`);
    } finally {
      setImportLoading(false);
    }
  };

  // 多集群管理函数
  const fetchClusters = async () => {
    setClustersLoading(true);
    try {
      const response = await fetch('/api/multi-cluster/list');
      const result = await response.json();
      if (result.success) {
        setClusters(result.clusters);
        
        // 只有当 activeCluster 真正改变时才更新
        if (result.activeCluster !== activeCluster) {
          setActiveCluster(result.activeCluster);
          
          // 集群切换时刷新页面以清除缓存
          if (result.activeCluster && activeCluster) {
            window.location.reload();
          }
          
          // 如果有活跃集群，加载其配置到表单
          if (result.activeCluster) {
            const activeClusterInfo = result.clusters.find(c => c.clusterTag === result.activeCluster);
            if (activeClusterInfo && activeClusterInfo.config) {
              form.setFieldsValue(activeClusterInfo.config);
              setEnableFtp(activeClusterInfo.config.enableFtp || false);
            }
          }
        }
        
        // 获取集群详细信息
        if (result.activeCluster) {
          await fetchClusterDetails();
        }
      }
    } catch (error) {
      console.error('Failed to fetch clusters:', error);
      message.error('Failed to load clusters');
    } finally {
      setClustersLoading(false);
    }
  };

  // 获取集群详细信息
  const fetchClusterDetails = async () => {
    try {
      const response = await fetch('/api/cluster/info');
      const result = await response.json();
      if (result.success) {
        setClusterDetails(result);
      }
    } catch (error) {
      console.error('Failed to fetch cluster details:', error);
      setClusterDetails(null);
    }
  };

  const switchCluster = async (clusterTag) => {
    if (clusterTag === activeCluster) return;
    
    setClustersLoading(true);
    // 重置依赖状态
    setDependenciesConfigured(false);
    
    try {
      const response = await fetch('/api/multi-cluster/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterTag })
      });
      
      const result = await response.json();
      if (result.success) {
        setActiveCluster(clusterTag);
        
        // 集群切换时刷新页面以清除缓存
        window.location.reload();
        
        // 检查是否有kubectl警告
        if (result.kubectlWarning) {
          message.warning(`Switched to cluster: ${clusterTag}. Kubectl config issue: ${result.kubectlWarning}`);
        } else {
          message.success(`Successfully switched to cluster: ${clusterTag}`);
        }
        
        // 加载切换后集群的配置
        const clusterInfo = clusters.find(c => c.clusterTag === clusterTag);
        if (clusterInfo && clusterInfo.config) {
          form.setFieldsValue(clusterInfo.config);
          setEnableFtp(clusterInfo.config.enableFtp || false);
        }
        
        // 获取集群详细信息
        await fetchClusterDetails();
        
        // 重置状态，因为切换到了不同的集群
        setStep1Status('wait');
        setStep2Status('wait');
        setStep1Details(null);
        setStep2Details(null);
        setLogs({ launch: '', configure: '' });
        setLogOffset({ launch: 0, configure: 0 });
        
        // 清除集群状态缓存
        try {
          await fetch('/api/cluster-status/clear-cache', { method: 'POST' });
          console.log('Cleared cluster status cache');
        } catch (cacheError) {
          console.warn('Failed to clear cluster status cache:', cacheError);
        }

        // 清除App Status缓存
        try {
          await fetch('/api/v2/app-status/clear-cache', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'all' })
          });
          console.log('Cleared app status cache');
        } catch (appCacheError) {
          console.warn('Failed to clear app status cache:', appCacheError);
        }
        
        // 延迟5秒刷新状态，给kubectl配置切换足够时间
        message.info('Updating kubectl configuration and refreshing cluster status...', 3);
        setTimeout(() => {
          refreshAllStatus(false); // 不显示成功消息
        }, 5000);
        
      } else {
        message.error(result.error || 'Failed to switch cluster');
      }
    } catch (error) {
      console.error('Failed to switch cluster:', error);
      message.error('Failed to switch cluster');
    } finally {
      setClustersLoading(false);
    }
  };

  const createNewCluster = () => {
    // 重置表单为默认值，生成新的集群标识
    const newClusterTag = `hypd-instrt-${new Date().toISOString().slice(5, 10).replace('-', '')}-${Math.random().toString(36).substr(2, 3)}`;
    const newConfig = { ...defaultConfig, clusterTag: newClusterTag };
    
    form.setFieldsValue(newConfig);
    setEnableFtp(false);
    setActiveCluster(null);
    
    // 重置状态
    setStep1Status('wait');
    setStep2Status('wait');
    setStep1Details(null);
    setStep2Details(null);
    setLogs({ launch: '', configure: '' });
    setLogOffset({ launch: 0, configure: 0 });
    
    // 切换到创建标签页
    setActiveTab('create');
    
    message.info(`Ready to create new cluster: ${newClusterTag}`);
  };

  useEffect(() => {
    console.log('ClusterManagement: Initial useEffect triggered');
    
    // 注册到全局刷新管理器
    const componentId = 'cluster-management';
    globalRefreshManager.subscribe(componentId, refreshAllStatus, {
      priority: 10 // 最高优先级
    });
    
    // 注册到操作刷新管理器
    operationRefreshManager.subscribe(componentId, refreshAllStatus);
    
    // 初始化多集群和表单默认值
    const initializeComponent = async () => {
      try {
        console.log('ClusterManagement: Starting initialization');
        // 1. 获取集群列表
        await fetchClusters();
        
        // 2. 检查当前状态，恢复按钮状态
        setTimeout(async () => {
          try {
            await refreshAllStatus(false); // 不显示成功消息
            console.log('ClusterManagement: Initial status check completed');
          } catch (error) {
            console.error('Error during initial status check:', error);
          }
        }, 1000); // 给集群列表加载一些时间
        
        console.log('ClusterManagement: Initialization completed');
      } catch (error) {
        console.error('Failed to initialize component:', error);
        // 如果初始化失败，至少设置默认值
        form.setFieldsValue(defaultConfig);
      }
    };
    
    initializeComponent();
    
    // 清理函数
    return () => {
      globalRefreshManager.unsubscribe(componentId);
      operationRefreshManager.unsubscribe(componentId);
    };
  }, []); // 只在组件挂载时执行一次

  // 单独的 useEffect 处理 activeCluster 变化
  useEffect(() => {
    console.log('ClusterManagement: activeCluster changed to:', activeCluster);
    if (!activeCluster) {
      form.setFieldsValue(defaultConfig);
    }
    // 重置依赖状态
    setDependenciesConfigured(false);
  }, [activeCluster]); // 当 activeCluster 变化时设置默认值

  // 检查步骤状态的函数
  const checkStepStatus = async () => {
    try {
      // 检查 Step 1 状态
      const step1Response = await fetch('/api/cluster/step1-status');
      const step1Result = await step1Response.json();
      
      if (step1Result.success) {
        const cfStatus = step1Result.data.status;
        setStep1Details(step1Result.data);
        setStep1Status(cfStatus === 'completed' ? 'finish' : 
                      cfStatus === 'running' ? 'process' : 
                      cfStatus === 'failed' ? 'error' : 'wait');
        
        // 只有 Step 1 完成后才检查 Step 2
        if (cfStatus === 'completed') {
          const step2Response = await fetch('/api/cluster/step2-status');
          const step2Result = await step2Response.json();
          
          if (step2Result.success) {
            const k8sStatus = step2Result.data.status;
            setStep2Details(step2Result.data);
            setStep2Status(k8sStatus === 'completed' ? 'finish' : 
                          k8sStatus === 'partial' ? 'process' : 
                          k8sStatus === 'error' ? 'error' : 'wait');
          }
        }
      }
    } catch (error) {
      console.error('Error checking status:', error);
    }
  };

  // 获取日志内容
  const fetchLogs = async (step) => {
    try {
      const currentOffset = logOffset[step] || 0;
      const response = await fetch(`/api/cluster/logs/${step}?offset=${currentOffset}`);
      const result = await response.json();
      
      if (result.success && result.data.content) {
        const hasNewContent = result.data.content.length > 0;
        
        setLogs(prev => ({
          ...prev,
          [step]: prev[step] + result.data.content
        }));
        setLogOffset(prev => ({
          ...prev,
          [step]: result.data.totalLength
        }));
        
        // 如果有新内容且当前显示的是这个步骤的日志，自动滚动到底部
        if (hasNewContent && step === activeLogTab && logContainerRef.current) {
          setTimeout(() => {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
          }, 100);
        }
      }
    } catch (error) {
      console.error('Error fetching logs:', error);
    }
  };

  // 获取 MLFlow 服务器信息
  const fetchMLFlowInfo = async () => {
    try {
      const response = await fetch('/api/cluster/mlflow-info');
      const result = await response.json();
      
      if (result.success) {
        setMlflowInfo(result.data);
      } else {
        console.error('Error fetching MLFlow info:', result.error);
        setMlflowInfo({ status: 'error', error: result.error });
      }
    } catch (error) {
      console.error('Error fetching MLFlow info:', error);
      setMlflowInfo({ status: 'error', error: error.message });
    }
  };

  // 统一的全局刷新函数 - 适配全局刷新管理器
  const refreshAllStatus = async (showSuccessMessage = true) => {
    // 如果是从全局刷新管理器调用，不显示loading状态（避免冲突）
    const isGlobalRefresh = showSuccessMessage === undefined;
    
    if (!isGlobalRefresh) {
      setLoading(true);
    }
    
    try {
      // 并行执行所有刷新操作
      await Promise.all([
        checkStepStatus(),
        refreshCloudFormationStatus(),
        fetchLogs('launch'),
        fetchLogs('configure'),
        fetchMLFlowInfo(), // 添加 MLFlow 信息获取
        fetchClusters(), // 添加集群列表刷新
        activeCluster ? fetchClusterDetails() : Promise.resolve() // 添加集群详情刷新
      ]);
      
      // 触发NodeGroupManager刷新
      setRefreshTrigger(prev => prev + 1);
      
      if (showSuccessMessage && !isGlobalRefresh) {
        message.success('Status refreshed successfully');
      }
    } catch (error) {
      console.error('Error refreshing status:', error);
      if (!isGlobalRefresh) {
        message.error(`Error refreshing status: ${error.message}`);
      }
      throw error; // 重新抛出错误，让全局刷新管理器处理
    } finally {
      if (!isGlobalRefresh) {
        setTimeout(() => setLoading(false), 500); // 给用户一个加载反馈
      }
    }
  };

  // 保存配置到 init_envs
  const saveConfiguration = async (values) => {
    try {
      const config = {
        ...values,
        enableFtp
      };

      const response = await fetch('/api/cluster/save-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const result = await response.json();
      if (result.success) {
        message.success('Configuration saved successfully');
        
        // 配置保存后，清除状态缓存并重新检查状态
        await fetch('/api/cluster/clear-status-cache', { method: 'POST' });
        setTimeout(() => {
          refreshAllStatus();
        }, 1000);
        
        return true;
      } else {
        message.error(`Failed to save configuration: ${result.error}`);
        return false;
      }
    } catch (error) {
      message.error(`Error saving configuration: ${error.message}`);
      return false;
    }
  };

  // 执行 Step 1: 集群启动
  const executeStep1 = async () => {
    setLoading(true);
    setStep1Status('process');
    
    try {
      const response = await fetch('/api/cluster/launch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();
      
      if (result.success) {
        message.success('Cluster launch started in background. Use "Refresh All" to check progress.');
        
        // 🚀 触发操作刷新 - 替代原有的setTimeout刷新
        operationRefreshManager.triggerOperationRefresh('cluster-launch', {
          clusterTag: form.getFieldValue('clusterTag') || activeCluster,
          timestamp: new Date().toISOString()
        });
        
      } else {
        setStep1Status('error');
        message.error(`Cluster launch failed: ${result.error}`);
      }
    } catch (error) {
      setStep1Status('error');
      message.error(`Error launching cluster: ${error.message}`);
    } finally {
      // 延迟设置 loading 为 false，避免与刷新冲突
      setTimeout(() => setLoading(false), 500);
    }
  };

  // 执行 Step 2: 集群配置
  const executeStep2 = async () => {
    setLoading(true);
    setStep2Status('process');
    
    try {
      const response = await fetch('/api/cluster/configure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();
      
      if (result.success) {
        message.success('Cluster configuration started in background');
        
        // 🚀 触发操作刷新 - 替代原有的setTimeout刷新
        operationRefreshManager.triggerOperationRefresh('cluster-configure', {
          clusterTag: form.getFieldValue('clusterTag') || activeCluster,
          timestamp: new Date().toISOString()
        });
        
      } else {
        setStep2Status('error');
        message.error(`Cluster configuration failed: ${result.error}`);
      }
    } catch (error) {
      setStep2Status('error');
      message.error(`Error configuring cluster: ${error.message}`);
    } finally {
      // 延迟设置 loading 为 false，避免与刷新冲突
      setTimeout(() => setLoading(false), 500);
    }
  };

  // 刷新 CloudFormation 状态 - 从 init_envs 获取堆栈名称
  const refreshCloudFormationStatus = async () => {
    try {
      // 不再从表单获取，而是从后端 init_envs 获取
      const response = await fetch('/api/cluster/cloudformation-status');
      const result = await response.json();
      
      if (result.success) {
        setCloudFormationStatus(result.data);
      } else {
        message.error(`Failed to get CloudFormation status: ${result.error}`);
      }
    } catch (error) {
      message.error(`Error getting CloudFormation status: ${error.message}`);
    }
  };

  // 处理表单提交
  const handleFormSubmit = async (values) => {
    const saved = await saveConfiguration(values);
    if (saved) {
      setCurrentStep(0);
    }
  };

  // 获取状态标签
  const getStatusTag = (status) => {
    switch (status) {
      case 'wait':
        return <Tag color="default">Waiting</Tag>;
      case 'process':
        return <Tag color="processing">Processing</Tag>;
      case 'finish':
        return <Tag color="success">Completed</Tag>;
      case 'error':
        return <Tag color="error">Failed</Tag>;
      default:
        return <Tag color="default">Unknown</Tag>;
    }
  };

  // 获取 CloudFormation 状态标签
  const getCloudFormationStatusTag = (status) => {
    if (!status) return <Tag color="default">Unknown</Tag>;
    
    switch (status.toUpperCase()) {
      case 'CREATE_COMPLETE':
      case 'UPDATE_COMPLETE':
        return <Tag color="success">{status}</Tag>;
      case 'CREATE_IN_PROGRESS':
      case 'UPDATE_IN_PROGRESS':
        return <Tag color="processing">{status}</Tag>;
      case 'CREATE_FAILED':
      case 'UPDATE_FAILED':
      case 'DELETE_FAILED':
        return <Tag color="error">{status}</Tag>;
      case 'DELETE_COMPLETE':
        return <Tag color="warning">{status}</Tag>;
      default:
        return <Tag color="default">{status}</Tag>;
    }
  };

  return (
    <>
      {/* 注入自定义滚动条样式 */}
      <style dangerouslySetInnerHTML={{ __html: customScrollbarStyle }} />
      
      <div style={{ padding: '24px' }}>
        
        <Card 
          title={
            <Space>
              <ClusterOutlined />
              <span>Cluster Management</span>
            </Space>
          } 
          style={{ marginBottom: 24 }}
        >
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'manage',
                label: (
                  <Space>
                    <InfoCircleOutlined />
                    <span>Cluster Information</span>
                  </Space>
                ),
                children: (
                  <Row gutter={24} style={{ height: '100%' }}>
                    {/* 左侧：集群选择和管理 */}
                    <Col xs={24} lg={10}>
                      <div>
                        {/* 集群选择器和管理功能 */}
                        <Row gutter={16} align="middle" style={{ marginBottom: 24 }}>
                          <Col flex="auto">
                            <Space direction="vertical" style={{ width: '100%' }}>
                              {/* 集群列表刷新按钮 */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Text strong>Active Cluster:</Text>
                                <Button 
                                  size="small"
                                  icon={<ReloadOutlined />} 
                                  onClick={async () => {
                                    await fetchClusters();
                                    if (activeCluster) {
                                      await fetchClusterDetails();
                                    }
                                    setRefreshTrigger(prev => prev + 1);
                                  }}
                                  loading={clustersLoading}
                                  type="text"
                                >
                                  Refresh
                                </Button>
                              </div>
                              <div>
                                <Select
                                  value={activeCluster}
                                  onChange={switchCluster}
                                  style={{ width: '100%' }}
                                  placeholder="Select a cluster or import/create one"
                                  loading={clustersLoading}
                                  allowClear
                                  showSearch
                                  optionFilterProp="children"
                                >
                                  {clusters.map(cluster => (
                                    <Option key={cluster.clusterTag} value={cluster.clusterTag}>
                                      <Space>
                                        <span>{cluster.clusterTag}</span>
                                        <Tag color={cluster.type === 'imported' ? 'blue' : 'green'} size="small">
                                          {cluster.type === 'imported' ? 'Imported' : 'Created'}
                                        </Tag>
                                        <Text type="secondary" style={{ fontSize: '12px' }}>
                                          {new Date(cluster.lastModified).toLocaleDateString()}
                                        </Text>
                                      </Space>
                                    </Option>
                                  ))}
                                </Select>
                              </div>
                              {activeCluster && (
                                <Alert
                                  message={`Currently managing cluster: ${activeCluster}`}
                                  type="info"
                                  showIcon
                                  style={{ marginTop: 8 }}
                                />
                              )}
                              {!activeCluster && clusters.length === 0 && (
                                <Alert
                                  message="No clusters found. Import an existing cluster or create a new one."
                                  type="warning"
                                  showIcon
                                  style={{ marginTop: 8 }}
                                />
                              )}
                            </Space>
                          </Col>
                          <Col>
                            <Space direction="vertical" align="center">
                              <Text type="secondary" style={{ fontSize: '12px' }}>
                                Total Clusters
                              </Text>
                              <Tag color="blue" style={{ fontSize: '16px', padding: '4px 12px' }}>
                                {clusters.length}
                              </Tag>
                            </Space>
                          </Col>
                        </Row>

                        {/* 集群操作按钮 */}
                        <Row style={{ marginBottom: 24 }}>
                          <Col>
                            <Space>
                              {activeCluster && (
                                <DependencyConfigButton 
                                  clusterTag={activeCluster} 
                                  refreshTrigger={refreshTrigger}
                                  currentCluster={clusters.find(c => c.clusterTag === activeCluster)}
                                />
                              )}
                              <Button 
                                type="default"
                                icon={<ImportOutlined />} 
                                onClick={() => setShowImportModal(true)}
                              >
                                Import Existing Cluster
                              </Button>
                            </Space>
                          </Col>
                        </Row>

                        {/* 集群信息显示 */}
                        {activeCluster && (() => {
                          const cluster = clusters.find(c => c.clusterTag === activeCluster);
                          if (!cluster) return <Text type="secondary">Loading cluster information...</Text>;
                          
                          // 统一获取cluster tag和region
                          const clusterTag = cluster.clusterTag || cluster.config?.clusterTag || 'N/A';
                          const region = cluster.region || cluster.config?.awsRegion || 'N/A';
                          const creationType = cluster.type === 'imported' ? 'Imported' : 'Created';
                          const creationColor = cluster.type === 'imported' ? 'blue' : 'green';
                          
                          // 从API获取的详细信息
                          const eksClusterName = clusterDetails?.eksClusterName || 'N/A';
                          const vpcId = clusterDetails?.vpcId || 'N/A';
                          
                          return (
                            <Card title="Cluster Details" size="small">
                              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Custom Tag:</Text>
                                      <br />
                                      <Text code>{clusterTag}</Text>
                                    </div>
                                  </Col>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>AWS Region:</Text>
                                      <br />
                                      <Text code>{region}</Text>
                                    </div>
                                  </Col>
                                </Row>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>EKS Cluster Name:</Text>
                                      <br />
                                      <Text code>{eksClusterName}</Text>
                                    </div>
                                  </Col>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Cluster VPC:</Text>
                                      <br />
                                      <Text code>{vpcId}</Text>
                                    </div>
                                  </Col>
                                </Row>
                                <Row gutter={[16, 16]}>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Creation Type:</Text>
                                      <br />
                                      <Tag color={creationColor}>{creationType}</Tag>
                                    </div>
                                  </Col>
                                  <Col span={12}>
                                    <div>
                                      <Text strong>Dependencies:</Text>
                                      <br />
                                      <DependencyStatus 
                                        cluster={cluster} 
                                        dependenciesConfigured={dependenciesConfigured} 
                                      />
                                    </div>
                                  </Col>
                                </Row>
                              </Space>
                            </Card>
                          );
                        })()}
                      </div>
                    </Col>
                    
                    {/* 右侧：Node Groups */}
                    <Col xs={24} lg={14}>
                      {activeCluster ? (
                        <NodeGroupManager 
                          dependenciesConfigured={dependenciesConfigured}
                          activeCluster={activeCluster}
                          onDependencyStatusChange={setDependenciesConfigured}
                          onRefreshClusterDetails={fetchClusterDetails}
                          refreshTrigger={refreshTrigger}
                          cluster={clusters.find(c => c.clusterTag === activeCluster)}
                        />
                      ) : (
                        <Card title="Node Groups" style={{ height: '100%' }}>
                          <div style={{ 
                            display: 'flex', 
                            justifyContent: 'center', 
                            alignItems: 'center', 
                            height: '200px',
                            flexDirection: 'column'
                          }}>
                            <Text type="secondary" style={{ fontSize: '16px', marginBottom: '8px' }}>
                              No Active Cluster
                            </Text>
                            <Text type="secondary">
                              Please select or import a cluster to view node groups
                            </Text>
                          </div>
                        </Card>
                      )}
                    </Col>
                  </Row>
                )
              },
              {
                key: 'create-eks',
                label: (
                  <Space>
                    <CloudServerOutlined />
                    <span>Create EKS Cluster</span>
                  </Space>
                ),
                children: <EksClusterCreationPanel />
              },
              ...(process.env.REACT_APP_SHOW_DEPRECATED_CREATE_CLUSTER === 'true' ? [{
                key: 'create',
                label: 'CreateCluster[DEPRECATED]',
                children: (
                  <CreateClusterDeprecated
                    form={form}
                    defaultConfig={defaultConfig}
                    enableFtp={enableFtp}
                    setEnableFtp={setEnableFtp}
                    handleFormSubmit={handleFormSubmit}
                    currentStep={currentStep}
                    step1Status={step1Status}
                    step2Status={step2Status}
                    executeStep1={executeStep1}
                    executeStep2={executeStep2}
                    loading={loading}
                    refreshAllStatus={refreshAllStatus}
                    step1Details={step1Details}
                    step2Details={step2Details}
                    step1Result={step1Result}
                    step2Result={step2Result}
                    mlflowInfo={mlflowInfo}
                    activeLogTab={activeLogTab}
                    switchLogTab={switchLogTab}
                    logs={logs}
                    logContainerRef={logContainerRef}
                    getCloudFormationStatusTag={getCloudFormationStatusTag}
                    getStatusTag={getStatusTag}
                  />
                )
              }] : [])
            ]}
          />
        </Card>
      </div>
    
    {/* 导入现有集群 Modal */}
    <Modal
      title={
        <Space>
          <ImportOutlined />
          <span>Import Existing Cluster</span>
        </Space>
      }
      open={showImportModal}
      onCancel={() => {
        setShowImportModal(false);
        importForm.resetFields();
      }}
      footer={null}
      width={600}
    >
      <Alert
        message="Import Existing EKS Cluster"
        description="Connect to your existing EKS cluster with HyperPod nodegroups. Only 3 fields required - other information will be auto-detected."
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />
      
      <Form
        form={importForm}
        layout="vertical"
        onFinish={importExistingCluster}
      >
        <Form.Item
          label="EKS Cluster Name"
          name="eksClusterName"
          rules={[{ required: true, message: 'Please enter EKS cluster name' }]}
          extra="The name of your existing EKS cluster"
        >
          <Input placeholder="my-eks-cluster" />
        </Form.Item>

        <Form.Item
          label="AWS Region"
          name="awsRegion"
          rules={[{ required: true, message: 'Please enter AWS region' }]}
          extra="The AWS region where your EKS cluster is located"
        >
          <Input placeholder="us-west-2" />
        </Form.Item>

        <Form.Item
          label="HyperPod Cluster Name (Optional)"
          name="hyperPodClusters"
          extra="Enter the HyperPod cluster name associated with this EKS cluster"
        >
          <Input 
            placeholder="hp-cluster-name"
          />
        </Form.Item>

        <Divider />

        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Button 
            onClick={testClusterConnection}
            loading={importLoading}
            icon={<CheckCircleOutlined />}
          >
            Test Connection
          </Button>
          
          <Space>
            <Button onClick={() => {
              setShowImportModal(false);
              importForm.resetFields();
            }}>
              Cancel
            </Button>
            <Button 
              type="primary" 
              htmlType="submit"
              loading={importLoading}
              icon={<ImportOutlined />}
            >
              Import Cluster
            </Button>
          </Space>
        </Space>
      </Form>
    </Modal>
    </>
  );
};

export default ClusterManagement;
