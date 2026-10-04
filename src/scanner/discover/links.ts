import { normalizeUrl } from "@/lib/ats";

export interface RawLink {
  href: string;
  text: string;
  /** Text of the surrounding card/row, which usually carries location and team. */
  context: string;
}

const SOCIAL_HOSTS = /(^|\.)(linkedin|twitter|x|facebook|instagram|youtube|tiktok|glassdoor|github|medium|apple|google)\.com$/i;
const NON_JOB_PATH =
  /\/(privacy|terms|legal|cookies?|login|signin|sign-in|signup|register|contact|about|press|news|blog|investors?|sitemap|accessibility|faq|help|support)(\/|$|\?)/i;
const ASSET = /\.(png|jpe?g|gif|svg|webp|css|js|ico|zip|mp4)(\?|$)/i;

/** Drops links that can't be a job posting, and de-duplicates by canonical URL. */
export function candidateLinks(links: RawLink[], pageUrl: string, max = 600): RawLink[] {
  const page = normalizeUrl(pageUrl);
  const seen = new Set<string>();
  const out: RawLink[] = [];
  for (const link of links) {
    if (!/^https?:\/\//i.test(link.href)) continue;
    let href: string;
    let host: string;
    try {
      href = normalizeUrl(link.href);
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    const text = link.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > 200) continue;
    if (href === page || seen.has(href)) continue;
    if (SOCIAL_HOSTS.test(host) || NON_JOB_PATH.test(href) || ASSET.test(href)) continue;
    seen.add(href);
    out.push({ href, text, context: link.context.replace(/\s+/g, " ").trim().slice(0, 220) });
    if (out.length >= max) break;
  }
  return out;
}
