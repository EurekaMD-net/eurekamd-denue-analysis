/**
 * Which Claude Code binary the Agent SDK spawns.
 *
 * On linux the SDK (0.2.138) tries the `-musl` optional package before the
 * glibc one, and npm installs both. The musl binary needs
 * /lib/ld-musl-<arch>.so.1; on a glibc host that loader is missing, the
 * spawn fails with ENOENT and the SDK reports "native binary not found".
 * So on a glibc linux host we point the SDK at the glibc package binary.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Node arch → musl loader name (/lib/ld-musl-<name>.so.1).
const MUSL_ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };

function defaultResolve(id: string): string | undefined {
  try {
    return require.resolve(id);
  } catch {
    return undefined;
  }
}

/**
 * Path for the SDK's `pathToClaudeCodeExecutable`, or undefined to keep the
 * SDK's own lookup. `SAGE_CLAUDE_EXECUTABLE` wins when it exists.
 */
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (path: string) => boolean = existsSync,
  resolve: (id: string) => string | undefined = defaultResolve,
): string | undefined {
  const override = env.SAGE_CLAUDE_EXECUTABLE;
  if (override && exists(override)) return override;

  if (platform !== "linux") return undefined;
  if (exists(`/lib/ld-musl-${MUSL_ARCH[arch] ?? arch}.so.1`)) return undefined;

  const path = resolve(`@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`);
  return path && exists(path) ? path : undefined;
}
