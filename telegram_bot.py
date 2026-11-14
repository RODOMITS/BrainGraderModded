"""Receive /start alongside the web server using Telegram long polling.

Bot API: https://core.telegram.org/bots/api#getupdates
"""
from html import escape
from contextlib import closing
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import named_cases
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

log = logging.getLogger('brainrot.telegram')
DEFAULT_APP_URL = 'https://bot-1793525010-3877-rodomits.bothost.tech/'
CHANNEL_USERNAME = '@brainrotmoddedgrader'
CHANNEL_URL = 'https://t.me/' + CHANNEL_USERNAME[1:]


class TelegramError(Exception):
    def __init__(self, code, retry_after=5):
        self.code = code
        self.retry_after = retry_after


def call(token, method, payload, photo=None, *, timeout=40):
    if photo is None:
        data = json.dumps(payload).encode('utf-8')
        content_type = 'application/json'
    else:
        boundary = 'Brainrot' + secrets.token_hex(16)
        chunks = []
        for key, value in payload.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            chunks.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'
                           f'{value}\r\n').encode('utf-8'))
        chunks.append((f'--{boundary}\r\nContent-Disposition: form-data; name="photo"; '
                       'filename="welcome.png"\r\nContent-Type: image/png\r\n\r\n').encode('utf-8'))
        chunks.extend([photo, f'\r\n--{boundary}--\r\n'.encode('utf-8')])
        data = b''.join(chunks)
        content_type = f'multipart/form-data; boundary={boundary}'
    req = Request(
        f'https://api.telegram.org/bot{token}/{method}',
        data=data,
        headers={'Content-Type': content_type},
    )
    try:
        with urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except HTTPError as error:
        try:
            result = json.loads(error.read())
        except (ValueError, OSError):
            raise TelegramError(error.code) from None
    except (URLError, OSError, ValueError):
        # Never put the token-bearing request URL in the logs.
        raise TelegramError('network') from None
    if not result.get('ok'):
        raise TelegramError(result.get('error_code', 'unknown'),
                            result.get('parameters', {}).get('retry_after', 5))
    return result['result']


def is_channel_subscriber(token, user_id):
    member = call(token, 'getChatMember', {
        'chat_id': CHANNEL_USERNAME,
        'user_id': user_id,
    }, timeout=3)
    status = member['status']
    if status == 'restricted':
        return member.get('is_member') is True
    return status in ('creator', 'administrator', 'member')


def welcome(token, app_url, message):
    if message.get('chat', {}).get('type') != 'private':
        return
    text = message.get('text', '')
    command = text.split(maxsplit=1)[0].split('@', 1)[0] if text else ''
    if command != '/start':
        return
    payload = {
        'chat_id': message['chat']['id'],
        'parse_mode': 'HTML',
        'text': (
            'Добро пожаловать в <b>Brainrot Grader ‼️MODDED‼️</b>, RODOMITS! 👋\n\n'
            'Кейсы, апгрейдер и мистери с брейнротами из Steal a Brainrot.\n'
            'Sandbox версия @brainrotgrader'
        ),
        'reply_markup': {
            'inline_keyboard': [
                [{'text': '🎮 Играть', 'web_app': {'url': app_url}}],
                [{'text': '📢 Наш Telegram-канал', 'url': CHANNEL_URL}],
            ],
        },
    }
    photo_path = Path(__file__).resolve().parent / 'assets' / 'welcome-modded.png'
    if photo_path.is_file():
        payload['caption'] = payload.pop('text')
        call(token, 'sendPhoto', payload, photo=photo_path.read_bytes())
    else:
        call(token, 'sendMessage', payload)


