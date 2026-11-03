// solve.mjs — 布局求解器（只重排道具，背包固定）
// usage: node solve.mjs [layout.json] [itemdb.json] [--restarts=200] [--iters=4000]
import fs from 'node:fs';
import { itemGeom, computeTracks, scoreLayout } from './layout-lib.mjs';

const POS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const layoutPath = POS[0] || 'layout.json';
const dbPath = POS[1] || 'itemdb.json';
const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith('--' + name + '='));
  return a ? Number(a.split('=')[1]) : def;
};
const RESTARTS = arg('restarts', 200);
const ITERS = arg('iters', 4000);

const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8')).items;

// ---------- 主轨道 & 背包格 ----------
const tracks = computeTracks(db, layout.bags);
let main = tracks[0] || { edges: [] };
for (const t of tracks) if (t.edges.length > main.edges.length) main = t;
const edgeSet = new Set(main.edges.map(e => `${e.x},${e.y},${e.side}`));

const bagCells = new Set();
for (const b of layout.bags) {
  for (const c of itemGeom(db, b.id, b.x, b.y, b.rot ?? b.rotation ?? 0).cells) bagCells.add(`${c.x},${c.y}`);
}
const xs = [...bagCells].map(k => +k.split(',')[0]);
const ys = [...bagCells].map(k => +k.split(',')[1]);
const X0 = Math.min(...xs), X1 = Math.max(...xs), Y0 = Math.min(...ys), Y1 = Math.max(...ys);

// ---------- 可选摆放 ----------
function placementsFor(id) {
  const def = db[id];
  if (!def || !def.shape) return [];
  const out = [];
  for (let rot = 0; rot < 4; rot++) {
    const g = itemGeom(db, id, 0, 0, rot);
    if (!g.cells.length) continue;
    const w = Math.max(...g.cells.map(c => c.x)), h = Math.max(...g.cells.map(c => c.y));
    for (let y = Y0; y + h <= Y1; y++) {
      for (let x = X0; x + w <= X1; x++) {
        const cells = g.cells.map(c => ({ x: c.x + x, y: c.y + y }));
        if (!cells.every(c => bagCells.has(`${c.x},${c.y}`))) continue;
        const hits = g.triggers.filter(t => edgeSet.has(`${t.x + x},${t.y + y},${(t.side) % 4}`)).length;
        out.push({
          x, y, rot, cells, hits,
          buffs: g.buffs.map(b => ({ x: b.x + x, y: b.y + y, buffType: b.buffType })),
        });
      }
    }
  }
  return out;
}

function isBowDef(d) {
  const st = d?.buffsMeta?.star;
  return d?.type === 'medium' && (d.tags || []).includes('ranged') && st?.triggerTarget && st?.targetTag === 'projectile';
}
function isArrowDef(d) {
  return d?.type === 'weapon' && (d.tags || []).includes('projectile');
}

const items = layout.items.map((it, i) => {
  const rot = it.rot ?? it.rotation ?? 0;
  const def = db[it.id] || {};
  const pls = placementsFor(it.id);
  let curIdx = pls.findIndex(p => p.x === it.x && p.y === it.y && p.rot === rot);
  if (curIdx < 0) {
    const g = itemGeom(db, it.id, it.x, it.y, rot);
    pls.push({
      x: it.x, y: it.y, rot, cells: g.cells,
      hits: g.triggers.filter(t => edgeSet.has(`${t.x},${t.y},${t.side}`)).length,
      buffs: g.buffs,
    });
    curIdx = pls.length - 1;
  }
  return {
    i, uid: it.uid, id: it.id, def, pls, curIdx,
    hitPls: pls.map((p, k) => k).filter(k => pls[k].hits > 0),
    starWeight: def.starBonus?.perItem ?? (def.counter && def.counter.pointTypes?.includes('star') ? 10 : (isBowDef(def) ? 40 : 1)),
    starFilter: (def.counter && def.counter.pointTypes?.includes('star'))
      ? { targetTag: def.counter.targetTag || null }
      : (def.buffsMeta?.star || (def.starBonus ? { targetType: def.starBonus.targetType } : null)),
  };
});

const W_TRIG = 10;
const MOVE_PENALTY = arg('penalty', 0.1);
const DEAD_PENALTY = arg('deadpen', 20);

