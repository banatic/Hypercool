import React from 'react';
import { Message, ManualTodo } from '../types';
import { PageHeader } from './PageHeader';
import { AttachmentList } from './AttachmentList';

interface TodosPageProps {
  keptMessages: Message[];
  manualTodos: ManualTodo[];
  deadlines: Record<string, string | null>;
  setAddTodoModal: (open: boolean) => void;
  classify: (id: number | string, direction: 'left' | 'right') => void;
  setScheduleModal: (modal: { open: boolean; id?: number | string }) => void;
  decodeEntities: (html: string) => string;
  formatReceiveDate: (receiveDate: string | null | undefined) => string | null;
  saveToRegistry: (key: string, value: string) => Promise<void>;
  setManualTodos: React.Dispatch<React.SetStateAction<ManualTodo[]>>;
  setDeadlines: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;
}

const REG_KEY_MANUAL_TODOS = 'ManualTodos';
const REG_KEY_DEADLINES = 'TodoDeadlineMap';

export const TodosPage: React.FC<TodosPageProps> = ({
  keptMessages,
  manualTodos,
  deadlines,
  setAddTodoModal,
  classify,
  setScheduleModal,
  decodeEntities,
  formatReceiveDate,
  saveToRegistry,
  setManualTodos,
  setDeadlines,
}) => {

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}. ${month}. ${day}.`;
  };

  const getRemainingTimeInfo = (deadline: string | null) => {
    if (!deadline) return { text: '', color: 'var(--text-secondary)' };

    const now = new Date();
    const deadlinedate = new Date(deadline);
    const diff = deadlinedate.getTime() - now.getTime();

    // Overdue
    if (diff < 0) {
      const days = Math.floor(Math.abs(diff) / (1000 * 60 * 60 * 24));
      if (days > 0) {
        return { text: `${days}일 지남`, color: 'var(--danger)' };
      }
      const hours = Math.floor(Math.abs(diff) / (1000 * 60 * 60));
      if (hours > 0) {
        return { text: `${hours}시간 지남`, color: 'var(--danger)' };
      }
      const minutes = Math.floor(Math.abs(diff) / (1000 * 60));
      return { text: `${minutes}분 지남`, color: 'var(--danger)' };
    }

    // Upcoming
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 24) {
      if (hours > 0) {
        return { text: `${hours}시간 남음`, color: 'var(--danger)' };
      }
      const minutes = Math.floor(diff / (1000 * 60));
      return { text: `${minutes}분 남음`, color: 'var(--danger)' };
    }

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days <= 3) {
      return { text: `${days}일 남음`, color: 'var(--danger)' };
    }
    if (days <= 7) {
      return { text: `${days}일 남음`, color: 'var(--warning)' };
    }
    return { text: `${days}일 남음`, color: 'var(--text-secondary)' };
  };

  // 메시지 기반 할 일과 직접 추가한 할 일을 합침
  const allTodos: Array<{ id: number | string; content: string; deadline: string | null; sender?: string; isManual?: boolean; receive_date?: string | null; file_paths?: string[] }> = [
    ...keptMessages.map(m => ({ id: m.id, content: m.content, deadline: deadlines[m.id.toString()] || null, sender: m.sender, isManual: false, receive_date: m.receive_date, file_paths: m.file_paths })),
    ...manualTodos.map(t => ({ id: t.id, content: t.content, deadline: t.deadline, isManual: true }))
  ];

  // 전체 항목을 먼저 정렬 (마감일 시간 순으로 전체 정렬, 수동 추가 항목은 같은 조건에서 뒤로)
  allTodos.sort((a, b) => {
    // 둘 다 마감일이 있으면 마감일 시간 순으로 정렬
    if (a.deadline && b.deadline) {
      const deadlineDiff = new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
      if (deadlineDiff !== 0) return deadlineDiff;
      // 마감일 시간이 같으면 수동 추가 항목을 뒤로
      if (a.isManual !== b.isManual) {
        return a.isManual ? 1 : -1;
      }
      return String(a.id).localeCompare(String(b.id));
    }
    // 마감일이 있는 항목이 먼저
    if (a.deadline && !b.deadline) return -1;
    if (!a.deadline && b.deadline) return 1;
    // 둘 다 마감일이 없으면 수동 추가 항목을 뒤로
    if (a.isManual !== b.isManual) {
      return a.isManual ? 1 : -1;
    }
    return String(a.id).localeCompare(String(b.id));
  });

  const groupedTodos = allTodos.reduce((acc, t) => {
    const date = t.deadline ? formatDate(t.deadline) : '마감 없음';
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(t);
    return acc;
  }, {} as Record<string, typeof allTodos>);

  // 그룹화는 이미 정렬된 순서를 유지하므로 별도 정렬 불필요

  const sortedGroups = Object.entries(groupedTodos).sort((a, b) => {
    const dateA = a[0];
    const dateB = b[0];
    if (dateA === '마감 없음') return 1;
    if (dateB === '마감 없음') return -1;
    return new Date(dateA).getTime() - new Date(dateB).getTime();
  });

  return (
    <div className="timeline page-content">
      <PageHeader title={`타임라인 (${allTodos.length})`}>
        <button onClick={() => setAddTodoModal(true)} className="add-todo-btn">
          할 일 추가
        </button>
      </PageHeader>
      {allTodos.length === 0 ? (
        <p>할 일이 없습니다. 할 일을 추가해보세요.</p>
      ) : (
        <div>
          {sortedGroups.map(([date, todos]) => {
            const firstTodoDeadline = todos.length > 0 ? todos[0].deadline : null;
            const remainingTime = getRemainingTimeInfo(firstTodoDeadline);

            return (
              <div key={date} className="timeline-group">
                <div className="timeline-marker">
                  <div className="timeline-date">{date}</div>
                  {remainingTime.text && (
                    <div className="timeline-remaining" style={{ color: remainingTime.color }}>
                      {remainingTime.text}
                    </div>
                  )}
                </div>
                <div className="timeline-vline"></div>
                <div className="timeline-items">
                  {todos.map((todo) => {
                    const deadline = todo.deadline;
                    const remainingTimeForItem = getRemainingTimeInfo(deadline);
                    
                    let deadlineDisplay = '마감 없음';
                    let deadlineTitle = '';
                    if (deadline) {
                      deadlineDisplay = new Date(deadline).toLocaleString(); // Fallback
                      deadlineTitle = deadlineDisplay;
                      if (remainingTimeForItem.text) {
                        deadlineDisplay = remainingTimeForItem.text;
                      }
                    }

                    const handleDelete = () => {
                      if (todo.isManual) {
                        setManualTodos(prev => {
                          const next = prev.filter(t => t.id !== todo.id);
                          void saveToRegistry(REG_KEY_MANUAL_TODOS, JSON.stringify(next));
                          return next;
                        });
                        // deadlines에서도 제거
                        setDeadlines(prev => {
                          const next = { ...prev };
                          delete next[todo.id.toString()];
                          void saveToRegistry(REG_KEY_DEADLINES, JSON.stringify(next));
                          return next;
                        });
                      } else {
                        classify(todo.id, 'left');
                      }
                    };

                    const handleSetDeadline = () => {
                      setScheduleModal({ open: true, id: todo.id });
                    };

                    return (
                      <div key={todo.id} className="todo-item">
                        <div className="todo-actions">
                          <span className="deadline-label" title={deadlineTitle} style={{ color: remainingTimeForItem.color }}>
                            {deadlineDisplay}
                          </span>
                          <button onClick={handleSetDeadline}>마감 설정</button>
                          <button onClick={handleDelete}>완료</button>
                        </div>
                        {todo.sender && (
                          <div className="todo-sender">
                            {todo.sender}
                            {(todo as any).receive_date && (
                              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '8px' }}>
                                {formatReceiveDate((todo as any).receive_date)}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="todo-content" dangerouslySetInnerHTML={{ __html: decodeEntities(todo.content) }} />
                        {todo.file_paths && todo.file_paths.length > 0 && (
                          <AttachmentList filePaths={todo.file_paths} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
