import React, { useState, useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  Card,
  Select,
  Button,
  Space,
  Alert,
  Typography,
  Spin,
  Empty,
  Row,
  Col,
  Tag,
  Popconfirm,
  message,
  Divider,
  Modal,
  Switch
} from 'antd';
import {
  LineChartOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ClearOutlined,
  DownloadOutlined,
  EyeOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import {
  fetchTrainingJobs,
  setActiveJob,
  updateJobLogs
} from '../store/slices/trainingSlice';
import {
  selectTrainingJobs,
  selectTrainingLoading,
  selectActiveJob,
  selectJobLogs
} from '../store/selectors';

const { Option } = Select;
const { Text, Title } = Typography;

// 日志显示配置
const MAX_DISPLAY_LINES = 1000; // 前端最多显示1000行日志

// 为不同pod定义颜色
const POD_COLORS = [
  '#1890ff', // 蓝色
  '#52c41a', // 绿色
  '#fa8c16', // 橙色
  '#eb2f96', // 粉色
  '#722ed1', // 紫色
  '#13c2c2', // 青色
  '#faad14', // 金色
  '#f5222d', // 红色
];

const TrainingMonitorPanelRedux = () => {
  // Redux state
  const dispatch = useDispatch();
  const trainingJobsFromStore = useSelector(selectTrainingJobs);
  const trainingJobs = Array.isArray(trainingJobsFromStore) ? trainingJobsFromStore : [];
  const loading = useSelector(selectTrainingLoading);
  const activeJob = useSelector(selectActiveJob);
  const jobLogs = useSelector(state => selectJobLogs(state));

  // Local state for UI
  const [selectedJob, setSelectedJob] = useState(null);
  const [jobPods, setJobPods] = useState([]);
  const [podsLoading, setPodsLoading] = useState(false);
  const [logs, setLogs] = useState({});
  const [logStreaming, setLogStreaming] = useState({});
  const [websocket, setWebsocket] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [autoScroll, setAutoScroll] = useState(true); // 自动滚动开关
  const logContainerRef = useRef(null);

  // 创建WebSocket连接
  useEffect(() => {
    console.log('Creating WebSocket connection for training monitor');
    setConnectionStatus('connecting');

    const connectWebSocket = () => {
      const ws = new WebSocket('ws://localhost:3098');

      ws.onopen = () => {
        console.log('WebSocket connected for training monitor');
        setWebsocket(ws);
        setConnectionStatus('connected');
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
      };

      ws.onclose = (event) => {
        console.log('WebSocket disconnected for training monitor, code:', event.code);
        setWebsocket(null);
        setConnectionStatus('disconnected');

        // 自动重连（如果不是正常关闭）
        if (event.code !== 1000) {
          console.log('Attempting to reconnect WebSocket in 3 seconds...');
          setTimeout(() => {
            setConnectionStatus('connecting');
            connectWebSocket();
          }, 3000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error for training monitor:', error);
        setConnectionStatus('error');
      };

      return ws;
    };

    const ws = connectWebSocket();

    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop_all_log_streams' }));
        ws.close(1000, 'Component unmounting');
      }
    };
  }, []);

  // 自动滚动到底部
  const scrollToBottom = () => {
    if (autoScroll && logContainerRef.current) {
      const container = logContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  };

  // 检查用户是否手动滚动了日志容器
  const handleLogScroll = () => {
    if (logContainerRef.current) {
      const container = logContainerRef.current;
      const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50; // 50px容差

      // 如果用户滚动到底部附近，启用自动滚动；否则禁用
      if (isAtBottom !== autoScroll) {
        setAutoScroll(isAtBottom);
      }
    }
  };

  // 当日志更新时自动滚动
  useEffect(() => {
    scrollToBottom();
  }, [logs, autoScroll]);

  // 处理WebSocket消息
  const handleWebSocketMessage = (data) => {
    switch (data.type) {
      case 'log_data':
        handleLogData(data);
        break;
      case 'log_error':
        handleLogError(data);
        break;
      case 'log_stream_closed':
        handleLogStreamClosed(data);
        break;
      case 'log_stream_error':
        handleLogStreamError(data);
        break;
      case 'log_stream_stopped':
        handleLogStreamStopped(data);
        break;
      case 'training_job_deleted':
        if (data.status === 'success') {
          message.success(data.message);
          dispatch(fetchTrainingJobs());
          if (selectedJob === data.jobName) {
            dispatch(setActiveJob(null));
            setSelectedJob(null);
            setJobPods([]);
            setLogs({});
          }
        } else {
          message.error(data.message);
        }
        break;
      case 'training_launch':
        if (data.jobName && data.logs) {
          // Update job logs using Redux
          dispatch(updateJobLogs({
            jobName: data.jobName,
            logs: data.logs
          }));
        }
        break;
      case 'training_log_update':
        if (data.jobName && data.logs) {
          // Update job logs using Redux
          dispatch(updateJobLogs({
            jobName: data.jobName,
            logs: data.logs
          }));
        }
        break;
      default:
        break;
    }
  };

  // 处理日志数据
  const handleLogData = (data) => {
    const { podName, data: logData, timestamp } = data;
    setLogs(prevLogs => {
      const podLogs = prevLogs[podName] || [];
      const newLog = {
        timestamp,
        data: logData,
        type: 'log'
      };

      const updatedLogs = [...podLogs, newLog];

      // 限制显示行数，保持最新的日志
      if (updatedLogs.length > MAX_DISPLAY_LINES) {
        return {
          ...prevLogs,
          [podName]: updatedLogs.slice(-MAX_DISPLAY_LINES)
        };
      }

      return {
        ...prevLogs,
        [podName]: updatedLogs
      };
    });
  };

  // 处理日志错误
  const handleLogError = (data) => {
    const { podName, error, timestamp } = data;
    setLogs(prevLogs => {
      const podLogs = prevLogs[podName] || [];
      const newLog = {
        timestamp,
        data: `Error: ${error}`,
        type: 'error'
      };
      return {
        ...prevLogs,
        [podName]: [...podLogs, newLog]
      };
    });
  };

  // 处理日志流关闭
  const handleLogStreamClosed = (data) => {
    const { podName } = data;
    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
    console.log(`Log stream closed for pod: ${podName}`);
  };

  // 处理日志流错误
  const handleLogStreamError = (data) => {
    const { podName, error } = data;
    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
    message.error(`Log stream error for ${podName}: ${error}`);
  };

  // 处理日志流停止
  const handleLogStreamStopped = (data) => {
    const { podName } = data;
    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
    console.log(`Log stream stopped for pod: ${podName}`);
  };

  // 获取训练任务的pods
  const fetchJobPods = async (jobName) => {
    setPodsLoading(true);
    try {
      const response = await fetch(`/api/training-jobs/${jobName}/pods`);
      const result = await response.json();

      if (result.success) {
        setJobPods(result.pods);
        // 清空之前的日志
        setLogs({});
        setLogStreaming({});
      } else {
        message.error(`Failed to fetch pods: ${result.error}`);
        setJobPods([]);
      }
    } catch (error) {
      console.error('Error fetching job pods:', error);
      message.error('Failed to fetch job pods');
      setJobPods([]);
    } finally {
      setPodsLoading(false);
    }
  };

  // 开始日志流
  const startLogStream = (podName) => {
    if (connectionStatus === 'connecting') {
      message.warning('WebSocket is connecting, please wait a moment...');
      return;
    }

    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        type: 'start_log_stream',
        jobName: selectedJob,
        podName: podName
      }));

      setLogStreaming(prev => ({
        ...prev,
        [podName]: true
      }));

      message.success(`Started log streaming for ${podName}`);
    } else {
      message.error(`WebSocket connection not available (${connectionStatus}). Please wait for connection.`);
    }
  };

  // 停止日志流
  const stopLogStream = (podName) => {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        type: 'stop_log_stream',
        jobName: selectedJob,
        podName: podName
      }));
    }

    setLogStreaming(prev => ({
      ...prev,
      [podName]: false
    }));
  };

  // 清空日志
  const clearLogs = () => {
    setLogs({});
  };

  // 获取完整日志
  const fetchFullLogs = async (jobName, podName) => {
    try {
      const response = await fetch(`http://localhost:3001/api/logs/${jobName}/${podName}`);
      if (response.ok) {
        const fullLogs = await response.text();
        return fullLogs;
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch logs');
      }
    } catch (error) {
      console.error('Failed to fetch full logs:', error);
      message.error(`获取完整日志失败: ${error.message}`);
      return null;
    }
  };

  // 下载完整日志
  const downloadFullLogs = async (jobName, podName) => {
    try {
      const response = await fetch(`http://localhost:3001/api/logs/${jobName}/${podName}/download`);
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${podName}.log`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        message.success('日志文件下载成功');
      } else {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to download logs');
      }
    } catch (error) {
      console.error('Failed to download logs:', error);
      message.error(`下载日志失败: ${error.message}`);
    }
  };

  // 查看完整日志（在模态框中显示）
  const viewFullLogs = async (jobName, podName) => {
    const fullLogs = await fetchFullLogs(jobName, podName);
    if (fullLogs) {
      Modal.info({
        title: `完整日志 - ${podName}`,
        content: (
          <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <pre style={{ fontSize: '12px', lineHeight: '1.4', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
              {fullLogs}
            </pre>
          </div>
        ),
        width: '80%',
        okText: '关闭'
      });
    }
  };

  // 处理训练任务选择
  const handleJobSelect = (jobName) => {
    // 停止之前的所有日志流
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'stop_all_log_streams' }));
    }

    dispatch(setActiveJob(jobName));
    setSelectedJob(jobName);
    setLogs({});
    setLogStreaming({});

    if (jobName) {
      fetchJobPods(jobName);
    } else {
      setJobPods([]);
    }
  };

  // Initial loading
  useEffect(() => {
    dispatch(fetchTrainingJobs());
  }, [dispatch]);

  // Effect to fetch job pods when selected job changes
  useEffect(() => {
    if (activeJob) {
      setSelectedJob(activeJob);
      fetchJobPods(activeJob);
    }
  }, [activeJob]);

  // 渲染日志内容
  const renderLogs = () => {
    if (jobPods.length === 0) {
      return (
        <Empty
          description="No pods found for selected training job"
          style={{ padding: '40px 0' }}
        />
      );
    }

    const allLogs = [];

    // 合并所有pod的日志并按时间排序
    jobPods.forEach((pod, index) => {
      const podLogs = logs[pod.name] || [];
      const color = POD_COLORS[index % POD_COLORS.length];

      podLogs.forEach(log => {
        allLogs.push({
          ...log,
          podName: pod.name,
          color: color
        });
      });
    });

    // 按时间戳排序
    allLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return (
      <div
        ref={logContainerRef}
        onScroll={handleLogScroll}
        style={{
          height: '400px',
          overflow: 'auto',
          backgroundColor: '#001529',
          color: '#fff',
          padding: '12px',
          fontFamily: 'Monaco, Consolas, "Courier New", monospace',
          fontSize: '12px',
          lineHeight: '1.4'
        }}
      >
        {allLogs.length === 0 ? (
          <div style={{ color: '#666', textAlign: 'center', padding: '20px' }}>
            No logs available. Click "Start Streaming" to begin monitoring logs.
          </div>
        ) : (
          allLogs.map((log, index) => (
            <div key={index} style={{ marginBottom: '2px' }}>
              <span style={{ color: '#666', fontSize: '10px' }}>
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span
                style={{
                  color: log.color,
                  fontWeight: 'bold',
                  marginLeft: '8px',
                  marginRight: '8px'
                }}
              >
                [{log.podName}]
              </span>
              <span style={{ color: log.type === 'error' ? '#ff4d4f' : '#fff', whiteSpace: 'pre-wrap' }}>
                {log.data}
              </span>
            </div>
          ))
        )}
        {/* 自动滚动状态指示器 */}
        {allLogs.length > 0 && (
          <div style={{
            position: 'sticky',
            bottom: 0,
            right: 0,
            textAlign: 'right',
            padding: '4px 8px',
            backgroundColor: 'rgba(0, 21, 41, 0.8)',
            fontSize: '10px',
            color: autoScroll ? '#52c41a' : '#faad14',
            borderTop: '1px solid #434343'
          }}>
            {autoScroll ? 'Auto-scrolling enabled' : 'Manual scroll mode'}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: '100%' }}>
      {/* 训练任务管理部分 */}
      <Card
        title={
          <Space>
            <LineChartOutlined />
            Log Monitor
            {connectionStatus === 'connected' && (
              <Tag color="green" size="small">Ready</Tag>
            )}
            {connectionStatus === 'connecting' && (
              <Tag color="orange" size="small">Connecting...</Tag>
            )}
            {connectionStatus === 'disconnected' && (
              <Tag color="red" size="small">Disconnected</Tag>
            )}
            {connectionStatus === 'error' && (
              <Tag color="red" size="small">Error</Tag>
            )}
          </Space>
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => dispatch(fetchTrainingJobs())}
            loading={loading}
            size="small"
          >
            Refresh
          </Button>
        }
        style={{ marginBottom: '16px' }}
      >
        <Row gutter={[16, 16]} align="middle">
          <Col span={24}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Text strong>Select Training Job:</Text>
              <Select
                style={{ width: '100%' }}
                placeholder="Select a training job to monitor"
                value={selectedJob}
                onChange={handleJobSelect}
                loading={loading}
                allowClear
              >
                {trainingJobs.map(job => (
                  <Option key={job.name} value={job.name}>
                    <Space>
                      <Text strong>{job.name}</Text>
                      <Tag color="blue">
                        {job.spec.replicas} replicas
                      </Tag>
                      <Text type="secondary" style={{ fontSize: '12px' }}>
                        Created: {new Date(job.creationTimestamp).toLocaleString()}
                      </Text>
                    </Space>
                  </Option>
                ))}
              </Select>
            </Space>
          </Col>
        </Row>

        {selectedJob && (
          <>
            <Divider />
            <Row gutter={[16, 8]} align="middle">
              <Col>
                <Text strong>Pods ({jobPods.length}):</Text>
              </Col>
              {jobPods.map((pod, index) => {
                const color = POD_COLORS[index % POD_COLORS.length];
                const isStreaming = logStreaming[pod.name];

                return (
                  <Col key={pod.name}>
                    <Space>
                      <Tag color={color} style={{ margin: 0 }}>
                        {pod.name}
                      </Tag>
                      <Tag color={pod.status === 'Running' ? 'green' : 'orange'}>
                        {pod.status}
                      </Tag>
                      <Button
                        size="small"
                        type={isStreaming ? "primary" : "default"}
                        icon={isStreaming ? <StopOutlined /> : <PlayCircleOutlined />}
                        onClick={() => isStreaming ? stopLogStream(pod.name) : startLogStream(pod.name)}
                        loading={podsLoading}
                        disabled={!isStreaming && connectionStatus !== 'connected'}
                      >
                        {isStreaming ? 'Stop' : 'Start'} Streaming
                      </Button>
                    </Space>
                  </Col>
                );
              })}
            </Row>
          </>
        )}
      </Card>

      {/* 日志显示部分 */}
      {selectedJob && (
        <Card
          title={
            <Space>
              <Text strong>Training Logs - {selectedJob}</Text>
              {Object.values(logStreaming).some(streaming => streaming) && (
                <Tag color="green">Live Streaming</Tag>
              )}
              <Text type="secondary" style={{ fontSize: '12px' }}>
                显示最近 {MAX_DISPLAY_LINES} 行日志 (实时)
              </Text>
            </Space>
          }
          extra={
            <Space>
              {/* 自动滚动开关 */}
              <Space align="center">
                <span style={{ fontSize: '12px', color: '#666' }}>Auto-scroll:</span>
                <Switch
                  size="small"
                  checked={autoScroll}
                  onChange={(checked) => {
                    setAutoScroll(checked);
                    if (checked) {
                      scrollToBottom();
                    }
                  }}
                  checkedChildren="ON"
                  unCheckedChildren="OFF"
                />
              </Space>
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={clearLogs}
              >
                Clear Logs
              </Button>
              {/* 完整日志操作按钮 */}
              {jobPods.length > 0 && (
                <>
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    onClick={() => {
                      if (jobPods.length === 1) {
                        viewFullLogs(selectedJob, jobPods[0].name);
                      } else {
                        // 多个pod时显示选择菜单
                        Modal.confirm({
                          title: '选择Pod查看完整日志',
                          content: (
                            <div>
                              {jobPods.map(pod => (
                                <Button
                                  key={pod.name}
                                  block
                                  style={{ marginBottom: '8px' }}
                                  onClick={() => {
                                    Modal.destroyAll();
                                    viewFullLogs(selectedJob, pod.name);
                                  }}
                                >
                                  {pod.name} ({pod.status})
                                </Button>
                              ))}
                            </div>
                          ),
                          footer: null,
                          width: 400
                        });
                      }
                    }}
                  >
                    查看完整日志
                  </Button>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={() => {
                      if (jobPods.length === 1) {
                        downloadFullLogs(selectedJob, jobPods[0].name);
                      } else {
                        // 多个pod时显示选择菜单
                        Modal.confirm({
                          title: '选择Pod下载完整日志',
                          content: (
                            <div>
                              {jobPods.map(pod => (
                                <Button
                                  key={pod.name}
                                  block
                                  style={{ marginBottom: '8px' }}
                                  onClick={() => {
                                    Modal.destroyAll();
                                    downloadFullLogs(selectedJob, pod.name);
                                  }}
                                >
                                  {pod.name} ({pod.status})
                                </Button>
                              ))}
                            </div>
                          ),
                          footer: null,
                          width: 400
                        });
                      }
                    }}
                  >
                    下载完整日志
                  </Button>
                </>
              )}
            </Space>
          }
        >
          {renderLogs()}
        </Card>
      )}

      {!selectedJob && (
        <Card>
          <Empty
            image={<LineChartOutlined style={{ fontSize: '64px', color: '#d9d9d9' }} />}
            description={
              <div>
                <Title level={4} style={{ color: '#999', marginBottom: '8px' }}>
                  Select a Training Job
                </Title>
                <Text type="secondary">
                  Choose a training job from the dropdown above to monitor its logs and manage pods.
                </Text>
              </div>
            }
          />
        </Card>
      )}
    </div>
  );
};

export default TrainingMonitorPanelRedux;