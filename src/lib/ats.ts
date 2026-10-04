import type { AtsConfig, AtsType } from "./types";

export interface AtsMatch {
  type: Exclude<AtsType, "generic">;
  config: AtsConfig;
}

const RESERVED = new Set(["embed", "wday", "v1", "api", "js", "css", "assets", "static"]);

/** Finds every hosted-ATS board reference in a URL or a blob of HTML. */
function findAll(text: string): AtsMatch[] {
  const found: AtsMatch[] = [];
  let m: RegExpExecArray | null;

  const ghEmbed = /greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s]*&)?for=([\w-]+)/g;
  while ((m = ghEmbed.exec(text))) found.push({ type: "greenhouse", config: { token: m[1] } });
  const gh = /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)/g;
  while ((m = gh.exec(text))) if (!RESERVED.has(m[1])) found.push({ type: "greenhouse", config: { token: m[1] } });
  const ghApi = /boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/g;
  while ((m = ghApi.exec(text))) found.push({ type: "greenhouse", config: { token: m[1] } });

  const lever = /jobs(\.eu)?\.lever\.co\/([\w-]+)/g;
  while ((m = lever.exec(text))) {
    found.push({ type: "lever", config: { company: m[2], ...(m[1] ? { eu: "1" } : {}) } });
  }

  const ashby = /jobs\.ashbyhq\.com\/([\w.%-]+)/g;
  while ((m = ashby.exec(text))) if (!RESERVED.has(m[1])) found.push({ type: "ashby", config: { board: decodeURIComponent(m[1]) } });

  const workday = /([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/g;
  while ((m = workday.exec(text))) {
    if (RESERVED.has(m[3])) continue;
    found.push({
      type: "workday",
      config: { host: `${m[1]}.${m[2]}.myworkdayjobs.com`, tenant: m[1], site: m[3] },
    });
  }

  const sr = /(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/g;
  while ((m = sr.exec(text))) if (!RESERVED.has(m[1])) found.push({ type: "smartrecruiters", config: { company: m[1] } });

  return found;
}

/** The careers URL itself points at a known ATS board. */
export function detectAtsFromUrl(url: string): AtsMatch | null {
  return findAll(url)[0] ?? null;
}

/** A company's own careers page embeds or links to an ATS board: pick the most referenced one. */
export function detectAtsInHtml(html: string): AtsMatch | null {
  const counts = new Map<string, { match: AtsMatch; n: number }>();
  for (const match of findAll(html)) {
    const id = `${match.type}:${JSON.stringify(match.config)}`;
    const entry = counts.get(id);
    if (entry) entry.n++;
    else counts.set(id, { match, n: 1 });
  }
  let best: { match: AtsMatch; n: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.n > best.n) best = entry;
  return best?.match ?? null;
}

const GENERIC_SUBDOMAINS = new Set(["www", "careers", "career", "jobs", "job", "apply", "work", "join", "boards", "hire"]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov"]);

function titleCase(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Best-effort company name from a careers URL; the user can rename it in the UI. */
export function guessCompanyName(url: string): string {
  const ats = detectAtsFromUrl(url);
  if (ats) {
    const slug = ats.config.token ?? ats.config.company ?? ats.config.board ?? ats.config.tenant;
    if (slug) return titleCase(slug);
  }
  const labels = new URL(url).hostname.toLowerCase().split(".");
  labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
  const meaningful = labels.filter((l) => !GENERIC_SUBDOMAINS.has(l));
  return titleCase(meaningful[meaningful.length - 1] ?? labels[labels.length - 1] ?? url);
}

const TRACKING_PARAMS = /^(utm_\w+|gh_src|gh_jid_src|source|src|ref|referrer|lever-source.*|trk|fbclid|gclid)$/i;

/** Canonical form of a URL, used to recognise the same posting across scans. */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  let out = u.toString();
  if (out.endsWith("/") && u.pathname !== "/") out = out.slice(0, -1);
  return out;
}

/** Accepts what a person pastes ("stripe.com/jobs") and returns an absolute https URL, or null. */
export function parseCareersUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!u.hostname.includes(".")) return null;
    return normalizeUrl(u.toString());
  } catch {
    return null;
  }
}
