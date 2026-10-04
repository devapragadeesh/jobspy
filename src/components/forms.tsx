"use client";

import { useActionState, useTransition, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { addCompany, login, saveSettings, scanNow, setJobStatus, type FormState } from "@/app/actions";
import { JOB_STATUSES, type JobStatus, type Settings } from "@/lib/types";

const input =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-ink";
const primary = "rounded-md bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-50";

export function SubmitButton({ children, className = primary }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? "Working…" : children}
    </button>
  );
}

function Message({ state }: { state: FormState }) {
  if (state.error) return <p role="alert" className="text-sm text-red-700">{state.error}</p>;
  if (state.ok) return <p role="status" className="text-sm text-green-700">{state.ok}</p>;
  return null;
}

export function LoginForm() {
  const [state, action] = useActionState(login, {});
  return (
    <form action={action} className="space-y-3">
      <input name="password" type="password" required autoFocus placeholder="Password" aria-label="Password" className={input} />
      <SubmitButton className={`${primary} w-full`}>Sign in</SubmitButton>
      <Message state={state} />
    </form>
  );
}

export function AddCompanyForm() {
  const [state, action] = useActionState(addCompany, {});
  return (
    <form action={action} className="space-y-2">
      <div className="flex gap-2">
        <input
          // Remount after a successful add so the field clears.
          key={state.ok}
          name="url"
          required
          inputMode="url"
          placeholder="Paste a careers page URL"
          aria-label="Careers page URL"
          className={input}
        />
        <SubmitButton>Add</SubmitButton>
      </div>
      <Message state={state} />
    </form>
  );
}

export function ScanNowForm({ companyId, label = "Scan now" }: { companyId?: string; label?: string }) {
  const [state, action] = useActionState(scanNow, {});
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={companyId ?? ""} />
      <SubmitButton className="text-sm text-mute underline-offset-2 hover:text-ink hover:underline disabled:opacity-50">
        {label}
      </SubmitButton>
      {state.ok && <span role="status" className="text-xs text-green-700">{state.ok}</span>}
      {state.error && <span role="alert" className="text-xs text-red-700">{state.error}</span>}
    </form>
  );
}

export function StatusSelect({ id, status }: { id: string; status: JobStatus }) {
  const [pending, start] = useTransition();
  return (
    <select
      aria-label="Status"
      defaultValue={status}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value as JobStatus;
        start(() => setJobStatus(id, next));
      }}
      className="rounded-md border border-line bg-white px-2 py-1 text-xs capitalize disabled:opacity-50"
    >
      {JOB_STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-mute">{hint}</span>}
    </label>
  );
}

type SettingsFields = Pick<
  Settings,
  "resume_filename" | "resume_profile" | "target_roles" | "departments" | "locations" | "exclude_keywords" | "min_score" | "alert_to"
>;

export function SettingsForm({ settings }: { settings: SettingsFields }) {
  const [state, action] = useActionState(saveSettings, {});
  const profile = settings.resume_profile;
  return (
    <form action={action} className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mute">Resume</h2>
        {settings.resume_filename ? (
          <div className="rounded-md border border-line bg-card p-3 text-sm">
            <div className="font-medium">{settings.resume_filename}</div>
            {profile && (
              <>
                <div className="mt-1 text-mute">{profile.headline}</div>
                {profile.suggested_titles.length > 0 && (
                  <div className="mt-2 text-xs text-mute">Matching against titles like: {profile.suggested_titles.join(", ")}</div>
                )}
              </>
            )}
            <label className="mt-3 flex items-center gap-2 text-xs text-mute">
              <input type="checkbox" name="remove_resume" /> Remove this resume
            </label>
          </div>
        ) : (
          <p className="text-sm text-mute">No resume yet. Without one, roles are matched on the titles below and not scored.</p>
        )}
        <Field label={settings.resume_filename ? "Replace resume" : "Upload resume"} hint="PDF or plain text, up to 3.5 MB.">
          <input name="resume" type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" className="block w-full text-sm" />
        </Field>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mute">What to look for</h2>
        <Field label="Roles" hint="Comma separated. Leave empty to match on your resume alone.">
          <input name="target_roles" defaultValue={settings.target_roles.join(", ")} placeholder="Data Scientist, ML Engineer" className={input} />
        </Field>
        <Field label="Departments" hint="Comma separated.">
          <input name="departments" defaultValue={settings.departments.join(", ")} placeholder="Engineering, Data" className={input} />
        </Field>
        <Field label="Locations" hint="Only roles whose location contains one of these. Add Remote to include remote roles. Empty means anywhere.">
          <input name="locations" defaultValue={settings.locations.join(", ")} placeholder="Bengaluru, Chennai, Remote" className={input} />
        </Field>
        <Field label="Never show titles containing" hint="Comma separated.">
          <input name="exclude_keywords" defaultValue={settings.exclude_keywords.join(", ")} placeholder="Intern, Director" className={input} />
        </Field>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-mute">Alerts</h2>
        <Field label="Send alerts to" hint="Leave empty to send to the Gmail account that does the sending.">
          <input name="alert_to" type="email" defaultValue={settings.alert_to ?? ""} placeholder="you@example.com" className={input} />
        </Field>
        <Field label="Minimum fit score" hint="Roles scoring below this against your resume are kept in the tracker but not emailed.">
          <input name="min_score" type="number" min={0} max={100} defaultValue={settings.min_score} className={`${input} max-w-28`} />
        </Field>
      </section>

      <div className="flex items-center gap-4">
        <SubmitButton>Save</SubmitButton>
        <Message state={state} />
      </div>
    </form>
  );
}
