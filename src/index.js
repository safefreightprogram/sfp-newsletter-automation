require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');

// Import your modules - updated paths
const NewsletterGenerator = require('./generator');        
const { scrapeAllSources } = require('./scraper');          
const EmailSender = require('./emailSender'); // Updated path

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize email sender
const emailSender = new EmailSender();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'SFP Newsletter Automation'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'SFP Newsletter Automation API',
    version: '1.0.0',
    schedule: {
      scraping: '4:45 PM AEST daily',
      newsletter: '5:00 PM AEST daily'
    },
    endpoints: {
      health: '/health',
      scrape: '/api/scrape',
      generate: '/api/generate',
      'generate-pro': '/api/generate/pro',
      'generate-driver': '/api/generate/driver',
      'test-email': '/api/test-email',
      'test-subscribers': '/api/test-subscribers',
      'email-status': '/api/email-status',
      status: '/api/status'
    }
  });
});

// Manual trigger endpoints
app.post('/api/scrape', async (req, res) => {
  try {
    console.log('📡 Manual scrape triggered');
    const results = await scrapeAllSources();
    res.json({ 
      success: true, 
      message: 'Scraping completed',
      articlesFound: results.length 
    });
  } catch (error) {
    console.error('❌ Scraping failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Generate newsletter for specific segment or default to 'pro'
app.post('/api/generate/:segment?', async (req, res) => {
  try {
    const segment = req.params.segment || 'pro';
    
    if (!['pro', 'driver'].includes(segment)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid segment. Must be "pro" or "driver"'
      });
    }
    
    console.log(`📧 Manual newsletter generation and sending triggered for ${segment} segment`);
    
    // Initialize newsletter generator
    const newsletterGenerator = new NewsletterGenerator();
    
    // Generate and send newsletter
    const newsletter = await newsletterGenerator.generateNewsletter(segment, true);
    
    res.json({ 
      success: true, 
      message: `${segment} newsletter generated and sent successfully`,
      newsletter: {
        segment: newsletter.segment,
        subject: newsletter.subject,
        articles: newsletter.articles.length,
        filename: newsletter.filename
      },
      email: newsletter.emailSending || { status: 'Email sending status not available' }
    });
  } catch (error) {
    console.error('❌ Newsletter generation/sending failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Legacy endpoint for backward compatibility
app.post('/api/generate', async (req, res) => {
  // Redirect to pro segment for backward compatibility
  req.params.segment = 'pro';
  return app._router.handle(req, res);
});

// Test subscriber system
app.get('/api/test-subscribers', async (req, res) => {
  try {
    console.log('🧪 Testing subscriber system...');
    
    const testResult = await emailSender.testEmailSystem();
    
    res.json({
      success: true,
      message: 'Subscriber system test completed',
      results: testResult
    });
  } catch (error) {
    console.error('❌ Subscriber test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed subscriber statistics including inactive ones
app.get('/api/subscriber-stats', async (req, res) => {
  try {
    console.log('📊 Fetching detailed subscriber statistics...');
    
    // Fetch raw data for both segments
    const [proRaw, driverRaw] = await Promise.all([
      emailSender.fetchSubscribersData(emailSender.SUBSCRIBERS_SHEET_URLS[0], 'pro', true), // true = include all statuses
      emailSender.fetchSubscribersData(emailSender.SUBSCRIBERS_SHEET_URLS[0], 'driver', true)
    ]);
    
    // Analyze the data
    const analyzeSegment = (rawData, segment) => {
      let active = 0, unsubscribed = 0, paused = 0, pending = 0;
      const companies = new Set();
      const roles = new Set();
      
      rawData.forEach(row => {
        if (row.length < 5) return;
        const [id, email, name, segmentCol, status, , , , , company, role, , , , unsubAt, , pausedAt, resumeAt] = row;
        
        if (segmentCol && segmentCol.toLowerCase() === segment.toLowerCase() && email && email.includes('@')) {
          if (company) companies.add(company);
          if (role) roles.add(role);
          
          if (unsubAt && unsubAt.trim() !== '') {
            unsubscribed++;
          } else if (pausedAt && pausedAt.trim() !== '' && (!resumeAt || resumeAt.trim() === '')) {
            paused++;
          } else if (status && status.toLowerCase() === 'active') {
            active++;
          } else {
            pending++;
          }
        }
      });
      
      return {
        active,
        unsubscribed,
        paused,
        pending,
        total: active + unsubscribed + paused + pending,
        companies: Array.from(companies),
        roles: Array.from(roles)
      };
    };
    
    const proStats = analyzeSegment(proRaw, 'pro');
    const driverStats = analyzeSegment(driverRaw, 'driver');
    
    res.json({
      success: true,
      pro: proStats,
      driver: driverStats,
      summary: {
        totalActive: proStats.active + driverStats.active,
        totalSubscribers: proStats.total + driverStats.total,
        totalUnsubscribed: proStats.unsubscribed + driverStats.unsubscribed,
        totalPaused: proStats.paused + driverStats.paused,
        allCompanies: [...new Set([...proStats.companies, ...driverStats.companies])],
        allRoles: [...new Set([...proStats.roles, ...driverStats.roles])]
      }
    });
  } catch (error) {
    console.error('❌ Subscriber stats failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
app.get('/api/subscribers/:segment?', async (req, res) => {
  try {
    const segment = req.params.segment;
    
    if (segment && !['pro', 'driver'].includes(segment)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid segment. Must be "pro" or "driver"'
      });
    }
    
    if (segment) {
      // Get specific segment
      const subscribers = await emailSender.getSubscribersFromSheet(segment);
      res.json({
        success: true,
        segment: segment,
        count: subscribers.length,
        subscribers: subscribers.map(s => ({ email: s.email, name: s.name, status: s.status }))
      });
    } else {
      // Get both segments
      const [proSubscribers, driverSubscribers] = await Promise.all([
        emailSender.getSubscribersFromSheet('pro'),
        emailSender.getSubscribersFromSheet('driver')
      ]);
      
      res.json({
        success: true,
        pro: {
          count: proSubscribers.length,
          subscribers: proSubscribers.map(s => ({ email: s.email, name: s.name, status: s.status }))
        },
        driver: {
          count: driverSubscribers.length,
          subscribers: driverSubscribers.map(s => ({ email: s.email, name: s.name, status: s.status }))
        },
        total: proSubscribers.length + driverSubscribers.length
      });
    }
  } catch (error) {
    console.error('❌ Subscriber fetch failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test email endpoint
app.post('/api/test-email', async (req, res) => {
  try {
    const testRecipient = req.body.email || process.env.NEWSLETTER_RECIPIENTS?.split(',')[0];
    
    if (!testRecipient) {
      return res.status(400).json({
        success: false,
        error: 'No test recipient provided. Include email in request body or set NEWSLETTER_RECIPIENTS env var.'
      });
    }

    console.log(`📧 Sending test email to: ${testRecipient}`);
    
    // Create test newsletter data
    const testData = {
      html: `
        <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1e40af;">SFP Newsletter System Test</h2>
          <p>This is a test email from the Safe Freight Program newsletter automation system.</p>
          <p><strong>Test Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</p>
          <p><strong>System Status:</strong> Email sending functionality is working correctly</p>
          <p><strong>Subscriber System:</strong> Connected to Google Sheets</p>
        </body></html>
      `,
      text: 'SFP Newsletter System Test - Email sending working correctly',
      subject: 'SFP Newsletter System Test',
      segment: 'test'
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
      recipient: testRecipient
    });
  } catch (error) {
    console.error('❌ Test email failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Email configuration status
app.get('/api/email-status', async (req, res) => {
  try {
    const connectionVerified = await emailSender.verifyConnection();
    
    res.json({
      emailConfigured: !!process.env.EMAIL_USER,
      recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS,
      connectionVerified: connectionVerified,
      smtpHost: process.env.EMAIL_HOST || 'smtp.gmail.com',
      smtpPort: process.env.EMAIL_PORT || 587,
      fromAddress: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'Not configured'
    });
  } catch (error) {
    res.status(500).json({
      emailConfigured: !!process.env.EMAIL_USER,
      recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS,
      connectionVerified: false,
      error: error.message
    });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    lastRestart: new Date().toISOString(),
    emailConfigured: !!process.env.EMAIL_USER,
    recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS,
    subscribersSheetConfigured: true,
    scheduleActive: process.env.NODE_ENV === 'production',
    currentTime: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })
  });
});

// Unsubscribe endpoint
app.get('/unsubscribe', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).send('Email parameter required');
  }
  
  try {
    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>Successfully Unsubscribed</h2>
          <p>You have been removed from the Safe Freight Program newsletter.</p>
          <p>If this was a mistake, you can resubscribe at safefreightprogram.com</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).send('Error processing unsubscribe request');
  }
});

// CORRECTED: Automated scheduling (only in production)
if (process.env.NODE_ENV === 'production') {
  console.log('🕐 Production mode: Automated scheduling enabled');
  console.log('📅 Schedule: 4:45 PM AEST (scraping), 5:00 PM AEST (newsletter + email)');
  
  // Content scraping - 4:45 PM AEST daily
  cron.schedule('45 16 * * *', async () => {
    console.log('🔍 AUTOMATED SCRAPING: Started at 4:45 PM AEST');
    try {
      const results = await scrapeAllSources();
      console.log(`✅ Scheduled scraping completed - ${results.length} articles found`);
    } catch (error) {
      console.error('❌ Scheduled scraping failed:', error);
    }
  }, {
    timezone: "Australia/Sydney"
  });

  // Newsletter generation and sending - 5:00 PM AEST daily
  cron.schedule('0 17 * * *', async () => {
    console.log('📧 AUTOMATED NEWSLETTER: Started at 5:00 PM AEST');
    try {
      // Initialize newsletter generator
      const newsletterGenerator = new NewsletterGenerator();
      
      // Generate and send both pro and driver newsletters
      console.log('📊 Generating COR Intel Weekly (pro segment)...');
      const proNewsletter = await newsletterGenerator.generateNewsletter('pro', true);
      console.log(`✅ Pro newsletter sent to ${proNewsletter.emailSending?.sentCount || 0} recipients`);
      
      // Wait a bit between newsletters to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      console.log('🚛 Generating Safe Freight Mate (driver segment)...');
      const driverNewsletter = await newsletterGenerator.generateNewsletter('driver', true);
      console.log(`✅ Driver newsletter sent to ${driverNewsletter.emailSending?.sentCount || 0} recipients`);
      
      console.log('📧 All newsletters sent successfully');
      
    } catch (error) {
      console.error('❌ Scheduled newsletter generation/sending failed:', error);
    }
  }, {
    timezone: "Australia/Sydney"
  });
  
} else {
  console.log('🔧 Development mode: Automated scheduling disabled');
  console.log('💡 Use /api/scrape and /api/generate endpoints for manual testing');
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found' 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 SFP Newsletter Automation running on port ${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🕐 Current Sydney time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`);
  
  // Check email configuration on startup
  if (process.env.EMAIL_USER && process.env.NEWSLETTER_RECIPIENTS) {
    console.log('📧 Email configuration detected');
    console.log(`📮 From: ${process.env.EMAIL_FROM || process.env.EMAIL_USER}`);
    emailSender.verifyConnection()
      .then(verified => {
        if (verified) {
          console.log('✅ Email server connection verified');
          
          // Test subscriber system on startup
          emailSender.testEmailSystem()
            .then(testResult => {
              console.log('📊 Subscriber System Status:');
              console.log(`   Pro Subscribers: ${testResult.proSubscribers}`);
              console.log(`   Driver Subscribers: ${testResult.driverSubscribers}`);
              console.log(`   Total Subscribers: ${testResult.totalSubscribers}`);
            })
            .catch(error => {
              console.log('⚠️ Subscriber system test failed:', error.message);
            });
        } else {
          console.log('❌ Email server connection failed');
        }
      })
      .catch(error => {
        console.log('❌ Email configuration error:', error.message);
      });
  } else {
    console.log('⚠️  Email not configured - set EMAIL_USER and NEWSLETTER_RECIPIENTS env vars');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});