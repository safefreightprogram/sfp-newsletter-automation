// src/emailSender.js - Updated with Subscribers Sheet integration
const nodemailer = require('nodemailer');

class EmailSender {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
    
    // Subscribers Sheet URL for fetching subscriber data
    this.SUBSCRIBERS_SHEET_URLS = [
      'https://docs.google.com/spreadsheets/d/1Gz3qHzlxPGsI-ar-d28zoE-oTfrfmxGnXyPmko76uNM/gviz/tq?tqx=out:json',
      'https://docs.google.com/spreadsheets/d/1Gz3qHzlxPGsI-ar-d28zoE-oTfrfmxGnXyPmko76uNM/gviz/tq?tqx=out:csv',
      'https://docs.google.com/spreadsheets/d/1Gz3qHzlxPGsI-ar-d28zoE-oTfrfmxGnXyPmko76uNM/export?format=csv'
    ];
  }

  initializeTransporter() {
    try {
      this.transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        tls: {
          rejectUnauthorized: false
        }
      });

      console.log('Email transporter initialized successfully');
    } catch (error) {
      console.error('Error initializing email transporter:', error);
      throw error;
    }
  }

  async verifyConnection() {
    try {
      await this.transporter.verify();
      console.log('Email server connection verified');
      return true;
    } catch (error) {
      console.error('Email server connection failed:', error);
      return false;
    }
  }

  // Main newsletter sending function - updated to use Subscribers Sheet
  async sendNewsletter(newsletterData) {
    try {
      console.log(`📧 Starting email send for ${newsletterData.segment} newsletter...`);
      
      // Get subscribers for this specific segment from Google Sheets
      const subscribers = await this.getSubscribersFromSheet(newsletterData.segment);
      console.log(`📋 Found ${subscribers.length} subscribers for ${newsletterData.segment} segment`);
      
      if (subscribers.length === 0) {
        throw new Error(`No active subscribers found for ${newsletterData.segment} segment`);
      }
      
      let sentCount = 0;
      let failedCount = 0;
      const failedEmails = [];
      
      // Send in batches to avoid rate limits
      const BATCH_SIZE = 10;
      for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
        const batch = subscribers.slice(i, i + BATCH_SIZE);
        
        console.log(`📤 Sending batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(subscribers.length/BATCH_SIZE)} (${batch.length} emails)`);
        
        const batchPromises = batch.map(subscriber => 
          this.sendSingleEmail(newsletterData, subscriber)
            .then(() => {
              sentCount++;
              console.log(`✅ Sent to ${subscriber.email}`);
            })
            .catch(error => {
              failedCount++;
              failedEmails.push({ email: subscriber.email, error: error.message });
              console.error(`❌ Failed to send to ${subscriber.email}: ${error.message}`);
            })
        );
        
        await Promise.allSettled(batchPromises);
        
        // Delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < subscribers.length) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }
      }
      
      console.log(`📊 Email sending complete: ${sentCount} sent, ${failedCount} failed`);
      
      return {
        success: true,
        sentCount,
        failedCount,
        failedEmails,
        totalSubscribers: subscribers.length
      };
      
    } catch (error) {
      console.error('📧 Email sending failed:', error.message);
      throw error;
    }
  }

  // Fetch subscribers from Google Sheets with filtering by segment
  async getSubscribersFromSheet(segment) {
    console.log(`📊 Fetching ${segment} subscribers from Google Sheets...`);
    
    // Try multiple URLs in case one fails
    for (const url of this.SUBSCRIBERS_SHEET_URLS) {
      try {
        console.log(`🔗 Trying URL: ${url.substring(0, 80)}...`);
        const subscribers = await this.fetchSubscribersData(url, segment);
        
        if (subscribers && subscribers.length > 0) {
          console.log(`✅ Successfully loaded ${subscribers.length} ${segment} subscribers`);
          return subscribers;
        }
      } catch (error) {
        console.error(`❌ Failed to fetch from ${url}:`, error.message);
        continue;
      }
    }
    
    // Fallback to environment variable if Google Sheets fails
    console.warn('⚠️ Google Sheets failed, using environment variable fallback');
    return this.getFallbackSubscribers(segment);
  }

  // Fetch and parse subscriber data from Google Sheets
  async fetchSubscribersData(url, segment) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const text = await response.text();
    let rawData = [];
    
    // Handle JSON response
    if (url.includes('json')) {
      try {
        const json = JSON.parse(text.substr(47).slice(0, -2));
        rawData = json.table.rows.map(row => row.c.map(cell => cell ? cell.v : ''));
      } catch (e) {
        throw new Error('Failed to parse JSON response');
      }
    }
    // Handle CSV response
    else if (url.includes('csv')) {
      const lines = text.split('\n');
      rawData = lines.slice(1) // Skip header row
        .filter(line => line.trim())
        .map(line => {
          // Simple CSV parsing - handles quoted fields
          const result = [];
          let current = '';
          let inQuotes = false;
          
          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              result.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          result.push(current.trim());
          return result;
        });
    }
    
    // Filter and format subscriber data
    return this.filterSubscribers(rawData, segment);
  }

  // Filter subscribers by segment and active status
  filterSubscribers(rawData, segment) {
    const subscribers = [];
    
    // Expected columns: Email, Name, Segment, Status, Subscribed Date
    rawData.forEach(row => {
      if (row.length < 4) return; // Skip incomplete rows
      
      const [email, name, subscriberSegment, status, subscribedDate] = row;
      
      // Filter criteria:
      // 1. Must have valid email
      // 2. Must match requested segment (pro/driver)
      // 3. Must have "Active" status
      // 4. Must not be empty/placeholder data
      
      if (email && 
          email.includes('@') && 
          subscriberSegment && 
          subscriberSegment.toLowerCase() === segment.toLowerCase() &&
          status && 
          status.toLowerCase() === 'active') {
        
        subscribers.push({
          email: email.trim(),
          name: (name || '').trim(),
          segment: subscriberSegment.trim(),
          status: status.trim(),
          subscribedDate: subscribedDate || new Date().toISOString()
        });
      }
    });
    
    console.log(`📊 Filtered ${subscribers.length} active ${segment} subscribers from ${rawData.length} total rows`);
    
    return subscribers;
  }

  // Fallback subscriber list if Google Sheets is unavailable
  getFallbackSubscribers(segment) {
    const fallbackEmail = process.env.NEWSLETTER_RECIPIENTS;
    if (!fallbackEmail) {
      return [];
    }
    
    const emails = fallbackEmail.split(',').map(email => email.trim()).filter(Boolean);
    
    return emails.map(email => ({
      email,
      name: 'Test Subscriber',
      segment: segment,
      status: 'active',
      subscribedDate: new Date().toISOString()
    }));
  }

  // Send individual email with personalization and proper unsubscribe tokens
  async sendSingleEmail(newsletterData, subscriber) {
    const issueId = `${newsletterData.segment}-${new Date().toISOString().split('T')[0]}`;
    
    // Use the subscriber's existing unsubscribe token from the database
    const unsubscribeToken = subscriber.unsubToken || this.generateUnsubscribeToken(subscriber.email);
    
    // Create unsubscribe URLs using the existing token system
    const unsubscribeUrl = `https://safefreightprogram.com/unsubscribe?token=${unsubscribeToken}&email=${encodeURIComponent(subscriber.email)}`;
    const pauseUrl = `https://safefreightprogram.com/pause?token=${unsubscribeToken}&email=${encodeURIComponent(subscriber.email)}`;
    
    // Replace placeholders in HTML
    let personalizedHtml = newsletterData.html
      .replace(/\{\{ISSUE_ID\}\}/g, issueId)
      .replace(/\{\{TOKEN\}\}/g, unsubscribeToken)
      .replace(/\{\{EMAIL\}\}/g, subscriber.email)
      .replace(/\{\{NAME\}\}/g, subscriber.name || 'Valued Subscriber')
      .replace(/\{\{COMPANY\}\}/g, subscriber.company || '')
      .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubscribeUrl)
      .replace(/\{\{PAUSE_URL\}\}/g, pauseUrl);
    
    // Email configuration with anti-spam headers and proper unsubscribe links
    const mailOptions = {
      from: {
        name: 'Safe Freight Program',
        address: process.env.EMAIL_FROM || process.env.EMAIL_USER
      },
      to: subscriber.email,
      subject: newsletterData.subject,
      html: personalizedHtml,
      text: newsletterData.text || this.htmlToText(personalizedHtml),
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@safefreightprogram.com?subject=Unsubscribe&body=Token: ${unsubscribeToken}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'List-ID': `${newsletterData.segment}-newsletter.safefreightprogram.com`,
        'X-Mailer': 'SFP Newsletter System',
        'Precedence': 'bulk',
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Reply-To': 'noreply@safefreightprogram.com',
        'X-Subscriber-ID': subscriber.id || '',
        'X-Newsletter-Segment': newsletterData.segment
      }
    };
    
    const info = await this.transporter.sendMail(mailOptions);
    return info;
  }

  // Convert HTML to plain text for email fallback
  htmlToText(html) {
    return html
      .replace(/<style[^>]*>.*?<\/style>/gi, '') // Remove style blocks
      .replace(/<script[^>]*>.*?<\/script>/gi, '') // Remove script blocks
      .replace(/<[^>]+>/g, '') // Remove all HTML tags
      .replace(/&nbsp;/g, ' ') // Replace non-breaking spaces
      .replace(/&amp;/g, '&') // Replace HTML entities
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .trim();
  }

  // Generate unsubscribe token (simple implementation)
  generateUnsubscribeToken(email) {
    return Buffer.from(`${email}-${Date.now()}`).toString('base64');
  }

  // Test email functionality with subscriber data preview
  async testEmailSystem() {
    console.log('🧪 Testing email system...');
    
    try {
      // Test SMTP connection
      const connectionOk = await this.verifyConnection();
      if (!connectionOk) {
        throw new Error('SMTP connection failed');
      }
      
      // Test subscriber data fetch for both segments
      const proSubscribers = await this.getSubscribersFromSheet('pro');
      const driverSubscribers = await this.getSubscribersFromSheet('driver');
      
      console.log('📊 Test Results:');
      console.log(`   SMTP Connection: ✅ Working`);
      console.log(`   Pro Subscribers: ${proSubscribers.length} found`);
      console.log(`   Driver Subscribers: ${driverSubscribers.length} found`);
      
      if (proSubscribers.length > 0) {
        console.log(`   Sample Pro Subscriber: ${proSubscribers[0].email}`);
      }
      if (driverSubscribers.length > 0) {
        console.log(`   Sample Driver Subscriber: ${driverSubscribers[0].email}`);
      }
      
      return {
        smtpWorking: true,
        proSubscribers: proSubscribers.length,
        driverSubscribers: driverSubscribers.length,
        totalSubscribers: proSubscribers.length + driverSubscribers.length
      };
      
    } catch (error) {
      console.error('🧪 Test failed:', error.message);
      return {
        smtpWorking: false,
        error: error.message,
        proSubscribers: 0,
        driverSubscribers: 0,
        totalSubscribers: 0
      };
    }
  }
}

module.exports = EmailSender;