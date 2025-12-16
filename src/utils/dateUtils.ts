export const formatReceiveDate = (receiveDate: string | null | undefined) => {
    if (!receiveDate) return null;
    try {
        const date = new Date(receiveDate);
        if (isNaN(date.getTime())) return null;

        const year = date.getFullYear().toString().slice(-2);
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${year}.${month}.${day} ${hours}:${minutes}`;
    } catch {
        return null;
    }
};

export const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}. ${month}. ${day}.`;
};

// HTML entity decode cache to avoid repeated DOM operations
const entityDecodeCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500;

// Common HTML entities map
const HTML_ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&ndash;': '–',
    '&mdash;': '—',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '\u201C',
    '&rdquo;': '\u201D',
    '&bull;': '\u2022',
    '&hellip;': '\u2026',
};

// Decode HTML entities WITHOUT DOM manipulation (no forced layout!)
export const decodeEntities = (html: string): string => {
    if (!html) return html;

    // Check cache first
    const cached = entityDecodeCache.get(html);
    if (cached !== undefined) return cached;

    // Decode using regex (no DOM!)
    let decoded = html
        // Named entities
        .replace(/&[a-zA-Z]+;/g, (entity) => HTML_ENTITIES[entity] || entity)
        // Numeric entities (decimal)
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
        // Numeric entities (hex)
        .replace(/&#x([a-fA-F0-9]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    // Cache the result (with size limit)
    if (entityDecodeCache.size >= MAX_CACHE_SIZE) {
        // Remove oldest entries (first 100)
        const keys = Array.from(entityDecodeCache.keys()).slice(0, 100);
        keys.forEach(k => entityDecodeCache.delete(k));
    }
    entityDecodeCache.set(html, decoded);

    return decoded;
};

// 날짜 파싱 함수: 다양한 형식의 날짜 문자열을 파싱하여 ISO 날짜 문자열과 시간을 반환
export const parseDateFromText = (text: string, baseDate?: Date): { date: string | null; time: string | null } => {
    const now = baseDate || new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const pad = (n: number) => n.toString().padStart(2, '0');

    // "님의 보낸 메시지 전달 >> YYYY/MM/DD HH:MM:SS (요일)" 형식 제거
    const textWithoutDeliveryTime = text.replace(/님의\s*보낸\s*메시지\s*전달\s*>>\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*\([일월화수목금토]\)/gi, '');

    // 텍스트 정규화 (공백 제거, 소문자 변환)
    const normalizedText = textWithoutDeliveryTime.replace(/\s+/g, ' ').trim();

    // 상대적 날짜 패턴
    const relativeDatePatterns = [
        { pattern: /오늘|지금/i, days: 0 },
        { pattern: /내일/i, days: 1 },
        { pattern: /모레/i, days: 2 },
        { pattern: /글피/i, days: 3 },
        { pattern: /다음\s*주|다음주/i, days: 7 },
        { pattern: /이번\s*주|이번주/i, days: 0 },
        { pattern: /다다음\s*주|다다음주/i, days: 14 },
    ];

    // 요일 패턴 (한국어)
    const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    const weekdayMap: Record<string, number> = {};
    weekdays.forEach((day, index) => {
        weekdayMap[day] = index;
    });

    // 절대 날짜 패턴들 (각 패턴마다 파싱 로직이 다름)
    const absoluteDatePatterns: Array<{ pattern: RegExp; parse: (match: RegExpMatchArray, today: Date) => Date | null }> = [
        {
            // YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD
            pattern: /(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/,
            parse: (match) => {
                const year = parseInt(match[1]);
                const month = parseInt(match[2]) - 1;
                const day = parseInt(match[3]);
                return new Date(year, month, day);
            }
        },
        {
            // YYYY년 MM월 DD일
            pattern: /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
            parse: (match) => {
                const year = parseInt(match[1]);
                const month = parseInt(match[2]) - 1;
                const day = parseInt(match[3]);
                return new Date(year, month, day);
            }
        },
        {
            // MM월 DD일
            pattern: /(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
            parse: (match, today) => {
                const month = parseInt(match[1]) - 1;
                const day = parseInt(match[2]);
                const date = new Date(today.getFullYear(), month, day);
                // 이미 지난 날짜면 내년으로
                if (date < today) {
                    date.setFullYear(date.getFullYear() + 1);
                }
                return date;
            }
        },
        {
            // MM-DD, MM.DD, MM/DD (올해로 가정)
            pattern: /(\d{1,2})[.\-\/](\d{1,2})(?!\d)/,
            parse: (match, today) => {
                const month = parseInt(match[1]) - 1;
                const day = parseInt(match[2]);
                const date = new Date(today.getFullYear(), month, day);
                // 이미 지난 날짜면 내년으로
                if (date < today) {
                    date.setFullYear(date.getFullYear() + 1);
                }
                return date;
            }
        },
    ];

    // 시간 패턴들
    const timePatterns: Array<{ pattern: RegExp; parse: (match: RegExpMatchArray) => string | null }> = [
        {
            // 오전/오후 시간
            pattern: /(오전|오후|AM|PM|am|pm)\s*(\d{1,2})시(?:\s*(\d{1,2})분)?/,
            parse: (match) => {
                const period = match[1].toLowerCase();
                let hours = parseInt(match[2]) || 0;
                const minutes = match[3] ? parseInt(match[3]) : 0;

                if (period.includes('오후') || period.includes('pm')) {
                    if (hours !== 12) hours += 12;
                } else if (period.includes('오전') || period.includes('am')) {
                    if (hours === 12) hours = 0;
                }
                return `${pad(hours)}:${pad(minutes)}`;
            }
        },
        {
            // HH:MM 형식
            pattern: /(\d{1,2}):(\d{2})/,
            parse: (match) => {
                const hours = parseInt(match[1]);
                const minutes = parseInt(match[2]);
                return `${pad(hours)}:${pad(minutes)}`;
            }
        },
        {
            // HH시 MM분 형식
            pattern: /(\d{1,2})\s*시\s*(\d{1,2})\s*분/,
            parse: (match) => {
                const hours = parseInt(match[1]);
                const minutes = parseInt(match[2]);
                return `${pad(hours)}:${pad(minutes)}`;
            }
        },
        {
            // HHMM 형식 (4자리 숫자)
            pattern: /(\d{2})(\d{2})(?=\s|$|[^\d])/,
            parse: (match) => {
                const hours = parseInt(match[1]);
                const minutes = parseInt(match[2]);
                if (hours < 24 && minutes < 60) {
                    return `${pad(hours)}:${pad(minutes)}`;
                }
                return null;
            }
        },
        {
            // N시 형식
            pattern: /(\d{1,2})\s*시(?!\s*\d)/,
            parse: (match) => {
                const hours = parseInt(match[1]);
                return `${pad(hours)}:00`;
            }
        },
    ];

    // 모든 날짜와 시간을 수집
    const foundDates: Date[] = [];
    let parsedTime: string | null = null;

    // 1. 상대적 날짜 패턴 매칭 (모든 매칭 찾기)
    for (const { pattern, days } of relativeDatePatterns) {
        const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        const matches = normalizedText.matchAll(globalPattern);
        for (const _match of matches) {
            const date = new Date(today);
            date.setDate(date.getDate() + days);
            foundDates.push(date);
        }
    }

    // 2. 요일 패턴 매칭 (모든 매칭 찾기)
    for (const [weekday, weekdayIndex] of Object.entries(weekdayMap)) {
        if (normalizedText.includes(weekday)) {
            const targetDate = new Date(today);
            const currentDay = today.getDay();
            let daysToAdd = (weekdayIndex - currentDay + 7) % 7;
            if (daysToAdd === 0) daysToAdd = 7; // 이번 주가 아니라 다음 주로
            targetDate.setDate(targetDate.getDate() + daysToAdd);
            foundDates.push(targetDate);
        }
    }

    // 3. 절대 날짜 패턴 매칭 (모든 매칭 찾기)
    for (const { pattern, parse } of absoluteDatePatterns) {
        const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        const matches = normalizedText.matchAll(globalPattern);
        for (const match of matches) {
            const date = parse(match, today);
            if (date) {
                foundDates.push(date);
            }
        }
    }

    // 4. 시간 패턴 매칭 (첫 번째 매칭만 사용)
    for (const { pattern, parse } of timePatterns) {
        const match = normalizedText.match(pattern);
        if (match) {
            parsedTime = parse(match);
            if (parsedTime) break;
        }
    }

    // 가장 빠른 날짜 선택
    let parsedDate: Date | null = null;
    if (foundDates.length > 0) {
        // 날짜 배열을 정렬하여 가장 빠른 날짜 선택
        foundDates.sort((a, b) => a.getTime() - b.getTime());
        parsedDate = foundDates[0];
    }

    // 파싱된 날짜를 YYYY-MM-DD 형식으로 변환
    if (parsedDate) {
        const dateStr = `${parsedDate.getFullYear()}-${pad(parsedDate.getMonth() + 1)}-${pad(parsedDate.getDate())}`;
        return { date: dateStr, time: parsedTime };
    }

    return { date: null, time: null };
};
