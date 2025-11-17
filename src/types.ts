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
}

export type Page = 'classify' | 'todos' | 'history' | 'settings';
