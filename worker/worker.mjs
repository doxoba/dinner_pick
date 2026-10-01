// 저녁픽 API — Cloudflare Worker (KV 바인딩 이름: DP)
//
// 하는 일: 회원가입/로그인(세션 토큰) · 같은 "가구"(부부)끼리 취향/먹은 기록/설정 공유 저장 · 카카오 평점 프록시
// 추천 계산은 전부 브라우저(core.js)에서 하므로 여기는 얇은 저장소 + 인증이다.
//
// 환경변수(선택)
//   SIGNUP_CODE     설정하면 회원가입 때 이 코드를 입력해야 한다 (공개 URL이라 가입을 막아두는 용도 — 설정 권장)
//   ALLOWED_ORIGIN  설정하면 CORS를 이 오리진(예: https://doxoba.github.io)으로 좁힌다. 없으면 '*'
//
// KV 키 구조 (쓰기 경쟁을 피하려고 "사람마다/기록마다" 키를 따로 쓴다 — 한끼픽 팀 모드와 같은 원칙)
//   user:{id}                 { id, name, salt, hash, iter, hid }
//   sess:{token}              { uid }                         (30일 TTL)
//   hh:{CODE}                 { code, members:[uid], settings }
//   pref:{CODE}:{uid}         { scores, feedback, wc }        (본인만 씀)
//   log:{CODE}:{역순시각}-{랜덤}  value '1' + metadata(메뉴/식당/시각) — list 한 번으로 목록을 읽는다
//   fail:{id}                 로그인 실패 횟수 (15분 TTL)

const SESSION_TTL = 60 * 60 * 24 * 30;
const PBKDF2_ITER = 100000; // Workers의 PBKDF2 반복 상한
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_MEMBERS = 4;
const MAX_BODY = 40000;
const MAX_LOGS = 80;
const KAKAO_API = 'https://place-api.map.kakao.com/places/panel3/';
const enc = new TextEncoder();

const DEFAULT_SETTINGS = { address: '', lat: null, lng: null, radiusM: 2000, priceMul: 1, recentDays: 7, defaultHeadcount: 2 };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? '서버 오류' : e.message }, status, cors);
    }
  },
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
}

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const m = request.method;
  if (!env.DP) throw new HttpError(500, 'KV 바인딩(DP)이 없습니다');

  if (pathname === '/api/health') return json({ ok: true, signupCodeRequired: !!env.SIGNUP_CODE });
  if (pathname === '/api/signup' && m === 'POST') return signup(request, env);
  if (pathname === '/api/login' && m === 'POST') return login(request, env);

  const session = await authenticate(request, env);
  if (pathname === '/api/logout' && m === 'POST') { await env.DP.delete('sess:' + session.token); return json({ ok: true }); }
  if (pathname === '/api/state' && m === 'GET') return json(await buildState(env, session.user));
  if (pathname === '/api/prefs' && m === 'PUT') return savePrefs(request, env, session.user);
  if (pathname === '/api/prefs/reset' && m === 'POST') return resetPrefs(env, session.user);
  if (pathname === '/api/feedback' && m === 'POST') return saveFeedback(request, env, session.user);
  if (pathname === '/api/history' && m === 'POST') return addHistory(request, env, session.user);
  if (pathname === '/api/history' && m === 'DELETE') return deleteHistory(url, env, session.user);
  if (pathname === '/api/household' && m === 'PUT') return saveHousehold(request, env, session.user);
  if (pathname === '/api/place' && m === 'GET') return placeInfo(url);
  throw new HttpError(404, '없는 경로입니다');
}

// ------------------------------------------------------------------ 공통
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, '요청이 너무 큽니다');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'JSON 형식이 아닙니다'); }
}
const kvGet = (env, key) => env.DP.get(key, 'json');
const kvPut = (env, key, val, opts) => env.DP.put(key, JSON.stringify(val), opts);

function b64(buf) {
  let s = ''; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}
function b64url(buf) { return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randomToken(bytes = 32) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
function randomCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

async function hashPassword(password, saltB64, iter = PBKDF2_ITER) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function authenticate(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) throw new HttpError(401, '로그인이 필요합니다');
  const sess = await kvGet(env, 'sess:' + token);
  if (!sess) throw new HttpError(401, '세션이 만료되었습니다. 다시 로그인해주세요');
  const user = await kvGet(env, 'user:' + sess.uid);
  if (!user) throw new HttpError(401, '계정을 찾을 수 없습니다');
  return { token, user };
}
async function newSession(env, uid) {
  const token = randomToken();
  await kvPut(env, 'sess:' + token, { uid }, { expirationTtl: SESSION_TTL });
  return token;
}

