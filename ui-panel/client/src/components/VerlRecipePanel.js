import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Form,
  Input,
  InputNumber,
  Button,
  Space,
  Row,
  Col,
  Alert,
  Typography,
  message,
  Tooltip,
  Select
} from 'antd';
import {
  RocketOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  ReloadOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  DatabaseOutlined,
  CloudServerOutlined
} from '@ant-design/icons';

const { Text } = Typography;

const VerlRecipePanel = ({ onLaunch, deploymentStatus, hyperPodInstanceTypes, instanceTypesLoading }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const hasLoadedConfig = useRef(false);

  useEffect(() => {
    if (!hasLoadedConfig.current) {
      hasLoadedConfig.current = true;
      loadSavedConfig();
    }
  }, []);

  const loadSavedConfig = async () => {
    try {
      const response = await fetch('/api/verl-config/load');
      const result = await response.json();
      
      if (result.success) {
        form.setFieldsValue(result.config);
        if (!result.isDefault) {
          message.success('Previous configuration loaded');
        }
      }
    } catch (error) {
      console.error('Error loading config:', error);
      message.error('Failed to load saved configuration');
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);
      const values = await form.validateFields();
      
      const response = await fetch('/api/verl-config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success('Configuration saved successfully');
      } else {
        message.error(`Failed to save configuration: ${result.error}`);
      }
    } catch (error) {
      console.error('Error saving config:', error);
      message.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      await fetch('/api/verl-config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      await onLaunch({ ...values, recipeType: 'verl' });
    } finally {
      setLoading(false);
    }
  };

  const getStatusAlert = () => {
    if (!deploymentStatus) return null;

    const { type, status, message: statusMessage } = deploymentStatus;
    
    if (type === 'training_launch') {
      return (
        <Alert
          message={statusMessage}
          type={status === 'success' ? 'success' : 'error'}
          showIcon
          style={{ marginBottom: 16 }}
        />
      );
    }
    
    return null;
  };

  return (
    <Card 
      title={
        <Space>
          <RocketOutlined />
          VERL Recipe
        </Space>
      }
      extra={
        <Space>
          <Tooltip title="Save Configuration">
            <Button 
              icon={<SaveOutlined />} 
              onClick={saveConfig}
              loading={saving}
              size="small"
            />
          </Tooltip>
          <Tooltip title="Reload Configuration">
            <Button 
              icon={<ReloadOutlined />} 
              onClick={loadSavedConfig}
              size="small"
            />
          </Tooltip>
        </Space>
      }
    >
      {getStatusAlert()}
      
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          jobName: 'verl-training-a1',
          instanceType: '',
          entryPointPath: 'verl-project/src/qwen-3b-grpo-kuberay.sh',
          dockerImage: '633205212955.dkr.ecr.us-west-2.amazonaws.com/hypd-verl:latest',
          workerReplicas: 1,
          gpuPerNode: 4,
          efaPerNode: 1
        }}
      >
        {/* 基础配置 */}
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <RocketOutlined />
                  <Text strong>Job Name</Text>
                </Space>
              }
              name="jobName"
              rules={[
                { required: true, message: 'Please input job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="verl-training-a1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <CloudServerOutlined />
                  <Text strong>Instance Type</Text>
                </Space>
              }
              name="instanceType"
              rules={[{ required: true, message: 'Please select instance type!' }]}
            >
              <Select
                placeholder="Select HyperPod instance type"
                options={hyperPodInstanceTypes}
                loading={instanceTypesLoading}
                showSearch
                filterOption={(inputValue, option) =>
                  option.label.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
                }
                onSelect={(value, option) => {
                  // 如果选择的是从集群获取的选项，提取实例类型；否则使用原值
                  const instanceType = option.instanceType || value.split('-')[0];
                  form.setFieldValue('instanceType', instanceType);
                }}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        {/* Docker Image - 单独一行 */}
        <Form.Item
          label={
            <Space>
              <DatabaseOutlined />
              <Text strong>Docker Image</Text>
            </Space>
          }
          name="dockerImage"
          rules={[{ required: true, message: 'Please input docker image!' }]}
        >
          <Input placeholder="633205212955.dkr.ecr.us-west-2.amazonaws.com/hypd-verl:latest" />
        </Form.Item>

        {/* Entry Point配置 */}
        <Form.Item
          label={
            <Space>
              <CodeOutlined />
              <Text strong>Entry Point Script Path</Text>
            </Space>
          }
          name="entryPointPath"
          rules={[{ required: true, message: 'Please input entry point path!' }]}
          extra="Relative Path under /s3/train-recipes/"
        >
          <Input placeholder="verl-project/src/qwen-3b-grpo-kuberay.sh" />
        </Form.Item>

        {/* 资源配置 */}
        <Row gutter={16}>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Header Replica</Text>
                </Space>
              }
              extra="at least 1 header replica is required"
            >
              <InputNumber value={1} disabled style={{ width: '100%', color: '#999' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Worker Replicas</Text>
                </Space>
              }
              name="workerReplicas"
              rules={[{ required: true, message: 'Please input worker replicas!' }]}
              extra="0-N workers (0 means head and worker on one single node)"
            >
              <InputNumber min={0} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>GPUs Per Node</Text>
                </Space>
              }
              name="gpuPerNode"
              rules={[{ required: true, message: 'Please input GPU count!' }]}
            >
              <InputNumber min={1} max={8} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>EFA Per Node</Text>
                </Space>
              }
              name="efaPerNode"
              rules={[{ required: true, message: 'Please input EFA count!' }]}
            >
              <InputNumber min={0} max={32} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {/* 部署按钮 */}
        <Form.Item style={{ marginTop: 24 }}>
          <Button
            type="primary"
            htmlType="submit"
            icon={<PlayCircleOutlined />}
            loading={loading}
            size="large"
            block
          >
            Launch VERL Training Job
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default VerlRecipePanel;
