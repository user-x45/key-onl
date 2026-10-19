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

const NAME_CHECK_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const NAME_CHECK_CACHE_MAX = 500;
const nameCheckCache = new Map();

const NAME_CHECK_SYSTEM_PROMPT = [
  "あなたはオンラインゲームのプレイヤー名を審査するモデレーターです。",
  "与えられた名前が以下のいずれかに該当する場合は BLOCK、そうでなければ ALLOW と判定します。",
  "1. 公序良俗に反する単語",
  "2. 猥褻（下ネタ・性的な表現。隠語、伏せ字、当て字、ローマ字、英語、略語、ひらがな・カタカナ・漢字の言い換えを含む）",
  "3. 暴力・残虐的表現（殺害、虐待、拷問、グロテスクな表現など）",
  "4. 差別用語（人種、民族、国籍、宗教、性別、性的指向、障害、出身などに対する蔑称・侮辱）",
  "5. 違法行為・犯罪を示唆する単語（違法薬物、自殺や自傷を促す言葉、テロ、犯罪の助長など）",
  "名前は最大6文字です。文字の置き換え、全角半角の混在、記号や空白の挿入、逆読み、数字による当て字による回避も見抜いてください。",
  "一般的な人名、ニックネーム、無害な単語、意味のない文字列は ALLOW としてください。",
  "判定が難しい場合は、明らかに不適切と思われる場合のみ BLOCK としてください。",
  '出力は {"verdict":"ALLOW"} または {"verdict":"BLOCK"} のJSONのみとし、他の文字は一切出力しないでください。'
].join("\n");

function normalizeNameForCheck(raw){
  return String(raw || "").normalize("NFKC").trim().slice(0, 6);
}

function extractModelText(result){
  if(result === null || result === undefined) return "";
  if(typeof result === "string") return result;
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  if(choice){
    if(choice.message && choice.message.content !== undefined && choice.message.content !== null){
      const c = choice.message.content;
      if(typeof c === "string") return c;
      if(Array.isArray(c)) return c.map(part => (part && part.text) || "").join("");
      return JSON.stringify(c);
    }
    if(typeof choice.text === "string") return choice.text;
  }
  if(result.response !== undefined && result.response !== null){
    return typeof result.response === "object" ? JSON.stringify(result.response) : String(result.response);
  }
  if(result.result) return extractModelText(result.result);
  if(typeof result.output_text === "string") return result.output_text;
  return "";
}

function parseNameVerdict(result){
  const text = extractModelText(result);
  const upper = text.toUpperCase();
  if(upper.includes("BLOCK")) return false;
  if(upper.includes("ALLOW")) return true;
  return null;
}

async function checkNameAllowed(env, rawName){
  const name = normalizeNameForCheck(rawName);
  if(name.length === 0 || name === "GUEST") return { ok: true };
  if(!env.AI) return { ok: false, error: "name_check_failed" };
  if(nameCheckCache.has(name)){
    return nameCheckCache.get(name) ? { ok: true } : { ok: false, error: "name_blocked" };
  }
  try{
    const result = await env.AI.run(NAME_CHECK_MODEL, {
      messages: [
        { role: "system", content: NAME_CHECK_SYSTEM_PROMPT },
        { role: "user", content: `プレイヤー名: ${JSON.stringify(name)}` }
      ],
      max_tokens: 128,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false }
    });
    const verdict = parseNameVerdict(result);
    if(verdict === null){
      console.error("name check unparsable", JSON.stringify(result).slice(0, 500));
      return { ok: false, error: "name_check_failed" };
    }
    if(nameCheckCache.size >= NAME_CHECK_CACHE_MAX){
      nameCheckCache.delete(nameCheckCache.keys().next().value);
    }
    nameCheckCache.set(name, verdict);
    return verdict ? { ok: true } : { ok: false, error: "name_blocked" };
  }catch(e){
    console.error("name check error", e && e.message ? e.message : e);
    return { ok: false, error: "name_check_failed" };
  }
}

async function rejectIfNameNotAllowed(env, rawName){
  const check = await checkNameAllowed(env, rawName);
  if(check.ok) return null;
  const status = check.error === "name_blocked" ? 400 : 503;
  return new Response(JSON.stringify({ error: check.error }), { status, headers: corsHeaders() });
}

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

function stripSubs(list){
  return list.map(({ sub, ...rest }) => rest);
}

async function resolveUserSession(env, token){
  if(!token || !env.USER_AUTH) return null;
  const stub = env.USER_AUTH.get(env.USER_AUTH.idFromName("global"));
  try{
    const res = await stub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolveSession", token })
    }));
    const data = await res.json();
    return data.valid ? data : null;
  }catch(e){
    return null;
  }
}

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };
}


