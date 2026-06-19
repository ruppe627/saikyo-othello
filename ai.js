// Othello rules + AI engine
(function () {
const EMPTY = 0, BLACK = 1, WHITE = 2;
const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

const WEIGHTS = [
  120,-20, 20,  5,  5, 20,-20,120,
  -20,-40, -5, -5, -5, -5,-40,-20,
   20, -5, 15,  3,  3, 15, -5, 20,
    5, -5,  3,  3,  3,  3, -5,  5,
    5, -5,  3,  3,  3,  3, -5,  5,
   20, -5, 15,  3,  3, 15, -5, 20,
  -20,-40, -5, -5, -5, -5,-40,-20,
  120,-20, 20,  5,  5, 20,-20,120,
];

function createBoard() {
  const b = new Array(64).fill(EMPTY);
  b[3 * 8 + 3] = WHITE; b[3 * 8 + 4] = BLACK;
  b[4 * 8 + 3] = BLACK; b[4 * 8 + 4] = WHITE;
  return b;
}

function opponent(p) { return p === BLACK ? WHITE : BLACK; }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

function flipsForMove(board, idx, player) {
  const r0 = Math.floor(idx / 8), c0 = idx % 8;
  if (board[idx] !== EMPTY) return null;
  const opp = opponent(player);
  let allFlips = [];
  for (const [dr, dc] of DIRS) {
    let r = r0 + dr, c = c0 + dc;
    const line = [];
    while (inBounds(r, c) && board[r * 8 + c] === opp) {
      line.push(r * 8 + c);
      r += dr; c += dc;
    }
    if (line.length > 0 && inBounds(r, c) && board[r * 8 + c] === player) {
      allFlips = allFlips.concat(line);
    }
  }
  return allFlips.length > 0 ? allFlips : null;
}

function legalMoves(board, player) {
  const moves = new Map();
  for (let idx = 0; idx < 64; idx++) {
    const flips = flipsForMove(board, idx, player);
    if (flips) moves.set(idx, flips);
  }
  return moves;
}

function applyMove(board, idx, player, flips) {
  const next = board.slice();
  next[idx] = player;
  for (const f of flips) next[f] = player;
  return next;
}

function countDiscs(board) {
  let black = 0, white = 0;
  for (const v of board) { if (v === BLACK) black++; else if (v === WHITE) white++; }
  return { black, white };
}

function isGameOver(board) {
  return legalMoves(board, BLACK).size === 0 && legalMoves(board, WHITE).size === 0;
}

function emptyCount(board) {
  let n = 0;
  for (const v of board) if (v === EMPTY) n++;
  return n;
}

// Squares whose weight is only dangerous while the neighboring corner is
// still up for grabs. Once that corner is occupied (by either side) the
// square is no longer a trap, so its weight should be neutralized.
const CORNER_RISK = [
  { corner: 0,  neighbors: [1, 8, 9] },
  { corner: 7,  neighbors: [6, 14, 15] },
  { corner: 56, neighbors: [48, 57, 49] },
  { corner: 63, neighbors: [55, 62, 54] },
];

function positionalScore(board, player, opp) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    if (board[i] === player) score += WEIGHTS[i];
    else if (board[i] === opp) score -= WEIGHTS[i];
  }
  for (const { corner, neighbors } of CORNER_RISK) {
    if (board[corner] === EMPTY) continue;
    for (const n of neighbors) {
      if (board[n] === player) score -= WEIGHTS[n];
      else if (board[n] === opp) score += WEIGHTS[n];
    }
  }
  return score;
}

function evaluate(board, player) {
  const opp = opponent(player);
  const posScore = positionalScore(board, player, opp);

  const myMoves = legalMoves(board, player).size;
  const oppMoves = legalMoves(board, opp).size;
  const mobility = (myMoves + oppMoves === 0) ? 0 : 100 * (myMoves - oppMoves) / (myMoves + oppMoves + 1);
  if (myMoves === 0) return -9000 + posScore * 0.1; // about to be forced to pass is bad

  const { black, white } = countDiscs(board);
  const myDiscs = player === BLACK ? black : white;
  const oppDiscs = player === BLACK ? white : black;
  const discDiff = (myDiscs + oppDiscs === 0) ? 0 : 100 * (myDiscs - oppDiscs) / (myDiscs + oppDiscs);

  const empties = emptyCount(board);
  const phase = empties / 60; // 1 = opening, 0 = endgame
  return posScore * (0.6 + 0.4 * phase) + mobility * (3 * phase + 0.5) + discDiff * (1 - phase) * 1.5;
}

