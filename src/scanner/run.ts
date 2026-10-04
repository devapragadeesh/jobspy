import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { guessCompanyName, parseCareersUrl } from "@/lib/ats";
import { chunk, db, fetchAll } from "@/lib/db";
import { geminiCallCount, QuotaError } from "@/lib/gemini";
import { TRACKED_STATUSES, type Company, type Job, type Settings } from "@/lib/types";
import { diffJobs, type StoredJobRef } from "./diff";
import { describe, discover } from "./discover";
import { closeBrowser, type KnownJob } from "./discover/generic";
import { digestIsEmpty, renderDigest, sendDigest, type Digest, type DigestGroup } from "./email";
import { ALERT_AFTER_FAILURES, nextHealth, type HealthUpdate } from "./health";
import { hasCriteria, passesHardFilters, SCORE_BATCH, scoreJobs, triageTitles } from "./match";
import { estimateSalary, researchCompany, researchIsStale } from "./research";
import { truncate } from "./text";

const TRIAGE_LIMIT = 3000;
const SCORE_LIMIT = Number(process.env.SCORE_LIMIT_PER_RUN ?? 60);
const SALARY_LIMIT = Number(process.env.SALARY_LIMIT_PER_RUN ?? 20);
const ROLES_PER_COMPANY_IN_EMAIL = 10;
const ID_CHUNK = 100; // ids travel in the query string

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    company: { type: "string" },
    url: { type: "string" },
  },
});
const dryRun = args["dry-run"];
const force = args.force || process.env.FORCE === "true";
const onlyCompany = args.company || process.env.COMPANY_ID || undefined;

const log = (msg: string) => console.log(msg);
const healthFields = ({ last_scan_status, last_scan_error, consecutive_failures }: HealthUpdate) => ({
  last_scan_status,
  last_scan_error,
  consecutive_failures,
});
const must = <T>(res: { data: T; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message);
  return res.data;
};

/** `--url`: list what a careers page yields without touching the database. */
async function probe(input: string): Promise<void> {
  const url = parseCareersUrl(input);
  if (!url) throw new Error(`Not a URL: ${input}`);
  const result = await discover({ name: guessCompanyName(url), careers_url: url, ats_type: null, ats_config: null }, new Map());
  log(`${result.jobs.length} roles via ${result.atsType}${result.truncated ? " (truncated)" : ""}`);
  for (const j of result.jobs.slice(0, 15)) log(`  ${j.title}${j.location ? ` — ${j.location}` : ""}\n    ${j.url}`);
  if (result.jobs.length > 15) log(`  … and ${result.jobs.length - 15} more`);
}

interface Stats {
  companies_scanned: number;
  companies_failed: number;
  jobs_found: number;
  jobs_added: number;
  jobs_closed: number;
  triaged: number;
  scored: number;
  notified: number;
  gemini_calls: number;
}

