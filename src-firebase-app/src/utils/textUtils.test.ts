import { describe, it, expect } from 'vitest';
import { stripHtml, snippet, fileName, matchesQuery } from './textUtils';

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

    describe('snippet', () => {
        it('collapses whitespace and truncates with an ellipsis', () => {
            expect(snippet('<p>안녕하세요</p>\n<p>   공지   입니다</p>')).toBe('안녕하세요 공지 입니다');
            expect(snippet('가나다라마바사아자차', 6)).toBe('가나다라마…');
            expect(snippet('<table><tr><td>일시</td><td>15:00</td></tr><tr><td>장소</td><td>2층</td></tr></table>')).toBe('일시 15:00 장소 2층');
            expect(snippet('첫 줄<br>둘째 줄')).toBe('첫 줄 둘째 줄');
        });
    });

    describe('fileName', () => {
        it('strips Windows and POSIX directories', () => {
            expect(fileName('C:\\Users\\me\\Downloads\\공문.hwp')).toBe('공문.hwp');
            expect(fileName('/tmp/a/b.pdf')).toBe('b.pdf');
            expect(fileName('plain.txt')).toBe('plain.txt');
        });
    });

    describe('matchesQuery', () => {
        it('matches every space-separated term, case-insensitively', () => {
            expect(matchesQuery('교무부 김선생 9월 회의 안내', '회의 교무부')).toBe(true);
            expect(matchesQuery('Staff Meeting', 'meeting')).toBe(true);
            expect(matchesQuery('교무부 회의', '급식')).toBe(false);
            expect(matchesQuery('anything', '   ')).toBe(true);
        });
    });
});
