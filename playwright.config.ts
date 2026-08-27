import { defineConfig } from '@playwright/test';
import { loadConfig } from './core/config-loader';

/**
 * Playwright 설정.
 * 타겟 정보는 전부 config/test-config.json(또는 CONDI_CONFIG 경로)에서 로드한다.
 */
const condi = loadConfig();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: condi.target.baseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: condi.waits?.elementTimeout ?? 10_000,
    navigationTimeout: condi.waits?.navigationTimeout ?? 30_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
