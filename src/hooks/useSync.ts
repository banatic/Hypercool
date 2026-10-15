import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SyncService } from '../sync/SyncService';
import { auth } from '../firebase';

const REG_KEY_LAST_SYNC = 'LastSyncTime';

export function useSync(udbPath: string, onSyncComplete?: () => void) {
    const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const lastSyncRef = useRef<string | null>(null);
    const runningRef = useRef<Promise<void> | null>(null);
    const pendingRef = useRef(false);
    const showErrorsRef = useRef(false);

    // Load last sync time
    useEffect(() => {
        invoke<string | null>('get_registry_value', { key: REG_KEY_LAST_SYNC })
            .then(val => {
                if (val && !lastSyncRef.current) {
                    lastSyncRef.current = val;
                    setLastSyncTime(val);
                }
            })
            .catch(console.warn);
    }, []);

    const handleSync = useCallback((silent: boolean = false): Promise<void> => {
        if (!auth.currentUser) return Promise.resolve();
        if (!silent) showErrorsRef.current = true;
        if (runningRef.current) {
            // 실행 중 들어온 변경은 한 번의 후속 작업으로 합친다.
            pendingRef.current = true;
            return runningRef.current;
        }
        setIsSyncing(true);
        setSyncError(null);
        const request = (async () => {
        try {
            do {
            pendingRef.current = false;
            // 1. Sync Schedules (Firestore <-> Local DB)
            // We pass lastSyncTime to optimize
            const newSyncTime = await SyncService.syncData(lastSyncRef.current);

            // 2. Sync Messages (UDB -> Firestore)
            if (udbPath) {
                await SyncService.syncMessages(udbPath, (current, total) => {
                    setSyncProgress({ current, total });
                });
            }

            lastSyncRef.current = newSyncTime;
            setLastSyncTime(newSyncTime);
            await invoke('set_registry_value', { key: REG_KEY_LAST_SYNC, value: newSyncTime });

            if (onSyncComplete) onSyncComplete();
            } while (pendingRef.current);
        } catch (e: any) {
            console.error('Sync failed', e);
            if (showErrorsRef.current) setSyncError(e.message || 'Sync failed');
        } finally {
            runningRef.current = null;
            pendingRef.current = false;
            showErrorsRef.current = false;
            setIsSyncing(false);
            setSyncProgress(null);
        }
        })();
        runningRef.current = request;
        return request;
    }, [udbPath, onSyncComplete]);

    // Auto sync on interval (e.g. 5 minutes)
    useEffect(() => {
        const interval = setInterval(() => {
            handleSync(true);
        }, 5 * 60 * 1000);
        return () => clearInterval(interval);
    }, [handleSync]);

    return {
        lastSyncTime,
        isSyncing,
        syncProgress,
        syncError,
        handleSync
    };
}
