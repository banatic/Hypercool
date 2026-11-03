import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { refreshHolidays } from '../utils/holidays';

/** 위젯을 클릭·포커스하면 바탕화면 바로 위로 내린다(500ms 간격 제한). */
export function useSendToBottom() {
  useEffect(() => {
    let lastCall = 0;
    const sendToBottom = (e?: Event) => {
      // 리사이즈 핸들 위에서는 send-to-bottom 이 리사이즈 시작을 가로채지 않도록 건너뜀
      if (e && e.target instanceof HTMLElement && e.target.closest('[data-resize-handle]')) return;
      const now = Date.now();
      if (now - lastCall < 500) return;
      lastCall = now;
      invoke('send_window_to_bottom').catch(console.error);
    };

    window.addEventListener('mousedown', sendToBottom);
    window.addEventListener('focus', sendToBottom);
    return () => {
      window.removeEventListener('mousedown', sendToBottom);
      window.removeEventListener('focus', sendToBottom);
    };
  }, []);
}

/** 공휴일: 시작 시 + 6시간마다 원격 holidays.json 확인. 바뀌면 다시 그리도록 리렌더. */
export function useHolidayRefresh() {
  const [, setHolidayRev] = useState(0);
  useEffect(() => {
    const refresh = () => {
      refreshHolidays().then(changed => {
        if (changed) setHolidayRev(v => v + 1);
      });
    };
    refresh();
    const timer = setInterval(refresh, 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
}

/** 메시지 본문의 http(s) 링크는 위젯 안이 아니라 외부 브라우저로 연다. */
export function useExternalLinks() {
  useEffect(() => {
    const handleLinkClick = async (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a');
      if (!link) return;
      // href 속성 원본이 상대 경로여도 link.href 는 절대 URL 이 된다
      const href = link.getAttribute('href') || link.href;
      if (!href) return;
      const url = /^https?:\/\//.test(href) ? href : /^https?:\/\//.test(link.href) ? link.href : null;
      if (!url) return;

      e.preventDefault();
      e.stopPropagation();
      try {
        await shellOpen(url);
      } catch (error) {
        console.error('링크 열기 실패:', error);
      }
    };

    // 이벤트 위임: 동적으로 추가되는 링크도 처리
    document.addEventListener('click', handleLinkClick, true);
    return () => {
      document.removeEventListener('click', handleLinkClick, true);
    };
  }, []);
}
