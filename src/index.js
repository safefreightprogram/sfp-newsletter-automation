require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { google } = require('googleapis');
const NewsletterGenerator = require('./generator');
const { scrapeAllSources } = require('./scraper');
const EmailSender = require('./emailSender');
const { AdvancedScheduler, setupAdvancedSchedulingEndpoints } = require('./advancedScheduler');
const crypto = require('crypto');


const app = express();
const PORT = process.env.PORT || 3000;

// --- ENVIRONMENT VALIDATION ---
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
    console.log('🔧 Set these in Railway dashboard under Variables');
    return false;
  }
  console.log('✅ All required environment variables present');
  return true;
}

if (process.env.NODE_ENV === 'production' && !validateEnvironment()) {
  console.error('🚫 Production startup failed due to missing environment variables');
  process.exit(1);
}

// --- MIDDLEWARE ---
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/static', express.static('public', {
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.css')) {
      res.set('Content-Type', 'text/css; charset=utf-8');
    } else if (path.endsWith('.js')) {
      res.set('Content-Type', 'application/javascript; charset=utf-8');
    } else if (path.endsWith('.html')) {
      res.set('Content-Type', 'text/html; charset=utf-8');
    } else if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif') || path.endsWith('.svg')) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Cache-Control', 'public, max-age=31536000');
    }
  }
}));

// Serve assets files directly at root as well (for backward compatibility)
app.use(express.static('assets', {
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif') || path.endsWith('.svg')) {
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Access-Control-Allow-Methods', 'GET');
      res.set('Cache-Control', 'public, max-age=31536000');
    }
  }
}));

// --- SPECIFIC ROUTES FOR ADMIN DASHBOARD ---
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../newsletter-management.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../newsletter-management.html'));
});

app.get('/newsletter-management.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../newsletter-management.html'));
});

