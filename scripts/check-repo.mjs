// Repository hygiene gate (AT-21: no secrets in the repository; AT-23: no AI/LLM SDK or call).
// Scans every tracked file plus untracked files that are not git-ignored. Exit 1 with a list on any hit.
// Prints file and line only, never the matched text (a hit could be a real secret).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SECRET_PATTERNS = [
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["Alpaca key id", /\b(?:PK|AK|CK)[A-Z0-9]{18}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Cloudflare/API token assignment", /\b(?:api[_-]?token|api[_-]?key|secret[_-]?key|access[_-]?code|bot[_-]?token|secret|password|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{32,}["']/i],
  ["long hex string in an assignment", /[:=]\s*["'][0-9a-f]{40,}["']/i],
];

const AI_PATTERNS = [
  ["AI SDK or provider name", /\b(?:anthropic|openai|@anthropic-ai|langchain|generativelanguage|gemini-api|cohere-ai|mistralai|replicate)\b/i],
  ["AI provider host", /\b(?:api\.anthropic\.com|api\.openai\.com|openrouter\.ai|api\.cohere\.(?:ai|com)|api\.mistral\.ai)\b/i],
  ["Claude model id", /\bclaude-(?:opus|sonnet|haiku|\d)[\w.-]*/i],
];

/** Where the words may appear: project rules, agent notes and documentation, and this scanner (tooling, not product code). */
const AI_ALLOWED = [/^CLAUDE\.md$/, /^\.claude\//, /^docs\//, /^scripts\/check-repo\.mjs$/, /^test\/adapters\/check-repo\.test\.ts$/, /^ux\//, /^package-lock\.json$/];
const SKIP_FILES = [/^package-lock\.json$/, /\.(png|jpg|jpeg|gif|ico|woff2?|webmanifest)$/i];

/** Pure scan of one file's text. Returns [{line, rule}] hits. */
export function scanText(path, text) {
  const hits = [];
  const aiOk = AI_ALLOWED.some((r) => r.test(path));
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [name, re] of SECRET_PATTERNS) if (re.test(line)) hits.push({ path, line: i + 1, rule: name });
    if (!aiOk) for (const [name, re] of AI_PATTERNS) if (re.test(line)) hits.push({ path, line: i + 1, rule: name });
  });
  return hits;
}

function listFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return out.split("\0").filter(Boolean);
}

export function scanRepo(files = listFiles(), read = (p) => readFileSync(p, "utf8")) {
  const hits = [];
  for (const f of files) {
    if (SKIP_FILES.some((r) => r.test(f))) continue;
    let text;
    try {
      if (!statSync(f).isFile() || statSync(f).size > 2_000_000) continue;
      text = read(f);
    } catch {
      continue; // deleted or unreadable
    }
    if (text.includes("\0")) continue; // binary
    hits.push(...scanText(f, text));
  }
  return hits;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const hits = scanRepo();
  if (hits.length) {
    console.error("check-repo: FAILED (text of the match is not printed)");
    for (const h of hits) console.error(`  ${h.path}:${h.line}  ${h.rule}`);
    process.exit(1);
  }
  console.log("check-repo: clean (no secret-like strings, no AI SDK or host).");
}
