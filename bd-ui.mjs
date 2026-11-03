#!/usr/bin/env node
// Backpack Dungeon trainer UI (Plan B)
//   node bd-ui.mjs
//   open http://127.0.0.1:8787
//
// Requires the game launched with --remote-debugging-port=9222

import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scoreLayout } from './layout-lib.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const LAYOUT_FILE = fileURLToPath(new URL('./layout.json', import.meta.url));
const PLAN_FILE = fileURLToPath(new URL('./plan.json', import.meta.url));
const BACKUP_FILE = fileURLToPath(new URL('./layout-backup.json', import.meta.url));
const BACKUP_ORIG_FILE = fileURLToPath(new URL('./layout-backup-orig.json', import.meta.url));
const ITEMDB_FILE = fileURLToPath(new URL('./itemdb.json', import.meta.url));

let ITEM_NAMES = {};
try {
  const list = JSON.parse(fs.readFileSync(new URL('./items.json', import.meta.url), 'utf8'));
  for (const it of list) ITEM_NAMES[it.id] = it.name;
} catch {}
let ITEMDB = {};
try {
  ITEMDB = JSON.parse(fs.readFileSync(new URL('./itemdb.json', import.meta.url), 'utf8')).items || {};
} catch {}

const CDP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const PORT = Number(process.env.BD_UI_PORT || 8787);
const BUNDLE = process.env.BD_BUNDLE || fileURLToPath(new URL('./idx.js', import.meta.url));

/* ---------- CDP ---------- */
async function withCDP(fn) {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('找不到游戏页面（是否用 --remote-debugging-port=9222 启动？）');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const events = [];
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 15000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  try { await send('Runtime.enable'); return await fn({ send, evalJs, events }); }
  finally { try { ws.close(); } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 布局工具 ---------- */
const LAYOUT_JS = `(()=>{const P=(window.__bd_pinia||(window.__bd_pinia=(()=>{const el=document.querySelector('#app');const app=el&&el.__vue_app__;if(!app)return null;for(const k of Reflect.ownKeys(app._context.provides)){const v=app._context.provides[k];if(v&&typeof v==='object'&&'_s' in v&&'state' in v)return v;}return null;})()));const s=P.state.value;return {gameState:s.gameFlow.gameState,items:s.player.items.map(i=>({uid:i.uid,id:i.id,x:i.x,y:i.y,rot:i.rotation||0})),bags:s.player.bags.map(b=>({id:b.id,x:b.x,y:b.y,rot:b.rotation||0}))};})()`;

const WRITE_JS = req => `(()=>{const P=(window.__bd_pinia||(window.__bd_pinia=(()=>{const el=document.querySelector('#app');const app=el&&el.__vue_app__;if(!app)return null;for(const k of Reflect.ownKeys(app._context.provides)){const v=app._context.provides[k];if(v&&typeof v==='object'&&'_s' in v&&'state' in v)return v;}return null;})()));const s=P.state.value;
if(s.gameFlow.gameState==='battle')return {error:'in_battle'};
const plan=${JSON.stringify(req)};const byUid=new Map(s.player.items.map(i=>[i.uid,i]));const done=[],missing=[];
for(const p of plan){const it=byUid.get(p.uid);if(!it){missing.push(p.uid);continue;}it.x=p.x;it.y=p.y;it.rotation=p.rot;done.push(p.uid);}
return {done:done.length,missing:missing.length};})()`;

function layoutMetrics(d) {
  const r = scoreLayout(ITEMDB, d);
  return {
    items: r.totals.items,
    hits: r.totals.totalTriggerHits,
    onTrack: r.totals.ballTriggerOnTrack + '/' + r.totals.ballTriggerItems,
    bows: r.totals.bowsWithAmmo + '/' + r.totals.bows,
    ammo: r.totals.ammoLoaded + '/' + r.totals.ammoSlots,
    deadArrows: r.totals.deadArrows,
    stars: r.totals.starSatisfied + '/' + r.totals.starPoints,
    fill: Math.round(r.totals.fillRate * 100),
    overlaps: r.warnings.overlaps.length,
    outside: r.warnings.outside.length,
  };
}

function diffMoves(before, after) {
  const B = new Map(before.map(i => [i.uid, i]));
  const out = [];
  for (const a of after) {
    const b = B.get(a.uid);
    if (!b) continue;
    if (b.x !== a.x || b.y !== a.y || (b.rot || 0) !== (a.rot || 0)) {
      out.push({ id: a.id, from: `${b.x},${b.y},r${b.rot || 0}`, to: `${a.x},${a.y},r${a.rot || 0}` });
    }
  }
  return out;
}

function runNode(args, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, args, { cwd });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', c => c === 0 ? res(out) : rej(new Error(err || out || ('exit ' + c))));
  });
}

