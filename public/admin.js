// Configure Telegram chrome on this page as well as the game frontend.
const adminTG=window.Telegram?.WebApp;
function setAdminTelegramColors(){
  for(const method of ['setHeaderColor','setBackgroundColor','setBottomBarColor']){
    try{adminTG?.[method]?.('#0c1110');}catch{}
  }
}
try{adminTG?.ready();adminTG?.expand();adminTG?.onEvent?.('themeChanged',setAdminTelegramColors);}catch{}
setAdminTelegramColors();
const $=id=>document.getElementById(id);
function notice(text,error=false){$('message').style.display='block';$('message').style.background=error?'#632f2f':'#24372b';$('message').textContent=text;}
async function api(path,body){const headers={'X-Play-Session':window.playSession};const init=window.Telegram?.WebApp?.initData;if(init)headers.authorization='tma '+init;if(body)headers['Content-Type']='application/json';const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify({...body,key:crypto.randomUUID()}):undefined});const d=await r.json();if(!r.ok)throw new Error(d.message||'Ошибка');return d;}
function option(value,text){const o=document.createElement('option');o.value=value;o.textContent=text;return o;}
async function load(catalog=true){const d=await api('admin/state'+(catalog?'':'?catalog=0'));if(catalog)$('balance').value=d.me.balance;
if(catalog){$('catalog').value=JSON.stringify(d.catalog,null,2);const ordered=[...d.catalog.items].sort((a,b)=>a.price-b.price||a.id-b.id);$('item').replaceChildren(...ordered.map(i=>option(i.id,i.name+' · '+i.price+' BG')));$('rigItem').replaceChildren(...ordered.map(i=>option(i.id,i.name+' · '+i.price+' BG')));}
const names={case:'Кейсы',upgrade:'Апгрейдер',mystery:'Мистери',dice:'Колор Дайс',mines:'Мины'};const modes={win:'победа',lose:'проигрыш',bonus:'бонус ×10',safe:'следующий клик — алмаз',bomb:'следующий клик — бомба'};$('rigStatus').textContent=Object.entries(d.nextResults||{}).map(([game,r])=>names[game]+': '+(r.item?r.item.name:modes[r.mode])+(game==='dice'&&['item','win'].includes(r.mode)?' · '+r.hits+' из 4':'')).join(' | ')||'Следующие результаты не заданы';
$('promos').textContent=d.promos.map(p=>p.code+': '+p.reward+' BG, осталось '+p.uses).join(' | ');}
function bind(form,action){$(form).onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;try{await action();notice('Сохранено');await load(false);}catch(err){notice(err.message,true);}finally{b.disabled=false;}};}
let previewUrl=null;
$('customImage').onchange=()=>{if(previewUrl)URL.revokeObjectURL(previewUrl);const file=$('customImage').files[0];$('customPreview').hidden=!file;if(file){previewUrl=URL.createObjectURL(file);$('customPreview').src=previewUrl;}};
const imageData=file=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Не удалось прочитать картинку'));r.readAsDataURL(file);});
bind('customForm',async()=>{const file=$('customImage').files[0];if(!file||file.size>1024*1024)throw new Error('Выбери картинку размером до 1 МБ');await api('admin/custom-item',{name:$('customName').value,price:Number($('customPrice').value),rarity:$('customRarity').value,imageData:await imageData(file)});$('customForm').reset();$('customPreview').hidden=true;if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}await load(true);});
bind('balanceForm',()=>api('admin/balance',{balance:Number($('balance').value)}));
bind('grantForm',()=>api('admin/grant',{itemId:Number($('item').value),qty:Number($('qty').value)}));
bind('catalogForm',async()=>{await api('admin/catalog',JSON.parse($('catalog').value));await load(true);});
bind('giveawayForm',()=>api('admin/giveaway-progress',{amount:Number($('giveawayAmount').value)}));
bind('promoForm',()=>api('admin/promo',{code:$('code').value,reward:Number($('reward').value),uses:Number($('uses').value)}));
function updateRigFields(){const game=$('rigGame').value;const allowed={case:['item'],mystery:['item'],upgrade:['item','win','lose'],dice:['item','win','lose','bonus'],mines:['safe','bomb']}[game];for(const o of $('rigMode').options)o.disabled=!allowed.includes(o.value);if(!allowed.includes($('rigMode').value))$('rigMode').value=allowed[0];$('rigItemField').hidden=$('rigMode').value!=='item';$('rigHitsField').hidden=game!=='dice'||['lose','bonus'].includes($('rigMode').value);}
$('rigGame').onchange=updateRigFields;$('rigMode').onchange=updateRigFields;updateRigFields();
bind('rigForm',()=>api('admin/next-result',{game:$('rigGame').value,mode:$('rigMode').value,itemId:Number($('rigItem').value),hits:Number($('rigHits').value)}));
$('rigCancel').onclick=async()=>{try{await api('admin/next-result/cancel',{game:$('rigGame').value});await load(false);notice('Отменено');}catch(e){notice(e.message,true);}};
$('importFile').onchange=async e=>{try{$('catalog').value=JSON.stringify(JSON.parse(await e.target.files[0].text()),null,2);notice('Файл загружен. Нажми «Сохранить каталог».');}catch(err){notice(err.message,true);}};
$('resetCatalog').onclick=async()=>{try{await api('admin/catalog/reset',{});await load();notice('Личные правки сброшены');}catch(e){notice(e.message,true);}};
window.sandboxReady.then(()=>load()).catch(e=>notice(e.message,true));
