import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { findRating } from '../worker/worker.mjs';
import { MockKV } from '../dev/mock-kv.mjs';

function makeEnv(extra = {}) { return { DP: new MockKV(), ...extra }; }
async function call(env, method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('https://x.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json(), headers: res.headers };
}
async function setupCouple(env) {
  const a = await call(env, 'POST', '/api/signup', { id: 'hyeri', password: 'password1', name: '혜리', household: { mode: 'create' } });
  assert.equal(a.status, 201);
  const code = a.body.household.code;
  const b = await call(env, 'POST', '/api/signup', { id: 'hubby', password: 'password2', name: '남편', household: { mode: 'join', code } });
  assert.equal(b.status, 201);
  return { code, ta: a.body.token, tb: b.body.token };
}

test('가입: 가구 생성 → 초대 코드로 배우자 합류, 서로의 취향이 state에 보인다', async () => {
  const env = makeEnv();
  const { code, ta, tb } = await setupCouple(env);
  assert.match(code, /^[A-Z2-9]{6}$/);
  const st = await call(env, 'GET', '/api/state', null, tb);
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.members.map((m) => m.name).sort(), ['남편', '혜리']);
  assert.equal(st.body.household.settings.recentDays, 7);
  assert.equal(st.body.me.uid, 'hubby');
  // 비밀번호 해시/솔트가 응답에 새어나가지 않는다
  assert.ok(!JSON.stringify(st.body).includes('hash') && !JSON.stringify(st.body).includes('salt'));
  // KV에 비밀번호 평문이 저장되지 않는다
  for (const [, v] of env.DP.m) assert.ok(!v.value.includes('password1'));
});

test('가입 검증: 중복 아이디, 짧은 비밀번호, 잘못된 아이디, 없는 초대 코드, 가입 코드', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/signup', { id: 'hyeri', password: 'password1', name: '혜리' });
  assert.equal((await call(env, 'POST', '/api/signup', { id: 'hyeri', password: 'password1', name: 'x' })).status, 409);
  assert.equal((await call(env, 'POST', '/api/signup', { id: 'new1', password: 'short', name: 'x' })).status, 400);
  assert.equal((await call(env, 'POST', '/api/signup', { id: 'A B', password: 'password1', name: 'x' })).status, 400);
  assert.equal((await call(env, 'POST', '/api/signup', { id: 'new2', password: 'password1', name: 'x', household: { mode: 'join', code: 'ZZZZZZ' } })).status, 404);
  const locked = makeEnv({ SIGNUP_CODE: 'secret' });
  assert.equal((await call(locked, 'POST', '/api/signup', { id: 'abc', password: 'password1', name: 'x' })).status, 403);
  assert.equal((await call(locked, 'POST', '/api/signup', { id: 'abc', password: 'password1', name: 'x', signupCode: 'secret' })).status, 201);
});

test('가구는 최대 4명', async () => {
  const env = makeEnv();
  const a = await call(env, 'POST', '/api/signup', { id: 'user1', password: 'password1', name: '1' });
  const code = a.body.household.code;
  for (const id of ['user2', 'user3', 'user4']) assert.equal((await call(env, 'POST', '/api/signup', { id, password: 'password1', name: id, household: { mode: 'join', code } })).status, 201);
  assert.equal((await call(env, 'POST', '/api/signup', { id: 'user5', password: 'password1', name: '5', household: { mode: 'join', code } })).status, 409);
});

test('로그인: 성공 / 실패 / 8회 실패 후 잠금', async () => {
  const env = makeEnv();
  await setupCouple(env);
  const ok = await call(env, 'POST', '/api/login', { id: 'HYERI', password: 'password1' });
  assert.equal(ok.status, 200); assert.ok(ok.body.token);
  for (let i = 0; i < 8; i++) assert.equal((await call(env, 'POST', '/api/login', { id: 'hubby', password: 'wrong-pass' })).status, 401);
  assert.equal((await call(env, 'POST', '/api/login', { id: 'hubby', password: 'password2' })).status, 429);
  assert.equal((await call(env, 'POST', '/api/login', { id: 'nobody', password: 'whatever12' })).status, 401);
});

