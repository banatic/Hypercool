import { invoke } from '@tauri-apps/api/core';
import { ScheduleItem } from '../types/schedule';

export const ScheduleService = {
    /**
     * Get schedules within a date range.
     */
    async getSchedules(range: { start: Date; end: Date }): Promise<ScheduleItem[]> {
        return invoke('get_schedules', {
            start: range.start.toISOString(),
            end: range.end.toISOString()
        });
    },



    /**
     * Create a new schedule item.
     */
    async createSchedule(item: Omit<ScheduleItem, 'createdAt' | 'updatedAt' | 'isDeleted'>): Promise<ScheduleItem> {
        const now = new Date().toISOString();
        const fullItem: ScheduleItem = {
            ...item,
            createdAt: now,
            updatedAt: now,
            isDeleted: false
        };
        return invoke('create_schedule', { item: fullItem });
    },

    async updateScheduleItem(item: ScheduleItem): Promise<ScheduleItem> {
        const now = new Date().toISOString();
        const updatedItem = { ...item, updatedAt: now };
        return invoke('update_schedule', { id: item.id, item: updatedItem });
    },

    /**
     * Soft delete a schedule item.
     */
    async deleteSchedule(id: string): Promise<void> {
        return invoke('delete_schedule', { id });
    },

    /**
     * Convert a message to a schedule item.
     */
    async convertMessageToSchedule(messageId: number, date: Date, title: string, content?: string): Promise<ScheduleItem> {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const dateStr = date.toISOString();

        const item: ScheduleItem = {
            id,
            type: 'message_task',
            title,
            content,
            startDate: dateStr,
            endDate: dateStr,
            isAllDay: false,
            referenceId: messageId.toString(),
            color: undefined,
            isCompleted: false,
            createdAt: now,
            updatedAt: now,
            isDeleted: false
        };

        return invoke('create_schedule', { item });
    }
};
