import { test, expect } from '../fixtures/condi-fixtures';

/**
 * 예시 시나리오: 조건(conditions)에 따라 동적으로 분기하는 범용 테스트.
 *
 * 이 파일에는 URL도, 셀렉터 문자열도 등장하지 않는다.
 * 모든 타겟 정보는 config/test-config.json 에서 온다.
 * 다른 사이트를 검증하려면 설정 파일만 교체하면 된다.
 *   예) CONDI_CONFIG=config/another-site.json npx playwright test
 */

test.describe('Condi 조건부 진입 플로우', () => {
  test('API 선행 세팅 후 역할(userRole)에 맞는 화면이 노출된다', async ({ condi, condiPage }) => {
    // API 세팅에서 발급된 토큰이 이미 localStorage/헤더로 주입된 상태로 진입
    await condiPage.goto('/');
    await condiPage.expectVisible('welcomeBanner');

    // ── conditions 기반 동적 분기 ──
    switch (condi.conditions.userRole) {
      case 'admin':
        await condiPage.expectVisible('adminDashboardMenu');
        break;
      case 'member':
        await condiPage.expectHidden('adminDashboardMenu');
        await condiPage.expectVisible('myPageLink');
        break;
      default:
        // 비로그인 등 그 외 조건: 로그인 폼이 노출되어야 함
        await condiPage.expectVisible('loginEmailInput');
    }
  });

  test('선행 생성된 테스트 데이터가 UI에 반영된다', async ({ condi, condiPage }) => {
    // 이 조건이 아닐 때는 시나리오 자체를 건너뛴다 (조건부 실행)
    test.skip(
      condi.conditions.testDataCondition !== 'hasActiveOrder',
      'hasActiveOrder 조건에서만 유효한 시나리오',
    );

    await condiPage.goto('/orders');
    await condiPage.expectVisible('orderListItem');

    // 주문이 1건 이상 존재해야 함 (API 세팅에서 seed된 데이터)
    const count = await condiPage.el('orderListItem').count();
    expect(count, 'API로 선행 생성한 주문이 목록에 있어야 합니다').toBeGreaterThan(0);
  });
});
