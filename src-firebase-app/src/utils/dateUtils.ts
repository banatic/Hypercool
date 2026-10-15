/**
 * 날짜 유틸 — Firestore 에 올라온 문자열은 형식이 제각각이다.
 *  - JS toISOString:      2026-09-08T01:08:34.222Z
 *  - Rust to_rfc3339:     2026-09-08T01:08:34.222295300+00:00
 *  - 쿨메신저 ReceiveDate: 2026-09-08 14:23:11 (Safari 는 공백 구분자를 못 읽는다)
 *  - 날짜만:              2026-09-08 (로컬 자정으로 취급)
 *  - 숫자 뭉치:           20260908142311
 */
export function parseDate(value: string | number | Date | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    const s = value.trim();

    let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/);
    if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    }

    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3]);
    }

    m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    }

    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

export function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 달력 셀 묶음용 키: 로컬 날짜 기준 */
export function dateKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 기준일 자정에서 대상일 자정까지의 일수 차 (양수: 미래) */
export function daysBetween(from: Date, to: Date): number {
    const a = startOfDay(from).getTime();
    const b = startOfDay(to).getTime();
    return Math.round((b - a) / 86_400_000);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function weekdayLabel(d: Date): string {
    return WEEKDAYS[d.getDay()];
}

/** 2026년 9월 8일 (화) */
export function formatKoreanDate(d: Date, opts: { year?: boolean; weekday?: boolean } = {}): string {
    const { year = true, weekday = true } = opts;
    const parts = [] as string[];
    if (year) parts.push(`${d.getFullYear()}년`);
    parts.push(`${d.getMonth() + 1}월`, `${d.getDate()}일`);
    let out = parts.join(' ');
    if (weekday) out += ` (${weekdayLabel(d)})`;
    return out;
}

/** 9월 8일 (화) 14:23 */
export function formatKoreanDateTime(d: Date, opts: { year?: boolean } = {}): string {
    return `${formatKoreanDate(d, { year: opts.year ?? false })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 목록용 짧은 시각: 오늘이면 14:23, 올해면 9월 8일, 그 외 2025.12.01 */
export function formatListDate(d: Date, now: Date = new Date()): string {
    if (isSameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (daysBetween(d, now) === 1) return '어제';
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/** 기간 표시: 같은 날이면 한 번만, 해가 같으면 뒤쪽 해 생략 */
export function formatRange(start: Date, end: Date): string {
    if (isSameDay(start, end)) return formatKoreanDate(start);
    const sameYear = start.getFullYear() === end.getFullYear();
    return `${formatKoreanDate(start)} ~ ${formatKoreanDate(end, { year: !sameYear })}`;
}

/** D-day 라벨: 오늘 → "오늘", 내일 → "내일", 미래 → "D-3", 과거 → "3일 지남" */
export function dDayLabel(target: Date, now: Date = new Date()): string {
    const diff = daysBetween(now, target);
    if (diff === 0) return '오늘';
    if (diff === 1) return '내일';
    if (diff > 1) return `D-${diff}`;
    return `${-diff}일 지남`;
}

function pad(n: number): string {
    return n.toString().padStart(2, '0');
}
