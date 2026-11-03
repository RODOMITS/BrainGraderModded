// Shared original game sound engine.
window.BGCreateAudio = function(prefs) { return (() => {
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
};
