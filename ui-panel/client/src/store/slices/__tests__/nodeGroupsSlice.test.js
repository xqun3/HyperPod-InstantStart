import { configureStore } from '@reduxjs/toolkit';
import nodeGroupsReducer, {
  fetchNodeGroups,
  createHyperPod,
  deleteHyperPod,
  addInstanceGroup,
  scaleNodeGroup,
  deleteNodeGroup,
  clearHyperPodCreationStatus,
  setHyperPodCreationStatus,
  setHyperPodDeletionStatus,
  clearNodeGroupOperationStatus
} from '../nodeGroupsSlice';

// Mock fetch
global.fetch = jest.fn();

// Helper function to create a mock store
const createMockStore = () => {
  return configureStore({
    reducer: {
      nodeGroups: nodeGroupsReducer
    }
  });
};

// Reset mocks before each test
beforeEach(() => {
  fetch.mockClear();
});

describe('nodeGroupsSlice reducers', () => {
  it('should handle clearHyperPodCreationStatus', () => {
    const initialState = {
      hyperPodCreationStatus: 'creating'
    };

    const nextState = nodeGroupsReducer(initialState, clearHyperPodCreationStatus());

    expect(nextState.hyperPodCreationStatus).toBeNull();
  });

  it('should handle setHyperPodCreationStatus', () => {
    const initialState = {
      hyperPodCreationStatus: null
    };

    const nextState = nodeGroupsReducer(initialState, setHyperPodCreationStatus('completed'));

    expect(nextState.hyperPodCreationStatus).toBe('completed');
  });

  it('should handle setHyperPodDeletionStatus', () => {
    const initialState = {
      hyperPodDeletionStatus: null
    };

    const nextState = nodeGroupsReducer(initialState, setHyperPodDeletionStatus('deleting'));

    expect(nextState.hyperPodDeletionStatus).toBe('deleting');
  });

  it('should handle clearNodeGroupOperationStatus', () => {
    const initialState = {
      nodeGroupDeletionStatus: 'deleting',
      nodeGroupScalingStatus: 'scaling',
      instanceGroupAdditionStatus: 'adding'
    };

    const nextState = nodeGroupsReducer(initialState, clearNodeGroupOperationStatus());

    expect(nextState.nodeGroupDeletionStatus).toBeNull();
    expect(nextState.nodeGroupScalingStatus).toBeNull();
    expect(nextState.instanceGroupAdditionStatus).toBeNull();
  });
});

describe('nodeGroupsSlice async thunks', () => {
  it('should handle fetchNodeGroups.fulfilled', async () => {
    const mockData = {
      eksNodeGroups: [{ name: 'eks-group' }],
      hyperPodGroups: [{ name: 'hyperpod-group' }]
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData
    });

    const store = createMockStore();
    await store.dispatch(fetchNodeGroups());

    expect(store.getState().nodeGroups.eksNodeGroups).toEqual(mockData.eksNodeGroups);
    expect(store.getState().nodeGroups.hyperPodGroups).toEqual(mockData.hyperPodGroups);
    expect(store.getState().nodeGroups.loading).toBe(false);
    expect(store.getState().nodeGroups.error).toBeNull();
  });

  it('should handle createHyperPod.fulfilled', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    const store = createMockStore();
    await store.dispatch(createHyperPod({ userConfig: { clusterTag: 'test-hyperpod' } }));

    expect(store.getState().nodeGroups.hyperPodCreationStatus).toBe('created');
    expect(store.getState().nodeGroups.error).toBeNull();
  });

  it('should handle deleteHyperPod.fulfilled', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    const store = createMockStore();
    await store.dispatch(deleteHyperPod('test-cluster'));

    expect(store.getState().nodeGroups.hyperPodDeletionStatus).toBe('deleted');
    expect(store.getState().nodeGroups.hyperPodGroups).toEqual([]);
    expect(store.getState().nodeGroups.error).toBeNull();
  });
});