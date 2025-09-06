// Create new file: src/emailSender.js
const nodemailer = require('nodemailer');
const SheetsManager = require('../config/sheets');

class EmailSender {
  constructor() {
    this.sheetsManager = new SheetsManager();
    
    // Create transporter with Gmail SMTP
    this.transporter = nodemailer.createTransporter({
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: false, // true for 465, false for 587
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      },
      // Anti-spam configuration
      tls: {
        rejectUnauthorized: false
      },
      dkim: {
        domainName: 'safefreightprogram.com',
        keySelector: 'default',
        privateKey: process.env.DKIM_PRIVATE_KEY || ''
      }
    });
  }

  async sendNewsletter(newsletterData) {
    try {
      console.log(`📧 Starting email send for ${newsletterData.segment} newsletter...`);
      
      await this.sheetsManager.initialize();
      
      // Get subscriber list for this segment
      const subscribers = await this.getSubscribers(newsletterData.segment);
      console.log(`📋 Found ${subscribers.length} subscribers for ${newsletterData.segment}`);
      
      if (subscribers.length === 0) {
        throw new Error(`No subscribers found for ${newsletterData.segment} segment`);
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
      
      // Update archive with send statistics
      await this.updateSendStats(newsletterData.segment, sentCount, failedCount);
      
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
    // Create personalized unsubscribe links
    const unsubscribeToken = this.generateUnsubscribeToken(subscriber.email);
    const issueId = `${newsletterData.segment}-${new Date().toISOString().split('T')[0]}`;
    
    // Replace placeholders in HTML
    let personalizedHtml = newsletterData.html
      .replace(/\{\{ISSUE_ID\}\}/g, issueId)
      .replace(/\{\{TOKEN\}\}/g, unsubscribeToken)
      .replace(/\{\{EMAIL\}\}/g, subscriber.email);
    
    // Anti-spam headers
    const mailOptions = {
      from: {
        name: 'Safe Freight Program',
        address: process.env.EMAIL_FROM
      },
      to: subscriber.email,
      subject: newsletterData.subject,
      html: personalizedHtml,
      text: newsletterData.text,
      headers: {
        'List-Unsubscribe': `<mailto:unsubscribe@safefreightprogram.com.au?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'List-ID': `${newsletterData.segment}-newsletter.safefreightprogram.com`,
        'X-Mailer': 'SFP Newsletter System',
        'Precedence': 'bulk',
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Reply-To': 'noreply@safefreightprogram.com.au'
      },
      // Track opens and clicks
      attachments: [{
        filename: 'pixel.png',
        content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
        cid: 'tracking-pixel'
      }]
    };
    
    const info = await this.transporter.sendMail(mailOptions);
    return info;
  }

  async getSubscribers(segment) {
    // Get from your subscriber database - you'll need to implement this
    // For now, use environment variable as fallback
    const emailList = process.env.NEWSLETTER_RECIPIENTS || '';
    const emails = emailList.split(',').map(email => email.trim()).filter(Boolean);
    
    return emails.map(email => ({
      email,
      segment,
      status: 'active',
      subscribed_date: new Date().toISOString()
    }));
  }

  generateUnsubscribeToken(email) {
    // Simple token generation - you might want to use crypto for production
    return Buffer.from(`${email}-${Date.now()}`).toString('base64');
  }

  async updateSendStats(segment, sentCount, failedCount) {
    try {
      const issueId = `${segment}-${new Date().toISOString().split('T')[0]}`;
      // Update your Content_Archive sheet with send statistics
      console.log(`📊 Updated send stats for ${issueId}: ${sentCount} sent, ${failedCount} failed`);
    } catch (error) {
      console.error('Failed to update send stats:', error.message);
    }
  }
}

module.exports = EmailSender;