/* ===================== APP ===================== */
const STAGE_LABELS = {
  awaiting_docs: 'در انتظار تکمیل مدارک',
  awaiting_score: 'مدارک تکمیل شد - در انتظار دریافت امتیاز',
  awaiting_withdrawal: 'امتیاز دریافت شد - در انتظار برداشت - تسویه',
  completed: 'تکمیل شد'
};
// Ordered processing steps + short labels, used to draw the caller-panel progress timeline
const PAYMENT_TYPE_LABELS = { cash: 'وجه نقد', goods: 'خرید کالا' };
const ROLE_LABELS = { admin: 'مدیر', caller: 'جذب‌کننده تلفنی', processor: 'کارشناس دفتر' };
const STAGE_ORDER = ['awaiting_docs', 'awaiting_score', 'awaiting_withdrawal', 'completed'];
const STAGE_SHORT_LABELS = {
  awaiting_docs: 'در انتظار تکمیل مدارک',
  awaiting_score: 'مدارک تکمیل شد - در انتظار دریافت امتیاز',
  awaiting_withdrawal: 'امتیاز دریافت شد - در انتظار برداشت - تسویه',
  completed: 'تکمیل شد'
};
const FOLLOWUP_LABELS = {
  awaiting_visit: 'در انتظار مراجعه',
  in_progress: 'رفته دفتر - در حال انجام',
  incomplete_docs: 'مدارک ناقص',
  follow_up: 'پیگیری مجدد کنم',
  taken_by_other: 'وامش را با نام شخص دیگر گرفته'
};
// Same as FOLLOWUP_LABELS, minus «مدارک ناقص» - used only for the selectable options and
// section grouping in the caller (جذب‌کننده تلفنی) panel, at the caller's request. Kept
// separate from FOLLOWUP_LABELS itself so historical leads that already have this status
// (and other places like the Excel export) still show/label it correctly.
const CALLER_FOLLOWUP_LABELS = Object.fromEntries(
  Object.entries(FOLLOWUP_LABELS).filter(([k]) => k !== 'incomplete_docs')
);

let CURRENT_USER = null;
let CURRENT_ROUTE = 'dashboard';

/* ---------- formatting helpers ---------- */
// Wrapped in <bdi dir="ltr"> so the digit groups always render in the correct order
// (left-to-right) regardless of the surrounding right-to-left Persian text. Without this,
// the browser's bidi algorithm can visually reorder/scatter the number and its thousand
// separators when it sits next to RTL text (e.g. "· مبلغ: ۱۲۳٬۰۰۰ تومان").
function fmtMoney(n) {
  n = Number(n) || 0;
  return `<bdi dir="ltr" class="money-num">${n.toLocaleString('fa-IR')}</bdi> تومان`;
}
// Jalali display for any stored ISO date
function fmtDate(iso) { return JalaliUtils.isoToJalaliStr(iso); }
// Same as fmtDate but also appends the HH:MM time - used where the exact moment matters
// (e.g. تاریخچه فعالیت‌ها/audit log), rather than everywhere fmtDate is already used for a
// plain date (registration date, completion date, etc.), so as not to change those.
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDate(iso);
  const pad = n => JalaliUtils.toFa(String(n).padStart(2, '0'));
  return `${fmtDate(iso)} - ساعت ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Fired by DB.save() when localStorage.setItem throws (most commonly a full storage
// quota - this app keeps every image ever attached in one shared browser storage key).
// Without this listener such a failure was completely invisible to the user.
document.addEventListener('db:save-error', (e) => {
  const isQuota = e.detail && e.detail.error && (e.detail.error.name === 'QuotaExceededError' || e.detail.error.code === 22);
  toast(
    isQuota
      ? 'حافظه ذخیره‌سازی مرورگر پر شده است؛ این تغییر ذخیره نشد. احتمالاً به‌خاطر تجمع تصاویر زیاد است - تصاویر قدیمی/غیرضروری را حذف کنید یا حجم تصاویر جدید را کاهش دهید.'
      : 'خطا در ذخیره‌سازی اطلاعات. لطفاً دوباره تلاش کنید.',
    'error'
  );
});

function toast(msg, type = 'success') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Live "1,234,567" thousand-separator formatting on a text input, while keeping
// the raw numeric value retrievable via input.dataset.raw / getRawNumber(input).
function attachMoneyFormatter(input) {
  const format = (raw) => raw ? Number(raw).toLocaleString('en-US') : '';
  input.addEventListener('input', () => {
    const raw = input.value.replace(/[^\d]/g, '');
    input.value = format(raw);
    input.dataset.raw = raw;
  });
}
function getRawNumber(input) {
  if (!input) return 0;
  const raw = input.dataset.raw !== undefined ? input.dataset.raw : input.value.replace(/[^\d]/g, '');
  return Number(raw) || 0;
}
function setMoneyInputValue(input, num) {
  const raw = String(Number(num) || '');
  input.value = raw ? Number(raw).toLocaleString('en-US') : '';
  input.dataset.raw = raw;
}
function attachAllMoneyFormatters(root) {
  root.querySelectorAll('.money-input').forEach(attachMoneyFormatter);
}

/* ---------- AUTH ---------- */
function initAuth() {
  const savedId = sessionStorage.getItem('loanCRM_session');
  console.info('[AUTH] initAuth start — savedId:', savedId);
  if (savedId) {
    const u = DB.getUser(savedId);
    console.info('[AUTH] getUser(savedId):', u ? { id: u.id, name: u.name, active: u.active } : 'NOT FOUND');
    if (u && u.active) { CURRENT_USER = u; console.info('[AUTH] → showApp (user found)'); showApp(); return; }
    // Session exists but user not found locally. This happens after a cache clear + re-login:
    // the seed admin got removed by removeSeedDefaultAdminIfSuperseded and the session was
    // switched to the real admin from cloud, but on a fresh page load the snapshot hasn't
    // arrived yet so the real admin isn't in localStorage yet. Wait briefly for cloud sync
    // before giving up and showing the login screen — this prevents the annoying "logout on
    // refresh" bug.
    const cloudConfigured = window.CloudSync && CloudSync.isConfigured();
    const syncDone = cloudConfigured ? CloudSync.hasCompletedInitialSync() : false;
    console.info('[AUTH] cloudConfigured:', cloudConfigured, 'syncDone:', syncDone);
    if (cloudConfigured && !syncDone) {
      console.info('[AUTH] → showLogin temporarily, waiting for cloud sync...');
      showLogin();
      CloudSync.waitForInitialSync(7000).then(() => {
        const u2 = DB.getUser(savedId);
        console.info('[AUTH] after sync — getUser(savedId):', u2 ? { id: u2.id, name: u2.name, active: u2.active } : 'STILL NOT FOUND');
        if (u2 && u2.active) { CURRENT_USER = u2; console.info('[AUTH] → showApp (after sync)'); showApp(); return; }
        console.info('[AUTH] → staying on login (user not found after sync)');
      });
      return;
    }
  }
  console.info('[AUTH] → showLogin (no session or sync already done)');
  showLogin();
}

function showLogin() {
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errorBox = document.getElementById('login-error');
  console.info('[AUTH] login attempt — username:', username);

  const localUser = await DB.authenticate(username, password);
  if (localUser) { console.info('[AUTH] login success — local user:', localUser.id); errorBox.textContent = ''; completeLogin(localUser); return; }
  console.info('[AUTH] login failed locally, checking cloud sync...');

  // On a brand-new device, DB.load() seeds only a fresh local default account the instant
  // the page opens, BEFORE Firebase's anonymous sign-in + first Firestore snapshot have had
  // a chance to arrive. So a real user (created earlier by the admin, on another device) can
  // fail to log in here for no real reason - not because the credentials are wrong, but
  // because the real user list simply hasn't synced down to this device yet. If that initial
  // cloud sync is still in flight, wait briefly for it (with a timeout for genuinely-offline
  // first use) and retry once, instead of immediately declaring the credentials wrong.
  if (window.CloudSync && CloudSync.isConfigured() && !CloudSync.hasCompletedInitialSync()) {
    errorBox.textContent = 'در حال بررسی اتصال ابری، لطفاً چند لحظه صبر کنید...';
    CloudSync.waitForInitialSync(7000).then(async () => {
      const retryUser = await DB.authenticate(username, password);
      if (retryUser) { console.info('[AUTH] login success after sync — user:', retryUser.id); errorBox.textContent = ''; completeLogin(retryUser); return; }
      // Still nothing after waiting: if the cloud sync genuinely never landed (still not
      // "done"), this is a brand-new device that couldn't reach Firebase at all - almost
      // always a VPN/internet problem, not a wrong password. Say so, instead of the
      // generic (and misleading, in this case) "wrong username or password".
      if (!CloudSync.hasCompletedInitialSync()) {
        console.info('[AUTH] login failed — cloud sync never connected (likely no VPN/internet)');
        errorBox.textContent = 'اتصال به سرور ابری برقرار نشد. لطفاً وی‌پی‌ان/اینترنت را بررسی و دوباره تلاش کنید. (این پیام فقط روی یک دستگاه که قبلاً روی آن وارد نشده‌اید ظاهر می‌شود — روی دستگاهی که قبلاً یک بار وارد شده‌اید، ورود بدون وی‌پی‌ان هم باید کار کند.)';
      } else {
        console.info('[AUTH] login failed after sync — credentials genuinely wrong');
        errorBox.textContent = 'نام کاربری یا رمز عبور اشتباه است.';
      }
    });
    return;
  }

  errorBox.textContent = 'نام کاربری یا رمز عبور اشتباه است.';
});

function completeLogin(user) {
  CURRENT_USER = user;
  sessionStorage.setItem('loanCRM_session', user.id);
  console.info('[AUTH] completeLogin — session set to:', user.id, 'name:', user.name);
  showApp();
}

document.getElementById('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem('loanCRM_session');
  CURRENT_USER = null;
  location.reload();
});

/* ---------- APP SHELL / NAV ---------- */
function showApp() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  window.__syncHeaderHeight?.();
  document.getElementById('current-user-name').textContent = CURRENT_USER.name;
  document.getElementById('sidebar-name').textContent = CURRENT_USER.name;
  document.getElementById('sidebar-role').textContent = ROLE_LABELS[CURRENT_USER.role] || CURRENT_USER.role;
  renderSidebarAvatar(CURRENT_USER);
  buildNav();
  navigate('dashboard');
  updateReminderBadge();
  checkTodayReminders();
  maybeRunAutoBackup();
}

// Shows the user's own uploaded photo if they've set one, otherwise falls back to the
// first letter of their name (the original look). Called on login and again right after
// a successful upload below.
function renderSidebarAvatar(user) {
  const el = document.getElementById('sidebar-avatar');
  if (user.photo) {
    el.textContent = '';
    el.style.backgroundImage = `url("${user.photo}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    el.style.backgroundImage = '';
    el.textContent = (user.name || '؟').slice(0, 1);
  }
}

// Lets any logged-in user (admin/caller/processor alike) tap their own avatar in the
// sidebar to set a personal profile photo, instead of always showing just the first
// letter of their name. Reuses the same client-side compression used for contract/receipt
// photos elsewhere in the app, so a multi-MB camera photo doesn't blow past the ~1MB
// Firestore document limit for the user's record.
document.getElementById('sidebar-avatar-wrap').addEventListener('click', () => {
  document.getElementById('input-avatar').click();
});
document.getElementById('input-avatar').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) { toast('لطفاً یک فایل تصویری انتخاب کنید.', 'error'); return; }
  const dataUrl = await compressImageToDataURL(file, { maxDim: 480, quality: 0.75 });
  if (!dataUrl) { toast('بارگذاری عکس ناموفق بود.', 'error'); return; }
  try {
    await DB.updateUser(CURRENT_USER.id, { photo: dataUrl });
    CURRENT_USER.photo = dataUrl;
    renderSidebarAvatar(CURRENT_USER);
    toast('عکس پروفایل بروزرسانی شد.');
  } catch (err) {
    toast(err.message || 'بروزرسانی عکس ناموفق بود.', 'error');
  }
});

function buildNav() {
  const nav = document.getElementById('nav-list');
  const items = [{ key: 'dashboard', label: '🏠 داشبورد' }];
  // Loan calculator is available to every role - callers use it to answer customer
  // questions on the phone, processors use it at the desk, admin uses it too.
  items.push({ key: 'loanCalc', label: '🧮 محاسبه وام' });
  if (CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'caller') {
    items.push({ key: 'templates', label: '📝 توضیحات آماده وام‌ها' });
  }
  if (DB.canUseChat(CURRENT_USER)) {
    items.push({ key: 'chat', label: '💬 گفتگوی گروهی' });
  }
  if (DB.canApproveScore(CURRENT_USER)) {
    items.push({ key: 'scoreRequests', label: '💳 درخواست‌های خرید امتیاز' });
  }
  if (DB.canReviewTakenLeads(CURRENT_USER)) {
    items.push({ key: 'takenByOther', label: '🚩 وام گرفته‌شده با نام دیگری' });
  }
  if (CURRENT_USER.role === 'admin') {
    items.push({ key: 'loanProducts', label: '🏦 مدیریت محصولات وام' });
    items.push({ key: 'pending', label: '🔎 تطبیق‌های در انتظار تایید' });
    items.push({ key: 'report', label: '📊 گزارش مالی و سود' });
    items.push({ key: 'analytics', label: '📈 گزارش تحلیلی و نمودار' });
    items.push({ key: 'settings', label: '⚙️ تنظیمات پورسانت' });
    items.push({ key: 'users', label: '👥 مدیریت کاربران' });
    items.push({ key: 'audit', label: '🕓 تاریخچه فعالیت‌ها' });
  }
  nav.innerHTML = '';
  items.forEach(it => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = it.label;
    if (it.key === 'pending') {
      const n = DB.getPendingMatches().length + DB.getLeadConflicts().length + DB.getCustomerConflicts().length;
      if (n) a.textContent += ` (${JalaliUtils.toFa(n)})`;
    }
    if (it.key === 'scoreRequests') {
      const n = DB.getScoreRequests().length;
      if (n) a.textContent += ` (${JalaliUtils.toFa(n)})`;
    }
    if (it.key === 'takenByOther') {
      const n = DB.getTakenByOtherLeads().length;
      if (n) a.textContent += ` (${JalaliUtils.toFa(n)})`;
    }
    a.dataset.route = it.key;
    a.onclick = () => { navigate(it.key); closeSidebar(); };
    li.appendChild(a);
    nav.appendChild(li);
  });

  buildBottomNav(items);
}

// Native-app-style bottom tab bar: takes the same items buildNav() just built for
// the sidebar and turns a subset into always-visible tabs (each label's emoji
// prefix is reused as the tab glyph, split off on the first space so the bar shows
// icon-over-label like a native tab bar instead of a wrapped emoji+text row). Every
// remaining item — including anything role-specific further down the list — stays
// reachable behind a closing "بیشتر" tab that simply opens the existing sidebar, so
// no destination is ever dropped, only reflowed.
//
// Admin gets a fixed, hand-picked set of tabs (dashboard/calc/score-requests/chat)
// regardless of where those items happen to fall in the sidebar list, since admin's
// sidebar is long and its natural top-4 wouldn't be the most useful tabs.
// Caller and processor instead get the sidebar's own priority order verbatim: the
// first four items in their (permission-filtered) sidebar list become the tabs, and
// anything past that collapses into "بیشتر" — so up to 5 slots total, "بیشتر" being
// the 5th when there's overflow.
// Per-user "have I seen the latest chat message" marker, kept in localStorage so it
// survives reloads. Namespaced by user id (shared browser/device, multiple accounts).
function chatLastReadKey() {
  return CURRENT_USER ? `mp_chat_last_read_${CURRENT_USER.id}` : null;
}
function getChatLastRead() {
  const k = chatLastReadKey();
  if (!k) return 0;
  const v = localStorage.getItem(k);
  return v ? Number(v) : 0;
}
// Called the moment the person actually looks at the chat screen - both on first
// opening it and on every live refresh while it's already open - so the bottom-nav
// dot disappears immediately instead of waiting for the next full nav rebuild.
function markChatAsRead() {
  const k = chatLastReadKey();
  if (!k) return;
  try { localStorage.setItem(k, String(Date.now())); } catch (e) { /* ignore quota errors */ }
  const btn = document.querySelector('#bottom-nav .bottom-nav-item[data-route="chat"]');
  if (btn) btn.classList.remove('has-unread');
}
// True when someone else has posted to the group chat since this user last opened it.
function hasUnreadChat() {
  if (!CURRENT_USER || !DB.canUseChat(CURRENT_USER)) return false;
  const msgs = DB.getChatMessages();
  if (!msgs.length) return false;
  const lastRead = getChatLastRead();
  return msgs.some(m => m.senderId !== CURRENT_USER.id && new Date(m.createdAt).getTime() > lastRead);
}

function buildBottomNav(items) {
  const bar = document.getElementById('bottom-nav');
  if (!bar) return;
  const chatUnread = hasUnreadChat();
  const SHORT_LABEL = { scoreRequests: '💳 خرید امتیاز', templates: '📝 توضیحات وام' };
  let primary, rest;
  if (CURRENT_USER.role === 'admin') {
    // Fixed, always-in-this-order set of primary tabs. Any key here that the
    // current role doesn't have is simply skipped — it's still reachable from
    // "بیشتر" like every other sidebar item, it just doesn't reserve a tab.
    const PRIMARY_KEYS = ['dashboard', 'loanCalc', 'scoreRequests', 'chat'];
    const byKey = Object.fromEntries(items.map(it => [it.key, it]));
    primary = PRIMARY_KEYS.map(k => byKey[k]).filter(Boolean);
    rest = items.filter(it => !PRIMARY_KEYS.includes(it.key));
  } else {
    // Caller / processor ("جذب مشتری" / "کارشناس دفتر"): mirror the sidebar's
    // own priority order exactly - first four items become tabs, everything
    // else stays behind "بیشتر".
    primary = items.slice(0, 4);
    rest = items.slice(4);
  }
  bar.innerHTML = '';
  primary.forEach(it => {
    const label = SHORT_LABEL[it.key] || it.label;
    const spaceIdx = label.indexOf(' ');
    const icon = spaceIdx > -1 ? label.slice(0, spaceIdx) : label;
    const text = spaceIdx > -1 ? label.slice(spaceIdx + 1) : label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bottom-nav-item' + (it.key === 'chat' && chatUnread ? ' has-unread' : '');
    btn.dataset.route = it.key;
    btn.innerHTML = `<span class="bottom-nav-icon">${icon}</span><span class="bottom-nav-label">${text}</span>`;
    btn.onclick = () => navigate(it.key);
    bar.appendChild(btn);
  });
  if (rest.length) {
    const more = document.createElement('button');
    more.type = 'button';
    // If chat got bumped into "بیشتر" (not one of the primary tabs), the dot still
    // needs to surface somewhere so an unread message is never invisible.
    const chatInRest = chatUnread && rest.some(it => it.key === 'chat');
    more.className = 'bottom-nav-item bottom-nav-more' + (chatInRest ? ' has-unread' : '');
    more.innerHTML = `<span class="bottom-nav-icon">☰</span><span class="bottom-nav-label">بیشتر</span>`;
    more.onclick = () => openSidebar();
    bar.appendChild(more);
  }
}

document.getElementById('btn-menu').onclick = openSidebar;
document.getElementById('sidebar-overlay').onclick = closeSidebar;
document.getElementById('btn-close-sidebar').onclick = closeSidebar;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('sidebar').classList.contains('open')) closeSidebar();
});

const syncStatusEl = document.getElementById('sync-status');
syncStatusEl.setAttribute('role', 'button');
syncStatusEl.setAttribute('tabindex', '0');
function revealSyncStatus(e) {
  const badge = e.currentTarget;
  const full = badge.dataset.full || badge.textContent;
  toast(full, badge.classList.contains('on') ? 'success' : 'warn');
}
syncStatusEl.addEventListener('click', revealSyncStatus);
syncStatusEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealSyncStatus(e); }
});

// Delegated listener: reminder chips are re-rendered often (lead/customer lists repaint
// on every change), so one listener here covers all of them instead of rewiring per-render.
// Capture phase is required: the chip sits inside `.card`, which has its own onclick that
// opens the edit form. A bubble-phase listener on document would fire *after* that handler
// already ran, so it can't stop it - capture lets us stopPropagation() before it gets there.
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.reminder-chip[data-note]');
  if (!chip || !chip.dataset.note) return;
  e.stopPropagation();
  toast(chip.dataset.note);
}, true);

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.remove('hidden');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.add('hidden');
}

