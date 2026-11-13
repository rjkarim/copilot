import { useEffect, useState, type FormEvent } from "react";
import {
  addAmazonAccount, AMAZON_VERSIONS, loadAmazonAccounts, MARKETPLACES, supabase, syncSite, testConnection,
  type AmazonAccount, type Site,
} from "../lib";
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
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // Amazon account: "" = none, "new" = add a new one below, otherwise a saved account's id.
  const [accounts, setAccounts] = useState<AmazonAccount[]>([]);
  const [accountId, setAccountId] = useState(site?.amazon_account_id ?? "");
  const [acc, setAcc] = useState({ name: "", credential_id: "", credential_secret: "", version: "3.1" });
  const setA = (k: keyof typeof acc) => (e: { target: { value: string } }) => setAcc({ ...acc, [k]: e.target.value });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadAmazonAccounts().then(({ accounts, error }) => {
      setAccounts(accounts);
      if (error) setError(error);
      // New website: reuse the first saved account by default. No accounts yet: offer to add one.
      setAccountId((cur) => cur || (accounts.length === 0 ? "new" : site ? "" : accounts[0].id));
    });
  }, []);

  type Result = { ok: boolean; text: string } | "testing" | null;
  const [wpTest, setWpTest] = useState<Result>(null);
  const [amzTest, setAmzTest] = useState<Result>(null);

  async function test(kind: "wordpress" | "amazon") {
    const setResult = kind === "wordpress" ? setWpTest : setAmzTest;
    setResult("testing");
    setResult(
      await testConnection(kind, site?.id, {
        url: f.url,
        wp_username: f.wp_username,
        wp_app_password: f.wp_app_password,
        marketplace: f.marketplace,
        tracking_id: f.tracking_id,
        amazon_account_id: accountId,
        amazon_credential_id: accountId === "new" ? acc.credential_id : "",
        amazon_credential_secret: accountId === "new" ? acc.credential_secret : "",
        amazon_version: accountId === "new" ? acc.version : "",
      }),
    );
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
    const fail = (message: string) => {
      setError(
        message.includes("schema cache") || message.includes("amazon_account")
          ? "Database update needed: run supabase/migrations/005_amazon_accounts_and_faq.sql in the Supabase SQL Editor, then try again."
          : message,
      );
      setBusy(false);
    };

    // A new Amazon account is saved first, so other websites can reuse it later.
    let amazonAccountId: string | null = accountId && accountId !== "new" ? accountId : null;
    if (accountId === "new" && (acc.credential_id.trim() || acc.credential_secret.trim())) {
      const saved = await addAmazonAccount({ ...acc, name: acc.name || `Amazon API (${f.name.trim()})` });
      if (!saved.id) return fail(saved.error ?? "Could not save the Amazon account.");
      amazonAccountId = saved.id;
      setAccountId(saved.id);
    }

    const row: Record<string, unknown> = {
      name: f.name.trim(),
      url: f.url.trim().replace(/\/+$/, ""),
      wp_username: f.wp_username.trim(),
      tracking_id: f.tracking_id.trim(),
      marketplace: f.marketplace,
      amazon_account_id: amazonAccountId,
    };
    // The password is only sent when a new value was typed; empty means "keep".
    if (f.wp_app_password.trim()) row.wp_app_password = f.wp_app_password.trim();

    const id = site?.id ?? crypto.randomUUID();
    const { error } = site
      ? await supabase.from("websites").update(row).eq("id", id)
      : await supabase.from("websites").insert({ id, ...row });
    if (error) return fail(error.message);
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
        </div>
        {testRow("wordpress", "Test WordPress connection", wpTest)}

        <div className="border-t border-slate-200 pt-4">
          <div className="text-sm font-semibold">Amazon for this website</div>
          <p className="mt-0.5 text-xs text-slate-500">
            Pick a saved Creators API account or add a new one. The tracking ID is this website's own. Needed for
            affiliate review articles only.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Amazon Creators API account">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">None (informative articles only)</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} — version {a.version}</option>
                ))}
                <option value="new">+ Add a new Creators API account…</option>
              </Select>
            </Field>
          </div>
          {accountId === "new" && (
            <>
              <Field label="Account name" hint="Any label that helps you recognise it later">
                <Input value={acc.name} onChange={setA("name")} placeholder="Main Associates account" />
              </Field>
              <Field label="Credential version" hint="Shown next to the credentials in Associates Central">
                <Select value={acc.version} onChange={setA("version")}>
                  {AMAZON_VERSIONS.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Creators API Credential ID">
                <Input value={acc.credential_id} onChange={setA("credential_id")} autoComplete="off" />
              </Field>
              <Field label="Creators API Credential Secret">
                <Input type="password" value={acc.credential_secret} onChange={setA("credential_secret")} autoComplete="new-password" />
              </Field>
            </>
          )}
          <Field label="Amazon tracking ID" hint="Used for every Amazon link on this website">
            <Input value={f.tracking_id} onChange={set("tracking_id")} placeholder="mysite-20" />
          </Field>
          <Field label="Amazon marketplace">
            <Select value={f.marketplace} onChange={set("marketplace")}>
              {MARKETPLACES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
        </div>
        {accountId !== "" && testRow("amazon", "Test Amazon connection", amzTest)}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving and testing…" : site ? "Save changes" : "Add website"}</Button>
        </div>
      </form>
    </Modal>
  );
}
