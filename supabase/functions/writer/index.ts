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
    const allowed = ["url", "wp_username", "wp_app_password", "amazon_credential_id",
      "amazon_credential_secret", "amazon_version", "marketplace", "tracking_id"];
    for (const k of allowed) {
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
      if (!site.amazon_credential_id || !site.amazon_credential_secret) throw new Error("Enter the Credential ID and Credential Secret first.");
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
        if (!site.has_amazon_keys) throw new Error("This website has no Amazon Creators API credentials. Edit the website and add them.");
        if (!site.tracking_id) throw new Error("This website has no Amazon tracking ID. Edit the website and add one.");
        products = await searchAmazon(site, a.keyword);
        if (products.length === 0) throw new Error(`Amazon returned no products for "${a.keyword}".`);
      }

      const report: Report = (step, progress) => set({ step, progress });
      const draft = a.type === "review"
        ? await writeReview(cfg, site, a.keyword, products, Number(a.product_count) || 5, report)
        : await writeInformative(cfg, site, a.keyword, report);
      title = draft.title;
      html = draft.html;
      excerpt = draft.excerpt;
      await set({ title, content_html: html, word_count: countWords(html) });
    }

    // Cancelled while writing: stop here, post nothing to WordPress.
    if (!(await stillMine())) {
      cancelled = true;
      return;
    }
    await set({ step: "Publishing to WordPress", progress: 80 });
    const post = await wpCreatePost(site, title, html, excerpt, a.wp_category_id, a.keyword);
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
    if (!cancelled) await admin.from("websites")
      .update({ next_run_at: new Date(Date.now() + site.sleep_seconds * 1000).toISOString() })
      .eq("id", site.id);
  }
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
    throw new Error(`Amazon login failed (${res.status}). Check this website's Credential ID, Secret and Version.`);
  }
  return COGNITO[v] ? `Bearer ${data.access_token}, Version ${v}` : `Bearer ${data.access_token}`;
}

// Each website has its own Creators API credentials and tracking ID.
// One request fetches 10 products; the article later keeps the best few.
async function searchAmazon(site: Row, keyword: string): Promise<Product[]> {
  const authorization = await amazonAuthHeader(site);
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
  const text = String(data?.choices?.[0]?.message?.content ?? "");
  try {
    // Tolerates code fences or extra words around the JSON object.
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    throw new Error("The AI returned an answer that could not be read. Retry the keyword.");
  }
}

// How every article should read. Shared by both article types.
const STYLE = [
  "You are a senior editor and subject-matter expert who has written buying guides and how-to articles for major publications for 15 years.",
  "Write the way a knowledgeable person explains things to a friend: confident, specific, practical and honest.",
  "",
  "Writing quality:",
  "- Lead with what the reader needs. No warm-up sentences, no restating the question.",
  "- Be concrete. Explain what a feature means for the reader in real use instead of listing it.",
  "- Mix short and longer sentences. Keep paragraphs to 2-4 sentences. Use active voice and address the reader as 'you'.",
  "- Give honest trade-offs. Real experts point out who should NOT choose something.",
  "- Never use filler or cliches such as: 'in today's world', 'look no further', 'game-changer', 'when it comes to', 'whether you are a beginner or a pro', 'dive in', 'unleash', 'elevate', 'in conclusion', 'it is important to note'.",
  "- No exaggerated claims, no exclamation marks, no emojis.",
  "",
  "SEO:",
  "- Use the exact keyword naturally in the title, in the first 100 words, and in one subheading. Elsewhere use natural variations and related terms. Never stuff keywords.",
  "- Title: 50-60 characters, keyword near the start, clear benefit. Meta description: 140-155 characters, includes the keyword, reads like an invitation to click.",
  "- Subheadings describe their section and match what people search for. Answer questions directly in the first sentence under a heading.",
  "",
  "Format: HTML fragments may only use these tags: p, h3, h4, ul, ol, li, strong, em, table, tr, th, td. Never use h1 or h2, links, images, markdown or code fences.",
  "Reply with one JSON object only, exactly in the requested shape.",
].join("\n");

const REVIEW_RULES = "\n\n" + [
  "Product reviews:",
  "- Use only the product facts you are given. Never invent prices, ratings, scores, test results, measurements, awards or specifications.",
  "- Never claim you bought, tested or used a product. Write as an expert analysing the specifications and what they mean for the buyer.",
  "- Say clearly who a product suits best and who should skip it. Every product must have real drawbacks, not disguised praise.",
].join("\n");

