import { researchJson } from "@/lib/gemini";
import type { Company, CompanyResearch, Job, SalaryEstimate } from "@/lib/types";

export const RESEARCH_TTL_DAYS = 30;

export function researchIsStale(company: Pick<Company, "research" | "researched_at">, now = Date.now()): boolean {
  if (!company.research || !company.researched_at) return true;
  return now - new Date(company.researched_at).getTime() > RESEARCH_TTL_DAYS * 86_400_000;
}

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
  },
  required: ["summary", "top_products", "flagship", "key_stats", "growth_outlook"],
};

export async function researchCompany(company: Pick<Company, "name" | "careers_url">): Promise<CompanyResearch> {
  const host = new URL(company.careers_url).hostname;
  const { data, sources, grounded } = await researchJson<Omit<CompanyResearch, "sources" | "grounded">>(
    `Research the company "${company.name}" (careers site: ${host}) for a job seeker deciding whether to apply.
Use current, verifiable information. Cover: what it does, its top products, its best-known product and
where that product is applied in the real world, key statistics with the year they refer to, and the
projected growth of the company or its market from analyst or company guidance.
State figures plainly; if a figure isn't publicly known (e.g. private-company revenue), say "not disclosed"
rather than guessing.`,
    COMPANY_SCHEMA,
  );
  return {
    summary: data.summary,
    top_products: (data.top_products ?? []).slice(0, 5),
    flagship: data.flagship,
    key_stats: (data.key_stats ?? []).slice(0, 6),
    growth_outlook: data.growth_outlook,
    sources,
    grounded,
  };
}

const SALARY_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "under 110 characters, e.g. '₹28–40 LPA total (base ₹24–32 LPA)' or '$165k–$210k base + equity'",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["text", "confidence"],
};

export async function estimateSalary(
  company: Pick<Company, "name">,
  job: Pick<Job, "title" | "location">,
): Promise<SalaryEstimate> {
  const where = job.location ? ` in ${job.location}` : "";
  const { data, sources, grounded } = await researchJson<{ text: string; confidence: SalaryEstimate["confidence"] }>(
    `What is the expected annual pay for the role "${job.title}" at ${company.name}${where}?
Prefer figures specific to this company and level (its own posted ranges for the same role, Levels.fyi,
Glassdoor, AmbitionBox). If there are none, give the market range for this role and seniority in that
location. Use the local currency of the job location and give a range, not a single number.
confidence: "high" for company-and-level-specific data, "medium" for company-level data,
"low" for a general market estimate.`,
    SALARY_SCHEMA,
  );
  return {
    text: data.text,
    basis: grounded ? "research" : "unverified",
    confidence: grounded ? data.confidence : "low",
    sources,
  };
}
