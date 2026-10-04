import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, sessionIsValid } from "./auth";

/** Call at the top of every page and Server Action: the proxy alone is not the security boundary. */
export async function requireSession(): Promise<void> {
  const store = await cookies();
  if (!sessionIsValid(store.get(SESSION_COOKIE)?.value)) redirect("/login");
}
