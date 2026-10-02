// Line icons for tool steps, drawn in currentColor so they take the design system's ink. Generic shapes, no brand marks.
import type { StepIcon as Name } from "../lib/steps";

const P: Record<Name, string[]> = {
  mail: ["M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z", "M3.5 7l8.5 6 8.5-6"],
  calendar: ["M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M4 10h16", "M8 3v4", "M16 3v4"],
  drive: ["M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  engram: ["M16.5 13.5a5 5 0 1 1 .2-3.5H7.5"],
  ledger: ["M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h12", "M16 13h2"],
  web: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M3 12h18", "M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"],
  browser: ["M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M3 9h18"],
  terminal: ["M5 8l4 4-4 4", "M12 16h7"],
  file: ["M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M14 3v5h5"],
  tool: ["M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z", "M12 3v3", "M12 18v3", "M3 12h3", "M18 12h3"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z", "M20 20l-4-4"],
  read: ["M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z", "M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z"],
  add: ["M12 5v14", "M5 12h14"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  remove: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  send: ["M21 3L10 14", "M21 3l-7 18-4-7-7-4z"],
};

export function StepIcon({ name }: { name: Name }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
