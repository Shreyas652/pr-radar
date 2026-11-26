# pr-radar

**See where work is already happening in a GitHub repo before you write another PR.**

Busy open-source repos lose a lot of time to avoidable collisions:

- a contributor polishes a fix for a repo whose guide says it does not take outside PRs
- two contributors fix the same issue in parallel, and one PR gets thrown away
- a fix is merged with "Refs #123", but the issue stays open for weeks
- a dozen open PRs edit the same file, so every merge breaks the others
- reviewers have to work out by hand whether a PR has tests, a linked issue, or a changeset

`pr-radar` reads a repository's open issues, open PRs and recently merged PRs, then reports all of that in one Markdown or JSON summary. It is useful on both sides:

- **Contributors:** check whether a repo takes PRs from you at all, find unclaimed issues, and check your local branch for competing PRs and file conflicts *before* you open a PR.
- **Maintainers:** spot duplicate PRs, issues that can probably be closed, and conflict hotspots across the open queue.

## Quick start

Requires Node.js 20+ and a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, or a logged-in [`gh`](https://cli.github.com/) CLI).

```sh
git clone <this repo> && cd pr-radar
npm install && npm run build

# Does this repo take PRs from me? (one API call)
node dist/src/cli.js policy openai/openai-agents-js

# Whole-repo report
node dist/src/cli.js scan openai/openai-agents-js

# Check one open PR
node dist/src/cli.js check openai/openai-agents-js --pr 2736

# Check your local branch before opening a PR (run inside your checkout)
node dist/src/cli.js check --branch --base origin/main
```

When `owner/repo` is left out, it is read from the `origin` remote (change it with `--remote upstream`).

## Contribution policy check

Some projects, including large company-run ones, only accept PRs from collaborators, and say so in their contributing guide. Others want an issue or a "vouch" before any PR. `pr-radar policy` reads the guide GitHub would show (`.github/`, the repo root, `docs/`, then the owner's `.github` repository) and compares it with your access level:

```md
# pr-radar policy: openai/openai-agents-js

**⛔ Outside PRs not accepted.** The guide says it does not take PRs from non-collaborators, and @you is not one. Contribute through issues instead.

Guide: `CONTRIBUTING.md` · Your access: READ (@you)

> Pull requests are limited to repository collaborators.
```

| Verdict | When |
| --- | --- |
| ⛔ blocked | The guide limits PRs to collaborators or says it is not accepting them, and you lack write access. Archived repos are blocked too. |
| ⚠️ caution | PRs need a first step: an issue, a discussion or a vouch. Unsolicited PRs may be closed. |
| ✅ ok | The guide has none of the above, or you are a collaborator. |
| ❔ unknown | No contributing guide was found. |

The verdict quotes the sentences it is based on, so you can check it yourself. It also notes when a CLA or DCO sign-off is required. The same check appears at the top of `scan` and as the first item of `check --branch`. Rules about stale or draft PRs are ignored, since they don't say who may contribute.

Results on a sample of real repos (November 2026):

| Repo | Verdict | Based on |
| --- | --- | --- |
| `openai/openai-agents-js` | ⛔ blocked | "Pull requests are limited to repository collaborators." |
| `tldraw/tldraw` | ⛔ blocked | "We are not accepting contributions to tldraw at this time." |
| `ghostty-org/ghostty` | ⚠️ caution | Vouch system: "Once approved, you can submit PRs" |
| `sindresorhus/got` | ✅ ok | Owner-wide guide in `sindresorhus/.github` |
| `facebook/react`, `vitejs/vite`, `microsoft/vscode`, `golang/go`, `rust-lang/rust` | ✅ ok | No restriction found |

## What the scan reports

| Section | Meaning |
| --- | --- |
| **Contribution policy** | Whether the repo takes PRs from you (see above). |
| **Contested issues** | Two or more open PRs link the same issue. |
| **Possibly resolved** | An open issue is linked from a merged PR, so it may be safe to close. |
| **Unclaimed issues** | No open or recently merged PR references the issue. |
| **Claimed issues** | One open PR already references the issue. |
| **Conflict hotspots** | Files touched by at least 3 open PRs (`--min-hotspot`). |
| **Open PR checklist** | Linked issue, tests, changeset (when the repo uses them), description, reviewable size, no competing PR. |

Example from a real run on `openai/openai-agents-js` (trimmed):

```md
## Conflict hotspots (6)

| File | Open PRs |
| --- | --- |
| `packages/agents-core/src/runner/sessionPersistence.ts` | #2289, #2295, #2714, #2715, #2716, #2720, … (16 PRs) |
| `packages/agents-core/src/run.ts` | #2289, #2295, #2719, #2723, #2730, #2732, #2733 |
```

### Branch check

`check --branch` diffs your branch against `--base`, reads `Fixes #N` / `Refs #N` from your commit messages, and tells you whether the repo takes your PR at all, and whether someone else already has an open PR for the same issue or is editing the same files:

```md
### pr-radar: local branch: feat/aisdk-span-tools

**Score:** 86% (6/7 checks) · openai/openai-agents-js

- ⛔ **Repo takes your PR**: The guide says it does not take PRs from non-collaborators, and @you is not one. Contribute through issues instead. CONTRIBUTING.md: "Pull requests are limited to repository collaborators."
- ✅ **Linked issue**: #2185
- ✅ **Tests**: 1 test file changed
- ✅ **Changeset**: included
- ✅ **Description**: 476 characters after removing template comments
- ✅ **Reviewable size**: 192 lines changed
- ✅ **No competing PR**: no other open PR targets the same issue
```

Use `--fail-under 80` to make `check` exit with code 1 below a score, for CI.

## How issue links are detected

A PR is linked to an issue when:

1. GitHub lists the issue as closed by the PR (`closingIssuesReferences`), or
2. the PR title or body references it (`#12`, `owner/repo#12`, or an issue URL) in the same clause as a linking word: *fixes, closes, resolves, refs, references, addresses, implements, part of, towards*.

Other references count as **mentions**. They mark an issue as claimed but never as contested. References inside HTML comments (PR templates), code blocks and inline code are ignored, as are references to other repositories.

## Options

```text
--json                  Print JSON instead of Markdown
--out <file>            Write the report to a file
--limit <n>             Rows per Markdown section (default 25)
--from-snapshot <file>  Analyse a saved snapshot instead of calling GitHub
--save-snapshot <file>  Save the fetched snapshot for later runs
--max-issues <n>        Open issues to fetch (default 500)
--max-prs <n>           Open PRs to fetch (default 200)
--max-merged <n>        Recently merged PRs to fetch (default 150)
--min-hotspot <n>       Open PRs on one file to call it a hotspot (default 3)
--fail-under <score>    check: exit 1 below this score
--remote <name>         Git remote used to infer owner/repo (default origin)
--cwd <dir>             Git working directory for --branch
```

## Limitations

- Only the first 100 changed files of each PR are compared (the report says when this happens).
- "Unclaimed" only looks at the merged PRs fetched (`--max-merged`). An older fix outside that window is not seen.
- The checklist is a set of review signals, not a quality verdict. Many good maintainer PRs have no linked issue.
- The policy check is a wording heuristic. It reads the contributing guide only, not the README or PR templates, and it quotes its evidence so you can judge for yourself.

## Roadmap

- GitHub Action that posts the PR check as a single sticky comment (the Markdown already starts with a `<!-- pr-radar -->` marker for this)
- Repo config file (ignored paths, bot authors, custom checks)
- Stale claims: issues whose only PR has been inactive for weeks
- Smarter duplicate detection for PRs that fix the same thing without linking an issue

## Development

```sh
npm install
npm test        # builds with tsc, then runs node:test
```

## License

MIT
