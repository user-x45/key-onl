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
        let monthRank = currentIndex !== -1 ? currentIndex + 1 : null;
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

const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_CHALLENGE_MAX = 1000;
const PASSKEY_DEFAULT_RP_ID = "s-typing.f5.si";
const PASSKEY_ALGS = [-7, -257];

function passkeyRpId(env){
  return env.PASSKEY_RP_ID || PASSKEY_DEFAULT_RP_ID;
}

function passkeyOrigin(env){
  return env.PASSKEY_ORIGIN || `https://${passkeyRpId(env)}`;
}

function bytesToB64url(bytes){
  let binary = "";
  for(let i = 0; i < bytes.length; i++){
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str){
  const base64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++){
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomB64url(length){
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToB64url(bytes);
}

function concatBytes(a, b){
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function derSignatureToRaw(der, size){
  let offset = 2;
  if(der[1] & 0x80) offset += der[1] & 0x7f;
  const readInt = () => {
    if(der[offset] !== 0x02) throw new Error("bad der");
    const len = der[offset + 1];
    let value = der.slice(offset + 2, offset + 2 + len);
    offset += 2 + len;
    while(value.length > size && value[0] === 0) value = value.slice(1);
    if(value.length > size) throw new Error("bad der");
    const padded = new Uint8Array(size);
    padded.set(value, size - value.length);
    return padded;
  };
  const r = readInt();
  const s = readInt();
  return concatBytes(r, s);
}

async function importPasskeyPublicKey(spkiB64url, alg){
  const spki = b64urlToBytes(spkiB64url);
  if(alg === -7){
    return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  }
  if(alg === -257){
    return crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  throw new Error("unsupported alg");
}

async function verifyPasskeySignature(credential, signature, signedData){
  const key = await importPasskeyPublicKey(credential.publicKey, credential.alg);
  if(credential.alg === -7){
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derSignatureToRaw(signature, 32), signedData);
  }
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
}

function parsePasskeyClientData(clientDataB64, expectedType, expectedChallenge, env){
  let bytes;
  let data;
  try{
    bytes = b64urlToBytes(clientDataB64);
    data = JSON.parse(new TextDecoder().decode(bytes));
  }catch(e){
    return null;
  }
  if(!data || data.type !== expectedType) return null;
  if(data.challenge !== expectedChallenge) return null;
  if(data.origin !== passkeyOrigin(env)) return null;
  if(data.crossOrigin === true) return null;
  return bytes;
}

async function parsePasskeyAuthData(authDataB64, env){
  let bytes;
  try{
    bytes = b64urlToBytes(authDataB64);
  }catch(e){
    return null;
  }
  if(bytes.length < 37) return null;
  const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passkeyRpId(env))));
  for(let i = 0; i < 32; i++){
    if(bytes[i] !== expectedHash[i]) return null;
  }
  const flags = bytes[32];
  if(!(flags & 0x01)) return null;
  const counter = ((bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36]) >>> 0;
  return { bytes, flags, counter };
}

function passkeyErrorResponse(message, status){
  return new Response(JSON.stringify({ error: message }), { status: status || 400, headers: corsHeaders() });
}

