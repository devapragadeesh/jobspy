import { ApiError, GoogleGenAI } from "@google/genai";
import type { Source } from "./types";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
// Free tier is rate limited per minute; space calls out rather than burst and retry.
const MIN_INTERVAL_MS = Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 4500);
const MAX_CALLS = Number(process.env.GEMINI_MAX_CALLS_PER_RUN ?? 150);
const MAX_ATTEMPTS = 4;

/** Thrown when the per-run call budget or the API quota is used up. Callers stop and carry work over. */
export class QuotaError extends Error {}

let ai: GoogleGenAI | null = null;
let lastCallAt = 0;
let calls = 0;

function client(): GoogleGenAI {
  if (ai) return ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY must be set");
  ai = new GoogleGenAI({ apiKey });
  return ai;
}

export function geminiCallCount(): number {
  return calls;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(fn: (ai: GoogleGenAI) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (calls >= MAX_CALLS) throw new QuotaError(`Gemini call budget of ${MAX_CALLS} per run reached`);
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    calls++;
    try {
      return await fn(client());
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const retryable = status === 429 || status >= 500;
      if (!retryable) throw err;
      if (attempt >= MAX_ATTEMPTS) {
        if (status === 429) throw new QuotaError("Gemini quota exhausted (429 after retries)");
        throw err;
      }
      await sleep(15_000 * attempt);
    }
  }
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
  const res = await call((ai) =>
    ai.models.generateContent({
      model: MODEL,
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
 * Research with Google Search grounding, returning JSON matching `schema`.
 * Grounded calls return prose, so the model is asked for a JSON object in its reply;
 * if that doesn't parse, a second structured call converts the prose.
 */
export async function researchJson<T>(prompt: string, schema: object): Promise<Grounded<T>> {
  const instructions = `${prompt}

Reply with ONLY a JSON object (no prose, no code fence) matching this JSON Schema:
${JSON.stringify(schema)}`;

  let grounded = true;
  let res;
  try {
    res = await call((ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: instructions,
        config: { tools: [{ googleSearch: {} }], temperature: 0.2 },
      }),
    );
  } catch (err) {
    if (err instanceof QuotaError) throw err;
    // Grounding not offered for this model/tier: fall back, and say so in the result.
    console.warn(`  search grounding failed (${(err as Error).message.slice(0, 120)}); using ungrounded answer`);
    grounded = false;
    res = await call((ai) =>
      ai.models.generateContent({ model: MODEL, contents: instructions, config: { temperature: 0.2 } }),
    );
  }

  const chunks = res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const c of chunks) {
    const url = c.web?.uri;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: c.web?.title || new URL(url).hostname, url });
  }
  if (grounded && sources.length === 0) grounded = false;

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
  const res = await call((ai) =>
    ai.models.generateContent({
      model: MODEL,
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
