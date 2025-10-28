import React, { useState } from 'react';
import {
  Card,
  Steps,
  Form,
  Row,
  Col,
  Checkbox,
  Slider,
  Select,
  Input,
  InputNumber,
  Switch,
  Radio,
  Space,
  Button,
  Alert,
  Tag,
  Typography,
  Descriptions,
  Divider,
  Progress,
  Tooltip
} from 'antd';
import {
  CloudServerOutlined,
  ShareAltOutlined,
  RocketOutlined,
  CheckCircleOutlined,
  EyeOutlined,
  DownloadOutlined,
  DollarOutlined,
  ThunderboltOutlined,
  SafetyOutlined,
  SettingOutlined
} from '@ant-design/icons';
import './AdvancedScalingPanelPreview.css';

const { Option } = Select;
const { Text, Title } = Typography;
const { TextArea } = Input;
const { Step } = Steps;

const AdvancedScalingPanelPreview = () => {
  const [currentStep, setCurrentStep] = useState(0);
  const [form] = Form.useForm();
  const [deploying, setDeploying] = useState(false);
  const [config, setConfig] = useState({
    onDemandInstances: ['g6.xlarge', 'g6.2xlarge'],
    spotInstances: ['g6.xlarge', 'g6.2xlarge', 'g6.4xlarge'],
    onDemandLimit: 10,
    spotLimit: 20,
    routingPolicy: 'cache_aware',
    routerPort: 30000,
    modelReplicas: 6,
    priority: 'medium-priority-spot'
  });

  const steps = [
    {
      title: 'Karpenter Config',
      icon: <CloudServerOutlined />,
      description: 'Node pools & cost optimization'
    },
    {
      title: 'SGLang Router',
      icon: <ShareAltOutlined />,
      description: 'Intelligent routing configuration'
    },
    {
      title: 'Model Deployment',
      icon: <RocketOutlined />,
      description: 'Scaling & model settings'
    },
    {
      title: 'Preview & Deploy',
      icon: <CheckCircleOutlined />,
      description: 'Review and deploy stack'
    }
  ];

  const nextStep = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const calculateEstimatedCost = () => {
    const onDemandCost = config.onDemandLimit * 0.85; // 假设每GPU每小时$0.85
    const spotCost = config.spotLimit * 0.25; // 假设每GPU每小时$0.25
    return (onDemandCost + spotCost).toFixed(2);
  };

  const renderKarpenterConfig = () => (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={12}>
          <Card
            title={
              <Space>
                <SafetyOutlined style={{ color: '#52c41a' }} />
                <span>On-Demand Node Pool</span>
                <Tag color="green">Stable</Tag>
              </Space>
            }
            size="small"
            style={{ height: '100%' }}
          >
            <Form.Item label="Instance Types">
              <Checkbox.Group
                defaultValue={config.onDemandInstances}
                onChange={(values) => setConfig({...config, onDemandInstances: values})}
              >
                <Space direction="vertical">
                  <Checkbox value="g6.xlarge">
                    <Space>
                      g6.xlarge
                      <Text type="secondary">(1 GPU, 4 vCPUs)</Text>
                    </Space>
                  </Checkbox>
                  <Checkbox value="g6.2xlarge">
                    <Space>
                      g6.2xlarge
                      <Text type="secondary">(1 GPU, 8 vCPUs)</Text>
                    </Space>
                  </Checkbox>
                  <Checkbox value="g6.4xlarge">
                    <Space>
                      g6.4xlarge
                      <Text type="secondary">(1 GPU, 16 vCPUs)</Text>
                    </Space>
                  </Checkbox>
                </Space>
              </Checkbox.Group>
            </Form.Item>

            <Form.Item label="GPU Limit">
              <Slider
                min={1}
                max={20}
                value={config.onDemandLimit}
                onChange={(value) => setConfig({...config, onDemandLimit: value})}
                marks={{
                  1: '1',
                  5: '5',
                  10: '10',
                  15: '15',
                  20: '20'
                }}
              />
              <Text type="secondary">Max {config.onDemandLimit} GPUs (Cost Control)</Text>
            </Form.Item>
          </Card>
        </Col>

        <Col span={12}>
          <Card
            title={
              <Space>
                <DollarOutlined style={{ color: '#1890ff' }} />
                <span>Spot Node Pool</span>
                <Tag color="blue">Cost-Effective</Tag>
              </Space>
            }
            size="small"
            style={{ height: '100%' }}
          >
            <Form.Item label="Instance Types">
              <Checkbox.Group
                defaultValue={config.spotInstances}
                onChange={(values) => setConfig({...config, spotInstances: values})}
              >
                <Space direction="vertical">
                  <Checkbox value="g6.xlarge">
                    <Space>
                      g6.xlarge
                      <Text type="secondary">(1 GPU, 4 vCPUs)</Text>
                    </Space>
                  </Checkbox>
                  <Checkbox value="g6.2xlarge">
                    <Space>
                      g6.2xlarge
                      <Text type="secondary">(1 GPU, 8 vCPUs)</Text>
                    </Space>
                  </Checkbox>
                  <Checkbox value="g6.4xlarge">
                    <Space>
                      g6.4xlarge
                      <Text type="secondary">(1 GPU, 16 vCPUs)</Text>
                    </Space>
                  </Checkbox>
                </Space>
              </Checkbox.Group>
            </Form.Item>

            <Form.Item label="GPU Limit">
              <Slider
                min={1}
                max={50}
                value={config.spotLimit}
                onChange={(value) => setConfig({...config, spotLimit: value})}
                marks={{
                  1: '1',
                  10: '10',
                  20: '20',
                  30: '30',
                  50: '50'
                }}
              />
              <Text type="secondary">Max {config.spotLimit} GPUs (Budget Friendly)</Text>
            </Form.Item>
          </Card>
        </Col>
      </Row>

      <Alert
        type="info"
        message="Cost-Aware Scheduling"
        description="Karpenter will prioritize Spot instances when possible, falling back to On-Demand for guaranteed availability."
        showIcon
        style={{ marginTop: 16 }}
      />

      <Card title="Cost Estimation" size="small" style={{ marginTop: 16 }}>
        <Row gutter={16}>
          <Col span={8}>
            <Text strong>On-Demand: </Text>
            <Text>${(config.onDemandLimit * 0.85).toFixed(2)}/hour</Text>
          </Col>
          <Col span={8}>
            <Text strong>Spot: </Text>
            <Text>${(config.spotLimit * 0.25).toFixed(2)}/hour</Text>
          </Col>
          <Col span={8}>
            <Text strong>Total Max: </Text>
            <Text type="danger">${calculateEstimatedCost()}/hour</Text>
          </Col>
        </Row>
      </Card>
    </div>
  );

  const renderSGLangRouter = () => (
    <div>
      <Row gutter={[16, 16]}>
        <Col span={12}>
          <Card title="Router Configuration" size="small">
            <Form.Item label="Routing Policy">
              <Select
                value={config.routingPolicy}
                onChange={(value) => setConfig({...config, routingPolicy: value})}
              >
                <Option value="cache_aware">
                  <Space>
                    <ThunderboltOutlined />
                    Cache Aware (Recommended)
                  </Space>
                </Option>
                <Option value="round_robin">Round Robin</Option>
                <Option value="least_loaded">Least Loaded</Option>
              </Select>
            </Form.Item>

            <Form.Item label="Router Port">
              <InputNumber
                min={8000}
                max={65535}
                value={config.routerPort}
                onChange={(value) => setConfig({...config, routerPort: value})}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item label="Metrics Port">
              <InputNumber
                min={8000}
                max={65535}
                defaultValue={29000}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Card>
        </Col>

        <Col span={12}>
          <Card title="Service Discovery" size="small">
            <Form.Item label="Pod Selector">
              <TextArea
                rows={3}
                defaultValue="app=sglang-qwen-inference"
                placeholder="Kubernetes selector for model pods"
              />
            </Form.Item>

            <Form.Item label="Discovery Port">
              <InputNumber
                min={1000}
                max={65535}
                defaultValue={8000}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item>
              <Space>
                <Switch defaultChecked />
                <Text>Enable Health Check</Text>
                <Tooltip title="Automatically remove unhealthy pods from routing">
                  <Text type="secondary">(?)</Text>
                </Tooltip>
              </Space>
            </Form.Item>
          </Card>
        </Col>
      </Row>

      <Alert
        type="success"
        message="Smart Routing Enabled"
        description="SGLang Router will automatically discover model pods and route requests based on cache awareness for optimal performance."
        showIcon
        style={{ marginTop: 16 }}
      />
    </div>
  );

  const renderModelDeployment = () => (
    <div>
      <Card title="Scheduling Priority" size="small" style={{ marginBottom: 16 }}>
        <Radio.Group
          value={config.priority}
          onChange={(e) => setConfig({...config, priority: e.target.value})}
        >
          <Space direction="vertical">
            <Radio value="high-priority-ondemand">
              <Space>
                <Tag color="red">High Priority</Tag>
                On-Demand Nodes (Stable, Higher Cost ~$0.85/GPU/hour)
              </Space>
            </Radio>
            <Radio value="medium-priority-spot">
              <Space>
                <Tag color="blue">Medium Priority</Tag>
                Spot Nodes (Cost-Effective ~$0.25/GPU/hour, May be Interrupted)
              </Space>
            </Radio>
          </Space>
        </Radio.Group>
      </Card>

      <Row gutter={[16, 16]}>
        <Col span={12}>
          <Card title="Instance Configuration" size="small">
            <Form.Item label="Model Replicas">
              <Slider
                min={1}
                max={10}
                value={config.modelReplicas}
                onChange={(value) => setConfig({...config, modelReplicas: value})}
                marks={{
                  1: '1',
                  3: '3',
                  6: '6',
                  10: '10'
                }}
              />
              <Text type="secondary">{config.modelReplicas} replicas</Text>
            </Form.Item>

            <Form.Item label="CPU Request">
              <InputNumber
                min={1}
                max={16}
                defaultValue={4}
                addonAfter="cores"
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item label="Memory Request">
              <InputNumber
                min={1}
                max={32}
                defaultValue={8}
                addonAfter="Gi"
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item label="GPU Request">
              <InputNumber
                min={1}
                max={1}
                defaultValue={1}
                addonAfter="GPU"
                style={{ width: '100%' }}
                disabled
              />
            </Form.Item>
          </Card>
        </Col>

        <Col span={12}>
          <Card title="Model Deployment" size="small">
            <Form.Item label="Model Path">
              <Input
                placeholder="/s3/Qwen-Qwen3-0.6B/"
                defaultValue="/s3/Qwen-Qwen3-0.6B/"
              />
            </Form.Item>

            <Form.Item label="TP Size (Tensor Parallel)">
              <Select defaultValue="1">
                <Option value="1">1 (Single GPU)</Option>
                <Option value="2">2 (Multi GPU)</Option>
              </Select>
            </Form.Item>

            <Form.Item label="Model Port">
              <InputNumber
                min={1000}
                max={65535}
                defaultValue={8000}
                style={{ width: '100%' }}
              />
            </Form.Item>

            <Form.Item>
              <Space>
                <Switch defaultChecked />
                <Text>Trust Remote Code</Text>
              </Space>
            </Form.Item>
          </Card>
        </Col>
      </Row>
    </div>
  );

  const renderPreviewAndDeploy = () => (
    <div>
      <Card title="Deployment Preview" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="Node Pools">
            <Space>
              <Tag color="green">On-Demand ({config.onDemandLimit} GPUs)</Tag>
              <Tag color="blue">Spot ({config.spotLimit} GPUs)</Tag>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Router Policy">
            <Tag color="purple">{config.routingPolicy}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Model Replicas">
            <Tag>{config.modelReplicas}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Priority Class">
            <Tag color={config.priority === 'high-priority-ondemand' ? 'red' : 'blue'}>
              {config.priority}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Estimated Max Cost">
            <Text strong type="danger">${calculateEstimatedCost()}/hour</Text>
          </Descriptions.Item>
          <Descriptions.Item label="Router Endpoint">
            <Text code>sglang-router-service:{config.routerPort}</Text>
          </Descriptions.Item>
        </Descriptions>

        <Divider />

        <Alert
          type="success"
          message="Configuration Validated Successfully"
          description="All components are properly configured and ready for deployment. The system will automatically scale based on demand."
          showIcon
        />

        <div style={{ marginTop: 16 }}>
          <Title level={5}>Deployment Components:</Title>
          <Row gutter={[8, 8]}>
            <Col><Tag color="cyan">Karpenter NodeClass</Tag></Col>
            <Col><Tag color="cyan">On-Demand NodePool</Tag></Col>
            <Col><Tag color="cyan">Spot NodePool</Tag></Col>
            <Col><Tag color="green">PriorityClass (High)</Tag></Col>
            <Col><Tag color="blue">PriorityClass (Medium)</Tag></Col>
            <Col><Tag color="orange">SGLang Router</Tag></Col>
            <Col><Tag color="orange">Router Service</Tag></Col>
            <Col><Tag color="purple">Model Deployment</Tag></Col>
            <Col><Tag color="red">ServiceAccount & RBAC</Tag></Col>
          </Row>
        </div>
      </Card>

      <Card>
        <Space size="large">
          <Button
            type="primary"
            size="large"
            icon={<RocketOutlined />}
            loading={deploying}
            onClick={() => {
              setDeploying(true);
              setTimeout(() => setDeploying(false), 3000);
            }}
          >
            Deploy KVCache-aware Routing Stack
          </Button>

          <Button
            icon={<EyeOutlined />}
            size="large"
          >
            Preview YAML
          </Button>

          <Button
            icon={<DownloadOutlined />}
            size="large"
          >
            Export Config
          </Button>
        </Space>
      </Card>
    </div>
  );

  const renderStepContent = () => {
    switch (currentStep) {
      case 0:
        return renderKarpenterConfig();
      case 1:
        return renderSGLangRouter();
      case 2:
        return renderModelDeployment();
      case 3:
        return renderPreviewAndDeploy();
      default:
        return renderKarpenterConfig();
    }
  };

  return (
    <div className="advanced-scaling-preview">
      <Alert
        type="info"
        message="UI Design Preview"
        description="This is a preview of the KVCache-aware Routing configuration panel. All interactions are simulated for demonstration purposes."
        showIcon
        closable
        style={{ marginBottom: 16 }}
      />

      <Card
        title={
          <Space>
            <SettingOutlined />
            <span>KVCache-aware Routing Configuration</span>
            <Tag color="orange">SGLang + Karpenter</Tag>
          </Space>
        }
      >
        <Steps
          current={currentStep}
          size="small"
          style={{ marginBottom: 24 }}
          items={steps}
        />

        <div style={{ marginBottom: 24 }}>
          <Progress
            percent={((currentStep + 1) / steps.length) * 100}
            showInfo={false}
            strokeColor={{
              '0%': '#108ee9',
              '100%': '#87d068',
            }}
          />
        </div>

        <div className="step-content">
          {renderStepContent()}
        </div>

        <Divider />

        <div className="step-navigation" style={{ textAlign: 'center' }}>
          <Space>
            <Button
              disabled={currentStep === 0}
              onClick={prevStep}
            >
              Previous
            </Button>

            <Text type="secondary">
              Step {currentStep + 1} of {steps.length}
            </Text>

            <Button
              type="primary"
              disabled={currentStep === steps.length - 1}
              onClick={nextStep}
            >
              Next
            </Button>
          </Space>
        </div>
      </Card>
    </div>
  );
};

export default AdvancedScalingPanelPreview;