import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.mjs';
import { MockKV } from '../dev/mock-kv.mjs';

const makeEnv = () => ({ DP: new MockKV() });
async function call(env, method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await worker.fetch(new Request('https://x.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json() };
}
async function couple(env) {
  const a = await call(env, 'POST', '/api/signup', { id: 'hyeri', password: 'password1', name: '혜리', household: { mode: 'create' } });
  const b = await call(env, 'POST', '/api/signup', { id: 'hubby', password: 'password2', name: '남편', household: { mode: 'join', code: a.body.household.code } });
  return { ta: a.body.token, tb: b.body.token };
}
const cond = (o = {}) => ({ priceId: 'any', priceMin: null, priceMax: null, cats: [], drinks: [], tastes: [], forms: [], mains: [], ...o });
const result = (id = 'dakbal', n) => ({ menuId: id, perPerson: 11000, reasons: [{ k: 'price', text: '인당 약 11,000원' }], ...(n ? { n } : {}) });
const member = (v, uid) => v.members.find((m) => m.uid === uid);

async function readyRoom(env, ta, tb, ca = cond({ drinks: ['소주'] }), cb = cond({ drinks: ['맥주'] })) {
  await call(env, 'POST', '/api/room', null, ta);
  await call(env, 'POST', '/api/room/join', null, tb);
  await call(env, 'PUT', '/api/room/me', { cond: ca, ready: true }, ta);
  return call(env, 'PUT', '/api/room/me', { cond: cb, ready: true }, tb);
}

test('방 만들기: 만든 사람이 방장, 상대는 아직 미참여. 이미 열린 방이 있으면 그 방을 그대로 보여준다', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  assert.equal((await call(env, 'GET', '/api/room', null, ta)).body.room, null);
  const created = await call(env, 'POST', '/api/room', null, ta);
  assert.equal(created.status, 201);
  assert.equal(created.body.room.hostUid, 'hyeri'); assert.equal(created.body.room.phase, 'setup'); assert.equal(created.body.room.round, 1);
  assert.equal(member(created.body, 'hyeri').joined, true); assert.equal(member(created.body, 'hubby').joined, false);
  const seen = await call(env, 'GET', '/api/room', null, tb);
  assert.equal(seen.body.room.roomId, created.body.room.roomId);
  // 상대가 "방 만들기"를 눌러도 새 방이 생기지 않고 기존 방(방장 그대로)이 보인다
  const again = await call(env, 'POST', '/api/room', null, tb);
  assert.equal(again.body.room.roomId, created.body.room.roomId); assert.equal(again.body.room.hostUid, 'hyeri');
});

test('참여 전에는 조건을 낼 수 없고, 참여하면 준비 상태가 보인다', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await call(env, 'POST', '/api/room', null, ta);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: cond(), ready: true }, tb)).status, 403);
  const joined = await call(env, 'POST', '/api/room/join', null, tb);
  assert.equal(member(joined.body, 'hubby').joined, true); assert.equal(member(joined.body, 'hubby').ready, false);
  assert.equal(joined.body.allReady, false);
  assert.equal((await call(env, 'POST', '/api/room/join', null, 'bogus')).status, 401);
});

test('눈치 방지: 모두 준비하기 전에는 상대 조건이 내려오지 않고, 모두 준비하면 서로 보인다', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await call(env, 'POST', '/api/room', null, ta); await call(env, 'POST', '/api/room/join', null, tb);
  await call(env, 'PUT', '/api/room/me', { cond: cond({ drinks: ['소주'], cats: ['한식'] }), ready: true }, ta);
  const bSees = await call(env, 'GET', '/api/room', null, tb);
  assert.equal(member(bSees.body, 'hyeri').ready, true);
  assert.equal(member(bSees.body, 'hyeri').cond, undefined, '준비 전에는 조건 비공개');
  assert.ok(!JSON.stringify(bSees.body).includes('소주'));
  assert.equal(bSees.body.allReady, false);
  const done = await call(env, 'PUT', '/api/room/me', { cond: cond({ drinks: ['맥주'] }), ready: true }, tb);
  assert.equal(done.body.allReady, true);
  assert.deepEqual(member(done.body, 'hyeri').cond.cats, ['한식']);
  assert.deepEqual(member(done.body, 'hubby').cond.drinks, ['맥주']);
});

