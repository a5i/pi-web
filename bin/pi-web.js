#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { once } = require("events");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets, getRotationWarning } = require("./rotate-preview-secrets");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openInBrowser } = require("./browser-opener");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir } = require("./run-records");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getTokenDataDir, getTokenFilePath, readOrCreateToken, rotateTokenFile } = require("./pi-web-token");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { signInLinkUrls } = require("./sign-in-links");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureProductionBuild } = require("./ensure-build");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const term = require("./term");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const access = require("./access");
const {
  ACCESS_LABELS,
  CloudflareTunnel,
  bindHost,
  chooseAccess,
  cloudflaredSource,
  downloadCloudflared,
  findCloudflared,
  lanAddresses,
  loadAccessSettings,
  saveAccessSettings,
  tailscaleAddress,
  tailscaleDnsName,
} = access;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require("./pi-web-commands");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("net");

/**
 * Whether something already listens on host:port, checked by connecting: a
 * free port refuses the connection at once. A timeout counts as free, so a
 * filtered path never blocks a rebuild for longer than the probe.
 */
function portInUse(hostname, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === "start") {
  startServer(launchOptions).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else {
  runCommand(launchOptions).then(
    exitWhenIdle,
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      exitWhenIdle(1);
    },
  );
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

async function startServer({
  port,
  hostname: givenHostname,
  hostnameExplicit,
  openBrowser,
  tokenAuth,
  rotateToken,
  tokenFile,
  access: givenAccess,
  yes,
}) {

  const pkgDir = path.join(__dirname, "..");
  const nextDir = path.join(pkgDir, ".next");

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  try {
    nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    // Fallback: locate next package root and derive the bin path manually.
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }

  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

  // ─── How devices reach pi-web: a menu, the saved choice, or an explicit hostname ───
  let mode;
  let cloudflaredBinary;
  // The tailnet name "tailscale-https" serves: the Host to allow and the
  // https address the links print.
  let serveDnsName;
  if (!hostnameExplicit) {
    const dataDir = getTokenDataDir(process.env);
    const saved = loadAccessSettings(dataDir).access;
    const ask = term.interactive && !yes;
    if (ask) {
      console.log("");
      console.log(`  ${term.accent("◆")} ${term.bold("Pi Web")}  ${term.dim(term.tilde(pkgDir))}`);
      console.log("");
    }
    const chosen = await chooseAccess({
      given: givenAccess,
      saved,
      ask,
      menu: (current) => pickAccessMode(current, port, dataDir),
      prepare: (each) => prepareAccessMode(each, dataDir),
    });
    if (chosen === "closed") {
      term.restoreTerminal();
      process.exit(0);
    }
    if (chosen === "unready") {
      term.restoreTerminal();
      console.error(
        givenAccess !== undefined || yes
          ? "Fix the problem above, or start without --access to pick another access mode."
          : "Fix the problem above, or pick another access mode.",
      );
      process.exit(1);
    }
    mode = chosen.mode;
    cloudflaredBinary = mode === "cloudflare" ? chosen.binary : undefined;
    serveDnsName = mode === "tailscale-https" ? chosen.binary : undefined;
    saveAccessSettings(dataDir, mode);
    if (ask) {
      console.log(`  Starting Pi Web (${ACCESS_LABELS[mode]})…`);
      console.log("");
    }
  }
  const hostname = hostnameExplicit ? givenHostname : bindHost(mode);

  // `next start` refuses to serve without a production build. A source
  // checkout (`.next` empty or dev-only, or its build older than the
  // sources) builds one here; an install whose shipped `.next` went missing
  // cannot, and keeps the old hard error. A rebuild is skipped when another
  // server already holds the port: `next build` writes into the same `.next`
  // a dev server may be serving from.
  try {
    const ensured = await ensureProductionBuild({
      nextDir,
      pkgDir,
      runBuild: (args) => spawnSync(process.execPath, getNextNodeArgs(nextBin, args), {
        cwd: pkgDir,
        stdio: "inherit",
      }),
      canBuild: async () => {
        if (!(await portInUse(hostname, port))) return true;
        console.warn(
          `Another server already listens on ${hostname}:${port}; not rebuilding — stop it first to pick up source changes.`,
        );
        return false;
      },
    });
    if (ensured.reason === "no-source") {
      console.error("Build artifacts not found. Please report this issue.");
      process.exit(1);
    }
  } catch (error) {
    console.error(`Could not build pi-web: ${error.message}`);
    process.exit(1);
  }

  // The sign-in token (`--token`) is resolved before Next starts, so a broken
  // token file fails the launch here instead of producing an unusable secret.
  const tokenFilePath = tokenFile ?? getTokenFilePath(process.env);
  let token;
  if (tokenAuth) {
    try {
      if (rotateToken) {
        token = rotateTokenFile(tokenFilePath);
        console.log("Rotated the sign-in token; every link and device that used the old one is signed out.");
      } else {
        token = readOrCreateToken(tokenFilePath).token;
      }
    } catch (error) {
      console.error(`Could not ${rotateToken ? "rotate" : "read"} the sign-in token: ${error.message}`);
      process.exit(1);
    }
  }

  // Replace the published preview-mode secrets with fresh random values so the
  // previewModeId baked into the npm tarball cannot be used to skip the proxy
  // (via the x-prerender-revalidate header). Must happen before `next start`.
  const rotation = rotatePreviewSecrets(nextDir);
  if (!rotation.ok) {
    console.warn(getRotationWarning(rotation.reason));
  }

  if (!loopbackHostnames.has(hostname)) {
    if (tokenAuth) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with token sign-in over plain HTTP. Anyone who sees the link or sniffs this network can sign in; use HTTPS or a trusted VPN.`,
      );
    } else if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  // ─── The Cloudflare tunnel, up before the server so the host is allowed ───
  let tunnel;
  let tunnelUrl;
  if (mode === "cloudflare") {
    const logFile = path.join(getTokenDataDir(process.env), "cloudflared.log");
    const retry = { failures: 0, stopped: false };
    tunnel = new CloudflareTunnel(cloudflaredBinary, port, logFile, {
      ready(url) {
        const changed = tunnelUrl !== undefined && tunnelUrl !== url;
        tunnelUrl = url;
        retry.failures = 0;
        console.log(`  ✓ Tunnel is up${changed ? " at a new address" : ""}: ${url}`);
        if (changed) void restartNext(url);
      },
      problem(line) {
        console.warn(`  cloudflared: ${line}`);
      },
      exit(code) {
        if (retry.stopped) {
          return;
        }
        retry.failures += 1;
        const delay = Math.min(60, 2 ** retry.failures) * 1000;
        console.warn(
          `  The tunnel stopped (code ${code}); trying again in ${delay / 1000} seconds. Log: ${term.tilde(logFile)}`,
        );
        setTimeout(() => tunnel.start(), delay);
      },
    });
    process.once("exit", () => {
      retry.stopped = true;
      tunnel.killSync();
    });
    tunnel.start();
    tunnelUrl = await waitForTunnelUrl(tunnel, 45_000);
    if (tunnelUrl === undefined) {
      console.error("The Cloudflare tunnel did not come up. Check the messages above, or start with --access local.");
      tunnel.killSync();
      process.exit(1);
    }
  }

  // ─── tailscale serve: the https front for the loopback-bound server ───
  // ─── tailscale serve: the https front for the loopback-bound server ───
  let tailscaleServeUp = false;
  if (mode === "tailscale-https") {
    // A proxy left by an earlier run, or set up manually (with sudo, before
    // `tailscale set --operator`), is as good as one we start: the status
    // listing names it. Only a listing without our port calls for a setup.
    const existing = spawnSync("tailscale", ["serve", "status"], { encoding: "utf8", timeout: 30_000 });
    if (existing.status === 0 && /proxy/i.test(existing.stdout) && existing.stdout.includes(`:${port}`)) {
      tailscaleServeUp = true;
      console.log(`  ✓ Tailscale HTTPS is up: https://${serveDnsName}`);
    } else {
      const serve = spawnSync("tailscale", ["serve", "--bg", String(port)], { encoding: "utf8", timeout: 30_000 });
      if (serve.status === 0) {
        tailscaleServeUp = true;
        console.log(`  ✓ Tailscale HTTPS is up: https://${serveDnsName}`);
      } else {
        // tailscale's own stderr carries the exact remedy for most failures
        // (an operator hint for a permission denial, an admin-console link for
        // a disabled HTTPS), so it is shown whole rather than paraphrased.
        const reason = (serve.stderr ?? "").trim();
        console.error(term.yellow(
          `  tailscale serve did not start${reason ? `:\n    ${reason.split("\n").join("\n    ")}` : "."}\n`
          + `  Fix Tailscale and run this again, or pick another access mode (--access local, lan, tailscale or cloudflare).`
          + (/\b(?:https|magicdns|certificat)/i.test(reason)
            ? " MagicDNS and HTTPS Certificates must be enabled in the Tailscale admin console."
            : ""),
        ));
        // The mode promises an https address: without serve the launch must
        // not go on and quietly serve plain http.
        process.exit(1);
      }
    }
  }

  const nextArgs = ["start", "-p", port];
  nextArgs.push("-H", hostname);

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const restartState = { restarting: false };
  let child;

  function startNext() {
    const env = { ...process.env, PI_WEB_HOSTNAME: hostname };
    // In token mode the generated token is the password: every existing
    // check (cookie signature, Basic Auth, throttle, MCP env sanitization)
    // covers it, and the parser has refused a manually set PI_WEB_PASSWORD.
    if (tokenAuth) env.PI_WEB_PASSWORD = token;
    // The proxy allows exact host names only, so the tunnel's host has to be
    // allowed before its first request can pass. A restarted tunnel gets a
    // new address; restartNext() respawns the server with it.
    if (tunnelUrl !== undefined) {
      env.PI_WEB_ALLOWED_HOSTS = [env.PI_WEB_ALLOWED_HOSTS, new URL(tunnelUrl).hostname]
        .filter(Boolean)
        .join(",");
    }
    if (serveDnsName !== undefined) {
      env.PI_WEB_ALLOWED_HOSTS = [env.PI_WEB_ALLOWED_HOSTS, serveDnsName]
        .filter(Boolean)
        .join(",");
    }
    child = spawn(process.execPath, getNextNodeArgs(nextBin, nextArgs), {
      cwd: pkgDir,
      stdio: ["inherit", "pipe", "inherit"],
      env,
    });
    wireChildProcessLifecycle(child, process, undefined, console.error, restartState);
    child.stdout.on("data", onNextStdout);
    // When the server goes, the launcher follows it: take the tunnel along,
    // or cloudflared's pipes would hold this process open forever. A planned
    // restart (restartNext) spawns a replacement and keeps the tunnel.
    child.once("exit", () => {
      if (!restartState.restarting && tunnel !== undefined) {
        void tunnel.stop();
      }
    });
  }

  async function restartNext(newTunnelUrl) {
    if (child === undefined || restartState.restarting) {
      return;
    }
    restartState.restarting = true;
    console.log("  Restarting the server for the tunnel's new address…");
    const outgoing = child;
    outgoing.kill("SIGTERM");
    await once(outgoing, "exit").catch(() => {});
    restartState.restarting = false;
    tunnelUrl = newTunnelUrl;
    startNext();
  }

  startNext();

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      nextPid: child.pid,
      port: Number(port),
      hostname,
      url: mode === "tailscale-https" && tailscaleServeUp && serveDnsName !== undefined
        ? `https://${serveDnsName}`
        : getOpenUrl(hostname, port),
      // Says where the token file lives (never the token), so `pi-web open`
      // can read the same file and open the sign-in link.
      ...(tokenAuth ? { tokenAuth: tokenFilePath } : {}),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString(),
    },
  });

  let serverReady = false;
  const url = `http://${hostname}:${port}`;

  function onNextStdout(chunk) {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!text.includes("Ready")) return;
    if (port !== "0") runRecord.markReady();
    if (!tokenAuth) {
      if (!serverReady && openBrowser) openInBrowser(url);
      serverReady = true;
      return;
    }
    // In token mode the browser opens the sign-in link, so the first browser
    // is signed in at once; the console keeps a copy for the others. A server
    // restarted for a new tunnel address prints its links again.
    const { links, qrUrl } = signInLinksForMode();
    printSignInLinks(links, qrUrl);
    if (!serverReady && openBrowser) openInBrowser(links[0]);
    serverReady = true;
  }

  function signInLinksForMode() {
    const { loopback, lan } = signInLinkUrls(hostname, port, token);
    if (mode === "cloudflare" && tunnelUrl !== undefined) {
      return { links: [`${tunnelUrl}/login?token=${token}`, loopback], qrUrl: `${tunnelUrl}/login?token=${token}` };
    }
    if (mode === "tailscale-https" && tailscaleServeUp && serveDnsName !== undefined) {
      const httpsLink = `https://${serveDnsName}/login?token=${token}`;
      return { links: [httpsLink, loopback], qrUrl: httpsLink };
    }
    const links = [loopback, ...lan];
    return { links, qrUrl: lan[0] ?? loopback };
  }
}

