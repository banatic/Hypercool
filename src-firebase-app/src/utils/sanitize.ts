import DOMPurify, { type Config } from 'dompurify';

// 쿨메신저 본문은 신뢰할 수 없는 HTML 이다. 서식·표·인라인 이미지(data:)는 살리고
// 스크립트·프레임·폼처럼 실행되거나 밖으로 나가는 요소는 걷어낸다.
const CONFIG: Config = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcdoc'],
    ADD_ATTR: ['target'],
};

let hooked = false;
function ensureHooks() {
    if (hooked) return;
    hooked = true;
    // 링크는 항상 새 창 + noopener 로 연다.
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.hasAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });
}

export function sanitizeHtml(html: string | null | undefined): string {
    if (!html) return '';
    ensureHooks();
    return String(DOMPurify.sanitize(html, CONFIG));
}
