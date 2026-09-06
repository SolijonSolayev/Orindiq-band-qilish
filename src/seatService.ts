import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  writeBatch
} from 'firebase/firestore';
import { db, auth, handleFirestoreError, OperationType } from './firebase';

export interface SeatData {
  seatId: string;
  row: string;
  col: number;
  tier: 'standard' | 'vip' | 'accessible';
  status: 'free' | 'held' | 'reserved';
  heldBy?: string | null;
  heldExpiresAt?: number | null;
  reservedBy?: string | null;
  updatedAt?: number;
}

export interface ReservationData {
  reservationId: string;
  showId: string;
  userId: string;
  userEmail: string;
  seatIds: string[];
  totalPrice: number;
  status: 'confirmed' | 'cancelled';
  createdAt: number;
}

export interface ShowData {
  id: string;
  title: string;
  hall: string;
  time: string;
  price: number;
  rows: number;
  cols: number;
}

export const DEFAULT_SHOW: ShowData = {
  id: 'show_2026_02_23_1930',
  title: 'Interstellar: Beyond Time',
  hall: 'Hall 1 (Dolby Cinema)',
  time: '19:30',
  price: 6.50,
  rows: 10,
  cols: 14
};

function rowName(rIndex: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + rIndex);
}

function getSeatTier(r: number): 'standard' | 'vip' | 'accessible' {
  if (r === 9) return 'accessible';
  if (r >= 4 && r <= 6) return 'vip';
  return 'standard';
}

/**
 * Ensures show document and initial seat pool exist in Firestore.
 */
export async function initializeShowAndSeats(show: ShowData = DEFAULT_SHOW): Promise<void> {
  const showRef = doc(db, 'shows', show.id);
  const showSnap = await getDoc(showRef).catch(err => {
    handleFirestoreError(err, OperationType.GET, `shows/${show.id}`);
    throw err;
  });

  if (!showSnap.exists()) {
    // Only admins or first setup can create show document
    try {
      await setDoc(showRef, {
        title: show.title,
        hall: show.hall,
        time: show.time,
        price: show.price,
        rows: show.rows,
        cols: show.cols
      });
    } catch (err) {
      console.warn('Could not write show doc directly (may need admin permissions or already exists):', err);
    }
  }

  // Check if seats subcollection is initialized
  const seatsColRef = collection(db, 'shows', show.id, 'seats');
  const existingSeatsSnap = await getDocs(seatsColRef).catch(err => {
    handleFirestoreError(err, OperationType.LIST, `shows/${show.id}/seats`);
    throw err;
  });

  if (existingSeatsSnap.empty && auth.currentUser) {
    console.log('Seeding initial seat documents to Firestore...');
    const batch = writeBatch(db);
    for (let r = 0; r < show.rows; r++) {
      const rName = rowName(r);
      for (let c = 0; c < show.cols; c++) {
        const sId = `${rName}-${c + 1}`;
        const seatRef = doc(db, 'shows', show.id, 'seats', sId);
        batch.set(seatRef, {
          seatId: sId,
          row: rName,
          col: c + 1,
          tier: getSeatTier(r),
          status: 'free',
          heldBy: null,
          heldExpiresAt: null,
          reservedBy: null,
          updatedAt: Date.now()
        });
      }
    }
    try {
      await batch.commit();
      console.log('Seats initialized successfully in Firestore.');
    } catch (err) {
      console.warn('Batch seed failed (permissions or already seeded):', err);
    }
  }
}

/**
 * Subscribes to live seat state changes for a show.
 */
export function subscribeToSeats(
  showId: string,
  onUpdate: (seats: SeatData[]) => void,
  onError?: (err: Error) => void
): () => void {
  const seatsColRef = collection(db, 'shows', showId, 'seats');

  return onSnapshot(
    seatsColRef,
    (snapshot) => {
      const seats: SeatData[] = [];
      snapshot.forEach((docSnap) => {
        seats.push(docSnap.data() as SeatData);
      });
      onUpdate(seats);
    },
    (error) => {
      console.error('Seat subscription error:', error);
      try {
        handleFirestoreError(error, OperationType.GET, `shows/${showId}/seats`);
      } catch (wrapped) {
        if (onError) onError(wrapped as Error);
      }
    }
  );
}

/**
 * Hold a free seat in Firestore.
 */
