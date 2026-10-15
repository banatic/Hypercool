import { createContext, useContext } from 'react';
import type { User } from 'firebase/auth';
import type { ManualTodo, PeriodSchedule, Message } from '../types';

export interface DataContextType {
    user: User | null;
    /** 인증 상태가 아직 확인되지 않은 동안 true */
    authLoading: boolean;
    todos: ManualTodo[];
    schedules: PeriodSchedule[];
    recentMessages: Message[];
    loading: boolean;
    error: string | null;
}

/** 컨텍스트가 실시간 구독하는 최근 메시지 개수. useMessages 의 페이지 크기와 같다. */
export const RECENT_MESSAGE_LIMIT = 20;

export const DataContext = createContext<DataContextType | undefined>(undefined);

export const useData = () => {
    const context = useContext(DataContext);
    if (context === undefined) {
        throw new Error('useData must be used within a DataProvider');
    }
    return context;
};
