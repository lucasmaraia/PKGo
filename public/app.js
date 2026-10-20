const $ = s => document.querySelector(s);
const ACTIVE = ['queued', 'starting', 'installing'];
let state = null, view = location.hash === '#ps4' ? 'ps4' : 'pc', filter = 'all', query = '', gridKey = '', consoleKey = '', activityKey = '', serverDown = false;

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toLocaleString('pt-BR', {maximumFractionDigits: i >= 3 ? 2 : 1})} ${units[i]}`;
}
function duration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
function initials(title) {
  return esc(title.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'PKG');
}
function cover(item, cls = 'cover') {
  return item?.hasIcon
    ? `<img class="${cls}" src="/api/icon/${item.iconId || item.id}" alt="" loading="lazy">`
    : `<div class="${cls} fallback">${initials(item?.title || 'PKG')}</div>`;
}
function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
const percent = job => job.total ? Math.min(100, (job.transferred / job.total) * 100) : 0;
const jobLabel = job => job.state === 'queued' ? 'Na fila' : job.state === 'starting' ? 'Iniciando…' : `${percent(job).toFixed(0)}%`;
const itemById = id => state?.library.find(i => i.id === id);
const consoleById = titleId => state?.console.items.find(i => i.titleId === titleId);
const latestJob = id => state?.jobs.filter(j => j.pkgId === id).at(-1);
const consoleCover = (item, cls = 'cover') => item.hasIcon
  ? `<img class="${cls}" src="/api/console-icon/${item.titleId}" alt="" loading="lazy">`
  : `<div class="${cls} fallback">${initials(item.title)}</div>`;
const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>',
  install: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

// ---------- rendering ----------
function renderStatus() {
  const pill = $('#ps4Status');
  if (serverDown) {
    pill.className = 'status offline';
    pill.querySelector('.label').textContent = 'PKG Sender foi fechado — abra-o novamente';
    return;
  }
  const {ps4, config} = state;
  // With the payload, a closed installer app no longer blocks installs.
  const viaGoldhen = ps4.state === 'noinstaller' && state.dpi;
  pill.className = `status ${viaGoldhen ? 'online' : ps4.state}`;
  pill.querySelector('.label').textContent = viaGoldhen ? `PS4 conectado · instala pelo GoldHEN · ${config.ps4Ip}` : {
    online: `PS4 conectado · ${config.ps4Ip}`,
    offline: `PS4 não encontrado · ${config.ps4Ip}`,
    noinstaller: 'PS4 encontrado · abra o Remote Package Installer',
    unconfigured: 'Configure o IP do PS4',
  }[ps4.state] || 'Verificando PS4…';
}

function visibleItems() {
  const q = query.trim().toLowerCase();
  return state.library.filter(i =>
    (filter === 'all' || i.kind === filter) &&
    (!q || [i.title, i.titleId, i.name, i.contentId].some(v => v && v.toLowerCase().includes(q))));
}

function renderGrid() {
  const items = visibleItems();
  const key = JSON.stringify([filter, query, items.map(i => [i.id, i.installed, i.installedVersion, i.newer, i.error, i.hasIcon])]);
  if (key === gridKey) return;
  gridKey = key;
  $('#empty').hidden = view !== 'pc' || state.library.length > 0 || state.scanning;
  $('#grid').innerHTML = items.length || !state.library.length ? items.map(i => `
    <article class="card" data-id="${i.id}" tabindex="0" title="${esc(i.path)}">
      <div class="tile-art">
        ${cover(i)}
        ${i.installed ? `<span class="flag" title="Instalado no PS4">${ICON.check}</span>`
          : i.newer ? `<span class="flag newer" title="Mais nova que a do PS4">${ICON.up}</span>` : ''}
        <div class="tile-progress"></div>
      </div>
      <h3>${esc(i.title)}</h3>
      <div class="meta">${[esc(i.kindLabel), i.version && `v${esc(i.version)}`, bytes(i.size)].filter(Boolean).join(' · ')}</div>
      ${i.error ? `<div class="meta state error">Não foi possível ler o PKG</div>`
        : i.installed ? `<div class="meta state">Instalado${i.installedVersion ? ` · v${esc(i.installedVersion)}` : ''}</div>`
        : i.newer ? `<div class="meta state newer">Mais nova · PS4 tem v${esc(i.installedVersion)}</div>` : ''}
    </article>`).join('')
    : `<p class="empty">Nada encontrado para essa busca.</p>`;
  renderCardStates(true);
}

// Progress overlay at the bottom of the tile, like a PS4 download.
function renderCardStates(force = false) {
  for (const card of document.querySelectorAll('#grid .card')) {
    const job = latestJob(card.dataset.id);
    const box = card.querySelector('.tile-progress');
    const active = job && ACTIVE.includes(job.state);
    const key = active ? job.state : '';
    if (force || box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = active ? `<span></span><div class="progress ${job.state === 'installing' ? '' : 'indeterminate'}"><span></span></div>` : '';
    }
    if (active) {
      box.firstElementChild.textContent = jobLabel(job);
      box.querySelector('.progress > span').style.width = `${percent(job)}%`;
    }
  }
}

function consoleItems() {
  const q = query.trim().toLowerCase();
  return state.console.items.filter(i =>
    (filter === 'all' || i.kind === filter || (filter === 'patch' && i.patchVersion) || (filter === 'dlc' && i.dlcCount)) &&
    (!q || [i.title, i.titleId].some(v => v && v.toLowerCase().includes(q))));
}

function renderConsole() {
  const c = state.console;
  const grid = $('#consoleGrid'), status = $('#consoleStatus');
  const loading = c.state === 'loading' || (c.state === 'idle' && state.config.ps4Ip);
  let statusHtml = '';
  if (!state.config.ps4Ip) statusHtml = '<h2>Configure o IP do PS4</h2><p>Clique no indicador de status no topo da janela.</p>';
  else if (loading) {
    const p = c.total ? (c.done / c.total) * 100 : 0;
    statusHtml = `<div class="spinner"></div><h2>Lendo os jogos do PS4…</h2>
      <p>${c.total ? `${c.done} de ${c.total}` : 'Conectando ao FTP do GoldHEN'}</p>
      <div class="progress loading-bar ${c.total ? '' : 'indeterminate'}"><span style="width:${p}%"></span></div>`;
  } else if (c.state === 'error') statusHtml = `<h2>Não consegui ler o PS4</h2><p>${esc(c.error)}</p>
      <button class="btn primary" data-action="refreshConsole">Tentar de novo</button>`;
  status.hidden = view !== 'ps4' || !statusHtml;
  if (statusHtml && status.dataset.html !== statusHtml) { status.innerHTML = statusHtml; status.dataset.html = statusHtml; }
  grid.hidden = view !== 'ps4' || !!statusHtml;
  if (statusHtml) return;
  const items = consoleItems();
  const key = JSON.stringify([filter, query, c.updatedAt, items.map(i => i.titleId)]);
  if (key === consoleKey) return;
  consoleKey = key;
  grid.innerHTML = items.length ? items.map(i => {
    const extras = [i.patchVersion && 'Com atualização', i.dlcCount && `${i.dlcCount} DLC`].filter(Boolean);
    return `
    <article class="card" data-title="${i.titleId}" tabindex="0" title="${esc(i.titleId)}">
      <div class="tile-art">${consoleCover(i)}</div>
      <h3>${esc(i.title)}</h3>
      <div class="meta">${[esc(i.kindLabel), i.version && `v${esc(i.version)}`, i.size && bytes(i.size)].filter(Boolean).join(' · ')}</div>
      ${extras.length ? `<div class="meta state">${extras.join(' · ')}</div>` : ''}
    </article>`;
  }).join('') : '<p class="empty">Nada encontrado para essa busca.</p>';
}

// Space used per category. The PS4 does not report free space over FTP,
// so the bar splits what is used instead of showing a capacity.
let storageKey = '';
function renderStorage() {
  const box = $('#storage');
  const parts = state.console.state === 'ready' ? state.console.storage || [] : [];
  const key = JSON.stringify(parts);
  if (key === storageKey) return;
  storageKey = key;
  const used = parts.reduce((total, p) => total + p.size, 0);
  box.innerHTML = used ? `
    <div class="storage-head"><strong>${bytes(used)} usados</strong>
      <span>O PS4 não informa o espaço livre pela rede</span></div>
    <div class="storage-bar">${parts.filter(p => p.size).map(p =>
      `<span class="s-${p.key}" style="flex:${p.size}" title="${p.label}: ${bytes(p.size)}"></span>`).join('')}</div>
    <ul class="storage-legend">${parts.map(p => `<li><i class="s-${p.key}"></i>${p.label} <b>${bytes(p.size)}</b></li>`).join('')}</ul>` : '';
}

// ---------- details panel (PS4 "Options" menu) ----------
let detail = null, detailKey = '';
function openDetails(target) {
  detail = target; detailKey = '';
  renderDetails();
  if (detail) { $('#details').showModal(); $('#details .menu-item:not(:disabled)')?.focus(); }
}
$('#details').addEventListener('close', () => { detail = null; });

function detailsHead(bg, coverHtml, title, sub) {
  return `<div class="d-head">
    ${bg ? `<div class="hero-bg" style="background-image:url(${bg})"></div>` : ''}
    ${coverHtml}<h2>${esc(title)}</h2><p>${sub}</p></div>`;
}
const infoList = rows => `<dl class="info">${rows.filter(r => r[1]).map(([k, v, cls]) =>
  `<dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('')}</dl>`;
const closeItem = `<button class="menu-item" value="close">${ICON.close}Fechar</button>`;

function renderDetails() {
  if (!detail || !state) return;
  const body = $('#detailsBody');
  if (detail.id) {
    const item = itemById(detail.id);
    if (!item) { detail = null; return $('#details').open && $('#details').close(); }
    const job = latestJob(item.id);
    const active = job && ACTIVE.includes(job.state);
    const key = JSON.stringify([item, active && job.state]);
    if (key !== detailKey) {
      detailKey = key;
      const bg = item.hasPic ? `/api/pic/${item.id}` : item.hasIcon ? `/api/icon/${item.iconId}` : '';
      body.innerHTML = detailsHead(bg, cover(item), item.title, `${esc(item.kindLabel)}${item.version ? ` · v${esc(item.version)}` : ''}`) +
        (active ? `<div class="d-progress"><div class="progress ${job.state === 'installing' ? '' : 'indeterminate'}"><span></span></div><span id="detailsProgress"></span></div>` : '') +
        `<div class="menu">
          ${!active ? `<button type="button" class="menu-item" data-action="install" data-id="${item.id}" ${item.error ? 'disabled' : ''}>${ICON.install}${item.installed ? 'Reinstalar no PS4' : 'Instalar no PS4'}</button>` : ''}
          ${active && job.state === 'queued' ? `<button type="button" class="menu-item" data-action="cancel" data-job="${job.id}">${ICON.close}Remover da fila</button>` : ''}
          <button type="button" class="menu-item" data-action="remove" data-id="${item.id}" ${active ? 'disabled' : ''}>${ICON.trash}Remover da biblioteca</button>
          ${closeItem}
        </div>` +
        infoList([
          ['Situação', item.error ? esc(item.error) : item.installed ? `Instalado no PS4${item.installedVersion ? ` (v${esc(item.installedVersion)})` : ''}`
            : item.newer ? `Mais nova que a do PS4 (v${esc(item.installedVersion)})` : 'Não instalado', item.error ? 'error' : ''],
          ['CUSA', esc(item.titleId)],
          ['Content ID', esc(item.contentId)],
          ['Versão', item.version && `v${esc(item.version)}`],
          ['Tamanho', bytes(item.size)],
          ['Firmware', item.firmware && esc(item.firmware)],
          ['Arquivo', esc(item.path)],
        ]);
    }
    if (active) {
      body.querySelector('.d-progress .progress > span').style.width = `${percent(job)}%`;
      $('#detailsProgress').textContent = job.state === 'installing'
        ? `${percent(job).toFixed(1)}% · ${bytes(job.transferred)} de ${bytes(job.total)}${job.eta ? ` · faltam ${duration(job.eta)}` : ''}`
        : jobLabel(job);
    }
  } else {
    const item = consoleById(detail.titleId);
    if (!item) { detail = null; return $('#details').open && $('#details').close(); }
    const key = JSON.stringify(item);
    if (key === detailKey) return;
    detailKey = key;
    body.innerHTML = detailsHead(item.hasIcon ? `/api/console-icon/${item.titleId}` : '', consoleCover(item), item.title,
      `${esc(item.kindLabel)}${item.version ? ` · v${esc(item.version)}` : ''}`) +
      `<div class="menu">
        <button type="button" class="menu-item" data-action="uninstall" data-title="${item.titleId}">${ICON.trash}Excluir do PS4…</button>
        ${closeItem}
      </div>` +
      infoList([
        ['CUSA', esc(item.titleId)],
        ['Versão do jogo', item.baseVersion && `v${esc(item.baseVersion)}`],
        ['Atualização', item.patchVersion && `v${esc(item.patchVersion)}`],
        ['DLCs', item.dlcCount && `${item.dlcCount}${item.dlcSize ? ` · ${bytes(item.dlcSize)}` : ''}`],
        ['Espaço ocupado', item.size && bytes(item.size)],
      ]);
  }
}

// ---------- uninstall ----------
let uninstallTarget = null, uninstallBusy = false;
function openUninstall(titleId) {
  const item = consoleById(titleId);
  if (!item) return;
  uninstallTarget = item;
  if ($('#details').open) $('#details').close();
  $('#uninstallItem').innerHTML = `${consoleCover(item)}<div><strong>${esc(item.title)}</strong>
    <span>${esc(item.titleId)}${item.version ? ` · v${esc(item.version)}` : ''} · ${bytes(item.size)}</span></div>`;
  $('#uninstallChoices').innerHTML = `
    <label class="choice"><input type="radio" name="what" value="game" checked>
      <span><strong>Excluir o jogo</strong><small>Remove o jogo e a atualização instalada, liberando cerca de ${bytes(item.size)}.</small></span></label>
    ${item.patchVersion ? `<label class="choice"><input type="radio" name="what" value="patch">
      <span><strong>Excluir só a atualização v${esc(item.patchVersion)}</strong><small>O jogo continua instalado, na versão v${esc(item.baseVersion || '01.00')}.</small></span></label>` : ''}`;
  updateUninstall();
  $('#uninstall').showModal();
}
function updateUninstall() {
  // The uninstall payload covers a closed Remote Package Installer.
  const offline = state?.ps4.state !== 'online' && !(state?.ps4.state === 'noinstaller' && state.dpiUninstall);
  $('#uninstallOffline').hidden = !offline;
  const btn = $('#confirmUninstall');
  btn.disabled = offline || uninstallBusy;
  btn.textContent = uninstallBusy ? 'Excluindo…' : 'Excluir do PS4';
}
$('#confirmUninstall').addEventListener('click', async () => {
  if (!uninstallTarget || uninstallBusy) return;
  const what = $('#uninstallForm').querySelector('input[name=what]:checked')?.value || 'game';
  uninstallBusy = true; updateUninstall();
  try {
    await api('/api/console/uninstall', {titleId: uninstallTarget.titleId, what});
    toast(what === 'patch' ? `Atualização de ${uninstallTarget.title} excluída.` : `${uninstallTarget.title} foi excluído do PS4.`, 'success');
    $('#uninstall').close();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    uninstallBusy = false; updateUninstall(); refresh();
  }
});
$('#uninstall').addEventListener('close', () => { if (!uninstallBusy) uninstallTarget = null; });

function renderView() {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('[data-for]').forEach(el => { el.hidden = el.dataset.for !== view; });
  $('#grid').hidden = view !== 'pc';
  if (view !== 'pc') $('#empty').hidden = true;
  $('#viewTitle').textContent = view === 'pc' ? 'No PC' : 'No PS4';
  $('#countPc').textContent = state.library.length || '';
  const c = state.console;
  $('#countPs4').textContent = c.state === 'ready' ? c.items.length : '';
  const list = view === 'pc' ? state.library : c.items;
  const total = list.reduce((sum, i) => sum + (i.size || 0), 0);
  const games = list.filter(i => i.kind === 'game').length;
  $('#summary').textContent = list.length ? `${games} jogo(s) · ${list.length - games} outro(s) · ${bytes(total)}`
    + (view === 'ps4' && c.refreshing && c.state === 'ready' ? ' · atualizando…' : '') : '';
}

function renderActivity() {
  const box = $('#activity');
  const jobs = state.jobs;
  box.hidden = !jobs.length;
  if (!jobs.length) { activityKey = ''; box.innerHTML = ''; return; }
  const current = jobs.find(j => j.state === 'starting' || j.state === 'installing');
  const others = jobs.filter(j => j !== current).slice().reverse();
  const key = JSON.stringify([current?.id, current?.state, others.map(j => [j.id, j.state])]);
  if (key !== activityKey) {
    activityKey = key;
    const item = current && itemById(current.pkgId);
    box.innerHTML = (current ? `
      <h4>Instalando</h4>
      <div class="hero">
        ${item?.hasPic ? `<div class="hero-bg" style="background-image:url(/api/pic/${item.id})"></div>` : item?.hasIcon ? `<div class="hero-bg" style="background-image:url(/api/icon/${item.iconId})"></div>` : ''}
        <div class="hero-body">
          ${cover(item || {title: current.title})}
          <div class="hero-info">
            <h2>${esc(current.title)}</h2>
            <div class="hero-state" id="heroState"></div>
            <div class="progress" id="heroBar"><span></span></div>
            <div class="hero-stats" id="heroStats"></div>
          </div>
        </div>
      </div>` : '') +
      (others.length ? `<div class="queue-head"><h4 class="section-label">Fila e histórico</h4>
        ${others.some(j => !ACTIVE.includes(j.state)) ? '<button class="btn small" data-action="clear">Limpar concluídos</button>' : ''}</div>` : '') +
      `<div class="queue">` + others.map(j => {
        const it = itemById(j.pkgId);
        const sub = j.state === 'queued' ? 'Aguardando a vez' : j.state === 'done' ? 'Instalação enviada ao PS4 com sucesso' : esc(j.error);
        return `<div class="queue-row ${j.state}">${cover(it || {title: j.title})}
          <div class="q-title">${esc(j.title)}<span class="q-sub">${sub}</span></div>
          ${j.state === 'queued' ? `<button class="btn small" data-action="cancel" data-job="${j.id}">Remover</button>` : ''}
          ${j.state === 'error' ? `<button class="btn small" data-action="retry" data-id="${j.pkgId}">Tentar de novo</button>` : ''}
        </div>`;
      }).join('') + `</div>`;
  }
  if (current) {
    const p = percent(current);
    $('#heroState').textContent = current.state === 'starting' ? 'Enviando pedido ao PS4…' : `Instalando · ${p.toFixed(1)}%`;
    $('#heroBar').classList.toggle('indeterminate', current.state === 'starting');
    $('#heroBar > span').style.width = `${p}%`;
    $('#heroStats').innerHTML = current.state === 'installing' ? `
      <span><strong>${bytes(current.transferred)}</strong> de ${bytes(current.total)}</span>
      ${current.speed ? `<span><strong>${bytes(current.speed)}/s</strong></span>` : ''}
      ${current.eta ? `<span>faltam <strong>${duration(current.eta)}</strong></span>` : ''}` : '<span>Aguardando o PS4 aceitar o pacote</span>';
  }
}

let lastJobStates = {};
function notifyTransitions() {
  for (const j of state.jobs) {
    const before = lastJobStates[j.id];
    if (before && before !== j.state) {
      if (j.state === 'done') toast(`${j.title}: instalação concluída.`, 'success');
      if (j.state === 'error') toast(`${j.title}: ${j.error}`, 'error');
    }
    lastJobStates[j.id] = j.state;
  }
}

let refreshing = false, failures = 0;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api('/api/state');
  } catch {
    // One failed poll is not a closed app; wait for a few in a row.
    if (++failures >= 3) { serverDown = true; if (state) renderStatus(); }
    return;
  } finally {
    refreshing = false;
  }
  failures = 0; serverDown = false;
  // The server was replaced by a newer version: load its interface too.
  if (refresh.version && state.version !== refresh.version) return location.reload();
  refresh.version = state.version;
  {
    notifyTransitions();
    // One failing section must not freeze the rest of the screen.
    for (const render of [renderStatus, renderGrid, renderActivity, renderCardStates, renderConsole, renderStorage, renderView, renderDetails, updateUninstall]) {
      try { render(); } catch (e) { console.error(e); }
    }
    if (state.ps4.state === 'unconfigured' && !refresh.prompted) { refresh.prompted = true; openSettings(); }
  }
}

