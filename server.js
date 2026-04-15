const WebSocket = require('ws');
const Database = require('better-sqlite3');
const path = require('path');

// --- База данных на постоянном диске Render ---
const dbPath = path.join('/opt/render/project/data', 'offline.db');
const db = new Database(dbPath);

// Создаём таблицу для хранения офлайн-сообщений
db.exec(`
  CREATE TABLE IF NOT EXISTS offline_queue (
    msg_id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    payload TEXT NOT NULL,          -- JSON-строка с зашифрованными данными
    type TEXT DEFAULT 'msg',        -- 'msg' или 'voice-listened'
    timestamp INTEGER NOT NULL,
    expires_at INTEGER               -- когда истекает (NULL = никогда)
  );
  CREATE INDEX IF NOT EXISTS idx_offline_recipient ON offline_queue (recipient_id);
  CREATE INDEX IF NOT EXISTS idx_offline_expires ON offline_queue (expires_at);
`);

// Автоудаление старых сообщений (14 дней)
const AUTO_DELETE_DAYS = 14;
function cleanupExpired() {
  if (AUTO_DELETE_DAYS <= 0) return;
  const stmt = db.prepare('DELETE FROM offline_queue WHERE expires_at IS NOT NULL AND expires_at < ?');
  const info = stmt.run(Date.now());
  if (info.changes > 0) console.log(`🧹 Удалено ${info.changes} старых офлайн-сообщений.`);
}
cleanupExpired();
setInterval(cleanupExpired, 60 * 60 * 1000); // раз в час

