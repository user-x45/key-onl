const WORDS_BASE_URL = "https://s-typing.f5.si/words";
const wordListCache = {};

async function fetchWordList(mode, level){
  const cacheKey = `${mode}-${level}`;
  if(wordListCache[cacheKey]) return wordListCache[cacheKey];
  try{
    const res = await fetch(`${WORDS_BASE_URL}/${cacheKey}.json`);
    if(!res.ok) throw new Error("fetch failed");
    const list = await res.json();
    wordListCache[cacheKey] = list;
    return list;
  }catch(e){
    if(cacheKey !== "hiragana-beginner"){
      return fetchWordList("hiragana", "beginner");
    }
    return ["あいさつ"];
  }
}

async function pickDeck(mode, level){
  const pool = await fetchWordList(mode, level);
  const deck = [];
  for(let i = 0; i < 60; i++){
    deck.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return deck;
}

export class Lobby {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.waiting = null;
  }

  async fetch(request){
    if(request.headers.get("Upgrade") !== "websocket"){
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "hiragana";
    const level = url.searchParams.get("level") || "beginner";
    const name = String(url.searchParams.get("name") || "GUEST").trim().slice(0, 6) || "GUEST";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server, mode, level, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSocket(ws, mode, level, name){
    if(this.waiting){
      const partner = this.waiting;
      this.waiting = null;
      clearTimeout(partner.timeoutId);
      const matchId = crypto.randomUUID();
      try{
        partner.ws.send(JSON.stringify({ type: "matched", matchId, role: "p1", opponentName: name }));
        partner.ws.close(1000, "matched");
      }catch(e){}
      ws.send(JSON.stringify({ type: "matched", matchId, role: "p2", opponentName: partner.name }));
      ws.close(1000, "matched");
      return;
    }

    const entry = { ws, mode, level, name, timeoutId: null };
    entry.timeoutId = setTimeout(() => {
      if(this.waiting === entry){
        this.waiting = null;
        try{
          ws.send(JSON.stringify({ type: "timeout" }));
          ws.close(1000, "timeout");
        }catch(e){}
      }
    }, 15000);
    this.waiting = entry;

    ws.addEventListener("close", () => {
      if(this.waiting === entry){
        clearTimeout(entry.timeoutId);
        this.waiting = null;
      }
    });
  }
}

const FRIEND_ROOM_TTL_MS = 600000;

export class FriendRoom {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.host = null;
    this.guest = null;
    this.expiresAt = null;
    this.closed = false;
    this.code = null;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("room");
      if(stored){
        this.expiresAt = stored.expiresAt;
        this.closed = stored.closed;
        this.code = stored.code || null;
      }
    });
  }

  async persist(){
    await this.state.storage.put("room", { expiresAt: this.expiresAt, closed: this.closed, code: this.code });
  }

  async registerCode(mode, level){
    if(!this.code || !this.env.FRIEND_REGISTRY) return;
    const regId = this.env.FRIEND_REGISTRY.idFromName("global");
    const regStub = this.env.FRIEND_REGISTRY.get(regId);
    try{
      await regStub.fetch(new Request("https://internal/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register", code: this.code, expiresAt: this.expiresAt, mode, level })
      }));
    }catch(e){}
  }

  async unregisterCode(){
    if(!this.code || !this.env.FRIEND_REGISTRY) return;
    const regId = this.env.FRIEND_REGISTRY.idFromName("global");
    const regStub = this.env.FRIEND_REGISTRY.get(regId);
    try{
      await regStub.fetch(new Request("https://internal/registry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unregister", code: this.code })
      }));
    }catch(e){}
  }

  async forceClose(){
    this.closed = true;
    await this.persist();
    if(this.host){
      try{ this.host.ws.close(1000, "closed"); }catch(e){}
      this.host = null;
    }
    if(this.guest){
      try{ this.guest.ws.close(1000, "closed"); }catch(e){}
      this.guest = null;
    }
    await this.unregisterCode();
  }

  async fetch(request){
    const url = new URL(request.url);

    if(request.method === "POST"){
      let body = {};
      try{
        body = await request.json();
      }catch(e){
        body = {};
      }
      if(body.action === "close"){
        await this.forceClose();
        return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
      }
      return new Response("bad request", { status: 400 });
    }

    if(request.headers.get("Upgrade") !== "websocket"){
      return new Response("expected websocket", { status: 426 });
    }
    const role = url.searchParams.get("role");
    if(role !== "host" && role !== "guest"){
      return new Response("bad request", { status: 400 });
    }

    const code = url.pathname.split("/")[2];
    const mode = url.searchParams.get("mode") || "hiragana";
    const level = url.searchParams.get("level") || "beginner";

    if(this.expiresAt === null){
      if(role === "guest"){
        return new Response("room not found", { status: 404 });
      }
      this.code = code;
      this.expiresAt = Date.now() + FRIEND_ROOM_TTL_MS;
      await this.persist();
      await this.state.storage.setAlarm(this.expiresAt);
      await this.registerCode(mode, level);
    }
    if(this.closed || Date.now() >= this.expiresAt){
      return new Response("expired", { status: 410 });
    }

    const name = String(url.searchParams.get("name") || "GUEST").trim().slice(0, 6) || "GUEST";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server, role, mode, level, name);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSocket(ws, role, mode, level, name){
    if(this[role]){
      try{
        this[role].ws.close(1000, "replaced");
      }catch(e){}
    }

    const entry = { ws, mode, level, name };
    this[role] = entry;

    ws.addEventListener("close", () => {
      if(this[role] === entry){
        this[role] = null;
      }
    });

    this.tryMatch();
  }

  async tryMatch(){
    if(!this.host || !this.guest) return;
    const host = this.host;
    const guest = this.guest;
    this.host = null;
    this.guest = null;
    this.closed = true;
    await this.persist();
    await this.unregisterCode();
    const matchId = crypto.randomUUID();
    try{
      host.ws.send(JSON.stringify({ type: "matched", matchId, role: "p1", opponentName: guest.name, mode: host.mode, level: host.level }));
      host.ws.close(1000, "matched");
    }catch(e){}
    try{
      guest.ws.send(JSON.stringify({ type: "matched", matchId, role: "p2", opponentName: host.name, mode: host.mode, level: host.level }));
      guest.ws.close(1000, "matched");
    }catch(e){}
  }

  async alarm(){
    this.closed = true;
    if(this.host){
      try{
        this.host.ws.send(JSON.stringify({ type: "timeout" }));
        this.host.ws.close(1000, "timeout");
      }catch(e){}
      this.host = null;
    }
    if(this.guest){
      try{
        this.guest.ws.send(JSON.stringify({ type: "timeout" }));
        this.guest.ws.close(1000, "timeout");
      }catch(e){}
      this.guest = null;
    }
    await this.unregisterCode();
    await this.state.storage.deleteAll();
  }
}

