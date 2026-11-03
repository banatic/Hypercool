import React, { useState, useRef } from 'react';
import { DropPosition, TodoItem } from './types';

const DRAG_THRESHOLD_PX = 5; // 드래그 시작 임계값 (CSS 픽셀)

interface DropTarget {
  dateKey: string;
  todoId?: string;
  position?: DropPosition;
}

/**
 * 좌표 아래의 달력 칸·할 일. 할 일 위면 중앙선 기준 위/아래까지.
 * 삽입 표시선은 끼어들면서 대상 항목을 밀어내 커서 아래에 표시선만 남기므로,
 * 표시선 위에서는 직전 대상(`last`)을 그대로 유지한다.
 */
function findDropTarget(x: number, y: number, draggedId: string | null, last: DropTarget | null): DropTarget | null {
  const element = document.elementFromPoint(x, y);
  const dayElement = element?.closest('.calendar-day');
  const dateKey = dayElement?.getAttribute('data-date');
  if (!element || !dateKey) return null;

  if (element.closest('.calendar-todo-drop-indicator') && last?.todoId && last.dateKey === dateKey) return last;

  const todoElement = element.closest('.calendar-todo-item');
  const todoId = todoElement?.getAttribute('data-todo-id');
  if (!todoElement || !todoId || todoId === draggedId) return { dateKey };

  const rect = todoElement.getBoundingClientRect();
  return { dateKey, todoId, position: y < rect.top + rect.height / 2 ? 'above' : 'below' };
}

/**
 * 할 일 마우스 드래그. 임계값을 넘기 전 손을 떼면 클릭(onClick)으로 처리한다.
 * 고스트는 리렌더 없이 ghostRef 의 style 을 직접 옮긴다.
 */
export function useTodoDrag({ allTodos, onDrop, onClick }: {
  allTodos: TodoItem[];
  onDrop: (draggedId: string, dateKey: string, targetTodoId?: string, position?: DropPosition) => void;
  onClick: (todo: TodoItem) => void;
}) {
  const [draggedTodoId, setDraggedTodoId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOverDateKey, setDragOverDateKey] = useState<string | null>(null);
  const [dragOverTodoId, setDragOverTodoId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<DropPosition | null>(null);

  const draggedTodoIdRef = useRef<string | null>(null); // 동기적으로 접근하기 위한 ref
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const startPosRef = useRef({ x: 0, y: 0 }); // 드래그 시작 위치 (클릭 판별용)
  const isDraggingRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement>(null);
  const lastTargetRef = useRef<DropTarget | null>(null); // 표시선 위에서 유지할 직전 대상

  const handleGlobalMouseMove = (e: MouseEvent) => {
    if (!draggedTodoIdRef.current) return;

    if (!isDraggingRef.current) {
      // 일정 거리 이상 움직였을 때만 드래그 시작 (클릭 미스 방지)
      const dx = e.clientX - startPosRef.current.x;
      const dy = e.clientY - startPosRef.current.y;
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      isDraggingRef.current = true;
      setIsDragging(true);
      setDraggedTodoId(draggedTodoIdRef.current);
    }

    if (ghostRef.current) {
      ghostRef.current.style.left = `${e.clientX - dragOffsetRef.current.x}px`;
      ghostRef.current.style.top = `${e.clientY - dragOffsetRef.current.y}px`;
    }

    const element = document.elementFromPoint(e.clientX, e.clientY);
    if (!element) return;
    if (!element.closest('.calendar-day')) {
      lastTargetRef.current = null;
      setDragOverDateKey(null);
      setDragOverTodoId(null);
      setDragOverPosition(null);
      return;
    }
    const target = findDropTarget(e.clientX, e.clientY, draggedTodoIdRef.current, lastTargetRef.current);
    if (!target) return;
    lastTargetRef.current = target;
    setDragOverDateKey(target.dateKey);
    setDragOverTodoId(target.todoId ?? null);
    setDragOverPosition(target.position ?? null);
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);

    const draggedId = draggedTodoIdRef.current;
    if (isDraggingRef.current && draggedId) {
      const target = findDropTarget(e.clientX, e.clientY, draggedId, lastTargetRef.current);
      if (target) onDrop(draggedId, target.dateKey, target.todoId, target.position);
    } else if (draggedId) {
      // 드래그가 아니면 클릭. onClick 대신 여기서 처리해 드래그/클릭 간섭을 막는다.
      const todo = allTodos.find(t => t.id === draggedId);
      if (todo) onClick(todo);
    }

    setIsDragging(false);
    isDraggingRef.current = false;
    lastTargetRef.current = null;
    setDraggedTodoId(null);
    draggedTodoIdRef.current = null;
    setDragOverDateKey(null);
    setDragOverTodoId(null);
    setDragOverPosition(null);
  };

  const handleMouseDown = (e: React.MouseEvent, todo: TodoItem) => {
    if (e.button !== 0) return; // 좌클릭만 허용
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    startPosRef.current = { x: e.clientX, y: e.clientY };
    draggedTodoIdRef.current = todo.id;
    isDraggingRef.current = false; // 아직 드래그 시작 안함 (클릭과 구분)

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
  };

  return {
    handleMouseDown,
    ghostRef,
    isDragging,
    draggedTodoId,
    dragOverDateKey,
    dragOverTodoId,
    dragOverPosition,
  };
}
