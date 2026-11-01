"""Public sandbox backend for the saved Brainrot Grader client. No real payments."""
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl

from flask import Flask, g, jsonify, redirect, request, send_from_directory

ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024
DB_PATH = Path(os.getenv('DATABASE_PATH', str(ROOT / 'data' / 'brainrot.db')))
RNG = secrets.SystemRandom()


class Problem(Exception):
    def __init__(self, message, code='invalid_request', status=400):
        self.message, self.code, self.status = message, code, status


@app.errorhandler(Problem)
def problem(e):
    return jsonify(error=e.code, message=e.message), e.status


def number(v, minimum=0, maximum=1_000_000_000):
    if isinstance(v, bool):
        raise Problem('Нужно число')
    try:
        n = float(v)
    except (ValueError, TypeError):
        raise Problem('Нужно число')
    if not math.isfinite(n) or not minimum <= n <= maximum:
        raise Problem('Число вне допустимого диапазона')
    return round(n, 2)


def integer(v, minimum=1, maximum=1_000_000_000):
    n = number(v, minimum, maximum)
    if n != int(n):
        raise Problem('Нужно целое число')
    return int(n)


def db():
    if 'db' not in g:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        g.db = sqlite3.connect(DB_PATH, timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys=ON')
    return g.db


@app.teardown_appcontext
def close_db(_):
    c = g.pop('db', None)
    if c:
        c.close()


def iso(t=None):
    return datetime.fromtimestamp(t or time.time(), timezone.utc).isoformat()


def init_db():
    with app.app_context():
        c = db()
        c.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL,
          balance REAL NOT NULL DEFAULT 10000 CHECK(balance>=0), testBalance REAL NOT NULL DEFAULT 100000,
          cases INTEGER NOT NULL DEFAULT 0, upgrades INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_catalogs(user_id TEXT PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS next_results(user_id TEXT NOT NULL REFERENCES users(id), game TEXT NOT NULL,
          value TEXT NOT NULL, PRIMARY KEY(user_id,game));
        CREATE TABLE IF NOT EXISTS inventory(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          item TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'owned', test INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL,
          body TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,key));
        CREATE TABLE IF NOT EXISTS cooldown(user_id TEXT NOT NULL, case_id INTEGER NOT NULL, until REAL NOT NULL,
          PRIMARY KEY(user_id,case_id));
        CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, user_id TEXT, kind TEXT, payload TEXT, created REAL);
        CREATE TABLE IF NOT EXISTS live_drops(inventory_id INTEGER PRIMARY KEY REFERENCES inventory(id),
          item TEXT NOT NULL, source TEXT NOT NULL, price REAL NOT NULL, created REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS live_drops_created ON live_drops(created DESC, inventory_id DESC);
        CREATE TABLE IF NOT EXISTS promos(code TEXT PRIMARY KEY, reward REAL NOT NULL, uses INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS claims(user_id TEXT, code TEXT, PRIMARY KEY(user_id,code));
        ''')
        if not c.execute("SELECT 1 FROM settings WHERE key='catalog'").fetchone():
            # Do not invent the original site's catalogue. Import its exported JSON instead.
            c.execute('INSERT INTO settings VALUES (?,?)', ('catalog', json.dumps(dict(items=[],cases=[]))))
        # Preserve previous wins in the feed when upgrading an existing deployment.
        previous = c.execute('''SELECT i.* FROM inventory i
          WHERE i.test=0 AND i.source IN ('case','upgrade','mystery','dice')
          AND NOT EXISTS(SELECT 1 FROM live_drops d WHERE d.inventory_id=i.id)''').fetchall()
        for row in previous:
            item = json.loads(row['item'])
            c.execute('INSERT INTO live_drops VALUES (?,?,?,?,?)',
                      (row['id'],row['item'],json.dumps(dict(kind=row['source'])),item['price'],row['created']))
        c.commit()


def catalog():
    personal = db().execute('SELECT value FROM user_catalogs WHERE user_id=?', (g.uid,)).fetchone()
    if personal:
        return json.loads(personal[0])
    source = ROOT / 'source_catalog.json'
    if source.exists():
        data = json.loads(source.read_text(encoding='utf-8-sig'))
        validate_catalog(data)
        return data
    return json.loads(db().execute("SELECT value FROM settings WHERE key='catalog'").fetchone()[0])


def user():
    return db().execute('SELECT * FROM users WHERE id=?', (g.uid,)).fetchone()


def me():
    u = dict(user())
    return dict(id=u['id'], firstName=u['name'], username=getattr(g,'username',''),
                photoUrl=getattr(g,'photo_url',None), balance=u['balance'], testBalance=u['testBalance'],
                isAdmin=True, isTester=True, isPartner=False, siteMode='open',
                stats=dict(cases=u['cases'], upgrades=u['upgrades'], withdrawn=0))


@app.before_request
def identify():
    if not request.path.startswith('/api/'):
        return
    # Only these test-only identities are accepted; Telegram identities require a valid signature.
    auth = request.headers.get('Authorization', '')
    g.photo_url = None
    g.username = ''
    g.uid, name = 'guest:' + request.cookies.get('sandbox_id', secrets.token_hex(16)), 'Игрок'
    if auth.startswith('tma '):
        token = os.getenv('BOT_TOKEN', '')
        if not token:
            raise Problem('Для входа через Telegram задайте BOT_TOKEN', 'auth_required', 401)
        pairs = parse_qsl(auth[4:], keep_blank_values=True)
        data = dict(pairs)
        if len(pairs) != len(data):
            raise Problem('Некорректная авторизация', 'auth_required', 401)
        received = data.pop('hash', '')
        check = '\n'.join(f'{k}={v}' for k,v in sorted(data.items()))
        secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        try:
            age = time.time() - int(data.get('auth_date', 0))
            info = json.loads(data.get('user', '{}'))
            uid = integer(info['id'], 1, 10**16)
        except (ValueError, KeyError, TypeError, Problem):
            raise Problem('Некорректная авторизация', 'auth_required', 401)
        if not hmac.compare_digest(expected, received) or not -60 <= age <= 86400:
            raise Problem('Сессия Telegram истекла или подпись неверна', 'auth_required', 401)
        g.uid, name = 'tg:' + str(uid), str(info.get('first_name', 'Игрок'))[:80]
        photo = info.get('photo_url')
        if isinstance(photo, str) and photo.startswith('https://'):
            g.photo_url = photo
        g.username = str(info.get('username', ''))[:80]
    c = db()
    c.execute('INSERT OR IGNORE INTO users(id,name) VALUES (?,?)', (g.uid,name))
    c.commit()


@app.after_request
def cookie(response):
    if hasattr(g,'uid') and g.uid.startswith('guest:'):
        response.set_cookie('sandbox_id', g.uid[6:], httponly=True, samesite='Lax',
                            secure=request.headers.get('X-Forwarded-Proto',request.scheme)=='https', max_age=31536000)
    if request.path.startswith('/api/'):
        response.headers['Cache-Control']='no-store'
    response.headers['X-Content-Type-Options']='nosniff'
    return response


def inventory(owned=False):
    rows = db().execute("SELECT * FROM inventory WHERE user_id=? AND status='owned' ORDER BY id DESC LIMIT 2000", (g.uid,))
    return [dict(id=r['id'], item=json.loads(r['item']), status=r['status'], test=bool(r['test']),
                 source=r['source'], createdAt=iso(r['created']), withdrawable=False) for r in rows
            if not owned or r['status']=='owned']


def add_item(item, source, test=False, uid=None):
    details = source if isinstance(source, dict) else dict(kind=source)
    kind = details['kind']
    created = time.time()
    iid = db().execute('INSERT INTO inventory(user_id,item,test,source,created) VALUES (?,?,?,?,?)',
                       (uid or g.uid,json.dumps(item),int(test),kind,created)).lastrowid
    if not test and kind in ('case','upgrade','mystery','dice'):
        db().execute('INSERT INTO live_drops VALUES (?,?,?,?,?)',
                     (iid,json.dumps(item),json.dumps(details),item['price'],created))
    return iid


def home():
    def drop(row):
        if row is None:
            return None
        return dict(json.loads(row['item']),id=row['inventory_id'],
                    source=json.loads(row['source']),createdAt=iso(row['created']))
    # Calendar day in Moscow, matching the user-facing timezone.
    start_of_day = math.floor((time.time()+10800)/86400)*86400-10800
    recent = db().execute('SELECT * FROM live_drops ORDER BY created DESC,inventory_id DESC LIMIT 30').fetchall()
    top = db().execute('SELECT * FROM live_drops WHERE created>=? ORDER BY price DESC,created DESC LIMIT 1',
                       (start_of_day,)).fetchone()
    return dict(top=drop(top),drops=[drop(row) for row in recent],bonus=None)


def selected(body, allow_test=False):
    ids = body.get('ids', [body['id']] if 'id' in body else [])
    if not isinstance(ids,list) or not 1 <= len(ids) <= 100:
        raise Problem('Выбери от 1 до 100 предметов')
    ids = [integer(i) for i in ids]
    if len(set(ids)) != len(ids):
        raise Problem('Предметы не должны повторяться')
    items = {i['id']:i for i in inventory(True)}
    if any(i not in items or (items[i]['test'] and not allow_test) for i in ids):
        raise Problem('Предмет недоступен', 'item_unavailable')
    return [items[i] for i in ids]


def consume(items, status):
    db().executemany('UPDATE inventory SET status=? WHERE id=? AND user_id=?',
                     [(status,i['id'],g.uid) for i in items])


def find_item(i):
    return next((x for x in catalog()['items'] if x['id']==integer(i)), None)


def case(i):
    cat = catalog()
    cs = next((x for x in cat['cases'] if x['id']==integer(i)), None)
    if not cs:
        raise Problem('Кейс не найден', 'not_found',404)
    pool = {x['id']:x for x in cat['items']}
    return dict(cs, items=[dict(pool[x['itemId']],weight=x['weight']) for x in cs['items']], itemsCount=len(cs['items']))


def config():
    return dict(build='',theme='halloween',caseAnim='classic',sandbox=True,depositEnabled=False,withdrawEnabled=False,
                starsRate=1,starsMin=1,starsMax=10000,refBonusPercent=0,withdrawMin=1,withdrawWindow='отключён',
                upgrade=dict(maxItems=5,minChance=1,maxChance=90,presets=[dict(label=f'×{n}',mult=n) for n in [1.25,2,3,5,10]]),
                mystery=dict(enabled=True,mult=3,minInput=1,maxInput=1e9,floor=1,cap=1e9),
                dice=dict(enabled=True,min=1,max=100000,maxItems=5,colors=[dict(name=n,hex=h) for n,h in
                    zip(['Красный','Оранжевый','Жёлтый','Зелёный','Синий','Фиолетовый'],
                        ['#ef4444','#f97316','#facc15','#22c55e','#3b82f6','#a855f7'])],
                    table=[dict(hits=h,mult=m) for h,m in [(1,0),(2,2),(3,5),(4,20)]]))


def targets(body):
    rows=selected(body)
    if len(rows)>5:
        raise Problem('Можно поставить до 5 предметов')
    value=sum(i['item']['price'] for i in rows)
    options=[dict(x,chance=round(value/x['price']*90,2)) for x in catalog()['items'] if 1<=value/x['price']*90<=90]
    options.sort(key=lambda x: (x['price'], x['id']))
    presets=[]
    for n in [1.25,2,3,5,10]:
        target=min(options,key=lambda x:abs(x['price']-value*n)) if options else None
        presets.append(dict(label=f'×{n}',target=target,chance=target['chance'] if target else 0))
    return dict(inputValue=value,targets=options,presets=presets)


def take_next_result(game):
    row = db().execute('SELECT value FROM next_results WHERE user_id=? AND game=?', (g.uid,game)).fetchone()
    if not row:
        return None
    db().execute('DELETE FROM next_results WHERE user_id=? AND game=?', (g.uid,game))
    return json.loads(row[0])


def dispatch(path, body):
    c=db()
    parts=path.split('/')
    post=request.method=='POST'
    # All payment and withdrawal mutations are rejected, including unknown nested routes.
    if path.startswith('deposit') or (path.startswith('withdraw') and post):
        raise Problem('Пополнение и вывод отключены. Баланс можно изменить в общей админке.', 'payments_disabled',403)
    if path=='me': return me()
    if path=='config': return config()
    if path in ('ping','diag'): return dict(ok=True)
    if path=='avatar': raise Problem('Нет аватара','not_found',404)
    if path=='inventory' and not post: return inventory()
    if path=='withdraw' and not post: return dict(requests=[],enabled=False)
    if path=='cases' and not post: return [case(x['id']) for x in catalog()['cases']]
    if path.startswith('cases/') and len(parts)==2 and not post: return case(parts[1])
    if path.startswith('cases/') and path.endswith('/free') and not post:
        cs=case(parts[1]); r=c.execute('SELECT until FROM cooldown WHERE user_id=? AND case_id=?',(g.uid,cs['id'])).fetchone()
        return dict(ok=not r or r[0]<=time.time(),nextAt=iso(r[0]) if r and r[0]>time.time() else None,hours=24)
    if post and ((path.startswith('cases/') and path.endswith('/open')) or path.startswith('test/open/')):
        test=path.startswith('test/')
        cs=case(parts[2] if test else parts[1]); n=integer(body.get('count',1),1,5)
        if n not in [1,3,5]: raise Problem('Количество: 1, 3 или 5')
        if body.get('promo'): raise Problem('Промокоды открытия не настроены')
        if cs.get('freeKind') and not test:
            n=1
            r=c.execute('SELECT until FROM cooldown WHERE user_id=? AND case_id=?',(g.uid,cs['id'])).fetchone()
            if r and r[0]>time.time(): raise Problem('Бесплатный кейс доступен раз в сутки')
            c.execute('INSERT OR REPLACE INTO cooldown VALUES (?,?,?)',(g.uid,cs['id'],time.time()+86400))
        field='testBalance' if test else 'balance'; cost=cs['price']*n
        if user()[field]<cost: raise Problem('Недостаточно BG. Добавь баланс в админке.', 'insufficient_balance')
        c.execute(f'UPDATE users SET {field}={field}-?, cases=cases+? WHERE id=?',(cost,0 if test else n,g.uid))
        rig = None if test else take_next_result('case')
        drops=[]
        for index in range(n):
            item=dict(rig['item']) if rig and index==0 else dict(RNG.choices(cs['items'],weights=[x['weight'] for x in cs['items']])[0])
            item.pop('weight',None)
            iid=add_item(item,dict(kind='case',caseId=cs['id'],caseName=cs['name'],caseImage=cs['image']),test)
            drops.append(dict(item=item,inventoryId=iid))
        return dict(drops=drops,balance=user()['balance'],testBalance=user()['testBalance'],test=test)
    if post and path in ('inventory/sell','inventory/sell-all','test/sell'):
        test=path=='test/sell'
        rows=[i for i in inventory(True) if i['test']==test] if path.endswith('sell-all') or (test and not body.get('ids')) else selected(body,True)
        if any(i['test']!=test for i in rows): raise Problem('Тестовые предметы продаются отдельно')
        total=sum(i['item']['price'] for i in rows); consume(rows,'sold')
        field='testBalance' if test else 'balance'
        c.execute(f'UPDATE users SET {field}={field}+? WHERE id=?',(total,g.uid))
        return dict(total=total,balance=user()['balance'],testBalance=user()['testBalance'],test=test)
    if path=='shop' and not post: return dict(enabled=True,items=sorted(catalog()['items'],key=lambda x:(x['price'],x['id'])))
    if path=='shop/buy' and post:
        it=find_item(body.get('itemId'))
        if not it: raise Problem('Предмет не найден')
        if user()['balance']<it['price']: raise Problem('Недостаточно BG')
        c.execute('UPDATE users SET balance=balance-? WHERE id=?',(it['price'],g.uid))
        return dict(inventoryId=add_item(it,'shop'),balance=user()['balance'])
    if path=='upgrade/targets' and post: return targets(body)
    if path=='upgrade' and post:
        options=targets(body); target=next((x for x in options['targets'] if x['id']==integer(body.get('targetId'))),None)
        if not target: raise Problem('Недопустимая цель')
        rows=selected(body)
        rig=take_next_result('upgrade')
        if rig and rig.get('item'):
            target=dict(rig['item'],chance=target['chance'])
        chance=target['chance']
        roll=RNG.random()*100
        if rig:
            roll=chance/2 if rig['mode']!='lose' else chance+(100-chance)/2
        won=roll<chance
        consume(rows,'upgraded')
        c.execute('UPDATE users SET upgrades=upgrades+1 WHERE id=?',(g.uid,))
        return dict(won=won,chance=target['chance'],roll=roll,target=target,inventoryIds=[add_item(target,'upgrade')] if won else [])
    if path in ('mystery/info','mystery') and post:
        row=selected(body)[0]; value=row['item']['price']; pool=[x for x in catalog()['items'] if value/3<=x['price']<=value*3]
        if path.endswith('info'): return dict(ok=bool(pool),min=value/3,max=value*3,items=pool,reason='Нет подходящих предметов')
        if not pool: raise Problem('Нет подходящих предметов')
        rig=take_next_result('mystery')
        it=rig['item'] if rig else RNG.choice(pool)
        consume([row],'mystery')
        return dict(item=it,inventoryId=add_item(it,'mystery'),shuffle=[x['image'] for x in pool]+[it['image']],balance=user()['balance'])
    if path=='dice/my' and not post:
        return [json.loads(r[0]) for r in c.execute("SELECT payload FROM history WHERE user_id=? AND kind='dice' ORDER BY id DESC LIMIT 20",(g.uid,))]
    if path=='dice' and post:
        rows=selected(body); color=integer(body.get('color'),0,5); value=sum(i['item']['price'] for i in rows)
        if len(rows)>5 or value>100000: raise Problem('Ставка: до 5 предметов и до 100000 BG')
        rig=take_next_result('dice')
        dice=[RNG.randrange(6) for _ in range(4)]
        if rig:
            hits=rig['hits']
            dice=[color]*hits+[RNG.choice([n for n in range(6) if n!=color]) for _ in range(4-hits)]
            RNG.shuffle(dice)
        hits=dice.count(color); mult={0:0,1:0,2:2,3:5,4:20}[hits]
        won=[]
        winnings=0
        if not mult: consume(rows,'dice')
        else:
            for row in rows:
                prize=rig['item'] if rig and rig.get('item') else row['item']
                won.extend(add_item(prize,'dice') for _ in range(mult-1))
                winnings+=prize['price']*(mult-1)
        return dict(dice=dice,color=color,hits=hits,mult=mult,rainbow=False,wonIds=won,net=winnings if mult else -value)
    if path=='home': return home()
    if path=='giveaways' and not post: return dict(now=iso(),active=[],finished=[])
    if path=='streak/checkin' and post: return dict(enabled=False,count=0,pending=[],fresh=False)
    if path=='referrals' and not post:
        return dict(code='SANDBOX',link='',bonusPercent=0,percent=0,preliminary=0,refBalance=0,count=0,earned=0,
                    referrals=[],history=[],nextPayoutAt=iso(time.time()+604800),tz='Europe/Moscow',tzLabel='МСК',isPartner=False)
    if path=='promo' and post:
        code=str(body.get('code','')).upper().strip(); r=c.execute('SELECT * FROM promos WHERE code=?',(code,)).fetchone()
        if not r or r['uses']<1: raise Problem('Промокод не найден или закончился')
        if c.execute('SELECT 1 FROM claims WHERE user_id=? AND code=?',(g.uid,code)).fetchone(): raise Problem('Код уже использован')
        c.execute('INSERT INTO claims VALUES (?,?)',(g.uid,code)); c.execute('UPDATE promos SET uses=uses-1 WHERE code=?',(code,))
        c.execute('UPDATE users SET balance=balance+? WHERE id=?',(r['reward'],g.uid))
        return dict(type='coins',kind='coins',reward=r['reward'],balance=user()['balance'])
    if path=='admin/state' and not post:
        return dict(me=me(),users=[dict(r) for r in c.execute('SELECT * FROM users ORDER BY rowid DESC LIMIT 500')],
                    catalog=catalog(),promos=[dict(r) for r in c.execute('SELECT * FROM promos')],
                    nextResults={r['game']:json.loads(r['value']) for r in c.execute('SELECT game,value FROM next_results WHERE user_id=?',(g.uid,))},
                    history=[dict(r) for r in c.execute('SELECT id,user_id,kind,created FROM history ORDER BY id DESC LIMIT 50')])
    if path in ('admin/next-result','admin/next-result/cancel') and post:
        game=body.get('game')
        if game not in ('case','upgrade','mystery','dice'):
            raise Problem('Выбери игру')
        if path.endswith('/cancel'):
            c.execute('DELETE FROM next_results WHERE user_id=? AND game=?',(g.uid,game))
            return dict(ok=True)
        mode=body.get('mode','item')
        if mode not in ('item','win','lose') or (game in ('case','mystery') and mode!='item'):
            raise Problem('Для кейса и мистери выбери конкретный предмет')
        item=None
        if mode=='item':
            item=find_item(body.get('itemId'))
            if not item:
                raise Problem('Предмет не найден')
        value=dict(mode=mode,item=item)
        if game=='dice':
            value['hits']=0 if mode=='lose' else integer(body.get('hits',2),2,4)
        c.execute('INSERT OR REPLACE INTO next_results VALUES (?,?,?)',(g.uid,game,json.dumps(value)))
        return dict(ok=True)
    if path=='admin/balance' and post:
        uid=str(body.get('userId',g.uid)); amount=number(body.get('balance'))
        if not c.execute('UPDATE users SET balance=? WHERE id=?',(amount,uid)).rowcount: raise Problem('Игрок не найден')
        return dict(ok=True,balance=amount)
    if path=='admin/grant' and post:
        it=find_item(body.get('itemId')); uid=str(body.get('userId',g.uid)); qty=integer(body.get('qty',1),1,100)
        if not it or not c.execute('SELECT 1 FROM users WHERE id=?',(uid,)).fetchone(): raise Problem('Игрок или предмет не найден')
        return dict(ok=True,ids=[add_item(it,'admin',uid=uid) for _ in range(qty)])
    if path=='admin/catalog' and post:
        body = {k:v for k,v in body.items() if k!='key'}
        validate_catalog(body)
        c.execute('INSERT OR REPLACE INTO user_catalogs VALUES (?,?)',(g.uid,json.dumps(body)))
        return dict(ok=True)
    if path=='admin/catalog/reset' and post:
        c.execute('DELETE FROM user_catalogs WHERE user_id=?',(g.uid,))
        return dict(ok=True)
    if path=='admin/promo' and post:
        code=str(body.get('code','')).upper().strip()
        if not 3<=len(code)<=20 or not code.isascii() or not code.replace('_','').isalnum(): raise Problem('Код: 3–20 букв, цифр или _')
        if c.execute('SELECT 1 FROM promos WHERE code=?',(code,)).fetchone(): raise Problem('Такой код уже существует')
        c.execute('INSERT INTO promos VALUES (?,?,?)',(code,number(body.get('reward'),1),integer(body.get('uses'),1,10000)))
        return dict(ok=True)
    raise Problem('Раздел недоступен', 'not_available',404)


def validate_catalog(cat):
    if set(cat) != {'items','cases'} or not isinstance(cat['items'],list) or not isinstance(cat['cases'],list):
        raise Problem('Нужны массивы items и cases')
    if not 0<=len(cat['items'])<=5000 or not 0<=len(cat['cases'])<=500: raise Problem('Недопустимый размер каталога')
    ids=set()
    for it in cat['items']:
        iid=integer(it.get('id'))
        if iid in ids: raise Problem('ID предметов повторяются')
        ids.add(iid); it['price']=number(it.get('price'),0.01)
        if it.get('rarity') not in ['common','rare','epic','legendary','og']: raise Problem('Неизвестная редкость')
        for key in ['name','image']:
            if not isinstance(it.get(key),str) or not 1<=len(it[key])<=500: raise Problem('Проверь название и картинку')
        validate_image(it['image'])
    seen=set()
    for cs in cat['cases']:
        cid=integer(cs.get('id'))
        if cid in seen: raise Problem('ID кейсов повторяются')
        seen.add(cid); cs['price']=number(cs.get('price'))
        if not isinstance(cs.get('name'),str) or not 1<=len(cs['name'])<=100: raise Problem('Нужно название кейса')
        validate_image(cs.get('image',''))
        if cs.get('category','standard') not in ['free','start','standard','platina','allin']: raise Problem('Неизвестная категория')
        if cs.get('freeKind') not in [None,'daily']: raise Problem('freeKind: null или daily')
        if not isinstance(cs.get('items'),list) or not 1<=len(cs['items'])<=500: raise Problem('Нужны предметы кейса')
        item_ids=set()
        for entry in cs['items']:
            iid=integer(entry.get('itemId'))
            if iid not in ids or iid in item_ids: raise Problem('Неверный или повторяющийся предмет кейса')
            item_ids.add(iid); entry['weight']=number(entry.get('weight'),0.01,1000000)


def validate_image(value):
    if not isinstance(value,str) or not (value.startswith('/img/') or value.startswith('https://brainrotgrader.com/img/')):
        raise Problem('Картинка: /img/... или https://brainrotgrader.com/img/...')


@app.route('/api/<path:path>',methods=['GET','POST'])
def api(path):
    body=request.get_json(silent=True) if request.method=='POST' else {}
    if not isinstance(body,dict): raise Problem('Нужен JSON-объект')
    c=db()
    try:
        c.execute('BEGIN IMMEDIATE' if request.method=='POST' else 'BEGIN')
        key=body.get('key'); fingerprint=json.dumps(body,sort_keys=True,separators=(',',':'))
        if key is not None:
            if not isinstance(key,str) or not 1<=len(key)<=100: raise Problem('Неверный ключ операции')
            prev=c.execute('SELECT * FROM operations WHERE user_id=? AND key=?',(g.uid,key)).fetchone()
            if prev:
                if prev['path']!=path or prev['body']!=fingerprint: raise Problem('Ключ уже занят другой операцией','key_conflict',409)
                c.commit(); return jsonify(json.loads(prev['response']))
        result=dispatch(path,body)
        if request.method=='POST':
            c.execute('INSERT INTO history(user_id,kind,payload,created) VALUES (?,?,?,?)',(g.uid,path,json.dumps(result),time.time()))
            if key: c.execute('INSERT INTO operations VALUES (?,?,?,?,?)',(g.uid,key,path,fingerprint,json.dumps(result)))
        c.commit()
        return jsonify(result)
    except Exception:
        c.rollback()
        raise


@app.get('/health')
def health():
    db().execute('SELECT 1').fetchone()
    return jsonify(ok=True,payments=False,publicAdmin=True)


@app.get('/img/<path:name>')
def image(name):
    if name in ['logo.svg','coin.webp']:
        return send_from_directory(ROOT/'public'/'img',name)
    if '..' in name or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-.' for ch in name):
        raise Problem('Неверный путь',status=404)
    return redirect('https://brainrotgrader.com/img/'+name,302)


@app.get('/fonts/<path:name>')
def font(name):
    if name not in ['golos.woff','pixelify.woff','bg-digits.woff']: raise Problem('Шрифт не найден',status=404)
    return redirect('https://brainrotgrader.com/fonts/'+name,302)


@app.get('/')
def index(): return send_from_directory(ROOT/'public','index.html')


@app.get('/admin')
def admin(): return send_from_directory(ROOT/'public','admin.html')


@app.get('/<path:name>')
def static(name): return send_from_directory(ROOT/'public',name)


init_db()
if __name__=='__main__':
    required = ['index.html', 'admin.html', 'app.js', 'styles.css', 'sandbox.js', 'og-sound.js']
    missing = [name for name in required if not (ROOT / 'public' / name).is_file()]
    if missing:
        raise SystemExit('Missing frontend files in /app/public: ' + ', '.join(missing)
                         + '. Add the public directory to the repository and redeploy.')
    print('BrainGrader: frontend found; starting HTTP server.', flush=True)
    from telegram_bot import start_bot
    start_bot(DB_PATH)
    from waitress import serve
    serve(app,host='0.0.0.0',port=int(os.getenv('PORT','8000')),threads=8)
