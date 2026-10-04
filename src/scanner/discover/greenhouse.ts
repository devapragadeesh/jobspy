import type { AtsConfig, DiscoveredJob } from "@/lib/types";
import { decodeEntities, getJson, htmlToText } from "../text";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  departments?: { name: string }[];
  content?: string;
  first_published?: string;
  updated_at?: string;
}

export async function discoverGreenhouse(config: AtsConfig): Promise<DiscoveredJob[]> {
  const path = `/v1/boards/${config.token}/jobs?content=true`;
  let data: { jobs: GhJob[] };
  try {
    data = await getJson(`https://boards-api.greenhouse.io${path}`);
  } catch (err) {
    // EU-hosted boards live on a separate API host.
    data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.eu.greenhouse.io${path}`).catch(() => {
      throw err;
    });
  }
  return data.jobs.map((j) => ({
    key: `gh:${j.id}`,
    title: j.title.trim(),
    url: j.absolute_url,
    location: j.location?.name,
    department: j.departments?.map((d) => d.name).join(", ") || undefined,
    // `content` is entity-escaped HTML.
    description: j.content ? htmlToText(decodeEntities(j.content)) : undefined,
    postedAt: j.first_published ?? j.updated_at,
  }));
}
