import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchCategories, supabase, useLive, type Article, type Category, type Site } from "../lib";
import { Button, Card, ConfirmDialog, Field, Input, LiveStatus, Modal, Notice, Select, StatusBadge, Textarea, type ConfirmRequest } from "../ui";

const COLS =
  "id,seq,website_id,keyword,type,status,step,progress,title,word_count,wp_post_url,wp_status,wp_category_name,error,created_at,finished_at";
const FILTERS = ["all", "queued", "writing", "completed", "failed"] as const;
type Filter = (typeof FILTERS)[number];

export default function SitePage() {
  const { id = "" } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [missing, setMissing] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [preview, setPreview] = useState<{ title: string; html: string } | null>(null);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  async function load() {
    const { data: s } = await supabase.from("website_overview").select("*").eq("id", id).maybeSingle();
    if (!s) return setMissing(true);
    setSite(s as Site);
    let q = supabase.from("articles").select(COLS).eq("website_id", id);
    if (filter !== "all") q = q.eq("status", filter);
    // Queue order for waiting keywords, newest first for everything else.
    const { data } = await q.order("seq", { ascending: filter === "queued" }).limit(200);
    setArticles((data ?? []) as Article[]);
  }
  useLive(load, `site-${id}-${filter}`);

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
      .eq("website_id", id).eq("status", "failed");
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
        const { error } = await supabase.from("articles").delete().eq("website_id", id).eq("status", "queued");
        await load();
        return error?.message ?? null;
      },
    });
  }
  function clearHistory() {
    if (!site) return;
    const count = site.completed + site.failed;
    setAsk({
      title: "Clear article history?",
      message: `All ${count} finished articles for ${site.name} (${site.completed} completed, ${site.failed} failed) will be removed from this app. It cannot be undone.\n\nKeywords still waiting or being written stay. Posts already on the WordPress site are not touched.`,
      label: "Clear history",
      run: async () => {
        const { error } = await supabase.from("articles").delete().eq("website_id", id).in("status", ["completed", "failed"]);
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

      <Card className="p-5">
        <div className="mb-2 text-sm font-medium">Live progress</div>
        <LiveStatus site={site} />
        {site.wp_error && <div className="mt-3"><Notice kind="error">WordPress: {site.wp_error}</Notice></div>}
      </Card>

      <KeywordForm site={site} onDone={load} />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
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
          <div className="flex gap-1.5">
            {site.failed > 0 && <Button variant="ghost" onClick={retryAllFailed}>Retry all failed</Button>}
            {site.queued > 0 && <Button variant="danger" onClick={clearQueue}>Clear queue</Button>}
            {site.completed + site.failed > 0 && <Button variant="danger" onClick={clearHistory}>Clear history</Button>}
          </div>
        </div>
        {articles.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">Nothing here yet. Add keywords above to start.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {articles.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
                <div className="min-w-0 flex-1 basis-64">
                  <div className="truncate text-sm font-medium">{a.title || a.keyword}</div>
                  <div className="truncate text-xs text-slate-500">
                    {a.title && <>{a.keyword} · </>}
                    {a.type === "review" ? "Amazon review" : "Informative"}
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
        {counts[filter] > articles.length && (
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

function KeywordForm({ site, onDone }: { site: Site; onDone: () => void }) {
  const [text, setText] = useState("");
  const [type, setType] = useState<"review" | "informative">("review");
  const [sleep, setSleep] = useState(String(site.sleep_seconds));
  const [postStatus, setPostStatus] = useState(site.post_status);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [productCount, setProductCount] = useState("5");
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
    const sleepSeconds = Math.max(0, Number(sleep) || 0);
    const { error: siteError } = await supabase.from("websites")
      .update({ sleep_seconds: sleepSeconds, post_status: postStatus }).eq("id", site.id);
    let error = siteError;
    for (let i = 0; !error && i < keywords.length; i += 500) {
      const category = categories.find((c) => String(c.id) === categoryId);
      const rows = keywords.slice(i, i + 500).map((keyword) => ({
        website_id: site.id,
        keyword,
        type,
        product_count: Math.min(10, Math.max(1, Math.round(Number(productCount)) || 5)),
        wp_category_id: category?.id ?? null,
        wp_category_name: category?.name ?? null,
      }));
      ({ error } = await supabase.from("articles").insert(rows));
    }
    setBusy(false);
    if (error) {
      const text = error.message.includes("product_count")
        ? "Database update needed: run supabase/migrations/004_product_count.sql in the Supabase SQL Editor, then try again."
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
          <Field label="Sleep after each article (seconds)">
            <Input type="number" min={0} value={sleep} onChange={(e) => setSleep(e.target.value)} />
          </Field>
          <Field label="Post to WordPress as">
            <Select value={postStatus} onChange={(e) => setPostStatus(e.target.value as typeof postStatus)}>
              <option value="draft">Draft</option>
              <option value="publish">Published</option>
            </Select>
          </Field>
        </div>
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
