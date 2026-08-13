/**
 * Dependabot sweep — find every open Dependabot pull request across an owner's
 * repositories, and separate the ones worth reviewing from the ones that are
 * only noise.
 *
 * The problem this solves is not "list PRs" — the GitHub search API already
 * does that in one call. It is that the raw list is dominated by repositories
 * nobody maintains. On the account this was built against, 100 open Dependabot
 * PRs resolved to 75 on abandoned forks and 25 on live repositories, and the
 * two biggest offenders (25 PRs each, both untouched since 2023) sat at the top
 * of every listing. Any triage that walks the list in order spends its entire
 * budget on dead code. Classifying *before* reporting is the whole point.
 *
 * Three design decisions worth reading before use:
 *
 * 1. **Two API surfaces, deliberately.** The PR list comes from
 *    `/search/issues`, but a search result says nothing about whether its
 *    repository is alive — no fork flag, no archived flag, no push timestamp.
 *    Those require a `/repos/{owner}/{repo}` call each. The extra calls are
 *    what make the output actionable, and they are bounded by distinct
 *    repositories rather than by PR count, so they stay cheap.
 *
 * 2. **Truncation is reported, never hidden.** GitHub's search API returns at
 *    most 1000 results and will happily hand back a page-1 slice of a much
 *    larger set. A sweep that silently truncates reads exactly like a sweep
 *    that found everything, which is the failure mode most likely to matter
 *    here — an under-count looks like progress. `truncated` is on the summary
 *    resource, and the method logs a warning.
 *
 * 3. **`allowlist` outranks every automatic signal.** The heuristics (fork,
 *    archived, stale) are guesses about intent, and a maintained fork is a real
 *    thing. An operator naming a repository explicitly is stating intent
 *    directly, so it wins — including over `denylist`.
 *
 * Read-only against GitHub: it issues GETs and nothing else. There is no method
 * here that can close, merge, or comment on a pull request, which is what makes
 * it safe to run unattended on a schedule.
 *
 * @module
 */
// extensions/models/dependabot_sweep.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  owner: z.string().min(1).describe(
    "GitHub user or organization whose repositories to sweep, e.g. octo-org",
  ),
  // GitHub's search qualifiers differ for the two account kinds. `user:` does
  // match organizations in practice, but `org:` is the documented qualifier and
  // is unambiguous, so the distinction is exposed rather than guessed.
  ownerType: z.enum(["user", "org"]).default("user").describe(
    "Whether `owner` is a user account or an organization. Selects the `user:`/`org:` search qualifier.",
  ),
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "GitHub token with read access to the repositories being swept. Supply via vault.get() — never inline. Needs `public_repo` for public repositories, or `repo` to include private ones.",
  ),
  apiBaseUrl: z.string().url().default("https://api.github.com").describe(
    "GitHub API base URL. Override for GitHub Enterprise Server.",
  ),
  staleAfterDays: z.number().int().positive().default(365).describe(
    "A repository with no push in this many days counts as abandoned. Only consulted when the repository is not already archived, forked, or listed.",
  ),
  allowlist: z.array(z.string()).default([]).describe(
    "Repository names always treated as live, whatever the heuristics say. Outranks denylist. Bare names (`my-service`), not `owner/repo`.",
  ),
  denylist: z.array(z.string()).default([]).describe(
    "Repository names always treated as abandoned. Use for repositories that look active but whose dependency PRs you do not want to see.",
  ),
  timeoutMs: z.number().int().positive().default(30000).describe(
    "Abort any single GitHub API request after this long.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Why a repository was classified the way it was, in the precedence order
 * `classify` evaluates them.
 *
 * Declared as a const tuple rather than inline in the schema so the runtime
 * validator and the exported TypeScript type are derived from one list — a
 * reason that existed in only one of them would be a silent gap.
 */
export const CLASSIFICATION_REASONS = [
  "allowlisted",
  "denylisted",
  "archived",
  "fork",
  "stale",
  "active",
  "unknown",
] as const;

/** The decisive signal behind a repository's status. */
export type ClassificationReason = typeof CLASSIFICATION_REASONS[number];

/** Whether a repository's Dependabot PRs are worth reviewing. */
export type RepositoryStatus = "live" | "abandoned";

const ReasonSchema = z.enum(CLASSIFICATION_REASONS);

const PullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
});

