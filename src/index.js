require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { google } = require('googleapis');
const crypto = require('crypto');
const NewsletterGenerator = require('./generator');
const { scrapeAllSources } = require('./scraper');
const EmailSender = require('./emailSender');
const { AdvancedScheduler, setupAdvancedSchedulingEndpoints } = require('./advancedScheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
function validateEnvironment() {
  const required = [
    'GOOGLE_CLIENT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
    'GOOGLE_SHEETS_ID',
    'OPENAI_API_KEY'
  ];
  const missing = required.filter(env => !process.env[env]);
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    return false;
  }
  console.log('✅ All required environment variables present');
  return true;
}

if (process.env.NODE_ENV === 'production' && !validateEnvironment()) {
  console.error('🚫 Production startup failed due to missing environment variables');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// BASIC AUTH MIDDLEWARE
// Protects /admin, /dashboard, /newsletter-management and all /api/ routes.
// Public subscriber-facing endpoints (confirm, unsubscribe, pause, public signup)
// are explicitly excluded so email footer links keep working.
// Set ADMIN_USER and ADMIN_PASS as Railway env vars to activate.
// If vars are not set, auth is skipped (with a loud warning in production).
// ─────────────────────────────────────────────────────────────────────────────
const PROTECTED_PAGE_PREFIXES = ['/admin', '/dashboard', '/newsletter-management'];
const PUBLIC_API_PATHS = new Set([
  '/api/confirm',
  '/api/unsubscribe',
  '/api/pause',
]);

app.use((req, res, next) => {
  const p = req.path;
  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some(pp => p === pp || p.startsWith(pp + '.') || p.startsWith(pp + '/'));
  const isApi = p.startsWith('/api/');
  const isPublicApi = PUBLIC_API_PATHS.has(p) || (p === '/api/subscribers' && req.method === 'POST');
  const isHealth = p === '/health' || p === '/';

  if (!isProtectedPage && (!isApi || isPublicApi || isHealth)) return next();

  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;

  if (!adminUser || !adminPass) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('⚠️  ADMIN_USER/ADMIN_PASS not configured — admin routes are UNPROTECTED');
    }
    return next();
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="SFP Admin", charset="UTF-8"')
      .send('Authentication required');
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const colonIdx = decoded.indexOf(':');
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  if (user === adminUser && pass === adminPass) return next();

  return res
    .status(401)
    .set('WWW-Authenticate', 'Basic realm="SFP Admin", charset="UTF-8"')
    .send('Invalid credentials');
});

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/static', express.static('public', {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) res.set('Content-Type', 'text/css; charset=utf-8');
    else if (filePath.endsWith('.js')) res.set('Content-Type', 'application/javascript; charset=utf-8');
    else if (filePath.endsWith('.html')) res.set('Content-Type', 'text/html; charset=utf-8');
    else if (/\.(png|jpg|jpeg|gif|svg)$/.test(filePath)) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'public, max-age=31536000');
    }
  }
}));

