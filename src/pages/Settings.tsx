import { useEffect, useState, type FormEvent } from "react";
import {
  addAmazonAccount, AMAZON_VERSIONS, clearHistoryForAll, loadAmazonAccounts, saveSleepForAll, supabase, testConnection, useSession, type AmazonAccount,
} from "../lib";
import { Button, Card, ConfirmDialog, Field, Input, Notice, Select, type ConfirmRequest } from "../ui";

type Saved = { openai_model: string; openai_base_url: string; has_openai_key: boolean };
const DEFAULT_BASE = "https://api.openai.com/v1";

export default function Settings() {
  const session = useSession();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [model, setModel] = useState("gpt-4o-mini");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [openaiKey, setOpenaiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [test, setTest] = useState<{ ok: boolean; text: string } | "testing" | null>(null);

  async function runTest() {
    setTest("testing");
    setTest(
      await testConnection("ai", undefined, {
        openai_base_url: baseUrl.trim().replace(/\/+$/, ""),
        openai_api_key: openaiKey,
        openai_model: model,
      }),
    );
  }

  async function load() {
    const { data, error } = await supabase.from("settings")
      .select("openai_model,openai_base_url,has_openai_key").maybeSingle();
    if (error || !data) {
      const text = error?.message.includes("openai_base_url")
        ? "Database update needed: run supabase/migrations/002_ai_base_url.sql in the Supabase SQL Editor, then reload."
        : (error?.message ?? "Settings row not found. Run the database setup SQL (README.md).");
      return setMsg({ kind: "error", text });
    }
    setSaved(data);
    setModel(data.openai_model);
    setBaseUrl(data.openai_base_url);
  }
  useEffect(() => {
    load();
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    // The key is only sent when you typed a new value; empty means "keep".
    const patch: Record<string, string> = {
      openai_model: model.trim() || "gpt-4o-mini",
      openai_base_url: baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE,
      updated_at: new Date().toISOString(),
    };
    if (openaiKey.trim()) patch.openai_api_key = openaiKey.trim();
    const { error } = await supabase.from("settings").update(patch).eq("user_id", session.user.id);
    setBusy(false);
    if (error) return setMsg({ kind: "error", text: error.message });
    setOpenaiKey("");
    setMsg({ kind: "ok", text: "Settings saved." });
    load();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
    <form onSubmit={save} className="space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Notice kind="info">
        The key is stored in your Supabase database and is used only by the background writer. It is never shown again
        after saving — leave the field empty to keep the saved value.
      </Notice>

      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">AI article writer</h2>
          {saved?.has_openai_key ? (
            <span className="text-xs font-medium text-emerald-600">● Saved</span>
          ) : (
            <span className="text-xs font-medium text-amber-600">● Not set</span>
          )}
        </div>
        <Field label="API base URL" hint="OpenAI: https://api.openai.com/v1 — or the address of any OpenAI-compatible provider">
          <Input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required pattern="https://.*" />
        </Field>
        <Field label="API key" hint="The key from the provider above">
          <Input type="password" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} autoComplete="off"
            placeholder={saved?.has_openai_key ? "•••••••• (saved)" : "sk-..."} />
        </Field>
        <Field label="Model" hint="The exact model name your provider uses, e.g. gpt-4o-mini or openai/gpt-6-luna">
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <div className="space-y-2">
          <Button type="button" variant="ghost" onClick={runTest} disabled={test === "testing"}>
            {test === "testing" ? "Testing…" : "Test AI connection"}
          </Button>
          {test && test !== "testing" && <Notice kind={test.ok ? "ok" : "error"}>{test.text}</Notice>}
        </div>
      </Card>

      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button>
    </form>
    <SleepForAll />
    <ProductsForAll />
    <AmazonAccounts />
    <FreeStorage />
    </div>
  );
}

/** One "products per review article" number for every website, for new articles and old-post updates. */
function ProductsForAll() {
  const session = useSession();
  const [values, setValues] = useState({ product_count: "5", update_product_count: "5" });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  type Key = keyof typeof values;

  // Start the boxes at the number most websites use now.
  useEffect(() => {
    supabase.from("website_overview").select("product_count,update_product_count").then(({ data }) => {
      if (!data?.length) return;
      const common = (key: Key) => {
        const counts = new Map<number, number>();
        for (const row of data) if (row[key] != null) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
        return String([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 5);
      };
      setValues({ product_count: common("product_count"), update_product_count: common("update_product_count") });
    });
  }, []);

  async function apply(key: Key) {
    const count = Math.min(10, Math.max(1, Math.round(Number(values[key])) || 5));
    setBusy(key);
    setMsg(null);
    const { error, count: changed } = await supabase.from("websites")
      .update({ [key]: count }, { count: "exact" }).eq("user_id", session.user.id);
    setBusy(null);
    setValues({ ...values, [key]: String(count) });
    setMsg(
      error
        ? {
            kind: "error",
            text: error.message.includes("product_count")
              ? "Database update needed: run supabase/migrations/009_product_count_per_website.sql in the Supabase SQL Editor, then try again."
              : error.message,
          }
        : {
            kind: "ok",
            text: `Done. ${changed ?? "All"} websites now review ${count} products per ${key === "product_count" ? "new article" : "updated money post"}, starting with the next article.`,
          },
    );
  }
  const row = (key: Key, label: string) => (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
        <Input type="number" min={1} max={10} className="w-44" value={values[key]}
          onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
      </label>
      <Button type="button" onClick={() => apply(key)} disabled={busy !== null}>
        {busy === key ? "Applying…" : "Apply to all websites"}
      </Button>
    </div>
  );
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Products to review per article, for all websites</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Changes every website in one click (1-10). It applies to all keywords still waiting, starting with the next
          article. A single website can still be given its own number on its page afterwards.
        </p>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {row("product_count", "In each new review article")}
      {row("update_product_count", "In each updated money post")}
    </Card>
  );
}

/** Clears generated content of all websites from the app's database to free storage. */
function FreeStorage() {
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function run(mode: "text" | "all") {
    const all = mode === "all";
    setAsk({
      title: all ? "Clear all history?" : "Delete the saved article text?",
      message: all
        ? "For ALL websites, every completed and failed article is removed from this app, together with its saved text. It cannot be undone.\n\n" +
          "Not touched: keywords still waiting or being written, and every post on your WordPress sites.\n\n" +
          "The Statistics page will start again from zero. Updated old posts keep a small record (without text), so the updater never rewrites the same post twice."
        : "For ALL websites, the saved text of every completed article is erased from this app. It cannot be undone.\n\n" +
          "The article lists and the Statistics page stay as they are, but Preview no longer shows the text. Every post on your WordPress sites is untouched.",
      label: all ? "Clear all history" : "Delete saved text",
      busyLabel: "Clearing…",
      run: async () => {
        setMsg(null);
        setProgress(0);
        const problem = await clearHistoryForAll(mode, setProgress);
        setProgress((done) => {
          if (!problem) {
            setMsg({ kind: "ok", text: `Done. ${(done ?? 0).toLocaleString("en-US")} articles were cleared.` });
          }
          return null;
        });
        return problem;
      },
    });
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Free up database storage</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          The app keeps a copy of every article it writes, which is what fills your Supabase database. Both buttons
          work on all websites at once and never change anything on the websites themselves.
        </p>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {progress !== null && <Notice kind="info">Clearing… {progress.toLocaleString("en-US")} articles so far. Keep this page open.</Notice>}
      <div className="flex flex-wrap gap-6">
        <div className="max-w-xs space-y-2">
          <Button type="button" variant="danger" onClick={() => run("all")} disabled={progress !== null}>Clear all history</Button>
          <p className="text-xs text-slate-500">
            Removes all completed and failed articles from the lists and deletes their text. Frees the most space.
          </p>
        </div>
        <div className="max-w-xs space-y-2">
          <Button type="button" variant="ghost" onClick={() => run("text")} disabled={progress !== null}>Delete saved text only</Button>
          <p className="text-xs text-slate-500">
            Keeps the article lists and statistics, deletes only the stored text. Frees almost as much space.
          </p>
        </div>
      </div>
      {ask && <ConfirmDialog request={ask} onClose={() => setAsk(null)} />}
    </Card>
  );
}

/** One sleep time for every website, separately for new articles and old-post updates. */
function SleepForAll() {
  const [values, setValues] = useState({ new: "60", update: "60" });
  const [busy, setBusy] = useState<"new" | "update" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Start the boxes at the most common current value, so you can see what is in use.
  useEffect(() => {
    supabase.from("website_overview").select("sleep_seconds,update_sleep_seconds").then(({ data }) => {
      if (!data?.length) return;
      const common = (key: "sleep_seconds" | "update_sleep_seconds") => {
        const counts = new Map<number, number>();
        for (const row of data) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
        return String([...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] ?? 60);
      };
      setValues({ new: common("sleep_seconds"), update: common("update_sleep_seconds") });
    });
  }, []);

  async function apply(lane: "new" | "update") {
    setBusy(lane);
    setMsg(null);
    const res = await saveSleepForAll(lane, Math.max(0, Math.round(Number(values[lane])) || 0));
    setBusy(null);
    setMsg({ kind: res.ok ? "ok" : "error", text: res.text });
  }
  const row = (lane: "new" | "update", label: string) => (
    <div className="flex flex-wrap items-end gap-2">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
        <Input type="number" min={0} className="w-44" value={values[lane]}
          onChange={(e) => setValues({ ...values, [lane]: e.target.value })} />
      </label>
      <Button type="button" onClick={() => apply(lane)} disabled={busy !== null}>
        {busy === lane ? "Applying…" : "Apply to all websites"}
      </Button>
    </div>
  );
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Sleep time for all websites</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Changes every website in one click and takes effect immediately, also while articles are being written. A
          single website can still be given its own time on its page afterwards.
        </p>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {row("new", "After each new article (seconds)")}
      {row("update", "After each old-post update (seconds)")}
    </Card>
  );
}

