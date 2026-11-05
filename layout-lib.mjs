// layout-lib.mjs — 精确复刻游戏引擎的几何/轨道/触发模型
// 已对当前布局验证: 轨道 22/22 完全一致, 球触发预测与实测一致

export function parseShape(pattern) {
  if (!pattern) return { cells: [], triggers: [], buffs: [] };
  const lines = pattern.trim().split('\n').map(l => l.trim());
  const cells = [], circ = [], dia = [], buffs = [];
  lines.forEach((line, y) => {
    [...line].forEach((ch, x) => {
      if (ch === '▣') cells.push({ x, y });
      else if (ch === '◉') circ.push({ x, y });
      else if (ch === '◆') dia.push({ x, y });
      else if (ch === '☆') buffs.push({ x, y, buffType: 'star' });
      else if (ch === '◇') buffs.push({ x, y, buffType: 'diamond' });
      else if (ch === '○') buffs.push({ x, y, buffType: 'circle' });
    });
  });
  if (!cells.length) return { cells: [], triggers: [], buffs: [] };
  const minX = Math.min(...cells.map(c => c.x)), minY = Math.min(...cells.map(c => c.y));
  const n = q => ({ x: q.x - minX, y: q.y - minY });
  const nCells = cells.map(n);
  const set = new Set(nCells.map(c => `${c.x},${c.y}`));
  const trig = [];
  for (const t0 of circ.concat(dia)) {
    const t = n(t0);
    for (const [dx, dy, side] of [[0, 1, 0], [-1, 0, 1], [0, -1, 2], [1, 0, 3]]) {
      if (set.has(`${t.x + dx},${t.y + dy}`)) { trig.push({ x: t.x + dx, y: t.y + dy, side }); break; }
    }
  }
  const nBuff = q => ({ x: q.x - minX, y: q.y - minY, buffType: q.buffType });
  return { cells: nCells, triggers: trig, buffs: buffs.map(nBuff) };
}

function rotCell(c, r) {
  let { x, y } = c;
  for (let i = 0; i < (r % 4 + 4) % 4; i++) { const nx = -y, ny = x; x = nx; y = ny; }
  return { x, y };
}

export function itemGeom(db, id, x, y, rot) {
  const def = db[id];
  if (!def || !def.shape) return { cells: [], triggers: [], buffs: [], unknown: true };
  const p = parseShape(def.shape);
  if (!p.cells.length) return { cells: [], triggers: [], buffs: [] };
  const r = (rot || 0) % 4;
  const rc = p.cells.map(c => rotCell(c, r));
  const minX = Math.min(...rc.map(c => c.x)), minY = Math.min(...rc.map(c => c.y));
  const abs = c => ({ x: c.x - minX + x, y: c.y - minY + y });
  return {
    cells: rc.map(abs),
    triggers: p.triggers.map(t => { const q = rotCell(t, r); return { x: q.x - minX + x, y: q.y - minY + y, side: (t.side + r) % 4 }; }),
    buffs: p.buffs.map(b => { const q = rotCell(b, r); return { x: q.x - minX + x, y: q.y - minY + y, buffType: b.buffType }; }),
  };
}

export function contour(cells) {
  const grid = new Set(cells.map(c => `${c.x},${c.y}`));
  if (!grid.size) return [];
  let minX = Infinity, minY = Infinity;
  for (const c of cells) if (c.y < minY || (c.y === minY && c.x < minX)) { minX = c.x; minY = c.y; }
  const isBag = (x, y) => grid.has(`${x},${y}`);
  const out = [];
  let hx = minX, hy = minY, facing = 1, steps = 0;
  do {
    if (facing === 1) out.push({ x: hx, y: hy, side: 0 });
    else if (facing === 2) out.push({ x: hx - 1, y: hy, side: 1 });
    else if (facing === 3) out.push({ x: hx - 1, y: hy - 1, side: 2 });
    else out.push({ x: hx, y: hy - 1, side: 3 });
    if (facing === 1) hx++; else if (facing === 2) hy++; else if (facing === 3) hx--; else hy--;
    const nf = facing === 1 ? (!isBag(hx, hy) ? 2 : (!isBag(hx, hy - 1) ? 1 : 0))
      : facing === 2 ? (!isBag(hx - 1, hy) ? 3 : (!isBag(hx, hy) ? 2 : 1))
      : facing === 3 ? (!isBag(hx - 1, hy - 1) ? 0 : (!isBag(hx - 1, hy) ? 3 : 2))
      : (!isBag(hx, hy - 1) ? 1 : (!isBag(hx - 1, hy - 1) ? 0 : 3));
    facing = nf; steps++;
  } while ((hx !== minX || hy !== minY || facing !== 1) && steps < 300);
  return out;
}

