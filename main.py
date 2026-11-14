"""Public sandbox backend for the saved Brainrot Grader client. No real payments."""
import hashlib
import base64
import binascii
import hmac
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import threading
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qsl
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

import grader_pass
import named_cases
from PIL import Image

from flask import Flask, Response, g, jsonify, redirect, request, send_file, send_from_directory

ROOT = Path(__file__).resolve().parent
STREAK_SOURCE=(ROOT/'source_streak.json').read_bytes()
DEFAULT_STREAK=json.loads(STREAK_SOURCE)['track']
STREAK_VERSION=hashlib.sha256(STREAK_SOURCE).hexdigest()[:12]
FRONTEND_BUILD = hashlib.sha256(b''.join(
    (ROOT/'public'/name).read_bytes() for name in ('index.html','app.js','styles.css','sandbox.js','admin.html','admin.js','admin-pass.js','admin.css','admin-visual.js','ui-audio.js','telegram-web-app.js')
    if (ROOT/'public'/name).is_file()
)).hexdigest()[:12]
app = Flask(__name__, static_folder=None)
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024
OWNER_UID = 'tg:1821268346'
ONLINE_TTL = 18
SCREAMER_LIMIT = 8 * 1024 * 1024
DB_PATH = Path(os.getenv('DATABASE_PATH', str(ROOT / 'data' / 'brainrot.db')))
RNG = secrets.SystemRandom()
CUSTOM_SESSIONS = {}
CUSTOM_LOCK = threading.RLock()
ORIGINAL_LOCK = threading.Lock()
SHARED_ORIGINAL = {}


class OriginalNoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def original_api(path, token):
    request = Request('https://brainrotgrader.com/api/' + path, headers={
        'Authorization': 'tma ' + token, 'Accept': 'application/json',
    })
    with build_opener(OriginalNoRedirect()).open(request, timeout=5) as response:
        payload = response.read(2_000_001)
    if len(payload) > 2_000_000:
        raise ValueError('Original response too large')
    return json.loads(payload)


def original_item(item):
    result = {key: item[key] for key in ('name', 'price', 'rarity', 'image')}
    result['id'] = integer(item['id'])
    for key in ('kind', 'type', 'category'):
        if isinstance(item.get(key), str):
            result[key] = item[key]
    if result['rarity'] == 'coins' or item.get('coins'):
        result['coins'] = True
        result['rarity'] = 'common'
    return result


CASE_RARITY_WEIGHTS = {'common': 60, 'rare': 25, 'epic': 10, 'legendary': 4, 'og': 1}
UPGRADE_MIN_CHANCE = 0
UPGRADE_MAX_CHANCE = 75
UPGRADE_CHANCE_FACTOR = 90
MUTATIONS = {'gold': 1.25, 'diamond': 1.4, 'rainbow': 3}


def can_mutate(item):
    return (custom_content_enabled() and not item.get('coins') and not item.get('mutation')
            and not any(item.get(key, '').lower() in ('gear', 'gears', 'base', 'bases', 'coins')
                        for key in ('kind', 'type', 'category') if isinstance(item.get(key), str))
            and not re.search(r'\b(?:base|gear|slap)\b', item['name'], re.I)
            and not re.search(r'/(?:gears?|bases?)/|-(?:gear|base|slap)\.', item.get('image', ''), re.I))


def mutated(item, mutation):
    return dict(item, mutation=mutation, price=round(item['price'] * MUTATIONS[mutation], 2))


def roll_mutation(item):
    if can_mutate(item):
        mutation = RNG.choices((None, *MUTATIONS), weights=(45, 30, 20, 5))[0]
        if mutation:
            return mutated(item, mutation)
    return item


def mutation_variants(item):
    yield item
    if can_mutate(item):
        for mutation in MUTATIONS:
            yield mutated(item, mutation)
DICE_PAYOUTS = (0, 2, 0, 0, 3)
DICE_BONUS_MULTIPLIER = 10


def apply_case_rarity_weights(catalog):
    items = {item['id']: item for item in catalog['items']}
    for case_data in catalog['cases']:
        drops = case_data['items']
        weights = []
        for drop in drops:
            item = items[drop['itemId']]
            weights.append(CASE_RARITY_WEIGHTS[item['rarity']] / item['price'] ** 1.5)
        scale = 1_000_000 / max(weights)
        for drop, weight in zip(drops, weights):
            drop['weight'] = max(0.01, round(weight * scale, 2))
    return catalog


def fetch_original_catalog(token):
    summaries = original_api('cases', token)
    if not isinstance(summaries, list) or not 1 <= len(summaries) <= 100:
        raise ValueError('Invalid case list')
    shop = original_api('shop', token)
    items = {}
    for raw in shop['items']:
        item = original_item(raw)
        items[item['id']] = item
    with ThreadPoolExecutor(max_workers=4) as pool:
        details = list(pool.map(lambda cs: original_api(f"cases/{integer(cs['id'])}", token), summaries))
    cases = []
    for summary, detail in zip(summaries, details):
        cid = integer(summary['id'])
        if detail['id'] != cid:
            raise ValueError('Mismatched case')
        case_items = []
        for raw in detail['items']:
            item = original_item(raw)
            iid = item['id']
            items[iid] = item
            case_items.append(dict(itemId=iid, weight=1))
        cases.append(dict(id=cid, name=summary['name'], price=summary['price'], image=summary['image'],
                          category=summary.get('category', 'standard'),
                          freeKind='daily' if summary.get('freeKind') else None, items=case_items))
    catalog = dict(items=list(items.values()), cases=cases)
    validate_catalog(catalog)
    return apply_case_rarity_weights(catalog)


def refresh_original(entry, token, kind):
    delay = 60
    status = 'ready'
    try:
        if kind == 'catalog':
            value = fetch_original_catalog(token)
            delay = 300
        elif kind == 'pass':
            value = grader_pass.original_definition(original_api('pass', token))
            delay = 30
        elif kind == 'dragon':
            raw = original_api('config', token).get('dragonExchange')
            value = None if not raw else dict(itemId=integer(raw['dragon']['id']), minimum=number(raw['from'], 1))
            delay = 300
        elif kind == 'giveaways':
            data = original_api('giveaways', token)
            value = {
                group: [dict(itemId=integer(row['item']['id']), count=integer(row['participants'], 0))
                        for row in data[group]]
                for group in ('active', 'finished')
            }
            value['expires'] = time.time() + 120
        elif kind == 'deposit':
            data = original_api('deposit/current', token)
            if not isinstance(data.get('open'), bool):
                raise ValueError('Invalid original deposit status')
            value = dict(open=data['open'], expires=time.time() + 120)
            delay = 30
        elif kind == 'live':
            data = original_api('home', token)
            value = dict(drops=[original_drop(drop) for drop in data['drops'][:30]],
                         top=original_drop(data['top']) if data.get('top') else None,
                         expires=time.time() + 120)
            delay = 10
        else:
            raw = original_api('home', token).get('bonus')
            value = None
            if raw:
                expires = datetime.fromisoformat(raw['endsAt'].replace('Z', '+00:00')).timestamp()
                if expires > time.time():
                    value = dict(code=promo_code(raw['code']), percent=number(raw['percent'], 0, 100),
                                 endsAt=iso(expires), expires=expires, used=False)
                    delay = min(60, max(1, expires - time.time()))
            if value is None:
                delay = 15
        with ORIGINAL_LOCK:
            entry[kind] = value
    except HTTPError as error:
        status = 'auth_rejected' if error.code in (401, 403) else f'http_{error.code}'
    except OSError:
        status = 'network_error'
    except (ValueError, TypeError, KeyError, AttributeError, Problem):
        # A failed refresh must leave the last complete catalogue available.
        status = 'invalid_response'
    finally:
        with ORIGINAL_LOCK:
            entry[kind + '_status'] = status
            entry[kind + '_next'] = time.time() + delay
            entry[kind + '_loading'] = False


def original_snapshot(kind):
    token = os.getenv('ORIGINAL_INIT_DATA', '').strip()
    if not token:
        return None
    now = time.time()
    with ORIGINAL_LOCK:
        if now >= SHARED_ORIGINAL.get(kind + '_next', 0) and not SHARED_ORIGINAL.get(kind + '_loading'):
            SHARED_ORIGINAL[kind + '_loading'] = True
            threading.Thread(target=refresh_original, args=(SHARED_ORIGINAL, token, kind), daemon=True).start()
        value = SHARED_ORIGINAL.get(kind)
        if value and (kind in ('catalog', 'pass', 'dragon') or value['expires'] > now):
            return value
    return None


