import { describe, expect, it } from "vitest";
import { candidateLinks } from "@/scanner/discover/links";
import { configureLlm, resetLlm } from "@/lib/llm";
import { passesHardFilters, scoreJobs } from "@/scanner/match";
import { htmlToText } from "@/scanner/text";

describe("passesHardFilters", () => {
  const job = { title: "Senior Data Engineer", location: "Bengaluru, India", department: "Data" };

  it("passes when no filters are set", () => {
    expect(passesHardFilters(job, { locations: [], exclude_keywords: [] })).toBe(true);
  });
  it("drops excluded title keywords, case-insensitively", () => {
    expect(passesHardFilters(job, { locations: [], exclude_keywords: ["senior"] })).toBe(false);
    expect(passesHardFilters(job, { locations: [], exclude_keywords: ["intern", " "] })).toBe(true);
  });
  it("matches any wanted location", () => {
    expect(passesHardFilters(job, { locations: ["Chennai", "bengaluru"], exclude_keywords: [] })).toBe(true);
    expect(passesHardFilters(job, { locations: ["London"], exclude_keywords: [] })).toBe(false);
  });
  it("keeps postings that don't state a location", () => {
    expect(passesHardFilters({ ...job, location: null }, { locations: ["London"], exclude_keywords: [] })).toBe(true);
  });
});

describe("candidateLinks", () => {
  const page = "https://acme.test/careers";
  const link = (href: string, text = "Engineer") => ({ href, text, context: "" });

  it("keeps posting links and drops navigation, social, the page itself and duplicates", () => {
    const out = candidateLinks(
      [
        link("https://acme.test/careers/123?utm_source=li"),
        link("https://acme.test/careers/123"),
        link("https://acme.test/careers"),
        link("https://acme.test/privacy"),
        link("https://www.linkedin.com/company/acme"),
        link("mailto:jobs@acme.test"),
        link("https://acme.test/logo.png"),
        link("https://acme.test/careers/456", ""),
      ],
      page,
    );
    expect(out.map((l) => l.href)).toEqual(["https://acme.test/careers/123"]);
  });
});

describe("htmlToText", () => {
  it("strips markup and scripts, keeps list structure and decodes entities", () => {
    const html = "<style>p{}</style><p>Build &amp; ship</p><ul><li>Python</li><li>SQL&nbsp;&#8211; advanced</li></ul><script>x()</script>";
    expect(htmlToText(html)).toBe("Build & ship\n• Python\n• SQL – advanced");
  });
});

describe("scoreJobs", () => {
  const jobs = [
    { title: "Data Engineer", location: null, department: null, description: "Spark" },
    { title: "Account Executive", location: null, department: null, description: "Sales" },
  ];
  const criteria = { target_roles: [], departments: [], locations: [], exclude_keywords: [], resume_text: "resume", resume_profile: null };
  const result = (i: unknown, score: number) => ({ i, score, reason: " ok ", matched_skills: ["a", ""], gaps: [], posted_pay: "" });
  const reply = (results: unknown[]) => {
    resetLlm();
    configureLlm({ provider: "ollama", store: null, sendOllama: async () => JSON.stringify({ results }) });
  };

  it("maps results by index, clamps scores and tidies fields", async () => {
    reply([result(1, 140), result(0, 82.4)]);
    const { fits, model } = await scoreJobs(jobs, criteria);
    expect(fits.map((f) => f?.score)).toEqual([82, 100]);
    expect(fits[0]).toMatchObject({ reason: "ok", matched_skills: ["a"], posted_pay: null });
    expect(model).toBe("ollama:qwen2.5:7b");
  });

  it("falls back to reply order when a full-length reply has unusable indices", async () => {
    reply([result(undefined, 70), result(undefined, 20)]);
    expect((await scoreJobs(jobs, criteria)).fits.map((f) => f?.score)).toEqual([70, 20]);
    reply([result(1, 70), result(1, 20)]);
    expect((await scoreJobs(jobs, criteria)).fits.map((f) => f?.score)).toEqual([70, 20]);
  });

  it("leaves a role unscored rather than guessing when the reply is short and misnumbered", async () => {
    reply([result(7, 70)]);
    expect((await scoreJobs(jobs, criteria)).fits).toEqual([null, null]);
  });
});
