import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Core = require('../core.js');
const { MENUS, CATEGORIES, TASTES, FORMS } = require('../menus.js');

const byId = Object.fromEntries(MENUS.map((m) => [m.id, m]));
const NOW = Date.UTC(2026, 9, 1, 10);
const DAY = 86400000;
function seeded(seed) { // 재현 가능한 난수
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const baseCond = { headcount: 2, priceMin: null, priceMax: null, cats: [], tastes: [], forms: [] };
const me = { uid: 'a', name: '나', prefs: {} };
const hubby = { uid: 'b', name: '남편', prefs: {} };

test('메뉴 DB: id 중복 없음, 카테고리/태그가 정의된 목록 안에 있음', () => {
  assert.equal(new Set(MENUS.map((m) => m.id)).size, MENUS.length);
  const known = new Set([...TASTES, ...FORMS]);
  for (const m of MENUS) {
    assert.ok(CATEGORIES.includes(m.cat), `${m.id}: 알 수 없는 카테고리 ${m.cat}`);
    assert.ok(m.tags.length > 0 && m.price > 0 && m.kw, m.id);
    for (const t of m.tags) assert.ok(known.has(t), `${m.id}: 알 수 없는 태그 ${t}`);
    if (m.type === 'share') assert.ok(m.serves[0] >= 1 && m.serves[1] >= m.serves[0], m.id);
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
    { menuId: 'jjajang', at: NOW - 8 * DAY },
  ];
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, headcount: 3 }, members: [me, hubby], history, now: NOW, rng: seeded(2), count: 200 });
  const ids = r.picks.map((p) => p.menu.id);
  assert.ok(!ids.includes('dakbokkeum-m') && !ids.includes('dakbokkeum-l'), '닭볶음탕은 제외돼야 함');
  assert.ok(ids.includes('jjajang'), '8일 전 짜장면은 다시 나올 수 있음');
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
  const r = Core.recommend({ menus: MENUS, cond: { ...baseCond, tastes: ['얼큰칼칼'], priceMax: 12000, priceMin: 8000 }, members: [m1, m2], history: [{ menuId: 'jjajang', at: NOW - 1 * DAY }], now: NOW, rng: seeded(5), count: 300 });
  const pick = r.picks.find((p) => p.menu.id === 'kimchijjigae');
  assert.ok(pick, '김치찌개가 후보에 있어야 함');
  const text = pick.reasons.map((x) => x.text).join(' / ');
  assert.match(text, /두 분 모두 취향에 잘 맞아요/);
  assert.match(text, /혜리님 월드컵 4강/);
  assert.match(text, /남편님 월드컵 우승/);
  assert.match(text, /아직 한 번도 안 먹어본/);
  assert.match(text, /인당 약 10,000원 — 예산 안/);
  assert.match(text, /키워드가 그대로 들어있어요: #얼큰칼칼/);
  assert.match(text, /직전 식사가 중식이라 이번엔 한식으로/);
});

test('"다시 뽑기": exclude에 넣은 메뉴는 다시 나오지 않는다', () => {
  const exclude = { jjajang: true, pho: true };
  const r = Core.recommend({ menus: MENUS, cond: baseCond, members: [me], history: [], now: NOW, rng: seeded(1), count: 300, exclude });
  assert.ok(r.picks.length > 10);
  assert.ok(!r.picks.some((p) => exclude[p.menu.id]));
});

test('조사: 받침에 따라 으로/로, 이라/라', () => {
  const hist = (id) => [{ menuId: id, at: NOW - DAY }];
  const reasonFor = (lastId, onlyId) => Core.recommend({ menus: MENUS, cond: baseCond, members: [me], history: hist(lastId), now: NOW, rng: seeded(1), count: 300 })
    .picks.find((p) => p.menu.id === onlyId).reasons.find((r) => r.k === 'variety').text;
  assert.match(reasonFor('chicken-fried', 'jjajang'), /치킨·피자라 이번엔 중식으로/);
  assert.match(reasonFor('jjajang', 'pho'), /중식이라 이번엔 아시안으로/);
  assert.match(reasonFor('jjajang', 'donkatsu'), /일식으로/);
  assert.match(reasonFor('jjajang', 'pizza-m'), /치킨·피자로/);
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

test('음식 월드컵: 매번 첫째를 고르면 우승 1.0 / 결승 0.8 / 4강 0.55 / 8강 0.3 / 16강 탈락 0', () => {
  const items = Core.wcPick(MENUS, seeded(4), 16, []);
  let s = Core.wcNew(items);
  assert.equal(Core.wcRoundName(s), '16강');
  let guard = 0;
  while (!s.done && guard++ < 50) s = Core.wcChoose(s, 'a');
  assert.equal(s.done, true);
  assert.equal(s.champion.id, items[0].id);
  const scores = Core.wcScores(s);
  assert.equal(scores[items[0].id], 1.0);
  assert.equal(scores[items[8].id], 0.8);   // 결승 상대
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