// ------------------------------------------------------------------ 가입 / 로그인
const ID_RE = /^[a-z0-9_]{3,20}$/;

async function signup(request, env) {
  const body = await readBody(request);
  if (env.SIGNUP_CODE && String(body.signupCode || '') !== env.SIGNUP_CODE) throw new HttpError(403, '가입 코드가 맞지 않습니다');
  const id = String(body.id || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!ID_RE.test(id)) throw new HttpError(400, '아이디는 영문 소문자·숫자·_ 3~20자로 입력해주세요');
  if (!name || name.length > 12) throw new HttpError(400, '표시 이름은 1~12자로 입력해주세요');
  if (password.length < 8 || password.length > 100) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다');
  if (await kvGet(env, 'user:' + id)) throw new HttpError(409, '이미 사용 중인 아이디입니다');

  const hhReq = body.household || {};
  let hh;
  if (hhReq.mode === 'join') {
    const code = String(hhReq.code || '').trim().toUpperCase();
    hh = await kvGet(env, 'hh:' + code);
    if (!hh) throw new HttpError(404, '초대 코드를 찾을 수 없습니다');
    if (hh.members.length >= MAX_MEMBERS) throw new HttpError(409, '이 가구는 더 이상 가입할 수 없습니다');
  } else {
    let code = randomCode();
    for (let i = 0; i < 5 && (await kvGet(env, 'hh:' + code)); i++) code = randomCode();
    hh = { code, members: [], settings: { ...DEFAULT_SETTINGS } };
  }

  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPassword(password, salt);
  await kvPut(env, 'user:' + id, { id, name, salt, hash, iter: PBKDF2_ITER, hid: hh.code, createdAt: Date.now() });
  hh.members.push(id);
  await kvPut(env, 'hh:' + hh.code, hh);
  await kvPut(env, `pref:${hh.code}:${id}`, emptyPrefs());
  const token = await newSession(env, id);
  const user = await kvGet(env, 'user:' + id);
  return json({ token, ...(await buildState(env, user)) }, 201);
}

async function login(request, env) {
  const body = await readBody(request);
  const id = String(body.id || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!ID_RE.test(id)) throw new HttpError(401, '아이디 또는 비밀번호가 맞지 않습니다');
  const failKey = 'fail:' + id;
  const fails = (await kvGet(env, failKey)) || { n: 0 };
  if (fails.n >= 8) throw new HttpError(429, '로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도해주세요');
  const user = await kvGet(env, 'user:' + id);
  // 계정이 없어도 같은 비용의 해시 계산을 해서 존재 여부가 응답 시간으로 드러나지 않게 한다
  const hash = await hashPassword(password, user ? user.salt : b64(new Uint8Array(16)), user ? user.iter : PBKDF2_ITER);
  if (!user || !safeEqual(hash, user.hash)) {
    await kvPut(env, failKey, { n: fails.n + 1 }, { expirationTtl: 900 });
    throw new HttpError(401, '아이디 또는 비밀번호가 맞지 않습니다');
  }
  if (fails.n) await env.DP.delete(failKey);
  const token = await newSession(env, id);
  return json({ token, ...(await buildState(env, user)) });
}

// ------------------------------------------------------------------ 상태 조회
const emptyPrefs = () => ({ scores: {}, feedback: {}, wc: { runs: 0, lastAt: null } });
const LOG_PREFIX = (hid) => `log:${hid}:`;

async function buildState(env, user) {
  const hh = await kvGet(env, 'hh:' + user.hid);
  if (!hh) throw new HttpError(404, '가구 정보를 찾을 수 없습니다');
  const members = await Promise.all(hh.members.map(async (uid) => {
    const [u, prefs] = await Promise.all([kvGet(env, 'user:' + uid), kvGet(env, `pref:${hh.code}:${uid}`)]);
    return { uid, name: u ? u.name : uid, prefs: prefs || emptyPrefs() };
  }));
  const listed = await env.DP.list({ prefix: LOG_PREFIX(hh.code), limit: MAX_LOGS });
  const history = listed.keys.map((k) => ({ id: k.name.slice(LOG_PREFIX(hh.code).length), ...(k.metadata || {}) }));
  return {
    me: { uid: user.id, name: user.name },
    household: { code: hh.code, settings: { ...DEFAULT_SETTINGS, ...hh.settings } },
    members,
    history,
  };
}

