import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const VERSION = 'moji-fighter-x-rooms-v1';
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function createRoomServer({ now = Date.now, grace = 20000, maxRooms = 1000 } = {}) {
  const rooms = new Map(), limits = new Map();
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  function build(b) {
    if (!b || typeof b.character !== 'string' || b.character.length > 12 ||
        [...segmenter.segment(b.character.trim())].length !== 1) fail(400, '文字を一つ選んでください。');
    for (const [key, max] of Object.entries({ fontType: 3, weaponSize: 3, gripType: 3, battleStyle: 3, weaponFlip: 3 }))
      if (!Number.isInteger(b[key]) || b[key] < 0 || b[key] > max) fail(400, '装備の設定を確認してください。');
    for (const value of [b.gripPosition, b.gripPoint?.x, b.gripPoint?.y])
      if (!Number.isFinite(value) || value < 0 || value > 1) fail(400, '持ち手の位置を確認してください。');
    return { character: b.character.trim(), fontType: b.fontType, weaponSize: b.weaponSize, gripType: b.gripType,
      battleStyle: b.battleStyle, weaponFlip: b.weaponFlip, gripPosition: b.gripPosition,
      gripPoint: { x: b.gripPoint.x, y: b.gripPoint.y }, customGrip: Boolean(b.customGrip) };
  }
  function sweep() {
    for (const [code, r] of rooms) {
      if (now() - r.players[0].seen > grace || now() - r.created > 24 * 3600000) { rooms.delete(code); continue; }
      if (r.players[1] && now() - r.players[1].seen > grace) {
        r.players[1] = null; r.players[0].ready = false; r.stage = 'lobby'; r.frame = null; r.revision++;
      }
    }
  }
  function view(r, side, credential = false) {
    return { code: r.code, side, token: credential ? r.players[side].token : '', revision: r.revision,
      stage: r.stage, matchId: r.matchId, seed: r.seed, frame: r.frame,
      players: r.players.map(p => ({ joined: !!p, ready: !!p?.ready, build: p?.build ?? null })) };
  }
  const server = http.createServer(async (req, res) => {
    const allowed = process.env.ALLOWED_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      // Behind a hosting proxy (Render) every request shares the proxy address; rate-limit by the client address instead.
      const forwarded = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const ip = forwarded || req.socket.remoteAddress, t = now();
      const limit = limits.get(ip) ?? { count: 0, reset: t + 10000 };
      if (t > limit.reset) { limit.count = 0; limit.reset = t + 10000; }
      if (++limit.count > 600) fail(429, '少し待ってから、もう一度お試しください。');
      limits.set(ip, limit);
      if (limits.size > 4096) for (const [k, v] of limits) if (t > v.reset) limits.delete(k);
      sweep();
      const path = new URL(req.url, 'http://local').pathname;
      if (path === '/health' && req.method === 'GET') { res.end(JSON.stringify({ ok: true, version: VERSION })); return; }
      let body = {};
      if (req.method === 'POST') {
        let size = 0, chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 131072) fail(413, '送信データが大きすぎます。'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { fail(400, '送信内容を読み取れません。'); }
      }
      const player = b => ({ token: randomBytes(32).toString('hex'), build: build(b), ready: false, seen: now() });
      let result;
      if (path === '/rooms' && req.method === 'POST') {
        if (body.version !== VERSION) fail(409, 'ゲームのバージョンをそろえてください。');
        if (rooms.size >= maxRooms) fail(503, '現在、部屋がいっぱいです。');
        let code;
        do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
        const r = { code, players: [player(body.build), null], revision: 1, stage: 'lobby', seed: 0, matchId: 0,
          frame: null, created: now() }; rooms.set(code, r); result = view(r, 0, true);
      } else {
        const match = /^\/rooms\/([A-Z2-9]{6})(?:\/(join|build|ready|start|frame|lobby|leave))?$/.exec(path);
        if (!match) fail(404, '部屋が見つかりません。');
        const r = rooms.get(match[1]); if (!r) fail(404, '部屋が見つかりません。コードを確認してください。');
        const action = match[2];
        if (action === 'join' && req.method === 'POST') {
          if (body.version !== VERSION) fail(409, 'ゲームのバージョンをそろえてください。');
          if (r.players[1] || r.stage !== 'lobby') fail(409, 'この部屋は満員です。');
          r.players[1] = player(body.build); r.revision++; result = view(r, 1, true);
        } else {
          const token = (req.headers.authorization || '').replace(/^Bearer /, '');
          const side = r.players.findIndex(p => p && p.token === token);
          if (side < 0) fail(401, '部屋への接続が切れました。入り直してください。');
          const p = r.players[side]; p.seen = now();
          if (!action && req.method === 'GET') result = view(r, side);
          else if (req.method !== 'POST') fail(405, 'この操作は利用できません。');
          else if (action === 'build') {
            if (r.stage !== 'lobby') fail(409, '対戦中は装備を変更できません。');
            p.build = build(body.build); p.ready = false; r.revision++; result = view(r, side);
          } else if (action === 'ready') {
            if (r.stage !== 'lobby') fail(409, '対戦中です。');
            p.ready = Boolean(body.ready); r.revision++; result = view(r, side);
          } else if (action === 'start') {
            if (side !== 0) fail(403, 'ホストが対戦を開始します。');
            if (r.stage !== 'lobby' || !r.players.every(p => p?.ready)) fail(409, '2人の準備完了を待ってください。');
            r.stage = 'battle'; r.seed = randomInt(1, 2147483647); r.matchId++; r.frame = null; r.revision++; result = view(r, side);
          } else if (action === 'frame') {
            if (side !== 0) fail(403, 'ホストだけが試合を同期できます。');
            const f = body.frame;
            if (r.stage !== 'battle' || body.matchId !== r.matchId) fail(409, '試合が切り替わりました。');
            if (!f || !Number.isInteger(f.sequence) || f.sequence < 1 || !Number.isFinite(f.clock) ||
                !Array.isArray(f.actors) || f.actors.length !== 2 || !Array.isArray(f.events) || f.events.length > 128)
              fail(400, '試合データを読み取れません。');
            if (f.ended && (!f.result || ![-1, 0, 1].includes(f.result.winner) || !Array.isArray(f.result.hpRemaining) ||
                !Array.isArray(f.result.metrics) || f.result.metrics.length !== 2 || typeof f.result.finishReason !== 'string'))
              fail(400, '試合結果を読み取れません。');
            if (!r.frame || f.sequence > r.frame.sequence) r.frame = f;
            result = { ok: true };
          } else if (action === 'lobby') {
            r.stage = 'lobby'; r.frame = null; for (const item of r.players) if (item) item.ready = false;
            r.revision++; result = view(r, side);
          } else if (action === 'leave') {
            if (side === 0) rooms.delete(r.code);
            else { r.players[1] = null; r.players[0].ready = false; r.stage = 'lobby'; r.frame = null; r.revision++; }
            result = { ok: true };
          } else fail(404, 'この操作は利用できません。');
        }
      }
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(e.status || 500); res.end(JSON.stringify({ error: e.status ? e.message : 'サーバーでエラーが発生しました。' }));
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  createRoomServer().listen(port, process.env.HOST || '0.0.0.0', () => console.log(`MOJI Fighter X rooms listening on ${port}`));
}