export class FriendRegistry {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.codes = null;
  }

  async load(){
    if(this.codes) return;
    this.codes = (await this.state.storage.get("codes")) || {};
  }

  pruneExpired(){
    const now = Date.now();
    for(const code of Object.keys(this.codes)){
      if(this.codes[code].expiresAt < now){
        delete this.codes[code];
      }
    }
  }

  async fetch(request){
    await this.load();
    this.pruneExpired();

    let body = {};
    try{
      body = await request.json();
    }catch(e){
      body = {};
    }

    if(body.action === "register"){
      const existing = this.codes[body.code];
      this.codes[body.code] = {
        createdAt: existing ? existing.createdAt : Date.now(),
        expiresAt: body.expiresAt,
        mode: body.mode,
        level: body.level
      };
      await this.state.storage.put("codes", this.codes);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "unregister"){
      delete this.codes[body.code];
      await this.state.storage.put("codes", this.codes);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "list"){
      await this.state.storage.put("codes", this.codes);
      const list = Object.keys(this.codes).map(code => ({ code, ...this.codes[code] }));
      list.sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify({ codes: list }), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

export class Match {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.players = {};
    this.mode = "hiragana";
    this.level = "beginner";
    this.wordDeck = null;
    this.scores = {
      p1: { score: 0, miss: 0, finished: false },
      p2: { score: 0, miss: 0, finished: false }
    };
    this.ended = false;
    this.waitTimeoutId = null;
  }

  async fetch(request){
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if(request.headers.get("Upgrade") !== "websocket" || (role !== "p1" && role !== "p2")){
      return new Response("bad request", { status: 400 });
    }
    const mode = url.searchParams.get("mode");
    const level = url.searchParams.get("level");
    if(mode) this.mode = mode;
    if(level) this.level = level;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.players[role] = server;
    this.attach(server, role);

    if(this.players.p1 && this.players.p2){
      if(this.waitTimeoutId){
        clearTimeout(this.waitTimeoutId);
        this.waitTimeoutId = null;
      }
      if(!this.wordDeck){
        this.startMatch();
      }
    } else if(!this.waitTimeoutId){
      this.waitTimeoutId = setTimeout(() => {
        this.waitTimeoutId = null;
        if(this.ended) return;
        if(this.players.p1 && this.players.p2) return;
        this.ended = true;
        const waitingRole = this.players.p1 ? "p1" : "p2";
        const waitingWs = this.players[waitingRole];
        if(waitingWs){
          try{
            waitingWs.send(JSON.stringify({ type: "opponentLeft" }));
            waitingWs.close(1000, "opponent-missing");
          }catch(e){}
        }
      }, 10000);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  attach(ws, role){
    ws.addEventListener("message", (event) => {
      let msg;
      try{ msg = JSON.parse(event.data); }catch(e){ return; }

      if(msg.type === "progress"){
        this.scores[role].score = msg.score;
        const other = role === "p1" ? "p2" : "p1";
        if(this.players[other]){
          try{
            this.players[other].send(JSON.stringify({ type: "opponentProgress", score: msg.score }));
          }catch(e){}
        }
      } else if(msg.type === "finished"){
        this.scores[role].score = msg.score;
        this.scores[role].miss = msg.miss;
        this.scores[role].finished = true;
        this.maybeEnd(false);
      }
    });

    ws.addEventListener("close", () => {
      if(this.ended) return;
      const other = role === "p1" ? "p2" : "p1";
      if(this.players[other]){
        this.ended = true;
        try{
          this.players[other].send(JSON.stringify({ type: "opponentLeft" }));
        }catch(e){}
      }
    });
  }

  async startMatch(){
    this.wordDeck = await pickDeck(this.mode, this.level);
    for(const role of ["p1", "p2"]){
      try{
        this.players[role].send(JSON.stringify({
          type: "start",
          wordDeck: this.wordDeck,
          duration: 100
        }));
      }catch(e){}
    }
    this.state.storage.setAlarm(Date.now() + 106000);
  }

  async alarm(){
    this.maybeEnd(true);
  }

  maybeEnd(force){
    if(this.ended) return;
    const bothFinished = this.scores.p1.finished && this.scores.p2.finished;
    if(!force && !bothFinished) return;
    this.ended = true;

    const p1 = this.scores.p1;
    const p2 = this.scores.p2;
    const resultFor = (me, opp) => (me.score > opp.score ? "win" : me.score < opp.score ? "lose" : "draw");

    if(this.players.p1){
      try{
        this.players.p1.send(JSON.stringify({
          type: "end",
          you: { score: p1.score, miss: p1.miss },
          opponent: { score: p2.score, miss: p2.miss },
          result: resultFor(p1, p2)
        }));
      }catch(e){}
    }
    if(this.players.p2){
      try{
        this.players.p2.send(JSON.stringify({
          type: "end",
          you: { score: p2.score, miss: p2.miss },
          opponent: { score: p1.score, miss: p1.miss },
          result: resultFor(p2, p1)
        }));
      }catch(e){}
    }
  }
}

const RANKING_MAX = 20;
const RANKING_MODES = ["hiragana", "katakana", "sentence"];
const RANKING_LEVELS = ["beginner", "intermediate", "advanced"];

function sanitizeRankingName(raw){
  const trimmed = String(raw || "").trim().slice(0, 6);
  return trimmed.length === 0 ? "GUEST" : trimmed;
}

function getCurrentMonthJST(){
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
}

const SESSION_MIN_MS = 95000;
const SESSION_MAX_MS = 180000;
const SESSION_MAX_SCORE = 9000;
const SESSION_TOKEN_TTL_MS = 300000;

function bufToHex(buf){
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, message){
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bufToHex(sig);
}

async function issueSessionToken(env, mode, level){
  const secret = env.ADMIN_PASSWORD || "s-typing-fallback-secret";
  const payload = { ts: Date.now(), mode, level, nonce: crypto.randomUUID() };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(unescape(encodeURIComponent(payloadStr)));
  const sig = await hmacHex(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

async function verifySessionToken(env, token, mode, level){
  if(typeof token !== "string" || token.indexOf(".") === -1) return null;
  const [payloadB64, sig] = token.split(".");
  const secret = env.ADMIN_PASSWORD || "s-typing-fallback-secret";
  const expectedSig = await hmacHex(secret, payloadB64);
  if(expectedSig !== sig) return null;
  let payload;
  try{
    payload = JSON.parse(decodeURIComponent(escape(atob(payloadB64))));
  }catch(e){
    return null;
  }
  if(payload.mode !== mode || payload.level !== level) return null;
  const elapsed = Date.now() - payload.ts;
  if(elapsed < SESSION_MIN_MS || elapsed > SESSION_MAX_MS) return null;
  return payload;
}

export class Ranking {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.scores = null;
    this.usedNonces = null;
  }

  async load(){
    if(this.scores) return;
    const stored = await this.state.storage.get("scores");
    const list = Array.isArray(stored) ? stored : [];
    this.scores = list.map(entry => typeof entry === "object" && entry !== null ? entry : { score: entry, name: "GUEST" });
    const storedNonces = await this.state.storage.get("usedNonces");
    this.usedNonces = Array.isArray(storedNonces) ? storedNonces : [];
  }

  async fetch(request){
    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "hiragana";
    const level = url.searchParams.get("level") || "beginner";

    await this.load();

    if(request.method === "GET"){
      return new Response(JSON.stringify(this.scores), { headers: corsHeaders() });
    }

    if(request.method === "POST"){
      let body;
      try{
        body = await request.json();
      }catch(e){
        return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: corsHeaders() });
      }

      if(body.action === "startSession"){
        const token = await issueSessionToken(this.env, mode, level);
        return new Response(JSON.stringify({ token }), { headers: corsHeaders() });
      }

      if(body.action === "clear"){
        this.scores = [];
        await this.state.storage.put("scores", this.scores);
        return new Response(JSON.stringify({ top20: this.scores }), { headers: corsHeaders() });
      }

      if(body.action === "delete"){
        const target = Math.round(Number(body.score));
        const idx = this.scores.findIndex(s => (typeof s === "object" && s !== null ? s.score : s) === target);
        if(idx !== -1){
          this.scores.splice(idx, 1);
          await this.state.storage.put("scores", this.scores);
        }
        return new Response(JSON.stringify({ top20: this.scores }), { headers: corsHeaders() });
      }

      if(body.action === "getMonthRanking"){
        const month = String(body.month || "");
        const key = `monthScores:${month}`;
        const monthScores = (await this.state.storage.get(key)) || [];
        return new Response(JSON.stringify({ top20: monthScores }), { headers: corsHeaders() });
      }

      if(body.action === "clearMonthRanking"){
        const month = String(body.month || "");
        const key = `monthScores:${month}`;
        await this.state.storage.put(key, []);
        return new Response(JSON.stringify({ top20: [] }), { headers: corsHeaders() });
      }

      if(body.action === "deleteMonthRanking"){
        const month = String(body.month || "");
        const key = `monthScores:${month}`;
        const monthScores = (await this.state.storage.get(key)) || [];
        const target = Math.round(Number(body.score));
        const idx = monthScores.findIndex(s => s.score === target);
        if(idx !== -1){
          monthScores.splice(idx, 1);
          await this.state.storage.put(key, monthScores);
        }
        return new Response(JSON.stringify({ top20: monthScores }), { headers: corsHeaders() });
      }

      let eventEnabled = false;
      let eventMonth = "";
      if(this.env.EVENT_SETTINGS){
        const eventId = this.env.EVENT_SETTINGS.idFromName("global");
        const eventStub = this.env.EVENT_SETTINGS.get(eventId);
        const eventRes = await eventStub.fetch(new Request("https://internal/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get" })
        }));
        const eventData = await eventRes.json();
        eventEnabled = Boolean(eventData.enabled);
        eventMonth = String(eventData.month || "");
      }

      const payload = await verifySessionToken(this.env, body.token, mode, level);
      if(!payload){
        return new Response(JSON.stringify({ error: "invalid or expired session" }), { status: 403, headers: corsHeaders() });
      }
      if(this.usedNonces.some(n => n.nonce === payload.nonce)){
        return new Response(JSON.stringify({ error: "session already used" }), { status: 403, headers: corsHeaders() });
      }
      const now = Date.now();
      this.usedNonces = this.usedNonces.filter(n => n.until > now).concat([{ nonce: payload.nonce, until: now + SESSION_TOKEN_TTL_MS }]);
      await this.state.storage.put("usedNonces", this.usedNonces);

      let score = Math.max(0, Math.round(Number(body.score) || 0));
      if(score > SESSION_MAX_SCORE) score = SESSION_MAX_SCORE;
      const name = sanitizeRankingName(body.name);

      const activeEventMonth = eventEnabled && eventMonth === getCurrentMonthJST();

      if(activeEventMonth){
        const key = `monthScores:${eventMonth}`;
        const monthScores = (await this.state.storage.get(key)) || [];
        let monthRank = null;
        const existingMonthIndex = monthScores.findIndex(s => s.score === score && s.name === name);
        if(existingMonthIndex !== -1){
          monthRank = existingMonthIndex < RANKING_MAX ? existingMonthIndex + 1 : null;
        } else {
          let pos = 0;
          while(pos < monthScores.length && monthScores[pos].score > score) pos++;
          if(pos < RANKING_MAX){
            monthScores.splice(pos, 0, { score, name });
            if(monthScores.length > RANKING_MAX){
              monthScores.length = RANKING_MAX;
            }
            monthRank = pos + 1;
            await this.state.storage.put(key, monthScores);
          }
        }
        return new Response(JSON.stringify({ rank: monthRank, top20: monthScores, eventMode: true, month: eventMonth }), { headers: corsHeaders() });
      }

      let rank = null;
      const existingIndex = this.scores.findIndex(s => s.score === score && s.name === name);
      if(existingIndex !== -1){
        rank = existingIndex < RANKING_MAX ? existingIndex + 1 : null;
      } else {
        let pos = 0;
        while(pos < this.scores.length && this.scores[pos].score > score) pos++;
        if(pos < RANKING_MAX){
          this.scores.splice(pos, 0, { score, name });
          if(this.scores.length > RANKING_MAX){
            this.scores = this.scores.slice(0, RANKING_MAX);
          }
          rank = pos + 1;
          await this.state.storage.put("scores", this.scores);
        } else {
          rank = null;
        }
      }

      return new Response(JSON.stringify({ rank, top20: this.scores }), { headers: corsHeaders() });
    }

    return new Response("method not allowed", { status: 405, headers: corsHeaders() });
  }
}

