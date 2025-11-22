import React, { useEffect, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Table,
  Progress,
  Tag,
  Button,
  Space,
  Statistic,
  Row,
  Col,
  Card,
  message,
  Tooltip,
  Spin,
  Alert
} from 'antd';
import {
  ReloadOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ClusterOutlined,
  WarningOutlined
} from '@ant-design/icons';

// Redux imports
import { refreshClusterData } from '../store/slices/clusterStatusSlice';
import {
  selectClusterNodes,
  selectPendingGPUs,
  selectClusterStatusLoading,
  selectClusterStatusError,
  selectCalculatedClusterStats,
  selectClusterLastUpdate
} from '../store/selectors';

// 新的事件总线
import resourceEventBus from '../utils/resourceEventBus';

const ClusterStatusV2Redux = () => {
  const dispatch = useDispatch();

  // Redux 状态
  const clusterNodes = useSelector(selectClusterNodes);
  const pendingGPUs = useSelector(selectPendingGPUs);
  const loading = useSelector(selectClusterStatusLoading);
  const error = useSelector(selectClusterStatusError);
  const clusterStats = useSelector(selectCalculatedClusterStats);
  const lastUpdate = useSelector(selectClusterLastUpdate);


  // 初始化时获取数据（只执行一次）
  useEffect(() => {
    dispatch(refreshClusterData());

    // 订阅资源变化事件
    const refreshCallback = (eventType) => {
      // 只响应需要 GPU 的操作，忽略 'app-status-only' 事件
      if (eventType === 'app-status-only') {
        console.log('[ClusterStatus] Ignoring app-status-only event');
        return;
      }
      
      console.log('[ClusterStatus] Refreshing for event:', eventType);
      dispatch(refreshClusterData());
    };
    
    resourceEventBus.subscribe('cluster-status', refreshCallback);

    // 清理订阅
    return () => {
      resourceEventBus.unsubscribe('cluster-status');
    };
  }, [dispatch]); // 只依赖dispatch，避免无限循环


  // 手动刷新
  const handleRefresh = useCallback(async () => {
    try {
      await dispatch(refreshClusterData()).unwrap();
      message.success('Cluster status refreshed successfully');
    } catch (error) {
      console.error('Error refreshing cluster status:', error);
      message.error('Failed to refresh cluster status: ' + (error.message || error));
    }
  }, [dispatch]);

  // 表格列定义 - 与原版相同
  const columns = [
    {
      title: 'Node Name',
      dataIndex: 'nodeName',
      key: 'nodeName',
      width: '22%',
      render: (text, record) => (
        <div>
          <Space>
            <ClusterOutlined />
            <span style={{ fontFamily: 'monospace' }}>{text}</span>
            {!record.nodeReady && (
              <Tooltip title="Node not ready">
                <WarningOutlined style={{ color: '#faad14' }} />
              </Tooltip>
            )}
          </Space>
        </div>
      ),
    },
    {
      title: 'Instance Type',
      dataIndex: 'instanceType',
      key: 'instanceType',
      width: '13%',
      render: (text) => (
        <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>
          {text && text !== 'Unknown' ? text : '-'}
        </span>
      ),
    },
    {
      title: 'Capacity Type',
      key: 'capacityType',
      width: '12%',
      render: (_, record) => {
        const labels = record.labels || {};

        // HyperPod节点
        if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') {
          return (
            <Tag color="#722ed1">HyperPod</Tag>
          );
        }

        // EC2 Karpenter节点
        if (labels['karpenter.sh/nodepool']) {
          const capacityType = labels['karpenter.sh/capacity-type'] || 'unknown';
          return (
            <div>
              <Tag color="#52c41a">EC2 Karpenter</Tag>
              <div style={{ fontSize: '11px', color: '#666', marginTop: 2 }}>
                {capacityType === 'spot' ? 'Spot' : 'On-Demand'}
              </div>
            </div>
          );
        }

        // EKS NodeGroup节点
        if (labels['eks.amazonaws.com/nodegroup']) {
          const capacityType = labels['eks.amazonaws.com/capacityType'] || 'ON_DEMAND';
          return (
            <div>
              <Tag color="#1890ff">EKS NodeGroup</Tag>
              <div style={{ fontSize: '11px', color: '#666', marginTop: 2 }}>
                {capacityType === 'SPOT' ? 'Spot' : 'On-Demand'}
              </div>
            </div>
          );
        }

        // 未知类型
        return <Tag color="#8c8c8c">Unknown</Tag>;
      },
    },
    {
      title: 'Group/Pool',
      key: 'groupPool',
      width: '13%',
      render: (_, record) => {
        const labels = record.labels || {};

        // HyperPod节点
        if (labels['sagemaker.amazonaws.com/compute-type'] === 'hyperpod') {
          const instanceGroup = labels['sagemaker.amazonaws.com/instance-group-name'] || 'unknown';
          return <span style={{ fontSize: '12px' }}>Group: {instanceGroup}</span>;
        }

        // EC2 Karpenter节点
        if (labels['karpenter.sh/nodepool']) {
          const ec2NodePool = labels['karpenter.sh/nodepool'];
          return <span style={{ fontSize: '12px' }}>Pool: {ec2NodePool}</span>;
        }

        // EKS NodeGroup节点
        if (labels['eks.amazonaws.com/nodegroup']) {
          const nodegroup = labels['eks.amazonaws.com/nodegroup'];
          return <span style={{ fontSize: '12px' }}>Group: {nodegroup}</span>;
        }

        return <span style={{ color: '#8c8c8c' }}>-</span>;
      },
    },
    {
      title: 'GPU Usage',
      key: 'gpuUsage',
      render: (_, record) => {
        const { totalGPU = 0, usedGPU = 0, availableGPU = 0, allocatableGPU = 0, pendingGPU = 0 } = record;
        const percentage = totalGPU > 0 ? (usedGPU / totalGPU) * 100 : 0;

        return (
          <div>
            <Progress
              percent={Math.round(percentage)}
              size="small"
              status={percentage > 80 ? 'exception' : percentage > 60 ? 'active' : 'success'}
              format={() => `${usedGPU}/${totalGPU}`}
            />
            <div style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
              <Space size="small">
                <span>Available: {availableGPU}</span>
                {allocatableGPU !== totalGPU && (
                  <Tooltip title={`Total capacity: ${totalGPU}, Allocatable: ${allocatableGPU}`}>
                    <span style={{ color: '#1890ff' }}>
                      (Alloc: {allocatableGPU})
                    </span>
                  </Tooltip>
                )}
                {pendingGPU > 0 && (
                  <Tooltip title={`GPU requests from Pending pods (not counted in usage)`}>
                    <span style={{ color: '#faad14' }}>
                      Pending: {pendingGPU}
                    </span>
                  </Tooltip>
                )}
              </Space>
            </div>
          </div>
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      render: (_, record) => {
        const { totalGPU = 0, availableGPU = 0, error, nodeReady } = record;

        if (error) {
          return (
            <Tooltip title={error}>
              <Tag color="red" icon={<ExclamationCircleOutlined />}>
                Error
              </Tag>
            </Tooltip>
          );
        }

        if (!nodeReady) {
          return (
            <Tag color="orange" icon={<WarningOutlined />}>
              Not Ready
            </Tag>
          );
        }

        if (availableGPU === 0 && totalGPU > 0) {
          return (
            <Tag color="orange" icon={<ExclamationCircleOutlined />}>
              Full
            </Tag>
          );
        }

        return (
          <Tag color="green" icon={<CheckCircleOutlined />}>
            Available
          </Tag>
        );
      },
    },
  ];

  return (
    <Spin spinning={loading} tip="Refreshing cluster status...">
      <div>
        {/* 简单错误提示 - 可选显示 */}
        {error && (
          <Alert
            message="Unable to fetch cluster status"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            closable
          />
        )}

        {/* 总体统计 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Nodes"
                value={clusterStats.readyNodes}
                suffix={`/ ${clusterStats.totalNodes}`}
                prefix={<ClusterOutlined />}
                valueStyle={{
                  color: clusterStats.readyNodes === clusterStats.totalNodes ? '#52c41a' : '#faad14'
                }}
              />
              {clusterStats.errorNodes > 0 && (
                <div style={{ fontSize: '12px', color: '#cf1322', marginTop: 4 }}>
                  {clusterStats.errorNodes} error(s)
                </div>
              )}
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Total GPUs"
                value={clusterStats.totalGPUs}
                valueStyle={{ color: '#1890ff' }}
              />
              {clusterStats.allocatableGPUs !== clusterStats.totalGPUs && (
                <div style={{ fontSize: '12px', color: '#666', marginTop: 4 }}>
                  Allocatable: {clusterStats.allocatableGPUs}
                </div>
              )}
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Total Request GPUs"
                value={clusterStats.usedGPUs + clusterStats.pendingGPUs}
                valueStyle={{
                  color: (clusterStats.usedGPUs + clusterStats.pendingGPUs) > clusterStats.totalGPUs
                    ? '#cf1322' : '#666'
                }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Used GPUs"
                value={clusterStats.usedGPUs}
                valueStyle={{ color: '#cf1322' }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Available GPUs"
                value={clusterStats.availableGPUs}
                valueStyle={{ color: '#52c41a' }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title="Pending GPUs"
                value={clusterStats.pendingGPUs}
                valueStyle={{ color: '#faad14' }}
              />
            </Card>
          </Col>
        </Row>

        {/* 刷新按钮和最后更新时间 */}
        <div style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ fontSize: '12px', color: '#666' }}>
            {lastUpdate
              ? `Last updated: ${new Date(lastUpdate).toLocaleTimeString()}`
              : 'No data loaded yet'
            }
          </span>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            loading={loading}
            size="small"
          >
            Refresh
          </Button>
        </div>

        {/* 节点详情表格 */}
        <Table
          columns={columns}
          dataSource={clusterNodes}
          rowKey="nodeName"
          size="small"
          pagination={false}
          scroll={{ y: 300 }}
          locale={{
            emptyText: loading ? 'Refreshing cluster data...' : 'No cluster data available'
          }}
          rowClassName={(record) => {
            if (record.error) return 'cluster-row-error';
            if (!record.nodeReady) return 'cluster-row-warning';
            return '';
          }}
        />

        <style jsx>{`
          .cluster-row-error {
            background-color: #fff2f0;
          }
          .cluster-row-warning {
            background-color: #fffbe6;
          }
        `}</style>
      </div>
    </Spin>
  );
};

export default ClusterStatusV2Redux;