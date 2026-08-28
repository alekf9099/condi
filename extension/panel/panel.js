/**
 * Condi 확장 — 사이드 패널 UI.
 *
 * 설정 편집 · 조건 오버라이드 · 실행 · 결과 표시 · 셀렉터 수집을 담당한다.
 * 실제 자동화는 서비스 워커(background.js)가 수행하고 여기로 이벤트를 보낸다.
 */
import { validateConfig } from '../lib/template.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'condi.config';

let config = null;

/* ── 탭 전환 ── */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`);
    });
  });
});

/* ── 서비스 워커 이벤트 수신 ──
   최상위 await(스토리지 로드)보다 **먼저** 등록해야 한다.
   그 뒤에 등록하면 패널을 열자마자 도착한 피커 결과가 유실된다. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONDI_EVENT') {
    const e = msg.event;
    if (e.phase === 'start') {
      addLog('info', e.profile, `타겟 ${e.target}`);
    } else if (e.phase === 'done') {
      $('summary').textContent = `통과 ${e.passed} · 실패 ${e.failed}`;
      // uiFlow 가 비어 실행할 것이 없었던 경우를 성공처럼 보이게 두면 안 된다
      if (e.status === 'empty') {
        addLog('skip', '실행할 UI 단계가 없습니다', e.detail);
      } else if (e.detail) {
        addLog('info', '완료', e.detail);
      }
    } else {
      addLog(e.status, e.name, e.detail);
    }
  }
  if (msg?.type === 'CONDI_PICK_RESULT') {
    addPickedSelector(msg.selector, msg.suggestedName, msg.preview).catch((err) =>
      addLog('fail', '셀렉터 추가 실패', String(err?.message ?? err)),
    );
  }
  if (msg?.type === 'CONDI_PICK_CANCELLED') {
    $('pick').textContent = '요소 선택 시작';
  }
  if (msg?.type === 'CONDI_RECORD_STEP') recordStep(msg.step, msg.preview);
  if (msg?.type === 'CONDI_RECORD_AMEND') amendLastFill(msg.value);
  if (msg?.type === 'CONDI_RECORD_ENDED') setRecording(false);
  return false;
});

/* ── 플로우 레코더 ── */
let recording = false;

$('record').addEventListener('click', async () => {
  const tab = await getTargetTab();
  if (!tab?.id) {
    addLog('fail', '대상 탭을 찾을 수 없습니다', '검증할 웹페이지를 연 뒤 다시 시도하세요.');
    return;
  }
  const next = !recording;
  const res = await chrome.runtime.sendMessage({
    type: 'CONDI_RECORD',
    tabId: tab.id,
    on: next,
    stepCount: config?.uiFlow?.length ?? 0,
  });
  if (!res?.ok) {
    addLog('fail', '녹화 시작 실패', res?.error ?? '');
    return;
  }
  setRecording(next);
});

function setRecording(on) {
  recording = on;
  $('record').textContent = on ? '■ 녹화 중지' : '● 녹화 시작';
  $('record').classList.toggle('is-recording', on);
}

/**
 * 레코더가 보낸 단계를 설정에 반영한다.
 * 셀렉터는 selectors 맵에 등록하고, uiFlow 에는 논리 이름만 남긴다.
 */
async function recordStep(step, preview) {
  if (!config) config = await newSkeletonConfig();

  const { selector, ...rest } = step;
  const name = registerSelector(rest.target, selector);
  const uiStep = { ...rest, target: name };
  if (!uiStep.target) delete uiStep.target;

  config.uiFlow = config.uiFlow ?? [];
  config.uiFlow.push(uiStep);
  syncConfig();
  addLog('pass', `${uiStep.action} · ${name}`, preview ?? '');
}

/** 같은 셀렉터면 기존 이름을 재사용하고, 이름만 겹치면 새 이름을 만든다 */
function registerSelector(suggested, selector) {
  config.selectors = config.selectors ?? {};
  const existing = Object.entries(config.selectors).find(([, v]) => v === selector);
  if (existing) return existing[0];

  let name = suggested || 'element';
  let i = 2;
  while (name in config.selectors) name = `${suggested || 'element'}${i++}`;
  config.selectors[name] = selector;
  return name;
}

/** 한 필드에 이어 타이핑한 경우 마지막 fill 단계의 값만 갱신한다 */
function amendLastFill(value) {
  const last = config?.uiFlow?.[config.uiFlow.length - 1];
  if (last?.action !== 'fill') return;
  last.value = value;
  syncConfig();
}

$('clear-flow').addEventListener('click', () => {
  if (!config) return;
  config.uiFlow = [];
  syncConfig();
});

/** 설정 변경을 textarea·저장소·검증·목록에 한꺼번에 반영한다 */
function syncConfig() {
  const text = JSON.stringify(config, null, 2);
  applyConfig(text);
  $('config').value = text;
}

function renderFlow() {
  const list = $('flow-list');
  const steps = config?.uiFlow ?? [];
  $('flow-count').textContent = `${steps.length}단계`;
  $('clear-flow').disabled = !steps.length;
  list.innerHTML = '';
  if (!steps.length) {
    list.innerHTML = '<li class="empty">녹화하거나 설정에서 직접 추가하세요.</li>';
    return;
  }
  for (const step of steps) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.className = 'act';
    a.textContent = step.action;
    li.appendChild(a);
    const t = document.createElement('span');
    t.textContent = [step.target, step.value].filter(Boolean).join(' · ');
    li.appendChild(t);
    if (step.when) {
      const w = document.createElement('em');
      w.textContent = Object.entries(step.when).map(([k, v]) => `${k.split('.').pop()}=${v}`).join(', ');
      li.appendChild(w);
    }
    list.appendChild(li);
  }
}

/* ── 설정 로드/저장 ── */
// 최상위 await 를 쓰면 그 지점에서 모듈 평가가 멈춘다. 멈춘 동안 도착한 메시지는
// 아직 초기화되지 않은 모듈 상수를 건드려 조용히 실패한다(TDZ).
// 저장된 설정 로드는 부수 작업이므로 평가를 막지 않도록 비동기로 떼어낸다.
void (async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  // 그 사이 피커로 설정이 이미 생겼다면 덮어쓰지 않는다
  if (stored[STORAGE_KEY] && !config) {
    $('config').value = stored[STORAGE_KEY];
    applyConfig(stored[STORAGE_KEY]);
  }
})();

$('config').addEventListener('input', (e) => applyConfig(e.target.value));

$('new-config').addEventListener('click', async () => {
  const skeleton = await newSkeletonConfig();
  applyConfig(JSON.stringify(skeleton, null, 2));
  $('config').value = JSON.stringify(skeleton, null, 2);
});

$('load-file').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  $('config').value = text;
  applyConfig(text);
});

$('format').addEventListener('click', () => {
  if (!config) return;
  const text = JSON.stringify(config, null, 2);
  $('config').value = text;
  applyConfig(text);
});

$('download').addEventListener('click', () => {
  if (!config) return;
  // downloads 권한을 요구하지 않도록 앵커 클릭으로 저장한다.
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.profileName ?? 'test-config'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function applyConfig(text) {
  const status = $('config-status');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    config = null;
    status.className = 'status err';
    status.textContent = `JSON 파싱 실패: ${err.message}`;
    setReady(false);
    return;
  }

  const problems = validateConfig(parsed);
  if (problems.length) {
    config = null;
    status.className = 'status err';
    status.textContent = `설정 검증 실패:\n- ${problems.join('\n- ')}`;
    setReady(false);
    return;
  }

  config = parsed;
  chrome.storage.local.set({ [STORAGE_KEY]: text });
  status.className = 'status ok';
  status.textContent = `유효한 설정 — 셀렉터 ${Object.keys(config.selectors).length}개, UI 단계 ${config.uiFlow?.length ?? 0}개`;
  $('target').textContent = `${config.profileName ?? ''} · ${config.target.baseUrl}`;
  renderConditions();
  renderSelectors();
  renderFlow();
  renderMatrixFields();
  setReady(true);
}

function setReady(ready) {
  $('run').disabled = !ready;
  $('record').disabled = !ready && !config;
  $('run-matrix').disabled = !ready;
}

/* ── 조건 오버라이드 ── */
function renderConditions() {
  const box = $('condition-fields');
  box.innerHTML = '';
  const entries = Object.entries(config.conditions);
  if (!entries.length) {
    box.innerHTML = '<p class="empty">조건이 정의되지 않았습니다.</p>';
    return;
  }
  for (const [key, value] of entries) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `cond-${key}`;

    let input;
    if (typeof value === 'boolean') {
      input = document.createElement('select');
      for (const v of ['true', 'false']) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        opt.selected = String(value) === v;
        input.appendChild(opt);
      }
    } else {
      input = document.createElement('input');
      input.value = String(value);
    }
    input.id = `cond-${key}`;
    input.addEventListener('change', () => {
      config.conditions[key] = coerce(input.value, value);
      $('config').value = JSON.stringify(config, null, 2);
      chrome.storage.local.set({ [STORAGE_KEY]: $('config').value });
    });

    wrap.append(label, input);
    box.appendChild(wrap);
  }
}

/** 원래 타입을 보존하며 문자열 입력을 변환 */
function coerce(raw, original) {
  if (typeof original === 'boolean') return raw === 'true';
  if (typeof original === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

/* ── 실행 ── */
$('run').addEventListener('click', async () => {
  const tab = await getTargetTab();
  if (!tab?.id) {
    addLog('fail', '대상 탭을 찾을 수 없습니다', '검증할 웹페이지를 연 뒤 다시 실행하세요.');
    return;
  }

  $('log').innerHTML = '';
  $('summary').textContent = '';
  $('run').disabled = true;
  $('run').classList.add('is-running');
  $('run').textContent = '실행 중…';

  const res = await chrome.runtime.sendMessage({ type: 'CONDI_RUN', config, tabId: tab.id });

  $('run').disabled = false;
  $('run').classList.remove('is-running');
  $('run').textContent = '실행';
  if (!res?.ok) addLog('fail', '실행 중단', res?.error ?? '알 수 없는 오류');
});

function addLog(status, name, detail) {
  const li = document.createElement('li');
  li.className = status ?? 'info';
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;
  li.appendChild(n);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = detail;
    li.appendChild(d);
  }
  $('log').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

/* ── 셀렉터 피커 ── */
$('pick').addEventListener('click', async () => {
  const tab = await getTargetTab();
  if (!tab?.id) {
    addLog('fail', '대상 탭을 찾을 수 없습니다', '검증할 웹페이지를 연 뒤 다시 시도하세요.');
    return;
  }
  $('pick').textContent = '페이지에서 요소를 클릭하세요…';
  const res = await chrome.runtime.sendMessage({ type: 'CONDI_PICK', tabId: tab.id });
  if (!res?.ok) {
    $('pick').textContent = '요소 선택 시작';
    addLog('fail', '피커 실행 실패', res?.error ?? '');
  }
});

async function addPickedSelector(selector, suggestedName, preview) {
  $('pick').textContent = '요소 선택 시작';

  // 피커는 설정을 '만들기 위한' 도구다. 설정이 아직 없다고 고른 셀렉터를 버리면
  // 닭과 달걀이 된다. 없으면 현재 탭을 기준으로 최소 설정을 만들어 이어붙인다.
  if (!config) {
    config = await newSkeletonConfig();
    addLog('info', '새 설정을 만들었습니다', `타겟 ${config.target.baseUrl}`);
  }

  let name = suggestedName || 'element';
  let i = 2;
  while (name in config.selectors && config.selectors[name] !== selector) name = `${suggestedName}${i++}`;

  config.selectors[name] = selector;

  // 요소를 고르는 행위의 의도는 대개 "이게 보여야 한다"이다.
  // 셀렉터만 담고 끝내면 실행해도 아무 일이 없어, 고른 의미가 사라진다.
  // 동작(클릭·입력)은 녹화가 담당하고, 여기서는 검증 단계를 만든다.
  config.uiFlow = config.uiFlow ?? [];
  config.uiFlow.push({ action: 'expectVisible', target: name });

  // applyConfig 를 거쳐야 검증 상태·실행 버튼·목록이 한꺼번에 갱신된다.
  applyConfig(JSON.stringify(config, null, 2));
  $('config').value = JSON.stringify(config, null, 2);
  addLog(
    'pass',
    `셀렉터 추가: ${name}`,
    `${selector}${preview ? ` — "${preview}"` : ''}