async function scanCompany(company: Company, stats: Stats): Promise<void> {
  const stored = await fetchAll<StoredJobRef & KnownJob>((from, to) =>
    db()
      .from("jobs")
      .select("id, external_key, missed_scans, closed_at, title, location, department")
      .eq("company_id", company.id)
      .range(from, to),
  );
  const known = new Map(stored.map((s) => [s.external_key, s as KnownJob]));
  const now = new Date().toISOString();

  let result;
  try {
    result = await discover(company, known);
  } catch (err) {
    // Running out of model quota is our problem, not the page's: leave the company due for the next run.
    if (err instanceof QuotaError) throw err;
    const health = nextHealth(company, { kind: "error", message: (err as Error).message });
    log(`  ✗ ${company.name}: ${health.last_scan_error}`);
    stats.companies_failed++;
    must(await db().from("companies").update({ ...healthFields(health), last_scan_at: now }).eq("id", company.id));
    return;
  }

  const health = nextHealth(company, { kind: "ok", count: result.jobs.length });
  const update: Record<string, unknown> = {
    ...healthFields(health),
    last_scan_at: now,
    ats_type: result.atsType,
    ats_config: result.atsConfig,
  };
  if (health.last_scan_status === "ok") {
    update.last_job_count = result.jobs.length;
    update.health_alerted_at = null;
  }
  must(await db().from("companies").update(update).eq("id", company.id));
  // Stored so describe() below and later stages use the detected board.
  company.ats_type = result.atsType;
  company.ats_config = result.atsConfig;

  if (health.last_scan_status !== "ok") {
    log(`  ✗ ${company.name}: ${health.last_scan_error}`);
    stats.companies_failed++;
    return;
  }

  const diff = diffJobs(stored, result.jobs, { trackMissing: !result.truncated });
  for (const batch of chunk(diff.added, 500)) {
    must(
      await db()
        .from("jobs")
        .upsert(
          batch.map((j) => ({
            company_id: company.id,
            external_key: j.key,
            title: truncate(j.title, 300),
            url: j.url,
            location: j.location ?? null,
            department: j.department ?? null,
            description: j.description ? truncate(j.description, 8000) : null,
            posted_at: j.postedAt && !Number.isNaN(Date.parse(j.postedAt)) ? new Date(j.postedAt).toISOString() : null,
            salary: j.postedPay ? { text: j.postedPay, basis: "posting", confidence: "high", sources: [] } : null,
          })),
          { onConflict: "company_id,external_key", ignoreDuplicates: true },
        ),
    );
  }
  for (const ids of chunk(diff.seen, ID_CHUNK)) {
    must(await db().from("jobs").update({ last_seen_at: now, missed_scans: 0 }).in("id", ids));
  }
  for (const ids of chunk(diff.reopened, ID_CHUNK)) {
    must(await db().from("jobs").update({ closed_at: null, closed_notified_at: null }).in("id", ids));
  }
  const closing = diff.missed.filter((m) => m.close).map((m) => m.id);
  for (const ids of chunk(closing, ID_CHUNK)) {
    must(await db().from("jobs").update({ closed_at: now }).in("id", ids));
  }
  // Group the rest by their new miss count so each count is one update.
  const pending = new Map<number, string[]>();
  for (const m of diff.missed) pending.set(m.missed_scans, [...(pending.get(m.missed_scans) ?? []), m.id]);
  for (const [missed, all] of pending) {
    for (const ids of chunk(all, ID_CHUNK)) must(await db().from("jobs").update({ missed_scans: missed }).in("id", ids));
  }

  stats.companies_scanned++;
  stats.jobs_found += result.jobs.length;
  stats.jobs_added += diff.added.length;
  stats.jobs_closed += closing.length;
  log(`  ✓ ${company.name}: ${result.jobs.length} roles via ${result.atsType}, ${diff.added.length} new, ${closing.length} closed`);
}

/** Decide which untriaged postings are worth scoring. */
async function triage(settings: Settings, stats: Stats): Promise<void> {
  const queue = must(
    await db()
      .from("jobs")
      .select("id, title, location, department")
      .is("relevant", null)
      .is("closed_at", null)
      .order("first_seen_at")
      .limit(TRIAGE_LIMIT),
  ) as Pick<Job, "id" | "title" | "location" | "department">[];
  if (!queue.length) return;

  const passed = queue.filter((j) => passesHardFilters(j, settings));
  const filtered = queue.filter((j) => !passesHardFilters(j, settings));
  await setRelevant(filtered, false);
  stats.triaged += filtered.length;

  if (!hasCriteria(settings)) {
    // Nothing to match against: every new role is reported, unscored.
    await setRelevant(passed, true);
    stats.triaged += passed.length;
    return;
  }
  // Commit each batch so a quota stop keeps the work done so far.
  for (const batch of chunk(passed, 200)) {
    const keep = await triageTitles(batch, settings);
    await setRelevant(batch.filter((_, i) => keep.has(i)), true);
    await setRelevant(batch.filter((_, i) => !keep.has(i)), false);
    stats.triaged += batch.length;
  }
}

async function setRelevant(jobs: { id: string }[], relevant: boolean): Promise<void> {
  for (const batch of chunk(jobs, ID_CHUNK)) {
    must(await db().from("jobs").update({ relevant }).in("id", batch.map((j) => j.id)));
  }
}

