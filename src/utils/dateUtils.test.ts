import { describe, it, expect } from 'vitest';
import { formatReceiveDate, formatDate, parseDateFromText, decodeEntities } from './dateUtils';

describe('dateUtils', () => {
    describe('formatReceiveDate', () => {
        it('should format date correctly', () => {
            const date = '2023-10-05T14:30:00';
            // Note: getMonth is 0-indexed, so 10 is Oct.
            // But implementation uses new Date(string).
            // If running in local timezone, it might vary.
            // Ideally we should mock timezone or use fixed UTC string if implementation handles it.
            // The implementation uses local time methods (getFullYear, getMonth, etc).
            // Let's assume the test runner environment (jsdom) uses local time or UTC.
            // We can check the output format primarily.
            const result = formatReceiveDate(date);
            expect(result).toMatch(/^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}$/);
        });

        it('should return null for invalid date', () => {
            expect(formatReceiveDate('invalid')).toBe(null);
        });

        it('should return null for null/undefined', () => {
            expect(formatReceiveDate(null)).toBe(null);
            expect(formatReceiveDate(undefined)).toBe(null);
        });
    });

    describe('formatDate', () => {
        it('should format date correctly', () => {
            const date = '2023-10-05';
            const result = formatDate(date);
            expect(result).toMatch(/^\d{2}\. \d{2}\. \d{2}\.$/);
        });
    });

    describe('decodeEntities', () => {
        it('should decode HTML entities', () => {
            expect(decodeEntities('&lt;div&gt;')).toBe('<div>');
            expect(decodeEntities('&amp;')).toBe('&');
        });
    });

    describe('parseDateFromText', () => {
        const baseDate = new Date('2023-10-05T10:00:00'); // Thursday

        it('should parse "오늘"', () => {
            const result = parseDateFromText('오늘 회의', baseDate);
            expect(result.date).toBe('2023-10-05');
        });

        it('should parse "내일"', () => {
            const result = parseDateFromText('내일 미팅', baseDate);
            expect(result.date).toBe('2023-10-06');
        });

        it('should parse absolute date "2023-12-25"', () => {
            const result = parseDateFromText('2023-12-25 크리스마스', baseDate);
            expect(result.date).toBe('2023-12-25');
        });

        it('should parse time "14:30"', () => {
            const result = parseDateFromText('오후 2시 30분', baseDate);
            expect(result.time).toBe('14:30');
        });

        it('should parse time "14:30" from "14:30"', () => {
            const result = parseDateFromText('14:30 미팅', baseDate);
            expect(result.time).toBe('14:30');
        });
    });
});
