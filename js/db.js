/* ===================== DB LAYER (localStorage + Firebase sync) ===================== */
const DB_KEY = 'loanCRM_v1';

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Persian/Arabic-Indic digits -> plain ASCII digits. Many keyboards type numbers in
// Persian digits (۰-۹) by default, which used to make phone/national-id matching
// silently fail (those characters would get stripped out instead of compared).
function toEnglishDigits(s) {
  if (!s) return '';
  return String(s)
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function normalizePhone(p) {
  if (!p) return '';
  return toEnglishDigits(p).replace(/[^0-9]/g, '').replace(/^0098/, '0').replace(/^98/, '0');
}

// National ID: digits only, Persian/Arabic digits normalized first (same reasoning as phone).
function normalizeNationalId(n) {
  if (!n) return '';
  return toEnglishDigits(n).replace(/[^0-9]/g, '');
}

function normalizeName(n) {
  if (!n) return '';
  return toEnglishDigits(n).trim().replace(/[\u200c\s]+/g, ' ').replace(/[یي]/g, 'ی').replace(/[کك]/g, 'ک').toLowerCase();
}

// Iranian mobile number check: after normalizePhone() the number should be 11 digits
// starting with 09 (e.g. 09123456789). Empty string is treated as "not provided".
function isValidMobile(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  return /^09\d{9}$/.test(p);
}

// Standard Iranian national-ID (کد ملی) checksum validation. Empty string is treated
// as "not provided" (field stays optional; this only rejects a *wrong* value).
function isValidNationalId(id) {
  const n = normalizeNationalId(id);
  if (!n) return false;
  if (!/^\d{10}$/.test(n)) return false;
  if (/^(\d)\1{9}$/.test(n)) return false; // all-same-digit codes are never valid
  const digits = n.split('').map(Number);
  const check = digits[9];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += digits[i] * (10 - i);
  const remainder = sum % 11;
  return remainder < 2 ? check === remainder : check === (11 - remainder);
}

function nowISO() { return new Date().toISOString(); }

function simpleHash(str) {
  // NOTE: legacy, INSECURE - kept only so existing accounts created before the current
  // hashPassword() below existed can still log in once, so their hash can be
  // transparently upgraded (see verifyPassword()). Never used for NEW passwords anymore.
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return 'h' + h + '_' + btoa(unescape(encodeURIComponent(str))).slice(0, 12);
}

/* ===================== PASSWORD HASHING (real, one-way) =====================
   Previous format (simpleHash above) embedded a truncated, plain Base64 encoding of
   the ACTUAL password inside the "hash" - i.e. reversible, not real hashing. Combined
   with Firestore rules that let any signed-in (including anonymous) visitor read the
   whole `users` collection, that meant every user's real password was effectively
   public. A first fix moved to salted SHA-256 - a real one-way hash, but SHA-256 is a
   general-purpose *fast* hash (designed for checksums, not passwords), so if the
   `users` collection is ever actually read by someone unauthorized, a fast hash is
   cheap to brute-force at scale on a GPU.
   This upgrades to PBKDF2-HMAC-SHA256 with 600,000 iterations - the current
   OWASP-recommended minimum (Password Storage Cheat Sheet) - which deliberately
   makes each guess computationally expensive, using the browser's built-in Web
   Crypto API (SubtleCrypto, works fully offline, no network/library needed).
   Stored format: "pbkdf2$<iterations>$<saltHex>$<hashHex>" - the iteration count is
   stored alongside the hash itself, so a future bump to the count doesn't break
   verification of hashes created under the old, lower count. */
const PBKDF2_ITERATIONS = 600000;
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
}
async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return bufToHex(digest);
}
function randomSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function pbkdf2Hex(password, saltHex, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password)), { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(bits);
}
// Current (best) format: PBKDF2. Called with just a password to hash a NEW password
// with a fresh salt and today's iteration count; called with an existing salt/iteration
// count (from verifyPassword, re-verifying an existing hash) to reproduce it exactly.
async function hashPassword(password, existingSaltHex, existingIterations) {
  const salt = existingSaltHex || randomSaltHex();
  const iterations = existingIterations || PBKDF2_ITERATIONS;
  const hash = await pbkdf2Hex(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}
// Legacy (previous-gen) format - salted SHA-256. Kept ONLY so an account that hasn't
// logged in since the PBKDF2 upgrade can still be verified once, immediately upgraded
// to pbkdf2$ by authenticate() below. Never used for new passwords.
async function legacySha256Hash(password, saltHex) {
  return `sha256$${saltHex}$${await sha256Hex(saltHex + ':' + String(password))}`;
}
// Verifies a password against whatever is stored - transparently handles the current
// pbkdf2$ format, the previous-gen sha256$ format, and the original simpleHash() value,
// so nobody's existing account/password stops working through any of these upgrades.
async function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expected = await hashPassword(password, salt, iterations);
    return expected === stored;
  }
  if (stored.startsWith('sha256$')) {
    const parts = stored.split('$');
    const salt = parts[1];
    const expected = await legacySha256Hash(password, salt);
    return expected === stored;
  }
  return stored === simpleHash(password); // legacy fallback
}

/* ===================== INDEXEDDB STORAGE LAYER =====================
   Replaces plain localStorage as the persistence layer. localStorage caps each
   origin at roughly 5-10MB total, shared by every key the app writes - and since
   every base64-encoded image the app ever stores lives inside the one big
   DB_KEY blob, that cap gets hit as soon as enough images accumulate (the
   "حافظه ذخیره‌سازی مرورگر پر شده است" error). IndexedDB has no comparable
   small fixed cap (commonly hundreds of MB up to low GBs, tied to available
   disk space) and every read/write is asynchronous, so persisting the dataset
   no longer blocks the UI thread while JSON.stringify runs over the whole
   thing (that blocking was the main cause of the app freezing/"stopping").
   Nothing else about how the app uses `DB._data` changes: it's still one
   plain in-memory JS object that every other function in this file (and all
   of app.js) reads/writes synchronously exactly as before. Only *how that
   object gets saved to disk* is different now. */
