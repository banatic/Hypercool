import { describe, it, expect } from 'vitest';
import {
  buildMonthDays, buildScheduleItem, dateKey, groupPeriodsByDate, groupTodosByDate,
  parseDateFromText, periodPosition, reorderForDrop, shortTitle, splitScheduleItems,
} from './utils';
import { TodoItem } from './types';

const todo = (id: string, deadline: string | null, extra: Partial<TodoItem> = {}): TodoItem =>
  ({ id, content: id, deadline, isManual: true, ...extra });

describe('dateKey', () => {
  it('uses zero-based month like TodoOrderMap keys', () => {
    expect(dateKey(new Date(2026, 10, 5))).toBe('2026-10-5');
  });
});

describe('shortTitle', () => {
  it('prefers calendar title, else first 10 chars of content', () => {
    expect(shortTitle({ calendarTitle: '회의', content: '아주 긴 내용입니다 정말로' })).toBe('회의');
    expect(shortTitle({ content: '0123456789AB' })).toBe('0123456789...');
    expect(shortTitle({ content: '짧음' })).toBe('짧음');
  });
});

describe('buildMonthDays', () => {
  it('returns 42 days starting on the Sunday of the 1st', () => {
    const days = buildMonthDays(new Date(2026, 10, 17)); // 2026-11-01 은 일요일
    expect(days).toHaveLength(42);
    expect(dateKey(days[0])).toBe('2026-10-1');
    expect(dateKey(days[41])).toBe('2026-11-12');
  });

  it('includes trailing days of the previous month', () => {
    const days = buildMonthDays(new Date(2026, 9, 1)); // 2026-10-01 은 목요일
    expect(days[0].getDay()).toBe(0);
    expect(dateKey(days[0])).toBe('2026-8-27');
  });
});

describe('groupTodosByDate', () => {
  const a = todo('A', new Date(2026, 10, 5, 10).toISOString());
  const b = todo('B', new Date(2026, 10, 5, 15).toISOString());
  const c = todo('C', new Date(2026, 10, 5, 9).toISOString());
  const none = todo('N', null);

  it('groups by deadline day and skips todos without deadline', () => {
    const g = groupTodosByDate([a, b, none], {});
    expect(Object.keys(g)).toEqual(['2026-10-5']);
    expect(g['2026-10-5'].map(t => t.id)).toEqual(['A', 'B']);
  });

  it('applies saved order, appending unknown ids at the end', () => {
    const g = groupTodosByDate([a, b, c], { '2026-10-5': ['B', 'X', 'A'] });
    expect(g['2026-10-5'].map(t => t.id)).toEqual(['B', 'A', 'C']);
  });
});

describe('groupPeriodsByDate / periodPosition', () => {
  const p = { id: 'P', content: '', startDate: '2026-11-16', endDate: '2026-11-18', createdAt: '', updatedAt: '' };

  it('puts a period on every day it spans, skipping deleted ones', () => {
    const g = groupPeriodsByDate([p, { ...p, id: 'D', isDeleted: true }]);
    expect(Object.keys(g).sort()).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
    expect(g['2026-10-17'].map(s => s.id)).toEqual(['P']);
  });

  it('marks start, middle, end and single-day periods', () => {
    expect(periodPosition(p, new Date(2026, 10, 16))).toBe('start');
    expect(periodPosition(p, new Date(2026, 10, 17))).toBe('middle');
    expect(periodPosition(p, new Date(2026, 10, 18))).toBe('end');
    expect(periodPosition({ ...p, endDate: '2026-11-16' }, new Date(2026, 10, 16))).toBe('start end');
  });
});

describe('parseDateFromText', () => {
  const base = new Date(2026, 10, 3, 9, 0);

  it('parses relative words against the base date', () => {
    expect(parseDateFromText('내일 회의', base)).toEqual({ date: '2026-11-04', time: null });
    expect(parseDateFromText('모레까지', base).date).toBe('2026-11-05');
    expect(parseDateFromText('다음 주 제출', base).date).toBe('2026-11-10');
  });

  it('parses absolute dates and times', () => {
    expect(parseDateFromText('2026.12.5 9:05 마감', base)).toEqual({ date: '2026-12-05', time: '09:05' });
  });

  it('returns nulls when nothing matches', () => {
    expect(parseDateFromText('그냥 메모', base)).toEqual({ date: null, time: null });
  });
});

