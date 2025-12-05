import { useData } from '../context/DataContext';

export const useCalendarData = () => {
    const { todos, schedules, loading, error } = useData();
    return { todos, schedules, loading, error };
};