export class Ranking {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.scores = null;
  }

  async load(){
    if(this.scores) return;
    const stored = await this.state.storage.get("scores");
    const list = Array.isArray(stored) ? stored : [];
    this.scores = list.map(entry => typeof entry === "object" && entry !== null ? entry : { score: entry, name: "GUEST" });
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
        return new Response(JSON.stringify({ top20: stripSubs(monthScores) }), { headers: corsHeaders() });
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
        return new Response(JSON.stringify({ top20: stripSubs(monthScores) }), { headers: corsHeaders() });
      }

      let eventEnabled = false;
      let eventMonth = "";
      let eventCombos = [];
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
        eventCombos = Array.isArray(eventData.combos) ? eventData.combos : [];
      }

      const score = Math.max(0, Math.round(Number(body.score) || 0));
      const name = sanitizeRankingName(body.name);

      let activeEventMonth = eventEnabled && eventMonth === getCurrentMonthJST() && eventCombos.includes(`${mode}:${level}`);
      if(body.__forceNormal){
        activeEventMonth = false;
      } else if(body.__forceEvent){
        activeEventMonth = true;
        eventMonth = String(body.__eventMonth || eventMonth);
      }

      if(activeEventMonth){
        const session = await resolveUserSession(this.env, body.token);
        if(!session){
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
        }
        const key = `monthScores:${eventMonth}`;
        const stored = (await this.state.storage.get(key)) || [];
        const currentIndex = stored.findIndex(s => s.sub === session.sub);
        let monthScores = stored;
        let monthRank = null;
        if(currentIndex === -1 || score > stored[currentIndex].score){
          const others = stored.filter(s => s.sub !== session.sub);
          let pos = 0;
          while(pos < others.length && others[pos].score > score) pos++;
          if(pos < RANKING_MAX){
            others.splice(pos, 0, { score, name: session.name, sub: session.sub });
            monthScores = others.slice(0, RANKING_MAX);
            monthRank = pos + 1;
            await this.state.storage.put(key, monthScores);
          }
        }
        return new Response(JSON.stringify({ rank: monthRank, top20: stripSubs(monthScores), eventMode: true, month: eventMonth }), { headers: corsHeaders() });
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

const EVENT_MODES = ["hiragana", "katakana", "sentence"];
const EVENT_LEVELS = ["beginner", "intermediate", "advanced"];
const EVENT_COMBOS = EVENT_MODES.flatMap(mode => EVENT_LEVELS.map(level => `${mode}:${level}`));
const EVENT_NOTICE_MAX = 200;

export class EventSettings {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.settings = null;
  }

  async load(){
    if(this.settings) return;
    const stored = await this.state.storage.get("settings");
    this.settings = stored || { enabled: false, month: "", combos: EVENT_COMBOS.slice(), notice: "" };
    if(!Array.isArray(this.settings.combos)){
      this.settings.combos = EVENT_COMBOS.slice();
    }
    if(typeof this.settings.notice !== "string"){
      this.settings.notice = "";
    }
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
      const combos = Array.isArray(body.combos)
        ? body.combos.filter(c => EVENT_COMBOS.includes(c))
        : EVENT_COMBOS.slice();
      const notice = String(body.notice || "").trim().slice(0, EVENT_NOTICE_MAX);
      this.settings = { enabled: Boolean(body.enabled), month: String(body.month || ""), combos, notice };
      await this.state.storage.put("settings", this.settings);
      return new Response(JSON.stringify(this.settings), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

const LOGIN_SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const PENDING_TOKEN_TTL_MS = 10 * 60 * 1000;

const PLAY_RECORD_MAX = 20;

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
      if(sub && sub.startsWith("google:") && !this.users[sub]){
        const legacySub = sub.slice("google:".length);
        if(this.users[legacySub]){
          this.users[sub] = this.users[legacySub];
          delete this.users[legacySub];
          for(const token of Object.keys(this.sessions)){
            if(this.sessions[token].sub === legacySub){
              this.sessions[token].sub = sub;
            }
          }
          await this.state.storage.put("users", this.users);
          await this.state.storage.put("sessions", this.sessions);
        }
      }
      const existing = this.users[sub];
      if(existing){
        const token = crypto.randomUUID();
        this.sessions[token] = { sub, expires: Date.now() + LOGIN_SESSION_TTL_MS };
        await this.state.storage.put("sessions", this.sessions);
        return new Response(JSON.stringify({ isNewUser: false, token, name: existing.name, inputMode: existing.inputMode || null, displaySettings: existing.displaySettings || null }), { headers: corsHeaders() });
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

    if(body.action === "resolveSession"){
      const entry = this.sessions[body.token];
      const user = entry && entry.expires >= Date.now() ? this.users[entry.sub] : null;
      if(!user){
        return new Response(JSON.stringify({ valid: false }), { headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ valid: true, sub: entry.sub, name: user.name }), { headers: corsHeaders() });
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
      return new Response(JSON.stringify({ valid: true, name: user.name, inputMode: user.inputMode || null, displaySettings: user.displaySettings || null }), { headers: corsHeaders() });
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

    if(body.action === "setInputMode"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const inputMode = body.inputMode === "textbox" ? "textbox" : "realtime";
      user.inputMode = inputMode;
      await this.state.storage.put("users", this.users);
      return new Response(JSON.stringify({ ok: true, inputMode }), { headers: corsHeaders() });
    }

    if(body.action === "setDisplaySettings"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const displaySettings = {
        showRomaji: body.showRomaji !== false,
        showHiragana: body.showHiragana !== false,
        romajiUppercase: body.romajiUppercase === true,
        showKeyboard: body.showKeyboard !== false
      };
      user.displaySettings = displaySettings;
      await this.state.storage.put("users", this.users);
      return new Response(JSON.stringify({ ok: true, displaySettings }), { headers: corsHeaders() });
    }

    if(body.action === "addPlayRecord"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const record = {
        mode: String(body.mode || ""),
        level: String(body.level || ""),
        playedAt: Date.now(),
        accuracy: Number(body.accuracy) || 0,
        speed: Number(body.speed) || 0,
        miss: Number(body.miss) || 0,
        score: Number(body.score) || 0
      };
      if(!user.playRecords) user.playRecords = [];
      user.playRecords.unshift(record);
      user.playRecords = user.playRecords.slice(0, PLAY_RECORD_MAX);
      await this.state.storage.put("users", this.users);
      return new Response(JSON.stringify({ ok: true, playRecords: user.playRecords }), { headers: corsHeaders() });
    }

    if(body.action === "getPlayRecords"){
      const entry = this.sessions[body.token];
      if(!entry || entry.expires < Date.now()){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      const user = this.users[entry.sub];
      if(!user){
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders() });
      }
      return new Response(JSON.stringify({ playRecords: user.playRecords || [] }), { headers: corsHeaders() });
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

async function verifyXAuthCode(code, codeVerifier, redirectUri, env){
  const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`)}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: env.X_CLIENT_ID
    })
  });
  if(!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  if(!tokenData.access_token) return null;

  const userRes = await fetch("https://api.x.com/2/users/me", {
    headers: { "Authorization": `Bearer ${tokenData.access_token}` }
  });
  if(!userRes.ok) return null;
  const userData = await userRes.json();
  if(!userData.data || !userData.data.id) return null;
  return userData.data;
}

async function verifyDiscordAuthCode(code, codeVerifier, redirectUri, env){
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "DiscordBot (https://s-typing.f5.si, 1.0)"
    },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    })
  });
  if(!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  if(!tokenData.access_token) return null;

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: {
      "Authorization": `Bearer ${tokenData.access_token}`,
      "User-Agent": "DiscordBot (https://s-typing.f5.si, 1.0)"
    }
  });
  if(!userRes.ok) return null;
  const userData = await userRes.json();
  if(!userData.id) return null;
  return userData;
}

async function verifyLineAuthCode(code, codeVerifier, redirectUri, env){
  const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.LINE_CHANNEL_ID,
      client_secret: env.LINE_CHANNEL_SECRET,
      code_verifier: codeVerifier
    })
  });
  if(!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  if(!tokenData.access_token) return null;

  const profileRes = await fetch("https://api.line.me/v2/profile", {
    headers: { "Authorization": `Bearer ${tokenData.access_token}` }
  });
  if(!profileRes.ok) return null;
  const profile = await profileRes.json();
  if(!profile.userId) return null;
  return profile;
}

async function verifyFacebookAuthCode(code, redirectUri, env){
  const tokenQuery = new URLSearchParams({
    client_id: env.FACEBOOK_APP_ID,
    client_secret: env.FACEBOOK_APP_SECRET,
    redirect_uri: redirectUri,
    code
  });
  const tokenRes = await fetch(`https://graph.facebook.com/v22.0/oauth/access_token?${tokenQuery.toString()}`);
  if(!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  if(!tokenData.access_token) return null;

  const userRes = await fetch("https://graph.facebook.com/v22.0/me?fields=id", {
    headers: { "Authorization": `Bearer ${tokenData.access_token}` }
  });
  if(!userRes.ok) return null;
  const userData = await userRes.json();
  if(!userData.id) return null;
  return userData;
}

async function verifyGithubAuthCode(code, redirectUri, env){
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    })
  });
  if(!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  if(!tokenData.access_token) return null;

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `Bearer ${tokenData.access_token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "s-typing"
    }
  });
  if(!userRes.ok) return null;
  const userData = await userRes.json();
  if(!userData.id) return null;
  return userData;
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
    if(body.provider === "x"){
      const userData = await verifyXAuthCode(body.code, body.codeVerifier, body.redirectUri, env);
      if(!userData){
        return new Response(JSON.stringify({ error: "invalid auth code" }), { status: 401, headers: corsHeaders() });
      }
      const res = await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveLogin", sub: `x:${userData.id}` })
      }));
      return new Response(await res.text(), { headers: corsHeaders() });
    }

    if(body.provider === "discord"){
      const userData = await verifyDiscordAuthCode(body.code, body.codeVerifier, body.redirectUri, env);
      if(!userData){
        return new Response(JSON.stringify({ error: "invalid auth code" }), { status: 401, headers: corsHeaders() });
      }
      const res = await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveLogin", sub: `discord:${userData.id}` })
      }));
      return new Response(await res.text(), { headers: corsHeaders() });
    }

    if(body.provider === "line"){
      const userData = await verifyLineAuthCode(body.code, body.codeVerifier, body.redirectUri, env);
      if(!userData){
        return new Response(JSON.stringify({ error: "invalid auth code" }), { status: 401, headers: corsHeaders() });
      }
      const res = await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveLogin", sub: `line:${userData.userId}` })
      }));
      return new Response(await res.text(), { headers: corsHeaders() });
    }

    if(body.provider === "facebook"){
      const userData = await verifyFacebookAuthCode(body.code, body.redirectUri, env);
      if(!userData){
        return new Response(JSON.stringify({ error: "invalid auth code" }), { status: 401, headers: corsHeaders() });
      }
      const res = await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveLogin", sub: `facebook:${userData.id}` })
      }));
      return new Response(await res.text(), { headers: corsHeaders() });
    }

    if(body.provider === "github"){
      const userData = await verifyGithubAuthCode(body.code, body.redirectUri, env);
      if(!userData){
        return new Response(JSON.stringify({ error: "invalid auth code" }), { status: 401, headers: corsHeaders() });
      }
      const res = await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolveLogin", sub: `github:${userData.id}` })
      }));
      return new Response(await res.text(), { headers: corsHeaders() });
    }

    const payload = await verifyGoogleIdToken(body.idToken, env.GOOGLE_CLIENT_ID);
    if(!payload){
      return new Response(JSON.stringify({ error: "invalid id token" }), { status: 401, headers: corsHeaders() });
    }
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolveLogin", sub: `google:${payload.sub}` })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "checkName"){
    const rejected = await rejectIfNameNotAllowed(env, body.name);
    if(rejected) return rejected;
    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
  }

  if(body.action === "register"){
    const rejected = await rejectIfNameNotAllowed(env, body.name);
    if(rejected) return rejected;
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
    const rejected = await rejectIfNameNotAllowed(env, body.name);
    if(rejected) return rejected;
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setName", token: body.token, name: body.name })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "setInputMode"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setInputMode", token: body.token, inputMode: body.inputMode })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "setDisplaySettings"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setDisplaySettings", token: body.token, showRomaji: body.showRomaji, showHiragana: body.showHiragana, romajiUppercase: body.romajiUppercase, showKeyboard: body.showKeyboard })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "addPlayRecord"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "addPlayRecord", token: body.token, mode: body.mode, level: body.level, accuracy: body.accuracy, speed: body.speed, miss: body.miss, score: body.score })
    }));
    return new Response(await res.text(), { headers: corsHeaders() });
  }

  if(body.action === "getPlayRecords"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getPlayRecords", token: body.token })
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

const PRESENCE_ACTIVITIES = ["idle", "solo", "online", "friend", "matching"];
const PRESENCE_MAX_CLIENTS = 2000;
const PRESENCE_MAX_ADMINS = 10;
const PRESENCE_STALE_MS = 150000;
const PRESENCE_TICK_MS = 5000;
const PRESENCE_HEARTBEAT_MS = 25000;
const PRESENCE_ADMIN_RECHECK_MS = 60000;
const PRESENCE_BROADCAST_MIN_MS = 1000;
const PRESENCE_MESSAGE_MAX = 512;

export class Presence {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.clients = new Map();
    this.admins = new Map();
    this.nextId = 1;
    this.lastBroadcastAt = 0;
    this.broadcastTimer = null;
    this.tickTimer = null;
  }

  async fetch(request){
    const url = new URL(request.url);

    if(request.method === "POST" && url.pathname === "/presence-snapshot"){
      return new Response(JSON.stringify(this.buildSnapshot()), { headers: corsHeaders() });
    }

    if(request.headers.get("Upgrade") !== "websocket"){
      return new Response("expected websocket", { status: 426 });
    }

    if(url.pathname === "/admin-presence"){
      if(this.admins.size >= PRESENCE_MAX_ADMINS){
        return new Response("too many admin connections", { status: 503 });
      }
      const adminPair = new WebSocketPair();
      const [adminClient, adminServer] = Object.values(adminPair);
      adminServer.accept();
      this.attachAdmin(adminServer, request);
      return new Response(null, { status: 101, webSocket: adminClient, headers: { "Sec-WebSocket-Protocol": "admin-presence" } });
    }

    if(this.clients.size >= PRESENCE_MAX_CLIENTS){
      return new Response("too many connections", { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.attachClient(server, request);
    return new Response(null, { status: 101, webSocket: client });
  }

  attachClient(ws, request){
    const now = Date.now();
    const entry = {
      id: this.nextId++,
      ip: String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64),
      userAgent: String(request.headers.get("User-Agent") || "unknown").slice(0, 300),
      connectedAt: now,
      lastSeen: now,
      activity: "idle",
      mode: "",
      level: "",
      name: "GUEST"
    };
    this.clients.set(ws, entry);
    this.ensureTick();
    this.scheduleBroadcast();

    ws.addEventListener("message", (event) => {
      entry.lastSeen = Date.now();
      if(typeof event.data !== "string" || event.data.length > PRESENCE_MESSAGE_MAX) return;
      let msg;
      try{
        msg = JSON.parse(event.data);
      }catch(e){
        return;
      }
      if(!msg || msg.type !== "state") return;
      const activity = PRESENCE_ACTIVITIES.includes(msg.activity) ? msg.activity : "idle";
      const active = activity !== "idle";
      const mode = active && RANKING_MODES.includes(msg.mode) ? msg.mode : "";
      const level = active && RANKING_LEVELS.includes(msg.level) ? msg.level : "";
      const name = sanitizeRankingName(msg.name);
      if(entry.activity === activity && entry.mode === mode && entry.level === level && entry.name === name) return;
      entry.activity = activity;
      entry.mode = mode;
      entry.level = level;
      entry.name = name;
      this.scheduleBroadcast();
    });

    const drop = () => this.dropClient(ws);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  attachAdmin(ws, request){
    const protocols = String(request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(p => p.trim());
    this.admins.set(ws, { token: protocols[1] || "", lastCheck: Date.now() });
    this.ensureTick();
    try{
      ws.send(JSON.stringify(this.buildSnapshot()));
    }catch(e){}

    const drop = () => {
      this.admins.delete(ws);
      this.stopTickIfIdle();
    };
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
  }

  dropClient(ws){
    if(!this.clients.delete(ws)) return;
    this.scheduleBroadcast();
    this.stopTickIfIdle();
  }

  buildSnapshot(){
    const now = Date.now();
    const clients = [];
    for(const entry of this.clients.values()){
      clients.push({
        id: entry.id,
        name: entry.name,
        activity: entry.activity,
        mode: entry.mode,
        level: entry.level,
        ip: entry.ip,
        userAgent: entry.userAgent,
        connectedMs: now - entry.connectedAt
      });
    }
    return { type: "snapshot", clients };
  }

  scheduleBroadcast(){
    if(this.admins.size === 0 || this.broadcastTimer) return;
    const wait = Math.max(0, this.lastBroadcastAt + PRESENCE_BROADCAST_MIN_MS - Date.now());
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcast();
    }, wait);
  }

  broadcast(){
    this.lastBroadcastAt = Date.now();
    if(this.admins.size === 0) return;
    const payload = JSON.stringify(this.buildSnapshot());
    for(const ws of this.admins.keys()){
      try{
        ws.send(payload);
      }catch(e){}
    }
  }

  ensureTick(){
    if(this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), PRESENCE_TICK_MS);
  }

  stopTickIfIdle(){
    if(this.tickTimer && this.clients.size === 0 && this.admins.size === 0){
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  tick(){
    const now = Date.now();
    for(const [ws, entry] of this.clients){
      if(now - entry.lastSeen > PRESENCE_STALE_MS){
        this.dropClient(ws);
        try{
          ws.close(1001, "stale");
        }catch(e){}
      }
    }
    for(const [ws, admin] of this.admins){
      if(now - admin.lastCheck >= PRESENCE_ADMIN_RECHECK_MS){
        admin.lastCheck = now;
        this.recheckAdmin(ws, admin);
      }
    }
    if(this.admins.size > 0 && now - this.lastBroadcastAt >= PRESENCE_HEARTBEAT_MS){
      this.scheduleBroadcast();
    }
  }

  async recheckAdmin(ws, admin){
    let valid = true;
    try{
      const stub = this.env.ADMIN_AUTH.get(this.env.ADMIN_AUTH.idFromName("global"));
      const data = await adminAuthCall(stub, { action: "verify", token: admin.token });
      valid = Boolean(data.valid);
    }catch(e){
      return;
    }
    if(valid) return;
    this.admins.delete(ws);
    try{
      ws.close(4401, "unauthorized");
    }catch(e){}
    this.stopTickIfIdle();
  }
}

async function handleAdminPresence(request, env){
  if(request.headers.get("Upgrade") !== "websocket"){
    return new Response("expected websocket", { status: 426 });
  }
  if(!env.PRESENCE){
    return new Response("presence not configured", { status: 503 });
  }
  const protocols = String(request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(p => p.trim());
  const token = protocols[0] === "admin-presence" ? protocols[1] || "" : "";
  if(!token){
    return new Response("unauthorized", { status: 401 });
  }
  const authStub = env.ADMIN_AUTH.get(env.ADMIN_AUTH.idFromName("global"));
  const verified = await adminAuthCall(authStub, { action: "verify", token });
  if(!verified.valid){
    return new Response("unauthorized", { status: 401 });
  }
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
  return stub.fetch(request);
}

const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ADMIN_MAX_CHALLENGES = 50;
const ADMIN_MAX_CREDENTIALS = 10;

function b64urlEncode(bytes){
  const arr = new Uint8Array(bytes);
  let bin = "";
  for(let i = 0; i < arr.length; i++){
    bin += String.fromCharCode(arr[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str){
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++){
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function concatBytes(...arrays){
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for(const a of arrays){
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function sha256(data){
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function bytesEqual(a, b){
  if(a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++){
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function secretEquals(a, b){
  const ha = await sha256(new TextEncoder().encode(String(a || "")));
  const hb = await sha256(new TextEncoder().encode(String(b || "")));
  return bytesEqual(ha, hb);
}

function cborDecode(bytes, start){
  let pos = start || 0;

  function readLen(info){
    if(info < 24) return info;
    if(info === 24){
      const v = bytes[pos];
      pos += 1;
      return v;
    }
    if(info === 25){
      const v = (bytes[pos] << 8) | bytes[pos + 1];
      pos += 2;
      return v;
    }
    if(info === 26){
      const v = bytes[pos] * 16777216 + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3];
      pos += 4;
      return v;
    }
    throw new Error("unsupported cbor length");
  }

  function read(){
    const initial = bytes[pos];
    pos += 1;
    const major = initial >> 5;
    const info = initial & 31;
    if(major === 0) return readLen(info);
    if(major === 1) return -1 - readLen(info);
    if(major === 2){
      const len = readLen(info);
      const v = bytes.slice(pos, pos + len);
      pos += len;
      return v;
    }
    if(major === 3){
      const len = readLen(info);
      const v = new TextDecoder().decode(bytes.slice(pos, pos + len));
      pos += len;
      return v;
    }
    if(major === 4){
      const len = readLen(info);
      const arr = [];
      for(let i = 0; i < len; i++){
        arr.push(read());
      }
      return arr;
    }
    if(major === 5){
      const len = readLen(info);
      const map = new Map();
      for(let i = 0; i < len; i++){
        const k = read();
        const v = read();
        map.set(k, v);
      }
      return map;
    }
    if(major === 7){
      if(info === 20) return false;
      if(info === 21) return true;
      if(info === 22) return null;
    }
    throw new Error("unsupported cbor type");
  }

  const value = read();
  return { value, end: pos };
}

function coseToCredentialKey(cose){
  if(!(cose instanceof Map)) return null;
  const kty = cose.get(1);
  const alg = cose.get(3);
  if(kty === 2 && alg === -7 && cose.get(-1) === 1){
    const x = cose.get(-2);
    const y = cose.get(-3);
    if(!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return null;
    return { alg: -7, jwk: { kty: "EC", crv: "P-256", x: b64urlEncode(x), y: b64urlEncode(y), ext: true } };
  }
  if(kty === 3 && alg === -257){
    const n = cose.get(-1);
    const e = cose.get(-2);
    if(!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) return null;
    return { alg: -257, jwk: { kty: "RSA", alg: "RS256", n: b64urlEncode(n), e: b64urlEncode(e), ext: true } };
  }
  return null;
}

function derToRawEcdsa(der){
  let pos = 0;
  if(der[pos++] !== 0x30) throw new Error("bad signature");
  let seqLen = der[pos++];
  if(seqLen & 0x80){
    const n = seqLen & 0x7f;
    seqLen = 0;
    for(let i = 0; i < n; i++){
      seqLen = (seqLen << 8) | der[pos++];
    }
  }
  function readInt(){
    if(der[pos++] !== 0x02) throw new Error("bad signature");
    const len = der[pos++];
    let int = der.slice(pos, pos + len);
    pos += len;
    while(int.length > 32 && int[0] === 0){
      int = int.slice(1);
    }
    if(int.length > 32) throw new Error("bad signature");
    const out = new Uint8Array(32);
    out.set(int, 32 - int.length);
    return out;
  }
  const r = readInt();
  const s = readInt();
  return concatBytes(r, s);
}

function parseAuthData(authData){
  if(authData.length < 37) throw new Error("bad authenticator data");
  return {
    rpIdHash: authData.slice(0, 32),
    flags: authData[32],
    signCount: ((authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36]) >>> 0
  };
}

function parseClientData(clientDataBytes, expectedType, env){
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  if(clientData.type !== expectedType) return null;
  if(clientData.origin !== env.ADMIN_ORIGIN) return null;
  if(clientData.crossOrigin === true) return null;
  if(typeof clientData.challenge !== "string") return null;
  return clientData;
}

async function verifyAssertionSignature(credential, signedData, signature){
  if(credential.alg === -7){
    const key = await crypto.subtle.importKey("jwk", credential.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRawEcdsa(signature), signedData);
  }
  if(credential.alg === -257){
    const key = await crypto.subtle.importKey("jwk", credential.jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  }
  return false;
}

export class AdminAuth {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.tokens = null;
    this.attempts = null;
    this.credentials = null;
    this.challenges = null;
  }

  async load(){
    if(this.tokens && this.attempts && this.credentials && this.challenges) return;
    const stored = await this.state.storage.get(["tokens", "attempts", "credentials", "challenges"]);
    this.tokens = stored.get("tokens") || {};
    this.attempts = stored.get("attempts") || {};
    this.credentials = stored.get("credentials") || {};
    this.challenges = stored.get("challenges") || {};
  }

  pruneExpired(){
    const now = Date.now();
    for(const token of Object.keys(this.tokens)){
      if(this.tokens[token] < now){
        delete this.tokens[token];
      }
    }
    for(const challenge of Object.keys(this.challenges)){
      if(this.challenges[challenge] < now){
        delete this.challenges[challenge];
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

    if(body.action === "listCredentialIds"){
      return new Response(JSON.stringify({ ids: Object.keys(this.credentials) }), { headers: corsHeaders() });
    }

    if(body.action === "getCredential"){
      const credential = typeof body.id === "string" ? this.credentials[body.id] || null : null;
      return new Response(JSON.stringify({ credential }), { headers: corsHeaders() });
    }

    if(body.action === "saveCredential"){
      const credential = body.credential;
      if(!credential || typeof credential.id !== "string"){
        return new Response(JSON.stringify({ error: "invalid credential" }), { status: 400, headers: corsHeaders() });
      }
      if(!this.credentials[credential.id] && Object.keys(this.credentials).length >= ADMIN_MAX_CREDENTIALS){
        return new Response(JSON.stringify({ error: "too many credentials" }), { status: 400, headers: corsHeaders() });
      }
      this.credentials[credential.id] = credential;
      await this.state.storage.put("credentials", this.credentials);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "updateSignCount"){
      if(this.credentials[body.id]){
        this.credentials[body.id].signCount = body.signCount;
        this.credentials[body.id].lastUsedAt = Date.now();
        await this.state.storage.put("credentials", this.credentials);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "listCredentials"){
      const list = Object.keys(this.credentials).map(id => {
        const c = this.credentials[id];
        return {
          id,
          label: c.label || "不明な端末",
          createdAt: c.createdAt || 0,
          lastUsedAt: c.lastUsedAt || 0
        };
      });
      list.sort((a, b) => b.createdAt - a.createdAt);
      return new Response(JSON.stringify({ credentials: list }), { headers: corsHeaders() });
    }

    if(body.action === "deleteCredential"){
      if(typeof body.id !== "string" || !this.credentials[body.id]){
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: corsHeaders() });
      }
      if(Object.keys(this.credentials).length <= 1){
        return new Response(JSON.stringify({ error: "last_credential" }), { status: 400, headers: corsHeaders() });
      }
      delete this.credentials[body.id];
      await this.state.storage.put("credentials", this.credentials);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders() });
    }

    if(body.action === "newChallenge"){
      const challenge = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
      this.challenges[challenge] = Date.now() + ADMIN_CHALLENGE_TTL_MS;
      const keys = Object.keys(this.challenges);
      if(keys.length > ADMIN_MAX_CHALLENGES){
        keys.sort((a, b) => this.challenges[a] - this.challenges[b]);
        for(const key of keys.slice(0, keys.length - ADMIN_MAX_CHALLENGES)){
          delete this.challenges[key];
        }
      }
      await this.state.storage.put("challenges", this.challenges);
      return new Response(JSON.stringify({ challenge }), { headers: corsHeaders() });
    }

    if(body.action === "takeChallenge"){
      const valid = Boolean(body.challenge && this.challenges[body.challenge] && this.challenges[body.challenge] >= Date.now());
      if(valid){
        delete this.challenges[body.challenge];
        await this.state.storage.put("challenges", this.challenges);
      }
      return new Response(JSON.stringify({ valid }), { headers: corsHeaders() });
    }

    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: corsHeaders() });
  }
}

function describeDevice(ua){
  const s = String(ua || "");
  let os = "不明なOS";
  if(/iPhone/.test(s)) os = "iPhone";
  else if(/iPad/.test(s)) os = "iPad";
  else if(/Android/.test(s)) os = "Android";
  else if(/Windows/.test(s)) os = "Windows";
  else if(/Mac OS X|Macintosh/.test(s)) os = "Mac";
  else if(/CrOS/.test(s)) os = "ChromeOS";
  else if(/Linux/.test(s)) os = "Linux";
  let browser = "不明なブラウザ";
  if(/Edg\//.test(s)) browser = "Edge";
  else if(/OPR\/|Opera/.test(s)) browser = "Opera";
  else if(/SamsungBrowser/.test(s)) browser = "Samsung Internet";
  else if(/Firefox|FxiOS/.test(s)) browser = "Firefox";
  else if(/Chrome|CriOS/.test(s)) browser = "Chrome";
  else if(/Safari/.test(s)) browser = "Safari";
  return `${os} / ${browser}`;
}

async function adminAuthCall(stub, payload){
  const res = await stub.fetch(new Request("https://internal/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
  return res.json();
}

function adminJson(data, status){
  return new Response(JSON.stringify(data), { status: status || 200, headers: corsHeaders() });
}

async function handlePasskeyAdmin(body, request, env, authStub){
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if(!env.ADMIN_RP_ID || !env.ADMIN_ORIGIN){
    return adminJson({ error: "passkey_not_configured" }, 500);
  }

  async function lockedResponse(){
    const lock = await adminAuthCall(authStub, { action: "checkLock", ip });
    if(lock.locked){
      return adminJson({ error: "locked", retryAfterSeconds: lock.retryAfterSeconds }, 429);
    }
    return null;
  }

  async function fail(){
    await adminAuthCall(authStub, { action: "recordFailure", ip });
    return adminJson({ error: "unauthorized" }, 401);
  }

  if(body.action === "authOptions"){
    const locked = await lockedResponse();
    if(locked) return locked;
    const list = await adminAuthCall(authStub, { action: "listCredentialIds" });
    if(list.ids.length === 0){
      return adminJson({ hasCredentials: false });
    }
    const issued = await adminAuthCall(authStub, { action: "newChallenge" });
    return adminJson({ hasCredentials: true, challenge: issued.challenge, rpId: env.ADMIN_RP_ID, allowCredentials: list.ids });
  }

  if(body.action === "login"){
    const locked = await lockedResponse();
    if(locked) return locked;
    try{
      const cred = body.credential;
      const clientDataBytes = b64urlDecode(cred.response.clientDataJSON);
      const clientData = parseClientData(clientDataBytes, "webauthn.get", env);
      if(!clientData) return fail();
      const taken = await adminAuthCall(authStub, { action: "takeChallenge", challenge: clientData.challenge });
      if(!taken.valid) return fail();
      const stored = await adminAuthCall(authStub, { action: "getCredential", id: cred.id });
      if(!stored.credential) return fail();
      const authData = b64urlDecode(cred.response.authenticatorData);
      const parsed = parseAuthData(authData);
      const expectedRpIdHash = await sha256(new TextEncoder().encode(env.ADMIN_RP_ID));
      if(!bytesEqual(parsed.rpIdHash, expectedRpIdHash)) return fail();
      if(!(parsed.flags & 0x01) || !(parsed.flags & 0x04)) return fail();
      const clientDataHash = await sha256(clientDataBytes);
      const signedData = concatBytes(authData, clientDataHash);
      const signature = b64urlDecode(cred.response.signature);
      const ok = await verifyAssertionSignature(stored.credential, signedData, signature);
      if(!ok) return fail();
      const previous = stored.credential.signCount || 0;
      if((previous !== 0 || parsed.signCount !== 0) && parsed.signCount <= previous) return fail();
      await adminAuthCall(authStub, { action: "updateSignCount", id: cred.id, signCount: parsed.signCount });
    }catch(e){
      return fail();
    }
    await adminAuthCall(authStub, { action: "resetAttempts", ip });
    const issued = await adminAuthCall(authStub, { action: "issue" });
    return adminJson({ token: issued.token });
  }

  if(body.action === "registerOptions" || body.action === "register"){
    let authorized = false;
    if(body.token){
      const verified = await adminAuthCall(authStub, { action: "verify", token: body.token });
      authorized = Boolean(verified.valid);
    }
    let viaSetup = false;
    if(!authorized){
      const locked = await lockedResponse();
      if(locked) return locked;
      const list = await adminAuthCall(authStub, { action: "listCredentialIds" });
      if(list.ids.length === 0 && env.ADMIN_SETUP_CODE && await secretEquals(body.setupCode, env.ADMIN_SETUP_CODE)){
        authorized = true;
        viaSetup = true;
      }
    }
    if(!authorized) return fail();

    if(body.action === "registerOptions"){
      const list = await adminAuthCall(authStub, { action: "listCredentialIds" });
      const issued = await adminAuthCall(authStub, { action: "newChallenge" });
      return adminJson({
        publicKey: {
          challenge: issued.challenge,
          rp: { id: env.ADMIN_RP_ID, name: "Simple Typing Admin" },
          user: { id: b64urlEncode(new TextEncoder().encode("admin")), name: "admin", displayName: "admin" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
          excludeCredentials: list.ids.map(id => ({ id })),
          attestation: "none",
          timeout: 60000
        }
      });
    }

    try{
      const cred = body.credential;
      const clientDataBytes = b64urlDecode(cred.response.clientDataJSON);
      const clientData = parseClientData(clientDataBytes, "webauthn.create", env);
      if(!clientData) return adminJson({ error: "invalid_credential" }, 400);
      const taken = await adminAuthCall(authStub, { action: "takeChallenge", challenge: clientData.challenge });
      if(!taken.valid) return adminJson({ error: "invalid_credential" }, 400);
      const attestation = cborDecode(b64urlDecode(cred.response.attestationObject), 0).value;
      const authData = attestation.get("authData");
      const parsed = parseAuthData(authData);
      const expectedRpIdHash = await sha256(new TextEncoder().encode(env.ADMIN_RP_ID));
      if(!bytesEqual(parsed.rpIdHash, expectedRpIdHash)) return adminJson({ error: "invalid_credential" }, 400);
      if(!(parsed.flags & 0x01) || !(parsed.flags & 0x04) || !(parsed.flags & 0x40)) return adminJson({ error: "invalid_credential" }, 400);
      let offset = 37 + 16;
      const credIdLength = (authData[offset] << 8) | authData[offset + 1];
      offset += 2;
      const credId = authData.slice(offset, offset + credIdLength);
      offset += credIdLength;
      const key = coseToCredentialKey(cborDecode(authData, offset).value);
      if(!key) return adminJson({ error: "unsupported_key" }, 400);
      const saved = await adminAuthCall(authStub, {
        action: "saveCredential",
        credential: {
          id: b64urlEncode(credId),
          alg: key.alg,
          jwk: key.jwk,
          signCount: parsed.signCount,
          createdAt: Date.now(),
          lastUsedAt: 0,
          label: describeDevice(request.headers.get("User-Agent"))
        }
      });
      if(saved.error) return adminJson({ error: saved.error }, 400);
    }catch(e){
      return adminJson({ error: "invalid_credential" }, 400);
    }

    if(viaSetup){
      const issued = await adminAuthCall(authStub, { action: "issue" });
      return adminJson({ ok: true, token: issued.token });
    }
    return adminJson({ ok: true });
  }

  return null;
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

  if(request.method === "POST"){
    const passkeyResponse = await handlePasskeyAdmin(body, request, env, authStub);
    if(passkeyResponse) return passkeyResponse;
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

  if(body.action === "listPasskeys"){
    const data = await adminAuthCall(authStub, { action: "listCredentials" });
    return new Response(JSON.stringify(data), { headers: corsHeaders() });
  }

  if(body.action === "deletePasskey"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteCredential", id: body.id })
    }));
    return new Response(await res.text(), { status: res.status, headers: corsHeaders() });
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
    const { enabled, month, combos, notice } = body;
    const eventId = env.EVENT_SETTINGS.idFromName("global");
    const eventStub = env.EVENT_SETTINGS.get(eventId);
    const res = await eventStub.fetch(new Request("https://internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", enabled, month, combos, notice })
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

  if(body.action === "presenceSnapshot"){
    if(!env.PRESENCE){
      return new Response(JSON.stringify({ error: "presence_not_configured" }), { status: 503, headers: corsHeaders() });
    }
    const presenceStub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
    const presenceRes = await presenceStub.fetch(new Request("https://internal/presence-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "snapshot" })
    }));
    return new Response(await presenceRes.text(), { headers: corsHeaders() });
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

    if(url.pathname === "/event-status"){
      if(request.method === "OPTIONS"){
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if(!env.EVENT_SETTINGS){
        return new Response(JSON.stringify({ enabled: false, month: "", combos: [], notice: "" }), { headers: corsHeaders() });
      }
      const eventId = env.EVENT_SETTINGS.idFromName("global");
      const eventStub = env.EVENT_SETTINGS.get(eventId);
      const eventRes = await eventStub.fetch(new Request("https://internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" })
      }));
      const eventData = await eventRes.json();
      const enabled = Boolean(eventData.enabled) && String(eventData.month || "") === getCurrentMonthJST();
      return new Response(JSON.stringify({
        enabled,
        month: String(eventData.month || ""),
        combos: enabled && Array.isArray(eventData.combos) ? eventData.combos : [],
        notice: enabled ? String(eventData.notice || "") : ""
      }), { headers: corsHeaders() });
    }

    if(url.pathname === "/auth"){
      return handleAuth(request, env);
    }

    if(url.pathname === "/playlog"){
      return handlePlayLog(request, env);
    }

    if(url.pathname === "/presence"){
      if(!env.PRESENCE){
        return new Response("presence not configured", { status: 503 });
      }
      const presenceStub = env.PRESENCE.get(env.PRESENCE.idFromName("global"));
      return presenceStub.fetch(request);
    }

    if(url.pathname === "/admin-presence"){
      return handleAdminPresence(request, env);
    }

    if(url.pathname === "/ranking"){
      const mode = url.searchParams.get("mode") || "hiragana";
      const level = url.searchParams.get("level") || "beginner";
      const force = url.searchParams.get("force") || "";
      const id = env.RANKING.idFromName(`${mode}:${level}`);
      const stub = env.RANKING.get(id);

      let eventEnabled = false;
      let eventMonth = "";
      let eventCombos = [];
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
        eventCombos = Array.isArray(eventData.combos) ? eventData.combos : [];
      }
      const eventActive = eventEnabled && eventMonth === getCurrentMonthJST() && eventCombos.includes(`${mode}:${level}`);

      if(request.method === "GET"){
        if(force === "event"){
          if(!eventActive){
            return new Response(JSON.stringify({ error: "no_event" }), { status: 409, headers: corsHeaders() });
          }
          const res = await stub.fetch(new Request("https://internal/ranking", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "getMonthRanking", month: eventMonth })
          }));
          const data = await res.json();
          return new Response(JSON.stringify({ scores: data.top20 || [], eventMode: true, month: eventMonth }), { headers: corsHeaders() });
        }
        if(force === "normal"){
          const res = await stub.fetch(request);
          const scores = await res.json();
          return new Response(JSON.stringify({ scores, eventMode: false, month: "" }), { headers: corsHeaders() });
        }
        if(eventActive){
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

      if(request.method === "POST" && (force === "event" || force === "normal")){
        if(force === "event" && !eventActive){
          return new Response(JSON.stringify({ error: "no_event" }), { status: 409, headers: corsHeaders() });
        }
        let body = {};
        try{
          body = await request.json();
        }catch(e){
          return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: corsHeaders() });
        }
        const forwardBody = force === "event"
          ? { ...body, __forceEvent: true, __eventMonth: eventMonth }
          : { ...body, __forceNormal: true };
        return stub.fetch(new Request(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(forwardBody)
        }));
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
