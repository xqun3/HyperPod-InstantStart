import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';

// 异步操作：获取节点组
export const fetchNodeGroups = createAsyncThunk(
  'nodeGroups/fetchNodeGroups',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/nodegroups');
      if (!response.ok) throw new Error('Failed to fetch node groups');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：创建 HyperPod 集群
export const createHyperPod = createAsyncThunk(
  'nodeGroups/createHyperPod',
  async (formData, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/create-hyperpod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) throw new Error('Failed to create HyperPod');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：删除 HyperPod 集群
export const deleteHyperPod = createAsyncThunk(
  'nodeGroups/deleteHyperPod',
  async (clusterTag, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/${clusterTag}/hyperpod`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error('Failed to delete HyperPod');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：添加实例组
export const addInstanceGroup = createAsyncThunk(
  'nodeGroups/addInstanceGroup',
  async (userConfig, { rejectWithValue }) => {
    try {
      const response = await fetch('/api/cluster/hyperpod/add-instance-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userConfig }),
      });

      if (!response.ok) throw new Error('Failed to add instance group');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：扩展节点组
export const scaleNodeGroup = createAsyncThunk(
  'nodeGroups/scaleNodeGroup',
  async ({ name, count }, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/nodegroups/${name}/scale`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desiredSize: count }),
      });

      if (!response.ok) throw new Error('Failed to scale node group');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// 异步操作：删除节点组
export const deleteNodeGroup = createAsyncThunk(
  'nodeGroups/deleteNodeGroup',
  async (nodeGroupName, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/cluster/nodegroup/${nodeGroupName}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error('Failed to delete node group');
      return await response.json();
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const nodeGroupsSlice = createSlice({
  name: 'nodeGroups',
  initialState: {
    eksNodeGroups: [],
    hyperPodGroups: [],
    loading: false,
    error: null,
    hyperPodCreationStatus: null,
    hyperPodDeletionStatus: null,
    instanceGroupAdditionStatus: null,
    nodeGroupDeletionStatus: null,
    nodeGroupScalingStatus: null,
  },
  reducers: {
    clearHyperPodCreationStatus(state) {
      state.hyperPodCreationStatus = null;
    },
    setHyperPodCreationStatus(state, action) {
      state.hyperPodCreationStatus = action.payload;
    },
    setHyperPodDeletionStatus(state, action) {
      state.hyperPodDeletionStatus = action.payload;
    },
    clearNodeGroupOperationStatus(state) {
      state.nodeGroupDeletionStatus = null;
      state.nodeGroupScalingStatus = null;
      state.instanceGroupAdditionStatus = null;
    },
  },
  extraReducers: (builder) => {
    // 处理获取节点组
    builder
      .addCase(fetchNodeGroups.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchNodeGroups.fulfilled, (state, action) => {
        const { eksNodeGroups, hyperPodGroups } = action.payload;
        state.eksNodeGroups = eksNodeGroups || [];
        state.hyperPodGroups = hyperPodGroups || [];
        state.loading = false;
      })
      .addCase(fetchNodeGroups.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload;
      })

    // 处理创建 HyperPod
      .addCase(createHyperPod.pending, (state) => {
        state.hyperPodCreationStatus = 'creating';
        state.error = null;
      })
      .addCase(createHyperPod.fulfilled, (state) => {
        state.hyperPodCreationStatus = 'created';
      })
      .addCase(createHyperPod.rejected, (state, action) => {
        state.hyperPodCreationStatus = 'error';
        state.error = action.payload;
      })

    // 处理删除 HyperPod
      .addCase(deleteHyperPod.pending, (state) => {
        state.hyperPodDeletionStatus = 'deleting';
        state.error = null;
      })
      .addCase(deleteHyperPod.fulfilled, (state) => {
        state.hyperPodDeletionStatus = 'deleted';
        state.hyperPodGroups = [];
      })
      .addCase(deleteHyperPod.rejected, (state, action) => {
        state.hyperPodDeletionStatus = 'error';
        state.error = action.payload;
      })

    // 处理添加实例组
      .addCase(addInstanceGroup.pending, (state) => {
        state.instanceGroupAdditionStatus = 'adding';
        state.error = null;
      })
      .addCase(addInstanceGroup.fulfilled, (state) => {
        state.instanceGroupAdditionStatus = 'added';
      })
      .addCase(addInstanceGroup.rejected, (state, action) => {
        state.instanceGroupAdditionStatus = 'error';
        state.error = action.payload;
      })

    // 处理扩展节点组
      .addCase(scaleNodeGroup.pending, (state) => {
        state.nodeGroupScalingStatus = 'scaling';
        state.error = null;
      })
      .addCase(scaleNodeGroup.fulfilled, (state) => {
        state.nodeGroupScalingStatus = 'scaled';
      })
      .addCase(scaleNodeGroup.rejected, (state, action) => {
        state.nodeGroupScalingStatus = 'error';
        state.error = action.payload;
      })

    // 处理删除节点组
      .addCase(deleteNodeGroup.pending, (state) => {
        state.nodeGroupDeletionStatus = 'deleting';
        state.error = null;
      })
      .addCase(deleteNodeGroup.fulfilled, (state) => {
        state.nodeGroupDeletionStatus = 'deleted';
      })
      .addCase(deleteNodeGroup.rejected, (state, action) => {
        state.nodeGroupDeletionStatus = 'error';
        state.error = action.payload;
      });
  },
});

export const {
  clearHyperPodCreationStatus,
  setHyperPodCreationStatus,
  setHyperPodDeletionStatus,
  clearNodeGroupOperationStatus,
} = nodeGroupsSlice.actions;

export default nodeGroupsSlice.reducer;