// --- GLOBALS ---
function makeToken(len = 24) {
  return crypto.randomBytes(len).toString('hex'); // 48 chars by default
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  if (!from) throw new Error('EMAIL_FROM not set');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Resend send failed: ${resp.status} ${txt}`);
  }

  return resp.json().catch(() => ({}));
}

const emailSender = new EmailSender();
let newsletterCache = new Map();

// ── SYSTEM STATE: in-memory + Events_Log persistence ─────────────────────────
// Survives restarts via Events_Log sheet; populated on startup and updated on events
const systemState = {
  lastScrape: null,       // { timestamp, articlesFound, savedCount, trigger }
  lastSent: {             // keyed by segment
    pro: null,            // { timestamp, subject, recipients, trigger }
    driver: null
  }
};

async function logSystemEvent(event, metadata = {}) {
  try {
    const { google } = require('googleapis');
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Events_Log!A:G',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          new Date().toISOString(),  // Timestamp
          event,                      // Event
          metadata.issue_id || '',    // Issue_ID
          metadata.segment || '',     // Segment
          '',                         // Token
          '',                         // Email
          JSON.stringify(metadata)    // URL (repurposed for metadata JSON)
        ]]
      }
    });
  } catch (e) {
    console.warn('Events_Log write failed (non-fatal):', e.message);
  }
}

// Restore systemState from Events_Log on startup
async function restoreSystemState() {
  try {
    const { google } = require('googleapis');
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Events_Log!A:G'
    });
    const rows = (resp.data.values || []).slice(1).reverse(); // most recent first

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
        // Stop once we have everything we need
        if (systemState.lastScrape && systemState.lastSent.pro && systemState.lastSent.driver) break;
      } catch (e) { /* skip malformed rows */ }
    }
    console.log(`✅ System state restored — last scrape: ${systemState.lastScrape?.timestamp || 'never'}`);
  } catch (e) {
    console.warn('Could not restore system state:', e.message);
  }
}

// GET /api/system/state — dashboard polls this for last scraped / last sent
app.get('/api/system/state', (req, res) => {
  res.json({
    success: true,
    data: {
      lastScrape: systemState.lastScrape,
      lastSent: systemState.lastSent
    }
  });
});



// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'SFP Newsletter Automation',
    version: '2.0.0'
  });
});

// --- ROOT DOCS ---
app.get('/', (req, res) => {
  res.json({
    message: 'SFP Newsletter Automation API',
    status: 'running',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    endpoints: [
      'GET /health - Health check',
      'GET /admin - Admin dashboard',
      'POST /api/scrape - Manual article scraping',
      'POST /api/newsletter/generate/:segment - Generate newsletter preview',
      'POST /api/newsletter/send/:newsletterId - Send generated newsletter',
      'GET /api/subscribers/:segment? - Get subscribers',
      'POST /api/subscribers - Add subscriber',
      'PUT /api/subscribers/:email - Update subscriber',
      'DELETE /api/subscribers/:email - Delete subscriber',
      'GET /api/status - System status',
      'GET /api/articles - Get article archive',
      'GET /api/newsletters - Get recent newsletters',
      'POST /api/newsletters/send - Send new newsletter',
      'POST /api/test-email - Send test email',
      'GET /api/analytics/summary - Analytics overview',
      'GET /api/config - System configuration'
    ]
  });
});

// --- API VERSION ---
app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    version: '2.0.0',
    system: 'SFP Newsletter Automation',
    timestamp: new Date().toISOString(),
    build: process.env.RAILWAY_GIT_COMMIT_SHA || 'local',
    environment: process.env.NODE_ENV || 'production'
  });
});

// --- SCRAPING (Manual) ---
app.post('/api/scrape', async (req, res) => {
  try {
    const { sources } = req.body; // Optional: specific sources to scrape
    const startTime = Date.now();
    
    console.log('🔍 Manual scraping triggered via API...');
    
    const results = await scrapeAllSources();
    const articles = results.articles || [];
    let savedCount = 0;
    
    if (articles.length > 0) {
      try {
        const SheetsManager = require('../config/sheets');
        const sheetsManager = new SheetsManager();
        await sheetsManager.initialize();
        const savedArticles = await sheetsManager.saveArticles(articles);
        savedCount = savedArticles.length;
        console.log(`💾 Saved ${savedCount} articles to sheets`);
      } catch (sheetsError) {
        console.error('⚠️ Failed to save to sheets:', sheetsError.message);
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Persist last scrape time to Events_Log for dashboard display
    const scrapeTimestamp = new Date().toISOString();
    systemState.lastScrape = { timestamp: scrapeTimestamp, articlesFound: articles.length, savedCount, trigger: 'manual' };
    await logSystemEvent('scrape_completed', { articlesFound: articles.length, savedCount, duration, trigger: 'manual' }).catch(() => {});

    res.json({
      success: true,
      message: 'Scraping completed successfully',
      data: {
        articlesFound: articles.length,
        savedToSheets: savedCount,
        duration: `${duration} seconds`,
        timestamp: scrapeTimestamp,
        sources: results.errors ? results.errors.length : 0,
        errors: results.errors || []
      }
    });
  } catch (error) {
    console.error('❌ Scraping API error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// --- NEWSLETTER PREVIEW (cache, never marks as used) ---
app.post('/api/newsletter/generate/:segment', async (req, res) => {
  try {
    const segment = req.params.segment;
    if (!['pro', 'driver'].includes(segment)) {
      return res.status(400).json({ success: false, error: 'Invalid segment. Must be "pro" or "driver"' });
    }
    const newsletterGenerator = new NewsletterGenerator();
    const newsletter = await newsletterGenerator.generateNewsletter(segment, false); // false = do not send
    const newsletterId = `NL_${segment}_${Date.now()}`;
    newsletterCache.set(newsletterId, {
      newsletter,
      segment,
      generatedAt: new Date().toISOString(),
      articles: newsletter.articles || []
    });
    if (newsletterCache.size > 10) {
      const oldestKey = newsletterCache.keys().next().value;
      newsletterCache.delete(oldestKey);
    }
    res.json({
      success: true,
      data: {
        newsletterId,
        segment,
        subject: newsletter.subject,
        articlesCount: newsletter.articles?.length || 0,
        previewHtml: newsletter.html,
        previewText: newsletter.text,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- NEWSLETTER SEND (only marks as used on real send) ---
app.post('/api/newsletter/send/:newsletterId', async (req, res) => {
  try {
    const newsletterId = req.params.newsletterId;
    const { testEmail, confirmSend } = req.body;
    const cachedData = newsletterCache.get(newsletterId);
    if (!cachedData) {
      return res.status(404).json({ success: false, error: 'Newsletter not found. Please generate preview first.' });
    }
    const { newsletter, segment, articles } = cachedData;
    if (testEmail) {
      const testSubscribers = await emailSender.getSubscribersFromSheet(segment);
const matched = testSubscribers.find(s => s.email.toLowerCase() === testEmail.toLowerCase());
const testSubscriber = matched || { email: testEmail, name: 'Test User', segment, unsubToken: 'test-token' };
await emailSender.sendSingleEmail(newsletter, testSubscriber);
      return res.json({ success: true, message: 'Test email sent successfully', data: { newsletterId, testEmail, segment } });
    }
    if (confirmSend) {
      const subscribers = await emailSender.getSubscribersFromSheet(segment);
      const sendResult = await emailSender.sendBulkEmails(newsletter, subscribers);
      await markArticlesAsUsed(articles, segment, newsletterId);
      // Write to Send_Log with Resend IDs for later analytics querying
      await writeSendLog(segment, newsletterId, newsletter, sendResult, articles).catch(e =>
        console.error('Send_Log write failed (non-fatal):', e.message)
      );
      // Update in-memory state and log to Events_Log
      const sentMeta = { segment, subject: newsletter.subject, recipients: subscribers.length, trigger: 'manual', issue_id: newsletterId };
      systemState.lastSent[segment] = { timestamp: new Date().toISOString(), ...sentMeta };
      await logSystemEvent('newsletter_sent', sentMeta).catch(() => {});
      newsletterCache.delete(newsletterId);
      return res.json({ success: true, message: 'Newsletter sent and articles marked as used', data: { newsletterId, segment, recipients: subscribers.length } });
    }
    return res.status(400).json({ success: false, error: 'Must specify either testEmail or confirmSend=true' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- MARK ARTICLES AS USED ---

// ─────────────────────────────────────────────────────────────────────────────
// SEND LOG: Write send metadata + Resend IDs to Google Sheets after each send
// ─────────────────────────────────────────────────────────────────────────────

// Helper: write a row to Subscription_Audit sheet
async function writeSubscriptionAudit(sheets, spreadsheetId, { action, email, metadata = '', ip = '', ua = '' }) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Subscription_Audit!A:F',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), action, email, metadata, ip, ua]]
      }
    });
  } catch (e) {
    console.warn('Subscription_Audit write failed (non-fatal):', e.message);
  }
}

async function writeSendLog(segment, issueId, newsletter, sendResult, articles) {
  const { google } = require('googleapis');
  const auth = await google.auth.getClient({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date().toISOString();

  // Build Send_Log row
  const resendIds = (sendResult.sentEmails || []).map(e => e.resend_id).filter(Boolean);
  const sendLogRow = [
    now,                                          // Timestamp
    segment,                                      // Segment
    sendResult.sentCount || 0,                    // Sent_Count
    sendResult.failedCount || 0,                  // Failed_Count
    'false',                                      // Is_Test
    JSON.stringify({                              // Notes — stores Resend IDs + issue context
      issue_id: issueId,
      subject: newsletter.subject,
      resend_ids: resendIds,
      article_count: articles?.length || 0
    })
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Send_Log!A:F',
    valueInputOption: 'RAW',
    requestBody: { values: [sendLogRow] }
  });

  // Also write/update Content_Archive row for this issue
  const contentRow = [
    issueId,                                      // Issue_ID
    segment,                                      // Segment
    newsletter.subject,                           // Subject
    now,                                          // Published_At
    sendResult.sentCount || 0,                    // Sent_Count
    sendResult.failedCount || 0,                  // Failed_Count
    '',                                           // Open_Rate (populated later by analytics)
    '',                                           // Click_Rate (populated later by analytics)
    JSON.stringify(articles || []),               // Content_JSON
    ''                                            // Notes
  ];

  // Check if this issue already exists in Content_Archive
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Content_Archive!A:A'
  });
  const issueIds = (existing.data.values || []).map(r => r[0]);
  const existingRow = issueIds.indexOf(issueId);

  if (existingRow > 0) {
    // Update existing row
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `Content_Archive!A${existingRow + 1}:J${existingRow + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [contentRow] }
    });
  } else {
    // Append new row
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Content_Archive!A:J',
      valueInputOption: 'RAW',
      requestBody: { values: [contentRow] }
    });
  }

  console.log(`📋 Send_Log written: ${sendResult.sentCount} sends, ${resendIds.length} Resend IDs stored`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS ENGINE: Pull Resend events and aggregate engagement by source/category
// ─────────────────────────────────────────────────────────────────────────────
async function fetchResendEngagement(resendIds) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || resendIds.length === 0) return [];

  const results = [];
  // Resend rate limit: 10 req/sec — fetch in batches with delay
  for (const id of resendIds) {
    try {
      const resp = await fetch(`https://api.resend.com/emails/${id}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      results.push({
        id,
        to: data.to?.[0] || '',
        subject: data.subject || '',
        created_at: data.created_at,
        last_event: data.last_event,
        opens: data.opens || [],
        clicks: data.clicks || []
      });
      await new Promise(r => setTimeout(r, 120)); // Stay under rate limit
    } catch (e) {
      console.warn(`Could not fetch Resend data for ${id}:`, e.message);
    }
  }
  return results;
}

async function buildEngagementSummary(days = 30) {
  const { google } = require('googleapis');
  const auth = await google.auth.getClient({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Read Send_Log to get Resend IDs for recent sends
  const sendLogResp = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Send_Log!A:F'
  });
  const sendRows = (sendLogResp.data.values || []).slice(1)
    .filter(r => r[0] >= cutoff && r[4] !== 'true'); // exclude tests, within window

  const allResendIds = [];
  const issueMap = {}; // resend_id -> issue context

  for (const row of sendRows) {
    try {
      const notes = JSON.parse(row[5] || '{}');
      const ids = notes.resend_ids || [];
      ids.forEach(id => {
        allResendIds.push(id);
        issueMap[id] = { issue_id: notes.issue_id, segment: row[1] };
      });
    } catch (e) { /* skip malformed rows */ }
  }

  if (allResendIds.length === 0) {
    return { message: 'No send data yet — analytics will populate after first real send', bySource: {}, byCategory: {}, byIssue: [] };
  }

  // Fetch engagement events from Resend
  console.log(`📊 Fetching Resend events for ${allResendIds.length} emails...`);
  const emailEvents = await fetchResendEngagement(allResendIds);

  // Read Content_Archive to build URL -> article metadata map
  const archiveResp = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'Content_Archive!A:J'
  });
  const archiveRows = (archiveResp.data.values || []).slice(1);
  const articleMap = {}; // url -> { source, category, title, issue_id }
  for (const row of archiveRows) {
    try {
      const articles = JSON.parse(row[8] || '[]');
      articles.forEach(a => {
        if (a.url) articleMap[a.url] = {
          source: a.source || 'Unknown',
          category: a.category || 'Unknown',
          title: a.title || '',
          issue_id: row[0]
        };
      });
    } catch (e) { /* skip */ }
  }

  // Aggregate engagement
  const bySource = {};    // source -> { sent, opened, clicked, clicks: [url] }
  const byCategory = {};  // category -> { sent, opened, clicked }
  const byIssue = {};     // issue_id -> { sent, opened, clicked, articles: [] }
  const engagementRows = []; // For Engagement_Tracking sheet

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

    // Map clicks to articles
    for (const url of clickedUrls) {
      const article = articleMap[url];
      if (!article) continue;

      const src = article.source;
      const cat = article.category;

      if (!bySource[src]) bySource[src] = { impressions: 0, clicks: 0, click_rate: 0 };
      if (!byCategory[cat]) byCategory[cat] = { impressions: 0, clicks: 0, click_rate: 0 };

      bySource[src].impressions++;
      bySource[src].clicks++;
      byCategory[cat].impressions++;
      byCategory[cat].clicks++;

      // Write to Engagement_Tracking
      engagementRows.push([
        email.to,            // Subscriber_ID (email as proxy)
        issueId,             // Issue_ID
        'click',             // Action
        new Date().toISOString(), // Timestamp
        '',                  // IP_Address
        '',                  // User_Agent
        cat,                 // Article_Category
        article.title        // Article_Title
      ]);
    }

    if (opened) {
      engagementRows.push([
        email.to, issueId, 'open', new Date().toISOString(), '', '', '', ''
      ]);
    }
  }

  // Calculate rates
  Object.values(bySource).forEach(s => {
    s.click_rate = s.impressions > 0 ? ((s.clicks / s.impressions) * 100).toFixed(1) + '%' : '0%';
  });
  Object.values(byCategory).forEach(c => {
    c.click_rate = c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(1) + '%' : '0%';
  });

  // Write Engagement_Tracking rows (append)
  if (engagementRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Engagement_Tracking!A:H',
      valueInputOption: 'RAW',
      requestBody: { values: engagementRows }
    });
  }

  // Build per-issue summary
  const issueList = Object.entries(byIssue).map(([id, d]) => ({
    issue_id: id,
    sent: d.sent,
    opened: d.opened,
    open_rate: d.sent > 0 ? ((d.opened / d.sent) * 100).toFixed(1) + '%' : '0%',
    unique_clicks: d.clicked_urls.size,
    click_events: d.click_events,
    clicked_articles: [...d.clicked_urls].map(u => articleMap[u]?.title || u).filter(Boolean)
  })).sort((a, b) => b.issue_id.localeCompare(a.issue_id));

  // Update Issues_Analytics sheet
  for (const issue of issueList) {
    const existingResp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'Issues_Analytics!A:A'
    });
    const existingIds = (existingResp.data.values || []).map(r => r[0]);
    const rowIdx = existingIds.indexOf(issue.issue_id);
    const analyticsRow = [
      issue.issue_id, '', '', '',
      issue.sent, 0, issue.open_rate, issue.click_events + ' clicks', ''
    ];
    if (rowIdx > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: `Issues_Analytics!A${rowIdx + 1}:I${rowIdx + 1}`,
        valueInputOption: 'RAW', requestBody: { values: [analyticsRow] }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: 'Issues_Analytics!A:I',
        valueInputOption: 'RAW', requestBody: { values: [analyticsRow] }
      });
    }
  }

  return { bySource, byCategory, byIssue: issueList, emailsFetched: emailEvents.length };
}

async function markArticlesAsUsed(articles, segment, newsletterId) {
  if (!articles || articles.length === 0) return;
  try {
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Article_Archive!A:Z',
    });
    const rows = response.data.values;
    if (!rows || rows.length < 2) return;
    const headers = rows[0];
    const urlCol = headers.findIndex(h => h === 'URL');
    const usedCol = headers.findIndex(h => h === 'Used_In_Issue');
    if (urlCol === -1 || usedCol === -1) return;
    const articleUrls = new Set(articles.map(a => a.url || a.link));
    const updates = [];
    const timestamp = new Date().toISOString();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const articleUrl = row[urlCol];
      if (articleUrls.has(articleUrl) && !row[usedCol]) {
        const usageMarker = `${segment}-${newsletterId}_${timestamp}`;
        updates.push({
          range: `Article_Archive!${String.fromCharCode(65 + usedCol)}${i + 1}`,
          values: [[usageMarker]]
        });
      }
    }
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }
  } catch (error) {
    console.error('Failed to mark articles as used:', error);
  }
}

// --- NEWSLETTER MANAGEMENT (Direct Send - Alternative API) ---
app.post('/api/newsletters/send', async (req, res) => {
  try {
    const { segment, testEmail } = req.body;
    
    if (!['pro', 'driver'].includes(segment)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid segment. Must be "pro" or "driver"'
      });
    }
    
    const newsletterGenerator = new NewsletterGenerator();
    
    if (testEmail) {
      // Send test email only
      const newsletter = await newsletterGenerator.generateNewsletter(segment, false);
      const testSubscribers = await emailSender.getSubscribersFromSheet(segment);
const matched = testSubscribers.find(s => s.email.toLowerCase() === testEmail.toLowerCase());
const testSubscriber = matched || { email: testEmail, name: 'Test User', segment, unsubToken: 'test-token' };
await emailSender.sendSingleEmail(newsletter, testSubscriber);
      
      return res.json({
        success: true,
        message: 'Test newsletter sent successfully',
        data: {
          segment: segment,
          recipient: testEmail,
          subject: newsletter.subject
        }
      });
    } else {
      // Send to all subscribers
      const newsletter = await newsletterGenerator.generateNewsletter(segment, true);
      
      return res.json({
        success: true,
        message: 'Newsletter sent to all subscribers',
        data: {
          segment: segment,
          subject: newsletter.subject,
          emailSending: newsletter.emailSending
        }
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --- GET RECENT NEWSLETTERS ---
app.get('/api/newsletters', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Content_Archive!A:J',
    });
    
    const rows = response.data.values || [];
    const newsletters = rows.slice(1, 21).map(row => ({ // Get last 20 newsletters
      id: row[0] || '',
      segment: row[1] || '',
      subject: row[2] || '',
      published_at: row[3] || '',
      sent_count: parseInt(row[4]) || 0,
      open_rate: parseFloat(row[6]) || 0,
      click_rate: parseFloat(row[7]) || 0
    }));
    
    res.json({
      success: true,
      data: newsletters,
      count: newsletters.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --- SUBSCRIBER MANAGEMENT ---
app.get('/api/subscribers/:segment?', async (req, res) => {
  try {
    const segment = req.params.segment;
    if (segment && !['pro', 'driver'].includes(segment)) {
      return res.status(400).json({ success: false, error: 'Invalid segment.' });
    }
    if (segment) {
      const subscribers = await emailSender.getSubscribersFromSheet(segment);
      return res.json({ success: true, data: { segment, subscribers } });
    } else {
      const [pro, driver] = await Promise.all([
        emailSender.getSubscribersFromSheet('pro'),
        emailSender.getSubscribersFromSheet('driver')
      ]);
      // Counts: treat "active" as the truth for totals (future-proof)
const proActive = pro.filter(s => (s.status || '').toLowerCase() === 'active');
const driverActive = driver.filter(s => (s.status || '').toLowerCase() === 'active');

// Unique active subscribers = unique emails across both active lists
const uniqueActiveEmails = new Set(
  [...proActive, ...driverActive]
    .map(s => (s.email || '').trim().toLowerCase())
    .filter(Boolean)
);

return res.json({
  success: true,
  data: {
    summary: {
      // Unique people
      totalActiveSubscribers: uniqueActiveEmails.size,

      // Subscriptions (double-counts dual opt-in by design)
      totalActiveSubscriptions: proActive.length + driverActive.length,

      // Segment subscription counts
      proActive: proActive.length,
      driverActive: driverActive.length
    },
    pro: { count: pro.length, subscribers: pro },
    driver: { count: driver.length, subscribers: driver }
  }
});
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/subscribers', async (req, res) => {
  try {
const { email, name, segment, segments, company, role } = req.body || {};
    
    // --- Validate ---
if (!email) {
  return res.status(400).json({ success: false, error: 'Email is required' });
}

// Accept either `segments: []` or legacy `segment: ""`
let segmentsArr = [];
if (Array.isArray(segments)) {
  segmentsArr = segments;
} else if (typeof segment === 'string' && segment.trim()) {
  segmentsArr = [segment.trim()];
}

segmentsArr = [...new Set(segmentsArr.map(s => String(s).trim()).filter(Boolean))];

if (segmentsArr.length === 0) {
  return res.status(400).json({ success: false, error: 'At least one segment is required' });
}

const allowedSegments = new Set(['pro', 'driver']);
for (const s of segmentsArr) {
  if (!allowedSegments.has(s)) {
    return res.status(400).json({ success: false, error: 'Segments must be "pro" and/or "driver"' });
  }
}    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // --- Google Sheets client (scoped correctly) ---
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;

    // --- Prevent duplicates (by email, any segment) ---
   // --- Load sheet once (headers + rows) ---
const existingCheck = await sheets.spreadsheets.values.get({
  spreadsheetId: GOOGLE_SHEETS_ID,
  range: 'Subscribers!A:Z',
});
const existingRows = existingCheck.data.values || [];
const headers = (existingRows[0] || []).map(h => (h || '').toString().trim());

const colIndex = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

// Identify whether this email already exists
let existingRowIndex = -1; // index into existingRows (0 = header row)
for (let i = 1; i < existingRows.length; i++) {
  if (((existingRows[i][colIndex('Email')] || existingRows[i][1] || '')).toString().toLowerCase() === email.toLowerCase()) {
    existingRowIndex = i;
    break;
  }
}

// If exists -> either (a) add segment immediately, or (b) reactivate immediately if previously confirmed.
if (existingRowIndex !== -1) {
  const idxStatus = colIndex('Status');
  const idxSegment = colIndex('Segment');
  const idxUpdated = colIndex('Updated_At');
  const idxConfirmedAt = colIndex('Confirmed_At');
  const idxUnsubAt = colIndex('Unsubscribed_At');

  const existingStatus =
    idxStatus !== -1
      ? (existingRows[existingRowIndex][idxStatus] || '').toString().trim().toLowerCase()
      : '';

  const confirmedAt =
    idxConfirmedAt !== -1
      ? (existingRows[existingRowIndex][idxConfirmedAt] || '').toString().trim()
      : '';

  const now = new Date().toISOString();

  // Parse existing segments
  const rawExisting = idxSegment !== -1 ? (existingRows[existingRowIndex][idxSegment] || '').toString() : '';
  const existingSegs = rawExisting
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // Merge requested segments with existing, canonical order: pro,driver
  const mergedSet = new Set([...existingSegs, ...segmentsArr.map(s => String(s).trim().toLowerCase())]);
  const canonical = ['pro', 'driver'];
  const mergedCsv = canonical.filter(s => mergedSet.has(s)).join(',');

  // Case A: Existing subscriber is not unsubscribed -> "add segment" path (no reconfirm)
  if (existingStatus !== 'unsubscribed') {
    const existingCanonicalCsv = canonical.filter(s => existingSegs.includes(s)).join(',');

    if (mergedCsv === existingCanonicalCsv) {
      return res.json({
        success: true,
        message: 'Subscriber already subscribed to selected list(s)',
        data: { email, segments: mergedCsv, status: existingStatus }
      });
    }

    if (idxSegment !== -1) existingRows[existingRowIndex][idxSegment] = mergedCsv;
    if (idxUpdated !== -1) existingRows[existingRowIndex][idxUpdated] = now;

    const sheetRowNumber = existingRowIndex + 1; // sheets are 1-indexed
    const lastColLetter = String.fromCharCode(65 + headers.length - 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `Subscribers!A${sheetRowNumber}:${lastColLetter}${sheetRowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [existingRows[existingRowIndex]] }
    });

    return res.json({
      success: true,
      message: 'Subscription updated successfully',
      data: { email, segments: mergedCsv, status: existingStatus }
    });
  }

  // Case B: Existing subscriber IS unsubscribed
  // If they have previously confirmed, reactivate immediately (no pending, no email).
  if (existingStatus === 'unsubscribed' && confirmedAt) {
    if (idxSegment !== -1) existingRows[existingRowIndex][idxSegment] = mergedCsv || rawExisting;
    if (idxStatus !== -1) existingRows[existingRowIndex][idxStatus] = 'active';
    if (idxUnsubAt !== -1) existingRows[existingRowIndex][idxUnsubAt] = '';
    if (idxUpdated !== -1) existingRows[existingRowIndex][idxUpdated] = now;

    const sheetRowNumber = existingRowIndex + 1; // sheets are 1-indexed
    const lastColLetter = String.fromCharCode(65 + headers.length - 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `Subscribers!A${sheetRowNumber}:${lastColLetter}${sheetRowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [existingRows[existingRowIndex]] }
    });

    return res.json({
      success: true,
      message: 'Subscription reactivated successfully',
      data: { email, segments: (existingRows[existingRowIndex][idxSegment] || '').toString(), status: 'active' }
    });
  }

  // Else: unsubscribed but never confirmed -> fall through to pending + confirmation email path below.
}


// NOTE: do not redefine colIndex again below (avoid duplicate const)

    // Helper: create an output row sized to header length
// If re-subscribing, start from existing row values to preserve any columns you don't explicitly set.
const outRow = new Array(headers.length).fill('');

if (existingRowIndex !== -1) {
  const existing = existingRows[existingRowIndex] || [];
  for (let i = 0; i < outRow.length; i++) outRow[i] = existing[i] ?? '';
}

    const set = (headerName, value) => {
      const i = colIndex(headerName);
      if (i !== -1) outRow[i] = value ?? '';
    };

    // --- Create pending subscriber + tokens ---
    const subscriberId = `SUB-${Date.now()}`;
    const now = new Date().toISOString();

    const confirmToken = makeToken(16);
    const unsubToken = makeToken(16);

    set('Subscriber_ID', subscriberId);
    set('Email', email);
    set('Name', name || '');
const segmentsCsv = segmentsArr.join(',');
set('Segment', segmentsCsv);    set('Status', 'pending');
    set('Source_IP', req.ip || '');
    set('Subscribed_At', now);
    set('Confirm_Token', confirmToken);
    set('Unsub_Token', unsubToken);
    set('Company', company || '');
    set('Role', role || '');
    set('Notes', '');
    set('Updated_At', now);
    set('Confirmed_At', '');
    set('Unsubscribed_At', '');
    set('Email_Frequency', 'weekly');
    set('Paused_At', '');
    set('Resume_At', '');


  if (existingRowIndex === -1) {
  // New subscriber -> append
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: 'Subscribers!A:Z',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [outRow] }
  });
} else {
  // Re-subscribe -> update existing row in place
  const sheetRowNumber = existingRowIndex + 1; // sheets are 1-indexed
  const lastColLetter = String.fromCharCode(65 + headers.length - 1);

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `Subscribers!A${sheetRowNumber}:${lastColLetter}${sheetRowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [outRow] }
  });
}


    // --- Email confirm + unsubscribe links ---
       // IMPORTANT: confirmation/unsubscribe links must hit the API host (Railway), not Cloudflare Pages
    const apiBaseUrl =
      (process.env.PUBLIC_API_BASE_URL || '').trim() ||
      (process.env.PUBLIC_BASE_URL || '').trim() ||
      'https://sfp-newsletter-automation-production.up.railway.app';

    const confirmUrl = `${apiBaseUrl}/api/confirm?token=${encodeURIComponent(confirmToken)}`;