// Prints the links and a QR of the address another device reaches (the
// tunnel's or the LAN one; the loopback one when nothing else is listed). A
// missing or broken qrcode package only skips the QR — the plain links
// always work.
function printSignInLinks(links, qrUrl) {
  console.log("");
  console.log("Open one of these once per browser to sign in (the link is the key — keep it private):");
  for (const link of links) {
    console.log(`  ${link}`);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require("qrcode");
    QRCode.toString(qrUrl, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "L",
    }).then(
      (qr) => process.stdout.write(`\n${qr}\n`),
      () => {},
    );
  } catch {
    // qrcode is an optional convenience for the launcher only.
  }
  return links;
}

// ─── The access menu ────────────────────────────────────────────────────

/** The menu entries: one per access mode, unready ones shown but disabled. */
function accessChoices(port, dataDir) {
  const lan = lanAddresses()[0];
  const tailnet = tailscaleAddress();
  const cloudflared = findCloudflared(dataDir);
  const source = cloudflaredSource();

  const lanChoice = lan === undefined
    ? { label: ACCESS_LABELS.lan, detail: "no network connection found", disabled: true }
    : { label: ACCESS_LABELS.lan, detail: `http://${lan}:${port} · same Wi-Fi, not encrypted` };

  const cloudflareChoice = cloudflared !== undefined
    ? { label: ACCESS_LABELS.cloudflare, detail: "public https link" }
    : "url" in source
      ? { label: ACCESS_LABELS.cloudflare, detail: "public https link · downloads cloudflared first" }
      : { label: ACCESS_LABELS.cloudflare, detail: `install cloudflared first: ${source.install}`, disabled: true };

  const tailscaleChoice = tailnet === undefined
    ? { label: ACCESS_LABELS.tailscale, detail: "not connected", disabled: true }
    : { label: ACCESS_LABELS.tailscale, detail: `http://${tailnet}:${port} · your tailnet only` };

  const tailscaleDns = tailnet === undefined ? undefined : tailscaleDnsName();
  const tailscaleHttpsChoice = tailnet === undefined
    ? { label: ACCESS_LABELS.tailscaleHttps, detail: "not connected", disabled: true }
    : tailscaleDns === undefined
      ? { label: ACCESS_LABELS.tailscaleHttps, detail: "no MagicDNS name — enable it in the Tailscale admin console", disabled: true }
      : { label: ACCESS_LABELS.tailscaleHttps, detail: `https://${tailscaleDns} · your tailnet only` };

  return [
    { mode: "local", choice: { label: ACCESS_LABELS.local, detail: `http://127.0.0.1:${port}` } },
    { mode: "lan", choice: lanChoice },
    { mode: "cloudflare", choice: cloudflareChoice },
    { mode: "tailscale", choice: tailscaleChoice },
    { mode: "tailscale-https", choice: tailscaleHttpsChoice },
  ];
}

