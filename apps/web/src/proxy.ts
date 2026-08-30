import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const COOKIE_NAME = "xyn_session";

export function proxy(request: NextRequest) {
  const localMode = process.env.LOCAL_MODE === "true" || !process.env.DATABASE_URL;
  if (localMode || request.cookies.has(COOKIE_NAME)) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("returnTo", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/",
    "/conversations/:path*",
    "/agents/:path*",
    "/automations/:path*",
    "/scheduling/:path*",
    "/security/:path*",
    "/briefings/:path*",
    "/memory/:path*",
    "/knowledge/:path*",
    "/integrations/:path*",
    "/settings/:path*",
    "/onboarding",
  ],
};