export class EventSettings {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.settings = null;
  }

  async load(){
    if(this.settings) return;
    const stored = await this.state.storage.get("settings");
    this.settings = stored || { enabled: false, month: "" };
  }

  async fetch(request){
    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    await this.load();

    let body = {};
    try{
      body = await request.json();
    }catch(e){
      body = {};
    }

    if(body.action === "get"){
      return new Response(JSON.stringify(this.settings), { headers: corsHeaders() });
    }

    if(body.action === "set"){
      this.settings = { enabled: Boolean(body.enabled), month: String(body.month || "") };
      await this.state.storage.put("settings", this.settings);
      return new Response(JSON.stringify(this.settings), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

const LOGIN_SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const PENDING_TOKEN_TTL_MS = 10 * 60 * 1000;

export class UserAuth {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.users = null;
    this.sessions = null;
    this.pending = null;
  }

  async load(){
    if(this.users && this.sessions && this.pending) return;
    const stored = await this.state.storage.get(["users", "sessions", "pending"]);
    this.users = stored.get("users") || {};
    this.sessions = stored.get("sessions") || {};
    this.pending = stored.get("pending") || {};
  }

  pruneExpired(){
    const now = Date.now();
    for(const token of Object.keys(this.sessions)){
      if(this.sessions[token].expires < now) delete this.sessions[token];
    }
    for(const token of Object.keys(this.pending)){
      if(this.pending[token].expires < now) delete this.pending[token];
    }
  }

  async fetch(request){
    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    await this.load();
    this.pruneExpired();

    let body = {};
    try{
      body = await request.json();
    }catch(e){
      body = {};
    }

    if(body.action === "resolveLogin"){
      const { sub } = body;
      const existing = this.users[sub];
      if(existing){
        const token = crypto.randomUUID();
        this.sessions[token] = { sub, expires: Date.now() + LOGIN_SESSION_TTL_MS };
        await this.state.storage.put("sessions", this.sessions);
        return new Response(JSON.stringify({ isNewUser: false, token, name: existing.name }), { headers: corsHeaders() });
      }
      const pendingToken = crypto.randomUUID();
      this.pending[pendingToken] = { sub, expires: Date.now() + PENDING_TOKEN_TTL_MS };
      await this.state.storage.put("pending", this.pending);
      return new Response(JSON.stringify({ isNewUser: true, pendingToken }), { headers: corsHeaders() });
    }

    if(body.action === "register"){
      const { pendingToken, name } = body;
      const entry = this.pending[pendingToken];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "invalid pending token" }), { status: 400, headers: corsHeaders() });
      }
      const cleanName = (name || "").trim().slice(0, 6) || "GUEST";
      this.users[entry.sub] = { name: cleanName, highScores: {} };
      delete this.pending[pendingToken];
      const token = crypto.randomUUID();
      this.sessions[token] = { sub: entry.sub, expires: Date.now() + LOGIN_SESSION_TTL_MS };
      await this.state.storage.put("users", this.users);
      await this.state.storage.put("pending", this.pending);
      await this.state.storage.put("sessions", this.sessions);
      return new Response(JSON.stringify({ token, name: cleanName }), { headers: corsHeaders() });
    }

    if(body.action === "verify"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ valid: false }), { headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ valid: false }), { headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ valid: true, name: user.name }), { headers: corsHeaders() });
    }

    if(body.action === "getHighScores"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ highScores: user.highScores || {} }), { headers: corsHeaders() });
    }

    if(body.action === "setHighScore"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const { mode, level, score } = body;
      const key = `highScore_${mode}_${level}`;
      if(!user.highScores) user.highScores = {};
      const current = user.highScores[key] || 0;
      if(score > current){
        user.highScores[key] = score;
        await this.state.storage.put("users", this.users);
      }
      return new Response(JSON.stringify({ ok: true, highScore: user.highScores[key] || current }), { headers: corsHeaders() });
    }

    if(body.action === "setName"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const cleanName = (body.name || "").trim().slice(0, 6) || "GUEST";
      user.name = cleanName;
      await this.state.storage.put("users", this.users);
      return new Response(JSON.stringify({ ok: true, name: cleanName }), { headers: corsHeaders() });
    }

    if(body.action === "logout"){
      delete this.sessions[body.token];
      await this.state.storage.put("sessions", this.sessions);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "listUsers"){
      const list = Object.keys(this.users).map(sub => ({
        sub,
        name: this.users[sub].name,
        highScores: this.users[sub].highScores || {}
      }));
      return new Response(JSON.stringify({ users: list }), { headers: corsHeaders() });
    }

    if(body.action === "deleteUser"){
      const { sub } = body;
      if(!this.users[sub]){
        return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders() });
      }
      delete this.users[sub];
      for(const token of Object.keys(this.sessions)){
        if(this.sessions[token].sub === sub) delete this.sessions[token];
      }
      await this.state.storage.put("users", this.users);
      await this.state.storage.put("sessions", this.sessions);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

