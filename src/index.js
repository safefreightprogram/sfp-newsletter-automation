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
app.use(express.static('public'));

// --- GLOBALS ---
const emailSender = new EmailSender();
let newsletterCache = new Map();

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
    endpoints: [
      'GET /health',
      'POST /api/scrape',
      'POST /api/newsletter/generate/:segment',
      'POST /api/newsletter/send/:newsletterId',
      'GET /api/subscribers',
      'POST /api/subscribers',
      'PUT /api/subscribers/:email',
      'DELETE /api/subscribers/:email',
      'GET /api/status',
      'GET /api/email-status',
      'GET /api/schedule/advanced',
      'PUT /api/schedule/:jobType',
      'POST /api/schedule/trigger/:jobType'
    ]
  });
});

// --- SCRAPING (Manual) ---
app.post('/api/scrape', async (req, res) => {
  try {
    const startTime = Date.now();
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
      } catch (sheetsError) {
        console.error('⚠️ Failed to save to sheets:', sheetsError.message);
      }
    }
    res.json({
      success: true,
      message: 'Scraping completed successfully',
      results: {
        articlesFound: articles.length,
        savedToSheets: savedCount,
        duration: `${((Date.now() - startTime) / 1000).toFixed(1)} seconds`,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
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

// --- STATUS, EMAIL STATUS, DEBUG ---
app.get('/api/status', async (req, res) => {
  try {
    const emailStatus = await emailSender.verifyConnection();
    const subscriberTest = await emailSender.testEmailSystem();
    res.json({
      status: 'running',
      version: '2.0.0',
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
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
        environment: process.env.NODE_ENV || 'development'
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

// --- 404 HANDLER ---
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', timestamp: new Date().toISOString() });
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
  console.log(`SFP Newsletter Automation running on port ${PORT}`);
});
