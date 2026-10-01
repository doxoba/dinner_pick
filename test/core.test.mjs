import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('../core.js');
const { MENUS, CATEGORIES, TASTES, FORMS, MAINS, DRINKS, MEAL } = require('../menus.js');
const ALL_TAGS = new Set([...TASTES, ...FORMS, ...MAINS]);
const SNACKS = MENUS.filter((m) => m.cat !== MEAL);

const byId = Object.fromEntries(MENUS.map((m) => [m.id, m]));
const NOW = Date.UTC(2026, 9, 1, 10);
const DAY = 86400000;
function seeded(seed) { // 재현 가능한 난수
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const baseCond = { headcount: 2, priceMin: null, priceMax: null, cats: [], tastes: [], forms: [], mains: [], drinks: [] };
const me = { uid: 'a', name: '나', prefs: {} };
const hubby = { uid: 'b', name: '남편', prefs: {} };

test('메뉴 DB: id 중복 없음, 카테고리/태그/술이 정의된 목록 안에 있음', () => {
  assert.equal(new Set(MENUS.map((m) => m.id)).size, MENUS.length);
  for (const m of MENUS) {
    assert.ok(CATEGORIES.includes(m.cat), `${m.id}: 알 수 없는 카테고리 ${m.cat}`);
    assert.ok(m.tags.length > 0 && m.price > 0 && m.kw, m.id);
    for (const t of m.tags) assert.ok(ALL_TAGS.has(t), `${m.id}: 알 수 없는 태그 ${t}`);
    assert.ok(m.drinks.length > 0 && m.drinks.every((d) => DRINKS.includes(d)), `${m.id}: 술 목록 오류 ${m.drinks}`);
    if (m.type === 'share') assert.ok(m.serves[0] >= 1 && m.serves[1] >= m.serves[0], m.id);
  }
});

test('메뉴 DB: 안주 메뉴는 128강도 가능한 규모이고, 밥류는 전부 "식사" 카테고리에 있다', () => {
  assert.ok(new Set(SNACKS.map((m) => m.kw)).size >= 128, '안주 서로 다른 음식 128종 이상');
  assert.ok(MENUS.filter((m) => m.cat === MEAL).length >= 25);
  // 초밥은 회 중심이라 일부러 안주(일식)에 남겨둔 예외, 케밥은 이름만 비슷한 빵 요리
  for (const m of SNACKS) assert.ok(!/밥|도시락|김밥|리조또|포케/.test(m.name.replace('초밥', '').replace('케밥', '')), `${m.name} 은(는) 식사 카테고리여야 함`);
  for (const m of MENUS.filter((x) => x.cat === MEAL)) assert.equal(m.type, 'each', m.id); // 식사는 1인 기준
});

test('모든 안주에 조리 방식 태그가 하나 이상 있다 (조리 방식 필터에서 빠지는 메뉴가 없도록)', () => {
  for (const m of SNACKS) assert.ok(m.tags.some((t) => FORMS.includes(t)), `${m.name} 에 조리 방식 태그가 없음`);
  for (const f of FORMS) assert.ok(SNACKS.some((m) => m.tags.includes(f)), `조리 방식 '${f}' 에 해당하는 안주가 하나도 없음`);
});

test('자주 먹는 안주가 DB에 있다 (치킨·닭강정·피자·써브웨이·이삭토스트·에그드랍·낙지볶음·탕짜면·생선구이·호떡·타코야끼·야끼소바·라멘·핫도그)', () => {
  for (const kw of ['치킨', '닭강정', '피자', '써브웨이', '이삭토스트', '에그드랍', '낙지볶음', '탕짜면', '생선구이', '호떡', '타코야끼', '야끼소바', '라멘', '핫도그', '떡볶이', '제육볶음', '만두']) {
    assert.ok(SNACKS.some((m) => m.kw.includes(kw) || m.name.includes(kw)), `${kw} 가 안주 카테고리에 없음`);
  }
});

test('인당 가격: 1인 메뉴는 그대로, 나눠 먹는 메뉴는 인원수로 나눈다 (가격 보정 포함)', () => {
  assert.equal(Core.perPerson(byId['jjajang'], 2), 8500);
  assert.equal(Core.perPerson(byId['dakbokkeum-l'], 4), 9500);   // 38000 / 4
  assert.equal(Core.perPerson(byId['dakbokkeum-l'], 3), 12700);  // 12666 → 100원 반올림
  assert.equal(Core.perPerson(byId['jjajang'], 2, 1.1), 9400);
});

test('권장 인원 밖이면 후보에서 빠진다 (2명이 닭볶음탕 대를 시키지 않는다)', () => {
  assert.equal(Core.fitsHeadcount(byId['dakbokkeum-l'], 2), false);
  assert.equal(Core.fitsHeadcount(byId['dakbokkeum-m'], 2), true);
  assert.equal(Core.fitsHeadcount(byId['dakbokkeum-m'], 4), false);
  assert.equal(Core.fitsHeadcount(byId['jjajang'], 5), true);
});

test('조건 필터: 가격대 · 카테고리 · 맛(any-of)', () => {
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, cats: ['중식'], tastes: ['마라'], priceMax: 20000 }, members: [me, hubby], history: [], now: NOW, rng: seeded(1), count: 20 });
  assert.ok(r.picks.length > 0);
  for (const p of r.picks) {
    assert.equal(p.menu.cat, '중식');
    assert.ok(p.menu.tags.includes('마라'));
    assert.ok(p.perPerson <= 20000);
  }
});

