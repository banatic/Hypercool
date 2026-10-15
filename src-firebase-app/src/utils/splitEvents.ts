import type { ManualTodo, PeriodSchedule, ScheduleItem } from '../types';

/** Firestore events 문서 → 달력/할 일 모델. 삭제된 문서는 쿼리에서 이미 빠져 있다. */
export function splitEvents(items: ScheduleItem[]): { todos: ManualTodo[]; schedules: PeriodSchedule[] } {
    const todos: ManualTodo[] = [];
    const schedules: PeriodSchedule[] = [];

    for (const item of items) {
        if (item.type === 'manual_todo' || item.type === 'desktopcal_memo') {
            todos.push({
                id: item.id,
                content: item.content || '',
                deadline: item.startDate || null,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                calendarTitle: item.title,
                isDeleted: item.isDeleted,
                isCompleted: !!item.isCompleted,
                referenceId: item.referenceId,
            });
        } else if (item.type === 'period_schedule' || item.type === 'desktopcal_event' || item.type === 'message_task') {
            const start = item.startDate || '';
            const end = item.endDate || start;
            const isMulti = start.slice(0, 10) !== end.slice(0, 10);
            schedules.push({
                id: item.id,
                content: item.content || '',
                startDate: start,
                endDate: end,
                calendarTitle: item.title,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                isDeleted: item.isDeleted,
                isCompleted: !!item.isCompleted,
                referenceId: item.referenceId,
                kind: item.type === 'message_task' ? 'message' : isMulti ? 'period' : 'event',
            });
        }
    }

    // 과거 마이그레이션이 같은 일정을 할 일과 일정 양쪽으로 만든 경우가 있어,
    // 제목+날짜가 같으면 일정 쪽만 남긴다.
    const scheduleKeys = new Set<string>();
    for (const s of schedules) {
        const dateStr = s.startDate ? new Date(s.startDate).toDateString() : 'no-date';
        scheduleKeys.add(`${s.calendarTitle || s.content}|${dateStr}`);
    }
    const uniqueTodos = todos.filter(t => {
        const dateStr = t.deadline ? new Date(t.deadline).toDateString() : 'no-date';
        return !scheduleKeys.has(`${t.calendarTitle || t.content}|${dateStr}`);
    });

    return { todos: uniqueTodos, schedules };
}
