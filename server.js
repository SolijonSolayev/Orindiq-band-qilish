const express = require('express');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

app.use(express.json());

// Lazy-initialized Gemini AI client
let aiClient = null;
function getAI() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not configured');
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

function isQuotaOrRateLimitError(err) {
  if (!err) return false;
  const str = String(err.message || err.status || err.code || JSON.stringify(err) || '');
  return (
    str.includes('429') ||
    str.includes('RESOURCE_EXHAUSTED') ||
    str.includes('quota') ||
    str.includes('rate-limits') ||
    str.includes('rate limit') ||
    str.includes('exceeded your current quota')
  );
}

function generateChatFallback(queryText, seatContext, userLocation, isLocationQuery) {
  const q = (queryText || '').toLowerCase();
  let reply = '';
  let mapLinks = [];

  const defaultMapUrl = userLocation && userLocation.latitude && userLocation.longitude
    ? `https://www.google.com/maps/dir/?api=1&origin=${userLocation.latitude},${userLocation.longitude}&destination=41.3411,69.2867`
    : `https://www.google.com/maps/dir/?api=1&destination=41.3411,69.2867&destination_place_id=Sugarland+Theatres`;

  if (isLocationQuery || /manzil|qayerda|yetib|marshrut|yo'nalish|yo'l|xarita|maps|joylashuv|metro|avtobus|transport|tirbandlik/i.test(q)) {
    reply = `📍 **Sugarland Theatres kinoteatri manzili va yetib borish yo‘riqnomasi**:

🏛️ **Aniq manzil**: Toshkent shahri, Yunusobod tumani, Amir Temur shoh ko‘chasi, 107B (mo‘ljal: Shahriston metro bekati yonida, Teleminora ro‘parasi).

🎬 **Bugungi seans**: "Avatar: Suv yo‘li" — Soat **19:30** da (Hall 1, Dolby Cinema).
⏱️ **Tavsiya etilgan vaqt**: Zalda o'z o'rningizga qulay joylashish uchun soat **19:10** ga qadar kelishni maslahat beramiz.

🚇 **Jamoat transporti**:
- **Metro**: Shahriston bekati (Yunusobod yo‘nalishi). Chiqishdan kinoteatrgacha atigi **350 metr** (piyoda 4 daqiqa).
- **Avtobuslar**: 24, 51, 67, 91, 93, 95 (Shahriston bekati to'xtash joyi).

🚗 **Avtomobil va Parkovka**:
- Kinoteatr hududida tomoshabinlar uchun **120 o‘rinli bepul** xavfsiz avtoturargoh mavjud.
- Kechki tirbandliklarni hisobga olgan holda kamida 35-45 daqiqa oldin yo'lga chiqish maqsadga muvofiq.`;

    mapLinks = [
      {
        title: 'Google Maps da to‘liq navigatsiya marshrutini ochish',
        uri: defaultMapUrl
      },
      {
        title: 'Sugarland Theatres joylashuvi (Google Maps)',
        uri: 'https://www.google.com/maps/search/?api=1&query=Sugarland+Theatres+Amir+Temur+Toshkent'
      }
    ];
  } else if (/o'rindiq|joy|bo'sh|band|qaysi|zal|markaz|qator|sektor/i.test(q)) {
    const free = seatContext?.freeCount ?? 92;
    const taken = seatContext?.takenCount ?? 48;
    const held = seatContext?.heldCount ?? 0;
    const total = seatContext?.totalSeats ?? 140;

    reply = `💺 **Zal va o'rindiqlar holati (Dolby Cinema Hall 1)**:

- 🟢 **Bo'sh o'rindiqlar**: **${free} ta** (jami ${total} tadan)
- 🔴 **Band o'rindiqlar**: **${taken} ta**
${held > 0 ? `- 🟡 **Ayni paytda bron jarayonida (Hold)**: **${held} ta**\n` : ''}
🎯 **Eng yaxshi ko'rish nuqtalari**:
- Markaziy sektorlar: **D, E va F qatorlari, 6–9 o'rindiqlar**. Bu qatorlar Dolby Atmos akustikasi va lazer proyektorning to'liq rang berish markazida joylashgan.
- **Sektorlar holati**:
  * **Sektor A (Old-Chap)**: ${seatContext?.sectors?.A?.free ?? 'bo‘sh joylar bor'}
  * **Sektor B (Old-O‘ng)**: ${seatContext?.sectors?.B?.free ?? 'bo‘sh joylar bor'}
  * **Sektor C (Orqa-Chap)**: ${seatContext?.sectors?.C?.free ?? 'bo‘sh joylar bor'}
  * **Sektor D (Orqa-O‘ng)**: ${seatContext?.sectors?.D?.free ?? 'bo‘sh joylar bor'}

O'rindiqni tanlash uchun ekrandagi xaritadan mos o'rinni bosing!`;
  } else if (/bron|qanday|qilish|sotib|olish|to'lov|chizish|ticket/i.test(q)) {
    reply = `🎫 **O'rindiqni bron qilish bo'yicha bosqichma-bosqich qo'llanma**:

1. **O'rindiqni tanlang**: Zal xaritasidan o'zingizga ma'qul yashil (bo'sh) o'rindiqni bosing.
2. **2 daqiqalik Hold**: Tanlangan o'rindiq sariq rangga aylanadi va 2 daqiqaga faqat siz uchun saqlanadi (boshqa foydalanuvchilar uni egallay olmaydi).
3. **Google orqali kiring**: Yuqori paneldagi "Google orqali kirish" tugmasini bosing (agar hali kirmagan bo'lsangiz).
4. **Tasdiqlash**: Pastki paneldagi **"Davom etish"** (yoki "Bron qilish") tugmasini bosing.
5. **Chiptalar**: Muvaffaqiyatli bron qilingan chiptalaringiz "Mening bronlarim" bo'limida saqlanadi va bemalol kirish kodini ko'rishingiz mumkin!`;
  } else if (/narx|pul|so'm|dollar|price|cost|seans|vaqt|film|avatar/i.test(q)) {
    reply = `💰 **Chipta narxlari va seans ma'lumotlari**:

- 🎬 **Film**: "Avatar: Suv yo‘li"
- 🕐 **Seans vaqti**: Bugun soat **19:30**
- 🏛️ **Zal**: Hall 1 (Dolby Atmos surround audio, 4K Laser proyektor)
- 💵 **Standart narx**: **$6.50** (barcha sektorlar uchun yagona qulay narx)
- ⏳ **Hold vaqti**: O'rindiq tanlanganda 2 daqiqa ushlab turiladi. Agar shu vaqtda tasdiqlanmasa, o'rin avtomatik boshqalar uchun bo'shatiladi.`;
  } else {
    reply = `Salom! Men **Sugarland Theatres** kinoteatrining rasmiy AI yordamchisiman.

Sizga quyidagi ma'lumotlar bo'yicha yordam bera olaman:
- 📍 **Manzil va Marshrut**: Kinoteatrga yetib borish, Shahriston metrosi, Google Maps yo‘nalishlari va 19:30 seansiga o'z vaqtida kelish.
- 💺 **O'rindiqlar holati**: Zalning qaysi joylari bo'sh, eng qulay o'rinlar (D-F qatorlari).
- 🎫 **Bron qilish tartibi**: 2 daqiqalik hold va tasdiqlash bosqichlari.
- 💰 **Narx va seanslar**: $6.50 standart narx va Dolby Cinema afzalliklari.

Bemalol savolingizni bering yoki yuqoridagi tezkor tugmalardan foydalaning!`;
  }

  return { reply, mapLinks };
}

