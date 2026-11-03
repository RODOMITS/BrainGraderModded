// Visual controls reuse the existing forms and API contracts.
const fmtAdmin=n=>Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});
const safeAdmin=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rarityNames={common:'Common',rare:'Rare',epic:'Epic',legendary:'Legendary',og:'OG'};
const artAdmin=item=>`<img loading="lazy" src="${safeAdmin(item.image)}" alt="">`;
const valueAdmin=item=>`<span class="card-price"><img src="/img/coin.webp" alt="BG">${fmtAdmin(item.price)}</span>`;
function brainCard(item,selected=false){const card=document.createElement('button');card.type='button';card.className='brain-card'+(selected?' selected':'');card.setAttribute('aria-label',item.name+', '+fmtAdmin(item.price)+' BG');card.innerHTML=`<span class="rarity-label rarity-${safeAdmin(item.rarity)}">${safeAdmin(rarityNames[item.rarity]||'Кейс')}</span>${artAdmin(item)}<b>${safeAdmin(item.name)}</b>${valueAdmin(item)}`;return card;}
const picker=document.createElement('dialog');picker.className='picker-dialog';picker.innerHTML=`<div class="picker-head"><div class="picker-title"><h2>Выбрать брейнрота</h2><button type="button" aria-label="Закрыть">×</button></div><div class="picker-filters"><input type="search" placeholder="Название брейнрота" aria-label="Название брейнрота"><select aria-label="Редкость"><option value="">Все редкости</option>${Object.entries(rarityNames).map(([v,n])=>`<option value="${v}">${n}</option>`).join('')}</select><select aria-label="Сортировка"><option value="asc">Сначала дешевле</option><option value="desc">Сначала дороже</option><option value="name">По названию</option></select></div></div><div class="item-gallery"></div><div class="picker-count"></div>`;document.body.append(picker);
const pickerInputs=picker.querySelectorAll('.picker-filters input,.picker-filters select');let pickerTarget=null;
picker.querySelector('.picker-title button').onclick=()=>picker.close();picker.onclick=e=>{if(e.target===picker){const r=picker.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)picker.close();}};
function drawPicker(){const [search,rarity,sort]=pickerInputs;rarity.disabled=pickerTarget==='streakCaseChoice';const query=search.value.trim().toLowerCase();const source=pickerTarget==='streakCaseChoice'?catalogDraft().cases:adminCatalog;const items=source.filter(i=>(!['liveItem','streakItemChoice'].includes(pickerTarget)||!i.customSession)&&i.name.toLowerCase().includes(query)&&(pickerTarget==='streakCaseChoice'||!rarity.value||i.rarity===rarity.value)).sort((a,b)=>sort.value==='name'?a.name.localeCompare(b.name):sort.value==='desc'?b.price-a.price:a.price-b.price);const grid=picker.querySelector('.item-gallery');grid.replaceChildren(...items.map(item=>{const card=brainCard(item,String(item.id)===$(pickerTarget)?.value);card.onclick=()=>{const select=$(pickerTarget);if(![...select.options].some(o=>o.value===String(item.id)))fillItems(pickerTarget);select.value=item.id;select.dispatchEvent(new Event('change',{bubbles:true}));picker.close();};return card;}));if(!items.length)grid.innerHTML='<div class="gallery-empty">Ничего не найдено. Попробуй другое название.</div>';picker.querySelector('.picker-count').textContent=items.length+' предметов';}
pickerInputs.forEach(input=>input.oninput=drawPicker);
const visualPickers=new Map();
for(const id of ['item','rigItem','liveItem']){const select=$(id);select.hidden=true;const previous=select.previousElementSibling;if(previous?.tagName==='INPUT'&&previous.type==='search')previous.hidden=true;const trigger=document.createElement('button');trigger.type='button';trigger.className='visual-picker';select.after(trigger);const sync=()=>{const item=adminCatalog.find(i=>String(i.id)===select.value);trigger.innerHTML=item?`${artAdmin(item)}<span><b>${safeAdmin(item.name)}</b>${valueAdmin(item)}<small>${safeAdmin(rarityNames[item.rarity]||item.rarity)}</small></span><span class="choose-label">Выбрать →</span>`:'<span>Загружаем каталог…</span>';trigger.disabled=!adminCatalog.length;};trigger.onclick=()=>{pickerTarget=id;pickerInputs[0].value='';drawPicker();picker.showModal();pickerInputs[0].focus();};select.addEventListener('change',sync);new MutationObserver(sync).observe(select,{childList:true});visualPickers.set(id,sync);sync();}
$('liveSearch').hidden=true;
// Game and outcome choices stay visible, rather than buried in native menus.
for(const id of ['rigGame','rigMode','rigHits','liveMode','liveSource']){const select=$(id);select.hidden=true;const strip=document.createElement('div');strip.className='choice-strip';select.after(strip);const sync=()=>{strip.replaceChildren(...[...select.options].filter(o=>!o.disabled).map(o=>{const b=document.createElement('button');b.type='button';b.textContent=o.textContent.replace('Мины: следующий клик — ','');b.setAttribute('aria-pressed',String(o.value===select.value));b.onclick=()=>{select.value=o.value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();};return b;}));};select.addEventListener('change',sync);new MutationObserver(sync).observe(select,{subtree:true,attributes:true,attributeFilter:['disabled']});sync();}
// Preserve explicit changes to native selects made by the existing editor.
window.addEventListener('admin:data',()=>{for(const sync of visualPickers.values())sync();for(const id of ['rigGame','rigMode','rigHits','liveMode','liveSource'])$(id).dispatchEvent(new Event('change'));drawCatalog();});
// The JSON stays available for import/export, but normal editing uses cards.
const catalogSection=$('catalogForm').closest('section');
const advanced=document.createElement('details');advanced.className='advanced-json';advanced.innerHTML='<summary>Импорт и расширенный редактор JSON</summary>';
for(const child of [...catalogSection.children])if(child.tagName!=='H2')advanced.append(child);
catalogSection.append(advanced);
const toolbar=document.createElement('div');toolbar.className='catalog-toolbar';toolbar.innerHTML='<input type="search" placeholder="Найти в каталоге" aria-label="Поиск в каталоге"><button type="button" class="on" data-kind="items">Предметы</button><button type="button" data-kind="cases">Кейсы</button>';
const catalogGrid=document.createElement('div');catalogGrid.className='item-gallery catalog-gallery';catalogSection.insertBefore(toolbar,advanced);catalogSection.insertBefore(catalogGrid,advanced);let catalogKind='items';
toolbar.querySelector('input').oninput=drawCatalog;toolbar.querySelectorAll('button').forEach(b=>b.onclick=()=>{catalogKind=b.dataset.kind;toolbar.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));drawCatalog();});
function catalogDraft(){return JSON.parse($('catalog').value);}
function drawCatalog(){if(!$('catalog').value)return;let data;try{data=catalogDraft();}catch{return;}const q=toolbar.querySelector('input').value.toLowerCase();const entries=(data[catalogKind]||[]).filter(i=>i.name.toLowerCase().includes(q)).sort((a,b)=>a.price-b.price);catalogGrid.replaceChildren(...entries.map(item=>{const card=brainCard(item);card.onclick=()=>editCatalog(item.id,catalogKind);return card;}));if(!entries.length)catalogGrid.innerHTML='<div class="gallery-empty">Ничего не найдено</div>';}
const editor=document.createElement('dialog');editor.className='picker-dialog';document.body.append(editor);
function editCatalog(id,kind){const data=catalogDraft(),entry=data[kind].find(i=>i.id===id);if(!entry)return;const isCase=kind==='cases';editor.replaceChildren();editor.innerHTML=`<div class="picker-head"><div class="picker-title"><h2>${isCase?'Настройка кейса':'Настройка брейнрота'}</h2><button type="button" aria-label="Закрыть">×</button></div></div><div class="edit-hero">${artAdmin(entry)}<div><h2>${safeAdmin(entry.name)}</h2>${valueAdmin(entry)}</div></div><form><div class="edit-fields"><label class="wide">Название<input name="name" value="${safeAdmin(entry.name)}" required maxlength="80"></label><label>Цена BG<input name="price" type="number" min="0" step="0.01" value="${entry.price}" required></label>${!isCase?`<label>Редкость<select name="rarity">${Object.entries(rarityNames).map(([v,n])=>`<option value="${v}" ${entry.rarity===v?'selected':''}>${n}</option>`).join('')}</select></label>`:''}<label class="wide">Картинка<input name="image" value="${safeAdmin(entry.image)}" required></label></div>${isCase?'<div class="case-contents"><h2>Содержимое и веса выпадения</h2><div id="caseEditRows"></div><select id="caseAddItem" hidden></select><button class="secondary" type="button" id="caseAdd">Выбрать брейнрота для кейса</button></div>':''}<div class="edit-footer"><button type="button" class="secondary" data-close>Отмена</button><button type="submit">Сохранить изменения</button></div></form>`;
  editor.querySelector('.picker-title button').onclick=()=>editor.close();editor.querySelector('[data-close]').onclick=()=>editor.close();
  if(isCase){const add=editor.querySelector('#caseAddItem');add.replaceChildren(...data.items.map(i=>option(i.id,i.name)));const rows=editor.querySelector('#caseEditRows');const draw=()=>{rows.replaceChildren(...entry.items.map((slot,index)=>{const item=data.items.find(i=>i.id===slot.itemId);const row=document.createElement('div');row.className='case-content';row.innerHTML=`${item?artAdmin(item):''}<span>${safeAdmin(item?.name||slot.itemId)}</span><input aria-label="Вес выпадения" type="number" min="0.01" step="any" value="${slot.weight}"><button type="button" aria-label="Удалить из кейса">×</button>`;row.querySelector('input').oninput=e=>slot.weight=Number(e.target.value);row.querySelector('button').onclick=()=>{entry.items.splice(index,1);draw();};return row;}));};draw();editor.querySelector('#caseAdd').onclick=()=>{pickerTarget='caseAddItem';pickerInputs[0].value='';drawPicker();picker.showModal();};add.onchange=()=>{const iid=Number(add.value);if(!entry.items.some(s=>s.itemId===iid))entry.items.push({itemId:iid,weight:1});draw();};}
  editor.querySelector('form').onsubmit=async e=>{e.preventDefault();const fields=new FormData(e.target);entry.name=fields.get('name');entry.price=Number(fields.get('price'));entry.image=fields.get('image');if(!isCase)entry.rarity=fields.get('rarity');if(isCase&&(!entry.items.length||entry.items.some(s=>!Number.isFinite(s.weight)||s.weight<=0)))return notice('Добавь предметы и положительные веса',true);const b=e.submitter;b.disabled=true;try{await api('admin/catalog',data);$('catalog').value=JSON.stringify(data,null,2);await load(true);editor.close();notice('Каталог сохранён');}catch(error){notice(error.message,true);}finally{b.disabled=false;}};editor.showModal();
}
if(window.parent!==window)document.documentElement.classList.add('embedded');
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='bg-admin-open'&&adminCatalog.length)load(false).catch(e=>notice(e.message,true));});

