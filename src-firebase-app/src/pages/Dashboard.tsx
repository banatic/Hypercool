import React from 'react';
import { Card } from '../components/ui/Card';
import { Calendar, MessageSquare, DollarSign } from 'lucide-react';
import { useCalendarData } from '../hooks/useCalendarData';
import { useMessages } from '../hooks/useMessages';
import { CalendarView } from '../components/CalendarView';
import { MessageList } from '../components/MessageList';
import './Dashboard.css';

export const Dashboard: React.FC = () => {
  const { todos, schedules, loading: calendarLoading } = useCalendarData();
  const { messages, loading: messagesLoading } = useMessages();

  const stats = [
    { title: 'Total Todos', value: todos.length.toString(), icon: Calendar, change: '' },
    { title: 'Schedules', value: schedules.length.toString(), icon: Calendar, change: '' },
    { title: 'Messages', value: messages.length.toString(), icon: MessageSquare, change: '' },
    { title: 'Revenue', value: '$12,345', icon: DollarSign, change: '+23%' },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Dashboard</h1>
        <p>Overview of your application status.</p>
      </div>

      <div className="stats-grid">
        {stats.map((stat, index) => (
          <Card key={index} className="stat-card">
            <div className="stat-icon">
              <stat.icon size={24} />
            </div>
            <div className="stat-info">
              <p className="stat-title">{stat.title}</p>
              <h3 className="stat-value">{stat.value}</h3>
              <span className="stat-change">{stat.change}</span>
            </div>
          </Card>
        ))}
      </div>

      <div className="dashboard-content">
        <Card title="Recent Calendar Activity" className="activity-card">
          <CalendarView 
            todos={todos.slice(0, 5)} 
            schedules={schedules.slice(0, 5)} 
            loading={calendarLoading} 
          />
        </Card>
        <Card title="Recent Messages" className="events-card">
          <MessageList 
            messages={messages.slice(0, 5)} 
            loading={messagesLoading} 
          />
        </Card>
      </div>
    </div>
  );
};
