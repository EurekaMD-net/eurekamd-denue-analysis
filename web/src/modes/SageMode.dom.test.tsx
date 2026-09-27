// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the store pulls in the auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));
vi.mock("../api/sage-client", () => ({
  fetchSageHealth: vi.fn(),
  fetchSageThread: vi.fn(),
  sageQueryStream: vi.fn(),
}));

import { ApiError } from "../api/client";
import {
  fetchSageHealth,
  fetchSageThread,
  sageQueryStream,
  type SageEvent,
} from "../api/sage-client";
import { listSavedThreads, upsertThread } from "../lib/sage-threads-store";
import { useUiStore } from "../store";
import { SageMode } from "./SageMode";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const healthMock = fetchSageHealth as unknown as ReturnType<typeof vi.fn>;
const streamMock = sageQueryStream as unknown as ReturnType<typeof vi.fn>;
const threadMock = fetchSageThread as unknown as ReturnType<typeof vi.fn>;

const CONFIGURED = {
  configured: true,
  provider: "test",
  router_model: "router",
};

/**
 * A stream the test drives event by event. It stays open until end() and
 * rejects with AbortError when the caller's signal aborts, as fetch does.
 */
function controlledStream() {
  const queue: SageEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const state = { signal: null as AbortSignal | null };
  streamMock.mockImplementation(async function* (
    _q: string,
    _t: string | null,
    _tok: string | null,
    signal: AbortSignal,
  ) {
    state.signal = signal;
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((resolve, reject) => {
        wake = resolve;
        if (signal.aborted)
          reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }
  });
  return {
    state,
    async push(...evs: SageEvent[]) {
      queue.push(...evs);
      wake?.();
      await flush();
    },
    async end() {
      ended = true;
      wake?.();
      await flush();
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let frames: Map<number, FrameRequestCallback>;
let scrollTo: ReturnType<typeof vi.fn>;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function runFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  });
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  act(() => {
    (el as HTMLElement).click();
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
}

function exampleButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter((b) =>
    b.textContent?.startsWith("¿Qué municipios"),
  );
}

function typeAndSubmit(text: string) {
  const ta = container.querySelector("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  click(buttonByText("Enviar"));
}

async function renderMode() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SageMode />
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  healthMock.mockReset();
  healthMock.mockResolvedValue(CONFIGURED);
  streamMock.mockReset();
  threadMock.mockReset();
  frames = new Map();
  let nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  scrollTo = vi.fn();
  Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
  localStorage.clear();
  useUiStore.setState({
    session: {
      access_token: "test-token",
      user: { id: "u1" },
    } as Session,
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SageMode stream lifecycle (#177)", () => {
  it("aborts the in-flight stream when the page unmounts", async () => {
    const s = controlledStream();
    await renderMode();
    click(exampleButtons()[0]);
    await s.push({ type: "thread", thread_id: "t-1" });
    expect(s.state.signal?.aborted).toBe(false);

    act(() => root.unmount());
    // Old code: no unmount cleanup, the signal stayed live.
    expect(s.state.signal?.aborted).toBe(true);
    root = createRoot(container); // afterEach unmounts again
  });
});

describe("SageMode error codes (#185)", () => {
  async function failWith(err: unknown): Promise<string> {
    streamMock.mockImplementation(async function* () {
      throw err;
    });
    await renderMode();
    click(exampleButtons()[0]);
    await flush();
    return container.querySelector(".bg-red-950")?.textContent ?? "";
  }

  it("classifies on ApiError.status, not digits in the message", async () => {
    // Old code: the regex found "100" and labelled it HTTP_100.
    expect(await failWith(new ApiError("límite 100 consultas", 429))).toBe(
      "RATE_LIMITED: límite 100 consultas",
    );
  });

  it("maps a 503 whose message has no digits", async () => {
    // Old code: NETWORK.
    expect(await failWith(new ApiError("Service Unavailable", 503))).toBe(
      "PROVIDER_UNAVAILABLE: Service Unavailable",
    );
  });

  it("prefers the backend's own error code", async () => {
    expect(
      await failWith(
        new ApiError("thread has reached the cap", 429, "THREAD_TURN_CAP"),
      ),
    ).toBe("THREAD_TURN_CAP: thread has reached the cap");
  });

  it("keeps NETWORK for non-HTTP failures", async () => {
    expect(await failWith(new TypeError("Failed to fetch"))).toBe(
      "NETWORK: Failed to fetch",
    );
  });
});

describe("SageMode streaming renders (#186)", () => {
  it("batches deltas per animation frame and flushes before later events", async () => {
    const s = controlledStream();
    await renderMode();
    click(exampleButtons()[0]);
    await s.push(
      { type: "thread", thread_id: "t-1" },
      { type: "delta", text: "Hola" },
      { type: "delta", text: " mundo" },
    );
    const narrative = () =>
      container.querySelector(".whitespace-pre-wrap")?.textContent;
    // Old code applied each delta immediately.
    expect(narrative()).toBe("…");
    expect(frames.size).toBe(1);
    runFrames();
    expect(narrative()).toBe("Hola mundo");

    // A pending delta lands before the event that follows it.
    await s.push({ type: "delta", text: "!" }, { type: "done", turn_id: null });
    expect(narrative()).toBe("Hola mundo!");
    expect(frames.size).toBe(0);
    await s.end();
    expect(buttonByText("Nuevo hilo")).toBeDefined();
  });

  it("scrolls with behavior auto while streaming", async () => {
    const s = controlledStream();
    await renderMode();
    click(exampleButtons()[0]);
    scrollTo.mockClear();
    await s.push({ type: "delta", text: "a" });
    runFrames();
    const behaviors = scrollTo.mock.calls.map(
      (c) => (c[0] as ScrollToOptions).behavior,
    );
    expect(behaviors.length).toBeGreaterThan(0);
    // Old code: always "smooth".
    expect(behaviors.every((b) => b === "auto")).toBe(true);
    await s.end();
  });

  it("does not re-render earlier turns while a new turn streams", async () => {
    const s = controlledStream();
    await renderMode();
    click(exampleButtons()[0]);
    await s.push(
      { type: "thread", thread_id: "t-1" },
      { type: "table", columns: ["n"], rows: [{ n: 5000 }], row_count: 1 },
      { type: "done", turn_id: null },
    );
    await s.end();
    click(buttonByText("Tabla (1)"));
    expect(container.querySelector("td")?.textContent).toBe(
      (5000).toLocaleString("es-MX"),
    );

    const s2 = controlledStream();
    typeAndSubmit("segunda pregunta");
    await flush();
    // formatCell formats the first turn's 5000 with toLocaleString, so
    // any re-render of that TurnCard calls it (old code: once per event).
    const spy = vi.spyOn(Number.prototype, "toLocaleString");
    await s2.push({
      type: "route",
      payload: { kind: "decline", reasoning: "x" },
    });
    await s2.push({ type: "delta", text: "b" });
    runFrames();
    expect(spy).not.toHaveBeenCalled();
    await s2.end();
  });
});

describe("SageMode provider gate (#187)", () => {
  it("disables the example questions while the provider is unconfigured", async () => {
    healthMock.mockResolvedValue({ ...CONFIGURED, configured: false });
    await renderMode();
    const examples = exampleButtons();
    expect(examples.length).toBe(1);
    // Old code: example buttons ignored the gate.
    expect(examples[0]!.disabled).toBe(true);
    click(examples[0]);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("shows a failed health check with a retry", async () => {
    healthMock.mockRejectedValueOnce(new ApiError("boom", 500));
    await renderMode();
    // Old code rendered nothing for health.isError.
    expect(container.textContent).toContain("no se pudo verificar el provider");
    expect(exampleButtons()[0]!.disabled).toBe(true);

    click(buttonByText("reintentar"));
    await flush();
    expect(healthMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("no se pudo verificar");
    expect(exampleButtons()[0]!.disabled).toBe(false);
  });
});

describe("SageMode thread ownership (#11/#82/#89)", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";

  function savedIds(): string[] {
    return listSavedThreads("u1").map((e) => e.thread_id);
  }

  function saveThread(question: string) {
    upsertThread("u1", {
      thread_id: T1,
      first_question: question,
      last_question: question,
      turn_count: 1,
      updated_at: 1,
    });
  }

  it("drops a thread the server 404s on a follow-up and starts a new one", async () => {
    const s = controlledStream();
    await renderMode();
    click(exampleButtons()[0]);
    await s.push(
      { type: "thread", thread_id: T1 },
      { type: "narrative", text: "ok" },
      { type: "done", turn_id: "turn-1" },
    );
    await s.end();
    expect(savedIds()).toEqual([T1]);

    streamMock.mockImplementation(async function* () {
      throw new ApiError("thread not found.", 404, "THREAD_NOT_FOUND");
    });
    typeAndSubmit("segunda pregunta");
    await flush();
    expect(streamMock.mock.calls[1]?.[1]).toBe(T1);
    expect(container.textContent).toContain(
      "THREAD_NOT_FOUND: thread not found.",
    );
    // Old code: the gone thread stayed in the index and stayed current.
    expect(savedIds()).toEqual([]);

    typeAndSubmit("tercera pregunta");
    await flush();
    // Old code: every later question re-sent T1 and 404ed again.
    expect(streamMock.mock.calls[2]?.[1]).toBeNull();
  });

  it("keeps the thread on a non-404 follow-up failure", async () => {
    const s = controlledStream();
    await renderMode();
    click(exampleButtons()[0]);
    await s.push({ type: "thread", thread_id: T1 }, { type: "done", turn_id: "t" });
    await s.end();
    streamMock.mockImplementation(async function* () {
      throw new ApiError("Service Unavailable", 503);
    });
    typeAndSubmit("segunda pregunta");
    await flush();
    typeAndSubmit("tercera pregunta");
    await flush();
    expect(savedIds()).toEqual([T1]);
    expect(streamMock.mock.calls[2]?.[1]).toBe(T1);
  });

  it("restores a persisted failed turn with its error", async () => {
    saveThread("pregunta fallida");
    threadMock.mockResolvedValue({
      thread_id: T1,
      turns: [
        {
          turn_id: "turn-1",
          created_at: "2026-09-27T00:00:00Z",
          question: "pregunta fallida",
          route: { kind: "sql" },
          digest: { columns: [], row_count: 0, first_5_rows: [] },
          narrative: "",
          error: { code: "SQL_GATE_REJECTED", message: "consulta rechazada" },
        },
      ],
    });
    await renderMode();
    click(buttonByText("pregunta fallida"));
    await flush();
    // Old code hydrated error: null, so the card showed an empty narrative.
    expect(container.querySelector(".bg-red-950")?.textContent).toBe(
      "SQL_GATE_REJECTED: consulta rechazada",
    );
  });

  it("drops a thread from the index when loading it 404s", async () => {
    saveThread("hilo ajeno");
    threadMock.mockRejectedValue(
      new ApiError("thread not found.", 404, "THREAD_NOT_FOUND"),
    );
    await renderMode();
    click(buttonByText("hilo ajeno"));
    await flush();
    expect(savedIds()).toEqual([]);
    expect(container.textContent).toContain(
      "Este hilo ya no existe en el servidor.",
    );
  });
});
