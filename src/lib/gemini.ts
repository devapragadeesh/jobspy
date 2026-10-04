import { ApiError, GoogleGenAI } from "@google/genai";
import type { Source } from "./types";

// Tried in order. Free-tier models are often overloaded (503) and each has its own quota (429),
// so a call moves on to the next model instead of giving up.
const MODELS = (
  process.env.GEMINI_MODEL ||
  "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const ATTEMPTS_PER_MODEL = 2;
// Free tier is rate limited per minute; space calls out rather than burst and retry.
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4500);
const MAX_CALLS = Number(process.env.GEMINI_MAX_CALLS_PER_RUN ?? 150);
const REQUEST_TIMEOUT_MS = 75_000;

/**
 * Thrown when Gemini can't take more work this run: the call budget is spent, or every
 * configured model is out of quota or overloaded. Callers stop and carry work over.
 */
export class QuotaError extends Error {}

let ai: GoogleGenAI | null = null;
let lastCallAt = 0;
let calls = 0;
let modelIndex = 0;
// Search grounding is not included in every tier; once refused, stop asking for the rest of the run.
let searchAvailable = true;

function client(): GoogleGenAI {
  if (ai) return ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY must be set");
  // Overloaded models can hold a request for minutes before failing; cut that short and move on.
  ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  return ai;
}

export function geminiCallCount(): number {
  return calls;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (err: unknown) => (err instanceof ApiError ? err.status : 0);
const isNetworkFailure = (err: unknown) =>
  !(err instanceof ApiError) && /timeout|timed out|abort|fetch failed|ECONNRESET|socket/i.test(`${(err as Error)?.name} ${(err as Error)?.message}`);

type Request<T> = (ai: GoogleGenAI, model: string) => Promise<T>;

/** One throttled, counted request on the current model. */
async function once<T>(fn: Request<T>): Promise<T> {
  if (calls >= MAX_CALLS) throw new QuotaError(`Gemini call budget of ${MAX_CALLS} per run reached`);
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  calls++;
  return fn(client(), MODELS[modelIndex]);
}

/** Retries on overload and quota errors, moving through the model list once before giving up. */
async function call<T>(fn: Request<T>): Promise<T> {
  let last: unknown;
  for (let tried = 0; tried < MODELS.length; tried++) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return await once(fn);
      } catch (err) {
        if (err instanceof QuotaError) throw err;
        last = err;
        const status = statusOf(err);
        if (status === 404) break; // model retired: no point retrying it
        if (status !== 429 && status < 500 && !isNetworkFailure(err)) throw err;
        if (attempt < ATTEMPTS_PER_MODEL) await sleep(8000);
      }
    }
    const next = (modelIndex + 1) % MODELS.length;
    if (MODELS.length > 1) console.warn(`  ${MODELS[modelIndex]} unavailable (${statusOf(last)}); trying ${MODELS[next]}`);
    modelIndex = next;
  }
  throw new QuotaError(`Every Gemini model is overloaded or out of quota (last status ${statusOf(last)})`);
}

function parseJson<T>(text: string | undefined): T {
  if (!text) throw new Error("Gemini returned an empty response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error("No JSON found in Gemini response");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** Structured output: the model must return JSON matching `schema`. */
export async function generateJson<T>(prompt: string, schema: object): Promise<T> {
  const res = await call((ai, model) =>
    ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2 },
    }),
  );
  return parseJson<T>(res.text);
}

export interface Grounded<T> {
  data: T;
  sources: Source[];
  /** false when Google Search grounding was unavailable and the answer is from model memory */
  grounded: boolean;
}

/**
 * Research returning JSON matching `schema`, grounded in Google Search when the API key's tier
 * allows it. Without grounding the answer comes from the model's memory and is flagged as such.
 * Grounded calls return prose, so the model is asked for a JSON object in its reply;
 * if that doesn't parse, a second structured call converts the prose.
 */
export async function researchJson<T>(prompt: string, schema: object): Promise<Grounded<T>> {
  const format = `Reply with ONLY a JSON object (no prose, no code fence) matching this JSON Schema:
${JSON.stringify(schema)}`;

  let res;
  if (searchAvailable) {
    try {
      res = await once((ai, model) =>
        ai.models.generateContent({
          model,
          contents: `${prompt}\n\n${format}`,
          config: { tools: [{ googleSearch: {} }], temperature: 0.2 },
        }),
      );
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      const status = statusOf(err);
      if (status < 400 && !isNetworkFailure(err)) throw err;
      // 429 here means the tier has no search quota, not that the model is busy.
      if (status >= 400 && status < 500) {
        searchAvailable = false;
        console.warn("  Google Search grounding is not available for this Gemini key; research will be unverified");
      }
    }
  }

  let grounded = Boolean(res);
  res ??= await call((ai, model) =>
    ai.models.generateContent({
      model,
      contents: `${prompt}

You cannot search the web. Answer from what you know, give the year each figure refers to, and write
"not known" for anything you are unsure of rather than guessing.

${format}`,
      config: { temperature: 0.2 },
    }),
  );

  const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const c of chunks) {
    const url = c.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: c.web?.title || new URL(url).hostname, url });
  }
  if (sources.length === 0) grounded = false;

  let data: T;
  try {
    data = parseJson<T>(res.text);
  } catch {
    data = await generateJson<T>(
      `Convert these research notes into the requested JSON. Use only facts in the notes.\n\n${res.text ?? ""}`,
      schema,
    );
  }
  return { data, sources: sources.slice(0, 6), grounded };
}

/** Reads a PDF directly (no local PDF parsing) and returns JSON matching `schema`. */
export async function readPdfJson<T>(pdf: Buffer, prompt: string, schema: object): Promise<T> {
  const res = await call((ai, model) =>
    ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } }, { text: prompt }],
        },
      ],
      config: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0 },
    }),
  );
  return parseJson<T>(res.text);
}
