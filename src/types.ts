export interface Issue {
  number: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  assignees: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  state: 'OPEN' | 'MERGED';
  isDraft: boolean;
  body: string;
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Paths changed by the PR. Empty for merged PRs, which are fetched without files. */
  files: string[];
  /** Per-file line counts, aligned with `files`. Missing in older snapshots. */
  fileStats?: FileStat[];
  /** Issues GitHub itself links as "closed by this PR". */
  closingIssues: number[];
}

export interface RepoPolicyInfo {
  isArchived: boolean;
  /** The token user's permission on the repo: READ, TRIAGE, WRITE, MAINTAIN or ADMIN. */
  viewerPermission?: string;
  /** Path of the contributing guide GitHub would show, if any. */
  contributingPath?: string;
  contributingText?: string;
}

export interface RepoSnapshot {
  owner: string;
  name: string;
  fetchedAt: string;
  /** Login of the token's user, when known. Used to recognise your own PRs. */
  viewer?: string;
  /** Missing in snapshots saved before policy checks existed. */
  policy?: RepoPolicyInfo;
  /** The repo's root .gitattributes, used to recognise generated files. */
  gitattributes?: string;
  issues: Issue[];
  openPulls: PullRequest[];
  mergedPulls: PullRequest[];
}
