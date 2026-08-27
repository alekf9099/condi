/**
 * Condi 범용 설정 스키마 타입 정의.
 * 어떤 타겟 사이트/시나리오든 이 스키마를 만족하는 JSON만 있으면 구동된다.
 */

/** HTTP 메서드 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** API 선행 세팅의 단일 스텝 정의 (설정 파일에서 선언적으로 기술) */
export interface ApiSetupStep {
  /** 스텝 식별자. extract 결과를 {{vars.*}}로 참조할 때의 네임스페이스 근거가 된다. */
  name: string;
  description?: string;
  /**
   * 조건부 실행 필터. key는 컨텍스트 경로(예: "conditions.userRole"),
   * value는 기대값. 모두 일치할 때만 스텝이 실행된다. 생략 시 항상 실행.
   */
  when?: Record<string, unknown>;
  request: {
    method: HttpMethod;
    /** apiBaseUrl 기준 상대 경로. {{conditions.*}}, {{vars.*}}, {{env.*}} 플레이스홀더 지원 */
    path: string;
    headers?: Record<string, string>;
    /** JSON 바디. 문자열 값 내 플레이스홀더가 재귀적으로 치환된다. */
    body?: unknown;
    /** 쿼리 파라미터 */
    params?: Record<string, string>;
  };
  /**
   * 응답에서 값을 추출해 변수로 저장.
   * key = 변수명, value = 응답 JSON에 대한 dot-path (예: "$.data.accessToken")
   */
  extract?: Record<string, string>;
  /** 응답 상태 코드 검증 (기본: 2xx면 통과) */
  expectStatus?: number;
}

/** API 세팅 결과를 브라우저 컨텍스트에 주입하는 방법 정의 */
export interface BrowserInjection {
  cookies?: Array<{
    name: string;
    value: string; // {{vars.*}} 지원
    domain?: string;
    path?: string;
    url?: string;
  }>;
  /** baseUrl 오리진의 localStorage에 주입 (페이지 로드 전 addInitScript로 처리) */
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  /** 모든 브라우저 요청에 부착할 HTTP 헤더 (예: Authorization) */
  extraHTTPHeaders?: Record<string, string>;
}

/** Condi 범용 설정 루트 스키마 */
export interface CondiConfig {
  /** 사람이 읽기 위한 시나리오 이름 */
  profileName?: string;

  target: {
    baseUrl: string;
    apiBaseUrl: string;
  };

  /**
   * 테스트 분기 조건. userRole / testDataCondition 외에
   * 어떤 키든 자유롭게 추가 가능 (확장 개방형).
   */
  conditions: {
    userRole?: string;
    testDataCondition?: string;
    [key: string]: unknown;
  };

  /**
   * 논리적 요소 이름 -> 실제 셀렉터 매핑.
   * "xpath=" 접두어로 XPath도 지원. 타겟 사이트마다 이 맵만 교체하면 된다.
   */
  selectors: Record<string, string>;

  /** UI를 띄우기 전 순차 실행되는 API 선행 세팅 파이프라인 */
  apiSetup?: {
    /** 모든 스텝에 공통 적용될 헤더 */
    defaultHeaders?: Record<string, string>;
    steps: ApiSetupStep[];
  };

  /** API 세팅 산출물을 브라우저에 주입하는 규칙 */
  injection?: BrowserInjection;

  /** 공통 대기/타임아웃 정책 */
  waits?: {
    /** 요소 등장 대기 기본값(ms) */
    elementTimeout?: number;
    /** 페이지 네비게이션 대기 기본값(ms) */
    navigationTimeout?: number;
    /** API 요청 타임아웃(ms) */
    apiTimeout?: number;
  };
}

/** API 세팅 후 런타임 상태 (테스트 픽스처로 전달됨) */
export interface CondiRuntime {
  config: CondiConfig;
  /** apiSetup steps의 extract 결과가 누적되는 변수 저장소 */
  vars: Record<string, unknown>;
}
