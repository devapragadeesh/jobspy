import { StatusSelect } from "@/components/forms";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { TRACKED_STATUSES, type Job } from "@/lib/types";

const VIEWS = {
  matches: "Matches",
  tracked: "Saved & applied",
  all: "Everything found",
} as const;
type View = keyof typeof VIEWS;

type Row = Job & { companies: { name: string } | null };

function scoreClass(score: number): string {
  if (score >= 80) return "bg-green-100 text-green-800";
  if (score >= 65) return "bg-yellow-100 text-yellow-800";
  return "bg-gray-100 text-gray-700";
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const params = await searchParams;
  const view: View = typeof params.view === "string" && params.view in VIEWS ? (params.view as View) : "matches";
  const company = typeof params.company === "string" ? params.company : "";

  let query = db()
    .from("jobs")
    .select("*, companies(name)")
    .order("fit_score", { ascending: false, nullsFirst: false })
    .order("first_seen_at", { ascending: false })
    .limit(200);
  if (company) query = query.eq("company_id", company);
  if (view === "matches") query = query.eq("relevant", true).is("closed_at", null).not("status", "in", "(dismissed,rejected)");
  if (view === "tracked") query = query.in("status", TRACKED_STATUSES);

  const [{ data: jobs, error }, { data: companies }] = await Promise.all([
    query.returns<Row[]>(),
    db().from("companies").select("id, name").order("name"),
  ]);
  if (error) throw new Error(error.message);

  return (
    <div className="space-y-6">
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <select name="view" defaultValue={view} aria-label="View" className="rounded-md border border-line bg-white px-2 py-1.5">
          {Object.entries(VIEWS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select name="company" defaultValue={company} aria-label="Company" className="rounded-md border border-line bg-white px-2 py-1.5">
          <option value="">All companies</option>
          {(companies ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-md border border-line px-3 py-1.5 hover:bg-card">
          Show
        </button>
        <span className="ml-auto text-mute">
          {jobs.length}
          {jobs.length === 200 ? "+" : ""} roles
        </span>
      </form>

      {jobs.length === 0 ? (
        <p className="py-10 text-center text-sm text-mute">
          {view === "matches" ? "No matching roles yet. They appear here after the next scan." : "Nothing here yet."}
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-start justify-between gap-4 py-4">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <a href={j.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {j.title}
                  </a>
                  {j.fit_score != null && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${scoreClass(j.fit_score)}`}>{j.fit_score}% fit</span>
                  )}
                  {j.scored_by?.startsWith("ollama:") && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-mute" title={`Scored by ${j.scored_by}`}>
                      local model
                    </span>
                  )}
                  {j.closed_at && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-mute">closed</span>}
                </div>
                <div className="text-xs text-mute">
                  {[j.companies?.name, j.location, j.department].filter(Boolean).join(" · ")} · found {timeAgo(j.first_seen_at)}
                </div>
                {j.fit_reason && <p className="text-sm">{j.fit_reason}</p>}
                {j.gaps.length > 0 && <p className="text-xs text-mute">Gaps: {j.gaps.join(", ")}</p>}
                {j.salary && (
                  <p className="text-xs text-mute">
                    Pay: {j.salary.text}
                    {j.salary.basis === "posting" ? " (from the posting)" : j.salary.basis === "research" ? ` (estimate, ${j.salary.confidence} confidence)` : " (unverified estimate)"}
                  </p>
                )}
              </div>
              <StatusSelect id={j.id} status={j.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
