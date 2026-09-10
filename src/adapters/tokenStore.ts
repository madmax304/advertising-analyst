import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared .env read/write for the auth modules.
 *
 * Why this exists: each auth module used to do `resolve(process.cwd(), ".env")`.
 * That silently depends on where the process was started — from a git worktree
 * or any other directory there is no .env, and the failure lands AFTER the
 * token exchange has already happened. Since providers rotate refresh tokens on
 * exchange, that window can destroy the only copy of a live credential.
 *
 * So: resolution is explicit, and callers must assertWritable() BEFORE the
 * network call. Fail loudly with nothing spent, rather than quietly with a
 * rotated token we can't store.
 */

function findEnvFile(): string {
  // 1. Explicit override, 2. the same var dotenv/config honours, so a caller
  // that pointed dotenv at a file gets writes to that same file.
  const explicit = process.env.MEDIA_DIGEST_ENV_FILE ?? process.env.DOTENV_CONFIG_PATH;
  if (explicit) return resolve(explicit);

  // 3. Walk up from this module to the package root (nearest package.json).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "package.json"))) {
      const candidate = resolve(dir, ".env");
      if (existsSync(candidate)) return candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4. Fall back to cwd — the historical behaviour, and correct for the
  //    scheduled task, which runs from the project root.
  return resolve(process.cwd(), ".env");
}

export const ENV_FILE = findEnvFile();

/**
 * Throw unless we can actually persist to the env file. Call this BEFORE
 * exchanging a token, never after.
 */
export function assertWritable(context: string): void {
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `Refusing to ${context}: no .env at ${ENV_FILE}. A refresh can rotate the ` +
        `refresh token, and without a writable .env the new one would be lost — ` +
        `leaving no way back in. Run from the project root, or set ` +
        `MEDIA_DIGEST_ENV_FILE to the real .env path.`,
    );
  }
}

/** Read a key straight from the .env file (not process.env). */
export function readEnvFileValue(key: string): string | undefined {
  if (!existsSync(ENV_FILE)) return undefined;
  for (const line of readFileSync(ENV_FILE, "utf-8").split(/\r?\n/)) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return undefined;
}

/**
 * Rewrite .env in place, replacing the given keys' values while preserving
 * every other line (comments, other vars, blank lines). Atomic via temp+rename
 * so a failed write mid-flight can't truncate the file.
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

  // If a key wasn't present (expiry keys start out absent), append it.
  for (const [key, value] of Object.entries(updates)) {
    if (!keysReplaced.has(key)) rewritten.push(`${key}=${value}`);
  }

  const tmp = `${ENV_FILE}.tmp`;
  await writeFile(tmp, rewritten.join("\n"), "utf-8");
  await rename(tmp, ENV_FILE);
}

/** Record when a token dies, so renewal can run on a schedule instead of on failure. */
export async function recordExpiry(key: string, expiresInSeconds: number): Promise<void> {
  const at = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  process.env[key] = at;
  await updateEnvFile({ [key]: at });
}

export function daysUntil(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (t - Date.now()) / 86_400_000;
}
