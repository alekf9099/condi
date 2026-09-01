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

  /**
   * 고르는 동안 페이지가 반응하면 안 되는 입력들.
   *
   * click 만 막아서는 부족하다. 사이드바 메뉴나 SPA 라우터는 보통 mousedown/pointerdown
   * 에서 이동을 시작하는데, 그건 click 보다 먼저 일어난다. 그래서 요소를 고르려고
   * 누르는 순간 화면이 넘어가 버린다. 선택은 비파괴적이어야 하므로 전부 삼킨다.
   */
  const SWALLOWED = [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'auxclick',
    'dblclick',
    'submit',
    'touchstart',
    'touchend',
  ];

  function swallow(e) {
    if (!active) return;
    if (e.target?.closest?.('.condi-pick-overlay')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
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
    for (const type of SWALLOWED) document.addEventListener(type, swallow, true);
  }

  function stop() {
    if (!active) return;
    active = false;
    overlay?.remove();
    overlay = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    for (const type of SWALLOWED) document.removeEventListener(type, swallow, true);
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

  // 확장 밖(테스트/디버깅)에서도 켜고 끌 수 있게 노출한다
  window.__condiPicker = { start, stop };

  function onClick(e) {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
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
