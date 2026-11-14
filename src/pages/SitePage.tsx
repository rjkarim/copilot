import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchCategories, saveSleep, sleepLabel, supabase, useLive, type Article, type Category, type Site } from "../lib";
import { Button, Card, ConfirmDialog, Field, Input, LiveStatus, Modal, Notice, Select, StatusBadge, Textarea, type ConfirmRequest } from "../ui";

const COLS =
  "id,seq,website_id,keyword,type,status,step,progress,title,word_count,wp_post_url,wp_status,wp_category_name,kind,old_title,error,created_at,finished_at";
const FILTERS = ["all", "queued", "writing", "completed", "failed"] as const;
type Filter = (typeof FILTERS)[number];

export default function SitePage() {
  const { id = "" } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [missing, setMissing] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  // "new" = write new articles from keywords; "update" = rewrite the website's old posts.
  const [mode, setMode] = useState<"new" | "update">("new");
  const [preview, setPreview] = useState<{ title: string; html: string } | null>(null);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  async function load() {
    const { data: s } = await supabase.from("website_overview").select("*").eq("id", id).maybeSingle();
    if (!s) return setMissing(true);
    setSite(s as Site);
    let q = supabase.from("articles").select(COLS).eq("website_id", id).eq("kind", mode);
    if (mode === "new" && filter !== "all") q = q.eq("status", filter);
    // Queue order for waiting keywords, newest first for everything else.
    const { data } = await q.order("seq", { ascending: mode === "new" && filter === "queued" }).limit(200);
    setArticles((data ?? []) as Article[]);
  }
  useLive(load, `site-${id}-${mode}-${filter}`);

  async function retry(a: Article) {
    await supabase.from("articles").update({ status: "queued", error: null, progress: 0, step: null }).eq("id", a.id);
    load();
  }
  // Stops an article that is being written. The background writer notices and
  // drops its work; the keyword moves to Failed, where Retry runs it again.
  async function cancel(a: Article) {
    await supabase.from("articles")
      .update({ status: "failed", error: "Cancelled by you. Click Retry to write it again.", step: null, progress: 0, finished_at: new Date().toISOString() })
      .eq("id", a.id).eq("status", "writing");
    load();
  }
  async function retryAllFailed() {
    await supabase.from("articles").update({ status: "queued", error: null, progress: 0, step: null })
      .eq("website_id", id).eq("kind", mode).eq("status", "failed");
    load();
  }
  function remove(a: Article) {
    setAsk({
      title: "Delete this article?",
      message: `"${a.title || a.keyword}" will be removed from this app. It cannot be undone.${a.wp_post_url ? "\n\nThe post already on the WordPress site is not touched." : ""}`,
      label: "Delete article",
      run: async () => {
        const { error } = await supabase.from("articles").delete().eq("id", a.id);
        await load();
        return error?.message ?? null;
      },
    });
  }
  function clearQueue() {
    if (!site) return;
    setAsk({
      title: "Clear the queue?",
      message: `All ${site.queued} waiting keywords for ${site.name} will be removed. It cannot be undone.`,
      label: "Clear queue",
      run: async () => {
        const { error } = await supabase.from("articles").delete().eq("website_id", id).eq("kind", "new").eq("status", "queued");
        await load();
        return error?.message ?? null;
      },
    });
  }
  function clearHistory() {
    if (!site) return;
    const done = mode === "new" ? site.completed : site.updates_done;
    const failed = mode === "new" ? site.failed : site.updates_failed;
    setAsk({
      title: mode === "new" ? "Clear article history?" : "Clear update history?",
      message:
        `All ${done + failed} finished ${mode === "new" ? "articles" : "updates"} for ${site.name} (${done} completed, ${failed} failed) will be removed from this app. It cannot be undone.\n\n` +
        (mode === "new"
          ? "Keywords still waiting or being written stay. Posts already on the WordPress site are not touched."
          : "Posts on the WordPress site are not touched. The app also forgets which posts it already updated, so use this together with 'Start over' only if you want them updated again."),
      label: "Clear history",
      run: async () => {
        const { error } = await supabase.from("articles").delete().eq("website_id", id).eq("kind", mode).in("status", ["completed", "failed"]);
        await load();
        return error?.message ?? null;
      },
    });
  }
  async function openPreview(a: Article) {
    const { data } = await supabase.from("articles").select("title,content_html").eq("id", a.id).single();
    setPreview({ title: data?.title ?? a.keyword, html: data?.content_html ?? "" });
  }

  if (missing) return <Notice kind="error">Website not found. <Link to="/" className="underline">Back to dashboard</Link></Notice>;
  if (!site) return null;

  const counts: Record<Filter, number> = {
    all: site.queued + site.writing + site.completed + site.failed,
    queued: site.queued,
    writing: site.writing,
    completed: site.completed,
    failed: site.failed,
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-slate-500 hover:text-indigo-600">← Dashboard</Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-xl font-semibold">{site.name}</h1>
          <a href={site.url} target="_blank" rel="noreferrer" className="text-sm text-slate-500 hover:underline">{site.url}</a>
        </div>
      </div>

      {/* Both tabs always sit side by side on one line, however narrow the window. */}
      <div className="flex w-full flex-nowrap rounded-lg border border-slate-300 bg-white p-0.5 text-sm sm:w-fit">
        {([["new", "Write new articles"], ["update", "Update old posts"]] as const).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 font-medium sm:px-4 ${mode === m ? "bg-indigo-600 text-white" : "text-slate-600"}`}
          >
            {label}
            {m === "update" && site.update_enabled && <span className="ml-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
          </button>
        ))}
      </div>

      {mode === "new" ? (
        <>
          <Card className="p-5">
            <div className="mb-2 text-sm font-medium">Live progress</div>
            <LiveStatus site={site} />
            {site.wp_error && <div className="mt-3"><Notice kind="error">WordPress: {site.wp_error}</Notice></div>}
            <SleepSetting site={site} lane="new" onDone={load} />
          </Card>
          <KeywordForm site={site} onDone={load} />
        </>
      ) : (
        <UpdatePanel site={site} onDone={load} confirm={setAsk} />
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          {mode === "new" ? (
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${filter === f ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  {f} <span className="tabular-nums text-slate-400">{counts[f]}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-sm font-medium">
              Updated posts <span className="font-normal text-slate-500">· newest first</span>
            </div>
          )}
          <div className="flex gap-1.5">
            {(mode === "new" ? site.failed : site.updates_failed) > 0 && <Button variant="ghost" onClick={retryAllFailed}>Retry all failed</Button>}
            {mode === "new" && site.queued > 0 && <Button variant="danger" onClick={clearQueue}>Clear queue</Button>}
            {(mode === "new" ? site.completed + site.failed : site.updates_done + site.updates_failed) > 0 && (
              <Button variant="danger" onClick={clearHistory}>Clear history</Button>
            )}
          </div>
        </div>
        {articles.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {mode === "new" ? "Nothing here yet. Add keywords above to start." : "No posts updated yet. Start the updater above."}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {articles.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="truncate text-sm font-medium">{a.title || a.keyword}</div>
                  <div className="truncate text-xs text-slate-500">
                    {a.kind === "update" ? <>Was: {a.old_title ?? a.keyword} · Keyword: {a.keyword} · </> : a.title && <>{a.keyword} · </>}
                    {a.type === "review" ? (a.kind === "update" ? "Money content" : "Amazon review") : "Informative"}
                    {a.wp_category_name ? ` · ${a.wp_category_name}` : ""}
                    {a.word_count ? ` · ${a.word_count} words` : ""}
                    {a.status === "writing" && a.step ? ` · ${a.step} (${a.progress}%)` : ""}
                    {a.status === "completed" && a.wp_status ? ` · WordPress: ${a.wp_status === "publish" ? "published" : a.wp_status}` : ""}
                  </div>
                  {a.error && <div className="mt-0.5 text-xs text-red-600">{a.error}</div>}
                </div>
                <StatusBadge status={a.status} />
                <div className="flex gap-1.5">
                  {a.wp_post_url && (
                    <a href={a.wp_post_url} target="_blank" rel="noreferrer"><Button variant="ghost">Open post</Button></a>
                  )}
                  {a.word_count ? <Button variant="ghost" onClick={() => openPreview(a)}>Preview</Button> : null}
                  {a.status === "writing" && <Button variant="danger" onClick={() => cancel(a)}>Cancel</Button>}
                  {a.status === "failed" && <Button variant="ghost" onClick={() => retry(a)}>Retry</Button>}
                  {a.status !== "writing" && <Button variant="danger" onClick={() => remove(a)}>Delete</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {mode === "new" && counts[filter] > articles.length && (
          <div className="border-t border-slate-100 px-4 py-2 text-center text-xs text-slate-500">
            Showing {articles.length} of {counts[filter]}
          </div>
        )}
      </Card>

      {ask && <ConfirmDialog request={ask} onClose={() => setAsk(null)} />}

      {preview && (
        <Modal title={preview.title} onClose={() => setPreview(null)}>
          {/* Sandboxed so article HTML can never run scripts inside the app. */}
          <iframe
            title="Article preview"
            sandbox=""
            className="h-[70vh] w-full rounded-lg border border-slate-200"
            srcDoc={`<base target="_blank"><style>body{font:16px/1.65 system-ui,sans-serif;color:#1e293b;max-width:720px;margin:0 auto;padding:16px}img{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:6px 10px;text-align:left}a{color:#4f46e5}</style><h1>${preview.title.replace(/</g, "&lt;")}</h1>${preview.html}`}
          />
        </Modal>
      )}
    </div>
  );
}

