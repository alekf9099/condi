# Condi — Universal Conditional Test Engine

특정 서비스에 종속되지 않는 **범용 조건부 자동화 테스트 엔진**입니다.
테스트 코드에는 URL·API 엔드포인트·셀렉터가 일절 하드코딩되지 않으며,
모든 타겟 정보는 설정 파일(JSON)에서 동적으로 로드됩니다.

## 실행 흐름

```
설정 로드 → API 선행 세팅(토큰 발급·데이터 시딩) → 산출물을 브라우저에 주입 → UI 자동화 + 조건 분기 검증
```

1. **설정 로드** — `CONDI_CONFIG` 환경변수 경로 또는 기본 `config/test-config.json`
2. **API 선행 세팅** — `apiSetup.steps`를 순차 실행. `when`으로 조건부 실행, `extract`로 응답 값을 변수(`vars`)에 적재
3. **브라우저 주입** — `injection` 규칙에 따라 쿠키 / localStorage / HTTP 헤더로 주입
4. **UI 자동화** — `selectors`의 논리 이름으로만 요소에 접근, 모든 상호작용에 명시적 대기 공통 적용

## 디렉토리 구조

```
config/     설정 파일 (타겟별로 교체 가능한 JSON)
core/       엔진 코어 — types(스키마), config-loader, api-setup, ui-actions
fixtures/   Playwright 픽스처 (condi, condiPage)
tests/      시나리오 (설정에만 의존하는 범용 테스트)
```

## 시작하기

```bash
npm install
npx playwright install chromium
npm test
```

### 타겟/조건 바꿔서 실행

```bash
# 다른 설정 파일로 실행 (사이트 교체)
CONDI_CONFIG=config/test-config.member.json npx playwright test

# 설정 파일은 그대로 두고 조건만 오버라이드 (CI 매트릭스 등)
CONDI_CONDITIONS='{"userRole":"member"}' npx playwright test
```

PowerShell에서는:

```powershell
$env:CONDI_CONFIG = "config/test-config.member.json"; npx playwright test
```

## 설정 스키마 요약

```jsonc
{
  "target":     { "baseUrl": "...", "apiBaseUrl": "..." },
  "conditions": { "userRole": "admin", "testDataCondition": "...", "任意키": "확장 가능" },
  "selectors":  { "논리이름": "CSS 또는 xpath=... 셀렉터" },
  "apiSetup":   { "steps": [ { "name", "when", "request", "extract", "expectStatus" } ] },
  "injection":  { "cookies", "localStorage", "sessionStorage", "extraHTTPHeaders" },
  "waits":      { "elementTimeout", "navigationTimeout", "apiTimeout" }
}
```

### 플레이스홀더

문자열 값 어디서나 사용 가능하며 실행 시점에 치환됩니다.

| 표기 | 의미 |
|---|---|
| `{{conditions.userRole}}` | 설정의 조건 값 |
| `{{vars.accessToken}}` | 이전 API 스텝의 `extract` 결과 |
| `{{env.CONDI_CLIENT_SECRET}}` | 환경변수 (시크릿은 설정 파일에 넣지 말 것) |

### 조건부 API 스텝 (`when`)

```json
{
  "name": "seedActiveOrder",
  "when": { "conditions.testDataCondition": "hasActiveOrder" },
  "request": { "method": "POST", "path": "/test-support/orders", "body": { "userId": "{{vars.userId}}" } }
}
```

`when`의 모든 키(컨텍스트 dot-path)가 기대값과 일치할 때만 실행됩니다.

## CI / 자동 머지

`.github/workflows/ci.yml` 하나가 두 가지 잡을 담당합니다.

| 잡 | 트리거 | 하는 일 |
|---|---|---|
| `validate` | main push, PR | `tsc --noEmit` + `config/*.json` 전 프로필 스키마 검증 + 테스트 디스커버리 |
| `auto-merge` | PR (라벨 `automerge`) | GitHub 네이티브 auto-merge를 켬 |

