import Link from "next/link";
import { deleteCompany, renameCompany, setCompanyActive } from "@/app/actions";
import { AddCompanyForm, ScanNowForm } from "@/components/forms";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { scanTriggerConfigured } from "@/lib/github";
import { requireSession } from "@/lib/session";
import type { Company, Settings } from "@/lib/types";

function health(c: Company): { color: string; label: string } {
  if (!c.active) return { color: "bg-faint", label: "Paused" };
  if (!c.last_scan_at) return { color: "bg-faint", label: "Not scanned yet" };
  if (c.consecutive_failures >= 2) return { color: "bg-red-500", label: "Failing" };
  if (c.consecutive_failures === 1) return { color: "bg-amber-400", label: "Last scan failed" };
  return { color: "bg-green-500", label: "Healthy" };
}

async function matchCount(companyId: string, settings: Settings): Promise<number> {
  let q = db()
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("relevant", true)
    .is("closed_at", null)
    .not("status", "in", "(dismissed,rejected)");
  if (settings.resume_text) q = q.gte("fit_score", settings.min_score);
  return (await q).count ?? 0;
}

const quiet = "text-sm text-mute underline-offset-2 hover:text-ink hover:underline";

export default async function CompaniesPage() {
  await requireSession();
  const [{ data: settings }, { data: companies }, { data: lastRun }] = await Promise.all([
    db().from("settings").select("*").eq("id", 1).single<Settings>(),
    db().from("companies").select("*").order("created_at", { ascending: false }).returns<Company[]>(),
    db().from("scan_runs").select("started_at, finished_at, email_sent, error").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!settings || !companies) throw new Error("Couldn't load data. Check the Supabase environment variables.");

  const counts = await Promise.all(companies.map((c) => matchCount(c.id, settings)));
  const canScan = scanTriggerConfigured();
  const unconfigured = !settings.resume_text && !settings.target_roles.length && !settings.departments.length;

  return (
    <div className="space-y-8">
      {unconfigured && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No resume or target roles yet, so every new role would be reported.{" "}
          <Link href="/settings" className="underline">Add them in Settings</Link>.
        </p>
      )}

      <AddCompanyForm />

      <div className="flex items-center justify-between text-sm text-mute">
        <span>
          {lastRun
            ? `Last scan ${timeAgo(lastRun.started_at)}${lastRun.error ? " · failed" : lastRun.email_sent ? " · email sent" : " · nothing new"}`
            : "No scans yet"}
        </span>
        {canScan && companies.length > 0 && <ScanNowForm label="Scan all now" />}
      </div>

      {companies.length === 0 ? (
        <p className="py-10 text-center text-sm text-mute">Paste a company&apos;s careers page above to start watching it.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {companies.map((c, i) => {
            const h = health(c);
            return (
              <li key={c.id} className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${h.color}`} title={h.label} aria-label={h.label} />
                      <span className="truncate font-medium">{c.name}</span>
                      {c.ats_type && c.ats_type !== "generic" && (
                        <span className="rounded bg-card px-1.5 py-0.5 text-xs text-mute">{c.ats_type}</span>
                      )}
                    </div>
                    <a href={c.careers_url} target="_blank" rel="noreferrer" className="block truncate text-xs text-mute hover:underline">
                      {c.careers_url.replace(/^https?:\/\//, "")}
                    </a>
                    <div className="mt-1 text-xs text-mute">
                      {c.last_scan_at ? `Scanned ${timeAgo(c.last_scan_at)}` : "Waiting for first scan"}
                      {c.last_job_count != null && ` · ${c.last_job_count} open roles`}
                    </div>
                    {c.last_scan_error && c.consecutive_failures > 0 && (
                      <div className="mt-1 text-xs text-red-700">{c.last_scan_error}</div>
                    )}
                  </div>
                  <Link href={`/jobs?company=${c.id}`} className="shrink-0 text-right">
                    <div className="text-xl font-semibold tabular-nums">{counts[i]}</div>
                    <div className="text-xs text-mute">matching</div>
                  </Link>
                </div>

                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-xs text-mute hover:text-ink">Details</summary>
                  <div className="mt-3 space-y-3">
                    {c.research && (
                      <div className="space-y-2 rounded-md bg-card p-3 text-sm">
                        <p>{c.research.summary}</p>
                        <p>
                          <span className="font-medium">Best known for:</span> {c.research.flagship.name} — {c.research.flagship.where_used}
                        </p>
                        {c.research.key_stats.length > 0 && (
                          <ul className="list-disc pl-5 text-mute">
                            {c.research.key_stats.map((s) => (
                              <li key={s}>{s}</li>
                            ))}
                          </ul>
                        )}
                        <p>
                          <span className="font-medium">Outlook:</span> {c.research.growth_outlook}
                        </p>
                      </div>
                    )}
                    <form action={renameCompany} className="flex gap-2">
                      <input type="hidden" name="id" value={c.id} />
                      <input name="name" defaultValue={c.name} aria-label="Company name" className="w-56 rounded-md border border-line px-2 py-1 text-sm" />
                      <button type="submit" className={quiet}>Rename</button>
                    </form>
                    <div className="flex flex-wrap items-center gap-4">
                      {canScan && c.active && <ScanNowForm companyId={c.id} />}
                      <form action={setCompanyActive}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="active" value={String(!c.active)} />
                        <button type="submit" className={quiet}>{c.active ? "Pause" : "Resume"}</button>
                      </form>
                      <details>
                        <summary className={`cursor-pointer list-none ${quiet}`}>Remove</summary>
                        <form action={deleteCompany} className="mt-2">
                          <input type="hidden" name="id" value={c.id} />
                          <button type="submit" className="text-sm text-red-700 hover:underline">
                            Remove {c.name} and its tracked roles
                          </button>
                        </form>
                      </details>
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
