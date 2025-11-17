import React, { useEffect, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import './styles.css';
import './CalendarWidget.css';

const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CALENDAR_TITLES = 'CalendarTitles';
const REG_KEY_PERIOD_SCHEDULES = 'PeriodSchedules';

interface ManualTodo {
  id: number;
  content: string;
  deadline: string | null;
  createdAt: string;
  calendarTitle?: string;
}

interface PeriodSchedule {
  id: number;
  content: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  calendarTitle?: string;
  createdAt: string;
}

interface TodoItem {
  id: number;
  content: string;
  deadline: string | null;
  sender?: string;
  isManual?: boolean;
  calendarTitle?: string;
}

function CalendarWidget() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [manualTodos, setManualTodos] = useState<ManualTodo[]>([]);
  const [deadlines, setDeadlines] = useState<Record<number, string | null>>({});
  const [calendarTitles, setCalendarTitles] = useState<Record<number, string>>({});
  const [periodSchedules, setPeriodSchedules] = useState<PeriodSchedule[]>([]);
  const [keptMessages, setKeptMessages] = useState<any[]>([]);
  const [hoverTimers, setHoverTimers] = useState<Record<number, ReturnType<typeof setTimeout>>>({});
  const [addTodoModalOpen, setAddTodoModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [editTodoModalOpen, setEditTodoModalOpen] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState<TodoItem | null>(null);
  const [addPeriodModalOpen, setAddPeriodModalOpen] = useState(false);

  const loadTodos = useCallback(async () => {
    try {
      const savedManualTodos = await invoke<string | null>('get_registry_value', { key: REG_KEY_MANUAL_TODOS });
      if (savedManualTodos) {
        setManualTodos(JSON.parse(savedManualTodos) || []);
      }

      const savedDeadlines = await invoke<string | null>('get_registry_value', { key: REG_KEY_DEADLINES });
      if (savedDeadlines) {
        setDeadlines(JSON.parse(savedDeadlines) || {});
      }

      const savedCalendarTitles = await invoke<string | null>('get_registry_value', { key: REG_KEY_CALENDAR_TITLES });
      if (savedCalendarTitles) {
        setCalendarTitles(JSON.parse(savedCalendarTitles) || {});
      }

      const savedPeriodSchedules = await invoke<string | null>('get_registry_value', { key: REG_KEY_PERIOD_SCHEDULES });
      if (savedPeriodSchedules) {
        setPeriodSchedules(JSON.parse(savedPeriodSchedules) || []);
      }

      // classified와 allMessages를 가져와서 keptMessages 계산
      const savedClassified = await invoke<string | null>('get_registry_value', { key: 'ClassifiedMap' });
      const classified: Record<number, 'left' | 'right'> = savedClassified ? JSON.parse(savedClassified) : {};
      
      const savedUdbPath = await invoke<string | null>('get_registry_value', { key: 'UdbPath' });
      if (savedUdbPath) {
        // 모든 메시지를 가져와서 keptMessages 계산
        try {
          const result = await invoke<{ messages: any[]; total_count: number }>('read_udb_messages', {
            dbPath: savedUdbPath,
            limit: 1000, // 충분히 큰 수
            offset: 0,
            searchTerm: null,
          });
          
          const rightIds = new Set(Object.keys(classified).filter(k => classified[Number(k)] === 'right').map(Number));
          const kept = result.messages.filter(m => rightIds.has(m.id));
          setKeptMessages(kept);
        } catch (e) {
          console.error('메시지 로드 실패:', e);
        }
      }
    } catch (e) {
      console.error('할 일 로드 실패:', e);
    }
  }, []);

  useEffect(() => {
    loadTodos();
    // 주기적으로 업데이트 (10초마다 - 이벤트 기반 업데이트가 주로 사용됨)
    const interval = setInterval(loadTodos, 10000);
    
    // 레지스트리 변경 이벤트 구독 (즉시 업데이트)
    const unlistenPromise = listen('calendar-update', () => {
      loadTodos();
    });
    
    return () => {
      clearInterval(interval);
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [loadTodos]);

  // 달력 렌더링
  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    const firstDay = new Date(year, month, 1);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay()); // 주의 첫 번째 날
    
    const days: Date[] = [];
    const current = new Date(startDate);
    while (days.length < 42) { // 6주 * 7일
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    // 모든 할 일을 합침
    const allTodos: TodoItem[] = [
      ...keptMessages.map(m => ({ 
        id: m.id, 
        content: m.content, 
        deadline: deadlines[m.id] || null, 
        sender: m.sender, 
        isManual: false,
        calendarTitle: calendarTitles[m.id] || undefined
      })),
      ...manualTodos.map(t => ({ 
        id: t.id, 
        content: t.content, 
        deadline: t.deadline, 
        isManual: true,
        calendarTitle: t.calendarTitle || calendarTitles[t.id] || undefined
      }))
    ];

    // 날짜별로 할 일 그룹화
    const todosByDate: Record<string, TodoItem[]> = {};
    allTodos.forEach(todo => {
      if (todo.deadline) {
        const date = new Date(todo.deadline);
        const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (!todosByDate[dateKey]) {
          todosByDate[dateKey] = [];
        }
        todosByDate[dateKey].push(todo);
      }
    });

    // 날짜별로 기간 일정 그룹화
    const periodSchedulesByDate: Record<string, PeriodSchedule[]> = {};
    periodSchedules.forEach(schedule => {
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

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return (
      <div className="calendar-grid">
        {days.map((day, index) => {
          const dateKey = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const dayTodos = todosByDate[dateKey] || [];
          const dayPeriodSchedules = periodSchedulesByDate[dateKey] || [];
          const isCurrentMonth = day.getMonth() === month;
          const isToday = day.getTime() === today.getTime();
          const isPast = day < today && !isToday;
          const dayOfWeek = day.getDay();
          const isSunday = dayOfWeek === 0;
          const isSaturday = dayOfWeek === 6;

          // 기간 일정이 해당 날짜에서 시작/중간/끝인지 확인
          const getPeriodPosition = (schedule: PeriodSchedule): 'start' | 'middle' | 'end' | 'start end' => {
            const scheduleStart = new Date(schedule.startDate);
            scheduleStart.setHours(0, 0, 0, 0);
            const scheduleEnd = new Date(schedule.endDate);
            scheduleEnd.setHours(0, 0, 0, 0);
            const currentDay = new Date(day);
            currentDay.setHours(0, 0, 0, 0);
            
            const isStart = currentDay.getTime() === scheduleStart.getTime();
            const isEnd = currentDay.getTime() === scheduleEnd.getTime();
            
            if (isStart && isEnd) {
              return 'start end';
            } else if (isStart) {
              return 'start';
            } else if (isEnd) {
              return 'end';
            } else {
              return 'middle';
            }
          };

          return (
            <div
              key={index}
              className={`calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isCurrentMonth ? 'current-month' : ''} ${isToday ? 'today' : ''} ${isPast ? 'past' : ''} ${isSunday ? 'sunday' : ''} ${isSaturday ? 'saturday' : ''}`}
              onDoubleClick={() => {
                setSelectedDate(day);
                setAddTodoModalOpen(true);
              }}
            >
              <div className="calendar-day-number">{day.getDate()}</div>
              {(dayPeriodSchedules.length > 0 || dayTodos.length > 0) && (
                <div className="calendar-day-todos">
                  {/* 기간 일정을 먼저 표시 (상단) */}
                  {dayPeriodSchedules.map(schedule => {
                    const title = schedule.calendarTitle || (schedule.content.length > 10 ? schedule.content.substring(0, 10) + '...' : schedule.content);
                    const position = getPeriodPosition(schedule);
                    const className = position === 'start end' 
                      ? 'calendar-period-schedule period-start period-end'
                      : `calendar-period-schedule period-${position}`;
                    return (
                      <div
                        key={`period-${schedule.id}`}
                        className={className}
                        onClick={(e) => {
                          e.stopPropagation();
                          // 기간 일정 편집 모달 (추후 구현 가능)
                        }}
                      >
                        {title}
                      </div>
                    );
                  })}
                  {/* 일반 할 일 표시 */}
                  {dayTodos.slice(0, 2).map(todo => {
                    const title = todo.calendarTitle || (todo.content.length > 10 ? todo.content.substring(0, 10) + '...' : todo.content);
                    return (
                      <div
                        key={todo.id}
                        className="calendar-todo-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedTodo(todo);
                          setEditTodoModalOpen(true);
                        }}
                        onMouseEnter={() => {
                          // 기존 타이머가 있으면 제거
                          if (hoverTimers[todo.id]) {
                            clearTimeout(hoverTimers[todo.id]);
                          }
                          // 2초 후 메시지 뷰어 열기
                          const timer = setTimeout(async () => {
                            try {
                              await invoke('open_message_viewer', {
                                messageId: todo.id
                              });
                            } catch (e) {
                              console.error('메시지 뷰어 열기 실패:', e);
                            }
                          }, 2000);
                            setHoverTimers((prev: Record<number, ReturnType<typeof setTimeout>>) => ({ ...prev, [todo.id]: timer }));
                        }}
                        onMouseLeave={() => {
                          // 마우스가 벗어나면 타이머 제거
                          if (hoverTimers[todo.id]) {
                            clearTimeout(hoverTimers[todo.id]);
                            setHoverTimers((prev: Record<number, ReturnType<typeof setTimeout>>) => {
                              const next = { ...prev };
                              delete next[todo.id];
                              return next;
                            });
                          }
                        }}
                      >
                        {title}
                      </div>
                    );
                  })}
                  {(dayPeriodSchedules.length === 0 && dayTodos.length > 2) && (
                    <div className="calendar-todo-more">+{dayTodos.length - 2}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const goToPreviousMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  // 간단한 날짜 파싱 함수 (기본적인 패턴만 지원)
  const parseDateFromText = (text: string, baseDate?: Date): { date: string | null; time: string | null } => {
    const now = baseDate || new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    
    // 상대적 날짜 패턴
    const relativeDatePatterns = [
      { pattern: /오늘|지금/i, days: 0 },
      { pattern: /내일/i, days: 1 },
      { pattern: /모레/i, days: 2 },
      { pattern: /다음\s*주|다음주/i, days: 7 },
    ];

    let parsedDate: Date | null = null;
    let parsedTime: string | null = null;

    // 상대적 날짜 체크
    for (const { pattern, days } of relativeDatePatterns) {
      if (pattern.test(text)) {
        parsedDate = new Date(now);
        parsedDate.setDate(parsedDate.getDate() + days);
        break;
      }
    }

    // 절대 날짜 패턴 (YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD)
    if (!parsedDate) {
      const dateMatch = text.match(/(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
      if (dateMatch) {
        const year = parseInt(dateMatch[1]);
        const month = parseInt(dateMatch[2]) - 1;
        const day = parseInt(dateMatch[3]);
        parsedDate = new Date(year, month, day);
      }
    }

    // 시간 패턴 (HH:MM)
    const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      parsedTime = `${pad(parseInt(timeMatch[1]))}:${pad(parseInt(timeMatch[2]))}`;
    }

    return {
      date: parsedDate ? `${parsedDate.getFullYear()}-${pad(parsedDate.getMonth() + 1)}-${pad(parsedDate.getDate())}` : null,
      time: parsedTime
    };
  };

  const saveToRegistry = async (key: string, value: string) => {
    await invoke('set_registry_value', { key, value });
  };

  return (
    <div className="calendar-widget">
      <div className="calendar-widget-header">
        <button onClick={goToPreviousMonth} className="calendar-nav-btn">‹</button>
        <div className="calendar-month-year">
          {currentDate.getFullYear()}년 {currentDate.getMonth() + 1}월
        </div>
        <button onClick={goToNextMonth} className="calendar-nav-btn">›</button>
      </div>
      <div className="calendar-weekdays">
        <div className="calendar-weekday">일</div>
        <div className="calendar-weekday">월</div>
        <div className="calendar-weekday">화</div>
        <div className="calendar-weekday">수</div>
        <div className="calendar-weekday">목</div>
        <div className="calendar-weekday">금</div>
        <div className="calendar-weekday">토</div>
      </div>
      {renderCalendar()}
      <div className="calendar-footer-trigger"></div>
      <div className="calendar-widget-footer">
        <button onClick={goToToday} className="calendar-today-btn">오늘</button>
        <button 
          onClick={() => setAddPeriodModalOpen(true)} 
          className="calendar-today-btn"
          style={{ marginLeft: '10px', background: 'rgba(255, 165, 0, 0.3)', borderColor: 'rgba(255, 165, 0, 0.6)' }}
        >
          기간 일정 등록
        </button>
      </div>
      {addTodoModalOpen && selectedDate && (
        <AddTodoModalWidget
          selectedDate={selectedDate}
          onClose={() => {
            setAddTodoModalOpen(false);
            setSelectedDate(null);
          }}
          onSave={async (content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string) => {
            if (!content.trim()) {
              alert('할 일 내용을 입력해주세요.');
              return;
            }

            const newId = Date.now();
            const deadline = deadlineDate && deadlineTime 
              ? new Date(`${deadlineDate}T${deadlineTime}:00`).toISOString()
              : null;

            const newTodo: ManualTodo = {
              id: newId,
              content: content.trim(),
              deadline,
              createdAt: new Date().toISOString(),
              calendarTitle: calendarTitle.trim() || undefined,
            };

            const currentTodos = [...manualTodos, newTodo];
            await saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(currentTodos));
            setManualTodos(currentTodos);

            if (deadline) {
              const currentDeadlines = { ...deadlines, [newId]: deadline };
              await saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(currentDeadlines));
              setDeadlines(currentDeadlines);
            }

            if (calendarTitle.trim()) {
              const currentTitles = { ...calendarTitles, [newId]: calendarTitle.trim() };
              await saveToRegistry(REG_KEY_CALENDAR_TITLES, JSON.stringify(currentTitles));
              setCalendarTitles(currentTitles);
            }

            void emit('calendar-update');
            setAddTodoModalOpen(false);
            setSelectedDate(null);
            loadTodos();
          }}
          parseDateFromText={parseDateFromText}
        />
      )}
      {editTodoModalOpen && selectedTodo && (
        <EditTodoModalWidget
          todo={selectedTodo}
          manualTodos={manualTodos}
          deadlines={deadlines}
          calendarTitles={calendarTitles}
          onClose={() => {
            setEditTodoModalOpen(false);
            setSelectedTodo(null);
          }}
          onSave={async (content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string) => {
            const todoId = selectedTodo.id;
            const deadline = deadlineDate && deadlineTime 
              ? new Date(`${deadlineDate}T${deadlineTime}:00`).toISOString()
              : null;

            // ManualTodo인 경우
            if (selectedTodo.isManual) {
              const updatedTodos = manualTodos.map(t => 
                t.id === todoId 
                  ? { ...t, content: content.trim(), deadline, calendarTitle: calendarTitle.trim() || undefined }
                  : t
              );
              await saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(updatedTodos));
              setManualTodos(updatedTodos);
            }

            // deadline 업데이트
            if (deadline) {
              const updatedDeadlines = { ...deadlines, [todoId]: deadline };
              await saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(updatedDeadlines));
              setDeadlines(updatedDeadlines);
            } else {
              const updatedDeadlines = { ...deadlines };
              delete updatedDeadlines[todoId];
              await saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(updatedDeadlines));
              setDeadlines(updatedDeadlines);
            }

            // calendarTitle 업데이트
            if (calendarTitle.trim()) {
              const updatedTitles = { ...calendarTitles, [todoId]: calendarTitle.trim() };
              await saveToRegistry(REG_KEY_CALENDAR_TITLES, JSON.stringify(updatedTitles));
              setCalendarTitles(updatedTitles);
            } else {
              const updatedTitles = { ...calendarTitles };
              delete updatedTitles[todoId];
              await saveToRegistry(REG_KEY_CALENDAR_TITLES, JSON.stringify(updatedTitles));
              setCalendarTitles(updatedTitles);
            }

            void emit('calendar-update');
            setEditTodoModalOpen(false);
            setSelectedTodo(null);
            loadTodos();
          }}
          parseDateFromText={parseDateFromText}
        />
      )}
      {addPeriodModalOpen && (
        <AddPeriodModalWidget
          onClose={() => {
            setAddPeriodModalOpen(false);
          }}
          onSave={async (content: string, calendarTitle: string, startDate: string, endDate: string) => {
            if (!content.trim()) {
              alert('일정 내용을 입력해주세요.');
              return;
            }

            if (!startDate || !endDate) {
              alert('시작일과 종료일을 모두 입력해주세요.');
              return;
            }

            if (new Date(startDate) > new Date(endDate)) {
              alert('시작일이 종료일보다 늦을 수 없습니다.');
              return;
            }

            const newId = Date.now();
            const newSchedule: PeriodSchedule = {
              id: newId,
              content: content.trim(),
              startDate,
              endDate,
              createdAt: new Date().toISOString(),
              calendarTitle: calendarTitle.trim() || undefined,
            };

            const currentSchedules = [...periodSchedules, newSchedule];
            await saveToRegistry(REG_KEY_PERIOD_SCHEDULES, JSON.stringify(currentSchedules));
            setPeriodSchedules(currentSchedules);

            void emit('calendar-update');
            setAddPeriodModalOpen(false);
            loadTodos();
          }}
        />
      )}
    </div>
  );
}

interface EditTodoModalWidgetProps {
  todo: TodoItem;
  manualTodos: ManualTodo[];
  deadlines: Record<number, string | null>;
  calendarTitles: Record<number, string>;
  onClose: () => void;
  onSave: (content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string) => Promise<void>;
  parseDateFromText: (text: string, baseDate?: Date) => { date: string | null; time: string | null };
}

const EditTodoModalWidget: React.FC<EditTodoModalWidgetProps> = ({ todo, manualTodos, deadlines, calendarTitles, onClose, onSave, parseDateFromText }) => {
  const pad = (n: number) => n.toString().padStart(2, '0');
  
  // HTML 엔티티 디코딩 함수
  const decodeEntities = (html: string): string => {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = html;
    return textarea.value;
  };
  
  // 기존 값 로드
  const existingDeadline = deadlines[todo.id] || (todo.isManual ? manualTodos.find(t => t.id === todo.id)?.deadline : null);
  const existingCalendarTitle = todo.calendarTitle || calendarTitles[todo.id] || '';
  const existingContent = todo.content;

  const defaultDate = existingDeadline 
    ? `${new Date(existingDeadline).getFullYear()}-${pad(new Date(existingDeadline).getMonth() + 1)}-${pad(new Date(existingDeadline).getDate())}`
    : `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`;
  const defaultTime = existingDeadline
    ? `${pad(new Date(existingDeadline).getHours())}:${pad(new Date(existingDeadline).getMinutes())}`
    : `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;

  const [content, setContent] = useState<string>(existingContent);
  const [calendarTitle, setCalendarTitle] = useState<string>(existingCalendarTitle);
  const [deadlineDate, setDeadlineDate] = useState<string>(defaultDate);
  const [deadlineTime, setDeadlineTime] = useState<string>(defaultTime);
  const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    const parsed = parseDateFromText(newContent);
    setParsedDateInfo(parsed);
    if (parsed.date && !deadlineDate) {
      setDeadlineDate(parsed.date);
    }
    if (parsed.time && !deadlineTime) {
      setDeadlineTime(parsed.time);
    }
  };

  const handleSave = async () => {
    await onSave(content, calendarTitle, deadlineDate, deadlineTime);
  };

  return (
    <div className="schedule-modal-overlay" onClick={onClose}>
      <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-inner">
          <div className="schedule-preview">
            <div>
              <h3 style={{ marginBottom: '12px', color: '#1a1a1a', marginTop: 0 }}>할 일 내용</h3>
              {todo.isManual ? (
                <textarea
                  value={content}
                  onChange={(e) => handleContentChange(e.target.value)}
                  placeholder="할 일 내용을 입력하세요... (예: 내일까지 과제 제출, 12월 25일 오후 3시 회의)"
                  style={{
                    width: '100%',
                    minHeight: '200px',
                    padding: '12px',
                    border: '1px solid rgba(0, 0, 0, 0.15)',
                    borderRadius: '8px',
                    fontSize: '15px',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                    backgroundColor: '#ffffff',
                    color: '#1a1a1a',
                    boxSizing: 'border-box',
                  }}
                />
              ) : (
                <div 
                  style={{
                    width: '100%',
                    minHeight: '200px',
                    padding: '12px',
                    border: '1px solid rgba(0, 0, 0, 0.1)',
                    borderRadius: '8px',
                    fontSize: '15px',
                    fontFamily: 'inherit',
                    backgroundColor: '#ffffff',
                    color: '#1a1a1a',
                    lineHeight: '1.6',
                    boxSizing: 'border-box',
                  }}
                  dangerouslySetInnerHTML={{ __html: decodeEntities(content) }}
                />
              )}
              {parsedDateInfo.date && (
                <div style={{ 
                  marginTop: '8px', 
                  padding: '8px', 
                  backgroundColor: '#e8f4fd', 
                  borderRadius: '8px',
                  fontSize: '13px',
                  color: '#0066cc'
                }}>
                  📅 날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
                </div>
              )}
            </div>
          </div>
          <div className="schedule-panel">
            <h3>마감 시간 설정</h3>
            <label htmlFor="calendar-edit-todo-calendar-title">달력 제목 (짧게)</label>
            <input 
              id="calendar-edit-todo-calendar-title" 
              type="text" 
              value={calendarTitle}
              onChange={(e) => setCalendarTitle(e.target.value)}
              placeholder="예: 과제 제출, 회의"
              maxLength={20}
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid rgba(0, 0, 0, 0.15)',
                borderRadius: '8px',
                fontSize: '14px',
                backgroundColor: '#ffffff',
                color: '#1a1a1a',
              }}
            />
            <label htmlFor="calendar-edit-todo-deadline-date">날짜</label>
            <input 
              id="calendar-edit-todo-deadline-date" 
              type="date" 
              value={deadlineDate || defaultDate}
              onChange={(e) => setDeadlineDate(e.target.value)} 
            />
            <label htmlFor="calendar-edit-todo-deadline-time">시간</label>
            <input 
              id="calendar-edit-todo-deadline-time" 
              type="time" 
              value={deadlineTime || defaultTime}
              onChange={(e) => setDeadlineTime(e.target.value)} 
            />
            <div className="row">
              <button onClick={handleSave}>저장</button>
              <button onClick={onClose}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface AddTodoModalWidgetProps {
  selectedDate: Date;
  onClose: () => void;
  onSave: (content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string) => Promise<void>;
  parseDateFromText: (text: string, baseDate?: Date) => { date: string | null; time: string | null };
}

interface AddPeriodModalWidgetProps {
  onClose: () => void;
  onSave: (content: string, calendarTitle: string, startDate: string, endDate: string) => Promise<void>;
}

const AddPeriodModalWidget: React.FC<AddPeriodModalWidgetProps> = ({ onClose, onSave }) => {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const defaultStartDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultEndDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const [content, setContent] = useState<string>('');
  const [calendarTitle, setCalendarTitle] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(defaultStartDate);
  const [endDate, setEndDate] = useState<string>(defaultEndDate);

  const handleSave = async () => {
    await onSave(content, calendarTitle, startDate, endDate);
  };

  return (
    <div className="schedule-modal-overlay" onClick={onClose}>
      <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-inner">
          <div className="schedule-preview">
            <div style={{ padding: '16px' }}>
              <h3 style={{ marginBottom: '12px' }}>기간 일정 내용</h3>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="기간 일정 내용을 입력하세요... (예: 겨울 방학, 프로젝트 기간)"
                style={{
                  width: '100%',
                  minHeight: '200px',
                  padding: '12px',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius)',
                  fontSize: '15px',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
              />
            </div>
          </div>
          <div className="schedule-panel">
            <h3>기간 설정</h3>
            <label htmlFor="period-calendar-title">달력 제목 (짧게)</label>
            <input 
              id="period-calendar-title" 
              type="text" 
              value={calendarTitle}
              onChange={(e) => setCalendarTitle(e.target.value)}
              placeholder="예: 겨울방학, 프로젝트"
              maxLength={20}
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius)',
                fontSize: '14px',
              }}
            />
            <label htmlFor="period-start-date">시작일</label>
            <input 
              id="period-start-date" 
              type="date" 
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)} 
            />
            <label htmlFor="period-end-date">종료일</label>
            <input 
              id="period-end-date" 
              type="date" 
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)} 
            />
            <div className="row">
              <button onClick={handleSave}>저장</button>
              <button onClick={onClose}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const AddTodoModalWidget: React.FC<AddTodoModalWidgetProps> = ({ selectedDate, onClose, onSave, parseDateFromText }) => {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const defaultDate = `${selectedDate.getFullYear()}-${pad(selectedDate.getMonth() + 1)}-${pad(selectedDate.getDate())}`;
  const now = new Date();
  const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const [content, setContent] = useState<string>('');
  const [calendarTitle, setCalendarTitle] = useState<string>('');
  const [deadlineDate, setDeadlineDate] = useState<string>(defaultDate);
  const [deadlineTime, setDeadlineTime] = useState<string>(defaultTime);
  const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    const parsed = parseDateFromText(newContent, selectedDate);
    setParsedDateInfo(parsed);
    if (parsed.date && !deadlineDate) {
      setDeadlineDate(parsed.date);
    }
    if (parsed.time && !deadlineTime) {
      setDeadlineTime(parsed.time);
    }
  };

  const handleSave = async () => {
    await onSave(content, calendarTitle, deadlineDate, deadlineTime);
  };

  return (
    <div className="schedule-modal-overlay" onClick={onClose}>
      <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-inner">
          <div className="schedule-preview">
            <div style={{ padding: '16px' }}>
              <h3 style={{ marginBottom: '12px' }}>할 일 내용</h3>
              <textarea
                value={content}
                onChange={(e) => handleContentChange(e.target.value)}
                placeholder="할 일 내용을 입력하세요... (예: 내일까지 과제 제출, 12월 25일 오후 3시 회의)"
                style={{
                  width: '100%',
                  minHeight: '200px',
                  padding: '12px',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius)',
                  fontSize: '15px',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
              />
              {parsedDateInfo.date && (
                <div style={{ 
                  marginTop: '8px', 
                  padding: '8px', 
                  backgroundColor: 'var(--bg-light)', 
                  borderRadius: 'var(--radius)',
                  fontSize: '13px',
                  color: 'var(--primary)'
                }}>
                  📅 날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
                </div>
              )}
            </div>
          </div>
          <div className="schedule-panel">
            <h3>마감 시간 설정</h3>
            <label htmlFor="calendar-add-todo-calendar-title">달력 제목 (짧게)</label>
            <input 
              id="calendar-add-todo-calendar-title" 
              type="text" 
              value={calendarTitle}
              onChange={(e) => setCalendarTitle(e.target.value)}
              placeholder="예: 과제 제출, 회의"
              maxLength={20}
              style={{
                width: '100%',
                padding: '8px',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius)',
                fontSize: '14px',
              }}
            />
            <label htmlFor="calendar-add-todo-deadline-date">날짜</label>
            <input 
              id="calendar-add-todo-deadline-date" 
              type="date" 
              value={deadlineDate || defaultDate}
              onChange={(e) => setDeadlineDate(e.target.value)} 
            />
            <label htmlFor="calendar-add-todo-deadline-time">시간</label>
            <input 
              id="calendar-add-todo-deadline-time" 
              type="time" 
              value={deadlineTime || defaultTime}
              onChange={(e) => setDeadlineTime(e.target.value)} 
            />
            <div className="row">
              <button onClick={handleSave}>저장</button>
              <button onClick={onClose}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

function CalendarWidgetApp() {
  // 윈도우 드래그 가능하게 만들기
  useEffect(() => {
    const handleMouseDown = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.calendar-widget-header') || target.closest('.calendar-widget-footer')) {
        const window = getCurrentWindow();
        await window.startDragging();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);

  return <CalendarWidget />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CalendarWidgetApp />
  </React.StrictMode>
);

