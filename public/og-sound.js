// Звук выпадения OG — синтез на лету, без файлов.
//  rise(ctx, out, t, sec) — нарастание: «суперсо» и шумовой подъём, удары всё чаще, в конце дробь малого;
//                           за мгновение до удара всё обрывается — так удар бьёт сильнее;
//  boom(ctx, out, t)      — удар с суббасом, «взрыв», тарелка, медный аккорд и звенящие искры, всё с эхом.
// Отдельный файл, чтобы тот же звук можно было отрендерить в превью.
(() => {
  'use strict';
  const cache = new WeakMap();
  const kit = (ctx, out) => {
    let k = cache.get(ctx);
    if (k && k.out === out) return k;
    // Эхо зала: импульс из затухающего шума
    const len = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4);
    }
    const verb = ctx.createConvolver();
    verb.buffer = ir;
    const vg = ctx.createGain();
    vg.gain.value = 0.32;
    verb.connect(vg).connect(out);
    const nlen = Math.floor(ctx.sampleRate * 3.5);
    const noise = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    // Мягкий перегруз для удара
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.6);
    }
    k = { out, verb, noise, curve };
    cache.set(ctx, k);
    return k;
  };
  const env = (g, t, peak, a, d, curveEnd = 0.0001) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(curveEnd, t + a + d);
  };
  const noiseSrc = (ctx, k, t, dur, offset = Math.random() * 2) => {
    const s = ctx.createBufferSource();
    s.buffer = k.noise;
    s.start(t, offset, dur + 0.05);
    return s;
  };
  const kick = (ctx, k, t, vol, f0 = 120, f1 = 45, dur = 0.18) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.8);
    env(g, t, vol, 0.004, dur);
    o.connect(g).connect(k.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  };
  const snare = (ctx, k, t, vol) => {
    const s = noiseSrc(ctx, k, t, 0.08);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const g = ctx.createGain();
    env(g, t, vol, 0.002, 0.06);
    s.connect(hp).connect(g);
    g.connect(k.out);
    g.connect(k.verb);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.05);
    env(og, t, vol * 0.6, 0.002, 0.06);
    o.connect(og).connect(k.out);
    o.start(t);
    o.stop(t + 0.1);
  };

  function rise(ctx, out, t, sec = 3) {
    const base = kit(ctx, out);
    // Всё нарастание идёт через свою громкость — чтобы его можно было оборвать (пропуск прокрута)
    const gOut = ctx.createGain();
    const gVerb = ctx.createGain();
    gOut.connect(base.out);
    gVerb.connect(base.verb);
    const k = { ...base, out: gOut, verb: gVerb };
    const end = t + sec;
    const cut = end - 0.07; // короткая тишина перед ударом
    // 1) Суперсо: три расстроенные пилы ползут вверх на две октавы, фильтр открывается
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 5;
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.exponentialRampToValueAtTime(5200, cut);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.05, t + sec * 0.6);
    sg.gain.exponentialRampToValueAtTime(0.085, cut - 0.02);
    sg.gain.exponentialRampToValueAtTime(0.0001, cut);
    lp.connect(sg);
    sg.connect(k.out);
    sg.connect(k.verb);
    [-14, 0, 11].forEach((cents) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = cents;
      o.frequency.setValueAtTime(98, t);
      o.frequency.exponentialRampToValueAtTime(392, cut);
      o.connect(lp);
      o.start(t);
      o.stop(cut + 0.02);
    });
    // 2) Шумовой подъём: «вжжжж» всё выше и громче
    const ns = noiseSrc(ctx, k, t, sec);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(7500, cut);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.16, cut - 0.02);
    ng.gain.exponentialRampToValueAtTime(0.0001, cut);
    ns.connect(bp).connect(ng).connect(k.out);
    // 3) Удары: от редких к частым, последние полсекунды — дробь малого барабана
    const rollFrom = sec - Math.min(0.6, sec * 0.25);
    for (let at = 0.02; at < rollFrom; ) {
      const p = at / sec;
      kick(ctx, k, t + at, 0.45 + p * 0.4);
      at += 0.5 - p * 0.36;
    }
    for (let at = rollFrom; at < sec - 0.09; ) {
      const p = (at - rollFrom) / (sec - rollFrom);
      snare(ctx, k, t + at, 0.12 + p * 0.22);
      at += 0.07 - p * 0.035;
    }
    return {
      stop() {
        const n = ctx.currentTime;
        [gOut, gVerb].forEach((g) => {
          g.gain.cancelScheduledValues(n);
          g.gain.setValueAtTime(g.gain.value, n);
          g.gain.linearRampToValueAtTime(0, n + 0.06);
        });
      },
    };
  }

  function boom(ctx, out, t) {
    const k = kit(ctx, out);
    // 1) Удар: перегруженный «бум» с падающим тоном + щелчок атаки
    const o = ctx.createOscillator();
    const ws = ctx.createWaveShaper();
    ws.curve = k.curve;
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.55);
    env(g, t, 0.75, 0.005, 0.75);
    o.connect(ws).connect(g).connect(k.out);
    o.start(t);
    o.stop(t + 0.85);
    const click = noiseSrc(ctx, k, t, 0.02);
    const cg = ctx.createGain();
    env(cg, t, 0.5, 0.001, 0.018);
    click.connect(cg).connect(k.out);
    // Суббас-хвост
    const sub = ctx.createOscillator();
    const subg = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(58, t);
    sub.frequency.exponentialRampToValueAtTime(41, t + 1.4);
    env(subg, t, 0.42, 0.02, 1.4);
    sub.connect(subg).connect(k.out);
    sub.start(t);
    sub.stop(t + 1.5);
    // 2) «Взрыв»: шум, фильтр закрывается сверху вниз
    const ex = noiseSrc(ctx, k, t, 1.2);
    const exf = ctx.createBiquadFilter();
    exf.type = 'lowpass';
    exf.frequency.setValueAtTime(5000, t);
    exf.frequency.exponentialRampToValueAtTime(180, t + 1.1);
    const exg = ctx.createGain();
    env(exg, t, 0.42, 0.006, 1.15);
    ex.connect(exf).connect(exg);
    exg.connect(k.out);
    exg.connect(k.verb);
    // 3) Тарелка: длинный яркий шум
    const cr = noiseSrc(ctx, k, t, 2.2);
    const crf = ctx.createBiquadFilter();
    crf.type = 'highpass';
    crf.frequency.value = 5200;
    const crg = ctx.createGain();
    env(crg, t, 0.2, 0.004, 2.1);
    cr.connect(crf).connect(crg);
    crg.connect(k.out);
    crg.connect(k.verb);
    // 4) Медный аккорд: до мажор, широкие пилы, фильтр «раскрывается» и медленно гаснет
    const bf = ctx.createBiquadFilter();
    bf.type = 'lowpass';
    bf.Q.value = 2;
    bf.frequency.setValueAtTime(500, t);
    bf.frequency.exponentialRampToValueAtTime(4200, t + 0.06);
    bf.frequency.exponentialRampToValueAtTime(900, t + 1.8);
    const bg = ctx.createGain();
    env(bg, t, 0.2, 0.03, 1.9);
    bf.connect(bg);
    bg.connect(k.out);
    bg.connect(k.verb);
    [130.81, 261.63, 329.63, 392, 523.25].forEach((fq) => {
      [-9, 8].forEach((cents) => {
        const b = ctx.createOscillator();
        b.type = 'sawtooth';
        b.frequency.value = fq;
        b.detune.value = cents;
        b.connect(bf);
        b.start(t);
        b.stop(t + 2);
      });
    });
    // 5) Звенящие искры: колокольчики вверх по аккорду, потом россыпь высоких
    const bell = (fq, at, vol, dur) => {
      [1, 2.76, 5.4].forEach((m, i) => {
        const b = ctx.createOscillator();
        const bgn = ctx.createGain();
        b.type = 'sine';
        b.frequency.value = fq * m;
        env(bgn, at, vol / (1 + i * 2.2), 0.003, dur / (1 + i));
        b.connect(bgn);
        bgn.connect(k.out);
        bgn.connect(k.verb);
        b.start(at);
        b.stop(at + dur + 0.05);
      });
    };
    [1046.5, 1318.51, 1567.98, 2093, 2637.02].forEach((fq, i) => bell(fq, t + 0.1 + i * 0.075, 0.09, 1.1));
    for (let i = 0; i < 12; i++) bell(2200 + Math.random() * 2600, t + 0.55 + i * 0.075 + Math.random() * 0.04, 0.03, 0.35);
  }

  window.BGOgSound = { rise, boom };
})();
