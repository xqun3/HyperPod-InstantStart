import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Row,
  Col,
  Checkbox,
  InputNumber,
  Select,
  Input,
  Button,
  Space,
  Alert,
  Typography,
  Divider,
  Spin,
  Tooltip,
  AutoComplete
} from 'antd';
import {
  CloudServerOutlined,
  ShareAltOutlined,
  RocketOutlined,
  ReloadOutlined,
  InfoCircleOutlined,
  DockerOutlined,
  TagOutlined,
  ThunderboltOutlined,
  GlobalOutlined,
  CodeOutlined
} from '@ant-design/icons';
import './AdvancedScalingPanelV2.css';

const { Option } = Select;
const { Text, Title } = Typography;
const { TextArea } = Input;

const AdvancedScalingPanelV2 = ({ onDeploy, deploymentStatus }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [instanceTypesLoading, setInstanceTypesLoading] = useState(false);
  const [availableInstanceTypes, setAvailableInstanceTypes] = useState([]);

  // SGLang Docker镜像选项
  const sglangImageOptions = [
    {
      value: 'lmsysorg/sglang:latest',
      label: 'lmsysorg/sglang:latest'
    },
    {
      value: 'lmsysorg/sglang:v0.2.13',
      label: 'lmsysorg/sglang:v0.2.13'
    }
  ];

  // 根据镜像生成SGLang命令
  const getSGLangDefaultCommand = (dockerImage, modelPath = '/s3/Qwen-Qwen3-0.6B', port = 8000) => {
    return `python3 -m sglang.launch_server \\
--model-path ${modelPath} \\
--host 0.0.0.0 \\
--port ${port} \\
--trust-remote-code`;
  };

  // 处理Docker镜像选择变化
  const handleDockerImageChange = (value) => {
    const modelPath = form.getFieldValue('modelPath') || '/s3/Qwen-Qwen3-0.6B';
    const port = form.getFieldValue('port') || 8000;
    const newCommand = getSGLangDefaultCommand(value, modelPath, port);
    form.setFieldsValue({ containerCommand: newCommand });
  };

  // 处理模型路径或端口变化
  const handleModelConfigChange = () => {
    const dockerImage = form.getFieldValue('dockerImage');
    const modelPath = form.getFieldValue('modelPath');
    const port = form.getFieldValue('port');

    if (dockerImage && modelPath && port) {
      const newCommand = getSGLangDefaultCommand(dockerImage, modelPath, port);
      form.setFieldsValue({ containerCommand: newCommand });
    }
  };

  // GPU实例类型配置
  const gpuInstanceFamilies = {
    g5: { name: 'G5', description: 'NVIDIA A10G GPUs for ML training and inference' },
    g6: { name: 'G6', description: 'NVIDIA L4 GPUs for cost-effective ML workloads' },
    g6e: { name: 'G6e', description: 'NVIDIA L40S GPUs for high-performance ML workloads' },
    p4: { name: 'P4d', description: 'NVIDIA A100 GPUs for high-performance ML training' },
    p5: { name: 'P5', description: 'NVIDIA H100 GPUs for cutting-edge AI workloads' },
    p5e: { name: 'P5e', description: 'NVIDIA H100 GPUs optimized for cost-effectiveness' },
    p5en: { name: 'P5en', description: 'NVIDIA H100 GPUs with enhanced networking' },
    p6: { name: 'P6-B200', description: 'Latest NVIDIA B200 GPU instances' }
  };

  // State for cache info
  const [cacheInfo, setCacheInfo] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [isAutoFetching, setIsAutoFetching] = useState(false);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

  // 动态获取AWS实例类型（从缓存，如果无缓存则自动刷新）
  const fetchAvailableInstanceTypes = async (autoRefreshOnMissing = true) => {
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
        // 缓存不存在或需要刷新，自动触发获取
        console.log('No cache found, automatically fetching from AWS...');
        setRefreshError(null); // 清除错误状态
        setIsAutoFetching(true);
        await refreshInstanceTypes();
        return; // refreshInstanceTypes 会处理状态更新
      } else {
        // 其他错误情况
        setAvailableInstanceTypes([]);
        setCacheInfo(null);
        setRefreshError(data.error || 'Failed to load instance types');
        console.warn('Instance types not available:', data.error);
      }
    } catch (error) {
      if (autoRefreshOnMissing) {
        // 网络错误时也尝试自动刷新一次
        console.log('Network error, trying to fetch from AWS...');
        setIsAutoFetching(true);
        try {
          await refreshInstanceTypes();
          return;
        } catch (refreshError) {
          // 如果刷新也失败，显示原始错误
          setAvailableInstanceTypes([]);
          setCacheInfo(null);
          setRefreshError(`Network error: ${error.message}`);
          console.error('Failed to fetch instance types and auto-refresh failed:', error);
        }
      } else {
        setAvailableInstanceTypes([]);
        setCacheInfo(null);
        setRefreshError(`Network error: ${error.message}`);
        console.error('Failed to fetch instance types:', error);
      }
    } finally {
      setInstanceTypesLoading(false);
    }
  };

  // 手动刷新实例类型（从AWS获取并更新缓存）
  const refreshInstanceTypes = async () => {
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
        setRefreshError(data.error || 'Failed to refresh instance types');
        setIsAutoFetching(false);
        setIsManualRefreshing(false);
        console.error('Failed to refresh instance types:', data.error);
      }
    } catch (error) {
      setRefreshError(`Network error: ${error.message}`);
      setIsAutoFetching(false);
      setIsManualRefreshing(false);
      console.error('Failed to refresh instance types:', error);
    } finally {
      setInstanceTypesLoading(false);
    }
  };

  useEffect(() => {
    fetchAvailableInstanceTypes();
  }, []);

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      console.log('Advanced Scaling Config:', values);

      // 构建配置对象
      const config = {
        type: 'advanced-scaling',
        karpenter: {
          instanceTypes: values.instanceTypes || [],
          onDemandWeight: values.onDemandWeight || 0,
          spotWeight: values.spotWeight || 0
        },
        sglangRouter: {
          routingPolicy: values.routingPolicy || 'cache_aware',
          routerPort: values.routerPort || 30000,
          metricsPort: values.metricsPort || 29000
        },
        modelDeployment: {
          deploymentName: values.deploymentName,
          replicas: values.replicas,
          dockerImage: values.dockerImage,
          modelPath: values.modelPath,
          port: values.port,
          containerCommand: values.containerCommand,
          cpuRequest: values.cpuRequest,
          memoryRequest: values.memoryRequest
        }
      };

      if (onDeploy) {
        await onDeploy(config);
      }
    } catch (error) {
      console.error('Error deploying advanced scaling:', error);
    } finally {
      setLoading(false);
    }
  };

  const renderInstanceTypeCheckboxes = () => {
    if (instanceTypesLoading) {
      return (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <Spin size="large" />
          <div style={{ marginTop: '16px' }}>
            <Text type="secondary">
              {isManualRefreshing
                ? 'Refreshing instance types from AWS...'
                : isAutoFetching
                  ? 'Auto-fetching instance types from AWS...'
                  : 'Loading cached instance types...'}
            </Text>
          </div>
        </div>
      );
    }

    // Show error state if no instance types and there's an error
    if (availableInstanceTypes.length === 0 && refreshError) {
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
                  onClick={refreshInstanceTypes}
                  style={{ marginTop: '16px' }}
                >
                  Fetch from AWS
                </Button>
              </div>
            }
            showIcon
          />
        </div>
      );
    }

    // Show cache info if available
    const cacheInfoDisplay = cacheInfo && (
      <div style={{
        marginBottom: '16px',
        padding: '8px 12px',
        backgroundColor: '#f0f9ff',
        border: '1px solid #bae6fd',
        borderRadius: '4px',
        fontSize: '12px'
      }}>
        <Text type="secondary">
          Region: {cacheInfo.region} •
          Found: {cacheInfo.totalFound} types •
          Updated: {new Date(cacheInfo.lastUpdated).toLocaleString()}
          {cacheInfo.cached && ' (cached)'}
        </Text>
      </div>
    );

    // 按实例系列分组
    const groupedTypes = availableInstanceTypes.reduce((acc, type) => {
      if (!acc[type.family]) {
        acc[type.family] = [];
      }
      acc[type.family].push(type);
      return acc;
    }, {});

    return (
      <div>
        {cacheInfoDisplay}
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
              <Text strong style={{ fontSize: '14px', color: '#1890ff' }}>
                {gpuInstanceFamilies[family]?.name || family.toUpperCase()}
              </Text>
              <Text type="secondary" style={{ marginLeft: '8px', fontSize: '12px' }}>
                {gpuInstanceFamilies[family]?.description}
              </Text>
            </div>
            <Form.Item name="instanceTypes" noStyle>
              <Checkbox.Group>
                <Row gutter={[6, 6]}>
                  {types.map(type => (
                    <Col span={8} key={type.value} style={{ minWidth: '160px', maxWidth: '200px' }}>
                      <div style={{
                        border: '1px solid #e0e0e0',
                        borderRadius: '4px',
                        padding: '8px',
                        backgroundColor: '#ffffff',
                        transition: 'all 0.2s',
                        cursor: 'pointer',
                        ':hover': {
                          borderColor: '#1890ff',
                          backgroundColor: '#f0f9ff'
                        }
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
              </Checkbox.Group>
            </Form.Item>
          </div>
        ))}
        </div>
      </div>
    );
  };

  return (
    <div className="advanced-scaling-v2">
      <Alert
        type="info"
        message="Advanced Scaling with SGLang Router + Karpenter"
        description="Configure intelligent auto-scaling with cost-aware node provisioning and smart request routing."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          onDemandWeight: 0,
          spotWeight: 100,
          routingPolicy: 'cache_aware',
          routerPort: 30000,
          metricsPort: 29000,
          // 模型部署配置
          deploymentName: '',
          replicas: 3,
          dockerImage: '',
          modelPath: '/s3/Qwen-Qwen3-0.6B',
          port: 8000,
          containerCommand: '',
          cpuRequest: 4,
          memoryRequest: 16
        }}
      >
        {/* 1. Karpenter Node Configuration */}
        <Card
          title={
            <Space>
              <CloudServerOutlined />
              <span>Karpenter Node Configuration</span>
            </Space>
          }
          className="section-card"
          style={{ marginBottom: 16 }}
        >
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                label={
                  <Space>
                    <span>Available GPU Instance Types</span>
                    <Tooltip title="Select instance types that Karpenter can provision">
                      <InfoCircleOutlined />
                    </Tooltip>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={refreshInstanceTypes}
                      loading={instanceTypesLoading}
                      type={refreshError ? "primary" : "default"}
                    >
                      {refreshError ? 'Fetch from AWS' : 'Refresh'}
                    </Button>
                  </Space>
                }
              >
                {renderInstanceTypeCheckboxes()}
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    <span>On-Demand Weight</span>
                    <Tooltip title="Higher values prefer On-Demand instances. Set to 0 to disable.">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="onDemandWeight"
              >
                <InputNumber
                  min={0}
                  max={200}
                  style={{ width: '100%' }}
                  placeholder="0 = disabled"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    <span>Spot Weight</span>
                    <Tooltip title="Higher values prefer Spot instances. Set to 0 to disable.">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="spotWeight"
              >
                <InputNumber
                  min={0}
                  max={200}
                  style={{ width: '100%' }}
                  placeholder="100 = default"
                />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        {/* 2. Model Deployment Configuration */}
        <Card
          title={
            <Space>
              <RocketOutlined />
              <span>Model Deployment Configuration</span>
            </Space>
          }
          className="section-card"
          style={{ marginBottom: 16 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    <TagOutlined />
                    Deployment Name
                    <Tooltip title="Kubernetes资源的标识符">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="deploymentName"
                rules={[
                  { required: true, message: 'Please input deployment name!' },
                  { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers and hyphens allowed' }
                ]}
              >
                <Input
                  placeholder="e.g., sglang-qwen3"
                  style={{ fontFamily: 'monospace' }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    <ThunderboltOutlined />
                    Replicas
                    <Tooltip title="Number of pod replicas to deploy">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="replicas"
                rules={[
                  { required: true, message: 'Please input replica count!' },
                  { type: 'number', min: 1, max: 20, message: 'Replicas must be between 1 and 20' }
                ]}
              >
                <InputNumber
                  min={1}
                  max={20}
                  style={{ width: '100%' }}
                  placeholder="Number of replicas"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={18}>
              <Form.Item
                label={
                  <Space>
                    <DockerOutlined />
                    Docker Image
                    <Tooltip title="Select SGLang Docker image">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="dockerImage"
                rules={[{ required: true, message: 'Please select docker image!' }]}
              >
                <AutoComplete
                  options={sglangImageOptions}
                  placeholder="Select SGLang Docker image"
                  style={{ fontFamily: 'monospace' }}
                  onChange={handleDockerImageChange}
                  filterOption={false}
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={
                  <Space>
                    <GlobalOutlined />
                    Port
                  </Space>
                }
                name="port"
                rules={[{ required: true, message: 'Please input port!' }]}
              >
                <InputNumber
                  min={1000}
                  max={65535}
                  style={{ width: '100%' }}
                  onChange={handleModelConfigChange}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label={
              <Space>
                Model Path
                <Tooltip title="Path to the model files">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="modelPath"
            rules={[{ required: true, message: 'Please input model path!' }]}
          >
            <Input
              placeholder="/s3/Qwen-Qwen3-0.6B"
              style={{ fontFamily: 'monospace' }}
              onChange={handleModelConfigChange}
            />
          </Form.Item>

          <Form.Item
            label={
              <Space>
                <CodeOutlined />
                Container Entry Command
                <Tooltip title="Command to run in the container (auto-generated based on image selection)">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="containerCommand"
            rules={[{ required: true, message: 'Please input container command!' }]}
          >
            <TextArea
              rows={4}
              placeholder="Select Docker image above to auto-generate command"
              style={{ fontFamily: 'monospace', fontSize: '12px' }}
            />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="CPU Request"
                name="cpuRequest"
              >
                <InputNumber
                  min={1}
                  max={32}
                  addonAfter="cores"
                  style={{ width: '100%' }}
                  placeholder="4"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Memory Request"
                name="memoryRequest"
              >
                <InputNumber
                  min={1}
                  max={512}
                  addonAfter="Gi"
                  style={{ width: '100%' }}
                  placeholder="16"
                />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        {/* 3. SGLang Router Configuration */}
        <Card
          title={
            <Space>
              <ShareAltOutlined />
              <span>SGLang Router Configuration</span>
            </Space>
          }
          className="section-card"
          style={{ marginBottom: 24 }}
        >
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="Routing Policy"
                name="routingPolicy"
                rules={[{ required: true, message: 'Please select routing policy' }]}
              >
                <Select>
                  <Option value="cache_aware">Cache Aware (Recommended)</Option>
                  <Option value="round_robin">Round Robin</Option>
                  <Option value="least_loaded">Least Loaded</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="Router Port"
                name="routerPort"
                rules={[{ required: true, message: 'Please enter router port' }]}
              >
                <InputNumber
                  min={8000}
                  max={65535}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="Metrics Port"
                name="metricsPort"
                rules={[{ required: true, message: 'Please enter metrics port' }]}
              >
                <InputNumber
                  min={8000}
                  max={65535}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        {/* Deploy Button */}
        <div className="deploy-button-container">
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            loading={loading}
            icon={<RocketOutlined />}
          >
            Deploy Advanced Scaling Stack
          </Button>
        </div>
      </Form>
    </div>
  );
};

export default AdvancedScalingPanelV2;