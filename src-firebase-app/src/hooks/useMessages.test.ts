import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMessages } from './useMessages';
import * as firestore from 'firebase/firestore';

// Hoist the mock function
const { mockUseData } = vi.hoisted(() => {
    return { mockUseData: vi.fn() };
});

// Mock Firebase
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(),
    query: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    getDocs: vi.fn(),
    startAfter: vi.fn(),
}));

vi.mock('../firebase', () => ({
    auth: {
        currentUser: { uid: 'test-uid' },
    },
    db: {},
}));

// Mock DataContext
vi.mock('../context/DataContext', () => ({
    useData: mockUseData,
}));

describe('useMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUseData.mockReturnValue({
            recentMessages: [],
            loading: false,
        });
    });

    it('should load initial messages from firestore', async () => {
        const mockMessages = [
            { id: 1, content: 'Message 1' },
            { id: 2, content: 'Message 2' },
        ];

        vi.mocked(firestore.getDocs).mockResolvedValue({
            docs: mockMessages.map(msg => ({ data: () => msg })),
            empty: false,
        } as any);

        const { result } = renderHook(() => useMessages());

        // Initial state
        expect(result.current.loading).toBe(true);

        await waitFor(() => {
            expect(result.current.loading).toBe(false);
        });

        expect(result.current.messages).toHaveLength(2);
        expect(firestore.getDocs).toHaveBeenCalled();
    });

    it('should use recentMessages from context if available', async () => {
        const mockContextMessages = [{ id: 3, content: 'Context Message' }];
        mockUseData.mockReturnValue({
            recentMessages: mockContextMessages,
            loading: false,
        });

        const { result } = renderHook(() => useMessages());

        await waitFor(() => {
            expect(result.current.loading).toBe(false);
        });

        expect(result.current.messages).toEqual(mockContextMessages);
        expect(firestore.getDocs).not.toHaveBeenCalled();
    });
});