test('최근 7일 안에 먹은 메뉴는 제외 — 사이즈 변형(닭볶음탕 중/대)도 같은 음식으로 취급', () => {
  const history = [
    { menuId: 'dakbokkeum-l', at: NOW - 3 * DAY },
    { menuId: 'donkatsu', at: NOW - 8 * DAY },
  ];
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, headcount: 3 }, members: [me, hubby], history, now: NOW, rng: seeded(2), count: 200 });
  const ids = r.picks.map((p) => p.menu.id);
  assert.ok(!ids.includes('dakbokkeum-m') && !ids.includes('dakbokkeum-l'), '닭볶음탕은 제외돼야 함');
  assert.ok(ids.includes('donkatsu'), '8일 전 돈까스는 다시 나올 수 있음');
});

test('교집합: 한 명이라도 "비선호"인 메뉴는 절대 안 나온다', () => {
  const husband = { uid: 'b', name: '남편', prefs: { scores: { jjamppong: -1, 'pizza-m': -1 } } };
  for (let seed = 1; seed <= 30; seed++) {
    const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [me, husband], history: [], now: NOW, rng: seeded(seed), count: 300 });
    const ids = new Set(r.picks.map((p) => p.menu.id));
    assert.ok(!ids.has('jjamppong') && !ids.has('pizza-m'));
  }
});

test('먹고 난 뒤 👎 평가가 쌓이면 그 메뉴가 빠지고, 비슷한 메뉴 점수도 내려간다', () => {
  const disliker = { uid: 'a', name: '나', prefs: { feedback: { l1: { menuId: 'budae', v: -1, at: NOW - 20 * DAY } } } };
  const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [disliker], history: [], now: NOW, rng: seeded(3), count: 300 });
  assert.ok(!r.picks.some((p) => p.menu.id === 'budae'));
});

test('취향 점수가 높은 계열이 더 자주 뽑힌다 (가중 랜덤)', () => {
  const fan = { uid: 'a', name: '나', prefs: { scores: { malatang: 1, malaxiangguo: 1, hotpot: 0.8, kkanpunggi: 0.6 } } };
  let mala = 0, total = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [fan], history: [], now: NOW, rng: seeded(seed * 7), count: 1 });
    total++; if (r.picks[0] && r.picks[0].menu.tags.includes('마라')) mala++;
  }
  const baseline = MENUS.filter((m) => m.tags.includes('마라') && Core.matchesCond(m, baseCond)).length / MENUS.filter((m) => Core.matchesCond(m, baseCond)).length;
  assert.ok(mala / total > baseline * 2, `마라 비율 ${mala / total} vs 균등 ${baseline}`);
});

test('이유 문장: 취향·최근기록·가격·키워드가 들어간다', () => {
  const m1 = { uid: 'a', name: '혜리', prefs: { scores: { 'kimchijjigae': 0.55 } } };
  const m2 = { uid: 'b', name: '남편', prefs: { scores: { 'kimchijjigae': 1.0 } } };
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, tastes: ['얼큰칼칼'], priceMax: 12000, priceMin: 8000 }, members: [m1, m2], history: [{ menuId: 'tangsuyuk-s', at: NOW - 1 * DAY }], now: NOW, rng: seeded(5), count: 300 });
  const pick = r.picks.find((p) => p.menu.id === 'kimchijjigae');
  assert.ok(pick, '김치찌개가 후보에 있어야 함');
  const text = pick.reasons.map((x) => x.text).join(' / ');
  assert.match(text, /두 분 모두 취향에 잘 맞아요/);
  assert.match(text, /혜리님 월드컵 상위권/);
  assert.match(text, /남편님 월드컵 우승/);
  assert.match(text, /아직 한 번도 안 먹어본/);
  assert.match(text, /인당 약 10,000원 — 예산 안/);
  assert.match(text, /키워드가 그대로 들어있어요: #얼큰칼칼/);
  assert.match(text, /직전 식사가 중식이라 이번엔 한식으로/);
});

