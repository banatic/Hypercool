import { useEffect, useMemo, useState, useCallback } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import './App.css';

interface Message {
  id: number;
  content: string; 
}

type Page = 'classify' | 'todos' | 'settings';

const REG_KEY_UDB = 'UdbPath';
const REG_KEY_CLASSIFIED = 'ClassifiedMap';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const DRAG_THRESHOLD = 160;

// SVG Icons for sidebar
const ClassifyIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>;
const TodosIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15.5 22a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-.5z"/><path d="M2 11.5a.5.5 0 0 1 .5-.5h19a.5.5 0 0 1 0 1h-19a.5.5 0 0 1-.5-.5z"/><path d="m12 2-7.07 7.07a1 1 0 0 0 0 1.41L12 17.5l7.07-7.07a1 1 0 0 0 0-1.41L12 2z"/></svg>;
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

  const loadFromRegistry = useCallback(async () => {
    try {
      const savedPath = await invoke<string | null>('get_registry_value', { key: REG_KEY_UDB });
      if (savedPath) setUdbPath(savedPath);
      
      const savedMap = await invoke<string | null>('get_registry_value', { key: REG_KEY_CLASSIFIED });
      if (savedMap) setClassified(JSON.parse(savedMap) || {});

      const savedDeadlines = await invoke<string | null>('get_registry_value', { key: REG_KEY_DEADLINES });
      if (savedDeadlines) setDeadlines(JSON.parse(savedDeadlines) || {});

    } catch (e) {
      console.warn('레지스트리 로드 실패', e);
    }
  }, []);

  const saveToRegistry = useCallback(async (key: string, value: string) => {
    try {
      await invoke('set_registry_value', { key, value });
    } catch (e) {
      console.warn('레지스트리 저장 실패', e);
    }
  }, []);

  useEffect(() => {
    loadFromRegistry();
  }, [loadFromRegistry]);

  const loadUdbFile = useCallback(async (path?: string) => {
    try {
      setIsLoading(true);

      const finalPath = path ?? udbPath;
      if (!finalPath) {
        return;
      }

      const messages: Message[] = await invoke('read_udb_messages', { dbPath: finalPath });
      setAllMessages(messages);
      setVisiblePairStart(0);
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
        await loadUdbFile(udbPath);
      }
    });
    return () => { void unlistenPromise.then(unlisten => unlisten()); };
  }, [udbPath, loadUdbFile]);

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

  useEffect(() => {
    if (udbPath) {
      void loadUdbFile(udbPath);
    }
  }, [udbPath, loadUdbFile]);

  const totalCount = allMessages.length;
  const unclassifiedCount = pendingIndexes.length;
  const statusText = isLoading ? '로딩 중...' : `총 메시지 ${totalCount}개 / 미분류 ${unclassifiedCount}개`;

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
    <div className="classifier">
      <div className="classifier-header">
        <button onClick={() => loadUdbFile()} disabled={isLoading} className="load-btn small">
          {isLoading ? '로딩 중...' : '메시지 다시 로드'}
        </button>
        <span className="status">{statusText}</span>
        <button className="complete-all-btn" onClick={completeAllPending} disabled={unclassifiedCount === 0}>전부 완료 처리</button>
        <button className="title-x" onClick={onHideToTray} title="트레이로 숨기기">×</button>
      </div>
      <div className="classifier-stage">
        {visibleMessages.length === 0 && <div className="empty">분류할 메시지가 없습니다.</div>}
        {visibleMessages.map((msg, idx) => (
          <div key={msg.id} className={`card ${idx === 0 ? 'top' : 'back'}`} onMouseDown={onMouseDown(msg.id)}>
            <div className="card-inner">
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

  const renderTodos = () => (
    <div className="todos">
      <h2>해야할 일 ({keptMessages.length})</h2>
      {keptMessages.length === 0 ? (
        <p>오른쪽으로 분류된 메시지가 없습니다.</p>
      ) : (
        <ul className="todo-list">
          {keptMessages.map((m) => (
            <li key={m.id}>
              <div className="todo-item">
                <div className="todo-content" dangerouslySetInnerHTML={{ __html: decodeEntities(m.content) }} />
                <div className="todo-actions">
                  <span className="deadline-label">{deadlines[m.id] ? `마감: ${new Date(deadlines[m.id]!).toLocaleString()}` : '마감 없음'}</span>
                  <button onClick={() => setScheduleModal({ open: true, id: m.id })}>마감 설정</button>
                  <button onClick={() => classify(m.id, 'left')}>완료</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const renderSettings = () => (
    <div className="settings">
      <h2>설정</h2>
      <div className="field">
        <label htmlFor="udbPathInput">UDB 경로</label>
        <div className="row">
          <input id="udbPathInput" type="text" value={udbPath} onChange={(e) => setUdbPath(e.target.value)} placeholder="C:\...\your.udb" />
          <button onClick={pickUdb}>찾기</button>
          <button onClick={() => saveToRegistry(REG_KEY_UDB, udbPath)}>저장</button>
        </div>
      </div>
    </div>
  );

  const ScheduleModal = () => {
    if (!scheduleModal.open || scheduleModal.id === undefined) return null;

    const id = scheduleModal.id;
    const msg = allMessages.find((m) => m.id === id);
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
                <div className="schedule-preview" dangerouslySetInnerHTML={{ __html: msg ? decodeEntities(msg.content) : '' }} />
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
          <h1><span className='icon'>🚀</span><span className="label">HyperCool</span></h1>
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
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            <span className="icon"><SettingsIcon /></span><span className="label">설정</span>
          </button>
        </nav>
      </aside>
      <main className="content">
        {page === 'classify' && renderClassifier()}
        {page === 'todos' && renderTodos()}
        {page === 'settings' && renderSettings()}
        <ScheduleModal />
      </main>
    </div>
  );
}

export default App;