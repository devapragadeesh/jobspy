import type { AtsConfig, DiscoveredJob } from "@/lib/types";
import { getJson } from "../text";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text: string; content: string }[];
  categories?: { location?: string; team?: string; department?: string; commitment?: string };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export async function discoverLever(config: AtsConfig): Promise<DiscoveredJob[]> {
  const host = config.eu ? "api.eu.lever.co" : "api.lever.co";
  // One unpaginated response with every description: several MB for large boards, and slow.
  const postings = await getJson<LeverPosting[]>(`https://${host}/v0/postings/${config.company}?mode=json`, {}, 180_000);
  return postings.map((p) => {
    const lists = (p.lists ?? [])
      .map((l) => `${l.text}\n${l.content.replace(/<li[^>]*>/g, "• ").replace(/<[^>]+>/g, "\n")}`)
      .join("\n\n");
    const pay = p.salaryRange;
    return {
      key: `lever:${p.id}`,
      title: p.text.trim(),
      url: p.hostedUrl,
      location: p.categories?.location,
      department: [p.categories?.department, p.categories?.team].filter(Boolean).join(" / ") || undefined,
      description: [p.descriptionPlain, lists, p.additionalPlain].filter(Boolean).join("\n\n") || undefined,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : undefined,
      postedPay:
        pay?.min && pay?.max
          ? `${pay.currency ?? ""} ${pay.min.toLocaleString()}–${pay.max.toLocaleString()} ${pay.interval ?? ""}`.trim()
          : undefined,
    };
  });
}