function generateDirectionsFallback(userLocation) {
  const hasCoords = userLocation && typeof userLocation.latitude === 'number' && typeof userLocation.longitude === 'number';
  
  const destUrl = hasCoords 
    ? `https://www.google.com/maps/dir/?api=1&origin=${userLocation.latitude},${userLocation.longitude}&destination=41.3411,69.2867`
    : `https://www.google.com/maps/dir/?api=1&destination=41.3411,69.2867&destination_place_id=Sugarland+Theatres`;

  const advice = `📍 **Sugarland Theatres (Dolby Cinema) Navigatsiya va Marshrut Yo'riqnomasi**:

🏛️ **Aniq manzil**: Toshkent shahri, Yunusobod tumani, Amir Temur shoh ko'chasi, 107B (mo'ljal: Shahriston metro bekati yaqinida, Teleminora ro'parasi).
🎬 **Bugungi asosiy seans**: "Avatar: Suv yo‘li" • Soat **19:30** da (1-Zal Dolby Cinema).

⏱️ **Tavsiya etilgan chiqish va yetib kelish vaqti**:
- Kinoteatr zaliga shoshilmasdan, popkorn va ichimliklar bilan qulay joylashish uchun soat **19:10** ga qadar (seansdan 20 daqiqa oldin) yetib kelish tavsiya etiladi.
- Kechki soat 18:30 dan 19:15 gacha Amir Temur shoh ko'chasida transport qatnovi tig'iz bo'ladi. Agar shahar markazi yoki boshqa tumanlardan kelayotgan bo'lsangiz, soat **18:40** dan kechikmay yo'lga chiqish maqsadga muvofiq.

🚇 **Jamoat transporti (Tirbandliksiz eng tez yo'l)**:
- **Metro**: Yunusobod yo'nalishi bo'ylab **"Shahriston" bekati**ga keling.
- Bekatdan chiqqach, kinoteatrgacha bor-yo'g'i **350 metr** (piyoda 4 daqiqa).
- **Avtobuslar**: 24, 51, 67, 91, 93, 95-marshrutlar (Shahriston bekati to'xtash joyi).

🚗 **Avtomobil va Taksi orqali**:
- Navigatorda: "Sugarland Theatres" yoki "Amir Temur shoh ko'chasi 107B" manzilini belgilang.
- Kinoteatr hududida tomoshabinlar uchun **120 o'rinli bepul** xavfsiz avtoturargoh (yer usti va yer osti) mavjud.`;

  return {
    advice,
    mapLinks: [
      {
        title: "Google Maps da to‘g‘ridan-to‘g‘ri jonli navigatsiyani ochish",
        uri: destUrl
      },
      {
        title: "Sugarland Theatres xaritadagi joylashuvi",
        uri: "https://www.google.com/maps/search/?api=1&query=Sugarland+Theatres+Amir+Temur+Toshkent"
      }
    ],
    destination: {
      name: 'Sugarland Theatres (Dolby Cinema)',
      address: 'Toshkent sh., Amir Temur shoh ko‘chasi, 107B',
      coords: { lat: 41.3411, lng: 69.2867 },
      metro: 'Shahriston bekati (350 metr)',
      showTime: '19:30',
      mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Sugarland+Theatres+Amir+Temur+Toshkent'
    }
  };
}