export function computeTracks(db, bags) {
  const list = bags.map((b, i) => ({ ...b, rot: b.rot ?? b.rotation ?? 0, _i: i, cells: itemGeom(db, b.id, b.x, b.y, b.rot ?? b.rotation ?? 0).cells }))
    .filter(b => b.cells.length && !db[b.id]?.bagVoid);
  const cellToBag = new Map();
  for (const b of list) for (const c of b.cells) cellToBag.set(`${c.x},${c.y}`, b);
  const parent = new Map(list.map(b => [b._i, b._i]));
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const union = (a, b) => { const pa = find(a), pb = find(b); if (pa !== pb) parent.set(pa, pb); };
  for (const [k, b] of cellToBag) {
    const [x, y] = k.split(',').map(Number);
    for (const nk of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
      const nb = cellToBag.get(nk);
      if (nb && nb._i !== b._i) union(b._i, nb._i);
    }
  }
  const groups = new Map();
  for (const b of list) { const r = find(b._i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b); }
  return [...groups.values()].map(g => ({
    bags: g.map(b => ({ id: b.id, x: b.x, y: b.y, rot: b.rot })),
    cells: g.flatMap(b => b.cells),
    edges: contour(g.flatMap(b => b.cells)),
  }));
}

export function scoreLayout(db, layout, opts = {}) {
  const tracks = computeTracks(db, layout.bags || []);
  let mainIdx = -1, best = -1;
  tracks.forEach((t, i) => { if (t.edges.length > best) { best = t.edges.length; mainIdx = i; } });
  const main = tracks[mainIdx] || { edges: [], bags: [], cells: [] };
  const edgeSet = new Set(main.edges.map(e => `${e.x},${e.y},${e.side}`));
  const baseSpeed = opts.baseSpeed ?? 5;
  const minLoop = opts.minLoopTimeSeconds ?? 2;

  const occ = new Map();
  const items = (layout.items || []).map(it => {
    const rot = it.rot ?? it.rotation ?? 0;
    const g = itemGeom(db, it.id, it.x, it.y, rot);
    const def = db[it.id] || {};
    const hits = g.triggers.filter(t => edgeSet.has(`${t.x},${t.y},${t.side}`));
    const rec = {
      uid: it.uid, id: it.id, name: def.name || it.id, type: def.type || null,
      x: it.x, y: it.y, rot, cells: g.cells, triggers: g.triggers, buffs: g.buffs,
      triggerHits: hits.length, onTrack: hits.length > 0,
      starBonus: def.starBonus || null, buffsMeta: def.buffsMeta || {}, counter: def.counter || null,
    };
    for (const c of g.cells) { const k = `${c.x},${c.y}`; if (!occ.has(k)) occ.set(k, []); occ.get(k).push(rec); }
    return rec;
  });

  const bagCells = new Set();
  const bagCellList = [];
  for (const b of (layout.bags || [])) {
    for (const c of itemGeom(db, b.id, b.x, b.y, b.rot ?? b.rotation ?? 0).cells) {
      const k = `${c.x},${c.y}`; if (!bagCells.has(k)) { bagCells.add(k); bagCellList.push(k); }
    }
  }

  const filterOk = (f, tgt) => {
    if (!f) return true;
    if (f.targetType && tgt.type !== f.targetType) return false;
    if (f.targetTag && !(db[tgt.id]?.tags || []).includes(f.targetTag)) return false;
    if (f.excludeTag && (db[tgt.id]?.tags || []).includes(f.excludeTag)) return false;
    return true;
  };

  const isBowDef = id => {
    const d = db[id] || {};
    const s = d.buffsMeta?.star;
    return d.type === 'medium' && (d.tags || []).includes('ranged') && s?.triggerTarget && s?.targetTag === 'projectile';
  };
  const isArrowDef = id => {
    const d = db[id] || {};
    return d.type === 'weapon' && (d.tags || []).includes('projectile');
  };

  // 弓的弹药槽：弓的 ☆ 位需要放 projectile 武器
  const bowStars = new Map(); // "x,y" -> [{bowUid, filter}]
  for (const it of items) {
    if (!isBowDef(it.id)) continue;
    const f = db[it.id]?.buffsMeta?.star || null;
    for (const b of it.buffs) {
      if (b.buffType !== 'star') continue;
      const k = `${b.x},${b.y}`;
      if (!bowStars.has(k)) bowStars.set(k, []);
      bowStars.get(k).push({ bowUid: it.uid, filter: f });
    }
  }

  const ammoReport = [];
  for (const it of items) {
    if (!isBowDef(it.id)) continue;
    const f = db[it.id]?.buffsMeta?.star || null;
    let loaded = 0, slots = 0;
    for (const b of it.buffs) {
      if (b.buffType !== 'star') continue;
      slots++;
      const here = (occ.get(`${b.x},${b.y}`) || []).filter(o => o.uid !== it.uid);
      if (here.some(o => isArrowDef(o.id) && filterOk(f, o))) loaded++;
    }
    ammoReport.push({ id: it.id, name: it.name, x: it.x, y: it.y, slots, loaded });
  }

  const deadArrows = items.filter(it => isArrowDef(it.id) && !it.cells.some(c => bowStars.has(`${c.x},${c.y}`))).map(it => `${it.id}@${it.x},${it.y}`);

  let starPoints = 0, starSatisfied = 0;
  const starReport = [];
  for (const src of items) {
    const pts = src.buffs.filter(b => b.buffType === 'star' || b.buffType === 'diamond');
    if (!pts.length) continue;
    const ctr = src.counter;
    let sat = 0;
    for (const p of pts) {
      let filter = src.buffsMeta?.[p.buffType] || null;
      if (!filter && p.buffType === 'star' && ctr && ctr.pointTypes && ctr.pointTypes.includes('star')) filter = { targetTag: ctr.targetTag || null };
      if (!filter && p.buffType === 'star' && src.starBonus) filter = { targetType: src.starBonus.targetType };
      const here = (occ.get(`${p.x},${p.y}`) || []).filter(o => o.uid !== src.uid);
      if (here.some(o => filterOk(filter, o))) sat++;
    }
    starPoints += pts.length; starSatisfied += sat;
    starReport.push({ id: src.id, name: src.name, points: pts.length, satisfied: sat, perItem: src.starBonus?.perItem ?? null });
  }

  const offTrackBall = items.filter(i => i.triggers.length > 0 && !i.onTrack);
  const overlaps = [...occ.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ cell: k, ids: v.map(x => x.id) }));
  const outside = items.filter(i => i.cells.length && i.cells.some(c => !bagCells.has(`${c.x},${c.y}`))).map(i => i.id);
  const unknown = items.filter(i => !i.cells.length).map(i => i.id);

  const loopSeconds = Math.max(minLoop, main.edges.length / baseSpeed);

  return {
    tracks: tracks.map((t, i) => ({
      index: i, main: i === mainIdx, edges: t.edges.length,
      bags: t.bags.map(b => b.id),
      loopSeconds: Math.max(minLoop, t.edges.length / baseSpeed),
      triggered: items.filter(it => t.edges.some(e => `${e.x},${e.y},${e.side}`) && it.triggers.some(x => t.edges.some(e => e.x === x.x && e.y === x.y && e.side === x.side))).map(it => it.id),
    })),
    main,
    loopSeconds,
    items,
    totals: {
      items: items.length,
      ballTriggerItems: items.filter(i => i.triggers.length > 0).length,
      ballTriggerOnTrack: items.filter(i => i.triggers.length > 0 && i.onTrack).length,
      totalTriggerHits: items.reduce((s, i) => s + i.triggerHits, 0),
      starPoints, starSatisfied,
      bows: ammoReport.length, bowsWithAmmo: ammoReport.filter(a=>a.loaded>0).length, ammoLoaded: ammoReport.reduce((a,b)=>a+b.loaded,0), ammoSlots: ammoReport.reduce((a,b)=>a+b.slots,0), deadArrows: deadArrows.length,
      bagCells: bagCells.size,
      occupiedCells: [...occ.keys()].filter(k => bagCells.has(k)).length,
      fillRate: bagCells.size ? ([...occ.keys()].filter(k => bagCells.has(k)).length / bagCells.size) : 0,
    },
    warnings: { offTrackBall: offTrackBall.map(i => `${i.id}@${i.x},${i.y}(${i.id})`), overlaps, outside, unknown },
    starReport,
    ammoReport,
    deadArrows,
    occupancy: occ,
    bagCells,
  };
}

