// Runs in MAIN world (declared in manifest) — bypasses page CSP.
// Hooks WebSocket before the page creates any connections.
(function () {
  if (window.__cfzHooked) return;
  window.__cfzHooked = true;
  const _WS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (url && url.includes('substrate.office.com')) {
      window.postMessage({ type: 'CFZ_WS_URL', url }, '*');
    }
    return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
  };
  Object.setPrototypeOf(window.WebSocket, _WS);
  window.WebSocket.prototype = _WS.prototype;
})();
