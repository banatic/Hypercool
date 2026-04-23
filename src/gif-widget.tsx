import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './gif-widget.css';

interface GifItem {
  id: string;
  title: string;
  preview_url: string;
  embed_url: string;
}

interface TenorResult {
  gifs: GifItem[];
  total_count: number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function GifWidget() {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusText, setStatusText] = useState('트렌딩 GIF 로딩 중...');
  const [countText, setCountText] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);
  const [toast, setToast] = useState<{ icon: string; msg: string } | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((icon: string, msg: string) => {
    setToast({ icon, msg });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const loadGifs = useCallback(async (q: string) => {
    if (isLoading) return;
    setIsLoading(true);
    setGifs([]);
    setShowEmpty(false);
    setCountText('');
    setStatusText(q ? `"${q}" 크롤링 중...` : 'Tenor 트렌딩 로딩 중...');

    try {
      const result = await invoke<TenorResult>('cmd_search_tenor', { query: q, offset: 0 });
      if (!result.gifs || result.gifs.length === 0) {
        setShowEmpty(true);
        setStatusText('결과 없음');
      } else {
        setGifs(result.gifs);
        setStatusText(q ? `"${q}" 검색 결과` : 'Tenor 트렌딩');
        setCountText(`${result.gifs.length}개`);
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes('error sending request') || msg.includes('connection') || msg.includes('network')) {
        setStatusText('⚠️ 네트워크 오류 — 인터넷 연결을 확인하세요');
      } else {
        setStatusText('⚠️ GIF 로드 실패');
      }
      setShowEmpty(true);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  useEffect(() => {
    loadGifs('');
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => loadGifs(val.trim()), 600);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      loadGifs(query.trim());
    }
    if (e.key === 'Escape') {
      setQuery('');
      loadGifs('');
    }
  };

  const handleClear = () => {
    setQuery('');
    loadGifs('');
  };

  const handleGifClick = async (gif: GifItem) => {
    const html = `<img src="${gif.embed_url}" alt="${escapeHtml(gif.title)}" />`;
    try {
      await invoke('cmd_copy_html', { html });
      showToast('✅', '클립보드에 복사됨!');
    } catch (err) {
      showToast('❌', '복사 실패: ' + String(err).slice(0, 40));
    }
  };

  return (
    <div className="gif-panel">
      {/* 검색 */}
      <div className="gif-search-area">
        <div className="gif-search-wrap">
          <span className="gif-search-icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
          </span>
          <input
            className="gif-search-input"
            type="text"
            placeholder="GIF 검색... (비워두면 트렌딩)"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
          />
          <button
            className={`gif-btn-clear ${query ? 'visible' : ''}`}
            onClick={handleClear}
            title="지우기"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 상태 바 */}
      <div className="gif-status-bar">
        <span className="gif-status-text">{statusText}</span>
        {countText && <span className="gif-count-badge">{countText}</span>}
      </div>

      {/* GIF 그리드 */}
      <div className="gif-grid-wrap">
        <div className="gif-grid">
          {isLoading
            ? Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="gif-skeleton" />
              ))
            : gifs.map(gif => (
                <GifCard key={gif.id} gif={gif} onClick={handleGifClick} />
              ))
          }
        </div>
        {showEmpty && (
          <div className="gif-empty-state">
            <div className="gif-empty-icon">🔍</div>
            <div>검색 결과가 없습니다</div>
          </div>
        )}
      </div>

      {/* 토스트 */}
      <div className={`gif-toast ${toast ? '' : 'hidden'}`}>
        <span>{toast?.icon}</span>
        <span>{toast?.msg}</span>
      </div>
    </div>
  );
}

function GifCard({ gif, onClick }: { gif: GifItem; onClick: (g: GifItem) => void }) {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && img.dataset.src) {
            img.src = img.dataset.src;
            observer.unobserve(img);
          }
        });
      },
      { rootMargin: '120px' }
    );
    observer.observe(img);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="gif-card" onClick={() => onClick(gif)} title={gif.title}>
      <img
        ref={imgRef}
        data-src={gif.preview_url}
        alt={gif.title}
        loading="lazy"
        style={{ opacity: 0, transition: 'opacity 0.3s' }}
        onLoad={e => { (e.target as HTMLImageElement).style.opacity = '1'; }}
        onError={e => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GifWidget />
  </React.StrictMode>
);
