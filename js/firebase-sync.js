/* ===================== CLOUD SYNC (Firebase Firestore) =====================
   Design goals (per requirements):
   1) Works fully offline; when connectivity returns (VPN, wifi, mobile data - any
      network path) queued writes are sent automatically. Firestore's SDK persistence
      queue handles this natively - we don't need our own retry loop.
   2) A sync from one device/user can NEVER wipe or overwrite another user's or the
      manager's data. This is guaranteed structurally:
        - Every user, lead, customer and pendingMatch is its own Firestore document
          (collection/{id}), never a single blob document holding everything.
        - All writes use setDoc(ref, data, {merge:true}) on that one document only.
          We never delete or overwrite a whole collection.
        - Deletes are explicit, single-document deletes triggered only by an explicit
          "delete customer" action (admin only) - never implied by a sync/backup.
        - Incoming data from Firestore is merged into localStorage record-by-record
          via DB.upsert*, which itself is last-write-wins PER RECORD using
          `updatedAt`, so two people editing different customers never collide,
          and an older device coming back online cannot stomp newer edits.
================================================================================ */
const CloudSync = (() => {
  // Bump this any time firebase-sync.js changes, and check it in the browser console
  // (`CloudSync.getDebugInfo().build`) to confirm THIS build is actually the one running -
  // this is the fastest way to rule out "stale cached code" vs. "a real sync bug".
  const BUILD = '2026-07-08-auth-retry-and-network-detection-7';
  console.info('[CloudSync] build', BUILD);
  let app = null, db = null, auth = null, ready = false, currentUid = null, persistenceEnabled = false;
  let unsubUsers = null, unsubLeads = null, unsubCustomers = null, unsubPM = null, unsubLC = null, unsubCC = null, unsubSettings = null, unsubTemplates = null, unsubChat = null, unsubAuditLogs = null, unsubLoanProducts = null;
  const COLLECTIONS = { users: 'users', leads: 'leads', customers: 'customers', pendingMatches: 'pendingMatches', leadConflicts: 'leadConflicts', customerConflicts: 'customerConflicts', settings: 'settings', templates: 'templates', chatMessages: 'chatMessages', auditLogs: 'auditLogs', loanProducts: 'loanProducts' };
  const SETTINGS_DOC_ID = 'global';

  // Resolves once the FIRST users-collection snapshot has come back from Firestore (or once
  // we've confirmed sync will never happen - not configured, SDK missing, or auth failed).
  // Login uses this to avoid falsely rejecting a real user's password just because the real
  // user list from Firestore hasn't landed on this (brand-new) device yet.
  let initialSyncDone = false;
  let resolveInitialSync;
  const initialSyncPromise = new Promise((resolve) => { resolveInitialSync = resolve; });
  function markInitialSyncDone() {
    if (initialSyncDone) return;
    initialSyncDone = true;
    resolveInitialSync();
  }
  function hasCompletedInitialSync() { return initialSyncDone; }
  function waitForInitialSync(timeoutMs) {
    if (initialSyncDone) return Promise.resolve();
    return Promise.race([
      initialSyncPromise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs || 6000))
    ]);
  }

  function isConfigured() {
    return typeof firebaseConfig !== 'undefined'
      && firebaseConfig.apiKey && firebaseConfig.apiKey !== 'YOUR_API_KEY';
  }

  /* ===================== DURABLE PENDING-DELETE QUEUE =====================
     Firestore's own IndexedDB persistence is deliberately OFF (see the note in init()
     below), which means an in-flight delete() request that hasn't been ack'd by the
     server yet lives ONLY in memory - if the tab closes or refreshes before the server
     confirms it, the request is gone forever, but the server-side document is still
     there. The next time a listener attaches (e.g. right after that refresh), it will
     hand back that still-existing document, and upsert*() would happily re-add it
     locally - a deleted customer/template/message "coming back from the dead".
     This queue is the exact same protection the previous (Realtime DB) version of this
     app implemented as `mp_pending_sync` in localStorage: record the intent to delete
     BEFORE relying on the network, so it survives a refresh/close, and keep retrying
     (and refusing to let an incoming snapshot resurrect the record) until the server
     actually confirms the delete. ============================================= */
  const PENDING_DELETES_KEY = 'loanCRM_pendingCloudDeletes';
  function loadPendingDeletes() {
    try { return JSON.parse(localStorage.getItem(PENDING_DELETES_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function savePendingDeletes(obj) {
    try { localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(obj)); } catch (e) { /* ignore quota errors */ }
  }
  function markPendingDelete(collectionName, id) {
    const p = loadPendingDeletes();
    p[collectionName] = p[collectionName] || {};
    const isNew = !p[collectionName][id];
    p[collectionName][id] = true;
    savePendingDeletes(p);
    console.info('[CloudSync] marked pending delete:', collectionName, id);
    return isNew;
  }
  function clearPendingDelete(collectionName, id) {
    const p = loadPendingDeletes();
    if (p[collectionName]) { delete p[collectionName][id]; savePendingDeletes(p); }
    console.info('[CloudSync] cleared pending delete (server confirmed):', collectionName, id);
  }
  function isPendingDelete(collectionName, id) {
    const p = loadPendingDeletes();
    return !!(p[collectionName] && p[collectionName][id]);
  }
  function countPendingDeletes() {
    const p = loadPendingDeletes();
    return Object.keys(p).reduce((sum, col) => sum + Object.keys(p[col] || {}).length, 0);
  }
  // Sends (or re-sends) a single delete. Recorded as pending BEFORE this is ever called,
  // so callers never need to call markPendingDelete themselves first.
  // isNewAction: true only when this call originates from a fresh user action (delete
  // button pressed just now) - NOT from a periodic/init/online retry of an already-queued
  // delete. Keeps the "queued for sending" toast from repeating every retry cycle.
  function sendDelete(collectionName, id, isNewAction) {
    if (!ready) {
      console.warn('[CloudSync] sendDelete skipped - not ready/signed in yet:', collectionName, id);
      if (isNewAction) noteChangeQueued();
      return Promise.resolve({ ok: false, reason: 'offline' });
    }
    console.info('[CloudSync] sending delete to Firestore:', collectionName, id);
    // See WRITE_STALL_MS note above sendPush(): a plain network/VPN drop does NOT reject
    // this promise - it just sits pending until reconnected. This timer is what actually
    // surfaces "queued"/"connection lost" for that (by far the most common) case.
    let settled = false;
    const stallTimer = setTimeout(() => { if (!settled) flagStalled(isNewAction); }, WRITE_STALL_MS);
    return db.collection(collectionName).doc(id).delete()
      .then(() => { settled = true; clearTimeout(stallTimer); console.info('[CloudSync] delete CONFIRMED by server:', collectionName, id); clearPendingDelete(collectionName, id); markConnected(); noteQueueMaybeFlushed(); return { ok: true }; })
      .catch((err) => {
        settled = true; clearTimeout(stallTimer);
        console.error('[CloudSync] delete FAILED:', collectionName, id, err);
        const isTransient = logWriteErr(err);
        if (isTransient) {
          if (isNewAction) noteChangeQueued();
          scheduleConnectionLostBanner();
        }
        return { ok: false, reason: err && err.code || 'error' };
      });
  }
  // Retries every delete still recorded as pending (e.g. left over from a session that
  // closed before the server could confirm). Called on init, on 'online', and periodically.
  function retryPendingDeletes() {
    if (!ready) return;
    const p = loadPendingDeletes();
    Object.keys(p).forEach((collectionName) => {
      Object.keys(p[collectionName] || {}).forEach((id) => { sendDelete(collectionName, id); });
    });
  }

  /* ===================== DURABLE PENDING-PUSH QUEUE =====================
     Same problem as pending deletes, but for ordinary writes (create/update).
     pushUser/pushLead/pushCustomer/etc. used to call db.collection(...).set() directly
     and rely ENTIRELY on the Firestore SDK's in-memory retry queue to redeliver it once
     back online. That in-memory queue lives only inside the current page/app instance -
     since Firestore's own IndexedDB persistence is deliberately OFF (see note in init()),
     nothing survives a tab close, page refresh, or the OS killing a backgrounded PWA.
     Concretely: a record created/edited while offline synced ONLY if the exact same page
     load stayed open uninterrupted until the network came back - which matched the
     reported symptom (sync only works if the network happens to be up "at that moment").
     If the app was closed/reopened (very common for a mobile PWA on a flaky VPN) before
     reconnecting, the write was silently lost forever - even though the record is still
     sitting correctly in localStorage - because queueFullFlush() only ever re-uploads
     the ENTIRE local dataset once per device, never again (that guard exists on purpose,
     to avoid resurrecting records deleted by someone else - see its comment above).
     Fix: record the intent to push (collection + id + the exact payload) synchronously to
     localStorage BEFORE attempting the network call, just like markPendingDelete already
     does. Retry every still-pending push on init(), on 'online', and periodically - so a
     write made offline keeps trying across as many app restarts as it takes, until the
     server actually confirms it. */
  const PENDING_PUSHES_KEY = 'loanCRM_pendingCloudPushes';
  function loadPendingPushes() {
    try { return JSON.parse(localStorage.getItem(PENDING_PUSHES_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function savePendingPushes(obj) {
    try { localStorage.setItem(PENDING_PUSHES_KEY, JSON.stringify(obj)); } catch (e) { /* ignore quota errors */ }
  }
  // Storing the payload itself (not just the id) means a retry never needs to reach back
  // into DB.load() to figure out "what was the data" - it just resends exactly what was
  // last pushed. Calling this again for the same id simply overwrites with the newest
  // data, so if the record is edited again before the first push ever succeeds, the retry
  // naturally sends the LATEST version, not a stale one.
  function markPendingPush(collectionName, id, data) {
    const p = loadPendingPushes();
    p[collectionName] = p[collectionName] || {};
    const isNew = !(id in p[collectionName]);
    p[collectionName][id] = data;
    savePendingPushes(p);
    return isNew;
  }
  function clearPendingPush(collectionName, id) {
    const p = loadPendingPushes();
    if (p[collectionName]) { delete p[collectionName][id]; savePendingPushes(p); }
  }
  function countPendingPushes() {
    const p = loadPendingPushes();
    return Object.keys(p).reduce((sum, col) => sum + Object.keys(p[col] || {}).length, 0);
  }
  // Every ordinary write goes through here: mark as pending FIRST (survives a close before
  // the server ever replies), then attempt the network call, then clear only once Firestore
  // has actually confirmed it. `isNewlyQueued` tells us this id wasn't already sitting in
  // the pending queue - i.e. this is a genuinely new change, not a periodic retry of one
  // we already told the user about - so the "queued" toast doesn't repeat every retry cycle.
  // How long a write is allowed to sit unconfirmed before we treat that, by itself, as
  // live proof the connection is down right now. This is NOT an error-retry timeout (the
  // real write below keeps trying in the background regardless) - it exists purely to
  // drive the UI. It matters because on a plain network/VPN drop, Firestore's write
  // promise does not reject: it just stays pending silently until connectivity returns.
  // Without this timer, a mid-session VPN drop would never show the "در صف ارسال" badge
  // or the "اتصال قطع است" banner - both only ever fired for an actual rejected promise
  // (permission-denied, etc.), which a routine connectivity blip never produces.
  const WRITE_STALL_MS = 6000;
  function sendPush(collectionName, id, data) {
    const isNewlyQueued = markPendingPush(collectionName, id, data);
    if (!ready) {
      if (isNewlyQueued) noteChangeQueued();
      return Promise.resolve({ ok: false, reason: 'offline' });
    }
    let settled = false;
    const stallTimer = setTimeout(() => { if (!settled) flagStalled(isNewlyQueued); }, WRITE_STALL_MS);
    return db.collection(collectionName).doc(id).set(data, { merge: true })
      .then(() => { settled = true; clearTimeout(stallTimer); clearPendingPush(collectionName, id); markConnected(); noteQueueMaybeFlushed(); return { ok: true }; })
      .catch((err) => {
        settled = true; clearTimeout(stallTimer);
        const isTransient = logWriteErr(err);
        if (isTransient) {
          if (isNewlyQueued) noteChangeQueued();
          scheduleConnectionLostBanner();
        }
        return { ok: false, reason: err && err.code || 'error' };
      });
  }
  // Called on init, on 'online', and periodically - resends every write that hasn't been
  // confirmed by the server yet, exactly like retryPendingDeletes() does for deletes.
  function retryPendingPushes() {
    if (!ready) return;
    const p = loadPendingPushes();
    Object.keys(p).forEach((collectionName) => {
      Object.keys(p[collectionName] || {}).forEach((id) => { sendPush(collectionName, id, p[collectionName][id]); });
    });
  }

  function isReady() { return ready; }

  // For diagnosing sync issues without needing to read source code: open the browser
  // console (F12) and run  CloudSync.getDebugInfo()
  function getDebugInfo() {
    return {
      build: BUILD,
      configured: isConfigured(),
      firebaseSdkLoaded: typeof firebase !== 'undefined',
      ready,
      persistenceEnabled,
      signedInUid: currentUid,
      initialSyncDone,
      pendingDeletes: countPendingDeletes(),
      pendingDeleteDetail: loadPendingDeletes(),
      pendingPushes: countPendingPushes(),
      pendingPushDetail: loadPendingPushes()
    };
  }

  function updateStatusBadge(text, cls) {
    const el = document.getElementById('sync-status');
    if (el) { el.textContent = text; el.title = text; el.dataset.full = text; el.className = 'sync-badge ' + (cls || ''); }
    // Any time we can confidently report "on" (connected/synced), that's also proof the
    // internet/VPN path to Firestore is actually up right now - clear the big banner too.
    if (cls === 'on') markConnected();
  }

  /* ===================== CONNECTION-LOST BANNER =====================
     A small badge in the topbar is easy to miss, especially on a flaky office VPN where
     Firestore access can silently stop working. This shows a hard-to-miss banner across
     the top of the screen whenever the connection appears to be down, and hides it again
     the moment we're confidently back online. A single brief blip doesn't show it -
     only a problem that persists a few seconds does, to avoid flashing on/off constantly. */
  let connectionLostTimer = null;
  let bannerVisible = false;
  function showConnectionBanner(message) {
    const el = document.getElementById('connection-banner');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    bannerVisible = true;
  }
  function hideConnectionBanner() {
    const el = document.getElementById('connection-banner');
    if (el) el.classList.add('hidden');
    bannerVisible = false;
  }
  // Call on any confirmed sign of life (successful snapshot, browser 'online' event).
  function markConnected() {
    if (connectionLostTimer) { clearTimeout(connectionLostTimer); connectionLostTimer = null; }
    if (bannerVisible) hideConnectionBanner();
  }
  // Call on any sign the connection might be down (listener/write error, browser
  // 'offline' event). Debounced 4s so a single temporary blip doesn't flash the banner.
  function scheduleConnectionLostBanner() {
    if (bannerVisible || connectionLostTimer) return;
    connectionLostTimer = setTimeout(() => {
      connectionLostTimer = null;
      showConnectionBanner('📴 اتصال اینترنت/VPN قطع است — تغییرات به‌صورت محلی ذخیره می‌شوند و به‌محض اتصال مجدد به‌طور خودکار ارسال خواهند شد.');
    }, 4000);
  }
  // A real browser 'offline' event is a strong, immediate signal - no need to debounce it.
  function showConnectionBannerNow() {
    if (connectionLostTimer) { clearTimeout(connectionLostTimer); connectionLostTimer = null; }
    showConnectionBanner('📴 اتصال اینترنت/VPN قطع است — تغییرات به‌صورت محلی ذخیره می‌شوند و به‌محض اتصال مجدد به‌طور خودکار ارسال خواهند شد.');
  }

  /* ===================== "QUEUED FOR SENDING" NOTICE =====================
     Whenever a change is made while we can't reach the server right now, tell the user
     clearly that it was saved locally and is queued to send - not lost. Only fires when
     the write is genuinely queued (not on the normal instant-confirm happy path), and
     the follow-up "sent successfully" toast only fires if we'd actually shown
     the queued notice before, so a healthy connection stays silent as before. */
  let pendingNoticeShown = false;
  function noteChangeQueued() {
    pendingNoticeShown = true;
    const total = countPendingPushes() + countPendingDeletes();
    updateStatusBadge(`📦 در صف ارسال (${total} مورد در انتظار)`, 'off');
    if (typeof toast === 'function') {
      toast('این تغییر ذخیره شد و در صف ارسال به سرور قرار گرفت.', 'warn');
    }
  }
  // Called when a write's WRITE_STALL_MS timer fires - i.e. we're not sure yet whether
  // this is a real error, just that the server hasn't confirmed in a normal amount of
  // time. Unlike noteChangeQueued() this doesn't pop a toast every time (a flaky
  // connection could fire this repeatedly for many in-flight writes); it just keeps the
  // badge and banner honest. If the write later fails outright, noteChangeQueued() still
  // runs normally and shows the one-time toast.
  function flagStalled(isNewlyQueued) {
    pendingNoticeShown = pendingNoticeShown || isNewlyQueued;
    const total = countPendingPushes() + countPendingDeletes();
    if (total > 0) updateStatusBadge(`📦 در صف ارسال (${total} مورد در انتظار)`, 'off');
    scheduleConnectionLostBanner();
  }
  // Called after a push/delete is confirmed by the server - if the queue has fully
  // drained AND we'd previously told the user something was queued, let them know it
  // went through.
  function noteQueueMaybeFlushed() {
    const total = countPendingPushes() + countPendingDeletes();
    if (total > 0) return;
    if (pendingNoticeShown) {
      pendingNoticeShown = false;
      if (typeof toast === 'function') toast('تغییرات در صف با موفقیت به سرور ارسال شد.', 'success');
    }
    if (ready) updateStatusBadge('☁️ متصل — همه تغییرات ارسال شد', 'on');
  }

  // ===================== HEARTBEAT (idle connection check) =====================
  // Everything above only reacts when the USER does something (a write stalls, a
  // listener errors). If nobody touches the app for a while on a dead VPN, none of that
  // fires and the banner never appears even though sync is, in fact, dead. This actively
  // probes the server on a timer regardless of user activity, using the same
  // "no response within N seconds = treat as down" logic as the write-stall timer, since
  // a hung request here (get() from a genuinely offline client) also won't reject.
  const HEARTBEAT_INTERVAL_MS = 15000;
  const HEARTBEAT_TIMEOUT_MS = 7000;
  function heartbeatOnce() {
    if (!ready) return;
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; scheduleConnectionLostBanner(); } }, HEARTBEAT_TIMEOUT_MS);
    db.collection(COLLECTIONS.settings).doc(SETTINGS_DOC_ID).get({ source: 'server' })
      .then(() => { if (!done) { done = true; clearTimeout(to); markConnected(); } })
      .catch(() => { if (!done) { done = true; clearTimeout(to); scheduleConnectionLostBanner(); } });
  }
  function startHeartbeat() { setInterval(heartbeatOnce, HEARTBEAT_INTERVAL_MS); }

  // Registered exactly once, on the very first call to init(), regardless of whether that
  // first attempt succeeds. Previously these were only registered AFTER a successful
  // connection - so if the app was opened while VPN/internet was already down, the first
  // signInAnonymously() call failed, init() returned early, and 'online'/'offline' were
  // never wired up at all. The app then had no way to notice VPN coming back later; only
  // a manual page refresh fixed it. Now 'online' always retries init() when not ready yet.
  let globalListenersAttached = false;
  function attachGlobalNetworkListeners() {
    if (globalListenersAttached) return;
    globalListenersAttached = true;
    window.addEventListener('online', () => {
      if (!ready) { init(); return; }
      updateStatusBadge('☁️ آنلاین — در حال ارسال تغییرات', 'on');
      retryPendingDeletes(); retryPendingPushes();
    });
    window.addEventListener('offline', () => { updateStatusBadge('📴 آفلاین — تغییرات پس از اتصال ارسال می‌شود', 'off'); showConnectionBannerNow(); });
  }

  // How long to wait before automatically retrying a failed initial connection (auth or
  // Firestore setup). Without this, a single failure at page-load time (VPN off the
  // moment the app was opened) would leave the app permanently disconnected until the
  // user manually refreshes - even though nothing is actually wrong once VPN comes back.
  const INIT_RETRY_MS = 8000;
  let initRetryTimer = null;
  function scheduleInitRetry() {
    if (initRetryTimer) return;
    initRetryTimer = setTimeout(() => { initRetryTimer = null; if (!ready) init(); }, INIT_RETRY_MS);
  }

  async function init() {
    attachGlobalNetworkListeners();
    if (!isConfigured()) { updateStatusBadge('☁️ همگام‌سازی ابری تنظیم نشده', 'off'); markInitialSyncDone(); return; }
    if (typeof firebase === 'undefined') { updateStatusBadge('☁️ کتابخانه Firebase بارگذاری نشد', 'off'); markInitialSyncDone(); return; }
    try {
      // Guard against re-initializing the Firebase app object on a retry (calling
      // initializeApp twice throws "Firebase App named '[DEFAULT]' already exists").
      if (!app) {
        app = firebase.apps && firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        auth = firebase.auth();

        // ===================== App Check =====================
        // جلوی درخواست‌های Firestore که از خارج همین صفحه‌ی وب (اسکریپت/بات/curl
        // با استفاده از همین apiKey عمومی) می‌آیند را می‌گیرد. برای فعال شدنِ
        // واقعیِ این محافظت باید در Firebase Console یک reCAPTCHA v3 site key
        // بسازید و «Enforce» را برای Firestore در بخش App Check روشن کنید - تا
        // وقتی این کار را نکرده‌اید وجود این کد بی‌ضرر است (فقط token اضافه
        // می‌کند) اما هیچ محدودیتی اعمال نمی‌شود. راهنمای کامل در README.md.
        try {
          if (typeof firebase.appCheck === 'function'
              && typeof RECAPTCHA_V3_SITE_KEY !== 'undefined'
              && RECAPTCHA_V3_SITE_KEY && RECAPTCHA_V3_SITE_KEY !== 'YOUR_RECAPTCHA_V3_SITE_KEY') {
            firebase.appCheck().activate(RECAPTCHA_V3_SITE_KEY, true);
          }
        } catch (appCheckErr) {
          console.warn('[CloudSync] App Check init skipped/failed (non-fatal):', appCheckErr);
        }
      }

      // NOTE: we deliberately do NOT enable Firestore's own IndexedDB persistence
      // (db.enablePersistence()) here. This app already has its own independent, working
      // offline-first cache: everything lives in localStorage via DB.js, with proper
      // last-write-wins merge logic per record (see DB.upsert*). Firestore's own on-disk
      // cache is a SECOND, separate cache layer on top of that - and it can go stale
      // between tab/page sessions (especially in multi-tab mode). A fresh listener
      // reattaching after a page refresh was sometimes being served an outdated snapshot
      // from that on-disk cache instead of the true current server state - which is exactly
      // what made deleted customers "come back" after a refresh. Without it, every listener
      // always reads live from the server, which is slightly slower on a cold reconnect but
      // cannot serve stale data.
      persistenceEnabled = false;

      // IMPORTANT: previously this resolved as "signed in" even when signInAnonymously()
      // failed (e.g. Anonymous sign-in disabled in Firebase Console) - the app would then
      // claim to be "connected" and attach Firestore listeners with NO valid auth, which
      // silently fail forever against rules that require request.auth != null. Now a failed
      // sign-in is treated as a real connection failure, not a false "success". We also keep
      // the actual error, so we can tell "no internet/VPN" apart from "really misconfigured"
      // instead of always blaming Firebase Console config.
      const signInResult = await new Promise((resolve) => {
        auth.onAuthStateChanged((user) => {
          if (user) { resolve({ user }); }
          else {
            auth.signInAnonymously()
              .then((cred) => resolve({ user: cred.user }))
              .catch((err) => { console.warn('Firebase anonymous auth failed', err); resolve({ user: null, err }); });
          }
        });
      });

      if (!signInResult.user) {
        const err = signInResult.err;
        // 'auth/network-request-failed' (and similar) means the request never even
        // reached Google - i.e. no internet/VPN path right now. That's a connectivity
        // problem, not a Firebase Console misconfiguration, so say so and keep retrying.
        // Anything else (e.g. anonymous sign-in genuinely disabled) is a real config
        // problem that a retry won't fix, but we still retry harmlessly in case it gets
        // fixed remotely - it just won't spam the user, since the badge text stays put.
        const isNetworkErr = !err || err.code === 'auth/network-request-failed' || err.code === 'auth/timeout' || err.code === 'unavailable';
        if (isNetworkErr) {
          updateStatusBadge('📴 اتصال اینترنت/VPN برقرار نیست — به محض اتصال مجدد، ورود ابری خودکار انجام می‌شود', 'off');
          showConnectionBannerNow();
        } else {
          updateStatusBadge('☁️ ورود ناشناس ناموفق بود (در Firebase Console → Authentication → Sign-in method → Anonymous را فعال کنید)', 'off');
        }
        markInitialSyncDone();
        scheduleInitRetry();
        return;
      }

      currentUid = signInResult.user.uid;
      ready = true;
      updateStatusBadge('☁️ متصل — در حال دریافت اطلاعات...', 'on');
      markConnected();
      attachListeners();
      // Catches any delete that was recorded as pending in a previous session but never
      // got confirmed (e.g. the tab was closed before the server replied). The resurrection
      // guards inside the onSnapshot handlers above will also catch this reactively as soon
      // as a snapshot for that document arrives, but this covers it immediately too.
      retryPendingDeletes();
      retryPendingPushes();
      // IMPORTANT: this used to run on EVERY init() (i.e. every single page load/refresh on
      // every device), which re-pushed this device's ENTIRE local dataset - including any
      // record this device still had locally that had since been deleted by someone else on
      // another device. Because pushes use set(...,{merge:true}), that silently RECREATED the
      // deleted document in Firestore the moment this device's page was reopened, even though
      // nothing was actually edited. It's only genuinely needed once, to upload data that was
      // created locally before cloud sync ever connected for the first time on this device -
      // every ordinary edit afterwards is already pushed individually by pushUser/pushLead/
      // pushCustomer/etc. at the moment it happens, so a repeat full flush isn't needed and is
      // actively harmful.
      const FLUSH_ONCE_KEY = 'loanCRM_didInitialCloudFlush';
      if (!localStorage.getItem(FLUSH_ONCE_KEY)) {
        queueFullFlush();
        try { localStorage.setItem(FLUSH_ONCE_KEY, '1'); } catch (e) { /* ignore quota errors */ }
      }

      startHeartbeat();
      // Belt-and-suspenders: also retry every 20s while any delete/push is still
      // unconfirmed, in case neither 'online' nor a fresh snapshot fires for a while
      // (e.g. a flaky VPN that never fully drops but also never quite reconnects cleanly).
      setInterval(() => { if (ready && (countPendingDeletes() > 0 || countPendingPushes() > 0)) { retryPendingDeletes(); retryPendingPushes(); } }, 20000);
    } catch (err) {
      console.warn('CloudSync init failed', err);
      updateStatusBadge('☁️ خطا در اتصال ابری (آفلاین کار می‌کند)', 'off');
      markInitialSyncDone();
      scheduleInitRetry();
    }
  }

  function attachListeners() {
    if (unsubUsers) unsubUsers();
    if (unsubLeads) unsubLeads();
    if (unsubCustomers) unsubCustomers();
    if (unsubPM) unsubPM();
    if (unsubLC) unsubLC();
    if (unsubCC) unsubCC();
    if (unsubSettings) unsubSettings();
    if (unsubTemplates) unsubTemplates();
    if (unsubChat) unsubChat();

    unsubUsers = db.collection(COLLECTIONS.users).onSnapshot((snap) => {
      const incomingUsers = snap.docs.map((d) => d.data());
      console.info('[CloudSync][users] snapshot arrived — count:', incomingUsers.length, 'ids:', incomingUsers.map(u => u.id + '(' + (u.username || '?') + ')'));
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') { console.info('[CloudSync][users] removed:', change.doc.id); clearPendingDelete(COLLECTIONS.users, change.doc.id); DB.removeUserLocal(change.doc.id, { skipCloud: true }); return; }
        if (isPendingDelete(COLLECTIONS.users, change.doc.id)) { console.warn('[CloudSync] server still has a user we deleted locally - re-sending delete instead of resurrecting it:', change.doc.id); sendDelete(COLLECTIONS.users, change.doc.id); return; }
        const userData = change.doc.data();
        console.info('[CloudSync][users] upsert:', userData.id, '(' + (userData.username || '?') + ', role=' + (userData.role || '?') + ', isSeedDefault=' + (userData.isSeedDefault === true) + ')');
        DB.upsertUser(userData, { skipCloud: true });
      });
      const localUsersBefore = DB.getUsers();
      console.info('[CloudSync][users] local users after upsert:', localUsersBefore.length, localUsersBefore.map(u => u.id + '(' + (u.username || '?') + ', seed=' + (u.isSeedDefault === true) + ')'));
      if (typeof DB.removeSeedDefaultAdminIfSuperseded === 'function') {
        DB.removeSeedDefaultAdminIfSuperseded(incomingUsers);
      }
      const localUsersAfter = DB.getUsers();
      console.info('[CloudSync][users] local users after removeSeedDefault:', localUsersAfter.length, localUsersAfter.map(u => u.id + '(' + (u.username || '?') + ')'));
      if (typeof DB.deduplicateCloudAdmins === 'function') {
        const toDelete = DB.deduplicateCloudAdmins(incomingUsers);
        if (toDelete.length) {
          console.info('[CloudSync] auto-cleaning', toDelete.length, 'duplicate admin(s) from cloud:', toDelete.map(d => d.id));
          toDelete.forEach(dup => {
            DB.removeUserLocal(dup.id, { skipCloud: true });
            sendDelete(COLLECTIONS.users, dup.id);
          });
        }
      }
      const localUsersFinal = DB.getUsers();
      const sessionId = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('loanCRM_session') : null;
      console.info('[CloudSync][users] FINAL local users:', localUsersFinal.length, '| session:', sessionId, '| session user exists:', !!localUsersFinal.find(u => u.id === sessionId));
      updateStatusBadge('☁️ متصل — همگام‌سازی فعال', 'on');
      markInitialSyncDone();
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('users', err));

    unsubLeads = db.collection(COLLECTIONS.leads).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') { clearPendingDelete(COLLECTIONS.leads, change.doc.id); DB.removeLeadLocal(change.doc.id, { skipCloud: true }); return; }
        // Same resurrection guard as customers/users below: if we already deleted this lead
        // locally and are still waiting for server confirmation, don't bring it back just
        // because the server still (briefly) has the old document - re-send the delete.
        if (isPendingDelete(COLLECTIONS.leads, change.doc.id)) { console.warn('[CloudSync] server still has a lead we deleted locally - re-sending delete instead of resurrecting it:', change.doc.id); sendDelete(COLLECTIONS.leads, change.doc.id); return; }
        DB.upsertLead(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('leads', err));

    unsubCustomers = db.collection(COLLECTIONS.customers).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') { clearPendingDelete(COLLECTIONS.customers, change.doc.id); DB.removeCustomerLocal(change.doc.id, { skipCloud: true }); return; }
        // The server is telling us this document still exists, but we already deleted it
        // locally and are still waiting for that delete to be confirmed (see the pending
        // delete queue above) - do NOT resurrect it locally; just re-send the delete.
        if (isPendingDelete(COLLECTIONS.customers, change.doc.id)) { console.warn('[CloudSync] server still has a customer we deleted locally - re-sending delete instead of resurrecting it:', change.doc.id); sendDelete(COLLECTIONS.customers, change.doc.id); return; }
        DB.upsertCustomer(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('customers', err));

    unsubPM = db.collection(COLLECTIONS.pendingMatches).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') return;
        DB.upsertPendingMatch(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('pendingMatches', err));

    // lead<->lead duplicate warnings (see addLead() in db.js) - same simple upsert pattern
    // as pendingMatches; these are never deleted, only marked resolved.
    unsubLC = db.collection(COLLECTIONS.leadConflicts).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') return;
        DB.upsertLeadConflict(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('leadConflicts', err));

    // customer<->customer duplicate warnings (see addCustomer() in db.js) - same simple
    // upsert pattern as leadConflicts/pendingMatches; these are never deleted, only marked
    // resolved.
    unsubCC = db.collection(COLLECTIONS.customerConflicts).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') return;
        DB.upsertCustomerConflict(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('customerConflicts', err));

    // single shared document holding global commission settings
    unsubSettings = db.collection(COLLECTIONS.settings).doc(SETTINGS_DOC_ID).onSnapshot((doc) => {
      if (doc.exists) DB.upsertSettings(doc.data(), { skipCloud: true });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('settings', err));

    unsubTemplates = db.collection(COLLECTIONS.templates).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') { clearPendingDelete(COLLECTIONS.templates, change.doc.id); DB.removeTemplateLocal(change.doc.id, { skipCloud: true }); return; }
        if (isPendingDelete(COLLECTIONS.templates, change.doc.id)) { sendDelete(COLLECTIONS.templates, change.doc.id); return; }
        DB.upsertTemplate(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('templates', err));

    // group chat: messages are append-only, so upsert = "add if new"
    unsubChat = db.collection(COLLECTIONS.chatMessages).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') { clearPendingDelete(COLLECTIONS.chatMessages, change.doc.id); DB.removeChatMessageLocal(change.doc.id, { skipCloud: true }); return; }
        if (isPendingDelete(COLLECTIONS.chatMessages, change.doc.id)) { sendDelete(COLLECTIONS.chatMessages, change.doc.id); return; }
        DB.upsertChatMessage(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('chatMessages', err));

    // Audit log: append-only everywhere (locally, in Firestore Rules, and here) - same
    // "add if new" upsert pattern as chat messages, never edited/removed once written.
    unsubAuditLogs = db.collection(COLLECTIONS.auditLogs).onSnapshot((snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') return; // rules block deletes anyway; ignore defensively
        DB.upsertAuditLog(change.doc.data(), { skipCloud: true });
      });
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('auditLogs', err));

    // Loan products (admin-defined loan calculators). Same per-document upsert pattern as
    // templates/customers - a sync from one admin device can never wipe another's product.
    unsubLoanProducts = db.collection(COLLECTIONS.loanProducts).onSnapshot((snap) => {
      const incomingProducts = snap.docs.map((d) => d.data());
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') { clearPendingDelete(COLLECTIONS.loanProducts, change.doc.id); DB.removeLoanProductLocal(change.doc.id, { skipCloud: true }); return; }
        if (isPendingDelete(COLLECTIONS.loanProducts, change.doc.id)) { console.warn('[CloudSync] server still has a loan product we deleted locally - re-sending delete instead of resurrecting it:', change.doc.id); sendDelete(COLLECTIONS.loanProducts, change.doc.id); return; }
        DB.upsertLoanProduct(change.doc.data(), { skipCloud: true });
      });
      // Drop the local seed-default loan product if the cloud already has real products,
      // so multiple devices don't create duplicates of the "بانک مهر ایران" seed example.
      if (typeof DB.removeSeedDefaultLoanProductIfSuperseded === 'function') {
        DB.removeSeedDefaultLoanProductIfSuperseded(incomingProducts);
      }
      // Auto-cleanup: if the cloud has DUPLICATE loan products with the same bankName +
      // schemeName (which happened before the isSeedDefault guard was added — seed products
      // got pushed to Firestore from multiple devices), automatically delete the older
      // duplicates and keep only the newest one. Same pattern as deduplicateCloudAdmins.
      if (typeof DB.deduplicateCloudLoanProducts === 'function') {
        const toDelete = DB.deduplicateCloudLoanProducts(incomingProducts);
        if (toDelete.length) {
          console.info('[CloudSync] auto-cleaning', toDelete.length, 'duplicate loan product(s) from cloud:', toDelete.map(d => d.id));
          toDelete.forEach(dup => {
            DB.removeLoanProductLocal(dup.id, { skipCloud: true });
            sendDelete(COLLECTIONS.loanProducts, dup.id);
          });
        }
      }
      markConnected(); if (typeof onCloudDataChanged === 'function') onCloudDataChanged();
    }, (err) => onListenerError('loanProducts', err));
  }

  // Each push touches exactly ONE document, merged - never a collection-level write.
  // Routed through sendPush() so the write is remembered in localStorage BEFORE it's
  // attempted, and automatically retried (even across app restarts) until confirmed -
  // see the DURABLE PENDING-PUSH QUEUE note above.
  function pushUser(user) {
    // CRITICAL: never push a seed-default admin to the cloud. The seed admin is a per-device
    // placeholder created automatically when a brand-new device opens the app; pushing it
    // would create a duplicate "admin" document in Firestore that every other device would
    // then pull down. This is a belt-and-suspenders check — db.js also guards this in
    // authenticate() and queueFullFlush — but having it here too means even a future code
    // path that forgets to check isSeedDefault can't accidentally push a seed.
    if (user && user.isSeedDefault) {
      console.warn('[CloudSync] refused to push seed-default admin to cloud:', user.id);
      return;
    }
    sendPush(COLLECTIONS.users, user.id, user);
  }
  function deleteUser(id) {
    markPendingDelete(COLLECTIONS.users, id);
    return sendDelete(COLLECTIONS.users, id, true);
  }
  function pushLead(lead) { sendPush(COLLECTIONS.leads, lead.id, lead); }
  function deleteLead(id) {
    markPendingDelete(COLLECTIONS.leads, id);
    return sendDelete(COLLECTIONS.leads, id, true);
  }
  function pushCustomer(customer) { sendPush(COLLECTIONS.customers, customer.id, customer); }
  function pushPendingMatch(pm) { sendPush(COLLECTIONS.pendingMatches, pm.id, pm); }
  function pushLeadConflict(lc) { sendPush(COLLECTIONS.leadConflicts, lc.id, lc); }
  function pushCustomerConflict(cc) { sendPush(COLLECTIONS.customerConflicts, cc.id, cc); }
  // Every delete is recorded in the durable pending-delete queue FIRST (synchronously,
  // to localStorage) and only then sent to Firestore. This means the *intent* to delete
  // survives even if the tab closes/refreshes before the server acknowledges it - the next
  // time this device is online, retryPendingDeletes() (and the resurrection guards in the
  // onSnapshot handlers above) make sure the delete actually completes instead of the
  // document silently reappearing. Still returns the delete promise too, for callers that
  // want to wait for real server confirmation before telling the user "deleted".
  function deleteCustomer(id) {
    markPendingDelete(COLLECTIONS.customers, id);
    return sendDelete(COLLECTIONS.customers, id, true);
  }
  function pushSettings(settings) { sendPush(COLLECTIONS.settings, SETTINGS_DOC_ID, settings); }
  // NOTE: templates can carry a base64 image/audio payload - Firestore documents are
  // capped at ~1MB, so very large media may fail to sync (logWriteErr just logs it,
  // the record still works fine locally on the device that created it). That failure is
  // permanent (see logWriteErr's isTooLarge check) so it's still worth NOT leaving it in
  // the pending-push queue forever; logWriteErr already surfaces it to the user, and the
  // next retry attempt will simply fail the same way again without harm.
  function pushTemplate(tpl) { sendPush(COLLECTIONS.templates, tpl.id, tpl); }
  function deleteTemplate(id) {
    markPendingDelete(COLLECTIONS.templates, id);
    return sendDelete(COLLECTIONS.templates, id, true);
  }
  // Chat messages are immutable once sent - merge:true is harmless here too, and delete
  // is only ever explicit (admin moderation), never implied by a sync/backup.
  function pushChatMessage(msg) { sendPush(COLLECTIONS.chatMessages, msg.id, msg); }
  function deleteChatMessage(id) {
    markPendingDelete(COLLECTIONS.chatMessages, id);
    return sendDelete(COLLECTIONS.chatMessages, id, true);
  }
  // Audit log entries are never deleted - intentionally no deleteAuditLog() function, and
  // firestore.rules also hard-blocks update/delete on this collection server-side.
  function pushAuditLog(entry) { sendPush(COLLECTIONS.auditLogs, entry.id, entry); }
  // Loan products are admin-defined and editable; same push/delete pattern as templates.
  function pushLoanProduct(p) {
    // CRITICAL: never push a seed-default loan product to the cloud. Same guard as pushUser.
    if (p && p.isSeedDefault) {
      console.warn('[CloudSync] refused to push seed-default loan product to cloud:', p.id);
      return;
    }
    sendPush(COLLECTIONS.loanProducts, p.id, p);
  }
  function deleteLoanProduct(id) {
    markPendingDelete(COLLECTIONS.loanProducts, id);
    return sendDelete(COLLECTIONS.loanProducts, id, true);
  }

  // A listener that fails once (offline, temporary network blip) will recover on its own -
  // Firestore's SDK retries automatically. But 'permission-denied' will NEVER recover on its
  // own (wrong/unpublished rules, or auth not actually valid) and previously was only ever
  // logged to the console, so the office could go for weeks thinking sync was fine while
  // nothing was ever actually being read or written. Surface that specific case clearly.
  let permissionErrorShown = false;
  function onListenerError(name, err) {
    if (err && err.code === 'permission-denied') {
      if (!permissionErrorShown) {
        permissionErrorShown = true;
        updateStatusBadge('⛔ دسترسی ابری رد شد (Firestore Rules را بررسی کنید)', 'off');
        if (typeof toast === 'function') {
          toast('همگام‌سازی ابری کار نمی‌کند: دسترسی رد شد. لطفاً در Firebase Console بررسی کنید که Rules فایل firestore.rules واقعاً Publish شده باشد.', 'error');
        }
      }
      console.warn(name + ' listener error (permission-denied - will not self-recover):', err);
    } else {
      // genuinely transient (offline, unavailable, etc.) - Firestore reconnects/retries on its own,
      // but it's exactly the "VPN dropped" case the office runs into, so surface it via the banner.
      console.info(name + ' listener temporarily unavailable (will retry automatically):', err.code || err.message);
      scheduleConnectionLostBanner();
    }
    // Either way, don't leave login waiting forever for data that may never arrive.
    markInitialSyncDone();
  }

  // Returns true if the failure is transient/network-related (worth telling the user
  // "queued, will retry"), false if it's a permanent failure (too-large / permission)
  // that logWriteErr already surfaced its own specific, more accurate message for.
  function logWriteErr(err) {
    // Firestore documents are capped at ~1MB. A record carrying one or more
    // base64-encoded images (contract/receipt photos, template attachments, etc.) can
    // exceed that even after client-side compression. That specific failure is NOT
    // transient (unlike being offline) - it will never succeed on retry, so unlike a
    // normal offline queue, we surface it to the user instead of only logging it.
    const msg = String(err && (err.message || err.code) || '');
    const isTooLarge = err && (err.code === 'invalid-argument') && /larger than|too large|exceeds the maximum/i.test(msg);
    if (isTooLarge) {
      updateStatusBadge('⚠️ برخی تصاویر حجیم‌اند و به ابر همگام‌سازی نشدند', 'off');
      if (typeof toast === 'function') {
        toast('این رکورد به‌خاطر حجم بالای تصویر/تصاویر پیوست، با سرور ابری همگام‌سازی نشد و فقط روی همین دستگاه ذخیره ماند. لطفاً حجم تصویر را کاهش دهید.', 'error');
      }
      console.warn('Cloud write rejected - document too large for Firestore (1MB limit):', err);
      return false;
    }
    // permission-denied / unauthenticated on a WRITE are just as permanent as on a listener -
    // the write is silently dropped forever otherwise, with no visible sign anything is wrong.
    if (err && (err.code === 'permission-denied' || err.code === 'unauthenticated')) {
      if (!permissionErrorShown) {
        permissionErrorShown = true;
        updateStatusBadge('⛔ دسترسی ابری رد شد (Firestore Rules را بررسی کنید)', 'off');
        if (typeof toast === 'function') {
          toast('این تغییر به ابر ارسال نشد: دسترسی رد شد. لطفاً Rules پروژه Firebase را بررسی کنید.', 'error');
        }
      }
      console.warn('Cloud write rejected - permission denied (will not self-recover):', err);
      return false;
    }
    // Firestore automatically queues this write locally and retries once back online -
    // this is expected while offline, so we don't alarm the user for it.
    console.info('Cloud write queued/pending (will retry automatically):', err.code || err.message);
    return true;
  }

  // Used after imports/backups/local seeds - pushes every LOCAL record up as an
  // individual per-document merge write (still never touches other people's docs).
  function queueFullFlush() {
    if (!ready) return;
    const d = DB.load();
    // Never push a still-untouched seed-default admin (isSeedDefault) up to the cloud. Every
    // brand-new device creates one of these locally the moment it's opened, before any real
    // sync happens; pushing it here would create a permanent DUPLICATE "admin" document in
    // Firestore (different id, same username) for every single device that's ever opened the
    // app for the first time - splitting that identity forever instead of merging into the
    // one real admin account.
    d.users.filter((u) => !u.isSeedDefault).forEach(pushUser);
    d.leads.forEach(pushLead);
    d.customers.forEach(pushCustomer);
    d.pendingMatches.forEach(pushPendingMatch);
    if (Array.isArray(d.leadConflicts)) d.leadConflicts.forEach(pushLeadConflict);
    if (Array.isArray(d.customerConflicts)) d.customerConflicts.forEach(pushCustomerConflict);
    // NEVER push settings here. Unlike the per-record collections above, settings is ONE
    // single document shared by everyone - and DB.load() eagerly seeds it locally with the
    // hardcoded defaults (0.5%/0.5%) the moment ANY brand-new device (or one that just had
    // its site data cleared) opens the app, before that device's own settings snapshot has
    // had a chance to arrive. This full-flush write is a raw Firestore set(...,{merge:true})
    // with NO timestamp comparison (the last-write-wins check only exists client-side, in
    // DB.upsertSettings, on the RECEIVING end) - so it used to unconditionally overwrite
    // the real shared commission percentages back to the defaults for EVERY connected
    // client, the instant any such device ran its one-time flush. This is exactly why
    // "the commission percent I set keeps reverting to 0.5% after a while" happened - same
    // failure mode already guarded against for seed-default users/loanProducts above/below,
    // just missing here. Any genuine settings change is already pushed immediately and
    // correctly by DB.updateSettings() the moment the admin makes it, so a full flush never
    // legitimately needs to touch this document at all.
    d.templates.forEach(pushTemplate);
    d.chatMessages.forEach(pushChatMessage);
    // Loan products: push every LOCAL product up EXCEPT seed-default placeholders, so a freshly
    // restored backup lands in the cloud. Seed defaults are per-device auto-generated examples
    // and must never be pushed (they'd create duplicates - one per device).
    if (Array.isArray(d.loanProducts)) d.loanProducts.filter((p) => !p.isSeedDefault).forEach(pushLoanProduct);
  }

  return {
    init, isReady, isConfigured, pushUser, deleteUser, pushLead, deleteLead, pushCustomer, pushPendingMatch, pushLeadConflict, pushCustomerConflict, pushSettings,
    pushTemplate, deleteTemplate, deleteCustomer, pushChatMessage, deleteChatMessage, pushAuditLog, queueFullFlush,
    pushLoanProduct, deleteLoanProduct,
    hasCompletedInitialSync, waitForInitialSync, getDebugInfo
  };
})();

// CRITICAL: db.js guards every single push/delete call with `if (window.CloudSync) ...`.
// `const CloudSync = (...)()` at the top level of a classic (non-module) <script> creates
// a global BINDING (so the bare identifier `CloudSync` works fine everywhere, including in
// the console), but it does NOT create a property on the `window` object itself - that only
// happens automatically for `var`. Without this explicit assignment, `window.CloudSync` is
// always `undefined`, so EVERY `if (window.CloudSync)` check in db.js silently short-circuits
// and no push/delete ever reaches Firestore after the app's initial one-time flush - which is
// exactly the bug that made deletes (and every other edit) appear to never sync at all.
window.CloudSync = CloudSync;

document.addEventListener('DOMContentLoaded', () => { CloudSync.init(); });