// NEW: segment-aware unsubscribe URLs (backwards compatible on the backend)
const unsubUrlAll = `${apiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}&segment=all`;
const unsubUrlPro = `${apiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}&segment=pro`;
const unsubUrlDriver = `${apiBaseUrl}/api/unsubscribe?token=${encodeURIComponent(unsubToken)}&segment=driver`;


    const safeName = (name || '').trim() || 'there';

const hasPro = segmentsArr.includes('pro');
const hasDriver = segmentsArr.includes('driver');

const subject =
  hasPro && hasDriver
    ? 'Confirm your Safe Freight Intel subscriptions'
    : hasDriver
      ? 'Confirm your Safe Freight Mate subscription'
      : 'Confirm your CoR Intel Weekly subscription';

const brandName =
  hasPro && hasDriver
    ? 'Safe Freight Intel'
    : hasDriver
      ? 'Safe Freight Mate'
      : 'CoR Intel Weekly';

const selectedEditionsText =
  hasPro && hasDriver
    ? 'CoR Intel Weekly and Safe Freight Mate'
    : hasDriver
      ? 'Safe Freight Mate'
      : 'CoR Intel Weekly';

const webViewUrl =
  `https://www.safefreightprogram.com/subscribe-pending?` +
  `email=${encodeURIComponent(email)}&segments=${encodeURIComponent(segmentsArr.join(','))}`;