test('뽑기는 방장만, 모두 준비된 뒤에만. 뽑을 때마다 서버가 횟수를 센다', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await call(env, 'POST', '/api/room', null, ta); await call(env, 'POST', '/api/room/join', null, tb);
  assert.equal((await call(env, 'POST', '/api/room/pick', result(), ta)).status, 409, '준비 전 뽑기 불가');
  await call(env, 'PUT', '/api/room/me', { cond: cond(), ready: true }, ta);
  await call(env, 'PUT', '/api/room/me', { cond: cond(), ready: true }, tb);
  assert.equal((await call(env, 'POST', '/api/room/pick', result(), tb)).status, 403, '방장이 아니면 불가');
  const first = await call(env, 'POST', '/api/room/pick', result('dakbal'), ta);
  assert.equal(first.status, 200);
  assert.equal(first.body.room.pickCount, 1); assert.equal(first.body.room.phase, 'picked');
  assert.equal(first.body.room.result.n, 1); assert.equal(first.body.room.result.menuId, 'dakbal');
  // 클라이언트가 n을 속여서 보내도 무시된다
  const second = await call(env, 'POST', '/api/room/pick', result('pizza-m', 99), ta);
  assert.equal(second.body.room.pickCount, 2); assert.equal(second.body.room.result.n, 2);
  assert.deepEqual(second.body.room.history.map((h) => h.menuId), ['dakbal', 'pizza-m']);
  // 상대 화면에서도 같은 결과/횟수가 보인다
  const bSees = await call(env, 'GET', '/api/room', null, tb);
  assert.equal(bSees.body.room.pickCount, 2); assert.equal(bSees.body.room.result.menuId, 'pizza-m');
  // 잘못된 결과 형식
  assert.equal((await call(env, 'POST', '/api/room/pick', { menuId: 'BAD ID', perPerson: 1, reasons: [] }, ta)).status, 400);
  assert.equal((await call(env, 'POST', '/api/room/pick', { menuId: 'dakbal', perPerson: 'x', reasons: [] }, ta)).status, 400);
});

test('조건 잠금: 준비완료 후에는 수정 불가(취소 후 가능), 뽑기가 시작되면 조건 변경 불가', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await readyRoom(env, ta, tb);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: cond({ cats: ['중식'] }) }, ta)).status, 409);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: cond({ cats: ['중식'] }), ready: true }, ta)).status, 409);
  const cancel = await call(env, 'PUT', '/api/room/me', { ready: false }, ta);
  assert.equal(member(cancel.body, 'hyeri').ready, false); assert.equal(cancel.body.allReady, false);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: cond({ cats: ['중식'] }) }, ta)).status, 200);
  assert.equal((await call(env, 'PUT', '/api/room/me', { ready: true }, ta)).status, 200);
  await call(env, 'POST', '/api/room/pick', result(), ta);
  assert.equal((await call(env, 'PUT', '/api/room/me', { ready: false }, tb)).status, 409, '뽑기 후 준비 취소 불가');
});

test('조건 검증: 형식이 잘못되면 거부', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await call(env, 'POST', '/api/room', null, ta); await call(env, 'POST', '/api/room/join', null, tb);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: { cats: 'x' }, ready: true }, tb)).status, 400);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: cond({ cats: ['가'.repeat(30)] }), ready: true }, tb)).status, 400);
  assert.equal((await call(env, 'PUT', '/api/room/me', { cond: cond({ priceMin: -5 }), ready: true }, tb)).status, 400);
  assert.equal((await call(env, 'PUT', '/api/room/me', { ready: true }, tb)).status, 400, '조건 없이 준비 불가');
});

test('의견내기: 상대는 "다시 뽑자"를 요청할 수 있고, 방장이 다시 뽑으면 요청이 사라진다', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await readyRoom(env, ta, tb);
  assert.equal((await call(env, 'PUT', '/api/room/me', { reroll: true }, tb)).status, 409, '뽑기 전에는 요청 불가');
  await call(env, 'POST', '/api/room/pick', result(), ta);
  assert.equal((await call(env, 'PUT', '/api/room/me', { reroll: true }, ta)).status, 400, '방장은 직접 뽑으면 됨');
  const req = await call(env, 'PUT', '/api/room/me', { reroll: true }, tb);
  assert.equal(member(req.body, 'hubby').reroll, true);
  assert.equal(member((await call(env, 'GET', '/api/room', null, ta)).body, 'hubby').reroll, true, '방장 화면에 요청이 보임');
  const again = await call(env, 'POST', '/api/room/pick', result('pizza-m'), ta);
  assert.equal(member(again.body, 'hubby').reroll, false, '다시 뽑으면 요청이 초기화');
});

