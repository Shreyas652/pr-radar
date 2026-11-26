const REF_PATTERN = /(?<![\w&/])(?:(?<owner>[A-Za-z0-9][\w.-]*)\/(?<repo>[\w.-]+))?#(?<num>\d+)\b|https?:\/\/github\.com\/(?<uowner>[\w.-]+)\/(?<urepo>[\w.-]+)\/(?:issues|pull)\/(?<unum>\d+)/g;
const LINK_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references|address(?:es|ed)?|implements?|part of|towards?)\b/i;
/** Removes text that usually holds template placeholders or code, not real references. */
export function stripNoise(text) {
    return text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
}
/**
 * Finds issue/PR numbers referenced in free text for one repository.
 * References to other repositories are ignored.
 */
export function extractIssueRefs(text, owner, repo) {
    const linked = new Set();
    const mentioned = new Set();
    const want = `${owner}/${repo}`.toLowerCase();
    for (const line of stripNoise(text).split('\n')) {
        for (const match of line.matchAll(REF_PATTERN)) {
            const g = match.groups ?? {};
            const refOwner = g.owner ?? g.uowner;
            const refRepo = g.repo ?? g.urepo;
            if (refOwner && refRepo && `${refOwner}/${refRepo}`.toLowerCase() !== want)
                continue;
            const num = Number(g.num ?? g.unum);
            if (!Number.isSafeInteger(num) || num <= 0)
                continue;
            const prefix = line.slice(0, match.index);
            const clause = prefix.slice(Math.max(prefix.lastIndexOf('.'), prefix.lastIndexOf(';')) + 1);
            if (LINK_KEYWORD.test(clause))
                linked.add(num);
            else
                mentioned.add(num);
        }
    }
    for (const n of linked)
        mentioned.delete(n);
    return { linked: [...linked].sort((a, b) => a - b), mentioned: [...mentioned].sort((a, b) => a - b) };
}
