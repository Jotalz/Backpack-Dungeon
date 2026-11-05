// solve.mjs — 布局求解器
// usage: node solve.mjs [layout.json] [itemdb.json] [--movebags=1] [--penalty=0.4] [--deadpen=120] [--bagtime=15000]
import fs from 'node:fs';
import { itemGeom, computeTracks, scoreLayout } from './layout-lib.mjs';

const POS = process.argv.slice(2).filter(a => !a.startsWith('--'));
const layoutPath = POS[0] || 'layout.json';
const dbPath = POS[1] || 'itemdb.json';
const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith('--' + name + '='));
  return a ? Number(a.split('=')[1]) : def;
};
const RESTARTS = arg('restarts', 40);
const ITERS = arg('iters', 2000);
const MOVE_PENALTY = arg('penalty', 0.1);
const DEAD_PENALTY = arg('deadpen', 20);
const MOVE_BAGS = arg('movebags', 0) === 1;
const BAG_TIME = arg('bagtime', 15000);
const GRID_W = arg('gridW', 10);
const GRID_H = arg('gridH', 8);

const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8')).items;
const rnd = n => Math.floor(Math.random() * n);

function isBowDef(d) {
  const st = d?.buffsMeta?.star;
  return d?.type === 'medium' && (d.tags || []).includes('ranged') && st?.triggerTarget && st?.targetTag === 'projectile';
}
function isArrowDef(d) {
  return d?.type === 'weapon' && (d.tags || []).includes('projectile');
}
function bagCells(db, b) { return itemGeom(db, b.id, b.x, b.y, b.rot || 0).cells; }

// ---------- 模型 ----------
function buildModel(db, bags, layoutItems) {
  const bagSet = new Set();
  for (const b of bags) for (const c of bagCells(db, b)) bagSet.add(`${c.x},${c.y}`);
  const xs = [...bagSet].map(k => +k.split(',')[0]);
  const ys = [...bagSet].map(k => +k.split(',')[1]);
  const X0 = Math.min(...xs), X1 = Math.max(...xs), Y0 = Math.min(...ys), Y1 = Math.max(...ys);

  const tracks = computeTracks(db, bags);
  let main = tracks[0] || { edges: [] };
  for (const t of tracks) if (t.edges.length > main.edges.length) main = t;
  const edgeSet = new Set(main.edges.map(e => `${e.x},${e.y},${e.side}`));

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
          if (!cells.every(c => bagSet.has(`${c.x},${c.y}`))) continue;
          const hits = g.triggers.filter(t => edgeSet.has(`${t.x + x},${t.y + y},${t.side % 4}`)).length;
          out.push({
            x, y, rot, cells, hits,
            buffs: g.buffs.map(b => ({ x: b.x + x, y: b.y + y, buffType: b.buffType })),
          });
        }
      }
    }
    return out;
  }

  const items = layoutItems.map((it) => {
    const rot = it.rot ?? it.rotation ?? 0;
    const def = db[it.id] || {};
    const pls = placementsFor(it.id);
    let curIdx = pls.findIndex(p => p.x === it.x && p.y === it.y && p.rot === rot);
    if (curIdx < 0) {
      const g = itemGeom(db, it.id, it.x, it.y, rot);
      const inside = g.cells.length > 0 && g.cells.every(c => bagSet.has(`${c.x},${c.y}`));
      if (inside) {
        pls.push({
          x: it.x, y: it.y, rot, cells: g.cells,
          hits: g.triggers.filter(t => edgeSet.has(`${t.x},${t.y},${t.side}`)).length,
          buffs: g.buffs,
        });
        curIdx = pls.length - 1;
      } else {
        curIdx = -1;
      }
    }
    const isCtr = def.counter && def.counter.pointTypes?.includes('star');
    return {
      uid: it.uid, id: it.id, def, pls, curIdx, buffsMeta: def.buffsMeta || {}, hasTrigger: itemGeom(db, it.id, 0, 0, 0).triggers.length > 0,
      hitPls: pls.map((p, k) => k).filter(k => pls[k].hits > 0),
      starWeight: def.starBonus?.perItem ?? (isCtr ? 10 : (isBowDef(def) ? 40 : (def.buffsMeta?.star?.triggerOther ? 15 : 1))),
      starFilter: isCtr
        ? { targetTag: def.counter.targetTag || null }
        : (def.buffsMeta?.star || (def.starBonus ? { targetType: def.starBonus.targetType } : null)),
    };
  });

  return { bags, bagSet, edgeSet, items, nTracks: tracks.length, len: main.edges.length };
}

