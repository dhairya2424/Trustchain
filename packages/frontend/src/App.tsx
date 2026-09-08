import { NavLink, Route, Routes } from "react-router-dom";

import { NetworkBadge } from "./components/NetworkBadge";
import { Landing } from "./routes/Landing";
import { Dashboard } from "./routes/Dashboard";
import { AdminLayout } from "./admin/AdminLayout";
import { AuditLog } from "./admin/AuditLog";
import { MintWizard } from "./admin/MintWizard";
import { RoleManager } from "./admin/RoleManager";
import { Verify } from "./routes/routes";
import { ConnectButton } from "./wallet/ConnectButton";
import { cn } from "@/lib/utils";

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
  return (
    <div className="flex min-h-screen flex-col">
      {/*
        First focusable element on the page. A keyboard user should not have to tab through
        the whole navigation on every route to reach the content.
      */}
      <a
        href="#main"
        className="absolute left-3 top-0 z-100 -translate-y-full rounded-b bg-fg px-4 py-2 text-[13px] font-medium text-base transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-line bg-base/85 backdrop-blur-md">
        <div className="mx-auto flex min-h-15 w-full max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
          <NavLink
            to="/"
            className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-fg"
            aria-label="TrustChain home"
          >
            {/* A drawn mark, not a gradient chip: two linked squares, offset. */}
            <span
              className="relative size-4 shrink-0 rounded-[2px] border border-fg-muted"
              aria-hidden="true"
            >
              <span className="absolute -bottom-1 -right-1 size-2.5 rounded-[1px] border border-fg-faint bg-base" />
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
                className={({ isActive }) =>
                  cn(
                    "rounded px-3 py-1.5 text-[13.5px] transition-colors",
                    // Weight as well as colour: "current" must not be carried by hue alone.
                    isActive
                      ? "bg-hover font-medium text-fg"
                      : "font-normal text-fg-muted hover:bg-hover/60 hover:text-fg",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 sm:ml-0">
            <span className="hidden lg:inline-flex">
              <NetworkBadge />
            </span>
            <ConnectButton />
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
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
              <section className="mx-auto w-full max-w-[1200px] px-4 py-20 sm:px-6">
                <h1 className="text-title">Page not found</h1>
                <p className="mt-3 max-w-[60ch] text-fg-muted">
                  That route does not exist. Try the navigation above.
                </p>
              </section>
            }
          />
        </Routes>
      </main>

      <footer className="mt-auto border-t border-line">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap justify-between gap-3 px-4 py-6 text-[12.5px] text-fg-faint sm:px-6">
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
