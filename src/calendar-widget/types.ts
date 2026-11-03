export interface TodoItem {
  id: string;
  content: string;
  deadline: string | null;
  sender?: string;
  receiveDate?: string | null;
  isManual?: boolean;
  calendarTitle?: string;
  isCompleted?: boolean;
  file_paths?: string[];
  updatedAt?: string;
  color?: string | null;
  isDeleted?: boolean;
}

export interface ParsedDate {
  date: string | null;
  time: string | null;
}

export type DropPosition = 'above' | 'below';

export type ParseDateFn = (text: string, baseDate?: Date) => ParsedDate;
