import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "./client";
import { fetchSageThread, sageQueryStream, type SageEvent } from "./sage-client";

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

async function tableEvent(data: Record<string, unknown>) {
  fetchMock.mockResolvedValue(
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

describe("fetchSageThread thread_id validation (#92)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ thread_id: "x", turns: [] })),
    );
  });

  it.each([
    "-".repeat(36),
    "0123456789abcdef0123456789abcdef0123",
    "11111111-1111-1111-1111-11111111111-",
  ])("rejects the non-UUID %s without a request", async (id) => {
    // Old code: /^[0-9a-f-]{36}$/ accepted these and hit the server.
    await expect(fetchSageThread(id, null)).rejects.toThrow("Invalid threadId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a well-formed UUID", async () => {
    const id = "11111111-1111-4111-8111-11111111ABCD";
    await fetchSageThread(id, null);
    expect(fetchMock).toHaveBeenCalledWith(`/sage/thread/${id}`, {}, null);
  });
});