describe('splitScheduleItems', () => {
  it('sorts items into manual, period and message-task state', () => {
    const s = splitScheduleItems([
      { id: 'm', type: 'manual_todo', title: 'T', content: 'c', startDate: 'd1', color: '#fff' },
      { id: 'dm', type: 'desktopcal_memo', title: 'T2', startDate: null },
      { id: 'p', type: 'period_schedule', title: 'P', startDate: 's', endDate: 'e', isCompleted: true },
      { id: 'mt', type: 'message_task', title: 'M', referenceId: '101', startDate: 'd2', isCompleted: true },
      { id: 'orphan', type: 'message_task', title: 'O', referenceId: 'uuid-x', startDate: 'd3' },
      { id: 'noref', type: 'message_task', title: 'N' },
    ]);
    expect(s.manualTodos.map(t => t.id)).toEqual(['m', 'dm', 'orphan']);
    expect(s.manualTodos[0]).toMatchObject({ content: 'c', deadline: 'd1', calendarTitle: 'T', color: '#fff' });
    expect(s.manualTodos[1]).toMatchObject({ content: '', deadline: null, color: null });
    expect(s.periodSchedules.map(p => p.id)).toEqual(['p']);
    expect(s.deadlines).toEqual({ 101: 'd2' });
    expect(s.calendarTitles).toEqual({ 101: 'M' });
    expect(s.referenceIdToScheduleId).toEqual({ 101: 'mt' });
    expect([...s.completed].sort()).toEqual(['101', 'mt', 'p']);
  });
});

describe('buildScheduleItem', () => {
  it('updates a manual todo in place', () => {
    const { scheduleItem, targetId, shouldCreate } = buildScheduleItem(
      todo('A', '2026-11-05T01:00:00.000Z', { calendarTitle: '회의', content: '회의 준비' }),
      { isCompleted: true }, {});
    expect(shouldCreate).toBe(false);
    expect(targetId).toBe('A');
    expect(scheduleItem).toMatchObject({
      id: 'A', type: 'manual_todo', title: '회의', content: '회의 준비',
      startDate: '2026-11-05T01:00:00.000Z', endDate: '2026-11-05T01:00:00.000Z',
      isAllDay: false, referenceId: null, color: null, isCompleted: true,
    });
  });

  it('maps a message todo to its schedule id, or creates one if unmapped', () => {
    const msg = todo('101', 'd', { isManual: false });
    const mapped = buildScheduleItem(msg, {}, { 101: 'M1' });
    expect(mapped).toMatchObject({ targetId: 'M1', shouldCreate: false });
    expect(mapped.scheduleItem).toMatchObject({ id: 'M1', type: 'message_task', referenceId: '101' });

    const created = buildScheduleItem(msg, {}, {});
    expect(created.shouldCreate).toBe(true);
    expect(created.targetId).not.toBe('101');
  });

  it('treats period schedules as all-day and lets updates.deadline override dates', () => {
    const p = { id: 'P', content: 'c', startDate: '2026-11-16', endDate: '2026-11-18', createdAt: 'x', updatedAt: 'y' };
    const { scheduleItem } = buildScheduleItem(p, { endDate: '2026-11-19' }, {});
    expect(scheduleItem).toMatchObject({ type: 'period_schedule', isAllDay: true, startDate: '2026-11-16', endDate: '2026-11-19', createdAt: 'x' });
    expect(buildScheduleItem(p, { deadline: 'Z' }, {}).scheduleItem).toMatchObject({ startDate: 'Z', endDate: 'Z' });
  });
});

describe('reorderForDrop', () => {
  const day = (h: number) => new Date(2026, 10, 5, h).toISOString();
  const all = [todo('A', day(10)), todo('B', day(15)), todo('C', day(9), { isCompleted: true }), todo('D', new Date(2026, 10, 10).toISOString())];

  it('inserts above / below the target todo', () => {
    const args = { allTodos: all, draggedId: 'A', sourceDateKey: '2026-10-5', targetDateKey: '2026-10-5', currentOrder: ['A', 'B'] };
    expect(reorderForDrop({ ...args, targetTodoId: 'B', position: 'below' })).toEqual(['B', 'A']);
    expect(reorderForDrop({ ...args, currentOrder: ['B', 'A'], targetTodoId: 'B', position: 'above' })).toEqual(['A', 'B']);
  });

  it('appends when there is no target, and drops completed ids from the order', () => {
    expect(reorderForDrop({ allTodos: all, draggedId: 'A', sourceDateKey: '2026-10-5', targetDateKey: '2026-10-5', currentOrder: ['C', 'A', 'B'] }))
      .toEqual(['B', 'A']);
  });

  it('adds a todo dropped from another day to the target day order', () => {
    expect(reorderForDrop({ allTodos: all, draggedId: 'D', sourceDateKey: '2026-10-10', targetDateKey: '2026-10-5', currentOrder: [], targetTodoId: 'A', position: 'above' }))
      .toEqual(['D', 'A', 'B']);
  });
});
