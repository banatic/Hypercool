import { useState, useCallback, useRef } from 'react';
import { ScheduleService } from '../services/ScheduleService';
import { ScheduleItem } from '../types/schedule';
import { ManualTodo, PeriodSchedule } from '../types';

export function useSchedules() {
    const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
    const lastLoadTimeRef = useRef(0);

    const loadSchedules = useCallback(async () => {
        const now = Date.now();
        if (now - lastLoadTimeRef.current < 1000) {
            return;
        }
        lastLoadTimeRef.current = now;

        try {
            // Load a wide range or paginate? Currently loading 100 years.
            const start = new Date('2000-01-01');
            const end = new Date('2100-12-31');
            const items = await ScheduleService.getSchedules({ start, end });
            setSchedules(items);
        } catch (e) {
            console.error('Failed to load schedules', e);
        }
    }, []);

    const manualTodos = schedules
        .filter(s => s.type === 'manual_todo')
        .map(s => ({
            id: s.id,
            content: s.content || '',
            deadline: s.startDate, // Assuming startDate holds deadline for todos
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            calendarTitle: s.title,
            isDeleted: s.isDeleted
        } as ManualTodo));

    const periodSchedules = schedules
        .filter(s => s.type === 'period_schedule')
        .map(s => ({
            id: s.id,
            content: s.content || '',
            startDate: s.startDate!,
            endDate: s.endDate!,
            calendarTitle: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            isDeleted: s.isDeleted
        } as PeriodSchedule));

    // Map message ID to schedule for quick lookup
    const messageSchedulesMap = schedules
        .filter(s => s.type === 'message_task' && s.referenceId)
        .reduce((acc, s) => {
            if (s.referenceId) {
                acc[s.referenceId] = s;
            }
            return acc;
        }, {} as Record<string, ScheduleItem>);

    return {
        schedules,
        manualTodos,
        periodSchedules,
        messageSchedulesMap,
        loadSchedules,
        setSchedules, // Expose setter for optimistic updates if needed
    };
}
