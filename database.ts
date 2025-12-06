import sqlite3 from 'sqlite3';
import path from 'path';

const dbPath = path.resolve(__dirname, 'shellmind.db');

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
