import { ApiError, GoogleGenAI } from "@google/genai";

/**
 * Every model call goes through here. Free Gemini models are tried in order; one that reports
 * its quota exhausted is set aside until the quota resets and never asked again before then,
 * across runs. When none is usable the caller gets a QuotaError and carries the work over,
 * or, on a machine with Ollama running, the local model takes over.
 */

/** heavy: judgement that needs the best model. light: bulk classification that any model can do. */
export type Weight = "heavy" | "light";

const list = (env: string | undefined, fallback: string[]) =>
  env
    ? env
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean)
    : fallback;

// Light work starts on the Flash-Lite models to keep the Flash models' small daily quotas for scoring.
// Gemma is last in both: when measured it was free but mostly answering with server errors.
const HEAVY_ORDER = list(process.env.GEMINI_MODELS_HEAVY, [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
]);
const LIGHT_ORDER = list(process.env.GEMINI_MODELS_LIGHT, [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
]);

const START_SPACING_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 6000);
const MAX_SPACING_MS = 60_000;
const MAX_CALLS = Number(process.env.LLM_MAX_CALLS_PER_RUN ?? 150);
const REQUEST_TIMEOUT_MS = 75_000;
const OVERLOAD_COOLDOWN_MS = 10 * 60_000;
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";

/** No model can take more work right now. Callers stop and leave the rest queued. */
export class QuotaError extends Error {}

export interface LlmRequest {
  prompt: string;
  /** JSON Schema the reply must match. */
  schema: object;
  pdf?: Buffer;
}

/** Sends one request to one model and returns the reply text. `plainJson`: the model can't take a schema. */
export type Send = (model: string, req: LlmRequest, plainJson: boolean) => Promise<string>;

/** Remembers which models are exhausted, so separate runs don't each rediscover it with a refused request. */
export interface LlmStore {
  load(): Promise<Record<string, string>>;
  save(model: string, exhaustedUntil: Date): Promise<void>;
}

interface ModelState {
  exhaustedUntil: number;
  coolUntil: number;
  spacingMs: number;
  lastCallAt: number;
  plainJson: boolean;
}

interface Config {
  provider: "gemini" | "ollama";
  sendGemini: Send;
  sendOllama: Send;
  store: LlmStore | null;
  /** May a Gemini run that finds every model unusable hand over to Ollama? Never in the cloud. */
  ollamaFallback: boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const states = new Map<string, ModelState>();
let calls = 0;
let loaded = false;
let ollamaUp: boolean | null = null;

const statusOf = (err: unknown) => (err instanceof ApiError ? err.status : Number((err as { status?: number })?.status) || 0);
const isNetworkFailure = (err: unknown) =>
  statusOf(err) === 0 && /timeout|timed out|abort|fetch failed|ECONNRESET|socket/i.test(`${(err as Error)?.name} ${(err as Error)?.message}`);

export type QuotaKind = { kind: "minute"; retryMs: number } | { kind: "day" };

/**
 * Reads a 429 body. A per-minute limit says when to retry; anything else (a per-day limit, or
 * no detail at all) is treated as exhausted for the day, which is the safe reading.
 */
export function classifyQuota(message: string): QuotaKind {
  let details: { "@type"?: string; violations?: { quotaId?: string; quotaMetric?: string }[]; retryDelay?: string }[] = [];
  try {
    details = JSON.parse(message.slice(message.indexOf("{")))?.error?.details ?? [];
  } catch {
    return { kind: "day" };
  }
  const ids = details.flatMap((d) => d.violations ?? []).map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`);
  if (ids.some((id) => /per_?day/i.test(id))) return { kind: "day" };
  if (!ids.some((id) => /per_?minute/i.test(id))) return { kind: "day" };
  const delay = details.find((d) => d.retryDelay)?.retryDelay;
  const seconds = delay ? parseFloat(delay) : NaN;
  return { kind: "minute", retryMs: Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 60_000 };
}

/** Gemini daily quotas reset at midnight Pacific time. Returns that instant plus a small margin. */
export function nextQuotaReset(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000;
  return new Date(now.getTime() + (86_400_000 - elapsed) + 5 * 60_000);
}

const JSON_ONLY = (schema: object) =>
  `Reply with ONLY a JSON object (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(schema)}`;

let genai: GoogleGenAI | null = null;
const sendGemini: Send = async (model, req, plainJson) => {
  if (!genai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY must be set");
    // Overloaded models can hold a request for minutes before failing; cut that short and move on.
    genai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  }
  const text = plainJson ? `${req.prompt}\n\n${JSON_ONLY(req.schema)}` : req.prompt;
  const parts = req.pdf
    ? [{ inlineData: { mimeType: "application/pdf", data: req.pdf.toString("base64") } }, { text }]
    : [{ text }];
  const res = await genai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: plainJson
      ? { temperature: 0.2 }
      : { temperature: 0.2, responseMimeType: "application/json", responseJsonSchema: req.schema },
  });
  return res.text ?? "";
};

const sendOllama: Send = async (model, req) => {
  if (req.pdf) throw new Error("The local model can't read PDFs; upload the resume as plain text");
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: req.schema,
      messages: [{ role: "user", content: req.prompt }],
      options: { temperature: 0.2, num_ctx: 16_384 },
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
};

const config: Config = {
  provider: process.env.LLM_PROVIDER === "ollama" ? "ollama" : "gemini",
  sendGemini,
  sendOllama,
  store: null,
  ollamaFallback: !process.env.CI && !process.env.VERCEL && process.env.OLLAMA_FALLBACK !== "false",
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export function configureLlm(overrides: Partial<Config>): void {
  Object.assign(config, overrides);
}

/** Test hook: forget everything learned about models in this process. */
export function resetLlm(): void {
  states.clear();
  calls = 0;
  loaded = false;
  ollamaUp = null;
}

export function llmCallCount(): number {
  return calls;
}

function state(model: string): ModelState {
  let s = states.get(model);
  if (!s) {
    // Gemma is served without JSON-schema mode; it is asked in the prompt instead.
    s = { exhaustedUntil: 0, coolUntil: 0, spacingMs: START_SPACING_MS, lastCallAt: 0, plainJson: model.startsWith("gemma") };
    states.set(model, s);
  }
  return s;
}

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  if (!config.store) return;
  try {
    for (const [model, until] of Object.entries(await config.store.load())) {
      state(model).exhaustedUntil = new Date(until).getTime();
    }
  } catch (err) {
    console.warn(`  couldn't load model quota state (${(err as Error).message}); continuing without it`);
  }
}