/** Score relevant postings against the resume, fetching descriptions where the listing had none. */
async function score(settings: Settings, companies: Map<string, Company>, stats: Stats): Promise<void> {
  if (!settings.resume_text) return;
  const queue = must(
    await db()
      .from("jobs")
      .select("*")
      .eq("relevant", true)
      .is("fit_score", null)
      .is("closed_at", null)
      .order("first_seen_at", { ascending: false })
      .limit(SCORE_LIMIT),
  ) as Job[];

  for (const batch of chunk(queue, SCORE_BATCH)) {
    for (const job of batch) {
      if (job.description) continue;
      const company = companies.get(job.company_id);
      if (!company) continue;
      const text = await describe(company, job);
      if (text) {
        job.description = truncate(text, 8000);
        must(await db().from("jobs").update({ description: job.description }).eq("id", job.id));
      }
    }
    const fits = await scoreJobs(batch, settings);
    for (const [i, fit] of fits.entries()) {
      if (!fit) continue;
      const job = batch[i];
      const patch: Partial<Job> = {
        fit_score: fit.score,
        fit_reason: fit.reason,
        matched_skills: fit.matched_skills,
        gaps: fit.gaps,
      };
      if (!job.salary && fit.posted_pay) {
        patch.salary = { text: fit.posted_pay, basis: "posting", confidence: "high", sources: [] };
      }
      must(await db().from("jobs").update(patch).eq("id", job.id));
      stats.scored++;
    }
  }
}

async function buildDigest(
  settings: Settings,
  companies: Map<string, Company>,
  notes: string[],
): Promise<{ digest: Digest; notifyIds: string[] }> {
  let pending = db()
    .from("jobs")
    .select("*")
    .eq("relevant", true)
    .eq("status", "new")
    .is("notified_at", null)
    .is("closed_at", null)
    .order("fit_score", { ascending: false, nullsFirst: false })
    .limit(500);
  if (settings.resume_text) pending = pending.gte("fit_score", settings.min_score);
  const toNotify = must(await pending) as Job[];

  const byCompany = new Map<string, Job[]>();
  for (const job of toNotify) byCompany.set(job.company_id, [...(byCompany.get(job.company_id) ?? []), job]);

  const groups: DigestGroup[] = [];
  for (const [companyId, jobs] of byCompany) {
    const company = companies.get(companyId);
    if (!company) continue;
    groups.push({
      company,
      jobs: jobs.slice(0, ROLES_PER_COMPANY_IN_EMAIL),
      more: Math.max(0, jobs.length - ROLES_PER_COMPANY_IN_EMAIL),
    });
  }

  // Research is the last and least essential use of quota: when it runs out the email still goes.
  try {
    for (const g of groups) {
      if (!researchIsStale(g.company)) continue;
      g.company.research = await researchCompany(g.company);
      g.company.researched_at = new Date().toISOString();
      must(
        await db()
          .from("companies")
          .update({ research: g.company.research, researched_at: g.company.researched_at })
          .eq("id", g.company.id),
      );
      log(`  researched ${g.company.name}`);
    }
    let budget = SALARY_LIMIT;
    for (const g of groups) {
      for (const job of g.jobs) {
        if (job.salary || budget-- <= 0) continue;
        job.salary = await estimateSalary(g.company, job);
        must(await db().from("jobs").update({ salary: job.salary }).eq("id", job.id));
      }
    }
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    notes.push("Some company briefs or pay estimates are missing: today's Gemini quota ran out. They fill in on the next scan.");
  }

  const closedJobs = must(
    await db()
      .from("jobs")
      .select("*")
      .not("closed_at", "is", null)
      .is("closed_notified_at", null)
      .in("status", TRACKED_STATUSES),
  ) as Job[];
  const closed = closedJobs.flatMap((job) => {
    const company = companies.get(job.company_id);
    return company ? [{ company, job }] : [];
  });

  const unhealthy = must(
    await db()
      .from("companies")
      .select("*")
      .eq("active", true)
      .gte("consecutive_failures", ALERT_AFTER_FAILURES)
      .is("health_alerted_at", null),
  ) as Company[];

  return {
    digest: { groups, closed, unhealthy, notes, appUrl: process.env.APP_URL?.replace(/\/$/, "") },
    // Roles beyond the per-company cap are counted in the email, so they are marked as notified too.
    notifyIds: toNotify.filter((j) => companies.has(j.company_id)).map((j) => j.id),
  };
}

