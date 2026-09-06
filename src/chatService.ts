export interface MapLink {
  title: string;
  uri: string;
  placeAnswerSources?: any;
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  mapLinks?: MapLink[];
}

export interface ChatSeatContext {
  showInfo: {
    title: string;
    hall: string;
    time: string;
    price: number;
  };
  totalSeats: number;
  freeCount: number;
  takenCount: number;
  heldCount: number;
  selectedSeats: string[];
  sectors: {
    A: { free: number; taken: number; held: number };
    B: { free: number; taken: number; held: number };
    C: { free: number; taken: number; held: number };
    D: { free: number; taken: number; held: number };
  };
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);

let chatHistory: ChatMessage[] = [];
let isGenerating = false;
let getContextFn: (() => ChatSeatContext) | null = null;

async function getUserCoords(): Promise<{ latitude: number; longitude: number } | null> {
  if (!('geolocation' in navigator)) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 3500, enableHighAccuracy: false, maximumAge: 60000 }
    );
  });
}

function formatMarkdown(text: string): string {
  // Escape HTML first
  let safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold **text**
  safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong style="color: #f8fafc;">$1</strong>');
  // Italic *text*
  safe = safe.replace(/\*([^\*]+)\*/g, '<em>$1</em>');
  // Inline code / badges
  safe = safe.replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.12); padding: 2px 6px; border-radius: 4px; font-family: monospace; color: #93c5fd; font-size: 12px;">$1</code>');
  // Bullet lists
  safe = safe.replace(/(?:^|<br>)[-*•]\s+([^\n<]+)/g, '<li style="margin-left: 18px; margin-bottom: 4px; list-style-type: disc;">$1</li>');
  // Numbered lists
  safe = safe.replace(/(?:^|<br>)(\d+)\.\s+([^\n<]+)/g, '<li style="margin-left: 18px; margin-bottom: 4px; list-style-type: decimal;">$2</li>');
  // Newlines
  safe = safe.replace(/\n\n/g, '<div style="height: 8px;"></div>');
  safe = safe.replace(/\n/g, '<br>');
  return safe;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function openChat() {
  const modal = $('chatModal');
  const launcher = $('chatLauncherBtn');
  if (modal) {
    modal.classList.add('active');
    modal.style.display = 'flex';
    setTimeout(() => {
      const input = $('chatInput') as HTMLInputElement | null;
      if (input) input.focus();
    }, 150);
  }
  if (launcher) {
    launcher.classList.add('chat-open');
  }
  scrollToBottom();
}

export function closeChat() {
  const modal = $('chatModal');
  const launcher = $('chatLauncherBtn');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
  if (launcher) {
    launcher.classList.remove('chat-open');
  }
}

export function clearChat() {
  chatHistory = [];
  // Re-add greeting
  addModelMessage(
    "Salom! Men **Sugarland Theatres** kinoteatrining sun'iy intellekt yordamchisiman (Gemini 3.5/3.8 Flash va Google Maps ma'lumotlari bilan ishlayman). Sizga quyidagilar bo‘yicha yordam beraman:\n" +
    "- 📍 **Manzil va yetib borish**: Google Maps orqali kinoteatrga eng tez marshrut, metro (Shahriston), avtomobil tirbandligi va seansga (19:30) o'z vaqtida yetib kelish bo'yicha maslahatlar.\n" +
    "- 💺 **O'rindiqlar holati**: Qaysi sektor va qatorlar bo'sh yoki band, zal markazi.\n" +
    "- 🎫 **Bron qilish yo'riqnomasi**: Joy tanlash, 2 daqiqalik hold va tasdiqlash.\n" +
    "- 💰 **Narx va seanslar**: $6.50 narx, Dolby Atmos zallari va boshqa qo‘shimcha savollar.\n\n" +
    "Savolingiz bormi? Quyidagi tugmalardan birini bosing yoki bemalol yozing!"
  );
  renderMessages();
}

