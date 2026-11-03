import { ManualTodo, PeriodSchedule } from '../types';
import { DropPosition, ParsedDate, TodoItem } from './types';

export const CALENDAR_DAYS = 42; // 6주 × 7일

const pad = (n: number) => n.toString().padStart(2, '0');

/** 달력 칸 키. 월은 0부터(`Date.getMonth()`) — 레지스트리 TodoOrderMap 키와 같은 형식. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** 칸에 표시할 짧은 제목: 달력 제목, 없으면 내용 앞 10자. */
export function shortTitle(item: { calendarTitle?: string; content: string }): string {
  return item.calendarTitle || (item.content.length > 10 ? item.content.substring(0, 10) + '...' : item.content);
}

/** currentDate 가 속한 달을 덮는 6주(42일). 첫 칸은 1일이 속한 주의 일요일. */
export function buildMonthDays(currentDate: Date): Date[] {
  const firstDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const startDate = new Date(firstDay);
  startDate.setDate(startDate.getDate() - firstDay.getDay());

  const days: Date[] = [];
  const current = new Date(startDate);
  while (days.length < CALENDAR_DAYS) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return days;
}

/** 할 일을 마감일 칸별로 묶고, 저장된 순서(todoOrder)를 적용. 순서에 없는 항목은 뒤에 붙인다. */
export function groupTodosByDate(todos: TodoItem[], todoOrder: Record<string, string[]>): Record<string, TodoItem[]> {
  const todosByDate: Record<string, TodoItem[]> = {};
  todos.forEach(todo => {
    if (todo.deadline) {
      const key = dateKey(new Date(todo.deadline));
      (todosByDate[key] ||= []).push(todo);
    }
  });

  Object.keys(todosByDate).forEach(key => {
    const savedOrder = todoOrder[key];
    if (savedOrder && savedOrder.length > 0) {
      const todoMap = new Map(todosByDate[key].map(t => [t.id, t]));
      const orderedTodos: TodoItem[] = [];
      savedOrder.forEach(id => {
        const todo = todoMap.get(id);
        if (todo) {
          orderedTodos.push(todo);
          todoMap.delete(id);
        }
      });
      todoMap.forEach(todo => orderedTodos.push(todo));
      todosByDate[key] = orderedTodos;
    }
  });
  return todosByDate;
}

/** 기간 일정을 걸치는 모든 칸에 넣는다(삭제된 일정 제외). */
export function groupPeriodsByDate(periodSchedules: PeriodSchedule[]): Record<string, PeriodSchedule[]> {
  const byDate: Record<string, PeriodSchedule[]> = {};
  periodSchedules.filter(s => !s.isDeleted).forEach(schedule => {
    const end = new Date(schedule.endDate);
    const current = new Date(schedule.startDate);
    while (current <= end) {
      (byDate[dateKey(current)] ||= []).push(schedule);
      current.setDate(current.getDate() + 1);
    }
  });
  return byDate;
}

/** 기간 일정이 해당 날짜에서 시작/중간/끝인지. */
export function periodPosition(schedule: PeriodSchedule, day: Date): 'start' | 'middle' | 'end' | 'start end' {
  const startOf = (d: string | Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const current = startOf(day);
  const isStart = current === startOf(schedule.startDate);
  const isEnd = current === startOf(schedule.endDate);
  if (isStart && isEnd) return 'start end';
  if (isStart) return 'start';
  if (isEnd) return 'end';
  return 'middle';
}

/** 간단한 날짜 파싱 (상대 날짜·YYYY-MM-DD·HH:MM 만 지원). */
export function parseDateFromText(text: string, baseDate?: Date): ParsedDate {
  const now = baseDate || new Date();

  const relativeDatePatterns = [
    { pattern: /오늘|지금/i, days: 0 },
    { pattern: /내일/i, days: 1 },
    { pattern: /모레/i, days: 2 },
    { pattern: /다음\s*주|다음주/i, days: 7 },
  ];

  let parsedDate: Date | null = null;
  let parsedTime: string | null = null;

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
      parsedDate = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
    }
  }

  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    parsedTime = `${pad(parseInt(timeMatch[1]))}:${pad(parseInt(timeMatch[2]))}`;
  }

  return {
    date: parsedDate ? `${parsedDate.getFullYear()}-${pad(parsedDate.getMonth() + 1)}-${pad(parsedDate.getDate())}` : null,
    time: parsedTime,
  };
}

export interface CalendarDbState {
  manualTodos: ManualTodo[];
  periodSchedules: PeriodSchedule[];
  deadlines: Record<string, string | null>;
  calendarTitles: Record<string, string>;
  referenceIdToScheduleId: Record<string, string>;
  completed: Set<string>;
}

