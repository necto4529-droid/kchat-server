const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// --- Supabase клиент ---
const SUPABASE_URL = 'https://lnrrnhpzudcsyjijbjrh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Q-1rp2b2aWmw5TpNC7Lw7Q_luaAVrUY';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

  ws.on('message', async (raw) => {
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

      // Доставляем все накопленные офлайн-сообщения из Supabase
      const now = Date.now();
      const { data: pending, error } = await supabase
        .from('offline_queue')
        .select('*')
        .eq('recipient_id', userId)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('timestamp', { ascending: true });

      if (!error && pending && pending.length > 0) {
        console.log(`[${userId}] delivering ${pending.length} queued items`);
        
        // Удаляем доставленные сообщения из очереди
        const idsToDelete = pending.map(item => item.msg_id);
        await supabase.from('offline_queue').delete().in('msg_id', idsToDelete);

        // Отправляем сообщения клиенту
        for (const item of pending) {
          if (item.type === 'msg') {
            send(ws, {
              type: 'incoming-msg',
              from: item.sender_id,
              msgId: item.msg_id,
              payload: item.payload
            });
          } else if (item.type === 'voice-listened') {
            send(ws, {
              type: 'voice-listened',
              from: item.sender_id,
              voiceMsgId: item.payload.voiceMsgId
            });
          }
        }
      }
      return;
    }

    // --- SEND-MSG ---
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
        
        // Сохраняем в БД на случай, если ACK не придёт
        if (!ephemeral) {
          const timestamp = Date.now();
          const expires = timestamp + (14 * 24 * 60 * 60 * 1000); // 14 дней
          await supabase.from('offline_queue').upsert({
            msg_id: msgId,
            recipient_id: target,
            sender_id: userId,
            payload: payload,
            type: 'msg',
            timestamp: timestamp,
            expires_at: expires
          });
        }
      } else {
        // Получатель офлайн – сохраняем в Supabase
        if (!ephemeral) {
          const timestamp = Date.now();
          const expires = timestamp + (14 * 24 * 60 * 60 * 1000); // 14 дней
          await supabase.from('offline_queue').insert({
            msg_id: msgId,
            recipient_id: target,
            sender_id: userId,
            payload: payload,
            type: 'msg',
            timestamp: timestamp,
            expires_at: expires
          });
          console.log(`[${userId}] → [${target}] queued in Supabase (offline)`);
        }
      }
      return;
    }

    // --- ACK-MSG ---
    if (data.type === 'ack-msg') {
      if (!userId) return;
      const { msgId } = data;
      if (!msgId) return;

      // Удаляем сообщение из очереди, так как получатель подтвердил получение
      const { error } = await supabase
        .from('offline_queue')
        .delete()
        .eq('msg_id', msgId);

      if (!error) {
        console.log(`[${userId}] ACK ${msgId}`);
        
        // Уведомляем отправителя о доставке
        const { data: msgData } = await supabase
          .from('offline_queue')
          .select('sender_id')
          .eq('msg_id', msgId)
          .maybeSingle();
          
        if (msgData) {
          const senderWs = clients.get(msgData.sender_id);
          if (senderWs) {
            send(senderWs, { type: 'msg-delivered', msgId, by: userId });
          }
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

    // --- VOICE-LISTENED ---
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
        // Отправитель офлайн – сохраняем в Supabase
        const timestamp = Date.now();
        const expires = timestamp + (14 * 24 * 60 * 60 * 1000); // 14 дней
        await supabase.from('offline_queue').insert({
          msg_id: `vl-${timestamp}-${userId}-${target}`,
          recipient_id: target,
          sender_id: userId,
          payload: payload,
          type: 'voice-listened',
          timestamp: timestamp,
          expires_at: expires
        });
        console.log(`[${userId}] → [${target}] voice-listened queued in Supabase (offline)`);
      }
      return;
    }

    // --- Legacy signal ---
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
console.log(`⏳ Автоудаление офлайн-сообщений через 14 дн.`);
