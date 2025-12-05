import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { check } from '@tauri-apps/plugin-updater';

import { Message, SearchResultItem, ManualTodo, Page, PeriodSchedule } from './types';
import { SyncService } from './sync/SyncService';
import { ScheduleService } from './services/ScheduleService';
import { Sidebar } from './components/Sidebar';
import { ClassifierPage } from './components/ClassifierPage';

import { HistoryPage } from './components/HistoryPage';
import { SettingsPage } from './components/SettingsPage';
import { ScheduleModal } from './components/ScheduleModal';

import { UpdateNotificationModal } from './components/UpdateNotificationModal';
import { AuthService } from './auth/AuthService';

import './App.css';

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASSIFIED = 'ClassifiedMap';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CLASS_TIMES = 'ClassTimes';
const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_UI_SCALE = 'UIScale';
const REG_KEY_CALENDAR_TITLES = 'CalendarTitles';
const REG_KEY_PERIOD_SCHEDULES = 'PeriodSchedules';
const REG_KEY_LAST_SYNC = 'LastSyncTime';
const REG_KEY_SKIPPED_UPDATE_VERSION = 'SkippedUpdateVersion';
const DRAG_THRESHOLD = 160;
const UPDATE_CHECK_INTERVAL = 10 * 60 * 1000; // 10분

// 기본 수업 시간 (HHMM-HHMM 형식)
const DEFAULT_CLASS_TIMES = [
  '0830-0920',
  '0930-1020',
  '1030-1120',
  '1130-1220',
  '1320-1410',
  '1420-1510',
  '1520-1610',
];

