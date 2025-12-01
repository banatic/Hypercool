import React, { useEffect, useState } from 'react';
import { AuthService } from '../auth/AuthService';
import { User } from 'firebase/auth';

interface AuthLandingProps {
  onSync?: () => Promise<void>;
  lastSyncTime?: string | null;
}

export const AuthLanding: React.FC<AuthLandingProps> = ({ onSync, lastSyncTime }) => {
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
    <div className="auth-landing p-4 flex flex-col items-center justify-center h-full">
      {user ? (
        <div className="user-info text-center">
          <img 
            src={user.photoURL || 'https://via.placeholder.com/150'} 
            alt="Profile" 
            className="w-16 h-16 rounded-full mx-auto mb-2"
          />
          <p className="font-bold mb-1">{user.displayName || 'User'}</p>
          <p className="text-sm text-gray-500 mb-4">{user.email}</p>
          <button 
            onClick={handleSignOut}
            className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 transition-colors"
          >
            Sign Out
          </button>
          
          <div className="mt-4 pt-4 border-t border-gray-200">
            <p className="text-sm text-gray-500 mb-2">
              Last Synced: {lastSyncTime ? new Date(lastSyncTime).toLocaleString() : 'Never'}
            </p>
            {onSync && (
              <button 
                onClick={onSync}
                className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 transition-colors text-sm"
              >
                Sync Now
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="login-container text-center">
          <h2 className="text-xl font-bold mb-2">Sync Your Data</h2>
          <p className="text-gray-600 mb-6">Sign in to synchronize your calendar and messages across devices.</p>
          <button 
            onClick={handleSignIn}
            className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center mx-auto"
          >
            Sign In
          </button>
        </div>
      )}
    </div>
  );
};
