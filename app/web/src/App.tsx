// Boot: ask the server who we are, then show setup, sign-in or the app.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Session, State } from "../../shared/types";
import { Toasts } from "./components/Toasts";
import { api, whenSignedOut } from "./lib/api";
import { StoreProvider } from "./lib/store";
import { Shell } from "./Shell";

type Boot = { kind: "loading" } | { kind: "setup" } | { kind: "login" } | { kind: "app"; state: State } | { kind: "error"; message: string };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const start = useCallback(async () => {
    try {
      const s = await fetch("/api/session").then((r) => r.json() as Promise<Session>);
      if (!s.authed) return setBoot({ kind: s.setup ? "login" : "setup" });
      setBoot({ kind: "app", state: await api.get<State>("/api/state") });
    } catch (e) { setBoot({ kind: "error", message: (e as Error).message }); }
  }, []);
  useEffect(() => { whenSignedOut(start); start(); }, [start]);

  return (
    <>
      {boot.kind === "setup" && <SetupScreen />}
      {boot.kind === "login" && <LoginScreen />}
      {boot.kind === "app" && <StoreProvider initial={boot.state}><Shell /></StoreProvider>}
      {boot.kind === "error" && <div className="auth"><div className="pc-card"><pc-logo size="md" wordmark="" /><p className="badc small">{`Can't reach Pitcrew: ${boot.message}`}</p><button className="pc-pill" onClick={start}>Try again</button></div></div>}
      <Toasts />
    </>
  );
}

function AuthCard({ title, sub, label, submit, children }: { title: string; sub: string; label: string; submit: () => Promise<unknown>; children: ReactNode }) {
  const [err, setErr] = useState("");
  return (
    <div className="auth">
      <form className="pc-card" onSubmit={async (e) => {
        e.preventDefault(); setErr("");
        try { await submit(); location.hash = "#/"; location.reload(); } catch (x) { setErr((x as Error).message); }
      }}>
        <pc-logo size="md" wordmark="" />
        <h1 className="pc-h2">{title}</h1>
        <p className="muted small">{sub}</p>
        {children}
        <p className="small badc">{err}</p>
        <button className="pc-pill" type="submit">{label}</button>
      </form>
    </div>
  );
}

function SetupScreen() {
  const [token, setToken] = useState(""), [name, setName] = useState(""), [pw, setPw] = useState("");
  return (
    <AuthCard title="Set up Pitcrew" sub="Paste the setup token from /srv/pitcrew/data/setup-token on the server, then choose a password." label="Set password"
      submit={() => api.post("/api/setup", { token: token.trim(), password: pw, driverName: name.trim() }, { quiet: true })}>
      <input autoComplete="off" placeholder="Setup token" value={token} onChange={(e) => setToken(e.target.value)} />
      <input placeholder="What should the crew call you?" value={name} onChange={(e) => setName(e.target.value)} />
      <input type="password" autoComplete="new-password" placeholder="Password (12+ characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
    </AuthCard>
  );
}

function LoginScreen() {
  const [pw, setPw] = useState("");
  return (
    <AuthCard title="Pitcrew" sub="Sign in to your crew." label="Sign in" submit={() => api.post("/api/login", { password: pw }, { quiet: true })}>
      <input type="password" autoComplete="current-password" placeholder="Password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
    </AuthCard>
  );
}