test('조건 다시 정하기: 라운드가 올라가며 모두의 준비가 풀리고 횟수/결과가 초기화된다 (내 이전 조건은 내게만 남아 있다)', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await readyRoom(env, ta, tb, cond({ cats: ['한식'] }), cond({ cats: ['일식'] }));
  await call(env, 'POST', '/api/room/pick', result(), ta); await call(env, 'POST', '/api/room/pick', result('pizza-m'), ta);
  assert.equal((await call(env, 'POST', '/api/room/reset', null, tb)).status, 403);
  const reset = await call(env, 'POST', '/api/room/reset', null, ta);
  assert.equal(reset.body.room.round, 2); assert.equal(reset.body.room.pickCount, 0);
  assert.equal(reset.body.room.result, null); assert.deepEqual(reset.body.room.history, []); assert.equal(reset.body.room.phase, 'setup');
  assert.equal(member(reset.body, 'hyeri').ready, false); assert.equal(member(reset.body, 'hubby').ready, false);
  assert.deepEqual(member(reset.body, 'hyeri').cond.cats, ['한식'], '내 이전 조건은 내게 보인다(미리 채워주기용)');
  assert.equal(member(reset.body, 'hubby').cond, undefined, '상대 조건은 다시 숨김');
  const bReady = await call(env, 'PUT', '/api/room/me', { ready: true }, tb); // 이전 조건 그대로 다시 준비
  assert.equal(member(bReady.body, 'hubby').ready, true);
});

test('방 설정: 방장만, 준비 단계에서만. 누구 취향으로(who)/인원', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await call(env, 'POST', '/api/room', null, ta); await call(env, 'POST', '/api/room/join', null, tb);
  assert.equal((await call(env, 'PUT', '/api/room/settings', { who: 'hubby' }, tb)).status, 403);
  assert.equal((await call(env, 'PUT', '/api/room/settings', { who: 'nobody' }, ta)).status, 400);
  assert.equal((await call(env, 'PUT', '/api/room/settings', { headcount: 9 }, ta)).status, 400);
  const ok = await call(env, 'PUT', '/api/room/settings', { who: 'hubby', headcount: 3 }, ta);
  assert.equal(ok.body.room.who, 'hubby'); assert.equal(ok.body.room.headcount, 3);
  assert.equal((await call(env, 'GET', '/api/room', null, tb)).body.room.who, 'hubby');
  await call(env, 'PUT', '/api/room/me', { cond: cond(), ready: true }, ta); await call(env, 'PUT', '/api/room/me', { cond: cond(), ready: true }, tb);
  await call(env, 'POST', '/api/room/pick', result(), ta);
  assert.equal((await call(env, 'PUT', '/api/room/settings', { who: 'all' }, ta)).status, 409);
});

test('확정(닫기) 후에는 상대도 결과를 볼 수 있고, 새 방을 열면 이전 참가 기록이 정리된다', async () => {
  const env = makeEnv(); const { ta, tb } = await couple(env);
  await readyRoom(env, ta, tb);
  await call(env, 'POST', '/api/room/pick', result('dakbal'), ta);
  assert.equal((await call(env, 'POST', '/api/room/close', { menuId: 'dakbal' }, tb)).status, 403);
  const closed = await call(env, 'POST', '/api/room/close', { menuId: 'dakbal' }, ta);
  assert.equal(closed.body.room.phase, 'closed'); assert.equal(closed.body.room.finalMenuId, 'dakbal');
  assert.equal((await call(env, 'GET', '/api/room', null, tb)).body.room.finalMenuId, 'dakbal');
  assert.equal((await call(env, 'POST', '/api/room/join', null, tb)).status, 404, '닫힌 방엔 참여 불가');
  assert.equal((await call(env, 'PUT', '/api/room/me', { ready: false }, tb)).status, 404);
  const fresh = await call(env, 'POST', '/api/room', null, tb); // 이번엔 남편이 방장
  assert.equal(fresh.status, 201); assert.equal(fresh.body.room.hostUid, 'hubby'); assert.equal(fresh.body.room.round, 1);
  assert.equal(member(fresh.body, 'hyeri').joined, false, '옛 참가 기록이 정리됨');
});

test('다른 가구의 방과 분리된다', async () => {
  const env = makeEnv(); const { ta } = await couple(env);
  const other = await call(env, 'POST', '/api/signup', { id: 'other', password: 'password1', name: '남', household: { mode: 'create' } });
  await call(env, 'POST', '/api/room', null, ta);
  assert.equal((await call(env, 'GET', '/api/room', null, other.body.token)).body.room, null);
  assert.equal((await call(env, 'POST', '/api/room/join', null, other.body.token)).status, 404);
  assert.equal((await call(env, 'GET', '/api/room')).status, 401);
});
