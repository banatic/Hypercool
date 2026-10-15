import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useMessages } from './useMessages';
import * as firestore from 'firebase/firestore';

const { mockUseData } = vi.hoisted(() => ({ mockUseData: vi.fn() }));

vi.mock('firebase/firestore', () => ({
    collection: vi.fn(),
    query: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    getDocs: vi.fn(),
    startAfter: vi.fn(),
}));

vi.mock('../firebase', () => ({
    auth: { currentUser: { uid: 'test-uid' } },
    db: {},
}));

vi.mock('../context/DataStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../context/DataStore')>();
    return { ...actual, useData: mockUseData };
});

const msg = (id: number) => ({ id, sender: `s${id}`, content: `Message ${id}` });
const page = (ids: number[]) => ({ docs: ids.map(id => ({ data: () => msg(id) })), empty: ids.length === 0 });

describe('useMessages', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('serves the context messages without an extra query and reports loading', () => {
        mockUseData.mockReturnValue({ recentMessages: [msg(3), msg(2)], loading: false });
        const { result } = renderHook(() => useMessages());
        expect(result.current.loading).toBe(false);
        expect(result.current.messages.map(m => m.id)).toEqual([3, 2]);
        expect(firestore.getDocs).not.toHaveBeenCalled();
    });

    it('has no more pages when the context holds fewer than a full chunk', () => {
        mockUseData.mockReturnValue({ recentMessages: [msg(1)], loading: false });
        const { result } = renderHook(() => useMessages());
        expect(result.current.hasMore).toBe(false);
    });

    it('loads older pages after the last id, de-duplicates, and stops on a short page', async () => {
        const recent = Array.from({ length: 20 }, (_, i) => msg(100 - i)); // 100..81
        mockUseData.mockReturnValue({ recentMessages: recent, loading: false });
        vi.mocked(firestore.getDocs).mockResolvedValueOnce(page([81, 80, 79]) as never);

        const { result } = renderHook(() => useMessages());
        expect(result.current.hasMore).toBe(true);

        await act(async () => {
            await result.current.loadMoreMessages();
        });

        expect(firestore.startAfter).toHaveBeenCalledWith(81);
        await waitFor(() => expect(result.current.messages).toHaveLength(22));
        expect(result.current.messages.slice(-2).map(m => m.id)).toEqual([80, 79]);
        expect(result.current.hasMore).toBe(false);
    });
});
