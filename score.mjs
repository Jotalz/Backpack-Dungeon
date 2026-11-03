// score.mjs — 布局评分器 CLI
// usage: node score.mjs [layout.json] [itemdb.json]
import fs from 'node:fs';
import { scoreLayout, renderGrid } from './layout-lib.mjs';

const layoutPath = process.argv[2] || 'layout.json';
const dbPath = process.argv[3] || 'itemdb.json';

const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8')).items;

const r = scoreLayout(db, layout);

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log('=== 轨道 ===');
for (const t of r.tracks) {
  console.log(`${t.main ? '→' : ' '} track${t.index}: ${lpad(t.edges, 3)} 格  一圈≈${t.loopSeconds.toFixed(1)}s  背包[${t.bags.join(',')}]`);
  console.log(`    可触发: ${t.triggered.length ? t.triggered.join(', ') : '(无)'}`);
}

console.log('\n=== 球触发道具 ===');
console.log(pad('道具', 24) + pad('位置', 8) + pad('触发点', 7) + pad('命中', 6) + '状态');
const ballItems = r.items.filter(i => i.triggers.length > 0).sort((a, b) => b.triggerHits - a.triggerHits || a.id.localeCompare(b.id));
for (const it of ballItems) {
  console.log(pad(it.id, 24) + pad(`${it.x},${it.y}`, 8) + pad(it.triggers.length, 7) + pad(it.triggerHits, 6) + (it.onTrack ? '在轨道上' : '★ 环外(0触发)'));
}

console.log('\n=== 弓 / 弹药 ===');
console.log(pad('弓', 24) + pad('位置', 8) + pad('装填', 8) + '状态');
for (const b of r.ammoReport) {
  console.log(pad(b.id, 24) + pad(`${b.x},${b.y}`, 8) + pad(`${b.loaded}/${b.slots}`, 8) + (b.loaded > 0 ? '' : '★ 无弹药'));
}
if (r.deadArrows.length) console.log('⚠ 死箭(不在任何弓的星位): ' + r.deadArrows.join(', '));

console.log('\n=== 星位/菱形位 ===');
console.log(pad('道具', 24) + pad('点数', 6) + pad('已覆盖', 8) + '每件加成');
for (const s of r.starReport.sort((a, b) => (b.points - b.satisfied) - (a.points - a.satisfied))) {
  const waste = s.points - s.satisfied;
  console.log(pad(s.id, 24) + pad(s.points, 6) + pad(`${s.satisfied}/${s.points}`, 8) + (s.perItem ? `+${s.perItem}/件` : '') + (waste > 0 ? `  (${waste} 空)` : ''));
}

console.log('\n=== 汇总 ===');
const T = r.totals;
console.log(`道具 ${T.items}  球触发类 ${T.ballTriggerItems} (在轨道 ${T.ballTriggerOnTrack})  预计每圈总触发 ${T.totalTriggerHits}`);
console.log(`星位 ${T.starSatisfied}/${T.starPoints} 被覆盖  格位占用 ${T.occupiedCells}/${T.bagCells} (${(T.fillRate * 100).toFixed(0)}%)`);
console.log(`主轨道 ${r.main.edges.length} 格，一圈约 ${r.loopSeconds.toFixed(1)}s`);

const W = r.warnings;
if (W.offTrackBall.length) console.log('\n⚠ 球触发道具在环外: ' + W.offTrackBall.join(', '));
if (W.overlaps.length) console.log('⚠ 道具重叠: ' + W.overlaps.map(o => `${o.cell}[${o.ids.join('+')}]`).join(', '));
if (W.outside.length) console.log('⚠ 道具超出背包: ' + W.outside.join(', '));
if (W.unknown.length) console.log('⚠ 无形状数据: ' + W.unknown.join(', '));

console.log('\n' + renderGrid(r));
