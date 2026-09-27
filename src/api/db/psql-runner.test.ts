import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Controllable fake children: each spawn() is recorded and left pending
// until the test calls finish()/fail() on it.
interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  args: string[];
  sql: () => string;
  finish: (stdout: string) => void;
  fail: (code: number, stderr: string) => void;
}

const { spawned, mockExecFileSync } = vi.hoisted(() => ({
  spawned: [] as FakeChild[],
  mockExecFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
  spawn: (_file: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      args,
    }) as unknown as FakeChild;
    let sql = "";
    child.stdin.on("data", (d: Buffer) => (sql += d.toString("utf-8")));
    child.sql = () => sql;
    const close = (code: number) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code, null));
    };
    child.finish = (out) => {
      child.stdout.write(out);
      close(0);
    };
    child.fail = (code, err) => {
      child.stderr.write(err);
      close(code);
    };
    spawned.push(child);
    return child;
  },
}));

import { runJson, runJsonSync, runSql } from "./psql-runner.js";

const SQL = "SELECT json_agg(t) FROM secret_table t WHERE x = 'marker'";
const OPTS = { container: "test-supabase-db" };

const tick = () => new Promise((r) => setImmediate(r));
async function waitForSpawns(n: number) {
  for (let i = 0; i < 50 && spawned.length < n; i++) await tick();
}
const envArg = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
const queryChildren = () =>
  spawned.filter((c) => !envArg(c.args, "PGAPPNAME")?.endsWith("-cancel"));
const cancelChildren = () =>
  spawned.filter((c) => envArg(c.args, "PGAPPNAME")?.endsWith("-cancel"));

let errSpy: { mock: { calls: unknown[][] } };
beforeEach(() => {
  spawned.length = 0;
  mockExecFileSync.mockReset();
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runSql argv + stdin transport", () => {
  it("sends SQL on stdin, never in argv", async () => {
    const p = runSql(SQL, OPTS);
    await waitForSpawns(1);
    const child = spawned[0]!;
    expect(child.args.join(" ")).not.toContain("secret_table");
    expect(child.args).not.toContain("-c");
    expect(child.args.slice(0, 2)).toEqual(["exec", "-i"]);
    expect(child.args.slice(-2)).toEqual(["-f", "-"]);
    expect(child.args).toContain("ON_ERROR_STOP=1");
    expect(child.args).toContain("test-supabase-db");
    child.finish("out\n");
    await expect(p).resolves.toBe("out\n");
    expect(child.sql()).toBe(SQL);
  });

  it("passes a read-only PGOPTIONS by default with timeout, work_mem, jit", async () => {
    const p = runSql(SQL, OPTS);
    await waitForSpawns(1);
    const child = spawned[0]!;
    const pgopts = envArg(child.args, "PGOPTIONS");
    expect(pgopts).toBe(
      "-c statement_timeout=25000 -c default_transaction_read_only=on -c work_mem=32MB -c jit=off",
    );
    expect(child.args[child.args.indexOf("-U") + 1]).toBe("postgres");
    expect(envArg(child.args, "PGAPPNAME")).toMatch(/^denue-[0-9a-f-]{36}$/);
    child.finish("");
    await p;
  });

  it("honours readOnly=false, timeoutMs, user and extraSettings", async () => {
    const p = runSql(SQL, {
      ...OPTS,
      readOnly: false,
      timeoutMs: 10000,
      user: "denue_sage",
      extraSettings: ["search_path=public"],
    });
    await waitForSpawns(1);
    const child = spawned[0]!;
    expect(envArg(child.args, "PGOPTIONS")).toBe(
      "-c statement_timeout=10000 -c default_transaction_read_only=off -c work_mem=32MB -c jit=off -c search_path=public",
    );
    expect(child.args[child.args.indexOf("-U") + 1]).toBe("denue_sage");
    child.finish("");
    await p;
  });

  it("rejects an unsafe container with config.bad_container and spawns nothing", async () => {
    await expect(
      runSql(SQL, { container: "--rm; rm -rf /" }),
    ).rejects.toMatchObject({ status: 500, code: "config.bad_container" });
    expect(spawned).toHaveLength(0);
  });
});

