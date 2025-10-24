import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取集群列表
export const fetchClusters = createAsyncThunk(
  'clusters/fetchClusters',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/multi-cluster/list');
      if (!response.ok) throw new Error('Failed to fetch clusters');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：切换活跃集群
export const switchCluster = createAsyncThunk(
  'clusters/switchCluster',
  async (clusterTag, { rejectWithValue, dispatch }) => {
    try {
      const response = await fetch('/api/multi-cluster/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterTag }),
      });

      if (!response.ok) throw new Error('Failed to switch cluster');

      // 获取集群详细信息
      const clusterInfoResponse = await fetch(`/api/cluster/info?clusterTag=${clusterTag}`);
      if (!clusterInfoResponse.ok) throw new Error('Failed to fetch cluster info');

      return await clusterInfoResponse.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：检查依赖状态
export const checkDependenciesStatus = createAsyncThunk(
  'clusters/checkDependenciesStatus',
  async (clusterTag, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/${clusterTag}/dependencies/status`);
      if (!response.ok) throw new Error('Failed to check dependencies');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：配置依赖
export const configureDependencies = createAsyncThunk(
  'clusters/configureDependencies',
  async (clusterTag, { rejectWithValue, dispatch }) => {
    try {
      const response = await fetch('/api/cluster/configure-dependencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterTag }),
      });

      if (!response.ok) throw new Error('Failed to configure dependencies');

      // 配置后重新检查状态
      dispatch(checkDependenciesStatus(clusterTag));

      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const clustersSlice = createSlice({
  name: 'clusters',
  initialState: {
    list: [],
    activeCluster: null,
    clusterDetails: null,
    dependencies: {
      configured: false,
      components: {
        helmDependencies: false,
        nlbController: false,
        s3CsiDriver: false,
        kuberayOperator: false,
        certManager: false
      }
    },
    creatingClusters: {},
    loading: false,
    error: null,
    configuring: false
  },
  reducers: {
    // 直接更新创建中集群的状态
    updateCreatingClusterStatus(state, action) {
      const { clusterTag, status } = action.payload;
      if (state.creatingClusters[clusterTag]) {
        state.creatingClusters[clusterTag].status = status;
      }
    },
  },
  extraReducers: (builder) => {
    // 处理获取集群列表
    builder
      .addCase(fetchClusters.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchClusters.fulfilled, (state, action) => {
        state.list = action.payload;
        state.loading = false;
      })
      .addCase(fetchClusters.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理切换活跃集群
      .addCase(switchCluster.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(switchCluster.fulfilled, (state, action) => {
        state.activeCluster = action.meta.arg; // clusterTag
        state.clusterDetails = action.payload;
        state.loading = false;
      })
      .addCase(switchCluster.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理依赖状态检查
      .addCase(checkDependenciesStatus.fulfilled, (state, action) => {
        state.dependencies = action.payload;
      })

    // 处理依赖配置
      .addCase(configureDependencies.pending, (state) => {
        state.configuring = true;
      })
      .addCase(configureDependencies.fulfilled, (state) => {
        state.configuring = false;
      })
      .addCase(configureDependencies.rejected, (state, action) => {
        state.configuring = false;
        state.error = action.payload;
      });
  },
});

export const { updateCreatingClusterStatus } = clustersSlice.actions;
export default clustersSlice.reducer;