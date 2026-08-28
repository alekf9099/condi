/**
 * Condi 확장 — 플로우 레코더 (content script).
 *
 * 평소처럼 사이트를 조작하면 그 동작을 uiFlow 단계로 받아적는다.
 * 셀렉터 생성은 피커와 같은 규칙(content/selector.js)을 쓰므로,
 * 피커로 모은 셀렉터와 레코더가 만든 셀렉터가 한 설정 안에서 어긋나지 않는다.
 *
 * 두 가지 모드:
 *   - 동작 기록(기본): 클릭·입력·선택·체크를 그대로 단계로 남긴다
 *   - 검증 추가: 클릭한 요소에 대해 expectVisible/expectText 단계를 남긴다
 */
(() => {
  if (window.__condiRecorderReady) return;
  window.__condiRecorderReady = true;

  const { buildSelector, suggestName } = window.__condiSelector;

  let recording = false;
  let assertMode = false;
  let bar = null;
  let count = 0;
  /** 같은 입력 필드의 연속 입력을 하나로 합치기 위한 키 */
  let lastFillKey = null;

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg?.type === 'CONDI_RECORD_START') {
        start(msg.stepCount ?? 0);
        sendResponse({ ok: true });
      }
      if (msg?.type === 'CONDI_RECORD_STOP') {
        stop();
        sendResponse({ ok: true });
      }
      return false;
    });
  }

  function start(startingCount) {
    if (recording) return;
    recording = true;
    count = startingCount;
    lastFillKey = null;
    showBar();
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKey, true);
  }

  function stop() {
    if (!recording) return;
    recording = false;
    assertMode = false;
    bar?.remove();
    bar = null;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKey, true);
  }

  /** 녹화 중임을 알리고 모드를 바꿀 수 있는 떠 있는 막대 */
  function showBar() {
    bar = document.createElement('div');
    bar.className = 'condi-rec-bar';
    bar.innerHTML =
      '<span class="condi-rec-dot"></span>' +
      '<span class="condi-rec-label">녹화 중</span>' +
      '<span class="condi-rec-count">0단계</span>' +
      '<button class="condi-rec-assert" type="button">검증 추가</button>' +
      '<button class="condi-rec-stop" type="button">중지</button>';
    document.documentElement.appendChild(bar);
    updateBar();

    bar.querySelector('.condi-rec-assert').addEventListener('click', (e) => {
      e.stopPropagation();
      assertMode = !assertMode;
      updateBar();
    }, true);

    bar.querySelector('.condi-rec-stop').addEventListener('click', (e) => {
      e.stopPropagation();
      stop();
      chrome.runtime.sendMessage({ type: 'CONDI_RECORD_ENDED' }).catch(() => {});
    }, true);
  }

  function updateBar() {
    if (!bar) return;
    bar.querySelector('.condi-rec-count').textContent = `${count}단계`;
    bar.classList.toggle('is-assert', assertMode);
    bar.querySelector('.condi-rec-label').textContent = assertMode ? '검증 추가 모드' : '녹화 중';
    bar.querySelector('.condi-rec-assert').textContent = assertMode ? '동작 기록으로' : '검증 추가';
  }

  /** 레코더 자신의 UI에서 발생한 이벤트는 기록하지 않는다 */
  const isOwnUi = (el) => !!el?.closest?.('.condi-rec-bar');

  function emit(step, preview) {
    count += 1;
    updateBar();
    chrome.runtime.sendMessage({ type: 'CONDI_RECORD_STEP', step, preview }).catch(() => {});
  }

  /** 요소에서 단계에 필요한 셀렉터·이름을 뽑는다 */
  function describe(el) {
    return { selector: buildSelector(el), name: suggestName(el) };
  }

  function onClick(e) {
    if (!recording) return;
    const el = e.target;
    if (isOwnUi(el)) return;

    if (assertMode) {
      // 검증 추가 모드에서는 클릭이 동작이 아니라 '이게 보여야 함'으로 남는다
      e.preventDefault();
      e.stopPropagation();
      const { selector, name } = describe(el);
      const text = (el.textContent ?? '').trim().slice(0, 30);
      emit(
        text
          ? { action: 'expectText', target: name, value: text, selector }
          : { action: 'expectVisible', target: name, selector },
        text,
      );
      return;
    }

    // 체크박스/라디오는 change 로 기록한다 (클릭과 중복 방지)
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return;
    // 텍스트 입력 클릭은 의미가 없다
    if (el instanceof HTMLInputElement && !['button', 'submit', 'reset'].includes(el.type)) return;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;

    lastFillKey = null;
    const { selector, name } = describe(el);
    emit({ action: 'click', target: name, selector }, (el.textContent ?? '').trim().slice(0, 30));
  }

  function onInput(e) {
    if (!recording || assertMode) return;
    const el = e.target;
    if (isOwnUi(el)) return;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) return;

    const { selector, name } = describe(el);
    // 한 필드에 연속으로 타이핑한 것은 마지막 값 하나로 합친다
    if (lastFillKey === selector) {
      chrome.runtime
        .sendMessage({ type: 'CONDI_RECORD_AMEND', value: el.value })
        .catch(() => {});
      return;
    }
    lastFillKey = selector;
    emit({ action: 'fill', target: name, value: el.value, selector }, el.value);
  }

  function onChange(e) {
    if (!recording || assertMode) return;
    const el = e.target;
    if (isOwnUi(el)) return;

    if (el instanceof HTMLSelectElement) {
      lastFillKey = null;
      const { selector, name } = describe(el);
      emit({ action: 'select', target: name, value: el.value, selector }, el.value);
      return;
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      lastFillKey = null;
      const { selector, name } = describe(el);
      // 체크 해제는 지원 액션이 없으므로 체크된 경우만 남긴다
      if (el.checked) emit({ action: 'check', target: name, selector }, '');
    }
  }

  function onKey(e) {
    if (!recording) return;
    // Esc 로 녹화를 중지한다
    if (e.key === 'Escape') {
      e.preventDefault();
      stop();
      chrome.runtime.sendMessage({ type: 'CONDI_RECORD_ENDED' }).catch(() => {});
    }
  }

  // 테스트/디버깅에서 확장 없이도 구동할 수 있게 노출한다
  window.__condiRecorder = { start, stop, isRecording: () => recording, setAssertMode: (v) => { assertMode = v; updateBar(); } };
})();