// NEW: unsubscribe footer block (edition-aware)
// Note: use the target segment links; show all options only when both were selected.
const unsubscribeHtml =
  hasPro && hasDriver
    ? `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:10px 0 0 0;">
        Unsubscribe options:
      </div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:6px 0 0 0;">
        • CoR Intel Weekly:
        <a href="${unsubUrlPro}" style="color:#1d4ed8;text-decoration:underline;">${unsubUrlPro}</a>
      </div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:6px 0 0 0;">
        • Safe Freight Mate:
        <a href="${unsubUrlDriver}" style="color:#1d4ed8;text-decoration:underline;">${unsubUrlDriver}</a>
      </div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:6px 0 0 0;">
        • Unsubscribe all:
        <a href="${unsubUrlAll}" style="color:#1d4ed8;text-decoration:underline;">${unsubUrlAll}</a>
      </div>
    `
    : hasDriver
      ? `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:10px 0 0 0;">
          Unsubscribe:
          <a href="${unsubUrlDriver}" style="color:#1d4ed8;text-decoration:underline;">${unsubUrlDriver}</a>
        </div>
      `
      : `
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:10px 0 0 0;">
          Unsubscribe:
          <a href="${unsubUrlPro}" style="color:#1d4ed8;text-decoration:underline;">${unsubUrlPro}</a>
        </div>
      `;
const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta http-equiv="x-ua-compatible" content="ie=edge">
    <title>Confirm subscription</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f3f4f6;">
    <!-- Preheader (hidden) -->
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
      Confirm your email address to activate ${brandName}.
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f3f4f6;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <!-- Container -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;border-collapse:collapse;">
            <!-- Website-style header -->
<tr>
  <td style="padding:0 0 12px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#1e40af;border-radius:12px;overflow:hidden;">
      <tr>
        <td align="left" style="padding:14px 16px;">
          <a href="https://www.safefreightprogram.com/" style="text-decoration:none;">
            <img
              src="https://www.safefreightprogram.com/assets/sfp-logo-small.png"
              width="60"
              alt="Safe Freight Program"
              style="display:block;border:0;outline:none;text-decoration:none;height:auto;"
            />
          </a>
        </td>
        <td align="right" style="padding:14px 16px;">
          <a href="${webViewUrl}" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:#ffffff;text-decoration:underline;">
            View online
          </a>
        </td>
      </tr>
    </table>
  </td>
