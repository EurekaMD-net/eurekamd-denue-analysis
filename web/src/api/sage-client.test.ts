import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "./client";
import { fetchSageThread } from "./sage-client";

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

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
