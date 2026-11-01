// Run in DevTools Console while the ORIGINAL mini app is open and logged in.
// Only catalogue data is copied. No tokens or Telegram initData are exported.
(async () => {
  const initData = window.Telegram?.WebApp?.initData;
  if (!initData) throw new Error('Открой оригинальное мини-приложение внутри Telegram');
  const get = async path => {
    const r = await fetch(path, {headers:{authorization:'tma '+initData}});
    if (!r.ok) throw new Error(path+': HTTP '+r.status);
    return r.json();
  };
  const list = await get('/api/cases');
  if (!Array.isArray(list)) throw new Error('Неизвестный формат списка кейсов');
  const items = new Map(), cases = [];
  let missingWeights = 0;
  const image = value => {
    const u = new URL(value || '/img/unknown.svg',location.origin);
    if(u.origin !== location.origin || !u.pathname.startsWith('/img/'))
      throw new Error('Неожиданный адрес картинки: '+u.href);
    return u.pathname;
  };
  const addItem = i => {
    if(!Number.isInteger(Number(i.id)) || !(Number(i.price)>0))
      throw new Error('Предмет без ID или положительной цены: '+JSON.stringify(i));
    const out={id:Number(i.id),name:i.name,price:Number(i.price),rarity:i.rarity || 'common',image:image(i.image)};
    items.set(out.id,out); return out.id;
  };
  for (const entry of list) {
    const cs = await get('/api/cases/'+entry.id);
    const pool = cs.items.filter(i=>!i.coins).map(i=>{
      const itemId=addItem(i);
      const supplied = i.weight ?? i.chance ?? i.probability;
      if(!(Number(supplied)>0)) missingWeights++;
      return {itemId,weight:Number(supplied)>0?Number(supplied):1};
    });
    if(!pool.length) continue;
    cases.push({id:Number(cs.id),name:cs.name,price:Number(cs.price)||0,
      category:['free','start','standard','platina','allin'].includes(cs.category)?cs.category:'standard',
      freeKind:cs.freeKind?'daily':null,image:image(cs.image || '/img/chest.svg'),items:pool});
  }
  try {const shop=await get('/api/shop');for(const it of shop.items || [])if(!it.coins)addItem(it);}
  catch(e){console.warn('Магазин не экспортирован:',e.message);}
  const result=JSON.stringify({items:[...items.values()],cases},null,2);
  if(typeof copy==='function') copy(result);
  else console.log(result);
  console.info('Каталог скопирован. Вставь JSON в свою админку и сохрани. Кейсов:',cases.length,'предметов:',items.size);
  if(missingWeights)console.warn('У '+missingWeights+' позиций сервер не раскрыл шансы. Для них weight=1. Это НЕ оригинальные вероятности — задай свои в админке. Денежные призы coins исключены.');
})();
