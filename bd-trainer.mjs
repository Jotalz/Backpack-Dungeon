#!/usr/bin/env node
// Backpack Dungeon trainer (CDP / Plan A)
// Requires: game launched with --remote-debugging-port=9222
//
//   node bd-trainer.mjs status
//   node bd-trainer.mjs set <key> <value>
//   node bd-trainer.mjs lock key=value [key=value ...] [--interval 200]
//   node bd-trainer.mjs raw "<javascript>"
//   node bd-trainer.mjs unlock <itemId>
//
// env: CDP_ENDPOINT (default http://127.0.0.1:9222)

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
import fs from 'node:fs';

const GET_PINIA = `(()=>{const el=document.querySelector('#app');const app=el&&el.__vue_app__;if(!app)return null;
for(const k of Reflect.ownKeys(app._context.provides)){const v=app._context.provides[k];
if(v&&typeof v==='object'&&'_s' in v&&'state' in v)return v;}return null;})()`;

const P = `(window.__bd_pinia || (window.__bd_pinia = ${GET_PINIA}))`;

// leaf paths inside pinia.state.value
const TARGETS = {
  gold:         ['player.gold'],
  souls:        ['gameSave.totalSouls'],
  bank:         ['gameSave.bankGoldBalance'],
  refresh:      ['setting.refreshCost', 'gameFlow.currentCharacterConfig.initialRefreshCost'],
  hp:           ['player.playerHealth', 'gameFlow.battleState.playerHp'],
  maxhp:        ['player.playerMaxHealth', 'gameFlow.battleState.playerMaxHp'],
  stamina:      ['gameFlow.battleState.playerStamina'],
  maxstamina:   ['player.playerMaxStamina', 'gameFlow.battleState.playerMaxStamina'],
  regen:        ['player.playerStaminaRegen', 'gameFlow.battleState.playerStaminaRegen'],
  armor:        ['gameFlow.battleState.playerArmor'],
  // permanent meta upgrades (survive recalculation)
  meta_hp_pct:      ['gameSave.metaProgressionLevels.max_health_percent'],
  meta_stam_flat:   ['gameSave.metaProgressionLevels.max_stamina_flat'],
  meta_stam_pct:    ['gameSave.metaProgressionLevels.stamina_regen_percent'],
  meta_start_gold:  ['gameSave.metaProgressionLevels.starting_gold_flat'],
  meta_gold_pct:    ['gameSave.metaProgressionLevels.battle_end_gold_percent'],
  meta_free_refresh:['gameSave.metaProgressionLevels.free_shop_refresh_per_floor'],
  meta_lucky_shop:  ['gameSave.metaProgressionLevels.lucky_shop_chance_percent'],
  meta_potion_pct:  ['gameSave.metaProgressionLevels.health_potion_drop_percent'],
};

const STATUS_FIELDS = {
  gold: 'player.gold',
  souls: 'gameSave.totalSouls',
  bank: 'gameSave.bankGoldBalance',
  hp: 'player.playerHealth',
  hpMax: 'player.playerMaxHealth',
  stamMax: 'player.playerMaxStamina',
  regen: 'player.playerStaminaRegen',
  refreshCost: 'setting.refreshCost',
  floor: 'gameFlow.currentFloor',
  gameState: 'gameFlow.gameState',
};

