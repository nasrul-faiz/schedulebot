const baileys = require('atexovi-baileys');

const { generateWAMessageFromContent, proto } = baileys;

function isPersonalJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function normalizePhone(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function normalizeButton(button) {
  if (!button || typeof button !== 'object' || !button.name || !button.buttonParamsJson) return null;

  const name = String(button.name || '').trim();
  let params = {};

  if (typeof button.buttonParamsJson === 'string') {
    try {
      params = JSON.parse(button.buttonParamsJson);
    } catch (error) {
      params = {};
    }
  } else if (typeof button.buttonParamsJson === 'object') {
    params = button.buttonParamsJson || {};
  }

  const displayText = String(params.display_text || '').trim();

  // `cta_wa` is transformed to `cta_url` so the button reliably opens a WA chat.
  // This keeps behavior consistent even when interactive native payload falls back.
  if (name === 'cta_wa') {
    const phoneNumber = normalizePhone(params.phone_number || params.id || '');
    if (!phoneNumber) return null;

    const presetText = String(params.text || params.message || '').trim();
    const waUrl = presetText
      ? `https://wa.me/${phoneNumber}?text=${encodeURIComponent(presetText)}`
      : `https://wa.me/${phoneNumber}`;

    return {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: displayText || 'WhatsApp',
        url: waUrl,
      }),
    };
  }

  if (name === 'cta_call') {
    const phoneNumber = normalizePhone(params.phone_number || '');
    if (!phoneNumber) return null;

    return {
      name,
      buttonParamsJson: JSON.stringify({
        ...params,
        display_text: displayText,
        phone_number: phoneNumber,
      }),
    };
  }

  return {
    name,
    buttonParamsJson: JSON.stringify(params),
  };
}

