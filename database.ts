import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'shellmind.db');

// Ensure directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    try {
        fs.mkdirSync(dbDir, { recursive: true });
        console.log('Created database directory:', dbDir);
    } catch (e) {
        console.error('Failed to create database directory:', e);
    }
}

console.log('Opening database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');

        // Create table if not exists
        db.run(`CREATE TABLE IF NOT EXISTS servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            ip TEXT NOT NULL,
            type TEXT NOT NULL, -- 'linux' (ssh) or 'windows' (rdp)
            username TEXT,
            password TEXT,
            port INTEGER DEFAULT 22,
            os_detail TEXT
        )`, (err) => {
            if (err) {
                console.error("Error creating table 'servers':", err.message);
            } else {
                console.log("Table 'servers' is ready.");
                // Try to add column if it doesn't exist (migration for existing db)
                db.run(`ALTER TABLE servers ADD COLUMN os_detail TEXT`, (alterErr) => {
                    // Ignore error if column exists
                });
                db.run(`ALTER TABLE servers ADD COLUMN ssh_port INTEGER`, (alterErr) => {
                    // Ignore error if column exists
                });

                // S3 Migrations
                const s3Columns = [
                    "s3_provider TEXT",
                    "s3_bucket TEXT",
                    "s3_region TEXT",
                    "s3_endpoint TEXT",
                    "s3_access_key TEXT",
                    "s3_secret_key TEXT"
                ];

                s3Columns.forEach(colDef => {
                    const colName = colDef.split(' ')[0];
                    db.run(`ALTER TABLE servers ADD COLUMN ${colDef}`, (alterErr) => {
                        // Ignore error if column exists
                    });
                });

                // SSH Key Migration
                db.run(`ALTER TABLE servers ADD COLUMN privateKey TEXT`, () => { });
                db.run(`ALTER TABLE servers ADD COLUMN passphrase TEXT`, () => { });

                // Create settings table
                db.run(`CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`);
            }
        });
    }
});

export default db;
