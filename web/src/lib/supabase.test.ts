// @vitest-environment jsdom
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { supabase } from "./supabase";

// The auth-only client (audit #179) must look exactly like the auth
// client createClient() built: same storage key (or every signed-in user
// is logged out by the deploy), same auth URL, same apikey/Authorization.
describe("auth-only Supabase client", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  afterAll(() => vi.restoreAllMocks());

  it("matches the auth client createClient() used to build", () => {
    type Internals = {
      storageKey: string;
      url: string;
      headers: Record<string, string>;
    };
    const ours = supabase.auth as unknown as Internals;
    const url = ours.url.replace(/\/auth\/v1$/, "");
    const key = ours.headers["apikey"] ?? "";
    const reference = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
      },
    }).auth as unknown as Internals;

    expect(ours.storageKey).toBe(reference.storageKey);
    expect(ours.storageKey).toMatch(/^sb-.+-auth-token$/);
    expect(ours.url).toBe(reference.url);
    expect(ours.headers["apikey"]).toBe(reference.headers["apikey"]);
    expect(ours.headers["Authorization"]).toBe(
      reference.headers["Authorization"],
    );
  });
});