type Draft = { title: string; html: string; excerpt: string };
type Report = (step: string, progress: number) => Promise<unknown>;

// An article is written as one short "plan" request followed by several small
// requests that run at the same time (one per product or section). This is far
// quicker than one huge request, and a slow or failed part is retried on its own.
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

function faqHtml(heading: unknown, faq: unknown) {
  if (!Array.isArray(faq) || faq.length === 0) return "";
  return `<h2>${esc(String(heading || "Frequently Asked Questions"))}</h2>\n` +
    faq.map((f: Row) => `<h3>${esc(String(f.q ?? ""))}</h3>\n<p>${esc(String(f.a ?? ""))}</p>`).join("\n") + "\n";
}

async function writeInformative(cfg: Row, site: Row, keyword: string, report: Report): Promise<Draft> {
  await report("Planning article", 35);
  const plan = await askOpenAI(
    cfg,
    STYLE,
    `Plan an in-depth informative article in ${site.language} for the keyword "${keyword}". ` +
      `Cover what a searcher of this keyword actually wants to know, in the order they need it.\n\n` +
      `JSON shape:\n` +
      `{"title": string, "meta_description": string,\n` +
      ` "intro_html": string (2 short paragraphs; answer the main question straight away),\n` +
      ` "outline": [{"heading": string, "brief": string (one sentence: what this section must cover)}] (6-8 sections, no FAQ or conclusion),\n` +
      ` "faq_heading": string, "conclusion_heading": string}`,
  );
  if (!plan.title || !Array.isArray(plan.outline) || plan.outline.length === 0) {
    throw new Error("The AI returned an incomplete article plan. Retry the keyword.");
  }
  const outline: Row[] = plan.outline.slice(0, 8);
  const context = `Article: "${plan.title}" (keyword "${keyword}", language ${site.language}).\n` +
    `Full outline, for context only: ${outline.map((s) => s.heading).join(" | ")}\n\n`;

  const [closing, ...sections] = await inParallel<Row>([
    () => askOpenAI(cfg, STYLE,
      context + `Write the FAQ and the conclusion.\n` +
        `JSON shape: {"faq": [{"q": string, "a": string (40-70 words, direct answer first)}] (5-6 real questions people ask, not already answered by the outline), ` +
        `"conclusion_html": string (short; the key takeaway and a next step)}`),
    ...outline.map((s) => () => askOpenAI(cfg, STYLE,
      context + `Write only the section "${s.heading}". It must cover: ${s.brief}\n` +
        `Do not repeat the heading and do not cover the other sections.\n` +
        `JSON shape: {"html": string (150-250 words; use h3, lists or a table where they help)}`)),
  ], report);

  let html = `${plan.intro_html ?? ""}\n`;
  outline.forEach((s, i) => { html += `<h2>${esc(String(s.heading ?? ""))}</h2>\n${sections[i]?.html ?? ""}\n`; });
  html += faqHtml(plan.faq_heading, closing.faq);
  html += `<h2>${esc(String(plan.conclusion_heading || "Final Thoughts"))}</h2>\n${closing.conclusion_html ?? ""}`;
  return { title: String(plan.title), html, excerpt: String(plan.meta_description ?? "") };
}

