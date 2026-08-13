# swamp-dependabot-sweep

A [swamp](https://swamp-club.com) extension repo for triaging **Dependabot pull
requests across a whole GitHub account**, using only Deno's built-in APIs — no
dependencies, and no `gh` CLI.

## Extensions

### [`@sntxrr/dependabot-sweep`](./extensions/models/README.md)

Open Dependabot PRs, split into the ones worth reviewing and the ones that are
only noise.

| Method  | Writes? | What it does                                                          |
| ------- | ------- | --------------------------------------------------------------------- |
| `sweep` | no      | Search the owner's open Dependabot PRs, classify each repo live or dead |

Listing the PRs is one search call; the reason that is not enough is that the
raw list is dominated by repositories nobody maintains. Measured on the account
this was built against: 100 open PRs, of which 75 sat on abandoned forks and 25
were the actual review queue — with the two biggest dead repos sorting to the
top of every listing. The sweep classifies before it reports, so the queue you
get is the queue you should work.

Classification is an ordered cascade — allowlist, denylist, archived, fork,
stale, active — and the deciding rung is recorded on each result as `reason`, so
a surprising verdict can be explained without rerunning anything. See the
[model README](./extensions/models/README.md) for the full table.

## Why no `gh`

The intended home for this is a containerised `swamp serve`, which has `curl`
and `git` but no `gh`, no `node`, and no `jq`. Extensions run in swamp's bundled
Deno runtime, so a model that talks to the REST API with `fetch` runs there
unchanged, while anything shelling out to `gh` cannot. That constraint is the
reason this extension exists rather than a wrapper around the CLI.

## Development

```bash
~/.swamp/deno/deno check extensions/models/dependabot_sweep.ts
~/.swamp/deno/deno test extensions/models/dependabot_sweep_test.ts
```

## License

MIT — see [LICENSE.md](./extensions/models/LICENSE.md).
