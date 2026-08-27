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
import { matchesWhen, resolveDeep, resolveTemplate, getByPath, validateConfig } from './lib/template.js';

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
  const injection = config.injection ? resolveDeep(config.injection, ctx()) : null;
  if (injection) {
    await applyCookies(injection, config.target.baseUrl);
    await applyHeaders(injection, config.target.baseUrl);
    emit({ phase: 'inject', status: 'pass', name: '쿠키/헤더 주입', detail: summarizeInjection(injection) });
  }

  // ── 3. 이동 + 스토리지 주입 + 재로드 ──
  await navigate(tabId, config.target.baseUrl, config.waits?.navigationTimeout ?? 30000);

  if (injection?.localStorage || injection?.sessionStorage) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (ls, ss) => {
        for (const [k, v] of Object.entries(ls ?? {})) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(ss ?? {})) sessionStorage.setItem(k, v);
      },
      args: [injection.localStorage ?? {}, injection.sessionStorage ?? {}],
    });
    // 앱이 스토리지를 읽도록 다시 로드
    await navigate(tabId, null, config.waits?.navigationTimeout ?? 30000);
    emit({ phase: 'inject', status: 'pass', name: '스토리지 주입', detail: '주입 후 재로드 완료' });
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

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    (url ? chrome.tabs.update(tabId, { url }) : chrome.tabs.reload(tabId)).catch((err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
}

async function startPicker(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/picker.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
  await chrome.tabs.sendMessage(tabId, { type: 'CONDI_START_PICK' });
}
