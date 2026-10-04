import type { DiscoveredJob } from "@/lib/types";

export interface StoredJobRef {
  id: string;
  external_key: string;
  missed_scans: number;
  closed_at: string | null;
}

export interface JobDiff {
  /** Postings never seen before for this company. */
  added: DiscoveredJob[];
  /** Stored postings that are still listed. */
  seen: string[];
  /** Stored postings that were closed and are listed again. */
  reopened: string[];
  /** Open stored postings that are no longer listed. */
  missed: { id: string; missed_scans: number; close: boolean }[];
}

/**
 * Compares a fresh listing against what is stored for a company.
 * A posting is only closed after `closeAfter` consecutive successful scans without it,
 * so one flaky page load doesn't close everything. When the listing was truncated
 * (`trackMissing` false) absence proves nothing and no posting is counted as missed.
 */
export function diffJobs(
  stored: StoredJobRef[],
  discovered: DiscoveredJob[],
  { closeAfter = 2, trackMissing = true }: { closeAfter?: number; trackMissing?: boolean } = {},
): JobDiff {
  const storedByKey = new Map(stored.map((s) => [s.external_key, s]));
  const discoveredKeys = new Set(discovered.map((d) => d.key));

  const diff: JobDiff = { added: [], seen: [], reopened: [], missed: [] };
  for (const job of discovered) {
    const prior = storedByKey.get(job.key);
    if (!prior) diff.added.push(job);
    else {
      diff.seen.push(prior.id);
      if (prior.closed_at) diff.reopened.push(prior.id);
    }
  }
  if (trackMissing) {
    for (const s of stored) {
      if (s.closed_at || discoveredKeys.has(s.external_key)) continue;
      const missed = s.missed_scans + 1;
      diff.missed.push({ id: s.id, missed_scans: missed, close: missed >= closeAfter });
    }
  }
  return diff;
}
