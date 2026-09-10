import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";

// .env is expected in the project root — same place the CLI starts from.
export const ENV_FILE = resolve(process.cwd(), ".env");

/**
 * Rewrite .env in place, replacing the given keys' values while preserving
 * every other line (comments, other vars, blank lines). Atomic via temp+rename
 * so a failed write mid-flight can't truncate the file.
 *
 * NOTE: `pinterestAuth.ts` still carries a private copy of this function.
 * It was left alone deliberately to avoid colliding with in-flight work on the
 * Pinterest thumbnail path; fold it into this module once that lands.
 */
export async function updateEnvFile(updates: Record<string, string>): Promise<void> {
  const content = await readFile(ENV_FILE, "utf-8");
  const lines = content.split(/\r?\n/);
  const keysReplaced = new Set<string>();

  const rewritten = lines.map((line) => {
    for (const [key, value] of Object.entries(updates)) {
      if (keysReplaced.has(key)) continue;
      if (line.startsWith(`${key}=`)) {
        keysReplaced.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });

  // If a key wasn't present, append it so subsequent runs can find it.
  for (const [key, value] of Object.entries(updates)) {
    if (!keysReplaced.has(key)) rewritten.push(`${key}=${value}`);
  }

  const tmp = `${ENV_FILE}.tmp`;
  await writeFile(tmp, rewritten.join("\n"), "utf-8");
  await rename(tmp, ENV_FILE);
}