// Gemini Chat API endpoint for Sugarland Theatres assistant (with Maps Grounding support)
app.post('/api/chat', async (req, res) => {
  const { messages, seatContext, userLocation, useMaps } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const queryText = String(lastUserMsg?.content || '').toLowerCase();
  const isLocationQuery = useMaps || /manzil|qayerda|yetib bor|marshrut|yo'nalish|yo'l|xarita|maps|joylashuv|metro|avtobus|transport|tirbandlik|location|direction|address|route|where/i.test(queryText);

  try {
    let contextPrompt = `Siz "Sugarland Theatres" kinoteatrining o'rindiqlarni bron qilish tizimidagi rasmiy AI yordamchisiz (Sugarland AI Konsyerj).
Kinoteatr manzili: Sugarland Theatres (Dolby Cinema zallari), Toshkent shahri, Yunusobod tumani, Amir Temur shoh ko'chasi 107B (mo'ljal: Shahriston metro bekati yaqinida, Teleminora ro'parasida).
Bugungi seans: "Avatar: Suv yo‘li", bugun soat 19:30 da Hall 1 (Dolby Cinema) zalida.

Sizning asosiy vazifalaringiz:
1. Kinoteatr manzili va yetib borish:
   - Foydalanuvchilarga kinoteatr manzilini topish, jamoat transporti (metro: Shahriston bekati, avtobuslar) yoki avtomobil/taksi orqali qulay va o'z vaqtida (seansdan 15-20 daqiqa oldin) yetib kelish bo'yicha aniq yo'l-yo'riq bering.
   - Google Maps ma'lumotlaridan foydalanib, tirbandliklar va eng maqbul yo'nalishlarni tushuntiring.
2. O'rindiqlar holati haqida ma'lumot: Qaysi sektorlar (A, B, C, D) va qatorlar bo'sh, nechtasi band, qaysi joylar tomosha qilish uchun eng qulay (zal markazi: D-F qatorlari, 6-9 o'rindiqlar).
3. Bron qilish yo'riqnomasi:
   - Xaritadan o'rindiqni tanlash (2 daqiqalik hold).
   - Google orqali tizimga kirish va bronni tasdiqlash.
4. Narxlar: Standart chipta narxi $6.50.
Javoblaringizni xushmuomala, do'stona, aniq, chiroyli emoji va punktlar bilan o'zbek tilida taqdim eting.`;

    if (seatContext) {
      contextPrompt += `\n\n[Hozirgi real-time zal va o'rindiqlar holati]:
- Film: ${seatContext.showInfo?.title || 'Avatar: Suv yo‘li'} (Vaqt: ${seatContext.showInfo?.time || '19:30'}, Zal: ${seatContext.showInfo?.hall || 'Hall 1 (Dolby)'})
- Standart narx: $${seatContext.showInfo?.price || 6.50}
- Jami o'rindiqlar soni: ${seatContext.totalSeats || 140} ta (10 qator: A-J, har birida 14 ta o'rin)
- Hozir bo'sh o'rindiqlar: ${seatContext.freeCount ?? 'noma’lum'} ta
- Band o'rindiqlar: ${seatContext.takenCount ?? 'noma’lum'} ta
- Ushlab turilgan (Hold) o'rindiqlar: ${seatContext.heldCount ?? 'noma’lum'} ta
- Foydalanuvchi ayni paytda tanlagan o'rindiqlari: ${seatContext.selectedSeats?.length ? seatContext.selectedSeats.join(', ') : 'Hozircha hech narsa tanlanmagan'}
- Sektorlar bo'yicha bo'sh joylar:
  * Sektor A (Old-Chap): ${seatContext.sectors?.A?.free ?? '-'} ta bo'sh
  * Sektor B (Old-O'ng): ${seatContext.sectors?.B?.free ?? '-'} ta bo'sh
  * Sektor C (Orqa-Chap): ${seatContext.sectors?.C?.free ?? '-'} ta bo'sh
  * Sektor D (Orqa-O'ng): ${seatContext.sectors?.D?.free ?? '-'} ta bo'sh`;
    }

    const ai = getAI();

    // Map messages to Gemini contents structure
    const contents = messages.map(m => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.content || m.text || '') }]
    }));

    let response = null;
    let mapLinks = [];

    if (isLocationQuery) {
      const config = {
        tools: [{ googleMaps: {} }],
        systemInstruction: contextPrompt + `\nFoydalanuvchi kinoteatr manzilini so'ramoqda yoki yetib borish marshruti haqida qiziqmoqda. Google Maps ma'lumotlariga tayangan holda aniq manzil, yo'nalishlar, transport vositalari va 19:30 seansiga o'z vaqtida yetib borish vaqtini ko'rsating.`
      };

      if (userLocation && typeof userLocation.latitude === 'number' && typeof userLocation.longitude === 'number') {
        config.toolConfig = {
          retrievalConfig: {
            latLng: {
              latitude: Number(userLocation.latitude),
              longitude: Number(userLocation.longitude)
            }
          }
        };
      }

      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents,
          config,
        });
      } catch (mapsErr) {
        if (!isQuotaOrRateLimitError(mapsErr)) {
          try {
            response = await ai.models.generateContent({
              model: 'gemini-3.8-flash',
              contents,
              config: {
                systemInstruction: contextPrompt,
                temperature: 0.7,
              },
            });
          } catch (e) {
            console.warn('Maps retry failed:', e.message);
          }
        }
      }
    } else {
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash',
          contents,
          config: {
            systemInstruction: contextPrompt,
            temperature: 0.7,
          },
        });
      } catch (primaryErr) {
        if (!isQuotaOrRateLimitError(primaryErr)) {
          try {
            response = await ai.models.generateContent({
              model: 'gemini-3.5-flash',
              contents,
              config: {
                systemInstruction: contextPrompt,
                temperature: 0.7,
              },
            });
          } catch (e) {
            console.warn('Fallback retry failed:', e.message);
          }
        }
      }
    }

    if (response) {
      const replyText = response.text || '';
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const groundingChunks = groundingMetadata?.groundingChunks || [];

      if (Array.isArray(groundingChunks)) {
        for (const chunk of groundingChunks) {
          if (chunk.maps) {
            mapLinks.push({
              title: chunk.maps.title || 'Google Maps manzili',
              uri: chunk.maps.uri || '',
              placeAnswerSources: chunk.maps.placeAnswerSources || null,
            });
          } else if (chunk.web) {
            mapLinks.push({
              title: chunk.web.title || 'Google havolasi',
              uri: chunk.web.uri || '',
            });
          }
        }
      }

      if (isLocationQuery && mapLinks.length === 0) {
        mapLinks.push({
          title: 'Sugarland Theatres (Google Maps)',
          uri: 'https://www.google.com/maps/search/?api=1&query=Sugarland+Theatres+Amir+Temur+Toshkent'
        });
      }

      return res.json({
        reply: replyText,
        mapLinks,
        isLocationQuery
      });
    }

    // If Gemini was unreachable or quota was exhausted, seamlessly provide accurate domain fallback
    const fallback = generateChatFallback(queryText, seatContext, userLocation, isLocationQuery);
    return res.json({
      reply: fallback.reply,
      mapLinks: fallback.mapLinks,
      isLocationQuery
    });
  } catch (err) {
    console.warn('Gemini chat handled via fallback:', err.message || err);
    const fallback = generateChatFallback(queryText, seatContext, userLocation, isLocationQuery);
    return res.json({
      reply: fallback.reply,
      mapLinks: fallback.mapLinks,
      isLocationQuery
    });
  }
});

