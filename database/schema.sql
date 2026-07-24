-- PyCheckmate database schema
-- Python concept: dictionaries

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  fen TEXT NOT NULL,
  moves_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE game_players (
  game_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('white', 'black')),
  points INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (game_id, user_id),
  UNIQUE (game_id, color),
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  explanation TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('warmup', 'tactic', 'advanced', 'endgame')),
  author_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  selected_index INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (question_id) REFERENCES quiz_questions(id)
);

CREATE TABLE game_challenges (
  game_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  captured_piece TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (question_id) REFERENCES quiz_questions(id)
);
