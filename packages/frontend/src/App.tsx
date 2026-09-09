import { useQueryClient } from "@tanstack/react-query";
import { motion as fm } from "framer-motion";
import { NavLink, Route, Routes } from "react-router-dom";

import { NetworkBadge } from "./components/NetworkBadge";
import { Landing } from "./routes/Landing";
import { Dashboard } from "./routes/Dashboard";
import { AdminLayout } from "./admin/AdminLayout";
import { AuditLog } from "./admin/AuditLog";
import { MintWizard } from "./admin/MintWizard";
import { RoleManager } from "./admin/RoleManager";
import { Verify } from "./routes/Verify";
import { ConnectButton } from "./wallet/ConnectButton";
import { cn } from "@/lib/utils";
import { PageTransition } from "@/components/PageTransition";
import { prefetchRoute } from "@/api/prefetch";
import { useMotion } from "@/motion/MotionProvider";

/**
 * The app shell: a persistent header, the routed view, and a footer.
 *
 * The network badge lives in the header on every route rather than on a settings screen.
 * Which chain a record landed on decides whether a third party can verify it, and that is
 * not a detail to make someone go looking for.
 */

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/dashboard", label: "Dashboard", end: false },
  { to: "/admin", label: "Admin", end: false },
  { to: "/verify", label: "Verify", end: false },
] as const;

export default function App() {
  const motion = useMotion();
  const queryClient = useQueryClient();

  /*
   * Warm the destination while the pointer is still travelling.
   *
   * Bound to focus as well as hover, so a keyboard user tabbing the nav gets the same head
   * start a mouse user does — an optimisation that only helps people using a pointer is
   * half an optimisation.
   */
  const warm = (path: string) => () => prefetchRoute(queryClient, path);

  return (
    <div className="flex min-h-screen flex-col">
      {/*
        First focusable element on the page. A keyboard user should not have to tab through
        the whole navigation on every route to reach the content.
      */}
      <a
        href="#main"
        className="absolute left-3 top-0 z-100 -translate-y-full rounded-b bg-fg px-4 py-2 text-sm font-medium text-canvas transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="shell flex min-h-15 flex-wrap items-center gap-x-6 gap-y-2 py-2.5">
          <NavLink
            to="/"
            className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-fg"
            aria-label="TrustChain home"
          >
            {/* A drawn mark, not a gradient chip: two linked squares, offset. */}
            <span
              className="relative size-4 shrink-0 rounded-[2px] border border-fg-muted"
              aria-hidden="true"
            >
              <span className="absolute -bottom-1 -right-1 size-2.5 rounded-[1px] border border-fg-faint bg-canvas" />
            </span>
            TrustChain
          </NavLink>

          <nav
            className="order-3 flex w-full gap-0.5 sm:order-none sm:mr-auto sm:w-auto"
            aria-label="Primary"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onMouseEnter={warm(item.to)}
                onFocus={warm(item.to)}
                className={({ isActive }) =>
                  cn(
                    "relative rounded px-3 py-1.5 text-sm transition-colors",
                    // Weight as well as colour: "current" must not be carried by hue alone.
                    isActive
                      ? "font-medium text-fg"
                      : "font-normal text-fg-muted hover:bg-hover/60 hover:text-fg",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {/*
                      One pill, shared across the links.
                      
                      `layoutId` makes framer treat the indicator on the old link and the one
                      on the new link as the same element, so it slides between them instead
                      of blinking out and in. It is behind the label rather than around it,
                      so the text never moves — motion that shifts the thing you are reading
                      is worse than no motion at all.
                    */}
                    {isActive && (
                      <fm.span
                        layoutId="nav-active"
                        className="absolute inset-0 -z-10 rounded bg-hover"
                        aria-hidden="true"
                        transition={
                          motion.reduced
                            ? { duration: 0 }
                            : { type: "spring", stiffness: 420, damping: 34 }
                        }
                      />
                    )}
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 sm:ml-0">
            {/*
              A reserved width, so the header does not reflow when the badge resolves.
              Without it the chip grows from "Checking network…" to the network name and
              its verifiability, which rewraps the navigation and pushes the page down.
            */}
            <span className="hidden min-w-[19rem] justify-end lg:inline-flex">
              <NetworkBadge />
            </span>
            <ConnectButton />
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        <PageTransition>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/dashboard" element={<Dashboard />} />
            {/* Nested so the rail persists and only the console swaps. */}
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AuditLog />} />
              <Route path="mint" element={<MintWizard />} />
              <Route path="roles" element={<RoleManager />} />
            </Route>
            <Route path="/verify" element={<Verify />} />
            {/*
            An unknown path is a real answer, not a redirect to the landing page — sending
            someone to the home page hides the fact that their link was wrong.
          */}
            <Route
              path="*"
              element={
                <section className="shell py-12">
                  <h1 className="text-title">Page not found</h1>
                  <p className="mt-3 max-w-[60ch] text-fg-muted">
                    That route does not exist. Try the navigation above.
                  </p>
                </section>
              }
            />
          </Routes>
        </PageTransition>
      </main>

      <footer className="mt-auto border-t border-line">
        <div className="shell flex flex-wrap justify-between gap-3 py-6 text-xs text-fg-faint">
          <span>TrustChain — decentralized identity, on-chain RBAC, NFT asset ownership.</span>
          {/*
            No second network badge here. Each one polls /network on its own timer, so a
            duplicate would double the request rate to say the same thing twice on one
            screen.
          */}
          <span className="font-mono">Built for SIH 2026</span>
        </div>
      </footer>
    </div>
  );
}
