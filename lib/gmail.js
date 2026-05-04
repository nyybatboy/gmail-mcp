import fs from 'node:fs';
import { google } from 'googleapis';
import { getAuthClient, mapApiError } from './auth.js';
import { buildRawMessage } from './mime.js';

let _client = null;

async function gmail() {
  if (_client) return _client;
  const auth = await getAuthClient();
  _client = google.gmail({ version: 'v1', auth });
  return _client;
}

// Single chokepoint for error mapping. Every wrapper below awaits its
// API call inside `safe(...)`. We tried a recursive Proxy on the gmail
// client first; googleapis defines resource properties (users, messages,
// etc.) as non-configurable read-only data properties, which breaks the
// JS Proxy invariant when we try to return wrapped versions. Per-call
// wrapping is the reliable path.
async function safe(promise) {
  try {
    return await promise;
  } catch (err) {
    throw mapApiError(err);
  }
}

const ME = 'me';

// ---------- Profile ----------

export async function getProfile() {
  const g = await gmail();
  const { data } = await safe(g.users.getProfile({ userId: ME }));
  return data;
}

// ---------- Messages ----------

export async function listMessages({ q, labelIds, maxResults = 50, pageToken, includeSpamTrash } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.messages.list({
    userId: ME, q, labelIds, maxResults, pageToken, includeSpamTrash,
  }));
  return data;
}

export async function getMessage({ id, format = 'full', metadataHeaders } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.messages.get({ userId: ME, id, format, metadataHeaders }));
  return data;
}

/**
 * Fetch many messages in parallel with bounded concurrency. Promise.allSettled
 * so one failure doesn't kill the batch. Returns { messages, errors }.
 *
 * Note: Node googleapis lacks a clean BatchHttpRequest; this is the practical
 * Promise.all + chunking pattern that taylorwilsdon/google_workspace_mcp uses
 * (`get_gmail_messages_content_batch`). N parallel HTTP roundtrips, but
 * Gmail's per-second quota (250) makes this cheap up to N≈50.
 */
export async function batchGetMessages({ ids, format = 'full', metadataHeaders, concurrency = 10 } = {}) {
  const messages = [];
  const errors = [];
  const all = ids || [];
  for (let i = 0; i < all.length; i += concurrency) {
    const chunk = all.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((id) => getMessage({ id, format, metadataHeaders }))
    );
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') messages.push(r.value);
      else errors.push({ id: chunk[j], error: r.reason?.message || String(r.reason) });
    });
  }
  return { messages, errors };
}

export async function sendMessage(opts) {
  const g = await gmail();
  const raw = buildRawMessage(opts);
  const requestBody = { raw };
  if (opts.threadId) requestBody.threadId = opts.threadId;
  const { data } = await safe(g.users.messages.send({ userId: ME, requestBody }));
  return data;
}

export async function modifyMessage({ id, addLabelIds = [], removeLabelIds = [] }) {
  const g = await gmail();
  const { data } = await safe(g.users.messages.modify({
    userId: ME, id, requestBody: { addLabelIds, removeLabelIds },
  }));
  return data;
}

export async function batchModifyMessages({ ids, addLabelIds = [], removeLabelIds = [] }) {
  const g = await gmail();
  await safe(g.users.messages.batchModify({
    userId: ME, requestBody: { ids, addLabelIds, removeLabelIds },
  }));
  return { ok: true, count: ids.length };
}

export async function batchDeleteMessages({ ids }) {
  const g = await gmail();
  await safe(g.users.messages.batchDelete({ userId: ME, requestBody: { ids } }));
  return { ok: true, count: ids.length };
}

export async function trashMessage({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.messages.trash({ userId: ME, id }));
  return data;
}

export async function untrashMessage({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.messages.untrash({ userId: ME, id }));
  return data;
}

export async function deleteMessage({ id }) {
  const g = await gmail();
  await safe(g.users.messages.delete({ userId: ME, id }));
  return { ok: true };
}

export async function getAttachment({ messageId, attachmentId, savePath } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.messages.attachments.get({
    userId: ME, messageId, id: attachmentId,
  }));
  if (savePath) {
    const buf = Buffer.from(data.data, 'base64');
    fs.writeFileSync(savePath, buf);
    return { savedTo: savePath, size: buf.length, attachmentId };
  }
  return data;
}

