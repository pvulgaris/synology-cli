import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadRuntimeConfig,
  loadTarget,
  tryLoadTarget,
} from "./config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("DSM target uses DSM authentication defaults", () => {
  withEnv({ DSM_BASE_URL: "https://nas.test:5001/", DSM_USER: "agent" }, () => {
    const target = loadTarget("dsm");
    assert.equal(target.platform, "dsm");
    assert.equal(target.baseUrl, "https://nas.test:5001");
    assert.equal(target.user, "agent");
    assert.equal(target.envPrefix, "DSM");
    assert.equal(target.authPath, "entry.cgi");
    assert.equal(target.authVersion, 6);
    assert.equal(target.readOnly, false);
  });
});

test("SRM target loads without any DSM configuration", () => {
  withEnv(
    {
      DSM_BASE_URL: undefined,
      DSM_USER: undefined,
      SRM_BASE_URL: "https://router.test:8001",
      SRM_USER: "srm-agent",
    },
    () => {
      const target = loadTarget("srm");
      assert.equal(target.platform, "srm");
      assert.equal(target.user, "srm-agent");
      assert.equal(target.envPrefix, "SRM");
      assert.equal(target.authPath, "auth.cgi");
      assert.equal(target.authVersion, 3);
      assert.equal(target.readOnly, true);
    }
  );
});

test("a missing or blank user is refused rather than defaulted", () => {
  for (const value of [undefined, "   "]) {
    withEnv({ SRM_BASE_URL: "https://router.test:8001", SRM_USER: value }, () =>
      assert.throws(() => loadTarget("srm"), /Missing required env: SRM_USER/)
    );
  }
});

test("tryLoadTarget returns null only when that target is absent", () => {
  withEnv({ DSM_BASE_URL: "https://nas.test", DSM_USER: "agent", SRM_BASE_URL: undefined }, () => {
    assert.equal(tryLoadTarget("srm"), null);
    assert.equal(tryLoadTarget("dsm")?.platform, "dsm");
  });
});

test("a trailing slash addresses the same target, so it shares the session", () => {
  let withSlash = "";
  let without = "";
  withEnv({ DSM_BASE_URL: "https://nas.test:5001/", DSM_USER: "agent", DSM_SID_CACHE_FILE: undefined }, () => {
    withSlash = loadTarget("dsm").sidCacheFile;
  });
  withEnv({ DSM_BASE_URL: "https://nas.test:5001", DSM_USER: "agent", DSM_SID_CACHE_FILE: undefined }, () => {
    without = loadTarget("dsm").sidCacheFile;
  });
  assert.equal(withSlash, without);
});

test("runtime configuration does not require a device", () => {
  withEnv(
    {
      DSM_BASE_URL: undefined,
      SRM_BASE_URL: undefined,
      AUDIT_LOG_DIR: "/tmp/syno-audit-test",
    },
    () => {
      const runtime = loadRuntimeConfig();
      assert.equal(runtime.auditLogDir, "/tmp/syno-audit-test");
    }
  );
});

// Certificates are verified unless one target opts out. The former global
// switch, TLS_REJECT_UNAUTHORIZED=0, skipped verification for every target
// by default and no longer does anything.
test("certificate checks are on unless a target sets <PREFIX>_TLS_SKIP_VERIFY=1", () => {
  const targets = { DSM_BASE_URL: "https://nas.test:5001", DSM_USER: "a", SRM_BASE_URL: "https://router.test:8001", SRM_USER: "a" };
  withEnv({ ...targets, TLS_REJECT_UNAUTHORIZED: "0", DSM_TLS_SKIP_VERIFY: undefined, SRM_TLS_SKIP_VERIFY: undefined }, () => {
    assert.equal(loadTarget("dsm").tlsSkipVerify, false);
    assert.equal(loadTarget("srm").tlsSkipVerify, false);
  });
  withEnv({ ...targets, DSM_TLS_SKIP_VERIFY: undefined, SRM_TLS_SKIP_VERIFY: "1" }, () => {
    assert.equal(loadTarget("dsm").tlsSkipVerify, false);
    assert.equal(loadTarget("srm").tlsSkipVerify, true);
  });
});