def original_status(kind):
    if not os.getenv('ORIGINAL_INIT_DATA', '').strip():
        return 'missing_env'
    with ORIGINAL_LOCK:
        if SHARED_ORIGINAL.get(kind + '_loading'):
            return 'loading'
        return SHARED_ORIGINAL.get(kind + '_status', 'waiting')


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
        CREATE TABLE IF NOT EXISTS channel_checks(
          user_id TEXT PRIMARY KEY, subscribed INTEGER NOT NULL, checked REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS site_presence(
          user_id TEXT PRIMARY KEY, username TEXT NOT NULL, seen REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS online_samples(
          minute INTEGER PRIMARY KEY, players INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS presence_reminders(
          user_id TEXT PRIMARY KEY REFERENCES users(id), on_enter INTEGER NOT NULL,
          on_leave INTEGER NOT NULL, was_online INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS screamers(
          target TEXT PRIMARY KEY, id TEXT NOT NULL, mime TEXT NOT NULL,
          video BLOB NOT NULL, expires REAL NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS screamer_history(
          id TEXT PRIMARY KEY, target TEXT NOT NULL, username TEXT NOT NULL,
          sent REAL NOT NULL, delivered REAL, ended TEXT);
        CREATE INDEX IF NOT EXISTS screamer_history_sent ON screamer_history(sent DESC);
        CREATE TABLE IF NOT EXISTS user_live(user_id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS streak_progress(user_id TEXT PRIMARY KEY,last_day INTEGER,count INTEGER NOT NULL,best INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS streak_rewards(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,day INTEGER NOT NULL,reward TEXT NOT NULL,expires REAL NOT NULL,claimed INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS streak_rewards_user ON streak_rewards(user_id,claimed,expires);
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
        CREATE INDEX IF NOT EXISTS inventory_created ON inventory(created);
        CREATE TABLE IF NOT EXISTS fake_withdrawals(
          id INTEGER PRIMARY KEY, inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
          roblox_username TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS fake_withdrawals_queued
          ON fake_withdrawals(inventory_id) WHERE status='queued';
        CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL, key TEXT NOT NULL, path TEXT NOT NULL,
          body TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,key));
        CREATE TABLE IF NOT EXISTS cooldown(user_id TEXT NOT NULL, case_id INTEGER NOT NULL, until REAL NOT NULL,
          PRIMARY KEY(user_id,case_id));
        CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, user_id TEXT, kind TEXT, payload TEXT, created REAL);
        CREATE INDEX IF NOT EXISTS history_case_batches ON history(user_id, created)
          WHERE kind GLOB 'cases/*/open';
        CREATE INDEX IF NOT EXISTS history_streak_checkin ON history(user_id, created DESC, id DESC)
          WHERE kind='streak/checkin';
        CREATE TABLE IF NOT EXISTS live_drops(inventory_id INTEGER PRIMARY KEY REFERENCES inventory(id),
          item TEXT NOT NULL, source TEXT NOT NULL, price REAL NOT NULL, created REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS live_drops_created ON live_drops(created DESC, inventory_id DESC);
        CREATE TABLE IF NOT EXISTS promos(code TEXT PRIMARY KEY, reward REAL NOT NULL, uses INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS claims(user_id TEXT, code TEXT, PRIMARY KEY(user_id,code));
        CREATE TABLE IF NOT EXISTS promo_options(
          code TEXT PRIMARY KEY, case_id INTEGER, partner_id TEXT, max_uses INTEGER
        );
        CREATE TABLE IF NOT EXISTS referral_profiles(
          user_id TEXT PRIMARY KEY, code TEXT NOT NULL, stats TEXT NOT NULL
        );
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
        c.executescript(grader_pass.SCHEMA)
        c.executescript(named_cases.SCHEMA)
        c.execute('BEGIN IMMEDIATE')
        if 'captions' not in {row['name'] for row in c.execute('PRAGMA table_info(screamers)')}:
            c.execute("ALTER TABLE screamers ADD COLUMN captions TEXT NOT NULL DEFAULT '[]'")
        c.commit()
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
    if 'original_catalog' not in g:
        g.original_catalog = original_snapshot('catalog')
    if g.original_catalog:
        return dict(items=list(g.original_catalog['items']), cases=g.original_catalog['cases'])
    source = ROOT / 'source_catalog.json'
    if source.exists():
        data = json.loads(source.read_text(encoding='utf-8-sig'))
        validate_catalog(data)
        return apply_case_rarity_weights(data)
    return json.loads(db().execute("SELECT value FROM settings WHERE key='catalog'").fetchone()[0])


HORSEMAN_ID = 600_000_001
RODOMITS_CASE_ID = 600_000_001
RODOMITS_DROPS = (45, 3245, 3243, 42, 41)


def custom_content_enabled():
    return request.headers.get('X-Custom-Content') == '1'


def catalog():
    data = base_catalog()
    session = custom_session()
    if session:
        if session['catalog'] is not None:
            data = json.loads(json.dumps(session['catalog']))
        known = {item['id'] for item in data['items']}
        data['items'].extend(dict(item) for item in session['items'] if item['id'] not in known)
    items = [item for item in data['items'] if item['id'] != HORSEMAN_ID]
    cases = [cs for cs in data['cases'] if cs['id'] < named_cases.CASE_BASE and cs['id'] != RODOMITS_CASE_ID]
    if not custom_content_enabled():
        cases = [dict(cs, items=[drop for drop in cs['items'] if drop['itemId'] != HORSEMAN_ID])
                 for cs in cases if any(drop['itemId'] != HORSEMAN_ID for drop in cs['items'])]
        return dict(items=items, cases=cases)

    horseman = dict(id=HORSEMAN_ID, name='Headless Horseman', price=74500, rarity='og',
                    image='/img/custom/horseman.webp')
    items.append(horseman)
    known = {item['id'] for item in items}
    missing = set(RODOMITS_DROPS) - known
    if missing:
        source = json.loads((ROOT / 'source_catalog.json').read_text(encoding='utf-8-sig'))
        items.extend(item for item in source['items'] if item['id'] in missing)
    rodomits = dict(id=RODOMITS_CASE_ID, name='RODOMITS', price=20000, category='named',
                    description='Именной кейс RODOMITS.',
                    image='/img/custom/rodomits.webp', freeKind=None,
                    items=[dict(itemId=item_id) for item_id in (*RODOMITS_DROPS, HORSEMAN_ID)])
    apply_case_rarity_weights(dict(items=items, cases=[rodomits]))
    return dict(items=items, cases=[*cases, rodomits])


def user():
    return db().execute('SELECT * FROM users WHERE id=?', (g.uid,)).fetchone()


def me():
    u = dict(user())
    return dict(id=u['id'], firstName=u['name'], username=getattr(g,'username',''),
                photoUrl=getattr(g,'photo_url',None), balance=u['balance'], testBalance=u['testBalance'],
                isAdmin=True, isOwner=g.uid == OWNER_UID, isTester=True, isPartner=False, siteMode=site_mode(),
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
    rows = db().execute("""SELECT i.*, w.id AS withdrawal_id FROM inventory i
        LEFT JOIN fake_withdrawals w ON w.inventory_id=i.id AND w.status='queued'
        WHERE i.user_id=? AND (i.status='owned' OR (?=0 AND i.status='withdrawing'))
        ORDER BY i.id DESC LIMIT 2000""", (g.uid, int(owned)))
    items = []
    for row in rows:
        item = json.loads(row['item'])
        if not visible_item(item):
            continue
        entry = dict(id=row['id'], item=item, status=row['status'], test=bool(row['test']),
                     source=row['source'], createdAt=iso(row['created']),
                     withdrawable=row['status'] == 'owned' and not row['test'] and row['source'] != 'pass' and not item.get('coins', False))
        if row['withdrawal_id'] is not None:
            entry['withdraw'] = dict(id=row['withdrawal_id'], status='queued')
        items.append(entry)
    return items


def withdrawal_history():
    rows = db().execute("""SELECT w.id,w.status,w.created,i.item FROM fake_withdrawals w
        JOIN inventory i ON i.id=w.inventory_id WHERE i.user_id=? ORDER BY w.id DESC LIMIT 100""", (g.uid,))
    requests = []
    for row in rows:
        item = json.loads(row['item'])
        if visible_item(item):
            requests.append(dict(id=row['id'], status=row['status'], createdAt=iso(row['created']), item=item))
    return dict(requests=requests, enabled=True)


def start_fake_withdrawal(body):
    nickname = body.get('robloxUsername')
    if not isinstance(nickname, str) or not re.fullmatch(r'[A-Za-z0-9_]{3,20}', nickname.strip()):
        raise Problem('Ник в Roblox: 3–20 символов, латиница, цифры и _')
    items = selected(body)
    if len(items) != 1 or items[0]['item'].get('coins'):
        raise Problem('Выбери один предмет для вывода')
    item = items[0]
    if item['source'] == 'pass':
        raise Problem('Награды Grader Pass нельзя вывести')
    c = db()
    withdrawal = c.execute('INSERT INTO fake_withdrawals(inventory_id,roblox_username,status,created) VALUES (?,?,?,?)',
                           (item['id'], nickname.strip(), 'queued', time.time()))
    consume(items, 'withdrawing')
    return dict(id=withdrawal.lastrowid, status='queued')


def cancel_fake_withdrawal(withdrawal_id):
    c = db()
    row = c.execute("""SELECT w.status,w.inventory_id,i.item FROM fake_withdrawals w
        JOIN inventory i ON i.id=w.inventory_id WHERE w.id=? AND i.user_id=?""",
                    (integer(withdrawal_id), g.uid)).fetchone()
    if not row or not visible_item(json.loads(row['item'])):
        raise Problem('Заявка не найдена', 'not_found', 404)
    if row['status'] == 'queued':
        c.execute("UPDATE fake_withdrawals SET status='cancelled' WHERE id=?", (integer(withdrawal_id),))
        c.execute("UPDATE inventory SET status='owned' WHERE id=? AND user_id=? AND status='withdrawing'",
                  (row['inventory_id'], g.uid))
    return dict(ok=True)


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
    bonus = original_snapshot('bonus')
    if config['mode']=='editor':
        drops=[dict(d,source=dict(kind=d['source']) if isinstance(d.get('source'),str) else d.get('source')) for d in config['drops']]
        top=next((d for d in drops if d['id']==config.get('topId')),None)
        return dict(drops=drops,top=top or max(drops,key=lambda d:d['price'],default=None),bonus=bonus,liveMode='editor')
    if config['mode']!='real':
        return dict(local_home(),liveMode='local',bonus=bonus)
    live = original_snapshot('live')
    if live is None:
        status = original_status('live')
        message = {
            'missing_env': 'Сервер не получил ORIGINAL_INIT_DATA',
            'auth_rejected': 'Оригинал отклонил серверную сессию',
            'network_error': 'Сервер не смог подключиться к оригиналу',
            'invalid_response': 'Оригинал вернул неожиданный формат ленты',
            'loading': 'Загружаем ленту оригинала…',
        }.get(status, 'Лента оригинала пока недоступна')
        return dict(drops=[], top=None, bonus=bonus, liveMode='real',
                    liveError=message)
    return dict(drops=live['drops'], top=live['top'], bonus=bonus, liveMode='real')


def original_drop(drop):
    image = str(drop.get('image', ''))
    rarity = drop.get('rarity')
    source = drop.get('source')
    return dict(
        id='real:' + str(drop.get('id', ''))[:100],
        name=str(drop.get('name', ''))[:120],
        image=image if image.startswith('/img/') else '/img/coin.webp',
        price=number(drop.get('price', 0)),
        rarity=rarity if rarity in ('common', 'rare', 'epic', 'legendary', 'og') else 'common',
        source=source if isinstance(source, (str, dict)) else 'case',
        createdAt=drop.get('createdAt'),
    )


def settle_giveaways():
    for giveaway in db().execute('SELECT * FROM giveaways WHERE finished=0 AND ends<=?',(time.time(),)).fetchall():
        entries=db().execute('SELECT user_id,num FROM giveaway_entries WHERE giveaway_id=?',(giveaway['id'],)).fetchall()
        winner=RNG.choice(entries) if entries else None
        if winner:
            add_item(json.loads(giveaway['item']),'giveaway',uid=winner['user_id'])
        db().execute('UPDATE giveaways SET finished=1,winner_id=?,winner_num=? WHERE id=?',
                     (winner['user_id'] if winner else None,winner['num'] if winner else None,giveaway['id']))


def giveaway_participant_overrides():
    row = db().execute('SELECT value FROM settings WHERE key=?', ('giveaway-count:' + g.uid,)).fetchone()
    return json.loads(row[0]) if row else {}


def giveaway_view(row):
    c=db(); gid=row['id']
    entry=c.execute('SELECT num FROM giveaway_entries WHERE giveaway_id=? AND user_id=?',(gid,g.uid)).fetchone()
    progress=c.execute('SELECT amount FROM giveaway_progress WHERE giveaway_id=? AND user_id=?',(gid,g.uid)).fetchone()
    amount=progress[0] if progress else 0
    winner=None
    if row['winner_id']:
        winner_user=c.execute('SELECT name FROM users WHERE id=?',(row['winner_id'],)).fetchone()
        winner=dict(name=winner_user[0] if winner_user else 'Игрок',num=row['winner_num'],me=row['winner_id']==g.uid)
    override = giveaway_participant_overrides().get(str(gid), {})
    item = json.loads(row['item'])
    participants = None
    if override.get('mode') == 'custom':
        participants = override['count']
    else:
        if 'original_giveaways' not in g:
            g.original_giveaways = original_snapshot('giveaways')
        group = 'finished' if row['finished'] else 'active'
        original = (g.original_giveaways or {}).get(group, [])
        matching = next((entry for entry in original if entry['itemId'] == item['id']), None)
        if matching is None and not row['finished'] and len(original) == 1:
            matching = original[0]
        if matching is not None:
            participants = matching['count']
    return dict(id=gid,item=item,endsAt=iso(row['ends']),needDeposit=row['minimum'],
                deposited=amount,participants=participants,
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
    i = integer(i)
    if i > named_cases.CASE_BASE and custom_content_enabled():
        row = db().execute('SELECT definition FROM named_cases WHERE id=? AND expires>?',
                           (i - named_cases.CASE_BASE, time.time())).fetchone()
        if row:
            return published_case(i - named_cases.CASE_BASE, row['definition'])
    cat = catalog()
    cs = next((x for x in cat['cases'] if x['id']==i), None)
    if not cs:
        raise Problem('Кейс не найден', 'not_found',404)
    pool = {x['id']:x for x in cat['items']}
    return dict(cs, items=[dict(pool[x['itemId']], weight=x['weight'],
                                mutationEligible=can_mutate(pool[x['itemId']])) for x in cs['items']],
                itemsCount=len(cs['items']))


def published_case(row_id, definition):
    data = json.loads(definition)
    data['items'] = [dict(item, mutationEligible=can_mutate(item)) for item in data['items']]
    return dict(data, id=named_cases.CASE_BASE + row_id, category='named', freeKind=None,
                image=f'/img/named/{row_id}.png', itemsCount=len(data['items']))


def config():
    return dict(build=FRONTEND_BUILD,theme='autumn',caseAnim='classic',sandbox=True,depositEnabled=False,withdrawEnabled=True,
                starsRate=1,starsMin=1,starsMax=10000,refBonusPercent=0,withdrawMin=1,withdrawWindow='отключён',
                upgrade=dict(maxItems=5,minChance=UPGRADE_MIN_CHANCE,maxChance=UPGRADE_MAX_CHANCE,presets=[dict(label=f'×{n}',mult=n) for n in [1.25,2,3,5,10]]),
                mystery=dict(enabled=True,mult=3,minInput=1,maxInput=1e9,floor=1,cap=1e9),
                dice=dict(enabled=True,min=1,max=100000,maxItems=5,colors=[dict(id=i,name=n,hex=h) for i,(n,h) in
                    enumerate(zip(['Красный','Оранжевый','Жёлтый','Зелёный','Синий','Фиолетовый'],
                                  ['#ef4444','#f97316','#facc15','#22c55e','#3b82f6','#a855f7']))],
                    table=[dict(hits=h,mult=m) for h,m in enumerate(DICE_PAYOUTS) if h],
                    rainbow=dict(mult=DICE_BONUS_MULTIPLIER)))


def targets(body):
    rows=selected(body)
    if len(rows)>5:
        raise Problem('Можно поставить до 5 предметов')
    value=sum(i['item']['price'] for i in rows)
    input_ids={(i['item']['id'], i['item'].get('mutation')) for i in rows}
    input_prices={round(i['item']['price'],2) for i in rows}
    options = []
    for item in (variant for base in catalog()['items'] for variant in mutation_variants(base)):
        if item.get('coins') or (item['id'], item.get('mutation')) in input_ids or round(item['price'], 2) in input_prices:
            continue
        chance = value / item['price'] * UPGRADE_CHANCE_FACTOR
        if UPGRADE_MIN_CHANCE <= chance <= UPGRADE_MAX_CHANCE:
            # Keep tiny positive chances playable even when the display rounds them to 0%.
            options.append(dict(item, chance=round(chance, 2) or chance))
    options.sort(key=lambda x: (x['price'], x['id']))
    presets=[]
    for n in [1.25,2,3,5,10]:
        desired_chance = min(UPGRADE_MAX_CHANCE, UPGRADE_CHANCE_FACTOR / n)
        target=min(options,key=lambda x:abs(x['chance']-desired_chance)) if options else None
        presets.append(dict(label=f'×{n}',target=target,chance=target['chance'] if target else 0))
    return dict(inputValue=value,targets=options,presets=presets)


def button_modes():
    row = db().execute('SELECT value FROM settings WHERE key=?', ('button-modes:' + g.uid,)).fetchone()
    return json.loads(row[0]) if row else {}


def controlled_side(game, body):
    side = body.get('buttonSide')
    if side in ('left', 'right') and button_modes().get(game) is True:
        return side
    return None


def take_next_result(game):
    row = db().execute('SELECT value FROM next_results WHERE user_id=? AND game=?', (g.uid,game)).fetchone()
    if not row:
        return None
    result=json.loads(row[0])
    if result.get('item') and not visible_item(result['item']):
        return None
    remaining=result.get('remaining',1)-1
    if remaining>0:
        updated=dict(result,remaining=remaining)
        db().execute('UPDATE next_results SET value=? WHERE user_id=? AND game=?',(json.dumps(updated),g.uid,game))
    else:
        db().execute('DELETE FROM next_results WHERE user_id=? AND game=?', (g.uid,game))
    return result


def streak_config():
    row=db().execute('SELECT value FROM settings WHERE key=?',('streak:'+g.uid,)).fetchone()
    return json.loads(row[0]) if row else dict(enabled=True,resetOnMiss=True,rewards=DEFAULT_STREAK,version=STREAK_VERSION)


def configured_streak_reward(cfg,day):
    reward=streak_reward(cfg['rewards'][(day-1)%len(cfg['rewards'])],day)
    if cfg.get('version'): reward['scheduleVersion']=cfg['version']
    return reward


def streak_reward(spec,day):
    if spec['kind']=='coins': return dict(kind='coins',amount=spec['amount'],day=day,need=0)
    cat=catalog()
    if spec['kind']=='item':
        item=next((i for i in cat['items'] if i['id']==spec['itemId'] and not i.get('customSession')),None)
        if not item: return dict(kind='coins',amount=100,day=day,need=0)
        return dict(item,kind='item',item=item,day=day,need=0)
    case=next((c for c in cat['cases'] if c['id']==spec['caseId']),None)
    if not case: return dict(kind='coins',amount=100,day=day,need=0)
    items={i['id']:i for i in cat['items'] if not i.get('customSession')}
    pool=[dict(items[e['itemId']],weight=e['weight']) for e in case['items'] if e['itemId'] in items]
    if not pool: return dict(kind='coins',amount=100,day=day,need=0)
    return dict(kind='case',name=case['name'],image=case['image'],price=case['price'],pool=pool,day=day,need=0)


def streak_view(checkin=False):
    c=db();cfg=streak_config();today=math.floor((time.time()+10800)/86400)
    row=c.execute('SELECT * FROM streak_progress WHERE user_id=?',(g.uid,)).fetchone()
    count=row['count'] if row else 0;best=row['best'] if row else 0;fresh=False;broken=False
    if checkin and cfg['enabled'] and (not row or row['last_day']!=today):
        broken=bool(row and row['last_day'] is not None and today-row['last_day']>1 and cfg['resetOnMiss'])
        count=1 if broken else count+1;best=max(best,count);fresh=True
        c.execute('INSERT OR REPLACE INTO streak_progress VALUES (?,?,?,?)',(g.uid,today,count,best))
        reward=configured_streak_reward(cfg,count)
        c.execute('INSERT INTO streak_rewards VALUES (?,?,?,?,?,0)',(secrets.token_hex(16),g.uid,count,json.dumps(reward),time.time()+86400))
    pending=[]
    for r in c.execute('SELECT * FROM streak_rewards WHERE user_id=? AND claimed=0 AND expires>? ORDER BY rowid',(g.uid,time.time())):
        reward=json.loads(r['reward'])
        if checkin and cfg.get('version') and reward.get('scheduleVersion')!=cfg['version']:
            reward=configured_streak_reward(cfg,r['day'])
            c.execute('UPDATE streak_rewards SET reward=? WHERE id=?',(json.dumps(reward),r['id']))
        reward.pop('pool',None);reward.pop('item',None)
        pending.append(dict(reward,id=r['id'],expiresAt=iso(r['expires']),claimed=False,canClaim=True,deposited=0))
    days=max(len(cfg['rewards']),count+6)
    templates=[streak_reward(spec,0) for spec in cfg['rewards']]
    track=[]
    for day in range(1,days+1):
        reward=dict(templates[(day-1)%len(templates)],day=day)
        reward.pop('pool',None);reward.pop('item',None);track.append(reward)
    return dict(enabled=cfg['enabled'],count=count,best=best,days=days,track=track,pending=pending,fresh=fresh,broken=broken,resetOnMiss=cfg['resetOnMiss'],nextAt=iso((today+1)*86400-10800))


def mines_multiplier(count, opened):
    if not opened:
        return 1.0
    return math.floor(0.99*math.comb(25,opened)/math.comb(25-count,opened)*100)/100


def mines_reward(value):
    pool = (item for base in catalog()['items'] if not base.get('coins')
            for item in mutation_variants(base) if item['price'] <= value)
    item = max(pool, key=lambda i: (i['price'], -i['id']), default=None)
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


REFERRAL_STATS = {
    'bonusPercent': (0, 100), 'percent': (0, 100),
    'preliminary': (-1_000_000_000, 1_000_000_000),
    'refBalance': (-1_000_000_000, 1_000_000_000),
    'earned': (0, 1_000_000_000), 'deposits': (0, 1_000_000_000),
    'dailyDeposits': (0, 1_000_000_000), 'dailyLosses': (0, 1_000_000_000),
}


def referral_profile():
    row = db().execute('SELECT code,stats FROM referral_profiles WHERE user_id=?', (g.uid,)).fetchone()
    stats = {key: 0 for key in REFERRAL_STATS}
    stats.update(count=0, payers=0, friendsDay=0, activeDay=0, link='', isPartner=False)
    if row:
        stats.update(json.loads(row['stats']))
    return dict(stats, code=row['code'] if row else '')


def referral_view():
    profile = referral_profile()
    now = time.time()
    day_start = int((now + 10800) // 86400) * 86400 - 10800
    days = [dict(day=iso(day_start - offset * 86400), joined=0, deposits=0, lost=0)
            for offset in range(13, -1, -1)]
    days[-1].update(joined=profile['friendsDay'], deposits=profile['dailyDeposits'], lost=profile['dailyLosses'])
    return dict(profile, code=profile['code'] or 'SANDBOX', friends=profile['count'], days=days, referrals=[], history=[])

def promo_code(value):
    code = str(value or '').strip().upper()
    if not 3 <= len(code) <= 20 or not code.isascii() or not code.replace('_', '').isalnum():
        raise Problem('Код: 3–20 букв, цифр или _')
    return code


def redeem_promo(value, case_id=None):
    c = db()
    code = promo_code(value)
    row = c.execute('SELECT p.*, o.case_id FROM promos p LEFT JOIN promo_options o USING(code) WHERE p.code=?', (code,)).fetchone()
    if not row or row['uses'] < 1:
        raise Problem('Код не найден или закончился')
    if row['case_id'] != case_id:
        raise Problem('Код предназначен для другого кейса или способа активации')
    if c.execute('SELECT 1 FROM claims WHERE user_id=? AND code=?', (g.uid, code)).fetchone():
        raise Problem('Код уже использован')
    c.execute('INSERT INTO claims VALUES (?,?)', (g.uid, code))
    c.execute('UPDATE promos SET uses=uses-1 WHERE code=?', (code,))
    return row['reward']


def deposit_mode():
    row = db().execute('SELECT value FROM settings WHERE key=?', ('deposit-mode:' + g.uid,)).fetchone()
    return row[0] if row else 'original'


def deposit_preview():
    mode = deposit_mode()
    if mode != 'original':
        return dict(open=mode == 'on', checking=False)
    status = original_snapshot('deposit')
    return dict(open=status is not None and status['open'],
                checking=status is None and original_status('deposit') == 'loading')


def dragon_exchange_config():
    original = original_snapshot('dragon')
    dragon = find_item(original['itemId'] if original else 62)
    if not dragon or dragon.get('coins') or dragon.get('customSession') or dragon['price'] <= 0:
        return None
    return {'dragon': dragon, 'from': max(dragon['price'], original['minimum'] if original else dragon['price'])}


def exchange_dragons(body):
    rows = selected(body)
    cfg = dragon_exchange_config()
    if not cfg or len(rows) != 1:
        raise Problem('Выбери один предмет для размена')
    row = rows[0]
    item = row['item']
    dragon = cfg['dragon']
    if (row['source'] in ('shop', 'pass', 'streak') or item.get('coins') or item.get('customSession') or
            item['rarity'] == 'og' or item['id'] == dragon['id'] or item['price'] < cfg['from']):
        raise Problem('Этот предмет нельзя разменять')
    count, remainder = divmod(round(item['price'] * 100), round(dragon['price'] * 100))
    if not 1 <= count <= 1000:
        raise Problem('Можно получить от 1 до 1000 драконов за раз')
    change = remainder / 100
    consume(rows, 'exchanged')
    for _ in range(count):
        add_item(dragon, 'exchange')
    db().execute('UPDATE users SET balance=balance+? WHERE id=?', (change, g.uid))
    return dict(dragons=count, dragon=dragon, change=change, balance=user()['balance'])


def pass_config():
    row = db().execute('SELECT value FROM settings WHERE key=?', ('pass:' + g.uid,)).fetchone()
    return json.loads(row[0]) if row else dict(rewardsMode='original', tasksMode='original',
                                               levels=[], daily=[], weekly=[], xpOffset=0, progress={})


def pass_track(cfg, original):
    result = grader_pass.view(db(), g.uid, cfg, original, settle=True)
    cases = catalog()['cases']
    for level in result['levels']:
        reward = level['reward']
        if reward['kind'] != 'case':
            continue
        selected_case = next((cs for cs in cases if cs['id'] == reward.get('caseId')), None)
        if not selected_case and 'name' in reward:
            selected_case = next((cs for cs in cases if cs['name'] == reward['name'] or
                                  cs['image'].split('?')[0] == reward.get('image')), None)
        if selected_case and selected_case['items']:
            level['reward'] = dict(reward, caseId=selected_case['id'], name=selected_case['name'],
                                   image=selected_case['image'])
        else:
            level['reward'] = dict(reward, name=reward.get('name', 'Кейс'))
            level.update(canClaim=False, unavailable=True)
    return result


def pass_view():
    result = pass_track(pass_config(), original_snapshot('pass'))
    return dict(result, originalStatus=original_status('pass'))


def admin_pass():
    cfg = pass_config()
    original = original_snapshot('pass')
    return dict(config=cfg, original=original, status=original_status('pass'),
                cases=[dict(id=cs['id'], name=cs['name']) for cs in catalog()['cases']],
                view=grader_pass.view(db(), g.uid, cfg, original))


def save_pass(body):
    cfg = pass_config()
    old = dict(cfg)
    try:
        for field in ('rewardsMode', 'tasksMode'):
            if body[field] not in ('original', 'custom'):
                raise ValueError('Выбери источник')
            cfg[field] = body[field]
        cfg['levels'] = grader_pass.levels(body['levels'])
        for group in grader_pass.QUEST_GROUPS:
            cfg[group] = grader_pass.quests(body[group])
        total_xp = grader_pass.whole(body['xp']) if 'xp' in body else None
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise Problem('Проверь уровни и задания. ' + (str(error) if isinstance(error, ValueError) else 'Неверный формат.')) from error
    case_ids = {cs['id'] for cs in catalog()['cases']}
    if any(row['reward']['kind'] == 'case' and row['reward']['caseId'] not in case_ids for row in cfg['levels']):
        raise Problem('Кейс награды отсутствует в каталоге')
    original = original_snapshot('pass')
    current = grader_pass.view(db(), g.uid, cfg, original)
    active_periods = {current[group]['period'] for group in grader_pass.QUEST_GROUPS if current[group]}
    cfg['progress'] = {period: values.copy() for period, values in cfg['progress'].items() if period in active_periods}
    edits = body.get('progress', {})
    if not isinstance(edits, dict):
        raise Problem('Неверный прогресс заданий')
    for group in grader_pass.QUEST_GROUPS:
        values = edits.get(group)
        if values is None:
            continue
        entry = current[group]
        if (not isinstance(values, dict) or not entry or cfg['tasksMode'] != old['tasksMode'] or
                values.get('period') != entry['period'] or
                not isinstance(values.get('counts'), dict)):
            raise Problem('Задания обновились. Открой вкладку пасса заново.', 'pass_tasks_changed', 409)
        changes = values['counts']
        for quest in entry['quests']:
            if quest['id'] in changes:
                key = cfg['tasksMode'] + ':' + quest['id']
                counts = cfg['progress'].setdefault(entry['period'], {})
                try:
                    if changes[quest['id']] is None:
                        counts.pop(key, None)
                    else:
                        counts[key] = grader_pass.whole(changes[quest['id']], 0, quest['goal'])
                except ValueError as error:
                    raise Problem('Прогресс задания вне допустимого диапазона') from error
    grader_pass.view(db(), g.uid, cfg, original, settle=True)
    if total_xp is not None:
        cfg['xpOffset'] = total_xp - grader_pass.view(db(), g.uid, dict(cfg, xpOffset=0), original)['xp']
    db().execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('pass:' + g.uid, json.dumps(cfg)))
    return admin_pass()


def record_pass_play(game, value, plays=1, wins=0):
    db().execute('INSERT INTO pass_events VALUES (?,?,?,?,?,?)',
                 (g.uid, game, time.time(), round(value * 100), plays, wins))
    cfg = pass_config()
    original = original_snapshot('pass')
    if cfg['tasksMode'] == 'custom' or original:
        grader_pass.view(db(), g.uid, cfg, original, settle=True)


def claim_pass(body):
    level = integer(body.get('level'), 1, 100)
    row = next((row for row in pass_view()['levels'] if row['level'] == level), None)
    if not row or not row['canClaim']:
        raise Problem('Эту награду сейчас нельзя забрать', 'pass_reward_unavailable', 409)
    reward = row['reward']
    got = []
    case_info = None
    if reward['kind'] == 'coins':
        got.append(dict(kind='coins', amount=reward['amount']))
    else:
        cs = case(reward['caseId'])
        if not cs['items']:
            raise Problem('В наградном кейсе нет предметов')
        case_info = dict(name=cs['name'])
        for drop in RNG.choices(cs['items'], weights=[item['weight'] for item in cs['items']], k=reward['count']):
            item = roll_mutation({key: value for key, value in drop.items() if key != 'weight'})
            if item.get('coins'):
                got.append(dict(kind='coins', amount=item['price']))
            else:
                got.append(dict(kind='item', item=item, inventoryId=add_item(item, 'pass')))
    total = sum(entry['amount'] for entry in got if entry['kind'] == 'coins')
    db().execute('UPDATE users SET balance=balance+? WHERE id=?', (total, g.uid))
    db().execute('INSERT INTO pass_claims VALUES (?,?,?)', (g.uid, level, reward['badge']))
    return dict(level=level, got=got, case=case_info, badge=reward['badge'], balance=user()['balance'])


def dispatch(path, body):
    c=db()
    parts=path.split('/')
    post=request.method=='POST'
    if post and path in ('admin/balance','admin/grant','admin/giveaway-progress'):
        if 'userId' in body and str(body['userId'])!=g.uid:
            raise Problem('Это действие доступно только для своего аккаунта', 'forbidden',403)
    if path == 'deposit/current' and not post:
        return deposit_preview()
    if path == 'withdraw':
        return start_fake_withdrawal(body) if post else withdrawal_history()
    if post and len(parts) == 3 and parts[0] == 'withdraw' and parts[2] == 'cancel':
        return cancel_fake_withdrawal(parts[1])
    # Payment and other withdrawal routes stay disabled.
    if path.startswith('deposit') or (path.startswith('withdraw') and post):
        raise Problem('Пополнение и вывод отключены. Баланс можно изменить в общей админке.', 'payments_disabled',403)
    if path == 'me':
        if not post:
            record_pass_play('visit', 0)
        return me()
    if path=='config':
        return dict(config(), dragonExchange=dragon_exchange_config(), **{'pass': {'enabled': True}})
    if path == 'pass' and not post:
        return pass_view()
    if path == 'pass/claim' and post:
        return claim_pass(body)
    if path == 'admin/pass':
        return save_pass(body) if post else admin_pass()
    if path=='mines/current' and not post:
        row=mines_current()
        return dict(game=mines_view(row) if row else None)
    if path=='mines/start' and post:
        if not custom_content_enabled():
            raise Problem('Включи кастомный контент в настройках', 'custom_content_disabled', 403)
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
    if path=='cases' and not post:
        cases = [case(x['id']) for x in catalog()['cases']]
        if custom_content_enabled():
            cases.extend(published_case(row['id'], row['definition']) for row in c.execute(
                'SELECT id,definition FROM named_cases WHERE expires>? ORDER BY id', (time.time(),)))
        return cases
    if path.startswith('cases/') and len(parts)==2 and not post: return case(parts[1])
    if path.startswith('cases/') and path.endswith('/free') and not post:
        cs=case(parts[1]); r=c.execute('SELECT until FROM cooldown WHERE user_id=? AND case_id=?',(g.uid,cs['id'])).fetchone()
        return dict(ok=not r or r[0]<=time.time(),nextAt=iso(r[0]) if r and r[0]>time.time() else None,hours=24)
    if post and ((path.startswith('cases/') and path.endswith('/open')) or path.startswith('test/open/')):
        test=path.startswith('test/')
        cs=case(parts[2] if test else parts[1]); n=integer(body.get('count',1),1,5)
        if n not in [1,3,5]: raise Problem('Количество: 1, 3 или 5')
        promo = body.get('promo')
        if promo:
            if test or cs.get('freeKind'):
                raise Problem('Промокод доступен для платного кейса')
            redeem_promo(promo, cs['id'])
            n = 1
        elif 'expectedPrice' in body and number(body['expectedPrice']) != cs['price']:
            raise Problem('Цена кейса обновилась. Открой его заново.', 'case_price_changed', 409)
        if cs.get('freeKind') and not test:
            n=1
            r=c.execute('SELECT until FROM cooldown WHERE user_id=? AND case_id=?',(g.uid,cs['id'])).fetchone()
            if r and r[0]>time.time(): raise Problem('Бесплатный кейс доступен раз в сутки')
            c.execute('INSERT OR REPLACE INTO cooldown VALUES (?,?,?)',(g.uid,cs['id'],time.time()+86400))
        field='testBalance' if test else 'balance'; cost=0 if promo else cs['price']*n
        if user()[field]<cost: raise Problem('Недостаточно BG. Добавь баланс в админке.', 'insufficient_balance')
        c.execute(f'UPDATE users SET {field}={field}-?, cases=cases+? WHERE id=?',(cost,0 if test else n,g.uid))
        side = controlled_side('case', body)
        forced_item = None
        if side:
            choose = max if side == 'right' else min
            forced_item = choose(cs['items'], key=lambda item: item['price'])
        rig = None if test or side else take_next_result('case')
        drops=[]
        for index in range(n):
            if forced_item is not None:
                item = dict(forced_item)
            elif rig and index == 0:
                item = dict(rig['item'])
            else:
                item = dict(RNG.choices(cs['items'], weights=[x['weight'] for x in cs['items']])[0])
            item.pop('weight',None)
            item = roll_mutation(item)
            if item.get('coins'):
                c.execute(f'UPDATE users SET {field}={field}+? WHERE id=?', (item['price'], g.uid))
                drops.append(dict(item=item))
            else:
                iid = add_item(item, dict(kind='case', caseId=cs['id'], caseName=cs['name'], caseImage=cs['image']), test)
                drops.append(dict(item=item, inventoryId=iid))
        if not test and not promo and not cs.get('freeKind') and cost > 0:
            record_pass_play('case', cost, n)
        return dict(drops=drops,balance=user()['balance'],testBalance=user()['testBalance'],test=test)
    if path == 'inventory/exchange-dragons' and post:
        return exchange_dragons(body)
    if post and path in ('inventory/sell','inventory/sell-all','test/sell'):
        test=path=='test/sell'
        rows=[i for i in inventory(True) if i['test']==test] if path.endswith('sell-all') or (test and not body.get('ids')) else selected(body,True)
        if any(i['test']!=test for i in rows): raise Problem('Тестовые предметы продаются отдельно')
        total=sum(i['item']['price'] for i in rows); consume(rows,'sold')
        field='testBalance' if test else 'balance'
        c.execute(f'UPDATE users SET {field}={field}+? WHERE id=?',(total,g.uid))
        return dict(total=total,balance=user()['balance'],testBalance=user()['testBalance'],test=test)
    if path=='shop' and not post:
        items = [dict(item, mutations=list(MUTATIONS) if can_mutate(item) else [])
                 for item in catalog()['items'] if not item.get('coins')]
        return dict(enabled=True, items=sorted(items, key=lambda item: (item['price'], item['id'])))
    if path=='shop/buy' and post:
        it=find_item(body.get('itemId'))
        if not it or it.get('coins'): raise Problem('Предмет не найден')
        mutation = body.get('mutation')
        if mutation is not None:
            if not isinstance(mutation, str) or mutation not in MUTATIONS or not can_mutate(it):
                raise Problem('Эта мутация недоступна')
            it = mutated(it, mutation)
        if user()['balance']<it['price']: raise Problem('Недостаточно BG')
        c.execute('UPDATE users SET balance=balance-? WHERE id=?',(it['price'],g.uid))
        return dict(item=it,inventoryId=add_item(it,'shop'),balance=user()['balance'])
    if path=='upgrade/targets' and post: return targets(body)
    if path=='upgrade' and post:
        options = targets(body)
        target_id = integer(body.get('targetId'))
        target = next((x for x in options['targets']
                       if x['id'] == target_id and x.get('mutation') == body.get('mutation')), None)
        if not target: raise Problem('Недопустимая цель')
        rows=selected(body)
        side = controlled_side('upgrade', body)
        rig = None if side else take_next_result('upgrade')
        if rig and rig.get('item'):
            target=dict(rig['item'],chance=target['chance'])
        chance=target['chance']
        roll=RNG.random()*100
        if side or rig:
            force_win = side == 'right' if side else rig['mode'] != 'lose'
            roll = RNG.random()*chance if force_win else chance+RNG.random()*(100-chance)
        won=roll<chance
        consume(rows,'upgraded')
        c.execute('UPDATE users SET upgrades=upgrades+1 WHERE id=?',(g.uid,))
        record_pass_play('upgrade', sum(row['item']['price'] for row in rows), wins=int(won))
        return dict(won=won,chance=target['chance'],roll=roll,target=target,inventoryIds=[add_item(target,'upgrade')] if won else [])
    if path in ('mystery/info','mystery') and post:
        row=selected(body)[0]; value=row['item']['price']; pool=[x for x in catalog()['items'] if not x.get('coins') and value/3<=x['price']<=value*3]
        if path.endswith('info'): return dict(ok=bool(pool),min=value/3,max=value*3,items=pool,reason='Нет подходящих предметов')
        if not pool: raise Problem('Нет подходящих предметов')
        rig=take_next_result('mystery')
        it=rig['item'] if rig else RNG.choice(pool)
        consume([row],'mystery')
        record_pass_play('mystery', value)
        return dict(item=it,inventoryId=add_item(it,'mystery'),shuffle=[x['image'] for x in pool]+[it['image']],balance=user()['balance'])
    if path=='dice/my' and not post:
        return [json.loads(r[0]) for r in c.execute("SELECT payload FROM history WHERE user_id=? AND kind='dice' ORDER BY id DESC LIMIT 20",(g.uid,))]
    if path=='dice' and post:
        rows=selected(body); color=integer(body.get('color'),0,5); value=sum(i['item']['price'] for i in rows)
        if len(rows) > 5 or not 1 <= value <= 100000 or any(row['item'].get('coins') for row in rows):
            raise Problem('Ставка: до 5 брейнротов на сумму от 1 до 100000 BG')
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
        hits = dice.count(color)
        mult = DICE_BONUS_MULTIPLIER if bonus else DICE_PAYOUTS[hits]
        won=[]
        winnings=0
        if not mult: consume(rows,'dice')
        else:
            for row in rows:
                prize=rig['item'] if rig and rig.get('item') else row['item']
                won.extend(add_item(prize,'dice') for _ in range(mult-1))
                winnings+=prize['price']*(mult-1)
        record_pass_play('dice', value, wins=int(bool(mult)))
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
        num = c.execute('SELECT COALESCE(MAX(num),0)+1 FROM giveaway_entries WHERE giveaway_id=?', (row['id'],)).fetchone()[0]
        c.execute('INSERT INTO giveaway_entries VALUES (?,?,?)',(row['id'],g.uid,num))
        return dict(num=num)
    if path=='streak/checkin' and post: return streak_view(True)
    if path=='streak/claim' and post:
        if not streak_config()['enabled']: raise Problem('Серия заходов выключена')
        row=c.execute('SELECT * FROM streak_rewards WHERE id=? AND user_id=?',(str(body.get('id','')),g.uid)).fetchone()
        if not row or row['claimed'] or row['expires']<=time.time(): raise Problem('Награда уже получена или истекла')
        reward=json.loads(row['reward']);cfg=streak_config()
        if cfg.get('version') and reward.get('scheduleVersion')!=cfg['version']:
            reward=configured_streak_reward(cfg,row['day'])
        c.execute('UPDATE streak_rewards SET claimed=1 WHERE id=?',(row['id'],))
        if reward['kind']=='coins':
            c.execute('UPDATE users SET balance=balance+? WHERE id=?',(reward['amount'],g.uid))
            return dict(kind='coins',amount=reward['amount'],balance=user()['balance'])
        item=reward.get('item')
        if reward['kind']=='case':
            item = roll_mutation(RNG.choices(reward['pool'], weights=[i['weight'] for i in reward['pool']])[0])
        if item.get('coins'):
            c.execute('UPDATE users SET balance=balance+? WHERE id=?', (item['price'], g.uid))
            return dict(kind='coins', amount=item['price'], balance=user()['balance'], fromCase=reward['kind']=='case')
        item={k:v for k,v in item.items() if k!='weight'}
        return dict(kind='item',item=item,inventoryId=add_item(item,'streak'),balance=user()['balance'],fromCase=reward['kind']=='case')
    if path=='admin/streak' and not post: return dict(config=streak_config(),progress=streak_view())
    if path=='admin/streak/reset' and post:
        c.execute('DELETE FROM settings WHERE key=?',('streak:'+g.uid,))
        return dict(ok=True)
    if path=='admin/streak' and post:
        specs=body.get('rewards')
        if not isinstance(specs,list) or not 1<=len(specs)<=60: raise Problem('Нужно от 1 до 60 дней наград')
        rewards=[];cat=catalog()
        for spec in specs:
            if not isinstance(spec,dict): raise Problem('Неверная награда')
            kind=spec.get('kind')
            if kind=='coins': rewards.append(dict(kind=kind,amount=number(spec.get('amount'),1)))
            elif kind=='item':
                item=find_item(spec.get('itemId'))
                if not item or item.get('customSession'): raise Problem('Выбери обычного брейнрота')
                rewards.append(dict(kind=kind,itemId=item['id']))
            elif kind=='case':
                cid=integer(spec.get('caseId'))
                if not any(cs['id']==cid for cs in cat['cases']): raise Problem('Кейс не найден')
                rewards.append(dict(kind=kind,caseId=cid))
            else: raise Problem('Выбери тип награды')
        cfg=dict(enabled=body.get('enabled') is True,resetOnMiss=body.get('resetOnMiss') is True,rewards=rewards)
        c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)',('streak:'+g.uid,json.dumps(cfg)))
        return dict(ok=True)
    if path=='admin/streak/progress' and post:
        count=integer(body.get('count',0),0,10000)
        old=c.execute('SELECT best FROM streak_progress WHERE user_id=?',(g.uid,)).fetchone()
        today=math.floor((time.time()+10800)/86400)
        c.execute('INSERT OR REPLACE INTO streak_progress VALUES (?,?,?,?)',(g.uid,today if count else None,count,max(count,old[0] if old else 0)))
        c.execute('DELETE FROM streak_rewards WHERE user_id=? AND claimed=0',(g.uid,))
        return dict(ok=True)
    if path=='referrals' and not post:
        return referral_view()
    if path=='admin/referrals' and post:
        code = promo_code(body.get('code'))
        link = str(body.get('link', '')).strip()
        if link and (not link.startswith('https://') or len(link) > 500):
            raise Problem('Ссылка должна начинаться с https://')
        stats = {key: number(body.get(key, 0), *bounds) for key, bounds in REFERRAL_STATS.items()}
        stats.update(count=integer(body.get('count', 0), 0, 1_000_000),
                     payers=integer(body.get('payers', 0), 0, 1_000_000),
                     friendsDay=integer(body.get('friendsDay', 0), 0, 1_000_000),
                     activeDay=integer(body.get('activeDay', 0), 0, 1_000_000),
                     link=link,
                     isPartner=body.get('isPartner') is True)
        c.execute('INSERT OR REPLACE INTO referral_profiles VALUES (?,?,?)', (g.uid, code, json.dumps(stats)))
        return dict(ok=True)
    if path=='partner' and not post:
        result = referral_view()
        if not result['isPartner']:
            raise Problem('Режим партнёра выключен', 'not_partner', 403)
        return result
    if path=='promos' or (path.startswith('promos/') and path.endswith('/delete') and post):
        if not referral_profile()['isPartner']:
            raise Problem('Режим партнёра выключен', 'not_partner', 403)
        if not post:
            rows = c.execute('SELECT p.*, o.max_uses FROM promos p JOIN promo_options o USING(code) WHERE o.partner_id=?', (g.uid,))
            return dict(limits=dict(maxUses=10000, minReward=1, maxReward=1_000_000), promos=[
                dict(id=r['code'], code=r['code'], reward=r['reward'], maxUses=r['max_uses'],
                     uses=r['max_uses']-r['uses'], status='active' if r['uses'] else 'used_up') for r in rows
            ])
        if path=='promos':
            code = promo_code(body.get('code'))
            if len(code) < 5 or not code.isalnum():
                raise Problem('Промокод: 5–20 латинских букв или цифр')
            if c.execute('SELECT 1 FROM promos WHERE code=?', (code,)).fetchone():
                raise Problem('Такой код уже существует')
            uses = integer(body.get('uses'), 1, 10000)
            reward = number(body.get('reward'), 1, 1_000_000)
            c.execute('INSERT INTO promos VALUES (?,?,?)', (code, reward, uses))
            c.execute('INSERT INTO promo_options VALUES (?,NULL,?,?)', (code, g.uid, uses))
            return dict(promo=dict(code=code), balance=user()['balance'])
        code = promo_code(parts[1])
        row = c.execute('SELECT p.* FROM promos p JOIN promo_options o USING(code) WHERE p.code=? AND o.partner_id=?', (code, g.uid)).fetchone()
        if not row:
            raise Problem('Промокод не найден', 'not_found', 404)
        c.execute('UPDATE promos SET uses=0 WHERE code=?', (code,))
        c.execute('DELETE FROM promo_options WHERE code=?', (code,))
        return dict(balance=user()['balance'])
    if path=='promo' and post:
        reward = redeem_promo(body.get('code'))
        c.execute('UPDATE users SET balance=balance+? WHERE id=?',(reward,g.uid))
        return dict(type='coins',kind='coins',reward=reward,balance=user()['balance'])
    if path=='admin/state' and not post:
        promos = c.execute('SELECT p.*, o.case_id AS caseId FROM promos p LEFT JOIN promo_options o USING(code)')
        result=dict(me=me(),promos=[dict(r) for r in promos],nextResults={},live=live_settings(),referralProfile=referral_profile())
        result['giveaways'] = [dict(id=row['id'], name=json.loads(row['item'])['name'])
                              for row in c.execute('SELECT id,item FROM giveaways ORDER BY id DESC')]
        result['giveawayParticipantOverrides'] = giveaway_participant_overrides()
        result['buttonModes'] = button_modes()
        result['depositMode'] = deposit_mode()
        if request.args.get('catalog','1')!='0':
            result['catalog']=catalog()
        for r in c.execute('SELECT game,value FROM next_results WHERE user_id=?',(g.uid,)):
            value=json.loads(r['value'])
            if not value.get('item') or visible_item(value['item']):
                result['nextResults'][r['game']]=value
        return result
    if path=='admin/deposit-mode' and post:
        mode = body.get('mode')
        if mode not in ('original', 'on', 'off'):
            raise Problem('Выбери режим пополнения брейнротами')
        c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('deposit-mode:' + g.uid, mode))
        return dict(ok=True)
    if path=='admin/button-modes' and post:
        game, enabled = body.get('game'), body.get('enabled')
        if game not in ('case', 'upgrade') or type(enabled) is not bool:
            raise Problem('Выбери игру и режим кнопки')
        modes = button_modes()
        modes[game] = enabled
        c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('button-modes:' + g.uid, json.dumps(modes)))
        return dict(ok=True)
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
            if item.get('coins') and game != 'case':
                raise Problem('Монеты можно назначить только дропом кейса')
        value=dict(mode=mode,item=item)
        if game=='dice':
            value['hits']=0 if mode in ('lose','bonus') else integer(body.get('hits',1),1,4)
            if mode not in ('lose','bonus') and value['hits'] not in (1,4):
                raise Problem('Выигрыш: 1 или 4 совпадения')
        count=integer(body.get('count',1),1,1000)
        previous=c.execute('SELECT value FROM next_results WHERE user_id=? AND game=?',(g.uid,game)).fetchone()
        if previous:
            existing=json.loads(previous[0])
            if {k:v for k,v in existing.items() if k!='remaining'}==value:
                count+=existing.get('remaining',1)
        if count>1000: raise Problem('Можно назначить максимум 1000 повторов; сначала отмени текущий Rig')
        value['remaining']=count
        c.execute('INSERT OR REPLACE INTO next_results VALUES (?,?,?)',(g.uid,game,json.dumps(value)))
        return dict(ok=True)
    if path=='admin/giveaway-participants' and post:
        gid = integer(body.get('giveawayId'))
        if not c.execute('SELECT 1 FROM giveaways WHERE id=?', (gid,)).fetchone():
            raise Problem('Розыгрыш не найден')
        overrides = giveaway_participant_overrides()
        mode = body.get('mode')
        if mode not in ('real', 'custom'):
            raise Problem('Выбери реальный или свой счётчик')
        count = overrides.get(str(gid), {}).get('count', 0)
        if mode == 'custom':
            count = integer(body.get('count'), 0, 1_000_000)
        overrides[str(gid)] = dict(mode=mode, count=count)
        c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', ('giveaway-count:' + g.uid, json.dumps(overrides)))
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
        if isinstance(body.get('cases'), list):
            for cs in body['cases']:
                if isinstance(cs, dict) and cs.get('id') == RODOMITS_CASE_ID:
                    cs['category'] = 'standard'
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
        code = promo_code(body.get('code'))
        if c.execute('SELECT 1 FROM promos WHERE code=?',(code,)).fetchone(): raise Problem('Такой код уже существует')
        target = case(body['caseId']) if body.get('caseId') is not None else None
        if target and target.get('freeKind'):
            raise Problem('Выбери платный кейс')
        reward = 0 if target else number(body.get('reward'), 1)
        c.execute('INSERT INTO promos VALUES (?,?,?)', (code, reward, integer(body.get('uses'), 1, 10000)))
        if target:
            c.execute('INSERT INTO promo_options(code,case_id) VALUES (?,?)', (code, target['id']))
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


@app.get('/api/welcome')
def welcome_status():
    if not g.uid.startswith('tg:'):
        return jsonify(show=True)

    from telegram_bot import TelegramError, is_channel_subscriber

    try:
        subscribed = is_channel_subscriber(os.environ['BOT_TOKEN'].strip(), int(g.uid[3:]))
    except TelegramError:
        return jsonify(show=False)
    c = db()
    with c:
        c.execute('INSERT OR REPLACE INTO channel_checks VALUES (?,?,?)',
                  (g.uid, int(subscribed), time.time()))
    return jsonify(show=not subscribed)


def require_owner():
    if g.uid != OWNER_UID:
        raise Problem('Доступ только владельцу', 'forbidden', 403)


@app.route('/api/owner/reminders', methods=['GET', 'POST'])
def owner_reminders():
    require_owner()
    c = db()
    if request.method == 'POST':
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get('player'), str):
            raise Problem('Укажи @username или Telegram ID')
        player = body['player'].strip().removeprefix('@').lower()
        if re.fullmatch(r'[0-9]{1,16}', player):
            uid = 'tg:' + player
            if not c.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone():
                raise Problem('Этот игрок ещё не заходил в Modded', status=404)
        else:
            rows = c.execute("""SELECT user_id FROM site_presence
                WHERE user_id GLOB 'tg:*' AND lower(username)=? AND username<>'' LIMIT 2""",
                (player,)).fetchall()
            if len(rows) != 1:
                raise Problem('Игрок не найден по нику. Попробуй Telegram ID', status=404)
            uid = rows[0]['user_id']
        enter, leave = body.get('enter'), body.get('leave')
        if type(enter) is not bool or type(leave) is not bool:
            raise Problem('Выбери события для уведомлений')
        c.execute('BEGIN IMMEDIATE')
        with c:
            if enter or leave:
                online = c.execute('SELECT 1 FROM site_presence WHERE user_id=? AND seen>?',
                                   (uid, time.time() - ONLINE_TTL)).fetchone() is not None
                c.execute('''INSERT INTO presence_reminders VALUES (?,?,?,?)
                    ON CONFLICT(user_id) DO UPDATE SET on_enter=excluded.on_enter,on_leave=excluded.on_leave''',
                          (uid, enter, leave, online))
            else:
                c.execute('DELETE FROM presence_reminders WHERE user_id=?', (uid,))
    rows = c.execute("""SELECT r.user_id AS id,u.name,COALESCE(p.username,'') AS username,
        r.on_enter AS enter,r.on_leave AS leave,COALESCE(p.seen>?,0) AS online
        FROM presence_reminders r JOIN users u ON u.id=r.user_id
        LEFT JOIN site_presence p ON p.user_id=r.user_id ORDER BY u.name,r.user_id""",
                     (time.time() - ONLINE_TTL,))
    return jsonify(players=[dict(row) for row in rows])


@app.get('/api/owner/stats')
def owner_stats():
    require_owner()
    c = db()
    now = time.time()
    players = c.execute("""SELECT COUNT(*) AS players, COALESCE(SUM(cases),0) AS cases,
        COALESCE(SUM(upgrades),0) AS upgrades FROM users WHERE id GLOB 'tg:*'""").fetchone()
    checks, subs = c.execute('SELECT COUNT(*), COALESCE(SUM(subscribed),0) FROM channel_checks').fetchone()
    online = c.execute("SELECT COUNT(*) FROM site_presence WHERE user_id GLOB 'tg:*' AND seen>?",
                       (now - ONLINE_TTL,)).fetchone()[0]
    active = c.execute("SELECT COUNT(*) FROM site_presence WHERE user_id GLOB 'tg:*' AND seen>?",
                       (now - 86400,)).fetchone()[0]
    average, daytime_average = c.execute("""SELECT AVG(players),
        AVG(CASE WHEN (minute + 180) % 1440 >= 540 AND (minute + 180) % 1440 < 1260 THEN players END)
        FROM online_samples WHERE minute>?""", (int(now // 60) - 1440,)).fetchone()
    from telegram_bot import CHANNEL_USERNAME, TelegramError, call
    members = None
    token = os.getenv('BOT_TOKEN', '').strip()
    if token:
        try:
            members = call(token, 'getChatMemberCount', {'chat_id': CHANNEL_USERNAME}, timeout=3)
        except TelegramError:
            pass
    scan_row = c.execute("SELECT value FROM settings WHERE key='channel-scan-issue'").fetchone()
    scan_issue = json.loads(scan_row[0]) if scan_row else None
    return jsonify(**dict(players), checked=checks, subscribed=subs, online=online, active24h=active,
                   scanIssue=scan_issue,
                   channelMembers=members, channel=CHANNEL_USERNAME,
                   averageOnline=average, daytimeOnline=daytime_average,
                   percent=round(100 * subs / players['players'], 2) if players['players'] else None)


DROP_SOURCES = ('case', 'upgrade', 'mystery', 'dice', 'mines', 'streak', 'pass', 'giveaway')


@app.get('/api/owner/drop-options')
def owner_drop_options():
    require_owner()
    c = db()
    items = [r[0] for r in c.execute("""SELECT DISTINCT json_extract(item,'$.name') AS name
        FROM inventory WHERE test=0 AND name IS NOT NULL ORDER BY name COLLATE NOCASE""")]
    companion_items = sorted(set(items) | {item['name'] for item in base_catalog()['items']
                                           if item.get('coins')}, key=str.casefold)
    cases = [r[0] for r in c.execute("""SELECT DISTINCT json_extract(source,'$.caseName') AS name
        FROM live_drops WHERE name IS NOT NULL ORDER BY name COLLATE NOCASE""")]
    players = [dict(r) for r in c.execute("""SELECT u.id,u.name,COALESCE(p.username,'') AS username
        FROM users u LEFT JOIN site_presence p ON p.user_id=u.id
        WHERE u.id GLOB 'tg:*' ORDER BY u.name COLLATE NOCASE""")]
    return jsonify(items=items, companionItems=companion_items, cases=cases, players=players)


def drop_batch(c, row):
    batch = c.execute("""SELECT json_extract(h.payload,'$.drops') FROM history h
        JOIN json_each(h.payload,'$.drops') d
        WHERE h.user_id=? AND h.created>=? AND h.created<=? AND h.kind GLOB 'cases/*/open'
        AND json_extract(d.value,'$.inventoryId')=? LIMIT 1""",
        (row['id'], row['created'], row['created'] + 60, row['inventory_id'])).fetchone()
    if not batch:
        return None, []
    drops = json.loads(batch[0])
    return len(drops), [drop['item']['name'] for drop in drops if drop.get('inventoryId') != row['inventory_id']]


@app.get('/api/owner/drops')
def owner_drops():
    require_owner()
    name = request.args.get('item', '').strip()
    source = request.args.get('source', '')
    case_name = request.args.get('case', '').strip().casefold()
    player = request.args.get('player', '').strip().casefold().removeprefix('@')
    mutation = request.args.get('mutation', '')
    clock = request.args.get('time', '')
    count = request.args.get('count', '')
    companions = [name.strip().casefold() for name in request.args.getlist('companion') if name.strip()]
    if count not in ('', '1', '3', '5') or len(companions) > 4 or any(len(n) > 100 for n in companions):
        raise Problem('Проверь параметры крутки')
    if (not 1 <= len(name) <= 100 or source not in ('', *DROP_SOURCES)
            or len(case_name) > 100 or len(player) > 100 or mutation not in ('', 'default', *MUTATIONS)):
        raise Problem('Укажи название предмета и способ получения')
    try:
        day = datetime.strptime(request.args.get('date', ''), '%Y-%m-%d').replace(
            tzinfo=timezone(timedelta(hours=3)))
        days = integer(request.args.get('days', '1'), 0, 7)
        start = (day - timedelta(days=days)).timestamp()
        end = (day + timedelta(days=days + 1)).timestamp()
        if clock:
            slots = datetime.strptime(clock, '%H:%M')
            target_minute = slots.hour * 60 + slots.minute
    except (ValueError, OverflowError):
        raise Problem('Укажи дату поиска') from None
    sources = (source,) if source else DROP_SOURCES
    placeholders = ','.join('?' for _ in sources)
    rows = db().execute(f"""SELECT i.user_id AS id,u.name,COALESCE(p.username,'') AS username,
            i.id AS inventory_id,i.item,i.source,i.created,json_extract(d.source,'$.caseName') AS case_name
        FROM inventory i JOIN users u ON u.id=i.user_id
        LEFT JOIN site_presence p ON p.user_id=i.user_id
        LEFT JOIN live_drops d ON d.inventory_id=i.id
        WHERE i.test=0 AND i.created>=? AND i.created<?
          AND i.source IN ({placeholders})
        ORDER BY i.created DESC, i.id DESC""", (start, end, *sources))
    matches = []
    needle = name.casefold()
    for row in rows:
        item = json.loads(row['item'])
        if case_name and case_name != (row['case_name'] or '').casefold():
            continue
        if player and player not in (row['username'].casefold(), row['name'].casefold(), row['id'].removeprefix('tg:')):
            continue
        if mutation and mutation != (item.get('mutation') or 'default'):
            continue
        if clock:
            actual = (int(row['created'] // 60) + 180) % 1440
            if abs((actual - target_minute + 720) % 1440 - 720) > 30:
                continue
        if needle == item['name'].casefold():
            opened, siblings = drop_batch(db(), row) if row['source'] == 'case' else (None, [])
            remaining = [sibling.casefold() for sibling in siblings]
            if count and opened != int(count):
                continue
            for companion in companions:
                if companion not in remaining:
                    break
                remaining.remove(companion)
            else:
                remaining = None
            if remaining is not None:
                continue
            streak = db().execute("""SELECT json_extract(payload,'$.count') FROM history
                WHERE kind='streak/checkin' AND user_id=? AND created<=?
                ORDER BY created DESC,id DESC LIMIT 1""", (row['id'], row['created'])).fetchone()
            matches.append(dict(id=row['id'], name=row['name'], username=row['username'],
                                item=item['name'], mutation=item.get('mutation'), source=row['source'],
                                createdAt=iso(row['created']), caseName=row['case_name'],
                                streakDays=streak[0] if streak else None,
                                opened=opened, companionDrops=siblings))
            if len(matches) == 51:
                break
    return jsonify(matches=matches[:50], more=len(matches) > 50)


def site_mode():
    return 'maintenance' if db().execute(
        "SELECT 1 FROM settings WHERE key='site-maintenance' AND value='1'"
    ).fetchone() else 'open'


@app.before_request
def enforce_maintenance():
    if request.path.startswith('/api/') and g.uid != OWNER_UID and site_mode() == 'maintenance':
        return jsonify(error='site_closed', mode='maintenance', message='Сайт закрыт на обновление'), 503


@app.post('/api/owner/maintenance')
def owner_maintenance():
    require_owner()
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or type(body.get('enabled')) is not bool:
        raise Problem('Укажи состояние режима обновления')
    c = db()
    with c:
        c.execute("INSERT OR REPLACE INTO settings VALUES ('site-maintenance', ?)",
                  ('1' if body['enabled'] else '0',))
    return jsonify(mode=site_mode())


@app.post('/api/presence')
def site_presence():
    c = db()
    now = time.time()
    body = request.get_json(silent=True) or {}
    active_id = body.get('activeVideoId') if isinstance(body, dict) else None
    active = False
    with c:
        c.execute('''INSERT INTO site_presence VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, seen=excluded.seen''',
                  (g.uid, g.username, now))
        delivery = c.execute('''UPDATE screamers SET delivered=1
            WHERE target=? AND expires>? AND delivered=0 RETURNING id,captions''', (g.uid, now)).fetchone()
        if delivery:
            c.execute('UPDATE screamer_history SET delivered=? WHERE id=?', (now, delivery['id']))
        if isinstance(active_id, str):
            active = bool(c.execute('''UPDATE screamers SET expires=?
                WHERE target=? AND id=? AND delivered=1 AND expires>?''',
                (now + 120, g.uid, active_id, now)).rowcount)
    return jsonify(videoId=delivery['id'] if delivery else None, active=active, build=FRONTEND_BUILD,
                   captions=json.loads(delivery['captions']) if delivery else [])


@app.get('/api/owner/online')
def owner_online():
    require_owner()
    c = db()
    now = time.time()
    with c:
        cutoff = now - ONLINE_TTL
        c.execute("DELETE FROM site_presence WHERE seen<=? AND user_id GLOB 'guest:*'", (cutoff,))
        expire_screamers(c, now)
        rows = c.execute('''SELECT u.id,p.username,u.name FROM site_presence p JOIN users u ON u.id=p.user_id
            WHERE p.user_id GLOB 'tg:*' AND p.seen>? ORDER BY p.username COLLATE NOCASE''', (cutoff,)).fetchall()
        total = c.execute('SELECT COUNT(*) FROM site_presence WHERE seen>?', (cutoff,)).fetchone()[0]
    return jsonify(total=total, players=[dict(row) for row in rows])


@app.get('/api/owner/players')
def owner_players():
    require_owner()
    rows = db().execute('''SELECT u.id,u.name,
            COALESCE(p.username,'') AS username, COALESCE(p.seen>?,0) AS online
        FROM users u LEFT JOIN site_presence p ON p.user_id=u.id
        WHERE u.id>? AND u.id GLOB 'tg:*' ORDER BY u.id LIMIT 51''',
        (time.time() - ONLINE_TTL, request.args.get('after', ''))).fetchall()
    return jsonify(players=[dict(row) for row in rows[:50]],
                   next=rows[49]['id'] if len(rows) > 50 else None)


@app.post('/api/owner/screamer')
def owner_screamer():
    require_owner()
    request.max_content_length = SCREAMER_LIMIT + 64 * 1024
    username = request.form.get('username', '').strip().removeprefix('@').lower()
    if not re.fullmatch(r'[a-z0-9_]{1,32}', username):
        raise Problem('Укажи Telegram-юзернейм')
    upload = request.files.get('video')
    captions = [request.form.get(f'caption{i}', '').strip() for i in range(1, 4)]
    if any(len(caption) > 80 for caption in captions):
        raise Problem('Каждая надпись должна быть не длиннее 80 символов')
    video = upload.stream.read(SCREAMER_LIMIT + 1) if upload else b''
    if len(video) > SCREAMER_LIMIT:
        raise Problem('Видео должно весить до 8 МБ', 'video_too_large', 413)
    if video[4:8] == b'ftyp':
        mime = 'video/mp4'
    elif video.startswith(b'\x1a\x45\xdf\xa3'):
        mime = 'video/webm'
    else:
        raise Problem('Загрузи видео в MP4 или WebM')
    c = db()
    now = time.time()
    c.execute('BEGIN IMMEDIATE')
    with c:
        players = c.execute('''SELECT user_id FROM site_presence
            WHERE seen>? AND lower(username)=? AND user_id LIKE 'tg:%' ''',
                            (now - ONLINE_TTL, username)).fetchall()
        if len(players) != 1:
            raise Problem('Игрок с этим юзернеймом сейчас недоступен', 'player_offline', 409)
        expire_screamers(c, now)
        target = players[0]['user_id']
        video_id = secrets.token_hex(16)
        c.execute("""UPDATE screamer_history SET ended='replaced'
            WHERE id IN (SELECT id FROM screamers WHERE target=?)""", (target,))
        c.execute('''INSERT OR REPLACE INTO screamers (target,id,mime,video,expires,captions)
                     VALUES (?,?,?,?,?,?)''',
                  (target, video_id, mime, video, now + 120,
                   json.dumps([caption for caption in captions if caption])))
        c.execute('INSERT INTO screamer_history(id,target,username,sent) VALUES (?,?,?,?)',
                  (video_id, target, username, now))
    return jsonify(ok=True)


@app.get('/api/screamer/<video_id>')
def screamer_video(video_id):
    row = db().execute('''SELECT mime,video FROM screamers
        WHERE target=? AND id=? AND delivered=1 AND expires>?''', (g.uid, video_id, time.time())).fetchone()
    if not row:
        raise Problem('Видео недоступно', 'not_found', 404)
    response = send_file(BytesIO(row['video']), mimetype=row['mime'], conditional=True)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.post('/api/owner/screamer/stop')
def owner_stop_screamer():
    require_owner()
    c = db()
    with c:
        expire_screamers(c, time.time())
        c.execute("""UPDATE screamer_history SET ended='stopped'
            WHERE id IN (SELECT id FROM screamers)""")
        stopped = c.execute('DELETE FROM screamers').rowcount
    return jsonify(stopped=stopped)


def expire_screamers(c, now):
    c.execute("""UPDATE screamer_history SET ended='expired'
        WHERE id IN (SELECT id FROM screamers WHERE expires<=?)""", (now,))
    c.execute('DELETE FROM screamers WHERE expires<=?', (now,))


@app.get('/api/owner/screamer/history')
def owner_screamer_history():
    require_owner()
    c = db()
    with c:
        expire_screamers(c, time.time())
        rows = c.execute('''SELECT target,username,sent,delivered,ended
            FROM screamer_history ORDER BY sent DESC LIMIT 50''').fetchall()
    return jsonify(entries=[dict(row) for row in rows])


@app.route('/api/<path:path>',methods=['GET','POST'])
def api(path):
    body=request.get_json(silent=True) if request.method=='POST' else {}
    if not isinstance(body,dict): raise Problem('Нужен JSON-объект')
    c=db()
    try:
        c.execute('BEGIN IMMEDIATE' if request.method=='POST' or path in ('giveaways','mines/current','pass','me') else 'BEGIN')
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
    if request.args.get('original') == '1':
        kinds = ('live', 'giveaways', 'pass')
        for kind in kinds:
            original_snapshot(kind)
        return jsonify(ok=True, build=FRONTEND_BUILD, original={kind: original_status(kind) for kind in kinds})
    return jsonify(ok=True,payments=False,publicAdmin=True)


@app.get('/img/<path:name>')
def image(name):
    match = re.fullmatch(r'named/([0-9]{1,9})\.png', name)
    if match:
        row = db().execute('SELECT cover FROM named_cases WHERE id=? AND expires>?',
                           (int(match[1]), time.time())).fetchone()
        if not row:
            raise Problem('Обложка недоступна', 'not_found', 404)
        return Response(row['cover'], mimetype='image/png', headers={'Cache-Control': 'no-store'})
    if name in ['logo.svg','coin.webp','custom/horseman.webp','custom/rodomits.webp'] or re.fullmatch(
            r'mutations/(?:default|gold|diamond|rainbow)\.webp', name):
        return send_from_directory(ROOT/'public'/'img',name)
    if '..' in name or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-.' for ch in name):
        raise Problem('Неверный путь',status=404)
    return redirect('https://brainrotgrader.com/img/'+name,302)


@app.post('/api/named-cases')
def create_named_case():
    from telegram_bot import call, TelegramError

    token = os.getenv('BOT_TOKEN', '').strip()
    if not token or not g.uid.startswith('tg:') or not custom_content_enabled():
        raise Problem('Открой мини-приложение в Telegram и включи кастомный контент', status=403)
    name = request.form.get('name', '').strip()
    description = request.form.get('description', '').strip()
    if not 1 <= len(name) <= 40 or not 1 <= len(description) <= 300:
        raise Problem('Название до 40 символов, описание до 300')
    price = integer(request.form.get('price'))
    ids = list(dict.fromkeys(integer(value) for value in request.form.getlist('drop')))
    if not 2 <= len(ids) <= 20:
        raise Problem('Выбери от 2 до 20 предметов')
    pool = {item['id']: item for item in named_case_items()}
    if any(item_id not in pool for item_id in ids):
        raise Problem('Один из предметов отсутствует в общем каталоге')
    upload = request.files.get('cover')
    try:
        if not upload:
            raise ValueError
        with Image.open(upload.stream) as img:
            if img.format not in ('PNG', 'JPEG', 'WEBP') or img.width * img.height > 4_000_000 or getattr(img, 'n_frames', 1) != 1:
                raise ValueError
            img = img.convert('RGBA')
            img.thumbnail((768, 768))
            output = BytesIO()
            img.save(output, 'PNG')
        cover = output.getvalue()
    except (OSError, ValueError, Image.DecompressionBombError):
        raise Problem('Загрузи обычную PNG, JPEG или WebP до 4 мегапикселей') from None
    c = db()
    now = time.time()
    with c:
        c.execute('BEGIN IMMEDIATE')
        if named_cases.active_case(c, g.uid):
            raise Problem('У тебя уже есть активный именной кейс', status=409)
        key = 'named-cover:' + g.uid
        last = c.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        if last and now - float(last[0]) < 30:
            raise Problem('Подожди 30 секунд перед новой проверкой', status=429)
        c.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', (key, str(now)))
    try:
        named_cases.check_cover(cover)
        bot = call(token, 'getMe', {}, timeout=5)
    except ValueError as error:
        raise Problem(str(error)) from None
    except TelegramError:
        raise Problem('Бот временно недоступен', status=503) from None
    items = [pool[item_id] for item_id in ids]
    weights = dict(items=[dict(itemId=item_id) for item_id in ids])
    apply_case_rarity_weights(dict(items=items, cases=[weights]))
    definition = dict(name=name, description=description, price=price,
                      items=[dict(item, weight=drop['weight']) for item, drop in zip(items, weights['items'])])
    order = secrets.token_urlsafe(24)
    with c:
        c.execute('BEGIN IMMEDIATE')
        if named_cases.active_case(c, g.uid):
            raise Problem('У тебя уже есть активный именной кейс', status=409)
        c.execute('DELETE FROM named_cases WHERE charge IS NULL AND created<?', (now - 7 * 86400,))
        c.execute('INSERT INTO named_cases(author,token,definition,cover,created) VALUES (?,?,?,?,?)',
                  (g.uid, order, json.dumps(definition), cover, now))
    return jsonify(url='https://t.me/' + bot['username'] + '?start=' + named_cases.PREFIX + order)


def named_case_items():
    source = original_snapshot('catalog') or json.loads((ROOT / 'source_catalog.json').read_text(encoding='utf-8-sig'))
    items = [item for item in source['items'] if not item.get('coins') and item['id'] != HORSEMAN_ID]
    items.append(dict(id=HORSEMAN_ID, name='Headless Horseman', price=74500, rarity='og',
                      image='/img/custom/horseman.webp'))
    return sorted(items, key=lambda item: item['price'])


@app.get('/api/named-cases/items')
def named_case_item_options():
    if not custom_content_enabled():
        raise Problem('Включи кастомный контент', status=403)
    return jsonify(named_case_items())


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
    required = ['index.html', 'admin.html', 'admin.js', 'admin-pass.js', 'admin-visual.js', 'admin.css', 'ui-audio.js', 'app.js', 'styles.css', 'sandbox.js', 'og-sound.js', 'telegram-web-app.js']
    missing = [name for name in required if not (ROOT / 'public' / name).is_file()]
    if missing:
        raise SystemExit('Missing frontend files in /app/public: ' + ', '.join(missing)
                         + '. Add the public directory to the repository and redeploy.')
    print('BrainGrader: frontend found; starting HTTP server.', flush=True)
    from telegram_bot import start_bot
    start_bot(DB_PATH, int(OWNER_UID[3:]), ONLINE_TTL)
    from waitress import serve
    serve(app,host='0.0.0.0',port=int(os.getenv('PORT','8000')),threads=8)
