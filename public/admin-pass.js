const passPanel = $('panel-pass');
passPanel.innerHTML = `
  <section>
    <h2>Grader Pass</h2>
    <p class="hint">Задания и награды можно брать из оригинала независимо друг от друга. Опыт, прогресс и полученные призы хранятся в твоём профиле Modded.</p>
    <p id="passStatus" role="status"></p>
    <button type="button" id="passRefresh" class="secondary">Обновить данные</button>
    <form id="passForm" hidden>
      <div class="pass-admin-grid">
        <label>Награды <select name="rewardsMode"><option value="original">Как в оригинале</option><option value="custom">Свои</option></select></label>
        <label>Задания <select name="tasksMode"><option value="original">Как в оригинале</option><option value="custom">Свои</option></select></label>
        <label>Всего XP <input name="xp" type="number" min="0" max="10000000" required></label>
      </div>
      <p id="passLevel" class="hint"></p>
      <div id="passRewards" hidden>
        <h3>Уровни и награды</h3>
        <div id="passRewardRows"></div>
        <button type="button" id="passAddReward" class="secondary">Добавить уровень</button>
      </div>
      <div id="passTasks" hidden>
        <h3>Ежедневные задания</h3><div id="passDailyRows"></div>
        <button type="button" id="passAddDaily" class="secondary">Добавить задание</button>
        <h3>Недельные задания</h3><div id="passWeeklyRows"></div>
        <button type="button" id="passAddWeekly" class="secondary">Добавить задание</button>
      </div>
      <h3>Прогресс заданий</h3>
      <p class="hint">Укажи число для ручного прогресса. Очисти поле, чтобы снова считать по играм. Новый список заданий можно настроить после сохранения.</p>
      <div id="passProgress"></div>
      <button type="submit">Сохранить Grader Pass</button>
    </form>
  </section>`;

const passMetrics = {
  manual: 'Вручную', visit: 'Вход на сайт', spend: 'Потрачено BG', case: 'Открыто платных кейсов',
  upgrade: 'Попытки апгрейда', upgrade_win: 'Успешные апгрейды',
  dice: 'Игры в Колор Дайс', dice_win: 'Победы в Колор Дайс', mystery: 'Игры в Мистери',
};
const passGroups = { daily: ['Ежедневные', 'passDailyRows'], weekly: ['Недельные', 'passWeeklyRows'] };
const passForm = $('passForm');
let passData, passLoading = false;

function passField(row, name, title, input) {
  const label = document.createElement('label');
  label.textContent = title;
  input.dataset.field = name;
  label.append(input);
  row.append(label);
  return input;
}

function passInput(type, value, min, max) {
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  if (type === 'number') {
    input.min = min;
    input.max = max;
  } else {
    input.maxLength = max;
  }
  input.required = true;
  return input;
}

function passSelect(value, entries) {
  const select = document.createElement('select');
  for (const [id, title] of entries) select.append(option(id, title));
  select.value = value;
  select.required = true;
  return select;
}

function passRow(parent) {
  const row = document.createElement('div');
  row.className = 'pass-admin-row pass-admin-grid';
  parent.append(row);
  return row;
}

function passRemove(row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = 'Удалить';
  button.onclick = () => row.remove();
  row.append(button);
}

function passRewardRow(level) {
  const { xp, reward } = level;
  const row = passRow($('passRewardRows'));
  passField(row, 'xp', 'Порог XP', passInput('number', xp, 0, 10000000));
  const kind = passField(row, 'kind', 'Награда', passSelect(reward.kind, [['coins', 'Монеты'], ['case', 'Кейс']]));
  const amount = passField(row, 'amount', 'Сумма BG', passInput('number', reward.amount ?? 1, 1, 10000000));
  const cases = passData.cases;
  const match = cases.find(c => c.id === reward.caseId || c.name === reward.name);
  const pick = passField(row, 'caseId', 'Кейс', passSelect(match?.id ?? '', cases.map(c => [c.id, c.name])));
  const count = passField(row, 'count', 'Количество', passInput('number', reward.count ?? 1, 1, 20));
  const badge = document.createElement('input');
  badge.type = 'checkbox';
  badge.checked = reward.badge;
  passField(row, 'badge', 'Значок сезона', badge);
  passRemove(row);
  kind.onchange = () => {
    for (const [input, enabled] of [[amount, kind.value === 'coins'], [pick, kind.value === 'case'], [count, kind.value === 'case']]) {
      input.disabled = !enabled;
      input.parentElement.hidden = !enabled;
    }
  };
  kind.onchange();
}

function passTaskRow(group, quest) {
  const row = passRow($(passGroups[group][1]));
  row.dataset.id = quest.id;
  passField(row, 'title', 'Название', passInput('text', quest.title, 0, 160));
  passField(row, 'metric', 'Условие', passSelect(quest.metric, Object.entries(passMetrics)));
  passField(row, 'goal', 'Цель', passInput('number', quest.goal, 1, 10000000));
  passField(row, 'xp', 'Награда XP', passInput('number', quest.xp, 1, 10000000));
  passField(row, 'unit', 'Единица измерения', passInput('text', quest.unit, 0, 30)).required = false;
  passRemove(row);
}

