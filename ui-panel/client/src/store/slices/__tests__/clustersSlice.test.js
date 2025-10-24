import { configureStore } from '@reduxjs/toolkit';
import clustersReducer, {
  fetchClusters,
  switchCluster,
  checkDependenciesStatus,
  configureDependencies,
  updateCreatingClusterStatus,
  clearDependencyStatus
} from '../clustersSlice';

// Mock fetch
global.fetch = jest.fn();

// Helper function to create a mock store
const createMockStore = () => {
  return configureStore({
    reducer: {
      clusters: clustersReducer
    }
  });
};

// Reset mocks before each test
beforeEach(() => {
  fetch.mockClear();
});

describe('clustersSlice reducers', () => {
  it('should handle updateCreatingClusterStatus', () => {
    const initialState = {
      creatingClusters: {
        'test-cluster': { status: 'in-progress' }
      }
    };

    const nextState = clustersReducer(initialState, updateCreatingClusterStatus({
      clusterTag: 'test-cluster',
      status: 'completed'
    }));

    expect(nextState.creatingClusters['test-cluster'].status).toBe('completed');
  });

  it('should handle clearDependencyStatus', () => {
    const initialState = {
      dependencies: { status: 'configuring' },
      configuring: true
    };

    const nextState = clustersReducer(initialState, clearDependencyStatus());

    expect(nextState.dependencies.status).toBeNull();
    expect(nextState.configuring).toBe(false);
  });
});

describe('clustersSlice async thunks', () => {
  it('should handle fetchClusters.fulfilled', async () => {
    const mockClusters = [{ clusterTag: 'test-cluster' }];
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, clusters: mockClusters })
    });

    const store = createMockStore();
    await store.dispatch(fetchClusters());

    expect(store.getState().clusters.list).toEqual(mockClusters);
    expect(store.getState().clusters.loading).toBe(false);
    expect(store.getState().clusters.error).toBeNull();
  });

  it('should handle fetchClusters.rejected', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ success: false, error: 'Failed to fetch clusters' })
    });

    const store = createMockStore();
    await store.dispatch(fetchClusters());

    expect(store.getState().clusters.list).toEqual([]);
    expect(store.getState().clusters.loading).toBe(false);
    expect(store.getState().clusters.error).toBe('Failed to fetch clusters');
  });

  it('should handle switchCluster.fulfilled', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    const store = createMockStore();
    await store.dispatch(switchCluster('test-cluster'));

    expect(store.getState().clusters.activeCluster).toBe('test-cluster');
    expect(store.getState().clusters.switching).toBe(false);
    expect(store.getState().clusters.error).toBeNull();
  });
});