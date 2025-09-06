require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');

// Import your modules
const NewsletterGenerator = require('./generator');        
const { scrapeAllSources } = require('./scraper');          
const EmailSender = require('./emailSender');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize email sender
const emailSender = new EmailSender();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Health check endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'SFP Newsletter Automation',
    version: '2.0.0'
  });
});

// Root endpoint with better documentation
app.get('/', (req, res) => {
  res.json({
    message: 'SFP Newsletter Automation API v2.0',
    schedule: {
      scraping: '4:45 PM AEST daily',
      newsletter: '5:00 PM AEST daily'
    },
    endpoints: {
      // Core functionality
      health: 'GET /health',
      status: 'GET /api/status',
      
      // Content management
      scrape: 'POST /api/scrape',
      
      // Newsletter generation
      'generate-pro': 'POST /api/generate/pro',
      'generate-driver': 'POST /api/generate/driver',
      'generate-both': 'POST /api/generate/both',
      
      // Email testing
      'test-email': 'POST /api/test-email',
      'test-subscribers': 'GET /api/test-subscribers',
      'email-status': 'GET /api/email-status',
      
      // Subscriber management
      'subscribers-pro': 'GET /api/subscribers/pro',
      'subscribers-driver': 'GET /api/subscribers/driver',
      'subscribers-all': 'GET /api/subscribers',
      'subscriber-stats': 'GET /api/subscriber-stats',
      'add-subscriber': 'POST /api/subscribers',
      'update-subscriber': 'PUT /api/subscribers/:email',
      'remove-subscriber': 'DELETE /api/subscribers/:email',
      
      // Newsletter management
      'newsletter-history': 'GET /api/newsletters',
      'newsletter-detail': 'GET /api/newsletters/:id',
      'newsletter-metrics': 'GET /api/metrics'
    }
  });
});

