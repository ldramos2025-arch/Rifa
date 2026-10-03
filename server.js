const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Banco de Dados SQLite
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error("Erro no SQLite:", err.message);
  else console.log("Conectado ao SQLite.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS participantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    telefone TEXT NOT NULL,
    pago INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT
  )`);
});

// WhatsApp Web JS
const clientWhatsapp = new Client({
  authStrategy: new LocalAuth()
});

clientWhatsapp.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
});

clientWhatsapp.on('ready', () => {
  console.log('WhatsApp Web conectado e pronto!');
});

clientWhatsapp.initialize();

// Helpers
function setConfig(chave, valor) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO configuracoes (chave, valor) VALUES (?, ?) 
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
      [chave, valor], (err) => err ? reject(err) : resolve()
    );
  });
}

function getConfig(chave) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT valor FROM configuracoes WHERE chave = ?`, [chave], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.valor : null);
    });
  });
}

function emitirAtualizacao() {
  db.all(`SELECT * FROM participantes ORDER BY CAST(numero AS INTEGER) ASC`, [], (err, rows) => {
    if (!err) io.emit('participants_updated', rows);
  });
}

// Rotas API
app.post('/api/participants', (req, res) => {
  const { numero, nome, telefone } = req.body;
  if (!numero || !nome || !telefone) {
    return res.status(400).json({ error: 'Número, nome e telefone são obrigatórios.' });
  }

  const numFormatado = String(numero).padStart(2, '0');

  db.run(`INSERT INTO participantes (numero, nome, telefone, pago) VALUES (?, ?, ?, 0)`, 
    [numFormatado, nome, telefone], function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: `O número ${numFormatado} já foi reservado ou comprado!` });
        }
        return res.status(500).json({ error: err.message });
      }

      emitirAtualizacao();
      res.json({ id: this.lastID, numero: numFormatado, nome, telefone, pago: 0 });
  });
});

app.post('/api/participants/:id/approve', (req, res) => {
  const { id } = req.params;
  db.run(`UPDATE participantes SET pago = 1 WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`SELECT * FROM participantes WHERE id = ?`, [id], async (err, p) => {
      if (!err && p) {
        try {
          const numTelefone = p.telefone.replace(/\D/g, '');
          const chatId = `${numTelefone}@c.us`;
          const mensagem = `✅ *Pagamento Confirmado!* Seu número *Nº ${p.numero}* foi ativado no sorteio com sucesso! Boa sorte! 🍀`;
          await clientWhatsapp.sendMessage(chatId, mensagem);
        } catch (wppErr) {
          console.error("Erro ao enviar mensagem WhatsApp:", wppErr.message);
        }
      }
    });

    emitirAtualizacao();
    res.json({ success: true });
  });
});

app.get('/api/participants', (req, res) => {
  db.all(`SELECT * FROM participantes ORDER BY CAST(numero AS INTEGER) ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.delete('/api/participants/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM participantes WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    emitirAtualizacao();
    res.json({ success: true });
  });
});

app.post('/api/draw-date', async (req, res) => {
  const { drawDate } = req.body;
  try {
    await setConfig('draw_date', drawDate);
    io.emit('draw_date_updated', drawDate);
    res.json({ success: true, drawDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/draw-date', async (req, res) => {
  try {
    const drawDate = await getConfig('draw_date');
    res.json({ drawDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  socket.on('start_spin', () => {
    db.all(`SELECT * FROM participantes WHERE pago = 1 ORDER BY CAST(numero AS INTEGER) ASC`, [], async (err, rows) => {
      if (err || rows.length === 0) {
        return socket.emit('spin_error', 'Nenhum número pago aprovado para o sorteio.');
      }

      const vencedorIndex = Math.floor(Math.random() * rows.length);
      const ganhador = rows[vencedorIndex];

      io.emit('spin_started', {
        vencedorIndex,
        ganhador
      });

      setTimeout(async () => {
        try {
          const numeroFormatado = ganhador.telefone.replace(/\D/g, '');
          const chatId = `${numeroFormatado}@c.us`;
          const mensagem = `🎉 Parabéns *${ganhador.nome}*! O seu número *Nº ${ganhador.numero}* foi o grande sorteado na roleta! 🏆`;
          await clientWhatsapp.sendMessage(chatId, mensagem);
          console.log(`WhatsApp enviado para ${ganhador.nome}`);
        } catch (wppError) {
          console.error("Erro WhatsApp:", wppError.message);
        }
      }, 5500);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor a rodar em http://localhost:${PORT}`);
});