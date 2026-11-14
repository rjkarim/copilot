import { useState } from "react";
import { Link } from "react-router-dom";
import { sleepLabel, supabase, syncSite, useLive, type Site } from "../lib";
import { Button, Card, ConfirmDialog, LiveStatus, Notice, type ConfirmRequest } from "../ui";
import WebsiteForm from "./WebsiteForm";

type View = "cards" | "list";

export default function Dashboard() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>(() => {
    try {
      return (localStorage.getItem("view") as View) || "cards";
    } catch {
      return "cards";
    }
  });
  const [form, setForm] = useState<{ site?: Site } | null>(null);
  const [syncing, setSyncing] = useState("");
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  async function load() {
    const { data, error } = await supabase.from("website_overview").select("*").order("created_at");
    if (error) setError(`${error.message} — has the database setup SQL been run? See README.md.`);
    else if (data.length > 0 && data[0].has_amazon_keys === undefined) {
      setError("Database update needed: run supabase/migrations/003_site_amazon_and_categories.sql in the Supabase SQL Editor, then reload.");
      setSites(data as Site[]);
    } else {
      setError("");
      setSites(data as Site[]);
    }
  }
  useLive(load, "dashboard");

  function changeView(v: View) {
    setView(v);
    try {
      localStorage.setItem("view", v);
    } catch {
      /* private mode */
    }
  }
  async function togglePause(s: Site) {
    await supabase.from("websites").update({ paused: !s.paused }).eq("id", s.id);
    load();
  }
  async function sync(s: Site) {
    setSyncing(s.id);
    await syncSite(s.id);
    setSyncing("");
    load();
  }
  function remove(s: Site) {
    setAsk({
      title: `Delete ${s.name}?`,
      message: "This removes the website and all of its keywords and articles from this app. It cannot be undone.\n\nPosts already on the WordPress site are not touched.",
      label: "Delete website",
      run: async () => {
        const { error } = await supabase.from("websites").delete().eq("id", s.id);
        await load();
        return error?.message ?? null;
      },
    });
  }

  const sum = (k: "queued" | "writing" | "completed" | "failed" | "wp_published" | "wp_drafts") =>
    (sites ?? []).reduce((n, s) => n + (s[k] ?? 0), 0);
  const stats = [
    { label: "Websites", value: sites?.length ?? 0 },
    { label: "Published", value: sum("wp_published") },
    { label: "Drafts", value: sum("wp_drafts") },
    { label: "In queue", value: sum("queued") },
    { label: "Writing now", value: sum("writing") },
    { label: "Failed", value: sum("failed") },
  ];

  const actions = (s: Site) => (
    <div className="flex flex-wrap gap-1.5">
      <Link to={`/sites/${s.id}`}>
        <Button>Keywords &amp; articles</Button>
      </Link>
      <Button variant="ghost" onClick={() => togglePause(s)}>{s.paused ? "Resume" : "Pause"}</Button>
      <Button variant="ghost" onClick={() => sync(s)} disabled={syncing === s.id}>
        {syncing === s.id ? "Syncing…" : "Sync"}
      </Button>
      <Button variant="ghost" onClick={() => setForm({ site: s })}>Edit</Button>
      <Button variant="danger" onClick={() => remove(s)}>Delete</Button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
            {(["cards", "list"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => changeView(v)}
                className={`rounded-md px-3 py-1 font-medium capitalize ${view === v ? "bg-indigo-600 text-white" : "text-slate-600"}`}
              >
                {v}
              </button>
            ))}
          </div>
          <Button onClick={() => setForm({})}>+ Add website</Button>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Card key={s.label} className="px-4 py-3">
            <div className="text-xs text-slate-500">{s.label}</div>
            <div className="mt-0.5 text-2xl font-semibold tabular-nums">{s.value}</div>
          </Card>
        ))}
      </div>

      {sites && sites.length === 0 && (
        <Card className="p-10 text-center">
          <h2 className="font-semibold">Add your first website</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Connect a WordPress site with its own Amazon tracking ID, then paste a list of keywords. Articles are
            written one by one in the background, even after you log out.
          </p>
          <Button className="mt-4" onClick={() => setForm({})}>+ Add website</Button>
        </Card>
      )}

      {sites && sites.length > 0 && view === "cards" && (
        <div className="grid gap-4 md:grid-cols-2">
          {sites.map((s) => (
            <Card key={s.id} className="flex flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link to={`/sites/${s.id}`} className="block truncate font-semibold hover:text-indigo-600">
                    {s.name}
                  </Link>
                  <a href={s.url} target="_blank" rel="noreferrer" className="block truncate text-sm text-slate-500 hover:underline">
                    {s.url.replace(/^https?:\/\//, "")}
                  </a>
                </div>
                <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                  {s.tracking_id || "no tracking ID"}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Num label="Published" value={s.wp_published} tone="text-emerald-600" />
                <Num label="Drafts" value={s.wp_drafts} tone="text-slate-700" />
                <Num label="In queue" value={s.queued} tone="text-sky-600" />
                <Num label="Failed" value={s.failed} tone={s.failed ? "text-red-600" : "text-slate-400"} />
              </div>
              <LiveStatus site={s} />
              {s.wp_error && <Notice kind="error">WordPress: {s.wp_error}</Notice>}
              {!s.has_amazon_keys && (
                <div className="text-xs text-amber-600">
                  No Amazon Creators API credentials yet — click Edit to add them (needed for review articles).
                </div>
              )}
              {(s.update_enabled || s.updates_done > 0) && (
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span className={`inline-block h-2 w-2 rounded-full ${s.update_enabled ? "animate-pulse bg-emerald-500" : "bg-slate-300"}`} />
                  Old-post updater {s.update_enabled ? "running" : "stopped"} · {s.updates_done} updated
                  {s.update_keyword ? ` · now: ${s.update_keyword}` : ""}
                </div>
              )}
              <div className="text-xs text-slate-500">
                {s.completed} written by AffiliWriter · posts as {s.post_status === "publish" ? "published" : "draft"} · sleep{" "}
                {sleepLabel(s.sleep_seconds)} · {s.marketplace.replace("www.", "")}
              </div>
              {actions(s)}
            </Card>
          ))}
        </div>
      )}

      {sites && sites.length > 0 && view === "list" && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Website</th>
                <th className="px-3 py-2.5">Tracking ID</th>
                <th className="px-3 py-2.5 text-right">Published</th>
                <th className="px-3 py-2.5 text-right">Drafts</th>
                <th className="px-3 py-2.5 text-right">Queue</th>
                <th className="px-3 py-2.5 text-right">Failed</th>
                <th className="w-64 px-3 py-2.5">Live status</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sites.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <Link to={`/sites/${s.id}`} className="font-medium hover:text-indigo-600">{s.name}</Link>
                    <div className="text-xs text-slate-500">{s.url.replace(/^https?:\/\//, "")}</div>
                    {s.wp_error && <div className="mt-0.5 text-xs text-red-600">WordPress: {s.wp_error}</div>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{s.tracking_id || "—"}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{s.wp_published ?? "—"}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{s.wp_drafts ?? "—"}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{s.queued}</td>
                  <td className={`px-3 py-3 text-right tabular-nums ${s.failed ? "text-red-600" : ""}`}>{s.failed}</td>
                  <td className="px-3 py-3"><LiveStatus site={s} /></td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-1.5">
                      <Link to={`/sites/${s.id}`}><Button>Open</Button></Link>
                      <Button variant="ghost" onClick={() => togglePause(s)}>{s.paused ? "Resume" : "Pause"}</Button>
                      <Button variant="ghost" onClick={() => sync(s)} disabled={syncing === s.id}>
                        {syncing === s.id ? "Syncing…" : "Sync"}
                      </Button>
                      <Button variant="ghost" onClick={() => setForm({ site: s })}>Edit</Button>
                      <Button variant="danger" onClick={() => remove(s)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {ask && <ConfirmDialog request={ask} onClose={() => setAsk(null)} />}

      {form && (
        <WebsiteForm
          site={form.site}
          onClose={() => {
            setForm(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Num({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-2 py-2">
      <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value ?? "—"}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