→ '보임' 검증 단계로 추가됨 (${config.uiFlow.length}단계)`,
  );
}


/**
 * 자동화 대상 탭을 찾는다.
 *
 * 활성 탭이 항상 웹페이지인 것은 아니다. 패널을 별도 탭으로 띄웠거나
 * chrome:// 페이지가 앞에 있으면 활성 탭은 대상이 될 수 없다.
 * 그럴 때는 같은 창에서 가장 최근에 본 http(s) 탭으로 대체한다.
 */
async function getTargetTab() {
  const isWeb = (t) => t?.url && /^https?:/.test(t.url);

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isWeb(active)) return active;

  const webTabs = (await chrome.tabs.query({ currentWindow: true })).filter(isWeb);
  if (!webTabs.length) return null;
  // lastAccessed 가 없는 브라우저를 대비해 탭 순서를 보조 기준으로 쓴다
  return webTabs.sort((a, b) => (b.lastAccessed ?? b.index) - (a.lastAccessed ?? a.index))[0];
}

/** 현재 탭을 기준으로 최소 설정을 만든다 */
async function newSkeletonConfig() {
  const tab = await getTargetTab();
  let baseUrl = 'https://example.com/';
  let host = 'new-profile';
  try {
    if (tab?.url) {
      const u = new URL(tab.url);
      // 사이트 루트가 아니라 '지금 보고 있는 페이지'를 타겟으로 잡아야 한다.
      // 루트로 잡으면 실행할 때마다 요소를 고른 화면을 떠나 버린다.
      baseUrl = u.origin + u.pathname;
      host = u.hostname;
    }
  } catch {
    /* 기본값 사용 */
  }
  return {
    profileName: host,
    target: { baseUrl },
    conditions: { userRole: 'default' },
    selectors: {},
    uiFlow: [],
  };
}

/**
 * 셀렉터 목록.
 *
 * 셀렉터를 모으는 것만으로는 실행할 것이 생기지 않는다. selectors 는 '무엇을 가리키는가'
 * 이고, uiFlow 가 '무엇을 하는가'다. 그래서 각 셀렉터 옆에 흐름 단계를 바로 추가하는
 * 버튼을 둔다. 이게 없으면 셀렉터만 모아 두고 실행했을 때 아무 일도 일어나지 않는다.
 */
const STEP_BUTTONS = [
  { action: 'click', label: '클릭', title: '이 요소를 클릭하는 단계를 추가' },
  { action: 'expectVisible', label: '보임', title: '이 요소가 보여야 한다는 검증을 추가' },
  { action: 'expectHidden', label: '없음', title: '이 요소가 없어야 한다는 검증을 추가' },
];

function renderSelectors() {
  const list = $('selector-list');
  list.innerHTML = '';
  const entries = Object.entries(config?.selectors ?? {});
  if (!entries.length) {
    list.innerHTML = '<li class="empty">설정에 셀렉터가 없습니다.</li>';
    return;
  }
  for (const [name, selector] of entries) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    const c = document.createElement('code');
    c.textContent = selector;

    const actions = document.createElement('div');
    actions.className = 'sel-actions';
    for (const { action, label, title } of STEP_BUTTONS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.dataset.action = action;
      b.dataset.target = name;
      b.addEventListener('click', () => addFlowStep(name, action));
      actions.appendChild(b);
    }

    li.append(n, c, actions);
    list.appendChild(li);
  }
}

/** 셀렉터 하나에 대해 uiFlow 단계를 덧붙인다 */
function addFlowStep(target, action) {
  if (!config) return;
  config.uiFlow = config.uiFlow ?? [];
  config.uiFlow.push({ action, target });
  syncConfig();
  addLog('pass', `단계 추가: ${action} · ${target}`, `UI 흐름 ${config.uiFlow.length}단계`);
}

/* ── 조건 매트릭스 실행 ──
   Condi의 전제는 "조건이 바뀌면 검증도 바뀐다"인데, 지금까지는 한 조건씩만 돌 수 있었다.
   여기서는 조건값의 모든 조합을 차례로 실행하고 결과를 격자로 보여준다. */

function renderMatrixFields() {
  const box = $('matrix-fields');
  box.innerHTML = '';
  const entries = Object.entries(config?.conditions ?? {});
  if (!entries.length) {
    box.innerHTML = '<p class="empty">조건이 정의되지 않았습니다.</p>';
    return;
  }
  for (const [key, value] of entries) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `mx-${key}`;
    const input = document.createElement('input');
    input.id = `mx-${key}`;
    input.dataset.key = key;
    input.value = String(value);
    input.placeholder = 'admin, member';
    wrap.append(label, input);
    box.appendChild(wrap);
  }
}

/** 입력된 값들로 조건 조합(데카르트 곱)을 만든다 */
function buildCombinations() {
  const axes = [...$('matrix-fields').querySelectorAll('input')].map((input) => ({
    key: input.dataset.key,
    values: input.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => coerce(v, config.conditions[input.dataset.key])),
  }));

  let combos = [{}];
  for (const axis of axes) {
    if (!axis.values.length) continue;
    combos = combos.flatMap((c) => axis.values.map((v) => ({ ...c, [axis.key]: v })));
  }
  return { combos, varied: axes.filter((a) => a.values.length > 1) };
}

$('run-matrix').addEventListener('click', async () => {
  if (!config) return;
  const tab = await getTargetTab();
  if (!tab?.id) {
    $('matrix-progress').className = 'status err';
    $('matrix-progress').textContent = '대상 탭을 찾을 수 없습니다. 검증할 웹페이지를 연 뒤 다시 실행하세요.';
    return;
  }

  const { combos, varied } = buildCombinations();
  const btn = $('run-matrix');
  btn.disabled = true;
  $('matrix-result').innerHTML = '';

  const results = [];
  const original = config.conditions;
  try {
    for (const [i, conditions] of combos.entries()) {
      $('matrix-progress').className = 'status';
      $('matrix-progress').textContent = `${i + 1}/${combos.length} 실행 중 — ${describeCombo(conditions)}`;

      const res = await chrome.runtime.sendMessage({
        type: 'CONDI_RUN',
        config: { ...config, conditions },
        tabId: tab.id,
      });

      const steps = res?.result?.steps ?? [];
      results.push({
        conditions,
        ok: Boolean(res?.ok) && steps.every((s) => s.ok),
        passed: steps.filter((s) => s.ok).length,
        total: steps.length,
        error: res?.ok ? null : res?.error,
      });
    }
  } finally {
    config.conditions = original;
    btn.disabled = false;
  }

  const failed = results.filter((r) => !r.ok).length;
  $('matrix-progress').className = failed ? 'status err' : 'status ok';
  $('matrix-progress').textContent = `${results.length}개 조합 · 통과 ${results.length - failed} · 실패 ${failed}`;
  renderMatrixResult(results, varied);
});

const describeCombo = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' · ');

function renderMatrixResult(results, varied) {
  const box = $('matrix-result');
  box.innerHTML = '';

  // 두 축이 변할 때만 격자가 의미 있다. 그 외에는 목록으로 보여준다.
  if (varied.length === 2) {
    const [rowAxis, colAxis] = varied;
    const table = document.createElement('table');
    table.className = 'matrix';

    const head = table.insertRow();
    head.insertCell().textContent = `${rowAxis.key} \ ${colAxis.key}`;
    for (const col of colAxis.values) head.insertCell().textContent = String(col);

    for (const row of rowAxis.values) {
      const tr = table.insertRow();
      tr.insertCell().textContent = String(row);
      for (const col of colAxis.values) {
        const r = results.find(
          (x) => x.conditions[rowAxis.key] === row && x.conditions[colAxis.key] === col,
        );
        const cell = tr.insertCell();
        cell.className = r?.ok ? 'ok' : 'ng';
        cell.textContent = r ? `${r.ok ? '✓' : '✕'} ${r.passed}/${r.total}` : '–';
        if (r?.error) cell.title = r.error;
      }
    }
    box.appendChild(table);
    return;
  }

  const list = document.createElement('ol');
  list.className = 'log';
  for (const r of results) {
    const li = document.createElement('li');
    li.className = r.ok ? 'pass' : 'fail';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = describeCombo(r.conditions);
    li.appendChild(n);
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = r.error ?? `${r.passed}/${r.total} 단계 통과`;
    li.appendChild(d);
    list.appendChild(li);
  }
  box.appendChild(list);
}
