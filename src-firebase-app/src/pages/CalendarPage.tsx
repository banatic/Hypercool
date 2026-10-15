import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCalendarData } from '../hooks/useCalendarData';
import { parseDate } from '../utils/dateUtils';
import { CalendarView } from '../components/CalendarView';
import { PageHeader } from '../components/Layout';

export const CalendarPage: React.FC = () => {
  const { todos, schedules, loading, error } = useCalendarData();
  const [searchParams] = useSearchParams();
  // 위젯에서 날짜를 누르면 /calendar?date=YYYY-MM-DD 로 들어온다.
  const [initialDay] = useState(() => parseDate(searchParams.get('date')) ?? new Date());
  const [currentDate, setCurrentDate] = useState(() => new Date(initialDay.getFullYear(), initialDay.getMonth(), 1));

  return (
    <div className="page">
      <PageHeader title="달력" />
      {error && <div className="state-error" role="alert">{error}</div>}
      <CalendarView
        todos={todos}
        schedules={schedules}
        loading={loading}
        currentDate={currentDate}
        onDateChange={setCurrentDate}
        initialSelectedDay={initialDay}
      />
    </div>
  );
};
