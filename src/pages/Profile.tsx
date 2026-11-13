import { useEffect, useState, type FormEvent } from "react";
import { supabase, useSession } from "../lib";
import { Button, Card, Field, Input, Notice } from "../ui";

export default function Profile() {
  const session = useSession();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    supabase.from("profiles").select("full_name").maybeSingle().then(({ data }) => setName(data?.full_name ?? ""));
  }, []);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("profiles").upsert({ id: session.user.id, full_name: name.trim() });
    setMsg(error ? { kind: "error", text: error.message } : { kind: "ok", text: "Profile saved." });
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    setMsg(error ? { kind: "error", text: error.message } : { kind: "ok", text: "Password changed." });
    if (!error) setPassword("");
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-xl font-semibold">Profile</h1>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <Card className="p-5">
        <form onSubmit={saveName} className="space-y-4">
          <Field label="Email">
            <Input value={session.user.email ?? ""} disabled className="bg-slate-50 text-slate-500" />
          </Field>
          <Field label="Full name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit">Save profile</Button>
        </form>
      </Card>

      <Card className="p-5">
        <form onSubmit={changePassword} className="space-y-4">
          <Field label="New password" hint="At least 6 characters">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
          </Field>
          <Button type="submit">Change password</Button>
        </form>
      </Card>

      <Card className="flex items-center justify-between p-5">
        <div className="text-sm text-slate-600">Articles keep being written after you log out.</div>
        <Button variant="ghost" onClick={() => supabase.auth.signOut()}>Log out</Button>
      </Card>
    </div>
  );
}
