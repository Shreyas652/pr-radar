import { execFileSync } from 'node:child_process';

export interface LocalBranch {
  branch: string;
  files: string[];
  messages: string;
  additions: number;
  deletions: number;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Parses `git diff --numstat` output. Binary files ("-\t-\tpath") count as zero lines. */
export function parseNumstat(numstat: string): { files: string[]; additions: number; deletions: number } {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const [add, del, ...rest] = line.split('\t');
    if (!rest.length) continue;
    files.push(rest.join('\t'));
    additions += Number(add) || 0;
    deletions += Number(del) || 0;
  }
  return { files, additions, deletions };
}

export function readLocalBranch(base: string, cwd = process.cwd()): LocalBranch {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const stats = parseNumstat(git(['diff', '--numstat', '--no-renames', `${base}...HEAD`], cwd));
  const messages = git(['log', '--format=%B', `${base}..HEAD`], cwd);
  return { branch, messages, ...stats };
}

/** Reads owner/name from a GitHub remote URL (https or ssh). */
export function parseGitHubRemote(url: string): { owner: string; name: string } | undefined {
  const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : undefined;
}

export function remoteRepo(remote: string, cwd = process.cwd()): { owner: string; name: string } | undefined {
  try {
    return parseGitHubRemote(git(['remote', 'get-url', remote], cwd));
  } catch {
    return undefined;
  }
}
