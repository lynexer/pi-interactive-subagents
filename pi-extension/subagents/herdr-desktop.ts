/**
 * Herdr desktop surface layer — the same surface API as herdr.ts, for pi
 * running inside the Herdr desktop app (`herdr-app`).
 *
 * The desktop app runs every terminal in herdr-core and talks to it with the
 * `hc` CLI. It exports `HC_TERMINAL_ID` (e.g. `t2`) into each terminal instead
 * of the `HERDR_*` variables the Herdr TUI sets.
 *
 * A subagent is started with `hc run`, which records the spawning pi's
 * terminal as the subagent's `parent`. Herdr shows parented terminals as
 * pane-less sub-agents: they nest under the agent that started them in the
 * app's Agents list, with no pane of their own. No `herdr.space`/`herdr.tab`
 * labels are set, so nothing is adopted into a tab (which would make the same
 * terminal appear twice — once nested, once as a top-level tab agent). The
 * person opens one from the list (peek) and can promote it to a tab with
 * keep-as-tab.
 *
 * Nothing is typed into a shell. createSurface only reserves a unique hc
 * terminal name, which is the surface handle. The terminal starts once the
 * launch script exists, running that script through the person's login shell
 * (or Git Bash on Windows) so it sees the same PATH and environment a typed
 * command would. When the script ends, the terminal finishes and the app
 * closes it.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { bashPosixScriptPath, resolveBash } from "./bash.ts";

const execFileAsync = promisify(execFile);

function hcBin(): string {
  return process.env.PI_SUBAGENT_HC_BIN || "hc";
}

/**
 * True when this pi runs in a herdr-core terminal. herdr-core exports
 * `HC_TERMINAL_ID` into every terminal it starts.
 */
export function isHerdrDesktopEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.HC_TERMINAL_ID?.trim();
}

function errorMessage(error: any): string {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  for (const text of [stderr, stdout]) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message ?? parsed?.error;
      if (typeof message === "string" && message) return message;
    } catch {}
    return text;
  }
  return error?.message ?? String(error);
}

function hc(args: string[]): string {
  try {
    return execFileSync(hcBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error: any) {
    throw new Error(`hc ${args[0]} failed: ${errorMessage(error)}`);
  }
}

function hcJson(args: string[]): any {
  const out = hc([...args, "--json"]).trim();
  return out ? JSON.parse(out) : null;
}

function quote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * An hc terminal name for a subagent: hc wants 1-32 of a-z 0-9 - _ and
 * uniqueness among live terminals. Returns null when nothing usable is left.
 */
export function terminalName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || null;
}

/**
 * The first of `base`, `base-2`, `base-3`, ... that no live terminal uses,
 * kept within hc's 32 characters.
 */
export function uniqueTerminalName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 32 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Names hc already holds for live terminals, plus names reserved here but not started yet. */
function takenNames(): Set<string> {
  const taken = new Set(pending.keys());
  try {
    const listed = hcJson(["ls"]);
    const terminals = Array.isArray(listed) ? listed : listed?.terminals;
    for (const t of terminals ?? []) {
      if (typeof t?.name === "string") taken.add(t.name);
    }
  } catch {}
  return taken;
}

interface PendingLaunch {
  cwd: string;
}

/** Surfaces handed out by createDesktopSurface whose terminal has not started yet. */
const pending = new Map<string, PendingLaunch>();

export function isPendingDesktopSurface(surface: string): boolean {
  return pending.has(surface);
}

/**
 * Reserve a subagent surface: a unique hc terminal name, which is the returned
 * handle. The terminal starts in launchDesktopSurface. No `herdr.space` /
 * `herdr.tab` labels are set, so the terminal is a pane-less sub-agent nested
 * under the spawning pi in the app's Agents list rather than a new tab/pane.
 */
export function createDesktopSurface(title: string): string {
  const handle = uniqueTerminalName(terminalName(title) ?? "subagent", takenNames());
  pending.set(handle, { cwd: process.cwd() });
  return handle;
}

