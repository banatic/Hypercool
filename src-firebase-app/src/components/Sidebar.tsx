import React from 'react';
import { NavLink } from 'react-router-dom';
import { LogOut, Calendar, MessageSquare, CheckCircle } from 'lucide-react';
import './Sidebar.css';

export const Sidebar: React.FC = () => {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>HyperCool</h2>
      </div>
      
      <nav className="sidebar-nav">
        <NavLink 
          to="/calendar" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <Calendar size={20} />
          <span>달력</span>
        </NavLink>
        <NavLink 
          to="/todos" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <CheckCircle size={20} />
          <span>할 일</span>
        </NavLink>
        <NavLink 
          to="/messages" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <MessageSquare size={20} />
          <span>메시지</span>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <button className="nav-item logout-btn">
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
};
