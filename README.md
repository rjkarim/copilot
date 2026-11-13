# AffiliWriter

Bulk informative and Amazon affiliate review articles for unlimited WordPress websites.
Articles are written one by one in the background by Supabase, so they keep going after you log out or close the browser.

## One-time setup (about 10 minutes)

### 1. Connect the app to Supabase
Copy `.env.example` to `.env` and paste the two values from **Supabase Dashboard > Project Settings > API** (Project URL and the `anon` public key).

### 2. Create the database
Open **Supabase Dashboard > SQL Editor**, paste the whole of `supabase/migrations/001_init.sql`, and click **Run**. Then do the same with `002_ai_base_url.sql`, `003_site_amazon_and_categories.sql` and `004_product_count.sql`, in that order.

### 3. Deploy the background writer
Pick a long random text to use as the worker secret (for example 40 random letters and numbers). Then, in this folder:

```bash
npx supabase login
```
```bash
npx supabase link --project-ref YOUR-PROJECT-REF
```
```bash
npx supabase secrets set WORKER_SECRET=your-long-random-secret
```
```bash
npx supabase functions deploy writer --no-verify-jwt
```

(No command line? In **Dashboard > Edge Functions**, create a function named `writer`, paste `supabase/functions/writer/index.ts`, turn **Verify JWT** off, and add the `WORKER_SECRET` secret under **Edge Functions > Secrets**.)

### 4. Tell the scheduler where the writer is
Back in the **SQL Editor**, run this with your own project ref and the same secret as step 3:

```sql
insert into private.config (key, value) values
  ('function_url', 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/writer'),
  ('worker_secret', 'your-long-random-secret')
on conflict (key) do update set value = excluded.value;
```

### 5. Start the app

```bash
npm install
```
```bash
npm run dev
```

Open http://localhost:5173, create your account, then:

1. **Settings** – the AI provider's API base URL, API key and model name.
2. **Dashboard > Add website** – WordPress URL, username, an *application password* (WordPress admin > Users > Profile > Application Passwords), and that website's own Amazon Creators API Credential ID, Secret, Version and tracking ID.
3. Open the website, paste keywords (one per line), choose the category (loaded live from the website), article type and sleep time, and click **Start writing**.

To put the app online, run `npm run build` and upload the `dist` folder to any static host (Vercel, Netlify, Cloudflare Pages) with the same two `VITE_` variables. Set the host to send every path to `index.html`.

## How it works

- **Scheduler** – a database job (`pg_cron`) runs every 30 seconds. For each website that is not paused, has finished its sleep time and is not already writing, it takes the next queued keyword and calls the `writer` function.
- **Writer** – for review keywords it finds products through the Amazon Creators API using the website's tracking ID, has OpenAI write the article, builds the product boxes and affiliate links, posts to WordPress as draft or published, and refreshes the website's post counts.
- **Sleep time** – set per website; after each article the website waits that many seconds before the next one. Different websites write at the same time.
- **Live progress** – the dashboard listens to database changes, so progress bars update by themselves.
- **Failures** – a failed keyword shows its reason and a Retry button. If only the WordPress upload failed, Retry reuses the article already written.
- **Secrets** – API keys and WordPress passwords can be saved from the browser but not read back by it; only the background writer reads them.

## Troubleshooting

- **Keywords stay "queued"** – step 3 or 4 is missing or the two secrets differ. Check **Dashboard > Edge Functions > writer > Logs**, and run `select * from cron.job_run_details order by start_time desc limit 5;`.
- **"Timed out while writing"** – the article took longer than Supabase allows a function to run (about 150 seconds on the free plan). Use a faster model such as `gpt-4o-mini`, then Retry.
- **WordPress 401 / 403** – wrong username or application password, or a security plugin is blocking the REST API.
- **Amazon errors** – check the Credential Version, that the tracking ID belongs to the same Associates account, and that the marketplace matches.
- **No confirmation email on sign-up** – in **Authentication > Sign In / Providers > Email** you can turn off "Confirm email" while testing.
