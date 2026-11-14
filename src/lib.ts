import { createContext, useContext, useEffect, useRef } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

export const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext)!;

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key && !url.includes("YOUR-PROJECT-REF"));
export const supabase = createClient(url || "https://placeholder.supabase.co", key || "placeholder");

export type Site = {
  id: string;
  name: string;
  url: string;
  wp_username: string;
  tracking_id: string;
  marketplace: string;
  language: string;
  post_status: "draft" | "publish";
  sleep_seconds: number;
  paused: boolean;
  wp_published: number | null;
  wp_drafts: number | null;
  wp_synced_at: string | null;
  wp_error: string | null;
  next_run_at: string;
  has_wp_password: boolean;
  queued: number;
  writing: number;
  completed: number;
  failed: number;
  current_keyword: string | null;
  current_step: string | null;
  current_progress: number | null;
  amazon_version: string;
  has_amazon_keys: boolean;
  amazon_account_id: string | null;
  // Old-post updater
  update_enabled: boolean;
  update_sleep_seconds: number;
  update_product_count: number;
  update_include_faq: boolean;
  update_next_run_at: string;
  update_cursor: string | null;
  update_remaining: number | null;
  update_error: string | null;
  updates_done: number;
  updates_failed: number;
  update_keyword: string | null;
  update_step: string | null;
  update_progress: number | null;
};

/** A saved Amazon Creators API account (the ID and Secret are never readable here). */
export type AmazonAccount = { id: string; name: string; version: string };

export const AMAZON_VERSIONS = [
  ["3.1", "3.1 — North America (US, CA, MX, BR)"],
  ["3.2", "3.2 — Europe, India, Middle East"],
  ["3.3", "3.3 — Far East (JP, SG, AU)"],
  ["2.1", "2.1 — North America (older credentials)"],
  ["2.2", "2.2 — Europe (older credentials)"],
  ["2.3", "2.3 — Far East (older credentials)"],
];

export async function loadAmazonAccounts(): Promise<{ accounts: AmazonAccount[]; error: string | null }> {
  const { data, error } = await supabase.from("amazon_accounts").select("id,name,version").order("created_at");
  if (error) {
    return {
      accounts: [],
      error: "Database update needed: run supabase/migrations/005_amazon_accounts_and_faq.sql in the Supabase SQL Editor, then reload.",
    };
  }
  return { accounts: data as AmazonAccount[], error: null };
}

/** Saves a new Amazon account. Returns its id, or an error message. */
export async function addAmazonAccount(a: {
  name: string; credential_id: string; credential_secret: string; version: string;
}): Promise<{ id?: string; error?: string }> {
  if (!a.credential_id.trim() || !a.credential_secret.trim()) return { error: "Enter both the Credential ID and the Credential Secret." };
  const id = crypto.randomUUID();
  const { error } = await supabase.from("amazon_accounts").insert({
    id,
    name: a.name.trim() || "Amazon API account",
    credential_id: a.credential_id.trim(),
    credential_secret: a.credential_secret.trim(),
    version: a.version,
  });
  return error ? { error: error.message } : { id };
}

export type Category = { id: number; name: string };

/** Reads the website's categories live from WordPress (through the background function). */
export async function fetchCategories(id: string): Promise<{ categories: Category[]; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("writer", {
    body: { action: "categories", website_id: id },
  });
  if (error) return { categories: [], error: await writerError(error) };
  return data?.ok ? { categories: data.categories, error: null } : { categories: [], error: data?.error ?? "Could not load categories." };
}

export type Article = {
  id: string;
  seq: number;
  website_id: string;
  keyword: string;
  type: "review" | "informative";
  status: "queued" | "writing" | "completed" | "failed";
  step: string | null;
  progress: number;
  title: string | null;
  word_count: number | null;
  wp_post_url: string | null;
  wp_status: string | null;
  wp_category_name: string | null;
  kind: "new" | "update";
  old_title: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export const MARKETPLACES = [
  "www.amazon.com", "www.amazon.ca", "www.amazon.com.mx", "www.amazon.com.br",
  "www.amazon.co.uk", "www.amazon.de", "www.amazon.fr", "www.amazon.it", "www.amazon.es",
  "www.amazon.nl", "www.amazon.in", "www.amazon.ae", "www.amazon.sa", "www.amazon.se",
  "www.amazon.pl", "www.amazon.com.tr", "www.amazon.co.jp", "www.amazon.sg", "www.amazon.com.au",
];

/** Calls `reload` now, on every database change (live), and every 10s as a safety net. */
export function useLive(reload: () => void, key: string) {
  const fn = useRef(reload);
  fn.current = reload;
  useEffect(() => {
    fn.current();
    let timer: number | undefined;
    const kick = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn.current(), 250);
    };
    const channel = supabase
      .channel(`live-${key}-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "articles" }, kick)
      .on("postgres_changes", { event: "*", schema: "public", table: "websites" }, kick)
      .subscribe();
    const poll = window.setInterval(() => fn.current(), 10000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [key]);
}

/** Turns a failed call to the background writer into the real reason, in plain words. */
async function writerError(error: unknown): Promise<string> {
  const res = (error as { context?: unknown })?.context;
  if (res instanceof Response) {
    const body = await res.clone().json().catch(() => null);
    const reason: string = body?.error ?? body?.message ?? body?.msg ?? "";
    if (reason === "Unknown action.") {
      return "The background writer on Supabase is an older version. Deploy it again: npx.cmd supabase functions deploy writer --no-verify-jwt";
    }
    if (res.status === 404) return "The 'writer' function is not deployed on Supabase yet (README step 3).";
    return `Background writer error (${res.status})${reason ? `: ${reason}` : ""}`;
  }
  return "Could not reach the background writer. Check your internet connection and that the 'writer' function is deployed.";
}

/** Asks the background function to test the WordPress login and refresh post counts. */
export async function syncSite(id: string): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("writer", {
    body: { action: "sync", website_id: id },
  });
  if (error) return writerError(error);
  return data?.ok ? null : (data?.error ?? "Sync failed.");
}

/** Tests WordPress, Amazon or the AI provider with the values typed in a form (nothing is saved). */
export async function testConnection(
  kind: "wordpress" | "amazon" | "ai",
  websiteId: string | undefined,
  fields: Record<string, string>,
): Promise<{ ok: boolean; text: string }> {
  const { data, error } = await supabase.functions.invoke("writer", {
    body: { action: `test_${kind}`, website_id: websiteId, fields },
  });
  if (error) return { ok: false, text: await writerError(error) };
  return data?.ok ? { ok: true, text: data.message } : { ok: false, text: data?.error ?? "Test failed." };
}

/** Saves a website's sleep time; it takes effect immediately. Returns an error message or null. */
export async function saveSleep(websiteId: string, lane: "new" | "update", seconds: number): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke("writer", {
    body: { action: "set_sleep", website_id: websiteId, lane, seconds },
  });
  if (error) return writerError(error);
  return data?.ok ? null : (data?.error ?? "Could not save the sleep time.");
}

export function sleepLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)} min`;
}
