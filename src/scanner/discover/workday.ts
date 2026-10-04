import type { AtsConfig, DiscoveredJob } from "@/lib/types";
import { getJson, htmlToText } from "../text";

interface WdPosting {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

const PAGE = 20; // Workday rejects larger pages
const WORKDAY_CAP = 2000;

export async function discoverWorkday(
  config: AtsConfig,
  maxJobs: number,
): Promise<{ jobs: DiscoveredJob[]; truncated: boolean }> {
  const api = `https://${config.host}/wday/cxs/${config.tenant}/${config.site}/jobs`;
  const jobs: DiscoveredJob[] = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset < maxJobs; offset += PAGE) {
    const page = await getJson<{ total?: number; jobPostings?: WdPosting[] }>(api, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText: "" }),
    });
    // `total` is only reliable on the first page; later pages report 0.
    if (offset === 0) total = page.total ?? 0;
    const postings = page.jobPostings ?? [];
    if (postings.length === 0) break;
    for (const p of postings) {
      if (!p.title || !p.externalPath) continue;
      jobs.push({
        key: `wd:${p.externalPath}`,
        title: p.title.trim(),
        url: `https://${config.host}/${config.site}${p.externalPath}`,
        location: p.locationsText,
      });
    }
  }
  // Workday never reports or serves more than 2000 results, so a full 2000 means there may be more.
  return { jobs, truncated: total >= WORKDAY_CAP || (total > jobs.length && jobs.length >= maxJobs) };
}

export async function describeWorkday(config: AtsConfig, job: { external_key: string }): Promise<string | null> {
  const path = job.external_key.replace(/^wd:/, "");
  const data = await getJson<{ jobPostingInfo?: { jobDescription?: string } }>(
    `https://${config.host}/wday/cxs/${config.tenant}/${config.site}${path}`,
  );
  const html = data.jobPostingInfo?.jobDescription;
  return html ? htmlToText(html) : null;
}