</tr>

            <!-- Card -->
            <tr>
              <td style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                
                  <!-- Body copy -->
                  <tr>
                    <td style="padding:0 0 12px 0;">
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111827;margin:0;">
                        Hi ${safeName},
                      </div>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:0 0 16px 0;">
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111827;margin:0;">
                        You’re one step away from activating <strong>${selectedEditionsText}</strong>.
                        Please confirm your email address to complete signup.
                      </div>
                    </td>
                  </tr>

                  <!-- CTA button (bulletproof with Outlook VML) -->
                  <tr>
                    <td align="left" style="padding:0 0 18px 0;">
                      <!--[if mso]>
                        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                          href="${confirmUrl}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="10%" stroke="f" fillcolor="#1d4ed8">
                          <w:anchorlock/>
                          <center style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;">
                            Confirm subscription
                          </center>
                        </v:roundrect>
                      <![endif]-->
                      <!--[if !mso]><!-- -->
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                          <tr>
                            <td bgcolor="#1d4ed8" style="border-radius:10px;">
                              <a href="${confirmUrl}"
                                 style="display:inline-block;padding:12px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">
                                Confirm subscription
                              </a>
                            </td>
                          </tr>
                        </table>
                      <!--<![endif]-->
                    </td>
                  </tr>

                  <!-- Fallback link -->
                  <tr>
                    <td style="padding:0 0 14px 0;">
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#374151;margin:0;">
                        If the button doesn’t work, copy and paste this link into your browser:
                      </div>
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#111827;word-break:break-all;margin:6px 0 0 0;">
                        <a href="${confirmUrl}" style="color:#1d4ed8;text-decoration:underline;">${confirmUrl}</a>
                      </div>
                    </td>
                  </tr>

                  <!-- Divider -->
                  <tr>
                    <td style="padding:12px 0;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                        <tr>
                          <td style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Footer -->
                  <tr>
                    <td style="padding:0;">
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:0;">
                        If you did not request this subscription, you can ignore this email.
                      </div>
                     ${unsubscribeHtml}
                      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;margin:10px 0 0 0;">
                        Safe Freight Program — compliance-grade freight assurance.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Legal/spacing -->
            <tr>
              <td style="padding:14px 6px 0 6px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:16px;color:#9ca3af;text-align:center;">
                  You are receiving this because an address was entered at safefreightprogram.com.
                </div>
              </td>
            </tr>

          </table>
          <!-- /Container -->
        </td>
      </tr>
    </table>
  </body>
</html>`;

    await sendResendEmail({ to: email, subject, html });

    return res.json({
      success: true,
      message: 'Subscriber created (pending) — confirmation email sent',
      data: { subscriberId, email, name: name || '', segment, status: 'pending' }
    });
  } catch (error) {
    console.error('Error adding subscriber:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to add subscriber' });
  }
});

app.get('/api/confirm', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).send('Missing token');

    // Sheets client
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    // Read all subscriber rows (enough columns to cover your headers)
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Subscribers!A:Z'
    });

    const rows = resp.data.values || [];
    if (rows.length < 2) return res.status(404).send('Token not found');

    const headers = (rows[0] || []).map(h => (h || '').toString().trim());
    const colIndex = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const idxConfirm = colIndex('Confirm_Token');
    const idxStatus = colIndex('Status');
    const idxUpdated = colIndex('Updated_At');
    const idxConfirmedAt = colIndex('Confirmed_At');
    const idxEmail = colIndex('Email');
    const idxSegment = colIndex('Segment');

    if ([idxConfirm, idxStatus, idxUpdated, idxConfirmedAt].some(i => i === -1)) {
      return res.status(500).send('Subscribers sheet headers missing required columns');
    }

    // Find matching row
    const rowIndex = rows.findIndex((r, i) => i >= 1 && (r[idxConfirm] || '') === token);
    if (rowIndex === -1) return res.status(404).send('Token not found');

    const row = rows[rowIndex];
    const now = new Date().toISOString();

    const currentStatus = (row[idxStatus] || '').toString().toLowerCase();

    // Idempotent behaviour:
    // - if already active, just redirect successfully (do NOT error)
    if (currentStatus === 'active') {
      const email0 = idxEmail !== -1 ? (row[idxEmail] || '') : '';
      const segment0 = idxSegment !== -1 ? (row[idxSegment] || '') : '';
      const redirectAlready =
        `https://www.safefreightprogram.com/subscribe-confirmed?` +
        `email=${encodeURIComponent(email0)}&segments=${encodeURIComponent(segment0)}&mode=already`;
      return res.redirect(redirectAlready);
    }

    // Only pending -> active
    if (currentStatus !== 'pending') {
      return res.redirect('https://www.safefreightprogram.com/subscribe-confirmed?mode=already');
    }

    row[idxStatus] = 'active';
    row[idxConfirmedAt] = now;
    row[idxUpdated] = now;

    // IMPORTANT: do NOT clear Confirm_Token (prevents SafeLinks/scan double-hit issues)

    const email = idxEmail !== -1 ? (row[idxEmail] || '') : '';
    const segment = idxSegment !== -1 ? (row[idxSegment] || '') : '';

    const sheetRowNumber = rowIndex + 1; // 1-based
    const lastColLetter = String.fromCharCode(65 + headers.length - 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Subscribers!A${sheetRowNumber}:${lastColLetter}${sheetRowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });

    const redirectUrl =
      `https://www.safefreightprogram.com/subscribe-confirmed?` +
      `email=${encodeURIComponent(email)}&segments=${encodeURIComponent(segment)}`;

    return res.redirect(redirectUrl);
  } catch (e) {
    console.error('Confirm error:', e);
    return res.status(500).send('Confirm failed');
  }
});


app.get('/api/unsubscribe', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).send('Missing token');

    // NEW: edition-aware unsubscribe target (backwards compatible)
    // If absent -> treat as "all" (old emails keep working)
    const requestedSegment = (req.query.segment || 'all').toString().trim().toLowerCase();
    const allowedTargets = new Set(['pro', 'driver', 'all']);
    const target = allowedTargets.has(requestedSegment) ? requestedSegment : 'all';

    // Sheets client
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Subscribers!A:Z'
    });

    const rows = resp.data.values || [];
    if (rows.length < 2) return res.status(404).send('Token not found');

    const headers = (rows[0] || []).map(h => (h || '').toString().trim());
    const colIndex = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const idxUnsub = colIndex('Unsub_Token');
    const idxStatus = colIndex('Status');
    const idxUpdated = colIndex('Updated_At');
    const idxUnsubAt = colIndex('Unsubscribed_At');
    const idxEmail = colIndex('Email');
    const idxSegment = colIndex('Segment');

    if ([idxUnsub, idxStatus, idxUpdated, idxUnsubAt, idxSegment].some(i => i === -1)) {
      return res.status(500).send('Subscribers sheet headers missing required columns');
    }

    const rowIndex = rows.findIndex((r, i) => i >= 1 && (r[idxUnsub] || '') === token);
    if (rowIndex === -1) return res.status(404).send('Token not found');

    const row = rows[rowIndex];
    const now = new Date().toISOString();

    const currentStatus = (row[idxStatus] || '').toString().toLowerCase();

    // Idempotent: if already unsubscribed, redirect successfully (and preserve requested target)
    if (currentStatus === 'unsubscribed') {
      const email0 = idxEmail !== -1 ? (row[idxEmail] || '') : '';
      const segment0 = idxSegment !== -1 ? (row[idxSegment] || '') : '';
      const redirectAlready =
        `https://www.safefreightprogram.com/unsubscribe-confirmed?` +
        `email=${encodeURIComponent(email0)}&segments=${encodeURIComponent(segment0)}&segment=${encodeURIComponent(target)}&already=1`;
      return res.redirect(redirectAlready);
    }

    // Parse current segments from CSV (e.g. "pro,driver")
    const rawSegments = (row[idxSegment] || '').toString();
    const segments = rawSegments
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    let nextSegments = segments;

    if (target === 'all') {
      nextSegments = [];
    } else {
      nextSegments = segments.filter(s => s !== target);
    }

    // Canonicalise order for consistency: pro,driver
    const canonical = ['pro', 'driver'];
    const nextSegmentsCsv = canonical.filter(s => nextSegments.includes(s)).join(',');

    // Update row fields
    row[idxSegment] = nextSegmentsCsv;
    row[idxUpdated] = now;

    if (nextSegments.length === 0) {
      row[idxStatus] = 'unsubscribed';
      row[idxUnsubAt] = now;
    } else {
      // Partial unsubscribe: keep active
      row[idxStatus] = 'active';
      // Keep Unsubscribed_At blank so it continues to mean "fully unsubscribed"
      row[idxUnsubAt] = '';
    }

    // IMPORTANT: do NOT clear Unsub_Token (SafeLinks/scan tolerance)

    const email = idxEmail !== -1 ? (row[idxEmail] || '') : '';
    const segmentCsv = row[idxSegment] || '';

    const sheetRowNumber = rowIndex + 1;
    const lastColLetter = String.fromCharCode(65 + headers.length - 1);

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Subscribers!A${sheetRowNumber}:${lastColLetter}${sheetRowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });

    const redirectUrl =
      `https://www.safefreightprogram.com/unsubscribe-confirmed?` +
      `email=${encodeURIComponent(email)}&segments=${encodeURIComponent(segmentCsv)}&segment=${encodeURIComponent(target)}`;

    return res.redirect(redirectUrl);
  } catch (e) {
    console.error('Unsubscribe error:', e);
    return res.status(500).send('Unsubscribe failed');
  }
});

