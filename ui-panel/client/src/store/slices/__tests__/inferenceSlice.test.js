import { configureStore } from '@reduxjs/toolkit';
import inferenceReducer, {
  fetchDeployments,
  deployModel,
  deployService,
  undeployModel,
  scaleDeployment,
  updateDeploymentStatus,
  clearDeployStatus,
  clearTestResults
} from '../inferenceSlice';

// Mock fetch
global.fetch = jest.fn();

// Helper function to create a mock store
const createMockStore = () => {
  return configureStore({
    reducer: {
      inference: inferenceReducer
    }
  });
};

// Reset mocks before each test
beforeEach(() => {
  fetch.mockClear();
});

describe('inferenceSlice reducers', () => {
  it('should handle updateDeploymentStatus', () => {
    const initialState = {
      deployments: [
        { name: 'model-1', status: 'Pending' }
      ]
    };

    const nextState = inferenceReducer(initialState, updateDeploymentStatus({
      name: 'model-1',
      status: 'Running'
    }));

    expect(nextState.deployments[0].status).toBe('Running');
  });

  it('should handle clearDeployStatus', () => {
    const initialState = {
      deployStatus: 'deploying',
      undeployStatus: 'undeploying',
      scaleStatus: 'scaling',
      serviceStatus: 'deploying'
    };

    const nextState = inferenceReducer(initialState, clearDeployStatus());

    expect(nextState.deployStatus).toBeNull();
    expect(nextState.undeployStatus).toBeNull();
    expect(nextState.scaleStatus).toBeNull();
    expect(nextState.serviceStatus).toBeNull();
  });

  it('should handle clearTestResults', () => {
    const initialState = {
      testResults: { result: 'test-result' },
      testError: 'test-error'
    };

    const nextState = inferenceReducer(initialState, clearTestResults());

    expect(nextState.testResults).toBeNull();
    expect(nextState.testError).toBeNull();
  });
});

describe('inferenceSlice async thunks', () => {
  it('should handle fetchDeployments.fulfilled', async () => {
    const mockDeployments = [
      { name: 'model-1', isService: false },
      { name: 'service-1', isService: true }
    ];
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockDeployments
    });

    const store = createMockStore();
    await store.dispatch(fetchDeployments());

    expect(store.getState().inference.deployments).toEqual([mockDeployments[0]]);
    expect(store.getState().inference.services).toEqual([mockDeployments[1]]);
    expect(store.getState().inference.loading).toBe(false);
    expect(store.getState().inference.error).toBeNull();
  });

  it('should handle deployModel.fulfilled', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    const store = createMockStore();
    await store.dispatch(deployModel({ modelTag: 'model-1' }));

    expect(store.getState().inference.deployStatus).toBe('deployed');
    expect(store.getState().inference.error).toBeNull();
  });

  it('should handle undeployModel.fulfilled', async () => {
    const initialState = {
      deployments: [{ name: 'model-1' }],
      services: [{ name: 'service-1' }]
    };

    const store = configureStore({
      reducer: {
        inference: inferenceReducer
      },
      preloadedState: {
        inference: initialState
      }
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    await store.dispatch(undeployModel('model-1'));

    expect(store.getState().inference.undeployStatus).toBe('undeployed');
    expect(store.getState().inference.deployments).toEqual([]);
    expect(store.getState().inference.services).toEqual([{ name: 'service-1' }]);
    expect(store.getState().inference.error).toBeNull();
  });
});