/**
 * Condi 템플릿/조건 엔진 — 순수 로직, 의존성 없음.
 *
 * Node(Playwright 러너)와 브라우저(Chrome 확장) 양쪽에서 **같은 파일**을 쓴다.
 * 여기에 fs / playwright / chrome API를 절대 들이지 말 것.
 * 확장 쪽 사본은 `npm run sync:ext` 로 복사되며 CI가 동기화를 검사한다.
 */

/**
 * dot-path 조회. "$.data.items[0].id" 또는 "conditions.userRole" 형태 지원.
 * 선두의 "$." 은 루트 표시로 간주하고 제거한다.
 * @param {unknown} root
 * @param {string} expr
 * @returns {unknown}
 */
export function getByPath(root, expr) {
  const normalized = expr.replace(/^\$\.?/, '');
  if (normalized === '') return root;
  const segments = normalized
    .replace(/\[(\d+)\]/g, '.$1') // items[0] -> items.0
    .split('.')
    .filter(Boolean);

  let current = /** @type {any} */ (root);
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[seg];
  }
  return current;
}

/**
 * "{{conditions.userRole}}", "{{vars.authToken}}", "{{env.SECRET}}" 형태의
 * 플레이스홀더를 컨텍스트 값으로 치환한다.
 * @param {string} input
 * @param {Record<string, unknown>} ctx
 * @returns {string}
 */
export function resolveTemplate(input, ctx) {
  return input.replace(/\{\{\s*([\w.$[\]]+)\s*\}\}/g, (_match, expr) => {
    const value = getByPath(ctx, expr);
    if (value === undefined || value === null) {
      throw new Error(`[Condi] 플레이스홀더 해석 실패: {{${expr}}} — 컨텍스트에 값이 없습니다.`);
    }
    return String(value);
  });
}

/**
 * 객체/배열 내부의 모든 문자열 값에 대해 재귀적으로 치환.
 * @template T
 * @param {T} input
 * @param {Record<string, unknown>} ctx
 * @returns {T}
 */
export function resolveDeep(input, ctx) {
  if (typeof input === 'string') return /** @type {T} */ (resolveTemplate(input, ctx));
  if (Array.isArray(input)) return /** @type {T} */ (input.map((v) => resolveDeep(v, ctx)));
  if (input && typeof input === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = resolveDeep(v, ctx);
    return /** @type {T} */ (out);
  }
  return input;
}

/**
 * `when` 필터 평가. 모든 키(컨텍스트 dot-path)가 기대값과 일치해야 true.
 * when이 없으면 항상 true.
 * @param {Record<string, unknown> | undefined} when
 * @param {Record<string, unknown>} ctx
 * @returns {boolean}
 */
export function matchesWhen(when, ctx) {
  if (!when) return true;
  return Object.entries(when).every(([path, expected]) => getByPath(ctx, path) === expected);
}

/**
 * 설정 스키마 검증. 문제 목록을 반환하며, 빈 배열이면 통과.
 * @param {any} config
 * @returns {string[]}
 */
export function validateConfig(config) {
  /** @type {string[]} */
  const problems = [];
  if (!config || typeof config !== 'object') return ['설정이 객체가 아닙니다'];
  if (!config.target?.baseUrl) problems.push('target.baseUrl 누락');
  if (!config.target?.apiBaseUrl) problems.push('target.apiBaseUrl 누락');
  if (!config.conditions) problems.push('conditions 누락');
  if (!config.selectors) problems.push('selectors 누락');

  for (const [i, step] of (config.uiFlow ?? []).entries()) {
    if (!step.action) problems.push(`uiFlow[${i}].action 누락`);
    if (UI_ACTIONS_NEEDING_TARGET.has(step.action) && !step.target) {
      problems.push(`uiFlow[${i}] (${step.action}) 에 target 누락`);
    }
    if (step.target && config.selectors && !(step.target in config.selectors)) {
      problems.push(`uiFlow[${i}] 의 target "${step.target}" 이 selectors에 없습니다`);
    }
  }
  return problems;
}

/** target(셀렉터 논리명)이 반드시 필요한 UI 액션 */
export const UI_ACTIONS_NEEDING_TARGET = new Set([
  'click',
  'fill',
  'select',
  'check',
  'expectVisible',
  'expectHidden',
  'expectText',
  'expectValue',
  'expectCount',
]);

/** 지원하는 모든 UI 액션 */
export const UI_ACTIONS = new Set(['goto', 'waitForUrl', ...UI_ACTIONS_NEEDING_TARGET]);
