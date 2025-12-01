import React from 'react';
import type { ManualTodo, PeriodSchedule } from '../types';
import './CalendarView.css';

interface CalendarViewProps {
  todos: ManualTodo[];
  schedules: PeriodSchedule[];
  loading: boolean;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ todos, schedules, loading }) => {
  if (loading) {
    return <div className="loading-state">Loading calendar data...</div>;
  }

  return (
    <div className="calendar-view">
      <div className="calendar-section">
        <h3>Upcoming Schedules</h3>
        {schedules.length === 0 ? (
          <p className="empty-state">No upcoming schedules.</p>
        ) : (
          <ul className="data-list">
            {schedules.map(schedule => (
              <li key={schedule.id} className="data-item schedule-item">
                <div className="item-content">
                  <span className="item-title">{schedule.calendarTitle || schedule.content}</span>
                  <span className="item-date">{schedule.startDate} ~ {schedule.endDate}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="calendar-section">
        <h3>To-Do List</h3>
        {todos.length === 0 ? (
          <p className="empty-state">No todos found.</p>
        ) : (
          <ul className="data-list">
            {todos.map(todo => (
              <li key={todo.id} className="data-item todo-item">
                <div className="item-content">
                  <span className="item-title">{todo.content}</span>
                  {todo.deadline && <span className="item-date">Due: {todo.deadline}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
