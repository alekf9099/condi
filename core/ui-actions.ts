import { expect, Locator, Page } from '@playwright/test';
import { CondiConfig, UiStep } from './types';
import { matchesWhen, resolveTemplate } from './template.js';

/**
 * 동적 UI 자동화 헬퍼.
 *
 * - 셀렉터를 코드에 하드코딩하지 않고, 논리 이름(elementName)으로만 접근한다.
 * - 모든 상호작용 전에 명시적 대기(요소 visible 대기)를 공통 적용해
 *   간헐적 실패(flakiness)를 줄인다.
 * - runUiFlow()는 설정의 선언적 uiFlow를 그대로 실행하므로,
 *   Chrome 확장과 **동일한 흐름 정의**를 공유한다.
 */
export class CondiPage {
  private readonly elementTimeout: number;

  constructor(
    public readonly page: Page,
    private readonly config: CondiConfig,
  ) {
    this.elementTimeout = config.waits?.elementTimeout ?? 10_000;
  }

  /** 설정 파일의 selectors 맵에서 논리 이름으로 Locator를 얻는다. */
  el(elementName: string): Locator {
    const selector = this.config.selectors[elementName];
    if (!selector) {
      throw new Error(
        `[Condi] 셀렉터 미정의: "${elementName}" — config의 selectors에 추가하세요.\n` +
        `정의된 이름: ${Object.keys(this.config.selectors).join(', ')}`,
      );
    }
    // "xpath=" 접두어는 Playwright가 네이티브로 처리한다.
    return this.page.locator(selector);
  }

  /** baseUrl 기준 상대 경로로 이동 */
  async goto(relativePath = '/'): Promise<void> {
    await this.page.goto(relativePath, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.waits?.navigationTimeout ?? 30_000,
    });
  }

  /** 요소가 보일 때까지 명시적으로 대기한 뒤 클릭 */
  async click(elementName: string): Promise<void> {
    const locator = this.el(elementName);
    await locator.waitFor({ state: 'visible', timeout: this.elementTimeout });
    await locator.click();
  }

  /** 요소가 보일 때까지 대기 후 값 입력 */
  async fill(elementName: string, value: string): Promise<void> {
    const locator = this.el(elementName);
    await locator.waitFor({ state: 'visible', timeout: this.elementTimeout });
    await locator.fill(value);
  }

  /** 요소 표시 여부 검증 (동적 대기 포함) */
  async expectVisible(elementName: string): Promise<void> {
    await expect(this.el(elementName), `"${elementName}" 요소가 보여야 합니다`).toBeVisible({
      timeout: this.elementTimeout,
    });
  }

  /** 요소가 화면에 없어야 함을 검증 */
  async expectHidden(elementName: string): Promise<void> {
    await expect(this.el(elementName), `"${elementName}" 요소가 없어야 합니다`).toBeHidden({
      timeout: this.elementTimeout,
    });
  }

  /** 요소 텍스트 검증 */
  async expectText(elementName: string, text: string | RegExp): Promise<void> {
    await expect(this.el(elementName)).toContainText(text, { timeout: this.elementTimeout });
  }

  /**
   * 설정의 선언적 uiFlow를 실행한다.
   * `when` 조건이 맞지 않는 단계는 건너뛴다.
   */
  async runUiFlow(vars: Record<string, unknown> = {}): Promise<void> {
    const ctx = { conditions: this.config.conditions, vars, env: process.env };

    for (const step of this.config.uiFlow ?? []) {
      if (!matchesWhen(step.when, ctx)) continue;
      const value = step.value !== undefined ? resolveTemplate(step.value, ctx) : undefined;
      await this.runStep(step, value);
    }
  }

  private async runStep(step: UiStep, value: string | undefined): Promise<void> {
    const timeout = step.timeout ?? this.elementTimeout;
    const name = step.target ?? '';

    switch (step.action) {
      case 'goto':
        await this.goto(value ?? '/');
        return;
      case 'waitForUrl':
        await this.page.waitForURL(new RegExp(escapeRegExp(value ?? '')), { timeout });
        return;
      case 'click':
        await this.click(name);
        return;
      case 'fill':
        await this.fill(name, value ?? '');
        return;
      case 'select':
        await this.el(name).selectOption(value ?? '', { timeout });
        return;
      case 'check':
        await this.el(name).check({ timeout });
        return;
      case 'expectVisible':
        await expect(this.el(name), `"${name}" 요소가 보여야 합니다`).toBeVisible({ timeout });
        return;
      case 'expectHidden':
        await expect(this.el(name), `"${name}" 요소가 없어야 합니다`).toBeHidden({ timeout });
        return;
      case 'expectText':
        await expect(this.el(name)).toContainText(value ?? '', { timeout });
        return;
      case 'expectValue':
        await expect(this.el(name)).toHaveValue(value ?? '', { timeout });
        return;
      case 'expectCount':
        await expect(this.el(name)).toHaveCount(step.count ?? 0, { timeout });
        return;
      default: {
        const exhaustive: never = step.action;
        throw new Error(`[Condi] 지원하지 않는 UI 액션: ${exhaustive}`);
      }
    }
  }
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
