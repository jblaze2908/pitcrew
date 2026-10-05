// Line icons for the shell: 16px, stroke follows currentColor.
const PATHS: Record<string, string> = {
  rail: '<rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M6 2.5v11"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  home: '<path d="M2.5 7.5L8 3l5.5 4.5V13h-11z"/>',
  threads: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  crew: '<circle cx="5.5" cy="6" r="2.2"/><circle cx="11" cy="6" r="2.2"/><path d="M1.8 13c.6-2 2-3 3.7-3s3.1 1 3.7 3M8.6 11.2c.5-.8 1.4-1.2 2.4-1.2 1.7 0 3.1 1 3.7 3"/>',
  flag: '<path d="M4 14V2.5h8l-2 3 2 3H4"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2.2 1.4"/>',
  library: '<rect x="2.5" y="2.5" width="4" height="11" rx="1"/><rect x="9.5" y="2.5" width="4" height="11" rx="1"/>',
  chart: '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/>',
  chev: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  panel: '<rect x="2" y="2.5" width="12" height="11" rx="2.5"/><path d="M10 2.5v11"/>',
  corner: '<rect x="2" y="3" width="12" height="10" rx="2"/><rect x="8" y="8" width="4.5" height="3.5" rx=".8"/>',
  expand: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9"/>',
  pen: '<path d="M10.5 2.5l3 3L5 14H2v-3z"/>',
  spark: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M4 12l1.8-1.8M10.2 5.8L12 4"/>',
  compact: '<path d="M5 3l3 3 3-3M5 13l3-3 3 3"/>',
  fresh: '<path d="M3 8h8M8 4.5L11.5 8 8 11.5M13.5 3v10"/>',
  pin: '<path d="M5.5 2.5h5l-1 4 2.5 2.5H4L6.5 6.5z"/><path d="M8 9v4.5"/>',
  folder: '<path d="M2.5 4.5h4l1.5 1.5h5.5v7h-11z"/>',
  person: '<circle cx="8" cy="6" r="2.5"/><path d="M3.5 13.5c.8-2.2 2.5-3.3 4.5-3.3s3.7 1.1 4.5 3.3"/>',
  archive: '<rect x="2.5" y="3" width="11" height="3" rx="1"/><path d="M3.5 6v7h9V6M6.5 9h3"/>',
  attach: '<path d="M8 3v10M3 8h10"/>',
  up: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] || "" }} />;
}
