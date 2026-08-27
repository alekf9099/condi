import * as fs from 'fs';
import * as path from 'path';
import { CondiConfig } from './types';
import { validateConfig } from './template.js';

/**
 * 설정 파일 로더 (Node 전용).
 *
 * 템플릿 치환/조건 평가 로직은 core/template.js 에 있으며 Chrome 확장과 공유한다.
 * 이 파일은 파일시스템 접근과 환경변수 오버라이드만 담당한다.
 *
 * 우선순위:
 *   1. 환경변수 CONDI_CONFIG 에 지정된 경로
 *   2. 기본 경로 config/test-config.json
 *
 * CONDI_CONDITIONS 에 JSON 문자열을 넘기면 conditions를 실행 시점에 덮어쓴다.
 *   예) CONDI_CONDITIONS='{"userRole":"admin"}' npx playwright test
 */

export { getByPath, resolveTemplate, resolveDeep, matchesWhen } from './template.js';

export interface TemplateContext {
  conditions: Record<string, unknown>;
  vars: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  [key: string]: unknown;
}

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

  const problems = validateConfig(raw);
  if (problems.length > 0) {
    throw new Error(`[Condi] 설정 검증 실패 (${configPath}):\n - ${problems.join('\n - ')}`);
  }

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
