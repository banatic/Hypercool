import { useData } from '../context/DataStore';

export const useCalendarData = () => {
    const { todos, schedules, loading, error } = useData();
    return { todos, schedules, loading, error };
};
