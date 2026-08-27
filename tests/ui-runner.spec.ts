import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 확장의 UI 실행기(extension/content/runner.js) 자체를 검증한다.
 *
 * 로컬 픽스처 페이지만 쓰므로 외부 타겟이 없어도 CI에서 항상 실행 가능하다.
 * 이 테스트가 있어야 확장 코드가 실제로 도는지 보장할 수 있다.
 */

const RUNNER = fs.readFileSync(
  path.resolve(__dirname, '..', 'extension', 'content', 'runner.js'),
  'utf-8',
);
const FIXTURE = 'file://' + path.resolve(__dirname, 'fixtures', 'sample-app.html').replace(/\\/g, '/');

interface StepResult {
  ok: boolean;
  label: string;
  detail: string;
}

/** 픽스처 페이지에 러너를 주입하고 uiFlow를 실행한다 */
async function runFlow(page: import('@playwright/test').Page, flow: unknown[]) {
  await page.goto(FIXTURE);
  await page.addScriptTag({ content: RUNNER });
  return page.evaluate(
    ([f, timeout]) => (window as any).__condiRunFlow(f, location.href, timeout),
    [flow, 3000] as const,
  ) as Promise<StepResult[]>;
}

test.describe('확장 UI 실행기', () => {
  test('보이는 요소 검증과 텍스트 검증이 통과한다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'expectVisible', target: 'welcomeBanner', selector: '[data-testid="welcome-banner"]' },
      { action: 'expectText', target: 'welcomeBanner', selector: '[data-testid="welcome-banner"]', value: '환영합니다' },
    ]);
    expect(results.every((r) => r.ok), JSON.stringify(results, null, 2)).toBe(true);
  });

  test('지연 등장 요소를 명시적 대기로 기다린다', async ({ page }) => {
    // 800ms 뒤에 나타나므로, 대기가 없으면 즉시 실패했을 단계다.
    const results = await runFlow(page, [
      { action: 'expectVisible', target: 'delayed', selector: '#delayed' },
    ]);
    expect(results[0].ok, results[0].detail).toBe(true);
  });

  test('없는 요소는 타임아웃으로 실패하고 이유를 담는다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'expectVisible', target: 'ghost', selector: '#does-not-exist', timeout: 500 },
    ]);
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toContain('대기 시간 초과');
    expect(results[0].detail).toContain('ghost');
  });

  test('클릭 후 요소가 사라지는 것을 expectHidden으로 잡는다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'click', target: 'dismiss', selector: '[data-testid="dismiss"]' },
      { action: 'expectHidden', target: 'dismissable', selector: '[data-testid="dismissable"]' },
    ]);
    expect(results.every((r) => r.ok), JSON.stringify(results, null, 2)).toBe(true);
  });

  test('입력·선택·체크가 반영된다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'fill', target: 'email', selector: '#email', value: 'qa@muhayu.com' },
      { action: 'expectValue', target: 'email', selector: '#email', value: 'qa@muhayu.com' },
      { action: 'select', target: 'plan', selector: '#plan', value: 'pro' },
      { action: 'expectValue', target: 'plan', selector: '#plan', value: 'pro' },
      { action: 'check', target: 'agree', selector: '#agree' },
    ]);
    expect(results.every((r) => r.ok), JSON.stringify(results, null, 2)).toBe(true);
    expect(await page.locator('#agree').isChecked()).toBe(true);
  });

  test('expectCount가 개수를 검증한다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'expectCount', target: 'orderListItem', selector: '.order-list > li', count: 3 },
    ]);
    expect(results[0].ok, results[0].detail).toBe(true);
  });

  test('xpath= 셀렉터도 동작한다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'expectVisible', target: 'byXpath', selector: 'xpath=//div[@data-testid="never"]' },
    ]);
    expect(results[0].ok, results[0].detail).toBe(true);
  });

  test('한 단계가 실패하면 이후 단계를 중단한다', async ({ page }) => {
    const results = await runFlow(page, [
      { action: 'expectVisible', target: 'ghost', selector: '#nope', timeout: 300 },
      { action: 'expectVisible', target: 'welcomeBanner', selector: '[data-testid="welcome-banner"]' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });
});
