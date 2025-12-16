export interface Message {
  id: number;
  sender: string;
  content: string;
  receive_date?: string | null;
  file_paths?: string[];
}

// Lightweight message metadata for lists (no full content)
export interface MessageMeta {
  id: number;
  sender: string;
  preview: string;  // First 200 chars only
  receive_date?: string | null;
  file_paths?: string[];
}

export interface SearchResultItem {
  id: number;
  sender: string;
  snippet: string;
}

export interface ManualTodo {
  id: string;
  content: string;
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
  calendarTitle?: string; // 달력에 표시될 짧은 제목
  isDeleted?: boolean;
}

export interface PeriodSchedule {
  id: string;
  content: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  calendarTitle?: string; // 달력에 표시될 짧은 제목
  createdAt: string;
  updatedAt: string;
  isDeleted?: boolean;
}

export type Page = 'classify' | 'todos' | 'history' | 'settings';
