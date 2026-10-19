"use strict";

// How other devices reach pi-web — this device only, the local network, a
// Cloudflare quick tunnel, or Tailscale — ported from pi-pocket's launcher
// (src/launcher/access.ts). The choice feeds the bind hostname of `next start`
// and, in token mode, which sign-in link and QR the launcher prints.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { once } = require("events");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createInterface } = require("readline");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { delimiter } = require("path");

const ACCESS_MODES = ["local", "lan", "cloudflare", "tailscale"];

const ACCESS_LABELS = {
  local: "This device only",
  lan: "Local network",
  cloudflare: "Cloudflare Tunnel",
  tailscale: "Tailscale",
};

function isAccessMode(value) {
  return value !== undefined && ACCESS_MODES.includes(value);
}

/** Tailscale hands out addresses in 100.64.0.0/10. */
function isTailscaleAddress(address) {
  const [first, second] = address.split(".").map(Number);

  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

function ipv4Addresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, list]) =>
    (list ?? [])
      .filter((net) => net.family === "IPv4" && !net.internal)
      .map((net) => ({ name, address: net.address })),
  );
}

/** This machine's addresses on the local network (not Tailscale's). */
function lanAddresses(interfaces = os.networkInterfaces()) {
  return ipv4Addresses(interfaces)
    .filter((each) => !isTailscaleAddress(each.address))
    .map((each) => each.address);
}

/** This machine's Tailscale address, when Tailscale is connected. */
function tailscaleAddress(interfaces = os.networkInterfaces()) {
  const candidates = ipv4Addresses(interfaces).filter((each) => isTailscaleAddress(each.address));

  return (candidates.find((each) => /tailscale|utun|tun/i.test(each.name)) ?? candidates[0])
    ?.address;
}

/**
 * The address the server listens on. A tunnel reaches it on this machine, so
 * only the local-network mode opens it to other machines directly, and
 * Tailscale opens it to the tailnet only.
 */
function bindHost(mode, interfaces = os.networkInterfaces()) {
  if (mode === "lan") {
    return "0.0.0.0";
  }

  if (mode === "tailscale") {
    return tailscaleAddress(interfaces) ?? "127.0.0.1";
  }

  return "127.0.0.1";
}

// ─── The saved choice ───────────────────────────────────────────────────

function accessSettingsPath(dataDir) {
  return path.join(dataDir, "access.json");
}

/** The last chosen mode from `<agentDir>/pi-web/access.json`, if any. */
function loadAccessSettings(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(accessSettingsPath(dataDir), "utf8"));
    return isAccessMode(parsed?.access) ? { access: parsed.access } : {};
  } catch {
    return {};
  }
}

function saveAccessSettings(dataDir, mode) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${accessSettingsPath(dataDir)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ access: mode })}\n`, { mode: 0o600 });
  fs.renameSync(temp, accessSettingsPath(dataDir));
}

// ─── Choosing a mode ────────────────────────────────────────────────────

/**
 * The mode to start in. One that is not ready (Tailscale not connected, no
 * cloudflared) goes back to the menu when it came from there. One from
 * `--access`, `-y`, or the last choice without a terminal ends the start:
 * asking nobody again would only try the same mode again, forever.
 *
 * `prepare(mode)` returns true when ready, false when not, or a string (the
 * cloudflared binary to run). The result mirrors that.
 */
async function chooseAccess(choice) {
  let mode = choice.given;

  for (;;) {
    const fromMenu = mode === undefined && choice.ask;

    if (mode === undefined) {
      mode = fromMenu ? await choice.menu(choice.saved) : (choice.saved ?? "local");

      if (mode === undefined) {
        return "closed";
      }
    }

    const ready = await choice.prepare(mode);

    if (ready !== false) {
      return typeof ready === "string" ? { mode, binary: ready } : { mode };
    }

    if (!fromMenu) {
      return "unready";
    }

    mode = undefined;
  }
}

// ─── cloudflared ────────────────────────────────────────────────────────

function findExecutable(name, extraDirectories, env = process.env) {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];

  for (const directory of [...(env.PATH ?? "").split(delimiter), ...extraDirectories]) {
    if (directory === "") {
      continue;
    }

    for (const each of names) {
      const file = path.join(directory, each);

      try {
        fs.accessSync(file, fs.constants.X_OK);

        return file;
      } catch {
        // keep looking
      }
    }
  }

  return undefined;
}

/** cloudflared from PATH, or the copy the launcher downloaded into the data folder. */
function findCloudflared(dataDir, env = process.env) {
  return findExecutable("cloudflared", [path.join(dataDir, "bin")], env);
}

/** Where to get cloudflared on this platform: a release binary the launcher can download, or how to install it. */
function cloudflaredSource(platform = process.platform, arch = process.arch) {
  const archName = (
    { x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" }
  )[arch];

  if (platform === "linux" && archName !== undefined) {
    return {
      url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${archName}`,
    };
  }

  if (platform === "android") {
    return { install: "pkg install cloudflared" };
  }

  if (platform === "darwin") {
    return { install: "brew install cloudflared" };
  }

  if (platform === "win32") {
    return { install: "winget install --id Cloudflare.cloudflared" };
  }

  return {
    install: "see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  };
}

