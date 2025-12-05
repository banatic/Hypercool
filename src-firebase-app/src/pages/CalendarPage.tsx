import React, { useMemo, useState, useCallback } from 'react';
import { Card } from '../components/ui/Card';
import { useCalendarData } from '../hooks/useCalendarData';
// import { useMessagesForDateRange } from '../hooks/useMessages';
// import { extractSchedulesFromMessages } from '../utils/messageScheduleExtractor';
import { CalendarView } from '../components/CalendarView';

export const CalendarPage: React.FC = () => {
  const { todos, schedules, loading: calendarLoading } = useCalendarData();
  const [currentDate, setCurrentDate] = useState(new Date());

  // 전월, 현재월, 후월까지의 날짜 범위 계산
  // 캘린더에 표시되는 전월의 일부와 후월의 일부를 포함하여 로드
  // 전월, 현재월, 후월까지의 날짜 범위 계산 (Legacy logic removed)
  // const { startDate, endDate } = useMemo(() => { ... });

  // 전월, 현재월, 후월까지의 메시지만 lazy loading (Legacy logic removed)
  // const { messages, loading: messagesLoading } = useMessagesForDateRange(...);

  // 메시지에서 일정 추출 (Legacy logic removed - now using events collection)
  // const messageSchedules = useMemo(() => { ... });

  // 기존 일정과 메시지 일정 합치기
  const allSchedules = useMemo(() => {
    // schedules now includes message tasks fetched from events collection
    return schedules;
  }, [schedules]);

  // CalendarView의 날짜 변경 핸들러
  const handleDateChange = useCallback((newDate: Date) => {
    setCurrentDate(newDate);
  }, []);

  const loading = calendarLoading;

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>달력</h1>
        <p>일정과 할 일을 확인하세요.</p>
      </div>
      
      <Card>
        <CalendarView 
          todos={todos} 
          schedules={allSchedules} 
          loading={loading}
          currentDate={currentDate}
          onDateChange={handleDateChange}
        />
      </Card>
    </div>
  );
};
