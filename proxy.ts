import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  createWebSessionToken,
  isValidBasicAuthorization,
  isValidWebPassword,
  isValidWebSessionToken,
  isWebPasswordEnabled,
  isSecureWebRequest,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
} from "@/lib/web-auth";
import { safeLoginDestination } from "@/lib/login-destination";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

/**
 * Sign a browser in from a link (`/login?token=…`, printed by `pi-web --token`).
 * The token is checked exactly like the login form's password, through the
 * shared throttle: the block runs before validation, a wrong token records a
 * failure and bounces to a bare /login without echoing the guess, and — like
 * Basic, unlike the form — a success never resets the counter, because
 * anything may fetch a link (terminal previews, link checkers) and each valid
 * fetch must not hand an interleaved guesser a fresh short block. A valid
 * token gets the session cookie on a redirect to a clean URL, so the token
 * leaves the address bar (and the back-button history) immediately.
 */
function signInWithToken(request: NextRequest, token: string, password: string): NextResponse {
  const retryAfterMs = getAuthRetryAfterMs();
  if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);

  if (!isValidWebPassword(token, password)) {
    recordAuthFailure();
    return NextResponse.redirect(new URL("/login", request.url), 303);
  }

  const destination = safeLoginDestination(
    request.nextUrl.searchParams.get("next"),
    new URL(request.url).origin,
  );
  const response = NextResponse.redirect(new URL(destination, request.url), 303);
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: createWebSessionToken(password),
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureWebRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
  return response;
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Every Basic header is a password guess, so it shares the login form's
    // throttle; otherwise any API path (or GET /api/web-auth) answers guesses
    // at full speed. While blocked even the right password is refused, or the
    // answer would leak. A success does not reset the counter: Basic clients
    // authenticate on every request, and each reset would hand an interleaved
    // guesser a fresh short block.
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization, password);
    if (!authenticated) recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    if (authenticated) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    // A sign-in link printed by `pi-web --token`. Validated below through the
    // shared throttle — this branch sits above the /api/web-auth exemption,
    // so the link is no unthrottled password oracle — and the reply is always
    // a redirect to a URL without the token.
    const token = request.nextUrl.searchParams.get("token");
    if (token !== null) {
      return signInWithToken(request, token, password);
    }
    return NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