function navigate(route) {
  CURRENT_ROUTE = route;
  document.querySelectorAll('#nav-list a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  const bottomTabs = document.querySelectorAll('#bottom-nav .bottom-nav-item:not(.bottom-nav-more)');
  let matchedTab = false;
  bottomTabs.forEach(a => { const on = a.dataset.route === route; a.classList.toggle('active', on); if (on) matchedTab = true; });
  const moreTab = document.querySelector('#bottom-nav .bottom-nav-more');
  if (moreTab) moreTab.classList.toggle('active', !matchedTab && document.querySelector(`#nav-list a[data-route="${route}"]`) != null);
  const main = document.getElementById('main-content');
  main.innerHTML = '';
  if (route === 'dashboard') renderDashboard(main);
  else if (route === 'report') renderReport(main);
  else if (route === 'users') renderUsers(main);
  else if (route === 'pending') renderPendingMatches(main);
  else if (route === 'settings') renderSettings(main);
  else if (route === 'templates') renderTemplates(main);
  else if (route === 'chat') { renderChat(main); markChatAsRead(); }
  else if (route === 'scoreRequests') renderScoreRequests(main);
  else if (route === 'takenByOther') renderTakenByOtherLeads(main);
  else if (route === 'analytics') renderAnalytics(main);
  else if (route === 'audit') renderAuditLog(main);
  else if (route === 'loanProducts') renderLoanProducts(main);
  else if (route === 'loanCalc') renderLoanCalc(main);
  updateReminderBadge();
}

// Called by CloudSync whenever new data arrives from Firestore, so open screens refresh live.
function onCloudDataChanged() {
  if (!CURRENT_USER) return;
  buildNav();
  updateReminderBadge();
  if (!document.getElementById('modal-root').classList.contains('hidden')) return;
  // Chat gets a lighter-weight refresh so a full re-render doesn't wipe out whatever
  // the person is currently typing or jump their scroll position on every new message.
  if (CURRENT_ROUTE === 'chat' && document.getElementById('chat-messages')) {
    paintChatMessages();
    markChatAsRead();
  } else {
    navigate(CURRENT_ROUTE);
  }
}

/* ---------- MODAL HELPERS ---------- */
function openModal(templateId) {
  const tpl = document.getElementById(templateId);
  const box = document.getElementById('modal-box');
  box.innerHTML = '';
  box.appendChild(tpl.content.cloneNode(true));
  document.getElementById('modal-root').classList.remove('hidden');
  box.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  document.querySelector('.modal-backdrop').onclick = closeModal;
  return box;
}
function closeModal() {
  document.getElementById('modal-root').classList.add('hidden');
  document.getElementById('modal-box').innerHTML = '';
}

/* ===================== DASHBOARD ===================== */
function renderDashboard(main) {
  if (CURRENT_USER.role === 'caller') renderCallerDashboard(main);
  else if (CURRENT_USER.role === 'processor') renderProcessorDashboard(main);
  else renderAdminDashboard(main);
}

/* --- CALLER --- */
function renderCallerDashboard(main) {
  const tpl = document.getElementById('tpl-dashboard-caller');
  main.appendChild(tpl.content.cloneNode(true));

  const leads = DB.getLeadsByCaller(CURRENT_USER.id);
  const myCustomers = DB.getCustomersForUser(CURRENT_USER);
  const completed = myCustomers.filter(c => c.stage === 'completed');
  // Same source as the admin's payment ledger (see DB.commissionPayoutForUser) - so a
  // payment the admin records there shows up here immediately, instead of the old
  // per-customer "paid" checkbox which the ledger never touches.
  const payout = DB.commissionPayoutForUser(CURRENT_USER.id) || { totalCommission: 0, paid: 0, remaining: 0 };

  document.getElementById('caller-stats').innerHTML = `
    ${statCard(leads.length, 'مشتری جذب‌شده (لید)')}
    ${statCard(myCustomers.length, 'مشتری متصل‌شده')}
    ${statCard(completed.length, 'وام تکمیل‌شده')}
    ${statCard(fmtMoney(payout.totalCommission), 'کل پورسانت من')}
    ${statCard(fmtMoney(payout.paid), 'پورسانت پرداخت‌شده')}
    ${statCard(fmtMoney(Math.max(payout.remaining, 0)), 'پورسانت مانده')}
  `;

  function paint(q) {
    q = (q || '').trim();
    const filteredLeads = q ? leads.filter(l => matchesQuery(l.name, l.rawPhone || l.phone, l.nationalId, q)) : leads;
    const filteredCustomers = q ? myCustomers.filter(c => matchesQuery(c.name, c.phone, c.nationalId, q, c.phone2)) : myCustomers;

    const leadsList = document.getElementById('leads-list');
    if (!filteredLeads.length) {
      leadsList.innerHTML = emptyState(q ? 'موردی یافت نشد.' : 'هنوز مشتری تلفنی ثبت نکرده‌اید.');
    } else {
      // group leads into a category per follow-up status, so each status has its own section
      const groups = {};
      Object.keys(CALLER_FOLLOWUP_LABELS).forEach(k => { groups[k] = []; });
      filteredLeads.forEach(l => {
        const key = CALLER_FOLLOWUP_LABELS[l.followUpStatus] ? l.followUpStatus : 'awaiting_visit';
        groups[key].push(l);
      });
      leadsList.innerHTML = Object.keys(groups).filter(k => groups[k].length).map(key => {
        const stateKey = `leads-list:${key}`;
        const { items, page, totalPages } = paginate(groups[key], leadsListPageState[stateKey] || 1, LEADS_LIST_PAGE_SIZE);
        leadsListPageState[stateKey] = page;
        return `
        <div class="followup-group" data-followup="${key}">
          <div class="followup-group-title chip followup-${key}">${CALLER_FOLLOWUP_LABELS[key]} (${JalaliUtils.toFa(groups[key].length)})</div>
          <div class="card-list">${items.map(l => leadCardHTML(l)).join('')}</div>
          ${paginationBarHTML(page, totalPages)}
        </div>
      `;
      }).join('');
      leadsList.querySelectorAll('[data-page-nav]').forEach(btn => {
        btn.onclick = () => {
          const key = btn.closest('.followup-group').dataset.followup;
          const stateKey = `leads-list:${key}`;
          leadsListPageState[stateKey] = (leadsListPageState[stateKey] || 1) + (btn.dataset.pageNav === 'next' ? 1 : -1);
          paint(document.getElementById('caller-search').value);
        };
      });
    }
    leadsList.querySelectorAll('.followup-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        DB.updateLead(e.target.dataset.leadId, { followUpStatus: e.target.value });
        toast('وضعیت پیگیری بروزرسانی شد.');
        paint(document.getElementById('caller-search').value);
      });
    });
    // Reminder + edit are now available on every lead as well (previously only available
    // once a lead was linked to an office customer record), so a caller can manage every
    // one of their own customers - linked or not - from one place.
    leadsList.querySelectorAll('.btn-edit-lead').forEach(btn => {
      btn.onclick = () => openLeadForm(btn.dataset.id);
    });
    leadsList.querySelectorAll('.btn-lead-reminder').forEach(btn => {
      btn.onclick = () => openReminderModal(btn.dataset.id, 'lead');
    });
    // Lets a caller with canProcessCustomers jump straight from a "رفته دفتر - در حال
    // انجام" lead into that customer's office workflow form (same form/permissions as
    // opening it from the connected-customers list below - see DB.canProcessCustomer).
    leadsList.querySelectorAll('.btn-process-lead-customer').forEach(btn => {
      btn.onclick = () => openCustomerForm(btn.dataset.customerId);
    });
    // Lets a caller with canProcessCustomers create the actual office customer record
    // themselves - for when they bring their own lead into the office and handle the
    // loan stages in person, instead of waiting for a کارشناس دفتر to register it.
    // Pre-fills name/phone/nationalId from the lead; on save it auto-links back to this
    // lead (same exact-match logic as DB.addCustomer always uses) and connects the
    // customer to this caller as both جذب‌کننده and کارشناس (see processorId branch above).
    leadsList.querySelectorAll('.btn-start-customer-from-lead').forEach(btn => {
      btn.onclick = () => openCustomerForm(null, { leadId: btn.dataset.leadId });
    });
    // Lets the caller remove a lead card entirely (e.g. it was a mistake, duplicate, or a
    // wrong number). Deleting only removes this "قبل از مراجعه به دفتر" record - if the lead
    // was already linked to a real office customer, that customer (and its commission) is
    // completely untouched; see DB.deleteLead's comment for why.
    leadsList.querySelectorAll('.btn-delete-lead').forEach(btn => {
      btn.onclick = () => {
        if (!confirm(`آیا از حذف مشتری «${btn.dataset.name || ''}» مطمئن هستید؟ این عمل غیرقابل بازگشت است.`)) return;
        DB.deleteLead(btn.dataset.id);
        toast('مشتری حذف شد.');
        navigate(CURRENT_ROUTE);
      };
    });

    // By default a caller's connected-customers list is view-only (disableOpen); if the
    // admin has granted this caller canProcessCustomers, they get the same open/edit
    // access a processor has - but only for their own customers (already filtered into
    // myCustomers above via DB.getCustomersForUser).
    const canOpenOwnCustomers = !!CURRENT_USER.canProcessCustomers;
    const custList = document.getElementById('caller-customers-list');
    if (!filteredCustomers.length) custList.innerHTML = emptyState(q ? 'موردی یافت نشد.' : 'هنوز مشتری‌ای به شما متصل نشده است.');
    else custList.innerHTML = filteredCustomers.map(c => customerCardHTML(c, { showStageTimeline: true, disableOpen: !canOpenOwnCustomers })).join('');
    wireCustomerCards(custList, { disableOpen: !canOpenOwnCustomers });
  }
  paint('');
  document.getElementById('caller-search').addEventListener('input', (e) => paint(e.target.value));

  document.getElementById('btn-add-lead').onclick = () => openLeadForm();

  // Lets a caller with canProcessCustomers register a brand-new office file directly -
  // for the exact scenario where the customer was originally brought in by a DIFFERENT
  // caller (so no matching lead exists in THIS caller's own list to launch it from - see
  // btn-start-customer-from-lead above, which only covers leads this caller owns). Reuses
  // the same openCustomerForm(null) blank-form path a processor uses: DB.addCustomer's
  // auto-link still matches the phone/national id against every lead system-wide and
  // connects callerId to whichever caller actually brought the lead in, while this caller
  // is self-assigned as processorId (see the payload branch in openCustomerForm) - so the
  // two commissions split correctly between both callers without any admin step.
  const btnAddOfficeFile = document.getElementById('btn-office-file-add');
  if (btnAddOfficeFile) {
    if (!CURRENT_USER.canProcessCustomers) btnAddOfficeFile.remove();
    else btnAddOfficeFile.onclick = () => openCustomerForm();
  }
}