자동 머지를 쓰려면 PR에 **`automerge` 라벨**만 붙이면 됩니다.

```bash
gh pr create --fill --label automerge
```

라벨이 붙으면 워크플로가 auto-merge를 켜두고, 실제 병합은 **required status check가
전부 통과한 뒤 GitHub가** 수행합니다. 라벨이 없는 PR은 검증만 하고 머지하지 않습니다.

### 브랜치 보호 (main)

`main`에는 룰셋 `main protection`이 걸려 있습니다.

| 규칙 | 효과 |
|---|---|
| `pull_request` | main 직접 push 차단 — 반드시 PR 경유 (승인 0건, squash만 허용) |
| `required_status_checks` | `Type-check & config validation` 통과 필수 |
| `non_fast_forward` | force push 차단 |
| `deletion` | main 삭제 차단 |

Vercel을 연결한 뒤 배포 성공까지 머지 조건에 넣으려면,
룰셋의 required status checks에 Vercel 체크를 추가하면 auto-merge가 그것까지 기다립니다.

### 실제 브라우저 테스트를 CI에서 돌리려면

현재 CI는 검증만 하고 실제 브라우저 테스트는 돌리지 않습니다.
예시 설정이 가상 타겟(`example-shop.test`)을 가리키기 때문입니다.
실제 타겟이 준비되면 워크플로에 다음을 추가하세요.

```yaml
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
        env:
          CONDI_CONFIG: config/staging.json
          CONDI_CLIENT_SECRET: ${{ secrets.CONDI_CLIENT_SECRET }}
```

## Vercel 배포 (PR 프리뷰 링크)

Vercel은 **머지를 수행하지 않습니다.** 머지는 위의 GitHub Actions가 담당하고,
Vercel이 더해주는 건 PR마다 붙는 **배포 프리뷰 링크**입니다.

Condi는 테스트 엔진이라 배포할 웹앱이 없으므로, `npm run build`가
배포할 만한 정적 사이트를 생성합니다.

- `config/*.json` 프로필 요약 — 어떤 타겟을 어떤 조건으로 검증하는지
- `playwright-report/` 가 있으면 `/report/` 경로로 함께 서빙

```bash
npm run build   # -> public/
```

### 연결 방법 (최초 1회, 브라우저에서 직접)

Vercel↔GitHub 연결은 OAuth 승인이 필요해 대시보드에서 직접 하셔야 합니다.

1. [vercel.com/new](https://vercel.com/new) 접속 후 GitHub 계정으로 로그인
2. **Import Git Repository** 에서 `alekf9099/condi` 선택
   - 목록에 없으면 *Adjust GitHub App Permissions* 로 이 저장소에 접근 권한 부여
3. 빌드 설정은 [vercel.json](vercel.json)에 이미 있으므로 그대로 **Deploy**
   - Build Command: `npm run build` / Output Directory: `public`

연결이 끝나면 이후 모든 PR에 Vercel 봇이 프리뷰 URL을 코멘트로 남기고,
저장소 우측 **Deployments** 에도 링크가 노출됩니다.

### 배포 상태를 머지 조건으로 걸려면

`.github/workflows/ci.yml` 의 `auto-merge` 잡에 Vercel 배포 성공 대기를 추가해야 합니다.
다만 Free 플랜 비공개 저장소에서는 required status check를 강제할 수 없으므로,
확실히 하려면 저장소를 public으로 전환하거나 GitHub Pro가 필요합니다.

## 테스트 작성 규칙

- `@playwright/test`가 아닌 `fixtures/condi-fixtures`의 `test`/`expect`를 import
- 요소 접근은 반드시 `condiPage.el('논리이름')` 또는 헬퍼(`click`/`fill`/`expectVisible`)로
- 조건 분기는 `condi.conditions.*` 값으로 수행하고, 해당 조건에서만 유효한 시나리오는 `test.skip(조건, 사유)` 사용
