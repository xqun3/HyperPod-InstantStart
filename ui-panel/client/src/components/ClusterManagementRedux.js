import React, { useState, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Card,
  Form,
  Input,
  Button,
  Space,
  Tag,
  Spin,
  message,
  Select,
  Modal,
  Drawer,
  Tabs,
  Row,
  Col,
  Typography,
  Alert,
  Divider,
  InputNumber,
  Tooltip
} from 'antd';
import {
  CloudServerOutlined,
  SettingOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  CheckCircleOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  ClusterOutlined,
  PlusOutlined
} from '@ant-design/icons';
import NodeGroupManager from './NodeGroupManagerRedux';
import EksClusterCreationPanel from './EksClusterCreationPanel';
import CreateClusterDeprecated from './CreateClusterDeprecated';
import {
  fetchClusters,
  fetchClusterDetails,
  switchCluster as switchClusterAction,
  checkDependenciesStatus,
  configureDependencies
} from '../store/slices/clustersSlice';
import {
  selectActiveCluster,
  selectClustersList,
  selectClusterDetails,
  selectDependenciesStatus,
  selectClusterLoading,
  selectClusterError,
  selectEffectiveDependenciesStatus
} from '../store/selectors';
import globalRefreshManager from '../hooks/useGlobalRefresh';

const { Title, Text } = Typography;
const { Option } = Select;

// 依赖配置状态显示组件（增强版）
const DependencyStatus = ({ cluster, dependenciesStatus }) => {
  // 获取状态显示
  const getDependencyStatusDisplay = () => {
    if (!dependenciesStatus) {
      return <Text type="secondary">Loading...</Text>;
    }

    // 检查是否是导入的集群类型
    const isImported = cluster?.type === 'imported';

    if (isImported) {
      // 导入的集群：显示实际配置状态（不再区分有无HyperPod）
      if (dependenciesStatus?.configured) {
        return <Tag color="green">Configured</Tag>;
      } else {
        return <Tag color="warning">Not Configured</Tag>;
      }
    } else {
      // 创建的集群：显示配置状态
      if (dependenciesStatus?.configured) {
        return <Tag color="green">Configured</Tag>;
      } else if (dependenciesStatus?.detected && dependenciesStatus?.effectiveStatus) {
        return <Tag color="blue">Detected</Tag>;
      } else {
        return <Tag color="warning">Not Configured</Tag>;
      }
    }
  };

  return getDependencyStatusDisplay();
};

