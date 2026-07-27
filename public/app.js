const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const API = '/api';
let token = localStorage.getItem('pycheckmate_token');
let user = JSON.parse(localStorage.getItem('pycheckmate_user') || 'null');
let games = [];
let game = null;
let socket = null;
let selected = null;
let qr = null;
let challengeQuestion = null;
let answerResult = null;
let tierQrs = null;
let openingGame = false;
let html5QrCode = null;
let scanModalOpen = false;
let scanCallbackPending = null;
let profileOpen = false;
let profileStats = null;
let gameForfeited = false;
let roomSearch = '';

const PIECE_URL = 'https://images.chesscomfiles.com/chess-themes/pieces/neo/80/';
const pieceImage = (ch) => ch ? `${PIECE_URL}${({ K:'wk', Q:'wq', R:'wr', B:'wb', N:'wn', P:'wp', k:'bk', q:'bq', r:'br', b:'bb', n:'bn', p:'bp' })[ch]}.png` : '';
const labels = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };
const escape = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const tierMeta = { warmup: { label: 'Warmup', pieces: 'Pawn', color: '#769656' }, tactic: { label: 'Tactic', pieces: 'Knight & Bishop', color: '#5a7fb5' }, advanced: { label: 'Advanced', pieces: 'Rook & Queen', color: '#b55a5a' } };

