import { KeyboardEvent } from 'react';
import { ScheduleItem } from '../../types/schedule';

interface Props {
  todos: ScheduleItem[];
  loading: boolean;
  newTodoText: string;
  onNewTodoTextChange: (v: string) => void;
  onAdd: () => void;
  onToggle: (todo: ScheduleItem) => void;
  onDelete: (id: string) => void;
}

export default function TodoTab({ todos, loading, newTodoText, onNewTodoTextChange, onAdd, onToggle, onDelete }: Props) {
  if (loading && todos.length === 0) return <div className="loading">Loading...</div>;

  return (
    <div className="todo-container">
      <div className="todo-input-group">
        <input
          type="text"
          className="todo-input"
          placeholder="새로운 할 일을 입력하세요..."
          value={newTodoText}
          onChange={(e) => onNewTodoTextChange(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') onAdd();
          }}
        />
        <button className="todo-add-btn" onClick={onAdd}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>
      <div className="todo-list">
        {todos.length === 0 ? (
          <div className="todo-empty">할 일이 없습니다.</div>
        ) : (
          todos.map(todo => (
            <div key={todo.id} className={`todo-item ${todo.isCompleted ? 'completed' : ''}`}>
              <button
                className={`todo-checkbox ${todo.isCompleted ? 'checked' : ''}`}
                onClick={() => onToggle(todo)}
              >
                {todo.isCompleted && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                )}
              </button>
              <div className="todo-content" onClick={() => onToggle(todo)}>
                {todo.title}
              </div>
              <button className="todo-delete-btn" onClick={() => onDelete(todo.id)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
