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
  /** Issues GitHub itself links as "closed by this PR". */
  closingIssues: number[];
}

export interface RepoSnapshot {
  owner: string;
  name: string;
  fetchedAt: string;
  /** Login of the token's user, when known. Used to recognise your own PRs. */
  viewer?: string;
  issues: Issue[];
  openPulls: PullRequest[];
  mergedPulls: PullRequest[];
}