const ENFORCE_JS = `(()=>{
  const t=window.__bdm; if(!t) return {ok:false,error:'no __bdm'};
  window.__bd = Object.assign({godHp:false,infStam:false,goldMul:1,dmgPct:0,ballSpeed:0,loopTime:0,hpTarget:0,stamTarget:0,manaTarget:0,hpOnce:false,stamOnce:false,manaFill:false,statusTarget:0,statusLocks:{}}, window.__bd||{});
  const apply=()=>{
    const m=window.__bdm,b=window.__bd; if(!m||!b) return;
    if(b.hpTarget>0){
      if(b.hpOnce){ m.playerMaxHp=b.hpTarget; m.playerHp=b.hpTarget; b.hpOnce=false; }
    }
    else if(b.godHp){m.playerHp=m.playerMaxHp;}
    if(b.stamTarget>0){
      if(b.stamOnce){ m.playerMaxStamina=b.stamTarget; m.playerStamina=b.stamTarget; b.stamOnce=false; }
    }
    else if(b.infStam){m.playerStamina=m.playerMaxStamina;}
    if(b.manaTarget>0&&m.playerStatusManager){
      if(b.manaFill){ try{m.playerStatusManager.setStatus('mana',b.manaTarget);}catch(e){} b.manaFill=false; }
    }\n    if(m.playerStatusManager){
      try{const ps=m.playerStatusManager;
        const locks=b.statusLocks||{};
        for(const s of ['armor','strength','frenzy','regeneration','mana','vitality','thorns']){
          const L=locks[s];
          let target=0;
          if(L&&L.on) target=Number(L.value)||0;
          else if(b.statusTarget>0) target=b.statusTarget;
          if(target>0&&ps.getStatusStacks(s)<target) ps.setStatus(s,target);
        }
      }catch(e){}
    }
    if(b.ballSpeed>0&&m.ballManager){
      if(typeof m.ballManager.setBaseSpeed==='function') m.ballManager.setBaseSpeed(b.ballSpeed);
      else m.ballManager.baseSpeed=b.ballSpeed;
    }
    if(b.loopTime>0&&m.ballManager){
      m.ballManager.minLoopTimeSeconds=b.loopTime;
    }
  };
  window.__bdApply=apply;
  if(window.__bdTimer) clearInterval(window.__bdTimer);
  window.__bdTimer=setInterval(function(){ try{ window.__bdApply&&window.__bdApply(); }catch(e){} },16);
  if(!t.__bdHooked){
    t.__bdHooked=true;
    const o=t.startBattle;
    t.startBattle=function(...a){const r=o.apply(this,a);try{window.__bdApply&&window.__bdApply();}catch(e){}return r;};
  }
  if(!t.__bdDamageWrapped){
    t.__bdDamageWrapped=true;
    for(const n of ['dealDamageToEnemy','dealDamageToAllEnemies','dealDamageToRandomEnemy']){
      const orig=t[n]; if(typeof orig!=='function') continue;
      t[n]=function(dmg,...rest){
        try{const b=window.__bd; if(b&&b.dmgPct>0&&typeof dmg==='number') dmg=dmg*(1+b.dmgPct/100);}catch(e){}
        return orig.call(this,dmg,...rest);
      };
    }
  }
  if(!t.__bdMiscWrapped){
    t.__bdMiscWrapped=true;
    const bm2=t.ballManager;
    if(bm2&&!bm2.__bdSpeedWrapped&&typeof bm2.getCurrentSpeed==='function'){
      const oc=bm2.getCurrentSpeed;
      bm2.getCurrentSpeed=function(){const b=window.__bd;if(b&&b.ballSpeed>0)return b.ballSpeed;return oc.call(this);};
      bm2.__bdSpeedWrapped=true;
    }
  }
  if(t.ballManager){
    const bp=Object.getPrototypeOf(t.ballManager);
    if(bp&&!bp.__bdLoopPatched&&typeof bp.setMinLoopTimeSeconds==='function'){
      bp.__bdLoopPatched=true;
      const os=bp.setMinLoopTimeSeconds;
      bp.setMinLoopTimeSeconds=function(s){
        const b=window.__bd||{};
        if(Number(b.loopTime)>0) return;
        return os.call(this,s);
      };
    }
  }
  {
    const P=window.__bd_pinia;
    const st=P&&P._s&&P._s.get?P._s.get('player'):null;
    if(st&&!st.__bdGoldWatch&&typeof st.$subscribe==='function'){
      st.__bdGoldWatch=true;
      const b=window.__bd; b.__goldPrev=st.gold||0;
      st.$subscribe(function(mut,state){
        const bb=window.__bd; if(!bb) return;
        const now=Number(state.gold)||0;
        if(bb.__goldGuard){ bb.__goldPrev=now; return; }
        const prev=Number(bb.__goldPrev)||0;
        bb.__goldPrev=now;
        const mul=Number(bb.goldMul)||1;
        if(mul>1&&now>prev){
          const add=(now-prev)*(mul-1);
          if(add>0){ bb.__goldGuard=true; try{ state.gold=now+add; bb.__goldPrev=now+add; } finally{ bb.__goldGuard=false; } }
        }
      });
    }
    // 清理旧版本遗留的回调包装（避免与监听器重复放大）
    const proto=Object.getPrototypeOf(t);
    if(proto&&proto.__bdGoldPatched){
      proto.setOnGoldChange=function(cb){ this.onGoldChangeCallback=cb; };
      try{ delete proto.__bdGoldPatched; }catch(e){ proto.__bdGoldPatched=false; }
    }
    if(typeof t.onGoldChangeCallback==='function'&&String(t.onGoldChangeCallback).indexOf('goldMul')>=0){
      const s=window.__bd_pinia&&window.__bd_pinia.state.value;
      t.onGoldChangeCallback=function(amount){
        const pl=s&&s.player; if(!pl) return;
        pl.gold=Math.max(0,(Number(pl.gold)||0)+Number(amount||0));
      };
    }
  }
  apply();
  return {ok:true,flags:window.__bd,timer:!!window.__bdTimer,damageWrapped:!!t.__bdDamageWrapped,
          speedWrapped:!!(t.ballManager&&t.ballManager.__bdSpeedWrapped),goldCbWrapped:!!t.__bdCbWrapped||!!t.__goldCbWrapped};
})()`;

const STATUS_JS = `(()=>{const t=window.__bdm;
  let P=window.__bd_pinia;
  if(!P){try{const el=document.querySelector('#app');const app=el&&el.__vue_app__;
    if(app){for(const k of Reflect.ownKeys(app._context.provides)){const v=app._context.provides[k];
      if(v&&typeof v==='object'&&'_s' in v&&'state' in v){P=v;window.__bd_pinia=v;break;}}}}catch(e){}}
  const store=(P&&P.state&&P.state.value&&P.state.value.player)||{};
  if(!t) return {ok:false, serverConnected:true, storeGold:store.gold};
  return {ok:true, hp:t.playerHp, maxHp:t.playerMaxHp, stamina:t.playerStamina, maxStamina:t.playerMaxStamina,
    gold:t.playerGold, storeGold:store.gold, mana:t.playerStatusManager?t.playerStatusManager.getStatusStacks('mana'):null,
    armorStacks:t.playerStatusManager?t.playerStatusManager.getStatusStacks('armor'):null,
    ballSpeed:t.ballManager&&t.ballManager.getCurrentSpeed&&t.ballManager.getCurrentSpeed(),
    enemies:t.enemyManagers?t.enemyManagers.length:0, flags:window.__bd||null,
    wrapped:{dmg:!!t.__bdDamageWrapped, speed:!!(t.ballManager&&t.ballManager.__bdSpeedWrapped),
             goldCb:!!t.__goldCbWrapped, hook:!!t.__bdHooked}};})()`;