function occupancy(state, ignore = -1) {
  const occ = new Map();
  for (let i = 0; i < items.length; i++) {
    if (i === ignore) continue;
    const p = items[i].pls[state[i]];
    if (!p) continue;
    for (const c of p.cells) { const k = `${c.x},${c.y}`; if (!occ.has(k)) occ.set(k, []); occ.get(k).push(i); }
  }
  return occ;
}

function evaluate(state) {
  const occ = new Map();
  let trig = 0;
  for (let i = 0; i < items.length; i++) {
    const p = items[i].pls[state[i]];
    if (!p) continue;
    trig += p.hits * W_TRIG;
    for (const c of p.cells) { const k = `${c.x},${c.y}`; if (!occ.has(k)) occ.set(k, []); occ.get(k).push(i); }
  }
  let starValue = 0, starPoints = 0;
  for (let i = 0; i < items.length; i++) {
    const p = items[i].pls[state[i]];
    if (!p) continue;
    const f = items[i].starFilter;
    for (const b of p.buffs) {
      if (b.buffType !== 'star' && b.buffType !== 'diamond') continue;
      const here = (occ.get(`${b.x},${b.y}`) || []).filter(j => j !== i);
      for (const j of here) {
        const tgt = items[j].def;
        if (f?.targetType && tgt.type !== f.targetType) continue;
        if (f?.targetTag && !(tgt.tags || []).includes(f.targetTag)) continue;
        if (f?.excludeTag && (tgt.tags || []).includes(f.excludeTag)) continue;
        starValue += items[i].starWeight;
        starPoints++;
        break;
      }
    }
  }
  // 弓的弹药槽：箭必须落在某把弓的 ☆ 位上，否则是死箭
  const bowStarCells = new Set();
  const bowIdx = [];
  for (let i = 0; i < items.length; i++) {
    if (!isBowDef(items[i].def)) continue;
    bowIdx.push(i);
    const p = items[i].pls[state[i]];
    if (!p) continue;
    for (const b of p.buffs) if (b.buffType === 'star') bowStarCells.add(`${b.x},${b.y}`);
  }
  let emptyBows = 0;
  for (const i of bowIdx) {
    const p = items[i].pls[state[i]];
    if (!p) continue;
    const loaded = p.buffs.some(b => b.buffType === 'star' && (occ.get(`${b.x},${b.y}`) || []).some(j => j !== i));
    if (!loaded) emptyBows++;
  }
  let deadArrows = 0;
  for (let i = 0; i < items.length; i++) {
    if (!isArrowDef(items[i].def)) continue;
    const p = items[i].pls[state[i]];
    if (!p) continue;
    if (!p.cells.some(c => bowStarCells.has(`${c.x},${c.y}`))) deadArrows++;
  }

  let moved = 0;
  for (let i = 0; i < items.length; i++) if (state[i] !== items[i].curIdx) moved++;
  const score = trig + starValue - moved * MOVE_PENALTY - deadArrows * DEAD_PENALTY - emptyBows * 50;
  return { score, trig, starValue, starPoints, moved, deadArrows, emptyBows };
}

function cellsFree(state, cells, ignore) {
  const occ = occupancy(state, ignore);
  return cells.every(c => !occ.has(`${c.x},${c.y}`));
}

// 在避开 ignore 集合的前提下，给 item j 找最优合法摆放
function bestAlternative(state, j, ignore) {
  const occ = occupancy(state, -1);
  const ignoreSet = new Set(ignore);
  let best = -1, bestScore = -Infinity;
  for (let k = 0; k < items[j].pls.length; k++) {
    if (k === state[j]) continue;
    const p = items[j].pls[k];
    let ok = true;
    for (const c of p.cells) {
      const holders = occ.get(`${c.x},${c.y}`) || [];
      if (holders.some(h => h !== j && !ignoreSet.has(h))) { ok = false; break; }
    }
    if (!ok) continue;
    const s = p.hits * W_TRIG;
    if (s > bestScore) { bestScore = s; best = k; }
  }
  return best;
}

// 链式替换：把 i 放到目标位，先挪开挡路的
function chainMove(state, i, targetK) {
  const p = items[i].pls[targetK];
  const occ = occupancy(state, i);
  const blockers = new Set();
  for (const c of p.cells) for (const h of (occ.get(`${c.x},${c.y}`) || [])) blockers.add(h);
  if (!blockers.size) {
    if (!cellsFree(state, p.cells, i)) return null;
    const st = state.slice(); st[i] = targetK; return st;
  }
  const st = state.slice();
  const ignore = [i];
  for (const b of blockers) {
    const k = bestAlternative(st, b, ignore);
    if (k < 0) return null;
    st[b] = k;
  }
  // 检查 i 目标位是否已空（被挪走的可能又占了）
  const occ2 = occupancy(st, i);
  if (!p.cells.every(c => !occ2.has(`${c.x},${c.y}`))) return null;
  st[i] = targetK;
  return st;
}

