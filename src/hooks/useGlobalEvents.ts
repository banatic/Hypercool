import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open as shellOpen } from '@tauri-apps/plugin-shell';

interface UseGlobalEventsProps {
    uiScale: number;
    udbPath: string;
    loadUdbFile: (path?: string) => Promise<void>;
    loadSchedules: () => Promise<void>;
    handleSync: (silent?: boolean) => Promise<void>;
}

export function useGlobalEvents({
    uiScale,
    udbPath,
    loadUdbFile,
    loadSchedules,
    handleSync
}: UseGlobalEventsProps) {

    // UI Scale
    useEffect(() => {
        const root = document.documentElement;
        root.style.setProperty('--ui-scale', uiScale.toString());
        const appElement = document.querySelector('.app') as HTMLElement;
        const contentElement = document.querySelector('.content') as HTMLElement;

        const updateSize = () => {
            if (appElement) {
                appElement.style.transform = `scale(${uiScale})`;
                appElement.style.transformOrigin = 'top left';
                const width = window.innerWidth / uiScale;
                const height = window.innerHeight / uiScale;
                appElement.style.width = `${width}px`;
                appElement.style.height = `${height}px`;
                if (contentElement) contentElement.style.height = `${height}px`;
            }
        };

        updateSize();
        window.addEventListener('resize', updateSize);
        return () => window.removeEventListener('resize', updateSize);
    }, [uiScale]);

    // External Link Handling
    useEffect(() => {
        const handleLinkClick = async (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const link = target.closest('a');
            if (link && (link.href.startsWith('http') || link.href.startsWith('https'))) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await shellOpen(link.href);
                } catch (error) {
                    console.error('링크 열기 실패:', error);
                }
            }
        };
        document.addEventListener('click', handleLinkClick, true);
        return () => document.removeEventListener('click', handleLinkClick, true);
    }, []);

    // Watchdog Events
    useEffect(() => {
        const unlistenPromise = listen('udb-changed', async () => {
            if (udbPath) {
                loadUdbFile(udbPath);
                handleSync(true); // Auto sync on change
            }
        });
        return () => { void unlistenPromise.then(unlisten => unlisten()); };
    }, [udbPath, loadUdbFile, handleSync]);

    useEffect(() => {
        const unlistenPromise = listen<{ source?: string }>('calendar-update', async (event) => {
            if (event.payload?.source === 'app-sync') return;
            loadSchedules();
            handleSync(true);
        });
        return () => { void unlistenPromise.then(unlisten => unlisten()); };
    }, [loadSchedules, handleSync]);
}
