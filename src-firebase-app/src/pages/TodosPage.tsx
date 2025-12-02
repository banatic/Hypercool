import React from 'react';
import { Card } from '../components/ui/Card';
import { useCalendarData } from '../hooks/useCalendarData';
import { Circle, Calendar as CalendarIcon } from 'lucide-react';
import './TodosPage.css';
import './Page.css';

export const TodosPage: React.FC = () => {
  const { todos, loading } = useCalendarData();

  // Sort todos by deadline
  const sortedTodos = [...todos].sort((a, b) => {
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return a.deadline.localeCompare(b.deadline);
  });

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>할 일</h1>
        <p>할 일 목록을 확인하세요.</p>
      </div>
      
      <div className="todos-container">
        <Card>
          {loading ? (
            <div className="loading-state">할 일을 불러오는 중...</div>
          ) : sortedTodos.length === 0 ? (
            <div className="empty-state">
              <p>할 일이 없습니다.</p>
            </div>
          ) : (
            <div className="todos-list">
              {sortedTodos.map((todo) => (
                <div key={todo.id} className="todo-item">
                  <div className="todo-item-icon">
                    <Circle size={20} />
                  </div>
                  <div className="todo-item-content">
                    <p className="todo-item-title">
                      {todo.content}
                    </p>
                    {todo.deadline && (
                      <div className="todo-item-deadline">
                        <CalendarIcon size={14} className="todo-item-deadline-icon" />
                        {todo.deadline}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};
