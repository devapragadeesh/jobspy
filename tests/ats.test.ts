import { describe, expect, it } from "vitest";
import { detectAtsFromUrl, detectAtsInHtml, guessCompanyName, normalizeUrl, parseCareersUrl } from "@/lib/ats";

describe("detectAtsFromUrl", () => {
  it.each([
    ["https://job-boards.greenhouse.io/anthropic", { type: "greenhouse", config: { token: "anthropic" } }],
    ["https://boards.greenhouse.io/figma/jobs/123", { type: "greenhouse", config: { token: "figma" } }],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", { type: "greenhouse", config: { token: "acme" } }],
    ["https://jobs.lever.co/palantir", { type: "lever", config: { company: "palantir" } }],
    ["https://jobs.eu.lever.co/acme", { type: "lever", config: { company: "acme", eu: "1" } }],
    ["https://jobs.ashbyhq.com/openai", { type: "ashby", config: { board: "openai" } }],
    [
      "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite",
      { type: "workday", config: { host: "nvidia.wd5.myworkdayjobs.com", tenant: "nvidia", site: "NVIDIAExternalCareerSite" } },
    ],
    ["https://careers.smartrecruiters.com/BoschGroup", { type: "smartrecruiters", config: { company: "BoschGroup" } }],
  ])("%s", (url, expected) => {
    expect(detectAtsFromUrl(url)).toEqual(expected);
  });

  it("returns null for a company's own careers page", () => {
    expect(detectAtsFromUrl("https://stripe.com/jobs/search")).toBeNull();
  });
});

describe("detectAtsInHtml", () => {
  it("picks the most referenced board and ignores API paths", () => {
    const html = `
      <a href="https://jobs.lever.co/partner/1">partner role</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=figma"></script>
      <a href="https://boards.greenhouse.io/figma/jobs/1">a</a>
      <a href="https://boards.greenhouse.io/figma/jobs/2">b</a>
      <a href="https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/x">api</a>`;
    expect(detectAtsInHtml(html)).toEqual({ type: "greenhouse", config: { token: "figma" } });
  });

  it("returns null when nothing is embedded", () => {
    expect(detectAtsInHtml("<a href='/jobs/1'>Engineer</a>")).toBeNull();
  });
});

describe("guessCompanyName", () => {
  it.each([
    ["https://stripe.com/jobs/search", "Stripe"],
    ["https://careers.google.com/jobs", "Google"],
    ["https://www.zoho.com/careers/", "Zoho"],
    ["https://jobs.lever.co/scale-ai", "Scale Ai"],
    ["https://careers.tcs.co.in/x", "Tcs"],
  ])("%s → %s", (url, name) => {
    expect(guessCompanyName(url)).toBe(name);
  });
});

describe("normalizeUrl", () => {
  it("drops tracking params, fragments and trailing slashes so the same posting compares equal", () => {
    expect(normalizeUrl("https://Example.com/jobs/42/?utm_source=x&gh_src=abc&team=eng#apply")).toBe(
      "https://example.com/jobs/42/?team=eng",
    );
    expect(normalizeUrl("https://example.com/jobs/42/")).toBe("https://example.com/jobs/42");
  });
});

describe("parseCareersUrl", () => {
  it("accepts a pasted URL without a scheme", () => {
    expect(parseCareersUrl("  stripe.com/jobs ")).toBe("https://stripe.com/jobs");
  });
  it("rejects junk", () => {
    expect(parseCareersUrl("not a url")).toBeNull();
    expect(parseCareersUrl("")).toBeNull();
  });
});
