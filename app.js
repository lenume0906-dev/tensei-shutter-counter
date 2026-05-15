'use strict';

// === 定数 ===
const GAS_URL = 'https://script.google.com/macros/s/AKfycby6sJG1vL42aYvngioWn18WwyTqgt6ZT4KBzFKFTdFA_eeQwRjvGBfWcE1jLYXSHqVx3Q/exec';
const SECRET_KEY = '16384';
const DB_NAME = 'hokuto-tensei';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const TOMBSTONE_KEY = 'hokuto-tombstones';

// === 墓標管理（localStorage）===
// 削除済みIDを記録し、再同期で復活させないようにする
function getTombstones() {
  try { return JSON.parse(localStorage.getItem(TOMBSTONE_KEY)) || []; }
  catch { return []; }
}
function addTombstone(id) {
  const t = getTombstones();
  if (!t.includes(id)) {
    t.push(id);
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(t));
  }
}

// === IndexedDB ===
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) {
        const store = d.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('synced', 'synced', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function saveSession(session) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(session);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getAllSessions() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getUnsyncedSessions() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('synced');
    const req = idx.getAll(false);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function markSynced(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const session = getReq.result;
      if (!session) { resolve(); return; }
      session.synced = true;
      const putReq = store.put(session);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// GASから取得したデータをマージ（idでユニーク化、墓標は除外）
function mergeSessions(sessions) {
  return new Promise((resolve, reject) => {
    const tombstones = new Set(getTombstones());
    const filtered = (sessions || []).filter((s) => !tombstones.has(s.id));
    if (filtered.length === 0) { resolve(); return; }
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let pending = filtered.length;
    filtered.forEach((s) => {
      const record = { ...s, synced: true };
      const req = store.put(record);
      req.onsuccess = () => { if (--pending === 0) resolve(); };
      req.onerror = () => reject(req.error);
    });
    tx.onerror = () => reject(tx.error);
  });
}

function deleteSession(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteFromGAS(id) {
  const body = { secret: SECRET_KEY, action: 'delete', id };
  const res  = await fetch(GAS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  return data.ok === true;
}

// === 計算 ===
function calcSession(s) {
  const totalRot = s.end_rotation - s.start_rotation;
  const balance = s.return_coins - s.invest_coins;
  const prob = s.win_count > 0 ? totalRot / s.win_count : null;
  const payout = totalRot > 0
    ? ((totalRot * 3 + s.return_coins - s.invest_coins) / (totalRot * 3)) * 100
    : null;
  return { totalRot, balance, prob, payout };
}

function calcTotal(sessions) {
  if (!sessions || sessions.length === 0) return null;
  const totalRot    = sessions.reduce((a, s) => a + (s.end_rotation - s.start_rotation), 0);
  const totalWin    = sessions.reduce((a, s) => a + s.win_count, 0);
  const totalInvest = sessions.reduce((a, s) => a + s.invest_coins, 0);
  const totalReturn = sessions.reduce((a, s) => a + s.return_coins, 0);
  const balance     = totalReturn - totalInvest;
  // 確率・機械割は累計の生データから再計算（単純平均ではない）
  const prob   = totalWin > 0 ? totalRot / totalWin : null;
  const payout = totalRot > 0
    ? ((totalRot * 3 + totalReturn - totalInvest) / (totalRot * 3)) * 100
    : null;
  return { count: sessions.length, totalRot, totalWin, balance, prob, payout };
}

// === フォーマット ===
function fmtProb(prob) {
  if (prob === null || !isFinite(prob)) return '—';
  return `1/${prob.toFixed(1)}`;
}

function fmtPayout(payout) {
  if (payout === null || !isFinite(payout)) return '—';
  return `${payout.toFixed(1)}%`;
}

function fmtBalance(balance) {
  if (balance === null || balance === undefined) return '—';
  const sign = balance >= 0 ? '+' : '';
  return `${sign}${balance.toLocaleString()}枚`;
}

function balanceClass(v) {
  if (v > 0) return 'positive';
  if (v < 0) return 'negative';
  return '';
}

function payoutClass(v) {
  if (v === null || !isFinite(v)) return '';
  if (v > 100) return 'positive';
  if (v < 100) return 'negative';
  return '';
}

// === タブ切り替え ===
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.remove('active');
    btn.setAttribute('aria-selected', 'false');
  });
  document.getElementById(`tab-${tabId}`).classList.add('active');
  const activeBtn = document.querySelector(`[data-tab="${tabId}"]`);
  activeBtn.classList.add('active');
  activeBtn.setAttribute('aria-selected', 'true');

  if (tabId === 'analytics') renderAnalytics();
}

// === リアルタイムプレビュー ===
function updatePreview() {
  const startRot    = parseInt(document.getElementById('start_rotation').value) || 0;
  const endRot      = parseInt(document.getElementById('end_rotation').value)   || 0;
  const winCount    = parseInt(document.getElementById('win_count').value)       || 0;
  const investCoins = parseInt(document.getElementById('invest_coins').value)    || 0;
  const returnCoins = parseInt(document.getElementById('return_coins').value)    || 0;

  const totalRot = endRot - startRot;
  const balance  = returnCoins - investCoins;
  const prob     = winCount > 0 && totalRot > 0 ? totalRot / winCount : null;
  const payout   = totalRot > 0
    ? ((totalRot * 3 + returnCoins - investCoins) / (totalRot * 3)) * 100
    : null;

  document.getElementById('prev-rot').textContent =
    totalRot > 0 ? `${totalRot.toLocaleString()}G` : '—';

  const balEl = document.getElementById('prev-balance');
  balEl.textContent = (investCoins || returnCoins) ? fmtBalance(balance) : '—';
  balEl.className = `prev-value ${balanceClass(balance)}`;

  document.getElementById('prev-prob').textContent = fmtProb(prob);

  const payEl = document.getElementById('prev-payout');
  payEl.textContent = fmtPayout(payout);
  payEl.className = `prev-value ${payoutClass(payout)}`;

  document.getElementById('prev-win').textContent =
    winCount > 0 ? `${winCount}回` : '—';
}

// === 解析タブ描画 ===
async function renderAnalytics() {
  const sessions = await getAllSessions();
  sessions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const latestEl   = document.getElementById('analytics-latest');
  const totalEl    = document.getElementById('analytics-total');
  const deleteBtn  = document.getElementById('delete-latest-btn');

  if (sessions.length === 0) {
    latestEl.innerHTML = '<p class="no-data">データがありません</p>';
    totalEl.innerHTML  = '<p class="no-data">データがありません</p>';
    deleteBtn.hidden = true;
    return;
  }
  deleteBtn.hidden = false;

  // 最新セッション1件
  const latest = sessions[sessions.length - 1];
  const ls = calcSession(latest);
  const dt = new Date(latest.timestamp);
  const dtStr = dt.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
    + ' ' + dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

  latestEl.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">総回転数</span>
      <span class="stat-value">${ls.totalRot.toLocaleString()}G</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">当選回数</span>
      <span class="stat-value">${latest.win_count}回</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">初当たり確率</span>
      <span class="stat-value">${fmtProb(ls.prob)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">収支</span>
      <span class="stat-value ${balanceClass(ls.balance)}">${fmtBalance(ls.balance)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">機械割</span>
      <span class="stat-value ${payoutClass(ls.payout)}">${fmtPayout(ls.payout)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">記録日時</span>
      <span class="stat-value small">${dtStr}</span>
    </div>
  `;

  // 累計
  const tot = calcTotal(sessions);
  totalEl.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">セッション数</span>
      <span class="stat-value">${tot.count}回</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">累計総回転数</span>
      <span class="stat-value">${tot.totalRot.toLocaleString()}G</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">累計当選回数</span>
      <span class="stat-value">${tot.totalWin}回</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">累計初当たり確率</span>
      <span class="stat-value">${fmtProb(tot.prob)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">累計収支</span>
      <span class="stat-value ${balanceClass(tot.balance)}">${fmtBalance(tot.balance)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">累計機械割</span>
      <span class="stat-value ${payoutClass(tot.payout)}">${fmtPayout(tot.payout)}</span>
    </div>
  `;
}

// === 同期ステータス表示 ===
function updateSyncStatus(status, count = 0) {
  const el = document.getElementById('sync-status');
  el.className = `sync-status ${status}`;
  const labels = {
    syncing: '同期中...',
    synced:  '同期済み',
    pending: `未同期 (${count}件)`,
    offline: 'オフライン',
  };
  el.textContent = labels[status] ?? '';
}

// === GAS通信 ===
async function syncFromGAS() {
  if (!navigator.onLine) { updateSyncStatus('offline'); return; }
  updateSyncStatus('syncing');
  try {
    const res  = await fetch(`${GAS_URL}?secret=${SECRET_KEY}`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.sessions)) {
      await mergeSessions(data.sessions);
    }
  } catch (e) {
    console.warn('GAS GET失敗:', e);
  }
  const unsynced = await getUnsyncedSessions();
  updateSyncStatus(unsynced.length > 0 ? 'pending' : 'synced', unsynced.length);
}

async function postToGAS(session) {
  const body = {
    secret:         SECRET_KEY,
    id:             session.id,
    timestamp:      session.timestamp,
    start_rotation: session.start_rotation,
    win_count:      session.win_count,
    abeshi_count:   session.abeshi_count,
    end_rotation:   session.end_rotation,
    invest_coins:   session.invest_coins,
    return_coins:   session.return_coins,
    note:           session.note || '',
  };
  // CORSプリフライト回避のため text/plain で送信（GAS側でJSON.parseされる）
  const res  = await fetch(GAS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  return data.ok === true;
}

async function syncPendingToGAS() {
  if (!navigator.onLine) return;
  const unsynced = await getUnsyncedSessions();
  for (const session of unsynced) {
    try {
      const ok = await postToGAS(session);
      if (ok) await markSynced(session.id);
    } catch (e) {
      console.warn('GAS POST失敗:', session.id, e);
    }
  }
  const remaining = await getUnsyncedSessions();
  updateSyncStatus(remaining.length > 0 ? 'pending' : 'synced', remaining.length);
}

// === 削除処理 ===
async function deleteLatest() {
  const sessions = await getAllSessions();
  if (sessions.length === 0) return;
  sessions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const latest = sessions[sessions.length - 1];

  const dt = new Date(latest.timestamp);
  const dtStr = dt.toLocaleDateString('ja-JP') + ' ' + dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (!confirm(`直近のセッションを削除しますか？\n\n${dtStr}\nこの操作は取り消せません。`)) return;

  // ローカル削除 + 墓標記録（GAS復活防止）
  await deleteSession(latest.id);
  addTombstone(latest.id);
  await renderAnalytics();

  // GAS側も削除を試みる（ベストエフォート、未対応でも墓標で復活はしない）
  if (navigator.onLine) {
    try {
      await deleteFromGAS(latest.id);
    } catch (e) {
      console.warn('GAS削除失敗（ローカルは削除済み）:', e);
    }
  }
}

// === 保存処理 ===
function showMessage(msg, type) {
  const el = document.getElementById('save-message');
  el.textContent  = msg;
  el.className    = `save-message ${type}`;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function saveData() {
  const startRot    = parseInt(document.getElementById('start_rotation').value);
  const winCount    = parseInt(document.getElementById('win_count').value);
  const endRot      = parseInt(document.getElementById('end_rotation').value);
  const investCoins = parseInt(document.getElementById('invest_coins').value);
  const returnCoins = parseInt(document.getElementById('return_coins').value);
  const note        = document.getElementById('note').value.trim();

  // バリデーション
  if ([startRot, winCount, endRot, investCoins, returnCoins].some(isNaN)) {
    showMessage('すべての数値項目を入力してください', 'error');
    return;
  }
  if (endRot < startRot) {
    showMessage('終了回転数は開始回転数以上にしてください', 'error');
    return;
  }

  const session = {
    id:             crypto.randomUUID(),
    timestamp:      new Date().toISOString(),
    start_rotation: startRot,
    win_count:      winCount,
    abeshi_count:   0,
    end_rotation:   endRot,
    invest_coins:   investCoins,
    return_coins:   returnCoins,
    note,
    synced: false,
  };

  await saveSession(session);
  showMessage('保存しました ✔', 'success');
  document.getElementById('input-form').reset();
  updatePreview();

  // バックグラウンドでGASに送信
  updateSyncStatus('syncing');
  try {
    const ok = await postToGAS(session);
    if (ok) {
      await markSynced(session.id);
      updateSyncStatus('synced');
    } else {
      const unsynced = await getUnsyncedSessions();
      updateSyncStatus('pending', unsynced.length);
    }
  } catch (e) {
    console.warn('GAS送信失敗、キューに積みます:', e);
    const unsynced = await getUnsyncedSessions();
    updateSyncStatus('pending', unsynced.length);
  }
}

// === Service Worker登録 ===
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js')
    .catch((e) => console.warn('SW登録失敗:', e));
}

// === 初期化 ===
async function init() {
  db = await openDB();
  registerSW();

  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // フォーム入力でプレビュー更新
  document.getElementById('input-form').addEventListener('input', updatePreview);

  // 保存ボタン
  document.getElementById('save-btn').addEventListener('click', saveData);

  // 削除ボタン
  document.getElementById('delete-latest-btn').addEventListener('click', deleteLatest);

  // 手動再同期ボタン
  document.getElementById('sync-btn').addEventListener('click', async () => {
    await syncFromGAS();
    await syncPendingToGAS();
  });

  // オンライン/オフライン検知
  window.addEventListener('online',  () => { syncFromGAS().then(() => syncPendingToGAS()); });
  window.addEventListener('offline', () => { updateSyncStatus('offline'); });

  // 起動時同期
  if (navigator.onLine) {
    syncFromGAS().then(() => syncPendingToGAS());
  } else {
    const unsynced = await getUnsyncedSessions();
    updateSyncStatus('offline', unsynced.length);
  }

  updatePreview();
}

init().catch(console.error);