// --- Функции для работы с очередью ---
function saveOfflineMessage(msgId, recipient, sender, payload, type = 'msg') {
  const timestamp = Date.now();
  const expires = AUTO_DELETE_DAYS > 0 ? timestamp + (AUTO_DELETE_DAYS * 24 * 60 * 60 * 1000) : null;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO offline_queue
    (msg_id, recipient_id, sender_id, payload, type, timestamp, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(msgId, recipient, sender, JSON.stringify(payload), type, timestamp, expires);
}

function getAndClearOfflineMessages(recipient) {
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT * FROM offline_queue
    WHERE recipient_id = ?
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY timestamp ASC
  `);
  const rows = stmt.all(recipient, now);
  if (rows.length === 0) return [];

  // Удаляем эти сообщения из очереди
  const deleteStmt = db.prepare('DELETE FROM offline_queue WHERE recipient_id = ? AND (expires_at IS NULL OR expires_at > ?)');
  deleteStmt.run(recipient, now);

  return rows.map(r => ({
    msgId: r.msg_id,
    from: r.sender_id,
    payload: r.type === 'msg' ? JSON.parse(r.payload) : null,
    type: r.type,
    voiceMsgId: r.type === 'voice-listened' ? JSON.parse(r.payload).voiceMsgId : null
  }));
}

function markDelivered(msgId) {
  // В этой архитектуре сообщение удаляется из очереди при доставке,
  // так что отдельно помечать не нужно.
}

// --- WebSocket сервер ---
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const clients = new Map(); // peerId -> WebSocket

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastPresence(peerId, isOnline) {
  const msg = JSON.stringify({ type: 'presence', peerId, online: isOnline });
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  let userId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // --- REGISTER ---
    if (data.type === 'register') {
      userId = (data.peerId || '').toLowerCase();
      if (!userId) return;
      clients.set(userId, ws);
      ws.userId = userId;
      console.log(`[${userId}] registered`);

      send(ws, { type: 'registered' });
      broadcastPresence(userId, true);

      // Доставляем все накопленные офлайн-сообщения
      const pending = getAndClearOfflineMessages(userId);
      if (pending.length > 0) {
        console.log(`[${userId}] delivering ${pending.length} queued items`);
        for (const item of pending) {
          if (item.type === 'msg') {
            send(ws, {
              type: 'incoming-msg',
              from: item.from,
              msgId: item.msgId,
              payload: item.payload
            });
          } else if (item.type === 'voice-listened') {
            send(ws, {
              type: 'voice-listened',
              from: item.from,
              voiceMsgId: item.voiceMsgId
            });
          }
        }
      }
      return;
    }

    // --- SEND-MSG (обычное или голосовое) ---
    if (data.type === 'send-msg') {
      if (!userId) return;
      const target = (data.target || '').toLowerCase();
      const { msgId, payload, ephemeral } = data;
      if (!target || !msgId || !payload) return;

      const targetWs = clients.get(target);

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        // Получатель онлайн – доставляем сразу
        send(targetWs, {
          type: 'incoming-msg',
          from: userId,
          msgId: msgId,
          payload: payload
        });
        console.log(`[${userId}] → [${target}] live delivery`);
        // Для не-ephemeral сообщений сохраняем в офлайн-очередь на случай, если ACK не придёт
        if (!ephemeral) {
          saveOfflineMessage(msgId, target, userId, payload, 'msg');
        }
      } else {
        // Получатель офлайн – сохраняем в БД
        if (!ephemeral) {
          saveOfflineMessage(msgId, target, userId, payload, 'msg');
          console.log(`[${userId}] → [${target}] queued (offline)`);
        }
      }
      return;
    }

    // --- ACK-MSG (подтверждение доставки) ---
    if (data.type === 'ack-msg') {
      if (!userId) return;
      const { msgId } = data;
      if (!msgId) return;

      // Удаляем сообщение из очереди, так как получатель подтвердил получение
      const stmt = db.prepare('DELETE FROM offline_queue WHERE msg_id = ?');
      stmt.run(msgId);

      console.log(`[${userId}] ACK ${msgId}`);

      // Уведомляем отправителя о доставке (если он ещё в сети)
      // Для этого нам нужно узнать, кто был отправителем. Можно сделать отдельный запрос.
      const info = db.prepare('SELECT sender_id FROM offline_queue WHERE msg_id = ?').get(msgId);
      if (info) {
        const senderWs = clients.get(info.sender_id);
        if (senderWs) {
          send(senderWs, { type: 'msg-delivered', msgId, by: userId });
        }
      }
      return;
    }

    // --- QUERY-PRESENCE ---
    if (data.type === 'query-presence') {
      if (!userId) return;
      const target = (data.target || '').toLowerCase();
      const isOnline = clients.has(target);
      send(ws, { type: 'presence-reply', target, online: isOnline });
      return;
    }

    // --- VOICE-LISTENED (relay) ---
    if (data.type === 'voice-listened') {
      if (!userId) return;
      const target = (data.target || '').toLowerCase();
      const targetWs = clients.get(target);
      const payload = { voiceMsgId: data.voiceMsgId };

      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        send(targetWs, {
          type: 'voice-listened',
          from: userId,
          voiceMsgId: data.voiceMsgId
        });
        console.log(`[${userId}] → [${target}] voice-listened live`);
      } else {
        // Отправитель офлайн – сохраняем в офлайн-очередь
        saveOfflineMessage(
          `vl-${Date.now()}-${userId}-${target}`,
          target,
          userId,
          payload,
          'voice-listened'
        );
        console.log(`[${userId}] → [${target}] voice-listened queued (offline)`);
      }
      return;
    }

    // --- Legacy signal (если нужно) ---
    if (data.type === 'signal' && data.target) {
      const targetWs = clients.get(data.target.toLowerCase());
      if (targetWs) {
        send(targetWs, { type: 'signal', from: userId, payload: data.payload });
      }
    }
  });

  ws.on('close', () => {
    if (userId) {
      clients.delete(userId);
      console.log(`[${userId}] disconnected`);
      broadcastPresence(userId, false);
    }
  });

  ws.on('error', (e) => console.error('ws error', e.message));
});

console.log(`🚀 Сервер запущен на порту ${wss.options.port}`);
console.log(`⏳ Автоудаление офлайн-сообщений через ${AUTO_DELETE_DAYS} дн.`);
