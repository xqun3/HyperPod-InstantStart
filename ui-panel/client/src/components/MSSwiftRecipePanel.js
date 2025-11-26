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
  Collapse,
  Typography,
  message,
  Tooltip,
  Select
} from 'antd';
import {
  ExperimentOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  ReloadOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  CodeOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  QuestionCircleOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Panel } = Collapse;
const { Text } = Typography;

const MSSwiftRecipePanel = ({ onLaunch, deploymentStatus, hyperPodInstanceTypes, instanceTypesLoading }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showLogMonitoring, setShowLogMonitoring] = useState(false);
  const [commandOptions, setCommandOptions] = useState([]);
  const [commandsMap, setCommandsMap] = useState({});
  const hasLoadedConfig = useRef(false);

  useEffect(() => {
    if (!hasLoadedConfig.current) {
      hasLoadedConfig.current = true;
      loadSavedConfig();
      loadCommandOptions();
    }
  }, []);

  const loadCommandOptions = async () => {
    try {
      const response = await fetch('/api/msswift-commands');
      const result = await response.json();
      
      if (result.success) {
        setCommandsMap(result.commands);
        const options = Object.keys(result.commands).map(key => ({
          label: key,
          value: key
        }));
        setCommandOptions(options);
      }
    } catch (error) {
      console.error('Error loading MS-Swift commands:', error);
    }
  };

  const loadSavedConfig = async () => {
    try {
      const response = await fetch('/api/msswift-config/load');
      const result = await response.json();
      
      if (result.success) {
        form.setFieldsValue(result.config);
        if (result.config.logMonitoringConfig && result.config.logMonitoringConfig.trim() !== '') {
          setShowLogMonitoring(true);
        }
        
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
      
      const response = await fetch('/api/msswift-config/save', {
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
      await fetch('/api/msswift-config/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });
      
      // 将 key 转换为 value 用于 YAML 填充
      const commandValue = commandsMap[values.msswiftCommandType] || values.msswiftCommandType;
      
      await onLaunch({ 
        ...values, 
        msswiftCommandType: commandValue,
        recipeType: 'msswift' 
      });
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
          <ExperimentOutlined />
          MS-Swift Recipe
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
      >
        {/* 基础配置 */}
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={
                <Space>
                  <ExperimentOutlined />
                  <Text strong>Job Name</Text>
                </Space>
              }
              name="trainingJobName"
              rules={[
                { required: true, message: 'Please input training job name!' },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'Invalid job name format' }
              ]}
            >
              <Input placeholder="msswift-1" />
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
                  const instanceType = option.instanceType || value.split('-')[0];
                  form.setFieldValue('instanceType', instanceType);
                }}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>

        {/* Docker Image */}
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
          <Input placeholder="633205212955.dkr.ecr.us-west-2.amazonaws.com/sm-training-op-torch26-smhp-op:latest" />
        </Form.Item>

        {/* 资源配置 */}
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>EFA Count</Text>
                </Space>
              }
              name="efaCount"
              rules={[{ required: true, message: 'Please input EFA count!' }]}
            >
              <InputNumber min={0} max={32} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <SettingOutlined />
                  <Text strong>GPUs Per Replica</Text>
                </Space>
              }
              name="nprocPerNode"
              rules={[{ required: true, message: 'Please input number of processes/gpus per node!' }]}
            >
              <InputNumber min={1} max={64} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <ThunderboltOutlined />
                  <Text strong>Num Replicas</Text>
                </Space>
              }
              name="replicas"
              rules={[{ required: true, message: 'Please input replicas/the amount nodes!' }]}
            >
              <InputNumber min={1} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        {/* MS-Swift配置 */}
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>MS-Swift Project</Text>
                  <Tooltip title="MS-Swift repo exists in this path">
                    <QuestionCircleOutlined style={{ color: '#1890ff' }} />
                  </Tooltip>
                </Space>
              }
              name="msswiftRecipeRunPath"
              rules={[{ required: true, message: 'Please input MS-Swift recipe run path!' }]}
            >
              <Input placeholder="/s3/train-recipes/ms-swift-project/" />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>MS-Swift Command Type</Text>
                </Space>
              }
              name="msswiftCommandType"
              rules={[{ required: true, message: 'Please select command type!' }]}
            >
              <Select
                placeholder="Select command type"
                options={commandOptions}
                showSearch
                filterOption={(input, option) =>
                  option.label.toLowerCase().indexOf(input.toLowerCase()) >= 0
                }
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              label={
                <Space>
                  <CodeOutlined />
                  <Text strong>MS-Swift Config YAML File Name</Text>
                </Space>
              }
              name="msswiftRecipeYamlFile"
              rules={[
                { required: true, message: 'Please input YAML file name!' },
                { pattern: /\.yaml$/, message: 'File must have .yaml extension' }
              ]}
            >
              <Input placeholder="qwen06b_full_sft_template.yaml" />
            </Form.Item>
          </Col>
        </Row>

        {/* MLFlow配置 */}
        <Form.Item
          label={
            <Space>
              <DatabaseOutlined />
              <Text strong>SageMaker MLFlow ARN (Optional)</Text>
            </Space>
          }
          name="mlflowTrackingUri"
          rules={[
            { 
              pattern: /^(arn:aws:sagemaker:|$)/, 
              message: 'Must be a valid SageMaker ARN or leave empty to disable MLFlow' 
            }
          ]}
          extra="Leave empty to disable MLFlow tracking for this training job"
        >
          <Input placeholder="" />
        </Form.Item>

        {/* 高级配置 */}
        <Collapse 
          ghost
          onChange={(keys) => setShowLogMonitoring(keys.includes('logMonitoring'))}
        >
          <Panel 
            header={
              <Space>
                <SettingOutlined />
                <Text strong>Advanced Settings</Text>
              </Space>
            } 
            key="logMonitoring"
          >
            <Form.Item
              label={
                <Space>
                  <DatabaseOutlined />
                  <Text strong>Log Monitoring Configuration (Optional)</Text>
                </Space>
              }
              name="logMonitoringConfig"
              extra="YAML format configuration for log monitoring"
            >
              <TextArea
                rows={6}
                placeholder={`logMonitoringConfiguration: 
  - name: "JobStart"
    logPattern: ".*Experiment configuration.*"
    expectedStartCutOffInSeconds: 120
  - name: "HighLossDetection"
    logPattern: ".*\\[train\\.py:\\d+\\] Batch \\d+ Loss: (\\d+\\.\\d+).*"
    metricThreshold: 1
    operator: "lteq"
    metricEvaluationDataPoints: 100`}
              />
            </Form.Item>
          </Panel>
        </Collapse>

        {/* 部署按钮 */}
        <Form.Item style={{ marginTop: 24 }}>
          <Button
            type="primary"
            htmlType="submit"
            icon={<PlayCircleOutlined />}
            loading={loading}
            size="large"
            className="training-btn"
            block
          >
            Launch Training Job
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default MSSwiftRecipePanel;
