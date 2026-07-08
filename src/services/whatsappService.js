const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const qrcode = require('qrcode');
const pino = require('pino');
const baileys = require('atexovi-baileys');
const ytSearch = require('yt-search');
const ffmpegPath = require('ffmpeg-static');

const customCommandStore = require('./customCommandStore');
const deletedMessageStore = require('./deletedMessageStore');
const { sendInteractiveButtons } = require('../lib/interactiveButtons');

const uploadDir = path.join(process.cwd(), 'uploads');
const tempDir = path.join(uploadDir, 'tmp');
const execFileAsync = promisify(execFile);

const makeWASocket = baileys.default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  normalizeMessageContent,
  downloadContentFromMessage,
} = baileys;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCommandPrefix(text) {
  return String(text || '').replace(/^[!.][^\s]+\s*/i, '').trim();
}

function normalizeInteractiveTrigger(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('.')) return raw;
  if (raw.startsWith('!')) return `.${raw.slice(1)}`;

  const cleaned = raw.replace(/^[^a-z0-9]+/, '');
  if (!cleaned) return '';
  return `.${cleaned}`;
}

function isLikelyUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch (error) {
    return false;
  }
}

function parseYouTubeInput(input) {
  try {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const isYoutubeHost = hostname === 'youtu.be'
      || hostname === 'youtube.com'
      || hostname === 'music.youtube.com'
      || hostname.endsWith('.youtube.com')
      || hostname.endsWith('youtube-nocookie.com');

    if (!isYoutubeHost) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    let videoId = '';

    if (hostname === 'youtu.be') {
      videoId = parts[0] || '';
    } else if (url.searchParams.get('v')) {
      videoId = url.searchParams.get('v') || '';
    } else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
      videoId = parts[1] || '';
    } else if (parts[0] && /^[a-zA-Z0-9_-]{11}$/.test(parts[0])) {
      videoId = parts[0];
    }

    if (videoId && !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      videoId = '';
    }

    return {
      videoId,
      playlistOnly: Boolean(url.searchParams.get('list')) && !videoId,
      canonicalUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : raw,
    };
  } catch (error) {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 30000) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function sanitizeFileName(value, fallback) {
  const clean = String(value || '').replace(/[\\/:*?"<>|]+/g, '').trim();
  return clean || fallback;
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function normalizeConnectedJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const atIndex = raw.indexOf('@');
  if (atIndex === -1) return raw;

  const localPart = raw.slice(0, atIndex);
  const domain = raw.slice(atIndex + 1);
  const cleanLocal = localPart.split(':')[0] || localPart;
  return `${cleanLocal}@${domain}`;
}

function extractPhoneFromJid(value) {
  const normalized = normalizeConnectedJid(value);
  if (!normalized) return '';
  const local = normalized.split('@')[0] || '';
  return local.replace(/\D/g, '');
}

function extractDownloadUrlFromPayload(data) {
  if (!data || typeof data !== 'object') return '';

  const candidates = [
    data?.downloadURL,
    data?.download_url,
    data?.dl,
    data?.url,
    data?.result?.url,
    data?.result?.download,
    data?.result?.dl,
    data?.result?.mp3,
    data?.result?.mp4,
    data?.result?.audio,
    data?.result?.video,
    data?.data?.url,
    data?.data?.download,
    data?.data?.download_url,
    data?.data?.dl,
    data?.data?.mp3,
    data?.data?.mp4,
  ];

  for (const candidate of candidates) {
    if (isHttpUrl(candidate)) return String(candidate).trim();
  }

  return '';
}

function extractAudioDownloadUrlFromPayload(data) {
  if (!data || typeof data !== 'object') return '';

  const candidates = [
    data?.audio,
    data?.audioUrl,
    data?.audio_url,
    data?.mp3,
    data?.result?.audio,
    data?.result?.audioUrl,
    data?.result?.audio_url,
    data?.result?.dl_audio,
    data?.result?.mp3,
    data?.result?.download?.audio,
    data?.result?.download?.mp3,
    data?.data?.audio,
    data?.data?.audioUrl,
    data?.data?.audio_url,
    data?.data?.dl_audio,
    data?.data?.mp3,
    data?.data?.download?.audio,
    data?.data?.download?.mp3,
  ];

  for (const candidate of candidates) {
    if (isHttpUrl(candidate)) return String(candidate).trim();
  }

  return extractDownloadUrlFromPayload(data);
}

function extractTitleFromPayload(data) {
  if (!data || typeof data !== 'object') return '';

  const candidates = [
    data?.title,
    data?.result?.title,
    data?.data?.title,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.qrCodeDataUrl = null;
    this.ready = false;
    this.lastStatus = 'Initializing...';
    this.reconnectTimer = null;
    this.isInitializing = false;
    this.reconnectAttempts = 0;
    this.initPromise = null;
    this.authPath = path.join(process.cwd(), '.baileys_auth');
    this.defaultDialCode = String(process.env.DEFAULT_DIAL_CODE || '60').replace(/\D/g, '') || '60';
    this.debugInteractive = process.env.WA_DEBUG_INTERACTIVE === '1';
    this.pairingCode = null;
    this.isRequestingPairingCode = false;
    this.store = null;
  }

  logInteractiveDebug(message, details = null) {
    if (!this.debugInteractive) return;

    if (details == null) {
      console.log(`[WA][interactive] ${message}`);
      return;
    }

    try {
      console.log(`[WA][interactive] ${message}:`, JSON.stringify(details));
    } catch (error) {
      console.log(`[WA][interactive] ${message}:`, details);
    }
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    if (this.isInitializing) return;

    this.isInitializing = true;
    this.lastStatus = 'Starting WhatsApp client...';

    this.initPromise = this.startSocket()
      .catch((error) => {
        this.lastStatus = `Initialization failed: ${error.message}`;
        this.ready = false;
        this.isInitializing = false;
        console.error('[WA] Initialization error:', error.message);
        this.scheduleReinitialize('initialize_error');
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  async startSocket() {
    fs.mkdirSync(this.authPath, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (error) {
      console.warn('[WA] Failed to fetch latest WA version, using fallback');
    }

    const socketLogger = pino({ level: 'silent' });
    if (!this.store) {
      this.store = makeInMemoryStore({ logger: socketLogger });
    }

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, socketLogger),
      },
      logger: socketLogger,
      browser: ['ScheduleBot', 'Desktop', '1.0.0'],
      printQRInTerminal: false,
      connectTimeoutMs: Number(process.env.WA_CONNECT_TIMEOUT_MS || 60000),
      keepAliveIntervalMs: 15000,
      defaultQueryTimeoutMs: Number(process.env.WA_QUERY_TIMEOUT_MS || 60000),
      version,
    });
    const currentSocket = this.sock;

    this.store.bind(currentSocket.ev);

    currentSocket.ev.on('creds.update', saveCreds);

    currentSocket.ev.on('messages.upsert', async (event) => {
      try {
        await this.handleIncomingMessages(event);
      } catch (error) {
        console.error('[WA] Failed to handle incoming message:', error.message);
      }
    });

    currentSocket.ev.on('messages.update', async (updates) => {
      try {
        await this.handleMessageUpdates(updates);
      } catch (error) {
        console.error('[WA] Failed to handle message update:', error.message);
      }
    });

    currentSocket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCodeDataUrl = await qrcode.toDataURL(qr);
        this.lastStatus = 'Scan QR from dashboard';
        this.ready = false;
        this.isInitializing = false;
      }

      if (connection === 'connecting' && !qr) {
        this.lastStatus = 'Connecting to WhatsApp...';
      }

      if (connection === 'open') {
        this.lastStatus = 'WhatsApp connected';
        const wasReady = this.ready;
        this.ready = true;
        this.isInitializing = false;
        this.reconnectAttempts = 0;
        this.qrCodeDataUrl = null;
        this.pairingCode = null;
        if (!wasReady) {
          console.log('[WA] Client ready');
        }
      }

      if (connection === 'close') {
        if (currentSocket !== this.sock) {
          return;
        }

        this.ready = false;
        this.isInitializing = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = this.describeDisconnectReason(statusCode);
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isAuthInvalid = statusCode === 405;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired;
        this.lastStatus = `Disconnected: ${disconnectReason}`;
        console.error('[WA] Disconnected event:', disconnectReason);

        if (isLoggedOut || isAuthInvalid) {
          try {
            fs.rmSync(this.authPath, { recursive: true, force: true });
            fs.mkdirSync(this.authPath, { recursive: true });
          } catch (error) {
            console.error('[WA] Failed to reset auth:', error.message);
          }
          this.qrCodeDataUrl = null;
          this.pairingCode = null;
          this.scheduleReinitialize(isAuthInvalid ? 'auth_invalid' : 'logged_out');
          return;
        }

        if (isRestartRequired) {
          this.scheduleReinitialize('restart_required', 0);
          return;
        }

        this.scheduleReinitialize('disconnected');
      }
    });
  }

  describeDisconnectReason(statusCode) {
    if (statusCode === DisconnectReason.restartRequired) return 'restart_required (515)';
    if (statusCode === DisconnectReason.connectionLost) return 'connection_lost (408)';
    if (statusCode === DisconnectReason.connectionClosed) return 'connection_closed (428)';
    if (statusCode === DisconnectReason.connectionReplaced) return 'connection_replaced (440)';
    if (statusCode === DisconnectReason.loggedOut) return 'logged_out (401)';
    if (statusCode === DisconnectReason.badSession) return 'bad_session (500)';
    if (statusCode === DisconnectReason.multideviceMismatch) return 'multidevice_mismatch (411)';
    if (statusCode === DisconnectReason.forbidden) return 'forbidden (403)';
    if (statusCode === 405) return 'auth_invalid (405)';
    if (statusCode === DisconnectReason.unavailableService) return 'unavailable_service (503)';
    return statusCode ? `unknown (${statusCode})` : 'unknown';
  }

  scheduleReinitialize(trigger, delayOverrideMs) {
    if (this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    const reconnectDelayMs = typeof delayOverrideMs === 'number'
      ? delayOverrideMs
      : Math.min(4000 * (2 ** (this.reconnectAttempts - 1)), 60000);

    this.lastStatus = `Reconnecting after ${trigger} in ${Math.round(reconnectDelayMs / 1000)}s...`;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const socketToClose = this.sock;
      this.sock = null;
      this.isInitializing = false;

      try {
        if (socketToClose) {
          socketToClose.end(new Error('reconnect'));
        }
      } catch (error) {
        console.error('[WA] End socket error:', error.message);
      }

      this.init();
    }, reconnectDelayMs);
  }

  getConnectionState() {
    const rawUser = this.sock?.user || null;
    const jid = normalizeConnectedJid(rawUser?.id || rawUser?.jid || '');
    const phoneNumber = extractPhoneFromJid(jid);
    const displayName = String(rawUser?.name || rawUser?.verifiedName || '').trim();

    return {
      ready: this.ready,
      status: this.lastStatus,
      qrCodeDataUrl: this.qrCodeDataUrl,
      pairingCode: this.pairingCode,
      connectedAccount: {
        jid,
        phoneNumber,
        displayName,
      },
    };
  }

  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      throw new Error('WhatsApp client is not ready yet, please wait a moment');
    }

    if (this.ready) {
      throw new Error('WhatsApp is already connected');
    }

    if (this.sock.authState?.creds?.registered) {
      throw new Error('This session is already registered, restart the connection to re-pair');
    }

    if (this.isRequestingPairingCode) {
      throw new Error('A pairing code request is already in progress');
    }

    const normalized = this.normalizePersonalNumber(phoneNumber);
    if (!normalized || normalized.length < 8) {
      throw new Error('Invalid phone number');
    }

    this.isRequestingPairingCode = true;
    try {
      const code = await this.sock.requestPairingCode(normalized);
      this.pairingCode = code;
      this.lastStatus = 'Enter the pairing code in WhatsApp > Linked Devices';
      return code;
    } finally {
      this.isRequestingPairingCode = false;
    }
  }

  buildChatId(targetType, target) {
    const rawTarget = String(target || '').trim();
    if (!rawTarget) {
      throw new Error('Target cannot be empty');
    }

    if (targetType === 'group') {
      if (rawTarget.endsWith('@g.us')) {
        return rawTarget;
      }

      const normalizedGroup = rawTarget.replace(/[^0-9-]/g, '');
      if (!normalizedGroup) {
        throw new Error('Invalid group ID');
      }

      return `${normalizedGroup}@g.us`;
    }

    if (rawTarget.includes('@')) {
      return rawTarget;
    }

    const normalizedPhone = this.normalizePersonalNumber(rawTarget);
    if (!normalizedPhone) {
      throw new Error('Invalid destination number');
    }

    return `${normalizedPhone}@s.whatsapp.net`;
  }

  normalizePersonalNumber(value) {
    const rawValue = String(value || '').trim();
    if (!rawValue) return '';

    if (rawValue.endsWith('@s.whatsapp.net')) {
      return rawValue.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, '');
    }

    const digitsOnly = rawValue.replace(/\D/g, '');
    if (!digitsOnly) return '';

    if (digitsOnly.startsWith('0')) {
      return `${this.defaultDialCode}${digitsOnly.slice(1)}`;
    }

    if (digitsOnly.startsWith(this.defaultDialCode)) {
      return digitsOnly;
    }

    return digitsOnly;
  }

  async sendMessage(targetType, target, message) {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp client is not ready');
    }

    let chatId = this.buildChatId(targetType, target);
    if (targetType === 'personal' && chatId.endsWith('@s.whatsapp.net')) {
      const result = await this.sock.onWhatsApp(chatId);
      if (!Array.isArray(result) || !result[0] || !result[0].exists) {
        throw new Error('Destination number is not registered on WhatsApp');
      }

      chatId = result[0].jid || chatId;
    }

    console.log(`[WA] Sending message to ${chatId}`);
    await this.sock.sendMessage(chatId, { text: String(message || '') });
  }

  async handleIncomingMessages(event) {
    if (!this.sock || event.type !== 'notify') return;

    for (const message of event.messages || []) {
      if (!message?.message || message.key?.fromMe) continue;

      const chatId = message.key?.remoteJid;
      if (!chatId) continue;

      const content = normalizeMessageContent(message.message) || message.message;

      const interactiveSelectionId = this.extractInteractiveSelectionId(content);
      const text = this.extractMessageText(content);

      if (interactiveSelectionId) {
        this.logInteractiveDebug('incoming selection detected', {
          chatId,
          interactiveSelectionId,
          text,
        });
      }

      if (text.trim() === '.vv' || text.trim() === '!vv') {
        await this.handleViewOnceCommand(chatId, content);
        continue;
      }

      if (text.trim().startsWith('.') || text.trim().startsWith('!')) {
        const handled = await this.handleBuiltInCommand(chatId, message, content, text);
        if (handled) continue;
      }

      let matched = customCommandStore.matchCommand(text);
      if (!matched) {
        matched = this.matchInteractiveCommand(interactiveSelectionId);
      }
      if (interactiveSelectionId) {
        this.logInteractiveDebug('selection match result', {
          interactiveSelectionId,
          matchedTrigger: matched?.trigger || null,
        });
      }
      if (!matched) continue;

      await this.replyWithCustomCommand(chatId, matched);
    }
  }

  extractMessageText(content) {
    if (!content || typeof content !== 'object') return '';

    const interactiveSelectedId = this.extractInteractiveSelectionId(content);

    const candidates = [
      content.conversation,
      content.extendedTextMessage?.text,
      content.imageMessage?.caption,
      content.videoMessage?.caption,
      content.documentMessage?.caption,
      content.buttonsResponseMessage?.selectedButtonId,
      content.buttonsResponseMessage?.selectedDisplayText,
      content.templateButtonReplyMessage?.selectedId,
      content.listResponseMessage?.singleSelectReply?.selectedRowId,
      interactiveSelectedId,
    ];

    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value) return value;
    }

    return '';
  }

  extractInteractiveSelectionId(content) {
    if (!content || typeof content !== 'object') return '';

    const viewOnceMessage = content.viewOnceMessage?.message || null;

    const directCandidates = [
      content.listResponseMessage?.singleSelectReply?.selectedRowId,
      content.buttonsResponseMessage?.selectedButtonId,
      content.templateButtonReplyMessage?.selectedId,
      content.interactiveResponseMessage?.nativeFlowResponseMessage?.id,
      content.interactiveResponseMessage?.nativeFlowResponseMessage?.selectedId,
      content.interactiveResponseMessage?.nativeFlowResponseMessage?.selected_id,
      viewOnceMessage?.listResponseMessage?.singleSelectReply?.selectedRowId,
      viewOnceMessage?.buttonsResponseMessage?.selectedButtonId,
      viewOnceMessage?.templateButtonReplyMessage?.selectedId,
      viewOnceMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.id,
      viewOnceMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.selectedId,
      viewOnceMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.selected_id,
    ];

    for (const candidate of directCandidates) {
      const value = String(candidate || '').trim();
      if (value) return value;
    }

    const paramsJsonCandidates = [
      content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
      viewOnceMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
    ];

    for (const interactiveParamsJson of paramsJsonCandidates) {
      if (!(typeof interactiveParamsJson === 'string' && interactiveParamsJson.trim())) {
        continue;
      }

      try {
        const parsed = JSON.parse(interactiveParamsJson);
        if (parsed && typeof parsed === 'object') {
          // Prioritize fields that represent the user-selected value.
          const selected = String(
            parsed.selected_id
            || parsed.selected_row_id
            || parsed.single_select_reply?.selected_row_id
            || parsed.button_id
            || parsed.row_id
            || parsed.id
            || ''
          ).trim();
          if (selected) {
            this.logInteractiveDebug('parsed paramsJson selection', {
              selected,
              parsed,
            });
            return selected;
          }
        }
      } catch (error) {
        this.logInteractiveDebug('failed to parse paramsJson', {
          error: error.message,
          interactiveParamsJson,
        });
        continue;
      }
    }

    return '';
  }

  matchInteractiveCommand(selectionId) {
    const raw = String(selectionId || '').trim();
    if (!raw) return null;

    const normalized = normalizeInteractiveTrigger(raw);

    this.logInteractiveDebug('attempt command match', {
      raw,
      normalized,
    });

    return (
      customCommandStore.findCommand(raw)
      || customCommandStore.matchCommand(raw)
      || customCommandStore.findCommand(normalized)
      || null
    );
  }

  async handleBuiltInCommand(chatId, message, content, text) {
    const normalized = String(text || '').trim();
    const command = normalized.split(/\s+/)[0].toLowerCase();

    if (command === '.sticker' || command === '.s' || command === '!sticker' || command === '!s') {
      await this.handleStickerCommand(chatId, message, content);
      return true;
    }

    return false;
  }

  async resolveYouTubeTarget(input) {
    const raw = String(input || '').trim();
    if (!raw) {
      throw new Error('Usage: .ytmp3 <judul atau link YouTube>');
    }

    if (isLikelyUrl(raw)) {
      const parsed = parseYouTubeInput(raw);
      if (!parsed || parsed.playlistOnly || !parsed.videoId) {
        throw new Error('Link YouTube tidak valid. Gunakan link video, bukan playlist.');
      }

      let info = null;
      try {
        info = await ytSearch({ videoId: parsed.videoId });
      } catch (error) {
        // Metadata lookup can fail even when the video URL is valid.
      }

      return {
        url: parsed.canonicalUrl,
        title: info?.title || `YouTube ${parsed.videoId}`,
        thumbnail: info?.thumbnail || '',
      };
    }

    const search = await ytSearch(raw);
    const first = Array.isArray(search?.videos) ? search.videos[0] : null;
    if (!first || !first.url) {
      throw new Error('Video tidak ditemukan, coba kata kunci lain.');
    }

    return {
      url: first.url,
      title: first.title || raw,
      thumbnail: first.thumbnail || '',
    };
  }

  async resolveDownloadFromProviders(providers) {
    for (const provider of providers) {
      try {
        const result = await provider();
        if (isHttpUrl(result?.url)) return { ...result, url: String(result.url).trim() };
      } catch (error) {
        console.log(`[WA] Provider failed: ${error.message}`);
      }
      await sleep(300);
    }

    return null;
  }

  async handleYtmp3Command(chatId, message, args) {
    if (!this.sock) return;

    try {
      const target = await this.resolveYouTubeTarget(args);
      const providers = [
        async () => {
          const data = await fetchJsonWithTimeout(
            `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(target.url)}&format=mp3`,
            40000
          );
          return { url: extractAudioDownloadUrlFromPayload(data), title: extractTitleFromPayload(data) };
        },
        async () => {
          const data = await fetchJsonWithTimeout(
            `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(target.url)}`,
            40000
          );
          return { url: extractAudioDownloadUrlFromPayload(data), title: extractTitleFromPayload(data) };
        },
        async () => {
          const data = await fetchJsonWithTimeout(
            `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(target.url)}`,
            40000
          );
          return { url: extractAudioDownloadUrlFromPayload(data), title: extractTitleFromPayload(data) };
        },
      ];

      if (target.thumbnail) {
        try {
          await this.sock.sendMessage(
            chatId,
            { image: { url: target.thumbnail }, caption: `🎵 ${target.title}\n⏳ Sedang menyiapkan audio...` },
            { quoted: message }
          );
        } catch (error) {
          console.log('[WA] Thumbnail preview skipped:', error.message);
        }
      }

      const picked = await this.resolveDownloadFromProviders(providers);
      if (!picked?.url) {
        await this.sock.sendMessage(
          chatId,
          { text: 'Gagal mengambil link audio. Coba lagi beberapa saat lagi.' },
          { quoted: message }
        );
        return;
      }

      const response = await fetchWithTimeout(picked.url, {}, 120000);
      if (!response.ok) throw new Error(`Audio download failed (HTTP ${response.status})`);

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        throw new Error('Audio kosong dari provider, coba lagi.');
      }
      const title = sanitizeFileName(picked.title || target.title, 'audio');

      try {
        await this.sock.sendMessage(
          chatId,
          {
            audio: buffer,
            mimetype: 'audio/mpeg',
            fileName: `${title}.mp3`,
            ptt: false,
          },
          { quoted: message }
        );
      } catch (audioSendError) {
        console.log('[WA] Audio send failed, fallback to document:', audioSendError.message);
        await this.sock.sendMessage(
          chatId,
          {
            document: buffer,
            mimetype: 'audio/mpeg',
            fileName: `${title}.mp3`,
            caption: `🎵 ${picked.title || target.title}`,
          },
          { quoted: message }
        );
      }
    } catch (error) {
      console.error('[WA] .ytmp3 error:', error.message);
      await this.sock.sendMessage(chatId, { text: `Gagal proses .ytmp3: ${error.message}` }, { quoted: message });
    }
  }

  async handleYtmp4Command(chatId, message, args) {
    if (!this.sock) return;

    try {
      const target = await this.resolveYouTubeTarget(args);
      const providers = [
        async () => {
          const data = await fetchJsonWithTimeout(
            `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(target.url)}&format=mp4`,
            40000
          );
          return { url: extractDownloadUrlFromPayload(data), title: extractTitleFromPayload(data) };
        },
        async () => {
          const data = await fetchJsonWithTimeout(
            `https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(target.url)}`,
            40000
          );
          return { url: extractDownloadUrlFromPayload(data), title: extractTitleFromPayload(data) };
        },
        async () => {
          const data = await fetchJsonWithTimeout(
            `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(target.url)}`,
            40000
          );
          return { url: extractDownloadUrlFromPayload(data), title: extractTitleFromPayload(data) };
        },
      ];

      const picked = await this.resolveDownloadFromProviders(providers);
      if (!picked?.url) {
        await this.sock.sendMessage(
          chatId,
          { text: 'Gagal mengambil link video. Coba lagi nanti.' },
          { quoted: message }
        );
        return;
      }

      const response = await fetchWithTimeout(picked.url, {}, 120000);
      if (!response.ok) throw new Error(`Video download failed (HTTP ${response.status})`);

      const contentLengthHeader = response.headers.get('content-length') || '0';
      const contentLength = Number(contentLengthHeader);
      const maxBytes = 64 * 1024 * 1024;
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('Ukuran video terlalu besar untuk dikirim (maks 64MB).');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new Error('Ukuran video terlalu besar untuk dikirim (maks 64MB).');
      }

      const title = sanitizeFileName(picked.title || target.title, 'video');
      await this.sock.sendMessage(
        chatId,
        {
          video: buffer,
          mimetype: 'video/mp4',
          fileName: `${title}.mp4`,
          caption: `🎬 ${picked.title || target.title}`,
        },
        { quoted: message }
      );
    } catch (error) {
      console.error('[WA] .ytmp4 error:', error.message);
      await this.sock.sendMessage(chatId, { text: `Gagal proses .ytmp4: ${error.message}` }, { quoted: message });
    }
  }

  extractFacebookVideoUrl(data) {
    if (!data || typeof data !== 'object') return '';

    const candidates = [
      data?.result?.media?.video_hd,
      data?.result?.media?.video_sd,
      data?.result?.url,
      data?.result?.download,
      data?.result?.video,
      data?.data?.url,
      data?.data?.download,
      data?.url,
      data?.download,
      data?.video,
    ];

    for (const item of candidates) {
      if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
        return item;
      }
    }

    if (Array.isArray(data?.data)) {
      const fromArray = data.data.find((item) => item?.url);
      if (fromArray?.url) return fromArray.url;
    }

    return '';
  }

  async handleFacebookCommand(chatId, message, args) {
    if (!this.sock) return;

    const url = String(args || '').trim();
    if (!url || !/facebook\.com|fb\.watch/i.test(url)) {
      await this.sock.sendMessage(
        chatId,
        { text: 'Usage: .facebook <link-facebook>\nContoh: .facebook https://www.facebook.com/...' },
        { quoted: message }
      );
      return;
    }

    try {
      const data = await fetchJsonWithTimeout(
        `https://api.hanggts.xyz/download/facebook?url=${encodeURIComponent(url)}`,
        40000
      );
      const videoUrl = this.extractFacebookVideoUrl(data);
      if (!videoUrl) throw new Error('Video tidak ditemukan dari API');

      const title = data?.result?.info?.title || data?.result?.title || data?.title || 'Facebook Video';
      await this.sock.sendMessage(
        chatId,
        { video: { url: videoUrl }, mimetype: 'video/mp4', caption: `📘 ${title}` },
        { quoted: message }
      );
    } catch (error) {
      console.error('[WA] .facebook error:', error.message);
      await this.sock.sendMessage(chatId, { text: 'Gagal download video Facebook. Coba link lain.' }, { quoted: message });
    }
  }

  extractInstagramMediaUrls(data) {
    const links = [];

    if (Array.isArray(data?.result)) {
      for (const item of data.result) {
        if (item?.url) links.push(item.url);
      }
    }

    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (typeof item === 'string' && /^https?:\/\//i.test(item)) links.push(item);
        if (item?.url) links.push(item.url);
      }
    }

    if (typeof data?.url === 'string') links.push(data.url);
    if (typeof data?.download === 'string') links.push(data.download);

    return [...new Set(links.filter((item) => /^https?:\/\//i.test(item)))];
  }

  async handleInstagramCommand(chatId, message, args) {
    if (!this.sock) return;

    const url = String(args || '').trim();
    if (!url || !/instagram\.com|instagr\.am/i.test(url)) {
      await this.sock.sendMessage(
        chatId,
        { text: 'Usage: .instagram <link-instagram>\nContoh: .instagram https://www.instagram.com/reel/...' },
        { quoted: message }
      );
      return;
    }

    const endpoints = [
      `https://api.hanggts.xyz/download/instagram?url=${encodeURIComponent(url)}`,
      `https://api.yupra.my.id/api/downloader/instagram?url=${encodeURIComponent(url)}`,
    ];

    try {
      let mediaUrls = [];
      for (const endpoint of endpoints) {
        try {
          const data = await fetchJsonWithTimeout(endpoint, 40000);
          mediaUrls = this.extractInstagramMediaUrls(data);
          if (mediaUrls.length) break;
        } catch (error) {
          console.log('[WA] Instagram provider failed:', error.message);
        }
      }

      if (!mediaUrls.length) {
        throw new Error('Media tidak ditemukan');
      }

      const limited = mediaUrls.slice(0, 5);
      for (const mediaUrl of limited) {
        const lower = mediaUrl.toLowerCase();
        const isVideo = lower.includes('.mp4') || lower.includes('/video');
        if (isVideo) {
          await this.sock.sendMessage(chatId, { video: { url: mediaUrl }, mimetype: 'video/mp4' }, { quoted: message });
        } else {
          await this.sock.sendMessage(chatId, { image: { url: mediaUrl } }, { quoted: message });
        }
      }
    } catch (error) {
      console.error('[WA] .instagram error:', error.message);
      await this.sock.sendMessage(chatId, { text: 'Gagal download media Instagram. Pastikan link publik.' }, { quoted: message });
    }
  }

  resolveStickerMedia(content) {
    const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage || null;
    const sources = [quoted, content];

    for (const source of sources) {
      if (source?.stickerMessage) return { media: source.stickerMessage, type: 'sticker' };
      if (source?.imageMessage) return { media: source.imageMessage, type: 'image' };
      if (source?.videoMessage) return { media: source.videoMessage, type: 'video' };
    }

    return null;
  }

  async streamToBuffer(stream) {
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
  }

  async convertToWebp(inputBuffer, mediaType) {
    if (mediaType === 'sticker') return inputBuffer;
    if (!ffmpegPath) {
      throw new Error('ffmpeg binary tidak tersedia di server');
    }

    await fs.promises.mkdir(tempDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inputExt = mediaType === 'video' ? 'mp4' : 'jpg';
    const inputPath = path.join(tempDir, `${id}.${inputExt}`);
    const outputPath = path.join(tempDir, `${id}.webp`);

    try {
      await fs.promises.writeFile(inputPath, inputBuffer);

      const filterBase = 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1';
      const videoFilter = `fps=12,${filterBase}`;
      const args = mediaType === 'video'
        ? ['-y', '-i', inputPath, '-t', '7', '-vf', videoFilter, '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '65', '-preset', 'default', '-loop', '0', '-an', '-vsync', '0', outputPath]
        : ['-y', '-i', inputPath, '-vf', filterBase, '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '75', '-preset', 'default', '-loop', '0', '-an', '-vsync', '0', outputPath];

      await execFileAsync(ffmpegPath, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return await fs.promises.readFile(outputPath);
    } finally {
      await fs.promises.unlink(inputPath).catch(() => {});
      await fs.promises.unlink(outputPath).catch(() => {});
    }
  }

  async handleStickerCommand(chatId, message, content) {
    if (!this.sock) return;

    const target = this.resolveStickerMedia(content);
    if (!target) {
      await this.sock.sendMessage(
        chatId,
        { text: 'Usage: kirim/reply gambar, video, atau sticker lalu ketik .sticker' },
        { quoted: message }
      );
      return;
    }

    try {
      const stream = await downloadContentFromMessage(target.media, target.type);
      const sourceBuffer = await this.streamToBuffer(stream);
      const stickerBuffer = await this.convertToWebp(sourceBuffer, target.type);
      await this.sock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: message });
    } catch (error) {
      console.error('[WA] .sticker error:', error.message);
      await this.sock.sendMessage(chatId, { text: 'Gagal membuat sticker dari media tersebut.' }, { quoted: message });
    }
  }

  async handleViewOnceCommand(chatId, content) {
    const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedImage = quoted?.imageMessage;
    const quotedVideo = quoted?.videoMessage;

    try {
      if (quotedImage && quotedImage.viewOnce) {
        const stream = await downloadContentFromMessage(quotedImage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await this.sock.sendMessage(
          chatId,
          { image: buffer, fileName: 'media.jpg', caption: quotedImage.caption || '' }
        );
      } else if (quotedVideo && quotedVideo.viewOnce) {
        const stream = await downloadContentFromMessage(quotedVideo, 'video');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        await this.sock.sendMessage(
          chatId,
          { video: buffer, fileName: 'media.mp4', caption: quotedVideo.caption || '' }
        );
      } else {
        await this.sock.sendMessage(chatId, { text: 'Reply to a "view once" image/video message with .vv to reopen it.' });
      }
    } catch (error) {
      console.error('[WA] Failed to process .vv command:', error.message);
      await this.sock.sendMessage(chatId, { text: 'Failed to reopen that media.' });
    }
  }

  async handleMessageUpdates(updates) {
    if (!this.sock || !Array.isArray(updates)) return;

    for (const item of updates) {
      const isRevoked =
        item?.update?.messageStubType === baileys.WAMessageStubType?.REVOKE ||
        (item?.update && 'message' in item.update && item.update.message === null);

      if (!isRevoked) continue;

      const chatId = item.key?.remoteJid;
      const messageId = item.key?.id;
      if (!chatId || !messageId) continue;

      await this.saveDeletedMessage(chatId, messageId, item.key);
    }
  }

  async saveDeletedMessage(chatId, messageId, key) {
    try {
      const original = await this.store?.loadMessage?.(chatId, messageId);
      if (!original?.message) return;

      const content = normalizeMessageContent(original.message) || original.message;
      const senderId = key?.participant || (chatId.endsWith('@g.us') ? '' : chatId);
      const senderName = original.pushName || '';
      const isGroup = chatId.endsWith('@g.us');

      let chatName = '';
      if (isGroup) {
        const chat = this.store?.chats?.get?.(chatId);
        chatName = chat?.name || chat?.subject || '';
      }

      const record = {
        chatId,
        chatName,
        senderId,
        senderName,
        isGroup,
        originalTimestamp: original.messageTimestamp
          ? Number(original.messageTimestamp) * 1000
          : null,
      };

      const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        '';

      const mediaField = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']
        .find((key2) => content[key2]);

      if (mediaField) {
        const mediaTypeMap = {
          imageMessage: 'image',
          videoMessage: 'video',
          audioMessage: 'audio',
          documentMessage: 'document',
          stickerMessage: 'sticker',
        };
        const mediaType = mediaTypeMap[mediaField];
        const mediaMessage = content[mediaField];

        try {
          const downloadType = mediaType === 'sticker' ? 'sticker' : mediaType;
          const stream = await downloadContentFromMessage(mediaMessage, downloadType);
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

          const extMap = {
            image: '.jpg',
            video: '.mp4',
            audio: '.ogg',
            document: '',
            sticker: '.webp',
          };
          const ext = extMap[mediaType] || '';
          const fileName = `deleted-${Date.now()}${ext}`;
          fs.mkdirSync(uploadDir, { recursive: true });
          fs.writeFileSync(path.join(uploadDir, fileName), buffer);

          record.type = mediaType;
          record.mediaUrl = `/uploads/${fileName}`;
          record.fileName = mediaMessage.fileName || fileName;
          record.text = text;
        } catch (downloadError) {
          console.error('[WA] Failed to download deleted media:', downloadError.message);
          record.type = mediaType;
          record.text = text || '[Media could not be recovered]';
        }
      } else {
        record.type = 'text';
        record.text = text || '[Unsupported message type]';
      }

      deletedMessageStore.addRecord(record);
      console.log(`[WA] Saved deleted message from ${chatId}`);
    } catch (error) {
      console.error('[WA] Failed to save deleted message:', error.message);
    }
  }

  async replyWithCustomCommand(chatId, command) {
    const caption = String(command.response || '').replace(/\\n/g, '\n');
    const options = {};
    const hasButtons = Boolean(command.buttons && command.buttons.length);

    if (command.mediaUrl && command.mediaType) {
      const media = {
        type: command.mediaType,
        source: { url: command.mediaUrl },
        fileName: command.fileName || 'file',
      };

      if (hasButtons) {
        await sendInteractiveButtons(this.sock, chatId, { caption, media, buttons: command.buttons }, options);
        return;
      }

      const payload = { [command.mediaType]: media.source, caption };
      if (command.mediaType === 'audio') {
        payload.mimetype = 'audio/mpeg';
        payload.ptt = false;
      } else if (command.mediaType === 'document') {
        payload.fileName = media.fileName;
        payload.mimetype = 'application/octet-stream';
      }

      await this.sock.sendMessage(chatId, payload, options);
      return;
    }

    if (caption || hasButtons) {
      await sendInteractiveButtons(this.sock, chatId, { text: caption, buttons: command.buttons }, options);
    }
  }

  async listGroups() {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp client is not ready');
    }

    const groupsMap = await this.sock.groupFetchAllParticipating();
    return Object.values(groupsMap)
      .map((group) => ({
        id: group.id || '',
        name: group.subject || 'Untitled',
      }))
      .filter((group) => group.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }

  async listPersonalChats() {
    if (!this.sock || !this.ready) {
      throw new Error('WhatsApp client is not ready');
    }

    const normalizePersonalJid = (value) => {
      const raw = String(value || '').trim();
      if (!raw.endsWith('@s.whatsapp.net')) return '';
      const localPart = raw.split('@')[0] || '';
      const phone = localPart.split(':')[0].replace(/\D/g, '');
      if (!phone) return '';
      return `${phone}@s.whatsapp.net`;
    };

    const ownJid = normalizePersonalJid(this.sock?.user?.id || '');
    const contacts = this.store?.contacts || {};
    const chats = this.store?.chats?.all?.() || [];
    const merged = new Map();

    for (const chat of chats) {
      const jid = normalizePersonalJid(chat?.id || '');
      if (!jid || jid === ownJid) continue;

      const hasDirectInteraction = Boolean(
        chat?.conversationTimestamp
        || chat?.lastMessageRecvTimestamp
        || chat?.lastMsgTimestamp
      );
      if (!hasDirectInteraction) continue;

      const phone = this.normalizePersonalNumber(jid);
      const contact = contacts[jid] || contacts[chat?.id] || null;
      merged.set(jid, {
        id: jid,
        name: String(
          chat?.name
          || chat?.notify
          || chat?.pushName
          || contact?.name
          || contact?.notify
          || phone
          || 'Unnamed'
        ),
        phone,
      });
    }

    try {
      const groupsMap = await this.sock.groupFetchAllParticipating();
      for (const group of Object.values(groupsMap || {})) {
        const participants = Array.isArray(group?.participants) ? group.participants : [];

        for (const participant of participants) {
          const rawParticipantId = participant?.id || participant;
          const jid = normalizePersonalJid(rawParticipantId);
          if (!jid || jid === ownJid || merged.has(jid)) continue;

          const phone = this.normalizePersonalNumber(jid);
          const contact = contacts[jid] || contacts[rawParticipantId] || null;
          merged.set(jid, {
            id: jid,
            name: String(contact?.name || contact?.notify || contact?.verifiedName || phone || 'Unnamed'),
            phone,
          });
        }
      }
    } catch (error) {
      console.log('[WA] Failed to enrich personal chats from groups:', error.message);
    }

    return Array.from(merged.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }
}

module.exports = new WhatsAppService();