// 依赖配置按钮组件 - Redux版本
const DependencyConfigButton = ({ clusterTag, currentCluster }) => {
  const dispatch = useDispatch();
  const dependenciesStatus = useSelector(selectDependenciesStatus);
  const isConfiguring = useSelector(state => state.clusters.configuring);

  // 配置依赖
  const configureDependenciesHandler = async () => {
    try {
      await dispatch(configureDependencies(clusterTag)).unwrap();
      message.success('Dependency configuration started');
    } catch (error) {
      message.error(error || 'Failed to start dependency configuration');
    }
  };

  // 获取按钮文本和状态
  const getButtonProps = () => {
    // 导入的集群也可以配置依赖（移除了原有的禁用逻辑）
    
    if (!dependenciesStatus) {
      return {
        text: 'Configure Dependencies',
        disabled: true,
        type: 'default',
        icon: <SettingOutlined />
      };
    }

    switch (dependenciesStatus.status) {
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
      loading={isConfiguring}
      disabled={buttonProps.disabled}
      onClick={configureDependenciesHandler}
      icon={buttonProps.icon}
    >
      {buttonProps.text}
    </Button>
  );
};

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

const ClusterManagementRedux = () => {
  // Redux hooks
  const dispatch = useDispatch();
  const clustersFromStore = useSelector(selectClustersList);
  const clusters = Array.isArray(clustersFromStore) ? clustersFromStore : [];
  const activeCluster = useSelector(selectActiveCluster);
  const clusterDetails = useSelector(selectClusterDetails);
  const dependenciesStatus = useSelector(selectDependenciesStatus);
  const effectiveDependenciesStatus = useSelector(selectEffectiveDependenciesStatus);
  const loading = useSelector(selectClusterLoading);
  // const error = useSelector(selectClusterError); // Unused

  // 本地状态管理
  const [showImportModal, setShowImportModal] = useState(false);
  const [importForm] = Form.useForm();
  const [importLoading, setImportLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('manage');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // 默认配置值
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
        await dispatch(fetchClusters()).unwrap();

        // 设置为活跃集群
        await dispatch(switchClusterAction(values.eksClusterName)).unwrap();

        // 刷新状态
        setTimeout(() => {
          dispatch(checkDependenciesStatus(values.eksClusterName));
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

  // 切换集群
  const handleSwitchCluster = async (clusterTag) => {
    if (clusterTag === activeCluster) return;

    try {
      await dispatch(switchClusterAction(clusterTag)).unwrap();

      // 集群切换时刷新页面以清除缓存
      window.location.reload();

      message.success(`Successfully switched to cluster: ${clusterTag}`);

      // 延迟5秒刷新状态，给kubectl配置切换足够时间
      message.info('Updating kubectl configuration and refreshing cluster status...', 3);
      setTimeout(() => {
        dispatch(checkDependenciesStatus(clusterTag));
      }, 5000);

    } catch (error) {
      message.error(`Failed to switch cluster: ${error}`);
    }
  };

  // 创建新集群
  const createNewCluster = () => {
    // 重置表单为默认值，生成新的集群标识
    const newClusterTag = `hypd-instrt-${new Date().toISOString().slice(5, 10).replace('-', '')}-${Math.random().toString(36).substr(2, 3)}`;
    const newConfig = { ...defaultConfig, clusterTag: newClusterTag };

    form.setFieldsValue(newConfig);

    // 切换到创建标签页
    setActiveTab('create-eks');

    message.info(`Ready to create new cluster: ${newClusterTag}`);
  };

  // 统一的全局刷新函数
  const refreshAllStatus = async () => {
    try {
      // 并行执行所有刷新操作
      await Promise.all([
        dispatch(fetchClusters()),
        activeCluster ? dispatch(checkDependenciesStatus(activeCluster)) : Promise.resolve(),
      ]);

      // 触发NodeGroupManager刷新
      setRefreshTrigger(prev => prev + 1);

      message.success('Status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing status:', error);
      message.error(`Error refreshing status: ${error.message}`);
    }
  };

  // 初始加载
  useEffect(() => {
    dispatch(fetchClusters());
  }, [dispatch]);

  // 注册到全局刷新管理器
  useEffect(() => {
    const componentId = 'cluster-management-redux';

    globalRefreshManager.subscribe(componentId, refreshAllStatus, {
      priority: 5
    });

    return () => {
      globalRefreshManager.unsubscribe(componentId);
    };
  }, []);

  // 监听活跃集群变化
  useEffect(() => {
    if (activeCluster) {
      dispatch(checkDependenciesStatus(activeCluster));
      // 如果没有集群详情，获取集群详情
      if (!clusterDetails) {
        dispatch(fetchClusterDetails(activeCluster));
      }
    }
  }, [activeCluster, clusterDetails, dispatch]);

  return (
    <>
      {/* 注入自定义滚动条样式 */}
      <style dangerouslySetInnerHTML={{ __html: customScrollbarStyle }} />

      <div>
        <Card
          title={
            <Space>
              <ClusterOutlined />
              <span>Cluster Management</span>
            </Space>
          }
          className="theme-card compute"
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
                                  onClick={refreshAllStatus}
                                  loading={loading}
                                  type="text"
                                >
                                  Refresh
                                </Button>
                              </div>
                              <div>
                                <Select
                                  value={activeCluster}
                                  onChange={handleSwitchCluster}
                                  style={{ width: '100%' }}
                                  placeholder="Select a cluster or import/create one"
                                  loading={loading}
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
                              <Button
                                type="primary"
                                icon={<PlusOutlined />}
                                onClick={createNewCluster}
                              >
                                Create EKS Cluster
                              </Button>
                            </Space>
                          </Col>
                        </Row>

                        {/* 集群信息显示 */}
                        {activeCluster && (() => {
                          const cluster = clusters.find(c => c.clusterTag === activeCluster);
                          if (!cluster) {
                            // 集群不存在时的处理
                            if (clusters.length === 0) {
                              return <Text type="secondary">No clusters available</Text>;
                            } else {
                              return <Text type="secondary">Cluster "{activeCluster}" not found</Text>;
                            }
                          }

                          // 统一获取cluster tag和region
                          const clusterTag = cluster.clusterTag || 'N/A';
                          const region = cluster.region || cluster.config?.awsRegion || 'N/A';
                          const creationType = cluster.type === 'imported' ? 'Imported' : 'Created';
                          const creationColor = cluster.type === 'imported' ? 'blue' : 'green';

                          // 从API获取的详细信息
                          const eksClusterName = clusterDetails?.eksClusterName || 'N/A';
                          const vpcId = clusterDetails?.vpcId || 'N/A';

                          return (
                            <Card title="Cluster Details" size="small" className="theme-card analytics">
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
                                        dependenciesStatus={dependenciesStatus}
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
                          dependenciesConfigured={effectiveDependenciesStatus}
                          activeCluster={activeCluster}
                          refreshTrigger={refreshTrigger}
                          cluster={clusters.find(c => c.clusterTag === activeCluster)}
                        />
                      ) : (
                        <Card title="Node Groups" style={{ height: '100%' }} className="theme-card database">
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
            label="HyperPod Cluster Name (Associated)"
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

export default ClusterManagementRedux;