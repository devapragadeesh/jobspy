import { SettingsForm } from "@/components/forms";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import type { Settings } from "@/lib/types";

// Reading a resume PDF with the model can take a while, more so when the first models tried are overloaded.
export const maxDuration = 300;

export default async function SettingsPage() {
  await requireSession();
  const { data: settings, error } = await db().from("settings").select("*").eq("id", 1).single<Settings>();
  if (error) throw new Error(error.message);

  return (
    <SettingsForm
      settings={{
        resume_filename: settings.resume_filename,
        resume_profile: settings.resume_profile,
        target_roles: settings.target_roles,
        departments: settings.departments,
        locations: settings.locations,
        exclude_keywords: settings.exclude_keywords,
        min_score: settings.min_score,
        alert_to: settings.alert_to,
      }}
    />
  );
}
