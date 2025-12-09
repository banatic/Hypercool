import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SyncService } from '../sync/SyncService';

const REG_KEY_LAST_SYNC = 'LastSyncTime';

export function useSync(udbPath: string, onSyncComplete?: () => void) {
    const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);

    // Load last sync time
    useEffect(() => {
        invoke<string | null>('get_registry_value', { key: REG_KEY_LAST_SYNC })
            .then(val => {
                if (val) setLastSyncTime(val);
            })
            .catch(console.warn);
    }, []);

    const handleSync = useCallback(async (silent: boolean = false) => {
        if (isSyncing) return;
        if (!silent) setIsSyncing(true);
        setSyncError(null);

        try {
            // 1. Sync Schedules (Firestore <-> Local DB)
            // We pass lastSyncTime to optimize
            const newSyncTime = await SyncService.syncData(lastSyncTime);

            // 2. Sync Messages (UDB -> Firestore)
            if (udbPath) {
                await SyncService.syncMessages(udbPath, (current, total) => {
                    setSyncProgress({ current, total });
                });
            }

            setLastSyncTime(newSyncTime);
            await invoke('set_registry_value', { key: REG_KEY_LAST_SYNC, value: newSyncTime });

            if (onSyncComplete) onSyncComplete();
        } catch (e: any) {
            console.error('Sync failed', e);
            if (!silent) setSyncError(e.message || 'Sync failed');
        } finally {
            if (!silent) setIsSyncing(false);
            setSyncProgress(null);
        }
    }, [isSyncing, lastSyncTime, udbPath, onSyncComplete]);

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
