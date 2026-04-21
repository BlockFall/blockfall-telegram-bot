import { Bot, GrammyError, HttpError, type Api, type Context, type Filter } from 'grammy';
import type { Message } from 'grammy/types';
import config from './config.ts';
import { CustomerTopicStore, type CustomerRecord } from './storage.ts';

type MessageContext = Filter<Context, 'message'>;

interface UserLike {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayName(u: { firstName: string; lastName: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || 'Customer';
}

function formatTopicName(from: UserLike): string {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  const base = fullName || `User ${String(from.id)}`;
  return from.username ? `${base} (@${from.username})` : base;
}

function formatCustomerInfo(rec: CustomerRecord): string {
  const lines = [
    `🆕 <b>New support session</b>`,
    `👤 ${escapeHtml(displayName(rec))}`,
    rec.username ? `🔗 @${escapeHtml(rec.username)}` : null,
    `🆔 User ID: <code>${String(rec.customerId)}</code>`,
    ``,
    `Reply in this topic to respond to the customer.`,
  ].filter((x): x is string => x !== null);
  return lines.join('\n');
}

async function createTopicForCustomer(
  api: Api,
  adminGroupId: number,
  store: CustomerTopicStore,
  from: UserLike
): Promise<CustomerRecord> {
  const topic = await api.createForumTopic(adminGroupId, formatTopicName(from), {
    icon_color: 0x6fb9f0,
  });
  const rec: CustomerRecord = {
    customerId: from.id,
    topicId: topic.message_thread_id,
    firstName: from.first_name,
    lastName: from.last_name ?? null,
    username: from.username ?? null,
    createdAt: new Date().toISOString(),
  };
  await store.upsert(rec);

  try {
    await api.sendMessage(adminGroupId, formatCustomerInfo(rec), {
      message_thread_id: rec.topicId,
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.warn('[bot] failed to post customer info message:', err);
  }

  return rec;
}

async function getOrCreateTopic(
  api: Api,
  adminGroupId: number,
  store: CustomerTopicStore,
  from: UserLike
): Promise<{ rec: CustomerRecord; created: boolean }> {
  const existing = store.getByCustomer(from.id);
  if (existing) return { rec: existing, created: false };
  const rec = await createTopicForCustomer(api, adminGroupId, store, from);
  return { rec, created: true };
}

function isTopicMissingError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toLowerCase();
  return (
    d.includes('message thread not found') ||
    d.includes('topic_deleted') ||
    d.includes('topic_closed') ||
    d.includes('thread_not_found')
  );
}

/**
 * Send `msg` (from `sourceChatId`) to `targetChatId` using the most appropriate
 * typed method, prepending `header` where possible. Returns true if something
 * was delivered.
 */
async function relayMessage(
  api: Api,
  msg: Message,
  sourceChatId: number,
  targetChatId: number,
  header: string,
  messageThreadId?: number
): Promise<boolean> {
  const threadOpt = messageThreadId === undefined ? {} : { message_thread_id: messageThreadId };
  const htmlOpts = { ...threadOpt, parse_mode: 'HTML' as const };

  const captionFor = (raw: string | undefined): string =>
    raw ? `${header}\n${escapeHtml(raw)}` : header;

  if (msg.text !== undefined) {
    await api.sendMessage(targetChatId, `${header}\n${escapeHtml(msg.text)}`, htmlOpts);
    return true;
  }
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    if (photo) {
      await api.sendPhoto(targetChatId, photo.file_id, {
        ...htmlOpts,
        caption: captionFor(msg.caption),
      });
      return true;
    }
  }
  if (msg.video) {
    await api.sendVideo(targetChatId, msg.video.file_id, {
      ...htmlOpts,
      caption: captionFor(msg.caption),
    });
    return true;
  }
  if (msg.animation) {
    await api.sendAnimation(targetChatId, msg.animation.file_id, {
      ...htmlOpts,
      caption: captionFor(msg.caption),
    });
    return true;
  }
  if (msg.document) {
    await api.sendDocument(targetChatId, msg.document.file_id, {
      ...htmlOpts,
      caption: captionFor(msg.caption),
    });
    return true;
  }
  if (msg.audio) {
    await api.sendAudio(targetChatId, msg.audio.file_id, {
      ...htmlOpts,
      caption: captionFor(msg.caption),
    });
    return true;
  }
  if (msg.voice) {
    await api.sendVoice(targetChatId, msg.voice.file_id, {
      ...htmlOpts,
      caption: captionFor(msg.caption),
    });
    return true;
  }
  if (msg.video_note) {
    await api.sendMessage(targetChatId, header, htmlOpts);
    await api.sendVideoNote(targetChatId, msg.video_note.file_id, threadOpt);
    return true;
  }
  if (msg.sticker) {
    await api.sendMessage(targetChatId, header, htmlOpts);
    await api.sendSticker(targetChatId, msg.sticker.file_id, threadOpt);
    return true;
  }
  if (msg.location) {
    await api.sendMessage(targetChatId, header, htmlOpts);
    await api.sendLocation(targetChatId, msg.location.latitude, msg.location.longitude, threadOpt);
    return true;
  }
  if (msg.contact) {
    const contactOpts: { message_thread_id?: number; last_name?: string } = { ...threadOpt };
    if (msg.contact.last_name !== undefined) contactOpts.last_name = msg.contact.last_name;
    await api.sendMessage(targetChatId, header, htmlOpts);
    await api.sendContact(
      targetChatId,
      msg.contact.phone_number,
      msg.contact.first_name,
      contactOpts
    );
    return true;
  }

  try {
    await api.sendMessage(targetChatId, header, htmlOpts);
    await api.copyMessage(targetChatId, sourceChatId, msg.message_id, threadOpt);
    return true;
  } catch (err) {
    console.warn('[bot] fallback copyMessage failed:', err);
    return false;
  }
}

async function handleCustomerMessage(
  ctx: MessageContext,
  adminGroupId: number,
  store: CustomerTopicStore
): Promise<void> {
  if (ctx.chat.type !== 'private') return;
  const from = ctx.from;

  const msg = ctx.message;
  const text = msg.text ?? '';

  if (text.startsWith('/start')) {
    await ctx.reply(config.WELCOME_MESSAGE);
    return;
  }

  const { rec, created } = await getOrCreateTopic(ctx.api, adminGroupId, store, from);

  const header = `💬 <b>${escapeHtml(displayName(rec))}:</b>`;

  const doRelay = (record: CustomerRecord) =>
    relayMessage(ctx.api, msg, from.id, adminGroupId, header, record.topicId);

  try {
    await doRelay(rec);
  } catch (err) {
    if (!isTopicMissingError(err)) throw err;
    console.warn(`[bot] topic ${String(rec.topicId)} missing, recreating for ${String(from.id)}`);
    await store.remove(from.id);
    const fresh = await createTopicForCustomer(ctx.api, adminGroupId, store, from);
    await doRelay(fresh);
  }

  if (created) {
    try {
      await ctx.reply(
        '✅ Your message has been received. Our support team will get back to you shortly.'
      );
    } catch (err) {
      console.warn('[bot] failed to send ack to customer:', err);
    }
  }
}

async function handleAdminMessage(
  ctx: MessageContext,
  adminGroupId: number,
  store: CustomerTopicStore
): Promise<void> {
  if (ctx.chat.id !== adminGroupId) return;
  const msg = ctx.message;

  const topicId = msg.message_thread_id;
  if (topicId === undefined) return;

  if (
    msg.forum_topic_created ||
    msg.forum_topic_edited ||
    msg.forum_topic_closed ||
    msg.forum_topic_reopened ||
    msg.pinned_message
  ) {
    return;
  }

  if (ctx.from.is_bot) return;

  const rec = store.getByTopic(topicId);
  if (!rec) return;

  const text = msg.text ?? msg.caption ?? '';
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0]?.split('@')[0];
    try {
      if (cmd === '/info') {
        await ctx.api.sendMessage(adminGroupId, formatCustomerInfo(rec), {
          message_thread_id: topicId,
          parse_mode: 'HTML',
        });
      } else if (cmd === '/close') {
        await ctx.api.closeForumTopic(adminGroupId, topicId);
      } else if (cmd === '/reopen') {
        await ctx.api.reopenForumTopic(adminGroupId, topicId);
      }
    } catch (err) {
      console.warn('[bot] admin command failed:', err);
    }
    return;
  }

