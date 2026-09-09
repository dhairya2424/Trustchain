import { motion as fm } from "framer-motion";
import { FileClock, Coins, Users } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";

import { NetworkBadge } from "@/components/NetworkBadge";
import { useSession } from "@/api/queries";
import { useMotion } from "@/motion/MotionProvider";
import { cn } from "@/lib/utils";
import { ConnectButton } from "@/wallet/ConnectButton";

/**
 * Admin shell: a left rail, and whichever console the route selects.
 *
 * The active indicator is one element moved between items with a shared `layoutId` rather
 * than an outline redrawn on each. That is what makes it slide: Framer sees the same node
 * in a new position and animates the difference, which no amount of per-item CSS can do.
 * Under reduced motion the same element simply appears in place — still unambiguous, with
 * nothing travelling.
 *
 * The rail is not the authorization boundary and does not pretend to be. Every console
 * below re-checks with the API, and the API re-reads the chain; hiding a link would only
 * make an unauthorised action harder to find, not harder to perform.
 */

const SECTIONS = [
  { to: "/admin", end: true, label: "Audit log", icon: FileClock },
  { to: "/admin/mint", end: false, label: "Mint asset", icon: Coins },
  { to: "/admin/roles", end: false, label: "Roles", icon: Users },
] as const;

export function AdminLayout() {
  const motion = useMotion();
  const session = useSession();

  if (session.isError && session.error.isUnauthenticated) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-4 py-16 sm:px-6">
        <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-fg-faint">
          Mission control
        </p>
        <h1 className="mt-2 text-title">Admin console</h1>
        <div
          className="mt-8 flex flex-wrap items-center justify-between gap-5 rounded-lg border border-line bg-surface px-6 py-6"
          data-testid="admin-signin"
        >
          <p className="max-w-[52ch] text-[14px] text-fg-muted">
            The console acts on your behalf, so it needs to know who you are. Sign in with a wallet
            — every action here is signed by you and attributed to you on-chain.
          </p>
          <ConnectButton />
        </div>
      </section>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-fg-faint">
            Mission control
          </p>
          <h1 className="mt-2 text-title">Admin console</h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {session.data?.roles.map((role) => (
            <span
              key={role}
              className="rounded border border-line-strong px-2 py-0.5 font-mono text-[11.5px] text-fg-muted"
              data-testid="admin-role"
            >
              {role}
            </span>
          ))}
          <NetworkBadge />
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Admin sections" data-testid="admin-rail">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {SECTIONS.map((section) => (
              <li key={section.to}>
                <NavLink
                  to={section.to}
                  end={section.end}
                  className={({ isActive }) =>
                    cn(
                      "relative flex items-center gap-2.5 whitespace-nowrap rounded px-3 py-2 text-[13.5px] transition-colors",
                      isActive
                        ? "font-medium text-fg"
                        : "font-normal text-fg-muted hover:bg-hover/60 hover:text-fg",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        /*
                         * One element, shared across items by layoutId. Framer animates it
                         * between positions; a per-item border could only fade.
                         */
                        <fm.span
                          layoutId={motion.reduced ? undefined : "admin-rail-indicator"}
                          className="absolute inset-0 -z-10 rounded bg-hover"
                          transition={motion.transition("quick")}
                          data-testid="rail-indicator"
                        />
                      )}
                      <section.icon className="size-4 shrink-0" aria-hidden="true" />
                      {section.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>

          <p className="mt-6 hidden border-t border-line pt-4 text-[12px] leading-relaxed text-fg-faint lg:block">
            Every action here is signed in your wallet and recorded on-chain against your identity,
            not the relayer&rsquo;s.
          </p>
        </nav>

        {/*
          A div, not a <main>. The shell already owns the document's single main landmark,
          and nesting a second one leaves a screen-reader user navigating by landmark with
          two "main" regions and no way to tell which holds the content. axe flags this as
          landmark-no-duplicate-main; it was a real defect, not a lint preference.
        */}
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
