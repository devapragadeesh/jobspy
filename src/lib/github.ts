export function scanTriggerConfigured(): boolean {
  return Boolean(process.env.GITHUB_DISPATCH_TOKEN && process.env.GITHUB_REPO);
}

/** Starts the scan workflow on GitHub Actions. With a company id, only that company is scanned. */
export async function triggerScan(companyId?: string): Promise<void> {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) throw new Error("Scan trigger is not configured (GITHUB_DISPATCH_TOKEN, GITHUB_REPO)");
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scan.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main", inputs: { company_id: companyId ?? "", force: "true" } }),
  });
  if (!res.ok) throw new Error(`GitHub refused to start the scan (${res.status})`);
}
