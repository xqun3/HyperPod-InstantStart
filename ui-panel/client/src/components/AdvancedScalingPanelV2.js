import React, { useState } from 'react';
import {
  Card,
  Form,
  Row,
  Col,
  Input,
  InputNumber,
  Select,
  Button,
  Space,
  Alert,
  Radio,
  Tooltip
} from 'antd';
import {
  ShareAltOutlined,
  RocketOutlined,
  GlobalOutlined,
  LinkOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import './AdvancedScalingPanelV2.css';

const { Option } = Select;

const AdvancedScalingPanelV2 = ({ onDeploy, deploymentStatus }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);



  const handleSubmit = async (values) => {
    setLoading(true);
    try {
      console.log('Routing Config:', values);

      // 构建配置对象
      const config = {
        type: 'advanced-scaling',
        sglangRouter: {
          deploymentName: values.deploymentName || 'sglang-router',
          routingPolicy: values.routingPolicy || 'cache_aware',
          routerPort: values.routerPort || 30000,
          metricsPort: values.metricsPort || 29000,
          serviceType: values.serviceType || 'external'
        }
      };

      if (onDeploy) {
        await onDeploy(config);
      }
    } catch (error) {
      console.error('Error deploying routing:', error);
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="advanced-scaling-v2">
      <Alert
        type="info"
        message="Routing with SGLang Router"
        description="Configure intelligent request routing with SGLang Router. Model deployments are managed in the Model Deployment tab."
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          deploymentName: 'sglang-router',
          routingPolicy: 'cache_aware',
          routerPort: 30000,
          metricsPort: 29000,
          serviceType: 'external'
        }}
      >
        {/* SGLang Router Configuration */}
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
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    Deployment Name
                    <Tooltip title="Name for the SGLang Router deployment">
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
                  placeholder="sglang-router"
                  style={{ fontFamily: 'monospace' }}
                />
              </Form.Item>
            </Col>
          </Row>

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

          <Row gutter={16} style={{ marginTop: 16 }}>
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    Service Type
                    <Tooltip title="Select how to expose the SGLang Router service">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="serviceType"
                rules={[{ required: true, message: 'Please select service type!' }]}
              >
                <Radio.Group>
                  <Radio value="external">
                    <Space>
                      <GlobalOutlined />
                      External Access
                    </Space>
                  </Radio>
                  <Radio value="clusterip">
                    <Space>
                      <LinkOutlined />
                      Cluster IP
                    </Space>
                  </Radio>
                </Radio.Group>
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
            Deploy SGLang Router
          </Button>
        </div>
      </Form>
    </div>
  );
};

export default AdvancedScalingPanelV2;