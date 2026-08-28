import { test as base, expect, chromium, BrowserContext, Worker } from '@playwright/test';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';

/**
 * 확장 전체 파이프라인 E2E.
 *
 * background.js(오케스트레이터)는 확장 컨텍스트 밖에서 실행할 수 없어 지금까지
 * 한 번도 검증되지 않았다. 여기서는 실제 Chromium에 확장을 로드하고,
 * 목 API + 목 타겟 페이지를 띄워 다음 경로를 통째로 확인한다.
 *
 *   apiSetup 실행 → extract → 스토리지 주입 → 이동/재로드 → uiFlow 실행
 */

// 확장 로드와 서비스 워커 기동에 시간이 걸려 기본 타임아웃으로는 부족하다.
base.describe.configure({ timeout: 120_000 });

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

interface MockServer {
  url: string;
  calls: string[];
  close: () => Promise<void>;
}

const APP_HTML = [
  '<!doctype html><meta charset="utf-8"><title>mock app</title><body>',
  '<div id="root"></div>',
  '<script>',
  '  var token = localStorage.getItem("accessToken");',
  '  var order = localStorage.getItem("seededOrderId");',
  '  document.getElementById("root").innerHTML = token',
  '    ? \'<b data-testid="welcome-banner">환영합니다</b>\'',
  '      + \'<span data-testid="admin-dashboard">관리자</span>\'',
  '      + (order ? \'<ul class="order-list"><li>A</li><li>B</li><li>C</li></ul>\'',
  '               : \'<p data-testid="empty-orders">주문 없음</p>\')',
  '    : \'<input id="email">\';',
  '  fetch("/echo-auth").then(function (r) { return r.json(); }).then(function (d) {',
  '    var el = document.createElement("p");',
  '    el.setAttribute("data-testid", "echo-auth");',
  '    el.textContent = d.auth;',
  '    document.body.appendChild(el);',
  '  });',
  '</script></body>',
].join('\n');

/** 목 타겟 앱 + 목 API 서버 */
function startServer(): Promise<MockServer> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/auth/token' && req.method === 'POST') {
      return json(200, { data: { accessToken: 'tok_abc123', user: { id: 42 } } });
    }
    if (req.url === '/test-support/orders' && req.method === 'POST') {
      return json(201, { data: { orderId: 'ord_777' } });
    }
    if (req.url === '/echo-auth') {
      return json(200, { auth: req.headers.authorization ?? '(없음)' });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(APP_HTML);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        // 페이지가 keep-alive 로 붙어 있으면 close() 가 끝나지 않으므로 강제로 끊는다
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

const test = base.extend<{ ctx: BrowserContext; extId: string; sw: Worker }>({
  ctx: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ ctx }, use) => {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = (await ctx.waitForEvent('serviceworker', { timeout: 15_000 })) as Worker;
    await use(sw);
  },
  extId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});

/** 목 서버 기준의 Condi 설정 */
function makeConfig(base: string, conditions: Record<string, unknown>) {
  return {
    profileName: 'e2e',
    target: { baseUrl: `${base}/`, apiBaseUrl: base },
    conditions,
    selectors: {
      welcomeBanner: '[data-testid="welcome-banner"]',
      adminDashboardMenu: '[data-testid="admin-dashboard"]',
      orderListItem: '.order-list > li',
      emptyOrders: '[data-testid="empty-orders"]',
      echoAuth: '[data-testid="echo-auth"]',
    },
    apiSetup: {
      defaultHeaders: { 'Content-Type': 'application/json' },
      steps: [
        {
          name: 'issueToken',
          request: { method: 'POST', path: '/auth/token', body: { role: '{{conditions.userRole}}' } },
          extract: { accessToken: '$.data.accessToken', userId: '$.data.user.id' },
        },
        {
          name: 'seedActiveOrder',
          when: { 'conditions.testDataCondition': 'hasActiveOrder' },
          request: {
            method: 'POST',
            path: '/test-support/orders',
            headers: { Authorization: 'Bearer {{vars.accessToken}}' },
            body: { userId: '{{vars.userId}}' },
          },
          extract: { seededOrderId: '$.data.orderId' },
          expectStatus: 201,
        },
      ],
    },
    injection: {
      localStorage: { accessToken: '{{vars.accessToken}}', seededOrderId: '{{vars.seededOrderId}}' },
    },
    uiFlow: [
      { action: 'expectVisible', target: 'welcomeBanner' },
      { when: { 'conditions.userRole': 'admin' }, action: 'expectVisible', target: 'adminDashboardMenu' },
      {
        when: { 'conditions.testDataCondition': 'hasActiveOrder' },
        action: 'expectCount',
        target: 'orderListItem',
        count: 3,
      },
      { when: { 'conditions.testDataCondition': 'noOrder' }, action: 'expectVisible', target: 'emptyOrders' },
    ],
  };
}

