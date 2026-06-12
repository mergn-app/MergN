import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Boot-time "is there a newer version?" check for self-hosters. Works for both
// install paths and tells the user the RIGHT update command for theirs:
//   - source checkout (git clone + npm install): compares the local git HEAD to
//     the latest commit on the tracked branch  →  "git pull && npm install"
//   - docker image: compares the stamped build time (Dockerfile writes
//     /app/.build-time) to the latest commit date  →  "docker compose pull && up -d"
// Fully non-blocking and silent on any error (offline, private repo, rate
// limit, no git), so it never affects startup. Disable with UPDATE_CHECK=0.
const REPO = process.env.UPDATE_REPO || "flowbaker/mergN";
const BRANCH = process.env.UPDATE_BRANCH || "main";
const GH = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "mergn-update-check",
};

async function localSha(): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      timeout: 3000,
    });
    return stdout.trim() || null;
  } catch {
    return null; // not a git checkout / no git binary (e.g. docker image)
  }
}

async function buildTime(): Promise<string | null> {
  if (process.env.APP_BUILD_TIME) return process.env.APP_BUILD_TIME;
  try {
    return (await readFile("/app/.build-time", "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function checkForUpdates(): Promise<void> {
  if (process.env.UPDATE_CHECK === "0") return;
  try {
    const latest = await getJson<{
      sha?: string;
      commit?: { committer?: { date?: string }; message?: string };
    }>(`${GH}/repos/${REPO}/commits/${BRANCH}`);
    if (!latest?.sha) return; // private / offline / rate-limited → stay quiet
    const latestSha = latest.sha;
    const short = latestSha.slice(0, 7);
    const title = (latest.commit?.message ?? "").split("\n")[0].slice(0, 80);

    // --- source checkout path ---
    const local = await localSha();
    if (local) {
      if (local === latestSha) {
        console.log(`[update] ✓ up to date (${local.slice(0, 7)})`);
        return;
      }
      const cmp = await getJson<{ status?: string; behind_by?: number }>(
        `${GH}/repos/${REPO}/compare/${local}...${BRANCH}`,
      );
      const behind = cmp?.behind_by ?? 0;
      if (behind > 0 || cmp?.status === "behind" || cmp?.status === "diverged") {
        console.log(
          `[update] ⬆ Update available — ${behind || "new"} commit(s) behind, latest ${short}${title ? `: "${title}"` : ""}.\n` +
            `[update]   To update:  git pull && npm install`,
        );
      } else {
        console.log(`[update] ✓ up to date (${local.slice(0, 7)})`);
      }
      return;
    }

    // --- docker image path ---
    const built = await buildTime();
    const date = latest.commit?.committer?.date;
    if (built && date && new Date(date).getTime() > new Date(built).getTime()) {
      console.log(
        `[update] ⬆ Update available — latest ${short} (${date})${title ? `: "${title}"` : ""}.\n` +
          `[update]   To update:  git pull && docker compose up -d`,
      );
    } else {
      console.log(`[update] ✓ up to date (latest ${short})`);
    }
  } catch {
    // never let an update check affect the server
  }
}
