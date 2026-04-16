const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

// --- Твои ключи Supabase (уже проверенные) ---
const SUPABASE_URL = 'https://lnrrnhpzudcsyjijbjrh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Q-1rp2b2aWmw5TpNC7Lw7Q_luaAVrUY';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

      // Доставляем офлайн-сообщения из Supabase
      const now = Date.now();
      const { data: pending, error } = await supabase
        .from('offline_queue')
        .select('*')
        .eq('recipient_id', userId)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('timestamp', { ascending: true });

      if (!error && pending && pending.length > 0) {
        console.log(`[${userId}] delivering ${pending.length} queued items`);
        const idsToDelete = pending.map(item => item.msg_id);
        await supabase.from('offline_queue').delete().in('msg_id', idsToDelete);

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
        send(targetWs, { type: 'incoming-msg', from: userId, msgId, payload });
        console.log(`[${userId}] → [${target}] live delivery`);
        if (!ephemeral) {
          const timestamp = Date.now();
          const expires = timestamp + (14 * 24 * 60 * 60 * 1000);
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
        if (!ephemeral) {
          const timestamp = Date.now();
          const expires = timestamp + (14 * 24 * 60 * 60 * 1000);
          await supabase.from('offline_queue').insert({
            msg_id: msgId,
            recipient_id: target,
            sender_id: userId,
            payload: payload,
            type: 'msg',
            timestamp: timestamp,
            expires_at: expires
          });
          console.log(`[${userId}] → [${target}] queued in Supabase`);
        }
      }
      return;
    }

    // --- ACK-MSG ---
    if (data.type === 'ack-msg') {
      if (!userId) return;
      const { msgId } = data;
      if (!msgId) return;
      await supabase.from('offline_queue').delete().eq('msg_id', msgId);
      console.log(`[${userId}] ACK ${msgId}`);
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
        send(targetWs, { type: 'voice-listened', from: userId, voiceMsgId: data.voiceMsgId });
        console.log(`[${userId}] → [${target}] voice-listened live`);
      } else {
        const timestamp = Date.now();
        const expires = timestamp + (14 * 24 * 60 * 60 * 1000);
        await supabase.from('offline_queue').insert({
          msg_id: `vl-${timestamp}-${userId}-${target}`,
          recipient_id: target,
          sender_id: userId,
          payload: payload,
          type: 'voice-listened',
          timestamp: timestamp,
          expires_at: expires
        });
        console.log(`[${userId}] → [${target}] voice-listened queued`);
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

  ws.on('error', e => console.error('ws error', e.message));
});

console.log(`🚀 Server running on port ${wss.options.port}`);