// Dedicated Directions & Route Advisor endpoint with Google Maps Grounding
app.post('/api/directions', async (req, res) => {
  const { userLocation } = req.body || {};

  try {
    const ai = getAI();
    const hasCoords = userLocation && typeof userLocation.latitude === 'number' && typeof userLocation.longitude === 'number';

    let userPrompt = `Foydalanuvchi "Sugarland Theatres" kinoteatriga (Toshkent shahri, Amir Temur shoh ko'chasi 107B) eng tez va o'z vaqtida yetib borishi uchun Google Maps ma'lumotlari asosida to'liq marshrut va transport yo'riqnomasini bering.
Bugungi asosiy seans: 19:30 da "Avatar: Suv yo‘li". Foydalanuvchi seansga kechikmasligi, o'rindiqlarni egallashi va qulay joylashishi uchun soat nechada yo'lga chiqishi kerak?
Transport turlari:
- Metro orqali (eng yaqin bekat: Shahriston yoki Bodomzor)
- Avtomobil / Taksi orqali (Tirbandlik holati, parkovka joylari)
- Piyoda yurish masofalari`;

    if (hasCoords) {
      userPrompt += `\nFoydalanuvchining ayni paytdagi koordinatalari: Latitude ${userLocation.latitude}, Longitude ${userLocation.longitude}. Shu nuqtadan kinoteatrgacha bo'lgan masofa va yo'nalishni hisoblang.`;
    }

    const config = {
      tools: [{ googleMaps: {} }],
      systemInstruction: "Siz Sugarland Theatres kinoteatrining professional Google Maps navigatsiya yordamchisisiz. Google Maps ma'lumotlaridan foydalanib, tomoshabinga kinoteatrga eng qulay, xavfsiz va o'z vaqtida yetib kelish yo'nalishini, metro va avtomobil marshrutlarini aniq ko'rsating."
    };

    if (hasCoords) {
      config.toolConfig = {
        retrievalConfig: {
          latLng: {
            latitude: Number(userLocation.latitude),
            longitude: Number(userLocation.longitude)
          }
        }
      };
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: userPrompt,
      config,
    });

    const replyText = response.text || '';
    const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
    const groundingChunks = groundingMetadata?.groundingChunks || [];

    const mapLinks = [];
    if (Array.isArray(groundingChunks)) {
      for (const chunk of groundingChunks) {
        if (chunk.maps) {
          mapLinks.push({
            title: chunk.maps.title || 'Google Maps marshruti',
            uri: chunk.maps.uri || '',
            placeAnswerSources: chunk.maps.placeAnswerSources || null,
          });
        }
      }
    }

    if (mapLinks.length === 0) {
      const destUrl = hasCoords 
        ? `https://www.google.com/maps/dir/?api=1&origin=${userLocation.latitude},${userLocation.longitude}&destination=41.3411,69.2867`
        : `https://www.google.com/maps/dir/?api=1&destination=41.3411,69.2867&destination_place_id=Sugarland+Theatres`;

      mapLinks.push({
        title: 'Google Maps da to‘liq marshrutni ochish',
        uri: destUrl
      });
    }

    return res.json({
      advice: replyText,
      mapLinks,
      destination: {
        name: 'Sugarland Theatres (Dolby Cinema)',
        address: 'Toshkent sh., Amir Temur shoh ko‘chasi, 107B',
        coords: { lat: 41.3411, lng: 69.2867 },
        metro: 'Shahriston bekati (350 metr)',
        showTime: '19:30',
        mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Sugarland+Theatres+Amir+Temur+Toshkent'
      }
    });
  } catch (err) {
    console.warn('Directions handled via fallback:', err.message || err);
    // Return high-quality, comprehensive navigation fallback with zero error to user
    const fallback = generateDirectionsFallback(userLocation);
    return res.json(fallback);
  }
});

