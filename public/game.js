// ── Connection ────────────────────────────────────────────────────────────────

let ws = null;
let myId = null;
let myUsername = '';
let lobbyCode = null;
let isHost = false;
let gameState = null;
let selectedCardId = null;     // card selected from hand
let selectedPile = null;       // pile selected for stack-move
let cardStyle = 'classic';
let currentBg = 'bg-felt-green';

function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = location.pathname.replace(/\/[^\/]*$/, '');
  ws = new WebSocket(`${proto}//${location.host}${basePath}`);
  ws.onopen = onOpen;
  ws.onmessage = e => handleMessage(JSON.parse(e.data));
  ws.onclose = () => showToast('Disconnected — reload to reconnect', 'error');
}

// ── Screens ───────────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Lobby actions ─────────────────────────────────────────────────────────────

function getUsername() {
  const v = document.getElementById('username-input').value.trim();
  return v || 'Player' + Math.floor(Math.random() * 999);
}

function createLobby() {
  myUsername = getUsername();
  connect(() => ws.send(JSON.stringify({ type: 'createLobby', username: myUsername })));
}

function joinLobby() {
  const code = document.getElementById('code-input').value.trim();
  if (code.length !== 4) { showToast('Enter a 4-digit code', 'error'); return; }
  myUsername = getUsername();
  connect(() => ws.send(JSON.stringify({ type: 'joinLobby', code, username: myUsername })));
}

function copyCode() {
  navigator.clipboard.writeText(lobbyCode).then(() => showToast('Code copied!', 'success'));
}

function startGame() {
  ws.send(JSON.stringify({ type: 'startGame' }));
}