function occupancy(model, state, ignore = -1) {
  const occ = new Map();
  for (let i = 0; i < model.items.length; i++) {
    if (i === ignore) continue;
    const p = model.items[i].pls[state[i]];
    if (!p) continue;
    for (const c of p.cells) { const k = `${c.x},${c.y}`; if (!occ.has(k)) occ.set(k, []); occ.get(k).push(i); }
  }
  return occ;
}

function evaluate(model, state) {
  const occ = new Map();
  let trigRaw = 0;
  for (let i = 0; i < model.items.length; i++) {
    const p = model.items[i].pls[state[i]];
    if (!p) continue;
    trigRaw += p.hits;
    for (const c of p.cells) { const k = `${c.x},${c.y}`; if (!occ.has(k)) occ.set(k, []); occ.get(k).push(i); }
  }
  let starValue = 0, starPoints = 0;
  for (let i = 0; i < model.items.length; i++) {
    const p = model.items[i].pls[state[i]];
    if (!p) continue;
    const it = model.items[i];
    for (const b of p.buffs) {
      if (b.buffType !== 'star' && b.buffType !== 'diamond') continue;
      const f = it.buffsMeta?.[b.buffType] || (b.buffType === 'star' ? it.starFilter : null);
      const here = (occ.get(`${b.x},${b.y}`) || []).filter(j => j !== i);
      for (const j of here) {
        const tgt = model.items[j].def;
        if (f?.targetType && tgt.type !== f.targetType) continue;
        if (f?.targetTag && !(tgt.tags || []).includes(f.targetTag)) continue;
        if (f?.excludeTag && (tgt.tags || []).includes(f.excludeTag)) continue;
        starValue += (b.buffType === 'diamond' ? 10 : it.starWeight);
        starPoints++;
        break;
      }
    }
  }
  const bowStarCells = new Set();
  const bowIdx = [];
  for (let i = 0; i < model.items.length; i++) {
    if (!isBowDef(model.items[i].def)) continue;
    bowIdx.push(i);
    const p = model.items[i].pls[state[i]]; if (!p) continue;
    for (const b of p.buffs) if (b.buffType === 'star') bowStarCells.add(`${b.x},${b.y}`);
  }
  let emptyBows = 0;
  for (const i of bowIdx) {
    const p = model.items[i].pls[state[i]]; if (!p) continue;
    const loaded = p.buffs.some(b => b.buffType === 'star' && (occ.get(`${b.x},${b.y}`) || []).some(j => j !== i));
    if (!loaded) emptyBows++;
  }
  let offBall = 0;
  for (let i = 0; i < model.items.length; i++) {
    if (!model.items[i].hasTrigger) continue;
    const p = model.items[i].pls[state[i]];
    if (p && p.hits === 0) offBall++;
  }
  let deadArrows = 0;
  for (let i = 0; i < model.items.length; i++) {
    if (!isArrowDef(model.items[i].def)) continue;
    const p = model.items[i].pls[state[i]]; if (!p) continue;
    if (!p.cells.some(c => bowStarCells.has(`${c.x},${c.y}`))) deadArrows++;
  }
  let moved = 0;
  for (let i = 0; i < model.items.length; i++) if (state[i] !== model.items[i].curIdx) moved++;
  const len = Math.max(1, model.len || 1);
  const trig = trigRaw * 10 * (REF_LEN / len);
  const score = trig + starValue - moved * MOVE_PENALTY - deadArrows * DEAD_PENALTY - emptyBows * 50 - offBall * 40;
  return { score, trig, trigRaw, len, starValue, starPoints, moved, deadArrows, emptyBows, offBall };
}

