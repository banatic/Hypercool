// Firestore 문서 크기(UTF-8 1,048,576 바이트) 안에 본문을 밀어 넣기 위한 유틸.
//
// 한도를 넘는 메시지는 거의 예외 없이 본문에 인라인 base64 이미지가 박혀 있는 경우다.
// 글자를 잘라 버리면 이미지 뒤의 본문까지 통째로 날아가므로, 먼저 이미지를 축소·재인코딩해
// 용량을 줄이고, 그래도 안 되면 그때 글자를 자른다.

const encoder = new TextEncoder();

export function byteLength(s: string): number {
    return encoder.encode(s).length;
}

// UTF-8 기준 maxBytes 이하가 되도록 자른다(서로게이트 쌍은 깨뜨리지 않는다).
export function truncateToBytes(s: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    if (byteLength(s) <= maxBytes) return s;

    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
        else hi = mid - 1;
    }

    let cut = lo;
    // 대리 쌍(이모지 등) 중간에서 끊겼으면 한 칸 물러난다.
    if (cut > 0 && cut < s.length) {
        const code = s.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    return s.slice(0, cut);
}

// ── 인라인 이미지 재압축 ────────────────────────────────────────────────

// mcp_server.rs::extract_inline_images 와 같은 패턴.
// 문자 클래스에 따옴표·꺾쇠가 없으므로 속성값 끝에서 자연히 멈춘다.
const DATA_URL_RE = /data:(image\/[^;"'\s]{1,30});base64,([A-Za-z0-9+/\r\n\s=]{40,})/g;

export interface ShrinkTier {
    /** 긴 변의 최대 길이(px) */
    maxDim: number;
    /** JPEG 품질 (0~1) */
    quality: number;
}

// 위에서부터 시도한다. 앞 단계로 한도에 들어가면 더 망가뜨리지 않는다.
const TIERS: ShrinkTier[] = [
    { maxDim: 1600, quality: 0.72 },
    { maxDim: 1024, quality: 0.6 },
    { maxDim: 640, quality: 0.5 },
];

/** 이미지 바이트를 받아 축소·재인코딩한 바이트를 돌려준다. 실패하면 null. */
export type ImageEncoder = (
    bytes: Uint8Array,
    mime: string,
    tier: ShrinkTier,
) => Promise<{ bytes: Uint8Array; mime: string } | null>;

function decodeBase64(b64: string): Uint8Array | null {
    try {
        const binary = atob(b64.replace(/\s/g, ""));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

function encodeBase64(bytes: Uint8Array): string {
    // btoa 에 큰 배열을 한 번에 펼치면 인자 개수 한도로 터진다 → 청크 단위로 처리.
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Canvas 기반 기본 인코더.
 *
 * JPEG 로 통일한다 — 스크린샷·사진이 대부분이라 압축률이 압도적이고, 여기까지 왔다는 건
 * 이미 한도를 넘겨 잘려 나갈 운명이었다는 뜻이다. 투명 배경은 흰색으로 채운다.
 * (애니메이션 GIF 는 첫 프레임만 남는다.)
 */
const canvasEncoder: ImageEncoder = async (bytes, mime, tier) => {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
        return null; // 테스트(jsdom) 등 캔버스가 없는 환경
    }
    try {
        // Uint8Array 를 그대로 넘기면 SharedArrayBuffer 파생 여부에 따라 타입이 안 맞을 수 있다.
        const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }));
        const scale = Math.min(1, tier.maxDim / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            bitmap.close();
            return null;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: tier.quality });
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
    } catch (e) {
        console.warn("Inline image re-encode failed; leaving original.", e);
        return null;
    }
};

/**
 * content 안의 인라인 base64 이미지를 점진적으로 축소해 targetBytes 이하로 맞춘다.
 *
 * 한도에 들어가는 즉시 멈추므로, 살짝 넘긴 문서는 살짝만 압축된다.
 * 이미지가 없거나 캔버스를 쓸 수 없으면 원본을 그대로 돌려준다(호출부가 잘라 낸다).
 */
export async function compressInlineImages(
    content: string,
    targetBytes: number,
    encode: ImageEncoder = canvasEncoder,
): Promise<string> {
    if (byteLength(content) <= targetBytes) return content;

    const matches = [...content.matchAll(DATA_URL_RE)];
    if (matches.length === 0) return content;

    // 원본 바이트는 티어마다 다시 디코딩하지 않고 한 번만 풀어 둔다.
    const sources = matches.map(m => ({
        start: m.index!,
        end: m.index! + m[0].length,
        mime: m[1],
        original: m[0],
        bytes: decodeBase64(m[2]),
    }));

    let best = content;

    for (const tier of TIERS) {
        const replacements: string[] = [];
        for (const src of sources) {
            if (!src.bytes) {
                replacements.push(src.original);
                continue;
            }
            const result = await encode(src.bytes, src.mime, tier);
            // 재인코딩이 실패했거나 오히려 커졌으면 원본을 유지한다.
            if (!result || result.bytes.length >= src.bytes.length) {
                replacements.push(src.original);
                continue;
            }
            replacements.push(`data:${result.mime};base64,${encodeBase64(result.bytes)}`);
        }

        let rebuilt = "";
        let cursor = 0;
        sources.forEach((src, i) => {
            rebuilt += content.slice(cursor, src.start) + replacements[i];
            cursor = src.end;
        });
        rebuilt += content.slice(cursor);

        if (byteLength(rebuilt) < byteLength(best)) best = rebuilt;
        if (byteLength(rebuilt) <= targetBytes) return rebuilt;
    }

    return best;
}
