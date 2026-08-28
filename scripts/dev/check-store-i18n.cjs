const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/src/locales/zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/src/locales/en.json'), 'utf8'));

const files = [
  'src/renderer/src/pages/Store.tsx',
  'src/renderer/src/pages/StoreToolbar.tsx',
  'src/renderer/src/pages/StoreFilterBar.tsx',
  'src/renderer/src/pages/StoreGrid.tsx',
  'src/renderer/src/pages/StoreEmptyState.tsx',
  'src/renderer/src/pages/StoreErrorState.tsx',
  'src/renderer/src/components/ServerCard.tsx',
  'src/renderer/src/components/SkillCard.tsx',
  'src/renderer/src/components/Pagination.tsx',
  'src/renderer/src/hooks/useStoreAttribution.ts',
  'src/renderer/src/hooks/useStoreFacets.ts',
];

const get = (o, k) => k.split('.').reduce((a, c) => (a ? a[c] : undefined), o);
const keys = new Map();
for (const f of files) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const re = /t\(\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(s))) {
    if (!keys.has(m[2])) keys.set(m[2], f);
  }
}
console.log('total static keys:', keys.size);
console.log('--- MISSING ---');
for (const [k, f] of keys) {
  const z = get(zh, k) === undefined;
  const e = get(en, k) === undefined;
  if (z || e) console.log(` ${k}  [zh:${z ? 'MISS' : 'ok'} en:${e ? 'MISS' : 'ok'}]  <- ${f}`);
}
