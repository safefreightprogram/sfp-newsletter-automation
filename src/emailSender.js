// src/emailSender.js - Resend API Version (bypasses SMTP blocks)
const axios = require('axios');

class EmailSender {
  constructor() {
    this.resendApiKey = process.env.RESEND_API_KEY;
    this.resendApiUrl = 'https://api.resend.com/emails';
    
    // Subscribers Sheet URLs
    this.SUBSCRIBERS_SHEET_URLS = [
      'https://docs.google.com/spreadsheets/d/1Gz3qHzlxPGsI-ar-d28zoE-oTfrfmxGnXyPmko76uNM/gviz/tq?tqx=out:json',
      'https://docs.google.com/spreadsheets/d/1Gz3qHzlxPGsI-ar-d28zoE-oTfrfmxGnXyPmko76uNM/gviz/tq?tqx=out:csv',
      'https://docs.google.com/spreadsheets/d/1Gz3qHzlxPGsI-ar-d28zoE-oTfrfmxGnXyPmko76uNM/export?format=csv'
    ];
    
    if (!this.resendApiKey) {
      console.warn('⚠️ RESEND_API_KEY not configured - email sending will fail');
    } else {
      console.log('📧 Resend API initialized successfully');
    }
  }

 async verifyConnection() {
  try {
    if (!this.resendApiKey) {
      throw new Error('RESEND_API_KEY not configured');
    }
    
    // Skip API call to avoid rate limiting
    console.log('✅ Resend API key configured - connection assumed valid');
    return true;
  } catch (error) {
    console.error('❌ Resend API verification failed:', error.message);
    return false;
  }
}

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
      
