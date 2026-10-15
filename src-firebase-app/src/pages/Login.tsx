import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { GoogleAuthProvider, signInWithPopup, signInWithRedirect } from 'firebase/auth';
import { auth } from '../firebase';
import { useData } from '../context/DataStore';
import './Login.css';

/** 데스크톱 앱은 Windows 전용이므로, 그 밖의 기기에서는 딥링크를 시도하지 않는다. */
const isWindows = () => /Windows NT/i.test(navigator.userAgent);

/** hypercool:// 딥링크를 숨은 iframe 으로 열어, 앱이 없어도 빈 오류 페이지로 넘어가지 않게 한다. */
function handOffToDesktop(idToken: string) {
  const url = `hypercool://auth/callback?token=${encodeURIComponent(idToken)}&type=google`;
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.src = url;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 1500);
}

export const Login: React.FC = () => {
  const { user, authLoading } = useData();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authLoading && user) {
    return <Navigate to="/today" replace />;
  }

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setError(null);
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const idToken = credential?.idToken;
      if (idToken && isWindows()) {
        try {
          handOffToDesktop(idToken);
        } catch (e) {
          console.warn('Deep link hand-off failed:', e);
        }
      }
      // 이후 이동은 onAuthStateChanged → 위의 Navigate 가 처리한다.
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        // 팝업을 막는 모바일 브라우저는 리다이렉트 방식으로 넘어간다.
        try {
          await signInWithRedirect(auth, provider);
          return;
        } catch (e) {
          console.error('Redirect login failed', e);
        }
      }
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        console.error('Login failed', err);
        setError('Google 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
      setIsLoading(false);
    }
  };

  return (
    <div className="login">
      <section className="login-hero" aria-hidden="true">
        <div className="hero-grid">
          {Array.from({ length: 35 }, (_, i) => (
            <span key={i} className={`hero-cell${[9, 10, 11, 17, 23, 24].includes(i) ? ' on' : ''}${i === 16 ? ' today' : ''}`} />
          ))}
        </div>
      </section>

      <section className="login-panel">
        <div className="login-brand">
          <span className="brand-mark" />
          <span className="brand-name">HyperCool</span>
        </div>

        <h1 className="login-title">
          학교 메신저의 일정과 할 일,
          <br />
          어디서나 이어 보기
        </h1>
        <p className="login-lead">HyperCool 앱과 같은 Google 계정으로 로그인하세요.</p>

        <button type="button" className="google-btn" onClick={handleGoogleLogin} disabled={isLoading || authLoading}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.86c2.26-2.09 3.56-5.17 3.56-8.87z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24z" />
            <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.9 12c0-.8.14-1.57.37-2.29V6.62H1.29A12 12 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.09z" />
            <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
          </svg>
          {isLoading ? '로그인 중…' : 'Google 계정으로 로그인'}
        </button>

        {error && <p className="login-error" role="alert">{error}</p>}

      </section>
    </div>
  );
};
