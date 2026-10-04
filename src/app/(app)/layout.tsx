import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/actions";
import { requireSession } from "@/lib/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <header className="flex items-center justify-between border-b border-line py-4">
        <Link href="/" className="text-base font-semibold tracking-tight">
          jobspy
        </Link>
        <nav className="flex items-center gap-5 text-sm text-mute">
          <Link href="/" className="hover:text-ink">Companies</Link>
          <Link href="/jobs" className="hover:text-ink">Jobs</Link>
          <Link href="/settings" className="hover:text-ink">Settings</Link>
          <form action={logout}>
            <button type="submit" className="hover:text-ink">Sign out</button>
          </form>
        </nav>
      </header>
      <main className="pt-8">{children}</main>
    </div>
  );
}
