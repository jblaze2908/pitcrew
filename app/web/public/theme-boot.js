// Applies the saved theme before first paint (dark is the default).
try { const t = localStorage.getItem("pc-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
