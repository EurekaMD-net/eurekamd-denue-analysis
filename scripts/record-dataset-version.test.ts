import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

import {
  buildRecordSql,
  dollarQuote,
  parseArgs,
  run,
} from "./record-dataset-version.js";

beforeEach(() => mockExec.mockReset());

/** The literal a dollar-quoted string denotes, parsed the way Postgres does. */
function unquote(q: string): string {
  const tag = /^\$[a-z0-9]*\$/.exec(q)![0];
  const body = q.slice(tag.length);
  const end = body.indexOf(tag);
  expect(end + tag.length).toBe(body.length); // closes exactly at the end
  return body.slice(0, end);
}

describe("dollarQuote", () => {
  it.each([
    "05/2026",
    "it's",
    "$v$",
    "a$v$b",
    "$v",
    "ends with $",
    "$v1$ and $v$",
    "'); DROP TABLE dataset_versions; --",
    "Marco Geoestadístico",
  ])("round-trips %j without an early close", (value) => {
    expect(unquote(dollarQuote(value))).toBe(value);
  });
});

describe("parseArgs", () => {
  it("requires --dataset and --edition", () => {
    expect(() => parseArgs(["--edition=05/2026"])).toThrow(/required/);
    expect(() => parseArgs(["--dataset=denue"])).toThrow(/required/);
  });

  it("parses --rows as an integer", () => {
    const { version } = parseArgs(["--dataset=denue", "--edition=05/2026", "--rows=6138075"]);
    expect(version.rows).toBe(6138075);
  });

  it.each(["1e3", "-1", "12.5", "", "0x10", "99999999999999999999"])(
    "refuses --rows=%j",
    (rows) => {
      expect(() => parseArgs(["--dataset=denue", "--edition=x", `--rows=${rows}`])).toThrow(
        /non-negative integer/,
      );
    },
  );

  it("refuses unknown flags (a typo must not be dropped silently)", () => {
    expect(() => parseArgs(["--dataset=denue", "--edition=x", "--row=5"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--dataset=denue", "--edition=x", "extra"])).toThrow(/unknown argument/);
  });

  it("refuses a dataset that is not a lowercase slug", () => {
    for (const d of ["DENUE", "denue data", "denue;drop", "1denue", ""]) {
      expect(() => parseArgs([`--dataset=${d}`, "--edition=x"])).toThrow(/--dataset/);
    }
  });

  it("refuses empty text values and control characters", () => {
    expect(() => parseArgs(["--dataset=denue", "--edition= "])).toThrow(/--edition is empty/);
    expect(() => parseArgs(["--dataset=denue", "--edition=x\n\\! id"])).toThrow(/control character/);
    expect(() => parseArgs(["--dataset=denue", "--edition=x", "--note=a\u0000b"])).toThrow(
      /control character/,
    );
  });

  it("refuses a flag given twice", () => {
    expect(() => parseArgs(["--dataset=a", "--dataset=b", "--edition=x"])).toThrow(
      /--dataset given more than once/,
    );
    expect(() => parseArgs(["--dataset=denue", "--edition=x", "--rows=1", "--rows=2"])).toThrow(
      /--rows given more than once/,
    );
  });

  it("trims values, so a trailing space cannot create a second edition", () => {
    const { version } = parseArgs(["--dataset= denue", "--edition=05/2026 ", "--source= INEGI "]);
    expect(version).toEqual({ dataset: "denue", edition: "05/2026", source: "INEGI" });
    expect(buildRecordSql(version)).toContain("VALUES ($v$denue$v$, $v$05/2026$v$, $v$INEGI$v$,");
    expect(() => parseArgs(["--dataset=denue", "--edition=   "])).toThrow(/--edition is empty/);
    expect(() => buildRecordSql({ dataset: "denue", edition: "05/2026 " })).toThrow(/whitespace/);
  });

  it("keeps '=' inside a value and reads --apply", () => {
    const { version, apply } = parseArgs(["--dataset=denue", "--edition=a=b", "--apply"]);
    expect(version.edition).toBe("a=b");
    expect(apply).toBe(true);
  });
});

describe("buildRecordSql", () => {
  it("upserts on (dataset, edition), refreshing loaded_at and keeping unset fields", () => {
    const sql = buildRecordSql({ dataset: "denue", edition: "05/2026", rows: 6138075 });
    expect(sql).toContain("INSERT INTO public.dataset_versions (dataset, edition, source, row_count, note)");
    expect(sql).toContain("VALUES ($v$denue$v$, $v$05/2026$v$, NULL, 6138075, NULL)");
    expect(sql).toContain("ON CONFLICT (dataset, edition) DO UPDATE SET");
    expect(sql).toContain("row_count = COALESCE(EXCLUDED.row_count, dataset_versions.row_count)");
    expect(sql).toContain("loaded_at = now()");
    expect(sql).toContain("source = COALESCE(EXCLUDED.source, dataset_versions.source)");
    expect(sql).toContain("note = COALESCE(EXCLUDED.note, dataset_versions.note)");
  });

  it("never lets a value close its literal", () => {
    const hostile = "x$v$); DROP TABLE dataset_versions; --";
    const sql = buildRecordSql({ dataset: "denue", edition: "e", note: hostile });
    const values = /VALUES \((.*)\)\n/.exec(sql)![1]!;
    const noteLit = values.slice(values.lastIndexOf(", ") + 2);
    expect(unquote(noteLit)).toBe(hostile);
    expect(noteLit.startsWith("$v1$")).toBe(true);
  });

  it("validates when called directly", () => {
    expect(() => buildRecordSql({ dataset: "Bad", edition: "e" })).toThrow(/--dataset/);
    expect(() => buildRecordSql({ dataset: "denue", edition: "e", rows: 1.5 })).toThrow(/integer/);
  });
});

describe("run", () => {
  const argv = ["--dataset=denue", "--edition=05/2026", "--rows=6138075"];

  it("prints the SQL and runs nothing without --apply", () => {
    const out = run(argv, "supabase-db");
    expect(out).toContain("INSERT INTO public.dataset_versions");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("pipes the SQL into one psql transaction with --apply", () => {
    mockExec.mockReturnValue("denue|05/2026|6138075|now\n");
    const out = run([...argv, "--apply"], "supabase-db");
    expect(out).toBe("denue|05/2026|6138075|now\n");
    const [cmd, args, opts] = mockExec.mock.calls[0]!;
    expect(cmd).toBe("docker");
    expect(args).toEqual(expect.arrayContaining(["exec", "-i", "supabase-db", "psql", "--single-transaction"]));
    expect(opts.input).toContain("VALUES ($v$denue$v$, $v$05/2026$v$, NULL, 6138075, NULL)");
  });

  it("refuses an unsafe container name before running docker", () => {
    expect(() => run([...argv, "--apply"], "--rm")).toThrow(/unsafe container/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
