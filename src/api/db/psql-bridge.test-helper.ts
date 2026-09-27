/**
 * Test-only `node:child_process` mock that routes the psql runner's
 * transport into a single FIFO `mockExec(file, argv, opts)` queue.
 *
 * The runner sends SQL on stdin (spawn) or as `input` (execFileSync). The
 * bridge APPENDS that SQL to the recorded argv so handler tests can read it
 * as `mockExec.mock.calls[N][1].at(-1)`; the real argv never carries it
 * (asserted in psql-runner.test.ts). A mockExec return value becomes
 * stdout with exit 0; a throw becomes exit 1 with the thrown error's
 * `stderr` (Buffer or string) on the child's stderr. pg_cancel_backend
 * side-calls go to `mockCancel(argv)` instead of the query queue.
 *
 * Usage (inside a test file):
 *   vi.mock("node:child_process", async () =>
 *     (await import("../db/psql-bridge.test-helper.js")).psqlChildProcessMock(
 *       mockExec, mockCancel));
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi, type Mock } from "vitest";

type ExecFn = (file: string, args: string[], opts: unknown) => unknown;

export function psqlChildProcessMock(mockExec: Mock, mockCancel?: Mock) {
  const call = mockExec as unknown as ExecFn;
  return {
    execSync: vi.fn(),
    execFile: vi.fn(),
    execFileSync: (file: string, args: string[], opts: { input?: string }) =>
      call(file, [...args, opts.input ?? ""], opts),
    spawn: (file: string, args: string[], opts: unknown) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      });
      if (
        args.some((a) => a.startsWith("PGAPPNAME=") && a.endsWith("-cancel"))
      ) {
        mockCancel?.(args);
        return child;
      }
      let sql = "";
      child.stdin.on("data", (d: Buffer) => (sql += d.toString("utf-8")));
      child.stdin.on("finish", () => {
        setImmediate(() => {
          let code = 0;
          try {
            const out = call(file, [...args, sql], opts);
            if (typeof out === "string" && out) child.stdout.write(out);
          } catch (err) {
            const se = (err as { stderr?: unknown }).stderr;
            if (typeof se === "string" || se instanceof Buffer) {
              child.stderr.write(se);
            }
            code = 1;
          }
          let open = 2;
          const done = (): void => {
            if (--open === 0) child.emit("close", code, null);
          };
          child.stdout.on("end", done);
          child.stderr.on("end", done);
          child.stdout.end();
          child.stderr.end();
        });
      });
      return child;
    },
  };
}
