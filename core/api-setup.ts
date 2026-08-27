import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { TemplateContext } from './config-loader';
import { getByPath, matchesWhen, resolveDeep, resolveTemplate } from './template.js';
import { ApiSetupStep, CondiConfig } from './types';

/**
 * API 선행 세팅 모듈 (Dynamic API Pre-setup).
 *
 * UI 브라우저를 띄우기 전에 config.apiSetup.steps 를 순차 실행한다.
 * - 각 스텝의 path/headers/body 에 있는 {{...}} 플레이스홀더를 conditions/vars/env 로 치환
 * - `when` 필터로 조건부 실행 (예: userRole이 admin일 때만 실행)
 * - `extract` 로 응답 값을 vars에 적재 → 이후 스텝 및 브라우저 주입에서 재사용
 */
export async function runApiSetup(config: CondiConfig): Promise<Record<string, unknown>> {
  const vars: Record<string, unknown> = {};
  if (!config.apiSetup || config.apiSetup.steps.length === 0) return vars;

  const apiContext = await playwrightRequest.newContext({
    baseURL: config.target.apiBaseUrl,
    extraHTTPHeaders: config.apiSetup.defaultHeaders,
    timeout: config.waits?.apiTimeout ?? 15_000,
  });

  try {
    for (const step of config.apiSetup.steps) {
      const ctx: TemplateContext = { conditions: config.conditions, vars, env: process.env };

      if (!matchesWhen(step.when, ctx)) {
        console.log(`[Condi][api-setup] SKIP  ${step.name} (when 조건 불일치)`);
        continue;
      }

      await executeStep(apiContext, step, ctx, vars);
    }
  } finally {
    await apiContext.dispose();
  }

  return vars;
}

async function executeStep(
  api: APIRequestContext,
  step: ApiSetupStep,
  ctx: TemplateContext,
  vars: Record<string, unknown>,
): Promise<void> {
  const path = resolveTemplate(step.request.path, ctx);
  const headers = step.request.headers ? resolveDeep(step.request.headers, ctx) : undefined;
  const body = step.request.body !== undefined ? resolveDeep(step.request.body, ctx) : undefined;
  const params = step.request.params ? resolveDeep(step.request.params, ctx) : undefined;

  console.log(`[Condi][api-setup] ${step.request.method} ${path}  (${step.name})`);

  const response = await api.fetch(path, {
    method: step.request.method,
    headers,
    data: body,
    params,
  });

  const okByExpectation = step.expectStatus
    ? response.status() === step.expectStatus
    : response.ok();

  if (!okByExpectation) {
    const text = await response.text().catch(() => '<본문 읽기 실패>');
    throw new Error(
      `[Condi][api-setup] 스텝 "${step.name}" 실패: ` +
      `${step.request.method} ${path} → HTTP ${response.status()}\n${text}`,
    );
  }

  if (step.extract) {
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      throw new Error(`[Condi][api-setup] 스텝 "${step.name}": extract가 정의됐지만 응답이 JSON이 아닙니다.`);
    }
    for (const [varName, pathExpr] of Object.entries(step.extract)) {
      const value = getByPath(json, pathExpr);
      if (value === undefined) {
        throw new Error(
          `[Condi][api-setup] 스텝 "${step.name}": 응답에서 "${pathExpr}" 경로를 찾을 수 없습니다. (변수: ${varName})`,
        );
      }
      vars[varName] = value;
      console.log(`[Condi][api-setup]   extract ${varName} = ${maskIfSecret(varName, value)}`);
    }
  }
}

/** 토큰/비밀번호류 변수는 로그에 마스킹 */
function maskIfSecret(name: string, value: unknown): string {
  const sensitive = /token|secret|password|credential|auth/i.test(name);
  const str = String(value);
  return sensitive && str.length > 8 ? `${str.slice(0, 4)}****` : str;
}
