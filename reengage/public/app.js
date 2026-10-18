const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = { contacts: [], pollTimer: null, openCampaign: null };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function firstName(name) {
  return String(name ?? '').trim().split(/[\s,]+/)[0] || 'there';
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function flash(message, isError = false) {
  const el = $('#flash');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

async function withButton(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try { await fn(); } catch (err) { flash(err.message, true); } finally { btn.disabled = false; }
}

// ---- Tabs ----

function showTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
  if (name === 'compose') renderRecipients();
  if (name === 'campaigns') loadCampaigns();
}
$$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---- Status ----

async function loadStatus() {
  const status = await api('/api/status');
  const badge = $('#mode');
  badge.className = `badge ${status.mode}`;
  badge.textContent = status.mode === 'live' ? `Live · ${status.from}` : 'Dry run — nothing is sent';
}

// ---- Contacts ----

function contactStatus(c) {
  if (c.opted_out) return '<span class="pill bad">Opted out</span>';
  if (!c.consent) return '<span class="pill warn">No consent</span>';
  return '<span class="pill ok">Can message</span>';
}

function renderContacts() {
  const term = $('#contact-search').value.trim().toLowerCase();
  const rows = state.contacts.filter(c => !term || `${c.name} ${c.phone} ${c.notes}`.toLowerCase().includes(term));
  $('#contact-count').textContent = `(${state.contacts.length})`;
  $('#contact-rows').innerHTML = rows.length ? rows.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.phone)}</td>
      <td>${contactStatus(c)}</td>
      <td>${formatDate(c.last_contacted_at)}</td>
      <td>${esc(c.notes)}</td>
      <td>
        <button class="btn ghost small" data-edit="${c.id}">Edit</button>
        <button class="btn ghost small danger" data-delete="${c.id}">Delete</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted">No contacts yet.</td></tr>';
}

async function loadContacts() {
  state.contacts = await api('/api/contacts');
  renderContacts();
}

function resetContactForm() {
  const form = $('#contact-form');
  form.reset();
  form.id.value = '';
  $('#contact-form-title').textContent = 'Add contact';
  $('#contact-cancel').hidden = true;
  $('#optout-row').hidden = true;
}

$('#contact-search').addEventListener('input', renderContacts);
$('#contact-cancel').addEventListener('click', resetContactForm);

$('#contact-rows').addEventListener('click', async e => {
  const editId = e.target.dataset.edit;
  const deleteId = e.target.dataset.delete;
  if (editId) {
    const c = state.contacts.find(x => x.id === Number(editId));
    const form = $('#contact-form');
    form.id.value = c.id;
    form.name.value = c.name;
    form.phone.value = c.phone;
    form.notes.value = c.notes;
    form.consent.checked = !!c.consent;
    form.opted_out.checked = !!c.opted_out;
    $('#contact-form-title').textContent = 'Edit contact';
    $('#contact-cancel').hidden = false;
    $('#optout-row').hidden = false;
    form.scrollIntoView({ behavior: 'smooth' });
  }
  if (deleteId) {
    const c = state.contacts.find(x => x.id === Number(deleteId));
    if (!confirm(`Delete ${c.name}? Their message history will also be removed.`)) return;
    try {
      await api(`/api/contacts/${deleteId}`, { method: 'DELETE' });
      await loadContacts();
    } catch (err) { flash(err.message, true); }
  }
});

$('#contact-form').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  withButton(form, async () => {
    const body = {
      name: form.name.value,
      phone: form.phone.value,
      notes: form.notes.value,
      consent: form.consent.checked,
    };
    if (form.id.value) {
      body.opted_out = form.opted_out.checked;
      await api(`/api/contacts/${form.id.value}`, { method: 'PUT', body });
      flash('Contact updated.');
    } else {
      await api('/api/contacts', { method: 'POST', body });
      flash('Contact added.');
    }
    resetContactForm();
    await loadContacts();
  });
});

$('#import-form').addEventListener('submit', e => {
  e.preventDefault();
  const file = $('#csv-file').files[0];
  if (!file) return flash('Choose a CSV file first.', true);
  withButton(e.target, async () => {
    const result = await api('/api/contacts/import', { method: 'POST', body: { csv: await file.text() } });
    const errors = result.errors.map(x => `Line ${x.line}: ${esc(x.error)}`).join('<br>');
    $('#import-result').innerHTML = `Added ${result.added}, updated ${result.updated}.${errors ? '<br>' + errors : ''}`;
    e.target.reset();
    await loadContacts();
  });
});

// ---- Compose ----

function eligibleContacts() {
  return state.contacts.filter(c => c.consent && !c.opted_out);
}

function renderRecipients() {
  const list = eligibleContacts();
  $('#recipient-list').innerHTML = list.length
    ? list.map(c => `<label class="check"><input type="checkbox" value="${c.id}" checked> ${esc(c.name)} <span class="muted">${esc(c.phone)}</span></label>`).join('')
    : '<p class="muted">No contacts can be messaged yet. Add contacts and record their consent first.</p>';
  updateRecipientCount();
  updatePreview();
}

