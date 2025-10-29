import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取 Pods 状态 (使用V2 API)
export const fetchPods = createAsyncThunk(
  'appStatus/fetchPods',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching pods status via Redux V2...');
      const response = await fetch('/api/v2/app-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Pods V2 status response:', data);

      return {
        pods: data.rawPods || data.pods || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching pods V2:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 Services 状态 (使用V2 API)
export const fetchServices = createAsyncThunk(
  'appStatus/fetchServices',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching services status via Redux V2...');
      const response = await fetch('/api/v2/app-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Services V2 status response:', data);

      return {
        services: data.rawServices || data.services || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching services V2:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取 RayJobs 状态
export const fetchRayJobs = createAsyncThunk(
  'appStatus/fetchRayJobs',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching RayJobs status via Redux...');
      const response = await fetch('/api/ray-jobs');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('RayJobs status response:', data);

      return {
        rayJobs: data.items || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching RayJobs:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：获取业务服务状态
export const fetchBindingServices = createAsyncThunk(
  'appStatus/fetchBindingServices',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching binding services status via Redux...');
      const response = await fetch('/api/binding-services');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('Business services status response:', data);

      return {
        bindingServices: data || [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching business services:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 新增：使用V2 API的优化组合获取
export const fetchAppStatusV2 = createAsyncThunk(
  'appStatus/fetchAppStatusV2',
  async (_, { rejectWithValue }) => {
    try {
      console.log('Fetching app status via V2 API...');
      const response = await fetch('/api/v2/app-status');

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('App Status V2 response:', data);

      return {
        pods: data.rawPods || data.pods || [],
        services: data.rawServices || data.services || [],
        timestamp: new Date().toISOString(),
        stats: data.stats || null,
        fetchTime: data.fetchTime || null,
        version: 'v2'
      };
    } catch (error) {
      console.error('Error fetching app status V2:', error);
      return rejectWithValue(error.message);
    }
  }
);

// 组合操作：刷新所有应用状态 (优化版本)
export const refreshAllAppStatus = createAsyncThunk(
  'appStatus/refreshAllAppStatus',
  async (_, { dispatch, rejectWithValue }) => {
    try {
      // 使用V2 API获取pods和services，其他资源单独获取
      const results = await Promise.allSettled([
        dispatch(fetchAppStatusV2()).unwrap(),
        dispatch(fetchRayJobs()).unwrap(),
        dispatch(fetchBindingServices()).unwrap()
      ]);

      const errors = [];
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const operations = ['App Status V2', 'RayJobs', 'Business Services'];
          errors.push(`${operations[index]}: ${result.reason}`);
        }
      });

      if (errors.length > 0) {
        console.warn('Some app status operations failed:', errors);
      }

      return {
        success: true,
        timestamp: new Date().toISOString(),
        errors: errors.length > 0 ? errors : null
      };
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const appStatusSlice = createSlice({
  name: 'appStatus',
  initialState: {
    // 各类应用数据
    pods: [],
    services: [],
    rayJobs: [],
    bindingServices: [],

    // 加载状态管理
    loading: false,
    podsLoading: false,
    servicesLoading: false,
    rayJobsLoading: false,
    bindingServicesLoading: false,

    // 错误状态管理
    error: null,
    podsError: null,
    servicesError: null,
    rayJobsError: null,
    bindingServicesError: null,

    // 时间戳记录
    lastUpdate: null,
    lastPodsUpdate: null,
    lastServicesUpdate: null,
    lastRayJobsUpdate: null,
    lastBindingServicesUpdate: null,

    // 统计信息
    stats: {
      totalPods: 0,
      runningPods: 0,
      pendingPods: 0,
      failedPods: 0,
      totalServices: 0,
      activeServices: 0,
      totalRayJobs: 0,
      runningRayJobs: 0,
      completedRayJobs: 0,
      failedRayJobs: 0,
      totalBindingServices: 0,
      healthyBindingServices: 0
    }
  },
  reducers: {
    // 清除错误状态
    clearError: (state) => {
      state.error = null;
      state.podsError = null;
      state.servicesError = null;
      state.rayJobsError = null;
      state.bindingServicesError = null;
    },

    // 更新单个 Pod 状态（用于 WebSocket 实时更新）
    updatePodStatus: (state, action) => {
      const { podName, status } = action.payload;
      const podIndex = state.pods.findIndex(pod => pod.metadata?.name === podName);

      if (podIndex !== -1) {
        state.pods[podIndex] = { ...state.pods[podIndex], ...status };
        state.lastPodsUpdate = new Date().toISOString();
        // 触发统计更新
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新单个 Service 状态
    updateServiceStatus: (state, action) => {
      const { serviceName, status } = action.payload;
      const serviceIndex = state.services.findIndex(service => service.metadata?.name === serviceName);

      if (serviceIndex !== -1) {
        state.services[serviceIndex] = { ...state.services[serviceIndex], ...status };
        state.lastServicesUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新单个 RayJob 状态
    updateRayJobStatus: (state, action) => {
      const { jobName, status } = action.payload;
      const jobIndex = state.rayJobs.findIndex(job => job.metadata?.name === jobName);

      if (jobIndex !== -1) {
        state.rayJobs[jobIndex] = { ...state.rayJobs[jobIndex], ...status };
        state.lastRayJobsUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 更新业务服务状态
    updateBusinessServiceStatus: (state, action) => {
      const { serviceName, status } = action.payload;
      const serviceIndex = state.bindingServices.findIndex(service => service.name === serviceName);

      if (serviceIndex !== -1) {
        state.bindingServices[serviceIndex] = { ...state.bindingServices[serviceIndex], ...status };
        state.lastBindingServicesUpdate = new Date().toISOString();
        appStatusSlice.caseReducers.updateStats(state);
      }
    },

    // 计算并更新统计信息
    updateStats: (state) => {
      // Pods 统计
      const podStats = state.pods.reduce((acc, pod) => {
        const phase = pod.status?.phase;
        return {
          totalPods: acc.totalPods + 1,
          runningPods: acc.runningPods + (phase === 'Running' ? 1 : 0),
          pendingPods: acc.pendingPods + (phase === 'Pending' ? 1 : 0),
          failedPods: acc.failedPods + (phase === 'Failed' ? 1 : 0)
        };
      }, {
        totalPods: 0,
        runningPods: 0,
        pendingPods: 0,
        failedPods: 0
      });

      // Services 统计
      const serviceStats = {
        totalServices: state.services.length,
        activeServices: state.services.filter(service =>
          service.spec?.type && service.status?.loadBalancer
        ).length
      };

      // RayJobs 统计
      const rayJobStats = state.rayJobs.reduce((acc, job) => {
        const jobStatus = job.status?.jobStatus;
        return {
          totalRayJobs: acc.totalRayJobs + 1,
          runningRayJobs: acc.runningRayJobs + (jobStatus === 'RUNNING' ? 1 : 0),
          completedRayJobs: acc.completedRayJobs + (jobStatus === 'SUCCEEDED' ? 1 : 0),
          failedRayJobs: acc.failedRayJobs + (jobStatus === 'FAILED' ? 1 : 0)
        };
      }, {
        totalRayJobs: 0,
        runningRayJobs: 0,
        completedRayJobs: 0,
        failedRayJobs: 0
      });

      // 业务服务统计
      const businessServiceStats = {
        totalBindingServices: state.bindingServices.length,
        healthyBindingServices: state.bindingServices.filter(service =>
          service.status === 'healthy' || service.health === 'ok'
        ).length
      };

      state.stats = {
        ...podStats,
        ...serviceStats,
        ...rayJobStats,
        ...businessServiceStats
      };
    }
  },
  extraReducers: (builder) => {
    // 处理V2 API组合获取
    builder
      .addCase(fetchAppStatusV2.pending, (state) => {
        state.podsLoading = true;
        state.servicesLoading = true;
        state.podsError = null;
        state.servicesError = null;
      })
      .addCase(fetchAppStatusV2.fulfilled, (state, action) => {
        state.podsLoading = false;
        state.servicesLoading = false;
        state.pods = action.payload.pods;
        state.services = action.payload.services;
        state.lastPodsUpdate = action.payload.timestamp;
        state.lastServicesUpdate = action.payload.timestamp;

        console.log('Redux: Updated pods and services from V2 API:', {
          podsCount: state.pods.length,
          servicesCount: state.services.length
        });

        // 自动更新统计信息
        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchAppStatusV2.rejected, (state, action) => {
        state.podsLoading = false;
        state.servicesLoading = false;
        state.podsError = action.payload;
        state.servicesError = action.payload;
      })

    // 处理获取 Pods (保留向后兼容)
      .addCase(fetchPods.pending, (state) => {
        state.podsLoading = true;
        state.podsError = null;
      })
      .addCase(fetchPods.fulfilled, (state, action) => {
        state.podsLoading = false;
        state.pods = action.payload.pods;
        state.lastPodsUpdate = action.payload.timestamp;

        // 自动更新统计信息
        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchPods.rejected, (state, action) => {
        state.podsLoading = false;
        state.podsError = action.payload;
      })

    // 处理获取 Services (保留向后兼容)
      .addCase(fetchServices.pending, (state) => {
        state.servicesLoading = true;
        state.servicesError = null;
      })
      .addCase(fetchServices.fulfilled, (state, action) => {
        state.servicesLoading = false;
        state.services = action.payload.services;
        state.lastServicesUpdate = action.payload.timestamp;

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchServices.rejected, (state, action) => {
        state.servicesLoading = false;
        state.servicesError = action.payload;
      })

    // 处理获取 RayJobs
      .addCase(fetchRayJobs.pending, (state) => {
        state.rayJobsLoading = true;
        state.rayJobsError = null;
      })
      .addCase(fetchRayJobs.fulfilled, (state, action) => {
        state.rayJobsLoading = false;
        state.rayJobs = action.payload.rayJobs;
        state.lastRayJobsUpdate = action.payload.timestamp;

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchRayJobs.rejected, (state, action) => {
        state.rayJobsLoading = false;
        state.rayJobsError = action.payload;
      })

    // 处理获取业务服务
      .addCase(fetchBindingServices.pending, (state) => {
        state.bindingServicesLoading = true;
        state.bindingServicesError = null;
      })
      .addCase(fetchBindingServices.fulfilled, (state, action) => {
        state.bindingServicesLoading = false;
        state.bindingServices = action.payload.bindingServices;
        state.lastBindingServicesUpdate = action.payload.timestamp;

        appStatusSlice.caseReducers.updateStats(state);
      })
      .addCase(fetchBindingServices.rejected, (state, action) => {
        state.bindingServicesLoading = false;
        state.bindingServicesError = action.payload;
      })

    // 处理组合刷新操作
      .addCase(refreshAllAppStatus.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(refreshAllAppStatus.fulfilled, (state, action) => {
        state.loading = false;
        state.lastUpdate = action.payload.timestamp;

        if (action.payload.errors) {
          console.warn('Some app status refresh operations had errors:', action.payload.errors);
        }
      })
      .addCase(refreshAllAppStatus.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      });
  }
});

export const {
  clearError,
  updatePodStatus,
  updateServiceStatus,
  updateRayJobStatus,
  updateBusinessServiceStatus,
  updateStats
} = appStatusSlice.actions;

export default appStatusSlice.reducer;