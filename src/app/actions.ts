"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { detectAtsFromUrl, guessCompanyName, parseCareersUrl } from "@/lib/ats";
import { createSession, passwordMatches, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth";
import { db } from "@/lib/db";
import { scanTriggerConfigured, triggerScan } from "@/lib/github";
import { profileFromText, readResumePdf } from "@/lib/resume";
import { requireSession } from "@/lib/session";
import { JOB_STATUSES, type JobStatus, type ResumeProfile, type Settings } from "@/lib/types";

export interface FormState {
  ok?: string;
  error?: string;
}

const MAX_RESUME_BYTES = 3_500_000;

export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  if (!passwordMatches(String(form.get("password") ?? ""))) {
    await new Promise((r) => setTimeout(r, 500));
    return { error: "Wrong password" };
  }
  (await cookies()).set(SESSION_COOKIE, createSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function addCompany(_prev: FormState, form: FormData): Promise<FormState> {
  await requireSession();
  const url = parseCareersUrl(String(form.get("url") ?? ""));
  if (!url) return { error: "That doesn't look like a URL" };

  const ats = detectAtsFromUrl(url);
  const name = guessCompanyName(url);
  const { data, error } = await db()
    .from("companies")
    .insert({ name, careers_url: url, ats_type: ats?.type ?? null, ats_config: ats?.config ?? null })
    .select("id")
    .single();
  if (error) return { error: error.code === "23505" ? "That careers page is already on your list" : error.message };

  revalidatePath("/");
  if (!scanTriggerConfigured()) return { ok: `Added ${name}. It will be scanned on the next scheduled run.` };
  try {
    await triggerScan(data.id);
    return { ok: `Added ${name}. First scan started; results arrive in a few minutes.` };
  } catch (err) {
    return { ok: `Added ${name}, but the first scan couldn't be started: ${(err as Error).message}` };
  }
}

export async function renameCompany(form: FormData): Promise<void> {
  await requireSession();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  // The brief was researched under the old name, so it is cleared and redone on the next scan.
  await db().from("companies").update({ name, research: null, researched_at: null }).eq("id", String(form.get("id")));
  revalidatePath("/");
}

export async function setCompanyActive(form: FormData): Promise<void> {
  await requireSession();
  await db().from("companies").update({ active: form.get("active") === "true" }).eq("id", String(form.get("id")));
  revalidatePath("/");
}

export async function deleteCompany(form: FormData): Promise<void> {
  await requireSession();
  await db().from("companies").delete().eq("id", String(form.get("id")));
  revalidatePath("/");
  revalidatePath("/jobs");
}

export async function scanNow(_prev: FormState, form: FormData): Promise<FormState> {
  await requireSession();
  try {
    await triggerScan(String(form.get("id") ?? "") || undefined);
    return { ok: "Scan started. Refresh in a few minutes." };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function setJobStatus(id: string, status: JobStatus): Promise<void> {
  await requireSession();
  if (!JOB_STATUSES.includes(status)) throw new Error("Unknown status");
  const { error } = await db().from("jobs").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/jobs");
}

const list = (form: FormData, key: string) => [
  ...new Set(
    String(form.get(key) ?? "")
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function saveSettings(_prev: FormState, form: FormData): Promise<FormState> {
  await requireSession();
  const { data: current, error: loadError } = await db().from("settings").select("*").eq("id", 1).single<Settings>();
  if (loadError) return { error: loadError.message };

  const alertTo = String(form.get("alert_to") ?? "").trim();
  if (alertTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alertTo)) return { error: "That email address doesn't look right" };
  const minScore = Math.min(100, Math.max(0, Math.round(Number(form.get("min_score")) || 0)));

  const patch: Partial<Settings> = {
    target_roles: list(form, "target_roles"),
    departments: list(form, "departments"),
    locations: list(form, "locations"),
    exclude_keywords: list(form, "exclude_keywords"),
    min_score: minScore,
    alert_to: alertTo || null,
    updated_at: new Date().toISOString(),
  };

  let resumeChanged = false;
  const file = form.get("resume");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_RESUME_BYTES) return { error: "Resume is too large (3.5 MB max)" };
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const isText = file.type.startsWith("text/") || /\.(txt|md)$/i.test(file.name);
    if (!isPdf && !isText) return { error: "Upload the resume as a PDF or a plain text file" };
    try {
      let text: string;
      let profile: ResumeProfile;
      if (isPdf) ({ text, profile } = await readResumePdf(Buffer.from(await file.arrayBuffer())));
      else {
        text = (await file.text()).trim();
        if (text.length < 100) return { error: "That file has too little text to be a resume" };
        profile = await profileFromText(text);
      }
      Object.assign(patch, { resume_filename: file.name, resume_text: text, resume_profile: profile });
      resumeChanged = true;
    } catch (err) {
      return { error: `Couldn't read the resume: ${(err as Error).message}` };
    }
  } else if (form.get("remove_resume") === "on" && current.resume_text) {
    Object.assign(patch, { resume_filename: null, resume_text: null, resume_profile: null });
    resumeChanged = true;
  }

  const { error } = await db().from("settings").update(patch).eq("id", 1);
  if (error) return { error: error.message };

  const criteriaChanged =
    resumeChanged ||
    !same(patch.target_roles!, current.target_roles) ||
    !same(patch.departments!, current.departments) ||
    !same(patch.locations!, current.locations) ||
    !same(patch.exclude_keywords!, current.exclude_keywords);
  if (criteriaChanged) {
    // Re-judge open roles against the new criteria on the next scan. Roles already emailed keep
    // their notified mark, so nothing is sent twice.
    await db().from("jobs").update({ relevant: null }).is("closed_at", null).is("notified_at", null).not("relevant", "is", null);
    await db()
      .from("jobs")
      .update({ fit_score: null, fit_reason: null, matched_skills: [], gaps: [] })
      .is("closed_at", null)
      .is("notified_at", null)
      .not("fit_score", "is", null);
  }

  revalidatePath("/", "layout");
  return {
    ok: criteriaChanged
      ? "Saved. Open roles will be re-matched against your new criteria on the next scan."
      : "Saved.",
  };
}
