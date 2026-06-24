const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// lobbies[code] = { players, gameState, leaderboard }
const lobbies = {};

function generateLobbyCode() {
  let code;
  do { code = Math.floor(1000 + Math.random() * 9000).toString(); }
  while (lobbies[code]);
  return code;
}

// ── Card engine ───────────────────────────────────────────────────────────────

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function rankValue(r) { return RANKS.indexOf(r); }
function isRed(suit) { return suit === '♥' || suit === '♦'; }

function newDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank, id: `${rank}${suit}` });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function canPlace(card, topCard) {
  // card goes ON topCard: must be one rank lower and opposite color
  if (!topCard) return false;
  return rankValue(card.rank) === rankValue(topCard.rank) - 1 &&
    isRed(card.suit) !== isRed(topCard.suit);
}

function initGame(lobby) {
  const deck = shuffle(newDeck());
  const playerIds = lobby.players.map(p => p.id);
  const hands = {};
  playerIds.forEach(id => { hands[id] = []; });

  // Deal 7 cards per player
  for (let i = 0; i < 7; i++)
    playerIds.forEach(id => hands[id].push(deck.pop()));

  // 4 foundation piles (N/S/E/W), 4 corner piles (NE/NW/SE/SW)
  const foundations = { N: [], S: [], E: [], W: [] };
  const corners = { NE: [], NW: [], SE: [], SW: [] };

  // Deal one face-up card to each foundation
  for (const pos of Object.keys(foundations))
    foundations[pos].push(deck.pop());

  lobby.gameState = {
    deck,
    hands,
    foundations,
    corners,
    currentPlayerIdx: 0,
    playerOrder: playerIds,
    drawnThisTurn: false,
    cardsPlayedThisTurn: 0,
    isFirstRound: true,
    roundNumber: 1,
    winner: null,
    log: [],
    phase: 'playing'
  };
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastLobby(lobbyCode, msg) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;
  lobby.players.forEach(p => { if (p.ws) sendTo(p.ws, msg); });
}

function lobbySnapshot(lobbyCode, forPlayerId) {
  const lobby = lobbies[lobbyCode];
  const gs = lobby.gameState;
  if (!gs) return null;

  // Send each player only their own hand; others get counts
  const handsView = {};
  gs.playerOrder.forEach(id => {
    handsView[id] = id === forPlayerId ? gs.hands[id] : gs.hands[id].length;
  });

  return {
    type: 'gameState',
    foundations: gs.foundations,
    corners: gs.corners,
    deckCount: gs.deck.length,
    hands: handsView,
    currentPlayerId: gs.playerOrder[gs.currentPlayerIdx],
    drawnThisTurn: gs.drawnThisTurn,
    cardsPlayedThisTurn: gs.cardsPlayedThisTurn,
    isFirstRound: gs.isFirstRound,
    winner: gs.winner,
    log: gs.log.slice(-8),
    players: lobby.players.map(p => ({ id: p.id, username: p.username })),
    leaderboard: lobby.leaderboard
  };
}

function broadcastGameState(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;
  lobby.players.forEach(p => {
    if (p.ws) sendTo(p.ws, lobbySnapshot(lobbyCode, p.id));
  });
}

function addLog(lobby, msg) {
  lobby.gameState.log.push(msg);
}

// ── Turn logic ────────────────────────────────────────────────────────────────

function nextTurn(lobby) {
  const gs = lobby.gameState;
  gs.drawnThisTurn = false;
  gs.cardsPlayedThisTurn = 0;
  gs.currentPlayerIdx = (gs.currentPlayerIdx + 1) % gs.playerOrder.length;

  // Check if we've completed a round
  if (gs.currentPlayerIdx === 0) {
    gs.isFirstRound = false;
    gs.roundNumber++;
  }
}

