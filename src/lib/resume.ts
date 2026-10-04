import { generateJson, readPdfJson } from "./gemini";
import type { ResumeProfile } from "./types";

const PROFILE_PROPS = {
  headline: { type: "string", description: "one line, e.g. 'Backend engineer, 6 yrs, payments and distributed systems'" },
  years_experience: { type: "number", description: "total years of professional experience; -1 if unclear" },
  skills: { type: "array", items: { type: "string" }, description: "up to 40 concrete skills, tools and technologies" },
  domains: { type: "array", items: { type: "string" }, description: "industries and problem areas worked in" },
  seniority: { type: "string", description: "e.g. entry, mid, senior, staff, manager, director" },
  suggested_titles: {
    type: "array",
    items: { type: "string" },
    description: "6-10 job titles this person should be applying for, most fitting first",
  },
};
const PROFILE_REQUIRED = Object.keys(PROFILE_PROPS);

type Extracted = ResumeProfile & { text?: string };

function toProfile(e: Extracted): ResumeProfile {
  return {
    headline: e.headline,
    years_experience: e.years_experience != null && e.years_experience >= 0 ? e.years_experience : null,
    skills: e.skills ?? [],
    domains: e.domains ?? [],
    seniority: e.seniority,
    suggested_titles: e.suggested_titles ?? [],
  };
}

/** Reads a resume PDF with the model: full text for scoring, plus a compact profile for triage. */
export async function readResumePdf(pdf: Buffer): Promise<{ text: string; profile: ResumeProfile }> {
  const e = await readPdfJson<Extracted>(
    pdf,
    "This is a resume. Put its complete text in `text`, preserving every role, date, skill and achievement. Then fill in the profile fields from it.",
    {
      type: "object",
      properties: { text: { type: "string" }, ...PROFILE_PROPS },
      required: ["text", ...PROFILE_REQUIRED],
    },
  );
  if (!e.text || e.text.trim().length < 100) throw new Error("Couldn't read any text from that PDF");
  return { text: e.text.trim(), profile: toProfile(e) };
}

export async function profileFromText(text: string): Promise<ResumeProfile> {
  const e = await generateJson<Extracted>(`Summarise this resume into the profile fields.\n\n${text.slice(0, 20_000)}`, {
    type: "object",
    properties: PROFILE_PROPS,
    required: PROFILE_REQUIRED,
  });
  return toProfile(e);
}
