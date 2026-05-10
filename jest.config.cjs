/**
 * Visual-regression test config. Each test draws the same scene with
 * simdra and @napi-rs/canvas, then compares with ssim.js.
 *
 * Tests are ESM (.test.js) because they import `dist/simdra.mjs` (ESM
 * bundle). Jest uses its experimental ESM-VM mode — set via:
 *   node --experimental-vm-modules ./node_modules/.bin/jest
 *
 * Configured by `npm run test:visual` in package.json.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/visual/**/*.test.js'],
  // No transforms — tests are plain ESM that Node 24+ runs natively.
  transform: {},
  // SSIM computation on 512×512 images takes a few seconds.
  testTimeout: 30000,
};
