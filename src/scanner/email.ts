import nodemailer from "nodemailer";
import type { Company, Job, SalaryEstimate, Source } from "@/lib/types";

export interface DigestGroup {
  company: Company;
  jobs: Job[];
  /** Matching roles beyond the ones listed, visible in the tracker. */
  more: number;
}

export interface Digest {
  groups: DigestGroup[];
  closed: { company: Company; job: Job }[];
  unhealthy: Company[];
  notes: string[];
  appUrl?: string;
}

export function digestIsEmpty(d: Digest): boolean {
  return d.groups.length === 0 && d.closed.length === 0 && d.unhealthy.length === 0;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function digestSubject(d: Digest): string {
  const parts: string[] = [];
  const roles = d.groups.reduce((n, g) => n + g.jobs.length + g.more, 0);
  if (roles) {
    const names = d.groups.map((g) => g.company.name);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
    parts.push(`${plural(roles, "new role")} at ${shown}`);
  }
  if (d.closed.length) parts.push(`${plural(d.closed.length, "tracked role")} closed`);
  if (d.unhealthy.length) parts.push(`${plural(d.unhealthy.length, "careers page")} failing`);
  return `[jobspy] ${parts.join(" · ")}`;
}

const C = { ink: "#111827", mute: "#6b7280", line: "#e5e7eb", card: "#f9fafb", link: "#1d4ed8", warn: "#b45309" };

function sourceLinks(sources: Source[]): string {
  if (!sources.length) return "";
  const links = sources
    .slice(0, 4)
    .map((s) => `<a href="${esc(s.url)}" style="color:${C.mute}">${esc(s.title)}</a>`)
    .join(" · ");
  return `<div style="font-size:11px;color:${C.mute};margin-top:4px">Sources: ${links}</div>`;
}

function payLine(s: SalaryEstimate | null): string {
  if (!s) return `<div style="font-size:13px;color:${C.mute};margin-top:6px">Expected pay: not researched yet</div>`;
  const label =
    s.basis === "posting"
      ? "stated in the posting"
      : s.basis === "research"
        ? `researched estimate, ${s.confidence} confidence`
        : "unverified estimate";
  return `<div style="font-size:13px;margin-top:6px"><b>Expected pay:</b> ${esc(s.text)} <span style="color:${C.mute}">(${label})</span></div>${sourceLinks(s.sources)}`;
}

function scorePill(score: number | null): string {
  if (score == null) return "";
  const bg = score >= 80 ? "#dcfce7" : score >= 65 ? "#fef9c3" : "#f3f4f6";
  const fg = score >= 80 ? "#166534" : score >= 65 ? "#854d0e" : "#374151";
  return `<span style="background:${bg};color:${fg};font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap">${score}% fit</span>`;
}

function companyBrief(c: Company): string {
  const r = c.research;
  if (!r) return "";
  const list = (items: string[]) => items.map((i) => `<li style="margin:2px 0">${esc(i)}</li>`).join("");
  return `<div style="background:${C.card};border:1px solid ${C.line};border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;margin:10px 0 16px">
  <div>${esc(r.summary)}</div>
  <div style="margin-top:10px"><b>Best known for:</b> ${esc(r.flagship.name)} — ${esc(r.flagship.where_used)}</div>
  ${r.top_products.length ? `<div style="margin-top:10px"><b>Top products</b><ul style="margin:4px 0 0;padding-left:18px">${list(r.top_products)}</ul></div>` : ""}
  ${r.key_stats.length ? `<div style="margin-top:10px"><b>Key numbers</b><ul style="margin:4px 0 0;padding-left:18px">${list(r.key_stats)}</ul></div>` : ""}
  <div style="margin-top:10px"><b>Growth outlook:</b> ${esc(r.growth_outlook)}</div>
  ${r.grounded ? sourceLinks(r.sources) : `<div style="font-size:11px;color:${C.warn};margin-top:6px">Not checked against live search — treat figures as approximate.</div>`}
</div>`;
}

function jobBlock(j: Job): string {
  const meta = [j.location, j.department].filter(Boolean).map((m) => esc(m!)).join(" · ");
  return `<div style="border-top:1px solid ${C.line};padding:12px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:15px;font-weight:600"><a href="${esc(j.url)}" style="color:${C.link};text-decoration:none">${esc(j.title)}</a></td>
    <td align="right" valign="top">${scorePill(j.fit_score)}</td>
  </tr></table>
  ${meta ? `<div style="font-size:13px;color:${C.mute};margin-top:2px">${meta}</div>` : ""}
  ${j.fit_reason ? `<div style="font-size:13px;margin-top:6px">${esc(j.fit_reason)}</div>` : ""}
  ${j.matched_skills.length ? `<div style="font-size:12px;color:${C.mute};margin-top:4px">Matches: ${esc(j.matched_skills.join(", "))}</div>` : ""}
  ${j.gaps.length ? `<div style="font-size:12px;color:${C.mute};margin-top:2px">Gaps: ${esc(j.gaps.join(", "))}</div>` : ""}
  ${payLine(j.salary)}
</div>`;
}

export function renderDigest(d: Digest): { subject: string; html: string; text: string } {
  const sections: string[] = [];
  const text: string[] = [];

  for (const g of d.groups) {
    sections.push(`<h2 style="font-size:18px;margin:28px 0 0">${esc(g.company.name)}
  <a href="${esc(g.company.careers_url)}" style="font-size:12px;font-weight:400;color:${C.mute};margin-left:6px">careers page</a></h2>
${companyBrief(g.company)}
${g.jobs.map(jobBlock).join("\n")}
${g.more ? `<div style="font-size:13px;color:${C.mute};border-top:1px solid ${C.line};padding-top:10px">+ ${plural(g.more, "more matching role")} in the tracker</div>` : ""}`);
    text.push(`${g.company.name}`);
    for (const j of g.jobs) {
      text.push(`- ${j.title}${j.fit_score != null ? ` (${j.fit_score}% fit)` : ""}${j.location ? ` — ${j.location}` : ""}`);
      if (j.salary) text.push(`  Expected pay: ${j.salary.text}`);
      text.push(`  ${j.url}`);
    }
    if (g.more) text.push(`+ ${g.more} more in the tracker`);
    text.push("");
  }

  if (d.closed.length) {
    sections.push(`<h2 style="font-size:16px;margin:28px 0 8px">Roles you were tracking that have closed</h2>
<ul style="font-size:13px;padding-left:18px;margin:0">${d.closed
      .map((c) => `<li style="margin:4px 0">${esc(c.job.title)} at ${esc(c.company.name)} <span style="color:${C.mute}">(you marked it ${c.job.status})</span></li>`)
      .join("")}</ul>`);
    text.push("Closed:", ...d.closed.map((c) => `- ${c.job.title} at ${c.company.name} (${c.job.status})`), "");
  }

  if (d.unhealthy.length) {
    sections.push(`<h2 style="font-size:16px;margin:28px 0 8px;color:${C.warn}">Careers pages that stopped scanning</h2>
<ul style="font-size:13px;padding-left:18px;margin:0">${d.unhealthy
      .map((c) => `<li style="margin:4px 0"><a href="${esc(c.careers_url)}" style="color:${C.link}">${esc(c.name)}</a> — ${esc(c.last_scan_error ?? "scan failed")}</li>`)
      .join("")}</ul>
<div style="font-size:12px;color:${C.mute};margin-top:6px">New roles at these companies are not being detected. Check the URL still opens their job list.</div>`);
    text.push("Failing pages:", ...d.unhealthy.map((c) => `- ${c.name}: ${c.last_scan_error ?? "scan failed"}`), "");
  }

  if (d.notes.length) {
    sections.push(`<div style="font-size:12px;color:${C.mute};margin-top:24px">${d.notes.map(esc).join("<br>")}</div>`);
    text.push(...d.notes, "");
  }

  const footer = d.appUrl
    ? `<a href="${esc(d.appUrl)}/jobs" style="color:${C.link}">Open the tracker</a> to save, dismiss or mark roles as applied.`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#ffffff">
<div style="max-width:640px;margin:0 auto;padding:24px 20px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${C.ink}">
  <div style="font-size:13px;font-weight:700;letter-spacing:.04em;color:${C.mute}">JOBSPY</div>
  ${sections.join("\n")}
  <div style="font-size:12px;color:${C.mute};border-top:1px solid ${C.line};margin-top:28px;padding-top:12px">${footer}</div>
</div></body></html>`;

  if (d.appUrl) text.push(`Tracker: ${d.appUrl}/jobs`);
  return { subject: digestSubject(d), html, text: text.join("\n") };
}

export async function sendDigest(to: string, mail: { subject: string; html: string; text: string }): Promise<void> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set to send email");
  const transport = nodemailer.createTransport({
    service: "gmail",
    // App passwords are shown with spaces for readability; SMTP wants them without.
    auth: { user, pass: pass.replace(/\s+/g, "") },
  });
  await transport.sendMail({ from: `jobspy <${user}>`, to, ...mail });
}