app.use(express.static('assets', {
  setHeaders: (res, filePath) => {
    if (/\.(png|jpg|jpeg|gif|svg)$/.test(filePath)) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'public, max-age=31536000');
    }
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN DASHBOARD ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../newsletter-management.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../newsletter-management.html')));
app.get('/newsletter-management', (req, res) => res.sendFile(path.join(__dirname, '../newsletter-management.html')));
app.get('/newsletter-management.html', (req, res) => res.sendFile(path.join(__dirname, '../newsletter-management.html')));

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function makeToken(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!from) throw new Error('EMAIL_FROM not set');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Resend send failed: ${resp.status} ${txt}`);
  }
  return resp.json().catch(() => ({}));
}

// Google Sheets auth helper — reused across all endpoints
async function getSheetsClient(readonly = false) {
  const auth = await google.auth.getClient({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: [readonly
      ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
      : 'https://www.googleapis.com/auth/spreadsheets'
    ]
  });
  return google.sheets({ version: 'v4', auth });
}

const SPREADSHEET_ID = () => process.env.GOOGLE_SHEETS_ID;

// Canonical segment order
const CANONICAL_SEGMENTS = ['pro', 'driver'];

function canonicalSegmentCsv(segs) {
  const set = new Set(segs.map(s => s.trim().toLowerCase()).filter(Boolean));
  return CANONICAL_SEGMENTS.filter(s => set.has(s)).join(',');
}

// Write an audit row to Subscription_Audit sheet
async function writeSubscriptionAudit(sheets, { action, email, metadata = '', ip = '', ua = '' }) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID(),
      range: 'Subscription_Audit!A:F',
      valueInputOption: 'RAW',
      requestBody: { values: [[new Date().toISOString(), action, email, metadata, ip, ua]] }
    });
  } catch (e) {
    console.warn('Subscription_Audit write failed (non-fatal):', e.message);
  }
}

const emailSender = new EmailSender();
let newsletterCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM STATE — in-memory + Events_Log persistence
// ─────────────────────────────────────────────────────────────────────────────
const systemState = {
  lastScrape: null,
  lastSent: { pro: null, driver: null }
};

async function logSystemEvent(event, metadata = {}) {
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID(),
      range: 'Events_Log!A:G',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),
          event,
          metadata.issue_id || '',
          metadata.segment || '',
          '', '',
          JSON.stringify(metadata)
        ]]
      }
    });
  } catch (e) {
    console.warn('Events_Log write failed (non-fatal):', e.message);
  }
}

async function restoreSystemState() {
  try {
    const sheets = await getSheetsClient(true);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Events_Log!A:G' });
    const rows = (resp.data.values || []).slice(1).reverse();

    for (const row of rows) {
      const event = row[1] || '';
      try {
        const meta = JSON.parse(row[6] || '{}');
        if (event === 'scrape_completed' && !systemState.lastScrape) {
          systemState.lastScrape = { timestamp: row[0], ...meta };
        }
        if (event === 'newsletter_sent') {
          const seg = meta.segment || row[3] || '';
          if (seg && !systemState.lastSent[seg]) {
            systemState.lastSent[seg] = { timestamp: row[0], ...meta };
          }
        }
        if (systemState.lastScrape && systemState.lastSent.pro && systemState.lastSent.driver) break;
      } catch (e) { /* skip malformed rows */ }
    }
    console.log(`✅ System state restored — last scrape: ${systemState.lastScrape?.timestamp || 'never'}`);
  } catch (e) {
    console.warn('Could not restore system state:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE CONFIG — stored in Google Sheets (Schedule_Config tab)
// Replaces /tmp file approach — survives Railway redeploys.
// Sheet: Schedule_Config | Columns: Key, Value (JSON)
// ─────────────────────────────────────────────────────────────────────────────
async function loadScheduleConfigFromSheets() {
  try {
    const sheets = await getSheetsClient(true);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID(),
      range: 'Schedule_Config!A:B'
    });
    const rows = resp.data.values || [];
    const config = {};
    for (const row of rows) {
      if (row[0] && row[1]) {
        try { config[row[0]] = JSON.parse(row[1]); } catch (e) { /* skip */ }
      }
    }
    if (config.scraping && config.newsletter) {
      console.log('✅ Schedule config loaded from Google Sheets');
      return config;
    }
  } catch (e) {
    console.warn('Could not load schedule config from Sheets (will use defaults):', e.message);
  }
  return null;
}

async function saveScheduleConfigToSheets(config) {
  try {
    const sheets = await getSheetsClient();
    // Write two rows: scraping and newsletter
    const rows = [
      ['scraping', JSON.stringify({ ...config.scraping, lastRun: undefined })],
      ['newsletter', JSON.stringify({ ...config.newsletter, lastRun: undefined })]
    ];
    // Clear and rewrite to keep it clean
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID(),
      range: 'Schedule_Config!A:B'
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID(),
      range: 'Schedule_Config!A1',
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
    console.log('💾 Schedule config saved to Google Sheets');
  } catch (e) {
    console.warn('Could not save schedule config to Sheets:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/system/state', (req, res) => {
  res.json({ success: true, data: { lastScrape: systemState.lastScrape, lastSent: systemState.lastSent } });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString(), service: 'SFP Newsletter Automation', version: '3.0.0' });
});

app.get('/', (req, res) => {
  res.json({
    message: 'SFP Newsletter Automation API',
    status: 'running',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /health', 'GET /admin', 'POST /api/scrape',
      'POST /api/newsletter/generate/:segment', 'POST /api/newsletter/send/:newsletterId',
      'GET /api/subscribers', 'POST /api/subscribers', 'PUT /api/subscribers/:email',
      'DELETE /api/subscribers/:email', 'GET /api/status', 'GET /api/analytics/summary'
    ]
  });
});

app.get('/api/version', (req, res) => {
  res.json({ success: true, version: '3.0.0', system: 'SFP Newsletter Automation', timestamp: new Date().toISOString(), build: process.env.RAILWAY_GIT_COMMIT_SHA || 'local', environment: process.env.NODE_ENV || 'production' });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCRAPING
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  try {
    const startTime = Date.now();
    console.log('🔍 Manual scraping triggered...');
    const results = await scrapeAllSources();
    const articles = results.articles || [];
    let savedCount = 0;

    if (articles.length > 0) {
      try {
        const SheetsManager = require('../config/sheets');
        const sheetsManager = new SheetsManager();
        await sheetsManager.initialize();
        const saved = await sheetsManager.saveArticles(articles);
        savedCount = saved.length;
      } catch (e) {
        console.error('⚠️ Failed to save articles to sheets:', e.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const timestamp = new Date().toISOString();
    systemState.lastScrape = { timestamp, articlesFound: articles.length, savedCount, trigger: 'manual' };
    await logSystemEvent('scrape_completed', { articlesFound: articles.length, savedCount, duration, trigger: 'manual' }).catch(() => {});

    res.json({ success: true, message: 'Scraping completed', data: { articlesFound: articles.length, savedToSheets: savedCount, duration: `${duration}s`, timestamp, errors: results.errors || [] } });
  } catch (error) {
    console.error('❌ Scraping error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWSLETTER GENERATE + SEND
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/newsletter/generate/:segment', async (req, res) => {
  try {
    const { segment } = req.params;
    if (!['pro', 'driver'].includes(segment)) return res.status(400).json({ success: false, error: 'Invalid segment' });

    const gen = new NewsletterGenerator();
    const newsletter = await gen.generateNewsletter(segment, false);
    const newsletterId = `NL_${segment}_${Date.now()}`;
    newsletterCache.set(newsletterId, { newsletter, segment, generatedAt: new Date().toISOString(), articles: newsletter.articles || [] });
    if (newsletterCache.size > 10) newsletterCache.delete(newsletterCache.keys().next().value);

    res.json({ success: true, data: { newsletterId, segment, subject: newsletter.subject, articlesCount: newsletter.articles?.length || 0, previewHtml: newsletter.html, previewText: newsletter.text, generatedAt: new Date().toISOString() } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/newsletter/send/:newsletterId', async (req, res) => {
  try {
    const { newsletterId } = req.params;
    const { testEmail, confirmSend } = req.body;
    const cached = newsletterCache.get(newsletterId);
    if (!cached) return res.status(404).json({ success: false, error: 'Newsletter not found. Generate preview first.' });

    const { newsletter, segment, articles } = cached;

    if (testEmail) {
      const subs = await emailSender.getSubscribersFromSheet(segment);
      const matched = subs.find(s => s.email.toLowerCase() === testEmail.toLowerCase());
      const testSub = matched || { email: testEmail, name: 'Test User', segment, unsubToken: 'test-token' };
      await emailSender.sendSingleEmail(newsletter, testSub);
      return res.json({ success: true, message: 'Test email sent', data: { newsletterId, testEmail, segment } });
    }

    if (confirmSend) {
      const subscribers = await emailSender.getSubscribersFromSheet(segment);
      const sendResult = await emailSender.sendBulkEmails(newsletter, subscribers);
      await markArticlesAsUsed(articles, segment, newsletterId);
      await writeSendLog(segment, newsletterId, newsletter, sendResult, articles).catch(e => console.error('Send_Log write failed:', e.message));
      const sentMeta = { segment, subject: newsletter.subject, recipients: subscribers.length, trigger: 'manual', issue_id: newsletterId };
      systemState.lastSent[segment] = { timestamp: new Date().toISOString(), ...sentMeta };
      await logSystemEvent('newsletter_sent', sentMeta).catch(() => {});
      newsletterCache.delete(newsletterId);
      return res.json({ success: true, message: 'Newsletter sent', data: { newsletterId, segment, recipients: subscribers.length } });
    }

    return res.status(400).json({ success: false, error: 'Must specify testEmail or confirmSend=true' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test endpoint — uses cached preview if available, generates fresh if not
app.post('/api/newsletter/test', async (req, res) => {
  try {
    const { segment = 'pro', email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Missing email' });

    let newsletter = null;
    let newsletterId = null;
    for (const [id, cached] of [...newsletterCache.entries()].reverse()) {
      if (cached.segment === segment) { newsletter = cached.newsletter; newsletterId = id; break; }
    }
    if (!newsletter) {
      const gen = new NewsletterGenerator();
      newsletter = await gen.generateNewsletter(segment, false);
    }

    const subs = await emailSender.getSubscribersFromSheet(segment);
    const matched = subs.find(s => s.email.toLowerCase() === email.toLowerCase());
    const testSub = matched || { email, name: 'Test User', segment, unsubToken: 'test-token' };
    await emailSender.sendSingleEmail(newsletter, testSub);
    return res.json({ success: true, message: 'Test email sent', data: { segment, email, subject: newsletter.subject, source: newsletterId ? 'cached-preview' : 'fresh-generate' } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Alternative direct-send (legacy)
app.post('/api/newsletters/send', async (req, res) => {
  try {
    const { segment, testEmail } = req.body;
    if (!['pro', 'driver'].includes(segment)) return res.status(400).json({ success: false, error: 'Invalid segment' });
    const gen = new NewsletterGenerator();
    const newsletter = await gen.generateNewsletter(segment, !testEmail);
    if (testEmail) {
      const subs = await emailSender.getSubscribersFromSheet(segment);
      const matched = subs.find(s => s.email.toLowerCase() === testEmail.toLowerCase());
      const testSub = matched || { email: testEmail, name: 'Test User', segment, unsubToken: 'test-token' };
      await emailSender.sendSingleEmail(newsletter, testSub);
      return res.json({ success: true, message: 'Test newsletter sent', data: { segment, recipient: testEmail, subject: newsletter.subject } });
    }
    return res.json({ success: true, message: 'Newsletter sent to all subscribers', data: { segment, subject: newsletter.subject } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MARK ARTICLES AS USED
// ─────────────────────────────────────────────────────────────────────────────
async function markArticlesAsUsed(articles, segment, newsletterId) {
  if (!articles || articles.length === 0) return;
  try {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Article_Archive!A:Z' });
    const rows = response.data.values;
    if (!rows || rows.length < 2) return;
    const headers = rows[0];
    const urlCol = headers.findIndex(h => h === 'URL');
    const usedCol = headers.findIndex(h => h === 'Used_In_Issue');
    if (urlCol === -1 || usedCol === -1) return;
    const articleUrls = new Set(articles.map(a => a.url || a.link));
    const timestamp = new Date().toISOString();
    const updates = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (articleUrls.has(row[urlCol]) && !row[usedCol]) {
        updates.push({ range: `Article_Archive!${String.fromCharCode(65 + usedCol)}${i + 1}`, values: [[`${segment}-${newsletterId}_${timestamp}`]] });
      }
    }
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID(), requestBody: { valueInputOption: 'RAW', data: updates } });
    }
  } catch (error) {
    console.error('Failed to mark articles as used:', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND LOG
// ─────────────────────────────────────────────────────────────────────────────
async function writeSendLog(segment, issueId, newsletter, sendResult, articles) {
  const sheets = await getSheetsClient();
  const now = new Date().toISOString();
  const resendIds = (sendResult.sentEmails || []).map(e => e.resend_id).filter(Boolean);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID(),
    range: 'Send_Log!A:F',
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        now, segment, sendResult.sentCount || 0, sendResult.failedCount || 0, 'false',
        JSON.stringify({ issue_id: issueId, subject: newsletter.subject, resend_ids: resendIds, article_count: articles?.length || 0 })
      ]]
    }
  });

  const contentRow = [issueId, segment, newsletter.subject, now, sendResult.sentCount || 0, sendResult.failedCount || 0, '', '', JSON.stringify(articles || []), ''];
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Content_Archive!A:A' });
  const issueIds = (existing.data.values || []).map(r => r[0]);
  const existingRow = issueIds.indexOf(issueId);
  if (existingRow > 0) {
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Content_Archive!A${existingRow + 1}:J${existingRow + 1}`, valueInputOption: 'RAW', requestBody: { values: [contentRow] } });
  } else {
    await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID(), range: 'Content_Archive!A:J', valueInputOption: 'RAW', requestBody: { values: [contentRow] } });
  }
  console.log(`📋 Send_Log written: ${sendResult.sentCount} sends, ${resendIds.length} Resend IDs`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBSCRIBER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Read ALL subscribers regardless of status (dashboard display)
async function getAllSubscribersFromSheet(segmentFilter) {
  const sheets = await getSheetsClient(true);
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => (h || '').trim());
  const col = (n) => headers.findIndex(h => h.toLowerCase() === n.toLowerCase());
  const emailIdx = col('Email'), nameIdx = col('Name'), segIdx = col('Segment');
  const statusIdx = col('Status'), companyIdx = col('Company'), roleIdx = col('Role');
  const subIdIdx = col('Subscriber_ID'), subAtIdx = col('Subscribed_At');
  const confirmedIdx = col('Confirmed_At'), pausedIdx = col('Paused_At');
  if (emailIdx === -1 || segIdx === -1) return [];

  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const email = (r[emailIdx] || '').trim();
    if (!email || !email.includes('@')) continue;
    const segRaw = (r[segIdx] || '').trim().toLowerCase();
    const segs = segRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (segmentFilter && !segs.includes(segmentFilter.toLowerCase())) continue;
    result.push({
      email, name: (r[nameIdx] || '').trim(), segment: r[segIdx] || '',
      status: (r[statusIdx] || 'pending').trim(), company: (r[companyIdx] || '').trim(),
      role: (r[roleIdx] || '').trim(), subscriberId: r[subIdIdx] || '',
      subscribedAt: r[subAtIdx] || '', confirmedAt: r[confirmedIdx] || '', pausedAt: r[pausedIdx] || ''
    });
  }
  return result;
}

