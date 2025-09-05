const express = require('express');
const NewsletterAnalytics = require('./analytics/tracker');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;
const analytics = new NewsletterAnalytics();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set trust proxy for accurate IP addresses
app.set('trust proxy', true);

// Analytics endpoints

// Track newsletter opens
app.get('/track/open', async (req, res) => {
  await analytics.trackOpen(req, res);
});

// Track article clicks
app.get('/track/click', async (req, res) => {
  await analytics.trackClick(req, res);
});

// Handle unsubscribe/pause (Australian Spam Act compliance)
app.get('/unsubscribe', async (req, res) => {
  await analytics.handleUnsubscribe(req, res);
});

// Analytics report endpoint (for internal use)
app.get('/analytics/report/:newsletterId?', async (req, res) => {
  try {
    const { newsletterId } = req.params;
    const report = await analytics.generateReport(newsletterId);
    
    if (report.error) {
      return res.status(500).json({ error: report.error });
    }
    
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'SFP Newsletter Analytics'
  });
});

// Simple analytics dashboard (optional)
app.get('/dashboard', async (req, res) => {
  try {
    const report = await analytics.generateReport();
    
    if (report.error) {
      return res.status(500).send(`Error: ${report.error}`);
    }
    
    const dashboardHTML = `
<!DOCTYPE html>
<html>
<head>
    <title>Newsletter Analytics Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; }
        .metric { display: inline-block; margin: 10px 20px; padding: 20px; background: #f8f9fa; border-radius: 6px; }
        .metric h3 { margin: 0; color: #1e40af; }
        .metric p { margin: 5px 0 0 0; font-size: 24px; font-weight: bold; }
        .events { margin-top: 30px; }
        .event { padding: 10px; border-left: 3px solid #1e40af; margin: 5px 0; background: #f8f9fa; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Safe Freight Program - Newsletter Analytics</h1>
        
        <div class="metrics">
            <div class="metric">
                <h3>Total Opens</h3>
                <p>${report.opens}</p>
            </div>
            <div class="metric">
                <h3>Total Clicks</h3>
                <p>${report.clicks}</p>
            </div>
            <div class="metric">
                <h3>Click-Through Rate</h3>
                <p>${report.clickThroughRate}</p>
            </div>
            <div class="metric">
                <h3>Unsubscribes</h3>
                <p>${report.unsubscribes}</p>
            </div>
        </div>
        
        <div class="events">
            <h2>Recent Events</h2>
            ${report.events.map(event => `
                <div class="event">
                    <strong>${event.eventType.toUpperCase()}</strong> 
                    - ${event.newsletterId} 
                    - ${new Date(event.timestamp).toLocaleString('en-AU')}
                    ${event.targetUrl ? `<br><small>→ ${event.targetUrl}</small>` : ''}
                </div>
            `).join('')}
        </div>
    </div>
</body>
</html>`;
    
    res.send(dashboardHTML);
  } catch (error) {
    res.status(500).send(`Dashboard Error: ${error.message}`);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 SFP Newsletter Analytics Server running on port ${port}`);
  console.log(`📊 Dashboard: http://localhost:${port}/dashboard`);
  console.log(`🔗 Health check: http://localhost:${port}/health`);
});

module.exports = app;