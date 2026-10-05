// Applies the saved theme before first paint (dark is the default); "system" follows the computer's setting, live.
try {
  const t = localStorage.getItem("pc-theme"), mq = matchMedia("(prefers-color-scheme: light)");
  const apply = () => { const s = localStorage.getItem("pc-theme"); if (s === "system") document.documentElement.dataset.theme = mq.matches ? "light" : "dark"; };
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else apply();
  mq.addEventListener("change", apply);
} catch {}