// ---------- Drafts ----------

export async function listDrafts({ maxResults = 50, q, pageToken } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.drafts.list({ userId: ME, maxResults, q, pageToken }));
  return data;
}

export async function getDraft({ id, format = 'full' } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.drafts.get({ userId: ME, id, format }));
  return data;
}

export async function createDraft(opts) {
  const g = await gmail();
  const composed = await applySignature(opts);
  const raw = buildRawMessage(composed);
  const message = { raw };
  if (composed.threadId) message.threadId = composed.threadId;
  const { data } = await safe(g.users.drafts.create({
    userId: ME, requestBody: { message },
  }));
  return data;
}

// ---------- Signature (auto-prepend from send-as) ----------

let _signatureCache = null;

async function ensureSignatureCache() {
  if (_signatureCache) return;
  const list = await listSendAs();
  _signatureCache = new Map();
  let defaultSig = null;
  for (const sa of list.sendAs || []) {
    const entry = {
      sendAsEmail: sa.sendAsEmail,
      html: sa.signature || '',
      text: stripHtml(sa.signature || ''),
    };
    _signatureCache.set(sa.sendAsEmail, entry);
    if (sa.isDefault) defaultSig = entry;
    if (!defaultSig && sa.isPrimary) defaultSig = entry;
  }
  if (defaultSig) _signatureCache.set('__default__', defaultSig);
}

export function clearSignatureCache() {
  _signatureCache = null;
}

async function getSignatureFor(fromEmail = null) {
  await ensureSignatureCache();
  const key = fromEmail && _signatureCache.has(fromEmail) ? fromEmail : '__default__';
  const entry = _signatureCache.get(key);
  return entry && entry.html ? entry : null;
}

/**
 * Append the user's Gmail signature to text/html body. Matches Gmail web UI:
 * - Plaintext: "\n\n-- \n<sig text>" (RFC 3676 sig delimiter)
 * - HTML:      <br><br><div class="gmail_signature" data-smartmail="gmail_signature">...</div>
 *
 * Skips when opts.useSignature === false or no signature is configured.
 */
async function applySignature(opts) {
  if (opts.useSignature === false) return opts;
  const fromEmail = typeof opts.from === 'string'
    ? opts.from
    : opts.from?.email || null;
  const sig = await getSignatureFor(fromEmail);
  if (!sig) return opts;

  const { useSignature: _drop, ...rest } = opts;
  const userText = opts.text || '';
  const userHtml = opts.html || '';

  return {
    ...rest,
    text: userText
      ? `${userText.replace(/\s+$/, '')}\n\n-- \n${sig.text}`
      : `-- \n${sig.text}`,
    html: userHtml
      ? `${userHtml}<br><br><div class="gmail_signature" data-smartmail="gmail_signature">${sig.html}</div>`
      : `<div class="gmail_signature" data-smartmail="gmail_signature">${sig.html}</div>`,
  };
}

function decodeBase64Url(s) {
  if (!s) return '';
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

// Walk a Gmail payload tree and return the first matching mimeType part body.
function findBody(payload, mimeType) {
  if (!payload) return '';
  if (payload.mimeType === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const child of payload.parts || []) {
    const found = findBody(child, mimeType);
    if (found) return found;
  }
  return '';
}

function formatReplyHeader(parentHeaders) {
  // Mimics Gmail's "On <Day>, <Mon> <D>, <YYYY> at <H>:<MM> <AM/PM>, <Sender> wrote:"
  const dateStr = parentHeaders['date'];
  const from = parentHeaders['from'] || '(unknown sender)';
  let datePart = '';
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const day = d.toLocaleDateString('en-US', { weekday: 'short' });
      const month = d.toLocaleDateString('en-US', { month: 'short' });
      const dayNum = d.getDate();
      const year = d.getFullYear();
      let hours = d.getHours();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      const minutes = String(d.getMinutes()).padStart(2, '0');
      datePart = `${day}, ${month} ${dayNum}, ${year} at ${hours}:${minutes} ${ampm}`;
    }
  }
  return datePart
    ? `On ${datePart}, ${from} wrote:`
    : `On <unknown date>, ${from} wrote:`;
}

