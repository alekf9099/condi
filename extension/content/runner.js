/**
 * Condi 확장 — UI 흐름 실행기 (content script).
 *
 * 서비스 워커가 넘겨준 uiFlow를 대상 페이지에서 실행한다.
 * 모든 요소 접근은 명시적 대기를 거치므로 간헐적 실패(flakiness)에 강하다.
 *
 * 주의: 이 스크립트는 executeScript로 반복 주입될 수 있으므로 중복 등록을 막는다.
 */
(() => {
  if (window.__condiRunnerReady) return;
  window.__condiRunnerReady = true;

  // 확장 컨텍스트에서만 메시지를 수신한다.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'CONDI_RUN_FLOW') return false;
      runFlow(msg.flow, msg.baseUrl, msg.defaultTimeout).then(sendResponse);
      return true;
    });
  }

  // 확장 밖(테스트/디버깅)에서도 같은 실행기를 호출할 수 있게 노출한다.
  window.__condiRunFlow = runFlow;

  async function runFlow(flow, baseUrl, defaultTimeout) {
    const results = [];
    for (const step of flow) {
      const label = `${step.action}${step.target ? ` · ${step.target}` : ''}`;
      const timeout = step.timeout ?? defaultTimeout;
      try {
        const detail = await execute(step, baseUrl, timeout);
        results.push({ ok: true, label, detail: detail ?? step.description ?? '' });
      } catch (err) {
        results.push({ ok: false, label, detail: String(err?.message ?? err) });
        break; // 실패 시 이후 단계는 의미가 없으므로 중단
      }
    }
    return results;
  }

  async function execute(step, baseUrl, timeout) {
    switch (step.action) {
      case 'goto': {
        // 같은 문서 안에서의 이동만 처리한다. 전체 네비게이션은 서비스 워커가 담당.
        const url = new URL(step.value ?? '/', baseUrl).toString();
        if (url !== location.href) location.assign(url);
        return url;
      }
      case 'waitForUrl': {
        await waitFor(() => location.href.includes(step.value ?? ''), timeout, `URL에 "${step.value}" 포함`);
        return location.href;
      }
      case 'click': {
        const el = await waitForVisible(step.selector, timeout, step.target);
        el.click();
        return '';
      }
      case 'fill': {
        const el = await waitForVisible(step.selector, timeout, step.target);
        setNativeValue(el, step.value ?? '');
        return `"${step.value ?? ''}" 입력`;
      }
      case 'select': {
        const el = await waitForVisible(step.selector, timeout, step.target);
        setNativeValue(el, step.value ?? '');
        return `"${step.value ?? ''}" 선택`;
      }
      case 'check': {
        const el = await waitForVisible(step.selector, timeout, step.target);
        if (!el.checked) el.click();
        return '';
      }
      case 'expectVisible': {
        await waitForVisible(step.selector, timeout, step.target);
        return '';
      }
      case 'expectHidden': {
        await waitFor(
          () => {
            const el = query(step.selector);
            return !el || !isVisible(el);
          },
          timeout,
          `"${step.target}" 가 보이지 않아야 함`,
        );
        return '';
      }
      case 'expectText': {
        const el = await waitForVisible(step.selector, timeout, step.target);
        await waitFor(
          () => (el.textContent ?? '').includes(step.value ?? ''),
          timeout,
          `"${step.target}" 텍스트에 "${step.value}" 포함`,
        );
        return `"${step.value}" 확인`;
      }
      case 'expectValue': {
        const el = await waitForVisible(step.selector, timeout, step.target);
        await waitFor(() => el.value === step.value, timeout, `"${step.target}" 값이 "${step.value}"`);
        return `"${step.value}" 확인`;
      }
      case 'expectCount': {
        const expected = step.count ?? 0;
        await waitFor(
          () => queryAll(step.selector).length === expected,
          timeout,
          `"${step.target}" 개수가 ${expected}개`,
        );
        return `${expected}개 확인`;
      }
      default:
        throw new Error(`지원하지 않는 액션: ${step.action}`);
    }
  }

  /* ── 셀렉터 유틸 (CSS / xpath= 접두어 지원) ── */

  function query(selector) {
    if (selector.startsWith('xpath=')) {
      const r = document.evaluate(selector.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    }
    return document.querySelector(selector);
  }

  function queryAll(selector) {
    if (selector.startsWith('xpath=')) {
      const r = document.evaluate(selector.slice(6), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
    }
    return Array.from(document.querySelectorAll(selector));
  }

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  /** 요소가 나타나고 보일 때까지 대기 */
  async function waitForVisible(selector, timeout, name) {
    let el = null;
    await waitFor(
      () => {
        el = query(selector);
        return el && isVisible(el);
      },
      timeout,
      `"${name}" 요소가 보일 것 (${selector})`,
    );
    return el;
  }

  /** 조건이 참이 될 때까지 폴링. 실패 시 무엇을 기다렸는지 담아 던진다. */
  function waitFor(predicate, timeout, what) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        let ok = false;
        try {
          ok = predicate();
        } catch {
          ok = false;
        }
        if (ok) return resolve();
        if (Date.now() - started >= timeout) {
          return reject(new Error(`대기 시간 초과 (${timeout}ms) — 조건: ${what}`));
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * React/Vue 등이 value setter를 가로채므로, 네이티브 setter로 값을 넣고
   * input/change 이벤트를 직접 발생시켜 프레임워크 상태와 동기화한다.
   */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
})();
