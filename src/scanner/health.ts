import type { Company } from "@/lib/types";

export type ScanOutcome = { kind: "ok"; count: number } | { kind: "error"; message: string };

export interface HealthUpdate {
  last_scan_status: "ok" | "empty" | "error";
  last_scan_error: string | null;
  consecutive_failures: number;
  /** A careers page that fails this many scans in a row is reported once. */
  alert: boolean;
}

export const ALERT_AFTER_FAILURES = 2;

/**
 * A scan that errors, or finds nothing at all, counts as a failure: an empty careers page
 * far more often means the page changed or blocked us than that every role closed at once.
 */
export function nextHealth(
  company: Pick<Company, "consecutive_failures" | "last_job_count" | "health_alerted_at">,
  outcome: ScanOutcome,
): HealthUpdate {
  if (outcome.kind === "ok" && outcome.count > 0) {
    return { last_scan_status: "ok", last_scan_error: null, consecutive_failures: 0, alert: false };
  }
  const failures = company.consecutive_failures + 1;
  const alert = failures >= ALERT_AFTER_FAILURES && !company.health_alerted_at;
  if (outcome.kind === "ok") {
    const before = company.last_job_count ? ` (it listed ${company.last_job_count} before)` : "";
    return {
      last_scan_status: "empty",
      last_scan_error: `No roles found on the page${before}`,
      consecutive_failures: failures,
      alert,
    };
  }
  return {
    last_scan_status: "error",
    last_scan_error: outcome.message.slice(0, 500),
    consecutive_failures: failures,
    alert,
  };
}
