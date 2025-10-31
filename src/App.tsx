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
}

interface SearchResultItem {
  id: number;
  sender: string;
  snippet: string;
}

type Page = 'classify' | 'todos' | 'history' | 'settings';

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASSIFIED = 'ClassifiedMap';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CLASS_TIMES = 'ClassTimes';
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
  const [historyIndex, setHistoryIndex] = useState(0);
  const [totalMessageCount, setTotalMessageCount] = useState(0);
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[] | null>(null);
  const [activeSearchMessage, setActiveSearchMessage] = useState<Message | null>(null);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);
  const [isLoadingActiveSearch, setIsLoadingActiveSearch] = useState(false);
  const [classTimes, setClassTimes] = useState<string[]>(DEFAULT_CLASS_TIMES);
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

    } catch (e) {
      console.warn('레지스트리 로드 실패', e);
    }
  }, [saveToRegistry]);

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
              <div className="card-sender">{msg.sender}</div>
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

    const tasksWithDeadlines = keptMessages
      .filter(m => deadlines[m.id])
      .sort((a, b) => new Date(deadlines[a.id]!).getTime() - new Date(deadlines[b.id]!).getTime());

    const groupedTasks = tasksWithDeadlines.reduce((acc, m) => {
      const date = formatDate(deadlines[m.id]!);
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(m);
      return acc;
    }, {} as Record<string, Message[]>);

    const groupedMessages = keptMessages.reduce((acc, m) => {
      const deadline = deadlines[m.id];
      const date = deadline ? formatDate(deadline) : '마감 없음';
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(m);
      return acc;
    }, {} as Record<string, Message[]>);

    const sortedGroups = Object.entries(groupedMessages).sort((a, b) => {
      const dateA = a[0];
      const dateB = b[0];
      if (dateA === '마감 없음') return 1;
      if (dateB === '마감 없음') return -1;
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    });

    return (
      <div className="timeline page-content">
        <PageHeader title={`타임라인 (${keptMessages.length})`}>
          <div className="todo-summary simple">
            <div className="spark-line">
              {Object.entries(groupedTasks).map(([date, tasks]) => {
                const firstTaskDeadline = tasks.length > 0 ? deadlines[tasks[0].id] : null;
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
                      {tasks.map(m => (
                        <div
                          key={m.id}
                          className="spark-line-item"
                          style={{ backgroundColor: getColorForDeadline(deadlines[m.id]) }}
                          title={`마감: ${new Date(deadlines[m.id]!).toLocaleString()}`}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </PageHeader>
        <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
        {keptMessages.length === 0 ? (
          <p>오른쪽으로 분류된 메시지가 없습니다.</p>
        ) : (
          <div>
            {sortedGroups.map(([date, messages]) => {
              const firstMessageDeadline = messages.length > 0 ? deadlines[messages[0].id] : null;
              const remainingTime = getRemainingTimeInfo(firstMessageDeadline);

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
                    {messages.map((m) => {
                      const deadline = deadlines[m.id];
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

                      return (
                        <div key={m.id} className="todo-item">
                          <div className="todo-actions">
                            <span className="deadline-label" title={deadlineTitle} style={{ color: remainingTimeForItem.color }}>
                              {deadlineDisplay}
                            </span>
                            <button onClick={() => setScheduleModal({ open: true, id: m.id })}>마감 설정</button>
                            <button onClick={() => classify(m.id, 'left')}>완료</button>
                          </div>
                          <div className="todo-sender">{m.sender}</div>
                          <div className="todo-content" dangerouslySetInnerHTML={{ __html: decodeEntities(m.content) }} />
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
                  style={{ width: '120px', fontFamily: 'monospace' }}
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
      </div>
    );
  };

  const ScheduleModal = () => {
    if (!scheduleModal.open || scheduleModal.id === undefined) return null;

    const id = scheduleModal.id;
    const [modalMsg, setModalMsg] = useState<Message | null>(null);
    const [isLoadingModalMsg, setIsLoadingModalMsg] = useState(false);
    
    useEffect(() => {
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
      };
    }, [id, udbPath, allMessages]);

    const current = deadlines[id] || '';
    const d = current ? new Date(current) : new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const [defDate, defTime] = [
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    ];

    let dateVal = defDate;
    let timeVal = defTime;

    const onSave = () => {
      const iso = new Date(`${dateVal}T${timeVal}:00`).toISOString();
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
      setScheduleModal({ open: false });
    };

    const onNoDeadline = () => {
      setDeadlines(prev => {
        const next = { ...prev, [id]: null };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
      setScheduleModal({ open: false });
    };

    return (
        <div className="schedule-modal-overlay" onClick={() => setScheduleModal({ open: false }) }>
            <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
              <div className="schedule-inner">
                <div className="schedule-preview">
                  {isLoadingModalMsg ? (
                    <div>로딩 중...</div>
                  ) : modalMsg ? (
                    <div dangerouslySetInnerHTML={{ __html: decodeEntities(modalMsg.content) }} />
                  ) : (
                    <div>메시지를 불러올 수 없습니다.</div>
                  )}
                </div>
                <div className="schedule-panel">
                  <h3>완료 시간 설정</h3>
                  <label htmlFor="deadline-date">날짜</label>
                  <input id="deadline-date" type="date" defaultValue={defDate} onChange={(e) => (dateVal = e.target.value)} />
                  <label htmlFor="deadline-time">시간</label>
                  <input id="deadline-time" type="time" defaultValue={defTime} onChange={(e) => (timeVal = e.target.value)} />
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
      </main>
    </div>
  );
}

export default App;