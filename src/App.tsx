import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { List } from 'react-window';
import './App.css';

interface Message {
  id: number;
  sender: string;
  content: string;
  receive_date?: string | null;
}

interface SearchResultItem {
  id: number;
  sender: string;
  snippet: string;
}

interface ManualTodo {
  id: number;
  content: string;
  deadline: string | null;
  createdAt: string;
}

type Page = 'classify' | 'todos' | 'history' | 'settings';

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASSIFIED = 'ClassifiedMap';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CLASS_TIMES = 'ClassTimes';
const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_UI_SCALE = 'UIScale';
const DRAG_THRESHOLD = 160;

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

const PageHeader = ({ title, children }: { title: React.ReactNode, children?: React.ReactNode }) => (
  <div className="page-header">
    <h2 className="page-title">{title}</h2>
    <div className="page-header-actions">{children}</div>
  </div>
);

// SVG Icons for sidebar
// 메시지 분류 아이콘 - 태그/레이블 아이콘
const ClassifyIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>;
// 해야할 일 아이콘 - 체크리스트 아이콘
const TodosIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
// 전체 메시지 아이콘 - 메시지 대화 아이콘
const HistoryIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
const SettingsIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 0 2l-.15.08a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1 0-2l.15-.08a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>;
const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {collapsed ? <><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></> : <><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="6" x2="18" y2="6"/><line x1="3" y1="18" x2="18" y2="18"/></>}
    </svg>
);