def case_payment_update(token, app_url, database_path, update):
    query = update.get('pre_checkout_query')
    message = update.get('message', {})
    payment = message.get('successful_payment')
    text = message.get('text', '').split()
    payload = text[1] if len(text) == 2 and text[0].split('@')[0] == '/start' else ''
    if not (query or payment or payload.startswith(named_cases.PREFIX) or text == ['/paysupport']):
        return False
    if not query and message.get('chat', {}).get('type') != 'private':
        return True
    with closing(sqlite3.connect(database_path, timeout=4)) as conn, conn:
        conn.row_factory = sqlite3.Row
        if query:
            conn.execute('BEGIN IMMEDIATE')
            allowed = named_cases.authorize(conn, query)
        elif payment:
            conn.execute('BEGIN IMMEDIATE')
            case_id = named_cases.publish(conn, payment, message['from']['id'], message['date'])
        elif payload:
            uid = message['from']['id']
            order = (named_cases.lookup(conn, payload, uid)
                     if not named_cases.active_case(conn, f'tg:{uid}') else None)
    if query:
        answer = dict(pre_checkout_query_id=query['id'], ok=allowed)
        if not allowed:
            answer['error_message'] = 'Этот заказ недоступен или уже оплачен.'
        call(token, 'answerPreCheckoutQuery', answer, timeout=5)
        return True
    chat_id = message['chat']['id']
    if payment:
        if case_id:
            call(token, 'sendMessage', {
                'chat_id': chat_id, 'text': 'Кейс опубликован на 168 часов. Включи кастомный контент, чтобы увидеть его.',
                'reply_markup': {'inline_keyboard': [[{'text': 'Открыть кейс', 'web_app': {
                    'url': app_url.split('#', 1)[0] + '#/case/' + str(named_cases.CASE_BASE + case_id),
                }}]]},
            }, timeout=5)
        else:
            call(token, 'sendMessage', {'chat_id': chat_id, 'text': 'Платёж получен, но заказ не опубликован. Напиши /paysupport.'})
    elif payload and order and not order['charge'] and order['created'] >= time.time() - 86400:
        call(token, 'sendInvoice', {
            'chat_id': chat_id, 'title': 'Именной кейс',
            'description': 'Публикация именного кейса в Brainrot Grader MODDED на 168 часов.',
            'payload': payload, 'currency': 'XTR', 'start_parameter': payload,
            'prices': [{'label': 'Публикация кейса', 'amount': named_cases.STARS}],
        }, timeout=5)
    else:
        reply = ('По оплате напиши @RODOMITS и приложи квитанцию Telegram.'
                 if not payload else 'Заказ недоступен или уже оплачен. Неоплаченный заказ действует сутки.')
        call(token, 'sendMessage', {'chat_id': chat_id, 'text': reply}, timeout=5)
    return True


def polling(token, app_url, database_path):
    # Scope the saved position to this bot, without storing its token.
    key = 'telegram_offset_' + hashlib.sha256(token.encode()).hexdigest()[:16]
    with sqlite3.connect(database_path, timeout=15) as conn:
        row = conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        offset = int(row[0]) if row else 0
    log.warning('Telegram: /start handler running.')
    while True:
        try:
            updates = call(token, 'getUpdates', {
                'offset': offset, 'timeout': 25, 'allowed_updates': ['message', 'pre_checkout_query'],
            })
            for update in updates:
                if 'message' in update or 'pre_checkout_query' in update:
                    try:
                        if not case_payment_update(token, app_url, database_path, update):
                            welcome(token, app_url, update['message'])
                    except TelegramError as error:
                        # A blocked/deleted chat must not hold up every other user.
                        if error.code not in (400, 403):
                            raise
                        log.warning('Telegram: cannot reply to a chat (code %s).', error.code)
                offset = update['update_id'] + 1
                with sqlite3.connect(database_path, timeout=15) as conn:
                    conn.execute('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', (key, str(offset)))
        except TelegramError as error:
            if error.code in (401, 404):
                log.error('Telegram: invalid BOT_TOKEN; /start handler stopped.')
                return
            if error.code == 409:
                log.error('Telegram: polling conflict. Stop other bot instances or remove its existing webhook.')
            else:
                log.warning('Telegram: request failed (code %s); retrying.', error.code)
            time.sleep(max(3, min(float(error.retry_after), 60)))
        except (sqlite3.Error, KeyError, TypeError, ValueError):
            log.error('Telegram: could not process an update; retrying.')
            time.sleep(5)


