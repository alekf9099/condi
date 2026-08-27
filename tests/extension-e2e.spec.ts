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

const test = base.extend<{ ctx: BrowserContext; extId: string }>({
  ctx: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    await use(context);
    await context.close();
  },
  extId: async ({ ctx }, use) => {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = (await ctx.waitForEvent('serviceworker', { timeout: 15_000 })) as Worker;
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
