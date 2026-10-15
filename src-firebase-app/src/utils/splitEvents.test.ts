import { describe, it, expect } from 'vitest';
import type { ScheduleItem } from '../types';

import { splitEvents } from '../utils/splitEvents';

const base = {
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    isDeleted: false,
};

describe('splitEvents', () => {
    it('maps todo-like types to todos and keeps isCompleted', () => {
        const items: ScheduleItem[] = [
            { ...base, id: 't1', type: 'manual_todo', title: '출석부 제출', startDate: '2026-09-10', isCompleted: true },
            { ...base, id: 't2', type: 'desktopcal_memo', title: '메모', startDate: '2026-09-11' },
        ];
        const { todos, schedules } = splitEvents(items);
        expect(schedules).toHaveLength(0);
        expect(todos.map(t => [t.id, t.isCompleted, t.deadline])).toEqual([
            ['t1', true, '2026-09-10'],
            ['t2', false, '2026-09-11'],
        ]);
    });

    it('derives kind: single-day → event, multi-day → period, message_task → message', () => {
        const items: ScheduleItem[] = [
            { ...base, id: 'a', type: 'period_schedule', title: '체육대회', startDate: '2026-09-10T00:00:00.000Z', endDate: '2026-09-10T00:00:00.000Z' },
            { ...base, id: 'b', type: 'desktopcal_event', title: '중간고사', startDate: '2026-10-05T00:00:00.000Z', endDate: '2026-10-08T00:00:00.000Z' },
            { ...base, id: 'c', type: 'message_task', title: '공문 회신', startDate: '2026-09-12T00:00:00.000Z', endDate: '2026-09-12T00:00:00.000Z', referenceId: '123' },
            { ...base, id: 'd', type: 'period_schedule', title: '끝 날짜 없음', startDate: '2026-09-13' },
        ];
        const { schedules } = splitEvents(items);
        expect(schedules.map(s => [s.id, s.kind])).toEqual([
            ['a', 'event'], ['b', 'period'], ['c', 'message'], ['d', 'event'],
        ]);
        expect(schedules[3].endDate).toBe('2026-09-13');
    });

    it('drops a todo that duplicates a schedule with the same title and day', () => {
        const items: ScheduleItem[] = [
            { ...base, id: 's', type: 'period_schedule', title: '학부모 상담', startDate: '2026-09-10T00:00:00', endDate: '2026-09-10T00:00:00' },
            { ...base, id: 't', type: 'manual_todo', title: '학부모 상담', startDate: '2026-09-10T00:00:00' },
            { ...base, id: 'u', type: 'manual_todo', title: '학부모 상담', startDate: '2026-09-11T00:00:00' },
        ];
        const { todos, schedules } = splitEvents(items);
        expect(schedules).toHaveLength(1);
        expect(todos.map(t => t.id)).toEqual(['u']);
    });
});