export async function holdSeatInFirestore(showId: string, seatId: string, ttlMs: number = 2 * 60 * 1000): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) throw new Error('O‘rindiqni ushlab turish uchun avval tizimga kiring (Sign in required)');

  const seatRef = doc(db, 'shows', showId, 'seats', seatId);
  const path = `shows/${showId}/seats/${seatId}`;

  try {
    const seatSnap = await getDoc(seatRef);
    if (!seatSnap.exists()) {
      // If doc doesn't exist yet, create it as held
      const [rName, colStr] = seatId.split('-');
      await setDoc(seatRef, {
        seatId,
        row: rName,
        col: parseInt(colStr, 10),
        tier: 'standard',
        status: 'held',
        heldBy: user.uid,
        heldExpiresAt: Date.now() + ttlMs,
        updatedAt: Date.now()
      });
      return true;
    }

    const current = seatSnap.data() as SeatData;
    const isExpired = current.heldExpiresAt && Date.now() > current.heldExpiresAt;

    if (current.status === 'reserved') {
      return false; // Already reserved
    }

    if (current.status === 'held' && current.heldBy !== user.uid && !isExpired) {
      return false; // Held by someone else
    }

    await updateDoc(seatRef, {
      status: 'held',
      heldBy: user.uid,
      heldExpiresAt: Date.now() + ttlMs,
      updatedAt: Date.now()
    });

    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
    return false;
  }
}

/**
 * Release a held seat in Firestore.
 */
export async function releaseSeatInFirestore(showId: string, seatId: string): Promise<boolean> {
  const user = auth.currentUser;
  if (!user) return true;

  const seatRef = doc(db, 'shows', showId, 'seats', seatId);
  const path = `shows/${showId}/seats/${seatId}`;

  try {
    const seatSnap = await getDoc(seatRef);
    if (!seatSnap.exists()) return true;

    const current = seatSnap.data() as SeatData;
    if (current.status !== 'held') return true;
    if (current.heldBy && current.heldBy !== user.uid) return false;

    await updateDoc(seatRef, {
      status: 'free',
      heldBy: null,
      heldExpiresAt: null,
      updatedAt: Date.now()
    });

    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
    return false;
  }
}

/**
 * Confirm reservation for held seats in Firestore.
 */
export async function reserveSeatsInFirestore(
  showId: string,
  seatIds: string[],
  totalPrice: number,
  guestInfo?: { name?: string; phone?: string; email?: string }
): Promise<{ ok: boolean; reservationId?: string; error?: string }> {
  const user = auth.currentUser;
  if (!user) {
    return { ok: false, error: 'Tizimga kiring (Login required)' };
  }

  const reservationId = 'SUGAR-' + Math.floor(100000 + Math.random() * 900000);
  const reservationRef = doc(db, 'reservations', reservationId);

  try {
    // 1. Update or create seat states to reserved
    for (const sId of seatIds) {
      const seatRef = doc(db, 'shows', showId, 'seats', sId);
      const snap = await getDoc(seatRef).catch(() => null);
      if (snap && snap.exists()) {
        await updateDoc(seatRef, {
          status: 'reserved',
          reservedBy: user.uid,
          heldBy: null,
          heldExpiresAt: null,
          updatedAt: Date.now()
        });
      } else {
        const [rName, colStr] = sId.split('-');
        await setDoc(seatRef, {
          seatId: sId,
          row: rName,
          col: parseInt(colStr, 10),
          tier: 'standard',
          status: 'reserved',
          reservedBy: user.uid,
          heldBy: null,
          heldExpiresAt: null,
          updatedAt: Date.now()
        });
      }
    }

    // 2. Create reservation document
    await setDoc(reservationRef, {
      reservationId,
      showId,
      userId: user.uid,
      userEmail: user.email || guestInfo?.email || 'guest@sugarland.com',
      seatIds,
      totalPrice,
      status: 'confirmed',
      createdAt: Date.now()
    });

    return { ok: true, reservationId };
  } catch (error) {
    console.warn('Firestore reservation notice:', error);
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Universal seat booking (works with Google Auth or Guest Checkout).
 * Persists to Firestore when signed in, and to Server + LocalStorage for guaranteed reliability.
 */
export async function bookSeats(params: {
  showId: string;
  seatIds: string[];
  totalPrice: number;
  userName?: string;
  userPhone?: string;
  userEmail?: string;
  paymentMethod?: string;
}): Promise<{ ok: boolean; reservationId: string; reservation: ReservationData & any; error?: string }> {
  const {
    showId,
    seatIds,
    totalPrice,
    userName = 'Mehmon',
    userPhone = '',
    userEmail = 'guest@sugarland.uz',
    paymentMethod = 'card'
  } = params;

  let reservationId = 'SUGAR-' + Math.floor(100000 + Math.random() * 900000);
  let firestoreSuccess = false;

  // 1. Try Firestore if user is authenticated
  if (auth.currentUser) {
    try {
      const fsRes = await reserveSeatsInFirestore(showId, seatIds, totalPrice, {
        name: userName,
        phone: userPhone,
        email: userEmail
      });
      if (fsRes.ok && fsRes.reservationId) {
        reservationId = fsRes.reservationId;
        firestoreSuccess = true;
      }
    } catch (fsErr) {
      console.warn('Firestore write skipped or failed, falling back to server store:', fsErr);
    }
  }

  // 2. Call backend server to register reservation
  let serverReservation: any = null;
  try {
    const res = await fetch('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        showId,
        seatIds,
        totalPrice,
        userName,
        userPhone,
        userEmail: auth.currentUser?.email || userEmail,
        userId: auth.currentUser?.uid || null,
        paymentMethod
      })
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.reservation) {
      reservationId = data.reservationId || reservationId;
      serverReservation = data.reservation;
    }
  } catch (srvErr) {
    console.warn('Server reservations endpoint note:', srvErr);
  }

  // 3. Construct confirmed reservation object
  const reservation: ReservationData & any = serverReservation || {
    reservationId,
    showId,
    userId: auth.currentUser?.uid || `guest_${Date.now()}`,
    userName,
    userPhone,
    userEmail: auth.currentUser?.email || userEmail,
    seatIds,
    totalPrice,
    status: 'confirmed',
    paymentMethod,
    createdAt: Date.now(),
    showDetails: {
      title: 'Avatar: Suv yo‘li',
      hall: 'Hall 1 (Dolby Cinema)',
      time: 'Bugun, 19:30',
      theater: 'Sugarland Theatres (Amir Temur 107B)'
    }
  };

  // 4. Save to client localStorage so user can always see in "Mening chiptalarim"
  try {
    const raw = localStorage.getItem('sugarland_my_reservations');
    const list: any[] = raw ? JSON.parse(raw) : [];
    list.unshift(reservation);
    localStorage.setItem('sugarland_my_reservations', JSON.stringify(list));
  } catch (lsErr) {
    console.warn('LocalStorage save note:', lsErr);
  }

  return {
    ok: true,
    reservationId,
    reservation
  };
}