test('인증: 토큰 없거나 틀리면 401, 로그아웃하면 토큰이 무효화된다', async () => {
  const env = makeEnv();
  const { ta } = await setupCouple(env);
  assert.equal((await call(env, 'GET', '/api/state')).status, 401);
  assert.equal((await call(env, 'GET', '/api/state', null, 'bogus')).status, 401);
  assert.equal((await call(env, 'POST', '/api/logout', null, ta)).status, 200);
  assert.equal((await call(env, 'GET', '/api/state', null, ta)).status, 401);
});

test('취향 저장: 병합/교체, 잘못된 값 거부, 월드컵 횟수, 서로의 취향은 덮어쓰지 않는다', async () => {
  const env = makeEnv();
  const { ta, tb } = await setupCouple(env);
  let r = await call(env, 'PUT', '/api/prefs', { scores: { jjajang: 1, 'pizza-m': -1 }, completedWorldcup: true }, ta);
  assert.equal(r.status, 200); assert.equal(r.body.prefs.wc.runs, 1);
  r = await call(env, 'PUT', '/api/prefs', { scores: { pho: 0.55 } }, ta);
  assert.deepEqual(Object.keys(r.body.prefs.scores).sort(), ['jjajang', 'pho', 'pizza-m']);
  r = await call(env, 'PUT', '/api/prefs', { scores: { pho: 0.3 }, mode: 'replace' }, ta);
  assert.deepEqual(r.body.prefs.scores, { pho: 0.3 });
  assert.equal((await call(env, 'PUT', '/api/prefs', { scores: { pho: 5 } }, ta)).status, 400);
  assert.equal((await call(env, 'PUT', '/api/prefs', { scores: { 'BAD ID': 1 } }, ta)).status, 400);
  await call(env, 'PUT', '/api/prefs', { scores: { donkatsu: 1 } }, tb);
  const st = await call(env, 'GET', '/api/state', null, ta);
  const byName = Object.fromEntries(st.body.members.map((m) => [m.name, m.prefs.scores]));
  assert.deepEqual(byName['혜리'], { pho: 0.3 });
  assert.deepEqual(byName['남편'], { donkatsu: 1 });
  const reset = await call(env, 'POST', '/api/prefs/reset', null, ta);
  assert.deepEqual(reset.body.prefs.scores, {}); assert.equal(reset.body.prefs.wc.runs, 0);
});

test('먹은 기록: 최신순 정렬, 평가 저장(기록이 있어야 함), 삭제하면 평가도 같이 사라진다', async () => {
  const env = makeEnv();
  const { ta, tb } = await setupCouple(env);
  const t0 = Date.now() - 5 * 86400000;
  const e1 = await call(env, 'POST', '/api/history', { menuId: 'jjajang', name: '짜장면', cat: '중식', at: t0 }, ta);
  const e2 = await call(env, 'POST', '/api/history', { menuId: 'pho', name: '쌀국수', cat: '아시안', rest: '맛있는 쌀국수집', at: t0 + 86400000 }, tb);
  assert.equal(e1.status, 201);
  let st = await call(env, 'GET', '/api/state', null, ta);
  assert.deepEqual(st.body.history.map((h) => h.menuId), ['pho', 'jjajang']);
  assert.equal(st.body.history[0].rest, '맛있는 쌀국수집');
  assert.equal(st.body.history[0].by, 'hubby');

  assert.equal((await call(env, 'POST', '/api/feedback', { logId: '0000000000000-aaaaaa', menuId: 'pho', v: 1 }, ta)).status, 404);
  assert.equal((await call(env, 'POST', '/api/feedback', { logId: e2.body.entry.id, menuId: 'pho', v: 2 }, ta)).status, 400);
  assert.equal((await call(env, 'POST', '/api/feedback', { logId: e2.body.entry.id, menuId: 'pho', v: 1 }, ta)).status, 200);
  assert.equal((await call(env, 'POST', '/api/feedback', { logId: e2.body.entry.id, menuId: 'pho', v: -1 }, tb)).status, 200);
  st = await call(env, 'GET', '/api/state', null, ta);
  const fb = Object.fromEntries(st.body.members.map((m) => [m.name, m.prefs.feedback[e2.body.entry.id]?.v]));
  assert.deepEqual(fb, { 혜리: 1, 남편: -1 });

  assert.equal((await call(env, 'DELETE', '/api/history?id=' + e2.body.entry.id, null, ta)).status, 200);
  st = await call(env, 'GET', '/api/state', null, tb);
  assert.deepEqual(st.body.history.map((h) => h.menuId), ['jjajang']);
  assert.ok(st.body.members.every((m) => !m.prefs.feedback[e2.body.entry.id]));
  assert.equal((await call(env, 'DELETE', '/api/history?id=../x', null, ta)).status, 400);
});

