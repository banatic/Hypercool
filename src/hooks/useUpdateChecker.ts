import { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';

const UPDATE_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes

export function useUpdateChecker(skippedUpdateVersion: string) {
    const [updateNotification, setUpdateNotification] = useState<{ version: string; date: string; body: string } | null>(null);

    useEffect(() => {
        const checkForUpdates = async () => {
            try {
                const update = await check();
                if (update && update.version !== skippedUpdateVersion) {
                    setUpdateNotification({
                        version: update.version,
                        date: update.date || '',
                        body: update.body || '',
                    });
                }
            } catch (error) {
                console.log('자동 업데이트 체크 실패:', error);
            }
        };

        checkForUpdates();
        const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
        return () => clearInterval(interval);
    }, [skippedUpdateVersion]);

    return {
        updateNotification,
        setUpdateNotification
    };
}
