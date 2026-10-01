import { useEffect, useState } from "react";
import { onToasts, type ToastItem } from "../lib/toast";

export function Toasts() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => onToasts(setList), []);
  return <>{list.map((t) => <div key={t.id} className={`toast ${t.bad ? "bad" : ""}`}>{t.text}</div>)}</>;
}
