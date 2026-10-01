/* 저녁픽 코어 로직 (DOM/네트워크 의존 없음 — 브라우저와 Node 테스트에서 동일하게 쓴다)
 *
 *  1) 필터(하드): 인원 · 인당 가격 · 카테고리 · 맛 · 재료/형태 · 최근 N일 먹은 것 · 누군가의 "비선호"
 *  2) 점수(소프트): 두 사람의 취향(평균 + 최저점) · 안 먹어본 정도 · 직전 식사와의 카테고리 겹침
 *  3) 가중 랜덤: 점수가 높을수록 뽑힐 확률이 높지만 항상 1등만 나오진 않는다
 *  4) 이유 문장: 왜 이 메뉴가 나왔는지 점수 구성요소를 그대로 문장으로 풀어쓴다
 *
 *  취향 데이터(prefs) 형태
 *    { scores: { menuId: -1..1 },                 // 음식 월드컵 결과 (-1 = "둘 다 싫어요")
 *      feedback: { logId: { menuId, v: -1|0|1, at } } }   // 먹고 난 뒤 평가
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DPCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var FEEDBACK_ADJ = { up: 0.3, down: -0.6 };
  var LIKE_CUT = 0.4; // 이 점수 이상이면 "선호"로 본다
  var LOVE_FLOOR = 0.5; // "둘 다 좋아요"를 누른 메뉴의 최소 점수(선호 그룹에 들어간다)

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function fmtWon(n) { return Number(n).toLocaleString('ko-KR') + '원'; }
  // 받침에 따라 조사 선택 (한글이 아니면 받침 없음으로 취급)
  function jong(word) {
    var c = String(word).charCodeAt(String(word).length - 1) - 0xAC00;
    return c >= 0 && c <= 11171 ? c % 28 : 0;
  }
  function ro(word) { var j = jong(word); return word + (j === 0 || j === 8 ? '로' : '으로'); } // ㄹ받침은 '로'
  function iRa(word) { return word + (jong(word) ? '이라' : '라'); }

  // ---------------------------------------------------------------- 가격 / 인원
  function perPerson(menu, headcount, priceMul) {
    var mul = priceMul || 1;
    var base = menu.type === 'each' ? menu.price : menu.price / Math.max(1, headcount);
    return Math.round((base * mul) / 100) * 100;
  }
  function fitsHeadcount(menu, n) {
    return menu.type === 'each' || (n >= menu.serves[0] && n <= menu.serves[1]);
  }

  // ---------------------------------------------------------------- 하드 필터
  function matchesCond(menu, cond, priceMul) {
    var n = cond.headcount || 2;
    if (!fitsHeadcount(menu, n)) return false;
    var pp = perPerson(menu, n, priceMul);
    if (cond.priceMin != null && pp < cond.priceMin) return false;
    if (cond.priceMax != null && pp > cond.priceMax) return false;
    if (cond.cats && cond.cats.length && cond.cats.indexOf(menu.cat) === -1) return false;
    if (cond.tastes && cond.tastes.length && !cond.tastes.some(function (t) { return menu.tags.indexOf(t) !== -1; })) return false;
    if (cond.forms && cond.forms.length && !cond.forms.some(function (t) { return menu.tags.indexOf(t) !== -1; })) return false;
    return true;
  }

  // ---------------------------------------------------------------- 취향
  // 월드컵 점수 + 먹고 난 뒤 평가를 합친 "확실히 아는" 점수
  function explicitScores(prefs) {
    var map = {};
    var raw = (prefs && prefs.scores) || {};
    Object.keys(raw).forEach(function (id) { map[id] = raw[id]; });
    var fb = (prefs && prefs.feedback) || {};
    Object.keys(fb).forEach(function (logId) {
      var f = fb[logId];
      if (!f || !f.menuId) return;
      var adj = f.v > 0 ? FEEDBACK_ADJ.up : f.v < 0 ? FEEDBACK_ADJ.down : 0;
      if (!adj) return;
      map[f.menuId] = clamp((map[f.menuId] == null ? 0 : map[f.menuId]) + adj, -1, 1);
    });
    return map;
  }

  function menuKeys(menu) {
    var keys = [['sub:' + menu.sub, 1.0], ['cat:' + menu.cat, 0.4]];
    menu.tags.forEach(function (t) { keys.push(['tag:' + t, 0.5]); });
    return keys;
  }

  // 점수를 알고 있는 메뉴들의 소분류/카테고리/태그별 평균(표본이 적으면 0 쪽으로 당김)
  function buildAffinity(menus, explicit) {
    var sums = {}, counts = {};
    menus.forEach(function (m) {
      if (explicit[m.id] == null) return;
      menuKeys(m).forEach(function (kw) {
        sums[kw[0]] = (sums[kw[0]] || 0) + explicit[m.id];
        counts[kw[0]] = (counts[kw[0]] || 0) + 1;
      });
    });
    return { sums: sums, counts: counts };
  }

  // 한 사람의 한 메뉴에 대한 점수. 직접 고른 적 있으면 그 값, 없으면 비슷한 메뉴에서 추정.
  function userScore(menu, ctx) {
    if (ctx.explicit[menu.id] != null) {
      return { score: ctx.explicit[menu.id], source: 'explicit', topKey: null };
    }
    var keys = menuKeys(menu), totalW = 0, acc = 0, best = null;
    keys.forEach(function (kw) {
      totalW += kw[1];
      var c = ctx.aff.counts[kw[0]];
      if (!c) return;
      var contrib = kw[1] * (ctx.aff.sums[kw[0]] / (c + 1.5));
      acc += contrib;
      if (kw[0].indexOf('cat:') !== 0 && (!best || contrib > best.contrib)) best = { key: kw[0], contrib: contrib };
    });
    var score = clamp((acc / totalW) * 1.5, -0.8, 0.8);
    return { score: score, source: acc === 0 ? 'unknown' : 'inferred', topKey: best && best.contrib > 0 ? best.key : null };
  }

  function makeMemberCtx(member, menus) {
    var explicit = explicitScores(member.prefs);
    return { uid: member.uid, name: member.name, prefs: member.prefs || {}, explicit: explicit, aff: buildAffinity(menus, explicit) };
  }

  // ---------------------------------------------------------------- 먹은 기록
  function lastEatenByKw(history, menusById) {
    var last = {};
    (history || []).forEach(function (h) {
      var m = menusById[h.menuId];
      var kw = m ? m.kw : h.menuId;
      if (!last[kw] || h.at > last[kw]) last[kw] = h.at;
    });
    return last;
  }

  // ---------------------------------------------------------------- 후보 수집 + 점수
  function collect(opts, cond) {
    var menus = opts.menus, now = opts.now || Date.now();
    var settings = opts.settings || {};
    var recentDays = settings.recentDays == null ? 7 : settings.recentDays;
    var mul = settings.priceMul || 1;
    var byId = {};
    menus.forEach(function (m) { byId[m.id] = m; });
    var members = (opts.members || []).map(function (m) { return makeMemberCtx(m, menus); });
    var lastByKw = lastEatenByKw(opts.history, byId);
    var hist = (opts.history || []).slice().sort(function (a, b) { return b.at - a.at; });
    var lastMeal = hist[0] && now - hist[0].at < 1.5 * DAY ? hist[0] : null;
    var stats = { total: menus.length, afterFilter: 0, afterRecent: 0, afterDislike: 0 };
    var out = [];

    menus.forEach(function (menu) {
      if (opts.exclude && opts.exclude[menu.id]) return; // "다시 뽑기"에서 이미 보여준 메뉴
      if (!matchesCond(menu, cond, mul)) return;
      stats.afterFilter++;
      var lastAt = lastByKw[menu.kw];
      var daysAgo = lastAt == null ? null : Math.floor((now - lastAt) / DAY);
      if (recentDays > 0 && daysAgo != null && daysAgo < recentDays) return;
      stats.afterRecent++;

      var per = members.map(function (mc) { return userScore(menu, mc); });
      if (per.some(function (s) { return s.score <= -0.5; })) return;
      stats.afterDislike++;

      var scores = per.map(function (s) { return s.score; });
      var mean = scores.length ? scores.reduce(function (a, b) { return a + b; }, 0) / scores.length : 0;
      var min = scores.length ? Math.min.apply(null, scores) : 0;
      var total = 0.6 * mean + 0.4 * min;
      if (daysAgo == null) total += 0.12;
      else if (daysAgo >= 14) total += 0.06;
      var sameCatAsLast = !!(lastMeal && byId[lastMeal.menuId] && byId[lastMeal.menuId].cat === menu.cat);
      if (sameCatAsLast) total -= 0.15;

      out.push({ menu: menu, score: total, per: per, daysAgo: daysAgo, sameCatAsLast: sameCatAsLast, lastMeal: lastMeal });
    });
    return { cands: out, stats: stats, members: members, byId: byId, mul: mul, recentDays: recentDays };
  }

  function sampleWeighted(items, n, temperature, rng) {
    var pool = items.slice(), out = [];
    while (out.length < n && pool.length) {
      var mx = Math.max.apply(null, pool.map(function (p) { return p.score; }));
      var w = pool.map(function (p) { return Math.exp((p.score - mx) / temperature); });
      var sum = w.reduce(function (a, b) { return a + b; }, 0);
      var r = rng() * sum, idx = 0;
      for (; idx < w.length - 1; idx++) { r -= w[idx]; if (r <= 0) break; }
      var picked = pool[idx];
      out.push(picked);
      // 같은 음식의 사이즈 변형(닭볶음탕 중/대)이 한 번에 두 개 나오지 않게
      pool = pool.filter(function (p) { return p.menu.kw !== picked.menu.kw; });
    }
    return out;
  }

  var DIMS = [
    ['price', '가격대', function (c) { return Object.assign({}, c, { priceMin: null, priceMax: null }); }],
    ['cats', '카테고리', function (c) { return Object.assign({}, c, { cats: [] }); }],
    ['tastes', '맛 키워드', function (c) { return Object.assign({}, c, { tastes: [] }); }],
    ['forms', '재료·형태', function (c) { return Object.assign({}, c, { forms: [] }); }]
  ];
  function dimActive(key, c) {
    if (key === 'price') return c.priceMin != null || c.priceMax != null;
    return !!(c[key] && c[key].length);
  }

  /**
   * opts: { menus, cond, members:[{uid,name,prefs}], history:[{menuId,at}], settings:{recentDays,priceMul}, now, rng, count, temperature, exclude:{menuId:true} }
   * 반환: { picks:[{menu, score, perPerson, reasons:[{k,text}]}], stats, suggest:[{label,count}] }
   */
  function recommend(opts) {
    var cond = opts.cond, rng = opts.rng || Math.random;
    var c = collect(opts, cond);
    var picks = sampleWeighted(c.cands, opts.count || 3, opts.temperature || 0.3, rng).map(function (cand) {
      return {
        menu: cand.menu,
        score: cand.score,
        perPerson: perPerson(cand.menu, cond.headcount || 2, c.mul),
        reasons: buildReasons(cand, c.members, cond, c)
      };
    });
    var suggest = [];
    if (!picks.length) {
      DIMS.forEach(function (d) {
        if (!dimActive(d[0], cond)) return;
        var n = collect(opts, d[2](cond)).cands.length;
        if (n > 0) suggest.push({ dim: d[0], label: d[1] + ' 조건 풀기', count: n });
      });
      if (c.recentDays > 0) {
        var n2 = collect(Object.assign({}, opts, { settings: Object.assign({}, opts.settings, { recentDays: 0 }) }), cond).cands.length;
        if (n2 > 0) suggest.push({ dim: 'recent', label: '최근 먹은 메뉴 제외 풀기', count: n2 });
      }
      suggest.sort(function (a, b) { return b.count - a.count; });
    }
    return { picks: picks, stats: c.stats, suggest: suggest };
  }

  // ---------------------------------------------------------------- 이유 문장
  function rawLabel(raw) {
    if (raw >= 0.95) return '우승';
    if (raw >= 0.75) return '최상위권';
    if (raw >= LIKE_CUT) return '상위권';
    return null;
  }

  function memberWhy(mc, s, menu) {
    var raw = mc.prefs.scores ? mc.prefs.scores[menu.id] : null;
    var fbUp = Object.keys(mc.prefs.feedback || {}).some(function (k) {
      var f = mc.prefs.feedback[k]; return f.menuId === menu.id && f.v > 0;
    });
    if (fbUp) return mc.name + '님 지난번에 맛있게 드심';
    if (raw != null && rawLabel(raw)) return mc.name + '님 월드컵 ' + rawLabel(raw);
    if (s.source === 'inferred' && s.topKey) return mc.name + '님은 ' + s.topKey.split(':')[1] + ' 계열을 좋아하는 편';
    return null;
  }

  function buildReasons(cand, members, cond, c) {
    var menu = cand.menu, n = cond.headcount || 2, reasons = [];

    // 1) 취향
    if (members.length) {
      var likers = [], neutral = [];
      members.forEach(function (mc, i) { (cand.per[i].score >= 0.4 ? likers : neutral).push(mc.name); });
      var head;
      if (likers.length === members.length) head = (members.length === 2 ? '두 분 모두' : members.length > 2 ? '모두' : likers[0] + '님') + ' 취향에 잘 맞아요';
      else if (likers.length) head = likers.join('·') + '님 취향 저격, ' + neutral.join('·') + '님도 거부감 없는 메뉴예요';
      else head = members.length === 1 ? members[0].name + '님에게 무난한 메뉴예요' : '모두에게 무난한 메뉴예요';
      var details = [];
      members.forEach(function (mc, i) {
        if (cand.per[i].score < 0.4) return;
        var w = memberWhy(mc, cand.per[i], menu);
        if (w) details.push(w);
      });
      reasons.push({ k: 'pref', text: head + (details.length ? ' (' + details.join(' · ') + ')' : '') });
    }

    // 2) 최근 기록
    if (cand.daysAgo == null) reasons.push({ k: 'recent', text: '아직 한 번도 안 먹어본 메뉴예요' });
    else if (cand.daysAgo >= 14) reasons.push({ k: 'recent', text: '마지막으로 먹은 지 ' + cand.daysAgo + '일이나 지났어요' });
    else if (c.recentDays > 0) reasons.push({ k: 'recent', text: '최근 ' + c.recentDays + '일 안에는 안 드셨어요' });

    // 3) 가격
    var pp = perPerson(menu, n, c.mul);
    var priceText = menu.type === 'share'
      ? '인당 약 ' + fmtWon(pp) + ' (' + fmtWon(Math.round(menu.price * c.mul / 100) * 100) + ' ÷ ' + n + '명)'
      : '인당 약 ' + fmtWon(pp);
    if (cond.priceMin != null || cond.priceMax != null) priceText += ' — 예산 안이에요';
    reasons.push({ k: 'price', text: priceText });

    // 4) 맛·형태 키워드
    var matched = []
      .concat((cond.tastes || []).filter(function (t) { return menu.tags.indexOf(t) !== -1; }))
      .concat((cond.forms || []).filter(function (t) { return menu.tags.indexOf(t) !== -1; }));
    if (matched.length) reasons.push({ k: 'taste', text: '고른 키워드가 그대로 들어있어요: ' + matched.map(function (t) { return '#' + t; }).join(' ') });

    // 5) 다양성
    if (cand.lastMeal && !cand.sameCatAsLast) {
      var lm = c.byId[cand.lastMeal.menuId];
      if (lm) reasons.push({ k: 'variety', text: '직전 식사가 ' + iRa(lm.cat) + ' 이번엔 ' + ro(menu.cat) + ' 바꿔봤어요' });
    }

    // 6) 양
    if (menu.type === 'share') reasons.push({ k: 'size', text: n + '명이 먹기 적당한 양이에요 (권장 ' + menu.serves[0] + '~' + menu.serves[1] + '인분)' });
    return reasons;
  }

  // ---------------------------------------------------------------- 음식 월드컵
  // 카테고리를 번갈아가며 뽑아서 16개 안에 다양한 메뉴가 들어가게 한다. 이미 점수가 있는 메뉴는 뒤로 미룬다.
  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function wcPick(menus, rng, size, knownIds) {
    rng = rng || Math.random; size = size || 16;
    var known = {}; (knownIds || []).forEach(function (id) { known[id] = true; });
    var buckets = {};
    shuffle(menus, rng).sort(function (a, b) { return (known[a.id] ? 1 : 0) - (known[b.id] ? 1 : 0); }).forEach(function (m) {
      (buckets[m.cat] = buckets[m.cat] || []).push(m);
    });
    var cats = shuffle(Object.keys(buckets), rng), out = [], usedKw = {}, progressed = true;
    while (out.length < size && progressed) {
      progressed = false;
      for (var i = 0; i < cats.length && out.length < size; i++) {
        var b = buckets[cats[i]];
        while (b.length && usedKw[b[0].kw]) b.shift();
        if (b.length) { var m = b.shift(); usedKw[m.kw] = true; out.push(m); progressed = true; }
      }
    }
    return shuffle(out, rng);
  }

  // 대진 크기는 자유(96강처럼 2의 거듭제곱이 아니어도 된다): 한 라운드에서 짝이 안 맞는 사람은 부전승으로 올라간다.
  // 점수 = (통과한 라운드 수) / (전체 라운드 수) 라서 16강이든 96강이든 같은 0~1 척도가 된다.
  function wcNew(items) {
    var s = { items: items, queue: [], next: [], cur: 0, adv: {}, dislikes: [], loves: [], choices: [], played: 0, done: false, champion: null };
    s.rounds = Math.max(1, Math.ceil(Math.log(items.length) / Math.LN2 - 1e-9));
    s.roundSize = items.length; // 라운드 이름용 "대진표상" 인원 ("둘 다 싫어요"로 사람이 빠져도 47강이 되지 않게)
    items.forEach(function (m) { s.adv[m.id] = 0; });
    for (var i = 0; i < items.length; i += 2) s.queue.push([items[i], items[i + 1] || null]);
    return wcSettle(s);
  }
  // 한쪽이 비어있는 대진(부전승)은 자동으로 넘기고, 라운드가 끝나면 다음 라운드를 만든다
  function wcSettle(s) {
    for (;;) {
      if (s.cur >= s.queue.length) {
        if (s.queue.length <= 1) { s.done = true; s.champion = s.next[0] || null; return s; }
        s.queue = []; for (var i = 0; i < s.next.length; i += 2) s.queue.push([s.next[i], s.next[i + 1] || null]);
        s.next = []; s.cur = 0; s.roundSize = Math.ceil(s.roundSize / 2); continue;
      }
      var m = s.queue[s.cur];
      if (m[0] && m[1]) return s;
      var w = m[0] || m[1] || null;
      if (w) s.adv[w.id] = (s.adv[w.id] || 0) + 1; // 부전승도 한 라운드 통과로 친다
      s.next.push(w); s.cur++;
    }
  }
  function wcMatch(s) { return s.done ? null : s.queue[s.cur]; }
  function wcRoundName(s) {
    var n = s.roundSize;
    return n <= 2 ? '결승' : n === 3 ? '준결승' : n + '강';
  }
  // choice: 'a' | 'b' | 'none'(둘 다 싫어요) | 'both-a' | 'both-b'(둘 다 좋아요 — 둘 다 ♥ 표시하고, 대진은 줄여야 하니 a/b 중 한쪽만 올라간다.
  //         어느 쪽이 올라갈지는 호출하는 쪽이 정해서 넘긴다: 기록(choices)만으로 똑같이 재생되어야 이어하기/되돌리기가 맞기 때문)
  function wcChoose(s, choice) {
    if (s.done) return s;
    var m = s.queue[s.cur], winner = null;
    if (choice === 'a') winner = m[0];
    else if (choice === 'b') winner = m[1];
    else if (choice === 'both-a' || choice === 'both-b') { winner = choice === 'both-a' ? m[0] : m[1]; s.loves.push(m[0].id, m[1].id); }
    else { s.dislikes.push(m[0].id, m[1].id); }
    if (winner) s.adv[winner.id] = (s.adv[winner.id] || 0) + 1;
    s.choices.push(choice); s.played++;
    s.next.push(winner); s.cur++;
    return wcSettle(s);
  }
  // 선택 기록(choices)만 있으면 같은 상태를 다시 만들 수 있다 → "이어하기"와 "되돌리기"에 쓴다
  function wcReplay(items, choices) {
    var s = wcNew(items);
    choices.forEach(function (c) { wcChoose(s, c); });
    return s;
  }
  function wcUndo(s) { return s.choices.length ? wcReplay(s.items, s.choices.slice(0, -1)) : s; }
  // 진행률: 지금까지 한 경기 + 남은 경기(이미 "둘 다 싫어요"로 사라진 자리까지 반영한 추정치)
  function wcProgress(s) {
    if (s.done) return { played: s.played, total: s.played };
    var alive = s.next.filter(Boolean).length, rest = 0;
    for (var i = s.cur; i < s.queue.length; i++) {
      var m = s.queue[i];
      if (m[0] && m[1]) { rest++; alive++; } else if (m[0] || m[1]) alive++;
    }
    while (alive > 1) { rest += Math.floor(alive / 2); alive = Math.ceil(alive / 2); }
    return { played: s.played, total: s.played + rest };
  }
  function wcScores(s) {
    var out = {};
    s.items.forEach(function (m) { out[m.id] = Math.round(Math.min(1, (s.adv[m.id] || 0) / s.rounds) * 100) / 100; });
    s.loves.forEach(function (id) { out[id] = Math.max(out[id], LOVE_FLOOR); });
    s.dislikes.forEach(function (id) { out[id] = -1; }); // 싫어요가 가장 우선
    return out;
  }
  // 결과 화면용: 선호 / 보통 / 비선호 그룹 (선호 = 점수 0.4 이상: 16강이면 4강, 96강이면 상위 12개 안팎)
  function wcGroups(s) {
    var scores = wcScores(s), liked = [], neutral = [], disliked = [];
    s.items.forEach(function (m) {
      if (scores[m.id] < 0) disliked.push(m);
      else if (scores[m.id] >= LIKE_CUT) liked.push(m);
      else neutral.push(m);
    });
    liked.sort(function (a, b) { return scores[b.id] - scores[a.id]; });
    var loved = {}; s.loves.forEach(function (id) { if (scores[id] >= 0) loved[id] = true; });
    return { liked: liked, neutral: neutral, disliked: disliked, scores: scores, loved: loved };
  }

  // 마이페이지용: 저장된 점수 → 선호/비선호 목록
  function summarizePrefs(menus, prefs) {
    var explicit = explicitScores(prefs), liked = [], disliked = [];
    menus.forEach(function (m) {
      var s = explicit[m.id];
      if (s == null) return;
      if (s >= LIKE_CUT) liked.push({ menu: m, score: s });
      else if (s <= -0.5) disliked.push({ menu: m, score: s });
    });
    liked.sort(function (a, b) { return b.score - a.score; });
    return { liked: liked, disliked: disliked, ratedCount: Object.keys(explicit).length };
  }

  return {
    perPerson: perPerson, fitsHeadcount: fitsHeadcount, matchesCond: matchesCond, fmtWon: fmtWon,
    explicitScores: explicitScores, userScore: userScore, makeMemberCtx: makeMemberCtx,
    recommend: recommend, summarizePrefs: summarizePrefs,
    wcPick: wcPick, wcNew: wcNew, wcMatch: wcMatch, wcChoose: wcChoose, wcRoundName: wcRoundName, wcReplay: wcReplay, wcUndo: wcUndo,
    wcProgress: wcProgress, wcScores: wcScores, wcGroups: wcGroups
  };
});
