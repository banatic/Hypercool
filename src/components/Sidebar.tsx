import React, { useState } from 'react';
import { ClassifyIcon, HistoryIcon, SettingsIcon, CollapseIcon, CalendarIcon, SchoolIcon } from './icons';
import { Page } from '../types';
import { invoke } from '@tauri-apps/api/core';

interface SidebarProps {
  page: Page;
  setPage: (page: Page) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ page, setPage, sidebarCollapsed, setSidebarCollapsed }) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <aside 
      className={`sidebar ${sidebarCollapsed && !isHovered ? 'collapsed' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="sidebar-top">
        <h1><span className='icon'></span><span className="label">HyperCool</span></h1>
        <button className="collapse" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? '펼치기' : '접기'}>
          <CollapseIcon collapsed={sidebarCollapsed} />
        </button>
      </div>
      <nav>
        <button className={page === 'classify' ? 'active' : ''} onClick={() => setPage('classify')}>
          <span className="icon"><ClassifyIcon /></span><span className="label">메시지 분류</span>
        </button>

        <button className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>
          <span className="icon"><HistoryIcon /></span><span className="label">전체 메시지</span>
        </button>
      </nav>
      <nav className="sidebar-bottom-nav">
        <button 
          onClick={async () => {
            try {
              await invoke('open_calendar_widget');
            } catch (e) {
              console.error('달력 위젯 열기 실패:', e);
            }
          }}
          title="달력 위젯 열기"
        >
          <span className="icon"><CalendarIcon /></span><span className="label">달력 위젯</span>
        </button>
        <button 
          onClick={async () => {
            try {
              await invoke('open_school_widget');
            } catch (e) {
              console.error('학교 위젯 열기 실패:', e);
            }
          }}
          title="학교 위젯 열기"
        >
          <span className="icon"><SchoolIcon /></span><span className="label">학교 위젯</span>
        </button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
          <span className="icon"><SettingsIcon /></span><span className="label">설정</span>
        </button>
      </nav>
    </aside>
  );
};
