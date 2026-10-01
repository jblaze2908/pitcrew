// A tiny toast bus: anything can call toast(); <Toasts/> draws them.
export interface ToastItem { id: number; text: string; bad: boolean }

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<(list: ToastItem[]) => void>();
const emit = () => listeners.forEach((fn) => fn(items));

export function toast(text: string, bad = false) {
  const t = { id: ++seq, text, bad };
  items = [...items, t]; emit();
  setTimeout(() => { items = items.filter((x) => x !== t); emit(); }, bad ? 6000 : 3000);
}

export function onToasts(fn: (list: ToastItem[]) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
