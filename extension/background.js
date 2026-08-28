/**
 * Condi 확장 — 서비스 워커 (오케스트레이터).
 *
 * 실행 순서는 Playwright 러너와 동일한 계약을 따른다.
 *   1. config 검증
 *   2. API 선행 세팅 (apiSetup.steps) → vars 적재
 *   3. 산출물 주입 (쿠키 / localStorage / sessionStorage / 요청 헤더)
 *   4. target.baseUrl 로 이동 후 uiFlow 실행
 *
 * 패널로는 진행 상황을 이벤트로 흘려보낸다.
 */
import { matchesWhen, resolveDeep, resolveTemplate, getByPath, validateConfig, resolveInjection } from './lib/template.js';

const DNR_RULE_ID_BASE = 9000;

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'CONDI_RUN') {
    run(msg.config, msg.tabId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true; // 비동기 응답
  }
  if (msg?.type === 'CONDI_PICK') {
    startPicker(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  if (msg?.type === 'CONDI_RECORD') {
    toggleRecorder(msg.tabId, msg.on, msg.stepCount)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  return false;
});

/** 패널로 진행 이벤트 전송 (패널이 닫혀 있으면 조용히 무시) */
function emit(event) {
  chrome.runtime.sendMessage({ type: 'CONDI_EVENT', event }).catch(() => {});
}

async function run(config, tabId) {
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`설정 검증 실패:\n- ${problems.join('\n- ')}`);

  const vars = {};
  const ctx = () => ({ conditions: config.conditions, vars, env: {} });

  emit({ phase: 'start', profile: config.profileName ?? '(이름 없음)', target: config.target.baseUrl });

  // ── 1. API 선행 세팅 ──
  for (const step of config.apiSetup?.steps ?? []) {
    if (!matchesWhen(step.when, ctx())) {
      emit({ phase: 'api', status: 'skip', name: step.name, detail: 'when 조건 불일치' });
      continue;
    }
    try {
      await runApiStep(step, config, vars, ctx());
      emit({ phase: 'api', status: 'pass', name: step.name, detail: `${step.request.method} ${step.request.path}` });
    } catch (err) {
      emit({ phase: 'api', status: 'fail', name: step.name, detail: String(err?.message ?? err) });
      throw err;
    }
  }

  // ── 2. 주입 ──
  // 건너뛴 API 스텝의 변수를 참조하는 항목은 주입할 값이 없으므로 항목 단위로 떨어뜨린다.
  let injection = null;
  if (config.injection) {
    const resolved = resolveInjection(config.injection, ctx());
    injection = resolved.injection;
    if (resolved.dropped.length) {
      emit({ phase: 'inject', status: 'skip', name: `${resolved.dropped.length}개 주입 항목`,
             detail: `값이 없어 건너뜀: ${resolved.dropped.join(', ')}` });
    }
    await applyCookies(injection, config.target.baseUrl);
    await applyHeaders(injection, config.target.baseUrl);
    emit({ phase: 'inject', status: 'pass', name: '쿠키/헤더 주입', detail: summarizeInjection(injection) });
  }

  // ── 3. 이동 + 스토리지 주입 + 재로드 ──
  await navigate(tabId, config.target.baseUrl, config.waits?.navigationTimeout ?? 30000);

  // 선언된 키는 이 실행의 결과로 '덮어써야' 한다. 값이 없어 떨어진 키를 그냥 두면
  // 직전 실행(특히 매트릭스의 앞 조합)이 남긴 값이 살아남아 오탐을 만든다.
  const declaredLs = Object.keys(config.injection?.localStorage ?? {});
  const declaredSs = Object.keys(config.injection?.sessionStorage ?? {});
  if (declaredLs.length || declaredSs.length) {
    const setLs = injection?.localStorage ?? {};
    const setSs = injection?.sessionStorage ?? {};
    const clearLs = declaredLs.filter((k) => !(k in setLs));
    const clearSs = declaredSs.filter((k) => !(k in setSs));

    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ls, ss, delLs, delSs) => {
        for (const k of delLs) localStorage.removeItem(k);
        for (const k of delSs) sessionStorage.removeItem(k);
        for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(ss)) sessionStorage.setItem(k, v);
      },
      args: [setLs, setSs, clearLs, clearSs],
    });
    // 앱이 스토리지를 읽도록 다시 로드
    await navigate(tabId, null, config.waits?.navigationTimeout ?? 30000);
    emit({
      phase: 'inject',
      status: 'pass',
      name: '스토리지 주입',
      detail: clearLs.length || clearSs.length
        ? `주입 후 재로드 · 이전 값 제거: ${[...clearLs, ...clearSs].join(', ')}`
        : '주입 후 재로드 완료',
    });
  }

  // ── 4. UI 흐름 실행 ──
  if (!config.uiFlow?.length) {
    emit({ phase: 'done', passed: 0, failed: 0, detail: 'uiFlow가 비어 있어 UI 단계를 건너뜁니다' });
    return { vars, steps: [] };
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/runner.js'] });

  const resolvedFlow = config.uiFlow
    .filter((step) => matchesWhen(step.when, ctx()))
    .map((step) => ({
      ...step,
      selector: step.target ? config.selectors[step.target] : undefined,
      value: step.value !== undefined ? resolveTemplate(step.value, ctx()) : undefined,
    }));

  const skipped = config.uiFlow.length - resolvedFlow.length;
  if (skipped > 0) emit({ phase: 'ui', status: 'skip', name: `${skipped}개 단계`, detail: 'when 조건 불일치' });

  const results = await chrome.tabs.sendMessage(tabId, {
    type: 'CONDI_RUN_FLOW',
    flow: resolvedFlow,
    baseUrl: config.target.baseUrl,
    defaultTimeout: config.waits?.elementTimeout ?? 10000,
  });

  for (const r of results) {
    emit({ phase: 'ui', status: r.ok ? 'pass' : 'fail', name: r.label, detail: r.detail });
  }

  const failed = results.filter((r) => !r.ok).length;
  emit({ phase: 'done', passed: results.length - failed, failed });
  return { vars, steps: results };
}