test('"다시 뽑기": exclude에 넣은 메뉴는 다시 나오지 않는다', () => {
  const exclude = { donkatsu: true, takoyaki: true };
  const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [me], history: [], now: NOW, rng: seeded(1), count: 300, exclude });
  assert.ok(r.picks.length > 10);
  assert.ok(!r.picks.some((p) => exclude[p.menu.id]));
});

test('조사: 받침에 따라 으로/로, 이라/라', () => {
  const hist = (id) => [{ menuId: id, at: NOW - DAY }];
  const reasonFor = (lastId, onlyId) => Core.recommend({ menus: MENUS, cond: baseCond, members: [me], history: hist(lastId), now: NOW, rng: seeded(1), count: 300 })
    .picks.find((p) => p.menu.id === onlyId).reasons.find((r) => r.k === 'variety').text;
  assert.match(reasonFor('chicken-fried', 'tangsuyuk-s'), /치킨·피자라 이번엔 중식으로/);
  assert.match(reasonFor('tangsuyuk-s', 'tandoori'), /중식이라 이번엔 아시안으로/);
  assert.match(reasonFor('tangsuyuk-s', 'donkatsu'), /일식으로/);
  assert.match(reasonFor('tangsuyuk-s', 'pizza-m'), /치킨·피자로/);
});

test('이유 문장: 나눠 먹는 메뉴는 "총액 ÷ 인원"과 권장 인원을 보여준다', () => {
  const r = Core.recommend({ menus: MENUS.filter((m) => m.id === 'dakbokkeum-m'), cond: baseCond, members: [me], history: [], now: NOW, rng: seeded(1), count: 1 });
  const text = r.picks[0].reasons.map((x) => x.text).join(' / ');
  assert.match(text, /29,000원 ÷ 2명/);
  assert.match(text, /권장 2~3인분/);
});

test('후보가 없으면 어떤 조건을 풀면 몇 개가 나오는지 제안한다', () => {
  const history = MENUS.filter((m) => m.cat === '중식').map((m) => ({ menuId: m.id, at: NOW - DAY }));
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, cats: ['중식'], priceMax: 30000 }, members: [me], history, now: NOW, rng: seeded(1), count: 3 });
  assert.equal(r.picks.length, 0);
  const labels = r.suggest.map((s) => s.dim);
  assert.ok(labels.includes('recent'), '최근 먹은 메뉴 제외 풀기 제안');
  assert.ok(r.suggest.every((s) => s.count > 0));
});

test('음식 월드컵: 16개 선택은 서로 다른 음식이고 카테고리가 고르게 섞인다', () => {
  const items = Core.wcPick(MENUS, seeded(9), 16, []);
  assert.equal(items.length, 16);
  assert.equal(new Set(items.map((m) => m.kw)).size, 16);
  assert.ok(new Set(items.map((m) => m.cat)).size >= 6);
});

test('음식 월드컵(16강): 매번 첫째를 고르면 우승 1.0 / 결승 0.75 / 4강 0.5 / 8강 0.25 / 16강 탈락 0', () => {
  const items = Core.wcPick(MENUS, seeded(4), 16, []);
  let s = Core.wcNew(items);
  assert.equal(Core.wcRoundName(s), '16강');
  let guard = 0;
  while (!s.done && guard++ < 50) s = Core.wcChoose(s, 'a');
  assert.equal(s.done, true);
  assert.equal(s.champion.id, items[0].id);
  const scores = Core.wcScores(s);
  assert.equal(scores[items[0].id], 1.0);
  assert.equal(scores[items[8].id], 0.75);  // 결승 상대
  assert.equal(Object.keys(scores).length, 16);
  assert.equal(Core.wcProgress(s).played, 15);
});

test('음식 월드컵: "둘 다 싫어요"는 둘 다 -1이고 다음 상대는 부전승으로 올라간다', () => {
  const items = Core.wcPick(MENUS, seeded(4), 16, []);
  let s = Core.wcNew(items);
  s = Core.wcChoose(s, 'none');           // 1경기: 둘 다 싫음
  const [a, b] = [items[0].id, items[1].id];
  let guard = 0;
  while (!s.done && guard++ < 50) s = Core.wcChoose(s, 'a');
  const sc = Core.wcScores(s);
  assert.equal(sc[a], -1); assert.equal(sc[b], -1);
  const g = Core.wcGroups(s);
  assert.deepEqual(g.disliked.map((m) => m.id).sort(), [a, b].sort());
  assert.ok(g.liked.length >= 1);
  // 비선호가 저장되면 추천에서 빠진다
  const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [{ uid: 'a', name: '나', prefs: { scores: sc } }], history: [], now: NOW, rng: seeded(1), count: 300 });
  assert.ok(!r.picks.some((p) => p.menu.id === a || p.menu.id === b));
});