// ------------------------------------------------------------------ 취향
const MENU_ID_RE = /^[a-z0-9-]{1,40}$/;
const LOG_ID_RE = /^\d{13}-[a-z0-9]{6}$/;

async function savePrefs(request, env, user) {
  const body = await readBody(request);
  const incoming = body.scores && typeof body.scores === 'object' ? body.scores : {};
  const clean = {};
  const entries = Object.entries(incoming);
  if (entries.length > 400) throw new HttpError(400, '점수 항목이 너무 많습니다');
  for (const [id, v] of entries) {
    if (!MENU_ID_RE.test(id) || typeof v !== 'number' || !(v >= -1 && v <= 1)) throw new HttpError(400, '잘못된 점수 형식입니다');
    clean[id] = Math.round(v * 100) / 100;
  }
  const key = `pref:${user.hid}:${user.id}`;
  const prefs = (await kvGet(env, key)) || emptyPrefs();
  prefs.scores = body.mode === 'replace' ? clean : { ...prefs.scores, ...clean };
  if (body.completedWorldcup) prefs.wc = { runs: (prefs.wc?.runs || 0) + 1, lastAt: Date.now() };
  await kvPut(env, key, prefs);
  return json({ prefs });
}

async function resetPrefs(env, user) {
  const prefs = emptyPrefs();
  await kvPut(env, `pref:${user.hid}:${user.id}`, prefs);
  return json({ prefs });
}

async function saveFeedback(request, env, user) {
  const body = await readBody(request);
  if (!LOG_ID_RE.test(String(body.logId)) || !MENU_ID_RE.test(String(body.menuId)) || ![-1, 0, 1].includes(body.v)) {
    throw new HttpError(400, '잘못된 평가 형식입니다');
  }
  if (!(await env.DP.get(LOG_PREFIX(user.hid) + body.logId))) throw new HttpError(404, '해당 기록이 없습니다');
  const key = `pref:${user.hid}:${user.id}`;
  const prefs = (await kvGet(env, key)) || emptyPrefs();
  prefs.feedback = prefs.feedback || {};
  prefs.feedback[body.logId] = { menuId: body.menuId, v: body.v, at: Date.now() };
  const ids = Object.keys(prefs.feedback).sort(); // 로그 id는 시간 역순이라 앞쪽이 최신
  for (const old of ids.slice(200)) delete prefs.feedback[old];
  await kvPut(env, key, prefs);
  return json({ prefs });
}

// ------------------------------------------------------------------ 먹은 기록
async function addHistory(request, env, user) {
  const body = await readBody(request);
  const menuId = String(body.menuId || '');
  if (!MENU_ID_RE.test(menuId)) throw new HttpError(400, '잘못된 메뉴입니다');
  const at = Number.isFinite(body.at) && body.at > 0 && body.at <= Date.now() + 3600000 ? Math.floor(body.at) : Date.now();
  const meta = {
    menuId,
    name: String(body.name || '').slice(0, 30),
    cat: String(body.cat || '').slice(0, 10),
    rest: String(body.rest || '').slice(0, 40),
    at,
    by: user.id,
  };
  const id = String(9999999999999 - at).padStart(13, '0') + '-' + randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 6).padEnd(6, '0');
  await env.DP.put(LOG_PREFIX(user.hid) + id, '1', { metadata: meta });
  return json({ entry: { id, ...meta } }, 201);
}

async function deleteHistory(url, env, user) {
  const id = url.searchParams.get('id') || '';
  if (!LOG_ID_RE.test(id)) throw new HttpError(400, '잘못된 기록 id입니다');
  await env.DP.delete(LOG_PREFIX(user.hid) + id);
  // 지운 기록에 달린 평가도 취향 점수에서 빠지도록 가구 구성원들의 평가를 같이 지운다
  const hh = await kvGet(env, 'hh:' + user.hid);
  await Promise.all((hh ? hh.members : []).map(async (uid) => {
    const key = `pref:${user.hid}:${uid}`;
    const prefs = await kvGet(env, key);
    if (prefs && prefs.feedback && prefs.feedback[id]) { delete prefs.feedback[id]; await kvPut(env, key, prefs); }
  }));
  return json({ ok: true });
}

