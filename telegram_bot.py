"""Receive /start alongside the web server using Telegram long polling.

Bot API: https://core.telegram.org/bots/api#getupdates
"""
from html import escape
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

log = logging.getLogger('brainrot.telegram')
DEFAULT_APP_URL = 'https://bot-1793525010-3877-rodomits.bothost.tech/'
CHANNEL_URL = 'https://t.me/brainrotmoddedgrader'


class TelegramError(Exception):
    def __init__(self, code, retry_after=5):
        self.code = code
        self.retry_after = retry_after


def call(token, method, payload, photo=None):
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
                       'filename="welcome.jpg"\r\nContent-Type: image/jpeg\r\n\r\n').encode('utf-8'))
        chunks.extend([photo, f'\r\n--{boundary}--\r\n'.encode('utf-8')])
        data = b''.join(chunks)
        content_type = f'multipart/form-data; boundary={boundary}'
    req = Request(
        f'https://api.telegram.org/bot{token}/{method}',
        data=data,
        headers={'Content-Type': content_type},
    )
    try:
        with urlopen(req, timeout=40) as response:
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
                'offset': offset, 'timeout': 25, 'allowed_updates': ['message'],
            })
            for update in updates:
                if 'message' in update:
                    try:
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


def start_bot(database_path):
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
