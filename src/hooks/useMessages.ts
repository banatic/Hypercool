import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Message, MessageMeta, SearchResultItem } from '../types';

const REG_KEY_CLASSIFIED = 'ClassifiedMap';

// Performance logging helper
const logPerf = (label: string, startTime?: number) => {
    const now = performance.now();
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    if (startTime !== undefined) {
        console.log(`[PERF ${timestamp}] ${label}: ${(now - startTime).toFixed(1)}ms`);
    } else {
        console.log(`[PERF ${timestamp}] ${label}`);
    }
    return now;
};

interface SyncStats {
    new_messages: number;
    updated_messages: number;
    total_messages: number;
    duration_ms: number;
}

// Backend response types
interface CachedMessageResponse {
    id: number;
    sender: string;
    content: string;
    content_preview: string;
    receive_date: string | null;
    file_paths: string[];
}

export function useMessages(udbPath: string) {
    // Use MessageMeta for list (lightweight, preview only)
    const [allMessages, setAllMessages] = useState<MessageMeta[]>([]);
    const [totalMessageCount, setTotalMessageCount] = useState(0);
    const [classified, setClassified] = useState<Record<number, 'left' | 'right'>>({});
    const [isLoading, setIsLoading] = useState(false);

    // Content cache - NOT in React state to avoid re-renders
    const contentCacheRef = useRef<Map<number, string>>(new Map());

    // Search state
    const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
    const [activeSearchMessage, setActiveSearchMessage] = useState<Message | null>(null);
    const [isLoadingSearch, setIsLoadingSearch] = useState(false);
    const [isLoadingActiveSearch, setIsLoadingActiveSearch] = useState(false);

    // Search DB sync state
    const [isSyncingSearch, setIsSyncingSearch] = useState(false);
    const [lastSyncStats, setLastSyncStats] = useState<SyncStats | null>(null);

    // Load classified map
    useEffect(() => {
        invoke<string | null>('get_registry_value', { key: REG_KEY_CLASSIFIED })
            .then(savedMap => {
                if (savedMap) setClassified(JSON.parse(savedMap) || {});
            })
            .catch(console.warn);
    }, []);

    const saveClassified = useCallback(async (newClassified: Record<number, 'left' | 'right'>) => {
        setClassified(newClassified);
        try {
            await invoke('set_registry_value', {
                key: REG_KEY_CLASSIFIED,
                value: JSON.stringify(newClassified)
            });
        } catch (e) {
            console.warn('Failed to save classified map', e);
        }
    }, []);

    // Sync search database from UDB
    const syncSearchDb = useCallback(async () => {
        if (!udbPath) return;
        setIsSyncingSearch(true);
        try {
            const stats = await invoke<SyncStats>('sync_search_db', {
                udbPath
            });
            setLastSyncStats(stats);
            console.log(`Search DB synced: ${stats.new_messages} new messages in ${stats.duration_ms}ms`);
        } catch (e) {
            console.error('Search DB sync failed', e);
        } finally {
            setIsSyncingSearch(false);
        }
    }, [udbPath]);

    // Load message list with PREVIEW ONLY (not full content)
    const loadUdbFile = useCallback(async (path?: string, offset: number = 0) => {
        const targetPath = path || udbPath;
        if (!targetPath) return;

        const t0 = logPerf('loadUdbFile START');
        setIsLoading(true);
        try {
            const cacheReady = await invoke<boolean>('is_cache_ready').catch(() => false);

            if (cacheReady) {
                const windowSize = 100; // Can load more since we're only getting previews
                const t2 = logPerf(`read_cached_messages START (offset=${offset})`);
                const result = await invoke<{ messages: CachedMessageResponse[], total_count: number }>('read_cached_messages', {
                    limit: windowSize,
                    offset: offset
                });
                logPerf('read_cached_messages DONE', t2);

                // Only use preview, NOT full content - THIS IS THE KEY OPTIMIZATION
                const t3 = logPerf('map to MessageMeta START');
                const metas: MessageMeta[] = result.messages.map(m => ({
                    id: m.id,
                    sender: m.sender,
                    preview: m.content_preview || m.content.slice(0, 200), // Use preview, fallback to truncated content
                    receive_date: m.receive_date,
                    file_paths: m.file_paths
                }));
                logPerf(`map to MessageMeta DONE (${metas.length} items)`, t3);

                setTotalMessageCount(result.total_count);

                if (offset === 0) {
                    setAllMessages(metas);
                } else {
                    setAllMessages(prev => [...prev, ...metas]);
                }
            } else {
                // Fallback to UDB if cache not ready
                const t2 = logPerf('read_udb_messages START (SLOW PATH)');
                const result = await invoke<{ messages: Message[], total_count: number }>('read_udb_messages', {
                    dbPath: targetPath,
                    limit: 100,
                    offset: offset
                });
                logPerf('read_udb_messages DONE', t2);

                // Convert to MessageMeta with truncated preview
                const metas: MessageMeta[] = result.messages.map(m => ({
                    id: m.id,
                    sender: m.sender,
                    preview: m.content.slice(0, 200),
                    receive_date: m.receive_date,
                    file_paths: m.file_paths
                }));

                setTotalMessageCount(result.total_count);

                if (offset === 0) {
                    setAllMessages(metas);
                } else {
                    setAllMessages(prev => [...prev, ...metas]);
                }
            }
        } catch (e) {
            console.error('Failed to load messages', e);
        } finally {
            setIsLoading(false);
            logPerf('loadUdbFile COMPLETE', t0);
        }
    }, [udbPath]);

    // Initial sync and load
    useEffect(() => {
        if (udbPath) {
            const initializeMessages = async () => {
                const t0 = logPerf('=== INIT START ===');

                // 1. Sync cache DB first
                setIsSyncingSearch(true);
                try {
                    const t1 = logPerf('sync_search_db START');
                    const stats = await invoke<SyncStats>('sync_search_db', { udbPath });
                    setLastSyncStats(stats);
                    logPerf(`sync_search_db DONE (${stats.total_messages} msgs)`, t1);
                } catch (e) {
                    console.error('[Cache] Sync failed:', e);
                } finally {
                    setIsSyncingSearch(false);
                }

                // 2. Then load messages from cache (now populated)
                await loadUdbFile(udbPath, 0);
                logPerf('=== INIT COMPLETE ===', t0);
            };

            initializeMessages();
        }
    }, [udbPath]); // Intentionally exclude loadUdbFile to avoid infinite loop

    const searchMessages = useCallback(async (term: string) => {
        if (!udbPath || !term) return;
        const t0 = logPerf('searchMessages START');
        setIsLoadingSearch(true);
        try {
            const results = await invoke<SearchResultItem[]>('search_messages', {
                dbPath: udbPath,
                searchTerm: term
            });
            setSearchResults(results);
            logPerf(`searchMessages DONE (${results.length} results)`, t0);
        } catch (e) {
            console.error('Search failed', e);
        } finally {
            setIsLoadingSearch(false);
        }
    }, [udbPath]);

    // Load full message content by ID (on-demand)
    // NOTE: Always fetch from backend (2ms) to avoid O(n) search in allMessages
    const loadMessageById = useCallback(async (id: number) => {
        if (!udbPath) return;

        const t0 = logPerf(`loadMessageById START (id=${id})`);
        setIsLoadingActiveSearch(true);
        try {
            const message = await invoke<Message>('get_message_by_id', {
                dbPath: udbPath,
                id
            });

            // Cache the content for future use
            contentCacheRef.current.set(id, message.content);

            setActiveSearchMessage(message);
            logPerf('loadMessageById DONE', t0);
        } catch (e) {
            console.error('Failed to load message', e);
        } finally {
            setIsLoadingActiveSearch(false);
        }
    }, [udbPath]);  // NO allMessages dependency!

    // Get full message by ID (for components that need full content)
    // NOTE: Always fetch from backend (2ms) to avoid O(n) search in allMessages
    const getFullMessage = useCallback(async (id: number): Promise<Message | null> => {
        try {
            const message = await invoke<Message>('get_message_by_id', {
                dbPath: udbPath,
                id
            });
            contentCacheRef.current.set(id, message.content);
            return message;
        } catch (e) {
            console.error('Failed to get message', e);
            return null;
        }
    }, [udbPath]);  // NO allMessages dependency!

    return {
        allMessages,       // Now MessageMeta[] (lightweight)
        totalMessageCount, // Total count for pagination
        classified,
        saveClassified,
        isLoading,
        loadUdbFile,
        searchResults,
        setSearchResults,
        activeSearchMessage,
        setActiveSearchMessage,
        searchMessages,
        loadMessageById,
        getFullMessage,    // New: get full content on demand
        isLoadingSearch,
        isLoadingActiveSearch,
        // Search DB sync
        syncSearchDb,
        isSyncingSearch,
        lastSyncStats
    };
}
