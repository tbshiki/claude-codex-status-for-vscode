// dist/ 内の VSIX を更新日時の新しい順に KEEP 件だけ残し、古いものを削除する。
// npm run package の最後に呼ばれる。単体でも `node scripts/prune-vsix.js` で実行できる。
const fs = require('fs');
const path = require('path');

const KEEP = 3;
const dist = path.join(__dirname, '..', 'dist');

fs.mkdirSync(dist, { recursive: true });

const files = fs
  .readdirSync(dist)
  .filter((f) => f.endsWith('.vsix'))
  .map((f) => ({ name: f, mtime: fs.statSync(path.join(dist, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

for (const { name } of files.slice(KEEP)) {
  fs.unlinkSync(path.join(dist, name));
  console.log(`古いVSIXを削除: dist/${name}`);
}
