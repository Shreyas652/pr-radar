# Changelog

## 0.3.0 (2026-11-26)

The first tagged release.

### GitHub Action

- Posts one pr-radar comment on each pull request and edits it in place on every push. The comment lists competing PRs for the same issue, other open PRs that edit the same files, and the review checklist.
- Never notifies anyone. Author names have no `@`, and mentions in PR titles are neutralised.
- Writes the report to the job summary and sets `score`, `competing` and `overlaps` outputs. `fail-under` can gate merges.
- Fork PRs on `pull_request` get a read-only token, so the action warns and keeps the job summary instead of failing. The README shows the `pull_request_target` setup.
- Works on GitHub Enterprise Server through `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL`.

### Contribution policy check

- `pr-radar policy owner/repo` reads the repo's contributing guide and your access level, and reports whether the repo takes PRs from you: blocked, caution (issue, discussion or vouch first), ok or unknown. It quotes the sentences behind the verdict and notes CLA or DCO requirements.
- Also shown at the top of `scan` and as the first item of `check --branch`.

### Reviewable size

- The size check counts only lines a reviewer reads. `dist/`, minified files, source maps, Jest snapshots and common lockfiles are left out by default, and a repo's `linguist-generated` lines in `.gitattributes` add to or override that list.

### CLI

- `scan` reports contested, possibly resolved, unclaimed and claimed issues, conflict hotspots and an open PR checklist.
- `check --pr N` and `check --branch` check one change for competing PRs, file overlaps and review signals.
- Markdown or JSON output, saved snapshots, and `--fail-under` for CI.

### Fixes

- Competing PRs are found from the issues open PRs link, so issues outside the `--max-issues` window and closed issues are no longer missed.