test('음식 월드컵: 전부 "둘 다 싫어요"여도 끝까지 진행되고 우승자는 없다', () => {
  const items = Core.wcPick(MENUS, seeded(4), 16, []);
  let s = Core.wcNew(items), guard = 0;
  while (!s.done && guard++ < 50) s = Core.wcChoose(s, 'none');
  assert.equal(s.done, true);
  assert.equal(s.champion, null);
  assert.equal(Core.wcGroups(s).disliked.length, 16);
});

test('마이페이지 요약: 선호/비선호 목록', () => {
  const sum = Core.summarizePrefs(MENUS, { scores: { malatang: 1, jjamppong: 0.8, 'pizza-m': -1, donkatsu: 0.1 } });
  assert.deepEqual(sum.liked.map((x) => x.menu.id), ['malatang', 'jjamppong']);
  assert.deepEqual(sum.disliked.map((x) => x.menu.id), ['pizza-m']);
});

// ---------------------------------------------------------------- 96강
function play(s, pick) { let i = 0; while (!s.done) { Core.wcChoose(s, pick(i++, s)); if (i > 400) throw new Error('끝나지 않음'); } return s; }

test('음식 월드컵(96강): 안주만 서로 다른 음식 96개, 카테고리 고르게, 이미 평가한 메뉴는 뒤로 미룬다', () => {
  const items = Core.wcPick(MENUS, seeded(11), 96, []);
  assert.equal(items.length, 96);
  assert.equal(new Set(items.map((m) => m.kw)).size, 96);
  assert.ok(items.every((m) => m.cat !== MEAL), '마무리 식사는 월드컵에 나오지 않는다');
  for (const c of CATEGORIES.filter((c) => c !== MEAL)) assert.ok(items.some((m) => m.cat === c), c + ' 누락');
  // 이미 평가한 메뉴를 known으로 주면, 아직 평가 안 한 안주가 더 많이 들어온다 (카테고리 균형은 유지하면서)
  const pool = [...new Map(SNACKS.map((m) => [m.kw, m])).values()];
  const known = pool.slice(0, 96).map((m) => m.id);
  const unknownKw = new Set(pool.slice(96).map((m) => m.kw));
  const countUnknown = (arr) => arr.filter((m) => unknownKw.has(m.kw)).length;
  const withKnown = Core.wcPick(MENUS, seeded(12), 96, known);
  const without = Core.wcPick(MENUS, seeded(12), 96, []);
  assert.ok(countUnknown(withKnown) > countUnknown(without), `${countUnknown(withKnown)} vs ${countUnknown(without)}`);
  assert.ok(countUnknown(withKnown) >= Math.min(unknownKw.size, 96) * 0.6);
});

test('음식 월드컵(96강): 부전승이 섞여도 95경기에 끝나고 라운드 이름이 맞다', () => {
  const items = Core.wcPick(MENUS, seeded(11), 96, []);
  const s = Core.wcNew(items);
  assert.equal(Core.wcRoundName(s), '96강');
  assert.equal(s.rounds, 7);
  assert.deepEqual(Core.wcProgress(s), { played: 0, total: 95 });
  const names = new Set();
  play(s, () => { names.add(Core.wcRoundName(s)); return 'a'; });
  assert.equal(s.played, 95);
  assert.deepEqual([...names], ['96강', '48강', '24강', '12강', '6강', '준결승', '결승']);
  assert.equal(s.champion.id, items[0].id);
  assert.equal(Core.wcScores(s)[items[0].id], 1);
});

test('음식 월드컵(96강): 점수는 0~1로 정규화되고 선호 그룹은 상위권만(12개 안팎)', () => {
  const items = Core.wcPick(MENUS, seeded(5), 96, []);
  const rng = seeded(77);
  const s = play(Core.wcNew(items), () => (rng() < 0.5 ? 'a' : 'b'));
  const sc = Core.wcScores(s);
  for (const v of Object.values(sc)) assert.ok(v >= 0 && v <= 1);
  assert.equal(Object.values(sc).filter((v) => v === 1).length, 1);
  const g = Core.wcGroups(s);
  assert.ok(g.liked.length >= 6 && g.liked.length <= 24, `선호 ${g.liked.length}개`);
  assert.equal(g.liked.length + g.neutral.length + g.disliked.length, 96);
  assert.ok(g.neutral.length > g.liked.length);
});

test('라운드 이름은 "둘 다 싫어요"로 사람이 빠져도 대진표 기준으로 유지된다', () => {
  const s = Core.wcNew(Core.wcPick(MENUS, seeded(3), 96, []));
  Core.wcChoose(s, 'none');                       // 2명 탈락 → 이번 라운드 승자는 47명
  const names = new Set();
  while (!s.done) { names.add(Core.wcRoundName(s)); Core.wcChoose(s, 'a'); }
  assert.deepEqual([...names], ['96강', '48강', '24강', '12강', '6강', '준결승', '결승']);
});