async function markSent(digest: Digest, notifyIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const ids of chunk(notifyIds, ID_CHUNK)) {
    must(await db().from("jobs").update({ notified_at: now }).in("id", ids));
  }
  for (const ids of chunk(digest.closed.map((c) => c.job.id), ID_CHUNK)) {
    must(await db().from("jobs").update({ closed_notified_at: now }).in("id", ids));
  }
  for (const ids of chunk(digest.unhealthy.map((c) => c.id), ID_CHUNK)) {
    must(await db().from("companies").update({ health_alerted_at: now }).in("id", ids));
  }
}

async function main(): Promise<void> {
  if (args.url) return probe(args.url);

  const settings = must(await db().from("settings").select("*").eq("id", 1).single()) as Settings;
  const all = must(await db().from("companies").select("*").eq("active", true).order("created_at")) as Company[];
  const companies = new Map(all.map((c) => [c.id, c]));

  const dueAfterMs = (settings.scan_interval_hours - 1) * 3_600_000; // an hour's slack for cron jitter
  const due = all.filter((c) => {
    if (onlyCompany) return c.id === onlyCompany;
    return force || !c.last_scan_at || Date.now() - new Date(c.last_scan_at).getTime() >= dueAfterMs;
  });

  const trigger = process.env.GITHUB_EVENT_NAME ?? "local";
  const run = must(await db().from("scan_runs").insert({ trigger }).select("id").single()) as { id: string };
  const stats: Stats = {
    companies_scanned: 0,
    companies_failed: 0,
    jobs_found: 0,
    jobs_added: 0,
    jobs_closed: 0,
    triaged: 0,
    scored: 0,
    notified: 0,
    gemini_calls: 0,
  };
  const notes: string[] = [];
  let emailSent = false;
  let failure: string | null = null;

  try {
    log(`Scanning ${due.length} of ${all.length} companies${dryRun ? " (dry run: no email)" : ""}`);
    if (!hasCriteria(settings)) log("No resume or target roles set: every new role will be reported unscored.");

    try {
      for (const company of due) await scanCompany(company, stats);
      await triage(settings, stats);
      await score(settings, companies, stats);
    } catch (err) {
      if (!(err instanceof QuotaError)) throw err;
      log(`  quota: ${err.message}`);
      notes.push("Today's Gemini quota ran out part-way through; remaining roles are queued for the next scan.");
    }

    const { digest, notifyIds } = await buildDigest(settings, companies, notes);
    stats.notified = digest.groups.reduce((n, g) => n + g.jobs.length + g.more, 0);

    if (digestIsEmpty(digest)) {
      log("Nothing new to report; no email sent.");
    } else {
      const mail = renderDigest(digest);
      if (dryRun) {
        await mkdir("out", { recursive: true });
        await writeFile("out/digest.html", mail.html);
        log(`Dry run: "${mail.subject}" written to out/digest.html`);
      } else {
        const to = settings.alert_to || process.env.GMAIL_USER;
        if (!to) throw new Error("No recipient: set an alert address in Settings");
        await sendDigest(to, mail);
        emailSent = true;
        await markSent(digest, notifyIds);
        log(`Sent "${mail.subject}" to ${to}`);
      }
    }
  } catch (err) {
    failure = (err as Error).stack ?? String(err);
    throw err;
  } finally {
    stats.gemini_calls = geminiCallCount();
    await closeBrowser();
    await db()
      .from("scan_runs")
      .update({ finished_at: new Date().toISOString(), stats, email_sent: emailSent, error: failure })
      .eq("id", run.id);
    log(`Done: ${JSON.stringify(stats)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
