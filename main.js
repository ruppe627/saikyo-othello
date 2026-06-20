const { BLACK, WHITE, createBoard, opponent, legalMoves, applyMove, countDiscs,
        isGameOver, chooseComputerMove, adviseMoves } = window.Othello;

// Advice mode can think for up to 10 seconds. Running it in a Worker keeps
// that heavy search off the main thread so the board stays clickable the
// whole time instead of freezing until advice is ready. If the worker ever
// fails to respond (load error, environment that blocks workers, etc.) we
// fall back to computing on the main thread so advice still shows up.
const adviceWorker = new Worker('advice-worker.js');
let adviceToken = 0;
let currentAdviceMap = new Map(); // tier lookup for the move the human is about to play

// Requests are kept by token even after a newer turn starts, so that if the
// human moves before advice for their turn finished computing, the tally can
// still be credited once the (now "stale" for display purposes) result
// arrives — otherwise fast players would never get a tally entry at all.
const pendingAdviceRequests = new Map(); // token -> { fallback() }
let awaitingTally = null; // { token, idx } for a move played before its advice was ready

function handleAdviceResult(token, advice) {
  const req = pendingAdviceRequests.get(token);
  if (!req) return;
  pendingAdviceRequests.delete(token);

  if (token === adviceToken) {
    currentAdviceMap = new Map(advice.map(a => [a.idx, a]));
    paintCells(legalMoves(state.board, state.current), currentAdviceMap);
  }

  if (awaitingTally && awaitingTally.token === token) {
    const played = advice.find(a => a.idx === awaitingTally.idx);
    if (played) {
      state.moveTally[played.tier]++;
      renderTally();
    }
    awaitingTally = null;
  }
}

adviceWorker.onmessage = (event) => {
  handleAdviceResult(event.data.token, event.data.advice);
};

adviceWorker.onerror = () => {
  for (const [token, req] of pendingAdviceRequests) req.fallback();
};

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const blackScoreEl = document.getElementById('blackScore');
const whiteScoreEl = document.getElementById('whiteScore');
const legendEl = document.getElementById('legend');
const difficultyRow = document.getElementById('difficultyRow');
const colorRow = document.getElementById('colorRow');
const adviceSpeedRow = document.getElementById('adviceSpeedRow');
const statsPanel = document.getElementById('statsPanel');
const settingsPanel = document.getElementById('settingsPanel');
const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const gameAreaEl = document.getElementById('gameArea');

const SETTINGS_KEY = 'saikyo-othello-settings';
const DIFFICULTIES = ['weakest', 'easy', 'normal', 'hard', 'strongest'];

function emptyStats() {
  const stats = {};
  for (const d of DIFFICULTIES) stats[d] = { win: 0, lose: 0, draw: 0 };
  return stats;
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      mode: state.mode,
      difficulty: state.difficulty,
      humanColor: state.humanColor,
      adviceOn: state.adviceOn,
      adviceSpeed: state.adviceSpeed,
      stats: state.stats,
    }));
  } catch (e) {
    // ignore (e.g. private browsing without storage access)
  }
}

const saved = loadSettings();

let state = {
  board: createBoard(),
  current: BLACK,
  mode: saved.mode || 'cpu',       // 'cpu' | 'pvp'
  difficulty: saved.difficulty || 'normal',
  humanColor: saved.humanColor || BLACK, // which color the human plays in 'cpu' mode
  adviceOn: !!saved.adviceOn,
  adviceSpeed: saved.adviceSpeed || '5000',
  stats: Object.assign(emptyStats(), saved.stats),
  moveTally: { best: 0, good: 0, normal: 0, bad: 0 },
  gameRecorded: false,
  hasStarted: false, // becomes true once the first move of the current game is played
  started: false, // becomes true once "新しく対戦する" has been pressed for the first time
  settingsOpen: true,
  busy: false,
};

function setSettingsOpen(open) {
  state.settingsOpen = open;
  settingsPanel.hidden = !open;
  settingsToggleBtn.classList.toggle('open', open);
}

function computerColor() {
  return opponent(state.humanColor);
}

function cellEl(idx) {
  return boardEl.children[idx];
}

function buildBoardDom() {
  boardEl.innerHTML = '';
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.idx = i;
    cell.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(cell);
  }
}

function isHumanTurn() {
  return !(state.mode === 'cpu' && state.current === computerColor());
}

