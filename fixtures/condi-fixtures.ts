import { test as base } from '@playwright/test';
import { loadConfig, resolveDeep, TemplateContext } from '../core/config-loader';
import { runApiSetup } from '../core/api-setup';
import { CondiPage } from '../core/ui-actions';
import { CondiConfig, CondiRuntime } from '../core/types';

/**
 * Condi 픽스처.
 *
 * 실행 흐름:
 *   1. condiRuntime(worker 단위 1회): 설정 로드 → API 선행 세팅 실행 → vars 확보
 *   2. condiPage(테스트 단위): vars를 쿠키/스토리지/헤더로 주입한 브라우저 컨텍스트 생성
 *   3. 테스트 본문: condiPage로 논리 이름 기반 UI 상호작용 + conditions 기반 분기
 */

interface CondiWorkerFixtures {
  condiRuntime: CondiRuntime;
}

interface CondiTestFixtures {
  /** 로드된 설정 (조건 분기용으로 테스트에서 직접 참조) */
  condi: CondiConfig;
  /** API 세팅 산출물이 주입된 페이지 래퍼 */
  condiPage: CondiPage;
}

export const test = base.extend<CondiTestFixtures, CondiWorkerFixtures>({
  // ── worker 스코프: API 선행 세팅은 워커당 1회만 수행 ──
  condiRuntime: [
    async ({}, use) => {
      const config = loadConfig();
      console.log(`[Condi] 프로필: ${config.profileName ?? '(이름 없음)'}`);
      console.log(`[Condi] 타겟: ${config.target.baseUrl}`);
      console.log(`[Condi] 조건: ${JSON.stringify(config.conditions)}`);

      const vars = await runApiSetup(config);
      await use({ config, vars });
    },
    { scope: 'worker' },
  ],

  condi: async ({ condiRuntime }, use) => {
    await use(condiRuntime.config);
  },

  // ── 테스트 스코프: 주입이 완료된 브라우저 컨텍스트/페이지 ──
  condiPage: async ({ browser, condiRuntime }, use) => {
    const { config, vars } = condiRuntime;
    const ctx: TemplateContext = { conditions: config.conditions, vars, env: process.env };

    // injection 규칙 내 {{vars.*}} 플레이스홀더를 실제 값으로 치환
    const injection = config.injection ? resolveDeep(config.injection, ctx) : undefined;

    const context = await browser.newContext({
      baseURL: config.target.baseUrl,
      extraHTTPHeaders: injection?.extraHTTPHeaders,
    });

    if (injection?.cookies?.length) {
      await context.addCookies(
        injection.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          // domain/path 또는 url 중 하나 필수 — 둘 다 없으면 baseUrl 기준으로 주입
          ...(c.domain ? { domain: c.domain, path: c.path ?? '/' } : { url: c.url ?? config.target.baseUrl }),
        })),
      );
    }

    if (injection?.localStorage || injection?.sessionStorage) {
      await context.addInitScript(
        ({ ls, ss }) => {
          for (const [k, v] of Object.entries(ls ?? {})) window.localStorage.setItem(k, v as string);
          for (const [k, v] of Object.entries(ss ?? {})) window.sessionStorage.setItem(k, v as string);
        },
        { ls: injection.localStorage ?? {}, ss: injection.sessionStorage ?? {} },
      );
    }

    const page = await context.newPage();
    await use(new CondiPage(page, config));
    await context.close();
  },
});

export { expect } from '@playwright/test';
