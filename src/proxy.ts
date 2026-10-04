import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionIsValid } from "@/lib/auth";

export function proxy(request: NextRequest) {
  if (sessionIsValid(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
