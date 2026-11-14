// AffiliWriter background writer (Supabase Edge Function).
//
// Two kinds of callers:
//  1. The database scheduler (x-worker-secret header): { action: "write", article_id }
//     Writes one article and posts it to the website's WordPress.
//  2. The logged-in user from the app: { action: "sync", website_id }
//     Tests the WordPress connection and refreshes published/draft counts.

import { createClient } from "npm:@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const WORKER_SECRET = Deno.env.get("WORKER_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));

  if (body.action === "write") {
    if (!WORKER_SECRET || req.headers.get("x-worker-secret") !== WORKER_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    // Answer right away and keep writing in the background.
    EdgeRuntime.waitUntil(writeArticle(String(body.article_id)));
    return json({ ok: true }, 202);
  }
  // From the scheduler: rewrite the next oldest post of a website.
  if (body.action === "update_next") {
    if (!WORKER_SECRET || req.headers.get("x-worker-secret") !== WORKER_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }
    EdgeRuntime.waitUntil(updateNext(String(body.website_id)));
    return json({ ok: true }, 202);
  }

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return json({ ok: false, error: "Please log in again." }, 401);

  if (body.action === "sync") {
    const { data: site } = await admin.from("websites").select("*")
      .eq("id", body.website_id).eq("user_id", auth.user.id).maybeSingle();
    if (!site) return json({ ok: false, error: "Website not found." });
    return json(await syncCounts(site));
  }
  // Connection tests from the website form. Uses what is typed in the form;
  // for an existing website, empty secret fields fall back to the saved values.
  if (body.action === "test_wordpress" || body.action === "test_amazon") {
    let site: Row = {};
    if (body.website_id) {
      const { data } = await admin.from("websites").select("*")
        .eq("id", body.website_id).eq("user_id", auth.user.id).maybeSingle();
      site = data ?? {};
    }
    site.user_id = auth.user.id;
    // "new" = the form is adding a new Amazon account: test the typed credentials, not saved ones.
    if (body.fields?.amazon_account_id === "new") {
      site.amazon_account_id = null;
      site.amazon_credential_id = null;
      site.amazon_credential_secret = null;
    }
    const allowed = ["url", "wp_username", "wp_app_password", "amazon_account_id", "amazon_credential_id",
      "amazon_credential_secret", "amazon_version", "marketplace", "tracking_id"];
    for (const k of allowed) {
      if (k === "amazon_account_id" && body.fields?.[k] === "new") continue;
      const v = body.fields?.[k];
      if (typeof v === "string" && v.trim()) site[k] = v.trim();
    }
    try {
      if (body.action === "test_wordpress") {
        const me = await wpMe(site);
        return json({
          ok: me.canPublish,
          message: `Connected to WordPress as ${me.name}.`,
          error: `Logged in as ${me.name}, but this user is not allowed to publish posts. Use an Editor or Administrator account.`,
        });
      }
      if (!site.tracking_id) throw new Error("Enter the Amazon tracking ID first.");
      const items = await searchAmazon(site, "water bottle");
      return json({ ok: true, message: `Connected to Amazon. A test search on ${site.marketplace} returned ${items.length} products for tracking ID ${site.tracking_id}.` });
    } catch (e) {
      return json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 400) });
    }
  }
  // AI connection test from Settings. Uses what is typed; an empty key falls back to the saved one.
  if (body.action === "test_ai") {
    const { data: saved } = await admin.from("settings").select("*").eq("user_id", auth.user.id).maybeSingle();
    const cfg: Row = { ...(saved ?? {}) };
    for (const k of ["openai_base_url", "openai_api_key", "openai_model"]) {
      const v = body.fields?.[k];
      if (typeof v === "string" && v.trim()) cfg[k] = v.trim();
    }
    try {
      if (!cfg.openai_api_key) throw new Error("Enter the API key first.");
      // Same kind of request the article writer sends, just tiny.
      await askOpenAI(cfg, "Reply with one JSON object only.", 'Return exactly this JSON: {"ok": true}');
      const host = new URL(String(cfg.openai_base_url || "https://api.openai.com/v1")).host;
      return json({ ok: true, message: `Connected to ${host}. Model ${cfg.openai_model} answered correctly.` });
    } catch (e) {
      return json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 400) });
    }
  }
  if (body.action === "categories") {
    const { data: site } = await admin.from("websites").select("*")
      .eq("id", body.website_id).eq("user_id", auth.user.id).maybeSingle();
    if (!site) return json({ ok: false, error: "Website not found." });
    try {
      return json({ ok: true, categories: await wpCategories(site) });
    } catch (e) {
      return json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }
  }
  return json({ ok: false, error: "Unknown action." }, 400);
});