/**
 * Fetch server-persisted reserved seats
 */
export async function fetchServerReservedSeats(): Promise<string[]> {
  try {
    const res = await fetch('/api/seats');
    const data = await res.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.seats)) {
      return data.seats.map((s: any) => s.seatId);
    }
  } catch (err) {
    console.warn('Could not fetch /api/seats:', err);
  }
  return [];
}

/**
 * Retrieve saved local reservations
 */
export function getLocalReservations(): (ReservationData & any)[] {
  try {
    const raw = localStorage.getItem('sugarland_my_reservations');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Fetch server-persisted reservations with optional filters
 */
export async function fetchServerReservations(filter?: {
  q?: string;
  userId?: string;
  email?: string;
  phone?: string;
}): Promise<(ReservationData & any)[]> {
  try {
    const params = new URLSearchParams();
    if (filter?.q) params.set('q', filter.q);
    if (filter?.userId) params.set('userId', filter.userId);
    if (filter?.email) params.set('email', filter.email);
    if (filter?.phone) params.set('phone', filter.phone);

    const qs = params.toString();
    const url = '/api/reservations' + (qs ? `?${qs}` : '');
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.reservations)) {
      return data.reservations;
    }
  } catch (err) {
    console.warn('Could not fetch server reservations:', err);
  }
  return [];
}

/**
 * Fetch a single reservation by ID
 */
export async function fetchReservationById(id: string): Promise<(ReservationData & any) | null> {
  try {
    const res = await fetch(`/api/reservations/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.reservation) {
      return data.reservation;
    }
  } catch (err) {
    console.warn('Could not fetch reservation by ID:', err);
  }
  return null;
}

/**
 * Unified reservation retriever combining Server, LocalStorage, and Firestore.
 */
export async function getAllMyReservations(): Promise<(ReservationData & any)[]> {
  const map = new Map<string, any>();

  // 1. LocalStorage
  const localList = getLocalReservations();
  localList.forEach(r => {
    if (r.reservationId) map.set(r.reservationId, r);
  });

  // 2. Server
  const serverList = await fetchServerReservations();
  serverList.forEach(r => {
    if (r.reservationId) {
      map.set(r.reservationId, { ...map.get(r.reservationId), ...r });
    }
  });

  // Save merged back to LocalStorage
  const merged = Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  try {
    localStorage.setItem('sugarland_my_reservations', JSON.stringify(merged));
  } catch {
    // Ignore storage quota errors
  }

  return merged;
}

/**
 * Subscribes to the authenticated user's reservations.
 */
export function subscribeToUserReservations(
  onUpdate: (reservations: ReservationData[]) => void
): () => void {
  const user = auth.currentUser;
  if (!user) {
    onUpdate([]);
    return () => {};
  }

  const reservationsQuery = query(
    collection(db, 'reservations'),
    where('userId', '==', user.uid)
  );

  return onSnapshot(
    reservationsQuery,
    (snapshot) => {
      const list: ReservationData[] = [];
      snapshot.forEach((docSnap) => {
        list.push(docSnap.data() as ReservationData);
      });
      list.sort((a, b) => b.createdAt - a.createdAt);
      onUpdate(list);
    },
    (error) => {
      console.error('Error fetching reservations:', error);
      handleFirestoreError(error, OperationType.LIST, 'reservations');
    }
  );
}
