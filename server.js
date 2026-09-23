const express = require('express');
const http = require('http');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'radio.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Database setup
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      favicon TEXT,
      country TEXT,
      tags TEXT,
      is_custom INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER,
      FOREIGN KEY(station_id) REFERENCES stations(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(station_id) REFERENCES stations(id) ON DELETE CASCADE
    )`);

    // Insert default Vietnamese stations if none exist
    db.get("SELECT COUNT(*) as count FROM stations", (err, row) => {
      if (row && row.count === 0) {
        const defaults = [
          { name: 'VOV1 - Kênh Thời sự Chính trị Tổng hợp', url: 'https://vovlive.vov.vn/vovlive/vov1.smil/playlist.m3u8', country: 'Vietnam', tags: 'news,talk' },
          { name: 'VOV3 - Kênh Âm nhạc Thông tin', url: 'https://vovlive.vov.vn/vovlive/vov3.smil/playlist.m3u8', country: 'Vietnam', tags: 'music' },
          { name: 'VOH FM 99.9 MHz - Đài TNND TP.HCM', url: 'https://live.voh.com.vn/stream/voh999.stream/playlist.m3u8', country: 'Vietnam', tags: 'general' },
          { name: 'BBC World Service', url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service', country: 'United Kingdom', tags: 'news' }
        ];
        const stmt = db.prepare("INSERT INTO stations (name, stream_url, country, tags, is_custom) VALUES (?, ?, ?, ?, 0)");
        defaults.forEach(d => stmt.run(d.name, d.url, d.country, d.tags));
        stmt.finalize();
      }
    });
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health Check endpoint
app.get('/healthz', (req, res) => {
  db.get("SELECT 1", (err) => {
    if (err) {
      res.status(500).json({ status: 'error', database: err.message });
    } else {
      res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date() });
    }
  });
});

// API: Get stations
app.get('/api/stations', (req, res) => {
  const search = req.query.search || '';
  const query = search 
    ? `SELECT * FROM stations WHERE name LIKE ? OR country LIKE ? OR tags LIKE ? ORDER BY id DESC`
    : `SELECT * FROM stations ORDER BY id DESC`;
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
  
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// API: Add custom station
app.post('/api/stations', (req, res) => {
  const { name, stream_url, favicon, country, tags } = req.body;
  if (!name || !stream_url) {
    return res.status(400).json({ error: 'Name and stream URL are required' });
  }
  const stmt = db.prepare("INSERT INTO stations (name, stream_url, favicon, country, tags, is_custom) VALUES (?, ?, ?, ?, ?, 1)");
  stmt.run(name, stream_url, favicon || '', country || 'Custom', tags || 'user', function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, name, stream_url, is_custom: 1 });
  });
  stmt.finalize();
});

// API: Get favorites
app.get('/api/favorites', (req, res) => {
  const query = `
    SELECT stations.*, favorites.id as favorite_id 
    FROM favorites 
    JOIN stations ON favorites.station_id = stations.id
    ORDER BY favorites.id DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// API: Add/Remove favorite
app.post('/api/favorites', (req, res) => {
  const { station_id } = req.body;
  if (!station_id) return res.status(400).json({ error: 'station_id is required' });

  db.get("SELECT id FROM favorites WHERE station_id = ?", [station_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (row) {
      db.run("DELETE FROM favorites WHERE station_id = ?", [station_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'removed', station_id });
      });
    } else {
      db.run("INSERT INTO favorites (station_id) VALUES (?)", [station_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'added', favorite_id: this.lastID, station_id });
      });
    }
  });
});

// API: Radio Browser Proxy Search
app.get('/api/radio-browser/search', async (req, res) => {
  const name = req.query.name || '';
  const country = req.query.country || '';
  try {
    let url = 'https://de1.api.radio-browser.info/json/stations/search?limit=30';
    if (name) url += `&name=${encodeURIComponent(name)}`;
    if (country) url += `&country=${encodeURIComponent(country)}`;
    
    const response = await fetch(url, { headers: { 'User-Agent': 'SoloRadio/1.0' } });
    const data = await response.json();
    
    const formatted = data.map(s => ({
      name: s.name,
      stream_url: s.url_resolved || s.url,
      favicon: s.favicon,
      country: s.country,
      tags: s.tags
    }));
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch from Radio Browser API', details: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Solo Radio server running on http://0.0.0.0:${PORT}`);
});