test('음식 월드컵: "둘 다 싫어요"를 섞어도 진행률 총 경기 수 추정이 실제와 일치한다', () => {
  const items = Core.wcPick(MENUS, seeded(3), 96, []);
  const s = Core.wcNew(items);
  let i = 0;
  while (!s.done) {
    const pr = Core.wcProgress(s);
    assert.ok(pr.total >= pr.played && pr.total <= 95);
    Core.wcChoose(s, i % 7 === 3 ? 'none' : 'a'); i++;
  }
  assert.equal(Core.wcProgress(s).played, Core.wcProgress(s).total);
  // 마지막 한 경기 전에는 정확히 1경기 남았다고 말해야 한다
  const s2 = Core.wcNew(Core.wcPick(MENUS, seeded(3), 96, []));
  let guard = 0; while (!s2.done && guard++ < 94) Core.wcChoose(s2, 'a');
  assert.equal(Core.wcProgress(s2).total - Core.wcProgress(s2).played, 1);
});

test('이어하기/되돌리기: 선택 기록만으로 같은 상태를 복원하고, 한 수 물릴 수 있다', () => {
  const items = Core.wcPick(MENUS, seeded(8), 96, []);
  const s = Core.wcNew(items);
  [ 'a', 'b', 'none', 'a', 'a', 'b' ].forEach((c) => Core.wcChoose(s, c));
  const saved = JSON.parse(JSON.stringify({ ids: s.items.map((m) => m.id), choices: s.choices }));
  const byIdLocal = Object.fromEntries(MENUS.map((m) => [m.id, m]));
  const restored = Core.wcReplay(saved.ids.map((id) => byIdLocal[id]), saved.choices);
  assert.equal(restored.played, 6);
  assert.deepEqual(restored.dislikes, s.dislikes);
  assert.deepEqual(Core.wcMatch(restored).map((m) => m && m.id), Core.wcMatch(s).map((m) => m && m.id));
  const undone = Core.wcUndo(restored);
  assert.equal(undone.played, 5);
  assert.deepEqual(undone.choices, ['a', 'b', 'none', 'a', 'a']);
  assert.equal(Core.wcUndo(Core.wcNew(items)).played, 0); // 처음에서 되돌려도 안전
});

test('96강 점수로 만든 취향이 추천에 반영된다: 비선호 제외 + 선호 계열이 더 자주 나온다', () => {
  const items = Core.wcPick(MENUS, seeded(21), 96, []);
  const s = play(Core.wcNew(items), (i) => (i === 0 ? 'none' : 'a'));
  const scores = Core.wcScores(s);
  const hated = Object.keys(scores).filter((id) => scores[id] < 0);
  assert.equal(hated.length, 2);
  const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [{ uid: 'a', name: '나', prefs: { scores } }], history: [], now: NOW, rng: seeded(1), count: 300 });
  assert.ok(!r.picks.some((p) => hated.includes(p.menu.id)));
});

test('둘 다 좋아요: 둘 다 ♥ 점수 하한(선호 그룹)을 받고, 대진에는 한쪽만 올라간다 (경기 수는 그대로)', () => {
  const items = Core.wcPick(MENUS, seeded(31), 96, []);
  const s = Core.wcNew(items);
  const [a, b] = Core.wcMatch(s);
  Core.wcChoose(s, 'both-b');
  assert.equal(s.adv[b.id], 1); assert.equal(s.adv[a.id], 0);
  let i = 0; while (!s.done) { Core.wcChoose(s, 'a'); if (++i > 300) throw new Error('끝나지 않음'); }
  assert.equal(s.played, 95);
  const g = Core.wcGroups(s);
  assert.ok(g.scores[a.id] >= 0.5 && g.scores[b.id] >= 0.5, '둘 다 선호 점수 이상');
  assert.ok(g.liked.some((m) => m.id === a.id) && g.liked.some((m) => m.id === b.id));
  assert.equal(g.loved[a.id], true); assert.equal(g.loved[b.id], true);
});

test('둘 다 좋아요만 계속 눌러도 월드컵은 정상 종료된다 (대진이 줄어든다)', () => {
  const s = Core.wcNew(Core.wcPick(MENUS, seeded(32), 96, []));
  let i = 0; while (!s.done) { Core.wcChoose(s, i++ % 2 ? 'both-a' : 'both-b'); if (i > 300) throw new Error('끝나지 않음'); }
  assert.equal(s.played, 95);
  assert.equal(Object.values(Core.wcScores(s)).filter((v) => v >= 0.5).length, 96); // 전부 ♥
});