/* ---------- capture ---------- */
async function capture(timeoutSec = 20) {
  const fs = await import('node:fs');
  const text = fs.readFileSync(BUNDLE, 'utf8');
  const mk = name => {
    const re = new RegExp(`\\n\\s*${name}\\s*\\(`, 'g');
    const hits = []; let m;
    while ((m = re.exec(text))) {
      const off = m.index + (m[0].length - m[0].trimStart().length);
      hits.push({ line: text.slice(0, off).split('\n').length - 1, col: off - (text.lastIndexOf('\n', off) + 1) });
    }
    return hits;
  };
  const candidates = [['updateState', mk('updateState')], ['startBattle', mk('startBattle')]]
    .filter(([, h]) => h.length);
  if (!candidates.length) throw new Error('bundle 中找不到目标方法');
  const [name, hits] = candidates[0];
  const loc = hits[hits.length - 1];

  return withCDP(async ({ send, events, evalJs }) => {
    await send('Debugger.enable');
    let scriptUrl = null;
    for (let i = 0; i < 60 && !scriptUrl; i++) {
      for (const e of events) if (e.method === 'Debugger.scriptParsed' && /index-.{6,}\.js/.test(e.params.url || '')) scriptUrl = e.params.url;
      if (!scriptUrl) await sleep(80);
    }
    if (!scriptUrl) { await send('Debugger.disable'); throw new Error('找不到渲染层 bundle'); }
    const bp = await send('Debugger.setBreakpointByUrl', { lineNumber: loc.line, columnNumber: loc.col, url: scriptUrl });
    const deadline = Date.now() + timeoutSec * 1000;
    let paused = null;
    while (Date.now() < deadline && !paused) {
      paused = events.find(e => e.method === 'Debugger.paused');
      if (!paused) await sleep(80);
    }
    if (!paused) {
      try { await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId }); } catch {}
      await send('Debugger.disable');
      throw new Error(`断点 ${timeoutSec}s 内未命中 —— 请先进入一场战斗`);
    }
    const frame = paused.params.callFrames[0];
    const r = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `(()=>{const t=this;if(!t||t.playerHp===undefined)return {ok:false};
        window.__bdm=t;return {ok:true,hp:t.playerHp,maxHp:t.playerMaxHp};})()`,
      returnByValue: true,
    });
    await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });
    await send('Debugger.resume');
    await send('Debugger.disable');
    const v = r.result?.value;
    if (!v || !v.ok) throw new Error('命中的不是 BattleManager');
    return v;
  });
}

const TRIG_START_JS = `(()=>{const t=window.__bdm;if(!t)return {ok:false,error:'no __bdm'};
  window.__bdTrig={};window.__bdTrigStartLoop=(function(){const P=window.__bd_pinia;
    return (P&&P.state.value.gameFlow.battleState&&P.state.value.gameFlow.battleState.loopCount)||0;})();
  if(!t.__bdTrigHooked){
    t.__bdTrigHooked=true;
    const o=t.handleItemTriggered;
    t.handleItemTriggered=function(uid,triggerSide,opts){
      try{const d=window.__bdTrig;
        const P=window.__bd_pinia;const bs=P&&P.state.value.gameFlow.battleState;
        const loop=(bs&&bs.loopCount)||0;
        const e=d[uid]||(d[uid]={n:0,firstLoop:loop,lastLoop:loop,sides:{}});
        e.n++;e.lastLoop=loop;
        const s=(opts&&opts.counterSourceType)||String(triggerSide||'?');
        e.sides[s]=(e.sides[s]||0)+1;
      }catch(err){}
      return o.apply(this,arguments);
    };
  }
  return {ok:true,startLoop:window.__bdTrigStartLoop};})()`;

const TRIG_REPORT_JS = `(()=>{const t=window.__bdm;const d=window.__bdTrig||{};
  const P=window.__bd_pinia;const st=P&&P.state.value;
  const bs=st&&st.gameFlow&&st.gameFlow.battleState;
  const loop=(bs&&bs.loopCount)||0;
  const items=((st&&st.player&&st.player.items)||[]).map(i=>({uid:i.uid,id:i.id,x:i.x,y:i.y,type:i.type}));
  const relics=((st&&st.player&&st.player.relics)||[]).map(i=>({uid:i.uid,id:i.id,type:i.type}));
  return {startLoop:window.__bdTrigStartLoop||0,loop,items,relics,trig:d,
          hooked:!!t.__bdTrigHooked};})()`;

/* ---------- actions ---------- */
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));

