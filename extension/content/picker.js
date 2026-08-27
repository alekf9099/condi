/**
 * Condi 확장 — 셀렉터 피커 (content script).
 *
 * 대상 페이지에서 요소를 클릭하면 안정적인 셀렉터를 생성해 패널로 보낸다.
 * config의 selectors 맵을 손으로 적지 않아도 되게 하는 것이 목적.
 *
 * 우선순위: data-testid > id > name > aria-label > 짧은 CSS 경로
 */
(() => {
  if (window.__condiPickerReady) return;
  window.__condiPickerReady = true;

  let active = false;
  let overlay = null;

  // 확장 컨텍스트에서만 메시지를 수신한다.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'CONDI_START_PICK') start();
      if (msg?.type === 'CONDI_STOP_PICK') stop();
      return false;
    });
  }

  // 셀렉터 생성 로직은 순수 DOM 연산이므로 확장 밖에서도 검증할 수 있게 노출한다.
  window.__condiBuildSelector = buildSelector;
  window.__condiSuggestName = suggestName;

  function start() {
    if (active) return;
    active = true;
    overlay = document.createElement('div');
    overlay.className = 'condi-pick-overlay';
    document.body.appendChild(overlay);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function stop() {
    if (!active) return;
    active = false;
    overlay?.remove();
    overlay = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || !overlay) return;
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      top: `${r.top + scrollY}px`,
      left: `${r.left + scrollX}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      stop();
      chrome.runtime.sendMessage({ type: 'CONDI_PICK_CANCELLED' }).catch(() => {});
    }
  }

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const selector = buildSelector(el);
    stop();
    chrome.runtime
      .sendMessage({
        type: 'CONDI_PICK_RESULT',
        selector,
        suggestedName: suggestName(el),
        preview: (el.textContent ?? '').trim().slice(0, 40),
      })
      .catch(() => {});
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

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
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
})();
