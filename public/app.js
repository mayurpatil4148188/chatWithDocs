const state = { documents: [], selected: null, chats: new Map(), activeChat: null, docStamp: '', typingChatId: null, showArchived: false };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
function formatText(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-•]\s+(.+)$/gm, '<span class="bullet">$1</span>');
}
const PROMPTS = ['What is this document?', 'Summarize the key points', 'List the most important details'];

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  $('#theme-icon').textContent = light ? '●' : '○';
  $('#theme-label').textContent = light ? 'Dark mode' : 'Light mode';
  $('#theme-toggle').setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  localStorage.setItem('chat-with-docs-theme', theme);
}
applyTheme(localStorage.getItem('chat-with-docs-theme') || 'dark');
$('#theme-toggle').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
$('#sidebar-toggle').onclick = () => $('#sidebar').classList.toggle('collapsed');

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function chatFor(documentId) { return state.chats.get(documentId) || []; }
function activeChat() { return state.selected ? chatFor(state.selected.id).find((chat) => chat.id === state.activeChat) : null; }
function rememberSelection() {
  if (!state.selected) return;
  localStorage.setItem('chat-with-docs-selected', state.selected.id);
  if (state.activeChat) localStorage.setItem(`chat-with-docs-chat:${state.selected.id}`, state.activeChat);
}
async function loadChats(documentId, preferredChatId = state.activeChat) {
  const chats = (await api(`/v1/documents/${documentId}/conversations?includeArchived=${state.showArchived}`)).data;
  state.chats.set(documentId, chats);
  const remembered = preferredChatId || localStorage.getItem(`chat-with-docs-chat:${documentId}`);
  state.activeChat = chats.find((chat) => chat.id === remembered)?.id || chats[0]?.id || null;
  rememberSelection();
  return chats;
}
function statusLabel(status) { return ({ queued: 'Queued', processing: 'Processing', ready: 'Ready', failed: 'Failed' }[status] || status); }
function progressFor(document) { return document.status === 'ready' ? 100 : document.status === 'failed' ? 35 : document.status === 'queued' ? 12 : 45; }
function ready() { return state.selected?.status === 'ready'; }
function resizeComposer() {
  const input = $('#question');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
function fileKind(document) {
  const name = String(document?.source_filename || document?.title || '');
  if ((document?.mime_type || '').includes('wordprocessingml') || name.toLowerCase().endsWith('.docx')) return 'DOCX';
  return 'PDF';
}
function setComposerEnabled(enabled) {
  $('#question').disabled = !enabled;
  $('#chat-form .send').disabled = !enabled;
  $('#new-chat').disabled = !enabled;
  const title = state.selected?.title || 'this document';
  $('#question').placeholder = enabled ? `Ask anything about ${title}` : 'Select a ready document to start chatting';
}
function renderScope() {
  const document = state.selected;
  const attached = $('#attached-doc');
  if (!document) {
    $('#chat-title').textContent = 'No document selected';
    $('#chat-scope').textContent = 'Choose a document in the sidebar. This chat stays empty until one is selected.';
    $('#chats-heading').textContent = 'Chats';
    $('#attached-name').textContent = 'No document in this chat';
    $('#attached-status').textContent = 'Select a file from Documents';
    $('.attached-kind').textContent = 'FILE';
    attached.classList.add('is-empty');
    $('#composer-hint').textContent = 'Select a document first. Questions only run against that file.';
    return;
  }
  const live = document.status === 'ready';
  $('#chat-title').textContent = live ? `Chatting with ${document.title}` : document.title;
  $('#chat-scope').textContent = live
    ? 'This conversation uses only the selected document.'
    : `This document is ${statusLabel(document.status).toLowerCase()} and cannot be asked yet.`;
  $('#chats-heading').textContent = `Chats in ${document.title}`;
  $('#attached-name').textContent = document.title;
  $('#attached-status').textContent = live ? 'Selected for this chat' : statusLabel(document.status);
  $('.attached-kind').textContent = fileKind(document);
  attached.classList.toggle('is-empty', !live);
  $('#composer-hint').textContent = live
    ? `Answers come only from ${document.title}.`
    : 'Wait until this document is ready before asking.';
}

function welcomeHtml() {
  const canAsk = ready();
  const chips = PROMPTS.map((prompt) => `<button class="chip" type="button" data-prompt="${escapeHtml(prompt)}" ${canAsk ? '' : 'disabled'}>${escapeHtml(prompt)}</button>`).join('');
  const title = state.selected ? `Ask about ${state.selected.title}` : 'Select a document first';
  const copy = state.selected
    ? (canAsk ? `${state.selected.title} is selected. Questions will only use this file.` : `${state.selected.title} is still processing.`)
    : 'Pick a document in the sidebar, then this chat will attach it.';
  return `<div class="welcome"><h2>${title}</h2><p>${copy}</p><div class="chips">${chips}</div></div>`;
}

function renderDocuments() {
  const root = $('#documents');
  if (!state.documents.length) { root.innerHTML = '<div class="empty">No documents yet</div>'; return; }
  root.innerHTML = '';
  for (const document of state.documents) {
    const node = $('#document-template').content.cloneNode(true);
    const item = node.querySelector('.document-item');
    const openButton = node.querySelector('.document-open');
    const deleteButton = node.querySelector('.delete-document');
    item.classList.toggle('selected', state.selected?.id === document.id);
    node.querySelector('.document-name').textContent = document.title;
    node.querySelector('.document-status').textContent = state.selected?.id === document.id
      ? `${statusLabel(document.status)} · in this chat`
      : statusLabel(document.status);
    const track = node.querySelector('.progress-track');
    if (document.status !== 'ready') {
      track.classList.remove('hidden');
      track.firstElementChild.style.width = `${progressFor(document)}%`;
    }
    openButton.onclick = () => selectDocument(document);
    deleteButton.onclick = () => deleteDocument(document);
    root.append(node);
  }
}

function renderChat() {
  const document = state.selected;
  renderScope();
  setComposerEnabled(ready());
  if (!document) {
    $('#chat-list').innerHTML = '<div class="empty">Select a document</div>';
    $('#messages').innerHTML = welcomeHtml();
    bindPrompts();
    return;
  }
  const chats = chatFor(document.id);
  if (!chats.length) {
    $('#chat-list').innerHTML = '<div class="empty">No saved chats yet</div>';
    $('#messages').innerHTML = welcomeHtml();
    bindPrompts();
    return;
  }
  if (!state.activeChat) state.activeChat = chats[0].id;
  const chatList = $('#chat-list');
  chatList.innerHTML = '';
  chats.forEach((chat) => {
    const item = globalThis.document.createElement('div');
    item.className = `nav-item chat-item ${chat.id === state.activeChat ? 'active' : ''}`;
    item.innerHTML = `<button class="chat-open" type="button"><span class="nav-title">${escapeHtml(chat.title)}</span><span class="nav-meta">${chat.archivedAt ? 'Archived' : (chat.messages.length ? `${chat.messages.length} messages` : 'New chat')}</span></button><span class="chat-actions"><button class="chat-action" type="button" title="${chat.archivedAt ? 'Restore chat' : 'Archive chat'}">${chat.archivedAt ? '↩' : '⌁'}</button></span>`;
    item.querySelector('.chat-open').onclick = () => { state.activeChat = chat.id; rememberSelection(); renderChat(); };
    const archiveButton = item.querySelector('.chat-action');
    archiveButton.onclick = async (event) => { event.stopPropagation(); await archiveConversation(chat); };
    chatList.append(item);
  });
  const messages = activeChat()?.messages ?? [];
  const typing = state.typingChatId === state.activeChat;
  $('#messages').innerHTML = messages.length || typing
    ? `<div class="thread">${messages.map((message) => `<div class="message ${message.role}"><div class="bubble">${formatText(message.text)}${message.citations?.length ? `<div class="citations">${[...new Set(message.citations.map((citation) => citation.label))].map((label) => `<span class="citation">${escapeHtml(label)}</span>`).join('')}</div>` : ''}</div></div>`).join('')}${typing ? '<div class="message assistant"><div class="bubble typing-bubble"><span class="typing-indicator" aria-label="Assistant is thinking"><i></i><i></i><i></i></span></div></div>' : ''}</div>`
    : welcomeHtml();
  bindPrompts();
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function bindPrompts() {
  for (const chip of document.querySelectorAll('.chip')) {
    chip.onclick = () => {
      if (!ready()) return;
      $('#question').value = chip.dataset.prompt;
      resizeComposer();
      $('#chat-form').requestSubmit();
    };
  }
}

async function selectDocument(document) {
  state.selected = document;
  state.activeChat = localStorage.getItem(`chat-with-docs-chat:${document.id}`);
  rememberSelection();
  renderDocuments();
  if (document.status === 'ready') await loadChats(document.id);
  else state.chats.set(document.id, []);
  renderChat();
}

async function archiveConversation(chat) {
  if (!state.selected) return;
  const archived = !chat.archivedAt;
  await api(`/v1/documents/${state.selected.id}/conversations/${chat.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived })
  });
  await loadChats(state.selected.id);
  renderChat();
}

async function deleteDocument(document) {
  if (!confirm(`Delete “${document.title}” and all of its chats and indexed content? This cannot be undone.`)) return;
  try {
    await api(`/v1/documents/${document.id}`, { method: 'DELETE' });
    state.chats.delete(document.id);
    if (state.selected?.id === document.id) { state.selected = null; state.activeChat = null; }
    await refresh();
  } catch (error) { alert(error.message); }
}

async function refresh() {
  try {
    state.documents = (await api('/v1/documents')).data;
    const remembered = localStorage.getItem('chat-with-docs-selected');
    if (state.selected) state.selected = state.documents.find((document) => document.id === state.selected.id) || null;
    if (!state.selected) state.selected = state.documents.find((document) => document.id === remembered) || state.documents.find((document) => document.status === 'ready') || state.documents[0] || null;
    const stamp = state.documents.map((document) => `${document.id}:${document.status}`).join('|') + `:${state.selected?.id || ''}`;
    if (stamp === state.docStamp) {
      setComposerEnabled(ready());
      return;
    }
    state.docStamp = stamp;
    renderDocuments();
    if (state.selected?.status === 'ready') await loadChats(state.selected.id);
    renderChat();
  } catch (error) { console.error(error); }
}

$('#file-input').onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await api('/v1/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || (file.name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'),
        contentBase64: await fileToBase64(file)
      })
    });
    await refresh();
  } catch (error) { alert(error.message); }
  event.target.value = '';
};

$('#archived-toggle').onclick = async () => {
  state.showArchived = !state.showArchived;
  $('#archived-toggle').textContent = state.showArchived ? 'Active chats' : 'Archived';
  if (state.selected?.status === 'ready') await loadChats(state.selected.id);
  renderChat();
};

$('#new-chat').onclick = async () => {
  if (!ready()) return;
  const chat = await api(`/v1/documents/${state.selected.id}/conversations`, { method: 'POST' });
  await loadChats(state.selected.id, chat.id);
  renderChat();
  $('#question').focus();
};

$('#question').addEventListener('input', resizeComposer);
$('#question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});

$('#chat-form').onsubmit = async (event) => {
  event.preventDefault();
  const input = $('#question');
  const question = input.value.trim();
  if (!question || !ready()) return;
  let chat = activeChat();
  if (!chat) {
    chat = await api(`/v1/documents/${state.selected.id}/conversations`, { method: 'POST' });
    await loadChats(state.selected.id, chat.id);
    chat = activeChat();
  }
  chat.messages.push({ role: 'user', text: question });
  if (chat.title === 'New chat') chat.title = question.slice(0, 48);
  input.value = '';
  resizeComposer();
  state.typingChatId = chat.id;
  renderChat();
  try {
    const answer = await api(`/v1/documents/${state.selected.id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, conversationId: chat.id })
    });
    state.typingChatId = null;
    await loadChats(state.selected.id, answer.conversationId || chat.id);
    const updatedChat = activeChat();
    const assistantMessage = updatedChat?.messages?.at(-1);
    if (assistantMessage?.role === 'assistant') {
      const fullText = assistantMessage.text;
      const citations = assistantMessage.citations;
      assistantMessage.text = '';
      assistantMessage.citations = [];
      renderChat();
      for (let index = 0; index < fullText.length; index += 3) {
        assistantMessage.text = fullText.slice(0, index + 3);
        renderChat();
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
      assistantMessage.citations = citations;
    }
  } catch (error) {
    state.typingChatId = null;
    chat.messages.push({ role: 'assistant', text: error.message });
  }
  renderChat();
};

refresh();
setInterval(refresh, 2500);
