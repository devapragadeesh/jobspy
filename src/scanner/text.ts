import { createHash } from "node:crypto";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  hellip: "…",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Rough HTML → readable text. Good enough to feed a model; not a renderer. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export async function http(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "user-agent": UA, accept: "application/json, text/html;q=0.9, */*;q=0.8", ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const res = await http(url, init, timeoutMs);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).hostname}`);
  return (await res.json()) as T;
}
