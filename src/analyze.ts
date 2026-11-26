import { extractIssueRefs, stripNoise } from './refs.js';
import type { Issue, PullRequest, RepoSnapshot } from './types.js';

export type RefStrength = 'linked' | 'mentioned';

export interface PullRef {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  strength: RefStrength;
}

export interface IssueClaim {
  issue: Issue;
  openPulls: PullRef[];
  mergedPulls: PullRef[];
}

export interface Hotspot {
  path: string;
  pulls: number[];
}

export interface ChecklistItem {
  id: 'linked-issue' | 'tests' | 'changeset' | 'description' | 'size' | 'no-competition';
  label: string;
  ok: boolean;
  detail: string;
}

export interface Overlap {
  number: number;
  title: string;
  author: string;
  shared: string[];
}

export interface Competition {
  issue: number;
  pulls: number[];
}

export interface PullCheck {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  linkedIssues: number[];
  competing: Competition[];
  overlaps: Overlap[];
  checklist: ChecklistItem[];
  score: number;
  filesTruncated: boolean;
}

export interface RepoReport {
  repo: string;
  fetchedAt: string;
  totals: { openIssues: number; openPulls: number; mergedPullsScanned: number };
  contested: IssueClaim[];
  possiblyResolved: IssueClaim[];
  unclaimed: Issue[];
  claimed: IssueClaim[];
  hotspots: Hotspot[];
  pullChecks: PullCheck[];
}

export interface AnalyzeOptions {
  /** A file counts as a hotspot when at least this many open PRs touch it. */
  minHotspotPulls: number;
  /** Paths ignored for overlaps and hotspots (prefix match). */
  ignorePaths: string[];
  /** PRs above this many changed lines fail the size check. */
  maxReviewableLines: number;
  /** Whether the repository uses changesets. `auto` detects it from open PRs. */
  changesets: boolean | 'auto';
}

export const DEFAULT_OPTIONS: AnalyzeOptions = {
  minHotspotPulls: 3,
  ignorePaths: ['.changeset/'],
  maxReviewableLines: 600,
  changesets: 'auto',
};

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

export function pullIssueRefs(pull: PullRequest, owner: string, name: string): { linked: Set<number>; mentioned: Set<number> } {
  const refs = extractIssueRefs(`${pull.title}\n${pull.body}`, owner, name);
  const linked = new Set([...pull.closingIssues, ...refs.linked]);
  const mentioned = new Set(refs.mentioned.filter((n) => !linked.has(n)));
  linked.delete(pull.number);
  mentioned.delete(pull.number);
  return { linked, mentioned };
}

function toRef(pull: PullRequest, strength: RefStrength): PullRef {
  return { number: pull.number, title: pull.title, url: pull.url, author: pull.author, isDraft: pull.isDraft, strength };
}

/** Maps each open issue number to the open and merged PRs that point at it. */
export function indexClaims(snapshot: RepoSnapshot): Map<number, IssueClaim> {
  const claims = new Map<number, IssueClaim>();
  for (const issue of snapshot.issues) claims.set(issue.number, { issue, openPulls: [], mergedPulls: [] });

  const add = (pulls: PullRequest[], key: 'openPulls' | 'mergedPulls') => {
    for (const pull of pulls) {
      const { linked, mentioned } = pullIssueRefs(pull, snapshot.owner, snapshot.name);
      for (const n of linked) claims.get(n)?.[key].push(toRef(pull, 'linked'));
      for (const n of mentioned) claims.get(n)?.[key].push(toRef(pull, 'mentioned'));
    }
  };
  add(snapshot.openPulls, 'openPulls');
  add(snapshot.mergedPulls, 'mergedPulls');
  return claims;
}

function relevantFiles(pull: Pick<PullRequest, 'files'>, ignore: string[]): string[] {
  return pull.files.filter((f) => !ignore.some((p) => f.startsWith(p)));
}

export function findHotspots(pulls: PullRequest[], opts: AnalyzeOptions = DEFAULT_OPTIONS): Hotspot[] {
  const byPath = new Map<string, number[]>();
  for (const pull of pulls) {
    for (const path of relevantFiles(pull, opts.ignorePaths)) {
      const list = byPath.get(path) ?? [];
      list.push(pull.number);
      byPath.set(path, list);
    }
  }
  return [...byPath]
    .filter(([, nums]) => nums.length >= opts.minHotspotPulls)
    .map(([path, nums]) => ({ path, pulls: nums.sort((a, b) => a - b) }))
    .sort((a, b) => b.pulls.length - a.pulls.length || a.path.localeCompare(b.path));
}

export function usesChangesets(snapshot: RepoSnapshot, opts: AnalyzeOptions): boolean {
  if (opts.changesets !== 'auto') return opts.changesets;
  return snapshot.openPulls.some((p) => p.files.some((f) => f.startsWith('.changeset/') && f.endsWith('.md')));
}

/** What a change looks like, whether it is an open PR or a local branch that has no PR yet. */
export interface ChangeCandidate {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  body: string;
  files: string[];
  changedFiles: number;
  additions: number;
  deletions: number;
  linkedIssues: number[];
  /** PR numbers to leave out of competition/overlap (the candidate's own PR). */
  exclude: number[];
}

