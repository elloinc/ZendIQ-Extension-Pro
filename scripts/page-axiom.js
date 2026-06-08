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

  // ── Local intercept state (IIFE scope) ───────────────────────────────────
  let _axiomBypassNext   = false;  // set true before re-click to bypass our own capture
  let _axiomBuyAmountSol = null;   // last SOL amount the user entered in the amount field
  const _AXIOM_SOL_FALLBACK = 150; // USD per SOL when no live price is available

  // ── Axiom-only widget mode ───────────────────────────────────────────────
  // Flag pages throughout page-widget.js to hide routing UX and show risk-only
  // content. Also exposes resolveWalletPubkey so the widget can display the address.
  if (ns) {
    ns.axiomVerifyOnly = true;
    if (!ns.resolveWalletPubkey) {
      ns.resolveWalletPubkey = () => ns.axiomSessionPubkey ?? null;
    }
    // Called by page-widget.js Proceed button — re-clicks the Buy button with
    // our capture listener bypassed so React's handlers fire normally.
    ns.axiomProceedTrade = function () {
      ns.axiomConfirmPending = false;
      ns.axiomPendingBtnRef  = null;
      // Immediately re-render Monitor so confirm panel disappears before the
      // trade fires — prevents the panel staying up through settlement.
      try { ns.renderWidgetPanel?.(); } catch (_) {}
      // Re-find the buy button fresh — the cached ref may be stale if React
      // re-rendered after the widget opened.
      const btn = Array.from(document.querySelectorAll('button')).find(function (b) {
        return (b.textContent ?? '').trim().toLowerCase().startsWith('buy ');
      });
      if (!btn) return;
      // Fire the full pointer → mouse → click chain so Axiom's handler fires
      // regardless of whether they use onPointerDown, onMouseDown, or onClick.
      // _axiomBypassNext lets all three events pass through our capture listeners.
      _axiomBypassNext = true;
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, isPrimary: true }));
      btn.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, composed: true, isPrimary: true }));
      btn.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true, composed: true }));
      btn.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true, composed: true }));
      btn.click();
    };
  }

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
    ns.axiomSessionPubkey = pubkey;    // Update the pill status — same 'Active' label as Jupiter once wallet is known.
    try { ns.updateWidgetStatus?.('Active'); } catch (_) {}  }

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
      ns.axiomLastOpIsClose = false;
      ns.axiomPositions.set(ev.walletAddress, { wallet: ev.walletAddress, token: ev.tokenAddress, openedAt: Date.now() });
    } else if (ev.type === 'handle-position-close-v2' && ev.walletAddress && ns) {
      ns.axiomLastOpIsClose = true;  // suppress the log-tx-v3 that follows (sell trade)
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
        ns.axiomRiskAcknowledged = false; // new token — reset acknowledgement
        ns.fetchTokenScore(ev.tokenAddress, null);
      }
    }

    // Step 6: Activity recording from log-tx-v3.
    // Fires post-settlement. Token context comes from ns._tokenScoreMint (set by URL
    // navigation before the user buys). Risk score from ns.tokenScoreResult (pre-fetched
    // the moment the user navigates to the token page).
    if (ev.type === 'log-tx-v3' && ev.signature && ns) {
      // Skip sell trades — log-tx-v3 fires for both buys and sells. When a
      // handle-position-close-v2 signal precedes it, it's a sell; we don't intercept
      // or add value to those, so skip recording to Activity.
      if (ns.axiomLastOpIsClose) { ns.axiomLastOpIsClose = false; return; }
      // Cache slippage (decimal) and MEV mode for use in pre-trade risk computations.
      if (ev.slippage != null) ns.axiomLastSlippage = ev.slippage / 100;
      if (ev.mevProtection != null) ns.axiomLastMevMode = ev.mevProtection;
      const _token = ns._tokenScoreMint || null;
      const _risk  = (ns.tokenScoreResult?.loaded) ? ns.tokenScoreResult : null;
      const _SOL   = 'So11111111111111111111111111111111111111112';
      const _entry = {
        source:      'axiom',
        optimized:   false,
        signature:   ev.signature,
        success:     ev.success,
        timestamp:   Date.now(),
        walletPubkey: ns.axiomSessionPubkey ?? null,
        // Token — outputMint is the meme token; input is always SOL on Axiom.
        tokenOut:    _risk?.symbol ?? null,
        outputMint:  _token,
        tokenIn:     'SOL',
        inputMint:   _SOL,
        amountIn:    _axiomBuyAmountSol ?? null,  // pre-trade SOL amount; enriched by RPC fetch below
        amountOut:   null,   // filled async below via getTransaction
        // Risk (token risk score — no swap MEV risk data on Axiom).
        riskScore:   _risk?.score   ?? null,
        riskLevel:   _risk?.level   ?? null,
        riskFactors: _risk?.factors ?? null,
        // Exchange hint.
        routeSource: 'axiom',
        // Axiom preset breakdown extracted from the log-tx-v3 body.
        axiomPreset: {
          priorityFeeSol:        ev.priorityFeeSol        ?? null,
          bribeFeeSol:           ev.bribeFeeSol           ?? null,
          mevProtection:         ev.mevProtection         ?? null,
          enhancedMevProtection: ev.enhancedMev           ?? null,
          provider:              ev.provider              ?? null,
          region:                ev.region                ?? null,
          slippage:              ev.slippage              ?? null,
          timeTakenMs:           ev.timeTakenMs           ?? null,
        },
        sandwichResult: null,   // filled async below
      };
      try {
        window.postMessage({ sr_bridge_to_ext: true, msg: { type: 'HISTORY_UPDATE', payload: _entry } }, '*');
      } catch (_) {}

      // Sandwich detection — assumed buy direction (SOL→token) which is the common case.
      // For sells the direction is reversed; detection may miss but never false-positives.
      if (ns.detectSandwich && _token) {
        ns.detectSandwich(ev.signature, _SOL, _token).then(function (sw) {
          if (!sw) return;
          try {
            window.postMessage({
              sr_bridge_to_ext: true,
              msg: { type: 'HISTORY_UPDATE', payload: { signature: ev.signature, sandwichResult: sw } },
            }, '*');
          } catch (_) {}
        }).catch(function () {});
      }

      // Async: fetch actual SOL spent + tokens received from the confirmed transaction.
      // Posts a second HISTORY_UPDATE to enrich the Activity card once on-chain data arrives.
      if (ns.rpcCall) {
        const _sig = ev.signature;
        const _wp  = ns.axiomSessionPubkey;
        (async function () {
          for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise(function (r) { setTimeout(r, attempt === 0 ? 4000 : 3000); });
            try {
              const res = await ns.rpcCall('getTransaction', [
                _sig,
                { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
              ]);
              const tx = res?.result;
              if (!tx?.meta) continue;
              const meta = tx.meta;
              if (meta.err != null) return; // failed tx — amountIn/Out irrelevant
              const msg  = tx.transaction?.message ?? {};
              const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
              const _rwp = _wp ?? (keys.length > 0
                ? (typeof keys[0] === 'string' ? keys[0] : (keys[0]?.pubkey ?? null)) : null);

              // amountOut: meme token balance increase for the wallet.
              // Tier 1: mint + owner exact match.
              // Tier 2: mint-only match (owner field absent on some token layouts).
              // Tier 3: scan all postTokenBalances for biggest positive increase (catch-all).
              let amountOut = null;
              const post = meta.postTokenBalances ?? [];
              const pre  = meta.preTokenBalances  ?? [];
              if (_token) {
                let pe = post.find(function (e) { return e.mint === _token && e.owner === _rwp; });
                let pr = pre.find(function  (e) { return e.mint === _token && e.owner === _rwp; });
                if (!pe) {
                  pe = post.find(function (e) { return e.mint === _token; });
                  pr = pre.find(function  (e) { return e.mint === _token; });
                }
                if (pe) {
                  const rawPe = pe.uiTokenAmount?.uiAmount ?? (parseFloat(pe.uiTokenAmount?.amount ?? '0') / Math.pow(10, pe.uiTokenAmount?.decimals ?? 0));
                  const rawPr = pr ? (pr.uiTokenAmount?.uiAmount ?? (parseFloat(pr.uiTokenAmount?.amount ?? '0') / Math.pow(10, pr.uiTokenAmount?.decimals ?? 0))) : 0;
                  const diff = rawPe - rawPr;
                  if (diff > 0) amountOut = diff;
                }
              }
              if (amountOut == null) {
                // Tier 3: pick the token account with the biggest positive balance increase.
                let best = 0;
                for (const pe of post) {
                  const pr = pre.find(function (e) { return e.mint === pe.mint && e.accountIndex === pe.accountIndex; });
                  const rawPe = pe.uiTokenAmount?.uiAmount ?? (parseFloat(pe.uiTokenAmount?.amount ?? '0') / Math.pow(10, pe.uiTokenAmount?.decimals ?? 0));
                  const rawPr = pr ? (pr.uiTokenAmount?.uiAmount ?? (parseFloat(pr.uiTokenAmount?.amount ?? '0') / Math.pow(10, pr.uiTokenAmount?.decimals ?? 0))) : 0;
                  const diff = rawPe - rawPr;
                  if (diff > best) { best = diff; amountOut = diff; }
                }
              }

              // amountIn: SOL decrease minus tx fee = actual swap cost in SOL
              let amountIn = null;
              if (_rwp) {
                const idx = keys.findIndex(function (k) {
                  return (typeof k === 'string' ? k : k?.pubkey) === _rwp;
                });
                if (idx >= 0) {
                  const lamports = (meta.preBalances[idx] ?? 0) - (meta.postBalances[idx] ?? 0) - (meta.fee ?? 0);
                  if (lamports > 0) amountIn = lamports / 1e9;
                }
              }

              if (amountOut != null || amountIn != null) {
                try {
                  window.postMessage({
                    sr_bridge_to_ext: true,
                    msg: { type: 'HISTORY_UPDATE', payload: { signature: _sig, amountIn: amountIn ?? null, amountOut: amountOut ?? null } },
                  }, '*');
                } catch (_) {}
              }
              return;
            } catch (_) { /* retry */ }
          }
        })();
      }
      // Refresh Monitor tab so it shows idle state (not the confirm panel) after
      // settlement. axiomConfirmPending is already false (cleared by axiomProceedTrade).
      try { ns.renderWidgetPanel?.(); } catch (_) {}
    }

    console.log('[ZQ:AXIOM]', ev.type);
  }

  // ── Pre-trade risk computation ───────────────────────────────────────────
  // Reads Axiom's slippage setting from localStorage (user preference persisted
  // by Axiom's React app). Falls back to last known value from log-tx-v3 signals,
  // then to the observed default of 20% (confirmed across multiple live trades).
  const _SLIP_KEY_RE = /slippage|slip|setting/i;
  function _readAxiomSlippage() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !_SLIP_KEY_RE.test(k)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const n = parseFloat(raw);
        if (!isNaN(n) && n > 0 && n <= 100) return n > 1 ? n / 100 : n; // "20" or "0.20"
        try {
          const obj = JSON.parse(raw);
          const slip = obj?.slippage ?? obj?.defaultSlippage ?? null;
          if (slip != null) { const s = parseFloat(slip); if (!isNaN(s) && s > 0) return s > 1 ? s / 100 : s; }
        } catch (_) {}
      }
    } catch (_) {}
    return null;
  }

  // Compute Execution Risk and Bot Attack Risk for the current axiom token.
  // Called after fetchTokenScore completes and whenever slippage/mint changes.
  // Results stored on ns so renderMonitor can read them synchronously.
  const _SOL_MINT = 'So11111111111111111111111111111111111111112';
  // amountUSD is optional — pass the real USD value when the user has entered an amount.
  // Omit (or pass null/undefined) for the proactive scan before any amount is set.
  async function _computeAxiomRisk(mint, amountUSD) {
    if (!ns || !mint) return;

    // Slippage: localStorage → last log-tx-v3 signal → observed default (20%).
    const _slipDecimal = _readAxiomSlippage() ?? ns.axiomLastSlippage ?? 0.20;

    // ── Bot Attack Risk via calculateMEVRisk ─────────────────────────────
    // Axiom is primarily used for memecoin buys: single-hop AMM, high slippage,
    // thin liquidity — all factors that make sandwich attacks profitable.
    // Use routeType 'bonding_curve' for pump.fun mints (end in 'pump'),
    // else 'unknown' (Raydium AMM post-graduation).
    if (ns.calculateMEVRisk) {
      ns.axiomMevRisk = ns.calculateMEVRisk({
        inputMint:  _SOL_MINT,
        outputMint: mint,
        amountUSD:  (amountUSD ?? null), // null = unknown (skips size floor cap); real value re-scores
        routePlan:  null,                // single hop
        slippage:   _slipDecimal,
        routeType:  mint.endsWith('pump') ? 'bonding_curve' : 'unknown',
      });
    }

    // ── Execution Risk via calculateRisk ────────────────────────────────
    if (ns.calculateRisk && ns.fetchDevnetContext) {
      const txInfo = {
        accountCount: 6,  // typical for a meme buy
        swapInfo: {
          slippagePercent: _slipDecimal * 100, // calculateRisk expects percentage
          inAmount:        null,
          inAmountUsd:     null,
          outputMint:      mint,
          source:          'axiom',
        },
      };
      try {
        const ctx = await ns.fetchDevnetContext(txInfo);
        ns.axiomRiskResult = await ns.calculateRisk(txInfo, ctx);
      } catch (_) {}
    }

    // Re-render widget with fresh risk data.
    try { ns.renderWidgetPanel?.(); } catch (_) {}
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

  // ── SPA URL listener (step 5) ────────────────────────────────────────────
  // Axiom is a React SPA. Token navigation uses history.pushState, which does
  // NOT fire popstate — the setInterval poll is the primary detection path.
  // popstate covers browser back/forward navigation.
  //
  // URL pattern: axiom.trade/meme/{mint}
  //   e.g. axiom.trade/meme/CQa5WuQMcGszuyfv59sA2QZ3CrCLhiY9HBpymPADpump
  const _MINT_PATH_RE = /\/meme\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/;
  function _readMintFromUrl() {
    const m = _MINT_PATH_RE.exec(window.location.pathname + window.location.search);
    return m ? m[1] : null;
  }

  let _currentAxiomMint = null;

  function _onMintChange(mint) {
    if (!mint || mint === _currentAxiomMint) return;
    _currentAxiomMint  = mint;
    _axiomBuyAmountSol = null;  // reset amount on token navigation
    if (!ns) return;
    // Reset any pending intercept state from the previous token.
    ns.axiomConfirmPending = false;
    ns.axiomPendingBtnRef  = null;
    // Clear stale score so the widget shows "Scanning…" for the new token.
    if (ns._tokenScoreMint !== mint) {
      ns._tokenScoreMint  = mint;
      ns.tokenScoreResult = null;
    }
    // Pre-fetch before the user buys — score is ready by the time the trade fires.
    if (ns.fetchTokenScore) {
      ns.fetchTokenScore(mint, null).then(function (r) {
        if (!r || !r.loaded) return;
        // Compute execution + MEV risk now that the token score is available.
        _computeAxiomRisk(mint).catch(function () {});
        // Open the widget proactively on HIGH/CRITICAL so user sees the warning
        // before they click Buy. MEDIUM and below = pill stays closed.
        if ((r.level === 'HIGH' || r.level === 'CRITICAL') && ns.openZendIQPanel) {
          ns.openZendIQPanel();
        } else if (ns.renderWidgetPanel) {
          // Refresh pill badge colour and Monitor content for lower-risk tokens.
          ns.renderWidgetPanel();
        }
      }).catch(function () {});
    }
    // Also run a lightweight MEV risk estimate immediately (slippage known, token known).
    // Gives the widget something to show before token score finishes loading.
    _computeAxiomRisk(mint).catch(function () {});
  }

  // Reads initial mint on load, then polls every 250 ms for SPA navigation.
  (function _startSpaListener() {
    // Inject the widget DOM as soon as the page body is available.
    // page-interceptor.js is not loaded on axiom.trade, so we bootstrap the widget here.
    (function _initWidget() {
      function _go() {
        try { if (ns?.ensureWidgetInjected) ns.ensureWidgetInjected(); } catch (_) {}
        // page-wallet.js is not in the Axiom manifest — walletHooked is never set,
        // so the pill stays 'Connecting...' forever. Set 'Active' immediately since
        // we are monitoring regardless; _setPubkey upgrades nothing (already Active).
        try { ns?.updateWidgetStatus?.('Active'); } catch (_) {}
      }
      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', _go, { once: true });
      } else {
        _go();
      }
    })();

    _onMintChange(_readMintFromUrl());
    let _lastHref = window.location.href;
    setInterval(function () {
      if (window.location.href !== _lastHref) {
        _lastHref = window.location.href;
        _onMintChange(_readMintFromUrl());
      }
    }, 250);
    window.addEventListener('popstate', function () {
      _onMintChange(_readMintFromUrl());
    });

    // Buy button intercept and amount watcher use event delegation — no DOM ready needed.
    _interceptBuyButton();
    _watchAmountInput();
  })();

  // ── Buy button intercept ─────────────────────────────────────────────────
  // Two-layer capture intercept: pointerdown + click.
  // pointerdown fires before mousedown/click and before any React handler.
  // Calling preventDefault() on pointerdown causes Chrome to suppress the
  // subsequent mousedown and click from the physical press, so Axiom's handler
  // never fires regardless of which DOM event they listen to.
  // btn.click() (programmatic — used by axiomProceedTrade) does NOT fire
  // pointerdown, so the proceed path is unaffected.
  function _interceptBuyButton() {
    // Helper — returns the Buy button from an event, or null.
    function _buyBtn(e) {
      const path = e.composedPath ? e.composedPath() : [];
      const btn  = path.find(function (el) { return el && el.tagName === 'BUTTON'; })
                ?? e.target?.closest?.('button');
      if (!btn) return null;
      const txt = (btn.textContent ?? '').trim().toLowerCase();
      return txt.startsWith('buy ') ? btn : null;
    }

    function _showPanel(btn) {
      if (ns) {
        ns.axiomConfirmPending = true;
        ns.axiomPendingBtnRef  = btn;
        ns.axiomRiskAcknowledged = false; // new buy intercept — reset acknowledgement
      }
      const _w = document.getElementById('sr-widget');
      if (_w) {
        _w.style.display = '';
        _w.classList.add('expanded');
        if (ns) ns.widgetActiveTab = 'monitor';
      } else if (ns?.ensureWidgetInjected) {
        ns.ensureWidgetInjected();
        if (ns) ns.widgetActiveTab = 'monitor';
      }
      try { ns?.renderWidgetPanel?.(); } catch (_) {}
    }

    // Layer 1: pointerdown — earliest possible intercept point.
    // preventDefault() here suppresses the browser-generated mousedown + click
    // that would follow a physical press, blocking Axiom regardless of which
    // event their React component listens to (onClick, onMouseDown, onPointerDown).
    document.addEventListener('pointerdown', function (e) {
      if (_axiomBypassNext) return; // proceed-path: flag cleared by click handler; all events pass through
      const btn = _buyBtn(e);
      if (!btn) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _showPanel(btn);
    }, true);

    // Layer 2: click — handles keyboard Enter / programmatic clicks that skip
    // the pointer event chain, and serves as the bypass path for axiomProceedTrade.
    document.addEventListener('click', function (e) {
      if (_axiomBypassNext) { _axiomBypassNext = false; return; }
      const btn = _buyBtn(e);
      if (!btn) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!ns?.axiomConfirmPending) _showPanel(btn); // avoid double-showing
    }, true);
  }

  // ── Amount input watcher ─────────────────────────────────────────────────
  // Re-scores bot attack risk whenever the user changes the SOL amount.
  // Listens for native 'input' events (covers typed values) and watches the
  // buy button text ("Buy TOKEN 買X.XX") for preset-button clicks via
  // MutationObserver, since preset buttons update React state without a native
  // input event on the amount field.
  function _watchAmountInput() {
    let _debounce = null;
    function _rescore(solAmt) {
      // Skip while the confirm panel is open — DOM changes from widget rendering
      // would otherwise re-trigger _computeAxiomRisk unnecessarily.
      if (ns?.axiomConfirmPending) return;
      _axiomBuyAmountSol = solAmt;
      const mint = ns?._tokenScoreMint;
      if (!mint) return;
      const usd = solAmt * _AXIOM_SOL_FALLBACK;
      _computeAxiomRisk(mint, usd).catch(function () {});
    }
    // Typed input events.
    document.addEventListener('input', function (e) {
      const el = e.target;
      if (!el || el.tagName !== 'INPUT') return;
      const v = parseFloat(el.value);
      if (!isNaN(v) && v > 0 && v < 100000) {
        clearTimeout(_debounce);
        _debounce = setTimeout(function () { _rescore(v); }, 300);
      }
    }, { capture: true, passive: true });
    // Preset buttons update the buy-button text — watch for that change.
    function _startBtnObserver() {
      const obs = new MutationObserver(function () {
        // The buy button text contains the amount: e.g. "Buy NOPA 買0.01".
        const btns = document.querySelectorAll('button');
        for (let i = 0; i < btns.length; i++) {
          const txt = btns[i].textContent ?? '';
          const m = /[\u8CB7\u8CB7]([0-9]+(?:\.[0-9]+)?)/.exec(txt) // 買X.XX
                 ?? /buy\s+\S+\s+([0-9]+(?:\.[0-9]+)?)/i.exec(txt); // Buy SYM X.XX
          if (m) {
            const v = parseFloat(m[1]);
            if (!isNaN(v) && v > 0) {
              clearTimeout(_debounce);
              _debounce = setTimeout(function () { _rescore(v); }, 200);
            }
            break;
          }
        }
      });
      obs.observe(document.body, { subtree: true, characterData: true, childList: true });
    }
    if (document.body) { _startBtnObserver(); }
    else { window.addEventListener('DOMContentLoaded', _startBtnObserver, { once: true }); }
  }

  // ── Site adapter registration ────────────────────────────────────────────
  // Registered so page-interceptor.js (if ever loaded here) finds the adapter
  // via ns.activeSiteAdapter(). Substantive logic lives in _dispatchSignal above.
  if (!ns?.registerSiteAdapter) return;

  ns.registerSiteAdapter({
    name:       'axiom',
    matches()   { return _HOST === 'axiom.trade' || _HOST === 'www.axiom.trade'; },
    busyStates: [],

    initPage() {
      // Steps 3a–5 are triggered directly from the IIFE above
      // (page-interceptor.js is not loaded on axiom.trade, so initPage is never called).
    },

    onNetworkRequest(_url, _parsed) {
      // No-op — page-network.js is not loaded on axiom.trade.
      // All signal reading is handled by the fetch/XHR observer above.
    },

    onWalletArgs(_args) {
      // No-op — Turnkey signs server-side; wallet adapter never fires for trades
    },

    // Called by page-widget.js renderWidgetPanel() when Monitor tab is active
    // and no pending swap is being processed. Returns HTML string.
    // Mirrors the Review & Sign card stack: Overall Risk → Token Risk Score →
    // Bot Attack Risk → Execution Risk → impact warning → close button.
    renderMonitor() {
      const tokenScore = ns.tokenScoreResult;
      const _token     = ns._tokenScoreMint;
      const hasScore   = tokenScore?.loaded && tokenScore.mint === _token;
      const mevRisk    = ns.axiomMevRisk;
      const execRisk   = ns.axiomRiskResult;
      const _isSimple  = ns.widgetMode === 'simple';
      const _esc       = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const _sym       = hasScore
        ? _esc(tokenScore.symbol || (_token ? _token.slice(0,8) + '\u2026' : '?'))
        : (_token ? _token.slice(0,8) + '\u2026' : '?');

      // ── Idle state — no token loaded (listing pages, search, etc.) ────────
      if (!_token) {
        return `<div style="padding:14px 16px;">
          <div style="font-size:13px;color:#C2C2D4;text-align:center;padding:12px 0;line-height:1.6">
            Monitoring active.<br>Navigate to a token on <a href="https://axiom.trade" style="color:#9945FF;text-decoration:none">axiom.trade</a> to see risk analysis before you buy.
          </div>
        </div>`;
      }
      const _clr = { CRITICAL:'#FF4D4D', HIGH:'#FFB547', MEDIUM:'#9945FF', LOW:'#14F195' };
      const _c   = lvl => _clr[lvl] ?? '#C2C2D4';
      const _rl  = ns._riskLabel ?? (lvl => lvl);

      // ── Overall Risk — weighted composite (same formula as jup.ag) ─────────
      const _tkSc   = hasScore  ? (tokenScore.score        ?? 0) : 0;
      const _tkLvl  = hasScore  ? (tokenScore.level        ?? 'LOW') : null;
      const _botSc  = mevRisk   ? (mevRisk.riskScore       ?? 0) : 0;
      const _botLvl = mevRisk   ? (mevRisk.riskLevel       ?? 'LOW') : null;
      const _exSc   = execRisk  ? (execRisk.score          ?? 0) : 0;
      const _exLvl  = execRisk  ? (execRisk.level          ?? 'LOW') : null;
      const _comp   = Math.round(_exSc * 0.40 + _botSc * 0.35 + _tkSc * 0.25);
      const _compLvl = _comp >= 70 ? 'CRITICAL' : _comp >= 40 ? 'HIGH' : _comp >= 20 ? 'MEDIUM' : 'LOW';
      const _cc      = _c(_compLvl);
      const _hasAnyRisk = mevRisk || execRisk || hasScore;
      const _compBadge = _hasAnyRisk
        ? (_isSimple ? _rl(_compLvl) : (_compLvl + ' \u00b7 ' + _comp + '/100'))
        : '<span style="font-size:12px;color:#FFB547">scanning\u2026</span>';
      const _compTip = 'Overall Risk Score \u2014 weighted composite of all three risk dimensions.'
        + '&#10;Formula: Execution \u00d7 40% + Bot Attack \u00d7 35% + Token Risk \u00d7 25%'
        + '&#10;&#10;Execution: ' + _exSc + '/100 \u00b7 Bot Attack: ' + _botSc + '/100 \u00b7 Token Risk: '
        + (hasScore ? _tkSc + '/100' : 'pending\u2026');
      const _sc = lvl => _c(lvl ?? 'LOW');
      const _subRows = _isSimple ? '' : (
        '<div style="margin-top:8px;border-top:1px solid ' + _cc + '22;padding-top:7px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">'
        +   '<span style="color:#C8C8D8;font-size:12px">Execution</span>'
        +   (_exLvl
              ? '<span style="color:' + _sc(_exLvl) + ';font-size:12px;font-weight:700;font-family:Space Mono,monospace">' + _exLvl + ' \u00b7 ' + _exSc + '/100</span>'
              : '<span style="font-size:12px;color:#FFB547">scanning\u2026</span>')
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">'
        +   '<span style="color:#C8C8D8;font-size:12px">Bot Attack</span>'
        +   (_botLvl
              ? '<span style="color:' + _sc(_botLvl) + ';font-size:12px;font-weight:700;font-family:Space Mono,monospace">' + _botLvl + ' \u00b7 ' + _botSc + '/100</span>'
              : '<span style="font-size:12px;color:#FFB547">scanning\u2026</span>')
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0">'
        +   '<span style="color:#C8C8D8;font-size:12px">Token Risk</span>'
        +   (hasScore
              ? '<span style="color:' + _sc(_tkLvl) + ';font-size:12px;font-weight:700;font-family:Space Mono,monospace">' + _tkLvl + ' \u00b7 ' + _tkSc + '/100</span>'
              : '<span style="font-size:12px;color:#FFB547">scanning\u2026</span>')
        + '</div>'
        + '</div>'
      );
      const _overallCard =
        '<div title="' + _compTip + '" style="background:' + _cc + '11;border:1px solid ' + _cc + '44;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:help">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">'
        +   '<span style="color:' + _cc + ';font-weight:600">Overall Risk</span>'
        +   '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _cc + '">' + _compBadge + '</span>'
        + '</div>'
        + _subRows
        + '</div>';

      // ── Token Risk Score — shared builder from page-widget.js ─────────────
      const _tokenRiskCard = ns._buildTokenRiskCard
        ? ns._buildTokenRiskCard(hasScore ? tokenScore : null, _isSimple)
        : '<div style="text-align:center;padding:12px 0;color:#C2C2D4;font-size:12px">Scanning token risk\u2026</div>';

      // ── Bot Attack Risk — real score from calculateMEVRisk ───────────────
      // Axiom is ranked among the most sandwiched DEX UIs (sandwiched.me).
      // mevProtection=false (the observed default) means raw RPC broadcast — fully exposed.
      let _botCard = '';
      if (!mevRisk) {
        _botCard = '<div style="background:linear-gradient(135deg,rgba(20,241,149,0.05),rgba(153,69,255,0.05));border:1px solid rgba(20,241,149,0.18);border-radius:10px;padding:10px 12px;margin-bottom:10px">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">'
          + '<span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>'
          + '<span style="color:#FFB547;font-size:12px">scanning\u2026</span>'
          + '</div></div>';
      } else {
        const _mc   = _c(mevRisk.riskLevel);
        const _mbg  = 'background:' + _mc + '11;border:1px solid ' + _mc + '44';
        const _badge = _isSimple ? _rl(mevRisk.riskLevel) : (mevRisk.riskLevel + ' \u00b7 ' + (mevRisk.estimatedLossPercentage?.toFixed(2) ?? '0') + '% est. loss');
        const _mevTip = 'Bot Attack Risk \u2014 Axiom.trade is one of the most sandwiched platforms (sandwiched.me).'
          + '&#10;Raw RPC broadcast (mevProtection: off) = fully exposed to sandwich attacks.'
          + '&#10;Score 0\u2013100: LOW <20 | MEDIUM 20\u201339 | HIGH 40\u201369 | CRITICAL 70+';

        // MEV factor rows — Advanced mode
        let _mevRows = '';
        if (!_isSimple) {
          const _mf = mevRisk.factors ?? [];
          if (_mf.length) {
            _mevRows = '<div style="margin-top:8px">' + _mf.map(function (f) {
              const fc = f.score >= 20 ? '#FF4D4D' : f.score >= 10 ? '#FFB547' : f.score >= 5 ? '#9945FF' : '#14F195';
              return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.25);border-left:2px solid ' + fc + ';border-radius:0 5px 5px 0;margin-bottom:3px">'
                + '<span style="font-size:12px;color:#C0C0D8">' + _esc(f.factor) + '</span>'
                + '<span style="font-size:9px;font-weight:700;color:' + fc + ';font-family:Space Mono,monospace;flex-shrink:0;margin-left:6px">' + f.score + '</span>'
                + '</div>';
            }).join('') + '</div>';
          }
        }

        // Est. exposure row
        const _expUsd = mevRisk.estimatedLossUSD > 0.0001
          ? '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06)">'
            + '<span style="color:#C2C2D4;cursor:help" title="Estimated dollar value bots could extract from this swap. Based on trade size and slippage tolerance. Actual trade amount not yet known.">Est. Exposure</span>'
            + '<span style="font-weight:700;font-family:Space Mono,monospace;font-size:12px;color:#FFB547">~$' + mevRisk.estimatedLossUSD.toFixed(4) + '</span>'
            + '</div>'
          : '';

        if (_isSimple) {
          _botCard = '<div title="' + _mevTip + '" style="' + _mbg + ';border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">'
            + '<span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>'
            + '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _mc + '">' + _badge + '</span>'
            + '</div></div>';
        } else {
          _botCard = '<div title="' + _mevTip + '" style="' + _mbg + ';border-radius:10px;padding:10px 12px;margin-bottom:10px;cursor:help">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,0.06)">'
            + '<span style="color:#9945FF;font-weight:600">Bot Attack Risk</span>'
            + '<span style="font-weight:700;font-size:12px;font-family:Space Mono,monospace;color:' + _mc + '">' + _badge + '</span>'
            + '</div>'
            + _mevRows
            + _expUsd
            + '</div>';
        }
      }

      // ── Execution Risk — shared builder; execRisk from calculateRisk ─────
      const _execCard = ns._buildExecutionRiskCard
        ? (ns._buildExecutionRiskCard(execRisk ?? null, _isSimple) || '<div style="background:rgba(255,181,71,0.06);border:1px solid rgba(255,181,71,0.2);border-radius:10px;padding:10px 12px;margin-bottom:10px"><div style="color:#FFB547;font-size:12px">Execution Risk — scanning\u2026</div></div>')
        : '';

      // ── Impact warning for HIGH / CRITICAL combined risk ─────────────────
      const _warnLvl = _hasAnyRisk && (_comp >= 40 || _botSc >= 40)
        ? (_comp >= 70 || _botSc >= 70 ? 'CRITICAL' : 'HIGH')
        : null;
      const _impactHtml = (_warnLvl && !ns.axiomRiskAcknowledged)
        ? '<div style="background:' + _c(_warnLvl) + '11;border:1px solid ' + _c(_warnLvl) + '33;border-radius:8px;padding:9px 12px;margin-bottom:10px">'
          + '<div style="color:' + _c(_warnLvl) + ';font-size:13px;font-weight:700;margin-bottom:3px">\u26a0 '
          + (_warnLvl === 'CRITICAL' ? 'Critical' : 'High') + ' sandwich risk on this token</div>'
          + '<div style="color:#C2C2D4;font-size:12px;line-height:1.5">Axiom broadcasts direct to RPC (no Jito by default). ZendIQ will show this panel before each buy \u2014 use Cancel if concerned.</div>'
          + '</div>'
        : '';

      // ── Footer: Proceed/Cancel (intercept) or Got-it (browse) ─────────────
      const _slipPct   = ((_readAxiomSlippage() ?? ns.axiomLastSlippage ?? 0.20) * 100).toFixed(1);
      const _amtLabel  = _axiomBuyAmountSol
        ? 'Trading <b>' + _axiomBuyAmountSol + ' SOL</b> at <b>' + _slipPct + '% slippage</b>'
        : 'Slippage tolerance: <b>' + _slipPct + '%</b>';
      const _footer = ns.axiomConfirmPending
        ? '<div style="font-size:12px;color:#C2C2D4;margin-bottom:8px;text-align:center">' + _amtLabel + '</div>'
          + '<button id="sr-ax-proceed" style="width:100%;padding:10px;border:none;border-radius:8px;background:linear-gradient(135deg,#14F195,#0cc97a);color:#061a10;font-size:13px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif;margin-bottom:7px">\u2713 Proceed with trade</button>'
          + '<button id="sr-ax-cancel" style="width:100%;padding:10px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:none;color:#C2C2D4;font-size:12px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif">\u2715 Cancel trade</button>'
        : ns.axiomRiskAcknowledged
          ? ''
          : '<button id="sr-ax-close" style="width:100%;padding:10px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;background:rgba(255,255,255,0.04);color:#C2C2D4;font-size:13px;font-weight:600;cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:background 0.15s">\u2713 Got it \u2014 close</button>';
      const _disclaimer = ns.axiomConfirmPending
        ? '<div style="font-size:11px;color:#4A4A6A;line-height:1.55;margin:0 0 10px;padding:0 2px">ZendIQ cannot re-route Axiom trades. Cancel and retry with lower slippage to reduce risk.</div>'
        : ns.axiomRiskAcknowledged
          ? ''
          : '<div style="font-size:11px;color:#4A4A6A;line-height:1.55;margin:0 0 12px;padding:0 2px">ZendIQ intercepts each buy to show this risk check.</div>';

      return '<div style="padding:14px 16px">'
        + (_token ? '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.7px;color:#6B6B8A;margin-bottom:10px">TOKEN RISK \u00b7 ' + _sym + '</div>' : '')
        + _overallCard
        + _tokenRiskCard
        + _botCard
        + _execCard
        + _impactHtml
        + _disclaimer
        + _footer
        + '</div>';
    },
  });

})();
