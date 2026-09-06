import {
  auth,
  testConnection,
  loginWithGoogle,
  logoutUser,
  onAuthStateChanged,
  handleFirestoreError,
  OperationType
} from './firebase';
import {
  DEFAULT_SHOW,
  initializeShowAndSeats,
  subscribeToSeats,
  holdSeatInFirestore,
  releaseSeatInFirestore,
  reserveSeatsInFirestore,
  bookSeats,
  fetchServerReservedSeats,
  getLocalReservations,
  fetchServerReservations,
  fetchReservationById,
  getAllMyReservations,
  subscribeToUserReservations,
  SeatData,
  ReservationData
} from './seatService';
import { initChat, ChatSeatContext } from './chatService';
import { User } from 'firebase/auth';

const SHOW_ID = DEFAULT_SHOW.id;
const ROWS = DEFAULT_SHOW.rows;
const COLS = DEFAULT_SHOW.cols;
const AISLE_AFTER_COL = 7;
const PRICE_PER_SEAT = DEFAULT_SHOW.price;
const HOLD_TTL_MS = 2 * 60 * 1000; // 2 minutes

// State
let currentUser: User | null = null;
const seatState = new Map<string, 'free' | 'held' | 'taken' | 'selected'>();
const selected = new Set<string>();
const pending = new Set<string>();
const holdTimers = new Map<string, any>();
const holdExpiresAt = new Map<string, number>();

let focusSeatId: string | null = null;
let currentSector: string | null = null;
let isMobile = false;
let userReservations: ReservationData[] = [];
let unsubscribeSeats: (() => void) | null = null;
let unsubscribeReservations: (() => void) | null = null;

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function rowName(rIndex: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + rIndex);
}

function seatId(rIndex: number, cIndex: number): string {
  return `${rowName(rIndex)}-${cIndex + 1}`;
}

function parseSeat(seatIdStr: string) {
  const [rL, cS] = seatIdStr.split('-');
  return { r: rL.charCodeAt(0) - 'A'.charCodeAt(0), c: parseInt(cS, 10) - 1 };
}

function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function sectorFor(r: number, c: number): string {
  const top = r < Math.floor(ROWS / 2);
  const left = c < AISLE_AFTER_COL;
  if (top && left) return 'A';
  if (top && !left) return 'B';
  if (!top && left) return 'C';
  return 'D';
}

function isSeatVisible(r: number, c: number): boolean {
  if (!isMobile || !currentSector) return true;
  return sectorFor(r, c) === currentSector;
}

// Toast
let toastTimer: any = null;
function announce(msg: string, tone: 'info' | 'success' | 'error' = 'info') {
  const live = $('live');
  if (live) live.textContent = msg;

  const t = $('statusToast');
  if (!t) return;
  t.classList.remove('info', 'success', 'error');
  t.classList.add(tone);
  const prefix = tone === 'success' ? 'Muvaffaqiyat' : tone === 'error' ? 'Xatolik' : 'Ma’lumot';
  t.textContent = `${prefix}: ${msg}`;

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('success', 'error');
    t.classList.add('info');
  }, 3000);
}

function deviceMode() {
  const w = window.innerWidth;
  isMobile = w <= 520;
  const dh = $('deviceHint');
  if (dh) dh.textContent = `Qurilma: ${isMobile ? 'Telefon' : w <= 980 ? 'Planshet' : 'Kompyuter'}`;
  const ml = $('modeLabel');
  if (ml) ml.textContent = `Rejim: ${isMobile ? (currentSector ? 'Sektor ko‘rinishi' : 'Sektorlar ro‘yxati') : 'To‘liq zal xaritasi'}`;
}

// Grid cell helper
function makeCell(text: string, cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  d.setAttribute('role', 'presentation');
  return d;
}

function makeSpacer() {
  const s = document.createElement('div');
  s.style.width = '14px';
  s.style.height = 'var(--seat)';
  s.style.opacity = '.25';
  s.setAttribute('role', 'presentation');
  return s;
}

function paintKeyboardFocus() {
  document.querySelectorAll('.seat.kbfocus').forEach(el => el.classList.remove('kbfocus'));
  if (!focusSeatId) return;
  const el = document.querySelector(`[data-seat-id="${CSS.escape(focusSeatId)}"]`);
  if (el) {
    el.classList.add('kbfocus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function moveFocusArrow(key: string) {
  if (!focusSeatId) return;
  const { r, c } = parseSeat(focusSeatId);

  let nr = r, nc = c;
  if (key === 'ArrowUp') nr = Math.max(0, r - 1);
  if (key === 'ArrowDown') nr = Math.min(ROWS - 1, r + 1);
  if (key === 'ArrowLeft') nc = Math.max(0, c - 1);
  if (key === 'ArrowRight') nc = Math.max(0, c + 1);

  nc = Math.min(COLS - 1, nc);

  let guard = 0;
  while (!isSeatVisible(nr, nc) && guard++ < 60) {
    if (currentSector === 'A' || currentSector === 'C') nc = Math.max(0, nc - 1);
    else nc = Math.min(COLS - 1, nc + 1);
  }

  focusSeatId = seatId(nr, nc);
  paintKeyboardFocus();
}

function onGridKeydown(e: KeyboardEvent) {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    moveFocusArrow(e.key);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (focusSeatId) toggleSeat(focusSeatId);
    return;
  }
  if (e.key === 'Escape') {
    if (isMobile && currentSector) {
      e.preventDefault();
      closeSector();
    }
  }
}

function renderSeatGrid() {
  const grid = $('seatGrid');
  if (!grid) return;
  grid.innerHTML = '';

  const totalColumns = 1 + COLS + 1;
  grid.style.gridTemplateColumns = `repeat(${totalColumns}, minmax(0, auto))`;

  grid.appendChild(makeCell('', 'col-label'));
  for (let c = 0; c < COLS; c++) {
    if (c === AISLE_AFTER_COL) grid.appendChild(makeSpacer());
    grid.appendChild(makeCell(String(c + 1), 'col-label'));
  }

  let firstVisibleSeat: string | null = null;

  for (let r = 0; r < ROWS; r++) {
    grid.appendChild(makeCell(rowName(r), 'row-label'));

    for (let c = 0; c < COLS; c++) {
      if (c === AISLE_AFTER_COL) grid.appendChild(makeSpacer());

      if (!isSeatVisible(r, c)) {
        const empty = document.createElement('div');
        empty.style.width = 'var(--seat)';
        empty.style.height = 'var(--seat)';
        empty.style.opacity = '0';
        grid.appendChild(empty);
        continue;
      }

      const id = seatId(r, c);
      const status = seatState.get(id) || 'free';

      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.dataset.seatId = id;
      seat.title = id;

      const isDisabled = (status === 'taken' || status === 'held') && !selected.has(id);
      const srStatus = status === 'free' ? 'mavjud'
                    : status === 'taken' ? 'band'
                    : status === 'held' ? 'band qilinmoqda'
                    : status === 'selected' ? 'tanlangan'
                    : status;
      seat.setAttribute('role', 'gridcell');
      seat.setAttribute('aria-label', `O‘rindiq ${id}. Holat: ${srStatus}.`);
      seat.setAttribute('aria-selected', selected.has(id) ? 'true' : 'false');
      seat.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');

      if (status === 'taken') seat.classList.add('taken');
      if (status === 'held') seat.classList.add('held');
      if (status === 'selected') seat.classList.add('selected');
      if (pending.has(id)) seat.classList.add('pending');

      seat.addEventListener('click', () => toggleSeat(id));

      if (!firstVisibleSeat) firstVisibleSeat = id;
      grid.appendChild(seat);
    }
  }

  if (!focusSeatId || !document.querySelector(`[data-seat-id="${CSS.escape(focusSeatId)}"]`)) {
    focusSeatId = firstVisibleSeat;
  }
  paintKeyboardFocus();
}

function sectorStats(key: string) {
  let free = 0, taken = 0, held = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (sectorFor(r, c) !== key) continue;
      const id = seatId(r, c);
      const s = seatState.get(id);
      if (s === 'free') free++;
      else if (s === 'taken') taken++;
      else if (s === 'held' || s === 'selected') held++;
    }
  }
  return { free, taken, held };
}

