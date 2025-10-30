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
  Tooltip,
  Collapse
} from 'antd';
import {
  ShareAltOutlined,
  RocketOutlined,
  GlobalOutlined,
  LinkOutlined,
  InfoCircleOutlined,
  SettingOutlined
} from '@ant-design/icons';
import './AdvancedScalingPanelV2.css';

const { Option } = Select;
const { Panel } = Collapse;

const AdvancedScalingPanelV2 = ({ onDeploy, deploymentStatus }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [routingPolicy, setRoutingPolicy] = useState('cache_aware');



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

          // 固定为clusterIP类型
          serviceType: 'clusterip',

          // 服务发现配置 - 固定针对sglang类型的deployment
          targetDeployment: values.targetDeployment,
          discoveryPort: values.discoveryPort || 8000,
          checkInterval: values.checkInterval || 120,

          // Cache-Aware策略参数
          cacheThreshold: values.cacheThreshold,
          balanceAbsThreshold: values.balanceAbsThreshold,
          balanceRelThreshold: values.balanceRelThreshold,
          evictionIntervalSecs: values.evictionIntervalSecs,
          maxTreeSize: values.maxTreeSize
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
          targetDeployment: '',
          discoveryPort: 8000,
          checkInterval: 120,
          cacheThreshold: 0.5,
          balanceAbsThreshold: 32,
          balanceRelThreshold: 1.1,
          evictionIntervalSecs: 30,
          maxTreeSize: 10000
        }}
      >
        {/* SGLang Router Basic Configuration */}
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
            <Col span={12}>
              <Form.Item
                label={
                  <Space>
                    Target SGLang Deployment
                    <Tooltip title="Select SGLang deployment to route requests to (only ClusterIP services are supported)">
                      <InfoCircleOutlined />
                    </Tooltip>
                  </Space>
                }
                name="targetDeployment"
                rules={[{ required: true, message: 'Please select target deployment!' }]}
              >
                <Select placeholder="Select SGLang deployment">
                  <Option value="">All SGLang Deployments (ClusterIP only)</Option>
                  <Option value="qwensgl-2025-10-30-06-39-57">qwensgl-2025-10-30-06-39-57 (ClusterIP)</Option>
                  <Option value="qwensglext-2025-10-30-06-44-25" disabled>qwensglext-2025-10-30-06-44-25 (LoadBalancer - Not supported)</Option>
                </Select>
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
                <Select onChange={setRoutingPolicy}>
                  <Option value="cache_aware">Cache Aware (Recommended)</Option>
                  <Option value="round_robin">Round Robin</Option>
                  <Option value="random">Random</Option>
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

          <Alert
            type="info"
            message="Router Service Configuration"
            description="Router will be deployed as ClusterIP service for internal cluster access only."
            style={{ marginTop: 16 }}
          />
        </Card>

        {/* Service Discovery Configuration */}
        <Card
          title={
            <Space>
              <SettingOutlined />
              <span>Service Discovery Settings</span>
            </Space>
          }
          className="section-card"
          style={{ marginBottom: 24 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="Discovery Port"
                name="discoveryPort"
                rules={[{ required: true, message: 'Please enter discovery port' }]}
              >
                <InputNumber
                  min={1000}
                  max={65535}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Check Interval (secs)"
                name="checkInterval"
                rules={[{ required: true, message: 'Please enter check interval' }]}
              >
                <InputNumber
                  min={30}
                  max={600}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Alert
            type="info"
            message="Automatic Discovery"
            description={`Router will automatically discover pods from the selected SGLang deployment using label selector: model-type=sglang`}
            style={{ marginTop: 8 }}
          />
        </Card>

        {/* Advanced Configuration - Only show for cache_aware policy */}
        {routingPolicy === 'cache_aware' && (
          <Collapse style={{ marginBottom: 24 }}>
            <Panel
              header={
                <Space>
                  <SettingOutlined />
                  <span>Cache-Aware Policy Settings</span>
                </Space>
              }
              key="cache-aware-settings"
            >
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item
                    label={
                      <Space>
                        Cache Threshold
                        <Tooltip title="Cache matching threshold (0.0-1.0)">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="cacheThreshold"
                  >
                    <InputNumber
                      min={0}
                      max={1}
                      step={0.1}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    label={
                      <Space>
                        Balance Abs Threshold
                        <Tooltip title="Load imbalance absolute threshold">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="balanceAbsThreshold"
                  >
                    <InputNumber
                      min={1}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item
                    label={
                      <Space>
                        Balance Rel Threshold
                        <Tooltip title="Load imbalance relative threshold">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="balanceRelThreshold"
                  >
                    <InputNumber
                      min={1}
                      step={0.1}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item
                    label={
                      <Space>
                        Eviction Interval (secs)
                        <Tooltip title="Cache cleanup interval in seconds">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="evictionIntervalSecs"
                  >
                    <InputNumber
                      min={10}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    label={
                      <Space>
                        Max Tree Size
                        <Tooltip title="Maximum nodes per radix tree">
                          <InfoCircleOutlined />
                        </Tooltip>
                      </Space>
                    }
                    name="maxTreeSize"
                  >
                    <InputNumber
                      min={1000}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Panel>
          </Collapse>
        )}

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