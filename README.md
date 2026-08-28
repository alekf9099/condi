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

## 두 개의 실행 주체, 하나의 설정

같은 config를 **Chrome 확장**과 **Playwright 러너**가 모두 실행합니다.

| | Chrome 확장 | Playwright 러너 |
|---|---|---|
| 용도 | QA가 즉석에서 조건 바꿔가며 검증 | CI에서 반복 실행 |
| 세션 | 브라우저에 이미 로그인된 실제 세션 | 매번 API로 새로 발급 |
| 사내망 타겟 | 접근 가능 | 러너가 망 안에 있어야 함 |
| 셀렉터 수집 | 페이지에서 클릭해 자동 생성 | 수동 작성 |

UI 흐름을 코드가 아닌 `uiFlow`로 설정에 둔 이유가 이것입니다 — 코드에 있으면 확장이 실행할 대상이 없습니다.
템플릿·조건 로직은 [core/template.js](core/template.js) 한 벌을 양쪽이 공유하며,
확장용 사본은 `npm run sync:ext`로 복사되고 CI가 동기화를 검사합니다.

## 디렉토리 구조

```
config/     설정 파일 (타겟별로 교체 가능한 JSON)
core/       엔진 코어 — template.js(공유 순수 로직), types, config-loader,
            api-setup, ui-actions(runUiFlow 포함)
extension/  Chrome MV3 확장 — background(오케스트레이터), content(러너·피커), panel(UI)
fixtures/   Playwright 픽스처 (condi, condiPage)
scripts/    build-site(Vercel 배포용), sync-extension(공유 모듈 복사)
tests/      시나리오 + 확장 러너 자체 테스트(ui-runner.spec.ts)
```

## Chrome 확장 설치

스토어에 올리지 않고 압축 해제된 확장으로 바로 씁니다.

