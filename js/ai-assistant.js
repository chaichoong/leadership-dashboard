// ══════════════════════════════════════════
// AI ASSISTANT — Chat Panel, Context Gathering, Streaming
// ══════════════════════════════════════════
    // ══════════════════════════════════════════
    // AI ASSISTANT
    // ══════════════════════════════════════════

    const AI_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';

    // Store computed dashboard state for AI context
    let dashboardState = {};

    function updateDashboardState(state) {
        dashboardState = state;
    }

    // Quick actions — rotate based on active tab
    const AI_ACTIONS = {
        overview: [
            { label: 'Summarise Financial Health', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'Give me a concise summary of the current financial health based on the dashboard data. Include opening balance, income vs costs, operating cushion (revenue minus fixed costs), and any concerns.' },
            { label: 'Cash Flow Report', model: AI_MODEL_DEFAULT, maxTokens: 2000, prompt: 'Generate a detailed 31-day cash flow forecast report. Include the daily projections, highlight risk dates where the balance drops low, and suggest actions to maintain positive cash flow.' },
            { label: 'Compare vs Budget', model: AI_MODEL_DEFAULT, maxTokens: 1500, prompt: 'Compare actual spending against budget targets for maintenance, wages, and CFV. Identify which are over/under budget and by how much. Suggest corrective actions.' },
            { label: 'Weekly Briefing', model: AI_MODEL_DEFAULT, maxTokens: 3000, prompt: 'Generate a professional weekly briefing I can share with stakeholders. Cover financial position, operational metrics, key risks, and recommended actions. Format with clear headers.' },
        ],
        cfv: [
            { label: 'Analyse CFV Risk', model: AI_MODEL_DEFAULT, maxTokens: 2000, prompt: 'Analyse all current cash flow voids. For each CFV tenancy, assess the risk level, days overdue, and recommended action. Prioritise by exposure amount.' },
            { label: 'CFV Action Plan', model: AI_MODEL_DEFAULT, maxTokens: 1500, prompt: 'Create an action plan for resolving the current CFVs. Include chase sequence status, next steps for each, and estimated recovery timeline.' },
        ],
        invoices: [
            { label: 'Overdue Summary', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'List all overdue invoices with amounts and how long overdue. Calculate total overdue amount.' },
            { label: 'Payment Priority', model: AI_MODEL_DEFAULT, maxTokens: 1000, prompt: 'Prioritise the pending invoices for payment based on due date, amount, and business importance. Suggest a payment schedule.' },
        ],
        airtable: [
            { label: 'Job List Overview', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'Summarise the current contractor job list. How many active jobs are there? Are any overdue or stalled? What needs attention?' },
        ],
        comms: [
            { label: 'Inbox Status', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'Summarise the current inbound communications status. How many emails need responding to? Are there any urgent items?' },
            { label: 'Follow-up Priorities', model: AI_MODEL_DEFAULT, maxTokens: 1000, prompt: 'Review the pending follow-ups and suggest which ones to prioritise based on urgency and importance.' },
        ],
        compliance: [
            { label: 'Compliance Status', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'Summarise the property compliance status. Are any certificates expired or expiring soon? Which properties need attention?' },
            { label: 'Expiry Report', model: AI_MODEL_DEFAULT, maxTokens: 1500, prompt: 'Generate a compliance expiry report. List all certificates by expiry date, flag any that are expired or expiring within 30 days, and suggest an action plan.' },
        ],
        sitemap: [
            { label: 'Version Status', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'Check the version sync status across all pages and SOPs. Which SOPs are out of date and need updating?' },
        ],
        fintable: [
            { label: 'Sync Health', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: 'Check the Fintable bank sync status. Are all accounts syncing correctly? Are any stale or disconnected?' },
        ],
        _default: [
            { label: 'Ask a Question', model: AI_MODEL_LIGHT, maxTokens: 500, prompt: '' },
        ],
    };

    function getActiveTab() {
        const hash = window.location.hash.replace('#', '');
        return hash || 'overview';
    }

    // ──────────────────────────────────────────
    // SOP-as-context loader
    // Each page has a Standard Operating Procedure (sopFile in PAGE_REGISTRY)
    // We fetch the SOP HTML once per session, strip it to clean text, cache it,
    // and inject it into the wizard's system prompt so the model understands
    // what the page is for, what it can do, and its limitations.
    // ──────────────────────────────────────────
    const sopCache = {};            // { tabId: "stripped text" | null }
    const sopInflight = {};         // { tabId: Promise } — dedupe concurrent fetches

    // One-line purpose for every tab. Used as a fast-path description and as a
    // fallback when a tab has no SOP file (os-strategy, fintable).
    const PAGE_PURPOSES = {
        'overview': 'Leadership Dashboard — financial overview, 31-day cash flow forecast, balance calculator, reconciliation accuracy, AI commentary. The single executive view of business health.',
        'tasks': 'Tasks & Projects — tasks and projects across the portfolio, with assignment, due dates, and Kanban-style flow.',
        'cfv': 'CFVs (Cash Flow Voids) — detects tenancies where rent hasn\'t landed on time, runs a 3-stage chase sequence, tracks exposure.',
        'invoices': 'Invoices — pending invoices pulled from Gmail, AI-matched to vendors/jobs, approved and marked paid.',
        'pnl': 'Profit & Loss — business-level P&L with category breakdown, period comparison, and variance.',
        'comms': 'Inbound Comms — email triage with AI label suggestions, follow-up tracking, priority scoring.',
        'compliance': 'Property Compliance — certificate tracking (gas, EICR, EPC, legionella, fire, PAT), expiry monitoring, renewal actions.',
        'airtable': 'Contractor Job List — active maintenance jobs, contractor assignment, status.',
        'os-bplan': 'Business Launch Plan Builder — AI-guided wizard that produces a complete launch plan for a new business.',
        'os-strategy': 'Objective & Strategy — quarterly strategy plan per business with Boardroom Mentor wizard support.',
        'fintable': 'Fintable Sync Monitor — health of bank-account sync across all connected accounts; flags stale or disconnected feeds.',
        'sitemap': 'Site Map & Guides — registry of every page, current version, matching SOP/user-guide version, and sync status.',
        'ai-brain': 'AI Brain — Kevin\'s second brain. Captures notes, meetings, documents, and videos; files and links them nightly; answers questions from everything filed.',
    };

    // ──────────────────────────────────────────
    // AI Brain context — the brain's note index + today's feed, published
    // nightly to two private Airtable tables. Loaded once per session and
    // injected into the system prompt when the question comes from the
    // AI Brain tab, so "Ask your brain" answers from what is actually filed.
    // ──────────────────────────────────────────
    const BRAIN_BASE = 'appnqjDpqDniH3IRl';
    const BRAIN_TODAY_TABLE = 'tblZ75JgE1wzDP0ps';
    const BRAIN_INDEX_TABLE = 'tbl5MY9FbImFQfvez';
    let brainContext;            // undefined = not loaded, null = failed/unavailable
    let brainInflight = null;

    async function fetchAllAirtableRows(table) {
        let records = [], offset = '';
        do {
            const url = `https://api.airtable.com/v0/${BRAIN_BASE}/${table}?pageSize=100${offset ? '&offset=' + offset : ''}`;
            const r = await fetch(url, { headers: { Authorization: 'Bearer ' + PAT } });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const data = await r.json();
            records = records.concat(data.records || []);
            offset = data.offset || '';
        } while (offset);
        return records.map(rec => rec.fields || {});
    }

    async function loadBrainContext() {
        if (brainContext !== undefined) return brainContext;
        if (brainInflight) return brainInflight;
        if (typeof PAT === 'undefined' || !PAT) { brainContext = null; return null; }
        brainInflight = (async () => {
            try {
                const [index, today] = await Promise.all([
                    fetchAllAirtableRows(BRAIN_INDEX_TABLE),
                    fetchAllAirtableRows(BRAIN_TODAY_TABLE),
                ]);
                brainContext = {
                    index: index.map(f => ({
                        name: f.Name, folder: f.Folder,
                        summary: f.Sensitive ? '(sensitive — content stays in the private brain)' : (f.Summary || ''),
                        link: f.DocLink || '',
                    })),
                    today: today.filter(f => f.Kind !== 'metric').map(f => ({
                        kind: f.Kind, item: f.Item, text: f.Text || '', doc: f.DocName || '', link: f.DocLink || '',
                    })),
                };
            } catch (e) {
                console.warn('Brain context load failed:', e);
                brainContext = null;
            } finally {
                brainInflight = null;
            }
            return brainContext;
        })();
        return brainInflight;
    }

    function stripHtmlToText(html) {
        // Remove non-content blocks before parsing so textContent is clean
        html = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const node = doc.body || doc.documentElement;
        let text = node ? (node.textContent || '') : '';
        // Collapse runs of whitespace but preserve paragraph breaks
        text = text.replace(/[ \t\f\v]+/g, ' ')
                   .replace(/\n[ \t]+/g, '\n')
                   .replace(/\n{3,}/g, '\n\n')
                   .trim();
        // Guardrail: cap at ~20k chars (~5k tokens). SOPs above this get truncated
        // with a marker so the model knows content was cut.
        const MAX = 20000;
        if (text.length > MAX) text = text.slice(0, MAX) + '\n\n[…SOP truncated — section beyond this point not loaded…]';
        return text;
    }

    async function loadSOPForTab(tabId) {
        if (sopCache[tabId] !== undefined) return sopCache[tabId];
        if (sopInflight[tabId]) return sopInflight[tabId];
        const page = (typeof PAGE_REGISTRY !== 'undefined') ? PAGE_REGISTRY.find(p => p.id === tabId) : null;
        if (!page || !page.sopFile) { sopCache[tabId] = null; return null; }
        sopInflight[tabId] = (async () => {
            try {
                const resp = await fetch(page.sopFile);
                if (!resp.ok) { sopCache[tabId] = null; return null; }
                const html = await resp.text();
                const text = stripHtmlToText(html);
                sopCache[tabId] = text;
                return text;
            } catch (e) {
                console.warn('SOP load failed for', tabId, e);
                sopCache[tabId] = null;
                return null;
            } finally {
                delete sopInflight[tabId];
            }
        })();
        return sopInflight[tabId];
    }

    // Prewarm: start fetching the SOP as soon as the panel opens or the tab changes
    // so by the time the user sends their first message the SOP is already in memory.
    function prewarmSOP() {
        const tab = getActiveTab();
        loadSOPForTab(tab).catch(() => {});
        if (tab === 'ai-brain') loadBrainContext();
    }
    window.addEventListener('hashchange', prewarmSOP);

    function renderAIChips() {
        const container = document.getElementById('aiChips');
        if (!container) return;
        const tab = getActiveTab();
        const actions = AI_ACTIONS[tab] || AI_ACTIONS._default;
        container.innerHTML = actions.filter(a => a.prompt).map(a =>
            `<div class="ai-chip" onclick="sendQuickAction('${escJs(a.label)}')">${escHtml(a.label)}</div>`
        ).join('');
    }

    // Toggle panel
    function toggleAIPanel() {
        const panel = document.getElementById('aiPanel');
        const bubble = document.getElementById('aiBubble');
        const isOpen = panel.classList.contains('open');
        panel.classList.toggle('open');
        if (isOpen) {
            bubble.classList.remove('hidden');
        } else {
            bubble.classList.add('hidden');
            renderAIChips();
            prewarmSOP();
            document.getElementById('aiInput').focus();
        }
    }

    // Gather dashboard context
    function gatherDashboardContext() {
        const tab = getActiveTab();
        const ctx = {
            currentTab: tab,
            timestamp: new Date().toISOString(),
            ...dashboardState,
        };
        // Add page-specific context
        try {
            if (tab === 'cfv' && typeof detectCFVs === 'function') {
                ctx.cfvDetails = detectCFVs().map(e => ({ surname: e.surname, ref: e.ref, rent: e.rent, dueDay: e.dueDay, daysOverdue: e.daysOverdue, status: e.status, propertyName: e.propertyName }));
            }
            if (tab === 'invoices') {
                const invoicePanel = document.getElementById('tab-invoices');
                if (invoicePanel) {
                    const rows = invoicePanel.querySelectorAll('tbody tr');
                    ctx.invoiceCount = rows.length;
                    ctx.invoiceSummary = document.getElementById('invoiceSummaryCards')?.innerText || '';
                }
            }
            if (tab === 'compliance') {
                ctx.compliancePage = 'Property compliance tracking page (loaded as iframe)';
            }
            if (tab === 'comms') {
                ctx.commsPage = 'Inbound communications tracker (loaded as iframe)';
            }
            if (tab === 'sitemap') {
                ctx.pageRegistry = PAGE_REGISTRY.map(p => ({ name: p.name, pageVer: p.pageVer, sopVer: p.sopVer, inSync: p.pageVer === p.sopVer }));
            }
            if (tab === 'fintable') {
                const summary = document.getElementById('fintableSummary');
                ctx.fintableSummary = summary?.innerText || 'Fintable sync monitor page';
            }
            if (tab === 'prospecting' && typeof prospectsCache !== 'undefined' && prospectsCache) {
                const byStatus = {};
                prospectsCache.forEach(r => {
                    const s = (r.fields && r.fields['Status']) || 'Found';
                    byStatus[s] = (byStatus[s] || 0) + 1;
                });
                ctx.prospectingFunnel = byStatus;
                ctx.prospectingQueue = prospectsCache
                    .filter(r => (r.fields && r.fields['Status']) === 'Ready for Review')
                    .slice(0, 25)
                    .map(r => ({ name: r.fields['Name'], company: r.fields['Company'], entity: r.fields['Entity Type'], pain: r.fields['Pain Signal'] }));
                ctx.prospectingKeywords = (typeof prospectKeywordsCache !== 'undefined' && prospectKeywordsCache || [])
                    .filter(k => k.fields && k.fields['Active'])
                    .map(k => k.fields['Keyword']);
            }
        } catch(e) { console.warn('Context gathering error:', e); }
        return ctx;
    }

    // Build system prompt as two content blocks.
    // Block 1 (STABLE — marked cache_control:ephemeral): Boardroom Mentor base +
    //   current page name + one-line purpose + full SOP text. Stable per page
    //   per session, so Anthropic's prompt cache reuses it across follow-up
    //   questions for ~90% off on that chunk.
    // Block 2 (DYNAMIC — not cached): live dashboard state + today's date.
    async function buildSystemPrompt() {
        const ctx = gatherDashboardContext();
        const tab = ctx.currentTab || 'overview';
        const page = (typeof PAGE_REGISTRY !== 'undefined') ? PAGE_REGISTRY.find(p => p.id === tab) : null;
        const pageName = page ? page.name : tab;
        const purpose = PAGE_PURPOSES[tab] || '';
        const sopText = await loadSOPForTab(tab);

        const mentor = (typeof BOARDROOM_MENTOR_PROMPT !== 'undefined') ? BOARDROOM_MENTOR_PROMPT : '';

        let brainBlock = '';
        if (tab === 'ai-brain') {
            const brain = await loadBrainContext();
            if (brain) {
                ctx.aiBrain = brain;
                brainBlock = [
                    `AI BRAIN MODE — the user is asking their second brain a question.`,
                    `The dashboard state below includes "aiBrain": an index of every note filed in the brain (name, folder, one-line summary, link) plus today's captures and open questions.`,
                    `Answer FROM THE INDEX. When you reference a note, name it and give its link as a plain URL so the user can open it. If the index does not cover the question, say the brain has nothing filed on it yet and suggest capturing it — do not guess or invent notes.`,
                    `Notes marked "(sensitive — content stays in the private brain)" exist but their content is not available here. If the answer lies in one, say so and give the link for the user to open privately. Never speculate about their contents.`,
                ].join('\n');
            } else {
                brainBlock = `AI BRAIN MODE — the brain index could not be loaded (not signed in, or the feed is unavailable). Say so honestly and suggest using the Refresh button on the AI Brain tab or trying again shortly. Do not guess at brain contents.`;
            }
        }

        const pageBlock = [
            `CURRENT PAGE: ${pageName} (tab id: "${tab}")`,
            purpose ? `PAGE PURPOSE: ${purpose}` : '',
            brainBlock,
            sopText
                ? `PAGE SOP — read this before answering. It describes exactly what this page does, how it works, and its limitations. Ground every answer in this:\n\n${sopText}`
                : `PAGE SOP: Not available for this page. Work from the page purpose above and the dashboard state below. If the user asks how something works on this page and you can't tell from the state, say so rather than guessing.`,
            `When answering, stay grounded in what this page actually does. Don't invent features the SOP doesn't mention. If a question is outside this page's scope, say so and point to the right page.`,
        ].filter(Boolean).join('\n\n');

        const stableText = `${mentor}\n\n---\n\n${pageBlock}`;

        const dynamicText = `CURRENT DASHBOARD STATE (live snapshot — may change between messages):\n\`\`\`json\n${JSON.stringify(ctx, null, 0)}\n\`\`\`\n\nToday is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;

        return [
            { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: dynamicText },
        ];
    }

    // Conversation history
    let aiConversation = [];
    const AI_MAX_HISTORY = 10;

    function addToConversation(role, content) {
        aiConversation.push({ role, content });
        if (aiConversation.length > AI_MAX_HISTORY) aiConversation.shift();
    }

    // Render a message in the chat
    function appendAIMessage(role, content) {
        const container = document.getElementById('aiMessages');
        const div = document.createElement('div');
        div.className = 'ai-msg ' + role;
        div.innerHTML = renderMarkdown(content);
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
    }

    // Simple markdown renderer.
    // SECURITY: the raw text is HTML-escaped FIRST so model (or error) output can
    // never inject markup — only the markdown patterns below produce HTML.
    function renderMarkdown(text) {
        const escaped = String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        return escaped
            .replace(/```([\s\S]*?)```/g, '<pre style="background:var(--bg-subtle);padding:8px;border-radius:6px;font-size:var(--fs-xs);overflow-x:auto"><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code style="background:var(--bg-subtle);padding:1px 4px;border-radius:3px;font-size:var(--fs-sm)">$1</code>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^### (.+)$/gm, '<h4 style="margin:8px 0 4px;font-size:var(--fs-base);color:var(--text-primary)">$1</h4>')
            .replace(/^## (.+)$/gm, '<h3 style="margin:10px 0 6px;font-size:var(--fs-md);color:var(--text-primary)">$1</h3>')
            .replace(/^# (.+)$/gm, '<h2 style="margin:12px 0 8px;font-size:var(--fs-lg);color:var(--text-primary)">$1</h2>')
            .replace(/^- (.+)$/gm, '<div style="padding-left:12px">\u2022 $1</div>')
            .replace(/^\d+\. (.+)$/gm, '<div style="padding-left:12px">$&</div>')
            .replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>')
            .replace(/\n/g, '<br>');
    }

    // Simulated streaming
    async function streamText(element, text) {
        element.innerHTML = '';
        let i = 0;
        return new Promise(resolve => {
            function type() {
                if (i < text.length) {
                    const chunk = text.substring(i, Math.min(i + 3, text.length));
                    i += chunk.length;
                    element.innerHTML = renderMarkdown(text.substring(0, i));
                    element.closest('.ai-messages').scrollTop = element.closest('.ai-messages').scrollHeight;
                    requestAnimationFrame(type);
                } else {
                    element.innerHTML = renderMarkdown(text);
                    resolve();
                }
            }
            type();
        });
    }

    // Show typing indicator
    function showTyping() {
        const container = document.getElementById('aiMessages');
        const div = document.createElement('div');
        div.className = 'ai-typing';
        div.id = 'aiTyping';
        div.innerHTML = '<div class="ai-typing-dot"></div><div class="ai-typing-dot"></div><div class="ai-typing-dot"></div>';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
    function hideTyping() {
        const el = document.getElementById('aiTyping');
        if (el) el.remove();
    }

    // Send message to Claude
    let aiCooldown = false;
    async function sendAIMessage() {
        const input = document.getElementById('aiInput');
        const text = input.value.trim();
        if (!text || aiCooldown) return;
        input.value = '';

        appendAIMessage('user', text);
        addToConversation('user', text);

        // Determine model
        const isComplex = text.length > 80 || /report|analyse|analyze|compare|strategy|plan|briefing|export|trend|forecast/i.test(text);
        const model = isComplex ? AI_MODEL_DEFAULT : AI_MODEL_LIGHT;
        const maxTokens = isComplex ? 2000 : 500;

        showTyping();
        aiCooldown = true;

        try {
            const systemPrompt = await buildSystemPrompt();
            const messages = aiConversation.map(m => ({ role: m.role, content: m.content }));

            const response = await fetch(AI_PROXY, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages })
            });

            hideTyping();

            if (!response.ok) {
                // Proxy errors can be long multi-line bodies — flatten and truncate before showing
                const errRaw = await response.text().catch(() => '');
                const errText = errRaw.replace(/\s+/g, ' ').trim().substring(0, 120);
                appendAIMessage('assistant', `Sorry, I couldn't process that (${response.status}). ${errText || 'Please try again.'}`);
                return;
            }

            const data = await response.json();
            const reply = data.content?.[0]?.text || 'No response received.';
            addToConversation('assistant', reply);

            const msgEl = appendAIMessage('assistant', '');
            await streamText(msgEl, reply);

            // Add export buttons for long responses
            if (reply.length > 500) {
                const exportBtn = document.createElement('div');
                exportBtn.style.cssText = 'margin-top:6px;display:flex;gap:6px';
                exportBtn.innerHTML = `<button onclick="copyAIResponse(this)" style="font-size:10px;padding:3px 8px;background:var(--bg-subtle);border:1px solid var(--border-default);border-radius:var(--radius-sm);cursor:pointer;color:var(--text-muted)">Copy</button>
                    <button onclick="printAIResponse(this)" style="font-size:10px;padding:3px 8px;background:var(--bg-subtle);border:1px solid var(--border-default);border-radius:var(--radius-sm);cursor:pointer;color:var(--text-muted)">Print</button>`;
                msgEl.appendChild(exportBtn);
            }
        } catch (e) {
            hideTyping();
            appendAIMessage('assistant', `Connection error: ${e.message}. The dashboard data is still available \u2014 try refreshing or rephrasing your question.`);
        } finally {
            setTimeout(() => { aiCooldown = false; }, 2000);
        }
    }

    // Quick action
    function sendQuickAction(label) {
        // Search every tab's actions so command-palette entries work from any tab
        const action = Object.values(AI_ACTIONS).flat().find(a => a.label === label);
        if (!action) return;
        document.getElementById('aiInput').value = action.prompt || label;
        sendAIMessage();
    }

    // Export helpers
    function copyAIResponse(btn) {
        const msg = btn.closest('.ai-msg');
        navigator.clipboard.writeText(msg.innerText).then(() => { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); });
    }
    function printAIResponse(btn) {
        const msg = btn.closest('.ai-msg');
        const printWin = window.open('', '_blank');
        if (!printWin) {
            showToast('Pop-up blocked \u2014 allow pop-ups to print', { type: 'warning' });
            return;
        }
        const doc = printWin.document;
        doc.title = 'AI Report';
        // Hex literals are intentional here: tokens.css does not load inside this standalone print popup.
        const style = doc.createElement('style');
        style.textContent = 'body{font-family:"DM Sans",sans-serif;padding:40px;max-width:800px;margin:0 auto;line-height:1.6;color:#1C2422;background:#FBFBF9}h1,h2,h3,h4{color:#1C2422}code{background:#FBFBF9;border:1px solid #DDE1D9;padding:2px 4px;border-radius:3px}pre{background:#FBFBF9;border:1px solid #DDE1D9;padding:12px;border-radius:6px;overflow-x:auto}hr{border:none;border-top:1px solid #DDE1D9}';
        doc.head.appendChild(style);
        // msg.innerHTML is already safe: it was produced by renderMarkdown, which escapes all raw HTML first.
        doc.body.innerHTML = `<h1>Operations Director \u2014 AI Report</h1><p style="color:#5A6660">${new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}</p><hr>${msg.innerHTML}`;
        doc.close();
        printWin.print();
    }

    // Command palette
    function openCmdPalette() {
        document.getElementById('aiCmdOverlay').style.display = 'flex';
        document.getElementById('aiCmdInput').value = '';
        document.getElementById('aiCmdInput').focus();
        populateCmdPalette('');
    }
    function closeCmdPalette() {
        document.getElementById('aiCmdOverlay').style.display = 'none';
    }
    function populateCmdPalette(filter) {
        const list = document.getElementById('aiCmdList');
        const all = Object.values(AI_ACTIONS).flat().filter(a => a.prompt);
        const filtered = filter ? all.filter(a => a.label.toLowerCase().includes(filter.toLowerCase())) : all;
        list.innerHTML = filtered.map(a =>
            `<div class="ai-cmd-item" onclick="closeCmdPalette();sendQuickAction('${escJs(a.label)}')">${escHtml(a.label)}</div>`
        ).join('') || '<div class="od-empty-state" style="padding:12px">No matching commands</div>';
    }
    function filterCmdPalette() {
        populateCmdPalette(document.getElementById('aiCmdInput').value);
    }

    // "Ask your brain" — the AI Brain iframe posts the question here; open the
    // panel, prewarm the brain context, and send it through the normal flow.
    window.addEventListener('message', e => {
        if (e.origin !== window.location.origin) return;
        const d = e.data || {};
        if (d.type !== 'od-ask-brain' || typeof d.question !== 'string' || !d.question.trim()) return;
        loadBrainContext();
        const panel = document.getElementById('aiPanel');
        if (panel && !panel.classList.contains('open')) toggleAIPanel();
        const input = document.getElementById('aiInput');
        if (!input) return;
        input.value = d.question.trim().slice(0, 2000);
        sendAIMessage();
    });

    // Keyboard shortcut: Cmd+K / Ctrl+K
    document.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            const overlay = document.getElementById('aiCmdOverlay');
            if (overlay.style.display === 'flex') closeCmdPalette();
            else openCmdPalette();
        }
        if (e.key === 'Escape') closeCmdPalette();
    });

    // Initial chip render
    setTimeout(renderAIChips, 1000);

