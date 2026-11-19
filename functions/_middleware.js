
const cookieName = '__Host-playbath';
const lifetime = 7 * 86400;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async text => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const json = (data, status = 200, headers = {}) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', ...headers }
});
function cookie(value, maxAge) {
  return { 'Set-Cookie': cookieName + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + maxAge };
}
async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2', salt:encoder.encode(salt), iterations:100000, hash:'SHA-256'}, key, 256));
}
function same(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function cleanState(input) {
  if (!Array.isArray(input?.people) || input.people.length > 1000) return;
  const people = [], entries = Object.create(null), ids = new Set();
  for (const person of input.people) {
    const { id, name } = person || {};
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,119}$/.test(id) || ids.has(id) ||
        typeof name !== 'string' || !name.trim() || name.length > 40) return;
    ids.add(id);
    people.push({ id, name: name.trim() });
    const time = input.entries?.[id];
    if (typeof time === 'string' && time.length <= 40 && Number.isFinite(Date.parse(time))) entries[id] = time;
  }
  const source = input.settings || {};
  const settings = {};
  for (const field of ['bathName', 'welcomeText']) {
    if (typeof source[field] === 'string') settings[field] = source[field].slice(0, 200);
  }
  for (const field of ['voiceOn', 'soundOn']) {
    if (typeof source[field] === 'boolean') settings[field] = source[field];
  }
  for (const [field, minimum, maximum] of [['welcomeSeconds',0,120],['voiceRate',0.1,2],['voiceVolume',0,1]]) {
    if (typeof source[field] === 'number' && Number.isFinite(source[field])) {
      settings[field] = Math.min(maximum, Math.max(minimum, source[field]));
    }
  }
  return { people, entries, settings };
}
async function body(request, cap) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > cap) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { return null; }
}
async function authenticate(request, db, register, now) {
  const form = await body(request, 4096);
  const username = typeof form?.username === 'string' ? form.username.trim().toLowerCase() : '';
  const password = form?.password;
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username) || typeof password !== 'string' ||
      password.length < 12 || password.length > 128) return json({error:'아이디와 비밀번호 형식을 확인해 주세요.'}, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limitKey = await digest(ip);
  const counter = await db.prepare(
    'INSERT INTO bath_limits VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET ' +
    'attempts=CASE WHEN expires<=? THEN 1 ELSE attempts+1 END, expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING attempts'
  ).bind(limitKey, now + 900, now, now).first();
  if (counter.attempts > 15) return json({error:'잠시 후 다시 시도해 주세요.'}, 429);
  const token = random();
  const sessionHash = await digest(token);
  if (register) {
    const salt = random();
    const passwordHash = await derive(password, salt);
    // Preserve the existing invite column and foreign key with an expired,
    // server-generated record. Users never receive or enter this value.
    const registrationId = random();
    const [, inserted] = await db.batch([
      db.prepare('INSERT INTO bath_invites(hash,expires) SELECT ?,0 WHERE NOT EXISTS (SELECT 1 FROM bath_accounts WHERE username=?)')
        .bind(registrationId, username),
      db.prepare('INSERT INTO bath_accounts(username,salt,password,invite) SELECT ?,?,?,hash FROM bath_invites WHERE hash=?')
        .bind(username, salt, passwordHash, registrationId),
      db.prepare('INSERT INTO bath_sessions SELECT ?,username,? FROM bath_accounts WHERE username=? AND invite=?')
        .bind(sessionHash, now + lifetime, username, registrationId),
      db.prepare('DELETE FROM bath_sessions WHERE expires<=?').bind(now),
      db.prepare('DELETE FROM bath_limits WHERE expires<=?').bind(now),
    ]);
    if (!inserted.meta.changes) return json({error:'이미 사용 중인 아이디입니다.'}, 409);
    return json({username}, 200, cookie(token, lifetime));
  } else {
    const account = await db.prepare('SELECT salt,password FROM bath_accounts WHERE username=?').bind(username).first();
    const actual = await derive(password, account?.salt ?? '0'.repeat(64));
    if (!account || !same(actual, account.password)) return json({error:'아이디 또는 비밀번호를 확인해 주세요.'}, 401);
  }
  await db.batch([
    db.prepare('DELETE FROM bath_sessions WHERE expires<=?').bind(now),
    db.prepare('DELETE FROM bath_limits WHERE expires<=?').bind(now),
    db.prepare('INSERT INTO bath_sessions VALUES (?,?,?)').bind(sessionHash, username, now + lifetime),
  ]);
  return json({username}, 200, cookie(token, lifetime));
}
async function api(context, action, url) {
  const { request, env } = context;
  if (!env.DB) return json({error:'공유 저장소 연결을 사용할 수 없습니다.'}, 503);
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  if (request.method !== 'GET' &&
      (request.headers.get('Origin') !== url.origin || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json')) {
    return json({error:'요청을 확인해 주세요.'}, 403);
  }
  if ((action === 'login' || action === 'register') && request.method === 'POST') {
    return authenticate(request, db, action === 'register', now);
  }
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-playbath=([a-f0-9]{64})(?:;|$)/)?.[1];
  const hash = token && await digest(token);
  const session = hash && await db.prepare('SELECT username FROM bath_sessions WHERE hash=? AND expires>?').bind(hash, now).first();
  if (action === 'logout' && request.method === 'POST') {
    if (hash) await db.prepare('DELETE FROM bath_sessions WHERE hash=?').bind(hash).run();
    return json({}, 200, cookie('', 0));
  }
  if (!session) return json({error:'교사 계정으로 로그인해 주세요.'}, 401);
  if (action === 'state' && request.method === 'GET') {
    const row = await db.prepare('SELECT data,version FROM bath_accounts WHERE username=?').bind(session.username).first();
    if (!row) return json({error:'교사 계정을 확인해 주세요.'}, 401);
    return json({username:session.username, version:row.version, state:row.data ? JSON.parse(row.data) : null});
  }
  if (action === 'state' && request.method === 'PUT') {
    const input = await body(request, 350000);
    const next = cleanState(input?.state);
    if (!next || !Number.isSafeInteger(input.version) || input.version < 0) return json({error:'저장할 명단과 기록을 확인해 주세요.'}, 400);
    const result = await db.prepare('UPDATE bath_accounts SET data=?, version=version+1 WHERE username=? AND version=?')
      .bind(JSON.stringify(next), session.username, input.version).run();
    if (!result.meta.changes) return json({error:'다른 기기에서 내용이 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.'}, 409);
    return json({version:input.version+1, state:next});
  }
  return json({error:'요청 경로를 확인해 주세요.'}, 404);
}
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith('/api/bath/')) {
    try { return await api(context, url.pathname.slice('/api/bath/'.length), url); }
    catch { return json({error:'공유 저장소 처리 중 문제가 발생했습니다. 다시 시도해 주세요.'}, 503); }
  }
  const response = await context.next();
  if (context.request.method !== 'GET' || !['/', '/index.html', '/index'].includes(url.pathname) ||
      !response.headers.get('Content-Type')?.includes('text/html')) return response;
  return new HTMLRewriter().on('body', {
    element(body) { body.append('<script src="/bath-sync.js"></script>', {html:true}); }
  }).transform(response);
}
