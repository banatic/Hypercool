import React, { useEffect, useState } from 'react';
import { AuthService } from '../auth/AuthService';
import { User } from 'firebase/auth';

interface AuthLandingProps {
  onSync?: () => Promise<void>;
  lastSyncTime?: string | null;
  isLoadingSync?: boolean;
  syncProgress?: { current: number; total: number } | null;
  syncError?: string | null;
}

export const AuthLanding: React.FC<AuthLandingProps> = ({ 
  onSync, 
  lastSyncTime,
  isLoadingSync,
  syncProgress,
  syncError
}) => {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // Initialize deep link listener
    AuthService.init();

    // Subscribe to auth state changes
    const unsubscribe = AuthService.onAuthStateChanged((user) => {
      setUser(user);
    });

    return () => unsubscribe();
  }, []);

  const handleSignIn = () => {
    AuthService.signIn();
  };

  const handleSignOut = () => {
    AuthService.signOut();
  };

  return (
    <div className="auth-landing">
      {user ? (
        <div className="auth-user-info">
          <div className="auth-user-profile">
            <img 
              src={user.photoURL || 'https://via.placeholder.com/150'} 
              alt="Profile" 
              className="auth-user-avatar"
            />
            <div className="auth-user-details">
              <div className="auth-user-name">{user.displayName || 'User'}</div>
              <div className="auth-user-email">{user.email}</div>
            </div>
          </div>
          
          <div className="auth-user-actions">
            {lastSyncTime && (
              <div className="auth-sync-time">
                <div className="auth-sync-time-label">마지막 동기화</div>
                <div className="auth-sync-time-value">
                  {new Date(lastSyncTime).toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </div>
              </div>
            )}

            {onSync && (
              <div className="auth-sync-button-wrapper">
                {isLoadingSync ? (
                  <div className="auth-sync-loading">
                    <div className="auth-loading-spinner"></div>
                    <span className="auth-sync-progress-text">
                      {syncProgress 
                        ? `${Math.round((syncProgress.current / syncProgress.total) * 100)}%` 
                        : '동기화 중...'}
                    </span>
                  </div>
                ) : (
                  <button 
                    onClick={onSync}
                    className="auth-sync-button"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                      <path d="M3 3v5h5"></path>
                      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                      <path d="M16 21h5v-5"></path>
                    </svg>
                    동기화
                  </button>
                )}
                {syncError && (
                  <div className="auth-sync-error" title={syncError}>
                    ⚠
                  </div>
                )}
              </div>
            )}

            <button 
              onClick={handleSignOut}
              className="auth-signout-button"
            >
              로그아웃
            </button>
          </div>
        </div>
      ) : (
        <div className="auth-login-container">
          <div className="auth-login-info">
            <div className="auth-login-title">데이터 동기화</div>
            <div className="auth-login-description">로그인하여 여러 기기에서 데이터를 동기화하세요.</div>
          </div>
          <button 
            onClick={handleSignIn}
            className="auth-signin-button"
          >
            로그인
          </button>
        </div>
      )}
    </div>
  );
};