async function exhaust(model: string): Promise<void> {
  const until = nextQuotaReset(new Date(config.now()));
  state(model).exhaustedUntil = until.getTime();
  console.warn(`  ${model} is out of quota; not used again until ${until.toISOString()}`);
  await config.store?.save(model, until).catch((err) => console.warn(`  couldn't save quota state: ${(err as Error).message}`));
}

const usable = (model: string) => {
  const s = state(model);
  return s.exhaustedUntil <= config.now() && s.coolUntil <= config.now();
};

async function ollamaReachable(): Promise<boolean> {
  if (ollamaUp !== null) return ollamaUp;
  try {
    ollamaUp = (await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    ollamaUp = false;
  }
  return ollamaUp;
}

function countCall(): void {
  if (calls >= MAX_CALLS) throw new QuotaError(`Model call budget of ${MAX_CALLS} per run reached`);
  calls++;
}

async function viaOllama(req: LlmRequest): Promise<{ text: string; model: string }> {
  countCall();
  return { text: await config.sendOllama(OLLAMA_MODEL, req, false), model: `ollama:${OLLAMA_MODEL}` };
}

async function run(req: LlmRequest, weight: Weight): Promise<{ text: string; model: string }> {
  if (config.provider === "ollama") return viaOllama(req);
  await load();

  // PDFs need a multimodal Gemini model.
  const order = (weight === "heavy" ? HEAVY_ORDER : LIGHT_ORDER).filter((m) => !req.pdf || m.startsWith("gemini-"));
  const retriedMinute = new Set<string>();
  for (;;) {
    const model = order.find(usable);
    if (!model) break;
    const s = state(model);
    countCall();
    const wait = s.lastCallAt + s.spacingMs - config.now();
    if (wait > 0) await config.sleep(wait);
    s.lastCallAt = config.now();
    try {
      return { text: await config.sendGemini(model, req, s.plainJson), model };
    } catch (err) {
      const status = statusOf(err);
      const message = (err as Error)?.message ?? "";
      if (status === 429) {
        const quota = classifyQuota(message);
        if (quota.kind === "minute" && !retriedMinute.has(model)) {
          // Going too fast for this model: wait as told, slow down, and give it one more try.
          retriedMinute.add(model);
          s.spacingMs = Math.min(s.spacingMs * 2, MAX_SPACING_MS);
          await config.sleep(quota.retryMs + 1000);
        } else {
          await exhaust(model);
        }
      } else if (status === 404) {
        s.exhaustedUntil = Infinity; // model retired
      } else if (status === 400 && !s.plainJson && /json|schema|mime/i.test(message)) {
        s.plainJson = true;
      } else if (status >= 500 || isNetworkFailure(err)) {
        s.coolUntil = config.now() + OVERLOAD_COOLDOWN_MS;
        console.warn(`  ${model} is overloaded (${status || "timeout"}); trying the next model`);
      } else {
        throw err;
      }
    }
  }

  if (!req.pdf && config.ollamaFallback && (await ollamaReachable())) {
    console.warn(`  no Gemini model is available; using local ${OLLAMA_MODEL}`);
    return viaOllama(req);
  }
  throw new QuotaError("Every Gemini model is out of quota or overloaded");
}

function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("The model's reply contained no JSON");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** Structured output, plus which model produced it. */
export async function generate<T>(prompt: string, schema: object, weight: Weight = "heavy"): Promise<{ data: T; model: string }> {
  const { text, model } = await run({ prompt, schema }, weight);
  return { data: parseJson<T>(text), model };
}

export async function generateJson<T>(prompt: string, schema: object, weight: Weight = "heavy"): Promise<T> {
  return (await generate<T>(prompt, schema, weight)).data;
}

/** Reads a PDF directly (no local PDF parsing) and returns JSON matching `schema`. Gemini only. */
export async function readPdfJson<T>(pdf: Buffer, prompt: string, schema: object): Promise<T> {
  const { text } = await run({ prompt, schema, pdf }, "heavy");
  return parseJson<T>(text);
}
