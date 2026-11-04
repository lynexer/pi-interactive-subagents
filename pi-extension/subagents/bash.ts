/**
 * Bash resolution for subagent launch scripts.
 *
 * Shared by herdr.ts (TUI panes) and herdr-desktop.ts (desktop-app terminals).
 * Both need the same answer to "which bash runs a .sh launch script on this
 * machine", and the same conversion of a Windows script path into the POSIX
 * form that bash expects (`/c/...` for Git Bash, `/mnt/c/...` for WSL).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

let resolvedBash: string | null = null;

/**
 * Resolve the Bash that runs launch scripts, mirroring Pi's own resolution:
 * `shellPath` from settings.json, then Git Bash, then PATH.
 *
 * On Windows a bare `bash` usually resolves to the WSL launcher in
 * `%SystemRoot%\System32`, which re-parses its command line and strips the
 * backslashes out of a Windows script path, so Git Bash has to win.
 */
export function resolveBash(): string {
  if (resolvedBash) return resolvedBash;

  if (process.platform !== "win32") {
    resolvedBash = "bash";
    return resolvedBash;
  }

  const configured = process.env.PI_SHELL_PATH?.trim() || readShellPathSetting();
  const candidates = [
    configured,
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Git",
      "bin",
      "bash.exe",
    ),
    "C:\\msys64\\usr\\bin\\bash.exe",
  ].filter((candidate): candidate is string => !!candidate?.trim());

  resolvedBash = candidates.find((candidate) => existsSync(candidate)) ?? "bash";
  return resolvedBash;
}

/** `shellPath` from the global settings, the same knob that configures Pi's own shell. */
function readShellPathSetting(): string {
  try {
    const agentDir =
      process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return typeof settings?.shellPath === "string" ? settings.shellPath : "";
  } catch {
    return "";
  }
}

/**
 * The POSIX form of `dir` as seen by the resolved Bash (`/c/...` for Git Bash,
 * `/mnt/c/...` for WSL). Letting Bash print its own cwd avoids hardcoding mounts.
 */
export function bashPosixDir(dir: string): string | null {
  if (process.platform !== "win32") return dir;
  try {
    return execFileSync(resolveBash(), ["-c", "pwd"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** The POSIX form of a script path, or null when Bash can't translate it. */
export function bashPosixScriptPath(scriptPath: string): string | null {
  const posixDir = bashPosixDir(dirname(scriptPath));
  return posixDir ? `${posixDir}/${basename(scriptPath)}` : null;
}
