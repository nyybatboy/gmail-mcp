#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runAuthFlow,
  CREDENTIALS_PATH,
  TOKEN_PATH,
  SCOPES,
} from '../lib/auth.js';
import * as G from '../lib/gmail.js';

const PROFILE_CACHE = path.join(os.homedir(), '.gmail-mcp', 'profile.json');
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function usage() {
  console.error(`gmail-cli <command> [--json '<obj>'] [--<flag> <val>...]

Auth:
  auth                              Run OAuth desktop flow (one-time, opens browser)
  auth-status                       Diagnose OAuth setup; print fix command for any failure
  whoami                            Print profile + email address (cached)

Messages:
  list-messages    --q <query> --max <n> --label <id>...
  get-message      --id <id> [--format full|metadata|minimal|raw]
  batch-get-messages --json '{"ids":[...],"format":"full","concurrency":10}'
  send             --json '{"to":"...","subject":"...","text":"...","attachments":[{"path":"..."}]}'
  modify-message   --id <id> --add <label>... --remove <label>...
  batch-modify     --json '{"ids":[...],"addLabelIds":[...],"removeLabelIds":[...]}'
  batch-delete     --json '{"ids":[...]}'
  trash-message    --id <id>
  untrash-message  --id <id>
  delete-message   --id <id>
  get-attachment   --message-id <id> --attachment-id <id> [--save-path <path>]

Drafts:
  list-drafts      --max <n> --q <query>
  get-draft        --id <id>
  create-draft     --json '{"to":"...","subject":"...","text":"...","attachments":[...]}'
  reply-draft      --json '{"toMessageId":"...","body":"...","attachments":[...],"replyAll":true}'
  update-draft     --json '{"id":"...","to":"...","subject":"...","text":"..."}'
  send-draft       --id <id>
  delete-draft     --id <id>

Threads:
  list-threads     --q <query> --max <n>
  get-thread       --id <id>
  batch-get-threads --json '{"ids":[...],"format":"full","concurrency":10}'
  modify-thread    --id <id> --add <label>... --remove <label>...
  trash-thread     --id <id>
  untrash-thread   --id <id>
  delete-thread    --id <id>

Labels:
  list-labels
  get-label        --id <id>
  create-label     --json '{"name":"...","color":{"backgroundColor":"#...","textColor":"#..."}}'
  update-label     --json '{"id":"...","name":"...","color":{...}}'
  delete-label     --id <id>

Filters:
  list-filters
  get-filter       --id <id>
  create-filter    --json '{"criteria":{...},"action":{...}}'
  delete-filter    --id <id>

Settings:
  get-vacation
  update-vacation        --json '{"enableAutoReply":true,"responseSubject":"...","responseBodyPlainText":"..."}'
  get-imap | update-imap | get-pop | update-pop | get-language | update-language
  get-auto-forwarding | update-auto-forwarding

Send-as / signatures:
  list-send-as
  get-send-as      --send-as-email <email>
  create-send-as   --json '{"sendAsEmail":"...","displayName":"...","signature":"<html>"}'
  update-send-as   --json '{"sendAsEmail":"...","signature":"<html>"}'
  delete-send-as   --send-as-email <email>
  verify-send-as   --send-as-email <email>

Forwarding addresses:
  list-forwarding-addresses | create-forwarding-address --forwarding-email <email>
  get-forwarding-address --forwarding-email <email>
  delete-forwarding-address --forwarding-email <email>

Delegates:
  list-delegates | get-delegate --delegate-email <email>
  create-delegate --delegate-email <email> | delete-delegate --delegate-email <email>

S/MIME:
  list-smime --send-as-email <email>
  get-smime --send-as-email <email> --id <id>
  insert-smime --json '{"sendAsEmail":"...","pkcs12":"<base64>","encryptedKeyPassword":"..."}'
  set-default-smime --send-as-email <email> --id <id>
  delete-smime --send-as-email <email> --id <id>

History / Watch:
  list-history --start-history-id <id> [--label-id <id>] [--types messageAdded,messageDeleted,...]
  watch        --json '{"topicName":"projects/.../topics/...","labelIds":[...]}'
  stop-watch

Common:
  --json '<obj>'   Pass full JSON args (or pipe via stdin)
  --pretty         Pretty-print JSON output (default)
  --raw            Print raw JSON without indent

Paths:
  OAuth client:  ${CREDENTIALS_PATH}
  Token cache:   ${TOKEN_PATH}
  Profile cache: ${PROFILE_CACHE}
`);
}

