import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASS_TIMES = 'ClassTimes';
const REG_KEY_UI_SCALE = 'UIScale';
const REG_KEY_SKIPPED_UPDATE_VERSION = 'SkippedUpdateVersion';

const DEFAULT_CLASS_TIMES = [
    '0830-0920',
    '0930-1020',
    '1030-1120',
    '1130-1220',
    '1320-1410',
    '1420-1510',
    '1520-1610',
];

export function useSettings() {
    const [udbPath, setUdbPath] = useState<string>('');
    const [classTimes, setClassTimes] = useState<string[]>(DEFAULT_CLASS_TIMES);
    const [uiScale, setUiScale] = useState<number>(1.0);
    const [skippedUpdateVersion, setSkippedUpdateVersion] = useState<string | null>(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

    const saveToRegistry = useCallback(async (key: string, value: string) => {
        try {
            await invoke('set_registry_value', { key, value });
        } catch (e) {
            console.warn('레지스트리 저장 실패', e);
        }
    }, []);

    const loadSettings = useCallback(async () => {
        try {
            const savedPath = await invoke<string | null>('get_registry_value', { key: REG_KEY_UDB });
            if (savedPath) setUdbPath(savedPath);

            const savedClassTimes = await invoke<string | null>('get_registry_value', { key: REG_KEY_CLASS_TIMES });
            if (savedClassTimes) {
                try {
                    const parsed = JSON.parse(savedClassTimes);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        setClassTimes(parsed);
                    } else {
                        setClassTimes(DEFAULT_CLASS_TIMES);
                        await saveToRegistry(REG_KEY_CLASS_TIMES, JSON.stringify(DEFAULT_CLASS_TIMES));
                    }
                } catch {
                    setClassTimes(DEFAULT_CLASS_TIMES);
                    await saveToRegistry(REG_KEY_CLASS_TIMES, JSON.stringify(DEFAULT_CLASS_TIMES));
                }
            } else {
                setClassTimes(DEFAULT_CLASS_TIMES);
                await saveToRegistry(REG_KEY_CLASS_TIMES, JSON.stringify(DEFAULT_CLASS_TIMES));
            }

            const savedUIScale = await invoke<string | null>('get_registry_value', { key: REG_KEY_UI_SCALE });
            if (savedUIScale) {
                try {
                    const scale = parseFloat(savedUIScale);
                    if (scale >= 0.5 && scale <= 2.0) {
                        setUiScale(scale);
                    }
                } catch {
                    // Ignore parse error
                }
            }

            const savedSkippedVersion = await invoke<string | null>('get_registry_value', { key: REG_KEY_SKIPPED_UPDATE_VERSION });
            if (savedSkippedVersion) {
                setSkippedUpdateVersion(savedSkippedVersion);
            }
        } catch (e) {
            console.warn('Settings load failed', e);
        }
    }, [saveToRegistry]);

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    return {
        udbPath,
        setUdbPath,
        classTimes,
        setClassTimes,
        uiScale,
        setUiScale,
        skippedUpdateVersion,
        setSkippedUpdateVersion,
        sidebarCollapsed,
        setSidebarCollapsed,
        saveToRegistry,
        loadSettings,
    };
}
