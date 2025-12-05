import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { collection, query, onSnapshot, where, orderBy, limit } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { ManualTodo, PeriodSchedule, ScheduleItem, Message } from '../types';

interface DataContextType {
    todos: ManualTodo[];
    schedules: PeriodSchedule[];
    recentMessages: Message[];
    loading: boolean;
    error: string | null;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

export const DataProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [todos, setTodos] = useState<ManualTodo[]>([]);
    const [schedules, setSchedules] = useState<PeriodSchedule[]>([]);
    const [recentMessages, setRecentMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let unsubscribeEvents: () => void;
        let unsubscribeMessages: () => void;

        const unsubscribeAuth = auth.onAuthStateChanged((user) => {
            if (!user) {
                setTodos([]);
                setSchedules([]);
                setRecentMessages([]);
                setLoading(false);
                return;
            }

            setLoading(true);
            const eventsRef = collection(db, 'users', user.uid, 'events');
            const messagesRef = collection(db, 'users', user.uid, 'messages');

            // 1. Subscribe to Events (Schedules & Todos)
            const eventsQuery = query(eventsRef, where('isDeleted', '==', false));
            
            unsubscribeEvents = onSnapshot(eventsQuery, (snapshot) => {
                const items = snapshot.docs.map(doc => doc.data() as ScheduleItem);
                
                const newTodos: ManualTodo[] = [];
                const newSchedules: PeriodSchedule[] = [];

                items.forEach(item => {
                    if (item.type === 'manual_todo') {
                        newTodos.push({
                            id: item.id,
                            content: item.content || '',
                            deadline: item.startDate || null,
                            createdAt: item.createdAt,
                            updatedAt: item.updatedAt,
                            calendarTitle: item.title,
                            isDeleted: item.isDeleted,
                            referenceId: item.referenceId
                        });
                    } else if (item.type === 'period_schedule') {
                        newSchedules.push({
                            id: item.id,
                            content: item.content || '',
                            startDate: item.startDate || '',
                            endDate: item.endDate || '',
                            calendarTitle: item.title,
                            createdAt: item.createdAt,
                            updatedAt: item.updatedAt,
                            isDeleted: item.isDeleted,
                            referenceId: item.referenceId
                        });
                    } else if (item.type === 'message_task') {
                         // Map message tasks to schedules so they appear on calendar
                         newSchedules.push({
                            id: item.id,
                            content: item.content || '',
                            startDate: item.startDate || '',
                            endDate: item.endDate || '',
                            calendarTitle: item.title,
                            createdAt: item.createdAt,
                            updatedAt: item.updatedAt,
                            isDeleted: item.isDeleted,
                            referenceId: item.referenceId
                        });
                    }
                });

                // Deduplication Logic:
                // If a Todo has the same title and date as a Schedule, prefer the Schedule.
                // This handles cases where legacy migration created both types for the same event.
                const scheduleKeys = new Set<string>();
                newSchedules.forEach(s => {
                    // Create a unique key based on title and start date
                    // Use a normalized date string for comparison
                    const dateStr = s.startDate ? new Date(s.startDate).toDateString() : 'no-date';
                    const key = `${s.calendarTitle || s.content}|${dateStr}`;
                    scheduleKeys.add(key);
                });

                const uniqueTodos = newTodos.filter(t => {
                    const dateStr = t.deadline ? new Date(t.deadline).toDateString() : 'no-date';
                    const key = `${t.calendarTitle || t.content}|${dateStr}`;
                    // Only keep todo if it DOESN'T match an existing schedule
                    return !scheduleKeys.has(key);
                });

                setTodos(uniqueTodos);
                setSchedules(newSchedules);
            }, (err) => {
                console.error("Error fetching events:", err);
                setError("Failed to fetch events");
            });

            // 2. Subscribe to Recent Messages
            const messagesQuery = query(messagesRef, orderBy('id', 'desc'), limit(20));
            
            unsubscribeMessages = onSnapshot(messagesQuery, (snapshot) => {
                const msgs = snapshot.docs.map(doc => doc.data() as Message);
                setRecentMessages(msgs);
                setLoading(false);
            }, (err) => {
                console.error("Error fetching messages:", err);
            });
        });

        return () => {
            unsubscribeAuth();
            if (unsubscribeEvents) unsubscribeEvents();
            if (unsubscribeMessages) unsubscribeMessages();
        };
    }, []);

    return (
        <DataContext.Provider value={{ todos, schedules, recentMessages, loading, error }}>
            {children}
        </DataContext.Provider>
    );
};

export const useData = () => {
    const context = useContext(DataContext);
    if (context === undefined) {
        throw new Error('useData must be used within a DataProvider');
    }
    return context;
};
