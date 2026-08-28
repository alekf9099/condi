import { test, expect } from '@playwright/test';
import {
  getByPath,
  matchesWhen,
  resolveDeep,
  resolveInjection,
  resolveTemplate,
  validateConfig,
} from '../core/template.js';

/**
 * 공유 모듈 단위 테스트.
 *
 * core/template.js 는 Playwright 러너와 Chrome 확장이 함께 쓰는 유일한 로직이다.
 * 여기가 틀리면 양쪽이 동시에 틀린다.
 */

const ctx = {
  conditions: { userRole: 'admin', retries: 3, beta: true },
  vars: { accessToken: 'tok_1', userId: 42 },
  env: { SECRET: 's3cr3t' },
};

test.describe('getByPath', () => {
  test('dot-path와 배열 인덱스, $ 접두어를 처리한다', () => {
    const data = { data: { items: [{ id: 'a' }, { id: 'b' }] } };
    expect(getByPath(data, '$.data.items[1].id')).toBe('b');
    expect(getByPath(data, 'data.items.0.id')).toBe('a');
    expect(getByPath(data, '$.data.missing')).toBeUndefined();
    expect(getByPath(data, '$.a.b.c.d')).toBeUndefined(); // 중간이 없어도 던지지 않는다
  });
});

test.describe('resolveTemplate', () => {
  test('conditions/vars/env를 치환한다', () => {
    expect(resolveTemplate('{{conditions.userRole}}', ctx)).toBe('admin');
    expect(resolveTemplate('Bearer {{vars.accessToken}}', ctx)).toBe('Bearer tok_1');
    expect(resolveTemplate('{{env.SECRET}}', ctx)).toBe('s3cr3t');
  });

  test('숫자·불리언도 문자열로 치환한다', () => {
    expect(resolveTemplate('/r/{{conditions.retries}}', ctx)).toBe('/r/3');
    expect(resolveTemplate('{{conditions.beta}}', ctx)).toBe('true');
  });

  test('값이 없으면 어떤 자리가 비었는지 알려주며 던진다', () => {
    expect(() => resolveTemplate('{{vars.nope}}', ctx)).toThrow(/vars\.nope/);
  });

  test('중첩 객체를 재귀적으로 치환한다', () => {
    const out = resolveDeep({ a: '{{vars.userId}}', b: ['{{conditions.userRole}}'] }, ctx);
    expect(out).toEqual({ a: '42', b: ['admin'] });
  });
});

test.describe('matchesWhen', () => {
  test('when이 없으면 항상 실행 대상이다', () => {
    expect(matchesWhen(undefined, ctx)).toBe(true);
  });

  test('모든 키가 일치할 때만 참이다', () => {
    expect(matchesWhen({ 'conditions.userRole': 'admin' }, ctx)).toBe(true);
    expect(matchesWhen({ 'conditions.userRole': 'member' }, ctx)).toBe(false);
    expect(matchesWhen({ 'conditions.userRole': 'admin', 'conditions.beta': true }, ctx)).toBe(true);
    expect(matchesWhen({ 'conditions.userRole': 'admin', 'conditions.beta': false }, ctx)).toBe(false);
  });

  test('타입이 다르면 일치하지 않는다', () => {
    expect(matchesWhen({ 'conditions.retries': '3' }, ctx)).toBe(false);
    expect(matchesWhen({ 'conditions.retries': 3 }, ctx)).toBe(true);
  });
});

test.describe('resolveInjection', () => {
  test('해석 가능한 항목만 남기고 나머지는 떨어뜨린다', () => {
    // seededOrderId 는 조건부 API 스텝이 건너뛰어져 존재하지 않는 상황
    const { injection, dropped } = resolveInjection(
      { localStorage: { accessToken: '{{vars.accessToken}}', seededOrderId: '{{vars.seededOrderId}}' } },
      ctx,
    );
    expect(injection.localStorage).toEqual({ accessToken: 'tok_1' });
    expect(dropped).toEqual(['localStorage.seededOrderId']);
  });

  test('모든 항목이 해석 불가면 해당 영역을 통째로 비운다', () => {
    const { injection, dropped } = resolveInjection({ sessionStorage: { x: '{{vars.nope}}' } }, ctx);
    expect(injection.sessionStorage).toBeUndefined();
    expect(dropped).toEqual(['sessionStorage.x']);
  });

  test('쿠키는 항목 단위로 걸러내고 이름을 보고한다', () => {
    const { injection, dropped } = resolveInjection(
      {
        cookies: [
          { name: 'session', value: '{{vars.accessToken}}' },
          { name: 'seeded', value: '{{vars.seededOrderId}}' },
        ],
      },
      ctx,
    );
    expect(injection.cookies).toHaveLength(1);
    expect(injection.cookies[0]).toMatchObject({ name: 'session', value: 'tok_1' });
    expect(dropped[0]).toContain('seeded');
  });

  test('헤더도 같은 규칙을 따른다', () => {
    const { injection, dropped } = resolveInjection(
      { extraHTTPHeaders: { Authorization: 'Bearer {{vars.accessToken}}', 'X-Order': '{{vars.nope}}' } },
      ctx,
    );
    expect(injection.extraHTTPHeaders).toEqual({ Authorization: 'Bearer tok_1' });
    expect(dropped).toEqual(['extraHTTPHeaders.X-Order']);
  });
});

test.describe('validateConfig', () => {
  const base = {
    target: { baseUrl: 'https://x.test' },
    conditions: {},
    selectors: { ok: '#ok' },
  };

  test('올바른 설정은 문제를 내지 않는다', () => {
    expect(validateConfig({ ...base, uiFlow: [{ action: 'expectVisible', target: 'ok' }] })).toEqual([]);
  });

  test('apiSetup이 없으면 apiBaseUrl 없이도 유효하다', () => {
    // 확장으로 이미 로그인된 세션을 검증할 때는 baseUrl 하나면 충분해야 한다
    expect(validateConfig(base)).toEqual([]);
  });

  test('apiSetup.steps가 있으면 apiBaseUrl을 요구한다', () => {
    const problems = validateConfig({
      ...base,
      apiSetup: { steps: [{ name: 'login', request: { method: 'POST', path: '/x' } }] },
    });
    expect(problems.join()).toContain('apiBaseUrl');
  });

  test('필수 항목 누락을 모두 모아 보고한다', () => {
    const problems = validateConfig({});
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join()).toContain('target.baseUrl');
  });

  test('selectors에 없는 target을 잡아낸다', () => {
    const problems = validateConfig({ ...base, uiFlow: [{ action: 'click', target: 'ghost' }] });
    expect(problems.join()).toContain('ghost');
  });

  test('target이 필요한 액션에 target이 없으면 잡아낸다', () => {
    const problems = validateConfig({ ...base, uiFlow: [{ action: 'click' }] });
    expect(problems.join()).toContain('target 누락');
  });

  test('goto는 target이 없어도 된다', () => {
    expect(validateConfig({ ...base, uiFlow: [{ action: 'goto', value: '/' }] })).toEqual([]);
  });
});