/** Saved Creators API accounts: add once here (or in the website form), reuse on any website. */
function AmazonAccounts() {
  const [accounts, setAccounts] = useState<AmazonAccount[]>([]);
  const [acc, setAcc] = useState({ name: "", credential_id: "", credential_secret: "", version: "3.1" });
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  const setA = (k: keyof typeof acc) => (e: { target: { value: string } }) => setAcc({ ...acc, [k]: e.target.value });

  async function load() {
    const res = await loadAmazonAccounts();
    setAccounts(res.accounts);
    if (res.error) setMsg({ kind: "error", text: res.error });
  }
  useEffect(() => {
    load();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const saved = await addAmazonAccount(acc);
    setBusy(false);
    if (!saved.id) return setMsg({ kind: "error", text: saved.error ?? "Could not save the account." });
    setAcc({ name: "", credential_id: "", credential_secret: "", version: acc.version });
    setMsg({ kind: "ok", text: "Amazon account saved. Choose it on a website with Edit on the dashboard." });
    load();
  }
  function remove(a: AmazonAccount) {
    setAsk({
      title: `Delete ${a.name}?`,
      message: "Websites using this Amazon account will have no account until you pick another one, and their review articles will fail. It cannot be undone.",
      label: "Delete account",
      run: async () => {
        const { error } = await supabase.from("amazon_accounts").delete().eq("id", a.id);
        await load();
        return error?.message ?? null;
      },
    });
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Amazon Creators API accounts</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Save an account once and reuse it on as many websites as you like. Each website keeps its own tracking ID.
        </p>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {accounts.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{a.name}</div>
                <div className="text-xs text-slate-500">Version {a.version} · credentials saved</div>
              </div>
              <Button variant="danger" onClick={() => remove(a)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="space-y-4 border-t border-slate-200 pt-4">
        <div className="text-sm font-medium">Add a new account</div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account name">
            <Input value={acc.name} onChange={setA("name")} required placeholder="Main Associates account" />
          </Field>
          <Field label="Credential version">
            <Select value={acc.version} onChange={setA("version")}>
              {AMAZON_VERSIONS.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Credential ID">
            <Input value={acc.credential_id} onChange={setA("credential_id")} required autoComplete="off" />
          </Field>
          <Field label="Credential Secret">
            <Input type="password" value={acc.credential_secret} onChange={setA("credential_secret")} required autoComplete="new-password" />
          </Field>
        </div>
        <Button type="submit" variant="ghost" disabled={busy}>{busy ? "Saving…" : "Add account"}</Button>
      </form>
      {ask && <ConfirmDialog request={ask} onClose={() => setAsk(null)} />}
    </Card>
  );
}
