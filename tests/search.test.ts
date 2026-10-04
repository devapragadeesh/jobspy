import { describe, expect, it } from "vitest";
import { formatEvidence, pickSources, rankResults } from "@/scanner/search";

const snippet = "Stripe Q1 2026 revenue: $2 billion, an annualized pace of roughly $8 billion.";

describe("rankResults", () => {
  it("puts topical-engine results first and drops navigational pages, empty snippets and duplicates", () => {
    const ranked = rankResults(
      [
        { title: "Stripe Login", url: "https://dashboard.stripe.com/login", content: snippet, engines: ["bing"] },
        { title: "Stripe", url: "https://stripe.com/", content: snippet, engines: ["bing", "yahoo"] },
        { title: "Stripe statistics", url: "https://www.chargeflow.io/blog/stripe-statistics", content: snippet, engines: ["startpage"] },
        { title: "Stripe statistics (dup)", url: "https://chargeflow.io/blog/stripe-statistics/", content: snippet, engines: ["bing"] },
        { title: "No snippet", url: "https://example.com/a", content: "", engines: ["startpage"] },
        { title: "Bad url", url: "not a url", content: snippet, engines: ["startpage"] },
      ],
      10,
    );
    expect(ranked.map((r) => r.title)).toEqual(["Stripe statistics", "Stripe"]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, content: snippet }));
    expect(rankResults(many, 5)).toHaveLength(5);
  });
});

describe("evidence helpers", () => {
  const evidence = [
    { title: "A", url: "https://a.test", text: "alpha" },
    { title: "B", url: "https://b.test", text: "beta" },
    { title: "C", url: "https://c.test", text: "gamma" },
    { title: "D", url: "https://d.test", text: "delta" },
  ];

  it("numbers evidence so the model can cite it", () => {
    expect(formatEvidence(evidence.slice(0, 2))).toBe("[0] A (https://a.test)\nalpha\n\n[1] B (https://b.test)\nbeta");
  });

  it("maps cited numbers to sources and ignores invalid ones", () => {
    expect(pickSources(evidence, [3, 3, 99, -1, "x", 1])).toEqual([
      { title: "D", url: "https://d.test" },
      { title: "B", url: "https://b.test" },
    ]);
  });

  it("falls back to the leading evidence when the model cites nothing", () => {
    expect(pickSources(evidence, undefined).map((s) => s.title)).toEqual(["A", "B", "C"]);
  });
});