function playAgain() {
  ws.send(JSON.stringify({ type: 'playAgain' }));
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(msg) {
  if (msg.type === 'error') { showToast(msg.message, 'error'); return; }

  if (msg.type === 'lobbyJoined') {
    myId = msg.playerId;
    lobbyCode = msg.code;
    isHost = msg.isHost;
    myUsername = msg.username;
    document.getElementById('lobby-code-display').textContent = lobbyCode;
    document.getElementById('lobby-code-badge').textContent = lobbyCode;
    showScreen('screen-waiting');
    return;
  }

  if (msg.type === 'lobbyUpdate') {
    const list = document.getElementById('player-list');
    list.innerHTML = msg.players.map(p => `
      <div class="player-item">
        <span>${p.username}</span>
        ${p.isHost ? '<span class="host-badge">HOST</span>' : ''}
        ${p.id === myId ? '<span style="color:#888;font-size:.8rem">(you)</span>' : ''}
      </div>`).join('');

    const startBtn = document.getElementById('start-btn');
    const waitingMsg = document.getElementById('waiting-msg');
    if (isHost && msg.players.length >= 2) {
      startBtn.classList.remove('hidden');
      waitingMsg.classList.add('hidden');
    } else if (isHost) {
      startBtn.classList.add('hidden');
      waitingMsg.textContent = 'Need at least 2 players…';
      waitingMsg.classList.remove('hidden');
    }
    if (msg.message) showToast(msg.message);
    return;
  }

  if (msg.type === 'gameStarted') {
    showScreen('screen-game');
    selectedCardId = null;
    selectedPile = null;
    return;
  }

  if (msg.type === 'gameState') {
    gameState = msg;
    renderGame();
    return;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function makeCardEl(card, clickable = false, isSelected = false) {
  const isRed = card.suit === '♥' || card.suit === '♦';
  const div = document.createElement('div');
  div.className = `card ${isRed ? 'red' : 'black'}${isSelected ? ' selected' : ''}`;
  div.dataset.cardId = card.id;
  div.innerHTML = `<span class="rank">${card.rank}</span><span class="suit-center">${card.suit}</span><span class="rank-br">${card.rank}</span>`;
  return div;
}

function renderGame() {
  if (!gameState) return;
  const gs = gameState;
  const myTurn = gs.currentPlayerId === myId;
  const winnerPlayer = gs.winner ? gs.players.find(p => p.id === gs.winner) : null;

  // ── Win state ──
  if (gs.winner) {
    renderWinScreen(winnerPlayer, gs);
    showScreen('screen-win');
    return;
  }

  showScreen('screen-game');

  // Turn indicator
  const currentPlayer = gs.players.find(p => p.id === gs.currentPlayerId);
  document.getElementById('turn-indicator').textContent =
    myTurn ? '▶ Your turn' : `${currentPlayer ? currentPlayer.username : '?'}'s turn`;

  // ── Deck ──
  const deckCount = document.getElementById('deck-count');
  deckCount.textContent = gs.deckCount;
  const drawPile = document.getElementById('draw-pile');
  drawPile.classList.toggle('must-draw', myTurn && !gs.drawnThisTurn);

  // ── Board piles ──
  const allPiles = { ...gs.foundations, ...gs.corners };
  for (const [pos, pile] of Object.entries(allPiles)) {
    const el = document.getElementById(`pile-content-${pos}`);
    el.innerHTML = '';
    if (pile.length > 0) {
      const topCard = pile[pile.length - 1];
      const cardEl = makeCardEl(topCard);
      cardEl.classList.add('board-card');
      el.appendChild(cardEl);
      if (pile.length > 1) {
        const cnt = document.createElement('span');
        cnt.className = 'stack-count';
        cnt.textContent = `×${pile.length}`;
        cardEl.appendChild(cnt);
      }
    } else {
      el.innerHTML = `<span class="pile-empty-text">Empty</span>`;
    }

    // Highlight valid targets if a card is selected
    const slot = document.getElementById(`pile-${pos}`);
    slot.classList.remove('highlight', 'valid-target');
    if (myTurn && gs.drawnThisTurn) {
      if (selectedCardId) {
        if (isValidCardTarget(selectedCardId, pos, gs)) slot.classList.add('valid-target');
      } else if (selectedPile) {
        if (isValidStackTarget(selectedPile, pos, gs)) slot.classList.add('valid-target');
        if (pos === selectedPile) slot.classList.add('highlight');
      }
    }
  }

  // ── Opponents ──
  const oppsArea = document.getElementById('opponents-area');
  oppsArea.innerHTML = '';
  gs.players.forEach(p => {
    if (p.id === myId) return;
    const handCount = typeof gs.hands[p.id] === 'number' ? gs.hands[p.id] : gs.hands[p.id].length;
    const isActive = gs.currentPlayerId === p.id;
    const div = document.createElement('div');
    div.className = `opponent${isActive ? ' active-player' : ''}`;
    const minis = Array.from({ length: Math.min(handCount, 10) }, () => `<div class="card-back-mini"></div>`).join('');
    div.innerHTML = `<span class="opponent-name">${p.username}</span><div class="opponent-cards">${minis}</div><span style="color:#aaa;font-size:.75rem">(${handCount})</span>`;
    oppsArea.appendChild(div);
  });

  // ── My hand ──
  const myHand = document.getElementById('my-hand');
  myHand.innerHTML = '';
  const myCards = Array.isArray(gs.hands[myId]) ? gs.hands[myId] : [];
  myCards.forEach(card => {
    const cardEl = makeCardEl(card, true, card.id === selectedCardId);
    if (myTurn) {
      cardEl.onclick = () => handleCardClick(card.id);
    }
    myHand.appendChild(cardEl);
  });

  document.getElementById('my-hand-label').textContent = `Your Hand (${myCards.length})`;

  const endBtn = document.getElementById('end-turn-btn');
  if (myTurn && gs.drawnThisTurn) {
    endBtn.classList.remove('hidden');
  } else {
    endBtn.classList.add('hidden');
  }

  // ── Log ──
  const logEl = document.getElementById('game-log');
  logEl.innerHTML = (gs.log || []).map(l => `<div class="log-entry">${l}</div>`).join('');

  // If first round, show hint
  if (gs.isFirstRound && myTurn && gs.drawnThisTurn && gs.cardsPlayedThisTurn >= 1) {
    showToast('Only 1 card per turn in round 1', 'error');
  }
}

function renderWinScreen(winner, gs) {
  document.getElementById('win-message').textContent =
    winner.id === myId ? 'You win! 🎉' : `${winner.username} wins!`;

  // Leaderboard
  const lb = gs.leaderboard || {};
  const entries = gs.players
    .map(p => ({ username: p.username, id: p.id, wins: lb[p.id] || 0 }))
    .sort((a, b) => b.wins - a.wins);
  const medals = ['🥇', '🥈', '🥉'];
  const lbEl = document.getElementById('leaderboard');
  lbEl.innerHTML = `<div class="leaderboard-title">Leaderboard</div>` +
    entries.map((e, i) => `
      <div class="lb-row rank-${i + 1}">
        <span class="lb-rank">${medals[i] || (i + 1)}</span>
        <span class="lb-name">${e.username}${e.id === myId ? ' (you)' : ''}</span>
        <span class="lb-wins">${e.wins} W</span>
      </div>`).join('');

  const playAgainBtn = document.getElementById('play-again-btn');
  const waitingMsg = document.getElementById('win-waiting-msg');
  if (isHost) {
    playAgainBtn.classList.remove('hidden');
    waitingMsg.classList.add('hidden');
  } else {
    playAgainBtn.classList.add('hidden');
    waitingMsg.classList.remove('hidden');
  }
}

// ── Interaction ───────────────────────────────────────────────────────────────

function handleCardClick(cardId) {
  if (!gameState || gameState.currentPlayerId !== myId) return;
  if (!gameState.drawnThisTurn) {
    // Penalty path — inform via toast; server will penalize on next action
    showToast('Draw a card first!', 'error');
    return;
  }
  if (gameState.isFirstRound && gameState.cardsPlayedThisTurn >= 1) {
    showToast('Only 1 card in round 1', 'error');
    return;
  }
  selectedPile = null;
  if (selectedCardId === cardId) {
    selectedCardId = null;
  } else {
    selectedCardId = cardId;
  }
  renderGame();
}

function handlePileClick(pile) {
  if (!gameState || gameState.currentPlayerId !== myId) return;

  if (!gameState.drawnThisTurn) {
    // Penalty: trying to play without drawing
    ws.send(JSON.stringify({ type: 'playCard', cardId: '__fake__', target: pile }));
    return;
  }

  // Case 1: have a card selected from hand → play it
  if (selectedCardId) {
    ws.send(JSON.stringify({ type: 'playCard', cardId: selectedCardId, target: pile }));
    selectedCardId = null;
    renderGame();
    return;
  }

  // Case 2: have a pile selected → move stack
  if (selectedPile) {
    if (selectedPile === pile) {
      selectedPile = null;
    } else {
      ws.send(JSON.stringify({ type: 'moveStack', from: selectedPile, to: pile }));
      selectedPile = null;
    }
    renderGame();
    return;
  }

  // Case 3: select this pile for stack move (if it has cards and it's not first round)
  const allPiles = { ...gameState.foundations, ...gameState.corners };
  const pileData = allPiles[pile];
  if (pileData && pileData.length > 0 && !gameState.isFirstRound) {
    selectedPile = pile;
    renderGame();
  }
}

function handleDraw() {
  if (!gameState || gameState.currentPlayerId !== myId) return;
  selectedCardId = null;
  selectedPile = null;
  ws.send(JSON.stringify({ type: 'draw' }));
}

function endTurn() {
  if (!gameState || gameState.currentPlayerId !== myId) return;
  selectedCardId = null;
  selectedPile = null;
  ws.send(JSON.stringify({ type: 'endTurn' }));
}

// ── Validity helpers (client-side preview only) ───────────────────────────────

function isValidCardTarget(cardId, pile, gs) {
  const myCards = Array.isArray(gs.hands[myId]) ? gs.hands[myId] : [];
  const card = myCards.find(c => c.id === cardId);
  if (!card) return false;

  const allPiles = { ...gs.foundations, ...gs.corners };
  const pileCards = allPiles[pile];
  const isCorner = ['NE', 'NW', 'SE', 'SW'].includes(pile);

  if (isCorner) {
    return card.rank === 'K' && pileCards.length === 0;
  } else {
    if (pileCards.length === 0) return false;
    const topCard = pileCards[pileCards.length - 1];
    return rankValue(card.rank) === rankValue(topCard.rank) - 1 &&
      isRed(card.suit) !== isRed(topCard.suit);
  }
}

function isValidStackTarget(fromPile, toPile, gs) {
  if (fromPile === toPile) return false;
  const allPiles = { ...gs.foundations, ...gs.corners };
  const src = allPiles[fromPile];
  const dst = allPiles[toPile];
  if (!src || src.length === 0) return false;

  const srcBottom = src[0];
  const isCornerDst = ['NE', 'NW', 'SE', 'SW'].includes(toPile);

  if (isCornerDst) {
    return srcBottom.rank === 'K' && dst.length === 0;
  }
  if (dst.length === 0) return false;
  const dstTop = dst[dst.length - 1];
  return rankValue(srcBottom.rank) === rankValue(dstTop.rank) - 1 &&
    isRed(srcBottom.suit) !== isRed(dstTop.suit);
}

function rankValue(r) {
  return ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].indexOf(r);
}
function isRed(suit) { return suit === '♥' || suit === '♦'; }

// ── Settings ──────────────────────────────────────────────────────────────────

function toggleSettings() {
  document.getElementById('settings-panel').classList.toggle('hidden');
}

function setCardStyle(style) {
  document.querySelectorAll('.style-btn[data-style]').forEach(b => b.classList.remove('active'));
  document.querySelector(`.style-btn[data-style="${style}"]`)?.classList.add('active');
  document.body.classList.remove('card-minimal', 'card-large');
  if (style === 'minimal') document.body.classList.add('card-minimal');
  if (style === 'large') document.body.classList.add('card-large');
  cardStyle = style;
}

function setBg(bg) {
  document.querySelectorAll('.style-btn[data-bg]').forEach(b => b.classList.remove('active'));
  document.querySelector(`.style-btn[data-bg="${bg}"]`)?.classList.add('active');
  document.body.classList.remove('bg-felt-green', 'bg-felt-blue', 'bg-wood', 'bg-dark');
  document.body.classList.add(bg);
  currentBg = bg;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${type ? ' ' + type : ''}`;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

// ── Enter key shortcuts ───────────────────────────────────────────────────────

document.getElementById('code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinLobby();
});
document.getElementById('username-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('code-input').focus();
});