// ------------------------------------------------------------------ writing

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function writeArticle(id: string) {
  const { data: a } = await admin.from("articles").select("*").eq("id", id).maybeSingle();
  if (!a || a.status !== "writing") return;
  const { data: site } = await admin.from("websites").select("*").eq("id", a.website_id).single();
  const { data: cfg } = await admin.from("settings").select("*").eq("user_id", a.user_id).maybeSingle();
  // Every update only applies while this run still owns the article. If you
  // cancel it (or it is retried), this run's updates stop having any effect.
  const set = (patch: Row) =>
    admin.from("articles").update(patch).eq("id", id).eq("status", "writing").eq("attempts", a.attempts);
  const stillMine = async () => {
    const { data } = await admin.from("articles").select("status,attempts").eq("id", id).maybeSingle();
    return data?.status === "writing" && data.attempts === a.attempts;
  };
  let cancelled = false;
  // "update" = rewrite an existing WordPress post in place; "new" = create a post.
  const isUpdate = a.kind === "update";
  // The main keyword (for an old post: the words of its URL) drives the title and the text.
  const keyword: string = a.keyword;
  // The Amazon search uses just the product words of it ("which is the best tent" -> "tent").
  const searchKeyword: string = isUpdate ? productKeyword(a.keyword) : a.keyword;

  try {
    let title: string = a.title ?? "";
    let html: string = a.content_html ?? "";
    let excerpt = "";

    // A retry after a failed WordPress upload reuses the text already written.
    if (!html) {
      if (!cfg?.openai_api_key) throw new Error("Add your AI API key in Settings.");

      let products: Product[] = [];
      if (a.type === "review") {
        await set({ step: "Finding Amazon products", progress: 15 });
        if (!site.tracking_id) throw new Error("This website has no Amazon tracking ID. Edit the website and add one.");
        products = await searchAmazon(site, searchKeyword);
        if (products.length === 0) throw new Error(`Amazon returned no products for "${searchKeyword}".`);
      }

      const report: Report = (step, progress) => set({ step, progress });
      cfg._usage = { in: 0, out: 0 };
      const draft = a.type === "review"
        ? await writeReview(cfg, site, keyword, products, Number(a.product_count) || 5, a.include_faq !== false, report)
        : await writeInformative(cfg, site, keyword, a.include_faq !== false, report);
      title = capitalize(noYear(draft.title));
      // Updated posts use the H2 tag only once; every later heading moves one level down.
      html = isUpdate ? singleH2(draft.html) : draft.html;
      excerpt = draft.excerpt;
      await set({ title, content_html: html, word_count: countWords(html) });
      // Separate update: if the token columns are missing, the article itself is still saved.
      if (cfg._usage.out > 0) await set({ tokens_in: cfg._usage.in, tokens_out: cfg._usage.out });
    }

    // Cancelled while writing: stop here, post nothing to WordPress.
    if (!(await stillMine())) {
      cancelled = true;
      return;
    }
    await set({ step: isUpdate ? "Replacing the old post" : "Publishing to WordPress", progress: 80 });
    const post = isUpdate
      ? await wpUpdatePost(site, Number(a.wp_post_id), title, html, excerpt, String(a.wp_post_url ?? ""))
      : await wpCreatePost(site, title, html, excerpt, a.wp_category_id, a.keyword);
    await set({
      status: "completed", step: "Done", progress: 100, error: null,
      wp_post_id: post.id, wp_post_url: post.link, wp_status: post.status,
      finished_at: new Date().toISOString(),
    });
    await syncCounts(site);
  } catch (e) {
    await set({
      status: "failed", step: null,
      error: String(e instanceof Error ? e.message : e).slice(0, 600),
      finished_at: new Date().toISOString(),
    });
  } finally {
    // Sleep time: this website's next keyword may not start before this moment.
    // (Not after a cancel, so a retry can start straight away.)
    const wake = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    if (isUpdate) {
      // The update lane has its own sleep time. After a cancel it may continue straight away.
      await admin.from("websites")
        .update({ update_next_run_at: wake(cancelled ? 0 : site.update_sleep_seconds) }).eq("id", site.id);
    } else if (!cancelled) {
      await admin.from("websites").update({ next_run_at: wake(site.sleep_seconds) }).eq("id", site.id);
    }
  }
}

// ------------------------------------------------------------------ updating old posts

