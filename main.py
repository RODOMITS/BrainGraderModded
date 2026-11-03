"""Public sandbox backend for the saved Brainrot Grader client. No real payments."""
import hashlib
import base64
import binascii
import hmac
import json
import math
import os
from pathlib import Path
import secrets
import sqlite3
import time
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qsl
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

from flask import Flask, Response, g, jsonify, redirect, request, send_from_directory

ROOT = Path(__file__).resolve().parent
FRONTEND_BUILD = hashlib.sha256(b''.join(
    (ROOT/'public'/name).read_bytes() for name in ('index.html','app.js','styles.css','sandbox.js','admin.html','admin.js','admin.css','admin-visual.js','telegram-web-app.js')
    if (ROOT/'public'/name).is_file()
)).hexdigest()[:12]
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024
DB_PATH = Path(os.getenv('DATABASE_PATH', str(ROOT / 'data' / 'brainrot.db')))
RNG = secrets.SystemRandom()
CUSTOM_SESSIONS = {}
CUSTOM_LOCK = threading.RLock()
REAL_LIVE = {}
REAL_LIVE_LOCK = threading.RLock()


def custom_session(create=False):
    token = getattr(g, 'play_session', '')
    if not token:
        if create:
            raise Problem('Переоткрой приложение, чтобы создать сессию')
        return None
    key = (g.uid, token)
    with CUSTOM_LOCK:
        if create and key not in CUSTOM_SESSIONS:
            CUSTOM_SESSIONS[key] = dict(items=[], images={}, catalog=None, touched=time.time())
        session = CUSTOM_SESSIONS.get(key)
        if session:
            session['touched'] = time.time()
        return session


def visible_item(item):
    return not item.get('customSession') or item['customSession'] == getattr(g, 'play_session', '')