def notify_presence(token, database_path, owner, ttl):
    while True:
        try:
            with closing(sqlite3.connect(database_path, timeout=5)) as conn:
                conn.row_factory = sqlite3.Row
                now = time.time()
                minute = int(now // 60)
                if not conn.execute('SELECT 1 FROM online_samples WHERE minute=?', (minute,)).fetchone():
                    with conn:
                        conn.execute("""INSERT OR IGNORE INTO online_samples
                            SELECT ?, COUNT(*) FROM site_presence WHERE user_id GLOB 'tg:*' AND seen>?""",
                                     (minute, now - ttl))
                        conn.execute('DELETE FROM online_samples WHERE minute<=?', (minute - 1440,))
                rows = conn.execute("""SELECT r.*,u.name,p.username,COALESCE(p.seen>?,0) AS online
                    FROM presence_reminders r JOIN users u ON u.id=r.user_id
                    LEFT JOIN site_presence p ON p.user_id=r.user_id""", (time.time() - ttl,)).fetchall()
                for row in rows:
                    online = row['online']
                    if online == row['was_online']:
                        continue
                    enabled = row['on_enter'] if online else row['on_leave']
                    if enabled:
                        name = '@' + row['username'] if row['username'] else row['name']
                        status = 'сейчас онлайн' if online else 'больше не онлайн'
                        try:
                            call(token, 'sendMessage', {
                                'chat_id': owner,
                                'text': f'{name} (ID {row["user_id"][3:]}) {status} в Modded.',
                            }, timeout=5)
                        except TelegramError as error:
                            log.warning('Presence reminder could not be delivered (%s).', error.code)
                            if error.code == 429:
                                time.sleep(max(5, min(error.retry_after, 60)))
                                break
                            continue
                    with conn:
                        conn.execute('UPDATE presence_reminders SET was_online=? WHERE user_id=? AND was_online=?',
                                     (online, row['user_id'], row['was_online']))
        except (TelegramError, sqlite3.Error) as error:
            log.warning('Presence reminder failed (%s).', getattr(error, 'code', type(error).__name__))
        time.sleep(5)


def refresh_subscriptions(token, database_path):
    after = ''
    while True:
        delay = 1
        try:
            with closing(sqlite3.connect(database_path, timeout=5)) as conn:
                row = conn.execute("""SELECT u.id FROM users u
                    LEFT JOIN channel_checks c ON c.user_id=u.id
                    WHERE u.id GLOB 'tg:*' AND u.id>? AND (c.checked IS NULL OR c.checked<?)
                    ORDER BY u.id LIMIT 1""", (after, time.time() - 86400,)).fetchone()
                if row:
                    uid = row[0]
                    after = uid
                    checked = time.time()
                    subscribed = is_channel_subscriber(token, int(uid[3:]))
                    with conn:
                        conn.execute("""INSERT INTO channel_checks VALUES (?,?,?)
                            ON CONFLICT(user_id) DO UPDATE SET subscribed=excluded.subscribed,checked=excluded.checked
                            WHERE excluded.checked>=channel_checks.checked""", (uid, int(subscribed), checked))
                else:
                    after = ''
                    delay = 60
        except TelegramError as error:
            delay = max(1, error.retry_after) if error.code == 429 else (
                60 if error.code in (401, 403, 404) else 3)
            if error.code == 429:
                # Retry this account after Telegram's cooldown.
                after = ''
            log.warning('Channel membership check failed (%s).', error.code)
            save_scan_issue(database_path, str(error.code), delay)
        except sqlite3.Error:
            delay = 60
            log.warning('Could not refresh channel membership statistics.')
        time.sleep(delay)


def save_scan_issue(database_path, code, delay):
    try:
        with closing(sqlite3.connect(database_path, timeout=5)) as conn, conn:
            conn.execute("INSERT OR REPLACE INTO settings VALUES ('channel-scan-issue',?)",
                         (json.dumps({'code': code, 'until': time.time() + delay}),))
    except sqlite3.Error:
        log.warning('Could not save membership check status.')


def start_bot(database_path, owner, online_ttl):
    token = os.getenv('BOT_TOKEN', '').strip()
    if not token:
        log.warning('Telegram: BOT_TOKEN is missing; /start handler disabled.')
        return
    app_url = os.getenv('MINI_APP_URL', DEFAULT_APP_URL).strip()
    parsed = urlsplit(app_url)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
        log.error('Telegram: MINI_APP_URL must be a valid public HTTPS URL; /start handler disabled.')
        return
    threading.Thread(target=polling, args=(token, app_url, Path(database_path)),
                     name='telegram-polling', daemon=True).start()
    threading.Thread(target=notify_presence, args=(token, database_path, owner, online_ttl),
                     name='presence-reminders', daemon=True).start()
    threading.Thread(target=refresh_subscriptions, args=(token, database_path),
                     name='channel-membership', daemon=True).start()