function readJsonFile(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readProfileCache() {
  try {
    if (!fs.existsSync(PROFILE_CACHE)) return null;
    const cached = JSON.parse(fs.readFileSync(PROFILE_CACHE, 'utf8'));
    if (Date.now() - (cached.cachedAt || 0) > PROFILE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeProfileCache(profile) {
  try {
    fs.mkdirSync(path.dirname(PROFILE_CACHE), { recursive: true });
    fs.writeFileSync(
      PROFILE_CACHE,
      JSON.stringify({ ...profile, cachedAt: Date.now() }, null, 2),
      { mode: 0o600 }
    );
  } catch {
    /* non-fatal */
  }
}

async function runAuthStatus({ json: jsonOut = false } = {}) {
  const checks = [];
  let firstFailure = null;
  function record(ok, label, detail, fix) {
    const entry = { ok, label, detail, fix };
    checks.push(entry);
    if (!ok && !firstFailure) firstFailure = entry;
  }

  // 1. OAuth client credentials present?
  const creds = readJsonFile(CREDENTIALS_PATH);
  if (!creds) {
    record(false, 'OAuth client credentials', `missing at ${CREDENTIALS_PATH}`,
      'See SETUP.md — create a Desktop OAuth client in Cloud Console, drop client_secret_*.json at this path');
  } else {
    const block = creds.installed || creds.web;
    if (!block || !block.client_id) {
      record(false, 'OAuth client credentials', 'malformed (no installed/web block)',
        'Re-download the JSON from Cloud Console; ensure it is a Desktop OAuth client');
    } else {
      record(true, 'OAuth client credentials', `${block.client_id.slice(0, 24)}…`, null);
    }
  }

  // 2. Token cache present?
  const token = readJsonFile(TOKEN_PATH);
  if (!token) {
    record(false, 'Token cached', `missing at ${TOKEN_PATH}`,
      'node bin/gmail-cli.js auth');
  } else if (!token.refresh_token) {
    record(false, 'Token cached', 'no refresh_token (consent not run with prompt=consent)',
      'rm ' + TOKEN_PATH + ' && node bin/gmail-cli.js auth');
  } else {
    record(true, 'Token cached', `refresh_token present, scope=${token.scope || '(unknown)'}`, null);
  }

  // 3. Token has Gmail scope?
  if (token?.scope) {
    const hasGmail = token.scope.includes('https://mail.google.com/') ||
      token.scope.includes('gmail.googleapis.com');
    if (!hasGmail) {
      record(false, 'Gmail scope granted', token.scope,
        'rm ' + TOKEN_PATH + ' && node bin/gmail-cli.js auth');
    } else {
      record(true, 'Gmail scope granted', SCOPES.join(' '), null);
    }
  }

  // 4. Live call (only if no prior failure)
  if (!firstFailure) {
    try {
      const profile = await G.getProfile();
      writeProfileCache({ email: profile.emailAddress, historyId: profile.historyId });
      record(true, 'Live API call (getProfile)',
        `${profile.emailAddress} (historyId=${profile.historyId})`, null);
    } catch (err) {
      record(false, 'Live API call (getProfile)', err.message,
        err.userActionable ? null : 'Check the error detail above');
    }
  } else {
    record(true, 'Live API call (getProfile)', 'skipped (prior step failed)', null);
  }

  if (jsonOut) {
    return { ok: !firstFailure, checks, firstFailure };
  }

  // Pretty print
  const lines = [];
  lines.push('gmail-mcp auth-status');
  lines.push('─'.repeat(34));
  for (const c of checks) {
    const tag = c.ok ? '[ok]  ' : '[FAIL]';
    if (c.label === 'Live API call (getProfile)' && c.detail === 'skipped (prior step failed)') {
      lines.push(`[skip] ${c.label.padEnd(28)} ${c.detail}`);
    } else {
      lines.push(`${tag} ${c.label.padEnd(28)} ${c.detail || ''}`);
    }
  }
  if (firstFailure && firstFailure.fix) {
    lines.push('');
    lines.push(`Fix:  ${firstFailure.fix}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(firstFailure ? 1 : 0);
}

async function whoamiCached() {
  const cached = readProfileCache();
  if (cached?.email) {
    return { ...cached, fromCache: true };
  }
  const profile = await G.getProfile();
  writeProfileCache({ email: profile.emailAddress, historyId: profile.historyId });
  return profile;
}

function parseArgs(argv) {
  const out = { _: [], flags: {}, multi: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags[key] = true;
        i += 1;
      } else {
        if (out.flags[key] !== undefined) {
          if (!out.multi[key]) out.multi[key] = [out.flags[key]];
          out.multi[key].push(next);
        }
        out.flags[key] = next;
        i += 2;
      }
    } else {
      out._.push(a);
      i += 1;
    }
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() || null;
}

function arr(v) {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  let json = null;
  if (args.flags.json) {
    json = JSON.parse(args.flags.json);
  } else {
    const stdin = await readStdin();
    if (stdin) json = JSON.parse(stdin);
  }

  const f = args.flags;
  const m = args.multi;
  const pretty = !f.raw;

  function out(data) {
    process.stdout.write(pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
    process.stdout.write('\n');
  }

  try {
    switch (cmd) {
      case 'auth':
        await runAuthFlow();
        out({ ok: true, savedTo: TOKEN_PATH });
        break;
      case 'auth-status': {
        const wantJson = f.json === true || f.raw === true;
        const result = await runAuthStatus({ json: wantJson });
        if (wantJson) {
          out(result);
          process.exit(result.ok ? 0 : 1);
        }
        // pretty-print path already wrote + exited inside runAuthStatus
        break;
      }
      case 'whoami':
        out(f.fresh ? await G.getProfile() : await whoamiCached());
        break;

      // Messages
      case 'list-messages':
        out(await G.listMessages({
          q: f.q, labelIds: m.label || arr(f.label),
          maxResults: f.max ? Number(f.max) : undefined,
          pageToken: f['page-token'], includeSpamTrash: f['include-spam-trash'] === true,
        }));
        break;
      case 'get-message':
        out(await G.getMessage({ id: f.id, format: f.format }));
        break;
      case 'batch-get-messages':
        if (!json) throw new Error('batch-get-messages requires --json');
        out(await G.batchGetMessages(json));
        break;
      case 'send':
        if (!json) throw new Error('send requires --json');
        out(await G.sendMessage(json));
        break;
      case 'modify-message':
        out(await G.modifyMessage({
          id: f.id,
          addLabelIds: m.add || arr(f.add) || [],
          removeLabelIds: m.remove || arr(f.remove) || [],
        }));
        break;
      case 'batch-modify':
        out(await G.batchModifyMessages(json));
        break;
      case 'batch-delete':
        out(await G.batchDeleteMessages(json));
        break;
      case 'trash-message':   out(await G.trashMessage({ id: f.id })); break;
      case 'untrash-message': out(await G.untrashMessage({ id: f.id })); break;
      case 'delete-message':  out(await G.deleteMessage({ id: f.id })); break;
      case 'get-attachment':
        out(await G.getAttachment({
          messageId: f['message-id'],
          attachmentId: f['attachment-id'],
          savePath: f['save-path'],
        }));
        break;

      // Drafts
      case 'list-drafts':
        out(await G.listDrafts({
          maxResults: f.max ? Number(f.max) : undefined,
          q: f.q, pageToken: f['page-token'],
        }));
        break;
      case 'get-draft':       out(await G.getDraft({ id: f.id, format: f.format })); break;
      case 'create-draft':    if (!json) throw new Error('create-draft requires --json'); out(await G.createDraft(json)); break;
      case 'reply-draft':     if (!json) throw new Error('reply-draft requires --json'); out(await G.createReplyDraft(json)); break;
      case 'update-draft':    if (!json) throw new Error('update-draft requires --json'); out(await G.updateDraft(json)); break;
      case 'send-draft':      out(await G.sendDraft({ id: f.id })); break;
      case 'delete-draft':    out(await G.deleteDraft({ id: f.id })); break;

      // Threads
      case 'list-threads':
        out(await G.listThreads({
          q: f.q, labelIds: m.label || arr(f.label),
          maxResults: f.max ? Number(f.max) : undefined,
          pageToken: f['page-token'], includeSpamTrash: f['include-spam-trash'] === true,
        }));
        break;
      case 'get-thread':      out(await G.getThread({ id: f.id, format: f.format })); break;
      case 'batch-get-threads':
        if (!json) throw new Error('batch-get-threads requires --json');
        out(await G.batchGetThreads(json));
        break;
      case 'modify-thread':
        out(await G.modifyThread({
          id: f.id,
          addLabelIds: m.add || arr(f.add) || [],
          removeLabelIds: m.remove || arr(f.remove) || [],
        }));
        break;
      case 'trash-thread':    out(await G.trashThread({ id: f.id })); break;
      case 'untrash-thread':  out(await G.untrashThread({ id: f.id })); break;
      case 'delete-thread':   out(await G.deleteThread({ id: f.id })); break;

      // Labels
      case 'list-labels':     out(await G.listLabels()); break;
      case 'get-label':       out(await G.getLabel({ id: f.id })); break;
      case 'create-label':    if (!json) throw new Error('create-label requires --json'); out(await G.createLabel(json)); break;
      case 'update-label':    if (!json) throw new Error('update-label requires --json'); out(await G.updateLabel(json)); break;
      case 'delete-label':    out(await G.deleteLabel({ id: f.id })); break;

      // Filters
      case 'list-filters':    out(await G.listFilters()); break;
      case 'get-filter':      out(await G.getFilter({ id: f.id })); break;
      case 'create-filter':   if (!json) throw new Error('create-filter requires --json'); out(await G.createFilter(json)); break;
      case 'delete-filter':   out(await G.deleteFilter({ id: f.id })); break;

      // Settings: vacation/imap/pop/language/auto-forward
      case 'get-vacation':            out(await G.getVacation()); break;
      case 'update-vacation':         out(await G.updateVacation(json)); break;
      case 'get-imap':                out(await G.getImap()); break;
      case 'update-imap':             out(await G.updateImap(json)); break;
      case 'get-pop':                 out(await G.getPop()); break;
      case 'update-pop':              out(await G.updatePop(json)); break;
      case 'get-language':            out(await G.getLanguage()); break;
      case 'update-language':         out(await G.updateLanguage(json)); break;
      case 'get-auto-forwarding':     out(await G.getAutoForwarding()); break;
      case 'update-auto-forwarding':  out(await G.updateAutoForwarding(json)); break;

      // Send-as
      case 'list-send-as':    out(await G.listSendAs()); break;
      case 'get-send-as':     out(await G.getSendAs({ sendAsEmail: f['send-as-email'] })); break;
      case 'create-send-as':  if (!json) throw new Error('create-send-as requires --json'); out(await G.createSendAs(json)); break;
      case 'update-send-as':  if (!json) throw new Error('update-send-as requires --json'); out(await G.updateSendAs(json)); break;
      case 'delete-send-as':  out(await G.deleteSendAs({ sendAsEmail: f['send-as-email'] })); break;
      case 'verify-send-as':  out(await G.verifySendAs({ sendAsEmail: f['send-as-email'] })); break;

      // Forwarding addresses
      case 'list-forwarding-addresses':  out(await G.listForwardingAddresses()); break;
      case 'get-forwarding-address':     out(await G.getForwardingAddress({ forwardingEmail: f['forwarding-email'] })); break;
      case 'create-forwarding-address':  out(await G.createForwardingAddress({ forwardingEmail: f['forwarding-email'] })); break;
      case 'delete-forwarding-address':  out(await G.deleteForwardingAddress({ forwardingEmail: f['forwarding-email'] })); break;

      // Delegates
      case 'list-delegates':   out(await G.listDelegates()); break;
      case 'get-delegate':     out(await G.getDelegate({ delegateEmail: f['delegate-email'] })); break;
      case 'create-delegate':  out(await G.createDelegate({ delegateEmail: f['delegate-email'] })); break;
      case 'delete-delegate':  out(await G.deleteDelegate({ delegateEmail: f['delegate-email'] })); break;

      // S/MIME
      case 'list-smime':         out(await G.listSmimeInfo({ sendAsEmail: f['send-as-email'] })); break;
      case 'get-smime':          out(await G.getSmimeInfo({ sendAsEmail: f['send-as-email'], id: f.id })); break;
      case 'insert-smime':       if (!json) throw new Error('insert-smime requires --json'); out(await G.insertSmimeInfo(json)); break;
      case 'set-default-smime':  out(await G.setDefaultSmimeInfo({ sendAsEmail: f['send-as-email'], id: f.id })); break;
      case 'delete-smime':       out(await G.deleteSmimeInfo({ sendAsEmail: f['send-as-email'], id: f.id })); break;

      // History / Watch
      case 'list-history':
        out(await G.listHistory({
          startHistoryId: f['start-history-id'],
          labelId: f['label-id'],
          historyTypes: f.types ? String(f.types).split(',') : undefined,
          maxResults: f.max ? Number(f.max) : undefined,
          pageToken: f['page-token'],
        }));
        break;
      case 'watch':       if (!json) throw new Error('watch requires --json'); out(await G.watch(json)); break;
      case 'stop-watch':  out(await G.stopWatch()); break;

      default:
        console.error(`Unknown command: ${cmd}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(JSON.stringify({
      error: err.message,
      code: err.code,
      details: err.errors || err.response?.data || null,
    }, null, 2) + '\n');
    process.exit(1);
  }
}

main();
