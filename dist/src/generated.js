/**
 * Recognises generated files (build output, lockfiles, snapshots) so they do not make a
 * PR look bigger than the part a reviewer actually reads. Rules use .gitattributes
 * patterns and its "last matching line wins" order, so a repo's own
 * `linguist-generated` lines can add paths or switch a default off.
 */
const LOCKFILES = [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'composer.lock',
    'poetry.lock',
    'uv.lock',
    'Pipfile.lock',
    'go.sum',
    'flake.lock',
    'packages.lock.json',
];
/** Paths that are generated in almost every repo. `build/` is left out on purpose: it is often source. */
export const DEFAULT_GENERATED_PATTERNS = ['**/dist/**', '*.min.js', '*.min.css', '*.map', '**/__snapshots__/**', ...LOCKFILES];
const DEFAULT_RULES = DEFAULT_GENERATED_PATTERNS.map((pattern) => ({ pattern, generated: true }));
/** Reads `linguist-generated` settings: `x linguist-generated`, `=true`, `=false`, `-linguist-generated`. */
export function parseGitattributes(text) {
    const rules = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const [pattern, ...attrs] = line.split(/\s+/);
        if (!pattern || pattern.startsWith('[attr]'))
            continue;
        for (const attr of attrs) {
            if (attr === 'linguist-generated' || attr === 'linguist-generated=true')
                rules.push({ pattern, generated: true });
            else if (attr === '-linguist-generated' || attr === 'linguist-generated=false' || attr === '!linguist-generated') {
                rules.push({ pattern, generated: false });
            }
        }
    }
    return rules;
}
/**
 * Converts a .gitattributes pattern to a RegExp over repo-relative paths.
 * Without a slash it matches the file name at any depth; with one it is anchored at the root.
 */
export function patternToRegExp(pattern) {
    let p = pattern.endsWith('/') ? `${pattern}**` : pattern;
    const anchored = p.includes('/');
    if (p.startsWith('/'))
        p = p.slice(1);
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const ch = p[i];
        if (ch === '*' && p[i + 1] === '*') {
            if (p[i + 2] === '/') {
                re += '(?:.*/)?';
                i += 2;
            }
            else {
                re += '.*';
                i += 1;
            }
        }
        else if (ch === '*')
            re += '[^/]*';
        else if (ch === '?')
            re += '[^/]';
        else
            re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}
export class GeneratedMatcher {
    rules;
    constructor(rules) {
        this.rules = rules.map((r) => ({ re: patternToRegExp(r.pattern), generated: r.generated }));
    }
    /** Defaults first, then the repo's .gitattributes, then any extra patterns, so later ones win. */
    static forRepo(gitattributes, extraPatterns = []) {
        return new GeneratedMatcher([
            ...DEFAULT_RULES,
            ...(gitattributes ? parseGitattributes(gitattributes) : []),
            ...extraPatterns.map((pattern) => ({ pattern, generated: true })),
        ]);
    }
    isGenerated(path) {
        let result = false;
        for (const rule of this.rules)
            if (rule.re.test(path))
                result = rule.generated;
        return result;
    }
}