**ZIP으로 받기 (가장 빠름)** — [condi-five.vercel.app](https://condi-five.vercel.app) 에서
ZIP을 받아 압축을 풀고, `chrome://extensions` → **개발자 모드** → **압축해제된 확장 프로그램을 로드**
→ 푼 폴더 선택. ZIP은 배포 시 `extension/`을 그대로 묶어 생성되므로 항상 최신입니다.

**소스에서 쓰기 (CI까지 함께 돌릴 때)**

1. `npm run sync:ext` — 공유 모듈을 확장으로 복사
2. Chrome에서 `chrome://extensions` 열기 → 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** → 이 저장소의 `extension/` 폴더 선택
4. 툴바의 Condi 아이콘을 눌러 사이드 패널 열기

### 사용법

**설정 탭** — `새 설정`을 누르면 현재 탭을 기준으로 최소 설정이 만들어집니다.
파일에서 불러오거나 JSON을 직접 붙여넣어도 됩니다.
유효성 검사가 실시간으로 돌고, 설정은 브라우저에 저장돼 다음에도 유지됩니다.

`apiBaseUrl` 은 **API 선행 세팅을 쓸 때만** 필요합니다. 이미 로그인된 세션을 그대로
검증할 거라면 `baseUrl` 하나로 충분합니다.

**셀렉터 탭** — 셀렉터는 *무엇을 가리키는가*이고, `uiFlow`는 *무엇을 하는가*입니다.
**셀렉터만 모아서는 실행할 것이 생기지 않습니다.** 그래서 각 셀렉터 옆의
`클릭` · `보임` · `없음` 버튼으로 흐름 단계를 바로 만들 수 있습니다.

설정이 아직 없어도 됩니다. 고른 셀렉터를 담을 설정이 없으면
현재 탭을 기준으로 자동 생성됩니다. `요소 선택 시작`을 누르고 대상 페이지에서 요소를 클릭하면
안정적인 셀렉터(`data-testid` > `id` > `name` > `aria-label` > 최단 CSS 경로)가
자동 생성되어 설정의 `selectors`에 추가됩니다. <kbd>Esc</kbd>로 취소합니다.

**실행 탭** — `● 녹화 시작`을 누르고 평소처럼 사이트를 조작하면, 클릭·입력·선택·체크가
`uiFlow` 단계로 쌓입니다. 페이지에 뜨는 막대에서 **검증 추가**로 바꾸면 클릭한 요소가
`expectVisible`/`expectText` 검증으로 남습니다. <kbd>Esc</kbd>로 중지합니다.
셀렉터는 피커와 같은 규칙으로 뽑히므로 한 설정 안에서 이름이 어긋나지 않습니다.

조건을 즉석에서 바꿔 실행합니다. 실행 순서는 Playwright 러너와 동일합니다:

```
apiSetup 실행 → 쿠키·헤더 주입 → baseUrl 이동 → 스토리지 주입 후 재로드 → uiFlow 실행
```

단계별 통과/실패가 패널에 쌓이고, 실패하면 무엇을 기다렸는지가 함께 표시됩니다.

**매트릭스 탭** — 조건마다 시험할 값을 쉼표로 나눠 적으면 **모든 조합을 차례로 실행**하고
결과를 격자로 보여줍니다.

|  | hasActiveOrder | noOrder |
|---|---|---|
| **admin** | ✓ 3/3 | ✓ 2/2 |
| **member** | ✓ 3/3 | ✕ 1/2 |

"member + noOrder에서만 깨진다"가 한눈에 드러납니다.
조합 사이에 `injection`이 선언한 스토리지 키는 매번 덮어쓰거나 지워지므로,
앞 조합이 남긴 상태가 다음 조합을 오염시키지 않습니다.

### 확장의 제약

- `extraHTTPHeaders`는 `declarativeNetRequest` 동적 규칙으로 부착되며 **타겟 호스트에만** 적용됩니다
- 스토리지 주입은 페이지 로드 후에만 가능해 **주입 뒤 한 번 재로드**합니다 (앱이 값을 읽도록)
- `host_permissions`가 `<all_urls>`인 것은 타겟이 설정으로 정해지기 때문입니다 — 특정 도메인만 쓸 거면 좁히세요

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
  "uiFlow":     [ { "action", "target", "value", "count", "when", "timeout" } ],
  "waits":      { "elementTimeout", "navigationTimeout", "apiTimeout" }
}
```

### uiFlow 액션

`target`은 `selectors`의 논리 이름이며, `goto`/`waitForUrl`을 뺀 모든 액션에 필요합니다.
각 단계는 `apiSetup`과 동일한 `when` 규칙으로 조건부 실행됩니다.

| 액션 | 쓰임 |
|---|---|
| `goto` | `value` 경로로 이동 (baseUrl 기준) |
| `waitForUrl` | URL에 `value`가 포함될 때까지 대기 |
| `click` / `check` | 클릭 / 체크박스 체크 |
| `fill` / `select` | `value` 입력 / 옵션 선택 |
| `expectVisible` / `expectHidden` | 표시 / 미표시 검증 |
| `expectText` / `expectValue` | 텍스트 포함 / 입력값 일치 검증 |
| `expectCount` | 요소 개수가 `count`와 일치 |

```json
{
  "when": { "conditions.userRole": "admin" },
  "action": "expectVisible",
  "target": "adminDashboardMenu",
  "description": "admin에게만 노출되는 메뉴"
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
| `validate` | main push, PR | `tsc --noEmit` · 확장 모듈 동기화 검사 · `config/*.json` 전 프로필 스키마 검증 · 테스트 54건 |
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

### 테스트 구성

| 스펙 | 검증 대상 | 실제 타겟 필요 |
|---|---|---|
| `template.spec.ts` | 공유 모듈 — 치환·조건·주입 해석·스키마 검증 | 없음 |
| `ui-runner.spec.ts` | 확장 UI 실행기 — 대기·액션·실패 메시지 | 없음 |
| `picker.spec.ts` | 셀렉터 피커 — 생성한 셀렉터가 유일하게 해석되는지 | 없음 |
| `recorder.spec.ts` | 플로우 레코더 — 조작이 올바른 uiFlow 단계로 남는지 | 없음 |
| `extension-e2e.spec.ts` | **확장 전체 파이프라인 + 패널 UI + 매트릭스** — 실제 Chromium에 로드해 API 세팅 → 주입 → uiFlow, 셀렉터 수집·조건 매트릭스 | 없음 (목 서버) |
| `example-conditional-flow.spec.ts` | 실제 사이트 시나리오 템플릿 | **필요** |

앞의 다섯은 로컬 목 서버만 쓰므로 CI에서 항상 실행됩니다.

### 실제 타겟 테스트를 CI에서 돌리려면

CI는 확장 러너 테스트(로컬 픽스처)는 돌리지만, `tests/example-conditional-flow.spec.ts`
같은 실제 타겟 시나리오는 돌리지 않습니다. 예시 설정이 가상 타겟(`example-shop.test`)을
가리키기 때문입니다. 실제 타겟이 준비되면 워크플로에 다음을 추가하세요.

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