function paintCells(moves, adviceMap) {
  for (let i = 0; i < 64; i++) {
    const cell = cellEl(i);
    cell.className = 'cell';
    cell.innerHTML = '';
    const v = state.board[i];
    if (v !== 0) {
      const disc = document.createElement('div');
      disc.className = 'disc ' + (v === BLACK ? 'black' : 'white');
      cell.appendChild(disc);
      continue;
    }
    if (moves.has(i)) {
      cell.classList.add('legal');
      const a = adviceMap.get(i);
      if (a) {
        if (a.tier === 'best') cell.classList.add('best-move');
        if (a.tier === 'bad') cell.classList.add('bad-move');
        const mark = document.createElement('div');
        mark.className = 'advice-mark ' + a.tier;
        mark.textContent = a.tier === 'best' ? '★' + a.rank : String(a.rank);
        cell.appendChild(mark);
      }
    }
  }
}

function render() {
  const moves = legalMoves(state.board, state.current);
  const humanTurn = isHumanTurn();
  const showAdvice = state.adviceOn && humanTurn;

  // Paint immediately without advice so the human's own move (or the
  // computer's just-played move) shows up with no delay. Advice marks (which
  // require a heavy search) are computed afterwards and patched in once ready.
  // While the computer is thinking, don't mark its candidate cells either —
  // those aren't something the player can act on.
  paintCells(humanTurn ? moves : new Map(), new Map());
  legendEl.hidden = !showAdvice;
  currentAdviceMap = new Map();

  adviceToken++;
  if (showAdvice) {
    const myToken = adviceToken;
    const boardSnapshot = state.board;
    const player = state.current;
    const speed = state.adviceSpeed;

    pendingAdviceRequests.set(myToken, {
      fallback: () => handleAdviceResult(myToken, adviseMoves(boardSnapshot, player, speed)),
    });

    adviceWorker.postMessage({ token: myToken, board: boardSnapshot, player, speed });

    // Safety net: if the worker never replies (load failure, blocked
    // environment, etc.) compute on the main thread instead of staying silent.
    const speedMs = speed === 'fast' ? 300 : Number(speed);
    setTimeout(() => {
      const req = pendingAdviceRequests.get(myToken);
      if (req) req.fallback();
    }, speedMs + 2000);
  }

  const { black, white } = countDiscs(state.board);
  blackScoreEl.textContent = black;
  whiteScoreEl.textContent = white;

  updateStatus(moves);
}

function recordResultIfNeeded() {
  if (state.gameRecorded || state.mode !== 'cpu') return;
  state.gameRecorded = true;
  const { black, white } = countDiscs(state.board);
  const humanDiscs = state.humanColor === BLACK ? black : white;
  const cpuDiscs = state.humanColor === BLACK ? white : black;
  const result = humanDiscs > cpuDiscs ? 'win' : humanDiscs < cpuDiscs ? 'lose' : 'draw';
  state.stats[state.difficulty][result]++;
  saveSettings();
  renderStats();
}

function renderTally() {
  for (const tier of ['best', 'good', 'normal', 'bad']) {
    legendEl.querySelector(`[data-tally="${tier}"]`).textContent = state.moveTally[tier];
  }
}

function renderStats() {
  statsPanel.hidden = state.mode !== 'cpu';
  for (const d of DIFFICULTIES) {
    const row = statsPanel.querySelector(`tr[data-stats-row="${d}"]`);
    row.classList.toggle('current-difficulty', d === state.difficulty);
    const s = state.stats[d];
    row.querySelector('.win').textContent = s.win;
    row.querySelector('.lose').textContent = s.lose;
    row.querySelector('.draw').textContent = s.draw;
  }
}

function updateStatus(moves) {
  if (isGameOver(state.board)) {
    const { black, white } = countDiscs(state.board);
    if (black === white) statusEl.textContent = `引き分け（黒${black} - 白${white}）`;
    else statusEl.textContent = (black > white ? '黒の勝ち' : '白の勝ち') + `（黒${black} - 白${white}）`;
    recordResultIfNeeded();
    return;
  }
  const playerLabel = state.current === BLACK ? '黒' : '白';
  if (moves.size === 0) {
    statusEl.textContent = `${playerLabel}は置けないのでパスします`;
    return;
  }
  if (state.mode === 'cpu' && state.current === computerColor()) {
    statusEl.textContent = 'コンピューターが考え中…';
  } else {
    statusEl.textContent = `${playerLabel}の番です`;
  }
}

function afterMove() {
  if (!state.hasStarted) {
    state.hasStarted = true;
    if (state.settingsOpen) setSettingsOpen(false);
  }

  if (isGameOver(state.board)) { render(); return; }

  const nextPlayer = opponent(state.current);
  if (legalMoves(state.board, nextPlayer).size === 0) {
    // nextPlayer has no legal move: show the pass message briefly, then
    // hand the turn straight back to the player who just moved.
    state.current = nextPlayer;
    render();
    setTimeout(() => {
      state.current = opponent(nextPlayer);
      render();
      maybeRunComputer();
    }, 700);
    return;
  }
  state.current = nextPlayer;
  render();
  maybeRunComputer();
}

