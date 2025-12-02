import React, { useMemo, useState, useCallback } from 'react';
import { Card } from '../components/ui/Card';
import { useCalendarData } from '../hooks/useCalendarData';
import { useMessagesForDateRange } from '../hooks/useMessages';
import { extractSchedulesFromMessages } from '../utils/messageScheduleExtractor';
import { CalendarView } from '../components/CalendarView';

export const CalendarPage: React.FC = () => {
  const { todos, schedules, loading: calendarLoading } = useCalendarData();
  const [currentDate, setCurrentDate] = useState(new Date());

  // 전월, 현재월, 후월까지의 날짜 범위 계산
  // 캘린더에 표시되는 전월의 일부와 후월의 일부를 포함하여 로드
  const { startDate, endDate } = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    // 전월 1일부터 시작
    const startDate = new Date(year, month - 1, 1);
    startDate.setHours(0, 0, 0, 0);
    
    // 후월 마지막일까지
    // month + 2의 0일 = 후월의 마지막일 (예: month=2(3월)이면 month+2=4(5월), 5월의 0일 = 4월 마지막일)
    const endDate = new Date(year, month + 2, 0);
    endDate.setHours(23, 59, 59, 999);
    
    return { startDate, endDate };
  }, [currentDate]);

  // 전월, 현재월, 후월까지의 메시지만 lazy loading
  const { messages, loading: messagesLoading } = useMessagesForDateRange(
    startDate, 
    endDate,
    currentDate.getMonth(),
    currentDate.getFullYear()
  );

  // 메시지에서 일정 추출
  const messageSchedules = useMemo(() => {
    const extracted = extractSchedulesFromMessages(messages);
    console.log('Extracted schedules from messages:', extracted.length, extracted);
    return extracted;
  }, [messages]);

  // 기존 일정과 메시지 일정 합치기
  const allSchedules = useMemo(() => {
    const combined = [...schedules, ...messageSchedules];
    console.log('All schedules (existing + messages):', {
      existing: schedules.length,
      fromMessages: messageSchedules.length,
      total: combined.length
    });
    return combined;
  }, [schedules, messageSchedules]);

  // CalendarView의 날짜 변경 핸들러
  const handleDateChange = useCallback((newDate: Date) => {
    setCurrentDate(newDate);
  }, []);

  const loading = calendarLoading || messagesLoading;

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