const QUESTION = /^\s*(how|why|what|when|where|which|who|whose|can|could|do|does|did|is|are|was|were|should|will|would)\b/i;
const NUMBERED = /\b(top\s*\d+|\d+\s+(best|top)|\d+\s+[\w' -]{0,40}?picks?)\b/i;
const MONEY = /\b(best|top|picks?|reviews?|reviewed|buying guide|buyer'?s guide)\b/i;

/**
 * Money content or informational, judged from the old title and the URL words.
 * Anything with "best" or a numbered list ("10 Best", "Top 5", "7 Picks") is money
 * content, even as a question ("Which Is the Best ..."). Other questions are informational.
 */
function detectIntent(title: string, keyword = ""): "review" | "informative" {
  const text = `${title} ${keyword}`;
  if (NUMBERED.test(text) || /\bbest\b/i.test(text)) return "review";
  if (QUESTION.test(title)) return "informative";
  return MONEY.test(text) ? "review" : "informative";
}

/** The main keyword of an old post: the words of its URL, without hyphens, years or a leading count. */
function mainKeyword(slug: string, fallbackTitle: string): string {
  let words = slug;
  try {
    words = decodeURIComponent(slug);
  } catch { /* keep as is */ }
  const clean = (s: string) =>
    s.replace(/[-_]+/g, " ")
      .replace(/\b(19|20)\d{2}\b/g, " ")       // years
      .replace(/^(\s*top)?\s*\d+\s+/i, "$1 ")  // "10 best ..." / "top 10 ..."
      .replace(/\s+\d{1,2}\s*$/, " ")          // WordPress duplicate suffix "-2"
      .replace(/\s+/g, " ").trim();
  return clean(words) || clean(fallbackTitle) || fallbackTitle;
}

/** Titles never carry a year: "Top 5 Tents in 2024: ..." -> "Top 5 Tents: ...". */
function noYear(title: string): string {
  return title
    .replace(/\s*\b(in|of|for)\s+\(?(19|20)\d{2}\)?(?=\W|$)/gi, "")
    .replace(/\s*[\[(]?\b(19|20)\d{2}\b[\])]?/g, "")
    .replace(/\s+([:,!?])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s:,-]+|[\s:,-]+$/g, "");
}

/**
 * Capitalize Case: every word of a title starts with a capital letter, also after a
 * hyphen ("top-rated" -> "Top-Rated"). Words with their own capitals (USB, iPhone) are kept.
 */
function capitalize(title: string): string {
  return title.replace(/[^\s-]+/g, (word) =>
    /[A-Z]/.test(word.slice(1)) ? word : word.replace(/\p{L}/u, (c) => c.toUpperCase()));
}

/** "which is the best camping lantern" -> "camping lantern" (what to search on Amazon). */
function productKeyword(title: string): string {
  const drop = /^(the|a|an|our|top|best|picks?|reviews?|reviewed|of|in|for|and|which|what|who|is|are|\d+|&)$/i;
  const words = title.split(/[:|()\[\]]| [-–—] /)[0].replace(/\b(19|20)\d{2}\b/g, " ").split(/\s+/).filter(Boolean);
  while (words.length && drop.test(words[0])) words.shift();
  while (words.length && drop.test(words[words.length - 1])) words.pop();
  return words.join(" ") || title;
}

/** Keeps the first H2; later H2s become H3, and the headings below them move down one level too. */
function singleH2(html: string): string {
  const first = html.search(/<h2[\s>]/i);
  if (first < 0) return html;
  const end = html.indexOf("</h2>", first);
  if (end < 0) return html;
  const rest = html.slice(end + 5)
    .replace(/<(\/?)h4(?=[\s>])/gi, "<$1h5")
    .replace(/<(\/?)h3(?=[\s>])/gi, "<$1h4")
    .replace(/<(\/?)h2(?=[\s>])/gi, "<$1h3");
  return html.slice(0, end + 5) + rest;
}

// Takes the oldest post that has not been handled yet, decides its intent from
// the title, and rewrites it. One post per call; the scheduler calls again after
// the website's update sleep time.
async function updateNext(siteId: string) {
  const { data: site } = await admin.from("websites").select("*").eq("id", siteId).maybeSingle();
  if (!site || !site.update_enabled) return;
  const patchSite = (patch: Row) => admin.from("websites").update(patch).eq("id", siteId);
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  let articleId: string | null = null;
  try {
    // A failed update that you clicked Retry on goes first.
    const { data: again } = await admin.from("articles").select("id,attempts")
      .eq("website_id", siteId).eq("kind", "update").eq("status", "queued").order("seq").limit(1).maybeSingle();
    if (again) {
      const { data: claimed } = await admin.from("articles")
        .update({
          status: "writing", started_at: new Date().toISOString(), finished_at: null, progress: 5,
          step: "Starting", attempts: again.attempts + 1, error: null,
        })
        .eq("id", again.id).eq("status", "queued").select("id").maybeSingle();
      articleId = claimed?.id ?? null;
    } else {
      const next = await wpNextOldPost(site);
      if (!next) {
        // Every post has been handled: switch the updater off.
        await patchSite({ update_enabled: false, update_remaining: 0, update_error: null });
        return;
      }
      const oldTitle = unesc(String(next.post.title?.rendered ?? "")).replace(/<[^>]+>/g, "").trim() || `Post ${next.post.id}`;
      // The main keyword is the post's URL without the hyphens.
      const keyword = mainKeyword(String(next.post.slug ?? ""), oldTitle);
      const { data: row, error } = await admin.from("articles").insert({
        user_id: site.user_id, website_id: siteId, kind: "update",
        keyword, old_title: oldTitle, type: detectIntent(oldTitle, keyword),
        status: "writing", started_at: new Date().toISOString(), attempts: 1, progress: 5, step: "Starting",
        wp_post_id: next.post.id, wp_post_url: next.post.link, wp_status: "publish",
        product_count: site.update_product_count, include_faq: site.update_include_faq,
      }).select("id").single();
      if (error) throw new Error(error.message);
      articleId = row.id;
      await patchSite({ update_cursor: next.post.date, update_remaining: Math.max(0, next.remaining - 1), update_error: null });
    }
  } catch (e) {
    // Could not even pick a post (for example the WordPress login failed): show why and try again later.
    await patchSite({
      update_error: String(e instanceof Error ? e.message : e).slice(0, 400),
      update_next_run_at: later(Math.max(60, site.update_sleep_seconds)),
    });
    return;
  }
  if (articleId) await writeArticle(articleId);
  else await patchSite({ update_next_run_at: later(0) });
}

/** The oldest published post not handled by this app yet, plus how many are left from there. */
async function wpNextOldPost(site: Row): Promise<{ post: Row; remaining: number } | null> {
  const { api, headers } = wp(site);
  let cursor: string | null = site.update_cursor ?? null;
  for (let round = 0; round < 10; round++) {
    // "after" is exclusive, so step one second back and skip the posts already handled.
    const after = cursor ? new Date(new Date(cursor + "Z").getTime() - 1000).toISOString().slice(0, 19) : null;
    const res = await fetch(
      `${api}/posts?status=publish&orderby=date&order=asc&per_page=20&_fields=id,date,link,slug,title` +
        (after ? `&after=${encodeURIComponent(after)}` : ""),
      { headers },
    );
    if (!res.ok) throw new Error(await wpError(res));
    const posts: Row[] = await res.json();
    if (posts.length === 0) return null;
    const remaining = Number(res.headers.get("X-WP-Total") ?? posts.length);
    // Posts this app wrote or already updated are skipped.
    const { data: seen } = await admin.from("articles").select("wp_post_id")
      .eq("website_id", site.id).in("wp_post_id", posts.map((p) => p.id));
    const done = new Set((seen ?? []).map((r) => Number(r.wp_post_id)));
    const post = posts.find((p) => !done.has(Number(p.id)));
    if (post) return { post, remaining: remaining - posts.indexOf(post) };
    if (posts.length < 20) return null;
    cursor = String(posts[posts.length - 1].date);
    if (cursor === site.update_cursor) cursor = new Date(new Date(cursor + "Z").getTime() + 1000).toISOString().slice(0, 19);
  }
  return null;
}

/**
 * Replaces title, content and excerpt of an existing post and sets its date to now.
 * The URL (slug) and status stay as they are. If the website puts the date in its
 * post addresses (/2021/05/post-name/), the date is left alone, because changing
 * it would change the URL.
 */
async function wpUpdatePost(site: Row, postId: number, title: string, content: string, excerpt: string, oldLink: string) {
  const { api, headers } = wp(site);
  const dateInUrl = /\/(19|20)\d{2}\/\d{1,2}(\/|$)/.test(oldLink);
  const res = await fetch(`${api}/posts/${postId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title, content, excerpt,
      ...(dateInUrl ? {} : { date_gmt: new Date().toISOString().slice(0, 19) }),
    }),
  });
  if (!res.ok) throw new Error(await wpError(res));
  return await res.json() as { id: number; link: string; status: string };
}

// ------------------------------------------------------------------ Amazon Creators API

type Product = {
  asin: string; title: string; features: string[]; brand: string; url: string; image: string;
  /** Amazon customer star rating and review count, when Amazon provides them. */
  rating: number | null; reviews: number | null;
};

// Credential version -> where to get the access token.
// 3.x = Login with Amazon (current). 2.x = older Cognito-based credentials.
const LWA: Record<string, string> = {
  "3.1": "https://api.amazon.com/auth/o2/token",
  "3.2": "https://api.amazon.co.uk/auth/o2/token",
  "3.3": "https://api.amazon.co.jp/auth/o2/token",
};
const COGNITO: Record<string, string> = {
  "2.1": "https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token",
  "2.2": "https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token",
  "2.3": "https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token",
};

// A website uses one of the user's saved Amazon accounts (reusable across
// websites). Older websites may still carry their own credentials.
async function amazonCreds(site: Row): Promise<Row> {
  if (site.amazon_account_id) {
    const { data } = await admin.from("amazon_accounts").select("*")
      .eq("id", site.amazon_account_id).eq("user_id", site.user_id).maybeSingle();
    if (data) {
      return {
        amazon_credential_id: data.credential_id,
        amazon_credential_secret: data.credential_secret,
        amazon_version: data.version,
      };
    }
  }
  return site;
}

async function amazonAuthHeader(cfg: Row): Promise<string> {
  const v = String(cfg.amazon_version || "3.1");
  let res: Response;
  if (COGNITO[v]) {
    res = await fetch(COGNITO[v], {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${cfg.amazon_credential_id}:${cfg.amazon_credential_secret}`),
      },
      body: "grant_type=client_credentials&scope=creatorsapi/default",
    });
  } else {
    res = await fetch(LWA[v] ?? LWA["3.1"], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: cfg.amazon_credential_id,
        client_secret: cfg.amazon_credential_secret,
        scope: "creatorsapi::default",
      }),
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Amazon login failed (${res.status}). Check the Credential ID, Secret and Version of the Amazon account.`);
  }
  return COGNITO[v] ? `Bearer ${data.access_token}, Version ${v}` : `Bearer ${data.access_token}`;
}

// Each website has its own Creators API credentials and tracking ID.
// One request fetches 10 products; the article later keeps the best few.
async function searchAmazon(site: Row, keyword: string): Promise<Product[]> {
  const creds = await amazonCreds(site);
  if (!creds.amazon_credential_id || !creds.amazon_credential_secret) {
    throw new Error("This website has no Amazon Creators API account. Edit the website and choose or add one.");
  }
  const authorization = await amazonAuthHeader(creds);
  const base = ["images.primary.large", "itemInfo.title", "itemInfo.features", "itemInfo.byLineInfo"];
  const call = (resources: string[]) =>
    fetch("https://creatorsapi.amazon/catalog/v1/searchItems", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json", "x-marketplace": site.marketplace },
      body: JSON.stringify({
        keywords: keyword.replace(/^\s*(the\s+)?(best|top)(\s+\d+)?\s+/i, ""),
        marketplace: site.marketplace,
        partnerTag: site.tracking_id,
        itemCount: 10,
        resources,
      }),
    });
  // Customer ratings are not available to every Associates account; if Amazon
  // rejects the request because of them, search again without ratings.
  let res = await call([...base, "customerReviews.starRating", "customerReviews.count"]);
  if (res.status === 400 || res.status === 403) {
    const plain = await call(base);
    if (plain.ok) res = plain;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message ?? data?.errors?.[0]?.message ?? JSON.stringify(data).slice(0, 200);
    throw new Error(`Amazon product search failed (${res.status}): ${msg}`);
  }
  const items: Row[] = data?.searchResult?.items ?? [];
  return items.filter((i) => i?.asin && i?.itemInfo?.title?.displayValue).map((i) => ({
    asin: i.asin,
    title: i.itemInfo.title.displayValue,
    features: (i.itemInfo?.features?.displayValues ?? []).slice(0, 8),
    brand: i.itemInfo?.byLineInfo?.brand?.displayValue ?? "",
    url: i.detailPageURL ?? `https://${site.marketplace}/dp/${i.asin}?tag=${encodeURIComponent(site.tracking_id)}`,
    image: i.images?.primary?.large?.url ?? "",
    rating: Number(i.customerReviews?.starRating?.value) || null,
    reviews: Number(i.customerReviews?.count) || null,
  }));
}