function App() {
  const [page, setPage] = useState<Page>('classify');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [udbPath, setUdbPath] = useState<string>('');
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  // 상태 텍스트는 파생값으로 계산합니다
  const [isLoading, setIsLoading] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const [classified, setClassified] = useState<Record<number, 'left' | 'right'>>({});
  const [deadlines, setDeadlines] = useState<Record<string, string | null>>({});
  const [calendarTitles, setCalendarTitles] = useState<Record<string, string>>({});
  const [scheduleModal, setScheduleModal] = useState<{ open: boolean; id?: number | string }>({ open: false });
  const [schedules, setSchedules] = useState<import('./types/schedule').ScheduleItem[]>([]);
  const [manualTodos, setManualTodos] = useState<ManualTodo[]>([]);
  const [periodSchedules, setPeriodSchedules] = useState<PeriodSchedule[]>([]);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

  const [historyIndex, setHistoryIndex] = useState(0);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
  const [activeSearchMessage, setActiveSearchMessage] = useState<Message | null>(null);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);
  const [isLoadingActiveSearch, setIsLoadingActiveSearch] = useState(false);
  const [classTimes, setClassTimes] = useState<string[]>(DEFAULT_CLASS_TIMES);
  const [uiScale, setUiScale] = useState<number>(1.0);
  const [updateNotification, setUpdateNotification] = useState<{ version: string; date: string; body: string } | null>(null);
  const [skippedUpdateVersion, setSkippedUpdateVersion] = useState<string | null>(null);
  const HISTORY_PAGE_SIZE = 20;
  
  const decodeEntities = useCallback((html: string): string => {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = html;
    return textarea.value;
  }, []);

  const pendingIndexes = useMemo(() => {
    const result: number[] = [];
    for (let i = 0; i < allMessages.length; i++) {
      if (!classified[allMessages[i].id]) result.push(i);
    }
    return result;
  }, [allMessages, classified]);

  const [visiblePairStart, setVisiblePairStart] = useState(0);
  const visibleIndexes = useMemo(() => {
    return pendingIndexes.slice(visiblePairStart, visiblePairStart + 2);
  }, [pendingIndexes, visiblePairStart]);

  const visibleMessages = useMemo(() => visibleIndexes.map(i => allMessages[i]).filter(Boolean), [visibleIndexes, allMessages]);

  const ensureVisiblePairProgress = useCallback(() => {
    setVisiblePairStart((prev) => {
      if (prev + 2 <= pendingIndexes.length) return prev;
      return Math.max(0, pendingIndexes.length - 2);
    });
  }, [pendingIndexes.length]);

  const saveToRegistry = useCallback(async (key: string, value: string) => {
    try {
      console.log(`Saving to registry: ${key} = ${value}`);
      await invoke('set_registry_value', { key, value });
      console.log(`Saved to registry: ${key}`);
    } catch (e) {
      console.warn('레지스트리 저장 실패', e);
    }
  }, []);

  const loadFromRegistry = useCallback(async () => {
    try {
      const savedPath = await invoke<string | null>('get_registry_value', { key: REG_KEY_UDB });
      console.log(`Loaded UDB path from registry: ${savedPath}`);
      if (savedPath) setUdbPath(savedPath);
      
      const savedMap = await invoke<string | null>('get_registry_value', { key: REG_KEY_CLASSIFIED });
      if (savedMap) setClassified(JSON.parse(savedMap) || {});

      // Legacy Registry keys for schedules are NO LONGER LOADED here.
      // We load from ScheduleService instead.
      await loadSchedules();

      const savedLastSync = await invoke<string | null>('get_registry_value', { key: REG_KEY_LAST_SYNC });
      if (savedLastSync) setLastSyncTime(savedLastSync);

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
        // 기본값이 없으면 기본값 설정
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
          // 파싱 실패 시 기본값 사용
        }
      }

      const savedSkippedVersion = await invoke<string | null>('get_registry_value', { key: REG_KEY_SKIPPED_UPDATE_VERSION });
      if (savedSkippedVersion) {
        setSkippedUpdateVersion(savedSkippedVersion);
      }

      // Try to migrate legacy registry data to DB if not already done
      // This is safe to call multiple times as it checks for existence (or we can make it idempotent)
      // Our migration function in db.rs checks if items exist before adding, but duplicates might be an issue if we don't track migration status.
      // However, since we use UUIDs for new items, we might create duplicates if we run it every time.
      // Let's check a flag in registry "DataMigratedToDB".
      const migrationStatus = await invoke<string | null>('get_registry_value', { key: 'DataMigratedToDB' });
      if (migrationStatus !== 'true') {
        console.log("Migrating legacy registry data to DB...");
        try {
          const result = await invoke<string>('migrate_registry_to_db_command');
          console.log("Migration result:", result);
          await saveToRegistry('DataMigratedToDB', 'true');
          // Reload schedules after migration
          await loadSchedules();
        } catch (e) {
          console.error("Migration failed:", e);
        }
      }

    } catch (e) {
      console.warn('레지스트리 로드 실패', e);
    }
  }, [saveToRegistry]);


  const lastLoadSchedulesTimeRef = useRef(0);

  const loadSchedules = useCallback(async () => {
    const now = Date.now();
    if (now - lastLoadSchedulesTimeRef.current < 1000) {
      return;
    }
    lastLoadSchedulesTimeRef.current = now;

    try {
      // Load all schedules (wide range or all? getSchedules takes range. 
      // For now, let's assume we want everything or a very wide range.
      // Since we are replacing registry which held EVERYTHING, we should fetch everything.
      // But getSchedules requires range.
      // Let's use a very wide range for now: 2000-01-01 to 2100-12-31
      const start = new Date('2000-01-01');
      const end = new Date('2100-12-31');
      const items = await ScheduleService.getSchedules({ start, end });

      const newManualTodos: ManualTodo[] = [];
      const newPeriodSchedules: PeriodSchedule[] = [];
      const newDeadlines: Record<string, string | null> = {};
      const newCalendarTitles: Record<string, string> = {};

      for (const item of items) {
        if (item.type === 'manual_todo') {
          newManualTodos.push({
            id: item.id,
            content: item.content || '',
            deadline: item.startDate || null,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            calendarTitle: item.title,
            isDeleted: item.isDeleted
          });
        } else if (item.type === 'period_schedule') {
          newPeriodSchedules.push({
            id: item.id,
            content: item.content || '',
            startDate: item.startDate!, // Should be present for period schedule
            endDate: item.endDate!,
            calendarTitle: item.title,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            isDeleted: item.isDeleted
          });
        } else if (item.type === 'message_task') {
          if (item.referenceId) {
            // Check if referenceId is a valid number (message ID)
            const isNumeric = !isNaN(Number(item.referenceId));
            if (isNumeric) {
              newDeadlines[item.referenceId] = item.startDate || null;
              newCalendarTitles[item.referenceId] = item.title;
            } else {
              // If referenceId is not a number (e.g. UUID), it's an orphaned task or migrated incorrectly.
              // Treat it as a manual todo so it shows up.
              newManualTodos.push({
                id: item.id,
                content: item.content || '',
                deadline: item.startDate || null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                calendarTitle: item.title,
                isDeleted: item.isDeleted
              });
            }
          }
        }
      }

      setManualTodos(newManualTodos);
      setPeriodSchedules(newPeriodSchedules);
      setDeadlines(newDeadlines);
      setCalendarTitles(newCalendarTitles);
      setSchedules(items);

      // Ensure ClassifiedMap includes all message tasks as 'right'
      const savedClassified = await invoke<string | null>('get_registry_value', { key: REG_KEY_CLASSIFIED });
      const currentClassified: Record<number, 'left' | 'right'> = savedClassified ? JSON.parse(savedClassified) : {};
      let classifiedChanged = false;

      for (const refId of Object.keys(newDeadlines)) {
        const msgId = Number(refId);
        if (!isNaN(msgId) && currentClassified[msgId] !== 'right') {
          currentClassified[msgId] = 'right';
          classifiedChanged = true;
        }
      }

      if (classifiedChanged) {
        await saveToRegistry(REG_KEY_CLASSIFIED, JSON.stringify(currentClassified));
        setClassified(currentClassified);
      }

      return {
        manualTodos: newManualTodos,
        periodSchedules: newPeriodSchedules,
        deadlines: newDeadlines,
        calendarTitles: newCalendarTitles
      };
    } catch (e) {
      console.error("Failed to load schedules from DB", e);
      return null;
    }
  }, [saveToRegistry]);

  // UI 배율 적용
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--ui-scale', uiScale.toString());
    const appElement = document.querySelector('.app') as HTMLElement;
    const contentElement = document.querySelector('.content') as HTMLElement;
    
    if (appElement) {
      appElement.style.transform = `scale(${uiScale})`;
      appElement.style.transformOrigin = 'top left';
      
      // 스케일 적용 시 너비와 높이 조정
      const width = window.innerWidth / uiScale;
      const height = window.innerHeight / uiScale;
      appElement.style.width = `${width}px`;
      appElement.style.height = `${height}px`;
      
      // .content의 높이도 조정
      if (contentElement) {
        contentElement.style.height = `${height}px`;
      }
    }
    
    // 윈도우 리사이즈 시에도 높이 업데이트
    const handleResize = () => {
      if (appElement && contentElement) {
        const width = window.innerWidth / uiScale;
        const height = window.innerHeight / uiScale;
        appElement.style.width = `${width}px`;
        appElement.style.height = `${height}px`;
        contentElement.style.height = `${height}px`;
      }
    };
    
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [uiScale]);

  useEffect(() => {
    AuthService.init();
  }, []);

  useEffect(() => {
    // Load from DB on startup (source of truth)
    const initData = async () => {
      await loadFromRegistry();
      await loadSchedules();
    };
    initData();
  }, [loadSchedules, loadFromRegistry]);

  // 자동 업데이트 체크 (10분마다)
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const update = await check();
        if (update) {
          // 넘어간 버전이 아니면 모달 표시
          if (update.version !== skippedUpdateVersion) {
            setUpdateNotification({
              version: update.version,
              date: update.date || '',
              body: update.body || '',
            });
          }
        }
      } catch (error) {
        // 업데이트 체크 실패는 조용히 무시 (콘솔에만 로그)
        console.log('자동 업데이트 체크 실패:', error);
      }
    };

    // 초기 체크
    checkForUpdates();

    // 10분마다 체크
    const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);

    return () => {
      clearInterval(interval);
    };
  }, [skippedUpdateVersion]);

  // 하이퍼링크 클릭 시 외부 브라우저에서 열기
  useEffect(() => {
    const handleLinkClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a');
      
      if (link) {
        // href 속성에서 원본 URL 가져오기 (상대 경로도 처리)
        const href = link.getAttribute('href') || link.href;
        
        if (href) {
          console.log('링크 발견:', href, 'link.href:', link.href);
          
          // http:// 또는 https://로 시작하는 외부 링크인 경우
          if (href.startsWith('http://') || href.startsWith('https://')) {
            e.preventDefault();
            e.stopPropagation();
            console.log('외부 브라우저에서 열기 시도:', href);
            try {
              await shellOpen(href);
              console.log('링크 열기 성공:', href);
            } catch (error) {
              console.error('링크 열기 실패:', error);
            }
          } else if (link.href && (link.href.startsWith('http://') || link.href.startsWith('https://'))) {
            // link.href가 절대 URL로 변환된 경우
            e.preventDefault();
            e.stopPropagation();
            console.log('외부 브라우저에서 열기 시도 (절대 URL):', link.href);
            try {
              await shellOpen(link.href);
              console.log('링크 열기 성공:', link.href);
            } catch (error) {
              console.error('링크 열기 실패:', error);
            }
          }
        }
      }
    };

    // 이벤트 위임을 사용해서 동적으로 추가되는 링크도 처리
    document.addEventListener('click', handleLinkClick, true);
    
    return () => {
      document.removeEventListener('click', handleLinkClick, true);
    };
  }, []);

  const loadUdbFile = useCallback(async (path?: string, offset: number = 0, searchTerm?: string) => {
    try {
      setIsLoading(true);

      const finalPath = path ?? udbPath;
      if (!finalPath) {
        return;
      }
      
      const finalSearchTerm = searchTerm ?? '';
      
      const result = await invoke<{ messages: Message[]; total_count: number }>('read_udb_messages', { 
        dbPath: finalPath,
        limit: HISTORY_PAGE_SIZE,
        offset,
        searchTerm: finalSearchTerm,
      });
      const { messages, total_count } = result;

      // 새 검색이면 메시지 목록을 교체하고, 아니면 추가합니다.
      setAllMessages(offset === 0 ? messages : prev => [...prev, ...messages]);
      setTotalMessageCount(total_count);
      
    } catch (error) {
      console.error('Error loading UDB file:', error);
    } finally {
      setIsLoading(false);
    }
  }, [udbPath]);

  // UDB 변경 이벤트 구독 (Watchdog에서 발생)
  useEffect(() => {
    const unlistenPromise = listen('udb-changed', async () => {
      if (udbPath) {
        // 히스토리 첫 페이지 및 관련 상태 초기화
        setHistoryIndex(0);
        await loadUdbFile(udbPath, 0, '');
      }
    });
    return () => { void unlistenPromise.then(unlisten => unlisten()); };
  }, [udbPath, loadUdbFile]);

  // UDB 경로 변경 시 데이터 다시 로드
  useEffect(() => {
    if (udbPath) {
      setHistoryIndex(0);
      setHistorySearchTerm('');
      void loadUdbFile(udbPath, 0, '');
    }
  }, [udbPath, loadUdbFile]);

  // 검색어 입력을 위한 디바운스 처리
  useEffect(() => {
    const handler = setTimeout(() => {
      if (udbPath) {
        if (historySearchTerm.trim() === '') {
          setSearchResults(null);
          setActiveSearchMessage(null);
          setHistoryIndex(0);
          loadUdbFile(udbPath, 0, '');
          return;
        }

        const performSearch = async () => {
          try {
            setIsLoadingSearch(true);
            setActiveSearchMessage(null);
            const results: SearchResultItem[] = await invoke('search_messages', {
              dbPath: udbPath,
              searchTerm: historySearchTerm,
            });
            setSearchResults(results);
            if (results.length > 0) {
              // Automatically load the first result
              const firstMsg: Message = await invoke('get_message_by_id', { dbPath: udbPath, id: results[0].id });
              setActiveSearchMessage(firstMsg);
            }
          } catch (e) {
            console.error("Search failed", e);
            setSearchResults([]);
          } finally {
            setIsLoadingSearch(false);
          }
        };
        void performSearch();
      }
    }, 500); // 500ms 디바운스

    return () => {
      clearTimeout(handler);
    };
  }, [historySearchTerm, udbPath, loadUdbFile]);

  const pickUdb = useCallback(async () => {
    const selected = await open({ filters: [{ name: 'UDB Files', extensions: ['udb'] }], multiple: false });
    if (typeof selected === 'string') {
      setUdbPath(selected);
      await saveToRegistry(REG_KEY_UDB, selected);
    }
  }, [saveToRegistry]);

  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleSync = useCallback(async (silent: boolean = false) => {
    try {
      if (!silent) {
        setIsLoading(true);
        setSyncError(null);
      }

      // CRITICAL: Load latest data from registry BEFORE syncing to avoid overwriting with stale state
      // This prevents the issue where a widget update (saved to registry) is overwritten by a sync 
      // triggered with stale App state.
      const savedManualTodos = await invoke<string | null>('get_registry_value', { key: REG_KEY_MANUAL_TODOS });
      const currentManualTodos: ManualTodo[] = savedManualTodos ? JSON.parse(savedManualTodos) : [];
      
      const savedPeriodSchedules = await invoke<string | null>('get_registry_value', { key: REG_KEY_PERIOD_SCHEDULES });
      const currentPeriodSchedules: PeriodSchedule[] = savedPeriodSchedules ? JSON.parse(savedPeriodSchedules) : [];

      const savedDeadlines = await invoke<string | null>('get_registry_value', { key: REG_KEY_DEADLINES });
      const currentDeadlines: Record<string, string | null> = savedDeadlines ? JSON.parse(savedDeadlines) : {};

      const savedCalendarTitles = await invoke<string | null>('get_registry_value', { key: REG_KEY_CALENDAR_TITLES });
      const currentCalendarTitles: Record<string, string> = savedCalendarTitles ? JSON.parse(savedCalendarTitles) : {};

      // Update local state to match registry (so UI is consistent)
      setManualTodos(currentManualTodos);
      setPeriodSchedules(currentPeriodSchedules);
      setDeadlines(currentDeadlines);
      setCalendarTitles(currentCalendarTitles);
      
      console.log('Syncing data:', { lastSyncTime });
      
      const newSyncTime = await SyncService.syncData(lastSyncTime);
      
      if (udbPath) {
        await SyncService.syncMessages(udbPath, (current, total) => {
          if (!silent) setSyncProgress({ current, total });
        });
      }

      // Reload schedules from DB to reflect changes
      await loadSchedules();
      
      setLastSyncTime(newSyncTime);
      await saveToRegistry(REG_KEY_LAST_SYNC, newSyncTime);
      
      // Notify calendar widget
      await emit('calendar-update', { source: 'app-sync' });
      
      if (!silent) alert('동기화 완료!');
    } catch (e: any) {
      console.error('Sync failed:', e);
      const errorMessage = e?.message || e?.toString() || '알 수 없는 오류';
      if (!silent) {
        setSyncError(errorMessage);
        alert('동기화 실패: ' + errorMessage);
      }
    } finally {
      if (!silent) {
        setIsLoading(false);
        setSyncProgress(null);
      }
    }
  }, [lastSyncTime, saveToRegistry, udbPath, deadlines, calendarTitles]);

  // Debounced Sync for Auto-Sync
  const debouncedSync = useCallback(() => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }
    syncTimeoutRef.current = setTimeout(() => {
      console.log('Auto-sync triggered');
      void handleSync(true);
    }, 5000); // 5초 후 자동 동기화
  }, [handleSync]);

  // UDB 변경 이벤트 구독 (Watchdog에서 발생)
  useEffect(() => {
    const unlistenPromise = listen('udb-changed', async () => {
      if (udbPath) {
        // 히스토리 첫 페이지 및 관련 상태 초기화
        setHistoryIndex(0);
        await loadUdbFile(udbPath, 0, '');
        
        // UDB 변경 시 자동 동기화 트리거
        debouncedSync();
      }
    });
    return () => { void unlistenPromise.then(unlisten => unlisten()); };
  }, [udbPath, loadUdbFile, debouncedSync]);

  // Calendar Update 이벤트 구독 (일정 변경 시)
  useEffect(() => {
    const unlistenPromise = listen<{ source?: string }>('calendar-update', async (event) => {
      // 앱 자체 동기화로 인한 업데이트는 무시 (무한 루프 방지)
      if (event.payload?.source === 'app-sync') {
        console.log('Ignoring calendar-update from app-sync');
        return;
      }

      // 레지스트리에서 최신 데이터 로드
      await loadFromRegistry();
      // 일정 변경 시 자동 동기화 트리거
      debouncedSync();
    });
    return () => { void unlistenPromise.then(unlisten => unlisten()); };
  }, [loadFromRegistry, debouncedSync]);

  const classify = useCallback((id: number | string, direction: 'left' | 'right') => {
    setClassified(prev => {
      const next = { ...prev, [id]: direction };
      void saveToRegistry(REG_KEY_CLASSIFIED, JSON.stringify(next));
      return next;
    });
    ensureVisiblePairProgress();
    if (direction === 'right') {
      setScheduleModal({ open: true, id });
    }
  }, [ensureVisiblePairProgress, saveToRegistry]);

  const dragHandlers = () => {
    let startX = 0;
    let draggingId: number | null = null;
    let el: HTMLElement | null = null;

    const onMouseMove = (e: MouseEvent) => {
      if (!el) return;
      const dx = e.clientX - startX;
      el.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      el.classList.toggle('preview-right', dx > DRAG_THRESHOLD);
      el.classList.toggle('preview-left', dx < -DRAG_THRESHOLD);
    };

    const onMouseUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (!el || draggingId === null) return;

      const dx = e.clientX - startX;
      el.style.transform = '';
      el.classList.remove('preview-right', 'preview-left');

      if (Math.abs(dx) > DRAG_THRESHOLD) {
        classify(draggingId, dx > 0 ? 'right' : 'left');
      }
      draggingId = null;
      el = null;
    };

    const onMouseDown = (id: number) => (e: React.MouseEvent<HTMLDivElement>) => {
      draggingId = id;
      startX = e.clientX;
      el = (e.currentTarget as HTMLElement).closest('.card');
      if (el) {
        el.style.transition = 'none'; // Disable transition during drag
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      }
    };

    return { onMouseDown };
  };
  const { onMouseDown } = dragHandlers();



  // 누락된 메시지들을 로드
  useEffect(() => {
    const loadMissingMessages = async () => {
      if (!udbPath) return;
      
      const rightIds = new Set(Object.keys(classified).filter(k => classified[Number(k)] === 'right').map(Number));
      const existingIds = new Set(allMessages.map(m => m.id));
      const missingIds = Array.from(rightIds).filter(id => !existingIds.has(id));
      
      if (missingIds.length === 0) return;
      
      // 누락된 메시지들을 하나씩 로드
      const promises = missingIds.map(async (id) => {
        try {
          const msg: Message = await invoke('get_message_by_id', { dbPath: udbPath, id });
          return msg;
        } catch (e) {
          console.error(`Failed to load message ${id}`, e);
          return null;
        }
      });
      
      const loadedMessages = await Promise.all(promises);
      const validMessages = loadedMessages.filter((m): m is Message => m !== null);
      
      if (validMessages.length > 0) {
        setAllMessages(prev => {
          const existingIds = new Set(prev.map(m => m.id));
          const newMessages = validMessages.filter(m => !existingIds.has(m.id));
          return [...prev, ...newMessages];
        });
      }
    };
    
    void loadMissingMessages();
  }, [classified, allMessages, udbPath]);

  const unclassifiedCount = pendingIndexes.length;
  const statusText = isLoading ? '로딩 중...' : `총 메시지 ${totalMessageCount}개 / 미분류 ${unclassifiedCount}개 (현재 로드된 메시지 기준)`;

  const completeAllPending = useCallback(() => {
    if (allMessages.length === 0 || unclassifiedCount === 0) return;
    setClassified(prev => {
      const next = { ...prev } as Record<number, 'left' | 'right'>;
      for (const idx of pendingIndexes) {
        const id = allMessages[idx].id;
        if (!next[id]) next[id] = 'left';
      }
      void saveToRegistry(REG_KEY_CLASSIFIED, JSON.stringify(next));
      return next;
    });
    setVisiblePairStart(0);
  }, [allMessages, pendingIndexes, unclassifiedCount, saveToRegistry]);

  const onHideToTray = useCallback(() => {
    void invoke('notify_hidden');
    void invoke('hide_main_window');
  }, []);

  const formatReceiveDate = (receiveDate: string | null | undefined) => {
    if (!receiveDate) return null;
    try {
      const date = new Date(receiveDate);
      const year = date.getFullYear().toString().slice(-2);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      return `${year}.${month}.${day} ${hours}:${minutes}`;
    } catch {
      return null;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}. ${month}. ${day}.`;
  };

  // 날짜 파싱 함수: 다양한 형식의 날짜 문자열을 파싱하여 ISO 날짜 문자열과 시간을 반환
  const parseDateFromText = (text: string, baseDate?: Date): { date: string | null; time: string | null } => {
    const now = baseDate || new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const pad = (n: number) => n.toString().padStart(2, '0');
    
    // "님의 보낸 메시지 전달 >> YYYY/MM/DD HH:MM:SS (요일)" 형식 제거
    const textWithoutDeliveryTime = text.replace(/님의\s*보낸\s*메시지\s*전달\s*>>\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*\([일월화수목금토]\)/gi, '');
    
    // 텍스트 정규화 (공백 제거, 소문자 변환)
    const normalizedText = textWithoutDeliveryTime.replace(/\s+/g, ' ').trim();
    
    // 상대적 날짜 패턴
    const relativeDatePatterns = [
      { pattern: /오늘|지금/i, days: 0 },
      { pattern: /내일/i, days: 1 },
      { pattern: /모레/i, days: 2 },
      { pattern: /글피/i, days: 3 },
      { pattern: /다음\s*주|다음주/i, days: 7 },
      { pattern: /이번\s*주|이번주/i, days: 0 },
      { pattern: /다다음\s*주|다다음주/i, days: 14 },
    ];

    // 요일 패턴 (한국어)
    const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    const weekdayMap: Record<string, number> = {};
    weekdays.forEach((day, index) => {
      weekdayMap[day] = index;
    });

    // 절대 날짜 패턴들 (각 패턴마다 파싱 로직이 다름)
    const absoluteDatePatterns: Array<{ pattern: RegExp; parse: (match: RegExpMatchArray, today: Date) => Date | null }> = [
      {
        // YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD
        pattern: /(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/,
        parse: (match) => {
          const year = parseInt(match[1]);
          const month = parseInt(match[2]) - 1;
          const day = parseInt(match[3]);
          return new Date(year, month, day);
        }
      },
      {
        // YYYY년 MM월 DD일
        pattern: /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
        parse: (match) => {
          const year = parseInt(match[1]);
          const month = parseInt(match[2]) - 1;
          const day = parseInt(match[3]);
          return new Date(year, month, day);
        }
      },
      {
        // MM월 DD일
        pattern: /(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
        parse: (match, today) => {
          const month = parseInt(match[1]) - 1;
          const day = parseInt(match[2]);
          const date = new Date(today.getFullYear(), month, day);
          // 이미 지난 날짜면 내년으로
          if (date < today) {
            date.setFullYear(date.getFullYear() + 1);
          }
          return date;
        }
      },
      {
        // MM-DD, MM.DD, MM/DD (올해로 가정)
        pattern: /(\d{1,2})[.\-\/](\d{1,2})(?!\d)/,
        parse: (match, today) => {
          const month = parseInt(match[1]) - 1;
          const day = parseInt(match[2]);
          const date = new Date(today.getFullYear(), month, day);
          // 이미 지난 날짜면 내년으로
          if (date < today) {
            date.setFullYear(date.getFullYear() + 1);
          }
          return date;
        }
      },
    ];

    // 시간 패턴들
    const timePatterns: Array<{ pattern: RegExp; parse: (match: RegExpMatchArray) => string | null }> = [
      {
        // 오전/오후 시간
        pattern: /(오전|오후|AM|PM|am|pm)\s*(\d{1,2})시(?:\s*(\d{1,2})분)?/,
        parse: (match) => {
          const period = match[1].toLowerCase();
          let hours = parseInt(match[2]) || 0;
          const minutes = match[3] ? parseInt(match[3]) : 0;
          
          if (period.includes('오후') || period.includes('pm')) {
            if (hours !== 12) hours += 12;
          } else if (period.includes('오전') || period.includes('am')) {
            if (hours === 12) hours = 0;
          }
          return `${pad(hours)}:${pad(minutes)}`;
        }
      },
      {
        // HH:MM 형식
        pattern: /(\d{1,2}):(\d{2})/,
        parse: (match) => {
          const hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          return `${pad(hours)}:${pad(minutes)}`;
        }
      },
      {
        // HH시 MM분 형식
        pattern: /(\d{1,2})\s*시\s*(\d{1,2})\s*분/,
        parse: (match) => {
          const hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          return `${pad(hours)}:${pad(minutes)}`;
        }
      },
      {
        // HHMM 형식 (4자리 숫자)
        pattern: /(\d{2})(\d{2})(?=\s|$|[^\d])/,
        parse: (match) => {
          const hours = parseInt(match[1]);
          const minutes = parseInt(match[2]);
          if (hours < 24 && minutes < 60) {
            return `${pad(hours)}:${pad(minutes)}`;
          }
          return null;
        }
      },
      {
        // N시 형식
        pattern: /(\d{1,2})\s*시(?!\s*\d)/,
        parse: (match) => {
          const hours = parseInt(match[1]);
          return `${pad(hours)}:00`;
        }
      },
    ];

    // 모든 날짜와 시간을 수집
    const foundDates: Date[] = [];
    let parsedTime: string | null = null;

    // 1. 상대적 날짜 패턴 매칭 (모든 매칭 찾기)
    for (const { pattern, days } of relativeDatePatterns) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      const matches = normalizedText.matchAll(globalPattern);
      for (const _match of matches) {
        const date = new Date(today);
        date.setDate(date.getDate() + days);
        foundDates.push(date);
      }
    }

    // 2. 요일 패턴 매칭 (모든 매칭 찾기)
    for (const [weekday, weekdayIndex] of Object.entries(weekdayMap)) {
      if (normalizedText.includes(weekday)) {
        const targetDate = new Date(today);
        const currentDay = today.getDay();
        let daysToAdd = (weekdayIndex - currentDay + 7) % 7;
        if (daysToAdd === 0) daysToAdd = 7; // 이번 주가 아니라 다음 주로
        targetDate.setDate(targetDate.getDate() + daysToAdd);
        foundDates.push(targetDate);
      }
    }

    // 3. 절대 날짜 패턴 매칭 (모든 매칭 찾기)
    for (const { pattern, parse } of absoluteDatePatterns) {
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      const matches = normalizedText.matchAll(globalPattern);
      for (const match of matches) {
        const date = parse(match, today);
        if (date) {
          foundDates.push(date);
        }
      }
    }

    // 4. 시간 패턴 매칭 (첫 번째 매칭만 사용)
    for (const { pattern, parse } of timePatterns) {
      const match = normalizedText.match(pattern);
      if (match) {
        parsedTime = parse(match);
        if (parsedTime) break;
      }
    }

    // 가장 빠른 날짜 선택
    let parsedDate: Date | null = null;
    if (foundDates.length > 0) {
      // 날짜 배열을 정렬하여 가장 빠른 날짜 선택
      foundDates.sort((a, b) => a.getTime() - b.getTime());
      parsedDate = foundDates[0];
    }

    // 파싱된 날짜를 YYYY-MM-DD 형식으로 변환
    if (parsedDate) {
      const dateStr = `${parsedDate.getFullYear()}-${pad(parsedDate.getMonth() + 1)}-${pad(parsedDate.getDate())}`;
      return { date: dateStr, time: parsedTime };
    }

    return { date: null, time: null };
  };

  const handleSearchResultClick = useCallback(async (id: number) => {
    if (!udbPath) return;
    try {
      setIsLoadingActiveSearch(true);
      const msg: Message = await invoke('get_message_by_id', { dbPath: udbPath, id });
      setActiveSearchMessage(msg);
    } catch (e) {
      console.error("Failed to load message by id", e);
    } finally {
      setIsLoadingActiveSearch(false);
    }
  }, [udbPath]);

  return (
    <div className="app with-sidebar">
      <Sidebar page={page} setPage={setPage} sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed} />
      <main className="content">
        <button className="app-title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
        {page === 'classify' && (
          <ClassifierPage
            isLoading={isLoading}
            statusText={statusText}
            unclassifiedCount={unclassifiedCount}
            visibleMessages={visibleMessages}
            onMouseDown={onMouseDown}
            classify={classify}
            loadUdbFile={loadUdbFile}
            udbPath={udbPath}
            completeAllPending={completeAllPending}
            decodeEntities={decodeEntities}
            formatReceiveDate={formatReceiveDate}
          />
        )}

        {page === 'history' && (
          <HistoryPage
            totalMessageCount={totalMessageCount}
            historySearchTerm={historySearchTerm}
            setHistorySearchTerm={setHistorySearchTerm}
            historyIndex={historyIndex}
            setHistoryIndex={setHistoryIndex}
            allMessages={allMessages}
            loadUdbFile={loadUdbFile}
            udbPath={udbPath}
            isLoading={isLoading}
            classified={classified}
            deadlines={deadlines}
            setScheduleModal={setScheduleModal}
            decodeEntities={decodeEntities}
            formatDate={formatDate}
            formatReceiveDate={formatReceiveDate}
            searchResults={searchResults}
            isLoadingSearch={isLoadingSearch}
            activeSearchMessage={activeSearchMessage}
            isLoadingActiveSearch={isLoadingActiveSearch}
            handleSearchResultClick={handleSearchResultClick}
            page={page}
          />
        )}
        {page === 'settings' && (
          <SettingsPage 
              udbPath={udbPath} 
              setUdbPath={setUdbPath}
              pickUdb={pickUdb}
              saveToRegistry={saveToRegistry}
              classTimes={classTimes}
              setClassTimes={setClassTimes}
              manualTodos={manualTodos}
              setManualTodos={setManualTodos}
              periodSchedules={periodSchedules}
              setPeriodSchedules={setPeriodSchedules}
              uiScale={uiScale}
              setUiScale={setUiScale}
              onSync={handleSync}
              lastSyncTime={lastSyncTime}
              isLoadingSync={isLoading}
              syncProgress={syncProgress}
              syncError={syncError}
            />
        )}
        <ScheduleModal
          scheduleModal={scheduleModal}
          setScheduleModal={setScheduleModal}
          deadlines={deadlines}
          setDeadlines={setDeadlines}
          calendarTitles={calendarTitles}
          setCalendarTitles={setCalendarTitles}
          manualTodos={manualTodos}
          setManualTodos={setManualTodos}
          allMessages={allMessages}
          setAllMessages={setAllMessages}
          udbPath={udbPath}
          saveToRegistry={saveToRegistry}
          classified={classified}
          setClassified={setClassified}
          parseDateFromText={parseDateFromText}
          decodeEntities={decodeEntities}
          schedules={schedules}
        />

        {updateNotification && (
          <UpdateNotificationModal
            updateInfo={updateNotification}
            onClose={() => {
              setUpdateNotification(null);
            }}
            onSkip={async () => {
              // 넘어간 버전 저장
              await saveToRegistry(REG_KEY_SKIPPED_UPDATE_VERSION, updateNotification.version);
              setSkippedUpdateVersion(updateNotification.version);
              setUpdateNotification(null);
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