function downloadQrPdf(tier, imageDataUrl) {
  const meta = tierMeta[tier];
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    canvas.toBlob((jpegBlob) => {
      if (!jpegBlob) return notice('Failed to generate PDF.');
      jpegBlob.arrayBuffer().then((buf) => {
        const jpegBytes = new Uint8Array(buf);
        const enc = new TextEncoder();
        const pageW = 595, pageH = 842;
        const imgDim = 280;
        const scale = imgDim / Math.max(img.width, img.height);
        const dw = img.width * scale, dh = img.height * scale;
        const ix = (pageW - dw) / 2, iy = (pageH - dh) / 2;
        const parts = [];
        const add = (s) => parts.push(typeof s === 'string' ? enc.encode(s) : s);
        const offsets = [];
        add('%PDF-1.4\n');
        offsets.push(parts.reduce((a, p) => a + p.length, 0));
        add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
        offsets.push(parts.reduce((a, p) => a + p.length, 0));
        add('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
        offsets.push(parts.reduce((a, p) => a + p.length, 0));
        add('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW + ' ' + pageH + '] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> /XObject << /Img 5 0 R >> >> >>\nendobj\n');
        const titleLine = 'BT /F1 20 Tf ' + ((pageW - meta.label.length * 6) / 2) + ' ' + (pageH - 70) + ' Td (' + meta.label + ' Tier QR Code) Tj ET';
        const piecesLine = 'BT /F1 12 Tf ' + ((pageW - meta.pieces.length * 4) / 2) + ' ' + (pageH - 95) + ' Td (Scans for: ' + meta.pieces + ') Tj ET';
        const imgCmd = 'q ' + dw + ' 0 0 ' + dh + ' ' + ix + ' ' + iy + ' cm /Img Do Q';
        const content = titleLine + '\n' + piecesLine + '\n' + imgCmd;
        const contentBytes = enc.encode(content);
        offsets.push(parts.reduce((a, p) => a + p.length, 0));
        add('4 0 obj\n<< /Length ' + contentBytes.length + ' >>\nstream\n');
        add(contentBytes);
        add('\nendstream\nendobj\n');
        offsets.push(parts.reduce((a, p) => a + p.length, 0));
        add('5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + img.width + ' /Height ' + img.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegBytes.length + ' >>\nstream\n');
        add(jpegBytes);
        add('\nendstream\nendobj\n');
        offsets.push(parts.reduce((a, p) => a + p.length, 0));
        add('6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
        const xrefOff = parts.reduce((a, p) => a + p.length, 0);
        add('xref\n0 7\n0000000000 65535 f \n');
        for (const o of offsets) add(String(o).padStart(10, '0') + ' 00000 n \n');
        add('trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF');
        let total = 0; for (const p of parts) total += p.length;
        const result = new Uint8Array(total); let off = 0;
        for (const p of parts) { result.set(p, off); off += p.length; }
        const blob = new Blob([result], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'pycheckmate-' + tier + '-qr.pdf';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        notice(meta.label + ' QR PDF downloaded.');
      });
    }, 'image/jpeg', 0.92);
  };
  img.src = imageDataUrl;
}

function printAllQr() {
  if (!tierQrs) return notice('QR codes not loaded yet.');
  const w = window.open('', '_blank', 'width=900,height=700');
  const cards = tierQrs.map(t => `
    <div style="flex:1;text-align:center;border:1px solid #ddd;border-radius:12px;padding:24px 16px;background:#fff">
      <div style="width:14px;height:14px;border-radius:50%;background:${tierMeta[t.tier].color};margin:0 auto 12px"></div>
      <h2 style="font-family:'Playfair Display',serif;font-size:22px;margin:0 0 4px">${t.label}</h2>
      <div style="font-family:monospace;font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.1em;margin-bottom:16px">${t.label} Tier</div>
      <img src="${t.image}" style="width:220px;height:220px;border-radius:8px;border:1px solid #eee" />
      <div style="font-family:monospace;font-size:12px;color:#666;margin-top:12px">Scans for: ${t.pieces}</div>
      <div style="font-size:11px;color:#999;margin-top:6px">Scan with phone to reveal challenge</div>
    </div>
  `).join('');
  w.document.write(`<!doctype html><html><head><title>PyCheckmate - Tier QR Cards</title>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;600&display=swap" rel="stylesheet">
    <style>
      * { box-sizing:border-box; margin:0; padding:0 }
      body { font-family:'Plus Jakarta Sans',sans-serif; padding:40px 32px; background:#f6f1e8; color:#14251c }
      h1 { font:700 28px 'Playfair Display',serif; text-align:center; margin-bottom:6px }
      .sub { text-align:center;font-size:14px;color:#52715c;margin-bottom:32px }
      .cards { display:flex; gap:24px; justify-content:center }
      .footer { text-align:center;margin-top:32px;font-size:12px;color:#8a9b8f }
      @media print { body { background:#fff;padding:20px } .no-print { display:none } }
    </style></head><body>
    <h1>PyCheckmate Tier QR Cards</h1>
    <p class="sub">Print and place beside your physical chess board.</p>
    <div class="cards">${cards}</div>
    <div class="footer no-print"><p style="margin-bottom:12px">Press Ctrl+P / Cmd+P to print, or save as PDF.</p></div>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 600);
}

function scanModal() {
  if (!scanModalOpen) return '';
  const ch = game?.challenge;
  const tierLabels = { warmup: 'Warmup', tactic: 'Tactic', advanced: 'Advanced' };
  const tierPieces = { warmup: 'Pawn', tactic: 'Knight & Bishop', advanced: 'Rook & Queen' };
  const expectedTier = ch ? tierLabels[ch.difficulty] : '';
  const tierColor = ch ? tierMeta[ch.difficulty]?.color : '#769656';
  return `<div class="scan-overlay" data-action="close-scanner"><div class="scan-modal" onclick="event.stopPropagation()"><div class="scan-header"><h3>Scan QR Card</h3><button class="scan-close" data-action="close-scanner">&times;</button></div><div class="scan-video-container"><div id="scan-reader"></div><div class="scan-frame"><div class="scan-corner tl"></div><div class="scan-corner tr"></div><div class="scan-corner bl"></div><div class="scan-corner br"></div></div></div><div class="scan-status" id="scan-status">Point camera at a tier QR card</div>${expectedTier ? `<div class="scan-tier-hint"><span class="tier-badge ${ch.difficulty}">${expectedTier}</span><span class="scan-tier-pieces">Matches: ${tierPieces[ch.difficulty] || ''}</span></div>` : ''}</div></div>`;
}

async function openScanner() {
  if (scanModalOpen) return;
  scanModalOpen = true;
  render();
  await new Promise(r => setTimeout(r, 50));
  const readerEl = document.getElementById('scan-reader');
  if (!readerEl) { scanModalOpen = false; render(); return; }
  html5QrCode = new Html5Qrcode('scan-reader');
  const statusEl = document.getElementById('scan-status');
  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
      async (decodedText) => {
        const tierMatch = decodedText.match(/#scan=(\w+)$/);
        if (!tierMatch) {
          if (statusEl) statusEl.textContent = 'Invalid QR code. Please scan a tier QR card.';
          return;
        }
        const difficulty = tierMatch[1];
        if (!['warmup', 'tactic', 'advanced'].includes(difficulty)) {
          if (statusEl) statusEl.textContent = 'Unknown tier. Please scan Warmup, Tactic, or Advanced.';
          return;
        }
        try {
          if (statusEl) statusEl.textContent = 'QR detected! Revealing challenge...';
          await closeScanner();
          const result = await api('/scan', { method: 'POST', body: JSON.stringify({ difficulty }) });
          notice('Challenge revealed! Check your board.');
          location.hash = `#game=${result.gameId}`;
          await openGame(result.gameId);
        } catch (error) {
          notice(error.message);
          if (scanModalOpen) { if (statusEl) statusEl.textContent = error.message + ' Try again.'; }
        }
      },
      () => {}
    );
    if (statusEl) statusEl.textContent = 'Scanning... Point camera at a tier QR card';
  } catch (error) {
    if (statusEl) statusEl.textContent = 'Camera access denied. Please allow camera access and try again.';
    notice('Could not access camera.');
    await closeScanner();
  }
}

