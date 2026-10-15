export const stripHtml = (html: string | null | undefined): string => {
  if (!html) return '';
  const tmp = document.createElement('DIV');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
};

/** 본문 HTML → 한 줄 미리보기 (공백 정리, 길이 제한) */
export const snippet = (html: string | null | undefined, max = 90): string => {
  // 블록 요소·표 셀 경계는 공백으로 바꿔, 붙어 버린 "15:00장소:" 같은 결과를 막는다.
  const spaced = (html ?? '').replace(/<br\s*\/?>|<\/(?:p|div|td|th|tr|li|h[1-6]|blockquote|pre)>/gi, '$& ');
  const text = stripHtml(spaced).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
};

/** 경로에서 파일 이름만 (Windows/POSIX 구분자 모두) */
export const fileName = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

/** 대소문자 무시 + 공백 단위 AND 매칭. 빈 검색어는 항상 참. */
export const matchesQuery = (haystack: string, query: string): boolean => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const target = haystack.toLowerCase();
  return terms.every(t => target.includes(t));
};
