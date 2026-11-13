import { useEffect, useState, type FormEvent } from "react";
import {
  addAmazonAccount, AMAZON_VERSIONS, loadAmazonAccounts, supabase, testConnection, useSession, type AmazonAccount,
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
    <AmazonAccounts />
    </div>
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
