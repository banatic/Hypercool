import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { AttachmentList } from './components/AttachmentList';
import { ManualTodo, PeriodSchedule } from './types';
import './styles.css';
import './CalendarWidget.css';

const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';
const REG_KEY_CALENDAR_TITLES = 'CalendarTitles';
const REG_KEY_PERIOD_SCHEDULES = 'PeriodSchedules';
const REG_KEY_COMPLETED_TODOS = 'CompletedTodos';
const REG_KEY_TODO_ORDER = 'TodoOrderMap';



interface TodoItem {
  id: string;
  content: string;
  deadline: string | null;
  sender?: string;
  isManual?: boolean;
  calendarTitle?: string;
  isCompleted?: boolean;
  file_paths?: string[];
  updatedAt?: string;
  isDeleted?: boolean;
}

interface CalendarWidgetProps {
  isPinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
}

function CalendarWidget({ isPinned = false, onPinnedChange }: CalendarWidgetProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [manualTodos, setManualTodos] = useState<ManualTodo[]>([]);
  const [deadlines, setDeadlines] = useState<Record<string, string | null>>({});
  const [calendarTitles, setCalendarTitles] = useState<Record<string, string>>({});
  const [periodSchedules, setPeriodSchedules] = useState<PeriodSchedule[]>([]);
  const [completedTodos, setCompletedTodos] = useState<Set<string>>(new Set());
  const [keptMessages, setKeptMessages] = useState<any[]>([]);
  const [todoOrder, setTodoOrder] = useState<Record<string, string[]>>({}); // 날짜별 할일 ID 순서
  const [draggedTodoId, setDraggedTodoId] = useState<string | null>(null);
  const draggedTodoIdRef = useRef<string | null>(null); // 동기적으로 접근하기 위한 ref
  // const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 }); // Performance: Removed state
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const startPosRef = useRef({ x: 0, y: 0 }); // 드래그 시작 위치 (클릭 판별용)
  const isDraggingRef = useRef(false);
  const ignoreClickRef = useRef(false); // 드래그 후 클릭 이벤트 무시용
  const ghostRef = useRef<HTMLDivElement>(null); // 고스트 엘리먼트 직접 제어용

  const [dragOverDateKey, setDragOverDateKey] = useState<string | null>(null);
  const [dragOverTodoId, setDragOverTodoId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<'above' | 'below' | null>(null);
  const [addTodoModalOpen, setAddTodoModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [editTodoModalOpen, setEditTodoModalOpen] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState<TodoItem | null>(null);
  const [addPeriodModalOpen, setAddPeriodModalOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; todo?: TodoItem; schedule?: PeriodSchedule } | null>(null);

  // 모든 할일 목록 (메모이제이션)
  const allTodos = useMemo(() => {
    return [
      ...keptMessages.map(m => {
        const id = m.id.toString();
        return { 
          id, 
          content: m.content, 
          deadline: deadlines[id] || null, 
          sender: m.sender, 
          isManual: false,
          calendarTitle: calendarTitles[id] || undefined,
          isCompleted: completedTodos.has(id),
          file_paths: m.file_paths,
          isDeleted: false
        };
      }),
      ...manualTodos.map(t => ({ 
        id: t.id, 
        content: t.content, 
        deadline: t.deadline, 
        isManual: true,
        calendarTitle: t.calendarTitle || calendarTitles[t.id] || undefined,
        isCompleted: completedTodos.has(t.id),
        updatedAt: t.updatedAt,
        isDeleted: t.isDeleted
      }))
    ].filter(t => !t.isDeleted);
  }, [keptMessages, manualTodos, deadlines, calendarTitles, completedTodos]);

  // 데이터 마이그레이션 (Number ID -> UUID String)
  const migrateData = async () => {
    try {
      const savedManualTodosStr = await invoke<string | null>('get_registry_value', { key: REG_KEY_MANUAL_TODOS });
      const savedPeriodSchedulesStr = await invoke<string | null>('get_registry_value', { key: REG_KEY_PERIOD_SCHEDULES });
      
      let needsMigration = false;
      const manualTodos = savedManualTodosStr ? JSON.parse(savedManualTodosStr) : [];
      const periodSchedules = savedPeriodSchedulesStr ? JSON.parse(savedPeriodSchedulesStr) : [];

      // Check if migration is needed
      if (manualTodos.some((t: any) => typeof t.id === 'number') || periodSchedules.some((s: any) => typeof s.id === 'number')) {
        needsMigration = true;
      }

      if (!needsMigration) return;

      console.log('Starting data migration to UUIDs...');
      const idMap: Record<string, string> = {}; // oldId (stringified) -> newUUID

      // Migrate ManualTodos
      const newManualTodos = manualTodos.map((t: any) => {
        if (typeof t.id === 'number') {
          const newId = crypto.randomUUID();
          idMap[t.id.toString()] = newId;
          return { ...t, id: newId, updatedAt: t.createdAt || new Date().toISOString(), isDeleted: false };
        }
        return t;
      });

      // Migrate PeriodSchedules
      const newPeriodSchedules = periodSchedules.map((s: any) => {
        if (typeof s.id === 'number') {
          const newId = crypto.randomUUID();
          idMap[s.id.toString()] = newId;
          return { ...s, id: newId, updatedAt: s.createdAt || new Date().toISOString(), isDeleted: false };
        }
        return s;
      });

      // Migrate Deadlines
      const savedDeadlinesStr = await invoke<string | null>('get_registry_value', { key: REG_KEY_DEADLINES });
      const deadlines = savedDeadlinesStr ? JSON.parse(savedDeadlinesStr) : {};
      const newDeadlines: Record<string, string | null> = {};
      Object.entries(deadlines).forEach(([key, value]) => {
        const newKey = idMap[key] || key; // Use new UUID if mapped, else keep original (likely message ID)
        newDeadlines[newKey] = value as string | null;
      });

      // Migrate CalendarTitles
      const savedTitlesStr = await invoke<string | null>('get_registry_value', { key: REG_KEY_CALENDAR_TITLES });
      const titles = savedTitlesStr ? JSON.parse(savedTitlesStr) : {};
      const newTitles: Record<string, string> = {};
      Object.entries(titles).forEach(([key, value]) => {
        const newKey = idMap[key] || key;
        newTitles[newKey] = value as string;
      });

      // Migrate CompletedTodos
      const savedCompletedStr = await invoke<string | null>('get_registry_value', { key: REG_KEY_COMPLETED_TODOS });
      const completed = savedCompletedStr ? JSON.parse(savedCompletedStr) : [];
      const newCompleted = completed.map((id: number | string) => idMap[id.toString()] || id.toString());

      // Migrate TodoOrder
      const savedOrderStr = await invoke<string | null>('get_registry_value', { key: REG_KEY_TODO_ORDER });
      const order = savedOrderStr ? JSON.parse(savedOrderStr) : {};
      const newOrder: Record<string, string[]> = {};
      Object.entries(order).forEach(([dateKey, ids]) => {
        newOrder[dateKey] = (ids as (number | string)[]).map(id => idMap[id.toString()] || id.toString());
      });

      // Save all migrated data
      await invoke('set_registry_value', { key: REG_KEY_MANUAL_TODOS, value: JSON.stringify(newManualTodos) });
      await invoke('set_registry_value', { key: REG_KEY_PERIOD_SCHEDULES, value: JSON.stringify(newPeriodSchedules) });
      await invoke('set_registry_value', { key: REG_KEY_DEADLINES, value: JSON.stringify(newDeadlines) });
      await invoke('set_registry_value', { key: REG_KEY_CALENDAR_TITLES, value: JSON.stringify(newTitles) });
      await invoke('set_registry_value', { key: REG_KEY_COMPLETED_TODOS, value: JSON.stringify(newCompleted) });
      await invoke('set_registry_value', { key: REG_KEY_TODO_ORDER, value: JSON.stringify(newOrder) });

      console.log('Data migration completed successfully.');
    } catch (e) {
      console.error('Data migration failed:', e);
    }
  };

  const loadTodos = useCallback(async () => {
    try {
      await migrateData();

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

      const savedCompletedTodos = await invoke<string | null>('get_registry_value', { key: REG_KEY_COMPLETED_TODOS });
      if (savedCompletedTodos) {
        const completedIds = JSON.parse(savedCompletedTodos) || [];
        setCompletedTodos(new Set(completedIds));
      }

      const savedTodoOrder = await invoke<string | null>('get_registry_value', { key: REG_KEY_TODO_ORDER });
      if (savedTodoOrder) {
        setTodoOrder(JSON.parse(savedTodoOrder) || {});
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

    // 모든 할 일을 합침 (메모이제이션된 값 사용)
    const allTodosForRender = allTodos;

    // 날짜별로 할 일 그룹화
    const todosByDate: Record<string, TodoItem[]> = {};
    allTodosForRender.forEach(todo => {
      if (todo.deadline) {
        const date = new Date(todo.deadline);
        const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        if (!todosByDate[dateKey]) {
          todosByDate[dateKey] = [];
        }
        todosByDate[dateKey].push(todo);
      }
    });

    // 날짜별로 할 일 순서 적용
    Object.keys(todosByDate).forEach(dateKey => {
      const dayTodos = todosByDate[dateKey];
      const savedOrder = todoOrder[dateKey];
      
      if (savedOrder && savedOrder.length > 0) {
        // 저장된 순서가 있으면 그 순서대로 정렬
        const orderedTodos: TodoItem[] = [];
        const todoMap = new Map(dayTodos.map(t => [t.id, t]));
        
        // 저장된 순서대로 추가
        savedOrder.forEach(id => {
          const todo = todoMap.get(id);
          if (todo) {
            orderedTodos.push(todo);
            todoMap.delete(id);
          }
        });
        
        // 순서에 없는 새로운 할일들을 뒤에 추가
        todoMap.forEach(todo => orderedTodos.push(todo));
        
        todosByDate[dateKey] = orderedTodos;
      }
    });

    // 날짜별로 기간 일정 그룹화
    const periodSchedulesByDate: Record<string, PeriodSchedule[]> = {};
    periodSchedules.filter(s => !s.isDeleted).forEach(schedule => {
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
              className={`calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isCurrentMonth ? 'current-month' : ''} ${isToday ? 'today' : ''} ${isPast ? 'past' : ''} ${isSunday ? 'sunday' : ''} ${isSaturday ? 'saturday' : ''} ${dragOverDateKey === dateKey ? 'drag-over-day' : ''}`}
              onDoubleClick={() => {
                setSelectedDate(day);
                setAddTodoModalOpen(true);
              }}
              data-date={dateKey} // 마우스 드래그를 위해 data-date 추가
            >
              <div className="calendar-day-number">{day.getDate()}</div>
              {(dayPeriodSchedules.length > 0 || dayTodos.length > 0) && (
                <div 
                  className={`calendar-day-todos ${dragOverDateKey === dateKey ? 'drag-over' : ''}`}
                >
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
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setContextMenu({ x: e.clientX, y: e.clientY, schedule });
                        }}
                      >
                        {title}
                      </div>
                    );
                  })}
                  {/* 일반 할 일 표시 - 완료되지 않은 항목 먼저, 완료된 항목은 최하단 */}
                  {dayTodos
                    .filter(todo => !todo.isCompleted)
                    .map((todo) => {
                      const title = todo.calendarTitle || (todo.content.length > 10 ? todo.content.substring(0, 10) + '...' : todo.content);
                      const isManual = todo.isManual ?? false;
                      const isDragOver = dragOverTodoId === todo.id;
                      return (
                        <React.Fragment key={todo.id}>
                          {isDragOver && dragOverPosition === 'above' && (
                            <div className="calendar-todo-drop-indicator" />
                          )}
                          <div
                            className={`calendar-todo-item ${isManual ? 'calendar-todo-manual' : 'calendar-todo-message'} ${draggedTodoId === todo.id ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
                            onMouseDown={(e) => handleMouseDown(e, todo)}
                            // onClick 제거: handleGlobalMouseUp에서 처리함
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setContextMenu({ x: e.clientX, y: e.clientY, todo });
                            }}
                            data-todo-id={todo.id} // 마우스 드래그를 위해 data-todo-id 추가
                          >
                            {title}
                          </div>
                          {isDragOver && dragOverPosition === 'below' && (
                            <div className="calendar-todo-drop-indicator" />
                          )}
                        </React.Fragment>
                      );
                    })}
                  {/* 완료된 항목은 최하단에 표시 */}
                  {dayTodos
                    .filter(todo => todo.isCompleted)
                    .map(todo => {
                      const title = todo.calendarTitle || (todo.content.length > 10 ? todo.content.substring(0, 10) + '...' : todo.content);
                      const isManual = todo.isManual ?? false;
                      return (
                        <div
                          key={todo.id}
                          className={`calendar-todo-item calendar-todo-completed ${isManual ? 'calendar-todo-manual' : 'calendar-todo-message'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTodo(todo);
                            setEditTodoModalOpen(true);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setContextMenu({ x: e.clientX, y: e.clientY, todo });
                          }}
                        >
                          {title}
                        </div>
                      );
                    })}
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



  // 마우스 드래그 핸들러
  const handleMouseDown = (e: React.MouseEvent, todo: TodoItem) => {
    if (e.button !== 0) return; // 좌클릭만 허용
    e.stopPropagation();
    
    // 클릭 시작 시 ignoreClickRef 초기화
    ignoreClickRef.current = false;
    
    const rect = e.currentTarget.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    startPosRef.current = { x: e.clientX, y: e.clientY };
    
    // setDragPosition({ x: rect.left, y: rect.top }); // State 제거
    // setDraggedTodoId(todo.id); // 드래그 시작 시점(MouseMove)으로 이동하여 단순 클릭 시 리렌더링 방지
    draggedTodoIdRef.current = todo.id;
    
    isDraggingRef.current = false; // 아직 드래그 시작 안함 (클릭과 구분)
    
    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
  };

  const handleGlobalMouseMove = (e: MouseEvent) => {
    if (!draggedTodoIdRef.current) return;
    
    if (!isDraggingRef.current) {
      // 일정 거리 이상 움직였을 때만 드래그 시작 (클릭 미스 방지)
      const dx = e.clientX - startPosRef.current.x;
      const dy = e.clientY - startPosRef.current.y;
      if (Math.hypot(dx, dy) > 5) {
        isDraggingRef.current = true;
        setIsDragging(true);
        setDraggedTodoId(draggedTodoIdRef.current); // 드래그가 확실시될 때 상태 업데이트
      } else {
        return; // 임계값 넘지 않으면 무시
      }
    }

    // Performance: Direct DOM manipulation instead of state update
    if (ghostRef.current) {
      ghostRef.current.style.left = `${e.clientX - dragOffsetRef.current.x}px`;
      ghostRef.current.style.top = `${e.clientY - dragOffsetRef.current.y}px`;
    }
    
    // 드롭 타겟 감지
    // Performance: Use requestAnimationFrame or throttle if needed, but simple check is usually fine
    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (!element) return;
    
    const dayElement = element.closest('.calendar-day');
    if (dayElement) {
      const dateKey = dayElement.getAttribute('data-date');
      if (dateKey) {
        setDragOverDateKey(dateKey);
        
        const todoElement = element.closest('.calendar-todo-item');
        if (todoElement) {
          const todoId = todoElement.getAttribute('data-todo-id');
          if (todoId && todoId !== draggedTodoIdRef.current) {
            setDragOverTodoId(todoId);
            const rect = todoElement.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            setDragOverPosition(e.clientY < centerY ? 'above' : 'below');
          } else {
            setDragOverTodoId(null);
            setDragOverPosition(null);
          }
        } else {
          setDragOverTodoId(null);
          setDragOverPosition(null);
        }
      }
    } else {
      setDragOverDateKey(null);
      setDragOverTodoId(null);
      setDragOverPosition(null);
    }
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);
    
    if (isDraggingRef.current && draggedTodoIdRef.current) {
      // 드래그가 발생했으므로 클릭 이벤트 무시 플래그 설정
      ignoreClickRef.current = true;
      // 약간의 지연 후 초기화 (onClick이 실행될 시간 확보 후 차단 해제는 불필요하지만 안전장치)
      setTimeout(() => {
        ignoreClickRef.current = false;
      }, 100);

      const element = document.elementFromPoint(e.clientX, e.clientY);
      if (element) {
        const dayElement = element.closest('.calendar-day');
        if (dayElement) {
          const dateKey = dayElement.getAttribute('data-date');
          if (dateKey) {
            let targetTodoId: string | undefined;
            let position: 'above' | 'below' | undefined;
            
            const todoElement = element.closest('.calendar-todo-item');
            if (todoElement) {
              const id = todoElement.getAttribute('data-todo-id');
              if (id && id !== draggedTodoIdRef.current) {
                targetTodoId = id;
                const rect = todoElement.getBoundingClientRect();
                const centerY = rect.top + rect.height / 2;
                position = e.clientY < centerY ? 'above' : 'below';
              }
            }
            
            handleDrop(dateKey, targetTodoId, position);
          }
        }
      }
    } else {
      // 드래그가 발생하지 않음 (순수 클릭)
      // onClick 대신 여기서 처리하여 드래그/클릭 간섭 원천 차단
      if (draggedTodoIdRef.current) {
        const todo = allTodos.find(t => t.id === draggedTodoIdRef.current);
        if (todo) {
          setSelectedTodo(todo);
          setEditTodoModalOpen(true);
        }
      }
    }
    
    setIsDragging(false);
    isDraggingRef.current = false;
    setDraggedTodoId(null);
    draggedTodoIdRef.current = null;
    setDragOverDateKey(null);
    setDragOverTodoId(null);
    setDragOverPosition(null);
  };

  // 드롭
  const handleDrop = async (targetDateKey: string, targetTodoId?: string, position?: 'above' | 'below') => {
    const draggedId = draggedTodoIdRef.current;
    if (!draggedId) return;

    let sourceDateKey: string | null = null;
    const draggedTodo = allTodos.find(t => t.id === draggedId);
    if (!draggedTodo) return;
    
    if (draggedTodo.deadline) {
      const date = new Date(draggedTodo.deadline);
      sourceDateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    if (!sourceDateKey) return;

    if (sourceDateKey !== targetDateKey) {
      const targetDateParts = targetDateKey.split('-');
      const newDate = new Date(
        parseInt(targetDateParts[0]), 
        parseInt(targetDateParts[1]), 
        parseInt(targetDateParts[2])
      );
      if (draggedTodo.deadline) {
        const oldDate = new Date(draggedTodo.deadline);
        newDate.setHours(oldDate.getHours(), oldDate.getMinutes(), oldDate.getSeconds());
      } else {
        newDate.setHours(12, 0, 0);
      }
      const newDeadline = newDate.toISOString();

      if (draggedTodo.isManual) {
        const updatedTodos = manualTodos.map(t => 
          t.id === draggedId ? { ...t, deadline: newDeadline, updatedAt: new Date().toISOString() } : t
        );
        await saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(updatedTodos));
        setManualTodos(updatedTodos);
      } 
      const updatedDeadlines = { ...deadlines, [draggedId]: newDeadline };
      await saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(updatedDeadlines));
      setDeadlines(updatedDeadlines);
    }

    const newTodoOrderMap = { ...todoOrder };

    if (sourceDateKey !== targetDateKey && newTodoOrderMap[sourceDateKey]) {
      newTodoOrderMap[sourceDateKey] = newTodoOrderMap[sourceDateKey].filter(id => id !== draggedId);
    }

    const currentOrder = newTodoOrderMap[targetDateKey] || [];
    
    const dayTodos = allTodos.filter(todo => {
      if (!todo.deadline) return false;
      const date = new Date(todo.deadline);
      const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      return dateKey === targetDateKey;
    });

    const incompleteTodos = dayTodos.filter(t => !t.isCompleted);
    const incompleteIds = new Set(incompleteTodos.map(t => t.id));
    
    let newOrder = currentOrder.filter(id => incompleteIds.has(id));
    
    incompleteIds.forEach(id => {
      if (!newOrder.includes(id)) {
        newOrder.push(id);
      }
    });

    newOrder = newOrder.filter(id => id !== draggedId);

    if (targetTodoId !== undefined) {
      const targetIndex = newOrder.indexOf(targetTodoId);
      if (targetIndex !== -1) {
        if (position === 'above') {
          newOrder.splice(targetIndex, 0, draggedId);
        } else if (position === 'below') {
          newOrder.splice(targetIndex + 1, 0, draggedId);
        } else {
          newOrder.splice(targetIndex, 0, draggedId);
        }
      } else {
        newOrder.push(draggedId);
      }
    } else {
      newOrder.push(draggedId);
    }

    newTodoOrderMap[targetDateKey] = newOrder;

    setTodoOrder(newTodoOrderMap);
    await saveToRegistry(REG_KEY_TODO_ORDER, JSON.stringify(newTodoOrderMap));
    
    void emit('calendar-update');
    loadTodos();
  };

  const deleteTodo = async (todo: TodoItem) => {
    const todoId = todo.id;
    
    // ManualTodo인 경우
    if (todo.isManual) {
      // Soft delete
      const updatedTodos = manualTodos.map(t => 
        t.id === todoId ? { ...t, isDeleted: true, updatedAt: new Date().toISOString() } : t
      );
      await saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(updatedTodos));
      setManualTodos(updatedTodos);
    }

    // deadline 삭제
    const updatedDeadlines = { ...deadlines };
    delete updatedDeadlines[todoId];
    await saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(updatedDeadlines));
    setDeadlines(updatedDeadlines);

    // calendarTitle 삭제
    const updatedTitles = { ...calendarTitles };
    delete updatedTitles[todoId];
    await saveToRegistry(REG_KEY_CALENDAR_TITLES, JSON.stringify(updatedTitles));
    setCalendarTitles(updatedTitles);

    void emit('calendar-update');
    setContextMenu(null);
    loadTodos();
  };

  const deletePeriodSchedule = async (schedule: PeriodSchedule) => {
    // Soft delete
    const updatedSchedules = periodSchedules.map(s => 
      s.id === schedule.id ? { ...s, isDeleted: true, updatedAt: new Date().toISOString() } : s
    );
    await saveToRegistry(REG_KEY_PERIOD_SCHEDULES, JSON.stringify(updatedSchedules));
    setPeriodSchedules(updatedSchedules);
    void emit('calendar-update');
    setContextMenu(null);
    loadTodos();
  };

  const toggleTodoCompletion = async (todo: TodoItem) => {
    const todoId = todo.id;
    const newCompletedSet = new Set(completedTodos);
    
    if (completedTodos.has(todoId)) {
      // 완료 취소
      newCompletedSet.delete(todoId);
    } else {
      // 완료 처리
      newCompletedSet.add(todoId);
    }
    
    await saveToRegistry(REG_KEY_COMPLETED_TODOS, JSON.stringify(Array.from(newCompletedSet)));
    setCompletedTodos(newCompletedSet);
    void emit('calendar-update');
    setContextMenu(null);
    loadTodos();
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
        <button 
          onClick={async () => {
            const newPinnedState = !isPinned;
            try {
              await invoke('set_calendar_widget_pinned', { pinned: newPinnedState });
              onPinnedChange?.(newPinnedState);
            } catch (e) {
              console.error('핀 상태 변경 실패:', e);
            }
          }}
          className="calendar-today-btn calendar-pin-btn"
          style={{ 
            marginLeft: '10px', 
            background: isPinned ? 'rgba(100, 200, 100, 0.3)' : 'rgba(100, 100, 100, 0.3)',
            borderColor: isPinned ? 'rgba(100, 200, 100, 0.6)' : 'rgba(100, 100, 100, 0.6)'
          }}
          title={isPinned ? '고정 해제' : '고정'}
        >
          {isPinned ? '📌' : '📍'}
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
            if (!calendarTitle.trim()) {
              alert('달력 제목을 입력해주세요.');
              return;
            }

            const finalContent = content.trim() || calendarTitle.trim();

            const newId = crypto.randomUUID();
            const deadline = deadlineDate && deadlineTime 
              ? new Date(`${deadlineDate}T${deadlineTime}:00`).toISOString()
              : null;

            const now = new Date().toISOString();
            const newTodo: ManualTodo = {
              id: newId,
              content: finalContent,
              deadline,
              createdAt: now,
              updatedAt: now,
              isDeleted: false,
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
                  ? { ...t, content: content.trim(), deadline, calendarTitle: calendarTitle.trim() || undefined, updatedAt: new Date().toISOString() }
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

            const newId = crypto.randomUUID();
            const now = new Date().toISOString();
            const newSchedule: PeriodSchedule = {
              id: newId,
              content: content.trim(),
              startDate,
              endDate,
              createdAt: now,
              updatedAt: now,
              isDeleted: false,
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
      {contextMenu && (
        <>
          <div 
            className="calendar-context-menu-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <div 
            className="calendar-context-menu"
            style={{
              position: 'fixed',
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
              zIndex: 10000,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.todo && (
              <>
                <div 
                  className="calendar-context-menu-item"
                  onClick={() => {
                    toggleTodoCompletion(contextMenu.todo!);
                  }}
                >
                  {contextMenu.todo.isCompleted ? '완료 취소' : '완료'}
                </div>
                <div 
                  className="calendar-context-menu-item"
                  onClick={() => {
                    if (confirm('이 일정을 삭제하시겠습니까?')) {
                      deleteTodo(contextMenu.todo!);
                    }
                  }}
                >
                  삭제
                </div>
              </>
            )}
            {contextMenu.schedule && (
              <div 
                className="calendar-context-menu-item"
                onClick={() => {
                  if (confirm('이 기간 일정을 삭제하시겠습니까?')) {
                    deletePeriodSchedule(contextMenu.schedule!);
                  }
                }}
              >
                삭제
              </div>
            )}
          </div>
        </>
      )}
      {isDragging && draggedTodoId && (
        createPortal(
          <div 
            ref={ghostRef}
            style={{
              position: 'fixed',
              // 초기 위치는 마우스 이벤트에서 설정됨
              left: '0px',
              top: '0px',
              width: '150px',
              pointerEvents: 'none',
              zIndex: 9999,
              opacity: 0.9,
              transform: 'scale(1.05)',
              boxShadow: '0 5px 15px rgba(0,0,0,0.3)',
              backgroundColor: 'rgba(60, 60, 70, 0.95)',
              color: 'white',
              padding: '6px 10px',
              borderRadius: '6px',
              fontSize: '12px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(5px)'
            }}
          >
            {allTodos.find(t => t.id === draggedTodoId)?.content.replace(/<[^>]*>/g, '') || 'Dragging...'}
          </div>,
          document.body
        )
      )}
    </div>
  );
}

interface EditTodoModalWidgetProps {
  todo: TodoItem;
  manualTodos: ManualTodo[];
  deadlines: Record<string, string | null>;
  calendarTitles: Record<string, string>;
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
              {todo.file_paths && todo.file_paths.length > 0 && (
                <AttachmentList filePaths={todo.file_paths} />
              )}
            </div>
          </div>
          <div className="schedule-panel">
            <h3>마감 시간 설정</h3>
            <label htmlFor="calendar-edit-todo-calendar-title">달력 제목</label>
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
            <label htmlFor="period-calendar-title">달력 제목</label>
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
            <label htmlFor="calendar-add-todo-calendar-title">달력 제목</label>
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
  const [isPinned, setIsPinned] = useState(false);

  // 핀 상태 확인
  useEffect(() => {
    const checkPinnedState = async () => {
      try {
        const pinned = await invoke<boolean>('get_calendar_widget_pinned');
        setIsPinned(pinned);
      } catch (e) {
        console.error('핀 상태 확인 실패:', e);
      }
    };
    checkPinnedState();
  }, []);

  // 윈도우 드래그 가능하게 만들기 (핀 상태에 따라)
  useEffect(() => {
    const handleMouseDown = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // 핀 버튼 자체는 드래그하지 않음
      if (target.closest('.calendar-pin-btn')) {
        return;
      }
      // 핀이 고정된 상태에서만 드래그 가능
      if (isPinned && (target.closest('.calendar-widget-header') || target.closest('.calendar-widget-footer'))) {
        const window = getCurrentWindow();
        await window.startDragging();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isPinned]);

  return <CalendarWidget isPinned={isPinned} onPinnedChange={setIsPinned} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CalendarWidgetApp />
  </React.StrictMode>
);