// Persistent reservations store using JSON file on disk
const SHOW_ID = 'show_2026_02_23_1930';
const RESERVATIONS_FILE = path.join(__dirname, 'reservations_db.json');

let confirmedReservations = [];
const reservedSeatsMap = new Map();

// Initial taken seats for realistic cinema atmosphere
const INITIAL_TAKEN = [
  'A-4', 'A-5', 'B-6', 'B-7', 'B-8', 'C-3', 'C-4', 'C-10', 'C-11',
  'D-5', 'D-6', 'D-7', 'D-8', 'E-5', 'E-6', 'E-7', 'E-8', 'E-9',
  'F-6', 'F-7', 'F-8', 'G-3', 'G-4', 'H-7', 'H-8', 'I-1', 'I-2'
];
INITIAL_TAKEN.forEach(sId => reservedSeatsMap.set(sId, {
  seatId: sId,
  status: 'reserved',
  reservedBy: 'system',
  updatedAt: Date.now()
}));

// Load persisted reservations from disk
try {
  if (fs.existsSync(RESERVATIONS_FILE)) {
    const raw = fs.readFileSync(RESERVATIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      confirmedReservations = parsed;
      confirmedReservations.forEach(r => {
        if (Array.isArray(r.seatIds)) {
          r.seatIds.forEach(id => {
            reservedSeatsMap.set(id, {
              seatId: id,
              status: 'reserved',
              reservedBy: r.userId || 'guest',
              reservationId: r.reservationId,
              updatedAt: r.createdAt || Date.now()
            });
          });
        }
      });
      console.log(`[Database] Loaded ${confirmedReservations.length} persistent reservations from disk.`);
    }
  }
} catch (loadErr) {
  console.warn('[Database] Could not load reservations file, starting fresh:', loadErr.message);
}

