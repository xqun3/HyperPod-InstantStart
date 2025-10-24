import { configureStore } from '@reduxjs/toolkit';
import trainingReducer, {
  fetchTrainingHistory,
  fetchTrainingJobs,
  launchTorchTraining,
  launchLlamaFactoryTraining,
  launchScriptTraining,
  launchVerlTraining,
  deleteTrainingJob,
  setActiveJob,
  updateTrainingStatus,
  clearTrainingStatus,
  updateJobLogs,
  clearMlflowStatus
} from '../trainingSlice';

// Mock fetch
global.fetch = jest.fn();

// Helper function to create a mock store
const createMockStore = () => {
  return configureStore({
    reducer: {
      training: trainingReducer
    }
  });
};

// Reset mocks before each test
beforeEach(() => {
  fetch.mockClear();
});

describe('trainingSlice reducers', () => {
  it('should handle setActiveJob', () => {
    const initialState = {
      activeJob: null
    };

    const nextState = trainingReducer(initialState, setActiveJob('job-1'));

    expect(nextState.activeJob).toBe('job-1');
  });

  it('should handle updateTrainingStatus', () => {
    const initialState = {
      jobs: [
        { name: 'job-1', status: 'Pending' }
      ]
    };

    const nextState = trainingReducer(initialState, updateTrainingStatus({
      jobName: 'job-1',
      status: 'Running'
    }));

    expect(nextState.jobs[0].status).toBe('Running');
  });

  it('should handle clearTrainingStatus', () => {
    const initialState = {
      trainingStatus: 'launching',
      deleteStatus: 'deleting'
    };

    const nextState = trainingReducer(initialState, clearTrainingStatus());

    expect(nextState.trainingStatus).toBeNull();
    expect(nextState.deleteStatus).toBeNull();
  });

  it('should handle updateJobLogs', () => {
    const initialState = {
      jobLogs: {
        'job-1': [
          { timestamp: '2023-01-01T00:00:00Z', message: 'log 1' }
        ]
      }
    };

    const newLogs = [
      { timestamp: '2023-01-01T00:01:00Z', message: 'log 2' }
    ];

    const nextState = trainingReducer(initialState, updateJobLogs({
      jobName: 'job-1',
      logs: newLogs
    }));

    expect(nextState.jobLogs['job-1'].length).toBe(2);
    expect(nextState.jobLogs['job-1'][1]).toEqual(newLogs[0]);
  });
});

describe('trainingSlice async thunks', () => {
  it('should handle fetchTrainingJobs.fulfilled', async () => {
    const mockJobs = [{ name: 'job-1' }];
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, jobs: mockJobs })
    });

    const store = createMockStore();
    await store.dispatch(fetchTrainingJobs());

    expect(store.getState().training.jobs).toEqual(mockJobs);
    expect(store.getState().training.loading).toBe(false);
    expect(store.getState().training.error).toBeNull();
  });

  it('should handle fetchTrainingHistory.fulfilled', async () => {
    const mockHistory = [{ id: 1, name: 'history-1' }];
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockHistory
    });

    const store = createMockStore();
    await store.dispatch(fetchTrainingHistory());

    expect(store.getState().training.history).toEqual(mockHistory);
    expect(store.getState().training.loading).toBe(false);
    expect(store.getState().training.error).toBeNull();
  });

  it('should handle launchTorchTraining.fulfilled', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    const store = createMockStore();
    await store.dispatch(launchTorchTraining({ jobName: 'job-1' }));

    expect(store.getState().training.trainingStatus).toBe('launched');
    expect(store.getState().training.error).toBeNull();
  });

  it('should handle deleteTrainingJob.fulfilled', async () => {
    const initialState = {
      jobs: [{ name: 'job-1' }],
      jobLogs: { 'job-1': ['log 1'] }
    };

    const store = configureStore({
      reducer: {
        training: trainingReducer
      },
      preloadedState: {
        training: initialState
      }
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true })
    });

    await store.dispatch(deleteTrainingJob('job-1'));

    expect(store.getState().training.deleteStatus).toBe('deleted');
    expect(store.getState().training.jobs).toEqual([]);
    expect(store.getState().training.jobLogs['job-1']).toBeUndefined();
    expect(store.getState().training.error).toBeNull();
  });
});