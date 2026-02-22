# Sugarland Theatres — Seat Booking Prototype

## 🇺🇿 O‘zbekcha

Moslashuvchan (responsive) o‘rindiqlarni bron qilish interfeysi prototipi.  
To‘liq **HTML / CSS / JavaScript (vanilla)** asosida yozilgan, hech qanday framework ishlatilmagan.

### ✨ Xususiyatlar
- **Responsive dizayn**
  - Desktop/Tablet: to‘liq qator-ustun o‘rindiqlar xaritasi
  - Mobile: sektor ko‘rinishi + zoom rejimi
- **Accessibility (A11y)**
  - `Tab` → faqat grid containerga fokus
  - `← ↑ → ↓` → grid ichida harakatlanish
  - `Enter / Space` → o‘rindiq tanlash
  - `Esc` → mobil rejimda sektorlar ro‘yxatiga qaytish
  - ARIA atributlar + live announce
- **Fake API qatlami**
  - `fetchSeatMap`
  - `holdSeat`
  - `releaseSeat`
  - `reserveSeats`
- **Optimistic UI + rollback**
  - Tanlash darhol ko‘rsatiladi
  - Server rad etsa avtomatik qaytariladi
- **Hold timeout (2 daqiqa)**
  - Tanlangan o‘rindiqlar 2 daqiqadan keyin avtomatik bo‘shaydi

### ▶ Ishga tushirish
Hech qanday build kerak emas.  
Faylni brauzerda oching:

```
sugarland_seat_booking_prototype.html
```

### ℹ Eslatma
Bu **UI prototip** hisoblanadi.  
Real backendga ulash uchun `<script>` ichidagi `api` blokini real API so‘rovlari bilan almashtirish kifoya.

---

## 🇬🇧 English

Responsive seat booking UI prototype built with **vanilla HTML, CSS, and JavaScript**.  
No frameworks, no build tools required.

### ✨ Features
- **Responsive layout**
  - Desktop/Tablet: full seat grid (rows & columns)
  - Mobile: sector-based view with zoom interaction
- **Accessibility (A11y)**
  - `Tab` → focus enters grid container only
  - `Arrow keys` → navigate inside grid
  - `Enter / Space` → select/unselect seat
  - `Esc` → exit sector view (mobile)
  - ARIA roles + live announcements
- **Fake API layer**
  - `fetchSeatMap`
  - `holdSeat`
  - `releaseSeat`
  - `reserveSeats`
- **Optimistic UI + rollback**
  - Immediate UI feedback
  - Automatic rollback on API failure/conflict
- **Hold timeout (2 minutes)**
  - Selected seats auto-release after timeout

### ▶ Run
No installation required.  
Open the file directly in a browser:

```
sugarland_seat_booking_prototype.html
```

### ℹ Note
This is a **UI prototype**.  
To integrate with a real backend, replace the `api` block in the script with actual API calls.
