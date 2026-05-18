#!/usr/bin/env node
// One-command worker deploy + smoke verify.
//
// Run from anywhere in the repo:
//   npm run ship --prefix backend
// Or from inside backend/:
//   npm run ship
//
// What it does:
//   1. Runs `wrangler deploy` (auto-launches browser login the first time)
//   2. Hits the live /push/vapid-public-key endpoint (public since e0cc7a3)
//      to confirm the new code is actually live, not stuck on old cache
//   3. Prints a clean ok/fail line so you don't have to read wrangler output
//
// Cross-platform: works on macOS, Linux, and Windows (Node 18+).

import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

console.log("▶ wrangler deploy");
console.log("");
try {
  execSync("npx wrangler deploy", { cwd: here, stdio: "inherit" });
} catch (e) {
  console.error("");
  console.error("✗ Deploy failed. See wrangler output above.");
  console.error("  If you see 'not authenticated', run: cd backend && npx wrangler login");
  process.exit(1);
}

console.log("");
console.log("▶ Smoke test (was 401 pre-fix, should be 200 now)");

const url = "https://ascend-backend.acend.workers.dev/push/vapid-public-key";
try {
  // Give CF a moment to swap routes to the new version. Usually instant, but
  // a short retry loop is cheap and avoids a flaky-test feeling.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url);
    const body = await res.text();
    if (res.status === 200) {
      console.log("");
      console.log("✓ HTTP " + res.status + "  " + body);
      console.log("");
      console.log("Deployed and verified. The new worker code is live.");
      process.exit(0);
    }
    if (attempt < 4) {
      console.log("  attempt " + attempt + ": HTTP " + res.status + " — retrying in 2s...");
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.error("");
      console.error("✗ Got HTTP " + res.status + " after 4 attempts (expected 200).");
      console.error("  Body: " + body);
      console.error("  Wrangler said deploy succeeded but the live route still 401s.");
      console.error("  Try: npx wrangler deployments list  to see what's actually live.");
      process.exit(1);
    }
  }
} catch (e) {
  console.error("");
  console.error("✗ Smoke test failed: " + (e && e.message ? e.message : e));
  console.error("  Wrangler said deploy succeeded; verify manually with curl.");
  process.exit(1);
}
