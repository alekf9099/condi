/**
 * core/template.js 를 확장의 lib/ 로 복사한다.
 *
 * 확장은 프로젝트 밖 파일을 import 할 수 없어 사본이 필요하다.
 * 두 벌이 갈라지면 Playwright 러너와 확장의 동작이 달라지므로,
 * --check 모드로 CI가 동기화 상태를 검사한다.
 *
 *   node scripts/sync-extension.mjs          복사
 *   node scripts/sync-extension.mjs --check  차이 있으면 실패
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'core', 'template.js');
const dest = path.join(root, 'extension', 'lib', 'template.js');

const banner =
  '/* 자동 생성 파일 — 직접 수정하지 마세요.\n' +
  '   원본: core/template.js · 갱신: npm run sync:ext */\n\n';

const expected = banner + fs.readFileSync(src, 'utf-8');

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : '';
  if (actual !== expected) {
    console.error('[condi] extension/lib/template.js 가 core/template.js 와 다릅니다.');
    console.error('        `npm run sync:ext` 를 실행하고 결과를 커밋하세요.');
    process.exit(1);
  }
  console.log('[condi] 확장 공유 모듈 동기화 확인됨');
} else {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, expected, 'utf-8');
  console.log('[condi] extension/lib/template.js 갱신 완료');
}