async function runApiStep(step, config, vars, ctx) {
  const base = config.target.apiBaseUrl.replace(/\/$/, '');
  const path = resolveTemplate(step.request.path, ctx);
  const url = new URL(path.startsWith('http') ? path : base + (path.startsWith('/') ? path : `/${path}`));

  for (const [k, v] of Object.entries(resolveDeep(step.request.params ?? {}, ctx))) {
    url.searchParams.set(k, String(v));
  }

  const headers = {
    ...(config.apiSetup?.defaultHeaders ?? {}),
    ...resolveDeep(step.request.headers ?? {}, ctx),
  };
  const body = step.request.body !== undefined ? resolveDeep(step.request.body, ctx) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.waits?.apiTimeout ?? 15000);

  let response;
  try {
    response = await fetch(url.toString(), {
      method: step.request.method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const okByExpectation = step.expectStatus ? response.status === step.expectStatus : response.ok;
  if (!okByExpectation) {
    const text = await response.text().catch(() => '<본문 읽기 실패>');
    throw new Error(`${step.request.method} ${url.pathname} → HTTP ${response.status}\n${text.slice(0, 300)}`);
  }

  if (step.extract) {
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(`extract가 정의됐지만 응답이 JSON이 아닙니다`);
    }
    for (const [varName, pathExpr] of Object.entries(step.extract)) {
      const value = getByPath(json, pathExpr);
      if (value === undefined) throw new Error(`응답에서 "${pathExpr}" 경로를 찾을 수 없습니다 (변수: ${varName})`);
      vars[varName] = value;
    }
  }
}

async function applyCookies(injection, baseUrl) {
  for (const c of injection.cookies ?? []) {
    await chrome.cookies.set({
      url: c.url ?? baseUrl,
      name: c.name,
      value: c.value,
      path: c.path ?? '/',
      ...(c.domain ? { domain: c.domain } : {}),
    });
  }
}

/** extraHTTPHeaders 를 declarativeNetRequest 동적 규칙으로 부착 */
async function applyHeaders(injection, baseUrl) {
  const entries = Object.entries(injection.extraHTTPHeaders ?? {});
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const staleIds = existing.filter((r) => r.id >= DNR_RULE_ID_BASE).map((r) => r.id);

  const addRules = entries.length
    ? [
        {
          id: DNR_RULE_ID_BASE,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: entries.map(([header, value]) => ({ header, operation: 'set', value })),
          },
          condition: { urlFilter: `||${new URL(baseUrl).hostname}`, resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'] },
        },
      ]
    : [];

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: staleIds, addRules });
}

function summarizeInjection(injection) {
  const parts = [];
  if (injection.cookies?.length) parts.push(`쿠키 ${injection.cookies.length}개`);
  if (injection.extraHTTPHeaders) parts.push(`헤더 ${Object.keys(injection.extraHTTPHeaders).length}개`);
  return parts.join(', ') || '없음';
}

/** 탭 이동(또는 재로드) 후 로드 완료까지 대기 */
function navigate(tabId, url, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`페이지 로드 시간 초과 (${timeout}ms)`));
    }, timeout);

    // 이전 로드의 잔여 complete 이벤트로 조기 resolve 되지 않도록,
    // 목적지 URL 이 있으면 실제로 그 주소에 도달했는지 확인한다.
    function listener(updatedTabId, info, tab) {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      if (url && tab?.url && !tab.url.startsWith(stripHash(url))) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);

    (url ? chrome.tabs.update(tabId, { url }) : chrome.tabs.reload(tabId)).catch((err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
}

/** 비교용으로 해시를 떼어낸다 */
function stripHash(url) {
  return url.split('#')[0];
}

async function startPicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/picker.css'] });
  // selector.js 를 먼저 넣어야 picker/recorder 가 같은 규칙을 공유한다
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/selector.js', 'content/picker.js'],
  });
  await chrome.tabs.sendMessage(tabId, { type: 'CONDI_START_PICK' });
}

/** 플로우 레코더 켜기/끄기 */
async function toggleRecorder(tabId, on, stepCount) {
  if (!on) {
    await chrome.tabs.sendMessage(tabId, { type: 'CONDI_RECORD_STOP' }).catch(() => {});
    return;
  }
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/picker.css'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/selector.js', 'content/recorder.js'],
  });
  await chrome.tabs.sendMessage(tabId, { type: 'CONDI_RECORD_START', stepCount: stepCount ?? 0 });
}
