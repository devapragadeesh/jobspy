import { chunk } from "@/lib/db";
import { generate, generateJson } from "@/lib/llm";
import type { Job, Settings } from "@/lib/types";
import { truncate } from "./text";

type Criteria = Pick<Settings, "target_roles" | "departments" | "locations" | "exclude_keywords" | "resume_profile" | "resume_text">;
type Listing = Pick<Job, "title" | "location" | "department">;

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.trim().toLowerCase());

/** Free, deterministic filters applied before any model call. */
export function passesHardFilters(job: Listing, c: Pick<Criteria, "locations" | "exclude_keywords">): boolean {
  if (c.exclude_keywords.some((k) => k.trim() && contains(job.title, k))) return false;
  const wanted = c.locations.filter((l) => l.trim());
  // A posting with no location is kept: better a false positive than a silently dropped role.
  if (wanted.length && job.location && !wanted.some((l) => contains(job.location!, l))) return false;
  return true;
}

export function hasCriteria(c: Criteria): boolean {
  return Boolean(c.resume_text || c.target_roles.length || c.departments.length);
}

function candidateBrief(c: Criteria): string {
  const lines: string[] = [];
  if (c.target_roles.length) lines.push(`Roles they want: ${c.target_roles.join(", ")}`);
  if (c.departments.length) lines.push(`Departments they want: ${c.departments.join(", ")}`);
  const p = c.resume_profile;
  if (p) {
    lines.push(`Profile: ${p.headline} (${p.seniority}${p.years_experience != null ? `, ~${p.years_experience} yrs` : ""})`);
    if (p.skills.length) lines.push(`Skills: ${p.skills.slice(0, 40).join(", ")}`);
    if (p.domains.length) lines.push(`Domains: ${p.domains.join(", ")}`);
    if (!c.target_roles.length && p.suggested_titles.length) lines.push(`Titles that suit them: ${p.suggested_titles.join(", ")}`);
  }
  return lines.join("\n");
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: { keep: { type: "array", items: { type: "integer" }, description: "indices worth a closer look" } },
  required: ["keep"],
};

/**
 * Cheap first pass over titles only: which postings could plausibly suit this person?
 * Returns the indices (into `jobs`) to keep. Deliberately inclusive; scoring is the strict step.
 */
export async function triageTitles(jobs: Listing[], c: Criteria): Promise<Set<number>> {
  const keep = new Set<number>();
  let offset = 0;
  for (const batch of chunk(jobs, 200)) {
    const listing = batch
      .map((j, i) => `${i}. ${j.title}${j.department ? ` [${j.department}]` : ""}${j.location ? ` (${j.location})` : ""}`)
      .join("\n");
    const res = await generateJson<{ keep: number[] }>(
      `You are screening job titles for one candidate.

${candidateBrief(c)}

Return the indices of postings that could plausibly be a fit for this candidate, judged on title and
department alone. If they named roles or departments, keep only postings in or adjacent to those.
Keep adjacent titles and different seniority levels within reach; when unsure, keep it.
Drop postings in clearly unrelated functions.

${listing}`,
      TRIAGE_SCHEMA,
      "light",
    );
    for (const i of res.keep ?? []) if (Number.isInteger(i) && i >= 0 && i < batch.length) keep.add(offset + i);
    offset += batch.length;
  }
  return keep;
}

export interface Fit {
  score: number;
  reason: string;
  matched_skills: string[];
  gaps: string[];
  /** Pay range quoted from the posting itself, if it states one. */
  posted_pay: string | null;
}

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          score: { type: "integer", minimum: 0, maximum: 100 },
          reason: { type: "string", description: "one sentence, specific to this candidate and role" },
          matched_skills: { type: "array", items: { type: "string" } },
          gaps: { type: "array", items: { type: "string" } },
          posted_pay: { type: "string", description: "pay range quoted verbatim from the posting, or empty string" },
        },
        required: ["i", "score", "reason", "matched_skills", "gaps", "posted_pay"],
      },
    },
  },
  required: ["results"],
};

export const SCORE_BATCH = 5;

/**
 * Scores up to SCORE_BATCH postings against the resume. fits[i] corresponds to jobs[i]; missing
 * entries are null. `model` is which model did the scoring.
 */
export async function scoreJobs(
  jobs: Pick<Job, "title" | "location" | "department" | "description">[],
  c: Criteria,
): Promise<{ fits: (Fit | null)[]; model: string }> {
  const postings = jobs
    .map(
      (j, i) => `### Posting ${i}
Title: ${j.title}
Location: ${j.location ?? "not stated"}
Department: ${j.department ?? "not stated"}
${j.description ? truncate(j.description, 3500) : "(No description available; judge on the title alone and say so in the reason.)"}`,
    )
    .join("\n\n");

  const { data: res, model } = await generate<{ results: (Fit & { i: number })[] }>(
    `Score how well each job posting fits this candidate.

## Candidate
${candidateBrief(c)}

## Resume
${truncate(c.resume_text ?? "", 6000)}

## Scoring
85-100: meets nearly every core requirement at the right seniority.
70-84: strong on most requirements, minor gaps.
50-69: related background but notable gaps or a seniority mismatch.
0-49: different function or far from the requirements.
If the candidate named roles or departments they want and this posting is outside them, score at most 55.
Be calibrated, not generous. matched_skills and gaps: at most 5 short items each, taken from the posting's
actual requirements. posted_pay: copy the pay range only if the posting states one, else "".

${postings}`,
    SCORE_SCHEMA,
  );

  const out: (Fit | null)[] = jobs.map(() => null);
  const results = res.results ?? [];
  // Small local models sometimes drop or renumber the index; a full-length reply is still in order.
  const indices = results.map((r) => r.i);
  const trustIndex = indices.every((i) => Number.isInteger(i) && i >= 0 && i < jobs.length) && new Set(indices).size === indices.length;
  if (!trustIndex && results.length === jobs.length) results.forEach((r, i) => (r.i = i));
  for (const r of results) {
    if (!Number.isInteger(r.i) || r.i < 0 || r.i >= jobs.length || !Number.isFinite(r.score)) continue;
    out[r.i] = {
      score: Math.max(0, Math.min(100, Math.round(r.score))),
      reason: (r.reason ?? "").trim(),
      matched_skills: (r.matched_skills ?? []).filter((x) => x?.trim()).slice(0, 5),
      gaps: (r.gaps ?? []).filter((x) => x?.trim()).slice(0, 5),
      posted_pay: r.posted_pay?.trim() || null,
    };
  }
  if (out.every((f) => f === null)) console.warn(`  ${model} returned no usable scores for ${jobs.length} roles; they stay queued`);
  return { fits: out, model };
}
