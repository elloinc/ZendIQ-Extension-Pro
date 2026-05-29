/**
 * ZendIQ – page-axiom.js
 * Axiom.trade verification adapter — post-settlement signal capture and token risk scoring.
 *
 * Registers a fetch + XHR observer at document_start (MAIN world) to read
 * Axiom's three post-settlement telemetry signals:
 *   • log-tx-v3                      — trade outcome, fees, MEV mode
 *   • meme-open-single-position-v2   — buy: wallet pubkey + token address
 *   • handle-position-close-v2       — sell: wallet pubkey + token address
 *
 * Caches ns.axiomSessionPubkey (wallet pubkey from position signals).
 * Triggers ns.fetchTokenScore on buy, deduped by ns._tokenScoreMint.
 *
 * Loaded independently of page-network.js (which must NOT run on axiom.trade —
 * page-network.js overrides sendTransaction and would wrongly trigger the
 * swap-intercept flow on Axiom's Helius submissions). This file installs a
 * minimal observer scoped to Axiom's telemetry endpoints only.
 *
 * Load order: page-config.js → page-utils.js → page-token-score.js → page-axiom.js.
 */

(function () {
  'use strict';

  // ── Only run on the main trading UI ─────────────────────────────────────
  // Use exact match so docs.axiom.trade / api3.axiom.trade etc. don't get
  // the fetch/XHR override installed (avoids spurious extension warnings).
  const _HOST = window.location.hostname;
  if (_HOST !== 'axiom.trade' && _HOST !== 'www.axiom.trade') return;

  const ns = window.__zq;

  // ── Signal URL fragments ─────────────────────────────────────────────────
  // Three post-settlement telemetry endpoints Axiom fires after every trade.
  // See docs/axiom-integration-scoping.md §2.3 for field documentation.
  const _SIG_LOG_TX    = 'log-tx-v3';
  const _SIG_OPEN_POS  = 'meme-open-single-position-v2';
  const _SIG_CLOSE_POS = 'handle-position-close-v2';

  function _isAxiomSignal(url) {
    if (typeof url !== 'string') return false;
    return url.includes('axiom.trade') && (
      url.includes(_SIG_LOG_TX) ||
      url.includes(_SIG_OPEN_POS) ||
      url.includes(_SIG_CLOSE_POS)
    );
  }

  // ── Safe JSON parse (no page-utils.js dependency in step 1) ─────────────
  function _tryJson(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  // ── Field extractors ─────────────────────────────────────────────────────

  // log-tx-v3: full trade outcome — signature, preset (fees, MEV mode), provider.
  // Primary post-trade anchor for sandwich detection and Activity recording.
  function _extractLogTx(raw) {
    const b = _tryJson(raw);
    if (!b) return null;
    const log = Array.isArray(b.logs) ? b.logs[0] : null;
    if (!log) return null;
    const p = log.preset ?? {};
    return {
      type:           'log-tx-v3',
      signature:      log.signature              ?? null,
      success:        log.success                ?? null,
      timeTakenMs:    log.timeTakenMs            ?? null,
      provider:       log.provider               ?? null,
      region:         log.region                 ?? null,
      slippage:       p.slippage                 ?? null,
      priorityFeeSol: p.priorityFeeSol           ?? null,
      bribeFeeSol:    p.bribeFeeSol              ?? null,
      mevProtection:  p.mevProtection            ?? null,
      enhancedMev:    p.enhancedMevProtection    ?? null,
    };
  }

  // meme-open-single-position-v2: new buy position.
  // walletAddress is the session wallet pubkey — cache on first signal received.
  // handle-position-close-v2: sell / position close.
  function _extractPosition(raw, type) {
    const b = _tryJson(raw);
    if (!b) return null;
    return {
      type,
      walletAddress: Array.isArray(b.walletAddresses) ? (b.walletAddresses[0] ?? null) : null,
      tokenAddress:  b.tokenAddress ?? null,
      subOrgId:      b.subOrgId     ?? null,
    };
  }

  // ── Pubkey + position state helpers ─────────────────────────────────────

  // Regex for Solana pubkeys: 32–44 base58 chars (no 0, O, I, l).
  const _PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  // Centralised pubkey setter — update-if-changed, logs every transition.
  // Replaces the old first-write-wins guard so multi-wallet switches are tracked.
  function _setPubkey(pubkey, source) {
    if (!pubkey || !ns) return;
    if (pubkey === ns.axiomSessionPubkey) return;
    if (ns.axiomSessionPubkey) {
      console.log('[ZQ:AXIOM] wallet switch (' + source + '):', ns.axiomSessionPubkey.slice(0, 8) + '…', '→', pubkey.slice(0, 8) + '…');
    }
    ns.axiomSessionPubkey = pubkey;
  }

  // Recursively find a Solana pubkey in a parsed JSON object.
  // Only follows object keys that semantically relate to a wallet to reduce
  // false positives (token addresses share the same base58 shape).
  const _WALLET_KEY_RE = /wallet|pubkey|address|account|public|owner/i;
  function _deepFindPubkey(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth ?? 0) > 4) return null;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && _WALLET_KEY_RE.test(k) && _PUBKEY_RE.test(v.trim())) return v.trim();
      if (v && typeof v === 'object') {
        const found = _deepFindPubkey(v, (depth ?? 0) + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // Scan localStorage + sessionStorage for a wallet pubkey.
  // Key-name filter narrows search; otherwise token addresses (same shape) yield false positives.
  const _STORE_KEY_RE = /wallet|pubkey|address|account|solana|profile|user/i;
  function _readFromStorage() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (!key || !_STORE_KEY_RE.test(key)) continue;
          const raw = store.getItem(key);
          if (!raw) continue;
          if (_PUBKEY_RE.test(raw.trim())) return raw.trim();
          try { const f = _deepFindPubkey(JSON.parse(raw), 0); if (f) return f; } catch (_) {}
        }
      } catch (_) {}
    }
    return null;
  }

  // Scan DOM attributes and text nodes for a wallet pubkey.
  // Not called at document_start (DOM empty then) — deferred to DOMContentLoaded.
  // NOTE: if Axiom uses a specific selector, refine _DOM_ATTRS or the zone query
  // after DevTools inspection to improve reliability before step 5.
  const _DOM_ATTRS = ['data-pubkey', 'data-wallet', 'data-address', 'data-wallet-address'];
  function _readFromDom() {
    for (const attr of _DOM_ATTRS) {
      const el = document.querySelector('[' + attr + ']');
      const v  = el?.getAttribute(attr)?.trim();
      if (v && _PUBKEY_RE.test(v)) return v;
    }
    const zones = document.querySelectorAll(
      'header, nav, [class*="wallet"], [class*="profile"], [class*="account"], [class*="user"]'
    );
    for (const zone of zones) {
      for (const el of zone.querySelectorAll('*')) {
        const text = (el.firstChild?.nodeType === 3 ? el.firstChild.textContent : '').trim();
        if (_PUBKEY_RE.test(text)) return text;
      }
    }
    return null;
  }

  // MutationObserver fallback — watches for pubkey-shaped text after React hydration.
  // Self-cancels after 60 s or when axiomSessionPubkey is already populated.
  let _domObserver = null;
  function _startObserver() {
    if (_domObserver) return;
    const deadline = Date.now() + 60_000;
    _domObserver = new MutationObserver(function () {
      if (ns?.axiomSessionPubkey || Date.now() > deadline) {
        _domObserver.disconnect(); _domObserver = null; return;
      }
      const found = _readFromDom();
      if (found) { _setPubkey(found, 'dom-observer'); _domObserver.disconnect(); _domObserver = null; }
    });
    _domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Dispatch captured signal ─────────────────────────────────────────────

  function _dispatchSignal(url, bodyStr) {
    let ev = null;
    if (url.includes(_SIG_LOG_TX))         ev = _extractLogTx(bodyStr);
    else if (url.includes(_SIG_OPEN_POS))  ev = _extractPosition(bodyStr, 'meme-open-single-position-v2');
    else if (url.includes(_SIG_CLOSE_POS)) ev = _extractPosition(bodyStr, 'handle-position-close-v2');
    if (!ev) return;

    // Step 3b: update session wallet pubkey (update-if-changed, logs wallet switches).
    if (ev.walletAddress) _setPubkey(ev.walletAddress, 'signal');

    // Step 3c: per-wallet open-position map — enables token resolution on close signals.
    if (ev.type === 'meme-open-single-position-v2' && ev.walletAddress && ev.tokenAddress && ns) {
      ns.axiomPositions.set(ev.walletAddress, { wallet: ev.walletAddress, token: ev.tokenAddress, openedAt: Date.now() });
    } else if (ev.type === 'handle-position-close-v2' && ev.walletAddress && ns) {
      const open = ns.axiomPositions.get(ev.walletAddress);
      if (open) {
        // Prefer map-resolved token; close signal body may omit tokenAddress.
        if (!ev.tokenAddress) ev = Object.assign({}, ev, { tokenAddress: open.token });
        ns.axiomPositions.delete(open.wallet);
        console.log('[ZQ:AXIOM] position close resolved: wallet=' + open.wallet.slice(0, 8) + '… token=' + open.token.slice(0, 8) + '…');
      } else if (!ev.tokenAddress) {
        console.warn('[ZQ:AXIOM] position close: no open position in map (opened before ZendIQ loaded) wallet=' + ev.walletAddress.slice(0, 8) + '…');
      }
    }

    // Step 4: trigger token risk scoring on buy; deduped by ns._tokenScoreMint.
    if (ev.type === 'meme-open-single-position-v2' && ev.tokenAddress && ns?.fetchTokenScore) {
      if (ev.tokenAddress !== ns._tokenScoreMint) {
        ns._tokenScoreMint  = ev.tokenAddress;
        ns.tokenScoreResult = null;
        ns.fetchTokenScore(ev.tokenAddress, null);
      }
    }

    console.log('[ZQ:AXIOM]', ev.type);
  }

  // ── Step 3a: early session wallet pubkey read ────────────────────────────
  // Storage is available immediately at document_start; DOM is not.
  // Falls back through: storage → DOMContentLoaded DOM scan → MutationObserver.
  // Signal-path (_dispatchSignal) fills the gap if all DOM strategies miss.
  (function _earlyPubkeyRead() {
    const fromStorage = _readFromStorage();
    if (fromStorage) { _setPubkey(fromStorage, 'storage'); return; }
    function _domRead() {
      if (ns?.axiomSessionPubkey) return;
      const fromDom = _readFromDom();
      if (fromDom) _setPubkey(fromDom, 'dom');
      else         _startObserver();
    }
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', _domRead, { once: true });
    } else {
      _domRead();
    }
  })();

  // ── fetch observer ──────────────────────────────────────────────────────────────────
  // Installed at document_start before Axiom's JS bundles load.
  const _origFetch = window.fetch;
  window.fetch = async function (resource, init) {
    try {
      const url = typeof resource === 'string' ? resource : (resource?.url ?? '');
      if (_isAxiomSignal(url)) {
        const body = init?.body ?? null;
        if (typeof body === 'string' && body) _dispatchSignal(url, body);
      }
    } catch (_) {}
    return _origFetch(resource, init);
  };

  // ── XHR observer ─────────────────────────────────────────────────────────────────
  // Axiom's telemetry signals are most likely fetch, but this observer covers XHR too.
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (_method, url) {
    this.__zq_ax_url = typeof url === 'string' ? url : '';
    return _origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__zq_ax_url ?? '';
      if (_isAxiomSignal(url) && typeof body === 'string' && body) {
        _dispatchSignal(url, body);
      }
    } catch (_) {}
    return _origSend.apply(this, arguments);
  };

  // ── Site adapter registration ────────────────────────────────────────────
  // Registered so page-interceptor.js (if ever loaded here) finds the adapter
  // via ns.activeSiteAdapter(). Substantive logic lives in _dispatchSignal above.
  if (!ns?.registerSiteAdapter) return;

  ns.registerSiteAdapter({
    name:       'axiom',
    matches()   { return _HOST === 'axiom.trade' || _HOST === 'www.axiom.trade'; },
    busyStates: [],

    initPage() {
      // Step 3a early pubkey read is triggered directly in the IIFE above
      // (page-interceptor.js is not loaded on axiom.trade, so initPage is never called).
      // Step 5: SPA URL listener for token changes + Jupiter benchmark trigger
    },

    onNetworkRequest(_url, _parsed) {
      // No-op — page-network.js is not loaded on axiom.trade.
      // All signal reading is handled by the fetch/XHR observer above.
    },

    onWalletArgs(_args) {
      // No-op — Turnkey signs server-side; wallet adapter never fires for trades
    },
  });

})();
