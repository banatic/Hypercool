export interface Message {
    id: number;
    sender: string;
    content: string;
    receive_date?: string | null;
    file_paths?: string[];
    deadline?: string | null;  // ISO date string
    calendarTitle?: string | null;
}

export interface ManualTodo {
    id: string;
    content: string;
    deadline: string | null;
    createdAt: string;
    updatedAt: string;
    calendarTitle?: string;
    isDeleted?: boolean;
    referenceId?: string | null;
}

export interface PeriodSchedule {
    id: string;
    content: string;
    startDate: string;
    endDate: string;
    calendarTitle?: string;
    createdAt: string;
    updatedAt: string;
    isDeleted?: boolean;
    referenceId?: string | null;
}

export interface ScheduleItem {
    id: string;
    type: 'manual_todo' | 'period_schedule' | 'message_task';
    title: string;
    content?: string;
    startDate?: string;
    endDate?: string;
    isAllDay?: boolean;
    referenceId?: string;
    color?: string;
    isCompleted?: boolean;
    createdAt: string;
    updatedAt: string;
    isDeleted: boolean;
}
