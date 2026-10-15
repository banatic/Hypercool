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
    isCompleted?: boolean;
    referenceId?: string | null;
}

/** 달력에 올라가는 일정. kind 는 표시 색과 라벨을 정한다. */
export type ScheduleKind = 'event' | 'period' | 'message';

export interface PeriodSchedule {
    id: string;
    content: string;
    startDate: string;
    endDate: string;
    calendarTitle?: string;
    createdAt: string;
    updatedAt: string;
    isDeleted?: boolean;
    isCompleted?: boolean;
    referenceId?: string | null;
    kind: ScheduleKind;
}

export interface ScheduleItem {
    id: string;
    type: 'manual_todo' | 'period_schedule' | 'message_task' | 'desktopcal_memo' | 'desktopcal_event';
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

export type CalendarEntry = ManualTodo | PeriodSchedule;

export const isSchedule = (entry: CalendarEntry): entry is PeriodSchedule => 'startDate' in entry;
