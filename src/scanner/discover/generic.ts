import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { generateJson } from "@/lib/llm";
import { chunk } from "@/lib/db";
import type { DiscoveredJob } from "@/lib/types";
import { normalizeUrl } from "@/lib/ats";
import { htmlToText, http, shortHash, truncate } from "../text";
import { candidateLinks, type RawLink } from "./links";

let browser: Browser | null = null;

async function newContext(): Promise<BrowserContext> {
  browser ??= await chromium.launch({ headless: true });
  return browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

export interface Rendered {
  /** Page HTML plus frame URLs, for spotting an embedded ATS board. */
  html: string;
  links: RawLink[];
  structured: DiscoveredJob[];
  /** Visible text, for pages whose job cards are not links. */
  text: string;
}

async function collectLinks(page: Page): Promise<RawLink[]> {
  const all: RawLink[] = [];
  for (const frame of page.frames()) {
    const links = await frame
      .evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((a) => {
          const card = a.closest("li, tr, article, [class*='job' i], [class*='card' i], [class*='position' i], [class*='opening' i]");
          return {
            href: a.href,
            text: (a.innerText || a.getAttribute("aria-label") || "").trim(),
            context: ((card as HTMLElement | null)?.innerText || a.parentElement?.innerText || "").slice(0, 400),
          };
        }),
      )
      .catch(() => []);
    all.push(...links);
  }
  return all;
}

async function clickFirstVisible(page: Page, pattern: RegExp): Promise<boolean> {
  const target = page.locator("button, a, [role='button']").filter({ hasText: pattern }).first();
  try {
    if (!(await target.isVisible({ timeout: 500 })) || !(await target.isEnabled())) return false;
    await target.click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function jsonLdJobs(blocks: string[]): DiscoveredJob[] {
  const jobs: DiscoveredJob[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj["@graph"]) visit(obj["@graph"]);
    const type = obj["@type"];
    if (type !== "JobPosting" && !(Array.isArray(type) && type.includes("JobPosting"))) return;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const url = typeof obj.url === "string" ? obj.url : "";
    if (!title || !/^https?:\/\//.test(url)) return;
    const place = [obj.jobLocation].flat().filter(Boolean)[0] as { address?: Record<string, string> } | undefined;
    const addr = place?.address;
    jobs.push({
      key: `url:${normalizeUrl(url)}`,
      title,
      url,
      location: addr ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter((v) => typeof v === "string").join(", ") : undefined,
      description: typeof obj.description === "string" ? htmlToText(obj.description) : undefined,
      postedAt: typeof obj.datePosted === "string" ? obj.datePosted : undefined,
    });
  };
  for (const block of blocks) {
    try {
      visit(JSON.parse(block));
    } catch {
      // malformed JSON-LD is common; ignore
    }
  }
  return jobs;
}

const LOAD_MORE = /^\s*(load|show|view|see)\s+(more|all)\b|^\s*more\s+(jobs|roles|positions|openings)/i;
const NEXT_PAGE = /^\s*(next|next page|›|»|→)\s*$/i;
const COOKIE_OK = /^\s*(accept|accept all|allow all|agree|i agree|got it|ok)\b/i;

/** Renders a careers page in a real browser, expanding lazy lists and following pagination. */
export async function render(url: string): Promise<Rendered> {
  const context = await newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await clickFirstVisible(page, COOKIE_OK);

    const byHref = new Map<string, RawLink>();
    const absorb = async () => {
      const before = byHref.size;
      for (const link of await collectLinks(page)) if (!byHref.has(link.href)) byHref.set(link.href, link);
      return byHref.size - before;
    };

    await absorb();
    // Infinite scroll and "load more" buttons.
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      const clicked = await clickFirstVisible(page, LOAD_MORE);
      await page.waitForTimeout(1200);
      if ((await absorb()) === 0 && !clicked) break;
    }
    // Numbered pagination.
    for (let i = 0; i < 15; i++) {
      if (!(await clickFirstVisible(page, NEXT_PAGE))) break;
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      if ((await absorb()) === 0) break;
    }

    const blocks = await page
      .evaluate(() => Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent ?? ""))
      .catch(() => []);
    const html = (await page.content().catch(() => "")) + "\n" + page.frames().map((f) => f.url()).join("\n");
    const texts = await Promise.all(page.frames().map((f) => f.evaluate(() => document.body?.innerText ?? "").catch(() => "")));
    return { html, links: [...byHref.values()], structured: jsonLdJobs(blocks), text: texts.join("\n").trim() };
  } finally {
    await context.close();
  }
}

