#!/usr/bin/env node
// Plan B trainer: capture the live BattleManager via CDP breakpoint, then
// drive it directly (instant, no restart, no file changes).
//
//   node bd-inject.mjs capture [--bundle idx.js] [--timeout 30]   (需要在战斗中)
//   node bd-inject.mjs enforce            install timer + hooks (god/stam/dmg/ball)
//   node bd-inject.mjs get
//   node bd-inject.mjs hp <cur> [max]
//   node bd-inject.mjs stam <cur> [max]
//   node bd-inject.mjs dmg <percent>      900 = x10
//   node bd-inject.mjs ball <speed>
//   node bd-inject.mjs gold <mult>
//   node bd-inject.mjs set <field> <value>
//   node bd-inject.mjs exec "<js>"

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const BUNDLE = process.env.BD_BUNDLE || fileURLToPath(new URL('./idx.js', import.meta.url));

const ENFORCE_JS = `(()=>{
  const t=window.__bdm; if(!t) return 'no __bdm';
  window.__bd = Object.assign({godHp:false,infStam:false,goldMul:1,dmgPct:0,ballSpeed:0,hpTarget:0,stamTarget:0}, window.__bd||{});
  const apply=()=>{
    const m=window.__bdm,b=window.__bd; if(!m||!b) return;
    if(b.hpTarget>0){m.playerMaxHp=b.hpTarget;m.playerHp=b.hpTarget;}
    else if(b.godHp){m.playerHp=m.playerMaxHp;}
    if(b.stamTarget>0){m.playerMaxStamina=b.stamTarget;m.playerStamina=b.stamTarget;}
    else if(b.infStam){m.playerStamina=m.playerMaxStamina;}
    if(b.ballSpeed>0&&m.ballManager){
      if(typeof m.ballManager.setBaseSpeed==='function') m.ballManager.setBaseSpeed(b.ballSpeed);
      else m.ballManager.baseSpeed=b.ballSpeed;
    }
  };
  window.__bdApply=apply;
  if(!window.__bdTimer) window.__bdTimer=setInterval(apply,16);
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
    if(!t.__goldCbWrapped&&typeof t.onGoldChangeCallback==='function'){
      const cb=t.onGoldChangeCallback;
      t.onGoldChangeCallback=function(amount){const mul=(window.__bd&&window.__bd.goldMul)||1;return cb.call(this,amount*mul);};
      t.__goldCbWrapped=true;
    }
  }
  apply();
  return {flags:window.__bd,timer:!!window.__bdTimer,hooked:!!t.__bdHooked,damageWrapped:!!t.__bdDamageWrapped,
          speedWrapped:!!(t.ballManager&&t.ballManager.__bdSpeedWrapped),goldCbWrapped:!!t.__goldCbWrapped};
})()`;

