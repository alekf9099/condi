import { test } from '../fixtures/condi-fixtures';

/**
 * 예시 시나리오: 설정의 선언적 uiFlow를 Playwright 러너가 그대로 실행한다.
 *
 * 이 파일에는 URL도, 셀렉터도, 단계 정의도 없다.
 * 흐름은 config/test-config.json 의 uiFlow 한 곳에만 있고,
 * Chrome 확장도 **같은 정의**를 실행한다. 두 벌로 갈라지지 않는다.
 *
 * 다른 사이트를 검증하려면 설정 파일만 교체하면 된다.
 *   예) CONDI_CONFIG=config/another-site.json npx playwright test
 *
 * 실제 타겟이 필요하므로 CI 기본 실행에서는 제외된다.
 * 설정 자체의 정합성(target이 selectors에 있는지 등)은 validateConfig가 CI에서 검사한다.
 */

test.describe('Condi 조건부 플로우', () => {
  test('설정의 uiFlow가 조건에 맞게 실행된다', async ({ condi, condiPage }) => {
    test.skip(!condi.uiFlow?.length, '설정에 uiFlow가 없습니다');

    await condiPage.goto('/');
    await condiPage.runUiFlow();
  });
});