function saveReservationsToDisk() {
  try {
    fs.writeFileSync(RESERVATIONS_FILE, JSON.stringify(confirmedReservations, null, 2), 'utf8');
  } catch (saveErr) {
    console.error('[Database] Failed to save reservations to disk:', saveErr.message);
  }
}

// GET /api/seats - Returns all reserved seats
app.get('/api/seats', (req, res) => {
  const seats = [];
  for (const [seatId, data] of reservedSeatsMap.entries()) {
    seats.push(data);
  }
  res.json({ ok: true, seats });
});

// GET /api/reservations - Returns confirmed reservations
app.get('/api/reservations', (req, res) => {
  const { userId, phone, email, q } = req.query;
  let list = [...confirmedReservations];

  if (q) {
    const queryStr = String(q).trim().toLowerCase();
    list = list.filter(r => 
      (r.reservationId && r.reservationId.toLowerCase().includes(queryStr)) ||
      (r.userName && r.userName.toLowerCase().includes(queryStr)) ||
      (r.userPhone && r.userPhone.includes(queryStr)) ||
      (r.userEmail && r.userEmail.toLowerCase().includes(queryStr))
    );
  } else if (userId) {
    list = list.filter(r => r.userId === userId);
  } else if (email) {
    list = list.filter(r => r.userEmail?.toLowerCase() === String(email).toLowerCase());
  } else if (phone) {
    list = list.filter(r => r.userPhone === phone);
  }

  res.json({ ok: true, reservations: list });
});

