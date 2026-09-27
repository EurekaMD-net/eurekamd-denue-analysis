import { describe, it, expect } from "vitest";
import { resolveClaudeExecutable } from "./claude-executable.js";

const GLIBC_BIN =
  "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";

// Fake filesystem: only the listed paths exist.
const fs =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);
// Fake module resolver: maps the non-musl package id to GLIBC_BIN.
const resolve = (id: string) =>
  id === "@anthropic-ai/claude-agent-sdk-linux-x64/claude"
    ? GLIBC_BIN
    : undefined;

describe("resolveClaudeExecutable", () => {
  it("SAGE_CLAUDE_EXECUTABLE wins when it exists", () => {
    const env = { SAGE_CLAUDE_EXECUTABLE: "/opt/claude" };
    expect(
      resolveClaudeExecutable(
        env,
        "linux",
        "x64",
        fs("/opt/claude", GLIBC_BIN),
        resolve,
      ),
    ).toBe("/opt/claude");
  });

  it("SAGE_CLAUDE_EXECUTABLE is ignored when it does not exist", () => {
    const env = { SAGE_CLAUDE_EXECUTABLE: "/missing/claude" };
    expect(
      resolveClaudeExecutable(env, "linux", "x64", fs(GLIBC_BIN), resolve),
    ).toBe(GLIBC_BIN);
  });

  it("linux glibc host → the non-musl package binary", () => {
    expect(
      resolveClaudeExecutable({}, "linux", "x64", fs(GLIBC_BIN), resolve),
    ).toBe(GLIBC_BIN);
  });

  // Proves require.resolve reaches the package binary (no "exports" map).
  it.runIf(process.platform === "linux" && process.arch === "x64")(
    "linux glibc host with the real resolver → the non-musl package path",
    () => {
      const path = resolveClaudeExecutable({}, "linux", "x64", (p) =>
        p.startsWith("/lib/ld-musl-") ? false : true,
      );
      expect(path).toMatch(/claude-agent-sdk-linux-x64\/claude$/);
    },
  );

  it("linux glibc host without the package → undefined", () => {
    expect(
      resolveClaudeExecutable({}, "linux", "x64", fs(), () => undefined),
    ).toBeUndefined();
  });

  it("musl host → undefined (the SDK's own musl-first lookup is right)", () => {
    expect(
      resolveClaudeExecutable(
        {},
        "linux",
        "x64",
        fs("/lib/ld-musl-x86_64.so.1", GLIBC_BIN),
        resolve,
      ),
    ).toBeUndefined();
  });

  it("darwin → undefined", () => {
    expect(
      resolveClaudeExecutable({}, "darwin", "arm64", fs(GLIBC_BIN), resolve),
    ).toBeUndefined();
  });
});
