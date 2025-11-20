import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Select, InputNumber, Button, Switch, message, Space, Typography, AutoComplete } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;
const { Option } = Select;

const EksNodeGroupCreationPanel = ({ onCreated }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [clusterInfo, setClusterInfo] = useState(null);
  const [subnets, setSubnets] = useState({ publicSubnets: [], privateSubnets: [], hyperPodSubnets: [] });
  const [hyperPodGroups, setHyperPodGroups] = useState([]);
  const [eksSecurityGroup, setEksSecurityGroup] = useState(null);

  useEffect(() => {
    fetchSubnetInfo();
    fetchHyperPodInfo();
  }, []);

  const fetchSubnetInfo = async () => {
    try {
      const response = await fetch('/api/cluster/subnets');
      const result = await response.json();
      
      if (result.success) {
        setClusterInfo({
          eksClusterName: result.data.eksClusterName,
          region: result.data.region,
          vpcId: result.data.vpcId
        });
        setSubnets({
          publicSubnets: result.data.publicSubnets || [],
          privateSubnets: result.data.privateSubnets || [],
          hyperPodSubnets: result.data.hyperPodSubnets || []
        });
        setEksSecurityGroup(result.data.securityGroupId);
      } else {
        message.error(`Failed to fetch subnet info: ${result.error}`);
      }
    } catch (error) {
      message.error(`Error fetching subnet info: ${error.message}`);
    }
  };

  const fetchHyperPodInfo = async () => {
    try {
      const response = await fetch('/api/cluster/nodegroups');
      const result = await response.json();
      
      if (result.success) {
        setHyperPodGroups(result.hyperPodInstanceGroups || []);
      }
    } catch (error) {
      console.error('Error fetching HyperPod info:', error);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setLoading(true);

      const response = await fetch('/api/cluster/create-nodegroup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userConfig: values
        }),
      });

      const result = await response.json();

      if (result.success) {
        message.success('EKS node group creation started successfully!');
        form.resetFields();
        if (onCreated) {
          onCreated();
        }
      } else {
        message.error(`Failed to create node group: ${result.error}`);
      }
    } catch (error) {
      message.error(`Error creating node group: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // 开关：是否只显示 HyperPod 使用的子网
  const ONLY_SHOW_HYPERPOD_SUBNETS = false;

  // 获取可用子网
  const getAvailableSubnets = () => {
    if (ONLY_SHOW_HYPERPOD_SUBNETS) {
      // 只显示 HyperPod 使用的私有子网
      const hyperPodPrivateSubnets = subnets.privateSubnets.filter(s => s.isHyperPodSubnet);
      return hyperPodPrivateSubnets.map(s => ({ ...s, type: 'Private (HyperPod)' }));
    } else {
      // 显示所有私有子网
      return subnets.privateSubnets.map(s => ({
        ...s,
        type: s.isHyperPodSubnet ? 'Private (HyperPod)' : 'Private'
      }));
    }
  };

  const availableSubnets = getAvailableSubnets();

  // GPU实例类型选项（不带ml.前缀，与HyperPod选项对应）
  const gpuInstanceTypes = [
    'g5.8xlarge', 'g5.12xlarge', 'g5.24xlarge', 'g5.48xlarge',
    'g6.8xlarge', 'g6.12xlarge', 'g6.24xlarge', 'g6.48xlarge', 
    'g6e.8xlarge', 'g6e.12xlarge', 'g6e.24xlarge', 'g6e.48xlarge',
    'p4d.24xlarge', 'p5.48xlarge', 'p5en.48xlarge', 'p6-b200.48xlarge'
  ];

  return (
    <Card title="Create EKS Node Group" size="small">
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          minSize: 0,
          maxSize: 3,
          desiredCapacity: 1,
          volumeSize: 200,
          useSpotInstances: false
        }}
      >
        {/* 只读集群信息 */}
        <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
          <Text type="secondary">
            <strong>EKS Cluster:</strong> {clusterInfo?.eksClusterName || 'Loading...'}
          </Text>
          <Text type="secondary">
            <strong>Region:</strong> {clusterInfo?.region || 'Loading...'}
          </Text>
          <Text type="secondary">
            <strong>VPC:</strong> {clusterInfo?.vpcId || 'Loading...'}
          </Text>
          <Text type="secondary">
            <strong>Security Group:</strong> {eksSecurityGroup || 'Loading...'}
          </Text>
        </Space>

        <Form.Item
          name="nodeGroupName"
          label="Node Group Name"
          rules={[{ required: true, message: 'Please input node group name!' }]}
        >
          <Input placeholder="gpu-nodegroup-1" />
        </Form.Item>

        <Form.Item
          name="instanceType"
          label="Instance Type"
          rules={[{ required: true, message: 'Please select or input instance type!' }]}
        >
          <AutoComplete
            placeholder="Select or type GPU instance type"
            options={gpuInstanceTypes.map(type => ({ value: type, label: type }))}
            filterOption={(inputValue, option) =>
              option.value.toLowerCase().indexOf(inputValue.toLowerCase()) !== -1
            }
          />
        </Form.Item>

        <Form.Item
          name="subnetId"
          label="Subnet"
          rules={[{ required: true, message: 'Please select subnet!' }]}
          extra={
            availableSubnets.length === 0 
              ? "Note: No private subnets available" 
              : ONLY_SHOW_HYPERPOD_SUBNETS 
                ? "Select HyperPod private subnet" 
                : "Select private subnet (HyperPod subnets are marked)"
          }
        >
          <Select placeholder="Select subnet">
            {availableSubnets.map(subnet => (
              <Option key={subnet.subnetId} value={subnet.subnetId}>
                {subnet.name} ({subnet.type}) - {subnet.availabilityZone} - {subnet.cidrBlock}
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Space style={{ width: '100%' }}>
          <Form.Item
            name="minSize"
            label="Min Size"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={0} max={100} style={{ width: 80 }} />
          </Form.Item>

          <Form.Item
            name="maxSize"
            label="Max Size"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={1} max={100} style={{ width: 80 }} />
          </Form.Item>

          <Form.Item
            name="desiredCapacity"
            label="Desired"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={0} max={100} style={{ width: 80 }} />
          </Form.Item>

          <Form.Item
            name="volumeSize"
            label="Volume Size (GB)"
            rules={[{ required: true, message: 'Required!' }]}
          >
            <InputNumber min={20} max={1000} style={{ width: 120 }} />
          </Form.Item>
        </Space>

        <Form.Item name="useSpotInstances" label="Use Spot Instances" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            icon={<PlusOutlined />}
            block
          >
            Create Node Group
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default EksNodeGroupCreationPanel;