function checkWin(lobby) {
  const gs = lobby.gameState;
  for (const id of gs.playerOrder) {
    if (gs.hands[id].length === 0) {
      gs.winner = id;
      gs.phase = 'ended';
      const player = lobby.players.find(p => p.id === id);
      // Update leaderboard
      lobby.leaderboard[id] = (lobby.leaderboard[id] || 0) + 1;
      addLog(lobby, `🏆 ${player.username} wins!`);
      return true;
    }
  }
  return false;
}

// ── Action handlers ───────────────────────────────────────────────────────────

function handleDraw(lobby, playerId) {
  const gs = lobby.gameState;
  const player = lobby.players.find(p => p.id === playerId);

  if (gs.phase !== 'playing') return { error: 'Game not active' };
  if (gs.playerOrder[gs.currentPlayerIdx] !== playerId) return { error: 'Not your turn' };
  if (gs.drawnThisTurn) return { error: 'Already drawn' };

  if (gs.deck.length === 0) {
    // Reshuffle played cards into deck (keep top card of each pile)
    addLog(lobby, 'Deck reshuffled');
    const recycled = [];
    for (const pile of [...Object.values(gs.foundations), ...Object.values(gs.corners)]) {
      while (pile.length > 1) recycled.push(pile.shift());
    }
    shuffle(recycled).forEach(c => gs.deck.push(c));
  }

  if (gs.deck.length > 0) {
    const card = gs.deck.pop();
    gs.hands[playerId].push(card);
    gs.drawnThisTurn = true;
    addLog(lobby, `${player.username} drew a card`);
  } else {
    gs.drawnThisTurn = true; // force allow play even with empty deck
    addLog(lobby, `${player.username} drew (deck empty)`);
  }
  return { ok: true };
}

function handlePlayCard(lobby, playerId, cardId, target) {
  const gs = lobby.gameState;
  const player = lobby.players.find(p => p.id === playerId);

  if (gs.phase !== 'playing') return { error: 'Game not active' };
  if (gs.playerOrder[gs.currentPlayerIdx] !== playerId) return { error: 'Not your turn' };

  if (!gs.drawnThisTurn) {
    // Penalty: pick up 2, skip turn
    const picked = [];
    for (let i = 0; i < 2 && gs.deck.length > 0; i++) picked.push(gs.deck.pop());
    gs.hands[playerId].push(...picked);
    addLog(lobby, `⚠️ ${player.username} played without drawing — picked up ${picked.length} cards, turn skipped`);
    nextTurn(lobby);
    return { ok: true, penalized: true };
  }

  if (gs.isFirstRound && gs.cardsPlayedThisTurn >= 1) {
    return { error: 'Only one card can be played in the first round' };
  }

  // Find card in hand
  const cardIdx = gs.hands[playerId].findIndex(c => c.id === cardId);
  if (cardIdx === -1) return { error: 'Card not in hand' };
  const card = gs.hands[playerId][cardIdx];

  // Validate target
  const allPiles = { ...gs.foundations, ...gs.corners };
  const pile = allPiles[target];
  if (pile === undefined) return { error: 'Invalid target' };

  const isCorner = ['NE', 'NW', 'SE', 'SW'].includes(target);

  if (isCorner) {
    if (card.rank !== 'K') return { error: 'Only Kings go in corners' };
    if (pile.length > 0) return { error: 'Corner already occupied' };
  } else {
    if (pile.length === 0) {
      return { error: 'Cannot start a foundation pile — move a stack here instead' };
    }
    const topCard = pile[pile.length - 1];
    if (!canPlace(card, topCard)) return { error: `Cannot place ${card.rank}${card.suit} on ${topCard.rank}${topCard.suit}` };
  }

  // Move card
  gs.hands[playerId].splice(cardIdx, 1);
  if (isCorner) gs.corners[target].push(card);
  else gs.foundations[target].push(card);

  gs.cardsPlayedThisTurn++;
  addLog(lobby, `${player.username} played ${card.rank}${card.suit} → ${target}`);

  if (checkWin(lobby)) return { ok: true };
  return { ok: true };
}