async function closeScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch {}
    html5QrCode = null;
  }
  scanModalOpen = false;
  const overlay = document.querySelector('.scan-overlay');
  if (overlay) overlay.remove();
  else render();
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Something went wrong.');
  return body;
}
function notice(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3500); }
function nav() { return `<header class="nav"><button class="brand" data-nav="lobby"><span class="brand-mark">♞</span>PyCheckmate</button>${user ? `<div class="nav-side"><button class="text-button profile-trigger" data-action="open-profile">${escape(user.username)}</button><button class="avatar profile-trigger" data-action="open-profile">${escape(user.username.slice(0, 1).toUpperCase())}</button><button class="button leave-btn" data-action="logout">Log Out</button></div>` : '<div class="nav-side">Python dictionaries × chess</div>'}</header>`; }
function langLabel(lang) { return { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java' }[lang] || lang; }
function langColor(lang) { return { python: '#3572A5', javascript: '#f1e05a', typescript: '#3178c6', java: '#b07219' }[lang] || '#769656'; }
function userProfilePanel() {
  if (!profileOpen) return '';
  const s = profileStats;
  const bar = (rate) => `<div class="profile-bar-track"><div class="profile-bar-fill" style="width:${rate}%"></div></div>`;
  const quizSection = s ? ['python', 'javascript', 'typescript', 'java'].map((lang) => {
    const q = s.quizzes[lang];
    return `<div class="profile-quiz-row"><div class="profile-quiz-head"><span class="profile-quiz-lang">${langLabel(lang)}</span><span class="profile-quiz-stat">${q.correct}/${q.attempted} · ${q.rate}%</span></div>${bar(q.rate)}</div>`;
  }).join('') : '';
  return `<div class="profile-overlay" data-action="close-profile"></div><aside class="profile-panel closing-prepare"><div class="profile-panel-header"><h3>Profile</h3><button class="profile-close" data-action="close-profile"></button></div><div class="profile-panel-body"><div class="profile-identity"><div class="avatar profile-avatar-lg">${escape(user.username.slice(0, 1).toUpperCase())}</div><div class="profile-name">${escape(user.username)}</div><div class="profile-email">${escape(user.email)}</div></div><div class="profile-section"><div class="profile-section-title">Battle Stats</div>${s ? `<div class="profile-stat-row"><span class="profile-stat-label">Won</span><span class="profile-stat-value">${s.gamesWon} / ${s.gamesPlayed} games</span></div><div class="profile-stat-row"><span class="profile-stat-label">Win Rate</span><span class="profile-stat-value">${s.winRate}%</span></div>${bar(s.winRate)}` : '<div class="profile-loading">Loading…</div>'}</div><div class="profile-section"><div class="profile-section-title">Quiz Win Rates</div>${s ? quizSection : '<div class="profile-loading">Loading…</div>'}</div></div></aside>`;
}
function hero() { return `${nav()}<section class="shell hero"><div><div class="eyebrow">A hybrid learning game</div><h1>Capture pieces.<br /><em>Capture concepts.</em></h1><p class="hero-copy">A real-time chess game where every capture unlocks a Python dictionaries challenge. Answer it correctly, and the board is yours for one more move.</p><div class="hero-actions"><button class="button" data-action="show-register">Start playing</button><button class="button ghost" data-action="show-login">I have an account</button></div><div class="rule-strip"><span>01 / capture a piece</span><span>02 / scan the matching QR card</span><span>03 / answer correctly</span><span>04 / move again</span></div></div><div class="hero-card"><div class="card-top"><strong>LIVE BOARD</strong><span class="online">2 players connected</span></div><div class="mini-board">${initialBoard().map((piece, i) => `<div class="mini-square ${(Math.floor(i / 8) + i) % 2 ? 'dark' : 'light'}">${piece ? `<img class="mini-piece" src="${pieceImage(piece)}" alt="${labels[piece.toLowerCase()] || ''}" draggable="false" />` : ''}</div>`).join('')}</div><div class="card-caption">CAPTURE → DICTIONARY CHALLENGE → EXTRA MOVE</div></div></section>`; }
function authForm(mode) { const register = mode === 'register'; return `${nav()}<section class="auth-wrap"><form class="auth-card" id="auth-form"><div class="eyebrow">${register ? 'Create your player profile' : 'Welcome back'}</div><h1>${register ? 'Join the club.' : 'Make your move.'}</h1><p>${register ? 'Your progress, scores and games are saved securely for your next visit.' : 'Sign in to continue your dictionary chess journey.'}</p><div class="field"><label>Player name</label><input required name="username" autocomplete="username" placeholder="e.g. chess_coder" ${register ? 'pattern="[A-Za-z0-9_]{3,20}"' : ''} /></div>${register ? `<div class="field"><label>Email address</label><input required type="email" name="email" autocomplete="email" placeholder="you@example.com" /></div>` : ''}<div class="field"><label>Password</label><input required type="password" name="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="8" placeholder="At least 8 characters" /></div><button class="button" style="width:100%;margin-top:8px">${register ? 'Create account' : 'Sign in'}</button><p class="auth-switch">${register ? 'Already have an account?' : 'New to PyCheckmate?'} <button type="button" class="text-button" data-action="show-${register ? 'login' : 'register'}">${register ? 'Sign in' : 'Create an account'}</button></p></form></section>`; }
function lobby() {
  const langNames = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java' };
  const query = roomSearch.trim().toUpperCase();
  const filtered = query ? games.filter((item) => item.id.toUpperCase().includes(query)) : games;
  const emptyMsg = !games.length
    ? 'No open games yet. Create the first board.'
    : query
      ? `No games match room code “${escape(query)}”.`
      : 'No open games yet. Create the first board.';
  return `${nav()}<main class="shell"><section class="lobby-head"><div><div class="eyebrow">Your arena</div><h1>Code with Chess.</h1></div><div class="lobby-actions"><form class="room-search" id="room-search-form" autocomplete="off"><input id="room-search" name="roomCode" type="search" placeholder="Search room code…" value="${escape(roomSearch)}" maxlength="12" spellcheck="false" aria-label="Search room code" /><button type="submit" class="button ghost">Join</button></form><button class="button gold" data-action="new-game">Create a Game</button></div></section><section class="games">${filtered.length ? filtered.map((item) => `<article class="game-card" data-action="join" data-id="${item.id}" role="button" tabindex="0"><div class="game-meta"><span class="pill">${item.status === 'waiting' ? 'awaiting rival' : 'in play'}</span><span class="lang-badge">${langNames[item.language] || 'Python'}</span><span>${item.id}</span></div><h3>${escape(item.title)}</h3><p>Hosted by ${escape(item.owner_name)} · ${item.player_count}/2 players</p><button class="button ${item.status === 'waiting' ? 'gold' : ''}" tabindex="-1">${item.status === 'waiting' ? 'Join game' : 'Watch board'}</button></article>`).join('') : `<div class="empty">${emptyMsg}</div>`}</section></main>`;
}
function newGameModal() { return `<div class="new-game"><form class="modal" id="new-game-form"><div class="eyebrow">New table</div><h2>Choose your language.</h2><p style="font-size:13px;color:#617066;line-height:1.6">You play White. Your opponent will join as Black.</p><div class="field"><label>Language</label><select required name="language"><option value="python">Python</option><option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="java">Java</option></select></div><div class="modal-actions"><button type="button" class="button ghost" data-action="close-modal">Cancel</button><button class="button">Create a Game</button></div></form></div>`; }
function boardPieces(fen) { const cells = []; fen.split(' ')[0].split('/').forEach((rank) => { for (const char of rank) { if (/\d/.test(char)) cells.push(...Array(Number(char)).fill('')); else cells.push(char); } }); return cells; }
function initialBoard() { return boardPieces('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); }
function myPlayer() { return game?.players?.find((player) => player.id === user?.id); }
function ownsChallenge() { return game?.challenge?.userId === user?.id; }
function isMyTurn() { const mine = myPlayer(); return mine && game.status !== 'finished' && !game.challenge && (game.fen.split(' ')[1] === (mine.color === 'white' ? 'w' : 'b')); }
function gameBoard() {
  const cells = boardPieces(game.fen);
  const mine = myPlayer();
  const flipped = mine && mine.color === 'black';
  const lastFrom = game.moves.length ? game.moves[game.moves.length - 1].from : null;
  const lastTo = game.moves.length ? game.moves[game.moves.length - 1].to : null;
  const files = 'abcdefgh';
  const ranks = [8,7,6,5,4,3,2,1];
  let checkSquare = null;
  if (game.inCheck) { const activeColor = game.fen.split(' ')[1]; const kingChar = activeColor === 'w' ? 'K' : 'k'; const kingIdx = cells.indexOf(kingChar); if (kingIdx >= 0) checkSquare = `${files[kingIdx % 8]}${ranks[Math.floor(kingIdx / 8)]}`; }
  const displayRanks = flipped ? [...ranks].reverse() : ranks;
  const displayFiles = flipped ? [...files].reverse().join('') : files;
  return `<div class="board-wrap"><div class="board-coords-left">${displayRanks.map(r => `<span class="coord-label">${r}</span>`).join('')}</div><div class="board-col"><div class="board" aria-label="Chess board">${cells.map((piece, index) => {
    const origRank = ranks[Math.floor(index / 8)];
    const origFile = files[index % 8];
    const square = `${origFile}${origRank}`;
    const color = (Math.floor(index / 8) + index) % 2 ? 'dark' : 'light';
    const isSelected = selected === square;
    const isLastMove = square === lastFrom || square === lastTo;
    const isCheck = square === checkSquare;
    const classes = ['square', color];
    if (isSelected) classes.push('select');
    if (isLastMove) classes.push('last-move');
    if (isCheck) classes.push('check');
    return `<button class="${classes.join(' ')}" data-square="${square}" aria-label="${square} ${piece ? labels[piece.toLowerCase()] : 'empty'}">${piece ? `<img class="piece" src="${pieceImage(piece)}" alt="${labels[piece.toLowerCase()]}" draggable="false" />` : ''}</button>`;
  }).join('')}</div><div class="board-coords-bottom">${displayFiles.split('').map(f => `<span class="coord-label">${f}</span>`).join('')}</div></div></div>`;
}
function sidePanel() { const active = game.fen.split(' ')[1] === 'w' ? 'White' : 'Black'; const recent = game.moves.slice(-12).reverse(); const challengeStatus = game.challenge ? (game.challenge.isRevealed ? 'challenge active' : 'awaiting scan') : ''; const checkText = game.inCheck ? (isMyTurn() ? 'Your king is in check!' : `${active} king is in check!`) : ''; const challengeHeading = game.challenge ? (game.challenge.isRevealed ? `${labels[game.challenge.capturedPiece]} challenge` : `Scan the ${({ warmup: 'Warmup', tactic: 'Tactic', advanced: 'Advanced' })[game.challenge.difficulty]} QR card`) : game.inCheck ? checkText : `${active} to move`; const challengeText = game.challenge ? (ownsChallenge() ? (game.challenge.isRevealed ? 'Answer correctly to earn an immediate extra move.' : 'Scan the matching tier QR card beside the board to reveal your challenge.') : 'Play is paused while the capturer answers.') : 'Every capture tests your dictionary mastery.'; const showScanBtn = game.challenge && ownsChallenge() && !game.challenge.isRevealed; return `<aside class="side-panel"><div class="side-top-bar">${game.status === 'active' ? `<button class="button leave-btn" data-action="leave-game">Leave Game</button>` : game.status === 'waiting' ? `<button class="button ghost" data-action="back">Arena</button>` : `<button class="button" data-action="back">Lobby</button>`}</div><section class="panel turn"><div class="eyebrow" style="color:${game.inCheck ? 'var(--coral)' : '#a7d39f'}">${game.status === 'finished' ? 'game complete' : game.challenge ? challengeStatus : game.inCheck ? 'CHECK' : isMyTurn() ? 'your move' : 'opponent is thinking'}</div><h3 style="font-size:19px;margin:7px 0">${game.status === 'finished' ? (gameForfeited ? 'Opponent Forfeited' : 'Checkmate. King taken.') : challengeHeading}</h3><p>${challengeText}</p>${showScanBtn ? `<button class="button scan-btn" data-action="open-scanner" style="margin-top:12px;width:100%">Scan QR with Camera</button>` : ''}</section><section class="panel"><h3>Players & mastery</h3>${game.players.map((player) => `<div class="player"><span class="player-dot ${player.color}"></span><span class="player-name">${escape(player.username)} ${player.id === user.id ? '(you)' : ''}</span><span class="score">${player.points} XP</span></div>`).join('')}</section><section class="panel"><h3>Move log</h3><div class="moves">${recent.length ? recent.map((move, index) => `<span class="move">${game.moves.length - index}. ${escape(move.san)}</span>`).join('') : '<span>First move awaits.</span>'}</div></section>${qr ? `<section class="panel qr"><img src="${qr.image}" alt="Game QR code" /><p><strong>Physical board QR</strong><br/>Print this QR beside the physical board. It opens this live match and its challenge station.</p></section>` : ''}</aside>`; }
function mobileGameInfo() { const active = game.fen.split(' ')[1] === 'w' ? 'White' : 'Black'; const challengeStatus = game.challenge ? (game.challenge.isRevealed ? 'challenge active' : 'awaiting scan') : ''; const checkText = game.inCheck ? (isMyTurn() ? 'Your king is in check!' : `${active} king is in check!`) : ''; const challengeHeading = game.challenge ? (game.challenge.isRevealed ? `${labels[game.challenge.capturedPiece]} challenge` : `Scan the ${({ warmup: 'Warmup', tactic: 'Tactic', advanced: 'Advanced' })[game.challenge.difficulty]} QR card`) : game.inCheck ? checkText : `${active} to move`; const challengeText = game.challenge ? (ownsChallenge() ? (game.challenge.isRevealed ? 'Answer correctly to earn an extra move.' : 'Scan the matching tier QR card to reveal your challenge.') : 'Play is paused while the capturer answers.') : 'Every capture tests your dictionary mastery.'; const showScanBtn = game.challenge && ownsChallenge() && !game.challenge.isRevealed; return `<div class="mobile-game-info"><div class="mobile-info-card mobile-turn"><div class="eyebrow" style="color:${game.inCheck ? 'var(--coral)' : '#a7d39f'}">${game.status === 'finished' ? 'game complete' : game.challenge ? challengeStatus : game.inCheck ? 'CHECK' : isMyTurn() ? 'your move' : 'opponent is thinking'}</div><h3 style="font-size:16px;margin:5px 0">${game.status === 'finished' ? (gameForfeited ? 'Opponent Forfeited.' : 'Checkmate.') : challengeHeading}</h3><p style="font-size:12px;line-height:1.5">${challengeText}</p>${showScanBtn ? `<button class="button scan-btn" data-action="open-scanner" style="margin-top:8px;width:100%;font-size:12px;padding:10px 14px">Scan QR with Camera</button>` : ''}</div><div class="mobile-info-card"><h3 style="font-size:14px;margin-bottom:6px">Players</h3>${game.players.map((player) => `<div class="player"><span class="player-dot ${player.color}"></span><span class="player-name">${escape(player.username)}${player.id === user.id ? ' (you)' : ''}</span><span class="score">${player.points} XP</span></div>`).join('')}</div><div class="mobile-info-card"><h3 style="font-size:14px;margin-bottom:6px">Moves</h3><div class="moves">${game.moves.length ? game.moves.slice(-8).reverse().map((move, index) => `<span class="move">${game.moves.length - index}. ${escape(move.san)}</span>`).join('') : '<span style="font-size:12px;color:#8a9b8f">First move awaits.</span>'}</div></div></div>`; }
function gameView() { const langNames = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java' }; return `${nav()}<main class="shell"><div class="game-title"><div><div class="eyebrow">${langNames[game.language] || 'Python'} · Table ${game.id}</div><h1>${escape(game.title)}</h1></div>${game.status === 'active' ? `<button class="button leave-btn game-title-back" data-action="leave-game">Leave Game</button>` : game.status === 'waiting' ? `<button class="button ghost game-title-back" data-action="back">Arena</button>` : `<button class="button game-title-back" data-action="back">Lobby</button>`}</div><section class="game-layout-three"><div class="rules-panel rules-col"><div class="eyebrow">How to play</div><h3>Rules</h3><ol class="rules-list"><li>Make standard chess moves to capture your opponent's pieces.</li><li>When you capture a piece, a <strong>${langNames[game.language] || 'Python'} challenge</strong> pops up based on the piece's tier.</li><li>Answer <strong>correctly</strong> to earn +10 XP and get an <strong>extra move</strong> immediately.</li><li>Answer <strong>wrong</strong> and your turn ends — your opponent plays next.</li><li>Game ends when a king is captured or checkmate is reached.</li></ol><div class="rules-tiers"><span class="tier"><span class="tier-dot warmup"></span>Pawn = Warmup</span><span class="tier"><span class="tier-dot tactic"></span>Knight / Bishop = Tactic</span><span class="tier"><span class="tier-dot advanced"></span>Rook / Queen = Advanced</span><span class="tier"><span class="tier-dot endgame"></span>King = Endgame</span></div></div><div class="board-col">${gameBoard()}</div>${sidePanel()}</section>${mobileGameInfo()}</main>${answerResult ? resultModal() : (gameForfeited && game.status === 'finished' ? forfeitModal() : (game.status === 'finished' && game.gameStats ? gameEndModal() : (game.challenge && ownsChallenge() && !game.challenge.isRevealed ? scanNotice() : (game.challenge && ownsChallenge() && game.challenge.isRevealed ? challengeModal() : ''))))}`; }
function challengeModal() { if (!challengeQuestion) return `<div class="new-game"><div class="modal challenge"><div class="eyebrow">Capture registered</div><h2>Preparing your ${labels[game.challenge.capturedPiece]} challenge…</h2></div></div>`; return `<div class="new-game"><div class="modal challenge"><span class="challenge-piece"><img src="${pieceImage(challengeQuestion.capturedPiece)}" alt="${labels[challengeQuestion.capturedPiece]}" /></span><div class="eyebrow">${escape(challengeQuestion.difficulty)} dictionary challenge</div><h2>Claim your extra move.</h2><p style="font-size:14px;line-height:1.6">You captured a ${labels[challengeQuestion.capturedPiece]}. Solve this to keep the turn.</p><strong style="font-size:15px;line-height:1.45;display:block;margin-top:16px">${escape(challengeQuestion.prompt)}</strong><div class="answer-list">${challengeQuestion.choices.map((choice, index) => `<button class="answer" data-action="answer" data-index="${index}"><span class="answer-prefix">${'ABCD'[index]}</span>${escape(choice)}</button>`).join('')}</div></div></div>`; }
function scanNotice() { const ch = game.challenge; const tierLabels = { warmup: 'Warmup', tactic: 'Tactic', advanced: 'Advanced' }; const tierPieces = { warmup: 'Pawn', tactic: 'Knight & Bishop', advanced: 'Rook & Queen' }; return `<div class="new-game"><div class="modal scan-notice"><span class="challenge-piece"><img src="${pieceImage(ch.capturedPiece)}" alt="${labels[ch.capturedPiece]}" /></span><div class="eyebrow">Scan required</div><h2>Scan the ${tierLabels[ch.difficulty]} QR card</h2><p style="font-size:14px;line-height:1.6">You captured a <strong>${labels[ch.capturedPiece]}</strong>. Scan the <span class="tier-badge ${ch.difficulty}">${tierLabels[ch.difficulty]}</span> QR card to reveal your challenge.</p><p class="scan-hint">Matches: ${tierPieces[ch.difficulty]}</p><div class="scan-notice-actions"><button class="button scan-btn" data-action="open-scanner" style="margin-top:14px">Use Camera to Scan</button><p class="scan-hint" style="margin-top:10px">Or scan the physical card with your phone camera</p></div></div></div>`; }
function resultModal() { const correctChoice = !answerResult.correct && answerResult.choices && answerResult.correctIndex != null ? answerResult.choices[answerResult.correctIndex] : null; return `<div class="new-game"><div class="modal challenge"><div class="eyebrow">Challenge result</div><h2>${answerResult.correct ? 'Extra move earned.' : 'Turn passed on.'}</h2><div class="result ${answerResult.correct ? 'good' : 'bad'}"><strong>${answerResult.correct ? '+10 mastery points' : 'Not quite.'}</strong><br/>${escape(answerResult.explanation)}${correctChoice ? `<div class="correct-answer">Correct answer: <strong>${escape(correctChoice)}</strong></div>` : ''}</div><div class="modal-actions"><button class="button" data-action="close-result">Continue</button></div></div></div>`; }
function leaveGameModal() { return `<div class="new-game"><div class="modal leave-modal"><div class="eyebrow" style="color:var(--coral)">Leave game</div><h2>Are you sure?</h2><div class="leave-warning"><span class="leave-warning-icon">⚠</span><span class="leave-warning-text">Leaving now will result in an <strong>automatic loss</strong>. Your opponent will be declared the winner.</span></div><div class="modal-actions"><button class="button ghost" data-action="close-modal">Cancel</button><button class="leave-confirm" data-action="confirm-leave">Leave Game</button></div></div></div>`; }
function forfeitModal() { return `<div class="new-game"><div class="modal challenge"><div class="eyebrow" style="color:#a7d39f">Victory</div><h2>Opponent Forfeited</h2><p style="font-size:14px;line-height:1.6;margin-top:8px">Your opponent has left the game. You win!</p>${gameEndStatsHtml()}<div class="modal-actions"><button class="button" data-action="back">Continue</button></div></div></div>`; }
function gameEndStatsHtml() { if (!game.gameStats || !game.gameStats.length) return ''; const myStats = game.gameStats.filter(s => s.user_id === user.id); const tiers = ['warmup', 'tactic', 'advanced']; const tierLabels = { warmup: 'Warmup', tactic: 'Tactic', advanced: 'Advanced' }; const rows = tiers.map(tier => { const row = myStats.find(s => s.difficulty === tier); const correct = row ? row.correct : 0; const attempted = row ? row.attempted : 0; return `<div class="stat-row"><span class="stat-tier">${tierLabels[tier]}</span><span class="stat-value">${correct} correct / ${attempted - correct} wrong</span></div>`; }).join(''); return `<div class="game-stats">${rows}</div>`; }
function gameEndModal() { if (game.status !== 'finished' || !game.gameStats) return ''; const iWon = game.winner_id === user.id; return `<div class="new-game"><div class="modal challenge"><div class="eyebrow" style="color:${iWon ? '#a7d39f' : 'var(--coral)'}">${iWon ? 'Victory' : 'Defeat'}</div><h2>${iWon ? 'You Won!' : 'You Lost!'}</h2><p style="font-size:14px;line-height:1.6;margin-top:8px">${gameForfeited ? 'Your opponent has forfeited.' : 'Checkmate. King captured.'}</p>${gameEndStatsHtml()}<div class="modal-actions"><button class="button" data-action="back">Continue</button></div></div></div>`; }
function render() { const hash = location.hash; if (!user) app.innerHTML = hash === '#login' ? authForm('login') : hash === '#register' ? authForm('register') : hash.startsWith('#scan=') ? authForm('login') : hero(); else if (hash.startsWith('#game=')) app.innerHTML = game ? gameView() : `${nav()}<main class="shell"><div class="empty">Loading board…</div></main>`; else if (hash.startsWith('#scan=')) app.innerHTML = `${nav()}<main class="shell"><div class="empty">Scanning…</div></main>`; else app.innerHTML = lobby();   if (profileOpen) {
    const existing = document.querySelector('.profile-overlay');
    if (!existing) app.insertAdjacentHTML('beforeend', userProfilePanel());
  }
  if (scanModalOpen) {
    const existing = document.querySelector('.scan-overlay');
    if (!existing) app.insertAdjacentHTML('beforeend', scanModal());
  } }

async function loadGames() { games = await api('/games'); render(); }
async function openGame(id) { if (openingGame) return; openingGame = true; try { game = await api(`/games/${id}/join`, { method: 'POST' }); location.hash = `#game=${id}`; connectSocket(); socket.emit('game:join', { gameId: id }); selected = null; qr = null; challengeQuestion = null; answerResult = null; gameForfeited = false; render(); try { qr = await api(`/games/${id}/qr`); render(); } catch {} } finally { openingGame = false; } }
function connectSocket() { if (socket?.connected) return; socket = io({ auth: { token } }); socket.on('game:state', async (nextGame) => { if (!game || nextGame.id !== game.id) return; game = nextGame; selected = null; if (ownsChallenge() && game.challenge?.isRevealed && !challengeQuestion && !answerResult) { try { challengeQuestion = await api(`/games/${game.id}/question`); } catch (error) { notice(error.message); } } if (!game.challenge) challengeQuestion = null; render(); }); socket.on('challenge:earned', (payload) => notice(`${labels[payload.capturedPiece]} captured — ${payload.reason}`)); socket.on('app:error', notice);
socket.on('game:left', (payload) => { gameForfeited = true; render(); notice(`${payload.username} has left the game. You win!`); });
socket.on('connect_error', () => notice('Live connection unavailable. Refresh to reconnect.')); }

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action], [data-square], [data-nav]'); if (!target) return;
  if (target.dataset.nav === 'lobby') { location.hash = ''; game = null; await loadGames(); return; }
  const action = target.dataset.action;
  if (action === 'show-login') { location.hash = '#login'; render(); }
  if (action === 'show-register') { location.hash = '#register'; render(); }
  if (action === 'logout') { localStorage.removeItem('pycheckmate_token'); localStorage.removeItem('pycheckmate_user'); token = null; user = null; socket?.disconnect(); game = null; location.hash = ''; render(); }
  if (action === 'new-game') { app.insertAdjacentHTML('beforeend', newGameModal()); }
  if (action === 'close-modal') $('.new-game')?.remove();
  if (action === 'join') { try { await openGame(target.dataset.id); } catch (error) { notice(error.message); } }
  if (action === 'back') { socket?.disconnect(); socket = null; game = null; location.hash = ''; await loadGames(); }
  if (action === 'leave-game') { app.insertAdjacentHTML('beforeend', leaveGameModal()); }
  if (action === 'confirm-leave') {
    try {
      await api(`/games/${game.id}/leave`, { method: 'POST' });
      game = null;
      location.hash = '';
      await loadGames();
    } catch (error) { notice(error.message); }
    return;
  }
  if (action === 'answer') { try { answerResult = await api(`/games/${game.id}/answer`, { method: 'POST', body: JSON.stringify({ questionId: challengeQuestion.id, selectedIndex: Number(target.dataset.index) }) }); challengeQuestion = null; render(); } catch (error) { notice(error.message); } }
  if (action === 'close-result') { answerResult = null; render(); }
  if (action === 'close-forfeit') { gameForfeited = false; render(); }
  if (action === 'open-profile') {
    profileOpen = true;
    profileStats = null;
    render();
    api('/users/me/stats').then((stats) => { profileStats = stats; const body = document.querySelector('.profile-panel-body'); if (body) { const temp = document.createElement('div'); temp.innerHTML = userProfilePanel(); const newBody = temp.querySelector('.profile-panel-body'); if (newBody) body.innerHTML = newBody.innerHTML; } else { render(); } }).catch(() => {});
    return;
  }
  if (action === 'close-profile') {
    const panel = document.querySelector('.profile-panel');
    if (panel) { panel.classList.add('sliding-out'); }
    setTimeout(() => { profileOpen = false; profileStats = null; render(); }, 260);
    return;
  }
  if (action === 'open-scanner') { openScanner(); }
  if (action === 'close-scanner') { closeScanner(); }
  if (target.dataset.square && game && isMyTurn()) { const square = target.dataset.square; const piece = boardPieces(game.fen)[Number('87654321'.indexOf(square[1])) * 8 + 'abcdefgh'.indexOf(square[0])]; const mine = myPlayer(); const own = piece && (mine.color === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase()); if (!selected && own) { selected = square; render(); } else if (selected) { if (selected === square) { selected = null; render(); } else { socket.emit('game:move', { gameId: game.id, from: selected, to: square }); selected = null; render(); } } }
});
document.addEventListener('input', (event) => {
  if (event.target.id !== 'room-search') return;
  const input = event.target;
  const cursor = input.selectionStart;
  roomSearch = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  render();
  const next = $('#room-search');
  if (next) {
    next.focus();
    const pos = Math.min(cursor, roomSearch.length);
    next.setSelectionRange(pos, pos);
  }
});

document.addEventListener('submit', async (event) => { event.preventDefault(); const form = event.target; try { if (form.id === 'auth-form') { const data = Object.fromEntries(new FormData(form)); const register = location.hash === '#register'; const result = await api(`/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(data) }); token = result.token; user = result.user; localStorage.setItem('pycheckmate_token', token); localStorage.setItem('pycheckmate_user', JSON.stringify(user)); const scanMatch = location.hash.match(/^#scan=(\w+)$/); if (scanMatch) { try { const scanResult = await api('/scan', { method: 'POST', body: JSON.stringify({ difficulty: scanMatch[1] }) }); notice('Challenge revealed! Check your board.'); location.hash = `#game=${scanResult.gameId}`; await openGame(scanResult.gameId); } catch (error) { notice(error.message); } return; } location.hash = ''; await loadGames(); } if (form.id === 'new-game-form') { const result = await api('/games', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); $('.new-game')?.remove(); await openGame(result.id); } if (form.id === 'room-search-form') { const code = (new FormData(form).get('roomCode') || roomSearch || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!code) { notice('Enter a room code to join.'); return; } roomSearch = code; try { await openGame(code); } catch (error) { notice(error.message || 'Game not found.'); render(); } } } catch (error) { notice(error.message); } });
window.addEventListener('hashchange', async () => { if (!user) return render(); const scanMatch = location.hash.match(/^#scan=(\w+)$/); if (scanMatch) { try { const result = await api('/scan', { method: 'POST', body: JSON.stringify({ difficulty: scanMatch[1] }) }); notice('Challenge revealed! Check your board.'); location.hash = `#game=${result.gameId}`; await openGame(result.gameId); } catch (error) { notice(error.message); location.hash = ''; } return; } const id = location.hash.match(/^#game=([A-Z0-9]+)$/)?.[1]; if (id && (!game || game.id !== id)) { try { await openGame(id); } catch (error) { notice(error.message); location.hash = ''; } } else if (!id) { game = null; await loadGames(); } });

(async () => { if (user) { try { user = await api('/auth/me'); localStorage.setItem('pycheckmate_user', JSON.stringify(user)); const scanMatch = location.hash.match(/^#scan=(\w+)$/); if (scanMatch) { try { const result = await api('/scan', { method: 'POST', body: JSON.stringify({ difficulty: scanMatch[1] }) }); notice('Challenge revealed! Check your board.'); location.hash = `#game=${result.gameId}`; await openGame(result.gameId); } catch (error) { notice(error.message); location.hash = ''; } return; } if (location.hash.startsWith('#game=')) await openGame(location.hash.split('=')[1]); else await loadGames(); } catch { localStorage.clear(); token = null; user = null; render(); } } else render(); })();