/** 확장 페이지에서 서비스 워커로 CONDI_RUN 을 보내고 결과를 받는다 */
async function runViaExtension(
  ctx: BrowserContext,
  extId: string,
  targetUrl: string,
  config: unknown,
) {
  const target = await ctx.newPage();
  await target.goto(targetUrl);

  const driver = await ctx.newPage();
  await driver.goto(`chrome-extension://${extId}/panel/panel.html`);

  const result = await driver.evaluate(
    async ({ cfg, url }) => {
      const tabs = await chrome.tabs.query({ url: `${url}/*` });
      return chrome.runtime.sendMessage({ type: 'CONDI_RUN', config: cfg, tabId: tabs[0].id });
    },
    { cfg: config, url: targetUrl },
  );

  return { result: result as Record<string, any>, target };
}

test.describe('확장 전체 파이프라인', () => {
  test('admin + hasActiveOrder — API 세팅부터 UI 검증까지 통과한다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const config = makeConfig(server.url, { userRole: 'admin', testDataCondition: 'hasActiveOrder' });
      const { result, target } = await runViaExtension(ctx, extId, server.url, config);

      expect(result.ok, JSON.stringify(result)).toBe(true);

      // API 선행 세팅이 실제로 호출됐는지
      expect(server.calls).toContain('POST /auth/token');
      expect(server.calls).toContain('POST /test-support/orders');

      // extract 가 동작했는지
      expect(result.result.vars.accessToken).toBe('tok_abc123');
      expect(result.result.vars.seededOrderId).toBe('ord_777');

      // uiFlow 3단계 전부 통과
      const steps = result.result.steps;
      expect(steps, JSON.stringify(steps)).toHaveLength(3);
      expect(steps.every((s: { ok: boolean }) => s.ok), JSON.stringify(steps)).toBe(true);

      // 주입이 실제 페이지에 반영됐는지
      expect(await target.evaluate(() => localStorage.getItem('accessToken'))).toBe('tok_abc123');
    } finally {
      await server.close();
    }
  });

  test('member + noOrder — 조건에 맞는 API 스텝과 UI 단계만 실행된다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const config = makeConfig(server.url, { userRole: 'member', testDataCondition: 'noOrder' });
      const { result } = await runViaExtension(ctx, extId, server.url, config);

      expect(result.ok, JSON.stringify(result)).toBe(true);

      // 조건이 안 맞으므로 시딩 API 는 호출되지 않아야 한다
      expect(server.calls).toContain('POST /auth/token');
      expect(server.calls).not.toContain('POST /test-support/orders');

      // admin 단계와 hasActiveOrder 단계가 빠지고 2단계만 남는다
      const steps = result.result.steps;
      expect(steps, JSON.stringify(steps)).toHaveLength(2);
      expect(steps.every((s: { ok: boolean }) => s.ok), JSON.stringify(steps)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('selectors에 없는 target을 쓰면 실행 전에 거부한다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const bad = makeConfig(server.url, { userRole: 'admin', testDataCondition: 'noOrder' });
      bad.uiFlow.push({ action: 'click', target: 'doesNotExist' } as never);
      const { result } = await runViaExtension(ctx, extId, server.url, bad);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('doesNotExist');
    } finally {
      await server.close();
    }
  });

  test('extraHTTPHeaders 가 declarativeNetRequest 로 실제 요청에 붙는다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const config = makeConfig(server.url, { userRole: 'admin', testDataCondition: 'noOrder' });
      // 페이지가 호출하는 요청에 Authorization 이 붙는지 확인한다
      (config.injection as Record<string, unknown>).extraHTTPHeaders = {
        Authorization: 'Bearer {{vars.accessToken}}',
      };
      config.uiFlow.push({
        action: 'expectText',
        target: 'echoAuth',
        value: 'Bearer tok_abc123',
      } as never);

      const { result } = await runViaExtension(ctx, extId, server.url, config);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      const steps = result.result.steps;
      expect(steps.every((s: { ok: boolean }) => s.ok), JSON.stringify(steps)).toBe(true);
    } finally {
      await server.close();
    }
  });
});


