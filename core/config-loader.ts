import * as fs from 'fs';
import * as path from 'path';
import { CondiConfig } from './types';

/**
 * 설정 파일 로더.
 *
 * 우선순위:
 *   1. 환경변수 CONDI_CONFIG 에 지정된 경로
 *   2. 기본 경로 config/test-config.json
 *
 * 추가로 환경변수 CONDI_CONDITIONS 에 JSON 문자열을 넘기면
 * conditions 필드를 실행 시점에 덮어쓸 수 있다.
 *   예) CONDI_CONDITIONS='{"userRole":"admin"}' npx playwright test
 */

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'test-config.json');

let cached: CondiConfig | null = null;

export function loadConfig(force = false): CondiConfig {
  if (cached && !force) return cached;

  const configPath = process.env.CONDI_CONFIG
    ? path.resolve(process.cwd(), process.env.CONDI_CONFIG)
    : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `[Condi] 설정 파일을 찾을 수 없습니다: ${configPath}\n` +
      `CONDI_CONFIG 환경변수로 경로를 지정하거나 config/test-config.json 을 생성하세요.`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CondiConfig;
  validate(raw, configPath);

  // 실행 시점 조건 오버라이드 (CI 매트릭스 등에서 활용)
  if (process.env.CONDI_CONDITIONS) {
    try {
      const overrides = JSON.parse(process.env.CONDI_CONDITIONS);
      raw.conditions = { ...raw.conditions, ...overrides };
    } catch {
      throw new Error('[Condi] CONDI_CONDITIONS 값이 유효한 JSON이 아닙니다.');
    }
  }

  cached = raw;
  return raw;
}

function validate(config: CondiConfig, source: string): void {
  const problems: string[] = [];
  if (!config.target?.baseUrl) problems.push('target.baseUrl 누락');
  if (!config.target?.apiBaseUrl) problems.push('target.apiBaseUrl 누락');
  if (!config.conditions) problems.push('conditions 누락');
  if (!config.selectors) problems.push('selectors 누락');
  if (problems.length > 0) {
    throw new Error(`[Condi] 설정 검증 실패 (${source}):\n - ${problems.join('\n - ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* 플레이스홀더 치환 유틸                                                */
/* ------------------------------------------------------------------ */

export interface TemplateContext {
  conditions: Record<string, unknown>;
  vars: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  [key: string]: unknown;
}

/**
 * "{{conditions.userRole}}", "{{vars.authToken}}", "{{env.SECRET}}" 형태의
 * 플레이스홀더를 컨텍스트 값으로 치환한다.
 */
export function resolveTemplate(input: string, ctx: TemplateContext): string {
  return input.replace(/\{\{\s*([\w.$[\]]+)\s*\}\}/g, (_match, expr: string) => {
    const value = getByPath(ctx, expr);
    if (value === undefined || value === null) {
      throw new Error(`[Condi] 플레이스홀더 해석 실패: {{${expr}}} — 컨텍스트에 값이 없습니다.`);
    }
    return String(value);
  });
}

/** 객체/배열 내부의 모든 문자열 값에 대해 재귀적으로 치환 */
export function resolveDeep<T>(input: T, ctx: TemplateContext): T {
  if (typeof input === 'string') return resolveTemplate(input, ctx) as unknown as T;
  if (Array.isArray(input)) return input.map((v) => resolveDeep(v, ctx)) as unknown as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = resolveDeep(v, ctx);
    }
    return out as T;
  }
  return input;
}

/**
 * dot-path 조회. "$.data.items[0].id" 또는 "conditions.userRole" 형태 지원.
 * 선두의 "$." 은 루트 표시로 간주하고 제거한다.
 */
export function getByPath(root: unknown, expr: string): unknown {
  const normalized = expr.replace(/^\$\.?/, '');
  if (normalized === '') return root;
  const segments = normalized
    .replace(/\[(\d+)\]/g, '.$1') // items[0] -> items.0
    .split('.')
    .filter(Boolean);

  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}
