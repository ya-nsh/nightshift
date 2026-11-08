import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DAEMON_LOG } from "./daemon.js";

/**
 * `nightshift service install|uninstall|status`: runs `nightshift daemon` for one nightshift home
 * as a launchd agent (macOS) or a systemd user unit (Linux).
 */

export type ServicePlatform = "darwin" | "linux";

export interface ServiceSpec {
  platform: ServicePlatform;
  /** launchd label, or the systemd unit name without `.service`. */
  name: string;
  /** The plist or unit file. */
  file: string;
  /** The nightshift home the daemon watches. */
  home: string;
  args: string[];
  /** PATH for the daemon: launchd and systemd start services with a bare one, without gh/claude. */
  envPath: string;
  logFile: string;
}

export interface SpecOptions {
  platform: NodeJS.Platform;
  /** The user's home directory (for ~/Library/LaunchAgents or ~/.config/systemd/user). */
  userHome: string;
  /** XDG_CONFIG_HOME, when set. */
  xdgConfigHome?: string | undefined;
  /** The directory that contains `.nightshift/`. */
  home: string;
  /** `.nightshift/` itself. */
  dir: string;
  configFile: string;
  nodePath: string;
  cliPath: string;
  envPath: string;
}

export class ServiceError extends Error {
  override name = "ServiceError";
}

