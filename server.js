import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { Chess } from 'chess.js';
import express from 'express';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = Number(process.env.PORT || 3000);
const secret = process.env.JWT_SECRET || 'pycheckmate-development-secret-change-me';

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'pycheckmate.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_id INTEGER NOT NULL,
    fen TEXT NOT NULL, moves_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS game_players (
    game_id TEXT NOT NULL, user_id INTEGER NOT NULL, color TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(game_id, user_id), UNIQUE(game_id, color),
    FOREIGN KEY(game_id) REFERENCES games(id), FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS quiz_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, choices_json TEXT NOT NULL,
    correct_index INTEGER NOT NULL, explanation TEXT NOT NULL, difficulty TEXT NOT NULL DEFAULT 'warmup',
    author_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(author_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL, selected_index INTEGER NOT NULL, is_correct INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id), FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(question_id) REFERENCES quiz_questions(id)
  );
  CREATE TABLE IF NOT EXISTS game_challenges (
    game_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
    captured_piece TEXT NOT NULL, difficulty TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id), FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(question_id) REFERENCES quiz_questions(id)
  );
`);

const seedQuestions = [
  ['Which expression reads the value stored under the key "rank"?', ['player.rank', 'player["rank"]', 'player.get(rank)', 'rank[player]'], 1, 'Dictionary values are accessed with their key inside square brackets.', 'warmup'],
  ['What does this create? {"white": 12, "black": 9}', ['A list', 'A tuple', 'A dictionary', 'A set'], 2, 'Curly braces with key-value pairs create a dictionary.', 'warmup'],
  ['Which method safely returns None when "bonus" is missing?', ['score["bonus"]', 'score.find("bonus")', 'score.get("bonus")', 'score.value("bonus")'], 2, 'get() avoids a KeyError when a key is absent.', 'tactic'],
  ['After board["e4"] = "pawn", what is board["e4"]?', ['"e4"', '"pawn"', 'True', 'A list'], 1, 'The key "e4" now maps to the value "pawn".', 'tactic'],
  ['What is the result of scores = {"white": 3}; scores["black"] = scores.get("black", 0) + 1?', ['{"white": 3}', '{"black": 1}', '{"white": 3, "black": 1}', 'A KeyError'], 2, 'get("black", 0) supplies a default of 0 before adding 1.', 'advanced'],
  ['Which statement correctly merges bonus points into a dictionary named score?', ['score + {"bonus": 5}', 'score.update({"bonus": 5})', 'score.append("bonus", 5)', 'score.merge("bonus": 5)'], 1, 'update() adds or replaces key-value pairs in a dictionary.', 'advanced'],
  ['Which loop visits both a dictionary key and its value?', ['for k, v in d.items():', 'for k, v in d.keys():', 'for k, v in d.values():', 'for k, v in d.pairs():'], 0, 'items() provides key-value pairs for unpacking.', 'endgame'],
  ['What removes and returns the value for "captured"?', ['del stats["captured"]', 'stats.pop("captured")', 'stats.remove("captured")', 'stats.clear("captured")'], 1, 'pop(key) removes the pair and returns its value.', 'endgame']
];
if (db.prepare('SELECT COUNT(*) AS count FROM quiz_questions').get().count === 0) {
  const insert = db.prepare('INSERT INTO quiz_questions (prompt, choices_json, correct_index, explanation, difficulty) VALUES (?, ?, ?, ?, ?)');
  const transaction = db.transaction(() => seedQuestions.forEach(([prompt, choices, correct, explanation, difficulty]) => insert.run(prompt, JSON.stringify(choices), correct, explanation, difficulty)));
  transaction();
}

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function safeUser(user) { return { id: user.id, username: user.username, email: user.email }; }
function issueToken(user) { return jwt.sign({ id: user.id, username: user.username }, secret, { expiresIn: '7d' }); }
function parseToken(token) { try { return jwt.verify(token, secret); } catch { return null; } }
function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const payload = parseToken(token);
  if (!payload) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.user = payload;
  next();
}
function validateCredentials({ username, email, password }, signUp = false) {
  if (signUp && (!/^[a-zA-Z0-9_]{3,20}$/.test(username || ''))) return 'Username must be 3-20 letters, numbers, or underscores.';
  if (signUp && !/^\S+@\S+\.\S+$/.test(email || '')) return 'Enter a valid email address.';
  if (!password || password.length < 8) return 'Password must contain at least 8 characters.';
}
function playerFor(gameId, userId) { return db.prepare('SELECT * FROM game_players WHERE game_id = ? AND user_id = ?').get(gameId, userId); }
function tierForPiece(piece) {
  return ({ p: 'warmup', n: 'tactic', b: 'tactic', r: 'advanced', q: 'advanced', k: 'endgame' })[piece] || 'warmup';
}
function challengeFor(gameId) {
  return db.prepare(`SELECT c.*, q.prompt, q.choices_json FROM game_challenges c JOIN quiz_questions q ON q.id = c.question_id WHERE c.game_id = ?`).get(gameId);
}
function selectQuestion(difficulty) {
  return db.prepare('SELECT * FROM quiz_questions WHERE difficulty = ? ORDER BY RANDOM() LIMIT 1').get(difficulty)
    || db.prepare('SELECT * FROM quiz_questions ORDER BY RANDOM() LIMIT 1').get();
}
function serializeGame(gameId, viewerId) {
  const game = db.prepare(`SELECT g.*, u.username AS owner_name FROM games g JOIN users u ON u.id = g.owner_id WHERE g.id = ?`).get(gameId);
  if (!game) return null;
  const players = db.prepare(`SELECT gp.user_id AS id, u.username, gp.color, gp.points FROM game_players gp JOIN users u ON u.id = gp.user_id WHERE gp.game_id = ? ORDER BY gp.color`).all(gameId);
  const challenge = challengeFor(gameId);
  const publicChallenge = challenge ? { userId: challenge.user_id, capturedPiece: challenge.captured_piece, difficulty: challenge.difficulty, awaiting: true, yours: challenge.user_id === viewerId } : null;
  return { ...game, moves: JSON.parse(game.moves_json), players, challenge: publicChallenge, you: players.find((p) => p.id === viewerId) || null };
}
function broadcastGame(gameId) {
  const game = serializeGame(gameId, null);
  io.to(`game:${gameId}`).emit('game:state', game);
}

app.post('/api/auth/register', async (req, res) => {
  const message = validateCredentials(req.body, true);
  if (message) return res.status(422).json({ error: message });
  try {
    const hash = await bcrypt.hash(req.body.password, 12);
    const result = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(req.body.username.trim(), req.body.email.trim().toLowerCase(), hash);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ token: issueToken(user), user: safeUser(user) });
  } catch (error) {
    res.status(409).json({ error: error.message.includes('username') ? 'That username is already taken.' : 'That email is already registered.' });
  }
});
app.post('/api/auth/login', async (req, res) => {
  const message = validateCredentials(req.body);
  if (message) return res.status(422).json({ error: message });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((req.body.email || '').trim().toLowerCase());
  if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: issueToken(user), user: safeUser(user) });
});
app.get('/api/auth/me', auth, (req, res) => res.json(safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id))));

app.get('/api/games', auth, (req, res) => {
  const games = db.prepare(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) AS player_count FROM games g JOIN users u ON u.id = g.owner_id WHERE g.status != 'finished' ORDER BY g.updated_at DESC`).all();
  res.json(games);
});
app.post('/api/games', auth, (req, res) => {
  const title = (req.body.title || '').trim();
  if (title.length < 3 || title.length > 40) return res.status(422).json({ error: 'Game title must be 3-40 characters.' });
  const id = crypto.randomBytes(4).toString('hex').toUpperCase();
  const chess = new Chess();
  db.transaction(() => {
    db.prepare('INSERT INTO games (id, title, owner_id, fen) VALUES (?, ?, ?, ?)').run(id, title, req.user.id, chess.fen());
    db.prepare('INSERT INTO game_players (game_id, user_id, color) VALUES (?, ?, ?)').run(id, req.user.id, 'white');
  })();
  res.status(201).json(serializeGame(id, req.user.id));
});
app.post('/api/games/:id/join', auth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found.' });
  if (!playerFor(game.id, req.user.id)) {
    const black = db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND color = ?').get(game.id, 'black');
    if (!black) {
      db.prepare('INSERT INTO game_players (game_id, user_id, color) VALUES (?, ?, ?)').run(game.id, req.user.id, 'black');
      db.prepare("UPDATE games SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(game.id);
    }
  }
  broadcastGame(game.id);
  res.json(serializeGame(game.id, req.user.id));
});
app.delete('/api/games/:id', auth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found.' });
  if (game.owner_id !== req.user.id || game.status !== 'waiting') return res.status(403).json({ error: 'Only the host can remove a waiting game.' });
  db.transaction(() => { db.prepare('DELETE FROM game_players WHERE game_id = ?').run(game.id); db.prepare('DELETE FROM games WHERE id = ?').run(game.id); })();
  res.status(204).end();
});

