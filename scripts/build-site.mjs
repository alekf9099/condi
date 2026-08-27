/**
 * Vercel 배포용 정적 사이트 빌더.
 *
 * Condi는 테스트 엔진이라 배포할 웹앱이 없다. 대신 배포할 가치가 있는 두 가지를 낸다.
 *   1. config/*.json 프로필 요약 — 어떤 타겟을 어떤 조건으로 검증하는지 한눈에
 *   2. playwright-report/ — 테스트를 실행했다면 그 HTML 리포트를 함께 서빙
 *
 * 출력: public/
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'public');
const configDir = path.join(root, 'config');
const reportDir = path.join(root, 'playwright-report');

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── 설정 프로필 수집 ──
const profiles = fs
  .readdirSync(configDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, f), 'utf-8'));
    return {
      file: f,
      name: cfg.profileName ?? f.replace(/\.json$/, ''),
      baseUrl: cfg.target?.baseUrl ?? '-',
      apiBaseUrl: cfg.target?.apiBaseUrl ?? '-',
      conditions: cfg.conditions ?? {},
      selectorCount: Object.keys(cfg.selectors ?? {}).length,
      steps: (cfg.apiSetup?.steps ?? []).map((s) => ({
        name: s.name,
        method: s.request?.method ?? '?',
        path: s.request?.path ?? '?',
        conditional: Boolean(s.when),
      })),
    };
  });

// ── 리포트가 있으면 함께 복사 ──
const hasReport = fs.existsSync(path.join(reportDir, 'index.html'));
if (hasReport) {
  fs.cpSync(reportDir, path.join(outDir, 'report'), { recursive: true });
}

const profileCards = profiles
  .map(
    (p) => `
    <article class="card">
      <h3>${esc(p.name)}</h3>
      <p class="file">${esc(p.file)}</p>
      <dl>
        <dt>baseUrl</dt><dd>${esc(p.baseUrl)}</dd>
        <dt>apiBaseUrl</dt><dd>${esc(p.apiBaseUrl)}</dd>
        <dt>selectors</dt><dd>${p.selectorCount}개</dd>
      </dl>
      <h4>conditions</h4>
      <ul class="tags">
        ${Object.entries(p.conditions)
          .map(([k, v]) => `<li><span>${esc(k)}</span>${esc(JSON.stringify(v))}</li>`)
          .join('')}
      </ul>
      ${
        p.steps.length
          ? `<h4>API 선행 세팅</h4><ol class="steps">${p.steps
              .map(
                (s) =>
                  `<li><code>${esc(s.method)} ${esc(s.path)}</code> ${esc(s.name)}${
                    s.conditional ? '<em>조건부</em>' : ''
                  }</li>`,
              )
              .join('')}</ol>`
          : ''
      }
    </article>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Condi — 조건부 테스트 엔진</title>
<style>
  :root {
    --bg: #fbfbfd; --fg: #1a1a1f; --muted: #6b6b78;
    --card: #ffffff; --border: #e4e4ec; --accent: #4f46e5; --code: #f4f4f8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0f14; --fg: #e8e8ef; --muted: #9a9aab;
      --card: #17171f; --border: #2a2a36; --accent: #8b85f5; --code: #1e1e28;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 3rem 1.5rem; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 0 0 .4rem; letter-spacing: -.02em; }
  .lede { color: var(--muted); margin: 0 0 2rem; }
  .grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
  .card h3 { margin: 0 0 .1rem; font-size: 1.05rem; }
  .card h4 { margin: 1.1rem 0 .5rem; font-size: .75rem; text-transform: uppercase;
             letter-spacing: .08em; color: var(--muted); }
  .file { margin: 0; font-size: .8rem; color: var(--muted); font-family: ui-monospace, monospace; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem .9rem; margin: 1rem 0 0; font-size: .87rem; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
  .tags { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .4rem; }
  .tags li { background: var(--code); border-radius: 6px; padding: .2rem .5rem;
             font-size: .8rem; font-family: ui-monospace, monospace; }
  .tags span { color: var(--muted); }
  .tags span::after { content: "="; margin: 0 .15rem; }
  .steps { margin: 0; padding-left: 1.2rem; font-size: .85rem; }
  .steps li { margin-bottom: .35rem; }
  .steps code { background: var(--code); border-radius: 4px; padding: .1rem .35rem; font-size: .8rem; }
  .steps em { color: var(--accent); font-style: normal; font-size: .72rem;
              border: 1px solid var(--accent); border-radius: 4px; padding: 0 .3rem; margin-left: .3rem; }
  .report { display: inline-block; margin-top: 2rem; padding: .7rem 1.2rem; border-radius: 8px;
            background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; font-size: .9rem; }
  .note { margin-top: 2rem; padding: 1rem 1.2rem; border-left: 3px solid var(--border);
          color: var(--muted); font-size: .87rem; }
</style>
</head>
<body>
<main>
  <h1>Condi</h1>
  <p class="lede">설정 파일로 타겟을 바꾸는 범용 조건부 테스트 엔진 — 커밋된 프로필 ${profiles.length}개</p>
  <div class="grid">${profileCards}</div>
  ${
    hasReport
      ? '<a class="report" href="/report/">Playwright 테스트 리포트 보기 →</a>'
      : '<p class="note">이 빌드에는 테스트 리포트가 없습니다. CI에서 <code>npx playwright test</code>를 실행하면 리포트가 <code>/report/</code>로 함께 배포됩니다.</p>'
  }
</main>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
console.log(`[condi] public/ 생성 완료 — 프로필 ${profiles.length}개, 리포트 ${hasReport ? '포함' : '없음'}`);
