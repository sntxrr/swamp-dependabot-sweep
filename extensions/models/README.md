# `@sntxrr/dependabot-sweep`

Find every open Dependabot pull request across an owner's repositories, and
separate the ones worth reviewing from the ones that are only noise.

| Method  | Writes? | What it does                                                          |
| ------- | ------- | --------------------------------------------------------------------- |
| `sweep` | no      | Search the owner's open Dependabot PRs, classify each repo live or dead |

Read-only against GitHub — it issues GETs and nothing else. There is no method
here that can close, merge, or comment on a pull request, which is what makes it
safe to run unattended on a schedule.

## Why classification is the point

Listing open Dependabot PRs is one search call. The reason that is not enough is
that the raw list is dominated by repositories nobody maintains. On the account
this was built against, 100 open PRs resolved to:

- **75 on abandoned forks** — old upstream projects, last pushed 2022–2023
- **25 on live repositories** — the actual review queue

and the two largest offenders (25 PRs each) sorted to the top of every listing.
Triage that walks the list in order spends its whole budget on dead code. So the
sweep classifies first and reports the split.

## Classification

An ordered cascade — the first rung that matches decides it, and `reason`
records which one that was:

| Precedence | Signal                                | Status      | `reason`      |
| ---------- | ------------------------------------- | ----------- | ------------- |
| 1          | name in `allowlist`                   | `live`      | `allowlisted` |
| 2          | name in `denylist`                    | `abandoned` | `denylisted`  |
| 3          | metadata unavailable                  | `live`      | `unknown`     |
| 4          | repository archived                   | `abandoned` | `archived`    |
| 5          | repository is a fork                  | `abandoned` | `fork`        |
| 6          | no push in `staleAfterDays` (def 365) | `abandoned` | `stale`       |
| 7          | otherwise                             | `live`      | `active`      |

Two of these rungs are deliberate and worth stating outright:

- **`allowlist` outranks everything, including `denylist`.** Fork/archived/stale
  are guesses about intent, and a maintained fork is a real thing. An operator
  naming a repository is stating intent directly, so it wins.
- **Unreadable metadata fails open.** A transient 502 on the repo lookup reports
  the repository as `live`/`unknown` rather than dropping it. Surfacing an extra
  repository costs a glance; hiding one costs an unreviewed CVE bump.

## Configuration

```bash
swamp model create @sntxrr/dependabot-sweep dependabot
```

| Global argument  | Required | Default                  | Notes                                                     |
| ---------------- | -------- | ------------------------ | --------------------------------------------------------- |
| `owner`          | yes      | —                        | User or organization to sweep                             |
| `token`          | yes      | —                        | Supply via `vault.get()`. Sensitive.                      |
| `ownerType`      | no       | `user`                   | `user` or `org` — picks the search qualifier              |
| `apiBaseUrl`     | no       | `https://api.github.com` | Override for GitHub Enterprise Server                     |
| `staleAfterDays` | no       | `365`                    | Consulted only when not archived, forked, or listed       |
| `allowlist`      | no       | `[]`                     | Bare repo names (`my-service`), not `owner/repo`          |
| `denylist`       | no       | `[]`                     | For repos that look active but whose PRs you do not want  |
| `timeoutMs`      | no       | `30000`                  | Per-request abort                                         |

The token needs `public_repo` for public repositories, or `repo` to include
private ones. A token missing the scope returns 403 **with quota remaining** —
the model distinguishes that from a throttle so you are not sent to rotate a
credential that was never broken.

## Usage

```bash
swamp model @sntxrr/dependabot-sweep method run sweep dependabot

# the review queue
swamp data query 'specName == "repository" && content.status == "live"'

# what got filtered, and why
swamp data query 'specName == "repository" && content.status == "abandoned"'

# the summary, including whether the search was truncated
swamp data get dependabot current
```

A worked example of the output, sorted by PR count:

```
=== LIVE (review queue) ===
9   notify-service      [active]  push=2026-08-10
8   dns-manager         [active]  push=2026-05-24
4   deploy-tool         [active]  push=2026-06-14
...

=== ABANDONED (noise) ===
25  old-collab-app      [stale]   push=2023-01-24
25  marketing-site      [fork]    push=2023-03-03
8   upstream-project    [fork]    push=2022-10-20
...
```

## Resources

- **`sweep`** (one, `current`) — `totalPrs`, `livePrs`, `abandonedPrs`,
  `liveRepos`, `abandonedRepos`, `truncated`, `reportedTotal`
- **`repository`** (one per repo) — `status`, `reason`, `isFork`, `isArchived`,
  `pushedAt`, `daysSincePush`, `prCount`, and the `prs` themselves

### `truncated` is load-bearing

GitHub's search API returns at most 1000 results and will hand back a page-1
slice of a larger set without complaint. A sweep that silently truncated would
read exactly like a complete one — and an under-count looks like progress, which
is the worst direction for this to fail in. When `truncated` is true every count
is a floor, not a total, and the method logs a warning saying so.

## Development

```bash
~/.swamp/deno/deno check extensions/models/dependabot_sweep.ts
~/.swamp/deno/deno test extensions/models/dependabot_sweep_test.ts
```

`classify` is exported and tested directly. A misclassification does not error —
it quietly moves a repository between "review this" and "ignore this" — so it is
a pure function that takes `now` as a parameter rather than reading the clock.