async function runAction(name, q) {
  switch (name) {
    case 'capture':
      return capture(num(q.timeout, 20));
    case 'enforce':
      return withCDP(async ({ evalJs }) => evalJs(ENFORCE_JS));
    case 'status':
      return withCDP(async ({ evalJs }) => Object.assign({ serverConnected: true }, await evalJs(STATUS_JS)));
    case 'god': {
      const on = q.value === '1';
      return withCDP(async ({ evalJs }) => { await evalJs(ENFORCE_JS); return evalJs(`(()=>{window.__bd.godHp=${on};window.__bd.hpTarget=0;window.__bdApply&&window.__bdApply();return window.__bd;})()`); });
    }
    case 'infstam': {
      const on = q.value === '1';
      return withCDP(async ({ evalJs }) => { await evalJs(ENFORCE_JS); return evalJs(`(()=>{window.__bd.infStam=${on};window.__bd.stamTarget=0;window.__bdApply&&window.__bdApply();return window.__bd;})()`); });
    }
    case 'hp': {
      const max = num(q.max, 0);
      return withCDP(async ({ evalJs }) => {
        await evalJs(ENFORCE_JS);
        if (max <= 0) return evalJs(`(()=>{const b=window.__bd;b.godHp=false;b.hpTarget=0;b.hpOnce=false;return {hpTarget:0};})()`);
        return evalJs(`(()=>{const P=window.__bd_pinia,st=P&&P.state.value,t=window.__bdm,b=window.__bd;
b.godHp=false;b.hpTarget=${max};b.hpOnce=true;b.hpStore=${max};
if(st&&st.player){st.player.playerMaxHealth=${max};st.player.playerHealth=${max};}
window.__bdApply&&window.__bdApply();
return {hp:t?t.playerHp:null,maxHp:t?t.playerMaxHp:null,storeMax:st?st.player.playerMaxHealth:null};})()`);
      });
    }
    case 'stam': {
      const max = num(q.max, 0);
      return withCDP(async ({ evalJs }) => {
        await evalJs(ENFORCE_JS);
        if (max <= 0) return evalJs(`(()=>{const b=window.__bd;b.infStam=false;b.stamTarget=0;b.stamOnce=false;b.stamStore=0;return {stamTarget:0};})()`);
        return evalJs(`(()=>{const P=window.__bd_pinia,st=P&&P.state.value,t=window.__bdm,b=window.__bd;
b.infStam=false;b.stamTarget=${max};b.stamOnce=true;b.stamStore=${max};
if(st&&st.player){const cur=st.player.playerMaxStamina||0;const d=${max}-cur;if(d!==0)st.player.goldSpendMaxStaminaBonus=(st.player.goldSpendMaxStaminaBonus||0)+d;st.player.playerMaxStamina=${max};}
window.__bdApply&&window.__bdApply();
return {stamina:t?t.playerStamina:null,maxStamina:t?t.playerMaxStamina:null,storeMax:st?st.player.playerMaxStamina:null,bonus:st?st.player.goldSpendMaxStaminaBonus:null};})()`);
      });
    }
    case 'dmg': {
      const pct = num(q.value, 900);
      return withCDP(async ({ evalJs }) => { await evalJs(ENFORCE_JS); return evalJs(`(()=>{window.__bd.dmgPct=${pct};return {dmgPct:window.__bd.dmgPct};})()`); });
    }
    case 'ball': {
      const speed = num(q.value, 12);
      return withCDP(async ({ evalJs }) => { await evalJs(ENFORCE_JS); return evalJs(`(()=>{window.__bd.ballSpeed=${speed};window.__bdApply&&window.__bdApply();const bm=window.__bdm.ballManager;return {ballSpeed:window.__bd.ballSpeed,current:bm.getCurrentSpeed(),max:bm.getMaxAllowedSpeed()};})()`); });
    }
    case 'looptime': {
      const v = Number(q.value) || 0;
      return withCDP(async ({ evalJs }) => {
        await evalJs(ENFORCE_JS);
        return evalJs(`(()=>{const b=window.__bd,m=window.__bdm;if(!m||!m.ballManager)return {error:'no ballManager'};
          const bm=m.ballManager;
          if(${v}>0){ if(!(b.__loopOrig>0)) b.__loopOrig=Number(bm.minLoopTimeSeconds)||2; b.loopTime=${v}; bm.minLoopTimeSeconds=${v}; }
          else { b.loopTime=0; if(b.__loopOrig>0){ bm.minLoopTimeSeconds=b.__loopOrig; b.__loopOrig=0; } }
          return {loopTime:b.loopTime,minLoop:bm.minLoopTimeSeconds,maxSpeed:(bm.trackPath&&bm.trackPath.length?bm.trackPath.length/bm.minLoopTimeSeconds:null)};})()`);
      });
    }
    case 'gold': {
      const mul = num(q.value, 5);
      return withCDP(async ({ evalJs }) => { await evalJs(ENFORCE_JS); return evalJs(`(()=>{window.__bd.goldMul=${mul};return {goldMul:window.__bd.goldMul};})()`); });
    }
    case 'mana': {
      const v = num(q.value, 50);
      return withCDP(async ({ evalJs }) => {
        await evalJs(ENFORCE_JS);
        return evalJs(`(()=>{const b=window.__bd;b.manaTarget=${v};b.manaFill=false;const ps=window.__bdm&&window.__bdm.playerStatusManager;if(ps&&${v}>0){try{ps.setStatus('mana',${v});}catch(e){}}return {manaTarget:b.manaTarget,mana:ps?ps.getStatusStacks('mana'):null};})()`);
      });
    }
    case 'statuses': {
      const v = num(q.value, 99);
      return withCDP(async ({ evalJs }) => { await evalJs(ENFORCE_JS); return evalJs(`(()=>{window.__bd.statusTarget=${v};window.__bdApply&&window.__bdApply();
        const ps=window.__bdm.playerStatusManager;const out={};
        for(const s of ['armor','strength','frenzy','regeneration','mana','vitality','thorns']) out[s]=ps.getStatusStacks(s);
        return {statusTarget:window.__bd.statusTarget, stacks:out};})()`); });
    }
    case 'trigstart':
      return withCDP(async ({ evalJs }) => evalJs(TRIG_START_JS));
    case 'trigreport': {
      const raw = await withCDP(async ({ evalJs }) => evalJs(TRIG_REPORT_JS));
      if (!raw || !raw.hooked) return { ok: false, error: '未安装触发统计（先进入战斗并点开始统计）' };
      const loops = Math.max(0, raw.loop - raw.startLoop);
      const nameById = ITEM_NAMES;
      const rows = [];
      const seen = new Set();
      const push = (it, kind) => {
        if (seen.has(it.uid)) return;
        seen.add(it.uid);
        const t = raw.trig[it.uid];
        const n = t ? t.n : 0;
        const meta = ITEMDB[it.id] || null;
        const cls = meta ? meta.cls : 'unknown';
        let note;
        if (n === 0) {
          if (cls === 'ball') note = '白放：需要球扫到却没触发';
          else if (cls === 'medium') note = '需弓/投掷物触发，自身不必在球路';
          else if (cls === 'passive') note = '被动/开战生效，正常';
          else if (cls === 'static') note = '常驻属性，正常';
          else note = '未知类型';
        } else {
          if (cls === 'ball') note = '球触发';
          else if (cls === 'medium') note = '被弓/投掷物触发';
          else if (cls === 'passive') note = '被动+触发';
          else note = '被触发';
        }
        if (meta && meta.positional) note += ' · ☆位置需求';
        rows.push({
          uid: it.uid, id: it.id, name: nameById[it.id] || it.id, kind, cls, note,
          pos: it.x !== undefined ? `${it.x},${it.y}` : '-',
          triggers: n,
          perLoop: loops > 0 ? Math.round((n / loops) * 100) / 100 : null,
          markers: meta ? meta.markers : null,
          sides: t ? t.sides : {},
        });
      };
      for (const it of raw.items) push(it, '装备');
      for (const it of raw.relics) push(it, '遗物');
      rows.sort((a, b) => b.triggers - a.triggers);
      const wasted = rows.filter(r => r.triggers === 0 && r.cls === 'ball');
      const okIdle = rows.filter(r => r.triggers === 0 && r.cls !== 'ball');
      return {
        ok: true, loops, totalItems: rows.length,
        triggered: rows.length - wasted.length - okIdle.length,
        wastedCount: wasted.length, okIdleCount: okIdle.length,
        rows,
        wasted: wasted.map(r => `${r.name}(${r.id}) @${r.pos}`),
        okIdle: okIdle.map(r => `${r.name}(${r.id}) · ${r.note}`),
      };
    }
    case 'statlock': {
      const s = String(q.status || '');
      const on = q.on === '1' || q.on === 'true';
      const v = num(q.value, 0);
      const POS = ['armor','strength','frenzy','regeneration','mana','vitality','thorns'];
      if (!POS.includes(s)) throw new Error('unknown status ' + s);
      return withCDP(async ({ evalJs }) => {
        await evalJs(ENFORCE_JS);
        return evalJs(`(()=>{const b=window.__bd;b.statusTarget=0;b.statusLocks=b.statusLocks||{};b.statusLocks[${JSON.stringify(s)}]={on:${on},value:${v}};const ps=window.__bdm&&window.__bdm.playerStatusManager;if(ps){try{if(${on}){if(ps.getStatusStacks(${JSON.stringify(s)})<${v})ps.setStatus(${JSON.stringify(s)},${v});}else{ps.setStatus(${JSON.stringify(s)},${v});}}catch(e){}}window.__bdApply&&window.__bdApply();return {locks:b.statusLocks,stacks:ps?ps.getStatusStacks(${JSON.stringify(s)}):null};})()`);
      });
    }
    case 'statlocks': {
      return withCDP(async ({ evalJs }) => evalJs(`(()=>{const r={locks:(window.__bd&&window.__bd.statusLocks)||{},stacks:{}};const m=window.__bdm;if(m&&m.playerStatusManager){for(const s of ['armor','strength','frenzy','regeneration','mana','vitality','thorns'])r.stacks[s]=m.playerStatusManager.getStatusStacks(s);}return r;})()`));
    }
    case 'layoutstatus': {
      const d = await withCDP(({ evalJs }) => evalJs(LAYOUT_JS));
      return { gameState: d.gameState, metrics: layoutMetrics(d) };
    }
    case 'layoutsolve': {
      const d = await withCDP(({ evalJs }) => evalJs(LAYOUT_JS));
      if (d.gameState === 'battle') throw new Error('战斗中不能求解，请先结束战斗');
      fs.writeFileSync(LAYOUT_FILE, JSON.stringify(d, null, 1));
      const t0 = Date.now();
      await runNode(['solve.mjs', LAYOUT_FILE, ITEMDB_FILE,
        '--restarts=' + (q.restarts || 40), '--iters=' + (q.iters || 2000),
        '--penalty=' + (q.penalty || 0.4), '--deadpen=120'], DIR);
      const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
      const merged = { ...d, items: plan.items };
      return { ms: Date.now() - t0, moves: diffMoves(d.items, plan.items), before: layoutMetrics(d), after: layoutMetrics(merged) };
    }
    case 'layoutapply': {
      if (!fs.existsSync(PLAN_FILE)) throw new Error('没有 plan.json，请先求解');
      const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
      const live = await withCDP(({ evalJs }) => evalJs(LAYOUT_JS));
      if (live.gameState === 'battle') throw new Error('战斗中不能写入，请先结束战斗');
      const liveUids = new Set(live.items.map(i => i.uid));
      const planUids = new Set(plan.items.map(i => i.uid));
      const extra = [...liveUids].filter(u => !planUids.has(u)).length;
      const gone = [...planUids].filter(u => !liveUids.has(u)).length;
      if (extra || gone) throw new Error(`计划与当前布局不匹配（多 ${extra} / 少 ${gone} 件），请重新求解`);
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(live, null, 1));
      const req = plan.items.map(i => ({ uid: i.uid, x: i.x, y: i.y, rot: i.rot || 0 }));
      const r = await withCDP(({ evalJs }) => evalJs(WRITE_JS(req)));
      if (r.error) throw new Error(r.error);
      const after = await withCDP(({ evalJs }) => evalJs(LAYOUT_JS));
      fs.writeFileSync(fileURLToPath(new URL('./layout-applied.json', import.meta.url)), JSON.stringify(after, null, 1));
      const m = new Map(after.items.map(i => [i.uid, i]));
      let bad = 0;
      for (const p of req) { const a = m.get(p.uid); if (!a || a.x !== p.x || a.y !== p.y || a.rot !== p.rot) bad++; }
      return { written: r.done, missing: r.missing, verified: bad === 0, metrics: layoutMetrics(after) };
    }
    case 'layoutundo': {
      const file = q.file === 'orig' ? BACKUP_ORIG_FILE : BACKUP_FILE;
      if (!fs.existsSync(file)) throw new Error('没有备份文件');
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      const req = b.items.map(i => ({ uid: i.uid, x: i.x, y: i.y, rot: i.rot || 0 }));
      const r = await withCDP(({ evalJs }) => evalJs(WRITE_JS(req)));
      if (r.error) throw new Error(r.error);
      const after = await withCDP(({ evalJs }) => evalJs(LAYOUT_JS));
      return { restored: r.done, metrics: layoutMetrics(after) };
    }
    case 'setfield': {
      const key = q.key, value = num(q.value, 0);
      return withCDP(async ({ evalJs }) => evalJs(`(()=>{const t=window.__bdm;t[${JSON.stringify(key)}]=${value};return {key:${JSON.stringify(key)},value:t[${JSON.stringify(key)}]};})()`));
    }
    default:
      throw new Error('unknown action ' + name);
  }
}

