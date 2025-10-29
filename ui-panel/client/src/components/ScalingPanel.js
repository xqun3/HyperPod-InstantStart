import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Row,
  Col,
  InputNumber,
  Input,
  Button,
  Space,
  Alert,
  Select,
  Tooltip,
  Typography,
  Divider,
  Modal
} from 'antd';
import {
  ScissorOutlined,
  RocketOutlined,
  InfoCircleOutlined,
  DatabaseOutlined,
  ClockCircleOutlined,
  LineChartOutlined,
  EyeOutlined,
  SaveOutlined
} from '@ant-design/icons';

const { Option } = Select;
const { Text, Title } = Typography;
const { TextArea } = Input;

const ScalingPanel = ({ onDeploy, deploymentStatus }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [generatedYaml, setGeneratedYaml] = useState('');
  const [availableDeployments, setAvailableDeployments] = useState([]);

  useEffect(() => {
    fetchAvailableDeployments();
  }, []);

  const fetchAvailableDeployments = async () => {
    try {
      const response = await fetch('/api/deployments');
      const data = await response.json();
      if (data.success) {
        setAvailableDeployments(data.deployments || []);
      }
    } catch (error) {
      console.error('Error fetching deployments:', error);
    }
  };

  const handlePreview = async () => {
    try {
      const values = await form.validateFields();

      const response = await fetch('/api/keda/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(values),
      });

      const result = await response.json();

      if (result.success) {
        setGeneratedYaml(result.yaml);
        setPreviewVisible(true);
      } else {
        console.error('Preview failed:', result.error);
      }
    } catch (error) {
      console.error('Error generating preview:', error);
    }
  };

  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      console.log('KEDA Scaling Config:', values);

      const config = {
        type: 'keda-scaling',
        ...values
      };

      if (onDeploy) {
        await onDeploy(config);
      }
    } catch (error) {
      console.error('Error deploying KEDA scaling:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="scaling-panel">
      <Alert
        type="info"
        message="KEDA Auto Scaling Configuration"
        description="Configure automatic horizontal pod scaling based on Prometheus metrics from SGLang Router. Ensure KEDA operator is installed in your cluster."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          // ScaledObject Configuration
          scaledObjectName: 'sglang-worker-scaler',
          namespace: 'default',
          targetDeployment: '',

          // Scaling Configuration
          minReplicaCount: 1,
          maxReplicaCount: 10,
          pollingInterval: 5,
          cooldownPeriod: 300,

          // Prometheus Configuration
          prometheusServer: 'http://prometheus-server.monitoring.svc.cluster.local:80',
          threshold: '2',
          activationThreshold: '1',

          // Prometheus ConfigMap Configuration
          prometheusNamespace: 'monitoring',
          prometheusTargets: 'sglang-router-service.default.svc.cluster.local:29000',
          scrapeInterval: '10s'
        }}
      >
        {/* Basic Configuration */}
        <Card
          title={
            <Space>
              <ScissorOutlined />
              <span>ScaledObject Configuration</span>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    ScaledObject Name
                    <Tooltip title="Kubernetes ScaledObject resource name">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="scaledObjectName"
                rules={[
                  { required: true, message: 'Please input ScaledObject name!' },
                  { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers and hyphens allowed' }
                ]}
              >
                <Input placeholder="sglang-worker-scaler" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Namespace"
                name="namespace"
                rules={[{ required: true, message: 'Please input namespace!' }]}
              >
                <Input placeholder="default" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label={
              <Space>
                Target Deployment
                <Tooltip title="The Kubernetes Deployment to scale">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="targetDeployment"
            rules={[{ required: true, message: 'Please select target deployment!' }]}
          >
            <Select
              showSearch
              placeholder="Select deployment to scale"
              optionFilterProp="children"
              onFocus={fetchAvailableDeployments}
            >
              {availableDeployments.map(deployment => (
                <Option key={deployment.name} value={deployment.name}>
                  {deployment.name} ({deployment.namespace})
                </Option>
              ))}
            </Select>
          </Form.Item>
        </Card>

        {/* Scaling Configuration */}
        <Card
          title={
            <Space>
              <LineChartOutlined />
              <span>Scaling Parameters</span>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item
                label={
                  <Space>
                    Min Replicas
                    <Tooltip title="Minimum number of pod replicas">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="minReplicaCount"
                rules={[
                  { required: true, message: 'Please input min replicas!' },
                  { type: 'number', min: 0, max: 100, message: 'Must be between 0 and 100' }
                ]}
              >
                <InputNumber
                  min={0}
                  max={100}
                  style={{ width: '100%' }}
                  placeholder="1"
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={
                  <Space>
                    Max Replicas
                    <Tooltip title="Maximum number of pod replicas">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="maxReplicaCount"
                rules={[
                  { required: true, message: 'Please input max replicas!' },
                  { type: 'number', min: 1, max: 100, message: 'Must be between 1 and 100' }
                ]}
              >
                <InputNumber
                  min={1}
                  max={100}
                  style={{ width: '100%' }}
                  placeholder="10"
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={
                  <Space>
                    Polling Interval (s)
                    <Tooltip title="How often to check metrics">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="pollingInterval"
                rules={[
                  { required: true, message: 'Please input polling interval!' },
                  { type: 'number', min: 1, max: 300, message: 'Must be between 1 and 300 seconds' }
                ]}
              >
                <InputNumber
                  min={1}
                  max={300}
                  style={{ width: '100%' }}
                  placeholder="5"
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label={
                  <Space>
                    Cooldown Period (s)
                    <Tooltip title="Wait time before scaling down">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="cooldownPeriod"
                rules={[
                  { required: true, message: 'Please input cooldown period!' },
                  { type: 'number', min: 30, max: 3600, message: 'Must be between 30 and 3600 seconds' }
                ]}
              >
                <InputNumber
                  min={30}
                  max={3600}
                  style={{ width: '100%' }}
                  placeholder="300"
                />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        {/* Prometheus Configuration */}
        <Card
          title={
            <Space>
              <DatabaseOutlined />
              <span>Prometheus Metrics Configuration</span>
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            label={
              <Space>
                Prometheus Server Address
                <Tooltip title="Prometheus server URL for querying metrics">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="prometheusServer"
            rules={[{ required: true, message: 'Please input Prometheus server address!' }]}
          >
            <Input placeholder="http://prometheus-server.monitoring.svc.cluster.local:80" />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    Threshold
                    <Tooltip title="Metric value that triggers scaling up">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="threshold"
                rules={[{ required: true, message: 'Please input threshold!' }]}
              >
                <Input placeholder="2" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    Activation Threshold
                    <Tooltip title="Minimum value to activate scaler">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="activationThreshold"
                rules={[{ required: true, message: 'Please input activation threshold!' }]}
              >
                <Input placeholder="1" />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        {/* Prometheus ConfigMap Configuration */}
        <Card
          title={
            <Space>
              <ClockCircleOutlined />
              <span>Prometheus ConfigMap Settings</span>
            </Space>
          }
          style={{ marginBottom: 24 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Prometheus Namespace"
                name="prometheusNamespace"
                rules={[{ required: true, message: 'Please input Prometheus namespace!' }]}
              >
                <Input placeholder="monitoring" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Scrape Interval"
                name="scrapeInterval"
                rules={[{ required: true, message: 'Please input scrape interval!' }]}
              >
                <Select>
                  <Option value="5s">5 seconds</Option>
                  <Option value="10s">10 seconds</Option>
                  <Option value="15s">15 seconds</Option>
                  <Option value="30s">30 seconds</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            label={
              <Space>
                Prometheus Targets
                <Tooltip title="Comma-separated list of targets to scrape">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            name="prometheusTargets"
            rules={[{ required: true, message: 'Please input Prometheus targets!' }]}
          >
            <Input placeholder="sglang-router-service.default.svc.cluster.local:29000" />
          </Form.Item>
        </Card>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          <Button
            type="default"
            icon={<EyeOutlined />}
            onClick={handlePreview}
          >
            Preview YAML
          </Button>

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            loading={loading}
            icon={<RocketOutlined />}
          >
            Deploy KEDA Scaling
          </Button>
        </div>
      </Form>

      {/* YAML Preview Modal */}
      <Modal
        title={
          <Space>
            <EyeOutlined />
            KEDA Configuration Preview
          </Space>
        }
        visible={previewVisible}
        onCancel={() => setPreviewVisible(false)}
        width={800}
        footer={[
          <Button key="close" onClick={() => setPreviewVisible(false)}>
            Close
          </Button>,
          <Button
            key="copy"
            type="primary"
            icon={<SaveOutlined />}
            onClick={() => {
              navigator.clipboard.writeText(generatedYaml);
            }}
          >
            Copy to Clipboard
          </Button>
        ]}
      >
        <TextArea
          value={generatedYaml}
          rows={20}
          style={{ fontFamily: 'monospace', fontSize: '12px' }}
          readOnly
        />
      </Modal>
    </div>
  );
};

export default ScalingPanel;