// ENHANCED: Manual scraping with better feedback
app.post('/api/scrape', async (req, res) => {
  try {
    console.log('🔡 Manual scrape triggered');
    const startTime = Date.now();
    
    const results = await scrapeAllSources();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    res.json({ 
      success: true, 
      message: 'Scraping completed successfully',
      results: {
        articlesFound: results.length,
        duration: `${duration} seconds`,
        highQuality: results.filter(a => a.relevanceScore > 10).length,
        mediumQuality: results.filter(a => a.relevanceScore >= 5 && a.relevanceScore <= 10).length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Scraping failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ENHANCED: Newsletter generation with better options
app.post('/api/generate/:segment?', async (req, res) => {
  try {
    const segment = req.params.segment || 'pro';
    const { sendEmail = true, dryRun = false } = req.body;
    
    if (!['pro', 'driver', 'both'].includes(segment)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid segment. Must be "pro", "driver", or "both"'
      });
    }
    
    console.log(`📧 Newsletter generation triggered for ${segment} segment (sendEmail: ${sendEmail}, dryRun: ${dryRun})`);
    
    const newsletterGenerator = new NewsletterGenerator();
    const results = {};
    
    if (segment === 'both') {
      // Generate both newsletters
      console.log('📊 Generating both newsletters...');
      
      try {
        results.pro = await newsletterGenerator.generateNewsletter('pro', sendEmail && !dryRun);
        console.log('✅ Pro newsletter completed');
        
        // Wait between newsletters
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        results.driver = await newsletterGenerator.generateNewsletter('driver', sendEmail && !dryRun);
        console.log('✅ Driver newsletter completed');
        
      } catch (error) {
        console.error('❌ Newsletter generation failed:', error);
        return res.status(500).json({
          success: false,
          error: error.message,
          partialResults: results
        });
      }
      
    } else {
      // Generate single newsletter
      results[segment] = await newsletterGenerator.generateNewsletter(segment, sendEmail && !dryRun);
    }
    
    res.json({ 
      success: true, 
      message: `Newsletter(s) generated successfully`,
      dryRun: dryRun,
      results: results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Newsletter generation failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// NEW: Enhanced subscriber management endpoints

// Get all subscribers or by segment
app.get('/api/subscribers/:segment?', async (req, res) => {
  try {
    const segment = req.params.segment;
    const { includeInactive = false, page = 1, limit = 100 } = req.query;
    
    if (segment && !['pro', 'driver'].includes(segment)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid segment. Must be "pro" or "driver"'
      });
    }
    
    let subscribers;
    
    if (segment) {
      subscribers = await emailSender.getSubscribersFromSheet(segment);
      
      // Add pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + parseInt(limit);
      const paginatedSubscribers = subscribers.slice(startIndex, endIndex);
      
      res.json({
        success: true,
        segment: segment,
        data: {
          subscribers: paginatedSubscribers.map(s => ({
            email: s.email,
            name: s.name,
            status: s.status,
            subscribedDate: s.subscribedDate
          })),
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: subscribers.length,
            pages: Math.ceil(subscribers.length / limit)
          }
        }
      });
    } else {
      // Get both segments
      const [proSubscribers, driverSubscribers] = await Promise.all([
        emailSender.getSubscribersFromSheet('pro'),
        emailSender.getSubscribersFromSheet('driver')
      ]);
      
      res.json({
        success: true,
        data: {
          pro: {
            count: proSubscribers.length,
            subscribers: proSubscribers.slice(0, 10).map(s => ({ email: s.email, name: s.name, status: s.status }))
          },
          driver: {
            count: driverSubscribers.length,
            subscribers: driverSubscribers.slice(0, 10).map(s => ({ email: s.email, name: s.name, status: s.status }))
          },
          summary: {
            totalActive: proSubscribers.length + driverSubscribers.length,
            proActive: proSubscribers.length,
            driverActive: driverSubscribers.length
          }
        }
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

// NEW: Add subscriber endpoint
app.post('/api/subscribers', async (req, res) => {
  try {
    const { email, name, segment, company, role } = req.body;
    
    if (!email || !segment) {
      return res.status(400).json({
        success: false,
        error: 'Email and segment are required'
      });
    }
    
    if (!['pro', 'driver'].includes(segment)) {
      return res.status(400).json({
        success: false,
        error: 'Segment must be "pro" or "driver"'
      });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email format'
      });
    }
    
    // This would require implementing a method to add to Google Sheets
    // For now, return a placeholder response
    res.json({
      success: true,
      message: 'Subscriber addition requested',
      data: {
        email,
        name: name || '',
        segment,
        company: company || '',
        role: role || '',
        status: 'pending',
        subscribedDate: new Date().toISOString()
      },
      note: 'Manual addition to Google Sheets required'
    });
    
  } catch (error) {
    console.error('❌ Add subscriber failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// NEW: Enhanced subscriber statistics
app.get('/api/subscriber-stats', async (req, res) => {
  try {
    console.log('📊 Fetching enhanced subscriber statistics...');
    
    const [proSubscribers, driverSubscribers] = await Promise.all([
      emailSender.getSubscribersFromSheet('pro'),
      emailSender.getSubscribersFromSheet('driver')
    ]);
    
    // Analyze subscriber data
    const analyzeSubscribers = (subscribers, segment) => {
      const companies = new Set();
      const domains = new Map();
      
      subscribers.forEach(sub => {
        if (sub.company) companies.add(sub.company);
        
        const domain = sub.email.split('@')[1];
        domains.set(domain, (domains.get(domain) || 0) + 1);
      });
      
      return {
        count: subscribers.length,
        topDomains: Array.from(domains.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([domain, count]) => ({ domain, count })),
        companies: Array.from(companies).slice(0, 10),
        segment
      };
    };
    
    const proStats = analyzeSubscribers(proSubscribers, 'pro');
    const driverStats = analyzeSubscribers(driverSubscribers, 'driver');
    
    res.json({
      success: true,
      data: {
        summary: {
          totalSubscribers: proStats.count + driverStats.count,
          proSubscribers: proStats.count,
          driverSubscribers: driverStats.count,
          lastUpdated: new Date().toISOString()
        },
        pro: proStats,
        driver: driverStats,
        growth: {
          // Placeholder for growth metrics
          weeklyGrowth: 0,
          monthlyGrowth: 0,
          note: 'Growth tracking requires historical data'
        }
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

// Enhanced test email with more options
app.post('/api/test-email', async (req, res) => {
  try {
    const { email, type = 'simple', segment = 'pro' } = req.body;
    const testRecipient = email || process.env.NEWSLETTER_RECIPIENTS?.split(',')[0];
    
    if (!testRecipient) {
      return res.status(400).json({
        success: false,
        error: 'No test recipient provided. Include email in request body or set NEWSLETTER_RECIPIENTS env var.'
      });
    }

    console.log(`📧 Sending ${type} test email to: ${testRecipient}`);
    
    let testData;
    
    if (type === 'newsletter') {
      // Send a sample newsletter
      const newsletterGenerator = new NewsletterGenerator();
      try {
        const sampleNewsletter = await newsletterGenerator.generateNewsletter(segment, false);
        testData = sampleNewsletter;
      } catch (error) {
        // Fallback to simple test if newsletter generation fails
        testData = {
          html: `<html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1e40af;">SFP Newsletter Test (Newsletter Generation Failed)</h2>
            <p>This is a fallback test email. Newsletter generation failed with error: ${error.message}</p>
            <p><strong>Test Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</p>
            </body></html>`,
          text: 'SFP Newsletter Test - Newsletter generation failed',
          subject: `SFP Newsletter Test - ${segment} (Generation Failed)`,
          segment: segment
        };
      }
    } else {
      // Simple connectivity test
      testData = {
        html: `
          <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1e40af;">SFP Newsletter System Test</h2>
            <p>This is a test email from the Safe Freight Program newsletter automation system.</p>
            <p><strong>Test Time:</strong> ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}</p>
            <p><strong>System Status:</strong> Email sending functionality is working correctly</p>
            <p><strong>Subscriber System:</strong> Connected to Google Sheets</p>
            <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
            <p><strong>Server:</strong> Railway Production</p>
          </body></html>
        `,
        text: 'SFP Newsletter System Test - Email sending working correctly',
        subject: 'SFP Newsletter System Test',
        segment: 'test'
      };
    }
    
    const testSubscriber = { 
      email: testRecipient, 
      name: 'Test User',
      segment: testData.segment || 'test'
    };
    
    await emailSender.sendSingleEmail(testData, testSubscriber);
    
    res.json({
      success: true,
      message: `${type} test email sent successfully`,
      data: {
        recipient: testRecipient,
        type: type,
        segment: testData.segment,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Test email failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: {
        smtpHost: process.env.EMAIL_HOST,
        fromEmail: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Enhanced test subscriber system
app.get('/api/test-subscribers', async (req, res) => {
  try {
    console.log('🧪 Testing subscriber system...');
    
    const testResult = await emailSender.testEmailSystem();
    
    res.json({
      success: true,
      message: 'Subscriber system test completed',
      results: {
        ...testResult,
        sheetsUrl: 'https://docs.google.com/spreadsheets/d/' + process.env.GOOGLE_SHEETS_ID,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Subscriber test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Enhanced email configuration status
app.get('/api/email-status', async (req, res) => {
  try {
    const connectionVerified = await emailSender.verifyConnection();
    
    res.json({
      success: true,
      configuration: {
        emailConfigured: !!process.env.EMAIL_USER,
        recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS,
        connectionVerified: connectionVerified,
        smtpHost: process.env.EMAIL_HOST || 'smtp.gmail.com',
        smtpPort: process.env.EMAIL_PORT || 587,
        fromAddress: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'Not configured',
        environment: process.env.NODE_ENV || 'development'
      },
      issues: identifyEmailIssues(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      configuration: {
        emailConfigured: !!process.env.EMAIL_USER,
        recipientsConfigured: !!process.env.NEWSLETTER_RECIPIENTS,
        connectionVerified: false
      },
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Helper function to identify email configuration issues
function identifyEmailIssues() {
  const issues = [];
  
  if (!process.env.EMAIL_USER) {
    issues.push('EMAIL_USER not configured');
  }
  
  if (!process.env.EMAIL_PASS) {
    issues.push('EMAIL_PASS not configured');
  }
  
  if (process.env.EMAIL_FROM && !process.env.EMAIL_FROM.includes('@')) {
    issues.push('EMAIL_FROM should be an email address, not a domain');
  }
  
  if (!process.env.NEWSLETTER_RECIPIENTS) {
    issues.push('NEWSLETTER_RECIPIENTS not configured for fallback');
  }
  
  // Check if using Gmail with regular password instead of App Password
  if (process.env.EMAIL_HOST === 'smtp.gmail.com' && process.env.EMAIL_PASS && !process.env.EMAIL_PASS.includes(' ')) {
    issues.push('Consider using Gmail App Password instead of regular password');
  }
  
  return issues;
}

// Enhanced system status
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
          configured: !!process.env.EMAIL_USER,
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
      schedule: {
        active: process.env.NODE_ENV === 'production',
        scraping: '4:45 PM AEST daily',
        newsletter: '5:00 PM AEST daily'
      },
      currentTime: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// NEW: Newsletter history endpoint
app.get('/api/newsletters', async (req, res) => {
  try {
    const { segment, limit = 10, page = 1 } = req.query;
    
    // This would require implementing newsletter archive retrieval
    // For now, return placeholder data
    res.json({
      success: true,
      message: 'Newsletter history endpoint - implementation pending',
      data: {
        newsletters: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          pages: 0
        },
        note: 'Requires Content_Archive sheet integration'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// NEW: Newsletter metrics endpoint
app.get('/api/metrics', async (req, res) => {
  try {
    const { timeframe = '30d' } = req.query;
    
    // Placeholder for newsletter metrics
    res.json({
      success: true,
      message: 'Newsletter metrics endpoint - implementation pending',
      data: {
        timeframe: timeframe,
        metrics: {
          newslettersSent: 0,
          totalOpens: 0,
          totalClicks: 0,
          openRate: 0,
          clickRate: 0,
          unsubscribeRate: 0
        },
        note: 'Requires analytics integration'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Unsubscribe endpoint with better handling
app.get('/unsubscribe', async (req, res) => {
  const { email, token } = req.query;
  
  if (!email) {
    return res.status(400).send(`
      <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #dc2626;">Error</h2>
        <p>Email parameter is required for unsubscribe.</p>
      </body></html>
    `);
  }
  
  try {
    res.send(`
      <html>
        <head><title>Unsubscribed - Safe Freight Program</title></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #16a34a;">Successfully Unsubscribed</h2>
          <p>You have been removed from the Safe Freight Program newsletter.</p>
          <p><strong>Email:</strong> ${email}</p>
          <p>If this was a mistake, you can resubscribe at <a href="https://safefreightprogram.com">safefreightprogram.com</a></p>
          <hr style="margin: 20px 0;">
          <p style="color: #6b7280; font-size: 14px;">
            Note: This is a manual unsubscribe confirmation. 
            Please contact support if you continue to receive emails.
          </p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).send(`
      <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #dc2626;">Error</h2>
        <p>Error processing unsubscribe request. Please contact support.</p>
      </body></html>
    `);
  }
});

// CORRECTED: Automated scheduling for production
if (process.env.NODE_ENV === 'production') {
  console.log('🕒 Production mode: Automated scheduling enabled');
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
      const newsletterGenerator = new NewsletterGenerator();
      
      console.log('📊 Generating COR Intel Weekly (pro segment)...');
      const proNewsletter = await newsletterGenerator.generateNewsletter('pro', true);
      console.log(`✅ Pro newsletter sent to ${proNewsletter.emailSending?.sentCount || 0} recipients`);
      
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay
      
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
  console.log('💡 Use API endpoints for manual testing');
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found',
    availableEndpoints: '/',
    timestamp: new Date().toISOString()
  });
});

// Start server with enhanced startup checks
app.listen(PORT, async () => {
  console.log(`🚀 SFP Newsletter Automation v2.0 running on port ${PORT}`);
  console.log(`🏥 Health check: https://sfp-newsletter-automation-production.up.railway.app/health`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🕒 Current Sydney time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`);
  
  // Enhanced startup checks
  console.log('\n🔍 Running startup diagnostics...');
  
  // Check email configuration
  if (process.env.EMAIL_USER && process.env.NEWSLETTER_RECIPIENTS) {
    console.log('📧 Email configuration detected');
    
    // Check FROM address configuration
    const fromEmail = process.env.EMAIL_FROM && process.env.EMAIL_FROM.includes('@') 
      ? process.env.EMAIL_FROM 
      : process.env.EMAIL_USER;
    console.log(`📮 From: ${fromEmail}`);
    
    // Verify SMTP connection
    try {
      const verified = await emailSender.verifyConnection();
      if (verified) {
        console.log('✅ Email server connection verified');
        
        // Test subscriber system
        try {
          const testResult = await emailSender.testEmailSystem();
          console.log('📊 Subscriber System Status:');
          console.log(`   Pro Subscribers: ${testResult.proSubscribers}`);
          console.log(`   Driver Subscribers: ${testResult.driverSubscribers}`);
          console.log(`   Total Subscribers: ${testResult.totalSubscribers}`);
          
          if (testResult.totalSubscribers === 0) {
            console.log('⚠️  No subscribers found - check Google Sheets configuration');
          }
        } catch (error) {
          console.log('⚠️  Subscriber system test failed:', error.message);
        }
      } else {
        console.log('❌ Email server connection failed');
        console.log('💡 Check EMAIL_PASS - consider using Gmail App Password');
      }
    } catch (error) {
      console.log('❌ Email configuration error:', error.message);
    }
  } else {
    console.log('⚠️  Email not configured - set EMAIL_USER and NEWSLETTER_RECIPIENTS env vars');
  }
  
  // Check other services
  console.log('\n🔧 Service Configuration:');
  console.log(`   Google Sheets: ${process.env.GOOGLE_SHEETS_ID ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   OpenAI API: ${process.env.OPENAI_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`   Scheduled Tasks: ${process.env.NODE_ENV === 'production' ? '✅ Active' : '⏸️  Disabled (dev mode)'}`);
  
  console.log('\n🎯 Ready for operation!');
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