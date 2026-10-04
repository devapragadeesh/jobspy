import { describe, expect, it } from "vitest";
import { digestIsEmpty, renderDigest, type Digest } from "@/scanner/email";
import type { Company, Job } from "@/lib/types";

const company = (over: Partial<Company> = {}): Company => ({
  id: "c1",
  name: "Acme <Labs>",
  careers_url: "https://acme.test/careers",
  ats_type: "generic",
  ats_config: null,
  active: true,
  research: {
    summary: "Acme makes anvils.",
    top_products: ["Anvil — a heavy thing"],
    flagship: { name: "Anvil", where_used: "Used by coyotes." },
    key_stats: ["Revenue $1B (2025)"],
    growth_outlook: "Expected to grow 10% a year through 2028.",
    sources: [{ title: "acme.test", url: "https://acme.test/about" }],
    grounded: true,
  },
  researched_at: "2026-10-01T00:00:00Z",
  last_scan_at: null,
  last_scan_status: null,
  last_scan_error: null,
  consecutive_failures: 0,
  health_alerted_at: null,
  last_job_count: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  company_id: "c1",
  external_key: "k1",
  title: "Data Engineer",
  location: "Chennai",
  department: "Data",
  url: "https://acme.test/careers/1",
  description: null,
  posted_at: null,
  first_seen_at: "2026-10-01T00:00:00Z",
  last_seen_at: "2026-10-01T00:00:00Z",
  missed_scans: 0,
  closed_at: null,
  closed_notified_at: null,
  relevant: true,
  fit_score: 82,
  fit_reason: "Strong Spark and SQL overlap.",
  matched_skills: ["Spark"],
  gaps: ["Kafka"],
  salary: { text: "₹30–40 LPA", basis: "research", confidence: "medium", sources: [] },
  status: "new",
  notified_at: null,
  ...over,
});

const empty: Digest = { groups: [], closed: [], unhealthy: [], notes: [] };

describe("renderDigest", () => {
  it("is empty only when there is nothing to report", () => {
    expect(digestIsEmpty(empty)).toBe(true);
    expect(digestIsEmpty({ ...empty, unhealthy: [company()] })).toBe(false);
  });

  it("renders roles with brief, score and pay, and escapes HTML", () => {
    const mail = renderDigest({ ...empty, groups: [{ company: company(), jobs: [job()], more: 2 }], appUrl: "https://app.test" });
    expect(mail.subject).toBe("[jobspy] 3 new roles at Acme <Labs>");
    expect(mail.html).toContain("Acme &lt;Labs&gt;");
    expect(mail.html).not.toContain("<Labs>");
    expect(mail.html).toContain("82% fit");
    expect(mail.html).toContain("₹30–40 LPA");
    expect(mail.html).toContain("researched estimate, medium confidence");
    expect(mail.html).toContain("Best known for:");
    expect(mail.html).toContain("+ 2 more matching roles in the tracker");
    expect(mail.html).toContain("https://app.test/jobs");
    expect(mail.text).toContain("- Data Engineer (82% fit) — Chennai");
  });

  it("flags an unverified brief and a missing pay estimate", () => {
    const c = company({ research: { ...company().research!, grounded: false } });
    const mail = renderDigest({ ...empty, groups: [{ company: c, jobs: [job({ salary: null })], more: 0 }] });
    expect(mail.html).toContain("Not checked against live search");
    expect(mail.html).toContain("not researched yet");
  });

  it("reports closed tracked roles and failing pages in the subject and body", () => {
    const mail = renderDigest({
      ...empty,
      closed: [{ company: company({ name: "Acme" }), job: job({ status: "applied" }) }],
      unhealthy: [company({ name: "Globex", last_scan_error: "No roles found on the page" })],
    });
    expect(mail.subject).toBe("[jobspy] 1 tracked role closed · 1 careers page failing");
    expect(mail.html).toContain("you marked it applied");
    expect(mail.html).toContain("No roles found on the page");
  });
});
