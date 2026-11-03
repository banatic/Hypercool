import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { ManualTodo, PeriodSchedule } from '../types';
import { DropPosition, TodoItem } from './types';
import { buildScheduleItem, dateKey, reorderForDrop, splitScheduleItems } from './utils';

const REG_KEY_TODO_ORDER = 'TodoOrderMap';

const toDeadline = (date: string, time: string) =>
  date && time ? new Date(`${date}T${time}:00`).toISOString() : null;

/** 달력 위젯의 일정 데이터(DB·레지스트리·쿨메신저 메시지)와 변경 동작. */
export function useCalendarData() {
  const [manualTodos, setManualTodos] = useState<ManualTodo[]>([]);
  const [deadlines, setDeadlines] = useState<Record<string, string | null>>({});
  const [calendarTitles, setCalendarTitles] = useState<Record<string, string>>({});
  const [periodSchedules, setPeriodSchedules] = useState<PeriodSchedule[]>([]);
  const [completedTodos, setCompletedTodos] = useState<Set<string>>(new Set());
  const [keptMessages, setKeptMessages] = useState<any[]>([]);
  const [todoOrder, setTodoOrder] = useState<Record<string, string[]>>({}); // 날짜별 할일 ID 순서
  const [referenceIdToScheduleId, setReferenceIdToScheduleId] = useState<Record<string, string>>({});

  const allTodos = useMemo<TodoItem[]>(() => {
    return [
      ...keptMessages.map(m => {
        const id = m.id.toString();
        return {
          id,
          content: m.content,
          deadline: deadlines[id] || null,
          sender: m.sender,
          receiveDate: m.receive_date || null,
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
        color: t.color ?? null,
        isDeleted: t.isDeleted
      }))
    ].filter(t => !t.isDeleted);
  }, [keptMessages, manualTodos, deadlines, calendarTitles, completedTodos]);

  const lastLoadTimeRef = useRef(0);

  const loadTodos = useCallback(async () => {
    const now = Date.now();
    if (now - lastLoadTimeRef.current < 1000) {
      return; // 1초 throttle
    }
    lastLoadTimeRef.current = now;

    try {
      const items = await invoke<any[]>('get_schedules', {
        start: new Date('2000-01-01').toISOString(),
        end: new Date('2100-12-31').toISOString()
      });

      const db = splitScheduleItems(items);
      setManualTodos(db.manualTodos);
      setPeriodSchedules(db.periodSchedules);
      setDeadlines(db.deadlines);
      setCalendarTitles(db.calendarTitles);
      setReferenceIdToScheduleId(db.referenceIdToScheduleId);
      setCompletedTodos(db.completed);

      // 칸 안 순서는 UI 설정이라 레지스트리에 둔다
      const savedTodoOrder = await invoke<string | null>('get_registry_value', { key: REG_KEY_TODO_ORDER });
      if (savedTodoOrder) {
        try {
          setTodoOrder(JSON.parse(savedTodoOrder) || {});
        } catch {
          console.error('Failed to parse TodoOrderMap from registry');
        }
      }

      // 분류기에서 "오른쪽(보관)"으로 넘긴 메시지
      const savedClassified = await invoke<string | null>('get_registry_value', { key: 'ClassifiedMap' });
      const classified: Record<number, 'left' | 'right'> = savedClassified ? JSON.parse(savedClassified) : {};

      const savedUdbPath = await invoke<string | null>('get_registry_value', { key: 'UdbPath' });
      if (savedUdbPath) {
        try {
          const result = await invoke<{ messages: any[]; total_count: number }>('read_udb_messages', {
            dbPath: savedUdbPath,
            limit: 1000,
            offset: 0,
            searchTerm: null,
          });
          const rightIds = new Set(Object.keys(classified).filter(k => classified[Number(k)] === 'right').map(Number));
          setKeptMessages(result.messages.filter(m => rightIds.has(m.id)));
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
    const unlistenPromise = listen('calendar-update', () => {
      loadTodos();
    });
    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [loadTodos]);

  /** 다른 창에 알리고 DB 에서 다시 읽는다. */
  const notifyChanged = () => {
    void emit('calendar-update');
    loadTodos();
  };

  const updateScheduleInDb = async (item: TodoItem | PeriodSchedule, updates: Partial<any>) => {
    try {
      const { scheduleItem, targetId, shouldCreate } = buildScheduleItem(item, updates, referenceIdToScheduleId);
      if (shouldCreate) {
        await invoke('create_schedule', { item: scheduleItem });
      } else {
        await invoke('update_schedule', { id: targetId, item: scheduleItem });
      }
    } catch (e) {
      console.error("Failed to update schedule in DB", e);
    }
  };

  /** 드래그 드롭: 다른 날짜면 마감일을 옮기고(시각 유지), 대상 칸 순서를 저장. */
  const moveTodo = async (draggedId: string, targetDateKey: string, targetTodoId?: string, position?: DropPosition) => {
    const draggedTodo = allTodos.find(t => t.id === draggedId);
    if (!draggedTodo || !draggedTodo.deadline) return;
    const sourceDateKey = dateKey(new Date(draggedTodo.deadline));

    if (sourceDateKey !== targetDateKey) {
      const [y, m, d] = targetDateKey.split('-').map(n => parseInt(n));
      const newDate = new Date(y, m, d);
      const oldDate = new Date(draggedTodo.deadline);
      newDate.setHours(oldDate.getHours(), oldDate.getMinutes(), oldDate.getSeconds());
      const newDeadline = newDate.toISOString();

      await updateScheduleInDb(draggedTodo, {
        startDate: newDeadline,
        endDate: newDeadline,
        deadline: newDeadline
      });

      if (draggedTodo.isManual) {
        setManualTodos(prev => prev.map(t => t.id === draggedId ? { ...t, deadline: newDeadline } : t));
      }
      setDeadlines(prev => ({ ...prev, [draggedId]: newDeadline }));
    }

    const newTodoOrderMap = { ...todoOrder };
    if (sourceDateKey !== targetDateKey && newTodoOrderMap[sourceDateKey]) {
      newTodoOrderMap[sourceDateKey] = newTodoOrderMap[sourceDateKey].filter(id => id !== draggedId);
    }
    newTodoOrderMap[targetDateKey] = reorderForDrop({
      allTodos,
      draggedId,
      sourceDateKey,
      targetDateKey,
      currentOrder: newTodoOrderMap[targetDateKey] || [],
      targetTodoId,
      position,
    });

    setTodoOrder(newTodoOrderMap);
    await invoke('set_registry_value', { key: REG_KEY_TODO_ORDER, value: JSON.stringify(newTodoOrderMap) });
    notifyChanged();
  };

  /** 삭제 성공하면 true. */
  const deleteTodo = async (todo: TodoItem): Promise<boolean> => {
    try {
      const scheduleId = referenceIdToScheduleId[todo.id] ?? todo.id;
      await invoke('delete_schedule', { id: scheduleId });

      if (todo.isManual) {
        setManualTodos(prev => prev.filter(t => t.id !== todo.id));
      }
      setDeadlines(prev => {
        const next = { ...prev };
        delete next[todo.id];
        return next;
      });
      setCalendarTitles(prev => {
        const next = { ...prev };
        delete next[todo.id];
        return next;
      });
      notifyChanged();
      return true;
    } catch (e) {
      console.error("Failed to delete todo", e);
      return false;
    }
  };

  const deletePeriodSchedule = async (schedule: PeriodSchedule): Promise<boolean> => {
    try {
      await invoke('delete_schedule', { id: schedule.id });
      setPeriodSchedules(prev => prev.filter(s => s.id !== schedule.id));
      notifyChanged();
      return true;
    } catch (e) {
      console.error("Failed to delete schedule", e);
      return false;
    }
  };

  const toggleTodoCompletion = async (todo: TodoItem) => {
    const newIsCompleted = !completedTodos.has(todo.id);
    await updateScheduleInDb(todo, { isCompleted: newIsCompleted });

    const next = new Set(completedTodos);
    if (newIsCompleted) next.add(todo.id);
    else next.delete(todo.id);
    setCompletedTodos(next);
    notifyChanged();
  };

  /** 할 일 추가. 달력 제목·내용 중 하나만 있어도 등록. 성공하면 true. */
  const addTodo = async (content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string): Promise<boolean> => {
    const finalTitle = calendarTitle.trim() || content.trim();
    const finalContent = content.trim() || finalTitle;
    if (!finalTitle) return false;

    const newId = crypto.randomUUID();
    const deadline = toDeadline(deadlineDate, deadlineTime);
    const now = new Date().toISOString();

    try {
      await invoke('create_schedule', {
        item: {
          id: newId,
          type: 'manual_todo',
          title: finalTitle,
          content: finalContent,
          startDate: deadline,
          endDate: deadline,
          isAllDay: false,
          referenceId: null,
          color: null,
          isCompleted: false,
          createdAt: now,
          updatedAt: now,
          isDeleted: false
        }
      });

      setManualTodos(prev => [...prev, {
        id: newId,
        content: finalContent,
        deadline,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
        calendarTitle: finalTitle,
      }]);
      if (deadline) {
        setDeadlines(prev => ({ ...prev, [newId]: deadline }));
      }
      setCalendarTitles(prev => ({ ...prev, [newId]: finalTitle }));
      notifyChanged();
      return true;
    } catch (e) {
      console.error("Failed to create todo", e);
      return false;
    }
  };

  const editTodo = async (todo: TodoItem, content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string) => {
    const todoId = todo.id;
    const deadline = toDeadline(deadlineDate, deadlineTime);
    const title = calendarTitle.trim();

    await updateScheduleInDb(todo, {
      content: todo.isManual ? content.trim() : undefined, // 메시지 할 일은 원문 유지
      title,
      startDate: deadline,
      endDate: deadline,
      deadline: deadline,
      calendarTitle: title
    });

    if (todo.isManual) {
      setManualTodos(prev => prev.map(t =>
        t.id === todoId
          ? { ...t, content: content.trim(), deadline, calendarTitle: title || undefined, updatedAt: new Date().toISOString() }
          : t
      ));
    }
    if (deadline) {
      setDeadlines(prev => ({ ...prev, [todoId]: deadline }));
    } else {
      setDeadlines(prev => { const n = { ...prev }; delete n[todoId]; return n; });
    }
    if (title) {
      setCalendarTitles(prev => ({ ...prev, [todoId]: title }));
    } else {
      setCalendarTitles(prev => { const n = { ...prev }; delete n[todoId]; return n; });
    }
    notifyChanged();
  };

  /** 기간 일정 추가. 달력 제목·내용 중 하나만 있어도 등록. 성공하면 true. */
  const addPeriod = async (content: string, calendarTitle: string, startDate: string, endDate: string): Promise<boolean> => {
    const finalTitle = calendarTitle.trim() || content.trim();
    const finalContent = content.trim() || finalTitle;
    if (!finalTitle || !startDate || !endDate) return false;
    if (new Date(startDate) > new Date(endDate)) return false;

    const newId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await invoke('create_schedule', {
        item: {
          id: newId,
          type: 'period_schedule',
          title: finalTitle,
          content: finalContent,
          startDate: startDate,
          endDate: endDate,
          isAllDay: true,
          referenceId: null,
          color: null,
          isCompleted: false,
          createdAt: now,
          updatedAt: now,
          isDeleted: false
        }
      });

      setPeriodSchedules(prev => [...prev, {
        id: newId,
        content: finalContent,
        startDate,
        endDate,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
        calendarTitle: calendarTitle.trim() || finalTitle,
      }]);
      notifyChanged();
      return true;
    } catch (e) {
      console.error("Failed to create period schedule", e);
      return false;
    }
  };

  /** 기간 일정 수정. 검증에 걸리면 false(모달 유지). */
  const editPeriod = async (schedule: PeriodSchedule, content: string, calendarTitle: string, startDate: string, endDate: string): Promise<boolean> => {
    if (!content.trim() || !startDate || !endDate) return false;
    if (new Date(startDate) > new Date(endDate)) return false;

    await updateScheduleInDb(schedule, {
      content: content.trim(),
      title: calendarTitle.trim(),
      startDate: startDate,
      endDate: endDate,
      calendarTitle: calendarTitle.trim()
    });

    setPeriodSchedules(prev => prev.map(s =>
      s.id === schedule.id
        ? {
          ...s,
          content: content.trim(),
          calendarTitle: calendarTitle.trim() || undefined,
          startDate,
          endDate,
          updatedAt: new Date().toISOString()
        }
        : s
    ));
    notifyChanged();
    return true;
  };

  return {
    allTodos,
    manualTodos,
    deadlines,
    calendarTitles,
    periodSchedules,
    todoOrder,
    moveTodo,
    deleteTodo,
    deletePeriodSchedule,
    toggleTodoCompletion,
    addTodo,
    editTodo,
    addPeriod,
    editPeriod,
  };
}
