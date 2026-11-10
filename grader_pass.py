"""Translate Grader Pass definitions and track local season progress."""

from datetime import datetime, timedelta, timezone
import re
import time
from urllib.parse import urlsplit


MOSCOW = timezone(timedelta(hours=3))
AUTUMN = dict(name='Осенний сезон', started=True, over=False)
METRICS = ('manual', 'spend', 'case', 'upgrade', 'upgrade_win', 'dice', 'dice_win', 'mystery')
QUEST_GROUPS = ('daily', 'weekly')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS pass_events(
    user_id TEXT NOT NULL, game TEXT NOT NULL, created REAL NOT NULL,
    cents INTEGER NOT NULL, plays INTEGER NOT NULL, wins INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pass_events_user ON pass_events(user_id,created);
CREATE TABLE IF NOT EXISTS pass_quests(
    user_id TEXT NOT NULL, period TEXT NOT NULL, quest_id TEXT NOT NULL, xp INTEGER NOT NULL,
    PRIMARY KEY(user_id,period,quest_id)
);
CREATE TABLE IF NOT EXISTS pass_claims(
    user_id TEXT NOT NULL, level INTEGER NOT NULL, badge INTEGER NOT NULL,
    PRIMARY KEY(user_id,level)
);
'''


def whole(value, low=0, high=10_000_000):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('Целое число вне допустимого диапазона')
    return value


def label(value, limit):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
        raise ValueError(f'Текст должен содержать от 1 до {limit} символов')
    return value.strip()


def metric_for(row):
    if row.get('metric') in METRICS:
        return row['metric']
    title = row['title'].lower().replace('ё', 'е')
    if re.search(r'потрать|оборот|ставок на', title) and 'bg' in title:
        return 'spend'
    if re.search(r'открой \d+ (платн\w+ )?кейс', title):
        return 'case'
    for word, game in (('апгрейд', 'upgrade'), ('дайс', 'dice')):
        if word in title:
            if re.search(r'выигра|успешн|побед', title):
                return game + '_win'
            if re.search(r'сыгра|сделай|проведи', title):
                return game
    if 'мистери' in title and re.search(r'сыгра|сделай|проведи', title):
        return 'mystery'
    return 'manual'


def quests(rows, original=False):
    if not isinstance(rows, list) or len(rows) > 50:
        raise ValueError('До 50 заданий в каждой группе')
    result = []
    ids = set()
    for index, row in enumerate(rows):
        title = label(row['title'], 160)
        quest_id = str(row.get('id', title if original else index + 1))
        if not quest_id or len(quest_id) > 180 or quest_id in ids:
            raise ValueError('Идентификаторы заданий должны быть уникальными')
        ids.add(quest_id)
        unit = row.get('unit') or ''
        if unit:
            unit = label(unit, 30)
        metric = metric_for(row) if original else row['metric']
        if metric not in METRICS:
            raise ValueError('Неизвестное условие задания')
        result.append(dict(id=quest_id, title=title, xp=whole(row['xp'], 1),
                           goal=whole(row['goal'], 1), unit=unit, metric=metric))
    return result


def levels(rows, original=False):
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValueError('До 100 уровней')
    result = []
    previous = -1
    for level, row in enumerate(rows, 1):
        xp = whole(row['xp'])
        if xp <= previous or (original and row['level'] != level):
            raise ValueError('Порог XP должен расти с каждым уровнем')
        previous = xp
        reward = row['reward']
        clean = dict(kind=reward['kind'], badge=reward.get('badge') is True)
        if clean['kind'] == 'coins':
            clean['amount'] = whole(reward['amount'], 1)
        elif clean['kind'] == 'case':
            clean['count'] = whole(reward.get('count') or 1, 1, 20)
            case_id = reward.get('caseId', reward.get('id'))
            if case_id is not None or not original:
                clean['caseId'] = whole(case_id, 1)
            if original:
                clean['name'] = label(reward['name'], 120)
                image = reward.get('image') or ''
                parts = urlsplit(image)
                if parts.path.startswith('/img/') and (not parts.netloc or parts.netloc == 'brainrotgrader.com'):
                    clean['image'] = parts.path
        else:
            raise ValueError('Награда должна быть монетами или кейсом')
        result.append(dict(level=level, xp=xp, reward=clean))
    return result


def parse_date(value):
    if not value:
        return None
    dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('У даты должен быть часовой пояс')
    return dt.timestamp()


def original_definition(data):
    season = data.get('season') or {}
    clean = dict(name=label(season.get('name') or AUTUMN['name'], 120),
                 started=bool(season.get('started', True)), over=bool(season.get('over', False)))
    for key in ('start', 'end', 'claimUntil'):
        value = season.get(key) or season.get(key + 'At')
        if parse_date(value) is not None:
            clean[key] = value
    result = dict(enabled=data.get('enabled') is True, season=clean,
                  levels=levels(data.get('levels') or [], original=True))
    for group in QUEST_GROUPS:
        source = data.get(group)
        if source is None:
            result[group] = None
            continue
        end = parse_date(source['endsAt'])
        if end is None:
            raise ValueError('У заданий должна быть дата обновления')
        result[group] = dict(endsAt=source['endsAt'], quests=quests(source['quests'], original=True))
    return result


def period(group, now):
    today = datetime.fromtimestamp(now, MOSCOW).replace(hour=0, minute=0, second=0, microsecond=0)
    if group == 'weekly':
        return today - timedelta(days=today.weekday()), timedelta(days=7)
    return today, timedelta(days=1)


def quest_progress(events, metric):
    if metric == 'manual':
        return 0
    if metric == 'spend':
        return sum(event['cents'] for event in events) // 100
    game, _, kind = metric.partition('_')
    return sum(event['wins' if kind == 'win' else 'plays'] for event in events if event['game'] == game)


def view(db, uid, cfg, original, settle=False):
    now = time.time()
    needs_original = 'original' in (cfg['rewardsMode'], cfg['tasksMode'])
    season = dict(original['season'] if original and needs_original else AUTUMN)
    start = parse_date(season.get('start'))
    end = parse_date(season.get('end'))
    if start is not None:
        season['started'] = now >= start
    if end is not None:
        season['over'] = now >= end
    active = season['started'] and not season['over']
    claim_end = parse_date(season.get('claimUntil')) or end
    can_claim = season['started'] and (not season['over'] or bool(claim_end and now < claim_end))
    first_event, last_event = start or 0, min(end or now, now)
    spent = db.execute('''SELECT COALESCE(SUM(cents),0) FROM pass_events
                          WHERE user_id=? AND created>=? AND created<?''',
                       (uid, first_event, last_event)).fetchone()[0]
    result = dict(enabled=True, season=season, rewardsUnavailable=False, tasksUnavailable=False)
    progress = cfg.get('progress', {})
    pending_xp = 0
    for group in QUEST_GROUPS:
        start_date, span = period(group, now)
        if cfg['tasksMode'] == 'original':
            definition = original[group] if original else None
            if definition and parse_date(definition['endsAt']) > now:
                stop = datetime.fromtimestamp(parse_date(definition['endsAt']), MOSCOW)
                start_date = stop - span
            else:
                result[group] = None
                result['tasksUnavailable'] = active
                continue
        else:
            stop = start_date + span
            definition = dict(endsAt=stop.isoformat(), quests=cfg[group])
        period_id = group + ':' + str(int(stop.timestamp()))
        period_events = db.execute('''SELECT game,SUM(cents) AS cents,SUM(plays) AS plays,SUM(wins) AS wins
            FROM pass_events WHERE user_id=? AND created>=? AND created<? GROUP BY game''',
            (uid, max(first_event, start_date.timestamp()), min(last_event, stop.timestamp()))).fetchall()
        completed = {row[0] for row in db.execute(
            'SELECT quest_id FROM pass_quests WHERE user_id=? AND period=?', (uid, period_id))}
        rows = []
        for quest in definition['quests']:
            key = cfg['tasksMode'] + ':' + quest['id']
            override = progress.get(period_id, {}).get(key)
            count = quest_progress(period_events, quest['metric']) if override is None else override
            done = key in completed or count >= quest['goal']
            if active and done and key not in completed:
                if settle:
                    db.execute('INSERT INTO pass_quests VALUES (?,?,?,?)', (uid, period_id, key, quest['xp']))
                else:
                    pending_xp += quest['xp']
            rows.append(dict(quest, progress=min(quest['goal'], count), done=done))
        result[group] = dict(endsAt=definition['endsAt'], quests=rows, period=period_id)
    quest_xp = db.execute('SELECT COALESCE(SUM(xp),0) FROM pass_quests WHERE user_id=?', (uid,)).fetchone()[0]
    xp = max(0, cfg.get('xpOffset', 0) + spent // 1000 + quest_xp + pending_xp)
    claimed = {row['level']: row['badge'] for row in db.execute(
        'SELECT level,badge FROM pass_claims WHERE user_id=?', (uid,))}
    track = cfg['levels'] if cfg['rewardsMode'] == 'custom' else (original or {}).get('levels', [])
    level = sum(xp >= row['xp'] for row in track)
    base = track[level - 1]['xp'] if level else 0
    result.update(xp=xp, level=level, maxLevel=len(track), levelXp=xp-base, badge=any(claimed.values()),
                  levelNeed=track[level]['xp']-base if level < len(track) else 1,
                  rewardsUnavailable=cfg['rewardsMode'] == 'original' and not track,
                  levels=[dict(row, claimed=row['level'] in claimed,
                               canClaim=can_claim and row['level'] <= level and row['level'] not in claimed)
                          for row in track])
    return result
