import { generateJson } from "@/lib/llm";
import type { Company, CompanyResearch, Job, SalaryEstimate } from "@/lib/types";
import { formatEvidence, pickSources, searchWeb, wikipedia, withPageText, type Evidence } from "./search";

export const RESEARCH_TTL_DAYS = 30;

export function researchIsStale(company: Pick<Company, "research" | "researched_at">, now = Date.now()): boolean {
  if (!company.research || !company.researched_at) return true;
  return now - new Date(company.researched_at).getTime() > RESEARCH_TTL_DAYS * 86_400_000;
}

const FROM_EVIDENCE = `Use ONLY the numbered evidence below. Prefer the most recent figures and give the year each refers to.
If the evidence doesn't cover something, write "not found" rather than filling it in from memory.
Ignore evidence that is about a different organisation with a similar name.
List in sources_used the evidence numbers you relied on.`;

const FROM_MEMORY = `You cannot search the web. Answer from what you know, give the year each figure refers to,
and write "not known" for anything you are unsure of rather than guessing.`;

const COMPANY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-3 sentences: what the company does and who buys from it" },
    top_products: { type: "array", items: { type: "string" }, description: "up to 5, each 'Name — what it is' in under 15 words" },
    flagship: {
      type: "object",
      properties: {
        name: { type: "string" },
        where_used: { type: "string", description: "1-2 sentences on who uses it and for what, with a concrete example" },
      },
      required: ["name", "where_used"],
    },
    key_stats: {
      type: "array",
      items: { type: "string" },
      description: "4-6 facts with the year: revenue, headcount, customers/users, valuation or market cap, funding, founded/HQ",
    },
    growth_outlook: { type: "string", description: "2-3 sentences: recent growth rate and projected growth, with figures and time frame" },
    sources_used: { type: "array", items: { type: "integer" } },
  },
  required: ["summary", "top_products", "flagship", "key_stats", "growth_outlook", "sources_used"],
};

type CompanyAnswer = Omit<CompanyResearch, "sources" | "grounded"> & { sources_used?: number[] };

/** Company brief built from live web search results and Wikipedia, or from model memory if neither is reachable. */
export async function researchCompany(company: Pick<Company, "name" | "careers_url">): Promise<CompanyResearch> {
  const year = new Date().getFullYear();
  const host = new URL(company.careers_url).hostname;

  const facts = await searchWeb(`${company.name} company products revenue employees valuation ${year}`, 7);
  const outlook = await searchWeb(`${company.name} revenue growth forecast outlook ${year}`, 5);
  const wiki = await wikipedia(company.name);
  // Snippets are short; read the two most relevant pages in full where the site allows it.
  const detailed = await Promise.all(facts.slice(0, 2).map((e) => withPageText(e)));
  const byUrl = new Map<string, Evidence>();
  for (const e of [...(wiki ? [wiki] : []), ...detailed, ...facts.slice(2), ...outlook]) if (!byUrl.has(e.url)) byUrl.set(e.url, e);
  const evidence = [...byUrl.values()];

  const task = `Write a brief on the company "${company.name}" (careers site: ${host}) for a job seeker deciding whether to apply.
Cover: what it does, its top products, its best-known product and where that product is applied in the
real world, key statistics, and the projected growth of the company or its market.`;

  const data = await generateJson<CompanyAnswer>(
    evidence.length ? `${task}\n\n${FROM_EVIDENCE}\n\n## Evidence\n${formatEvidence(evidence)}` : `${task}\n\n${FROM_MEMORY}`,
    COMPANY_SCHEMA,
  );
  return {
    summary: data.summary,
    top_products: (data.top_products ?? []).slice(0, 5),
    flagship: data.flagship,
    key_stats: (data.key_stats ?? []).slice(0, 6),
    growth_outlook: data.growth_outlook,
    sources: evidence.length ? pickSources(evidence, data.sources_used) : [],
    grounded: evidence.length > 0,
  };
}

const SALARY_SCHEMA = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "integer", description: "the role number" },
          text: {
            type: "string",
            description: "under 110 characters, e.g. '₹28–40 LPA total (base ₹24–32 LPA)' or '$165k–$210k base + equity'",
          },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sources_used: { type: "array", items: { type: "integer" } },
        },
        required: ["role", "text", "confidence", "sources_used"],
      },
    },
  },
  required: ["roles"],
};

type Role = Pick<Job, "id" | "title" | "location">;
type SalaryAnswer = { roles?: { role: number; text: string; confidence: SalaryEstimate["confidence"]; sources_used?: number[] }[] };

/** Expected pay for several roles at one company in a single model call. Keyed by job id. */
export async function estimateSalaries(company: Pick<Company, "name">, roles: Role[]): Promise<Map<string, SalaryEstimate>> {
  const out = new Map<string, SalaryEstimate>();
  if (!roles.length) return out;

  // Roles sharing a title and location share one search.
  const searches = new Map<string, Evidence[]>();
  const evidence: Evidence[] = [];
  const offsets: number[][] = [];
  for (const role of roles) {
    const query = `${company.name} ${role.title} salary ${role.location ?? ""}`.trim();
    let found = searches.get(query);
    if (!found) {
      found = await searchWeb(query, 5);
      searches.set(query, found);
    }
    const indices: number[] = [];
    for (const item of found) {
      let i = evidence.findIndex((e) => e.url === item.url);
      if (i < 0) i = evidence.push(item) - 1;
      indices.push(i);
    }
    offsets.push(indices);
  }

  const listing = roles
    .map((r, i) => `Role ${i}: "${r.title}"${r.location ? ` in ${r.location}` : ""}${evidence.length ? ` — relevant evidence: ${offsets[i].join(", ") || "none"}` : ""}`)
    .join("\n");
  const task = `Estimate the expected annual pay for each of these roles at ${company.name}.
Prefer figures specific to this company and level; otherwise the market range for the role and seniority in
that location. Use the local currency of the job location and give a range, not a single number.
confidence: "high" for company-and-level-specific data, "medium" for company-level data, "low" for a general estimate.

${listing}`;

  const data = await generateJson<SalaryAnswer>(
    evidence.length ? `${task}\n\n${FROM_EVIDENCE}\n\n## Evidence\n${formatEvidence(evidence)}` : `${task}\n\n${FROM_MEMORY}`,
    SALARY_SCHEMA,
  );
  for (const answer of data.roles ?? []) {
    const role = roles[answer.role];
    if (!role || !answer.text?.trim()) continue;
    const grounded = offsets[answer.role].length > 0;
    out.set(role.id, {
      text: answer.text.trim(),
      basis: grounded ? "research" : "unverified",
      confidence: grounded ? answer.confidence : "low",
      sources: grounded ? pickSources(evidence, answer.sources_used?.length ? answer.sources_used : offsets[answer.role], 3) : [],
    });
  }
  return out;
}