function handleMoveStack(lobby, playerId, fromPile, toPile) {
  const gs = lobby.gameState;
  const player = lobby.players.find(p => p.id === playerId);

  if (gs.phase !== 'playing') return { error: 'Game not active' };
  if (gs.playerOrder[gs.currentPlayerIdx] !== playerId) return { error: 'Not your turn' };
  if (!gs.drawnThisTurn) return { error: 'Draw a card first' };
  if (gs.isFirstRound) return { error: 'Cannot move stacks in first round' };

  const allPiles = { ...gs.foundations, ...gs.corners };
  const src = allPiles[fromPile];
  const dst = allPiles[toPile];
  if (!src || !dst) return { error: 'Invalid pile' };
  if (src.length === 0) return { error: 'Source pile empty' };

  const srcBottom = src[0];
  const dstTop = dst[dst.length - 1];

  const isCornerDst = ['NE', 'NW', 'SE', 'SW'].includes(toPile);

  if (isCornerDst) {
    if (srcBottom.rank !== 'K') return { error: 'Only King-led stacks go in corners' };
    if (dst.length > 0) return { error: 'Corner already occupied' };
  } else {
    if (dst.length === 0) return { error: 'Cannot move stack to empty foundation' };
    if (!canPlace(srcBottom, dstTop)) return { error: 'Stack does not fit' };
  }

  // Move entire stack
  const moved = src.splice(0);
  dst.push(...moved);
  gs.cardsPlayedThisTurn++;
  addLog(lobby, `${player.username} moved ${fromPile} stack → ${toPile}`);
  return { ok: true };
}

