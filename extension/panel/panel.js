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

/* ── 설정 로드/저장 ── */
const stored = await chrome.storage.local.get(STORAGE_KEY);
if (stored[STORAGE_KEY]) {
  $('config').value = stored[STORAGE_KEY];
  applyConfig(stored[STORAGE_KEY]);
}

$('config').addEventListener('input', (e) => applyConfig(e.target.value));

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
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  chrome.downloads
    ? chrome.downloads.download({ url, filename: 'test-config.json' })
    : window.open(url);
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
  setReady(true);
}

function setReady(ready) {
  $('run').disabled = !ready;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

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

/* ── 서비스 워커 이벤트 수신 ── */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'CONDI_EVENT') {
    const e = msg.event;
    if (e.phase === 'start') {
      addLog('info', e.profile, `타겟 ${e.target}`);
    } else if (e.phase === 'done') {
      $('summary').textContent = `통과 ${e.passed} · 실패 ${e.failed}`;
      if (e.detail) addLog('info', '완료', e.detail);
    } else {
      addLog(e.status, e.name, e.detail);
    }
  }
  if (msg?.type === 'CONDI_PICK_RESULT') {
    addPickedSelector(msg.selector, msg.suggestedName, msg.preview);
  }
  if (msg?.type === 'CONDI_PICK_CANCELLED') {
    $('pick').textContent = '요소 선택 시작';
  }
  return false;
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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  $('pick').textContent = '페이지에서 요소를 클릭하세요…';
  const res = await chrome.runtime.sendMessage({ type: 'CONDI_PICK', tabId: tab.id });
  if (!res?.ok) {
    $('pick').textContent = '요소 선택 시작';
    addLog('fail', '피커 실행 실패', res?.error ?? '');
  }
});

function addPickedSelector(selector, suggestedName, preview) {
  $('pick').textContent = '요소 선택 시작';
  if (!config) return;

  let name = suggestedName || 'element';
  let i = 2;
  while (name in config.selectors && config.selectors[name] !== selector) name = `${suggestedName}${i++}`;

  config.selectors[name] = selector;
  $('config').value = JSON.stringify(config, null, 2);
  chrome.storage.local.set({ [STORAGE_KEY]: $('config').value });
  renderSelectors();
  addLog('pass', `셀렉터 추가: ${name}`, `${selector}${preview ? ` — "${preview}"` : ''}`);
}

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
    li.append(n, c);
    list.appendChild(li);
  }
}
