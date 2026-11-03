import fs from 'node:fs';
const db = JSON.parse(fs.readFileSync('itemdb.json', 'utf8'));
console.log('stats', JSON.stringify(db.stats), 'total', db.total, 'missing', db.missing.length);
const check = ['frost_armor', 'rampage_boots', 'feather_arrow', 'gale_bow', 'short_bow', 'voodoo_doll',
  'guardian_fairy', 'baby_fire_dragon', 'lucky_coin', 'healing_stone',
  'thornblood_totem', 'feather_sigil', 'deflagration_core', 'warding_talisman'];
for (const id of check) {
  const e = db.items[id];
  if (!e) { console.log(id.padEnd(20), 'MISSING'); continue; }
  console.log(id.padEnd(20), e.cls.padEnd(8), 'pos=' + e.positional, 'stars=' + e.stars, 'markers=' + JSON.stringify(e.markers));
}