app.get('/api/subscribers/:segment?', async (req, res) => {
  try {
    const segment = req.params.segment;
    if (segment && !['pro', 'driver'].includes(segment)) return res.status(400).json({ success: false, error: 'Invalid segment' });

    if (segment) {
      const subscribers = await getAllSubscribersFromSheet(segment);
      return res.json({ success: true, data: { segment, subscribers } });
    }

    const [pro, driver] = await Promise.all([getAllSubscribersFromSheet('pro'), getAllSubscribersFromSheet('driver')]);
    const proActive = pro.filter(s => s.status.toLowerCase() === 'active');
    const driverActive = driver.filter(s => s.status.toLowerCase() === 'active');
    const uniqueActive = new Set([...proActive, ...driverActive].map(s => s.email.toLowerCase()));
    return res.json({
      success: true,
      data: {
        summary: { totalActiveSubscribers: uniqueActive.size, totalActiveSubscriptions: proActive.length + driverActive.length, proActive: proActive.length, driverActive: driverActive.length },
        pro: { count: proActive.length, subscribers: pro },
        driver: { count: driverActive.length, subscribers: driver }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Public signup — sets pending, sends confirmation email
app.post('/api/subscribers', async (req, res) => {
  try {
    const { email, name, segment, segments, company, role } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    let segmentsArr = Array.isArray(segments) ? segments : (typeof segment === 'string' && segment.trim() ? [segment.trim()] : []);
    segmentsArr = [...new Set(segmentsArr.map(s => String(s).trim()).filter(Boolean))];
    if (segmentsArr.length === 0) return res.status(400).json({ success: false, error: 'At least one segment required' });
    if (segmentsArr.some(s => !['pro', 'driver'].includes(s))) return res.status(400).json({ success: false, error: 'Segments must be "pro" and/or "driver"' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Invalid email format' });

    const sheets = await getSheetsClient();
    const existingCheck = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const existingRows = existingCheck.data.values || [];
    const headers = (existingRows[0] || []).map(h => (h || '').toString().trim());
    const colIndex = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    let existingRowIndex = -1;
    for (let i = 1; i < existingRows.length; i++) {
      if ((existingRows[i][colIndex('Email')] || '').toString().toLowerCase() === email.toLowerCase()) {
        existingRowIndex = i; break;
      }
    }

    const now = new Date().toISOString();

    if (existingRowIndex !== -1) {
      const idxStatus = colIndex('Status'), idxSegment = colIndex('Segment');
      const idxUpdated = colIndex('Updated_At'), idxConfirmedAt = colIndex('Confirmed_At');
      const idxUnsubAt = colIndex('Unsubscribed_At');
      const existingStatus = (existingRows[existingRowIndex][idxStatus] || '').toString().trim().toLowerCase();
      const confirmedAt = (existingRows[existingRowIndex][idxConfirmedAt] || '').toString().trim();
      const rawExisting = idxSegment !== -1 ? (existingRows[existingRowIndex][idxSegment] || '').toString() : '';
      const existingSegs = rawExisting.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const mergedCsv = canonicalSegmentCsv([...existingSegs, ...segmentsArr]);

      if (existingStatus !== 'unsubscribed') {
        const existingCanonical = canonicalSegmentCsv(existingSegs);
        if (mergedCsv === existingCanonical) {
          return res.json({ success: true, message: 'Already subscribed', data: { email, segments: mergedCsv, status: existingStatus } });
        }
        if (idxSegment !== -1) existingRows[existingRowIndex][idxSegment] = mergedCsv;
        if (idxUpdated !== -1) existingRows[existingRowIndex][idxUpdated] = now;
        const lastCol = String.fromCharCode(65 + headers.length - 1);
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${existingRowIndex + 1}:${lastCol}${existingRowIndex + 1}`, valueInputOption: 'RAW', requestBody: { values: [existingRows[existingRowIndex]] } });
        return res.json({ success: true, message: 'Subscription updated', data: { email, segments: mergedCsv, status: existingStatus } });
      }

      if (confirmedAt) {
        if (idxSegment !== -1) existingRows[existingRowIndex][idxSegment] = mergedCsv;
        if (idxStatus !== -1) existingRows[existingRowIndex][idxStatus] = 'active';
        if (idxUnsubAt !== -1) existingRows[existingRowIndex][idxUnsubAt] = '';
        if (idxUpdated !== -1) existingRows[existingRowIndex][idxUpdated] = now;
        const lastCol = String.fromCharCode(65 + headers.length - 1);
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${existingRowIndex + 1}:${lastCol}${existingRowIndex + 1}`, valueInputOption: 'RAW', requestBody: { values: [existingRows[existingRowIndex]] } });
        return res.json({ success: true, message: 'Subscription reactivated', data: { email, segments: mergedCsv, status: 'active' } });
      }
    }

    // New subscriber or unsubscribed-never-confirmed: create pending row
    const outRow = new Array(headers.length).fill('');
    if (existingRowIndex !== -1) {
      const existing = existingRows[existingRowIndex] || [];
      for (let i = 0; i < outRow.length; i++) outRow[i] = existing[i] ?? '';
    }
    const set = (headerName, value) => { const i = colIndex(headerName); if (i !== -1) outRow[i] = value ?? ''; };
    const subscriberId = `SUB-${Date.now()}`;
    const confirmToken = makeToken(16);
    const unsubToken = makeToken(16);

    set('Subscriber_ID', subscriberId); set('Email', email); set('Name', name || '');
    set('Segment', canonicalSegmentCsv(segmentsArr)); set('Status', 'pending');
    set('Source_IP', req.ip || ''); set('Subscribed_At', now);
    set('Confirm_Token', confirmToken); set('Unsub_Token', unsubToken);
    set('Company', company || ''); set('Role', role || '');
    set('Notes', ''); set('Updated_At', now); set('Confirmed_At', '');
    set('Unsubscribed_At', ''); set('Email_Frequency', 'weekly');
    set('Paused_At', ''); set('Resume_At', '');

    if (existingRowIndex === -1) {
      await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [outRow] } });
    } else {
      const lastCol = String.fromCharCode(65 + headers.length - 1);
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${existingRowIndex + 1}:${lastCol}${existingRowIndex + 1}`, valueInputOption: 'RAW', requestBody: { values: [outRow] } });
    }

    // Send confirmation email
    const apiBaseUrl = (process.env.PUBLIC_API_BASE_URL || '').trim() || 'https://sfp-newsletter-automation-production.up.railway.app';
    const confirmUrl = `${apiBaseUrl}/api/confirm?token=${encodeURIComponent(confirmToken)}`;
    const unsubUrlAll = `${apiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}&segment=all`;
    const unsubUrlPro = `${apiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}&segment=pro`;
    const unsubUrlDriver = `${apiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}&segment=driver`;
    const safeName = (name || '').trim() || 'there';
    const hasPro = segmentsArr.includes('pro'), hasDriver = segmentsArr.includes('driver');
    const brandName = hasPro && hasDriver ? 'Safe Freight Intel' : hasDriver ? 'Safe Freight Mate' : 'CoR Intel Weekly';
    const selectedEditionsText = hasPro && hasDriver ? 'CoR Intel Weekly and Safe Freight Mate' : hasDriver ? 'Safe Freight Mate' : 'CoR Intel Weekly';
    const subject = hasPro && hasDriver ? 'Confirm your Safe Freight Intel subscriptions' : hasDriver ? 'Confirm your Safe Freight Mate subscription' : 'Confirm your CoR Intel Weekly subscription';
    const webViewUrl = `https://www.safefreightprogram.com/subscribe-pending?email=${encodeURIComponent(email)}&segments=${encodeURIComponent(segmentsArr.join(','))}`;

    const unsubscribeHtml = hasPro && hasDriver
      ? `<div style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin:10px 0 0 0;">Unsubscribe options:<br>• CoR Intel Weekly: <a href="${unsubUrlPro}" style="color:#1d4ed8;">${unsubUrlPro}</a><br>• Safe Freight Mate: <a href="${unsubUrlDriver}" style="color:#1d4ed8;">${unsubUrlDriver}</a><br>• Unsubscribe all: <a href="${unsubUrlAll}" style="color:#1d4ed8;">${unsubUrlAll}</a></div>`
      : hasDriver
        ? `<div style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin:10px 0 0 0;">Unsubscribe: <a href="${unsubUrlDriver}" style="color:#1d4ed8;">${unsubUrlDriver}</a></div>`
        : `<div style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin:10px 0 0 0;">Unsubscribe: <a href="${unsubUrlPro}" style="color:#1d4ed8;">${unsubUrlPro}</a></div>`;

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Confirm subscription</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#f3f4f6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;border-collapse:collapse;">
<tr><td style="padding:0 0 12px 0;">
<table role="presentation" width="100%" style="border-collapse:collapse;background:#1e40af;border-radius:12px;">
<tr><td align="left" style="padding:14px 16px;"><a href="https://www.safefreightprogram.com/"><img src="https://www.safefreightprogram.com/assets/sfp-logo-small.png" width="60" alt="Safe Freight Program" style="display:block;"></a></td>
<td align="right" style="padding:14px 16px;"><a href="${webViewUrl}" style="font-family:Arial,sans-serif;font-size:12px;color:#fff;text-decoration:underline;">View online</a></td></tr></table></td></tr>
<tr><td style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;">
<p style="font-family:Arial,sans-serif;font-size:14px;color:#111827;">Hi ${safeName},</p>
<p style="font-family:Arial,sans-serif;font-size:14px;color:#111827;">You're one step away from activating <strong>${selectedEditionsText}</strong>. Please confirm your email address.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px 0;">
<tr><td bgcolor="#1d4ed8" style="border-radius:10px;"><a href="${confirmUrl}" style="display:inline-block;padding:12px 18px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#fff;text-decoration:none;">Confirm subscription</a></td></tr></table>
<p style="font-family:Arial,sans-serif;font-size:12px;color:#374151;">If the button doesn't work, copy this link: <a href="${confirmUrl}" style="color:#1d4ed8;">${confirmUrl}</a></p>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;">
<p style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;">If you did not request this, ignore this email.</p>
${unsubscribeHtml}
<p style="font-family:Arial,sans-serif;font-size:12px;color:#6b7280;margin-top:10px;">Safe Freight Program — compliance-grade freight assurance.</p>
</td></tr>
<tr><td style="padding:14px 6px 0;text-align:center;font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;">You are receiving this because an address was entered at safefreightprogram.com.</td></tr>
</table></td></tr></table></body></html>`;

    await sendResendEmail({ to: email, subject, html });
    return res.json({ success: true, message: 'Subscriber created — confirmation email sent', data: { subscriberId, email, name: name || '', segments: segmentsArr, status: 'pending' } });
  } catch (error) {
    console.error('Error adding subscriber:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Admin add — active immediately, no confirmation email
app.post('/api/admin/subscriber', async (req, res) => {
  try {
    const { email, name, segment, company, role, status } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });
    if (!segment) return res.status(400).json({ success: false, error: 'Segment is required' });

    const sheets = await getSheetsClient();
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = existing.data.values || [];
    const headers = (rows[0] || []).map(h => (h || '').toString().trim());
    const colIdx = (n) => headers.findIndex(h => h.toLowerCase() === n.toLowerCase());
    const now = new Date().toISOString();
    const unsubToken = makeToken(16);
    const subscriberId = `SUB-${Date.now()}`;
    const emailIdx = colIdx('Email');
    const existingRow = rows.findIndex((r, i) => i > 0 && (r[emailIdx] || '').toLowerCase() === email.toLowerCase());
    const outRow = new Array(headers.length).fill('');
    if (existingRow !== -1) { const er = rows[existingRow] || []; for (let i = 0; i < outRow.length; i++) outRow[i] = er[i] ?? ''; }
    const set = (col, val) => { const i = colIdx(col); if (i !== -1) outRow[i] = val ?? ''; };
    set('Subscriber_ID', existingRow !== -1 ? (rows[existingRow][colIdx('Subscriber_ID')] || subscriberId) : subscriberId);
    set('Email', email.trim().toLowerCase()); set('Name', name || '');
    set('Segment', canonicalSegmentCsv(segment.split(','))); set('Status', status || 'active');
    set('Subscribed_At', existingRow !== -1 ? (rows[existingRow][colIdx('Subscribed_At')] || now) : now);
    set('Confirmed_At', now); set('Unsub_Token', existingRow !== -1 ? (rows[existingRow][colIdx('Unsub_Token')] || unsubToken) : unsubToken);
    set('Company', company || ''); set('Role', role || ''); set('Updated_At', now);
    set('Unsubscribed_At', ''); set('Paused_At', ''); set('Resume_At', '');

    if (existingRow !== -1) {
      const lastCol = String.fromCharCode(65 + headers.length - 1);
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${existingRow + 1}:${lastCol}${existingRow + 1}`, valueInputOption: 'RAW', requestBody: { values: [outRow] } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [outRow] } });
    }
    return res.json({ success: true, message: `Subscriber ${email} added/updated as active` });
  } catch (e) {
    console.error('Admin add subscriber error:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Admin activate pending subscriber
app.post('/api/admin/subscriber/activate', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: 'Email required' });
    const sheets = await getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = resp.data.values || [];
    const headers = (rows[0] || []).map(h => (h || '').trim());
    const emailIdx = headers.findIndex(h => h.toLowerCase() === 'email');
    const statusIdx = headers.findIndex(h => h.toLowerCase() === 'status');
    const confirmedIdx = headers.findIndex(h => h.toLowerCase() === 'confirmed_at');
    const updatedIdx = headers.findIndex(h => h.toLowerCase() === 'updated_at');
    const rowIdx = rows.findIndex((r, i) => i > 0 && (r[emailIdx] || '').toLowerCase() === email.toLowerCase());
    if (rowIdx === -1) return res.status(404).json({ success: false, error: 'Subscriber not found' });
    const row = [...rows[rowIdx]];
    const now = new Date().toISOString();
    if (statusIdx !== -1) row[statusIdx] = 'active';
    if (confirmedIdx !== -1) row[confirmedIdx] = now;
    if (updatedIdx !== -1) row[updatedIdx] = now;
    const lastCol = String.fromCharCode(65 + headers.length - 1);
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${rowIdx + 1}:${lastCol}${rowIdx + 1}`, valueInputOption: 'RAW', requestBody: { values: [row] } });
    return res.json({ success: true, message: `${email} activated` });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET single subscriber (by email, used by edit modal)
app.get('/api/subscriber/:id', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.id);
    const SheetsManager = require('../config/sheets');
    const sm = new SheetsManager();
    await sm.initialize();
    const s = await sm.getSubscriberByEmail(email);
    if (!s) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, subscriber: s });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// PUT subscriber — full update via edit modal
// Accepts segment as comma-separated string OR array; merges cleanly
app.put('/api/subscribers/:email', async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email);
    const { name, segment, segments, company, role, status } = req.body;

    if (status && !['active', 'paused', 'unsubscribed', 'pending'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    // Resolve segment input — accept string or array
    let resolvedSegmentCsv = null;
    if (Array.isArray(segments) && segments.length > 0) {
      resolvedSegmentCsv = canonicalSegmentCsv(segments);
    } else if (typeof segment === 'string' && segment.trim()) {
      // Support comma-separated string e.g. "pro,driver" OR single value
      resolvedSegmentCsv = canonicalSegmentCsv(segment.split(','));
    }

    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = response.data.values || [];
    if (rows.length < 2) return res.status(404).json({ success: false, error: 'Subscriber not found' });

    const headers = (rows[0] || []).map(h => (h || '').trim());
    const col = (n) => headers.findIndex(h => h.toLowerCase() === n.toLowerCase());
    const emailIdx = col('Email');

    let targetRowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][emailIdx] || '').toLowerCase() === targetEmail.toLowerCase()) {
        targetRowIndex = i; break;
      }
    }
    if (targetRowIndex === -1) return res.status(404).json({ success: false, error: 'Subscriber not found' });

    // Clone the row and update only provided fields
    const row = [...rows[targetRowIndex]];
    while (row.length < headers.length) row.push('');
    const set = (n, v) => { const i = col(n); if (i !== -1 && v !== undefined && v !== null) row[i] = v; };

    set('Name', name);
    set('Segment', resolvedSegmentCsv);
    set('Status', status);
    set('Company', company);
    set('Role', role);
    set('Updated_At', new Date().toISOString());

    const lastCol = String.fromCharCode(65 + headers.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID(),
      range: `Subscribers!A${targetRowIndex + 1}:${lastCol}${targetRowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });

    res.json({ success: true, message: 'Subscriber updated', data: { email: targetEmail, segment: resolvedSegmentCsv || row[col('Segment')] || '', status: row[col('Status')] || '', updatedAt: row[col('Updated_At')] || '' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Alias for dashboard (uses /api/subscriber/:id)
app.put('/api/subscriber/:id', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.id);
    const SheetsManager = require('../config/sheets');
    const sm = new SheetsManager();
    await sm.initialize();
    const updated = await sm.updateSubscriberByEmail(email, req.body);
    return res.json({ success: true, subscriber: updated });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE subscriber with audit trail
app.delete('/api/subscribers/:email', async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email);
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = response.data.values || [];
    const headers = rows[0] || [];
    let targetRowIndex = -1, subscriberData = null;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][1] || '').toLowerCase() === targetEmail.toLowerCase()) { targetRowIndex = i; subscriberData = rows[i]; break; }
    }
    if (targetRowIndex === -1) return res.status(404).json({ success: false, error: 'Subscriber not found' });

    const metaResp = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID() });
    const subSheet = metaResp.data.sheets.find(s => s.properties.title === 'Subscribers');
    const sheetId = subSheet ? subSheet.properties.sheetId : 0;
    const snapshot = {};
    headers.forEach((h, i) => { snapshot[h] = subscriberData[i] || ''; });

    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID(), requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: targetRowIndex, endIndex: targetRowIndex + 1 } } }] } });
    await writeSubscriptionAudit(sheets, { action: 'deleted', email: targetEmail, metadata: JSON.stringify({ deleted_by: 'admin_dashboard', subscriber_id: snapshot['Subscriber_ID'] || '', name: snapshot['Name'] || '', segment: snapshot['Segment'] || '', subscribed_at: snapshot['Subscribed_At'] || '' }), ip: req.ip || '', ua: req.headers['user-agent'] || '' });
    res.json({ success: true, message: 'Subscriber deleted', data: { email: targetEmail } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Alias
app.delete('/api/subscriber/:id', async (req, res) => {
  req.params.email = req.params.id;
  // Forward to main delete handler via direct call
  try {
    const targetEmail = decodeURIComponent(req.params.id);
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = response.data.values || [];
    const headers = rows[0] || [];
    let targetRowIndex = -1, subscriberData = null;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][1] || '').toLowerCase() === targetEmail.toLowerCase()) { targetRowIndex = i; subscriberData = rows[i]; break; }
    }
    if (targetRowIndex === -1) return res.status(404).json({ success: false, error: 'Not found' });
    const metaResp = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID() });
    const subSheet = metaResp.data.sheets.find(s => s.properties.title === 'Subscribers');
    const sheetId = subSheet ? subSheet.properties.sheetId : 0;
    const snapshot = {};
    headers.forEach((h, i) => { snapshot[h] = subscriberData[i] || ''; });
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID(), requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: targetRowIndex, endIndex: targetRowIndex + 1 } } }] } });
    await writeSubscriptionAudit(sheets, { action: 'deleted', email: targetEmail, metadata: JSON.stringify({ deleted_by: 'admin_dashboard', subscriber_id: snapshot['Subscriber_ID'] || '' }), ip: req.ip || '', ua: req.headers['user-agent'] || '' });
    return res.json({ success: true, data: { email: targetEmail } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// CSV download
app.get('/api/subscribers/csv', async (req, res) => {
  try {
    const sheets = await getSheetsClient(true);
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = response.data.values || [];
    if (rows.length === 0) { res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"'); return res.send(''); }
    const headers = rows[0];
    const seg = (req.query.segment || '').toLowerCase();
    const segIdx = headers.findIndex(h => h.toLowerCase() === 'segment');
    const dataRows = rows.slice(1).filter(row => !seg || segIdx === -1 || (row[segIdx] || '').toLowerCase().includes(seg));
    const csvEscape = val => '"' + (val || '').toString().replace(/"/g, '""') + '"';
    const csvLines = [headers.map(csvEscape).join(','), ...dataRows.map(row => headers.map((_, i) => csvEscape(row[i] || '')).join(','))];
    const filename = seg ? `subscribers-${seg}.csv` : 'subscribers.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('\uFEFF' + csvLines.join('\n'));
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM / UNSUBSCRIBE / PAUSE (public — no auth)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/confirm', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).send('Missing token');
    const sheets = await getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = resp.data.values || [];
    if (rows.length < 2) return res.status(404).send('Token not found');
    const headers = (rows[0] || []).map(h => (h || '').toString().trim());
    const col = (n) => headers.findIndex(h => h.toLowerCase() === n.toLowerCase());
    const idxConfirm = col('Confirm_Token'), idxStatus = col('Status');
    const idxUpdated = col('Updated_At'), idxConfirmedAt = col('Confirmed_At');
    const idxEmail = col('Email'), idxSegment = col('Segment');
    if ([idxConfirm, idxStatus, idxUpdated, idxConfirmedAt].some(i => i === -1)) return res.status(500).send('Sheet headers missing required columns');
    const rowIndex = rows.findIndex((r, i) => i >= 1 && (r[idxConfirm] || '') === token);
    if (rowIndex === -1) return res.status(404).send('Token not found');
    const row = rows[rowIndex];
    const now = new Date().toISOString();
    const currentStatus = (row[idxStatus] || '').toString().toLowerCase();
    const email0 = idxEmail !== -1 ? (row[idxEmail] || '') : '';
    const segment0 = idxSegment !== -1 ? (row[idxSegment] || '') : '';
    if (currentStatus === 'active') return res.redirect(`https://www.safefreightprogram.com/subscribe-confirmed?email=${encodeURIComponent(email0)}&segments=${encodeURIComponent(segment0)}&mode=already`);
    if (currentStatus !== 'pending') return res.redirect('https://www.safefreightprogram.com/subscribe-confirmed?mode=already');
    row[idxStatus] = 'active'; row[idxConfirmedAt] = now; row[idxUpdated] = now;
    const lastCol = String.fromCharCode(65 + headers.length - 1);
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${rowIndex + 1}:${lastCol}${rowIndex + 1}`, valueInputOption: 'RAW', requestBody: { values: [row] } });
    return res.redirect(`https://www.safefreightprogram.com/subscribe-confirmed?email=${encodeURIComponent(email0)}&segments=${encodeURIComponent(segment0)}`);
  } catch (e) {
    console.error('Confirm error:', e);
    return res.status(500).send('Confirm failed');
  }
});

app.get('/api/unsubscribe', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).send('Missing token');
    const target = ['pro', 'driver', 'all'].includes(req.query.segment) ? req.query.segment : 'all';
    const sheets = await getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = resp.data.values || [];
    if (rows.length < 2) return res.status(404).send('Token not found');
    const headers = (rows[0] || []).map(h => (h || '').toString().trim());
    const col = (n) => headers.findIndex(h => h.toLowerCase() === n.toLowerCase());
    const idxUnsub = col('Unsub_Token'), idxStatus = col('Status');
    const idxUpdated = col('Updated_At'), idxUnsubAt = col('Unsubscribed_At');
    const idxEmail = col('Email'), idxSegment = col('Segment');
    const rowIndex = rows.findIndex((r, i) => i >= 1 && (r[idxUnsub] || '') === token);
    if (rowIndex === -1) return res.status(404).send('Token not found');
    const row = rows[rowIndex];
    const now = new Date().toISOString();
    const currentStatus = (row[idxStatus] || '').toString().toLowerCase();
    const email = (row[idxEmail] || '');
    if (currentStatus === 'unsubscribed') return res.redirect(`https://www.safefreightprogram.com/unsubscribe-confirmed?email=${encodeURIComponent(email)}&segment=${encodeURIComponent(target)}&already=1`);
    const segments = (row[idxSegment] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const nextSegments = target === 'all' ? [] : segments.filter(s => s !== target);
    const nextCsv = canonicalSegmentCsv(nextSegments);
    row[idxSegment] = nextCsv; row[idxUpdated] = now;
    if (nextSegments.length === 0) { row[idxStatus] = 'unsubscribed'; row[idxUnsubAt] = now; }
    else { row[idxStatus] = 'active'; row[idxUnsubAt] = ''; }
    const lastCol = String.fromCharCode(65 + headers.length - 1);
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${rowIndex + 1}:${lastCol}${rowIndex + 1}`, valueInputOption: 'RAW', requestBody: { values: [row] } });
    return res.redirect(`https://www.safefreightprogram.com/unsubscribe-confirmed?email=${encodeURIComponent(email)}&segments=${encodeURIComponent(nextCsv)}&segment=${encodeURIComponent(target)}`);
  } catch (e) {
    console.error('Unsubscribe error:', e);
    return res.status(500).send('Unsubscribe failed');
  }
});

app.get('/api/pause', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).send('Missing token');
    const sheets = await getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A:Z' });
    const rows = resp.data.values || [];
    if (rows.length < 2) return res.status(404).send('Token not found');
    const headers = rows[0].map(h => (h || '').toString().trim());
    const col = n => headers.findIndex(h => h.toLowerCase() === n.toLowerCase());
    const idxUnsub = col('Unsub_Token'), idxPaused = col('Paused_At'), idxResume = col('Resume_At');
    const idxUpdated = col('Updated_At'), idxEmail = col('Email');
    const rowIndex = rows.findIndex((r, i) => i >= 1 && (r[idxUnsub] || '') === token);
    if (rowIndex === -1) return res.status(404).send('Token not found');
    const row = [...rows[rowIndex]];
    const now = new Date();
    const resumeAt = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
    row[idxPaused] = now.toISOString(); row[idxResume] = resumeAt.toISOString(); row[idxUpdated] = now.toISOString();
    const email = row[idxEmail] || '';
    const lastCol = String.fromCharCode(65 + headers.length - 1);
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID(), range: `Subscribers!A${rowIndex + 1}:${lastCol}${rowIndex + 1}`, valueInputOption: 'RAW', requestBody: { values: [row] } });
    await writeSubscriptionAudit(sheets, { action: 'paused', email, metadata: JSON.stringify({ resume_at: resumeAt.toISOString(), duration_days: 28 }), ip: req.ip || '', ua: req.headers['user-agent'] || '' });
    const resumeFormatted = resumeAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
    return res.redirect(`https://www.safefreightprogram.com/paused?email=${encodeURIComponent(email)}&resume=${encodeURIComponent(resumeFormatted)}`);
  } catch (e) {
    console.error('Pause error:', e);
    return res.status(500).send('Pause failed — email hello@safefreightprogram.com.au');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTICLES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/articles', async (req, res) => {
  try {
    const { limit = 50, unused_only = false } = req.query;
    const sheets = await getSheetsClient(true);
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Article_Archive!A:P' });
    const rows = response.data.values || [];
    const headers = rows[0] || [];
    let articles = rows.slice(1, parseInt(limit) + 1).map(row => {
      const a = {};
      headers.forEach((h, i) => { a[h.toLowerCase().replace(/\s+/g, '_')] = row[i] || ''; });
      return a;
    });
    if (unused_only === 'true') articles = articles.filter(a => !a.used_in_issue || a.used_in_issue === '');
    res.json({ success: true, data: articles, count: articles.length, total_unused: articles.filter(a => !a.used_in_issue).length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NEWSLETTERS LIST
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/newsletters', async (req, res) => {
  try {
    const sheets = await getSheetsClient(true);
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Content_Archive!A:J' });
    const rows = response.data.values || [];
    const newsletters = rows.slice(1, 21).map(row => ({ id: row[0] || '', segment: row[1] || '', subject: row[2] || '', published_at: row[3] || '', sent_count: parseInt(row[4]) || 0, open_rate: parseFloat(row[6]) || 0, click_rate: parseFloat(row[7]) || 0 }));
    res.json({ success: true, data: newsletters, count: newsletters.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
async function fetchResendEngagement(resendIds) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || resendIds.length === 0) return [];
  const results = [];
  for (const id of resendIds) {
    try {
      const resp = await fetch(`https://api.resend.com/emails/${id}`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!resp.ok) continue;
      const data = await resp.json();
      results.push({ id, to: data.to?.[0] || '', subject: data.subject || '', created_at: data.created_at, last_event: data.last_event, opens: data.opens || [], clicks: data.clicks || [] });
      await new Promise(r => setTimeout(r, 120));
    } catch (e) { console.warn(`Resend fetch failed for ${id}:`, e.message); }
  }
  return results;
}

async function buildEngagementSummary(days = 30) {
  const sheets = await getSheetsClient();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const sendLogResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Send_Log!A:F' });
  const sendRows = (sendLogResp.data.values || []).slice(1).filter(r => r[0] >= cutoff && r[4] !== 'true');
  const allResendIds = [], issueMap = {};
  for (const row of sendRows) {
    try { const notes = JSON.parse(row[5] || '{}'); (notes.resend_ids || []).forEach(id => { allResendIds.push(id); issueMap[id] = { issue_id: notes.issue_id, segment: row[1] }; }); } catch (e) { /* skip */ }
  }
  if (allResendIds.length === 0) return { message: 'No send data yet', bySource: {}, byCategory: {}, byIssue: [] };
  const emailEvents = await fetchResendEngagement(allResendIds);
  const archiveResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Content_Archive!A:J' });
  const articleMap = {};
  for (const row of (archiveResp.data.values || []).slice(1)) {
    try { const articles = JSON.parse(row[8] || '[]'); articles.forEach(a => { if (a.url) articleMap[a.url] = { source: a.source || 'Unknown', category: a.category || 'Unknown', title: a.title || '', issue_id: row[0] }; }); } catch (e) { /* skip */ }
  }
  const bySource = {}, byCategory = {}, byIssue = {}, engagementRows = [];
  for (const email of emailEvents) {
    const ctx = issueMap[email.id] || {};
    const issueId = ctx.issue_id || 'unknown';
    const opened = email.opens.length > 0;
    const clickedUrls = email.clicks.map(c => c.link).filter(Boolean);
    if (!byIssue[issueId]) byIssue[issueId] = { sent: 0, opened: 0, click_events: 0, clicked_urls: new Set() };
    byIssue[issueId].sent++;
    if (opened) byIssue[issueId].opened++;
    if (clickedUrls.length > 0) byIssue[issueId].click_events += clickedUrls.length;
    clickedUrls.forEach(u => byIssue[issueId].clicked_urls.add(u));
    for (const url of clickedUrls) {
      const article = articleMap[url];
      if (!article) continue;
      const src = article.source, cat = article.category;
      if (!bySource[src]) bySource[src] = { impressions: 0, clicks: 0 };
      if (!byCategory[cat]) byCategory[cat] = { impressions: 0, clicks: 0 };
      bySource[src].impressions++; bySource[src].clicks++;
      byCategory[cat].impressions++; byCategory[cat].clicks++;
      engagementRows.push([email.to, issueId, 'click', new Date().toISOString(), '', '', cat, article.title]);
    }
    if (opened) engagementRows.push([email.to, issueId, 'open', new Date().toISOString(), '', '', '', '']);
  }
  Object.values(bySource).forEach(s => { s.click_rate = s.impressions > 0 ? ((s.clicks / s.impressions) * 100).toFixed(1) + '%' : '0%'; });
  Object.values(byCategory).forEach(c => { c.click_rate = c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(1) + '%' : '0%'; });
  if (engagementRows.length > 0) await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID(), range: 'Engagement_Tracking!A:H', valueInputOption: 'RAW', requestBody: { values: engagementRows } });
  const issueList = Object.entries(byIssue).map(([id, d]) => ({ issue_id: id, sent: d.sent, opened: d.opened, open_rate: d.sent > 0 ? ((d.opened / d.sent) * 100).toFixed(1) + '%' : '0%', unique_clicks: d.clicked_urls.size, click_events: d.click_events, clicked_articles: [...d.clicked_urls].map(u => articleMap[u]?.title || u).filter(Boolean) })).sort((a, b) => b.issue_id.localeCompare(a.issue_id));
  return { bySource, byCategory, byIssue: issueList, emailsFetched: emailEvents.length };
}

app.get('/api/analytics/summary', async (req, res) => {
  try {
    const subscriberData = await emailSender.testEmailSystem();
    const sheets = await getSheetsClient(true);
    const analyticsResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Issues_Analytics!A:I' });
    const analyticsRows = (analyticsResp.data.values || []).slice(1, 11);
    const issues = analyticsRows.map(r => ({ issue_id: r[0], segment: r[1], subject: r[2], sent: r[4], open_rate: r[6], clicks: r[7] }));
    const totalSent = issues.reduce((s, i) => s + (parseInt(i.sent) || 0), 0);
    res.json({ success: true, data: { subscribers: { total: subscriberData.totalSubscribers || 0, pro: subscriberData.proSubscribers || 0, driver: subscriberData.driverSubscribers || 0 }, recent_issues: issues, emailsSent7d: totalSent, successRate: 100, articlesScraped: issues.length, systemUptime: 99.9, system: { status: 'operational', email_configured: !!process.env.RESEND_API_KEY } }, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/analytics/engagement', async (req, res) => {
  try {
    const days = parseInt(req.query.days || req.body?.days || 30);
    const summary = await buildEngagementSummary(days);
    res.json({ success: true, data: summary, computed_at: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/analytics/engagement', async (req, res) => {
  try {
    const sheets = await getSheetsClient(true);
    const [analyticsResp, engTrackResp] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Issues_Analytics!A:I' }),
      sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Engagement_Tracking!A:H' })
    ]);
    const issues = (analyticsResp.data.values || []).slice(1).map(r => ({ issue_id: r[0], segment: r[1], subject: r[2], published: r[3], sent: r[4], open_rate: r[6], clicks: r[7] }));
    const byCategory = {};
    const engRows = (engTrackResp.data.values || []).slice(1).filter(r => r[2] === 'click');
    for (const row of engRows) { const cat = row[6] || 'Unknown'; byCategory[cat] = (byCategory[cat] || 0) + 1; }
    res.json({ success: true, data: { issues, by_category: byCategory, total_click_events: engRows.length, note: engRows.length === 0 ? 'No engagement data yet — POST to /api/analytics/engagement to pull from Resend' : null } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATUS + DEBUG ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const emailStatus = await emailSender.verifyConnection();
    const subscriberTest = await emailSender.testEmailSystem();
    res.json({ status: 'running', version: '3.0.0', uptime: process.uptime(), environment: process.env.NODE_ENV || 'production', services: { email: { configured: !!process.env.RESEND_API_KEY, connected: emailStatus, subscribers: subscriberTest.totalSubscribers || 0 }, sheets: { configured: !!process.env.GOOGLE_SHEETS_ID, connected: subscriberTest.smtpWorking }, openai: { configured: !!process.env.OPENAI_API_KEY } }, currentTime: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }), timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message, timestamp: new Date().toISOString() });
  }
});

app.get('/api/email-status', async (req, res) => {
  try {
    const connectionVerified = await emailSender.verifyConnection();
    res.json({ success: true, configuration: { emailConfigured: !!process.env.RESEND_API_KEY, recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS, connectionVerified, fromAddress: process.env.EMAIL_FROM || 'Not configured', environment: process.env.NODE_ENV || 'production' }, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, configuration: { emailConfigured: !!process.env.RESEND_API_KEY, connectionVerified: false }, error: error.message, timestamp: new Date().toISOString() });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ success: true, data: { scheduling: scheduler.getConfiguration(), email: { configured: !!process.env.RESEND_API_KEY, provider: 'resend', from_address: process.env.EMAIL_FROM || 'newsletter@safefreightprogram.com' }, sheets: { configured: !!process.env.GOOGLE_SHEETS_ID, spreadsheet_id: process.env.GOOGLE_SHEETS_ID ? '✓ Connected' : '✗ Not configured' }, openai: { configured: !!process.env.OPENAI_API_KEY, model: 'gpt-4o' } } });
});

app.get('/api/debug', (req, res) => {
  res.json({ timestamp: new Date().toISOString(), nodeEnv: process.env.NODE_ENV, environment: { hasOpenAI: !!process.env.OPENAI_API_KEY, hasGoogleEmail: !!process.env.GOOGLE_CLIENT_EMAIL, hasGoogleKey: !!process.env.GOOGLE_PRIVATE_KEY, hasResendKey: !!process.env.RESEND_API_KEY, hasSheetsId: !!process.env.GOOGLE_SHEETS_ID, hasAdminAuth: !!(process.env.ADMIN_USER && process.env.ADMIN_PASS) }, memory: process.memoryUsage() });
});

app.get('/api/test/connection', async (req, res) => {
  const tests = {};
  try {
    tests.sheets = { configured: !!process.env.GOOGLE_SHEETS_ID };
    if (process.env.GOOGLE_CLIENT_EMAIL) {
      try {
        const sheets = await getSheetsClient(true);
        await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID(), range: 'Subscribers!A1:A1' });
        tests.sheets.connected = true;
      } catch (e) { tests.sheets.connected = false; tests.sheets.error = e.message; }
    }
    try { tests.email = await emailSender.testEmailSystem(); } catch (e) { tests.email = { error: e.message }; }
    tests.openai = { configured: !!process.env.OPENAI_API_KEY };
    res.json({ success: true, tests, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, tests });
  }
});

app.post('/api/test/scrape', async (req, res) => {
  try {
    const startTime = Date.now();
    const results = await scrapeAllSources();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    res.json({ success: true, message: 'Scraping test completed', data: { articles_found: results.articles?.length || 0, duration: `${duration}s`, errors: results.errors?.length || 0, sample_titles: results.articles?.slice(0, 3).map(a => a.title) || [] } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/test/newsletter', async (req, res) => {
  try {
    const { segment = 'pro' } = req.body;
    const gen = new NewsletterGenerator();
    const newsletter = await gen.generateNewsletter(segment, false);
    res.json({ success: true, message: 'Newsletter generated (not sent)', data: { segment, subject: newsletter.subject, articles_count: newsletter.articles?.length || 0, html_length: newsletter.html?.length || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/test/env', (req, res) => {
  res.json({ success: true, environment: { NODE_ENV: process.env.NODE_ENV || 'not set', GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID ? '✓ Set' : '✗ Missing', GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL ? '✓ Set' : '✗ Missing', GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? '✓ Set' : '✗ Missing', OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '✓ Set' : '✗ Missing', RESEND_API_KEY: process.env.RESEND_API_KEY ? '✓ Set' : '✗ Missing', ADMIN_USER: process.env.ADMIN_USER ? '✓ Set' : '✗ Missing (auth disabled)', ADMIN_PASS: process.env.ADMIN_PASS ? '✓ Set' : '✗ Missing (auth disabled)', timestamp: new Date().toISOString() } });
});

app.get('/api/debug/openai', async (req, res) => {
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Reply with just "API WORKING"' }], max_tokens: 10 });
    res.json({ success: true, message: 'OpenAI API working', response: response.choices[0].message.content, apiKeyPresent: !!process.env.OPENAI_API_KEY });
  } catch (error) {
    res.json({ success: false, error: error.message, apiKeyPresent: !!process.env.OPENAI_API_KEY });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST EMAIL
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  try {
    const { email, segment = 'pro' } = req.body;
    const testRecipient = email || process.env.NEWSLETTER_RECIPIENTS?.split(',')[0];
    if (!testRecipient) return res.status(400).json({ success: false, error: 'No test recipient provided' });
    const testData = { html: `<html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;"><h2 style="color:#1e40af;">SFP Newsletter System Test</h2><p>Email sending is working correctly.</p><p><strong>Test Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</p></body></html>`, text: 'SFP Newsletter System Test — working correctly', subject: 'SFP Newsletter System Test' };
    await emailSender.sendSingleEmail(testData, { email: testRecipient, name: 'Test User', segment: 'test' });
    res.json({ success: true, message: 'Test email sent', data: { recipient: testRecipient, timestamp: new Date().toISOString() } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER — with Google Sheets config persistence
// ─────────────────────────────────────────────────────────────────────────────
let scheduler;

if (process.env.NODE_ENV === 'production') {
  scheduler = new AdvancedScheduler();

  // Override scheduler's config save to use Google Sheets instead of /tmp
  // The scheduler still loads from /tmp on first start — we'll seed it from Sheets on startup
  scheduler.onJobComplete = async (jobType) => {
    const now = new Date().toISOString();
    if (jobType === 'scraping') {
      systemState.lastScrape = { timestamp: now, trigger: 'scheduled' };
      await logSystemEvent('scrape_completed', { trigger: 'scheduled' });
    } else if (jobType === 'newsletter') {
      systemState.lastSent.pro = { timestamp: now, trigger: 'scheduled', subject: 'CoR Intel Weekly' };
      systemState.lastSent.driver = { timestamp: now, trigger: 'scheduled', subject: 'Safe Freight Mate' };
      await logSystemEvent('newsletter_sent', { segment: 'pro,driver', trigger: 'scheduled' });
    }
  };

  scheduler.initialize();
  setupAdvancedSchedulingEndpoints(app, scheduler);

  // After scheduler is running, load config from Sheets and apply it
  loadScheduleConfigFromSheets().then(sheetsConfig => {
    if (sheetsConfig) {
      try {
        if (sheetsConfig.scraping) scheduler.updateSchedule('scraping', sheetsConfig.scraping);
        if (sheetsConfig.newsletter) scheduler.updateSchedule('newsletter', sheetsConfig.newsletter);
        console.log('✅ Schedule config applied from Google Sheets');
      } catch (e) {
        console.warn('Could not apply Sheets schedule config:', e.message);
      }
    }
  }).catch(() => {});

} else {
  scheduler = {
    getConfiguration: () => ({
      schedules: { scraping: { enabled: false, frequency: 'weekly', dayOfWeek: 1, hour: 16, minute: 45 }, newsletter: { enabled: false, frequency: 'weekly', dayOfWeek: 1, hour: 17, minute: 30 } },
      nextRuns: { scraping: 'Dev mode — disabled', newsletter: 'Dev mode — disabled' },
      activeJobs: [], dependencies: {}
    }),
    updateSchedule: () => { throw new Error('Scheduling not available in dev mode'); },
    triggerJob: async (jobType) => { console.log(`🔧 Dev mode trigger: ${jobType}`); }
  };
  setupAdvancedSchedulingEndpoints(app, scheduler);
}

// Intercept the schedule PUT endpoint to ALSO save to Google Sheets
// We wrap after setupAdvancedSchedulingEndpoints registers its handlers
app.put('/api/schedule/:jobType', async (req, res, next) => {
  // This runs AFTER the scheduler's own handler has already responded — use a post-hook approach
  // Instead: we save to Sheets on every successful schedule update
  // Note: because Express routes are matched first-come-first-served, we hook via a separate route
  // that fires after the scheduler's PUT. Since we can't easily do that, we save to Sheets
  // asynchronously whenever the schedule status endpoint is hit with a change.
  next(); // Let scheduler's registered handler respond
});

// Dedicated endpoint: save current schedule to Google Sheets (called by dashboard Save button)
app.post('/api/schedule/save-to-sheets', async (req, res) => {
  try {
    const config = scheduler.getConfiguration();
    await saveScheduleConfigToSheets(config.schedules);
    res.json({ success: true, message: 'Schedule config saved to Google Sheets — will persist across redeploys' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 + ERROR HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { console.log('SIGTERM received, shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT received, shutting down'); process.exit(0); });

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ SFP Newsletter Automation v3.0.0 running on port ${PORT}`);
  console.log(`🌐 Admin Dashboard: http://localhost:${PORT}/admin`);
  console.log(`🔒 Auth: ${(process.env.ADMIN_USER && process.env.ADMIN_PASS) ? 'ENABLED (Basic Auth)' : 'DISABLED — set ADMIN_USER + ADMIN_PASS env vars'}`);
  console.log(`📅 Schedule persistence: Google Sheets (Schedule_Config tab)`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'production'}`);
  restoreSystemState().catch(e => console.warn('State restore error:', e.message));
});
