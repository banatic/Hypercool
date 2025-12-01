import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, LogOut, Calendar, MessageSquare } from 'lucide-react';
import './Sidebar.css';

export const Sidebar: React.FC = () => {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>HyperCool</h2>
      </div>
      
      <nav className="sidebar-nav">
        <NavLink 
          to="/dashboard" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <LayoutDashboard size={20} />
          <span>Dashboard</span>
        </NavLink>
        <NavLink 
          to="/calendar" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <Calendar size={20} />
          <span>Calendar</span>
        </NavLink>
        <NavLink 
          to="/messages" 
          className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
        >
          <MessageSquare size={20} />
          <span>Messages</span>
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
