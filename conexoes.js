/* FAROL — conexões feitas pelo próprio navegador, sem instalar nada:
     · scanner OBD2 Bluetooth 4.0 (BLE)  → velocidade, rotação, temperatura, bateria, carga, acelerador, consumo
     · fita de LED Bluetooth (ELK-BLEDOM / duoCo Strip / Lotus Lantern, e Triones / HappyLighting)
     · GPS do aparelho                   → velocidade quando não há scanner
   Funciona no Chrome do Android (celular ou multimídia) e no Chrome/Edge do PC.
   O navegador só libera Bluetooth e GPS em endereço seguro: https:// ou localhost.
   Escrito em ES5 + Promise para não quebrar em WebView antigo. */
(function () {
  'use strict';
  var win = window, doc = document, F = win.FAROL;
  if (!F) return;
  function $(id) { return doc.getElementById(id); }

  if (typeof Promise !== 'function') {
    $('c-env').textContent = 'Este navegador é antigo demais para conexões. O painel funciona só com dados simulados.';
    return;
  }

  var secure = win.isSecureContext === true;
  var iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

  // ---------- por que não dá (texto vazio = dá)
  function btWhy() {
    if (!secure) return 'o Bluetooth só é liberado em endereço seguro (https).';
    if (!navigator.bluetooth) return iOS ? 'no iPhone o Bluetooth só funciona pelo app Bluefy.' : 'este navegador não conecta Bluetooth. Use o Chrome.';
    return '';
  }
  function gpsWhy() {
    if (!navigator.geolocation) return 'este aparelho não tem GPS.';
    if (!secure) return 'o GPS só é liberado em endereço seguro (https).';
    return '';
  }

  // ---------- cartões da tela Conectar
  function card(id) {
    var c = $(id), btn = c.querySelector('.btn');
    return {
      btn: btn,
      state: function () { return c.getAttribute('data-state'); },
      set: function (state, status, label, info) {
        c.setAttribute('data-state', state);
        c.querySelector('.cst span').textContent = status;
        if (label) btn.textContent = label;
        c.querySelector('.cval').textContent = info || '';
      }
    };
  }
  var obdCard = card('c-obd'), ledCard = card('c-led'), gpsCard = card('c-gps');

  // ---------- Bluetooth: utilidades
  function writeBytes(ch, bytes) {
    var data = new Uint8Array(bytes), p = ch.properties;
    if (p.writeWithoutResponse && ch.writeValueWithoutResponse) return ch.writeValueWithoutResponse(data);
    if (p.write && ch.writeValueWithResponse) return ch.writeValueWithResponse(data);
    return ch.writeValue(data);
  }
  function textBytes(s) { var a = [], i; for (i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0x7f); return a; }
  function series(list, fn) { // roda fn(item) um depois do outro
    return list.reduce(function (p, x) { return p.then(function () { return fn(x); }); }, Promise.resolve());
  }
  // primeiro serviço da lista que tenha um canal de escrita e um de aviso
  function findPipe(server, services) {
    var i = 0;
    function next() {
      if (i >= services.length) return Promise.reject(new Error('sem-canal'));
      return server.getPrimaryService(services[i++]).then(function (s) {
        return s.getCharacteristics().then(function (chs) {
          var w = null, n = null, k, p;
          for (k = 0; k < chs.length; k++) {
            p = chs[k].properties;
            if (!w && (p.write || p.writeWithoutResponse)) w = chs[k];
            if (!n && (p.notify || p.indicate)) n = chs[k];
          }
          return w && n ? { w: w, n: n } : next();
        });
      }, next);
    }
    return next();
  }

  // =====================================================================
  // SCANNER OBD2 (ELM327 Bluetooth 4.0)
  // =====================================================================
  var OBD_SERVICES = [0xfff0, 0xffe0, 0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
  // consumo estimado pelo fluxo de ar (MAF), para gasolina comum brasileira (com ~27% de etanol)
  var AFR = 13.3, DENSIDADE = 750;
  var obd = { on: false, bye: false, dev: null, w: null, n: null, buf: '', pending: null, queue: null, items: [], k: 0, fails: 0, hasSpeed: false };

  function obdData(e) {
    var v = e.target.value, i, p, r, cb;
    for (i = 0; i < v.byteLength; i++) obd.buf += String.fromCharCode(v.getUint8(i));
    p = obd.buf.indexOf('>');
    if (p < 0) return;
    r = obd.buf.slice(0, p); obd.buf = obd.buf.slice(p + 1);
    cb = obd.pending; obd.pending = null;
    if (cb) cb(r);
  }
  // manda um comando e espera a resposta (o ELM327 termina toda resposta com ">")
  function cmd(s, ms) {
    function run() {
      return new Promise(function (res) {
        var t = setTimeout(function () { obd.pending = null; obd.buf = ''; res(''); }, ms || 1200);
        obd.pending = function (r) { clearTimeout(t); res(r); };
        writeBytes(obd.w, textBytes(s + '\r')).catch(function () { clearTimeout(t); obd.pending = null; res(''); });
      });
    }
    obd.queue = (obd.queue || Promise.resolve()).then(run, run);
    return obd.queue;
  }
  function parse(r, code) { // "410C1AF8" → [0x1A, 0xF8]
    var lines = r.split(/[\r\n]+/), i, s, out, j, b;
    for (i = 0; i < lines.length; i++) {
      s = lines[i].replace(/\s+/g, '').toUpperCase();
      if (s.indexOf('41' + code) !== 0) continue;
      out = [];
      for (j = 4; j + 1 < s.length; j += 2) { b = parseInt(s.substr(j, 2), 16); if (isNaN(b)) break; out.push(b); }
      if (out.length) return out;
    }
    return null;
  }
  function pid(code, key, dec) {
    return {
      key: key, miss: 0, dead: false,
      read: function (d) {
        var self = this;
        return cmd('01' + code).then(function (r) {
          var b = parse(r, code), v = b ? dec(b) : null;
          if (v !== null && isFinite(v)) { d[key] = v; self.miss = 0; }
          else if (++self.miss >= 4) self.dead = true; // o carro não tem esse dado
        });
      }
    };
  }
  function makeItems() {
    return [
      pid('0D', 'speed', function (b) { return b[0]; }),
      pid('0C', 'rpm', function (b) { return b.length > 1 ? (b[0] * 256 + b[1]) / 4 : null; }),
      pid('05', 'temp', function (b) { return b[0] - 40; }),
      pid('04', 'load', function (b) { return b[0] * 100 / 255; }),
      pid('11', 'thr', function (b) { return b[0] * 100 / 255; }),
      pid('10', 'flow', function (b) { return b.length > 1 ? (b[0] * 256 + b[1]) / 100 / AFR / DENSIDADE * 3600 : null; }),
      { key: 'volt', miss: 0, dead: false, read: function (d) {
        var self = this;
        return cmd('ATRV').then(function (r) {
          var m = /(\d{1,2}(?:\.\d{1,2})?)\s*V/i.exec(r);
          if (m) { d.volt = parseFloat(m[1]); self.miss = 0; } else if (++self.miss >= 4) self.dead = true;
        });
      } }
    ];
  }
  // a cada volta: velocidade e rotação sempre, mais um dos outros dados em rodízio
  function cycle() {
    if (!obd.on) return;
    var it = obd.items, d = {}, list = [], i, s, n = it.length - 2;
    if (!it[0].dead) list.push(it[0]);
    if (!it[1].dead) list.push(it[1]);
    for (i = 0; i < n; i++) { s = it[2 + (obd.k++ % n)]; if (!s.dead) { list.push(s); break; } }
    series(list, function (x) { return obd.on ? x.read(d) : null; }).then(function () {
      if (!obd.on) return;
      var any = false, alive = 0, k;
      for (k in d) if (d.hasOwnProperty(k)) any = true;
      for (k = 0; k < it.length; k++) if (!it[k].dead) alive++;
      obd.hasSpeed = !it[0].dead;
      if (any) {
        obd.fails = 0;
        F.feed(d);
        obdCard.set('on', 'Conectado', 'Desconectar', (obd.dev.name || 'Scanner') + ' · ' + alive + ' de ' + it.length + ' dados disponíveis');
      } else if (++obd.fails === 15) {
        obdCard.set('busy', 'Sem resposta do carro', 'Desconectar', 'Confira se a ignição está ligada.');
      }
      setTimeout(cycle, 20);
    });
  }
  function obdStop(info) {
    var was = obd.on;
    obd.on = false; obd.pending = null; obd.queue = null;
    if (was) F.link('obd', false);
    obdCard.set('off', 'Desconectado', 'Conectar scanner', info || '');
  }
  function obdLost() { var bye = obd.bye; obd.bye = false; obdStop(bye ? '' : 'A conexão com o scanner caiu.'); }
  function obdConnect() {
    var why = btWhy();
    if (why) { obdCard.set('err', 'Indisponível', null, 'Neste aparelho ' + why); return; }
    obdCard.set('busy', 'Escolha o scanner na lista', 'Cancelar');
    navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OBD_SERVICES })
      .then(function (dev) {
        obd.dev = dev; obd.bye = false;
        dev.addEventListener('gattserverdisconnected', obdLost);
        obdCard.set('busy', 'Conectando', 'Cancelar', dev.name || '');
        return dev.gatt.connect();
      })
      .then(function (server) { return findPipe(server, OBD_SERVICES); })
      .then(function (pipe) {
        obd.w = pipe.w; obd.n = pipe.n; obd.buf = ''; obd.queue = null;
        obd.n.addEventListener('characteristicvaluechanged', obdData);
        return obd.n.startNotifications();
      })
      .then(function () { obdCard.set('busy', 'Preparando o scanner', 'Cancelar'); return cmd('ATZ', 2500); })
      .then(function () { return series(['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0'], function (c) { return cmd(c); }); })
      .then(function () { obdCard.set('busy', 'Falando com o carro', 'Cancelar', 'Pode levar alguns segundos.'); return cmd('0100', 8000); })
      .then(function (r) {
        if (!parse(r, '00')) throw new Error('sem-carro');
        obd.items = makeItems(); obd.k = 0; obd.fails = 0; obd.on = true;
        F.link('obd', true);
        obdCard.set('on', 'Conectado', 'Desconectar', obd.dev.name || '');
        cycle();
      })
      .catch(function (e) {
        var msg = e && e.name === 'NotFoundError' ? ''
          : e && e.message === 'sem-canal' ? 'Esse aparelho não parece um scanner OBD2 Bluetooth 4.0.'
          : e && e.message === 'sem-carro' ? 'O scanner ligou, mas o carro não respondeu. Ligue a ignição e tente de novo.'
          : 'Não deu para conectar. Chegue mais perto do scanner e tente de novo.';
        obd.bye = true;
        try { if (obd.dev && obd.dev.gatt.connected) obd.dev.gatt.disconnect(); } catch (x) {}
        obdStop(msg);
        if (msg) obdCard.set('err', 'Não conectou', 'Tentar de novo', msg);
      });
  }
  obdCard.btn.onclick = function () {
    var st = obdCard.state();
    if (st === 'on' || st === 'busy') {
      obd.bye = true;
      try { if (obd.dev && obd.dev.gatt.connected) obd.dev.gatt.disconnect(); else obdStop(''); } catch (x) { obdStop(''); }
    } else obdConnect();
  };

  // =====================================================================
  // FITA DE LED BLUETOOTH
  // =====================================================================
  var LED_KINDS = [
    { name: 'ELK-BLEDOM', svc: 0xfff0, ch: 0xfff3, // apps duoCo Strip, Lotus Lantern
      on: [0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef],
      color: function (r, g, b) { return [0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef]; } },
    { name: 'Triones', svc: 0xffd5, ch: 0xffd9, // apps HappyLighting, Triones
      on: [0xcc, 0x23, 0x33],
      color: function (r, g, b) { return [0x56, r, g, b, 0x00, 0xf0, 0xaa]; } }
  ];
  var led = { dev: null, ch: null, kind: null, busy: false, next: null, bye: false };

  function ledFind(server) {
    var i = 0;
    function next() {
      if (i >= LED_KINDS.length) return Promise.reject(new Error('sem-canal'));
      var k = LED_KINDS[i++];
      return server.getPrimaryService(k.svc)
        .then(function (s) { return s.getCharacteristic(k.ch); })
        .then(function (ch) { return { ch: ch, kind: k }; }, next);
    }
    return next();
  }
  // manda só a cor mais recente; se ainda estiver enviando, a anterior é descartada
  function ledPump() {
    if (!led.next || !led.ch) { led.busy = false; return; }
    var b = led.next; led.next = null; led.busy = true;
    writeBytes(led.ch, b).then(ledPump, ledPump);
  }
  function ledSend(b) { led.next = b; if (!led.busy) ledPump(); }
  var sink = {
    setLed: function (r, g, b, pct) { // o brilho vai embutido na cor: funciona em qualquer modelo
      if (!led.kind) return;
      var k = Math.max(0, Math.min(100, pct)) / 100;
      ledSend(led.kind.color(Math.round(r * k), Math.round(g * k), Math.round(b * k)));
    }
  };
  function ledStop(info) {
    var was = !!F.ledSink;
    led.ch = null; led.kind = null; led.next = null;
    F.ledSink = null;
    if (was) F.ledChanged();
    ledCard.set('off', 'Desconectada', 'Conectar LED', info || '');
  }
  function ledLost() { var bye = led.bye; led.bye = false; ledStop(bye ? '' : 'A conexão com a fita caiu.'); }
  function ledConnect() {
    var why = btWhy();
    if (why) { ledCard.set('err', 'Indisponível', null, 'Neste aparelho ' + why); return; }
    ledCard.set('busy', 'Escolha a fita na lista', 'Cancelar');
    var opt = [], i;
    for (i = 0; i < LED_KINDS.length; i++) opt.push(LED_KINDS[i].svc);
    navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: opt })
      .then(function (dev) {
        led.dev = dev; led.bye = false;
        dev.addEventListener('gattserverdisconnected', ledLost);
        ledCard.set('busy', 'Conectando', 'Cancelar', dev.name || '');
        return dev.gatt.connect();
      })
      .then(ledFind)
      .then(function (found) {
        led.ch = found.ch; led.kind = found.kind;
        return writeBytes(led.ch, led.kind.on);
      })
      .then(function () {
        F.ledSink = sink;
        F.ledChanged(); // manda a cor atual da tela Luzes
        ledCard.set('on', 'Conectada', 'Desconectar', (led.dev.name || 'Fita') + ' · modelo ' + led.kind.name);
      })
      .catch(function (e) {
        var msg = e && e.name === 'NotFoundError' ? ''
          : e && e.message === 'sem-canal' ? 'Essa fita usa um modelo que o painel ainda não conhece. Me diga o nome do app dela.'
          : 'Não deu para conectar. Feche o app da fita no celular (ela só aceita uma conexão) e tente de novo.';
        led.bye = true;
        try { if (led.dev && led.dev.gatt.connected) led.dev.gatt.disconnect(); } catch (x) {}
        ledStop(msg);
        if (msg) ledCard.set('err', 'Não conectou', 'Tentar de novo', msg);
      });
  }
  ledCard.btn.onclick = function () {
    var st = ledCard.state();
    if (st === 'on' || st === 'busy') {
      led.bye = true;
      try { if (led.dev && led.dev.gatt.connected) led.dev.gatt.disconnect(); else ledStop(''); } catch (x) { ledStop(''); }
    } else ledConnect();
  };

  // =====================================================================
  // GPS
  // =====================================================================
  var gps = { id: null, last: null, on: false };
  function meters(a, lat, lon) {
    var R = 6371000, r = Math.PI / 180, dLa = (lat - a.lat) * r, dLo = (lon - a.lon) * r;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a.lat * r) * Math.cos(lat * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function gpsPos(p) {
    var c = p.coords, v = c.speed, last = gps.last, dt, kmh;
    if (c.accuracy > 60) { gpsCard.set('busy', 'Sinal fraco', 'Desligar GPS', 'Precisão de ' + Math.round(c.accuracy) + ' m'); return; }
    if ((v === null || isNaN(v)) && last) { dt = (p.timestamp - last.t) / 1000; v = dt > 0 ? meters(last, c.latitude, c.longitude) / dt : 0; }
    gps.last = { lat: c.latitude, lon: c.longitude, t: p.timestamp };
    kmh = v ? v * 3.6 : 0;
    if (kmh < 2) kmh = 0;
    if (!gps.on) { gps.on = true; F.link('gps', true); }
    var useIt = !(obd.on && obd.hasSpeed);
    gpsCard.set('on', 'Ativo', 'Desligar GPS', 'Precisão de ' + Math.round(c.accuracy) + ' m' + (useIt ? '' : ' · o scanner tem prioridade'));
    if (useIt) F.feed({ speed: kmh });
  }
  function gpsStop(info) {
    if (gps.id !== null) navigator.geolocation.clearWatch(gps.id);
    gps.id = null; gps.last = null;
    if (gps.on) { gps.on = false; F.link('gps', false); }
    gpsCard.set('off', 'Desligado', 'Usar GPS', info || '');
  }
  function gpsErr(e) {
    if (e.code === 1) { gpsStop(); gpsCard.set('err', 'Sem permissão', 'Tentar de novo', 'Permita a localização para este site nas configurações do navegador.'); }
    else gpsCard.set('busy', 'Procurando sinal', 'Desligar GPS', 'Em lugar aberto o sinal chega mais rápido.');
  }
  gpsCard.btn.onclick = function () {
    var why = gpsWhy();
    if (gps.id !== null) { gpsStop(); return; }
    if (why) { gpsCard.set('err', 'Indisponível', null, 'Neste aparelho ' + why); return; }
    gpsCard.set('busy', 'Procurando sinal', 'Desligar GPS');
    gps.id = navigator.geolocation.watchPosition(gpsPos, gpsErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  };

  // =====================================================================
  // GUIA POR TIPO DE MULTIMÍDIA
  // =====================================================================
  var GUIDE = {
    android: 'Abra o painel no Chrome da multimídia e toque em ⋮ → Adicionar à tela inicial. Ele vira um app em tela cheia, e o scanner, a fita de LED e o GPS se conectam direto nela.',
    espelho: 'Para centrais MP5 ou que espelham o celular (AutoLink, EasyConnection, Carbit Link, Mirror Link): abra o painel no celular Android e espelhe a tela. O celular faz as conexões; a multimídia só mostra.',
    auto: 'Android Auto e CarPlay não deixam colocar um painel próprio na tela do carro (só música, mapa e mensagens). Use o painel no celular preso no suporte; a música e o mapa continuam no Android Auto ou no CarPlay.',
    nenhuma: 'Sem tela compatível no carro: use um celular ou tablet Android no suporte, com o painel em tela cheia. Um aparelho antigo parado em casa serve.'
  };
  var GKEY = 'farol.tipo';
  function guide(t) {
    var bs = $('g-type').children, i, on;
    if (!GUIDE[t]) t = 'android';
    for (i = 0; i < bs.length; i++) {
      on = bs[i].getAttribute('data-g') === t;
      bs[i].classList.toggle('is-on', on);
      bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    $('g-text').textContent = GUIDE[t] + (iOS && t !== 'auto' ? ' No iPhone, abra o painel pelo app Bluefy para ter Bluetooth.' : '');
    try { localStorage.setItem(GKEY, t); } catch (e) {}
  }
  $('g-type').onclick = function (e) { var t = e.target.getAttribute('data-g'); if (t) guide(t); };
  var saved = null;
  try { saved = localStorage.getItem(GKEY); } catch (e) {}
  guide(saved || 'android');

  // ---------- o que este aparelho consegue
  (function () {
    var b = btWhy(), g = gpsWhy();
    if (!b && !g) $('c-env').textContent = 'Este aparelho consegue conectar o scanner, a fita de LED e o GPS.';
    else if (b && !g) $('c-env').textContent = 'Neste aparelho ' + b + ' O GPS funciona.';
    else $('c-env').textContent = 'Neste aparelho ' + (b || g) + ' O painel continua funcionando com dados simulados.';
    if (b) { obdCard.set('err', 'Indisponível', null, 'Precisa do Chrome em endereço seguro.'); ledCard.set('err', 'Indisponível', null, 'Precisa do Chrome em endereço seguro.'); }
    if (g) gpsCard.set('err', 'Indisponível', null, g.charAt(0).toUpperCase() + g.slice(1));
  })();
})();
