import { NavLink, Route, Routes } from "react-router-dom";

import { Landing } from "./routes/Landing";
import { Admin, Dashboard, Verify } from "./routes/routes";
import { ConnectButton } from "./wallet/ConnectButton";
import { NetworkBadge } from "./components/NetworkBadge";

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
    <div className="app">
      {/*
        First focusable element on the page. A keyboard user should not have to tab through
        the whole navigation on every route to reach the content.
      */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="app-header">
        <div className="shell app-header__inner">
          <NavLink to="/" className="brand" aria-label="TrustChain home">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-text">TrustChain</span>
          </NavLink>

          <nav className="app-nav" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  isActive ? "app-nav__link is-active" : "app-nav__link"
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="app-header__right">
            <span className="app-header__network">
              <NetworkBadge />
            </span>
            <ConnectButton />
          </div>
        </div>
      </header>

      <main id="main">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/verify" element={<Verify />} />
          {/*
            An unknown path is a real answer, not a redirect to the landing page — sending
            someone to the home page hides the fact that their link was wrong.
          */}
          <Route
            path="*"
            element={
              <section className="shell section">
                <h1>Page not found</h1>
                <p className="route-lead">That route does not exist. Try the navigation above.</p>
              </section>
            }
          />
        </Routes>
      </main>

      <footer className="app-footer">
        <div className="shell app-footer__inner">
          <span>TrustChain — decentralized identity, on-chain RBAC, NFT asset ownership.</span>
          {/*
            No second network badge here. Each one polls /network on its own timer, so a
            duplicate would double the request rate to say the same thing twice on one
            screen.
          */}
          <span className="mono app-footer__net">Built for SIH 2026</span>
        </div>
      </footer>
    </div>
  );
}