/** get_schedules 결과를 화면 상태로 나눈다. message_task 는 원본 메시지 id(referenceId) 기준. */
export function splitScheduleItems(items: any[]): CalendarDbState {
  const state: CalendarDbState = {
    manualTodos: [],
    periodSchedules: [],
    deadlines: {},
    calendarTitles: {},
    referenceIdToScheduleId: {},
    completed: new Set(),
  };

  for (const item of items) {
    if (item.type === 'manual_todo' || item.type === 'desktopcal_memo') {
      state.manualTodos.push({
        id: item.id,
        content: item.content || '',
        deadline: item.startDate || null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        calendarTitle: item.title,
        color: item.color ?? null,
        isDeleted: item.isDeleted,
      });
    } else if (item.type === 'period_schedule' || item.type === 'desktopcal_event') {
      state.periodSchedules.push({
        id: item.id,
        content: item.content || '',
        startDate: item.startDate!,
        endDate: item.endDate!,
        calendarTitle: item.title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        isDeleted: item.isDeleted,
      });
    } else if (item.type === 'message_task' && item.referenceId) {
      if (!isNaN(Number(item.referenceId))) {
        state.deadlines[item.referenceId] = item.startDate || null;
        state.calendarTitles[item.referenceId] = item.title;
        state.referenceIdToScheduleId[item.referenceId] = item.id;
      } else {
        // 메시지 id 가 아닌 참조(고아/UUID) → 수동 할 일로 취급
        state.manualTodos.push({
          id: item.id,
          content: item.content || '',
          deadline: item.startDate || null,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          calendarTitle: item.title,
          isDeleted: item.isDeleted,
        });
      }
    }
  }

  items.forEach(item => {
    if (item.isCompleted) {
      state.completed.add(item.id); // 수동·기간 일정
      if (item.referenceId) state.completed.add(item.referenceId); // 메시지 할 일
    }
  });

  return state;
}

/**
 * 할 일/기간 일정을 DB ScheduleItem 으로 만든다. `updates` 가 마지막에 덮어쓴다.
 * 아직 DB 에 없는 메시지 할 일(referenceId 매핑 없음)은 새 id 로 create 대상이 된다.
 */
export function buildScheduleItem(
  item: TodoItem | PeriodSchedule,
  updates: Partial<any>,
  referenceIdToScheduleId: Record<string, string>,
): { scheduleItem: any; targetId: string; shouldCreate: boolean } {
  const isManual = 'isManual' in item ? item.isManual : false;
  const type = 'startDate' in item ? 'period_schedule' : (isManual ? 'manual_todo' : 'message_task');

  let targetId = item.id;
  let shouldCreate = false;
  if (type === 'message_task') {
    const mappedId = referenceIdToScheduleId[item.id];
    if (mappedId) {
      targetId = mappedId;
    } else {
      shouldCreate = true;
      targetId = crypto.randomUUID();
    }
  }

  const scheduleItem = {
    id: targetId,
    type: type,
    title: item.calendarTitle || ('content' in item ? item.content : ''),
    content: 'content' in item ? item.content : null,
    startDate: updates.deadline || ('startDate' in item ? item.startDate : ('deadline' in item ? item.deadline : null)),
    endDate: updates.deadline || ('endDate' in item ? item.endDate : ('deadline' in item ? item.deadline : null)),
    isAllDay: type === 'period_schedule',
    referenceId: type === 'message_task' ? item.id : ('referenceId' in item ? (item as any).referenceId : null),
    color: null,
    isCompleted: 'isCompleted' in item ? item.isCompleted : false,
    createdAt: 'createdAt' in item ? item.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isDeleted: 'isDeleted' in item ? item.isDeleted : false,
    ...updates,
  };
  return { scheduleItem, targetId, shouldCreate };
}

/** 드롭 후 대상 칸의 미완료 할 일 순서. 드래그한 항목을 target 위/아래(없으면 끝)에 넣는다. */
export function reorderForDrop(params: {
  allTodos: TodoItem[];
  draggedId: string;
  sourceDateKey: string;
  targetDateKey: string;
  currentOrder: string[];
  targetTodoId?: string;
  position?: DropPosition;
}): string[] {
  const { allTodos, draggedId, sourceDateKey, targetDateKey, currentOrder, targetTodoId, position } = params;

  const dayTodos = allTodos.filter(todo => {
    // 방금 옮긴 항목은 새 칸 기준으로 본다(근사 판정)
    const deadline = todo.id === draggedId
      ? (sourceDateKey !== targetDateKey ? new Date(targetDateKey).toISOString() : todo.deadline)
      : todo.deadline;
    if (!deadline) return false;
    return dateKey(new Date(deadline)) === targetDateKey;
  });

  const incompleteIds = new Set(dayTodos.filter(t => !t.isCompleted).map(t => t.id));
  let newOrder = currentOrder.filter(id => incompleteIds.has(id));
  incompleteIds.forEach(id => {
    if (!newOrder.includes(id)) newOrder.push(id);
  });
  newOrder = newOrder.filter(id => id !== draggedId);

  const targetIndex = targetTodoId !== undefined ? newOrder.indexOf(targetTodoId) : -1;
  if (targetIndex === -1) {
    newOrder.push(draggedId);
  } else if (position === 'below') {
    newOrder.splice(targetIndex + 1, 0, draggedId);
  } else {
    newOrder.splice(targetIndex, 0, draggedId);
  }
  return newOrder;
}