function drawPassAdmin(data) {
  passData = data;
  const { config, original, view, status } = data;
  const statuses = {
    ready: 'Данные оригинала загружены.', loading: 'Оригинал загружается. Нажми «Обновить данные» через несколько секунд.',
    missing_env: 'На хостинге нужна переменная ORIGINAL_INIT_DATA.',
    auth_rejected: 'Оригинал отклонил авторизацию. Обнови ORIGINAL_INIT_DATA на хостинге.',
    invalid_response: 'Оригинал прислал данные в неожиданном формате.',
  };
  $('passStatus').textContent = (statuses[status] || 'Не удалось обновить данные оригинала.') +
    (original && !['ready', 'loading'].includes(status) ? ' Используются последние доступные данные.' : '');
  passForm.elements.rewardsMode.value = config.rewardsMode;
  passForm.elements.tasksMode.value = config.tasksMode;
  passForm.elements.xp.value = view.xp;
  $('passLevel').textContent = `Уровень ${view.level} из ${view.maxLevel} · получено наград: ${view.levels.filter(row => row.claimed).length}`;
  $('passRewardRows').replaceChildren();
  config.levels.forEach(passRewardRow);
  $('passProgress').replaceChildren();
  for (const [group, [title, rowId]] of Object.entries(passGroups)) {
    $(rowId).replaceChildren();
    config[group].forEach(quest => passTaskRow(group, quest));
    const current = view[group];
    if (!current?.quests.length) continue;
    const heading = document.createElement('h4');
    heading.textContent = title;
    $('passProgress').append(heading);
    const row = passRow($('passProgress'));
    row.dataset.group = group;
    row.dataset.period = current.period;
    for (const quest of current.quests) {
      const key = config.tasksMode + ':' + quest.id;
      const initial = config.progress[current.period]?.[key] ?? '';
      const input = passInput('number', initial, 0, quest.goal);
      input.required = false;
      input.placeholder = String(quest.progress);
      input.dataset.initial = initial;
      passField(row, quest.id, `${quest.title} · ${quest.progress}/${quest.goal}${quest.done ? ' ✓' : ''}`, input);
    }
  }
  passForm.hidden = false;
  updatePassModes();
}

function updatePassModes() {
  const customRewards = passForm.elements.rewardsMode.value === 'custom';
  const customTasks = passForm.elements.tasksMode.value === 'custom';
  $('passRewards').hidden = !customRewards;
  $('passTasks').hidden = !customTasks;
  if (customRewards && !$('passRewardRows').children.length) passData.original?.levels.forEach(passRewardRow);
  if (customTasks) {
    for (const [group, [, rowId]] of Object.entries(passGroups)) {
      if (!$(rowId).children.length) passData.original?.[group]?.quests.forEach(quest => passTaskRow(group, quest));
    }
  }
  $('passProgress').hidden = passForm.elements.tasksMode.value !== passData.config.tasksMode;
}

async function loadPassAdmin() {
  if (passLoading) return;
  passLoading = true;
  $('passStatus').textContent = 'Загружаю Grader Pass…';
  try {
    await window.sandboxReady;
    let data = await api('admin/pass');
    if (data.status === 'loading' && !data.original) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      data = await api('admin/pass');
    }
    drawPassAdmin(data);
  } catch (error) {
    $('passStatus').textContent = error.message;
  } finally {
    passLoading = false;
  }
}

nav.querySelector('[data-panel="pass"]').addEventListener('click', () => {
  if (!passData) loadPassAdmin();
});
if (!passPanel.hidden) loadPassAdmin();
$('passRefresh').onclick = loadPassAdmin;
passForm.elements.rewardsMode.onchange = updatePassModes;
passForm.elements.tasksMode.onchange = updatePassModes;
$('passAddReward').onclick = () => {
  const previous = $('passRewardRows').lastElementChild?.querySelector('[data-field="xp"]').value;
  passRewardRow({ xp: previous == null ? 10 : Number(previous) + 10, reward: { kind: 'coins' } });
};
for (const [group, button] of [['daily', 'passAddDaily'], ['weekly', 'passAddWeekly']]) {
  $(button).onclick = () => passTaskRow(group, { id: crypto.randomUUID(), title: '', xp: 10, goal: 1, unit: '', metric: 'manual' });
}

passForm.noValidate = true;
passForm.onsubmit = async event => {
  event.preventDefault();
  const { rewardsMode, tasksMode, xp } = passForm.elements;
  const fields = row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [
    input.dataset.field, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value,
  ]));
  for (const input of passForm.querySelectorAll('input,select')) {
    if (!input.closest('[hidden]') && !input.reportValidity()) return;
  }
  const levels = rewardsMode.value === 'custom' ? [...$('passRewardRows').children].map(row => {
    const { xp, kind, amount, caseId, count, badge } = fields(row);
    return { xp, reward: kind === 'coins' ? { kind, amount, badge } : { kind, caseId: Number(caseId), count, badge } };
  }) : passData.config.levels;
  const body = { rewardsMode: rewardsMode.value, tasksMode: tasksMode.value, levels, progress: {} };
  if (Number(xp.value) !== passData.view.xp) body.xp = Number(xp.value);
  for (const [group, [, rowId]] of Object.entries(passGroups)) {
    body[group] = tasksMode.value === 'custom'
      ? [...$(rowId).children].map(row => ({ ...fields(row), id: row.dataset.id })) : passData.config[group];
    const row = $('passProgress').querySelector(`[data-group="${group}"]`);
    if (!row || $('passProgress').hidden) continue;
    const counts = Object.fromEntries([...row.querySelectorAll('input')]
      .filter(input => input.value !== input.dataset.initial)
      .map(input => [input.dataset.field, input.value === '' ? null : Number(input.value)]));
    if (Object.keys(counts).length) body.progress[group] = { period: row.dataset.period, counts };
  }
  const button = event.submitter;
  button.disabled = true;
  try {
    drawPassAdmin(await api('admin/pass', body));
    notice('Grader Pass сохранён');
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
};