test('싫어요가 좋아요보다 우선하고, 이어하기/되돌리기에서도 "둘 다 좋아요"가 그대로 복원된다', () => {
  const items = Core.wcPick(MENUS, seeded(33), 96, []);
  const s = Core.wcNew(items);
  const first = Core.wcMatch(s).map((m) => m.id);
  Core.wcChoose(s, 'both-a');
  const choices = ['both-a', 'a', 'none', 'b', 'both-b'];
  choices.slice(1).forEach((c) => Core.wcChoose(s, c));
  const r = Core.wcReplay(items, JSON.parse(JSON.stringify(s.choices)));
  assert.deepEqual(r.loves, s.loves); assert.deepEqual(r.dislikes, s.dislikes);
  assert.deepEqual(Core.wcScores(r), Core.wcScores(s));
  assert.equal(Core.wcUndo(r).loves.length, s.loves.length - 2);
  assert.ok(first.every((id) => Core.wcScores(r)[id] >= 0.5));
  // 같은 메뉴에 좋아요 후 싫어요가 오면 싫어요가 이긴다
  const s2 = Core.wcNew(items); const m0 = Core.wcMatch(s2);
  Core.wcChoose(s2, 'both-a'); s2.dislikes.push(m0[0].id);
  assert.equal(Core.wcScores(s2)[m0[0].id], -1);
  assert.ok(!Core.wcGroups(s2).loved[m0[0].id]);
});

test('누구 취향으로: 교집합이면 상대의 비선호가 빠지고, 한 사람에게 맞추면 그 사람 취향만 본다', () => {
  const husband = { uid: 'b', name: '남편', prefs: { scores: { malatang: -1, donkatsu: 1 } } };
  const wife = { uid: 'a', name: '혜리', prefs: { scores: { malatang: 1 } } };
  const run = (members) => Core.recommend({ menus: MENUS, cond: baseCond, members, history: [], now: NOW, rng: seeded(4), count: 300 });
  assert.ok(!run([wife, husband]).picks.some((p) => p.menu.id === 'malatang'), '교집합: 남편이 싫어하는 마라탕 제외');
  const forWife = run([wife]).picks;
  assert.ok(forWife.some((p) => p.menu.id === 'malatang'), '혜리 기준: 마라탕 나올 수 있음');
  const top = forWife.find((p) => p.menu.id === 'malatang');
  assert.match(top.reasons[0].text, /^혜리님 취향에 잘 맞아요/);
  assert.ok(!run([husband]).picks.some((p) => p.menu.id === 'malatang'), '남편 기준: 마라탕 제외');
  // 취향 정보가 없는 사람 한 명 기준이면 "그 사람에게 무난한" 표현
  const blank = run([{ uid: 'c', name: '민수', prefs: {} }]).picks[0];
  assert.match(blank.reasons[0].text, /^민수님에게 무난한 메뉴예요/);
});

// ---------------------------------------------------------------- 안주 기준 (식사 분리 · 술 필터)
const pickAll = (cond, extra = {}) => Core.recommend({ menus: MENUS, cond: { ...baseCond, ...cond }, members: [me], history: [], now: NOW, rng: seeded(6), count: 500, ...extra }).picks;

test('식사 카테고리는 평소에는 빠지고, 카테고리에서 "식사"를 골라야만 후보가 된다', () => {
  assert.ok(pickAll({}).every((p) => p.menu.cat !== MEAL), '기본: 식사 없음');
  assert.ok(pickAll({ cats: ['한식'] }).every((p) => p.menu.cat === '한식'));
  const onlyMeal = pickAll({ cats: [MEAL] });
  assert.ok(onlyMeal.length >= 20 && onlyMeal.every((p) => p.menu.cat === MEAL), '식사만');
  const both = pickAll({ cats: ['한식', MEAL] });
  assert.ok(both.some((p) => p.menu.cat === MEAL) && both.some((p) => p.menu.cat === '한식') && both.every((p) => ['한식', MEAL].includes(p.menu.cat)));
  // 식사를 골랐을 때의 이유 문장, 식사 + 반주
  const jeyuk = onlyMeal.find((p) => p.menu.id === 'jeyuk');
  assert.ok(jeyuk.reasons.some((r) => r.k === 'meal'));
  assert.ok(pickAll({ cats: [MEAL], drinks: ['막걸리'] }).every((p) => p.menu.drinks.includes('막걸리')));
});