function hasOwn(obj, key){
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

export class UserAuth {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.users = null;
    this.sessions = null;
    this.pending = null;
    this.challenges = null;
    this.passkeys = null;
  }

  async load(){
    if(this.users && this.sessions && this.pending && this.challenges && this.passkeys) return;
    const stored = await this.state.storage.get(["users", "sessions", "pending", "challenges", "passkeys"]);
    this.users = stored.get("users") || {};
    this.sessions = stored.get("sessions") || {};
    this.pending = stored.get("pending") || {};
    this.challenges = stored.get("challenges") || {};
    this.passkeys = stored.get("passkeys") || {};
  }

  pruneExpired(){
    const now = Date.now();
    for(const token of Object.keys(this.sessions)){
      if(this.sessions[token].expires < now) delete this.sessions[token];
    }
    for(const token of Object.keys(this.pending)){
      if(this.pending[token].expires < now) delete this.pending[token];
    }
    for(const id of Object.keys(this.challenges)){
      if(this.challenges[id].expires < now) delete this.challenges[id];
    }
  }

  async resolveLogin(sub){
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

  async consumeChallenge(challengeId, type){
    if(!hasOwn(this.challenges, challengeId)) return null;
    const entry = this.challenges[challengeId];
    delete this.challenges[challengeId];
    await this.state.storage.put("challenges", this.challenges);
    if(entry.type !== type || entry.expires < Date.now()) return null;
    return entry;
  }

  async passkeyOptions(type){
    if(type !== "register" && type !== "login"){
      return passkeyErrorResponse("invalid type");
    }
    const challenge = randomB64url(32);
    const challengeId = crypto.randomUUID();
    const entry = { type, challenge, expires: Date.now() + PASSKEY_CHALLENGE_TTL_MS };
    const rpId = passkeyRpId(this.env);
    let options;
    if(type === "register"){
      const userHandle = randomB64url(16);
      entry.userHandle = userHandle;
      options = {
        rp: { name: "シンプルタイピング", id: rpId },
        user: { id: userHandle, name: `player-${userHandle.slice(0, 6)}`, displayName: "シンプルタイピング" },
        challenge,
        pubKeyCredParams: PASSKEY_ALGS.map(alg => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
        attestation: "none",
        timeout: 60000
      };
    } else {
      options = { challenge, rpId, userVerification: "preferred", timeout: 60000 };
    }
    this.challenges[challengeId] = entry;
    const ids = Object.keys(this.challenges);
    for(let i = 0; i < ids.length - PASSKEY_CHALLENGE_MAX; i++){
      delete this.challenges[ids[i]];
    }
    await this.state.storage.put("challenges", this.challenges);
    return new Response(JSON.stringify({ challengeId, options }), { headers: corsHeaders() });
  }

  async passkeyRegister(body){
    const entry = await this.consumeChallenge(body.challengeId, "register");
    if(!entry) return passkeyErrorResponse("invalid challenge", 401);
    const c = body.credential || {};
    if(typeof c.id !== "string" || !parsePasskeyClientData(c.clientDataJSON, "webauthn.create", entry.challenge, this.env)){
      return passkeyErrorResponse("invalid credential", 401);
    }
    const auth = await parsePasskeyAuthData(c.authenticatorData, this.env);
    if(!auth || !(auth.flags & 0x40) || auth.bytes.length < 55){
      return passkeyErrorResponse("invalid credential", 401);
    }
    const idLength = (auth.bytes[53] << 8) | auth.bytes[54];
    const credIdBytes = auth.bytes.slice(55, 55 + idLength);
    const credentialId = bytesToB64url(credIdBytes);
    if(idLength === 0 || credentialId !== c.id){
      return passkeyErrorResponse("invalid credential", 401);
    }
    const alg = Number(c.publicKeyAlgorithm);
    if(!PASSKEY_ALGS.includes(alg) || typeof c.publicKey !== "string"){
      return passkeyErrorResponse("unsupported algorithm", 400);
    }
    try{
      await importPasskeyPublicKey(c.publicKey, alg);
    }catch(e){
      return passkeyErrorResponse("invalid public key", 400);
    }
    if(hasOwn(this.passkeys, credentialId)){
      return passkeyErrorResponse("already registered", 409);
    }
    const sub = `passkey:${entry.userHandle}`;
    this.passkeys[credentialId] = { sub, publicKey: c.publicKey, alg, counter: auth.counter, createdAt: Date.now() };
    await this.state.storage.put("passkeys", this.passkeys);
    return this.resolveLogin(sub);
  }

  async passkeyLogin(body){
    const entry = await this.consumeChallenge(body.challengeId, "login");
    if(!entry) return passkeyErrorResponse("invalid challenge", 401);
    const c = body.credential || {};
    if(!hasOwn(this.passkeys, c.id)) return passkeyErrorResponse("unknown credential", 401);
    const stored = this.passkeys[c.id];
    const clientBytes = parsePasskeyClientData(c.clientDataJSON, "webauthn.get", entry.challenge, this.env);
    if(!clientBytes) return passkeyErrorResponse("invalid credential", 401);
    const auth = await parsePasskeyAuthData(c.authenticatorData, this.env);
    if(!auth) return passkeyErrorResponse("invalid credential", 401);
    let valid = false;
    try{
      const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientBytes));
      valid = await verifyPasskeySignature(stored, b64urlToBytes(c.signature), concatBytes(auth.bytes, clientHash));
    }catch(e){
      valid = false;
    }
    if(!valid) return passkeyErrorResponse("invalid signature", 401);
    if((auth.counter !== 0 || stored.counter !== 0) && auth.counter <= stored.counter){
      return passkeyErrorResponse("invalid counter", 401);
    }
    stored.counter = auth.counter;
    await this.state.storage.put("passkeys", this.passkeys);
    return this.resolveLogin(stored.sub);
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
      return this.resolveLogin(body.sub);
    }

    if(body.action === "passkeyOptions"){
      return this.passkeyOptions(body.type);
    }

    if(body.action === "passkeyRegister"){
      return this.passkeyRegister(body);
    }

    if(body.action === "passkeyLogin"){
      return this.passkeyLogin(body);
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
      for(const id of Object.keys(this.passkeys)){
        if(this.passkeys[id].sub === sub) delete this.passkeys[id];
      }
      await this.state.storage.put("users", this.users);
      await this.state.storage.put("sessions", this.sessions);
      await this.state.storage.put("passkeys", this.passkeys);
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

  if(body.action === "passkeyOptions"){
    const res = await authStub.fetch(new Request("https://internal/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "passkeyOptions", type: body.type })
    }));
    return new Response(await res.text(), { status: res.status, headers: corsHeaders() });
  }

  if(body.action === "login"){
    if(body.provider === "passkey"){
      const res = await authStub.fetch(new Request("https://internal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: body.passkeyType === "register" ? "passkeyRegister" : "passkeyLogin",
          challengeId: body.challengeId,
          credential: body.credential
        })
      }));
      return new Response(await res.text(), { status: res.status, headers: corsHeaders() });
    }

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
