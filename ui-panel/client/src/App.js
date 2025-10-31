import React, { useState, useEffect, useCallback } from 'react';
import { Layout, Row, Col, Card, message, Tabs, Space, Badge, Button } from 'antd';
import { useDispatch } from 'react-redux';
import { ContainerOutlined, ApiOutlined, RocketOutlined, ExperimentOutlined, DatabaseOutlined, CloudServerOutlined, SettingOutlined, ReloadOutlined } from '@ant-design/icons';
import { refreshAllAppStatus } from './store/slices/appStatusSlice';
import ThemeProvider from './components/ThemeProvider';
import ConfigPanel from './components/ConfigPanel';
import ServiceConfigPanel from './components/ServiceConfigPanel';
import ClusterStatusV2Redux from './components/ClusterStatusV2Redux';
import TestPanel from './components/TestPanel';
import StatusMonitorRedux from './components/StatusMonitorRedux';
// 备份：原部署管理组件已迁移到StatusMonitorRedux
import HyperPodRecipes from './components/HyperPodRecipes';
import TrainingMonitorPanel from './components/TrainingMonitorPanelRedux';
import TrainingHistoryPanel from './components/TrainingHistoryPanel';
// import ModelDownloadPanel from './components/ModelDownloadPanel'; // 未使用
// import S3StoragePanel from './components/S3StoragePanel'; // 未使用
// import HyperPodJobManager from './components/HyperPodJobManager'; // 备份：原训练任务管理组件
import ClusterManagement from './components/ClusterManagementRedux';
import GlobalRefreshButtonRedux from './components/GlobalRefreshButtonRedux';
// import OperationFeedback from './components/OperationFeedback'; // 已移除：右上角详细卡片
import EnhancedModelManagement from './components/EnhancedModelManagement';
// 🎨 PREVIEW ONLY - Remove this import to clean up preview
import AdvancedScalingPanelV2 from './components/AdvancedScalingPanelV2';
import ScalingPanel from './components/ScalingPanel';
import globalRefreshManager from './hooks/useGlobalRefresh';
import operationRefreshManager from './hooks/useOperationRefresh';
// import { refreshManager } from './hooks/useAutoRefresh'; // 未使用
import { getActiveTheme } from './config/themeConfig';
import './utils/testOperationRefresh'; // 导入测试工具
import './utils/refreshConfigViewer'; // 导入刷新配置查看工具
import './App.css';
import './styles/dynamic-theme.css';

const { Header, Content } = Layout;
const { TabPane } = Tabs;
// const { Text } = Typography; // 未使用

