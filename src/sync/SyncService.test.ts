import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncService } from './SyncService';
import { ScheduleService } from '../services/ScheduleService';
import * as firestore from 'firebase/firestore';

// Mock Firebase
const mockWriteBatch = {
    set: vi.fn(),
    commit: vi.fn().mockResolvedValue(undefined),
};

vi.mock('firebase/firestore', () => ({
    collection: vi.fn(),
    getDocs: vi.fn(),
    doc: vi.fn(),
    writeBatch: vi.fn(() => mockWriteBatch),
    query: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
}));

vi.mock('../firebase', () => ({
    db: {},
    auth: {
        currentUser: { uid: 'test-uid' },
    },
}));

// Mock ScheduleService
vi.mock('../services/ScheduleService', () => ({
    ScheduleService: {
        getSchedules: vi.fn(),
        updateScheduleItem: vi.fn(),
    },
}));

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

describe('SyncService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('syncData', () => {
        it('should sync data correctly', async () => {
            // Setup mocks
            const mockLocalItems = [{ id: 'local1', updatedAt: '2023-01-01T00:00:00Z' }];
            vi.mocked(ScheduleService.getSchedules).mockResolvedValue(mockLocalItems as any);

            vi.mocked(firestore.getDocs).mockResolvedValue({
                docs: [],
                empty: true
            } as any);

            const lastSyncTime = null;
            const result = await SyncService.syncData(lastSyncTime);

            expect(result).toBeDefined();
            expect(ScheduleService.getSchedules).toHaveBeenCalled();
            expect(firestore.getDocs).toHaveBeenCalled();
        });

        it('should push local changes to firestore', async () => {
            // Setup mocks
            const mockLocalItems = [{ id: 'local1', updatedAt: '2023-01-02T00:00:00Z' }];
            vi.mocked(ScheduleService.getSchedules).mockResolvedValue(mockLocalItems as any);

            vi.mocked(firestore.getDocs).mockResolvedValue({
                docs: [],
                empty: true
            } as any);

            const lastSyncTime = '2023-01-01T00:00:00Z';
            await SyncService.syncData(lastSyncTime);

            expect(mockWriteBatch.set).toHaveBeenCalled();
            expect(mockWriteBatch.commit).toHaveBeenCalled();
        });
    });
});