function handleEndTurn(lobby, playerId) {
  const gs = lobby.gameState;
  if (gs.playerOrder[gs.currentPlayerIdx] !== playerId) return { error: 'Not your turn' };
  if (!gs.drawnThisTurn) return { error: 'Draw a card first' };
  const player = lobby.players.find(p => p.id === playerId);
  addLog(lobby, `${player.username} ended turn`);
  nextTurn(lobby);
  return { ok: true };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  let playerId = uuidv4();
  let lobbyCode = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'createLobby') {
      lobbyCode = generateLobbyCode();
      lobbies[lobbyCode] = {
        players: [],
        gameState: null,
        leaderboard: {}
      };
      const username = (msg.username || 'Player').slice(0, 20);
      lobbies[lobbyCode].players.push({ id: playerId, username, ws, isHost: true });
      sendTo(ws, { type: 'lobbyJoined', code: lobbyCode, playerId, isHost: true, username });
      broadcastLobby(lobbyCode, {
        type: 'lobbyUpdate',
        players: lobbies[lobbyCode].players.map(p => ({ id: p.id, username: p.username, isHost: p.isHost })),
        code: lobbyCode
      });
      return;
    }

    if (msg.type === 'joinLobby') {
      const code = (msg.code || '').toString().trim();
      if (!lobbies[code]) { sendTo(ws, { type: 'error', message: 'Lobby not found' }); return; }
      if (lobbies[code].players.length >= 6) { sendTo(ws, { type: 'error', message: 'Lobby full (max 6)' }); return; }
      if (lobbies[code].gameState && lobbies[code].gameState.phase === 'playing') {
        sendTo(ws, { type: 'error', message: 'Game already in progress' }); return;
      }
      lobbyCode = code;
      const username = (msg.username || 'Player').slice(0, 20);
      lobbies[lobbyCode].players.push({ id: playerId, username, ws, isHost: false });
      // Inherit leaderboard entry
      lobbies[lobbyCode].leaderboard[playerId] = lobbies[lobbyCode].leaderboard[playerId] || 0;
      sendTo(ws, { type: 'lobbyJoined', code: lobbyCode, playerId, isHost: false, username });
      broadcastLobby(lobbyCode, {
        type: 'lobbyUpdate',
        players: lobbies[lobbyCode].players.map(p => ({ id: p.id, username: p.username, isHost: p.isHost })),
        code: lobbyCode
      });
      return;
    }

    if (msg.type === 'startGame') {
      if (!lobbyCode || !lobbies[lobbyCode]) return;
      const lobby = lobbies[lobbyCode];
      const host = lobby.players.find(p => p.isHost);
      if (!host || host.id !== playerId) { sendTo(ws, { type: 'error', message: 'Only host can start' }); return; }
      if (lobby.players.length < 2) { sendTo(ws, { type: 'error', message: 'Need at least 2 players' }); return; }
      initGame(lobby);
      lobby.leaderboard = {};
      lobby.players.forEach(p => { lobby.leaderboard[p.id] = 0; });
      broadcastLobby(lobbyCode, { type: 'gameStarted' });
      broadcastGameState(lobbyCode);
      return;
    }

    if (msg.type === 'playAgain') {
      if (!lobbyCode || !lobbies[lobbyCode]) return;
      const lobby = lobbies[lobbyCode];
      const host = lobby.players.find(p => p.isHost);
      if (!host || host.id !== playerId) { sendTo(ws, { type: 'error', message: 'Only host can restart' }); return; }
      const lb = { ...lobby.leaderboard };
      initGame(lobby);
      lobby.leaderboard = lb;
      broadcastLobby(lobbyCode, { type: 'gameStarted' });
      broadcastGameState(lobbyCode);
      return;
    }

    if (!lobbyCode || !lobbies[lobbyCode]) return;
    const lobby = lobbies[lobbyCode];
    if (!lobby.gameState) return;

    let result;
    if (msg.type === 'draw') result = handleDraw(lobby, playerId);
    else if (msg.type === 'playCard') result = handlePlayCard(lobby, playerId, msg.cardId, msg.target);
    else if (msg.type === 'moveStack') result = handleMoveStack(lobby, playerId, msg.from, msg.to);
    else if (msg.type === 'endTurn') result = handleEndTurn(lobby, playerId);
    else return;

    if (result && result.error) { sendTo(ws, { type: 'error', message: result.error }); return; }
    broadcastGameState(lobbyCode);
  });

  ws.on('close', () => {
    if (!lobbyCode || !lobbies[lobbyCode]) return;
    const lobby = lobbies[lobbyCode];
    const idx = lobby.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;
    const wasHost = lobby.players[idx].isHost;
    const username = lobby.players[idx].username;
    lobby.players.splice(idx, 1);

    if (lobby.players.length === 0) { delete lobbies[lobbyCode]; return; }

    if (wasHost && lobby.players.length > 0) lobby.players[0].isHost = true;

    broadcastLobby(lobbyCode, {
      type: 'lobbyUpdate',
      players: lobby.players.map(p => ({ id: p.id, username: p.username, isHost: p.isHost })),
      code: lobbyCode,
      message: `${username} left`
    });

    if (lobby.gameState && lobby.gameState.phase === 'playing') {
      // Remove from turn order
      const ti = lobby.gameState.playerOrder.indexOf(playerId);
      if (ti !== -1) {
        lobby.gameState.playerOrder.splice(ti, 1);
        delete lobby.gameState.hands[playerId];
        if (lobby.gameState.currentPlayerIdx >= lobby.gameState.playerOrder.length)
          lobby.gameState.currentPlayerIdx = 0;
        addLog(lobby, `${username} disconnected`);
        if (lobby.gameState.playerOrder.length === 1) {
          const lastId = lobby.gameState.playerOrder[0];
          lobby.gameState.winner = lastId;
          lobby.gameState.phase = 'ended';
          lobby.leaderboard[lastId] = (lobby.leaderboard[lastId] || 0) + 1;
          const lastPlayer = lobby.players.find(p => p.id === lastId);
          addLog(lobby, `🏆 ${lastPlayer ? lastPlayer.username : 'Last player'} wins by default!`);
        }
        broadcastGameState(lobbyCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Kings Corner server running on port ${PORT}`));