function quoteAsText(parentText) {
  if (!parentText) return '';
  return parentText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

// Match Gmail's exact inline style bytes (verified against web-UI emitted markup).
const GMAIL_BLOCKQUOTE_STYLE =
  'margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex';

function quoteAsHtml(parentHtml, parentText) {
  if (parentHtml) {
    return `<blockquote class="gmail_quote" style="${GMAIL_BLOCKQUOTE_STYLE}">${parentHtml}</blockquote>`;
  }
  if (parentText) {
    const escaped = parentText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r?\n/g, '<br>');
    return `<blockquote class="gmail_quote" style="${GMAIL_BLOCKQUOTE_STYLE}">${escaped}</blockquote>`;
  }
  return '';
}

/**
 * Create a draft as a threaded reply to an existing message.
 *
 * Sets In-Reply-To, References, threadId, and Subject from the parent so the draft
 * docks into the original Gmail thread. ALSO appends the parent's body as quoted
 * text below the user's reply — this matches Gmail's UI reply convention so the
 * draft looks like a normal reply, not a stripped one.
 */
export async function createReplyDraft({
  toMessageId, replyAll = false, body, html, attachments, extraTo, extraCc, extraBcc, fromAlias,
  includeQuotedParent = true, useSignature = true,
}) {
  // Fetch full parent so we have body parts (not just metadata).
  const parent = await getMessage({ id: toMessageId, format: 'full' });
  const headers = Object.fromEntries(
    (parent.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])
  );
  const parentMessageId = headers['message-id'];
  const references = [headers['references'], parentMessageId].filter(Boolean).join(' ');
  const subject = headers['subject'] || '';
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;

  const replyTo = headers['reply-to'] || headers['from'];
  const to = [replyTo, ...(extraTo ? (Array.isArray(extraTo) ? extraTo : [extraTo]) : [])].filter(Boolean);
  let cc = extraCc ? (Array.isArray(extraCc) ? [...extraCc] : [extraCc]) : [];
  if (replyAll) {
    if (headers['to']) cc.push(headers['to']);
    if (headers['cc']) cc.push(headers['cc']);
  }

  // Apply signature to user body BEFORE the quoted parent is appended,
  // matching Gmail's web UI reply order: [body] + [signature] + [quoted parent].
  const fromEmailForSig =
    typeof fromAlias === 'string' ? fromAlias : fromAlias?.email || null;
  const signed = useSignature
    ? await applySignature({ text: body || '', html: html || '', from: fromEmailForSig })
    : { text: body || '', html: html || '' };

  let finalText = signed.text || '';
  let finalHtml = signed.html || '';

  if (includeQuotedParent) {
    const parentText = findBody(parent.payload, 'text/plain');
    const parentHtml = findBody(parent.payload, 'text/html');
    const replyHeader = formatReplyHeader(headers);

    if (parentText || parentHtml) {
      const quotedText = quoteAsText(parentText || stripHtml(parentHtml));
      finalText = `${finalText}\n\n${replyHeader}\n${quotedText}`;

      const userHtml = signed.html || (signed.text ? signed.text.replace(/\r?\n/g, '<br>') : '');
      const quotedHtml = quoteAsHtml(parentHtml, parentText);
      // Gmail's emitted structure: outer div.gmail_quote wraps the attribution div
      // and the inner blockquote.gmail_quote. Verified against Gmail web UI markup.
      finalHtml =
        `<div>${userHtml}</div><br>` +
        `<div class="gmail_quote">` +
          `<div class="gmail_attr">${replyHeader}<br></div>` +
          quotedHtml +
        `</div>`;
    }
  }

  return createDraft({
    to,
    cc: cc.length ? cc : undefined,
    bcc: extraBcc,
    from: fromAlias,
    subject: replySubject,
    useSignature: false, // already applied above
    text: finalText,
    html: finalHtml,
    attachments,
    inReplyTo: parentMessageId,
    references,
    threadId: parent.threadId,
  });
}

function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function updateDraft({ id, ...opts }) {
  const g = await gmail();
  const raw = buildRawMessage(opts);
  const message = { raw };
  if (opts.threadId) message.threadId = opts.threadId;
  const { data } = await safe(g.users.drafts.update({
    userId: ME, id, requestBody: { message },
  }));
  return data;
}