async function pickAccessMode(current, port, dataDir) {
  const options = accessChoices(port, dataDir);
  const initial = Math.max(
    0,
    options.findIndex((each) => each.mode === current),
  );
  const picked = await term.choose(
    "How should your devices reach Pi Web?",
    options.map((each) => each.choice),
    initial,
  );

  return picked === undefined ? undefined : options[picked].mode;
}

/** Get `mode` ready; false (with a message above) when it cannot be used. */
async function prepareAccessMode(mode, dataDir) {
  if (mode === "lan" && lanAddresses().length === 0) {
    console.warn(term.yellow("  No network connection found."));
    return false;
  }

  if (mode === "tailscale" && tailscaleAddress() === undefined) {
    console.warn(term.yellow("  Tailscale is not connected."));
    return false;
  }

  if (mode === "tailscale-https") {
    if (tailscaleAddress() === undefined) {
      console.warn(term.yellow("  Tailscale is not connected."));
      return false;
    }
    const dns = tailscaleDnsName();
    if (dns === undefined) {
      console.warn(term.yellow("  No MagicDNS name for this machine. Enable MagicDNS and HTTPS Certificates in the Tailscale admin console."));
      return false;
    }
    return dns;
  }

  if (mode === "cloudflare") {
    return (await ensureCloudflared(dataDir)) ?? false;
  }

  return true;
}