export function candidateFromPull(pull: PullRequest, snapshot: RepoSnapshot): ChangeCandidate {
  const { linked } = pullIssueRefs(pull, snapshot.owner, snapshot.name);
  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    author: pull.author,
    isDraft: pull.isDraft,
    body: pull.body,
    files: pull.files,
    changedFiles: pull.changedFiles,
    additions: pull.additions,
    deletions: pull.deletions,
    linkedIssues: [...linked].sort((a, b) => a - b),
    exclude: [pull.number],
  };
}

export function checkCandidate(
  candidate: ChangeCandidate,
  snapshot: RepoSnapshot,
  claims: Map<number, IssueClaim> = indexClaims(snapshot),
  opts: AnalyzeOptions = DEFAULT_OPTIONS,
): PullCheck {
  const excluded = new Set(candidate.exclude);

  const competing: Competition[] = [];
  for (const n of candidate.linkedIssues) {
    const others = (claims.get(n)?.openPulls ?? [])
      .filter((p) => p.strength === 'linked' && !excluded.has(p.number))
      .map((p) => p.number);
    if (others.length) competing.push({ issue: n, pulls: others });
  }

  const mine = new Set(relevantFiles(candidate, opts.ignorePaths));
  const overlaps: Overlap[] = snapshot.openPulls
    .filter((p) => !excluded.has(p.number))
    .map((p) => ({ number: p.number, title: p.title, author: p.author, shared: relevantFiles(p, opts.ignorePaths).filter((f) => mine.has(f)) }))
    .filter((o) => o.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length || a.number - b.number);

  const lines = candidate.additions + candidate.deletions;
  const tests = candidate.files.filter(isTestPath);
  const description = stripNoise(candidate.body).replace(/\s+/g, ' ').trim();

  const checklist: ChecklistItem[] = [
    {
      id: 'linked-issue',
      label: 'Linked issue',
      ok: candidate.linkedIssues.length > 0,
      detail: candidate.linkedIssues.length ? candidate.linkedIssues.map((n) => `#${n}`).join(', ') : 'no "Fixes #N" or "Refs #N" found',
    },
    {
      id: 'tests',
      label: 'Tests',
      ok: tests.length > 0,
      detail: tests.length ? `${tests.length} test file${tests.length === 1 ? '' : 's'} changed` : 'no test files changed',
    },
  ];
  if (usesChangesets(snapshot, opts)) {
    const has = candidate.files.some((f) => f.startsWith('.changeset/') && f.endsWith('.md'));
    checklist.push({ id: 'changeset', label: 'Changeset', ok: has, detail: has ? 'included' : 'repo uses changesets but none added' });
  }
  checklist.push(
    {
      id: 'description',
      label: 'Description',
      ok: description.length >= 80,
      detail: `${description.length} characters after removing template comments`,
    },
    {
      id: 'size',
      label: 'Reviewable size',
      ok: lines <= opts.maxReviewableLines,
      detail: `${lines} lines changed`,
    },
    {
      id: 'no-competition',
      label: 'No competing PR',
      ok: competing.length === 0,
      detail: competing.length
        ? competing.map((c) => `#${c.issue} also targeted by ${c.pulls.map((n) => `#${n}`).join(', ')}`).join('; ')
        : 'no other open PR targets the same issue',
    },
  );

  const passed = checklist.filter((c) => c.ok).length;
  return {
    number: candidate.number,
    title: candidate.title,
    url: candidate.url,
    author: candidate.author,
    isDraft: candidate.isDraft,
    linkedIssues: candidate.linkedIssues,
    competing,
    overlaps,
    checklist,
    score: Math.round((passed / checklist.length) * 100),
    filesTruncated: candidate.changedFiles > candidate.files.length,
  };
}

export function analyzeRepo(snapshot: RepoSnapshot, opts: AnalyzeOptions = DEFAULT_OPTIONS): RepoReport {
  const claims = indexClaims(snapshot);
  const all = [...claims.values()];
  const newestFirst = (a: IssueClaim, b: IssueClaim) => b.issue.number - a.issue.number;

  const contested = all.filter((c) => c.openPulls.filter((p) => p.strength === 'linked').length >= 2).sort(newestFirst);
  const contestedSet = new Set(contested.map((c) => c.issue.number));
  const possiblyResolved = all
    .filter((c) => c.mergedPulls.some((p) => p.strength === 'linked') && c.openPulls.length === 0)
    .sort(newestFirst);
  const claimed = all.filter((c) => c.openPulls.length > 0 && !contestedSet.has(c.issue.number)).sort(newestFirst);
  const unclaimed = all
    .filter((c) => c.openPulls.length === 0 && c.mergedPulls.length === 0)
    .map((c) => c.issue)
    .sort((a, b) => b.number - a.number);

  return {
    repo: `${snapshot.owner}/${snapshot.name}`,
    fetchedAt: snapshot.fetchedAt,
    totals: {
      openIssues: snapshot.issues.length,
      openPulls: snapshot.openPulls.length,
      mergedPullsScanned: snapshot.mergedPulls.length,
    },
    contested,
    possiblyResolved,
    unclaimed,
    claimed,
    hotspots: findHotspots(snapshot.openPulls, opts),
    pullChecks: snapshot.openPulls.map((p) => checkCandidate(candidateFromPull(p, snapshot), snapshot, claims, opts)),
  };
}
