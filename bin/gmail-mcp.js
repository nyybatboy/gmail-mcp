#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as G from '../lib/gmail.js';

// Each entry: tool name -> { description, inputSchema, handler }
const ADDR = {
  oneOf: [
    { type: 'string' },
    { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['email'] },
    { type: 'array', items: { oneOf: [
      { type: 'string' },
      { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['email'] },
    ] } },
  ],
};

const ATTACHMENT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Local file path. Read at send/draft time.' },
    filename: { type: 'string' },
    mimeType: { type: 'string' },
    contentBase64: { type: 'string', description: 'Inline base64 contents if no path' },
  },
};

const MESSAGE_BODY = {
  type: 'object',
  properties: {
    to: ADDR,
    cc: ADDR,
    bcc: ADDR,
    from: { description: 'Override From (must be a verified send-as alias)', ...{ oneOf: ADDR.oneOf.slice(0, 2) } },
    replyTo: { oneOf: ADDR.oneOf.slice(0, 2) },
    subject: { type: 'string' },
    text: { type: 'string', description: 'Plaintext body' },
    html: { type: 'string', description: 'HTML body. Provide both text and html for multipart/alternative.' },
    attachments: { type: 'array', items: ATTACHMENT },
    inReplyTo: { type: 'string', description: 'Message-Id of parent (for threaded replies)' },
    references: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    threadId: { type: 'string', description: 'Gmail threadId — required to dock the message into an existing thread' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['to'],
};

const TOOLS = {
  // Profile
  whoami: {
    description: 'Return Gmail profile (email, message totals, history id).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => G.getProfile(),
  },

  // Messages
  list_messages: {
    description: 'Search/list messages. q uses Gmail search syntax (from:, to:, subject:, has:attachment, newer_than:7d, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        labelIds: { type: 'array', items: { type: 'string' } },
        maxResults: { type: 'integer' },
        pageToken: { type: 'string' },
        includeSpamTrash: { type: 'boolean' },
      },
    },
    handler: G.listMessages,
  },
  get_message: {
    description: 'Get a single message by id. format: full|metadata|minimal|raw.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['full', 'metadata', 'minimal', 'raw'] },
        metadataHeaders: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    handler: G.getMessage,
  },
  batch_get_messages: {
    description: 'Fetch many messages in parallel with bounded concurrency. Returns { messages, errors }. Use this instead of looping get_message — one tool call instead of N round-trips for the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        format: { type: 'string', enum: ['full', 'metadata', 'minimal', 'raw'] },
        metadataHeaders: { type: 'array', items: { type: 'string' } },
        concurrency: { type: 'integer', description: 'Parallel fetch limit (default 10)' },
      },
      required: ['ids'],
    },
    handler: G.batchGetMessages,
  },
  send_message: {
    description: 'Send a message. Supports To/Cc/Bcc, plaintext + HTML, attachments (path or base64), threaded replies (set inReplyTo, references, threadId).',
    inputSchema: MESSAGE_BODY,
    handler: G.sendMessage,
  },
  modify_message: {
    description: 'Add/remove labels on a message. Use INBOX, UNREAD, STARRED, or any label id from list_labels.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        addLabelIds: { type: 'array', items: { type: 'string' } },
        removeLabelIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    handler: G.modifyMessage,
  },
  batch_modify_messages: {
    description: 'Batch add/remove labels across many message ids.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        addLabelIds: { type: 'array', items: { type: 'string' } },
        removeLabelIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['ids'],
    },
    handler: G.batchModifyMessages,
  },
  batch_delete_messages: {
    description: 'PERMANENTLY delete (skip Trash) up to 1000 messages by id. Irreversible.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
    handler: G.batchDeleteMessages,
  },
  trash_message:   { description: 'Move a message to Trash.',  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.trashMessage },
  untrash_message: { description: 'Restore a message from Trash.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.untrashMessage },
  delete_message:  { description: 'PERMANENTLY delete a message. Irreversible.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.deleteMessage },
  get_attachment: {
    description: 'Download an attachment. If savePath provided, writes to disk and returns metadata; otherwise returns base64 in .data.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        attachmentId: { type: 'string' },
        savePath: { type: 'string' },
      },
      required: ['messageId', 'attachmentId'],
    },
    handler: G.getAttachment,
  },

  // Drafts
  list_drafts: {
    description: 'List drafts. q uses Gmail search syntax (constrained to drafts).',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, maxResults: { type: 'integer' }, pageToken: { type: 'string' } } },
    handler: G.listDrafts,
  },
  get_draft: {
    description: 'Get a draft by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string' } }, required: ['id'] },
    handler: G.getDraft,
  },
  create_draft: {
    description: 'Create a draft. Same body shape as send_message, plus optional useSignature (default true) to auto-append the user\'s default Gmail signature from send-as. For threaded reply drafts, use create_reply_draft instead — it handles In-Reply-To/References/threadId AND quoted parent body.',
    inputSchema: {
      ...MESSAGE_BODY,
      properties: {
        ...MESSAGE_BODY.properties,
        useSignature: { type: 'boolean', description: 'Auto-append the user\'s Gmail signature from send-as (default: true). Set false for raw drafts where the body is already complete.' },
      },
    },
    handler: G.createDraft,
  },
  create_reply_draft: {
    description: 'Create a draft as a threaded reply to an existing message. Pulls In-Reply-To, References, threadId, and Re: subject from the parent so the draft appears inside the original Gmail thread. AUTO-INCLUDES the parent body as a Gmail-style quote (gmail_quote/gmail_attr/blockquote markup, byte-matched to Gmail web UI) AND auto-appends the user\'s send-as signature, so the rendered draft looks like a normal Gmail reply. THIS IS THE ONE THE DEFAULT GMAIL MCP CANNOT DO.',
    inputSchema: {
      type: 'object',
      properties: {
        toMessageId: { type: 'string', description: 'Gmail id of the message you are replying to' },
        replyAll:    { type: 'boolean', description: 'If true, Cc all original recipients' },
        body:        { type: 'string', description: 'Plaintext body' },
        html:        { type: 'string', description: 'HTML body' },
        attachments: { type: 'array', items: ATTACHMENT },
        extraTo:  ADDR,
        extraCc:  ADDR,
        extraBcc: ADDR,
        fromAlias: { description: 'Optional verified send-as alias', oneOf: ADDR.oneOf.slice(0, 2) },
        includeQuotedParent: { type: 'boolean', description: 'Append parent body as quoted reply (default: true).' },
        useSignature: { type: 'boolean', description: 'Auto-append the user\'s Gmail signature (default: true).' },
      },
      required: ['toMessageId'],
    },
    handler: G.createReplyDraft,
  },
  update_draft: {
    description: 'Replace a draft with new content. Pass id plus the same fields as create_draft.',
    inputSchema: { ...MESSAGE_BODY, properties: { ...MESSAGE_BODY.properties, id: { type: 'string' } }, required: ['id', 'to'] },
    handler: G.updateDraft,
  },
  send_draft:   { description: 'Send an existing draft.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.sendDraft },
  delete_draft: { description: 'Delete a draft.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.deleteDraft },

  // Threads
  list_threads: {
    description: 'List threads matching a query.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        labelIds: { type: 'array', items: { type: 'string' } },
        maxResults: { type: 'integer' },
        pageToken: { type: 'string' },
        includeSpamTrash: { type: 'boolean' },
      },
    },
    handler: G.listThreads,
  },
  get_thread: {
    description: 'Get a thread by id with all messages.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, format: { type: 'string' }, metadataHeaders: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
    handler: G.getThread,
  },
  batch_get_threads: {
    description: 'Fetch many threads in parallel with bounded concurrency. Returns { threads, errors }. Most useful for analysis flows that need full conversation context across many threads at once.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        format: { type: 'string', enum: ['full', 'metadata', 'minimal'] },
        metadataHeaders: { type: 'array', items: { type: 'string' } },
        concurrency: { type: 'integer', description: 'Parallel fetch limit (default 10)' },
      },
      required: ['ids'],
    },
    handler: G.batchGetThreads,
  },
  modify_thread: {
    description: 'Add/remove labels on a thread (applies to all messages).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, addLabelIds: { type: 'array', items: { type: 'string' } }, removeLabelIds: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
    handler: G.modifyThread,
  },
  trash_thread:   { description: 'Move a thread to Trash.',   inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.trashThread },
  untrash_thread: { description: 'Restore a thread from Trash.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.untrashThread },
  delete_thread:  { description: 'PERMANENTLY delete a thread.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.deleteThread },

  // Labels
  list_labels: { description: 'List all labels (system + user).', inputSchema: { type: 'object', properties: {} }, handler: G.listLabels },
  get_label:   { description: 'Get a label by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.getLabel },
  create_label: {
    description: 'Create a label. color: { backgroundColor, textColor } (hex; must be from Gmail palette).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        labelListVisibility: { type: 'string', enum: ['labelShow', 'labelShowIfUnread', 'labelHide'] },
        messageListVisibility: { type: 'string', enum: ['show', 'hide'] },
        color: { type: 'object', properties: { backgroundColor: { type: 'string' }, textColor: { type: 'string' } } },
      },
      required: ['name'],
    },
    handler: G.createLabel,
  },
  update_label: {
    description: 'Update a label (name, visibility, color).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        labelListVisibility: { type: 'string' },
        messageListVisibility: { type: 'string' },
        color: { type: 'object' },
      },
      required: ['id'],
    },
    handler: G.updateLabel,
  },
  delete_label: { description: 'Delete a label.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.deleteLabel },

  // Filters
  list_filters: { description: 'List Gmail filters.', inputSchema: { type: 'object', properties: {} }, handler: G.listFilters },
  get_filter:   { description: 'Get a filter by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.getFilter },
  create_filter: {
    description: 'Create a filter. criteria: {from, to, subject, query, hasAttachment, ...}; action: {addLabelIds, removeLabelIds, forward}.',
    inputSchema: {
      type: 'object',
      properties: {
        criteria: { type: 'object' },
        action:   { type: 'object' },
      },
      required: ['criteria', 'action'],
    },
    handler: G.createFilter,
  },
  delete_filter: { description: 'Delete a filter.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, handler: G.deleteFilter },

  // Settings
  get_vacation:    { description: 'Get vacation auto-responder settings.', inputSchema: { type: 'object', properties: {} }, handler: G.getVacation },
  update_vacation: {
    description: 'Update vacation auto-responder.',
    inputSchema: {
      type: 'object',
      properties: {
        enableAutoReply: { type: 'boolean' },
        responseSubject: { type: 'string' },
        responseBodyPlainText: { type: 'string' },
        responseBodyHtml: { type: 'string' },
        restrictToContacts: { type: 'boolean' },
        restrictToDomain: { type: 'boolean' },
        startTime: { type: 'string', description: 'epoch ms' },
        endTime: { type: 'string', description: 'epoch ms' },
      },
    },
    handler: G.updateVacation,
  },
  get_imap:    { description: 'Get IMAP settings.', inputSchema: { type: 'object', properties: {} }, handler: G.getImap },
  update_imap: { description: 'Update IMAP settings.', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, autoExpunge: { type: 'boolean' }, expungeBehavior: { type: 'string' }, maxFolderSize: { type: 'integer' } } }, handler: G.updateImap },
  get_pop:     { description: 'Get POP settings.', inputSchema: { type: 'object', properties: {} }, handler: G.getPop },
  update_pop:  { description: 'Update POP settings.', inputSchema: { type: 'object', properties: { accessWindow: { type: 'string' }, disposition: { type: 'string' } } }, handler: G.updatePop },
  get_language:    { description: 'Get language setting.', inputSchema: { type: 'object', properties: {} }, handler: G.getLanguage },
  update_language: { description: 'Update language setting.', inputSchema: { type: 'object', properties: { displayLanguage: { type: 'string' } } }, handler: G.updateLanguage },
  get_auto_forwarding:    { description: 'Get auto-forwarding settings.', inputSchema: { type: 'object', properties: {} }, handler: G.getAutoForwarding },
  update_auto_forwarding: { description: 'Update auto-forwarding (forward all incoming mail).', inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' }, emailAddress: { type: 'string' }, disposition: { type: 'string' } } }, handler: G.updateAutoForwarding },

  // Send-as / signatures
  list_send_as:   { description: 'List send-as aliases (each carries its own signature).', inputSchema: { type: 'object', properties: {} }, handler: G.listSendAs },
  get_send_as:    { description: 'Get a send-as alias by email.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' } }, required: ['sendAsEmail'] }, handler: G.getSendAs },
  create_send_as: {
    description: 'Create a send-as alias (custom From + signature).',
    inputSchema: {
      type: 'object',
      properties: {
        sendAsEmail: { type: 'string' },
        displayName: { type: 'string' },
        replyToAddress: { type: 'string' },
        signature: { type: 'string', description: 'HTML signature' },
        isDefault: { type: 'boolean' },
        treatAsAlias: { type: 'boolean' },
      },
      required: ['sendAsEmail'],
    },
    handler: G.createSendAs,
  },
  update_send_as: {
    description: 'Update a send-as alias (e.g. change the signature).',
    inputSchema: {
      type: 'object',
      properties: {
        sendAsEmail: { type: 'string' },
        displayName: { type: 'string' },
        replyToAddress: { type: 'string' },
        signature: { type: 'string' },
        isDefault: { type: 'boolean' },
        treatAsAlias: { type: 'boolean' },
      },
      required: ['sendAsEmail'],
    },
    handler: G.updateSendAs,
  },
  delete_send_as: { description: 'Delete a send-as alias.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' } }, required: ['sendAsEmail'] }, handler: G.deleteSendAs },
  verify_send_as: { description: 'Send the verification email for a send-as alias.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' } }, required: ['sendAsEmail'] }, handler: G.verifySendAs },

  // Forwarding addresses
  list_forwarding_addresses:  { description: 'List approved forwarding addresses.', inputSchema: { type: 'object', properties: {} }, handler: G.listForwardingAddresses },
  get_forwarding_address:     { description: 'Get a forwarding address.', inputSchema: { type: 'object', properties: { forwardingEmail: { type: 'string' } }, required: ['forwardingEmail'] }, handler: G.getForwardingAddress },
  create_forwarding_address:  { description: 'Add a forwarding address (sends a verification email).', inputSchema: { type: 'object', properties: { forwardingEmail: { type: 'string' } }, required: ['forwardingEmail'] }, handler: G.createForwardingAddress },
  delete_forwarding_address:  { description: 'Remove a forwarding address.', inputSchema: { type: 'object', properties: { forwardingEmail: { type: 'string' } }, required: ['forwardingEmail'] }, handler: G.deleteForwardingAddress },

  // Delegates
  list_delegates:  { description: 'List delegate accounts.', inputSchema: { type: 'object', properties: {} }, handler: G.listDelegates },
  get_delegate:    { description: 'Get a delegate.', inputSchema: { type: 'object', properties: { delegateEmail: { type: 'string' } }, required: ['delegateEmail'] }, handler: G.getDelegate },
  create_delegate: { description: 'Add a delegate (Workspace only; sends acceptance email).', inputSchema: { type: 'object', properties: { delegateEmail: { type: 'string' } }, required: ['delegateEmail'] }, handler: G.createDelegate },
  delete_delegate: { description: 'Remove a delegate.', inputSchema: { type: 'object', properties: { delegateEmail: { type: 'string' } }, required: ['delegateEmail'] }, handler: G.deleteDelegate },

  // S/MIME
  list_smime:        { description: 'List S/MIME configs for a send-as alias.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' } }, required: ['sendAsEmail'] }, handler: G.listSmimeInfo },
  get_smime:         { description: 'Get an S/MIME config.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' }, id: { type: 'string' } }, required: ['sendAsEmail', 'id'] }, handler: G.getSmimeInfo },
  insert_smime:      { description: 'Upload a PKCS#12 cert as S/MIME for a send-as alias.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' }, pkcs12: { type: 'string' }, encryptedKeyPassword: { type: 'string' } }, required: ['sendAsEmail', 'pkcs12'] }, handler: G.insertSmimeInfo },
  set_default_smime: { description: 'Set the default S/MIME for a send-as alias.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' }, id: { type: 'string' } }, required: ['sendAsEmail', 'id'] }, handler: G.setDefaultSmimeInfo },
  delete_smime:      { description: 'Delete an S/MIME config.', inputSchema: { type: 'object', properties: { sendAsEmail: { type: 'string' }, id: { type: 'string' } }, required: ['sendAsEmail', 'id'] }, handler: G.deleteSmimeInfo },

  // History / Watch
  list_history: {
    description: 'Incremental sync of mailbox changes since startHistoryId. Returns messageAdded/Deleted/LabelAdded/LabelRemoved events.',
    inputSchema: {
      type: 'object',
      properties: {
        startHistoryId: { type: 'string' },
        labelId: { type: 'string' },
        historyTypes: { type: 'array', items: { type: 'string', enum: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'] } },
        maxResults: { type: 'integer' },
        pageToken: { type: 'string' },
      },
      required: ['startHistoryId'],
    },
    handler: G.listHistory,
  },
  watch: {
    description: 'Subscribe to push notifications via a Cloud Pub/Sub topic. Requires Pub/Sub setup; rarely needed for personal use.',
    inputSchema: {
      type: 'object',
      properties: {
        topicName: { type: 'string' },
        labelIds: { type: 'array', items: { type: 'string' } },
        labelFilterAction: { type: 'string', enum: ['include', 'exclude'] },
      },
      required: ['topicName'],
    },
    handler: G.watch,
  },
  stop_watch: { description: 'Stop push notifications.', inputSchema: { type: 'object', properties: {} }, handler: G.stopWatch },
};

const server = new Server(
  { name: 'gmail-max', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = TOOLS[name];
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await tool.handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: err.message,
        code: err.code,
        details: err.errors || err.response?.data || null,
      }, null, 2) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