export function renderGrid(result) {
  const xs = [], ys = [];
  for (const k of result.bagCells) { const [x, y] = k.split(',').map(Number); xs.push(x); ys.push(y); }
  if (!xs.length) return '';
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const edges = new Set(result.main.edges.map(e => `${e.x},${e.y},${e.side}`));
  const star = new Set();
  for (const it of result.items) for (const b of it.buffs) if (b.buffType === 'star') star.add(`${b.x},${b.y}`);
  const rows = [];
  rows.push('    ' + Array.from({ length: x1 - x0 + 1 }, (_, i) => String(x0 + i).padStart(2)).join(''));
  for (let y = y0; y <= y1; y++) {
    let line = String(y).padStart(3) + ' ';
    for (let x = x0; x <= x1; x++) {
      const k = `${x},${y}`;
      const inBag = result.bagCells.has(k);
      const isStar = star.has(k);
      let ch = inBag ? (isStar ? '*' : '.') : ' ';
      if (!inBag && isStar) ch = '*';
      const hitEdge = ['0', '1', '2', '3'].some(s => edges.has(`${x},${y},${s}`));
      if (hitEdge) ch = inBag ? '=' : '=';
      if (isStar && hitEdge) ch = '@';
      line += ' ' + ch;
    }
    rows.push(line);
  }
  rows.push('  图例: =轨道经过  *星位(空)  @星位且在轨道上  .背包空格');
  return rows.join('\n');
}