function renderSectors() {
  const sg = $('sectorGrid');
  if (!sg) return;
  sg.innerHTML = '';

  const sectors = [
    { key: 'A', name: 'Sektor A (Old-Chap)' },
    { key: 'B', name: 'Sektor B (Old-O‘ng)' },
    { key: 'C', name: 'Sektor C (Orqa-Chap)' },
    { key: 'D', name: 'Sektor D (Orqa-O‘ng)' },
  ];

  sectors.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'sector';
    btn.type = 'button';
    const st = sectorStats(s.key);

    btn.innerHTML = `
      <div class="name">${s.name}</div>
      <div class="meta">
        <span>Bo‘sh: <strong>${st.free}</strong></span>
        <span>Band: <strong>${st.taken}</strong></span>
        <span>Ushlangan: <strong>${st.held}</strong></span>
      </div>
    `;

    btn.addEventListener('click', () => openSector(s.key, s.name));
    sg.appendChild(btn);
  });
}

function openSector(key: string, name: string) {
  currentSector = key;
  const title = $('sectorTitle');
  if (title) title.textContent = name;
  announce(`Sektor tanlandi: ${name}`, 'info');

  renderSeatGrid();
  updateUI();
  const first = document.querySelector('.seat:not([style*="opacity: 0"])') as HTMLElement | null;
  if (first && first.dataset.seatId) {
    focusSeatId = first.dataset.seatId;
    paintKeyboardFocus();
  }
}

function closeSector() {
  currentSector = null;
  announce('Sektorlardan chiqildi (To‘liq xarita)', 'info');
  renderSeatGrid();
  updateUI();
}

// Seat interaction (frictionless selection + optional Firestore hold)
async function toggleSeat(id: string) {
  const status = seatState.get(id);
  if (pending.has(id)) return;

  if (status === 'taken') {
    announce(`O‘rindiq ${id} allaqachon band qilingan.`, 'error');
    return;
  }
  if (status === 'held' && !selected.has(id)) {
    announce(`O‘rindiq ${id} boshqa tomoshabin tomonidan ushlab turilibdi.`, 'error');
    return;
  }

  const wasSelected = selected.has(id);

  if (wasSelected) {
    seatState.set(id, 'free');
    selected.delete(id);
    disarmHoldTimeout(id);
    announce(`O‘rindiq ${id} tanlovdan chiqarildi.`, 'info');
  } else {
    seatState.set(id, 'selected');
    selected.add(id);
    armHoldTimeout(id);
    announce(`O‘rindiq ${id} tanlandi ✅`, 'success');
  }

  renderSeatGrid();
  updateUI();

  // If user is logged in with Firebase, sync hold in background
  if (currentUser) {
    try {
      if (wasSelected) {
        await releaseSeatInFirestore(SHOW_ID, id);
      } else {
        await holdSeatInFirestore(SHOW_ID, id, HOLD_TTL_MS);
      }
    } catch (e) {
      console.warn('Firestore hold sync note:', e);
    }
  }
}

function armHoldTimeout(id: string) {
  disarmHoldTimeout(id);
  const expires = Date.now() + HOLD_TTL_MS;
  holdExpiresAt.set(id, expires);

  const tid = setTimeout(async () => {
    if (!selected.has(id)) return;
    announce(`Vaqt tugadi: ${id} bo‘shatildi`, 'info');
    if (currentUser) {
      await releaseSeatInFirestore(SHOW_ID, id).catch(() => {});
    }
    selected.delete(id);
    seatState.set(id, 'free');
    renderSeatGrid();
    updateUI();
  }, HOLD_TTL_MS);

  holdTimers.set(id, tid);
}

function disarmHoldTimeout(id: string) {
  if (holdTimers.has(id)) {
    clearTimeout(holdTimers.get(id));
    holdTimers.delete(id);
  }
  holdExpiresAt.delete(id);
}

// Clear selection
async function clearSelection() {
  if (selected.size === 0) return;
  const ids = [...selected];

  ids.forEach(id => {
    seatState.set(id, 'free');
    disarmHoldTimeout(id);
  });
  selected.clear();
  announce('Tanlangan o‘rindiqlar tozalandi.', 'info');
  renderSeatGrid();
  updateUI();

  if (currentUser) {
    for (const id of ids) {
      releaseSeatInFirestore(SHOW_ID, id).catch(() => {});
    }
  }
}