// ------------------------------------------------------------------ 가구 설정
async function saveHousehold(request, env, user) {
  const b = await readBody(request);
  const hh = await kvGet(env, 'hh:' + user.hid);
  const s = { ...DEFAULT_SETTINGS, ...hh.settings };
  const num = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi ? v : undefined);
  if (typeof b.address === 'string') s.address = b.address.trim().slice(0, 100);
  if (b.lat === null && b.lng === null) { s.lat = null; s.lng = null; }
  if (num(b.lat, 33, 39) !== undefined && num(b.lng, 124, 132) !== undefined) { s.lat = b.lat; s.lng = b.lng; }
  if (num(b.radiusM, 500, 5000) !== undefined) s.radiusM = Math.round(b.radiusM);
  if (num(b.priceMul, 0.8, 1.6) !== undefined) s.priceMul = Math.round(b.priceMul * 100) / 100;
  if (num(b.recentDays, 0, 30) !== undefined) s.recentDays = Math.round(b.recentDays);
  if (num(b.defaultHeadcount, 1, 6) !== undefined) s.defaultHeadcount = Math.round(b.defaultHeadcount);
  hh.settings = s;
  await kvPut(env, 'hh:' + user.hid, hh);
  return json({ settings: s });
}

// ------------------------------------------------------------------ 카카오 평점 프록시 (비공식 API — 구조가 바뀌면 조용히 null)
// ※ panel3 응답에서 평점이 정확히 어떤 필드에 있는지는 확인하지 못했다(추측 기반). 그래서 "평점처럼 보이는 키"를
//   재귀로 찾고, 어디서 찾았는지(path)를 같이 돌려준다. 못 찾으면 score=null → 화면에선 평점을 숨긴다.
//   실제 응답 구조를 보려면 /api/place?placeId=...&debug=1
const SCORE_KEYS = /^(average_score|score_avg|avg_score|average_rating)$/i; // 일부러 좁게: 엉뚱한 'score'를 평점으로 오인하지 않도록
const COUNT_KEYS = /^(review_count|score_count|scorecnt|rating_count|reviewcount)$/i;

export function findRating(obj, path = '', depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  let score = null, count = null;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') {
      if (score == null && SCORE_KEYS.test(k) && v > 0 && v <= 5) score = { v, k };
      else if (count == null && COUNT_KEYS.test(k) && v >= 0) count = { v, k };
    }
  }
  if (score) return { score: Math.round(score.v * 10) / 10, count: count ? count.v : null, path: path + '/' + score.k };
  // 옛 place API 스타일: 합계(scoresum) ÷ 참여수(scorecnt)
  if (typeof obj.scoresum === 'number' && typeof obj.scorecnt === 'number' && obj.scorecnt > 0) {
    const avg = obj.scoresum / obj.scorecnt;
    if (avg > 0 && avg <= 5) return { score: Math.round(avg * 10) / 10, count: obj.scorecnt, path: path + '/scoresum÷scorecnt' };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      const r = findRating(v, path + '/' + k, depth + 1);
      if (r) return r;
    }
  }
  return null;
}
function outline(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return typeof obj;
  if (Array.isArray(obj)) return obj.length ? [outline(obj[0], depth + 1), `…(${obj.length})`] : [];
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, outline(v, depth + 1)]));
}

async function placeInfo(url) {
  const placeId = url.searchParams.get('placeId') || '';
  if (!/^\d{1,12}$/.test(placeId)) throw new HttpError(400, 'placeId(숫자)가 필요합니다');
  let resp;
  try {
    resp = await fetch(KAKAO_API + placeId, {
      headers: {
        accept: 'application/json, text/plain, */*', 'accept-language': 'ko-KR,ko;q=0.9',
        appversion: '6.6.0', origin: 'https://place.map.kakao.com', referer: 'https://place.map.kakao.com/', pf: 'PC',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch (e) {
    return json({ placeId, score: null, count: null, error: 'kakao 요청 실패' });
  }
  if (!resp.ok) return json({ placeId, score: null, count: null, error: 'kakao status ' + resp.status });
  let data;
  try { data = await resp.json(); } catch { return json({ placeId, score: null, count: null, error: '파싱 실패' }); }
  if (url.searchParams.get('debug')) return json({ placeId, outline: outline(data), found: findRating(data) });
  const r = findRating(data);
  return json({ placeId, score: r ? r.score : null, count: r ? r.count : null, path: r ? r.path : null });
}
