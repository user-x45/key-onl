const WORD_BANK = {
  hiragana: {
    beginner: ["たべる","ねこ","いぬ","さくら","つくえ","ほん","みず","はな","とり","やま","かわ","うみ","そら","くも","あめ","ゆき","はる","なつ","あき","ふゆ","いろ","おと","かぜ","こおり","きって","たまご","りんご","ばなな","めがね","くつした","とけい","かばん","えんぴつ","けしごむ","いす","まど","かぎ","ぼうし","てぶくろ","かがみ","はさみ","うさぎ","くま","とら","ぞう","きりん","さる","ぶた","うし","うま","ひつじ","にわとり","すずめ","からす","かに","たこ","さかな","くじら","かめ","へび"],
    intermediate: ["あさごはん","としょかん","どうぶつえん","おかあさん","おとうさん","きょうしつ","てんきよほう","おかしをたべる","がっこういく","でんしゃにのる","ほんをよむ","てがみをかく","にわのはな","おともだち","なつやすみ","ゆうびんきょく","びょういん","こうえんであそぶ","いぬとさんぽ","おふろにはいる","はをみがく","てをあらう","くつをはく","まどをあける","でんきをけす","ばすにのる","しゅくだいをする","えをかく","うたをうたう","ともだちとあそぶ"],
    advanced: ["おはようございます","ありがとうございます","よろしくおねがいします","きょうはいいてんきです","にほんごをべんきょうする","としょかんでほんをかりる","でんしゃがおくれています","せんせいにしつもんする","おかあさんがりょうりをつくる","なつやすみにうみへいく","おげんきですか","きょうはさむいですね","いっしょにいきましょう","おなまえはなんですか","にほんはとてもきれいです","まいにちうんどうをします","しゅくだいをおわらせました","でんわをかけてください","おみずをのみたいです","がっこうまでとおいです"]
  },
  kanji: {
    beginner: ["猫が窓辺で眠っている","駅前に新しい店ができた","明日は友達と映画を見る","父は毎朝新聞を読みます","週末に家族と旅行に行く","先生が黒板に字を書いた","夏休みに海へ泳ぎに行った","新しい本を図書館で借りた","庭に美しい花が咲いている","電車が定刻通りに到着した","母が朝ご飯を作ってくれた","子供が公園で遊んでいる","今日は天気がとても良い","彼は毎日学校へ行きます","姉は音楽を聞くのが好きだ","弟が自転車に乗っている","家の前に大きな木がある","朝早く起きて散歩をした","昨日友達に手紙を書いた","冬になると雪が降ります","父は会社で働いています","今年の夏はとても暑かった"],
    intermediate: ["公園で子供たちが遊んでいる","彼女は毎日日記をつけている","雨が降ってきたので傘をさす","料理を作るのが上手になった","駅から歩いて十分かかります","兄は大学で経済学を学んでいる","祖母が昔の写真を見せてくれた","新しい携帯電話を買いに行った","彼は将来医者になりたいと言っている","毎週日曜日に家族で買い物に行く","先週から新しい仕事を始めました","今朝は電車が混んでいて大変だった","弟は算数の宿題を一人でやり遂げた","姉は来月から海外へ留学する予定だ","祖父は庭で野菜を育てるのが趣味だ","彼女はピアノの練習を毎日続けている"],
    advanced: ["会社の会議は午後三時から始まる","来年の春に新しい学校へ入学する","友人と一緒に山に登る計画を立てた","毎朝早起きをして散歩をしています","日本語の勉強を一生懸命続けている","隣の家族が引っ越してきたと聞いた","台風の影響で電車が止まってしまった","図書館で静かに本を読む時間が好きだ","来週の日曜日に親戚が遊びに来る予定です","経済の状況が急速に変化していると専門家が指摘した","彼はどんな困難にも屈せずに努力を続けてきた","政府は新しい政策を来月から実施すると発表した","科学技術の発展によって生活は大きく便利になった","彼女は大学院で環境問題について研究している","長い交渉の末にようやく契約がまとまった","その事件については今も詳しい調査が続けられている","若者の間で健康志向がますます高まっている","地域社会のつながりを大切にする活動が広がっている"]
  }
};

function pickDeck(mode, level){
  const pool = (WORD_BANK[mode] && WORD_BANK[mode][level]) || WORD_BANK.hiragana.beginner;
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
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server, mode, level);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSocket(ws, mode, level){
    if(this.waiting){
      const partner = this.waiting;
      this.waiting = null;
      clearTimeout(partner.timeoutId);
      const matchId = crypto.randomUUID();
      try{
        partner.ws.send(JSON.stringify({ type: "matched", matchId, role: "p1" }));
        partner.ws.close(1000, "matched");
      }catch(e){}
      ws.send(JSON.stringify({ type: "matched", matchId, role: "p2" }));
      ws.close(1000, "matched");
      return;
    }

    const entry = { ws, mode, level, timeoutId: null };
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

  startMatch(){
    this.wordDeck = pickDeck(this.mode, this.level);
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

export default {
  async fetch(request, env){
    const url = new URL(request.url);

    if(url.pathname === "/lobby"){
      const mode = url.searchParams.get("mode") || "hiragana";
      const level = url.searchParams.get("level") || "beginner";
      const id = env.LOBBY.idFromName(`${mode}:${level}`);
      const stub = env.LOBBY.get(id);
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
