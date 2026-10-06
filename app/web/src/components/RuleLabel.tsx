// A standing approval's label as an action, shared by Pit stops → Rules, Settings → Permissions and member Settings.
const BROWSER_RULE: Record<string, string> = { run_code_unsafe: "Run browser scripts", evaluate: "Run page JavaScript", navigate: "Open pages", click: "Click", type: "Type" };
/** Rule labels are stored as matched ("browser browser_run_code_unsafe", "run python3 bot/work/x.py"); say them as an action. */
export function RuleLabel({ label }: { label: string }) {
  const [, core, scope = ""] = /^(.*?)( \(this thread\))?$/.exec(label.replace(/(\/?bot\/work\/)/g, "")) || [];
  const br = /^browser browser_(\w+)$/.exec(core);
  const run = /^run (.+)$/.exec(core);
  const body = br ? BROWSER_RULE[br[1]] || `Browser: ${br[1].replace(/_/g, " ")}` : run ? <>Run <code className="pc-m">{run[1]}</code></> : core;
  return <>{body}{scope && <span className="faint">{scope}</span>}</>;
}