async function verifyGoogleIdToken(idToken, expectedAudience){
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if(!res.ok) return null;
  const payload = await res.json();
  if(!payload.sub) return null;
  if(payload.aud !== expectedAudience) return null;
  if(payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") return null;
  return payload;
}

async function handleAuth(request, env){
  if(request.method === "OPTIONS"){
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let body = {};
  try{
    body = await request.json();
  }catch(e){
    body = {};
  }

  const authId = env.USER_AUTH.idFromName("global");
  const authStub = env.USER_AUTH.get(authId);

  if(body.action === "login"){
    const payload = await verifyGoogleIdToken(body.idToken, env.GOOGLE_CLIENT_ID);
    if(!payload){
      return new Response(JSON.stringify({ error: "invalid id token" }), { status: 401, headers: corsHeaders() });
    }
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolveLogin", sub: payload.sub })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "register"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "register", pendingToken: body.pendingToken, name: body.name })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "verify"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", token: body.token })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "getHighScores"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getHighScores", token: body.token })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "setHighScore"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setHighScore", token: body.token, mode: body.mode, level: body.level, score: body.score })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "setName"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setName", token: body.token, name: body.name })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "logout"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout", token: body.token })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
}

const PLAY_LOG_MAX = 500;

export class PlayLog {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.entries = null;
  }

  async load(){
    if(this.entries) return;
    const stored = await this.state.storage.get("entries");
    this.entries = Array.isArray(stored) ? stored : [];
  }

  async fetch(request){
    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    await this.load();

    let body = {};
    try{
      body = await request.json();
    }catch(e){
      body = {};
    }

    if(body.action === "record"){
      const name = sanitizeRankingName(body.name);
      const mode = String(body.mode || "");
      const level = String(body.level || "");
      const matchType = String(body.matchType || "solo");
      const opponent = String(body.opponent || "").trim().slice(0, 6);
      const ip = String(body.ip || "unknown").slice(0, 64);
      const userAgent = String(body.userAgent || "unknown").slice(0, 300);
      this.entries.unshift({ name, mode, level, matchType, opponent, ip, userAgent, ts: Date.now() });
      if(this.entries.length > PLAY_LOG_MAX){
        this.entries = this.entries.slice(0, PLAY_LOG_MAX);
      }
      await this.state.storage.put("entries", this.entries);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "list"){
      return new Response(JSON.stringify({ entries: this.entries }), { headers: corsHeaders() });
    }

    if(body.action === "clear"){
      this.entries = [];
      await this.state.storage.put("entries", this.entries);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

async function handlePlayLog(request, env){
  if(request.method === "OPTIONS"){
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  let body = {};
  try{
    body = await request.json();
  }catch(e){
    body = {};
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const userAgent = request.headers.get("User-Agent") || "unknown";
  const id = env.PLAY_LOG.idFromName("global");
  const stub = env.PLAY_LOG.get(id);
  const res = await stub.fetch(new Request("https://internal/playlog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "record", name: body.name, mode: body.mode, level: body.level, matchType: body.matchType, opponent: body.opponent, ip, userAgent })
  }));
  return new Response(await res.text(), { headers: corsHeaders() });
}

const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_LOCK_MS = 15 * 60 * 1000;

export class AdminAuth {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.tokens = null;
    this.attempts = null;
  }

  async load(){
    if(this.tokens && this.attempts) return;
    const stored = await this.state.storage.get(["tokens", "attempts"]);
    this.tokens = stored.get("tokens") || {};
    this.attempts = stored.get("attempts") || {};
  }

  pruneExpired(){
    const now = Date.now();
    for(const token of Object.keys(this.tokens)){
      if(this.tokens[token] < now){
        delete this.tokens[token];
      }
    }
    for(const ip of Object.keys(this.attempts)){
      const entry = this.attempts[ip];
      if(entry.lockUntil && entry.lockUntil < now){
        delete this.attempts[ip];
        continue;
      }
      if(!entry.lockUntil && entry.firstFailAt < now - ADMIN_ATTEMPT_WINDOW_MS){
        delete this.attempts[ip];
      }
    }
  }

  async fetch(request){
    if(request.method === "OPTIONS"){
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    await this.load();
    this.pruneExpired();

    let body = {};
    try{
      body = await request.json();
    }catch(e){
      body = {};
    }

    if(body.action === "checkLock"){
      const entry = this.attempts[body.ip];
      const now = Date.now();
      if(entry && entry.lockUntil && entry.lockUntil > now){
        return new Response(JSON.stringify({ locked: true, retryAfterSeconds: Math.ceil((entry.lockUntil - now) / 1000) }), { headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ locked: false }), { headers: corsHeaders() });
    }

    if(body.action === "recordFailure"){
      const now = Date.now();
      const entry = this.attempts[body.ip] || { count: 0, firstFailAt: now, lockUntil: 0 };
      if(now - entry.firstFailAt > ADMIN_ATTEMPT_WINDOW_MS){
        entry.count = 0;
        entry.firstFailAt = now;
      }
      entry.count += 1;
      if(entry.count >= ADMIN_MAX_ATTEMPTS){
        entry.lockUntil = now + ADMIN_LOCK_MS;
      }
      this.attempts[body.ip] = entry;
      await this.state.storage.put("attempts", this.attempts);
      return new Response(JSON.stringify({ locked: Boolean(entry.lockUntil) }), { headers: corsHeaders() });
    }

    if(body.action === "resetAttempts"){
      delete this.attempts[body.ip];
      await this.state.storage.put("attempts", this.attempts);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "issue"){
      const token = crypto.randomUUID();
      this.tokens[token] = Date.now() + ADMIN_TOKEN_TTL_MS;
      await this.state.storage.put("tokens", this.tokens);
      return new Response(JSON.stringify({ token }), { headers: corsHeaders() });
    }

    if(body.action === "verify"){
      const valid = Boolean(body.token && this.tokens[body.token] && this.tokens[body.token] >= Date.now());
      await this.state.storage.put("tokens", this.tokens);
      return new Response(JSON.stringify({ valid }), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

async function handleAdmin(request, env){
  if(request.method === "OPTIONS"){
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  let body = {};
  if(request.method === "POST"){
    try{
      body = await request.json();
    }catch(e){
      body = {};
    }
  } else {
    const url = new URL(request.url);
    body = {
      token: url.searchParams.get("token"),
      action: url.searchParams.get("action") || "list"
    };
  }

  const authId = env.ADMIN_AUTH.idFromName("global");
  const authStub = env.ADMIN_AUTH.get(authId);

  if(body.action === "login"){
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    const lockRes = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "checkLock", ip })
    }));
    const lockData = await lockRes.json();
    if(lockData.locked){
      return new Response(JSON.stringify({ error: "locked", retryAfterSeconds: lockData.retryAfterSeconds }), { status: 429, headers: corsHeaders() });
    }

    if(body.password !== env.ADMIN_PASSWORD){
      await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recordFailure", ip })
      }));
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
    }

    await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resetAttempts", ip })
    }));
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "issue" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  const verifyRes = await authStub.fetch(new Request("https://internal/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "verify", token: body.token })
  }));
  const verifyData = await verifyRes.json();
  if(!verifyData.valid){
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
  }

  if(body.action === "list" || !body.action){
    const result = {};
    for(const mode of RANKING_MODES){
      for(const level of RANKING_LEVELS){
        const id = env.RANKING.idFromName(`${mode}:${level}`);
        const stub = env.RANKING.get(id);
        const res = await stub.fetch(new Request("https://internal/ranking", { method: "GET" }));
        result[`${mode}:${level}`] = await res.json();
      }
    }
    return new Response(JSON.stringify(result), { headers: corsHeaders() });
  }

  if(body.action === "delete"){
    const { mode, level, score } = body;
    const id = env.RANKING.idFromName(`${mode}:${level}`);
    const stub = env.RANKING.get(id);
    const res = await stub.fetch(new Request("https://internal/ranking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", score })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "clear"){
    const { mode, level } = body;
    const id = env.RANKING.idFromName(`${mode}:${level}`);
    const stub = env.RANKING.get(id);
    const res = await stub.fetch(new Request("https://internal/ranking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "getEventMode"){
    const eventId = env.EVENT_SETTINGS.idFromName("global");
    const eventStub = env.EVENT_SETTINGS.get(eventId);
    const res = await eventStub.fetch(new Request("https://internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "setEventMode"){
    const { enabled, month } = body;
    const eventId = env.EVENT_SETTINGS.idFromName("global");
    const eventStub = env.EVENT_SETTINGS.get(eventId);
    const res = await eventStub.fetch(new Request("https://internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", enabled, month })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "getEventArchive"){
    const { month } = body;
    const result = {};
    for(const mode of RANKING_MODES){
      for(const level of RANKING_LEVELS){
        const id = env.RANKING.idFromName(`${mode}:${level}`);
        const stub = env.RANKING.get(id);
        const res = await stub.fetch(new Request("https://internal/ranking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "getMonthRanking", month })
        }));
        const data = await res.json();
        result[`${mode}:${level}`] = data.top20 || [];
      }
    }
    return new Response(JSON.stringify(result), { headers: corsHeaders() });
  }

  if(body.action === "clearMonthRanking"){
    const { mode, level, month } = body;
    const id = env.RANKING.idFromName(`${mode}:${level}`);
    const stub = env.RANKING.get(id);
    const res = await stub.fetch(new Request("https://internal/ranking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clearMonthRanking", month })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "deleteMonthRanking"){
    const { mode, level, month, score } = body;
    const id = env.RANKING.idFromName(`${mode}:${level}`);
    const stub = env.RANKING.get(id);
    const res = await stub.fetch(new Request("https://internal/ranking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteMonthRanking", month, score })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "listUsers"){
    const userAuthId = env.USER_AUTH.idFromName("global");
    const userAuthStub = env.USER_AUTH.get(userAuthId);
    const res = await userAuthStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "listUsers" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "deleteUser"){
    const { sub } = body;
    const userAuthId = env.USER_AUTH.idFromName("global");
    const userAuthStub = env.USER_AUTH.get(userAuthId);
    const res = await userAuthStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteUser", sub })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "listPlayLog"){
    const id = env.PLAY_LOG.idFromName("global");
    const stub = env.PLAY_LOG.get(id);
    const res = await stub.fetch(new Request("https://internal/playlog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "clearPlayLog"){
    const id = env.PLAY_LOG.idFromName("global");
    const stub = env.PLAY_LOG.get(id);
    const res = await stub.fetch(new Request("https://internal/playlog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "listInviteCodes"){
    const regId = env.FRIEND_REGISTRY.idFromName("global");
    const regStub = env.FRIEND_REGISTRY.get(regId);
    const res = await regStub.fetch(new Request("https://internal/registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "deleteInviteCode"){
    const { code } = body;
    const roomId = env.FRIEND_ROOM.idFromName(code);
    const roomStub = env.FRIEND_ROOM.get(roomId);
    try{
      await roomStub.fetch(new Request("https://internal/friend-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close" })
      }));
    }catch(e){}
    const regId = env.FRIEND_REGISTRY.idFromName("global");
    const regStub = env.FRIEND_REGISTRY.get(regId);
    await regStub.fetch(new Request("https://internal/registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unregister", code })
    }));
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if(url.pathname === "/admin"){
      return handleAdmin(request, env);
    }

    if(url.pathname === "/auth"){
      return handleAuth(request, env);
    }

    if(url.pathname === "/playlog"){
      return handlePlayLog(request, env);
    }

    if(url.pathname === "/ranking"){
      const mode = url.searchParams.get("mode") || "hiragana";
      const level = url.searchParams.get("level") || "beginner";
      const id = env.RANKING.idFromName(`${mode}:${level}`);
      const stub = env.RANKING.get(id);
      if(request.method === "GET"){
        let eventEnabled = false;
        let eventMonth = "";
        if(env.EVENT_SETTINGS){
          const eventId = env.EVENT_SETTINGS.idFromName("global");
          const eventStub = env.EVENT_SETTINGS.get(eventId);
          const eventRes = await eventStub.fetch(new Request("https://internal/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "get" })
          }));
          const eventData = await eventRes.json();
          eventEnabled = Boolean(eventData.enabled);
          eventMonth = String(eventData.month || "");
        }
        if(eventEnabled && eventMonth === getCurrentMonthJST()){
          const res = await stub.fetch(new Request("https://internal/ranking", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "getMonthRanking", month: eventMonth })
          }));
          const data = await res.json();
          return new Response(JSON.stringify({ scores: data.top20 || [], eventMode: true, month: eventMonth }), { headers: corsHeaders() });
        }
        const res = await stub.fetch(request);
        const scores = await res.json();
        return new Response(JSON.stringify({ scores, eventMode: false, month: "" }), { headers: corsHeaders() });
      }
      return stub.fetch(request);
    }

    if(url.pathname === "/lobby"){
      const mode = url.searchParams.get("mode") || "hiragana";
      const level = url.searchParams.get("level") || "beginner";
      const id = env.LOBBY.idFromName(`${mode}:${level}`);
      const stub = env.LOBBY.get(id);
      return stub.fetch(request);
    }

    if(url.pathname.startsWith("/friend/")){
      const code = url.pathname.split("/")[2];
      if(!code){
        return new Response("missing room code", { status: 400 });
      }
      if(!/^[0-9]+$/.test(code)){
        return new Response("invalid room code", { status: 400 });
      }
      const id = env.FRIEND_ROOM.idFromName(code);
      const stub = env.FRIEND_ROOM.get(id);
      return stub.fetch(request);
    }

    if(url.pathname.startsWith("/match/")){
      const matchId = url.pathname.split("/")[2];
      if(!matchId){
        return new Response("missing match id", { status: 400 });
      }
      const id = env.MATCH.idFromName(matchId);
      const stub = env.MATCH.get(id);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  }
};
