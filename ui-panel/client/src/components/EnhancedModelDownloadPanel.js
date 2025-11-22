import React, { useState, useEffect } from 'react';
import { Form, Input, Button, Card, Space, Collapse, message, Typography, Select, InputNumber, Row, Col } from 'antd';
import { DownloadOutlined, KeyOutlined, RobotOutlined, SettingOutlined, ReloadOutlined } from '@ant-design/icons';
import operationRefreshManager from '../hooks/useOperationRefresh';
import resourceEventBus from '../utils/resourceEventBus';

const { Panel } = Collapse;
const { Text } = Typography;
const { Option } = Select;

const EnhancedModelDownloadPanel = ({ onStorageChange }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [storages, setStorages] = useState([]);

  // 获取可用的S3存储配置
  const fetchStorages = async () => {
    try {
      const response = await fetch('/api/s3-storages');
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setStorages(result.storages || []);
        }
      }
    } catch (error) {
      console.error('Error fetching S3 storages:', error);
      // 设置默认存储，避免界面卡住
      setStorages([]);
    }
  };

  useEffect(() => {
    fetchStorages();
    
    // 暂时注释掉全局刷新监听，避免超时问题
    // const unsubscribe = globalRefreshManager.subscribe(async () => {
    //   console.log('🔄 Enhanced Model Download Panel: Global refresh triggered');
    //   await fetchStorages();
    // });
    
    // return () => {
    //   unsubscribe();
    // };
  }, []);

  const handleDownload = async (values) => {
    try {
      setLoading(true);
      console.log('🚀 Starting model download with values:', values);
      
      const response = await fetch('/api/download-model-enhanced', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modelId: values.modelId,
          hfToken: values.hfToken || null,
          resources: {
            cpu: values.cpu || 8,
            memory: values.memory || 16,
          },
          s3Storage: values.s3Storage || 's3-claim'
        }),
      });
      
      const result = await response.json();
      
      if (result.success) {
        message.success(`Model download job created: ${result.jobName}`);
        
        // 触发操作刷新（旧机制，保留兼容）
        operationRefreshManager.triggerOperationRefresh('model-download', {
          modelId: values.modelId,
          jobName: result.jobName,
          timestamp: new Date().toISOString(),
          source: 'enhanced-model-download-panel'
        });

        // 触发新的事件总线（新机制）
        resourceEventBus.emit('model-download', {
          modelId: values.modelId,
          jobName: result.jobName
        });
        
        console.log('✅ Model download initiated and refresh triggered');
        form.resetFields();
      } else {
        message.error(`Download failed: ${result.error}`);
      }
    } catch (error) {
      console.error('❌ Error downloading model:', error);
      message.error('Failed to initiate model download');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card 
      title={
        <Space>
          <RobotOutlined />
          Model Download
        </Space>
      }
      size="small"
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleDownload}
        initialValues={{
          cpu: 8,
          memory: 16,
          s3Storage: 's3-claim'
        }}
      >
        {/* S3存储选择 - 第一位 */}
        <Form.Item
          name="s3Storage"
          label={
            <Space>
              S3 Provision
              <Button 
                type="text" 
                size="small" 
                icon={<ReloadOutlined />}
                onClick={fetchStorages}
                title="Refresh storage list"
              />
            </Space>
          }
          rules={[{ required: true, message: 'Please select S3 provision' }]}
        >
          <Select 
            placeholder="Select S3 provision configuration"
            onChange={(value) => onStorageChange && onStorageChange(value)}
          >
            {storages.map(storage => (
              <Option key={storage.pvcName} value={storage.pvcName}>
                {storage.name} ({storage.bucketName})
              </Option>
            ))}
          </Select>
        </Form.Item>

        {/* Model ID - 第二位 */}
        <Form.Item
          name="modelId"
          label="Model ID"
          rules={[{ required: true, message: 'Please input model ID' }]}
        >
          <Input 
            placeholder="e.g., microsoft/DialoGPT-medium, meta-llama/Llama-2-7b-hf"
            prefix={<RobotOutlined />}
          />
        </Form.Item>

        {/* 资源配置和HF Token合并 */}
        <Collapse size="small" style={{ marginBottom: 16 }}>
          <Panel 
            header={
              <Space>
                <SettingOutlined />
                Advanced Configuration
              </Space>
            } 
            key="advanced"
          >
            {/* 资源配置 */}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Form.Item
                  name="cpu"
                  label="CPU Cores"
                  rules={[{ required: true, message: 'Please input CPU cores' }]}
                >
                  <InputNumber
                    min={1}
                    max={32}
                    style={{ width: '100%' }}
                    placeholder="8"
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="memory"
                  label="Memory (GB)"
                  rules={[{ required: true, message: 'Please input memory' }]}
                >
                  <InputNumber
                    min={1}
                    max={128}
                    style={{ width: '100%' }}
                    placeholder="16"
                  />
                </Form.Item>
              </Col>
            </Row>

            {/* HF Token */}
            <Form.Item
              name="hfToken"
              label={
                <Space>
                  <KeyOutlined />
                  <Text>Hugging Face Token</Text>
                  <Text type="secondary" style={{ fontSize: '12px' }}>
                    (Optional, for private models)
                  </Text>
                </Space>
              }
            >
              <Input.Password 
                placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                visibilityToggle
              />
            </Form.Item>
          </Panel>
        </Collapse>

        <Form.Item>
          <Button 
            type="primary" 
            htmlType="submit" 
            loading={loading}
            icon={<DownloadOutlined />}
            block
          >
            Download Model
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
};

export default EnhancedModelDownloadPanel;
