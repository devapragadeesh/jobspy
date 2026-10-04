import type { AtsConfig, DiscoveredJob } from "@/lib/types";
import { getJson } from "../text";

interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  department?: string;
  team?: string;
  isListed?: boolean;
  publishedAt?: string;
  descriptionPlain?: string;
  compensation?: { compensationTierSummary?: string; scrapeableCompensationSalarySummary?: string };
}

export async function discoverAshby(config: AtsConfig): Promise<DiscoveredJob[]> {
  const data = await getJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(config.board)}?includeCompensation=true`,
  );
  return data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      key: `ashby:${j.id}`,
      title: j.title.trim(),
      url: j.jobUrl,
      location: j.location,
      department: [j.department, j.team].filter(Boolean).join(" / ") || undefined,
      description: j.descriptionPlain,
      postedAt: j.publishedAt,
      postedPay: j.compensation?.compensationTierSummary || j.compensation?.scrapeableCompensationSalarySummary || undefined,
    }));
}
