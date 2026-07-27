const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // e2e shares one emulator projectId; parallel per-worker projectIds are a later hardening step
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        // A document fulfilled via route interception loses its "local" address space, so Chromium's
        // Private Network Access then blocks fetches to the emulator on another 127.0.0.1 port.
        '--disable-features=PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests',
      ],
    },
  },
  webServer: {
    command: 'node lib/static-server.mjs',
    url: 'http://127.0.0.1:4173/manifest.json',
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [
    { name: 'logic', testDir: './specs/logic' },
    { name: 'e2e', testDir: './specs/e2e' },
  ],
});