/** Download Cloudflare's release binary into `<data>/bin/cloudflared` and check that it runs. */
async function downloadCloudflared(
  dataDir,
  url,
  progress,
  fetchImpl = fetch,
  runVersionCheck = (file) => spawnSync(file, ["--version"], { encoding: "utf8", timeout: 20_000 }),
) {
  const directory = path.join(dataDir, "bin");

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "cloudflared");
  const temp = `${target}.download`;
  // Give up when no data arrives for a minute: a stalled connection must not hang the launcher. Slow is fine.
  const controller = new AbortController();
  let idle;

  const wait = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error("the download stalled")), 60_000);
  };

  wait();
  const out = fs.createWriteStream(temp, { mode: 0o755 });
  let done = 0;

  try {
    const response = await fetchImpl(url, { signal: controller.signal });

    if (!response.ok || response.body === null) {
      throw new Error(`download failed: HTTP ${response.status}`);
    }

    const total = Number(response.headers.get("content-length") ?? 0);

    for await (const chunk of response.body) {
      wait();
      done += chunk.length;

      if (!out.write(chunk)) {
        await once(out, "drain");
      }

      progress(done, total);
    }

    await new Promise((resolve, reject) =>
      out.end((error) => (error ? reject(error) : resolve())),
    );
  } catch (error) {
    out.destroy();
    fs.rmSync(temp, { force: true });

    throw error;
  } finally {
    clearTimeout(idle);
  }

  fs.chmodSync(temp, 0o755);
  const check = runVersionCheck(temp);

  if (check.status !== 0) {
    fs.rmSync(temp, { force: true });

    throw new Error("the downloaded cloudflared does not run on this machine");
  }

  fs.renameSync(temp, target);

  return target;
}

// ─── The tunnel ─────────────────────────────────────────────────────────

/**
 * A Cloudflare quick tunnel: a random https://….trycloudflare.com address, no
 * account needed. The address is new for every cloudflared process, so the
 * launcher keeps one running across server restarts and restarts the Next.js
 * server when a restart changes the address (pi-web allows exact host names
 * only). Its log goes to `logFile`, mode 0600: cloudflared logs request
 * addresses, which can include a sign-in token.
 */
class CloudflareTunnel {
  #binary;
  #port;
  #logFile;
  #events;
  #child = undefined;
  url = undefined;

  constructor(binary, port, logFile, events) {
    this.#binary = binary;
    this.#port = port;
    this.#logFile = logFile;
    this.#events = events;
  }

  start() {
    fs.appendFileSync(this.#logFile, `\n--- ${new Date().toISOString()} starting cloudflared\n`, {
      mode: 0o600,
    });
    fs.chmodSync(this.#logFile, 0o600);
    const child = spawn(
      this.#binary,
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.#port}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.#child = child;
    let candidate;

    const onLine = (line) => {
      fs.appendFileSync(this.#logFile, `${line}\n`);
      candidate ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];

      if (
        this.url === undefined &&
        candidate !== undefined &&
        /Registered tunnel connection/i.test(line)
      ) {
        this.url = candidate;
        this.#events.ready(candidate);
      } else if (
        (/\sERR\s/.test(line) || /failed to (request|create) quick tunnel/i.test(line)) &&
        // A browser closing a request (a reload, a long poll it gave up on) is routine, not a tunnel problem.
        !/context canceled|canceled by remote|ended abruptly/i.test(line)
      ) {
        this.#events.problem(line.replace(/^\S+\s+ERR\s+/, ""));
      }
    };

    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", onLine);
    }

    child.on("error", (error) => this.#events.problem(error.message));
    // "close", not "exit": a cloudflared that could not be started (removed, not executable) never exits.
    child.on("close", (code) => {
      if (this.#child === child) {
        this.#child = undefined;
      }

      this.#events.exit(code);
    });
  }

  async stop() {
    const child = this.#child;

    this.#child = undefined;

    if (child === undefined || child.exitCode !== null) {
      return;
    }

    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);

    await once(child, "exit").catch(() => {});
    clearTimeout(timer);
  }

  /** Synchronous stop for process-exit handlers: SIGTERM, then a hard kill. */
  killSync() {
    const child = this.#child;

    if (child === undefined) {
      return;
    }
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }
}

module.exports = {
  ACCESS_LABELS,
  ACCESS_MODES,
  CloudflareTunnel,
  bindHost,
  chooseAccess,
  cloudflaredSource,
  downloadCloudflared,
  findCloudflared,
  isAccessMode,
  isTailscaleAddress,
  lanAddresses,
  loadAccessSettings,
  saveAccessSettings,
  tailscaleAddress,
};
