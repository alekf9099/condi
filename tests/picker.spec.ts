import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 셀렉터 피커 검증.
 *
 * 피커가 뽑는 셀렉터가 실제로 그 요소를 다시 찾아내는지, 그리고 유일한지가 핵심이다.
 * 여기가 틀리면 설정에 잘못된 셀렉터가 쌓여 나중에 원인 찾기가 어려워진다.
 */

const PICKER = fs.readFileSync(
  path.resolve(__dirname, '..', 'extension', 'content', 'picker.js'),
  'utf-8',
);

const FIXTURE = `
  <div data-testid="save-button">저장</div>
  <button id="submitForm">보내기</button>
  <input name="userEmail">
  <a aria-label="장바구니 열기" href="#">🛒</a>
  <ul class="menu">
    <li>첫째</li>
    <li>둘째</li>
    <li>셋째</li>
  </ul>
  <section><div><span class="deep">깊은 요소</span></div></section>
  <p>이름 없는 문단</p>
`;

async function setup(page: Page) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${FIXTURE}</body>`);
  await page.addScriptTag({ content: PICKER });
}

/** 특정 요소를 피커에 넣어 셀렉터와 이름 후보를 얻는다 */
async function pick(page: Page, cssToLocate: string) {
  return page.evaluate((css) => {
    const el = document.querySelector(css)!;
    const w = window as unknown as {
      __condiBuildSelector: (e: Element) => string;
      __condiSuggestName: (e: Element) => string;
    };
    const selector = w.__condiBuildSelector(el);
    // 뽑은 셀렉터가 같은 요소를 실제로 다시 찾아내는지 확인
    const found = document.querySelectorAll(selector);
    return {
      selector,
      name: w.__condiSuggestName(el),
      matchCount: found.length,
      resolvesToSameElement: found[0] === el,
    };
  }, cssToLocate);
}

test.describe('셀렉터 피커', () => {
  test('data-testid를 최우선으로 쓴다', async ({ page }) => {
    await setup(page);
    const r = await pick(page, '[data-testid="save-button"]');
    expect(r.selector).toBe('[data-testid="save-button"]');
    expect(r.name).toBe('saveButton');
  });

  test('id가 있으면 id를 쓴다', async ({ page }) => {
    await setup(page);
    const r = await pick(page, '#submitForm');
    expect(r.selector).toBe('#submitForm');
    expect(r.name).toBe('submitForm');
  });

  test('name 속성을 쓴다', async ({ page }) => {
    await setup(page);
    const r = await pick(page, '[name="userEmail"]');
    expect(r.selector).toBe('[name="userEmail"]');
    expect(r.name).toBe('userEmail');
  });

  test('aria-label을 쓴다', async ({ page }) => {
    await setup(page);
    const r = await pick(page, 'a[aria-label]');
    expect(r.selector).toBe('[aria-label="장바구니 열기"]');
  });

  test('식별자가 없으면 유일한 CSS 경로를 만든다', async ({ page }) => {
    await setup(page);
    const r = await pick(page, '.deep');
    expect(r.matchCount, `선택자가 유일하지 않음: ${r.selector}`).toBe(1);
    expect(r.resolvesToSameElement).toBe(true);
  });

  test('형제가 여럿이면 nth-of-type으로 구분한다', async ({ page }) => {
    await setup(page);
    const second = await pick(page, '.menu li:nth-child(2)');
    expect(second.matchCount, `선택자가 유일하지 않음: ${second.selector}`).toBe(1);
    expect(second.resolvesToSameElement).toBe(true);
    expect(second.selector).toContain('nth-of-type(2)');
  });

  test('속성이 없는 요소는 텍스트로 이름을 만든다', async ({ page }) => {
    await setup(page);
    // el.id 가 빈 문자열이라 ?? 로는 걸러지지 않던 회귀를 막는다
    const r = await pick(page, 'p');
    expect(r.name).not.toBe('p');
    expect(r.name).toContain('이름');
  });

  test('뽑은 셀렉터는 모두 유일하게 해석된다', async ({ page }) => {
    await setup(page);
    for (const css of ['[data-testid="save-button"]', '#submitForm', '[name="userEmail"]', '.deep', 'p']) {
      const r = await pick(page, css);
      expect(r.matchCount, `${css} → ${r.selector} 가 ${r.matchCount}개 매치`).toBe(1);
      expect(r.resolvesToSameElement, `${css} → ${r.selector}`).toBe(true);
    }
  });
});
