/**
 * Condi 확장 — 셀렉터 피커 (content script).
 *
 * 대상 페이지에서 요소를 클릭하면 안정적인 셀렉터를 생성해 패널로 보낸다.
 * config의 selectors 맵을 손으로 적지 않아도 되게 하는 것이 목적.
 *
 * 셀렉터 생성 규칙은 content/selector.js 를 공유한다 (레코더와 동일 규칙 유지).
 */
(() => {
  if (window.__condiPickerReady) return;
  window.__condiPickerReady = true;

  const { buildSelector, suggestName } = window.__condiSelector;

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
})();
