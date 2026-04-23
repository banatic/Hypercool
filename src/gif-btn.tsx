import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import './gif-btn.css';

const LABEL = getCurrentWebviewWindow().label;

function GifButton() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // 워처가 대상 창을 닫을 때 (target window destroyed/hidden) active 초기화
    const unsub = listen<string>('gif-panel-closed', (e) => {
      if (e.payload === LABEL) setActive(false);
    });
    return () => { unsub.then(f => f()); };
  }, []);

  const handleClick = async () => {
    try {
      const nowVisible = await invoke<boolean>('toggle_gif_panel', { btnLabel: LABEL });
      setActive(nowVisible);
    } catch (e) {
      console.error('GIF 패널 토글 실패:', e);
    }
  };

  return (
    <div className={`gif-btn ${active ? 'active' : ''}`} onClick={handleClick}>
      <span className="gif-btn-label">GIF</span>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GifButton />
  </React.StrictMode>
);