function getButtonDedupKey(button) {
  if (!button || typeof button !== 'object') return '';

  const name = String(button.name || '').trim();
  let params = {};

  if (typeof button.buttonParamsJson === 'string') {
    try {
      params = JSON.parse(button.buttonParamsJson);
    } catch (error) {
      params = {};
    }
  }

  if (name === 'quick_reply') {
    return `quick_reply:${String(params.id || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_url') {
    return `cta_url:${String(params.url || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_call') {
    return `cta_call:${String(params.phone_number || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_wa') {
    return `cta_wa:${String(params.phone_number || '').trim()}:${String(params.display_text || '').trim()}`;
  }
  if (name === 'cta_copy') {
    return `cta_copy:${String(params.copy_code || '').trim()}:${String(params.display_text || '').trim()}`;
  }

  return `${name}:${JSON.stringify(params)}`;
}

function toNativeFlowButtons(buttons) {
  if (!Array.isArray(buttons)) return [];

  const mapped = [];
  const seen = new Set();

  for (const button of buttons) {
    const normalized = normalizeButton(button);
    if (!normalized) continue;

    const key = getButtonDedupKey(normalized);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    mapped.push(normalized);
  }

  return mapped;
}

function toLegacyButtons(nativeButtons) {
  return nativeButtons
    .map((button, index) => {
      try {
        const params = JSON.parse(button.buttonParamsJson || '{}');
        const displayText = params.display_text || `Button ${index + 1}`;
        const buttonId = params.id || params.url || params.phone_number || params.copy_code || displayText;
        return { buttonId: String(buttonId), buttonText: { displayText }, type: 1 };
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .slice(0, 3);
}

function buildMediaField(media) {
  if (!media || !media.type || !media.source) return null;

  const field = { [media.type]: media.source };
  if (media.type === 'document') {
    field.fileName = media.fileName || 'file';
    field.mimetype = media.mimetype || 'application/octet-stream';
  } else if (media.type === 'audio') {
    field.mimetype = media.mimetype || 'audio/mpeg';
    field.ptt = false;
  }

  return field;
}

async function sendInteractiveButtons(sock, jid, payload, options = {}) {
  const bodyText = payload?.text || payload?.caption || '';
  const footerText = payload?.footer || '';
  const nativeButtons = toNativeFlowButtons(payload?.buttons);
  const shouldStripQuotedFallback = isPersonalJid(jid) && Boolean(options?.quoted);
  const mediaField = buildMediaField(payload?.media);
  const legacyButtons = toLegacyButtons(nativeButtons);
  const buttonMessageText = bodyText || footerText || 'Choose an option:';

  if (!nativeButtons.length) {
    if (mediaField) {
      await sock.sendMessage(jid, { ...mediaField, caption: bodyText || undefined }, options);
    } else {
      await sock.sendMessage(jid, { text: bodyText || ' ' }, options);
    }
    return;
  }

  // Compatibility-first path: media+buttons in one message is inconsistent across WA clients.
  // We send media first, then response text together with button message to ensure both are delivered reliably.
  if (mediaField) {
    try {
      await sock.sendMessage(jid, { ...mediaField }, options);
    } catch (mediaError) {
      if (!shouldStripQuotedFallback) throw mediaError;

      await sock.sendMessage(jid, { ...mediaField });
    }

    try {
      await sock.sendMessage(
        jid,
        {
          text: buttonMessageText,
          footer: footerText,
          interactiveButtons: nativeButtons,
          viewOnce: true,
        },
        options
      );
      return;
    } catch (interactiveError) {
      console.warn('[WA] media follow-up interactiveButtons failed:', interactiveError.message);

      if (shouldStripQuotedFallback) {
        try {
          await sock.sendMessage(jid, {
            text: buttonMessageText,
            footer: footerText,
            interactiveButtons: nativeButtons,
            viewOnce: true,
          });
          return;
        } catch (retryInteractiveError) {
          console.warn('[WA] media follow-up interactiveButtons retry failed:', retryInteractiveError.message);
        }
      }
    }

    try {
      const followUpMsg = generateWAMessageFromContent(
        jid,
        {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2,
              },
              interactiveMessage: proto.Message.InteractiveMessage.create({
                body: proto.Message.InteractiveMessage.Body.create({ text: buttonMessageText }),
                footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }),
                header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                  buttons: nativeButtons,
                }),
              }),
            },
          },
        },
        {
          userJid: sock?.user?.id,
          quoted: options?.quoted,
        }
      );

      await sock.relayMessage(jid, followUpMsg.message, { messageId: followUpMsg.key.id });
      return;
    } catch (relayError) {
      console.warn('[WA] media follow-up nativeFlow relay failed:', relayError.message);
    }

    if (legacyButtons.length) {
      try {
        await sock.sendMessage(
          jid,
          {
            text: buttonMessageText,
            footer: footerText,
            buttons: legacyButtons,
            headerType: 1,
            viewOnce: true,
          },
          options
        );
        return;
      } catch (buttonError) {
        if (!shouldStripQuotedFallback) throw buttonError;

        await sock.sendMessage(jid, {
          text: buttonMessageText,
          footer: footerText,
          buttons: legacyButtons,
          headerType: 1,
          viewOnce: true,
        });
        return;
      }
    }

    // If legacy button format is unavailable, still send a text fallback.
    await sock.sendMessage(jid, { text: buttonMessageText }, options);
    return;
  }

  const bodyKey = mediaField ? 'caption' : 'text';

  async function sendFinalFallback() {
    if (mediaField) {
      await sock.sendMessage(jid, { ...mediaField, caption: bodyText || undefined }, options);
      return;
    }

    await sock.sendMessage(jid, { text: bodyText || ' ' }, options);
  }

  try {
    await sock.sendMessage(
      jid,
      {
        ...mediaField,
        [bodyKey]: bodyText || ' ',
        footer: footerText,
        interactiveButtons: nativeButtons,
        viewOnce: true,
      },
      options
    );
    return;
  } catch (error) {
    // Fallback for Baileys variants that do not support interactiveButtons in sendMessage.
    console.warn('[WA] interactiveButtons via sendMessage failed:', error.message);

    if (shouldStripQuotedFallback) {
      try {
        await sock.sendMessage(jid, {
          ...mediaField,
          [bodyKey]: bodyText || ' ',
          footer: footerText,
          interactiveButtons: nativeButtons,
          viewOnce: true,
        });
        return;
      } catch (retryError) {
        console.warn('[WA] interactiveButtons retry without quoted failed:', retryError.message);
      }
    }
  }

  try {
    const msg = generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage: proto.Message.InteractiveMessage.create({
              body: proto.Message.InteractiveMessage.Body.create({ text: bodyText || ' ' }),
              footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }),
              header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
              nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: nativeButtons,
              }),
            }),
          },
        },
      },
      {
        userJid: sock?.user?.id,
        quoted: options?.quoted,
      }
    );

    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    return;
  } catch (error) {
    console.warn('[WA] nativeFlow relay failed, trying legacy buttons:', error.message);
    if (!legacyButtons.length) {
      await sendFinalFallback();
      return;
    }

    try {
      await sock.sendMessage(
        jid,
        {
          text: bodyText || ' ',
          footer: footerText,
          buttons: legacyButtons,
          headerType: 1,
          viewOnce: true,
        },
        options
      );
      return;
    } catch (legacyError) {
      if (shouldStripQuotedFallback) {
        try {
          await sock.sendMessage(jid, {
            text: bodyText || ' ',
            footer: footerText,
            buttons: legacyButtons,
            headerType: 1,
            viewOnce: true,
          });
          return;
        } catch (retryLegacyError) {
          console.warn('[WA] legacy buttons retry without quoted failed:', retryLegacyError.message);
        }
      }

      // Last fallback when mixed media+buttons payload cannot be composed by the WA client.
      if (mediaField) {
        await sock.sendMessage(jid, { ...mediaField, caption: bodyText || undefined }, options);
        await sock.sendMessage(
          jid,
          {
            text: footerText || 'Choose an option:',
            buttons: legacyButtons,
            headerType: 1,
            viewOnce: true,
          },
          options
        );
        return;
      }

      await sendFinalFallback();
      return;
    }
  }
}

module.exports = {
  sendInteractiveButtons,
  toNativeFlowButtons,
};