  const header = `🛟 <b>Support:</b>`;

  try {
    const delivered = await relayMessage(ctx.api, msg, adminGroupId, rec.customerId, header);
    if (delivered) {
      await ctx.api
        .setMessageReaction(adminGroupId, msg.message_id, [{ type: 'emoji', emoji: '👌' }])
        .catch(() => {
          // Reactions can be unsupported for some accounts/content; safe to ignore.
        });
    }
  } catch (err) {
    const description =
      err instanceof GrammyError
        ? err.description
        : err instanceof Error
          ? err.message
          : String(err);
    await ctx.api
      .sendMessage(
        adminGroupId,
        `⚠️ Could not deliver message to ${escapeHtml(displayName(rec))}: ${escapeHtml(description)}`,
        { message_thread_id: topicId }
      )
      .catch((e: unknown) => {
        console.warn('[bot] failed to post delivery error notice:', e);
      });
  }
}

async function registerCommandMenus(bot: Bot, adminGroupId: number): Promise<void> {
  try {
    await bot.api.setMyCommands([{ command: 'start', description: 'Contact support' }], {
      scope: { type: 'all_private_chats' },
    });
    await bot.api.setMyCommands(
      [
        { command: 'info', description: 'Show customer info' },
        { command: 'close', description: 'Close this support topic' },
        { command: 'reopen', description: 'Reopen this support topic' },
      ],
      { scope: { type: 'chat', chat_id: adminGroupId } }
    );
  } catch (err) {
    console.warn('[bot] failed to set command menus:', err);
  }
}