function App() {
  const [page, setPage] = useState<Page>('classify');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [udbPath, setUdbPath] = useState<string>('');
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  // 상태 텍스트는 파생값으로 계산합니다
  const [isLoading, setIsLoading] = useState(false);

  const [classified, setClassified] = useState<Record<number, 'left' | 'right'>>({});
  const [deadlines, setDeadlines] = useState<Record<number, string | null>>({});
  const [scheduleModal, setScheduleModal] = useState<{ open: boolean; id?: number }>({ open: false });
  const [manualTodos, setManualTodos] = useState<ManualTodo[]>([]);
  const [addTodoModal, setAddTodoModal] = useState<boolean>(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
  const [activeSearchMessage, setActiveSearchMessage] = useState<Message | null>(null);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);
  const [isLoadingActiveSearch, setIsLoadingActiveSearch] = useState(false);
  const [classTimes, setClassTimes] = useState<string[]>(DEFAULT_CLASS_TIMES);
  const [uiScale, setUiScale] = useState<number>(1.0);
  const HISTORY_PAGE_SIZE = 20;
  
  const wheelLastProcessed = useRef(0);
  
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
      await invoke('set_registry_value', { key, value });
    } catch (e) {
      console.warn('레지스트리 저장 실패', e);
    }
  }, []);

  const loadFromRegistry = useCallback(async () => {
    try {
      const savedPath = await invoke<string | null>('get_registry_value', { key: REG_KEY_UDB });
      if (savedPath) setUdbPath(savedPath);
      
      const savedMap = await invoke<string | null>('get_registry_value', { key: REG_KEY_CLASSIFIED });
      if (savedMap) setClassified(JSON.parse(savedMap) || {});

      const savedDeadlines = await invoke<string | null>('get_registry_value', { key: REG_KEY_DEADLINES });
      if (savedDeadlines) setDeadlines(JSON.parse(savedDeadlines) || {});

      const savedManualTodos = await invoke<string | null>('get_registry_value', { key: REG_KEY_MANUAL_TODOS });
      if (savedManualTodos) setManualTodos(JSON.parse(savedManualTodos) || []);

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

    } catch (e) {
      console.warn('레지스트리 로드 실패', e);
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
    loadFromRegistry();
  }, [loadFromRegistry]);

  const loadUdbFile = useCallback(async (path?: string, offset: number = 0, searchTerm: string = historySearchTerm) => {
    try {
      setIsLoading(true);

      const finalPath = path ?? udbPath;
      if (!finalPath) {
        return;
      }
      
      const result = await invoke<{ messages: Message[]; total_count: number }>('read_udb_messages', { 
        dbPath: finalPath,
        limit: HISTORY_PAGE_SIZE,
        offset,
        searchTerm,
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
  }, [udbPath, historySearchTerm]);

  // UDB 변경 이벤트 구독 (Watchdog에서 발생)
  useEffect(() => {
    const unlistenPromise = listen('udb-changed', async () => {
      if (udbPath) {
        // 히스토리 첫 페이지 및 관련 상태 초기화
        setHistoryIndex(0);
        await loadUdbFile(udbPath, 0, historySearchTerm);
      }
    });
    return () => { void unlistenPromise.then(unlisten => unlisten()); };
  }, [udbPath, loadUdbFile, historySearchTerm]);

  // UDB 경로 변경 시 데이터 다시 로드
  useEffect(() => {
    if (udbPath) {
      setHistoryIndex(0);
      setHistorySearchTerm('');
      void loadUdbFile(udbPath, 0, '');
    }
  }, [udbPath]);

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
  }, [historySearchTerm, udbPath]);

  const pickUdb = useCallback(async () => {
    const selected = await open({ filters: [{ name: 'UDB Files', extensions: ['udb'] }], multiple: false });
    if (typeof selected === 'string') {
      setUdbPath(selected);
      await saveToRegistry(REG_KEY_UDB, selected);
    }
  }, [saveToRegistry]);

  const classify = useCallback((id: number, direction: 'left' | 'right') => {
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

  const keptMessages = useMemo(() => {
    const rightIds = new Set(Object.keys(classified).filter(k => classified[Number(k)] === 'right').map(Number));
    return allMessages
      .filter(m => rightIds.has(m.id))
      .sort((a, b) => {
        const da = deadlines[a.id] || '';
        const db = deadlines[b.id] || '';
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return da.localeCompare(db);
      });
  }, [classified, allMessages, deadlines]);

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

  useEffect(() => {
    if (udbPath) {
      setHistoryIndex(0);
      void loadUdbFile(udbPath, 0);
    }
  }, [udbPath]);

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

  const renderClassifier = () => (
    <div className="classifier page-content">
      <PageHeader title="메시지 분류">
        <button onClick={() => { setHistoryIndex(0); loadUdbFile(udbPath, 0); }} disabled={isLoading} className="load-btn small">
          {isLoading ? '로딩 중...' : '메시지 다시 로드'}
        </button>
        <span className="status">{statusText}</span>
        <button className="complete-all-btn" onClick={completeAllPending} disabled={unclassifiedCount === 0}>전부 완료 처리</button>
      </PageHeader>
      <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
      <div className="classifier-stage">
        {visibleMessages.length === 0 && <div className="empty">분류할 메시지가 없습니다.</div>}
        {visibleMessages.map((msg, idx) => (
          <div key={msg.id} className={`card ${idx === 0 ? 'top' : 'back'}`} onMouseDown={onMouseDown(msg.id)}>
            <div className="card-inner">
              <div className="card-sender">
                {msg.sender}
                {msg.receive_date && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '8px' }}>
                    {formatReceiveDate(msg.receive_date)}
                  </span>
                )}
              </div>
              <div className="card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(msg.content) }} />
              <div className="card-actions">
                <button className="left" onClick={() => classify(msg.id, 'left')}>◀ 완료된 일</button>
                <button className="right" onClick={() => classify(msg.id, 'right')}>해야할 일 ▶</button>
              </div>
            </div>
          </div>
        )).reverse() /* Render back card first */}
      </div>
    </div>
  );

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}. ${month}. ${day}.`;
  };

  const getRemainingTimeInfo = (deadline: string | null) => {
    if (!deadline) return { text: '', color: 'var(--text-secondary)' };

    const now = new Date();
    const deadlinedate = new Date(deadline);
    const diff = deadlinedate.getTime() - now.getTime();

    // Overdue
    if (diff < 0) {
      const days = Math.floor(Math.abs(diff) / (1000 * 60 * 60 * 24));
      if (days > 0) {
        return { text: `${days}일 지남`, color: 'var(--danger)' };
      }
      const hours = Math.floor(Math.abs(diff) / (1000 * 60 * 60));
      if (hours > 0) {
        return { text: `${hours}시간 지남`, color: 'var(--danger)' };
      }
      const minutes = Math.floor(Math.abs(diff) / (1000 * 60));
      return { text: `${minutes}분 지남`, color: 'var(--danger)' };
    }

    // Upcoming
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 24) {
      if (hours > 0) {
        return { text: `${hours}시간 남음`, color: 'var(--danger)' };
      }
      const minutes = Math.floor(diff / (1000 * 60));
      return { text: `${minutes}분 남음`, color: 'var(--danger)' };
    }

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days <= 3) {
      return { text: `${days}일 남음`, color: 'var(--danger)' };
    }
    if (days <= 7) {
      return { text: `${days}일 남음`, color: 'var(--warning)' };
    }
    return { text: `${days}일 남음`, color: 'var(--text-secondary)' };
  };

  // 날짜 파싱 함수: 다양한 형식의 날짜 문자열을 파싱하여 ISO 날짜 문자열과 시간을 반환
  const parseDateFromText = (text: string, baseDate?: Date): { date: string | null; time: string | null } => {
    const now = baseDate || new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const pad = (n: number) => n.toString().padStart(2, '0');
    
    // 텍스트 정규화 (공백 제거, 소문자 변환)
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    
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

  const renderTodos = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (7 - today.getDay()));
    const endOfNextWeek = new Date(endOfWeek);
    endOfNextWeek.setDate(endOfWeek.getDate() + 7);

    const getColorForDeadline = (deadline: string | null) => {
      if (!deadline) return 'var(--text-secondary)';
      const deadlineDate = new Date(deadline);
      if (deadlineDate < today) return 'var(--danger)';
      if (deadlineDate >= today && deadlineDate < tomorrow) return 'var(--danger)';
      if (deadlineDate >= tomorrow && deadlineDate < new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) return 'var(--warning)';
      if (deadlineDate >= tomorrow && deadlineDate <= endOfWeek) return 'var(--primary)';
      if (deadlineDate > endOfWeek && deadlineDate <= endOfNextWeek) return 'var(--primary-light)';
      return 'var(--text-secondary)';
    };

    // 메시지 기반 할 일과 직접 추가한 할 일을 합침
    const allTodos: Array<{ id: number; content: string; deadline: string | null; sender?: string; isManual?: boolean; receive_date?: string | null }> = [
      ...keptMessages.map(m => ({ id: m.id, content: m.content, deadline: deadlines[m.id] || null, sender: m.sender, isManual: false, receive_date: m.receive_date })),
      ...manualTodos.map(t => ({ id: t.id, content: t.content, deadline: t.deadline, isManual: true }))
    ];

    // 전체 항목을 먼저 정렬 (마감일 시간 순으로 전체 정렬, 수동 추가 항목은 같은 조건에서 뒤로)
    allTodos.sort((a, b) => {
      // 둘 다 마감일이 있으면 마감일 시간 순으로 정렬
      if (a.deadline && b.deadline) {
        const deadlineDiff = new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
        if (deadlineDiff !== 0) return deadlineDiff;
        // 마감일 시간이 같으면 수동 추가 항목을 뒤로
        if (a.isManual !== b.isManual) {
          return a.isManual ? 1 : -1;
        }
        return a.id - b.id;
      }
      // 마감일이 있는 항목이 먼저
      if (a.deadline && !b.deadline) return -1;
      if (!a.deadline && b.deadline) return 1;
      // 둘 다 마감일이 없으면 수동 추가 항목을 뒤로
      if (a.isManual !== b.isManual) {
        return a.isManual ? 1 : -1;
      }
      return a.id - b.id;
    });

    const tasksWithDeadlines = allTodos
      .filter(t => t.deadline)
      .sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime());

    const groupedTasks = tasksWithDeadlines.reduce((acc, t) => {
      const date = formatDate(t.deadline!);
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(t);
      return acc;
    }, {} as Record<string, typeof allTodos>);

    const groupedTodos = allTodos.reduce((acc, t) => {
      const date = t.deadline ? formatDate(t.deadline) : '마감 없음';
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(t);
      return acc;
    }, {} as Record<string, typeof allTodos>);

    // 그룹화는 이미 정렬된 순서를 유지하므로 별도 정렬 불필요

    const sortedGroups = Object.entries(groupedTodos).sort((a, b) => {
      const dateA = a[0];
      const dateB = b[0];
      if (dateA === '마감 없음') return 1;
      if (dateB === '마감 없음') return -1;
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    });

    return (
      <div className="timeline page-content">
        <PageHeader title={`타임라인 (${allTodos.length})`}>
          <div className="todo-summary simple">
            <div className="spark-line">
              {Object.entries(groupedTasks).map(([date, tasks]) => {
                const firstTaskDeadline = tasks.length > 0 ? tasks[0].deadline : null;
                const remainingTime = getRemainingTimeInfo(firstTaskDeadline);
                return (
                  <div key={date} className="spark-line-group">
                    {remainingTime.text && (
                      <span className="spark-line-remaining" style={{ color: remainingTime.color }}>
                        {remainingTime.text}
                      </span>
                    )}
                    <span className="spark-line-date">{date}</span>
                    <div className="spark-line-items">
                      {tasks.map(task => (
                        <div
                          key={task.id}
                          className="spark-line-item"
                          style={{ backgroundColor: getColorForDeadline(task.deadline) }}
                          title={task.deadline ? `마감: ${new Date(task.deadline).toLocaleString()}` : '마감 없음'}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <button onClick={() => setAddTodoModal(true)} className="add-todo-btn">
            할 일 추가
          </button>
        </PageHeader>
        <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
        {allTodos.length === 0 ? (
          <p>할 일이 없습니다. 할 일을 추가해보세요.</p>
        ) : (
          <div>
            {sortedGroups.map(([date, todos]) => {
              const firstTodoDeadline = todos.length > 0 ? todos[0].deadline : null;
              const remainingTime = getRemainingTimeInfo(firstTodoDeadline);

              return (
                <div key={date} className="timeline-group">
                  <div className="timeline-marker">
                    <div className="timeline-date">{date}</div>
                    {remainingTime.text && (
                      <div className="timeline-remaining" style={{ color: remainingTime.color }}>
                        {remainingTime.text}
                      </div>
                    )}
                  </div>
                  <div className="timeline-vline"></div>
                  <div className="timeline-items">
                    {todos.map((todo) => {
                      const deadline = todo.deadline;
                      const remainingTimeForItem = getRemainingTimeInfo(deadline);
                      
                      let deadlineDisplay = '마감 없음';
                      let deadlineTitle = '';
                      if (deadline) {
                        deadlineDisplay = new Date(deadline).toLocaleString(); // Fallback
                        deadlineTitle = deadlineDisplay;
                        if (remainingTimeForItem.text) {
                          deadlineDisplay = remainingTimeForItem.text;
                        }
                      }

                      const handleDelete = () => {
                        if (todo.isManual) {
                          setManualTodos(prev => {
                            const next = prev.filter(t => t.id !== todo.id);
                            void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
                            return next;
                          });
                          // deadlines에서도 제거
                          setDeadlines(prev => {
                            const next = { ...prev };
                            delete next[todo.id];
                            void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
                            return next;
                          });
                        } else {
                          classify(todo.id, 'left');
                        }
                      };

                      const handleSetDeadline = () => {
                        setScheduleModal({ open: true, id: todo.id });
                      };

                      return (
                        <div key={todo.id} className="todo-item">
                          <div className="todo-actions">
                            <span className="deadline-label" title={deadlineTitle} style={{ color: remainingTimeForItem.color }}>
                              {deadlineDisplay}
                            </span>
                            <button onClick={handleSetDeadline}>마감 설정</button>
                            <button onClick={handleDelete}>완료</button>
                          </div>
                          {todo.sender && (
                            <div className="todo-sender">
                              {todo.sender}
                              {(todo as any).receive_date && (
                                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '8px' }}>
                                  {formatReceiveDate((todo as any).receive_date)}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="todo-content" dangerouslySetInnerHTML={{ __html: decodeEntities(todo.content) }} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Lazy loading을 위한 가시 범위 계산
  // 전체 메시지 탭은 이제 allMessages가 페이지 단위이므로 직접 사용합니다.

  // 휠 이벤트로 카드 넘기기 및 추가 데이터 로드
  const handleHistoryWheel = useCallback((e: React.WheelEvent) => {
    if (isLoading) return;

    const now = Date.now();
    if (now - wheelLastProcessed.current < 100) { // 100ms 딜레이
      return;
    }

    let isActionTaken = false;

    // 휠을 아래로 내릴 때 (다음 메시지)
    if (e.deltaY > 0) {
      if (historyIndex < allMessages.length - 1) {
        setHistoryIndex(prev => prev + 1);
        isActionTaken = true;
      }
      
      // 로드된 메시지의 끝에 가까워지면 다음 페이지 로드
      const loadThreshold = 5; // 5개 남았을 때 미리 로드
      if (historyIndex >= allMessages.length - loadThreshold && allMessages.length < totalMessageCount) {
        loadUdbFile(udbPath, allMessages.length, historySearchTerm);
        isActionTaken = true; // 데이터 로드도 액션으로 간주
      }
    } 
    // 휠을 위로 올릴 때 (이전 메시지)
    else if (e.deltaY < 0 && historyIndex > 0) {
      setHistoryIndex(prev => prev - 1);
      isActionTaken = true;
    }

    if (isActionTaken) {
      wheelLastProcessed.current = now;
    }
  }, [historyIndex, allMessages.length, totalMessageCount, isLoading, udbPath, loadUdbFile, historySearchTerm]);

  // 드래그 이벤트 핸들러를 위한 ref
  const historyDragRef = useRef({ startX: 0, dragging: false });

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

  const historyOnMouseDown = useCallback((e: React.MouseEvent) => {
    historyDragRef.current.dragging = true;
    historyDragRef.current.startX = e.clientX;

    const onMouseMove = (e: MouseEvent) => {
      if (!historyDragRef.current.dragging) return;
      const dx = e.clientX - historyDragRef.current.startX;
      const threshold = 100;
      if (dx > threshold && historyIndex > 0) {
        setHistoryIndex(prev => prev - 1);
        historyDragRef.current.dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      } else if (dx < -threshold && historyIndex < allMessages.length - 1) {
        setHistoryIndex(prev => prev + 1);
        historyDragRef.current.dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
    };

    const onMouseUp = () => {
      historyDragRef.current.dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [historyIndex, allMessages.length]);

  // 키보드 이벤트로 메시지 넘기기
  const handleHistoryKeyDown = useCallback((e: KeyboardEvent) => {
    if (page !== 'history' || isLoading) return;
    
    // 입력 필드에 포커스가 있으면 키보드 이벤트 무시
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    const now = Date.now();
    if (now - wheelLastProcessed.current < 100) {
      return;
    }

    let isActionTaken = false;

    // 우측/아래 키: 다음 메시지
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      if (historyIndex < allMessages.length - 1) {
        setHistoryIndex(prev => prev + 1);
        isActionTaken = true;
      }
      
      // 로드된 메시지의 끝에 가까워지면 다음 페이지 로드
      const loadThreshold = 5;
      if (historyIndex >= allMessages.length - loadThreshold && allMessages.length < totalMessageCount) {
        loadUdbFile(udbPath, allMessages.length, historySearchTerm);
        isActionTaken = true;
      }
    }
    // 좌측/위 키: 이전 메시지
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && historyIndex > 0) {
      setHistoryIndex(prev => prev - 1);
      isActionTaken = true;
    }

    if (isActionTaken) {
      wheelLastProcessed.current = now;
      e.preventDefault();
    }
  }, [page, historyIndex, allMessages.length, totalMessageCount, isLoading, udbPath, loadUdbFile, historySearchTerm]);

  // 키보드 이벤트 리스너 등록
  useEffect(() => {
    window.addEventListener('keydown', handleHistoryKeyDown);
    return () => {
      window.removeEventListener('keydown', handleHistoryKeyDown);
    };
  }, [handleHistoryKeyDown]);

  const renderNormalHistory = () => (
    <>
      <PageHeader title={`전체 메시지 (${totalMessageCount})`}>
        <div className="history-search">
          <input 
            type="text" 
            placeholder="발송자 또는 내용으로 검색..." 
            value={historySearchTerm}
            onChange={(e) => setHistorySearchTerm(e.target.value)}
          />
        </div>
        <div className="history-nav">
          <button 
            onClick={() => setHistoryIndex(prev => Math.max(0, prev - 1))}
            disabled={historyIndex === 0}
            className="nav-btn"
          >
            ← 이전
          </button>
          <span className="history-counter">
            {historyIndex + 1} / {totalMessageCount}
          </span>
          <button 
            onClick={() => {
              const nextIndex = historyIndex + 1;
              if (nextIndex < allMessages.length) {
                setHistoryIndex(nextIndex);
              }
              // 다음 메시지가 로드되지 않았다면 로드
              if (nextIndex >= allMessages.length && allMessages.length < totalMessageCount && !isLoading) {
                loadUdbFile(udbPath, allMessages.length, historySearchTerm);
              }
            }}
            disabled={historyIndex >= totalMessageCount - 1}
            className="nav-btn"
          >
            다음 →
          </button>
        </div>
      </PageHeader>
      <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
      <div className="history-stage" onWheel={handleHistoryWheel}>
        {allMessages.length === 0 ? (
          <p className="empty">메시지가 없습니다.</p>
        ) : (
          <div className="history-card-stack" onMouseDown={historyOnMouseDown}>
            {(() => {
              const renderWindow = 11; // 현재 아이템 기준 앞뒤로 5개씩
              const startIndex = Math.max(0, historyIndex - Math.floor(renderWindow / 2));
              const endIndex = Math.min(allMessages.length, startIndex + renderWindow);

              return allMessages.slice(startIndex, endIndex).map((msg, i) => {
                const idx = startIndex + i; // 원래 인덱스 복원
                const isCurrent = idx === historyIndex;
                const offset = idx - historyIndex;
                const classification = classified[msg.id];
                const deadline = deadlines[msg.id];
                
                return (
                  <div 
                    key={msg.id} 
                    className={`history-card ${isCurrent ? 'current' : 'offset'}`}
                    style={{
                      transform: `translateX(${offset * 20}px) translateY(${Math.abs(offset) * 20}px) scale(${1 - Math.abs(offset) * 0.05})`,
                      zIndex: allMessages.length - Math.abs(offset),
                      opacity: Math.abs(offset) > 3 ? 0 : 1 - Math.abs(offset) * 0.15
                    }}
                  >
                    <div className="history-card-inner">
                      <div className="history-card-header">
                        <span className="history-id">#{msg.id}</span>
                        <span className="history-sender">{msg.sender}</span>
                        {msg.receive_date && (
                          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '8px' }}>
                            {formatReceiveDate(msg.receive_date)}
                          </span>
                        )}
                        {classification && (
                          <span className={`history-badge ${classification}`}>
                            {classification === 'left' ? '완료' : '해야할 일'}
                          </span>
                        )}
                        {deadline && (
                          <span className="history-deadline">
                            {formatDate(deadline)}
                          </span>
                        )}
                        <button 
                          className="history-set-deadline-btn"
                          onClick={() => setScheduleModal({ open: true, id: msg.id })}
                        >
                          마감 설정
                        </button>
                      </div>
                      <div className="history-card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(msg.content) }} />
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </>
  );

  
  
  const SearchResultRowComponent = ({ index, style, results, activeId, onClick }: { index: number, style: React.CSSProperties, ariaAttributes: { "aria-posinset": number, "aria-setsize": number, role: "listitem" }, results: SearchResultItem[], activeId: number | null, onClick: (id: number) => void }) => {
    const item = results[index];
    return (
      <div
        style={style}
        className={`result-item ${activeId === item.id ? 'active' : ''}`}
        onClick={() => onClick(item.id)}
      >
        <div className="result-sender">{item.sender}</div>
        <div className="result-snippet">{item.snippet}</div>
      </div>
    );
  };

  const renderSearchResults = () => {

    return (
      <>
        <PageHeader title={`검색 결과 (${searchResults?.length || 0})`}>
          <div className="history-search">
            <input
              type="text"
              placeholder="발송자 또는 내용으로 검색..."
              value={historySearchTerm}
              onChange={(e) => setHistorySearchTerm(e.target.value)}
            />
          </div>
        </PageHeader>
        <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
        <div className="history-search-layout">
          <div className="history-main-pane">
            {isLoadingActiveSearch && <div className="empty">로딩 중...</div>}
            {!isLoadingActiveSearch && activeSearchMessage && (
              <div className="history-card current">
                <div className="history-card-inner">
                  <div className="history-card-header">
                    <span className="history-id">#{activeSearchMessage.id}</span>
                    <span className="history-sender">{activeSearchMessage.sender}</span>
                    <button
                      className="history-set-deadline-btn"
                      onClick={() => setScheduleModal({ open: true, id: activeSearchMessage.id })}
                    >
                      마감 설정
                    </button>
                  </div>
                  <div className="history-card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(activeSearchMessage.content) }} />
                </div>
              </div>
            )}
            {!isLoadingActiveSearch && !activeSearchMessage && (
              <div className="empty">
                {isLoadingSearch ? '검색 중...' : '검색 결과가 없습니다.'}
              </div>
            )}
          </div>
          <div className="history-results-pane">
            {isLoadingSearch && <div className="empty">검색 중...</div>}
            {!isLoadingSearch && searchResults && (
              <div className="results-list">
                <List<{ results: SearchResultItem[], activeId: number | null, onClick: (id: number) => void }>
                  rowCount={searchResults.length}
                  rowHeight={(index) => {
                    const item = searchResults[index];
                    const isActive = activeSearchMessage?.id === item.id;
                    return isActive ? 120 : 100;
                  }}
                  rowComponent={SearchResultRowComponent}
                  rowProps={{
                    results: searchResults,
                    activeId: activeSearchMessage?.id || null,
                    onClick: handleSearchResultClick,
                  }}
                  overscanCount={5}
                  style={{ height: '100%', width: '100%' }}
                />
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  const renderHistory = () => {
    return (
      <div className="history page-content">
        {historySearchTerm.trim() ? renderSearchResults() : renderNormalHistory()}
      </div>
    );
  };

  const renderSettings = () => {
    const addClassTime = () => {
      const newTime = '0900-0950';
      setClassTimes([...classTimes, newTime]);
    };

    const removeClassTime = (index: number) => {
      setClassTimes(classTimes.filter((_, i) => i !== index));
    };

    const updateClassTime = (index: number, value: string) => {
      const newTimes = [...classTimes];
      newTimes[index] = value;
      setClassTimes(newTimes);
    };

    const saveClassTimes = () => {
      saveToRegistry(REG_KEY_CLASS_TIMES, JSON.stringify(classTimes));
    };

    const formatTimeDisplay = (timeStr: string) => {
      // HHMM-HHMM 형식을 HH:MM - HH:MM로 변환
      const match = timeStr.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
      if (match) {
        return `${match[1]}:${match[2]} - ${match[3]}:${match[4]}`;
      }
      return timeStr;
    };

    return (
      <div className="settings page-content">
        <PageHeader title="설정" />
        <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
        <div className="field">
          <label htmlFor="udbPathInput">UDB 경로</label>
          <div className="row">
            <input id="udbPathInput" type="text" value={udbPath} onChange={(e) => setUdbPath(e.target.value)} placeholder="C:\...\your.udb" />
            <button onClick={pickUdb}>찾기</button>
            <button onClick={() => saveToRegistry(REG_KEY_UDB, udbPath)}>저장</button>
          </div>
        </div>
        <div className="field">
          <label>수업 시간</label>
          <div className="class-times-list">
            {classTimes.map((time, index) => (
              <div key={index} className="class-time-item">
                <input
                  type="text"
                  value={time}
                  onChange={(e) => updateClassTime(index, e.target.value)}
                  placeholder="0830-0920"
                  pattern="\d{4}-\d{4}"
                />
                <span className="class-time-display">{formatTimeDisplay(time)}</span>
                <button onClick={() => removeClassTime(index)} className="remove-btn">삭제</button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: '10px' }}>
            <button onClick={addClassTime}>수업 시간 추가</button>
            <button onClick={saveClassTimes}>저장</button>
          </div>
          <div className="field-description">
            수업 시간 동안에는 새로운 메시지가 와도 창이 자동으로 표시되지 않습니다. 형식: HHMM-HHMM (예: 0830-0920)
          </div>
        </div>
        <br /> <br />
        <div className="field">
          <label htmlFor="uiScaleInput">UI 배율</label>
          <div className="row">
            <input 
              id="uiScaleInput" 
              type="range" 
              min="0.5" 
              max="2.0" 
              step="0.1" 
              value={uiScale} 
              onChange={(e) => {
                const newScale = parseFloat(e.target.value);
                setUiScale(newScale);
                saveToRegistry(REG_KEY_UI_SCALE, newScale.toString());
              }}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: '60px', textAlign: 'right' }}>{(uiScale * 100).toFixed(0)}%</span>
          </div>
          <div className="field-description">
            전체 UI의 크기를 조정합니다. (50% ~ 200%)
          </div>
        </div>
      </div>
    );
  };

  const ScheduleModal = () => {
    if (!scheduleModal.open || scheduleModal.id === undefined) return null;

    const id = scheduleModal.id;
    const isManualTodo = manualTodos.some(t => t.id === id);
    const [modalMsg, setModalMsg] = useState<Message | null>(null);
    const [isLoadingModalMsg, setIsLoadingModalMsg] = useState(false);
    const [dateVal, setDateVal] = useState<string>('');
    const [timeVal, setTimeVal] = useState<string>('');
    const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });
    
    const pad = (n: number) => n.toString().padStart(2, '0');
    const now = new Date();
    const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // 메시지 내용에서 날짜 파싱 및 초기값 설정
    useEffect(() => {
      const current = deadlines[id] || '';
      
      // 이미 deadline이 있으면 그것을 사용
      if (current) {
        const d = new Date(current);
        setDateVal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
        setTimeVal(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
        return;
      }

      // 메시지 내용 파싱
      let contentToParse = '';
      if (isManualTodo) {
        const manualTodo = manualTodos.find(t => t.id === id);
        if (manualTodo) {
          contentToParse = manualTodo.content;
        }
      } else if (modalMsg) {
        contentToParse = modalMsg.content;
      }

      if (contentToParse) {
        // HTML 태그 제거하고 텍스트만 추출
        const textContent = contentToParse.replace(/<[^>]*>/g, '');
        
        // 메시지의 receiveDate를 기준으로 날짜 파싱
        let baseDate: Date | undefined = undefined;
        if (!isManualTodo && modalMsg?.receive_date) {
          try {
            baseDate = new Date(modalMsg.receive_date);
          } catch {
            // 파싱 실패 시 무시
          }
        }
        
        const parsed = parseDateFromText(textContent, baseDate);
        setParsedDateInfo(parsed);
        
        if (parsed.date) {
          setDateVal(parsed.date);
        } else {
          setDateVal(defaultDate);
        }
        
        if (parsed.time) {
          setTimeVal(parsed.time);
        } else {
          setTimeVal(defaultTime);
        }
      } else {
        // 파싱할 내용이 없으면 기본값 사용
        setDateVal(defaultDate);
        setTimeVal(defaultTime);
      }
    }, [id, modalMsg, isManualTodo, manualTodos, deadlines, defaultDate, defaultTime]);

    useEffect(() => {
      if (isManualTodo) {
        // 수동 할 일인 경우 메시지 로드 불필요
        return;
      }
      
      const loadMsg = async () => {
        const found = allMessages.find((m) => m.id === id);
        if (found) {
          setModalMsg(found);
        } else if (udbPath) {
          setIsLoadingModalMsg(true);
          try {
            const msg: Message = await invoke('get_message_by_id', { dbPath: udbPath, id });
            setModalMsg(msg);
            // 메시지를 allMessages에 추가
            setAllMessages(prev => {
              if (prev.find(m => m.id === id)) return prev;
              return [...prev, msg];
            });
          } catch (e) {
            console.error("Failed to load message for modal", e);
          } finally {
            setIsLoadingModalMsg(false);
          }
        }
      };
      void loadMsg();
      
      // 모달이 닫히면 초기화
      return () => {
        setModalMsg(null);
        setIsLoadingModalMsg(false);
        setDateVal('');
        setTimeVal('');
        setParsedDateInfo({ date: null, time: null });
      };
    }, [id, udbPath, allMessages, isManualTodo]);

    const onSave = () => {
      const iso = new Date(`${dateVal}T${timeVal}:00`).toISOString();
      
      if (isManualTodo) {
        // 수동 할 일의 경우 manualTodos 업데이트
        setManualTodos(prev => {
          const next = prev.map(t => t.id === id ? { ...t, deadline: iso } : t);
          void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
          return next;
        });
        // deadlines에도 저장 (일관성 유지)
        setDeadlines(prev => {
          const next = { ...prev, [id]: iso };
          void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
          return next;
        });
      } else {
        setDeadlines(prev => {
          const next = { ...prev, [id]: iso };
          void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
          return next;
        });
        if (classified[id] !== 'right') {
          setClassified(prev => {
            const next = { ...prev, [id]: 'right' as const };
            void saveToRegistry(REG_KEY_CLASSIFIED, JSON.stringify(next));
            return next;
          });
        }
      }
      setScheduleModal({ open: false });
    };

    const onNoDeadline = () => {
      if (isManualTodo) {
        setManualTodos(prev => {
          const next = prev.map(t => t.id === id ? { ...t, deadline: null } : t);
          void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
          return next;
        });
        setDeadlines(prev => {
          const next = { ...prev, [id]: null };
          void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
          return next;
        });
      } else {
        setDeadlines(prev => {
          const next = { ...prev, [id]: null };
          void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
          return next;
        });
      }
      setScheduleModal({ open: false });
    };

    const manualTodo = isManualTodo ? manualTodos.find(t => t.id === id) : null;

    return (
        <div className="schedule-modal-overlay" onClick={() => setScheduleModal({ open: false }) }>
            <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
              <div className="schedule-inner">
                <div className="schedule-preview">
                  {isManualTodo ? (
                    manualTodo ? (
                      <div dangerouslySetInnerHTML={{ __html: decodeEntities(manualTodo.content) }} />
                    ) : (
                      <div>할 일을 불러올 수 없습니다.</div>
                    )
                  ) : isLoadingModalMsg ? (
                    <div>로딩 중...</div>
                  ) : modalMsg ? (
                    <div dangerouslySetInnerHTML={{ __html: decodeEntities(modalMsg.content) }} />
                  ) : (
                    <div>메시지를 불러올 수 없습니다.</div>
                  )}
                </div>
                <div className="schedule-panel">
                  <h3>완료 시간 설정</h3>
                  {parsedDateInfo.date && (
                    <div style={{ 
                      marginBottom: '12px', 
                      padding: '8px', 
                      backgroundColor: 'var(--bg-light)', 
                      borderRadius: 'var(--radius)',
                      fontSize: '13px',
                      color: 'var(--primary)'
                    }}>
                      📅 날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
                    </div>
                  )}
                  <label htmlFor="deadline-date">날짜</label>
                  <input 
                    id="deadline-date" 
                    type="date" 
                    value={dateVal || defaultDate}
                    onChange={(e) => setDateVal(e.target.value)} 
                  />
                  <label htmlFor="deadline-time">시간</label>
                  <input 
                    id="deadline-time" 
                    type="time" 
                    value={timeVal || defaultTime}
                    onChange={(e) => setTimeVal(e.target.value)} 
                  />
                  <div className="row">
                    <button onClick={onSave}>저장</button>
                    <button onClick={onNoDeadline}>완료 시간 없음</button>
                    <button onClick={() => setScheduleModal({ open: false })}>취소</button>
                  </div>
                </div>
              </div>
            </div>
        </div>
    );
  };

  const AddTodoModal = () => {
    if (!addTodoModal) return null;

    const [content, setContent] = useState<string>('');
    const [deadlineDate, setDeadlineDate] = useState<string>('');
    const [deadlineTime, setDeadlineTime] = useState<string>('');
    const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });

    const pad = (n: number) => n.toString().padStart(2, '0');
    const now = new Date();
    const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    // 텍스트 변경 시 날짜 자동 파싱
    const handleContentChange = (newContent: string) => {
      setContent(newContent);
      
      // 날짜 파싱 시도
      const parsed = parseDateFromText(newContent);
      setParsedDateInfo(parsed);
      
      // 파싱된 날짜가 있으면 자동으로 설정 (사용자가 수동으로 변경하지 않은 경우에만)
      if (parsed.date && !deadlineDate) {
        setDeadlineDate(parsed.date);
      }
      if (parsed.time && !deadlineTime) {
        setDeadlineTime(parsed.time);
      }
    };

    const onSave = () => {
      if (!content.trim()) {
        alert('할 일 내용을 입력해주세요.');
        return;
      }

      const newId = Date.now(); // 타임스탬프 기반 ID 생성 (메시지 ID와 충돌 방지)
      const deadline = deadlineDate && deadlineTime 
        ? new Date(`${deadlineDate}T${deadlineTime}:00`).toISOString()
        : null;

      const newTodo: ManualTodo = {
        id: newId,
        content: content.trim(),
        deadline,
        createdAt: new Date().toISOString(),
      };

      setManualTodos(prev => {
        const next = [...prev, newTodo];
        void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
        return next;
      });

      // deadline이 있으면 deadlines에도 저장
      if (deadline) {
        setDeadlines(prev => {
          const next = { ...prev, [newId]: deadline };
          void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
          return next;
        });
      }

      setContent('');
      setDeadlineDate('');
      setDeadlineTime('');
      setParsedDateInfo({ date: null, time: null });
      setAddTodoModal(false);
    };

    return (
      <div className="schedule-modal-overlay" onClick={() => setAddTodoModal(false)}>
        <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
          <div className="schedule-inner">
            <div className="schedule-preview">
              <div style={{ padding: '16px' }}>
                <h3 style={{ marginBottom: '12px' }}>할 일 내용</h3>
                <textarea
                  value={content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  placeholder="할 일 내용을 입력하세요... (예: 내일까지 과제 제출, 12월 25일 오후 3시 회의)"
                  style={{
                    width: '100%',
                    minHeight: '200px',
                    padding: '12px',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius)',
                    fontSize: '15px',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  }}
                />
                {parsedDateInfo.date && (
                  <div style={{ 
                    marginTop: '8px', 
                    padding: '8px', 
                    backgroundColor: 'var(--bg-light)', 
                    borderRadius: 'var(--radius)',
                    fontSize: '13px',
                    color: 'var(--primary)'
                  }}>
                    📅 날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
                  </div>
                )}
              </div>
            </div>
            <div className="schedule-panel">
              <h3>마감 시간 설정</h3>
              <label htmlFor="add-todo-deadline-date">날짜</label>
              <input 
                id="add-todo-deadline-date" 
                type="date" 
                value={deadlineDate || defaultDate}
                onChange={(e) => setDeadlineDate(e.target.value)} 
              />
              <label htmlFor="add-todo-deadline-time">시간</label>
              <input 
                id="add-todo-deadline-time" 
                type="time" 
                value={deadlineTime || defaultTime}
                onChange={(e) => setDeadlineTime(e.target.value)} 
              />
              <div className="row">
                <button onClick={onSave}>저장</button>
                <button onClick={() => {
                  setContent('');
                  setDeadlineDate('');
                  setDeadlineTime('');
                  setParsedDateInfo({ date: null, time: null });
                  setAddTodoModal(false);
                }}>취소</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app with-sidebar">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-top">
          <h1><span className='icon'></span><span className="label">HyperCool</span></h1>
          <button className="collapse" onClick={() => setSidebarCollapsed(v => !v)} title={sidebarCollapsed ? '펼치기' : '접기'}>
            <CollapseIcon collapsed={sidebarCollapsed} />
          </button>
        </div>
        <nav>
          <button className={page === 'classify' ? 'active' : ''} onClick={() => setPage('classify')}>
            <span className="icon"><ClassifyIcon /></span><span className="label">메시지 분류</span>
          </button>
          <button className={page === 'todos' ? 'active' : ''} onClick={() => setPage('todos')}>
            <span className="icon"><TodosIcon /></span><span className="label">해야할 일</span>
          </button>
          <button className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>
            <span className="icon"><HistoryIcon /></span><span className="label">전체 메시지</span>
          </button>
        </nav>
        <nav className="sidebar-bottom-nav">
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            <span className="icon"><SettingsIcon /></span><span className="label">설정</span>
          </button>
        </nav>
      </aside>
      <main className="content">
        {page === 'classify' && renderClassifier()}
        {page === 'todos' && renderTodos()}
        {page === 'history' && renderHistory()}
        {page === 'settings' && renderSettings()}
        <ScheduleModal />
        <AddTodoModal />
      </main>
    </div>
  );
}

export default App;