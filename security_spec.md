# Security Specification: Sugarland Theatres Seat Booking

## 1. Data Invariants
1. Shows are publicly viewable by anyone. Show metadata modification is reserved for administrators or initialization.
2. Seat records (`/shows/{showId}/seats/{seatId}`) are readable by everyone for real-time seat mapping.
3. Seat holds can only be acquired or released by authenticated users. A user may only release a seat they currently hold, or acquire a seat that is free or whose hold has expired.
4. Users cannot mark seats as "reserved" directly unless creating a matching atomic reservation. Reserved seats cannot be overwritten by other users.
5. Reservations (`/reservations/{reservationId}`) can only be created by the authenticated owner (`userId == request.auth.uid`).
6. Users may only list and read their own reservations (`resource.data.userId == request.auth.uid`).
7. Reservations cannot be deleted or forged with mismatched user identities.

## 2. The "Dirty Dozen" Payloads
1. **Payload 1 (Ghost Field Injection in Reservation)**: `{ reservationId: "r1", showId: "s1", userId: "attacker", seatIds: ["A-1"], totalPrice: 10, status: "confirmed", createdAt: 12345, isAdminOverride: true }` -> REJECTED (Unauthorized keys).
2. **Payload 2 (Identity Spoofing in Reservation)**: User A creates reservation with `userId: "user_B"` -> REJECTED (`userId != request.auth.uid`).
3. **Payload 3 (ID Poisoning Attack)**: Document ID of size > 128 characters or non-alphanumeric chars -> REJECTED (`isValidId` check fails).
4. **Payload 4 (Seat Hold Hijack)**: User B attempts to release seat held by User A -> REJECTED (`heldBy != request.auth.uid`).
5. **Payload 5 (Denial of Wallet Oversized Array)**: Reservation with 500 seat IDs -> REJECTED (`seatIds.size() <= 20`).
6. **Payload 6 (Unauthenticated Reservation Creation)**: Unauthenticated client tries to write to `/reservations/r1` -> REJECTED (`request.auth == null`).
7. **Payload 7 (List Snooping on Other Users' Reservations)**: User A queries `/reservations` where `userId == "user_B"` -> REJECTED (`resource.data.userId == request.auth.uid`).
8. **Payload 8 (Invalid Status Transition)**: Updating seat status to an arbitrary string `"hacked"` -> REJECTED (`status in ['free', 'held', 'reserved']`).
9. **Payload 9 (Forging System/Admin Fields)**: Updating show document pricing directly as regular user -> REJECTED (Read-only for public/regular users).
10. **Payload 10 (Reservation Price Tampering / Negative Price)**: Reservation created with `totalPrice: -50` -> REJECTED (`totalPrice >= 0`).
11. **Payload 11 (Empty Seat Array Booking)**: Reservation created with `seatIds: []` -> REJECTED (`seatIds.size() > 0`).
12. **Payload 12 (Direct Deletion of Confirmed Reservation)**: User tries to delete `/reservations/r1` directly -> REJECTED (`allow delete: if false`).

## 3. Test Runner
Implemented in `firestore.rules.test.ts`.
