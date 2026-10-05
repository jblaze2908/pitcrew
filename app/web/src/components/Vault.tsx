// Settings → Vault: secrets the crew fills by name. Values are write-only: the API never returns one, so the editor
// only knows which fields are "set". Imports (Google Passwords CSV, Authenticator QR) are parsed here in the browser;
// only the rows or the one seed the driver picks are sent.
import { useState } from "react";
import type { BotCard, VaultEntry, VaultKind } from "../../../shared/types";
import { parseGoogleCsv, parseMigration, type CsvLogin, type OtpAccount } from "../../../shared/vaultImport";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { go } from "../lib/router";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { useFetch } from "../lib/useFetch";
import { BusyButton, ConfirmButton, Face, Field, Seg } from "./ui";

const KINDS = [["login", "login"], ["login+totp", "login + TOTP"], ["card", "card"]] as const;
type Access = "no" | "ask" | "always";

export function VaultSettings({ item }: { item?: string }) {
  const { S } = useStore();
  const { data, error, reload } = useFetch(() => api.get<VaultEntry[]>("/api/vault"), []);
  const [importing, setImporting] = useState(false);
  if (error && !data) return <p className="badc">{error}</p>;
  if (!data) return null;
  const editing = item === "new" ? null : data.find((x) => x.id === item);
  if (item && (item === "new" || editing)) return <VaultEditor key={item} v={editing || null} bots={S.bots} done={() => { reload(); go("#/settings/vault"); }} />;
  const name = (id: string | null) => S.bots.find((b) => b.id === id)?.name || "a member";
  return (
    <div className="col vault">
      <div className="spread" style={{ alignItems: "flex-end", gap: 16 }}>
        <p className="small muted" style={{ maxWidth: 560 }}>Logins, one-time codes and cards your crew can use without ever seeing them. Pitcrew fills the value into the page and submits; the model only knows the name.</p>
        <div className="row"><button className="pc-pill o s" onClick={() => setImporting((x) => !x)}>Import</button><a className="pc-pill s" href="#/settings/vault/new">+ Add secret</a></div>
      </div>
      {importing && <CsvImport bots={S.bots} done={() => { setImporting(false); reload(); }} />}
      {data.length ? (
        <div className="vtbl">
          <div className="vh"><span>Name · site</span><span>Kind</span><span>Who may use it</span><span>Last used</span></div>
          {data.map((v) => (
            <a key={v.id} className="vr" href={`#/settings/vault/${v.id}`}>
              <div><b>{v.name}</b>{v.needs_update && <span className="pc-chip bad" title={v.needs_update}>needs update</span>}<small>{[v.site || "any checkout", v.kind === "card" && v.last4 ? `card ending ${v.last4}` : "", v.note].filter(Boolean).join(" · ")}</small></div>
              <span><span className="vk">{v.kind === "card" ? `card ·${v.last4}` : v.kind === "login+totp" ? "login + TOTP" : "login"}</span></span>
              <Who v={v} bots={S.bots} />
              <span className="pc-m small faint" title={v.last_used ? `by ${name(v.last_used_by)}` : undefined}>{v.last_used ? ago(v.last_used) : "never"}</span>
            </a>
          ))}
        </div>
      ) : <p className="empty">No secrets yet. Add one, or import the sites your crew needs from a Google Passwords export.</p>}
      <p className="small faint" style={{ maxWidth: 640 }}>Values are encrypted on this server with a key that never enters a member's computer. A member asks by name; Pitcrew checks the page is that secret's site and that you allowed it, then types it in and submits itself. Cards always ask, every time.</p>
    </div>
  );
}

function Who({ v, bots }: { v: VaultEntry; bots: BotCard[] }) {
  const list = bots.filter((b) => v.allowed.includes(b.id));
  if (!list.length) return <span className="faces faint">nobody yet</span>;
  return <span className="faces">{list.slice(0, 2).map((b) => <span key={b.id} className="row" style={{ gap: 6 }}><Face b={b} size="xs" />{b.name}</span>)}{list.length > 2 && <span className="faint">{`+${list.length - 2}`}</span>}{v.kind === "card" && <span className="faint">asks every time</span>}</span>;
}

// One field: write-only, shows "set" when there's a value, and an empty box keeps it.
function Secret({ label, has, value, onChange, kind = "password", placeholder }: { label: string; has: boolean; value: string; onChange: (v: string) => void; kind?: string; placeholder?: string }) {
  return <Field label={label}><input type={kind} autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} placeholder={has ? "set · type to replace" : placeholder || ""} /></Field>;
}

