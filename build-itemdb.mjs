#!/usr/bin/env node
// Build a classified item database from the minified bundle.
// usage: node build-itemdb.mjs [game.js] [items.json] [out.json]
import fs from 'node:fs';

const gamePath = process.argv[2] || 'game.js';
const itemsPath = process.argv[3] || 'items.json';
const outPath = process.argv[4] || 'itemdb.json';

const text = fs.readFileSync(gamePath, 'utf8');

function findObjEnd(t, start) {
  let depth = 0, inStr = null, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && t[i + 1] === '*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findItemObject(id) {
  const idRe = new RegExp('id\\s*:\\s*"' + id + '"');
  let from = 0;
  while (true) {
    const pos = text.indexOf('id: "' + id + '"', from);
    if (pos < 0) break;
    from = pos + 8;
    let brace = -1;
    for (let i = pos - 1; i >= 0 && i > pos - 40; i--) {
      if (text[i] === '{') { brace = i; break; }
    }
    if (brace < 0) continue;
    const end = findObjEnd(text, brace);
    if (end < 0) continue;
    const body = text.slice(brace, end + 1);
    if (body.length > 200000) continue;
    if (!idRe.test(body)) continue;
    if (!/name\s*:/.test(body)) continue;
    return body;
  }
  return null;
}

