export type ScheduleType = 'manual_todo' | 'period_schedule' | 'message_task';

export interface ScheduleItem {
    id: string;              // UUID for local generation
    type: ScheduleType;
    title: string;           // Display title (e.g. "Meeting", or Message Sender)
    content?: string;        // Description or Message Body

    // Time
    startDate: string;       // ISO 8601
    endDate: string;         // ISO 8601
    isAllDay: boolean;

    // Metadata
    referenceId?: string;    // ID of the original message (if type is message_task)
    color?: string;
    isCompleted: boolean;

    // Audit
    createdAt: string;
    updatedAt: string;
    isDeleted: boolean;      // Soft delete support
}