function leadCardHTML(l) {
  return `
      <div class="card" data-id="${l.id}">
        <div class="card-top">
          <div class="card-title">${esc(l.name)}</div>
          <span class="chip ${l.matchedCustomerId ? 'stage-completed' : 'stage-new'}">
            ${l.matchedCustomerId ? 'متصل شده به مشتری دفتر' : 'در انتظار مراجعه'}
          </span>
        </div>
        <div class="card-sub">${esc(l.rawPhone || l.phone)} ${l.nationalId ? '· کد ملی: ' + esc(l.nationalId) : ''}</div>
        <div class="card-sub">تاریخ ثبت: ${fmtDate(l.createdAt)}</div>
        ${l.note ? `<div class="card-sub">${esc(l.note)}</div>` : ''}
        <div class="card-meta">
          <span class="chip">${l.requestType === 'goods' ? 'درخواست: کالا' : 'درخواست: وام'}</span>
          ${l.requestType === 'goods' && l.goodsType ? `<span class="chip goods-chip">${esc(l.goodsType)}</span>` : ''}
          ${l.reminder ? `<span class="chip reminder-chip ${isReminderDue(l.reminder) ? 'reminder-due' : ''}" title="${esc(l.reminder.note || '')}" data-note="${esc(l.reminder.note || '')}">⏰ یادآوری: ${fmtDate(l.reminder.dateISO)}</span>` : ''}
        </div>
        <div class="followup-row" onclick="event.stopPropagation()">
          <label>وضعیت پیگیری:
            <select class="followup-select" data-lead-id="${l.id}">
              ${Object.keys(CALLER_FOLLOWUP_LABELS).map(k => `<option value="${k}" ${l.followUpStatus === k ? 'selected' : ''}>${CALLER_FOLLOWUP_LABELS[k]}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="card-actions" onclick="event.stopPropagation()">
          <button type="button" class="btn btn-ghost btn-sm btn-edit-lead" data-id="${l.id}">✏️ ویرایش مشتری</button>
          <button type="button" class="btn btn-ghost btn-sm btn-lead-reminder" data-id="${l.id}">⏰ ${l.reminder ? 'ویرایش یادآوری' : 'افزودن یادآوری'}</button>
          ${CURRENT_USER.canProcessCustomers && l.followUpStatus === 'in_progress' ? (
            l.matchedCustomerId
              ? `<button type="button" class="btn btn-primary btn-sm btn-process-lead-customer" data-customer-id="${l.matchedCustomerId}">📄 پیگیری مراحل دریافت وام</button>`
              : `<button type="button" class="btn btn-primary btn-sm btn-start-customer-from-lead" data-lead-id="${l.id}">📄 شروع پرونده دفتر</button>`
          ) : ''}
          <button type="button" class="btn btn-danger btn-sm btn-delete-lead" data-id="${l.id}" data-name="${esc(l.name || '')}">🗑️ حذف مشتری</button>
        </div>
      </div>`;
}

function matchesQuery(name, phone, nationalId, q, phone2) {
  const hay = toEnglishDigits(`${name || ''} ${phone || ''} ${phone2 || ''} ${nationalId || ''}`).toLowerCase();
  return hay.includes(toEnglishDigits(q).toLowerCase());
}

// leadId omitted -> "add new lead" (original behavior). leadId provided -> "edit
// existing lead", so a caller can fix a mistyped name/phone/note etc. on any of their
// own leads, not just on ones already linked to an office customer record.
function openLeadForm(leadId) {
  const isEdit = !!leadId;
  const l = isEdit ? DB.getLeads().find(x => x.id === leadId) : null;
  if (isEdit && !l) return;
  const box = openModal('tpl-modal-lead');
  box.querySelector('#lead-form-title').textContent = isEdit ? 'ویرایش مشتری جذب‌شده تلفنی' : 'ثبت مشتری جذب‌شده تلفنی';
  const form = box.querySelector('#form-lead');
  const requestTypeSel = form.querySelector('#lead-request-type');
  const goodsWrap = form.querySelector('#lead-goods-type-wrap');
  const syncGoodsVisibility = () => goodsWrap.classList.toggle('hidden', requestTypeSel.value !== 'goods');
  requestTypeSel.addEventListener('change', syncGoodsVisibility);

  if (isEdit) {
    form.name.value = l.name || '';
    form.phone.value = l.rawPhone || l.phone || '';
    form.nationalId.value = l.nationalId || '';
    requestTypeSel.value = l.requestType || 'loan';
    form.goodsType.value = l.goodsType || '';
    form.note.value = l.note || '';
  }
  syncGoodsVisibility();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (isEdit) {
      DB.updateLead(l.id, {
        name: fd.get('name'), phone: normalizePhone(fd.get('phone')), rawPhone: fd.get('phone'),
        nationalId: normalizeNationalId(fd.get('nationalId')), note: fd.get('note'),
        requestType: fd.get('requestType'),
        goodsType: fd.get('requestType') === 'goods' ? (fd.get('goodsType') || '') : ''
      });
      toast('اطلاعات مشتری بروزرسانی شد.');
      closeModal();
      navigate(CURRENT_ROUTE);
      return;
    }
    const { ambiguous, flaggedDuplicate, conflictDetail, nameMatches } = DB.addLead({
      callerId: CURRENT_USER.id,
      name: fd.get('name'), phone: fd.get('phone'),
      nationalId: fd.get('nationalId'), note: fd.get('note'),
      requestType: fd.get('requestType'), goodsType: fd.get('goodsType')
    });
    // A matching customer/lead may already exist - either registered by the office first,
    // by another caller, or even by the SAME caller for the same person before. In all of
    // these single-match cases we name the earlier record and require an explicit
    // acknowledgement (native alert = a real "OK" click, not an auto-dismissing toast)
    // before moving on; the case is always sent to the admin queue regardless of the click.
    if (ambiguous) {
      toast('مشخصات این مشتری با چند رکورد ثبت‌شده مطابقت دقیق دارد؛ برای بررسی و تایید نهایی به مدیر ارسال شد.', 'error');
    } else if (flaggedDuplicate && conflictDetail) {
      const when = fmtDateTime(conflictDetail.matchedAt);
      const msg = conflictDetail.isSelf
        ? `شما قبلاً همین مشتری (شماره تماس/کد ملی یکسان) را در تاریخ ${when} ثبت کرده‌اید.\nاگر این یک درخواست/وام جدید برای همین شخص است، «تایید» کنید تا برای بررسی به مدیر ارسال شود.`
        : `این مشتری قبلاً توسط «${conflictDetail.ownerName}» در تاریخ ${when} ثبت شده است.\nبا تایید، این مورد برای بررسی نهایی به مدیر ارسال می‌شود.`;
      alert(msg);
      toast('مشتری تلفنی ثبت شد؛ برای بررسی تکراری‌بودن به مدیر ارسال شد.', 'error');
    } else if (nameMatches && nameMatches.length) {
      toast('نام این لید با یک یا چند مشتری ثبت‌شده یکسان است؛ برای تایید نهاییِ اتصال به مدیر ارسال شد.', 'error');
    } else {
      toast('مشتری تلفنی ثبت شد.');
    }
    closeModal();
    navigate('dashboard');
  });
}

/* --- PROCESSOR --- */
function renderProcessorDashboard(main) {
  const tpl = document.getElementById('tpl-dashboard-processor');
  main.appendChild(tpl.content.cloneNode(true));
  const all = DB.getCustomersForUser(CURRENT_USER);
  paintProcessorStats(all);
  paintCustomerList(all, 'customers-list-processor');
  wireFilters(() => DB.getCustomersForUser(CURRENT_USER), 'customers-list-processor', false, 'filter-stage-processor', 'filter-search-processor');
  document.getElementById('btn-add-customer').onclick = () => openCustomerForm();
}

function paintProcessorStats(all) {
  const completed = all.filter(c => c.stage === 'completed');
  const incompleteDocs = all.filter(c => DB.stageBucket(c.stage) === 'incomplete_docs');
  // Processor dashboard used to show zero commission info at all. Same source as the
  // admin's payment ledger (see DB.commissionPayoutForUser) so it always matches what
  // the admin has actually recorded as paid.
  const payout = DB.commissionPayoutForUser(CURRENT_USER.id) || { totalCommission: 0, paid: 0, remaining: 0 };
  document.getElementById('processor-stats').innerHTML = `
    ${statCard(all.length, 'کل مشتریان من')}
    ${statCard(incompleteDocs.length, 'مدارک ناقص')}
    ${statCard(completed.length, 'تکمیل شد')}
    ${statCard(fmtMoney(payout.totalCommission), 'کل پورسانت من')}
    ${statCard(fmtMoney(payout.paid), 'پورسانت پرداخت‌شده')}
    ${statCard(fmtMoney(Math.max(payout.remaining, 0)), 'پورسانت مانده')}
  `;
}

/* --- ADMIN --- */
function renderAdminDashboard(main) {
  const tpl = document.getElementById('tpl-dashboard-admin');
  main.appendChild(tpl.content.cloneNode(true));
  // Manager sees every customer registered by every user in the system, with full details.
  const all = DB.getCustomers();
  const totalFees = all.reduce((s, c) => s + (Number(c.serviceFee?.amount) || 0), 0);
  const totalLoanAmount = all.reduce((s, c) => s + (Number(c.loanAmount) || 0), 0);
  document.getElementById('admin-stats').innerHTML = `
    ${statCard(all.length, 'کل مشتریان (همه کاربران)')}
    ${statCard(all.filter(c => c.stage === 'completed').length, 'تکمیل‌شده')}
    ${statCard(all.filter(c => DB.stageBucket(c.stage) === 'incomplete_docs').length, 'مدارک ناقص')}
    ${statCard(DB.getUsers().filter(u => u.active).length, 'کاربر فعال')}
    ${statCard(fmtMoney(totalFees), 'کل دریافتی خدمات')}
    ${statCard(fmtMoney(totalLoanAmount), 'کل مبلغ وام‌های ثبت‌شده')}
  `;

  const procSel = document.getElementById('filter-processor');
  const callSel = document.getElementById('filter-caller');
  DB.getUsers().filter(u => u.role === 'processor').forEach(u => procSel.add(new Option(u.name, u.id)));
  DB.getUsers().filter(u => u.role === 'caller').forEach(u => callSel.add(new Option(u.name, u.id)));

  paintCustomerList(all, 'customers-list-admin');
  wireFilters(() => DB.getCustomers(), 'customers-list-admin', true, 'filter-stage-admin', 'filter-search-admin');
  document.getElementById('btn-add-customer-admin').onclick = () => openCustomerForm();
}

function wireFilters(getBase, listId, withAssignFilters, stageId, searchId) {
  const stageSel = document.getElementById(stageId);
  const search = document.getElementById(searchId);
  const procSel = document.getElementById('filter-processor');
  const callSel = document.getElementById('filter-caller');
  const sortSel = document.getElementById('filter-sort');
  const apply = () => {
    let list = getBase();
    if (stageSel.value) list = list.filter(c => c.stage === stageSel.value);
    if (withAssignFilters && procSel && procSel.value) list = list.filter(c => c.processorId === procSel.value);
    if (withAssignFilters && callSel && callSel.value) list = list.filter(c => c.callerId === callSel.value);
    const q = search.value.trim();
    if (q) list = list.filter(c => matchesQuery(c.name, c.phone, c.nationalId, q, c.phone2));
    paintCustomerList(list, listId, sortSel ? sortSel.value : 'new');
  };
  stageSel.onchange = apply;
  search.oninput = apply;
  if (procSel) procSel.onchange = apply;
  if (callSel) callSel.onchange = apply;
  if (sortSel) sortSel.onchange = apply;
  apply();
}

// Groups the customer list into one category per processing stage (STAGE_ORDER),
// same idea as the follow-up-status grouping in the caller's lead list - so the
// admin and processor panels get clear labeled sections instead of one long flat
// list. Each section is sorted internally using the chosen sort mode, and - since the
// admin view in particular can hold hundreds/thousands of records - each section is
// also paginated independently instead of dumping every card into the DOM at once.
const CUSTOMER_LIST_PAGE_SIZE = 10;
let customerListPageState = {};   // `${containerId}:${stage}` -> current page number
let customerListCache = {};       // containerId -> { list, sortMode }, so pager buttons can re-render
const LEADS_LIST_PAGE_SIZE = 10;
let leadsListPageState = {};      // `leads-list:${followUpStatus}` -> current page number
function paintCustomerList(list, containerId, sortMode) {
  customerListCache[containerId] = { list, sortMode };
  const el = document.getElementById(containerId);
  const countBox = document.getElementById('customers-count');
  if (countBox) countBox.textContent = `${JalaliUtils.toFa(list.length)} مشتری با این فیلترها یافت شد.`;
  if (!list.length) { el.innerHTML = emptyState('مشتری‌ای یافت نشد.'); return; }
  const sortFn = (a, b) => {
    if (sortMode === 'old') return new Date(a.createdAt) - new Date(b.createdAt);
    if (sortMode === 'amount-desc') return (Number(b.loanAmount) || 0) - (Number(a.loanAmount) || 0);
    if (sortMode === 'amount-asc') return (Number(a.loanAmount) || 0) - (Number(b.loanAmount) || 0);
    return new Date(b.updatedAt) - new Date(a.updatedAt); // 'new' (default)
  };
  const groups = {};
  STAGE_ORDER.forEach(s => { groups[s] = []; });
  list.forEach(c => { (groups[c.stage] || (groups[c.stage] = [])).push(c); });
  el.innerHTML = STAGE_ORDER.filter(s => groups[s].length).map(s => {
    const sorted = groups[s].slice().sort(sortFn);
    const stateKey = `${containerId}:${s}`;
    const { items, page, totalPages } = paginate(sorted, customerListPageState[stateKey] || 1, CUSTOMER_LIST_PAGE_SIZE);
    customerListPageState[stateKey] = page;
    return `
      <div class="customer-group" data-stage="${s}">
        <div class="customer-group-title chip stage-${s}">${STAGE_LABELS[s]} (${JalaliUtils.toFa(groups[s].length)})</div>
        <div class="card-list">${items.map(c => customerCardHTML(c)).join('')}</div>
        ${paginationBarHTML(page, totalPages)}
      </div>
    `;
  }).join('');
  wireCustomerCards(el);
  el.querySelectorAll('[data-page-nav]').forEach(btn => {
    btn.onclick = () => {
      const stage = btn.closest('.customer-group').dataset.stage;
      const stateKey = `${containerId}:${stage}`;
      customerListPageState[stateKey] = (customerListPageState[stateKey] || 1) + (btn.dataset.pageNav === 'next' ? 1 : -1);
      const cached = customerListCache[containerId];
      paintCustomerList(cached.list, containerId, cached.sortMode);
    };
  });
}

function statCard(num, label) {
  return `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`;
}
function emptyState(text) { return `<div class="empty-state">${text}</div>`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// Vertical checklist-style progress timeline: shows all 4 processing steps with the
// completed ones checked, the current one highlighted, and the rest dimmed - so a
// caller can see at a glance where the office specialist's work currently stands.
function stageTimelineHTML(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  return `<div class="stage-timeline">
    ${STAGE_ORDER.map((s, i) => `
      <div class="stage-step ${i < idx ? 'done' : i === idx ? 'current' : 'future'}">
        <span class="stage-step-dot"></span>
        <span class="stage-step-label">${i < idx ? '✓ ' : ''}${STAGE_SHORT_LABELS[s]}</span>
      </div>`).join('')}
  </div>`;
}

function isReminderDue(reminder) {
  if (!reminder || !reminder.dateISO) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const g = JalaliUtils.gregorianPartsFromISO(reminder.dateISO);
  if (!g) return false;
  // y/m/d constructor form always builds a LOCAL-time date directly - unlike
  // `new Date(reminder.dateISO)` (a bare "YYYY-MM-DD" string), which JS parses as UTC
  // midnight and which could then land on the PREVIOUS local day once read back, making a
  // reminder look due a day early on timezones behind UTC.
  const remDate = new Date(g.gy, g.gm - 1, g.gd);
  return remDate <= today;
}

function customerCardHTML(c, opts) {
  opts = opts || {};
  const caller = c.callerId ? DB.getUser(c.callerId) : null;
  const processor = c.processorId ? DB.getUser(c.processorId) : null;
  const reminder = c.reminder;
  return `
  <div class="card ${opts.disableOpen ? 'card-static' : ''}" data-id="${c.id}">
    <div class="card-top">
      <div class="card-title">${esc(c.name)}</div>
      <span class="chip stage-${c.stage}">${STAGE_LABELS[c.stage]}</span>
    </div>
    <div class="card-sub">${esc(c.phone)} ${c.phone2 ? '/ ' + esc(c.phone2) : ''} ${c.nationalId ? '· کد ملی: ' + esc(c.nationalId) : ''} ${c.bankName ? '· ' + esc(c.bankName) : ''} ${c.loanAmount ? '· ' + fmtMoney(c.loanAmount) : ''}</div>
    <div class="card-sub">تاریخ ثبت: ${fmtDate(c.createdAt)}</div>
    ${opts.showStageTimeline ? stageTimelineHTML(c.stage) : ''}
    <div class="card-meta">
      <span class="chip">جذب: ${caller ? esc(caller.name) : 'نامشخص'}</span>
      <span class="chip">کارشناس: ${processor ? esc(processor.name) : '—'}</span>
      ${c.paymentType ? `<span class="chip goods-chip">${PAYMENT_TYPE_LABELS[c.paymentType]}</span>` : ''}
      ${c.stage === 'awaiting_score' && !(c.leadPurchase && c.leadPurchase.approved) ? '<span class="chip followup-incomplete_docs">در انتظار تایید امتیاز توسط مدیر</span>' : ''}
      ${c.stage === 'completed' && c.paymentType === 'goods' ? `<span class="chip stage-completed">وام برداشت‌شده: ${fmtMoney(c.goodsSettlement?.totalLoanWithdrawn)}</span>` : ''}
      ${c.stage === 'completed' && c.paymentType !== 'goods' ? `<span class="chip stage-completed">دریافتی: ${fmtMoney(c.serviceFee?.amount)}</span>` : ''}
      ${reminder ? `<span class="chip reminder-chip ${isReminderDue(reminder) ? 'reminder-due' : ''}" title="${esc(reminder.note || '')}" data-note="${esc(reminder.note || '')}">⏰ یادآوری: ${fmtDate(reminder.dateISO)}</span>` : ''}
    </div>
    <div class="card-actions" onclick="event.stopPropagation()">
      <button type="button" class="btn btn-ghost btn-sm btn-reminder" data-id="${c.id}">⏰ ${reminder ? 'ویرایش یادآوری' : 'افزودن یادآوری'}</button>
    </div>
  </div>`;
}

// Wires both the card-open click and the reminder button for a rendered list of
// customer cards, so every panel (caller/processor/admin/score-requests) gets the
// same behavior from one place. opts.disableOpen skips wiring the "open edit form"
// click - used for the caller's own connected-customers list, where the office
// workflow (stage timeline) is view-only by default UNLESS the admin has granted
// that caller canProcessCustomers (see renderCallerDashboard).
function wireCustomerCards(container, opts) {
  opts = opts || {};
  if (!opts.disableOpen) {
    container.querySelectorAll('.card').forEach(node => {
      node.onclick = () => openCustomerForm(node.dataset.id);
    });
  }
  container.querySelectorAll('.btn-reminder').forEach(btn => {
    btn.onclick = () => openReminderModal(btn.dataset.id);
  });
}

/* ===================== REMINDERS ===================== */
// All reminders due today or overdue, visible to the current user (admin sees
// everyone's; caller/processor only see their own customers), oldest first.
function getDueReminders() {
  if (!CURRENT_USER) return [];
  const custList = CURRENT_USER.role === 'admin' ? DB.getCustomers() : DB.getCustomersForUser(CURRENT_USER);
  const items = custList.filter(c => isReminderDue(c.reminder)).map(c => ({ id: c.id, kind: 'customer', name: c.name, reminder: c.reminder }));
  // A caller's own leads (not yet linked to an office customer) can also carry a
  // reminder now, so they need to show up here too - otherwise a reminder set on a
  // not-yet-linked lead would never surface anywhere.
  const leads = CURRENT_USER.role === 'admin' ? DB.getLeads() : (CURRENT_USER.role === 'caller' ? DB.getLeadsByCaller(CURRENT_USER.id) : []);
  leads.filter(l => isReminderDue(l.reminder)).forEach(l => items.push({ id: l.id, kind: 'lead', name: l.name, reminder: l.reminder }));
  return items.sort((a, b) => new Date(a.reminder.dateISO) - new Date(b.reminder.dateISO));
}

// Keeps the topbar bell badge in sync with the current count of due reminders.
// Called on login, on every navigate(), and whenever cloud data changes.
function updateReminderBadge() {
  const btn = document.getElementById('btn-today-reminders');
  const badge = document.getElementById('reminder-bell-badge');
  if (!btn || !badge || !CURRENT_USER) return;
  const n = getDueReminders().length;
  if (n > 0) {
    badge.textContent = n > 99 ? '99+' : JalaliUtils.toFa(n);
    badge.classList.remove('hidden');
    btn.classList.add('has-due');
  } else {
    badge.classList.add('hidden');
    btn.classList.remove('has-due');
  }
}

// Renders/opens the today-reminders popup for a given list. Used both for the
// automatic once-per-session popup and for manual opens via the topbar bell icon.
function renderTodayRemindersModal(due) {
  const box = openModal('tpl-modal-today-reminders');
  const countEl = box.querySelector('#today-reminders-count');
  const hint = box.querySelector('#today-reminders-hint');
  const listEl = box.querySelector('#today-reminders-list');

  // Re-renders the list in place (without re-opening the modal) after a
  // complete/delete action, so the popup stays open and just updates itself.
  function refresh(list) {
    countEl.textContent = JalaliUtils.toFa(list.length);
    if (!list.length) {
      hint.textContent = 'یادآوری‌ای برای امروز یا گذشته ثبت نشده است.';
      listEl.innerHTML = '<div class="empty-state">هیچ یادآوری فعالی وجود ندارد ✓</div>';
      return;
    }
    hint.textContent = 'برای مشاهده و ویرایش هرکدام، روی آن بزنید، یا از گزینه‌های «تکمیل»/«حذف» استفاده کنید.';
    listEl.innerHTML = list.map(item => `
      <div class="card" data-id="${item.id}" data-kind="${item.kind}">
        <div class="card-top">
          <div class="card-title">${esc(item.name)}</div>
          <span class="chip reminder-chip reminder-due">⏰ ${fmtDate(item.reminder.dateISO)}</span>
        </div>
        ${item.kind === 'lead' ? `<div class="card-sub">مشتری تلفنی (لید)</div>` : ''}
        ${item.reminder.note ? `<div class="card-sub">${esc(item.reminder.note)}</div>` : ''}
        <div class="card-actions" onclick="event.stopPropagation()">
          <button type="button" class="btn btn-primary btn-sm btn-complete-reminder" data-id="${item.id}" data-kind="${item.kind}">✓ تکمیل شد</button>
          <button type="button" class="btn btn-danger btn-sm btn-delete-reminder" data-id="${item.id}" data-kind="${item.kind}">🗑 حذف</button>
        </div>
      </div>
    `).join('');

    // Clicking anywhere on the card (other than the action buttons) opens the
    // matching edit form - the customer window for a linked customer, or the lead
    // form for a not-yet-linked lead - same as before.
    listEl.querySelectorAll('.card').forEach(node => {
      node.onclick = () => {
        closeModal();
        if (node.dataset.kind === 'lead') openLeadForm(node.dataset.id);
        else openCustomerForm(node.dataset.id);
      };
    });
    listEl.querySelectorAll('.btn-complete-reminder').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (btn.dataset.kind === 'lead') DB.updateLead(btn.dataset.id, { reminder: null });
        else DB.updateCustomer(btn.dataset.id, { reminder: null });
        toast('یادآوری تکمیل‌شده علامت خورد.');
        updateReminderBadge();
        refresh(getDueReminders());
      };
    });
    listEl.querySelectorAll('.btn-delete-reminder').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (!confirm('آیا از حذف این یادآوری مطمئن هستید؟')) return;
        if (btn.dataset.kind === 'lead') DB.updateLead(btn.dataset.id, { reminder: null });
        else DB.updateCustomer(btn.dataset.id, { reminder: null });
        toast('یادآوری حذف شد.');
        updateReminderBadge();
        refresh(getDueReminders());
      };
    });
  }

  refresh(due);
}

// Small heads-up popup, shown once per browser tab session right after the app
// loads (login or restored session), listing every reminder that is due today
// or overdue - so nothing gets missed without having to dig through each panel.
function checkTodayReminders() {
  if (sessionStorage.getItem('loanCRM_remindersShown')) return;
  sessionStorage.setItem('loanCRM_remindersShown', '1');
  const due = getDueReminders();
  if (!due.length) return;
  renderTodayRemindersModal(due);
}

// Topbar bell icon: opens the same popup on demand, any time, and closes on
// its own close button, the backdrop, or a click anywhere outside it (handled
// by openModal/closeModal already).
document.getElementById('btn-today-reminders').addEventListener('click', () => {
  renderTodayRemindersModal(getDueReminders());
});

// kind 'customer' (default) -> office customer record; kind 'lead' -> a caller's own
// lead (before/without being linked to an office customer). Both share the exact same
// { dateISO, note, createdAt, createdBy, createdByName } reminder shape, so one modal
// and one save path covers every customer the panel user has, linked or not.
function openReminderModal(id, kind) {
  kind = kind === 'lead' ? 'lead' : 'customer';
  const c = kind === 'lead' ? DB.getLeads().find(l => l.id === id) : DB.getCustomer(id);
  if (!c) return;
  const box = openModal('tpl-modal-reminder');
  const form = box.querySelector('#form-reminder');
  box.querySelector('#reminder-customer-name').textContent = c.name || '';
  const dateWidget = buildJalaliDateSelects(form.querySelector('#reminder-date-wrap'), c.reminder?.dateISO || nowISO());
  form.note.value = c.reminder?.note || '';

  const saveReminder = (reminder) => kind === 'lead' ? DB.updateLead(id, { reminder }) : DB.updateCustomer(id, { reminder });

  const clearBtn = form.querySelector('#btn-clear-reminder');
  if (c.reminder) {
    clearBtn.style.display = 'inline-block';
    clearBtn.onclick = () => {
      saveReminder(null);
      toast('یادآوری حذف شد.');
      closeModal();
      navigate(CURRENT_ROUTE);
      updateReminderBadge();
    };
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveReminder({
      dateISO: dateWidget.getISO(),
      note: form.note.value.trim(),
      createdAt: nowISO(),
      createdBy: CURRENT_USER.id,
      createdByName: CURRENT_USER.name
    });
    toast('یادآوری ذخیره شد.');
    closeModal();
    navigate(CURRENT_ROUTE);
    updateReminderBadge();
  });
}

/* ===================== CUSTOMER FORM ===================== */
function openCustomerForm(customerId, opts) {
  opts = opts || {};
  const isEdit = !!customerId;
  const c = isEdit ? DB.getCustomer(customerId) : null;
  // Lets a caller with canProcessCustomers "start the office file" directly from one of
  // their own leads (see leadCardHTML's btn-start-customer-from-lead), pre-filling the
  // new-customer form with that lead's name/phone/nationalId instead of a blank form.
  const prefillLead = (!isEdit && opts.leadId) ? DB.getLeads().find(l => l.id === opts.leadId) : null;
  const box = openModal('tpl-modal-customer');
  const form = box.querySelector('#form-customer');

  box.querySelector('#customer-form-title').textContent = isEdit ? 'ویرایش مشتری' : (prefillLead ? 'شروع پرونده دفتر' : 'ثبت مشتری جدید');

  attachAllMoneyFormatters(form);

  // Commissions are visible/editable only to the manager - removed entirely from the
  // office-specialist (processor) view, per office policy.
  const commissionsFieldset = form.querySelector('#commissions-fieldset');
  if (CURRENT_USER.role !== 'admin') commissionsFieldset.remove();

  // Which کارشناس دفتر (processor) this customer belongs to: normally set automatically
  // (whoever registers the customer), but previously had NO way to be assigned or changed
  // when the manager registers/edits a customer directly - leaving it permanently empty and
  // invisible to every processor. Admin-only, same pattern as commissionsFieldset above.
  const processorAssignFieldset = form.querySelector('#processor-assign-fieldset');
  const processorSelect = form.querySelector('#customer-processor-select');

  // جذب‌کننده تلفنی (caller) این مشتری: پیش‌تر پس از تبدیل لید به مشتری اصلاً قابل تغییر
  // نبود (فقط یک متن اطلاعاتی در match-info نمایش داده می‌شد). گاهی لازم است مدیر این
  // اتصال را دستی اصلاح کند (مثلاً تطابق اشتباه، یا انتقال مشتری بین جذب‌کننده‌ها) - پس
  // مثل processorAssignFieldset، فقط برای مدیر یک select قابل‌تغییر اضافه شده.
  const callerAssignFieldset = form.querySelector('#caller-assign-fieldset');
  const callerSelect = form.querySelector('#customer-caller-select');
  if (CURRENT_USER.role !== 'admin') {
    callerAssignFieldset.remove();
  } else {
    const callerOptions = DB.getUsers().filter(u => u.role === 'caller');
    // مثل processorOptions: اگر جذب‌کننده‌ی فعلی به هر دلیلی (نقشش عوض شده و...) در لیست
    // نیست، همچنان در دراپ‌داون نگه داشته شود تا ذخیره‌ی دوباره‌ی فرم بدون دست‌زدن به این
    // فیلد، اتصال معتبر موجود را پاک نکند.
    if (c?.callerId && !callerOptions.some(u => u.id === c.callerId)) {
      callerOptions.push(DB.getUser(c.callerId) || { id: c.callerId, name: 'کاربر نامشخص' });
    }
    callerOptions.forEach(u => callerSelect.add(new Option(u.name, u.id)));
    callerSelect.value = c?.callerId || '';
  }

  if (CURRENT_USER.role !== 'admin') {
    processorAssignFieldset.remove();
  } else {
    // Also includes callers with canProcessCustomers - covers the case where a customer's
    // lead belongs to one caller but a different caller (or the admin, on their behalf)
    // needs to hand the office/کارشناس role to a second caller who actually processed the
    // file in person (see DB.getCustomersForUser/DB.canProcessCustomer for the matching
    // read-access side of this). Labeled distinctly in the dropdown so the admin can tell
    // them apart from real کارشناس دفتر (processor) users.
    const processorOptions = DB.getUsers().filter(u => u.role === 'processor' || (u.role === 'caller' && u.canProcessCustomers));
    // Always keep the currently-assigned processor selectable, even in the edge case where
    // their role changed after being assigned - otherwise just opening and re-saving this
    // form (without touching the dropdown) would silently clear a valid assignment.
    if (c?.processorId && !processorOptions.some(u => u.id === c.processorId)) {
      processorOptions.push(DB.getUser(c.processorId) || { id: c.processorId, name: 'کاربر نامشخص' });
    }
    processorOptions.forEach(u => processorSelect.add(new Option(u.role === 'caller' ? `${u.name} (جذب تلفنی)` : u.name, u.id)));
    processorSelect.value = c?.processorId || '';
  }

  // Commission auto-calc based on global settings (percent of loan amount), unless the
  // admin switched the whole system to manual entry, OR the specific caller/processor
  // linked to this customer was individually selected (Settings > manual per-user list)
  // to always be entered manually - independently for the caller side and processor side.
  const commSettings = DB.getSettings();
  const globalManual = commSettings.commissionMode === 'manual';
  // اگر سلکت جذب‌کننده/کارشناسِ ادمین در فرم حضور دارد، مقدار پورسانت باید بر اساس همان
  // چیزی که ادمین *الان* در دراپ‌داون انتخاب کرده محاسبه/نمایش شود - نه اینکه برای همیشه
  // روی جذب‌کننده/کارشناسِ لحظه‌ی باز شدن فرم قفل بماند. پس این دو let هستند و با تغییر
  // سلکت‌ها به‌روزرسانی می‌شوند (زیر همین بلوک).
  let currentCallerId = callerAssignFieldset.isConnected ? (callerSelect.value || null) : (c?.callerId || null);
  let currentProcessorId = processorAssignFieldset.isConnected ? (processorSelect.value || null) : (c?.processorId || (CURRENT_USER.role === 'processor' ? CURRENT_USER.id : null));
  let recalcCommissions = () => {};
  const noteBox = commissionsFieldset.isConnected ? form.querySelector('#commission-mode-note') : null;
  function refreshCommissionNote() {
    if (!noteBox) return;
    if (globalManual) {
      noteBox.textContent = 'حالت فعلی: ورود دستی مبلغ پورسانت توسط مدیر برای همه (از تنظیمات پورسانت قابل تغییر است).';
      return;
    }
    const calc = DB.computeCommissions(0, { callerId: currentCallerId, processorId: currentProcessorId });
    const callerNote = calc.callerManual ? 'ورود دستی (این جذب‌کننده به‌صورت اختصاصی دستی انتخاب شده)' : `${commSettings.callerPercent}٪ مبلغ وام`;
    const processorNote = calc.processorManual ? 'ورود دستی (این کارشناس به‌صورت اختصاصی دستی انتخاب شده)' : `${commSettings.processorPercent}٪ مبلغ وام`;
    noteBox.textContent = `حالت فعلی — پورسانت جذب‌کننده: ${callerNote} · پورسانت کارشناس دفتر: ${processorNote} (از تنظیمات پورسانت قابل تغییر است).`;
  }
  if (commissionsFieldset.isConnected) {
    refreshCommissionNote();
    recalcCommissions = () => {
      const loanAmount = getRawNumber(form.loanAmount);
      const calc = DB.computeCommissions(loanAmount, { callerId: currentCallerId, processorId: currentProcessorId });
      if (!calc.callerManual) setMoneyInputValue(form.callerCommissionAmount, calc.callerAmount);
      if (!calc.processorManual) setMoneyInputValue(form.processorCommissionAmount, calc.processorAmount);
      form.callerCommissionAmount.readOnly = !calc.callerManual;
      form.processorCommissionAmount.readOnly = !calc.processorManual;
    };
    form.loanAmount.addEventListener('input', recalcCommissions);
    recalcCommissions();
  }
  // با تغییر جذب‌کننده/کارشناس از سلکت‌های بالا، پیش‌نمایش پورسانت (متن راهنما + مبلغ) هم
  // بلافاصله بر اساس کاربر جدید به‌روز می‌شود - مقدار نهایی واقعی باز هم هنگام ذخیره توسط
  // DB.updateCustomer بازمحاسبه و تضمین می‌شود (برای پرونده‌های قبلاً تکمیل‌شده).
  if (callerAssignFieldset.isConnected) {
    callerSelect.addEventListener('change', () => {
      currentCallerId = callerSelect.value || null;
      refreshCommissionNote();
      recalcCommissions();
      // اگر جذب‌کننده‌ی تازه‌انتخاب‌شده در حالت پورسانت دستی است، عددی که همین الان در
      // فیلد نشان داده می‌شود متعلق به محاسبه/ثبت جذب‌کننده‌ی قبلی است، نه این یکی - اگر
      // پاک نشود، مدیر فکر می‌کند همان عدد ذخیره خواهد شد، در حالی که DB.updateCustomer
      // هنگام ذخیره آن را صفر می‌کند (چون پورسانت واقعاً به کاربر جدید تعلق نگرفته).
      if (commissionsFieldset.isConnected) {
        const calc = DB.computeCommissions(getRawNumber(form.loanAmount), { callerId: currentCallerId, processorId: currentProcessorId });
        if (calc.callerManual) setMoneyInputValue(form.callerCommissionAmount, 0);
      }
    });
  }
  if (processorAssignFieldset.isConnected) {
    processorSelect.addEventListener('change', () => {
      currentProcessorId = processorSelect.value || null;
      refreshCommissionNote();
      recalcCommissions();
      if (commissionsFieldset.isConnected) {
        const calc = DB.computeCommissions(getRawNumber(form.loanAmount), { callerId: currentCallerId, processorId: currentProcessorId });
        if (calc.processorManual) setMoneyInputValue(form.processorCommissionAmount, 0);
      }
    });
  }

  // permission: only admin (or a user the admin has granted this to) can record/approve
  // "خرید امتیاز" (score purchase) and "تسویه خرید کالا" (goods purchase settlement).
  // Per office policy the office specialist (processor) doesn't see these sections at
  // all - they belong entirely to the manager's panel - so they're removed from the DOM
  // instead of just being disabled.
  const canSeeLeadPurchase = DB.canApproveScore(CURRENT_USER);
  const leadFieldset = form.querySelector('#lead-purchase-fieldset');
  const goodsPurchaseFieldset = form.querySelector('#goods-purchase-fieldset');
  if (!canSeeLeadPurchase) {
    leadFieldset.remove();
    goodsPurchaseFieldset.remove();
  }

  // Jalali date-select for the score-purchase date (only built when the fieldset exists)
  const leadDateWidget = leadFieldset.isConnected
    ? buildJalaliDateSelects(form.querySelector('#lead-date-wrap'), c?.leadPurchase?.date || null)
    : null;

  // ---------- visibility of the workflow fieldsets, driven by stage + payment type ----------
  const contractFieldset = form.querySelector('#contract-fieldset');
  const withdrawCashFieldset = form.querySelector('#withdrawal-cash-fieldset');
  const withdrawGoodsFieldset = form.querySelector('#withdrawal-goods-fieldset');
  const stageSelect = form.querySelector('#customer-stage-select');
  const paymentTypeSelect = form.querySelector('#customer-payment-type');
  const stageHelp = form.querySelector('#stage-help-text');
  const STAGE_HELP = {
    awaiting_docs: 'مدارک مشتری را دریافت کنید. وقتی کامل شد، مرحله را روی «مدارک تکمیل شد» بگذارید تا قسمت آپلود قرارداد ظاهر شود.',
    awaiting_score: 'تصویر قرارداد را اینجا آپلود کنید. این مشتری در لیست «درخواست‌های خرید امتیاز» برای مدیر/شخص مجاز نمایش داده می‌شود تا خرید امتیاز را ثبت و تایید کند.',
    awaiting_withdrawal: 'پس از تایید خرید امتیاز توسط مدیر، اطلاعات دریافتی خدمات وام (وجه نقد) یا جزییات فروش کالا را تکمیل کنید.',
    completed: 'پرونده تکمیل شده و پورسانت‌ها لحاظ می‌شود.'
  };
  function isLeadApproved() {
    const cb = form.querySelector('#lead-purchase-approved');
    return !!(c?.leadPurchase?.approved) || (cb ? cb.checked : false);
  }
  function syncWorkflowVisibility() {
    const stage = stageSelect.value;
    const paymentType = paymentTypeSelect.value;
    stageHelp.textContent = STAGE_HELP[stage] || '';
    // مدارک: تصویر قرارداد، از مرحله «مدارک تکمیل شد - در انتظار دریافت امتیاز» به بعد
    contractFieldset.classList.toggle('hidden', stage === 'awaiting_docs');
    if (leadFieldset.isConnected) leadFieldset.classList.toggle('hidden', stage === 'awaiting_docs');
    const approved = isLeadApproved();
    const atWithdrawalOrLater = stage === 'awaiting_withdrawal' || stage === 'completed';
    withdrawCashFieldset.classList.toggle('hidden', !(atWithdrawalOrLater && approved && paymentType === 'cash'));
    withdrawGoodsFieldset.classList.toggle('hidden', !(atWithdrawalOrLater && approved && paymentType === 'goods'));
    // تسویه خرید کالا (مدیر): فقط وقتی پرونده تکمیل شده و نوع دریافت خرید کالا بوده
    if (goodsPurchaseFieldset.isConnected) {
      goodsPurchaseFieldset.classList.toggle('hidden', !(stage === 'completed' && paymentType === 'goods'));
    }
  }
  stageSelect.addEventListener('change', () => {
    syncWorkflowVisibility();
    // The stage selector sits at the bottom of the form (so it's not missed while
    // scrolling down), but the fieldset it reveals sits higher up. Scroll that
    // fieldset into view automatically so the user doesn't have to hunt for it.
    const revealedFieldset = [contractFieldset, withdrawCashFieldset, withdrawGoodsFieldset, goodsPurchaseFieldset]
      .find(fs => fs && fs.isConnected && !fs.classList.contains('hidden'));
    if (revealedFieldset) revealedFieldset.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  paymentTypeSelect.addEventListener('change', syncWorkflowVisibility);
  const leadApprovedCheckbox = form.querySelector('#lead-purchase-approved');
  if (leadApprovedCheckbox) leadApprovedCheckbox.addEventListener('change', syncWorkflowVisibility);

  // مبلغ باقی‌مانده (جزییات فروش کالا) = مبلغ فروش − مبلغ پیش‌پرداخت، به‌صورت خودکار
  function recalcGoodsRemaining() {
    const remaining = getRawNumber(form.goodsSaleAmount) - getRawNumber(form.goodsDownPayment);
    setMoneyInputValue(form.goodsRemaining, remaining > 0 ? remaining : 0);
  }
  form.goodsSaleAmount.addEventListener('input', recalcGoodsRemaining);
  form.goodsDownPayment.addEventListener('input', recalcGoodsRemaining);

  // processors only manage their own customers; restrict edit of others for non-admin -
  // UNLESS this user has been granted "خرید امتیاز" approval rights (canApproveScore), in
  // which case they're specifically meant to act on ANY customer awaiting score approval,
  // regardless of which processor it's assigned to (see renderScoreRequests/getScoreRequests,
  // which already list customers system-wide for such a user). Without this exception, the
  // very permission granted to them was unusable: opening another processor's customer from
  // the "درخواست‌های خرید امتیاز" list disabled the entire form, including the score-purchase
  // fields and the save button.
  // a caller may only edit a customer if the admin has granted canProcessCustomers AND
  // the customer is actually their own (see DB.canProcessCustomer) - otherwise, same as
  // before, they get a view-only form. This also covers entry points other than the
  // dashboard card (e.g. the due-reminders modal), which don't gate opening the form.
  const readOnly = isEdit && (
    (CURRENT_USER.role === 'processor' && c.processorId && c.processorId !== CURRENT_USER.id && !canSeeLeadPurchase)
    || (CURRENT_USER.role === 'caller' && !DB.canProcessCustomer(CURRENT_USER, c))
  );

  let contractBase64 = c?.contractImage || null;
  let creditValidationBase64 = c?.creditValidationImage || null;
  let leadPurchaseReceiptBase64 = c?.leadPurchase?.receiptImage || null;
  let goodsPurchaseReceiptBase64 = c?.goodsPurchase?.receiptImage || null;
  let goodsWithdrawReceiptBase64 = c?.goodsSettlement?.receiptImage || null;

  if (isEdit) {
    form.name.value = c.name;
    form.phone.value = c.phone;
    form.phone2.value = c.phone2 || '';
    form.nationalId.value = c.nationalId;
    form.accountNumber.value = c.accountNumber || '';
    setMoneyInputValue(form.loanAmount, c.loanAmount);
    setMoneyInputValue(form.maxLoanWithoutGuarantor, c.maxLoanWithoutGuarantor);
    form.bankName.value = c.bankName || '';
    paymentTypeSelect.value = c.paymentType || '';
    stageSelect.value = c.stage;
    if (commissionsFieldset.isConnected) {
      setMoneyInputValue(form.callerCommissionAmount, c.callerCommission?.amount);
      form.callerCommissionPaid.checked = !!c.callerCommission?.paid;
      setMoneyInputValue(form.processorCommissionAmount, c.processorCommission?.amount);
      form.processorCommissionPaid.checked = !!c.processorCommission?.paid;
      recalcCommissions(); // in percent mode, refresh display using current loan amount + settings
    }
    if (c.contractImage) renderImagePreviewButton(document.getElementById('contract-preview'), c.contractImage, 'قرارداد');
    if (c.creditValidationImage) renderImagePreviewButton(document.getElementById('credit-validation-preview'), c.creditValidationImage, 'اعتبارسنجی');
    if (c.leadPurchase && leadFieldset.isConnected) {
      form.leadFromName.value = c.leadPurchase.fromName || '';
      form.leadPurchaseToAccount.value = c.leadPurchase.toAccount || '';
      setMoneyInputValue(form.leadPurchaseAmount, c.leadPurchase.amount);
      form.querySelector('#lead-purchase-approved').checked = !!c.leadPurchase.approved;
      if (c.leadPurchase.receiptImage) renderImagePreviewButton(document.getElementById('lead-purchase-receipt-preview'), c.leadPurchase.receiptImage, 'فیش واریزی');
    }
    if (c.goodsSettlement) {
      form.goodsName.value = c.goodsSettlement.goodsName || '';
      setMoneyInputValue(form.goodsSaleAmount, c.goodsSettlement.saleAmount);
      setMoneyInputValue(form.goodsDownPayment, c.goodsSettlement.downPayment);
      setMoneyInputValue(form.goodsRemaining, c.goodsSettlement.remainingAmount);
      setMoneyInputValue(form.goodsTotalWithdrawn, c.goodsSettlement.totalLoanWithdrawn);
      if (c.goodsSettlement.receiptImage) renderImagePreviewButton(document.getElementById('goods-withdraw-receipt-preview'), c.goodsSettlement.receiptImage, 'رسید برداشت');
    }
    if (c.goodsPurchase && goodsPurchaseFieldset.isConnected) {
      form.goodsPurchaseName.value = c.goodsPurchase.goodsName || '';
      form.goodsPurchaseFromName.value = c.goodsPurchase.fromName || '';
      setMoneyInputValue(form.goodsPurchaseAmount, c.goodsPurchase.amount);
      if (c.goodsPurchase.receiptImage) renderImagePreviewButton(document.getElementById('goods-purchase-receipt-preview'), c.goodsPurchase.receiptImage, 'فیش واریزی');
    }
    if (c.serviceFee) {
      setMoneyInputValue(form.serviceFeeAmount, c.serviceFee.amount);
      form.serviceToAccount.value = c.serviceFee.toAccount || '';
      if (c.serviceFee.receiptImage) {
        renderImagePreviewButton(document.getElementById('receipt-preview'), c.serviceFee.receiptImage, 'رسید');
      }
    }
    const caller = c.callerId ? DB.getUser(c.callerId) : null;
    const matchBox = document.getElementById('match-info');
    matchBox.classList.remove('hidden');
    matchBox.textContent = caller
      ? `این مشتری به «${caller.name}» به‌عنوان جذب‌کننده تلفنی متصل است.`
      : 'هیچ جذب‌کننده تلفنی برای این مشتری شناسایی نشده است. اگر شماره تماس یا کد ملی را ثبت/اصلاح کنید و لید مطابقی وجود داشته باشد، به‌صورت خودکار متصل می‌شود.';
    // Delete/edit is now available in every panel, not just the manager's: admins can
    // delete any customer; a processor or caller can delete only the customer that is
    // actually assigned/connected to them.
    const canDeleteCustomer = CURRENT_USER.role === 'admin'
      || (CURRENT_USER.role === 'processor' && c.processorId === CURRENT_USER.id)
      || (CURRENT_USER.role === 'caller' && c.callerId === CURRENT_USER.id);
    const delBtn = document.getElementById('btn-delete-customer');
    if (canDeleteCustomer) {
      delBtn.style.display = 'inline-block';
      delBtn.onclick = () => {
        if (confirm('آیا از حذف این مشتری مطمئن هستید؟')) {
          DB.deleteCustomer(c.id); toast('مشتری حذف شد.'); closeModal(); navigate(CURRENT_ROUTE);
        }
      };
    }

    // Manager-only: copy the customer's full info (personal details + loan details)
    // in one click, so it can be pasted elsewhere (chat, SMS, another system, ...).
    const copyBtn = document.getElementById('btn-copy-customer');
    if (CURRENT_USER.role === 'admin') {
      copyBtn.style.display = 'inline-block';
      copyBtn.onclick = () => copyCustomerDetailsToClipboard(form, { caller, processor: c.processorId ? DB.getUser(c.processorId) : null });
    }
  } else if (prefillLead) {
    form.name.value = prefillLead.name || '';
    form.phone.value = prefillLead.rawPhone || prefillLead.phone || '';
    form.nationalId.value = prefillLead.nationalId || '';
  }

  syncWorkflowVisibility();

  if (readOnly) {
    Array.from(form.elements).forEach(el => el.disabled = true);
  }

  // Every "change" handler below: (1) compresses/resizes the photo client-side so a
  // multi-MB camera photo doesn't blow past the 1MB Firestore document limit or the
  // shared localStorage quota, (2) shows the resulting file size under the preview so
  // it's visible that the image was actually processed, and (3) toasts a clear error
  // if the file couldn't be read at all, instead of failing silently.
  let receiptBase64 = c?.serviceFee?.receiptImage || null;
  form.receiptImage.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById('receipt-preview');
    box.innerHTML = 'در حال پردازش تصویر…';
    const result = await compressImageToDataURL(file);
    if (!result) { toast('خواندن فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'error'); box.innerHTML = ''; return; }
    receiptBase64 = result;
    renderImagePreviewButton(box, receiptBase64, 'رسید');
    attachSizeCaption(box, receiptBase64);
  });
  if (leadFieldset.isConnected) {
    form.leadPurchaseReceipt.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const box = document.getElementById('lead-purchase-receipt-preview');
      box.innerHTML = 'در حال پردازش تصویر…';
      const result = await compressImageToDataURL(file);
      if (!result) { toast('خواندن فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'error'); box.innerHTML = ''; return; }
      leadPurchaseReceiptBase64 = result;
      renderImagePreviewButton(box, leadPurchaseReceiptBase64, 'فیش واریزی');
      attachSizeCaption(box, leadPurchaseReceiptBase64);
    });
  }
  if (goodsPurchaseFieldset.isConnected) {
    form.goodsPurchaseReceipt.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const box = document.getElementById('goods-purchase-receipt-preview');
      box.innerHTML = 'در حال پردازش تصویر…';
      const result = await compressImageToDataURL(file);
      if (!result) { toast('خواندن فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'error'); box.innerHTML = ''; return; }
      goodsPurchaseReceiptBase64 = result;
      renderImagePreviewButton(box, goodsPurchaseReceiptBase64, 'فیش واریزی');
      attachSizeCaption(box, goodsPurchaseReceiptBase64);
    });
  }
  form.goodsWithdrawReceipt.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById('goods-withdraw-receipt-preview');
    box.innerHTML = 'در حال پردازش تصویر…';
    const result = await compressImageToDataURL(file);
    if (!result) { toast('خواندن فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'error'); box.innerHTML = ''; return; }
    goodsWithdrawReceiptBase64 = result;
    renderImagePreviewButton(box, goodsWithdrawReceiptBase64, 'رسید برداشت');
    attachSizeCaption(box, goodsWithdrawReceiptBase64);
  });
  form.contractImage.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById('contract-preview');
    box.innerHTML = 'در حال پردازش تصویر…';
    const result = await compressImageToDataURL(file);
    if (!result) { toast('خواندن فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'error'); box.innerHTML = ''; return; }
    contractBase64 = result;
    renderImagePreviewButton(box, contractBase64, 'قرارداد');
    attachSizeCaption(box, contractBase64);
  });
  form.creditValidationImage.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById('credit-validation-preview');
    box.innerHTML = 'در حال پردازش تصویر…';
    const result = await compressImageToDataURL(file);
    if (!result) { toast('خواندن فایل ناموفق بود. لطفاً دوباره تلاش کنید.', 'error'); box.innerHTML = ''; return; }
    creditValidationBase64 = result;
    renderImagePreviewButton(box, creditValidationBase64, 'اعتبارسنجی');
    attachSizeCaption(box, creditValidationBase64);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    let stage = fd.get('stage');
    const paymentType = fd.get('paymentType') || '';
    const approvedNow = leadApprovedCheckbox ? leadApprovedCheckbox.checked : !!(c?.leadPurchase?.approved);

    // مشخصات مشتری: شماره تماس و کد ملی چک شود (فرمت صحیح ایرانی)
    // normalizePhone() also handles trimming/stripping non-digits, so the phone is stored
    // the same standardized way regardless of digit set (فارسی/عربی/انگلیسی) or spacing -
    // matching how leads and nationalId already work. Without this, a number typed with
    // Persian digits still passed validation (isValidMobile normalizes internally) but was
    // saved as-is, so later searching by phone (matchesQuery) could never find it again.
    const phoneValue = normalizePhone(fd.get('phone') || '');
    // شماره تماس دوم اختیاری است؛ اگر خالی بماند نیازی به اعتبارسنجی نیست، اما اگر پر شود
    // باید مثل شماره اول یک موبایل معتبر باشد.
    const phone2Value = normalizePhone(fd.get('phone2') || '');
    const nationalIdValue = (fd.get('nationalId') || '').trim();
    if (!DB.isValidMobile(phoneValue)) {
      toast('شماره تماس معتبر نیست. لطفاً شماره موبایل را به‌صورت صحیح (مثلاً 09123456789) وارد کنید.', 'error');
      return;
    }
    if (phone2Value && !DB.isValidMobile(phone2Value)) {
      toast('شماره تماس دوم معتبر نیست. لطفاً شماره موبایل را به‌صورت صحیح (مثلاً 09123456789) وارد کنید یا آن را خالی بگذارید.', 'error');
      return;
    }
    if (nationalIdValue && !DB.isValidNationalId(nationalIdValue)) {
      toast('کد ملی وارد شده معتبر نیست. لطفاً دوباره بررسی کنید.', 'error');
      return;
    }

    // safety gate: an office specialist (without score-approval access) cannot push a
    // file past "awaiting_score" until the manager/authorized person has approved it.
    if (!canSeeLeadPurchase && (stage === 'awaiting_withdrawal' || stage === 'completed') && !c?.leadPurchase?.approved) {
      toast('تا زمانی که مدیر یا شخص مجاز، خرید امتیاز را تایید نکند، نمی‌توانید به مرحله برداشت - تسویه یا تکمیل بروید.', 'error');
      return;
    }
    // once the manager checks "approve" while still on awaiting_score, move the file
    // forward automatically so the office specialist sees it needs the next step.
    if (canSeeLeadPurchase && approvedNow && stage === 'awaiting_score') stage = 'awaiting_withdrawal';

    const payload = {
      name: fd.get('name'), phone: phoneValue, phone2: phone2Value, nationalId: nationalIdValue,
      accountNumber: (fd.get('accountNumber') || '').trim(),
      // حداکثر وام دریافتی بدون ضامن: فقط برای ثبت/نمایش است - عمداً در computeCommissions،
      // فرمول معکوس یا هیچ محاسبه‌ی دیگری استفاده نمی‌شود.
      maxLoanWithoutGuarantor: getRawNumber(form.maxLoanWithoutGuarantor),
      loanAmount: getRawNumber(form.loanAmount), bankName: fd.get('bankName'),
      paymentType, stage, contractImage: contractBase64, creditValidationImage: creditValidationBase64
    };
    // انتخاب/تغییر کارشناس دفتر: فقط مدیر این فیلد را در فرم دارد (برای بقیه‌ی کاربران این
    // فیلدست از DOM حذف شده)، پس این کلید فقط وقتی در payload قرار می‌گیرد که واقعاً مدیر
    // باشد - مقدار قبلی برای بقیه‌ی کاربران دست‌نخورده می‌ماند.
    // انتخاب/تغییر جذب‌کننده تلفنی: فقط مدیر این فیلد را در فرم دارد (برای بقیه‌ی کاربران
    // این فیلدست از DOM حذف شده)، پس این کلید فقط وقتی در payload قرار می‌گیرد که واقعاً
    // مدیر باشد - مقدار قبلی برای بقیه‌ی کاربران دست‌نخورده می‌ماند.
    if (callerAssignFieldset.isConnected) {
      payload.callerId = callerSelect.value || null;
    }
    if (processorAssignFieldset.isConnected) {
      payload.processorId = processorSelect.value || null;
    } else if (CURRENT_USER.role === 'caller' && (isEdit ? DB.canProcessCustomer(CURRENT_USER, c) : !!CURRENT_USER.canProcessCustomers)) {
      // این کاربر جذب تلفنی خودش دارد مراحل دریافت وام مشتریِ خودش را جلو می‌برد - یعنی
      // نقش کارشناس دفتر را هم برای همین پرونده ایفا می‌کند، پس باید به‌عنوان کارشناس
      // (processorId) هم به خودش وصل شود؛ در غیر این صورت پورسانت کارشناس دفتر و فیلد
      // «کارشناس» در کارت مشتری برای همیشه بدون صاحب (—) باقی می‌ماند. همین قانون برای
      // پرونده‌ی تازه‌ساز (شروع پرونده از روی لید خودش) هم صدق می‌کند.
      payload.processorId = CURRENT_USER.id;
    }
    // پورسانت‌ها فقط برای مدیر قابل مشاهده/ورود است؛ برای بقیه کاربران این کلید اصلاً
    // در payload قرار نمی‌گیرد تا مقدار قبلی در دیتابیس دست‌نخورده بماند.
    if (commissionsFieldset.isConnected) {
      payload.callerCommission = {
        amount: getRawNumber(form.callerCommissionAmount),
        paid: form.callerCommissionPaid.checked
      };
      payload.processorCommission = {
        amount: getRawNumber(form.processorCommissionAmount),
        paid: form.processorCommissionPaid.checked
      };
    }
    // "خرید امتیاز" فقط در پنل مدیر (یا شخص مجاز) وجود دارد؛ برای کارشناس دفتر این
    // فیلدست از فرم حذف شده، پس مقدار قبلی دست‌نخورده باقی می‌ماند.
    if (leadFieldset.isConnected) {
      const leadFromName = fd.get('leadFromName');
      payload.leadPurchase = {
        fromName: leadFromName || '',
        toAccount: fd.get('leadPurchaseToAccount') || '',
        date: leadDateWidget ? leadDateWidget.getISO() : null,
        amount: getRawNumber(form.leadPurchaseAmount),
        receiptImage: leadPurchaseReceiptBase64,
        approved: approvedNow,
        approvedAt: approvedNow && !c?.leadPurchase?.approved ? nowISO() : (c?.leadPurchase?.approvedAt || null),
        approvedBy: approvedNow ? CURRENT_USER.id : (c?.leadPurchase?.approvedBy || null)
      };
    }
    // دریافتی بابت خدمات وام: فقط برای مسیر «وجه نقد»
    if (paymentType === 'cash') {
      const serviceFeeAmount = getRawNumber(form.serviceFeeAmount);
      const serviceToAccount = fd.get('serviceToAccount');
      payload.serviceFee = {
        amount: serviceFeeAmount,
        toAccount: serviceToAccount || '',
        receiptImage: receiptBase64
      };
    }
    // جزییات فروش کالا (کارشناس دفتر): فقط برای مسیر «خرید کالا»
    if (paymentType === 'goods') {
      const saleAmount = getRawNumber(form.goodsSaleAmount);
      const downPayment = getRawNumber(form.goodsDownPayment);
      payload.goodsSettlement = {
        goodsName: fd.get('goodsName') || '',
        saleAmount,
        downPayment,
        remainingAmount: Math.max(saleAmount - downPayment, 0),
        totalLoanWithdrawn: getRawNumber(form.goodsTotalWithdrawn),
        receiptImage: goodsWithdrawReceiptBase64
      };
    }
    // تسویه خرید کالا (مدیر یا شخص مجاز): فقط وقتی این فیلدست در فرم حاضر است
    if (goodsPurchaseFieldset.isConnected && paymentType === 'goods') {
      payload.goodsPurchase = {
        goodsName: fd.get('goodsPurchaseName') || '',
        fromName: fd.get('goodsPurchaseFromName') || '',
        amount: getRawNumber(form.goodsPurchaseAmount),
        receiptImage: goodsPurchaseReceiptBase64
      };
    }

    // A single customer record can carry up to 5 images at once (contract, score-purchase
    // receipt, service-fee receipt, goods receipt, goods-purchase receipt). Even after
    // per-image compression these can add up past Firestore's 1MB-per-document limit.
    // The record still saves fine locally either way; this only warns that cloud sync
    // (visibility to other devices/users) of this specific record may fail.
    const totalImgBytes = [contractBase64, receiptBase64, leadPurchaseReceiptBase64, goodsPurchaseReceiptBase64, goodsWithdrawReceiptBase64]
      .reduce((s, img) => s + estimateDataURLBytes(img), 0);
    if (totalImgBytes > 900 * 1024) {
      toast(`مجموع حجم تصاویر این مشتری حدود ${formatBytes(totalImgBytes)} است. اطلاعات همین‌جا ذخیره می‌شود، اما ممکن است همگام‌سازی ابری این مشتری با خطا مواجه شود و تصاویر روی سایر دستگاه‌ها دیده نشوند.`, 'error');
    }

    if (isEdit) {
      // اگر پرونده از قبل تکمیل شده بود و مدیر جذب‌کننده/کارشناس آن را از سلکت‌های بالا
      // عوض کرد، DB.updateCustomer پورسانتِ همان طرف را خودکار بر اساس کاربر جدید دوباره
      // حساب و وضعیت «پرداخت‌شده» را صفر می‌کند (چون مبلغ/پرداختی قبلی متعلق به کاربر قبلی
      // بود) - این‌جا فقط برای آگاهی مدیر یک پیام جداگانه نشان داده می‌شود.
      const wasCompletedBeforeSave = c.stage === 'completed';
      const callerReassigned = wasCompletedBeforeSave && payload.callerId !== undefined && payload.callerId !== c.callerId;
      const processorReassigned = wasCompletedBeforeSave && payload.processorId !== undefined && payload.processorId !== c.processorId;
      DB.updateCustomer(c.id, payload);
      if (callerReassigned || processorReassigned) {
        const parts = [];
        if (callerReassigned) parts.push('جذب‌کننده');
        if (processorReassigned) parts.push('کارشناس دفتر');
        toast(`${parts.join(' و ')} این پرونده تغییر کرد؛ چون پرونده تکمیل‌شده بود، پورسانت مربوطه بر اساس کاربر جدید از نو محاسبه و وضعیت «پرداخت‌شده» آن صفر شد.`, 'error');
      }
      // exact/name-match re-check if caller not yet linked
      if (!c.callerId) {
        const matches = DB.findExactMatchingLeads(payload.phone, payload.nationalId, payload.phone2);
        if (matches.length === 1) {
          DB.linkLeadToCustomer(matches[0].id, c.id);
          toast('اطلاعات ذخیره شد و بر اساس تطابق دقیق شماره تماس/کد ملی به یک لید متصل شد.');
        } else if (matches.length > 1) {
          matches.forEach(l => DB.createPendingMatch(l.id, c.id, 'exact'));
          toast('اطلاعات ذخیره شد. چند لید با شماره تماس/کد ملی یکسان یافت شد؛ برای تایید نهایی به مدیر ارسال شد.', 'error');
        } else {
          const nameMatches = DB.findNameMatchingLeads(payload.name, payload.phone, payload.nationalId, payload.phone2);
          nameMatches.forEach(l => DB.createPendingMatch(l.id, c.id, 'name'));
          if (nameMatches.length) toast('اطلاعات ذخیره شد. یک یا چند لید با نام مشابه یافت شد؛ برای تایید نهایی به مدیر ارسال شد.', 'error');
          else toast('اطلاعات مشتری ذخیره شد.');
        }
      } else {
        toast('اطلاعات مشتری ذخیره شد.');
      }
    } else {
      const { customer, autoLinked, possibleMatches, nameMatches } = DB.addCustomer(payload, CURRENT_USER);
      if (prefillLead) {
        const leadNow = DB.getLeads().find(l => l.id === prefillLead.id);
        if (!leadNow || leadNow.matchedCustomerId !== customer.id) {
          // این پرونده از روی یک لید مشخص شروع شده (دکمه «شروع پرونده دفتر») - صرف‌نظر از
          // اینکه تطابق خودکار شماره تماس/کد ملی چه تشخیصی داده (مثلاً چون کاربر یک اشتباه
          // تایپی را در شماره یا کد ملی هنگام ذخیره اصلاح کرده و دیگر با لید اصلی مطابقت
          // نداشته، یا چون یک لید دیگر از همین کاربر تصادفاً همین شماره را داشته)، این
          // پرونده باید همیشه دقیقاً به همان لیدی که از آن شروع شده وصل بماند - در غیر این
          // صورت هم پرونده‌ی تازه‌ساز از دید همین کاربر جذب تلفنی ناپدید می‌شود (چون
          // DB.canProcessCustomer دیگر او را مالک نمی‌شناسد) و هم لید اصلی دوباره دکمه‌ی
          // «شروع پرونده دفتر» را نشان می‌دهد که می‌تواند باعث ساخت پرونده‌ی تکراری شود.
          DB.linkLeadToCustomer(prefillLead.id, customer.id);
        }
      }
      if (possibleMatches.length > 1) {
        toast('چند لید با شماره تماس/کد ملی یکسان یافت شد؛ برای بررسی و تایید نهایی به مدیر ارسال شد.', 'error');
      } else if (autoLinked) {
        const caller = DB.getUser(customer.callerId);
        toast(`مشتری ثبت شد و بر اساس تطابق دقیق شماره تماس/کد ملی به «${caller.name}» متصل شد.`);
      } else if (nameMatches && nameMatches.length) {
        toast('نام این مشتری با یک یا چند لید تلفنی یکسان است؛ برای تایید نهاییِ اتصال به مدیر ارسال شد.', 'error');
      } else {
        toast('مشتری ثبت شد.');
      }
    }
    closeModal();
    navigate(CURRENT_ROUTE);
  });
}

// Builds a single plain-text block with the customer's personal info + all loan/workflow
// details currently shown in the form, and copies it to the clipboard in one click
// (manager-only feature). Reads live values straight from the form fields, so it also
// reflects any not-yet-saved edits.
function copyCustomerDetailsToClipboard(form, extra) {
  const fd = new FormData(form);
  const g = (name) => (fd.get(name) || '').toString().trim();
  const plainMoney = (n) => { n = Number(n) || 0; return n ? n.toLocaleString('fa-IR') + ' تومان' : '-'; };
  const lines = [];

  lines.push('مشخصات مشتری');
  lines.push(`نام و نام خانوادگی: ${g('name') || '-'}`);
  lines.push(`شماره تماس: ${g('phone') || '-'}`);
  if (g('phone2')) lines.push(`شماره تماس دوم: ${g('phone2')}`);
  lines.push(`کد ملی: ${g('nationalId') || '-'}`);
  lines.push(`شماره حساب: ${g('accountNumber') || '-'}`);

  lines.push('');
  lines.push('مشخصات وام درخواستی');
  lines.push(`نام بانک: ${g('bankName') || '-'}`);
  lines.push(`حداکثر وام دریافتی بدون ضامن: ${plainMoney(getRawNumber(form.maxLoanWithoutGuarantor))}`);
  lines.push(`مبلغ وام: ${plainMoney(getRawNumber(form.loanAmount))}`);
  lines.push(`نوع دریافت: ${PAYMENT_TYPE_LABELS[g('paymentType')] || '-'}`);

  const text = lines.join('\n');

  const done = () => toast('مشخصات مشتری و وام در کلیپ‌بورد کپی شد.');
  const fail = () => toast('کپی خودکار در این مرورگر ممکن نشد. متن به‌صورت انتخاب‌شده نمایش داده شد؛ آن را دستی کپی کنید.', 'error');

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopyFallback(text, done, fail));
  } else {
    legacyCopyFallback(text, done, fail);
  }
}

function legacyCopyFallback(text, done, fail) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    ok ? done() : fail();
  } catch (e) {
    fail();
  }
}

/* ===================== PENDING MATCHES (ADMIN) ===================== */
function renderPendingMatches(main) {
  const tpl = document.getElementById('tpl-pending-matches');
  main.appendChild(tpl.content.cloneNode(true));
  paintPending('');
  paintLeadConflicts();
  paintCustomerConflicts();
  document.getElementById('pm-search').addEventListener('input', (e) => paintPending(e.target.value));
}

function paintPending(q) {
  const list = document.getElementById('pending-matches-list');
  let items = DB.getPendingMatches();
  if (q && q.trim()) {
    items = items.filter(pm => {
      const lead = DB.getLeads().find(l => l.id === pm.leadId);
      const cust = DB.getCustomer(pm.customerId);
      return matchesQuery(lead?.name, '', '', q) || matchesQuery(cust?.name, '', '', q);
    });
  }
  if (!items.length) { list.innerHTML = emptyState('موردی برای تایید وجود ندارد.'); return; }

  list.innerHTML = items.map(pm => {
    const lead = DB.getLeads().find(l => l.id === pm.leadId);
    const cust = DB.getCustomer(pm.customerId);
    const caller = lead ? DB.getUser(lead.callerId) : null;
    const processor = cust ? DB.getUser(cust.processorId) : null;
    if (!lead || !cust) return '';
    const isExact = pm.reason === 'exact';
    const title = isExact
      ? `❗ چند لید/مشتری با شماره تماس یا کد ملی یکسان: «${esc(lead.name)}» ≈ «${esc(cust.name)}»`
      : `شباهت اسمی: «${esc(lead.name)}» ≈ «${esc(cust.name)}»`;
    // Who registered first matters: an office customer already registered by a processor
    // cannot be claimed by a later phone lead without the admin's explicit approval, so
    // the admin needs this front and center rather than having to compare two dates
    // themselves.
    const leadFirst = new Date(lead.createdAt) <= new Date(cust.createdAt);
    const firstNote = leadFirst
      ? '🕐 اول ثبت شده: لید تلفنی — سپس مشتری در دفتر ثبت شده است.'
      : '🕐 اول ثبت شده: مشتری دفتر — سپس همین شخص به‌عنوان لید تلفنی هم ثبت شده است.';
    return `
    <div class="card pending-card" data-id="${pm.id}">
      <div class="card-top">
        <div class="card-title">${title}</div>
        ${isExact ? '<span class="chip stage-following">تطابق دقیق - چند مورد</span>' : '<span class="chip">شباهت اسمی</span>'}
      </div>
      <div class="card-sub">لید تلفنی توسط ${caller ? esc(caller.name) + ' (' + esc(ROLE_LABELS[caller.role] || '') + ')' : 'نامشخص'} · شماره: ${esc(lead.rawPhone || lead.phone)} ${lead.nationalId ? '· کد ملی: ' + esc(lead.nationalId) : ''} · ${fmtDateTime(lead.createdAt)}</div>
      <div class="card-sub">مشتری دفتر: ${esc(cust.name)} · شماره: ${esc(cust.phone)}${cust.phone2 ? ' / ' + esc(cust.phone2) : ''} ${cust.nationalId ? '· کد ملی: ' + esc(cust.nationalId) : ''} · توسط ${processor ? esc(processor.name) + ' (' + esc(ROLE_LABELS[processor.role] || '') + ')' : 'نامشخص'} · ${fmtDateTime(cust.createdAt)}</div>
      <div class="card-sub muted small">${firstNote}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-danger" data-action="reject">رد می‌کنم — متصل نشود</button>
        <button type="button" class="btn btn-primary" data-action="approve">تایید می‌کنم — متصل شود</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-action="approve"]').forEach(btn => {
    btn.onclick = (e) => { const id = e.target.closest('.pending-card').dataset.id; DB.resolvePendingMatch(id, true); toast('اتصال تایید و برقرار شد.'); navigate('pending'); };
  });
  list.querySelectorAll('[data-action="reject"]').forEach(btn => {
    btn.onclick = (e) => { const id = e.target.closest('.pending-card').dataset.id; DB.resolvePendingMatch(id, false); toast('رد شد؛ به این لید متصل نمی‌شود.'); navigate('pending'); };
  });
}

