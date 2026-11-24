/* DG-3 mock-up data and Telegram message templates.
   Shared by ux/index.html (browser, via build.mjs) and ux/build.mjs (Node, for alternatives.md).
   ALL NUMBERS ARE SAMPLE DATA. Nothing here is a real price, threshold or watchlist. */
var MM = (function () {
  'use strict';

  /* ---------- small helpers ---------- */
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  function mus(et) { var p = et.split(':').map(Number); return pad((p[0] + 9) % 24) + ':' + pad(p[1]) + (p.length > 2 ? ':' + pad(p[2]) : ''); }
  function both(et) { return et + ' ET / ' + mus(et) + ' Muscat'; }
  var f2 = function (n) { return n.toFixed(2); };
  var sg = function (n) { return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(2); };
  var sp = function (n, d) { return (n >= 0 ? '+' : '-') + Math.abs(n).toFixed(d == null ? 2 : d) + '%'; };
  var pcOf = function (x, base, d) { return sp((x - base) / base * 100, d); };
  var fM = function (m) { return (m >= 10 ? m.toFixed(1) : m.toFixed(2)) + 'M'; };
  function plain(h) { return h.replace(/<\/?(b|i|code)>/g, ''); }
  /* Visual width: emoji and a few symbols count 2 cells, so the 38-character limit is checked conservatively. */
  var WIDE = '✅⏱⏰⛔❌⌨';
  function width(line) {
    var cps = Array.from(plain(line)), w = 0;
    for (var i = 0; i < cps.length; i++) {
      var ch = cps[i], c = ch.codePointAt(0);
      if (c === 0xFE0F || c === 0x200D) continue;
      if (c >= 0x1F000 || WIDE.indexOf(ch) >= 0 || cps[i + 1] === '️') w += 2; else w += 1;
    }
    return w;
  }
  function widest(text) { return text.split('\n').reduce(function (m, l) { return Math.max(m, width(l)); }, 0); }

  /* ---------- sample market data (Mon 30 Nov 2026, snapshot 10:40 ET = 19:40 Muscat) ---------- */
  var DATE = 'Mon 30 Nov';
  var DATE_LONG = 'Mon 30 Nov 2026';
  var NOW_ET = '10:40';
  var S = [
    { sym: 'AAPL', pc: 236.40, open: 237.15, yH: 238.10, yL: 234.90, yV: 1.9, avg: 2.1, low: 230.00, high: 245.00, last: 238.05, age: 6, lastEt: '10:39:54', st: 'OK', vol: 0.41, x: 0.9 },
    { sym: 'MSFT', pc: 421.80, open: 418.60, yH: 424.30, yL: 419.10, yV: 1.3, avg: 1.4, low: 420.00, high: 435.00, last: 417.95, age: 11, lastEt: '10:39:49', st: 'ACK', ackAt: '18:44', vol: 0.55, x: 1.6 },
    { sym: 'NVDA', pc: 138.20, open: 141.05, yH: 139.40, yL: 136.80, yV: 6.1, avg: 6.8, low: 130.00, high: 145.00, last: 145.60, age: 6, lastEt: '10:39:54', st: 'CROSSED', since: '10:22', rem: 1, vol: 1.90, x: 1.3 },
    { sym: 'AMZN', pc: 207.50, open: 206.90, yH: 209.00, yL: 205.20, yV: 1.7, avg: 1.8, low: 200.00, high: 215.00, last: 201.30, age: 3, lastEt: '10:39:57', st: 'NEAR', vol: 0.52, x: 1.2 },
    { sym: 'JPM', pc: 241.10, open: 240.20, yH: 243.00, yL: 239.20, yV: 0.8, avg: 0.9, low: 235.00, high: 250.00, last: 241.75, age: 9, lastEt: '10:39:51', st: 'OK', vol: 0.55, x: 1.8 },
    { sym: 'XOM', pc: 111.30, open: 111.55, yH: 112.40, yL: 110.40, yV: 1.0, avg: 1.1, low: 108.00, high: 115.00, last: 112.20, age: 74, lastEt: '10:38:46', st: 'OK', vol: 0.21, x: 0.8 },
    { sym: 'GOOGL', pc: 178.60, open: 179.10, yH: 180.20, yL: 177.00, yV: 1.5, avg: 1.6, low: 172.00, high: 185.00, last: 179.40, age: 372, lastEt: '10:33:48', st: 'OK', vol: 0.33, x: 1.0 },
    { sym: 'TSLA', pc: 352.40, open: 355.90, yH: 356.80, yL: 349.10, yV: 3.2, avg: 3.4, low: 335.00, high: 370.00, last: 357.20, age: 5, lastEt: '10:39:55', st: 'OK', vol: 0.77, x: 1.1 }
  ];
  var BRIEF = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'JPM', 'XOM'];
  var FRAC = { '10:00': 0.17, '11:00': 0.30, '13:00': 0.55 };
  function st(sym) { return S.filter(function (s) { return s.sym === sym; })[0]; }
  function gap(s) { return (s.open - s.pc) / s.pc * 100; }
  function briefOrder() {
    return BRIEF.map(st).sort(function (a, b) { return Math.abs(gap(b)) - Math.abs(gap(a)); });
  }
  function x2(s, k) { return fM(2 * s.avg * FRAC[k]); }
  function gapCross(s) { return s.open <= s.low ? 'LOW' : (s.open >= s.high ? 'HIGH' : null); }
  var dOpen = function (thr, s) { return pcOf(thr, s.open, 1); };

  /* ---------- sample alert events ---------- */
  var EV = {
    nvdaHigh: { sym: 'NVDA', rule: 'HIGH', thr: 145.00, price: 145.60, et: '10:22', vol: '1.62M', x: '1.3x', icon: '📈', n: 1, ackAt: '19:23' },
    nvdaRem3: { sym: 'NVDA', rule: 'HIGH', thr: 145.00, price: 144.80, et: '10:52', vol: '2.40M', x: '1.3x', icon: '📈', n: 3, t0: '10:22', ackAt: '19:52' },
    amznLow: { sym: 'AMZN', rule: 'LOW', thr: 200.00, price: 199.85, et: '13:15', vol: '1.10M', x: '1.2x', icon: '📉', n: 1, ackAt: '22:16' },
    jpmVol: { sym: 'JPM', rule: 'VOLUME', thr: 2.0, price: 241.75, et: '10:42', vol: '0.62M', avgNow: '0.31M', x: '2.0x', icon: '📊', n: 1, ackAt: '19:43' },
    xomLate: { sym: 'XOM', rule: 'HIGH', thr: 115.00, barHigh: 115.20, touchEt: '14:07', et: '14:11', now: 114.60, vol: '0.88M', x: '1.0x', icon: '📈', n: 1, ackAt: '23:12' }
  };

  /* ---------- message plumbing ---------- */
  function button(t, cb, extra) { var b = { t: t, cb: cb }; if (extra) for (var k in extra) b[k] = extra[k]; return b; }
  var DASH = button('📊 Dashboard', 'dash', { url: 'https://example.com/dashboard' });
  var BOARD = button('📋 Board', 'board');
  var ACK = button('✅ Acknowledge', 'ack', { primary: true });
  var AMOVE = button('↗ Ack + move', 'ackmove');
  var MUTE = button('🔕 Mute 1h', 'mute');
  var DETAILS = button('ℹ️ Details', 'details');

  function ackLines(o, s) {
    var a = o.ackAt, etAck = pad((Number(a.split(':')[0]) + 15) % 24) + ':' + a.split(':')[1];
    var l = ['✅ <b>' + o.sym + ' ' + o.rule + '</b> acknowledged', 'Acknowledged ' + a + ' Muscat (' + etAck + ' ET)'];
    if (s.moved) { l.push(o.rule + ' moved ' + f2(o.thr) + ' → ' + f2(s.moved.to) + ' (' + s.moved.lab + ')'); l.push('Re-armed. Quiet until crossed again.'); }
    else l.push('No more reminders for this alert.');
    return l;
  }
  function moveTo(o, p) { return Math.round(o.thr * (1 + o.dir * p / 100) * 100) / 100; }

  /* Alert message with the full acknowledge / Details / move-threshold flow. */
  function flowMsg(o) {
    o.dir = o.rule === 'LOW' ? -1 : 1;
    var below = o.dir > 0 ? 'above' : 'below';
    var m = {
      id: o.id, title: o.title, kind: o.kind, notify: true, time: o.time, ackable: true,
      init: { step: 'main', expanded: false, muted: false, moved: null },
      variants: o.variants,
      view: function (s) {
        var l;
        if (s.step === 'acked') return { text: ackLines(o, s).join('\n'), buttons: [] };
        if (s.step === 'move') {
          l = ['↗ <b>Acknowledge and move ' + o.rule + '</b>', o.sym + ' ' + o.rule + ' is ' + f2(o.thr) + ' · last ' + f2(o.price), 'Move it further out by:'];
          return { text: l.join('\n'), buttons: [[button('+1% → ' + f2(moveTo(o, 1)), 'm1'), button('+2% → ' + f2(moveTo(o, 2)), 'm2')], [button('⌨ Type a value', 'type')], [button('← Cancel', 'cancel')]] };
        }
        if (s.step === 'typing') {
          l = ['⌨ Reply with the new ' + o.sym + ' ' + o.rule + ':', 'a price (148.00) or a percent (+3%)', 'Must be ' + below + ' last ' + f2(o.price) + '.'];
          return { text: l.join('\n'), buttons: [[button('← Cancel', 'cancel')]] };
        }
        l = (s.expanded && o.details) ? o.details(s) : o.main(s);
        if (s.muted) l = l.concat(['🔕 Muted 1 h · still unacknowledged']);
        return { text: l.join('\n'), buttons: o.buttons(s) };
      },
      act: function (s, cb, arg) {
        if (cb === 'ack') { s.step = 'acked'; s.moved = null; return {}; }
        if (cb === 'details') { s.expanded = !s.expanded; return {}; }
        if (cb === 'mute') { s.muted = true; return { toast: 'Mock: ' + o.sym + ' muted for 1 hour. The alert stays unacknowledged.' }; }
        if (cb === 'ackmove') { s.step = 'move'; return {}; }
        if (cb === 'cancel') { s.step = 'main'; return {}; }
        if (cb === 'm1' || cb === 'm2') { var p = cb === 'm1' ? 1 : 2; s.step = 'acked'; s.moved = { to: moveTo(o, p), lab: '+' + p + '%' }; return {}; }
        if (cb === 'type') { s.step = 'typing'; return { composer: 'Type e.g. 148 or +3%' }; }
        if (cb === 'typed') {
          var v = String(arg || '').trim().replace(',', '.'), to, lab;
          if (/^[+-]?\d+(\.\d+)?%$/.test(v)) { var pp = Math.abs(parseFloat(v)); to = moveTo(o, pp); lab = '+' + pp + '%'; }
          else if (/^\d+(\.\d+)?$/.test(v)) { to = Math.round(parseFloat(v) * 100) / 100; lab = 'typed'; }
          else return { note: '🤖 Not understood. Send a price like 148.00 or a percent like +3%.' };
          if (o.dir * (to - o.price) <= 0) return { note: '🤖 ' + f2(to) + ' is not ' + below + ' last ' + f2(o.price) + ' (it would alert at once). Try again.' };
          s.step = 'acked'; s.moved = { to: to, lab: lab }; return { composerOff: true };
        }
        if (cb === 'dash') return { goto: 'dash' };
        if (cb === 'board') return { goto: 'board' };
        return {};
      }
    };
    return m;
  }

  /* Simple message: fixed text, buttons only show a toast or jump. */
  function stat(o) {
    return {
      id: o.id, title: o.title, kind: o.kind || 'info', notify: o.notify, edit: !!o.edit, time: o.time, from: o.from || 'bot',
      init: { expanded: false }, variants: o.variants,
      view: function (s) {
        var t = (s.expanded && o.long) ? o.long : o.lines;
        if (s.done) return { text: o.done.join('\n'), buttons: [] };
        return { text: t.join('\n'), buttons: o.buttons || [] };
      },
      act: function (s, cb) {
        if (cb === 'details') { s.expanded = !s.expanded; return {}; }
        if (cb === 'dash') return { goto: 'dash' };
        if (cb === 'board') return { goto: 'board' };
        if (cb === 'ackall' || cb === 'save') { s.done = true; return {}; }
        if (cb === 'cancel') { s.done = true; return { toast: 'Mock: cancelled, nothing saved.' }; }
        return { toast: 'Mock: this button would run "' + cb + '" on the server.' };
      }
    };
  }

  /* ======================================================================
     ALTERNATIVE A - GLANCE LINE
     ====================================================================== */
  function aHead(ev) { return ev.rule === 'VOLUME' ? '🚨 NEW 📊 <b>' + ev.sym + ' VOLUME</b> ' + ev.x : '🚨 NEW ' + ev.icon + ' <b>' + ev.sym + ' ' + ev.rule + '</b> ' + f2(ev.price); }
  function aFirst(ev, id, title, time) {
    var s = st(ev.sym);
    var main = function () {
      return [aHead(ev), ev.rule === 'VOLUME' ? 'IEX volume ' + ev.vol + ' · avg ' + ev.avgNow : pcOf(ev.price, s.pc) + ' · IEX vol ' + ev.x, both(ev.et)];
    };
    var details = function () {
      return [aHead(ev),
        ev.rule === 'VOLUME' ? 'Limit: VOLUME ≥ 2.0x average' : 'Limit: ' + ev.rule + ' ' + f2(ev.thr) + ' (LOW ' + f2(s.low) + ')',
        'Last ' + f2(ev.price) + ' · ' + sg(ev.price - s.pc) + ' (' + pcOf(ev.price, s.pc) + ')',
        'Prev Close ' + f2(s.pc),
        'Opening (IEX) ' + f2(s.open),
        'IEX volume ' + ev.vol + ' · ' + ev.x + ' avg',
        'Crossed ' + both(ev.et), 'Unacknowledged 0 min · alert #1'];
    };
    var o = { id: id, title: title, kind: 'first', time: time, sym: ev.sym, rule: ev.rule, thr: ev.thr, price: ev.price, et: ev.et, ackAt: ev.ackAt, main: main, details: details,
      buttons: function () { return [[ACK], [DETAILS, AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'After tapping Details (message edited, no new notification)', s: { expanded: true } }, { label: 'After Acknowledge', s: { step: 'acked' } }] };
    return flowMsg(o);
  }
  function aReminder3() {
    var ev = EV.nvdaRem3, s = st('NVDA');
    var o = { id: 'a-rem3', title: 'Reminder 3 (NVDA HIGH)', kind: 'reminder', time: '19:52', sym: 'NVDA', rule: 'HIGH', thr: 145.00, price: ev.price, et: ev.et, ackAt: ev.ackAt,
      main: function () { return ['🔁 <b>REMINDER 3</b> · not a new alert', '📈 NVDA HIGH 145.00 · 30 min open', 'Now 144.80 · back inside band', both(ev.et)]; },
      details: function () { return ['🔁 <b>REMINDER 3</b> · not a new alert', '📈 NVDA HIGH 145.00 · 30 min open', 'Now 144.80 · back inside band', 'Last ' + f2(ev.price) + ' · ' + sg(ev.price - s.pc) + ' (' + pcOf(ev.price, s.pc) + ')', 'Prev Close 138.20', 'Opening (IEX) 141.05', 'IEX volume ' + ev.vol + ' · ' + ev.x + ' avg', 'First alert ' + both('10:22'), 'Reminder 3 at ' + both(ev.et)]; },
      buttons: function () { return [[ACK], [DETAILS, AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'Details', s: { expanded: true } }, { label: 'Ack + move chooser', s: { step: 'move' } }, { label: 'Typed-value prompt', s: { step: 'typing' } }, { label: 'After Acknowledge', s: { step: 'acked' } }, { label: 'After Ack + move +1%', s: { step: 'acked', moved: { to: 146.45, lab: '+1%' } } }] };
    return flowMsg(o);
  }
  function aLate() {
    var ev = EV.xomLate, s = st('XOM');
    var o = { id: 'a-late', title: 'LATE alert (XOM HIGH)', kind: 'late', time: '23:11', sym: 'XOM', rule: 'HIGH', thr: 115.00, price: ev.now, et: ev.et, ackAt: ev.ackAt,
      main: function () { return ['⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00', 'Touched ' + ev.touchEt + ' ET · bar high 115.20', 'Found ' + ev.et + ' ET · runs were missed', both(ev.touchEt)]; },
      details: function () { return ['⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00', 'Touched ' + ev.touchEt + ' ET · bar high 115.20', 'Found ' + ev.et + ' ET · runs were missed', 'Now 114.60 · ' + sg(ev.now - s.pc) + ' (' + pcOf(ev.now, s.pc) + ')', 'Prev Close 111.30', 'Opening (IEX) 111.55', 'IEX volume ' + ev.vol + ' · ' + ev.x + ' avg', 'Touched ' + both(ev.touchEt)]; },
      buttons: function () { return [[ACK], [DETAILS, AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'Details', s: { expanded: true } }, { label: 'After Acknowledge', s: { step: 'acked' } }] };
    return flowMsg(o);
  }
  function aBriefing() {
    var order = briefOrder();
    var head = ['☀️ <b>OPENING BRIEFING</b>', DATE + ' · ' + both('09:31'), 'Close 16:00 ET / 01:00 Muscat', 'Sorted by gap · prices IEX', 'PC = Previous Close'];
    var cl = head.slice(), ex = head.slice();
    order.forEach(function (s) {
      var gc = gapCross(s), g = sp(gap(s));
      cl.push('', (gc ? '⚠️ ' : '') + '<b>' + s.sym + '</b> ' + g + ' Open(IEX) ' + f2(s.open));
      cl.push('PC ' + f2(s.pc) + ' · yHigh ' + f2(s.yH));
      if (gc) cl.push('<b>' + gc + ' ' + f2(gc === 'LOW' ? s.low : s.high) + ' crossed at open</b>');
      ex.push('', (gc ? '⚠️ ' : '') + '<b>' + s.sym + '</b> ' + g + ' Open(IEX) ' + f2(s.open));
      ex.push('PC ' + f2(s.pc) + ' · yHigh ' + f2(s.yH) + ' · yLow ' + f2(s.yL));
      ex.push('Yesterday IEX volume ' + fM(s.yV));
      ex.push('LOW ' + f2(s.low) + ' (' + dOpen(s.low, s) + ' vs open)' + (gc === 'LOW' ? ' ⚠️' : ''));
      ex.push('HIGH ' + f2(s.high) + ' (' + dOpen(s.high, s) + ' vs open)' + (gc === 'HIGH' ? ' ⚠️' : ''));
      ex.push('IEX avg/day ' + fM(s.avg) + ' · 2x = ' + fM(2 * s.avg));
      ex.push('2x IEX by 10:00 ' + x2(s, '10:00') + ' · 11:00 ' + x2(s, '11:00'));
      ex.push('2x IEX by 13:00 ' + x2(s, '13:00'));
      if (gc) ex.push('<b>' + gc + ' crossed at open - alert follows</b>');
    });
    cl.push('', '<i>Tap Details for volume levels.</i>');
    return stat({ id: 'a-brief', title: 'Opening Briefing (6 stocks)', notify: true, time: '18:31', lines: cl, long: ex, buttons: [[DETAILS, DASH]],
      variants: [{ label: 'As sent (collapsed)', s: {} }, { label: 'After Details (expanded in place)', s: { expanded: true } }] });
  }
  function aAlerts() {
    return [aFirst(EV.nvdaHigh, 'a-high', 'HIGH alert (NVDA)', '19:22'), aFirst(EV.amznLow, 'a-low', 'LOW alert (AMZN)', '22:15'), aFirst(EV.jpmVol, 'a-vol', 'VOLUME alert (JPM)', '19:42')];
  }
  function aClose() {
    return stat({ id: 'a-close', title: 'Unacknowledged at close', kind: 'close', notify: true, time: '01:00',
      lines: ['🔕 <b>UNACKNOWLEDGED AT CLOSE</b>', '2 alerts · no more reminders', '📉 AMZN LOW · since 13:15 ET', '📈 XOM HIGH · since 14:07 ET (late)', 'Closed 16:00 ET / 01:00 Muscat', 'They re-arm fresh at the next open.'],
      done: ['🔕 <b>UNACKNOWLEDGED AT CLOSE</b>', 'Marked as seen 01:02 Muscat', 'Nothing was sent after the close.'],
      buttons: [[button('✅ Mark all seen', 'ackall')], [DASH]], variants: [{ label: 'As sent', s: {} }, { label: 'After Mark all seen', s: { done: true } }] });
  }
  function aHealth() {
    return [
      stat({ id: 'a-ready', title: 'READY', kind: 'health', notify: false, time: '18:00', lines: ['🟢 <b>READY</b> · ' + DATE, '8 stocks · 24 rules active', 'Baselines 8/8 · calendar OK', 'Open ' + both('09:30').replace('09:30 ET', '09:30 ET'), 'Close 16:00 ET / 01:00 Muscat'] }),
      stat({ id: 'a-end', title: 'SESSION ENDED', kind: 'health', notify: false, time: '01:05', lines: ['🏁 <b>SESSION ENDED</b> · ' + DATE, 'Closed 16:00 ET / 01:00 Muscat', 'Alerts 5 (1 late) · reminders 11', 'Acknowledged 3 · open at close 2', 'Missed polls 3 min · gap scan OK'] }),
      stat({ id: 'a-err', title: 'Operational error notice', kind: 'health', notify: true, time: '20:41', lines: ['⚠️ <b>DATA PROBLEM</b> · provider error', 'No prices for 2 min', 'Alerts may be late, not lost.', 'Gap scan runs when data returns.', 'Since ' + both('11:41'), 'Next notice of this type: 30 min'], buttons: [[DASH]] })
    ];
  }
  function aCommands() {
    return [
      stat({ id: 'a-cmd-status', from: 'user', title: '/status (you type)', notify: null, time: '19:40', lines: ['/status'] }),
      stat({ id: 'a-status', title: '/status reply', notify: true, time: '19:40', lines: ['<b>STATUS</b> · v0.1.0 (sample)', 'Market OPEN · closes 16:00 ET', 'Data LIVE · last poll 12 s ago', 'Unacknowledged: 1', 'Next reminder ' + both('10:42'), 'Baselines 8/8 · calendar valid', 'Free tier: 3% writes · 2% requests'] }),
      stat({ id: 'a-cmd-set', from: 'user', title: '/set (you type)', notify: null, time: '19:41', lines: ['/set NVDA high 148'] }),
      stat({ id: 'a-set', title: '/set reply', notify: true, time: '19:41', lines: ['✅ <b>NVDA HIGH</b> set to 148.00', '+7.1% from Prev Close 138.20', 'Was 145.00 · last 145.60', 'Re-armed now.'] }),
      stat({ id: 'a-cmd-set2', from: 'user', title: '/set that is already crossed (you type)', notify: null, time: '19:42', lines: ['/set NVDA high 145'] }),
      stat({ id: 'a-set2', title: '/set confirmation (already crossed)', notify: true, time: '19:42', lines: ['⚠️ <b>NVDA HIGH 145.00</b>', 'Last 145.60 is already above it.', '<b>This will alert immediately. Save?</b>'], done: ['✅ <b>NVDA HIGH</b> saved: 145.00', 'Alert sent now (see above).'], buttons: [[button('✅ Save and alert', 'save')], [button('← Cancel', 'cancel')]], variants: [{ label: 'As sent', s: {} }, { label: 'After Save', s: { done: true } }] })
    ];
  }

  /* ======================================================================
     ALTERNATIVE B - DECISION CARD
     ====================================================================== */
  function bBlocks(ev, s, head, sub, timeLines) {
    var vol = ev.rule === 'VOLUME' ? ['IEX volume ' + ev.vol + ' · avg ' + ev.avgNow, 'Multiple ' + ev.x + ' · limit 2.0x'] : ['IEX volume ' + ev.vol + ' · ' + ev.x + ' avg'];
    var price = ev.price;
    return [].concat(head, sub, ['▸ <b>PRICE</b>', 'Last ' + f2(price) + ' (' + sg(price - s.pc) + ' · ' + pcOf(price, s.pc) + ')', 'Prev Close ' + f2(s.pc), 'Opening (IEX) ' + f2(s.open),
      '▸ <b>LEVELS</b>', 'LOW ' + f2(s.low) + ' · HIGH ' + f2(s.high) + (ev.rule === 'VOLUME' ? '' : '  ◀ ' + ev.rule), '▸ <b>VOLUME</b>'], vol, ['▸ <b>TIME</b>'], timeLines);
  }
  function bFirst(ev, id, title, time) {
    var s = st(ev.sym);
    var head = ['🚨 <b>NEW ALERT</b> ' + ev.icon + ' <b>' + ev.sym + ' ' + ev.rule + '</b>'];
    var sub = [ev.rule === 'VOLUME' ? '<b>' + ev.x + '</b> IEX volume · price ' + f2(ev.price) : '<b>' + f2(ev.price) + '</b> (' + pcOf(ev.price, s.pc) + ') · limit ' + f2(ev.thr)];
    var o = { id: id, title: title, kind: 'first', time: time, sym: ev.sym, rule: ev.rule, thr: ev.thr, price: ev.price, et: ev.et, ackAt: ev.ackAt,
      main: function () { return bBlocks(ev, s, head, sub, ['Crossed ' + both(ev.et), 'Unacknowledged 0 min · alert #1']); },
      buttons: function () { return [[ACK], [AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'After Acknowledge', s: { step: 'acked' } }] };
    return flowMsg(o);
  }
  function bReminder3() {
    var ev = EV.nvdaRem3, s = st('NVDA');
    var o = { id: 'b-rem3', title: 'Reminder 3 (NVDA HIGH)', kind: 'reminder', time: '19:52', sym: 'NVDA', rule: 'HIGH', thr: 145.00, price: ev.price, et: ev.et, ackAt: ev.ackAt,
      main: function () {
        return bBlocks(ev, s, ['🔁 <b>REMINDER 3</b> · NOT A NEW ALERT', '📈 <b>NVDA HIGH</b> · now <b>144.80</b>'], ['↩ Price is back inside your band'],
          ['First alert ' + both('10:22'), 'Unacknowledged 30 min · R3']);
      },
      buttons: function () { return [[ACK], [AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'Ack + move chooser', s: { step: 'move' } }, { label: 'Typed-value prompt', s: { step: 'typing' } }, { label: 'After Acknowledge', s: { step: 'acked' } }, { label: 'After Ack + move +1%', s: { step: 'acked', moved: { to: 146.45, lab: '+1%' } } }] };
    return flowMsg(o);
  }
  function bLate() {
    var ev = EV.xomLate, s = st('XOM');
    var fake = { sym: 'XOM', rule: 'HIGH', price: ev.now, vol: ev.vol, x: ev.x };
    var o = { id: 'b-late', title: 'LATE alert (XOM HIGH)', kind: 'late', time: '23:11', sym: 'XOM', rule: 'HIGH', thr: 115.00, price: ev.now, et: ev.et, ackAt: ev.ackAt,
      main: function () {
        return bBlocks(fake, s, ['⏱ <b>LATE ALERT</b> 📈 <b>XOM HIGH</b>', 'Missed runs · found by gap scan'], ['Bar high <b>115.20</b> ≥ limit 115.00'],
          ['Touched ' + both('14:07'), 'Found ' + both('14:11'), 'Unacknowledged 0 min · alert #1']);
      },
      buttons: function () { return [[ACK], [AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'After Acknowledge', s: { step: 'acked' } }] };
    return flowMsg(o);
  }
  function bBriefing() {
    var order = briefOrder();
    function card(s) {
      var gc = gapCross(s), l = [];
      l.push((gc ? '⚠️ ' : '') + '<b>' + s.sym + '</b> ' + (gap(s) >= 0 ? '▲' : '▼') + ' gap ' + sp(gap(s)));
      l.push('PC ' + f2(s.pc) + ' → Open(IEX) ' + f2(s.open));
      l.push('Yest H ' + f2(s.yH) + ' L ' + f2(s.yL) + ' · ' + fM(s.yV));
      l.push('LOW ' + f2(s.low) + ' (' + dOpen(s.low, s) + ' vs open)');
      l.push('HIGH ' + f2(s.high) + ' (' + dOpen(s.high, s) + ' vs open)');
      l.push('IEX avg/day ' + fM(s.avg) + ' · 2x ' + fM(2 * s.avg));
      l.push('2x at 10/11/13h: ' + x2(s, '10:00') + ' ' + x2(s, '11:00') + ' ' + x2(s, '13:00'));
      if (gc) l.push('<b>' + gc + ' crossed at open - alert follows</b>');
      return l;
    }
    function build(part, items) {
      var l = ['☀️ <b>OPENING BRIEFING</b> ' + part, DATE + ' · ' + both('09:31'), 'Close 16:00 ET / 01:00 Muscat', 'Sorted by gap · all volume is IEX'];
      items.forEach(function (s) { l.push(''); card(s).forEach(function (x) { l.push(x); }); });
      return l;
    }
    return [
      stat({ id: 'b-brief1', title: 'Opening Briefing 1/2', notify: true, time: '18:31', lines: build('1/2', order.slice(0, 3)), buttons: [[DASH]] }),
      stat({ id: 'b-brief2', title: 'Opening Briefing 2/2', notify: false, time: '18:31', lines: build('2/2', order.slice(3)).concat(['', '<i>Y = yesterday · PC = Previous Close</i>']), buttons: [[DASH]] })
    ];
  }
  function bClose() {
    return stat({ id: 'b-close', title: 'Unacknowledged at close', kind: 'close', notify: true, time: '01:00',
      lines: ['🔕 <b>UNACKNOWLEDGED AT CLOSE</b>', '2 alerts · reminders have stopped', '', '▸ <b>1 · 📉 AMZN LOW</b>', 'Limit 200.00 · low print 199.85', 'Crossed ' + both('13:15'), 'Reminders sent 8', '', '▸ <b>2 · 📈 XOM HIGH (LATE)</b>', 'Limit 115.00 · bar high 115.20', 'Touched ' + both('14:07'), 'Reminders sent 5', '', 'Closed ' + both('16:00').replace('16:00 ET / 01:00', '16:00 ET / 01:00'), 'Both re-arm fresh at the next open.'],
      done: ['🔕 <b>UNACKNOWLEDGED AT CLOSE</b>', 'Marked as seen 01:02 Muscat', 'Nothing was sent after the close.'],
      buttons: [[button('✅ Mark all seen', 'ackall')], [DASH]], variants: [{ label: 'As sent', s: {} }, { label: 'After Mark all seen', s: { done: true } }] });
  }
  function bHealth() {
    return [
      stat({ id: 'b-ready', title: 'READY', kind: 'health', notify: false, time: '18:00', lines: ['🟢 <b>READY</b> · ' + DATE, '', '▸ <b>STOCKS</b>', '8 active · 24 rules', 'Baselines 8/8', '▸ <b>SYSTEM</b>', 'Calendar OK · data LIVE', '▸ <b>SESSION</b>', 'Open ' + both('09:30'), 'Close ' + both('16:00')] }),
      stat({ id: 'b-end', title: 'SESSION ENDED', kind: 'health', notify: false, time: '01:05', lines: ['🏁 <b>SESSION ENDED</b> · ' + DATE, '', '▸ <b>ALERTS</b>', 'First alerts 5 (1 late)', 'Reminders 11', '▸ <b>OUTCOME</b>', 'Acknowledged 3', 'Open at close 2', '▸ <b>HEALTH</b>', 'Missed polls 3 min · gap scan OK', 'Closed ' + both('16:00')] }),
      stat({ id: 'b-err', title: 'Operational error notice', kind: 'health', notify: true, time: '20:41', lines: ['⚠️ <b>DATA PROBLEM</b>', '', '▸ <b>WHAT</b>', 'Provider returned errors', 'No prices for 2 min', '▸ <b>IMPACT</b>', 'Alerts may be late, not lost.', 'Gap scan runs on recovery.', '▸ <b>WHEN</b>', 'Since ' + both('11:41'), 'Next notice of this type: 30 min'], buttons: [[DASH]] })
    ];
  }
  function bCommands() {
    return [
      stat({ id: 'b-cmd-status', from: 'user', title: '/status (you type)', notify: null, time: '19:40', lines: ['/status'] }),
      stat({ id: 'b-status', title: '/status reply', notify: true, time: '19:40', lines: ['<b>STATUS</b> · v0.1.0 (sample)', '', '▸ <b>MARKET</b>', 'OPEN · closes 16:00 ET', 'Data LIVE · poll 12 s ago', '▸ <b>ALERTS</b>', 'Unacknowledged 1', 'Next reminder ' + both('10:42'), '▸ <b>SYSTEM</b>', 'Baselines 8/8 · calendar valid', 'Free tier 3% writes · 2% requests'] }),
      stat({ id: 'b-cmd-set', from: 'user', title: '/set (you type)', notify: null, time: '19:41', lines: ['/set NVDA high 148'] }),
      stat({ id: 'b-set', title: '/set reply', notify: true, time: '19:41', lines: ['✅ <b>NVDA HIGH</b> saved', '', '▸ <b>NEW</b>', 'HIGH 148.00 (+7.1% from PC)', '▸ <b>BEFORE</b>', 'HIGH 145.00', '▸ <b>NOW</b>', 'Last 145.60 · inside the band', 'Re-armed immediately'] }),
      stat({ id: 'b-cmd-set2', from: 'user', title: '/set that is already crossed (you type)', notify: null, time: '19:42', lines: ['/set NVDA high 145'] }),
      stat({ id: 'b-set2', title: '/set confirmation (already crossed)', notify: true, time: '19:42', lines: ['⚠️ <b>CHECK BEFORE SAVING</b>', '', 'NVDA HIGH 145.00', 'Last 145.60 is already above it.', '<b>This will alert immediately. Save?</b>'], done: ['✅ <b>NVDA HIGH</b> saved: 145.00', 'Alert sent now (see above).'], buttons: [[button('✅ Save and alert', 'save')], [button('← Cancel', 'cancel')]], variants: [{ label: 'As sent', s: {} }, { label: 'After Save', s: { done: true } }] })
    ];
  }

  /* ======================================================================
     ALTERNATIVE C - LIVE BOARD
     ====================================================================== */
  function statusWord(s) {
    if (s.st === 'CROSSED') return '🚨 CROSSED';
    if (s.st === 'ACK') return '✔ ACKED';
    if (s.st === 'NEAR') return '◔ NEAR';
    return '✓ OK';
  }
  function boardLines(final) {
    var l = ['📋 <b>LIVE BOARD</b> · ' + DATE, 'Updated ' + both(NOW_ET), 'Market OPEN · data LIVE', '<i>Op = Opening (IEX) · PC = Prev Close</i>', '', '━━ <b>ACTION NEEDED (1)</b> ━━',
      '🚨 <b>NVDA HIGH 145.00 crossed</b>', 'Last 145.60 · +7.40 (+5.35%)', 'PC 138.20 · Opening (IEX) 141.05', 'LOW 130.00 · HIGH 145.00', 'IEX volume 1.90M · 1.3x avg', 'Since ' + both('10:22'), 'Reminder 1 sent · next 10:42 ET', '', '━━ <b>WATCHING (7)</b> ━━'];
    S.filter(function (s) { return s.sym !== 'NVDA'; }).forEach(function (s) {
      var stale = s.age > 300 ? ' 🔴 STALE ' + Math.round(s.age / 60) + ' min' : (s.age > 60 ? ' 🟡 STALE ' + s.age + ' s' : '');
      var word = s.st === 'ACK' ? '✔ ACKED ' + s.ackAt : statusWord(s);
      l.push('<b>' + s.sym + '</b> ' + f2(s.last) + ' ' + pcOf(s.last, s.pc) + ' ' + word);
      if (stale) l.push(stale.trim());
      l.push('PC ' + f2(s.pc) + ' Op ' + f2(s.open) + ' L' + f2(s.low) + ' H' + f2(s.high));
    });
    l.push('', '<i>Edited silently. Alerts are pings.</i>');
    return l;
  }
  function cFirst(ev, id, title, time) {
    var s = st(ev.sym);
    var o = { id: id, title: title, kind: 'first', time: time, sym: ev.sym, rule: ev.rule, thr: ev.thr, price: ev.price, et: ev.et, ackAt: ev.ackAt,
      main: function () {
        return [ev.rule === 'VOLUME' ? '🚨 NEW 📊 <b>' + ev.sym + ' VOLUME</b> ' + ev.x : '🚨 NEW ' + ev.icon + ' <b>' + ev.sym + ' ' + ev.rule + '</b> ' + f2(ev.price), both(ev.et), 'Full numbers: pinned board ▲'];
      },
      buttons: function () { return [[ACK], [BOARD, AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'After Acknowledge', s: { step: 'acked' } }] };
    return flowMsg(o);
  }
  /* Combined reminder digest: one notifying message for every open alert due in the same minute. */
  function cDigest() {
    var A = { sym: 'NVDA', rule: 'HIGH', thr: 145.00, price: 144.80, dir: 1, ackAt: '19:52' };
    var J = { sym: 'JPM', rule: 'VOLUME', ackAt: '19:52' };
    function lines(s) {
      var l = ['🔁 <b>REMINDERS</b> · ' + (s.n === 'open' && s.j === 'open' ? '2 open' : (s.n === 'open' || s.j === 'open' ? '1 open' : 'all done')) + ' · NOT NEW'];
      if (s.n === 'open') { l.push('📈 NVDA HIGH · R3 · 30 min', 'now 144.80 · back inside band'); }
      else l.push('✅ NVDA HIGH acknowledged 19:52'); if (s.moved) l.push('HIGH moved 145.00 → ' + f2(s.moved.to) + ' (' + s.moved.lab + ')');
      if (s.j === 'open') { l.push('📊 JPM VOLUME · R1 · 10 min', 'now 2.1x IEX volume'); }
      else l.push('✅ JPM VOLUME acknowledged 19:52');
      l.push(both('10:52'));
      if (s.n === 'open' || s.j === 'open') l.push('Full numbers: pinned board ▲');
      return l;
    }
    return {
      id: 'c-rem3', title: 'Reminder 3 (NVDA HIGH, combined with JPM VOLUME)', kind: 'reminder', notify: true, time: '19:52', ackable: true,
      init: { n: 'open', j: 'open', mv: false, moved: null },
      variants: [{ label: 'As sent (two alerts due in the same minute)', s: {} }, { label: 'Ack + move chooser for NVDA', s: { mv: true } }, { label: 'NVDA acknowledged + moved +1%', s: { n: 'done', moved: { to: 146.45, lab: '+1%' } } }, { label: 'Both acknowledged', s: { n: 'done', j: 'done' } }],
      view: function (s) {
        if (s.mv) return { text: ['↗ <b>Acknowledge and move NVDA HIGH</b>', 'HIGH is 145.00 · last 144.80', 'Move it further out by:'].join('\n'), buttons: [[button('+1% → 146.45', 'm1'), button('+2% → 147.90', 'm2')], [button('⌨ Type a value', 'type')], [button('← Cancel', 'cancel')]] };
        if (s.typing) return { text: ['⌨ Reply with the new NVDA HIGH:', 'a price (148.00) or a percent (+3%)', 'Must be above last 144.80.'].join('\n'), buttons: [[button('← Cancel', 'cancel')]] };
        var b = [];
        if (s.n === 'open') b.push([button('✅ Ack NVDA', 'ackn', { primary: true }), button('↗ +move', 'ackmove')]);
        if (s.j === 'open') b.push([button('✅ Ack JPM', 'ackj', { primary: true })]);
        if (s.n === 'open' && s.j === 'open') b.push([button('✅ Acknowledge all', 'ackall')]);
        if (s.n === 'open' || s.j === 'open') b.push([BOARD, DASH]);
        return { text: lines(s).join('\n'), buttons: b };
      },
      act: function (s, cb, arg) {
        if (cb === 'ackn') { s.n = 'done'; s.moved = null; return {}; }
        if (cb === 'ackj') { s.j = 'done'; return {}; }
        if (cb === 'ackall') { s.n = 'done'; s.j = 'done'; s.moved = null; return {}; }
        if (cb === 'ackmove') { s.mv = true; return {}; }
        if (cb === 'cancel') { s.mv = false; s.typing = false; return {}; }
        if (cb === 'm1' || cb === 'm2') { var p = cb === 'm1' ? 1 : 2; s.mv = false; s.n = 'done'; s.moved = { to: Math.round(145 * (1 + p / 100) * 100) / 100, lab: '+' + p + '%' }; return {}; }
        if (cb === 'type') { s.mv = false; s.typing = true; return { composer: 'Type e.g. 148 or +3%' }; }
        if (cb === 'typed') {
          var v = String(arg || '').trim().replace(',', '.'), to;
          if (/^\+?\d+(\.\d+)?%$/.test(v)) to = Math.round(145 * (1 + parseFloat(v) / 100) * 100) / 100;
          else if (/^\d+(\.\d+)?$/.test(v)) to = Math.round(parseFloat(v) * 100) / 100;
          else return { note: '🤖 Not understood. Send a price like 148.00 or a percent like +3%.' };
          if (to <= 144.80) return { note: '🤖 ' + f2(to) + ' is not above last 144.80 (it would alert at once). Try again.' };
          s.typing = false; s.n = 'done'; s.moved = { to: to, lab: 'typed' }; return { composerOff: true };
        }
        if (cb === 'dash') return { goto: 'dash' };
        if (cb === 'board') return { goto: 'board' };
        return {};
      }
    };
  }
  function cBriefing() {
    var order = briefOrder();
    var l = ['☀️ <b>OPENING BRIEFING</b>', DATE + ' · ' + both('09:31'), 'Close 16:00 ET / 01:00 Muscat', 'Prices and volume are IEX', 'PC = Prev Close · Op = Opening (IEX)', '', '<b>PRICES</b> (sorted by gap)'];
    order.forEach(function (s) {
      var gc = gapCross(s);
      l.push((gc ? '⚠️ ' : '') + '<b>' + s.sym + '</b> ' + sp(gap(s)) + ' PC ' + f2(s.pc) + ' Op ' + f2(s.open));
      l.push('yH ' + f2(s.yH) + ' yL ' + f2(s.yL) + ' · L' + f2(s.low) + ' H' + f2(s.high));
      if (gc) l.push('<b>' + gc + ' crossed at open - alert follows</b>');
    });
    l.push('', '<b>2x IEX VOLUME</b> at 10:00 / 11:00 / 13:00');
    order.forEach(function (s) { l.push(s.sym + ' ' + x2(s, '10:00').replace('M', '') + ' / ' + x2(s, '11:00').replace('M', '') + ' / ' + x2(s, '13:00')); });
    l.push('', '<i>Live numbers: pinned board ▲</i>');
    return stat({ id: 'c-brief', title: 'Opening Briefing (6 stocks)', notify: true, time: '18:31', lines: l, buttons: [[BOARD, DASH]] });
  }
  function cLate() {
    var ev = EV.xomLate;
    var o = { id: 'c-late', title: 'LATE alert (XOM HIGH)', kind: 'late', time: '23:11', sym: 'XOM', rule: 'HIGH', thr: 115.00, price: ev.now, et: ev.et, ackAt: ev.ackAt,
      main: function () { return ['⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00', 'Touched ' + both('14:07'), 'Found ' + ev.et + ' ET · runs were missed', 'Full numbers: pinned board ▲']; },
      buttons: function () { return [[ACK], [BOARD, AMOVE], [MUTE, DASH]]; },
      variants: [{ label: 'As sent', s: {} }, { label: 'After Acknowledge', s: { step: 'acked' } }] };
    return flowMsg(o);
  }
  function cClose() {
    return stat({ id: 'c-close', title: 'Unacknowledged at close', kind: 'close', notify: true, time: '01:00',
      lines: ['🔕 <b>UNACKNOWLEDGED AT CLOSE</b>', '2 alerts · no more reminders', '📉 AMZN LOW · since 13:15 ET', '📈 XOM HIGH · since 14:07 ET (late)', 'Closed 16:00 ET / 01:00 Muscat', 'The board is frozen as of the close.'],
      done: ['🔕 <b>UNACKNOWLEDGED AT CLOSE</b>', 'Marked as seen 01:02 Muscat', 'Nothing was sent after the close.'],
      buttons: [[button('✅ Mark all seen', 'ackall')], [BOARD, DASH]], variants: [{ label: 'As sent', s: {} }, { label: 'After Mark all seen', s: { done: true } }] });
  }
  function cHealth() {
    return [
      stat({ id: 'c-ready', title: 'READY (also pins the new board)', kind: 'health', notify: false, time: '18:00', lines: ['🟢 <b>READY</b> · ' + DATE, '8 stocks · 24 rules active', 'Baselines 8/8 · calendar OK', 'Open ' + both('09:30'), '📌 Today\'s board is pinned ▲'] }),
      stat({ id: 'c-end', title: 'SESSION ENDED', kind: 'health', notify: false, time: '01:05', lines: ['🏁 <b>SESSION ENDED</b> · ' + DATE, 'Closed 16:00 ET / 01:00 Muscat', 'Alerts 5 (1 late) · reminders 11', 'Acknowledged 3 · open at close 2', 'Missed polls 3 min · gap scan OK', '📌 Board frozen at the close.'] }),
      stat({ id: 'c-err', title: 'Operational error notice', kind: 'health', notify: true, time: '20:41', lines: ['⚠️ <b>DATA PROBLEM</b> · provider error', 'No prices for 2 min', 'Alerts may be late, not lost.', 'Board shows 🔴 STALE until fixed.', 'Since ' + both('11:41'), 'Next notice of this type: 30 min'], buttons: [[BOARD, DASH]] })
    ];
  }
  function cCommands() {
    return [
      stat({ id: 'c-cmd-status', from: 'user', title: '/status (you type)', notify: null, time: '19:40', lines: ['/status'] }),
      stat({ id: 'c-status', title: '/status reply', notify: true, time: '19:40', lines: ['<b>STATUS</b> · v0.1.0 (sample)', 'Market OPEN · closes 16:00 ET', 'Data LIVE · last poll 12 s ago', 'Board edited 19:40 Muscat', 'Unacknowledged: 1', 'Next reminder ' + both('10:42'), 'Baselines 8/8 · calendar valid', 'Free tier: 3% writes · 2% requests'], buttons: [[BOARD]] }),
      stat({ id: 'c-cmd-set', from: 'user', title: '/set (you type)', notify: null, time: '19:41', lines: ['/set NVDA high 148'] }),
      stat({ id: 'c-set', title: '/set reply', notify: true, time: '19:41', lines: ['✅ <b>NVDA HIGH</b> set to 148.00', '+7.1% from Prev Close 138.20', 'Was 145.00 · last 145.60', 'Re-armed now. Board updated.'] }),
      stat({ id: 'c-cmd-set2', from: 'user', title: '/set that is already crossed (you type)', notify: null, time: '19:42', lines: ['/set NVDA high 145'] }),
      stat({ id: 'c-set2', title: '/set confirmation (already crossed)', notify: true, time: '19:42', lines: ['⚠️ <b>NVDA HIGH 145.00</b>', 'Last 145.60 is already above it.', '<b>This will alert immediately. Save?</b>'], done: ['✅ <b>NVDA HIGH</b> saved: 145.00', 'Alert sent now (see above).'], buttons: [[button('✅ Save and alert', 'save')], [button('← Cancel', 'cancel')]], variants: [{ label: 'As sent', s: {} }, { label: 'After Save', s: { done: true } }] })
    ];
  }

  /* ---------- scenes (PRD 9.2 letters) ---------- */
  function scenes(alt) {
    var T = {
      A: { brief: [aBriefing()], first: aAlerts(), rem: [aReminder3()], late: [aLate(), aClose()], health: aHealth(), cmd: aCommands() },
      B: { brief: bBriefing(), first: [bFirst(EV.nvdaHigh, 'b-high', 'HIGH alert (NVDA)', '19:22'), bFirst(EV.amznLow, 'b-low', 'LOW alert (AMZN)', '22:15'), bFirst(EV.jpmVol, 'b-vol', 'VOLUME alert (JPM)', '19:42')], rem: [bReminder3()], late: [bLate(), bClose()], health: bHealth(), cmd: bCommands() },
      C: { brief: [cBriefing()], first: [cFirst(EV.nvdaHigh, 'c-high', 'HIGH alert (NVDA)', '19:22'), cFirst(EV.amznLow, 'c-low', 'LOW alert (AMZN)', '22:15'), cFirst(EV.jpmVol, 'c-vol', 'VOLUME alert (JPM)', '19:42')], rem: [cDigest()], late: [cLate(), cClose()], health: cHealth(), cmd: cCommands() }
    }[alt];
    var out = [
      { letter: 'a', title: 'Opening Briefing, 6 sample stocks', note: 'Sent about 60 s after the open: ' + both('09:31') + '. Information only, no acknowledge, no repeats.', items: T.brief },
    ];
    if (alt === 'C') out.push({ letter: 'a2', title: 'The pinned Live Board (edited in place)', note: 'Edited silently on every state change and about every 5 minutes. Shown as of ' + both(NOW_ET) + '. Edits never notify.', items: [stat({ id: 'c-board', title: 'Live Board (pinned)', kind: 'board', notify: false, edit: true, time: '19:40', lines: boardLines(), buttons: [[button('✅ Ack NVDA', 'ack', { primary: true }), button('✅ Ack all', 'ackall')], [DASH]] })] });
    out.push(
      { letter: 'b', title: 'First alerts: HIGH, LOW, VOLUME', note: 'Each first alert is sent in the same run as the crossing. Tap the buttons to try them.', items: T.first },
      { letter: 'c', title: 'Reminder 3 and the acknowledge flow', note: alt === 'C' ? 'Reminder 3 of NVDA is due in the same minute as JPM reminder 1, so ONE combined message is sent. Try Acknowledge, "+move" and "Type a value".' : 'Sent 30 minutes after the first alert (10:22 ET). Try Acknowledge, Ack + move (+1%, +2%, Type a value).', items: T.rem },
      { letter: 'd', title: 'LATE alert and Unacknowledged at close', note: 'LATE: two schedule runs were missed; the gap scan found the crossing.', items: T.late },
      { letter: 'e', title: 'READY, SESSION ENDED, operational error', note: 'READY and SESSION ENDED are silent. The error notice notifies, at most once per 30 minutes per type.', items: T.health },
      { letter: 'i', title: '/status and /set exchanges', note: 'Commands you type are shown on the right.', items: T.cmd }
    );
    return out;
  }

  /* ---------- trade-offs (PRD 9.2 j, 9.5) ---------- */
  var ALTS = {
    A: {
      key: 'A', name: 'Glance Line', tag: 'Two or three lines per alert, details on demand',
      idea: 'Every alert is 3 lines you can read on the lock screen. A Details button expands the message in place (an edit, so no extra notification). Acknowledge is always the first, full-width button.',
      sharpened: 'Added: Details expands in place (no new message), Acknowledge on its own row so a night-time mis-tap lands on the harmless Details button, and the dashboard is a sorted list with the five numbers on every row.',
      strengths: ['Fastest to read: type, symbol, rule and price are in the first line, which is what the phone shows on the lock screen.', 'Shortest reminders, so ten of them in a row stay tolerable.', 'Details expands in place, so the chat stays short and nothing extra buzzes.', 'Small formatter, easy to test; closest to FR-5.5 with the least text.'],
      weaknesses: ['Previous Close, Opening and both thresholds are not visible until Details is tapped (the five numbers are one tap away on Telegram, always visible on the dashboard).', 'Three buttons per row and a second tap for the full card.', 'Briefing is collapsed by default, so volume levels need a tap.'],
      quiet: '5 messages (3 notify): READY, Briefing, 1 alert, 1 reminder, SESSION ENDED. Plus 1 silent edit when acknowledged.',
      busy: '37 messages (35 notify): READY, Briefing, 8 first alerts, 24 reminders, 1 close summary, 1 error, SESSION ENDED. Tidy-up (FR-4.12) keeps only the newest reminder per rule in the chat.',
      effort: 'Low to medium, about 3 days. Formatter plus one stored "expanded" flag per message; callbacks edit the same message.',
      risk: 'Low. Main risk: Salim acknowledges from the glance without seeing the opening price or levels (mitigation: Details is the second button, the dashboard shows all five numbers).',
      score: [['Five numbers in 3 s', 'Partial on Telegram (Last only), full on dashboard'], ['Which alert needs action now', 'Good: NEW/REMINDER prefix and icon in line 1'], ['One-tap acknowledge, no night mis-tap', 'Good: Acknowledge alone on row 1'], ['Readable on both screens', 'Good: all lines are 38 characters or fewer'], ['Quiet when quiet, loud when not', 'Good: 3 messages on a quiet day'], ['Effort / risk', 'Low / low']]
    },
    B: {
      key: 'B', name: 'Decision Card', tag: 'Everything in one grouped card',
      idea: 'Every alert is a complete card in four labelled blocks (Price, Levels, Volume, Time), so the decision can be made without tapping anything but Acknowledge.',
      sharpened: 'Added: the first two lines repeat symbol, rule, price and limit so the lock-screen preview is still useful; Acknowledge is a full-width button on its own row; the briefing is split into two messages by gap size (FR-7.4).',
      strengths: ['All five numbers, volume and times are in the message itself: no second tap, no hidden data.', 'Most complete record in the chat: you can scroll back and see exactly what you knew at the time.', 'Fixed layout, so you learn where each number is.', 'No stored state besides the acknowledgment.'],
      weaknesses: ['About 14 lines per alert; on the cover screen one card fills most of the display.', 'Reminders repeat the whole card every 10 minutes, so a busy day is a lot of text.', 'The notification preview shows only the first lines, so the card structure helps little on the lock screen.', 'Briefing needs two messages for 6 stocks and more for 30.'],
      quiet: '6 messages (3 notify): READY, Briefing 1/2 (notifies), Briefing 2/2 (silent), 1 alert, 1 reminder, SESSION ENDED.',
      busy: '38 messages (35 notify): as A, plus one extra briefing message. Same notification count as A, but about 3 times the text.',
      effort: 'Low, about 2 days. Static formatter; no expand/collapse state.',
      risk: 'Low technically. Usability risk: long reminders lose urgency (a block of text looks the same as the last one). Mitigated by the 🔁 NOT A NEW ALERT banner.',
      score: [['Five numbers in 3 s', 'Good: three of five in PRICE, two in LEVELS, same place every time'], ['Which alert needs action now', 'Good: banner line, but cards look alike when stacked'], ['One-tap acknowledge, no night mis-tap', 'Good: Acknowledge alone on row 1'], ['Readable on both screens', 'Fair: long on the cover screen'], ['Quiet when quiet, loud when not', 'Fair: loud text even for reminders'], ['Effort / risk', 'Low / low']]
    },
    C: {
      key: 'C', name: 'Live Board', tag: 'One pinned board plus short pings',
      idea: 'One pinned message per session lists every stock (the five numbers on two lines) and the alerts needing action, and is edited in place. A short notifying ping is sent only for a first alert or a reminder; reminders due in the same minute share ONE message.',
      sharpened: 'Added: combined reminder digest (FR-4.13 extended across stocks), the board carries the full alert card for open alerts so pings can stay at 3 lines, and the board shows an "Updated HH:MM" line so a frozen board is visible.',
      strengths: ['Best overview: all stocks and all open alerts at a glance, on one screen.', 'Fewest notifications on a busy day because reminders are combined.', 'The chat stays short: one board, a few pings.', 'Board and dashboard show the same structure, so learning one teaches the other.'],
      weaknesses: ['Edits do not notify, so the board can be stale without any sound; Salim must trust the "Updated" time and the pings.', 'Pings carry less than FR-5.5 requires: the rest sits on the board (needs a PRD wording change).', 'Combined reminders break the one-alert-one-reminder-number rule (each line keeps its own R number).', 'Two sources of truth to keep in step (board and pings).'],
      quiet: '6 messages (3 notify): READY, pinned Board, Briefing, 1 alert, 1 reminder, SESSION ENDED. Plus about 85 silent board edits.',
      busy: '26 messages (23 notify): READY, Board, Briefing, 8 first alerts, about 12 combined reminders, 1 close summary, 1 error, SESSION ENDED. About 150 silent board edits.',
      effort: 'High, about 6 days. Board state machine, edit throttling, "message is not modified" handling, re-pin if deleted, digest scheduling, more Telegram calls per run (budget guard).',
      risk: 'Highest. Edits never notify; Telegram can reject unchanged edits; the board is lost if Salim deletes it; more calls per run against the 45-call limit; combined reminders change FR-4.2 wording.',
      score: [['Five numbers in 3 s', 'Good: two lines per stock, all five numbers'], ['Which alert needs action now', 'Best: ACTION NEEDED section on top, ping on new'], ['One-tap acknowledge, no night mis-tap', 'Fair: several ack buttons in a combined reminder'], ['Readable on both screens', 'Good: lines are 38 characters or fewer; board is tall (about 40 lines)'], ['Quiet when quiet, loud when not', 'Best: fewest pings'], ['Effort / risk', 'High / medium-high']]
    }
  };

  return { S: S, st: st, EV: EV, ALTS: ALTS, scenes: scenes, width: width, widest: widest, plain: plain, both: both, mus: mus, f2: f2, sg: sg, sp: sp, pcOf: pcOf, fM: fM, gap: gap, gapCross: gapCross, FRAC: FRAC, DATE: DATE, DATE_LONG: DATE_LONG, NOW_ET: NOW_ET, boardLines: boardLines };
})();
if (typeof module !== 'undefined') module.exports = MM;
