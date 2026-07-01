export interface ExtStyle {
  bg: string;
  fg: string;
}

export function getExtStyle(filename: string): { style: ExtStyle; label: string } {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const label = ext.slice(0, 4) || '—';

  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg'].includes(ext))
    return { label, style: { bg: '#EDE9FE', fg: '#6D28D9' } };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv'].includes(ext))
    return { label, style: { bg: '#FEF3C7', fg: '#B45309' } };
  if (['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext))
    return { label, style: { bg: '#D1FAE5', fg: '#047857' } };
  if (ext === 'pdf')
    return { label, style: { bg: '#FEE2E2', fg: '#B91C1C' } };
  if (['doc', 'docx', 'hwp', 'hwpx', 'odt'].includes(ext))
    return { label, style: { bg: '#DBEAFE', fg: '#1D4ED8' } };
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext))
    return { label, style: { bg: '#DCFCE7', fg: '#15803D' } };
  if (['ppt', 'pptx', 'odp'].includes(ext))
    return { label, style: { bg: '#FFEDD5', fg: '#C2410C' } };
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext))
    return { label, style: { bg: '#F1F5F9', fg: '#475569' } };
  if (['exe', 'msi', 'dmg'].includes(ext))
    return { label, style: { bg: '#F1F5F9', fg: '#334155' } };
  if (['txt', 'md', 'log', 'xml', 'json'].includes(ext))
    return { label, style: { bg: '#F1F5F9', fg: '#475569' } };

  return { label: label || '…', style: { bg: '#F1F5F9', fg: '#6B7280' } };
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * 파일명 truncation — 뒷자리(확장자/버전/날짜 등 정보가 많은 쪽)를 최대한 보여줌.
 * 앞부분은 3자만 남기고 ellipsis, 나머지는 모두 뒤에서 자름.
 *
 *   "보고서_가정통신문_2026학년도_봄학기_v3_최종_signed.pdf" (32+)
 *   → "보고서…학년도_봄학기_v3_최종_signed.pdf"
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = 3;
  const tail = max - head - 1; // -1 for ellipsis
  return s.slice(0, head) + '…' + s.slice(-tail);
}
