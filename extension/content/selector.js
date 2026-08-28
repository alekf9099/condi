/**
 * Condi — 셀렉터 생성 (content script 공유 모듈).
 *
 * 피커(요소를 골라 담기)와 레코더(동작을 받아적기)가 같은 규칙으로 셀렉터를 뽑아야
 * 한 설정 안에서 이름과 셀렉터가 어긋나지 않는다. 그래서 한 파일로 둔다.
 *
 * content script 는 ESM import 를 쓸 수 없어, executeScript 로 이 파일을 먼저 주입한 뒤
 * window.__condiSelector 로 공유한다.
 */
(() => {
  if (window.__condiSelector) return;

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  /** 가능한 한 짧고 안정적인 셀렉터를 만든다 */
  function buildSelector(el) {
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
    if (testId) return `[data-testid="${testId}"]`;

    if (el.id && !/^\d/.test(el.id) && isUnique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;

    const name = el.getAttribute('name');
    if (name && isUnique(`[name="${name}"]`)) return `[name="${name}"]`;

    const aria = el.getAttribute('aria-label');
    if (aria && isUnique(`[aria-label="${aria}"]`)) return `[aria-label="${aria}"]`;

    // 조상을 거슬러 올라가며 고유해질 때까지 경로를 쌓는다
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const cls = Array.from(node.classList)
        .filter((c) => !/^(ng|is|has)-|^\w*\d{3,}/.test(c)) // 동적 생성으로 보이는 클래스 제외
        .slice(0, 2);
      if (cls.length) part += `.${cls.map((c) => CSS.escape(c)).join('.')}`;

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }

      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      node = parent;
    }
    return parts.join(' > ');
  }

  /** 논리 이름 후보를 만들어 준다 (camelCase) */
  function suggestName(el) {
    // 빈 문자열도 '없음'으로 취급해야 한다. el.id 는 없을 때 null 이 아니라 '' 이므로
    // ?? 를 쓰면 뒤 후보로 넘어가지 않는다.
    const raw =
      [
        el.getAttribute('data-testid'),
        el.getAttribute('name'),
        el.getAttribute('aria-label'),
        el.id,
        (el.textContent ?? '').trim().slice(0, 20),
      ].find((v) => v && String(v).trim()) ?? el.tagName.toLowerCase();

    const words = String(raw)
      .replace(/[^a-zA-Z0-9가-힣\s_-]/g, '')
      .split(/[\s_-]+/)
      .filter(Boolean);
    if (!words.length) return el.tagName.toLowerCase();
    return words
      .map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w[0].toUpperCase() + w.slice(1)))
      .join('');
  }

  window.__condiSelector = { buildSelector, suggestName, isUnique };

  // 기존 테스트/디버깅 경로 호환
  window.__condiBuildSelector = buildSelector;
  window.__condiSuggestName = suggestName;
})();