function paintLeadConflicts() {
  const list = document.getElementById('lead-conflicts-list');
  if (!list) return;
  const items = DB.getLeadConflicts();
  if (!items.length) { list.innerHTML = emptyState('هشدار تکراری‌بودنی در انتظار بررسی نیست.'); return; }

  list.innerHTML = items.map(lc => {
    const leadA = DB.getLeads().find(l => l.id === lc.leadAId); // registered first
    const leadB = DB.getLeads().find(l => l.id === lc.leadBId); // registered second (triggered the flag)
    if (!leadA || !leadB) return '';
    const callerA = DB.getUser(leadA.callerId);
    const callerB = DB.getUser(leadB.callerId);
    const sameCaller = lc.kind === 'self';
    const title = sameCaller
      ? `❗ ثبت تکراری توسط همان کارشناس: «${esc(leadA.name)}»`
      : `❗ ثبت تکراری توسط دو کارشناس مختلف: «${esc(leadA.name)}» / «${esc(leadB.name)}»`;
    return `
    <div class="card pending-card" data-id="${lc.id}">
      <div class="card-top">
        <div class="card-title">${title}</div>
        <span class="chip stage-following">${sameCaller ? 'تکراری - همان کارشناس' : 'تکراری - دو کارشناس'}</span>
      </div>
      <div class="card-sub">ثبت اول: ${callerA ? esc(callerA.name) + ' (' + esc(ROLE_LABELS[callerA.role] || '') + ')' : 'نامشخص'} — ${fmtDateTime(leadA.createdAt)} · شماره: ${esc(leadA.rawPhone || leadA.phone)} ${leadA.nationalId ? '· کد ملی: ' + esc(leadA.nationalId) : ''}</div>
      <div class="card-sub">ثبت دوم: ${callerB ? esc(callerB.name) + ' (' + esc(ROLE_LABELS[callerB.role] || '') + ')' : 'نامشخص'} — ${fmtDateTime(leadB.createdAt)} · شماره: ${esc(leadB.rawPhone || leadB.phone)} ${leadB.nationalId ? '· کد ملی: ' + esc(leadB.nationalId) : ''}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-action="separate">دو مورد جداگانه‌اند</button>
        <button type="button" class="btn btn-primary" data-action="duplicate">تکراری تایید شد</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-action="duplicate"]').forEach(btn => {
    btn.onclick = (e) => { const id = e.target.closest('.pending-card').dataset.id; DB.resolveLeadConflict(id, 'duplicate'); toast('به‌عنوان تکراری علامت‌گذاری شد.'); navigate('pending'); };
  });
  list.querySelectorAll('[data-action="separate"]').forEach(btn => {
    btn.onclick = (e) => { const id = e.target.closest('.pending-card').dataset.id; DB.resolveLeadConflict(id, 'separate'); toast('به‌عنوان دو مورد جداگانه علامت‌گذاری شد.'); navigate('pending'); };
  });
}

function paintCustomerConflicts() {
  const list = document.getElementById('customer-conflicts-list');
  if (!list) return;
  const items = DB.getCustomerConflicts();
  if (!items.length) { list.innerHTML = emptyState('هشدار تکراری‌بودنی بین مشتریان در انتظار بررسی نیست.'); return; }

  list.innerHTML = items.map(cc => {
    const custA = DB.getCustomer(cc.customerAId); // registered first
    const custB = DB.getCustomer(cc.customerBId); // registered second (triggered the flag)
    if (!custA || !custB) return '';
    const processorA = DB.getUser(custA.processorId);
    const processorB = DB.getUser(custB.processorId);
    const title = `❗ ثبت تکراری مشتری: «${esc(custA.name)}» / «${esc(custB.name)}»`;
    return `
    <div class="card pending-card" data-id="${cc.id}">
      <div class="card-top">
        <div class="card-title">${title}</div>
        <span class="chip stage-following">تکراری - مشتری با مشتری</span>
      </div>
      <div class="card-sub">ثبت اول: ${processorA ? esc(processorA.name) + ' (' + esc(ROLE_LABELS[processorA.role] || '') + ')' : 'نامشخص'} — ${fmtDateTime(custA.createdAt)} · شماره: ${esc(custA.phone)}${custA.phone2 ? ' / ' + esc(custA.phone2) : ''} ${custA.nationalId ? '· کد ملی: ' + esc(custA.nationalId) : ''}</div>
      <div class="card-sub">ثبت دوم: ${processorB ? esc(processorB.name) + ' (' + esc(ROLE_LABELS[processorB.role] || '') + ')' : 'نامشخص'} — ${fmtDateTime(custB.createdAt)} · شماره: ${esc(custB.phone)}${custB.phone2 ? ' / ' + esc(custB.phone2) : ''} ${custB.nationalId ? '· کد ملی: ' + esc(custB.nationalId) : ''}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-action="separate">دو مورد جداگانه‌اند</button>
        <button type="button" class="btn btn-primary" data-action="duplicate">تکراری تایید شد</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-action="duplicate"]').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest('.pending-card').dataset.id;
      const cc = DB.getCustomerConflicts().find(x => x.id === id);
      if (cc) openCustomerConflictChooser(cc);
    };
  });
  list.querySelectorAll('[data-action="separate"]').forEach(btn => {
    btn.onclick = (e) => { const id = e.target.closest('.pending-card').dataset.id; DB.resolveCustomerConflict(id, 'separate'); toast('به‌عنوان دو مورد جداگانه علامت‌گذاری شد.'); navigate('pending'); };
  });
}

