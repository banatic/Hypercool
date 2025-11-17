import React, { useState } from 'react';
import { ManualTodo } from '../types';

interface AddTodoModalProps {
  addTodoModal: boolean;
  setAddTodoModal: (open: boolean) => void;
  setManualTodos: React.Dispatch<React.SetStateAction<ManualTodo[]>>;
  setDeadlines: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  saveToRegistry: (key: string, value: string) => Promise<void>;
  parseDateFromText: (text: string, baseDate?: Date) => { date: string | null; time: string | null };
}

const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';

export const AddTodoModal: React.FC<AddTodoModalProps> = ({
  addTodoModal,
  setAddTodoModal,
  setManualTodos,
  setDeadlines,
  saveToRegistry,
  parseDateFromText,
}) => {
  if (!addTodoModal) return null;

  const [content, setContent] = useState<string>('');
  const [deadlineDate, setDeadlineDate] = useState<string>('');
  const [deadlineTime, setDeadlineTime] = useState<string>('');
  const [parsedDateInfo, setParsedDateInfo] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });

  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const defaultDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // 텍스트 변경 시 날짜 자동 파싱
  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    
    // 날짜 파싱 시도
    const parsed = parseDateFromText(newContent);
    setParsedDateInfo(parsed);
    
    // 파싱된 날짜가 있으면 자동으로 설정 (사용자가 수동으로 변경하지 않은 경우에만)
    if (parsed.date && !deadlineDate) {
      setDeadlineDate(parsed.date);
    }
    if (parsed.time && !deadlineTime) {
      setDeadlineTime(parsed.time);
    }
  };

  const onSave = () => {
    if (!content.trim()) {
      alert('할 일 내용을 입력해주세요.');
      return;
    }

    const newId = Date.now(); // 타임스탬프 기반 ID 생성 (메시지 ID와 충돌 방지)
    const deadline = deadlineDate && deadlineTime 
      ? new Date(`${deadlineDate}T${deadlineTime}:00`).toISOString()
      : null;

    const newTodo: ManualTodo = {
      id: newId,
      content: content.trim(),
      deadline,
      createdAt: new Date().toISOString(),
    };

    setManualTodos(prev => {
      const next = [...prev, newTodo];
      void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
      return next;
    });

    // deadline이 있으면 deadlines에도 저장
    if (deadline) {
      setDeadlines(prev => {
        const next = { ...prev, [newId]: deadline };
        void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
        return next;
      });
    }

    setContent('');
    setDeadlineDate('');
    setDeadlineTime('');
    setParsedDateInfo({ date: null, time: null });
    setAddTodoModal(false);
  };

  return (
    <div className="schedule-modal-overlay" onClick={() => setAddTodoModal(false)}>
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
            <label htmlFor="add-todo-deadline-date">날짜</label>
            <input 
              id="add-todo-deadline-date" 
              type="date" 
              value={deadlineDate || defaultDate}
              onChange={(e) => setDeadlineDate(e.target.value)} 
            />
            <label htmlFor="add-todo-deadline-time">시간</label>
            <input 
              id="add-todo-deadline-time" 
              type="time" 
              value={deadlineTime || defaultTime}
              onChange={(e) => setDeadlineTime(e.target.value)} 
            />
            <div className="row">
              <button onClick={onSave}>저장</button>
              <button onClick={() => {
                setContent('');
                setDeadlineDate('');
                setDeadlineTime('');
                setParsedDateInfo({ date: null, time: null });
                setAddTodoModal(false);
              }}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