function maybeRunComputer() {
  const cpuColor = computerColor();
  if (state.mode !== 'cpu' || state.current !== cpuColor || state.busy) return;
  if (isGameOver(state.board)) return;
  state.busy = true;
  render();
  setTimeout(() => {
    const idx = chooseComputerMove(state.board, cpuColor, state.difficulty);
    state.busy = false;
    if (idx === null) { afterMove(); return; }
    const flips = legalMoves(state.board, cpuColor).get(idx);
    state.board = applyMove(state.board, idx, cpuColor, flips);
    afterMove();
  }, 50);
}

function onCellClick(idx) {
  if (state.busy) return;
  if (isGameOver(state.board)) return;
  if (state.mode === 'cpu' && state.current === computerColor()) return;

  const moves = legalMoves(state.board, state.current);
  const flips = moves.get(idx);
  if (!flips) return;

  if (state.adviceOn) {
    const advice = currentAdviceMap.get(idx);
    if (advice) {
      state.moveTally[advice.tier]++;
      renderTally();
    } else {
      // Advice for this move hasn't finished computing yet — remember it so
      // the tally still gets credited once that computation resolves.
      awaitingTally = { token: adviceToken, idx };
    }
  }

  state.board = applyMove(state.board, idx, state.current, flips);
  afterMove();
}

function newGame() {
  state.board = createBoard();
  state.current = BLACK;
  state.busy = false;
  state.gameRecorded = false;
  state.hasStarted = false;
  state.moveTally = { best: 0, good: 0, normal: 0, bad: 0 };
  pendingAdviceRequests.clear();
  awaitingTally = null;
  renderTally();
  renderStats();
  if (state.started) {
    render();
    maybeRunComputer();
  }
}

function setupControls() {
  document.getElementById('modeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    setActive('modeSeg', btn);
    state.mode = btn.dataset.mode;
    difficultyRow.style.display = state.mode === 'cpu' ? '' : 'none';
    colorRow.style.display = state.mode === 'cpu' ? '' : 'none';
    saveSettings();
    newGame();
  });

  document.getElementById('diffSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-diff]');
    if (!btn) return;
    setActive('diffSeg', btn);
    state.difficulty = btn.dataset.diff;
    saveSettings();
    newGame();
  });

  document.getElementById('colorSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-color]');
    if (!btn) return;
    setActive('colorSeg', btn);
    state.humanColor = btn.dataset.color === 'black' ? BLACK : WHITE;
    saveSettings();
    newGame();
  });

  document.getElementById('adviceSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-advice]');
    if (!btn) return;
    setActive('adviceSeg', btn);
    state.adviceOn = btn.dataset.advice === 'on';
    adviceSpeedRow.style.display = state.adviceOn ? '' : 'none';
    saveSettings();
    render();
  });

  document.getElementById('adviceSpeedSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-speed]');
    if (!btn) return;
    setActive('adviceSpeedSeg', btn);
    state.adviceSpeed = btn.dataset.speed;
    saveSettings();
    render();
  });

  document.getElementById('newGameBtn').addEventListener('click', () => {
    state.started = true;
    gameAreaEl.hidden = false;
    setSettingsOpen(false);
    newGame();
  });

  settingsToggleBtn.addEventListener('click', () => {
    setSettingsOpen(!state.settingsOpen);
  });
}

function setActive(groupId, activeBtn) {
  const group = document.getElementById(groupId);
  group.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  activeBtn.classList.add('active');
}

function applySavedSettingsToUi() {
  setActive('modeSeg', document.querySelector(`#modeSeg [data-mode="${state.mode}"]`));
  setActive('diffSeg', document.querySelector(`#diffSeg [data-diff="${state.difficulty}"]`));
  setActive('colorSeg', document.querySelector(`#colorSeg [data-color="${state.humanColor === BLACK ? 'black' : 'white'}"]`));
  setActive('adviceSeg', document.querySelector(`#adviceSeg [data-advice="${state.adviceOn ? 'on' : 'off'}"]`));
  setActive('adviceSpeedSeg', document.querySelector(`#adviceSpeedSeg [data-speed="${state.adviceSpeed}"]`));
  difficultyRow.style.display = state.mode === 'cpu' ? '' : 'none';
  colorRow.style.display = state.mode === 'cpu' ? '' : 'none';
  adviceSpeedRow.style.display = state.adviceOn ? '' : 'none';
}

buildBoardDom();
setupControls();
applySavedSettingsToUi();
setSettingsOpen(true);
state.current = BLACK;
renderStats();
