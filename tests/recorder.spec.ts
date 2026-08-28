import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 플로우 레코더 검증.
 *
 * 사이트를 평소처럼 조작했을 때 그것이 올바른 uiFlow 단계로 남는지가 핵심이다.
 * 여기가 틀리면 녹화 결과가 실행되지 않거나 엉뚱한 요소를 건드린다.
 *
 * 확장 없이 content script 만 주입해 검증하므로 빠르고 CI에서 항상 돌아간다.
 */

const read = (f: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'content', f), 'utf-8');
const SELECTOR = read('selector.js');
const RECORDER = read('recorder.js');

const FIXTURE = `
  <button data-testid="save">저장</button>
  <input id="email" type="text">
  <textarea name="memo"></textarea>
  <select id="plan"><option value="free">무료</option><option value="pro">프로</option></select>
  <input id="agree" type="checkbox">
  <p data-testid="notice">확인이 필요합니다</p>
`;

interface Step {
  action: string;
  target?: string;
  value?: string;
  selector?: string;
}

async function setup(page: Page) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${FIXTURE}</body>`);
  // 확장이 없으므로 chrome.runtime 을 가로채 보내진 단계를 모은다
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    (window as any).__steps = [];
    (window as any).chrome = {
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (msg: any) => {
          if (msg.type === 'CONDI_RECORD_STEP') (window as any).__steps.push(msg.step);
          if (msg.type === 'CONDI_RECORD_AMEND') {
            const s = (window as any).__steps;
            if (s.length) s[s.length - 1].value = msg.value;
          }
          return Promise.resolve();
        },
      },
    };
  });
  await page.addScriptTag({ content: SELECTOR });
  await page.addScriptTag({ content: RECORDER });
  await page.evaluate(() => (window as any).__condiRecorder.start(0));
}

const steps = (page: Page) => page.evaluate(() => (window as any).__steps as Step[]);

test.describe('플로우 레코더', () => {
  test('버튼 클릭이 click 단계로 남는다', async ({ page }) => {
    await setup(page);
    await page.click('[data-testid="save"]');

    const s = await steps(page);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ action: 'click', target: 'save', selector: '[data-testid="save"]' });
  });

  test('텍스트 입력이 fill 한 단계로 합쳐진다', async ({ page }) => {
    await setup(page);
    // 한 글자마다 단계가 생기면 흐름이 쓸모없어진다
    await page.fill('#email', 'qa@muhayu.com');
    await page.locator('#email').pressSequentially('!');

    const s = await steps(page);
    const fills = s.filter((x) => x.action === 'fill');
    expect(fills, JSON.stringify(s)).toHaveLength(1);
    expect(fills[0].value).toBe('qa@muhayu.com!');
    expect(fills[0].target).toBe('email');
  });

  test('필드를 옮기면 새 fill 단계가 생긴다', async ({ page }) => {
    await setup(page);
    await page.fill('#email', 'a@b.c');
    await page.fill('textarea[name="memo"]', '메모');

    const fills = (await steps(page)).filter((x) => x.action === 'fill');
    expect(fills).toHaveLength(2);
    expect(fills[1].target).toBe('memo');
  });

  test('셀렉트와 체크박스가 각각 select·check로 남는다', async ({ page }) => {
    await setup(page);
    await page.selectOption('#plan', 'pro');
    await page.check('#agree');

    const s = await steps(page);
    expect(s.find((x) => x.action === 'select')).toMatchObject({ target: 'plan', value: 'pro' });
    expect(s.find((x) => x.action === 'check')).toMatchObject({ target: 'agree' });
    // 체크박스 클릭이 click 으로 중복 기록되면 안 된다
    expect(s.filter((x) => x.action === 'click')).toHaveLength(0);
  });

  test('텍스트 입력란 클릭은 단계로 남기지 않는다', async ({ page }) => {
    await setup(page);
    await page.click('#email');
    expect(await steps(page)).toHaveLength(0);
  });

  test('검증 추가 모드에서는 클릭이 검증 단계가 된다', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => (window as any).__condiRecorder.setAssertMode(true));
    await page.click('[data-testid="notice"]');

    const s = await steps(page);
    expect(s).toHaveLength(1);
    expect(s[0].action).toBe('expectText');
    expect(s[0].value).toContain('확인이 필요합니다');
  });

  test('중지하면 더 이상 기록하지 않는다', async ({ page }) => {
    await setup(page);
    await page.click('[data-testid="save"]');
    await page.evaluate(() => (window as any).__condiRecorder.stop());
    await page.click('[data-testid="save"]');

    expect(await steps(page)).toHaveLength(1);
  });

  test('녹화한 셀렉터가 실제로 그 요소를 찾아낸다', async ({ page }) => {
    await setup(page);
    await page.click('[data-testid="save"]');
    await page.selectOption('#plan', 'pro');

    for (const step of await steps(page)) {
      if (!step.selector) continue;
      const count = await page.locator(step.selector).count();
      expect(count, `${step.selector} 가 ${count}개 매치`).toBe(1);
    }
  });
});
