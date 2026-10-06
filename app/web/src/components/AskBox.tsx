// The front door: who takes the message shows before sending (picked, named, or the router's guess; two or more named → a plan).
// The guess costs one jev call per 600 ms typing pause, none when a member is picked or named.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AskResult, BotCard, RoutePick } from "../../../shared/types";
import { api } from "../lib/api";
import { cap, escRe } from "../lib/format";
import { connected, useStore } from "../lib/store";
import { toast } from "../lib/toast";
import { jobLine, MemberMenu, type MenuHandle } from "./MemberMenu";
import { Chev, Face, hueStyle, Loader } from "./ui";

const ROUTE_SURE = 0.55;
const GUESS_AFTER_MS = 600;
const STARTERS = ["Pay this month's electricity bill", "Compare my health-insurance renewal", "Watch BLR → GOI fares for 14 Dec"];

type Sent = (r: { threadId: string; botId: string }) => void;
/** to: a member to start with (New thread with …); the pill and @ can still change it. */
export function AskBox({ onSent, to }: { onSent: Sent; to?: string | null }) {
  const { S, setS } = useStore();
  if (S.paused || !connected(S)) {
    return (
      <div className="ask off">
        <div className="row" style={{ gap: 12, opacity: 0.55 }}><span className="to auto">Auto</span><p className="q ph">{S.paused ? "The crew is stopped. Resume to send." : "Connect a provider to start."}</p></div>
        <div className="bar"><span style={{ flex: 1 }} />
          {S.paused ? <button className="pc-pill s" onClick={async () => setS(await api.post("/api/resume"))}>Resume the crew</button>
            : <a className="pc-pill s" href="#/settings">Connect a provider</a>}
        </div>
      </div>
    );
  }
  return <LiveAskBox onSent={onSent} start={to ?? null} />;
}

/** Name matching for the crew: who a text names, and the text split into plain runs and highlighted names. */
function useNames(bots: BotCard[]) {
  return useMemo(() => {
    const specialists = bots.filter((b) => b.kind !== "chief");
    const each = specialists.map((b) => ({ b, re: new RegExp(`(^|[^\\p{L}])@?${escRe(b.name)}(?![\\p{L}])`, "iu") }));
    const longestFirst = [...specialists].sort((a, b) => b.name.length - a.name.length);
    const any = longestFirst.length ? new RegExp(`(^|[^\\p{L}])(@?(?:${longestFirst.map((b) => escRe(b.name)).join("|")}))(?![\\p{L}])`, "giu") : null;
    const namedIn = (t: string) => each.filter((x) => x.re.test(t)).map((x) => x.b);
    const highlight = (t: string): ReactNode[] => {
      const parts: ReactNode[] = [];
      if (any) {
        any.lastIndex = 0;
        let last = 0, m: RegExpExecArray | null;
        while ((m = any.exec(t))) {
          const start = m.index + m[1].length, word = m[2];
          const b = specialists.find((x) => x.name.toLowerCase() === word.replace(/^@/, "").toLowerCase());
          parts.push(t.slice(last, start), <mark key={start} style={hueStyle(b?.hue)}>{word}</mark>);
          last = start + word.length;
        }
        parts.push(t.slice(last));
      } else parts.push(t);
      parts.push("\n");
      return parts;
    };
    return { specialists, namedIn, highlight };
  }, [bots]);
}

type Menu = { mode: "pill" } | { mode: "mention"; filter: string; start: number; caret: number };