// Review layout: intro, "at a glance" table, numbered detailed reviews (image,
// button, rating, review, likes, improvements, verdict), buying guide, FAQ, conclusion.
async function writeReview(
  cfg: Row, site: Row, keyword: string, products: Product[], wanted: number, report: Report,
): Promise<Draft> {
  const count = Math.max(1, Math.min(wanted, products.length, 10));
  const facts = (p: Product) => ({
    asin: p.asin, name: p.title, brand: p.brand, features: p.features,
    ...(p.rating ? { customer_rating: p.rating, customer_reviews: p.reviews } : {}),
  });

  // 1) Plan: choose the best products and write the short framing parts.
  await report("Choosing the best products", 35);
  const plan = await askOpenAI(
    cfg,
    STYLE + REVIEW_RULES,
    `Plan a "best of" product review article in ${site.language} for the keyword "${keyword}".\n\n` +
      `From the ${products.length} Amazon products below, pick the ${count} best for this keyword. ` +
      `They must truly match the keyword, be clearly different from each other (no colour or size variants of the same item), ` +
      `and cover different needs or budgets. Prefer better customer ratings when given. Order them best first. Keep each asin exactly as given.\n\n` +
      `Products:\n${JSON.stringify(products.map((p) => ({ ...facts(p), features: p.features.slice(0, 5) })))}\n\n` +
      `JSON shape:\n` +
      `{"title": string (for example "Top ${count} ...: Reviews & Buyer's Guide", in ${site.language}),\n` +
      ` "meta_description": string,\n` +
      ` "intro_html": string (2-3 short paragraphs: the buyer's problem, what matters when choosing, what this guide covers),\n` +
      ` "glance_heading": string (like "Our Top ${count} <keyword> Recommendations at a Glance"),\n` +
      ` "reviews_heading": string (like "Top ${count} <keyword> Detailed Reviews"),\n` +
      ` "buying_guide_heading": string (like "The Ultimate Buying Guide: <keyword>"),\n` +
      ` "faq_heading": string, "conclusion_heading": string,\n` +
      ` "labels": {"product": string, "rating": string, "view_on_amazon": string, "check_price": string, "what_we_like": string, "what_could_be_improved": string} (these UI words in ${site.language}),\n` +
      ` "picks": [{"asin": string, "name": string (clean short product name with brand, max 65 characters), ` +
      `"best_for": string (max 6 words, e.g. "Best for long rides"), ` +
      `"angle": string (one sentence: what sets it apart from the other picks)}] (exactly ${count})}`,
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
  const lineup = picks.map((x, i) => `${i + 1}. ${x.r.name ?? x.p.title} (${x.r.best_for ?? ""})`).join("\n");
  const context = `Article: "${plan.title}" (keyword "${keyword}", language ${site.language}).\nProducts in the article:\n${lineup}\n\n`;

  // 2) Everything else at the same time: one request per product, plus guide and FAQ.
  const [guide, closing, ...reviews] = await inParallel<Row>([
    () => askOpenAI(cfg, STYLE + REVIEW_RULES,
      context + `Write the buying guide section. Its heading is "${plan.buying_guide_heading}" - do not repeat it. ` +
        `Explain how to choose in general; do not review the individual products.\n` +
        `JSON shape: {"buying_guide_html": string (500-700 words; 4-6 h3 subsections on the factors that decide a good purchase, with lists where useful)}`),
    () => askOpenAI(cfg, STYLE + REVIEW_RULES,
      context + `Write the FAQ and the conclusion.\n` +
        `JSON shape: {"faq": [{"q": string, "a": string (40-70 words, direct answer first)}] (6-8 real buyer questions about this kind of product), ` +
        `"conclusion_html": string (short: best overall pick, best budget or alternative pick, and why)}`),
    ...picks.map((x) => () => askOpenAI(cfg, STYLE + REVIEW_RULES,
      context + `Write the detailed review of this one product only: ${x.r.name ?? x.p.title}.\n` +
        `Its place in the article: ${x.r.best_for ?? ""}. ${x.r.angle ?? ""}\n` +
        `Product facts:\n${JSON.stringify(facts(x.p))}\n\n` +
        `JSON shape: {"review_html": string (2 paragraphs, 110-150 words: what it is, the features that matter and why, who it suits), ` +
        `"likes": string[] (4-6 specific benefits, each one short sentence), ` +
        `"improvements": string[] (2-3 honest drawbacks), ` +
        `"verdict": string (1-2 sentences: who should buy it)}`)),
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

  let html = `<p><em>As an Amazon Associate I earn from qualifying purchases.</em></p>\n${plan.intro_html ?? ""}\n`;

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
    html += `${r.review_html ?? ""}\n`;
    html += `<p><strong>${esc(L.what_we_like)}:</strong></p>\n<ul>${li(r.likes)}</ul>\n`;
    html += `<p><strong>${esc(L.what_could_be_improved)}:</strong></p>\n<ul>${li(r.improvements)}</ul>\n`;
    if (r.verdict) html += `<p>${esc(String(r.verdict))}</p>\n`;
  });

  html += `<h2>${esc(String(plan.buying_guide_heading || "Buying Guide"))}</h2>\n${guide.buying_guide_html ?? ""}\n`;
  html += faqHtml(plan.faq_heading, closing.faq);
  html += `<h2>${esc(String(plan.conclusion_heading || "Final Verdict"))}</h2>\n${closing.conclusion_html ?? ""}`;
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
