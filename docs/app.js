/* Netflix PL – moja lista. Zwykły JavaScript, bez bibliotek. */
(function () {
  'use strict';

  var PAGE = 40;
  var WORKFLOW = 'update.yml';
  var $ = function (id) { return document.getElementById(id); };

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* brak miejsca */ } }
  };

  var DEFAULTS = { q: '', kind: 'all', genre: '', show: 'all', by: 'fw', min: 0, sort: 'rating' };
  var DATA = { meta: {}, items: [], removed: [] };
  var BY_ID = {};
  var seen = new Set(store.get('seen', []));
  var st = Object.assign({}, DEFAULTS, store.get('filters', {}));
  var fs = store.get('fs', 1.15);
  var limit = PAGE;
  var current = [];
  var pollTimer = null;

  /* ---------- pomocnicze ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) {
    return String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
  }
  function num(x) { return (Math.round(x * 10) / 10).toFixed(1).replace('.', ','); }
  function votes(v) {
    if (!v) return '';
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' mln';
    if (v >= 1000) return Math.round(v / 1000) + ' tys.';
    return String(v);
  }
  function isoDaysAgo(n) { var d = new Date(Date.now() - n * 864e5); return d.toISOString().slice(0, 10); }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function rating(it) { return st.by === 'fw' ? it.fr : it.ir; }
  function rVotes(it) { return st.by === 'fw' ? (it.fv || 0) : (it.iv || 0); }
  function isNew(it) {
    var first = DATA.meta.first || '';
    return it.add && it.add > first && it.add >= isoDaysAgo(7);
  }

  /* ---------- status ---------- */
  function setStatus(msg, isErr) {
    var el = $('status');
    if (!msg) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = 'status' + (isErr ? ' err' : '');
  }

  /* ---------- czcionka ---------- */
  function applyFont() {
    fs = Math.min(1.9, Math.max(0.9, Math.round(fs * 100) / 100));
    document.documentElement.style.setProperty('--fs', fs);
    store.set('fs', fs);
  }

  /* ---------- dane ---------- */
  function loadData() {
    return fetch('data.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        DATA = { meta: d.meta || {}, items: d.items || [], removed: d.removed || [] };
        BY_ID = {};
        DATA.items.forEach(function (it) { BY_ID[it.id] = it; });
        DATA.removed.forEach(function (it) { if (!BY_ID[it.id]) BY_ID[it.id] = it; });
        fillGenres();
        showHeader();
        render(true);
      })
      .catch(function () {
        $('stamp').textContent = 'Nie udało się wczytać listy. Sprawdź internet i spróbuj ponownie.';
        render(true);
      });
  }

  function showHeader() {
    var m = DATA.meta;
    if (!m.updated) { $('stamp').textContent = 'Lista jeszcze nie została pobrana.'; return; }
    var t = 'Stan na ' + fmtDate(m.updated) + ' · ' + (m.movies || 0) + ' filmów, ' + (m.series || 0) + ' seriali';
    if (m.added_today || m.removed_today) t += ' · nowe: ' + (m.added_today || 0) + ', usunięte: ' + (m.removed_today || 0);
    $('stamp').textContent = t;
    var n = $('notice');
    if (m.fw_ok === false) {
      n.hidden = false;
      n.textContent = 'Oceny Filmweb chwilowo nie są aktualizowane. Pokazuję ostatnie znane – przy każdym tytule masz przycisk „Filmweb”.';
    } else n.hidden = true;
  }

  function fillGenres() {
    var set = {};
    DATA.items.forEach(function (it) { (it.g || []).forEach(function (g) { set[g] = 1; }); });
    var names = Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'pl'); });
    var sel = $('genre');
    sel.innerHTML = '<option value="">Wszystkie</option>' +
      names.map(function (g) { return '<option>' + esc(g) + '</option>'; }).join('');
    if (st.genre && !set[st.genre]) st.genre = '';
    sel.value = st.genre;
  }

  /* ---------- filtrowanie i sortowanie ---------- */
  function compute() {
    var q = norm(st.q);
    var src = st.show === 'removed' ? DATA.removed : DATA.items;
    var newSince = isoDaysAgo(7);
    var list = src.filter(function (it) {
      if (st.kind !== 'all' && it.k !== st.kind) return false;
      if (q && norm(it.t).indexOf(q) < 0 && norm(it.o).indexOf(q) < 0) return false;
      if (st.show === 'removed') return true;
      if (st.genre && (it.g || []).indexOf(st.genre) < 0) return false;
      if (st.show === 'unseen' && seen.has(it.id)) return false;
      if (st.show === 'seen' && !seen.has(it.id)) return false;
      if (st.show === 'new' && !(isNew(it) && it.add >= newSince)) return false;
      if (st.min > 0) { var r = rating(it); if (!(r >= st.min)) return false; }
      return true;
    });
    var cmp;
    if (st.show === 'removed') cmp = function (a, b) { return (b.rm || '').localeCompare(a.rm || ''); };
    else if (st.sort === 'rating') cmp = function (a, b) { return (rating(b) || 0) - (rating(a) || 0) || rVotes(b) - rVotes(a); };
    else if (st.sort === 'pop') cmp = function (a, b) { return (b.pop || 0) - (a.pop || 0); };
    else if (st.sort === 'new') cmp = function (a, b) { return (b.add || '').localeCompare(a.add || '') || (b.pop || 0) - (a.pop || 0); };
    else if (st.sort === 'year') cmp = function (a, b) { return (b.y || 0) - (a.y || 0) || (b.pop || 0) - (a.pop || 0); };
    else cmp = function (a, b) { return a.t.localeCompare(b.t, 'pl'); };
    return list.sort(cmp);
  }

  /* ---------- wyświetlanie ---------- */
  function linksHtml(it) {
    var fw = it.fu ? 'https://www.filmweb.pl/' + it.fu
      : 'https://www.filmweb.pl/search#/?query=' + encodeURIComponent(it.t);
    var imdb = it.imdb ? 'https://www.imdb.com/title/' + it.imdb + '/'
      : 'https://www.imdb.com/find/?q=' + encodeURIComponent((it.o || it.t) + (it.y ? ' ' + it.y : ''));
    var nf = 'https://www.netflix.com/search?q=' + encodeURIComponent(it.t);
    return '<div class="links">' +
      '<a class="fw" href="' + esc(fw) + '" target="_blank" rel="noopener">Filmweb</a>' +
      '<a class="imdb" href="' + esc(imdb) + '" target="_blank" rel="noopener">IMDb</a>' +
      '<a class="nf" href="' + esc(nf) + '" target="_blank" rel="noopener">Netflix</a></div>';
  }

  function cardHtml(it) {
    var isSeen = seen.has(it.id);
    var removed = st.show === 'removed';
    var genres = (it.g || []).slice(0, 3).join(', ');
    var meta = [it.k === 'm' ? 'Film' : 'Serial', it.y || '', genres].filter(Boolean).join(' · ');
    var rates = '';
    rates += '<span class="rate fw">Filmweb <b>' + (it.fr ? num(it.fr) : '–') + '</b>' +
      (it.fv ? ' <small>(' + votes(it.fv) + ')</small>' : '') + '</span>';
    rates += '<span class="rate imdb">IMDb <b>' + (it.ir ? num(it.ir) : '–') + '</b>' +
      (it.iv ? ' <small>(' + votes(it.iv) + ')</small>' : '') + '</span>';
    var poster = it.p ? '<img class="poster" loading="lazy" alt="" src="https://image.tmdb.org/t/p/w154' + esc(it.p) + '">'
      : '<div class="poster" aria-hidden="true"></div>';
    var badge = removed ? '<span class="badge rm">usunięty ' + esc((it.rm || '').split('-').reverse().join('.')) + '</span>'
      : (isNew(it) ? '<span class="badge">NOWE</span>' : '');
    var orig = it.o && norm(it.o) !== norm(it.t) ? '<div class="orig">' + esc(it.o) + '</div>' : '';
    return '<article class="card' + (isSeen ? ' seen' : '') + '" data-id="' + esc(it.id) + '">' +
      '<div class="card-main" role="button" tabindex="0" aria-expanded="false">' + poster +
      '<div class="info"><h2 class="title">' + esc(it.t) + badge + '</h2>' + orig +
      '<div class="meta">' + esc(meta) + '</div><div class="rates">' + rates + '</div></div></div>' +
      '<button type="button" class="seen-btn" aria-pressed="' + isSeen + '">' +
      (isSeen ? '✓ Widziane' : 'Oznacz jako widziane') + '</button>' +
      '<div class="details" hidden>' + (it.d ? '<p>' + esc(it.d) + '</p>' : '') + linksHtml(it) + '</div>' +
      '</article>';
  }

  function render(reset) {
    if (reset) { limit = PAGE; current = compute(); }
    var list = $('list');
    if (!DATA.items.length && !DATA.removed.length) {
      list.innerHTML = '<p class="empty">Lista jest pusta. Naciśnij ⟳, aby pobrać katalog Netflix (pierwsze pobranie może potrwać do ok. godziny).</p>';
      $('count').textContent = '';
      $('more').hidden = true;
      return;
    }
    if (!current.length) {
      list.innerHTML = '<p class="empty">Brak tytułów spełniających filtry.</p>';
    } else {
      list.innerHTML = current.slice(0, limit).map(cardHtml).join('');
    }
    $('count').textContent = 'Znaleziono: ' + current.length + (current.length > limit ? ' (pokazuję ' + limit + ')' : '');
    var more = $('more');
    more.hidden = current.length <= limit;
    more.textContent = 'Pokaż więcej (' + Math.min(PAGE, current.length - limit) + ')';
    summary();
  }

  function summary() {
    var active = 0;
    Object.keys(DEFAULTS).forEach(function (k) { if (k !== 'q' && k !== 'sort' && k !== 'by' && String(st[k]) !== String(DEFAULTS[k])) active++; });
    $('filtersSummary').textContent = 'Filtry i sortowanie' + (active ? ' (aktywne: ' + active + ')' : '');
  }

  function saveFilters() { store.set('filters', st); }

  /* ---------- widziane ---------- */
  function toggleSeen(card) {
    var id = card.getAttribute('data-id');
    if (seen.has(id)) seen.delete(id); else seen.add(id);
    store.set('seen', Array.from(seen));
    var on = seen.has(id);
    card.classList.toggle('seen', on);
    var b = card.querySelector('.seen-btn');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? '✓ Widziane' : 'Oznacz jako widziane';
  }

  /* ---------- aktualizacja przez GitHub ---------- */
  function repoName() {
    var saved = store.get('repo', '');
    if (saved) return saved;
    var h = location.hostname;
    if (h.slice(-10) !== '.github.io') return '';
    var owner = h.split('.')[0];
    var first = location.pathname.split('/').filter(Boolean)[0];
    return owner + '/' + (first || owner + '.github.io');
  }

  function gh(path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + store.get('token', ''), 'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + repoName() + path, { method: opts.method || 'GET', headers: headers, body: opts.body, cache: 'no-store' });
  }

  function busy(on) { $('btnUpdate').classList.toggle('busy', !!on); }

  function startUpdate() {
    if (!store.get('token', '') || !repoName()) {
      openSettings();
      setStatus('Aby aktualizować z telefonu, wpisz najpierw token GitHub (instrukcja, krok 9).', true);
      return;
    }
    if (store.get('pending', null)) { setStatus('Aktualizacja już trwa – lista odświeży się sama.'); return; }
    setStatus('Uruchamiam aktualizację…');
    busy(true);
    var since = new Date(Date.now() - 60000).toISOString();
    gh('/actions/workflows/' + WORKFLOW + '/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) })
      .then(function (r) {
        if (r.status === 204) {
          store.set('pending', since);
          setStatus('Aktualizacja uruchomiona. Zwykle trwa 5–30 minut – lista odświeży się sama, gdy aplikacja jest otwarta.');
          schedulePoll(15000);
          return;
        }
        busy(false);
        var why = r.status === 401 ? 'token jest błędny lub wygasł'
          : r.status === 403 ? 'token nie ma uprawnienia „Actions: Read and write”'
          : r.status === 404 ? 'nie znaleziono repozytorium lub token nie ma do niego dostępu'
          : 'kod ' + r.status;
        setStatus('Nie udało się uruchomić aktualizacji: ' + why + '.', true);
      })
      .catch(function () { busy(false); setStatus('Brak połączenia z GitHub. Sprawdź internet.', true); });
  }

  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }

  function poll() {
    var since = store.get('pending', null);
    if (!since) { busy(false); return; }
    if (Date.now() - new Date(since).getTime() > 4 * 3600e3) {
      store.set('pending', null); busy(false);
      setStatus('Aktualizacja trwa zbyt długo. Sprawdź zakładkę Actions w repozytorium.', true);
      return;
    }
    busy(true);
    gh('/actions/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&per_page=1')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) {
        var run = (j.workflow_runs || [])[0];
        if (!run || run.created_at < since) { setStatus('Czekam na start aktualizacji…'); schedulePoll(20000); return; }
        if (run.status !== 'completed') {
          setStatus('Aktualizacja w toku (start ' + fmtDate(run.created_at) + '). Lista odświeży się sama.');
          schedulePoll(30000); return;
        }
        store.set('pending', null); busy(false);
        if (run.conclusion === 'success') {
          setStatus('Zaktualizowano. Wczytuję nową listę…');
          loadData().then(function () { setStatus('Lista zaktualizowana.'); setTimeout(function () { setStatus(''); }, 6000); });
        } else {
          setStatus('Aktualizacja nie powiodła się (' + run.conclusion + '). Szczegóły: GitHub → repozytorium → Actions.', true);
        }
      })
      .catch(function () { setStatus('Sprawdzam stan aktualizacji… (brak odpowiedzi, ponowię)'); schedulePoll(30000); });
  }

  /* ---------- ustawienia ---------- */
  function openSettings() {
    $('token').value = store.get('token', '');
    $('repo').value = repoName();
    $('seenInfo').textContent = 'Oznaczonych jako widziane: ' + seen.size + '.';
    var d = $('settings');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeSettings() { var d = $('settings'); if (d.close) d.close(); else d.removeAttribute('open'); }

  /* ---------- zdarzenia ---------- */
  function bind() {
    var q = $('q');
    q.value = st.q;
    var qt = null;
    q.addEventListener('input', function () {
      clearTimeout(qt);
      qt = setTimeout(function () { st.q = q.value; saveFilters(); render(true); }, 250);
    });
    ['kind', 'genre', 'show', 'by', 'min', 'sort'].forEach(function (k) {
      var el = $(k);
      el.value = String(st[k]);
      if (el.value !== String(st[k])) { st[k] = DEFAULTS[k]; el.value = String(st[k]); }
      el.addEventListener('change', function () {
        st[k] = k === 'min' ? (parseFloat(el.value) || 0) : el.value;
        saveFilters(); render(true);
      });
    });
    $('btnReset').addEventListener('click', function () {
      st = Object.assign({}, DEFAULTS, { by: st.by });
      ['kind', 'genre', 'show', 'by', 'min', 'sort'].forEach(function (k) { $(k).value = String(st[k]); });
      $('q').value = '';
      saveFilters(); render(true);
    });
    $('more').addEventListener('click', function () { limit += PAGE; render(false); });
    $('list').addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      if (e.target.closest('.seen-btn')) { toggleSeen(card); return; }
      var main = e.target.closest('.card-main');
      if (main) {
        var det = card.querySelector('.details');
        det.hidden = !det.hidden;
        main.setAttribute('aria-expanded', String(!det.hidden));
      }
    });
    $('list').addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card-main')) { e.preventDefault(); e.target.click(); }
    });
    $('btnSmaller').addEventListener('click', function () { fs -= 0.1; applyFont(); });
    $('btnBigger').addEventListener('click', function () { fs += 0.1; applyFont(); });
    $('btnUpdate').addEventListener('click', startUpdate);
    $('btnSettings').addEventListener('click', openSettings);
    $('btnClose').addEventListener('click', closeSettings);
    $('settingsForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('btnSave').addEventListener('click', function () {
      store.set('token', $('token').value.trim());
      var repo = $('repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
      store.set('repo', /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '');
      closeSettings();
      setStatus('Zapisano ustawienia.');
      setTimeout(function () { setStatus(''); }, 3000);
    });
  }

  applyFont();
  bind();
  loadData();
  if (store.get('pending', null)) schedulePoll(2000);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