app.get('/api/games/:id/qr', auth, async (req, res) => {
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Game not found.' });
  const url = `${req.protocol}://${req.get('host')}/#game=${req.params.id}`;
  res.json({ url, image: await QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: '#17291f', light: '#f5f1e8' } }) });
});

app.get('/api/questions', auth, (req, res) => res.json(db.prepare('SELECT id, prompt, choices_json, explanation, difficulty FROM quiz_questions ORDER BY id DESC').all().map((q) => ({ ...q, choices: JSON.parse(q.choices_json) }))));
app.post('/api/questions', auth, (req, res) => {
  const { prompt, choices, correctIndex, explanation, difficulty = 'warmup' } = req.body;
  if (!prompt?.trim() || !Array.isArray(choices) || choices.length !== 4 || choices.some((item) => !item?.trim()) || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3 || !explanation?.trim()) return res.status(422).json({ error: 'Provide a question, four choices, a correct answer, and an explanation.' });
  const result = db.prepare('INSERT INTO quiz_questions (prompt, choices_json, correct_index, explanation, difficulty, author_id) VALUES (?, ?, ?, ?, ?, ?)').run(prompt.trim(), JSON.stringify(choices.map((item) => item.trim())), correctIndex, explanation.trim(), difficulty, req.user.id);
  res.status(201).json({ id: result.lastInsertRowid });
});
app.put('/api/questions/:id', auth, (req, res) => {
  const { prompt, choices, correctIndex, explanation, difficulty = 'warmup' } = req.body;
  if (!prompt?.trim() || !Array.isArray(choices) || choices.length !== 4 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3 || !explanation?.trim()) return res.status(422).json({ error: 'All question fields are required.' });
  const result = db.prepare('UPDATE quiz_questions SET prompt = ?, choices_json = ?, correct_index = ?, explanation = ?, difficulty = ? WHERE id = ?').run(prompt.trim(), JSON.stringify(choices), correctIndex, explanation.trim(), difficulty, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Question not found.' });
  res.json({ success: true });
});
app.delete('/api/questions/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM quiz_questions WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Question not found.' });
  res.status(204).end();
});
app.get('/api/games/:id/question', auth, (req, res) => {
  const challenge = challengeFor(req.params.id);
  if (!challenge || challenge.user_id !== req.user.id) return res.status(404).json({ error: 'There is no challenge waiting for you.' });
  res.json({ id: challenge.question_id, prompt: challenge.prompt, choices: JSON.parse(challenge.choices_json), difficulty: challenge.difficulty, capturedPiece: challenge.captured_piece });
});
app.post('/api/games/:id/answer', auth, (req, res) => {
  const player = playerFor(req.params.id, req.user.id);
  const challenge = challengeFor(req.params.id);
  const question = challenge && db.prepare('SELECT * FROM quiz_questions WHERE id = ?').get(challenge.question_id);
  if (!player || !challenge || challenge.user_id !== req.user.id || !question || question.id !== req.body.questionId || !Number.isInteger(req.body.selectedIndex)) return res.status(422).json({ error: 'Invalid challenge submission.' });
  const correct = Number(req.body.selectedIndex) === question.correct_index;
  db.transaction(() => {
    db.prepare('INSERT INTO quiz_attempts (game_id, user_id, question_id, selected_index, is_correct) VALUES (?, ?, ?, ?, ?)').run(req.params.id, req.user.id, question.id, req.body.selectedIndex, Number(correct));
    if (correct) {
      db.prepare('UPDATE game_players SET points = points + 10 WHERE game_id = ? AND user_id = ?').run(req.params.id, req.user.id);
      const game = db.prepare('SELECT fen FROM games WHERE id = ?').get(req.params.id);
      const fen = game.fen.split(' '); fen[1] = player.color === 'white' ? 'w' : 'b';
      db.prepare('UPDATE games SET fen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fen.join(' '), req.params.id);
    }
    db.prepare('DELETE FROM game_challenges WHERE game_id = ?').run(req.params.id);
  })();
  broadcastGame(req.params.id);
  res.json({ correct, explanation: question.explanation, pointsAwarded: correct ? 10 : 0, extraMove: correct });
});

io.use((socket, next) => {
  const user = parseToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('Authentication required'));
  socket.user = user;
  next();
});
io.on('connection', (socket) => {
  socket.on('game:join', ({ gameId }) => {
    if (!playerFor(gameId, socket.user.id)) return socket.emit('app:error', 'Join this game before opening its board.');
    socket.join(`game:${gameId}`);
    socket.emit('game:state', serializeGame(gameId, socket.user.id));
  });
  socket.on('game:move', ({ gameId, from, to, promotion = 'q' }) => {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
    const player = playerFor(gameId, socket.user.id);
    if (!game || !player || game.status !== 'active') return socket.emit('app:error', 'This game is not ready for moves.');
    if (challengeFor(gameId)) return socket.emit('app:error', 'A capture challenge must be answered before play continues.');
    const chess = new Chess(game.fen);
    const expectedColor = chess.turn() === 'w' ? 'white' : 'black';
    if (player.color !== expectedColor) return socket.emit('app:error', 'Wait for your turn.');
    try {
      const move = chess.move({ from, to, promotion });
      const moves = JSON.parse(game.moves_json);
      moves.push({ san: move.san, from, to, by: socket.user.username, at: Date.now(), captured: move.captured || null });
      let status = 'active';
      if (chess.isCheckmate() || chess.isDraw()) status = 'finished';
      db.transaction(() => {
        db.prepare('UPDATE games SET fen = ?, moves_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chess.fen(), JSON.stringify(moves), status, gameId);
        if (move.captured && status === 'active') {
          const difficulty = tierForPiece(move.captured);
          const question = selectQuestion(difficulty);
          db.prepare('INSERT INTO game_challenges (game_id, user_id, question_id, captured_piece, difficulty) VALUES (?, ?, ?, ?, ?)').run(gameId, socket.user.id, question.id, move.captured, difficulty);
        }
      })();
      broadcastGame(gameId);
      if (move.captured && status === 'active') socket.emit('challenge:earned', { gameId, capturedPiece: move.captured, difficulty: tierForPiece(move.captured), reason: 'Capture confirmed. Answer the matching QR challenge to earn an immediate extra move.' });
    } catch { socket.emit('app:error', 'That move is not legal.'); }
  });
});

server.listen(port, () => console.log(`PyCheckmate running at http://localhost:${port}`));
