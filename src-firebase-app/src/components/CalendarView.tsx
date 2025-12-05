import React, { useState, useMemo } from 'react';
import type { ManualTodo, PeriodSchedule } from '../types';
import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { Modal } from './ui/Modal';
import { stripHtml } from '../utils/textUtils';
import './CalendarView.css';

interface CalendarViewProps {
  todos: ManualTodo[];
  schedules: PeriodSchedule[];
  loading: boolean;
  currentDate?: Date;
  onDateChange?: (date: Date) => void;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ 
  todos, 
  schedules, 
  loading,
  currentDate: externalCurrentDate,
  onDateChange
}) => {
  const [internalCurrentDate, setInternalCurrentDate] = useState(new Date());
  const currentDate = externalCurrentDate || internalCurrentDate;
  
  const handleDateChange = (newDate: Date) => {
    if (onDateChange) {
      onDateChange(newDate);
    } else {
      setInternalCurrentDate(newDate);
    }
  };
  const [selectedEvent, setSelectedEvent] = useState<ManualTodo | PeriodSchedule | null>(null);

  // Fetch message content if missing
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  const [fetchingContent, setFetchingContent] = useState(false);

  React.useEffect(() => {
    if (selectedEvent && !selectedEvent.content && selectedEvent.referenceId) {
      const fetchMessage = async () => {
        setFetchingContent(true);
        try {
          const { doc, getDoc } = await import('firebase/firestore');
          const { db, auth } = await import('../firebase');
          if (auth.currentUser) {
            const msgRef = doc(db, 'users', auth.currentUser.uid, 'messages', selectedEvent.referenceId!);
            const snap = await getDoc(msgRef);
            if (snap.exists()) {
              setFetchedContent(snap.data().content);
            } else {
              setFetchedContent("메시지를 찾을 수 없습니다.");
            }
          }
        } catch (e) {
          console.error("Error fetching message content:", e);
          setFetchedContent("내용을 불러오는데 실패했습니다.");
        } finally {
          setFetchingContent(false);
        }
      };
      fetchMessage();
    } else {
      setFetchedContent(null);
    }
  }, [selectedEvent]);

  const { days, todosByDate, periodSchedulesByDate } = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    const firstDay = new Date(year, month, 1);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay()); // Start from Sunday
    
    const days: Date[] = [];
    const current = new Date(startDate);
    while (days.length < 42) { // 6 weeks * 7 days
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    // Group todos by date
    const todosByDate: Record<string, ManualTodo[]> = {};
    todos.forEach(todo => {
      if (todo.deadline) {
        try {
          // 날짜 파싱 (다양한 형식 지원)
          const date = new Date(todo.deadline);
          // 유효한 날짜인지 확인
          if (!isNaN(date.getTime())) {
            const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
            if (!todosByDate[dateKey]) {
              todosByDate[dateKey] = [];
            }
            todosByDate[dateKey].push(todo);
          }
        } catch (error) {
          console.warn('Failed to parse todo deadline:', todo.deadline, error);
        }
      }
    });

    // Group schedules by date
    const periodSchedulesByDate: Record<string, PeriodSchedule[]> = {};
    schedules.forEach(schedule => {
      const start = new Date(schedule.startDate);
      const end = new Date(schedule.endDate);
      const current = new Date(start);
      while (current <= end) {
        const dateKey = `${current.getFullYear()}-${current.getMonth()}-${current.getDate()}`;
        if (!periodSchedulesByDate[dateKey]) {
          periodSchedulesByDate[dateKey] = [];
        }
        periodSchedulesByDate[dateKey].push(schedule);
        current.setDate(current.getDate() + 1);
      }
    });

    return { days, todosByDate, periodSchedulesByDate };
  }, [currentDate, todos, schedules]);

  const goToPreviousMonth = () => {
    handleDateChange(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const goToNextMonth = () => {
    handleDateChange(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const goToToday = () => {
    handleDateChange(new Date());
  };

  const getPeriodPosition = (schedule: PeriodSchedule, day: Date): 'start' | 'middle' | 'end' | 'start end' => {
    const scheduleStart = new Date(schedule.startDate);
    scheduleStart.setHours(0, 0, 0, 0);
    const scheduleEnd = new Date(schedule.endDate);
    scheduleEnd.setHours(0, 0, 0, 0);
    const currentDay = new Date(day);
    currentDay.setHours(0, 0, 0, 0);
    
    const isStart = currentDay.getTime() === scheduleStart.getTime();
    const isEnd = currentDay.getTime() === scheduleEnd.getTime();
    
    if (isStart && isEnd) return 'start end';
    if (isStart) return 'start';
    if (isEnd) return 'end';
    return 'middle';
  };

  const handleEventClick = (e: React.MouseEvent, event: ManualTodo | PeriodSchedule) => {
    e.stopPropagation();
    setSelectedEvent(event);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long'
    });
  };

  if (loading) {
    return (
      <div className="loading-state">
        <div className="loading-spinner"></div>
        <p>Loading calendar data...</p>
      </div>
    );
  }

  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  return (
    <div className="calendar-container">
      <div className="calendar-header">
        <div className="header-left">
          <h2 className="calendar-title">
            {monthNames[currentDate.getMonth()]} 
            <span className="year">{currentDate.getFullYear()}</span>
          </h2>
        </div>
        <div className="calendar-nav">
          <button className="nav-btn" onClick={goToPreviousMonth} aria-label="Previous month">
            <ChevronLeft size={20} />
          </button>
          <button className="today-btn" onClick={goToToday}>Today</button>
          <button className="nav-btn" onClick={goToNextMonth} aria-label="Next month">
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      <div className="calendar-weekdays">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className={`weekday ${day === 'Sun' ? 'sunday' : ''} ${day === 'Sat' ? 'saturday' : ''}`}>
            {day}
          </div>
        ))}
      </div>

      <div className="calendar-grid">
        {days.map((day, index) => {
          const dateKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const dayTodos = todosByDate[dateKey] || [];
          // Sort schedules: multi-day first
          const dayPeriodSchedules = [...(periodSchedulesByDate[dateKey] || [])].sort((a, b) => {
            const getIsMultiDay = (schedule: PeriodSchedule) => {
              const start = new Date(schedule.startDate);
              start.setHours(0, 0, 0, 0);
              const end = new Date(schedule.endDate);
              end.setHours(0, 0, 0, 0);
              return start.getTime() !== end.getTime();
            };
            
            const aMulti = getIsMultiDay(a);
            const bMulti = getIsMultiDay(b);
            
            if (aMulti && !bMulti) return -1;
            if (!aMulti && bMulti) return 1;
            return 0;
          });
          const isCurrentMonth = day.getMonth() === currentDate.getMonth();
          const isToday = day.toDateString() === new Date().toDateString();

          return (
            <div
              key={index}
              className={`calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}`}
            >
              <div className="day-header">
                <span className={`day-number ${day.getDay() === 0 ? 'sunday' : ''} ${day.getDay() === 6 ? 'saturday' : ''}`}>
                  {day.getDate()}
                </span>
              </div>
              
              <div className="day-content">
                {dayPeriodSchedules.map(schedule => {
                  const position = getPeriodPosition(schedule, day);
                  // 기간 일정인지 단일 일정인지 확인
                  const startDate = new Date(schedule.startDate);
                  startDate.setHours(0, 0, 0, 0);
                  const endDate = new Date(schedule.endDate);
                  endDate.setHours(0, 0, 0, 0);
                  const isPeriodSchedule = startDate.getTime() !== endDate.getTime();
                  
                  return (
                    <div
                      key={`${schedule.id}-${dateKey}`}
                      className={`calendar-schedule ${isPeriodSchedule ? 'period' : 'single'} ${position}`}
                      onClick={(e) => handleEventClick(e, schedule)}
                      title={schedule.content}
                    >
                      {(position === 'start' || position === 'start end' || day.getDay() === 0) && (
                        <span className="schedule-text">
                          {schedule.calendarTitle || stripHtml(schedule.content)}
                        </span>
                      )}
                    </div>
                  );
                })}
                
                {dayTodos.map(todo => (
                  <div 
                    key={todo.id} 
                    className="calendar-todo" 
                    onClick={(e) => handleEventClick(e, todo)}
                    title={stripHtml(todo.content)}
                  >
                    <span className="todo-dot"></span>
                    <span className="todo-text">{todo.calendarTitle || stripHtml(todo.content)}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Modal 
        isOpen={!!selectedEvent} 
        onClose={() => setSelectedEvent(null)}
        title={selectedEvent?.calendarTitle || "일정 상세"}
      >
        {selectedEvent && (
          <div className="event-detail-content">
            <div className="event-time-info">
              <Clock size={16} className="text-gray-400" />
              {'startDate' in selectedEvent ? (
                <span>
                  {formatDate(selectedEvent.startDate)} - {formatDate(selectedEvent.endDate)}
                </span>
              ) : (
                <span>{formatDate(selectedEvent.deadline)}</span>
              )}
            </div>
            <div 
              className="event-body"
              dangerouslySetInnerHTML={{ __html: fetchedContent || selectedEvent.content || (fetchingContent ? '<p>내용을 불러오는 중...</p>' : '<p class="text-gray-400 italic">내용이 없습니다.</p>') }}
            />
          </div>
        )}
      </Modal>
    </div>
  );
};
