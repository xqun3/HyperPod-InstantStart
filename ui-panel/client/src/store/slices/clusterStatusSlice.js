import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取集群状态
export const fetchClusterStatus = createAsyncThunk(
  'clusterStatus/fetchClusterStatus',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching cluster status via Redux...');
      const response = await fetch('/api/cluster-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Cluster status response:', data);

      return {
        nodes: data.nodes || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching cluster status:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 Pending GPUs 统计
export const fetchPendingGPUs = createAsyncThunk(
  'clusterStatus/fetchPendingGPUs',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/pending-gpus');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return {
        pendingGPUs: data.pendingGPUs || 0,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching pending GPUs:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 组合操作：同时获取集群状态和 Pending GPUs
export const refreshClusterData = createAsyncThunk(
  'clusterStatus/refreshClusterData',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      const results = await Promise.allSettled([
        dispatch(fetchClusterStatus()).unwrap(),
        dispatch(fetchPendingGPUs()).unwrap()
      ]);

      const clusterResult = results[0];
      const pendingGPUResult = results[1];

      // 检查是否有错误
      const errors = [];
      if (clusterResult.status === 'rejected') {
        errors.push(`Cluster status: ${clusterResult.reason}`);
      }
      if (pendingGPUResult.status === 'rejected') {
        errors.push(`Pending GPUs: ${pendingGPUResult.reason}`);
      }

      if (errors.length > 0) {
        return rejectWithValue(`Some operations failed: ${errors.join(', ')}`);
      }

      return {
        success: true,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const clusterStatusSlice = createSlice({
  name: 'clusterStatus',
  initialState: {
    // 集群节点数据
    nodes: [],

    // Pending GPUs 统计
    pendingGPUs: 0,

    // 状态管理
    loading: false,
    pendingGPUsLoading: false,
    error: null,

    // 时间戳记录
    lastUpdate: null,
    lastPendingGPUsUpdate: null,

    // 计算得出的统计信息（将由 selectors 计算）
    stats: {
      totalNodes: 0,
      readyNodes: 0,
      totalGPUs: 0,
      usedGPUs: 0,
      availableGPUs: 0,
      allocatableGPUs: 0,
      errorNodes: 0,
      pendingGPUs: 0
    }
  },
  reducers: {
    // 清除错误状态
    clearError: (state) => {
      state.error = null;
    },

    // 更新单个节点状态（用于 WebSocket 实时更新）
    updateNodeStatus: (state, action) => {
      const { nodeName, status } = action.payload;
      const nodeIndex = state.nodes.findIndex(node => node.nodeName === nodeName);

      if (nodeIndex !== -1) {
        state.nodes[nodeIndex] = { ...state.nodes[nodeIndex], ...status };
        state.lastUpdate = new Date().toISOString();
      }
    },

    // 更新 Pending GPUs（用于 WebSocket 实时更新）
    updatePendingGPUs: (state, action) => {
      state.pendingGPUs = action.payload;
      state.lastPendingGPUsUpdate = new Date().toISOString();
    },

    // 计算并更新统计信息
    updateStats: (state) => {
      const stats = state.nodes.reduce((acc, node) => ({
        totalNodes: acc.totalNodes + 1,
        readyNodes: acc.readyNodes + (node.nodeReady ? 1 : 0),
        totalGPUs: acc.totalGPUs + (node.totalGPU || 0),
        usedGPUs: acc.usedGPUs + (node.usedGPU || 0),
        availableGPUs: acc.availableGPUs + (node.availableGPU || 0),
        allocatableGPUs: acc.allocatableGPUs + (node.allocatableGPU || 0),
        errorNodes: acc.errorNodes + (node.error ? 1 : 0)
      }), {
        totalNodes: 0,
        readyNodes: 0,
        totalGPUs: 0,
        usedGPUs: 0,
        availableGPUs: 0,
        allocatableGPUs: 0,
        errorNodes: 0
      });

      state.stats = {
        ...stats,
        pendingGPUs: state.pendingGPUs
      };
    }
  },
  extraReducers: (builder) => {
    // 处理获取集群状态
    builder
      .addCase(fetchClusterStatus.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchClusterStatus.fulfilled, (state, action) => {
        state.loading = false;
        state.nodes = action.payload.nodes;
        state.lastUpdate = action.payload.timestamp;

        // 自动更新统计信息
        clusterStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchClusterStatus.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理获取 Pending GPUs
      .addCase(fetchPendingGPUs.pending, (state) => {
        state.pendingGPUsLoading = true;
      })
      .addCase(fetchPendingGPUs.fulfilled, (state, action) => {
        state.pendingGPUsLoading = false;
        state.pendingGPUs = action.payload.pendingGPUs;
        state.lastPendingGPUsUpdate = action.payload.timestamp;

        // 更新统计信息
        state.stats.pendingGPUs = action.payload.pendingGPUs;
      })
      .addCase(fetchPendingGPUs.rejected, (state, action) => {
        state.pendingGPUsLoading = false;
        // Pending GPUs 失败不影响主要功能，只记录错误
        console.error('Failed to fetch pending GPUs:', action.payload);
      })

    // 处理组合刷新操作
      .addCase(refreshClusterData.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(refreshClusterData.fulfilled, (state, action) => {
        state.loading = false;
        state.lastUpdate = action.payload.timestamp;
      })
      .addCase(refreshClusterData.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  }
});

export const {
  clearError,
  updateNodeStatus,
  updatePendingGPUs,
  updateStats
} = clusterStatusSlice.actions;

export default clusterStatusSlice.reducer;