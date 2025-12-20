import React, { useState, useEffect, useCallback } from 'react';
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
  Divider,
  Typography,
  message,
  Spin,
  Modal,
  Select
} from 'antd';
import {
  ThunderboltFilled,
  InfoCircleOutlined,
  RocketOutlined,
  CodeOutlined,
  ReloadOutlined
} from '@ant-design/icons';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

const ManagedInferenceScalingPanel = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [ampWorkspaceUrl, setAmpWorkspaceUrl] = useState(null);
  const [ampLoading, setAmpLoading] = useState(false);
  const [yamlPreview, setYamlPreview] = useState('');
  const [previewVisible, setPreviewVisible] = useState(false);
  const [inferenceDeployments, setInferenceDeployments] = useState([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(false);

  // 获取 HyperPod Inference Operator 部署列表
  const fetchInferenceDeployments = useCallback(async () => {
    setDeploymentsLoading(true);
    try {
      const response = await fetch('/api/inference-operator/deployments');
      const data = await response.json();
      if (data.success) {
        setInferenceDeployments(data.deployments || []);
      } else {
        setInferenceDeployments([]);
      }
    } catch (error) {
      console.error('Error fetching inference deployments:', error);
      setInferenceDeployments([]);
    } finally {
      setDeploymentsLoading(false);
    }
  }, []);

  // 获取 AMP Workspace URL
  const fetchAmpWorkspace = useCallback(async () => {
    setAmpLoading(true);
    try {
      const response = await fetch('/api/cluster/amp-workspace');
      const data = await response.json();
      if (data.success && data.workspaceUrl) {
        setAmpWorkspaceUrl(data.workspaceUrl);
        form.setFieldValue('promServerAddress', data.workspaceUrl);
      } else {
        setAmpWorkspaceUrl(null);
      }
    } catch (error) {
      console.error('Error fetching AMP workspace:', error);
      setAmpWorkspaceUrl(null);
    } finally {
      setAmpLoading(false);
    }
  }, [form]);

  useEffect(() => {
    fetchAmpWorkspace();
    fetchInferenceDeployments();
  }, [fetchAmpWorkspace, fetchInferenceDeployments]);

  const handlePreview = async () => {
    try {
      const values = await form.validateFields();
      const response = await fetch('/api/keda/preview-scaledobject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      const data = await response.json();
      if (data.success) {
        setYamlPreview(data.yaml);
        setPreviewVisible(true);
      }
    } catch (error) {
      console.error('Error generating preview:', error);
    }
  };

  const handleDeploy = async (values) => {
    setLoading(true);
    try {
      const response = await fetch('/api/keda/deploy-scaledobject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      const data = await response.json();
      if (data.success) {
        message.success('KEDA ScaledObject deployed successfully');
        form.resetFields();
      } else {
        message.error(data.error || 'Failed to deploy');
      }
    } catch (error) {
      console.error('Error deploying scaling:', error);
      message.error('Failed to deploy scaling configuration');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '24px' }}>
      <Alert
        type="info"
        message="Managed Scaling (KEDA)"
        description="Configure KEDA auto-scaling for Inference Operator deployments based on Amazon Managed Prometheus (AMP) metrics."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Card
        title={
          <Space>
            <ThunderboltFilled />
            <Text strong>Auto-Scaling Configuration</Text>
          </Space>
        }
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleDeploy}
          initialValues={{
            deploymentName: '',
            minReplicaCount: 1,
            maxReplicaCount: 5,
            pollingInterval: 30,
            cooldownPeriod: 120,
            scaleDownStabilizationTime: 60,
            scaleUpStabilizationTime: 0,
            promQuery: 'avg(model_concurrent_requests{resource_name="DEPLOYMENT_NAME"})',
            promTargetValue: 5,
            promActivationTargetValue: 2
          }}
        >
          <Card size="small" style={{ marginBottom: 16, backgroundColor: '#e6f7ff' }}>
            <Paragraph style={{ marginBottom: 0, fontSize: '13px' }}>
              <strong>Note:</strong> This configuration will be applied to your next Managed Inference deployment.
              The DEPLOYMENT_NAME placeholder will be automatically replaced with your actual deployment name.
            </Paragraph>
          </Card>

          {/* Target Configuration */}
          <Divider orientation="left">Target Configuration</Divider>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item
              label="Deployment Name"
              name="deploymentName"
              rules={[{ required: true, message: 'Required' }]}
              tooltip="Select HyperPod Inference Operator deployment to scale"
              style={{ flex: 1, marginBottom: 0 }}
            >
              <Select
                placeholder="Select inference deployment"
                loading={deploymentsLoading}
                notFoundContent={
                  deploymentsLoading ? <Spin size="small" /> : 
                  <Text type="secondary">No HyperPod Inference Operator deployments found</Text>
                }
                showSearch
                filterOption={(input, option) =>
                  (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                }
                options={inferenceDeployments.map(dep => ({
                  label: dep.name,
                  value: dep.name
                }))}
              />
            </Form.Item>
            <Button
              icon={<ReloadOutlined />}
              loading={deploymentsLoading}
              onClick={fetchInferenceDeployments}
              title="Refresh deployments"
              style={{ marginTop: 30 }}
            />
          </Space.Compact>

          {/* Replica Configuration */}
          <Divider orientation="left">Replica Configuration</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Min Replicas"
                name="minReplicaCount"
                rules={[{ required: true, message: 'Required' }]}
                tooltip="Minimum number of replicas (can be 0 for scale-to-zero)"
              >
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Max Replicas"
                name="maxReplicaCount"
                rules={[{ required: true, message: 'Required' }]}
                tooltip="Maximum number of replicas"
              >
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          {/* Polling Configuration */}
          <Divider orientation="left">Polling Configuration</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Polling Interval (s)"
                name="pollingInterval"
                tooltip="How often KEDA queries Prometheus metrics"
              >
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Cooldown Period (s)"
                name="cooldownPeriod"
                tooltip="Wait time before scaling down from 1 to 0"
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Scale Down Stabilization (s)"
                name="scaleDownStabilizationTime"
                tooltip="Stabilization window for scale down decisions"
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Scale Up Stabilization (s)"
                name="scaleUpStabilizationTime"
                tooltip="Stabilization window for scale up decisions"
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          {/* Prometheus Trigger */}
          <Divider orientation="left">Prometheus Trigger</Divider>

          {ampLoading ? (
            <Alert
              message="Checking for Amazon Managed Prometheus..."
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
          ) : ampWorkspaceUrl ? (
            <Alert
              message="Amazon Managed Prometheus (AMP) Detected"
              description={
                <div style={{ fontSize: '12px' }}>
                  <strong>Using AMP from HyperPod Observability</strong>
                  <br />
                  Workspace URL has been auto-filled below.
                </div>
              }
              type="success"
              showIcon
              style={{ marginBottom: 16 }}
            />
          ) : (
            <Alert
              message="Prometheus Not Found"
              description={
                <div style={{ fontSize: '12px' }}>
                  <strong>Install HyperPod Observability first:</strong>
                  <br />
                  Go to SageMaker Console → HyperPod → Your Cluster → Advanced Capabilities → Install Observability
                  <br />
                  <br />
                  Or manually enter your Prometheus endpoint below.
                </div>
              }
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          <Form.Item
            label="Server Address"
            name="promServerAddress"
            rules={[{ required: true, message: 'Required' }]}
            tooltip="AMP workspace URL (without /api/v1/query path)"
          >
            <Input 
              placeholder="https://aps-workspaces.us-west-2.amazonaws.com/workspaces/ws-xxx" 
            />
          </Form.Item>

          <Form.Item
            label="PromQL Query"
            name="promQuery"
            rules={[{ required: true, message: 'Required' }]}
            tooltip="PromQL query that returns a scalar value. DEPLOYMENT_NAME will be auto-replaced."
          >
            <TextArea
              rows={3}
              placeholder='avg(model_concurrent_requests{resource_name="DEPLOYMENT_NAME"})'
            />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Target Value"
                name="promTargetValue"
                rules={[{ required: true, message: 'Required' }]}
                tooltip="Scale when metric value exceeds this threshold"
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Activation Target"
                name="promActivationTargetValue"
                tooltip="Value to scale from 0 to 1 replica"
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" icon={<RocketOutlined />} loading={loading}>
                Deploy Scaling
              </Button>
              <Button icon={<CodeOutlined />} onClick={handlePreview}>
                Preview YAML
              </Button>
              <Button onClick={() => form.resetFields()}>
                Reset
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Modal
        title="KEDA ScaledObject YAML Preview"
        open={previewVisible}
        onCancel={() => setPreviewVisible(false)}
        width={800}
        footer={[
          <Button key="close" onClick={() => setPreviewVisible(false)}>
            Close
          </Button>
        ]}
      >
        <pre style={{ backgroundColor: '#f5f5f5', padding: 16, borderRadius: 4, maxHeight: 600, overflow: 'auto' }}>
          {yamlPreview}
        </pre>
      </Modal>
    </div>
  );
};

export default ManagedInferenceScalingPanel;
