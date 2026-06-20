importScripts('ai.js');

self.onmessage = (event) => {
  const { token, board, player, speed } = event.data;
  const advice = self.Othello.adviseMoves(board, player, speed);
  self.postMessage({ token, advice });
};
