/* DG-3 mock-up viewer. Browser only, no network, no storage. All text is inserted with textContent. */
(function () {
  'use strict';
  var f2 = MM.f2, pcOf = MM.pcOf;
  var $ = function (id) { return document.getElementById(id); };
  var stocks = JSON.parse(JSON.stringify(MM.S));
  var state = { alt: 'A', screen: 'cover', tab: 'tg', theme: 'auto' };
  var sceneCache = {}, msgState = {}, toastTimer = null, composerTarget = null;
  var ACK_NOW = '19:40';

  /* ---------- DOM helper (strings become text nodes, never HTML) ---------- */
  function h(tag, a) {
    var e = document.createElement(tag), kids = Array.prototype.slice.call(arguments, 2);
    if (a) Object.keys(a).forEach(function (k) {
      var v = a[k]; if (v == null || v === false) return;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    (function add(list) { list.forEach(function (c) { if (Array.isArray(c)) return add(c); if (c == null || c === false) return; e.append(c.nodeType ? c : document.createTextNode(String(c))); }); })(kids);
    return e;
  }
  /* Telegram HTML subset: only <b>, <i>, <code> are honoured; everything else is plain text. */
  function rich(parent, src) {
    var re = /<(\/?)(b|i|code)>/g, last = 0, cur = parent, stack = [], m;
    while ((m = re.exec(src))) {
      if (m.index > last) cur.append(document.createTextNode(src.slice(last, m.index)));
      if (!m[1]) { var e = document.createElement(m[2]); cur.append(e); stack.push(cur); cur = e; } else cur = stack.pop() || parent;
      last = re.lastIndex;
    }
    if (last < src.length) cur.append(document.createTextNode(src.slice(last)));
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 5200);
  }
  function stockBy(sym) { return stocks.filter(function (s) { return s.sym === sym; })[0]; }

  /* ---------- Telegram bubbles ---------- */
  var KIND = { first: 'FIRST ALERT', reminder: 'REMINDER', late: 'LATE ALERT', close: 'AT CLOSE', health: 'HEALTH', board: 'PINNED BOARD', info: 'INFO' };
  function getScenes() { return sceneCache[state.alt] || (sceneCache[state.alt] = MM.scenes(state.alt)); }

  function msgNode(m, chat) {
    var s = msgState[m.id] || (msgState[m.id] = JSON.parse(JSON.stringify(m.init)));
    var wrap = h('div', { class: 'mrow ' + (m.from === 'user' ? 'out' : 'in') + ' k-' + (m.kind || 'info'), id: 'msg-' + m.id });
    function draw(focusKb) {
      wrap.replaceChildren();
      var v = m.view(s), widest = MM.widest(v.text);
      var meta = h('div', { class: 'meta' });
      if (m.from !== 'user') {
        meta.append(h('span', { class: 'chip ' + (m.notify ? 'n-yes' : 'n-no'), text: m.notify ? '🔔 notifies' : (m.edit ? '🔕 silent edit, no notification' : '🔕 silent') }));
        if (m.kind && m.kind !== 'info') meta.append(h('span', { class: 'chip kind-' + m.kind, text: KIND[m.kind] || m.kind }));
        meta.append(h('span', { class: 'chip w' + (widest > 38 ? ' over' : ''), text: 'widest line ' + widest + '/38', title: 'Emoji count as 2 characters' }));
      } else meta.append(h('span', { class: 'chip', text: 'you type' }));
      wrap.append(h('div', { class: 'mtitle', text: m.title }), meta);
      if (m.variants && m.variants.length > 1) {
        var vb = h('div', { class: 'vbtns' });
        m.variants.forEach(function (vr) {
          vb.append(h('button', { type: 'button', class: 'vbtn', text: vr.label, onclick: function () {
            Object.keys(s).forEach(function (k) { delete s[k]; });
            Object.assign(s, JSON.parse(JSON.stringify(m.init)), JSON.parse(JSON.stringify(vr.s)));
            if (composerTarget && composerTarget.m === m) hideComposer();
            draw(); } }));
        });
        wrap.append(h('details', { class: 'variants' }, h('summary', { text: 'Preview other states of this message' }), vb));
      }
      var txt = h('div', { class: 'txt' }); rich(txt, v.text);
      wrap.append(h('div', { class: 'bubble', 'aria-live': 'polite' }, txt, h('div', { class: 'time', text: m.time })));
      if (v.buttons && v.buttons.length) {
        wrap.append(h('div', { class: 'kb' }, v.buttons.map(function (row) {
          return h('div', { class: 'krow' }, row.map(function (b) {
            return h('button', { type: 'button', class: 'kbtn' + (b.primary ? ' pri' : ''), text: b.t, onclick: function () { press(b); } });
          }));
        })));
      }
      (s._thread || []).forEach(function (t) { wrap.append(h('div', { class: 'thread ' + t.dir }, h('div', { class: 'bubble' }, h('div', { class: 'txt', text: t.text })))); });
      if (focusKb) { var f = wrap.querySelector('.kbtn') || wrap.querySelector('.bubble'); if (f) { if (!f.hasAttribute('tabindex') && f.tagName !== 'BUTTON') f.setAttribute('tabindex', '-1'); f.focus({ preventScroll: true }); } }
    }
    function press(b) {
      var r = m.act(s, b.cb) || {};
      if (r.toast) toast(r.toast);
      if (r.goto === 'dash') { setTab('dash'); toast('Opened the dashboard (the "Dashboard" button opens the web app).'); return; }
      if (r.goto === 'board') { var t = document.getElementById('msg-c-board'); if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); setTimeout(function () { t.classList.remove('flash'); }, 1600); } return; }
      if (r.composer) showComposer(m, s, draw, r.composer);
      else if (composerTarget && composerTarget.m === m && !(s.step === 'typing' || s.typing)) hideComposer();
      draw(true);
    }
    m._submit = function (val) {
      (s._thread = s._thread || []).push({ dir: 'out', text: val });
      var r = m.act(s, 'typed', val) || {};
      if (r.note) s._thread.push({ dir: 'in', text: r.note });
      if (r.composerOff) hideComposer();
      draw();
    };
    draw();
    return wrap;
  }
  function showComposer(m, s, draw, ph) {
    var c = $('composerForm'); if (!c) return;
    composerTarget = { m: m }; c.hidden = false; $('composerIn').placeholder = ph; $('composerIn').value = ''; $('composerIn').focus();
  }
  function hideComposer() { var c = $('composerForm'); if (c) c.hidden = true; composerTarget = null; }

  function renderTelegram() {
    var dev = h('div', { class: 'device tg', 'data-screen': state.screen });
    dev.append(h('div', { class: 'tg-head' }, h('div', { class: 'avatar', 'aria-hidden': 'true', text: 'MM' }), h('div', {}, h('strong', { text: 'Market Monitor (test bot)' }), h('div', { class: 'sub', text: 'bot · ' + MM.DATE_LONG + ' · SAMPLE DATA' }))));
    var chat = h('div', { class: 'chat' });
    getScenes().forEach(function (sc) {
      var lab = sc.letter === 'a2' ? '+' : sc.letter + ')';
      chat.append(h('section', { class: 'scene', 'aria-label': sc.title },
        h('h2', { class: 'scene-h' }, h('span', { class: 'letter', text: lab }), ' ' + sc.title),
        h('p', { class: 'scene-note', text: sc.note }),
        sc.items.map(function (m) { return msgNode(m); })));
    });
    dev.append(chat);
    var form = h('form', { id: 'composerForm', class: 'composer', hidden: true, onsubmit: function (e) {
      e.preventDefault(); var v = $('composerIn').value; if (!v.trim() || !composerTarget) return; composerTarget.m._submit(v); $('composerIn').value = ''; } },
      h('label', { for: 'composerIn', class: 'sr', text: 'Message to the bot' }), h('input', { id: 'composerIn', autocomplete: 'off', inputmode: 'decimal' }), h('button', { type: 'submit', text: 'Send' }));
    dev.append(form);
    return dev;
  }

  /* ---------- dashboard shared bits ---------- */
  function ageText(a) { return a < 60 ? a + ' s' : Math.floor(a / 60) + ' min ' + (a % 60 ? (a % 60) + ' s' : ''); }
  function fresh(s) { return s.age > 300 ? 'red' : (s.age > 60 ? 'amber' : 'fresh'); }
  var ST = { OK: ['✓', 'OK'], NEAR: ['◔', 'NEAR'], CROSSED: ['⚠', 'CROSSED – UNACKNOWLEDGED'], ACK: ['✔', 'ACKNOWLEDGED'] };
  function chipStatus(s) { var t = ST[s.st]; return h('span', { class: 'chip st st-' + s.st, text: t[0] + ' ' + t[1] + (s.st === 'ACK' ? ' ' + s.ackAt + ' Muscat' : '') }); }
  function chipAge(s) {
    var f = fresh(s);
    var txt = f === 'fresh' ? '● LIVE ' + ageText(s.age) + ' old' : (f === 'amber' ? '⏱ STALE ' + ageText(s.age).trim() + ' old (over 60 s)' : '⛔ STALE ' + ageText(s.age).trim() + ' old (over 5 min)');
    return h('span', { class: 'chip age age-' + f, text: txt });
  }
  function lastTime(s) { return s.lastEt + ' ET · ' + MM.mus(s.lastEt) + ' Muscat'; }
  function chg(s) { return (s.last >= s.pc ? '+' : '-') + Math.abs(s.last - s.pc).toFixed(2) + ' (' + pcOf(s.last, s.pc) + ')'; }
  function thrBtn(s, which) {
    var v = s[which], lab = which.toUpperCase();
    return h('button', { type: 'button', class: 'edit', onclick: function (e) { openEdit(s.sym, which, e.currentTarget); }, 'aria-label': 'Edit ' + lab + ' threshold for ' + s.sym + ', now ' + f2(v) + ', ' + pcOf(v, s.pc, 1) + ' from Previous Close' },
      h('span', { class: 'ev', text: f2(v) }), h('span', { class: 'ep', text: pcOf(v, s.pc, 1) }), h('span', { class: 'pen', 'aria-hidden': 'true', text: '✎' }));
  }
  function cell(label, val, sub, extra) { return h('div', { class: 'cell ' + (extra || '') }, h('dt', { text: label }), h('dd', {}, val, sub ? h('small', { text: sub }) : null)); }
  function nums(s) {   /* the five required numbers: Last, Previous Close, Opening (IEX), LOW, HIGH */
    return h('dl', { class: 'nums' },
      cell('Prev Close', f2(s.pc)), cell('Opening (IEX)', f2(s.open)), cell('LOW', thrBtn(s, 'low')), cell('HIGH', thrBtn(s, 'high')));
  }
  function lastBlock(s) {
    return h('div', { class: 'lastb' }, h('div', { class: 'lastv' }, h('span', { class: 'big', text: f2(s.last) }), h('span', { class: 'chg ' + (s.last >= s.pc ? 'up' : 'down'), text: (s.last >= s.pc ? '▲ ' : '▼ ') + chg(s) })),
      h('div', { class: 'lastt', text: 'Last recorded ' + lastTime(s) }));
  }
  function ackBtn(s, label) {
    return h('button', { type: 'button', class: 'btn pri', text: label || ('Acknowledge ' + s.sym), onclick: function () { ack(s); } });
  }
  function ack(s) {
    s.st = 'ACK'; s.ackAt = ACK_NOW; renderStage();
    toast('Acknowledged ' + s.sym + '. Telegram bubble becomes "Acknowledged ' + ACK_NOW + ' Muscat" with buttons removed (mock).');
  }
  function unackCount() { return stocks.filter(function (s) { return s.st === 'CROSSED'; }).length; }
  function head() {
    var n = unackCount();
    return h('div', { class: 'dhead' },
      h('div', { class: 'dline' }, h('strong', { class: 'mk', text: 'Market OPEN' }), h('span', { text: 'closes 16:00 ET / 01:00 Muscat' })),
      h('div', { class: 'dline' }, h('span', { class: 'chip age age-fresh', text: '● Data LIVE' }), h('span', { text: 'server last poll 12 s ago' }), h('span', { class: 'chip ' + (n ? 'st st-CROSSED' : 'st st-OK'), text: (n ? '⚠ ' : '✓ ') + n + ' unacknowledged' })),
      h('div', { class: 'dline sm', text: 'Next reminder ' + MM.both('10:42') + ' · now ' + MM.both('10:40') }),
      h('div', { class: 'dtabs', role: 'tablist', 'aria-label': 'Dashboard sections (only Watchlist is drawn)' },
        ['WATCHLIST', 'ALERTS', 'BRIEFING', 'SETTINGS', 'LOG'].map(function (t, i) {
          return h('button', { type: 'button', role: 'tab', 'aria-selected': i === 0 ? 'true' : 'false', class: 'dtab', text: t, onclick: i === 0 ? null : function () { toast('Mock-up: the ' + t + ' tab is not drawn. Only the Watchlist is part of this decision.'); } });
        })));
  }
  var ORDER = { CROSSED: 0, NEAR: 3, OK: 4, ACK: 5 };
  function rank(s) { return s.st === 'CROSSED' ? 0 : (fresh(s) === 'red' ? 1 : (fresh(s) === 'amber' ? 2 : ORDER[s.st])); }
  function sorted() { return stocks.slice().sort(function (a, b) { return rank(a) - rank(b) || a.sym.localeCompare(b.sym); }); }
  function legend() {
    return h('div', { class: 'legend' }, h('strong', { text: 'Status words and symbols' }),
      h('ul', {}, [['✓ OK', 'inside the band'], ['◔ NEAR', 'within 20% of the way to a threshold (dashed outline)'], ['⚠ CROSSED – UNACKNOWLEDGED', 'needs you (thick solid outline)'], ['✔ ACKNOWLEDGED', 'quiet until re-armed (left bar)'], ['⏱ STALE amber', 'last trade older than 60 s'], ['⛔ STALE red', 'last trade older than 5 min']].map(function (p) { return h('li', {}, h('b', { text: p[0] }), ' ' + p[1]); })),
      h('p', { text: 'Volume is always IEX volume. Opening is the IEX open. All data on this page is SAMPLE data.' }));
  }

  /* ---------- Alternative A dashboard: sorted glance list / table ---------- */
  function dashA() {
    var box = h('div', { class: 'dbody a-dash' });
    if (state.screen === 'cover') {
      box.append(h('div', { class: 'a-list' }, sorted().map(function (s) {
        return h('article', { class: 'card st-' + s.st + ' age-' + fresh(s), 'aria-label': s.sym },
          h('div', { class: 'ctop' }, h('h3', { text: s.sym }), chipStatus(s)),
          lastBlock(s), h('div', {}, chipAge(s)), nums(s),
          s.st === 'CROSSED' ? h('div', { class: 'cact' }, ackBtn(s), h('button', { type: 'button', class: 'btn', text: 'Ack + move…', onclick: function (e) { openEdit(s.sym, 'high', e.currentTarget, true); } })) : null);
      })));
    } else {
      var tb = h('table', { class: 'tbl' }, h('caption', { class: 'sr', text: 'Watchlist, sorted by what needs action' }),
        h('thead', {}, h('tr', {}, ['Symbol', 'Last recorded', 'Prev Close', 'Opening (IEX)', 'LOW', 'HIGH', 'Status', 'IEX volume', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', {}, sorted().map(function (s) {
          return h('tr', { class: 'st-' + s.st + ' age-' + fresh(s) },
            h('th', { scope: 'row', text: s.sym }),
            h('td', {}, h('b', { class: 'big2', text: f2(s.last) }), h('div', { class: 'sm', text: chg(s) }), h('div', { class: 'sm', text: lastTime(s) }), chipAge(s)),
            h('td', { text: f2(s.pc) }), h('td', { text: f2(s.open) }), h('td', {}, thrBtn(s, 'low')), h('td', {}, thrBtn(s, 'high')),
            h('td', {}, chipStatus(s)), h('td', { text: s.vol.toFixed(2) + 'M · ' + s.x.toFixed(1) + 'x of avg' }),
            h('td', {}, s.st === 'CROSSED' ? ackBtn(s, 'Acknowledge') : null));
        })));
      box.append(h('div', { class: 'tblwrap' }, tb));
    }
    return box;
  }

  /* ---------- Alternative B dashboard: decision cards with range gauge ---------- */
  function gauge(s) {
    var lo = s.low, hi = s.high, pos = function (v) { return Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); };
    var beyond = s.last <= lo || s.last >= hi;
    return h('div', { class: 'gauge', role: 'img', 'aria-label': 'Range from LOW ' + f2(lo) + ' to HIGH ' + f2(hi) + '. Previous Close ' + f2(s.pc) + ', Opening ' + f2(s.open) + ', Last ' + f2(s.last) + (beyond ? ', outside the band' : '') },
      h('div', { class: 'track' }),
      h('span', { class: 'mk p', style: 'left:' + pos(s.pc) + '%', text: 'P' }), h('span', { class: 'mk o', style: 'left:' + pos(s.open) + '%', text: 'O' }),
      h('span', { class: 'mk l' + (beyond ? ' beyond' : ''), style: 'left:' + pos(s.last) + '%', text: beyond ? (s.last >= hi ? '▶' : '◀') : '▲' }),
      h('div', { class: 'gl' }, h('span', { text: 'LOW ' + f2(lo) }), h('span', { text: 'HIGH ' + f2(hi) })));
  }
  function dashB() {
    var box = h('div', { class: 'dbody b-dash' });
    box.append(h('div', { class: 'b-grid' }, sorted().map(function (s) {
      return h('article', { class: 'card bcard st-' + s.st + ' age-' + fresh(s), 'aria-label': s.sym },
        h('div', { class: 'ctop' }, h('h3', { text: s.sym }), chipStatus(s)), h('div', {}, chipAge(s)),
        h('section', { class: 'blk' }, h('h4', { text: 'PRICE' }), lastBlock(s),
          h('dl', { class: 'nums' }, cell('Prev Close', f2(s.pc)), cell('Opening (IEX)', f2(s.open)))),
        h('section', { class: 'blk' }, h('h4', { text: 'LEVELS' }), gauge(s),
          h('dl', { class: 'nums' }, cell('LOW', thrBtn(s, 'low')), cell('HIGH', thrBtn(s, 'high'))),
          h('p', { class: 'sm', text: 'P = Prev Close · O = Opening (IEX) · ▲ = Last (◀ ▶ = beyond LOW or HIGH)' })),
        h('section', { class: 'blk' }, h('h4', { text: 'VOLUME (IEX)' }), h('p', { class: 'vol', text: 'IEX volume ' + s.vol.toFixed(2) + 'M · ' + s.x.toFixed(1) + 'x of the average at this time · alert at 2.0x' })),
        s.st === 'CROSSED' ? h('div', { class: 'cact' }, ackBtn(s), h('button', { type: 'button', class: 'btn', text: 'Ack + move…', onclick: function (e) { openEdit(s.sym, 'high', e.currentTarget, true); } })) : null);
    })));
    return box;
  }

  /* ---------- Alternative C dashboard: action queue + board ---------- */
  function dashC() {
    var box = h('div', { class: 'dbody c-dash ' + state.screen });
    var need = stocks.filter(function (s) { return s.st === 'CROSSED'; });
    var bad = stocks.filter(function (s) { return fresh(s) !== 'fresh'; });
    var left = h('div', { class: 'cleft' });
    left.append(h('section', { class: 'panel need', 'aria-label': 'Action needed' }, h('h3', { text: 'ACTION NEEDED (' + need.length + ')' }),
      need.length ? need.map(function (s) {
        return h('div', { class: 'nrow' }, h('div', {}, h('b', { text: '🚨 ' + s.sym + ' HIGH ' + f2(s.high) + ' crossed' }), h('div', { class: 'sm', text: 'Last ' + f2(s.last) + ' · since ' + MM.both(s.since) + ' · reminder ' + s.rem + ' sent' })),
          h('div', { class: 'cact' }, ackBtn(s, 'Acknowledge'), h('button', { type: 'button', class: 'btn', text: 'Ack + move…', onclick: function (e) { openEdit(s.sym, 'high', e.currentTarget, true); } })));
      }) : h('p', { class: 'ok', text: '✓ Nothing needs action. Quiet is good.' })));
    if (bad.length) left.append(h('section', { class: 'panel prob', 'aria-label': 'Data problems' }, h('h3', { text: 'DATA PROBLEMS (' + bad.length + ')' }), bad.map(function (s) { return h('div', { class: 'nrow' }, h('b', { text: s.sym }), ' ', chipAge(s)); })));
    left.append(h('section', { class: 'board', 'aria-label': 'Watchlist board' }, h('h3', { text: 'BOARD (' + stocks.length + ' stocks)' }),
      sorted().map(function (s) {
        return h('div', { class: 'brow st-' + s.st + ' age-' + fresh(s) },
          h('div', { class: 'b1' }, h('b', { class: 'sym', text: s.sym }), h('span', { class: 'bl', text: f2(s.last) }), h('span', { class: 'chg ' + (s.last >= s.pc ? 'up' : 'down'), text: pcOf(s.last, s.pc) }), chipStatus(s), chipAge(s)),
          h('div', { class: 'b2' }, h('span', { text: 'PC ' + f2(s.pc) }), h('span', { text: 'Opening (IEX) ' + f2(s.open) }), h('span', { class: 'lw' }, 'LOW ', thrBtn(s, 'low')), h('span', { class: 'hg' }, 'HIGH ', thrBtn(s, 'high')), h('span', { class: 'sm', text: 'Last ' + lastTime(s) })));
      })));
    box.append(left);
    if (state.screen === 'inner') {
      var side = h('aside', { class: 'cright', 'aria-label': 'Pinned Telegram board preview' }, h('h3', { text: 'Same board in Telegram (pinned)' }));
      var m = getScenes()[1].items[0];
      side.append(msgNode(m));
      box.append(side);
    }
    return box;
  }

  function renderDashboard() {
    var dev = h('div', { class: 'device dash alt-' + state.alt, 'data-screen': state.screen });
    dev.append(head());
    dev.append(state.alt === 'A' ? dashA() : (state.alt === 'B' ? dashB() : dashC()));
    dev.append(legend());
    return dev;
  }

  /* ---------- Edit threshold (h) ---------- */
  var ed = { sym: null, which: null, ackToo: false, opener: null, confirmed: false };
  function parseEntry(s, mode, raw) {
    var v = parseFloat(String(raw).replace(',', '.'));
    if (!isFinite(v) || String(raw).trim() === '') return { err: 'Enter a number.' };
    var price = mode === 'usd' ? v : s.pc * (1 + v / 100);
    if (price <= 0) return { err: 'The threshold must be above zero.' };
    price = Math.round(price * 100) / 100;
    if (ed.which === 'low' && price >= s.high) return { err: 'LOW must be below HIGH (HIGH is ' + f2(s.high) + ').' };
    if (ed.which === 'high' && price <= s.low) return { err: 'HIGH must be above LOW (LOW is ' + f2(s.low) + ').' };
    return { price: price };
  }
  function crossed(s, price) { return ed.which === 'high' ? s.last >= price : s.last <= price; }
  function openEdit(sym, which, opener, ackToo) {
    var s = stockBy(sym), d = $('editDlg');
    ed = { sym: sym, which: which, ackToo: !!ackToo, opener: opener, confirmed: false };
    $('edTitle').textContent = (ackToo ? 'Acknowledge and move ' : 'Edit ') + which.toUpperCase() + ' for ' + sym;
    $('edCtx').textContent = 'Prev Close ' + f2(s.pc) + ' · Last ' + f2(s.last) + ' · now ' + which.toUpperCase() + ' ' + f2(s[which]) + ' (' + pcOf(s[which], s.pc, 1) + ')';
    document.querySelector('input[name="edmode"][value="usd"]').checked = true;
    $('edVal').value = ackToo ? f2(s.high * 1.01) : f2(s[which]);
    $('edConfirm').hidden = true; $('edSave').hidden = false;
    d.className = 'alt-' + state.alt; refreshPreview();
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    $('edVal').focus(); $('edVal').select();
  }
  function refreshPreview() {
    var s = stockBy(ed.sym); if (!s) return;
    var mode = document.querySelector('input[name="edmode"]:checked').value;
    $('edLbl').textContent = mode === 'usd' ? 'New ' + ed.which.toUpperCase() + ' price in dollars ($)' : 'New ' + ed.which.toUpperCase() + ' as percent from Previous Close (%, use - for below)';
    var r = parseEntry(s, mode, $('edVal').value);
    $('edConfirm').hidden = true; $('edSave').hidden = false; ed.confirmed = false;
    if (r.err) { $('edPrev').textContent = ''; $('edErr').textContent = r.err; $('edSave').disabled = true; return; }
    $('edErr').textContent = ''; $('edSave').disabled = false;
    $('edPrev').textContent = 'Preview: ' + ed.which.toUpperCase() + ' = $' + f2(r.price) + ' · ' + pcOf(r.price, s.pc, 2) + ' from Prev Close ' + f2(s.pc) + ' · ' + pcOf(r.price, s.last, 2) + ' from Last ' + f2(s.last) + (crossed(s, r.price) ? ' · ALREADY CROSSED' : '');
  }
  function closeEdit() { var d = $('editDlg'); if (d.close) d.close(); else d.removeAttribute('open'); }
  function saveEdit() {
    var s = stockBy(ed.sym), mode = document.querySelector('input[name="edmode"]:checked').value, r = parseEntry(s, mode, $('edVal').value);
    if (r.err) return;
    if (crossed(s, r.price) && !ed.confirmed) { ed.confirmed = true; $('edConfirm').hidden = false; $('edSave').hidden = true; $('edYes').focus(); return; }
    var was = s[ed.which]; s[ed.which] = r.price; var msg;
    if (crossed(s, r.price)) { s.st = 'CROSSED'; s.since = MM.NOW_ET; s.rem = 0; msg = 'Saved ' + ed.sym + ' ' + ed.which.toUpperCase() + ' ' + f2(r.price) + ' (was ' + f2(was) + '). Alert sent now (mock).'; }
    else {
      var near = Math.abs(s.last - s.high) <= 0.2 * Math.abs(s.pc - s.high) || Math.abs(s.last - s.low) <= 0.2 * Math.abs(s.pc - s.low);
      s.st = near ? 'NEAR' : 'OK'; msg = 'Saved ' + ed.sym + ' ' + ed.which.toUpperCase() + ' ' + f2(r.price) + ' (was ' + f2(was) + '). Re-armed now' + (ed.ackToo ? ' and acknowledged.' : '.');
    }
    closeEdit(); renderStage(); toast(msg);
  }

  /* ---------- Trade-offs (j) ---------- */
  function list(items) { return h('ul', {}, items.map(function (t) { return h('li', { text: t }); })); }
  function renderTrade() {
    var A = MM.ALTS[state.alt], box = h('div', { class: 'trade' });
    box.append(h('h2', { text: state.alt + ' · ' + A.name + ': trade-offs' }),
      h('div', { class: 'two' }, h('section', { class: 'panel' }, h('h3', { text: 'Strengths' }), list(A.strengths)), h('section', { class: 'panel' }, h('h3', { text: 'Weaknesses' }), list(A.weaknesses))),
      h('section', { class: 'panel' }, h('h3', { text: 'Numbers' }), h('dl', { class: 'kv' },
        h('dt', { text: 'Quiet day (1 alert, acknowledged after 1 reminder)' }), h('dd', { text: A.quiet }),
        h('dt', { text: 'Busy day (8 alerts, 3 reminders each, 1 error)' }), h('dd', { text: A.busy }),
        h('dt', { text: 'Implementation effort' }), h('dd', { text: A.effort }),
        h('dt', { text: 'Risk' }), h('dd', { text: A.risk }))),
      h('section', { class: 'panel' }, h('h3', { text: 'Against the PRD 9.5 criteria' }),
        h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Criterion' }), h('th', { scope: 'col', text: 'This alternative' }))),
          h('tbody', {}, A.score.map(function (r) { return h('tr', {}, h('th', { scope: 'row', text: r[0] }), h('td', { text: r[1] })); })))));
    var cmp = h('table', { class: 'tbl' }, h('caption', { text: 'Side by side' }),
      h('thead', {}, h('tr', {}, ['', 'A Glance Line', 'B Decision Card', 'C Live Board'].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
      h('tbody', {}, [['Quiet day', 'quiet'], ['Busy day', 'busy'], ['Effort', 'effort'], ['Risk', 'risk']].map(function (p) {
        return h('tr', {}, h('th', { scope: 'row', text: p[0] }), ['A', 'B', 'C'].map(function (k) { return h('td', { text: MM.ALTS[k][p[1]] }); }));
      })));
    box.append(h('section', { class: 'panel' }, h('div', { class: 'tblwrap' }, cmp)),
      h('p', { class: 'sm', text: 'Message counts are estimates from the PRD rules (reminder every 10 minutes, tidy-up on). Telegram edits never notify.' }));
    return box;
  }

  /* ---------- shell ---------- */
  function fit() {
    var dev = document.querySelector('.device'), wrap = $('frameWrap'); if (!dev) { $('fitnote').textContent = ''; return; }
    dev.style.zoom = ''; var w = state.screen === 'cover' ? 360 : 780, avail = wrap.clientWidth, sc = Math.min(1, avail / w);
    if (sc < 1) { dev.style.zoom = sc; $('fitnote').textContent = 'Shown at ' + Math.round(sc * 100) + '% to fit this window (the layout inside is the real ' + w + ' px one).'; } else $('fitnote').textContent = '';
  }
  function renderStage() {
    var st = $('stage'), y = window.scrollY, fw = $('frameWrap'), dev;
    hideComposerIfGone();
    fw.replaceChildren();
    $('frameBar').hidden = state.tab === 'trade';
    if (state.tab === 'trade') { fw.append(renderTrade()); $('fitnote').textContent = ''; }
    else { dev = state.tab === 'tg' ? renderTelegram() : renderDashboard(); var holder = h('div', { class: 'holder ' + state.screen }, dev); fw.append(holder); fit(); }
    window.scrollTo(0, y);
  }
  function hideComposerIfGone() { composerTarget = null; }
  function setTab(t) { state.tab = t; render(); window.scrollTo(0, 0); }
  function render() {
    document.querySelectorAll('#altbar button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.alt === state.alt)); b.tabIndex = b.dataset.alt === state.alt ? 0 : -1; });
    document.querySelectorAll('#screenbar button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.screen === state.screen)); });
    document.querySelectorAll('#subtabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)); b.tabIndex = b.dataset.tab === state.tab ? 0 : -1; });
    var A = MM.ALTS[state.alt];
    $('intro').replaceChildren(h('h2', { text: state.alt + ' · ' + A.name }), h('p', { class: 'tag', text: A.tag }), h('p', { text: A.idea }),
      h('details', {}, h('summary', { text: 'What I sharpened compared with PRD 9.4' }), h('p', { text: A.sharpened })));
    try { history.replaceState(null, '', '#' + state.alt + '-' + state.screen + '-' + state.tab); } catch (e) { /* file:// may refuse */ }
    renderStage();
  }
  function theme() {
    var order = ['auto', 'light', 'dark'], i = (order.indexOf(state.theme) + 1) % 3; state.theme = order[i];
    if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', state.theme);
    $('themebtn').textContent = 'Theme: ' + state.theme;
  }
  function arrows(container, sel, cb) {
    container.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var bs = Array.prototype.slice.call(container.querySelectorAll(sel)), i = bs.indexOf(document.activeElement); if (i < 0) return;
      var n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; n.focus(); cb(n); e.preventDefault();
    });
  }
  function init() {
    var m = /^#([ABC])-(cover|inner)-(tg|dash|trade)$/.exec(location.hash || ''); if (m) { state.alt = m[1]; state.screen = m[2]; state.tab = m[3]; }
    document.querySelectorAll('#altbar button').forEach(function (b) { b.addEventListener('click', function () { state.alt = b.dataset.alt; hideComposerIfGone(); render(); }); });
    arrows($('altbar'), 'button', function (b) { state.alt = b.dataset.alt; render(); $('altbar').querySelector('[aria-selected="true"]').focus(); });
    document.querySelectorAll('#screenbar button').forEach(function (b) { b.addEventListener('click', function () { state.screen = b.dataset.screen; render(); }); });
    document.querySelectorAll('#subtabs button').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; render(); }); });
    arrows($('subtabs'), 'button', function (b) { state.tab = b.dataset.tab; render(); $('subtabs').querySelector('[aria-selected="true"]').focus(); });
    $('themebtn').addEventListener('click', theme);
    $('edVal').addEventListener('input', refreshPreview);
    document.querySelectorAll('input[name="edmode"]').forEach(function (r) { r.addEventListener('change', refreshPreview); });
    $('edSave').addEventListener('click', saveEdit); $('edYes').addEventListener('click', saveEdit);
    $('edBack').addEventListener('click', function () { refreshPreview(); $('edVal').focus(); });
    $('edCancel').addEventListener('click', closeEdit);
    $('editDlg').addEventListener('close', function () { if (ed.opener && document.body.contains(ed.opener)) ed.opener.focus(); });
    $('edForm').addEventListener('submit', function (e) { e.preventDefault(); saveEdit(); });
    var raf = 0; window.addEventListener('resize', function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); });
    render();
  }
  init();
})();