/** cloudflared's path, downloading it first when the user agrees. */
async function ensureCloudflared(dataDir) {
  const found = findCloudflared(dataDir);
  if (found !== undefined) {
    return found;
  }

  const source = cloudflaredSource();

  if (!("url" in source)) {
    console.warn(term.yellow(`  cloudflared is not installed. Install it with: ${source.install}`));
    return undefined;
  }

  if (!term.interactive) {
    console.warn(
      term.yellow("  cloudflared is not installed. Install it, or run pi-web once in a terminal to download it."),
    );
    return undefined;
  }

  console.log("");
  const agreed = await term.confirm(
    `Download cloudflared (Cloudflare's official release, about 40 MB) to ${term.tilde(path.join(dataDir, "bin"))}?`,
    true,
  );

  if (!agreed) {
    return undefined;
  }

  let last = 0;

  try {
    const file = await downloadCloudflared(dataDir, source.url, (done, total) => {
      if (Date.now() - last < 120 && done !== total) {
        return;
      }

      last = Date.now();
      const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

      process.stdout.write(
        `\r  ${term.dim(`Downloading… ${mb(done)}${total ? ` / ${mb(total)}` : ""} MB`)}\x1b[K`,
      );
    });

    process.stdout.write(`\r  ${term.green("✓")} cloudflared is ready.\x1b[K\n`);

    return file;
  } catch (error) {
    process.stdout.write("\n");
    console.error(term.red(`  Could not download cloudflared: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
}

/** Poll the tunnel until it reports its address, or `timeoutMs` passes. */
function waitForTunnelUrl(tunnel, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (tunnel.url !== undefined) {
        clearInterval(poll);
        resolve(tunnel.url);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        resolve(undefined);
      }
    }, 250);
  });
}