test('술 필터(멀티): 고른 술 중 하나라도 어울리면 후보, 여러 개와 두루 어울릴수록 점수가 높다', () => {
  const makgeolli = pickAll({ drinks: ['막걸리'] });
  assert.ok(makgeolli.length > 5 && makgeolli.every((p) => p.menu.drinks.includes('막걸리')));
  assert.ok(makgeolli.some((p) => p.menu.id === 'haemul-pajeon'));
  const multi = pickAll({ drinks: ['막걸리', '와인'] });
  assert.ok(multi.every((p) => p.menu.drinks.some((d) => ['막걸리', '와인'].includes(d))));
  assert.ok(multi.length > makgeolli.length, '여러 술을 고르면 후보가 넓어진다');
  // 술 두 개 모두와 어울리는 메뉴가 한 개와만 어울리는 메뉴보다 평균 점수가 높다
  const both = multi.filter((p) => p.menu.drinks.includes('막걸리') && p.menu.drinks.includes('와인'));
  const one = multi.filter((p) => !(p.menu.drinks.includes('막걸리') && p.menu.drinks.includes('와인')));
  if (both.length && one.length) {
    const avg = (a) => a.reduce((s, p) => s + p.score, 0) / a.length;
    assert.ok(avg(both) > avg(one) - 0.0001);
  }
  // 이유 문장
  const pajeon = makgeolli.find((p) => p.menu.id === 'haemul-pajeon');
  assert.match(pajeon.reasons.map((r) => r.text).join('/'), /막걸리와 잘 어울려요/);
  const two = multi.find((p) => p.menu.drinks.includes('막걸리') && p.menu.drinks.includes('와인'));
  if (two) assert.match(two.reasons.map((r) => r.text).join('/'), /막걸리·와인 모두와 잘 어울려요/);
  const partial = multi.find((p) => p.menu.drinks.includes('와인') && !p.menu.drinks.includes('막걸리'));
  assert.match(partial.reasons.map((r) => r.text).join('/'), /와인과 잘 어울려요 \(고른 술 중 일부\)/);
});

test('조리 방식/재료 필터: 구이·전·회·탕·튀김·볶음 + 고기/해산물/채소', () => {
  assert.ok(pickAll({ forms: ['구이'] }).every((p) => p.menu.tags.includes('구이')));
  assert.ok(pickAll({ forms: ['전'] }).some((p) => p.menu.id === 'kimchi-jeon'));
  assert.ok(pickAll({ forms: ['회'], mains: ['해산물'] }).every((p) => p.menu.tags.includes('회') && p.menu.tags.includes('해산물')));
  assert.ok(pickAll({ forms: ['볶음'], mains: ['고기'] }).some((p) => p.menu.id === 'jeyuk-bokkeum'));
});

test('후보가 없을 때 술/재료 조건 풀기도 제안한다', () => {
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, drinks: ['위스키'], forms: ['전'], mains: ['해산물'], priceMax: 12000 }, members: [me], history: [], now: NOW, rng: seeded(1), count: 3 });
  assert.equal(r.picks.length, 0);
  assert.ok(r.suggest.length >= 1 && r.suggest.every((s) => s.count > 0));
});

test('새 조리 방식(꼬치·조림·마른안주·플래터·간식) 필터', () => {
  assert.ok(pickAll({ forms: ['꼬치'] }).some((p) => p.menu.id === 'yakitori'));
  assert.ok(pickAll({ forms: ['마른안주'] }).every((p) => p.menu.tags.includes('마른안주')));
  assert.ok(pickAll({ forms: ['간식'] }).some((p) => p.menu.id === 'hotteok') && pickAll({ forms: ['간식'] }).some((p) => p.menu.id === 'isaac-toast'));
  assert.ok(pickAll({ forms: ['플래터'] }).some((p) => p.menu.id === 'cheese-plate'));
  assert.ok(pickAll({ forms: ['조림'] }).some((p) => p.menu.id === 'godeungeo-jorim'));
});

// ---------------------------------------------------------------- 방 모드 (각자 조건 → 합쳐서 뽑기)
const rc = (o = {}) => ({ priceId: 'any', priceMin: null, priceMax: null, cats: [], tastes: [], forms: [], mains: [], drinks: [], ...o });
const room = (conds, extra = {}) => Core.recommendRoom({ menus: MENUS, headcount: 2, conds, members: [me, hubby], history: [], now: NOW, rng: seeded(8), count: 500, ...extra });

test('방: 술은 합집합 — 한 명은 막걸리, 한 명은 와인이면 둘 중 어느 쪽에 어울려도 후보', () => {
  const r = room([{ uid: 'a', cond: rc({ drinks: ['막걸리'] }) }, { uid: 'b', cond: rc({ drinks: ['와인'] }) }]);
  const ids = r.picks.map((p) => p.menu.id);
  assert.ok(r.picks.every((p) => p.menu.drinks.some((d) => ['막걸리', '와인'].includes(d))));
  assert.ok(ids.includes('haemul-pajeon'), '막걸리 안주');
  assert.ok(ids.includes('bruschetta'), '와인 안주');
  assert.equal(r.merged.drinks.join(), '막걸리,와인');
  // 한 명만 술을 골랐으면 그 술 기준 (안 고른 사람은 제한 없음)
  const one = room([{ uid: 'a', cond: rc({ drinks: ['막걸리'] }) }, { uid: 'b', cond: rc() }]);
  assert.ok(one.picks.length > 5 && one.picks.every((p) => p.menu.drinks.includes('막걸리')));
});

