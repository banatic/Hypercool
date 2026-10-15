import React, { useState, useEffect, type ReactNode } from 'react';
import { collection, query, onSnapshot, where, orderBy, limit } from 'firebase/firestore';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, db } from '../firebase';
import type { ManualTodo, PeriodSchedule, ScheduleItem, Message } from '../types';
import { DataContext, RECENT_MESSAGE_LIMIT, type DataContextType } from './DataStore';
import { splitEvents } from '../utils/splitEvents';

interface ProviderProps {
    children: ReactNode;
    /** 테스트·미리보기용: 주어지면 Firebase 구독 없이 이 값을 그대로 제공한다. */
    value?: DataContextType;
}

export const DataProvider: React.FC<ProviderProps> = ({ children, value }) => {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [todos, setTodos] = useState<ManualTodo[]>([]);
    const [schedules, setSchedules] = useState<PeriodSchedule[]>([]);
    const [recentMessages, setRecentMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (value) return;
        let unsubscribeEvents: (() => void) | undefined;
        let unsubscribeMessages: (() => void) | undefined;

        const stopSubscriptions = () => {
            unsubscribeEvents?.();
            unsubscribeMessages?.();
            unsubscribeEvents = undefined;
            unsubscribeMessages = undefined;
        };

        const unsubscribeAuth = onAuthStateChanged(auth, (nextUser) => {
            setUser(nextUser);
            setAuthLoading(false);
            stopSubscriptions();

            if (!nextUser) {
                setTodos([]);
                setSchedules([]);
                setRecentMessages([]);
                setLoading(false);
                return;
            }

            setLoading(true);
            setError(null);
            const eventsRef = collection(db, 'users', nextUser.uid, 'events');
            const messagesRef = collection(db, 'users', nextUser.uid, 'messages');

            let eventsReady = false;
            let messagesReady = false;
            const settle = () => {
                if (eventsReady && messagesReady) setLoading(false);
            };

            unsubscribeEvents = onSnapshot(
                query(eventsRef, where('isDeleted', '==', false)),
                (snapshot) => {
                    const items = snapshot.docs.map(d => d.data() as ScheduleItem);
                    const split = splitEvents(items);
                    setTodos(split.todos);
                    setSchedules(split.schedules);
                    eventsReady = true;
                    settle();
                },
                (err) => {
                    console.error('Error fetching events:', err);
                    setError('일정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
                    eventsReady = true;
                    settle();
                },
            );

            unsubscribeMessages = onSnapshot(
                query(messagesRef, orderBy('id', 'desc'), limit(RECENT_MESSAGE_LIMIT)),
                (snapshot) => {
                    setRecentMessages(snapshot.docs.map(d => d.data() as Message));
                    messagesReady = true;
                    settle();
                },
                (err) => {
                    console.error('Error fetching messages:', err);
                    setError('메시지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
                    messagesReady = true;
                    settle();
                },
            );
        });

        return () => {
            unsubscribeAuth();
            stopSubscriptions();
        };
    }, [value]);

    const ctx: DataContextType = value ?? { user, authLoading, todos, schedules, recentMessages, loading, error };

    return <DataContext.Provider value={ctx}>{children}</DataContext.Provider>;
};
