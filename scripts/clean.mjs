// `npm run clean`, the first step of `npm run build`: removes the build output
// of the current directory (the project root under npm).
//
// It never deletes a database or data key: `node dist-server/server.js` run
// without DB_PATH keeps them inside dist-server/, and removing that folder
// would lose every saved connection together with the key that decrypts the
// credentials. The build stops instead and says where to move them.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const OUTPUT_DIRS = ['dist', 'dist-server', 'dist-electron', 'coverage'];
const DATA_FILE = /\.(db|db-wal|db-shm|db-journal|sqlite3?|key)$/i;

function dataFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && DATA_FILE.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name));
}

const kept = OUTPUT_DIRS.flatMap((dir) => dataFiles(path.resolve(dir)));
if (kept.length) {
    console.error([
        'Not cleaning: the build output holds data that would be lost:',
        ...kept.map((file) => `  ${path.relative(process.cwd(), file)}`),
        'Move these files out of the build folders, for example next to package.json, and point',
        'DB_PATH at the database (`npm run serve` uses ./shellmind.db by default); the key file',
        'shellmind.key must stay next to the database. Then build again.',
    ].join('\n'));
    process.exit(1);
}

for (const dir of OUTPUT_DIRS) fs.rmSync(dir, { recursive: true, force: true });
