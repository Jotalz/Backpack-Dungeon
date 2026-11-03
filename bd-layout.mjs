#!/usr/bin/env node
// Backpack Dungeon — 布局读写工具（CDP）
//   node bd-layout.mjs dump [out.json]
//   node bd-layout.mjs apply <plan.json> [--force]
//   node bd-layout.mjs undo [backup.json]
// env: CDP_ENDPOINT (default http://127.0.0.1:9222)
import fs from 'node:fs';

const ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';

const GET_PINIA = `(()=>{const el=document.querySelector('#app');const app=el&&el.__vue_app__;if(!app)return null;
for(const k of Reflect.ownKeys(app._context.provides)){const v=app._context.provides[k];
if(v&&typeof v==='object'&&'_s' in v&&'state' in v)return v;}return null;})()`;
const P = `(window.__bd_pinia || (window.__bd_pinia = ${GET_PINIA}))`;

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
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 20000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  return { ws, evaluate, close: () => ws.close() };
}

const DUMP = `(()=>{const P=${P};const s=P.state.value;
return JSON.stringify({
  gameState: s.gameFlow.gameState,
  items: s.player.items.map(i=>({uid:i.uid,id:i.id,x:i.x,y:i.y,rot:i.rotation||0})),
  bags: s.player.bags.map(b=>({id:b.id,x:b.x,y:b.y,rot:b.rotation||0})),
});})()`;

const WRITE = b64 => `(()=>{const P=${P};const s=P.state.value;
if(s.gameFlow.gameState==='battle')return JSON.stringify({error:'in_battle'});
const plan=JSON.parse(atob('${b64}'));
const byUid=new Map(s.player.items.map(i=>[i.uid,i]));
const done=[],missing=[];
for(const p of plan){
  const it=byUid.get(p.uid);
  if(!it){missing.push(p.uid);continue;}
  it.x=p.x;it.y=p.y;it.rotation=p.rot;
  done.push({uid:p.uid,x:it.x,y:it.y,rot:it.rotation});
}
return JSON.stringify({done,missing});})()`;

function readLayout(ev) {
  return ev(DUMP).then(s => JSON.parse(s));
}

async function cmdDump(ev, out) {
  const d = await readLayout(ev);
  const file = out || 'layout.json';
  fs.writeFileSync(file, JSON.stringify(d, null, 1), 'utf8');
  console.log(`state=${d.gameState} items=${d.items.length} bags=${d.bags.length} -> ${file}`);
  return d;
}

async function cmdApply(ev, planPath, force) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const items = plan.items || plan;
  const live = await readLayout(ev);
  if (live.gameState === 'battle') throw new Error('游戏正在战斗中，请先结束战斗再应用');

  fs.writeFileSync('layout-backup.json', JSON.stringify(live, null, 1), 'utf8');
  console.log(`已备份当前布局 -> layout-backup.json (${live.items.length} 件)`);

  const liveUids = new Set(live.items.map(i => i.uid));
  const planUids = new Set(items.map(i => i.uid));
  const extra = [...liveUids].filter(u => !planUids.has(u));
  const gone = [...planUids].filter(u => !liveUids.has(u));
  if ((extra.length || gone.length) && !force) {
    await ev(WRITE('W10=')); // no-op
    throw new Error(`计划与当前布局不匹配: 未覆盖 ${extra.length} 件, 缺失 ${gone.length} 件. 用 --force 强制或重新 dump+solve`);
  }

  const b64 = Buffer.from(JSON.stringify(items.map(i => ({ uid: i.uid, x: i.x, y: i.y, rot: i.rot ?? i.rotation ?? 0 }))), 'utf8').toString('base64');
  const res = JSON.parse(await ev(WRITE(b64)));
  if (res.error) throw new Error(res.error);
  console.log(`写入完成: ${res.done.length} 件${res.missing.length ? `, 未找到 ${res.missing.length}` : ''}`);

  const after = await readLayout(ev);
  const byUid = new Map(after.items.map(i => [i.uid, i]));
  let bad = 0;
  for (const p of items) {
    const a = byUid.get(p.uid);
    const want = p.rot ?? p.rotation ?? 0;
    if (!a || a.x !== p.x || a.y !== p.y || a.rot !== want) { bad++; }
  }
  console.log(bad ? `⚠ 回读校验失败 ${bad} 件` : `✅ 回读校验通过 (${items.length} 件)`);

  fs.writeFileSync('layout-applied.json', JSON.stringify(after, null, 1), 'utf8');
  return bad === 0;
}

async function cmdUndo(ev, backupPath) {
  const file = backupPath || 'layout-backup.json';
  if (!fs.existsSync(file)) throw new Error(`${file} 不存在`);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  const b64 = Buffer.from(JSON.stringify(backup.items.map(i => ({ uid: i.uid, x: i.x, y: i.y, rot: i.rot ?? i.rotation ?? 0 }))), 'utf8').toString('base64');
  const res = JSON.parse(await ev(WRITE(b64)));
  if (res.error) throw new Error(res.error);
  console.log(`已还原 ${res.done.length} 件${res.missing.length ? `, 缺失 ${res.missing.length}` : ''}`);
  const after = await readLayout(ev);
  let bad = 0;
  const byUid = new Map(after.items.map(i => [i.uid, i]));
  for (const p of backup.items) {
    const a = byUid.get(p.uid);
    if (!a || a.x !== p.x || a.y !== p.y || a.rot !== (p.rot ?? 0)) bad++;
  }
  console.log(bad ? `⚠ 还原校验失败 ${bad} 件` : '✅ 还原校验通过');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const pos = argv.slice(1).filter(a => !a.startsWith('--'));
  if (!cmd || cmd === 'help' || cmd === '-h') {
    console.log(`背包地牢 布局工具
  node bd-layout.mjs dump [out.json]
  node bd-layout.mjs apply <plan.json> [--force]
  node bd-layout.mjs undo [backup.json]`);
    return;
  }
  const { evaluate, close } = await connect();
  try {
    if (cmd === 'dump') await cmdDump(evaluate, pos[0]);
    else if (cmd === 'apply') await cmdApply(evaluate, pos[0] || 'plan.json', argv.includes('--force'));
    else if (cmd === 'undo') await cmdUndo(evaluate, pos[0]);
    else throw new Error('unknown command: ' + cmd);
  } finally { close(); }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