/**
 * The program a subagent terminal runs: the launch script, through the
 * person's login shell so PATH, version managers and exported keys match a
 * typed command. `exec` leaves bash as the only process once the shell has
 * set up the environment.
 */
export function launchArgv(
  scriptPath: string,
  options: {
    shell?: string;
    platform?: NodeJS.Platform;
    /** Bash binary that runs a Windows launch script (injected for tests). */
    bashPath?: string;
    /** POSIX form of `scriptPath` as that bash sees it (injected for tests). */
    posixScriptPath?: string;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const bash = options.bashPath ?? resolveBash();
    const posix = options.posixScriptPath ?? bashPosixScriptPath(scriptPath) ?? scriptPath;
    return [bash, posix];
  }
  const shell = options.shell?.trim() || "/bin/sh";
  return [shell, "-l", "-i", "-c", `exec bash ${quote(scriptPath)}`];
}

/** The `hc run` arguments that start a subagent terminal. */
export function runArgs(options: {
  cwd: string;
  name: string;
  argv: string[];
}): string[] {
  return [
    "run",
    "--bg",
    "--keep",
    "--no-notify",
    "--outlive-parent",
    "--cwd",
    options.cwd,
    "--name",
    options.name,
    "--",
    ...options.argv,
  ];
}

/** Start a reserved surface's terminal, running the launch script. */
export function launchDesktopSurface(surface: string, scriptPath: string): void {
  const launch = pending.get(surface);
  if (!launch) throw new Error(`No pending subagent surface "${surface}"`);
  pending.delete(surface);

  const argv = launchArgv(scriptPath, { shell: process.env.SHELL });
  hcJson(runArgs({ cwd: launch.cwd, name: surface, argv }));
}

/** Type a line into a terminal and press Enter. */
export function sendDesktopCommand(terminal: string, command: string): void {
  hc(["send", terminal, command]);
}

/**
 * Deliver a message to the agent in a terminal. `hc send` waits for the
 * person to pause typing and refuses an agent parked at a dialog.
 */
export function sendDesktopMessage(terminal: string, message: string): void {
  hc(["send", terminal, message]);
}

/** The last `lines` lines of a terminal's screen and history. */
export function lastLines(text: string, lines: number): string {
  const all = text.replace(/\s+$/, "").split("\n");
  return all.slice(-Math.max(1, lines)).join("\n") + "\n";
}

export function readDesktopScreen(terminal: string, lines: number): string {
  return lastLines(hc(["read", terminal, "--lines", String(Math.max(1, lines))]), lines);
}

export async function readDesktopScreenAsync(terminal: string, lines: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      hcBin(),
      ["read", terminal, "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return lastLines(stdout, lines);
  } catch (error: any) {
    throw new Error(`hc read failed: ${errorMessage(error)}`);
  }
}

/**
 * Whether a subagent's terminal has ended, from herdr-core's own record
 * rather than its screen. `exitCode` is the launch script's.
 */
export async function desktopExitState(
  terminal: string,
): Promise<{ finished: false } | { finished: true; exitCode: number }> {
  const { stdout } = await execFileAsync(hcBin(), ["get", terminal, "--json"], { encoding: "utf8" });
  return exitStateOf(JSON.parse(stdout));
}

export function exitStateOf(
  record: any,
): { finished: false } | { finished: true; exitCode: number } {
  if (record?.state !== "finished") return { finished: false };
  return { finished: true, exitCode: typeof record.exit_code === "number" ? record.exit_code : 1 };
}

/** End a subagent's terminal; the app closes its pane with it. */
export function closeDesktopSurface(terminal: string): void {
  if (pending.delete(terminal)) return;
  try {
    hc(["kill", terminal]);
  } catch {
    // Already finished on its own.
  }
  try {
    hc(["rm", terminal]);
  } catch {
    // Already removed; the core keeps finished terminals harmlessly otherwise.
  }
}
