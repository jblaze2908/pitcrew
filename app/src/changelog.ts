// What changed in the harness, for crew members (whats_new). One line per change that alters what a member can do or
// should do; append to the end, never edit or reorder (members track how many they've seen). Internal changes get none.
export const CHANGELOG: { date: string; note: string }[] = [
  { date: "2026-10-04", note: "Full browser access: browser_evaluate, browser_run_code_unsafe, network requests and bodies, cookies and local/session storage. Secrets come back masked; page JS is judged by jev." },
  { date: "2026-10-04", note: "browser_replay_request re-sends a captured request with a changed body, cursor or query, from the page's session; headers stay hidden." },
  { date: "2026-10-04", note: "Bound dashboards: render_surface with source (a SQLite ledger) and queries; tiles fill from the ledger whenever viewed. Pass id to update a surface in place." },
  { date: "2026-10-04", note: "Scheduled runs stay quiet: reply \"QUIET: <what you checked>\" unless an alert fired, something failed, the driver must act, or the digest is due." },
  { date: "2026-10-04", note: "read_thread reads a whole thread; list_schedules shows each schedule's last run; query_ledger reads another member's ledger." },
  { date: "2026-10-04", note: "Probes and raw dumps go in /bot/work/.scratch. Your skills live in /bot/work/skills/<name>/ (one git repo); load one with skill_view." },
  { date: "2026-10-04", note: "Memory tiers: remember(scope) = session (this thread), agent (your own, 3,000 chars) or global (facts about the driver, reviewed in Engram)." },
  { date: "2026-10-04", note: "A blocked action says jev's reason; an expired pit stop means the driver didn't answer, not a refusal. Repeated blocks escalate to the driver." },
  { date: "2026-10-04", note: "harness_help(topic) explains any part of the harness; whats_new lists changes like this one." },
  { date: "2026-10-04", note: "Retros: after a run that stood out (or weekly for scheduled work) you get a \"[Retro]\" with Pitcrew's measurements. Fix your skill or memory; file what only Pitcrew can fix with suggest_improvement." },
  { date: "2026-10-04", note: "The Crew Chief manages the crew: crew_overview, propose_soul (the driver approves) and triage_suggestion. A SOUL is the driver's description of who a member is and how it works." },
  { date: "2026-10-04", note: "The Crew Chief can propose_retire a member whose job is gone, duplicated or idle; the driver approves. Retiring stops its schedules and keeps its threads and memory." },
  { date: "2026-10-04", note: "The Crew Chief is the workspace admin: propose_member_change (profile, model, budget, policy), member_files and delete_member_files; each change waits for the driver." },
  { date: "2026-10-04", note: "publish_file is opt-in: publish only when the driver asks for a page, file or link, or to share something. Otherwise answer in the thread." },
  { date: "2026-10-04", note: "Images: generate_image makes or edits images with any OpenRouter model (pass images to edit); on the ChatGPT plan Codex's image_gen works too. Both save to /bot/work/out/images and show in the chat. harness_help images." },
];