def cleanup_custom_sessions(c):
    with CUSTOM_LOCK:
        expired = [key for key,s in CUSTOM_SESSIONS.items() if s['touched'] < time.time()-12*3600]
        for uid, token in expired:
            del CUSTOM_SESSIONS[(uid,token)]
            c.execute("DELETE FROM inventory WHERE user_id=? AND json_extract(item,'$.customSession')=?", (uid,token))
            c.execute("DELETE FROM next_results WHERE user_id=? AND json_extract(value,'$.item.customSession')=?", (uid,token))


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
        CREATE TABLE IF NOT EXISTS user_live(user_id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_catalogs(user_id TEXT PRIMARY KEY REFERENCES users(id), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS next_results(user_id TEXT NOT NULL REFERENCES users(id), game TEXT NOT NULL,
          value TEXT NOT NULL, PRIMARY KEY(user_id,game));
        CREATE TABLE IF NOT EXISTS mines_games(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
          status TEXT NOT NULL, mine_count INTEGER NOT NULL, board TEXT NOT NULL, revealed TEXT NOT NULL,
          stake TEXT NOT NULL, stake_value REAL NOT NULL, custom_session TEXT, created REAL NOT NULL, payout TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS mines_active_user ON mines_games(user_id) WHERE status='active';
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
        CREATE TABLE IF NOT EXISTS giveaways(id INTEGER PRIMARY KEY, item TEXT NOT NULL,
          ends REAL NOT NULL, minimum REAL NOT NULL, finished INTEGER NOT NULL DEFAULT 0,
          winner_id TEXT, winner_num INTEGER);
        CREATE TABLE IF NOT EXISTS giveaway_entries(giveaway_id INTEGER NOT NULL REFERENCES giveaways(id),
          user_id TEXT NOT NULL REFERENCES users(id), num INTEGER NOT NULL,
          PRIMARY KEY(giveaway_id,user_id), UNIQUE(giveaway_id,num));
        CREATE TABLE IF NOT EXISTS giveaway_progress(giveaway_id INTEGER NOT NULL REFERENCES giveaways(id),
          user_id TEXT NOT NULL REFERENCES users(id), amount REAL NOT NULL,
          PRIMARY KEY(giveaway_id,user_id));
        ''')
        # Uploaded assets exist only in process memory; discard their previous inventory snapshots on restart.
        c.execute("DELETE FROM inventory WHERE json_extract(item,'$.customSession') IS NOT NULL")
        c.execute("DELETE FROM next_results WHERE json_extract(value,'$.item.customSession') IS NOT NULL")
        c.execute("UPDATE mines_games SET status='expired' WHERE status='active' AND custom_session IS NOT NULL")
        if not c.execute('SELECT 1 FROM giveaways WHERE id=1').fetchone():
            source_path=ROOT/'source_catalog.json'
            source_items=json.loads(source_path.read_text(encoding='utf-8-sig'))['items'] if source_path.exists() else []
            prize=next((x for x in source_items if x['name']=='Skibidi Toilet'),
                       dict(id=1,name='Skibidi Toilet',price=13154,rarity='og',image='/img/brainrots/skibidi-toilet.webp'))
            c.execute('INSERT INTO giveaways(id,item,ends,minimum) VALUES (1,?,?,500)',
                      (json.dumps(prize),time.time()+9*86400+4*3600+46*60))
        if not c.execute("SELECT 1 FROM settings WHERE key='catalog'").fetchone():
            # Do not invent the original site's catalogue. Import its exported JSON instead.
            c.execute('INSERT INTO settings VALUES (?,?)', ('catalog', json.dumps(dict(items=[],cases=[]))))
        # Preserve previous wins in the feed when upgrading an existing deployment.
        previous = c.execute('''SELECT i.* FROM inventory i
          WHERE i.test=0 AND i.source IN ('case','upgrade','mystery','dice','mines')
          AND json_extract(i.item,'$.customSession') IS NULL
          AND NOT EXISTS(SELECT 1 FROM live_drops d WHERE d.inventory_id=i.id)''').fetchall()
        for row in previous:
            item = json.loads(row['item'])
            c.execute('INSERT INTO live_drops VALUES (?,?,?,?,?)',
                      (row['id'],row['item'],json.dumps(dict(kind=row['source'])),item['price'],row['created']))
        c.commit()


def base_catalog():
    personal = db().execute('SELECT value FROM user_catalogs WHERE user_id=?', (g.uid,)).fetchone()
    if personal:
        return json.loads(personal[0])
    source = ROOT / 'source_catalog.json'
    if source.exists():
        data = json.loads(source.read_text(encoding='utf-8-sig'))
        validate_catalog(data)
        return data
    return json.loads(db().execute("SELECT value FROM settings WHERE key='catalog'").fetchone()[0])


def catalog():
    data = base_catalog()
    session = custom_session()
    if session:
        if session['catalog'] is not None:
            data = json.loads(json.dumps(session['catalog']))
        known = {item['id'] for item in data['items']}
        data['items'].extend(dict(item) for item in session['items'] if item['id'] not in known)
    return data


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
    session_token=request.headers.get('X-Play-Session','')
    g.play_session=session_token if len(session_token)==32 and all(ch in '0123456789abcdef' for ch in session_token) else ''
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
    cleanup_custom_sessions(c)
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
            if (not owned or r['status']=='owned') and visible_item(json.loads(r['item']))]


def add_item(item, source, test=False, uid=None):
    if item.get('customSession') and (not visible_item(item) or uid not in (None,g.uid)):
        raise Problem('Кастомный предмет доступен только в текущей сессии')
    details = source if isinstance(source, dict) else dict(kind=source)
    kind = details['kind']
    created = time.time()
    iid = db().execute('INSERT INTO inventory(user_id,item,test,source,created) VALUES (?,?,?,?,?)',
                       (uid or g.uid,json.dumps(item),int(test),kind,created)).lastrowid
    if not test and not item.get('customSession') and kind in ('case','upgrade','mystery','dice','mines'):
        db().execute('INSERT INTO live_drops VALUES (?,?,?,?,?)',
                     (iid,json.dumps(item),json.dumps(details),item['price'],created))
    return iid


def local_home():
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


def live_settings():
    row=db().execute('SELECT value FROM user_live WHERE user_id=?',(g.uid,)).fetchone()
    return json.loads(row[0]) if row else dict(mode='local',drops=[],topId=None)


def home():
    config=live_settings()
    if config['mode']=='editor':
        drops=[dict(d,source=dict(kind=d['source']) if isinstance(d.get('source'),str) else d.get('source')) for d in config['drops']]
        top=next((d for d in drops if d['id']==config.get('topId')),None)
        return dict(drops=drops,top=top or max(drops,key=lambda d:d['price'],default=None),bonus=None,liveMode='editor')
    if config['mode']!='real':
        return dict(local_home(),liveMode='local')
    key=(g.uid,g.play_session)
    # Credentials and cached original responses remain in memory, never in SQLite/history.
    with REAL_LIVE_LOCK:
        entry=REAL_LIVE.get(key)
        if not entry or entry['expires']<time.time():
            REAL_LIVE.pop(key,None)
            return dict(drops=[],top=None,bonus=None,liveMode='real',liveError='Подключи сессию оригинала в редакторе лайв-дропов')
        if entry.get('next',0)>time.time():
            return entry['data']
        try:
            req=Request('https://brainrotgrader.com/api/home',headers={'Authorization':'tma '+entry['token'],'Accept':'application/json'})
            with urlopen(req,timeout=4) as response:
                data=json.loads(response.read(512_001))
            if not isinstance(data,dict) or not isinstance(data.get('drops'),list):
                raise ValueError('format')
            clean=[]
            def clean_drop(d):
                if not isinstance(d,dict): raise ValueError('drop')
                image=str(d.get('image',''))
                if not image.startswith('/img/'): image='/img/coin.webp'
                return dict(id='real:'+str(d.get('id',''))[:100],name=str(d.get('name',''))[:120],
                            image=image,price=number(d.get('price',0)),rarity=d.get('rarity') if d.get('rarity') in ('common','rare','epic','legendary','og') else 'common',
                            source=d.get('source') if isinstance(d.get('source'),(str,dict)) else 'case',createdAt=d.get('createdAt'))
            clean=[clean_drop(d) for d in data['drops'][:30]]
            entry['data']=dict(drops=clean,top=clean_drop(data['top']) if data.get('top') else None,bonus=None,liveMode='real')
        except (HTTPError,URLError,TimeoutError,ValueError,TypeError,OSError,Problem) as error:
            message='Оригинал отклонил сессию. Открой его заново и переподключись.' if isinstance(error,HTTPError) and error.code in (401,403) else 'Лента оригинала временно недоступна'
            entry['data']=dict(entry.get('data') or dict(drops=[],top=None,bonus=None),liveMode='real',liveError=message)
        entry['next']=time.time()+10
        return entry['data']


def settle_giveaways():
    for giveaway in db().execute('SELECT * FROM giveaways WHERE finished=0 AND ends<=?',(time.time(),)).fetchall():
        entries=db().execute('SELECT user_id,num FROM giveaway_entries WHERE giveaway_id=?',(giveaway['id'],)).fetchall()
        winner=RNG.choice(entries) if entries else None
        if winner:
            add_item(json.loads(giveaway['item']),'giveaway',uid=winner['user_id'])
        db().execute('UPDATE giveaways SET finished=1,winner_id=?,winner_num=? WHERE id=?',
                     (winner['user_id'] if winner else None,winner['num'] if winner else None,giveaway['id']))


def giveaway_view(row):
    c=db(); gid=row['id']
    entry=c.execute('SELECT num FROM giveaway_entries WHERE giveaway_id=? AND user_id=?',(gid,g.uid)).fetchone()
    progress=c.execute('SELECT amount FROM giveaway_progress WHERE giveaway_id=? AND user_id=?',(gid,g.uid)).fetchone()
    amount=progress[0] if progress else 0
    winner=None
    if row['winner_id']:
        winner_user=c.execute('SELECT name FROM users WHERE id=?',(row['winner_id'],)).fetchone()
        winner=dict(name=winner_user[0] if winner_user else 'Игрок',num=row['winner_num'],me=row['winner_id']==g.uid)
    return dict(id=gid,item=json.loads(row['item']),endsAt=iso(row['ends']),needDeposit=row['minimum'],
                deposited=amount,participants=c.execute('SELECT COUNT(*) FROM giveaway_entries WHERE giveaway_id=?',(gid,)).fetchone()[0],
                myNum=entry[0] if entry else None,canJoin=not row['finished'] and amount>=row['minimum'],winner=winner)


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
    return dict(build=FRONTEND_BUILD,theme='halloween',caseAnim='classic',sandbox=True,depositEnabled=False,withdrawEnabled=False,
                starsRate=1,starsMin=1,starsMax=10000,refBonusPercent=0,withdrawMin=1,withdrawWindow='отключён',
                upgrade=dict(maxItems=5,minChance=1,maxChance=90,presets=[dict(label=f'×{n}',mult=n) for n in [1.25,2,3,5,10]]),
                mystery=dict(enabled=True,mult=3,minInput=1,maxInput=1e9,floor=1,cap=1e9),
                dice=dict(enabled=True,min=1,max=100000,maxItems=5,colors=[dict(name=n,hex=h) for n,h in
                    zip(['Красный','Оранжевый','Жёлтый','Зелёный','Синий','Фиолетовый'],
                        ['#ef4444','#f97316','#facc15','#22c55e','#3b82f6','#a855f7'])],
                    table=[dict(hits=h,mult=m) for h,m in [(1,2),(2,0),(3,0),(4,3)]],
                    rainbow=dict(mult=10)))


def targets(body):
    rows=selected(body)
    if len(rows)>5:
        raise Problem('Можно поставить до 5 предметов')
    value=sum(i['item']['price'] for i in rows)
    input_ids={i['item']['id'] for i in rows}
    input_prices={round(i['item']['price'],2) for i in rows}
    options=[dict(x,chance=round(value/x['price']*90,2)) for x in catalog()['items']
             if x['id'] not in input_ids and round(x['price'],2) not in input_prices
             and 1<=value/x['price']*90<=90]
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
    result=json.loads(row[0])
    if result.get('item') and not visible_item(result['item']):
        return None
    db().execute('DELETE FROM next_results WHERE user_id=? AND game=?', (g.uid,game))
    return result


def mines_multiplier(count, opened):
    if not opened:
        return 1.0
    return math.floor(0.99*math.comb(25,opened)/math.comb(25-count,opened)*100)/100


def mines_reward(value):
    pool=[i for i in catalog()['items'] if i['price']<=value]
    item=max(pool,key=lambda i:(i['price'],-i['id'])) if pool else None
    return dict(item=item,coins=round(value-(item['price'] if item else 0),2),total=value)


def mines_view(row):
    opened=json.loads(row['revealed']); count=row['mine_count']
    mult=mines_multiplier(count,len(opened))
    value=round(row['stake_value']*mult,2)
    result=json.loads(row['payout']) if row['payout'] else None
    return dict(id=row['id'],status=row['status'],mines=count,revealed=opened,
                bombs=json.loads(row['board']) if row['status']!='active' else [],
                stake=json.loads(row['stake']),stakeValue=row['stake_value'],multiplier=mult,
                reward=result if result else mines_reward(value),payout=result)


def mines_current():
    row=db().execute("SELECT * FROM mines_games WHERE user_id=? AND status='active'",(g.uid,)).fetchone()
    if row and row['custom_session'] and (row['custom_session']!=g.play_session or not custom_session()):
        db().execute("UPDATE mines_games SET status='expired' WHERE id=?",(row['id'],))
        return None
    return row


def mines_cashout(row):
    mult=mines_multiplier(row['mine_count'],len(json.loads(row['revealed'])))
    payout=mines_reward(round(row['stake_value']*mult,2))
    if payout['item']:
        payout['inventoryId']=add_item(payout['item'],'mines')
    db().execute('UPDATE users SET balance=balance+? WHERE id=?',(payout['coins'],g.uid))
    db().execute("UPDATE mines_games SET status='cashed',payout=? WHERE id=?",(json.dumps(payout),row['id']))
    return db().execute('SELECT * FROM mines_games WHERE id=?',(row['id'],)).fetchone()


def dispatch(path, body):
    c=db()
    parts=path.split('/')
    post=request.method=='POST'
    if post and path in ('admin/balance','admin/grant','admin/giveaway-progress'):
        if 'userId' in body and str(body['userId'])!=g.uid:
            raise Problem('Это действие доступно только для своего аккаунта', 'forbidden',403)
    # All payment and withdrawal mutations are rejected, including unknown nested routes.
    if path.startswith('deposit') or (path.startswith('withdraw') and post):
        raise Problem('Пополнение и вывод отключены. Баланс можно изменить в общей админке.', 'payments_disabled',403)
    if path=='me': return me()
    if path=='config': return config()
    if path=='mines/current' and not post:
        row=mines_current()
        return dict(game=mines_view(row) if row else None)
    if path=='mines/start' and post:
        if mines_current(): raise Problem('Сначала заверши текущую игру')
        count=integer(body.get('mines'),1,24); rows=selected(body)
        if len(rows)!=1: raise Problem('Выбери одного брейнрота для ставки')
        item=rows[0]['item']; bombs=RNG.sample(range(25),count)
        consume(rows,'mines')
        gid=c.execute("INSERT INTO mines_games(user_id,status,mine_count,board,revealed,stake,stake_value,custom_session,created) VALUES (?,'active',?,?,'[]',?,?,?,?)",
                      (g.uid,count,json.dumps(bombs),json.dumps(item),item['price'],item.get('customSession'),time.time())).lastrowid
        return dict(game=mines_view(c.execute('SELECT * FROM mines_games WHERE id=?',(gid,)).fetchone()))
    if path in ('mines/reveal','mines/cashout') and post:
        row=mines_current()
        if not row or row['id']!=integer(body.get('gameId')): raise Problem('Активная игра не найдена')
        if path.endswith('cashout'):
            row=mines_cashout(row)
            return dict(game=mines_view(row),balance=user()['balance'])
        tile=integer(body.get('tile'),0,24); opened=json.loads(row['revealed']); bombs=json.loads(row['board'])
        if tile in opened: return dict(game=mines_view(row))
        rig=take_next_result('mines')
        if rig:
            if rig['mode']=='safe' and tile in bombs:
                other=RNG.choice([i for i in range(25) if i not in opened and i not in bombs])
                bombs.remove(tile); bombs.append(other)
            elif rig['mode']=='bomb' and tile not in bombs:
                other=RNG.choice(bombs); bombs.remove(other); bombs.append(tile)
        c.execute('UPDATE mines_games SET board=? WHERE id=?',(json.dumps(bombs),row['id']))
        if tile in bombs:
            c.execute("UPDATE mines_games SET status='lost',payout=? WHERE id=?",(json.dumps(dict(item=None,coins=0,total=0,bomb=tile)),row['id']))
        else:
            opened.append(tile)
            c.execute('UPDATE mines_games SET revealed=? WHERE id=?',(json.dumps(opened),row['id']))
        row=c.execute('SELECT * FROM mines_games WHERE id=?',(row['id'],)).fetchone()
        if row['status']=='active' and len(opened)==25-row['mine_count']:
            row=mines_cashout(row)
        return dict(game=mines_view(row),balance=user()['balance'])
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
        return dict(item=it,inventoryId=add_item(it,'shop'),balance=user()['balance'])
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
            roll=RNG.random()*chance if rig['mode']!='lose' else chance+RNG.random()*(100-chance)
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
            if rig['mode']!='lose' and hits not in (1,4):
                hits=1
            dice=[color]*hits+[RNG.choice([n for n in range(6) if n!=color]) for _ in range(4-hits)]
            RNG.shuffle(dice)
        # The original does not expose its bonus probability; this version uses 1% per roll by default.
        bonus=rig['mode']=='bonus' if rig else RNG.random()<number(os.getenv('DICE_BONUS_CHANCE','0.01'),0,1)
        if bonus:
            dice[RNG.randrange(4)]=6
        hits=dice.count(color); mult=10 if bonus else {0:0,1:2,2:0,3:0,4:3}[hits]
        won=[]
        winnings=0
        if not mult: consume(rows,'dice')
        else:
            for row in rows:
                prize=rig['item'] if rig and rig.get('item') else row['item']
                won.extend(add_item(prize,'dice') for _ in range(mult-1))
                winnings+=prize['price']*(mult-1)
        return dict(dice=dice,color=color,hits=hits,mult=mult,rainbow=bonus,wonIds=won,net=winnings if mult else -value)
    if path=='home': return home()
    if path=='giveaways' and not post:
        settle_giveaways()
        rows=c.execute('SELECT * FROM giveaways ORDER BY id DESC').fetchall()
        return dict(now=iso(),active=[giveaway_view(r) for r in rows if not r['finished']],
                    finished=[giveaway_view(r) for r in rows if r['finished']])
    if path.startswith('giveaways/') and path.endswith('/join') and post:
        settle_giveaways()
        row=c.execute('SELECT * FROM giveaways WHERE id=?',(integer(parts[1]),)).fetchone()
        if not row or row['finished']: raise Problem('Розыгрыш завершён')
        view=giveaway_view(row)
        if view['myNum'] is not None: return dict(num=view['myNum'])
        if not view['canJoin']: raise Problem('Недостаточно прогресса для участия')
        num=view['participants']+1
        c.execute('INSERT INTO giveaway_entries VALUES (?,?,?)',(row['id'],g.uid,num))
        return dict(num=num)
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
        result=dict(me=me(),promos=[dict(r) for r in c.execute('SELECT * FROM promos')],nextResults={},live=live_settings())
        if request.args.get('catalog','1')!='0':
            result['catalog']=catalog()
        for r in c.execute('SELECT game,value FROM next_results WHERE user_id=?',(g.uid,)):
            value=json.loads(r['value'])
            if not value.get('item') or visible_item(value['item']):
                result['nextResults'][r['game']]=value
        return result
    if path=='admin/live' and post:
        mode=body.get('mode')
        if mode not in ('local','editor','real'): raise Problem('Выбери источник ленты')
        rows=body.get('drops',[])
        if not isinstance(rows,list) or len(rows)>30: raise Problem('В ленте максимум 30 дропов')
        drops=[]
        for row in rows:
            if not isinstance(row,dict): raise Problem('Неверная запись дропа')
            item=find_item(row.get('itemId'))
            if not item or item.get('customSession'): raise Problem('Выбери обычный предмет из каталога')
            ident=str(row.get('id') or secrets.token_hex(8))[:80]
            if any(d['id']==ident for d in drops): raise Problem('Повторный ID дропа')
            source=row.get('source','case')
            if source not in ('case','upgrade','mystery','dice','mines'): raise Problem('Неизвестная игра')
            drops.append(dict(item,id=ident,itemId=item['id'],source=source,createdAt=iso(time.time())))
        live_config=dict(mode=mode,drops=drops,topId=body.get('topId'))
        c.execute('INSERT OR REPLACE INTO user_live VALUES (?,?)',(g.uid,json.dumps(live_config)))
        return dict(ok=True)
    if path in ('admin/next-result','admin/next-result/cancel') and post:
        game=body.get('game')
        if game not in ('case','upgrade','mystery','dice','mines'):
            raise Problem('Выбери игру')
        if path.endswith('/cancel'):
            c.execute('DELETE FROM next_results WHERE user_id=? AND game=?',(g.uid,game))
            return dict(ok=True)
        mode=body.get('mode','item')
        allowed={'case':('item',),'mystery':('item',),'upgrade':('item','win','lose'),
                 'dice':('item','win','lose','bonus'),'mines':('safe','bomb')}
        if mode not in allowed[game]:
            raise Problem('Для кейса и мистери выбери конкретный предмет')
        item=None
        if mode=='item':
            item=find_item(body.get('itemId'))
            if not item:
                raise Problem('Предмет не найден')
        value=dict(mode=mode,item=item)
        if game=='dice':
            value['hits']=0 if mode in ('lose','bonus') else integer(body.get('hits',1),1,4)
            if mode not in ('lose','bonus') and value['hits'] not in (1,4):
                raise Problem('Выигрыш: 1 или 4 совпадения')
        c.execute('INSERT OR REPLACE INTO next_results VALUES (?,?,?)',(g.uid,game,json.dumps(value)))
        return dict(ok=True)
    if path=='admin/giveaway-progress' and post:
        gid=integer(body.get('giveawayId',1)); uid=g.uid; amount=number(body.get('amount'))
        if not c.execute('SELECT 1 FROM giveaways WHERE id=? AND finished=0',(gid,)).fetchone(): raise Problem('Активный розыгрыш не найден')
        if not c.execute('SELECT 1 FROM users WHERE id=?',(uid,)).fetchone(): raise Problem('Игрок не найден')
        c.execute('INSERT OR REPLACE INTO giveaway_progress VALUES (?,?,?)',(gid,uid,amount))
        return dict(ok=True)
    if path=='admin/balance' and post:
        uid=g.uid; amount=number(body.get('balance'))
        if not c.execute('UPDATE users SET balance=? WHERE id=?',(amount,uid)).rowcount: raise Problem('Игрок не найден')
        return dict(ok=True,balance=amount)
    if path=='admin/grant' and post:
        it=find_item(body.get('itemId')); uid=g.uid; qty=integer(body.get('qty',1),1,100)
        if not it or not c.execute('SELECT 1 FROM users WHERE id=?',(uid,)).fetchone(): raise Problem('Игрок или предмет не найден')
        return dict(ok=True,ids=[add_item(it,'admin',uid=uid) for _ in range(qty)])
    if path=='admin/catalog' and post:
        body = {k:v for k,v in body.items() if k!='key'}
        validate_catalog(body)
        if any(item.get('customSession') for item in body['items']):
            custom_session(create=True)['catalog']=body
        else:
            c.execute('INSERT OR REPLACE INTO user_catalogs VALUES (?,?)',(g.uid,json.dumps(body)))
            session=custom_session()
            if session:
                session['catalog']=None
        return dict(ok=True)
    if path=='admin/catalog/reset' and post:
        c.execute('DELETE FROM user_catalogs WHERE user_id=?',(g.uid,))
        session=custom_session()
        if session:
            session['catalog']=None
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
        if it.get('customSession'):
            session=custom_session()
            original=next((x for x in session['items'] if x['id']==iid),None) if session else None
            if not original or it['customSession']!=g.play_session or it['image']!=original['image']:
                raise Problem('Кастомный предмет доступен только в своей сессии')
        else:
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
        c.execute('BEGIN IMMEDIATE' if request.method=='POST' or path in ('giveaways','mines/current') else 'BEGIN')
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


@app.post('/api/admin/live-connect')
def connect_real_live():
    body=request.get_json(silent=True) or {}
    if not isinstance(body,dict): raise Problem('Нужен JSON-объект')
    if not g.play_session: raise Problem('Переоткрой приложение для подключения сессии')
    token=body.get('initData','')
    if not isinstance(token,str) or not 20<len(token)<16000 or '\n' in token or '\r' in token:
        raise Problem('Вставь Telegram.WebApp.initData из оригинального приложения')
    with REAL_LIVE_LOCK:
        now=time.time()
        for key in list(REAL_LIVE):
            if REAL_LIVE[key]['expires']<now: del REAL_LIVE[key]
        if len(REAL_LIVE)>=100 and (g.uid,g.play_session) not in REAL_LIVE:
            raise Problem('Слишком много подключений. Попробуй позже')
        REAL_LIVE[(g.uid,g.play_session)]=dict(token=token,expires=now+3600)
    return jsonify(dict(ok=True))


@app.post('/api/admin/custom-item')
def upload_custom_item():
    body=request.get_json(silent=True)
    if not isinstance(body,dict):
        raise Problem('Нужны данные предмета')
    name=body.get('name')
    if not isinstance(name,str) or not 1<=len(name.strip())<=80:
        raise Problem('Название: от 1 до 80 символов')
    rarity=body.get('rarity')
    if rarity not in ('common','rare','epic','legendary','og'):
        raise Problem('Выбери редкость')
    price=number(body.get('price'),0.01)
    encoded=body.get('imageData','')
    if not isinstance(encoded,str) or ',' not in encoded or len(encoded)>1_500_000:
        raise Problem('Загрузи PNG, JPEG или WebP размером до 1 МБ')
    try:
        raw=base64.b64decode(encoded.split(',',1)[1],validate=True)
    except (ValueError,binascii.Error):
        raise Problem('Не удалось прочитать картинку')
    if not 1<=len(raw)<=1024*1024:
        raise Problem('Размер картинки: до 1 МБ')
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        mime='image/png'
    elif raw.startswith(b'\xff\xd8\xff'):
        mime='image/jpeg'
    elif raw.startswith(b'RIFF') and raw[8:12]==b'WEBP':
        mime='image/webp'
    else:
        raise Problem('Поддерживаются PNG, JPEG и WebP')
    session=custom_session(create=True)
    occupied={i['id'] for i in catalog()['items']}
    with CUSTOM_LOCK:
        if len(session['items'])>=20 or sum(len(v[0]) for v in session['images'].values())+len(raw)>5*1024*1024:
            raise Problem('Лимит сессии: 20 предметов и 5 МБ картинок')
        iid=700_000_000+secrets.randbelow(299_999_999)
        while iid in occupied:
            iid=700_000_000+secrets.randbelow(299_999_999)
        item=dict(id=iid,name=name.strip(),price=price,rarity=rarity,
                  image=f'/session-img/{g.play_session}/{iid}',customSession=g.play_session)
        session['items'].append(item)
        session['images'][iid]=(raw,mime)
    c=db()
    try:
        c.execute('BEGIN IMMEDIATE')
        inventory_id=add_item(item,'custom')
        c.commit()
    except Exception:
        c.rollback()
        with CUSTOM_LOCK:
            session['items']=[i for i in session['items'] if i['id']!=iid]
            session['images'].pop(iid,None)
        raise
    return jsonify(ok=True,item=item,inventoryId=inventory_id)


@app.get('/session-img/<token>/<int:item_id>')
def custom_image(token,item_id):
    with CUSTOM_LOCK:
        for (_,session_token),session in CUSTOM_SESSIONS.items():
            if session_token==token and session['touched']>=time.time()-12*3600:
                image=session['images'].get(item_id)
                if image:
                    return Response(image[0],mimetype=image[1],headers={'Cache-Control':'no-store'})
    raise Problem('Картинка больше недоступна', 'not_found',404)


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
def index():
    html=(ROOT/'public'/'index.html').read_text(encoding='utf-8').replace('__BG_BUILD__',FRONTEND_BUILD)
    return Response(html,mimetype='text/html',headers={'Cache-Control':'no-store'})


@app.get('/admin')
def admin():
    html=(ROOT/'public'/'admin.html').read_text(encoding='utf-8').replace('__BG_BUILD__',FRONTEND_BUILD)
    if request.args.get('embed')=='1':
        html=html.replace(f'<script defer src="/telegram-web-app.js?v={FRONTEND_BUILD}"></script>','')
    return Response(html,mimetype='text/html',headers={'Cache-Control':'no-store'})


@app.get('/<path:name>')
def static(name): return send_from_directory(ROOT/'public',name)


init_db()
if __name__=='__main__':
    required = ['index.html', 'admin.html', 'admin.js', 'admin-visual.js', 'admin.css', 'app.js', 'styles.css', 'sandbox.js', 'og-sound.js', 'telegram-web-app.js']
    missing = [name for name in required if not (ROOT / 'public' / name).is_file()]
    if missing:
        raise SystemExit('Missing frontend files in /app/public: ' + ', '.join(missing)
                         + '. Add the public directory to the repository and redeploy.')
    print('BrainGrader: frontend found; starting HTTP server.', flush=True)
    from telegram_bot import start_bot
    start_bot(DB_PATH)
    from waitress import serve
    serve(app,host='0.0.0.0',port=int(os.getenv('PORT','8000')),threads=8)