function scrollToBottom() {
  const container = $('chatMessages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderMessages() {
  const container = $('chatMessages');
  if (!container) return;

  container.innerHTML = '';

  chatHistory.forEach(msg => {
    const item = document.createElement('div');
    item.className = `chat-msg ${msg.role}`;

    const isUser = msg.role === 'user';
    
    let mapsHtml = '';
    if (!isUser && msg.mapLinks && msg.mapLinks.length > 0) {
      mapsHtml = `
        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.12);">
          <div style="font-size: 11px; font-weight: 700; color: #93c5fd; margin-bottom: 6px; display:flex; align-items:center; gap:5px;">
            <span>📍</span> Google Maps havolalari va joylashuv:
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${msg.mapLinks.map(l => `
              <a href="${l.uri}" target="_blank" rel="noopener noreferrer" style="display: inline-flex; align-items: center; justify-content: space-between; background: rgba(59,130,246,0.14); border: 1px solid rgba(59,130,246,0.32); color: #bfdbfe; padding: 7px 11px; border-radius: 8px; font-size: 12px; text-decoration: none; transition: all 0.15s ease;">
                <span style="display:flex; align-items:center; gap: 6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                  <span>🗺️</span> <strong>${l.title}</strong>
                </span>
                <span style="font-size: 11px; opacity: 0.85; margin-left:8px; white-space:nowrap; color: #60a5fa;">Google Maps da ochish ↗</span>
              </a>
            `).join('')}
          </div>
        </div>
      `;
    }

    item.innerHTML = `
      <div class="msg-bubble ${isUser ? 'user-bubble' : 'model-bubble'}">
        ${!isUser ? '<div class="msg-sender"><span class="gemini-icon">✨</span> Sugarland AI (Google Maps)</div>' : ''}
        <div class="msg-content">${isUser ? msg.content.replace(/</g, '&lt;').replace(/>/g, '&gt;') : formatMarkdown(msg.content)}</div>
        ${mapsHtml}
        <div class="msg-time">${formatTime(msg.timestamp)}</div>
      </div>
    `;

    container.appendChild(item);
  });

  if (isGenerating) {
    const typing = document.createElement('div');
    typing.className = 'chat-msg model';
    typing.innerHTML = `
      <div class="msg-bubble model-bubble typing-bubble">
        <div class="msg-sender"><span class="gemini-icon">✨</span> Sugarland AI</div>
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
        <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">Gemini va Google Maps ma'lumotlarni tekshirmoqda…</div>
      </div>
    `;
    container.appendChild(typing);
  }

  scrollToBottom();
}

function addUserMessage(text: string) {
  chatHistory.push({
    role: 'user',
    content: text,
    timestamp: Date.now()
  });
  renderMessages();
}

function addModelMessage(text: string, mapLinks?: MapLink[]) {
  chatHistory.push({
    role: 'model',
    content: text,
    timestamp: Date.now(),
    mapLinks
  });
  renderMessages();
}

export async function sendUserMessage(text: string, forceUseMaps = false) {
  const trimmed = text.trim();
  if (!trimmed || isGenerating) return;

  addUserMessage(trimmed);

  const input = $('chatInput') as HTMLInputElement | null;
  if (input) input.value = '';

  isGenerating = true;
  renderMessages();

  // Prepare payload for /api/chat
  const seatContext = getContextFn ? getContextFn() : null;

  // Retrieve user location if permitted
  const userLocation = await getUserCoords();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: chatHistory.map(m => ({
          role: m.role,
          content: m.content
        })),
        seatContext,
        userLocation,
        useMaps: forceUseMaps
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || `Server xatosi (${response.status})`);
    }

    const data = await response.json();
    const reply = data.reply || "Kechirasiz, javob olishda xatolik yuz berdi.";
    addModelMessage(reply, data.mapLinks);
  } catch (err: any) {
    console.warn('Chat request fallback activated:', err);
    addModelMessage(
      `📍 **Sugarland Theatres yordamchisi**:\n\nKinoteatrimiz Toshkent shahri, Amir Temur shoh ko‘chasi 107B (Shahriston metro bekati yaqinida) joylashgan.\nBugungi asosiy seans: **"Avatar: Suv yo‘li"** soat **19:30** da (Hall 1, Dolby Cinema).\nStandart chipta narxi: **$6.50**.\n\nO‘rindiqni bron qilish uchun xaritadan bo‘sh (yashil) joyni tanlang va pastdagi **"Davom etish"** tugmasini bosing!`,
      [
        {
          title: 'Google Maps da marshrutni ochish',
          uri: 'https://www.google.com/maps/search/?api=1&query=Sugarland+Theatres+Amir+Temur+Toshkent'
        }
      ]
    );
  } finally {
    isGenerating = false;
    renderMessages();
  }
}

export function initChat(getContextCallback: () => ChatSeatContext) {
  getContextFn = getContextCallback;

  // Toggle & open buttons
  const launcher = $('chatLauncherBtn');
  if (launcher) {
    launcher.addEventListener('click', () => {
      const modal = $('chatModal');
      if (modal && modal.style.display === 'flex') {
        closeChat();
      } else {
        openChat();
      }
    });
  }

  const topOpenBtn = $('openAiChatBtn');
  if (topOpenBtn) {
    topOpenBtn.addEventListener('click', openChat);
  }

  // Close & Clear buttons
  const closeBtn = $('closeChatBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeChat);

  const clearBtn = $('clearChatBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearChat);

  // Send form
  const form = $('chatForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('chatInput') as HTMLInputElement | null;
      if (input && input.value) {
        sendUserMessage(input.value);
      }
    });
  }

  // Quick suggestion chips
  const chips = document.querySelectorAll('.chat-chip');
  chips.forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = (btn as HTMLElement).dataset.prompt;
      if (prompt) {
        sendUserMessage(prompt);
      }
    });
  });

  // Initial greeting
  clearChat();
}
