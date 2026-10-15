import { describe, it, expect } from 'vitest';
import { byteLength, truncateToBytes, compressInlineImages, ImageEncoder } from './contentSize';

// 실제 캔버스 대신 "고정 비율로 줄어드는" 가짜 인코더. 티어가 셀수록 더 많이 줄인다.
function fakeEncoder(ratioByMaxDim: Record<number, number>): ImageEncoder {
    return async (bytes, _mime, tier) => {
        const ratio = ratioByMaxDim[tier.maxDim] ?? 1;
        const size = Math.max(1, Math.floor(bytes.length * ratio));
        return { bytes: new Uint8Array(size), mime: 'image/jpeg' };
    };
}

function dataUrl(mime: string, rawBytes: number): string {
    // base64 는 3바이트 → 4문자
    return `data:${mime};base64,${'A'.repeat(Math.ceil(rawBytes / 3) * 4)}`;
}

describe('byteLength', () => {
    it('한글은 글자당 3바이트로 센다', () => {
        expect(byteLength('가나다')).toBe(9);
        expect('가나다'.length).toBe(3); // 예전 버그의 원인
    });
});

describe('truncateToBytes', () => {
    it('바이트 한도 이하로 자른다', () => {
        const s = '가'.repeat(100); // 300 바이트
        const cut = truncateToBytes(s, 100);
        expect(byteLength(cut)).toBeLessThanOrEqual(100);
        expect(cut).toBe('가'.repeat(33));
    });

    it('한도 이내면 그대로 둔다', () => {
        expect(truncateToBytes('hello', 100)).toBe('hello');
    });

    it('대리 쌍을 반쪽으로 끊지 않는다', () => {
        const s = '😀😀😀'; // 각 4바이트
        const cut = truncateToBytes(s, 6); // 1개 반
        expect(byteLength(cut)).toBeLessThanOrEqual(6);
        expect(cut).toBe('😀');
        expect([...cut].length).toBe(1);
    });
});

describe('compressInlineImages', () => {
    it('한도 이내면 손대지 않는다', async () => {
        const content = `<p>안녕</p><img src="${dataUrl('image/png', 300)}">`;
        expect(await compressInlineImages(content, 1_000_000, fakeEncoder({}))).toBe(content);
    });

    it('이미지를 압축해 한도에 맞추고 본문은 보존한다', async () => {
        const content = `<p>중요한 본문</p><img src="${dataUrl('image/png', 30_000)}"><p>뒷부분</p>`;
        const target = 12_000;

        const out = await compressInlineImages(content, target, fakeEncoder({ 1600: 0.2 }));

        expect(byteLength(out)).toBeLessThanOrEqual(target);
        expect(out).toContain('중요한 본문');
        expect(out).toContain('뒷부분'); // 잘렸다면 사라졌을 부분
        expect(out).toContain('data:image/jpeg;base64,');
    });

    it('첫 티어로 부족하면 더 강한 티어로 내려간다', async () => {
        const content = `<img src="${dataUrl('image/png', 30_000)}">`;
        const target = 5_000;

        const out = await compressInlineImages(content, target, fakeEncoder({
            1600: 0.5,   // 부족
            1024: 0.25,  // 부족
            640: 0.05,   // 충분
        }));

        expect(byteLength(out)).toBeLessThanOrEqual(target);
    });

    it('이미지가 여러 개면 모두 압축한다', async () => {
        const img = dataUrl('image/png', 20_000);
        const content = `<img src="${img}"><p>사이</p><img src="${img}">`;

        const out = await compressInlineImages(content, 15_000, fakeEncoder({ 1600: 0.1 }));

        expect(byteLength(out)).toBeLessThanOrEqual(15_000);
        expect(out.match(/data:image\/jpeg;base64,/g)).toHaveLength(2);
        expect(out).toContain('사이');
    });

    it('인코더가 실패하면 원본을 유지한다', async () => {
        const content = `<img src="${dataUrl('image/png', 30_000)}">`;
        const out = await compressInlineImages(content, 5_000, async () => null);
        expect(out).toBe(content);
    });

    it('재인코딩이 더 커지면 원본을 유지한다', async () => {
        const content = `<img src="${dataUrl('image/png', 30_000)}">`;
        const out = await compressInlineImages(content, 5_000, fakeEncoder({ 1600: 2, 1024: 2, 640: 2 }));
        expect(out).toBe(content);
    });

    it('인라인 이미지가 없으면 원본을 그대로 돌려준다(호출부가 자른다)', async () => {
        const content = '가'.repeat(10_000);
        const out = await compressInlineImages(content, 1_000, fakeEncoder({ 1600: 0.1 }));
        expect(out).toBe(content);
    });

    it('압축해도 부족하면 가장 작은 결과를 돌려준다', async () => {
        const content = `<img src="${dataUrl('image/png', 30_000)}">`;
        const out = await compressInlineImages(content, 100, fakeEncoder({ 1600: 0.5, 1024: 0.3, 640: 0.1 }));

        expect(byteLength(out)).toBeGreaterThan(100);       // 목표엔 못 미치지만
        expect(byteLength(out)).toBeLessThan(byteLength(content)); // 최선은 다했다
    });
});