// --- PAUSE NEWSLETTERS ---
// Linked from email footer {{PAUSE_URL}}. Sets Paused_At for 4 weeks, keeps status active.
app.get('/api/pause', async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) return res.status(400).send('Missing token');

    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Subscribers!A:Z' });
    const rows = resp.data.values || [];
    if (rows.length < 2) return res.status(404).send('Token not found');

    const headers = rows[0].map(h => (h || '').toString().trim());
    const col = name => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

    const idxUnsub   = col('Unsub_Token');
    const idxStatus  = col('Status');
    const idxUpdated = col('Updated_At');
    const idxPaused  = col('Paused_At');
    const idxResume  = col('Resume_At');
    const idxEmail   = col('Email');

    const rowIndex = rows.findIndex((r, i) => i >= 1 && (r[idxUnsub] || '') === token);
    if (rowIndex === -1) return res.status(404).send('Token not found');

    const row = [...rows[rowIndex]];
    const now = new Date();
    const resumeAt = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000); // 4 weeks

    row[idxPaused]  = now.toISOString();
    row[idxResume]  = resumeAt.toISOString();
    row[idxUpdated] = now.toISOString();
    // Status stays 'active' — emailSender.js checks Paused_At to skip sends

    const email = row[idxEmail] || '';
    const lastCol = String.fromCharCode(65 + headers.length - 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Subscribers!A${rowIndex + 1}:${lastCol}${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });

    // Write audit record
    await writeSubscriptionAudit(sheets, spreadsheetId, {
      action: 'paused',
      email,
      metadata: JSON.stringify({ resume_at: resumeAt.toISOString(), duration_days: 28 }),
      ip: req.ip || '',
      ua: req.headers['user-agent'] || ''
    });

    const resumeFormatted = resumeAt.toLocaleDateString('en-AU', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney'
    });
    return res.redirect(
      `https://www.safefreightprogram.com/paused?email=${encodeURIComponent(email)}&resume=${encodeURIComponent(resumeFormatted)}`
    );
  } catch (e) {
    console.error('Pause error:', e);
    return res.status(500).send('Pause failed — please email us at hello@safefreightprogram.com.au');
  }
});