async function connect() {
  const list = await (await fetch(`${ENDPOINT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target (launch with --remote-debugging-port=9222)');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('websocket failed')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, timeout: 15000,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  };
  return { ws, evaluate };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readStatus(ev) {
  const lines = Object.entries(STATUS_FIELDS).map(([name, path]) =>
    `${name}: P.state.value.${path}`);
  const expr = `(()=>{const P=${P};const o={};
    ${lines.map((l, i) => {
      const [name, rhs] = l.split(': ');
      return `try{o[${JSON.stringify(name)}]=${rhs};}catch(e){o[${JSON.stringify(name)}]=null;}`;
    }).join('\n')}
    const bs=P.state.value.gameFlow&&P.state.value.gameFlow.battleState;
    o.battle = bs ? {active:bs.isActive, hp:bs.playerHp, hpMax:bs.playerMaxHp,
                     stamina:bs.playerStamina, stamMax:bs.playerMaxStamina, armor:bs.playerArmor} : null;
    o.unlockedItems = Object.keys(P.state.value.itemUnlock.unlockedItems||{}).length;
    return o;})()`;
  return ev(expr);
}

async function setKey(ev, key, value) {
  const paths = TARGETS[key];
  if (!paths) throw new Error(`unknown key '${key}'. valid: ${Object.keys(TARGETS).join(', ')}`);
  const expr = `(()=>{const P=${P};const n=Number(${JSON.stringify(String(value))});const done=[];
    const paths=${JSON.stringify(paths)};
    for(const p of paths){
      const parts=p.split('.');let o=P.state.value;
      for(let i=0;i<parts.length-1;i++){o=o&&o[parts[i]];}
      const leaf=parts[parts.length-1];
      if(o&&typeof o==='object'){o[leaf]=n;done.push(p);}
    }
    return done;})()`;
  return ev(expr);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    console.log(`Backpack Dungeon trainer
  node bd-trainer.mjs status
  node bd-trainer.mjs set <key> <value>
  node bd-trainer.mjs lock key=value [key=value ...] [--interval 200]
  node bd-trainer.mjs unlock <itemId>
  node bd-trainer.mjs raw "<javascript>"

keys: ${Object.keys(TARGETS).join(', ')}
env : CDP_ENDPOINT (default ${ENDPOINT})`);
    return;
  }

  const { ws, evaluate } = await connect();
  try {
    if (cmd === 'status') {
      console.log(JSON.stringify(await readStatus(evaluate), null, 2));
    } else if (cmd === 'set') {
      const key = argv[1], value = argv[2];
      if (!key || value === undefined) throw new Error('usage: set <key> <value>');
      const done = await setKey(evaluate, key, value);
      console.log(`applied: ${done.join(', ')}`);
      console.log(JSON.stringify(await readStatus(evaluate), null, 2));
    } else if (cmd === 'unlock') {
      const id = argv[1];
      if (!id) throw new Error('usage: unlock <itemId>');
      const r = await evaluate(`(()=>{const P=${P};const u=P.state.value.itemUnlock.unlockedItems;
        const id=${JSON.stringify(id)};
        const before=u[id]?{...u[id]}:null;
        u[id]={unlockedAt:Date.now(),sourceType:'achievement',sourceKey:'PERFECT_BATTLE'};
        return {before, after:{...u[id]}};})()`);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'raw') {
      const expr = argv[1] === '-f' ? fs.readFileSync(argv[2], 'utf8') : argv[1];
      if (!expr) throw new Error('usage: raw "<javascript>" | raw -f file.js');
      console.log(JSON.stringify(await evaluate(expr), null, 2));
    } else if (cmd === 'lock') {
      const pairs = argv.slice(1).filter(a => a.includes('=')).map(a => {
        const i = a.indexOf('=');
        return [a.slice(0, i), a.slice(i + 1)];
      });
      if (!pairs.length) throw new Error('usage: lock key=value [key=value ...]');
      const ii = argv.indexOf('--interval');
      const interval = ii >= 0 ? Number(argv[ii + 1]) : 200;
      console.log(`locking ${pairs.map(([k, v]) => `${k}=${v}`).join(', ')} every ${interval}ms (Ctrl+C)`);
      let running = true;
      process.on('SIGINT', () => { running = false; });
      while (running) {
        for (const [k, v] of pairs) {
          try { await setKey(evaluate, k, v); } catch (e) { console.error('  ' + e.message); }
        }
        await sleep(interval);
      }
      console.log('lock stopped');
    } else {
      throw new Error(`unknown command '${cmd}'`);
    }
  } finally {
    ws.close();
  }
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