export interface KnownJob {
  title: string;
  location: string | null;
  department: string | null;
}

const LINK_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer", description: "index of the link" },
          title: { type: "string", description: "clean job title" },
          location: { type: "string" },
          department: { type: "string" },
        },
        required: ["i", "title"],
      },
    },
  },
  required: ["jobs"],
};

/**
 * Turns the rendered page's links into job postings. Links already known from a previous
 * scan are reused as-is, so the model only ever classifies links it hasn't seen.
 */
export async function extractJobs(
  companyName: string,
  pageUrl: string,
  rendered: Rendered,
  known: Map<string, KnownJob>,
): Promise<DiscoveredJob[]> {
  const jobs = new Map<string, DiscoveredJob>();
  for (const job of rendered.structured) jobs.set(job.key, job);

  const unknown: RawLink[] = [];
  for (const link of candidateLinks(rendered.links, pageUrl)) {
    const key = `url:${link.href}`;
    if (jobs.has(key)) continue;
    const prior = known.get(key);
    if (prior) {
      jobs.set(key, { key, url: link.href, title: prior.title, location: prior.location ?? undefined, department: prior.department ?? undefined });
    } else {
      unknown.push(link);
    }
  }

  for (const batch of chunk(unknown, 150)) {
    const listing = batch
      .map((l, i) => `${i}. text="${l.text}" url=${l.href}${l.context && l.context !== l.text ? ` context="${l.context}"` : ""}`)
      .join("\n");
    const res = await generateJson<{ jobs: { i: number; title: string; location?: string; department?: string }[] }>(
      `These links were found on the careers page of ${companyName} (${pageUrl}).

Return only the links that open ONE specific, currently open job posting. Exclude category, team,
location and "all jobs" listing pages, navigation, benefits/culture pages, blog posts and anything else.
Use the link text and context for the title, location and department; omit a field if it isn't shown.

${listing}`,
      LINK_SCHEMA,
      "light",
    );
    for (const found of res.jobs ?? []) {
      const link = batch[found.i];
      if (!link || !found.title?.trim()) continue;
      const key = `url:${link.href}`;
      jobs.set(key, {
        key,
        url: link.href,
        title: found.title.trim(),
        location: found.location?.trim() || undefined,
        department: found.department?.trim() || undefined,
      });
    }
  }
  if (jobs.size === 0 && rendered.text.length > 200) return extractFromText(companyName, pageUrl, rendered.text);
  return [...jobs.values()];
}

const TEXT_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, location: { type: "string" }, department: { type: "string" } },
        required: ["title"],
      },
    },
  },
  required: ["jobs"],
};

/**
 * Last resort for pages whose job cards are click handlers rather than links: read the titles
 * off the visible text. These postings have no URL of their own, so they link to the careers page.
 */
async function extractFromText(companyName: string, pageUrl: string, text: string): Promise<DiscoveredJob[]> {
  const res = await generateJson<{ jobs: { title: string; location?: string; department?: string }[] }>(
    `This is the visible text of the careers page of ${companyName} (${pageUrl}).
List every currently open job posting it shows. Copy titles exactly as written. Do not invent postings:
if the text shows no specific openings, return an empty list.

${truncate(text, 60_000)}`,
    TEXT_SCHEMA,
    "light",
  );
  const jobs = new Map<string, DiscoveredJob>();
  for (const j of res.jobs ?? []) {
    const title = j.title?.trim();
    if (!title) continue;
    const location = j.location?.trim() || undefined;
    const key = `text:${shortHash(`${title}|${location ?? ""}`.toLowerCase())}`;
    jobs.set(key, { key, url: pageUrl, title, location, department: j.department?.trim() || undefined });
  }
  return [...jobs.values()];
}

/** Job description text for a posting on an arbitrary site. */
export async function describeGeneric(url: string): Promise<string | null> {
  try {
    const res = await http(url);
    if (res.ok) {
      const text = htmlToText(await res.text());
      if (text.length > 600) return truncate(text, 8000);
    }
  } catch {
    // fall through to a real browser
  }
  const context = await newContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText);
    return text.trim().length > 200 ? truncate(text.trim(), 8000) : null;
  } catch {
    return null;
  } finally {
    await context.close();
  }
}
