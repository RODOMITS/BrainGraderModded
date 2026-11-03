// Brainrot Grader — Mini App. Без сборки и библиотек: один файл, работает в Telegram.
(() => {
  'use strict';

  const TG = window.Telegram && window.Telegram.WebApp;
  const DEV_ID = new URLSearchParams(location.search).get('dev'); // только для локальной разработки
  const view = document.getElementById('view');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = { me: null, cfg: null, cases: null, timers: [], render: 0, busy: false };

  // ---------- Мелкие помощники ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const COIN = '<img class="coin" src="/img/coin.webp" alt="BG">';
  // Грифоны на заставках: в Хэллоуин-оформлении — праздничные, выключили оформление — снова обычные
  const MASCOT = { gwLeft: '/img/giveaway-griffin.webp', gwRight: '/img/giveaway-griffin.webp', luck: '/img/sticker-luck.webp', pause: '/img/sticker-bg.webp' };
  const MASCOT_HW = { gwLeft: '/img/hw/griffin-witch.webp', gwRight: '/img/hw/griffin-pumpkinseat.webp', luck: '/img/hw/griffin-wizard.webp', pause: '/img/hw/griffin-ghost.webp' };
  const mascot = (k) => (state.cfg?.theme === 'halloween' ? MASCOT_HW : MASCOT)[k];
  const price = (n) => `<span class="price">${COIN}${fmt(n)}</span>`;
  // Картинки брейнротов 512×512, а в списках и лентах они 60–70 px: там берём уменьшенную копию (img/brainrots/s/…),
  // её телефон раскодирует в разы быстрее. Крупно (окно выигрыша, слоты апгрейда) — оригинал
  const itemImgBig = (src) => esc(src || '/img/unknown.svg');
  const itemImg = (src) => esc(src ? String(src).replace(/^\/img\/brainrots\/(?!s\/)/, '/img/brainrots/s/') : '/img/unknown.svg');
  // «OG» нарисовано по пикселям: в пиксельном шрифте O похожа на ноль, а G на шестёрку
  const OG_PATH = 'M1 0h4v1h-4zM8 0h4v1h-4zM0 1h2v1h-2zM4 1h2v1h-2zM7 1h2v1h-2zM11 1h2v1h-2zM0 2h2v1h-2zM4 2h2v1h-2zM7 2h2v1h-2zM0 3h2v1h-2zM4 3h2v1h-2zM7 3h2v1h-2zM10 3h3v1h-3zM0 4h2v1h-2zM4 4h2v1h-2zM7 4h2v1h-2zM11 4h2v1h-2zM0 5h2v1h-2zM4 5h2v1h-2zM7 5h2v1h-2zM11 5h2v1h-2zM1 6h4v1h-4zM8 6h4v1h-4z';
  const ogSvg = (fill = 'currentColor') => `<svg viewBox="0 0 13 7" shape-rendering="crispEdges" aria-hidden="true"><path d="${OG_PATH}" fill="${fill}"/></svg>`;
  const ogTag = (it) => (it?.rarity === 'og' ? `<i class="og-tag" title="OG">${ogSvg()}</i>` : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const newKey = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
  const haptic = (t) => { try { TG?.HapticFeedback?.notificationOccurred(t); } catch {} };
  const tick = () => { try { TG?.HapticFeedback?.selectionChanged(); } catch {} };
  const mmss = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const plural = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
  };
  // Своё окно подтверждения (вместо системного Telegram): одно за раз, повторные нажатия не плодят окна
  let confirmOpen = null;
  const confirmBox = (text, { ok = 'Подтвердить', cancel = 'Отмена' } = {}) => {
    if (confirmOpen) return confirmOpen;
    confirmOpen = new Promise((res) => {
      const el = h(`<div class="confirm-ov" role="dialog" aria-modal="true">
          <div class="confirm-card"><p></p>
            <div class="btn-row"><button class="btn ghost" data-c="no"></button><button class="btn" data-c="yes"></button></div>
          </div></div>`);
      $('p', el).textContent = text;
      $('[data-c=no]', el).textContent = cancel;
      $('[data-c=yes]', el).textContent = ok;
      const done = (v) => {
        removeEventListener('keydown', onKey);
        el.classList.remove('show');
        setTimeout(() => el.remove(), 180);
        confirmOpen = null;
        res(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
      el.addEventListener('click', (e) => { if (e.target === el) done(false); });
      $('[data-c=no]', el).onclick = () => done(false);
      $('[data-c=yes]', el).onclick = () => { tick(); done(true); };
      addEventListener('keydown', onKey);
      document.body.append(el);
      requestAnimationFrame(() => el.classList.add('show'));
      $('[data-c=yes]', el).focus({ preventScroll: true });
    });
    return confirmOpen;
  };
  const every = (ms, fn) => state.timers.push(setInterval(fn, ms));
  const stopTimers = () => { state.timers.forEach(clearInterval); state.timers = []; };
  const newRender = () => ++state.render;

  // ---------- Настройки игрока на этом устройстве: кейсы за раз, быстрый прокрут, звук, режим стримера ----------
  const SM_IDS = ['balance', 'pay', 'prices', 'spin', 'images', 'words'];
  const prefs = (() => {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('bg_prefs') || '{}') || {}; } catch {}
    const v = Number(p.volume);
    const sm = p.sm && typeof p.sm === 'object' ? p.sm : {};
    return {
      count: [1, 3, 5].includes(p.count) ? p.count : 1,
      fast: !!p.fast,
      showAdmin: p.showAdmin !== false,
      modded: p.modded !== false,
      minesEnabled: !!p.minesEnabled,
      minesCount: Number.isInteger(p.minesCount) && p.minesCount>=1 && p.minesCount<=24 ? p.minesCount : 3,
      sound: p.sound !== false,
      volume: Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 60,
      sm: {
        on: !!sm.on,
        hide: Object.fromEntries(SM_IDS.map((k) => [k, sm.hide?.[k] !== false])),
        blur: [1, 2, 3].includes(sm.blur) ? sm.blur : 2,
        hover: sm.hover !== false,
      },
    };
  })();
  const savePrefs = () => { try { localStorage.setItem('bg_prefs', JSON.stringify(prefs)); } catch {} };
  const applyAdminVisibility = () => document.documentElement.classList.toggle('admin-concealed', !(prefs.modded && prefs.showAdmin));
  applyAdminVisibility();

  // ---------- Звуки: синтезируем на лету, без файлов. Мягкие щелчки ленты и короткие аккорды ----------
  const sfx = (() => {
    let ctx = null;
    let master = null;
    let lastTick = 0;
    let out = null;
    // Громкость стоит после компрессора, иначе он «съедает» разницу. 60% = как было, 100% ≈ +5 дБ
    const volGain = () => 1.8 * Math.pow(prefs.volume / 100, 1.15);
    const ensure = () => {
      if (!prefs.sound || prefs.volume <= 0) return null;
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          ctx = new AC();
          master = ctx.createGain();
          master.gain.value = 0.55;
          const comp = ctx.createDynamicsCompressor();
          out = ctx.createGain();
          out.gain.value = volGain();
          // Ограничитель в конце: на максимальной громкости звук не хрипит
          const lim = ctx.createDynamicsCompressor();
          lim.threshold.value = -2;
          lim.knee.value = 0;
          lim.ratio.value = 20;
          lim.attack.value = 0.002;
          lim.release.value = 0.08;
          master.connect(comp).connect(out).connect(lim).connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch { return null; }
    };
    // Нота: синус + немного октавы выше, быстрая атака и плавное затухание
    const note = (freq, at, dur, vol = 0.18, type = 'sine') => {
      const o = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const g = ctx.createGain();
      const g2 = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      o2.type = 'sine';
      o2.frequency.value = freq * 2;
      g2.gain.value = 0.18;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g);
      o2.connect(g2).connect(g);
      g.connect(master);
      o.start(at); o2.start(at);
      o.stop(at + dur + 0.05); o2.stop(at + dur + 0.05);
    };
    // Шум для «вдоха» (кэшируем)
    const noiseCache = {};
    const noiseBuf = (sec) => {
      const key = sec.toFixed(2);
      if (noiseCache[key]) return noiseCache[key];
      const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return (noiseCache[key] = b);
    };
    // Лёгкая реверберация: короткий мягкий «зал», чтобы ноты не звучали сухо. Создаётся один раз
    let verbIn = null;
    const verb = () => {
      if (verbIn) return verbIn;
      const len = Math.floor(ctx.sampleRate * 1.6);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; // приглушаем верха хвоста
          d[i] = lp * Math.pow(1 - i / len, 3.2);
        }
      }
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      verbIn = ctx.createGain();
      verbIn.connect(conv).connect(wet).connect(master);
      return verbIn;
    };
    // Калимба: чистый тон с быстрым «щипком» и долгим мягким затуханием
    const pluck = (f, at, dur, vol) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.004);
      g.gain.exponentialRampToValueAtTime(vol * 0.35, at + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g);
      const o2 = ctx.createOscillator(); // «язычок» — короткая призвучка в начале
      const g2 = ctx.createGain();
      o2.type = 'sine';
      o2.frequency.value = f * 5.95;
      g2.gain.setValueAtTime(0.0001, at);
      g2.gain.exponentialRampToValueAtTime(vol * 0.18, at + 0.002);
      g2.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
      o2.connect(g2).connect(g);
      g.connect(master);
      g.connect(verb());
      o.start(at); o2.start(at);
      o.stop(at + dur + 0.05); o2.stop(at + 0.08);
    };
    // Колокольчик: частотная модуляция с затухающей глубиной — стеклянный, мягкий
    const bell = (f, at, dur, vol) => {
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const mg = ctx.createGain();
      const g = ctx.createGain();
      car.type = 'sine';
      mod.type = 'sine';
      car.frequency.value = f;
      mod.frequency.value = f * 3.5;
      mg.gain.setValueAtTime(f * 0.7, at);
      mg.gain.exponentialRampToValueAtTime(f * 0.01, at + dur * 0.25); // «стекло» только в начале, хвост — чистый тон
      mod.connect(mg).connect(car.frequency);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6000;
      car.connect(lp).connect(g);
      g.connect(master);
      g.connect(verb());
      car.start(at); mod.start(at);
      car.stop(at + dur + 0.05); mod.stop(at + dur + 0.05);
    };
    let noise = null;
    let lastClack = 0;
    let lastClick = 0;
    return {
      unlock: () => ensure(),
      // Нажатие любой кнопки: мягкий короткий «тук» с лёгким звоном. pitch > 1 — выше (включение), < 1 — ниже
      click(pitch = 1) {
        const now = performance.now();
        if (now - lastClick < 45 || !ensure()) return;
        lastClick = now;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(1180 * pitch, t);
        o.frequency.exponentialRampToValueAtTime(760 * pitch, t + 0.06);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.11, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + 0.11);
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.type = 'triangle';
        o2.frequency.value = 2900 * pitch;
        g2.gain.setValueAtTime(0.0001, t);
        g2.gain.exponentialRampToValueAtTime(0.022, t + 0.002);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
        o2.connect(g2).connect(master);
        o2.start(t);
        o2.stop(t + 0.04);
      },
      setVolume() {
        if (out && ctx) out.gain.setTargetAtTime(volGain(), ctx.currentTime, 0.02);
      },
      // Кейсы: щелчок «язычка» колеса фортуны — короткий пластиковый клац и мягкий деревянный стук
      clack() {
        const now = performance.now();
        if (now - lastClack < 32 || !ensure()) return;
        lastClack = now;
        const t = ctx.currentTime;
        if (!noise) {
          noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.03), ctx.sampleRate);
          const d = noise.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
        }
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600 + Math.random() * 600;
        bp.Q.value = 3.5;
        const g = ctx.createGain();
        g.gain.value = 0.32;
        src.connect(bp).connect(g).connect(master);
        src.start(t);
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(430, t);
        o.frequency.exponentialRampToValueAtTime(240, t + 0.04);
        og.gain.setValueAtTime(0.0001, t);
        og.gain.exponentialRampToValueAtTime(0.11, t + 0.002);
        og.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        o.connect(og).connect(master);
        o.start(t);
        o.stop(t + 0.07);
      },
      // Щелчок ленты/стрелки: короткий «ток» с лёгким разбросом высоты
      tick(strength = 1) {
        const now = performance.now();
        if (now - lastTick < 28 || !ensure()) return;
        lastTick = now;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const f = ctx.createBiquadFilter();
        o.type = 'triangle';
        o.frequency.setValueAtTime(1500 * (0.96 + Math.random() * 0.08), t);
        o.frequency.exponentialRampToValueAtTime(700, t + 0.035);
        f.type = 'lowpass';
        f.frequency.value = 3200;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.09 * strength, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
        o.connect(f).connect(g).connect(master);
        o.start(t);
        o.stop(t + 0.06);
      },
      // Стрелка апгрейдера: щелчки заранее «по расписанию» звуковой карты — ровно в те моменты, когда стрелка
      // проходит деления (моменты считаются из той же кривой, по которой крутится стрелка). Не зависит от кадров
      // и нагрузки телефона, поэтому звук всегда совпадает с движением. Возвращает stop() — оборвать звук.
      spinTicks(times, strengths, opts = {}) {
        if (!ensure()) return { stop() {} };
        const bus = ctx.createGain();
        bus.gain.value = 1;
        bus.connect(master);
        const t0 = ctx.currentTime + 0.03;
        // старт: короткий «вжух» — шум, фильтр уходит сверху вниз
        if (opts.whoosh) {
          const len = Math.floor(ctx.sampleRate * 0.7);
          const buf = ctx.createBuffer(1, len, ctx.sampleRate);
          const d = buf.getChannelData(0);
          for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.Q.value = 1.4;
          bp.frequency.setValueAtTime(2400, t0);
          bp.frequency.exponentialRampToValueAtTime(380, t0 + 0.65);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.06);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.68);
          src.connect(bp).connect(g).connect(bus);
          src.start(t0);
          src.stop(t0 + 0.7);
        }
        // стрелка «доехала» и пошла назад на место: мягкий глухой щелчок фиксации
        if (opts.lockAt != null) {
          const t = t0 + opts.lockAt;
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(320, t);
          o.frequency.exponentialRampToValueAtTime(140, t + 0.12);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.13, t + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
          o.connect(g).connect(bus);
          o.start(t);
          o.stop(t + 0.18);
        }
        for (let i = 0; i < times.length; i++) {
          const t = t0 + times[i];
          const st = strengths[i];
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          const f = ctx.createBiquadFilter();
          o.type = 'triangle';
          const base = 1250 + 450 * Math.min(1, st);
          o.frequency.setValueAtTime(base * (0.97 + Math.random() * 0.06), t);
          o.frequency.exponentialRampToValueAtTime(650, t + 0.03);
          f.type = 'lowpass';
          f.frequency.value = 3000;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.1 * st), t + 0.003);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
          o.connect(f).connect(g).connect(bus);
          o.start(t);
          o.stop(t + 0.05);
        }
        return {
          stop() {
            try {
              const now = ctx.currentTime;
              bus.gain.setTargetAtTime(0.0001, now, 0.02);
              setTimeout(() => { try { bus.disconnect(); } catch {} }, 200);
            } catch {}
          },
        };
      },
      // Мистери: «зарядка» — нарастающий гул с мерцанием
      charge(sec = 1) {
        if (!ensure()) return;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        const f = ctx.createBiquadFilter();
        const g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(110, t);
        o.frequency.exponentialRampToValueAtTime(440, t + sec);
        f.type = 'lowpass';
        f.Q.value = 6;
        f.frequency.setValueAtTime(300, t);
        f.frequency.exponentialRampToValueAtTime(2400, t + sec);
        lfo.frequency.setValueAtTime(6, t);
        lfo.frequency.linearRampToValueAtTime(18, t + sec);
        lg.gain.value = 0.035;
        lfo.connect(lg).connect(g.gain);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.07, t + sec * 0.8);
        g.gain.exponentialRampToValueAtTime(0.0001, t + sec + 0.12);
        o.connect(f).connect(g).connect(master);
        o.start(t); lfo.start(t);
        o.stop(t + sec + 0.15); lfo.stop(t + sec + 0.15);
      },
      // Мистери: звон колокольчика при смене картинки, всё выше к концу
      chime(p = 0) {
        if (!ensure()) return;
        const t = ctx.currentTime;
        const base = 880 * Math.pow(2, p * 0.9);
        [1, 2.76].forEach((k, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = base * k;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(i ? 0.025 : 0.07, t + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, t + (i ? 0.12 : 0.3));
          o.connect(g).connect(master);
          o.start(t);
          o.stop(t + 0.35);
        });
      },
      // ---- Новая анимация кейса: свой набор звуков ----
      // Всё в одной тональности (ре мажор, пентатоника — любые ноты звучат вместе без «грязи»),
      // мягкие атаки, без резких верхов, лёгкое «пространство» (реверберация). Громкость низкая — звук не утомляет.
      tok(progress = 0) {
        // Ход ленты: деревянный «тук» калимбы. К концу прокрута тон чуть поднимается — растёт ожидание.
        // Когда лента летит и щелчки идут очень часто, каждый тише — не превращается в жужжание
        const now = performance.now();
        const gap = now - lastClack;
        if (gap < 34 || !ensure()) return;
        lastClack = now;
        const t = ctx.currentTime;
        const dens = Math.min(1, gap / 110); // 0 — сплошной поток, 1 — редкие щелчки в конце
        const f = 587.33 * Math.pow(2, (Math.min(1, progress) * 5) / 12) * (0.995 + Math.random() * 0.01);
        const g = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2600;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.02 + 0.05 * dens, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + 0.08 * dens);
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * 1.04, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.02);
        o.connect(lp).connect(g).connect(master);
        o.start(t);
        o.stop(t + 0.2);
        // «дерево»: очень короткая верхняя призвучка
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.type = 'sine';
        o2.frequency.value = f * 2.98;
        g2.gain.setValueAtTime(0.0001, t);
        g2.gain.exponentialRampToValueAtTime(0.006 + 0.01 * dens, t + 0.004);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.026);
        o2.connect(g2).connect(master);
        o2.start(t);
        o2.stop(t + 0.04);
      },
      // Старт: мягкий «вдох» — воздух поднимается вверх, под ним две ноты (ре → ля) уходят в пространство
      whoosh() {
        if (!ensure()) return;
        const t = ctx.currentTime;
        const len = 0.7;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf(len);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.9;
        bp.frequency.setValueAtTime(300, t);
        bp.frequency.exponentialRampToValueAtTime(2200, t + len);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.3);
        g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        src.connect(bp).connect(g);
        g.connect(master);
        g.connect(verb());
        src.start(t);
        pluck(293.66, t + 0.03, 0.9, 0.06);
        pluck(440, t + 0.15, 1.1, 0.055);
      },
      // Пока лента едет — едва слышный тёплый фон (ре–ля–ре), медленно светлеет и затихает перед остановкой,
      // чтобы остановка прозвучала чисто. Возвращает stop() — для «Пропустить»
      spinPad(sec) {
        if (!ensure() || sec <= 0.8) return { stop() {} };
        const t = ctx.currentTime;
        const end = t + sec;
        const g = ctx.createGain();
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 0.7;
        lp.frequency.setValueAtTime(320, t);
        lp.frequency.exponentialRampToValueAtTime(1100, Math.max(t + 0.5, end - 0.4));
        const oscs = [146.83, 220, 293.66].map((f, i) => {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = f;
          o.detune.value = (i - 1) * 4;
          const og = ctx.createGain();
          og.gain.value = [0.6, 0.35, 0.2][i];
          o.connect(og).connect(lp);
          o.start(t);
          o.stop(end + 0.3);
          return o;
        });
        lp.connect(g);
        g.connect(master);
        g.connect(verb());
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.022, t + 0.7);
        g.gain.setValueAtTime(0.022, Math.max(t + 0.7, end - 1.4));
        g.gain.exponentialRampToValueAtTime(0.0001, Math.max(t + 0.8, end - 0.15));
        return {
          stop() {
            const n = ctx.currentTime;
            g.gain.cancelScheduledValues(n);
            g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), n);
            g.gain.exponentialRampToValueAtTime(0.0001, n + 0.2);
            oscs.forEach((o) => { try { o.stop(n + 0.3); } catch {} });
          },
        };
      },
      // ×3 / ×5: каждая лента встала — нота калимбы, каждая следующая выше по пентатонике: складывается в мелодию
      land(k = 0, rarity = 'common') {
        if (!ensure()) return;
        const t = ctx.currentTime + 0.01;
        const scale = [587.33, 659.25, 739.99, 880, 987.77, 1174.66];
        const f = scale[Math.min(k, scale.length - 1)];
        const rank = Math.max(0, RAR_ORDER.indexOf(rarity));
        pluck(f, t, 1.2, 0.1);
        if (rank >= 2) pluck(f * 1.5, t + 0.06, 1.3, 0.05); // редкий — с квинтой сверху
      },
      // Выпал брейнрот: мягкий «колокольчик». Чем реже, тем длиннее арпеджио, у легендарного — искорка в конце.
      // Обычный — две спокойные ноты, без фанфар
      reveal(rarity = 'common', soft = false) {
        if (!ensure()) return;
        const t = ctx.currentTime + 0.02;
        const rank = Math.max(0, RAR_ORDER.indexOf(rarity));
        const k = soft ? 0.7 : 1;
        const seqs = [
          [587.33, 880],
          [587.33, 739.99, 880],
          [587.33, 739.99, 880, 1174.66],
          [587.33, 739.99, 880, 1174.66, 1479.98],
          [587.33, 739.99, 880, 1174.66, 1479.98, 1760],
        ];
        const seq = seqs[Math.min(rank, seqs.length - 1)];
        seq.forEach((f, i) => bell(f, t + i * (rank >= 2 ? 0.075 : 0.06), 1.4 + i * 0.15, (0.1 - i * 0.008) * k));
        if (rank >= 3) bell(2349.32, t + seq.length * 0.075 + 0.05, 2, 0.035 * k); // искорка
      },
      // Мягкий «пуф» в начале прокрута
      start() {
        if (!ensure()) return;
        const t = ctx.currentTime;
        note(392, t, 0.18, 0.08);
        note(523.25, t + 0.06, 0.22, 0.08);
      },
      // Выпал брейнрот: чем реже, тем выше и длиннее аккорд
      win(rarity = 'common') {
        if (!ensure()) return;
        const t = ctx.currentTime + 0.02;
        const chords = {
          common: [523.25, 659.25],
          rare: [523.25, 659.25, 783.99],
          epic: [587.33, 739.99, 880, 1174.66],
          legendary: [659.25, 830.61, 987.77, 1318.51, 1661.22],
          og: [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98, 2093],
        };
        (chords[rarity] || chords.common).forEach((fq, i) => note(fq, t + i * 0.075, 0.55 + i * 0.08, 0.16));
      },
      // Апгрейд: победа — восходящий аккорд, проигрыш — тихие две ноты вниз
      upWin() {
        if (!ensure()) return;
        const t = ctx.currentTime + 0.02;
        [523.25, 659.25, 783.99, 1046.5].forEach((fq, i) => note(fq, t + i * 0.08, 0.6 + i * 0.1, 0.17));
      },
      // Апгрейд: золото — звенящий арпеджио вверх, на каждом удвоении выше
      gold(level = 0) {
        if (!ensure()) return;
        const t = ctx.currentTime + 0.02;
        const k = Math.pow(2, Math.min(level, 4) / 6);
        [783.99, 987.77, 1174.66, 1567.98, 1975.53, 2349.32].forEach((fq, i) => note(fq * k, t + i * 0.055, 0.7 + i * 0.07, 0.13));
        note(392 * k, t, 1.1, 0.12, 'triangle');
      },
      upLose() {
        if (!ensure()) return;
        const t = ctx.currentTime + 0.02;
        note(392, t, 0.35, 0.12, 'triangle');
        note(311.13, t + 0.14, 0.5, 0.11, 'triangle');
      },
      // OG едет к маркеру: нарастание. Сам звук — в og-sound.js
      ogRise(sec = 3) {
        if (!ensure() || !window.BGOgSound) return null;
        return window.BGOgSound.rise(ctx, master, ctx.currentTime + 0.01, sec);
      },
      // OG выпал: удар, взрыв, аккорд и искры
      ogBoom() {
        if (!ensure() || !window.BGOgSound) return;
        window.BGOgSound.boom(ctx, master, ctx.currentTime + 0.01);
      },
    };
  })();
  // Браузеры разрешают звук только после первого касания
  addEventListener('pointerdown', () => sfx.unlock(), { once: true, capture: true });
  // Звук нажатия на всё, что нажимается: кнопки, ссылки, карточки, переключатели
  const CLICKABLE = 'button, a[href], [role="button"], [role="switch"], label.chip, select';
  addEventListener('click', (e) => {
    const el = e.target.closest?.(CLICKABLE);
    if (!el || el.disabled || el.closest('[data-nosnd]')) return;
    const sw = el.matches('[role="switch"], .tgl');
    const wasOn = sw && (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true');
    if (prefs.sound) sfx.click(sw ? (wasOn ? 0.8 : 1.25) : 1);
    // включили звук этим нажатием — подтверждаем щелчком уже после включения
    else setTimeout(() => prefs.sound && sfx.click(1.25), 0);
  }, true);
  const SOUND_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
  const SOUND_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 6M22 9l-5 6"/></svg>';
  const SKIP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 5l9 7-9 7zM13 5l9 7-9 7z"/></svg>';
  const FAST_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';
  // Кнопки «Быстро» и «Звук» — одинаковые на кейсе и в апгрейдере
  function speedSoundHtml() {
    return `<button class="tgl ${prefs.fast ? 'on' : ''}" id="tFast" aria-pressed="${prefs.fast}" title="Быстрый прокрут">${FAST_ICON}<span>Быстро</span></button>
      <button class="tgl icon ${prefs.sound ? 'on' : ''}" id="tSound" aria-pressed="${prefs.sound}" aria-label="Звук">${prefs.sound ? SOUND_ON : SOUND_OFF}</button>`;
  }
  function bindSpeedSound(root) {
    $('#tFast', root).onclick = (e) => {
      prefs.fast = !prefs.fast;
      savePrefs();
      e.currentTarget.classList.toggle('on', prefs.fast);
      e.currentTarget.setAttribute('aria-pressed', prefs.fast);
      tick();
    };
    $('#tSound', root).onclick = (e) => {
      prefs.sound = !prefs.sound;
      savePrefs();
      const b = e.currentTarget;
      b.classList.toggle('on', prefs.sound);
      b.setAttribute('aria-pressed', prefs.sound);
      b.innerHTML = prefs.sound ? SOUND_ON : SOUND_OFF;
      if (prefs.sound) sfx.tick();
    };
  }

  // Если «Быстро»/«Звук» поменяли в настройках — обновляем кнопки на открытой странице
  function syncSpeedSound() {
    const f = $('#tFast');
    if (f) { f.classList.toggle('on', prefs.fast); f.setAttribute('aria-pressed', prefs.fast); }
    const b = $('#tSound');
    if (b) { b.classList.toggle('on', prefs.sound); b.setAttribute('aria-pressed', prefs.sound); b.innerHTML = prefs.sound ? SOUND_ON : SOUND_OFF; }
  }

  // ---------- Режим стримера: размываем то, к чему придирается модерация эфиров ----------
  // Каждая группа — список CSS-селекторов. Новый блок на сайте = добавить его селектор в нужную группу.
  const SM_CATS = [
    {
      id: 'balance',
      title: 'Баланс и доход',
      desc: 'Баланс в шапке и в профиле, реферальный доход и статистика профиля.',
      sel: ['#balance', '.bal-big', '.stats .stat b', '.ref-income-sum'],
    },
    {
      id: 'pay',
      title: 'Пополнение и вывод',
      desc: 'Кнопки пополнения и вывода размыты и не нажимаются, чтобы случайно не открыть их в эфире. История выводов тоже скрыта.',
      sel: ['#topup', '#pTopup', '#promoUse', '[data-a="withdraw"]', '#wdHistory', '.wd-layer'],
      block: ['#topup', '#pTopup', '#promoUse', '[data-a="withdraw"]'],
    },
    {
      id: 'prices',
      title: 'Цены и суммы',
      desc: 'Стоимость кейсов и брейнротов, «Топ-дроп дня», итог выпадения и суммы в пополнении.',
      sel: ['.price', '.td-price', '.total b', '#partnerBox .line .muted'],
    },
    {
      id: 'spin',
      title: 'Прокрутка и результат',
      desc: 'Лента открытия кейса, круг апгрейдера, мистери и окно с тем, что выпало. Самый узнаваемый кадр.',
      sel: ['.roulette', '.result-row', '.result-total', '.ring-wrap', '.mys-stage', '.mys-cap'],
    },
    {
      id: 'images',
      title: 'Картинки',
      desc: 'Кейсы и брейнроты чуть размыты: понятно, что на экране, но без витрины.',
      sel: ['#view img:not(.coin):not(.logo):not(.ava-img)', '.sheet img:not(.coin)'],
      half: true,
    },
    {
      id: 'words',
      title: 'Слова',
      desc: '«Кейс», «вывод», «пополнение», «апгрейд», «выигрыш», «дроп» и похожие — везде в тексте сайта.',
      sel: ['.smw'],
    },
  ];
  const SM_BLUR = [0, 4, 7, 11];
  // «Азартные» слова: русские основы и английские варианты, с любыми окончаниями
  const SM_WORDS = /(?<![\p{L}\p{N}])(?:кейс|ставк|выв(?:од|ед|ест|ел)|депозит|пополн|апгрейд|джекпот|казино|выигр|выйгр|проигр|рулетк|дроп|прокрут|крутк|шанс|лутбокс|cases?|upgrade|deposit|withdraw|jackpot|casino|drops?)[\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)*/giu;
  const SM_SKIP = 'script,style,textarea,input,select,option,svg,.smw,[data-sm-skip]';

  const smWords = (() => {
    let obs = null;
    const wrap = (node) => {
      const t = node.nodeValue;
      if (!t || t.length < 3) return;
      SM_WORDS.lastIndex = 0;
      if (!SM_WORDS.test(t)) return;
      const parent = node.parentElement;
      if (!parent || parent.closest(SM_SKIP)) return;
      SM_WORDS.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = SM_WORDS.exec(t))) {
        if (m.index > last) frag.append(t.slice(last, m.index));
        const w = document.createElement('span');
        w.className = 'smw';
        w.textContent = m[0];
        frag.append(w);
        last = m.index + m[0].length;
      }
      if (last < t.length) frag.append(t.slice(last));
      node.replaceWith(frag);
    };
    const scan = (root) => {
      if (root.nodeType === 3) return wrap(root);
      if (root.nodeType !== 1 || root.closest(SM_SKIP)) return;
      const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const list = [];
      while (it.nextNode()) list.push(it.currentNode);
      list.forEach(wrap);
    };
    return {
      start() {
        if (obs) return;
        scan(document.body);
        // Срабатывает до отрисовки кадра, поэтому новое слово не успевает мелькнуть
        obs = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type === 'characterData') scan(m.target);
            else m.addedNodes.forEach(scan);
          }
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      },
      stop() {
        obs?.disconnect();
        obs = null;
        $$('.smw').forEach((w) => {
          const p = w.parentNode;
          w.replaceWith(w.textContent);
          p?.normalize();
        });
      },
    };
  })();

  const smStyle = document.createElement('style');
  document.head.append(smStyle);
  const smHidden = (id) => prefs.sm.on && prefs.sm.hide[id];
  function applyStreamer() {
    const sm = prefs.sm;
    let css = '';
    if (sm.on) {
      const b = SM_BLUR[sm.blur];
      for (const c of SM_CATS) {
        if (!sm.hide[c.id]) continue;
        const sel = c.sel.join(',');
        css += `${sel}{filter:blur(${c.half ? b / 2 : b}px)!important;transition:filter .25s}`;
        if (c.id === 'words') css += '.smw{display:inline-block}';
        if (c.block) css += `${c.block.join(',')}{pointer-events:none!important;user-select:none}`;
        if (sm.hover) css += `@media (hover:hover){${c.sel.map((x) => x + ':hover').join(',')}{filter:none!important}}`;
      }
    }
    smStyle.textContent = css;
    document.body.classList.toggle('streamer', sm.on);
    if (sm.on && sm.hide.words) smWords.start();
    else smWords.stop();
  }
  // Пополнение/вывод, открытые не кнопкой (например, «Открыть» без денег), — тоже не открываем
  function payBlocked() {
    if (!smHidden('pay')) return false;
    toast('Пополнение и вывод скрыты режимом стримера. Выключить — в настройках', 'err', 3000);
    return true;
  }

  // ---------- Блокировка выхода, пока крутится кейс или апгрейд ----------
  let lastLockToast = 0;
  function lockNav(on) {
    state.locked = on;
    document.body.classList.toggle('locked', on);
    try {
      if (on) { TG?.enableClosingConfirmation?.(); TG?.BackButton?.hide(); }
      else { TG?.disableClosingConfirmation?.(); if ((location.hash || '#/') !== '#/') TG?.BackButton?.show(); }
    } catch {}
  }
  function lockedNotice() {
    if (Date.now() - lastLockToast < 1500) return;
    lastLockToast = Date.now();
    tick();
    toast('Дождись, пока закончится прокрутка', 'err', 2000);
  }
  // Клики по ссылкам, «+», меню и аватарке не срабатывают, пока идёт прокрутка
  document.addEventListener('click', (e) => {
    if (!state.locked) return;
    if (e.target.closest('a[href], #topup, #avatar, #menuBtn, .back')) {
      e.preventDefault();
      e.stopPropagation();
      lockedNotice();
    }
  }, true);
  const stale = (t) => t !== state.render;

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'X-Play-Session': window.playSession };
    if (TG?.initData) headers.authorization = 'tma ' + TG.initData;
    else if (DEV_ID) headers.authorization = 'dev ' + DEV_ID;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('Нет связи с сервером, проверь интернет');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'site_closed') showClosed(data.mode);
      const e = new Error(data.message || `Ошибка ${res.status}`);
      e.code = data.error;
      e.data = data;
      throw e;
    }
    return data;
  }

  // ---------- Технический перерыв / в разработке ----------
  const CLOSED = {
    maintenance: { title: 'Технический перерыв', text: 'Обновляем Brainrot Grader. Баланс и брейнроты в сохранности. Загляни через несколько минут.' },
    development: { title: 'Сейчас в разработке', text: 'Brainrot Grader скоро откроется. Следи за новостями в нашем канале — запуск совсем скоро.' },
  };
  function showClosed(mode) {
    const c = CLOSED[mode] || CLOSED.maintenance;
    if ($('#closed')) return;
    document.body.append(h(`
      <div class="closed" id="closed">
        <img src="/img/logo.svg?v=3" alt="Brainrot Grader">
        <h1><span class="closed-dot"></span>${esc(c.title)}</h1>
        <p>${esc(c.text)}</p>
        <button class="btn" onclick="location.reload()">Обновить</button>
      </div>`));
  }
  function adminModeStrip() {
    if (!state.me?.siteMode || state.me.siteMode === 'open') return;
    const c = CLOSED[state.me.siteMode];
    const title = esc(c ? c.title : state.me.siteMode);
    if (state.me.isAdmin) document.body.prepend(h(`<div class="mode-strip">Режим «${title}»: игроки не могут зайти, ты видишь сайт как админ</div>`));
    else if (state.me.isTester) document.body.prepend(h(`<div class="mode-strip tester">🧪 Ты тестер. ${title} — обычные игроки сейчас зайти не могут</div>`));
  }

  // ---------- Уведомления сверху: зелёные/красные, пропадают через 6 секунд или по нажатию ----------
  function toast(text, type = 'ok', ms = 6000) {
    const el = h(`<div class="toast ${type === 'err' ? 'err' : ''}" role="status"></div>`);
    el.textContent = text;
    $('#toasts').append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    const close = () => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    };
    el.addEventListener('click', close);
    setTimeout(close, ms);
  }
  const fail = (e) => {
    haptic('error');
    toast(e.message || String(e), 'err');
  };

  // ---------- Нижняя шторка ----------
  let sheet = null;
  function openSheet(title, body, { onClose } = {}) {
    closeSheet();
    const ov = h('<div class="overlay"></div>');
    const sh = h('<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-head"><h3></h3><button class="x" aria-label="Закрыть">×</button></div></div>');
    $('h3', sh).textContent = title;
    sh.append(body);
    document.body.append(ov, sh);
    requestAnimationFrame(() => requestAnimationFrame(() => { ov.classList.add('show'); sh.classList.add('show'); }));
    const close = () => {
      if (sheet?.sh !== sh) return;
      sheet = null;
      ov.classList.remove('show');
      sh.classList.remove('show');
      setTimeout(() => { ov.remove(); sh.remove(); }, 280);
      onClose?.();
    };
    ov.addEventListener('click', close);
    $('.x', sh).addEventListener('click', close);
    sheet = { sh, close, setTitle: (t) => ($('h3', sh).textContent = t) };
    return sheet;
  }
  function closeSheet() {
    sheet?.close();
  }

  // ---------- Шапка ----------
  function setBalance(n) {
    if (state.me) state.me.balance = n;
    $('#balance').textContent = fmt(n);
  }
  async function refreshMe() {
    state.me = await api('/api/me');
    setBalance(state.me.balance);
    return state.me;
  }
  // Аватарка: сначала копия с нашего сервера (/api/avatar), потом ссылка из Telegram.
  // Картинку показываем только если она реально загрузилась, иначе — первая буква имени.
  let avatarPromise = null;
  function tryImage(src) {
    return new Promise((done) => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.onload = () => done(img.naturalWidth > 0 ? src : null);
      img.onerror = () => done(null);
      img.src = src;
    });
  }
  function loadAvatar() {
    avatarPromise ||= (async () => {
      // Telegram provides this optional URL in the server-verified initData.
      const photo = state.me?.photoUrl;
      if (photo && /^https:\/\//.test(photo)) {
        const src = await tryImage(photo);
        if (src) return src;
      }
      try {
        const headers = TG?.initData ? { authorization: 'tma ' + TG.initData } : DEV_ID ? { authorization: 'dev ' + DEV_ID } : {};
        const r = await fetch('/api/avatar', { headers });
        if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
          const src = await tryImage(URL.createObjectURL(await r.blob()));
          if (src) return src;
        }
      } catch {}
      const url = state.me?.photoUrl;
      if (url && /^https:\/\//.test(url)) return tryImage(url);
      return null;
    })();
    return avatarPromise;
  }
  async function fillAvatar(el) {
    if (!el) return;
    el.textContent = (state.me?.firstName || state.me?.username || '?').slice(0, 1).toUpperCase();
    const src = await loadAvatar();
    if (!src || !el.isConnected) return;
    const img = document.createElement('img');
    img.className = 'ava-img';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    el.replaceChildren(img);
  }

  // ---------- Меню (кнопка ≡ слева сверху) ----------
  // Новый режим = одна строка в MENU + его страница в route().
  // badge: 'NEW' — жёлтая метка; show: () => true/false — показывать ли пункт (например, только админам).
  const ICON = {
    cases: '<path d="M3 9h18v11H3z"/><path d="M5 9V5h14v4"/><path d="M10 13h4"/>',
    upgrade: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8"/><path d="m8.5 11.5 3.5-3.5 3.5 3.5"/>',
    gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M5 12v8h14v-8"/><path d="M12 8v12"/><path d="M12 8c-1.5-3-5-4-6-2s2 2.6 6 2c4 .6 7 0 6-2s-4.5-1-6 2z"/>',
    mines: '<path d="M8 3h8l5 7-9 11L3 10zM3 10h18M8 3l4 18 4-18"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.3"/><circle cx="16" cy="8" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="8" cy="16" r="1.3"/><circle cx="16" cy="16" r="1.3"/>',
    mystery: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.6.3-1 .8-1 1.5v.6"/><path d="M12 16.8h.01"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/>',
    faq: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>',
    friends: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.2 14.9c1.6.8 2.7 2.4 3.3 5.1"/>',
  };
  const MENU = [
    {
      group: 'Игры',
      items: [
        { id: 'home', label: 'Кейсы', href: '#/', icon: 'cases' },
        { id: 'upgrade', label: 'Апгрейдер', href: '#/upgrade', icon: 'upgrade' },
        { id: 'mystery', label: 'Мистери', href: '#/mystery', icon: 'mystery', show: () => state.cfg?.mystery?.enabled !== false },
        { id: 'dice', label: 'Колор Дайс', href: '#/dice', icon: 'dice', show: () => !!state.cfg?.dice?.enabled },
        { id: 'mines', label: 'Мины', href: '#/mines', icon: 'mines', badge: 'NEW', show: () => prefs.modded && prefs.minesEnabled },
        { id: 'giveaways', label: 'Розыгрыши', href: '#/giveaways', icon: 'gift', badge: 'NEW' },
      ],
    },
    {
      group: null,
      items: [
        { id: 'admin', label: 'Админка', href: '/admin', icon: 'settings' },
        { id: 'referrals', label: 'Рефералы', href: '#/referrals', icon: 'friends' },
        { id: 'faq', label: 'Вопросы', href: '#/faq', icon: 'faq', small: true },
        { id: 'settings', label: 'Настройки', icon: 'settings', action: () => openSettings() },
      ],
    },
  ];
  const svgIcon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;
  // Какой пункт меню подсвечен на текущей странице
  function currentSection() {
    const path = (location.hash.slice(1) || '/').split('?')[0];
    if (path.startsWith('/upgrade')) return 'upgrade';
    if (path.startsWith('/mystery')) return 'mystery';
    if (path.startsWith('/dice')) return 'dice';
    if (path.startsWith('/mines')) return 'mines';
    if (path.startsWith('/giveaways')) return 'giveaways';
    if (path.startsWith('/referrals') || path.startsWith('/partner')) return 'referrals';
    if (path.startsWith('/profile')) return 'profile';
    if (path.startsWith('/faq')) return 'faq';
    return 'home';
  }

  // ---------- Компьютер: разделы прямо в шапке ----------
  function drawTopnav() {
    const nav = $('#topnav');
    if (!nav) return;
    const cur = currentSection();
    nav.innerHTML = MENU.flatMap((g) => g.items)
      .filter((it) => it.href && (!it.show || it.show()))
      .map((it) => `<a class="tn-item${it.small ? ' tn-small' : ''}" href="${it.href}" title="${esc(it.label)}" ${it.id === cur ? 'aria-current="page"' : ''}>${svgIcon(it.icon)}<span>${esc(it.label)}</span>${it.badge ? `<i class="tn-new">${esc(it.badge)}</i>` : ''}</a>`)
      .join('');
  }

  // ---------- Компьютер: живая лента слева (топ-дроп дня и последние дропы) ----------
  const WIDE = matchMedia('(min-width: 1200px)');
  const live = { busy: false, ids: new Set() };
  const liveCard = (d) => (rememberDrop(d), '') + `
    <div class="lb-drop swap rar-${esc(d.rarity)}" data-drop="${esc(d.id)}" data-id="${esc(d.id)}" role="link" tabindex="0">
      ${ogTag(d)}<img src="${itemImg(d.image)}" alt=""><b>${esc(d.name)}</b>${price(d.price)}${srcLayer(d)}
    </div>`;
  function drawLive(home, animate) {
    const bar = $('#livebar');
    if (!bar) return;
    if (!bar.firstChild) bar.innerHTML = '<div class="lb-head"><span class="live"><i></i>LIVE</span></div><div class="lb-top" id="lbTop"></div><div class="lb-list" id="lbList"></div>';
    const top = home.top;
    $('#lbTop', bar).innerHTML = top
      ? (rememberDrop(top), '') + `<div class="lb-top-in swap rar-${esc(top.rarity)}" data-drop="${esc(top.id)}" role="link" tabindex="0"><span class="td-label">🏆 Топ-дроп дня</span>${ogTag(top)}<img src="${itemImg(top.image)}" alt=""><b>${esc(top.name)}</b><span class="td-price">${COIN}${fmt(top.price)}</span>${srcLayer(top)}</div>`
      : `<div class="lb-top-in"><span class="td-label">🏆 Топ-дроп дня</span><div class="lb-empty">${HOURGLASS}<span class="muted">Сегодня ещё пусто</span></div></div>`;
    const list = $('#lbList', bar);
    const fresh = home.drops.filter((d) => !live.ids.has(d.id));
    if (!animate || !live.ids.size) list.innerHTML = home.drops.map(liveCard).join('');
    else if (fresh.length) {
      list.insertAdjacentHTML('afterbegin', fresh.map(liveCard).join(''));
      $$('.lb-drop', list).slice(0, fresh.length).forEach((el) => el.classList.add('new'));
      $$('.lb-drop', list).slice(home.drops.length).forEach((el) => el.remove());
    }
    live.ids = new Set(home.drops.map((d) => d.id));
  }
  async function liveTick(animate = true) {
    if (!WIDE.matches || document.hidden || live.busy || !state.me || state.locked) return;
    live.busy = true;
    try { drawLive(await api('/api/home'), animate); } catch {}
    live.busy = false;
  }
  function setupDesktop() {
    $('#setBtn').onclick = () => openSettings();
    // высота шапки — чтобы лента слева начиналась сразу под ней
    const bar = $('.topbar');
    const setH = () => document.documentElement.style.setProperty('--hdr', `${bar.offsetTop + bar.offsetHeight}px`);
    setH();
    if (window.ResizeObserver) new ResizeObserver(setH).observe(bar);
    addEventListener('resize', setH);
    liveTick(false);
    setInterval(() => liveTick(true), 10000);
    WIDE.addEventListener?.('change', () => liveTick(false));
    document.addEventListener('visibilitychange', () => !document.hidden && liveTick(true));
  }

  let menu = null;
  function openMenu() {
    if (menu || state.locked) return;
    closeSheet();
    const cur = currentSection();
    const ov = h('<div class="menu-ov"></div>');
    const el = h(`
      <aside class="menu" role="dialog" aria-modal="true" aria-label="Меню">
        <div class="menu-top">
          <img class="logo" src="/img/logo.svg?v=3" alt="Brainrot Grader">
          <button class="x" id="menuX" aria-label="Закрыть меню">×</button>
        </div>
        <nav class="menu-list">
          ${MENU.map((g) => {
            const items = g.items.filter((it) => !it.show || it.show());
            if (!items.length) return '';
            return (g.group ? `<div class="menu-group">${esc(g.group)}</div>` : '<div class="menu-sep"></div>') + items.map((it) => {
              const inner = `${svgIcon(it.icon)}<span>${esc(it.label)}</span>${it.badge ? `<span class="menu-new">${esc(it.badge)}</span>` : ''}`;
              const curAttr = it.id === cur ? ' aria-current="page"' : '';
              return it.href
                ? `<a class="menu-item${it.small ? ' menu-small' : ''}" href="${it.href}" data-id="${it.id}"${curAttr}>${inner}</a>`
                : `<button class="menu-item" data-id="${it.id}">${inner}</button>`;
            }).join('');
          }).join('')}
        </nav>
      </aside>`);
    document.body.append(ov, el);
    requestAnimationFrame(() => requestAnimationFrame(() => { ov.classList.add('show'); el.classList.add('show'); }));
    $('#menuBtn').setAttribute('aria-expanded', 'true');
    menu = { ov, el };
    try { TG?.BackButton?.show(); } catch {}
    tick();

    ov.addEventListener('click', closeMenu);
    $('#menuX', el).onclick = closeMenu;
    $$('.menu-item', el).forEach((a) => a.addEventListener('click', (e) => {
      const it = MENU.flatMap((g) => g.items).find((x) => x.id === a.dataset.id);
      if (it?.action) { e.preventDefault(); closeMenu(); return it.action(); }
      // Нажали на страницу, где уже стоим — просто закрываем меню
      if (a.getAttribute('href') === (location.hash || '#/')) e.preventDefault();
      closeMenu();
    }));
    // Свайп влево закрывает меню
    let x0 = null;
    let dx = 0;
    el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; dx = 0; el.style.transition = 'none'; }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (x0 === null) return;
      dx = Math.min(0, e.touches[0].clientX - x0);
      el.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    el.addEventListener('touchend', () => {
      el.style.transition = '';
      el.style.transform = '';
      if (dx < -70) closeMenu();
      x0 = null;
    });
    $('#menuX', el).focus({ preventScroll: true });
  }
  function closeMenu() {
    if (!menu) return;
    const { ov, el } = menu;
    menu = null;
    ov.classList.remove('show');
    el.classList.remove('show');
    setTimeout(() => { ov.remove(); el.remove(); }, 280);
    $('#menuBtn').setAttribute('aria-expanded', 'false');
    try { if ((location.hash || '#/') === '#/') TG?.BackButton?.hide(); } catch {}
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu) closeMenu(); });

  // ---------- Настройки (меню ≡ и «⋮» Telegram) ----------
  const sw = (key, on, label) => `<button class="sw ${on ? 'on' : ''}" data-k="${key}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"><i></i></button>`;
  function openSettings() {
    if (state.locked) return lockedNotice();
    closeMenu();
    const sm = prefs.sm;
    const body = h(`
      <div class="settings" data-sm-skip>
        <section class="set-group">
          <div class="set-row">
            <div class="grow"><b>Звук</b><p>Нажатия кнопок, щелчки ленты, выпадения и апгрейд. Запоминается на этом устройстве.</p></div>
            ${sw('sound', prefs.sound, 'Звук')}
          </div>
          <div class="set-vol ${prefs.sound ? '' : 'off'}">
            <span>Громкость</span>
            <input type="range" id="setVol" min="0" max="100" step="5" value="${prefs.volume}" aria-label="Громкость">
            <b id="setVolV">${prefs.volume}%</b>
          </div>
          <div class="set-row">
            <div class="grow"><b>Быстрая прокрутка</b><p>Кейсы и апгрейдер крутятся в несколько раз быстрее.</p></div>
            ${sw('fast', prefs.fast, 'Быстрая прокрутка')}
          </div>
        </section>

        <section class="set-group">
          <div class="set-row main">
            <div class="grow"><b>Режим стримера</b><p>Для эфиров в TikTok и других стримов. Размывает деньги, цены, прокрутку и «азартные» слова — то, за что модерация чаще всего режет эфир. Что именно скрывать, выбери ниже.</p></div>
            ${sw('sm', sm.on, 'Режим стримера')}
          </div>
          <div class="set-sub ${sm.on ? '' : 'off'}" id="smSub">
            <div class="set-cap">Что скрывать</div>
            ${SM_CATS.map((c) => `
              <div class="set-row">
                <div class="grow"><b>${esc(c.title)}</b><p>${esc(c.desc)}</p></div>
                ${sw('hide:' + c.id, sm.hide[c.id], c.title)}
              </div>`).join('')}
            <div class="set-row col">
              <div class="grow"><b>Сила размытия</b><p>Картинки всегда размываются в два раза мягче, чтобы на экране не было пустых пятен.</p></div>
              <div class="seg3" role="group" aria-label="Сила размытия">
                ${['Слабо', 'Средне', 'Сильно'].map((t, i) => `<button data-blur="${i + 1}" class="${sm.blur === i + 1 ? 'on' : ''}">${t}</button>`).join('')}
              </div>
            </div>
            <div class="set-row">
              <div class="grow"><b>Проявлять под мышкой</b><p>Только на компьютере: наведи курсор на размытое, и оно станет чётким. Если курсор не захватывается в трансляцию, зрители этого не увидят.</p></div>
              ${sw('hover', sm.hover, 'Проявлять под мышкой')}
            </div>
          </div>
        </section>
        <section class="set-group modded-settings ${prefs.modded ? '' : 'modded-off'}" id="moddedSettings">
          <div class="set-row main modded-main">
            <div class="grow"><b>Моддед</b><p>Дополнительные возможности</p></div>
            ${sw('modded', prefs.modded, 'Моддед')}
          </div>
          <div class="set-sub modded-sub">
            <div class="set-row"><div class="grow"><b>Админ-панель</b><p>Показывать кнопку админки</p></div>${sw('showAdmin', prefs.showAdmin, 'Админ-панель')}</div>
            <div class="set-row"><div class="grow"><b>Мины</b><p>Поле с алмазами и минами, ставка брейнротом</p></div>${sw('minesEnabled', prefs.minesEnabled, 'Мины')}</div>
          </div>
        </section>
      </div>`);
    openSheet('Настройки', body);
    const save = () => {
      savePrefs(); applyStreamer(); syncSpeedSound(); applyAdminVisibility(); drawTopnav();
      $('#moddedSettings',body).classList.toggle('modded-off',!prefs.modded);
      if (!(prefs.modded && prefs.minesEnabled) && location.hash.startsWith('#/mines')) location.hash='#/';
    };
    $$('.sw', body).forEach((b) => (b.onclick = () => {
      const k = b.dataset.k;
      let on;
      if (k === 'sound') { on = prefs.sound = !prefs.sound; $('.set-vol', body).classList.toggle('off', !on); }
      else if (k === 'fast') on = prefs.fast = !prefs.fast;
      else if (k === 'showAdmin') on = prefs.showAdmin = !prefs.showAdmin;
      else if (k === 'modded') on = prefs.modded = !prefs.modded;
      else if (k === 'minesEnabled') on = prefs.minesEnabled = !prefs.minesEnabled;
      else if (k === 'sm') { on = sm.on = !sm.on; $('#smSub', body).classList.toggle('off', !on); }
      else if (k === 'hover') on = sm.hover = !sm.hover;
      else if (k.startsWith('hide:')) { const id = k.slice(5); on = sm.hide[id] = !sm.hide[id]; }
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
      tick();
      save();
      if (k === 'sound' && on) sfx.tick();
    }));
    const vol = $('#setVol', body);
    vol.oninput = () => {
      prefs.volume = Number(vol.value);
      $('#setVolV', body).textContent = `${prefs.volume}%`;
      sfx.setVolume();
    };
    vol.onchange = () => {
      savePrefs();
      if (prefs.sound) { sfx.unlock(); sfx.setVolume(); sfx.clack(); }
    };
    $$('[data-blur]', body).forEach((b) => (b.onclick = () => {
      sm.blur = Number(b.dataset.blur);
      $$('[data-blur]', body).forEach((x) => x.classList.toggle('on', x === b));
      tick();
      save();
    }));
  }

  // ---------- Маршруты ----------
  function route() {
    if (state.locked) {
      history.replaceState(null, '', state.currentHash || '#/');
      lockedNotice();
      return;
    }
    state.currentHash = location.hash || '#/';
    const hash = location.hash.slice(1) || '/';
    const [path, qs] = hash.split('?');
    closeSheet();
    closeMenu();
    stopTimers();
    newRender();
    const tab = path.startsWith('/upgrade') ? 'upgrade' : path.startsWith('/mystery') ? 'mystery' : path.startsWith('/dice') ? 'dice' : path.startsWith('/mines') ? 'mines' : path.startsWith('/giveaways') ? 'giveaways' : path.startsWith('/profile') ? 'profile' : path.startsWith('/referrals') ? 'referrals' : path.startsWith('/partner') ? 'partner' : path.startsWith('/faq') ? 'faq' : 'home';
    const m = /^\/case\/(\d+)$/.exec(path);
    view.dataset.page = m ? 'case' : tab; // для раскладки на компьютере
    drawTopnav();
    // Нижней панели нет: на всех страницах, кроме главной, работает кнопка «Назад» Telegram
    try {
      if (m || tab !== 'home') TG?.BackButton?.show();
      else TG?.BackButton?.hide();
    } catch {}
    window.scrollTo(0, 0);
    if (m) return renderCase(Number(m[1]));
    if (tab === 'upgrade') return renderUpgrade(new URLSearchParams(qs || ''));
    if (tab === 'mystery') return renderMystery(new URLSearchParams(qs || ''));
    if (tab === 'dice') return renderDice();
    if (tab === 'mines') return renderMines();
    if (tab === 'giveaways') return renderGiveaways();
    if (tab === 'profile') return renderProfile();
    if (tab === 'referrals') return renderReferrals();
    if (tab === 'partner') { setTimeout(sendDiag, 2500); return renderPartner(); }
    if (tab === 'faq') return renderFaq(new URLSearchParams(qs || ''));
    return renderHome();
  }

  // =====================================================================
  //                               ГЛАВНАЯ
  // =====================================================================
  // Песочные часы в пиксельном стиле (рисуем сами, без картинок)
  const HOURGLASS = `<svg class="hourglass" viewBox="0 0 12 20" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="0" y="0" width="12" height="2" fill="#8a5a24"/><rect x="0" y="0" width="12" height="1" fill="#c88a3a"/>
    <rect x="0" y="18" width="12" height="2" fill="#8a5a24"/><rect x="0" y="18" width="12" height="1" fill="#c88a3a"/>
    <rect x="1" y="2" width="1" height="16" fill="#6b4419"/><rect x="10" y="2" width="1" height="16" fill="#6b4419"/>
    <g fill="#cfeee3" opacity=".22"><rect x="3" y="2" width="6" height="3"/><rect x="4" y="5" width="4" height="2"/><rect x="5" y="7" width="2" height="3"/><rect x="4" y="10" width="4" height="2"/><rect x="3" y="12" width="6" height="6"/></g>
    <rect x="3" y="4" width="6" height="1" fill="#f2b33d"/><rect x="4" y="5" width="4" height="2" fill="#f2b33d"/><rect x="5" y="7" width="2" height="1" fill="#f2b33d"/>
    <rect class="sand-stream" x="5.5" y="8" width="1" height="7" fill="#f2b33d"/>
    <rect x="4" y="15" width="4" height="1" fill="#f2b33d"/><rect x="3" y="16" width="6" height="2" fill="#e9a52a"/>
    <rect x="3" y="2" width="1" height="2" fill="#fff" opacity=".35"/>
  </svg>`;
  // ---------- Лента дропов: откуда выпал (подсказка при наведении) и переход по клику ----------
  const drops = new Map();
  function rememberDrop(d) {
    if (!d?.id) return;
    drops.set(String(d.id), d);
    if (drops.size > 300) drops.delete(drops.keys().next().value);
  }
  const dropHref = (d) => (d.source?.kind === 'case' && d.source.caseId ? `#/case/${d.source.caseId}` : d.source?.kind === 'upgrade' ? '#/upgrade' : d.source?.kind === 'mystery' ? '#/mystery' : d.source?.kind === 'mines' ? '#/mines' : null);
  // Слой «откуда выпал»: при наведении он плавно заезжает на место брейнрота (без шанса апгрейда)
  const srcLayer = (d) => {
    const src = d.source || {};
    if (src.kind === 'case') {
      return `<span class="drop-src">${src.caseImage ? `<img src="${esc(src.caseImage)}" alt="">` : `<i class="ds-ico">${svgIcon('box')}</i>`}<span class="ds-txt"><small>Кейс</small><b>${esc(src.caseName || 'Кейс')}</b></span></span>`;
    }
    if (src.kind === 'upgrade') return `<span class="drop-src"><i class="ds-ico">${svgIcon('upgrade')}</i><span class="ds-txt"><b>Апгрейд</b></span></span>`;
    if (src.kind === 'mines') return `<span class="drop-src"><i class="ds-ico">${svgIcon('mines')}</i><span class="ds-txt"><b>Мины</b></span></span>`;
    if (src.kind === 'mystery') return `<span class="drop-src"><i class="ds-ico">${svgIcon('mystery')}</i><span class="ds-txt"><b>Мистери</b></span></span>`;
    return '';
  };
  const goDrop = (el) => {
    const d = drops.get(el.dataset.drop);
    const href = d && dropHref(d);
    if (!href) return;
    if (location.hash === href) route();
    else location.hash = href;
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-drop]');
    if (el) goDrop(el);
  });
  document.addEventListener('keydown', (e) => {
    const el = e.key === 'Enter' && e.target.closest?.('[data-drop]');
    if (el) goDrop(el);
  });

  const hms = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const dropTile = (d) => (rememberDrop(d), `<div class="drop-tile swap rar-${esc(d.rarity)}" data-drop="${esc(d.id)}" data-id="${esc(d.id)}" role="link" tabindex="0" aria-label="${esc(d.name)} — ${fmt(d.price)} BG"><img src="${itemImg(d.image)}" alt="${esc(d.name)}">${srcLayer(d)}</div>`);

  function drawTopDrop(home) {
    const box = $('#topDropMain');
    if (!box) return;
    const top = home.top;
    box.classList.toggle('swap', !!top);
    if (top) { rememberDrop(top); box.dataset.drop = top.id; box.setAttribute('role', 'link'); box.tabIndex = 0; } else delete box.dataset.drop;
    box.innerHTML = top
      ? `<div class="td-img rar-${esc(top.rarity)}"><img src="${itemImg(top.image)}" alt=""></div>
         <div class="td-info"><span class="td-label">🏆 Топ-дроп дня</span><b class="td-name">${esc(top.name)}</b></div>
         <span class="td-price">${COIN}${fmt(top.price)}</span>${srcLayer(top)}`
      : `<div class="td-img empty-img">${HOURGLASS}</div>
         <div class="td-info"><span class="td-label">🏆 Топ-дроп дня</span><b class="td-name">Сегодня ещё пусто</b><span class="muted td-sub">Открой кейс, и твой дроп окажется здесь</span></div>`;
  }
  function drawDrops(home, animate) {
    const strip = $('#dropsStrip');
    if (!strip) return;
    if (!home.drops.length) { strip.innerHTML = ''; strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    const have = new Set($$('.drop-tile', strip).map((x) => x.dataset.id));
    if (!animate || !have.size) { strip.innerHTML = home.drops.map(dropTile).join(''); return; }
    // новые дропы въезжают слева
    const fresh = home.drops.filter((d) => !have.has(String(d.id)));
    if (!fresh.length) return;
    strip.insertAdjacentHTML('afterbegin', fresh.map(dropTile).join(''));
    $$('.drop-tile', strip).slice(0, fresh.length).forEach((el) => el.classList.add('new'));
    $$('.drop-tile', strip).slice(home.drops.length).forEach((el) => el.remove());
  }
  function drawPromo(home) {
    const box = $('#promoCard');
    if (!box) return;
    const b = home.bonus;
    if (!b) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="promo-top">
        <div class="promo-hero"><img src="/img/brainrots/fortunu-and-cashuru.webp" alt=""><img class="pc pc1" src="/img/coin.webp" alt=""><img class="pc pc2" src="/img/coin.webp" alt=""><img class="pc pc3" src="/img/coin.webp" alt=""></div>
        <div class="promo-time"><span>Осталось времени</span><b id="promoTimer">${hms(new Date(b.endsAt) - Date.now())}</b></div>
        ${HOURGLASS}
      </div>
      <div class="promo-bottom">
        <div class="promo-code-box"><span>Используй промокод</span><button class="promo-code" id="promoCode" aria-label="Скопировать промокод">${esc(b.code)}</button></div>
        <div class="promo-ticket"><b>+${fmt(b.percent)}%</b><span>к пополнению</span></div>
      </div>
      ${b.used
        ? '<p class="promo-used">Этот промокод ты уже использовал. Следующий появится, когда закончится время</p>'
        : '<button class="btn" id="promoUse">Пополнить с промокодом</button>'}`;
    $('#promoCode', box).onclick = () => copy(b.code, 'Промокод скопирован');
    const use = $('#promoUse', box);
    if (use) use.onclick = () => openDeposit(dep.tab, { promo: b.code });
  }

  // Названия разделов кейсов на главной (новый раздел = новая строка здесь + category у кейса)
  const CASE_SECTIONS = { free: 'Бесплатные кейсы', start: 'Лёгкий Старт', standard: 'Стандартные кейсы', platina: 'Платиновые кейсы', allin: 'ALL-IN кейсы' };

  async function renderHome() {
    const t = state.render;
    view.innerHTML = `
      <section class="top-drop">
        <span class="live"><i></i>LIVE</span>
        <div class="td-main" id="topDropMain"><div class="skeleton" style="height:64px;flex:1"></div></div>
        <div class="drops-strip hidden" id="dropsStrip" aria-label="Последние дропы"></div>
      </section>
      <section class="promo-card hidden" id="promoCard"></section>
      <div id="cases"><h2>Кейсы</h2><div class="case-grid">${'<div class="skeleton"></div>'.repeat(4)}</div></div>`;
    const loadHome = async (animate) => {
      try {
        const home = await api('/api/home');
        if (stale(t)) return;
        const codeChanged = !state.home?.bonus || !home.bonus || state.home.bonus.code !== home.bonus.code || state.home.bonus.used !== home.bonus.used;
        state.home = home;
        drawTopDrop(home);
        drawDrops(home, animate);
        if (!animate || codeChanged) drawPromo(home);
      } catch {}
    };
    loadHome(false);
    // Лента и топ-дроп обновляются сами, таймер промокода тикает каждую секунду
    every(10000, () => !document.hidden && loadHome(true));
    every(1000, () => {
      const el = $('#promoTimer');
      const b = state.home?.bonus;
      if (!el || !b) return;
      const left = new Date(b.endsAt) - Date.now();
      el.textContent = hms(left);
      if (left <= 0 && !state.homeRefreshing) {
        state.homeRefreshing = true;
        setTimeout(() => loadHome(false).finally(() => (state.homeRefreshing = false)), 1500);
      }
    });
    try {
      state.cases = state.cases || (await api('/api/cases'));
    } catch (e) {
      return fail(e);
    }
    if (stale(t)) return;
    // Разделы кейсов: порядок — как идут кейсы, название раздела — из CASE_SECTIONS
    const card = (c) => `
        <a class="case-card" href="#/case/${c.id}">
          <img src="${esc(c.image || '/img/chest.svg')}" alt="">
          <div class="name">${esc(c.name)}</div>
          <div class="row">${c.freeKind
            ? '<span class="muted">раз в сутки</span><span class="free-chip">Бесплатно</span>'
            : `<span class="muted">${c.itemsCount} ${plural(c.itemsCount, 'брейнрот', 'брейнрота', 'брейнротов')}</span>${price(c.price)}`}</div>
        </a>`;
    const groups = new Map();
    for (const c of state.cases) {
      const k = c.category || 'standard';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    $('#cases').innerHTML = state.cases.length
      ? [...groups].map(([k, list]) => `<h2>${esc(CASE_SECTIONS[k] || k)}</h2><div class="case-grid">${list.map(card).join('')}</div>`).join('')
      : '<h2>Кейсы</h2><div class="empty">Кейсы скоро появятся</div>';
  }

  // =====================================================================
  //                         КЕЙС И РУЛЕТКА
  // =====================================================================
  // =====================================================================
  //   Выпал OG: экран трясётся всё сильнее, пока OG едет к маркеру, потом —
  //   вспышка, кольца, лучи, огромное «OG» и пиксельные искры
  // =====================================================================
  const ogFx = (() => {
    let el = null;
    let raf = 0;
    let mode = null; // 'build' — нарастает, 'boom' — толчок и затухание
    let t0 = 0;
    let len = 1;
    let glow = null;
    let timers = [];
    let riseSnd = null; // чтобы оборвать гул, если взрыв раньше (пропуск)
    let pending = null; // ждущий взрыв от arm()
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    // Трясём только страницу (шапка с размытием фона на телефоне тяжёлая). На слабых телефонах — меньше искр
    const shaken = () => [view];
    const LOW = matchMedia('(max-width: 700px)').matches || (navigator.hardwareConcurrency || 8) <= 4;
    const vib = (k) => { try { TG?.HapticFeedback?.impactOccurred(k); } catch {} };
    const mount = () => {
      if (el?.isConnected) return el;
      el = h(`<div class="ogfx" aria-hidden="true"><div class="vig"></div><div class="edge"></div><div class="rays"></div><canvas></canvas><div class="flash"></div><div class="ring"></div><div class="ring r2"></div><div class="word"><i></i></div><div class="sub">ВЫПАЛ OG</div></div>`);
      const mask = `url("data:image/svg+xml,${encodeURIComponent(ogSvg('#000').replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}")`;
      const w = $('.word i', el);
      w.style.webkitMaskImage = mask;
      w.style.maskImage = mask;
      document.body.appendChild(el);
      return el;
    };
    const centerY = (anchor) => {
      const r = anchor?.getBoundingClientRect?.();
      return r && r.height ? Math.round(r.top + r.height / 2) : Math.round(innerHeight * 0.4);
    };
    const shake = (now) => {
      let a = 0;
      if (mode === 'build') {
        const p = Math.min(1, (now - t0) / len);
        a = 0.5 + p * p * 6.5;
      } else if (mode === 'boom') {
        const p = (now - t0) / 950;
        a = p < 1 ? 17 * (1 - p) * (1 - p) : 0;
      }
      if (!mode || (mode === 'boom' && a <= 0)) {
        shaken().forEach((x) => { x.style.transform = ''; x.style.willChange = ''; });
        raf = 0;
        return;
      }
      const dx = (Math.random() * 2 - 1) * a;
      const dy = (Math.random() * 2 - 1) * a * 0.7;
      const rot = (Math.random() * 2 - 1) * a * 0.09;
      shaken().forEach((x) => (x.style.transform = `translate3d(${dx.toFixed(1)}px,${dy.toFixed(1)}px,0) rotate(${rot.toFixed(2)}deg)`));
      raf = requestAnimationFrame(shake);
    };
    const startShake = (m, ms = 1) => {
      mode = m;
      t0 = performance.now();
      len = ms;
      shaken().forEach((x) => (x.style.willChange = 'transform'));
      if (!raf && !reduced) raf = requestAnimationFrame(shake);
    };
    // Пиксельные искры цветов OG: разлетаются из центра и падают
    function sparks(cy, n = 150, power = 1) {
      const cv = $('canvas', el);
      if (!cv) return;
      const W = innerWidth;
      const H = innerHeight;
      const dpr = LOW ? 1 : Math.min(1.5, devicePixelRatio || 1);
      n = LOW ? Math.round(n * 0.45) : n;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cols = ['#ff4fb8', '#ffb547', '#fff27a', '#4dffb0', '#4ad8ff', '#b06cff', '#ffffff'];
      const ps = Array.from({ length: n }, () => {
        const a = Math.random() * Math.PI * 2;
        const v = (4 + Math.random() * 12) * power;
        return { x: W / 2, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3.5, s: 3 + 2 * Math.floor(Math.random() * 3), c: cols[(Math.random() * cols.length) | 0], life: 0, max: 55 + Math.random() * 55 };
      });
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(2.5, (now - last) / 16.67);
        last = now;
        c.clearRect(0, 0, W, H);
        let alive = 0;
        for (const p of ps) {
          p.life += dt;
          if (p.life > p.max) continue;
          alive++;
          p.vx *= Math.pow(0.965, dt);
          p.vy = p.vy * Math.pow(0.965, dt) + 0.3 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          c.globalAlpha = Math.max(0, 1 - p.life / p.max);
          c.fillStyle = p.c;
          c.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
        }
        c.globalAlpha = 1;
        if (alive && el?.isConnected) requestAnimationFrame(step);
        else c.clearRect(0, 0, W, H);
      };
      requestAnimationFrame(step);
    }
    function clear() {
      timers.forEach(clearTimeout);
      timers = [];
      riseSnd?.stop?.();
      riseSnd = null;
      pending?.res();
      pending = null;
      mode = null;
      cancelAnimationFrame(raf);
      raf = 0;
      shaken().forEach((x) => { x.style.transform = ''; x.style.willChange = ''; });
      glow?.classList.remove('og-build');
      glow = null;
      el?.remove();
      el = null;
    }
    // Нарастание: затемнение, пульс по краям, тряска, гул с сердцебиением, вибрация всё чаще
    function build(sec, anchor) {
      if (reduced || sec <= 0.2) return;
      const e = mount();
      e.classList.remove('boom', 'out');
      e.style.setProperty('--cy', centerY(anchor) + 'px');
      e.style.setProperty('--beat', '0.5s');
      requestAnimationFrame(() => e.classList.add('build'));
      glow = anchor || null;
      glow?.classList.add('og-build');
      startShake('build', sec * 1000);
      riseSnd = sfx.ogRise(sec);
      later(() => e.style.setProperty('--beat', '0.3s'), sec * 400);
      later(() => e.style.setProperty('--beat', '0.16s'), sec * 750);
      for (let at = 0, p = 0; at < sec * 1000; p = at / (sec * 1000), at += 520 - p * 400) {
        later(() => vib(p < 0.4 ? 'light' : p < 0.75 ? 'medium' : 'heavy'), at);
      }
    }
    // Взрыв. Промис — когда можно показывать результат (экран уже успокаивается)
    function boom(anchor) {
      timers.forEach(clearTimeout);
      timers = [];
      const e = mount();
      const cy = centerY(anchor || glow);
      glow?.classList.remove('og-build');
      glow = null;
      riseSnd?.stop?.();
      riseSnd = null;
      e.style.setProperty('--cy', cy + 'px');
      e.classList.remove('out', 'boom');
      void e.offsetWidth; // перезапуск анимаций
      e.classList.add('boom');
      sfx.ogBoom();
      vib('heavy');
      later(() => vib('heavy'), 130);
      later(() => vib('rigid'), 280);
      later(() => haptic('success'), 420);
      if (!reduced) {
        startShake('boom');
        sparks(cy, 160, 1);
        later(() => sparks(cy, 90, 0.7), 360);
      }
      later(() => e.classList.add('out'), 1550);
      later(clear, 2100);
      return sleep(1650);
    }
    // Для ленты: нарастание за ~3 с до остановки, взрыв в момент остановки
    function arm(endMs, anchor) {
      const lead = Math.min(3000, endMs * 0.55);
      later(() => build(lead / 1000, anchor), Math.max(0, endMs - lead));
      return new Promise((res) => {
        pending = { anchor, res };
        later(() => fire(), endMs);
      });
    }
    function fire() {
      const pd = pending;
      pending = null;
      if (pd) boom(pd.anchor).then(pd.res);
    }
    // Пропуск прокрута: нарастание отменяем, взрыв — когда лента доедет (через ms)
    function rush(ms) {
      if (!pending) return;
      timers.forEach(clearTimeout);
      timers = [];
      mode = null;
      later(() => fire(), ms);
    }
    return { build, boom, arm, rush, clear };
  })();

  const CARD = 104;
  const STEP = CARD + 8;
  // Сколько карточек пролетает до выигрыша: обычный прокрут — сильный и длинный, быстрый — короткий
  const SPIN = { normal: { win: 125, dur: 9800 }, fast: { win: 36, dur: 2700 } };

  const rCard = (it) => `<div class="r-card rar-${esc(it.rarity)}">${ogTag(it)}<img src="${itemImg(it.image)}" alt=""><div class="n">${esc(it.name)}</div>${price(it.price)}</div>`;
  const itemCard = (it, extra = '') => `<div class="item rar-${esc(it.rarity)}" ${extra}>${ogTag(it)}<img loading="lazy" src="${itemImg(it.image)}" alt=""><div class="n">${esc(it.name)}</div>${price(it.price)}</div>`;

  // Дешёвые чаще мелькают в ленте, как и выпадают на самом деле
  function randomItem(pool) {
    const w = pool.map((p) => 1 / Math.pow(Math.max(p.price, 0.01), 0.8));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) <= 0) return pool[i];
    return pool[0];
  }

  function placeStrip(strip, index, offset = 0) {
    const W = strip.parentElement.clientWidth;
    const x = W / 2 - (index * STEP + CARD / 2) + offset;
    strip.style.transform = `translate3d(${x}px,0,0)`;
  }

  // Пока кейс не открывают, лента медленно едет по кругу: все брейнроты, которые могут выпасть
  const idleRaf = new Map();
  function stopIdle(strip) {
    const st = idleRaf.get(strip);
    if (st) {
      clearTimeout(st.timer);
      st.anim?.cancel();
    }
    idleRaf.delete(strip);
  }
  // Медленный ход ленты — анимацией на видеокарте (бесконечный цикл), без JS в каждом кадре.
  // Для новой анимации «линзу» у маркера подправляем ~12 раз в секунду: лента едет медленно, глазу этого хватает
  function idleStrip(strip, pool) {
    stopIdle(strip);
    strip.style.transition = 'none';
    strip.classList.remove('spinning');
    const seq = [...pool].sort(() => Math.random() - 0.5);
    while (seq.length < 6) seq.push(...pool);
    const period = seq.length * STEP;
    const W = strip.parentElement.clientWidth || 390;
    const reps = Math.ceil((W + period) / period) + 1;
    strip.innerHTML = Array.from({ length: reps }, () => seq.map(rCard).join('')).join('');
    const v2 = isV2(strip);
    if (v2) resetFlow(strip);
    const x0 = Math.random() * period;
    strip.style.transform = `translate3d(${-x0}px,0,0)`;
    if (v2) applyFlow(strip, -x0);
    if (reduced) return;
    const speed = 34; // пикселей в секунду
    const dur = (period / speed) * 1000;
    const anim = strip.animate([{ transform: `translate3d(${-x0}px,0,0)` }, { transform: `translate3d(${-x0 - period}px,0,0)` }], { duration: dur, iterations: Infinity });
    const st = { anim, timer: 0 };
    idleRaf.set(strip, st);
    if (!v2) return;
    // таймер, а не кадр анимации: между обновлениями браузер вообще не трогает страницу
    const loop = () => {
      if (!strip.isConnected || idleRaf.get(strip) !== st) return;
      const t = ((anim.currentTime || 0) % dur) / dur;
      applyFlow(strip, -x0 - t * period);
      st.timer = setTimeout(loop, 85);
    };
    st.timer = setTimeout(loop, 85);
  }

  // Щелчок, когда под маркером проходит новая карточка: частота сама замедляется вместе с лентой
  function followStrip(strip, until) {
    const lim = typeof until === 'object' ? until : { until };
    const W = strip.parentElement.clientWidth;
    let last = null;
    const loop = () => {
      if (performance.now() > lim.until || !strip.isConnected) return;
      const m = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
      const idx = Math.floor((W / 2 - m.m41) / STEP);
      if (last !== null && idx !== last) sfx.clack();
      last = idx;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // «Пропустить»: одна кнопка останавливает все ленты разом
  function makeSkip() {
    const fns = [];
    return {
      used: false,
      add(fn) { fns.push(fn); },
      fire() {
        if (this.used) return;
        this.used = true;
        fns.forEach((fn) => fn());
      },
    };
  }

  // ---------- Новая анимация кейса (в настройках можно вернуть старую: case_anim = classic) ----------
  // Лента «каруселью»: карточка под маркером крупнее и светится цветом редкости, края уходят в глубину;
  // старт — сундук трясётся и раскрывается, лента вылетает сразу на полной скорости и долго тормозит.
  const V2_EASE = (() => {
    try {
      if (CSS.supports('animation-timing-function', 'linear(0, 1)')) {
        const pts = Array.from({ length: 41 }, (_, i) => { const t = i / 40; return (1 - Math.pow(1 - t, 4.2)).toFixed(4); });
        return `linear(${pts.join(', ')})`;
      }
    } catch {}
    return 'cubic-bezier(0.1, 0.72, 0.18, 1)';
  })();
  const caseAnimV2 = () => state.cfg?.caseAnim !== 'classic' && !reduced;
  const isV2 = (strip) => strip.parentElement?.classList.contains('v2');
  const RAR_BEAM = { common: '#34e08a', rare: '#4aa3ff', epic: '#b06cff', legendary: '#ffc83d', og: '#ff4fb8' };
  // Оптимизация (важно при ×5): ширину ленты читаем один раз (без чтения разметки в каждом кадре),
  // пишем стиль карточки только если он заметно изменился, карточки, ушедшие из кадра, сбрасываем
  // (иначе каждая остаётся отдельным 3D-слоем), подсветку под маркером на большой скорости обновляем не чаще ~12 раз в секунду.
  function applyFlow(strip, x, now = performance.now()) {
    const W = strip._W || (strip._W = strip.parentElement.clientWidth || 390);
    const cards = strip.children;
    const center = (W / 2 - x - CARD / 2) / STEP; // индекс карточки, что сейчас под маркером (дробный)
    // При ×3/×5 «линза» уже: увеличиваются только карточки у маркера, края гасит затемнение по бокам ленты
    const span = strip._flat ? 2 : Math.ceil(W / 2 / STEP) + 1;
    // На самой большой скорости карточки пролетают по одной за кадр — увеличение там не видно, не тратим на него силы
    const speed = strip._fx == null ? 0 : Math.abs(x - strip._fx);
    strip._fx = x;
    const lensOn = speed < STEP * 0.6;
    const c0 = lensOn ? Math.max(0, Math.floor(center) - span) : 0;
    const c1 = lensOn ? Math.min(cards.length - 1, Math.ceil(center) + span) : -1;
    // ушли из линзы — обычная плоская карточка
    if (strip._c0 != null) {
      for (let i = strip._c0; i <= strip._c1; i++) {
        if (i >= c0 && i <= c1) continue;
        const el = cards[i];
        if (el && el._q != null) { el.style.transform = ''; el.style.opacity = ''; el._q = null; el.classList.remove('lens'); }
      }
    }
    strip._c0 = c0;
    strip._c1 = c1;
    for (let i = c0; i <= c1; i++) {
      const el = cards[i];
      const d = i - center;
      const q = Math.round(d * 24);
      if (el._q === q) continue;
      if (el._q == null) el.classList.add('lens'); // свой слой: дальше двигается без перерисовки
      el._q = q;
      const ad = Math.min(Math.abs(d), 4);
      // объём (поворот) — только для одной ленты; при ×3/×5 — плоское увеличение, так в разы легче для телефона
      if (strip._flat) {
        el.style.transform = `scale(${(1.12 - Math.min(ad, 2) * 0.06).toFixed(3)})`;
      } else {
        el.style.transform = `perspective(700px) rotateY(${Math.max(-38, Math.min(38, -d * 13)).toFixed(1)}deg) scale(${(1.14 - ad * 0.085).toFixed(3)})`;
        el.style.opacity = (1 - ad * 0.17).toFixed(2);
      }
    }
    const hot = Math.round(center);
    if (strip._hotIdx === hot) return false;
    strip._hotIdx = hot;
    // на скорости подсветку и цвет луча не трогаем каждый кадр — глаз всё равно не успевает
    const fastNow = strip._last != null && Math.abs(x - strip._last) > STEP * 0.35;
    strip._last = x;
    if (!fastNow || now - (strip._hotAt || 0) > 85) {
      strip._hotAt = now;
      if (strip._hot !== hot) {
        cards[strip._hot]?.classList.remove('hot');
        cards[hot]?.classList.add('hot');
        strip._hot = hot;
        const rar = cards[hot]?.className.match(/rar-(\w+)/)?.[1] || 'common';
        if (strip._rar !== rar) {
          strip._rar = rar;
          strip.previousElementSibling?.style.setProperty('--beam', RAR_BEAM[rar] || RAR_BEAM.common);
        }
      }
    }
    return true; // новая карточка под маркером — щелчок
  }
  function resetFlow(strip) {
    strip._W = strip.parentElement.clientWidth || 390;
    strip._flat = strip.parentElement.classList.contains('multi');
    strip._c0 = strip._c1 = strip._hot = strip._hotIdx = strip._last = strip._rar = strip._fx = null;
  }
  function stripX(strip, index, offset = 0) {
    return strip.parentElement.clientWidth / 2 - (index * STEP + CARD / 2) + offset;
  }
  // Старт открытия: сам кейс сверху трясётся и раскрывается вспышкой, но остаётся на месте — лента крутится под ним.
  // При ×3 / ×5 вызывается для каждой ленты — анимируем кейс один раз.
  async function caseIntro() {
    const art = $('#caseArt');
    if (!art || art._busy) return;
    art._busy = true;
    art.classList.remove('opening', 'burst');
    void art.offsetWidth;
    art.classList.add('opening');
    await sleep(prefs.fast ? 0 : 560);
    art.classList.remove('opening');
    art.classList.add('burst');
    setTimeout(() => { art.classList.remove('burst'); art._busy = false; }, 600);
  }
  async function spinStripV2(strip, pool, winner, { delay = 0, sound = true, skip = null, intro = null } = {}) {
    const cfg = prefs.fast ? SPIN.fast : SPIN.normal;
    const roulette = strip.parentElement;
    // При ×3/×5 лента короче (меньше карточек в странице — легче телефону), время прокрута то же
    const winIdx = roulette.classList.contains('n5') ? Math.round(cfg.win * 0.5) : roulette.classList.contains('n3') ? Math.round(cfg.win * 0.65) : cfg.win;
    const cards = Array.from({ length: winIdx + 8 }, (_, i) => (i === winIdx ? winner : randomItem(pool)));
    stopIdle(strip);
    roulette.classList.remove('done');
    strip.style.transition = 'none';
    strip.innerHTML = cards.map(rCard).join('');
    resetFlow(strip);
    const x0 = stripX(strip, 3);
    strip.style.transform = `translate3d(${x0}px,0,0)`;
    applyFlow(strip, x0);
    const introMs = intro && !prefs.fast ? 640 : 0;
    // «Пропустить» могут нажать сразу, ещё во время сундука — запоминаем и сразу едем коротким доездом
    let skipNow = null;
    let skipped = false;
    const skipWait = new Promise((r) => skip?.add(() => { skipped = true; r(); skipNow?.(); }));
    if (intro) caseIntro();
    const dur = cfg.dur + delay - introMs;
    const jitter = (Math.random() * 0.7 - 0.35) * CARD;
    const x1 = stripX(strip, winIdx, jitter);
    let k = 0;
    await Promise.race([sleep(introMs), skipWait]);
    // Движение ленты — на видеокарте (Web Animations): даже если телефон занят, лента едет плавно.
    // В кадре JS лишь читает, где сейчас лента, и подправляет карточки рядом с маркером.
    const move = (from, to, ms, easing) => strip.animate([{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${to}px,0,0)` }], { duration: ms, easing, fill: 'forwards' });
    let a0 = x0;
    let anim = skipped ? move(x0, x1, 420, 'cubic-bezier(0.2, 0.75, 0.25, 1)') : move(x0, x1, dur, V2_EASE);
    await new Promise((done) => {
      let over = false;
      const frame = (now) => {
        if (over || !strip.isConnected) return;
        const pr = anim.effect.getComputedTiming().progress;
        const x = pr == null ? x1 : a0 + (x1 - a0) * pr;
        if (applyFlow(strip, x, now)) {
          if (sound) sfx.tok(pr ?? 1);
          if (k++ < 40 && k % 3 === 0) tick();
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const finish = (an) => an.finished.then(() => {
        if (an !== anim) return;
        over = true;
        strip.style.transform = `translate3d(${x1}px,0,0)`;
        anim.cancel();
        done();
      }, () => {});
      finish(anim);
      // «Пропустить»: с текущего места быстро доезжаем до того же выпавшего брейнрота
      let fastDone = skipped;
      skipNow = () => {
        if (over || fastDone) return;
        fastDone = true;
        const pr = anim.effect.getComputedTiming().progress ?? 1;
        const xc = a0 + (x1 - a0) * pr;
        const old = anim;
        a0 = xc;
        anim = move(xc, x1, 420, 'cubic-bezier(0.2, 0.75, 0.25, 1)');
        old.cancel();
        finish(anim);
      };
    });
    // Остановка: победитель выезжает вперёд, лучи цвета редкости и искры
    strip._fx = x1;
    applyFlow(strip, x1, performance.now() + 1000); // подсветка точно на победителе
    const win = strip.children[winIdx];
    strip.children[strip._hot]?.classList.remove('hot');
    win.classList.add('win');
    // затемняем только видимых соседей, а не всю ленту
    for (let i = Math.max(0, winIdx - 7); i <= winIdx + 7; i++) if (i !== winIdx) strip.children[i]?.classList.add('dim');
    roulette.classList.add('done');
    roulette.querySelector('.marker')?.style.setProperty('--beam', RAR_BEAM[winner.rarity] || RAR_BEAM.common);
    const fx = h(`<div class="r-win-fx rar-${esc(winner.rarity)}"><b></b>${Array.from({ length: 14 }, (_, i) => `<i style="--a:${(i / 14) * 360 + Math.random() * 12}deg;--d:${50 + Math.random() * 60}px"></i>`).join('')}</div>`);
    fx.style.left = `${win.offsetLeft + CARD / 2}px`;
    strip.appendChild(fx);
  }

  async function spinStrip(strip, pool, winner, opts = {}) {
    if (isV2(strip)) return spinStripV2(strip, pool, winner, opts);
    const { delay = 0, sound = true, skip = null } = opts;
    const cfg = prefs.fast ? SPIN.fast : SPIN.normal;
    const winIdx = cfg.win;
    const cards = Array.from({ length: winIdx + 6 }, (_, i) => (i === winIdx ? winner : randomItem(pool)));
    stopIdle(strip);
    strip.style.transition = 'none';
    strip.classList.remove('spinning');
    strip.innerHTML = cards.map(rCard).join('');
    placeStrip(strip, 3);
    strip.getBoundingClientRect(); // применяем стартовую позицию до анимации
    const dur = reduced ? 700 : cfg.dur + delay;
    const jitter = (Math.random() * 0.7 - 0.35) * CARD; // останавливаемся не ровно по центру — живее
    strip.classList.add('spinning');
    strip.style.transition = `transform ${dur}ms cubic-bezier(0.04, 0.7, 0.09, 1)`;
    placeStrip(strip, winIdx, jitter);
    const follow = { until: performance.now() + dur };
    if (sound) followStrip(strip, follow);
    // Лёгкая вибрация, пока лента быстрая
    let k = 0;
    const tk = setInterval(() => (k++ < (prefs.fast ? 8 : 20) ? tick() : clearInterval(tk)), 140);
    const unblur = setTimeout(() => strip.classList.remove('spinning'), dur * 0.62);
    await new Promise((done) => {
      let over = false;
      const end = setTimeout(() => { over = true; done(); }, dur + 60);
      // Пропуск: лента с того места, где сейчас, быстро доезжает до того же выпавшего брейнрота
      skip?.add(() => {
        if (over) return;
        clearTimeout(end);
        clearTimeout(unblur);
        clearInterval(tk);
        strip.classList.remove('spinning');
        const now = getComputedStyle(strip).transform;
        strip.style.transition = 'none';
        strip.style.transform = now;
        strip.getBoundingClientRect();
        const fin = 420;
        strip.style.transition = `transform ${fin}ms cubic-bezier(0.2, 0.75, 0.25, 1)`;
        placeStrip(strip, winIdx, jitter);
        follow.until = performance.now() + fin;
        setTimeout(() => { over = true; done(); }, fin + 40);
      });
    });
    clearInterval(tk);
    // размываем только видимые соседние карточки: blur на сотнях карточек сразу тормозит телефоны
    $$('.r-card', strip).forEach((el, i) => {
      if (i === winIdx) el.classList.add('win');
      else if (Math.abs(i - winIdx) <= 7) el.classList.add('faded');
    });
  }

  const RAR_ORDER = ['common', 'rare', 'epic', 'legendary', 'og'];
  const bestRarity = (items) => items.reduce((a, it) => (RAR_ORDER.indexOf(it.rarity) > RAR_ORDER.indexOf(a) ? it.rarity : a), 'common');

  async function renderCase(id) {
    const t = state.render;
    view.innerHTML = '<div class="skeleton"></div>';
    let cs;
    try {
      cs = await api('/api/cases/' + id);
    } catch (e) {
      view.innerHTML = '<a class="back" href="#/">‹ Все кейсы</a><div class="empty">Кейс не найден</div>';
      return fail(e);
    }
    if (stale(t)) return;
    view.innerHTML = `
      <a class="back" href="#/">‹ Все кейсы</a>
      <div class="case-head">
        <div class="ch-art" id="caseArt"><img src="${esc(cs.image || '/img/chest.svg')}" alt=""><i class="ch-flash"></i></div>
        <div><h1>${esc(cs.name)}</h1><div class="muted">${cs.freeKind ? 'Бесплатно, раз в сутки' : `${cs.items.length} ${plural(cs.items.length, 'брейнрот', 'брейнрота', 'брейнротов')} внутри`}</div></div>
      </div>
      <div id="strips"></div>
      <div class="case-ctrl">
        ${cs.freeKind ? '<span></span>' : `<div class="count-seg" id="countSeg" role="group" aria-label="Сколько кейсов открыть">${[1, 3, 5].map((n) => `<button data-n="${n}" class="${prefs.count === n ? 'on' : ''}">×${n}</button>`).join('')}</div>`}
        ${speedSoundHtml()}
      </div>
      ${cs.freeKind ? '<div class="free-box hidden" id="freeBox"></div>' : ''}
      <button class="btn open-btn" id="open"></button>
      ${cs.freeKind ? '' : '<button class="link-btn promo-open" id="promoOpen">Открыть по промокоду</button>'}
      <h2>Что внутри</h2>
      <div class="items">${cs.items.map((i) => itemCard(i)).join('')}</div>`;
    const drawStrips = () => {
      const cnt = openCount(cs);
      $('#strips').innerHTML = Array.from({ length: cnt }, (_, k) => `<div class="roulette ${caseAnimV2() ? 'v2' : ''} ${cnt > 1 ? 'multi' : ''} n${cnt}"><div class="marker"></div><div class="strip" data-k="${k}"></div></div>`).join('');
      $$('#strips .strip').forEach((st) => idleStrip(st, cs.items));
    };
    drawStrips();
    bindSpeedSound(view);
    const btn = $('#open');
    // Бесплатный кейс: условие (подписка / тег) и таймер до следующего открытия
    let free = null;
    const loadFree = async (check = false) => {
      try {
        free = await api(`/api/cases/${cs.id}/free${check ? '?check=1' : ''}`);
      } catch (e) {
        if (check) fail(e);
      }
      if (!stale(t)) update();
      return free;
    };
    const freeEvery = (f) => (!f.hours || f.hours === 24 ? 'раз в сутки' : `раз в ${f.hours} ч`);
    const drawFree = () => {
      const box = $('#freeBox');
      if (!box) return;
      const show = free && !free.nextAt && (!free.ok || free.broken || free.needDeposit);
      box.classList.toggle('hidden', !show);
      if (!show) return void (box.innerHTML = '');
      const sig = JSON.stringify(free);
      if (box.dataset.sig === sig) return;
      box.dataset.sig = sig;
      if (free.broken) return void (box.innerHTML = '<p>Кейс скоро заработает — загляни чуть позже</p>');
      if (free.needDeposit) {
        box.innerHTML = `<p>Бесплатные кейсы — для тех, кто пополнил баланс от <b>${fmt(free.needDeposit.min)} BG</b>. Ты пополнил: ${fmt(free.needDeposit.have)} BG</p><button class="btn ghost" id="freeDep">Пополнить</button>`;
        $('#freeDep', box).onclick = () => openDeposit();
        return;
      }
      if (free.kind === 'channel') {
        box.innerHTML = `<p>Подпишись на наш канал${free.channel?.title ? ` <b>${esc(free.channel.title)}</b>` : ''} — и открывай этот кейс бесплатно ${freeEvery(free)}</p>
          ${free.channel?.url ? '<button class="btn ghost" id="freeGo">Подписаться</button>' : ''}`;
        const go = $('#freeGo', box);
        if (go) go.onclick = () => { try { TG?.openTelegramLink ? TG.openTelegramLink(free.channel.url) : window.open(free.channel.url, '_blank'); } catch { window.open(free.channel.url, '_blank'); } };
      } else {
        box.innerHTML = `<p>Добавь <b>${esc(free.tag)}</b> в своё имя в Telegram — и открывай этот кейс бесплатно ${freeEvery(free)}</p>
          <div class="free-tag-row"><code>${esc(free.tag)}</code><button class="btn ghost" id="freeCopy">Скопировать</button></div>
          <p class="muted">Настройки Telegram → нажми на своё имя → впиши в имя или фамилию. Уберёшь тег — кейс снова закроется</p>`;
        $('#freeCopy', box).onclick = () => copy(free.tag, 'Скопировано');
      }
    };
    const update = () => {
      const n = openCount(cs);
      const test = isTest();
      const enough = (test ? state.me?.testBalance ?? 0 : state.me?.balance ?? 0) >= cs.price * n;
      $('#testBal') && ($('#testBal').textContent = fmt(state.me.testBalance || 0));
      $('#promoOpen')?.classList.toggle('hidden', test);
      $$('#countSeg button').forEach((b) => (b.disabled = state.busy));
      // Пока крутится — на месте кнопки «Открыть» кнопка «Пропустить»
      if (state.busy && state.skip) {
        btn.classList.add('skip');
        btn.disabled = state.skip.used;
        btn.innerHTML = state.skip.used ? 'Останавливаю…' : `${SKIP_ICON}<span>Пропустить</span>`;
        btn.onclick = () => { state.skip?.fire(); update(); };
        return;
      }
      btn.classList.remove('skip');
      btn.disabled = state.busy;
      if (test) {
        $('#freeBox')?.classList.add('hidden');
        btn.disabled = state.busy || !enough;
        btn.innerHTML = enough ? `Открыть${n > 1 ? ` ${n} шт.` : ''} за ${price(cs.price * n)}` : 'Недостаточно BG';
        btn.onclick = () => openFlow(cs, update, null, true);
        return;
      }
      if (cs.freeKind) {
        drawFree();
        const left = free?.nextAt ? new Date(free.nextAt) - Date.now() : 0;
        if (!free) { btn.disabled = true; btn.textContent = 'Проверяю…'; return; }
        if (left > 0) { btn.disabled = true; btn.innerHTML = `Следующий через <span class="mono">${hms(left)}</span>`; return; }
        if (free.nextAt) { free.nextAt = null; loadFree(); }
        if (free.broken) { btn.disabled = true; btn.textContent = 'Скоро'; return; }
        if (free.needDeposit) { btn.disabled = false; btn.textContent = 'Пополнить баланс'; btn.onclick = () => openDeposit(); return; }
        if (!free.ok) {
          btn.textContent = free.kind === 'channel' ? 'Я подписался — проверить' : 'Я добавил — проверить';
          btn.onclick = async () => {
            btn.disabled = true;
            const r = await loadFree(true);
            if (r && !r.ok && !r.broken) toast(r.kind === 'channel' ? 'Подписка пока не видна — подпишись и нажми ещё раз' : 'Тег в имени пока не виден — добавь и нажми ещё раз');
          };
          return;
        }
        btn.textContent = 'Открыть бесплатно';
        btn.onclick = () => openFlow(cs, update);
        return;
      }
      btn.innerHTML = enough ? `Открыть${n > 1 ? ` ${n} шт.` : ''} за ${price(cs.price * n)}` : 'Пополнить баланс';
      btn.onclick = enough ? () => openFlow(cs, update) : () => openDeposit();
    };
    $$('#countSeg button').forEach((b) => (b.onclick = () => {
      if (state.busy) return;
      prefs.count = Number(b.dataset.n);
      savePrefs();
      $$('#countSeg button').forEach((x) => x.classList.toggle('on', x === b));
      tick();
      drawStrips();
      update();
    }));
    if ($('#tTest')) {
      $('#tTest').onclick = (e) => {
        if (state.busy) return;
        state.testMode = !state.testMode;
        e.currentTarget.classList.toggle('on', state.testMode);
        e.currentTarget.setAttribute('aria-pressed', state.testMode);
        update();
      };
      $('#testSell').onclick = () => sellTestAll(update);
    }
    update();
    state.caseUpdate = update;
    if ($('#promoOpen')) $('#promoOpen').onclick = () => { if (!state.busy) promoOpenSheet(cs, update); };
    if (cs.freeKind) {
      update.reloadFree = () => loadFree();
      loadFree();
      every(1000, () => free?.nextAt && !state.busy && update());
    }
  }

  // Тест-деньги — только у админов; открытия на них не идут в статистику и не выводятся
  const isTest = () => !!(state.testMode && state.me?.isAdmin);
  async function sellTestAll(update) {
    try {
      const r = await api('/api/test/sell', { method: 'POST', body: {} });
      state.me.testBalance = r.testBalance;
      toast(`Продано за ${fmt(r.total)} BG`);
      update?.();
    } catch (e) { fail(e); }
  }
  // Бесплатный кейс открывается по одному (на тест-деньги — сколько угодно)
  const openCount = (cs) => (cs.freeKind && !isTest() ? 1 : prefs.count);

  // Открыть кейс по промокоду (код создаёт админ: на этот кейс, каждый игрок — один раз)
  function promoOpenSheet(cs, update) {
    const body = h(`<div>
      <p class="hint">Введи промокод на кейс «${esc(cs.name)}» — откроешь его бесплатно один раз.</p>
      <label class="field"><span>Промокод</span><input id="cpCode" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="Например, BRAINROT"></label>
      <button class="btn" id="cpGo">Открыть бесплатно</button></div>`);
    const s = openSheet('Открыть по промокоду', body);
    const inp = $('#cpCode', body);
    setTimeout(() => inp.focus(), 50);
    const go = () => {
      const code = inp.value.trim().toUpperCase();
      if (code.length < 3) return toast('Введи промокод', 'err');
      s.close();
      openFlow(cs, update, code);
    };
    $('#cpGo', body).onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  async function openFlow(cs, update, promo = null, test = false) {
    if (state.busy) return;
    const n = promo ? 1 : openCount(cs);
    state.busy = true;
    update();
    lockNav(true);
    try {
      const v2 = caseAnimV2();
      const r = test
        ? await api(`/api/test/open/${cs.id}`, { method: 'POST', body: { count: n } })
        : await api(`/api/cases/${cs.id}/open`, { method: 'POST', body: { key: newKey(), count: n, ...(promo ? { promo } : {}) } });
      if (promo) toast('Промокод сработал — открываем бесплатно');
      if (test) state.me.testBalance = r.testBalance;
      else setBalance(r.balance);
      const strips = $$('#strips .strip');
      if (!v2) sfx.start();
      // Ленты стартуют вместе и останавливаются по очереди; щёлкает только первая, чтобы звук не был кашей
      const delays = r.drops.map((d, k) => k * (prefs.fast ? (n > 3 ? 120 : 180) : n > 3 ? 280 : 420));
      // Выпал OG: за пару секунд до остановки экран начинает трястись, на остановке — взрыв
      const ogK = r.drops.map((d, k) => (d.item.rarity === 'og' ? k : -1)).filter((k) => k >= 0).pop();
      const ogDone = ogK != null ? ogFx.arm((reduced ? 700 : (prefs.fast ? SPIN.fast : SPIN.normal).dur + delays[ogK]), strips[ogK].parentElement) : null;
      // Кнопка «Пропустить»: ленты сразу доезжают, а если выпал OG — взрыв всё равно будет, как только они встанут
      const skip = makeSkip();
      if (ogDone) skip.add(() => ogFx.rush(480));
      // новая анимация: «вжух» на старте, тихий тянущий фон до последней остановки
      let pad = null;
      if (v2) {
        sfx.whoosh();
        // выпал OG — у него свой нарастающий гул, тянущий фон не накладываем
        if (!ogDone) pad = sfx.spinPad(((prefs.fast ? SPIN.fast : SPIN.normal).dur + delays[delays.length - 1]) / 1000);
        if (pad) skip.add(() => pad.stop());
      }
      state.skip = skip;
      update();
      let landed = 0;
      await Promise.all(r.drops.map((d, k) => spinStrip(strips[k], cs.items, d.item, { delay: delays[k], sound: k === 0, skip, intro: cs.image }).then(() => {
        if (!v2 || ogDone) return; // у OG свой звук
        // ×1 — колокольчик сразу на остановке; ×3 / ×5 — нота на каждую ленту, по нарастающей
        if (n === 1) sfx.reveal(d.item.rarity);
        else sfx.land(landed++, d.item.rarity);
      })));
      pad?.stop();
      if (v2 && !ogDone && n > 1) setTimeout(() => sfx.reveal(bestRarity(r.drops.map((d) => d.item)), true), 260);
      state.skip = null;
      if (ogDone) await ogDone;
      else if (caseAnimV2()) await sleep(prefs.fast ? 250 : 700); // дать увидеть победителя с лучами
      lockNav(false);
      if (!ogDone) {
        haptic('success');
        if (!v2) sfx.win(bestRarity(r.drops.map((d) => d.item)));
      }
      showDrop(cs, r, update);
      if (!test) setTimeout(() => liveTick(true), 400); // свой дроп сразу появляется в ленте слева (на компьютере)
    } catch (e) {
      ogFx.clear();
      fail(e);
    } finally {
      state.skip = null;
      lockNav(false);
      state.busy = false;
      if (cs.freeKind && !test) update.reloadFree?.();
      update();
    }
  }

  function showDrop(cs, r, update) {
    const drops = r.drops || [r];
    const n = drops.length;
    const total = drops.reduce((a, d) => a + d.item.price, 0);
    // Монеты уже на балансе — продавать и апгрейдить можно только брейнротов
    const items = drops.filter((d) => !d.item.coins);
    const coins = drops.reduce((a, d) => a + (d.item.coins ? d.item.price : 0), 0);
    const sellSum = items.reduce((a, d) => a + d.item.price, 0);
    const again = openCount(cs);
    const test = !!r.test;
    const enough = (test ? state.me.testBalance : state.me.balance) >= cs.price * again;
    const body = h(`
      <div>
        <div class="result-row n${n}">${drops.map((d) => `
          <div class="result-card shine rar-${esc(d.item.rarity)}">${ogTag(d.item)}
            <img src="${itemImgBig(d.item.image)}" alt="">
            <b>${esc(d.item.name)}</b>
            ${price(d.item.price)}
          </div>`).join('')}
        </div>
        ${n > 1 ? `<div class="result-total"><span>Всего выпало на</span>${price(total)}</div>` : ''}
        ${coins ? `<div class="result-total coins-got"><span>Зачислено на баланс</span>${price(coins)}</div>` : ''}
        ${items.length ? `<div class="btn-row" style="margin-top:18px">
          <button class="btn ghost" data-a="sell">Продать за ${price(sellSum)}</button>
          <button class="btn ghost" data-a="upgrade">Апгрейд</button>
        </div>` : ''}
        <button class="btn" data-a="again" style="margin-top:${items.length ? 8 : 18}px">${test ? (enough ? `Ещё${again > 1 ? ` ${again} шт.` : ''} за ${price(cs.price * again)}` : 'Готово') : cs.freeKind ? 'Готово' : enough ? `Открыть ещё${again > 1 ? ` ${again} шт.` : ''} за ${price(cs.price * again)}` : 'Пополнить баланс'}</button>
        
      </div>`);
    const s = openSheet((n > 1 ? `Тебе выпало ${n} ${plural(n, 'брейнрот', 'брейнрота', 'брейнротов')}` : 'Тебе выпало'), body);
    const sellBtn = $('[data-a=sell]', body);
    if (sellBtn) sellBtn.onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      ev.currentTarget.disabled = true;
      try {
        if (test) {
          const res = await api('/api/test/sell', { method: 'POST', body: { ids: items.map((d) => d.inventoryId) } });
          state.me.testBalance = res.testBalance;
          toast(`Продано за ${fmt(res.total)} BG`);
          s.close();
          return update();
        }
        const res = await api('/api/inventory/sell', { method: 'POST', body: { ids: items.map((d) => d.inventoryId), key: newKey() } });
        setBalance(res.balance);
        toast(`Продано за ${fmt(res.total)} BG`);
        s.close();
        update();
      } catch (e) {
        ev.currentTarget.disabled = false;
        fail(e);
      }
    };
    const upBtn = $('[data-a=upgrade]', body);
    if (upBtn) upBtn.onclick = () => {
      s.close();
      // Один дроп — сразу в ставку; несколько — просто открываем апгрейдер, игрок выберет сам
      location.hash = items.length === 1 ? `#/upgrade?item=${items[0].inventoryId}` : '#/upgrade';
    };
    $('[data-a=again]', body).onclick = () => {
      s.close();
      if (test) return enough ? openFlow(cs, update, null, true) : update();
      if (cs.freeKind) return update();
      if (enough) openFlow(cs, update);
      else openDeposit();
    };
  }

  // =====================================================================
  //                              АПГРЕЙДЕР
  // =====================================================================
  const R = 110;
  const C = 2 * Math.PI * R;
  const up = { selected: [], target: null, preset: 'x2', data: null, tab: 'mine', angle: 0, spinning: false, inv: [], shop: null, q: '', view: 'targets' };
  const boughtTag = (i) => (i.test ? testTag : i.bought ? '<span class="bought-tag" title="Куплен за баланс — вывести нельзя">куплен</span>' : i.reward ? '<span class="bought-tag" title="Награда за серию — вывести нельзя">награда</span>' : '');

  const riskColor = (ch) => (ch >= 45 ? 'var(--crystal)' : ch >= 25 ? 'var(--amber)' : 'var(--ember)');

  async function renderUpgrade(qs) {
    const t = state.render;
    const pre = (qs.get('items') || qs.get('item') || '').split(',').map(Number).filter((x) => Number.isSafeInteger(x) && x !== 0);
    up.spinning = false; // если прошлый апгрейд прервали уходом со страницы — не зависаем
    up.selected = pre.length ? pre.slice(0, state.cfg.upgrade.maxItems) : up.selected;
    up.target = null;
    up.data = null;
    up.shop = null;
    up.q = '';
    up.view = 'targets';
    up.preset = 'x2';
    const ticks = Array.from({ length: 24 }, (_, i) => {
      const a = (i * 15 * Math.PI) / 180;
      const r1 = i % 6 === 0 ? 124 : 126;
      return `<line x1="${130 + Math.sin(a) * r1}" y1="${130 - Math.cos(a) * r1}" x2="${130 + Math.sin(a) * 129}" y2="${130 - Math.cos(a) * 129}"/>`;
    }).join('');
    view.innerHTML = `
      <div class="up-wrap" id="upWrap" data-tab="mine">
      <div class="seg up-seg" id="upSeg">
        <button data-t="mine">Мои брейнроты</button>
        <button data-t="right">Брейнроты</button>
      </div>
      <div class="up-col up-mine"><div class="section-head col-head"><h2>Мои брейнроты</h2><span class="muted" id="upMineN"></span></div><div id="upMine"></div></div>
      <div class="up-left">
      <div class="ring-wrap">
        <svg viewBox="0 0 260 260" aria-hidden="true">
          <g class="ring-ticks">${ticks}</g>
          <circle class="ring-track" cx="130" cy="130" r="${R}"/>
          <defs><linearGradient id="goldGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#ffc83d"/><stop offset="1" stop-color="#d98a00"/></linearGradient></defs>
          <circle class="ring-arc" id="arc" cx="130" cy="130" r="${R}" transform="rotate(-90 130 130)" stroke-dasharray="0 ${C / 2} 0 ${C}"/>
          <circle class="ring-gold" id="goldArc" cx="130" cy="130" r="${R}" transform="rotate(-90 130 130)" stroke-dasharray="0 ${C / 2} 0 ${C}"/>
        </svg>
        <div class="gold-rays" aria-hidden="true"></div>
        <div class="pointer" id="pointer"><div class="ptr-tail" id="ptrTail"></div></div>
        <div class="ring-center" id="rc"><div class="pct" id="pct">0%</div><div class="lbl" id="rlbl">шанс</div></div>
        <div class="gold-burst" id="goldBurst" aria-hidden="true"></div>
      </div>
      <div class="slots">
        <div class="slot" id="slotIn"></div>
        <div class="arrow-between">›</div>
        <div class="slot" id="slotOut"></div>
      </div>
      <div class="mults" id="mults"></div>
      <div class="up-ctrl">${speedSoundHtml()}</div>
      <button class="btn" id="go" disabled>Апгрейд</button>
      </div>
      <div class="up-col up-right"><div class="section-head col-head"><h2>Брейнроты</h2><span class="muted" id="upRightHint"></span></div>
      <div class="seg up-rseg" id="upRSeg"><button data-v="targets">🎯 Цель апгрейда</button><button data-v="shop">🛒 Магазин</button></div>
      <input class="up-search hidden" id="upSearch" placeholder="Поиск брейнрота" autocomplete="off">
      <div id="upList"></div></div>
      </div>`;
    $('#pointer').style.transform = `rotate(${up.angle % 360}deg)`;
    up.angle = up.angle % 360;
    $$('#upSeg button').forEach((b) => (b.onclick = () => { up.tab = b.dataset.t; drawUpList(); }));
    $$('#upRSeg button').forEach((b) => (b.onclick = () => { if (up.spinning) return; up.view = b.dataset.v; drawRight(); }));
    $('#go').onclick = runUpgrade;
    bindSpeedSound(view);
    try {
      up.inv = (await api('/api/inventory')).filter((i) => i.status === 'owned');
    } catch (e) {
      return fail(e);
    }
    if (stale(t)) return;
    up.selected = up.selected.filter((id) => up.inv.some((i) => i.id === id));
    up.tab = up.selected.length ? 'right' : 'mine';
    if (up.selected.length) await loadTargets();
    $('#upSearch').oninput = (e) => { up.q = e.target.value.trim().toLowerCase(); drawRight(); };
    drawUpgrade();
  }

  let targetsSeq = 0;
  async function loadTargets() {
    const my = ++targetsSeq;
    up.data = null;
    up.target = null;
    up.loading = up.selected.length > 0;
    if (!up.selected.length) return;
    try {
      const data = await api('/api/upgrade/targets', { method: 'POST', body: { ids: up.selected } });
      if (my !== targetsSeq) return; // пока ждали, игрок уже выбрал другое — этот ответ устарел
      up.loading = false;
      up.data = data;
      const p = up.data.presets.find((x) => x.label === up.preset && x.target) || up.data.presets.find((x) => x.target);
      up.preset = p ? p.label : null;
      up.target = p ? p.target : null;
    } catch (e) {
      if (my === targetsSeq) up.loading = false;
      fail(e);
    }
  }

  function drawUpgrade({ lists = true } = {}) {
    const cfg = state.cfg.upgrade;
    const chance = up.target ? up.target.chance : 0;
    const arc = $('#arc');
    if (!arc) return;
    if (!up.spinning) {
      arc.setAttribute('stroke-dasharray', zoneDash(chance));
      arc.style.stroke = riskColor(chance);
    }
    $('#pct').textContent = `${fmt(chance)}%`;
    $('#rlbl').textContent = up.target ? 'шанс' : 'выбери брейнрота';

    const chosen = up.inv.filter((i) => up.selected.includes(i.id));
    const sum = chosen.reduce((a, i) => a + i.item.price, 0);
    const slotIn = $('#slotIn');
    slotIn.classList.toggle('full', chosen.length > 0);
    slotIn.innerHTML = chosen.length
      ? `<div class="imgs ${chosen.length === 1 ? 'one' : ''}">${chosen.map((i) => `<img src="${chosen.length === 1 ? itemImgBig(i.item.image) : itemImg(i.item.image)}" alt="">`).join('')}</div>
         <div>${chosen.length === 1 ? esc(chosen[0].item.name) : `${chosen.length} брейнрота`}</div>${price(sum)}`
      : `<div class="t">Твоя ставка</div><div class="t">выбери до ${cfg.maxItems} своих брейнротов</div>`;
    const slotOut = $('#slotOut');
    slotOut.classList.toggle('full', !!up.target);
    slotOut.innerHTML = up.target
      ? `<div class="imgs one"><img src="${itemImgBig(up.target.image)}" alt=""></div><div>${esc(up.target.name)}</div>${price(up.target.price)}`
      : `<div class="t">Цель</div><div class="t">${up.loading ? 'подбираю…' : chosen.length ? 'нет подходящих целей' : 'появится после выбора ставки'}</div>`;

    const presets = up.data?.presets || cfg.presets.map((p) => ({ ...p, target: null }));
    $('#mults').innerHTML = presets
      .map((p) => `<button class="chip ${up.preset === p.label && up.target ? 'on' : ''}" data-p="${p.label}" ${p.target ? '' : 'disabled'}>${p.label} <small>${fmt(p.chance)}%</small></button>`)
      .join('');
    $$('#mults .chip').forEach((b) => {
      b.onclick = () => {
        const p = up.data?.presets.find((x) => x.label === b.dataset.p);
        if (!p?.target || up.spinning) return;
        up.preset = p.label;
        up.target = p.target;
        tick();
        drawUpgrade({ lists: false });
      };
    });
    $('#go').disabled = !up.target || up.spinning;
    $$('#upSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === up.tab));
    if (lists) drawUpList();
    else markRight();
  }

  function drawUpList() {
    $$('#upSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === up.tab));
    const w = $('#upWrap');
    if (w) w.dataset.tab = up.tab;
    drawMine();
    drawRight();
  }

  // Слева (на телефоне — вкладка): свои брейнроты — выбрать ставку.
  // Список рисуется один раз на инвентарь; при выборе меняются только отметки (раньше перерисовывалось всё — отсюда лаги)
  function drawMine() {
    const box = $('#upMine');
    if (!box) return;
    const max = state.cfg.upgrade.maxItems;
    $('#upMineN').textContent = up.inv.length ? `${up.inv.length} шт.` : '';
    if (!up.inv.length) {
      box.innerHTML = '<div class="empty">Пока нечего апгрейдить. Открой кейс или купи брейнрота справа<a class="btn" href="#/">К кейсам</a></div>';
      box.dataset.sig = '';
      return;
    }
    const sig = up.inv.map((i) => i.id).join(',');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = `<div class="items">${up.inv
        .map((i) => `<button class="item rar-${esc(i.item.rarity)}" data-id="${i.id}">${ogTag(i.item)}${boughtTag(i)}<img loading="lazy" decoding="async" src="${itemImg(i.item.image)}" alt=""><div class="n">${esc(i.item.name)}</div>${price(i.item.price)}</button>`)
        .join('')}</div>`;
      box.onclick = async (ev) => {
        const b = ev.target.closest('.item[data-id]');
        if (!b || up.spinning) return;
        const id = Number(b.dataset.id);
        // тестовые и настоящие не смешиваем: выбрал другой вид — ставка начинается заново
        if (up.selected.length && (up.selected[0] < 0) !== (id < 0)) up.selected = [];
        if (up.selected.includes(id)) up.selected = up.selected.filter((x) => x !== id);
        else if (up.selected.length < state.cfg.upgrade.maxItems) up.selected.push(id);
        else return toast(`Можно поставить до ${state.cfg.upgrade.maxItems} брейнротов`, 'err', 3000);
        tick();
        markMine();
        const pending = loadTargets();
        drawUpgrade({ lists: false }); // ставка в слоте видна сразу, шансы подтянутся следом
        await pending;
        drawUpgrade();
      };
    }
    markMine(max);
  }
  function markMine(max = state.cfg.upgrade.maxItems) {
    const box = $('#upMine');
    if (!box) return;
    const full = up.selected.length >= max;
    for (const b of box.querySelectorAll('.item[data-id]')) {
      const sel = up.selected.includes(Number(b.dataset.id));
      b.classList.toggle('sel', sel);
      b.classList.toggle('dim', full && !sel);
    }
  }

  // Справа (на телефоне — вкладка «Брейнроты»): без ставки — магазин (купить за баланс), со ставкой — цели апгрейда.
  // Перерисовываем, только если поменялся сам список; выбор цели — просто отметка
  async function drawRight() {
    const box = $('#upList');
    if (!box) return;
    const search = $('#upSearch');
    const qy = up.q;
    const match = (it) => !qy || it.name.toLowerCase().includes(qy);
    const paint = (sig, html, bind) => {
      if (box.dataset.sig === sig) return false;
      box.dataset.sig = sig;
      box.innerHTML = html;
      box.onclick = bind || null;
      return true;
    };
    const shopView = !up.selected.length || up.view === 'shop';
    $$('#upRSeg button').forEach((b) => {
      b.classList.toggle('on', (b.dataset.v === 'shop') === shopView);
      b.disabled = b.dataset.v === 'targets' && !up.selected.length;
    });
    if (shopView) {
      $('#upRightHint').textContent = 'купить за баланс';
      search.classList.remove('hidden');
      if (!up.shop) {
        paint('loading', '<div class="skeleton" style="height:160px"></div>');
        try { up.shop = await api('/api/shop'); } catch (e) { box.innerHTML = ''; box.dataset.sig = ''; return fail(e); }
        if (up.selected.length || !$('#upList')) return drawRight();
      }
      if (!up.shop.enabled) return void paint('shop-off', '<div class="empty">Выбери своего брейнрота слева — здесь появятся цели для апгрейда</div>');
      const list = up.shop.items.filter(match).sort((a, b) => a.price - b.price || a.id - b.id);
      paint(`shop|${qy}`, `<div class="shop-warn">⚠️ <b>Брейнротов из магазина нельзя вывести.</b> Купленного можно поставить в апгрейд, сыграть в мистери или продать за ту же цену. А то, что выиграешь в апгрейде, выводится как обычно.</div>
        <div class="items">${list
          .map((it) => `<button class="item rar-${esc(it.rarity)}" data-id="${it.id}">${ogTag(it)}<img loading="lazy" decoding="async" src="${itemImg(it.image)}" alt=""><div class="n">${esc(it.name)}</div>${price(it.price)}<small class="buy-lbl">Купить</small></button>`)
          .join('') || '<div class="empty">Ничего не нашлось</div>'}</div>`, (ev) => {
        const b = ev.target.closest('.item[data-id]');
        if (b) buyShop(up.shop.items.find((x) => x.id === Number(b.dataset.id)));
      });
      return;
    }
    $('#upRightHint').textContent = 'цель апгрейда';
    if (!up.data) {
      // шансы ещё грузятся — оставляем прежний список, только без отметки
      $$('.item.sel', box).forEach((x) => x.classList.remove('sel'));
      return;
    }
    if (!up.data.targets?.length) {
      search.classList.add('hidden');
      paint('none', `<div class="empty">Нет брейнротов с шансом от ${state.cfg.upgrade.minChance}% до ${state.cfg.upgrade.maxChance}%. Измени ставку</div>`);
      return;
    }
    search.classList.remove('hidden');
    const targets = up.data.targets.filter(match).sort((a, b) => a.price - b.price || a.id - b.id);
    paint(`t|${up.data.inputValue}|${qy}|${targets.length}`, `<div class="items">${targets
      .map((it) => `<button class="item rar-${esc(it.rarity)}" data-id="${it.id}">${ogTag(it)}<img loading="lazy" decoding="async" src="${itemImg(it.image)}" alt=""><div class="n">${esc(it.name)}</div>${price(it.price)}<small class="muted">${fmt(it.chance)}%</small></button>`)
      .join('') || '<div class="empty">Ничего не нашлось</div>'}</div>`, (ev) => {
      const b = ev.target.closest('.item[data-id]');
      if (!b || up.spinning || !up.data) return;
      up.target = up.data.targets.find((x) => x.id === Number(b.dataset.id));
      up.preset = up.data.presets.find((p) => p.target?.id === up.target.id)?.label || null;
      tick();
      drawUpgrade({ lists: false });
      markRight();
    });
    markRight();
  }
  function markRight() {
    const box = $('#upList');
    if (!box) return;
    const id = up.target?.id;
    for (const b of box.querySelectorAll('.item[data-id]')) b.classList.toggle('sel', Number(b.dataset.id) === id);
  }

  async function buyShop(it) {
    if (!it || up.spinning) return;
    if ((state.me?.balance ?? 0) < it.price) {
      toast('Недостаточно BG на балансе', 'err');
      return openDeposit();
    }
    const ok = await confirmBox(`Купить «${it.name}» за ${fmt(it.price)} BG?\n\nКупленного брейнрота вывести нельзя — его можно поставить в апгрейд, сыграть в мистери или продать за ту же цену.`, { ok: 'Купить' });
    if (!ok) return;
    try {
      const r = await api('/api/shop/buy', { method: 'POST', body: { itemId: it.id, key: newKey() } });
      setBalance(r.balance);
      haptic('success');
      toast(`${r.item?.name || it.name} в инвентаре — выбран для апгрейда`);
      up.inv = (await api('/api/inventory')).filter((i) => i.status === 'owned');
      if (up.selected.length < state.cfg.upgrade.maxItems) up.selected.push(r.inventoryId);
      up.view = 'targets';
      await loadTargets();
      drawUpgrade();
    } catch (e) {
      fail(e);
    }
  }

  // Зона выигрыша — внизу круга: дуга из «chance» процентов с серединой на 6 часах.
  // Число с сервера (0–100) ложится на круг так: начало зоны + roll × 3,6°.
  const zoneStart = (pct) => 180 - pct * 1.8; // градусы от 12 часов по часовой
  const zoneDash = (pct, mid = pct / 2, size = pct) => `0 ${(C * (zoneStart(pct) + (mid - size / 2) * 3.6)) / 360} ${(C * size) / 100} ${C}`;
  const ptrAngle = (pct, roll) => zoneStart(pct) + roll * 3.6;
  // Крутка: сразу быстро, дальше долгое плавное торможение; в самом конце стрелка чуть «проезжает» вперёд
  // и мягко возвращается на число с сервера. Откат всегда меньше расстояния до края зоны — стрелка
  // никогда не пересекает границу, результат на экране = результат на сервере.
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const SPIN_MAIN = 0.87; // доля времени на основной прокрут, остальное — возврат «на место»
  const smooth = (u) => u * u * (3 - 2 * u);
  // доля пути (0…1+o) в момент x (0…1); o — «проезд» в долях всего пути
  const spinCurve = (x, o) => (!o ? ease(x) : x <= SPIN_MAIN ? (1 + o) * ease(x / SPIN_MAIN) : 1 + o - o * smooth((x - SPIN_MAIN) / (1 - SPIN_MAIN)));
  const SPIN_OVERSHOOT = false; // «проезд» вперёд и откат назад в конце — выключен по просьбе владельца
  const UP_LIN = (() => { try { return CSS.supports('animation-timing-function', 'linear(0, 1)'); } catch { return false; } })();
  const SPIN_PTS = 120;
  // насколько стрелка «проезжает» вперёд, градусы: до 5°, но не дальше половины пути до ближайшего края зоны
  function overshootDeg(toAngle, zone) {
    if (!zone) return 0;
    const size = zone.pct * 3.6;
    const fa = ((toAngle % 360) + 360) % 360;
    const rel = (fa - zoneStart(zone.pct) + 720) % 360;
    const fwd = rel < size ? size - rel : 360 - rel;
    return Math.max(0, Math.min(5, fwd * 0.45));
  }

  // Стрелка крутится через Web Animations (на видеокарте — не дёргается, даже если телефон занят).
  // В кадре JS только читает угол: яркость хвоста, подсветка зоны, «сердцебиение» на финише.
  function spinPointer(toAngle, dur, zone) {
    const ptr = $('#pointer');
    const tail = $('#ptrTail');
    const wrap = $('.ring-wrap');
    const from = up.angle;
    return new Promise((res) => {
      if (!ptr) return res();
      ptr.style.transition = 'none';
      const total = toAngle - from;
      const osDeg = !SPIN_OVERSHOOT || reduced || total <= 0 ? 0 : overshootDeg(toAngle, zone);
      const o = total > 0 ? osDeg / total : 0;
      // одна и та же кривая и для стрелки, и для расчёта моментов щелчков
      const pts = Array.from({ length: SPIN_PTS + 1 }, (_, i) => spinCurve(i / SPIN_PTS, o));
      const curve = UP_LIN
        ? (x) => { const k = Math.min(SPIN_PTS - 1, Math.floor(x * SPIN_PTS)); return pts[k] + (pts[k + 1] - pts[k]) * (x * SPIN_PTS - k); }
        : (x) => spinCurve(x, o);
      const anim = UP_LIN
        ? ptr.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${toAngle}deg)` }], { duration: dur, easing: `linear(${pts.map((v) => v.toFixed(6)).join(', ')})`, fill: 'forwards' })
        : !osDeg
        ? ptr.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${toAngle}deg)` }], { duration: dur, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'forwards' })
        : ptr.animate([
            { transform: `rotate(${from}deg)`, easing: 'cubic-bezier(0.08, 0.7, 0.16, 1)' },
            { transform: `rotate(${toAngle + osDeg}deg)`, offset: SPIN_MAIN, easing: 'ease-in-out' },
            { transform: `rotate(${toAngle}deg)` },
          ], { duration: dur, fill: 'forwards' });
      // звук: щелчок на каждом делении (15°) ровно в момент прохода стрелки (и туда, и обратно на откате).
      // На большой скорости — тише и через одно, к концу — громче и реже.
      const times = [];
      const strengths = [];
      if (total > 0) {
        const N = 8000;
        let prevA = from;
        let prevT = -1;
        for (let i = 1; i <= N; i++) {
          const a = from + total * curve(i / N);
          const b0 = Math.floor(prevA / 15), b1 = Math.floor(a / 15);
          if (b0 !== b1) {
            const line = (a > prevA ? b1 : b0) * 15;
            const t = ((i - 1 + (line - prevA) / (a - prevA)) / N) * dur / 1000;
            const gap = t - prevT;
            if (gap >= 0.022) {
              prevT = t;
              strengths.push(Math.max(0.3, Math.min(1, (gap - 0.015) / 0.12)));
              times.push(t);
            }
          }
          prevA = a;
        }
      }
      const ticks = sfx.spinTicks(times, strengths, { whoosh: false, lockAt: osDeg > 0.3 ? SPIN_MAIN * dur / 1000 : null });
      const zs = zone ? zoneStart(zone.pct) : 0;
      const zsize = zone ? zone.pct * 3.6 : 0;
      let prevA = from;
      let prevT = performance.now();
      let tailOp = -1;
      let hot = false;
      let tense = false;
      let over = false;
      const setCls = (c, on) => wrap && wrap.classList.toggle(c, on);
      const frame = (now) => {
        if (over || !ptr.isConnected) { if (!over) ticks.stop(); return; }
        const pr = anim.effect.getComputedTiming().progress;
        const a = pr == null ? toAngle : from + total * curve(pr);
        const speed = Math.abs(a - prevA) / Math.max(1, now - prevT); // градусов за мс
        if (tail) {
          const op = Math.round(Math.min(1, speed / 1.1) * 20) / 20;
          if (op !== tailOp) { tailOp = op; tail.style.opacity = op; }
        }
        // зона светится, когда стрелка медленно идёт по ней (на скорости не мигаем)
        if (zone) {
          const inZone = (((a - zs) % 360) + 360) % 360 < zsize;
          const h = speed < 0.45 && inZone;
          if (h !== hot) { hot = h; setCls('hot', h); }
        }
        // последние секунды: центр круга «бьётся», как сердце
        const t2 = speed < 0.12 && pr != null && pr > 0.4;
        if (t2 !== tense) { tense = t2; setCls('tense', t2); }
        prevA = a;
        prevT = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      const done = () => {
        over = true;
        setCls('hot', false);
        setCls('tense', false);
        if (tail) tail.style.opacity = 0;
      };
      anim.finished.then(() => {
        done();
        ptr.style.transform = `rotate(${toAngle}deg)`;
        anim.cancel();
        up.angle = toAngle;
        res();
      }, () => { done(); ticks.stop(); res(); });
    });
  }
  // Финал обычного апгрейда: вспышка, стрелка «защёлкивается», при победе — зелёные искры
  function upFlash(won) {
    const wrap = $('.ring-wrap');
    if (!wrap) return;
    wrap.classList.remove('u-win', 'u-lose');
    void wrap.offsetWidth;
    wrap.classList.add(won ? 'u-win' : 'u-lose');
    const burst = $('#goldBurst');
    if (burst && won && !reduced) {
      const n = 22;
      burst.innerHTML = Array.from({ length: n }, (_, i) => {
        const ang = (i / n) * 360 + Math.random() * 12;
        const dist = 110 + Math.random() * 80;
        return `<i style="--a:${ang}deg;--d:${dist}px;--s:${0.5 + Math.random() * 0.8};animation-delay:${Math.random() * 100}ms"></i>`;
      }).join('');
    }
  }
  const spinTo = (angle, turns) => up.angle - (up.angle % 360) + 360 * turns + angle;

  function setCenter(big, small, cls = '') {
    const rc = $('#rc');
    if (!rc) return;
    rc.className = 'ring-center ' + cls;
    $('#pct').textContent = big;
    $('#rlbl').textContent = small;
  }
  // Золото: в слоте цели — брейнрот, который уже твой на этом множителе (один, дороже цели)
  function slotOutMult(item, mult) {
    const slot = $('#slotOut');
    if (!slot || !item) return;
    slot.classList.add('full', 'gold');
    slot.innerHTML = `<div class="imgs one"><img src="${itemImgBig(item.image)}" alt=""><span class="mult-tag">×${mult}</span></div><div>${esc(item.name)}</div>${price(item.price)}`;
    slot.classList.remove('pop');
    void slot.offsetWidth;
    slot.classList.add('pop');
  }
  function goldFlash(kind = 'hit') {
    const wrap = $('.ring-wrap');
    if (!wrap) return;
    wrap.classList.remove('g-hit', 'g-up', 'g-lose');
    void wrap.offsetWidth;
    wrap.classList.add(kind === 'hit' ? 'g-hit' : kind === 'up' ? 'g-up' : 'g-lose');
    const burst = $('#goldBurst');
    if (burst && kind !== 'lose' && !reduced) {
      burst.innerHTML = Array.from({ length: kind === 'hit' ? 26 : 16 }, (_, i) => {
        const ang = (i / (kind === 'hit' ? 26 : 16)) * 360 + Math.random() * 10;
        const dist = 120 + Math.random() * 90;
        return `<i style="--a:${ang}deg;--d:${dist}px;--s:${0.6 + Math.random() * 0.8};animation-delay:${Math.random() * 120}ms"></i>`;
      }).join('');
    }
  }

  async function runUpgrade() {
    if (!up.target || up.spinning) return;
    const t = state.render;
    up.spinning = true;
    drawUpgrade();
    const wrap = $('.ring-wrap');
    const arc = $('#arc');
    const goldArc = $('#goldArc');
    wrap.classList.remove('gold-on', 'gold-mode', 'g-hit', 'g-up', 'g-lose', 'u-win', 'u-lose');
    lockNav(true);
    let r;
    try {
      r = await api('/api/upgrade', { method: 'POST', body: { ids: up.selected, targetId: up.target.id, key: newKey() } });
      if (r.target) {
        up.target = r.target;
        drawUpgrade({ lists: false });
      }
    } catch (e) {
      lockNav(false);
      up.spinning = false;
      drawUpgrade();
      return fail(e);
    }
    const fast = prefs.fast;
    const won = (r.inventoryIds || []).length ? r.inventoryIds : r.inventoryId ? [r.inventoryId] : [];
    try {
      // Золотая зона: появляется сразу при старте прокрута, в середине зелёной (внизу). Размер — настоящий шанс попасть в неё
      if (r.gold) {
        goldArc.setAttribute('stroke-dasharray', zoneDash(r.chance, (r.gold.from + r.gold.to) / 2, r.gold.to - r.gold.from));
        wrap.classList.add('gold-on');
        sfx.chime(0.7);
      }
      sfx.start();
      const dur = reduced ? 700 : fast ? 3200 : 10500;
      await spinPointer(spinTo(ptrAngle(r.chance, r.roll), reduced ? 1 : fast ? 6 : 16), dur, { pct: r.chance });
      if (stale(t)) return;

      if (r.gold?.hit) {
        // ЗОЛОТО: брейнрот ×2, дальше удвоения сами, пока везёт
        const g = r.gold;
        let mult = 2;
        const prizeAt = (m) => g.prizes?.find((x) => x.mult === m)?.item || r.prize;
        goldFlash('hit');
        sfx.gold(0);
        haptic('success');
        setCenter('×2', 'ЗОЛОТО!', 'gold');
        slotOutMult(prizeAt(2), 2);
        await sleep(fast ? 1100 : 2300);
        for (const st of g.ladder) {
          if (stale(t)) return;
          // круг становится золотым: зона = шанс удвоения, тоже внизу
          wrap.classList.add('gold-mode');
          wrap.classList.remove('gold-on', 'g-hit', 'g-up', 'g-lose');
          arc.style.stroke = 'url(#goldGrad)';
          arc.setAttribute('stroke-dasharray', zoneDash(g.step));
          setCenter(`×${mult}`, `${fmt(g.step)}% на ×${mult * 2}`, 'gold');
          await sleep(fast ? 350 : 900);
          sfx.start();
          await spinPointer(spinTo(ptrAngle(g.step, st.roll), reduced ? 1 : fast ? 2 : 4), reduced ? 500 : fast ? 1700 : 4600, { pct: g.step });
          if (stale(t)) return;
          if (st.won) {
            mult *= 2;
            goldFlash('up');
            sfx.gold(Math.log2(mult) - 1);
            haptic('success');
            setCenter(`×${mult}`, mult >= g.max ? 'Максимум!' : 'Удвоение!', 'gold');
            slotOutMult(prizeAt(mult), mult);
          } else {
            goldFlash('lose');
            sfx.upLose();
            haptic('warning');
            setCenter(`×${mult}`, 'Остаётся', 'gold lost');
          }
          await sleep(fast ? 900 : 1700);
        }
        if (!g.ladder.length || g.ladder[g.ladder.length - 1].won) setCenter(`×${mult}`, 'Максимум!', 'gold won');
        toast(`Золото ×${mult}! ${r.prize?.name || r.target.name} уже в инвентаре`);
        if (r.prize?.rarity === 'og') ogFx.boom(wrap);
        await sleep(fast ? 900 : 1600);
      } else {
        setCenter(`${fmt(r.chance)}%`, r.won ? 'Победа' : 'Проигрыш', r.won ? 'won' : 'lost');
        upFlash(r.won);
        if (r.won && r.target?.rarity === 'og') ogFx.boom(wrap);
        else if (r.won) sfx.upWin();
        else sfx.upLose();
        haptic(r.won ? 'success' : 'error');
        if (r.won) toast(`Апгрейд удался! ${r.target.name} уже в инвентаре`);
        await sleep(fast ? 1100 : 2200);
      }
      lockNav(false);
      if (stale(t)) return;
      wrap.classList.remove('gold-on', 'gold-mode', 'g-hit', 'g-up', 'g-lose', 'u-win', 'u-lose');
      $('#slotOut')?.classList.remove('gold', 'pop');
      setCenter('', '');
      up.selected = won.slice(0, state.cfg.upgrade.maxItems);
      up.spinning = false;
      try {
        up.inv = (await api('/api/inventory')).filter((i) => i.status === 'owned');
      } catch {}
      if (stale(t)) return;
      up.tab = up.selected.length ? 'right' : 'mine';
      await loadTargets();
      if (!stale(t)) drawUpgrade();
    } finally {
      lockNav(false);
      // Ушли со страницы — следующий экран апгрейда начнёт с чистого листа
      if (stale(t)) {
        up.spinning = false;
        up.selected = won.slice(0, state.cfg.upgrade.maxItems);
      }
    }
  }

  // =====================================================================
  //                               МИСТЕРИ
  // =====================================================================
  // Кладёшь одного брейнрота → он превращается в случайного другого (от 1/N до N× стоимости).
  // Результат решает сервер; анимация — только показ. Победы/поражения не пишем: просто открываем, что выпало.
  const mys = { inv: [], sel: null, info: null, busy: false };

  // =====================================================================
  //                         КОЛОР ДАЙС
  // 4 кубика по 6 цветов: выбираешь цвет и ставку, выплата за число кубиков твоего цвета.
  // =====================================================================
  const minesUI = { game: null, inv: [], pool: [], selected: null, busy: false };
  const mineGlyph = (bomb) => bomb
    ? '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="14" cy="19" r="9" fill="currentColor"/><path d="m20 12 4-4m-2-3 4 4m-1-8 1 3m3 2 3-1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m9 17 2-3" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 5h16l6 9-14 15L2 14z" fill="currentColor"/><path d="M2 14h28M8 5l8 24L24 5" fill="none" stroke="#103d2c" stroke-width="1.5"/></svg>';

  async function renderMines() {
    if (!(prefs.modded && prefs.minesEnabled)) {
      view.innerHTML='<div class="empty">Включи «Мины» в настройках раздела «Моддед»</div>';
      return;
    }
    const t=state.render;
    view.innerHTML='<div class="skeleton"></div>';
    try {
      const [current,inv,shop]=await Promise.all([api('/api/mines/current'),api('/api/inventory'),api('/api/shop')]);
      if (stale(t)) return;
      minesUI.game=current.game;
      minesUI.inv=inv.filter(i=>i.status==='owned'&&!i.test);
      minesUI.pool=shop.items;
      minesUI.busy=false;
      minesUI.selected=null;
      if (current.game) prefs.minesCount=current.game.mines;
      view.innerHTML=`<section class="mines-wrap"><div class="section-head"><h1>Мины</h1><span class="muted" id="minesStatus">Выбери ставку</span></div>
        <div class="mines-board" id="minesBoard" role="group" aria-label="Поле мин 5 на 5">${Array.from({length:25},(_,i)=>`<button class="mine-tile" data-tile="${i}" aria-label="Клетка ${i+1}"><span class="mine-flip"><span class="mine-front"><i></i></span><span class="mine-back"></span></span></button>`).join('')}</div>
        <div class="mines-stats"><div class="mines-stat"><label for="minesCount">Количество мин</label><input id="minesCount" type="number" min="1" max="24" step="1" inputmode="numeric" value="${prefs.minesCount}"></div><div class="mines-stat"><span>Множитель</span><b id="minesMult">×1</b></div><div class="mines-stat mines-return"><span>Получишь</span><div id="minesReward"></div></div></div>
        <button class="btn" id="minesGo">Начать</button>
        <div class="mines-stake" id="minesStake"></div><h2>Брейнрот для ставки</h2><div class="items" id="minesInv"></div></section>`;
      $$('#minesBoard [data-tile]').forEach(button=>button.onclick=()=>{
        if (!minesUI.game || minesUI.game.status!=='active' || minesUI.busy) return;
        minesMove('/api/mines/reveal',{gameId:minesUI.game.id,tile:Number(button.dataset.tile)});
      });
      $('#minesCount').oninput=()=>{
        const n=Number($('#minesCount').value);
        if(Number.isInteger(n)&&n>=1&&n<=24){prefs.minesCount=n;savePrefs();}
        drawMinesSummary();
      };
      $('#minesGo').onclick=()=>{
        if(minesUI.busy)return;
        const game=minesUI.game;
        if(game?.status==='active')return minesMove('/api/mines/cashout',{gameId:game.id});
        const item=minesUI.inv.find(i=>i.id===minesUI.selected);
        const n=Number($('#minesCount').value);
        if(!item||!Number.isInteger(n)||n<1||n>24)return;
        minesMove('/api/mines/start',{ids:[item.id],mines:n});
      };
      drawMinesInventory();drawMinesBoard();drawMinesSummary();
    } catch(e){if(!stale(t)){view.innerHTML='<div class="empty">Не удалось открыть мины</div>';fail(e);}}
  }

  function drawMinesInventory(){
    const box=$('#minesInv');if(!box)return;
    box.innerHTML=minesUI.inv.length?minesUI.inv.map(i=>`<button class="item rar-${esc(i.item.rarity)} ${minesUI.selected===i.id?'sel':''}" data-mine-item="${i.id}" ${minesUI.game?.status==='active'||minesUI.busy?'disabled':''}>${ogTag(i.item)}<img src="${itemImg(i.item.image)}" alt=""><div class="n">${esc(i.item.name)}</div>${price(i.item.price)}</button>`).join(''):'<div class="empty">Нет брейнротов для ставки. Открой кейс или выдай предмет в админке</div>';
    $$('[data-mine-item]',box).forEach(button=>button.onclick=()=>{
      if(minesUI.busy||minesUI.game?.status==='active')return;
      minesUI.selected=Number(button.dataset.mineItem);
      drawMinesInventory();drawMinesSummary();
    });
  }

  function drawMinesBoard(){
    const game=minesUI.game;const active=game?.status==='active';
    $$('#minesBoard [data-tile]').forEach(button=>{
      const tile=Number(button.dataset.tile);
      const opened=game?.revealed.includes(tile);
      const bomb=game?.bombs.includes(tile);
      const flip=!!game&&(opened||game.status!=='active');
      $('.mine-back',button).innerHTML=mineGlyph(bomb);
      button.classList.toggle('bomb',!!bomb);
      button.classList.toggle('mine-dim',flip&&!opened&&tile!==game?.payout?.bomb);
      button.disabled=!active||opened||minesUI.busy;
      button.setAttribute('aria-label',flip?(bomb?'Мина':'Алмаз'):`Клетка ${tile+1}`);
      requestAnimationFrame(()=>button.classList.toggle('flipped',flip));
    });
  }

  function drawMinesSummary(){
    if(!$('#minesGo'))return;
    const game=minesUI.game;const active=game?.status==='active';
    const item=active?game.stake:minesUI.inv.find(i=>i.id===minesUI.selected)?.item;
    let reward=game&&!minesUI.selected?game.reward:null;
    if(!reward&&item){const nearest=[...minesUI.pool].filter(i=>i.price<=item.price).sort((a,b)=>b.price-a.price||a.id-b.id)[0];reward={item:nearest||null,coins:Math.round((item.price-(nearest?.price||0))*100)/100,total:item.price};}
    $('#minesCount').disabled=active||minesUI.busy;
    $('#minesMult').textContent='×'+fmt(game&&!minesUI.selected?game.multiplier:1);
    $('#minesReward').innerHTML=reward?`${reward.item?`<div class="mines-prize"><img src="${itemImg(reward.item.image)}" alt=""><span>${esc(reward.item.name)}</span></div>`:''}<b>${price(reward.total)}</b>${reward.coins>0?`<small>+ ${fmt(reward.coins)} BG доплатой</small>`:''}`:'<span class="muted">Выбери ставку</span>';
    $('#minesStake').innerHTML=item?`Ставка: <b>${esc(item.name)}</b> · ${price(item.price)}`:'';
    $('#minesStatus').textContent=active?`Открыто ${game.revealed.length} из ${25-game.mines}`:game?.status==='lost'?'Мина — ставка проиграна':game?.status==='cashed'?'Награда в инвентаре':'Выбери ставку';
    const go=$('#minesGo');go.textContent=minesUI.busy?'Подожди':active?'Забрать '+fmt(game.reward.total)+' BG':game?'Начать новую игру':'Начать';
    const n=Number($('#minesCount').value);
    go.disabled=minesUI.busy||(!active&&(!item||!Number.isInteger(n)||n<1||n>24));
  }

  async function minesMove(path,body){
    if(minesUI.busy)return;
    const t=state.render;minesUI.busy=true;drawMinesBoard();drawMinesSummary();drawMinesInventory();
    try{
      const r=await api(path,{method:'POST',body:{...body,key:newKey()}});
      minesUI.game=r.game;minesUI.selected=null;
      if(r.balance!==undefined)setBalance(r.balance);
      minesUI.inv=(await api('/api/inventory')).filter(i=>i.status==='owned'&&!i.test);
      if(r.game.status==='lost'){haptic('error');sfx.upLose();}
      else if(r.game.status==='cashed'){haptic('success');sfx.upWin();toast('Получено '+fmt(r.game.payout.total)+' BG предметом и доплатой');}
      else tick();
    }catch(e){fail(e);try{minesUI.game=(await api('/api/mines/current')).game;}catch{}}
    finally{minesUI.busy=false;if(!stale(t)){drawMinesBoard();drawMinesSummary();drawMinesInventory();}}
  }

  const dice = { color: 0, sel: [], inv: [], busy: false };
  const RAINBOW = 6;
  const diceFace = (c, cls = '') => `<div class="cd-die ${cls}" style="--c:${esc(c.hex)}"><i></i></div>`;
  // цвет грани: 0–5 — цвета, 6 — разноцветная
  const faceOf = (d) => (d === RAINBOW ? { hex: '#ffffff', rainbow: true } : state.cfg.dice.colors[d]);
  const setFace = (el, d) => { const f = faceOf(d); el.style.setProperty('--c', f.hex); el.classList.toggle('rainbow', !!f.rainbow); };
  const multText = (m) => (m === 2 ? 'твой брейнрот + ещё такой же' : `твой брейнрот + ещё ${m - 1} таких же`);

  // =====================================================================
  //                 ХЭЛЛОУИН (включается настройкой в админке)
  // =====================================================================
  // Всё оформление — отдельным слоем поверх страниц (клики проходят насквозь) и паутинки в углах карточек.
  // Выключили настройку «Хэллоуин-оформление» — при следующем заходе сайт обычный.
  const HW_WEB = '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M0 0L118.0 0.0M0 0L108.2 29.0M0 0L95.0 59.4M0 0L72.0 85.8M0 0L42.0 103.8M0 0L11.7 111.4M0 0L0.0 118.0M20.0 0.0Q16.1 2.1 19.3 5.2Q14.9 6.5 17.0 10.6Q12.2 10.6 12.9 15.3Q8.3 13.9 7.5 18.5Q3.9 15.8 2.1 19.9Q0.9 16.4 0.0 20.0M38.0 0.0Q30.6 4.0 36.7 9.8Q28.3 12.3 32.2 20.1Q23.2 20.2 24.4 29.1Q15.9 26.4 14.2 35.2Q7.5 29.9 4.0 37.8Q1.6 31.1 0.0 38.0M58.0 0.0Q46.7 6.2 56.0 15.0Q43.1 18.8 49.2 30.7Q35.5 30.8 37.3 44.4Q24.2 40.3 21.7 53.8Q11.4 45.7 6.1 57.7Q2.5 47.4 0.0 58.0M80.0 0.0Q64.5 8.5 77.3 20.7Q59.5 25.9 67.8 42.4Q48.9 42.5 51.4 61.3Q33.4 55.5 30.0 74.2Q15.7 63.0 8.4 79.6Q3.4 65.4 0.0 80.0M104.0 0.0Q83.8 11.0 100.5 26.9Q77.3 33.6 88.2 55.1Q63.6 55.3 66.8 79.7Q43.4 72.2 39.0 96.4Q20.4 81.9 10.9 103.4Q4.5 85.0 0.0 104.0"/></svg>';
  const HW_BAT = '<svg viewBox="0 0 64 20" aria-hidden="true"><path d="M32,9 34,4 35,1 36,5 39,6 44,3 52,1 63,4 58,8 56,13 52,11 48,12 46,16 42,14 38,16 35,13 33,15 32,19 32,19 31,15 29,13 26,16 22,14 18,16 16,12 12,11 8,13 6,8 1,4 12,1 20,3 25,6 28,5 29,1 30,4 32,9Z"/></svg>';
  const HW_SPIDER = '<svg viewBox="0 0 40 40" aria-hidden="true"><g stroke="#9aa59f" stroke-width="2.2" fill="none" stroke-linecap="round"><path d="M14 18 6 12 3 4M14 21 4 20 1 14M14 24 5 28 2 35M15 26 9 34 8 39M26 18 34 12 37 4M26 21 36 20 39 14M26 24 35 28 38 35M25 26 31 34 32 39"/></g><ellipse cx="20" cy="17" rx="5" ry="5" fill="#4a524f"/><ellipse cx="20" cy="27" rx="7.5" ry="8.5" fill="#56605c"/><circle cx="18" cy="16" r="1.3" fill="#ff5d5d"/><circle cx="22" cy="16" r="1.3" fill="#ff5d5d"/></svg>';
  const HW_PUMPKIN = '<svg viewBox="0 0 64 58" aria-hidden="true"><path d="M30 12c0-5 1-9 5-11l2 3c-3 2-3 5-3 8z" fill="#5d7a2a"/><ellipse cx="18" cy="35" rx="15" ry="20" fill="#d9600a"/><ellipse cx="46" cy="35" rx="15" ry="20" fill="#d9600a"/><ellipse cx="32" cy="35" rx="15" ry="21" fill="#ff8a1f"/><ellipse cx="25" cy="34" rx="5" ry="18" fill="#f07714" opacity=".7"/><ellipse cx="39" cy="34" rx="5" ry="18" fill="#f07714" opacity=".7"/><path d="M17 28l7-7 4 9zM47 28l-7-7-4 9z" fill="#ffd84a"/><path d="M15 39c6 7 28 7 34 0l-4 2-3-3-4 4-4-4-4 4-4-4-3 3z" fill="#ffd84a"/></svg>';
  // куда вешаем паутинку и в какой угол
  const HW_SPOTS = [['.case-card', ['tr']], ['.case-head', ['tl', 'tr']], ['.cd-stage', ['tl', 'tr']], ['.cd-panel', ['tr']], ['.ring-wrap', ['tl', 'tr']], ['.slot', ['tr']], ['.mys-stage', ['tl', 'tr']], ['.gw-empty', ['tl', 'br']], ['.promo-card', ['tr']]];
  let hwObs = null;
  let hwQueued = false;
  function hwDecorate() {
    hwQueued = false;
    for (const [sel, corners] of HW_SPOTS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.querySelector(':scope > .hw-web')) continue;
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.insertAdjacentHTML('beforeend', corners.map((k) => `<span class="hw-web ${k}">${HW_WEB}</span>`).join(''));
      }
    }
  }
  function halloween(on) {
    document.documentElement.classList.toggle('halloween', on);
    if (!on) {
      hwObs?.disconnect();
      hwObs = null;
      $('#hwLayer')?.remove();
      $$('.hw-web, .hw-pumpkin').forEach((el) => el.remove());
      return;
    }
    if (!$('#hwLayer')) {
      const bats = [1, 2, 3].map((i) => `<div class="hw-bat b${i}"><i>${HW_BAT}</i></div>`).join('');
      const spiders = [1, 2].map((i) => `<div class="hw-hang s${i}"><b></b>${HW_SPIDER}</div>`).join('');
      document.body.insertAdjacentHTML('beforeend', `<div id="hwLayer" aria-hidden="true">
        <span class="hw-corner l">${HW_WEB}</span><span class="hw-corner r">${HW_WEB}</span>
        ${spiders}${bats}<div class="hw-fog"></div><span class="hw-pk l">${HW_PUMPKIN}</span><span class="hw-pk r">${HW_PUMPKIN}</span></div>`);
    }
    const logo = document.querySelector('.topbar a[aria-label="На главную"]');
    if (logo && !logo.querySelector('.hw-pumpkin')) logo.insertAdjacentHTML('beforeend', `<span class="hw-pumpkin">${HW_PUMPKIN}</span>`);
    hwDecorate();
    if (!hwObs) {
      hwObs = new MutationObserver(() => { if (!hwQueued) { hwQueued = true; requestAnimationFrame(hwDecorate); } });
      hwObs.observe(view, { childList: true, subtree: true });
    }
  }

  // =====================================================================
  //                             РОЗЫГРЫШИ
  // =====================================================================
  // Приз — брейнрот. Участвует тот, кто с начала розыгрыша пополнил баланс на нужную сумму; один раз, номер — по порядку.
  // Победителя в конце выбирает сервер, брейнрот сразу падает в инвентарь, бот пишет победителю.
  async function renderGiveaways() {
    const t = state.render;
    const hero = `<div class="gw-hero"><img class="gw-griffin" src="${mascot('gwLeft')}" alt=""><h1 class="gw-title">РОЗЫГРЫШИ</h1><img class="gw-griffin flip" src="${mascot('gwRight')}" alt=""></div>`;
    view.innerHTML = `<div class="gw-wrap">${hero}<div id="gwBody"><div class="skeleton" style="height:240px"></div></div></div>`;
    let data;
    try {
      data = await api('/api/giveaways');
    } catch (e) {
      return fail(e);
    }
    if (stale(t)) return;
    // часы сервера: таймер не зависит от неправильного времени на телефоне
    const skew = Date.now() - new Date(data.now).getTime();
    const left = (g) => new Date(g.endsAt).getTime() - (Date.now() - skew);
    // «9 д 23 ч 58 мин»; последний час — с секундами
    const dhm = (ms) => {
      const t = Math.max(0, Math.floor(ms / 1000));
      const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
      const u = (n, w) => `${n}<i>${w}</i>`;
      if (d) return u(d, 'дн') + u(h, 'ч') + u(m, 'мин');
      if (h) return u(h, 'ч') + u(m, 'мин');
      return u(m, 'мин') + u(sec, 'сек');
    };
    // паутина по четырём углам карточки и паучок на нитке
    const WEB = '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M0 0L118.0 0.0M0 0L108.2 29.0M0 0L95.0 59.4M0 0L72.0 85.8M0 0L42.0 103.8M0 0L11.7 111.4M0 0L0.0 118.0M20.0 0.0Q16.1 2.1 19.3 5.2Q14.9 6.5 17.0 10.6Q12.2 10.6 12.9 15.3Q8.3 13.9 7.5 18.5Q3.9 15.8 2.1 19.9Q0.9 16.4 0.0 20.0M38.0 0.0Q30.6 4.0 36.7 9.8Q28.3 12.3 32.2 20.1Q23.2 20.2 24.4 29.1Q15.9 26.4 14.2 35.2Q7.5 29.9 4.0 37.8Q1.6 31.1 0.0 38.0M58.0 0.0Q46.7 6.2 56.0 15.0Q43.1 18.8 49.2 30.7Q35.5 30.8 37.3 44.4Q24.2 40.3 21.7 53.8Q11.4 45.7 6.1 57.7Q2.5 47.4 0.0 58.0M80.0 0.0Q64.5 8.5 77.3 20.7Q59.5 25.9 67.8 42.4Q48.9 42.5 51.4 61.3Q33.4 55.5 30.0 74.2Q15.7 63.0 8.4 79.6Q3.4 65.4 0.0 80.0M104.0 0.0Q83.8 11.0 100.5 26.9Q77.3 33.6 88.2 55.1Q63.6 55.3 66.8 79.7Q43.4 72.2 39.0 96.4Q20.4 81.9 10.9 103.4Q4.5 85.0 0.0 104.0"/></svg>';
    const webs = ['tl', 'tr', 'bl', 'br'].map((k) => `<span class="gw-web ${k}">${WEB}</span>`).join('')
      + '<span class="gw-spider" aria-hidden="true"><i></i><svg viewBox="0 0 40 40"><g stroke="#9aa59f" stroke-width="2.2" fill="none" stroke-linecap="round"><path d="M14 18 6 12 3 4M14 21 4 20 1 14M14 24 5 28 2 35M15 26 9 34 8 39M26 18 34 12 37 4M26 21 36 20 39 14M26 24 35 28 38 35M25 26 31 34 32 39"/></g><ellipse cx="20" cy="17" rx="5" ry="5" fill="#4a524f"/><ellipse cx="20" cy="27" rx="7.5" ry="8.5" fill="#56605c"/><circle cx="18" cy="16" r="1.3" fill="#ff5d5d"/><circle cx="22" cy="16" r="1.3" fill="#ff5d5d"/></svg></span>';
    const card = (g) => {
      const joined = g.myNum != null;
      const need = g.needDeposit;
      const pct = need > 0 ? Math.min(100, Math.round((g.deposited / need) * 100)) : 100;
      const action = joined
        ? `<div class="gw-in">✅ Ты участвуешь — твой номер <b>№${fmt(g.myNum)}</b></div>`
        : g.canJoin
          ? `<button class="btn gw-join" data-join="${g.id}">Участвовать</button>`
          : `<button class="btn gw-join ghost" data-dep="${g.id}">Пополнить на ${fmt(Math.max(0, Math.round((need - g.deposited) * 100) / 100))} BG</button>`;
      return `
        <section class="gw-card rar-${esc(g.item.rarity)}" data-id="${g.id}">
          ${webs}
          <div class="gw-prize">
            <div class="gw-glow"></div>
            <img src="${itemImgBig(g.item.image)}" alt="">
            <div class="gw-name">${esc(g.item.name)}</div>
            <div class="gw-price">${price(g.item.price)}</div>
          </div>
          <div class="gw-info">
            <div class="gw-timer"><span class="muted">До конца</span><b class="mono" data-left="${g.id}">${dhm(left(g))}</b></div>
            <div class="gw-stats">
              <div><span class="muted">Участников</span><b>${fmt(g.participants)}</b></div>
              <div><span class="muted">Твой номер</span><b>${joined ? '№' + fmt(g.myNum) : '—'}</b></div>
            </div>
            <div class="gw-need">
              ${need > 0
                ? `<div class="gw-need-t"><span>Для участия пополни баланс от <b>${price(need)}</b></span><span class="muted">${fmt(g.deposited)} / ${fmt(need)}</span></div>
                   <div class="gw-bar"><i style="width:${pct}%"></i></div>
                   <p class="muted">Считаются пополнения звёздами и брейнротами с начала розыгрыша</p>`
                : '<div class="gw-need-t"><span>Участие <b>бесплатное</b></span></div>'}
            </div>
            ${action}
          </div>
        </section>`;
    };
    const past = (g) => `
      <div class="gw-past rar-${esc(g.item.rarity)}">
        <img src="${itemImg(g.item.image)}" alt="">
        <div class="gw-past-n"><b>${esc(g.item.name)}</b>${price(g.item.price)}</div>
        <div class="gw-past-w">${g.winner ? `${g.winner.me ? '🎉 <b>Ты победил!</b>' : `Победил <b>${esc(g.winner.name)}</b>`} · №${fmt(g.winner.num)} из ${fmt(g.participants)}` : '<span class="muted">Участников не было</span>'}</div>
      </div>`;
    $('#gwBody').innerHTML = (data.active.length
      ? data.active.map(card).join('')
      : `<div class="gw-empty"><p>Сейчас розыгрышей нет.</p><span class="muted">Как только начнётся новый розыгрыш, он появится на этой странице.</span></div>`)
      + (data.finished.length ? `<h2>Прошедшие розыгрыши</h2><div class="gw-past-list">${data.finished.map(past).join('')}</div>` : '');
    $$('[data-join]', view).forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api(`/api/giveaways/${b.dataset.join}/join`, { method: 'POST', body: {} });
        haptic('success');
        toast(r.already ? `Ты уже участвуешь — №${r.num}` : `Ты в розыгрыше! Твой номер — №${r.num}`);
      } catch (e) {
        fail(e);
      }
      if (!stale(t)) renderGiveaways();
    }));
    $$('[data-dep]', view).forEach((b) => (b.onclick = () => openDeposit()));
    // таймеры; закончился — через пару секунд обновляем (сервер подведёт итоги)
    let reloading = false;
    if (gwTimer) clearInterval(gwTimer);
    gwTimer = setInterval(() => {
      if (stale(t)) return;
      for (const g of data.active) {
        const el = $(`[data-left="${g.id}"]`);
        const ms = left(g);
        if (el) el.innerHTML = ms > 0 ? dhm(ms) : 'итоги…';
        if (ms <= -3000 && !reloading) { reloading = true; setTimeout(() => !stale(t) && renderGiveaways(), 2000); }
      }
    }, 1000);
    state.timers.push(gwTimer);
  }
  let gwTimer = null;

  async function renderDice() {
    const t = state.render;
    const cfg = state.cfg.dice;
    dice.busy = false;
    if (!cfg?.enabled) {
      view.innerHTML = '<div class="empty">Колор Дайс скоро вернётся</div>';
      return;
    }
    const colors = cfg.colors;
    // правила: «N из 4 — выплата», проигрыш красным, выигрыш зелёным, внизу бонус за разноцветный кубик
    const ruleRow = (label, mult, extra = '') => `<div class="cd-rule ${mult > 0 ? 'win' : 'lose'} ${extra}"><span class="cd-rule-k">${label}</span><b>${mult > 0 ? '×' + fmt(mult) : 'проигрыш'}</b></div>`;
    const rulesHtml = [ruleRow('Не одного совпадения', 0), ...cfg.table.map((r) => ruleRow(`${r.hits} из 4`, r.mult))].join('')
      + (cfg.rainbow ? ruleRow('<i class="cd-rbdot rbw"></i>БОНУС', cfg.rainbow.mult, 'rb') : '')
      + `<p class="cd-rule-note">Выиграл — твой брейнрот остаётся и к нему добавляются такие же (×2 — ещё один, ×3 — ещё два…). Проиграл — сгорает.</p>`;
    view.innerHTML = `
      <div class="cd-wrap">
        <aside class="cd-panel cd-rules">
          <div class="cd-panel-h">Правила</div>
          <div class="cd-rules-list">${rulesHtml}</div>
        </aside>
        <div class="cd-center">
          <section class="cd-stage">
            <div class="cd-top">
              <div class="cd-dice" id="cdDice">${[0, 1, 2, 3].map((i) => diceFace(colors[(dice.color + i) % 6], 'idle')).join('')}</div>
              <div class="cd-slot hidden" id="cdSlot"></div>
            </div>
            <div class="cd-result hidden" id="cdRes"></div>
          </section>
          <div class="cd-colors" id="cdColors">${colors.map((c) => `<button class="cd-color" data-c="${c.id}" style="--c:${esc(c.hex)}" aria-label="${esc(c.name)}"><i></i><span>${esc(c.name)}</span></button>`).join('')}</div>
          <div class="up-ctrl cd-ctrl">${speedSoundHtml()}</div>
          <button class="btn cd-go" id="cdGo" disabled>Крутить Колор Дайс</button>
          <p class="hint center cd-note">Выбери брейнрота и цвет, желаю удачи <img class="cd-luck" src="${mascot('luck')}" alt=""></p>
        </div>
        <aside class="cd-panel cd-histbox">
          <div class="cd-panel-h">Твои броски</div>
          <div id="cdHist" class="cd-hist"><div class="skeleton" style="height:60px"></div></div>
        </aside>
        <div class="cd-invbox">
          <div class="section-head"><h2>Выбери брейнрота</h2><span class="muted" id="cdSelN"></span></div>
          <div id="cdInv"><div class="skeleton" style="height:120px"></div></div>
        </div>
      </div>`;
    const markColor = () => $$('.cd-color', view).forEach((b) => b.classList.toggle('on', Number(b.dataset.c) === dice.color));
    markColor();
    $$('.cd-color', view).forEach((b) => (b.onclick = () => { if (dice.busy) return; dice.color = Number(b.dataset.c); haptic('success'); markColor(); }));
    $('#cdGo').onclick = rollDice;
    bindSpeedSound(view);
    loadDiceHist(t);
    await loadDiceInv(t);
  }

  async function loadDiceInv(t) {
    try {
      dice.inv = (await api('/api/inventory')).filter((i) => i.status === 'owned' && !i.test && !i.item.coins);
    } catch (e) {
      return fail(e);
    }
    if (t && stale(t)) return;
    dice.sel = dice.sel.filter((id) => dice.inv.some((i) => i.id === id));
    drawDiceInv();
  }

  function drawDiceInv() {
    const cfg = state.cfg.dice;
    const box = $('#cdInv');
    if (!box) return;
    const sum = dice.inv.filter((i) => dice.sel.includes(i.id)).reduce((a, i) => a + i.item.price, 0);
    const full = dice.sel.length >= cfg.maxItems;
    box.innerHTML = dice.inv.length
      ? `<div class="items">${[...dice.inv].sort((a, b) => b.item.price - a.item.price).map((i) => {
          const on = dice.sel.includes(i.id);
          const off = !on && (full || sum + i.item.price > cfg.max);
          return `<button class="item rar-${esc(i.item.rarity)} ${on ? 'sel' : ''} ${off ? 'dim' : ''}" data-id="${i.id}">${ogTag(i.item)}${boughtTag(i)}<img loading="lazy" decoding="async" src="${itemImg(i.item.image)}" alt=""><div class="n">${esc(i.item.name)}</div>${price(i.item.price)}</button>`;
        }).join('')}</div>`
      : '<div class="empty">У тебя пока нет брейнротов. Открой кейс или купи в апгрейдере — и возвращайся</div>';
    box.onclick = (ev) => {
      const b = ev.target.closest('.item[data-id]');
      if (!b || dice.busy) return;
      const id = Number(b.dataset.id);
      if (dice.sel.includes(id)) dice.sel = dice.sel.filter((x) => x !== id);
      else {
        const it = dice.inv.find((x) => x.id === id);
        if (dice.sel.length >= cfg.maxItems) return toast(`Можно поставить до ${cfg.maxItems} брейнротов`, 'err');
        if (sum + it.item.price > cfg.max) return toast(`Ставка — до ${fmt(cfg.max)} BG вместе`, 'err');
        dice.sel.push(id);
      }
      haptic('success');
      drawDiceInv();
    };
    drawDiceSlot();
  }

  function drawDiceSlot() {
    const cfg = state.cfg.dice;
    const slot = $('#cdSlot');
    if (!slot) return;
    const chosen = dice.inv.filter((i) => dice.sel.includes(i.id));
    const sum = chosen.reduce((a, i) => a + i.item.price, 0);
    slot.classList.toggle('full', chosen.length > 0);
    slot.classList.toggle('hidden', !chosen.length); // пустой слот не показываем — выбор и так внизу
    slot.innerHTML = chosen.length
      ? `<div class="cd-slot-imgs">${chosen.map((i) => `<img src="${itemImg(i.item.image)}" alt="">`).join('')}</div><div class="cd-slot-sum">${price(sum)}</div>`
      : '';
    slot.onclick = () => $('#cdInv')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const n = $('#cdSelN');
    if (n) n.textContent = chosen.length ? `${chosen.length} из ${cfg.maxItems}` : `до ${cfg.maxItems} шт.`;
    const go = $('#cdGo');
    if (go && !dice.busy) go.disabled = !chosen.length || sum < cfg.min;
  }

  async function loadDiceHist(t) {
    let list = [];
    try { list = await api('/api/dice/my'); } catch {}
    if (t && stale(t)) return;
    const box = $('#cdHist');
    if (!box) return;
    const colors = state.cfg.dice.colors;
    box.innerHTML = list.length
      ? list.map((r) => {
          const rb = r.dice.includes(RAINBOW);
          const win = r.net > 0;
          const label = rb ? '<i class="cd-rbdot rbw"></i>БОНУС' : `${r.hits} из 4`;
          return `<div class="cd-h2 ${rb && win ? 'rb' : win ? 'win' : 'lose'}"><span class="cd-hc" style="--c:${esc(colors[r.color].hex)}"></span><span class="cd-h2-k">${label}</span><span class="cd-h2-v">${win ? `×${fmt(r.mult)}` : 'проигрыш'}</span></div>`;
        }).join('')
      : '<div class="empty">Здесь появятся твои броски</div>';
  }

  async function rollDice() {
    if (dice.busy) return;
    const cfg = state.cfg.dice;
    if (!dice.sel.length) return toast('Выбери брейнрота для ставки', 'err');
    dice.busy = true;
    const t = state.render;
    const go = $('#cdGo');
    go.disabled = true;
    const colors = cfg.colors;
    const box = $('#cdDice');
    const res = $('#cdRes');
    res.className = 'cd-result';
    res.textContent = 'Крутим…';
    // ⚡ «Быстро» — короткий прокрут; обычный — медленнее, кубики останавливаются по одному
    const fast = !!prefs.fast;
    const T = fast ? { step: 70, min: 350, gap: 110, slow: [] } : { step: 130, min: 1300, gap: 450, slow: [] };
    box.classList.toggle('fast', fast);
    box.innerHTML = [0, 1, 2, 3].map(() => diceFace(colors[0], 'spin')).join('');
    const dies = $$('.cd-die', box);
    const face = dies.map((_, i) => (i * 2) % 6);
    let k = 0;
    // каждый крутящийся кубик листает цвета; изредка мелькает разноцветный
    const flick = setInterval(() => {
      dies.forEach((d, i) => {
        if (!d.classList.contains('spin')) return;
        face[i] = (face[i] + 1 + ((k + i) % 2)) % 6;
        setFace(d, (k + i * 3) % 17 === 16 ? RAINBOW : face[i]);
      });
      k++;
      if (!fast && k % 2 === 0) sfx.tick(0.4);
    }, T.step);
    try { sfx.whoosh(); } catch {}
    let r;
    try {
      [r] = await Promise.all([api('/api/dice', { method: 'POST', body: { color: dice.color, ids: dice.sel, key: newKey() } }), sleep(T.min)]);
    } catch (e) {
      clearInterval(flick);
      dice.busy = false;
      if (!stale(t)) {
        box.innerHTML = [0, 1, 2, 3].map((i) => diceFace(colors[(dice.color + i) % 6], 'idle')).join('');
        drawDiceSlot();
      }
      return fail(e);
    }
    if (stale(t)) { clearInterval(flick); dice.busy = false; return; }
    // кубики останавливаются по одному: перед остановкой цвета мелькают всё медленнее
    for (let i = 0; i < 4; i++) {
      const d = dies[i];
      if (stale(t)) break;
      d.classList.add('slowing');
      for (const ms of T.slow) {
        d.classList.remove('spin');
        face[i] = (face[i] + 1) % 6;
        setFace(d, face[i]);
        try { sfx.tick(0.6); } catch {}
        await sleep(ms);
      }
      d.classList.remove('spin', 'slowing');
      setFace(d, r.dice[i]);
      const good = r.rainbow ? r.dice[i] === RAINBOW : r.dice[i] === r.color;
      d.classList.add('land', good ? 'hit' : 'miss');
      try { sfx.clack(); } catch {}
      if (i < 3) await sleep(T.gap);
    }
    clearInterval(flick);
    if (stale(t)) { dice.busy = false; return; }
    const got = r.wonIds?.length || 0;
    if (r.mult > 0) {
      res.className = `cd-result win ${r.rainbow ? 'rb' : ''}`;
      res.innerHTML = `${r.rainbow ? '🌈 Разноцветный кубик' : `${r.hits} ${plural(r.hits, 'кубик', 'кубика', 'кубиков')} твоего цвета`} — <b>×${fmt(r.mult)}</b>! ${got ? `+${got} ${plural(got, 'брейнрот', 'брейнрота', 'брейнротов')} в инвентарь` : ''}`;
      haptic('success');
      try { sfx.chime(r.rainbow ? 1 : 0.5); } catch {}
      toast(`${r.rainbow ? '🌈 ' : ''}×${fmt(r.mult)}! +${got} ${plural(got, 'брейнрот', 'брейнрота', 'брейнротов')} в инвентарь`);
    } else {
      res.className = 'cd-result lose';
      res.innerHTML = r.hits ? `${r.hits} ${plural(r.hits, 'кубик', 'кубика', 'кубиков')} твоего цвета — не повезло, брейнроты сгорели` : 'Твоего цвета нет — не повезло, брейнроты сгорели';
      haptic('error');
      dice.sel = [];
    }
    dice.busy = false;
    loadDiceHist(t);
    await loadDiceInv(t);
  }

  const SPARKS = Array.from({ length: 16 }, (_, i) => `<b style="--x:${(i * 37) % 100}%;--d:${((i * 0.53) % 3.2).toFixed(2)}s;--s:${3 + (i % 3)}px"></b>`).join('');
  const multLabel = () => fmt(state.cfg.mystery?.mult || 3);
  const MYS_POOL_EMPTY = '<div class="mys-pool-empty"><div class="section-head"><h2>Что может выпасть</h2></div><div class="empty">Выбери своего брейнрота — здесь появится всё, во что он может превратиться</div></div>';

  async function renderMystery(qs) {
    const t = state.render;
    const cfg = state.cfg.mystery || { enabled: false };
    mys.busy = false;
    mys.info = null;
    const pre = Number(qs.get('item'));
    mys.sel = Number.isSafeInteger(pre) && pre > 0 ? pre : mys.sel;
    view.innerHTML = `
      <div class="mys-wrap">
      <div class="mys-mine"><div class="section-head"><h2>Твои брейнроты</h2></div>
      <div id="mysList"><div class="skeleton" style="height:120px"></div></div></div>
      <div class="mys-left">
      <div class="mys-slot" id="mysSlot"></div>
      <section class="mys-stage" id="mysStage">
        <div class="mys-rings" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="mys-sparks" aria-hidden="true">${SPARKS}</div>
        <div class="mys-core" id="mysCore"><div class="mys-q" aria-hidden="true">?</div><img class="mys-img hidden" id="mysImg" alt=""></div>
        <div class="mys-flash" aria-hidden="true"></div>
      </section>
      <div class="mys-capbox"><div class="mys-cap" id="mysCap"></div>
      <div class="mys-range" id="mysRange"></div>
      <div id="mysAfter"></div></div>
      <div class="up-ctrl">${speedSoundHtml()}</div>
      <button class="btn mys-go" id="mysGo" disabled><span class="mys-go-q" aria-hidden="true">?</span> Мистери</button>
      <p class="hint center mys-about">Твой брейнрот превратится в случайного другого — стоимостью от ⅓ до ${multLabel()}× от своей. <button class="link-btn" id="mysHelp">Как это работает</button></p>
      </div>
      <div class="mys-right">
      <div id="mysPool">${MYS_POOL_EMPTY}</div>
      </div></div>`;
    bindSpeedSound(view);
    $('#mysHelp').onclick = mysHelp;
    $('#mysGo').onclick = playMys;
    if (!cfg.enabled) {
      $('#mysCap').innerHTML = '<b>Мистери скоро вернётся</b>';
      $('#mysList').innerHTML = '';
      return;
    }
    try {
      mys.inv = (await api('/api/inventory')).filter((i) => i.status === 'owned' && !i.test);
    } catch (e) {
      return fail(e);
    }
    if (stale(t)) return;
    if (mys.sel && !mys.inv.some((i) => i.id === mys.sel)) mys.sel = null;
    drawMysList();
    await selectMys(mys.sel);
  }

  const mysFits = (price) => {
    const c = state.cfg.mystery;
    return price >= c.minInput && price <= c.maxInput;
  };

  function drawMysList() {
    const box = $('#mysList');
    if (!box) return;
    if (!mys.inv.length) {
      box.innerHTML = '<div class="empty">Пока нечего положить. Открой кейс, и брейнрот появится здесь<a class="btn" href="#/">К кейсам</a></div>';
      return;
    }
    // Подходящие — сначала, по цене; неподходящие (слишком дорогие или дешёвые) — тусклые в конце
    const list = [...mys.inv].sort((a, b) => (mysFits(b.item.price) - mysFits(a.item.price)) || b.item.price - a.item.price);
    box.innerHTML = `<div class="items">${list
      .map((i) => {
        const fits = mysFits(i.item.price);
        // почему нельзя положить — прямо на карточке, а не просто «тусклая»
        const why = fits ? '' : `<small class="mys-why">${i.item.price < state.cfg.mystery.minInput ? `дешевле ${fmt(state.cfg.mystery.minInput)} BG` : `дороже ${fmt(state.cfg.mystery.maxInput)} BG`}</small>`;
        return `<button class="item rar-${esc(i.item.rarity)} ${mys.sel === i.id ? 'sel' : ''} ${fits ? '' : 'dim'}" data-id="${i.id}">${ogTag(i.item)}<img loading="lazy" src="${itemImg(i.item.image)}" alt=""><div class="n">${esc(i.item.name)}</div>${price(i.item.price)}${why}</button>`;
      })
      .join('')}</div>`;
    $$('.item', box).forEach((b) => (b.onclick = () => {
      if (mys.busy) return;
      const id = Number(b.dataset.id);
      tick();
      selectMys(mys.sel === id ? null : id);
    }));
  }

  async function selectMys(id) {
    mys.sel = id || null;
    mys.info = null;
    $('#mysAfter').innerHTML = '';
    $('#mysGo').innerHTML = '<span class="mys-go-q" aria-hidden="true">?</span> Мистери';
    $('#mysStage')?.classList.remove('revealed');
    $$('#mysList .item').forEach((b) => b.classList.toggle('sel', Number(b.dataset.id) === mys.sel));
    const it = mys.inv.find((i) => i.id === mys.sel);
    showMysItem(it?.item || null);
    const slot = $('#mysSlot');
    if (slot) slot.innerHTML = it
      ? `<img src="${itemImg(it.item.image)}" alt=""><b>${esc(it.item.name)}</b>${price(it.item.price)}`
      : '<div class="t">Твой брейнрот</div><div class="t">выбери его в списке «Твои брейнроты»</div>';
    $('#mysRange').innerHTML = '';
    $('#mysPool').innerHTML = MYS_POOL_EMPTY;
    $('#mysGo').disabled = true;
    if (!it) return;
    try {
      const info = await api('/api/mystery/info', { method: 'POST', body: { id: it.id } });
      if (mys.sel !== it.id) return;
      mys.info = info;
      if (info.ok) {
        $('#mysRange').innerHTML = `<span>Может выпасть</span> от ${price(info.min)} до ${price(info.max)}`;
        drawMysPool(info.items);
        $('#mysGo').disabled = false;
      } else {
        $('#mysRange').innerHTML = `<span class="warn-t">${esc(info.reason)}</span>`;
      }
    } catch (e) {
      fail(e);
    }
  }

  // Витрина «Что может выпасть» для выбранного брейнрота — как «Что внутри» у кейса
  function drawMysPool(items) {
    const box = $('#mysPool');
    if (!box) return;
    if (!items?.length) { box.innerHTML = ''; return; }
    // Сначала 6 самых дорогих, остальные — по кнопке, чтобы список своих брейнротов не уезжал далеко вниз
    const SHOW = 6;
    const draw = (all) => {
      const list = all ? items : items.slice(0, SHOW);
      box.innerHTML = `<div class="section-head"><h2>Что может выпасть</h2><span class="muted">${items.length} ${plural(items.length, 'брейнрот', 'брейнрота', 'брейнротов')}</span></div>
        <div class="items mys-pool">${list.map((i) => itemCard(i)).join('')}</div>
        ${items.length > SHOW ? `<button class="btn ghost small" id="mysPoolMore" style="margin-top:8px">${all ? 'Свернуть' : `Показать все ${items.length}`}</button>` : ''}`;
      const more = $('#mysPoolMore', box);
      if (more) more.onclick = () => { tick(); draw(!all); };
    };
    draw(false);
  }

  function showMysItem(item, { result = false } = {}) {
    const img = $('#mysImg');
    const core = $('#mysCore');
    if (!img) return;
    core.className = `mys-core ${item ? 'has' : ''} ${item ? 'rar-' + esc(item.rarity) : ''}`;
    if (item) {
      img.src = itemImg(item.image);
      img.classList.remove('hidden');
      $('#mysCap').innerHTML = `<b>${esc(item.name)}</b>${price(item.price)}`;
    } else {
      img.classList.add('hidden');
      img.removeAttribute('src');
      $('#mysCap').innerHTML = '<span class="muted">Выбери своего брейнрота</span>';
    }
    if (result) core.classList.add('result');
  }

  function mysHelp() {
    const m = multLabel();
    openSheet('Как работает мистери', h(`
      <div class="mys-help">
        <p>1. Выбери одного своего брейнрота и нажми «Мистери».</p>
        <p>2. Он превратится в случайного другого брейнрота стоимостью <b>от ⅓ до ${m}×</b> от своей. Например, брейнрот за 150 BG может стать брейнротом от ${fmt(Math.round(150 / (state.cfg.mystery?.mult || 3)))} до ${fmt(Math.round(150 * (state.cfg.mystery?.mult || 3)))} BG.</p>
        <p>3. Какой выпадет — решает сервер в момент нажатия, анимация лишь показывает результат.</p>
        <p>Положить можно брейнрота стоимостью ${state.cfg.mystery?.floor ? `от ${fmt(state.cfg.mystery.floor)} ` : ''}${state.cfg.mystery?.cap ? `до ${fmt(state.cfg.mystery.cap)} BG` : 'BG'}.</p>
      </div>`));
  }

  async function playMys() {
    if (mys.busy || !mys.sel || !mys.info?.ok) return;
    const fast = prefs.fast;
    const stage = $('#mysStage');
    const go = $('#mysGo');
    const inputId = mys.sel;
    mys.busy = true;
    go.disabled = true;
    $('#mysAfter').innerHTML = '';
    lockNav(true);
    sfx.unlock();
    // Зарядка начинается сразу, параллельно с запросом
    stage.classList.remove('revealed');
    stage.classList.add('charging');
    const charge = fast ? 500 : 1300;
    sfx.charge(charge / 1000);
    try { TG?.HapticFeedback?.impactOccurred('light'); } catch {}
    const t0 = performance.now();
    let r;
    try {
      r = await api('/api/mystery', { method: 'POST', body: { id: inputId, key: newKey() } });
    } catch (e) {
      stage.classList.remove('charging');
      mys.busy = false;
      lockNav(false);
      go.disabled = false;
      return fail(e);
    }
    await sleep(Math.max(0, charge - (performance.now() - t0)));
    // Перебор: картинки мелькают всё медленнее
    stage.classList.remove('charging');
    stage.classList.add('shuffling');
    const frames = [...r.shuffle];
    const steps = fast ? 9 : 22;
    const img = $('#mysImg');
    $('#mysCap').innerHTML = '<span class="mys-dots">?  ?  ?</span>';
    const gaps = Array.from({ length: steps }, (_, i) => (fast ? 40 : 55) + Math.pow(i / steps, 2.2) * (fast ? 170 : 430));
    const isOg = r.item.rarity === 'og';
    let left = gaps.reduce((a, b) => a + b, 0);
    const lead = Math.min(3000, left * 0.6);
    let built = false;
    for (let i = 0; i < steps; i++) {
      // Выпадет OG: последние ~3 секунды перебора экран трясётся всё сильнее
      if (isOg && !built && left <= lead) {
        built = true;
        ogFx.build(left / 1000, stage);
      }
      img.src = itemImg(frames[i % frames.length]);
      img.classList.remove('hidden');
      sfx.chime(i / steps);
      if (i % 3 === 0) tick();
      await sleep(gaps[i]);
      left -= gaps[i];
    }
    // Вспышка — и результат
    stage.classList.remove('shuffling');
    stage.classList.add('revealed');
    showMysItem(r.item, { result: true });
    if (isOg) ogFx.boom(stage);
    else sfx.win(r.item.rarity);
    try { TG?.HapticFeedback?.impactOccurred('heavy'); } catch {}
    // Обновляем список: старого брейнрота нет, новый — выбран
    mys.inv = mys.inv.filter((i) => i.id !== inputId);
    mys.inv.unshift({ id: r.inventoryId, status: 'owned', item: r.item });
    mys.sel = r.inventoryId;
    drawMysList();
    $('#mysRange').innerHTML = '';
    $('#mysPool').innerHTML = MYS_POOL_EMPTY;
    $('#mysAfter').innerHTML = `
      <div class="btn-row">
        <button class="btn ghost" data-a="sell">Продать за ${price(r.item.price)}</button>
        <button class="btn ghost" data-a="upgrade">Апгрейд</button>
      </div>`;
    $('[data-a=upgrade]', $('#mysAfter')).onclick = () => (location.hash = `#/upgrade?item=${r.inventoryId}`);
    $('[data-a=sell]', $('#mysAfter')).onclick = async (ev) => {
      const b = ev.currentTarget;
      if (b.disabled) return;
      b.disabled = true;
      try {
        const s = await api('/api/inventory/sell', { method: 'POST', body: { ids: [r.inventoryId], key: newKey() } });
        setBalance(s.balance);
        haptic('success');
        toast(`Продано за ${fmt(r.item.price)} BG`);
        mys.inv = mys.inv.filter((i) => i.id !== r.inventoryId);
        drawMysList();
        selectMys(null);
      } catch (e) {
        b.disabled = false;
        fail(e);
      }
    };
    mys.busy = false;
    lockNav(false);
    // Можно сразу ещё раз — уже с новым брейнротом
    try {
      const info = await api('/api/mystery/info', { method: 'POST', body: { id: r.inventoryId } });
      if (mys.sel !== r.inventoryId) return;
      mys.info = info;
      if (info.ok) {
        $('#mysRange').innerHTML = `<span>Может выпасть</span> от ${price(info.min)} до ${price(info.max)}`;
        drawMysPool(info.items);
      }
      go.disabled = !info.ok;
      go.innerHTML = info.ok ? '<span class="mys-go-q" aria-hidden="true">?</span> Ещё раз' : '<span class="mys-go-q" aria-hidden="true">?</span> Мистери';
    } catch {}
  }

  // =====================================================================
  //                               ПРОФИЛЬ
  // =====================================================================
  async function renderProfile() {
    const t = state.render;
    view.innerHTML = '<div class="skeleton"></div>';
    let me, inv, wd;
    try {
      [me, inv, wd] = await Promise.all([refreshMe(), api('/api/inventory'), api('/api/withdraw')]);
    } catch (e) {
      return fail(e);
    }
    if (stale(t)) return;
    const name = me.firstName || me.username || 'Игрок';
    view.innerHTML = `
      <div class="prof-wrap"><div class="prof-left">
      <section class="panel">
        <div class="me">
          <div class="avatar" id="bigAva"></div>
          <div class="who">
            <b>${esc(name)}</b>
            <div class="muted">${me.username ? '@' + esc(me.username) : ''}</div>
            <button class="idline" id="copyId">ID ${me.id}</button>
          </div>
        </div>
        <div class="bal-row">
          <div class="bal-big">${COIN}${fmt(me.balance)}</div>
          <button class="btn small" id="pTopup" style="width:auto;padding:0 18px">Пополнить</button>
        </div>
        <div class="stats">
          <div class="stat"><b>${me.stats.cases}</b><span>кейсов</span></div>
          <div class="stat"><b>${me.stats.upgrades}</b><span>апгрейдов</span></div>
          <div class="stat"><b>${fmt(me.stats.withdrawn)}</b><span>выведено BG</span></div>
        </div>
      </section>

      <a class="panel go-panel" href="#/referrals">
        ${svgIcon('friends')}
        <span class="grow"><b>Рефералы</b><span class="muted">Приглашай друзей и получай долю от их проигрышей</span></span>
        <span class="chev" aria-hidden="true">›</span>
      </a>

      <section class="panel promo-enter">
        <h3>Промокод</h3>
        <div class="reflink"><input id="pCode" maxlength="20" placeholder="Введи промокод" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="btn small" id="pAct">Активировать</button></div>
      </section>
      ${me.isPartner ? `<a class="panel go-panel" href="#/partner">${svgIcon('friends')}<span class="grow"><b>Кабинет партнёра</b><span class="muted">Статистика друзей, доход и твои промокоды</span></span><span class="chev" aria-hidden="true">›</span></a>` : ''}
      </div>
      <div class="prof-right">
      <div class="section-head"><h2>Инвентарь</h2>${inv.some((i) => i.status === 'owned' && !i.test) ? '<button class="link-btn" id="sellAll">Продать всё</button>' : ''}</div>
      <div id="invBox"></div>
      <div id="wdHistory"></div>
      </div></div>`;
    fillAvatar($('#bigAva'));
    const pAct = async () => {
      const code = $('#pCode').value.trim();
      if (!code) return;
      $('#pAct').disabled = true;
      try {
        const r = await api('/api/promo', { method: 'POST', body: { code } });
        haptic('success');
        if (r.type === 'coins') { setBalance(r.balance); toast(`Промокод активирован: +${fmt(r.reward)} BG`); }
        else toast('Код друга применён: бонус к этому пополнению');
        $('#pCode').value = '';
        refreshMe().catch(() => {});
      } catch (e) { fail(e); }
      $('#pAct').disabled = false;
    };
    $('#pAct').onclick = pAct;
    $('#pCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') pAct(); });
    $('#pTopup').onclick = () => openDeposit();
    $('#copyId').onclick = () => copy(String(me.id), 'ID скопирован');
    const sa = $('#sellAll');
    if (sa) {
      sa.onclick = async () => {
        const owned = inv.filter((i) => i.status === 'owned' && !i.test);
        const sum = owned.reduce((a, i) => a + i.item.price, 0);
        if (!(await confirmBox(`Продать ${owned.length} брейнротов за ${fmt(sum)} BG?`, { ok: 'Продать' }))) return;
        try {
          const r = await api('/api/inventory/sell-all', { method: 'POST', body: { key: newKey() } });
          setBalance(r.balance);
          toast(`Продано за ${fmt(r.total)} BG`);
          renderProfile();
        } catch (e) {
          fail(e);
        }
      };
    }
    drawInventory(inv);
    drawWdHistory(wd);
    // Пока что-то на выводе — обновляем статусы сами
    if (inv.some((i) => i.withdraw)) {
      every(15000, async () => {
        try {
          const fresh = await api('/api/inventory');
          if (!stale(t)) drawInventory(fresh);
        } catch {}
      });
    }
  }

  // =====================================================================
  //                               РЕФЕРАЛЫ
  // =====================================================================
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  // «в пятницу, 16 октября, в 17:00 МСК» и «Каждую пятницу в 17:00 МСК»
  const WEEKDAY = {
    понедельник: ['в понедельник', 'Каждый понедельник'],
    вторник: ['во вторник', 'Каждый вторник'],
    среда: ['в среду', 'Каждую среду'],
    четверг: ['в четверг', 'Каждый четверг'],
    пятница: ['в пятницу', 'Каждую пятницу'],
    суббота: ['в субботу', 'Каждую субботу'],
    воскресенье: ['в воскресенье', 'Каждое воскресенье'],
  };
  function payoutParts(iso, tz, label) {
    const d = new Date(iso);
    let wd, date, time;
    try {
      wd = d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: tz });
      date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: tz });
      time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    } catch {
      wd = d.toLocaleDateString('ru-RU', { weekday: 'long' });
      date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    const [on, every] = WEEKDAY[wd] || [wd, wd];
    return { next: `${on}, ${date}, в ${time} ${label}`, every: `${every} в ${time} ${label}` };
  }
  function refHelp(r) {
    const when = payoutParts(r.nextPayoutAt, r.tz, r.tzLabel);
    const body = h(`<div class="ref-help">
      <p>Каждую неделю ты получаешь <b>${fmt(r.percent)}%</b> от того, сколько проиграли приглашённые тобой друзья: сколько они потратили на кейсы и апгрейды минус стоимость того, что им выпало.</p>
      <p>Засчитывается не больше, чем друг пополнил за эту неделю. Если он играет без пополнений, на доход это не влияет.</p>
      <p>Если друг выиграл, его выигрыш (тоже не больше его пополнений) уменьшает доход. Если за неделю друзья в плюсе, реферальный баланс уходит в минус, и этот минус гасится доходом следующих недель.</p>
      <p>${esc(when.every)} доход за неделю переходит на реферальный баланс. Оттуда его можно перевести на основной баланс в любой момент.</p>
      <button class="btn" id="helpOk">Понятно</button>
    </div>`);
    const sh = openSheet('Как считается доход', body);
    $('#helpOk', body).onclick = () => sh.close();
  }

  async function renderReferrals() {
    const t = state.render;
    view.innerHTML = '<div class="skeleton"></div>';
    let r;
    try {
      r = await api('/api/referrals');
    } catch (e) {
      return fail(e);
    }
    if (stale(t)) return;
    const pre = r.preliminary;
    const neg = r.refBalance < 0;
    view.innerHTML = `
      <h1 class="page-title">Рефералы</h1>

      <section class="panel ref-code">
        <span class="muted">Твой код</span>
        <button class="ref-code-big" id="copyCode" aria-label="Скопировать код">${esc(r.code)}</button>
        <p class="hint">Друг получает <b>+${fmt(r.bonusPercent)}%</b> к каждому пополнению с твоим кодом. Ты получаешь <b>${fmt(r.percent)}%</b> от его проигрышей каждую неделю.</p>
        ${r.link ? `<div class="reflink"><input id="refLink" readonly value="${esc(r.link)}"><button class="btn small" id="copyRef">Копировать</button></div>
        <button class="btn ghost small" id="shareRef" style="margin-top:8px">Отправить ссылку друзьям</button>` : ''}
        ${!r.isPartner && r.partnerContact ? '<button class="btn ghost small" id="howPartner" style="margin-top:8px">Как стать партнёром?</button>' : ''}
        ${r.isPartner ? '<a class="btn small" href="#/partner" style="margin-top:8px">Кабинет партнёра</a>' : ''}
      </section>

      <section class="ref-income">
        <div class="ref-income-head">
          <span>Предварительный доход</span>
          <button class="help" id="refHelp" aria-label="Как считается доход">?</button>
        </div>
        <div class="ref-income-sum ${pre < 0 ? 'neg' : ''}">${COIN}${signed(pre)}</div>
        <span class="ref-income-when">Начислится ${esc(payoutParts(r.nextPayoutAt, r.tz, r.tzLabel).next)}</span>
      </section>

      <section class="panel">
        <span class="muted">Реферальный баланс</span>
        <div class="bal-big ${neg ? 'neg' : ''}">${COIN}${neg ? signed(r.refBalance) : fmt(r.refBalance)}</div>
        ${neg ? '<p class="hint">Друзья выиграли больше, чем проиграли. Этот минус погасится доходом следующих недель, с основного баланса ничего не спишется.</p>' : ''}
        <button class="btn" id="refTransfer" ${r.refBalance > 0 ? '' : 'disabled'}>Перевести на баланс</button>
        <div class="stats two">
          <div class="stat"><b>${r.count}</b><span>${plural(r.count, 'друг', 'друга', 'друзей')}</span></div>
          <div class="stat"><b>${fmt(r.earned)}</b><span>BG заработано</span></div>
        </div>
      </section>

      <h2>Друзья</h2>
      ${r.referrals.length
        ? `<div class="panel ref-list">${r.referrals.map((f) => `<div class="line"><div class="grow"><b>${esc(f.name)}</b><span class="muted">с ${new Date(f.joinedAt).toLocaleDateString('ru-RU')}</span></div>${price(f.earned)}</div>`).join('')}</div>`
        : '<div class="empty">Пока никого. Отправь другу ссылку: когда он зайдёт по ней, он появится здесь</div>'}

      ${r.history.length ? `<h2>История</h2><div class="panel ref-list">${r.history.map((x) => `<div class="line"><div class="grow"><b>${x.kind === 'week' ? 'Доход за неделю' : x.kind === 'transfer' ? 'Перевод на баланс' : 'Корректировка'}</b><span class="muted">${new Date(x.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</span></div><span class="price ${x.amount < 0 ? 'neg' : ''}">${COIN}${signed(x.amount)}</span></div>`).join('')}</div>` : ''}`;

    $('#refHelp').onclick = () => refHelp(r);
    if ($('#howPartner')) $('#howPartner').onclick = () => partnerHow(r.partnerContact);
    $('#copyCode').onclick = () => copy(r.code, 'Код скопирован');
    if (r.link) {
      $('#copyRef').onclick = () => copy(r.link, 'Ссылка скопирована');
      $('#shareRef').onclick = () => {
        const url = `https://t.me/share/url?url=${encodeURIComponent(r.link)}&text=${encodeURIComponent(`Залетай в Brainrot Grader: с моим кодом ${r.code} +${fmt(r.bonusPercent)}% к пополнению`)}`;
        try { TG?.openTelegramLink ? TG.openTelegramLink(url) : window.open(url, '_blank'); } catch { window.open(url, '_blank'); }
      };
    }
    $('#refTransfer').onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      ev.currentTarget.disabled = true;
      try {
        const res = await api('/api/referrals/transfer', { method: 'POST', body: { key: newKey() } });
        setBalance(res.balance);
        haptic('success');
        toast(`Переведено на баланс: ${fmt(res.transferred)} BG`);
        renderReferrals();
      } catch (e) {
        fail(e);
        ev.currentTarget.disabled = false;
      }
    };
  }

  // Как стать партнёром: написать владельцу, приложить ссылки на TikTok и Telegram-канал
  function partnerHow(contact) {
    const nick = String(contact).replace(/^@/, '');
    const body = h(`
      <div class="partner-how">
        <p>Партнёры получают повышенный процент с друзей и могут создавать свои промокоды на монеты.</p>
        <p><b>Чтобы стать партнёром:</b></p>
        <ol>
          <li>Напиши в личные сообщения <b>@${esc(nick)}</b></li>
          <li>Пришли ссылку на свой <b>TikTok</b></li>
          <li>И ссылки на свои <b>Telegram-каналы</b></li>
        </ol>
        <p class="muted">Мы посмотрим твои площадки и ответим в Telegram.</p>
        <button class="btn" id="partnerWrite">Написать @${esc(nick)}</button>
      </div>`);
    openSheet('Как стать партнёром', body);
    $('#partnerWrite', body).onclick = () => {
      const url = `https://t.me/${encodeURIComponent(nick)}`;
      try { TG?.openTelegramLink ? TG.openTelegramLink(url) : window.open(url, '_blank'); } catch { window.open(url, '_blank'); }
    };
  }

  // =====================================================================
  //                         СЕРИЯ ЗАХОДОВ
  // =====================================================================
  // Зелёный пиксельный огонёк с «BG» внутри. off — серый (серии нет)
  function streakFlame(px, { off = false, bg = true } = {}) {
    const rows = ['....11....', '...121....', '...1221...', '..12221.1.', '.1223221..', '.12233221.', '1223333221', '1233443321', '1234444321', '.12344321.', '..123321..', '...1111...'];
    const col = off ? { 1: '#2a332f', 2: '#46524c', 3: '#66746d', 4: '#8b9c94' } : { 1: '#0b5a30', 2: '#1fbf6a', 3: '#34e08a', 4: '#c9ffe2' };
    let r = '';
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (col[ch]) r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${col[ch]}"/>`; }));
    // «BG» поверх пламени — пиксельным шрифтом сайта
    const t = bg && px >= 34 ? `<text x="5" y="9.6" text-anchor="middle" font-family="Pixelify Sans, monospace" font-weight="700" font-size="3.4" fill="${off ? '#1b211f' : '#04331a'}" letter-spacing="-0.1">BG</text>` : '';
    return `<svg class="s-flame${off ? ' off' : ''}" width="${px}" height="${Math.round(px * 1.2)}" viewBox="0 0 10 12" shape-rendering="crispEdges" aria-hidden="true">${r}${t}</svg>`;
  }

  // Раз за сессию на странице кабинета: размеры окна и блоков — в логи сервера (ищем, почему у кого-то узко)
  function sendDiag() {
    try {
      if (sessionStorage.getItem('bg_diag')) return;
      sessionStorage.setItem('bg_diag', '1');
    } catch {}
    const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
    const v = $('#view');
    const cs = v ? getComputedStyle(v) : null;
    const pm = v?.parentElement ? getComputedStyle(v.parentElement) : null;
    api('/api/diag', { method: 'POST', body: {
      page: v?.dataset.page || '', iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, cw: document.documentElement.clientWidth,
      view: w(v), main: w(v?.parentElement), grid: w($('.pc-grid')), viewDisplay: cs?.display, viewMax: cs?.maxWidth, viewPad: cs?.paddingLeft + ' ' + cs?.paddingRight,
      viewMargin: cs?.marginLeft + ' ' + cs?.marginRight, mainDisplay: pm?.display, mainPad: pm?.paddingLeft + ' ' + pm?.paddingRight, mainMargin: pm?.marginLeft,
      build: document.querySelector('meta[name="bg-build"]')?.content || 'нет', css: [...document.styleSheets].map((x) => x.href || '').join(' ').slice(0, 200),
      tg: TG?.platform + ' ' + TG?.version, ua: navigator.userAgent,
    } }).catch(() => {});
  }

  async function streakCheckin() {
    try {
      const r = await api('/api/streak/checkin', { method: 'POST', body: {} });
      state.streak = r;
      drawStreakPill();
      if (r.enabled && r.fresh && r.pending.some((p) => !p.claimed)) openStreak();
    } catch {}
  }
  function drawStreakPill() {
    const el = $('#streakPill');
    const r = state.streak;
    if (!el) return;
    if (!r?.enabled) return el.classList.add('hidden');
    el.classList.remove('hidden');
    el.classList.toggle('has-reward', r.pending.some((p) => !p.claimed));
    el.innerHTML = `${streakFlame(16, { off: !r.count, bg: false })}<b>${r.count}</b>`;
    el.onclick = () => openStreak();
  }

  function streakRewardIcon(t) {
    if (t.kind === 'coins') return `<img class="s-ico" src="/img/coin.webp" alt="">`;
    return `<img class="s-ico${t.kind === 'case' ? ' case' : ''}" src="${itemImg(t.image)}" alt="">`;
  }
  const streakRewardLabel = (t) => (t.kind === 'coins' ? `${fmt(t.amount)} BG` : t.kind === 'case' ? 'Кейс' : esc(t.name));

  function openStreak() {
    const r = state.streak;
    if (!r?.enabled) return;
    const n = r.count;
    const from = Math.max(1, Math.min(n - 3, r.days - 6));
    const win = r.track.slice(from - 1, from + 6);
    const big = r.track.filter((t) => t.kind !== 'coins');
    const today = r.pending.find((p) => p.day === n && !p.claimed) || null;
    const body = h(`<div class="streak-sheet">
      <div class="s-head">${streakFlame(78)}<div class="s-num">${n}</div><div class="s-lbl">${plural(n, 'день', 'дня', 'дней')} подряд</div>
        ${r.broken ? '<p class="s-sub warn-t">Серия прервалась — пропустил день. Начинаем заново</p>' : `<p class="s-sub">Заходи каждый день — награды растут. Пропустишь день — серия начнётся сначала. Рекорд: ${r.best}</p>`}</div>
      <div class="s-week">${win.map((t) => `<div class="s-day ${t.day < n ? 'done' : t.day === n ? 'today' : ''} ${t.kind !== 'coins' ? 'big' : ''}">
        ${t.day === n ? '<span class="s-tag">СЕГОДНЯ</span>' : ''}<span class="s-dn">День ${t.day}</span>
        <div class="s-ic">${t.day < n ? '✓' : streakRewardIcon(t)}</div><div class="s-rw">${COIN}${fmt(t.kind === 'coins' ? t.amount : t.price)}</div></div>`).join('')}</div>
      <div id="sClaim"></div>
      <h3 class="s-h">Большие награды</h3>
      <div class="s-big">${big.map((t) => `<div class="s-bigrow ${t.day <= n ? 'past' : ''}"><span class="s-bd">День ${t.day}</span>${streakRewardIcon(t)}<div class="grow"><b>${t.kind === 'case' ? 'Кейс «' + esc(t.name) + '»' : esc(t.name)}</b><span class="muted">${price(t.price)} · забрать — если пополнил от ${fmt(t.need)} BG</span></div></div>`).join('')}</div>
      <p class="hint">Брейнротов из серии (и из наградных кейсов) вывести нельзя — их можно продать, поставить в апгрейд или сыграть в мистери. Выигрыш выводится как обычно.</p>
    </div>`);
    const s = openSheet('Серия заходов', body);
    drawStreakClaim(today, s);
  }

  function drawStreakClaim(p, sheet) {
    const box = $('#sClaim');
    if (!box) return;
    if (!p) {
      box.innerHTML = '<div class="s-next">Награду за сегодня ты уже забрал. Возвращайся завтра 🔥</div>';
      return;
    }
    const left = Math.max(0, new Date(p.expiresAt) - Date.now());
    const what = p.kind === 'coins' ? `${fmt(p.amount)} BG` : p.kind === 'case' ? `кейс «${esc(p.name)}»` : `«${esc(p.name)}»`;
    if (p.canClaim) {
      box.innerHTML = `<button class="btn s-btn" id="sGo">Забрать ${what}</button><p class="hint center">Сгорит через ${hms(left)}</p>`;
    } else {
      box.innerHTML = `<div class="s-need">Чтобы забрать ${what}, пополни баланс от <b>${fmt(p.need)} BG</b> — пополнено ${fmt(p.deposited)} BG. Сгорит через ${hms(left)}</div>
        <div class="btn-row"><button class="btn s-btn" id="sDep">Пополнить</button><button class="btn ghost" id="sRe">Я пополнил — проверить</button></div>`;
      $('#sDep', box).onclick = () => { sheet.close(); openDeposit(); };
      $('#sRe', box).onclick = async () => { await streakCheckin(); sheet.close(); openStreak(); };
      return;
    }
    $('#sGo', box).onclick = async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        const res = await api('/api/streak/claim', { method: 'POST', body: { id: p.id, key: newKey() } });
        setBalance(res.balance);
        haptic('success');
        sfx.win?.(res.item?.rarity || 'rare');
        p.claimed = true;
        state.streak.pending = state.streak.pending.filter((x) => x.id !== p.id);
        drawStreakPill();
        box.innerHTML = res.kind === 'coins'
          ? `<div class="s-got">${streakFlame(40)}<b>+${fmt(res.amount)} BG</b><span class="muted">${res.fromCase ? 'выпало из наградного кейса · ' : ''}уже на балансе</span></div>`
          : `<div class="s-got item rar-${esc(res.item.rarity)}"><img src="${itemImg(res.item.image)}" alt=""><b>${esc(res.item.name)}</b>${price(res.item.price)}<span class="muted">${res.fromCase ? 'выпал из наградного кейса · ' : ''}уже в инвентаре. Вывести нельзя — можно продать, апгрейд или мистери</span></div>`;
      } catch (e) {
        fail(e);
        if (e.code === 'need_deposit') { await streakCheckin(); }
        ev.currentTarget && (ev.currentTarget.disabled = false);
      }
    };
  }

  // =====================================================================
  //                          КАБИНЕТ ПАРТНЁРА
  // =====================================================================
  // =====================================================================
  //                         ВОПРОСЫ (FAQ)
  // =====================================================================
  // Цифры — из текущих настроек сайта, поэтому ответы не устаревают. #/faq?q=withdraw — открыть нужный вопрос
  function faqData() { return [{group:'Кейсы',items:[{id:'cases',q:'Как открыть кейс?',a:'<p>Выбери кейс и количество открытий. Полученные предметы появятся в инвентаре — их можно продать или использовать в играх.</p>'}]}];
    const c = state.cfg || {};
    const f = c.faq || {};
    const list = [
      { group: 'Пополнение', items: [
        { id: 'deposit', q: 'Как пополнить баланс?', a: `<p><b>Звёздами Telegram:</b> 1 ⭐ = ${fmt(c.starsRate)} BG, от ${fmt(c.starsMin)} звёзд.</p><p><b>Брейнротами из Steal a Brainrot:</b> создаёшь заявку — бот покажет ник нашего аккаунта, и у тебя ${fmt(f.depositWindow || 10)} мин, чтобы отправить трейд. Минимум — ${fmt(c.depositMinTotal)} BG за заявку, брейнроты от ${fmt(c.depositItemMin)} BG.</p>` },
        { id: 'friend', q: 'Что такое код друга?', a: `<p>Код друга даёт <b>+${fmt(c.refBonusPercent)}%</b> к каждому пополнению, где ты его ввёл. Привязать можно только один код.</p><p>Промокод с главной — разовый бонус к пополнению, он меняется каждые несколько часов.</p>` },
      ] },
      { group: 'Вывод', items: [
        { id: 'withdraw', q: 'Когда проходят выводы?', a: `<p>Каждые 2 дня, ${esc(c.withdrawWindow || '')}. Ставишь брейнрота на вывод из инвентаря — когда подойдёт очередь, бот напишет в Telegram. Зайди в игру за ${fmt(f.callMinutes || 10)} мин и нажми «Я в игре».</p>` },
        { id: 'withdraw-rules', q: 'Какие условия вывода?', a: `<p>Брейнрот от <b>${fmt(c.withdrawMin)} BG</b>.${c.withdrawNeed ? ` И за последние ${fmt(c.withdrawNeed.hours)} ч нужно пополнить баланс от <b>${fmt(c.withdrawNeed.min)} BG</b> — звёздами или брейнротами.` : ''}${c.withdrawBig ? ` Крупные выводы (от <b>${fmt(c.withdrawBig.from)} BG</b>) обрабатываются <b>до ${c.withdrawBig.days} дней</b>.` : ''}</p>` },
        { id: 'no-withdraw', q: 'Почему брейнрота нельзя вывести?', a: '<p>Купленных за баланс и полученных в награду за серию вывести нельзя — у них плашка «куплен» или «награда». Их можно продать, поставить в апгрейд или сыграть в мистери: то, что выиграешь, выводится как обычно.</p>' },
        { id: 'no-stock', q: 'Что если брейнрота нет на складе?', a: '<p>Предложим замену прямо сейчас или подождать — как только брейнрот появится у нас, вывод встанет в очередь и бот напишет.</p>' },
      ] },
      { group: 'Кейсы', items: [
        { id: 'odds', q: 'Какие шансы в кейсах?', a: '<p>В «Что внутри» видно всё, что может выпасть, — от дорогих к дешёвым. Что выпало, решает сервер в момент открытия, лента только показывает результат.</p>' },
        { id: 'free', q: 'Как открыть бесплатный кейс?', a: `<p>Подпишись на наш канал или добавь тег в имя в Telegram — условие написано на странице кейса. Открывать можно раз в ${fmt(f.freeHours || 24)} ч.</p>` },
      ] },
      { group: 'Апгрейдер', items: [
        ...(f.gold ? [{ id: 'gold', q: 'Что такое золото?', a: `<p>Иногда в середине зелёной зоны появляется золотая полоса — её размер на круге и есть шанс попасть в неё. Попал — вместо цели получаешь брейнрота примерно в <b>2 раза дороже</b>.</p>${f.gold.max >= 4 ? `<p>Дальше круг сам крутится ещё раз: ${fmt(f.gold.step)}% на ×4${f.gold.max >= 8 ? `, потом на ×8 и так далее (до ×${fmt(f.gold.max)})` : ''}. Не повезло — остаётся то, до чего дошёл, ты ничего не теряешь.</p>` : ''}` }] : []),
      ] },
      ...(c.dice?.enabled ? [{ group: 'Колор Дайс', items: [
        { id: 'dice', q: 'Как работает Колор Дайс?', a: `<p>Ставишь до ${fmt(c.dice.maxItems)} своих брейнротов и выбираешь цвет — бросаются 4 кубика, на каждом 6 цветов. Если выпало ${c.dice.table.filter((r) => r.mult > 0).map((r) => `${r.hits} ${plural(r.hits, 'кубик', 'кубика', 'кубиков')} твоего цвета — ×${fmt(r.mult)}`).join(', ')}: брейнроты остаются у тебя, и к каждому добавляются такие же. Проиграл — брейнроты сгорают.${c.dice.rainbow ? ` А если в броске выпал <b>разноцветный кубик</b> — сразу <b>×${fmt(c.dice.rainbow.mult)}</b>.` : ''} Результат определяет сервер.</p>` },
      ] }] : []),
      ...(c.mystery?.enabled ? [{ group: 'Мистери', items: [
        { id: 'mystery', q: 'Как работает мистери?', a: `<p>Кладёшь своего брейнрота — получаешь случайного другого: дешевле или дороже, от ⅓ до ×${fmt(c.mystery.mult)} его цены.</p>` },
      ] }] : []),
      ...(f.streak ? [{ group: 'Серия заходов', items: [
        { id: 'streak', q: 'Что такое серия заходов?', a: '<p>Заходи каждый день — огонёк в шапке растёт, и за дни подряд даются награды. Пропустил день — серия начинается заново. Награду нужно забрать за 24 ч, а для дорогих — пополнить баланс.</p>' },
      ] }] : []),
    ];
    return list.filter((g) => g.items.length);
  }
  function renderFaq(qs) {
    const data = faqData();
    const open = qs.get('q');
    view.innerHTML = `
      <div class="faq">
        <h1>Вопросы</h1>
        <input class="faq-search" id="faqQ" placeholder="Поиск по вопросам" autocomplete="off">
        <div id="faqList">${data.map((g) => `
          <section class="faq-group" data-g>
            <h2>${esc(g.group)}</h2>
            ${g.items.map((it) => `<details class="faq-item" id="faq-${it.id}" ${it.id === open ? 'open' : ''}><summary>${esc(it.q)}</summary><div class="faq-a">${it.a}</div></details>`).join('')}
          </section>`).join('')}
        </div>
        <div class="empty hidden" id="faqNone">Ничего не нашлось</div>
      </div>`;
    if (open) setTimeout(() => $('#faq-' + CSS.escape(open))?.scrollIntoView({ block: 'center' }), 50);
    $('#faqQ').oninput = (e) => {
      const v = e.target.value.trim().toLowerCase();
      let any = false;
      $$('.faq-group').forEach((g) => {
        let shown = 0;
        $$('.faq-item', g).forEach((d) => {
          const hit = !v || d.textContent.toLowerCase().includes(v);
          d.classList.toggle('hidden', !hit);
          if (hit) shown++;
          if (v && hit) d.open = true;
        });
        g.classList.toggle('hidden', !shown);
        any ||= shown > 0;
      });
      $('#faqNone').classList.toggle('hidden', any);
    };
  }

  async function renderPartner() {
    const t = state.render;
    view.innerHTML = '<div class="skeleton"></div>';
    let r;
    try { r = await api('/api/partner'); } catch (e) {
      if (e.code === 'not_partner') { location.hash = '#/referrals'; return; }
      return fail(e);
    }
    if (stale(t)) return;
    const max = Math.max(1, ...r.days.map((d) => Math.max(d.deposits, d.lost)));
    const dd = (d) => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    view.innerHTML = `
      <a class="back" href="#/referrals">‹ Рефералы</a>
      <h1 class="page-title">Кабинет партнёра</h1>
      <div class="pc-grid">
        <div class="pc-stat"><span>Твой процент</span><b>${fmt(r.percent)}%</b><small>от проигрышей друзей</small></div>
        <div class="pc-stat accent"><span>Предварительный доход</span><b>${COIN}${signed(r.preliminary)}</b><small>начислится ${esc(payoutParts(r.nextPayoutAt, r.tz, r.tzLabel).next)}</small></div>
        <div class="pc-stat"><span>Реферальный баланс</span><b>${COIN}${fmt(r.refBalance)}</b><small>заработано всего ${fmt(r.earned)} BG</small></div>
        <div class="pc-stat"><span>Друзей</span><b>${fmt(r.friends)}</b><small>+${fmt(r.friendsDay)} за сутки · заходили ${fmt(r.activeDay)}</small></div>
        <div class="pc-stat"><span>Пополнили</span><b>${fmt(r.payers)}</b><small>из ${fmt(r.friends)} друзей</small></div>
        <div class="pc-stat"><span>Друзья пополнили на</span><b>${COIN}${fmt(r.deposits)}</b><small>за всё время</small></div>
      </div>

      <section class="panel">
        <div class="section-head" style="margin-top:0"><h3 style="margin:0">14 дней</h3><span class="muted"><i class="lg dep"></i> пополнили · <i class="lg lost"></i> проиграли</span></div>
        <div class="pc-chart">${r.days.map((d) => `<div class="pc-day" title="${dd(d.day)}: +${d.joined} друзей, пополнили ${fmt(d.deposits)} BG, проиграли ${fmt(d.lost)} BG">
          <div class="pc-bars"><i class="dep" style="height:${Math.round((Math.max(0, d.deposits) / max) * 100)}%"></i><i class="lost" style="height:${Math.round((Math.max(0, d.lost) / max) * 100)}%"></i></div>
          <span class="pc-j">${d.joined ? '+' + d.joined : ''}</span><span class="pc-d">${new Date(d.day).getDate()}</span></div>`).join('')}</div>
        <p class="hint">Цифра над датой — сколько друзей пришло в этот день. Доход — ${fmt(r.percent)}% от проигрышей друзей, но не больше их пополнений за неделю.</p>
      </section>

      <section class="panel ref-code">
        <span class="muted">Твой код и ссылка</span>
        <button class="ref-code-big" id="pcCode">${esc(r.code)}</button>
        <p class="hint">Друг получает <b>+${fmt(r.bonusPercent)}%</b> к каждому пополнению с твоим кодом.</p>
        ${r.link ? `<div class="reflink"><input readonly value="${esc(r.link)}"><button class="btn small" id="pcLink">Копировать</button></div>` : ''}
      </section>

      <section class="panel" id="partnerBox"><h3>Мои промокоды</h3><div class="skeleton" style="height:60px"></div></section>`;
    $('#pcCode').onclick = () => copy(r.code, 'Код скопирован');
    if ($('#pcLink')) $('#pcLink').onclick = () => copy(r.link, 'Ссылка скопирована');
    drawPartnerPromos();
  }

  // Партнёр: создание своих промокодов на монеты
  async function drawPartnerPromos() {
    const box = $('#partnerBox');
    if (!box) return;
    let d;
    try { d = await api('/api/promos'); } catch (e) { return fail(e); }
    if (!box.isConnected) return;
    const L = d.limits;
    // коды скрыты, пока не нажмёшь «Показать» — чтобы случайно не засветить на стриме
    const show = !!state.showCodes;
    const mask = (c) => (show ? esc(c) : '•'.repeat(Math.min(10, c.length)));
    box.innerHTML = `
      <div class="section-head" style="margin-top:0"><h3 style="margin:0">Мои промокоды</h3><button class="link-btn" id="ppShow">${show ? '🙈 Скрыть коды' : '👁 Показать коды'}</button></div>
      <p class="hint" style="margin-top:0">Ты партнёр: можешь создать промокод на монеты для своих подписчиков. Каждый игрок активирует его только один раз. Монеты списываются с твоего баланса сразу, за неиспользованные активации вернутся при удалении.</p>
      <label class="field"><span>Промокод (5–20 латинских букв или цифр)</span><input id="ppCode" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Например, VLADTV50"></label>
      <div class="btn-row" style="gap:8px">
        <label class="field" style="flex:1"><span>Активаций</span><input id="ppUses" type="number" inputmode="numeric" min="1" max="${L.maxUses}" value="10"></label>
        <label class="field" style="flex:1"><span>BG за активацию</span><input id="ppReward" type="number" inputmode="decimal" min="${L.minReward}" max="${L.maxReward}" value="5"></label>
      </div>
      <button class="btn" id="ppCreate" style="margin-top:12px"></button>
      <div id="ppList" style="margin-top:12px">${d.promos.length ? d.promos.map((p) => `
        <div class="line"><div class="grow"><b class="pp-code">${mask(p.code)}</b><span class="muted">${fmt(p.reward)} BG × ${p.maxUses} · использовано ${p.uses} из ${p.maxUses}${p.status === 'used_up' ? ' · закончился' : ''}</span></div>
        ${p.status === 'active' ? `<button class="link-btn" data-pdel="${p.id}" data-code="${show ? esc(p.code) : 'этот'}" data-left="${(p.maxUses - p.uses) * p.reward}">Удалить</button>` : ''}</div>`).join('') : '<p class="hint">Промокодов пока нет</p>'}</div>`;
    const cost = () => {
      const n = Math.floor(Number($('#ppUses').value) || 0);
      const r = Number($('#ppReward').value) || 0;
      $('#ppCreate').innerHTML = `Создать за ${price(Math.round(n * r * 100) / 100)}`;
    };
    $('#ppShow').onclick = () => { state.showCodes = !state.showCodes; drawPartnerPromos(); };
    $('#ppUses').oninput = cost;
    $('#ppReward').oninput = cost;
    cost();
    $('#ppCreate').onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return; // уже создаём — повторные нажатия игнорируем
      const code = $('#ppCode').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{5,20}$/.test(code)) return toast('Промокод: 5–20 латинских букв или цифр', 'err');
      const uses = Math.floor(Number($('#ppUses').value));
      const reward = Number($('#ppReward').value);
      if (!(uses >= 1)) return toast('Укажи количество активаций', 'err');
      if (!(reward > 0)) return toast('Укажи, сколько монет даёт одна активация', 'err');
      btn.disabled = true;
      try {
        const ok = await confirmBox(
          `Создать промокод ${code}: ${uses} активаций по ${fmt(reward)} BG?\nС баланса спишется ${fmt(uses * reward)} BG.`,
          { ok: 'Создать' },
        );
        if (!ok) return;
        const r = await api('/api/promos', { method: 'POST', body: { code, uses, reward, key: newKey() } });
        setBalance(r.balance);
        haptic('success');
        toast(`Промокод ${r.promo.code} создан`);
        drawPartnerPromos();
      } catch (e) {
        fail(e);
      } finally {
        btn.disabled = false;
      }
    };
    $$('[data-pdel]', box).forEach((b) => (b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true;
      try {
        // Сумма в окне — на момент открытия. Вернём ровно за те активации, которые останутся неиспользованными
        // в момент удаления: если кто-то успеет активировать раньше, вернётся меньше — сервер считает сам.
        const ok = await confirmBox(
          `Удалить промокод ${b.dataset.code}? Вернём монеты за неиспользованные активации — сейчас это ${fmt(Number(b.dataset.left))} BG.`,
          { ok: 'Удалить' },
        );
        if (!ok) return;
        const r = await api(`/api/promos/${b.dataset.pdel}/delete`, { method: 'POST', body: {} });
        setBalance(r.balance);
        toast(`Промокод удалён, вернули ${fmt(r.refund)} BG`);
        drawPartnerPromos();
      } catch (e) {
        fail(e);
        drawPartnerPromos();
      } finally {
        b.disabled = false;
      }
    }));
  }

  // Тестовые брейнроты (только у админов): открыты на тест-деньги, вне статистики, вывести нельзя
  const testTag = '';
  function drawInventory(inv) {
    state.inv = inv;
    const box = $('#invBox');
    if (!box) return;
    if (!inv.length) {
      box.innerHTML = '<div class="empty">Здесь будут твои брейнроты<a class="btn" href="#/">Открыть кейс</a></div>';
      return;
    }
    box.innerHTML = `<div class="items">${inv
      .map((i) => {
        const w = i.withdraw;
        let layer = '';
        if (w && w.status === 'queued') {
          // старая заявка-замена (брейнрот уже обменян) — без кнопки ×; остальные (и новая замена) — обычный «На выводе»
          const oldEx = w.exchange && typeof w.exchange !== 'object';
          layer = oldEx
            ? `<div class="wd-layer"><div class="spinner"></div>На выводе</div>`
            : `<div class="wd-layer"><div class="spinner"></div>На выводе<button class="wd-cancel" data-cancel="${w.id}" aria-label="Отменить вывод">×</button></div>`;
        } else if (w && w.status === 'waiting') {
          layer = `<div class="wd-layer wd-wait">📦<span>Ждём на складе</span><button class="wd-cancel" data-cancel="${w.id}" aria-label="Отменить вывод">×</button></div>`;
        } else if (w && w.status === 'called') {
          layer = w.inGame
            ? `<div class="wd-layer"><div class="spinner"></div>Ждём тебя в игре</div>`
            : `<div class="wd-layer">Твоя очередь!<button class="wd-ingame" data-ingame="${w.id}">Я в игре</button></div>`;
        }
        // div, а не button: внутри есть свои кнопки (отмена вывода, «Я в игре»)
        return `<div class="item rar-${esc(i.item.rarity)} ${w ? 'withdrawing' : ''} ${i.test ? 'is-test' : ''}" role="button" tabindex="0" data-id="${i.id}">${ogTag(i.item)}${i.test ? testTag : ''}<img loading="lazy" src="${itemImg(i.item.image)}" alt=""><div class="n">${esc(i.item.name)}</div>${price(i.item.price)}${layer}</div>`;
      })
      .join('')}</div>`;
    $$('.item', box).forEach((b) => {
      b.onclick = (ev) => {
        const cancelId = ev.target.closest('[data-cancel]')?.dataset.cancel;
        const ingameId = ev.target.closest('[data-ingame]')?.dataset.ingame;
        if (cancelId) return cancelWithdraw(Number(cancelId));
        if (ingameId) return imInGame(Number(ingameId));
        const it = inv.find((x) => x.id === Number(b.dataset.id));
        if (it && it.status === 'owned') itemActions(it);
      };
    });
  }

  function drawWdHistory(wd) {
    const box = $('#wdHistory');
    const done = wd.requests.filter((r) => !['queued', 'called', 'waiting'].includes(r.status)).slice(0, 10);
    if (!box || !done.length) return;
    const label = { completed: 'Выведен', cancelled: 'Отменён', rejected: 'Отклонён' };
    box.innerHTML = `<div class="section-head"><h2>История выводов</h2></div>${done
      .map((r) => `<div class="line"><img src="${itemImg(r.item.image)}" alt=""><div class="grow"><b>${esc(r.item.name)}</b><span class="muted">${label[r.status] || r.status}${r.note ? ': ' + esc(r.note) : ''}</span></div>${price(r.item.price)}</div>`)
      .join('')}`;
  }

  const GARAMA = 'Garama and Madundung';
  function itemActions(it) {
    const min = state.cfg.withdrawMin;
    // Гарамы дешевле минимума, но выводятся парой: берём эту и ещё одну свободную
    const garPair = it.item.name === GARAMA && it.item.price < min
      ? (state.inv || []).filter((x) => x.status === 'owned' && !x.bought && !x.test && x.item.name === GARAMA && x.id !== it.id).slice(0, 1).map((x) => x.id)
      : null;
    const canWithdraw = false;
    it.withIds = garPair && garPair.length === 1 ? [it.id, garPair[0]] : [it.id];
    const body = h(`
      <div>
        <div class="result-card rar-${esc(it.item.rarity)}" ${it.item.rarity === 'og' ? '' : 'style="box-shadow:none;border-color:var(--ridge-2)"'}>${ogTag(it.item)}
          <img src="${itemImgBig(it.item.image)}" alt=""><b>${esc(it.item.name)}</b>${price(it.item.price)}
        </div>
        <button class="btn" data-a="withdraw" ${canWithdraw ? '' : 'disabled'}>${it.withIds.length > 1 ? `Вывести ${it.withIds.length} шт. в Roblox` : 'Вывести в Roblox'}</button>
        ${canWithdraw ? '' : it.test ? '' : it.reward ? '<p class="hint center">Награда за серию заходов — вывести нельзя. Продай её, поставь в апгрейд или сыграй в мистери: выигрыш вывести можно</p>' : it.bought ? '<p class="hint center">Куплен за баланс — вывести нельзя. Продай его, поставь в апгрейд или сыграй в мистери: выигрыш вывести можно</p>' : `<p class="hint center">${garPair ? 'Garama and Madundung выводится от 2 шт. — нужна ещё одна' : `Вывести можно брейнрота от ${fmt(min)} BG`}</p>`}
        <div class="btn-row" style="margin-top:8px">
          <button class="btn ghost" data-a="sell">Продать за ${price(it.item.price)}</button>
          <button class="btn ghost" data-a="upgrade">Апгрейд</button>
        </div>
      </div>`);
    const s = openSheet('Брейнрот', body);
    $('[data-a=sell]', body).onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      ev.currentTarget.disabled = true;
      try {
        const r = await api('/api/inventory/sell', { method: 'POST', body: { ids: [it.id], key: newKey() } });
        setBalance(r.balance);
        if (r.test) state.me.testBalance = r.testBalance;
        toast(r.test ? `Продано за ${fmt(r.total)} BG` : `Продано за ${fmt(r.total)} BG`);
        s.close();
        renderProfile();
      } catch (e) {
        ev.currentTarget.disabled = false;
        fail(e);
      }
    };
    $('[data-a=upgrade]', body).onclick = () => {
      s.close();
      location.hash = `#/upgrade?item=${it.id}`;
    };
    $('[data-a=withdraw]', body).onclick = () => withdrawSheet(it);
  }

  function withdrawSheet(it) {
    toast('Вывод отключён в этой версии.', 'err'); return;
    if (payBlocked()) return;
    const body = h(`
      <div>
        <div class="line" style="border-top:1px solid var(--ridge)"><img src="${itemImg(it.item.image)}" alt=""><div class="grow"><b>${esc(it.item.name)}${(it.withIds || []).length > 1 ? ` ×${it.withIds.length}` : ''}</b></div>${price(it.item.price * ((it.withIds || []).length || 1))}</div>
        <label class="field"><span>Твой ник в Roblox</span><input id="rbx" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="20" placeholder="Например, Player_123" value="${esc(state.me.robloxUsername || '')}"></label>
        <div class="note">Выводы проходят каждый день ${esc(state.cfg.withdrawWindow)}. Бот напишет в Telegram, когда подойдёт твоя очередь и нужно будет зайти в игру.</div>
        ${state.cfg.withdrawNeed ? `<div class="note">Вывод доступен, если за последние ${state.cfg.withdrawNeed.hours} ч ты пополнил баланс от ${fmt(state.cfg.withdrawNeed.min)} BG — звёздами или брейнротами.</div>` : ''}
        ${state.cfg.withdrawBig && it.item.price >= state.cfg.withdrawBig.from ? `<div class="note warn">🕓 Крупный вывод (от ${fmt(state.cfg.withdrawBig.from)} BG) — обработка займёт <b>до ${state.cfg.withdrawBig.days} дней</b>.</div>` : ''}
        <button class="btn" id="wdGo">Поставить на вывод</button>
      </div>`);
    const s = openSheet('Вывод', body);
    $('#wdGo', body).onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      const nick = $('#rbx', body).value.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) return toast('Ник в Roblox: 3–20 символов, латиница, цифры и _', 'err');
      ev.currentTarget.disabled = true;
      const btn = ev.currentTarget;
      const picked = {}; // выбор по каждому брейнроту копится: при выводе пары спросим про каждый
      const send = async (choices) => {
        Object.assign(picked, choices || {});
        const r = await api('/api/withdraw', { method: 'POST', body: { ids: it.withIds || [it.id], robloxUsername: nick, choices: picked } });
        state.me.robloxUsername = nick;
        if (r.balance != null) setBalance(r.balance);
        s.close();
        haptic('success');
        const ex = r.requests.filter((x) => x.mode === 'exchange').length;
        if (r.bigDays) toast(`Крупный вывод — обработка займёт до ${r.bigDays} дней. Бот напишет, когда подойдёт очередь`);
        else if (r.waiting) toast('Как только брейнрот появится у нас на складе, вывод встанет в очередь — бот напишет');
        else if (ex) toast('Ты в очереди на вывод. Замену выдадим в игре, когда подойдёт твоя очередь — бот напишет');
        else toast('Ты в очереди на вывод. Бот напишет, когда нужно будет зайти в игру');
        renderProfile();
      };
      try {
        await send();
      } catch (e) {
        btn.disabled = false;
        // брейнрота нет на складе — даём выбрать: замена сразу или подождать
        if (e.code === 'need_choice' && e.data?.offers?.length) return exchangeSheet(e.data.offers[0], s, send);
        if (e.code === 'need_recent_deposit') {
          const b2 = h(`<div><p>${esc(e.message)}</p><button class="btn" id="needDep">Пополнить баланс</button></div>`);
          const s3 = openSheet('Нужно пополнение', b2);
          $('#needDep', b2).onclick = () => { s3.close(); s.close(); openDeposit(); };
          return;
        }
        fail(e);
      }
    };
  }

  // Брейнрота нет на складе: замена драконами / Гарамами (+ остаток на баланс) или подождать, пока появится
  function exchangeSheet(o, parent, send) {
    const ex = o.exchange;
    const body = h(`
      <div>
        <p class="ex-lead">«${esc(o.item.name)}» сейчас нет у нас на складе. Как поступим?</p>
        ${ex ? `
        <div class="ex-card">
          <div class="ex-title">Вывести с заменой</div>
          <div class="line"><img src="${itemImg(ex.item.image)}" alt=""><div class="grow"><b>${ex.qty} × ${esc(ex.item.name)}</b>${ex.change > 0 ? `<span class="muted">+ ${fmt(ex.change)} BG на баланс</span>` : ''}</div></div>
          <p class="muted">Сейчас ничего не меняется: «${esc(o.item.name)}» просто встанет в очередь на вывод. Когда тебя вызовут, в игре выдадим это вместо него. До этого можно отменить.</p>
          <button class="btn" data-a="exchange">Вывести с заменой</button>
        </div>` : '<p class="hint">Заменить сейчас нечем — на складе не хватает брейнротов для замены.</p>'}
        <div class="ex-card">
          <div class="ex-title">Подождать «${esc(o.item.name)}»</div>
          <p class="muted">Как только он появится у нас на складе, вывод сам встанет в очередь, и бот напишет. Пока ждёшь, отменить можно в любой момент.</p>
          <button class="btn ghost" data-a="wait">Подождать</button>
        </div>
      </div>`);
    const s2 = openSheet('Нет на складе', body);
    const go = (choice) => async (ev) => {
      const b = ev.currentTarget;
      $$('button', body).forEach((x) => (x.disabled = true));
      try {
        await send({ [o.inventoryId]: choice });
        s2.close();
        parent.close?.();
      } catch (e) {
        $$('button', body).forEach((x) => (x.disabled = false));
        if (e.code === 'need_choice' && e.data?.offers?.length) { s2.close(); return exchangeSheet(e.data.offers[0], parent, send); }
        fail(e);
      }
      return b;
    };
    const exBtn = $('[data-a=exchange]', body);
    if (exBtn) exBtn.onclick = go('exchange');
    $('[data-a=wait]', body).onclick = go('wait');
  }

  async function cancelWithdraw(id) {
    try {
      await api(`/api/withdraw/${id}/cancel`, { method: 'POST', body: {} });
      toast('Вывод успешно отменён');
      renderProfile();
    } catch (e) {
      fail(e);
      renderProfile();
    }
  }

  async function imInGame(id) {
    try {
      await api(`/api/withdraw/${id}/in-game`, { method: 'POST', body: {} });
      toast('Отлично, сейчас отправим брейнрота');
      renderProfile();
    } catch (e) {
      fail(e);
    }
  }

  async function copy(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('<textarea style="position:fixed;opacity:0"></textarea>');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg, 'ok', 2500);
  }

  // =====================================================================
  //                             ПОПОЛНЕНИЕ
  // =====================================================================
  const dep = { tab: 'stars', sel: new Map(), q: '', from: '', to: '', sort: 'desc', catalog: null, timers: [] };
  const stopDepTimers = () => { dep.timers.forEach(clearInterval); dep.timers = []; };

  // Одно поле «Промокод или код друга» в пополнении
  const refPct = () => state.me.refBonusPercent || state.cfg.refBonusPercent;
  function codeFieldsHtml() {
    const hb = state.home?.bonus;
    const about = state.me.canEnterRefCode
      ? `Промокод с главной даёт бонус к пополнению. Код друга — +${fmt(refPct())}% к каждому пополнению, где его ввёл; на аккаунт можно привязать только один код друга.`
      : 'Промокод с главной даёт бонус к пополнению.';
    return `
      <label class="field"><span>Промокод или код друга</span><input id="dPromo" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Например, ${esc(hb?.code || 'DRAGON47')}" value="${esc(dep.promo || '')}"></label>
      <p class="hint" style="margin-top:6px">${about}</p>`;
  }
  // Что за код в поле — спрашиваем у сервера, пока игрок печатает (промокод с главной узнаём сразу)
  const peek = { code: '', res: null, timer: 0 };
  function knownBonus(box) {
    const code = ($('#dPromo', box)?.value || '').trim().toUpperCase();
    const bound = state.me.firstDepositBonus || 0; // уже привязан к другу, впереди первое пополнение
    let pct = bound;
    const parts = bound ? [`+${fmt(bound)}% к первому пополнению по коду друга`] : [];
    if (code.length >= 3) {
      const r = peek.code === code ? peek.res : null;
      if (!r) parts.push('Проверяем код…');
      else if (r.ok && r.kind === 'friend' && bound) { /* тот же друг — бонус уже учтён */ }
      else if (r.ok) { pct += r.percent; if (r.text) parts.push(r.text); }
      else if (r.text) parts.push('⚠ ' + r.text);
    }
    return { pct, text: parts.join('. ') };
  }
  function watchCode(box, recalc) {
    const inp = $('#dPromo', box);
    if (!inp) return recalc();
    const run = () => {
      const code = inp.value.trim().toUpperCase();
      clearTimeout(peek.timer);
      if (code !== peek.code) {
        peek.code = code;
        peek.res = null;
        const hb = state.home?.bonus;
        if (hb && code === hb.code) {
          peek.res = hb.used
            ? { ok: false, kind: 'bonus', percent: 0, text: 'Ты уже использовал этот промокод' }
            : { ok: true, kind: 'bonus', percent: hb.percent, text: `+${fmt(hb.percent)}% к пополнению по промокоду ${hb.code}` };
        } else if (code.length >= 3) {
          peek.timer = setTimeout(async () => {
            let r;
            try { r = await api('/api/deposit/code', { method: 'POST', body: { code } }); }
            catch { r = { ok: true, kind: null, percent: 0, text: 'Код проверим, когда создашь оплату' }; }
            if (peek.code === code) { peek.res = r; recalc(); }
          }, 350);
        }
      }
      recalc();
    };
    inp.oninput = run;
    run();
  }
  const codeBody = (box) => ({ promo: $('#dPromo', box)?.value.trim() || undefined });
  function afterCodes(kind) {
    if (kind === 'friend') {
      if (state.me.canEnterRefCode) state.me.firstDepositBonus = refPct();
      Object.assign(state.me, { hasReferrer: true, canEnterRefCode: false });
    }
    dep.promo = '';
    peek.code = '';
    peek.res = null;
  }

  function openDeposit(tab = dep.tab, { promo } = {}) { toast('Пополнение отключено. Баланс меняется в админке.', 'err'); return;
    if (payBlocked()) return;
    if (promo !== undefined) dep.promo = promo;
    const body = h(`<div><div class="seg" id="depSeg" style="margin-top:0"><button data-t="stars">Звёзды</button><button data-t="items">Брейнроты</button></div><div id="dep"></div></div>`);
    openSheet('Пополнение', body, { onClose: stopDepTimers });
    $$('#depSeg button', body).forEach((b) => (b.onclick = () => showDepTab(b.dataset.t)));
    showDepTab(tab);
  }

  function showDepTab(tab) {
    dep.tab = tab;
    stopDepTimers();
    $$('#depSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
    if (tab === 'stars') starsTab();
    else itemsTab();
  }

  // ----- Звёзды -----
  function starsTab() {
    const cfg = state.cfg;
    const box = $('#dep');
    box.innerHTML = `
      <label class="field"><span>Сколько звёзд</span><input id="stars" type="number" inputmode="numeric" min="${cfg.starsMin}" max="${cfg.starsMax}" placeholder="Например, 100"></label>
      ${codeFieldsHtml()}
      <div class="total"><span>Получишь</span><b>${COIN}<span id="get">0</span></b></div>
      <p class="hint" id="bonusHint"></p>
      <button class="btn" id="pay" disabled>Оплатить звёздами</button>
      <p class="hint center">1 ⭐ = ${fmt(cfg.starsRate)} BG, минимум ${cfg.starsMin} ⭐. Зачисление сразу после оплаты.</p>`;
    const inp = $('#stars', box);
    const recalc = () => {
      const n = Math.floor(Number(inp.value) || 0);
      const base = n * cfg.starsRate;
      const kb = knownBonus(box);
      $('#get', box).textContent = fmt(base * (1 + kb.pct / 100));
      $('#bonusHint', box).textContent = kb.text;
      $('#pay', box).disabled = !(n >= cfg.starsMin && n <= cfg.starsMax);
    };
    inp.oninput = recalc;
    watchCode(box, recalc);
    $('#pay', box).onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const codes = codeBody(box);
        const r = await api('/api/deposit/stars', { method: 'POST', body: { stars: Math.floor(Number(inp.value)), ...codes } });
        afterCodes(r.codeKind);
        const after = (status) => {
          if (status === 'paid') {
            haptic('success');
            toast(r.bonus > 0 ? `Оплата прошла: ${fmt(r.bg)} BG и +${fmt(r.bonus)} BG бонусом` : 'Оплата прошла, BG уже на балансе');
            if (codes.promo && state.home?.bonus && codes.promo.toUpperCase() === state.home.bonus.code) state.home.bonus.used = true;
            closeSheet();
            pollBalance();
          } else if (status === 'failed') toast('Оплата не прошла', 'err');
          btn.disabled = false;
        };
        if (TG?.openInvoice) TG.openInvoice(r.link, after);
        else {
          window.open(r.link, '_blank');
          btn.disabled = false;
        }
      } catch (e) {
        btn.disabled = false;
        fail(e);
      }
    };
  }

  async function pollBalance() {
    const before = state.me.balance;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      try {
        const me = await refreshMe();
        if (me.balance !== before) break;
      } catch {}
    }
    state.caseUpdate?.();
  }

  // ----- Брейнроты -----
  async function itemsTab() {
    const box = $('#dep');
    box.innerHTML = '<div class="skeleton"></div>';
    let cur;
    try {
      cur = await api('/api/deposit/current');
    } catch (e) {
      return fail(e);
    }
    if (dep.tab !== 'items' || !$('#dep')) return;
    if (cur.request && ['queued', 'active'].includes(cur.request.status)) return queueView(cur);
    if (cur.request) return finishedView(cur.request);
    return catalogView(cur.open);
  }

  async function catalogView(open) {
    const box = $('#dep');
    // приём на паузе — в очередь не встать
    if (open === false) {
      box.innerHTML = `<div class="empty dep-paused"><img src="${mascot('pause')}" alt="" style="width:150px;max-width:50%;height:auto;margin:0 auto 6px;display:block"><b>Упсс…</b><p>Сейчас пополнения брейнротами на паузе.<br>Приходи позже</p><button class="btn" id="dreload">Проверить снова</button></div>`;
      $("#dreload", box).onclick = () => itemsTab();
      return;
    }
    if (!dep.catalog) {
      box.innerHTML = '<div class="skeleton"></div>';
      try {
        dep.catalog = await api('/api/deposit/catalog');
      } catch (e) {
        return fail(e);
      }
    }
    const cat = dep.catalog;
    box.innerHTML = `
      <p class="hint" style="margin-top:0">Выбери одного или сразу несколько брейнротов. Отдашь их одним трейдом в Roblox, BG зачислятся после приёма.</p>
      <input class="search" id="dq" placeholder="Поиск брейнрота" value="${esc(dep.q)}" style="margin-top:12px">
      <div class="filters">
        <input id="dfrom" inputmode="decimal" placeholder="Цена от" value="${esc(dep.from)}">
        <input id="dto" inputmode="decimal" placeholder="до" value="${esc(dep.to)}">
        <button class="sort" id="dsort"></button>
      </div>
      <div class="items" id="dgrid"></div>
      <div class="picked"><button class="btn" id="dnext"></button></div>`;
    const draw = () => {
      const q = dep.q.toLowerCase();
      const from = Number(dep.from) || 0;
      const to = Number(dep.to) || Infinity;
      let list = cat.items.filter((i) => i.name.toLowerCase().includes(q) && i.price >= from && i.price <= to);
      list = list.sort((a, b) => (dep.sort === 'desc' ? b.price - a.price : a.price - b.price));
      $('#dsort').textContent = dep.sort === 'desc' ? 'Сначала дорогие' : 'Сначала дешёвые';
      $('#dgrid').innerHTML = list.length
        ? list
            .map((i) => {
              const n = dep.sel.get(i.id) || 0;
              return `<button class="item rar-${esc(i.rarity)} ${n ? 'sel' : ''}" data-id="${i.id}">${n ? `<span class="qty">${n}</span><span class="minus" data-minus="${i.id}">−</span>` : ''}${i.minQty && !n ? `<span class="min-qty">от ${i.minQty} шт.</span>` : ''}${ogTag(i)}<img loading="lazy" src="${itemImg(i.image)}" alt=""><div class="n">${esc(i.name)}</div>${price(i.price)}</button>`;
            })
            .join('')
        : '<div class="empty" style="grid-column:1/-1">Ничего не нашлось</div>';
      const count = [...dep.sel.values()].reduce((a, b) => a + b, 0);
      const sum = [...dep.sel.entries()].reduce((a, [id, n]) => a + (cat.items.find((x) => x.id === id)?.price || 0) * n, 0);
      const nb = $('#dnext');
      nb.disabled = !count;
      nb.innerHTML = count ? `Продолжить: ${count} шт. на ${price(sum)}` : 'Выбери брейнротов';
      $$('#dgrid .item').forEach((b) => {
        b.onclick = (ev) => {
          const id = Number(b.dataset.id);
          const n = dep.sel.get(id) || 0;
          const minQty = cat.items.find((x) => x.id === id)?.minQty || 1;
          if (ev.target.closest('[data-minus]')) {
            if (n <= minQty) dep.sel.delete(id);
            else dep.sel.set(id, n - 1);
          } else {
            const add = n === 0 ? minQty : 1; // Гарамы — сразу парой: их принимаем от 2 шт.
            if (count + add > cat.maxItems) return toast(`За одну заявку можно до ${cat.maxItems} брейнротов`, 'err', 3000);
            dep.sel.set(id, n + add);
          }
          tick();
          draw();
        };
      });
    };
    $('#dq').oninput = (e) => { dep.q = e.target.value; draw(); };
    $('#dfrom').oninput = (e) => { dep.from = e.target.value.replace(',', '.'); draw(); };
    $('#dto').oninput = (e) => { dep.to = e.target.value.replace(',', '.'); draw(); };
    $('#dsort').onclick = () => { dep.sort = dep.sort === 'desc' ? 'asc' : 'desc'; draw(); };
    $('#dnext').onclick = () => summaryView(open);
    draw();
  }

  function summaryView(open) {
    const cat = dep.catalog;
    const box = $('#dep');
    const lines = [...dep.sel.entries()].map(([id, n]) => ({ it: cat.items.find((x) => x.id === id), n })).filter((l) => l.it);
    const sum = lines.reduce((a, l) => a + l.it.price * l.n, 0);
    box.innerHTML = `
      <button class="back" id="dback">‹ Назад к выбору</button>
      ${lines.map((l) => `<div class="line"><img src="${itemImg(l.it.image)}" alt=""><div class="grow"><b>${esc(l.it.name)} ×${l.n}</b></div>${price(l.it.price * l.n)}<button class="x" data-rm="${l.it.id}" aria-label="Убрать">×</button></div>`).join('')}
      <div class="total"><span>Всего получишь</span><b>${COIN}<span id="dget">${fmt(sum)}</span></b></div>
      <p class="hint" id="dbonus"></p>
      ${sum < cat.minTotal ? `<div class="note warn">Минимальное пополнение — ${fmt(cat.minTotal)} BG. Добавь ещё брейнротов</div>` : ''}
      <label class="field"><span>Твой ник в Roblox</span><input id="drbx" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="20" placeholder="Например, Player_123" value="${esc(state.me.robloxUsername || '')}"></label>
      ${codeFieldsHtml()}
      <button class="btn" id="dcreate" ${sum < cat.minTotal ? 'disabled' : ''}>Создать заявку</button>`;
    const recalc = () => {
      const kb = knownBonus(box);
      $('#dget', box).textContent = fmt(sum * (1 + kb.pct / 100));
      $('#dbonus', box).textContent = kb.text;
    };
    watchCode(box, recalc);
    $('#dback').onclick = () => catalogView(open);
    $$('[data-rm]', box).forEach((b) => (b.onclick = () => { dep.sel.delete(Number(b.dataset.rm)); dep.sel.size ? summaryView(open) : catalogView(open); }));
    $('#dcreate').onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      const nick = $('#drbx').value.trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) return toast('Ник в Roblox: 3–20 символов, латиница, цифры и _', 'err');
      const createBtn = ev.currentTarget;
      createBtn.disabled = true;
      try {
        const r = await api('/api/deposit/items', {
          method: 'POST',
          body: { items: lines.map((l) => ({ itemId: l.it.id, qty: l.n })), robloxUsername: nick, ...codeBody(box) },
        });
        state.me.robloxUsername = nick;
        afterCodes(r.codeKind);
        dep.sel.clear();
        haptic('success');
        toast('Заявка создана. Бот напишет, когда подойдёт очередь');
        itemsTab();
      } catch (e) {
        createBtn.disabled = false;
        if (e.code === 'deposits_paused') return catalogView(false); // пока выбирал — приём поставили на паузу
        fail(e);
      }
    };
  }

  function queueView(cur) {
    const r = cur.request;
    const box = $('#dep');
    const active = r.status === 'active';
    let left = active ? r.secondsLeft : r.etaSeconds;
    box.innerHTML = `
      <div class="center" style="padding:6px 0 4px">
        ${active
          ? `<div class="queue-num">Твоя очередь!</div>
             <p>Отправь трейд в Roblox аккаунту <b>${esc(r.tradeAccount || '—')}</b></p>
             <div class="muted">Осталось</div>`
          : r.ahead
            ? `<div class="muted">Ты в очереди</div><div class="queue-num">№${r.position}</div>
               <p class="hint">Впереди ${r.ahead} ${plural(r.ahead, 'заявка', 'заявки', 'заявок')}. Примерное ожидание:</p>`
            : `<div class="muted">Ты в очереди</div><div class="queue-num">№1</div>
               <p class="hint">Ты следующий. Примерное ожидание:</p>`}
        <div class="timer" id="qtimer">${mmss(left)}</div>
      </div>
      ${cur.open === false && !active ? '<div class="note warn">Приём сейчас на паузе, очередь продолжится, когда мы вернёмся.</div>' : ''}
      <div class="note">Бот напишет в Telegram, когда подойдёт очередь. Это окно можно закрыть.</div>
      <div style="margin-top:12px">${r.items.map((i) => `<div class="line"><img src="${itemImg(i.image)}" alt=""><div class="grow"><b>${esc(i.name)} ×${i.qty}</b></div>${price(i.price * i.qty)}</div>`).join('')}</div>
      <div class="total"><span>Ник: ${esc(r.robloxUsername)}</span><b>${COIN}${fmt(r.total)}</b></div>
      <button class="btn danger" id="dcancel">Отменить заявку</button>`;
    dep.timers.push(setInterval(() => {
      left = Math.max(0, left - 1);
      const el = $('#qtimer');
      if (el) el.textContent = mmss(left);
    }, 1000));
    dep.timers.push(setInterval(async () => {
      try {
        const fresh = await api('/api/deposit/current');
        if (dep.tab !== 'items' || !$('#dep')) return;
        stopDepTimers();
        if (fresh.request && ['queued', 'active'].includes(fresh.request.status)) queueView(fresh);
        else if (fresh.request) finishedView(fresh.request);
        else catalogView(fresh.open);
      } catch {}
    }, 10000));
    $('#dcancel').onclick = async (ev) => {
      ev = { currentTarget: ev.currentTarget }; // после await у события пропадает currentTarget
      if (!(await confirmBox('Отменить заявку на пополнение? Место в очереди пропадёт.', { ok: 'Отменить заявку', cancel: 'Назад' }))) return;
      ev.currentTarget.disabled = true;
      try {
        await api(`/api/deposit/items/${r.id}/cancel`, { method: 'POST', body: {} });
        stopDepTimers();
        toast('Заявка отменена');
        catalogView(cur.open);
      } catch (e) {
        ev.currentTarget.disabled = false;
        fail(e);
      }
    };
  }

  function finishedView(r) {
    const box = $('#dep');
    const text = {
      completed: `Зачислено ${fmt(r.credited)} BG`,
      cancelled: 'Заявка отменена',
      expired: 'Время на трейд вышло',
      rejected: `Заявка отклонена${r.note ? ': ' + r.note : ''}`,
    }[r.status];
    box.innerHTML = `
      <div class="center" style="padding:10px 0"><div class="queue-num" style="font-size:26px">${esc(text || r.status)}</div></div>
      <button class="btn" id="dnew">Новая заявка</button>`;
    if (r.status === 'completed') refreshMe().catch(() => {});
    $('#dnew').onclick = () => catalogView();
  }

  // =====================================================================
  //                                СТАРТ
  // =====================================================================
  // ---------- Полный экран (Telegram 8.0+) ----------
  // На компьютере открываемся сразу во весь экран, на телефоне остаётся обычный вид.
  // Кнопка ⛶ в шапке переключает режим вручную (только на компьютере).
  function setupFullscreen() {
    if (!TG?.isVersionAtLeast?.('8.0') || !TG.requestFullscreen) return;
    const desktop = ['tdesktop', 'macos', 'weba', 'webk', 'web'].includes(TG.platform);
    if (!desktop) return;
    const btn = $('#fsBtn');
    btn.classList.remove('hidden');
    btn.onclick = () => {
      try { TG.isFullscreen ? TG.exitFullscreen() : TG.requestFullscreen(); } catch {}
    };
    try { if (!TG.isFullscreen) TG.requestFullscreen(); } catch {}
  }

  async function boot() {
    await window.sandboxReady;
    applyStreamer();
    if (TG) {
      try {
        TG.ready();
        TG.expand();
        TG.setHeaderColor?.('#0c1110');
        TG.setBackgroundColor?.('#0c1110');
        if (TG.isVersionAtLeast?.('7.7')) TG.disableVerticalSwipes();
        // Пункт «Настройки» в меню ⋮ Telegram
        if (TG.SettingsButton && TG.isVersionAtLeast?.('7.0')) {
          TG.SettingsButton.onClick(() => openSettings());
          TG.SettingsButton.show();
        } else TG.onEvent?.('settingsButtonClicked', () => openSettings());
        setupFullscreen();
        TG.BackButton?.onClick(() => {
          if (state.locked) return lockedNotice();
          if (menu) return closeMenu();
          if (sheet) return closeSheet();
          if (history.length > 1) history.back();
          else location.hash = '#/';
        });
      } catch {}
    }
    if (false) { // Browser guests are supported by this sandbox backend.
      view.innerHTML = '<div class="empty">Открой Brainrot Grader через бота в Telegram</div>';
      return;
    }
    try {
      [state.me, state.cfg] = await Promise.all([api('/api/me'), api('/api/config')]);
      // Старая версия страницы из кэша Telegram — перезагружаем на свежую (один раз на версию)
      const mine = document.querySelector('meta[name="bg-build"]')?.content || '';
      if (state.cfg.build && mine !== state.cfg.build) {
        let tried = '';
        try { tried = sessionStorage.getItem('bg_reload') || ''; } catch {}
        if (tried !== state.cfg.build) {
          try { sessionStorage.setItem('bg_reload', state.cfg.build); } catch {}
          const qs = new URLSearchParams(location.search);
          qs.set('r', state.cfg.build);
          location.replace(location.pathname + '?' + qs.toString() + location.hash);
          return;
        }
      }
    } catch (e) {
      if (e.code !== 'site_closed') view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    adminModeStrip();
    halloween(state.cfg.theme === 'halloween');
    streakCheckin();
    // «я тут» для счётчика онлайна в админке — раз в минуту, пока приложение на экране
    setInterval(() => { if (!document.hidden) api('/api/ping').catch(() => {}); }, 60000);
    setBalance(state.me.balance);
    fillAvatar($('#avatar'));
    $('#topup').onclick = () => openDeposit();
    $('#menuBtn').onclick = () => (menu ? closeMenu() : openMenu());
    setupDesktop();
    addEventListener('hashchange', route);
    route();
  }

  boot();
})();
