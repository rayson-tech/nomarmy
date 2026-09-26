import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'page.spec.js',
  reporter: [['html', { open: 'never' }]],
  use: { browserName: 'chromium', screenshot: 'on', trace: 'on',
    launchOptions: { args: ['--disable-dev-shm-usage'] } },
});