/** Sleep time with its own Save button. Can be changed at any moment; applies from the click. */
function SleepSetting({ site, lane, onDone }: { site: Site; lane: "new" | "update"; onDone: () => void }) {
  const saved = lane === "new" ? site.sleep_seconds : site.update_sleep_seconds;
  const [value, setValue] = useState(String(saved ?? 60));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const seconds = Math.max(0, Math.round(Number(value)) || 0);

  async function save() {
    setBusy(true);
    const problem = await saveSleep(site.id, lane, seconds);
    setBusy(false);
    setMsg(problem ? { kind: "error", text: problem } : { kind: "ok", text: `Saved. Sleep time is now ${sleepLabel(seconds)}, effective from now.` });
    onDone();
  }
  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Sleep after each {lane === "new" ? "article" : "update"} (seconds)
          </span>
          <Input type="number" min={0} value={value} className="w-40"
            onChange={(e) => { setValue(e.target.value); setMsg(null); }} />
        </label>
        <Button variant={seconds === saved ? "ghost" : "primary"} onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <span className="pb-2 text-xs text-slate-500">
          Currently {sleepLabel(saved ?? 0)}. You can change it at any time, also while articles are being written.
        </span>
      </div>
      {msg && <div className="mt-2"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
    </div>
  );
}

