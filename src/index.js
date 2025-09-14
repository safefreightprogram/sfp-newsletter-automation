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

const app = express();
const PORT = process.env.PORT || 3000;

const cors = require('cors');

// List of allowed domains (your production site + dev machines)
const ALLOWED_ORIGINS = [
  'https://www.safefreightprogram.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

app.use(cors({
  origin(origin, cb) {
    // allow requests with no origin (like curl, Postman) or from allowed list
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Handle preflight OPTIONS requests
app.options('*', cors());

const express = require('express');
const app = express();


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
const emailSender = new EmailSender();
let newsletterCache = new Map();

const express = require('express');
const app = express(); // your existing line

// NEW CORS CONFIG
const cors = require('cors');

const ALLOWED_ORIGINS = [
  'https://www.safefreightprogram.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('CORS: Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Handle preflight requests
app.options('*', cors());


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
    
    res.json({
      success: true,
      message: 'Scraping completed successfully',
      data: {
        articlesFound: articles.length,
        savedToSheets: savedCount,
        duration: `${duration} seconds`,
        timestamp: new Date().toISOString(),
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
      const testSubscriber = { email: testEmail, name: 'Test User', segment };
      await emailSender.sendSingleEmail(newsletter, testSubscriber);
      return res.json({ success: true, message: 'Test email sent successfully', data: { newsletterId, testEmail, segment } });
    }
    if (confirmSend) {
      const subscribers = await emailSender.getSubscribersFromSheet(segment);
      await emailSender.sendBulkEmails(newsletter, subscribers);
      await markArticlesAsUsed(articles, segment, newsletterId);
      newsletterCache.delete(newsletterId);
      return res.json({ success: true, message: 'Newsletter sent and articles marked as used', data: { newsletterId, segment, recipients: subscribers.length } });
    }
    return res.status(400).json({ success: false, error: 'Must specify either testEmail or confirmSend=true' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- MARK ARTICLES AS USED ---
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
      const testSubscriber = { 
        email: testEmail, 
        name: 'Test User',
        segment: segment
      };
      
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
      return res.json({
        success: true,
        data: {
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
    const { email, name, segment, company, role, status = 'active' } = req.body;
    if (!email || !segment) {
      return res.status(400).json({ success: false, error: 'Email and segment are required' });
    }
    if (!['pro', 'driver'].includes(segment)) {
      return res.status(400).json({ success: false, error: 'Segment must be "pro" or "driver"' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }
    const auth = await google.auth.getClient({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const existingCheck = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Subscribers!A:P',
    });
    const existingRows = existingCheck.data.values || [];
    for (let i = 1; i < existingRows.length; i++) {
      if (existingRows[i][1] && existingRows[i][1].toLowerCase() === email.toLowerCase()) {
        return res.status(409).json({ success: false, error: 'Subscriber already exists' });
      }
    }
    const subscriberId = `SUB-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const newSubscriberData = [
      subscriberId, email, name || '', segment, status, '',
      timestamp, '', '', company || '', role || '', '', timestamp, '', '', 'weekly'
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: 'Subscribers!A:P',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [newSubscriberData] }
    });
    res.json({
      success: true,
      message: 'Subscriber added successfully',
      data: { subscriberId, email, name: name || '', segment, status, subscribedAt: timestamp }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
    const targetEmail = req.params.email;
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
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] && rows[i][1].toLowerCase() === targetEmail.toLowerCase()) {
        targetRowIndex = i;
        break;
      }
    }
    if (targetRowIndex === -1) {
      return res.status(404).json({ success: false, error: 'Subscriber not found' });
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: 0,
              dimension: 'ROWS',
              startIndex: targetRowIndex,
              endIndex: targetRowIndex + 1
            }
          }
        }]
      }
    });
    res.json({
      success: true,
      message: 'Subscriber deleted successfully',
      data: { email: targetEmail }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- COMPATIBILITY ALIASES FOR FRONTEND ---

// Alias: POST /api/newsletter/test  -> existing send flow as 'test'
app.post('/api/newsletter/test', async (req, res) => {
  try {
    const { segment = 'pro', email } = req.body || {};
    if (!email) return res.status(400).json({ success:false, error:'Missing email' });

    // Reuse existing "generate-and-send" test path
    const NewsletterGenerator = require('./generator');
    const EmailSender = require('./emailSender');
    const newsletterGenerator = new NewsletterGenerator();
    const emailSender = new EmailSender();

    const newsletter = await newsletterGenerator.generateNewsletter(segment, false);
    await emailSender.sendSingleEmail(newsletter, { email, name: 'Test User', segment });
    return res.json({ success:true, message:'Test email sent', data:{ segment, email, subject: newsletter.subject }});
  } catch (e) {
    return res.status(500).json({ success:false, error:e.message });
  }
});

// New: GET /api/subscribers/csv
app.get('/api/subscribers/csv', async (req, res) => {
  try {
    const SheetsManager = require('./config/sheets');
    const sheetsManager = new SheetsManager();
    await sheetsManager.initialize();

    const seg = req.query.segment || ''; // optional
    const list = await sheetsManager.getSubscribers(seg); // assumes existing helper
    const cols = ['email','name','segment','company','role','status'];
    const header = cols.join(',');
    const rows = list.map(s => cols.map(c => `"${(s[c] ?? '').toString().replace(/"/g,'""')}"`).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
    return res.send([header, ...rows].join('\n'));
  } catch (e) {
    return res.status(500).json({ success:false, error:e.message });
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
    // Reuse existing delete handler semantics
    const SheetsManager = require('./config/sheets');
    const sheetsManager = new SheetsManager();
    await sheetsManager.initialize();
    await sheetsManager.deleteSubscriberByEmail(email);
    return res.json({ success:true });
  } catch (e) {
    return res.status(500).json({ success:false, error:e.message });
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
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const subscriberData = await emailSender.testEmailSystem();
    
    // Get recent newsletters count
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
    
    const newsletterRows = response.data.values || [];
    const recentNewsletters = newsletterRows.slice(1, 11); // Last 10
    
    const summary = {
      subscribers: {
        total: subscriberData.totalSubscribers || 0,
        pro: subscriberData.proSubscribers || 0,
        driver: subscriberData.driverSubscribers || 0
      },
      newsletters: {
        total_sent: recentNewsletters.length,
        last_sent: recentNewsletters.length > 0 ? recentNewsletters[0][3] : null,
        average_open_rate: recentNewsletters.length > 0 ? 
          (recentNewsletters.reduce((sum, row) => sum + (parseFloat(row[6]) || 0), 0) / recentNewsletters.length).toFixed(2) : 0
      },
      system: {
        status: 'operational',
        last_scrape: new Date().toISOString(),
        email_configured: subscriberData.smtpWorking || false
      }
    };
    
    res.json({
      success: true,
      data: summary,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
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
});