function boardKey(board, player) {
  return board.join('') + '_' + player;
}

function alphaBeta(board, player, rootPlayer, depth, alpha, beta, deadline, tt, ctx) {
  if (Date.now() > deadline) { ctx.timedOut = true; return evaluate(board, rootPlayer); }

  const moves = legalMoves(board, player);
  if (depth === 0 || (moves.size === 0 && legalMoves(board, opponent(player)).size === 0)) {
    return evaluate(board, rootPlayer);
  }

  if (moves.size === 0) {
    return alphaBeta(board, opponent(player), rootPlayer, depth - 1, alpha, beta, deadline, tt, ctx);
  }

  const key = boardKey(board, player) + '_' + depth;
  if (tt.has(key)) return tt.get(key);

  const entries = [...moves.entries()].sort((a, b) => WEIGHTS[b[0]] - WEIGHTS[a[0]]);
  let value;
  if (player === rootPlayer) {
    value = -Infinity;
    for (const [idx, flips] of entries) {
      const next = applyMove(board, idx, player, flips);
      const score = alphaBeta(next, opponent(player), rootPlayer, depth - 1, alpha, beta, deadline, tt, ctx);
      value = Math.max(value, score);
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
  } else {
    value = Infinity;
    for (const [idx, flips] of entries) {
      const next = applyMove(board, idx, player, flips);
      const score = alphaBeta(next, opponent(player), rootPlayer, depth - 1, alpha, beta, deadline, tt, ctx);
      value = Math.min(value, score);
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
  }
  tt.set(key, value);
  return value;
}

// Exact endgame solve (maximize disc difference) once few empties remain.
function solveExact(board, player, rootPlayer, deadline) {
  if (Date.now() > deadline) return null;
  const moves = legalMoves(board, player);
  const oppMoves = legalMoves(board, opponent(player));
  if (moves.size === 0 && oppMoves.size === 0) {
    const { black, white } = countDiscs(board);
    const diff = black - white;
    return rootPlayer === BLACK ? diff : -diff;
  }
  if (moves.size === 0) {
    return solveExact(board, opponent(player), rootPlayer, deadline);
  }
  let best = player === rootPlayer ? -Infinity : Infinity;
  for (const [idx, flips] of moves) {
    const next = applyMove(board, idx, player, flips);
    const v = solveExact(next, opponent(player), rootPlayer, deadline);
    if (v === null) return null;
    if (player === rootPlayer) best = Math.max(best, v);
    else best = Math.min(best, v);
  }
  return best;
}

// Scores every legal move at a single fixed depth. Used by easy/normal
// (shallow enough to always finish well inside the budget) and by advice mode.
function scoredMovesFixed(board, player, depth, timeBudgetMs, exactEmpties) {
  const moves = legalMoves(board, player);
  const deadline = Date.now() + timeBudgetMs;
  const tt = new Map();
  const ctx = { timedOut: false };
  const results = [];
  const useExact = emptyCount(board) <= exactEmpties;
  for (const [idx, flips] of moves) {
    const next = applyMove(board, idx, player, flips);
    let score;
    if (useExact) {
      score = solveExact(next, opponent(player), player, deadline);
      if (score === null) score = alphaBeta(next, opponent(player), player, Math.max(depth - 1, 2), -Infinity, Infinity, deadline, tt, ctx);
    } else {
      score = alphaBeta(next, opponent(player), player, depth - 1, -Infinity, Infinity, deadline, tt, ctx);
    }
    results.push({ idx, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// Iterative deepening: keeps re-running at increasing depth until the time
// budget runs out, discarding any depth that didn't finish (its scores would
// be an unfair mix of deep and cut-short branches). Returns the deepest
// fully-completed ranking, ordering each pass by the previous pass's best
// move first so alpha-beta prunes harder as depth grows.
function scoredMovesDeepening(board, player, timeBudgetMs, exactEmpties) {
  const deadline = Date.now() + timeBudgetMs;
  const moves = [...legalMoves(board, player).entries()];
  let order = moves.map(([idx]) => idx);
  let best = null;
  const useExact = emptyCount(board) <= exactEmpties;

  if (useExact) {
    const tt = new Map();
    const results = moves.map(([idx, flips]) => {
      const next = applyMove(board, idx, player, flips);
      let score = solveExact(next, opponent(player), player, deadline);
      if (score === null) score = evaluate(next, player);
      return { idx, score };
    });
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  for (let depth = 2; Date.now() < deadline; depth++) {
    const tt = new Map();
    const ctx = { timedOut: false };
    const results = [];
    const ordered = moves.slice().sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    for (const [idx, flips] of ordered) {
      if (Date.now() > deadline) { ctx.timedOut = true; break; }
      const next = applyMove(board, idx, player, flips);
      const score = alphaBeta(next, opponent(player), player, depth - 1, -Infinity, Infinity, deadline, tt, ctx);
      results.push({ idx, score });
    }
    if (ctx.timedOut || results.length < moves.length) break; // incomplete pass, keep previous best
    results.sort((a, b) => b.score - a.score);
    best = results;
    order = results.map(r => r.idx);
    if (depth >= 60) break;
  }
  return best || scoredMovesFixed(board, player, 2, timeBudgetMs, exactEmpties);
}

const DIFFICULTY_CONFIG = {
  easy:      { depth: 2, timeMs: 150, exactEmpties: 0 },
  normal:    { depth: 3, timeMs: 250, exactEmpties: 0 },
  hard:      { timeMs: 700,  exactEmpties: 10, deepening: true },
  strongest: { timeMs: 1600, exactEmpties: 14, deepening: true },
};

// How long advice mode is allowed to think before showing a recommendation.
// Longer budgets read deeper (closer to the strongest difficulty's strength);
// 'fast' trades some accuracy for an instant response.
const ADVICE_SPEED_CONFIG = {
  fast:    { timeMs: 300,   exactEmpties: 10 },
  '5000':  { timeMs: 5000,  exactEmpties: 18 },
  '10000': { timeMs: 10000, exactEmpties: 22 },
};

function chooseComputerMove(board, player, difficulty) {
  const moves = legalMoves(board, player);
  if (moves.size === 0) return null;
  if (moves.size === 1) return [...moves.keys()][0];
  const cfg = DIFFICULTY_CONFIG[difficulty] || DIFFICULTY_CONFIG.normal;
  const ranked = cfg.deepening
    ? scoredMovesDeepening(board, player, cfg.timeMs, cfg.exactEmpties)
    : scoredMovesFixed(board, player, cfg.depth, cfg.timeMs, cfg.exactEmpties);

  if (difficulty === 'easy') {
    // Intentionally pick from the worse half so the human side can win.
    const worstHalf = ranked.slice(Math.ceil(ranked.length / 2));
    const pool = worstHalf.length > 0 ? worstHalf : ranked;
    return pool[Math.floor(Math.random() * pool.length)].idx;
  }
  if (difficulty === 'normal') {
    // Mostly reasonable but occasionally imperfect.
    const top = ranked.slice(0, Math.max(2, Math.ceil(ranked.length / 2)));
    return top[Math.floor(Math.random() * top.length)].idx;
  }
  return ranked[0].idx; // hard / strongest: always best found
}

// Advice ranking for the human player: returns array of {idx, rank, tier}
// tier: 'best' | 'good' | 'normal' | 'bad'
function adviseMoves(board, player, speed) {
  const moves = legalMoves(board, player);
  if (moves.size <= 1) {
    return [...moves.keys()].map(idx => ({ idx, rank: 1, tier: 'best' }));
  }
  const cfg = ADVICE_SPEED_CONFIG[speed] || ADVICE_SPEED_CONFIG['5000'];
  const ranked = scoredMovesDeepening(board, player, cfg.timeMs, cfg.exactEmpties);
  const n = ranked.length;
  return ranked.map((m, i) => {
    let tier;
    if (i === 0) tier = 'best';
    else if (i < Math.ceil(n * 0.4)) tier = 'good';
    else if (i < Math.ceil(n * 0.75)) tier = 'normal';
    else tier = 'bad';
    return { idx: m.idx, rank: i + 1, tier };
  });
}

window.Othello = {
  EMPTY, BLACK, WHITE,
  createBoard, opponent, legalMoves, applyMove, countDiscs,
  isGameOver, chooseComputerMove, adviseMoves,
};
})();
