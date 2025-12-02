import React from 'react';
import { NavLink } from 'react-router-dom';
import { LogOut, Calendar, MessageSquare, CheckCircle, X } from 'lucide-react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import './Sidebar.css';

interface SidebarProps {
  isMobileMenuOpen?: boolean;
  onMobileMenuClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isMobileMenuOpen = false, onMobileMenuClose }) => {
  const handleLogout = async () => {
    try {
      console.log('Logging out...');
      await signOut(auth);
      console.log('Logout successful - AuthGuard will redirect to /login');
      // AuthGuard의 onAuthStateChanged가 자동으로 /login으로 리다이렉트함
    } catch (error) {
      console.error('Logout failed:', error);
      alert('로그아웃에 실패했습니다. 다시 시도해주세요.');
    }
  };

  const handleNavClick = () => {
    if (onMobileMenuClose) {
      onMobileMenuClose();
    }
  };

  return (
    <>
      <aside className={`sidebar ${isMobileMenuOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <h2>HyperCool</h2>
          <button 
            className="mobile-close-btn"
            onClick={onMobileMenuClose}
            aria-label="메뉴 닫기"
          >
            <X size={24} />
          </button>
        </div>
        
        <nav className="sidebar-nav">
          <NavLink 
            to="/calendar" 
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            onClick={handleNavClick}
          >
            <Calendar size={20} />
            <span>달력</span>
          </NavLink>
          <NavLink 
            to="/todos" 
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            onClick={handleNavClick}
          >
            <CheckCircle size={20} />
            <span>할 일</span>
          </NavLink>
          <NavLink 
            to="/messages" 
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            onClick={handleNavClick}
          >
            <MessageSquare size={20} />
            <span>메시지</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <button 
            type="button"
            className="nav-item logout-btn" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleLogout();
            }}
          >
            <LogOut size={20} />
            <span>Logout</span>
          </button>
        </div>
      </aside>
    </>
  );
};
