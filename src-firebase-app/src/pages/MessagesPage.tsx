import React, { useState, useEffect } from 'react';
import { useMessages } from '../hooks/useMessages';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './MessagesPage.css';
import './Page.css';

export const MessagesPage: React.FC = () => {
  const { messages, loading, loadingMore, hasMore, loadMoreMessages } = useMessages();
  const [currentIndex, setCurrentIndex] = useState(0);

  // 메시지가 로드되면 인덱스 초기화
  useEffect(() => {
    if (messages.length > 0 && currentIndex >= messages.length) {
      setCurrentIndex(messages.length - 1);
    }
  }, [messages.length, currentIndex]);

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex < messages.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else if (hasMore && !loadingMore) {
      // 마지막 메시지이고 더 불러올 수 있으면 로드
      loadMoreMessages().then(() => {
        setCurrentIndex(messages.length);
      });
    }
  };

  // 키보드 네비게이션
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        handlePrevious();
      } else if (e.key === 'ArrowRight') {
        handleNext();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [currentIndex, messages.length, hasMore, loadingMore]);

  const currentMessage = messages[currentIndex];

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>메시지</h1>
        <p>받은 메시지를 확인하세요.</p>
      </div>
      
      <div className="message-viewer-container">
        {loading ? (
          <div className="loading-state">메시지를 불러오는 중...</div>
        ) : messages.length === 0 ? (
          <div className="empty-state">메시지가 없습니다.</div>
        ) : (
          <>
            <div className="message-card-wrapper">
              <button 
                className="nav-button nav-button-left"
                onClick={handlePrevious}
                disabled={currentIndex === 0}
                aria-label="이전 메시지"
              >
                <ChevronLeft size={24} />
              </button>

              <div className="message-card">
                <div className="message-card-header">
                  <span className="message-sender">{currentMessage.sender}</span>
                  {currentMessage.receive_date && (
                    <span className="message-date">{currentMessage.receive_date}</span>
                  )}
                </div>
                <div className="message-card-content">
                  <div 
                    className="message-content"
                    dangerouslySetInnerHTML={{ __html: currentMessage.content }}
                  />
                </div>
                <div className="message-card-footer">
                  <span className="message-counter">
                    {currentIndex + 1} / {messages.length}{hasMore ? '+' : ''}
                  </span>
                </div>
              </div>

              <button 
                className="nav-button nav-button-right"
                onClick={handleNext}
                disabled={!hasMore && currentIndex === messages.length - 1}
                aria-label="다음 메시지"
              >
                <ChevronRight size={24} />
              </button>
            </div>

            {loadingMore && (
              <div className="loading-more-indicator">더 많은 메시지를 불러오는 중...</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