export function serviceSpec(options: SpecOptions): ServiceSpec {
  const { platform } = options;
  if (platform !== "darwin" && platform !== "linux") {
    throw new ServiceError(
      `nightshift service supports macOS (launchd) and Linux (systemd), not ${platform}; run \`nightshift daemon\` under your own supervisor`,
    );
  }
  for (const [what, value] of Object.entries({
    home: options.home,
    config: options.configFile,
    node: options.nodePath,
    cli: options.cliPath,
  })) {
    if (!path.isAbsolute(value))
      throw new ServiceError(`the ${what} path must be absolute: ${value}`);
    if (/[\n\r\0]/.test(value)) throw new ServiceError(`the ${what} path contains a line break`);
  }
  // One service per home: readable, and unique through a hash of the home's path.
  const slug =
    path
      .basename(options.home)
      .replace(/[^A-Za-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "home";
  const hash = createHash("sha256").update(options.home).digest("hex").slice(0, 8);
  const args = [options.nodePath, options.cliPath, "daemon", "--config", options.configFile];
  const logFile = path.join(options.dir, DAEMON_LOG);
  if (platform === "darwin") {
    const name = `com.github.ya-nsh.nightshift.${slug}-${hash}`;
    return {
      platform,
      name,
      file: path.join(options.userHome, "Library", "LaunchAgents", `${name}.plist`),
      home: options.home,
      args,
      envPath: options.envPath,
      logFile,
    };
  }
  const name = `nightshift-${slug}-${hash}`;
  const config = options.xdgConfigHome || path.join(options.userHome, ".config");
  return {
    platform,
    name,
    file: path.join(config, "systemd", "user", `${name}.service`),
    home: options.home,
    args,
    envPath: options.envPath,
    logFile,
  };
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const s = (value: string) => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(spec.name)}
  <key>ProgramArguments</key>
  <array>
${spec.args.map((arg) => `    ${s(arg)}`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  ${s(spec.home)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${s(spec.envPath)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ExitTimeOut</key>
  <integer>90</integer>
  <key>StandardOutPath</key>
  ${s(spec.logFile)}
  <key>StandardErrorPath</key>
  ${s(spec.logFile)}
</dict>
</plist>
`;
}

/** A word for a systemd command line or `Environment=`: quoted, with `%` and `$` escaped. */
export function systemdQuote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=nightshift daemon for ${spec.home.replaceAll("%", "%%")}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${spec.args.map(systemdQuote).join(" ")}
WorkingDirectory=${spec.home.replaceAll("%", "%%")}
Environment=${systemdQuote(`PATH=${spec.envPath}`)}
Restart=on-failure
RestartSec=60
TimeoutStopSec=90

[Install]
WantedBy=default.target
`;
}

export function serviceFile(spec: ServiceSpec): string {
  return spec.platform === "darwin" ? launchdPlist(spec) : systemdUnit(spec);
}

export interface CommandResult {
  code: number | null;
  output: string;
}
export type Runner = (command: string, args: string[]) => Promise<CommandResult>;

function launchdDomain(uid: number): string {
  return `gui/${uid}`;
}

async function must(run: Runner, command: string, args: string[]): Promise<CommandResult> {
  const result = await run(command, args);
  if (result.code !== 0) {
    throw new ServiceError(
      `${command} ${args.join(" ")} failed (exit ${String(result.code)}): ${result.output.trim()}`,
    );
  }
  return result;
}

/** Writes the service file, validates it, and (re)loads it. Returns lines to print. */
export async function installService(
  spec: ServiceSpec,
  run: Runner,
  uid: number,
): Promise<string[]> {
  const lines: string[] = [];
  await mkdir(path.dirname(spec.file), { recursive: true });
  await mkdir(path.dirname(spec.logFile), { recursive: true });
  await writeFile(spec.file, serviceFile(spec));
  lines.push(`wrote ${spec.file}`);
  if (spec.platform === "darwin") {
    await must(run, "plutil", ["-lint", spec.file]);
    const target = `${launchdDomain(uid)}/${spec.name}`;
    await run("launchctl", ["bootout", target]); // not loaded yet is fine
    await must(run, "launchctl", ["bootstrap", launchdDomain(uid), spec.file]);
    lines.push(`loaded launchd agent ${spec.name}`);
  } else {
    const unit = `${spec.name}.service`;
    await must(run, "systemctl", ["--user", "daemon-reload"]);
    await must(run, "systemctl", ["--user", "enable", unit]);
    await must(run, "systemctl", ["--user", "restart", unit]);
    lines.push(`enabled and started systemd user unit ${unit}`);
    lines.push(
      "to keep it running while you are logged out: loginctl enable-linger (once per user)",
    );
  }
  lines.push(`daemon log: ${spec.logFile}`);
  return lines;
}

export async function uninstallService(
  spec: ServiceSpec,
  run: Runner,
  uid: number,
): Promise<string[]> {
  const lines: string[] = [];
  if (spec.platform === "darwin") {
    const result = await run("launchctl", ["bootout", `${launchdDomain(uid)}/${spec.name}`]);
    lines.push(
      result.code === 0 ? `unloaded launchd agent ${spec.name}` : "launchd agent was not loaded",
    );
  } else {
    const unit = `${spec.name}.service`;
    const result = await run("systemctl", ["--user", "disable", "--now", unit]);
    lines.push(
      result.code === 0 ? `stopped and disabled ${unit}` : `${unit} was not enabled or running`,
    );
  }
  if (existsSync(spec.file)) {
    await rm(spec.file, { force: true });
    lines.push(`removed ${spec.file}`);
  } else {
    lines.push(`no service file at ${spec.file}`);
  }
  if (spec.platform === "linux") await run("systemctl", ["--user", "daemon-reload"]);
  return lines;
}

export interface ServiceStatus {
  installed: boolean;
  /** The service file differs from what `install` would write now (e.g. nightshift moved). */
  stale: boolean;
  loaded: boolean;
  running: boolean;
  pid: number | undefined;
}

export async function serviceStatus(
  spec: ServiceSpec,
  run: Runner,
  uid: number,
): Promise<ServiceStatus> {
  const installed = existsSync(spec.file);
  const stale = installed && (await readFile(spec.file, "utf8")) !== serviceFile(spec);
  if (spec.platform === "darwin") {
    const result = await run("launchctl", ["print", `${launchdDomain(uid)}/${spec.name}`]);
    if (result.code !== 0)
      return { installed, stale, loaded: false, running: false, pid: undefined };
    const pid = /^\s*pid = (\d+)/m.exec(result.output)?.[1];
    const running = /^\s*state = running/m.test(result.output);
    return {
      installed,
      stale,
      loaded: true,
      running,
      pid: pid === undefined ? undefined : Number(pid),
    };
  }
  const unit = `${spec.name}.service`;
  const active = await run("systemctl", ["--user", "is-active", unit]);
  const enabled = await run("systemctl", ["--user", "is-enabled", unit]);
  const shown = await run("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit]);
  const pid = Number(shown.output.trim());
  return {
    installed,
    stale,
    loaded: enabled.code === 0,
    running: active.code === 0,
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
  };
}

/**
 * The `node` to put in the service: the first one on PATH that is the same binary as the running
 * one, e.g. Homebrew's `/opt/homebrew/bin/node` rather than its versioned Cellar path, so the
 * service survives a Node upgrade. Falls back to `execPath`.
 */
export function stableNodePath(execPath: string, envPath: string): string {
  let real: string;
  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === real) return candidate;
    } catch {
      // not here
    }
  }
  return execPath;
}

/** Warnings about where nightshift would run from. */
export function installWarnings(cli: string): string[] {
  const warnings: string[] = [];
  if (/[\\/]_npx[\\/]/.test(cli)) {
    warnings.push(
      `nightshift runs from the npx cache (${cli}), which npm may clean; install it (npm install -g @deva00/nightshift) and run \`nightshift service install\` again`,
    );
  }
  return warnings;
}
