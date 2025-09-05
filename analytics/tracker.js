const SheetsManager = require('../config/sheets');

class NewsletterAnalytics {
  constructor() {
    this.sheetsManager = new SheetsManager();
  }

  // Track newsletter opens
  async trackOpen(req, res) {
    try {
      const { newsletter } = req.query;
      
      if (newsletter) {
        await this.logEvent({
          newsletterId: newsletter,
          eventType: 'open',
          timestamp: new Date().toISOString(),
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        });
      }
      
      // Return 1x1 transparent pixel
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': pixel.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(pixel);
      
    } catch (error) {
      console.error('Analytics tracking error:', error.message);
      // Still return pixel even if tracking fails
      const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(pixel);
    }
  }

  // Track article clicks with redirect
  async trackClick(req, res) {
    try {
      const { newsletter, article, url } = req.query;
      
      if (newsletter && article && url) {
        await this.logEvent({
          newsletterId: newsletter,
          eventType: 'click',
          articleIndex: parseInt(article),
          targetUrl: decodeURIComponent(url),
          timestamp: new Date().toISOString(),
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        });
      }
      
      // Redirect to original article
      const targetUrl = url ? decodeURIComponent(url) : 'https://safefreightprogram.com.au';
      res.redirect(302, targetUrl);
      
    } catch (error) {
      console.error('Click tracking error:', error.message);
      // Still redirect even if tracking fails
      const targetUrl = req.query.url ? decodeURIComponent(req.query.url) : 'https://safefreightprogram.com.au';
      res.redirect(302, targetUrl);
    }
  }

  // Handle unsubscribe/pause requests (Australian Spam Act compliance)
  async handleUnsubscribe(req, res) {
    try {
      const { newsletter, type, email } = req.query;
      
      await this.logEvent({
        newsletterId: newsletter,
        eventType: type || 'unsubscribe',
        email: email,
        timestamp: new Date().toISOString(),
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });
      
      // Show confirmation page
      const confirmationHTML = this.getUnsubscribeConfirmation(type);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(confirmationHTML);
      
    } catch (error) {
      console.error('Unsubscribe handling error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error processing request. Please contact support@safefreightprogram.com.au');
    }
  }

  // Log events to Google Sheets
  async logEvent(eventData) {
    try {
      await this.sheetsManager.initialize();
      
      // Get or create analytics sheet
      let analyticsSheet = this.sheetsManager.doc.sheetsByTitle['Newsletter_Analytics'];
      if (!analyticsSheet) {
        analyticsSheet = await this.sheetsManager.doc.addSheet({
          title: 'Newsletter_Analytics',
          headerValues: [
            'Timestamp', 'Newsletter_ID', 'Event_Type', 'Article_Index', 
            'Target_URL', 'Email', 'IP_Address', 'User_Agent', 'Details'
          ]
        });
      }
      
      // Add event row
      await analyticsSheet.addRow({
        Timestamp: eventData.timestamp,
        Newsletter_ID: eventData.newsletterId,
        Event_Type: eventData.eventType,
        Article_Index: eventData.articleIndex || '',
        Target_URL: eventData.targetUrl || '',
        Email: eventData.email || '',
        IP_Address: eventData.ipAddress || '',
        User_Agent: eventData.userAgent || '',
        Details: JSON.stringify(eventData)
      });
      
      console.log(`📊 Logged ${eventData.eventType} event for newsletter ${eventData.newsletterId}`);
      
    } catch (error) {
      console.error('Failed to log analytics event:', error.message);
    }
  }

  getUnsubscribeConfirmation(type) {
    const action = type === 'pause' ? 'paused' : 'unsubscribed';
    const message = type === 'pause' 
      ? 'Your newsletter subscription has been paused. You can resubscribe at any time.'
      : 'You have been successfully unsubscribed from our newsletters.';
    
    return `<!DOCTYPE html>
<html lang="en-AU">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Subscription ${action.charAt(0).toUpperCase() + action.slice(1)} - Safe Freight Program</title>
</head>
<body style="margin: 0; padding: 40px; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
    <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1e40af; margin: 0 0 16px 0; font-size: 28px;">Safe Freight Program</h1>
            <div style="width: 50px; height: 3px; background: #1e40af; margin: 0 auto;"></div>
        </div>
        
        <div style="text-align: center;">
            <div style="background: #dcfce7; color: #16a34a; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
                <h2 style="margin: 0 0 8px 0; font-size: 20px;">Subscription ${action.charAt(0).toUpperCase() + action.slice(1)}</h2>
                <p style="margin: 0; font-size: 16px;">${message}</p>
            </div>
            
            <p style="color: #6b7280; margin-bottom: 24px; line-height: 1.6;">
                This action complies with the Australian Spam Act 2003. If you have any questions, 
                please contact us at <a href="mailto:support@safefreightprogram.com.au" style="color: #1e40af;">support@safefreightprogram.com.au</a>
            </p>
            
            <a href="https://safefreightprogram.com.au" style="display: inline-block; background: #1e40af; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600;">
                Return to Website
            </a>
        </div>
    </div>
</body>
</html>`;
  }

  // Generate analytics report
  async generateReport(newsletterId = null) {
    try {
      await this.sheetsManager.initialize();
      
      const analyticsSheet = this.sheetsManager.doc.sheetsByTitle['Newsletter_Analytics'];
      if (!analyticsSheet) {
        return { error: 'No analytics data found' };
      }
      
      const rows = await analyticsSheet.getRows();
      const events = rows.map(row => ({
        timestamp: row.get('Timestamp'),
        newsletterId: row.get('Newsletter_ID'),
        eventType: row.get('Event_Type'),
        articleIndex: row.get('Article_Index'),
        targetUrl: row.get('Target_URL')
      }));
      
      // Filter by newsletter if specified
      const filteredEvents = newsletterId 
        ? events.filter(e => e.newsletterId === newsletterId)
        : events;
      
      // Calculate metrics
      const opens = filteredEvents.filter(e => e.eventType === 'open').length;
      const clicks = filteredEvents.filter(e => e.eventType === 'click').length;
      const unsubscribes = filteredEvents.filter(e => e.eventType === 'unsubscribe').length;
      
      return {
        totalEvents: filteredEvents.length,
        opens: opens,
        clicks: clicks,
        unsubscribes: unsubscribes,
        clickThroughRate: opens > 0 ? ((clicks / opens) * 100).toFixed(2) + '%' : '0%',
        events: filteredEvents.slice(-50) // Latest 50 events
      };
      
    } catch (error) {
      console.error('Analytics report generation error:', error.message);
      return { error: error.message };
    }
  }
}

module.exports = NewsletterAnalytics;