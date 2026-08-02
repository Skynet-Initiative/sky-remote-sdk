import { defineConfig, devices } from "@playwright/test";

/**
 * No browser had ever run this code before phase 2.5. Both defects that reached a real
 * customer — the mirror showing unstyled HTML and the consent panel cropped to 150px —
 * would have been caught by a single automated page load, which is what this file is.
 *
 * Two projects, because the two failures were size-dependent: a phone and a laptop.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./build-probe.mjs",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: "http://localhost:4180",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "laptop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } }
  ],
  webServer: {
    command: "node server.mjs",
    url: "http://localhost:4180/01-external-stylesheet.html",
    reuseExistingServer: true,
    stdout: "pipe",
    timeout: 20_000
  }
});
