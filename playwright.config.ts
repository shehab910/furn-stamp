import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: { channel: 'chromium', baseURL: 'http://localhost:8765', acceptDownloads: true },
  // tests run against the production build, so they check exactly what ships
  webServer: { command: 'npm run build && vite preview --port 8765 --strictPort', url: 'http://localhost:8765/index.html', reuseExistingServer: true },
});
