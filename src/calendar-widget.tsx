import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CalendarWidget } from './calendar-widget/CalendarWidget';
import './styles.css';
import './CalendarWidget.css';

function CalendarWidgetApp() {
  const [isPinned, setIsPinned] = useState(false);

  // 핀 상태 확인
  useEffect(() => {
    const checkPinnedState = async () => {
      try {
        const pinned = await invoke<boolean>('get_calendar_widget_pinned');
        setIsPinned(pinned);
      } catch (e) {
        console.error('핀 상태 확인 실패:', e);
      }
    };
    checkPinnedState();
  }, []);

  // 윈도우 드래그 가능하게 만들기 (핀 상태에 따라)
  useEffect(() => {
    const handleMouseDown = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 핀 버튼 자체는 드래그하지 않음
      if (target.closest('.calendar-pin-btn') || target.closest('.calendar-nav-btn')) {
        return;
      }
      // 핀이 고정된 상태에서만 드래그 가능
      if (isPinned && (target.closest('.calendar-widget-header') || target.closest('.calendar-widget-footer'))) {
        const window = getCurrentWindow();
        await window.startDragging();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isPinned]);

  return <CalendarWidget isPinned={isPinned} onPinnedChange={setIsPinned} />;
}

const rootEl = document.getElementById('root')!;
const root = (rootEl as any).__viteReactRoot ?? ReactDOM.createRoot(rootEl);
(rootEl as any).__viteReactRoot = root;
root.render(
  <React.StrictMode>
    <CalendarWidgetApp />
  </React.StrictMode>
);