function unescapeStr(s) {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function extractShape(body) {
  let m = /shapePattern\s*:\s*`([^`]*)`/.exec(body);
  if (m) return m[1];
  m = /shapePattern\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  if (m) return unescapeStr(m[1]);
  m = /shapePattern\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(body);
  if (m) return unescapeStr(m[1]);
  return null;
}

let items = [];
try { items = JSON.parse(fs.readFileSync(itemsPath, 'utf8')); } catch {}
const idSet = new Set(items.map(x => x.id));
for (const m of text.matchAll(/(?:^|[,{\s])id\s*:\s*"([A-Za-z0-9_]+)"/g)) idSet.add(m[1]);
const ids = [...idSet];

const db = {};
const missing = [];

for (const id of ids) {
  const body = findItemObject(id);
  if (!body) { missing.push(id); continue; }

  const shape = extractShape(body);
  const markers = {};
  if (shape) {
    for (const ch of shape) {
      if (!ch.trim()) continue;
      markers[ch] = (markers[ch] || 0) + 1;
    }
  }

  const nameMatch = /name\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  const typeMatch = /(?:^|[,{\s])type\s*:\s*"([^"]+)"/.exec(body);
  const rarityMatch = /rarity\s*:\s*"([^"]+)"/.exec(body);
  const tagsMatch = /(?:^|[,{\s])tags\s*:\s*\[([^\]]*)\]/.exec(body);

  let ballCells = false, mediumSelf = false;
  const tteMatch = /triggerTypeEffects\s*:\s*\{/.exec(body);
  if (tteMatch) {
    const tteStart = tteMatch.index + tteMatch[0].length - 1;
    const tteEnd = findObjEnd(body, tteStart);
    const tteBody = tteEnd > 0 ? body.slice(tteStart, tteEnd + 1) : '';
    const keyRe = /(?:^|[,{\s])(circle|line|self|cross|square|diamond|star|rect|arc|row|column)\s*:/g;
    let km;
    while ((km = keyRe.exec(tteBody))) {
      if (km[1] === 'self') mediumSelf = true; else ballCells = true;
    }
    if (!ballCells && !mediumSelf) ballCells = true;
  }

  const bagVoid = /bagVoid\s*:\s*true/.test(body);
  const buffsMeta = {};
  const bm = /(?:^|[,{\s])buffs\s*:\s*\{/.exec(body);
  if (bm) {
    const bs = bm.index + bm[0].length - 1;
    const be = findObjEnd(body, bs);
    const bb = be > 0 ? body.slice(bs, be + 1) : '';
    for (const km of bb.matchAll(/(?:^|[,{\s])([A-Za-z]+)\s*:\s*\{/g)) {
      const ss = km.index + km[0].length - 1;
      const se = findObjEnd(bb, ss);
      if (se < 0) continue;
      const sb = bb.slice(ss, se + 1);
      const tt = /targetType\s*:\s*"([^"]+)"/.exec(sb);
      const tg = /targetTag\s*:\s*"([^"]+)"/.exec(sb);
      const ex = /excludeTag\s*:\s*"([^"]+)"/.exec(sb);
      buffsMeta[km[1]] = {
        targetType: tt ? tt[1] : null, targetTag: tg ? tg[1] : null, excludeTag: ex ? ex[1] : null,
        triggerTarget: /triggerTarget\s*:\s*true/.test(sb),
        damageAllEnemies: /damageAllEnemies\s*:\s*true/.test(sb),
        randomTrigger: /randomTriggerTarget\s*:/.test(sb),
        triggerOther: /triggerOtherTargetsOnTrigger\s*:/.test(sb),
      };
    }
  }

  let counter = null;
  const cm = /counterConfig\s*:\s*\{/.exec(body);
  if (cm) {
    const cs = cm.index + cm[0].length - 1;
    const ce = findObjEnd(body, cs);
    const cb = ce > 0 ? body.slice(cs, ce + 1) : '';
    const tag = /countTargetTag\s*:\s*"([^"]+)"/.exec(cb);
    const pts = /countBuffPointTypes\s*:\s*\[([^\]]*)\]/.exec(cb);
    const maxc = /maxCount\s*:\s*(\d+)/.exec(cb);
    counter = {
      targetTag: tag ? tag[1] : null,
      pointTypes: pts ? pts[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [],
      maxCount: maxc ? Number(maxc[1]) : null,
    };
  }

  const sbMatch = /buffBonusPerItem\s*:\s*(\d+)/.exec(body);
  const sbType = /buffTargetType\s*:\s*"([^"]+)"/.exec(body);
  const starBonus = sbMatch ? { perItem: Number(sbMatch[1]), targetType: sbType ? sbType[1] : null } : null;

  const hasBattleStart = /battleStartStatuses\s*:/.test(body);
  const hasArmorBlock = /onArmorBlock\s*:/.test(body);
  const hasLoopComplete = /onLoopComplete\s*:/.test(body);
  const hasBuffs = /(?:^|[,{\s])buffs\s*:\s*\{/.test(body);
  const hasOtherEvent = /(onHit|onKill|onCrit|onDodge|onBlock|onEquip|periodicEffect|onEachLoop|onAttack)\s*:/.test(body);
  const hasStats = /(?:^|[,{\s])stats\s*:\s*\{/.test(body);

  let cls;
  if (ballCells) cls = 'ball';
  else if (mediumSelf) cls = 'medium';
  else if (hasBattleStart || hasArmorBlock || hasLoopComplete || hasOtherEvent || hasBuffs) cls = 'passive';
  else cls = 'static';

  db[id] = {
    id,
    name: nameMatch ? nameMatch[1] : id,
    type: typeMatch ? typeMatch[1] : null,
    rarity: rarityMatch ? rarityMatch[1] : null,
    cls,
    ballTrigger: ballCells,
    mediumTrigger: mediumSelf,
    passive: { battleStart: hasBattleStart, armorBlock: hasArmorBlock, loopComplete: hasLoopComplete, buffs: hasBuffs, otherEvent: hasOtherEvent },
    positional: hasBuffs,
    stars: markers['☆'] || 0,
    markers,
    shape,
    bagVoid: !!bagVoid,
    buffsMeta,
    counter,
    starBonus,
    tags: tagsMatch ? tagsMatch[1].replace(/["\s]/g, '').split(',').filter(Boolean) : [],
  };
}

const stats = { ball: 0, medium: 0, passive: 0, static: 0 };
for (const k in db) stats[db[k].cls]++;

fs.writeFileSync(outPath, JSON.stringify({
  generatedFrom: { game: gamePath, items: itemsPath },
  stats, total: Object.keys(db).length, missing, items: db,
}, null, 1), 'utf8');

console.log('parsed =', Object.keys(db).length, '/', ids.length);
console.log('classes:', stats);
console.log('missing:', missing.length, missing.slice(0, 12).join(', '));
console.log('wrote', outPath);