function LiveAskBox({ onSent, start }: { onSent: Sent; start: string | null }) {
  const { S, bot, chief } = useStore();
  const { specialists, namedIn, highlight } = useNames(S.bots);
  const [text, setText] = useState("");
  const [to, setTo] = useState<string | null>(start);
  const [guess, setGuess] = useState<RoutePick | null>(null);
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const menuKeys = useRef<MenuHandle>(null);
  const caretAfter = useRef<number | null>(null);
  const seq = useRef(0);
  // Read through a ref so a /api/state refresh (new bot objects) doesn't restart the guess.
  const namedRef = useRef(namedIn);
  namedRef.current = namedIn;

  // The route guess: cancelled by typing again, and skipped when someone is picked or named.
  useEffect(() => {
    const my = ++seq.current;
    setPending(false);
    const t = text.trim();
    if (to || t.length < 8 || namedRef.current(t).length) return;
    const timer = setTimeout(async () => {
      setPending(true);
      const r = await api.post<RoutePick>("/api/ask", { text: t, dry: true }, { quiet: true }).catch(() => null);
      if (my !== seq.current) return;
      setGuess(r); setPending(false);
    }, GUESS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [text, to]);

  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "auto"; el.style.height = `${Math.min(240, el.scrollHeight)}px`;
    if (caretAfter.current != null) { el.selectionStart = el.selectionEnd = caretAfter.current; caretAfter.current = null; }
    if (hl.current) hl.current.scrollTop = el.scrollTop;
  }, [text]);

  const sure = !!guess && (guess.confidence == null || guess.confidence >= ROUTE_SURE || !guess.alternatives?.length);
  const named = namedIn(text), multi = named.length > 1 && !to;
  const m = to ? bot(to) : multi ? chief : named.length === 1 ? named[0] : !pending && sure ? bot(guess!.botId) : undefined;
  const unsure = !to && !multi && named.length !== 1 && !pending && !!guess && !sure;
  const label = to ? `You picked${m?.private ? " · private" : ""}`
    : multi ? `${named.length} members · the Crew Chief plans it`
    : named.length === 1 && m ? `You named ${m.name}${m.private ? " · private" : ""}`
    : m ? `Picked by Pitcrew${m.private ? " · private" : jobLine(m) ? ` · ${jobLine(m).toLowerCase()}` : ""}`
    : unsure ? "Who's this for?" : "";
  const unknown = /\b([a-z]+)\s+bot\b/i.exec(text);
  const stranger = unknown && !S.bots.some((b) => b.name.toLowerCase() === unknown[1].toLowerCase()) ? unknown[1] : null;
  const candidates = unsure ? [guess!.botId, ...guess!.alternatives.map((a) => a.botId)].map(bot).filter((b): b is BotCard => !!b) : [];
  const privates = multi ? named.filter((b) => b.private) : [];

  const pickTo = (id: string | null) => { setTo(id); ta.current?.focus(); };
  const onInput = (v: string, caret: number) => {
    setText(v);
    // @ at the start sets the pill; anywhere else it becomes the member's name in the text, which names them.
    const mm = /(^|\s)@([\p{L}\d]*)$/u.exec(v.slice(0, caret));
    if (mm) setMenu({ mode: "mention", filter: mm[2], start: caret - mm[2].length - 1, caret });
    else if (menu?.mode === "mention") setMenu(null);
  };
  const pickMention = (id: string | null, start: number, caret: number) => {
    const b = bot(id); if (!b) return;
    if (!text.slice(0, start).trim()) { setText(text.slice(caret).replace(/^\s+/, "")); setTo(b.id); }
    else { setText(`${text.slice(0, start)}${b.name} ${text.slice(caret)}`); caretAfter.current = start + b.name.length + 1; }
    ta.current?.focus();
  };

  const send = async () => {
    const t = text.trim();
    if (!t || unsure || sending) return;
    const botId = to || (named.length ? null : !pending && sure ? guess!.botId : null);
    setSending(true);
    try {
      const r = await api.post<AskResult>("/api/ask", { text: t, ...(botId ? { botId } : {}) });
      if ("choose" in r) { setGuess({ botId: r.choose[0], confidence: 0, alternatives: r.choose.slice(1).map((x) => ({ botId: x })), by: "choose" }); return; }
      setText(""); setTo(null); setGuess(null);
      toast(`Sent to ${bot(r.botId)?.name || "the crew"}`);
      onSent(r);
    } finally { setSending(false); }
  };

  const quote = (chip: ReactNode, ...rest: ReactNode[]) => <div className="pc-quote small row" style={{ gap: 10 }}>{chip}{rest}</div>;
  return (
    <section className="col askwrap">
      <div className="ask">
        <div className="row top">
          <button ref={pill} className={`to${m ? "" : " auto"}`} style={m ? hueStyle(m.hue) : undefined} title="Who takes it" onClick={() => setMenu({ mode: "pill" })}>
            {pending && !m ? <><Loader />Finding who…</> : m ? <><Face b={m} size="xs" />{m.name}<Chev /></> : <>Auto<Chev /></>}
          </button>
          <div className="field">
            <div ref={hl} className="hl" aria-hidden="true">{highlight(text)}</div>
            <textarea ref={ta} rows={1} placeholder="Ask your crew anything…" value={text}
              onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
              onScroll={(e) => { if (hl.current) hl.current.scrollTop = e.currentTarget.scrollTop; }}
              onKeyDown={(e) => {
                if (menu && menuKeys.current?.key(e)) { e.preventDefault(); return; }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }} />
          </div>
        </div>
        <div className="bar">
          <span className="pc-lab ell">{label}</span><span style={{ flex: 1 }} />
          <span className="small faint hint">@ to pick · Enter to send</span>
          <button className="pc-pill s" disabled={unsure || !text.trim() || sending} onClick={send}>{unsure ? "Pick one" : multi ? "Plan it" : m ? `Send to ${m.name}` : "Send"}</button>
        </div>
        <div className="extra">
          {candidates.length > 0 && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {candidates.map((b) => <button key={b.id} className="to alt" style={hueStyle(b.hue)} onClick={() => pickTo(b.id)}><Face b={b} size="xs" />{b.name}</button>)}
          </div>}
          {stranger && quote(<span style={{ flex: 1 }}>{`No one on the crew is called ${cap(stranger)}.`}</span>,
            <button key="p" className="pc-pill o s" onClick={() => setMenu({ mode: "pill" })}>Pick someone</button>,
            <a key="h" className="pc-pill o s" href="#/hire">{`Hire ${stranger}`}</a>)}
          {m?.private && quote(<span className="pc-chip">Private</span>, <span key="t">{`Only ${m.name} sees this and its answer. The Crew Chief can't ask ${m.name}.`}</span>)}
          {privates.length > 0 && quote(<span className="pc-chip">Private</span>, <span key="t">{`${privates.map((b) => b.name).join(", ")} is private, so the plan can't use it.`}</span>)}
        </div>
      </div>
      <div className="row sugs">
        {S.bots.length > 1
          ? specialists.slice(0, 4).map((b) => <button key={b.id} className="sug" onClick={() => pickTo(b.id)}><Face b={b} size="xs" />{b.name}</button>)
          : STARTERS.map((x) => <button key={x} className="sug" onClick={() => { setText(x); ta.current?.focus(); }}>{x}</button>)}
      </div>
      {menu?.mode === "pill" && pill.current && <MemberMenu anchor={pill.current} current={to} handle={menuKeys} onClose={() => setMenu(null)} onPick={pickTo} />}
      {menu?.mode === "mention" && ta.current && <MemberMenu key={menu.filter} anchor={ta.current} auto={false} filter={menu.filter} handle={menuKeys}
        onClose={() => setMenu(null)} onPick={(id) => pickMention(id, menu.start, menu.caret)} />}
    </section>
  );
}
