import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import "./index.css";
import { configured, SessionContext, supabase, useSession } from "./lib";
import AuthPage from "./pages/AuthPage";
import Dashboard from "./pages/Dashboard";
import SitePage from "./pages/SitePage";
import Settings from "./pages/Settings";
import Profile from "./pages/Profile";
import Stats from "./pages/Stats";

function SetupNeeded() {
  return (
    <div className="mx-auto mt-24 max-w-lg rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-xl font-semibold">Connect your Supabase project</h1>
      <p className="mt-3 text-sm text-slate-600">
        Copy <code className="rounded bg-slate-100 px-1">.env.example</code> to{" "}
        <code className="rounded bg-slate-100 px-1">.env</code>, paste your Supabase URL and anon key, then restart{" "}
        <code className="rounded bg-slate-100 px-1">npm run dev</code>. The full steps are in README.md.
      </p>
    </div>
  );
}

function Shell() {
  const session = useSession();
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"}`;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5">
          <Link to="/" className="mr-3 flex items-center gap-2 font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-sm text-white">A</span>
            <span className="hidden sm:inline">AffiliWriter</span>
          </Link>
          <NavLink to="/" end className={link}>Dashboard</NavLink>
          <NavLink to="/stats" className={link}>Statistics</NavLink>
          <NavLink to="/settings" className={link}>Settings</NavLink>
          <div className="ml-auto flex items-center gap-1">
            <NavLink to="/profile" className={link}>
              <span className="hidden sm:inline">{session.user.email}</span>
              <span className="sm:hidden">Profile</span>
            </NavLink>
            <button
              // "local": log out here only, so other devices and tabs stay signed in.
              onClick={() => supabase.auth.signOut({ scope: "local" })}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sites/:id" element={<SitePage />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!configured) return <SetupNeeded />;
  if (session === undefined) return null;
  if (!session) return <AuthPage />;
  return (
    <SessionContext.Provider value={session}>
      <Shell />
    </SessionContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
