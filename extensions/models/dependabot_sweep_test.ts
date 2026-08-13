// extensions/models/dependabot_sweep_test.ts
//
// `classify` is where every judgement in this extension lives, and it is the
// part most likely to be wrong in a way nobody notices — a misclassification
// does not error, it just quietly moves a repository between "review this" and
// "ignore this". So it is a pure function taking `now` as a parameter, and it
// is tested directly rather than through the API path.
import { assertEquals } from "jsr:@std/assert@1";
import { classify } from "./dependabot_sweep.ts";

const NOW = new Date("2026-08-13T00:00:00Z");

const DEFAULTS = { allowlist: [], denylist: [], staleAfterDays: 365 };

function meta(
  overrides: Partial<{ fork: boolean; archived: boolean; pushed_at: string | null }> = {},
) {
  return { fork: false, archived: false, pushed_at: "2026-08-01T00:00:00Z", ...overrides };
}

Deno.test("an actively pushed non-fork is live", () => {
  const result = classify("my-service", meta(), DEFAULTS, NOW);
  assertEquals(result.status, "live");
  assertEquals(result.reason, "active");
  assertEquals(result.daysSincePush, 12);
});

Deno.test("a fork is abandoned even when recently pushed", () => {
  const result = classify("some-fork", meta({ fork: true }), DEFAULTS, NOW);
  assertEquals(result.status, "abandoned");
  assertEquals(result.reason, "fork");
});

Deno.test("an archived repo reports archived, not fork, when it is both", () => {
  const result = classify(
    "old-thing",
    meta({ fork: true, archived: true }),
    DEFAULTS,
    NOW,
  );
  assertEquals(result.status, "abandoned");
  // Precedence matters for the explanation, not just the verdict: archiving is
  // a deliberate act and is the more useful thing to report back.
  assertEquals(result.reason, "archived");
});

Deno.test("a non-fork untouched past the threshold is stale", () => {
  // The case that motivated a staleness rung at all: 25 open PRs, genuinely not
  // a fork, last pushed in 2023. Fork-and-archived checks alone would have
  // called it live and put it at the top of the review queue.
  const result = classify(
    "etherpad",
    meta({ pushed_at: "2023-01-24T00:00:00Z" }),
    DEFAULTS,
    NOW,
  );
  assertEquals(result.status, "abandoned");
  assertEquals(result.reason, "stale");
});

Deno.test("staleness is measured against staleAfterDays, not a constant", () => {
  const pushed = meta({ pushed_at: "2026-01-01T00:00:00Z" }); // 224 days before NOW
  assertEquals(classify("x", pushed, DEFAULTS, NOW).status, "live");
  assertEquals(
    classify("x", pushed, { ...DEFAULTS, staleAfterDays: 30 }, NOW).status,
    "abandoned",
  );
});

Deno.test("a repo pushed exactly at the threshold is not yet stale", () => {
  // Boundary is `>`, not `>=` — a repo touched exactly staleAfterDays ago is
  // still given the benefit of the doubt.
  const pushed = meta({ pushed_at: "2025-08-13T00:00:00Z" });
  const result = classify("edge", pushed, DEFAULTS, NOW);
  assertEquals(result.daysSincePush, 365);
  assertEquals(result.status, "live");
});

Deno.test("allowlist rescues a fork", () => {
  const result = classify(
    "maintained-fork",
    meta({ fork: true, pushed_at: "2020-01-01T00:00:00Z" }),
    { ...DEFAULTS, allowlist: ["maintained-fork"] },
    NOW,
  );
  assertEquals(result.status, "live");
  assertEquals(result.reason, "allowlisted");
});

Deno.test("allowlist outranks denylist", () => {
  const result = classify(
    "contested",
    meta(),
    { ...DEFAULTS, allowlist: ["contested"], denylist: ["contested"] },
    NOW,
  );
  assertEquals(result.status, "live");
  assertEquals(result.reason, "allowlisted");
});

Deno.test("denylist buries an otherwise active repo", () => {
  const result = classify(
    "noisy",
    meta(),
    { ...DEFAULTS, denylist: ["noisy"] },
    NOW,
  );
  assertEquals(result.status, "abandoned");
  assertEquals(result.reason, "denylisted");
});

Deno.test("unreadable metadata fails open, not closed", () => {
  // A transient 502 on the repo lookup must not hide real PRs. Surfacing an
  // extra repository costs a glance; hiding one costs an unreviewed CVE bump.
  const result = classify("mystery", null, DEFAULTS, NOW);
  assertEquals(result.status, "live");
  assertEquals(result.reason, "unknown");
  assertEquals(result.daysSincePush, null);
});

Deno.test("a listed repo is decided before metadata is even consulted", () => {
  assertEquals(classify("known", null, { ...DEFAULTS, denylist: ["known"] }, NOW).reason, "denylisted");
  assertEquals(classify("known", null, { ...DEFAULTS, allowlist: ["known"] }, NOW).reason, "allowlisted");
});

Deno.test("a repo with no push timestamp is judged on fork/archived alone", () => {
  const result = classify("empty", meta({ pushed_at: null }), DEFAULTS, NOW);
  assertEquals(result.status, "live");
  assertEquals(result.reason, "active");
  assertEquals(result.daysSincePush, null);
});