const RepositorySchema = z.object({
  repo: z.string().describe("Bare repository name, without the owner prefix"),
  fullName: z.string().describe("owner/repo"),
  status: z.enum(["live", "abandoned"]).describe(
    "Whether this repository's Dependabot PRs are worth reviewing",
  ),
  reason: ReasonSchema.describe(
    "The single decisive signal behind `status`, in precedence order",
  ),
  isFork: z.boolean().nullable(),
  isArchived: z.boolean().nullable(),
  pushedAt: z.string().nullable(),
  daysSincePush: z.number().int().nullable(),
  prCount: z.number().int(),
  prs: z.array(PullRequestSchema),
});

const SweepSchema = z.object({
  owner: z.string(),
  totalPrs: z.number().int().describe("Open Dependabot PRs found across all repositories"),
  livePrs: z.number().int().describe("PRs on repositories classified live — the review queue"),
  abandonedPrs: z.number().int().describe("PRs on archived, forked, stale, or denylisted repositories"),
  liveRepos: z.number().int(),
  abandonedRepos: z.number().int(),
  // A sweep that quietly returned a slice would read identically to a complete
  // one. Surfacing this is the difference between "you have 25 to review" and
  // "you have at least 25 to review".
  truncated: z.boolean().describe(
    "True when GitHub's 1000-result search ceiling cut the result set short, making every count a floor rather than a total",
  ),
  reportedTotal: z.number().int().describe(
    "GitHub's own `total_count` for the search, which may exceed what the API will actually return",
  ),
  sweptAt: z.string(),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

/** GitHub's search ceiling. Ten pages of 100 and it stops, whatever total_count says. */
const SEARCH_RESULT_CEILING = 1000;
const PER_PAGE = 100;

type SearchItem = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  repository_url: string;
};

/**
 * The subset of GitHub's repository payload that classification depends on.
 *
 * Field names are GitHub's, snake_case and all, because this is the wire shape
 * rather than something this extension defines — renaming it here would hide
 * where it came from.
 */
export type RepositoryMetadata = {
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
};

/** The operator-supplied half of a classification decision. */
export type ClassificationPolicy = {
  /** Repository names always treated as live. Outranks every other signal. */
  allowlist: string[];
  /** Repository names always treated as abandoned. */
  denylist: string[];
  /** Days without a push after which a repository counts as abandoned. */
  staleAfterDays: number;
};

/** The verdict for one repository, and the evidence for it. */
export type Classification = {
  status: RepositoryStatus;
  reason: ClassificationReason;
  /** Null when the repository has never been pushed to, or metadata was unavailable. */
  daysSincePush: number | null;
};

/**
 * Issue a GitHub API GET and parse it, turning the failure modes that actually
 * happen into messages that say what to do about them.
 *
 * Rate limiting is called out separately because its symptom — a 403 with a
 * perfectly valid token — otherwise reads as an authorization problem and sends
 * you to rotate a credential that was never broken.
 */
async function githubGet<T>(
  url: string,
  globalArgs: GlobalArgs,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${globalArgs.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "swamp-dependabot-sweep",
      },
      signal: AbortSignal.timeout(globalArgs.timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? `timed out after ${globalArgs.timeoutMs}ms`
      : String(cause);
    throw new Error(`GitHub GET ${url} failed: ${reason}`);
  }

  if (res.status === 401) {
    throw new Error(
      `GitHub GET ${url} returned 401 — the token was rejected. Check that the ` +
        `vault entry holds a current token and that it has not been revoked.`,
    );
  }

  // The remaining-count header is what separates "you are throttled" from "you
  // are not allowed". Search is 30/min authenticated; the repo lookups draw on
  // the 5000/hr core pool.
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || res.status === 429) {
      const resetAt = res.headers.get("x-ratelimit-reset");
      const when = resetAt
        ? new Date(Number(resetAt) * 1000).toISOString()
        : "unknown";
      throw new Error(
        `GitHub rate limit exhausted on ${url}; resets at ${when}. This is a ` +
          `throttle, not an auth failure — the token is fine.`,
      );
    }
    throw new Error(
      `GitHub GET ${url} returned 403 with quota remaining — the token lacks ` +
        `scope for this resource. Private repositories need \`repo\`, not \`public_repo\`.`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub GET ${url} failed: ${res.status} ${body.slice(0, 400)}`,
    );
  }

  return await res.json() as T;
}

/**
 * Page through the Dependabot PR search until GitHub runs out of results or
 * refuses to hand back more.
 *
 * Returns the reported total alongside the items so the caller can tell the
 * difference between "that is all of them" and "that is all you may have".
 */
async function searchDependabotPrs(
  globalArgs: GlobalArgs,
): Promise<{ items: SearchItem[]; reportedTotal: number; truncated: boolean }> {
  const qualifier = globalArgs.ownerType === "org" ? "org" : "user";
  const query =
    `is:pr is:open author:app/dependabot ${qualifier}:${globalArgs.owner}`;
  const base = globalArgs.apiBaseUrl.replace(/\/+$/, "");

  const items: SearchItem[] = [];
  let reportedTotal = 0;
  let page = 1;

  while (true) {
    const url = `${base}/search/issues?q=${encodeURIComponent(query)}` +
      `&per_page=${PER_PAGE}&page=${page}`;
    const body = await githubGet<{ total_count: number; items: SearchItem[] }>(
      url,
      globalArgs,
    );

    reportedTotal = body.total_count;
    items.push(...body.items);

    if (body.items.length < PER_PAGE) break;
    if (items.length >= SEARCH_RESULT_CEILING) break;
    page += 1;
  }

  return {
    items,
    reportedTotal,
    truncated: reportedTotal > items.length,
  };
}

/** `https://api.github.com/repos/octo-org/thing` → `thing`. */
function repoNameFromUrl(repositoryUrl: string): string {
  const parts = repositoryUrl.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Decide whether a repository's dependency PRs deserve attention.
 *
 * Precedence is the substance of this function, so it is written as an ordered
 * cascade rather than a boolean expression: an operator's explicit statement
 * beats a heuristic, and among heuristics the cheap certain ones (archived,
 * fork) come before the judgement call (stale). `reason` records which rung it
 * stopped on, so a surprising classification can be explained without rerunning
 * anything.
 *
 * A repository whose metadata could not be fetched is reported `live`/`unknown`
 * on purpose. Failing open surfaces it for a human; failing closed would hide
 * real PRs behind a transient API error.
 */
export function classify(
  repo: string,
  meta: RepositoryMetadata | null,
  policy: ClassificationPolicy,
  now: Date,
): Classification {
  const daysSincePush = meta?.pushed_at
    ? Math.floor(
      (now.getTime() - new Date(meta.pushed_at).getTime()) / 86_400_000,
    )
    : null;

  if (policy.allowlist.includes(repo)) {
    return { status: "live", reason: "allowlisted", daysSincePush };
  }
  if (policy.denylist.includes(repo)) {
    return { status: "abandoned", reason: "denylisted", daysSincePush };
  }
  if (meta === null) {
    return { status: "live", reason: "unknown", daysSincePush };
  }
  if (meta.archived) {
    return { status: "abandoned", reason: "archived", daysSincePush };
  }
  if (meta.fork) {
    return { status: "abandoned", reason: "fork", daysSincePush };
  }
  if (daysSincePush !== null && daysSincePush > policy.staleAfterDays) {
    return { status: "abandoned", reason: "stale", daysSincePush };
  }
  return { status: "live", reason: "active", daysSincePush };
}

/**
 * Model type `@sntxrr/dependabot-sweep`.
 *
 * @example
 * ```bash
 * swamp model create @sntxrr/dependabot-sweep dependabot
 * swamp model @sntxrr/dependabot-sweep method run sweep dependabot
 * swamp data query dependabot 'resource.status == "live"'
 * ```
 */
export const model = {
  type: "@sntxrr/dependabot-sweep",
  description:
    "Sweep an owner's repositories for open Dependabot pull requests and split the review queue from the abandoned-repo noise",
  version: "2026.08.13.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "sweep": {
      description:
        "Summary of one sweep: how many Dependabot PRs are open, how many are worth reviewing, and whether the search was truncated",
      schema: SweepSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    "repository": {
      description:
        "One repository carrying open Dependabot PRs, with its live/abandoned classification and the PRs themselves",
      schema: RepositorySchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  methods: {
    sweep: {
      description:
        "Find every open Dependabot PR for the owner and classify each repository as live or abandoned",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          logger: Logger;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const { globalArgs, logger } = context;
        const now = new Date();
        const base = globalArgs.apiBaseUrl.replace(/\/+$/, "");

        const { items, reportedTotal, truncated } = await searchDependabotPrs(
          globalArgs,
        );

        if (truncated) {
          logger.warn(
            "GitHub reported {reported} matching PRs but returned only {returned}; every count below is a floor, not a total",
            { reported: reportedTotal, returned: items.length },
          );
        }

        // Group first so the metadata lookups are bounded by repository count
        // rather than PR count — 100 PRs across 15 repositories is 15 calls.
        const byRepo = new Map<string, SearchItem[]>();
        for (const item of items) {
          const repo = repoNameFromUrl(item.repository_url);
          const bucket = byRepo.get(repo);
          if (bucket) bucket.push(item);
          else byRepo.set(repo, [item]);
        }

        logger.info(
          "Found {prs} open Dependabot PRs across {repos} repositories for {owner}",
          { prs: items.length, repos: byRepo.size, owner: globalArgs.owner },
        );

        const handles = [];
        let livePrs = 0;
        let abandonedPrs = 0;
        let liveRepos = 0;
        let abandonedRepos = 0;

        for (const [repo, prs] of [...byRepo].sort((a, b) => a[0].localeCompare(b[0]))) {
          const fullName = `${globalArgs.owner}/${repo}`;

          // One repository's metadata being unavailable must not abort the
          // sweep — the other twenty are still worth reporting.
          let meta: RepositoryMetadata | null = null;
          try {
            meta = await githubGet<RepositoryMetadata>(
              `${base}/repos/${fullName}`,
              globalArgs,
            );
          } catch (cause) {
            logger.warn(
              "Could not read metadata for {repo}; reporting it as live/unknown so it is not silently dropped: {error}",
              { repo: fullName, error: String(cause) },
            );
          }

          const { status, reason, daysSincePush } = classify(
            repo,
            meta,
            globalArgs,
            now,
          );

          if (status === "live") {
            liveRepos += 1;
            livePrs += prs.length;
          } else {
            abandonedRepos += 1;
            abandonedPrs += prs.length;
          }

          handles.push(
            await context.writeResource("repository", repo, {
              repo,
              fullName,
              status,
              reason,
              isFork: meta?.fork ?? null,
              isArchived: meta?.archived ?? null,
              pushedAt: meta?.pushed_at ?? null,
              daysSincePush,
              prCount: prs.length,
              prs: prs
                .sort((a, b) => a.number - b.number)
                .map((pr) => ({
                  number: pr.number,
                  title: pr.title,
                  url: pr.html_url,
                  createdAt: pr.created_at,
                })),
            }),
          );
        }

        logger.info(
          "{livePrs} PRs across {liveRepos} live repositories need review; {abandonedPrs} across {abandonedRepos} are noise",
          { livePrs, liveRepos, abandonedPrs, abandonedRepos },
        );

        handles.push(
          await context.writeResource("sweep", "current", {
            owner: globalArgs.owner,
            totalPrs: items.length,
            livePrs,
            abandonedPrs,
            liveRepos,
            abandonedRepos,
            truncated,
            reportedTotal,
            sweptAt: now.toISOString(),
          }),
        );

        return { dataHandles: handles };
      },
    },
  },
};
