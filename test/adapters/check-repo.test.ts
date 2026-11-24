import { describe, expect, it } from "vitest";

type Hit = { path: string; line: number; rule: string };
const load = async () => (await import("../../scripts/check-repo.mjs" as string)) as { scanText(p: string, t: string): Hit[]; scanRepo(): Hit[] };

// Fixtures are assembled from pieces so this file never contains a complete secret-like string.
const tgToken = "123456789" + ":" + "A".repeat(35);
const alpacaId = "PK" + "ABCDEFGHIJ0123456789".slice(0, 18);

describe("AT-21 / AT-23 repository check", () => {
  it("flags secret-like strings (AT-21)", async () => {
    const { scanText } = await load();
    expect(scanText("src/x.ts", `const t = "${tgToken}";`)[0]?.rule).toBe("Telegram bot token");
    expect(scanText("src/x.ts", `const id = "${alpacaId}";`)[0]?.rule).toBe("Alpaca key id");
    expect(scanText("src/x.ts", `const apiKey = "${"Ab1".repeat(14)}";`)[0]?.rule).toMatch(/assignment/);
    expect(scanText("a.env", `secret: '${"0f".repeat(24)}'`).length).toBeGreaterThan(0);
    expect(scanText("k.pem", "-----BEGIN " + "PRIVATE KEY-----")[0]?.rule).toBe("private key block");
    expect(scanText("src/x.ts", 'const code = process.env.DASHBOARD_ACCESS_CODE;')).toEqual([]);
    expect(scanText("src/x.ts", 'const SECRET = "whsecret_abcdefghijklmnop";')).toEqual([]);
  });

  it("flags AI SDK names and hosts outside CLAUDE.md and docs/ (AT-23)", async () => {
    const { scanText } = await load();
    const ai = "anth" + "ropic";
    const oa = "open" + "ai";
    expect(scanText("src/x.ts", `import X from "@${ai}-ai/sdk";`).length).toBeGreaterThan(0);
    expect(scanText("src/x.ts", `fetch("https://api.${oa}.com/v1")`).length).toBeGreaterThan(0);
    expect(scanText("package.json", `"${oa}": "^4"`).length).toBeGreaterThan(0);
    expect(scanText("src/x.ts", 'const m = "claude-' + 'sonnet-5-5";').length).toBeGreaterThan(0);
    expect(scanText("CLAUDE.md", `No ${ai} SDK anywhere`)).toEqual([]);
    expect(scanText("docs/PRD.md", `No ${oa} calls`)).toEqual([]);
  });

  it("the repository itself is clean", async () => {
    const { scanRepo } = await load();
    expect(scanRepo()).toEqual([]);
  });
});