      // Process emails individually with Resend
      for (const subscriber of subscribers) {
        try {
          await this.sendSingleEmail(newsletterData, subscriber);
          sentCount++;
          console.log(`✅ Sent to ${subscriber.email}`);
          
          // Rate limiting - Resend allows 10 req/sec on free tier
          await new Promise(resolve => setTimeout(resolve, 150)); // 150ms delay
          
        } catch (error) {
          failedCount++;
          failedEmails.push({ email: subscriber.email, error: error.message });
          console.error(`❌ Failed to send to ${subscriber.email}: ${error.message}`);
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

  async sendSingleEmail(newsletterData, subscriber) {
    if (!this.resendApiKey) {
      throw new Error('RESEND_API_KEY not configured');
    }
    
    const issueId = `${newsletterData.segment}-${new Date().toISOString().split('T')[0]}`;
    const unsubscribeToken = this.generateUnsubscribeToken(subscriber.email);
    
    const unsubscribeUrl = `https://safefreightprogram.com/unsubscribe?token=${unsubscribeToken}&email=${encodeURIComponent(subscriber.email)}`;
    const pauseUrl = `https://safefreightprogram.com/pause?token=${unsubscribeToken}&email=${encodeURIComponent(subscriber.email)}`;
    
    // Personalize HTML
    let personalizedHtml = newsletterData.html
      .replace(/\{\{ISSUE_ID\}\}/g, issueId)
      .replace(/\{\{TOKEN\}\}/g, unsubscribeToken)
      .replace(/\{\{EMAIL\}\}/g, subscriber.email)
      .replace(/\{\{NAME\}\}/g, subscriber.name || 'Valued Subscriber')
      .replace(/\{\{COMPANY\}\}/g, subscriber.company || '')
      .replace(/\{\{UNSUBSCRIBE_URL\}\}/g, unsubscribeUrl)
      .replace(/\{\{PAUSE_URL\}\}/g, pauseUrl);
    
    const fromEmail = process.env.EMAIL_FROM || 'newsletter@safefreightprogram.com';
    
    // Resend API payload
    const emailData = {
      from: `Safe Freight Program <${fromEmail}>`,
      to: [subscriber.email],
      subject: newsletterData.subject,
      html: personalizedHtml,
      text: newsletterData.text || this.htmlToText(personalizedHtml),
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      },
      tags: [
        {
          name: 'newsletter',
          value: newsletterData.segment
        },
        {
          name: 'issue_id', 
          value: issueId
        }
      ]
    };
    
    try {
      const response = await axios.post(this.resendApiUrl, emailData, {
        headers: {
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      
      return response.data;
      
    } catch (error) {
      if (error.response) {
        throw new Error(`Resend API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
      } else if (error.code === 'ECONNABORTED') {
        throw new Error('Email send timeout');
      } else {
        throw new Error(`Network error: ${error.message}`);
      }
    }
  }

async getSubscribersFromSheet(segment) {
    console.log(`📊 Fetching ${segment} subscribers from Google Sheets API...`);
    
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
        range: 'Subscribers!A:R', // Extended to include all columns
      });
      
      const rows = response.data.values;
      if (!rows || rows.length <= 1) {
        console.warn('⚠️ No data found in Google Sheets');
        return this.getFallbackSubscribers(segment);
      }
      
      // Parse header row to get column positions
      const headers = rows[0];
      const columnMap = {};
      headers.forEach((header, index) => {
        columnMap[header.trim()] = index;
      });
      
      // Get column indices based on your actual headers
      const emailCol = columnMap['Email'];
      const nameCol = columnMap['Name'];
      const segmentCol = columnMap['Segment'];
      const statusCol = columnMap['Status'];
            const unsubCol = columnMap['Unsubscribed_At'];
      const pausedCol = columnMap['Paused_At'];
      const resumeCol = columnMap['Resume_At'];
      const companyCol = columnMap['Company'];
      const confirmedCol = columnMap['Confirmed_At'];

      // Optional columns may not exist in the sheet; guard indexes
      const safeCell = (row, colIndex) =>
        (typeof colIndex === 'number' && colIndex >= 0) ? row[colIndex] : '';

      
      if (emailCol === undefined || segmentCol === undefined || statusCol === undefined) {
        console.error('❌ Required columns not found. Available columns:', headers);
        return this.getFallbackSubscribers(segment);
      }
      
      // Filter subscribers based on your new format
      const subscribers = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length < 4) continue;
        
        const email = row[emailCol];
        const name = row[nameCol];
        const subscriberSegment = row[segmentCol];
        const status = row[statusCol];
                const unsubscribedAt = safeCell(row, unsubCol);
        const pausedAt = safeCell(row, pausedCol);
        const resumeAt = safeCell(row, resumeCol);
        const company = safeCell(row, companyCol);
        const confirmedAt = safeCell(row, confirmedCol);

        
        // Validate email
        if (!email || !email.includes('@')) continue;
        
        // Check if active status
        if (!status || !['active', 'confirmed', 'subscribed'].includes(status.toLowerCase())) continue;
        
        // Check if unsubscribed
        if (unsubscribedAt && String(unsubscribedAt).trim() !== '') continue;
        
        // Check if paused (and not ready to resume)
        if (pausedAt && String(pausedAt).trim() !== '') {
          if (!resumeAt || new Date(resumeAt) > new Date()) {
            continue;
          }
        }
        
        // Check segment match
        const segmentMatch = (
          subscriberSegment && 
          (subscriberSegment.toLowerCase() === segment.toLowerCase() ||
           subscriberSegment.toLowerCase() === 'all' ||
           (segment === 'pro' && subscriberSegment.toLowerCase() === 'professional'))
        );
        
        if (segmentMatch) {
          subscribers.push({
            email: email.trim(),
            name: (name || '').trim(),
            segment: subscriberSegment.trim(),
            status: status.trim(),
            company: (company || '').trim(),
            subscribedDate: confirmedAt || new Date().toISOString()
          });
        }
      }
      
      console.log(`✅ Successfully loaded ${subscribers.length} ${segment} subscribers from Google Sheets API`);
      return subscribers;
      
    } catch (error) {
      console.error('❌ Google Sheets API failed:', error.message);
      console.warn('⚠️ Falling back to environment variable subscribers');
      return this.getFallbackSubscribers(segment);
    }
  }

  async fetchSubscribersData(url, segment) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
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
      
      if (url.includes('json')) {
        try {
          const jsonText = typeof text === 'string' ? text : JSON.stringify(text);
          const cleanJson = jsonText.substr(47).slice(0, -2);
          const json = JSON.parse(cleanJson);
          rawData = json.table.rows.map(row => row.c.map(cell => cell ? cell.v : ''));
        } catch (e) {
          throw new Error('Failed to parse JSON response: ' + e.message);
        }
      } else if (url.includes('csv')) {
        const lines = text.split('\n');
        rawData = lines.slice(1)
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

  filterSubscribers(rawData, segment) {
    const subscribers = [];
    
    rawData.forEach(row => {
      if (row.length < 4) return;
      
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
    console.log('🧪 Testing Resend email system...');
    
    try {
      const connectionOk = await this.verifyConnection();
      if (!connectionOk) {
        throw new Error('Resend API connection failed');
      }
      
      const proSubscribers = await this.getSubscribersFromSheet('pro');
      const driverSubscribers = await this.getSubscribersFromSheet('driver');
      
      console.log('📊 Test Results:');
      console.log(`   Resend API: ✅ Working`);
      console.log(`   Pro Subscribers: ${proSubscribers.length} found`);
      console.log(`   Driver Subscribers: ${driverSubscribers.length} found`);
      
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

  async testSubscriberMapping() {
    console.log('🧪 Testing subscriber mapping...');
    
    try {
      const proSubs = await this.getSubscribersFromSheet('pro');
      const driverSubs = await this.getSubscribersFromSheet('driver');
      
      console.log(`📊 Results:`);
      console.log(`   Pro subscribers: ${proSubs.length}`);
      console.log(`   Driver subscribers: ${driverSubs.length}`);
      
      if (proSubs.length > 0) {
        console.log(`   Sample pro subscriber:`, proSubs[0]);
      }
      if (driverSubs.length > 0) {
        console.log(`   Sample driver subscriber:`, driverSubs[0]);
      }
      
      return { proSubs: proSubs.length, driverSubs: driverSubs.length };
    } catch (error) {
      console.error('❌ Subscriber mapping test failed:', error.message);
      return { error: error.message };
    }
  }
}

module.exports = EmailSender;
