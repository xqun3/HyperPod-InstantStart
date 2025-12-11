import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Form,
  Input,
  InputNumber,
  Button,
  Space,
  Alert,
  Tooltip,
  Row,
  Col,
  AutoComplete,
  Select,
  message
} from 'antd';
import {
  RocketOutlined,
  InfoCircleOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  CodeOutlined,
  DockerOutlined,
  TagOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  GlobalOutlined,
  CloudServerOutlined,
  ReloadOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Option } = Select;

const ManagedInferencePanel = ({ onDeploy, deploymentStatus }) => {
  const [deploymentForm] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // 实例类型相关状态 - 只需要 HyperPod 实例类型
  const [instanceTypes, setInstanceTypes] = useState({
    hyperpod: [],
    karpenterHyperPod: []
  });
  const [instanceTypesLoading, setInstanceTypesLoading] = useState(false);
  const [s3Buckets, setS3Buckets] = useState([]);
  const [s3Region, setS3Region] = useState('');

  // Docker镜像预设选项
  const dockerImageOptions = useMemo(() => [
    {
      value: 'vllm/vllm-openai:latest',
      label: 'vllm/vllm-openai:latest'
    },
    {
      value: 'lmsysorg/sglang:latest',
      label: 'lmsysorg/sglang:latest'
    }
  ], []);

  // 根据Docker镜像获取对应的默认参数数组
  const getDefaultArgsByImage = useCallback((dockerImage) => {
    if (!dockerImage) {
      return '';
    }

    if (dockerImage.includes('sglang')) {
      return `python3
-m
sglang.launch_server
--model-path
/opt/ml/model
--host
0.0.0.0
--port
22022`;
    } else {
      // 默认 vLLM 参数
      return `--model
/opt/ml/model
--served-model-name
MODEL_NAME
--max-model-len
2048
--dtype
auto`;
    }
  }, []);

  // 处理Docker镜像选择变化
  const handleDockerImageChange = useCallback((value) => {
    const newArgs = getDefaultArgsByImage(value);
    deploymentForm.setFieldsValue({ workerArgs: newArgs });

    // SGLang 使用 22022 端口，vLLM 使用 8000
    const defaultPort = value.includes('sglang') ? 22022 : 8000;
    deploymentForm.setFieldsValue({ port: defaultPort });
  }, [getDefaultArgsByImage, deploymentForm]);

  // 获取集群可用实例类型
  const fetchInstanceTypes = useCallback(async () => {
    setInstanceTypesLoading(true);
    try {
      const response = await fetch('/api/cluster/cluster-available-instance');
      const data = await response.json();

      if (data.success) {
        setInstanceTypes({
          hyperpod: data.data.hyperpod || [],
          karpenterHyperPod: data.data.karpenterHyperPod || []
        });
        console.log('Instance types loaded:', data.data);
      } else {
        console.error('Failed to fetch instance types:', data.error);
      }
    } catch (error) {
      console.error('Error fetching instance types:', error);
    } finally {
      setInstanceTypesLoading(false);
    }
  }, []);

  // 获取 S3 存储桶列表
  const fetchS3Buckets = useCallback(async () => {
    try {
      const response = await fetch('/api/cluster/s3-buckets');
      const data = await response.json();

      if (data.success && data.buckets) {
        setS3Buckets(data.buckets);
        // 如果有 cluster S3 bucket，设置为默认值
        if (data.clusterBucket) {
          deploymentForm.setFieldsValue({
            s3BucketName: data.clusterBucket.name,
            s3Region: data.clusterBucket.region
          });
          setS3Region(data.clusterBucket.region);
        }
      }
    } catch (error) {
      console.error('Error fetching S3 buckets:', error);
    }
  }, [deploymentForm]);

  // 组件挂载时获取数据
  useEffect(() => {
    fetchInstanceTypes();
    fetchS3Buckets();
  }, [fetchInstanceTypes, fetchS3Buckets]);

  // 实例类型选项
  const instanceTypeOptions = useMemo(() => {
    const options = [];

    // HyperPod 实例
    if (instanceTypes.hyperpod.length > 0) {
      options.push(
        <Select.OptGroup key="hyperpod" label="HyperPod (ml.*)">
          {instanceTypes.hyperpod.map(type => (
            <Option key={`hp-${type.type}`} value={type.type}>
              {type.type} ({type.group}) [{type.count} nodes]
            </Option>
          ))}
        </Select.OptGroup>
      );
    }

    // Karpenter HyperPod 实例
    if (instanceTypes.karpenterHyperPod.length > 0) {
      options.push(
        <Select.OptGroup key="karpenter-hyperpod" label="Karpenter HyperPod (ml.*)">
          {instanceTypes.karpenterHyperPod.map((type, index) => (
            <Option key={`kar-hp-${type.type}-${type.nodePool}-${index}`} value={type.type}>
              {type.type} (Karpenter: {type.nodePool})
            </Option>
          ))}
        </Select.OptGroup>
      );
    }

    return options;
  }, [instanceTypes]);

  const handleSubmit = async (values) => {
    console.log('ManagedInferencePanel handleSubmit called with values:', values);

    setLoading(true);
    try {
      const deploymentConfig = {
        ...values,
        deploymentType: 'managed-inference'
      };

      console.log('Managed inference deployment config:', deploymentConfig);
      await onDeploy(deploymentConfig);
      message.success('Managed inference deployment initiated');
    } catch (error) {
      console.error('Error in handleSubmit:', error);
      message.error('Failed to submit deployment');
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;

    const { status, message: msg } = deploymentStatus;

    if (status === 'success') {
      return (
        <Alert
          message="Deployment Successful"
          description={msg}
          type="success"
          icon={<CheckCircleOutlined />}
          showIcon
          closable
          style={{ marginBottom: 16 }}
        />
      );
    } else if (status === 'error') {
      return (
        <Alert
          message="Deployment Failed"
          description={msg}
          type="error"
          icon={<ExclamationCircleOutlined />}
          showIcon
          closable
          style={{ marginBottom: 16 }}
        />
      );
    }

    return null;
  };

  return (
    <div>
      {getStatusAlert()}

      <Form
        form={deploymentForm}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          replicas: 1,
          gpuCount: 1,
          port: 8000,
          cpuRequest: '',
          memoryRequest: '',
          s3Region: ''
        }}
      >
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <TagOutlined />
                  Deployment Name
                  <Tooltip title="Kubernetes resource identifier">
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
                placeholder="e.g., qwen3-06b, llama2-7b"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  Model Name
                  <Tooltip title="Model identifier for the inference endpoint">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="modelName"
              rules={[
                { required: true, message: 'Please input model name!' },
                { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers and hyphens allowed' }
              ]}
            >
              <Input
                placeholder="e.g., qwen3-06b, llama2-7b"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>
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
                { type: 'number', min: 1, max: 10, message: 'Replicas must be between 1 and 10' }
              ]}
            >
              <InputNumber
                min={1}
                max={10}
                style={{ width: '100%' }}
                placeholder="Number of replicas"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  GPU Count (per replica)
                  <Tooltip title="Number of GPUs allocated per replica">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="gpuCount"
              rules={[
                { required: true, message: 'Please input GPU count!' },
                { type: 'number', min: 1, max: 8, message: 'GPU count must be between 1 and 8' }
              ]}
            >
              <InputNumber
                min={1}
                max={8}
                style={{ width: '100%' }}
                placeholder="Number of GPUs per replica"
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <GlobalOutlined />
                  Port
                  <Tooltip title="Container port for model inference">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="port"
              rules={[{ required: true, message: 'Please input port!' }]}
            >
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="CPU Request (optional)"
              name="cpuRequest"
              tooltip="Leave empty to skip CPU resource request"
            >
              <Input
                addonAfter="cores"
                placeholder="e.g., 4"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Memory Request (optional)"
              name="memoryRequest"
              tooltip="Leave empty to skip memory resource request"
            >
              <Input
                addonAfter="Gi"
                placeholder="e.g., 16"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={24}>
            <Form.Item
              label={
                <Space>
                  <CloudServerOutlined />
                  Instance Type
                  <Tooltip title="Select HyperPod instance type (ml.*)">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              required
            >
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item
                  name="instanceType"
                  noStyle
                  rules={[
                    { required: true, message: 'Please select an instance type!' }
                  ]}
                >
                  <Select
                    placeholder="Select instance type"
                    loading={instanceTypesLoading}
                    style={{ fontFamily: 'monospace', flex: 1 }}
                    allowClear
                    notFoundContent={instanceTypesLoading ? 'Loading...' : 'No HyperPod instance types available'}
                  >
                    {instanceTypeOptions}
                  </Select>
                </Form.Item>
                <Button
                  icon={<ReloadOutlined />}
                  loading={instanceTypesLoading}
                  onClick={fetchInstanceTypes}
                  title="Refresh instance types"
                />
              </Space.Compact>
            </Form.Item>
          </Col>
        </Row>

        <Alert
          message="S3 Model Source Configuration"
          description="Configure the S3 location where your model is stored"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  S3 Bucket Name
                  <Tooltip title="S3 bucket containing the model">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="s3BucketName"
              rules={[{ required: true, message: 'Please input S3 bucket name!' }]}
            >
              <AutoComplete
                options={s3Buckets.map(bucket => ({ value: bucket.name, label: bucket.name }))}
                placeholder="Select or input S3 bucket name"
                style={{ fontFamily: 'monospace' }}
                filterOption={true}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <GlobalOutlined />
                  S3 Region
                  <Tooltip title="AWS region of the S3 bucket">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="s3Region"
              rules={[{ required: true, message: 'Please input S3 region!' }]}
            >
              <Input
                placeholder="e.g., us-west-2"
                style={{ fontFamily: 'monospace' }}
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label={
            <Space>
              <DatabaseOutlined />
              Model Location (S3 Path)
              <Tooltip title="Path to model within S3 bucket (e.g., Qwen-Qwen3-0.6B)">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          name="modelLocation"
          rules={[{ required: true, message: 'Please input model location!' }]}
        >
          <Input
            placeholder="e.g., Qwen-Qwen3-0.6B"
            style={{ fontFamily: 'monospace' }}
          />
        </Form.Item>

        <Row gutter={16}>
          <Col span={24}>
            <Form.Item
              label={
                <Space>
                  <DockerOutlined />
                  Docker Image
                  <Tooltip title="Select preset image or input custom image">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Space>
              }
              name="dockerImage"
              rules={[{ required: true, message: 'Please select or input docker image!' }]}
            >
              <AutoComplete
                options={dockerImageOptions}
                placeholder="Select Docker image"
                style={{ fontFamily: 'monospace' }}
                onChange={handleDockerImageChange}
                filterOption={false}
                allowClear
              />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          label={
            <Space>
              <CodeOutlined />
              Worker Arguments
              <Tooltip title="One argument per line, will be passed as args array to the container">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          }
          name="workerArgs"
          rules={[{ required: true, message: 'Please input worker arguments!' }]}
        >
          <TextArea
            rows={10}
            placeholder="Select Docker image first, default args will be auto-generated&#10;One argument per line"
            style={{ fontFamily: 'monospace', fontSize: '12px' }}
          />
        </Form.Item>

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            icon={<RocketOutlined />}
            loading={loading}
            block
            size="large"
          >
            Deploy Managed Inference
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default ManagedInferencePanel;