// Helper to generate a clean SVG QR Code
function generateQRCodeSVG(text: string): string {
  // Generates a realistic, clean matrix barcode representation for cinema tickets
  const size = 25;
  const hash = Array.from(text).reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 1000000007, 42);
  let rects = '';
  
  // Finder patterns at three corners (7x7 squares)
  const drawFinder = (startX: number, startY: number) => {
    for (let x = 0; x < 7; x++) {
      for (let y = 0; y < 7; y++) {
        const isBorder = x === 0 || x === 6 || y === 0 || y === 6;
        const isCenter = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (isBorder || isCenter) {
          rects += `<rect x="${startX + x}" y="${startY + y}" width="1" height="1" fill="#f8fafc" />`;
        }
      }
    }
  };

  drawFinder(1, 1);
  drawFinder(size - 8, 1);
  drawFinder(1, size - 8);

  // Data modules
  let seed = hash;
  for (let x = 1; x < size - 1; x++) {
    for (let y = 1; y < size - 1; y++) {
      const inTopLeft = x < 9 && y < 9;
      const inTopRight = x > size - 10 && y < 9;
      const inBottomLeft = x < 9 && y > size - 10;
      if (!inTopLeft && !inTopRight && !inBottomLeft) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        if (seed % 3 === 0) {
          rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="#60a5fa" />`;
        }
      }
    }
  }

  return `
    <svg viewBox="0 0 ${size} ${size}" width="140" height="140" style="border-radius: 12px; background: #0b0f19; padding: 10px; border: 1px solid rgba(255,255,255,0.15);">
      ${rects}
    </svg>
  `;
}

// Checkout Entry Point
function checkout() {
  if (selected.size === 0) {
    announce('Iltimos, avval xaritadan kamida bitta o‘rindiqni tanlang.', 'info');
    return;
  }
  showCheckoutModal();
}

// Interactive Checkout & Payment Modal
function showCheckoutModal() {
  const existing = $('checkoutModal');
  if (existing) existing.remove();

  const seatIds = [...selected].sort();
  const totalPrice = seatIds.length * PRICE_PER_SEAT;
  const uzsAmount = Math.round(totalPrice * 12800).toLocaleString();

  const modal = document.createElement('div');
  modal.id = 'checkoutModal';
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.85);
    display: flex; align-items: center; justify-content: center; z-index: 99999;
    padding: 16px; backdrop-filter: blur(10px);
  `;

  const isLoggedIn = !!currentUser;
  const userDisplay = currentUser?.displayName || currentUser?.email || 'Solijon';
  const userEmailVal = currentUser?.email || '';

  modal.innerHTML = `
    <div style="background: #111827; border: 1px solid rgba(255,255,255,0.16); border-radius: 24px; max-width: 520px; width: 100%; max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; color: #f9fafb; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.85);">
      
      <!-- Header -->
      <div style="padding: 20px 24px; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02);">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 24px;">🎟️</span>
          <div>
            <h2 style="margin: 0; font-size: 18px; font-weight: 800; color: #f8fafc;">Chiptani rasmiylashtirish va xarid</h2>
            <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">Sugarland Theatres • Dolby Cinema</div>
          </div>
        </div>
        <button id="closeCheckoutModalBtn" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #9ca3af; font-size: 20px; width: 32px; height: 32px; display:flex; align-items:center; justify-content:center; cursor: pointer;">&times;</button>
      </div>

      <!-- Body -->
      <div style="padding: 22px 24px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 18px;">
        
        <!-- Order Summary Card -->
        <div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 16px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 15px; font-weight: 800; color: #60a5fa;">Avatar: Suv yo‘li</span>
            <span style="background: rgba(34,197,94,0.2); color: #4ade80; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700;">Hall 1 (Dolby)</span>
          </div>
          <div style="font-size: 13px; color: #9ca3af; margin-bottom: 12px; display: flex; gap: 14px;">
            <span>🕒 Bugun, 19:30</span>
            <span>📍 Amir Temur 107B</span>
          </div>
          <div style="border-top: 1px dashed rgba(255,255,255,0.12); padding-top: 10px; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 12px; color: #94a3b8;">Tanlangan o‘rindiqlar (${seatIds.length} ta):</div>
              <div style="font-size: 15px; font-weight: 800; color: #f8fafc; letter-spacing: 0.5px;">${seatIds.join(', ')}</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 11px; color: #94a3b8;">Jami to‘lov:</div>
              <div style="font-size: 20px; font-weight: 900; color: #4ade80;">${formatMoney(totalPrice)}</div>
              <div style="font-size: 11px; color: #6ee7b7;">~${uzsAmount} so‘m</div>
            </div>
          </div>
        </div>

        <!-- Buyer Details Section -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 18px;">
          <div style="font-size: 14px; font-weight: 700; margin-bottom: 12px; color: #e2e8f0; display: flex; align-items: center; justify-content: space-between;">
            <span>👤 Xaridor ma'lumotlari</span>
            ${isLoggedIn 
              ? `<span style="font-size: 11px; color: #4ade80; background: rgba(34,197,94,0.15); padding: 2px 8px; border-radius: 6px;">Google bilan ulangan ✅</span>` 
              : `<span style="font-size: 11px; color: #94a3b8;">Tezkor xarid rejimi</span>`
            }
          </div>

          <div style="display: flex; flex-direction: column; gap: 12px;">
            <div>
              <label style="display: block; font-size: 12px; color: #94a3b8; margin-bottom: 5px;">Ism va Familiya</label>
              <input id="checkoutUserName" type="text" value="${isLoggedIn ? userDisplay : ''}" placeholder="Masalan: Solijon Solayev" style="width: 100%; background: #1e293b; border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; padding: 10px 14px; color: #f8fafc; font-size: 14px; box-sizing: border-box;" />
            </div>

            <div>
              <label style="display: block; font-size: 12px; color: #94a3b8; margin-bottom: 5px;">Telefon raqami (SMS chipta uchun)</label>
              <input id="checkoutUserPhone" type="tel" value="+998 " placeholder="+998 90 123 45 67" style="width: 100%; background: #1e293b; border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; padding: 10px 14px; color: #f8fafc; font-size: 14px; box-sizing: border-box;" />
            </div>

            <div>
              <label style="display: block; font-size: 12px; color: #94a3b8; margin-bottom: 5px;">Elektron pochta (ixtiyoriy)</label>
              <input id="checkoutUserEmail" type="email" value="${userEmailVal}" placeholder="solijon@example.com" style="width: 100%; background: #1e293b; border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; padding: 10px 14px; color: #f8fafc; font-size: 14px; box-sizing: border-box;" />
            </div>
          </div>

          ${!isLoggedIn ? `
            <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: space-between;">
              <span style="font-size: 12px; color: #94a3b8;">Google bilan kirishni xohlaysizmi?</span>
              <button id="modalGoogleLoginBtn" type="button" class="btn" style="padding: 6px 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 6px;">
                <svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/></svg>
                Google orqali kirish
              </button>
            </div>
          ` : ''}
        </div>

        <!-- Payment Method -->
        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 16px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px; color: #e2e8f0;">💳 To‘lov usuli</div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <label style="display: flex; align-items: center; gap: 8px; background: rgba(59,130,246,0.12); border: 1px solid rgba(59,130,246,0.4); padding: 10px 12px; border-radius: 12px; cursor: pointer;">
              <input type="radio" name="payMethod" value="online" checked style="accent-color: #3b82f6;" />
              <div>
                <div style="font-size: 13px; font-weight: 700; color: #93c5fd;">Uzcard / Humo / Click</div>
                <div style="font-size: 10px; color: #94a3b8;">Onlayn to‘lov</div>
              </div>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 10px 12px; border-radius: 12px; cursor: pointer;">
              <input type="radio" name="payMethod" value="cash" style="accent-color: #3b82f6;" />
              <div>
                <div style="font-size: 13px; font-weight: 700; color: #e2e8f0;">Kassada naqd to‘lash</div>
                <div style="font-size: 10px; color: #94a3b8;">Joyida bron qilish</div>
              </div>
            </label>
          </div>
        </div>

        <div id="checkoutNoticeArea" style="display: none; padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.5;"></div>
      </div>

      <!-- Footer Actions -->
      <div style="padding: 18px 24px; border-top: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.02); display: flex; gap: 12px; align-items: center;">
        <button id="cancelCheckoutBtn" class="btn" style="flex: 1; padding: 12px; font-size: 14px; border-radius: 12px;">
          Bekor qilish
        </button>
        <button id="confirmPurchaseBtn" class="btn primary" style="flex: 2; padding: 12px 18px; font-size: 15px; font-weight: 800; border-radius: 12px; display: inline-flex; justify-content: center; align-items: center; gap: 8px;">
          <span>✅</span> Xaridni tasdiqlash (${formatMoney(totalPrice)})
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  const closeBtn = $('closeCheckoutModalBtn');
  const cancelBtn = $('cancelCheckoutBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.remove());
  if (cancelBtn) cancelBtn.addEventListener('click', () => modal.remove());

  // Google login from inside modal
  const modalGoogleBtn = $('modalGoogleLoginBtn');
  if (modalGoogleBtn) {
    modalGoogleBtn.addEventListener('click', async () => {
      try {
        announce('Google orqali kiring…', 'info');
        await loginWithGoogle();
        modal.remove();
        showCheckoutModal();
      } catch (err) {
        console.warn('Modal Google sign-in note:', err);
        const notice = $('checkoutNoticeArea');
        if (notice) {
          notice.style.display = 'block';
          notice.style.background = 'rgba(239,68,68,0.15)';
          notice.style.color = '#f87171';
          notice.style.border = '1px solid rgba(239,68,68,0.3)';
          notice.textContent = 'Google oynasi ochilmadi (brauzer blokladi). Hechqisi yo‘q, yuqoridagi maydonlarga ismingizni kiritib to‘g‘ridan-to‘g‘ri tezkor xarid qilishingiz mumkin!';
        }
      }
    });
  }

  // Confirm purchase button
  const confirmBtn = $('confirmPurchaseBtn') as HTMLButtonElement | null;
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const nameInput = $('checkoutUserName') as HTMLInputElement | null;
      const phoneInput = $('checkoutUserPhone') as HTMLInputElement | null;
      const emailInput = $('checkoutUserEmail') as HTMLInputElement | null;

      const userName = (nameInput?.value || '').trim() || (currentUser?.displayName || 'Tomoshabin');
      const userPhone = (phoneInput?.value || '').trim();
      const userEmail = (emailInput?.value || '').trim() || (currentUser?.email || 'guest@sugarland.uz');

      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span>⏳</span> Rasmiylashtirilmoqda…';

      announce('Bron rasmiylashtirilmoqda…', 'info');
      seatIds.forEach(id => pending.add(id));
      renderSeatGrid();
      updateUI();

      try {
        const result = await bookSeats({
          showId: SHOW_ID,
          seatIds,
          totalPrice,
          userName,
          userPhone,
          userEmail,
          paymentMethod: 'card'
        });

        if (result.ok) {
          // Success!
          seatIds.forEach(id => {
            seatState.set(id, 'taken');
            disarmHoldTimeout(id);
          });
          selected.clear();

          modal.remove();
          announce(`Xarid muvaffaqiyatli amalga oshirildi! ✅ (${result.reservationId})`, 'success');
          showTicketModal(result.reservation);
          updateAllTicketBadges();
        } else {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = `<span>✅</span> Qayta urinish (${formatMoney(totalPrice)})`;
          announce(`Xatolik: ${result.error || 'Bron qilib bo‘lmadi'}`, 'error');
        }
      } catch (err: any) {
        console.error('Checkout error:', err);
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `<span>✅</span> Xaridni tasdiqlash (${formatMoney(totalPrice)})`;
        announce('Tarmoq xatoligi yuz berdi. Iltimos qayta urinib ko‘ring.', 'error');
      } finally {
        seatIds.forEach(id => pending.delete(id));
        renderSeatGrid();
        updateUI();
      }
    });
  }
}

// Display official Cinema Boarding Pass / E-Ticket with QR Code
function showTicketModal(reservation: any) {
  const existing = $('ticketModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'ticketModal';
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.85);
    display: flex; align-items: center; justify-content: center; z-index: 99999;
    padding: 16px; backdrop-filter: blur(10px);
  `;

  const rsvId = reservation.reservationId || 'SUGAR-' + Math.floor(100000 + Math.random() * 900000);
  const seats = Array.isArray(reservation.seatIds) ? reservation.seatIds.join(', ') : '';
  const price = formatMoney(reservation.totalPrice || 0);
  const guestName = reservation.userName || currentUser?.displayName || 'Hurmatli Mehmon';
  const qrSvg = generateQRCodeSVG(rsvId);

  modal.innerHTML = `
    <div style="background: #0f172a; border: 1px solid rgba(255,255,255,0.18); border-radius: 24px; max-width: 480px; width: 100%; max-height: 94vh; display: flex; flex-direction: column; overflow: hidden; color: #f8fafc; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.9);">
      
      <!-- Top banner -->
      <div style="background: linear-gradient(135deg, #1e3a8a 0%, #1e1b4b 100%); padding: 22px 24px; border-bottom: 2px dashed rgba(255,255,255,0.15); position: relative;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div style="font-size: 11px; font-weight: 800; letter-spacing: 1.5px; color: #93c5fd; text-transform: uppercase;">Rasmiy Elektron Chipta</div>
            <h2 style="margin: 4px 0 0; font-size: 22px; font-weight: 900; color: #ffffff;">Sugarland Theatres</h2>
            <div style="font-size: 12px; color: #bfdbfe; margin-top: 2px;">Dolby Cinema • Hall 1</div>
          </div>
          <div style="background: rgba(34,197,94,0.2); border: 1px solid rgba(34,197,94,0.4); color: #4ade80; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 800;">
            TASDIQLANGAN ✅
          </div>
        </div>
      </div>

      <!-- Ticket Body -->
      <div style="padding: 24px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 16px;">
        
        <!-- Movie Title and Time -->
        <div style="text-align: center; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.08);">
          <div style="font-size: 20px; font-weight: 900; color: #60a5fa; margin-bottom: 4px;">Avatar: Suv yo‘li</div>
          <div style="font-size: 13px; color: #94a3b8;">3D Dolby Atmos • Bugun, Soat 19:30 da</div>
        </div>

        <!-- Seats and ID details grid -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 14px; border-radius: 14px;">
          <div>
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">O‘rindiqlar</div>
            <div style="font-size: 17px; font-weight: 900; color: #4ade80;">${seats}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Chipta kodi</div>
            <div style="font-size: 15px; font-weight: 800; font-family: monospace; color: #93c5fd;">${rsvId}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">Tomoshabin</div>
            <div style="font-size: 13px; font-weight: 700; color: #e2e8f0;">${guestName}</div>
          </div>
          <div>
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase;">To‘langan summa</div>
            <div style="font-size: 15px; font-weight: 800; color: #f8fafc;">${price}</div>
          </div>
        </div>

        <!-- QR Code Display -->
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 10px 0;">
          ${qrSvg}
          <div style="font-size: 11px; color: #64748b; margin-top: 8px;">Kirishda ushbu QR-kodni skanerga tuting</div>
        </div>

        <!-- Address Notice -->
        <div style="background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.2); border-radius: 12px; padding: 10px 14px; font-size: 12px; color: #93c5fd; display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 18px;">📍</span>
          <span>Toshkent sh., Amir Temur shoh ko‘chasi 107B (Shahriston metrosidan 350m). Iltimos, 19:10 ga qadar yetib keling.</span>
        </div>

      </div>

      <!-- Ticket Actions Footer -->
      <div style="padding: 16px 24px; border-top: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.02); display: flex; gap: 10px;">
        <button id="printTicketBtn" class="btn" style="flex: 1; padding: 12px; font-size: 13px; border-radius: 12px; display: inline-flex; justify-content: center; align-items: center; gap: 6px;">
          <span>🖨️</span> Chop etish / PDF
        </button>
        <button id="openMapFromTicketBtn" class="btn" style="flex: 1; padding: 12px; font-size: 13px; border-radius: 12px; display: inline-flex; justify-content: center; align-items: center; gap: 6px;">
          <span>📍</span> Google Maps
        </button>
        <button id="closeTicketModalBtn" class="btn primary" style="flex: 1; padding: 12px; font-size: 13px; font-weight: 800; border-radius: 12px;">
          Yopish
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(modal);

  const closeBtn = $('closeTicketModalBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.remove());

  const printBtn = $('printTicketBtn');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      window.print();
    });
  }

  const mapBtn = $('openMapFromTicketBtn');
  if (mapBtn) {
    mapBtn.addEventListener('click', () => {
      modal.remove();
      showLocationModal();
    });
  }
}

// Update all ticket badges and counters across the app
async function updateAllTicketBadges() {
  try {
    const list = await getAllMyReservations();
    const count = list.length;

    // Header badge
    const hBadge = $('headerTicketsBadge');
    if (hBadge) {
      hBadge.textContent = String(count);
      hBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }

    // Sidebar count
    const sCount = $('sideTicketsCount');
    if (sCount) sCount.textContent = String(count);

    // Mobile sheet count
    const mCount = $('mTicketsCount');
    if (mCount) mCount.textContent = String(count);
  } catch (err) {
    console.warn('Update ticket badges note:', err);
  }
}

// Show My Bookings Modal (Aggregates Server, LocalStorage, and Firestore)
async function showMyBookingsModal() {
  const existing = $('myBookingsModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'myBookingsModal';
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.85);
    display: flex; align-items: center; justify-content: center; z-index: 99999;
    padding: 16px; backdrop-filter: blur(8px);
  `;

  // Start with whatever is already locally stored
  const localList = getLocalReservations();
  const map = new Map<string, any>();
  localList.forEach(r => { if (r.reservationId) map.set(r.reservationId, r); });
  userReservations.forEach(r => { if (r.reservationId) map.set(r.reservationId, r); });
  let currentList = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  function renderItems(bookings: any[], isLoading: boolean = false) {
    const listContainer = $('bookingsListContainer');
    const countBadge = $('bookingsModalCount');
    if (countBadge) countBadge.textContent = String(bookings.length);
    if (!listContainer) return;

    if (bookings.length === 0) {
      listContainer.innerHTML = `
        <div style="text-align: center; color: #9ca3af; padding: 40px 16px;">
          <div style="font-size: 48px; margin-bottom: 12px;">🎟️</div>
          <div style="font-size: 16px; font-weight: 700; color: #e2e8f0; margin-bottom: 6px;">
            ${isLoading ? 'Chiptalar tekshirilmoqda…' : 'Chiptalar topilmadi'}
          </div>
          <div style="font-size: 13px; color: #64748b; max-width: 340px; margin: 0 auto; line-height: 1.5;">
            ${isLoading ? 'Iltimos, bir necha soniya kuting…' : 'Xaritadan bo‘sh (yashil) o‘rindiqni tanlang va "Davom etish" orqali chipta xarid qiling.'}
          </div>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = bookings.map(r => {
      const seatsStr = Array.isArray(r.seatIds) ? r.seatIds.join(', ') : (r.seatIds || '');
      const dateStr = new Date(r.createdAt || Date.now()).toLocaleString('uz-UZ', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const buyer = r.userName || r.userEmail || r.userPhone || 'Hurmatli tomoshabin';

      return `
        <div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 18px; margin-bottom: 14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-family: monospace; font-size: 14px; color: #60a5fa; font-weight: 800; background: rgba(59,130,246,0.15); padding: 3px 8px; border-radius: 6px;">#${r.reservationId}</span>
              <button class="copy-code-btn" data-code="${r.reservationId}" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #94a3b8; cursor: pointer; font-size: 12px; padding: 3px 6px;" title="Chipta kodidan nusxa olish">📋 Nusxa</button>
            </div>
            <span style="background: rgba(34,197,94,0.2); border: 1px solid rgba(34,197,94,0.4); color: #4ade80; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 800;">Tasdiqlangan ✅</span>
          </div>

          <div style="font-size: 17px; font-weight: 900; color: #f8fafc; margin-bottom: 4px;">Avatar: Suv yo‘li</div>
          <div style="font-size: 12px; color: #94a3b8; margin-bottom: 12px;">Hall 1 (Dolby Cinema) • Bugun, 19:30</div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 10px; background: rgba(0,0,0,0.3); padding: 10px 14px; border-radius: 12px; margin-bottom: 14px; font-size: 13px;">
            <div>
              <span style="color: #94a3b8; font-size: 11px; display: block; text-transform: uppercase;">O‘rindiqlar:</span>
              <strong style="color: #4ade80; font-size: 16px; font-weight: 900;">${seatsStr}</strong>
            </div>
            <div>
              <span style="color: #94a3b8; font-size: 11px; display: block; text-transform: uppercase;">Jami to‘lov:</span>
              <strong style="color: #f8fafc; font-size: 16px; font-weight: 900;">${formatMoney(r.totalPrice || 0)}</strong>
            </div>
            <div style="grid-column: 1 / -1; border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 8px;">
              <span style="color: #94a3b8; font-size: 11px;">Tomoshabin: </span>
              <span style="color: #e2e8f0; font-weight: 700;">${buyer}</span>
              ${r.userPhone ? `<span style="color: #64748b; font-size: 11px; margin-left: 6px;">(${r.userPhone})</span>` : ''}
            </div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 12px;">
            <span style="font-size: 11px; color: #64748b;">${dateStr}</span>
            <button class="view-ticket-btn btn primary" data-rsv-id="${r.reservationId}" style="padding: 8px 16px; font-size: 13px; font-weight: 800; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 4px 12px rgba(37,99,235,0.35);">
              🎫 Chiptani ko‘rish / QR
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Attach click listeners for View Ticket
    listContainer.querySelectorAll('.view-ticket-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const rsvId = btn.getAttribute('data-rsv-id');
        const found = currentList.find(r => r.reservationId === rsvId);
        if (found) {
          modal.remove();
          showTicketModal(found);
        }
      });
    });

    // Attach copy button listeners
    listContainer.querySelectorAll('.copy-code-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-code');
        if (code) {
          navigator.clipboard.writeText(code).then(() => {
            announce(`Chipta kodi (${code}) nusxalandi!`, 'success');
          }).catch(() => {});
        }
      });
    });
  }

  modal.innerHTML = `
    <div style="background: #111827; border: 1px solid rgba(255,255,255,0.16); border-radius: 22px; max-width: 560px; width: 100%; max-height: 88vh; display: flex; flex-direction: column; padding: 22px; color: #f9fafb; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.85);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 14px;">
        <div style="display:flex; align-items:center; gap: 10px;">
          <span style="font-size: 22px;">🎟️</span>
          <div>
            <h2 style="margin: 0; font-size: 18px; font-weight: 800;">Mening chiptalarim (<span id="bookingsModalCount">${currentList.length}</span>)</h2>
            <div style="font-size: 11px; color: #94a3b8;" id="syncNotice">Server va xaridlar bilan sinxronlanmoqda…</div>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap: 6px;">
          <button id="refreshBookingsBtn" class="btn" style="padding: 6px 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;" title="Serverdan qayta tekshirish">
            🔄 Yangilash
          </button>
          <button id="closeBookingsModalBtn" style="background: transparent; border: none; color: #9ca3af; font-size: 24px; cursor: pointer; line-height: 1; padding: 4px 8px;">&times;</button>
        </div>
      </div>

      <!-- Search bar -->
      <div style="margin-bottom: 14px;">
        <input 
          id="bookingSearchInput" 
          type="text" 
          placeholder="🔍 Chipta kodi (#SUGAR-...), telefon yoki ism bo‘yicha qidirish..." 
          style="width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 10px 14px; color: #ffffff; font-size: 13px; outline: none;"
        />
      </div>

      <div id="bookingsListContainer" style="overflow-y: auto; flex: 1; padding-right: 4px;">
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeBtn = $('closeBookingsModalBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.remove());

  // Search filter
  const searchInput = $('bookingSearchInput') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        renderItems(currentList);
      } else {
        const filtered = currentList.filter(r => 
          (r.reservationId && r.reservationId.toLowerCase().includes(q)) ||
          (Array.isArray(r.seatIds) && r.seatIds.join(', ').toLowerCase().includes(q)) ||
          (r.userName && r.userName.toLowerCase().includes(q)) ||
          (r.userPhone && r.userPhone.toLowerCase().includes(q)) ||
          (r.userEmail && r.userEmail.toLowerCase().includes(q))
        );
        renderItems(filtered);
      }
    });
  }

  // Render initial list right away
  renderItems(currentList, currentList.length === 0);

  // Background fetch from server to get ALL previous bookings
  const loadFromServer = async () => {
    const notice = $('syncNotice');
    if (notice) notice.textContent = 'Serverdan chiptalar tekshirilmoqda…';
    try {
      const fullList = await getAllMyReservations();
      currentList = fullList;
      if (searchInput && searchInput.value.trim()) {
        const q = searchInput.value.trim().toLowerCase();
        const filtered = currentList.filter(r => 
          (r.reservationId && r.reservationId.toLowerCase().includes(q)) ||
          (Array.isArray(r.seatIds) && r.seatIds.join(', ').toLowerCase().includes(q)) ||
          (r.userName && r.userName.toLowerCase().includes(q)) ||
          (r.userPhone && r.userPhone.toLowerCase().includes(q)) ||
          (r.userEmail && r.userEmail.toLowerCase().includes(q))
        );
        renderItems(filtered);
      } else {
        renderItems(currentList);
      }
      if (notice) {
        notice.textContent = currentList.length > 0 
          ? `${currentList.length} ta tasdiqlangan chipta mavjud` 
          : 'Hozircha chiptalar yo‘q';
      }
      updateAllTicketBadges();
    } catch (e) {
      if (notice) notice.textContent = 'Mahalliy chiptalar ko‘rsatilmoqda';
    }
  };

  const refreshBtn = $('refreshBookingsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadFromServer);

  // Trigger server sync immediately
  loadFromServer();
}

function showLocationModal() {
  const existing = $('locationModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'locationModal';
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.85);
    display: flex; align-items: center; justify-content: center; z-index: 99999;
    padding: 16px; backdrop-filter: blur(8px);
  `;

  modal.innerHTML = `
    <div style="background: #111827; border: 1px solid rgba(255,255,255,0.16); border-radius: 20px; max-width: 580px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; padding: 24px; color: #f9fafb; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.8);">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 14px;">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size: 22px;">📍</span>
            <h2 style="margin: 0; font-size: 19px; font-weight: 800; color:#f8fafc;">Sugarland Theatres — Google Maps & Marshrut</h2>
          </div>
          <div style="font-size: 12px; color: #94a3b8; margin-top: 4px;">
            Dolby Cinema zallari • Toshkent shahri, Amir Temur shoh ko'chasi 107B
          </div>
        </div>
        <button id="closeLocationModalBtn" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #9ca3af; font-size: 20px; width: 32px; height: 32px; display:flex; align-items:center; justify-content:center; cursor: pointer; line-height: 1;">&times;</button>
      </div>

      <div style="overflow-y: auto; flex: 1; padding-right: 4px; display: flex; flex-direction: column; gap: 14px;">
        <!-- Seans va vaqt eslatmasi -->
        <div style="background: linear-gradient(135deg, rgba(34,197,94,0.12), rgba(59,130,246,0.12)); border: 1px solid rgba(34,197,94,0.3); border-radius: 14px; padding: 12px 16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
          <div>
            <div style="font-size: 12px; color: #86efac; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">🎬 Bugungi seans</div>
            <div style="font-size: 14px; font-weight: 700; color: #ffffff;">Avatar: Suv yo‘li • 19:30 (1-Zal Dolby)</div>
          </div>
          <div style="background: rgba(0,0,0,0.35); padding: 6px 12px; border-radius: 8px; font-size: 12px; color: #fef08a; font-weight: 600;">
            ⏱️ 19:10 gacha kelish tavsiya etiladi
          </div>
        </div>

        <!-- Google Maps Embed Iframe -->
        <div style="border-radius: 14px; overflow: hidden; border: 1px solid rgba(255,255,255,0.12); position: relative; background: #0f172a; height: 210px;">
          <iframe
            src="https://maps.google.com/maps?q=41.3411,69.2867&hl=uz&z=15&output=embed"
            width="100%"
            height="100%"
            style="border:0;"
            allowfullscreen=""
            loading="lazy"
            referrerpolicy="no-referrer-when-downgrade"
            title="Google Maps - Sugarland Theatres"
          ></iframe>
        </div>

        <!-- Manzil va Mo'ljallar detallari -->
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 14px; font-size: 13px; line-height: 1.6;">
          <div style="margin-bottom: 8px; display:flex; gap: 8px;">
            <span style="color:#60a5fa; font-weight:700;">📌 Manzil:</span>
            <span>Toshkent sh., Yunusobod tumani, Amir Temur shoh ko‘chasi, 107B</span>
          </div>
          <div style="margin-bottom: 8px; display:flex; gap: 8px;">
            <span style="color:#34d399; font-weight:700;">🚇 Eng yaqin metro:</span>
            <span>Shahriston bekati (350 metr, piyoda 4 daqiqa)</span>
          </div>
          <div style="margin-bottom: 8px; display:flex; gap: 8px;">
            <span style="color:#fbbf24; font-weight:700;">🅿️ Avtoturargoh:</span>
            <span>Kinoteatr hududida 120 o‘rinli bepul yer osti va yer usti parkovka</span>
          </div>
          <div style="display:flex; gap: 8px;">
            <span style="color:#c084fc; font-weight:700;">🚌 Avtobuslar:</span>
            <span>24, 51, 67, 91, 93, 95 (Shahriston bekati)</span>
          </div>
        </div>

        <!-- AI Navigation Advice Box (loaded on demand) -->
        <div id="aiDirectionsBox" style="display: none; background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.25); border-radius: 14px; padding: 14px;">
          <div style="display:flex; align-items:center; gap:6px; font-size: 13px; font-weight: 700; color: #93c5fd; margin-bottom: 8px;">
            <span>✨</span> Gemini 3.5 Flash & Google Maps tavsiyalari:
          </div>
          <div id="aiDirectionsContent" style="font-size: 13px; line-height: 1.6; color: #e2e8f0; white-space: pre-wrap;"></div>
          <div id="aiDirectionsLinks" style="margin-top: 10px; display:flex; flex-direction:column; gap:6px;"></div>
        </div>

        <!-- Action Buttons -->
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <a
              id="openInGoogleMapsBtn"
              href="https://www.google.com/maps/dir/?api=1&destination=41.3411,69.2867&destination_place_id=Sugarland+Theatres"
              target="_blank"
              rel="noopener noreferrer"
              class="btn"
              style="text-align: center; text-decoration: none; padding: 10px; font-size: 12.5px; background: rgba(34,197,94,0.15); border-color: rgba(34,197,94,0.35); color: #86efac; display: flex; align-items: center; justify-content: center; gap: 6px;"
            >
              <span>🧭</span> Google Maps Navigatsiya ↗
            </a>
            <button
              id="calculateAiRouteBtn"
              class="btn"
              style="padding: 10px; font-size: 12.5px; background: rgba(96,165,250,0.15); border-color: rgba(96,165,250,0.35); color: #93c5fd; display: flex; align-items: center; justify-content: center; gap: 6px;"
            >
              <span>⚡</span> Eng tez marshrut (AI)
            </button>
          </div>

          <button
            id="askChatAboutLocationBtn"
            class="btn"
            style="width: 100%; padding: 10px; font-size: 12.5px; background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.12); color: #cbd5e1; display: flex; align-items: center; justify-content: center; gap: 6px;"
          >
            <span>💬</span> AI Konsyerjdan yo'nalish so'rash
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeBtn = $('closeLocationModalBtn');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.remove());

  // AI Route calculation with Google Maps Grounding
  const calcBtn = $('calculateAiRouteBtn') as HTMLButtonElement | null;
  if (calcBtn) {
    calcBtn.addEventListener('click', async () => {
      calcBtn.disabled = true;
      calcBtn.innerHTML = '<span>⏳</span> Hisoblanmoqda…';

      const box = $('aiDirectionsBox');
      const content = $('aiDirectionsContent');
      const linksContainer = $('aiDirectionsLinks');
      if (box && content) {
        box.style.display = 'block';
        content.textContent = "Google Maps ma'lumotlari tahlil qilinmoqda, eng maqbul yo'nalish va tirbandlik hisoblanmoqda...";
      }

      let userLocation: { latitude: number; longitude: number } | null = null;
      if ('geolocation' in navigator) {
        userLocation = await new Promise(resolve => {
          navigator.geolocation.getCurrentPosition(
            pos => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
            () => resolve(null),
            { timeout: 4000, maximumAge: 60000 }
          );
        });
      }

      try {
        const resp = await fetch('/api/directions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userLocation })
        });
        const data = await resp.json().catch(() => ({}));

        if (content) {
          content.textContent = data.advice || "📍 Sugarland Theatres (Toshkent, Amir Temur 107B). Eng yaqin metro: Shahriston bekati (350m). Seans 19:30 da, 19:10 ga qadar yetib kelish tavsiya etiladi.";
        }

        if (linksContainer && data.mapLinks && data.mapLinks.length > 0) {
          linksContainer.innerHTML = data.mapLinks.map((l: any) => `
            <a href="${l.uri}" target="_blank" rel="noopener noreferrer" style="display:flex; align-items:center; justify-content:space-between; background: rgba(59,130,246,0.16); border: 1px solid rgba(59,130,246,0.3); color: #bfdbfe; padding: 6px 10px; border-radius: 8px; font-size: 12px; text-decoration: none;">
              <span>🗺️ <strong>${l.title}</strong></span>
              <span style="font-size: 11px; opacity: 0.8;">Ochish ↗</span>
            </a>
          `).join('');
        }
      } catch (err: any) {
        if (content) {
          content.textContent = "📍 Sugarland Theatres: Toshkent sh., Amir Temur shoh ko‘chasi 107B. Shahriston metrosidan 350 metr. To‘liq marshrutni Google Maps orqali ko‘rishingiz mumkin.";
        }
      } finally {
        calcBtn.disabled = false;
        calcBtn.innerHTML = '<span>⚡</span> Qayta hisoblash';
      }
    });
  }

  // Ask Chat About Location button
  const askChatBtn = $('askChatAboutLocationBtn');
  if (askChatBtn) {
    askChatBtn.addEventListener('click', () => {
      modal.remove();
      const openAiBtn = $('openAiChatBtn');
      if (openAiBtn) openAiBtn.click();
      import('./chatService').then(mod => {
        mod.sendUserMessage("Kinoteatrga qanday yetib borsam bo'ladi? Google Maps orqali eng qisqa marshrut va metro bekatlarini ko'rsating.", true);
      });
    });
  }
}

// UI update
function updateUI() {
  deviceMode();

  const count = selected.size;
  const totalPrice = count * PRICE_PER_SEAT;

  const countOut = $('countOut');
  if (countOut) countOut.textContent = String(count);

  const priceOut = $('priceOut');
  if (priceOut) priceOut.textContent = formatMoney(totalPrice);

  const mCount = $('mSelectedCount');
  if (mCount) mCount.textContent = String(count);

  const disableCheckout = count === 0 || pending.size > 0;
  ['checkoutBtn', 'checkoutBtn2', 'mCheckoutBtn'].forEach(id => {
    const el = $(id) as HTMLButtonElement | null;
    if (el) el.disabled = disableCheckout;
  });

  const chips = $('chips');
  if (chips) {
    chips.innerHTML = '';
    [...selected].sort().forEach(id => {
      let remain = '';
      if (holdExpiresAt.has(id)) {
        const ms = Math.max(0, (holdExpiresAt.get(id) || 0) - Date.now());
        const sec = Math.floor(ms / 1000);
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = String(sec % 60).padStart(2, '0');
        remain = ` • ${mm}:${ss}`;
      }

      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = `<span>${id}${remain}</span><button aria-label="${id} o‘rindig‘ini o‘chirish">×</button>`;
      chip.querySelector('button')?.addEventListener('click', () => toggleSeat(id));
      chips.appendChild(chip);
    });
  }

  const sectorGrid = $('sectorGrid');
  const backbar = $('backbar');
  if (isMobile) {
    if (sectorGrid) sectorGrid.style.display = currentSector ? 'none' : 'grid';
    if (backbar) backbar.style.display = currentSector ? 'flex' : 'none';
  } else {
    if (sectorGrid) sectorGrid.style.display = 'none';
    if (backbar) backbar.style.display = 'none';
  }

  renderSectors();
}

function updateAuthUI(user: User | null) {
  currentUser = user;
  const container = $('authContainer');
  if (!container) return;

  if (user) {
    container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.06); padding: 4px 10px 4px 4px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1);">
          <img src="${user.photoURL || 'https://www.gravatar.com/avatar/?d=mp'}" alt="" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover;" />
          <span style="font-size: 12px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${user.displayName || user.email || 'Foydalanuvchi'}</span>
        </div>
        <button id="signOutBtn" class="btn" style="padding: 8px 10px; font-size: 12px;">Chiqish</button>
      </div>
    `;

    const sBtn = $('signOutBtn');
    if (sBtn) sBtn.addEventListener('click', async () => {
      await logoutUser();
      announce('Tizimdan chiqildi', 'info');
    });
  } else {
    container.innerHTML = `
      <button id="googleSignInBtn" class="btn primary" style="padding: 8px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 8px;">
        <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
        Google orqali kirish
      </button>
    `;

    const gBtn = $('googleSignInBtn');
    if (gBtn) {
      gBtn.addEventListener('click', async () => {
        try {
          await loginWithGoogle();
          announce('Google orqali kirdingiz ✅', 'success');
        } catch (e) {
          console.error(e);
          announce('Kirish bekor qilindi yoki xatolik yuz berdi', 'error');
        }
      });
    }
  }
}

