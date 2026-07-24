# PyCheckmate

An educational hybrid chess game that teaches one Python concept: **dictionaries**.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in two browser sessions and create two accounts.

## Game rules

1. White creates a table and Black joins it.
2. Capturing a piece pauses the board and opens a Python dictionary question for the capturing player.
3. Question tier follows the captured piece: pawn = warmup; knight/bishop = tactic; rook/queen = advanced.
4. A correct answer gives 10 mastery points and an immediate extra move. A wrong answer passes the turn.
5. Capturing the king (or checkmate under standard movement) ends the game.

The physical component is a printable QR code shown for each live table. Place it beside the physical chessboard; scanning it opens the same live digital board and challenge station.

## Stack

- Node.js, Express, Socket.IO
- SQLite (`better-sqlite3`)
- Chess.js game engine
- JWT authentication with bcrypt password hashing

`database/schema.sql` is included for the required database submission.