// "تکراری تایید شد" no longer resolves the conflict on its own - it first asks the admin
// WHICH of the two duplicate customer records is the correct one to keep. Once chosen, the
// OTHER record is permanently deleted (DB.deleteCustomer, same tombstoned delete used
// everywhere else in the app), so the duplicate doesn't just get acknowledged but actually
// stops existing as a separate (possibly still-open) file. "دو مورد جداگانه‌اند" is
// unaffected - both records are legitimate, so the normal flow continues untouched.
function openCustomerConflictChooser(cc) {
  const custA = DB.getCustomer(cc.customerAId);
  const custB = DB.getCustomer(cc.customerBId);
  if (!custA || !custB) return;
  const box = document.getElementById('modal-box');
  const renderCard = (c) => {
    const processor = DB.getUser(c.processorId);
    return `
      <div class="card">
        <div class="card-top"><div class="card-title">${esc(c.name || 'بدون نام')}</div></div>
        <div class="card-sub">شماره: ${esc(c.phone)}${c.phone2 ? ' / ' + esc(c.phone2) : ''} ${c.nationalId ? '· کد ملی: ' + esc(c.nationalId) : ''}</div>
        <div class="card-sub">${c.bankName ? esc(c.bankName) + ' · ' : ''}${c.loanAmount ? fmtMoney(c.loanAmount) + ' · ' : ''}مرحله: ${esc(STAGE_LABELS[c.stage] || c.stage)}</div>
        <div class="card-sub muted small">توسط ${processor ? esc(processor.name) + ' (' + esc(ROLE_LABELS[processor.role] || '') + ')' : 'نامشخص'} · ${fmtDateTime(c.createdAt)}</div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" data-keep="${c.id}">این پرونده درست است</button>
        </div>
      </div>`;
  };
  box.innerHTML = `
    <div class="modal-form">
      <h3>کدام پرونده صحیح است؟</h3>
      <p class="muted small">پرونده‌ی دیگر برای همیشه حذف خواهد شد و این کار قابل بازگشت نیست. پرونده‌ای را انتخاب کنید که باید باقی بماند.</p>
      <div class="card-list">${renderCard(custA)}${renderCard(custB)}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-close>انصراف</button>
      </div>
    </div>`;
  document.getElementById('modal-root').classList.remove('hidden');
  box.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  document.querySelector('.modal-backdrop').onclick = closeModal;
  box.querySelectorAll('[data-keep]').forEach(btn => {
    btn.onclick = () => {
      const keepId = btn.dataset.keep;
      const loserId = keepId === custA.id ? custB.id : custA.id;
      const loser = DB.getCustomer(loserId);
      if (!confirm(`آیا مطمئن هستید؟ پرونده‌ی «${loser ? (loser.name || 'بدون نام') : ''}» برای همیشه حذف می‌شود.`)) return;
      DB.resolveCustomerConflict(cc.id, 'duplicate');
      DB.deleteCustomer(loserId);
      toast('پرونده‌ی تکراری حذف شد.');
      closeModal();
      navigate('pending');
    };
  });
}

/* ===================== SCORE (امتیاز) PURCHASE REQUESTS ===================== */
// Visible to admin and any user the admin granted canApproveScore to. Lists customers
// whose office specialist finished the paperwork and is waiting for the score to be
// bought and recorded before they can proceed to withdrawal/settlement.
function renderScoreRequests(main) {
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h2>💳 درخواست‌های خرید امتیاز</h2></div>
      <p class="muted small">
        وقتی کارشناس دفتر مدارک مشتری را تکمیل و وضعیت را «مدارک تکمیل شد - در انتظار دریافت امتیاز» می‌کند، آن مشتری
        اینجا نمایش داده می‌شود. برای ادامه، روی مشتری بزنید و اطلاعات خرید امتیاز (از چه کسی، به چه قیمتی، واریزی‌ها و رسیدها)
        را ثبت و تایید کنید تا کارشناس بتواند مرحله بعد (برداشت/تسویه) را تکمیل کند.
      </p>
      <div id="score-requests-list" class="card-list"></div>

      <div class="section-title" style="margin-top:28px">✅ مشتریان تکمیل‌شده (همه پرونده‌ها)</div>
      <p class="muted small">
        فهرست کامل تمام مشتریانی که مراحل دریافت وامشان به طور کامل تکمیل شده - صرف‌نظر از این‌که کدام
        کارشناس دفتر یا جذب‌کننده روی آن‌ها کار کرده‌اند.
      </p>
      <div id="completed-customers-list" class="card-list"></div>
    </div>`;
  const list = DB.getScoreRequests();
  const box = document.getElementById('score-requests-list');
  if (!list.length) box.innerHTML = emptyState('در حال حاضر درخواست خرید امتیازی در انتظار نیست.');
  else { box.innerHTML = list.map(c => customerCardHTML(c)).join(''); wireCustomerCards(box); }

  const completed = DB.getCompletedCustomers().slice().sort((a, b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt));
  const completedBox = document.getElementById('completed-customers-list');
  if (!completed.length) completedBox.innerHTML = emptyState('هنوز پرونده‌ی تکمیل‌شده‌ای ثبت نشده است.');
  else { completedBox.innerHTML = completed.map(c => customerCardHTML(c)).join(''); wireCustomerCards(completedBox); }
}

/* ===================== "وامش را با نام شخص دیگر گرفته" REVIEW QUEUE (ADMIN/AUTHORIZED) ===================== */
// Whenever a caller sets a lead's follow-up status to "وامش را با نام شخص دیگر گرفته"
// (taken_by_other), that lead's details are effectively "sent" here for the manager (or
// anyone else granted canReviewTakenLeads) to look into - same pattern as the score-
// requests queue above: a nav badge + a dedicated list, until it's explicitly dismissed.
function renderTakenByOtherLeads(main) {
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h2>🚩 مشتریانی که وامشان با نام شخص دیگر گرفته شده</h2></div>
      <p class="muted small">
        وقتی جذب‌کننده تلفنی وضعیت پیگیری یک مشتری را روی «وامش را با نام شخص دیگر گرفته» می‌گذارد،
        مشخصات آن مشتری برای بررسی اینجا نمایش داده می‌شود. پس از بررسی، روی «بررسی شد» بزنید تا از این لیست خارج شود.
      </p>
      <div id="taken-by-other-list" class="card-list"></div>
    </div>`;
  paintTakenByOther();
}