app.put('/api/subscribers/:email', async (req, res) => {
  try {
    const targetEmail = req.params.email;
    const { name, segment, company, role, status } = req.body;
    if (status && !['active', 'paused', 'unsubscribed'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be "active", "paused", or "unsubscribed"' });
    }
    if (segment && !['pro', 'driver'].includes(segment)) {
      return res.status(400).json({ success: false, error: 'Segment must be "pro" or "driver"' });
    }
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Subscribers!A:P',
    });
    const rows = response.data.values;
    let targetRowIndex = -1;
    let currentData = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] && rows[i][1].toLowerCase() === targetEmail.toLowerCase()) {
        targetRowIndex = i + 1;
        currentData = rows[i];
        break;
      }
    }
    if (targetRowIndex === -1) {
      return res.status(404).json({ success: false, error: 'Subscriber not found' });
    }
    const updateData = [
      currentData[0] || '',
      targetEmail,
      name || currentData[2] || '',
      segment || currentData[3] || 'pro',
      status || currentData[4] || 'active',
      currentData[5] || '',
      currentData[6] || new Date().toISOString(),
      currentData[7] || '',
      currentData[8] || '',
      company || currentData[9] || '',
      role || currentData[10] || '',
      currentData[11] || '',
      new Date().toISOString(),
      currentData[13] || '', currentData[14] || '', currentData[15] || ''
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: `Subscribers!A${targetRowIndex}:P${targetRowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updateData] }
    });
    res.json({
      success: true,
      message: 'Subscriber updated successfully',
      data: {
        email: targetEmail,
        name: updateData[2],
        segment: updateData[3],
        status: updateData[4],
        company: updateData[9],
        role: updateData[10],
        updatedAt: updateData[12]
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/subscribers/:email', async (req, res) => {
  try {
    const targetEmail = decodeURIComponent(req.params.email);
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId, range: 'Subscribers!A:Z'
    });
    const rows = response.data.values || [];
    const headers = rows[0] || [];

    let targetRowIndex = -1;
    let subscriberData = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] && rows[i][1].toLowerCase() === targetEmail.toLowerCase()) {
        targetRowIndex = i;
        subscriberData = rows[i];
        break;
      }
    }
    if (targetRowIndex === -1) {
      return res.status(404).json({ success: false, error: 'Subscriber not found' });
    }

    // Get the Subscribers sheet's actual sheetId (not always 0)
    const metaResp = await sheets.spreadsheets.get({ spreadsheetId });
    const subSheet = metaResp.data.sheets.find(s => s.properties.title === 'Subscribers');
    const sheetId = subSheet ? subSheet.properties.sheetId : 0;

    // Snapshot subscriber before deletion for audit record
    const snapshot = {};
    headers.forEach((h, i) => { snapshot[h] = subscriberData[i] || ''; });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: targetRowIndex,
              endIndex: targetRowIndex + 1
            }
          }
        }]
      }
    });

    // Write audit record with full subscriber snapshot
    await writeSubscriptionAudit(sheets, spreadsheetId, {
      action: 'deleted',
      email: targetEmail,
      metadata: JSON.stringify({
        deleted_by: 'admin_dashboard',
        subscriber_id: snapshot['Subscriber_ID'] || '',
        name: snapshot['Name'] || '',
        segment: snapshot['Segment'] || '',
        company: snapshot['Company'] || '',
        subscribed_at: snapshot['Subscribed_At'] || '',
        confirmed_at: snapshot['Confirmed_At'] || ''
      }),
      ip: req.ip || '',
      ua: req.headers['user-agent'] || ''
    });

    res.json({
      success: true,
      message: 'Subscriber deleted and audit record written',
      data: { email: targetEmail }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- COMPATIBILITY ALIASES FOR FRONTEND ---

// Alias: POST /api/newsletter/test  -> use cached preview if available, otherwise generate fresh
app.post('/api/newsletter/test', async (req, res) => {
  try {
    const { segment = 'pro', email } = req.body || {};
    if (!email) return res.status(400).json({ success:false, error:'Missing email' });

    const EmailSender = require('./emailSender');
    const emailSender = new EmailSender();

    // Find most recently cached newsletter for this segment
    // Iterate in reverse insertion order so the latest preview is used
    let newsletter = null;
    let newsletterId = null;
    const cacheEntries = [...newsletterCache.entries()].reverse();
    for (const [id, cached] of cacheEntries) {
      if (cached.segment === segment) {
        newsletter = cached.newsletter;
        newsletterId = id;
        console.log(`📋 Send Test: matched cache entry ${id} for segment "${segment}"`);
        break;
      }
    }
    if (!newsletter) {
      console.log(`📋 Send Test: no cached entry found for segment "${segment}". Available: ${[...newsletterCache.entries()].map(([id,c]) => `${id}(${c.segment})`).join(', ')}`);
      // No cache — generate fresh but do NOT mark articles as used
      console.log(`📋 Send Test: generating fresh for ${segment} (articles will NOT be marked used)`);
      const NewsletterGenerator = require('./generator');
      const newsletterGenerator = new NewsletterGenerator();
      newsletter = await newsletterGenerator.generateNewsletter(segment, false);
    }

    const subscribers = await emailSender.getSubscribersFromSheet(segment);
    const matched = subscribers.find(s => s.email.toLowerCase() === email.toLowerCase());
    const testSubscriber = matched || { email, name: 'Test User', segment, unsubToken: 'test-token' };

    await emailSender.sendSingleEmail(newsletter, testSubscriber);
    return res.json({ success:true, message:'Test email sent', data:{ segment, email, subject: newsletter.subject, source: newsletterId ? 'cached-preview' : 'fresh-generate' }});
  } catch (e) {
    return res.status(500).json({ success:false, error:e.message });
  }
});

// GET /api/subscribers/csv — download subscribers as CSV
app.get('/api/subscribers/csv', async (req, res) => {
  try {
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Subscribers!A:Z'
    });

    const rows = response.data.values || [];
    if (rows.length === 0) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
      return res.send('');
    }

    const headers = rows[0];
    const seg = (req.query.segment || '').toLowerCase();

    // Optional segment filter
    const segIdx = headers.findIndex(h => h.toLowerCase() === 'segment');
    const statusIdx = headers.findIndex(h => h.toLowerCase() === 'status');

    const dataRows = rows.slice(1).filter(row => {
      if (seg && segIdx !== -1) {
        const rowSeg = (row[segIdx] || '').toLowerCase();
        if (!rowSeg.includes(seg)) return false;
      }
      return true; // include all statuses in export
    });

    // Build CSV with proper quoting
    const csvEscape = val => '"' + (val || '').toString().replace(/"/g, '""') + '"';
    const csvLines = [
      headers.map(csvEscape).join(','),
      ...dataRows.map(row => {
        // Pad row to header length
        const padded = headers.map((_, i) => row[i] || '');
        return padded.map(csvEscape).join(',');
      })
    ];

    const filename = seg ? `subscribers-${seg}.csv` : 'subscribers.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('\uFEFF' + csvLines.join('\n')); // BOM for Excel compatibility
  } catch (e) {
    console.error('CSV export error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Singular subscriber routes expected by the frontend:
// GET /api/subscriber/:id  (id is email for now)
// PUT /api/subscriber/:id
// DELETE /api/subscriber/:id
app.get('/api/subscriber/:id', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.id);
    const SheetsManager = require('./config/sheets');
    const sheetsManager = new SheetsManager();
    await sheetsManager.initialize();
    const s = await sheetsManager.getSubscriberByEmail(email);
    if (!s) return res.status(404).json({ success:false, error:'Not found' });
    return res.json({ success:true, subscriber: s });
  } catch (e) {
    return res.status(500).json({ success:false, error:e.message });
  }
});

app.put('/api/subscriber/:id', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.id);
    const payload = req.body || {};
    const SheetsManager = require('./config/sheets');
    const sheetsManager = new SheetsManager();
    await sheetsManager.initialize();
    const updated = await sheetsManager.updateSubscriberByEmail(email, payload);
    return res.json({ success:true, subscriber: updated });
  } catch (e) {
    return res.status(500).json({ success:false, error:e.message });
  }
});

app.delete('/api/subscriber/:id', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.id);
    // Route through the audited delete handler above
    // Build a synthetic request and call the same logic
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Subscribers!A:Z' });
    const rows = response.data.values || [];
    const headers = rows[0] || [];

    let targetRowIndex = -1;
    let subscriberData = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] && rows[i][1].toLowerCase() === email.toLowerCase()) {
        targetRowIndex = i;
        subscriberData = rows[i];
        break;
      }
    }
    if (targetRowIndex === -1) return res.status(404).json({ success: false, error: 'Not found' });

    const metaResp = await sheets.spreadsheets.get({ spreadsheetId });
    const subSheet = metaResp.data.sheets.find(s => s.properties.title === 'Subscribers');
    const sheetId = subSheet ? subSheet.properties.sheetId : 0;

    const snapshot = {};
    headers.forEach((h, i) => { snapshot[h] = subscriberData[i] || ''; });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: targetRowIndex, endIndex: targetRowIndex + 1 } } }] }
    });

    await writeSubscriptionAudit(sheets, spreadsheetId, {
      action: 'deleted',
      email,
      metadata: JSON.stringify({ deleted_by: 'admin_dashboard', subscriber_id: snapshot['Subscriber_ID'] || '', name: snapshot['Name'] || '', segment: snapshot['Segment'] || '' }),
      ip: req.ip || '',
      ua: req.headers['user-agent'] || ''
    });

    return res.json({ success: true, data: { email } });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});


// --- ARTICLES MANAGEMENT ---
app.get('/api/articles', async (req, res) => {
  try {
    const { limit = 50, unused_only = false } = req.query;
    
    const { google } = require('googleapis');
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Article_Archive!A:P',
    });
    
    const rows = response.data.values || [];
    const headers = rows[0] || [];
    
    let articles = rows.slice(1, parseInt(limit) + 1).map(row => {
      const article = {};
      headers.forEach((header, index) => {
        article[header.toLowerCase().replace(/\s+/g, '_')] = row[index] || '';
      });
      return article;
    });
    
    // Filter for unused articles if requested
    if (unused_only === 'true') {
      articles = articles.filter(article => 
        !article.used_in_issue || article.used_in_issue === ''
      );
    }
    
    res.json({
      success: true,
      data: articles,
      count: articles.length,
      total_unused: articles.filter(a => !a.used_in_issue || a.used_in_issue === '').length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --- TEST EMAIL ---
app.post('/api/test-email', async (req, res) => {
  try {
    const { email, type = 'simple', segment = 'pro' } = req.body;
    const testRecipient = email || process.env.NEWSLETTER_RECIPIENTS?.split(',')[0];
    
    if (!testRecipient) {
      return res.status(400).json({
        success: false,
        error: 'No test recipient provided'
      });
    }

    const testData = {
      html: `<html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #1e40af;">SFP Newsletter System Test</h2>
        <p>This is a test email from the Safe Freight Program newsletter automation system.</p>
        <p><strong>Test Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</p>
        <p><strong>System Status:</strong> Email sending functionality is working correctly</p>
        </body></html>`,
      text: 'SFP Newsletter System Test - Email sending working correctly',
      subject: 'SFP Newsletter System Test'
    };
    
    const testSubscriber = { 
      email: testRecipient, 
      name: 'Test User',
      segment: 'test'
    };
    
    await emailSender.sendSingleEmail(testData, testSubscriber);
    
    res.json({
      success: true,
      message: 'Test email sent successfully',
      data: {
        recipient: testRecipient,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// --- ANALYTICS ENDPOINTS ---

// GET /api/analytics/summary — subscriber counts + recent issue performance
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const subscriberData = await emailSender.testEmailSystem();
    const { google } = require('googleapis');
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Pull recent issues from Issues_Analytics
    const analyticsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Issues_Analytics!A:I'
    });
    const analyticsRows = (analyticsResp.data.values || []).slice(1, 11);

    const issues = analyticsRows.map(r => ({
      issue_id: r[0], segment: r[1], subject: r[2],
      sent: r[4], open_rate: r[6], clicks: r[7]
    }));
    const totalSent = issues.reduce((s, i) => s + (parseInt(i.sent) || 0), 0);

    res.json({
      success: true,
      data: {
        subscribers: {
          total: subscriberData.totalSubscribers || 0,
          pro: subscriberData.proSubscribers || 0,
          driver: subscriberData.driverSubscribers || 0
        },
        recent_issues: issues,
        // Legacy fields expected by dashboard loadRealAnalytics()
        emailsSent7d: totalSent,
        successRate: 100,
        articlesScraped: issues.length,
        systemUptime: 99.9,
        system: { status: 'operational', email_configured: !!process.env.RESEND_API_KEY }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/analytics/engagement — pull Resend events and build engagement report
// Call this from the dashboard Analytics tab to refresh engagement data
app.post('/api/analytics/engagement', async (req, res) => {
  try {
    const days = parseInt(req.query.days || req.body?.days || 30);
    console.log(`📊 Building engagement summary for last ${days} days...`);
    const summary = await buildEngagementSummary(days);
    res.json({ success: true, data: summary, computed_at: new Date().toISOString() });
  } catch (error) {
    console.error('Analytics engagement error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/analytics/engagement — return last computed engagement data from Issues_Analytics
app.get('/api/analytics/engagement', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const [analyticsResp, engTrackResp] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'Issues_Analytics!A:I'
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: 'Engagement_Tracking!A:H'
      })
    ]);

    const issues = (analyticsResp.data.values || []).slice(1).map(r => ({
      issue_id: r[0], segment: r[1], subject: r[2], published: r[3],
      sent: r[4], open_rate: r[6], clicks: r[7]
    }));

    // Aggregate clicks by category and source from Engagement_Tracking
    const byCategory = {};
    const bySource = {};
    const engRows = (engTrackResp.data.values || []).slice(1)
      .filter(r => r[2] === 'click');
    for (const row of engRows) {
      const cat = row[6] || 'Unknown';
      const title = row[7] || '';
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        issues,
        by_category: byCategory,
        total_click_events: engRows.length,
        note: engRows.length === 0
          ? 'No engagement data yet — POST to /api/analytics/engagement to pull from Resend'
          : null
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- STATUS ENDPOINTS ---
app.get('/api/status', async (req, res) => {
  try {
    const emailStatus = await emailSender.verifyConnection();
    const subscriberTest = await emailSender.testEmailSystem();
    res.json({
      status: 'running',
      version: '2.0.0',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'production',
      lastRestart: new Date().toISOString(),
      services: {
        email: {
          configured: !!process.env.EMAIL_USER || !!process.env.RESEND_API_KEY,
          connected: emailStatus,
          subscribers: subscriberTest.totalSubscribers || 0
        },
        sheets: {
          configured: !!process.env.GOOGLE_SHEETS_ID,
          connected: subscriberTest.smtpWorking
        },
        openai: {
          configured: !!process.env.OPENAI_API_KEY
        }
      },
      currentTime: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message, timestamp: new Date().toISOString() });
  }
});

app.get('/api/email-status', async (req, res) => {
  try {
    const connectionVerified = await emailSender.verifyConnection();
    res.json({
      success: true,
      configuration: {
        emailConfigured: !!process.env.EMAIL_USER || !!process.env.RESEND_API_KEY,
        recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS,
        connectionVerified,
        smtpHost: process.env.EMAIL_HOST || 'smtp.gmail.com',
        smtpPort: process.env.EMAIL_PORT || 587,
        fromAddress: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'Not configured',
        environment: process.env.NODE_ENV || 'production'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      configuration: { emailConfigured: !!process.env.EMAIL_USER, recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS, connectionVerified: false },
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// --- SYSTEM CONFIGURATION ---
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: {
      scheduling: scheduler.getConfiguration(),
      email: {
        configured: !!process.env.RESEND_API_KEY || !!process.env.EMAIL_USER,
        provider: process.env.RESEND_API_KEY ? 'resend' : 'gmail',
        from_address: process.env.EMAIL_FROM || 'newsletter@safefreightprogram.com'
      },
      sheets: {
        configured: !!process.env.GOOGLE_SHEETS_ID,
        spreadsheet_id: process.env.GOOGLE_SHEETS_ID ? '✓ Connected' : '✗ Not configured'
      },
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        model: 'gpt-4o-mini'
      }
    }
  });
});

// --- DEBUG ENDPOINTS ---
app.get('/api/debug', (req, res) => {
  const debug = {
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV,
    isProduction: process.env.NODE_ENV === 'production',
    environment: {
      hasOpenAI: !!process.env.OPENAI_API_KEY,
      hasGoogleEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
      hasGoogleKey: !!process.env.GOOGLE_PRIVATE_KEY,
      hasResendKey: !!process.env.RESEND_API_KEY,
      hasSheetsId: !!process.env.GOOGLE_SHEETS_ID
    },
    memory: process.memoryUsage(),
    modules: {}
  };
  try {
    const scraper = require('./scraper');
    debug.modules.scraper = { available: true, exports: Object.keys(scraper) };
  } catch (error) {
    debug.modules.scraper = { available: false, error: error.message };
  }
  res.json(debug);
});

// --- SYSTEM TEST ENDPOINTS ---
app.get('/api/test/connection', async (req, res) => {
  const tests = {};
  
  try {
    // Test Google Sheets connection
    tests.sheets = {
      configured: !!process.env.GOOGLE_SHEETS_ID,
      spreadsheet_id: process.env.GOOGLE_SHEETS_ID || null
    };
    
    if (process.env.GOOGLE_CLIENT_EMAIL) {
      try {
        const { google } = require('googleapis');
        const auth = await google.auth.getClient({
          credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
          },
          scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
        });
        
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: 'Subscribers!A1:A1',
        });
        
        tests.sheets.connected = true;
        tests.sheets.test_result = 'Successfully accessed spreadsheet';
      } catch (error) {
        tests.sheets.connected = false;
        tests.sheets.error = error.message;
      }
    }
    
    // Test email system
    try {
      const emailTest = await emailSender.testEmailSystem();
      tests.email = emailTest;
    } catch (error) {
      tests.email = { error: error.message };
    }
    
    // Test OpenAI
    tests.openai = {
      configured: !!process.env.OPENAI_API_KEY,
      api_key_present: process.env.OPENAI_API_KEY ? true : false
    };
    
    res.json({
      success: true,
      tests: tests,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      tests: tests
    });
  }
});

app.post('/api/test/newsletter', async (req, res) => {
  try {
    const { segment = 'pro' } = req.body;
    
    console.log(`🧪 Testing newsletter generation for ${segment} segment...`);
    
    const newsletterGenerator = new NewsletterGenerator();
    const newsletter = await newsletterGenerator.generateNewsletter(segment, false); // false = don't send
    
    res.json({
      success: true,
      message: 'Newsletter generated successfully (not sent)',
      data: {
        segment: segment,
        subject: newsletter.subject,
        articles_count: newsletter.articles?.length || 0,
        html_length: newsletter.html?.length || 0,
        filename: newsletter.filename || null
      }
    });
  } catch (error) {
    console.error('Newsletter test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/test/scrape', async (req, res) => {
  try {
    console.log('🧪 Testing scraping system...');
    
    const startTime = Date.now();
    const results = await scrapeAllSources();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    res.json({
      success: true,
      message: 'Scraping test completed',
      data: {
        articles_found: results.articles?.length || 0,
        duration: `${duration} seconds`,
        errors: results.errors?.length || 0,
        sample_titles: results.articles?.slice(0, 3).map(a => a.title) || []
      }
    });
  } catch (error) {
    console.error('Scraping test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/test/env', (req, res) => {
  const env_check = {
    NODE_ENV: process.env.NODE_ENV || 'not set',
    GOOGLE_SHEETS_ID: process.env.GOOGLE_SHEETS_ID ? '✓ Set' : '✗ Missing',
    GOOGLE_CLIENT_EMAIL: process.env.GOOGLE_CLIENT_EMAIL ? '✓ Set' : '✗ Missing',
    GOOGLE_PRIVATE_KEY: process.env.GOOGLE_PRIVATE_KEY ? '✓ Set' : '✗ Missing',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '✓ Set' : '✗ Missing',
    RESEND_API_KEY: process.env.RESEND_API_KEY ? '✓ Set (Resend)' : '✗ Missing',
    EMAIL_USER: process.env.EMAIL_USER ? '✓ Set (Gmail)' : '✗ Missing',
    NEWSLETTER_RECIPIENTS: process.env.NEWSLETTER_RECIPIENTS ? '✓ Set' : '✗ Missing',
    timestamp: new Date().toISOString()
  };
  
  res.json({
    success: true,
    environment: env_check
  });
});

// --- ADVANCED SCHEDULER (AUTOMATION) ---
let scheduler;
if (process.env.NODE_ENV === 'production') {
  scheduler = new AdvancedScheduler();

  // Register callback so scheduled runs update systemState + Events_Log
  scheduler.onJobComplete = async (jobType) => {
    const now = new Date().toISOString();
    if (jobType === 'scraping') {
      systemState.lastScrape = { timestamp: now, trigger: 'scheduled' };
      await logSystemEvent('scrape_completed', { trigger: 'scheduled' });
    } else if (jobType === 'newsletter') {
      // Newsletter sends both pro and driver; mark both segments
      systemState.lastSent['pro']    = { timestamp: now, trigger: 'scheduled', subject: 'CoR Intel Weekly' };
      systemState.lastSent['driver'] = { timestamp: now, trigger: 'scheduled', subject: 'Safe Freight Mate' };
      await logSystemEvent('newsletter_sent', { segment: 'pro,driver', trigger: 'scheduled' });
    }
  };

  scheduler.initialize();
  setupAdvancedSchedulingEndpoints(app, scheduler);
} else {
  scheduler = {
    getConfiguration: () => ({
      schedules: {
        scraping: { enabled: false, frequency: 'weekly', dayOfWeek: 1, hour: 16, minute: 45 },
        newsletter: { enabled: false, frequency: 'weekly', dayOfWeek: 1, hour: 17, minute: 30 }
      },
      nextRuns: { scraping: 'Dev mode - disabled', newsletter: 'Dev mode - disabled' },
      activeJobs: [],
      dependencies: {}
    }),
    updateSchedule: () => { throw new Error('Scheduling not available in development mode'); },
    triggerJob: async (jobType) => {
      console.log(`🔧 Dev mode manual trigger: ${jobType}`);
    }
  };
  setupAdvancedSchedulingEndpoints(app, scheduler);
}
// --- DEBUG ENDPOINT ---
app.get('/api/debug/openai', async (req, res) => {
  console.log('🧪 Testing OpenAI API directly...');
  
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    console.log('📝 API Key present:', !!process.env.OPENAI_API_KEY);
    console.log('📝 API Key format:', process.env.OPENAI_API_KEY?.substring(0, 7) + '...');
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Reply with just "API WORKING"' }],
      max_tokens: 10
    });
    
    console.log('✅ OpenAI Response:', response.choices[0].message.content);
    
    res.json({
      success: true,
      message: 'OpenAI API is working',
      response: response.choices[0].message.content,
      apiKeyPresent: !!process.env.OPENAI_API_KEY
    });
    
  } catch (error) {
    console.error('❌ OpenAI Test Error:', error.message);
    console.error('❌ Error Type:', error.constructor.name);
    
    res.json({
      success: false,
      error: error.message,
      errorType: error.constructor.name,
      apiKeyPresent: !!process.env.OPENAI_API_KEY,
      httpStatus: error.response?.status,
      httpData: error.response?.data
    });
  }
});

// --- 404 HANDLER ---
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found', 
    timestamp: new Date().toISOString(),
    available_endpoints: [
      'GET /',
      'GET /health', 
      'GET /admin',
      'GET /api/version',
      'POST /api/scrape',
      'GET /api/status'
    ]
  });
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// --- STARTUP ---
app.listen(PORT, () => {
  console.log(`✅ SFP Newsletter Automation running on port ${PORT}`);
  console.log(`🌐 Admin Dashboard: http://localhost:${PORT}/admin`);
  console.log(`📊 API Status: http://localhost:${PORT}/api/status`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'production'}`);
  // Restore last scrape/send times from Events_Log for dashboard display
  restoreSystemState().catch(e => console.warn('State restore error:', e.message));
});
