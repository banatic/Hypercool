import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { isSchedule, type CalendarEntry, type ManualTodo, type PeriodSchedule } from '../types';
import { Modal } from './ui/Modal';
import { EventDetail } from './EventDetail';
import { entriesForDay, entryKind, entryTitle, KIND_LABEL } from '../utils/entries';
import { parseDate, dateKey, startOfDay, isSameDay, formatKoreanDate, weekdayLabel } from '../utils/dateUtils';
import { stripHtml } from '../utils/textUtils';
import './CalendarView.css';

interface CalendarViewProps {
  todos: ManualTodo[];
  schedules: PeriodSchedule[];
  loading: boolean;
  currentDate?: Date;
  onDateChange?: (date: Date) => void;
  initialSelectedDay?: Date;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_CHIPS = 3;

type Position = 'start' | 'middle' | 'end' | 'single';

interface DayCell {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
  schedules: { item: PeriodSchedule; position: Position }[];
  todos: ManualTodo[];
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  todos,
  schedules,
  loading,
  currentDate: externalCurrentDate,
  onDateChange,
  initialSelectedDay,
}) => {
  const [internalDate, setInternalDate] = useState(() => new Date());
  const currentDate = externalCurrentDate || internalDate;
  const [selectedDay, setSelectedDay] = useState<Date>(() => startOfDay(initialSelectedDay ?? new Date()));
  const [openEntry, setOpenEntry] = useState<CalendarEntry | null>(null);

  const changeMonth = useCallback((next: Date) => {
    if (onDateChange) onDateChange(next);
    else setInternalDate(next);
  }, [onDateChange]);

  const goPrev = useCallback(() => changeMonth(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1)), [changeMonth, currentDate]);
  const goNext = useCallback(() => changeMonth(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1)), [changeMonth, currentDate]);
  const goToday = useCallback(() => {
    const now = new Date();
    changeMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDay(startOfDay(now));
  }, [changeMonth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || openEntry) return;
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key.toLowerCase() === 't') goToday();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext, goToday, openEntry]);

  const cells = useMemo<DayCell[]>(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const first = new Date(year, month, 1);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());

    // 6주가 항상 필요하진 않다: 이 달이 5주 안에 끝나면 5줄만 그린다.
    const last = new Date(year, month + 1, 0);
    const weeks = Math.ceil((first.getDay() + last.getDate()) / 7);

    const todosByKey = new Map<string, ManualTodo[]>();
    for (const t of todos) {
      const d = parseDate(t.deadline);
      if (!d) continue;
      const k = dateKey(d);
      if (!todosByKey.has(k)) todosByKey.set(k, []);
      todosByKey.get(k)!.push(t);
    }

    const schedulesByKey = new Map<string, { item: PeriodSchedule; position: Position }[]>();
    const rangeEnd = new Date(gridStart);
    rangeEnd.setDate(gridStart.getDate() + weeks * 7);
    for (const s of schedules) {
      const start = parseDate(s.startDate);
      if (!start) continue;
      const end = parseDate(s.endDate) ?? start;
      const a = startOfDay(start);
      const b = startOfDay(end);
      if (b < gridStart || a >= rangeEnd) continue;
      const cursor = new Date(Math.max(a.getTime(), gridStart.getTime()));
      const isSingle = a.getTime() === b.getTime();
      while (cursor <= b && cursor < rangeEnd) {
        const k = dateKey(cursor);
        const position: Position = isSingle ? 'single'
          : isSameDay(cursor, a) ? 'start'
          : isSameDay(cursor, b) ? 'end'
          : 'middle';
        if (!schedulesByKey.has(k)) schedulesByKey.set(k, []);
        schedulesByKey.get(k)!.push({ item: s, position });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const today = new Date();
    const out: DayCell[] = [];
    const d = new Date(gridStart);
    for (let i = 0; i < weeks * 7; i++) {
      const key = dateKey(d);
      const daySchedules = [...(schedulesByKey.get(key) || [])].sort((x, y) => {
        // 기간 일정을 위로 올려 막대가 이어지게
        const xm = x.position !== 'single' ? 0 : 1;
        const ym = y.position !== 'single' ? 0 : 1;
        return xm - ym;
      });
      out.push({
        date: new Date(d),
        key,
        inMonth: d.getMonth() === month,
        isToday: isSameDay(d, today),
        schedules: daySchedules,
        todos: todosByKey.get(key) || [],
      });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [currentDate, todos, schedules]);

  const agenda = useMemo(() => entriesForDay(schedules, todos, selectedDay), [schedules, todos, selectedDay]);

  const selectDay = (date: Date) => {
    setSelectedDay(startOfDay(date));
    if (date.getMonth() !== currentDate.getMonth()) {
      changeMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    }
  };

  const weeks = cells.length / 7;

  return (
    <div className="cal">
      <section className="cal-main panel" aria-label="월간 달력">
        <header className="cal-head">
          <h2 className="cal-month">
            <span className="cal-month-num">{currentDate.getMonth() + 1}월</span>
            <span className="cal-year">{currentDate.getFullYear()}</span>
          </h2>
          <div className="cal-nav">
            <button type="button" className="cal-nav-btn" onClick={goPrev} aria-label="이전 달">
              <ChevronLeft size={18} />
            </button>
            <button type="button" className="cal-today-btn" onClick={goToday}>오늘</button>
            <button type="button" className="cal-nav-btn" onClick={goNext} aria-label="다음 달">
              <ChevronRight size={18} />
            </button>
          </div>
        </header>

        <div className="cal-weekdays" aria-hidden="true">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`cal-weekday${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`}>{w}</div>
          ))}
        </div>

        {loading ? (
          <div className="cal-grid skeleton-grid" style={{ ['--weeks' as string]: 5 }} aria-busy="true">
            {Array.from({ length: 35 }, (_, i) => <div key={i} className="cal-cell"><span className="skeleton cal-skel-num">00</span></div>)}
          </div>
        ) : (
          <div className="cal-grid" style={{ ['--weeks' as string]: weeks }} role="grid">
            {cells.map(cell => {
              const total = cell.schedules.length + cell.todos.length;
              const overflow = Math.max(0, total - MAX_CHIPS);
              const visibleSchedules = cell.schedules.slice(0, MAX_CHIPS);
              const visibleTodos = cell.todos.slice(0, Math.max(0, MAX_CHIPS - visibleSchedules.length));
              const isSelected = isSameDay(cell.date, selectedDay);
              const dow = cell.date.getDay();
              return (
                <div
                  key={cell.key}
                  role="gridcell"
                  tabIndex={0}
                  aria-selected={isSelected}
                  aria-label={`${formatKoreanDate(cell.date)}${total ? `, 항목 ${total}개` : ''}`}
                  className={`cal-cell${cell.inMonth ? '' : ' out'}${cell.isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
                  onClick={() => selectDay(cell.date)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectDay(cell.date);
                    }
                  }}
                >
                  <span className={`cal-num${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}`}>{cell.date.getDate()}</span>
                  <div className="cal-items">
                    {visibleSchedules.map(({ item, position }) => (
                      <button
                        type="button"
                        key={`${item.id}-${cell.key}`}
                        className={`cal-bar ${item.kind} ${position}`}
                        title={item.calendarTitle || stripHtml(item.content)}
                        onClick={e => { e.stopPropagation(); setOpenEntry(item); }}
                      >
                        {(position === 'start' || position === 'single' || dow === 0) && (
                          <span className="cal-bar-text">{item.calendarTitle || stripHtml(item.content)}</span>
                        )}
                      </button>
                    ))}
                    {visibleTodos.map(t => (
                      <button
                        type="button"
                        key={t.id}
                        className={`cal-bar todo single${t.isCompleted ? ' done' : ''}`}
                        title={t.calendarTitle || stripHtml(t.content)}
                        onClick={e => { e.stopPropagation(); setOpenEntry(t); }}
                      >
                        <span className="cal-dot" />
                        <span className="cal-bar-text">{t.calendarTitle || stripHtml(t.content)}</span>
                      </button>
                    ))}
                    {overflow > 0 && <span className="cal-more">+{overflow}</span>}
                  </div>
                  {total > 0 && (
                    <span className="cal-dots" aria-hidden="true">
                      {cell.schedules.slice(0, 3).map(({ item }) => <i key={item.id} className={item.kind} />)}
                      {cell.todos.slice(0, Math.max(0, 3 - Math.min(3, cell.schedules.length))).map(t => <i key={t.id} className="todo" />)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <aside className="cal-agenda panel" aria-label="선택한 날짜의 일정">
        <header className="agenda-head">
          <div className="agenda-day">
            <span className="agenda-daynum">{selectedDay.getDate()}</span>
            <div>
              <div className="agenda-date">{selectedDay.getFullYear()}년 {selectedDay.getMonth() + 1}월</div>
              <div className="agenda-weekday">{weekdayLabel(selectedDay)}요일{isSameDay(selectedDay, new Date()) ? ' · 오늘' : ''}</div>
            </div>
          </div>
          <span className="agenda-count">{agenda.length ? `${agenda.length}개` : ''}</span>
        </header>

        {loading ? (
          <ul className="agenda-list" aria-busy="true">
            {[0, 1, 2].map(i => (
              <li key={i} className="agenda-item">
                <span className="skeleton" style={{ width: '60%' }}>&nbsp;</span>
              </li>
            ))}
          </ul>
        ) : agenda.length === 0 ? (
          <div className="state-empty">
            <strong>일정이 없습니다</strong>
          </div>
        ) : (
          <ul className="agenda-list">
            {agenda.map(entry => {
              const kind = entryKind(entry);
              const done = !isSchedule(entry) && entry.isCompleted;
              return (
                <li key={entry.id}>
                  <button type="button" className={`agenda-item${done ? ' done' : ''}`} onClick={() => setOpenEntry(entry)}>
                    <span className={`agenda-mark ${kind}`} aria-hidden="true" />
                    <span className="agenda-text">
                      <span className="agenda-title">{entryTitle(entry)}</span>
                      <span className="agenda-sub">{KIND_LABEL[kind]}{done ? ' · 완료' : ''}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <Modal isOpen={!!openEntry} onClose={() => setOpenEntry(null)} title={openEntry ? entryTitle(openEntry) : undefined}>
        {openEntry && <EventDetail entry={openEntry} />}
      </Modal>
    </div>
  );
};
