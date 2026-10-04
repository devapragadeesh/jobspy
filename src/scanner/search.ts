import { htmlToText, http, truncate } from "./text";

/** A piece of web text the model may quote from, with where it came from. */
export interface Evidence {
  title: string;
  url: string;
  text: string;
}

export interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  engines?: string[];
}

const NAVIGATIONAL = /(log-?in|sign-?in|sign-?up|register|account|dashboard|support|help|download|drivers|pricing)(\b|\/|\.)/i;
// Measured on GitHub runners: these return topical pages; Bing and Yahoo mostly return the company's own site.
const TOPICAL_ENGINES = /startpage|google/i;

/** Orders raw results by usefulness as evidence and drops navigational pages and duplicates. */
export function rankResults(results: SearxResult[], limit: number): Evidence[] {
  const seen = new Set<string>();
  const topical: Evidence[] = [];
  const other: Evidence[] = [];
  for (const r of results) {
    const text = r.content?.replace(/\s+/g, " ").trim();
    if (!r.url || !r.title || !text || text.length < 40) continue;
    let key: string;
    try {
      const u = new URL(r.url);
      key = u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
      if (NAVIGATIONAL.test(u.hostname + u.pathname)) continue;
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { title: r.title.trim(), url: r.url, text: truncate(text, 400) };
    ((r.engines ?? []).some((e) => TOPICAL_ENGINES.test(e)) ? topical : other).push(item);
  }
  return [...topical, ...other].slice(0, limit);
}

const SEARXNG_URL = process.env.SEARXNG_URL?.replace(/\/$/, "");
let warned = false;
let lastSearchAt = 0;

export function searchConfigured(): boolean {
  return Boolean(SEARXNG_URL);
}

/** Web search through the SearXNG instance running beside the scanner. Returns [] when it is unavailable. */
export async function searchWeb(query: string, limit = 8): Promise<Evidence[]> {
  if (!SEARXNG_URL) return [];
  // Upstream engines suspend clients that fire queries back to back.
  const wait = lastSearchAt + 2500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
  try {
    const url = `${SEARXNG_URL}/search?format=json&language=en&q=${encodeURIComponent(query)}`;
    const res = await http(url, {}, 45_000);
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
    const body = (await res.json()) as { results?: SearxResult[] };
    return rankResults(body.results ?? [], limit);
  } catch (err) {
    if (!warned) console.warn(`  web search unavailable (${(err as Error).message}); research falls back to what the model knows`);
    warned = true;
    return [];
  }
}

/** The start of a company's English Wikipedia article, as a source that is always reachable. */
export async function wikipedia(name: string): Promise<Evidence | null> {
  try {
    const found = await http(`https://en.wikipedia.org/w/rest.php/v1/search/page?limit=1&q=${encodeURIComponent(`${name} company`)}`);
    const key = ((await found.json()) as { pages?: { key: string; title: string }[] }).pages?.[0];
    if (!key) return null;
    const res = await http(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(key.key)}`,
    );
    const pages = ((await res.json()) as { query?: { pages?: Record<string, { extract?: string }> } }).query?.pages ?? {};
    const extract = Object.values(pages)[0]?.extract?.trim();
    if (!extract || extract.length < 200) return null;
    return { title: `${key.title} - Wikipedia`, url: `https://en.wikipedia.org/wiki/${key.key}`, text: truncate(extract, 4500) };
  } catch {
    return null;
  }
}

/** Replaces a search snippet with the page's own text where the site allows fetching it. */
export async function withPageText(item: Evidence, max = 2500): Promise<Evidence> {
  try {
    const res = await http(item.url, {}, 15_000);
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return item;
    const text = htmlToText(await res.text());
    return text.length > 800 ? { ...item, text: `${item.text}\n${truncate(text, max)}` } : item;
  } catch {
    return item;
  }
}

export function formatEvidence(evidence: Evidence[]): string {
  return evidence.map((e, i) => `[${i}] ${e.title} (${e.url})\n${e.text}`).join("\n\n");
}

/** Maps the indices a model says it used back to sources, ignoring anything out of range. */
export function pickSources(evidence: Evidence[], used: unknown, max = 5): { title: string; url: string }[] {
  const indices = Array.isArray(used) ? used.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < evidence.length) : [];
  const chosen = indices.length ? [...new Set(indices)] : evidence.map((_, i) => i).slice(0, 3);
  return chosen.slice(0, max).map((i) => ({ title: evidence[i].title, url: evidence[i].url }));
}
