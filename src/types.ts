export interface Message {
  id: number;
  sender: string;
  content: string;
  receive_date?: string | null;
}

export interface SearchResultItem {
  id: number;
  sender: string;
  snippet: string;
}

export interface ManualTodo {
  id: number;
  content: string;
  deadline: string | null;
  createdAt: string;
  calendarTitle?: string; // 달력에 표시될 짧은 제목
}

export type Page = 'classify' | 'todos' | 'history' | 'settings';