function legal(state, model, i, p) {
  const taken = new Set();
  for (let j = 0; j < model.items.length; j++) {
    if (j === i) continue;
    const q = model.items[j].pls[state[j]]; if (!q) continue;
    for (const c of q.cells) taken.add(`${c.x},${c.y}`);
  }
  return p.cells.every(c => !taken.has(`${c.x},${c.y}`));
}

function bestAlternative(state, model, j, ignore) {
  const occ = occupancy(model, state);
  const ignoreSet = new Set(ignore);
  let best = -1, bestScore = -Infinity;
  for (let k = 0; k < model.items[j].pls.length; k++) {
    if (k === state[j]) continue;
    const p = model.items[j].pls[k];
    let ok = true;
    for (const c of p.cells) {
      const holders = occ.get(`${c.x},${c.y}`) || [];
      if (holders.some(h => h !== j && !ignoreSet.has(h))) { ok = false; break; }
    }
    if (!ok) continue;
    const s = p.hits * 10;
    if (s > bestScore) { bestScore = s; best = k; }
  }
  return best;
}

function chainMove(state, model, i, targetK) {
  const p = model.items[i].pls[targetK]; if (!p) return null;
  const occ = occupancy(model, state, i);
  const blockers = new Set();
  for (const c of p.cells) for (const h of (occ.get(`${c.x},${c.y}`) || [])) blockers.add(h);
  const st = state.slice();
  if (!blockers.size) {
    if (!p.cells.every(c => !(occupancy(model, st, i).has(`${c.x},${c.y}`)))) return null;
    st[i] = targetK; return st;
  }
  const ignore = [i];
  for (const b of blockers) {
    const k = bestAlternative(st, model, b, ignore);
    if (k < 0) return null;
    st[b] = k;
  }
  const occ2 = occupancy(model, st, i);
  if (!p.cells.every(c => !occ2.has(`${c.x},${c.y}`))) return null;
  st[i] = targetK;
  return st;
}

// ---------- 贪心打包（用于背包搜索的打分） ----------
function packInOrder(model, order) {
  const n = model.items.length;
  const state = new Array(n).fill(-1);
  const occ = new Set();
  for (const i of order) {
    let best = -1, bestS = -Infinity;
    for (let k = 0; k < model.items[i].pls.length; k++) {
      const p = model.items[i].pls[k];
      let ok = true;
      for (const c of p.cells) if (occ.has(`${c.x},${c.y}`)) { ok = false; break; }
      if (!ok) continue;
      const sc = p.hits * 10 + p.buffs.length * 2;
      if (sc > bestS) { bestS = sc; best = k; }
    }
    if (best < 0) return null;
    state[i] = best;
    for (const c of model.items[i].pls[best].cells) occ.add(`${c.x},${c.y}`);
  }
  return state;
}

function greedyPack(model, tries = 24) {
  const n = model.items.length;
  const base = [...Array(n).keys()].sort((a, b) => {
    const A = model.items[a], B = model.items[b];
    const sa = (A.def.counter && A.def.counter.pointTypes?.includes('star') ? 1 : 0) + (isBowDef(A.def) ? 1 : 0);
    const sb = (B.def.counter && B.def.counter.pointTypes?.includes('star') ? 1 : 0) + (isBowDef(B.def) ? 1 : 0);
    if (sa !== sb) return sb - sa;
    return (B.def.counter ? 1 : 0) - (A.def.counter ? 1 : 0);
  });
  let st = packInOrder(model, base);
  if (st) return st;
  // 固定顺序失败时，尝试多种随机顺序（放置是顺序敏感的）
  for (let t = 0; t < tries; t++) {
    const order = base.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = rnd(i + 1); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
    st = packInOrder(model, order);
    if (st) return st;
  }
  return null;
}

