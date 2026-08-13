// extensions/models/dependabot_sweep_test.ts
//
// Two halves, because there are two ways this extension can be quietly wrong.
//
// `classify` holds every judgement, and a misclassification does not error — it
// just moves a repository between "review this" and "ignore this". So it is a
// pure function taking `now` as a parameter, exercised directly below.
//
// The API path below that decides whether `classify` is fed the truth at all:
// pagination, the truncation flag, and the error mapping. Those are mocked
// rather than live, so the suite needs no token and no network.
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedFetch,
} from "jsr:@swamp-club/swamp-testing@0.20260805.30";
import { classify, model } from "./dependabot_sweep.ts";

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

// ---------------------------------------------------------------------------
// API path
//
// `classify` above covers the judgement. These cover the parts that decide
// whether that judgement is fed the truth: pagination, the truncation flag, and
// the error mapping that separates "you are throttled" from "you are not
// allowed". All three are silent failure modes — a truncated sweep and a
// complete one look identical downstream.
// ---------------------------------------------------------------------------

type SweepContext = Parameters<typeof model.methods.sweep.execute>[1];

const GLOBAL_ARGS = {
  owner: "octo-org",
  ownerType: "user",
  token: "test-token-not-a-real-credential",
  apiBaseUrl: "https://api.github.com",
  staleAfterDays: 365,
  allowlist: [],
  denylist: [],
  timeoutMs: 30000,
};

function sweepContext(overrides: Record<string, unknown> = {}) {
  const ctx = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, ...overrides },
    methodName: "sweep",
  });
  return { ...ctx, context: ctx.context as unknown as SweepContext };
}

function searchItem(repo: string, number: number) {
  return {
    number,
    title: `Bump thing from 1.0.0 to 1.0.1`,
    html_url: `https://github.com/octo-org/${repo}/pull/${number}`,
    created_at: "2026-08-01T00:00:00Z",
    repository_url: `https://api.github.com/repos/octo-org/${repo}`,
  };
}

function repoPayload(
  overrides: Partial<{ fork: boolean; archived: boolean; pushed_at: string }> = {},
) {
  return {
    fork: false,
    archived: false,
    pushed_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Route mocked responses by URL so one handler serves search and repo lookups. */
function router(
  search: (page: number) => unknown,
  repo: (name: string) => unknown,
) {
  return (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/search/issues")) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return Promise.resolve(Response.json(search(page)));
    }
    const name = url.split("/").pop() ?? "";
    return Promise.resolve(Response.json(repo(name)));
  };
}

Deno.test("sweep splits live from abandoned and summarises both", async () => {
  const { context, getWrittenResources } = sweepContext();

  await withMockedFetch(
    router(
      () => ({
        total_count: 3,
        items: [searchItem("alive", 1), searchItem("alive", 2), searchItem("dead", 9)],
      }),
      (name) =>
        name === "dead"
          ? repoPayload({ fork: true })
          : repoPayload({ pushed_at: "2026-08-10T00:00:00Z" }),
    ),
    async () => {
      await model.methods.sweep.execute({}, context);
    },
  );

  const written = getWrittenResources();
  const summary = written.find((w) => w.specName === "sweep")!.data;
  assertEquals(summary.totalPrs, 3);
  assertEquals(summary.livePrs, 2);
  assertEquals(summary.abandonedPrs, 1);
  assertEquals(summary.liveRepos, 1);
  assertEquals(summary.abandonedRepos, 1);
  assertEquals(summary.truncated, false);

  // One resource per repository, plus the summary.
  assertEquals(written.filter((w) => w.specName === "repository").length, 2);
});

Deno.test("sweep reports truncation when GitHub withholds results", async () => {
  const { context, getWrittenResources } = sweepContext();

  // total_count claims far more than the single page hands back — exactly the
  // shape that makes an under-count look like good news.
  await withMockedFetch(
    router(
      () => ({ total_count: 5000, items: [searchItem("alive", 1)] }),
      () => repoPayload(),
    ),
    async () => {
      await model.methods.sweep.execute({}, context);
    },
  );

  const summary = getWrittenResources().find((w) => w.specName === "sweep")!.data;
  assertEquals(summary.truncated, true);
  assertEquals(summary.reportedTotal, 5000);
  assertEquals(summary.totalPrs, 1);
});

Deno.test("sweep follows pagination to the end of the result set", async () => {
  const { context, getWrittenResources } = sweepContext();
  const full = Array.from({ length: 100 }, (_, i) => searchItem("alive", i + 1));

  await withMockedFetch(
    router(
      (page) =>
        page === 1
          ? { total_count: 101, items: full }
          : { total_count: 101, items: [searchItem("alive", 101)] },
      () => repoPayload(),
    ),
    async () => {
      await model.methods.sweep.execute({}, context);
    },
  );

  const summary = getWrittenResources().find((w) => w.specName === "sweep")!.data;
  assertEquals(summary.totalPrs, 101);
  assertEquals(summary.truncated, false);
});

Deno.test("a repo whose metadata 500s is reported, not dropped", async () => {
  const { context, getWrittenResources } = sweepContext();

  await withMockedFetch(
    (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/search/issues")) {
        return Promise.resolve(
          Response.json({ total_count: 1, items: [searchItem("mystery", 1)] }),
        );
      }
      return Promise.resolve(new Response("upstream exploded", { status: 500 }));
    },
    async () => {
      await model.methods.sweep.execute({}, context);
    },
  );

  const repo = getWrittenResources().find((w) => w.specName === "repository")!.data;
  assertEquals(repo.status, "live");
  assertEquals(repo.reason, "unknown");
  assertEquals(repo.prCount, 1);
});

