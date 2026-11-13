"""Paid publication of community cases."""
import json
import os
import secrets
import time
from urllib.request import Request, urlopen

STARS = 15
WEEK = 168 * 3600
CASE_BASE = 610_000_000
PREFIX = 'named_'
SCHEMA = """
CREATE TABLE IF NOT EXISTS named_cases(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    definition TEXT NOT NULL, cover BLOB NOT NULL,
    created REAL NOT NULL, expires REAL,
    charge TEXT UNIQUE, checkout TEXT, checkout_at REAL
);
"""


def check_cover(cover):
    user = os.getenv('SIGHTENGINE_API_USER', '').strip()
    secret = os.getenv('SIGHTENGINE_API_SECRET', '').strip()
    if not user or not secret:
        raise ValueError('Проверка обложек пока не настроена')
    boundary = secrets.token_hex(24)
    fields = {'api_user': user, 'api_secret': secret, 'models': 'nudity-2.1,gore-2.0'}
    data = b''.join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        for key, value in fields.items()
    )
    data += (f'--{boundary}\r\nContent-Disposition: form-data; name="media"; filename="cover.png"\r\n'
             'Content-Type: image/png\r\n\r\n').encode() + cover + f'\r\n--{boundary}--\r\n'.encode()
    req = Request('https://api.sightengine.com/1.0/check.json', data=data,
                  headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
    try:
        with urlopen(req, timeout=8) as response:
            result = json.load(response)
        if result['status'] != 'success':
            raise ValueError
        scores = [result['gore']['prob']]
        scores.extend(result['nudity'][key] for key in (
            'sexual_activity', 'sexual_display', 'erotica', 'very_suggestive',
            'suggestive', 'mildly_suggestive',
        ))
        if not all(type(score) in (int, float) and 0 <= score <= 1 for score in scores):
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError):
        raise ValueError('Проверка обложки недоступна. Попробуй позже.') from None
    if max(scores) >= 0.35:
        raise ValueError('Обложка не прошла проверку на наготу или графическое насилие')


def lookup(conn, payload, uid):
    return conn.execute('''SELECT id,created,charge,checkout,checkout_at FROM named_cases
        WHERE token=? AND author=?''', (payload.removeprefix(PREFIX), 'tg:' + str(uid))).fetchone()


def active_case(conn, author):
    return conn.execute('SELECT 1 FROM named_cases WHERE author=? AND expires>?',
                        (author, time.time())).fetchone() is not None


def authorize(conn, query):
    uid = query['from']['id']
    if query['currency'] != 'XTR' or query['total_amount'] != STARS:
        return False
    now = time.time()
    row = lookup(conn, query['invoice_payload'], query['from']['id'])
    if not row or row['charge'] or row['created'] < now - 86400 or active_case(conn, 'tg:' + str(uid)):
        return False
    if conn.execute('''SELECT 1 FROM named_cases WHERE author=? AND id<>?
        AND charge IS NULL AND checkout_at>?''', ('tg:' + str(uid), row['id'], now - 600)).fetchone():
        return False
    return bool(conn.execute('''UPDATE named_cases SET checkout=?, checkout_at=?
        WHERE id=? AND charge IS NULL AND (checkout IS NULL OR checkout=? OR checkout_at<?)''',
        (query['id'], now, row['id'], query['id'], now - 600)).rowcount)


def publish(conn, payment, uid, paid_at):
    if payment['currency'] != 'XTR' or payment['total_amount'] != STARS:
        return None
    row = lookup(conn, payment['invoice_payload'], uid)
    if not row or not row['checkout']:
        return None
    charge = payment['telegram_payment_charge_id']
    if row['charge'] == charge:
        return row['id']
    if active_case(conn, 'tg:' + str(uid)):
        return None
    changed = conn.execute('''UPDATE OR IGNORE named_cases SET charge=?, expires=?
        WHERE id=? AND charge IS NULL''', (charge, paid_at + WEEK, row['id'])).rowcount
    return row['id'] if changed else None