// ---------- 搜索 ----------
const rnd = n => Math.floor(Math.random() * n);
const startState = items.map(it => it.curIdx);
const startEval = evaluate(startState);
console.log(`初始: score=${startEval.score.toFixed(1)}  触发命中/圈=${startEval.trig / W_TRIG}  星位点=${startEval.starPoints}  加成值=${startEval.starValue}`);

let bestState = startState.slice(), bestEval = startEval;

for (let r = 0; r < RESTARTS; r++) {
  let state = startState.slice();
  if (r > 0) {
    for (let k = 0; k < 6; k++) {
      const i = rnd(items.length);
      const st2 = chainMove(state, i, rnd(items[i].pls.length));
      if (st2) state = st2;
    }
  }
  let cur = evaluate(state).score;
  let T = 25;
  for (let it = 0; it < ITERS; it++) {
    const useChain = Math.random() < 0.35;
    let ns = null, i = -1;
    if (useChain) {
      // 优先给"有可用命中位但未命中"的道具做链式替换
      const cands = items.filter(x => x.hitPls.length && x.pls[state[x.i]].hits === 0);
      i = cands.length ? cands[rnd(cands.length)].i : rnd(items.length);
      const tx = items[i].hitPls;
      const tk = tx.length ? tx[rnd(tx.length)] : rnd(items[i].pls.length);
      ns = chainMove(state, i, tk);
    } else {
      i = rnd(items.length);
      const t = rnd(items[i].pls.length);
      if (t === state[i]) continue;
      if (!cellsFree(state, items[i].pls[t].cells, i)) continue;
      ns = state.slice(); ns[i] = t;
    }
    if (!ns) continue;
    const val = evaluate(ns).score;
    const delta = val - cur;
    if (delta >= 0 || Math.random() < Math.exp(delta / T)) { state = ns; cur = val; }
    T = Math.max(0.5, T * 0.9995);
    const ev = evaluate(state);
    if (ev.score > bestEval.score) { bestEval = ev; bestState = state.slice(); }
  }
}

// ---------- 输出 ----------
const newItems = layout.items.map((it, i) => {
  const p = items[i].pls[bestState[i]];
  return { ...it, x: p.x, y: p.y, rot: p.rot, _from: { x: it.x, y: it.y, rot: it.rot ?? 0 }, _hitsFrom: items[i].pls[items[i].curIdx].hits, _hitsTo: p.hits };
});

console.log(`\n最优: score=${bestEval.score.toFixed(1)}  触发命中/圈=${bestEval.trig / W_TRIG}  星位点=${bestEval.starPoints}  加成值=${bestEval.starValue}  移动=${bestEval.moved}`);

console.log('\n=== 移动方案 ===');
let any = false;
for (const it of newItems) {
  const f = it._from;
  if (f.x !== it.x || f.y !== it.y || f.rot !== it.rot || it._hitsFrom !== it._hitsTo) {
    any = true;
    console.log(`  ${String(it.id).padEnd(22)} (${f.x},${f.y},r${f.rot}) → (${it.x},${it.y},r${it.rot})   命中 ${it._hitsFrom}→${it._hitsTo}`);
  }
}
if (!any) console.log('  (无需移动)');

const clean = newItems.map(({ _from, _hitsFrom, _hitsTo, ...rest }) => rest);
fs.writeFileSync('plan.json', JSON.stringify({ score: bestEval.score, items: clean }, null, 1), 'utf8');

const after = scoreLayout(db, { ...layout, items: clean });
console.log('\n=== 新布局 ===');
console.log(`球触发道具在轨: ${after.totals.ballTriggerOnTrack}/${after.totals.ballTriggerItems}   每圈总命中: ${after.totals.totalTriggerHits}`);
console.log(`星位覆盖: ${after.totals.starSatisfied}/${after.totals.starPoints}   格位占用: ${after.totals.occupiedCells}/${after.totals.bagCells}`);
console.log('已写入 plan.json');