// GET /api/reservations/:id - Returns a single reservation by ID
app.get('/api/reservations/:id', (req, res) => {
  const targetId = req.params.id;
  const found = confirmedReservations.find(r => r.reservationId.toLowerCase() === targetId.toLowerCase());
  if (found) {
    return res.json({ ok: true, reservation: found });
  }
  return res.status(404).json({ ok: false, error: 'Chipta topilmadi' });
});

// POST /api/reservations - Confirm booking
app.post('/api/reservations', (req, res) => {
  try {
    const {
      showId = SHOW_ID,
      seatIds = [],
      totalPrice = 0,
      userName = 'Mehmon',
      userPhone = '',
      userEmail = 'guest@sugarland.uz',
      userId = null,
      paymentMethod = 'card'
    } = req.body;

    if (!Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'Kamida bitta o‘rindiq tanlanishi shart.' });
    }

    // Check if any seat is already booked
    const conflicts = seatIds.filter(id => reservedSeatsMap.has(id));
    if (conflicts.length > 0) {
      return res.status(409).json({
        ok: false,
        error: `Quyidagi o‘rindiq(lar) allaqachon band qilingan: ${conflicts.join(', ')}`
      });
    }

    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    const reservationId = `SUGAR-${randomSuffix}`;

    const reservation = {
      reservationId,
      showId,
      userId: userId || `guest_${Date.now()}`,
      userName,
      userPhone,
      userEmail,
      seatIds,
      totalPrice: Number(totalPrice),
      paymentMethod,
      status: 'confirmed',
      createdAt: Date.now(),
      showDetails: {
        title: 'Avatar: Suv yo‘li',
        hall: 'Hall 1 (Dolby Cinema)',
        time: 'Bugun, 19:30',
        theater: 'Sugarland Theatres (Amir Temur 107B)'
      }
    };

    seatIds.forEach(id => {
      reservedSeatsMap.set(id, {
        seatId: id,
        status: 'reserved',
        reservedBy: reservation.userId,
        reservationId,
        updatedAt: Date.now()
      });
    });

    confirmedReservations.unshift(reservation);
    saveReservationsToDisk();

    console.log(`[Reservation Confirmed] ID: ${reservationId}, Seats: ${seatIds.join(', ')}, User: ${userName} (${userPhone || userEmail})`);

    return res.json({
      ok: true,
      reservationId,
      reservation
    });
  } catch (err) {
    console.error('Reservation creation error:', err);
    return res.status(500).json({ ok: false, error: 'Bron qilishda server xatoligi yuz berdi.' });
  }
});

// Serve static assets from current directory
app.use(express.static(__dirname));

// Primary route serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

