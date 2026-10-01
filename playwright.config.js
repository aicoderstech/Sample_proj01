import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

// End-to-end tests run against the production build served by server/index.mjs
// (run `npm run test:e2e`, which builds first). Chromium gets a fake camera
// that plays tests/.fixtures/person.y4m, a real photo of a person.
const PORT = 4319;
const fixtures = join(import.meta.dirname, 'tests', '.fixtures');

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.js',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${join(fixtures, 'person.y4m')}`,
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server/index.mjs',
    url: `http://127.0.0.1:${PORT}/healthz`,
    env: { PORT: String(PORT), HOST: '127.0.0.1' },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