function paintTakenByOther() {
  const box = document.getElementById('taken-by-other-list');
  if (!box) return;
  const list = DB.getTakenByOtherLeads();
  if (!list.length) { box.innerHTML = emptyState('در حال حاضر موردی برای بررسی وجود ندارد.'); return; }
  box.innerHTML = list.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(l => {
    const caller = l.callerId ? DB.getUser(l.callerId) : null;
    return `
    <div class="card" data-id="${l.id}">
      <div class="card-top">
        <div class="card-title">${esc(l.name)}</div>
        <span class="chip followup-taken_by_other">وامش را با نام شخص دیگر گرفته</span>
      </div>
      <div class="card-sub">${esc(l.rawPhone || l.phone)} ${l.nationalId ? '· کد ملی: ' + esc(l.nationalId) : ''}</div>
      <div class="card-sub">جذب‌کننده تلفنی: ${caller ? esc(caller.name) : 'نامشخص'}</div>
      <div class="card-sub">تاریخ ثبت: ${fmtDate(l.createdAt)}</div>
      ${l.note ? `<div class="card-sub">یادداشت: ${esc(l.note)}</div>` : ''}
      <div class="card-meta">
        <span class="chip">${l.requestType === 'goods' ? 'درخواست: کالا' : 'درخواست: وام'}</span>
        ${l.requestType === 'goods' && l.goodsType ? `<span class="chip goods-chip">${esc(l.goodsType)}</span>` : ''}
        ${l.matchedCustomerId ? '<span class="chip stage-completed">متصل شده به مشتری دفتر</span>' : ''}
      </div>
      <div class="card-actions" onclick="event.stopPropagation()">
        <button type="button" class="btn btn-ghost btn-sm btn-edit-lead" data-id="${l.id}">✏️ ویرایش مشتری</button>
        <button type="button" class="btn btn-primary btn-sm btn-review-taken" data-id="${l.id}">✓ بررسی شد</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('.btn-edit-lead').forEach(btn => { btn.onclick = () => openLeadForm(btn.dataset.id); });
  box.querySelectorAll('.btn-review-taken').forEach(btn => {
    btn.onclick = () => {
      DB.markLeadReviewed(btn.dataset.id);
      toast('این مورد بررسی‌شده علامت خورد.');
      buildNav();
      paintTakenByOther();
    };
  });
}

/* ===================== REPORT (ADMIN) ===================== */
function renderReport(main) {
  const tpl = document.getElementById('tpl-report');
  main.appendChild(tpl.content.cloneNode(true));

  const fromWidget = buildJalaliDateSelects(document.getElementById('report-from-wrap'), new Date(new Date().setDate(1)).toISOString());
  const toWidget = buildJalaliDateSelects(document.getElementById('report-to-wrap'), new Date().toISOString());

  document.getElementById('btn-report-today').onclick = () => {
    const todayISO = new Date().toISOString();
    fromWidget.setISO(todayISO);
    toWidget.setISO(todayISO);
    runReport();
  };
  document.getElementById('btn-report-run').onclick = runReport;
  runReport();
  renderPayouts();

  function runReport() {
    const from = fromWidget.getISO();
    const to = toWidget.getISO();
    const r = DB.financialReport(from, to);
    const resultBox = document.getElementById('report-result');
    resultBox.innerHTML = `
      ${r.incompleteCustomers.length ? `
        <div class="warning-box">
          <b>⚠ ${JalaliUtils.toFa(r.incompleteCustomers.length)} پرونده‌ی «تکمیل شد» اطلاعات مالی ناقص دارد و در محاسبات زیر لحاظ نشده است</b>
          (تا وقتی این موارد تکمیل نشوند، برای جلوگیری از نمایش سود اشتباه، از محاسبه کنار گذاشته می‌شوند):
          <ul>
            ${r.incompleteCustomers.map(ic => `<li><a data-open-customer="${ic.id}">${esc(ic.name)}</a> — ${ic.gaps.join('، ')}</li>`).join('')}
          </ul>
        </div>` : ''}
      ${(r.commissionWarnings && r.commissionWarnings.length) ? `
        <div class="warning-box" style="background:#fef3c7;">
          <b>ℹ️ ${JalaliUtils.toFa(r.commissionWarnings.length)} مورد پورسانت نامشخص — در محاسبه سود = ۰ لحاظ شد</b>
          <p class="small" style="margin:6px 0 0;">
            پرونده‌های زیر مبلغ پورسانت دارند ولی کاربر مرتبط (جذب‌کننده/کارشناس دفتر) مشخص نیست.
            سود این پرونده‌ها همچنان محاسبه می‌شود، ولی پورسانت نامشخص از سود کسر نمی‌شود.
            برای کسر صحیح، کاربر مرتبط را تعیین کنید یا مبلغ پورسانت را صفر کنید.
          </p>
          <ul style="margin:8px 0 0;">
            ${r.commissionWarnings.map(w => `<li><a data-open-customer="${w.id}">${esc(w.name)}</a> — ${w.type === 'caller' ? 'پورسانت جذب‌کننده' : 'پورسانت کارشناس دفتر'}: ${fmtMoney(w.amount)} (کاربر نامشخص)</li>`).join('')}
          </ul>
        </div>` : ''}
      <div class="stat-row">
        ${statCard(JalaliUtils.toFa(r.completeCount), 'پرونده‌ی کامل و لحاظ‌شده در بازه')}
        ${statCard(fmtMoney(r.totalServiceFee), 'دریافتی خدمات وام (وجه نقد)')}
        ${statCard(fmtMoney(r.totalLoanWithdrawnGoods), 'وام برداشت‌شده (خرید کالا)')}
        ${statCard(fmtMoney(r.totalCommissions), 'کل پورسانت‌ها (فقط کاربران مشخص)')}
        ${statCard(fmtMoney(r.totalLeadPurchase), 'هزینه خرید امتیاز')}
        ${statCard(fmtMoney(r.totalGoodsPurchase), 'هزینه خرید کالا')}
      </div>
      <div class="profit-box">
        <div class="muted small">
          سود خالص فقط برای پرونده‌های «تکمیل شد» و با اطلاعات کامل محاسبه می‌شود:<br>
          مسیر وجه نقد: دریافتی خدمات وام − (هزینه خرید امتیاز + پورسانت‌ها)<br>
          مسیر خرید کالا: (مبلغ وام برداشت‌شده + مبلغ پیش‌پرداخت) − (هزینه خرید امتیاز + هزینه خرید کالا + پورسانت‌ها)<br>
          <span style="color:#92400e;">نکته: پورسانت‌هایی که کاربر مرتبطشان نامشخص است = ۰ لحاظ می‌شوند.</span>
        </div>
        <div class="amount">${fmtMoney(r.netProfit)}</div>
      </div>
    `;
    resultBox.querySelectorAll('[data-open-customer]').forEach(a => {
      a.onclick = () => openCustomerForm(a.dataset.openCustomer);
    });
  }

  // ---------- per-user commission payout tracker (all-time, independent of the date range above) ----------
  function renderPayouts() {
    const box = document.getElementById('commission-payouts');
    const summary = DB.commissionPayoutSummary();
    if (!summary.length) { box.innerHTML = emptyState('کاربری با نقش جذب‌کننده/کارشناس دفتر ثبت نشده است.'); return; }
    box.innerHTML = summary.map(s => `
      <div class="payout-card" data-user-id="${s.userId}">
        <div class="payout-name">${esc(s.name)} <span class="chip">${ROLE_LABELS[s.role]}</span></div>
        <div class="payout-figures">
          <div>کل پورسانت<b>${fmtMoney(s.totalCommission)}</b></div>
          <div>پرداخت‌شده<b>${fmtMoney(s.paid)}</b></div>
          <div class="remaining ${s.remaining <= 0 ? 'settled' : ''}">مانده<b>${fmtMoney(Math.max(s.remaining, 0))}</b></div>
        </div>
        <div class="payout-pay-row">
          <input type="text" inputmode="numeric" class="money-input payout-amount-input" placeholder="مبلغ پرداختی جدید (تومان)">
          <button type="button" class="btn btn-primary btn-sm btn-pay-commission">ثبت پرداخت و کسر از مانده</button>
        </div>
        ${s.payments.length ? `<div class="payout-history">آخرین پرداخت: ${fmtMoney(s.payments[s.payments.length - 1].amount)} - ${fmtDate(s.payments[s.payments.length - 1].date)}</div>` : ''}
      </div>
    `).join('');
    box.querySelectorAll('.payout-amount-input').forEach(attachMoneyFormatter);
    box.querySelectorAll('.btn-pay-commission').forEach(btn => {
      btn.onclick = () => {
        const card = btn.closest('.payout-card');
        const input = card.querySelector('.payout-amount-input');
        const amount = getRawNumber(input);
        if (!amount) { toast('مبلغ پرداختی را وارد کنید.', 'error'); return; }
        try {
          DB.recordCommissionPayment(card.dataset.userId, amount, '');
          toast('پرداخت ثبت و از مانده کسر شد.');
          renderPayouts();
        } catch (err) {
          toast(err.message || 'خطا در ثبت پرداخت.', 'error');
        }
      };
    });
  }
}

/* ===================== Pagination (generic helper) =====================
   استفاده‌شده در تاریخچه فعالیت‌ها؛ چون فقط یک آرایه‌ی مرتب‌شده می‌گیرد و
   بخشی از آن را برمی‌گرداند، برای هر لیست دیگری هم قابل استفاده مجدد است. */
function paginate(list, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  page = Math.min(Math.max(1, page || 1), totalPages);
  const start = (page - 1) * pageSize;
  return { items: list.slice(start, start + pageSize), page, totalPages, total: list.length };
}
function paginationBarHTML(page, totalPages) {
  if (totalPages <= 1) return '';
  return `
    <div class="pagination-bar">
      <button type="button" data-page-nav="prev" ${page <= 1 ? 'disabled' : ''}>‹ قبلی</button>
      <span>صفحه ${JalaliUtils.toFa(page)} از ${JalaliUtils.toFa(totalPages)}</span>
      <button type="button" data-page-nav="next" ${page >= totalPages ? 'disabled' : ''}>بعدی ›</button>
    </div>`;
}

/* ===================== تاریخچه فعالیت‌ها (Audit Log) - ADMIN ===================== */
const AUDIT_PAGE_SIZE = 25;
const AUDIT_ACTION_LABELS = {
  create: 'ایجاد', update: 'ویرایش', delete: 'حذف', activate: 'فعال‌سازی', deactivate: 'غیرفعال‌سازی',
  password_change: 'تغییر رمز عبور', status_change: 'تغییر وضعیت', stage_change: 'تغییر مرحله پرونده',
  commission_payment: 'پرداخت پورسانت'
};
const AUDIT_ENTITY_LABELS = { user: 'کاربر', lead: 'لید', customer: 'مشتری', settings: 'تنظیمات' };
let auditState = { page: 1, entity: '', q: '' };

function renderAuditLog(main) {
  auditState = { page: 1, entity: '', q: '' };
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h2>🕓 تاریخچه فعالیت‌ها</h2></div>
      <div class="muted small" style="margin-bottom:10px;">
        هر عملیات مهم (ایجاد/ویرایش/حذف کاربر، تغییر وضعیت لید، تغییر مرحله پرونده، تنظیمات و پرداخت پورسانت)
        اینجا با زمان و نام کاربر ثبت می‌شود و هیچ‌کس - حتی مدیر - نمی‌تواند این تاریخچه را ویرایش یا حذف کند.
      </div>
      <div class="filter-row">
        <select id="audit-filter-entity">
          <option value="">همه موارد</option>
          <option value="user">کاربران</option>
          <option value="lead">لیدها</option>
          <option value="customer">مشتریان</option>
          <option value="settings">تنظیمات</option>
        </select>
        <input type="text" id="audit-search" placeholder="جستجو در نام کاربر یا شرح رویداد...">
      </div>
      <div id="audit-table-box"></div>
    </div>
  `;
  document.getElementById('audit-filter-entity').onchange = (e) => { auditState.entity = e.target.value; auditState.page = 1; paintAudit(); };
  document.getElementById('audit-search').oninput = (e) => { auditState.q = e.target.value; auditState.page = 1; paintAudit(); };
  paintAudit();
}

function paintAudit() {
  let list = DB.getAuditLogs(); // already newest-first
  if (auditState.entity) list = list.filter(a => a.entity === auditState.entity);
  const q = (auditState.q || '').trim();
  if (q) list = list.filter(a => (a.summary || '').includes(q) || (a.actorName || '').includes(q));

  const box = document.getElementById('audit-table-box');
  if (!list.length) { box.innerHTML = emptyState('رکوردی یافت نشد.'); return; }

  const { items, page, totalPages } = paginate(list, auditState.page, AUDIT_PAGE_SIZE);
  box.innerHTML = `
    <div class="audit-table-wrap">
      <table class="audit-table">
        <thead><tr><th>زمان</th><th>کاربر</th><th>مورد</th><th>نوع رویداد</th><th>شرح</th></tr></thead>
        <tbody>
          ${items.map(a => `
            <tr>
              <td class="audit-time-cell">${fmtDateTime(a.at)}</td>
              <td>${esc(a.actorName || 'سیستم')}</td>
              <td>${AUDIT_ENTITY_LABELS[a.entity] || esc(a.entity)}</td>
              <td><span class="audit-action-chip ${a.action === 'delete' ? 'danger' : (a.action === 'deactivate' ? 'warn' : '')}">${AUDIT_ACTION_LABELS[a.action] || esc(a.action)}</span></td>
              <td>${esc(a.summary || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${paginationBarHTML(page, totalPages)}
  `;
  box.querySelectorAll('[data-page-nav]').forEach(btn => {
    btn.onclick = () => { auditState.page += (btn.dataset.pageNav === 'next' ? 1 : -1); paintAudit(); };
  });
}

/* ===================== گزارش تحلیلی و نمودار (Analytics) - ADMIN =====================
   از Chart.js (بارگذاری‌شده در index.html از CDN) استفاده می‌کند. کاملاً از روی داده‌ی
   محلی موجود (DB) محاسبه می‌شود - هیچ درخواست شبکه‌ی جدیدی لازم ندارد. */
let analyticsCharts = [];
function renderAnalytics(main) {
  main.innerHTML = `
    <div class="page">
      <div class="page-head"><h2>📈 گزارش تحلیلی و نمودار</h2></div>
      <div class="analytics-grid">
        <div class="analytics-card"><h3>وضعیت پرونده‌ها بر اساس مرحله</h3><canvas id="chart-stage"></canvas></div>
        <div class="analytics-card"><h3>روند ثبت لید و مشتری (۶ ماه اخیر)</h3><canvas id="chart-trend"></canvas></div>
        <div class="analytics-card"><h3>پورسانت پرداخت‌شده / مانده به تفکیک کاربر</h3><canvas id="chart-commission"></canvas></div>
        <div class="analytics-card"><h3>قیف تبدیل لید</h3><canvas id="chart-conversion"></canvas></div>
      </div>
    </div>
  `;
  analyticsCharts.forEach(c => c.destroy());
  analyticsCharts = [];
  if (typeof Chart === 'undefined') {
    main.querySelector('.analytics-grid').innerHTML = emptyState('کتابخانه نمودار بارگذاری نشد؛ اتصال اینترنت را بررسی کنید.');
    return;
  }
  paintStageChart();
  paintTrendChart();
  paintCommissionChart();
  paintConversionChart();
}
function paintStageChart() {
  const customers = DB.getCustomers();
  const counts = STAGE_ORDER.map(s => customers.filter(c => c.stage === s).length);
  analyticsCharts.push(new Chart(document.getElementById('chart-stage'), {
    type: 'bar',
    data: { labels: STAGE_ORDER.map(s => STAGE_LABELS[s]), datasets: [{ label: 'تعداد پرونده', data: counts, backgroundColor: '#10b981', borderRadius: 6 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  }));
}
function paintTrendChart() {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const keyOf = (d) => d.toLocaleDateString('fa-IR', { year: 'numeric', month: 'long' });
  const labels = months.map(keyOf);
  const leads = DB.getLeads(), customers = DB.getCustomers();
  const leadCounts = labels.map(lbl => leads.filter(l => keyOf(new Date(l.createdAt)) === lbl).length);
  const custCounts = labels.map(lbl => customers.filter(c => keyOf(new Date(c.createdAt)) === lbl).length);
  analyticsCharts.push(new Chart(document.getElementById('chart-trend'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'لید جدید', data: leadCounts, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.15)', tension: .3, fill: true },
      { label: 'مشتری جدید', data: custCounts, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.12)', tension: .3, fill: true }
    ] },
    options: { responsive: true, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
  }));
}
function paintCommissionChart() {
  const summary = DB.commissionPayoutSummary();
  analyticsCharts.push(new Chart(document.getElementById('chart-commission'), {
    type: 'bar',
    data: { labels: summary.map(s => s.name), datasets: [
      { label: 'پرداخت‌شده', data: summary.map(s => s.paid), backgroundColor: '#10b981' },
      { label: 'مانده', data: summary.map(s => Math.max(s.remaining, 0)), backgroundColor: '#f59e0b' }
    ] },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
  }));
}
function paintConversionChart() {
  const leads = DB.getLeads();
  const linked = leads.filter(l => l.matchedCustomerId).length;
  const linkedCustomerIds = new Set(leads.filter(l => l.matchedCustomerId).map(l => l.matchedCustomerId));
  const completed = DB.getCustomers().filter(c => c.stage === 'completed' && linkedCustomerIds.has(c.id)).length;
  analyticsCharts.push(new Chart(document.getElementById('chart-conversion'), {
    type: 'doughnut',
    data: {
      labels: ['لید بدون اتصال به مشتری', 'متصل‌شده (در حال پیگیری)', 'تکمیل‌شده (وام گرفته)'],
      datasets: [{ data: [leads.length - linked, Math.max(linked - completed, 0), completed], backgroundColor: ['#e5e9f2', '#60a5fa', '#10b981'] }]
    },
    options: { responsive: true }
  }));
}
function renderSettings(main) {
  const tpl = document.getElementById('tpl-settings');
  main.appendChild(tpl.content.cloneNode(true));
  const s = DB.getSettings();
  const form = document.getElementById('form-settings');
  const callerInput = document.getElementById('settings-caller-percent');
  const processorInput = document.getElementById('settings-processor-percent');
  const manualCheck = document.getElementById('settings-manual-mode');
  const manualUsersList = document.getElementById('settings-manual-users-list');

  callerInput.value = s.callerPercent;
  processorInput.value = s.processorPercent;
  manualCheck.checked = s.commissionMode === 'manual';

  function syncDisabled() {
    const manual = manualCheck.checked;
    callerInput.disabled = manual;
    processorInput.disabled = manual;
  }
  manualCheck.addEventListener('change', syncDisabled);
  syncDisabled();

  // Per-user manual override list: only callers and processors (the two roles that
  // actually receive a commission) are relevant here.
  const manualIds = new Set(s.manualUserIds || []);
  const eligibleUsers = DB.getUsers().filter(u => u.role === 'caller' || u.role === 'processor');
  if (!eligibleUsers.length) {
    manualUsersList.innerHTML = emptyState('هنوز کاربر جذب‌کننده یا کارشناسی ثبت نشده است.');
  } else {
    manualUsersList.innerHTML = eligibleUsers.map(u => `
      <label class="check-inline card" style="cursor:default;">
        <input type="checkbox" class="manual-user-check" value="${u.id}" ${manualIds.has(u.id) ? 'checked' : ''}>
        ${esc(u.name)} <span class="chip">${ROLE_LABELS[u.role]}</span>
      </label>
    `).join('');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const selectedManualIds = Array.from(manualUsersList.querySelectorAll('.manual-user-check:checked')).map(el => el.value);
    DB.updateSettings({
      commissionMode: manualCheck.checked ? 'manual' : 'percent',
      callerPercent: Number(callerInput.value) || 0,
      processorPercent: Number(processorInput.value) || 0,
      manualUserIds: selectedManualIds
    });
    toast('تنظیمات پورسانت ذخیره شد.');
    buildNav();
    navigate('settings');
  });
}

/* ===================== MESSAGE TEMPLATES (preset loan descriptions) ===================== */
function renderTemplates(main) {
  const tpl = document.getElementById('tpl-templates');
  main.appendChild(tpl.content.cloneNode(true));

  document.getElementById('templates-intro').textContent = CURRENT_USER.role === 'admin'
    ? 'توضیحاتی که اینجا ثبت می‌کنید به‌صورت مشترک در اختیار همه کاربران جذب‌کننده قرار می‌گیرد.'
    : 'توضیحات ثبت‌شده توسط شما فقط برای خودتان است. توضیحات مشترکی که مدیر ثبت کرده نیز اینجا در دسترس شماست.';

  paintTemplates('');
  document.getElementById('templates-search').addEventListener('input', (e) => paintTemplates(e.target.value));
  document.getElementById('btn-add-template').onclick = () => openTemplateForm();
}

function paintTemplates(q) {
  const list = document.getElementById('templates-list');
  let items = DB.getTemplatesForUser(CURRENT_USER);
  if (q && q.trim()) items = items.filter(t => matchesQuery(t.title, t.text, '', q));
  if (!items.length) { list.innerHTML = emptyState('هنوز توضیح آماده‌ای ثبت نشده است.'); return; }

  list.innerHTML = items.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(t => {
    const canManage = CURRENT_USER.role === 'admin' || t.ownerId === CURRENT_USER.id;
    return `
    <div class="card" data-id="${t.id}">
      <div class="card-top">
        <div class="card-title">${esc(t.title)}</div>
        <span class="chip scope-${t.scope}">${t.scope === 'shared' ? 'مشترک (مدیر)' : 'شخصی من'}</span>
      </div>
      <div class="template-preview-text">${esc(t.text || '')}</div>
      <div class="card-meta">
        ${(t.images && t.images.length) ? `<span class="chip">🖼 ${JalaliUtils.toFa(t.images.length)} تصویر</span>` : ''}
        ${(t.audios && t.audios.length) ? `<span class="chip">🎙 ${JalaliUtils.toFa(t.audios.length)} فایل صوتی</span>` : ''}
      </div>
      <div class="modal-actions">
        ${canManage ? `<button type="button" class="btn btn-ghost" data-action="edit">ویرایش</button>` : ''}
        <button type="button" class="btn btn-primary" data-action="send">📤 ارسال به مشتری</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.onclick = (e) => openTemplateForm(e.target.closest('.card').dataset.id);
  });
  list.querySelectorAll('[data-action="send"]').forEach(btn => {
    btn.onclick = (e) => openSendTemplateModal(e.target.closest('.card').dataset.id);
  });
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Rough byte-size of a base64 data URL (without fetching/decoding it).
function estimateDataURLBytes(dataURL) {
  if (!dataURL) return 0;
  const comma = dataURL.indexOf(',');
  const b64 = comma >= 0 ? dataURL.slice(comma + 1) : dataURL;
  const padding = (b64.endsWith('==')) ? 2 : (b64.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.round((b64.length * 3) / 4) - padding);
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

// Every image the app stores ends up embedded (as base64) inside a single Firestore
// document (1MB hard limit per document) and inside one shared localStorage key
// (5-10MB total, shared by the whole app). Raw phone-camera photos (often several MB)
// blow past both silently if not shrunk first. This resizes to a reasonable max
// dimension and re-encodes as JPEG, which typically brings a photo down to ~80-250KB
// while staying perfectly legible for documents/receipts.
// Non-image files (or any failure to decode as an image) fall back to the original
// raw file untouched.
function compressImageToDataURL(file, { maxDim = 1280, quality = 0.65 } = {}) {
  return new Promise((resolve) => {
    if (!file.type || !file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      fileToDataURL(file).then(resolve).catch(() => resolve(null));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else { width = Math.round(width * (maxDim / height)); height = maxDim; }
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', quality);
        // safety net: if for some reason the "compressed" result is bigger than the
        // original (can happen with already-tiny/simple images), just keep the original.
        fileToDataURL(file).then((original) => {
          resolve(estimateDataURLBytes(compressed) < estimateDataURLBytes(original) ? compressed : original);
        }).catch(() => resolve(compressed));
      } catch (err) {
        URL.revokeObjectURL(url);
        fileToDataURL(file).then(resolve).catch(() => resolve(null));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      fileToDataURL(file).then(resolve).catch(() => resolve(null));
    };
    img.src = url;
  });
}

// Shows a small "حجم: ۱۲۰ کیلوبایت" caption under an image preview, and warns the
// user (once) if a single attached image is still large enough to risk blowing the
// 1MB-per-document Firestore sync limit once combined with the customer's other
// attachments.
function attachSizeCaption(previewEl, dataURL) {
  if (!dataURL) return;
  const bytes = estimateDataURLBytes(dataURL);
  const cap = document.createElement('div');
  cap.className = 'attachment-size-caption';
  cap.style.cssText = 'font-size:11px;opacity:.7;margin-top:2px;';
  cap.textContent = `حجم: ${formatBytes(bytes)}`;
  previewEl.appendChild(cap);
  if (bytes > 600 * 1024) {
    toast(`حجم این تصویر (${formatBytes(bytes)}) نسبتاً بالاست. اگر چند تصویر روی یک مشتری اضافه شود ممکن است همگام‌سازی ابری آن رکورد با خطا مواجه شود.`, 'error');
  }
}

// Uploaded images are no longer shown inline inside forms/windows - only a small
// "نمایش تصویر" button is rendered, and the actual picture is shown full-size in a
// lightbox overlay when that button is clicked. Keeps forms compact and avoids large
// base64 images bloating the visible page.
function imagePreviewButtonHTML(label) {
  return `<button type="button" class="btn btn-ghost btn-sm btn-view-image">🖼 نمایش ${esc(label)}</button>`;
}

// Fills a preview box with the "view image" button (instead of the image itself) and
// wires it to open the lightbox. Call this anywhere a preview box used to get an <img>.
function renderImagePreviewButton(box, dataURL, label) {
  if (!box || !dataURL) return;
  box.innerHTML = imagePreviewButtonHTML(label);
  const btn = box.querySelector('.btn-view-image');
  if (btn) btn.onclick = () => openImageLightbox(dataURL, label);
}

// Full-size image viewer overlay. Closes on the × button, backdrop click, or Escape.
function openImageLightbox(dataURL, altText) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';
  overlay.innerHTML = `
    <div class="image-lightbox-box">
      <button type="button" class="image-lightbox-close" aria-label="بستن">✕</button>
      <img src="${dataURL}" alt="${esc(altText || '')}">
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('.image-lightbox-close').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

function dataURLtoFile(dataURL, filename) {
  const [meta, b64] = dataURL.split(',');
  const mime = (meta.match(/:(.*?);/) || [, 'application/octet-stream'])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], filename, { type: mime });
}

function openTemplateForm(templateId) {
  const isEdit = !!templateId;
  const t = isEdit ? DB.getTemplates().find(x => x.id === templateId) : null;
  const box = openModal('tpl-modal-template');
  const form = box.querySelector('#form-template');
  box.querySelector('#template-form-title').textContent = isEdit ? 'ویرایش توضیح آماده' : 'توضیح آماده جدید';

  // Multiple images / multiple audio files can now be attached to a single preset description.
  let images = (t?.images || []).slice();
  let audios = (t?.audios || []).slice();

  function renderImagePreview() {
    const box2 = document.getElementById('template-image-preview');
    box2.innerHTML = images.map((img, i) => `
      <div class="attachment-item">
        <button type="button" class="btn btn-ghost btn-sm btn-view-image" data-view-image="${i}">🖼 نمایش تصویر ${i + 1}</button>
        <div style="font-size:11px;opacity:.7;">حجم: ${formatBytes(estimateDataURLBytes(img))}</div>
        <button type="button" class="btn btn-danger btn-sm" data-remove-image="${i}">حذف</button>
      </div>`).join('');
    box2.querySelectorAll('[data-view-image]').forEach(b => b.onclick = () => {
      const idx = Number(b.dataset.viewImage);
      openImageLightbox(images[idx], `تصویر ${idx + 1}`);
    });
    box2.querySelectorAll('[data-remove-image]').forEach(b => b.onclick = () => {
      images.splice(Number(b.dataset.removeImage), 1);
      renderImagePreview();
    });
  }
  function renderAudioPreview() {
    const box2 = document.getElementById('template-audio-preview');
    box2.innerHTML = audios.map((aud, i) => `
      <div class="attachment-item">
        <audio controls src="${aud}"></audio>
        <button type="button" class="btn btn-danger btn-sm" data-remove-audio="${i}">حذف</button>
      </div>`).join('');
    box2.querySelectorAll('[data-remove-audio]').forEach(b => b.onclick = () => {
      audios.splice(Number(b.dataset.removeAudio), 1);
      renderAudioPreview();
    });
  }

  if (isEdit) {
    form.title.value = t.title;
    form.text.value = t.text || '';
    renderImagePreview();
    renderAudioPreview();
    const delBtn = document.getElementById('btn-delete-template');
    const canManage = CURRENT_USER.role === 'admin' || t.ownerId === CURRENT_USER.id;
    if (canManage) {
      delBtn.style.display = 'inline-block';
      delBtn.onclick = () => {
        if (confirm('آیا از حذف این توضیح آماده مطمئن هستید؟')) {
          DB.deleteTemplate(t.id); toast('توضیح آماده حذف شد.'); closeModal(); navigate('templates');
        }
      };
    }
  }

  // both inputs support selecting more than one file at a time; every selection is
  // appended to the existing list rather than replacing it, so more attachments can
  // keep being added.
  form.image.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    for (const file of files) {
      const result = await compressImageToDataURL(file);
      if (!result) { toast('خواندن یکی از فایل‌ها ناموفق بود.', 'error'); continue; }
      images.push(result);
    }
    renderImagePreview();
    form.image.value = '';
    const totalBytes = images.reduce((s, img) => s + estimateDataURLBytes(img), 0);
    if (totalBytes > 900 * 1024) {
      toast(`مجموع حجم تصاویر این قالب حدود ${formatBytes(totalBytes)} است و ممکن است در همگام‌سازی ابری (سقف ۱ مگابایت هر سند) با خطا مواجه شود. تعداد یا حجم تصاویر را کم کنید.`, 'error');
    }
  });
  form.audio.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    for (const file of files) audios.push(await fileToDataURL(file));
    renderAudioPreview();
    form.audio.value = '';
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = { title: fd.get('title'), text: fd.get('text'), images, audios };
    if (isEdit) DB.updateTemplate(t.id, payload);
    else DB.addTemplate(payload, CURRENT_USER);
    toast('توضیح آماده ذخیره شد.');
    closeModal();
    navigate('templates');
  });
}

function openSendTemplateModal(templateId) {
  const t = DB.getTemplates().find(x => x.id === templateId);
  if (!t) return;
  const box = openModal('tpl-modal-send-template');
  const form = box.querySelector('#form-send-template');

  // suggest phone numbers from this caller's own leads/customers, for convenience
  const suggestions = document.getElementById('send-phone-suggestions');
  const known = CURRENT_USER.role === 'caller'
    ? DB.getLeadsByCaller(CURRENT_USER.id).map(l => ({ name: l.name, phone: l.rawPhone || l.phone }))
    : DB.getCustomers().flatMap(c => [
        { name: c.name, phone: c.phone },
        ...(c.phone2 ? [{ name: c.name + ' (شماره دوم)', phone: c.phone2 }] : [])
      ]);
  suggestions.innerHTML = known.filter(k => k.phone).map(k => `<option value="${esc(k.phone)}">${esc(k.name)}</option>`).join('');

  const images = t.images || [];
  const audios = t.audios || [];
  const imageOpt = document.getElementById('send-image-opt');
  const audioOpt = document.getElementById('send-audio-opt');
  const attachmentsHint = document.getElementById('send-attachments-hint');
  if (attachmentsHint) attachmentsHint.classList.toggle('hidden', !(images.length || audios.length));
  if (images.length) {
    imageOpt.classList.remove('hidden');
    imageOpt.innerHTML = images.map((img, i) => `
      <label class="check-inline"><input type="checkbox" class="send-image-check" data-index="${i}" checked> ارسال تصویر ${JalaliUtils.toFa(i + 1)}</label>`).join('');
  }
  if (audios.length) {
    audioOpt.classList.remove('hidden');
    audioOpt.innerHTML = audios.map((aud, i) => `
      <label class="check-inline"><input type="checkbox" class="send-audio-check" data-index="${i}" checked> ارسال فایل صوتی ${JalaliUtils.toFa(i + 1)}</label>`).join('');
  }

  const fallbackBox = document.getElementById('send-file-fallback');
  const fallbackLinks = [];
  images.forEach((img, i) => fallbackLinks.push(`<a class="btn btn-ghost" download="${esc(t.title)}-تصویر-${i + 1}.jpg" href="${img}">⬇️ دانلود تصویر ${JalaliUtils.toFa(i + 1)}</a>`));
  audios.forEach((aud, i) => fallbackLinks.push(`<a class="btn btn-ghost" download="${esc(t.title)}-صوت-${i + 1}.mp3" href="${aud}">⬇️ دانلود فایل صوتی ${JalaliUtils.toFa(i + 1)}</a>`));
  fallbackBox.innerHTML = fallbackLinks.join('');

  function buildText() {
    return form.includeText.checked ? (t.text || '') : '';
  }

  document.getElementById('btn-share-native').onclick = async () => {
    try {
      const text = buildText();
      const filesToShare = [];
      imageOpt.querySelectorAll('.send-image-check:checked').forEach(chk => {
        filesToShare.push(dataURLtoFile(images[Number(chk.dataset.index)], `${t.title || 'image'}-${Number(chk.dataset.index) + 1}.jpg`));
      });
      audioOpt.querySelectorAll('.send-audio-check:checked').forEach(chk => {
        filesToShare.push(dataURLtoFile(audios[Number(chk.dataset.index)], `${t.title || 'audio'}-${Number(chk.dataset.index) + 1}.mp3`));
      });

      const shareData = { title: t.title, text };
      if (filesToShare.length && navigator.canShare && navigator.canShare({ files: filesToShare })) {
        shareData.files = filesToShare;
      }
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        toast('اشتراک‌گذاری در این مرورگر پشتیبانی نمی‌شود؛ از دکمه‌های دیگر استفاده کنید.', 'error');
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('اشتراک‌گذاری انجام نشد. از دکمه‌های دیگر استفاده کنید.', 'error');
    }
  };

  document.getElementById('btn-send-whatsapp').onclick = () => {
    const phone = normalizePhoneIntl(form.phone.value);
    const text = encodeURIComponent(buildText());
    const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
    window.open(url, '_blank');
  };

  document.getElementById('btn-send-telegram').onclick = () => {
    const phone = normalizePhoneIntl(form.phone.value);
    if (!phone) { toast('برای ارسال در تلگرام، شماره تماس مشتری را وارد کنید.', 'error'); return; }
    const statusBox = document.getElementById('send-telegram-status');
    const text = buildText();
    // Order matters, for two separate reasons:
    // 1) window.open() must run synchronously in this handler with nothing awaited
    //    before it - any `await` first breaks the direct user-gesture chain and
    //    browsers (Safari especially) silently block the popup.
    // 2) navigator.clipboard.writeText() needs the document to still have focus at
    //    the moment it's called - and focus can shift away the instant window.open()
    //    runs (a new tab/app opens). So the write must be *started* here, before
    //    window.open(), even though we only read its result afterward.
    const copyPromise = text ? navigator.clipboard.writeText(text).then(() => true).catch(() => false) : Promise.resolve(false);
    window.open(`https://t.me/+${phone}`, '_blank');
    // Telegram has no official "wa.me"-style public link to open a chat purely by
    // phone number, and unlike wa.me it has no way to prefill the message text either
    // - so even when everything works, the chat opens with an empty message box and
    // the text only exists on the clipboard, waiting to be pasted by hand. This status
    // line stays in the modal (rather than a toast that could fade before the person
    // switches back from Telegram) so the "now go paste it" step isn't missed.
    copyPromise.then((copied) => {
      if (!statusBox) return;
      statusBox.classList.remove('hidden');
      statusBox.textContent = copied
        ? '✅ متن کپی شد. تلگرام پیام را خودش پر نمی‌کند - در چت بازشده باید خودتان آن را Paste کنید. اگر چت درستی هم باز نشد، یعنی این شماره برای تلگرام شما قابل‌شناسایی نیست؛ از دکمه «اشتراک‌گذاری» بالا استفاده کنید.'
        : (text
          ? '⚠️ کپی خودکار متن ناموفق بود. روی دکمه «کپی متن» بزنید و بعد در چت تلگرام Paste کنید.'
          : '⚠️ این توضیح متنی برای ارسال ندارد.');
    });
  };

  document.getElementById('btn-copy-text').onclick = async () => {
    try {
      await navigator.clipboard.writeText(buildText());
      toast('متن کپی شد؛ آن را در اپلیکیشن مقصد جای‌گذاری کنید.');
    } catch (err) {
      toast('کپی خودکار پشتیبانی نشد.', 'error');
    }
  };

  form.addEventListener('submit', (e) => e.preventDefault());
}

// Produces the digits-only "989xxxxxxxxx" format both wa.me and t.me links need.
// normalizePhone() already collapses "0098"/"98" prefixes down to a leading "0", so
// the common cases (09xxxxxxxxx, +989xxxxxxxxx, 00989xxxxxxxxx) all land in the first
// branch below. The one case that used to slip through and silently strip the country
// code entirely was a number typed WITHOUT the leading 0 (e.g. "912xxxxxxx" - a very
// common shorthand people use when writing/copying their number) - the second branch
// catches that.
function normalizePhoneIntl(phone) {
  let p = normalizePhone(phone);
  if (!p) return '';
  if (p.startsWith('0')) return '98' + p.slice(1);
  if (/^9\d{9}$/.test(p)) return '98' + p;
  return p;
}
// Kept as an alias since this used to be WhatsApp-specific; Telegram's t.me link
// needs the exact same "989xxxxxxxxx" format so both buttons now share one function.
function normalizePhoneForWhatsapp(phone) { return normalizePhoneIntl(phone); }

/* =========================================================================
   ===================== LOAN PRODUCTS & CALCULATOR ========================
   =========================================================================
   بخش وام شامل دو صفحه است:
   1) «محصولات وام» (فقط admin): تعریف/ویرایش/حذف محصولات وام با فرمول‌ساز
   2) «محاسبه وام» (همه نقش‌ها): انتخاب محصول + وارد کردن مبلغ + نمایش نتایج
   فرمول‌ها توسط موتور امن (js/formula-engine.js) ارزیابی می‌شوند - بدون eval().
   متغیرها به‌صورت حروف لاتین کوتاه: L (مبلغ وام)، R (مانده)، N (تعداد اقساط)،
   i (شماره قسط)، P (قدرت خرید)، c.X (ثابت‌ها).
   ======================================================================= */

// ---- صفحه مدیریت محصولات وام (admin) ----
function renderLoanProducts(main) {
  if (CURRENT_USER.role !== 'admin') {
    main.innerHTML = `<div class="page">${emptyState('دسترسی به این بخش فقط برای مدیر مجاز است.')}</div>`;
    return;
  }
  const tpl = document.getElementById('tpl-loan-products');
  main.appendChild(tpl.content.cloneNode(true));

  const searchInput = document.getElementById('loan-products-search');
  const filterSelect = document.getElementById('loan-products-filter');
  if (!filterSelect.value) filterSelect.value = 'active';

  function refresh() { paintLoanProducts(searchInput.value, filterSelect.value); }
  refresh();
  searchInput.addEventListener('input', refresh);
  filterSelect.addEventListener('change', refresh);
  document.getElementById('btn-add-loan-product').onclick = () => openLoanProductForm();
}

function paintLoanProducts(q, filter) {
  const list = document.getElementById('loan-products-list');
  let items = DB.getLoanProducts();
  if (filter === 'active') items = items.filter(p => !p.archived);
  else if (filter === 'archived') items = items.filter(p => p.archived);
  if (q && q.trim()) {
    const qq = q.trim().toLowerCase();
    items = items.filter(p => (p.bankName || '').toLowerCase().includes(qq) ||
      (p.schemeName || '').toLowerCase().includes(qq));
  }
  if (!items.length) {
    list.innerHTML = emptyState('هنوز محصول وامی ثبت نشده است. روی «افزودن محصول وام جدید» بزنید.');
    return;
  }
  items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  list.innerHTML = items.map(p => {
    const name = esc(p.bankName) + (p.schemeName ? ' — ' + esc(p.schemeName) : '');
    const chips = [];
    chips.push(`<span class="chip">📅 ${JalaliUtils.toFa(p.installmentsCount)} قسط</span>`);
    if (p.formulas.specialInstallments && p.formulas.specialInstallments.length) {
      chips.push(`<span class="chip">🔢 ${JalaliUtils.toFa(p.formulas.specialInstallments.length)} قسط خاص</span>`);
    }
    if (p.constants && p.constants.length) {
      chips.push(`<span class="chip">🔢 ${JalaliUtils.toFa(p.constants.length)} ثابت</span>`);
    }
    if (p.archived) chips.push(`<span class="chip chip-archived">بایگانی‌شده</span>`);
    // تست سریع اعتبار فرمول‌ها - اگر خطایی هست نشان بده
    let formulaStatus = '';
    try {
      const vars = DB._loanBaseVars(p, { L: 100000000, R: 50000000, i: 13, P: 60000000 });
      if (p.formulas.firstInstallment) FormulaEngine.eval(p.formulas.firstInstallment, vars);
      if (p.formulas.otherInstallments) FormulaEngine.eval(p.formulas.otherInstallments, vars);
      if (p.formulas.purchasableAmount) FormulaEngine.eval(p.formulas.purchasableAmount, vars);
      (p.formulas.specialInstallments || []).forEach(s => FormulaEngine.eval(s.formula, vars));
      formulaStatus = '<span class="chip chip-ok">✓ فرمول‌ها معتبر</span>';
    } catch (e) {
      formulaStatus = `<span class="chip chip-err">⚠ خطا در فرمول</span>`;
    }
    return `
      <div class="card loan-product-card" data-id="${p.id}">
        <div class="card-top">
          <div class="card-title">${name}</div>
        </div>
        <div class="card-meta">${chips.join('')}</div>
        <div class="card-meta" style="margin-top:6px;">${formulaStatus}</div>
        ${p.description ? `<div class="loan-product-desc">${esc(p.description)}</div>` : ''}
        <div class="loan-product-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="calc">🧮 محاسبه با این محصول</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit">✏️ ویرایش</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="duplicate">📋 کپی</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.onclick = (e) => openLoanProductForm(e.target.closest('.card').dataset.id);
  });
  list.querySelectorAll('[data-action="duplicate"]').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest('.card').dataset.id;
      const p = DB.getLoanProduct(id);
      if (!p) return;
      const copy = JSON.parse(JSON.stringify(p));
      delete copy.id;
      copy.bankName = (p.bankName || '') + ' (کپی)';
      copy.archived = false;
      openLoanProductForm(null, copy);
    };
  });
  list.querySelectorAll('[data-action="calc"]').forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest('.card').dataset.id;
      navigate('loanCalc');
      setTimeout(() => {
        const sel = document.getElementById('loan-calc-product');
        if (sel) { sel.value = id; sel.dispatchEvent(new Event('change')); }
      }, 50);
    };
  });
}

// ---- فرم افزودن/ویرایش محصول وام ----
function openLoanProductForm(productId, initialState) {
  const isEdit = !!productId;
  const stored = isEdit ? DB.getLoanProduct(productId) : null;
  const t = stored || initialState || null;
  const box = openModal('tpl-modal-loan-product');
  const form = box.querySelector('#form-loan-product');
  box.querySelector('#loan-product-form-title').textContent = isEdit ? 'ویرایش محصول وام' : 'محصول وام جدید';

  form.bankName.value = t?.bankName || '';
  form.schemeName.value = t?.schemeName || '';
  form.installmentsCount.value = t?.installmentsCount || 24;
  form.description.value = t?.description || '';
  form.archived.checked = !!t?.archived;
  form.firstInstallment.value = t?.formulas?.firstInstallment || '';
  form.otherInstallments.value = t?.formulas?.otherInstallments || '';
  form.purchasableAmount.value = t?.formulas?.purchasableAmount || '';
  form.loanAmountFromPurchasable.value = t?.formulas?.loanAmountFromPurchasable || '';

  attachAllMoneyFormatters(form);

  // ---- مدیریت لیست ثابت‌ها ----
  const constantsList = document.getElementById('loan-product-constants-list');
  let constants = (t?.constants || []).map(c => Object.assign({}, c));
  function renderConstants() {
    constantsList.innerHTML = constants.map((c, idx) => `
      <div class="loan-const-row" data-idx="${idx}">
        <input type="text" placeholder="نام (firstPercent)" value="${esc(c.name || '')}" data-field="name">
        <input type="text" placeholder="برچسب (درصد قسط اول)" value="${esc(c.label || '')}" data-field="label">
        <input type="number" step="any" placeholder="مقدار (4)" value="${esc(c.value ?? '')}" data-field="value">
        <button type="button" class="btn btn-danger btn-sm" data-action="remove" title="حذف">✕</button>
      </div>
    `).join('') || '<p class="muted small">ثابتی اضافه نشده.</p>';
    constantsList.querySelectorAll('input').forEach(inp => {
      inp.oninput = (e) => {
        const row = e.target.closest('.loan-const-row');
        const idx = parseInt(row.dataset.idx, 10);
        const field = e.target.dataset.field;
        if (field === 'value') constants[idx][field] = Number(e.target.value);
        else constants[idx][field] = e.target.value;
        updatePreview();
      };
    });
    constantsList.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.onclick = (e) => {
        const idx = parseInt(e.target.closest('.loan-const-row').dataset.idx, 10);
        constants.splice(idx, 1);
        renderConstants();
        updatePreview();
      };
    });
  }
  document.getElementById('btn-add-constant').onclick = () => {
    constants.push({ name: '', label: '', value: 0 });
    renderConstants();
  };
  renderConstants();

  // ---- مدیریت لیست اقساط خاص ----
  const specialList = document.getElementById('loan-product-special-list');
  let specials = (t?.formulas?.specialInstallments || []).map(s => Object.assign({}, s));
  function renderSpecials() {
    specialList.innerHTML = specials.map((s, idx) => `
      <div class="loan-special-row" data-idx="${idx}">
        <input type="number" min="2" placeholder="شماره (13)" value="${esc(s.installmentNumber ?? '')}" data-field="installmentNumber">
        <input type="text" placeholder="برچسب (قسط سیزدهم)" value="${esc(s.label || '')}" data-field="label">
        <input type="text" placeholder="فرمول (R * 4%)" value="${esc(s.formula || '')}" data-field="formula" class="formula-input">
        <button type="button" class="btn btn-danger btn-sm" data-action="remove" title="حذف">✕</button>
      </div>
    `).join('') || '<p class="muted small">قسط خاصی تعریف نشده.</p>';
    specialList.querySelectorAll('input').forEach(inp => {
      inp.oninput = (e) => {
        const row = e.target.closest('.loan-special-row');
        const idx = parseInt(row.dataset.idx, 10);
        const field = e.target.dataset.field;
        if (field === 'installmentNumber') specials[idx][field] = parseInt(e.target.value, 10) || 0;
        else specials[idx][field] = e.target.value;
        updatePreview();
      };
    });
    specialList.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.onclick = (e) => {
        const idx = parseInt(e.target.closest('.loan-special-row').dataset.idx, 10);
        specials.splice(idx, 1);
        renderSpecials();
        updatePreview();
      };
    });
  }
  document.getElementById('btn-add-special').onclick = () => {
    specials.push({ installmentNumber: 13, label: '', formula: '' });
    renderSpecials();
  };
  renderSpecials();

  // ---- پیش‌نمایش زنده ----
  const previewResult = document.getElementById('loan-product-preview-result');
  function buildCurrentProduct() {
    return {
      bankName: form.bankName.value,
      schemeName: form.schemeName.value,
      installmentsCount: parseInt(form.installmentsCount.value, 10) || 1,
      description: form.description.value,
      formulas: {
        firstInstallment: form.firstInstallment.value.trim(),
        otherInstallments: form.otherInstallments.value.trim(),
        purchasableAmount: form.purchasableAmount.value.trim(),
        loanAmountFromPurchasable: form.loanAmountFromPurchasable.value.trim(),
        specialInstallments: specials.slice()
      },
      constants: constants.slice(),
      archived: form.archived.checked
    };
  }
  function updatePreview() {
    const amount = getRawNumber(document.getElementById('loan-product-preview-amount'));
    if (!amount) { previewResult.innerHTML = '<p class="muted small">مبلغ نمونه را وارد کنید.</p>'; return; }
    const product = buildCurrentProduct();
    const issues = [];
    if (!product.formulas.firstInstallment) issues.push('فرمول قسط اول خالی است.');
    if (!product.formulas.otherInstallments) issues.push('فرمول سایر اقساط خالی است.');
    if (!product.formulas.purchasableAmount) issues.push('فرمول مبلغ قابل دریافت خالی است.');
    const names = (product.constants || []).map(c => c.name).filter(Boolean);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) issues.push('نام ثابت‌ها تکراری: ' + dupes.join('، '));
    const badNames = names.filter(n => n && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n));
    if (badNames.length) issues.push('نام ثابت‌ها نامعتبر: ' + badNames.join('، '));

    if (issues.length) {
      previewResult.innerHTML = `<div class="loan-preview-issues">${issues.map(i => `<div>• ${esc(i)}</div>`).join('')}</div>`;
      return;
    }
    try {
      const normalized = DB._normalizeLoanProduct(Object.assign({ id: 'preview' }, product));
      const result = DB.buildLoanSchedule(normalized, amount);
      const firstInst = result.schedule[0];
      const otherInst = result.schedule.find(x => x.kind === 'other');
      const specialInsts = result.schedule.filter(x => x.kind === 'special');
      previewResult.innerHTML = `
        <div class="loan-preview-grid">
          <div class="loan-preview-cell"><span>مبلغ وام</span><b>${fmtMoney(result.loanAmount)}</b></div>
          <div class="loan-preview-cell"><span>قدرت خرید</span><b>${fmtMoney(result.purchasableAmount)}</b></div>
          <div class="loan-preview-cell"><span>قسط اول</span><b>${fmtMoney(firstInst ? firstInst.amount : 0)}</b></div>
          ${specialInsts.map(s => `<div class="loan-preview-cell"><span>${esc(s.label)}</span><b>${fmtMoney(s.amount)}</b></div>`).join('')}
          <div class="loan-preview-cell"><span>سایر اقساط</span><b>${fmtMoney(otherInst ? otherInst.amount : 0)}</b></div>
          <div class="loan-preview-cell"><span>مجموع</span><b>${fmtMoney(result.totalPayable)}</b></div>
        </div>
      `;
    } catch (e) {
      previewResult.innerHTML = `<div class="loan-preview-issues"><div>• ${esc(e.message)}</div></div>`;
    }
  }
  ['bankName', 'schemeName', 'installmentsCount', 'description', 'firstInstallment', 'otherInstallments', 'purchasableAmount', 'loanAmountFromPurchasable'].forEach(name => {
    form[name].addEventListener('input', updatePreview);
  });
  document.getElementById('loan-product-preview-amount').addEventListener('input', updatePreview);
  updatePreview();

  // ---- دکمه حذف ----
  const deleteBtn = document.getElementById('btn-delete-loan-product');
  if (isEdit) {
    deleteBtn.style.display = '';
    deleteBtn.onclick = () => {
      const p = DB.getLoanProduct(productId);
      const name = p ? (p.bankName + (p.schemeName ? ' - ' + p.schemeName : '')) : productId;
      if (!confirm(`حذف محصول وام «${name}»؟`)) return;
      DB.deleteLoanProduct(productId);
      closeModal();
      toast('محصول حذف شد.');
      navigate('loanProducts');
    };
  }

  // ---- ذخیره فرم ----
  form.onsubmit = (e) => {
    e.preventDefault();
    const product = buildCurrentProduct();
    if (!product.bankName.trim()) { toast('نام بانک را وارد کنید.', 'error'); return; }
    if (!product.formulas.firstInstallment) { toast('فرمول قسط اول را وارد کنید.', 'error'); return; }
    if (!product.formulas.otherInstallments) { toast('فرمول سایر اقساط را وارد کنید.', 'error'); return; }
    if (!product.formulas.purchasableAmount) { toast('فرمول مبلغ قابل دریافت را وارد کنید.', 'error'); return; }
    const names = (product.constants || []).map(c => c.name).filter(Boolean);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) { toast('نام ثابت‌ها تکراری: ' + dupes.join('، '), 'error'); return; }
    const badNames = names.filter(n => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n));
    if (badNames.length) { toast('نام ثابت‌ها نامعتبر: ' + badNames.join('، '), 'error'); return; }
    try {
      const normalized = DB._normalizeLoanProduct(Object.assign({ id: 'test' }, product));
      const vars = DB._loanBaseVars(normalized, { L: 100000000, R: 50000000, i: 13, P: 60000000 });
      FormulaEngine.eval(normalized.formulas.firstInstallment, vars);
      FormulaEngine.eval(normalized.formulas.otherInstallments, vars);
      FormulaEngine.eval(normalized.formulas.purchasableAmount, vars);
      (normalized.formulas.specialInstallments || []).forEach(s => FormulaEngine.eval(s.formula, vars));
      if (normalized.formulas.loanAmountFromPurchasable) {
        FormulaEngine.eval(normalized.formulas.loanAmountFromPurchasable, DB._loanBaseVars(normalized, { P: 60000000 }));
      }
    } catch (err) {
      toast('فرمول خطا دارد: ' + err.message, 'error');
      return;
    }
    if (isEdit) {
      DB.updateLoanProduct(productId, product);
      toast('محصول بروزرسانی شد.');
    } else {
      DB.addLoanProduct(product, CURRENT_USER);
      toast('محصول اضافه شد.');
    }
    closeModal();
    navigate('loanProducts');
  };
}

// ---- صفحه محاسبه وام (همه نقش‌ها) ----
function renderLoanCalc(main) {
  const tpl = document.getElementById('tpl-loan-calc');
  main.appendChild(tpl.content.cloneNode(true));

  const productSelect = document.getElementById('loan-calc-product');
  const amountInput = document.getElementById('loan-calc-amount');
  const amountLabel = document.getElementById('loan-calc-amount-label');
  const resultBox = document.getElementById('loan-calc-result');
  const descBox = document.getElementById('loan-calc-description');

  attachMoneyFormatter(amountInput);

  const products = DB.getActiveLoanProducts();
  products.sort((a, b) => (a.bankName || '').localeCompare(b.bankName || '', 'fa'));
  productSelect.innerHTML = '<option value="">— انتخاب بانک / طرح وام —</option>' +
    products.map(p => {
      const label = esc(p.bankName) + (p.schemeName ? ' — ' + esc(p.schemeName) : '');
      return `<option value="${p.id}">${label}</option>`;
    }).join('');

  function updateAmountLabel() {
    const mode = document.querySelector('input[name="loan-calc-mode"]:checked').value;
    amountLabel.textContent = mode === 'purchasableAmount' ? 'مبلغ موردنیاز / قدرت خرید (تومان)' : 'مبلغ وام (تومان)';
    amountInput.placeholder = mode === 'purchasableAmount' ? 'مثلاً 60,000,000' : 'مثلاً 100,000,000';
  }
  // رفع باگ پرش فرم: هنگام تغییر radio، فقط label و placeholder را عوض می‌کنیم
  // و نتیجه/مبلغ را پاک نمی‌کنیم تا فرم نپرد. نتیجه قدیمی تا فشردن دوباره‌ی «محاسبه» می‌ماند.
  document.querySelectorAll('input[name="loan-calc-mode"]').forEach(r => r.addEventListener('change', () => {
    updateAmountLabel();
  }));
  updateAmountLabel();

  productSelect.onchange = () => {
    const p = DB.getLoanProduct(productSelect.value);
    if (p && p.description) {
      descBox.classList.remove('hidden');
      descBox.innerHTML = `<div class="loan-calc-desc-box">${esc(p.description)}</div>`;
    } else {
      descBox.classList.add('hidden');
      descBox.innerHTML = '';
    }
    // پاک کردن نتیجه هنگام تغییر محصول منطقی است، اما با حفظ ارتفاع برای جلوگیری از پرش
    resultBox.innerHTML = '';
  };

  document.getElementById('btn-loan-calc-run').onclick = () => {
    const productId = productSelect.value;
    if (!productId) { toast('ابتدا یک بانک/طرح وام انتخاب کنید.', 'error'); return; }
    const product = DB.getLoanProduct(productId);
    if (!product) { toast('محصول وام یافت نشد.', 'error'); return; }
    const amount = getRawNumber(amountInput);
    if (!amount || amount <= 0) { toast('یک مبلغ معتبر وارد کنید.', 'error'); return; }
    const mode = document.querySelector('input[name="loan-calc-mode"]:checked').value;
    try {
      const result = DB.calculateLoan(product, amount, mode);
      resultBox.innerHTML = renderLoanCalcResult(product, result, mode);
      const shareBtn = document.getElementById('btn-loan-calc-share');
      if (shareBtn) shareBtn.onclick = () => shareLoanResult(product, result);
      const printBtn = document.getElementById('btn-loan-calc-print');
      if (printBtn) printBtn.onclick = () => printLoanResult(product, result);
    } catch (e) {
      resultBox.innerHTML = `<div class="warning-box">خطا در محاسبه: ${esc(e.message)}</div>`;
    }
  };
}

// نمایش نتیجه محاسبه - کارت‌های گرافیکی و جدول کامل
function renderLoanCalcResult(product, result, mode) {
  const firstInst = result.schedule.find(x => x.kind === 'first');
  const otherInst = result.schedule.find(x => x.kind === 'other');
  const specials = result.schedule.filter(x => x.kind === 'special');
  const productName = esc(product.bankName) + (product.schemeName ? ' — ' + esc(product.schemeName) : '');
  const otherCount = result.schedule.filter(x => x.kind === 'other').length;

  // خلاصه‌ی سریع - کارت‌های گرافیکی
  const summary = `
    <div class="loan-result-grid">
      <div class="loan-result-cell"><span class="label">مبلغ وام</span><b>${fmtMoney(result.loanAmount)}</b></div>
      <div class="loan-result-cell highlight"><span class="label">مبلغ قابل دریافت (قدرت خرید)</span><b>${fmtMoney(result.purchasableAmount)}</b></div>
      <div class="loan-result-cell"><span class="label">قسط اول</span><b>${fmtMoney(firstInst ? firstInst.amount : 0)}</b></div>
      ${specials.map(s => `<div class="loan-result-cell"><span class="label">${esc(s.label)}</span><b>${fmtMoney(s.amount)}</b></div>`).join('')}
      <div class="loan-result-cell"><span class="label">سایر اقساط (${JalaliUtils.toFa(otherCount)} قسط)</span><b>${fmtMoney(otherInst ? otherInst.amount : 0)}</b></div>
      <div class="loan-result-cell"><span class="label">مجموع بازپرداخت</span><b>${fmtMoney(result.totalPayable)}</b></div>
      <div class="loan-result-cell"><span class="label">هزینه/کمیسیون کل</span><b>${fmtMoney(result.totalExtra)}</b></div>
    </div>
  `;

  // جدول کامل اقساط - همیشه باز
  const scheduleRows = result.schedule.map(s => `
    <tr class="${s.kind === 'first' ? 'row-first' : ''} ${s.kind === 'special' ? 'row-special' : ''}">
      <td>${JalaliUtils.toFa(s.number)}</td>
      <td>${esc(s.label)}</td>
      <td class="amount">${fmtMoney(s.amount)}</td>
      <td>${s.kind === 'first' ? 'قسط اول' : s.kind === 'special' ? 'قسط خاص' : 'قسط عادی'}</td>
    </tr>
  `).join('');

  const warningBox = result.warning ? `<div class="warning-box">${esc(result.warning)}</div>` : '';

  return `
    <div class="loan-result">
      <div class="loan-result-head">
        <h3>📊 نتیجه محاسبه وام — ${productName}</h3>
        <p class="muted small">بر اساس فرمول‌های تعریف‌شده برای این محصول${mode === 'purchasableAmount' ? ' (محاسبه از مبلغ موردنیاز)' : ' (محاسبه از مبلغ وام)'}</p>
      </div>
      ${warningBox}
      ${summary}
      <div class="loan-schedule-wrap">
        <h4 class="section-title" style="margin-top:18px;">جدول کامل اقساط (${JalaliUtils.toFa(result.schedule.length)} قسط)</h4>
        <div class="audit-table-wrap">
          <table class="audit-table loan-schedule-table">
            <thead>
              <tr><th>شماره قسط</th><th>نوع</th><th>مبلغ</th><th>دسته</th></tr>
            </thead>
            <tbody>${scheduleRows}</tbody>
          </table>
        </div>
      </div>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:14px;">
        <button type="button" class="btn btn-secondary btn-sm" id="btn-loan-calc-share">📤 اشتراک‌گذاری نتیجه</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-loan-calc-print">🖨 چاپ</button>
      </div>
    </div>
  `;
}

// اشتراک‌گذاری نتیجه (Web Share API با fallback کپی)
function shareLoanResult(product, result) {
  const productName = product.bankName + (product.schemeName ? ' - ' + product.schemeName : '');
  const firstInst = result.schedule.find(x => x.kind === 'first');
  const otherInst = result.schedule.find(x => x.kind === 'other');
  const specials = result.schedule.filter(x => x.kind === 'special');
  let text = `محاسبه وام — ${productName}\n\n`;
  text += `مبلغ وام: ${result.loanAmount.toLocaleString('fa-IR')} تومان\n`;
  text += `قدرت خرید: ${result.purchasableAmount.toLocaleString('fa-IR')} تومان\n`;
  text += `تعداد اقساط: ${result.installmentsCount.toLocaleString('fa-IR')}\n`;
  text += `قسط اول: ${(firstInst ? firstInst.amount : 0).toLocaleString('fa-IR')} تومان\n`;
  specials.forEach(s => { text += `${s.label}: ${s.amount.toLocaleString('fa-IR')} تومان\n`; });
  text += `سایر اقساط: ${(otherInst ? otherInst.amount : 0).toLocaleString('fa-IR')} تومان\n`;
  text += `مجموع: ${result.totalPayable.toLocaleString('fa-IR')} تومان\n`;
  if (navigator.share) {
    navigator.share({ title: 'محاسبه وام', text }).catch(() => {});
  } else {
    try {
      navigator.clipboard.writeText(text);
      toast('در کلیپ‌بورد کپی شد.');
    } catch (e) {
      toast('اشتراک‌گذاری پشتیبانی نمی‌شود.', 'warn');
    }
  }
}

// چاپ نتیجه - با esc() برای جلوگیری از XSS
function printLoanResult(product, result) {
  const productName = product.bankName + (product.schemeName ? ' - ' + product.schemeName : '');
  const w = window.open('', '_blank');
  if (!w) { toast('مرورگر pop-up را مسدود کرد.', 'error'); return; }
  const safeName = esc(productName);
  const rows = result.schedule.map(s => `<tr><td>${JalaliUtils.toFa(s.number)}</td><td>${esc(s.label)}</td><td style="text-align:left;direction:ltr;">${s.amount.toLocaleString('fa-IR')}</td></tr>`).join('');
  w.document.write(`<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>محاسبه وام — ${safeName}</title>
    <style>body{font-family:Vazirmatn,Tahoma,sans-serif;padding:24px;max-width:720px;margin:0 auto;color:#0f172a;}
    h1{font-size:20px;}h2{font-size:16px;margin-top:18px;}table{width:100%;border-collapse:collapse;margin-top:8px;}
    th,td{padding:8px;border:1px solid #ddd;text-align:right;font-size:13px;}th{background:#f4f6fb;}
    .summary{background:#f4f6fb;padding:14px;border-radius:10px;margin-top:12px;}
    .summary div{display:flex;justify-content:space-between;padding:4px 0;font-size:14px;}
    .summary b{font-size:15px;}</style></head><body>
    <h1>محاسبه وام — ${safeName}</h1>
    <div class="summary">
      <div><span>مبلغ وام:</span><b>${result.loanAmount.toLocaleString('fa-IR')} تومان</b></div>
      <div><span>قدرت خرید:</span><b>${result.purchasableAmount.toLocaleString('fa-IR')} تومان</b></div>
      <div><span>تعداد اقساط:</span><b>${result.installmentsCount.toLocaleString('fa-IR')}</b></div>
      <div><span>مجموع بازپرداخت:</span><b>${result.totalPayable.toLocaleString('fa-IR')} تومان</b></div>
    </div>
    <h2>جدول اقساط</h2>
    <table><thead><tr><th>شماره</th><th>نوع</th><th>مبلغ (تومان)</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="margin-top:18px;font-size:11px;color:#6b7688;">محاسبه بر اساس فرمول‌های تعریف‌شده در سامانه وام‌یار.</p>
    <script>window.onload=function(){window.print();};</script>
    </body></html>`);
  w.document.close();
}


function renderChat(main) {
  if (!DB.canUseChat(CURRENT_USER)) {
    main.innerHTML = `<div class="page">${emptyState('گفتگوی گروهی برای شما فعال نیست. برای دسترسی، از مدیر سیستم بخواهید آن را از همین قسمت (گفتگوی گروهی) برایتان فعال کند.')}</div>`;
    return;
  }
  const tpl = document.getElementById('tpl-chat');
  main.appendChild(tpl.content.cloneNode(true));
  if (CURRENT_USER.role === 'admin') paintChatAdminAccess();
  paintChatMessages();
  document.getElementById('form-chat').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-text');
    const text = input.value.trim();
    if (!text) return;
    DB.addChatMessage({ text }, CURRENT_USER);
    input.value = '';
    paintChatMessages();
  });
}

// Single, consolidated place for the admin to control group-chat access — the master
// on/off switch plus the per-user grant list used to live scattered across "تنظیمات
// پورسانت" and the new-user form; both now live only here, right next to the feature
// they control.
function paintChatAdminAccess() {
  const wrap = document.getElementById('chat-admin-access');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  const s = DB.getSettings();
  const users = DB.getUsers().filter(u => u.role !== 'admin');
  wrap.innerHTML = `
    <fieldset class="fieldset">
      <legend>⚙️ مدیریت دسترسی گفتگوی گروهی</legend>
      <label class="check-inline">
        <input type="checkbox" id="chat-admin-enabled" ${s.chatEnabled ? 'checked' : ''}>
        گفتگوی گروهی بین کاربران را فعال کن
      </label>
      <p class="muted small">
        با فعال بودن این گزینه، فقط کاربرانی که پایین‌تر برایشان تیک زده‌اید می‌توانند وارد گفتگوی گروهی شوند
        و پیام ارسال/دریافت کنند. مدیر همیشه به گفتگو دسترسی دارد.
      </p>
      ${users.length ? `<div id="chat-admin-users-list" class="card-list">
        ${users.map(u => `
          <label class="check-inline card" style="cursor:default;">
            <input type="checkbox" class="chat-admin-user-check" value="${u.id}" ${u.canChat ? 'checked' : ''}>
            ${esc(u.name)} <span class="chip">${ROLE_LABELS[u.role]}</span>
          </label>
        `).join('')}
      </div>` : emptyState('هنوز کاربر جذب‌کننده یا کارشناسی ثبت نشده است.')}
      <div class="modal-actions">
        <button type="button" id="btn-save-chat-access" class="btn btn-primary">ذخیره دسترسی گفتگو</button>
      </div>
    </fieldset>
  `;
  document.getElementById('btn-save-chat-access').onclick = async () => {
    DB.updateSettings({ chatEnabled: document.getElementById('chat-admin-enabled').checked });
    const checks = wrap.querySelectorAll('.chat-admin-user-check');
    for (const chk of checks) {
      await DB.updateUser(chk.value, { canChat: chk.checked });
    }
    toast('دسترسی گفتگوی گروهی ذخیره شد.');
    buildNav();
    navigate('chat');
  };
}

// Deterministic per-sender color so each person in the group chat reads as a
// consistent "identity" across messages (Telegram-style name/avatar coloring),
// without needing to store a color on the user record.
const CHAT_AVATAR_PALETTE = ['#3B5BDB', '#0F9D58', '#D2422A', '#8E44AD', '#12839A', '#B23A6E', '#B8860B'];
function chatColorForSender(senderId, senderRole) {
  if (senderRole === 'admin') return 'var(--gold-dark)';
  let hash = 0;
  const s = String(senderId || '');
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return CHAT_AVATAR_PALETTE[hash % CHAT_AVATAR_PALETTE.length];
}

function fmtChatTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => JalaliUtils.toFa(String(n).padStart(2, '0'));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "امروز" / "دیروز" / full Jalali date — computed off local calendar-day boundaries
// (not raw ms diff) so it flips at midnight rather than after a rolling 24h.
function chatDayLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fmtDate(iso);
  const now = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((nowStart - dayStart) / 86400000);
  if (diffDays === 0) return 'امروز';
  if (diffDays === 1) return 'دیروز';
  return fmtDate(iso);
}

function paintChatMessages() {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const msgs = DB.getChatMessages().slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!msgs.length) { box.innerHTML = emptyState('هنوز پیامی ارسال نشده است.'); return; }
  const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 60;
  const lastIsMine = msgs[msgs.length - 1].senderId === CURRENT_USER.id;

  // A message starts a new visual "cluster" (shows avatar + name) when it's the
  // first message overall, follows a different sender, or the day divider just
  // broke the visual flow above it — mirrors how Telegram groups a burst of
  // messages from the same person instead of repeating the header every time.
  let html = '';
  let lastDayLabel = null;
  msgs.forEach((m, i) => {
    const dayLabel = chatDayLabel(m.createdAt);
    if (dayLabel !== lastDayLabel) {
      html += `<div class="chat-day-divider"><span>${esc(dayLabel)}</span></div>`;
      lastDayLabel = dayLabel;
    }
    const prev = msgs[i - 1];
    const isGroupStart = !prev || prev.senderId !== m.senderId || dayLabel !== chatDayLabel(prev.createdAt);
    const isMine = m.senderId === CURRENT_USER.id;
    const color = chatColorForSender(m.senderId, m.senderRole);
    html += `
    <div class="chat-row ${isMine ? 'mine' : ''} ${isGroupStart ? 'group-start' : ''}" data-id="${m.id}">
      <div class="chat-avatar ${isGroupStart ? '' : 'spacer'}" style="background:${color}">${esc(m.senderName.slice(0, 1))}</div>
      <div class="chat-bubble ${isGroupStart ? 'group-start' : ''}">
        ${CURRENT_USER.role === 'admin' ? `<button type="button" class="chat-delete-btn" data-id="${m.id}" title="حذف پیام">✕</button>` : ''}
        ${isGroupStart ? `<div class="chat-bubble-meta" style="color:${color}">${esc(m.senderName)}${m.senderRole === 'admin' ? ' <span class="role-tag">(مدیر)</span>' : ''}</div>` : ''}
        <div class="chat-bubble-text">${esc(m.text)}</div>
        <div class="chat-bubble-foot"><span class="chat-bubble-time">${fmtChatTime(m.createdAt)}</span></div>
      </div>
    </div>`;
  });
  box.innerHTML = html;
  if (nearBottom || lastIsMine) box.scrollTop = box.scrollHeight;
  box.querySelectorAll('.chat-delete-btn').forEach(btn => {
    btn.onclick = () => {
      if (!confirm('این پیام حذف شود؟')) return;
      DB.deleteChatMessage(btn.dataset.id);
      paintChatMessages();
    };
  });
}

/* ===================== USERS (ADMIN) ===================== */
function renderUsers(main) {
  const tpl = document.getElementById('tpl-users');
  main.appendChild(tpl.content.cloneNode(true));
  usersPageState = 1;
  paintUsers('');
  document.getElementById('users-search').addEventListener('input', (e) => { usersPageState = 1; paintUsers(e.target.value); });
  document.getElementById('btn-add-user').onclick = () => openUserForm();
}

let usersPageState = 1;
const USERS_PAGE_SIZE = 20;
function paintUsers(q) {
  const list = document.getElementById('users-list');
  let users = DB.getUsers();
  if (q && q.trim()) users = users.filter(u => matchesQuery(u.name, u.username, '', q));
  if (!users.length) { list.innerHTML = emptyState('کاربری یافت نشد.'); return; }
  const { items, page, totalPages } = paginate(users, usersPageState, USERS_PAGE_SIZE);
  list.innerHTML = items.map(u => `
    <div class="card" data-id="${u.id}">
      <div class="card-top">
        <div class="card-title">${esc(u.name)} ${!u.active ? '<span class="chip">غیرفعال</span>' : ''}</div>
        <span class="chip">${ROLE_LABELS[u.role]}</span>
      </div>
      <div class="card-sub">نام کاربری: ${esc(u.username)}</div>
      <div class="card-meta">
        ${u.canSeeLeadPurchase ? '<span class="chip stage-completed">دسترسی به خرید امتیاز</span>' : ''}
        ${u.canReviewTakenLeads ? '<span class="chip stage-completed">دسترسی به بررسی وام‌های گرفته‌شده با نام دیگری</span>' : ''}
        ${u.role === 'caller' && u.canProcessCustomers ? '<span class="chip stage-completed">دسترسی به پیگیری مراحل دریافت وام مشتریان خودش</span>' : ''}
        ${u.role !== 'admin' && u.canChat ? '<span class="chip stage-completed">دسترسی به گفتگوی گروهی</span>' : ''}
      </div>
    </div>
  `).join('') + paginationBarHTML(page, totalPages);
  list.querySelectorAll('.card').forEach(el => el.onclick = () => openUserForm(el.dataset.id));
  list.querySelectorAll('[data-page-nav]').forEach(btn => {
    btn.onclick = () => { usersPageState += (btn.dataset.pageNav === 'next' ? 1 : -1); paintUsers(q); };
  });
}

function openUserForm(userId) {
  const isEdit = !!userId;
  const u = isEdit ? DB.getUser(userId) : null;
  const box = openModal('tpl-modal-user');
  const form = box.querySelector('#form-user');
  box.querySelector('#user-form-title').textContent = isEdit ? 'ویرایش کاربر' : 'کاربر جدید';

  // canProcessCustomers only means anything for a caller (جذب‌کننده تلفنی) - a processor
  // already has full access to their own customers, and it's meaningless for admin - so
  // this checkbox is hidden unless the selected role is 'caller'.
  const processCustomersWrap = form.querySelector('#canProcessCustomers-wrap');
  const syncProcessCustomersVisibility = () => processCustomersWrap.classList.toggle('hidden', form.role.value !== 'caller');
  form.role.addEventListener('change', syncProcessCustomersVisibility);

  if (isEdit) {
    form.name.value = u.name;
    form.username.value = u.username;
    form.role.value = u.role;
    form.canSeeLeadPurchase.checked = !!u.canSeeLeadPurchase;
    form.canReviewTakenLeads.checked = !!u.canReviewTakenLeads;
    form.canProcessCustomers.checked = !!u.canProcessCustomers;
    form.active.checked = !!u.active;
    form.password.required = false;
    const delBtn = document.getElementById('btn-delete-user');
    delBtn.style.display = 'inline-block';
    delBtn.textContent = u.active ? 'غیرفعال‌سازی' : 'فعال‌سازی';
    delBtn.onclick = async () => {
      await DB.updateUser(u.id, { active: !u.active });
      toast('وضعیت کاربر بروزرسانی شد.');
      closeModal();
      navigate('users');
    };

    // Permanent delete - distinct from the toggle above. Deactivating just revokes login
    // (keeping the user's history/attribution intact everywhere); this fully removes the
    // account. A user can't delete the account they're currently logged in with.
    const delPermBtn = document.getElementById('btn-delete-user-permanent');
    if (u.id !== CURRENT_USER.id) {
      delPermBtn.style.display = 'inline-block';
      delPermBtn.onclick = () => {
        if (!confirm(`آیا از حذف کامل کاربر «${u.name}» مطمئن هستید؟ این عمل غیرقابل بازگشت است.`)) return;
        DB.deleteUser(u.id);
        toast('کاربر حذف شد.');
        closeModal();
        buildNav();
        navigate('users');
      };
    }
  } else {
    form.password.required = true;
  }
  syncProcessCustomersVisibility();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {
      name: fd.get('name'), username: fd.get('username'), role: fd.get('role'),
      canSeeLeadPurchase: form.canSeeLeadPurchase.checked,
      canReviewTakenLeads: form.canReviewTakenLeads.checked,
      canProcessCustomers: form.canProcessCustomers.checked,
      active: form.active.checked
    };
    const password = fd.get('password');
    if (password) patch.password = password;
    try {
      // Duplicate-username guard: checked here too (not just relying on DB.addUser/
      // updateUser throwing) so the message shows up right away, next to the field,
      // without waiting on the async call - DB still enforces it as the source of truth.
      if (isEdit) await DB.updateUser(u.id, patch);
      else await DB.addUser({ ...patch, password: password || Math.random().toString(36).slice(2, 8) });
      toast('کاربر ذخیره شد.');
      closeModal();
      buildNav();
      navigate('users');
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ===================== BACKUP / RESTORE ===================== */
// Shared by: the manual "📦 پشتیبان‌گیری" button AND the automatic end-of-day backup below.
function downloadJSONBackup(user, opts = {}) {
  const payload = DB.exportBackup(user);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `backup-${user.username}-${dateStr}${opts.auto ? '-خودکار' : ''}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  if (!opts.silent) toast('فایل پشتیبان (JSON) دانلود شد.');
}

document.getElementById('btn-backup').addEventListener('click', () => downloadJSONBackup(CURRENT_USER));

/* ---------- Excel (.xlsx) export ----------
   A human-readable, spreadsheet-friendly export in addition to the full JSON backup.
   JSON stays the complete/lossless backup (used for restore); Excel is meant for opening
   in Excel/Google Sheets, printing, or handing to an accountant - so images and internal
   IDs are left out and amounts/dates are laid out as plain columns. Visible sheets and
   columns follow the same role rules as the rest of the app (e.g. a کارشناس دفتر/processor
   never sees commission amounts; a جذب‌کننده/caller only ever sees their own commission). */
function buildExcelWorkbook(user) {
  const wb = XLSX.utils.book_new();
  const d = DB.load();
  const userName = (id) => (id && DB.getUser(id)?.name) || '';

  function addSheet(rows, name) {
    if (!rows.length) rows = [{ 'توضیح': 'رکوردی برای نمایش وجود ندارد' }];
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); // Excel sheet-name limit
  }

  const customers = DB.getCustomersForUser(user);
  const customerRows = customers.map(c => {
    const row = {
      'نام مشتری': c.name,
      'شماره تماس': c.phone,
      'شماره تماس دوم': c.phone2 || '',
      'کد ملی': c.nationalId,
      'بانک': c.bankName,
      'مبلغ وام': c.loanAmount,
      'نوع دریافت': PAYMENT_TYPE_LABELS[c.paymentType] || '',
      'مرحله پرونده': STAGE_LABELS[c.stage] || c.stage,
      'کارشناس دفتر': userName(c.processorId),
      'جذب‌کننده تلفنی': userName(c.callerId)
    };
    if (user.role === 'admin') {
      row['پورسانت کارشناس'] = c.processorCommission?.amount || 0;
      row['پورسانت کارشناس پرداخت‌شده'] = c.processorCommission?.paid ? 'بله' : 'خیر';
      row['پورسانت جذب‌کننده'] = c.callerCommission?.amount || 0;
      row['پورسانت جذب‌کننده پرداخت‌شده'] = c.callerCommission?.paid ? 'بله' : 'خیر';
      row['هزینه خرید امتیاز'] = c.leadPurchase?.amount || 0;
      row['خرید امتیاز از (شخص)'] = c.leadPurchase?.fromName || '';
      row['خرید امتیاز - واریز به حساب'] = c.leadPurchase?.toAccount || '';
      row['دریافتی خدمات وام (نقد)'] = c.serviceFee?.amount || 0;
      row['مبلغ فروش کالا'] = c.goodsSettlement?.saleAmount || 0;
      row['پیش‌پرداخت کالا'] = c.goodsSettlement?.downPayment || 0;
      row['مبلغ خرید کالا (تسویه)'] = c.goodsPurchase?.amount || 0;
      row['خرید کالا از (شخص)'] = c.goodsPurchase?.fromName || '';
    } else if (user.role === 'caller' && c.callerId === user.id) {
      row['پورسانت من'] = c.callerCommission?.amount || 0;
      row['پورسانت من پرداخت‌شده'] = c.callerCommission?.paid ? 'بله' : 'خیر';
    }
    row['تاریخ ثبت'] = JalaliUtils.isoToJalaliStr(c.createdAt);
    row['تاریخ تکمیل'] = c.completedAt ? JalaliUtils.isoToJalaliStr(c.completedAt) : '';
    return row;
  });
  addSheet(customerRows, 'مشتریان');

  if (user.role === 'admin' || user.role === 'caller') {
    const leads = user.role === 'admin' ? d.leads : DB.getLeadsByCaller(user.id);
    const leadRows = leads.map(l => ({
      'نام': l.name,
      'شماره تماس': l.phone,
      'کد ملی': l.nationalId,
      'جذب‌کننده': userName(l.callerId),
      'وضعیت پیگیری': FOLLOWUP_LABELS[l.followUpStatus] || l.followUpStatus,
      'یادداشت': l.note || '',
      'تاریخ ثبت': JalaliUtils.isoToJalaliStr(l.createdAt)
    }));
    addSheet(leadRows, 'لیدهای جذب تلفنی');
  }

  if (user.role === 'admin') {
    const userRows = d.users.map(u => ({
      'نام': u.name,
      'نام کاربری': u.username,
      'نقش': ROLE_LABELS[u.role] || u.role,
      'فعال': u.active ? 'بله' : 'خیر',
      'دسترسی گفتگوی گروهی': u.canChat ? 'بله' : 'خیر',
      'دسترسی خرید امتیاز': u.canSeeLeadPurchase ? 'بله' : 'خیر',
      'دسترسی پیگیری مراحل وام مشتریان خودش': u.role === 'caller' && u.canProcessCustomers ? 'بله' : 'خیر'
    }));
    addSheet(userRows, 'کاربران');

    const payoutRows = DB.commissionPayoutSummary().map(s => ({
      'نام': s.name,
      'نقش': ROLE_LABELS[s.role] || s.role,
      'کل پورسانت': s.totalCommission,
      'پرداخت‌شده': s.paid,
      'مانده': s.remaining
    }));
    addSheet(payoutRows, 'پرداخت پورسانت کاربران');
  }

  return wb;
}

function downloadExcelBackup(user, opts = {}) {
  const wb = buildExcelWorkbook(user);
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `backup-excel-${user.username}-${dateStr}${opts.auto ? '-خودکار' : ''}.xlsx`);
  if (!opts.silent) toast('فایل اکسل دانلود شد.');
}

document.getElementById('btn-backup-excel').addEventListener('click', () => downloadExcelBackup(CURRENT_USER));

/* ---------- Automatic end-of-day backup (admin panel) ----------
   This app has no dedicated backend server (only Firebase Firestore, used for per-record
   sync), so there is no process running at midnight even when nobody has the app open.
   A real "runs no matter what, even if the browser is closed" daily backup would need a
   Firebase Cloud Function on a paid (Blaze) plan - see the Cloud Functions note in the
   README if that's ever wanted later. Within the current free/no-backend setup, this does
   the closest practical thing: once the admin has the app open on/after 23:00 (local
   device time) on a given day, it automatically downloads that day's JSON + Excel backup
   - no click needed. If the admin never has the app open that late on a given day, it
   automatically catches up and runs once as soon as they open the app the next time
   ("پایان دیروز"), so a day is never silently skipped.
   Only ever runs for the admin (the only role with a full-data backup). */
const AUTO_BACKUP_HOUR = 23; // "end of day" trigger point, 24h local device time
const AUTO_BACKUP_KEY = 'vam_auto_backup_last_date';

function localDateStr(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderAutoBackupStatus() {
  const el = document.getElementById('auto-backup-status');
  if (!el) return;
  if (CURRENT_USER?.role !== 'admin') { el.classList.add('hidden'); return; }
  const last = localStorage.getItem(AUTO_BACKUP_KEY);
  el.classList.remove('hidden');
  el.textContent = last
    ? `✅ آخرین بکاپ خودکار: ${JalaliUtils.isoToJalaliStr(last)}`
    : '⏳ هنوز بکاپ خودکار پایان‌روز انجام نشده (این دستگاه)';
}

function runAutoBackupNow() {
  try {
    downloadJSONBackup(CURRENT_USER, { silent: true, auto: true });
    downloadExcelBackup(CURRENT_USER, { silent: true, auto: true });
    localStorage.setItem(AUTO_BACKUP_KEY, localDateStr());
    toast('📦 بکاپ خودکار پایان روز (JSON + اکسل) دانلود شد.');
  } catch (err) {
    console.error('auto backup failed', err);
  } finally {
    renderAutoBackupStatus();
  }
}

function maybeRunAutoBackup() {
  if (!CURRENT_USER || CURRENT_USER.role !== 'admin') return;
  renderAutoBackupStatus();
  const now = new Date();
  const todayStr = localDateStr(now);
  const lastStr = localStorage.getItem(AUTO_BACKUP_KEY);
  if (lastStr === todayStr) return; // already backed up today on this device
  const isEndOfDay = now.getHours() >= AUTO_BACKUP_HOUR;
  const isCatchUp = !!lastStr && lastStr < todayStr; // a previous day's backup never ran
  if (!isEndOfDay && !isCatchUp) return;
  runAutoBackupNow();
}

// The tab can stay open across the 23:00 threshold, so keep re-checking periodically
// (not just once at login) - every 15 minutes is frequent enough to catch it reliably
// without doing any real work almost all of those checks.
setInterval(maybeRunAutoBackup, 15 * 60 * 1000);

document.getElementById('input-restore').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (payload.scope === 'all' && CURRENT_USER.role !== 'admin') {
        alert('فقط مدیر سیستم می‌تواند فایل پشتیبان کامل را بازیابی کند.');
        return;
      }
      if (payload.scope === 'all') {
        if (!confirm('این فایل به‌صورت رکورد به رکورد با داده‌های فعلی ادغام می‌شود (رکوردهای جدیدتر جایگزین می‌شوند) و چیزی حذف نخواهد شد. ادامه می‌دهید؟')) return;
      }
      const result = DB.importBackup(payload, CURRENT_USER);
      toast('بازیابی/ادغام داده‌ها با موفقیت انجام شد.');
      navigate(CURRENT_ROUTE);
    } catch (err) {
      alert('فایل پشتیبان معتبر نیست.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ===================== SERVICE WORKER / PWA ===================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
  // Without this, a device that installed the app once always keeps showing the OLD
  // cached version first and only updates the cache silently in the background for
  // "next time" - so a device could get stuck forever on a stale/broken build without
  // any visible error. Once a new service worker takes control, reload once automatically
  // so every device actually picks up the new code (new Firebase config fixes, bug fixes, etc).
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    swRefreshing = true;
    window.location.reload();
  });
}
window.addEventListener('online', () => document.getElementById('online-badge')?.remove());

/* ===================== Desktop sidebar offset sync =====================
   The desktop sidebar sits fixed below the topbar and reads its top offset
   from --header-h (see .sidebar in style.css) instead of a hardcoded pixel
   value, because the real height of "topbar" varies (font/box changes) and
   the connection-lost banner can appear/disappear above it at any time.
   Measure the actual combined height and keep the CSS variable in sync. */
(function syncHeaderHeight() {
  const banner = document.getElementById('connection-banner');
  const topbar = document.querySelector('.topbar');
  if (!banner || !topbar) return;
  const update = () => {
    const bannerH = banner.offsetHeight;
    const totalH = bannerH + topbar.offsetHeight;
    document.documentElement.style.setProperty('--banner-h', bannerH + 'px');
    document.documentElement.style.setProperty('--header-h', totalH + 'px');
  };
  window.__syncHeaderHeight = update;
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(update);
    ro.observe(banner);
    ro.observe(topbar);
  } else {
    window.addEventListener('resize', update);
  }
  update();
})();

/* ===================== INIT ===================== */
// DB.init() is asynchronous (it loads from IndexedDB, migrating any older
// localStorage-based data the first time it runs) - initAuth() must wait for
// it to finish before it can safely read DB._data.
DB.init().then(initAuth).catch((err) => {
  console.error('DB.init failed:', err);
  alert('خطا در بارگذاری اطلاعات برنامه. لطفاً صفحه را رفرش کنید.');
});
