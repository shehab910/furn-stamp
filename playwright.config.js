const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: { channel: 'chromium', baseURL: 'http://localhost:8765', acceptDownloads: true },
  webServer: { command: 'node tests/server.js', url: 'http://localhost:8765/index.html', reuseExistingServer: true },
});
