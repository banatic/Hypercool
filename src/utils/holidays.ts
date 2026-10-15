// 대한민국 관공서 공휴일 (대체공휴일·임시공휴일 포함)
// 원본은 저장소 루트의 holidays.json — main 에 push 하면 앱 업데이트 없이 반영됨
// 빌드 시점 사본을 내장해 두고, 시작할 때 원격 파일을 받아 덮어씀 (실패 시 마지막 캐시 → 내장본)
import bundled from '../../holidays.json';

const REMOTE_URL = 'https://raw.githubusercontent.com/banatic/Hypercool/refs/heads/main/holidays.json';
const CACHE_KEY = 'hypercool.holidays';

type HolidayMap = Record<string, string>;

function parse(data: unknown): HolidayMap | null {
  const map = (data as { holidays?: unknown } | null)?.holidays;
  if (!map || typeof map !== 'object') return null;
  const out: HolidayMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'string') out[k] = v;
  }
  return out;
}

function readCache(): HolidayMap | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

let holidays: HolidayMap = readCache() ?? parse(bundled) ?? {};

/** 원격 holidays.json 을 받아 적용. 바뀌었으면 true */
export async function refreshHolidays(): Promise<boolean> {
  try {
    const res = await fetch(REMOTE_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    const map = parse(data);
    if (!map || Object.keys(map).length === 0) return false;
    const changed = JSON.stringify(map) !== JSON.stringify(holidays);
    holidays = map;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch {
      // 캐시 실패는 무시 — 다음 시작 때 다시 받음
    }
    return changed;
  } catch {
    return false;
  }
}

/** 로컬 날짜 기준 공휴일 이름, 아니면 undefined */
export function getHoliday(date: Date): string | undefined {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return holidays[`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`];
}
