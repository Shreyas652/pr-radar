import type { Issue, PullRequest, RepoSnapshot } from '../src/types.js';

export function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: 'reporter',
    labels: [],
    assignees: [],
    comments: 0,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  };
}

export function pull(number: number, overrides: Partial<PullRequest> = {}): PullRequest {
  const files = overrides.files ?? ['src/index.ts'];
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: `dev${number}`,
    state: 'OPEN',
    isDraft: false,
    body: '',
    headRefName: `branch-${number}`,
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: files.length,
    closingIssues: [],
    ...overrides,
    files,
  };
}

export function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    owner: 'acme',
    name: 'widgets',
    fetchedAt: '2026-11-26T00:00:00Z',
    issues: [],
    openPulls: [],
    mergedPulls: [],
    ...overrides,
  };
}

export const LONG_BODY =
  'This change fixes the parser so that nested lists keep their indentation, and adds regression tests for it.';
