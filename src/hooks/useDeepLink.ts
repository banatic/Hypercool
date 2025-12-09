import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

export function useDeepLink() {
    const [deepLinkUrl, setDeepLinkUrl] = useState<string | null>(null);

    useEffect(() => {
        const unlisten = listen<string>('deep-link-url', (event) => {
            console.log('Deep link received:', event.payload);
            setDeepLinkUrl(event.payload);
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    return { deepLinkUrl, setDeepLinkUrl };
}