// ---------- actions ----------
async function run(action, fn) {
  try { return await fn(); } catch (e) { toast(e.message, 'error'); } finally { refresh(); }
}
async function addFiles() {
  await run('add', async () => { const r = await api('/api/add-files', {}); if (r.added) toast(`${r.added} PKG(s) adicionado(s).`, 'success'); });
}
async function addFolder() {
  await run('folder', async () => { const r = await api('/api/add-folder', {}); if (r.folder) toast('Pasta adicionada à biblioteca.', 'success'); });
}

function openSettings() {
  const form = $('#settingsForm');
  form.ps4Ip.value = state?.config.ps4Ip || '';
  form.rpiPort.value = state?.config.rpiPort || 12800;
  $('#lanIp').textContent = state?.lanIp || 'rede não encontrada';
  const folders = state?.config.folders || [];
  $('#folderList').innerHTML = folders.length
    ? folders.map(f => `<li><span>${esc(f)}</span><button type="button" class="btn ghost small" data-action="removeFolder" data-folder="${esc(f)}">Remover</button></li>`).join('')
    : '<li class="none">Nenhuma pasta adicionada</li>';
  $('#settings').showModal();
}

$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return;
  const form = $('#settingsForm');
  run('config', async () => {
    await api('/api/config', {ps4Ip: form.ps4Ip.value, rpiPort: form.rpiPort.value});
    toast('Configurações salvas.', 'success');
  });
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action], #addFiles, #addFolder, #rescan, #refreshConsole, #ps4Status, .chip, .tab, .card');
  if (!el) return;
  if (el.classList.contains('card')) return openDetails(el.dataset.id ? {id: el.dataset.id} : {titleId: el.dataset.title});
  if (el.classList.contains('tab')) {
    view = el.dataset.view;
    history.replaceState(null, '', view === 'ps4' ? '#ps4' : '#');
    gridKey = consoleKey = '';
    return refresh();
  }
  if (el.classList.contains('chip')) {
    filter = el.dataset.kind;
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === el));
    renderGrid(); renderConsole();
    return;
  }
  switch (el.id || el.dataset.action) {
    case 'addFiles': return addFiles();
    case 'addFolder': return addFolder();
    case 'rescan': return run('rescan', () => api('/api/rescan', {}));
    case 'refreshConsole': return run('console', () => api('/api/console/refresh', {}));
    case 'uninstall': return openUninstall(el.dataset.title);
    case 'ps4Status': return openSettings();
    case 'install':
      if (state.ps4.state !== 'online' && !(state.ps4.state === 'noinstaller' && state.dpi)) toast('O PS4 não está respondendo agora. O pacote entra na fila mesmo assim.', '');
      // Get the panel out of the way so the progress at the top is visible.
      if ($('#details').open) $('#details').close();
      return run('install', () => api('/api/install', {id: el.dataset.id}));
    case 'retry': return run('install', () => api('/api/install', {id: el.dataset.id}));
    case 'remove':
      $('#details').close();
      return run('remove', () => api('/api/remove', {id: el.dataset.id}));
    case 'cancel': return run('cancel', () => api('/api/cancel', {jobId: Number(el.dataset.job)}));
    case 'clear': return run('clear', () => api('/api/clear-finished', {}));
    case 'removeFolder':
      el.closest('li').remove();
      return run('folder', () => api('/api/remove-folder', {folder: el.dataset.folder}));
  }
});

$('#search').addEventListener('input', e => { query = e.target.value; renderGrid(); renderConsole(); });

// Tiles work like the PS4 library: arrows move the focus, Enter opens the options.
document.addEventListener('keydown', e => {
  const card = e.target.closest?.('.card');
  if (!card) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return card.click(); }
  const cards = [...card.parentElement.querySelectorAll('.card')];
  const i = cards.indexOf(card);
  const cols = cards.filter(c => c.offsetTop === cards[0].offsetTop).length;
  const next = {ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols}[e.key];
  if (next === undefined) return;
  e.preventDefault();
  cards[next]?.focus();
});

function tick() { $('#clock').textContent = new Date().toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'}); }
tick();
setInterval(tick, 5000);

refresh();
setInterval(refresh, 1000);
