// src/emailSender.js - Fixed version with better error handling and timeout management
const nodemailer = require('nodemailer');
const axios = require('axios');

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
      // Fix: Use proper FROM email address
      const fromEmail = process.env.EMAIL_FROM && process.env.EMAIL_FROM.includes('@') 
        ? process.env.EMAIL_FROM 
        : process.env.EMAIL_USER;

      this.transporter = nodemailer.createTransporter({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        // Enhanced timeout settings
        connectionTimeout: 30000, // 30 seconds
        greetingTimeout: 30000,
        socketTimeout: 60000, // 60 seconds
        // Additional SMTP settings for Gmail
        tls: {
          rejectUnauthorized: false,
          ciphers: 'SSLv3'
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        rateDelta: 1000,
        rateLimit: 5
      });

      console.log('Email transporter initialized successfully');
      console.log(`From address: ${fromEmail}`);
    } catch (error) {
      console.error('Error initializing email transporter:', error);
      throw error;
    }
  }

  async verifyConnection() {
    try {
      // Add timeout to verification
      const verifyPromise = this.transporter.verify();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection verification timeout')), 15000);
      });
      
      await Promise.race([verifyPromise, timeoutPromise]);
      console.log('Email server connection verified');
      return true;
    } catch (error) {
      console.error('Email server connection failed:', error.message);
      if (error.message.includes('timeout')) {
        console.error('Possible causes: Network issues, firewall blocking SMTP, or Gmail security settings');
      }
      return false;
    }
  }

  // Enhanced newsletter sending with better error handling
  async sendNewsletter(newsletterData) {
    try {
      console.log(`📧 Starting email send for ${newsletterData.segment} newsletter...`);
      
      const subscribers = await this.getSubscribersFromSheet(newsletterData.segment);
      console.log(`📋 Found ${subscribers.length} subscribers for ${newsletterData.segment} segment`);
      
      if (subscribers.length === 0) {
        throw new Error(`No active subscribers found for ${newsletterData.segment} segment`);
      }
      
      let sentCount = 0;
      let failedCount = 0;
      const failedEmails = [];
      
      // Smaller batch size for Railway environment
      const BATCH_SIZE = 5;
      
      for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
        const batch = subscribers.slice(i, i + BATCH_SIZE);
        
        console.log(`📤 Sending batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(subscribers.length/BATCH_SIZE)} (${batch.length} emails)`);
        
        const batchPromises = batch.map(subscriber => 
          this.sendSingleEmailWithRetry(newsletterData, subscriber, 3)
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
        
        // Longer delay for Railway/Gmail rate limiting
        if (i + BATCH_SIZE < subscribers.length) {
          console.log('⏳ Waiting 5s before next batch...');
          await new Promise(resolve => setTimeout(resolve, 5000));
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

  // Enhanced single email with retry logic
  async sendSingleEmailWithRetry(newsletterData, subscriber, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.sendSingleEmail(newsletterData, subscriber);
        return; // Success
      } catch (error) {
        lastError = error;
        console.warn(`Attempt ${attempt}/${maxRetries} failed for ${subscriber.email}: ${error.message}`);
        
        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  // Enhanced fetch with better error handling and timeout
  async getSubscribersFromSheet(segment) {
    console.log(`📊 Fetching ${segment} subscribers from Google Sheets...`);
    
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

  // Enhanced fetch with proper timeout and error handling
  async fetchSubscribersData(url, segment) {
    try {
      // Use axios for better timeout control
      const response = await axios.get(url, {
        timeout: 15000, // 15 second timeout
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'SFP-Newsletter-Bot/1.0'
        }
      });
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const text = response.data;
      let rawData = [];
      
      // Handle JSON response
      if (url.includes('json')) {
        try {
          const jsonText = typeof text === 'string' ? text : JSON.stringify(text);
          const cleanJson = jsonText.substr(47).slice(0, -2);
          const json = JSON.parse(cleanJson);
          rawData = json.table.rows.map(row => row.c.map(cell => cell ? cell.v : ''));
        } catch (e) {
          throw new Error('Failed to parse JSON response: ' + e.message);
        }
      }
      // Handle CSV response
      else if (url.includes('csv')) {
        const lines = text.split('\n');
        rawData = lines.slice(1) // Skip header row
          .filter(line => line.trim())
          .map(line => {
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
      
      return this.filterSubscribers(rawData, segment);
      
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout - check network connectivity');
      }
      throw error;
    }
  }

  // Filter subscribers by segment and active status
  filterSubscribers(rawData, segment) {
    const subscribers = [];
    
    rawData.forEach(row => {
      if (row.length < 4) return; // Skip incomplete rows
      
      const [email, name, subscriberSegment, status, subscribedDate] = row;
      
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

  // Fallback subscriber list
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

  // Enhanced single email with timeout protection
  async sendSingleEmail(newsletterData, subscriber) {
    const issueId = `${newsletterData.segment}-${new Date().toISOString().split('T')[0]}`;
    const unsubscribeToken = this.generateUnsubscribeToken(subscriber.email);
    
    const unsubscribeUrl = `https://safefreightprogram.com/unsubscribe?token=${unsubscribeToken}&email=${encodeURIComponent(subscriber.email)}`;
    const pauseUrl = `https://safefreightprogram.com/pause?token=${unsubscribeToken}&email=${encodeURIComponent(subscriber.email)}`;
    
    let personalizedHtml = newsletterData.html
      .replace(/\{\{ISSUE_ID\}\}/g, issueId)
      .replace(/\{\{TOKEN\}\}/g, unsubscribeToken)
      .replace(/\{\{EMAIL\}\}/g, subscriber.email)
      .replace(/\{\{NAME\}\}/g, subscriber.name || 'Valued Subscriber')
      .replace(/\{\{COMPANY\}\}/g, subscriber.company || '')
      .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubscribeUrl)
      .replace(/\{\{PAUSE_URL\}\}/g, pauseUrl);
    
    const fromEmail = process.env.EMAIL_FROM && process.env.EMAIL_FROM.includes('@') 
      ? process.env.EMAIL_FROM 
      : process.env.EMAIL_USER;

    const mailOptions = {
      from: {
        name: 'Safe Freight Program',
        address: fromEmail
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
    
    // Add timeout wrapper for individual email sending
    const sendPromise = this.transporter.sendMail(mailOptions);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Email send timeout')), 30000); // 30 second timeout
    });
    
    const info = await Promise.race([sendPromise, timeoutPromise]);
    return info;
  }

  htmlToText(html) {
    return String(html || '')
      .replace(/<style[^>]*>.*?<\/style>/gi, '')
      .replace(/<script[^>]*>.*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  generateUnsubscribeToken(email) {
    return Buffer.from(`${email}-${Date.now()}`).toString('base64');
  }

  async testEmailSystem() {
    console.log('🧪 Testing email system...');
    
    try {
      const connectionOk = await this.verifyConnection();
      if (!connectionOk) {
        throw new Error('SMTP connection failed');
      }
      
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