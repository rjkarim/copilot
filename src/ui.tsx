import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import type { Site } from "./lib";

const variants = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700",
  ghost: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50",
  danger: "bg-white text-red-600 border border-red-200 hover:bg-red-50",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Notice({ kind, children }: { kind: "error" | "ok" | "info"; children: ReactNode }) {
  const cls = {
    error: "border-red-200 bg-red-50 text-red-700",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
    info: "border-indigo-200 bg-indigo-50 text-indigo-700",
  }[kind];
  return <div className={`rounded-lg border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 sm:p-8" onMouseDown={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export type ConfirmRequest = {
  title: string;
  message: string;
  label: string;
  /** Does the deletion. Return an error message to show, or null on success. */
  run: () => Promise<string | null>;
};

/** In-app "are you sure?" dialog (the browser's own confirm box is blocked in some browsers). */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    const problem = await request.run();
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-4" onMouseDown={onClose}>
      <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="font-semibold">{request.title}</h2>
        <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{request.message}</p>
        {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={go} disabled={busy} className="!bg-red-600 hover:!bg-red-700">
            {busy ? "Deleting…" : request.label}
          </Button>
        </div>
      </div>
    </div>
  );
}

const badge = {
  queued: "bg-slate-100 text-slate-600",
  writing: "bg-indigo-100 text-indigo-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};
export function StatusBadge({ status }: { status: keyof typeof badge }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${badge[status]}`}>{status}</span>;
}

/** Live writing status for one website: progress bar, sleeping, paused or idle. */
export function LiveStatus({ site }: { site: Site }) {
  if (site.writing > 0) {
    const pct = Math.max(5, site.current_progress ?? 5);
    return (
      <div>
        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
          <span className="truncate font-medium text-indigo-700">
            <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            {site.current_step ?? "Writing"}: {site.current_keyword}
          </span>
          <span className="tabular-nums text-slate-500">{pct}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="bar-live h-full rounded-full bg-indigo-500 transition-all duration-700" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  let text = "Idle — no keywords in the queue";
  let dot = "bg-slate-300";
  if (site.paused) {
    text = "Paused";
    dot = "bg-amber-400";
  } else if (site.queued > 0) {
    const next = new Date(site.next_run_at);
    dot = "bg-sky-400";
    text =
      next.getTime() > Date.now() + 1000
        ? `Sleeping — next article at ${next.toLocaleTimeString()}`
        : "Starting the next article…";
  }
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {text}
    </div>
  );
}
