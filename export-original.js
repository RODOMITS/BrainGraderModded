// Paste into DevTools Console while logged into the original Mini App.
(async () => {
  if (location.origin !== 'https://brainrotgrader.com') {
    throw new Error('Открой оригинальный Mini App на brainrotgrader.com');
  }
  const session = window.Telegram?.WebApp?.initData;
  if (!session) throw new Error('Открой оригинальное мини-приложение внутри Telegram');
  const get = async path => {
    const checkin = path === '/api/streak/checkin';
    const headers = { Authorization: 'tma ' + session };
    if (checkin) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      headers, redirect: 'error', method: checkin ? 'POST' : 'GET', body: checkin ? '{}' : undefined,
    });
    if (!response.ok) throw new Error(path + ' — HTTP ' + response.status);
    return response.json();
  };

  const [list, config, shop] = await Promise.all(['/api/cases', '/api/config', '/api/shop'].map(get));
  if (!Array.isArray(list) || !list.length || !Array.isArray(shop.items)) throw new Error('Каталог не загрузился');
  const image = value => {
    const url = new URL(value || '/img/unknown.svg', location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/img/')) {
      throw new Error('Картинка должна находиться в /img/ оригинала');
    }
    return url.pathname + url.search;
  };
  const item = raw => {
    const id = Number(raw.id), price = Number(raw.price);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(price) || price <= 0) {
      throw new Error('В каталоге есть предмет без ID или цены');
    }
    const result = { id, price, name: raw.name, rarity: raw.rarity || 'common', image: image(raw.image) };
    if (raw.coins || raw.rarity === 'coins') result.coins = true;
    const variant = config.mutations?.[raw.name];
    if (typeof variant?.base === 'string' && typeof variant?.mut === 'string') {
      result.baseName = variant.base;
      result.mutation = variant.mut;
    }
    return result;
  };
  const items = new Map(shop.items.map(raw => {
    const normalized = item(raw);
    return [normalized.id, normalized];
  }));
  const cases = [];
  let estimated = 0;
  const categories = new Set(['free', 'start', 'pixel', 'standard', 'platina', 'allin']);
  for (let offset = 0; offset < list.length; offset += 4) {
    const batch = list.slice(offset, offset + 4);
    const details = await Promise.all(batch.map(row => get('/api/cases/' + Number(row.id))));
    for (const [index, detail] of details.entries()) {
      const summary = batch[index];
      const weights = new Map();
      for (const row of detail.items || []) {
        const normalized = item(row);
        items.set(normalized.id, normalized);
        const rawWeight = Number(row.weight ?? row.chance ?? row.probability);
        const previous = weights.get(normalized.id);
        const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : null;
        weights.set(normalized.id, weight != null && previous !== null ? (previous || 0) + weight : null);
      }
      const hasHiddenWeights = [...weights.values()].some(weight => weight == null);
      if (hasHiddenWeights) estimated++;
      const scale = hasHiddenWeights || !weights.size ? 1 : 1_000_000 / Math.max(...weights.values());
      const category = detail.category || summary.category;
      const free = detail.freeKind ?? summary.freeKind;
      cases.push({
        id: Number(summary.id), name: detail.name || summary.name, price: Number(detail.price ?? summary.price) || 0,
        image: image(detail.image || summary.image || '/img/chest.svg'),
        isNew: Boolean(detail.isNew || summary.isNew), category: categories.has(category) ? category : 'standard',
        freeKind: free === 'ref' ? 'ref' : free ? 'daily' : null,
        items: [...weights].map(([itemId, weight]) => ({
          itemId, weight: hasHiddenWeights ? null : Math.max(.01, Math.min(1_000_000, Math.round(weight * scale * 100) / 100)),
        })),
      });
    }
  }

  const out = { version: 1, catalog: { items: [...items.values()], cases } };
  if (config.starsRate > 0 && config.starsMin > 0 && config.starsMax >= config.starsMin) {
    out.stars = { starsRate: config.starsRate, starsMin: config.starsMin, starsMax: config.starsMax };
  }
  out.crypto = config.crypto ? {
    min: config.crypto.min, max: config.crypto.max, rate: config.crypto.rate,
    assets: (config.crypto.assets || []).filter(asset => typeof asset === 'string').slice(0, 30),
  } : null;
  const exchange = config.dragonExchange;
  if (!exchange) out.dragon = null;
  else {
    const dragonName = exchange.dragon?.name || 'Dragon Cannelloni';
    const dragon = items.get(Number(exchange.dragon?.id)) || [...items.values()].find(row =>
      row.name.toLowerCase() === dragonName.toLowerCase());
    if (dragon) out.dragon = { itemId: dragon.id, minimum: exchange.from ?? dragon.price };
    else console.warn('Предмет для размена не найден в каталоге');
  }

  const passGroup = group => group && {
    endsAt: group.endsAt,
    quests: (group.quests || []).map(({ id, title, goal, xp, metric, unit }) => ({ id, title, goal, xp, metric, unit })),
  };
  const sources = {
    '/api/pass': ['pass', data => ({
      enabled: data.enabled === true,
      season: Object.fromEntries(['name', 'started', 'over', 'start', 'end', 'claimUntil', 'startAt', 'endAt', 'claimUntilAt']
        .filter(key => data.season?.[key] !== undefined).map(key => [key, data.season[key]])),
      levels: (data.levels || []).map(({ level, xp, reward }) => ({ level, xp, reward: {
        kind: reward.kind, badge: reward.badge, amount: reward.amount, caseId: reward.caseId ?? reward.id,
        count: reward.count, name: reward.name || cases.find(row => row.id === (reward.caseId ?? reward.id))?.name || 'Кейс',
        image: reward.image ? image(reward.image) : undefined,
      } })),
      daily: passGroup(data.daily), weekly: passGroup(data.weekly),
    })],
    '/api/streak/checkin': ['streak', data => {
      if (!data.track?.length) return undefined;
      const size = Number(data.days) || data.track.length;
      return { enabled: data.enabled, track: data.track.slice(0, size).map(({ day, kind, amount, itemId, caseId }) =>
        ({ day, kind, amount, itemId, caseId })) };
    }],
    '/api/deposit/current': ['deposit', data => typeof data.open === 'boolean' ? { open: data.open } : undefined],
    '/api/deposit/catalog': ['deposit_catalog', data => ({
      minTotal: data.minTotal || 0, items: data.items.map(row => ({ ...item(row), minQty: row.minQty || 1 })),
    })],
    '/api/giveaways': ['giveaways', data => Object.fromEntries(['active', 'finished'].map(group => [
      group, (data[group] || []).filter(row => row.item?.id > 0 && Number.isInteger(row.participants))
        .map(row => ({ itemId: row.item.id, count: row.participants })),
    ]))],
    '/api/home': ['bonus', data => data.bonus ? {
      code: data.bonus.code, percent: data.bonus.percent, endsAt: data.bonus.endsAt,
    } : null],
  };
  await Promise.all(Object.entries(sources).map(async ([url, [name, extract]]) => {
    try {
      const value = extract(await get(url));
      if (value !== undefined) out[name] = value;
      else console.warn('Нет данных для раздела', name);
    } catch {
      console.warn('Раздел временно недоступен', name);
    }
  }));

  const json = JSON.stringify(out, null, 2);
  window.bgModdedExport = json;
  const file = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const download = document.createElement('a');
  download.href = url;
  download.download = 'bg-modded-export.json';
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  console.info('Скачан bg-modded-export.json. Импортируй его в Modded через овнерку.', Object.keys(out).slice(1));
  if (estimated) console.warn('У кейсов с закрытыми шансами Modded рассчитает свои веса. Таких кейсов:', estimated);
})().catch(error => console.error('Экспорт не завершён:', error.message));