export async function sendDraft({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.drafts.send({
    userId: ME, requestBody: { id },
  }));
  return data;
}

export async function deleteDraft({ id }) {
  const g = await gmail();
  await safe(g.users.drafts.delete({ userId: ME, id }));
  return { ok: true };
}

// ---------- Threads ----------

export async function listThreads({ q, labelIds, maxResults = 50, pageToken, includeSpamTrash } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.threads.list({
    userId: ME, q, labelIds, maxResults, pageToken, includeSpamTrash,
  }));
  return data;
}

export async function getThread({ id, format = 'full', metadataHeaders } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.threads.get({ userId: ME, id, format, metadataHeaders }));
  return data;
}

export async function batchGetThreads({ ids, format = 'full', metadataHeaders, concurrency = 10 } = {}) {
  const threads = [];
  const errors = [];
  const all = ids || [];
  for (let i = 0; i < all.length; i += concurrency) {
    const chunk = all.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map((id) => getThread({ id, format, metadataHeaders }))
    );
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') threads.push(r.value);
      else errors.push({ id: chunk[j], error: r.reason?.message || String(r.reason) });
    });
  }
  return { threads, errors };
}

export async function modifyThread({ id, addLabelIds = [], removeLabelIds = [] }) {
  const g = await gmail();
  const { data } = await safe(g.users.threads.modify({
    userId: ME, id, requestBody: { addLabelIds, removeLabelIds },
  }));
  return data;
}

export async function trashThread({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.threads.trash({ userId: ME, id }));
  return data;
}

export async function untrashThread({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.threads.untrash({ userId: ME, id }));
  return data;
}

export async function deleteThread({ id }) {
  const g = await gmail();
  await safe(g.users.threads.delete({ userId: ME, id }));
  return { ok: true };
}

// ---------- Labels ----------

export async function listLabels() {
  const g = await gmail();
  const { data } = await safe(g.users.labels.list({ userId: ME }));
  return data;
}

export async function getLabel({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.labels.get({ userId: ME, id }));
  return data;
}

export async function createLabel({ name, labelListVisibility = 'labelShow', messageListVisibility = 'show', color }) {
  const g = await gmail();
  const requestBody = { name, labelListVisibility, messageListVisibility };
  if (color) requestBody.color = color;
  const { data } = await safe(g.users.labels.create({ userId: ME, requestBody }));
  return data;
}

export async function updateLabel({ id, ...patch }) {
  const g = await gmail();
  const { data } = await safe(g.users.labels.patch({ userId: ME, id, requestBody: patch }));
  return data;
}

export async function deleteLabel({ id }) {
  const g = await gmail();
  await safe(g.users.labels.delete({ userId: ME, id }));
  return { ok: true };
}

// ---------- Filters ----------

export async function listFilters() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.filters.list({ userId: ME }));
  return data;
}

export async function getFilter({ id }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.filters.get({ userId: ME, id }));
  return data;
}

export async function createFilter({ criteria, action }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.filters.create({
    userId: ME, requestBody: { criteria, action },
  }));
  return data;
}

export async function deleteFilter({ id }) {
  const g = await gmail();
  await safe(g.users.settings.filters.delete({ userId: ME, id }));
  return { ok: true };
}

// ---------- Settings: vacation / IMAP / POP / language / auto-forward ----------

export async function getVacation() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.getVacation({ userId: ME }));
  return data;
}

export async function updateVacation(settings) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.updateVacation({ userId: ME, requestBody: settings }));
  return data;
}

export async function getImap() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.getImap({ userId: ME }));
  return data;
}
export async function updateImap(settings) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.updateImap({ userId: ME, requestBody: settings }));
  return data;
}

export async function getPop() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.getPop({ userId: ME }));
  return data;
}
export async function updatePop(settings) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.updatePop({ userId: ME, requestBody: settings }));
  return data;
}

export async function getLanguage() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.getLanguage({ userId: ME }));
  return data;
}
export async function updateLanguage(settings) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.updateLanguage({ userId: ME, requestBody: settings }));
  return data;
}

