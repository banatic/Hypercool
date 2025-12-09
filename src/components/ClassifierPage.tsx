import React from 'react';
import { Message } from '../types';
import { PageHeader } from './PageHeader';
import { AttachmentList } from './AttachmentList';
import { decodeEntities, formatReceiveDate } from '../utils/dateUtils';

interface ClassifierPageProps {
  isLoading: boolean;
  statusText: string;
  visibleMessages: Message[];
  onMouseDown: (id: number) => (e: React.MouseEvent<HTMLDivElement>) => void;
  classify: (id: number, direction: 'left' | 'right') => void;
  loadUdbFile: (path?: string, offset?: number, searchTerm?: string) => Promise<void>;
  udbPath: string;
  pickUdb: () => Promise<void>;
  completeAllPending: () => void;
  onHideToTray?: () => void;
  deadlines?: Record<string, string | null>;
  calendarTitles?: Record<string, string>;
  isSyncing?: boolean;
  syncProgress?: { current: number; total: number } | null;
  syncError?: string | null;
  onSync?: () => Promise<void>;
}

export const ClassifierPage: React.FC<ClassifierPageProps> = ({
  isLoading,
  statusText,
  visibleMessages,
  onMouseDown,
  classify,
  loadUdbFile,
  udbPath,
  pickUdb,
  completeAllPending,
  isSyncing,
  syncProgress,
}) => {
  return (
    <div className="classifier page-content">
      <PageHeader title="메시지 분류">
        <div className="header-actions">
          <span className="status">{statusText}</span>
          <button 
            onClick={() => { loadUdbFile(udbPath, 0); }} 
            disabled={isLoading} 
            className="refresh-btn" 
            title="새로고침"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6"></path>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
            새로고침
          </button>
          <button className="complete-all-btn" onClick={completeAllPending} disabled={visibleMessages.length === 0}>
            전부 완료 처리
          </button>
        </div>
      </PageHeader>
      <div className="classifier-stage">
        {visibleMessages.length === 0 && (
          <div className="empty">
            {udbPath ? '분류할 메시지가 없습니다.' : (
              <div className="no-udb">
                <p>UDB 파일을 선택해주세요.</p>
                <button onClick={pickUdb}>파일 선택</button>
              </div>
            )}
          </div>
        )}
        {visibleMessages.map((msg, idx) => (
          <div key={msg.id} className={`card ${idx === 0 ? 'top' : 'back'}`} onMouseDown={onMouseDown(msg.id)}>
            <div className="card-inner">
              <div className="card-sender">
                {msg.sender}
                {msg.receive_date && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal', marginLeft: '8px' }}>
                    {formatReceiveDate(msg.receive_date)}
                  </span>
                )}
              </div>
              <div className="card-content" dangerouslySetInnerHTML={{ __html: decodeEntities(msg.content) }} />
              {msg.file_paths && msg.file_paths.length > 0 && (
                <AttachmentList filePaths={msg.file_paths} />
              )}
              <div className="card-actions">
                <button className="left" onClick={() => classify(msg.id, 'left')}>◀ 완료된 일</button>
                <button className="right" onClick={() => classify(msg.id, 'right')}>해야할 일 ▶</button>
              </div>
            </div>
          </div>
        )).reverse() /* Render back card first */}
      </div>
      {/* Sync Status Overlay or Indicator if needed */}
      {isSyncing && (
        <div className="sync-indicator">
          동기화 중... {syncProgress ? `${syncProgress.current}/${syncProgress.total}` : ''}
        </div>
      )}
    </div>
  );
};
