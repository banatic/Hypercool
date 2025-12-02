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
    <div className="auth-landing w-full">
      {user ? (
        <div className="user-info flex flex-row items-center justify-between w-full p-2">
          <div className="flex flex-row items-center gap-4">
            <img 
              src={user.photoURL || 'https://via.placeholder.com/150'} 
              alt="Profile" 
              className="w-10 h-10 rounded-full"
            />
            <div className="flex flex-col items-start">
              <p className="font-bold text-sm">{user.displayName || 'User'}</p>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
          </div>
          
          <div className="flex flex-row items-center gap-4">
            <div className="text-right mr-2">
              <p className="text-xs text-gray-500">
                Last Synced:
              </p>
              <p className="text-xs text-gray-700 font-medium">
                {lastSyncTime ? new Date(lastSyncTime).toLocaleString() : 'Never'}
              </p>
            </div>

            {onSync && (
              <div className="flex items-center">
                {isLoadingSync ? (
                  <div className="text-sm text-blue-500 flex items-center gap-2">
                    <div className="loading-spinner w-4 h-4"></div>
                    <span className="text-xs">
                      {syncProgress 
                        ? `${Math.round((syncProgress.current / syncProgress.total) * 100)}%` 
                        : 'Syncing...'}
                    </span>
                  </div>
                ) : (
                  <button 
                    onClick={onSync}
                    className="bg-green-500 text-white px-3 py-1.5 rounded hover:bg-green-600 transition-colors text-xs flex items-center gap-1"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                      <path d="M3 3v5h5"></path>
                      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
                      <path d="M16 21h5v-5"></path>
                    </svg>
                    Sync
                  </button>
                )}
                {syncError && (
                  <div className="text-xs text-red-500 ml-2">
                    !
                  </div>
                )}
              </div>
            )}

            <button 
              onClick={handleSignOut}
              className="bg-red-500 text-white px-3 py-1.5 rounded hover:bg-red-600 transition-colors text-xs"
            >
              Sign Out
            </button>
          </div>
        </div>
      ) : (
        <div className="login-container flex flex-row items-center justify-between w-full p-2">
          <div className="flex flex-col">
            <h2 className="text-sm font-bold">Sync Your Data</h2>
            <p className="text-xs text-gray-600">Sign in to synchronize across devices.</p>
          </div>
          <button 
            onClick={handleSignIn}
            className="bg-blue-500 text-white px-4 py-1.5 rounded hover:bg-blue-600 transition-colors text-xs"
          >
            Sign In
          </button>
        </div>
      )}
    </div>
  );
};
