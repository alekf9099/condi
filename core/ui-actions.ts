import { expect, Locator, Page } from '@playwright/test';
import { CondiConfig } from './types';

/**
 * 동적 UI 자동화 헬퍼.
 *
 * - 셀렉터를 코드에 하드코딩하지 않고, 논리 이름(elementName)으로만 접근한다.
 * - 모든 상호작용 전에 명시적 대기(요소 visible 대기)를 공통 적용해
 *   간헐적 실패(flakiness)를 줄인다.
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
}