const IDB_NAME = 'loanCRM_idb';
const IDB_STORE = 'kv';
const IDB_VERSION = 1;

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const DB = {
  _data: null,
  // Resolves once init() has finished the first time - lets code elsewhere
  // (see app.js bottom) `await`/`.then()` a guaranteed-loaded DB instead of
  // racing the async IndexedDB read.
  _ready: null,

  isValidMobile,
  isValidNationalId,

  // Best-effort reference to the logged-in user, used only for attributing audit-log
  // entries (WHO did this). app.js declares `CURRENT_USER` as a top-level `let`, which -
  // since both files are plain classic <script> tags on the same page - is visible here
  // via the shared script-global scope, even though it's never attached to `window`.
  // Guarded with `typeof` so db.js never throws if it's ever loaded standalone.
  _actor() { return (typeof CURRENT_USER !== 'undefined') ? CURRENT_USER : null; },

  // Synchronous accessor used everywhere in app.js/firebase-sync.js. By the time
  // any of those call sites run, init() below has already resolved (see the
  // DB.init().then(...) bootstrap at the bottom of app.js), so this just returns
  // the already-loaded in-memory object. The synchronous localStorage fallback
  // here only guards against some future code path calling load() before init()
  // - it should not normally be hit.
  load() {
    if (this._data) return this._data;
    console.warn('[DB] load() called before init() finished - using a temporary synchronous fallback.');
    let raw = null;
    try { raw = localStorage.getItem(DB_KEY); } catch (e) { /* ignore */ }
    try { this._data = raw ? JSON.parse(raw) : this._seed(); }
    catch (e) { this._data = this._seed(); }
    this._migrateAndNormalize();
    return this._data;
  },

  // Real, asynchronous first-time load. Reads from IndexedDB; if IndexedDB has
  // nothing yet, migrates whatever was previously saved under the old
  // localStorage key (one-time, for devices upgrading from the older
  // localStorage-only version), then removes that legacy key so it stops
  // competing for the small localStorage quota. Safe to call more than once -
  // every call after the first just returns the same already-loaded data.
  async init() {
    if (this._data) return this._data;
    if (this._ready) return this._ready;
    this._ready = (async () => {
      let stored = null;
      try {
        stored = await idbGet(DB_KEY);
      } catch (err) {
        console.error('[DB] IndexedDB unavailable, falling back to localStorage only:', err);
      }
      if (!stored) {
        let legacyRaw = null;
        try { legacyRaw = localStorage.getItem(DB_KEY); } catch (e) { /* ignore */ }
        if (legacyRaw) {
          try { stored = JSON.parse(legacyRaw); } catch (e) { stored = null; }
        }
      }
      this._data = stored || this._seed();
      this._migrateAndNormalize();
      await this.save({ skipCloud: true });
      // Data now lives in IndexedDB - drop the old localStorage copy so it isn't
      // duplicated forever and doesn't keep eating into the small localStorage quota.
      try { localStorage.removeItem(DB_KEY); } catch (e) { /* ignore */ }
      return this._data;
    })();
    return this._ready;
  },

  // Every migration/backfill/dedup rule that used to live inline inside load()
  // - unchanged, just factored out so both load()'s fallback and init()'s real
  // path run exactly the same normalization on whatever raw object they got.
  _migrateAndNormalize() {
    if (!this._data.pendingMatches) this._data.pendingMatches = [];
    if (!this._data.leadConflicts) this._data.leadConflicts = [];
    // customer <-> customer duplicate warnings (see addCustomer below) - catches the case
    // where TWO customers are registered directly in the office (no lead involved on
    // either side), which leadConflicts/pendingMatches never see since those only ever
    // compare against leads. See createCustomerConflict()/getCustomerConflicts() below.
    if (!this._data.customerConflicts) this._data.customerConflicts = [];
    if (!this._data.templates) this._data.templates = [];
    if (!this._data.chatMessages) this._data.chatMessages = [];
    if (!this._data.auditLogs) this._data.auditLogs = [];
    if (!this._data.loanProducts) this._data.loanProducts = [];
    if (!this._data.settings) {
      this._data.settings = {
        commissionMode: 'percent',   // 'percent' | 'manual'
        callerPercent: 0.5,          // % of loan amount for the caller (lead generator)
        processorPercent: 0.5,       // % of loan amount for the office specialist
        manualUserIds: [],          // ids of specific caller/processor users forced to manual commission entry
        chatEnabled: false,          // admin-controlled master switch for the group chat feature
        updatedAt: nowISO()
      };
    }
    if (!this._data.settings.manualUserIds) this._data.settings.manualUserIds = [];
    if (this._data.settings.chatEnabled === undefined) this._data.settings.chatEnabled = false;
    // migrate older leads so new fields always exist; also re-normalize phone/nationalId
    // from the originally-typed value so legacy records typed with Persian digits (which
    // used to get silently stripped out) self-heal the next time the app loads.
    this._data.leads.forEach(l => {
      if (l.requestType === undefined) l.requestType = 'loan';
      if (l.goodsType === undefined) l.goodsType = '';
      if (l.followUpStatus === undefined) l.followUpStatus = 'in_progress';
      if (l.rawPhone) l.phone = normalizePhone(l.rawPhone);
      if (l.nationalId) l.nationalId = normalizeNationalId(l.nationalId);
      // reminder ("یادآوری"): same shape as the customer reminder, so a caller can set a
      // reminder on a lead (a "مشتری تلفنی") before/without it ever being linked to an
      // office customer record.
      if (l.reminder === undefined) l.reminder = null;
      // Whether an admin/authorized reviewer has already looked at this lead's
      // "وامش را با نام شخص دیگر گرفته" flag (see getTakenByOtherLeads/markLeadReviewed
      // below). Defaults to false so any lead already sitting at that status before this
      // feature existed also surfaces for review instead of being silently skipped.
      if (l.takenByOtherReviewed === undefined) l.takenByOtherReviewed = false;
    });
    this._data.customers.forEach(c => {
      if (c.nationalId) c.nationalId = normalizeNationalId(c.nationalId);
      // self-heal legacy records saved before customer.phone was normalized on save
      // (see addCustomer below) - same reasoning as the lead phone migration above.
      if (c.phone) c.phone = normalizePhone(c.phone);
      // شماره تماس دوم (اختیاری) - برخی مشتریان دو شماره تماس دارند. رکوردهای قدیمی این
      // فیلد را نداشتند، پس همیشه مقداردهی اولیه می‌شود تا فرم/جستجو/تطبیق با آن کار کنند.
      if (c.phone2 === undefined) c.phone2 = '';
      else if (c.phone2) c.phone2 = normalizePhone(c.phone2);
      // self-heal: a completed file whose commission was never computed because it was
      // completed by a processor/caller BEFORE updateCustomer auto-calculated it (see
      // updateCustomer below) - stuck at the {amount:0,paid:false} creation default.
      // Only touches sides that are (a) not in manual mode and (b) still exactly at that
      // untouched default, so it never overwrites a real 0 an admin deliberately entered
      // or paid out.
      if (c.stage === 'completed') {
        const calc = this.computeCommissions(c.loanAmount, { callerId: c.callerId, processorId: c.processorId });
        const callerUntouched = c.callerCommission && c.callerCommission.amount === 0 && !c.callerCommission.paid;
        const processorUntouched = c.processorCommission && c.processorCommission.amount === 0 && !c.processorCommission.paid;
        if (!calc.callerManual && callerUntouched && calc.callerAmount) c.callerCommission = { amount: calc.callerAmount, paid: false };
        if (!calc.processorManual && processorUntouched && calc.processorAmount) c.processorCommission = { amount: calc.processorAmount, paid: false };
      }
    });
    // migrate older templates: single image/audio -> arrays of multiple attachments
    this._data.templates.forEach(t => {
      if (t.images === undefined) t.images = t.image ? [t.image] : [];
      if (t.audios === undefined) t.audios = t.audio ? [t.audio] : [];
    });
    // migrate older loan products: ensure formulas.specialInstallments is an array and
    // constants is an array of {name,label,value}. Older records (if any) get safe defaults.
    this._data.loanProducts.forEach(p => {
      if (!p.formulas) p.formulas = {};
      if (!Array.isArray(p.formulas.specialInstallments)) p.formulas.specialInstallments = [];
      if (!Array.isArray(p.constants)) p.constants = [];
      if (p.formulas.loanAmountFromPurchasable === undefined) p.formulas.loanAmountFromPurchasable = '';
      if (p.archived === undefined) p.archived = false;
      // isSeedDefault: products created by _seed() on a brand-new device. Older products
      // (created before this flag existed) default to false — they're real, intentional products.
      if (p.isSeedDefault === undefined) p.isSeedDefault = false;
    });
    // Dedup guard: if there are MULTIPLE seed-default products (which can happen if a device
    // was re-seeded or if old duplicates accumulated before the isSeedDefault flag existed),
    // keep only the newest one. This runs on every load so duplicates are cleaned up even
    // without waiting for a cloud snapshot.
    const seedProdCount = this._data.loanProducts.filter(p => p.isSeedDefault).length;
    if (seedProdCount > 1) {
      const seedProds = this._data.loanProducts.filter(p => p.isSeedDefault)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const keepId = seedProds[0].id;
      const before = this._data.loanProducts.length;
      this._data.loanProducts = this._data.loanProducts.filter(p => !p.isSeedDefault || p.id === keepId);
      console.info('[DB] dedup: removed', before - this._data.loanProducts.length, 'duplicate seed-default product(s) on load');
    }
    // migrate older users: chat access defaults to off until the admin grants it
    this._data.users.forEach(u => {
      if (u.canChat === undefined) u.canChat = false;
      // Grants access to the "وام گرفته‌شده با نام دیگری" review queue (see
      // canReviewTakenLeads/getTakenByOtherLeads below) - off by default, same pattern
      // as canSeeLeadPurchase, until the admin explicitly grants it to a specific user.
      if (u.canReviewTakenLeads === undefined) u.canReviewTakenLeads = false;
      // Grants a تلفنی (caller) user the same office-workflow editing rights a
      // کارشناس دفتر (processor) has, but scoped only to that caller's OWN connected
      // customers (see getCustomersForUser/openCustomerForm) - for cases where the
      // caller's lead comes into the office themselves and the same person walks the
      // file through the loan stages. Off by default, same admin-granted pattern as
      // canChat/canSeeLeadPurchase/canReviewTakenLeads above.
      if (u.canProcessCustomers === undefined) u.canProcessCustomers = false;
      if (!Array.isArray(u.commissionPayments)) u.commissionPayments = [];
    });
    // Dedup guard: if there are MULTIPLE seed-default admin users (which can happen if a
    // device was re-seeded, or if old duplicates accumulated before the isSeedDefault flag
    // existed, or if the user cleared cache multiple times and cloud sync hadn't arrived yet),
    // keep only the newest one. This runs on every load so duplicates are cleaned up even
    // without waiting for a cloud snapshot. Real admin accounts (isSeedDefault=false/undefined)
    // are never touched here.
    const seedAdminCount = this._data.users.filter(u => u.isSeedDefault).length;
    if (seedAdminCount > 1) {
      const seedAdmins = this._data.users.filter(u => u.isSeedDefault)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const keepId = seedAdmins[0].id;
      const before = this._data.users.length;
      this._data.users = this._data.users.filter(u => !u.isSeedDefault || u.id === keepId);
      console.info('[DB] dedup: removed', before - this._data.users.length, 'duplicate seed-default admin(s) on load');
    }
    // migrate older customers to the new detailed processing workflow:
    // new -> awaiting_docs -> awaiting_score -> awaiting_withdrawal -> completed
    // (legacy 'following' meant "in progress"; closest safe equivalent is awaiting_docs)
    this._data.customers.forEach(c => {
      if (c.stage === 'following') c.stage = 'awaiting_docs';
      if (c.stage === 'new') c.stage = 'awaiting_docs'; // "مشتری جدید" step removed from the workflow
      if (c.paymentType === undefined) c.paymentType = '';
      if (c.contractImage === undefined) c.contractImage = null;
      // "خرید امتیاز" (score purchase): a single amount + single receipt (per current
      // office process). Migrate older shapes (single deposit fields, or an array of
      // multiple deposits from a previous version) into this simpler shape without
      // losing any already-recorded amount/receipt.
      if (c.leadPurchase && Array.isArray(c.leadPurchase.deposits)) {
        const old = c.leadPurchase;
        const totalAmount = old.deposits.reduce((s, dep) => s + (Number(dep.amount) || 0), 0);
        const firstReceipt = old.deposits.find(dep => dep.receiptImage)?.receiptImage || null;
        c.leadPurchase = {
          fromName: old.fromName || '',
          date: old.date || null,
          amount: totalAmount,
          receiptImage: firstReceipt,
          requestedAt: old.requestedAt || null,
          approved: !!old.approved,
          approvedAt: old.approvedAt || null,
          approvedBy: old.approvedBy || null
        };
      } else if (c.leadPurchase) {
        if (c.leadPurchase.amount === undefined) c.leadPurchase.amount = c.leadPurchase.amount || 0;
        if (c.leadPurchase.receiptImage === undefined) c.leadPurchase.receiptImage = null;
      }
      if (c.withdrawal === undefined) c.withdrawal = null;
      if (c.goodsSettlement === undefined) c.goodsSettlement = null;
      if (c.goodsSettlement && c.goodsSettlement.goodsName === undefined) c.goodsSettlement.goodsName = '';
      if (c.goodsSettlement && c.goodsSettlement.receiptImage === undefined) c.goodsSettlement.receiptImage = null;
      // "تسویه خرید کالا" (admin/authorized-person side: what the office paid the
      // store), separate from the office specialist's "جزییات فروش کالا".
      if (c.goodsPurchase === undefined) c.goodsPurchase = null;
      // reminder ("یادآوری"): a single active reminder per customer, visible/editable
      // from any panel the customer appears in (caller/processor/admin).
      if (c.reminder === undefined) c.reminder = null;
    });
    // One-time backfill: this customer<->customer duplicate check didn't exist before,
    // so any pair of customers already registered directly (no lead involved) with the
    // same phone/national id never got flagged. Run the O(n²) scan exactly once per
    // device/dataset (guarded by customerDuplicateScanDone) so existing duplicates also
    // surface in the admin's "تطبیق‌های در انتظار تایید" queue instead of staying silent
    // forever. Safe to run before pendingMatches processing since it only ever compares
    // customers to other customers.
    if (!this._data.customerDuplicateScanDone) {
      this._scanExistingCustomerDuplicates();
      this._data.customerDuplicateScanDone = true;
    }
    return this._data;
  },
  _scanExistingCustomerDuplicates() {
    const customers = this._data.customers;
    for (let i = 0; i < customers.length; i++) {
      for (let j = i + 1; j < customers.length; j++) {
        const a = customers[i], b = customers[j];
        const aPhone = normalizePhone(a.phone), aPhone2 = normalizePhone(a.phone2), aNid = normalizeNationalId(a.nationalId);
        const matches = (aPhone && (normalizePhone(b.phone) === aPhone || (b.phone2 && normalizePhone(b.phone2) === aPhone)))
          || (aPhone2 && (normalizePhone(b.phone) === aPhone2 || (b.phone2 && normalizePhone(b.phone2) === aPhone2)))
          || (aNid && b.nationalId && normalizeNationalId(b.nationalId) === aNid);
        if (matches) this.createCustomerConflict(a.id, b.id, 'exact');
      }
    }
  },

  // Persists to IndexedDB only. Cloud pushes are explicit and per-record (see each
  // mutation method below, e.g. addCustomer/updateCustomer call CloudSync.pushCustomer),
  // so a single edit never re-uploads the whole dataset - only the one changed document.
  //
  // Everything the app stores (including every base64-encoded image) still lives under
  // this ONE storage key/record, but it's now in IndexedDB instead of localStorage, which
  // removes the old ~5-10MB origin-wide cap (IndexedDB is commonly good for hundreds of
  // MB, tied to actual free disk space) and - just as importantly - is asynchronous, so
  // writing the whole dataset no longer blocks the UI thread the way a big synchronous
  // JSON.stringify + localStorage.setItem did (that blocking was the main cause of the
  // app "freezing"/appearing to stop responding on larger datasets).
  //
  // Every caller in this file just calls `this.save()`/`this.save(opts)` without awaiting
  // or checking a return value, so making this async changes nothing at any call site -
  // the in-memory `this._data` object (which every synchronous read in the app uses) is
  // already up to date the instant the caller mutated it; this only persists it to disk
  // in the background. A failure (e.g. IndexedDB itself unavailable, or the rare case of
  // a device truly out of disk space) is still reported via the same 'db:save-error' DOM
  // event app.js already listens for, so it's never silently lost like before.
  async save(opts) {
    try {
      await idbSet(DB_KEY, this._data);
      return true;
    } catch (err) {
      console.error('DB.save failed:', err);
      try {
        document.dispatchEvent(new CustomEvent('db:save-error', { detail: { error: err } }));
      } catch (e) { /* ignore if document unavailable */ }
      return false;
    }
  },

  _seed() {
    const adminId = uid('u');
    return {
      version: 2,
      users: [
        {
          id: adminId,
          name: 'مدیر سیستم',
          username: 'admin',
          passwordHash: simpleHash('admin123'),
          role: 'admin',
          active: true,
          canSeeLeadPurchase: true,
          canChat: true,
          createdAt: nowISO(),
          updatedAt: nowISO(),
          // Marks this as a placeholder created automatically the moment THIS device opened
          // the app for the first time - not a real account a person set up. Cleared the
          // moment someone actually edits it (see updateUser). Used to (a) never push it to
          // Firestore as a brand-new duplicate "admin" document, and (b) safely remove it once
          // the real cloud data for this app arrives, see removeSeedDefaultAdminIfSuperseded().
          isSeedDefault: true
        }
      ],
      leads: [],
      customers: [],
      pendingMatches: [],
      // Early "duplicate lead" warnings - raised the moment a caller registers a lead whose
      // phone/national id already exactly matches ANOTHER lead (a different caller, or the
      // same caller registering the same person twice), *before* any office customer record
      // exists yet. Separate from pendingMatches (which is always lead<->customer); this one
      // is always lead<->lead. See addLead()/getLeadConflicts()/resolveLeadConflict() below.
      leadConflicts: [],
      customerConflicts: [],
      customerDuplicateScanDone: true, // brand-new device has no legacy data to backfill
      templates: [],
      chatMessages: [],
      auditLogs: [],
      // Loan products are completely admin-defined. Seed exactly ONE example so the
      // admin immediately sees how a product is structured (formulas + constants) and
      // can copy/edit it for other banks instead of starting from a blank form. This
      // sample matches the "بانک مهر ایران" example from the original request.
      loanProducts: [
        {
          id: uid('lp'),
          bankName: 'بانک مهر ایران',
          schemeName: 'وام مسکن',
          installmentsCount: 24,
          description: 'وام ۲۴ ماهه بانک مهر ایران. قسط اول و قسط سیزدهم به‌صورت درصدی از مبلغ وام و مانده محاسبه می‌شوند و سایر اقساط مساوی هستند. مبلغ قابل دریافت (قدرت خرید) پس از کسر ۴۰٪ است.',
          formulas: {
            firstInstallment: 'L * 4%',
            otherInstallments: 'L / (N - 2)',
            purchasableAmount: 'L - L * 40%',
            loanAmountFromPurchasable: '',
            specialInstallments: [
              { installmentNumber: 13, label: 'قسط سیزدهم', formula: 'R * 4%' }
            ]
          },
          constants: [],
          archived: false,
          // Marks this as a placeholder created automatically the moment THIS device opened
          // the app for the first time - not a real product a person set up. Same pattern as
          // the seed default admin: once real cloud data arrives, this is removed so we don't
          // end up with N duplicate seed products (one per device that ever opened the app).
          isSeedDefault: true,
          createdAt: nowISO(),
          updatedAt: nowISO()
        }
      ],
      settings: {
        commissionMode: 'percent',
        callerPercent: 0.5,
        processorPercent: 0.5,
        manualUserIds: [],
        chatEnabled: false,
        updatedAt: nowISO()
      },
      currentUserId: null
    };
  },

  reset() {
    this._data = this._seed();
    this.save();
  },

  /* ===================== upsert helpers (used by local UI AND incoming cloud data) =====================
     Every entity is its own record with an id. Upserts here NEVER wipe the collection -
     they only ever touch the single record with a matching id, so a sync from one device/user
     can never delete or overwrite another device's/user's data. Deletions are explicit (tombstone). */
  upsertUser(user, opts) {
    const d = this.load();
    const i = d.users.findIndex(u => u.id === user.id);
    if (i === -1) d.users.push(user);
    else if (!user.updatedAt || !d.users[i].updatedAt || new Date(user.updatedAt) >= new Date(d.users[i].updatedAt)) {
      d.users[i] = user; // last-write-wins per record, based on updatedAt
    }
    this.save(opts);
  },
  upsertLead(lead, opts) {
    const d = this.load();
    const i = d.leads.findIndex(l => l.id === lead.id);
    if (i === -1) d.leads.push(lead);
    else if (!lead.updatedAt || !d.leads[i].updatedAt || new Date(lead.updatedAt) >= new Date(d.leads[i].updatedAt)) {
      d.leads[i] = lead;
    }
    this.save(opts);
  },
  upsertCustomer(customer, opts) {
    const d = this.load();
    const i = d.customers.findIndex(c => c.id === customer.id);
    if (i === -1) d.customers.push(customer);
    else if (!customer.updatedAt || !d.customers[i].updatedAt || new Date(customer.updatedAt) >= new Date(d.customers[i].updatedAt)) {
      d.customers[i] = customer;
    }
    this.save(opts);
  },
  upsertPendingMatch(pm, opts) {
    const d = this.load();
    const i = d.pendingMatches.findIndex(p => p.id === pm.id);
    if (i === -1) d.pendingMatches.push(pm);
    else d.pendingMatches[i] = pm;
    this.save(opts);
  },
  upsertLeadConflict(lc, opts) {
    const d = this.load();
    const i = d.leadConflicts.findIndex(x => x.id === lc.id);
    if (i === -1) d.leadConflicts.push(lc);
    else d.leadConflicts[i] = lc;
    this.save(opts);
  },
  upsertCustomerConflict(cc, opts) {
    const d = this.load();
    const i = d.customerConflicts.findIndex(x => x.id === cc.id);
    if (i === -1) d.customerConflicts.push(cc);
    else d.customerConflicts[i] = cc;
    this.save(opts);
  },
  upsertTemplate(tpl, opts) {
    const d = this.load();
    const i = d.templates.findIndex(t => t.id === tpl.id);
    if (i === -1) d.templates.push(tpl);
    else if (!tpl.updatedAt || !d.templates[i].updatedAt || new Date(tpl.updatedAt) >= new Date(d.templates[i].updatedAt)) {
      d.templates[i] = tpl;
    }
    this.save(opts);
  },
  removeTemplateLocal(id, opts) {
    const d = this.load();
    d.templates = d.templates.filter(t => t.id !== id);
    this.save(opts);
  },
  // Loan products: admin-defined, completely customizable loan calculators. Each product
  // carries its own formulas (first/special/other installment + purchasable amount) and a
  // set of named constants (c.XXX) the admin can use inside those formulas. Synced via the
  // same per-document pattern as every other entity, so two admins editing different
  // products on different devices never collide.
  upsertLoanProduct(p, opts) {
    const d = this.load();
    const i = d.loanProducts.findIndex(x => x.id === p.id);
    if (i === -1) d.loanProducts.push(p);
    else if (!p.updatedAt || !d.loanProducts[i].updatedAt || new Date(p.updatedAt) >= new Date(d.loanProducts[i].updatedAt)) {
      d.loanProducts[i] = p;
    }
    this.save(opts);
  },
  removeLoanProductLocal(id, opts) {
    const d = this.load();
    d.loanProducts = d.loanProducts.filter(p => p.id !== id);
    this.save(opts);
  },
  upsertSettings(settings, opts) {
    const d = this.load();
    if (!settings) return;
    if (!d.settings || !settings.updatedAt || !d.settings.updatedAt || new Date(settings.updatedAt) >= new Date(d.settings.updatedAt)) {
      d.settings = settings;
    }
    this.save(opts);
  },
  removeCustomerLocal(id, opts) {
    const d = this.load();
    d.customers = d.customers.filter(c => c.id !== id);
    d.leads.forEach(l => { if (l.matchedCustomerId === id) l.matchedCustomerId = null; });
    this.save(opts);
  },
  // Removing a lead is intentionally "shallow": if it was already linked to an office
  // customer record, that customer's own callerId (used for commission) is left exactly
  // as-is - the link/commission lives on the customer record itself once established, not
  // on the caller's lead card, so deleting the lead card must never silently undo a
  // commission that's already attached to a real customer.
  removeLeadLocal(id, opts) {
    const d = this.load();
    d.leads = d.leads.filter(l => l.id !== id);
    this.save(opts);
  },
  // Permanent user removal (as opposed to the existing active/inactive toggle). Any
  // lead/customer that referenced this user (callerId/processorId) is left untouched -
  // every place that displays it already falls back gracefully (e.g. "نامشخص") when
  // DB.getUser(id) no longer finds a match, so nothing else needs to be cleaned up.
  removeUserLocal(id, opts) {
    const d = this.load();
    d.users = d.users.filter(u => u.id !== id);
    this.save(opts);
  },
  // Chat messages are append-only (no edits), so upsert is just "add if missing".
  upsertChatMessage(msg, opts) {
    const d = this.load();
    if (d.chatMessages.find(m => m.id === msg.id)) return;
    d.chatMessages.push(msg);
    this.save(opts);
  },
  removeChatMessageLocal(id, opts) {
    const d = this.load();
    d.chatMessages = d.chatMessages.filter(m => m.id !== id);
    this.save(opts);
  },
  // Audit log entries are append-only, exactly like chat messages - never edited/deleted
  // locally, and Firestore Rules also hard-block update/delete server-side (see
  // firestore.rules) so even a compromised session can't erase history.
  upsertAuditLog(entry, opts) {
    const d = this.load();
    if (d.auditLogs.find(a => a.id === entry.id)) return;
    d.auditLogs.push(entry);
    this.save(opts);
  },

  // ---------- AUDIT LOG (تاریخچه) ----------
  // Called from every sensitive mutation below (users/leads/customers/settings/...).
  // `entity`/`entityId` identify WHAT changed, `action` is a short machine key
  // ('create'|'update'|'delete'|...), `summary` is the human-readable Persian line
  // shown in the history screen, and `meta` is optional extra structured detail
  // (e.g. { before, after } or a patch) kept for completeness but not required for display.
  logAudit({ entity, entityId, action, summary, meta }, user) {
    const d = this.load();
    const entry = {
      id: uid('al'),
      entity, entityId: entityId || null, action,
      actorId: user ? user.id : null,
      actorName: user ? user.name : 'سیستم',
      summary: summary || '',
      meta: meta || null,
      at: nowISO()
    };
    d.auditLogs.push(entry);
    // Audit log can grow indefinitely; keep localStorage bounded by trimming the oldest
    // entries beyond a generous cap (cloud copy in Firestore is unaffected/kept forever).
    const AUDIT_LOCAL_CAP = 5000;
    if (d.auditLogs.length > AUDIT_LOCAL_CAP) d.auditLogs = d.auditLogs.slice(d.auditLogs.length - AUDIT_LOCAL_CAP);
    this.save();
    if (window.CloudSync) CloudSync.pushAuditLog(entry);
    return entry;
  },
  getAuditLogs() { return this.load().auditLogs.slice().sort((a, b) => new Date(b.at) - new Date(a.at)); },

  // ---------- SETTINGS (global, admin-managed) ----------
  getSettings() { return this.load().settings; },
  updateSettings(patch) {
    const d = this.load();
    const updatedAt = nowISO();
    d.settings = Object.assign({}, d.settings, patch, { updatedAt });
    this.save();
    // IMPORTANT: push only the fields that actually changed (+ updatedAt), not the whole
    // cached settings object. Firestore writes here use {merge:true}, so sending the full
    // object means any field this particular session's local cache hasn't caught up on
    // yet (e.g. chatEnabled toggled from another tab/device) gets re-sent with its stale
    // value and a brand-new updatedAt — which then "wins" the last-write-wins comparison
    // in upsertSettings() and silently reverts that field everywhere. Sending just the
    // patch means unrelated fields on the server are left untouched no matter how stale
    // the local copy of them is.
    if (window.CloudSync) CloudSync.pushSettings(Object.assign({}, patch, { updatedAt }));
    this.logAudit({ entity: 'settings', action: 'update', summary: 'ویرایش تنظیمات کلی سیستم (پورسانت/چت و...)' }, this._actor());
    return d.settings;
  },
  // Returns { callerAmount, processorAmount, callerManual, processorManual } computed per
  // current settings + loan amount. `opts.callerId` / `opts.processorId` let specific users
  // (chosen by the admin in Settings > manualUserIds) be forced to manual commission entry
  // even while the global mode is 'percent' - independently for the caller and processor side.
  computeCommissions(loanAmount, opts) {
    const s = this.getSettings();
    const amount = Number(loanAmount) || 0;
    const manualIds = s.manualUserIds || [];
    opts = opts || {};
    const globalManual = s.commissionMode === 'manual';
    // وقتی callerId/processorId نامشخص است، پورسانت باید قابل ویرایش دستی باشد (manual)
    // چون نمی‌توان درصدی از وام را به کاربری که مشخص نیست نسبت داد. اینطوری مدیر می‌تواند
    // مبلغ پورسانت را خودش وارد کند (یا صفر بگذارد) — مطابق منطق گزارش سود که پورسانت
    // نامشخص را = ۰ لحاظ می‌کند.
    const callerManual = globalManual || !opts.callerId || (manualIds.includes(opts.callerId));
    const processorManual = globalManual || !opts.processorId || (manualIds.includes(opts.processorId));
    const callerAmount = callerManual ? null : Math.round(amount * (Number(s.callerPercent) || 0) / 100);
    const processorAmount = processorManual ? null : Math.round(amount * (Number(s.processorPercent) || 0) / 100);
    return { callerAmount, processorAmount, callerManual: !!callerManual, processorManual: !!processorManual };
  },

  // ---------- MESSAGE TEMPLATES (preset descriptions for sending to customers) ----------
  // scope 'shared'   -> created by the admin, visible/usable by every caller
  // scope 'personal' -> created by a caller, visible/usable only by that caller
  getTemplates() { return this.load().templates; },
  getTemplatesForUser(user) {
    const all = this.load().templates;
    if (user.role === 'admin') return all;
    return all.filter(t => t.scope === 'shared' || t.ownerId === user.id);
  },
  addTemplate({ title, text, images, audios }, user) {
    const d = this.load();
    const tpl = {
      id: uid('t'),
      title: title || '',
      text: text || '',
      images: Array.isArray(images) ? images.filter(Boolean) : (images ? [images] : []),
      audios: Array.isArray(audios) ? audios.filter(Boolean) : (audios ? [audios] : []),
      scope: user.role === 'admin' ? 'shared' : 'personal',
      ownerId: user.id,
      ownerName: user.name,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    d.templates.push(tpl);
    this.save();
    if (window.CloudSync) CloudSync.pushTemplate(tpl);
    return tpl;
  },
  updateTemplate(id, patch) {
    const d = this.load();
    const t = d.templates.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch);
    t.updatedAt = nowISO();
    this.save();
    if (window.CloudSync) CloudSync.pushTemplate(t);
    return t;
  },
  deleteTemplate(id) {
    this.removeTemplateLocal(id);
    if (window.CloudSync) CloudSync.deleteTemplate(id);
  },

  /* ===================== LOAN PRODUCTS (محصولات وام قابل‌تنظیم توسط مدیر) =====================
     هر «محصول وام» یک ماشین‌حساب کامل و مستقل است که مدیر آن را تعریف می‌کند:
     - نام بانک، نام طرح، تعداد اقساط، توضیحات
     - فرمول قسط اول، فرمول سایر اقساط، فرمول مبلغ قابل دریافت (قدرت خرید)
     - لیست اقساط خاص (مثلاً قسط سیزدهم) با شماره قسط، برچسب و فرمول جداگانه
     - لیست ثابت‌ها (درصدها و اعدادی که در فرمول‌ها با پیشوند c. قابل استفاده‌اند)
     - فرمول اختیاری معکوس (از قدرت خرید به مبلغ وام)؛ اگر خالی باشد، سیستم با
       نمونه‌گیری خطی آن را خودکار به‌دست می‌آورد (برای اکثر وام‌های واقعی که
       رابطه‌ی مبلغ وام ↔ قدرت خرید خطی است کافی است).

     متغیرهای قابل استفاده در فرمول‌ها:
       loanAmount, remainingBalance, installmentsCount, installmentNumber, paidCount,
       paidPrincipal, purchasableAmount (فقط در فرمول معکوس), c.<name>
  ======================================================================================= */
  getLoanProducts() { return this.load().loanProducts; },
  getLoanProduct(id) { return this.load().loanProducts.find(p => p.id === id); },
  getActiveLoanProducts() { return this.load().loanProducts.filter(p => !p.archived); },
  addLoanProduct(data, user) {
    const d = this.load();
    const product = this._normalizeLoanProduct(data);
    product.id = uid('lp');
    product.createdAt = nowISO();
    product.updatedAt = nowISO();
    d.loanProducts.push(product);
    this.save();
    if (window.CloudSync) CloudSync.pushLoanProduct(product);
    this.logAudit({ entity: 'loanProduct', entityId: product.id, action: 'create',
      summary: `افزودن محصول وام «${product.bankName}${product.schemeName ? ' - ' + product.schemeName : ''}»` }, this._actor());
    return product;
  },
  updateLoanProduct(id, data) {
    const d = this.load();
    const p = d.loanProducts.find(x => x.id === id);
    if (!p) return null;
    const updated = this._normalizeLoanProduct(Object.assign({}, p, data));
    updated.id = id;
    updated.createdAt = p.createdAt;
    updated.updatedAt = nowISO();
    // an explicit edit confirms this is now a real, intentional product — clear the seed flag,
    // same pattern as updateUser deleting isSeedDefault. This prevents the seed product from
    // being treated as a placeholder forever AND from being silently dropped by
    // removeSeedDefaultLoanProductIfSuperseded (which would lose the admin's edits).
    delete updated.isSeedDefault;
    const i = d.loanProducts.findIndex(x => x.id === id);
    d.loanProducts[i] = updated;
    this.save();
    if (window.CloudSync) CloudSync.pushLoanProduct(updated);
    this.logAudit({ entity: 'loanProduct', entityId: id, action: 'update',
      summary: `ویرایش محصول وام «${updated.bankName}${updated.schemeName ? ' - ' + updated.schemeName : ''}»` }, this._actor());
    return updated;
  },
  deleteLoanProduct(id) {
    const p = this.getLoanProduct(id);
    this.removeLoanProductLocal(id);
    if (window.CloudSync) CloudSync.deleteLoanProduct(id);
    this.logAudit({ entity: 'loanProduct', entityId: id, action: 'delete',
      summary: `حذف محصول وام «${p ? (p.bankName + (p.schemeName ? ' - ' + p.schemeName : '')) : id}»` }, this._actor());
  },
  // تضمین می‌کند که ذخیره‌ی محصول همیشه شکل یکسان داشته باشد (مستقل از فرم ورودی).
  // همچنین اعتبارسنجی مهم: installmentNumber نباید 1 باشد (با قسط اول تداخل دارد)،
  // نباید تکراری باشد، و نباید از installmentsCount بزرگتر باشد. installmentsCount
  // به یک حد معقول (حداکثر 360) محدود می‌شود تا از DoS جلوگیری شود.
  _normalizeLoanProduct(data) {
    const formulas = data.formulas || {};
    const constants = Array.isArray(data.constants) ? data.constants : [];
    const installmentsCount = Math.min(360, Math.max(1, parseInt(data.installmentsCount, 10) || 1));
    // فیلتر و نرمال‌سازی اقساط خاص + حذف تکراری‌ها (آخرین برنده) + حذف installmentNumber=1
    let seenNumbers = new Set();
    const rawSpecials = Array.isArray(formulas.specialInstallments)
      ? formulas.specialInstallments
          .filter(s => s && (s.installmentNumber || s.formula))
          .map(s => ({
            installmentNumber: Math.max(1, parseInt(s.installmentNumber, 10) || 1),
            label: String(s.label || '').trim(),
            formula: String(s.formula || '').trim()
          }))
          // installmentNumber=1 با قسط اول تداخل دارد — نادیده گرفته می‌شود
          .filter(s => s.installmentNumber > 1 && s.installmentNumber <= installmentsCount)
          .sort((a, b) => a.installmentNumber - b.installmentNumber)
      : [];
    const specialInstallments = rawSpecials.filter(s => {
      if (seenNumbers.has(s.installmentNumber)) return false; // duplicate حذف می‌شود
      seenNumbers.add(s.installmentNumber);
      return true;
    });
    return {
      id: data.id,
      bankName: String(data.bankName || '').trim(),
      schemeName: String(data.schemeName || '').trim(),
      installmentsCount: installmentsCount,
      description: String(data.description || '').slice(0, 5000), // محدودیت طول برای جلوگیری از سند Firestore بزرگ
      formulas: {
        firstInstallment: String(formulas.firstInstallment || '').trim(),
        otherInstallments: String(formulas.otherInstallments || '').trim(),
        purchasableAmount: String(formulas.purchasableAmount || '').trim(),
        loanAmountFromPurchasable: String(formulas.loanAmountFromPurchasable || '').trim(),
        specialInstallments: specialInstallments
      },
      constants: constants
        .filter(c => c && c.name)
        .map(c => ({
          name: String(c.name).trim(),
          label: String(c.label || '').trim(),
          value: Number.isFinite(Number(c.value)) ? Number(c.value) : 0
        })),
      archived: !!data.archived,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    };
  },
  // تبدیل لیست ثابت‌ها به یک آبجکت برای استفاده در فرمول‌ها (c.name -> value)
  _loanConstantsMap(product) {
    const map = {};
    (product.constants || []).forEach(c => {
      if (c.name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c.name)) map[c.name] = Number(c.value) || 0;
    });
    return map;
  },
  // ساخت آبجکت متغیرهای پایه برای ارزیابی فرمول.
  // هم متغیرهای کوتاه (L, R, N, I, P) و هم متغیرهای قدیمی (loanAmount, ...) پر می‌شوند
  // تا فرمول‌های قدیمی و جدید هر دو کار کنند. I بزرگ و i کوچک هر دو برای شماره قسط هستن.
  _loanBaseVars(product, overrides) {
    const base = {
      L: 0, R: 0, N: product.installmentsCount, I: 0, i: 0,
      paid: 0, paidP: 0, P: 0,
      loanAmount: 0, remainingBalance: 0, installmentsCount: product.installmentsCount,
      installmentNumber: 0, paidCount: 0, paidPrincipal: 0, purchasableAmount: 0,
      c: this._loanConstantsMap(product)
    };
    const o = overrides || {};
    if (o.loanAmount !== undefined) base.L = base.loanAmount = o.loanAmount;
    if (o.L !== undefined) base.L = base.loanAmount = o.L;
    if (o.remainingBalance !== undefined) base.R = base.remainingBalance = o.remainingBalance;
    if (o.R !== undefined) base.R = base.remainingBalance = o.R;
    if (o.installmentsCount !== undefined) base.N = base.installmentsCount = o.installmentsCount;
    if (o.N !== undefined) base.N = base.installmentsCount = o.N;
    // I بزرگ و i کوچک هر دو = شماره قسط
    if (o.installmentNumber !== undefined) base.I = base.i = base.installmentNumber = o.installmentNumber;
    if (o.I !== undefined) base.I = base.i = base.installmentNumber = o.I;
    if (o.i !== undefined) base.I = base.i = base.installmentNumber = o.i;
    if (o.purchasableAmount !== undefined) base.P = base.purchasableAmount = o.purchasableAmount;
    if (o.P !== undefined) base.P = base.purchasableAmount = o.P;
    if (o.paidCount !== undefined) base.paid = base.paidCount = o.paidCount;
    if (o.paidPrincipal !== undefined) base.paidP = base.paidPrincipal = o.paidPrincipal;
    if (o.c !== undefined) base.c = o.c;
    return base;
  },
  // محاسبه مبلغ قابل دریافت (قدرت خرید) از مبلغ وام - فرمول مستقیم
  computePurchasableAmount(product, loanAmount) {
    if (!product.formulas.purchasableAmount) throw new Error('فرمول «مبلغ قابل دریافت» تعریف نشده است.');
    const vars = this._loanBaseVars(product, {
      loanAmount: Number(loanAmount) || 0,
      remainingBalance: Number(loanAmount) || 0
    });
    return FormulaEngine.eval(product.formulas.purchasableAmount, vars);
  },
  // محاسبه مبلغ وام از مبلغ قابل دریافت (معکوس). اگر مدیر فرمول معکوس صریح تعریف کرده
  // باشد از همان استفاده می‌کند؛ در غیر این صورت با نمونه‌گیری دو نقطه، فرض خطی بودن
  // را بررسی می‌کند و ضرایب را به‌دست می‌آورد. این روش برای اکثر وام‌های واقعی که
  // purchasable = a*loanAmount + b هستند کافی است.
  solveLoanAmountFromPurchasable(product, purchasableAmount) {
    const target = Number(purchasableAmount) || 0;
    if (product.formulas.loanAmountFromPurchasable && product.formulas.loanAmountFromPurchasable.trim()) {
      const vars = this._loanBaseVars(product, { purchasableAmount: target });
      return FormulaEngine.eval(product.formulas.loanAmountFromPurchasable, vars);
    }
    // نمونه‌گیری خطی: f(L) = a*L + b
    const f = (L) => {
      const vars = this._loanBaseVars(product, { loanAmount: L, remainingBalance: L });
      return FormulaEngine.eval(product.formulas.purchasableAmount, vars);
    };
    const b = f(0);
    const f1 = f(1000000); // یک میلیون به‌عنوان نقطه نمونه (نه صفر تا تقسیم بر صفر نشود)
    const a = (f1 - b) / 1000000;
    if (Math.abs(a) < 1e-12) {
      throw new Error('فرمول قدرت خرید نسبت به مبلغ وام ثابت است؛ معکوس‌سازی ممکن نیست. لطفاً فرمول معکوس را در پنل مدیریت وارد کنید.');
    }
    const result = (target - b) / a;
    if (!isFinite(result) || result < 0) {
      throw new Error('مبلغ وام محاسبه‌شده نامعتبر است. فرمول قدرت خرید را بررسی کنید.');
    }
    return result;
  },
  // ساخت جدول کامل اقساط. منطق کاهش مانده:
  //   - قسط اول و اقساط خاص = هزینه/کمیسیون (مانده را تغییر نمی‌دهند)
  //   - سایر اقساط = اصل وام را تقسیم می‌کنند (مانده را کاهش می‌دهند)
  // این منطق با مثال بانک مهر ایران تطبیق دارد و برای اکثر وام‌های بانکی ایرانی قابل‌اعمال است.
  // اگر مدیر منطق متفاوتی خواست، می‌تواند در توضیحات محصول قید کند.
  buildLoanSchedule(product, loanAmount) {
    const L = Number(loanAmount) || 0;
    if (L <= 0) throw new Error('مبلغ وام باید بزرگ‌تر از صفر باشد.');
    if (!product.formulas.firstInstallment) throw new Error('فرمول «قسط اول» تعریف نشده است.');
    if (!product.formulas.otherInstallments) throw new Error('فرمول «سایر اقساط» تعریف نشده است.');
    const n = product.installmentsCount;
    const specialMap = {};
    (product.formulas.specialInstallments || []).forEach(s => { specialMap[s.installmentNumber] = s; });
    let remaining = L;
    const schedule = [];
    for (let i = 1; i <= n; i++) {
      let entry;
      const vars = this._loanBaseVars(product, {
        loanAmount: L,
        remainingBalance: remaining,
        installmentNumber: i,
        paidCount: i - 1,
        paidPrincipal: L - remaining
      });
      if (i === 1) {
        // قسط اول: مبلغ را گرد می‌کنیم (قسط همیشه عدد صحیح تومان است)
        const amount = Math.round(FormulaEngine.eval(product.formulas.firstInstallment, vars));
        entry = { number: 1, label: 'قسط اول', amount, kind: 'first', reducesBalance: false };
      } else if (specialMap[i]) {
        const s = specialMap[i];
        const amount = Math.round(FormulaEngine.eval(s.formula, vars));
        entry = { number: i, label: s.label || ('قسط ' + i), amount, kind: 'special', reducesBalance: false };
      } else {
        const amount = Math.round(FormulaEngine.eval(product.formulas.otherInstallments, vars));
        entry = { number: i, label: 'قسط ' + i, amount, kind: 'other', reducesBalance: true };
      }
      schedule.push(entry);
      if (entry.reducesBalance) remaining = Math.max(0, remaining - entry.amount);
    }
    const purchasable = Math.round(this.computePurchasableAmount(product, L));
    const totalPayable = schedule.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    return {
      loanAmount: L,
      installmentsCount: n,
      purchasableAmount: purchasable,
      totalPayable,
      totalExtra: totalPayable - L,
      schedule
    };
  },
  // یک محاسبه کامل برای نمایش در بخش کاربر. inputMode: 'loanAmount' | 'purchasableAmount'
  calculateLoan(product, inputAmount, inputMode) {
    let loanAmount;
    if (inputMode === 'purchasableAmount') {
      loanAmount = this.solveLoanAmountFromPurchasable(product, inputAmount);
      // گرد کردن مبلغ وام به نزدیک‌ترین عدد صحیح (تومان) - مبلغ وام اعشاری گیج‌کننده است
      loanAmount = Math.round(loanAmount);
    } else {
      loanAmount = Number(inputAmount) || 0;
    }
    const result = this.buildLoanSchedule(product, loanAmount);
    // اگر ورودی قدرت خرید بود، همان مقدار را در خروجی تأیید می‌کنیم؛ در غیر این صورت
    // مقدار محاسبه‌شده از فرمول را برمی‌گردانیم (که ممکن است به‌دلیل گردکردن کمی متفاوت باشد).
    if (inputMode === 'purchasableAmount') {
      result.purchasableAmount = Number(inputAmount) || 0;
      result.requestedPurchasableAmount = Number(inputAmount) || 0;
    } else {
      result.requestedLoanAmount = Number(inputAmount) || 0;
    }
    // هشدار منطقی: اگه totalPayable خیلی بزرگتر از loanAmount باشه (مثلاً 3 برابر)،
    // احتمالاً فرمول اشتباه است یا remaining زودتر صفر شده. در schedule این رو علامت می‌زنیم.
    if (result.totalPayable > result.loanAmount * 3) {
      result.warning = 'مجموع بازپرداخت به‌طور غیرعادی بزرگ‌تر از مبلغ وام است. فرمول‌ها را بررسی کنید — ممکن است مانده وام زودتر از موعد صفر شده باشد.';
    }
    return result;
  },

  // ---------- GROUP CHAT (admin-gated) ----------
  // Single shared group thread. Available to admins always; available to a
  // caller/processor only when BOTH the global switch (settings.chatEnabled) and
  // that specific user's canChat flag are on - both are controlled by the admin.
  canUseChat(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const s = this.getSettings();
    return !!s.chatEnabled && !!user.canChat;
  },
  getChatMessages() { return this.load().chatMessages; },
  addChatMessage({ text }, user) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const d = this.load();
    const msg = {
      id: uid('cm'), senderId: user.id, senderName: user.name, senderRole: user.role,
      text: clean, createdAt: nowISO(), updatedAt: nowISO()
    };
    d.chatMessages.push(msg);
    this.save();
    if (window.CloudSync) CloudSync.pushChatMessage(msg);
    return msg;
  },
  deleteChatMessage(id) {
    this.removeChatMessageLocal(id);
    if (window.CloudSync) CloudSync.deleteChatMessage(id);
  },

  // ---------- USERS ----------
  getUsers() { return this.load().users; },
  getUser(id) { return this.load().users.find(u => u.id === id); },
  getUserByUsername(username) {
    return this.load().users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  },
  async addUser({ name, username, password, role, canSeeLeadPurchase, canReviewTakenLeads, canChat, canProcessCustomers }) {
    const d = this.load();
    username = String(username || '').trim();
    if (this.getUserByUsername(username)) throw new Error('این نام کاربری قبلاً استفاده شده است.');
    const user = {
      id: uid('u'), name, username, passwordHash: await hashPassword(password),
      role, active: true, canSeeLeadPurchase: !!canSeeLeadPurchase, canReviewTakenLeads: !!canReviewTakenLeads, canChat: !!canChat,
      canProcessCustomers: !!canProcessCustomers,
      commissionPayments: [], // running ledger of commission payments made to this user
      createdAt: nowISO(), updatedAt: nowISO()
    };
    d.users.push(user);
    this.save();
    if (window.CloudSync) CloudSync.pushUser(user);
    this.logAudit({ entity: 'user', entityId: user.id, action: 'create',
      summary: `ایجاد کاربر «${user.name}» (${user.username}) با نقش ${user.role}` }, this._actor());
    return user;
  },
  async updateUser(id, patch) {
    const d = this.load();
    const u = d.users.find(x => x.id === id);
    if (!u) return null;
    // Same duplicate-username guard as addUser(): renaming an existing user to a username
    // already used by someone ELSE must be rejected too, not just blocked at creation time.
    if (patch.username) {
      patch.username = String(patch.username).trim();
      const existing = this.getUserByUsername(patch.username);
      if (existing && existing.id !== id) throw new Error('این نام کاربری قبلاً برای کاربر دیگری استفاده شده است.');
    }
    const activeChanged = (patch.active !== undefined && patch.active !== u.active);
    const hadPasswordChange = !!patch.password;
    const skipGenericAudit = !!patch._skipGenericAudit;
    delete patch._skipGenericAudit;
    if (patch.password) { patch.passwordHash = await hashPassword(patch.password); delete patch.password; }
    Object.assign(u, patch);
    delete u.isSeedDefault; // an explicit edit confirms this is now a real, intentional account
    u.updatedAt = nowISO();
    this.save();
    if (window.CloudSync) CloudSync.pushUser(u);
    if (activeChanged) {
      this.logAudit({ entity: 'user', entityId: u.id, action: u.active ? 'activate' : 'deactivate',
        summary: `${u.active ? 'فعال‌سازی' : 'غیرفعال‌سازی'} کاربر «${u.name}» (${u.username})` }, this._actor());
    } else if (hadPasswordChange) {
      this.logAudit({ entity: 'user', entityId: u.id, action: 'password_change',
        summary: `تغییر رمز عبور کاربر «${u.name}» (${u.username})` }, this._actor());
    } else if (!skipGenericAudit) {
      this.logAudit({ entity: 'user', entityId: u.id, action: 'update',
        summary: `ویرایش اطلاعات کاربر «${u.name}» (${u.username})` }, this._actor());
    }
    return u;
  },
  // Called by CloudSync once the real users list has arrived from Firestore. If this device's
  // local storage still holds any untouched, auto-seeded default admin (isSeedDefault) and the
  // cloud already has a REAL admin account (a different id, same username OR any admin account
  // at all), drop ALL local seed admins so this device converges on the one real account.
  // If the user is logged in as one of the seed admins, transparently switch the session to
  // the real admin before dropping the seed(s).
  removeSeedDefaultAdminIfSuperseded(incomingUsers) {
    const d = this.load();
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: ALL local users at start:', d.users.length, d.users.map(u => u.id + '(seed=' + (u.isSeedDefault === true) + ')'));
    const seedUsers = d.users.filter(u => u.isSeedDefault);
    if (!seedUsers.length) { console.info('[DB] removeSeedDefaultAdminIfSuperseded: no local seed admins, skipping'); return; }
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: found', seedUsers.length, 'local seed admin(s):', seedUsers.map(s => s.id));
    // Find all real admins from cloud (not seedDefault). If there are multiple (duplicates
    // from before the isSeedDefault guard existed), pick the NEWEST one — that's the one
    // deduplicateCloudAdmins will keep, so switching the session to it is safe.
    const realAdmins = incomingUsers.filter(u => !u.isSeedDefault && u.role === 'admin');
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: real admins from cloud:', realAdmins.length, realAdmins.map(a => a.id + '(' + (a.name || '?') + ')'));
    if (!realAdmins.length) { console.info('[DB] removeSeedDefaultAdminIfSuperseded: no real admin in cloud, keeping seed'); return; }
    // Sort by updatedAt descending — newest first. This matches deduplicateCloudAdmins' logic.
    realAdmins.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    const realAdmin = realAdmins[0];
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: picked newest real admin:', realAdmin.id, '(' + (realAdmin.name || '?') + ')');
    const activeSessionId = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('loanCRM_session') : null;
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: current session:', activeSessionId);
    // If the user is logged in as ANY of the seed admins, switch their session to the real admin
    // before dropping all seeds.
    const activeSeed = seedUsers.find(s => s.id === activeSessionId);
    if (activeSeed) {
      console.info('[DB] removeSeedDefaultAdminIfSuperseded: session was on seed, switching to real admin:', realAdmin.id);
      sessionStorage.setItem('loanCRM_session', realAdmin.id);
      if (typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.id === activeSeed.id) {
        CURRENT_USER.id = realAdmin.id;
        CURRENT_USER.passwordHash = realAdmin.passwordHash;
        CURRENT_USER.name = realAdmin.name;
        console.info('[DB] removeSeedDefaultAdminIfSuperseded: CURRENT_USER updated to:', CURRENT_USER.id);
      }
    } else {
      console.info('[DB] removeSeedDefaultAdminIfSuperseded: session not on a seed, no switch needed');
    }
    // Remove ALL seed-default admins. IMPORTANT: make sure the real admin from cloud is in
    // local storage before removing the seed — otherwise we end up with 0 users. The upsert
    // happens before this function is called (in the snapshot handler), but let's verify.
    const realAdminInLocal = d.users.find(u => u.id === realAdmin.id);
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: real admin in local before remove?', !!realAdminInLocal, 'realAdmin.id:', realAdmin.id, 'local ids:', d.users.map(u => u.id));
    if (!realAdminInLocal) {
      // The real admin from cloud hasn't been upserted yet (shouldn't happen, but defensive).
      // Force-upsert it now so we don't end up with 0 users.
      console.info('[DB] removeSeedDefaultAdminIfSuperseded: WARNING — real admin not in local, force-upserting before seed removal');
      this.upsertUser(realAdmin, { skipCloud: true });
    }
    const seedIds = new Set(seedUsers.map(s => s.id));
    d.users = d.users.filter(u => !seedIds.has(u.id));
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: after filter, users count:', d.users.length, d.users.map(u => u.id));
    // CRITICAL safety net: if after removing seeds we have 0 users, but we know the real admin
    // exists in cloud, force-add it. This prevents the "0 users" bug where the user gets logged
    // out and can't log back in.
    if (d.users.length === 0 && realAdmin) {
      console.info('[DB] removeSeedDefaultAdminIfSuperseded: SAFETY NET — 0 users after seed removal, force-adding real admin:', realAdmin.id);
      d.users.push(realAdmin);
    }
    this.save({ skipCloud: true });
    console.info('[DB] removeSeedDefaultAdminIfSuperseded: removed', seedUsers.length, 'seed admin(s)');
  },
  // Detects and removes DUPLICATE admin accounts that were accidentally pushed to Firestore
  // before the isSeedDefault guard existed. If multiple cloud users share the same username
  // (e.g. three "admin" accounts from three different devices that each pushed their seed),
  // keep only the newest one (largest updatedAt) and mark the others for deletion. This runs
  // after every cloud snapshot so duplicates are cleaned up automatically over time.
  // IMPORTANT: never deletes the admin that the current session is logged in as — that would
  // log the user out. If the session admin is one of the duplicates, we keep it instead of the
  // newest one.
  deduplicateCloudAdmins(incomingUsers) {
    // Group admin-role users by username
    const adminByUsername = {};
    incomingUsers.forEach(u => {
      if (u.role !== 'admin') return;
      if (!adminByUsername[u.username]) adminByUsername[u.username] = [];
      adminByUsername[u.username].push(u);
    });
    const activeSessionId = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('loanCRM_session') : null;
    console.info('[DB] deduplicateCloudAdmins: incoming admins:', Object.keys(adminByUsername).map(k => k + '(' + adminByUsername[k].length + ')'), '| session:', activeSessionId);
    // For each username with more than one admin, find the ones to delete (all but newest)
    const toDelete = [];
    Object.keys(adminByUsername).forEach(username => {
      const admins = adminByUsername[username];
      if (admins.length <= 1) return;
      // Sort by updatedAt descending — newest first
      admins.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      // Keep the newest, UNLESS the session admin is one of the duplicates — then keep that one
      // instead (deleting it would log the user out mid-session).
      let keepIndex = 0;
      if (activeSessionId) {
        const sessionIndex = admins.findIndex(a => a.id === activeSessionId);
        if (sessionIndex > 0) keepIndex = sessionIndex;
      }
      const keep = admins[keepIndex];
      console.info('[DB] deduplicateCloudAdmins: username="' + username + '" has', admins.length, 'admins, keeping:', keep.id, '| deleting:', admins.filter((_, i) => i !== keepIndex).map(a => a.id));
      admins.forEach((dup, idx) => {
        if (idx === keepIndex) return;
        toDelete.push({ id: dup.id, username, name: dup.name });
      });
    });
    console.info('[DB] deduplicateCloudAdmins: total to delete:', toDelete.length);
    return toDelete;
  },
  // Same pattern as removeSeedDefaultAdminIfSuperseded, but for loan products. Every brand-new
  // device seeds its own "بانک مهر ایران" example product the instant it opens the app. Without
  // this, each device that ever opened the app would push its own copy (different id, same bank
  // name) up to Firestore, creating N duplicates. Once the real cloud list arrives, we drop the
  // local placeholder IF the cloud already has ANY product (real or otherwise) — meaning
  // someone has already set up products on another device and this seed is now redundant.
  // We also deduplicate by bank name: if the cloud already has a product with the same bank
  // name as the local seed, the seed is dropped.
  removeSeedDefaultLoanProductIfSuperseded(incomingProducts) {
    const d = this.load();
    const seedProducts = d.loanProducts.filter(p => p.isSeedDefault);
    if (!seedProducts.length) return;
    // If the cloud has ANY product, local seed products are redundant.
    // This handles the multi-device case: device A seeds its product, device B opens the app
    // and seeds its own, but when device B's snapshot arrives it sees device A's product and
    // drops its own seed.
    if (incomingProducts.length > 0) {
      const removed = d.loanProducts.filter(p => p.isSeedDefault);
      d.loanProducts = d.loanProducts.filter(p => !p.isSeedDefault);
      this.save({ skipCloud: true });
      console.info('[DB] removed', removed.length, 'seed-default loan product(s) — superseded by cloud data');
      return;
    }
    // Secondary guard: even if cloud is empty, if there are MULTIPLE local seed products
    // (which can happen if a device re-seeds for any reason), keep only the newest one.
    // This prevents accumulation of duplicates on a single device over time.
    if (seedProducts.length > 1) {
      // Keep the newest (largest createdAt), drop the rest
      seedProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const toRemove = seedProducts.slice(1);
      const removeIds = new Set(toRemove.map(p => p.id));
      d.loanProducts = d.loanProducts.filter(p => !removeIds.has(p.id));
      this.save({ skipCloud: true });
      console.info('[DB] removed', toRemove.length, 'duplicate seed-default loan product(s) — kept only newest');
    }
  },
  // Detects and removes DUPLICATE loan products that were accidentally pushed to Firestore
  // before the isSeedDefault guard existed (or that share the same bankName + schemeName).
  // If multiple cloud products share the same bankName + schemeName, keep only the newest
  // one (largest updatedAt) and mark the others for deletion. This runs after every cloud
  // snapshot so duplicates are cleaned up automatically.
  deduplicateCloudLoanProducts(incomingProducts) {
    // Group products by bankName + schemeName
    const productByKey = {};
    incomingProducts.forEach(p => {
      const key = (p.bankName || '') + '||' + (p.schemeName || '');
      if (!productByKey[key]) productByKey[key] = [];
      productByKey[key].push(p);
    });
    console.info('[DB] deduplicateCloudLoanProducts: incoming products:', Object.keys(productByKey).map(k => k + '(' + productByKey[k].length + ')'));
    const toDelete = [];
    Object.keys(productByKey).forEach(key => {
      const products = productByKey[key];
      if (products.length <= 1) return;
      // Sort by updatedAt descending — newest first
      products.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      const keep = products[0];
      const duplicates = products.slice(1);
      console.info('[DB] deduplicateCloudLoanProducts: key="' + key + '" has', products.length, 'products, keeping:', keep.id, '| deleting:', duplicates.map(p => p.id));
      duplicates.forEach(dup => {
        toDelete.push({ id: dup.id, bankName: dup.bankName, schemeName: dup.schemeName });
      });
    });
    console.info('[DB] deduplicateCloudLoanProducts: total to delete:', toDelete.length);
    return toDelete;
  },
  async authenticate(username, password) {
    const u = this.getUserByUsername(username);
    if (!u || !u.active) return null;
    const ok = await verifyPassword(password, u.passwordHash);
    if (!ok) return null;
    // Transparently upgrade an older hash (legacy simpleHash, or the previous-gen sha256$)
    // to the current secure format the moment we have the plaintext password in hand
    // anyway - existing accounts self-heal on their very next successful login, no manual
    // password reset needed.
    if (!u.passwordHash.startsWith('pbkdf2$')) {
      u.passwordHash = await hashPassword(password);
      u.updatedAt = nowISO();
      this.save();
      // CRITICAL: never push a seed-default admin to the cloud, even after a hash upgrade.
      // The seed admin is a per-device placeholder; pushing it would create a duplicate
      // "admin" document in Firestore (different id, same username) that every other device
      // would then pull down — this is exactly what caused the "مدیر سیستم" duplication bug.
      // Once the real admin arrives from cloud, removeSeedDefaultAdminIfSuperseded will drop
      // this seed locally. The hash upgrade is saved locally only.
      if (window.CloudSync && !u.isSeedDefault) CloudSync.pushUser(u);
    }
    return u;
  },

  // ---------- LEADS (جذب تلفنی توسط کاربر تماس) ----------
  getLeads() { return this.load().leads; },
  getLeadsByCaller(callerId) { return this.load().leads.filter(l => l.callerId === callerId); },
  addLead({ callerId, name, phone, nationalId, note, requestType, goodsType }) {
    const d = this.load();
    const lead = {
      id: uid('l'), callerId, name: name || '', phone: normalizePhone(phone),
      rawPhone: phone, nationalId: normalizeNationalId(nationalId), note: note || '',
      requestType: requestType === 'goods' ? 'goods' : 'loan', // 'loan' | 'goods'
      goodsType: requestType === 'goods' ? (goodsType || '') : '',
      followUpStatus: 'awaiting_visit', // awaiting_visit | in_progress | incomplete_docs | follow_up | taken_by_other
      matchedCustomerId: null, createdAt: nowISO(), updatedAt: nowISO()
    };
    d.leads.push(lead);
    this.save();
    if (window.CloudSync) CloudSync.pushLead(lead);
    this.logAudit({ entity: 'lead', entityId: lead.id, action: 'create',
      summary: `ثبت لید جدید «${lead.name || 'بدون نام'}» (${lead.phone || '-'})` }, this._actor());

    // ---- duplicate-detection (never auto-links a caller's lead anymore) ----
    // A customer may already have been registered by the office BEFORE this lead was
    // logged (order isn't always caller-then-office in real life), AND/OR another lead
    // (same caller or a different caller) may already exist for the same person. Any
    // of these is now treated the SAME way: never silently auto-link/ignore - always
    // flag it (named, when there's exactly one match) and send it to the admin queue.
    // Only in the office->customer direction (see addCustomer below) does auto-linking
    // still happen automatically, per explicit request.
    const customerMatches = this.findExactMatchingCustomersAny(lead.phone, lead.nationalId);
    const otherLeadMatches = this.findExactMatchingLeads(lead.phone, lead.nationalId)
      .filter(l => l.id !== lead.id);
    const totalMatches = customerMatches.length + otherLeadMatches.length;

    let ambiguous = false, flaggedDuplicate = false, conflictDetail = null, nameMatches = [];

    if (totalMatches === 0) {
      // unchanged from before: only name-similarity, needs manager confirmation, no
      // direct warning shown to the caller at entry time.
      nameMatches = this.findNameMatchingCustomers(lead.name, lead.phone, lead.nationalId);
      nameMatches.forEach(c => this.createPendingMatch(lead.id, c.id, 'name'));
    } else if (totalMatches === 1) {
      flaggedDuplicate = true;
      if (customerMatches.length === 1) {
        const cust = customerMatches[0];
        this.createPendingMatch(lead.id, cust.id, 'exact');
        const ownerId = cust.callerId || cust.processorId || null;
        // If a caller is already attached to this customer, prefer THEIR lead's own
        // createdAt (the moment they actually registered it) over the customer record's
        // createdAt (which reflects when the office created the customer - a possibly
        // unrelated/earlier moment) - more accurate for "چه زمانی ثبت کرد".
        let matchedAt = cust.createdAt;
        if (cust.callerId) {
          const ownerLead = d.leads.find(l => l.matchedCustomerId === cust.id && l.callerId === cust.callerId);
          if (ownerLead) matchedAt = ownerLead.createdAt;
        }
        conflictDetail = {
          kind: 'customer', isSelf: false,
          ownerUserId: ownerId, ownerName: this._userLabel(ownerId),
          matchedAt
        };
      } else {
        const otherLead = otherLeadMatches[0];
        const isSelf = otherLead.callerId === callerId;
        this.createLeadConflict(otherLead.id, lead.id, isSelf ? 'self' : 'other-caller');
        conflictDetail = {
          kind: 'lead', isSelf,
          ownerUserId: otherLead.callerId, ownerName: this._userLabel(otherLead.callerId),
          matchedAt: otherLead.createdAt
        };
      }
    } else {
      // more than one prior record matches - genuinely ambiguous, don't name anyone,
      // send everything to the admin queue for manual review.
      ambiguous = true;
      customerMatches.forEach(c => this.createPendingMatch(lead.id, c.id, 'exact'));
      otherLeadMatches.forEach(l => {
        const isSelf = l.callerId === callerId;
        this.createLeadConflict(l.id, lead.id, isSelf ? 'self' : 'other-caller');
      });
    }

    return { lead, autoLinked: false, ambiguous, flaggedDuplicate, conflictDetail, nameMatches };
  },
  // small helper for building human-readable "ثبت‌شده توسط ..." messages
  _userLabel(userId) {
    if (!userId) return 'نامشخص';
    const u = this.getUser(userId);
    if (!u) return 'نامشخص';
    // ROLE_LABELS is defined in app.js (loaded after db.js), but this helper is only
    // ever called at runtime - well after both scripts have executed - so the global
    // is available by call time even though it doesn't exist yet when db.js parses.
    const roleLabel = (typeof ROLE_LABELS !== 'undefined' && ROLE_LABELS[u.role]) || '';
    return roleLabel ? `${u.name} (${roleLabel})` : u.name;
  },
  // Like findExactMatchingCustomers, but WITHOUT the "!c.callerId" restriction - used for
  // duplicate-detection purposes, where we need to know about a match regardless of whether
  // it already has a caller assigned (e.g. it could already be assigned to a DIFFERENT caller
  // than the one registering right now, which is exactly the conflict we want to catch).
  findExactMatchingCustomersAny(phone, nationalId) {
    const d = this.load();
    const np = normalizePhone(phone);
    const nid = normalizeNationalId(nationalId);
    return d.customers.filter(c => (
      (np && (normalizePhone(c.phone) === np || (c.phone2 && normalizePhone(c.phone2) === np)))
      || (nid && c.nationalId && normalizeNationalId(c.nationalId) === nid)
    ));
  },

  // ---------- CUSTOMER CONFLICTS (customer <-> customer duplicate warnings, needs admin review) ----------
  // Raised when a customer is registered directly (no lead involved) whose phone/national id
  // exactly matches ANOTHER customer that was also registered directly - see addCustomer()
  // below. Neither pendingMatches (always lead<->customer) nor leadConflicts (always
  // lead<->lead) ever catches this case, because both only ever compare against leads -
  // addCustomer only checked leads for a match before this existed, so two customers created
  // straight from the office (e.g. by two different processors, or the same one twice) with
  // the same phone/national id could both sail through to "completed" with no warning at all.
  // Same shape/semantics as leadConflicts: purely a notification/audit trail, never merges,
  // blocks, or auto-decides anything.
  findExactMatchingCustomersOther(customer) {
    const d = this.load();
    const np = normalizePhone(customer.phone);
    const np2 = normalizePhone(customer.phone2);
    const nid = normalizeNationalId(customer.nationalId);
    return d.customers.filter(c => c.id !== customer.id && (
      (np && (normalizePhone(c.phone) === np || (c.phone2 && normalizePhone(c.phone2) === np)))
      || (np2 && (normalizePhone(c.phone) === np2 || (c.phone2 && normalizePhone(c.phone2) === np2)))
      || (nid && c.nationalId && normalizeNationalId(c.nationalId) === nid)
    ));
  },
  createCustomerConflict(customerAId, customerBId, kind) {
    const d = this.load();
    const exists = d.customerConflicts.find(cc => !cc.resolved &&
      ((cc.customerAId === customerAId && cc.customerBId === customerBId) || (cc.customerAId === customerBId && cc.customerBId === customerAId)));
    if (exists) return exists;
    const cc = { id: uid('cc'), customerAId, customerBId, kind: kind || 'exact', resolved: false, decision: null, createdAt: nowISO(), updatedAt: nowISO() };
    d.customerConflicts.push(cc);
    this.save();
    if (window.CloudSync) CloudSync.pushCustomerConflict(cc);
    return cc;
  },
  getCustomerConflicts() {
    const d = this.load();
    return d.customerConflicts.filter(cc => {
      if (cc.resolved) return false;
      const a = d.customers.find(c => c.id === cc.customerAId);
      const b = d.customers.find(c => c.id === cc.customerBId);
      return !!a && !!b; // if either customer was since deleted, this conflict is stale
    });
  },
  // decision: 'duplicate' (admin confirms it really is the same person registered twice) or
  // 'separate' (admin confirms these are genuinely two different/legitimate registrations,
  // e.g. the same person taking a second, later loan).
  resolveCustomerConflict(id, decision) {
    const d = this.load();
    const cc = d.customerConflicts.find(x => x.id === id);
    if (!cc) return;
    cc.resolved = true;
    cc.decision = decision || 'duplicate';
    cc.updatedAt = nowISO();
    this.save();
    if (window.CloudSync) CloudSync.pushCustomerConflict(cc);
    const a = d.customers.find(c => c.id === cc.customerAId), b = d.customers.find(c => c.id === cc.customerBId);
    this.logAudit({ entity: 'customerConflict', entityId: cc.id, action: 'resolve',
      summary: `بررسی هشدار تکراری‌بودن مشتری «${a ? (a.name || 'بدون نام') : ''}» / «${b ? (b.name || 'بدون نام') : ''}» — تصمیم: ${cc.decision === 'separate' ? 'دو مورد جداگانه' : 'تکراری تایید شد'}` }, this._actor());
    return cc;
  },

  // ---------- LEAD CONFLICTS (lead <-> lead duplicate warnings, needs admin review) ----------
  // Raised when a caller registers a lead whose phone/national id exactly matches another
  // lead that ALREADY exists (from another caller, or from the very same caller registering
  // the same person again) - see addLead() above. This is purely a notification/audit trail:
  // it does not merge, block, or auto-decide anything. Commission itself is only ever
  // attached to a "customer" record, and that assignment continues to be governed entirely
  // by the existing lead<->customer matching/pendingMatch flow, which already resolves
  // ambiguity correctly when more than one lead points at the same customer.
  createLeadConflict(leadAId, leadBId, kind) {
    const d = this.load();
    const exists = d.leadConflicts.find(lc => !lc.resolved &&
      ((lc.leadAId === leadAId && lc.leadBId === leadBId) || (lc.leadAId === leadBId && lc.leadBId === leadAId)));
    if (exists) return exists;
    const lc = { id: uid('lc'), leadAId, leadBId, kind: kind || 'other-caller', resolved: false, decision: null, createdAt: nowISO(), updatedAt: nowISO() };
    d.leadConflicts.push(lc);
    this.save();
    if (window.CloudSync) CloudSync.pushLeadConflict(lc);
    return lc;
  },
  getLeadConflicts() {
    const d = this.load();
    return d.leadConflicts.filter(lc => {
      if (lc.resolved) return false;
      const a = d.leads.find(l => l.id === lc.leadAId);
      const b = d.leads.find(l => l.id === lc.leadBId);
      return !!a && !!b; // if either lead was since deleted, this conflict is stale
    });
  },
  // decision: 'duplicate' (admin confirms it really is the same person registered twice -
  //           reviewed/acknowledged, no further action needed here) or
  //           'separate' (admin confirms these are genuinely two different/legitimate
  //           registrations, e.g. same person taking a second, later loan).
  resolveLeadConflict(id, decision) {
    const d = this.load();
    const lc = d.leadConflicts.find(x => x.id === id);
    if (!lc) return;
    lc.resolved = true;
    lc.decision = decision || 'duplicate';
    lc.updatedAt = nowISO();
    this.save();
    if (window.CloudSync) CloudSync.pushLeadConflict(lc);
    const a = d.leads.find(l => l.id === lc.leadAId), b = d.leads.find(l => l.id === lc.leadBId);
    this.logAudit({ entity: 'leadConflict', entityId: lc.id, action: 'resolve',
      summary: `بررسی هشدار تکراری‌بودن «${a ? (a.name || 'بدون نام') : ''}» / «${b ? (b.name || 'بدون نام') : ''}» — تصمیم: ${lc.decision === 'separate' ? 'دو مورد جداگانه' : 'تکراری تایید شد'}` }, this._actor());
    return lc;
  },
  updateLead(id, patch) {
    const d = this.load();
    const lead = d.leads.find(l => l.id === id);
    if (!lead) return null;
    const wasTakenByOther = lead.followUpStatus === 'taken_by_other';
    const prevStatus = lead.followUpStatus;
    Object.assign(lead, patch);
    // Whenever a lead is freshly marked (or re-marked, after a previous occurrence was
    // already reviewed and dismissed) "وامش را با نام شخص دیگر گرفته", surface it again
    // in the admin/authorized-reviewer queue - see getTakenByOtherLeads() below.
    if (!wasTakenByOther && lead.followUpStatus === 'taken_by_other') {
      lead.takenByOtherReviewed = false;
      lead.takenByOtherFlaggedAt = nowISO();
    }
    lead.updatedAt = nowISO();
    this.save();
    if (window.CloudSync) CloudSync.pushLead(lead);
    // فقط تغییر وضعیت پیگیری ثبت می‌شود (نه هر ویرایش جزئی مثل یادداشت) تا تاریخچه شلوغ نشود.
    if (patch.followUpStatus !== undefined && patch.followUpStatus !== prevStatus) {
      this.logAudit({ entity: 'lead', entityId: lead.id, action: 'status_change',
        summary: `تغییر وضعیت لید «${lead.name || 'بدون نام'}» به «${lead.followUpStatus}»` }, this._actor());
    }
    return lead;
  },
  // exact match => safe to auto-link directly (phone or national ID). Both sides are
  // re-normalized here (not just trusted from storage) so it works regardless of how
  // the value was typed (Persian/English digits, spaces, leading zero, etc.).
  // phone2 (optional): a customer's second phone number, if any - checked the same way as
  // the primary phone so a lead registered under either of a customer's two numbers is
  // still found.
  findExactMatchingLeads(phone, nationalId, phone2) {
    const d = this.load();
    const np = normalizePhone(phone);
    const np2 = normalizePhone(phone2);
    const nid = normalizeNationalId(nationalId);
    return d.leads.filter(l => !l.matchedCustomerId && (
      (np && normalizePhone(l.phone) === np) || (np2 && normalizePhone(l.phone) === np2)
      || (nid && l.nationalId && normalizeNationalId(l.nationalId) === nid)
    ));
  },
  // name-only similarity => NOT auto-linked, requires admin confirmation
  findNameMatchingLeads(name, excludePhone, excludeNationalId, excludePhone2) {
    const d = this.load();
    const nn = normalizeName(name);
    if (!nn) return [];
    const np = normalizePhone(excludePhone);
    const np2 = normalizePhone(excludePhone2);
    const nid = normalizeNationalId(excludeNationalId);
    return d.leads.filter(l => {
      if (l.matchedCustomerId) return false;
      if (np && normalizePhone(l.phone) === np) return false; // already covered by exact match
      if (np2 && normalizePhone(l.phone) === np2) return false;
      if (nid && l.nationalId && normalizeNationalId(l.nationalId) === nid) return false;
      return normalizeName(l.name) === nn;
    });
  },
  // Reverse direction of the two functions above: given a lead's info, find customers
  // already registered by the office that could be that same person.
  findExactMatchingCustomers(phone, nationalId) {
    const d = this.load();
    const np = normalizePhone(phone);
    const nid = normalizeNationalId(nationalId);
    return d.customers.filter(c => !c.callerId && (
      (np && (normalizePhone(c.phone) === np || (c.phone2 && normalizePhone(c.phone2) === np)))
      || (nid && c.nationalId && normalizeNationalId(c.nationalId) === nid)
    ));
  },
  findNameMatchingCustomers(name, excludePhone, excludeNationalId) {
    const d = this.load();
    const nn = normalizeName(name);
    if (!nn) return [];
    const np = normalizePhone(excludePhone);
    const nid = normalizeNationalId(excludeNationalId);
    return d.customers.filter(c => {
      if (c.callerId) return false;
      if (np && (normalizePhone(c.phone) === np || (c.phone2 && normalizePhone(c.phone2) === np))) return false;
      if (nid && c.nationalId && normalizeNationalId(c.nationalId) === nid) return false;
      return normalizeName(c.name) === nn;
    });
  },
  linkLeadToCustomer(leadId, customerId) {
    const d = this.load();
    const lead = d.leads.find(l => l.id === leadId);
    if (!lead) return;
    lead.matchedCustomerId = customerId;
    lead.updatedAt = nowISO();
    const cust = d.customers.find(c => c.id === customerId);
    if (cust) { cust.callerId = lead.callerId; cust.updatedAt = nowISO(); }
    this.save();
    if (window.CloudSync) { CloudSync.pushLead(lead); if (cust) CloudSync.pushCustomer(cust); }
  },
  unlinkLead(leadId) {
    const d = this.load();
    const lead = d.leads.find(l => l.id === leadId);
    if (!lead) return;
    const custId = lead.matchedCustomerId;
    lead.matchedCustomerId = null;
    lead.updatedAt = nowISO();
    if (custId) {
      const cust = d.customers.find(c => c.id === custId);
      if (cust && cust.callerId === lead.callerId) { cust.callerId = null; cust.updatedAt = nowISO(); if (window.CloudSync) CloudSync.pushCustomer(cust); }
    }
    this.save();
    if (window.CloudSync) CloudSync.pushLead(lead);
  },

  // ---------- PENDING MATCHES (needs manager approval) ----------
  // reason: 'name'  -> only the name looked similar (phone/national id differed or were empty)
  //         'exact' -> phone or national id matched exactly, but against MORE THAN ONE
  //                    lead/customer, so the admin must pick which one is correct
  getPendingMatches() {
    // فقط تطبیق‌های واقعاً unresolved. بررسیresolved کافی نیست — یک pendingMatch ممکن است
    // به‌صورت stale با resolved:true باقی بماند (مثلاً اگر snapshot listener قبل از حذف
    // محلی آن را بازگردانده باشد). همچنین فقط مواردی که lead و customer مرتبط هنوز
    // وجود دارند و lead هنوز متصل نشده (matchedCustomerId خالی) برگردانده می‌شوند.
    const d = this.load();
    return d.pendingMatches.filter(p => {
      if (p.resolved) return false;
      const lead = d.leads.find(l => l.id === p.leadId);
      const cust = d.customers.find(c => c.id === p.customerId);
      if (!lead || !cust) return false; // lead یا مشتری حذف شده — این تطبیق stale است
      // اگه lead قبلاً به مشتری متصل شده، این تطبیق دیگه معنی نداره
      if (lead.matchedCustomerId) return false;
      return true;
    });
  },
  createPendingMatch(leadId, customerId, reason) {
    const d = this.load();
    const exists = d.pendingMatches.find(p => p.leadId === leadId && p.customerId === customerId && !p.resolved);
    if (exists) return exists;
    const pm = { id: uid('pm'), leadId, customerId, reason: reason || 'name', resolved: false, decision: null, createdAt: nowISO(), updatedAt: nowISO() };
    d.pendingMatches.push(pm);
    this.save();
    if (window.CloudSync) CloudSync.pushPendingMatch(pm);
    return pm;
  },
  resolvePendingMatch(id, approve) {
    const d = this.load();
    const pm = d.pendingMatches.find(p => p.id === id);
    if (!pm) return;
    pm.resolved = true;
    pm.decision = approve ? 'approved' : 'rejected';
    pm.updatedAt = nowISO();
    if (approve) {
      this.linkLeadToCustomer(pm.leadId, pm.customerId);
      // a lead/customer can only end up linked to ONE counterpart, so once one pairing
      // is approved, any other still-pending pairing involving either side is moot -
      // auto-reject those instead of leaving stale items for the admin to clean up.
      d.pendingMatches
        .filter(p => p.id !== pm.id && !p.resolved && (p.leadId === pm.leadId || p.customerId === pm.customerId))
        .forEach(p => {
          p.resolved = true; p.decision = 'rejected'; p.updatedAt = nowISO();
          if (window.CloudSync) CloudSync.pushPendingMatch(p);
        });
    }
    this.save();
    if (window.CloudSync) CloudSync.pushPendingMatch(pm);
  },

  // ---------- CUSTOMER PROCESSING WORKFLOW ----------
  // Full stage machine: new -> awaiting_docs -> awaiting_score -> awaiting_withdrawal -> completed
  // Grouped into 3 display categories (per office request), same idea as lead follow-up groups.
  stageBucket(stage) {
    if (stage === 'completed') return 'completed';
    return 'incomplete_docs'; // awaiting_docs | awaiting_score | awaiting_withdrawal
  },
  // Admin can always record/approve a score (امتیاز) purchase; the admin can also grant
  // this to specific trusted users via the existing "دسترسی به خرید امتیاز" permission.
  canApproveScore(user) {
    if (!user) return false;
    return user.role === 'admin' || !!user.canSeeLeadPurchase;
  },
  // Customers whose office specialist marked docs complete and are awaiting the
  // manager/authorized person to record & approve the score purchase.
  getScoreRequests() {
    return this.load().customers.filter(c => c.stage === 'awaiting_score' && !(c.leadPurchase && c.leadPurchase.approved));
  },
  // Every completed file, system-wide (not just this user's own leads/office files) -
  // used by the second section of the "خرید امتیاز" page (see renderScoreRequests) so
  // whoever handles score-purchase approvals can also review the full history of
  // finished loans, since a customer only ever reaches 'completed' after its score
  // purchase was already approved by someone with this same canApproveScore right.
  getCompletedCustomers() {
    return this.load().customers.filter(c => c.stage === 'completed');
  },

  // Admin can always review "وامش را با نام شخص دیگر گرفته" reports from callers; can
  // also grant this to specific trusted users via canReviewTakenLeads (same pattern as
  // canApproveScore/canSeeLeadPurchase above).
  canReviewTakenLeads(user) {
    if (!user) return false;
    return user.role === 'admin' || !!user.canReviewTakenLeads;
  },
  // Leads a caller flagged as "taken by someone else", not yet reviewed/dismissed by an
  // admin/authorized person. This is how that customer's details get "sent" for review -
  // it surfaces here (with a nav badge, see app.js buildNav) the moment the caller sets it.
  getTakenByOtherLeads() {
    return this.load().leads.filter(l => l.followUpStatus === 'taken_by_other' && !l.takenByOtherReviewed);
  },
  markLeadReviewed(id) {
    return this.updateLead(id, { takenByOtherReviewed: true });
  },

  // A caller (جذب‌کننده تلفنی) normally only has view access to the office workflow
  // of their own connected customers (see customerCardHTML/openCustomerForm in app.js).
  // If the admin has granted canProcessCustomers, that specific caller may edit/advance
  // the loan stages of a customer - but ONLY one they themselves brought in (callerId
  // match), same as how a processor may only edit customers assigned to them.
  canProcessCustomer(user, customer) {
    if (!user || !customer) return false;
    if (user.role === 'admin') return true;
    if (user.role === 'processor') return customer.processorId === user.id;
    // Covers both directions for a caller with canProcessCustomers: their own lead that
    // they're now also handling in the office (callerId match, the original case), AND a
    // customer they were assigned as کارشناس دفتر on even though the lead itself belongs to
    // a different caller (processorId match - see getCustomersForUser's comment above for
    // why that split can happen). Either relationship is enough to own/advance the file.
    if (user.role === 'caller') return !!user.canProcessCustomers && (customer.callerId === user.id || customer.processorId === user.id);
    return false;
  },

  // ---------- CUSTOMERS ----------
  getCustomers() { return this.load().customers; },
  getCustomer(id) { return this.load().customers.find(c => c.id === id); },
  getCustomersForUser(user) {
    const all = this.load().customers;
    if (user.role === 'admin') return all;
    if (user.role === 'processor') return all.filter(c => c.processorId === user.id);
    // A caller normally only sees customers from their OWN leads (callerId match). But a
    // caller with canProcessCustomers may also end up as the کارشناس دفتر (processorId) on
    // a customer whose lead belongs to a DIFFERENT caller - e.g. a colleague brought the
    // lead in by phone, but this caller is the one who happened to handle them when they
    // physically came to the office (see openCustomerForm/DB.addCustomer's self-assign
    // branch). Without also matching processorId here, that customer would silently vanish
    // from this caller's dashboard the moment they navigated away from the just-created form,
    // even though they are actively responsible for pushing its loan stages forward.
    if (user.role === 'caller') return all.filter(c => c.callerId === user.id || (user.canProcessCustomers && c.processorId === user.id));
    return [];
  },
  addCustomer(data, currentUser) {
    const d = this.load();
    const customer = {
      id: uid('c'),
      name: data.name || '',
      phone: normalizePhone(data.phone),
      phone2: normalizePhone(data.phone2 || ''),
      nationalId: normalizeNationalId(data.nationalId),
      accountNumber: data.accountNumber || '',
      loanAmount: Number(data.loanAmount) || 0,
      // فقط برای ثبت/نمایش - در هیچ محاسبه‌ای استفاده نمی‌شود (بر خلاف loanAmount که در
      // computeCommissions و فرمول معکوس نقش دارد).
      maxLoanWithoutGuarantor: Number(data.maxLoanWithoutGuarantor) || 0,
      creditValidationImage: data.creditValidationImage || null,
      bankName: data.bankName || '',
      stage: data.stage || 'awaiting_docs',
      paymentType: data.paymentType || '', // 'cash' | 'goods'
      processorId: currentUser.role === 'processor' ? currentUser.id : (data.processorId || null),
      callerId: null,
      callerCommission: { amount: 0, paid: false },
      processorCommission: { amount: 0, paid: false },
      leadPurchase: null,
      serviceFee: null,
      contractImage: null,
      withdrawal: null,
      goodsSettlement: null,
      goodsPurchase: null,
      reminder: null,   // { dateISO, note, createdAt, createdBy, createdByName }
      createdAt: nowISO(),
      updatedAt: nowISO(),
      completedAt: null
    };
    d.customers.push(customer);

    // 1) exact match (phone, second phone, or national id) -> link directly, no confirmation needed
    const exactMatches = this.findExactMatchingLeads(data.phone, data.nationalId, data.phone2);
    let autoLinked = false;
    if (exactMatches.length === 1) {
      this.linkLeadToCustomer(exactMatches[0].id, customer.id);
      autoLinked = true;
    } else if (exactMatches.length > 1) {
      // rare case: more than one lead shares the same phone/national id. This used to
      // just tell the office user to "inform the admin" without actually recording
      // anything - now it's sent to the admin's pending-approval list like any other
      // ambiguous match, so it doesn't rely on someone remembering to mention it.
      exactMatches.forEach(l => this.createPendingMatch(l.id, customer.id, 'exact'));
    }
    // 2) same-name-only matches -> flagged as pending, manager must confirm
    let nameMatches = [];
    if (!autoLinked && exactMatches.length <= 1) {
      nameMatches = this.findNameMatchingLeads(data.name, data.phone, data.nationalId, data.phone2);
      nameMatches.forEach(l => this.createPendingMatch(l.id, customer.id, 'name'));
    }
    // 3) customer <-> customer exact match -> flagged as pending, manager must confirm.
    // The two checks above only ever compare against LEADS, so a customer registered
    // directly in the office (no lead involved at all - the common case for a processor
    // adding someone who walked in) never got compared against OTHER customers created the
    // same way. Without this, two customers with an identical phone/national id could both
    // be created and pushed all the way to "completed" with no warning ever reaching the admin.
    const otherCustomerMatches = this.findExactMatchingCustomersOther(customer);
    otherCustomerMatches.forEach(other => this.createCustomerConflict(other.id, customer.id, 'exact'));
    this.save();
    if (window.CloudSync) CloudSync.pushCustomer(customer);
    this.logAudit({ entity: 'customer', entityId: customer.id, action: 'create',
      summary: `ثبت مشتری جدید «${customer.name || 'بدون نام'}» (${customer.phone || '-'})` }, currentUser || this._actor());
    return {
      customer,
      autoLinked,
      possibleMatches: exactMatches.length > 1 ? exactMatches : [],
      nameMatches
    };
  },
  updateCustomer(id, patch) {
    const d = this.load();
    const c = d.customers.find(x => x.id === id);
    if (!c) return null;
    const wasCompleted = c.stage === 'completed';
    const prevStage = c.stage;
    // برای تشخیص «تغییرِ» جذب‌کننده/کارشناس، مقدار قبل از اعمال patch لازم است.
    const prevCallerId = c.callerId;
    const prevProcessorId = c.processorId;
    Object.assign(c, patch);
    c.updatedAt = nowISO();
    if (!wasCompleted && c.stage === 'completed' && !c.completedAt) c.completedAt = nowISO();
    if (c.stage !== 'completed') c.completedAt = null;
    // Commissions used to only ever get computed+saved inside the ADMIN's customer form
    // (the only one with the commissions fieldset - see openCustomerForm in app.js), via
    // its recalcCommissions() helper running client-side on that specific open+save. A
    // processor or caller completing a file never touches that fieldset at all, so
    // callerCommission/processorCommission stayed stuck at their creation default of
    // {amount:0,paid:false} until an admin happened to separately open and re-save that
    // exact customer. Fix: compute it right here, the moment the stage actually
    // transitions into 'completed', regardless of who saved it - respects manual-mode
    // (global or per-user), and never overwrites an amount the admin's own form already
    // explicitly sent in this same patch.
    if (!wasCompleted && c.stage === 'completed') {
      const calc = this.computeCommissions(c.loanAmount, { callerId: c.callerId, processorId: c.processorId });
      if (!calc.callerManual && patch.callerCommission === undefined) {
        c.callerCommission = { amount: calc.callerAmount, paid: !!(c.callerCommission && c.callerCommission.paid) };
      }
      if (!calc.processorManual && patch.processorCommission === undefined) {
        c.processorCommission = { amount: calc.processorAmount, paid: !!(c.processorCommission && c.processorCommission.paid) };
      }
    } else if (wasCompleted && c.stage === 'completed') {
      // پرونده از قبل تکمیل شده بود و همچنان تکمیل‌شده می‌ماند، اما جذب‌کننده و/یا کارشناس
      // دفتر آن عوض شده (از طریق سلکت‌های ادمین در فرم مشتری). مبلغ پورسانتِ ذخیره‌شده
      // متعلق به قانون (درصدی/دستی) و وضعیتِ «پرداخت‌شده» کاربر قبلی بود - انتقال همان
      // مقدار به کاربر جدید هم می‌تواند نادرست باشد (مثلاً کاربر قبلی در لیست پورسانت
      // دستی بوده ولی جدید نیست) و هم گمراه‌کننده (چون به کاربر جدید چیزی پرداخت نشده).
      // پس برای هر طرفی که واقعاً عوض شده، پورسانت از نو بر اساس کاربر جدید محاسبه و
      // وضعیت پرداخت‌شده صفر می‌شود؛ اگر کاربر جدید هم در حالت ورود دستی باشد، مبلغ صفر
      // می‌شود تا مدیر خودش دوباره واردش کند (نه اینکه مبلغ کاربر قبلی باقی بماند).
      const callerChanged = patch.callerId !== undefined && patch.callerId !== prevCallerId;
      const processorChanged = patch.processorId !== undefined && patch.processorId !== prevProcessorId;
      if (callerChanged || processorChanged) {
        const calc = this.computeCommissions(c.loanAmount, { callerId: c.callerId, processorId: c.processorId });
        if (callerChanged) {
          c.callerCommission = { amount: calc.callerManual ? 0 : calc.callerAmount, paid: false };
        }
        if (processorChanged) {
          c.processorCommission = { amount: calc.processorManual ? 0 : calc.processorAmount, paid: false };
        }
      }
    }
    // اگر جذب‌کننده‌ی این مشتری عوض شد (از سلکت مدیر در فرم)، لید اصلی‌ای که این مشتری از
    // روی آن ساخته شده هم به همان جذب‌کننده‌ی جدید وصل می‌شود - در غیر این صورت لید در
    // گزارش‌ها/پنل قدیمی همچنان زیر نام جذب‌کننده‌ی قبلی می‌ماند و با مشتری هماهنگ نیست.
    const callerReassigned = patch.callerId !== undefined && patch.callerId !== prevCallerId;
    if (callerReassigned) {
      const ownerLead = d.leads.find(l => l.matchedCustomerId === c.id);
      if (ownerLead) {
        ownerLead.callerId = c.callerId;
        ownerLead.updatedAt = nowISO();
        if (window.CloudSync) CloudSync.pushLead(ownerLead);
      }
    }
    this.save();
    if (window.CloudSync) CloudSync.pushCustomer(c);
    // فقط تغییر مرحله (stage) ثبت می‌شود، نه هر ویرایش جزئی - تا تاریخچه قابل استفاده بماند.
    if (patch.stage !== undefined && patch.stage !== prevStage) {
      this.logAudit({ entity: 'customer', entityId: c.id, action: 'stage_change',
        summary: `تغییر مرحله پرونده «${c.name || 'بدون نام'}» به «${c.stage}»` }, this._actor());
    }
    if (callerReassigned) {
      this.logAudit({ entity: 'customer', entityId: c.id, action: 'caller_reassign',
        summary: `تغییر جذب‌کننده تلفنی پرونده «${c.name || 'بدون نام'}» از «${this._userLabel(prevCallerId)}» به «${this._userLabel(c.callerId)}»` }, this._actor());
    }
    return c;
  },
  deleteCustomer(id) {
    const c = this.getCustomer(id);
    this.removeCustomerLocal(id);
    if (window.CloudSync) CloudSync.deleteCustomer(id);
    this.logAudit({ entity: 'customer', entityId: id, action: 'delete',
      summary: `حذف مشتری «${c ? (c.name || 'بدون نام') : id}»` }, this._actor());
  },
  // Lets a caller remove one of their own lead cards (a customer they registered by phone,
  // before/without an office visit) from the "جذب‌کننده تلفنی" panel. Same tombstone pattern
  // as deleteCustomer/deleteUser above, so the deletion is permanent and synced everywhere.
  deleteLead(id) {
    const l = this.getLeads().find(x => x.id === id);
    this.removeLeadLocal(id);
    if (window.CloudSync) CloudSync.deleteLead(id);
    this.logAudit({ entity: 'lead', entityId: id, action: 'delete',
      summary: `حذف مشتری جذب‌شده تلفنی «${l ? (l.name || 'بدون نام') : id}»` }, this._actor());
  },

  // Permanently deletes a user account (admin panel). Distinct from the existing
  // active/inactive toggle, which is still the recommended way to revoke access without
  // losing history - this fully removes the record, locally and in the cloud.
  deleteUser(id) {
    const u = this.getUser(id);
    this.removeUserLocal(id);
    if (window.CloudSync) CloudSync.deleteUser(id);
    this.logAudit({ entity: 'user', entityId: id, action: 'delete',
      summary: `حذف کاربر «${u ? u.name : id}»` }, this._actor());
  },

  // ---------- REPORTS ----------
  // Profit is only counted for files whose stage is "تکمیل شد" (completed) - per office
  // policy, commissions and the profit figure only apply once a file is fully closed:
  //   cash path:  سود = دریافتی بابت خدمات وام  −  (هزینه خرید امتیاز + پورسانت‌ها)
  //   goods path: سود = (مبلغ وام برداشت‌شده + مبلغ پیش‌پرداخت) − (هزینه خرید امتیاز + مبلغ خرید کالا + پورسانت‌ها)
  //
  // Guard against silent wrong totals: if the manager (or whoever has access) forgets to
  // fill in one of the pieces a completed file's profit depends on, that file is left out
  // of every sum below (not "counted as zero" - which would quietly skew the numbers) and
  // is instead listed in `incompleteCustomers` so it can be found and finished.
  profitDataGaps(c) {
    const gaps = [];
    if (!(c.leadPurchase && c.leadPurchase.approved)) gaps.push('خرید امتیاز هنوز تایید نشده');
    else if (!(Number(c.leadPurchase.amount) > 0)) gaps.push('مبلغ خرید امتیاز ثبت نشده');
    if (c.paymentType === 'goods') {
      if (!(c.goodsSettlement && Number(c.goodsSettlement.totalLoanWithdrawn) > 0)) gaps.push('مبلغ وام برداشت‌شده (جزییات فروش کالا) ثبت نشده');
      if (!(c.goodsPurchase && Number(c.goodsPurchase.amount) > 0)) gaps.push('مبلغ خرید کالا (تسویه خرید کالا) ثبت نشده');
      if (c.goodsSettlement) {
        const dp = Number(c.goodsSettlement.downPayment) || 0;
        const sale = Number(c.goodsSettlement.saleAmount) || 0;
        if (dp < 0 || (sale > 0 && dp > sale)) gaps.push('مبلغ پیش‌پرداخت (جزییات فروش کالا) نامعتبر است (منفی یا بیشتر از مبلغ فروش)');
      }
    } else {
      if (!(c.serviceFee && Number(c.serviceFee.amount) > 0)) gaps.push('مبلغ دریافتی بابت خدمات وام ثبت نشده');
    }
    // پورسانت‌ها عمداً اینجا چک نمی‌شوند. منطق: اگه کاربر مرتبط (caller/processor) نامشخص باشه،
    // پورسانت اون کاربر در محاسبه سود = ۰ لحاظ میشه (نه اینکه کل پرونده ناقص بشه).
    // اینطوری سود پرونده‌های بدون caller/processor همچنان محاسبه میشه، فقط پورسانت نامشخص
    // از سود کسر نمیشه. financialReport همین منطق رو پیاده می‌کنه.
    return gaps;
  },
  financialReport(fromISO, toISO) {
    // setHours() reads/writes in LOCAL time, so calling it on a date parsed from a bare
    // "YYYY-MM-DD" string (which JS itself treats as UTC midnight) re-anchors it to the real
    // local start-of-day - exactly like the "to" line already did for end-of-day. Without this,
    // "from" stayed at UTC midnight, which on Iran's own (positive) UTC+03:30 offset is
    // 03:30 AM local time - so a file completed between local midnight and 03:30 AM on the
    // first day of the range was silently left out of the report.
    const from = fromISO ? new Date(new Date(fromISO).setHours(0, 0, 0, 0)) : new Date('1970-01-01');
    const to = toISO ? new Date(new Date(toISO).setHours(23, 59, 59, 999)) : new Date();
    const completed = this.load().customers.filter(c => {
      if (c.stage !== 'completed') return false;
      const ref = new Date(c.completedAt || c.createdAt);
      return ref >= from && ref <= to;
    });
    let totalServiceFee = 0, totalCallerCommission = 0, totalProcessorCommission = 0,
        totalLeadPurchase = 0, totalGoodsPurchase = 0, totalLoanWithdrawnGoods = 0, netProfit = 0;
    const incompleteCustomers = [];
    const customers = [];
    // برای نمایش هشدار در گزارش: پرونده‌هایی که پورسانت دارند ولی کاربر مرتبط نامشخص است.
    // این پرونده‌ها همچنان در محاسبه سود لحاظ می‌شوند، فقط پورسانت نامشخص = ۰ لحاظ می‌شود.
    const commissionWarnings = [];
    completed.forEach(c => {
      const gaps = this.profitDataGaps(c);
      if (gaps.length) { incompleteCustomers.push({ id: c.id, name: c.name, gaps }); return; }
      customers.push(c);
      // منطق پورسانت: اگه کاربر مرتبط (caller/processor) مشخص باشه، پورسانتش از سود کسر میشه.
      // اگه نامشخص باشه، پورسانت = ۰ لحاظ میشه (از سود کسر نمیشه).
      const callerAmt = (c.callerId && Number(c.callerCommission?.amount)) || 0;
      const processorAmt = (c.processorId && Number(c.processorCommission?.amount)) || 0;
      const commissions = callerAmt + processorAmt;
      // هشدار: اگه مبلغ پورسانت > 0 ولی کاربر نامشخص باشه
      if (!c.callerId && (Number(c.callerCommission?.amount) || 0) > 0) {
        commissionWarnings.push({ id: c.id, name: c.name, type: 'caller', amount: Number(c.callerCommission?.amount) || 0 });
      }
      if (!c.processorId && (Number(c.processorCommission?.amount) || 0) > 0) {
        commissionWarnings.push({ id: c.id, name: c.name, type: 'processor', amount: Number(c.processorCommission?.amount) || 0 });
      }
      const leadPurchaseAmt = Number(c.leadPurchase?.amount) || 0;
      totalCallerCommission += callerAmt;
      totalProcessorCommission += processorAmt;
      totalLeadPurchase += leadPurchaseAmt;
      if (c.paymentType === 'goods') {
        const goodsPurchaseAmt = Number(c.goodsPurchase?.amount) || 0;
        const loanWithdrawn = Number(c.goodsSettlement?.totalLoanWithdrawn) || 0;
        const downPayment = Number(c.goodsSettlement?.downPayment) || 0;
        totalGoodsPurchase += goodsPurchaseAmt;
        totalLoanWithdrawnGoods += loanWithdrawn;
        netProfit += (loanWithdrawn + downPayment) - (leadPurchaseAmt + goodsPurchaseAmt + commissions);
      } else {
        // cash path (or unspecified, treated the same as cash)
        const serviceFeeAmt = Number(c.serviceFee?.amount) || 0;
        totalServiceFee += serviceFeeAmt;
        netProfit += serviceFeeAmt - (leadPurchaseAmt + commissions);
      }
    });
    const totalCommissions = totalCallerCommission + totalProcessorCommission;
    return {
      count: completed.length, completeCount: customers.length, totalServiceFee, totalCallerCommission,
      totalProcessorCommission, totalCommissions, totalLeadPurchase,
      totalGoodsPurchase, totalLoanWithdrawnGoods, netProfit, customers, incompleteCustomers,
      commissionWarnings
    };
  },

  // ---------- COMMISSION PAYOUTS (per user, all-time running balance) ----------
  // Independent of the report's date range: commissions accumulate across every
  // completed file a caller/processor has ever been linked to, and payments made to
  // them are recorded as a running ledger (a payment doesn't have to match any single
  // customer's commission amount).
  commissionPayoutSummary() {
    const users = this.load().users.filter(u => u.role === 'caller' || u.role === 'processor');
    return users.map(u => this._commissionPayoutForUser(u));
  },
  // Single-user version of the summary above - the SAME totalCommission/paid/remaining
  // figures the admin's payout tracker shows, just scoped to one person. Used by the
  // caller/processor dashboards (see renderCallerDashboard/renderProcessorDashboard) so a
  // user's own "کل پورسانت / پرداخت‌شده / مانده" always reads from the exact same source
  // as the admin's payment ledger, instead of the old customer-by-customer paid checkbox
  // which never got touched by a payment recorded here and so silently drifted out of
  // sync the moment the admin paid someone through this ledger instead of that checkbox.
  commissionPayoutForUser(userId) {
    const u = this.getUser(userId);
    if (!u || (u.role !== 'caller' && u.role !== 'processor')) return null;
    return this._commissionPayoutForUser(u);
  },
  _commissionPayoutForUser(u) {
    let totalCommission = 0;
    // Matched by the customer's actual callerId/processorId, NOT the user's stored
    // role - a caller with canProcessCustomers can also end up as a customer's
    // processorId (see openCustomerForm), so they can hold both commission types on
    // different customers at once; restricting by role here used to silently drop
    // their processor-side commission from this summary entirely.
    this.load().customers.filter(c => c.stage === 'completed').forEach(c => {
      if (c.callerId === u.id) totalCommission += Number(c.callerCommission?.amount) || 0;
      if (c.processorId === u.id) totalCommission += Number(c.processorCommission?.amount) || 0;
    });
    const payments = Array.isArray(u.commissionPayments) ? u.commissionPayments : [];
    const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return {
      userId: u.id, name: u.name, role: u.role,
      totalCommission, paid, remaining: totalCommission - paid, payments
    };
  },
  recordCommissionPayment(userId, amount, note) {
    const amt = Number(amount) || 0;
    if (amt <= 0) throw new Error('مبلغ پرداختی باید بزرگ‌تر از صفر باشد.');
    const u = this.getUser(userId);
    if (!u) return null;
    const payments = Array.isArray(u.commissionPayments) ? u.commissionPayments.slice() : [];
    payments.push({ amount: amt, date: nowISO(), note: note || '' });
    const result = this.updateUser(userId, { commissionPayments: payments, _skipGenericAudit: true });
    this.logAudit({ entity: 'user', entityId: userId, action: 'commission_payment',
      summary: `پرداخت پورسانت ${amt.toLocaleString('fa-IR')} تومانی به «${u.name}»` }, this._actor());
    return result;
  },

  // ---------- BACKUP (local file, in addition to Firebase) ----------
  exportBackup(user) {
    const d = this.load();
    if (user.role === 'admin') {
      return { scope: 'all', exportedAt: nowISO(), data: d };
    }
    const customers = this.getCustomersForUser(user);
    const leads = user.role === 'caller' ? this.getLeadsByCaller(user.id) : [];
    return {
      scope: 'user', userId: user.id, username: user.username,
      exportedAt: nowISO(), data: { users: [user], leads, customers }
    };
  },
  importBackup(payload, currentUser) {
    const d = this.load();
    const incoming = payload.data;
    if (payload.scope === 'all' && currentUser.role === 'admin') {
      // even a full restore is merged record-by-record (last-write-wins by updatedAt),
      // never a blind collection overwrite, so it cannot erase newer data from other devices.
      (incoming.users || []).forEach(u => this.upsertUser(u, { skipCloud: true }));
      (incoming.leads || []).forEach(l => this.upsertLead(l, { skipCloud: true }));
      (incoming.customers || []).forEach(c => this.upsertCustomer(c, { skipCloud: true }));
      (incoming.pendingMatches || []).forEach(p => this.upsertPendingMatch(p, { skipCloud: true }));
      (incoming.leadConflicts || []).forEach(lc => this.upsertLeadConflict(lc, { skipCloud: true }));
      (incoming.customerConflicts || []).forEach(cc => this.upsertCustomerConflict(cc, { skipCloud: true }));
      (incoming.loanProducts || []).forEach(p => this.upsertLoanProduct(p, { skipCloud: true }));
      this.save();
      if (window.CloudSync) CloudSync.queueFullFlush();
      return { merged: true, replaced: false };
    }
    let added = { users: 0, leads: 0, customers: 0 };
    (incoming.users || []).forEach(u => { if (!d.users.find(x => x.id === u.id)) { this.upsertUser(u, { skipCloud: true }); added.users++; } });
    (incoming.leads || []).forEach(l => { if (!d.leads.find(x => x.id === l.id)) { this.upsertLead(l, { skipCloud: true }); added.leads++; } });
    (incoming.customers || []).forEach(c => { if (!d.customers.find(x => x.id === c.id)) { this.upsertCustomer(c, { skipCloud: true }); added.customers++; } });
    this.save();
    if (window.CloudSync) CloudSync.queueFullFlush();
    return { merged: true, added };
  }
};
