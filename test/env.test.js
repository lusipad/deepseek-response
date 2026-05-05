import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadDotEnv } from "../src/env.js";
import { resolveEnvPath } from "../src/server.js";

test("loads simple .env values without overriding existing env", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepseek2response-env-"));
  const path = join(dir, ".env");
  const oldValue = process.env.DEEPSEEK2RESPONSE_ENV_TEST;
  const oldExisting = process.env.DEEPSEEK2RESPONSE_ENV_EXISTING;

  try {
    process.env.DEEPSEEK2RESPONSE_ENV_EXISTING = "keep";
    delete process.env.DEEPSEEK2RESPONSE_ENV_TEST;
    writeFileSync(path, "DEEPSEEK2RESPONSE_ENV_TEST=\"loaded\"\nDEEPSEEK2RESPONSE_ENV_EXISTING=replace\n");

    loadDotEnv(path);

    assert.equal(process.env.DEEPSEEK2RESPONSE_ENV_TEST, "loaded");
    assert.equal(process.env.DEEPSEEK2RESPONSE_ENV_EXISTING, "keep");
  } finally {
    restoreEnv("DEEPSEEK2RESPONSE_ENV_TEST", oldValue);
    restoreEnv("DEEPSEEK2RESPONSE_ENV_EXISTING", oldExisting);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves exe-adjacent .env before parent .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepseek2response-env-path-"));

  try {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dir, ".env"), "PARENT=1\n");
    writeFileSync(join(dist, ".env"), "DIST=1\n");

    assert.equal(resolveEnvPath(join(dist, "deepseek2response.exe"), {}), join(dist, ".env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves Unix binary-adjacent .env before parent .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepseek2response-env-unix-path-"));

  try {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dir, ".env"), "PARENT=1\n");
    writeFileSync(join(dist, ".env"), "DIST=1\n");

    assert.equal(resolveEnvPath(join(dist, "deepseek2response"), {}), join(dist, ".env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to parent .env for repo-local dist exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepseek2response-env-parent-"));

  try {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dir, ".env"), "PARENT=1\n");

    assert.equal(resolveEnvPath(join(dist, "deepseek2response.exe"), {}), join(dist, "..", ".env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("honors explicit env file override", () => {
  assert.equal(
    resolveEnvPath("C:\\tools\\deepseek2response.exe", { DEEPSEEK2RESPONSE_ENV_FILE: "C:\\custom\\.env" }),
    "C:\\custom\\.env"
  );
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
