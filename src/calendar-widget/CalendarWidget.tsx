import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import ResizeHandles from '../components/ResizeHandles';
import { PeriodSchedule } from '../types';
import { CalendarGrid } from './CalendarGrid';
import { AddPeriodModalWidget, AddTodoModalWidget, EditPeriodModalWidget, EditTodoModalWidget } from './modals';
import { TodoItem } from './types';
import { useCalendarData } from './useCalendarData';
import { useTodoDrag } from './useTodoDrag';
import { useExternalLinks, useHolidayRefresh, useSendToBottom } from './useWidgetEffects';
import { parseDateFromText } from './utils';

type Modal =
  | { kind: 'addTodo'; date: Date }
  | { kind: 'editTodo'; todo: TodoItem }
  | { kind: 'addPeriod' }
  | { kind: 'editPeriod'; schedule: PeriodSchedule }
  | null;

interface ContextMenuState {
  x: number;
  y: number;
  todo?: TodoItem;
  schedule?: PeriodSchedule;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const toggleBtnStyle = (on: boolean) => ({
  marginLeft: '10px',
  background: on ? 'rgba(100, 200, 100, 0.3)' : 'rgba(100, 100, 100, 0.3)',
  borderColor: on ? 'rgba(100, 200, 100, 0.6)' : 'rgba(100, 100, 100, 0.6)',
});

const ghostStyle: React.CSSProperties = {
  position: 'fixed',
  left: '0px', // 실제 위치는 드래그 훅이 mousemove 에서 직접 지정
  top: '0px',
  width: '150px',
  pointerEvents: 'none',
  zIndex: 9999,
  opacity: 0.9,
  transform: 'scale(1.05)',
  boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
  backgroundColor: 'rgba(60, 60, 70, 0.95)',
  color: 'white',
  padding: '6px 10px',
  borderRadius: '6px',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  backdropFilter: 'blur(5px)',
};

interface CalendarWidgetProps {
  isPinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
}

export function CalendarWidget({ isPinned = false, onPinnedChange }: CalendarWidgetProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  // 월 전환 방향 — 나온 방향으로 슬라이드 인(공간 일관성, §7)
  const [slideDir, setSlideDir] = useState<'next' | 'prev' | null>(null);
  // 완료 항목 묶음을 항상 펼쳐 둘지 (푸터 토글, 레지스트리 CalendarShowCompleted)
  const [showCompleted, setShowCompleted] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const data = useCalendarData();
  const drag = useTodoDrag({
    allTodos: data.allTodos,
    onDrop: data.moveTodo,
    onClick: (todo) => setModal({ kind: 'editTodo', todo }),
  });

  useSendToBottom();
  useHolidayRefresh();
  useExternalLinks();

  useEffect(() => {
    invoke<string | null>('get_registry_value', { key: 'CalendarShowCompleted' })
      .then(v => setShowCompleted(v === '1'))
      .catch(() => {});
  }, []);

  const closeModal = () => setModal(null);

  const goToMonth = (offset: number) => {
    setSlideDir(offset > 0 ? 'next' : 'prev');
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1));
  };

  const goToToday = () => {
    setSlideDir(null);
    setCurrentDate(new Date());
  };

  const toggleShowCompleted = () => {
    const next = !showCompleted;
    setShowCompleted(next);
    invoke('set_registry_value', { key: 'CalendarShowCompleted', value: next ? '1' : '0' })
      .catch(e => console.error('완료 펼치기 저장 실패:', e));
  };

  const togglePinned = async () => {
    const newPinnedState = !isPinned;
    try {
      await invoke('set_calendar_widget_pinned', { pinned: newPinnedState });
      onPinnedChange?.(newPinnedState);
    } catch (e) {
      console.error('핀 상태 변경 실패:', e);
    }
  };

  const draggedTodo = drag.isDragging && drag.draggedTodoId
    ? data.allTodos.find(t => t.id === drag.draggedTodoId)
    : undefined;

  return (
    <div className="calendar-widget">
      <ResizeHandles enabled={isPinned} />
      <div className="calendar-widget-header">
        <button onClick={() => goToMonth(-1)} className="calendar-nav-btn">‹</button>
        <div className="calendar-month-year">
          {currentDate.getFullYear()}년 {currentDate.getMonth() + 1}월
        </div>
        <button onClick={() => goToMonth(1)} className="calendar-nav-btn">›</button>
      </div>
      <div className="calendar-weekdays">
        {WEEKDAYS.map(d => <div key={d} className="calendar-weekday">{d}</div>)}
      </div>
      <CalendarGrid
        currentDate={currentDate}
        slideDir={slideDir}
        allTodos={data.allTodos}
        todoOrder={data.todoOrder}
        periodSchedules={data.periodSchedules}
        showCompleted={showCompleted}
        draggedTodoId={drag.draggedTodoId}
        dragOverDateKey={drag.dragOverDateKey}
        dragOverTodoId={drag.dragOverTodoId}
        dragOverPosition={drag.dragOverPosition}
        onTodoMouseDown={drag.handleMouseDown}
        onDayDoubleClick={(date) => setModal({ kind: 'addTodo', date })}
        onTodoClick={(todo) => setModal({ kind: 'editTodo', todo })}
        onPeriodClick={(schedule) => setModal({ kind: 'editPeriod', schedule })}
        onContextMenu={(x, y, target) => setContextMenu({ x, y, ...target })}
      />
      <div className="calendar-footer-trigger"></div>
      <div className="calendar-widget-footer">
        <button onClick={goToToday} className="calendar-today-btn">오늘</button>
        <button
          onClick={() => setModal({ kind: 'addPeriod' })}
          className="calendar-today-btn"
          style={{ marginLeft: '10px', background: 'rgba(255, 165, 0, 0.3)', borderColor: 'rgba(255, 165, 0, 0.6)' }}
        >
          기간 일정 등록
        </button>
        <button onClick={toggleShowCompleted} className="calendar-today-btn" style={toggleBtnStyle(showCompleted)}>
          {showCompleted ? '완료 접기' : '완료 펼치기'}
        </button>
        <button
          onClick={togglePinned}
          className="calendar-today-btn calendar-pin-btn"
          style={toggleBtnStyle(isPinned)}
          title={isPinned ? '고정 해제' : '고정'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        </button>
      </div>
      {modal?.kind === 'addTodo' && (
        <AddTodoModalWidget
          selectedDate={modal.date}
          onClose={closeModal}
          onSave={async (content, calendarTitle, date, time) => {
            if (await data.addTodo(content, calendarTitle, date, time)) closeModal();
          }}
          parseDateFromText={parseDateFromText}
        />
      )}
      {modal?.kind === 'editTodo' && (
        <EditTodoModalWidget
          todo={modal.todo}
          manualTodos={data.manualTodos}
          deadlines={data.deadlines}
          calendarTitles={data.calendarTitles}
          onClose={closeModal}
          onSave={async (content, calendarTitle, date, time) => {
            await data.editTodo(modal.todo, content, calendarTitle, date, time);
            closeModal();
          }}
          parseDateFromText={parseDateFromText}
        />
      )}
      {modal?.kind === 'addPeriod' && (
        <AddPeriodModalWidget
          onClose={closeModal}
          onSave={async (content, calendarTitle, start, end) => {
            if (await data.addPeriod(content, calendarTitle, start, end)) closeModal();
          }}
        />
      )}
      {modal?.kind === 'editPeriod' && (
        <EditPeriodModalWidget
          schedule={modal.schedule}
          onClose={closeModal}
          onSave={async (content, calendarTitle, start, end) => {
            if (await data.editPeriod(modal.schedule, content, calendarTitle, start, end)) closeModal();
          }}
        />
      )}
      {contextMenu && (
        <>
          <div
            className="calendar-context-menu-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="calendar-context-menu"
            style={{ position: 'fixed', left: `${contextMenu.x}px`, top: `${contextMenu.y}px`, zIndex: 10000 }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.todo && (
              <>
                <div
                  className="calendar-context-menu-item"
                  onClick={async () => {
                    await data.toggleTodoCompletion(contextMenu.todo!);
                    setContextMenu(null);
                  }}
                >
                  {contextMenu.todo.isCompleted ? '완료 취소' : '완료'}
                </div>
                <div
                  className="calendar-context-menu-item"
                  onClick={async () => {
                    if (await data.deleteTodo(contextMenu.todo!)) setContextMenu(null);
                  }}
                >
                  삭제
                </div>
              </>
            )}
            {contextMenu.schedule && (
              <div
                className="calendar-context-menu-item"
                onClick={async () => {
                  if (await data.deletePeriodSchedule(contextMenu.schedule!)) setContextMenu(null);
                }}
              >
                삭제
              </div>
            )}
          </div>
        </>
      )}
      {drag.isDragging && drag.draggedTodoId && createPortal(
        <div ref={drag.ghostRef} style={ghostStyle}>
          {draggedTodo?.content.replace(/<[^>]*>/g, '') || 'Dragging...'}
        </div>,
        document.body
      )}
    </div>
  );
}
