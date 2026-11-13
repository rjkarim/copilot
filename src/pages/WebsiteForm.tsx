import { useState, type FormEvent } from "react";
import { MARKETPLACES, supabase, syncSite, testConnection, type Site } from "../lib";
import { Button, Field, Input, Modal, Notice, Select } from "../ui";

/** Add or edit a website. `site` is undefined when adding. */
export default function WebsiteForm({ site, onClose }: { site?: Site; onClose: () => void }) {
  const [f, setF] = useState({
    name: site?.name ?? "",
    url: site?.url ?? "https://",
    wp_username: site?.wp_username ?? "",
    wp_app_password: "",
    tracking_id: site?.tracking_id ?? "",
    marketplace: site?.marketplace ?? "www.amazon.com",
    language: site?.language ?? "English",
    post_status: site?.post_status ?? "draft",
    sleep_seconds: site?.sleep_seconds ?? 60,
    amazon_credential_id: "",
    amazon_credential_secret: "",
    amazon_version: site?.amazon_version ?? "3.1",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  type Result = { ok: boolean; text: string } | "testing" | null;
  const [wpTest, setWpTest] = useState<Result>(null);
  const [amzTest, setAmzTest] = useState<Result>(null);

  async function test(kind: "wordpress" | "amazon") {
    const setResult = kind === "wordpress" ? setWpTest : setAmzTest;
    setResult("testing");
    const { name, language, post_status, sleep_seconds, ...fields } = f;
    setResult(await testConnection(kind, site?.id, fields));
  }
  const testRow = (kind: "wordpress" | "amazon", label: string, result: Result) => (
    <div className="space-y-2">
      <Button type="button" variant="ghost" onClick={() => test(kind)} disabled={result === "testing"}>
        {result === "testing" ? "Testing…" : label}
      </Button>
      {result && result !== "testing" && <Notice kind={result.ok ? "ok" : "error"}>{result.text}</Notice>}
    </div>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { wp_app_password, amazon_credential_id, amazon_credential_secret, ...rest } = f;
    const row: Record<string, unknown> = {
      ...rest,
      name: f.name.trim(),
      url: f.url.trim().replace(/\/+$/, ""),
      tracking_id: f.tracking_id.trim(),
      sleep_seconds: Math.max(0, Number(f.sleep_seconds) || 0),
    };
    // Secret fields are only sent when a new value was typed; empty means "keep".
    if (wp_app_password.trim()) row.wp_app_password = wp_app_password.trim();
    if (amazon_credential_id.trim()) row.amazon_credential_id = amazon_credential_id.trim();
    if (amazon_credential_secret.trim()) row.amazon_credential_secret = amazon_credential_secret.trim();

    const id = site?.id ?? crypto.randomUUID();
    const { error } = site
      ? await supabase.from("websites").update(row).eq("id", id)
      : await supabase.from("websites").insert({ id, ...row });
    if (error) {
      setError(
        error.message.includes("schema cache")
          ? "Database update needed: run supabase/migrations/003_site_amazon_and_categories.sql in the Supabase SQL Editor, then try again."
          : error.message,
      );
      setBusy(false);
      return;
    }
    // Test the WordPress login and load post counts. The result shows on the website card.
    await syncSite(id);
    setBusy(false);
    onClose();
  }

  return (
    <Modal title={site ? `Edit ${site.name}` : "Add website"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Website name">
            <Input value={f.name} onChange={set("name")} required placeholder="My Kitchen Blog" />
          </Field>
          <Field label="WordPress URL">
            <Input type="url" value={f.url} onChange={set("url")} required placeholder="https://example.com" />
          </Field>
          <Field label="WordPress username">
            <Input value={f.wp_username} onChange={set("wp_username")} required autoComplete="off" />
          </Field>
          <Field
            label="WordPress application password"
            hint={
              site?.has_wp_password
                ? "Saved. Leave empty to keep the current one."
                : "WordPress admin > Users > Profile > Application Passwords"
            }
          >
            <Input
              type="password"
              value={f.wp_app_password}
              onChange={set("wp_app_password")}
              required={!site?.has_wp_password}
              autoComplete="new-password"
              placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            />
          </Field>
          <Field label="Article language">
            <Input value={f.language} onChange={set("language")} required />
          </Field>
          <Field label="Post new articles as">
            <Select value={f.post_status} onChange={set("post_status")}>
              <option value="draft">Draft (review before publishing)</option>
              <option value="publish">Published immediately</option>
            </Select>
          </Field>
          <Field label="Sleep time after each article (seconds)" hint="Example: 300 = wait 5 minutes before the next keyword">
            <Input type="number" min={0} value={f.sleep_seconds} onChange={set("sleep_seconds")} required />
          </Field>
        </div>
        {testRow("wordpress", "Test WordPress connection", wpTest)}

        <div className="border-t border-slate-200 pt-4">
          <div className="text-sm font-semibold">Amazon for this website</div>
          <p className="mt-0.5 text-xs text-slate-500">
            This website's own Creators API credentials and tracking ID. Needed for affiliate review articles only.
            {site?.has_amazon_keys && " Credentials are saved — leave ID and Secret empty to keep them."}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Creators API Credential ID">
            <Input value={f.amazon_credential_id} onChange={set("amazon_credential_id")} autoComplete="off"
              placeholder={site?.has_amazon_keys ? "•••••••• (saved)" : ""} />
          </Field>
          <Field label="Creators API Credential Secret">
            <Input type="password" value={f.amazon_credential_secret} onChange={set("amazon_credential_secret")}
              autoComplete="new-password" placeholder={site?.has_amazon_keys ? "•••••••• (saved)" : ""} />
          </Field>
          <Field label="Credential version" hint="Shown next to the credentials in Associates Central">
            <Select value={f.amazon_version} onChange={set("amazon_version")}>
              <option value="3.1">3.1 — North America (US, CA, MX, BR)</option>
              <option value="3.2">3.2 — Europe, India, Middle East</option>
              <option value="3.3">3.3 — Far East (JP, SG, AU)</option>
              <option value="2.1">2.1 — North America (older credentials)</option>
              <option value="2.2">2.2 — Europe (older credentials)</option>
              <option value="2.3">2.3 — Far East (older credentials)</option>
            </Select>
          </Field>
          <Field label="Amazon marketplace">
            <Select value={f.marketplace} onChange={set("marketplace")}>
              {MARKETPLACES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Amazon tracking ID" hint="Used for every Amazon link on this website">
            <Input value={f.tracking_id} onChange={set("tracking_id")} placeholder="mysite-20" />
          </Field>
        </div>
        {testRow("amazon", "Test Amazon connection", amzTest)}
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving and testing…" : site ? "Save changes" : "Add website"}</Button>
        </div>
      </form>
    </Modal>
  );
}
