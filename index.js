const { default: makeWASocket, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { createClient } = require('@libsql/client');
const express = require('express');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET || "adhikar_secret_123";

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function useTursoAuthState() {
  await turso.execute(`CREATE TABLE IF NOT EXISTS wa_session (id TEXT PRIMARY KEY, data TEXT)`);

  const readData = async (id) => {
    const res = await turso.execute({ sql: 'SELECT data FROM wa_session WHERE id = ?', args: [id] });
    return res.rows.length > 0 ? JSON.parse(res.rows[0].data, BufferJSON.reviver) : null;
  };

  const writeData = async (id, data) => {
    await turso.execute({
      sql: 'INSERT OR REPLACE INTO wa_session (id, data) VALUES (?, ?)',
      args: [id, JSON.stringify(data, BufferJSON.replacer)],
    });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await readData(`${type}-${id}`);
            if (val) {
              data[id] = type === 'app-state-sync-key' ? proto.Message.AppStateSyncKeyData.fromObject(val) : val;
            }
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) await writeData(`${category}-${id}`, value);
            }
          }
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

let sock;
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useTursoAuthState();
  sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) {
      console.log('\nScan this QR Code in WhatsApp -> Linked Devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      isConnected = true;
      console.log('WhatsApp Connected via Turso!');
    }
    if (connection === 'close') {
      isConnected = false;
      setTimeout(startWhatsApp, 3000);
    }
  });
}

startWhatsApp();

app.get('/', (req, res) => res.json({ status: isConnected ? 'connected' : 'connecting' }));

app.get('/groups', async (req, res) => {
  if (req.headers['x-api-key'] !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!isConnected) return res.status(503).json({ error: 'Not connected' });
  const groups = await sock.groupFetchAllParticipating();
  const list = Object.values(groups).map(g => ({ name: g.subject, groupId: g.id }));
  res.json(list);
});

app.post('/send-msg', async (req, res) => {
  if (req.headers['x-api-key'] !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!isConnected) return res.status(503).json({ error: 'Not connected yet' });

  try {
    const { phone, message } = req.body;
    const target = phone.toString().trim();
    const jid = target.includes('@g.us')
      ? target
      : `${target.replace(/[^0-9]/g, '').length === 10 ? '91' + target.replace(/[^0-9]/g, '') : target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    res.json({ status: 'sent', to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Baileys Server Ready'));
