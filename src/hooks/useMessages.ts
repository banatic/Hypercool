import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Message, SearchResultItem } from '../types';

const REG_KEY_CLASSIFIED = 'ClassifiedMap';

export function useMessages(udbPath: string) {
    const [allMessages, setAllMessages] = useState<Message[]>([]);
    const [classified, setClassified] = useState<Record<number, 'left' | 'right'>>({});
    const [isLoading, setIsLoading] = useState(false);

    // Search state
    const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
    const [activeSearchMessage, setActiveSearchMessage] = useState<Message | null>(null);
    const [isLoadingSearch, setIsLoadingSearch] = useState(false);
    const [isLoadingActiveSearch, setIsLoadingActiveSearch] = useState(false);

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

    const loadUdbFile = useCallback(async (path?: string, offset: number = 0) => {
        const targetPath = path || udbPath;
        if (!targetPath) return;

        setIsLoading(true);
        try {
            const result = await invoke<{ messages: Message[], total_count: number }>('read_udb_messages', {
                dbPath: targetPath,
                limit: 100,
                offset: offset
            });

            if (offset === 0) {
                setAllMessages(result.messages);
            } else {
                setAllMessages(prev => [...prev, ...result.messages]);
            }
        } catch (e) {
            console.error('Failed to load UDB file', e);
        } finally {
            setIsLoading(false);
        }
    }, [udbPath]);

    // Initial load
    useEffect(() => {
        if (udbPath) {
            loadUdbFile(udbPath, 0);
        }
    }, [udbPath, loadUdbFile]);

    const searchMessages = useCallback(async (term: string) => {
        if (!udbPath || !term) return;
        setIsLoadingSearch(true);
        try {
            const results = await invoke<SearchResultItem[]>('search_messages', {
                dbPath: udbPath,
                searchTerm: term
            });
            setSearchResults(results);
        } catch (e) {
            console.error('Search failed', e);
        } finally {
            setIsLoadingSearch(false);
        }
    }, [udbPath]);

    const loadMessageById = useCallback(async (id: number) => {
        if (!udbPath) return;
        setIsLoadingActiveSearch(true);
        try {
            const message = await invoke<Message>('get_message_by_id', {
                dbPath: udbPath,
                id
            });
            setActiveSearchMessage(message);
        } catch (e) {
            console.error('Failed to load message', e);
        } finally {
            setIsLoadingActiveSearch(false);
        }
    }, [udbPath]);

    return {
        allMessages,
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
        isLoadingSearch,
        isLoadingActiveSearch
    };
}
