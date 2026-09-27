import { describe, expect, it, vi } from "vitest";

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }));
vi.mock("./client", () => ({ apiFetch: mockApiFetch }));

import { sageQueryStream, type SageEvent } from "./sage-client";

async function tableEvent(data: Record<string, unknown>) {
  mockApiFetch.mockResolvedValue(
    new Response(`event: table\ndata: ${JSON.stringify(data)}\n\n`),
  );
  const evs: SageEvent[] = [];
  for await (const ev of sageQueryStream("q", null, null)) evs.push(ev);
  return evs.find((e) => e.type === "table");
}

describe("sageQueryStream table event (audit #87 follow-up)", () => {
  it("keeps the server's truncated flag so the UI can show N+ rows", async () => {
    const ev = await tableEvent({
      columns: ["nom_mun"],
      rows: [],
      row_count: 200,
      truncated: true,
    });
    expect(ev).toMatchObject({ row_count: 200, truncated: true });
  });

  it("treats a missing flag as not truncated", async () => {
    const ev = await tableEvent({ columns: [], rows: [], row_count: 3 });
    expect(ev).toMatchObject({ row_count: 3, truncated: false });
  });
});
