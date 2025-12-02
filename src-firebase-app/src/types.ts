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
}