Deno.test("a 200 with a partial repo payload classifies unknown, not active", async () => {
  const { context, getWrittenResources } = sweepContext();

  await withMockedFetch(
    router(
      () => ({ total_count: 1, items: [searchItem("partial", 1)] }),
      // No fork/archived flags. Trusting this would assert the repo is alive on
      // the strength of fields that were never in the response.
      () => ({ name: "partial" }),
    ),
    async () => {
      await model.methods.sweep.execute({}, context);
    },
  );

  const repo = getWrittenResources().find((w) => w.specName === "repository")!.data;
  assertEquals(repo.reason, "unknown");
  assertEquals(repo.isFork, null);
});

Deno.test("an exhausted rate limit is not reported as an auth failure", async () => {
  const { context } = sweepContext();

  await withMockedFetch(
    () =>
      Promise.resolve(
        new Response("rate limited", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1786000000",
          },
        }),
      ),
    async () => {
      const error = await assertRejects(
        () => model.methods.sweep.execute({}, context),
      );
      assertStringIncludes((error as Error).message, "rate limit");
      assertStringIncludes((error as Error).message, "the token is fine");
    },
  );
});

Deno.test("a 403 with quota left is reported as a missing scope", async () => {
  const { context } = sweepContext();

  await withMockedFetch(
    () =>
      Promise.resolve(
        new Response("forbidden", {
          status: 403,
          headers: { "x-ratelimit-remaining": "4999" },
        }),
      ),
    async () => {
      const error = await assertRejects(
        () => model.methods.sweep.execute({}, context),
      );
      assertStringIncludes((error as Error).message, "scope");
    },
  );
});

Deno.test("a 401 names the credential rather than the endpoint", async () => {
  const { context } = sweepContext();

  await withMockedFetch(
    () => Promise.resolve(new Response("bad creds", { status: 401 })),
    async () => {
      const error = await assertRejects(
        () => model.methods.sweep.execute({}, context),
      );
      assertStringIncludes((error as Error).message, "token was rejected");
    },
  );
});

Deno.test("a 200 with the wrong shape names the endpoint that lied", async () => {
  const { context } = sweepContext();

  await withMockedFetch(
    () => Promise.resolve(Response.json({ unexpected: true })),
    async () => {
      const error = await assertRejects(
        () => model.methods.sweep.execute({}, context),
      );
      assertStringIncludes((error as Error).message, "unexpected shape");
    },
  );
});

Deno.test("org owners use the org: search qualifier", async () => {
  const { context } = sweepContext({ ownerType: "org" });
  let seen = "";

  await withMockedFetch(
    (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/search/issues")) {
        seen = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
        return Promise.resolve(Response.json({ total_count: 0, items: [] }));
      }
      return Promise.resolve(Response.json(repoPayload()));
    },
    async () => {
      await model.methods.sweep.execute({}, context);
    },
  );

  assertStringIncludes(seen, "org:octo-org");
});
