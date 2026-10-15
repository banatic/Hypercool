import { isSchedule, type CalendarEntry, type ManualTodo, type PeriodSchedule } from '../types';
import { parseDate, startOfDay } from './dateUtils';

export type EntryKind = 'event' | 'period' | 'message' | 'todo';

export const KIND_LABEL: Record<EntryKind, string> = {
  event: '일정',
  period: '기간 일정',
  message: '메시지 일정',
  todo: '할 일',
};

export const entryKind = (entry: CalendarEntry): EntryKind => (isSchedule(entry) ? entry.kind : 'todo');

export const entryTitle = (entry: CalendarEntry): string => entry.calendarTitle || '(제목 없음)';

/** 하루치 항목: 기간 일정 → 하루 일정 → 할 일 순 */
export function entriesForDay(schedules: PeriodSchedule[], todos: ManualTodo[], day: Date): CalendarEntry[] {
  const target = startOfDay(day).getTime();
  const periods: PeriodSchedule[] = [];
  const singles: PeriodSchedule[] = [];
  for (const s of schedules) {
    const start = parseDate(s.startDate);
    if (!start) continue;
    const end = parseDate(s.endDate) ?? start;
    const a = startOfDay(start).getTime();
    const b = startOfDay(end).getTime();
    if (target < a || target > b) continue;
    (a === b ? singles : periods).push(s);
  }
  const out: CalendarEntry[] = [...periods, ...singles];
  for (const t of todos) {
    const d = parseDate(t.deadline);
    if (d && startOfDay(d).getTime() === target) out.push(t);
  }
  return out;
}