/**
 * 패널 UI 회귀 테스트.
 *
 * 실사용에서 "셀렉터를 골랐는데 설정에 안 들어가 실행할 수 없다"는 막힘이 있었다.
 * 원인은 두 가지가 겹친 것이었다.
 *   1) apiBaseUrl 을 무조건 필수로 검사해 최소 설정이 늘 검증 실패
 *   2) 검증 실패로 config 가 null 이면 피커 결과를 조용히 버림
 * 피커는 설정을 '만드는' 도구이므로 설정이 없어도 동작해야 한다.
 */
test.describe('패널 — 셀렉터 수집', () => {
  /** 서비스 워커에서 패널로 피커 결과를 보낸다 (패널은 자기 메시지를 못 받는다) */
  const sendPick = (sw: Worker, selector: string, name: string) =>
    sw.evaluate(
      ({ selector, name }) =>
        chrome.runtime
          .sendMessage({ type: 'CONDI_PICK_RESULT', selector, suggestedName: name, preview: '' })
          // 응답하는 리스너가 없으면 거부되지만, 여기서는 응답이 필요 없다
          .catch(() => {}),
      { selector, name },
    );

  test('설정이 없어도 고른 셀렉터가 설정에 들어가고 실행이 가능해진다', async ({ ctx, extId, sw }) => {
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);

      await target.bringToFront();

      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
      // 시작 시점에는 설정이 없어 실행이 막혀 있어야 한다
      await expect(panel.locator('#run')).toBeDisabled();

      await sendPick(sw, '[data-testid="welcome-banner"]', 'welcomeBanner');

      // 셀렉터가 설정에 실제로 반영되고
      await expect(panel.locator('#config')).toHaveValue(/welcomeBanner/);
      await expect(panel.locator('#selector-list')).toContainText('welcomeBanner');
      // 실행 가능 상태가 된다
      await expect(panel.locator('#run')).toBeEnabled();

      // 자동 생성된 설정의 타겟이 현재 탭 기준인지
      const cfg = JSON.parse(await panel.locator('#config').inputValue());
      expect(cfg.target.baseUrl).toContain('127.0.0.1');
      expect(cfg.selectors.welcomeBanner).toBe('[data-testid="welcome-banner"]');
    } finally {
      await server.close();
    }
  });

  test('이름이 겹치면 덮어쓰지 않고 새 이름을 붙인다', async ({ ctx, extId, sw }) => {
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);
      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);

      await sendPick(sw, '#first', 'item');
      await expect(panel.locator('#config')).toHaveValue(/#first/);
      await sendPick(sw, '#second', 'item');
      await expect(panel.locator('#config')).toHaveValue(/#second/);

      const cfg = JSON.parse(await panel.locator('#config').inputValue());
      expect(cfg.selectors.item).toBe('#first');
      expect(Object.values(cfg.selectors)).toContain('#second');
      expect(Object.keys(cfg.selectors)).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  test('새 설정 버튼이 현재 탭 기준 골격을 만든다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);
      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);

      await panel.locator('.tab[data-tab="config"]').click();
      await panel.locator('#new-config').click();

      const cfg = JSON.parse(await panel.locator('#config').inputValue());
      expect(cfg.target.baseUrl).toContain('127.0.0.1');
      expect(cfg.selectors).toEqual({});
      // apiBaseUrl 없이도 유효한 설정이어야 한다
      await expect(panel.locator('#config-status')).toHaveClass(/ok/);
    } finally {
      await server.close();
    }
  });

  test('요소를 고르고 바로 실행하면 그 요소가 검증된다', async ({ ctx, extId, sw }) => {
    // 사용자가 실제로 한 동선: 셀렉터 탭에서 요소 지정 → 실행 탭 → 실행.
    // 중간에 단계를 손으로 추가하지 않아도 의미 있는 검증이 돌아야 한다.
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);
      await target.bringToFront();

      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
      // 토큰 없는 목 앱에 항상 있는 요소
      await sendPick(sw, '#email', 'emailInput');

      // 고른 것만으로 흐름이 1단계 생겨야 한다
      await expect(panel.locator('#flow-count')).toHaveText('1단계');

      await panel.locator('#run').click();
      await expect(panel.locator('#summary')).toContainText('통과 1', { timeout: 30_000 });
      await expect(panel.locator('#summary')).toContainText('실패 0');
    } finally {
      await server.close();
    }
  });

  test('자동 생성 설정은 사이트 루트가 아니라 지금 보던 페이지를 타겟으로 잡는다', async ({ ctx, extId, sw }) => {
    // 루트로 잡으면 실행할 때마다 요소를 고른 화면을 떠나 검증이 깨진다
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(`${server.url}/some/deep/page`);
      await target.bringToFront();

      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
      await sendPick(sw, '#email', 'emailInput');

      const cfg = JSON.parse(await panel.locator('#config').inputValue());
      expect(cfg.target.baseUrl).toContain('/some/deep/page');
    } finally {
      await server.close();
    }
  });

  test('셀렉터 옆 버튼으로 단계를 더 붙일 수 있다', async ({ ctx, extId, sw }) => {
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);
      await target.bringToFront();

      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
      // 토큰이 없는 상태의 목 앱에는 로그인 입력만 있다 (항상 보이는 요소)
      await sendPick(sw, '#email', 'emailInput');

      // 고르는 순간 '보임' 1단계가 이미 생긴다. 버튼으로 클릭 단계를 더 붙인다.
      await expect(panel.locator('#flow-count')).toHaveText('1단계');
      await panel.locator('.tab[data-tab="selectors"]').click();
      await panel.locator('.sel-actions button[data-action="click"]').click();
      await expect(panel.locator('#flow-count')).toHaveText('2단계');

      await panel.locator('.tab[data-tab="run"]').click();
      await panel.locator('#run').click();

      await expect(panel.locator('#summary')).toContainText('통과 2', { timeout: 30_000 });
      await expect(panel.locator('#summary')).toContainText('실패 0');
    } finally {
      await server.close();
    }
  });
});