/* ---------- HTTP ---------- */
const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>背包地牢 修改器</title><style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.5 system-ui,"Segoe UI",sans-serif;background:#14161a;color:#e6e6e6}
header{padding:14px 18px;background:#1c2027;border-bottom:1px solid #2b313a;display:flex;gap:12px;align-items:center}
h1{font-size:16px;margin:0;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;padding:16px}
.card{background:#1c2027;border:1px solid #2b313a;border-radius:10px;padding:14px}
.card h2{font-size:13px;margin:0 0 10px;color:#9aa4b2;font-weight:600;letter-spacing:.04em}
.row{display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap}
button{background:#2b313a;color:#e6e6e6;border:1px solid #3a424d;border-radius:7px;padding:7px 12px;cursor:pointer;font-size:13px}
button:hover{background:#343c47}button.on{background:#1f6f43;border-color:#2f9c5e}button.off{background:#4a2b2b;border-color:#7a3b3b}
button.primary{background:#2f6fed;border-color:#4a86ff}
input{background:#12151a;border:1px solid #3a424d;color:#e6e6e6;border-radius:6px;padding:6px 8px;width:88px}
input[type=range]{width:180px}
.k{color:#8b96a5}.v{font-variant-numeric:tabular-nums;font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid #3a424d}
.ok{color:#4ade80;border-color:#2f9c5e}.bad{color:#f87171;border-color:#7a3b3b}.warn{color:#fbbf24;border-color:#a16207}
#msg{padding:0 18px 8px;color:#fbbf24;min-height:20px;font-size:13px}
table{width:100%;border-collapse:collapse}td{padding:3px 0}td:last-child{text-align:right}
</style></head><body>
<header><h1>背包地牢 修改器</h1>
<span id="conn" class="pill bad">未连接</span>
<button class="primary" onclick="act('capture')">① 抓取战斗实例</button>
<button onclick="act('enforce')">② 重装钩子</button>
<button onclick="refresh()">刷新</button></header>
<div id="msg"></div>
<div class="grid">
  <div class="card"><h2>状态</h2><table>
    <tr><td class="k">血量</td><td class="v"><span id="hp">-</span> / <span id="maxHp">-</span></td></tr>
    <tr><td class="k">耐力</td><td class="v"><span id="stam">-</span> / <span id="maxStam">-</span></td></tr>
    <tr><td class="k">魔力 / 护甲层数</td><td class="v"><span id="mana">-</span> / <span id="armor">-</span></td></tr>
    <tr><td class="k">战斗金币</td><td class="v" id="gold">-</td></tr>
    <tr><td class="k">存档金币</td><td class="v" id="storeGold">-</td></tr>
    <tr><td class="k">球速</td><td class="v" id="ball">-</td></tr>
    <tr><td class="k">敌人</td><td class="v" id="enemies">-</td></tr>
  </table></div>

  <div class="card"><h2>生存 / 资源</h2>
    <div class="row"><button id="btnGod" onclick="toggle('god')">无敌</button>
      <button id="btnStam" onclick="toggle('infstam')">无限耐力</button></div>
    <div class="row">血量上限 <input id="hpMax" placeholder="如 10000">
      <button onclick="act('hp',{max:val('hpMax')})">应用</button></div>
    <div class="row">耐力上限 <input id="stMax" placeholder="如 200">
      <button onclick="act('stam',{max:val('stMax')})">应用</button></div>
    <div class="row">金币倍率
      <button id="btnGold1" onclick="act('gold',{value:1})">×1</button>
      <button id="btnGold2" onclick="act('gold',{value:2})">×2</button>
      <button id="btnGold5" onclick="act('gold',{value:5})">×5</button>
      </div>
    <div class="row">存档金币 <input id="goldSet" placeholder="99999">
      <button onclick="setGold()">写入</button></div>
  </div>

  <div class="card"><h2>伤害 / 球速</h2>
    <div class="row">伤害 <input type="range" id="dmgR" min="0" max="2000" step="100" value="900"
      oninput="document.getElementById('dmgV').textContent=this.value+'%'">
      <span class="v" id="dmgV">900%</span></div>
    <div class="row"><button id="btnDmg" onclick="toggleDmg()">伤害倍率：关</button>
      <span class="k">900% = 10 倍</span></div>
    <div class="row">球速 <input type="range" id="ballR" min="1" max="40" step="1" value="12"
      oninput="document.getElementById('ballV').textContent=this.value">
      <span class="v" id="ballV">12</span></div>
    <div class="row"><button id="btnBall" onclick="toggleBall()">球速：关</button></div>
    <div class="row">单圈最短 <input type="range" id="loopR" min="0.1" max="2" step="0.1" value="1"
      oninput="document.getElementById('loopV').textContent=this.value+'s'">
      <span class="v" id="loopV">1s</span></div>
    <div class="row"><button id="btnLoop" onclick="toggleLoop()">单圈最短：关</button>
      <span class="k">越低允许的球速上限越高（默认 2s，硬下限 0.1s）</span></div>
    <div class="row"><button id="btnAll" onclick="toggleAll()">一键全开：关</button>
      <span class="k">无敌 + 无限耐力 + 伤害 + 球速</span></div>
  </div>

  <div class="card"><h2>触发率分析</h2>
    <div class="row"><button onclick="trigStart()">开始统计</button>
      <button onclick="trigReport()">生成报告</button></div>
    <div class="row"><span class="k">开战后点开始，跑几圈球再生成报告</span></div>
    <pre id="trigOut" style="white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto;margin:8px 0 0"></pre>
  </div>

  <div class="card"><h2>正向状态锁定（逐项）</h2>
    <div id="statRows"></div>
    <div class="row"><button onclick="statAll(1)">全部锁定</button>
      <button onclick="statAll(0)">全部关闭</button></div>
    <div class="row"><span class="k">勾选=持续锁定（低于目标自动补满）；不勾选点设置=只设置一次</span></div>
  </div>

  <div class="card"><h2>布局优化（球路 / 弓弹药 / 星位）</h2>
    <div class="row"><button onclick="layoutScore()">评分</button>
      <button class="primary" onclick="layoutSolve()">求解最优布局</button>
      <button onclick="layoutApply()">应用</button>
      <button onclick="layoutUndo()">回滚</button></div>
    <div class="row"><span class="k">应用前自动备份；战斗中禁止写入</span></div>
    <pre id="layOut" style="white-space:pre-wrap;font-size:12px;max-height:360px;overflow:auto;margin:8px 0 0"></pre>
  </div>

  <div class="card"><h2>使用顺序</h2>
    <div class="row"><span class="k">进入战斗 → ① 抓取战斗实例；其余功能点一次即自动装好钩子</span></div>
  </div>
</div>
<script>
const msg=document.getElementById('msg');
const val=id=>document.getElementById(id).value;
const setRange=(id,v)=>{const e=document.getElementById(id);e.value=v;e.dispatchEvent(new Event('input'));};
function say(t){msg.textContent=t||'';}
async function api(action,params={}){
  const q=new URLSearchParams(params).toString();
  const r=await fetch('/api/'+action+(q?'?'+q:''));
  const j=await r.json();
  if(!j.ok) throw new Error(j.error||'失败');
  return j.result;
}
async function act(action,params={}){
  try{say('执行中…');const r=await api(action,params);say('OK');refresh();return r;}
  catch(e){say('错误：'+e.message);}
}
async function toggle(kind){
  const st=await api('status').catch(()=>null);
  const cur=st&&st.flags&&((kind==='god'&&st.flags.godHp)||(kind==='infstam'&&st.flags.infStam));
  await act(kind,{value:cur?'0':'1'});
}
async function trigStart(){
  try{ const r=await api('trigstart'); say('已开始统计（起始圈数 '+r.startLoop+'）'); }
  catch(e){ say('错误：'+e.message); }
}
async function trigReport(){
  try{
    const r=await api('trigreport');
    const out=document.getElementById('trigOut');
    if(!r.ok){ out.textContent=r.error||'失败'; return; }
    const lines=[];
    lines.push('统计圈数: '+r.loops+'   道具总数: '+r.totalItems+'   有效触发: '+r.triggered+'   白放: '+r.wastedCount+'   被动/常驻: '+r.okIdleCount);
    if(r.loops < 10) lines.push('※ 圈数偏少（<10），每圈数值不稳定，建议再跑一会儿');
    lines.push('');
    lines.push('触发次数  每圈   类型   分类      位置      道具 / 说明');
    for(const row of (r.rows||[])){
      lines.push(String(row.triggers).padStart(6)+'  '+String(row.perLoop===null?'-':row.perLoop).padStart(5)+'  '+row.kind+'  '+String(row.cls).padEnd(8)+'  '+String(row.pos).padEnd(8)+'  '+row.name+' · '+row.note);
    }
    if((r.wasted||[]).length){ lines.push(''); lines.push('【白放】需要球扫到却没有触发（建议挪到球路上或换掉）:'); for(const s of (r.wasted||[])) lines.push('  '+s); }
    if((r.okIdle||[]).length){ lines.push(''); lines.push('【被动/常驻】0 触发属正常:'); for(const s of (r.okIdle||[])) lines.push('  '+s); }
    out.textContent=lines.join('\\n');
    say('报告已生成');
  }catch(e){ say('错误：'+e.message); }
}
async function setGold(){
  const v=val('goldSet'); if(!v) return say('请输入金币数');
  try{
    const r2=await fetch('/api/storegold?'+new URLSearchParams({value:v})); const j=await r2.json();
    if(!j.ok) throw new Error(j.error||'失败');
    say('存档金币已设为 '+v); refresh();
  }catch(e){say('错误：'+e.message);}
}
async function toggleDmg(){
  try{
    const st=await api('status');
    const f=(st&&st.flags)||{};
    if(Number(f.dmgPct)>0){ await act('dmg',{value:0}); say('伤害倍率已关闭'); }
    else { await act('dmg',{value:val('dmgR')}); say('伤害倍率已开启'); }
  }catch(e){say('错误：'+e.message);}
}
async function toggleBall(){
  try{
    const st=await api('status');
    const f=(st&&st.flags)||{};
    if(Number(f.ballSpeed)>0){ await act('ball',{value:0}); say('球速已关闭'); }
    else { await act('ball',{value:val('ballR')}); say('球速已开启'); }
  }catch(e){say('错误：'+e.message);}
}
async function toggleLoop(){
  try{
    const st=await api('status');
    const f=(st&&st.flags)||{};
    if(Number(f.loopTime)>0){ await act('looptime',{value:0}); say('单圈最短时间已恢复'); }
    else { await act('looptime',{value:val('loopR')}); say('单圈最短时间已设为 '+val('loopR')+'s'); }
  }catch(e){say('错误：'+e.message);}
}
async function toggleAll(){
  try{
    const st=await api('status');
    const f=(st&&st.flags)||{};
    const on=!!(f.godHp && f.infStam && Number(f.dmgPct)>0 && Number(f.ballSpeed)>0);
    if(on){
      await act('god',{value:'0'}); await act('infstam',{value:'0'});
      await act('dmg',{value:0}); await act('ball',{value:0});
      say('已全部关闭');
    }else{
      await act('god',{value:'1'}); await act('infstam',{value:'1'});
      await act('dmg',{value:val('dmgR')}); await act('ball',{value:val('ballR')});
      say('已全部开启');
    }
  }catch(e){say('错误：'+e.message);}
}
async function refresh(){
  try{
    const s=await api('status');
    const conn=document.getElementById('conn');
    if(!s||!s.ok){
      if(s&&s.serverConnected){conn.className='pill warn';conn.textContent='已连接 · 未抓取实例';}
      else{conn.className='pill bad';conn.textContent='未连接';}
    }
    else{conn.className='pill ok';conn.textContent='已连接';}
    if(s&&s.ok){
      document.getElementById('hp').textContent=s.hp;
      document.getElementById('maxHp').textContent=s.maxHp;
      document.getElementById('stam').textContent=Math.round(s.stamina*10)/10;
      document.getElementById('maxStam').textContent=s.maxStamina;
      document.getElementById('mana').textContent=s.mana;
      document.getElementById('armor').textContent=s.armorStacks;
      document.getElementById('gold').textContent=s.gold;
      document.getElementById('ball').textContent=s.ballSpeed;
      document.getElementById('enemies').textContent=s.enemies;
      const f=s.flags||{};
      document.getElementById('btnGod').className=f.godHp?'on':'';
      document.getElementById('btnGod').textContent=f.godHp?'无敌：开':'无敌：关';
      document.getElementById('btnStam').className=f.infStam?'on':'';
      document.getElementById('btnStam').textContent=f.infStam?'无限耐力：开':'无限耐力：关';
      const gm=Number(f.goldMul||1);
      [['btnGold1',1],['btnGold2',2],['btnGold5',5]].forEach(([id,v])=>{
        const el=document.getElementById(id); if(el) el.className=(gm===v?'on':'');
      });
      const allOn=!!(f.godHp&&f.infStam&&Number(f.dmgPct)>0&&Number(f.ballSpeed)>0);
      const ba=document.getElementById('btnAll');
      if(ba){ ba.className=allOn?'on':''; ba.textContent=allOn?'一键全开：开':'一键全开：关'; }
      const dmOn=Number(f.dmgPct)>0;
      const bd=document.getElementById('btnDmg');
      if(bd){ bd.className=dmOn?'on':''; bd.textContent=dmOn?('伤害倍率：开 '+f.dmgPct+'%'):'伤害倍率：关'; }
      const blOn=Number(f.ballSpeed)>0;
      const bb=document.getElementById('btnBall');
      if(bb){ bb.className=blOn?'on':''; bb.textContent=blOn?('球速：开 '+f.ballSpeed):'球速：关'; }
      const lpOn=Number(f.loopTime)>0;
      const bl=document.getElementById('btnLoop');
      if(bl){ bl.className=lpOn?'on':''; bl.textContent=lpOn?('单圈最短：开 '+f.loopTime+'s'):'单圈最短：关'; }
    }
    if(s&&s.storeGold!==undefined) document.getElementById('storeGold').textContent=s.storeGold;
  }catch(e){document.getElementById('conn').className='pill bad';document.getElementById('conn').textContent='未连接';}
}
/* ---------- 状态逐项锁定 ---------- */
const POS_STATUS=[['armor','护甲'],['strength','强力'],['frenzy','狂热'],['regeneration','再生'],['mana','魔力'],['vitality','活力'],['thorns','荆棘']];
const statState={};
function renderStatRows(){
  const box=document.getElementById('statRows');
  box.innerHTML=POS_STATUS.map(([k,n])=>
    '<div class="row"><label style="width:48px">'+n+'</label>'+
    '<input type="checkbox" id="sl_'+k+'" '+(statState[k]&&statState[k].on?'checked':'')+' style="width:auto">'+
    '<input id="sv_'+k+'" value="'+((statState[k]&&statState[k].value)!=null?statState[k].value:99)+'" style="width:70px">'+
    '<button data-k="'+k+'">设置</button>'+
    '<span class="k" id="ss_'+k+'"></span></div>').join('');
  box.querySelectorAll('button[data-k]').forEach(function(b){
    b.addEventListener('click',function(){ setStat(b.getAttribute('data-k')); });
  });
}
async function setStat(k){
  const on=document.getElementById('sl_'+k).checked?1:0;
  const v=val('sv_'+k)||0;
  try{
    const r=await api('statlock',{status:k,on:String(on),value:v});
    statState[k]={on:!!on,value:Number(v)};
    const e=document.getElementById('ss_'+k); if(e) e.textContent='当前 '+(r.stacks==null?'-':r.stacks);
    say(k+' '+(on?'锁定 '+v:'已关闭'));
  }catch(e){say('错误：'+e.message);}
}
function statAll(on){
  (async()=>{
    for(const [k] of POS_STATUS){
      const cb=document.getElementById('sl_'+k); if(cb) cb.checked=!!on;
      await setStat(k);
    }
  })();
}
async function loadStatLocks(){
  try{
    const r=await api('statlocks');
    for(const [k] of POS_STATUS) if(r.locks&&r.locks[k]) statState[k]=r.locks[k];
    renderStatRows();
    if(r.stacks) for(const [k] of POS_STATUS){const e=document.getElementById('ss_'+k); if(e) e.textContent='当前 '+(r.stacks[k]==null?'-':r.stacks[k]);}
  }catch(e){renderStatRows();}
}

/* ---------- 布局优化 ---------- */
function fmtM(m){
  return '命中/圈 '+m.hits+'   在轨 '+m.onTrack+'   弓 '+m.bows+'   装填 '+m.ammo+'   死箭 '+m.deadArrows+'\\n'+
         '星位 '+m.stars+'   占用 '+m.fill+'%   重叠 '+m.overlaps+'   越界 '+m.outside;
}
async function layoutScore(){
  try{ const r=await api('layoutstatus'); document.getElementById('layOut').textContent='当前布局（'+r.gameState+'）\\n'+fmtM(r.metrics); say('评分完成'); }
  catch(e){say('错误：'+e.message);}
}
async function layoutSolve(){
  const out=document.getElementById('layOut');
  try{
    say('求解中…'); out.textContent='求解中，请稍候（约 5~20 秒）…';
    const r=await api('layoutsolve');
    const lines=[];
    lines.push('当前: '+fmtM(r.before));
    lines.push('优化: '+fmtM(r.after));
    lines.push('耗时 '+(r.ms/1000).toFixed(1)+'s   移动 '+r.moves.length+' 件（尚未应用）');
    if(r.moves.length){ lines.push(''); for(const m of r.moves) lines.push('  '+m.id.padEnd(22)+' '+m.from+' → '+m.to); }
    out.textContent=lines.join('\\n');
    say('方案已生成');
  }catch(e){out.textContent='错误：'+e.message; say('错误：'+e.message);}
}
async function layoutApply(){
  try{
    say('应用中…');
    const r=await api('layoutapply');
    document.getElementById('layOut').textContent='应用结果（校验'+(r.verified?'通过':'失败')+'）\\n'+fmtM(r.metrics);
    say(r.verified?'已应用并校验通过':'已写入但回读不一致');
  }catch(e){say('错误：'+e.message);}
}
async function layoutUndo(){
  try{
    const r=await api('layoutundo');
    document.getElementById('layOut').textContent='回滚后\\n'+fmtM(r.metrics);
    say('已回滚');
  }catch(e){say('错误：'+e.message);}
}

refresh(); setInterval(refresh,1000);
loadStatLocks();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate' });
      return res.end(PAGE);
    }
    if (url.pathname === '/api/storegold') {
      const v = Number(url.searchParams.get('value'));
      const r = await withCDP(async ({ evalJs }) => evalJs(`(()=>{const P=window.__bd_pinia;
        if(!P) return {ok:false,error:'no pinia'};
        const b=window.__bd; if(b) b.__goldGuard=true;
        try{ P.state.value.player.gold=${v}; } finally { if(b){ b.__goldGuard=false; b.__goldPrev=${v}; } }
        return {ok:true,gold:P.state.value.player.gold};})()`));
      return send(200, r && r.ok ? { ok: true, result: r } : { ok: false, error: r?.error || '写入失败' });
    }
    if (url.pathname.startsWith('/api/')) {
      const action = url.pathname.slice(5);
      const q = Object.fromEntries(url.searchParams.entries());
      const result = await runAction(action, q);
      return send(200, { ok: true, result });
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    send(500, { ok: false, error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Trainer UI: http://127.0.0.1:${PORT}`);
  console.log(`CDP target: ${CDP}`);
});
