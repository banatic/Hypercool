import React from 'react';
import { Card } from '../components/ui/Card';
import { useCalendarData } from '../hooks/useCalendarData';
import { CalendarView } from '../components/CalendarView';

export const CalendarPage: React.FC = () => {
  const { todos, schedules, loading } = useCalendarData();

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Calendar</h1>
        <p>View your schedules and to-dos.</p>
      </div>
      
      <Card>
        <CalendarView todos={todos} schedules={schedules} loading={loading} />
      </Card>
    </div>
  );
};
