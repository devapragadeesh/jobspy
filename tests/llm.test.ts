import { beforeEach, describe, expect, it } from "vitest";
import { classifyQuota, configureLlm, generate, generateJson, nextQuotaReset, QuotaError, resetLlm, type Send } from "@/lib/llm";

const SCHEMA = { type: "object" };
const apiError = (status: number, body: object | string = {}) =>
  Object.assign(new Error(typeof body === "string" ? body : JSON.stringify(body)), { status });

const perDay = {
  error: {
    code: 429,
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
    ],
  },
};
const perMinute = {
  error: {
    code: 429,
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17.5s" },
    ],
  },
};

describe("classifyQuota", () => {
  it("reads a per-minute limit and its retry delay", () => {
    expect(classifyQuota(JSON.stringify(perMinute))).toEqual({ kind: "minute", retryMs: 17_500 });
  });
  it("treats a per-day limit as exhausted even when a retry delay is given", () => {
    expect(classifyQuota(JSON.stringify(perDay))).toEqual({ kind: "day" });
  });
  it("treats a 429 without details, or an unparseable one, as exhausted", () => {
    expect(classifyQuota('{"error":{"code":429,"message":"You exceeded your current quota"}}')).toEqual({ kind: "day" });
    expect(classifyQuota("quota exceeded")).toEqual({ kind: "day" });
  });
});

describe("nextQuotaReset", () => {
  it("is the next midnight in Pacific time", () => {
    // 2026-10-04 13:00 UTC is 06:00 PDT, so the reset is 18 hours later (plus the margin).
    const reset = nextQuotaReset(new Date("2026-10-04T13:00:00Z"));
    expect(reset.toISOString()).toBe("2026-10-05T07:05:00.000Z");
  });
});

describe("model rotation", () => {
  let now: number;
  let sent: string[];
  let slept: number[];
  let saved: Record<string, string>;

  const setup = (send: Send, stored: Record<string, string> = {}) => {
    resetLlm();
    now = Date.parse("2026-10-04T13:00:00Z");
    sent = [];
    slept = [];
    saved = {};
    configureLlm({
      provider: "gemini",
      ollamaFallback: false,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
      store: { load: async () => stored, save: async (model, until) => void (saved[model] = until.toISOString()) },
      sendGemini: async (model, req, plain) => {
        sent.push(model);
        return send(model, req, plain);
      },
      sendOllama: async () => '{"from":"ollama"}',
    });
  };
  beforeEach(() => setup(async () => '{"ok":true}'));

  it("starts heavy work on the best Flash model and light work on Flash-Lite", async () => {
    expect((await generate("p", SCHEMA, "heavy")).model).toBe("gemini-3.8-flash");
    expect((await generate("p", SCHEMA, "light")).model).toBe("gemini-3.5-flash-lite");
  });

  it("sets an exhausted model aside until the reset, saves that, and never asks it again", async () => {
    setup(async (model) => {
      if (model === "gemini-3.8-flash") throw apiError(429, perDay);
      return '{"ok":true}';
    });
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.7-flash");
    expect(saved["gemini-3.8-flash"]).toBe("2026-10-05T07:05:00.000Z");
    await generate("p", SCHEMA);
    expect(sent.filter((m) => m === "gemini-3.8-flash")).toHaveLength(1);
  });

  it("skips models another run already found exhausted, without sending them a request", async () => {
    setup(async () => '{"ok":true}', { "gemini-3.8-flash": "2026-10-05T07:05:00.000Z", "gemini-3.7-flash": "2026-10-05T07:05:00.000Z" });
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.6-flash");
    expect(sent).toEqual(["gemini-3.6-flash"]);
  });

  it("uses a model again once its reset time has passed", async () => {
    setup(async () => '{"ok":true}', { "gemini-3.8-flash": "2026-10-04T12:00:00.000Z" });
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.8-flash");
  });

  it("waits out a per-minute limit and retries the same model once", async () => {
    let first = true;
    setup(async () => {
      if (first) {
        first = false;
        throw apiError(429, perMinute);
      }
      return '{"ok":true}';
    });
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.8-flash");
    expect(slept).toContain(18_500);
    expect(saved).toEqual({});
  });

  it("gives up on a model for the day when the per-minute retry is refused too", async () => {
    setup(async (model) => {
      if (model === "gemini-3.8-flash") throw apiError(429, perMinute);
      return '{"ok":true}';
    });
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.7-flash");
    expect(sent.filter((m) => m === "gemini-3.8-flash")).toHaveLength(2);
    expect(saved["gemini-3.8-flash"]).toBeDefined();
  });

  it("moves past an overloaded model without marking it exhausted", async () => {
    setup(async (model) => {
      if (model === "gemini-3.8-flash") throw apiError(503, "overloaded");
      return '{"ok":true}';
    });
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.7-flash");
    expect(saved).toEqual({});
    // Still cooling down on the next call…
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.7-flash");
    // …and tried again after ten minutes.
    now += 11 * 60_000;
    setupSendOk();
    expect((await generate("p", SCHEMA)).model).toBe("gemini-3.8-flash");
  });
  const setupSendOk = () => configureLlm({ sendGemini: async (model) => (sent.push(model), '{"ok":true}') });

  it("throws QuotaError when every model is exhausted, and does not use Ollama in the cloud", async () => {
    setup(async () => {
      throw apiError(429, perDay);
    });
    await expect(generateJson("p", SCHEMA)).rejects.toBeInstanceOf(QuotaError);
    expect(new Set(sent).size).toBe(8);
    expect(sent).toHaveLength(8);
    // A second call sends nothing at all.
    await expect(generateJson("p", SCHEMA)).rejects.toBeInstanceOf(QuotaError);
    expect(sent).toHaveLength(8);
  });

  it("does not swallow errors that aren't about capacity", async () => {
    setup(async () => {
      throw apiError(403, "API key not valid");
    });
    await expect(generateJson("p", SCHEMA)).rejects.toThrow("API key not valid");
    expect(sent).toHaveLength(1);
  });

  it("asks Gemma for JSON in the prompt, and parses a fenced reply", async () => {
    const plainFlags: Record<string, boolean> = {};
    setup(async (model, _req, plain) => {
      plainFlags[model] = plain;
      if (model.startsWith("gemini")) throw apiError(429, perDay);
      return 'Here you go:\n```json\n{"keep":[1,2]}\n```';
    });
    expect(await generateJson("p", SCHEMA, "light")).toEqual({ keep: [1, 2] });
    expect(plainFlags["gemini-3.5-flash-lite"]).toBe(false);
    expect(plainFlags["gemma-4-31b-it"]).toBe(true);
  });

  it("sends everything to Ollama when asked to", async () => {
    configureLlm({ provider: "ollama" });
    expect(await generate("p", SCHEMA)).toEqual({ data: { from: "ollama" }, model: "ollama:qwen2.5:7b" });
    expect(sent).toEqual([]);
  });
});