function App() {
  const dispatch = useDispatch();

  const [clusterData, setClusterData] = useState([]);
  const [pods, setPods] = useState([]);
  const [services, setServices] = useState([]);
  const [businessServices, setBusinessServices] = useState([]);
  const [deploymentStatus, setDeploymentStatus] = useState(null);
  const [ws, setWs] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [refreshing, setRefreshing] = useState(false);
  const [activeMainTab, setActiveMainTab] = useState('model-management'); // 新增主标签状态
  const [configTab, setConfigTab] = useState('model-config'); // 配置标签页状态

  // 🔄 全局App Status刷新函数
  const handleAppStatusRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await dispatch(refreshAllAppStatus()).unwrap();
      message.success('App status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing app status:', error);
      message.error('Failed to refresh app status: ' + (error.message || error));
    } finally {
      setRefreshing(false);
    }
  }, [dispatch]);

  const connectWebSocket = () => {
    console.log('Attempting to connect to WebSocket...');
    
    const websocket = new WebSocket('ws://localhost:3098');
    
    // 设置连接超时
    const connectionTimeout = setTimeout(() => {
      if (websocket.readyState === WebSocket.CONNECTING) {
        console.log('WebSocket connection timeout, closing...');
        websocket.close();
        setConnectionStatus('error');
      }
    }, 10000); // 10秒连接超时
    
    websocket.onopen = () => {
      console.log('WebSocket connected successfully');
      clearTimeout(connectionTimeout);
      setWs(websocket);
      setConnectionStatus('connected');
    };
    
    websocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('📡 WebSocket message received:', data.type);
        
        switch (data.type) {
          case 'status_update':
            console.log('📊 Status update:', data.pods?.length, 'pods,', data.services?.length, 'services');
            setPods(data.pods || []);
            setServices(data.services || []);
            break;
            
          case 'request_status_update_broadcast':
            // 🔄 服务器请求客户端更新状态
            console.log('🔄 Server requested status update');
            // 触发全局刷新，但不显示消息
            globalRefreshManager.triggerGlobalRefresh({
              source: 'websocket-broadcast',
              silent: true
            });
            break;
            
          case 'pong':
            // 心跳响应
            console.log('❤️ WebSocket pong received');
            break;
            
          case 'deployment':
            setDeploymentStatus(data);
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('model-deploy', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'service_deployment':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新，更新业务Service列表
              operationRefreshManager.triggerOperationRefresh('service-deploy', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'service_deleted':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新，更新业务Service列表
              operationRefreshManager.triggerOperationRefresh('service-delete', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'training_launch':
            // 处理训练任务部署状态
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('training-start', data);
            } else {
              message.error(data.message);
            }
            break;

          case 'nodegroup_creation_started':
          if (data.status === 'success' || data.status === 'info') {
            message.success(data.message);
          } else {
            message.error(data.message);
          }
          operationRefreshManager.triggerOperationRefresh('nodegroup-create', data);
          break;

        case 'nodegroup_creation_completed':
          if (data.status === 'success') {
            message.success(data.message);
          } else {
            message.error(data.message);
          }
          operationRefreshManager.triggerOperationRefresh('nodegroup-create', data);
          break;

        case 'nodegroup_creation_failed':
          message.error(data.message);
          operationRefreshManager.triggerOperationRefresh('nodegroup-create', data);
          break;

        case 'nodegroup_dependencies_started':
          if (data.status === 'success' || data.status === 'info') {
            message.info(data.message);
          }
          break;

        case 'nodegroup_dependencies_completed':
          if (data.status === 'success') {
            message.success(data.message);
          } else {
            message.error(data.message);
          }
          operationRefreshManager.triggerOperationRefresh('nodegroup-create', data);
          break;

        case 'nodegroup_dependencies_failed':
          message.error(data.message);
          operationRefreshManager.triggerOperationRefresh('nodegroup-create', data);
          break;

        case 'hyperpod_creation_started':
            if (data.status === 'success' || data.status === 'info') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('hyperpod-create', data);
            } else {
              message.error(data.message);
            }
            break;

          case 'hyperpod_creation_completed':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('hyperpod-create', data);
            }
            break;

          case 'hyperpod_creation_failed':
            message.error(data.message);
            // 🚀 触发操作刷新
            operationRefreshManager.triggerOperationRefresh('hyperpod-create', data);
            break;

          case 'hyperpod_deletion_started':
            message.info(data.message);
            operationRefreshManager.triggerOperationRefresh('hyperpod-delete', data);
            break;

          case 'hyperpod_deletion_completed':
            message.success('HyperPod cluster deleted successfully');
            operationRefreshManager.triggerOperationRefresh('hyperpod-delete', data);
            break;

          case 'hyperpod_deletion_failed':
            message.error('HyperPod deletion failed');
            operationRefreshManager.triggerOperationRefresh('hyperpod-delete', data);
            break;

          case 'karpenter_installation_completed':
            message.success('Karpenter installation completed successfully');
            // 简化：不触发复杂刷新，用户会自然地刷新页面查看结果
            break;

          case 'karpenter_installation_failed':
            message.error('Karpenter installation failed');
            // 简化：不触发复杂刷新，用户会自然地刷新页面查看结果
            break;

          case 'karpenter_uninstallation_completed':
            message.success('Karpenter uninstallation completed successfully');
            // 简化：不触发复杂刷新，用户会自然地刷新页面查看结果
            break;

          case 'karpenter_uninstallation_failed':
            message.error('Karpenter uninstallation failed');
            // 简化：不触发复杂刷新，用户会自然地刷新页面查看结果
            break;

          case 'undeployment':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('model-undeploy', data);
            } else {
              message.error(data.message);
            }
            break;

          case 'sglang_router_deletion':
            if (data.status === 'success') {
              message.success(`Router "${data.deploymentName}" deleted successfully`);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('router-delete', data);
            } else {
              message.error(`Failed to delete Router: ${data.error}`);
            }
            break;
            
          case 'rayjob_deleted':
            // 处理RayJob删除状态
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新 - 使用rayjob-delete操作
              operationRefreshManager.triggerOperationRefresh('rayjob-delete', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'pod_assigned':
            // 处理Pod分配状态
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新 - 使用pod-assign操作
              operationRefreshManager.triggerOperationRefresh('pod-assign', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'training_job_deleted':
            // 处理训练任务删除状态
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新 - 使用training-delete操作
              operationRefreshManager.triggerOperationRefresh('training-delete', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'model_download':
            // 处理模型下载状态
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('model-download', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'nodegroup_updated':
            if (data.status === 'success') {
              message.success(data.message);
              operationRefreshManager.triggerOperationRefresh('nodegroup-scale', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'hyperpod_software_update':
            if (data.status === 'success') {
              message.success(data.message);
              operationRefreshManager.triggerOperationRefresh('hyperpod-software-update', data);
            } else {
              message.error(data.message);
            }
            break;
            
          case 'cluster_dependencies_started':
            if (data.status === 'success' || data.status === 'info') {
              message.info(data.message);
            }
            break;
            
          case 'cluster_dependencies_completed':
            if (data.status === 'success') {
              message.success(data.message);
              // 触发全局刷新，更新集群状态
              globalRefreshManager.triggerGlobalRefresh();
            }
            break;
            
          case 'cluster_dependencies_failed':
            if (data.status === 'warning') {
              message.warning(data.message);
              // 即使失败也触发刷新，让用户看到集群
              globalRefreshManager.triggerGlobalRefresh();
            } else {
              message.error(data.message);
            }
            break;
            
          case 'cluster_creation_cancelled':
            if (data.status === 'info') {
              message.info(data.message);
            }
            break;
            
          case 'cluster_creation_cancel_failed':
            if (data.status === 'error') {
              message.error(data.message);
            }
            break;

          case 'keda_deployment':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('keda-deploy', data);
            } else {
              message.error(data.message);
            }
            break;

          case 'keda_scaledobject_deleted':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('keda-delete', data);
            } else {
              message.error(data.message);
            }
            break;

          case 'sglang_router_deployment':
            if (data.status === 'success') {
              message.success(data.message);
              // 🚀 触发操作刷新
              operationRefreshManager.triggerOperationRefresh('sglang-router-deploy', data);
            } else {
              message.error(data.message);
            }
            break;

          default:
            console.log('❓ Unknown message type:', data.type);
            break;
        }
      } catch (error) {
        console.error('❌ Error parsing WebSocket message:', error);
      }
    };
    
    websocket.onclose = (event) => {
      console.log('WebSocket disconnected:', event.code, event.reason);
      clearTimeout(connectionTimeout);
      setWs(null);
      setConnectionStatus('disconnected');
      
      // 自动重连机制（5秒后重连）
      if (event.code !== 1000) { // 不是正常关闭
        console.log('Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
          if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWebSocket();
          }
        }, 5000);
      }
    };
    
    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      clearTimeout(connectionTimeout);
      setConnectionStatus('error');
    };
    
    return websocket;
  };

  // 🔄 通过WebSocket按需请求状态更新
  const requestWebSocketStatusUpdate = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'request_status_update',
        timestamp: new Date().toISOString()
      }));
      console.log('📡 Requested WebSocket status update');
    }
  };

  // 💓 WebSocket心跳检测
  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ping',
          timestamp: new Date().toISOString()
        }));
      }
    }, 30000); // 每30秒发送一次心跳
    
    return () => clearInterval(pingInterval);
  }, [ws]);

  useEffect(() => {
    // 注册App级别的刷新函数到全局刷新管理器
    const appRefreshFunction = async () => {
      // 🔄 优先通过WebSocket请求更新（更快）
      if (ws && ws.readyState === WebSocket.OPEN) {
        requestWebSocketStatusUpdate();
      }
      
      // 🔄 同时执行API调用作为备用
      await Promise.all([
        fetchClusterStatus(),
        fetchPodsAndServices()
      ]);
    };

    globalRefreshManager.subscribe('app-status', appRefreshFunction, {
      priority: 9 // 高优先级，与cluster-status同级
    });

    // 🚀 注册到操作刷新管理器
    operationRefreshManager.subscribe('app-status', appRefreshFunction);

    // 🚀 注册pods和services刷新到全局刷新管理器
    const podsServicesRefreshFunction = async () => {
      try {
        await fetchPodsAndServices();
      } catch (error) {
        console.error('Pods and services refresh error:', error);
        throw error;
      }
    };

    globalRefreshManager.subscribe('pods-services', podsServicesRefreshFunction, {
      priority: 8 // 高优先级，与status-monitor相同
    });

    // 🚀 注册到操作刷新管理器
    operationRefreshManager.subscribe('pods-services', podsServicesRefreshFunction);

    // 延迟连接WebSocket，给后端服务器启动时间
    const connectTimer = setTimeout(() => {
      connectWebSocket();
    }, 1000); // 延迟1秒连接
    
    // 初始加载集群状态
    fetchClusterStatus();
    
    // 初始加载pods和services（作为备用）
    fetchPodsAndServices();
    
    // 初始加载业务Service列表
    fetchBusinessServices();
    
    return () => {
      clearTimeout(connectTimer);
      globalRefreshManager.unsubscribe('app-status');
      globalRefreshManager.unsubscribe('pods-services');
      operationRefreshManager.unsubscribe('app-status');
      operationRefreshManager.unsubscribe('pods-services');
      if (ws) {
        ws.close(1000, 'Component unmounting'); // 正常关闭
      }
    };
  }, []);

  const fetchClusterStatus = useCallback(async () => {
    try {
      console.log('Fetching cluster status...');
      const response = await fetch('/api/cluster-status');
      const data = await response.json();
      console.log('Cluster status response:', data);
      setClusterData(data.nodes || []);
    } catch (error) {
      console.error('Error fetching cluster status:', error);
      message.error('Failed to fetch cluster status');
    }
  }, []); // 空依赖数组，因为函数内部没有依赖外部变量

  // 配置：是否使用 V2 API（可以通过环境变量或配置文件控制）
  const USE_V2_API = true; // 默认使用 V2 API

  // 获取业务Service列表
  const fetchBusinessServices = async () => {
    try {
      const response = await fetch('/api/binding-services');
      const data = await response.json();
      setBusinessServices(data);
    } catch (error) {
      console.error('Error fetching business services:', error);
      setBusinessServices([]);
    }
  };

  const fetchPodsAndServices = useCallback(async () => {
    try {
      setRefreshing(true);
      console.log(`Fetching pods and services using ${USE_V2_API ? 'V2' : 'V1'} API...`);
      
      if (USE_V2_API) {
        // 使用 V2 优化 API
        const response = await fetch('/api/v2/app-status');
        const data = await response.json();
        
        console.log('App Status V2 response:', {
          pods: data.pods?.length || 0,
          services: data.services?.length || 0,
          fetchTime: data.fetchTime,
          cached: data.cached
        });
        
        // V2 API 返回处理过的数据，需要提取原始数据给现有组件使用
        setPods(data.rawPods || data.pods || []);
        setServices(data.rawServices || data.services || []);
        
        // 可以选择性地显示性能信息
        if (data.fetchTime && !data.cached) {
          console.log(`Fresh data fetched in ${data.fetchTime}ms`);
        } else if (data.cached) {
          console.log('Using cached data');
        }
      } else {
        // 使用原有 V1 API
        const [podsResponse, servicesResponse] = await Promise.all([
          fetch('/api/pods'),
          fetch('/api/services')
        ]);
        
        const podsData = await podsResponse.json();
        const servicesData = await servicesResponse.json();
        
        console.log('Pods response:', podsData.length, 'pods');
        console.log('Services response:', servicesData.length, 'services');
        
        setPods(podsData);
        setServices(servicesData);
      }
      
      // 同时获取业务Service列表
      await fetchBusinessServices();
      
    } catch (error) {
      console.error('Error fetching pods and services:', error);
      message.error('Failed to fetch pods and services');
    } finally {
      setRefreshing(false);
    }
  }, []); // 空依赖数组

  const handleDeploy = async (config) => {
    console.log('🚀 handleDeploy called with config:', config);
    try {
      console.log('🚀 Deploying with config:', config);
      const response = await fetch('/api/deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });
      
      console.log('📡 Response received:', response);
      const result = await response.json();
      console.log('📊 Response JSON:', result);
      
      if (result.success) {
        // 🚀 触发操作刷新 - 立即刷新相关组件
        operationRefreshManager.triggerOperationRefresh('model-deploy', {
          modelId: config.modelId,
          deploymentType: config.deploymentType,
          timestamp: new Date().toISOString(),
          source: 'config-panel'
        });
        
        console.log('✅ Model deployment initiated and refresh triggered');
      } else {
        message.error(`Deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error deploying:', error);
      message.error('Failed to deploy model');
    }
  };

  const handleServiceDeploy = async (config) => {
    console.log('🚀 handleServiceDeploy called with config:', config);
    try {
      const response = await fetch('/api/deploy-service', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success('Business service deployed successfully!');
        // 触发操作刷新
        operationRefreshManager.triggerOperationRefresh('service-deploy', {
          serviceName: config.serviceName,
          timestamp: new Date().toISOString(),
          source: 'service-config-panel'
        });
      } else {
        message.error(`Service deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error deploying service:', error);
      message.error('Failed to deploy service');
    }
  };

  // 🎨 PREVIEW ONLY - Remove this function to clean up preview
  const handleAdvancedScalingDeploy = async (config) => {
    try {
      console.log('Deploying advanced scaling configuration:', config);

      const response = await fetch('/api/deploy-advanced-scaling', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const result = await response.json();

      if (result.success) {
        message.success('Advanced scaling stack deployed successfully!');
        // 触发操作刷新
        operationRefreshManager.triggerOperationRefresh('advanced-scaling-deploy', {
          timestamp: new Date().toISOString(),
          source: 'advanced-scaling-panel'
        });
      } else {
        message.error(`Advanced scaling deployment failed: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error deploying advanced scaling:', error);
      message.error('Failed to deploy advanced scaling stack');
    }
  };

  // 🎨 PREVIEW ONLY - KEDA Scaling deployment handler
  const handleScalingDeploy = async (config) => {
    try {
      console.log('Deploying KEDA scaling configuration:', config);

      // 根据配置类型选择不同的API端点
      let apiEndpoint = '/api/deploy-keda-scaling'; // 默认旧版本

      if (config.type === 'keda-scaling-unified') {
        apiEndpoint = '/api/deploy-keda-scaling-unified';
      }

      console.log(`Using API endpoint: ${apiEndpoint} for config type: ${config.type}`);

      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });

      const result = await response.json();

      if (result.success) {
        if (config.type === 'keda-scaling-unified') {
          message.success(`Unified KEDA scaling deployed for service: ${config.serviceName}`);
        } else {
          message.success('KEDA scaling configuration deployed successfully!');
        }

        // 触发操作刷新
        operationRefreshManager.triggerOperationRefresh('keda-scaling-deploy', {
          timestamp: new Date().toISOString(),
          source: 'scaling-panel',
          configType: config.type
        });
      } else {
        message.error(`KEDA scaling deployment failed: ${result.error}`);
        if (result.errors && result.errors.length > 0) {
          result.errors.forEach(error => {
            message.error(error);
          });
        }
      }
    } catch (error) {
      console.error('❌ Error deploying KEDA scaling:', error);
      message.error('Failed to deploy KEDA scaling configuration');
    }
  };

  const handleTrainingLaunch = async (config) => {
    try {
      console.log('Launching training job with config:', config);
      
      // 根据recipeType选择不同的API端点
      let apiEndpoint = '/api/launch-training'; // 默认LlamaFactory
      
      if (config.recipeType === 'verl') {
        apiEndpoint = '/api/launch-verl-training';
      } else if (config.recipeType === 'torch') {
        apiEndpoint = '/api/launch-torch-training';
      } else if (config.recipeType === 'script') {
        apiEndpoint = '/api/launch-script-training';
      }
      
      console.log(`Using API endpoint: ${apiEndpoint} for recipe type: ${config.recipeType}`);
      
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
      });
      
      const result = await response.json();
      
      if (result.success) {
        // 移除重复的message.success，让WebSocket处理通知
        // message.success('Training job deployed successfully');
        // 刷新集群状态
        fetchClusterStatus();
        // 刷新pods和services
        fetchPodsAndServices();
      } else {
        message.error(`Training launch failed: ${result.error}`);
      }
    } catch (error) {
      console.error('Error launching training job:', error);
      message.error('Failed to launch training job');
    }
  };

  const getConnectionStatusIndicator = () => {
    switch (connectionStatus) {
      case 'connected':
        return '🟢';
      case 'connecting':
        return '🟡';
      case 'disconnected':
        return '🟠';
      case 'error':
        return '🔴';
      default:
        return '🔴';
    }
  };

  const theme = getActiveTheme();

  return (
    <ThemeProvider>
      <Layout className="app-layout">
        <Header
          className={`theme-header ${theme.name === 'aws' ? 'aws-header' : ''}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 24px'
          }}
        >
          <h1 className="theme-header-title">
            <CloudServerOutlined style={{ marginRight: '8px' }} />
            HyperPod InstantStart
            <span className="theme-header-subtitle">
              Unified Platform
            </span>
          </h1>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <GlobalRefreshButtonRedux
              showAutoRefresh={true}
              autoRefreshOptions={{
                defaultEnabled: true,
                defaultInterval: 30000
              }}
              size="small"
            />
            <div style={{
              fontSize: '12px',
              lineHeight: '1',
              display: 'flex',
              alignItems: 'center'
            }}>
              {getConnectionStatusIndicator()}
            </div>
          </div>
        </Header>
      
      <Content className="app-content">
        {/* 主标签切换区域 */}
        <div style={{ marginBottom: '16px' }}>
          <Tabs 
            activeKey={activeMainTab}
            onChange={setActiveMainTab}
            size="large"
            items={[
              {
                key: 'cluster-management',
                label: (
                  <Space>
                    <SettingOutlined />
                    Cluster Management
                  </Space>
                ),
              },
              {
                key: 'model-management',
                label: (
                  <Space>
                    <DatabaseOutlined />
                    Model Management
                  </Space>
                ),
              },
              {
                key: 'inference',
                label: (
                  <Space>
                    <RocketOutlined />
                    Inference
                  </Space>
                ),
              },
              {
                key: 'training',
                label: (
                  <Space>
                    <ExperimentOutlined />
                    Training
                  </Space>
                ),
              },
              {
                key: 'training-history',
                label: (
                  <Space>
                    <DatabaseOutlined />
                    Training History
                  </Space>
                ),
              }
            ]}
          />
        </div>
        
        {/* 中间动态内容区域 */}
        <div style={{ marginBottom: '16px' }}>
          {/* Cluster Management */}
          <div style={{ display: activeMainTab === 'cluster-management' ? 'block' : 'none' }}>
            <ClusterManagement />
          </div>

          <div style={{ display: activeMainTab === 'inference' ? 'block' : 'none' }}>
            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Card 
                  title="Inference Configuration" 
                  className="theme-card compute"
                  style={{ height: '50vh', overflow: 'auto' }}
                >
                  <Tabs 
                    activeKey={configTab} 
                    onChange={setConfigTab}
                    size="small"
                    items={[
                      {
                        key: 'model-config',
                        label: 'Model Deployment',
                        children: (
                          <ConfigPanel 
                            onDeploy={handleDeploy}
                            deploymentStatus={deploymentStatus}
                          />
                        )
                      },
                      {
                        key: 'service-config',
                        label: 'Service Binding',
                        children: (
                          <ServiceConfigPanel
                            onDeploy={handleServiceDeploy}
                            deploymentStatus={deploymentStatus}
                          />
                        )
                      },
                      // 🎨 PREVIEW ONLY - Remove this tab to clean up preview
                      {
                        key: 'advanced-scaling-preview',
                        label: 'Advanced Routing',
                        children: (
                          <AdvancedScalingPanelV2
                            onDeploy={handleAdvancedScalingDeploy}
                            deploymentStatus={deploymentStatus}
                          />
                        )
                      },
                      // 🎨 PREVIEW ONLY - KEDA Scaling tab
                      {
                        key: 'keda-scaling-preview',
                        label: (
                          <Space>
                            Unified Scaling
                            <Badge count="PREVIEW" style={{ backgroundColor: '#ff4d4f' }} />
                          </Space>
                        ),
                        children: (
                          <ScalingPanel
                            onDeploy={handleScalingDeploy}
                            deploymentStatus={deploymentStatus}
                          />
                        )
                      }
                    ]}
                  />
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card 
                  title="Model Testing"
                  className="theme-card ml"
                  style={{ height: '50vh', overflow: 'auto' }}
                >
                  <TestPanel 
                    services={services} 
                    onRefresh={fetchPodsAndServices}
                  />
                </Card>
              </Col>
            </Row>
          </div>
          
          <Row gutter={[16, 16]} style={{ display: activeMainTab === 'training' ? 'flex' : 'none' }}>
            {/* Training - 左侧：训练配置 */}
            <Col xs={24} lg={12}>
              <Card 
                title="Training Recipes" 
                className="theme-card compute"
                style={{ height: '50vh', overflow: 'auto' }}
              >
                <HyperPodRecipes 
                  onLaunch={handleTrainingLaunch}
                  deploymentStatus={deploymentStatus}
                />
              </Card>
            </Col>
            
            {/* Training - 右侧：训练监控 */}
            <Col xs={24} lg={12}>
              <Card 
                title="Training Job Monitor"
                className="theme-card analytics"
                style={{ height: '50vh', overflow: 'auto' }}
              >
                <TrainingMonitorPanel />
              </Card>
            </Col>
          </Row>
          
          <div style={{
            display: activeMainTab === 'training-history' ? 'block' : 'none'
          }}>
            <TrainingHistoryPanel />
          </div>
          
          <div style={{ display: activeMainTab === 'model-management' ? 'block' : 'none' }}>
            <EnhancedModelManagement />
          </div>
        </div>
        
        {/* 底部监控区域 (共享) */}
        <Row gutter={[16, 16]}>
          {/* 左下：集群状态 */}
          <Col xs={24} lg={12}>
            <Card 
              title="Cluster Status" 
              className="theme-card analytics"
              style={{ height: '45vh', overflow: 'auto' }}
            >
              <ClusterStatusV2Redux />
            </Card>
          </Col>
          
          {/* 右下：状态监控和部署管理 */}
          <Col xs={24} lg={12}>
            <Card 
              title="App Status"
              className="theme-card database"
              style={{ height: '45vh', overflow: 'auto' }}
              bodyStyle={{ padding: 0 }}
            >
              <Tabs
                defaultActiveKey="pods"
                size="small"
                tabBarExtraContent={
                  <div style={{ marginRight: '12px' }}>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={refreshing}
                      onClick={handleAppStatusRefresh}
                      title="Refresh All App Status Data"
                    >
                      Refresh
                    </Button>
                  </div>
                }
              >
                <TabPane 
                  tab={
                    <Space>
                      <ContainerOutlined />
                      Pods
                      <Badge 
                        count={pods.length} 
                        style={{ backgroundColor: '#1890ff' }}
                      />
                    </Space>
                  } 
                  key="pods"
                >
                  <div style={{ padding: '16px' }}>
                    <StatusMonitorRedux
                      activeTab="pods"
                    />
                  </div>
                </TabPane>
                <TabPane 
                  tab={
                    <Space>
                      <ApiOutlined />
                      Services
                      <Badge 
                        count={services.length} 
                        style={{ backgroundColor: '#52c41a' }}
                      />
                    </Space>
                  } 
                  key="services"
                >
                  <div style={{ padding: '16px' }}>
                    <StatusMonitorRedux
                      activeTab="services"
                    />
                  </div>
                </TabPane>
                <TabPane 
                  tab={
                    <Space>
                      <ContainerOutlined />
                      Deployments
                    </Space>
                  } 
                  key="deployments"
                >
                  <div style={{ padding: '16px' }}>
                    <StatusMonitorRedux
                      activeTab="deployments"
                    />
                  </div>
                </TabPane>
                <TabPane 
                  tab={
                    <Space>
                      <ExperimentOutlined />
                      HyperPodPytorchJob
                    </Space>
                  } 
                  key="hyperpod-jobs"
                >
                  <div style={{ padding: '16px' }}>
                    <StatusMonitorRedux
                      activeTab="jobs"
                    />
                  </div>
                </TabPane>
                <TabPane 
                  tab={
                    <Space>
                      <RocketOutlined />
                      RayJobs
                    </Space>
                  } 
                  key="rayjobs"
                >
                  <div style={{ padding: '16px' }}>
                    <StatusMonitorRedux
                      activeTab="rayjobs"
                    />
                  </div>
                </TabPane>
              </Tabs>
            </Card>
          </Col>
        </Row>
      </Content>
      
      {/* 操作反馈组件 - 已移除右上角详细卡片，保留顶部message提示 */}
    </Layout>
    </ThemeProvider>
  );
}

export default App;
