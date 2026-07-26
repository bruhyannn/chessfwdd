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
    id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'python', owner_id INTEGER NOT NULL,
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
    language TEXT NOT NULL DEFAULT 'python',
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
    captured_piece TEXT NOT NULL, difficulty TEXT NOT NULL, is_revealed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id), FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(question_id) REFERENCES quiz_questions(id)
  );
`);
try { db.exec(`ALTER TABLE game_challenges ADD COLUMN is_revealed INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE games ADD COLUMN language TEXT NOT NULL DEFAULT 'python'`); } catch {}
try { db.exec(`ALTER TABLE quiz_questions ADD COLUMN language TEXT NOT NULL DEFAULT 'python'`); } catch {}
try { db.exec(`ALTER TABLE games ADD COLUMN winner_id INTEGER REFERENCES users(id)`); } catch {}

const LANGUAGES = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java' };
const ALLOWED_LANGUAGES = Object.keys(LANGUAGES);

const seedQuestions = [
  // Python (8 questions)
  ['Which expression reads the value stored under the key "rank"?', ['player.rank', 'player["rank"]', 'player.get(rank)', 'rank[player]'], 1, 'Dictionary values are accessed with their key inside square brackets.', 'warmup', 'python'],
  ['What does this create? {"white": 12, "black": 9}', ['A list', 'A tuple', 'A dictionary', 'A set'], 2, 'Curly braces with key-value pairs create a dictionary.', 'warmup', 'python'],
  ['Which method safely returns None when "bonus" is missing?', ['score["bonus"]', 'score.find("bonus")', 'score.get("bonus")', 'score.value("bonus")'], 2, 'get() avoids a KeyError when a key is absent.', 'tactic', 'python'],
  ['After board["e4"] = "pawn", what is board["e4"]?', ['"e4"', '"pawn"', 'True', 'A list'], 1, 'The key "e4" now maps to the value "pawn".', 'tactic', 'python'],
  ['What is the result of scores = {"white": 3}; scores["black"] = scores.get("black", 0) + 1?', ['{"white": 3}', '{"black": 1}', '{"white": 3, "black": 1}', 'A KeyError'], 2, 'get("black", 0) supplies a default of 0 before adding 1.', 'advanced', 'python'],
  ['Which statement correctly merges bonus points into a dictionary named score?', ['score + {"bonus": 5}', 'score.update({"bonus": 5})', 'score.append("bonus", 5)', 'score.merge("bonus": 5)'], 1, 'update() adds or replaces key-value pairs in a dictionary.', 'advanced', 'python'],
  ['What does len({"a": 1, "b": 2, "c": 3}) return?', ['3', '6', '2', '1'], 0, 'len() returns the number of keys in a dictionary.', 'warmup', 'python'],
  ['Which keyword checks if a key exists in a dictionary?', ['in', 'has', 'exists', 'contains'], 0, 'The "in" keyword tests membership in dictionary keys.', 'tactic', 'python'],
  // JavaScript (8 questions)
  ['What does typeof null return in JavaScript?', ['"null"', '"object"', '"undefined"', '"boolean"'], 1, 'typeof null returns "object" — a well-known quirk in JavaScript.', 'warmup', 'javascript'],
  ['Which method adds an element to the end of an array?', ['array.add()', 'array.push()', 'array.append()', 'array.insert()'], 1, 'push() adds one or more elements to the end of an array.', 'warmup', 'javascript'],
  ['What is the result of "5" + 3 in JavaScript?', ['8', '"53"', 'NaN', 'Error'], 1, 'The + operator concatenates when one operand is a string.', 'tactic', 'javascript'],
  ['Which keyword declares a block-scoped variable?', ['var', 'let', 'global', 'define'], 1, 'let declares a block-scoped variable, unlike var which is function-scoped.', 'tactic', 'javascript'],
  ['What does Array.isArray([]) return?', ['false', 'true', 'undefined', 'null'], 1, 'Array.isArray() correctly identifies arrays, returning true.', 'advanced', 'javascript'],
  ['What is 0 === "0" in JavaScript?', ['true', 'false', 'TypeError', 'undefined'], 1, 'Strict equality (===) compares type and value; number vs string differs.', 'advanced', 'javascript'],
  ['What does Object.keys({a: 1, b: 2}) return?', ['["a", "b"]', '[1, 2]', '{a: 1, b: 2}', '[["a", 1], ["b", 2]]'], 0, 'Object.keys() returns an array of an object\'s own property names.', 'warmup', 'javascript'],
  ['Which array method creates a new array with matching elements?', ['filter()', 'find()', 'map()', 'forEach()'], 0, 'filter() returns a new array containing elements that pass the test.', 'tactic', 'javascript'],
  // TypeScript (8 questions)
  ['What does the string type annotation look like in TypeScript?', ['string', 'String', 'str', 'char'], 0, 'TypeScript uses lowercase primitive types: string, number, boolean.', 'warmup', 'typescript'],
  ['Which keyword defines a custom type in TypeScript?', ['type', 'class', 'struct', 'define'], 0, 'The "type" keyword creates a type alias in TypeScript.', 'warmup', 'typescript'],
  ['What is the output of: const x: number = "hello"?', ['Compilation error', 'Runtime error', '"hello"', 'undefined'], 0, 'TypeScript catches type mismatches at compile time.', 'tactic', 'typescript'],
  ['Which modifier makes a property read-only in TypeScript?', ['readonly', 'const', 'final', 'static'], 0, 'readonly prevents reassignment of a property after initialization.', 'tactic', 'typescript'],
  ['What does the "?" mean in TypeScript: name?: string?', ['Optional property', 'Nullable type', 'Required property', 'Array type'], 0, 'The "?" suffix marks a property as optional in an interface or type.', 'advanced', 'typescript'],
  ['Which utility type makes all properties required?', ['Required<T>', 'Partial<T>', 'Readonly<T>', 'Pick<T>'], 0, 'Required<T> constructs a type with all properties set to required.', 'advanced', 'typescript'],
  ['What is the difference between "interface" and "type"?', ['Both are similar, interface is extendable', 'interface is faster', 'type supports enums only', 'No difference'], 0, 'Both define object shapes; interfaces support declaration merging and extends.', 'warmup', 'typescript'],
  ['What does "any" type do in TypeScript?', ['Disables type checking', 'Accepts only numbers', 'Makes variables global', 'Creates a union'], 0, 'The "any" type disables type checking for that variable.', 'tactic', 'typescript'],
  // Java (8 questions)
  ['Which keyword creates a new object in Java?', ['new', 'create', 'make', 'object'], 0, 'The "new" keyword instantiates a class by allocating memory.', 'warmup', 'java'],
  ['What is the size of an int in Java?', ['4 bytes', '2 bytes', '8 bytes', '1 byte'], 0, 'Java int is always 4 bytes (32 bits) regardless of platform.', 'warmup', 'java'],
  ['Which collection stores key-value pairs in Java?', ['HashMap', 'ArrayList', 'LinkedList', 'HashSet'], 0, 'HashMap implements the Map interface for key-value storage.', 'tactic', 'java'],
  ['What does "static" mean in a Java method?', ['Belongs to the class, not instances', 'Cannot be changed', 'Runs fast', 'Is private'], 0, 'Static methods belong to the class itself and can be called without an instance.', 'tactic', 'java'],
  ['Which keyword handles exceptions in Java?', ['try-catch', 'handle', 'rescue', 'except'], 0, 'try-catch blocks are used to handle checked and unchecked exceptions.', 'advanced', 'java'],
  ['What is method overriding in Java?', ['Redefining a parent class method in a subclass', 'Defining multiple methods with the same name', 'Deleting a method', 'Importing a method'], 0, 'Overriding provides a specific implementation of a method defined in the superclass.', 'advanced', 'java'],
  ['Which keyword prevents a class from being inherited?', ['final', 'static', 'private', 'abstract'], 0, 'A final class cannot be subclassed or extended.', 'warmup', 'java'],
  ['What does ArrayList implement internally?', ['Dynamic array', 'Linked list', 'Binary tree', 'Hash table'], 0, 'ArrayList uses a resizable array that grows as elements are added.', 'tactic', 'java'],
];
const expectedCount = seedQuestions.length;
if (db.prepare('SELECT COUNT(*) AS count FROM quiz_questions').get().count < expectedCount) {
  const insert = db.prepare('INSERT INTO quiz_questions (prompt, choices_json, correct_index, explanation, difficulty, language) VALUES (?, ?, ?, ?, ?, ?)');
  const transaction = db.transaction(() => seedQuestions.forEach(([prompt, choices, correct, explanation, difficulty, language]) => insert.run(prompt, JSON.stringify(choices), correct, explanation, difficulty, language)));
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
  if (!signUp && !username) return 'Username is required.';
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
const TIER_LABELS = { warmup: 'Warmup', tactic: 'Tactic', advanced: 'Advanced' };
const TIER_PIECES = { warmup: 'Pawn', tactic: 'Knight & Bishop', advanced: 'Rook & Queen' };
function selectQuestion(difficulty, language) {
  return db.prepare('SELECT * FROM quiz_questions WHERE difficulty = ? AND language = ? ORDER BY RANDOM() LIMIT 1').get(difficulty, language)
    || db.prepare('SELECT * FROM quiz_questions WHERE difficulty = ? ORDER BY RANDOM() LIMIT 1').get(difficulty)
    || db.prepare('SELECT * FROM quiz_questions WHERE language = ? ORDER BY RANDOM() LIMIT 1').get(language)
    || db.prepare('SELECT * FROM quiz_questions ORDER BY RANDOM() LIMIT 1').get();
}
function pathIsClear(chess, from, to) {
  const files = 'abcdefgh';
  const fromFile = files.indexOf(from[0]); const fromRank = Number(from[1]);
  const toFile = files.indexOf(to[0]); const toRank = Number(to[1]);
  const fileStep = Math.sign(toFile - fromFile); const rankStep = Math.sign(toRank - fromRank);
  for (let file = fromFile + fileStep, rank = fromRank + rankStep; file !== toFile || rank !== toRank; file += fileStep, rank += rankStep) {
    if (chess.get(`${files[file]}${rank}`)) return false;
  }
  return true;
}
function canCaptureKing(chess, from, to, color) {
  const files = 'abcdefgh'; const source = chess.get(from); const target = chess.get(to);
  if (!source || !target || source.color !== color || target.color === color || target.type !== 'k') return false;
  const fileDistance = Math.abs(files.indexOf(to[0]) - files.indexOf(from[0]));
  const rankDistance = Math.abs(Number(to[1]) - Number(from[1]));
  if (source.type === 'p') return fileDistance === 1 && Number(to[1]) - Number(from[1]) === (color === 'w' ? 1 : -1);
  if (source.type === 'n') return fileDistance * rankDistance === 2;
  if (source.type === 'b') return fileDistance === rankDistance && pathIsClear(chess, from, to);
  if (source.type === 'r') return (fileDistance === 0 || rankDistance === 0) && pathIsClear(chess, from, to);
  if (source.type === 'q') return (fileDistance === 0 || rankDistance === 0 || fileDistance === rankDistance) && pathIsClear(chess, from, to);
  return source.type === 'k' && Math.max(fileDistance, rankDistance) === 1;
}
function serializeGame(gameId, viewerId) {
  const game = db.prepare(`SELECT g.*, u.username AS owner_name FROM games g JOIN users u ON u.id = g.owner_id WHERE g.id = ?`).get(gameId);
  if (!game) return null;
  const players = db.prepare(`SELECT gp.user_id AS id, u.username, gp.color, gp.points FROM game_players gp JOIN users u ON u.id = gp.user_id WHERE gp.game_id = ? ORDER BY gp.color`).all(gameId);
  const challenge = challengeFor(gameId);
  const publicChallenge = challenge ? { userId: challenge.user_id, capturedPiece: challenge.captured_piece, difficulty: challenge.difficulty, isRevealed: !!challenge.is_revealed, awaiting: true, yours: challenge.user_id === viewerId } : null;
  let inCheck = false;
  if (game.status === 'active') { try { const chess = new Chess(game.fen); inCheck = chess.in_check(); } catch {} }
  let gameStats = null;
  if (game.status === 'finished') {
    gameStats = db.prepare(`SELECT qa.user_id, qq.difficulty, COUNT(*) AS attempted, SUM(qa.is_correct) AS correct FROM quiz_attempts qa JOIN quiz_questions qq ON qq.id = qa.question_id WHERE qa.game_id = ? GROUP BY qa.user_id, qq.difficulty`).all(gameId);
  }
  return { ...game, moves: JSON.parse(game.moves_json), players, challenge: publicChallenge, inCheck, gameStats, you: players.find((p) => p.id === viewerId) || null };
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
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((req.body.username || '').trim());
  if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) return res.status(401).json({ error: 'Username or password is incorrect.' });
  res.json({ token: issueToken(user), user: safeUser(user) });
});
app.get('/api/auth/me', auth, (req, res) => res.json(safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id))));

app.get('/api/users/me/stats', auth, (req, res) => {
  const userId = req.user.id;
  const gamesPlayed = db.prepare('SELECT COUNT(*) AS count FROM game_players WHERE user_id = ?').get(userId).count;
  const gamesWon = db.prepare('SELECT COUNT(*) AS count FROM games WHERE winner_id = ?').get(userId).count;
  const winRate = gamesPlayed > 0 ? Math.round((gamesWon / gamesPlayed) * 1000) / 10 : 0;

  const quizStats = db.prepare(`
    SELECT qq.language, COUNT(*) AS attempted, SUM(qa.is_correct) AS correct
    FROM quiz_attempts qa
    JOIN quiz_questions qq ON qq.id = qa.question_id
    WHERE qa.user_id = ?
    GROUP BY qq.language
  `).all(userId);

  const quizzes = {};
  for (const lang of ['python', 'javascript', 'typescript', 'java']) {
    const row = quizStats.find((r) => r.language === lang);
    const attempted = row ? row.attempted : 0;
    const correct = row ? row.correct : 0;
    quizzes[lang] = { attempted, correct, rate: attempted > 0 ? Math.round((correct / attempted) * 1000) / 10 : 0 };
  }

  res.json({ gamesPlayed, gamesWon, winRate, quizzes });
});

app.get('/api/games', auth, (req, res) => {
  const games = db.prepare(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM game_players gp WHERE gp.game_id = g.id) AS player_count FROM games g JOIN users u ON u.id = g.owner_id WHERE g.status != 'finished' ORDER BY g.updated_at DESC`).all();
  res.json(games);
});
app.post('/api/games', auth, (req, res) => {
  const language = (req.body.language || 'python').toLowerCase();
  if (!ALLOWED_LANGUAGES.includes(language)) return res.status(422).json({ error: 'Select a valid language: Python, JavaScript, TypeScript, or Java.' });
  const title = `${LANGUAGES[language]} Duel`;
  const id = crypto.randomBytes(4).toString('hex').toUpperCase();
  const chess = new Chess();
  db.transaction(() => {
    db.prepare('INSERT INTO games (id, title, language, owner_id, fen) VALUES (?, ?, ?, ?, ?)').run(id, title, language, req.user.id, chess.fen());
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
app.post('/api/games/:id/leave', auth, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found.' });
  if (game.status !== 'active') return res.status(422).json({ error: 'This game is not in progress.' });
  const leaver = playerFor(game.id, req.user.id);
  if (!leaver) return res.status(403).json({ error: 'You are not in this game.' });
  const opponent = db.prepare('SELECT gp.*, u.username FROM game_players gp JOIN users u ON u.id = gp.user_id WHERE gp.game_id = ? AND gp.user_id != ?').get(game.id, req.user.id);
  if (!opponent) return res.status(422).json({ error: 'No opponent found.' });
  db.prepare('UPDATE games SET status = ?, winner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('finished', opponent.user_id, game.id);
  const leaveQuestion = selectQuestion('warmup', game.language);
  if (leaveQuestion) {
    db.prepare('INSERT INTO quiz_attempts (game_id, user_id, question_id, selected_index, is_correct) VALUES (?, ?, ?, ?, ?)').run(game.id, opponent.user_id, leaveQuestion.id, leaveQuestion.correct_index, 1);
    db.prepare('INSERT INTO quiz_attempts (game_id, user_id, question_id, selected_index, is_correct) VALUES (?, ?, ?, ?, ?)').run(game.id, req.user.id, leaveQuestion.id, -1, 0);
  }
  broadcastGame(game.id);
  io.to(`game:${game.id}`).emit('game:left', { username: leaver.username || req.user.username });
  res.json({ success: true });
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
  if (!challenge.is_revealed) return res.status(403).json({ error: 'Scan the matching tier QR card to reveal this challenge.' });
  res.json({ id: challenge.question_id, prompt: challenge.prompt, choices: JSON.parse(challenge.choices_json), difficulty: challenge.difficulty, capturedPiece: challenge.captured_piece });
});
app.post('/api/scan', auth, (req, res) => {
  const { difficulty } = req.body;
  if (!['warmup', 'tactic', 'advanced'].includes(difficulty)) return res.status(422).json({ error: 'Invalid tier.' });
  const challenge = db.prepare(`SELECT c.*, g.id AS gid FROM game_challenges c JOIN games g ON g.id = c.game_id WHERE c.user_id = ? AND c.difficulty = ? AND c.is_revealed = 0 AND g.status = 'active'`).get(req.user.id, difficulty);
  if (!challenge) return res.status(404).json({ error: 'No matching challenge found. Make sure you have a pending capture of that tier.' });
  db.prepare('UPDATE game_challenges SET is_revealed = 1 WHERE game_id = ?').run(challenge.game_id);
  broadcastGame(challenge.game_id);
  res.json({ gameId: challenge.game_id, success: true });
});
app.get('/api/qr-tiers', async (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const tiers = ['warmup', 'tactic', 'advanced'];
  const results = await Promise.all(tiers.map(async (tier) => {
    const url = `${baseUrl}/#scan=${tier}`;
    const image = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#14251c', light: '#f6f1e8' } });
    return { tier, label: TIER_LABELS[tier], pieces: TIER_PIECES[tier], url, image };
  }));
  res.json(results);
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
  res.json({ correct, explanation: question.explanation, pointsAwarded: correct ? 10 : 0, extraMove: correct, correctIndex: question.correct_index, choices: JSON.parse(question.choices_json) });
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
      let move;
      const target = chess.get(to);
      if (target?.type === 'k' && canCaptureKing(chess, from, to, player.color === 'white' ? 'w' : 'b')) {
        const source = chess.get(from);
        chess.remove(from); chess.remove(to); chess.put(source, to);
        move = { san: `${source.type.toUpperCase()}${from}x${to}#`, from, to, captured: 'k' };
        const parts = chess.fen().split(' ');
        parts[1] = player.color === 'white' ? 'b' : 'w';
        parts[2] = '-';
        parts[3] = '-';
        if (parts[1] === 'b') parts[5] = String(Number(parts[5]) + 1);
        chess.load(parts.join(' '));
      } else {
        move = chess.move({ from, to, promotion });
      }
      let status = move.captured === 'k' || chess.isCheckmate() || chess.isDraw() ? 'finished' : 'active';
      db.transaction(() => {
        const currentGame = db.prepare('SELECT moves_json FROM games WHERE id = ?').get(gameId);
        const moves = JSON.parse(currentGame.moves_json);
        moves.push({ san: move.san, from, to, by: socket.user.username, at: Date.now(), captured: move.captured || null });
        if (status === 'finished' && !chess.isDraw()) {
          db.prepare('UPDATE games SET fen = ?, moves_json = ?, status = ?, winner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chess.fen(), JSON.stringify(moves), status, socket.user.id, gameId);
          const loser = db.prepare('SELECT user_id FROM game_players WHERE game_id = ? AND user_id != ?').get(gameId, socket.user.id);
          const endQuestion = selectQuestion('warmup', game.language);
          if (endQuestion) {
            db.prepare('INSERT INTO quiz_attempts (game_id, user_id, question_id, selected_index, is_correct) VALUES (?, ?, ?, ?, ?)').run(gameId, socket.user.id, endQuestion.id, endQuestion.correct_index, 1);
            if (loser) db.prepare('INSERT INTO quiz_attempts (game_id, user_id, question_id, selected_index, is_correct) VALUES (?, ?, ?, ?, ?)').run(gameId, loser.user_id, endQuestion.id, -1, 0);
          }
        } else {
          db.prepare('UPDATE games SET fen = ?, moves_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(chess.fen(), JSON.stringify(moves), status, gameId);
        }
        if (move.captured && status === 'active') {
          const difficulty = tierForPiece(move.captured);
          const question = selectQuestion(difficulty, game.language);
          db.prepare('INSERT INTO game_challenges (game_id, user_id, question_id, captured_piece, difficulty) VALUES (?, ?, ?, ?, ?)').run(gameId, socket.user.id, question.id, move.captured, difficulty);
        }
      })();
      broadcastGame(gameId);
      if (move.captured && status === 'active') socket.emit('challenge:earned', { gameId, capturedPiece: move.captured, difficulty: tierForPiece(move.captured), reason: `Capture confirmed. Scan the ${TIER_LABELS[tierForPiece(move.captured)]} QR card to reveal your challenge.` });
    } catch { socket.emit('app:error', 'That move is not legal.'); }
  });
});

server.listen(port, () => console.log(`PyCheckmate running at http://localhost:${port}`));
