import { detectAtsFromUrl, detectAtsInHtml, type AtsMatch } from "@/lib/ats";
import type { AtsConfig, AtsType, Company, DiscoveredJob } from "@/lib/types";
import { http } from "../text";
import { discoverAshby } from "./ashby";
import { describeGeneric, extractJobs, render, type KnownJob } from "./generic";
import { discoverGreenhouse } from "./greenhouse";
import { discoverLever } from "./lever";
import { describeSmartRecruiters, discoverSmartRecruiters } from "./smartrecruiters";
import { describeWorkday, discoverWorkday } from "./workday";

/** Above this, a board is too large to page through politely; closed-role detection is skipped. */
export const MAX_JOBS_PER_COMPANY = 3000;

export interface DiscoverResult {
  jobs: DiscoveredJob[];
  atsType: AtsType;
  atsConfig: AtsConfig | null;
  /** true when the board had more postings than were read, so absence doesn't imply closure */
  truncated: boolean;
}

async function runAdapter(ats: AtsMatch): Promise<{ jobs: DiscoveredJob[]; truncated: boolean }> {
  switch (ats.type) {
    case "greenhouse":
      return { jobs: await discoverGreenhouse(ats.config), truncated: false };
    case "lever":
      return { jobs: await discoverLever(ats.config), truncated: false };
    case "ashby":
      return { jobs: await discoverAshby(ats.config), truncated: false };
    case "workday":
      return discoverWorkday(ats.config, MAX_JOBS_PER_COMPANY);
    case "smartrecruiters":
      return discoverSmartRecruiters(ats.config, MAX_JOBS_PER_COMPANY);
  }
}

function dedupe(jobs: DiscoveredJob[]): DiscoveredJob[] {
  const byKey = new Map<string, DiscoveredJob>();
  for (const job of jobs) if (!byKey.has(job.key)) byKey.set(job.key, job);
  return [...byKey.values()];
}

type Target = Pick<Company, "name" | "careers_url" | "ats_type" | "ats_config">;

/**
 * Lists the open roles on a company's careers page.
 * Known ATS boards are read through their public JSON API; anything else is rendered
 * in a browser and its links classified by the model.
 */
export async function discover(company: Target, known: Map<string, KnownJob>): Promise<DiscoverResult> {
  const stored: AtsMatch | null =
    company.ats_type && company.ats_type !== "generic" && company.ats_config
      ? { type: company.ats_type, config: company.ats_config }
      : null;
  const direct = stored ?? detectAtsFromUrl(company.careers_url);
  if (direct) {
    const { jobs, truncated } = await runAdapter(direct);
    return { jobs: dedupe(jobs), atsType: direct.type, atsConfig: direct.config, truncated };
  }

  // The company's own page may embed a board. A wrong guess here must not break the scan,
  // so adapter failures fall through to the browser path.
  const tryEmbedded = async (html: string): Promise<DiscoverResult | null> => {
    const embedded = detectAtsInHtml(html);
    if (!embedded) return null;
    try {
      const { jobs, truncated } = await runAdapter(embedded);
      if (jobs.length === 0) return null;
      return { jobs: dedupe(jobs), atsType: embedded.type, atsConfig: embedded.config, truncated };
    } catch {
      return null;
    }
  };

  if (company.ats_type === null) {
    const res = await http(company.careers_url).catch(() => null);
    const viaHtml = res?.ok ? await tryEmbedded(await res.text()) : null;
    if (viaHtml) return viaHtml;
  }

  const rendered = await render(company.careers_url);
  const viaRendered = await tryEmbedded(rendered.html);
  if (viaRendered) return viaRendered;

  const jobs = await extractJobs(company.name, company.careers_url, rendered, known);
  return { jobs: dedupe(jobs), atsType: "generic", atsConfig: null, truncated: false };
}

/** Fetches a posting's full text for boards whose listing API doesn't include it. */
export async function describe(
  company: Pick<Company, "ats_type" | "ats_config">,
  job: { external_key: string; url: string },
): Promise<string | null> {
  // Postings read off page text have no page of their own; the careers page is not a description.
  if (job.external_key.startsWith("text:")) return null;
  try {
    if (company.ats_type === "workday" && company.ats_config) return await describeWorkday(company.ats_config, job);
    if (company.ats_type === "smartrecruiters" && company.ats_config) {
      return await describeSmartRecruiters(company.ats_config, job);
    }
    return await describeGeneric(job.url);
  } catch {
    return null;
  }
}
