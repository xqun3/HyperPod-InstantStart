import React, { useState, useEffect } from 'react';
import { Row, Col, Card, Tabs, Space, Select } from 'antd';
import { DownloadOutlined, DatabaseOutlined, SettingOutlined } from '@ant-design/icons';
import EnhancedModelDownloadPanel from './EnhancedModelDownloadPanel';
import S3StorageManager from './S3StorageManager';
import S3StoragePanel from './S3StoragePanel';

const { TabPane } = Tabs;
const { Option } = Select;

const EnhancedModelManagement = () => {
  const [selectedStorage, setSelectedStorage] = useState('s3-claim');
  const [availableStorages, setAvailableStorages] = useState([]);

  // 获取可用的存储配置 - 改为手动触发，不在组件挂载时自动执行
  const fetchAvailableStorages = async () => {
    try {
      const response = await fetch('/api/s3-storages');
      const result = await response.json();
      if (result.success) {
        setAvailableStorages(result.storages || []);
        // 如果当前选择的存储不存在，选择第一个可用的
        if (result.storages.length > 0 && !result.storages.find(s => s.pvcName === selectedStorage)) {
          setSelectedStorage(result.storages[0].pvcName);
        }
      }
    } catch (error) {
      console.error('Error fetching storages:', error);
    }
  };

  // 移除自动触发的useEffect，让S3StoragePanel自主管理数据获取
  // useEffect(() => {
  //   fetchAvailableStorages();
  // }, []);

  return (
    <Row gutter={[16, 16]} style={{ height: '100%' }}>
      {/* 左侧：配置面板 */}
      <Col xs={24} lg={12}>
        <Card
          title="Model Management Configuration"
          className="theme-card storage"
          style={{ height: '60vh', overflow: 'auto' }}
        >
          <Tabs 
            defaultActiveKey="enhanced-download" 
            size="small"
          >
            <TabPane
              tab={
                <Space>
                  <DownloadOutlined />
                  Model Download
                </Space>
              }
              key="enhanced-download"
            >
              <EnhancedModelDownloadPanel 
                onStorageChange={setSelectedStorage}
                onStorageRefresh={fetchAvailableStorages}
              />
            </TabPane>
            
            <TabPane
              tab={
                <Space>
                  <SettingOutlined />
                  S3 Mount Config
                </Space>
              }
              key="storage-config"
            >
              <S3StorageManager onStorageChange={fetchAvailableStorages} />
            </TabPane>
          </Tabs>
        </Card>
      </Col>

      {/* 右侧：S3存储显示 */}
      <Col xs={24} lg={12}>
        <Card 
          title={
            <Space>
              <DatabaseOutlined />
              S3 Storage Contents
              <Select
                size="small"
                value={selectedStorage}
                onChange={setSelectedStorage}
                style={{ minWidth: 150 }}
              >
                {availableStorages.map(storage => (
                  <Option key={storage.pvcName} value={storage.pvcName}>
                    {storage.name} ({storage.bucketName})
                  </Option>
                ))}
              </Select>
            </Space>
          }
          className="theme-card storage"
          style={{ height: '60vh', overflow: 'auto' }}
        >
          <S3StoragePanel selectedStorage={selectedStorage} />
        </Card>
      </Col>
    </Row>
  );
};

export default EnhancedModelManagement;