function selectedRecipients() {
  return $$('#recipient-list input:checked').map(i => Number(i.value));
}

function updateRecipientCount() {
  $('#recipient-count').textContent = `(${selectedRecipients().length} selected)`;
}

function updatePreview() {
  const sample = eligibleContacts()[0] || { name: 'Thandi Mokoena' };
  const text = $('#campaign-form').body.value
    .replaceAll('{first_name}', firstName(sample.name))
    .replaceAll('{name}', sample.name);
  $('#preview').textContent = text || '…';
}

function updateKind() {
  const kind = $('#campaign-form').kind.value;
  $('#template-fields').hidden = kind !== 'template';
  $('#text-fields').hidden = kind !== 'text';
}

$('#recipient-list').addEventListener('change', updateRecipientCount);
$('#select-all').addEventListener('click', () => { $$('#recipient-list input').forEach(i => { i.checked = true; }); updateRecipientCount(); });
$('#select-none').addEventListener('click', () => { $$('#recipient-list input').forEach(i => { i.checked = false; }); updateRecipientCount(); });
$('#campaign-form').body.addEventListener('input', updatePreview);
$$('#campaign-form input[name=kind]').forEach(r => r.addEventListener('change', updateKind));

$('#campaign-form').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const contactIds = selectedRecipients();
  if (!contactIds.length) return flash('Select at least one recipient.', true);
  const isTemplate = form.kind.value === 'template';
  if (!confirm(`Send "${form.name.value}" to ${contactIds.length} contact(s) on WhatsApp?`)) return;
  withButton(form, async () => {
    const result = await api('/api/campaigns', {
      method: 'POST',
      body: {
        name: form.name.value,
        contentSid: isTemplate ? form.contentSid.value : '',
        body: isTemplate ? '' : form.body.value,
        contactIds,
      },
    });
    flash(`Campaign started — sending to ${result.recipients} contact(s).`);
    form.reset();
    updateKind();
    showTab('campaigns');
    openCampaign(result.id);
  });
});

// ---- Campaigns ----

async function loadCampaigns() {
  const campaigns = await api('/api/campaigns');
  $('#campaign-rows').innerHTML = campaigns.length ? campaigns.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${formatDate(c.created_at)}</td>
      <td class="num">${c.total}</td>
      <td class="num">${c.sent ?? 0}</td>
      <td class="num">${c.delivered ?? 0}</td>
      <td class="num">${c.read ?? 0}</td>
      <td class="num">${c.failed ?? 0}</td>
      <td><button class="btn ghost small" data-open="${c.id}">View</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted">No campaigns yet.</td></tr>';
}

$('#campaign-rows').addEventListener('click', e => {
  if (e.target.dataset.open) openCampaign(Number(e.target.dataset.open));
});

function messagePill(m) {
  const cls = { delivered: 'ok', read: 'ok', sent: 'ok', simulated: 'ok', failed: 'bad', undelivered: 'bad', skipped: 'warn' }[m.status] || '';
  return `<span class="pill ${cls}">${esc(m.status)}</span>`;
}

async function openCampaign(id) {
  clearTimeout(state.pollTimer);
  state.openCampaign = id;
  const c = await api(`/api/campaigns/${id}`);
  if (state.openCampaign !== id) return;
  const el = $('#campaign-detail');
  el.hidden = false;
  el.innerHTML = `
    <div class="card-head">
      <h2>${esc(c.name)}</h2>
      <span class="muted">${c.sending ? 'Sending…' : 'Finished sending'}</span>
    </div>
    <p class="muted">${c.content_sid ? `Template ${esc(c.content_sid)}` : `Message: ${esc(c.body)}`}</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Contact</th><th>Number</th><th>Status</th><th>Updated</th><th>Error</th></tr></thead>
        <tbody>${c.messages.map(m => `
          <tr>
            <td>${esc(m.name)}</td>
            <td>${esc(m.phone)}</td>
            <td>${messagePill(m)}</td>
            <td>${formatDate(m.updated_at)}</td>
            <td class="muted">${esc(m.error || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  // Keep refreshing while messages are in flight so delivery updates appear.
  // Stop after 15 minutes so a missing webhook doesn't keep us polling forever.
  const recent = Date.now() - new Date(c.created_at.replace(' ', 'T') + 'Z').getTime() < 15 * 60 * 1000;
  const inFlight = c.sending || (recent && c.messages.some(m => ['queued', 'accepted', 'sending', 'sent'].includes(m.status)));
  if (inFlight) {
    state.pollTimer = setTimeout(() => {
      if (!$('#tab-campaigns').hidden) { openCampaign(id); loadCampaigns(); }
    }, 4000);
  }
}

// ---- Start ----

Promise.all([loadStatus(), loadContacts()]).catch(err => flash(err.message, true));