/**
 * Fail fast with a helpful message if ADMIN_GROUP_ID points to something
 * the bot can't use (wrong id, bot not in group, topics disabled, etc.).
 */
async function verifyAdminGroup(bot: Bot, adminGroupId: number): Promise<void> {
  let chat: Awaited<ReturnType<typeof bot.api.getChat>>;
  try {
    chat = await bot.api.getChat(adminGroupId);
  } catch (err) {
    if (err instanceof GrammyError) {
      throw new Error(
        [
          `Cannot access admin group ${String(adminGroupId)}: ${err.description}.`,
          `Most likely ADMIN_GROUP_ID is wrong. Note:`,
          `  • Ids you copy from web.telegram.org/k/ are NOT the Bot-API format.`,
          `  • The real id is always of the form -100<digits>, e.g. -1001234567890.`,
          `  • Easiest way to get it: leave ADMIN_GROUP_ID empty in .env,`,
          `    restart this bot (it will enter scout mode), then send any message`,
          `    in the admin group – the correct id will be printed for you.`,
          `Also make sure the bot is a member of the group and Topics is enabled.`,
        ].join('\n'),
        { cause: err }
      );
    }
    throw err;
  }

  if (chat.type !== 'supergroup') {
    throw new Error(
      `ADMIN_GROUP_ID (${String(adminGroupId)}) is a "${chat.type}", but a forum supergroup is required. ` +
        `In Telegram: Edit group → Group Type → set to a group with Topics enabled (this converts it to a supergroup).`
    );
  }
  if (!chat.is_forum) {
    throw new Error(
      `ADMIN_GROUP_ID (${String(adminGroupId)}) is a supergroup but Topics (forum mode) is OFF. ` +
        `Open the group → Edit → toggle "Topics" ON and try again.`
    );
  }
  console.log(`[bot] admin group ok: "${chat.title}" (${String(chat.id)})`);
}

