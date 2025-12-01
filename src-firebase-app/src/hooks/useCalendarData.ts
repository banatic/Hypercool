import { useState, useEffect } from 'react';
import { collection, query, onSnapshot } from 'firebase/firestore';
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

        const unsubscribeTodos = onSnapshot(query(todosRef), (snapshot) => {
            const todosData = snapshot.docs.map(doc => doc.data() as ManualTodo);
            setTodos(todosData.filter(t => !t.isDeleted));
        }, (err) => {
            console.error("Error fetching todos:", err);
            setError("Failed to fetch todos");
        });

        const unsubscribeSchedules = onSnapshot(query(schedulesRef), (snapshot) => {
            const schedulesData = snapshot.docs.map(doc => doc.data() as PeriodSchedule);
            setSchedules(schedulesData.filter(s => !s.isDeleted));
            setLoading(false);
        }, (err) => {
            console.error("Error fetching schedules:", err);
            setError("Failed to fetch schedules");
            setLoading(false);
        });

        return () => {
            unsubscribeTodos();
            unsubscribeSchedules();
        };
    }, []);

    return { todos, schedules, loading, error };
};
