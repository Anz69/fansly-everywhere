(function () {
  'use strict';

  var T = {
    ru: {
      title: 'Войти через Telegram',
      hint: 'Введите номер телефона, привязанный к Telegram',
      placeholder: '+7 900 000-00-00',
      btnSend: 'Получить код',
      titleCode: 'Введите код',
      hintCode: 'Telegram отправил код подтверждения на ',
      btnVerify: 'Войти',
      back: '← Изменить номер',
      errPhone: 'Введите номер в формате +79001234567',
      errCode: 'Введите код из Telegram',
      errSend: 'Ошибка отправки. Попробуйте снова.',
      errVerify: 'Неверный код. Попробуйте снова.',
      qrTitle: 'Войти по QR-коду',
      qrHint: 'Откройте Telegram на телефоне → Настройки → Устройства → Подключить устройство',
      qrSwitch: 'Войти по QR-коду',
      phoneSwitch: 'Войти по номеру',
      qrExpired: 'QR-код обновляется...',
      qrError: 'Ошибка QR. Попробуйте по номеру.',
    },
    en: {
      title: 'Sign in via Telegram',
      hint: 'Enter the phone number linked to your Telegram account',
      placeholder: '+1 234 567-89-00',
      btnSend: 'Get code',
      titleCode: 'Enter code',
      hintCode: 'Telegram sent a verification code to ',
      btnVerify: 'Sign in',
      back: '← Change number',
      errPhone: 'Enter phone in format +12345678900',
      errCode: 'Enter the Telegram code',
      errSend: 'Failed to send. Please try again.',
      errVerify: 'Wrong code. Please try again.',
      qrTitle: 'Sign in with QR code',
      qrHint: 'Open Telegram on your phone → Settings → Devices → Link Desktop Device',
      qrSwitch: 'Sign in with QR code',
      phoneSwitch: 'Sign in with phone',
      qrExpired: 'Refreshing QR code...',
      qrError: 'QR error. Try phone instead.',
    }
  };

  var lang = 'en';
  var overlayVisible = false;
  var pendingResolvers = [];
  var overlay = null;
  var cardEl = null;
  var _styleInjected = false;
  var _qrPollTimer = null;
  var _qrToken = null;

  function detectLang(cb) {
    var cached = localStorage.getItem('fe_lang');
    if (cached === 'en') { lang = cached; cb(); return; }
    fetch('/api/lang', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) {
        lang = (d.lang === 'ru') ? 'ru' : 'en';
        localStorage.setItem('fe_lang', lang);
        document.documentElement.lang = lang;
        cb();
      })
      .catch(function () { cb(); });
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function (kv) {
      if (kv[0] === 'style') e.style.cssText = kv[1];
      else if (kv[0] === 'text') e.textContent = kv[1];
      else e.setAttribute(kv[0], kv[1]);
    });
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function (r) {
      return r.json().then(function (d) { if (!r.ok) throw d; return d; });
    });
  }

  var OVERLAY_STYLE = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.85);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif;padding:1rem;';
  var CARD_STYLE = 'background:#161616;border-radius:20px;padding:32px 28px;width:100%;max-width:360px;box-sizing:border-box;display:flex;flex-direction:column;gap:18px;box-shadow:0 8px 60px rgba(0,0,0,.8);border:1px solid #222;animation:tgPop .18s ease;';
  var INPUT_STYLE = 'width:100%;padding:13px 16px;border-radius:12px;border:1.5px solid #2e2e2e;background:#111;color:#fff;font-size:16px;outline:none;box-sizing:border-box;transition:border-color .2s;font-family:inherit;';
  var BTN_STYLE = 'width:100%;padding:14px;border-radius:12px;border:none;cursor:pointer;background:#2AABEE;color:#fff;font-size:15px;font-weight:700;transition:opacity .2s;font-family:inherit;';
  var HINT_STYLE = 'color:#666;font-size:13px;text-align:center;margin:0;line-height:1.6;';
  var ERR_STYLE = 'color:#f87171;font-size:13px;text-align:center;margin:0;display:none;';
  var TITLE_STYLE = 'color:#fff;font-size:18px;font-weight:800;margin:0;text-align:center;';
  var CLOSE_STYLE = 'position:absolute;top:16px;right:16px;background:none;border:none;color:#555;cursor:pointer;font-size:20px;line-height:1;padding:4px;';
  var LINK_STYLE = 'background:none;border:none;color:#2AABEE;cursor:pointer;font-size:13px;text-align:center;font-family:inherit;text-decoration:underline;';

  function injectStyles() {
    if (_styleInjected) return;
    _styleInjected = true;
    var s = document.createElement('style');
    s.textContent = '@keyframes tgPop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}@keyframes tgSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  function stopQrPoll() {
    if (_qrPollTimer) { clearTimeout(_qrPollTimer); _qrPollTimer = null; }
    _qrToken = null;
  }

  function onAuthSuccess() {
    stopQrPoll();
    overlayVisible = false;
    if (overlay) { overlay.remove(); overlay = null; cardEl = null; }
    window.dispatchEvent(new CustomEvent('fan:auth-success'));
    pendingResolvers.forEach(function (r) { r(); });
    pendingResolvers = [];
  }

  function closeOverlay() {
    stopQrPoll();
    if (overlay) { overlay.remove(); overlay = null; cardEl = null; }
    overlayVisible = false;
    pendingResolvers.forEach(function (r) { r(); });
    pendingResolvers = [];
  }

  /* ── QR code form ── */
  function buildQrForm() {
    stopQrPoll();
    var t = T[lang];
    cardEl.innerHTML = '';

    var closeBtn = el('button', { style: CLOSE_STYLE, text: '\u2715' });
    closeBtn.addEventListener('click', closeOverlay);

    var title = el('p', { style: TITLE_STYLE, text: t.qrTitle });
    var hint  = el('p', { style: HINT_STYLE, text: t.qrHint });

    var qrWrap = el('div', { style: 'display:flex;align-items:center;justify-content:center;min-height:180px;' });
    var spinner = el('div', { style: 'width:40px;height:40px;border:3px solid #333;border-top-color:#2AABEE;border-radius:50%;animation:tgSpin .8s linear infinite;' });
    qrWrap.appendChild(spinner);

    var statusTxt = el('p', { style: HINT_STYLE + 'margin-top:-8px;', text: '' });
    var err = el('p', { style: ERR_STYLE });

    var switchBtn = el('button', { style: LINK_STYLE, text: t.phoneSwitch });
    switchBtn.addEventListener('click', function () { stopQrPoll(); buildPhoneForm(); });

    cardEl.appendChild(closeBtn);
    cardEl.appendChild(title);
    cardEl.appendChild(hint);
    cardEl.appendChild(qrWrap);
    cardEl.appendChild(statusTxt);
    cardEl.appendChild(err);
    cardEl.appendChild(switchBtn);

    // Start QR session
    function startQr() {
      post('/api/auth/tg/qr-start', {})
        .then(function (d) {
          _qrToken = d.token;
          showQrImage(qrWrap, d.qrImageUrl);
          statusTxt.textContent = '';
          pollQr();
        })
        .catch(function () {
          err.textContent = t.qrError;
          err.style.display = 'block';
        });
    }

    function showQrImage(wrap, dataUrl) {
      wrap.innerHTML = '';
      if (dataUrl) {
        var img = el('img', { src: dataUrl, style: 'width:180px;height:180px;border-radius:12px;background:#fff;' });
        wrap.appendChild(img);
      } else {
        wrap.innerHTML = '<div style="color:#555;font-size:13px;">QR unavailable</div>';
      }
    }

    function pollQr() {
      if (!_qrToken) return;
      var tok = _qrToken;
      post('/api/auth/tg/qr-poll', { token: tok })
        .then(function (d) {
          if (!overlayVisible || !_qrToken) return;
          if (d.status === 'authorized') {
            onAuthSuccess();
            return;
          }
          // Update QR image if server returned a fresh one (recovery after restart)
          if (d.qrImageUrl) { showQrImage(qrWrap, d.qrImageUrl); }
          _qrPollTimer = setTimeout(pollQr, 2000);
        })
        .catch(function (e) {
          if (!overlayVisible || !_qrToken) return;
          var code = e && e.status;
          // 410 = QR expired - try restarting automatically
          if (code === 410 || (e && (e.error || '').includes('истекла'))) {
            statusTxt.textContent = t.qrExpired;
            statusTxt.style.color = '#f59e0b';
            _qrToken = null;
            setTimeout(function () {
              if (overlayVisible) { statusTxt.textContent = ''; statusTxt.style.color = ''; startQr(); }
            }, 1500);
            return;
          }
          // Other errors - retry after delay
          _qrPollTimer = setTimeout(pollQr, 3000);
        });
    }

    startQr();
  }

  /* ── Phone form ── */
  function buildPhoneForm() {
    stopQrPoll();
    var t = T[lang];
    cardEl.innerHTML = '';

    var closeBtn = el('button', { style: CLOSE_STYLE, text: '\u2715' });
    closeBtn.addEventListener('click', closeOverlay);

    var title = el('p', { style: TITLE_STYLE, text: t.title });
    var hint  = el('p', { style: HINT_STYLE, text: t.hint });
    var input = el('input', { type: 'tel', placeholder: t.placeholder, style: INPUT_STYLE });
    var btn   = el('button', { style: BTN_STYLE, text: t.btnSend });
    var err   = el('p', { style: ERR_STYLE });
    var qrSwitch = el('button', { style: LINK_STYLE, text: t.qrSwitch });
    qrSwitch.addEventListener('click', buildQrForm);

    input.addEventListener('focus', function () { input.style.borderColor = '#2AABEE'; });
    input.addEventListener('blur', function () { input.style.borderColor = '#2e2e2e'; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });

    btn.addEventListener('click', function () {
      var phone = input.value.trim().replace(/[\s\-()]/g, '');
      if (!/^\+\d{7,15}$/.test(phone)) {
        err.textContent = t.errPhone; err.style.display = 'block'; return;
      }
      btn.disabled = true; btn.style.opacity = '0.6'; err.style.display = 'none';
      post('/api/auth/tg/send-code', { phone: phone })
        .then(function (d) { buildCodeForm(phone, d.token); })
        .catch(function (e) {
          err.textContent = (e && e.error) || t.errSend;
          err.style.display = 'block';
          btn.disabled = false; btn.style.opacity = '1';
        });
    });

    [closeBtn, title, hint, input, btn, err, qrSwitch].forEach(function (c) { cardEl.appendChild(c); });
    setTimeout(function () { input.focus(); }, 80);
  }

  /* ── Code form ── */
  function buildCodeForm(phone, token) {
    var t = T[lang];
    cardEl.innerHTML = '';

    var closeBtn = el('button', { style: CLOSE_STYLE, text: '\u2715' });
    closeBtn.addEventListener('click', closeOverlay);

    var title = el('p', { style: TITLE_STYLE, text: t.titleCode });
    var hint  = el('p', { style: HINT_STYLE, text: t.hintCode + phone });
    var input = el('input', { type: 'text', placeholder: '12345', maxlength: '6', style: INPUT_STYLE + 'letter-spacing:0.3em;text-align:center;font-size:22px;' });
    var btn   = el('button', { style: BTN_STYLE, text: t.btnVerify });
    var err   = el('p', { style: ERR_STYLE });
    var back  = el('button', { style: LINK_STYLE, text: t.back });

    input.addEventListener('focus', function () { input.style.borderColor = '#2AABEE'; });
    input.addEventListener('blur', function () { input.style.borderColor = '#2e2e2e'; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    back.addEventListener('click', buildPhoneForm);

    btn.addEventListener('click', function () {
      var code = input.value.trim();
      if (!code) { err.textContent = t.errCode; err.style.display = 'block'; return; }
      btn.disabled = true; btn.style.opacity = '0.6'; err.style.display = 'none';
      post('/api/auth/tg/verify', { token: token, code: code })
        .then(function () { onAuthSuccess(); })
        .catch(function (e) {
          if (e && e.session_password_needed) {
            buildPasswordForm(phone, token);
            return;
          }
          err.textContent = (e && e.error) || t.errVerify;
          err.style.display = 'block';
          btn.disabled = false; btn.style.opacity = '1';
        });
    });

    [closeBtn, title, hint, input, btn, err, back].forEach(function (c) { cardEl.appendChild(c); });
    setTimeout(function () { input.focus(); }, 80);
  }

  /* ── 2FA form ── */
  function buildPasswordForm(phone, token) {
    var t = T[lang];
    cardEl.innerHTML = '';

    var closeBtn = el('button', { style: CLOSE_STYLE, text: '\u2715' });
    closeBtn.addEventListener('click', closeOverlay);

    var title = el('p', { style: TITLE_STYLE, text: 'Two-Factor Authentication' });
    var hint  = el('p', { style: HINT_STYLE, text: 'Your account has a Telegram cloud password set. Enter it to sign in.' });
    var input = el('input', { type: 'password', placeholder: 'Cloud password', style: INPUT_STYLE });
    var btn   = el('button', { style: BTN_STYLE, text: 'Confirm' });
    var err   = el('p', { style: ERR_STYLE });
    var back  = el('button', { style: LINK_STYLE, text: '\u2190 Change number' });

    input.addEventListener('focus', function () { input.style.borderColor = '#2AABEE'; });
    input.addEventListener('blur', function () { input.style.borderColor = '#2e2e2e'; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    back.addEventListener('click', buildPhoneForm);

    btn.addEventListener('click', function () {
      var pwd = input.value;
      if (!pwd) { err.textContent = 'Enter your password'; err.style.display = 'block'; return; }
      btn.disabled = true; btn.style.opacity = '0.6'; err.style.display = 'none';
      post('/api/auth/tg/verify-2fa', { token: token, password: pwd })
        .then(function () { onAuthSuccess(); })
        .catch(function (e) {
          err.textContent = (e && e.error) || 'Wrong password. Please try again.';
          err.style.display = 'block';
          btn.disabled = false; btn.style.opacity = '1';
          input.value = ''; input.focus();
        });
    });

    [closeBtn, title, hint, input, btn, err, back].forEach(function (c) { cardEl.appendChild(c); });
    setTimeout(function () { input.focus(); }, 80);
  }

  function buildOverlay() {
    injectStyles();
    overlay = el('div', { style: OVERLAY_STYLE });
    cardEl  = el('div', { style: 'position:relative;' + CARD_STYLE });
    overlay.appendChild(cardEl);
    document.body.appendChild(overlay);
    buildPhoneForm();
  }

  function showAuth() {
    if (overlayVisible) return Promise.resolve();
    overlayVisible = true;
    return new Promise(function (resolve) {
      pendingResolvers.push(resolve);
      buildOverlay();
    });
  }

  window.showTelegramAuth = showAuth;

  function init() {
    detectLang(function () { document.documentElement.lang = lang; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 100); });
  } else {
    setTimeout(init, 100);
  }
})();
