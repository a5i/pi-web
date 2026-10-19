"use strict";

// Sign-in link URLs for `pi-web --token`: the loopback URL every launch can
// print, plus each LAN address when the server is bound to a wildcard. The
// link carries the owner's token, so it is the key itself — pi-pocket's rule:
// keep it private.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getOpenUrl } = require("./run-records");

function isWildcardBind(hostname) {
  return hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]";
}

/** The sign-in URLs to print: `{ loopback, lan }`, LAN only for wildcard binds. */
function signInLinkUrls(hostname, port, token, interfaces = os.networkInterfaces()) {
  const suffix = `/login?token=${token}`;
  const lan = [];

  if (isWildcardBind(hostname)) {
    // getOpenUrl() already brackets IPv6 loopback literals.
    for (const networks of Object.values(interfaces)) {
      for (const net of networks ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          lan.push(`http://${net.address}:${port}${suffix}`);
        }
      }
    }
  }

  return { loopback: getOpenUrl(hostname, port) + suffix, lan };
}

module.exports = { isWildcardBind, signInLinkUrls };