async function connect() {
  const list = await (await fetch(`${ENDPOINT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target (launch with --remote-debugging-port=9222)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send, events };
}

async function withPage(fn) {
  const { ws, send } = await connect();
  try {
    await send('Runtime.enable');
    return await fn(send);
  } finally { ws.close(); }
}

async function evalOnPage(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout: 15000,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

function locate(bundlePath, methodName) {
  const text = fs.readFileSync(bundlePath, 'utf8');
  const re = new RegExp(`\\n\\s*${methodName}\\s*\\(`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text))) {
    const off = m.index + (m[0].length - m[0].trimStart().length);
    const before = text.slice(0, off);
    hits.push({ off, line: before.split('\n').length - 1, col: off - (text.lastIndexOf('\n', off) + 1) });
  }
  return hits;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function capture(bundlePath, timeoutSec) {
  const candidates = [
    ['updateState', locate(bundlePath, 'updateState')],
    ['startBattle', locate(bundlePath, 'startBattle')],
    ['dealDamageToEnemy', locate(bundlePath, 'dealDamageToEnemy')],
  ].filter(([, hits]) => hits.length);
  if (!candidates.length) throw new Error('target methods not found in bundle');
  const [name, hits] = candidates[0];
  const loc = hits[hits.length - 1];
  console.log(`target ${name} line=${loc.line} col=${loc.col}`);

  const { ws, send, events } = await connect();
  await send('Debugger.enable');

  let scriptUrl = null;
  for (let i = 0; i < 50 && !scriptUrl; i++) {
    for (const e of events) {
      if (e.method === 'Debugger.scriptParsed' && /index-.{6,}\.js/.test(e.params.url || '')) {
        scriptUrl = e.params.url; break;
      }
    }
    if (!scriptUrl) await sleep(100);
  }
  if (!scriptUrl) { ws.close(); throw new Error('renderer bundle script not found'); }
  console.log('script:', scriptUrl);

  const bp = await send('Debugger.setBreakpointByUrl', {
    lineNumber: loc.line, columnNumber: loc.col, url: scriptUrl,
  });

  const deadline = Date.now() + timeoutSec * 1000;
  let paused = null;
  while (Date.now() < deadline && !paused) {
    paused = events.find(e => e.method === 'Debugger.paused');
    if (!paused) await sleep(100);
  }
  if (!paused) {
    try { await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId }); } catch {}
    await send('Debugger.disable'); ws.close();
    throw new Error(`breakpoint not hit in ${timeoutSec}s (进入战斗后重试)`);
  }

  const frame = paused.params.callFrames[0];
  const r = await send('Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId,
    expression: `(()=>{const t=this; if(!t||t.playerHp===undefined) return {ok:false, note:'not BattleManager'};
      window.__bdm=t;
      return {ok:true, hp:t.playerHp, maxHp:t.playerMaxHp, stamina:t.playerStamina,
              maxStamina:t.playerMaxStamina, gold:t.playerGold, ball:!!t.ballManager,
              enemies:t.enemyManagers?.length};})()`,
    returnByValue: true,
  });

  await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId });
  await send('Debugger.resume');
  await send('Debugger.disable');
  ws.close();
  console.log(JSON.stringify(r.result?.value ?? r, null, 2));
}

const args = process.argv.slice(2);
const cmd = args[0];

try {
  if (cmd === 'capture') {
    const bi = args.indexOf('--bundle');
    const ti = args.indexOf('--timeout');
    await capture(bi >= 0 ? args[bi + 1] : BUNDLE, ti >= 0 ? Number(args[ti + 1]) : 30);
  } else if (cmd === 'enforce' || cmd === 'patch') {
    await withPage(async send => {
      if (cmd === 'patch') {
        await evalOnPage(send, `(()=>{window.__bd&&(window.__bd.godHp=true,window.__bd.infStam=true);return 1;})()`);
      }
      console.log(JSON.stringify(await evalOnPage(send, ENFORCE_JS), null, 2));
    });
  } else if (cmd === 'get') {
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;
        if(!t) return {ok:false, note:'window.__bdm missing, run capture first'};
        return {hp:t.playerHp,maxHp:t.playerMaxHp,hpCap:t.playerMaxHpCap,
                stamina:t.playerStamina,maxStamina:t.playerMaxStamina,
                regen:t.playerStaminaRegen,gold:t.playerGold,speed:t.gameSpeed,
                physBoost:t.physicalDamageBoost,magicBoost:t.magicDamageBoost,
                ballSpeed:t.ballManager&&t.ballManager.baseSpeed,
                enemies:t.enemyManagers&&t.enemyManagers.length,
                flags:window.__bd,timer:!!window.__bdTimer};})()`), null, 2));
    });
  } else if (cmd === 'hp') {
    const cur = Number(args[1] ?? 9999), max = Number(args[2] ?? cur);
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;if(!t)return 'no __bdm';
        window.__bd=window.__bd||{}; window.__bd.godHp=false; window.__bd.hpTarget=${max};
        t.playerMaxHp=${max}; t.playerHp=${cur};
        return {hp:t.playerHp,maxHp:t.playerMaxHp,hpTarget:window.__bd.hpTarget};})()`), null, 2));
    });
  } else if (cmd === 'stam') {
    const cur = Number(args[1] ?? 999), max = Number(args[2] ?? cur);
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;if(!t)return 'no __bdm';
        window.__bd=window.__bd||{}; window.__bd.infStam=false; window.__bd.stamTarget=${max};
        t.playerMaxStamina=${max}; t.playerStamina=${cur};
        return {stamina:t.playerStamina,maxStamina:t.playerMaxStamina,stamTarget:window.__bd.stamTarget};})()`), null, 2));
    });
  } else if (cmd === 'dmg') {
    const pct = Number(args[1] ?? 900);
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;if(!t)return 'no __bdm';
        window.__bd=window.__bd||{}; window.__bd.dmgPct=${pct};
        return {dmgPct:window.__bd.dmgPct, wrapped:!!t.__bdDamageWrapped};})()`), null, 2));
    });
  } else if (cmd === 'ball') {
    const speed = Number(args[1] ?? 12);
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;if(!t)return 'no __bdm';
        window.__bd=window.__bd||{}; window.__bd.ballSpeed=${speed};
        if(window.__bdApply)window.__bdApply();
        return {ballSpeed:window.__bd.ballSpeed, baseSpeed:t.ballManager&&t.ballManager.baseSpeed};})()`), null, 2));
    });
  } else if (cmd === 'gold') {
    const mul = Number(args[1] ?? 5);
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;if(!t)return 'no __bdm';
        window.__bd=window.__bd||{}; window.__bd.goldMul=${mul};
        if(!t.__goldPatched){
          let v=t.playerGold;
          Object.defineProperty(t,'playerGold',{configurable:true,get(){return v;},
            set(nv){const m=(window.__bd&&window.__bd.goldMul)||1;
              if(nv>v&&m>1){v=v+(nv-v)*m;}else{v=nv;}}});
          t.__goldPatched=true;
        }
        return {gold:t.playerGold, goldMul:window.__bd.goldMul, patched:!!t.__goldPatched};})()`), null, 2));
    });
  } else if (cmd === 'set') {
    const [, key, value] = args;
    if (!key || value === undefined) throw new Error('usage: set <field> <value>');
    await withPage(async send => {
      console.log(JSON.stringify(await evalOnPage(send, `(()=>{const t=window.__bdm;if(!t)return 'no __bdm';
        t[${JSON.stringify(key)}]=Number(${JSON.stringify(value)});
        return {${JSON.stringify(key)}:t[${JSON.stringify(key)}]};})()`), null, 2));
    });
  } else if (cmd === 'exec') {
    const expr = args[1] === '-f' ? fs.readFileSync(args[2], 'utf8') : args[1];
    if (!expr) throw new Error('usage: exec "<js>" | exec -f file.js');
    await withPage(async send => console.log(JSON.stringify(await evalOnPage(send, expr), null, 2)));
  } else {
    console.log(`usage:
  node bd-inject.mjs capture [--timeout 30]     抓 BattleManager (需在战斗中)
  node bd-inject.mjs enforce                   安装定时器+钩子
  node bd-inject.mjs patch                     enforce + 无敌 + 无限耐力
  node bd-inject.mjs get
  node bd-inject.mjs hp <cur> [max]
  node bd-inject.mjs stam <cur> [max]
  node bd-inject.mjs dmg <percent>             900 = x10
  node bd-inject.mjs ball <speed>
  node bd-inject.mjs gold <mult>
  node bd-inject.mjs set <field> <value>
  node bd-inject.mjs exec "<js>"`);
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
