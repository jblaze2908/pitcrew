// A new thread: one question, the ask box, and the ways to pick who takes it (Draft F7). #/new/<bot> starts on that member.
import { AskBox } from "../components/AskBox";
import { go } from "../lib/router";
import { useStore } from "../lib/store";

export function NewThread({ to }: { to?: string }) {
  const { bot } = useStore();
  const who = to ? bot(to) : null;
  return (
    <div className="page newthread">
      <h1 className="pc-h2">{who ? `New thread with ${who.name}` : "Who's taking this?"}</h1>
      <AskBox key={to || "auto"} to={who?.id ?? null} onSent={(r) => go(`#/t/${r.threadId}`)} />
      <div className="ways">
        <p><b>1</b><span><b>To</b> starts on Auto: the crew picks from each member's job, and asks you when it isn't sure.</span></p>
        <p><b>2</b><span>Type <b>@name</b> anywhere you write to pick a member. Two names go to the Crew Chief to plan.</span></p>
        <p><b>3</b><span>From a member's page or the Crew page, <b>+ New thread</b> starts with them.</span></p>
        <p><b>4</b><span>Picked wrong? The member pill in the thread header moves it to someone else.</span></p>
      </div>
    </div>);
}