test('방: 가격·카테고리·맛·조리·재료는 각자의 조건을 모두 만족(교집합)', () => {
  const cat = room([{ uid: 'a', cond: rc({ cats: ['한식', '일식'] }) }, { uid: 'b', cond: rc({ cats: ['일식', '중식'] }) }]);
  assert.ok(cat.picks.length > 5 && cat.picks.every((p) => p.menu.cat === '일식'));
  const price = room([{ uid: 'a', cond: rc({ priceMax: 15000 }) }, { uid: 'b', cond: rc({ priceMin: 10000 }) }]);
  assert.ok(price.picks.length > 5 && price.picks.every((p) => p.perPerson >= 10000 && p.perPerson <= 15000));
  assert.equal(price.merged.priceMin, 10000); assert.equal(price.merged.priceMax, 15000);
  const form = room([{ uid: 'a', cond: rc({ forms: ['튀김'] }) }, { uid: 'b', cond: rc({ forms: ['구이', '찜'] }) }]);
  assert.ok(form.picks.every((p) => p.menu.tags.includes('튀김') && (p.menu.tags.includes('구이') || p.menu.tags.includes('찜'))));
  const taste = room([{ uid: 'a', cond: rc({ tastes: ['매운맛'] }) }, { uid: 'b', cond: rc({ mains: ['해산물'] }) }]);
  assert.ok(taste.picks.every((p) => p.menu.tags.includes('매운맛') && p.menu.tags.includes('해산물')));
});

test('방: 식사 — 한 명이 골랐고 다른 한 명이 카테고리를 안 골랐으면 식사만, 다른 카테고리를 골랐으면 충돌', () => {
  const ok = room([{ uid: 'a', cond: rc({ cats: [MEAL] }) }, { uid: 'b', cond: rc() }]);
  assert.ok(ok.picks.length > 10 && ok.picks.every((p) => p.menu.cat === MEAL));
  const clash = room([{ uid: 'a', cond: rc({ cats: [MEAL] }) }, { uid: 'b', cond: rc({ cats: ['한식'] }) }]);
  assert.equal(clash.picks.length, 0);
  const none = room([{ uid: 'a', cond: rc() }, { uid: 'b', cond: rc() }]);
  assert.ok(none.picks.every((p) => p.menu.cat !== MEAL));
});

test('방: 후보가 없으면 누구 조건 때문인지 진단한다', () => {
  const r = room([{ uid: 'a', cond: rc({ cats: ['분식'] }) }, { uid: 'b', cond: rc({ cats: ['중식'] }) }]);
  assert.equal(r.picks.length, 0);
  const a = r.diag.find((d) => d.uid === 'a'), b = r.diag.find((d) => d.uid === 'b');
  assert.ok(a.alone > 0 && b.alone > 0, '각자 조건만으로는 후보가 있다');
  assert.equal(a.without, b.alone); assert.equal(b.without, a.alone);
});

test('방: 한 번에 하나만 뽑고(count 기본 1), exclude/기록/취향(who)이 그대로 적용된다', () => {
  const one = Core.recommendRoom({ menus: MENUS, headcount: 2, conds: [{ uid: 'a', cond: rc() }, { uid: 'b', cond: rc() }], members: [me], history: [], now: NOW, rng: seeded(9) });
  assert.equal(one.picks.length, 1);
  const wifeOnly = { uid: 'a', name: '나', prefs: { scores: { malatang: 1 } } };
  const hateful = { uid: 'b', name: '남편', prefs: { scores: { malatang: -1 } } };
  const both = room([{ uid: 'a', cond: rc() }, { uid: 'b', cond: rc() }], { members: [wifeOnly, hateful] });
  assert.ok(!both.picks.some((p) => p.menu.id === 'malatang'), '교집합 취향: 남편이 싫어하면 제외');
  const mine = room([{ uid: 'a', cond: rc() }, { uid: 'b', cond: rc() }], { members: [wifeOnly] });
  assert.ok(mine.picks.some((p) => p.menu.id === 'malatang'), '내 취향으로: 나오는 메뉴');
  const ex = room([{ uid: 'a', cond: rc() }, { uid: 'b', cond: rc() }], { exclude: { 'chicken-fried': true } });
  assert.ok(!ex.picks.some((p) => p.menu.id === 'chicken-fried'));
});

test('권장 인원 표기: 범위가 같으면 "2인분", 다르면 "2~3인분"', () => {
  assert.equal(Core.servesText(byId['dakbokkeum-m']), '2~3인분');
  assert.equal(Core.servesText(byId['dakbal']), '2인분');
  const r = Core.recommend({ menus: MENUS.filter((m) => m.id === 'dakbal'), cond: baseCond, members: [me], history: [], now: NOW, rng: seeded(1), count: 1 });
  assert.match(r.picks[0].reasons.map((x) => x.text).join('/'), /권장 2인분/);
});