function VaultEditor({ v, bots, done }: { v: VaultEntry | null; bots: BotCard[]; done: () => void }) {
  const [kind, setKind] = useState<VaultKind>(v?.kind || "login");
  const [f, setF] = useState({ name: v?.name || "", site: v?.site || "", note: v?.note || "" });
  // Typed values live only in this form's state and are dropped on save or leave.
  const [vals, setVals] = useState<Record<string, string>>({});
  const [access, setAccess] = useState<Record<string, Access>>(() => Object.fromEntries(bots.map((b) => [b.id, v?.always.includes(b.id) ? "always" : v?.allowed.includes(b.id) ? "ask" : "no"])));
  const has = (x: string) => !!v?.has.includes(x), set = (k: string) => (x: string) => setVals((s) => ({ ...s, [k]: x }));
  const save = async () => {
    const allowed = bots.filter((b) => access[b.id] !== "no").map((b) => b.id), always = kind === "card" ? [] : bots.filter((b) => access[b.id] === "always").map((b) => b.id);
    const body = { kind, ...f, ...Object.fromEntries(Object.entries(vals).filter(([, x]) => x)), allowed, always };
    if (v) await api.put(`/api/vault/${v.id}`, body); else await api.post("/api/vault", body);
    setVals({}); toast("Saved"); done();
  };
  const accessOpts = kind === "card" ? ([["no", "no"], ["ask", "asks every time"]] as const) : ([["no", "no"], ["ask", "asks each thread"], ["always", "without asking"]] as const);
  return (
    <div className="pc-card col" style={{ maxWidth: 640 }}>
      <div className="spread"><b className="pc-h3">{v ? v.name : "New secret"}</b><a className="small faint" href="#/settings/vault">Back to Vault</a></div>
      {v?.needs_update && <p className="small badc">{`A sign-in with this failed: ${v.needs_update}. Save the current value from your password manager and the crew can use it again.`}</p>}
      <div className="field"><label>Kind</label><Seg options={KINDS} value={kind} onChange={setKind} /></div>
      <Field label="Name the crew uses"><input value={f.name} placeholder="BESCOM login" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={kind === "card" ? "Site (optional: leave empty for any checkout)" : "Site it signs in to"} help="The page's host must be this domain or a subdomain of it, over https."><input value={f.site} placeholder="bescom.co.in" onChange={(e) => setF({ ...f, site: e.target.value })} /></Field>
      <Field label="Note (shown in the list, not secret)"><input value={f.note} placeholder="account ending 7781" onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      {kind === "card" ? <>
        <Secret label="Card number" has={has("card_number")} value={vals.number || ""} onChange={set("number")} kind="text" />
        <div className="grid3"><Secret label="Expiry (MM/YY)" has={has("card_expiry")} value={vals.expiry || ""} onChange={set("expiry")} kind="text" /><Secret label="CVC" has={has("card_cvc")} value={vals.cvc || ""} onChange={set("cvc")} /><Secret label="Name on card" has={has("card_name")} value={vals.holder || ""} onChange={set("holder")} kind="text" /></div>
      </> : <>
        <Secret label="Username, email or phone" has={has("username")} value={vals.username || ""} onChange={set("username")} kind="text" />
        <Secret label="Password" has={has("password")} value={vals.password || ""} onChange={set("password")} />
        {kind === "login+totp" && <TotpField has={has("totp")} value={vals.totp || ""} onChange={set("totp")} />}
      </>}
      <div className="field"><label>Who may use it</label>
        <div className="col" style={{ gap: 6 }}>{bots.map((b) => <div key={b.id} className="spread"><span className="row" style={{ gap: 8 }}><Face b={b} size="xs" />{b.name}</span><Seg options={accessOpts} value={kind === "card" && access[b.id] === "always" ? "ask" : access[b.id] || "no"} onChange={(x) => setAccess((a) => ({ ...a, [b.id]: x }))} /></div>)}</div>
      </div>
      <div className="row">
        <BusyButton className="pc-pill s" onClick={save}>{v ? "Save" : "Add secret"}</BusyButton>
        <a className="pc-pill o s" href="#/settings/vault">Cancel</a>
        {v && <ConfirmButton className="small faint" style={{ marginLeft: "auto" }} ask="Delete it?" onConfirm={async () => { await api.del(`/api/vault/${v.id}`); toast(`${v.name} deleted`); done(); }}>Delete</ConfirmButton>}
      </div>
      <p className="small faint">Values are write-only: stored encrypted on the server and never shown again.</p>
    </div>
  );
}