// ---------- 初始 ----------
const bags0 = layout.bags.map(b => ({ uid: b.uid, id: b.id, x: b.x, y: b.y, rot: b.rot ?? b.rotation ?? 0 }));
let model = buildModel(db, bags0, layout.items);
const REF_LEN = Math.max(1, model.len || 1);
const startState = model.items.map(it => it.curIdx);
const startEval = evaluate(model, startState);
console.log(`初始: score=${startEval.score.toFixed(1)}  触发命中/圈=${startEval.trig / 10}  星位点=${startEval.starPoints}  加成值=${startEval.starValue}`);

// ---------- 背包搜索 ----------
let bestBags = bags0.map(b => ({ ...b }));
let bestBagsState = null;
let bestBagsScore = startEval.score;
if (MOVE_BAGS) {
  const t0 = Date.now();
  const basePack = greedyPack(model);
  let bestBagsScore = basePack ? evaluate(model, basePack).score : startEval.score;
  console.log(`背包基准(贪心同布局): ${bestBagsScore.toFixed(1)}`);
  let attempts = 0, accepted = 0;
  while (Date.now() - t0 < BAG_TIME) {
    attempts++;
    const i = rnd(bestBags.length);
    const cand = bestBags.map(b => ({ ...b }));
    const b = cand[i];
    if (Math.random() < 0.45) {
      let sx = 0, sy = 0, n = 0;
      for (let j = 0; j < cand.length; j++) { if (j === i) continue; sx += cand[j].x; sy += cand[j].y; n++; }
      const cx = sx / Math.max(1, n), cy = sy / Math.max(1, n);
      const dx = Math.sign(Math.round(cx - b.x)), dy = Math.sign(Math.round(cy - b.y));
      if (dx && (!dy || Math.random() < 0.5)) b.x += dx;
      else if (dy) b.y += dy;
      else b.x += Math.random() < 0.5 ? -1 : 1;
    } else if (Math.random() < 0.75) {
      b.x += Math.random() < 0.5 ? -1 : 1;
      if (Math.random() < 0.25) b.y += Math.random() < 0.5 ? -1 : 1;
    } else {
      b.rot = (b.rot + (Math.random() < 0.5 ? 1 : 3)) % 4;
    }
    const cells = bagCells(db, b);
    if (!cells.length) continue;
    if (cells.some(c => c.x < 0 || c.y < 0 || c.x >= GRID_W || c.y >= GRID_H)) continue;
    const others = new Set();
    for (let j = 0; j < cand.length; j++) {
      if (j === i) continue;
      for (const c of bagCells(db, cand[j])) others.add(`${c.x},${c.y}`);
    }
    if (cells.some(c => others.has(`${c.x},${c.y}`))) continue;
    const m2 = buildModel(db, cand, layout.items);
    const st = greedyPack(m2);
    if (!st) continue;
    const sc = evaluate(m2, st).score;
    if (sc > bestBagsScore || (sc === bestBagsScore && Math.random() < 0.35)) { if (sc > bestBagsScore) { bestBagsScore = sc; accepted++; } bestBags = cand; bestBagsState = st; }
  }
  console.log(`背包搜索: ${attempts} 次尝试, 接受 ${accepted} 次, 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  model = buildModel(db, bestBags, layout.items);
}

// ---------- 道具搜索 ----------
let bestState = null, bestEval = null;
{
  const g = bestBagsState || greedyPack(model);
  if (!g) {
    console.error('当前布局存在无法放进背包的道具，请先在游戏里整理或重新 dump 后再求解');
    process.exit(2);
  }
  bestEval = evaluate(model, g); bestState = g.slice();
}
for (let r = 0; r < RESTARTS; r++) {
  let state = bestState.slice();
  let cur = evaluate(model, state).score;
  let T = 25;
  for (let it = 0; it < ITERS; it++) {
    const useChain = Math.random() < 0.35;
    let ns = null, i = -1;
    if (useChain) {
      const pool = [];
      for (let k = 0; k < model.items.length; k++) if (model.items[k].hitPls.length && model.items[k].pls[state[k]] && model.items[k].pls[state[k]].hits === 0) pool.push(k);
      i = pool.length ? pool[rnd(pool.length)] : rnd(model.items.length);
      const tx = model.items[i].hitPls;
      const tk = tx.length ? tx[rnd(tx.length)] : rnd(model.items[i].pls.length);
      ns = chainMove(state, model, i, tk);
    } else {
      i = rnd(model.items.length);
      const t = rnd(model.items[i].pls.length);
      if (t === state[i]) continue;
      if (!legal(state, model, i, model.items[i].pls[t])) continue;
      ns = state.slice(); ns[i] = t;
    }
    if (!ns) continue;
    const val = evaluate(model, ns).score;
    const delta = val - cur;
    if (delta >= 0 || Math.random() < Math.exp(delta / T)) { state = ns; cur = val; }
    T = Math.max(0.5, T * 0.9995);
    const ev = evaluate(model, state);
    if (ev.score > bestEval.score) { bestEval = ev; bestState = state.slice(); }
  }
}

// ---------- 输出 ----------
const newItems = layout.items.map((it, i) => {
  const p = model.items[i].pls[bestState[i]];
  if (!p) { console.error('求解失败：有道具未被放置'); process.exit(3); }
  return { ...it, x: p.x, y: p.y, rot: p.rot };
});
{
  const bagSet = new Set();
  for (const b of bestBags) for (const c of bagCells(db, b)) bagSet.add(`${c.x},${c.y}`);
  const occ = new Set();
  for (const it of newItems) {
    for (const c of itemGeom(db, it.id, it.x, it.y, it.rot || 0).cells) {
      const k = `${c.x},${c.y}`;
      if (!bagSet.has(k)) { console.error('方案非法：' + it.id + ' 超出背包，已中止'); process.exit(4); }
      if (occ.has(k)) { console.error('方案非法：' + it.id + ' 与其他道具重叠，已中止'); process.exit(4); }
      occ.add(k);
    }
  }
}

console.log(`\n最优: score=${bestEval.score.toFixed(1)}  轨道=${model.nTracks}条/${model.len}格  触发命中/圈=${bestEval.trigRaw}  星位点=${bestEval.starPoints}  加成值=${bestEval.starValue}  移动=${bestEval.moved}  死箭=${bestEval.deadArrows}  空弓=${bestEval.emptyBows}`);

console.log('\n=== 背包移动 ===');
let bagMoved = 0;
bags0.forEach((b, i) => {
  const n = bestBags[i];
  if (b.x !== n.x || b.y !== n.y || b.rot !== n.rot) {
    bagMoved++;
    console.log(`  ${String(b.id).padEnd(20)} (${b.x},${b.y},r${b.rot}) → (${n.x},${n.y},r${n.rot})`);
  }
});
if (!bagMoved) console.log('  (未移动背包)');

console.log('\n=== 道具移动 ===');
let itemMoved = 0;
layout.items.forEach((it, i) => {
  const p = newItems[i];
  if (it.x !== p.x || it.y !== p.y || (it.rot ?? 0) !== p.rot) {
    itemMoved++;
    if (itemMoved <= 40) console.log(`  ${String(it.id).padEnd(22)} (${it.x},${it.y},r${it.rot ?? 0}) → (${p.x},${p.y},r${p.rot})`);
  }
});
if (!itemMoved) console.log('  (无需移动)');
else if (itemMoved > 40) console.log(`  ... 共 ${itemMoved} 件`);

fs.writeFileSync('plan.json', JSON.stringify({ score: bestEval.score, bags: bestBags, items: newItems }, null, 1), 'utf8');

const after = scoreLayout(db, { ...layout, bags: bestBags, items: newItems });
console.log('\n=== 新布局 ===');
console.log(`球触发道具在轨: ${after.totals.ballTriggerOnTrack}/${after.totals.ballTriggerItems}   每圈总命中: ${after.totals.totalTriggerHits}`);
console.log(`星位覆盖: ${after.totals.starSatisfied}/${after.totals.starPoints}   弓: ${after.totals.bowsWithAmmo}/${after.totals.bows}   死箭: ${after.totals.deadArrows}   重叠: ${after.warnings.overlaps.length}`);
console.log('已写入 plan.json');