test('다른 가구의 기록/취향은 보이지 않는다', async () => {
  const env = makeEnv();
  const { ta } = await setupCouple(env);
  const other = await call(env, 'POST', '/api/signup', { id: 'other', password: 'password1', name: '남', household: { mode: 'create' } });
  await call(env, 'POST', '/api/history', { menuId: 'jjajang', name: '짜장면', cat: '중식' }, ta);
  await call(env, 'PUT', '/api/prefs', { scores: { pho: 1 } }, ta);
  const st = await call(env, 'GET', '/api/state', null, other.body.token);
  assert.equal(st.body.history.length, 0);
  assert.equal(st.body.members.length, 1);
  assert.deepEqual(st.body.members[0].prefs.scores, {});
});

test('가구 설정: 범위 밖 값은 무시하고 유효한 값만 저장', async () => {
  const env = makeEnv();
  const { ta, tb } = await setupCouple(env);
  const r = await call(env, 'PUT', '/api/household', { address: '서울 금천구 가산디지털1로 136', lat: 37.4777, lng: 126.8878, radiusM: 99999, priceMul: 1.1, recentDays: 5, defaultHeadcount: 3 }, ta);
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.radiusM, 2000);       // 범위 밖 → 기본값 유지
  assert.equal(r.body.settings.priceMul, 1.1);
  assert.equal(r.body.settings.lat, 37.4777);
  const st = await call(env, 'GET', '/api/state', null, tb);                      // 배우자에게도 공유됨
  assert.equal(st.body.household.settings.address, '서울 금천구 가산디지털1로 136');
  assert.equal(st.body.household.settings.recentDays, 5);
  const bad = await call(env, 'PUT', '/api/household', { lat: 0, lng: 0 }, ta);    // 한국 밖 좌표는 무시
  assert.equal(bad.body.settings.lat, 37.4777);
});

test('CORS 헤더와 ALLOWED_ORIGIN', async () => {
  const open = await call(makeEnv(), 'GET', '/api/health');
  assert.equal(open.headers.get('access-control-allow-origin'), '*');
  const narrow = await call(makeEnv({ ALLOWED_ORIGIN: 'https://doxoba.github.io' }), 'GET', '/api/health');
  assert.equal(narrow.headers.get('access-control-allow-origin'), 'https://doxoba.github.io');
  const pre = await worker.fetch(new Request('https://x.test/api/state', { method: 'OPTIONS' }), makeEnv());
  assert.equal(pre.status, 200);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
});

test('평점 탐색: 알려진 키 이름만 인식하고 엉뚱한 score는 무시', () => {
  assert.deepEqual(findRating({ a: { b: { average_score: 4.26, review_count: 120 } } }), { score: 4.3, count: 120, path: '/a/b/average_score' });
  assert.equal(findRating({ x: { score: 5, count: 3 }, menu: { items: [] } }), null);
  assert.equal(findRating({ comment: { scoresum: 90, scorecnt: 20 } }).score, 4.5);
  assert.equal(findRating(null), null);
});
