/* 저녁픽 앱 — 화면/상호작용. 추천 계산은 core.js, 저장/인증은 worker/worker.mjs */
(function () {
  'use strict';

  var Core = window.DPCore, MENUS = window.DPMenus.MENUS, DM = window.DPMenus, CFG = window.DP_CONFIG || {};
  var MENU_BY_ID = {};
  MENUS.forEach(function (m) { MENU_BY_ID[m.id] = m; });
  var LOCAL = ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1;
  var API = LOCAL ? '' : String(CFG.API_BASE || '').replace(/\/$/, '');
  var API_CONFIGURED = LOCAL || (API && !/YOUR-SUBDOMAIN/.test(API));
  var $app = document.getElementById('app');

  var PRICE_OPTS = [
    { id: 'any', label: '상관없음', min: null, max: null },
    { id: 'u10', label: '~1만원', min: null, max: 10000 },
    { id: '10', label: '1~1.5만', min: 10000, max: 15000 },
    { id: '15', label: '1.5~2만', min: 15000, max: 20000 },
    { id: '20', label: '2~3만', min: 20000, max: 30000 },
    { id: '30', label: '3만 이상', min: 30000, max: null }
  ];
  var WC_SIZE = 96, WC_QUICK = 16;

  // ------------------------------------------------------------------ 유틸
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 사생활 보호 모드 등 */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };

  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  // 모든 사용자/외부 문자열은 textNode로만 들어간다(innerHTML 미사용)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function ico(name, fill) { return h('i', { class: (fill ? 'ph-fill ph-' : 'ph ph-') + name }); }
  function won(n) { return Core.fmtWon(n); }
  function distText(m) { return m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km'; }
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  function dateText(at) {
    var d = new Date(at), days = Math.floor((Date.now() - at) / 86400000);
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + DOW[d.getDay()] + ')' + (days <= 0 ? ' · 오늘' : ' · ' + days + '일 전');
  }
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.appendChild(el); }
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }
  function copyText(text) {
    var done = function () { toast('복사했어요: ' + text); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('복사해서 쓰세요', text); });
    else window.prompt('복사해서 쓰세요', text);
  }

  // ------------------------------------------------------------------ 상태
  var S = {
    view: 'boot', tab: 'pick', token: store.get('dp_token') || '', error: '', busy: false,
    authMode: 'login', authDraft: { hm: 'create' },
    me: null, household: null, members: [], history: [],
    cond: null, result: null, shown: {}, ignoreRecent: false, rest: { status: 'idle' }, chosenRest: null,
    wc: null, wcStage: 'intro'
  };

  function applyState(d) { S.me = d.me; S.household = d.household; S.members = d.members; S.history = d.history; }
  function settings() { return S.household.settings; }
  function myPrefs() {
    var m = S.members.filter(function (x) { return x.uid === S.me.uid; })[0];
    return m ? m.prefs : { scores: {}, feedback: {}, wc: { runs: 0 } };
  }

  function api(method, path, body) {
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.error || '요청에 실패했어요 (' + res.status + ')'); e.status = res.status; throw e; }
        return data;
      });
    }, function () {
      var e = new Error('서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.'); e.network = true; throw e;
    });
  }
  function refresh() { return api('GET', '/api/state').then(applyState); }
  function fail(e) {
    if (e && e.status === 401) { logoutLocal(); return; }
    toast((e && e.message) || '문제가 생겼어요');
  }

  // ------------------------------------------------------------------ 조건(필터)
  function defaultCond() {
    return { headcount: S.household ? settings().defaultHeadcount : 2, priceId: 'any', cats: [], tastes: [], forms: [] };
  }
  function loadCond() {
    var c = defaultCond();
    try {
      var saved = JSON.parse(store.get('dp_cond') || 'null');
      if (saved) {
        if (saved.headcount >= 1 && saved.headcount <= 6) c.headcount = saved.headcount;
        if (PRICE_OPTS.some(function (p) { return p.id === saved.priceId; })) c.priceId = saved.priceId;
        c.cats = (saved.cats || []).filter(function (x) { return DM.CATEGORIES.indexOf(x) !== -1; });
        c.tastes = (saved.tastes || []).filter(function (x) { return DM.TASTES.indexOf(x) !== -1; });
        c.forms = (saved.forms || []).filter(function (x) { return DM.FORMS.indexOf(x) !== -1; });
      }
    } catch (e) { /* 무시 */ }
    S.cond = c;
  }
  function saveCond() { store.set('dp_cond', JSON.stringify(S.cond)); }
  function condForCore() {
    var p = PRICE_OPTS.filter(function (x) { return x.id === S.cond.priceId; })[0];
    return { headcount: S.cond.headcount, priceMin: p.min, priceMax: p.max, cats: S.cond.cats, tastes: S.cond.tastes, forms: S.cond.forms };
  }
  function rcOpts(count) {
    return {
      menus: MENUS, cond: condForCore(), count: count,
      members: S.members.map(function (m) { return { uid: m.uid, name: m.name, prefs: m.prefs }; }),
      history: S.history, exclude: S.shown,
      settings: { recentDays: S.ignoreRecent ? 0 : settings().recentDays, priceMul: settings().priceMul }
    };
  }
  function toggle(arr, v) { var i = arr.indexOf(v); if (i === -1) arr.push(v); else arr.splice(i, 1); }
  function condChanged() { S.shown = {}; S.ignoreRecent = false; saveCond(); render(); }

  // ------------------------------------------------------------------ 카카오 지도 SDK (한끼픽과 같은 방식: 실패하면 조용히 링크 중심으로 폴백)
  var Kakao = {
    p: null,
    load: function () {
      if (Kakao.p) return Kakao.p;
      Kakao.p = new Promise(function (resolve) {
        if (!CFG.KAKAO_JS_KEY) return resolve(false);
        if (window.kakao && window.kakao.maps && window.kakao.maps.services) return resolve(true);
        var s = document.createElement('script');
        var t = setTimeout(function () { resolve(false); }, 6000);
        s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + encodeURIComponent(CFG.KAKAO_JS_KEY) + '&libraries=services&autoload=false';
        s.onload = function () {
          try { window.kakao.maps.load(function () { clearTimeout(t); resolve(!!window.kakao.maps.services); }); }
          catch (e) { clearTimeout(t); resolve(false); }
        };
        s.onerror = function () { clearTimeout(t); resolve(false); };
        document.head.appendChild(s);
      }).then(function (ok) { if (!ok) Kakao.p = null; return ok; }); // 실패하면 다음에 다시 시도할 수 있게
      return Kakao.p;
    },
    geocode: function (addr) {
      return new Promise(function (resolve) {
        var K = window.kakao.maps.services;
        new K.Geocoder().addressSearch(addr, function (res, status) {
          if (status === K.Status.OK && res[0]) return resolve({ lat: +res[0].y, lng: +res[0].x });
          new K.Places().keywordSearch(addr, function (r2, st2) { // 건물명/상호명으로도 시도
            resolve(st2 === K.Status.OK && r2[0] ? { lat: +r2[0].y, lng: +r2[0].x } : null);
          });
        });
      });
    },
    search: function (kw, lat, lng, radius) {
      return new Promise(function (resolve, reject) {
        var K = window.kakao.maps.services;
        new K.Places().keywordSearch(kw, function (data, status) {
          if (status === K.Status.ZERO_RESULT) return resolve([]);
          if (status !== K.Status.OK) return reject(new Error('search ' + status));
          resolve(data.map(function (d) {
            return {
              id: d.id, name: d.place_name, distance: +d.distance || 0, url: d.place_url,
              category: String(d.category_name || '').split(' > ').slice(-2).join(' · '), score: null, count: null
            };
          }));
        }, { location: new window.kakao.maps.LatLng(lat, lng), radius: Math.min(radius, 20000), sort: K.SortBy.DISTANCE, size: 15, category_group_code: 'FD6' });
      });
    }
  };

  function coupangUrl(q) { return 'https://www.coupangeats.com/search?keyword=' + encodeURIComponent(q); }

  function currentPick() { return S.result && S.result.picks ? S.result.picks[S.result.idx] : null; }

  function loadRestaurants() {
    var p = currentPick(); if (!p) return;
    var key = p.menu.id, st = settings();
    if (st.lat == null || st.lng == null) { S.rest = { key: key, status: 'noaddr' }; render(); return; }
    S.rest = { key: key, status: 'loading' }; render();
    Kakao.load().then(function (ok) {
      if (!S.rest || S.rest.key !== key) return;
      if (!ok) { S.rest = { key: key, status: 'nosdk' }; render(); return; }
      return Kakao.search(p.menu.kw, st.lat, st.lng, st.radiusM).then(function (items) {
        if (!S.rest || S.rest.key !== key) return;
        S.rest = { key: key, status: 'ok', items: items }; render();
        return enrichRatings(key, items);
      }, function () { if (S.rest && S.rest.key === key) { S.rest = { key: key, status: 'error' }; render(); } });
    });
  }
  // 카카오 평점(비공식 API, 워커 프록시). 못 가져오면 평점 없이 거리순 그대로 둔다.
  function enrichRatings(key, items) {
    return Promise.all(items.slice(0, 8).map(function (it) {
      return api('GET', '/api/place?placeId=' + encodeURIComponent(it.id)).then(function (r) {
        if (r && r.score != null) { it.score = r.score; it.count = r.count; }
      }, function () { /* 평점 없이 진행 */ });
    })).then(function () {
      if (!S.rest || S.rest.key !== key) return;
      var rated = items.filter(function (i) { return i.score != null; });
      if (rated.length >= 3) {
        var bayes = function (i) { var c = i.count || 0; return i.score == null ? -1 : (i.score * c + 3.5 * 5) / (c + 5); };
        items.sort(function (a, b) { return bayes(b) - bayes(a) || a.distance - b.distance; });
      }
      render();
    });
  }

  // ------------------------------------------------------------------ 렌더 루프
  function render() {
    var y = window.scrollY;
    $app.textContent = '';
    var showTabs = S.view === 'main';
    var shell = h('div', { class: 'shell' + (showTabs ? '' : ' no-tabs') });
    if (S.view === 'boot') shell.appendChild(h('p', { class: 'muted' }, h('span', { class: 'spinner' }), '불러오는 중…'));
    else if (S.view === 'setup') shell.appendChild(viewSetup());
    else if (S.view === 'auth') shell.appendChild(viewAuth());
    else if (S.view === 'wc') shell.appendChild(viewWc());
    else shell.appendChild(viewMain());
    $app.appendChild(shell);
    if (showTabs) $app.appendChild(tabbar());
    window.scrollTo(0, y);
  }

  function header() {
    return h('div', { class: 'page-header' },
      h('h1', { class: 'page-title' }, h('span', { class: 'stamp-top' }, "TONIGHT'S PICK"), h('span', null, '저녁', h('span', { class: 'pop' }, '픽'))),
      S.me ? h('span', { class: 'who-pill' }, ico('users-three'), S.members.map(function (m) { return m.name; }).join(' · ')) : null
    );
  }

  function viewSetup() {
    return h('div', null, header(),
      h('div', { class: 'panel' }, h('h2', null, '배포 설정이 필요해요'),
        h('p', null, 'config.js의 API_BASE를 배포한 Cloudflare Worker 주소로 바꿔주세요.'),
        h('p', { class: 'note' }, '로컬에서 먼저 써보려면 node dev/server.mjs 로 개발 서버를 켜고 http://localhost:8000 으로 접속하세요.')));
  }

  // ------------------------------------------------------------------ 로그인 / 가입
  function readDraft(form) {
    var f = new FormData(form);
    // 비밀번호도 메모리에서만 잠깐 보존한다(칩을 눌러 화면이 다시 그려져도 입력이 사라지지 않게). 저장은 하지 않는다.
    return { id: f.get('id') || '', pw: f.get('password') || '', name: f.get('name') || '', code: f.get('code') || '', signupCode: f.get('signupCode') || '', hm: S.authDraft.hm };
  }
  function viewAuth() {
    var signup = S.authMode === 'signup', d = S.authDraft;
    var form = h('form', { onsubmit: onAuthSubmit, autocomplete: 'on' });
    form.appendChild(h('label', { class: 'field' }, h('span', null, '아이디'),
      h('input', { class: 'input', name: 'id', value: d.id || '', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', required: true, placeholder: '영문 소문자·숫자·_ 3~20자' })));
    form.appendChild(h('label', { class: 'field' }, h('span', null, '비밀번호'),
      h('input', { class: 'input', name: 'password', type: 'password', value: d.pw || '', autocomplete: signup ? 'new-password' : 'current-password', required: true, placeholder: signup ? '8자 이상' : '' })));
    if (signup) {
      form.appendChild(h('label', { class: 'field' }, h('span', null, '표시 이름 (상대방에게 보여요)'),
        h('input', { class: 'input', name: 'name', value: d.name || '', maxlength: 12, required: true, placeholder: '예: 혜리' })));
      form.appendChild(h('div', { class: 'group' }, h('p', { class: 'group-label' }, '가구'),
        h('div', { class: 'chips' },
          h('button', { type: 'button', class: 'chip' + (d.hm === 'create' ? ' active' : ''), onclick: function () { S.authDraft = readDraft(form); S.authDraft.hm = 'create'; render(); } }, '새로 만들기'),
          h('button', { type: 'button', class: 'chip' + (d.hm === 'join' ? ' active' : ''), onclick: function () { S.authDraft = readDraft(form); S.authDraft.hm = 'join'; render(); } }, '초대 코드로 합류')),
        d.hm === 'join'
          ? h('label', { class: 'field', style: 'margin-top:10px' }, h('span', null, '초대 코드 (배우자 마이페이지에 있어요)'),
            h('input', { class: 'input', name: 'code', value: d.code || '', maxlength: 6, autocapitalize: 'characters', required: true, placeholder: '6자리' }))
          : h('p', { class: 'note' }, '새로 만들면 초대 코드가 생겨요. 배우자는 그 코드로 합류하면 두 분의 취향이 합쳐져요.')));
      form.appendChild(h('label', { class: 'field' }, h('span', null, '가입 코드 (설정한 경우만)'),
        h('input', { class: 'input', name: 'signupCode', value: d.signupCode || '', autocomplete: 'off' })));
    }
    if (S.error) form.appendChild(h('p', { class: 'err', role: 'alert' }, S.error));
    form.appendChild(h('button', { class: 'cta', type: 'submit', disabled: S.busy }, S.busy ? '잠시만요…' : (signup ? '가입하고 시작하기' : '로그인')));
    return h('div', null, header(),
      h('div', { class: 'seg' },
        h('button', { type: 'button', class: S.authMode === 'login' ? 'on' : '', onclick: function () { S.authDraft = readDraft(form); S.authMode = 'login'; S.error = ''; render(); } }, '로그인'),
        h('button', { type: 'button', class: signup ? 'on' : '', onclick: function () { S.authDraft = readDraft(form); S.authMode = 'signup'; S.error = ''; render(); } }, '가입')),
      form);
  }
  function onAuthSubmit(e) {
    e.preventDefault();
    var form = e.target, f = new FormData(form), signup = S.authMode === 'signup';
    S.authDraft = readDraft(form); S.error = ''; S.busy = true; render();
    var req = signup
      ? api('POST', '/api/signup', {
        id: f.get('id'), password: f.get('password'), name: f.get('name'), signupCode: f.get('signupCode') || undefined,
        household: S.authDraft.hm === 'join' ? { mode: 'join', code: f.get('code') } : { mode: 'create' }
      })
      : api('POST', '/api/login', { id: f.get('id'), password: f.get('password') });
    req.then(function (data) {
      S.token = data.token; store.set('dp_token', S.token); applyState(data);
      S.authDraft = { hm: 'create' }; S.authMode = 'login'; S.busy = false; afterLogin();
    }, function (err) { S.busy = false; S.error = err.message; render(); });
  }
  function afterLogin() {
    loadCond(); S.result = null; S.shown = {}; S.tab = 'pick';
    var skipped = store.get('dp_wc_skip_' + S.me.uid);
    if ((myPrefs().wc || {}).runs === 0 && !skipped) { S.view = 'wc'; S.wcStage = 'intro'; S.wc = null; }
    else S.view = 'main';
    render();
  }
  function logoutLocal() {
    S.token = ''; store.del('dp_token'); S.me = null; S.household = null; S.members = []; S.history = [];
    S.result = null; S.view = 'auth'; S.authMode = 'login'; S.authDraft = { hm: 'create' }; S.error = ''; render();
  }
  function logout() { api('POST', '/api/logout').then(logoutLocal, logoutLocal); }

  // ------------------------------------------------------------------ 메인(탭)
  function tabbar() {
    var tabs = [['pick', 'dice-five', '추천'], ['log', 'notebook', '기록'], ['me', 'user-circle', '마이']];
    return h('nav', { class: 'tabbar', 'aria-label': '메뉴' }, tabs.map(function (t) {
      return h('button', { class: S.tab === t[0] ? 'on' : '', onclick: function () { switchTab(t[0]); }, 'aria-current': S.tab === t[0] ? 'page' : null }, ico(t[1], S.tab === t[0]), t[2]);
    }));
  }
  function switchTab(t) {
    S.tab = t; render(); window.scrollTo(0, 0);
    if (t !== 'pick') refresh().then(render, function () { /* 조용히 */ }); // 배우자가 남긴 평가/취향 반영
  }
  function viewMain() {
    var wrap = h('div', null, header());
    if (S.tab === 'pick') wrap.appendChild(tabPick());
    else if (S.tab === 'log') wrap.appendChild(tabLog());
    else wrap.appendChild(tabMe());
    return wrap;
  }

  // ---- 추천 탭
  function chipGroup(label, hint, options, isActive, onClick) {
    return h('div', { class: 'group' }, h('p', { class: 'group-label' }, label, hint ? h('small', null, hint) : null),
      h('div', { class: 'chips' }, options.map(function (o) {
        return h('button', { type: 'button', class: 'chip' + (isActive(o.value) ? ' active' : ''), 'aria-pressed': isActive(o.value) ? 'true' : 'false', onclick: function () { onClick(o.value); } }, o.label);
      })));
  }
  function opts(arr) { return arr.map(function (x) { return { value: x, label: x }; }); }

  function tabPick() {
    var c = S.cond, frag = h('div', null);
    if (S.members.length < 2) {
      frag.appendChild(h('div', { class: 'panel', style: 'background:var(--accent-tint)' },
        h('p', { style: 'margin:0;font-size:14px' }, '아직 혼자예요. 배우자가 초대 코드 ', h('b', { class: 'mono' }, S.household.code), ' 로 합류하면 두 분의 교집합으로 뽑아요.')));
    }
    var count = Core.recommend(rcOpts(1)).stats.afterDislike;
    frag.appendChild(h('div', { class: 'panel' }, h('h2', null, '오늘의 조건'),
      h('div', { class: 'group' }, h('p', { class: 'group-label' }, '인원'),
        h('div', { class: 'stepper' },
          h('button', { type: 'button', 'aria-label': '인원 줄이기', disabled: c.headcount <= 1, onclick: function () { c.headcount--; condChanged(); } }, '−'),
          h('b', null, c.headcount + '명'),
          h('button', { type: 'button', 'aria-label': '인원 늘리기', disabled: c.headcount >= 6, onclick: function () { c.headcount++; condChanged(); } }, '+'))),
      chipGroup('인당 가격', '배달비 제외', PRICE_OPTS.map(function (p) { return { value: p.id, label: p.label }; }), function (v) { return c.priceId === v; }, function (v) { c.priceId = v; condChanged(); }),
      chipGroup('카테고리', '여러 개 가능', opts(DM.CATEGORIES), function (v) { return c.cats.indexOf(v) !== -1; }, function (v) { toggle(c.cats, v); condChanged(); }),
      chipGroup('맛', '고른 것 중 하나라도', opts(DM.TASTES), function (v) { return c.tastes.indexOf(v) !== -1; }, function (v) { toggle(c.tastes, v); condChanged(); }),
      chipGroup('재료 · 형태', null, opts(DM.FORMS), function (v) { return c.forms.indexOf(v) !== -1; }, function (v) { toggle(c.forms, v); condChanged(); }),
      h('div', { class: 'row between', style: 'margin:4px 0 12px' },
        h('button', { class: 'link-btn', onclick: function () { S.cond = defaultCond(); S.result = null; condChanged(); } }, '조건 초기화'),
        h('span', { class: 'mono small muted' }, '후보 ' + count + '개')),
      h('button', { class: 'cta', disabled: count === 0, onclick: function () { S.ignoreRecent = false; doPick(true); } }, count === 0 ? '조건에 맞는 메뉴가 없어요' : '오늘 저녁 뽑기!'),
      h('p', { class: 'note' }, '최근 ' + settings().recentDays + '일 안에 먹은 메뉴와 둘 중 한 명이라도 싫어하는 메뉴는 빼고 뽑아요.')));

    if (S.result) frag.appendChild(resultView());
    return frag;
  }

  function doPick(fresh) {
    if (fresh) S.shown = {};
    var r = Core.recommend(rcOpts(3));
    if (!r.picks.length && Object.keys(S.shown).length) { S.shown = {}; r = Core.recommend(rcOpts(3)); } // 다 보여줬으면 처음부터
    r.picks.forEach(function (p) { S.shown[p.menu.id] = true; });
    S.result = r.picks.length ? { picks: r.picks, idx: 0 } : { empty: true, suggest: r.suggest, stats: r.stats };
    S.chosenRest = null; S.rest = { status: 'idle' }; render();
    var el = document.getElementById('result-anchor'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (currentPick()) loadRestaurants();
  }
  function selectAlt(i) { S.result.idx = i; S.chosenRest = null; render(); loadRestaurants(); }

  function applySuggest(dim) {
    if (dim === 'price') S.cond.priceId = 'any';
    else if (dim === 'recent') S.ignoreRecent = true; // 이번 조건에서만 — 저장된 설정(최근 N일)은 그대로
    else S.cond[dim] = [];
    S.shown = {}; saveCond(); doPick(true);
  }

  function resultView() {
    var r = S.result, anchor = h('div', { id: 'result-anchor' });
    if (r.empty) {
      return h('div', null, anchor, h('div', { class: 'empty' }, h('b', null, '조건에 맞는 메뉴가 없어요'),
        '조건 ' + r.stats.afterFilter + '개 → 최근 기록 제외 ' + r.stats.afterRecent + '개 → 비선호 제외 ' + r.stats.afterDislike + '개',
        r.suggest.length ? h('div', { class: 'btn-row' }, r.suggest.map(function (s) {
          return h('button', { class: 'btn sm', onclick: function () { applySuggest(s.dim); } }, s.label + ' (' + s.count + '개)');
        })) : null));
    }
    var p = currentPick(), m = p.menu;
    var others = r.picks.map(function (x, i) { return { x: x, i: i }; }).filter(function (o) { return o.i !== r.idx; });
    return h('div', null, anchor,
      h('div', { class: 'result' },
        h('span', { class: 'kicker' }, '오늘의 저녁픽'),
        h('span', { class: 'result-emoji', 'aria-hidden': 'true' }, m.emoji),
        h('h2', { class: 'result-name' }, m.name),
        h('p', { class: 'result-meta' }, m.cat + ' · ' + m.sub + (m.type === 'share' ? ' · 권장 ' + m.serves[0] + '~' + m.serves[1] + '인분' : '')),
        h('div', { class: 'price-badge' }, '인당 약 ' + won(p.perPerson)),
        h('div', { class: 'tags' }, m.tags.map(function (t) { return h('span', { class: 'tag' }, '#' + t); })),
        h('p', { class: 'why-title' }, '왜 이 메뉴?'),
        h('ul', { class: 'why' }, p.reasons.map(function (x) { return h('li', null, x.text); })),
        others.length ? h('div', { class: 'alts' }, h('span', { class: 'lbl' }, '다른 후보'),
          others.map(function (o) { return h('button', { class: 'chip sm', onclick: function () { selectAlt(o.i); } }, o.x.menu.emoji + ' ' + o.x.menu.name); })) : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: function () { doPick(false); } }, ico('shuffle'), '다시 뽑기'),
          h('button', { class: 'btn pink', disabled: S.busy, onclick: eatIt }, ico('check-circle'), '이걸로 먹을래요'))),
      restaurantPanel(m));
  }

  function restaurantPanel(menu) {
    var st = settings(), R = S.rest || {};
    var box = h('div', { class: 'panel' }, h('h2', null, '배달 주문하기'),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn ink', href: coupangUrl(menu.kw), target: '_blank', rel: 'noopener' }, ico('storefront'), '쿠팡이츠에서 “' + menu.kw + '” 검색'),
        h('button', { class: 'btn', onclick: function () { copyText(menu.kw); } }, ico('copy'), '검색어 복사 (배민용)')));
    if (R.status === 'noaddr') {
      box.appendChild(h('p', { class: 'note' }, '집 주소를 등록하면 근처 가게도 찾아드려요. '));
      box.appendChild(h('button', { class: 'btn sm', style: 'margin-top:8px', onclick: function () { switchTab('me'); } }, '마이에서 주소 등록'));
    } else if (R.status === 'loading') {
      box.appendChild(h('p', { class: 'note' }, h('span', { class: 'spinner' }), '근처 가게 찾는 중…'));
    } else if (R.status === 'nosdk') {
      box.appendChild(h('p', { class: 'note' }, '카카오 지도를 불러오지 못했어요(카카오 콘솔에 이 도메인이 등록돼 있는지 확인해주세요). 위 버튼으로 직접 검색해주세요.'));
    } else if (R.status === 'error') {
      box.appendChild(h('p', { class: 'note' }, '가게 검색에 실패했어요. 잠시 후 다시 뽑아주세요.'));
    } else if (R.status === 'ok') {
      box.appendChild(h('p', { class: 'note' }, '집 기준 ' + (st.radiusM / 1000) + 'km 안의 “' + menu.kw + '” 가게예요. 쿠팡이츠 입점 여부와 배달 가능 여부는 앱에서 꼭 확인해주세요.'));
      if (!R.items.length) box.appendChild(h('p', { class: 'note' }, '이 반경에서는 찾지 못했어요. 마이에서 반경을 넓혀보세요.'));
      R.items.slice(0, 8).forEach(function (it) {
        var picked = S.chosenRest && S.chosenRest.id === it.id;
        box.appendChild(h('div', { class: 'rest' + (picked ? ' picked' : ''), style: 'margin-top:10px' },
          h('div', { class: 'name' }, it.name),
          h('div', { class: 'meta' }, distText(it.distance) + (it.category ? ' · ' + it.category : ''),
            it.score != null ? h('span', { class: 'stars' }, '  ★ ' + it.score + (it.count ? ' (' + it.count + ')' : '')) : null),
          h('div', { class: 'btn-row' },
            h('a', { class: 'btn sm', href: coupangUrl(it.name), target: '_blank', rel: 'noopener' }, '쿠팡이츠 검색'),
            h('a', { class: 'btn sm', href: it.url, target: '_blank', rel: 'noopener' }, '카카오맵'),
            h('button', { class: 'btn sm' + (picked ? ' ink' : ''), onclick: function () { S.chosenRest = picked ? null : it; render(); } }, picked ? '선택됨' : '여기로 정하기'))));
      });
    }
    return box;
  }

  function eatIt() {
    var p = currentPick(); if (!p) return;
    S.busy = true; render();
    api('POST', '/api/history', { menuId: p.menu.id, name: p.menu.name, cat: p.menu.cat, rest: S.chosenRest ? S.chosenRest.name : '' })
      .then(function () { return refresh(); })
      .then(function () {
        S.busy = false; S.result = null; S.shown = {};
        toast('기록했어요! ' + settings().recentDays + '일 동안은 다시 안 나와요'); render();
      }, function (e) { S.busy = false; render(); fail(e); });
  }

  // ---- 기록 탭
  function tabLog() {
    var wrap = h('div', null), recentDays = settings().recentDays, now = Date.now();
    var recent = {};
    S.history.forEach(function (x) { if (recentDays > 0 && now - x.at < recentDays * 86400000) recent[x.name] = true; });
    var names = Object.keys(recent);
    wrap.appendChild(h('div', { class: 'panel' }, h('h2', null, '최근 ' + recentDays + '일 제외 중'),
      names.length ? h('div', { class: 'chips' }, names.map(function (n) { return h('span', { class: 'chip sm static' }, n); })) : h('p', { class: 'note', style: 'margin:0' }, '제외 중인 메뉴가 없어요.')));
    if (!S.history.length) {
      wrap.appendChild(h('div', { class: 'empty' }, h('b', null, '아직 먹은 기록이 없어요'), '추천 탭에서 “이걸로 먹을래요”를 누르면 여기에 쌓여요.'));
      return wrap;
    }
    S.history.forEach(function (log) {
      var menu = MENU_BY_ID[log.menuId];
      var rates = h('div', { class: 'rates' });
      S.members.forEach(function (m) {
        var v = m.prefs.feedback && m.prefs.feedback[log.id] ? m.prefs.feedback[log.id].v : null, mine = m.uid === S.me.uid;
        var btn = function (val, label, cls) {
          return h('button', { class: 'rate-btn' + (v === val ? ' on' : '') + (cls || ''), disabled: !mine, 'aria-label': m.name + ' ' + label, 'aria-pressed': v === val ? 'true' : 'false',
            onclick: function () { rate(log, mine && v === val ? 0 : val); } }, label === '맛있었어요' ? '👍' : label === '보통' ? '😐' : '👎');
        };
        rates.appendChild(h('div', { class: 'rate-row' }, h('span', { class: 'who' }, m.name),
          h('div', { class: 'rate-btns' }, btn(1, '맛있었어요', ''), btn(0, '보통', ''), btn(-1, '별로였어요', ' down'))));
      });
      wrap.appendChild(h('div', { class: 'log' },
        h('div', { class: 'top' }, h('span', { class: 'emo', 'aria-hidden': 'true' }, menu ? menu.emoji : '🍽️'),
          h('div', { class: 'grow' }, h('div', { class: 'nm' }, log.name), h('div', { class: 'sub' }, dateText(log.at) + (log.rest ? ' · ' + log.rest : ''))),
          h('button', { class: 'icon-btn', 'aria-label': '기록 삭제', onclick: function () { delLog(log); } }, ico('trash'))),
        rates));
    });
    wrap.appendChild(h('p', { class: 'note' }, '평가는 취향 점수에 반영돼요. 👍는 비슷한 메뉴가 더 나오고, 👎는 그 메뉴가 빠져요. 같은 버튼을 다시 누르면 취소돼요.'));
    return wrap;
  }
  function rate(log, v) {
    api('POST', '/api/feedback', { logId: log.id, menuId: log.menuId, v: v }).then(refresh).then(render, fail);
  }
  function delLog(log) {
    if (!window.confirm('“' + log.name + '” 기록을 지울까요? 이 기록에 남긴 평가도 함께 사라져요.')) return;
    api('DELETE', '/api/history?id=' + encodeURIComponent(log.id)).then(refresh).then(render, fail);
  }

  // ---- 마이 탭
  function prefChips(summary, emptyText) {
    var any = summary.liked.length || summary.disliked.length;
    if (!any) return h('p', { class: 'note', style: 'margin:0' }, emptyText);
    return h('div', null,
      summary.liked.length ? h('div', { class: 'group' }, h('p', { class: 'group-label' }, '선호', h('small', null, summary.liked.length + '개')),
        h('div', { class: 'chips' }, summary.liked.slice(0, 24).map(function (x) { return h('span', { class: 'chip sm static like' }, x.menu.emoji + ' ' + x.menu.name); }))) : null,
      summary.disliked.length ? h('div', { class: 'group' }, h('p', { class: 'group-label' }, '비선호', h('small', null, summary.disliked.length + '개')),
        h('div', { class: 'chips' }, summary.disliked.map(function (x) { return h('span', { class: 'chip sm static dislike' }, x.menu.emoji + ' ' + x.menu.name); }))) : null);
  }
  function tabMe() {
    var st = settings(), mine = myPrefs(), wrap = h('div', null);
    wrap.appendChild(h('div', { class: 'panel' }, h('h2', null, '내 프로필'),
      h('div', { class: 'row between' },
        h('div', null, h('div', { style: 'font-family:var(--f-sub);font-size:20px' }, S.me.name), h('div', { class: 'mono small muted' }, '@' + S.me.uid)),
        h('button', { class: 'btn sm', onclick: logout }, ico('sign-out'), '로그아웃'))));

    wrap.appendChild(h('div', { class: 'panel' }, h('h2', null, '내 취향 · 음식 월드컵'),
      h('p', { class: 'note', style: 'margin:0 0 10px' }, '월드컵 ' + ((mine.wc && mine.wc.runs) || 0) + '회 · 입맛이 바뀌었다면 다시 해보세요. 새로 하면 기존 취향에 덧붙여 저장돼요.'),
      prefChips(Core.summarizePrefs(MENUS, mine), '아직 취향 데이터가 없어요. 음식 월드컵을 해보세요!'),
      h('div', { class: 'btn-row', style: 'margin-top:12px' },
        h('button', { class: 'btn pink', onclick: openWc }, ico('trophy'), '월드컵 하기'),
        h('button', { class: 'btn', onclick: resetPrefs }, ico('arrow-counter-clockwise'), '취향 초기화'))));

    S.members.filter(function (m) { return m.uid !== S.me.uid; }).forEach(function (m) {
      wrap.appendChild(h('div', { class: 'panel' }, h('h2', null, m.name + '님의 취향'), prefChips(Core.summarizePrefs(MENUS, m.prefs), m.name + '님이 아직 월드컵을 안 했어요.')));
    });

    var sel = function (name, vals, cur, fmt) {
      return h('select', { class: 'input', name: name }, vals.map(function (v) { return h('option', { value: v, selected: Number(cur) === v }, fmt(v)); }));
    };
    var form = h('form', { onsubmit: function (e) { e.preventDefault(); saveSettings(form); } },
      h('label', { class: 'field' }, h('span', null, '집 주소 (식당 검색 기준)'),
        h('input', { class: 'input', name: 'address', value: st.address || '', placeholder: '예: 서울 금천구 가산디지털1로 136', autocomplete: 'street-address' })),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, '검색 반경'), sel('radiusM', [1000, 2000, 3000, 5000], st.radiusM, function (v) { return v / 1000 + 'km'; })),
        h('label', { class: 'field' }, h('span', null, '기본 인원'), sel('defaultHeadcount', [1, 2, 3, 4, 5, 6], st.defaultHeadcount, function (v) { return v + '명'; }))),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, '최근 먹은 메뉴 제외'), sel('recentDays', [0, 3, 5, 7, 10, 14], st.recentDays, function (v) { return v ? v + '일' : '안 함'; })),
        h('label', { class: 'field' }, h('span', null, '가격 보정'), sel('priceMul', [0.9, 1, 1.1, 1.2, 1.3, 1.5], st.priceMul, function (v) { return v === 1 ? '그대로' : '×' + v; }))),
      h('p', { class: 'note', style: 'margin:0 0 12px' }, '메뉴 가격은 배달앱 기준 대략값이에요. 실제보다 낮게 나오면 가격 보정으로 올려주세요.'),
      h('button', { class: 'btn ink block', type: 'submit', disabled: S.busy }, '설정 저장'));
    wrap.appendChild(h('div', { class: 'panel' }, h('h2', null, '가구 설정 (둘이 공유)'),
      h('div', { class: 'group' }, h('p', { class: 'group-label' }, '초대 코드', h('small', null, '배우자가 가입할 때 입력해요')),
        h('div', { class: 'row' }, h('span', { class: 'code-box' }, S.household.code), h('button', { class: 'btn sm', onclick: function () { copyText(S.household.code); } }, ico('copy'), '복사'))),
      form));

    wrap.appendChild(h('p', { class: 'note' }, '※ 추천은 앱 안의 메뉴 목록과 두 분의 취향·기록으로 계산해요. 배달앱(쿠팡이츠·배민 등)의 실시간 메뉴·리뷰·가격은 가져오지 않아요.'));
    return wrap;
  }
  function saveSettings(form) {
    var f = new FormData(form), addr = String(f.get('address') || '').trim();
    var patch = { radiusM: +f.get('radiusM'), defaultHeadcount: +f.get('defaultHeadcount'), recentDays: +f.get('recentDays'), priceMul: +f.get('priceMul') };
    S.busy = true;
    var geo;
    if (addr === (settings().address || '')) { patch.address = addr; geo = Promise.resolve(null); }
    else if (!addr) { patch.address = ''; patch.lat = null; patch.lng = null; geo = Promise.resolve(null); }
    else {
      geo = Kakao.load().then(function (ok) {
        if (!ok) throw new Error('카카오 지도를 불러오지 못해 주소를 좌표로 바꿀 수 없어요. 카카오 콘솔의 도메인 등록을 확인해주세요.');
        return Kakao.geocode(addr);
      }).then(function (g) {
        if (!g) throw new Error('주소를 찾지 못했어요. 도로명 주소나 건물명으로 다시 입력해보세요.');
        patch.address = addr; patch.lat = g.lat; patch.lng = g.lng;
      });
    }
    geo.then(function () { return api('PUT', '/api/household', patch); })
      .then(function () { return refresh(); })
      .then(function () { S.busy = false; toast('저장했어요'); render(); }, function (e) { S.busy = false; render(); fail(e); });
  }
  function resetPrefs() {
    if (!window.confirm('내 취향(월드컵 결과와 평가)을 모두 지우고 처음부터 할까요?')) return;
    api('POST', '/api/prefs/reset').then(refresh).then(function () { store.del(wcKey()); openWc(); }, fail);
  }

  // ------------------------------------------------------------------ 음식 월드컵
  // 96강(≈95경기)은 길어서: 선택마다 진행 상황을 이 기기에 저장해 이어서 할 수 있고, 한 수 물릴 수 있다.
  var wcKey = function () { return 'dp_wc_' + S.me.uid; };
  function wcPersist() { store.set(wcKey(), JSON.stringify({ ids: S.wc.items.map(function (m) { return m.id; }), choices: S.wc.choices })); }
  function wcSaved() {
    try {
      var d = JSON.parse(store.get(wcKey()) || 'null');
      if (!d || !Array.isArray(d.ids) || !Array.isArray(d.choices) || d.ids.some(function (id) { return !MENU_BY_ID[id]; })) return null;
      var wc = Core.wcReplay(d.ids.map(function (id) { return MENU_BY_ID[id]; }), d.choices);
      return wc; // 끝난 판(결과 저장 전)도 돌려준다 — 저장에 성공하기 전까지는 기록을 지우지 않는다
    } catch (e) { return null; }
  }
  function openWc() { S.view = 'wc'; S.wcStage = 'intro'; S.wc = null; render(); window.scrollTo(0, 0); }
  function beginWc(size) {
    var known = Object.keys(myPrefs().scores || {});
    S.wc = Core.wcNew(Core.wcPick(MENUS, Math.random, size, known));
    S.wcStage = 'play'; S.view = 'wc'; wcPersist(); render(); window.scrollTo(0, 0);
  }
  function resumeWc() { var wc = wcSaved(); if (!wc) return beginWc(WC_SIZE); S.wc = wc; S.wcStage = 'play'; S.view = 'wc'; render(); window.scrollTo(0, 0); }
  function wcExit() { S.view = 'main'; S.wc = null; render(); window.scrollTo(0, 0); }
  function wcStep(fn) { fn(); wcPersist(); render(); window.scrollTo(0, 0); }

  function viewWc() {
    if (S.wcStage === 'intro') {
      var saved = wcSaved(), first = (myPrefs().wc || {}).runs === 0;
      var sp = saved && Core.wcProgress(saved);
      return h('div', null, header(),
        h('div', { class: 'panel' }, h('h2', null, '음식 월드컵'),
          h('p', { style: 'margin:0 0 8px;font-size:15px' }, '두 메뉴 중 지금 더 끌리는 걸 골라주세요. 96개 메뉴가 96강부터 결승까지 붙어요.'),
          h('p', { class: 'note', style: 'margin:0 0 14px' }, '정말 싫은 메뉴는 “둘 다 싫어요”! 앞으로 추천에서 빠져요. 약 95번 고르면 끝나고, 중간에 나가도 이어서 할 수 있어요. 결과는 선호 · 보통 · 비선호 그룹으로 나뉘어요.'),
          saved ? h('button', { class: 'cta', onclick: resumeWc }, saved.done ? '끝난 결과 보고 저장하기' : '이어서 하기 (' + sp.played + ' / ' + sp.total + ')') : null,
          h('button', { class: saved ? 'btn block' : 'cta', style: saved ? 'margin-top:10px' : '', onclick: function () { beginWc(WC_SIZE); } }, saved ? '새로 시작 (96강)' : '96강 시작하기'),
          h('button', { class: 'btn block', style: 'margin-top:10px', onclick: function () { beginWc(WC_QUICK); } }, '빠르게 16강만'),
          h('p', { class: 'note' }, '16강은 가볍게 취향을 보정할 때 좋아요. 기존 취향에 덧붙여 저장돼요.'),
          h('p', { style: 'text-align:center;margin:12px 0 0' }, h('button', { class: 'link-btn', onclick: function () { if (first) store.set('dp_wc_skip_' + S.me.uid, '1'); wcExit(); } }, first ? '나중에 할게요' : '돌아가기'))));
    }
    var s = S.wc;
    if (s.done) return viewWcResult();
    var match = Core.wcMatch(s), pr = Core.wcProgress(s);
    var card = function (m, choice) {
      return h('button', { class: 'vs-card', onclick: function () { wcStep(function () { Core.wcChoose(s, choice); }); } },
        h('span', { class: 'emo', 'aria-hidden': 'true' }, m.emoji), h('span', { class: 'nm' }, m.name),
        h('span', { class: 'sub' }, m.cat + ' · ' + m.sub));
    };
    return h('div', null,
      h('div', { class: 'wc-head' }, h('span', null, '음식 월드컵 · ' + Core.wcRoundName(s)), h('span', { class: 'mono small muted' }, pr.played + ' / ' + pr.total)),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pr.played, 'aria-valuemax': pr.total }, h('i', { style: 'width:' + Math.round(pr.played / pr.total * 100) + '%' })),
      h('div', { class: 'vs-wrap' }, card(match[0], 'a'), h('span', { class: 'vs-badge' }, 'VS'), card(match[1], 'b')),
      h('button', { class: 'btn block', onclick: function () { wcStep(function () { Core.wcChoose(s, 'none'); }); } }, '둘 다 싫어요'),
      h('div', { class: 'row between', style: 'margin-top:14px' },
        h('button', { class: 'link-btn', disabled: !s.choices.length, onclick: function () { wcStep(function () { S.wc = Core.wcUndo(s); }); } }, '← 방금 선택 취소'),
        h('button', { class: 'link-btn', onclick: function () { toast('진행 상황은 저장돼 있어요. 나중에 이어서 할 수 있어요'); wcExit(); } }, '잠시 나가기')));
  }
  function viewWcResult() {
    var s = S.wc, g = Core.wcGroups(s), champ = s.champion;
    var list = function (arr, cls) { return h('div', { class: 'chips' }, arr.map(function (m) { return h('span', { class: 'chip sm static ' + cls }, m.emoji + ' ' + m.name); })); };
    return h('div', null,
      h('div', { class: 'panel champ' },
        champ ? h('span', { class: 'emo', 'aria-hidden': 'true' }, champ.emoji) : null,
        h('span', { class: 'kicker' }, champ ? '우승 메뉴' : '결과'),
        champ ? h('span', { class: 'nm' }, champ.name) : h('span', { class: 'nm' }, '다 별로셨군요!'),
        h('p', { class: 'note', style: 'margin:0' }, '이 결과로 비슷한 계열의 취향도 추정해서 추천에 반영해요.')),
      h('div', { class: 'panel' },
        h('div', { class: 'group' }, h('p', { class: 'group-label' }, '선호 그룹', h('small', null, g.liked.length + '개')),
          g.liked.length ? list(g.liked, 'like') : h('p', { class: 'note', style: 'margin:0' }, '뚜렷한 선호가 없어요.')),
        g.disliked.length ? h('div', { class: 'group' }, h('p', { class: 'group-label' }, '비선호 그룹', h('small', null, g.disliked.length + '개 · 추천에서 빠져요')), list(g.disliked, 'dislike')) : null,
        g.neutral.length ? h('details', { class: 'group' }, h('summary', { class: 'group-label', style: 'cursor:pointer' }, '보통 ' + g.neutral.length + '개 (눌러서 보기)'), h('div', { style: 'margin-top:8px' }, list(g.neutral, ''))) : null),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn ink', disabled: S.busy, onclick: function () { saveWc(false); } }, '저장하고 끝내기'),
        h('button', { class: 'btn', disabled: S.busy, onclick: function () { saveWc(true); } }, '저장하고 한 판 더')),
      h('p', { style: 'text-align:center;margin:10px 0 0' }, h('button', { class: 'link-btn', onclick: function () { wcStep(function () { S.wc = Core.wcUndo(S.wc); }); } }, '← 마지막 선택 취소')));
  }
  function saveWc(again) {
    var scores = Core.wcGroups(S.wc).scores;
    S.busy = true; render();
    api('PUT', '/api/prefs', { scores: scores, mode: 'merge', completedWorldcup: true }).then(refresh).then(function () {
      S.busy = false; store.del(wcKey()); toast('취향을 저장했어요');
      if (again) openWc(); else { S.tab = 'me'; wcExit(); }
    }, function (e) { S.busy = false; render(); fail(e); });
  }

  // ------------------------------------------------------------------ 시작
  function boot() {
    if (!API_CONFIGURED) { S.view = 'setup'; render(); return; }
    if (!S.token) { S.view = 'auth'; render(); return; }
    render();
    api('GET', '/api/state').then(function (d) { applyState(d); afterLogin(); }, function (e) {
      if (e.status === 401) { logoutLocal(); return; }
      S.view = 'auth'; S.error = e.message; render();
    });
  }
  boot();
})();
