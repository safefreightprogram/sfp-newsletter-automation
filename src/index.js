require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');

// These should work with your current structure:
const { generateNewsletter } = require('./generator');        // ✅ same folder
const { scrapeAllSources } = require('./scraper');           // ✅ same folder  
const { trackAnalytics } = require('../analytics/tracker');   // ✅ up one level

const app = express();
const PORT = process.env.PORT || 3000;

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
    endpoints: {
      health: '/health',
      scrape: '/api/scrape',
      generate: '/api/generate',
      status: '/api/status'
    }
  });
});

// Manual trigger endpoints
app.post('/api/scrape', async (req, res) => {
  try {
    console.log('Manual scrape triggered');
    const results = await scrapeAllSources();
    res.json({ 
      success: true, 
      message: 'Scraping completed',
      articlesFound: results.length 
    });
  } catch (error) {
    console.error('Scraping failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    console.log('Manual newsletter generation triggered');
    const newsletter = await generateNewsletter();
    res.json({ 
      success: true, 
      message: 'Newsletter generated successfully',
      newsletter: newsletter 
    });
  } catch (error) {
    console.error('Newsletter generation failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    lastRestart: new Date().toISOString()
  });
});

// Unsubscribe endpoint (from your existing functionality)
app.get('/unsubscribe', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).send('Email parameter required');
  }
  
  try {
    // Your existing unsubscribe logic here
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

// Automated scheduling (only in production)
if (process.env.NODE_ENV === 'production') {
  // Weekly scraping - every Monday at 6 AM AEST
  cron.schedule('30 16 * * *', async () => {
    console.log('TEST SCRAPING: Started at 4:30 PM AEST');
    try {
      await scrapeAllSources();
      console.log('Scheduled scraping completed');
    } catch (error) {
      console.error('Scheduled scraping failed:', error);
    }
  }, {
    timezone: "Australia/Sydney"
  });

  // Weekly newsletter generation - every Monday at 8 AM AEST
  cron.schedule('45 16 * * *', async () => {
    console.log('TEST NEWSLETTER: Started at 4:45 PM AEST');
    try {
      await generateNewsletter();
      console.log('Scheduled newsletter generation completed');
    } catch (error) {
      console.error('Scheduled newsletter generation failed:', error);
    }
  }, {
    timezone: "Australia/Sydney"
  });
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
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
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