/**
 * 조건 매트릭스 실행.
 *
 * Condi 의 전제는 "조건이 바뀌면 검증도 바뀐다"이므로, 조합을 한 번에 돌려
 * 어느 조건에서만 깨지는지 드러내는 것이 이 기능의 목적이다.
 */
test.describe('패널 — 조건 매트릭스', () => {
  test('조합을 모두 실행하고 격자로 결과를 낸다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);
      await target.bringToFront();

      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);

      const config = makeConfig(server.url, { userRole: 'admin', testDataCondition: 'hasActiveOrder' });
      await panel.locator('.tab[data-tab="config"]').click();
      await panel.locator('#config').fill(JSON.stringify(config));
      await expect(panel.locator('#config-status')).toHaveClass(/ok/);

      await panel.locator('.tab[data-tab="matrix"]').click();
      await panel.locator('#mx-userRole').fill('admin, member');
      await panel.locator('#mx-testDataCondition').fill('hasActiveOrder, noOrder');
      await panel.locator('#run-matrix').click();

      // 2x2 = 4개 조합이 모두 통과해야 한다
      await expect(panel.locator('#matrix-progress')).toContainText('4개 조합', { timeout: 90_000 });
      await expect(panel.locator('#matrix-progress')).toContainText('실패 0');
      await expect(panel.locator('#matrix-progress')).toHaveClass(/ok/);

      // 격자가 그려지고 셀이 채워졌는지
      const cells = panel.locator('.matrix td.ok');
      await expect(cells).toHaveCount(4);
      // 축 라벨이 제자리에 있는지
      await expect(panel.locator('.matrix')).toContainText('userRole');
      await expect(panel.locator('.matrix')).toContainText('hasActiveOrder');
    } finally {
      await server.close();
    }
  });

  test('실패하는 조건이 격자에서 드러난다', async ({ ctx, extId }) => {
    const server = await startServer();
    try {
      const target = await ctx.newPage();
      await target.goto(server.url);
      await target.bringToFront();

      const panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel/panel.html`);

      // member 에서도 admin 메뉴를 요구하게 만들어 일부러 깨뜨린다
      const config = makeConfig(server.url, { userRole: 'admin', testDataCondition: 'noOrder' });
      config.uiFlow = [{ action: 'expectVisible', target: 'adminDashboardMenu' }] as never;
      // 목 앱은 로그인만 되면 admin 메뉴를 항상 그리므로, 없는 요소로 실패를 만든다
      config.selectors.adminDashboardMenu = '[data-testid="does-not-exist"]';
      (config as Record<string, unknown>).waits = { elementTimeout: 1500 };

      await panel.locator('.tab[data-tab="config"]').click();
      await panel.locator('#config').fill(JSON.stringify(config));
      await panel.locator('.tab[data-tab="matrix"]').click();
      await panel.locator('#mx-userRole').fill('admin, member');
      await panel.locator('#mx-testDataCondition').fill('noOrder');
      await panel.locator('#run-matrix').click();

      await expect(panel.locator('#matrix-progress')).toContainText('2개 조합', { timeout: 90_000 });
      await expect(panel.locator('#matrix-progress')).toContainText('실패 2');
      await expect(panel.locator('#matrix-progress')).toHaveClass(/err/);
    } finally {
      await server.close();
    }
  });
});
