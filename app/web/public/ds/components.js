var draftComponents = (function () {
  var registry = {}
  var defined = []
  var sheets = {}
  var themeCss = null
  var themeSheet = new CSSStyleSheet()
  var fallbackSheet = new CSSStyleSheet()
  fallbackSheet.replaceSync(':host{display:block;outline:1.5px dashed #d0341f;outline-offset:-1.5px;padding:8px 10px;font:12px/1.4 ui-monospace,monospace;color:#d0341f;background:rgba(208,52,31,.06)}')
  var MAX_DEPTH = 8

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function propDefault(def, name) {
    for (var i = 0; i < def.props.length; i++) if (def.props[i].name === name) return def.props[i].default
    return undefined
  }

  /* {{prop}} -> the instance attribute, else the prop default; always escaped */
  function fill(def, el) {
    var tpl = def.html
    var out = ''
    var i = 0
    for (;;) {
      var a = tpl.indexOf('{{', i)
      if (a < 0) break
      var b = tpl.indexOf('}}', a + 2)
      if (b < 0) break
      var name = tpl.slice(a + 2, b).trim()
      out += tpl.slice(i, a)
      if (/^[a-z][a-z0-9-]*$/.test(name)) {
        var v = el.getAttribute(name)
        if (v === null) v = propDefault(def, name)
        out += esc(v == null ? '' : v)
      } else {
        out += tpl.slice(a, b + 2)
      }
      i = b + 2
    }
    return out + tpl.slice(i)
  }

  /* what a render depends on: the definition version and the instance attributes */
  function keyOf(def, el) {
    var k = def ? (def.deletedAt ? 'x' : def.version) + ':' : '?:'
    for (var i = 0; i < el.attributes.length; i++) {
      var n = el.attributes[i].name
      if (n === 'style' || n === 'class' || n === 'contenteditable' || n.indexOf('data-v-') === 0) continue
      k += n + '=' + el.attributes[i].value + ';'
    }
    return k
  }

  function depth(el) {
    var d = 0
    for (var r = el.getRootNode(); r && r.host; r = r.host.getRootNode()) d++
    return d
  }

  function sheetFor(def) {
    var s = sheets[def.name]
    if (!s || s.v !== def.version) {
      s = { v: def.version, sheet: new CSSStyleSheet() }
      s.sheet.replaceSync(def.css || '')
      sheets[def.name] = s
    }
    return s.sheet
  }

  function render(el) {
    var def = registry[el.localName]
    var key = keyOf(def, el)
    if (el.__draftKey === key) return
    el.__draftKey = key
    var root = el.shadowRoot || el.attachShadow({ mode: 'open' })
    if (!def || def.deletedAt || depth(el) > MAX_DEPTH) {
      root.adoptedStyleSheets = [fallbackSheet]
      root.innerHTML = (def && !def.deletedAt ? 'Component nested too deep: &lt;' : 'Missing component: &lt;') + esc(el.localName) + '&gt; <slot></slot>'
      return
    }
    root.adoptedStyleSheets = [themeSheet, sheetFor(def)]
    root.innerHTML = fill(def, el)
  }

  function define(name) {
    if (customElements.get(name)) return
    customElements.define(name, class extends HTMLElement {
      connectedCallback() { render(this) }
    })
    defined.push(name)
  }

  function refresh(root) {
    if (!defined.length) return
    var els = root.querySelectorAll(defined.join(','))
    for (var i = 0; i < els.length; i++) {
      render(els[i])
      if (els[i].shadowRoot) refresh(els[i].shadowRoot)
    }
  }

  function set(list) {
    var next = {}
    for (var i = 0; i < list.length; i++) next[list[i].name] = list[i]
    registry = next
    for (var n in next) define(n)
    refresh(document)
  }

  function setTheme(css) {
    if (css === themeCss) return
    themeCss = css
    themeSheet.replaceSync(css || '')
  }

  /* server renders: the theme style precedes this script; the utilities
     style closes the head, so it is parsed only after this runs */
  function boot(list) {
    var st = document.querySelector('style[data-draft-theme]')
    setTheme(st ? st.textContent : '')
    set(list)
    document.addEventListener('DOMContentLoaded', function () {
      var ut = document.querySelector('style[data-draft-utilities]')
      if (ut) setTheme((st ? st.textContent : '') + ut.textContent)
    })
  }

  return { set: set, refresh: function () { refresh(document) }, setTheme: setTheme, boot: boot }
})();draftComponents.boot([{"name":"pc-appnav","html":"\u003caside class=\"s\">\u003cnav class=\"nv\">\u003cspan class=\"pc-nav pitwall\">Pit wall\u003cem class=\"hot\">3\u003c/em>\u003c/span>\u003cspan class=\"pc-nav threads\">Threads\u003cem>14\u003c/em>\u003c/span>\u003cspan class=\"pc-nav crew\">Crew\u003cem>5\u003c/em>\u003c/span>\u003cspan class=\"pc-nav telemetry\">Telemetry\u003c/span>\u003cspan class=\"pc-nav settings\">Settings\u003c/span>\u003c/nav>\u003cp class=\"pc-lab lb\">Crew\u003c/p>\u003cdiv class=\"ro\">\u003cspan class=\"pc-tile t general\" style=\"--hue:var(--c1)\">\u003cpc-bot size=\"sm\" hue=\"c1\" mood=\"working\">\u003c/pc-bot>\u003cb>General\u003c/b>\u003cpc-loader>\u003c/pc-loader>\u003c/span>\u003cspan class=\"pc-tile t inbox\" style=\"--hue:var(--c5)\">\u003cpc-bot size=\"sm\" hue=\"c5\" shape=\"round\" mood=\"needs\">\u003c/pc-bot>\u003cb>Inbox\u003c/b>\u003csmall class=\"sig\">PIT STOP\u003c/small>\u003c/span>\u003cspan class=\"pc-tile t bills\" style=\"--hue:var(--c2)\">\u003cpc-bot size=\"sm\" hue=\"c2\" shape=\"blob\" mood=\"needs\">\u003c/pc-bot>\u003cb>Bills\u003c/b>\u003csmall class=\"sig\">PIT STOP\u003c/small>\u003c/span>\u003cspan class=\"pc-tile t groceries\" style=\"--hue:var(--c3)\">\u003cpc-bot size=\"sm\" hue=\"c3\" mood=\"failed\">\u003c/pc-bot>\u003cb>Groceries\u003c/b>\u003csmall class=\"bad\">FAIL\u003c/small>\u003c/span>\u003cspan class=\"pc-tile t flights\" style=\"--hue:var(--c6)\">\u003cpc-bot size=\"sm\" hue=\"c6\" shape=\"round\" mood=\"sleep\">\u003c/pc-bot>\u003cb>Flights\u003c/b>\u003csmall>GARAGE\u003c/small>\u003c/span>\u003c/div>\u003cspan class=\"pc-pill nt\">+ New thread\u003c/span>\u003c/aside>","css":":host{display:block;height:100%}\n.s{box-sizing:border-box;width:236px;height:100%;display:flex;flex-direction:column;gap:20px;padding:16px;background:var(--ground-deep);border-right:1px solid var(--line)}\n.nv{display:flex;flex-direction:column;gap:4px}\n.pc-nav em{margin-left:auto;font:500 11px/1 var(--font-data);font-style:normal;color:var(--ink-3)}\n.pc-nav em.hot{min-width:20px;height:18px;padding:0 6px;display:grid;place-items:center;border-radius:99px;background:var(--signal);color:var(--on-signal)}\n:host([active=\"pitwall\"]) .pitwall,:host([active=\"threads\"]) .threads,:host([active=\"crew\"]) .crew,:host([active=\"telemetry\"]) .telemetry,:host([active=\"settings\"]) .settings{background:var(--btn);color:var(--on-btn)}\n.lb{margin:0 8px -12px}\n.ro{display:flex;flex-direction:column;gap:6px}\n.t{display:flex;align-items:center;gap:12px;height:46px;padding:0 10px;box-sizing:border-box}\n.t b{flex:1;font:700 14.5px/1 var(--font-display);color:var(--ink)}\n.t small{font:500 10px/1 var(--font-data);letter-spacing:.04em;color:var(--ink-3)}\n.t small.sig{color:var(--signal)}\n.t small.bad{color:var(--bad)}\n:host([bot]) .t{opacity:.55}\n:host([bot=\"general\"]) .general,:host([bot=\"inbox\"]) .inbox,:host([bot=\"bills\"]) .bills,:host([bot=\"groceries\"]) .groceries,:host([bot=\"flights\"]) .flights{opacity:1;box-shadow:inset 0 0 0 1.5px var(--hue)}\n:host([bot=\"\"]) .t{opacity:1}\n.nt{margin-top:auto}","props":[{"name":"active","default":"pitwall","description":"pitwall | threads | crew | telemetry | settings"},{"name":"bot","default":"","description":"general | inbox | bills | groceries | flights"}],"version":1},{"name":"pc-bot","html":"\u003cspan class=\"b\">\u003cspan class=\"ring\">\u003c/span>\u003cspan class=\"face\">\u003ci class=\"e\">\u003c/i>\u003ci class=\"e\">\u003c/i>\u003c/span>\u003cspan class=\"led\">\u003c/span>\u003cspan class=\"z\">z\u003c/span>\u003c/span>","css":":host{display:inline-flex;flex:none;--s:40px;--body:var(--ink-3);--eye:#111114}\n:host([size=\"xs\"]){--s:20px}\n:host([size=\"sm\"]){--s:28px}\n:host([size=\"lg\"]){--s:64px}\n:host([size=\"xl\"]){--s:112px}\n:host([hue=\"c1\"]){--body:var(--c1)}\n:host([hue=\"c2\"]){--body:var(--c2)}\n:host([hue=\"c3\"]){--body:var(--c3)}\n:host([hue=\"c5\"]){--body:var(--c5)}\n:host([hue=\"c6\"]){--body:var(--c6)}\n.b{position:relative;display:grid;place-items:center;width:var(--s);height:var(--s);border-radius:27%;background:var(--body);box-shadow:inset 0 calc(var(--s)*-.07) 0 rgba(0,0,0,.2),inset 0 calc(var(--s)*.05) 0 rgba(255,255,255,.2)}\n:host([shape=\"round\"]) .b{border-radius:50%}\n:host([shape=\"blob\"]) .b{border-radius:44% 56% 52% 48%/54% 44% 56% 46%}\n.face{display:flex;gap:calc(var(--s)*.16);transform:translateY(-5%)}\n.e{display:block;width:calc(var(--s)*.13);height:calc(var(--s)*.22);border-radius:calc(var(--s)*.05);background:var(--eye);animation:blink 4.6s infinite}\n.z,.ring,.led{display:none}\n:host([mood=\"working\"]) .e{height:calc(var(--s)*.15);animation:none}\n:host([mood=\"working\"]) .face{animation:read 1.8s ease-in-out infinite;transform:translate(-24%,2%)}\n:host([mood=\"working\"]) .b{animation:bob 1.8s ease-in-out infinite}\n:host([mood=\"working\"]) .led{display:block;position:absolute;top:calc(var(--s)*-.06);right:calc(var(--s)*-.06);width:max(6px,calc(var(--s)*.2));height:max(6px,calc(var(--s)*.2));border-radius:28%;background:var(--data);box-shadow:0 0 0 max(2px,calc(var(--s)*.05)) var(--ground);animation:pulse 1.2s ease-in-out infinite}\n:host([mood=\"needs\"]) .e{height:calc(var(--s)*.27);width:calc(var(--s)*.15)}\n:host([mood=\"needs\"]) .face{transform:translateY(-12%)}\n:host([mood=\"needs\"]) .ring{display:block;position:absolute;inset:calc(var(--s)*-.11);border-radius:inherit;box-shadow:0 0 0 calc(max(1.5px,var(--s)*.035)) var(--signal);animation:pulse 2.2s ease-in-out infinite}\n:host([mood=\"done\"]) .e{height:calc(var(--s)*.11);width:calc(var(--s)*.17);background:none;border:calc(var(--s)*.055) solid var(--eye);border-bottom:0;border-radius:calc(var(--s)*.2) calc(var(--s)*.2) 0 0;animation:none}\n:host([mood=\"failed\"]) .b{filter:saturate(.3) brightness(.8)}\n:host([mood=\"failed\"]) .e{height:calc(var(--s)*.055);width:calc(var(--s)*.16);animation:none}\n:host([mood=\"failed\"]) .e:first-child{transform:rotate(-20deg)}\n:host([mood=\"failed\"]) .e:last-child{transform:rotate(20deg)}\n:host([mood=\"failed\"]) .face{transform:translateY(8%)}\n:host([mood=\"sleep\"]) .b{opacity:.82}\n:host([mood=\"sleep\"]) .e{height:calc(var(--s)*.05);width:calc(var(--s)*.15);animation:none}\n:host([mood=\"sleep\"]) .face{transform:translateY(6%)}\n:host([mood=\"sleep\"]) .z{display:block;position:absolute;right:-14%;top:-24%;font:600 calc(var(--s)*.3)/1 var(--font-data);color:var(--ink-3);animation:zz 2.8s ease-in-out infinite}\n:host([mood=\"sleep\"][size=\"xs\"]) .z{display:none}\n@keyframes blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}\n@keyframes read{0%,100%{transform:translate(-24%,2%)}50%{transform:translate(24%,2%)}}\n@keyframes bob{0%,100%{translate:0 0}50%{translate:0 calc(var(--s)*-.05)}}\n@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}\n@keyframes zz{0%{opacity:0;translate:0 20%}40%{opacity:1}100%{opacity:0;translate:25% -40%}}\n@media (prefers-reduced-motion:reduce){*{animation:none!important}}","props":[{"name":"hue","default":"","description":"c1 | c2 | c3 | c5 | c6"},{"name":"shape","default":"square","description":"square | round | blob"},{"name":"mood","default":"idle","description":"idle | working | needs | done | failed | sleep"},{"name":"size","default":"md","description":"xs 20 | sm 28 | md 40 | lg 64 | xl 112"}],"version":1},{"name":"pc-effect","html":"\u003cspan class=\"e\">\u003cslot>\u003c/slot>\u003c/span>","css":":host{display:inline-flex;flex:none}\n.e{display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:var(--radius-xs);white-space:nowrap;font:600 10px/1 var(--font-data);letter-spacing:.06em;text-transform:uppercase;box-shadow:inset 0 0 0 1px var(--line-2);color:var(--ink-2)}\n:host([kind=\"send\"]) .e,:host([kind=\"pay\"]) .e,:host([kind=\"delete\"]) .e,:host([kind=\"share\"]) .e{background:var(--signal);box-shadow:none;color:var(--on-signal)}\n:host([kind=\"signin\"]) .e{box-shadow:inset 0 0 0 1px var(--data);color:var(--data)}","props":[{"name":"kind","default":"read","description":"read | draft | signin | send | pay | delete | share"}],"version":1},{"name":"pc-loader","html":"\u003cspan class=\"g\">\u003ci>\u003c/i>\u003ci>\u003c/i>\u003ci>\u003c/i>\u003ci>\u003c/i>\u003c/span>","css":":host{display:inline-flex;--c:5px}\n:host([size=\"md\"]){--c:8px}\n:host([size=\"lg\"]){--c:14px}\n.g{display:grid;grid-template-columns:repeat(2,var(--c));gap:calc(var(--c)*.34)}\ni{display:block;width:var(--c);height:var(--c);border-radius:calc(var(--c)*.18);background:var(--ink-2);animation:hop 2s step-end infinite}\ni:nth-child(2){animation-delay:.5s}\ni:nth-child(4){animation-delay:1s}\ni:nth-child(3){animation-delay:1.5s}\ni:nth-child(1){background:transparent;box-shadow:inset 0 0 0 max(1px,calc(var(--c)*.16)) var(--signal)}\n@keyframes hop{0%{background:transparent;box-shadow:inset 0 0 0 max(1px,calc(var(--c)*.16)) var(--signal)}25%,100%{background:var(--ink-2);box-shadow:none}}\n@media (prefers-reduced-motion:reduce){i{animation:none}}","props":[{"name":"size","default":"sm","description":"sm 5px | md 8px | lg 14px"}],"version":1},{"name":"pc-logo","html":"\u003cspan class=\"l\">\u003csvg viewBox=\"0 0 64 64\">\u003cpath style=\"fill:currentColor\" d=\"M14 14h15v15H14zm21 0h15v15H35zM14 35h15v15H14z\"/>\u003cpath fill=\"none\" stroke-width=\"3.5\" style=\"stroke:var(--signal)\" d=\"M36.5 36.5h12v12h-12z\"/>\u003c/svg>\u003cb>pitcrew\u003c/b>\u003c/span>","css":":host{display:inline-flex}\n.l{display:inline-flex;align-items:center;gap:6px;color:inherit;text-transform:none;letter-spacing:0}\nsvg{width:30px;height:30px;flex:none}\nb{font:800 19px/1 var(--font-display);letter-spacing:-.04em;text-transform:none}\n:host([size=\"sm\"]) svg{width:20px;height:20px}\n:host([size=\"sm\"]) b{font-size:15px}\n:host([size=\"lg\"]) .l{gap:10px}\n:host([size=\"lg\"]) svg{width:64px;height:64px}\n:host([size=\"lg\"]) b{font-size:48px}\n:host([wordmark=\"none\"]) b{display:none}","props":[{"name":"size","default":"md","description":"sm | md | lg"},{"name":"wordmark","default":"","description":"none hides the word"}],"version":2},{"name":"pc-topbar","html":"\u003cdiv class=\"b\">\u003cdiv class=\"l\">\u003cpc-logo size=\"sm\">\u003c/pc-logo>\u003cspan class=\"dim\">/ {{crumb}}\u003c/span>\u003c/div>\u003cdiv class=\"r\">\u003cspan>\u003ci>\u003c/i>host · {{computers}} computers up\u003c/span>\u003cspan>wk {{spend}}\u003c/span>\u003cspan class=\"hi\">{{clock}}\u003c/span>\u003c/div>\u003c/div>","css":":host{display:block}\n.b{display:flex;align-items:center;justify-content:space-between;height:38px;padding:0 20px;background:var(--bar);color:var(--on-bar);font:500 10.5px/1 var(--font-data);letter-spacing:.06em;text-transform:uppercase}\n.l,.r{display:flex;align-items:center;gap:20px}\n.r{gap:24px;color:var(--bar-3)}\n.dim{color:var(--bar-3)}\n.hi{color:var(--on-bar)}\ni{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--in);margin-right:7px;vertical-align:1px}","props":[{"name":"crumb","default":"Pit wall"},{"name":"computers","default":"5","description":"computers up right now"},{"name":"spend","default":"$14.82 / $40 cap","description":"weekly spend vs cap"},{"name":"clock","default":"Wed 30 Sep 19:42"}],"version":2},{"name":"pc-track","html":"\u003cdiv class=\"t\" style=\"--h:var(--{{hue}})\">\u003cb style=\"width:{{pct}}%\">\u003c/b>\u003cspan class=\"k\" style=\"left:calc({{pct}}% - 10px)\">\u003cpc-bot size=\"xs\" hue=\"{{hue}}\" shape=\"{{shape}}\" mood=\"{{state}}\">\u003c/pc-bot>\u003c/span>\u003c/div>","css":":host{display:block}\n.t{position:relative;height:30px}\n.t::before{content:\"\";position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;border-radius:9px;background:var(--surface-3)}\nb{position:absolute;left:0;top:50%;height:4px;margin-top:-2px;border-radius:9px;background:var(--h)}\n.k{position:absolute;top:5px}\n:host([state=\"failed\"]) b{background:var(--bad);opacity:.5}","props":[{"name":"pct","default":"0","description":"0-100"},{"name":"hue","default":"c1"},{"name":"shape","default":"square"},{"name":"state","default":"working","description":"working | failed"}],"version":1}])