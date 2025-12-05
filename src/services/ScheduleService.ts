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
     * Get a single schedule by ID.
     */
    async getScheduleById(id: string): Promise<ScheduleItem | null> {
        // We don't have a direct get_schedule_by_id command yet, but we can query by range or add it.
        // For now, let's assume we might need to add it or filter locally if needed.
        // But wait, we implemented get_schedules with range.
        // Let's add get_schedule_by_id to backend if strictly needed, or just use get_schedules with a wide range?
        // Actually, for editing, we usually have the item from the list.
        // Let's leave this as TODO or implement if needed.
        console.warn("getScheduleById not implemented in backend yet");
        return null;
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

    /**
     * Update an existing schedule item.
     */
    async updateSchedule(id: string, updates: Partial<ScheduleItem>): Promise<ScheduleItem> {
        // We need the full item to update because our backend update_schedule takes the full item.
        // This implies we should have the full item state in the frontend.
        // If we only have partial updates, we might need to fetch -> merge -> update.
        // For now, let's assume the caller passes the full item with updates applied, or we change the signature.
        // But the signature says `updates: Partial<ScheduleItem>`.
        // Let's change the implementation to expect the caller to handle merging or we fetch first.
        // Since we don't have get_schedule_by_id, we can't fetch easily.
        // Let's assume the caller passes the FULL item casted or we change the signature to `item: ScheduleItem`.
        // Actually, let's change the signature to `updateSchedule(item: ScheduleItem)` to be safe.
        throw new Error("Use updateScheduleItem instead");
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
