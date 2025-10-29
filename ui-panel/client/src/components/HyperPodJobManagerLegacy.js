import React, { useState, useEffect } from 'react';
import {
  Table,
  Button,
  Space,
  Popconfirm,
  message,
  Tag,
  Tooltip,
  Typography,
  Card,
  Empty
} from 'antd';
import {
  DeleteOutlined,
  ReloadOutlined,
  ExperimentOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined
} from '@ant-design/icons';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

const { Text } = Typography;

const HyperPodJobManager = () => {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState({});

  // 获取训练任务列表
  const fetchTrainingJobs = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/training-jobs');
      const result = await response.json();
      
      if (result.success) {
        setJobs(result.jobs || []);
      } else {
        console.error('Failed to fetch training jobs:', result.error);
        setJobs([]);
      }
    } catch (error) {
      console.error('Error fetching training jobs:', error);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  // 使用自动刷新Hook
  const { manualRefresh, config } = useAutoRefresh(
    'hyperpod-job-manager',
    fetchTrainingJobs,
    { 
      enabled: true,
      immediate: true
    }
  );

  // 删除训练任务
  const deleteTrainingJob = async (jobName) => {
    setDeleteLoading(prev => ({ ...prev, [jobName]: true }));
    
    try {
      const response = await fetch(`/api/training-jobs/${jobName}`, {
        method: 'DELETE'
      });
      
      const result = await response.json();
      
      if (result.success) {
        // 移除重复的message.success，让WebSocket处理通知
        // message.success(`Training job "${jobName}" deleted successfully`);
        // 刷新列表
        await fetchTrainingJobs();
      } else {
        // 只在WebSocket没有处理错误时显示错误消息
        message.error(`Failed to delete training job: ${result.error}`);
      }
    } catch (error) {
      console.error('Error deleting training job:', error);
      message.error('Failed to delete training job');
    } finally {
      setDeleteLoading(prev => ({ ...prev, [jobName]: false }));
    }
  };

  // 获取状态标签
  const getStatusTag = (statusObj) => {
    // 处理状态对象，提取实际的状态字符串
    let status = 'Unknown';
    
    if (typeof statusObj === 'string') {
      status = statusObj;
    } else if (statusObj && typeof statusObj === 'object') {
      // 从状态对象中提取状态信息
      if (statusObj.conditions && Array.isArray(statusObj.conditions)) {
        const lastCondition = statusObj.conditions[statusObj.conditions.length - 1];
        if (lastCondition && lastCondition.type) {
          status = lastCondition.type;
        }
      } else if (statusObj.phase) {
        status = statusObj.phase;
      } else if (statusObj.state) {
        status = statusObj.state;
      }
    }

    const statusConfig = {
      'Running': { color: 'processing', icon: <SyncOutlined /> },
      'Succeeded': { color: 'success', icon: <CheckCircleOutlined /> },
      'Failed': { color: 'error', icon: <CloseCircleOutlined /> },
      'Pending': { color: 'warning', icon: <ClockCircleOutlined /> },
      'Unknown': { color: 'default', icon: <ClockCircleOutlined /> },
      'Created': { color: 'default', icon: <ClockCircleOutlined /> },
      'Completed': { color: 'success', icon: <CheckCircleOutlined /> }
    };

    const config = statusConfig[status] || statusConfig['Unknown'];
    
    return (
      <Tag color={config.color} icon={config.icon}>
        {status}
      </Tag>
    );
  };

  // 表格列定义
  const columns = [
    {
      title: 'Job Name',
      dataIndex: 'name',
      key: 'name',
      render: (name) => (
        <Space>
          <ExperimentOutlined style={{ color: '#1890ff' }} />
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status) => getStatusTag(status),
    },
    {
      title: 'Created',
      dataIndex: 'creationTimestamp',
      key: 'creationTimestamp',
      render: (timestamp) => {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return (
          <Tooltip title={date.toLocaleString()}>
            <Text type="secondary">
              {date.toLocaleDateString()} {date.toLocaleTimeString()}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'Duration',
      key: 'duration',
      render: (_, record) => {
        if (!record.creationTimestamp) return '-';
        
        const startTime = new Date(record.creationTimestamp);
        const now = new Date();
        const diffMs = now - startTime;
        
        // 转换为可读的时间格式
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        
        if (hours > 0) {
          return <Text type="secondary">{hours}h {minutes}m</Text>;
        } else if (minutes > 0) {
          return <Text type="secondary">{minutes}m</Text>;
        } else {
          return <Text type="secondary">{'< 1m'}</Text>;
        }
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Popconfirm
            title="Delete Training Job"
            description={`Are you sure you want to delete "${record.name}"?`}
            onConfirm={() => deleteTrainingJob(record.name)}
            okText="Yes"
            cancelText="No"
          >
            <Button
              type="primary"
              danger
              size="small"
              icon={<DeleteOutlined />}
              loading={deleteLoading[record.name]}
            >
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // 组件挂载时获取数据
  useEffect(() => {
    // 组件挂载时已经通过useAutoRefresh自动调用了fetchTrainingJobs
    // 这里不需要再次调用
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary">
          HyperPod PyTorchJob Management
        </Text>
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={manualRefresh}
          >
            Refresh
          </Button>
        </Space>
      </div>
      
      {jobs.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No training jobs found"
          style={{ padding: '20px 0' }}
        />
      ) : (
        <Table
          columns={columns}
          dataSource={jobs}
          rowKey="name"
          loading={loading}
          size="small"
          pagination={{
            pageSize: 5,
            showSizeChanger: false,
            showQuickJumper: false,
            showTotal: (total) => `Total ${total} jobs`
          }}
          scroll={{ y: 200 }}
        />
      )}
    </div>
  );
};

export default HyperPodJobManager;