window.addEventListener('admin:data',()=>{
  const data=window.adminSnapshot;if(!data)return;
  const status=$('rigStatus');status.className='rig-queue';status.replaceChildren();
  const names={case:'Кейсы',upgrade:'Апгрейдер',mystery:'Мистери',dice:'Дайсы',mines:'Мины'};
  const modes={win:'Победа',lose:'Проигрыш',bonus:'Бонус ×10',safe:'Алмаз',bomb:'Бомба'};
  for(const [game,result] of Object.entries(data.nextResults||{})){
    const card=document.createElement('span');card.className='queued-rig';
    card.innerHTML=(result.item?artAdmin(result.item):'')+'<span><b>'+safeAdmin(names[game])+'</b><small>'+safeAdmin(result.item?.name||modes[result.mode])+' · осталось '+(result.remaining??1)+'</small></span>';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='×';cancel.setAttribute('aria-label','Отменить Rig: '+names[game]);cancel.onclick=async()=>{cancel.disabled=true;try{await api('admin/next-result/cancel',{game});await load(false);}catch(e){notice(e.message,true);cancel.disabled=false;}};card.append(cancel);status.append(card);
  }
  if(!status.children.length)status.textContent='Нет заданных результатов';
  $('promos').replaceChildren(...data.promos.map(p=>{const row=document.createElement('span');row.className='promo-entry';row.innerHTML='<b>'+safeAdmin(p.code)+'</b><span>'+fmtAdmin(p.reward)+' BG</span><small>Осталось '+p.uses+'</small>';return row;}));
});
if(adminCatalog.length)window.dispatchEvent(new Event('admin:data'));