describe("runSql errors", () => {
  it("throws a generic 502 and logs the real stderr server-side", async () => {
    const p = runSql(SQL, OPTS);
    await waitForSpawns(1);
    spawned[0]!.fail(3, 'ERROR:  relation "secret_table" does not exist');
    const err = await p.catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: "Upstream query failed",
      status: 502,
      code: "postgres.error",
    });
    expect((err as Error).message).not.toMatch(/secret_table|SELECT|docker/);
    // raw stderr kept on the error for server-side classification only
    expect((err as { stderr?: string }).stderr).toContain("does not exist");
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toMatch(/\[db\] denue-.* exit=3 stderr=ERROR:  relation/);
  });

  it("malformed JSON rejects with generic 502 postgres.parse_error", async () => {
    const p = runJson(SQL, OPTS);
    await waitForSpawns(1);
    spawned[0]!.finish("not json {{");
    await expect(p).rejects.toMatchObject({
      message: "Upstream query failed",
      status: 502,
      code: "postgres.parse_error",
    });
  });

  it("runJson maps empty / null output to []", async () => {
    const p1 = runJson(SQL, OPTS);
    const p2 = runJson(SQL, OPTS);
    await waitForSpawns(2);
    spawned[0]!.finish("  \n");
    spawned[1]!.finish("null\n");
    await expect(p1).resolves.toEqual([]);
    await expect(p2).resolves.toEqual([]);
  });

  it("runJson parses trimmed JSON output", async () => {
    const p = runJson<number[]>(SQL, OPTS);
    await waitForSpawns(1);
    spawned[0]!.finish("[1,2,3]\n");
    await expect(p).resolves.toEqual([1, 2, 3]);
  });
});

describe("cancellation", () => {
  it("abort kills the client and fires pg_cancel_backend for its tag", async () => {
    const ac = new AbortController();
    const p = runSql(SQL, { ...OPTS, signal: ac.signal });
    await waitForSpawns(1);
    const child = spawned[0]!;
    const tag = envArg(child.args, "PGAPPNAME")!;
    ac.abort();
    await expect(p).rejects.toMatchObject({
      status: 502,
      message: "Upstream query failed",
    });
    expect(child.kill).toHaveBeenCalled();
    const cancels = cancelChildren();
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.sql()).toContain("pg_cancel_backend(pid)");
    expect(cancels[0]!.sql()).toContain(`application_name = '${tag}'`);
  });

  it("wall-clock timeout (statement_timeout + 5s) kills and cancels", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = runSql(SQL, { ...OPTS, timeoutMs: 1000 });
    const settled = p.catch((e: unknown) => e);
    await waitForSpawns(1);
    const child = spawned[0]!;
    vi.advanceTimersByTime(5999);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(await settled).toMatchObject({
      status: 502,
      code: "postgres.error",
    });
    expect(child.kill).toHaveBeenCalled();
    expect(cancelChildren()).toHaveLength(1);
  });

  it("an already-aborted signal never spawns", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runSql(SQL, { ...OPTS, signal: ac.signal }),
    ).rejects.toMatchObject({ status: 502 });
    expect(spawned).toHaveLength(0);
  });
});

describe("concurrency", () => {
  it("caps in-flight psql processes at 6 and drains the queue", async () => {
    const ps = Array.from({ length: 10 }, () => runSql(SQL, OPTS));
    await waitForSpawns(6);
    await tick();
    await tick();
    expect(queryChildren()).toHaveLength(6);
    spawned[0]!.finish("a");
    await waitForSpawns(7);
    expect(queryChildren()).toHaveLength(7);
    for (let i = 1; i < 10; i++) {
      await waitForSpawns(i + 1);
      spawned[i]!.finish("x");
    }
    const out = await Promise.all(ps);
    expect(out).toHaveLength(10);
    expect(queryChildren()).toHaveLength(10);
  });
});

describe("runJsonSync (boot resolvers)", () => {
  it("uses the same argv shape with SQL as stdin input", () => {
    mockExecFileSync.mockReturnValueOnce("[2025]\n");
    expect(runJsonSync<number[]>(SQL, OPTS)).toEqual([2025]);
    const [file, args, opts] = mockExecFileSync.mock.calls[0]! as [
      string,
      string[],
      { input: string; timeout: number },
    ];
    expect(file).toBe("docker");
    expect(args.join(" ")).not.toContain("secret_table");
    expect(args.slice(-2)).toEqual(["-f", "-"]);
    expect(envArg(args, "PGOPTIONS")).toContain(
      "default_transaction_read_only=on",
    );
    expect(opts.input).toBe(SQL);
    expect(opts.timeout).toBe(30000);
  });

  it("throws a generic 502 carrying stderr on failure", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(`Command failed: docker exec ${SQL}`), {
        stderr: Buffer.from("FATAL: boom"),
      });
    });
    let err: unknown;
    try {
      runJsonSync(SQL, OPTS);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      message: "Upstream query failed",
      code: "postgres.error",
      stderr: "FATAL: boom",
    });
  });
});
