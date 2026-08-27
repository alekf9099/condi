/**
 * Vercel 배포용 사이트 빌더.
 *
 * site/ 의 정적 자산을 public/ 으로 옮기면서 두 가지를 주입한다.
 *   1. 확장의 실제 실행기(extension/content/runner.js) — 데모가 진짜 엔진을 돌리도록
 *   2. config/*.json 프로필 요약 — 저장소 상태를 페이지가 반영하도록
 *
 * playwright-report/ 가 있으면 /report/ 로 함께 서빙한다.
 */
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '..');
const siteDir = path.join(root, 'site');
const outDir = path.join(root, 'public');
const configDir = path.join(root, 'config');
const reportDir = path.join(root, 'playwright-report');
const extensionDir = path.join(root, 'extension');
const runnerPath = path.join(extensionDir, 'content', 'runner.js');

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
      conditions: cfg.conditions ?? {},
      selectorCount: Object.keys(cfg.selectors ?? {}).length,
      uiFlowCount: (cfg.uiFlow ?? []).length,
    };
  });

// ── 실행기 주입 ──
// <script type="text/plain"> 안에 넣으므로 </script> 만 깨뜨리지 않으면 된다.
const runner = fs.readFileSync(runnerPath, 'utf-8').replace(/<\/script>/gi, '<\\/script>');

// ── 확장을 ZIP으로 묶어 함께 배포 ──
// 받는 사람이 압축만 풀어 chrome://extensions 에 로드할 수 있게 한다.
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf-8'));
const zipName = `condi-extension-v${manifest.version}.zip`;

const zip = new JSZip();
for (const rel of walk(extensionDir)) {
  zip.file(rel.split(path.sep).join('/'), fs.readFileSync(path.join(extensionDir, rel)));
}
const zipBuffer = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
});
fs.writeFileSync(path.join(outDir, zipName), zipBuffer);
const zipKB = (zipBuffer.length / 1024).toFixed(0);

let html = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf-8');
html = html.replace('<!--CONDI_RUNNER-->', runner);
html = html.replace('/*<!--CONDI_PROFILES-->*/[]', JSON.stringify(profiles));
html = html.replaceAll('{{ZIP_NAME}}', zipName);
html = html.replaceAll('{{ZIP_SIZE}}', `${zipKB}KB`);
html = html.replaceAll('{{VERSION}}', manifest.version);

fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');

/** 디렉토리를 재귀 순회하며 상대 경로 목록을 반환 */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

// ── 나머지 정적 자산 복사 ──
for (const file of fs.readdirSync(siteDir)) {
  if (file === 'index.html') continue;
  fs.cpSync(path.join(siteDir, file), path.join(outDir, file), { recursive: true });
}

// ── 테스트 리포트가 있으면 함께 ──
const hasReport = fs.existsSync(path.join(reportDir, 'index.html'));
if (hasReport) fs.cpSync(reportDir, path.join(outDir, 'report'), { recursive: true });

console.log(
  `[condi] public/ 생성 완료 — 프로필 ${profiles.length}개, 실행기 ${(runner.length / 1024).toFixed(1)}KB, ` +
  `${zipName} ${zipKB}KB, 리포트 ${hasReport ? '포함' : '없음'}`,
);
