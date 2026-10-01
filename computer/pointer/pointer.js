// Draws the crew member's pointer from real input events (CDP- or X-dispatched), so the live view shows
// where it points, clicks and types. Display only: pointer-events none, closed shadow root, no page access beyond events.
(() => {
  if (window.top !== window) return;
  const { hue, name } = globalThis.PC_POINTER || { hue: "#4f7dff", name: "Crew" };
  const host = document.createElement("pitcrew-pointer");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host{all:initial}
    .layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
    .p{position:absolute;left:0;top:0;transform:translate(-100px,-100px);transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .4s;will-change:transform;opacity:0}
    .p.on{opacity:1}.p.idle{opacity:.45}
    svg{display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));transform-origin:3px 3px;transition:transform .12s}
    .p.down svg{transform:scale(.82)}
    .tag{position:absolute;left:22px;top:20px;white-space:nowrap;font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.04em;padding:5px 8px;border-radius:99px;background:${hue};color:#111114;box-shadow:0 2px 6px rgba(0,0,0,.25)}
    .dots i{display:inline-block;width:4px;height:4px;margin-left:3px;border-radius:50%;background:#111114;animation:b 1s infinite}
    .dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
    @keyframes b{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
    .ring{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2.5px solid ${hue};animation:r .55s ease-out forwards}
    @keyframes r{from{transform:scale(.2);opacity:1}to{transform:scale(1.4);opacity:0}}
  </style>
  <div class="layer"><div class="p"><svg width="26" height="30" viewBox="0 0 26 30">
    <path d="M3 3 L3 24 L9 18.5 L13 27 L17 25.2 L13 16.8 L21 16.8 Z" fill="${hue}" stroke="#111114" stroke-width="2" stroke-linejoin="round"/>
    <rect x="6.2" y="10" width="2.4" height="4" rx="1" fill="#111114"/><rect x="10.4" y="12.4" width="2.4" height="4" rx="1" fill="#111114"/>
  </svg><span class="tag"></span></div></div>`;
  const p = root.querySelector(".p"), tag = root.querySelector(".tag"), layer = root.querySelector(".layer");
  tag.textContent = name;
  let x = -100, y = -100, idleT = 0, typingT = 0, saveT = 0;
  const place = (nx, ny) => { x = nx; y = ny; p.style.transform = `translate(${x}px,${y}px)`; wake(); };
  const wake = () => { p.classList.add("on"); p.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => p.classList.add("idle"), 4000); };
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { chrome.storage.local.set({ pcPointer: { x, y } }); } catch {} }, 150); };
  const typing = (on) => {
    if (on) { tag.replaceChildren(document.createTextNode(name), Object.assign(document.createElement("span"), { className: "dots", innerHTML: "<i></i><i></i><i></i>" })); clearTimeout(typingT); typingT = setTimeout(() => typing(false), 900); }
    else tag.textContent = name;
  };
  addEventListener("mousemove", (e) => { place(e.clientX, e.clientY); save(); }, { capture: true, passive: true });
  addEventListener("mousedown", (e) => {
    place(e.clientX, e.clientY); p.classList.add("down");
    const ring = document.createElement("div"); ring.className = "ring"; ring.style.left = `${e.clientX}px`; ring.style.top = `${e.clientY}px`;
    layer.append(ring); setTimeout(() => ring.remove(), 600);
  }, { capture: true, passive: true });
  addEventListener("mouseup", () => p.classList.remove("down"), { capture: true, passive: true });
  // Playwright fills without moving the mouse; glide to the field being typed into.
  const onType = (e) => {
    const el = e.target instanceof Element ? e.target : document.activeElement;
    if (el && el !== document.body) { const r = el.getBoundingClientRect(); if (r.width && (Math.abs(x - r.left) > r.width || Math.abs(y - r.top) > r.height * 2)) place(r.left + Math.min(r.width - 8, 24), r.top + r.height / 2); }
    typing(true); wake();
  };
  addEventListener("keydown", onType, { capture: true, passive: true });
  addEventListener("input", onType, { capture: true, passive: true });
  const mount = () => { if (!host.isConnected) (document.body || document.documentElement).append(host); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true }); else mount();
  // The pointer carries over page loads, so a click that navigates still shows where it happened.
  try { chrome.storage.local.get("pcPointer", (v) => { if (v?.pcPointer && x < 0) { place(v.pcPointer.x, v.pcPointer.y); p.classList.add("idle"); } }); } catch {}
})();
