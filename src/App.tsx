import { useEffect, useMemo, useState, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { Page } from './types';
import { Sidebar } from './components/Sidebar';
import { ClassifierPage } from './components/ClassifierPage';
import { HistoryPage } from './components/HistoryPage';
import { SettingsPage } from './components/SettingsPage';
import { ScheduleModal } from './components/ScheduleModal';
import { UpdateNotificationModal } from './components/UpdateNotificationModal';
import { AuthService } from './auth/AuthService';

import { useSettings } from './hooks/useSettings';
import { useSchedules } from './hooks/useSchedules';
import { useMessages } from './hooks/useMessages';
import { useSync } from './hooks/useSync';
import { useDeepLink } from './hooks/useDeepLink';
import { useUpdateChecker } from './hooks/useUpdateChecker';
import { useGlobalEvents } from './hooks/useGlobalEvents';

import './App.css';

const DRAG_THRESHOLD = 160;

function App() {
  const [page, setPage] = useState<Page>('classify');
  const [scheduleModal, setScheduleModal] = useState<{ open: boolean; id?: number | string }>({ open: false });

  // Custom Hooks
  const { 
    udbPath, setUdbPath, 
    classTimes, setClassTimes, 
    uiScale, setUiScale, 
    skippedUpdateVersion, setSkippedUpdateVersion,
    sidebarCollapsed, setSidebarCollapsed,
    saveToRegistry 
  } = useSettings();

  const { 
    schedules, messageSchedulesMap, 
    loadSchedules 
  } = useSchedules();

  const { 
    allMessages, totalMessageCount, classified, saveClassified, isLoading: isLoadingMessages, 
    loadUdbFile, searchResults, setSearchResults, 
    activeSearchMessage, 
    searchMessages, loadMessageById, 
    isLoadingSearch, isLoadingActiveSearch 
  } = useMessages(udbPath);

  const { 
    handleSync, isSyncing, syncProgress, syncError, lastSyncTime 
  } = useSync(udbPath, loadSchedules);

  const { deepLinkUrl } = useDeepLink();

  // Derived State for Classifier
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

  // Memoize expensive schedule-based calculations
  const deadlines = useMemo(() => 
    Object.fromEntries(
      Object.values(messageSchedulesMap).map(s => [s.referenceId!, s.startDate || null])
    ), [messageSchedulesMap]);

  const calendarTitles = useMemo(() => 
    Object.fromEntries(
      Object.values(messageSchedulesMap).map(s => [s.referenceId!, s.title])
    ), [messageSchedulesMap]);

  const ensureVisiblePairProgress = useCallback(() => {
    setVisiblePairStart((prev) => {
      if (prev + 2 <= pendingIndexes.length) return prev;
      return Math.max(0, pendingIndexes.length - 2);
    });
  }, [pendingIndexes.length]);

  // Initialization
  useEffect(() => {
    AuthService.init();
    loadSchedules();
  }, [loadSchedules]);

  // Deep Link Handling
  useEffect(() => {
    if (deepLinkUrl) {
      // Handle deep link (e.g. open message)
      // Assuming format: hypercool://message?id=123
      try {
        const url = new URL(deepLinkUrl);
        const id = url.searchParams.get('id');
        if (id) {
          const msgId = parseInt(id);
          if (!isNaN(msgId)) {
            loadMessageById(msgId);
            setPage('history'); // Switch to history page to show the message
          }
        }
      } catch (e) {
        console.error('Invalid deep link', e);
      }
    }
  }, [deepLinkUrl, loadMessageById]);

  const { updateNotification, setUpdateNotification } = useUpdateChecker(skippedUpdateVersion || '');

  useGlobalEvents({
    uiScale,
    udbPath,
    loadUdbFile,
    loadSchedules,
    handleSync
  });

  // Classify Logic
  const classify = useCallback((id: number | string, direction: 'left' | 'right') => {
    const numId = Number(id);
    if (isNaN(numId)) return;

    saveClassified({ ...classified, [numId]: direction });
    ensureVisiblePairProgress();
    if (direction === 'right') {
      setScheduleModal({ open: true, id });
    }
  }, [classified, saveClassified, ensureVisiblePairProgress]);

  const completeAllPending = useCallback(() => {
    if (allMessages.length === 0 || pendingIndexes.length === 0) return;
    const next = { ...classified };
    for (const idx of pendingIndexes) {
      const id = allMessages[idx].id;
      if (!next[id]) next[id] = 'left';
    }
    saveClassified(next);
    setVisiblePairStart(0);
  }, [allMessages, pendingIndexes, classified, saveClassified]);

  // Drag Handlers
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
        el.style.transition = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      }
    };

    return { onMouseDown };
  };
  const { onMouseDown } = dragHandlers();

  const pickUdb = useCallback(async () => {
    const selected = await open({ filters: [{ name: 'UDB Files', extensions: ['udb'] }], multiple: false });
    if (typeof selected === 'string') {
      setUdbPath(selected);
      await saveToRegistry('UdbPath', selected);
    }
  }, [saveToRegistry, setUdbPath]);



  // History Page Props
  const [historyIndex, setHistoryIndex] = useState(0);
  const [historySearchTerm, setHistorySearchTerm] = useState('');

  // Debounced Search
  useEffect(() => {
    const handler = setTimeout(() => {
      if (udbPath && historySearchTerm.trim() !== '') {
        searchMessages(historySearchTerm);
      } else {
        setSearchResults(null);
      }
    }, 500);
    return () => clearTimeout(handler);
  }, [historySearchTerm, udbPath, searchMessages, setSearchResults]);

  // Auto-select first search result - DISABLED FOR DEBUGGING
  // useEffect(() => {
  //   if (searchResults && searchResults.length > 0) {
  //     loadMessageById(searchResults[0].id);
  //   }
  // }, [searchResults, loadMessageById]);

  // Use unused variables to silence TS (or remove them if truly unused)
  // schedules, manualTodos, periodSchedules are used in ScheduleModal via useSchedules hook indirectly?
  // No, ScheduleModal uses ScheduleService.
  // But we passed them to ScheduleModal in previous version.
  // In new ScheduleModal, we pass 'schedules' prop.
  // So we need to pass 'schedules' to ScheduleModal.

  const statusText = isLoadingMessages ? '로딩 중...' : `미분류 ${pendingIndexes.length}개`;

  return (
    <div className="app with-sidebar">
      <button className="app-title-x" onClick={() => getCurrentWindow().hide()}>×</button>
      <Sidebar 
        page={page} 
        setPage={setPage} 
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
      />
      <div className={`content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {page === 'classify' && (
          <ClassifierPage
            udbPath={udbPath}
            pickUdb={pickUdb}
            visibleMessages={visibleMessages}
            onMouseDown={onMouseDown}
            classify={classify}
            completeAllPending={completeAllPending}
            statusText={statusText}
            isLoading={isLoadingMessages}
            loadUdbFile={loadUdbFile}
            deadlines={deadlines}
            calendarTitles={calendarTitles}
            isSyncing={isSyncing}
            syncProgress={syncProgress}
            syncError={syncError}
            onSync={() => handleSync()}
          />
        )}
        {page === 'history' && (
          <HistoryPage
            allMessages={allMessages}
            historyIndex={historyIndex}
            setHistoryIndex={setHistoryIndex}
            totalMessageCount={totalMessageCount}
            searchTerm={historySearchTerm}
            setSearchTerm={setHistorySearchTerm}
            searchResults={searchResults}
            activeSearchMessage={activeSearchMessage}
            isLoadingSearch={isLoadingSearch}
            isLoadingActiveSearch={isLoadingActiveSearch}
            onSearchResultClick={(id) => loadMessageById(id)}
            loadUdbFile={loadUdbFile}
            udbPath={udbPath}
            deadlines={deadlines}
            calendarTitles={calendarTitles}
            setScheduleModal={setScheduleModal}
            classified={classified}
          />
        )}
        {page === 'settings' && (
          <SettingsPage
            udbPath={udbPath}
            setUdbPath={setUdbPath}
            pickUdb={pickUdb}
            saveToRegistry={saveToRegistry}
            classTimes={classTimes}
            setClassTimes={(times) => {
              setClassTimes(times);
              saveToRegistry('ClassTimes', JSON.stringify(times));
            }}
            uiScale={uiScale}
            setUiScale={(scale) => {
              setUiScale(scale);
              saveToRegistry('UIScale', scale.toString());
            }}
            isLoadingSync={isSyncing}
            syncProgress={syncProgress}
            syncError={syncError}
            onSync={() => handleSync()}
            lastSyncTime={lastSyncTime}
          />
        )}
      </div>

      {scheduleModal.open && (
        <ScheduleModal
          isOpen={scheduleModal.open}
          onClose={() => setScheduleModal({ open: false })}
          scheduleId={scheduleModal.id}
          onSave={() => {
            loadSchedules();
            handleSync(true);
          }}
          udbPath={udbPath}
          allMessages={[]}  // Empty - ScheduleModal loads content on demand
          schedules={schedules}
        />
      )}

      {updateNotification && (
        <UpdateNotificationModal
          updateInfo={updateNotification}
          onClose={() => setUpdateNotification(null)}
          onSkip={() => {
            setSkippedUpdateVersion(updateNotification.version);
            saveToRegistry('SkippedUpdateVersion', updateNotification.version);
            setUpdateNotification(null);
          }}
        />
      )}
    </div>
  );
}

export default App;
