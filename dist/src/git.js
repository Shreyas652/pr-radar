import { execFileSync } from 'node:child_process';
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/** Parses `git diff --numstat` output. Binary files ("-\t-\tpath") count as zero lines. */
export function parseNumstat(numstat) {
    const fileStats = [];
    for (const line of numstat.split('\n')) {
        const [add, del, ...rest] = line.split('\t');
        if (!rest.length)
            continue;
        fileStats.push({ path: rest.join('\t'), additions: Number(add) || 0, deletions: Number(del) || 0 });
    }
    return {
        files: fileStats.map((f) => f.path),
        fileStats,
        additions: fileStats.reduce((n, f) => n + f.additions, 0),
        deletions: fileStats.reduce((n, f) => n + f.deletions, 0),
    };
}
export function readLocalBranch(base, cwd = process.cwd()) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const stats = parseNumstat(git(['diff', '--numstat', '--no-renames', `${base}...HEAD`], cwd));
    const messages = git(['log', '--format=%B', `${base}..HEAD`], cwd);
    return { branch, messages, ...stats };
}
/** Reads owner/name from a GitHub remote URL (https or ssh). */
export function parseGitHubRemote(url) {
    const m = url.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : undefined;
}
export function remoteRepo(remote, cwd = process.cwd()) {
    try {
        return parseGitHubRemote(git(['remote', 'get-url', remote], cwd));
    }
    catch {
        return undefined;
    }
}
