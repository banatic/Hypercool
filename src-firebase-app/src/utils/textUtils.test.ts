import { describe, it, expect } from 'vitest';
import { stripHtml } from './textUtils';

describe('textUtils', () => {
    describe('stripHtml', () => {
        it('should remove HTML tags', () => {
            expect(stripHtml('<p>Hello</p>')).toBe('Hello');
            expect(stripHtml('<div><span>World</span></div>')).toBe('World');
        });

        it('should handle empty or null input', () => {
            expect(stripHtml('')).toBe('');
            expect(stripHtml(null)).toBe('');
            expect(stripHtml(undefined)).toBe('');
        });

        it('should handle plain text', () => {
            expect(stripHtml('Hello World')).toBe('Hello World');
        });
    });
});
