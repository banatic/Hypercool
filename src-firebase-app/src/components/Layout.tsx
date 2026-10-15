import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Sun, CalendarDays, MessageSquare, LogOut } from 'lucide-react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { useData } from '../context/DataStore';
import './Layout.css';

const NAV = [
  { to: '/today', label: '오늘', Icon: Sun },
  { to: '/calendar', label: '달력', Icon: CalendarDays },
  { to: '/messages', label: '메시지', Icon: MessageSquare },
];

export const Layout: React.FC = () => {
  const { user } = useData();

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout failed:', error);
      alert('로그아웃하지 못했습니다. 다시 시도해 주세요.');
    }
  };

  const initial = (user?.displayName || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="layout">
      <aside className="rail" aria-label="주 메뉴">
        <div className="rail-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">HyperCool</span>
        </div>

        <nav className="rail-nav">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
              <Icon size={20} strokeWidth={1.9} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="rail-user">
          {user?.photoURL ? (
            <img className="avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span className="avatar avatar-fallback" aria-hidden="true">{initial}</span>
          )}
          <div className="rail-user-text">
            <div className="rail-user-name">{user?.displayName || '사용자'}</div>
            <div className="rail-user-email">{user?.email}</div>
          </div>
          <button type="button" className="rail-logout" onClick={handleLogout} aria-label="로그아웃" title="로그아웃">
            <LogOut size={18} strokeWidth={1.9} />
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="주 메뉴">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
            <Icon size={22} strokeWidth={1.9} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
};

/** 페이지 공통 머리글: 제목 + 설명, 오른쪽에 도구를 둘 수 있다. */
export const PageHeader: React.FC<{ title: string; description?: string; children?: React.ReactNode }> = ({ title, description, children }) => (
  <header className="page-head">
    <div>
      <h1 className="page-title">{title}</h1>
      {description && <p className="page-desc">{description}</p>}
    </div>
    {children && <div className="page-tools">{children}</div>}
  </header>
);
