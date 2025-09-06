// src/scheduler.js - Newsletter Automation Cron Jobs
const cron = require('node-cron');
const { exec } = require('child_process');
const winston = require('winston');

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'newsletter-automation.log' })
  ]
});

// Newsletter Automation Schedule
class NewsletterScheduler {
  constructor() {
    this.setupCronJobs();
  }

  setupCronJobs() {
    // Daily content scraping - 6:00 AM AEST
    cron.schedule('0 6 * * *', () => {
      this.runScraping();
    }, {
      scheduled: true,
      timezone: "Australia/Sydney"
    });

    // Weekly newsletter generation - Monday 8:00 AM AEST  
    cron.schedule('0 8 * * 1', () => {
      this.runGeneration();
    }, {
      scheduled: true,
      timezone: "Australia/Sydney"
    });

    // Monthly comprehensive newsletter - First Monday 9:00 AM AEST
    cron.schedule('0 9 1-7 * 1', () => {
      this.runMonthlyGeneration();
    }, {
      scheduled: true,
      timezone: "Australia/Sydney"
    });

    logger.info('Newsletter automation cron jobs scheduled');
  }

  runScraping() {
    logger.info('Starting automated content scraping...');
    
    exec('npm run scrape', (error, stdout, stderr) => {
      if (error) {
        logger.error(`Scraping failed: ${error.message}`);
        this.sendAlert('Scraping Failed', error.message);
        return;
      }
      
      if (stderr) {
        logger.warn(`Scraping warnings: ${stderr}`);
      }
      
      logger.info(`Scraping completed successfully: ${stdout}`);
    });
  }

  runGeneration() {
    logger.info('Starting automated newsletter generation...');
    
    exec('npm run generate', (error, stdout, stderr) => {
      if (error) {
        logger.error(`Generation failed: ${error.message}`);
        this.sendAlert('Newsletter Generation Failed', error.message);
        return;
      }
      
      if (stderr) {
        logger.warn(`Generation warnings: ${stderr}`);
      }
      
      logger.info(`Newsletter generation completed: ${stdout}`);
    });
  }

  runMonthlyGeneration() {
    logger.info('Starting monthly comprehensive newsletter...');
    
    // Run with monthly flag for comprehensive content
    exec('npm run generate -- --monthly', (error, stdout, stderr) => {
      if (error) {
        logger.error(`Monthly generation failed: ${error.message}`);
        return;
      }
      
      logger.info(`Monthly newsletter completed: ${stdout}`);
    });
  }

  sendAlert(subject, message) {
    // Send notification for failed automation
    logger.error(`ALERT: ${subject} - ${message}`);
    
    // You could integrate with email/SMS alerts here
    // Example: Send email notification to admin
  }

  // Manual trigger methods for testing
  triggerScraping() {
    logger.info('Manual scraping triggered');
    this.runScraping();
  }

  triggerGeneration() {
    logger.info('Manual generation triggered');
    this.runGeneration();
  }

  // Get next scheduled times
  getSchedule() {
    return {
      dailyScraping: '6:00 AM AEST daily',
      weeklyNewsletter: 'Monday 8:00 AM AEST',
      monthlyNewsletter: 'First Monday 9:00 AM AEST',
      timezone: 'Australia/Sydney'
    };
  }
}

module.exports = NewsletterScheduler;