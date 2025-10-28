import React, { useState } from 'react';
import {
  Card,
  Form,
  Row,
  Col,
  InputNumber,
  Select,
  Input,
  Button,
  Space,
  Alert,
  Typography,
  Tooltip,
  AutoComplete
} from 'antd';
import {
  ShareAltOutlined,
  RocketOutlined,
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


  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      console.log('KVCache-aware Routing Config:', values);

      // 构建配置对象
      const config = {
        type: 'advanced-scaling',
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


  return (
    <div className="advanced-scaling-v2">
      <Alert
        type="info"
        message="KVCache-aware Routing with SGLang Router"
        description="Configure intelligent request routing and model deployment with SGLang Router. Karpenter node configuration is managed in Cluster Management section."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
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
        {/* 1. Model Deployment Configuration */}
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

        {/* 2. SGLang Router Configuration */}
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
            Deploy SGLang Router Stack
          </Button>
        </div>
      </Form>
    </div>
  );
};

export default AdvancedScalingPanelV2;