/** Settings, start/stop and live status for rewriting the website's old posts, oldest first. */
function UpdatePanel({ site, onDone, confirm }: { site: Site; onDone: () => void; confirm: (r: ConfirmRequest) => void }) {
  const [sleep, setSleep] = useState(String(site.update_sleep_seconds ?? 60));
  const [productCount, setProductCount] = useState(String(site.update_product_count ?? 5));
  const [includeFaq, setIncludeFaq] = useState(site.update_include_faq ?? true);
  const [error, setError] = useState("");

  const needsDb = site.update_enabled === undefined;
  const settings = () => ({
    update_sleep_seconds: Math.max(0, Math.round(Number(sleep)) || 0),
    update_product_count: Math.min(10, Math.max(1, Math.round(Number(productCount)) || 5)),
    update_include_faq: includeFaq,
  });
  async function save(patch: Record<string, unknown>): Promise<string | null> {
    const { error } = await supabase.from("websites").update(patch).eq("id", site.id);
    onDone();
    return error?.message ?? null;
  }
  function start() {
    confirm({
      title: "Start updating old posts?",
      message:
        `This replaces the title and the whole content of published posts on ${site.name}, one at a time, starting with the oldest. ` +
        "The post address (URL) and status stay the same; the post date becomes the date and time of the update.\n\n" +
        "The old text is overwritten on the website. WordPress normally keeps earlier versions as revisions, but this app keeps no copy, so make a backup first if you may want the old text back.",
      label: "Start updating",
      busyLabel: "Starting…",
      run: () => save({ ...settings(), update_enabled: true, update_error: null, update_next_run_at: new Date().toISOString() }),
    });
  }
  async function stop() {
    setError((await save({ update_enabled: false })) ?? "");
  }
  function startOver() {
    confirm({
      title: "Start over from the oldest post?",
      message:
        "The updater goes back to the very first post. Posts listed below as already updated are still skipped; clear the update history too if you want those rewritten again.",
      label: "Start over",
      busyLabel: "Resetting…",
      run: () => save({ update_cursor: null }),
    });
  }

  const pct = Math.max(5, site.update_progress ?? 5);
  const next = new Date(site.update_next_run_at ?? Date.now());
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Update old posts</div>
          <p className="mt-0.5 max-w-2xl text-xs text-slate-500">
            Rewrites published posts one by one, oldest first. The title decides the type: questions (How, Why, What,
            Can…) become a full informational article; anything with "Best", "10 Best…", "Top 5…" or "Picks" — also
            as a question, like "Which Is the Best…" — becomes a money article with fresh Amazon products. The main
            keyword is taken from the post's URL. The URL never changes; the post date is set to the day of the update.
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${site.update_enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {site.update_enabled ? "Running" : "Stopped"}
        </span>
      </div>

      {needsDb && <Notice kind="error">Database update needed: run supabase/migrations/007_update_old_posts.sql in the Supabase SQL Editor, then reload.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {site.update_error && <Notice kind="error">Could not pick the next post: {site.update_error}</Notice>}

      <div className="grid grid-cols-3 gap-2 text-center sm:max-w-md">
        {[["Updated", site.updates_done ?? 0, "text-emerald-600"], ["Failed", site.updates_failed ?? 0, site.updates_failed ? "text-red-600" : "text-slate-400"],
          ["Posts left", site.update_remaining ?? "—", "text-slate-700"]].map(([label, value, tone]) => (
          <div key={label} className="rounded-lg bg-slate-50 px-2 py-2">
            <div className={`text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
            <div className="text-[11px] text-slate-500">{label}</div>
          </div>
        ))}
      </div>

      {site.update_keyword ? (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium text-indigo-700">
              <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
              {site.update_step ?? "Updating"}: {site.update_keyword}
            </span>
            <span className="tabular-nums text-slate-500">{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="bar-live h-full rounded-full bg-indigo-500 transition-all duration-700" style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : (
        site.update_enabled && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
            {next.getTime() > Date.now() + 1000 ? `Sleeping — next post at ${next.toLocaleTimeString()}` : "Picking the next post…"}
          </div>
        )
      )}

      <div className="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Sleep after each update (seconds)" hint="Example: 300 = wait 5 minutes before the next post">
          <Input type="number" min={0} value={sleep} onChange={(e) => setSleep(e.target.value)} />
        </Field>
        <Field label="Products per money article" hint="10 are fetched from Amazon; the best ones are kept (1-10)">
          <Input type="number" min={1} max={10} value={productCount} onChange={(e) => setProductCount(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-center text-sm text-slate-700">
          <input type="checkbox" checked={includeFaq} onChange={(e) => setIncludeFaq(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-indigo-600" />
          Include an FAQ section
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {site.update_enabled ? (
          <>
            <Button variant="danger" onClick={stop}>Stop updating</Button>
            <Button
              variant="ghost"
              onClick={async () => {
                // The sleep time is re-timed by the writer so it applies from this moment.
                const problem = (await save(settings())) ?? (await saveSleep(site.id, "update", settings().update_sleep_seconds));
                setError(problem ?? "");
                onDone();
              }}
            >
              Save settings
            </Button>
          </>
        ) : (
          <Button onClick={start} disabled={needsDb}>Start updating</Button>
        )}
        {site.update_cursor && <Button variant="ghost" onClick={startOver}>Start over from the oldest</Button>}
        {site.update_enabled && <span className="text-xs text-slate-500">Stopping lets the post being written finish.</span>}
      </div>
    </Card>
  );
}

function KeywordForm({ site, onDone }: { site: Site; onDone: () => void }) {
  const [text, setText] = useState("");
  const [type, setType] = useState<"review" | "informative">("review");
  const [postStatus, setPostStatus] = useState(site.post_status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [productCount, setProductCount] = useState("5");
  const [includeFaq, setIncludeFaq] = useState(true);
  const [catState, setCatState] = useState<"loading" | "ready" | string>("loading");

  // Categories come straight from the WordPress site each time this page opens.
  async function loadCategories() {
    setCatState("loading");
    const res = await fetchCategories(site.id);
    setCategories(res.categories);
    setCatState(res.error ?? "ready");
  }
  useEffect(() => {
    loadCategories();
  }, [site.id]);

  const keywords = [...new Set(text.split(/\r?\n/).map((k) => k.trim()).filter(Boolean))];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (keywords.length === 0) return;
    setBusy(true);
    setMsg(null);
    const { error: siteError } = await supabase.from("websites")
      .update({ post_status: postStatus }).eq("id", site.id);
    let error = siteError;
    for (let i = 0; !error && i < keywords.length; i += 500) {
      const category = categories.find((c) => String(c.id) === categoryId);
      const rows = keywords.slice(i, i + 500).map((keyword) => ({
        website_id: site.id,
        keyword,
        type,
        product_count: Math.min(10, Math.max(1, Math.round(Number(productCount)) || 5)),
        include_faq: includeFaq,
        wp_category_id: category?.id ?? null,
        wp_category_name: category?.name ?? null,
      }));
      ({ error } = await supabase.from("articles").insert(rows));
    }
    setBusy(false);
    if (error) {
      const text = error.message.includes("product_count")
        ? "Database update needed: run supabase/migrations/004_product_count.sql in the Supabase SQL Editor, then try again."
        : error.message.includes("include_faq")
          ? "Database update needed: run supabase/migrations/005_amazon_accounts_and_faq.sql in the Supabase SQL Editor, then try again."
          : error.message;
      return setMsg({ kind: "error", text });
    }
    setText("");
    setMsg({
      kind: "ok",
      text: `${keywords.length} keyword${keywords.length > 1 ? "s" : ""} added. Writing starts within 30 seconds and continues in the background — you can close this page.`,
    });
    onDone();
  }

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="space-y-4">
        <div className="text-sm font-medium">Add keywords in bulk</div>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        {type === "review" && (!site.tracking_id || !site.has_amazon_keys) && (
          <Notice kind="error">
            This website is missing its Amazon {!site.has_amazon_keys ? "Creators API credentials" : "tracking ID"}. Click
            Edit on this website in the dashboard before adding review keywords.
          </Notice>
        )}
        {catState !== "loading" && catState !== "ready" && (
          <Notice kind="error">Could not load categories from the website: {catState}</Notice>
        )}
        <Textarea
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"One keyword per line, for example:\nbest air fryer for small kitchen\nbest cordless vacuum for pet hair\nhow to clean a cast iron skillet"}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category">
            <div className="flex gap-1.5">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={catState === "loading"}>
                <option value="">{catState === "loading" ? "Loading from website…" : "Website default"}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
              <Button type="button" variant="ghost" onClick={loadCategories} title="Reload categories from the website" aria-label="Reload categories">
                ↻
              </Button>
            </div>
          </Field>
          <Field label="Article type">
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="review">Amazon affiliate review</option>
              <option value="informative">Informative article</option>
            </Select>
          </Field>
          <Field
            label="Products to review per article"
            hint={type === "review" ? "10 are fetched from Amazon; the best ones are kept (1-10)" : "Only used for Amazon review articles"}
          >
            <Input type="number" min={1} max={10} value={productCount} disabled={type !== "review"}
              onChange={(e) => setProductCount(e.target.value)} />
          </Field>
          <Field label="Post to WordPress as">
            <Select value={postStatus} onChange={(e) => setPostStatus(e.target.value as typeof postStatus)}>
              <option value="draft">Draft</option>
              <option value="publish">Published</option>
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={includeFaq} onChange={(e) => setIncludeFaq(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-indigo-600" />
          Include an FAQ section in each article
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-slate-500">{keywords.length} keyword{keywords.length === 1 ? "" : "s"} ready</span>
          <Button type="submit" disabled={busy || keywords.length === 0}>
            {busy ? "Adding…" : "Start writing"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
