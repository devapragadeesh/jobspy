import type { AtsConfig, DiscoveredJob } from "@/lib/types";
import { getJson, htmlToText } from "../text";

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean; fullLocation?: string };
  department?: { label?: string };
}

const PAGE = 100;

export async function discoverSmartRecruiters(
  config: AtsConfig,
  maxJobs: number,
): Promise<{ jobs: DiscoveredJob[]; truncated: boolean }> {
  const base = `https://api.smartrecruiters.com/v1/companies/${config.company}/postings`;
  const jobs: DiscoveredJob[] = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < maxJobs; offset += PAGE) {
    const page = await getJson<{ totalFound: number; content: SrPosting[] }>(`${base}?limit=${PAGE}&offset=${offset}`);
    total = page.totalFound;
    if (page.content.length === 0) break;
    for (const p of page.content) {
      const loc = p.location;
      const place = loc?.fullLocation ?? [loc?.city, loc?.region, loc?.country?.toUpperCase()].filter(Boolean).join(", ");
      jobs.push({
        key: `sr:${p.id}`,
        title: p.name.trim(),
        url: `https://jobs.smartrecruiters.com/${config.company}/${p.id}`,
        location: [place, loc?.remote ? "Remote" : ""].filter(Boolean).join(" · ") || undefined,
        department: p.department?.label,
        postedAt: p.releasedDate,
      });
    }
  }
  return { jobs, truncated: total > jobs.length && jobs.length >= maxJobs };
}

export async function describeSmartRecruiters(config: AtsConfig, job: { external_key: string }): Promise<string | null> {
  const id = job.external_key.replace(/^sr:/, "");
  const data = await getJson<{ jobAd?: { sections?: Record<string, { title?: string; text?: string }> } }>(
    `https://api.smartrecruiters.com/v1/companies/${config.company}/postings/${id}`,
  );
  const sections = Object.values(data.jobAd?.sections ?? {})
    .filter((s) => s.text)
    .map((s) => `${s.title ?? ""}\n${htmlToText(s.text!)}`);
  return sections.length ? sections.join("\n\n") : null;
}
