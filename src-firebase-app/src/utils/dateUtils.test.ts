import { describe, it, expect } from 'vitest';
import {
    parseDate, dateKey, daysBetween, dDayLabel, formatKoreanDate,
    formatListDate, formatRange, isSameDay,
} from './dateUtils';

describe('parseDate', () => {
    it('parses ISO with Z and Rust rfc3339 nanoseconds', () => {
        expect(parseDate('2026-09-08T01:08:34.222Z')?.toISOString()).toBe('2026-09-08T01:08:34.222Z');
        const rust = parseDate('2026-09-08T01:08:34.222295300+00:00');
        expect(rust).not.toBeNull();
        expect(rust!.getUTCHours()).toBe(1);
    });

    it('parses CoolMessenger space-separated datetime as local time', () => {
        const d = parseDate('2026-09-08 14:23:11');
        expect(d).not.toBeNull();
        expect(d!.getFullYear()).toBe(2026);
        expect(d!.getMonth()).toBe(8);
        expect(d!.getDate()).toBe(8);
        expect(d!.getHours()).toBe(14);
        expect(d!.getMinutes()).toBe(23);
    });

    it('parses date-only as local midnight and 14-digit compact form', () => {
        const d = parseDate('2026-09-08');
        expect(d!.getHours()).toBe(0);
        expect(d!.getDate()).toBe(8);
        const c = parseDate('20260908142311');
        expect(c!.getHours()).toBe(14);
        expect(c!.getSeconds()).toBe(11);
    });

    it('returns null for garbage and empty', () => {
        expect(parseDate('')).toBeNull();
        expect(parseDate(null)).toBeNull();
        expect(parseDate('not a date')).toBeNull();
    });
});

describe('day math', () => {
    const now = new Date(2026, 8, 8, 15, 30);

    it('daysBetween ignores time of day', () => {
        expect(daysBetween(now, new Date(2026, 8, 9, 1))).toBe(1);
        expect(daysBetween(now, new Date(2026, 8, 8, 23, 59))).toBe(0);
        expect(daysBetween(now, new Date(2026, 8, 5))).toBe(-3);
    });

    it('dDayLabel', () => {
        expect(dDayLabel(new Date(2026, 8, 8), now)).toBe('오늘');
        expect(dDayLabel(new Date(2026, 8, 9), now)).toBe('내일');
        expect(dDayLabel(new Date(2026, 8, 12), now)).toBe('D-4');
        expect(dDayLabel(new Date(2026, 8, 6), now)).toBe('2일 지남');
    });

    it('dateKey and isSameDay', () => {
        expect(dateKey(new Date(2026, 0, 5))).toBe('2026-0-5');
        expect(isSameDay(new Date(2026, 0, 5, 1), new Date(2026, 0, 5, 23))).toBe(true);
    });
});

describe('formatting', () => {
    const now = new Date(2026, 8, 8, 15, 30);

    it('formatKoreanDate', () => {
        expect(formatKoreanDate(new Date(2026, 8, 8))).toBe('2026년 9월 8일 (화)');
        expect(formatKoreanDate(new Date(2026, 8, 8), { year: false, weekday: false })).toBe('9월 8일');
    });

    it('formatListDate picks the shortest useful form', () => {
        expect(formatListDate(new Date(2026, 8, 8, 9, 5), now)).toBe('09:05');
        expect(formatListDate(new Date(2026, 8, 7, 9, 5), now)).toBe('어제');
        expect(formatListDate(new Date(2026, 2, 1), now)).toBe('3월 1일');
        expect(formatListDate(new Date(2025, 11, 1), now)).toBe('2025.12.01');
    });

    it('formatRange collapses same-day and same-year', () => {
        expect(formatRange(new Date(2026, 8, 8), new Date(2026, 8, 8))).toBe('2026년 9월 8일 (화)');
        expect(formatRange(new Date(2026, 8, 8), new Date(2026, 8, 10))).toBe('2026년 9월 8일 (화) ~ 9월 10일 (목)');
        expect(formatRange(new Date(2026, 11, 30), new Date(2027, 0, 2))).toBe('2026년 12월 30일 (수) ~ 2027년 1월 2일 (토)');
    });
});
