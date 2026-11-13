import { useEffect, useState, type FormEvent } from "react";
import { supabase, testConnection, useSession } from "../lib";
import { Button, Card, Field, Input, Notice } from "../ui";

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
    <form onSubmit={save} className="mx-auto max-w-2xl space-y-6">
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

      <Card className="p-5 text-sm text-slate-600">
        <span className="font-semibold text-slate-800">Amazon Creators API</span> — credentials and tracking ID are set
        separately on each website. Open the dashboard and click <span className="font-medium">Edit</span> on a website.
      </Card>

      <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button>
    </form>
  );
}