/**
 * Scout mode: ADMIN_GROUP_ID is not set, so we can't relay yet. Listen for
 * any group message and tell the operator which id to paste into .env.
 */
async function runScoutMode(bot: Bot): Promise<void> {
  console.log('');
  console.log('='.repeat(70));
  console.log(' ADMIN_GROUP_ID is not set in .env — running in SCOUT MODE.');
  console.log('');
  console.log(' 1. Make sure this bot is added to your admin group.');
  console.log(' 2. Send any message in that group (e.g. type "hi").');
  console.log(' 3. Copy the printed id below into ADMIN_GROUP_ID in .env.');
  console.log(' 4. Restart the bot.');
  console.log('='.repeat(70));
  console.log('');

  bot.on('message', async (ctx) => {
    const chat = ctx.chat;
    const title = 'title' in chat && chat.title ? chat.title : '(no title)';
    const isForum = chat.type === 'supergroup' && chat.is_forum === true;

    console.log(
      `[scout] chat id=${String(chat.id)} type=${chat.type} title=${JSON.stringify(title)} is_forum=${String(isForum)}`
    );

    if (chat.type === 'private') return;

    try {
      if (chat.type === 'supergroup' && isForum) {
        await ctx.reply(
          [
            `✅ Use this id:`,
            `<code>${String(chat.id)}</code>`,
            ``,
            `Paste it into <b>ADMIN_GROUP_ID</b> in your <code>.env</code> and restart the bot.`,
          ].join('\n'),
          { parse_mode: 'HTML' }
        );
      } else {
        const hint =
          chat.type === 'supergroup'
            ? 'Topics are OFF. Enable them: Edit group → toggle "Topics" ON.'
            : 'This is a regular group. Enable "Topics" to convert it to a forum supergroup.';
        await ctx.reply([`ℹ️ id of this chat: <code>${String(chat.id)}</code>`, hint].join('\n'), {
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      console.warn('[scout] could not reply:', err);
    }
  });

  bot.catch((err) => {
    console.error('[scout] error:', err.error);
  });

  const shutdown = () => {
    bot.stop().catch(() => undefined);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await bot.start({ drop_pending_updates: true, allowed_updates: ['message'] });
}

export async function startBot(): Promise<void> {
  const bot = new Bot(config.BOT_TOKEN);
  await bot.init();

  console.log(`[bot] authenticated as @${bot.botInfo.username} (id=${String(bot.botInfo.id)})`);

  const adminGroupId = config.ADMIN_GROUP_ID;
  if (adminGroupId === undefined) {
    await runScoutMode(bot);
    return;
  }

  await verifyAdminGroup(bot, adminGroupId);

  const store = new CustomerTopicStore(config.DATA_FILE);
  await store.load();

  const botId = bot.botInfo.id;

  bot.on('message', async (ctx) => {
    if (ctx.from.id === botId) return;

    if (ctx.chat.type === 'private') {
      await handleCustomerMessage(ctx, adminGroupId, store);
      return;
    }

    if (ctx.chat.id === adminGroupId) {
      await handleAdminMessage(ctx, adminGroupId, store);
    }
  });

  bot.catch((err) => {
    const e: unknown = err.error;
    if (e instanceof GrammyError) {
      console.error('[bot] Telegram API error:', e.error_code, e.description);
    } else if (e instanceof HttpError) {
      console.error('[bot] network error:', e);
    } else {
      console.error('[bot] unexpected error:', e);
    }
  });

  await registerCommandMenus(bot, adminGroupId);

  console.log(`[bot] admin group id: ${String(adminGroupId)}`);

  const shutdown = (signal: string) => {
    console.log(`[bot] received ${signal}, stopping...`);
    bot.stop().catch((err: unknown) => {
      console.error('[bot] error while stopping:', err);
    });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  await bot.start({
    drop_pending_updates: true,
    allowed_updates: ['message'],
    onStart: (info) => {
      console.log(`[bot] long polling started for @${info.username}`);
    },
  });
}