// The embedded panel uses the game's actual audio engine and current volume.
const adminFeedback=(()=>{
  if(window.parent!==window&&window.parent.BGAdminFeedback)return window.parent.BGAdminFeedback;
  const read=()=>{try{return JSON.parse(localStorage.getItem('bg_prefs')||'{}');}catch{return {};}};
  const audio=window.BGCreateAudio({get sound(){return read().sound!==false;},get volume(){const v=Number(read().volume??60);return Number.isFinite(v)?Math.max(0,Math.min(100,v)):60;}});
  window.addEventListener('storage',event=>{if(event.key==='bg_prefs')audio.setVolume();});
  return {unlock:()=>audio.unlock(),click:p=>audio.click(p),select:()=>audio.click(1.25),success:()=>audio.chime(.7),error:()=>audio.upLose()};
})();
document.addEventListener('pointerdown',()=>adminFeedback.unlock(),{capture:true});
document.addEventListener('click',event=>{
  const button=event.target.closest('button,a[href],summary,select');
  if(!button||button.disabled)return;
  adminFeedback.click(button.matches('.brain-card,.choice-strip button')?1.25:1);
  try{adminTG?.HapticFeedback?.selectionChanged();}catch{}
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&button.matches('button'))
    button.animate([{transform:'scale(.97)'},{transform:'scale(1)'}],{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'});
},{capture:true});
const motionOff=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
function enterAdmin(element,delay=0){if(!element||motionOff())return;element.animate([{opacity:0,translate:'0 10px'},{opacity:1,translate:'0 0'}],{duration:220,delay,easing:'cubic-bezier(.2,.8,.2,1)',fill:'backwards'});}
new MutationObserver(records=>{
  for(const record of records){
    const element=record.target;
    if(record.attributeName==='hidden'&&element.classList.contains('admin-panel')&&!element.hidden)
      [...element.children].forEach((section,index)=>enterAdmin(section,index*40));
    if(record.attributeName==='open'&&element.tagName==='DIALOG'&&element.open&&!motionOff())
      element.animate([{opacity:0,transform:'translateY(16px) scale(.97)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden','open']});
// Only animate newly displayed cards; sound is reserved for deliberate actions.
for(const gallery of [picker.querySelector('.item-gallery'),catalogGrid,$('liveRows')])
  new MutationObserver(records=>{const fresh=records.flatMap(r=>[...r.addedNodes]).filter(n=>n.nodeType===1);fresh.slice(0,24).forEach((card,index)=>enterAdmin(card,Math.min(index,8)*18));}).observe(gallery,{childList:true});
let noticeTimer=null;
window.addEventListener('admin:notice',event=>{
  const error=!!event.detail?.error;
  adminFeedback[error?'error':'success']();
  try{adminTG?.HapticFeedback?.notificationOccurred(error?'error':'success');}catch{}
  const toast=$('message');clearTimeout(noticeTimer);enterAdmin(toast);
  noticeTimer=setTimeout(()=>{toast.style.display='none';},error?6000:3600);
});
document.querySelectorAll('.admin-panel:not([hidden])>section').forEach((section,index)=>enterAdmin(section,index*40));

// Daily streak configuration uses the same visual item picker as Rig and grants.
const streakTab=document.createElement('button');streakTab.type='button';streakTab.textContent='Серия заходов';streakTab.dataset.panel='streak';nav.append(streakTab);
const streakPanel=document.createElement('div');streakPanel.id='panel-streak';streakPanel.className='admin-panel';streakPanel.hidden=true;host.append(streakPanel);
streakPanel.innerHTML=`<section><h2>Серия заходов</h2><p class="hint">Личные настройки. День меняется в 00:00 МСК. Награда доступна до конца дня. После последнего дня цикл повторяется.</p><form id="streakSettings"><label><input id="streakEnabled" type="checkbox"> Показывать серию и выдавать награды</label><label><input id="streakReset" type="checkbox"> Сбрасывать серию, если пропущен день</label><div id="streakSchedule"></div><button id="streakAddDay" type="button" class="secondary">Добавить день</button><button type="submit">Сохранить настройки серии</button><button type="button" class="secondary" id="streakDefault">Вернуть стандартные 30 дней</button></form></section><section><h2>Мой прогресс</h2><p id="streakProgressLabel">Загрузка…</p><form id="streakProgressForm"><label>Дней подряд<input id="streakProgressCount" type="number" min="0" max="10000" value="0" required></label><p class="hint">0 — начать заново при следующем входе. Другое число — отметить сегодняшний день без выдачи награды. Несобранные награды будут удалены, рекорд сохранится.</p><button type="submit">Применить прогресс</button></form></section><select hidden id="streakItemChoice"></select><select hidden id="streakCaseChoice"></select>`;
let streakDraft=null,streakDirty=false;
async function loadStreak(){const d=await api('admin/streak');streakDraft=d.config;streakDirty=false;$('streakEnabled').checked=streakDraft.enabled;$('streakReset').checked=streakDraft.resetOnMiss;$('streakProgressCount').value=d.progress.count;$('streakProgressLabel').textContent=d.progress.count+' дней подряд · рекорд '+d.progress.best;drawStreakSchedule();}
streakTab.onclick=()=>{for(const b of nav.children)b.setAttribute('aria-pressed',String(b===streakTab));for(const panel of host.children)panel.hidden=panel!==streakPanel;sessionStorage.setItem('bg_admin_tab','streak');if(!streakDraft||!streakDirty)loadStreak().catch(e=>notice(e.message,true));};
function drawStreakSchedule(){if(!streakDraft)return;const cases=catalogDraft().cases;const container=$('streakSchedule');container.replaceChildren(...streakDraft.rewards.map((reward,index)=>{
  const row=document.createElement('div');row.className='streak-edit-day';const title=document.createElement('b');title.textContent='День '+(index+1);row.append(title);
  const types=document.createElement('div');types.className='choice-strip';for(const [kind,name] of [['coins','BG'],['item','Брейнрот'],['case','Кейс']]){const b=document.createElement('button');b.type='button';b.textContent=name;b.setAttribute('aria-pressed',String(reward.kind===kind));b.onclick=()=>{streakDraft.rewards[index]=kind==='coins'?{kind,amount:100}:kind==='item'?{kind,itemId:adminCatalog.find(i=>!i.customSession)?.id}:{kind,caseId:cases[0]?.id};streakDirty=true;drawStreakSchedule();};types.append(b);}row.append(types);
  if(reward.kind==='coins'){const amount=document.createElement('input');amount.type='number';amount.min='1';amount.max='1000000000';amount.step='.01';amount.value=reward.amount;amount.setAttribute('aria-label','Награда BG за день '+(index+1));amount.oninput=()=>{reward.amount=Number(amount.value);streakDirty=true;};row.append(amount);}else{
    const isCase=reward.kind==='case',items=isCase?cases:adminCatalog.filter(i=>!i.customSession),id=isCase?'streakCaseChoice':'streakItemChoice',current=items.find(i=>i.id===(isCase?reward.caseId:reward.itemId));
    const button=document.createElement('button');button.type='button';button.className='visual-picker';button.innerHTML=current?`${artAdmin(current)}<span><b>${safeAdmin(current.name)}</b>${valueAdmin(current)}</span><span class="choose-label">Выбрать →</span>`:'Выбрать награду';button.onclick=()=>{const select=$(id);select.replaceChildren(...items.map(i=>option(i.id,i.name)));select.value=current?.id||'';select.onchange=()=>{if(isCase)reward.caseId=Number(select.value);else reward.itemId=Number(select.value);streakDirty=true;drawStreakSchedule();};pickerTarget=id;pickerInputs[0].value='';pickerInputs[1].value='';drawPicker();picker.showModal();};row.append(button);
  }
  const actions=document.createElement('div');actions.className='quick-buttons';for(const [text,fn] of [['↑',()=>{if(index)[streakDraft.rewards[index-1],streakDraft.rewards[index]]=[reward,streakDraft.rewards[index-1]];}],['Удалить',()=>{if(streakDraft.rewards.length>1)streakDraft.rewards.splice(index,1);}]]){const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=text;b.onclick=()=>{fn();streakDirty=true;drawStreakSchedule();};actions.append(b);}row.append(actions);return row;}));}
$('streakAddDay').onclick=()=>{if(!streakDraft)return;if(streakDraft.rewards.length>=60)return notice('Максимум 60 дней в цикле',true);streakDraft.rewards.push({kind:'coins',amount:100});streakDirty=true;drawStreakSchedule();};
const notifyStreak=()=>{if(window.parent!==window)window.parent.postMessage({type:'bg-admin-streak'},location.origin);};
bind('streakSettings',async()=>{if(!streakDraft)throw new Error('Дождись загрузки');await api('admin/streak',{...streakDraft,enabled:$('streakEnabled').checked,resetOnMiss:$('streakReset').checked});await loadStreak();notifyStreak();});
bind('streakProgressForm',async()=>{await api('admin/streak/progress',{count:Number($('streakProgressCount').value)});await loadStreak();notifyStreak();});
if(initial==='streak')streakTab.click();

for(const id of ['streakEnabled','streakReset'])$(id).onchange=()=>{streakDirty=true;};

runAction('streakDefault',async()=>{await api('admin/streak/reset',{});await loadStreak();notifyStreak();notice('Восстановлены стандартные 30 дней');});