// ------------------------------------------------------------------ OpenAI

async function askOpenAI(cfg: Row, system: string, user: string): Promise<Row> {
  // Works with OpenAI and any OpenAI-compatible provider (custom base URL).
  const base = String(cfg.openai_base_url || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) throw new Error("The AI API base URL in Settings must start with https://");
  // Time limit for one AI request. Requests are small now, so one that takes this
  // long is stuck; it is retried once, then the keyword fails with a clear message.
  const limit = Number(Deno.env.get("AI_TIMEOUT_SECONDS") ?? 170);
  const call = (jsonMode: boolean) =>
    fetch(`${base}/chat/completions`, {
      signal: AbortSignal.timeout(limit * 1000),
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.openai_api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.openai_model || "gpt-4o-mini",
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
  let res: Response;
  try {
    res = await call(true);
    // Some providers do not support JSON mode; ask again without it.
    if (res.status === 400 || res.status === 422) res = await call(false);
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`The AI model took longer than ${limit} seconds to answer. Click Retry, or choose a faster model in Settings.`);
    }
    throw new Error(`Could not reach the AI provider at ${new URL(base).host}. Check the API base URL in Settings.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message ?? (typeof data?.error === "string" ? data.error : "request failed");
    // Names the address that was called, so a wrong base URL in Settings is easy to spot.
    throw new Error(`AI provider error (${res.status}) from ${new URL(base).host}, model ${cfg.openai_model}: ${detail}`);
  }
  // Add up the tokens the provider reports, for the Statistics page.
  if (cfg._usage && data?.usage) {
    cfg._usage.in += Number(data.usage.prompt_tokens) || 0;
    cfg._usage.out += Number(data.usage.completion_tokens) || 0;
  }
  const text = String(data?.choices?.[0]?.message?.content ?? "");
  try {
    // Tolerates code fences or extra words around the JSON object.
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new Error("The AI returned an answer that could not be read. Retry the keyword.");
  }
}

// How every article should read. Kept short on purpose: it is sent with every
// AI request, so each extra line here costs tokens on every article.
const STYLE = [
  "You are a veteran product reviewer and editor. Write like a knowledgeable friend: specific, practical, honest.",
  "Rules: lead with what the reader needs; explain what a feature means in real use; vary sentence length; 2-4 sentences per paragraph; active voice; address the reader as 'you'; give honest trade-offs. No filler or cliches ('look no further', 'game-changer', 'when it comes to', 'dive in', 'elevate', 'in conclusion'), no hype, no exclamation marks, no emojis.",
  "SEO: use the exact keyword naturally in the first 100 words and once in a subheading; elsewhere use natural variations. Never stuff keywords.",
  "HTML fragments may use only: p, h3, ul, ol, li. No h1 or h2, links, images or markdown. Never bold or italicise anything: no strong, b, em or i tags, and never highlight the keyword.",
  "Titles never contain a year.",
  "Reply with one JSON object only, in the requested shape.",
].join("\n");

const REVIEW_RULES =
  "\nUse only the product facts given. Never invent prices, ratings, test results or specifications, " +
  "and never claim to have bought or tested a product. Drawbacks must be real.";

type Draft = { title: string; html: string; excerpt: string };
type Report = (step: string, progress: number) => Promise<unknown>;

// An article is written as one short "plan" request followed by a few small
// requests that run at the same time. This is far quicker than one huge request,
// and a slow or failed part is retried on its own.
async function inParallel<T>(jobs: (() => Promise<T>)[], report: Report): Promise<T[]> {
  let done = 0;
  return await Promise.all(jobs.map(async (job) => {
    let out: T;
    try {
      out = await job();
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      out = await job(); // one retry
    }
    done++;
    await report(`Writing sections (${done}/${jobs.length})`, 45 + Math.round((33 * done) / jobs.length));
    return out;
  }));
}

const para = (text: unknown) => (text ? `<p>${esc(String(text))}</p>\n` : "");
/** AI-written HTML with any bold or italic markup removed, so keywords are never highlighted. */
const plain = (html: unknown) => String(html ?? "").replace(/<\/?(strong|b|em|i)(\s[^>]*)?>/gi, "");

function faqHtml(heading: unknown, faq: unknown) {
  if (!Array.isArray(faq) || faq.length === 0) return "";
  return `<h2>${esc(String(heading || "Frequently Asked Questions"))}</h2>\n` +
    faq.map((f: Row) => `<h3>${esc(String(f.q ?? ""))}</h3>\n<p>${esc(String(f.a ?? ""))}</p>`).join("\n") + "\n";
}
const FAQ_SHAPE = `"faq": [{"q": string, "a": string (30-50 words, direct answer first)}] (5 real questions people ask), `;

async function writeInformative(cfg: Row, site: Row, keyword: string, withFaq: boolean, report: Report): Promise<Draft> {
  await report("Planning article", 35);
  const plan = await askOpenAI(
    cfg,
    STYLE,
    `Plan an informative article in ${site.language} for the keyword "${keyword}". ` +
      `Cover what a searcher of this keyword wants to know, in the order they need it.\n` +
      `JSON shape: {"title": string (creative and specific, 50-62 characters, keyword near the start, every word capitalised), ` +
      `"meta_description": string (140-155 characters, includes the keyword), ` +
      `"intro_html": string (3-5 short paragraphs; answer the main question straight away), ` +
      `"outline": [{"heading": string, "brief": string (max 20 words: what the section covers)}] (5-6 sections, no FAQ or conclusion), ` +
      (withFaq ? `"faq_heading": string, ` : "") + `"conclusion_heading": string}`,
  );
  if (!plan.title || !Array.isArray(plan.outline) || plan.outline.length === 0) {
    throw new Error("The AI returned an incomplete article plan. Retry the keyword.");
  }
  const outline: Row[] = plan.outline.slice(0, 6);
  const context = `Article "${plan.title}", keyword "${keyword}", language ${site.language}. ` +
    `Sections: ${outline.map((s) => s.heading).join(" | ")}\n`;

  const [closing, ...sections] = await inParallel<Row>([
    () => askOpenAI(cfg, STYLE,
      context + `Write the closing parts.\nJSON shape: {` + (withFaq ? FAQ_SHAPE : "") +
        `"conclusion_html": string (60-90 words: the key takeaway and a next step)}`),
    ...outline.map((s) => () => askOpenAI(cfg, STYLE,
      context + `Write only the section "${s.heading}" (${s.brief}). Do not repeat the heading or cover other sections.\n` +
        `JSON shape: {"html": string (130-200 words; use h3 or a list where it helps)}`)),
  ], report);

  let html = `${plain(plan.intro_html)}\n`;
  outline.forEach((s, i) => { html += `<h2>${esc(String(s.heading ?? ""))}</h2>\n${plain(sections[i]?.html)}\n`; });
  if (withFaq) html += faqHtml(plan.faq_heading, closing.faq);
  html += `<h2>${esc(String(plan.conclusion_heading || "Final Thoughts"))}</h2>\n${plain(closing.conclusion_html)}`;
  return { title: String(plan.title), html, excerpt: String(plan.meta_description ?? "") };
}

// Numbered title patterns. One is picked at random for each article, so a
// website's titles do not all start with "Top N". <kw> is the keyword.
const TITLE_PATTERNS = [
  `"N Best <kw> for ..."`,
  `"Top N <kw> for ..."`,
  `"N <kw> Picks for ..."`,
  `"Top N <kw> Picks ..."`,
  `"The N Best <kw> ..."`,
  `"Best <kw>: N Top Picks for ..."`,
  `"N Top-Rated <kw> for ..."`,
  `"N <kw> Worth Buying for ..."`,
  `"<kw>: N Best Options for ..."`,
  `"N Best <kw> That ..."`,
  `"Our N Favorite <kw> for ..."`,
  `"N Must-Have <kw> for ..."`,
];
function titlePattern(count: number): string {
  const pick = TITLE_PATTERNS[Math.floor(Math.random() * TITLE_PATTERNS.length)];
  return pick.replace(/\bN\b/g, String(count));
}

// Review layout: intro (3-5 paragraphs), "at a glance" table, numbered reviews
// (image, button, one detail paragraph, likes, improvements, one closing
// paragraph), buying guide, optional FAQ, conclusion.
async function writeReview(
  cfg: Row, site: Row, keyword: string, products: Product[], wanted: number, withFaq: boolean, report: Report,
): Promise<Draft> {
  const count = Math.max(1, Math.min(wanted, products.length, 10));
  const english = /^english$/i.test(String(site.language).trim());
  // Product facts are trimmed: long feature lists cost tokens without improving the text.
  const facts = (p: Product, features: number, chars: number) => ({
    asin: p.asin, name: p.title.slice(0, 140), brand: p.brand,
    features: p.features.slice(0, features).map((f) => f.slice(0, chars)),
    ...(p.rating ? { rating: p.rating, reviews: p.reviews } : {}),
  });

  // 1) Plan: choose the best products and write the short framing parts.
  await report("Choosing the best products", 35);
  const plan = await askOpenAI(
    cfg,
    STYLE + REVIEW_RULES,
    `Plan a product roundup in ${site.language} for the keyword "${keyword}".\n` +
      `Pick the ${count} best of these Amazon products: they must match the keyword, differ from each other ` +
      `(no colour or size variants) and cover different needs or budgets. Best first. Keep each asin exactly.\n` +
      `Products: ${JSON.stringify(products.map((p) => facts(p, 4, 110)))}\n` +
      `JSON shape: {"title": string (creative, click-worthy and SEO-friendly, 50-65 characters, every word capitalised; ` +
      `it MUST contain the number ${count} and the keyword, and it MUST follow this pattern: ${titlePattern(count)} ` +
      `Fill the "..." with a specific benefit, use or audience that fits these products; do not repeat a word such as "Best" twice; ` +
      `no generic "Reviews & Buyer's Guide" ending), ` +
      `"meta_description": string (140-155 characters, includes the keyword and the number ${count}), ` +
      `"intro_html": string (3-5 short paragraphs: the buyer's problem, what matters when choosing, how these picks were selected, what the guide covers), ` +
      `"glance_heading": string (like "Our Top ${count} <keyword> Picks at a Glance"), ` +
      `"reviews_heading": string (like "Top ${count} <keyword>: Detailed Reviews"), ` +
      `"buying_guide_heading": string, ` + (withFaq ? `"faq_heading": string, ` : "") + `"conclusion_heading": string, ` +
      (english ? "" : `"labels": {"product": string, "rating": string, "view_on_amazon": string, "check_price": string, "what_we_like": string, "what_could_be_improved": string} (these UI words in ${site.language}), `) +
      `"picks": [{"asin": string, "name": string (clean short product name with brand, max 65 characters), ` +
      `"best_for": string (max 6 words), "angle": string (max 18 words: what sets it apart from the other picks)}] (exactly ${count})}`,
  );
  if (!plan.title || !Array.isArray(plan.picks)) throw new Error("The AI returned an incomplete article plan. Retry the keyword.");

  const byAsin = new Map(products.map((p) => [p.asin, p]));
  const picks: { p: Product; r: Row }[] = [];
  for (const r of plan.picks) {
    const p = byAsin.get(String(r.asin));
    if (p && !picks.some((x) => x.p.asin === p.asin) && picks.length < count) picks.push({ p, r });
  }
  if (picks.length === 0) throw new Error("The AI did not choose any of the Amazon products. Retry the keyword.");
  const name = (x: { p: Product; r: Row }) => esc(String(x.r.name ?? x.p.title).slice(0, 90));
  const context = `Article "${plan.title}", keyword "${keyword}", language ${site.language}. Picks: ` +
    picks.map((x, i) => `${i + 1}) ${x.r.name ?? x.p.title} - ${x.r.best_for ?? ""}`).join("; ") + "\n";

  // 2) Everything else at the same time: one small request per product, plus one for the closing parts.
  const [closing, ...reviews] = await inParallel<Row>([
    () => askOpenAI(cfg, STYLE + REVIEW_RULES,
      context + `Write the closing parts. The buying guide explains how to choose in general; it does not review the picks.\n` +
        `JSON shape: {"buying_guide_html": string (300-400 words; 3-4 h3 subsections on the factors that decide a good purchase), ` +
        (withFaq ? FAQ_SHAPE : "") +
        `"conclusion_html": string (60-90 words: best overall pick, best alternative, and why)}`),
    ...picks.map((x) => () => askOpenAI(cfg, STYLE + REVIEW_RULES,
      context + `Write the review of this one pick only (${x.r.angle ?? ""}).\n` +
        `Facts: ${JSON.stringify(facts(x.p, 6, 200))}\n` +
        `JSON shape: {"detail": string (ONE paragraph of plain text, 70-100 words: what it is, the features that matter and what they mean in use), ` +
        `"likes": string[] (4-5 specific benefits, each a short sentence), ` +
        `"improvements": string[] (2-3 honest drawbacks), ` +
        `"closing": string (ONE paragraph of plain text, 35-55 words: who should buy it and who should skip it)}`)),
  ], report);

  // 3) Build the page.
  const L = {
    product: "Product", rating: "Rating", view_on_amazon: "View on Amazon", check_price: "Check Price",
    what_we_like: "What We Like", what_could_be_improved: "What Could Be Improved",
    ...Object.fromEntries(Object.entries(plan.labels ?? {}).filter(([, v]) => typeof v === "string" && v)),
  } as Record<string, string>;
  const link = (p: Product, inner: string, style = "") =>
    `<a href="${esc(p.url)}" target="_blank" rel="nofollow sponsored noopener"${style ? ` style="${style}"` : ""}>${inner}</a>`;
  const button = "display:inline-block;background-color:#1f2937;color:#ffffff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600";
  const li = (items: unknown) =>
    (Array.isArray(items) ? items : []).map((x) => `<li>${esc(String(x))}</li>`).join("");
  // Only real Amazon customer ratings are shown; nothing is made up.
  const stars = (p: Product) =>
    p.rating ? `${p.rating.toFixed(1)}/5${p.reviews ? ` (${p.reviews.toLocaleString("en-US")})` : ""}` : "";
  const anyRating = picks.some(({ p }) => p.rating);

  let html = `<p><em>As an Amazon Associate I earn from qualifying purchases.</em></p>\n${plain(plan.intro_html)}\n`;

  html += `<h2>${esc(String(plan.glance_heading || `Our Top ${picks.length} Picks at a Glance`))}</h2>\n` +
    `<table><tr><th></th><th>${esc(L.product)}</th>${anyRating ? `<th>${esc(L.rating)}</th>` : ""}<th></th></tr>` +
    picks.map((x) =>
      `<tr><td>${x.p.image ? `<img src="${esc(x.p.image)}" alt="${name(x)}" style="width:64px;height:auto" />` : ""}</td>` +
      `<td>${link(x.p, `<strong>${name(x)}</strong>`)}${x.r.best_for ? `<br /><em>${esc(String(x.r.best_for))}</em>` : ""}</td>` +
      (anyRating ? `<td>${stars(x.p)}</td>` : "") +
      `<td>${link(x.p, esc(L.check_price), button + ";white-space:nowrap")}</td></tr>`
    ).join("") + `</table>\n`;

  html += `<h2>${esc(String(plan.reviews_heading || `Top ${picks.length} Detailed Reviews`))}</h2>\n`;
  picks.forEach((x, i) => {
    const r = reviews[i] ?? {};
    html += `<h3>${i + 1}. ${name(x)}</h3>\n`;
    if (x.p.image) {
      html += `<p style="text-align:center">${link(x.p, `<img src="${esc(x.p.image)}" alt="${name(x)}" style="max-width:340px;width:100%;height:auto" />`)}</p>\n`;
    }
    html += `<p style="text-align:center">${link(x.p, esc(L.view_on_amazon), button)}</p>\n`;
    if (x.p.rating) html += `<p style="text-align:center"><strong>${esc(L.rating)}: ${stars(x.p)}</strong></p>\n`;
    html += para(r.detail);
    html += `<p><strong>${esc(L.what_we_like)}:</strong></p>\n<ul>${li(r.likes)}</ul>\n`;
    html += `<p><strong>${esc(L.what_could_be_improved)}:</strong></p>\n<ul>${li(r.improvements)}</ul>\n`;
    html += para(r.closing);
  });

  html += `<h2>${esc(String(plan.buying_guide_heading || "Buying Guide"))}</h2>\n${plain(closing.buying_guide_html)}\n`;
  if (withFaq) html += faqHtml(plan.faq_heading, closing.faq);
  html += `<h2>${esc(String(plan.conclusion_heading || "Final Verdict"))}</h2>\n${plain(closing.conclusion_html)}`;
  return { title: String(plan.title), html, excerpt: String(plan.meta_description ?? "") };
}

// ------------------------------------------------------------------ WordPress

function wp(site: Row) {
  if (!/^https?:\/\//i.test(site.url)) throw new Error("The website URL must start with https://");
  if (!site.wp_username || !site.wp_app_password) {
    throw new Error("Add the WordPress username and application password for this website.");
  }
  return {
    api: site.url.replace(/\/+$/, "") + "/wp-json/wp/v2",
    headers: {
      Authorization: "Basic " + btoa(`${site.wp_username}:${site.wp_app_password}`),
      "Content-Type": "application/json",
    },
  };
}

async function wpError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  return `WordPress replied ${res.status}: ${data?.message ?? "request failed"}`;
}

async function wpCreatePost(
  site: Row, title: string, content: string, excerpt: string, categoryId?: number | null, keyword?: string,
) {
  const { api, headers } = wp(site);
  const res = await fetch(`${api}/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title, content, excerpt, status: site.post_status,
      // Short keyword-based URL (WordPress cleans it up), better for SEO than the full title.
      ...(keyword ? { slug: keyword } : {}),
      ...(categoryId ? { categories: [Number(categoryId)] } : {}),
    }),
  });
  if (!res.ok) throw new Error(await wpError(res));
  return await res.json() as { id: number; link: string; status: string };
}

// All categories of the website, read live from WordPress (up to 1000).
async function wpCategories(site: Row) {
  const { api, headers } = wp(site);
  const all: { id: number; name: string; parent: number }[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${api}/categories?per_page=100&page=${page}&orderby=name&_fields=id,name,parent`, { headers });
    if (!res.ok) throw new Error(await wpError(res));
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const names = new Map(all.map((c) => [c.id, c.name]));
  return all
    .map((c) => ({ id: c.id, name: unesc(c.parent && names.has(c.parent) ? `${names.get(c.parent)} › ${c.name}` : c.name) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

// Checks the WordPress login and whether that user may publish posts.
async function wpMe(site: Row) {
  const { api, headers } = wp(site);
  let res: Response;
  try {
    res = await fetch(`${api}/users/me?context=edit&_fields=name,capabilities`, { headers });
  } catch {
    throw new Error("Could not reach the website. Check the WordPress URL.");
  }
  if (!res.ok) throw new Error(await wpError(res));
  const me = await res.json().catch(() => null);
  if (!me?.name) throw new Error("The website answered, but not like WordPress. Check the URL and that the REST API is enabled.");
  return { name: String(me.name), canPublish: Boolean(me.capabilities?.publish_posts) };
}

async function wpCount(site: Row, status: string): Promise<number> {
  const { api, headers } = wp(site);
  const res = await fetch(`${api}/posts?status=${status}&per_page=1&_fields=id`, { headers });
  if (!res.ok) throw new Error(await wpError(res));
  return Number(res.headers.get("X-WP-Total") ?? 0);
}

async function syncCounts(site: Row) {
  const now = new Date().toISOString();
  try {
    const [published, drafts] = [await wpCount(site, "publish"), await wpCount(site, "draft")];
    await admin.from("websites")
      .update({ wp_published: published, wp_drafts: drafts, wp_synced_at: now, wp_error: null })
      .eq("id", site.id);
    return { ok: true, published, drafts };
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e).slice(0, 300);
    await admin.from("websites").update({ wp_synced_at: now, wp_error: error }).eq("id", site.id);
    return { ok: false, error };
  }
}

// ------------------------------------------------------------------ helpers

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// WordPress sends names like "Home &amp; Garden".
function unesc(s: string) {
  return s.replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
function countWords(html: string) {
  return html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}
