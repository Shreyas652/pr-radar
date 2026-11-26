import { appendFileSync, readFileSync } from 'node:fs';
import { DEFAULT_OPTIONS, candidateFromPull, checkCandidate } from './analyze.js';
import { DEFAULT_LIMITS, GitHubClient, GitHubRequestError, fetchPull, fetchSnapshot } from './github.js';
import { COMMENT_MARKER, renderPullCheck } from './render.js';

type Env = Record<string, string | undefined>;
type FetchLike = ConstructorParameters<typeof GitHubClient>[1];

export interface ActionIO {
  log(line: string): void;
  readFile(path: string): string;
  appendFile(path: string, text: string): void;
}

export const nodeIO: ActionIO = {
  log: (line) => process.stdout.write(`${line}\n`),
  readFile: (path) => readFileSync(path, 'utf8'),
  appendFile: (path, text) => appendFileSync(path, text),
};

/** Actions passes `with:` inputs as INPUT_<NAME>, uppercased, with spaces (not dashes) turned into underscores. */
export function getInput(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

function intInput(env: Env, name: string, fallback: number): number {
  const raw = getInput(env, name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Input "${name}" must be a non-negative integer, got "${raw}"`);
  return n;
}

/** Escapes a message for a workflow command such as `::warning::`. */
export function command(kind: 'error' | 'warning' | 'notice', message: string): string {
  return `::${kind}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}

export interface PullEvent {
  owner: string;
  name: string;
  number: number;
}

/** Reads the PR number and base repository from a pull_request or pull_request_target event. */
export function readPullEvent(env: Env, io: ActionIO): PullEvent | undefined {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  const event = JSON.parse(io.readFile(env.GITHUB_EVENT_PATH)) as {
    pull_request?: { number?: number };
    repository?: { full_name?: string };
  };
  const number = event.pull_request?.number;
  if (typeof number !== 'number') return undefined;
  const [owner, name] = (event.repository?.full_name ?? env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !name) throw new Error('Could not tell which repository this pull request belongs to');
  return { owner, name, number };
}

interface IssueComment {
  id: number;
  body?: string | null;
}

/**
 * Updates the earlier pr-radar comment on the PR, or creates one. A comment someone else
 * wrote with the marker cannot be edited (403), so it is skipped rather than failing the run.
 */
export async function upsertComment(client: GitHubClient, event: PullEvent, body: string): Promise<'created' | 'updated'> {
  const base = `/repos/${event.owner}/${event.name}/issues`;
  const marked: number[] = [];
  for (let page = 1; ; page++) {
    const comments = await client.rest<IssueComment[]>('GET', `${base}/${event.number}/comments?per_page=100&page=${page}`);
    for (const c of comments) if (c.body?.startsWith(COMMENT_MARKER)) marked.push(c.id);
    if (comments.length < 100) break;
  }
  for (const id of marked) {
    try {
      await client.rest('PATCH', `${base}/comments/${id}`, { body });
      return 'updated';
    } catch (err) {
      if (!(err instanceof GitHubRequestError && (err.status === 403 || err.status === 404))) throw err;
    }
  }
  await client.rest('POST', `${base}/${event.number}/comments`, { body });
  return 'created';
}

export async function runAction(env: Env, fetchImpl: FetchLike = fetch, io: ActionIO = nodeIO): Promise<number> {
  const event = readPullEvent(env, io);
  if (!event) {
    io.log(command('warning', 'pr-radar only runs on pull_request and pull_request_target events. Skipping.'));
    return 0;
  }

  const token = getInput(env, 'github-token') || env.GITHUB_TOKEN;
  if (!token) {
    io.log(command('error', 'No token. Pass `github-token`, or leave it unset to use the default GITHUB_TOKEN.'));
    return 1;
  }

  const client = new GitHubClient(token, fetchImpl, { apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });
  const opts = { ...DEFAULT_OPTIONS, minHotspotPulls: intInput(env, 'min-hotspot', DEFAULT_OPTIONS.minHotspotPulls) };
  const [snapshot, pull] = await Promise.all([
    fetchSnapshot(client, event.owner, event.name, {
      maxIssues: 0,
      maxOpenPulls: intInput(env, 'max-prs', DEFAULT_LIMITS.maxOpenPulls),
      maxMergedPulls: intInput(env, 'max-merged', DEFAULT_LIMITS.maxMergedPulls),
    }),
    fetchPull(client, event.owner, event.name, event.number),
  ]);
  if (!pull) throw new Error(`Pull request #${event.number} not found in ${event.owner}/${event.name}`);

  // The PR under review must be in the open set even when it is older than the fetch window.
  snapshot.openPulls = [...snapshot.openPulls.filter((p) => p.number !== pull.number), pull];

  const check = checkCandidate(candidateFromPull(pull, snapshot), snapshot, undefined, opts);
  const body = renderPullCheck(check, `${event.owner}/${event.name}`, { mentions: false });

  if (env.GITHUB_STEP_SUMMARY) io.appendFile(env.GITHUB_STEP_SUMMARY, `${body}\n`);
  if (env.GITHUB_OUTPUT) {
    io.appendFile(env.GITHUB_OUTPUT, `score=${check.score}\ncompeting=${check.competing.length}\noverlaps=${check.overlaps.length}\n`);
  }
  io.log(`pr-radar: #${check.number} scored ${check.score}% with ${check.competing.length} competing and ${check.overlaps.length} overlapping PRs.`);

  if (getInput(env, 'comment') !== 'false') {
    try {
      const result = await upsertComment(client, event, body);
      io.log(`pr-radar: ${result} the PR comment.`);
    } catch (err) {
      if (!(err instanceof GitHubRequestError && (err.status === 403 || err.status === 404))) throw err;
      io.log(
        command(
          'warning',
          'pr-radar could not comment because the token is read-only. This is normal for pull_request runs from forks: ' +
            'use the pull_request_target event with `pull-requests: write` permission. The report is in the job summary.',
        ),
      );
    }
  }

  const failUnder = getInput(env, 'fail-under');
  if (failUnder) {
    const threshold = intInput(env, 'fail-under', 0);
    if (check.score < threshold) {
      io.log(command('error', `pr-radar score ${check.score}% is below the required ${threshold}%.`));
      return 1;
    }
  }
  return 0;
}
