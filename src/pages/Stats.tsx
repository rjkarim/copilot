import { useEffect, useState } from "react";
import { supabase } from "../lib";
import { Card, Notice } from "../ui";

type Row = {
  website_id: string;
  website: string;
  completed: number;
  failed: number;
  words_total: number;
  tokens_total: number;
  tokens_articles: number;
  seconds_total: number;
};
type Bucket = { start: Date; label: string; completed: number };

const RANGES = [
  { key: "24h", label: "Last 24 hours", hours: 24, bucket: "hour" },
  { key: "7d", label: "Last 7 days", hours: 24 * 7, bucket: "day" },
  { key: "30d", label: "Last 30 days", hours: 24 * 30, bucket: "day" },
] as const;

const num = (n: number) => Math.round(n).toLocaleString("en-US");
const avg = (total: number, count: number) => (count > 0 ? total / count : null);
function duration(seconds: number | null) {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export default function Stats() {
  const [rangeKey, setRangeKey] = useState<(typeof RANGES)[number]["key"]>("24h");
  const range = RANGES.find((r) => r.key === rangeKey)!;
  // Separate statistics for brand-new articles and for rewritten old posts.
  const [kind, setKind] = useState<"new" | "update">("new");
  const noun = kind === "new" ? "article" : "update";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    async function load() {
      const since = new Date(Date.now() - range.hours * 3600_000);
      const [stats, timeline] = await Promise.all([
        supabase.rpc("article_stats", { since: since.toISOString(), kind }),
        supabase.rpc("article_timeline", { since: since.toISOString(), bucket: range.bucket, kind }),
      ]);
      if (!alive) return;
      if (stats.error || timeline.error) {
        return setError("Database update needed: run supabase/migrations/007_update_old_posts.sql in the Supabase SQL Editor, then reload.");
      }
      setError("");
      setRows((stats.data as Row[]).map((r) => ({ ...r, seconds_total: Number(r.seconds_total) })));
      setBuckets(fillBuckets(timeline.data as { bucket_start: string; completed: number }[], range.bucket, range.hours));
    }
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [rangeKey, kind]);

  const days = range.hours / 24;
  const sum = (k: keyof Row) => (rows ?? []).reduce((n, r) => n + Number(r[k]), 0);
  const completed = sum("completed");
  const sites = rows?.length ?? 0;
  const perDay = (n: number) => (n >= 10 || Number.isInteger(n) ? num(n) : n.toFixed(1));
  const tiles = [
    kind === "new"
      ? {
          label: "Articles per website per 24 h",
          value: sites > 0 ? completed / sites / days : null,
          format: perDay,
          note: `${num(completed)} articles on ${sites} website${sites === 1 ? "" : "s"}`,
        }
      : {
          label: days === 1 ? "Posts updated in 24 h" : "Posts updated per 24 h",
          value: rows ? completed / days : null,
          format: perDay,
          note: `${num(completed)} updated, ${num(sum("failed"))} failed`,
        },
    { label: `Avg time per ${noun}`, value: avg(sum("seconds_total"), completed), format: duration, note: kind === "new" ? "from start to WordPress draft" : "from picking the post to replacing it" },
    { label: `Avg words per ${noun}`, value: avg(sum("words_total"), completed), format: num, note: `${num(sum("words_total"))} words written` },
    { label: `Avg tokens per ${noun}`, value: avg(sum("tokens_total"), sum("tokens_articles")), format: num, note: `${num(sum("tokens_total"))} tokens used` },
  ];
  const perSite = (rows ?? []).map((r) => ({
    name: r.website,
    perDay: r.completed / days,
    words: avg(r.words_total, r.completed),
    tokens: avg(r.tokens_total, r.tokens_articles),
    seconds: avg(r.seconds_total, r.completed),
    completed: r.completed,
    failed: r.failed,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Statistics</h1>
          <p className="text-sm text-slate-500">
            {kind === "new" ? "New articles written" : "Old posts updated"}, {range.label.toLowerCase()}. Refreshes every 30 seconds.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
          {([["new", "New articles"], ["update", "Updated posts"]] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1 font-medium ${kind === k ? "bg-indigo-600 text-white" : "text-slate-600"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-slate-300 bg-white p-0.5 text-sm">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRangeKey(r.key)}
              className={`rounded-md px-3 py-1 font-medium ${rangeKey === r.key ? "bg-indigo-600 text-white" : "text-slate-600"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="px-5 py-4">
            <div className="text-xs font-medium text-slate-500">{t.label}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">
              {t.value === null ? "—" : t.format(t.value)}
            </div>
            <div className="mt-1 text-xs text-slate-400">{t.note}</div>
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <div className="text-sm font-semibold">{kind === "new" ? "Articles completed" : "Posts updated"} per {range.bucket}</div>
        <Timeline buckets={buckets} noun={noun} />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <BarList title={kind === "new" ? "Articles per 24 hours" : "Posts updated per 24 hours"}
          rows={perSite.map((s) => ({ name: s.name, value: s.perDay }))} format={perDay} />
        <BarList title={`Avg time per ${noun}`} rows={perSite.map((s) => ({ name: s.name, value: s.seconds }))} format={duration} />
        <BarList title={`Avg words per ${noun}`} rows={perSite.map((s) => ({ name: s.name, value: s.words }))} format={num} />
        <BarList title={`Avg tokens per ${noun}`} rows={perSite.map((s) => ({ name: s.name, value: s.tokens }))} format={num} />
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Website</th>
              <th className="px-3 py-2.5 text-right">Completed</th>
              <th className="px-3 py-2.5 text-right">Failed</th>
              <th className="px-3 py-2.5 text-right">Per 24 h</th>
              <th className="px-3 py-2.5 text-right">Avg words</th>
              <th className="px-3 py-2.5 text-right">Avg tokens</th>
              <th className="px-4 py-2.5 text-right">Avg time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 tabular-nums">
            {perSite.map((s) => (
              <tr key={s.name}>
                <td className="px-4 py-2.5 font-medium">{s.name}</td>
                <td className="px-3 py-2.5 text-right">{s.completed}</td>
                <td className={`px-3 py-2.5 text-right ${s.failed ? "text-red-600" : ""}`}>{s.failed}</td>
                <td className="px-3 py-2.5 text-right">{s.perDay >= 10 || Number.isInteger(s.perDay) ? num(s.perDay) : s.perDay.toFixed(1)}</td>
                <td className="px-3 py-2.5 text-right">{s.words === null ? "—" : num(s.words)}</td>
                <td className="px-3 py-2.5 text-right">{s.tokens === null ? "—" : num(s.tokens)}</td>
                <td className="px-4 py-2.5 text-right">{duration(s.seconds)}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Add a website to see statistics.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
      <p className="text-xs text-slate-400">
        Tokens are counted from the moment this feature was switched on; older articles are left out of the token average.
      </p>
    </div>
  );
}

/** Every hour (or day) of the range, including the empty ones, oldest first. */
function fillBuckets(data: { bucket_start: string; completed: number }[], bucket: "hour" | "day", hours: number): Bucket[] {
  const step = bucket === "hour" ? 3600_000 : 86400_000;
  const counts = new Map(data.map((d) => [new Date(d.bucket_start).getTime(), d.completed]));
  const last = Math.floor(Date.now() / step) * step; // buckets are cut on UTC hours / days, like the database
  const out: Bucket[] = [];
  for (let i = Math.round((hours * 3600_000) / step) - 1; i >= 0; i--) {
    const start = new Date(last - i * step);
    out.push({
      start,
      completed: counts.get(start.getTime()) ?? 0,
      label:
        bucket === "hour"
          ? start.toLocaleTimeString([], { hour: "numeric" })
          : start.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }),
    });
  }
  return out;
}

/** Column chart, one colour (one series). Hover a column for its exact value. */
function Timeline({ buckets, noun }: { buckets: Bucket[]; noun: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.completed));
  const total = buckets.reduce((n, b) => n + b.completed, 0);
  if (total === 0) return <div className="py-10 text-center text-sm text-slate-500">No {noun}s completed in this period yet.</div>;
  const ticks = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1];
  return (
    <div className="mt-4">
      <div className="relative flex h-44 items-end gap-0.5 border-b border-slate-200" onMouseLeave={() => setHover(null)}>
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-slate-200">
          <span className="absolute -top-2 right-0 bg-white pl-1 text-[11px] tabular-nums text-slate-400">{max}</span>
        </div>
        {buckets.map((b, i) => (
          <div key={i} className="relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div
              className={`w-full rounded-t ${hover === i ? "bg-indigo-700" : "bg-indigo-500"}`}
              style={{ height: b.completed ? `max(3px, ${(b.completed / max) * 100}%)` : 0 }}
            />
            {hover === i && (
              <div className={`pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow ${i > buckets.length / 2 ? "right-0" : "left-0"}`}>
                <span className="font-semibold tabular-nums">{b.completed}</span> {noun}{b.completed === 1 ? "" : "s"} · {b.label}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[11px] text-slate-400">
        {ticks.map((t, k) => (
          <span key={k} className={`absolute ${k === 0 ? "left-0" : k === 2 ? "right-0" : "left-1/2 -translate-x-1/2"}`}>
            {buckets[t]?.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One measure compared across websites: name, thin bar, value. */
function BarList({ title, rows, format }: {
  title: string;
  rows: { name: string; value: number | null }[];
  format: (n: number) => string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
  return (
    <Card className="p-5">
      <div className="mb-3 text-sm font-semibold">{title}</div>
      {rows.length === 0 && <div className="text-sm text-slate-500">No websites yet.</div>}
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.name} title={`${r.name}: ${r.value === null ? "no data" : format(r.value)}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-slate-700">{r.name}</span>
              <span className="font-semibold tabular-nums text-slate-900">{r.value === null ? "—" : format(r.value)}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-indigo-500" style={{ width: max > 0 && r.value ? `max(4px, ${(r.value / max) * 100}%)` : 0 }} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
