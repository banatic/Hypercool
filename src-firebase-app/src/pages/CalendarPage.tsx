import React, { useMemo } from 'react';
import { Card } from '../components/ui/Card';
import { useCalendarData } from '../hooks/useCalendarData';
import { useAllMessages } from '../hooks/useMessages';
import { extractSchedulesFromMessages } from '../utils/messageScheduleExtractor';
import { CalendarView } from '../components/CalendarView';

export const CalendarPage: React.FC = () => {
  const { todos, schedules, loading: calendarLoading } = useCalendarData();
  const { messages, loading: messagesLoading } = useAllMessages();

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

  const loading = calendarLoading || messagesLoading;

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>달력</h1>
        <p>일정과 할 일을 확인하세요.</p>
      </div>
      
      <Card>
        <CalendarView todos={todos} schedules={allSchedules} loading={loading} />
      </Card>
    </div>
  );
};