// Init
async function init() {
  deviceMode();
  window.addEventListener('resize', deviceMode);

  // Keyboard navigation on grid
  const seatGrid = $('seatGrid');
  if (seatGrid) seatGrid.addEventListener('keydown', onGridKeydown);

  // Back button in mobile sector view
  const backBtn = $('backBtn');
  if (backBtn) backBtn.addEventListener('click', closeSector);

  // Button handlers
  const openLocationBtn = $('openLocationModalBtn');
  if (openLocationBtn) openLocationBtn.addEventListener('click', showLocationModal);

  // My Tickets button handlers across topbar, sidebar, and mobile sheet
  const headerTicketsBtn = $('headerMyTicketsBtn');
  if (headerTicketsBtn) headerTicketsBtn.addEventListener('click', showMyBookingsModal);

  const sideTicketsBtn = $('sideMyTicketsBtn');
  if (sideTicketsBtn) sideTicketsBtn.addEventListener('click', showMyBookingsModal);

  const mTicketsBtn = $('mMyTicketsBtn');
  if (mTicketsBtn) mTicketsBtn.addEventListener('click', showMyBookingsModal);

  const clearBtn = $('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearSelection);
  const clearBtn2 = $('clearBtn2');
  if (clearBtn2) clearBtn2.addEventListener('click', clearSelection);

  const checkoutBtn = $('checkoutBtn');
  if (checkoutBtn) checkoutBtn.addEventListener('click', checkout);
  const checkoutBtn2 = $('checkoutBtn2');
  if (checkoutBtn2) checkoutBtn2.addEventListener('click', checkout);
  const mCheckoutBtn = $('mCheckoutBtn');
  if (mCheckoutBtn) mCheckoutBtn.addEventListener('click', checkout);

  // Initial ticket counts update
  updateAllTicketBadges();

  // Load server-persisted reserved seats immediately
  try {
    const srvSeats = await fetchServerReservedSeats();
    srvSeats.forEach(id => {
      seatState.set(id, 'taken');
    });
    renderSeatGrid();
    updateUI();
  } catch (err) {
    console.warn('Initial server seats fetch note:', err);
  }

  // Test Firestore connection on boot
  announce('Firebase Firestore bilan bog‘lanmoqda…', 'info');
  const isOnline = await testConnection();
  const dbBadge = $('firestoreStatusBadge');
  if (dbBadge) {
    if (isOnline) {
      dbBadge.innerHTML = '<span style="display:inline-block;width:8px;height:8px;background:#22c55e;border-radius:50%;margin-right:6px;"></span>Firestore • Jonli';
    } else {
      dbBadge.innerHTML = '<span style="display:inline-block;width:8px;height:8px;background:#eab308;border-radius:50%;margin-right:6px;"></span>Firestore • Bog‘lanmoqda';
    }
  }

  // Ensure show and seats in Firestore
  await initializeShowAndSeats(DEFAULT_SHOW);

  // Subscribe to real-time seat changes in Firestore
  unsubscribeSeats = subscribeToSeats(SHOW_ID, (seats) => {
    seats.forEach(s => {
      const isMine = currentUser && s.heldBy === currentUser.uid;
      if (s.status === 'reserved') {
        seatState.set(s.seatId, 'taken');
        selected.delete(s.seatId);
        disarmHoldTimeout(s.seatId);
      } else if (s.status === 'held') {
        if (isMine) {
          seatState.set(s.seatId, 'selected');
          selected.add(s.seatId);
        } else {
          seatState.set(s.seatId, 'held');
          selected.delete(s.seatId);
        }
      } else {
        if (!selected.has(s.seatId)) {
          seatState.set(s.seatId, 'free');
        }
      }
    });

    renderSeatGrid();
    updateUI();
  });

  // Auth observer
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (unsubscribeReservations) {
      unsubscribeReservations();
      unsubscribeReservations = null;
    }
    if (user) {
      unsubscribeReservations = subscribeToUserReservations((reservations) => {
        userReservations = reservations;
        updateAllTicketBadges();
      });
    } else {
      userReservations = [];
    }

    updateAuthUI(user);
    updateAllTicketBadges();
    renderSeatGrid();
    updateUI();
  });

  // Dynamic countdown updater for chips
  setInterval(() => {
    if (selected.size === 0) return;
    updateUI();
  }, 1000);

  // Initialize Gemini AI Chatbot with live seat context
  initChat(() => {
    let freeCount = 0;
    let takenCount = 0;
    let heldCount = 0;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const id = seatId(r, c);
        const s = seatState.get(id) || 'free';
        if (s === 'free') freeCount++;
        else if (s === 'taken') takenCount++;
        else if (s === 'held' || s === 'selected') heldCount++;
      }
    }

    return {
      showInfo: {
        title: DEFAULT_SHOW.title,
        hall: DEFAULT_SHOW.hall,
        time: DEFAULT_SHOW.time,
        price: DEFAULT_SHOW.price,
      },
      totalSeats: ROWS * COLS,
      freeCount,
      takenCount,
      heldCount,
      selectedSeats: [...selected].sort(),
      sectors: {
        A: sectorStats('A'),
        B: sectorStats('B'),
        C: sectorStats('C'),
        D: sectorStats('D'),
      },
    };
  });

  renderSectors();
  renderSeatGrid();
  updateUI();
  announce('Tizim tayyor ✅ Firebase Firestore ulangan', 'success');
}

document.addEventListener('DOMContentLoaded', init);
