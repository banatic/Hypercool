import React from 'react';
import { PeriodSchedule } from '../types';
import { getHoliday } from '../utils/holidays';
import { DropPosition, TodoItem } from './types';
import { buildMonthDays, dateKey, groupPeriodsByDate, groupTodosByDate, periodPosition, shortTitle } from './utils';

interface CalendarGridProps {
  currentDate: Date;
  slideDir: 'next' | 'prev' | null;
  allTodos: TodoItem[];
  todoOrder: Record<string, string[]>;
  periodSchedules: PeriodSchedule[];
  showCompleted: boolean;
  draggedTodoId: string | null;
  dragOverDateKey: string | null;
  dragOverTodoId: string | null;
  dragOverPosition: DropPosition | null;
  onTodoMouseDown: (e: React.MouseEvent, todo: TodoItem) => void;
  onDayDoubleClick: (day: Date) => void;
  onTodoClick: (todo: TodoItem) => void;
  onPeriodClick: (schedule: PeriodSchedule) => void;
  onContextMenu: (x: number, y: number, target: { todo?: TodoItem; schedule?: PeriodSchedule }) => void;
}

export function CalendarGrid(props: CalendarGridProps) {
  const {
    currentDate, slideDir, allTodos, todoOrder, periodSchedules, showCompleted,
    draggedTodoId, dragOverDateKey, dragOverTodoId, dragOverPosition,
    onTodoMouseDown, onDayDoubleClick, onTodoClick, onPeriodClick, onContextMenu,
  } = props;

  const month = currentDate.getMonth();
  const days = buildMonthDays(currentDate);
  const todosByDate = groupTodosByDate(allTodos, todoOrder);
  const periodSchedulesByDate = groupPeriodsByDate(periodSchedules);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const contextMenuHandler = (target: { todo?: TodoItem; schedule?: PeriodSchedule }) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e.clientX, e.clientY, target);
  };

  return (
    // key 로 월이 바뀔 때마다 리마운트 → 방향 슬라이드 인 애니메이션 재생(§7)
    <div
      className={`calendar-grid${slideDir ? ` slide-${slideDir}` : ''}`}
      key={`${currentDate.getFullYear()}-${currentDate.getMonth()}`}
    >
      {days.map((day, index) => {
        const key = dateKey(day);
        const dayTodos = todosByDate[key] || [];
        const dayPeriodSchedules = periodSchedulesByDate[key] || [];
        const completed = dayTodos.filter(todo => todo.isCompleted);
        const isCurrentMonth = day.getMonth() === month;
        const isToday = day.getTime() === today.getTime();
        const isPast = day < today && !isToday;
        const dayOfWeek = day.getDay();
        const holiday = getHoliday(day);

        return (
          <div
            key={index}
            className={`calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isCurrentMonth ? 'current-month' : ''} ${isToday ? 'today' : ''} ${isPast ? 'past' : ''} ${dayOfWeek === 0 ? 'sunday' : ''} ${dayOfWeek === 6 ? 'saturday' : ''} ${holiday ? 'holiday' : ''} ${dragOverDateKey === key ? 'drag-over-day' : ''}`}
            onDoubleClick={() => onDayDoubleClick(day)}
            data-date={key} // 마우스 드래그 드롭 대상 판별용
          >
            <div className="calendar-day-number">
              {day.getDate()}
              {holiday && <span className="calendar-day-holiday" title={holiday}>{holiday}</span>}
            </div>
            {(dayPeriodSchedules.length > 0 || dayTodos.length > 0) && (
              <div className={`calendar-day-todos ${dragOverDateKey === key ? 'drag-over' : ''}`}>
                {/* 기간 일정을 먼저 표시 (상단) */}
                {dayPeriodSchedules.map(schedule => {
                  const position = periodPosition(schedule, day);
                  const className = position === 'start end'
                    ? 'calendar-period-schedule period-start period-end'
                    : `calendar-period-schedule period-${position}`;
                  return (
                    <div
                      key={`period-${schedule.id}`}
                      className={className}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPeriodClick(schedule);
                      }}
                      onContextMenu={contextMenuHandler({ schedule })}
                    >
                      {shortTitle(schedule)}
                    </div>
                  );
                })}
                {/* 미완료 할 일. 클릭은 드래그 훅의 mouseup 에서 처리한다. */}
                {dayTodos
                  .filter(todo => !todo.isCompleted)
                  .map((todo) => {
                    const isDragOver = dragOverTodoId === todo.id;
                    return (
                      <React.Fragment key={todo.id}>
                        {isDragOver && dragOverPosition === 'above' && (
                          <div className="calendar-todo-drop-indicator" />
                        )}
                        <div
                          className={`calendar-todo-item ${todo.isManual ? 'calendar-todo-manual' : 'calendar-todo-message'} ${draggedTodoId === todo.id ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                          onMouseDown={(e) => onTodoMouseDown(e, todo)}
                          onContextMenu={contextMenuHandler({ todo })}
                          data-todo-id={todo.id}
                        >
                          {todo.color && <span className="calendar-todo-dot" style={{ background: todo.color }} />}
                          {shortTitle(todo)}
                        </div>
                        {isDragOver && dragOverPosition === 'below' && (
                          <div className="calendar-todo-drop-indicator" />
                        )}
                      </React.Fragment>
                    );
                  })}
                {/* 완료된 항목은 최하단 '완료 N' 묶음으로 접어 두고, 호버(또는 푸터 토글) 시 펼침 */}
                {completed.length > 0 && (
                  <div className={`calendar-completed-group ${showCompleted ? 'expanded' : ''}`}>
                    <div className="calendar-completed-summary">완료 {completed.length}</div>
                    <div className="calendar-completed-list">
                      {completed.map(todo => (
                        <div
                          key={todo.id}
                          className={`calendar-todo-item calendar-todo-completed ${todo.isManual ? 'calendar-todo-manual' : 'calendar-todo-message'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTodoClick(todo);
                          }}
                          onContextMenu={contextMenuHandler({ todo })}
                        >
                          {todo.color && <span className="calendar-todo-dot" style={{ background: todo.color }} />}
                          {shortTitle(todo)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