// A one-time-code seed: base32, an otpauth:// link, or Google Authenticator's export (otpauth-migration://, the
// "Transfer accounts" QR's text), decoded here so only the account picked is sent. A QR image works where the browser
// reads barcodes itself (BarcodeDetector); otherwise paste the QR's text.
function TotpField({ has, value, onChange }: { has: boolean; value: string; onChange: (v: string) => void }) {
  const [accounts, setAccounts] = useState<OtpAccount[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const detector = typeof window !== "undefined" && "BarcodeDetector" in window;
  const take = (text: string) => {
    if (/^otpauth-migration:/i.test(text.trim())) {
      try { const list = parseMigration(text).filter((a) => a.type === "totp"); setAccounts(list); onChange(""); if (!list.length) toast("No time-based codes in that export", true); }
      catch (e: any) { toast(e.message, true); }
    } else { setAccounts(null); setPicked(""); onChange(text); }
  };
  const fromImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const Det = (window as any).BarcodeDetector, bmp = await createImageBitmap(file);
      const codes = await new Det({ formats: ["qr_code"] }).detect(bmp);
      if (!codes.length) return toast("No QR code found in that image", true);
      take(String(codes[0].rawValue || ""));
    } catch { toast("Couldn't read that image; paste the QR's text instead", true); }
  };
  return (
    <Field label="One-time-code seed" help="The base32 secret, an otpauth:// link, or Google Authenticator's Transfer accounts QR text (otpauth-migration://).">
      <input type="password" autoComplete="off" spellCheck={false} value={accounts ? "" : value} placeholder={has ? "set · paste to replace" : "JBSW Y3DP … or otpauth://…"} onChange={(e) => take(e.target.value)} />
      {detector && <label className="small faint row" style={{ gap: 6 }}>Or a QR image<input type="file" accept="image/*" onChange={(e) => fromImage(e.target.files?.[0])} /></label>}
      {accounts && accounts.length > 0 && <div className="col" style={{ gap: 4 }}>
        <span className="small muted">Pick the account this secret is for:</span>
        {accounts.map((a) => <label key={a.uri} className="row small"><input type="radio" name="otp" checked={picked === a.uri} onChange={() => { setPicked(a.uri); onChange(a.uri); }} />{a.issuer ? `${a.issuer} · ${a.name}` : a.name}</label>)}
      </div>}
    </Field>
  );
}

// Google Passwords CSV: read in this tab, never uploaded whole. Only ticked rows go to the server, as logins.
function CsvImport({ bots, done }: { bots: BotCard[]; done: () => void }) {
  const [rows, setRows] = useState<(CsvLogin & { on: boolean })[] | null>(null);
  const [who, setWho] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const read = async (file: File | undefined) => {
    if (!file) return;
    try { setRows(parseGoogleCsv(await file.text()).map((r) => ({ ...r, on: false }))); } catch (e: any) { toast(e.message, true); }
  };
  const send = async () => {
    const pick = (rows || []).filter((r) => r.on && r.site);
    if (!pick.length) return toast("Tick the sites your crew needs", true);
    const r = await api.post<{ added: string[]; failed: { name: string; error: string }[] }>("/api/vault/import", { rows: pick.map((x) => ({ name: x.name, site: x.site, username: x.username, password: x.password, allowed: who })) });
    setRows(null);
    toast(`Imported ${r.added.length}${r.failed.length ? `; ${r.failed.length} failed (${r.failed.map((x) => `${x.name}: ${x.error}`).join("; ")})` : ""}. Now delete the CSV: it holds every password in plain text.`, r.failed.length > 0);
    done();
  };
  const shown = (rows || []).filter((r) => !q || `${r.name} ${r.site}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="pc-card col">
      <b className="pc-h3">Import from Google Passwords</b>
      <p className="small muted">In Google Password Manager: Settings → Export passwords, then pick the file here. It's read in this tab; only the sites you tick are sent. Notes aren't imported.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} />
      {rows && <>
        <input placeholder={`Filter ${rows.length} logins`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="vimp">{shown.map((r, i) => (
          <label key={`${r.url}|${r.username}|${i}`} className={`row small${r.site ? "" : " faint"}`}>
            <input type="checkbox" disabled={!r.site} checked={r.on} onChange={(e) => setRows((rs) => rs!.map((x) => (x === r ? { ...x, on: e.target.checked } : x)))} />
            <b>{r.name}</b><span className="faint">{r.site || "app login, no website"}</span><span className="faint">{r.username}</span>
          </label>))}
        </div>
        <div className="field"><label>Crew members who may use them (each asks once per thread)</label>
          <div className="row" style={{ flexWrap: "wrap" }}>{bots.map((b) => <label key={b.id} className="row small"><input type="checkbox" checked={who.includes(b.id)} onChange={(e) => setWho((w) => (e.target.checked ? [...w, b.id] : w.filter((x) => x !== b.id)))} />{b.name}</label>)}</div>
        </div>
        <div className="row"><BusyButton className="pc-pill s" onClick={send}>{`Import ${rows.filter((r) => r.on).length} ticked`}</BusyButton><button className="pc-pill o s" onClick={() => { setRows(null); done(); }}>Cancel</button></div>
      </>}
    </div>
  );
}
