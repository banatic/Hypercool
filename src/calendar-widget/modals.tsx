import React, { useState } from 'react';
import { AttachmentList } from '../components/AttachmentList';
import { ManualTodo, PeriodSchedule } from '../types';
import { decodeEntities } from '../utils/dateUtils';
import { ParseDateFn, TodoItem } from './types';

interface EditTodoModalWidgetProps {
  todo: TodoItem;
  manualTodos: ManualTodo[];
  deadlines: Record<string, string | null>;
  calendarTitles: Record<string, string>;
  onClose: () => void;
  onSave: (content: string, calendarTitle: string, deadlineDate: string, deadlineTime: string) => Promise<void>;
  parseDateFromText: ParseDateFn;
}

export const EditTodoModalWidget: React.FC<EditTodoModalWidgetProps> = ({ todo, manualTodos, deadlines, calendarTitles, onClose, onSave, parseDateFromText }) => {
  const pad = (n: number) => n.toString().padStart(2, '0');

  // 날짜 포맷팅 함수
  const formatReceiveDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      const year = date.getFullYear();
      const month = pad(date.getMonth() + 1);
      const day = pad(date.getDate());
      const hours = pad(date.getHours());
      const minutes = pad(date.getMinutes());

      if (diffDays === 0) {
        return `오늘 ${hours}:${minutes}`;
      } else if (diffDays === 1) {
        return `어제 ${hours}:${minutes}`;
      } else if (diffDays < 7) {
        return `${diffDays}일 전 ${hours}:${minutes}`;
      } else {
        return `${year}.${month}.${day} ${hours}:${minutes}`;
      }
    } catch {
      return dateStr;
    }
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
              {(todo.sender || todo.receiveDate) && (
                <div style={{
                  marginBottom: '16px',
                  padding: '10px 14px',
                  backgroundColor: '#f5f5f5',
                  border: '1px solid #e0e0e0',
                  borderRadius: '8px',
                  fontSize: '13px',
                  color: '#666666',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }}>
                  {todo.sender && (
                    <span style={{ fontWeight: 500, color: '#333333' }}>{todo.sender}</span>
                  )}
                  {todo.receiveDate && (
                    <>
                      {todo.sender && (
                        <span style={{ color: '#cccccc' }}>•</span>
                      )}
                      <span>{formatReceiveDate(todo.receiveDate)}</span>
                    </>
                  )}
                </div>
              )}
              {todo.isManual && !/<[a-z!/][^>]*>/i.test(content) ? (
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: '4px' }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
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
  parseDateFromText: ParseDateFn;
}

interface AddPeriodModalWidgetProps {
  onClose: () => void;
  onSave: (content: string, calendarTitle: string, startDate: string, endDate: string) => Promise<void>;
}

export const AddPeriodModalWidget: React.FC<AddPeriodModalWidgetProps> = ({ onClose, onSave }) => {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const defaultStartDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const defaultEndDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const [content, setContent] = useState<string>('');
  const [calendarTitle, setCalendarTitle] = useState<string>('');
  const [startDate, setStartDate] = useState<string>(defaultStartDate);
  const [endDate, setEndDate] = useState<string>(defaultEndDate);

  const handleSave = async () => {
    // 초기화하지 않는다: 저장 성공 시 부모가 모달을 닫아 컴포넌트가 언마운트되고,
    // 다음에 열 때 useState 기본값으로 새로 마운트된다. 검증 실패로 저장이 안 된
    // 경우에도 여기서 초기화하면 사용자가 입력한 내용이 그대로 날아간다.
    await onSave(content, calendarTitle, startDate, endDate);
  };

  const handleClose = () => {
    // 닫을 때 상태 초기화
    setContent('');
    setCalendarTitle('');
    setStartDate(defaultStartDate);
    setEndDate(defaultEndDate);
    onClose();
  };

  return (
    <div className="schedule-modal-overlay" onClick={handleClose}>
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
              <button onClick={handleClose}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface EditPeriodModalWidgetProps {
  schedule: PeriodSchedule;
  onClose: () => void;
  onSave: (content: string, calendarTitle: string, startDate: string, endDate: string) => Promise<void>;
}

export const EditPeriodModalWidget: React.FC<EditPeriodModalWidgetProps> = ({ schedule, onClose, onSave }) => {
  // 기존 값 로드
  const [content, setContent] = useState<string>(schedule.content);
  const [calendarTitle, setCalendarTitle] = useState<string>(schedule.calendarTitle || '');
  const [startDate, setStartDate] = useState<string>(schedule.startDate);
  const [endDate, setEndDate] = useState<string>(schedule.endDate);

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
            <label htmlFor="edit-period-calendar-title">달력 제목</label>
            <input
              id="edit-period-calendar-title"
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
            <label htmlFor="edit-period-start-date">시작일</label>
            <input
              id="edit-period-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <label htmlFor="edit-period-end-date">종료일</label>
            <input
              id="edit-period-end-date"
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

export const AddTodoModalWidget: React.FC<AddTodoModalWidgetProps> = ({ selectedDate, onClose, onSave, parseDateFromText }) => {
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
    // 초기화하지 않는다: 저장 성공 시 부모가 모달을 닫아 언마운트되고, 다음에
    // 열 때 새로 마운트된다. 검증 실패 시 초기화하면 입력 내용이 날아간다.
    await onSave(content, calendarTitle, deadlineDate, deadlineTime);
  };

  const handleClose = () => {
    // 닫을 때 상태 초기화
    setContent('');
    setCalendarTitle('');
    setDeadlineDate(defaultDate);
    setDeadlineTime(defaultTime);
    setParsedDateInfo({ date: null, time: null });
    onClose();
  };

  return (
    <div className="schedule-modal-overlay" onClick={handleClose}>
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: '4px' }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  날짜가 자동으로 감지되었습니다: {parsedDateInfo.date} {parsedDateInfo.time ? `(${parsedDateInfo.time})` : ''}
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
              <button onClick={handleClose}>취소</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
