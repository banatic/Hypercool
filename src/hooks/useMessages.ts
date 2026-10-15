import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Message, MessageMeta, SearchResultItem } from '../types';
import { MessageContentStore } from '../services/MessageContentStore';

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

    const contentStore = useMemo(() => new MessageContentStore(udbPath), [udbPath]);
    const pages = useMemo(() => ({ pending: new Map<number, Promise<void>>(), generation: 0 }), [udbPath]);
    const currentPathRef = useRef(udbPath);
    currentPathRef.current = udbPath;

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
    const loadUdbFile = useCallback((path?: string, offset: number = 0): Promise<void> => {
        const targetPath = path || udbPath;
        if (!targetPath || targetPath !== currentPathRef.current) return Promise.resolve();
        const existing = pages.pending.get(offset);
        if (existing) return existing;
        if (offset === 0) pages.generation++;
        const generation = pages.generation;

        const t0 = logPerf('loadUdbFile START');
        setIsLoading(true);
        const request = (async () => {
        try {
            const cacheReady = await invoke<boolean>('is_cache_ready').catch(() => false);

            if (cacheReady) {
                const windowSize = 100; // Can load more since we're only getting previews
                const t2 = logPerf(`read_cached_messages START (offset=${offset})`);
                const result = await invoke<{ messages: CachedMessageResponse[], total_count: number }>('read_cached_messages', {
                    limit: windowSize,
                    offset: offset,
                    includeContent: false
                });
                if (generation !== pages.generation || targetPath !== currentPathRef.current) return;
                logPerf('read_cached_messages DONE', t2);

                // Use full content (not truncated preview) for better UX
                const t3 = logPerf('map to MessageMeta START');
                const metas: MessageMeta[] = result.messages.map(m => ({
                    id: m.id,
                    sender: m.sender,
                    preview: m.content_preview,
                    receive_date: m.receive_date,
                    file_paths: m.file_paths
                }));
                logPerf(`map to MessageMeta DONE (${metas.length} items)`, t3);

                setTotalMessageCount(result.total_count);

                if (offset === 0) {
                    setAllMessages(metas);
                } else {
                    setAllMessages(prev => {
                        const ids = new Set(prev.map(m => m.id));
                        return [...prev, ...metas.filter(m => !ids.has(m.id) && !!ids.add(m.id))];
                    });
                }
            } else {
                // Fallback to UDB if cache not ready
                const t2 = logPerf('read_udb_messages START (SLOW PATH)');
                const result = await invoke<{ messages: Message[], total_count: number }>('read_udb_messages', {
                    dbPath: targetPath,
                    limit: 100,
                    offset: offset,
                    previewsOnly: true
                });
                if (generation !== pages.generation || targetPath !== currentPathRef.current) return;
                logPerf('read_udb_messages DONE', t2);

                // Convert to MessageMeta with full content
                const metas: MessageMeta[] = result.messages.map(m => ({
                    id: m.id,
                    sender: m.sender,
                    preview: m.content,
                    receive_date: m.receive_date,
                    file_paths: m.file_paths
                }));

                setTotalMessageCount(result.total_count);

                if (offset === 0) {
                    setAllMessages(metas);
                } else {
                    setAllMessages(prev => {
                        const ids = new Set(prev.map(m => m.id));
                        return [...prev, ...metas.filter(m => !ids.has(m.id) && !!ids.add(m.id))];
                    });
                }
            }
        } catch (e) {
            console.error('Failed to load messages', e);
        } finally {
            pages.pending.delete(offset);
            if (targetPath === currentPathRef.current) setIsLoading(pages.pending.size > 0);
            logPerf('loadUdbFile COMPLETE', t0);
        }
        })();
        pages.pending.set(offset, request);
        return request;
    }, [udbPath, pages]);

    // Initial sync and load
    useEffect(() => {
        setAllMessages([]);
        setTotalMessageCount(0);
        setActiveSearchMessage(null);
        setSearchResults(null);
        setIsLoading(false);
        let cancelled = false;
        if (udbPath) {
            const initializeMessages = async () => {
                const t0 = logPerf('=== INIT START ===');

                // 1. Sync cache DB first
                setIsSyncingSearch(true);
                try {
                    const t1 = logPerf('sync_search_db START');
                    const stats = await invoke<SyncStats>('sync_search_db', { udbPath });
                    if (!cancelled) setLastSyncStats(stats);
                    logPerf(`sync_search_db DONE (${stats.total_messages} msgs)`, t1);
                } catch (e) {
                    console.error('[Cache] Sync failed:', e);
                } finally {
                    if (!cancelled) setIsSyncingSearch(false);
                }

                // 2. Then load messages from cache (now populated)
                if (!cancelled) await loadUdbFile(udbPath, 0);
                logPerf('=== INIT COMPLETE ===', t0);
            };

            initializeMessages();
        }
        return () => { cancelled = true; };
    }, [udbPath]); // Intentionally exclude loadUdbFile to avoid infinite loop

    // Stale 응답 가드: 가장 최근에 시작된 검색만 결과를 반영한다
    const searchGenRef = useRef(0);

    const searchMessages = useCallback(async (term: string) => {
        if (!term.trim()) return;
        const gen = ++searchGenRef.current;
        const t0 = logPerf('searchMessages START');
        setIsLoadingSearch(true);
        try {
            const results = await invoke<SearchResultItem[]>('search_messages', {
                searchTerm: term
            });
            if (gen !== searchGenRef.current) return; // 더 최신 검색이 시작됨 — 결과 폐기
            setSearchResults(results);
            logPerf(`searchMessages DONE (${results.length} results)`, t0);
        } catch (e) {
            console.error('Search failed', e);
        } finally {
            if (gen === searchGenRef.current) setIsLoadingSearch(false);
        }
    }, []);

    // 검색 종료: 진행 중인 검색의 늦은 응답도 무시되도록 세대를 올린다
    const clearSearch = useCallback(() => {
        searchGenRef.current++;
        setSearchResults(null);
        setIsLoadingSearch(false);
    }, []);

    const activeMessageGenRef = useRef(0);
    // 동시에 같은 메시지를 요청하면 공유하고, 본문은 제한된 LRU에만 보관한다.
    const loadMessageById = useCallback(async (id: number) => {
        if (!udbPath) return;

        const t0 = logPerf(`loadMessageById START (id=${id})`);
        const generation = ++activeMessageGenRef.current;
        setIsLoadingActiveSearch(true);
        try {
            const message = await contentStore.get(id);
            if (generation !== activeMessageGenRef.current || udbPath !== currentPathRef.current) return;

            setActiveSearchMessage(message);
            logPerf('loadMessageById DONE', t0);
        } catch (e) {
            console.error('Failed to load message', e);
        } finally {
            if (generation === activeMessageGenRef.current && udbPath === currentPathRef.current) setIsLoadingActiveSearch(false);
        }
    }, [udbPath, contentStore]);

    // Get full message by ID (for components that need full content)
    // NOTE: Always fetch from backend (2ms) to avoid O(n) search in allMessages
    const getFullMessage = useCallback(async (id: number): Promise<Message | null> => {
        try {
            return await contentStore.get(id);
        } catch (e) {
            console.error('Failed to get message', e);
            return null;
        }
    }, [contentStore]);

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
        clearSearch,
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
