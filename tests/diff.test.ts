import { describe, expect, it } from "vitest";
import { diffJobs, type StoredJobRef } from "@/scanner/diff";
import { nextHealth } from "@/scanner/health";

const stored = (key: string, over: Partial<StoredJobRef> = {}): StoredJobRef => ({
  id: `id-${key}`,
  external_key: key,
  missed_scans: 0,
  closed_at: null,
  ...over,
});
const found = (key: string) => ({ key, title: key, url: `https://x.test/${key}` });

describe("diffJobs", () => {
  it("separates new, still-listed and missing postings", () => {
    const diff = diffJobs([stored("a"), stored("b")], [found("b"), found("c")]);
    expect(diff.added.map((j) => j.key)).toEqual(["c"]);
    expect(diff.seen).toEqual(["id-b"]);
    expect(diff.missed).toEqual([{ id: "id-a", missed_scans: 1, close: false }]);
  });

  it("closes a posting only on its second consecutive miss", () => {
    const diff = diffJobs([stored("a", { missed_scans: 1 })], []);
    expect(diff.missed).toEqual([{ id: "id-a", missed_scans: 2, close: true }]);
  });

  it("reopens a closed posting that is listed again and never re-counts closed ones as missed", () => {
    const closed = stored("a", { closed_at: "2026-01-01T00:00:00Z", missed_scans: 2 });
    expect(diffJobs([closed], [found("a")]).reopened).toEqual(["id-a"]);
    expect(diffJobs([closed], []).missed).toEqual([]);
  });

  it("does not count anything as missing when the listing was truncated", () => {
    const diff = diffJobs([stored("a")], [found("b")], { trackMissing: false });
    expect(diff.missed).toEqual([]);
    expect(diff.added).toHaveLength(1);
  });
});

describe("nextHealth", () => {
  const healthy = { consecutive_failures: 0, last_job_count: 12, health_alerted_at: null };

  it("resets on a scan that finds roles", () => {
    expect(nextHealth({ ...healthy, consecutive_failures: 3 }, { kind: "ok", count: 5 })).toMatchObject({
      last_scan_status: "ok",
      consecutive_failures: 0,
      alert: false,
    });
  });

  it("treats an empty page as a failure and alerts on the second in a row", () => {
    const first = nextHealth(healthy, { kind: "ok", count: 0 });
    expect(first).toMatchObject({ last_scan_status: "empty", consecutive_failures: 1, alert: false });
    expect(first.last_scan_error).toContain("12");
    const second = nextHealth({ ...healthy, consecutive_failures: 1 }, { kind: "error", message: "timeout" });
    expect(second).toMatchObject({ last_scan_status: "error", consecutive_failures: 2, alert: true });
  });

  it("does not alert again once already reported", () => {
    const again = nextHealth(
      { ...healthy, consecutive_failures: 4, health_alerted_at: "2026-01-01T00:00:00Z" },
      { kind: "error", message: "timeout" },
    );
    expect(again.alert).toBe(false);
  });
});