export async function getAutoForwarding() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.getAutoForwarding({ userId: ME }));
  return data;
}
export async function updateAutoForwarding(settings) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.updateAutoForwarding({ userId: ME, requestBody: settings }));
  return data;
}

// ---------- Send-as aliases (signatures live here) ----------

export async function listSendAs() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.list({ userId: ME }));
  return data;
}

export async function getSendAs({ sendAsEmail }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.get({ userId: ME, sendAsEmail }));
  return data;
}

export async function createSendAs(settings) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.create({ userId: ME, requestBody: settings }));
  return data;
}

export async function updateSendAs({ sendAsEmail, ...patch }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.patch({ userId: ME, sendAsEmail, requestBody: patch }));
  return data;
}

export async function deleteSendAs({ sendAsEmail }) {
  const g = await gmail();
  await safe(g.users.settings.sendAs.delete({ userId: ME, sendAsEmail }));
  return { ok: true };
}

export async function verifySendAs({ sendAsEmail }) {
  const g = await gmail();
  await safe(g.users.settings.sendAs.verify({ userId: ME, sendAsEmail }));
  return { ok: true };
}

// ---------- Forwarding addresses ----------

export async function listForwardingAddresses() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.forwardingAddresses.list({ userId: ME }));
  return data;
}

export async function getForwardingAddress({ forwardingEmail }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.forwardingAddresses.get({ userId: ME, forwardingEmail }));
  return data;
}

export async function createForwardingAddress({ forwardingEmail }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.forwardingAddresses.create({
    userId: ME, requestBody: { forwardingEmail },
  }));
  return data;
}

export async function deleteForwardingAddress({ forwardingEmail }) {
  const g = await gmail();
  await safe(g.users.settings.forwardingAddresses.delete({ userId: ME, forwardingEmail }));
  return { ok: true };
}

// ---------- Delegates ----------

export async function listDelegates() {
  const g = await gmail();
  const { data } = await safe(g.users.settings.delegates.list({ userId: ME }));
  return data;
}

export async function getDelegate({ delegateEmail }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.delegates.get({ userId: ME, delegateEmail }));
  return data;
}

export async function createDelegate({ delegateEmail }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.delegates.create({
    userId: ME, requestBody: { delegateEmail },
  }));
  return data;
}

export async function deleteDelegate({ delegateEmail }) {
  const g = await gmail();
  await safe(g.users.settings.delegates.delete({ userId: ME, delegateEmail }));
  return { ok: true };
}

// ---------- S/MIME ----------

export async function listSmimeInfo({ sendAsEmail }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.smimeInfo.list({ userId: ME, sendAsEmail }));
  return data;
}

export async function getSmimeInfo({ sendAsEmail, id }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.smimeInfo.get({ userId: ME, sendAsEmail, id }));
  return data;
}

export async function insertSmimeInfo({ sendAsEmail, pkcs12, encryptedKeyPassword }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.smimeInfo.insert({
    userId: ME, sendAsEmail, requestBody: { pkcs12, encryptedKeyPassword },
  }));
  return data;
}

export async function setDefaultSmimeInfo({ sendAsEmail, id }) {
  const g = await gmail();
  const { data } = await safe(g.users.settings.sendAs.smimeInfo.setDefault({ userId: ME, sendAsEmail, id }));
  return data;
}

export async function deleteSmimeInfo({ sendAsEmail, id }) {
  const g = await gmail();
  await safe(g.users.settings.sendAs.smimeInfo.delete({ userId: ME, sendAsEmail, id }));
  return { ok: true };
}

// ---------- History / Watch ----------

export async function listHistory({ startHistoryId, labelId, historyTypes, maxResults = 100, pageToken } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.history.list({
    userId: ME, startHistoryId, labelId, historyTypes, maxResults, pageToken,
  }));
  return data;
}

export async function watch({ topicName, labelIds, labelFilterAction = 'include' } = {}) {
  const g = await gmail();
  const { data } = await safe(g.users.watch({
    userId: ME, requestBody: { topicName, labelIds, labelFilterAction },
  }));
  return data;
}

export async function stopWatch() {
  const g = await gmail();
  await safe(g.users.stop({ userId: ME }));
  return { ok: true };
}
