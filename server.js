const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

// Указываем, где хранить базу данных (Render не удалит этот путь)
const dbPath = path.join('/opt/render/project/data', 'database.db');
const db = new Database(dbPath);

// Создаём таблицы, если их нет
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    msg_id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);
  CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at);
`);

// Автоудаление старых сообщений (14 дней)
const AUTO_DELETE_DAYS = 14;
function cleanupExpired() {
  if (AUTO_DELETE_DAYS <= 0) return;
  const stmt = db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?');
  const info = stmt.run(Date.now());
  if (info.changes > 0) console.log(`🧹 Удалено ${info.changes} старых сообщений.`);
}
cleanupExpired();
setInterval(cleanupExpired, 60 * 60 * 1000); // раз в час

// Сохранение сообщения
function saveMessage(msgId, sender, recipient, payload, timestamp) {
  const expires = timestamp + (AUTO_DELETE_DAYS * 24 * 60 * 60 * 1000);
  const stmt = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
  stmt.run(msgId, sender, recipient, JSON.stringify(payload), timestamp, expires);
}

// Получение истории для пользователя
function getMessagesForUser(userId) {
  const stmt = db.prepare(`
    SELECT payload FROM messages
    WHERE (recipient_id = ? OR sender_id = ?)
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY timestamp ASC
  `);
  return stmt.all(userId, userId, Date.now()).map(r => JSON.parse(r.payload));
}

// WebSocket сервер
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const clients = new Map();

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        userId = msg.peerId;
        clients.set(userId, ws);
        ws.userId = userId;
        // Отправляем историю
        const history = getMessagesForUser(userId);
        if (history.length) ws.send(JSON.stringify({ type: 'history', messages: history }));
      }

      if (msg.type === 'send-msg' && userId) {
        const { target, msgId, payload } = msg;
        saveMessage(msgId, userId, target, payload, Date.now());
        const recipientWs = clients.get(target);
        if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
          recipientWs.send(JSON.stringify({ type: 'incoming-msg', from: userId, msgId, payload }));
        }
      }

      if (msg.type === 'query-presence' && userId) {
        ws.send(JSON.stringify({ type: 'presence-reply', target: msg.target, online: clients.has(msg.target) }));
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (userId) clients.delete(userId);
  });
});

console.log(`🚀 Сервер запущен на порту ${wss.options.port}`);
console.log(`⏳ Автоудаление сообщений через ${AUTO_DELETE_DAYS} дн.`);
