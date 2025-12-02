import { useState, useEffect } from 'react';
import { collection, query, onSnapshot, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import type { ManualTodo, PeriodSchedule } from '../types';

export const useCalendarData = () => {
    const [todos, setTodos] = useState<ManualTodo[]>([]);
    const [schedules, setSchedules] = useState<PeriodSchedule[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const user = auth.currentUser;
        if (!user) {
            setLoading(false);
            return;
        }

        setLoading(true);
        const todosRef = collection(db, 'users', user.uid, 'todos');
        const schedulesRef = collection(db, 'users', user.uid, 'schedules');

        // 서버 사이드 필터링: isDeleted가 false인 문서만 읽기
        // 이렇게 하면 삭제된 문서는 읽지 않아 읽기 비용 절감
        const todosQuery = query(todosRef, where('isDeleted', '==', false));
        const schedulesQuery = query(schedulesRef, where('isDeleted', '==', false));

        const unsubscribeTodos = onSnapshot(todosQuery, (snapshot) => {
            const todosData = snapshot.docs.map(doc => doc.data() as ManualTodo);
            setTodos(todosData);
        }, (err) => {
            console.error("Error fetching todos:", err);
            setError("Failed to fetch todos");
            // 인덱스 오류 시 fallback: 모든 문서 읽고 클라이언트에서 필터링
            if (err.code === 'failed-precondition' || err.message?.includes('index')) {
                console.warn('Falling back to client-side filtering for todos');
                const fallbackQuery = query(todosRef);
                onSnapshot(fallbackQuery, (fallbackSnapshot) => {
                    const todosData = fallbackSnapshot.docs.map(doc => doc.data() as ManualTodo);
                    setTodos(todosData.filter(t => !t.isDeleted));
                });
            }
        });

        const unsubscribeSchedules = onSnapshot(schedulesQuery, (snapshot) => {
            const schedulesData = snapshot.docs.map(doc => doc.data() as PeriodSchedule);
            setSchedules(schedulesData);
            setLoading(false);
        }, (err) => {
            console.error("Error fetching schedules:", err);
            setError("Failed to fetch schedules");
            setLoading(false);
            // 인덱스 오류 시 fallback: 모든 문서 읽고 클라이언트에서 필터링
            if (err.code === 'failed-precondition' || err.message?.includes('index')) {
                console.warn('Falling back to client-side filtering for schedules');
                const fallbackQuery = query(schedulesRef);
                onSnapshot(fallbackQuery, (fallbackSnapshot) => {
                    const schedulesData = fallbackSnapshot.docs.map(doc => doc.data() as PeriodSchedule);
                    setSchedules(schedulesData.filter(s => !s.isDeleted));
                });
            }
        });

        return () => {
            unsubscribeTodos();
            unsubscribeSchedules();
        };
    }, []);

    return { todos, schedules, loading, error };
};
