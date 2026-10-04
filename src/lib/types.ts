export type AtsType =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "smartrecruiters"
  | "generic";

export const JOB_STATUSES = [
  "new",
  "saved",
  "applied",
  "interviewing",
  "rejected",
  "dismissed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses that mean "I care about this role", so its closing is worth an alert. */
export const TRACKED_STATUSES: JobStatus[] = ["saved", "applied", "interviewing"];

export interface Source {
  title: string;
  url: string;
}

export interface ResumeProfile {
  headline: string;
  years_experience: number | null;
  skills: string[];
  domains: string[];
  seniority: string;
  suggested_titles: string[];
}

export interface Settings {
  id: 1;
  resume_filename: string | null;
  resume_text: string | null;
  resume_profile: ResumeProfile | null;
  target_roles: string[];
  departments: string[];
  locations: string[];
  exclude_keywords: string[];
  min_score: number;
  alert_to: string | null;
  scan_interval_hours: number;
  updated_at: string;
}

export interface CompanyResearch {
  summary: string;
  top_products: string[];
  flagship: { name: string; where_used: string };
  key_stats: string[];
  growth_outlook: string;
  sources: Source[];
  /** false when search grounding was unavailable and this came from model memory alone */
  grounded: boolean;
}

export interface SalaryEstimate {
  text: string;
  basis: "posting" | "research" | "unverified";
  confidence: "high" | "medium" | "low";
  sources: Source[];
}

export type AtsConfig = Record<string, string>;

export interface Company {
  id: string;
  name: string;
  careers_url: string;
  ats_type: AtsType | null;
  ats_config: AtsConfig | null;
  active: boolean;
  research: CompanyResearch | null;
  researched_at: string | null;
  last_scan_at: string | null;
  last_scan_status: "ok" | "empty" | "error" | null;
  last_scan_error: string | null;
  consecutive_failures: number;
  health_alerted_at: string | null;
  last_job_count: number | null;
  created_at: string;
}

export interface Job {
  id: string;
  company_id: string;
  external_key: string;
  title: string;
  location: string | null;
  department: string | null;
  url: string;
  description: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  missed_scans: number;
  closed_at: string | null;
  closed_notified_at: string | null;
  relevant: boolean | null;
  fit_score: number | null;
  fit_reason: string | null;
  matched_skills: string[];
  gaps: string[];
  salary: SalaryEstimate | null;
  status: JobStatus;
  notified_at: string | null;
}

/** A posting as found on a careers page, before it is stored. */
export interface DiscoveredJob {
  key: string;
  title: string;
  url: string;
  location?: string;
  department?: string;
  description?: string;
  postedAt?: string;
  /** Pay stated by the ATS itself, when it exposes one. */
  postedPay?: string;
}
