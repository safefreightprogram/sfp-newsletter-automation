const cron = require('node-cron');

// Advanced Scheduling System for Newsletter Automation
// Supports weekly/fortnightly/monthly schedules with scraping dependencies

const fs = require('fs');
const path = require('path');

// Persistent schedule config — survives Railway restarts when using a volume,
// or falls back to defaults if the file doesn't exist yet.
// Railway's /app/src is read-only; /tmp is writable and persists within a deployment
// For true persistence across restarts, we also write to a known fallback location
const SCHEDULE_CONFIG_PATH = process.env.SCHEDULE_CONFIG_PATH || 
  (require('fs').existsSync('/tmp') ? '/tmp/schedule-config.json' : path.join(__dirname, 'schedule-config.json'));

const DEFAULT_SCHEDULE_CONFIG = {
  scraping: {
    enabled: true,
    frequency: 'weekly',
    dayOfWeek: 1,      // Monday
    hour: 16,
    minute: 45,
    weekOfMonth: null,
    lastRun: null
  },
  newsletter: {
    enabled: true,
    frequency: 'weekly',
    dayOfWeek: 1,
    hour: 17,
    minute: 30,
    weekOfMonth: null,
    dependsOn: 'scraping',
    delayAfterDependency: 45,
    lastRun: null
  }
};

function loadScheduleConfig() {
  try {
    if (fs.existsSync(SCHEDULE_CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SCHEDULE_CONFIG_PATH, 'utf8'));
      console.log('📅 Loaded persisted schedule config from:', SCHEDULE_CONFIG_PATH);
      // Merge with defaults to pick up any new fields added in code
      return {
        scraping:   { ...DEFAULT_SCHEDULE_CONFIG.scraping,   ...saved.scraping },
        newsletter: { ...DEFAULT_SCHEDULE_CONFIG.newsletter, ...saved.newsletter }
      };
    }
  } catch (e) {
    console.warn('⚠️ Could not load schedule-config.json, using defaults:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE_CONFIG));
}

function saveScheduleConfig(config) {
  try {
    // Don't persist lastRun here — that's tracked by Events_Log
    const toSave = {
      scraping: { ...config.scraping, lastRun: undefined },
      newsletter: { ...config.newsletter, lastRun: undefined }
    };
    fs.writeFileSync(SCHEDULE_CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
    console.log('💾 Schedule config saved to:', SCHEDULE_CONFIG_PATH);
  } catch (e) {
    console.warn('⚠️ Could not save schedule-config.json:', e.message);
  }
}

class AdvancedScheduler {
  constructor() {
    this.activeJobs = new Map();
    this.scheduleConfig = loadScheduleConfig();
    this.cronJobs = new Map();
    this.dependencies = new Map();
  }

  // Initialize the scheduling system
  initialize() {
    console.log('🔄 Initializing advanced scheduling system...');
    this.startAllSchedules();
  }

  // Update schedule configuration
  updateSchedule(jobType, config) {
    if (!this.scheduleConfig[jobType]) {
      throw new Error(`Unknown job type: ${jobType}`);
    }

    // Validate configuration
    this.validateScheduleConfig(config);
    
    // Update configuration
    this.scheduleConfig[jobType] = { ...this.scheduleConfig[jobType], ...config };
    
    // Persist immediately so the change survives Railway restarts
    saveScheduleConfig(this.scheduleConfig);
    
    // Restart the specific job with new schedule
    this.restartJob(jobType);
    
    console.log(`✅ Updated ${jobType} schedule:`, this.scheduleConfig[jobType]);
    return this.scheduleConfig[jobType];
  }

  validateScheduleConfig(config) {
    if (config.frequency && !['daily', 'weekly', 'fortnightly', 'monthly'].includes(config.frequency)) {
      throw new Error('Frequency must be daily, weekly, fortnightly, or monthly');
    }
    
    if (config.dayOfWeek !== undefined && (config.dayOfWeek < 0 || config.dayOfWeek > 6)) {
      throw new Error('Day of week must be 0-6 (Sunday=0)');
    }
    
    if (config.hour !== undefined && (config.hour < 0 || config.hour > 23)) {
      throw new Error('Hour must be 0-23');
    }
    
    if (config.minute !== undefined && (config.minute < 0 || config.minute > 59)) {
      throw new Error('Minute must be 0-59');
    }
    
    if (config.weekOfMonth && (config.weekOfMonth < 1 || config.weekOfMonth > 4)) {
      throw new Error('Week of month must be 1-4');
    }
  }

  // Start all scheduled jobs
  startAllSchedules() {
    this.stopAllJobs();
    
    for (const [jobType, config] of Object.entries(this.scheduleConfig)) {
      if (config.enabled) {
        this.createCronJob(jobType, config);
      }
    }
  }

  // Create cron job for specific schedule
  createCronJob(jobType, config) {
    const cronExpression = this.generateCronExpression(config);
    
    console.log(`📅 Scheduling ${jobType}: ${this.describeFriendlySchedule(config)} (cron: ${cronExpression})`);
    
    const cronJob = cron.schedule(cronExpression, async () => {
      await this.executeJob(jobType, config);
    }, {
      scheduled: true,
      timezone: "Australia/Sydney"
    });
    
    this.cronJobs.set(jobType, cronJob);
  }

  // Generate cron expression from config
  generateCronExpression(config) {
    const { frequency, dayOfWeek, hour, minute, weekOfMonth } = config;
    
    switch (frequency) {
      case 'daily':
        return `${minute} ${hour} * * *`;

      case 'weekly':
        return `${minute} ${hour} * * ${dayOfWeek}`;
        
      case 'fortnightly':
        // Use day-of-month calculation for fortnightly (approximate)
        // This runs on weeks 1 and 3, or 2 and 4 of each month
        const weekPattern = weekOfMonth || 1; // Default to weeks 1,3
        const dayOfMonthPattern = weekPattern === 1 ? '1-7,15-21' : '8-14,22-28';
        return `${minute} ${hour} ${dayOfMonthPattern} * ${dayOfWeek}`;
        
      case 'monthly':
        // Run on specific week of the month
        const weekNum = weekOfMonth || 1;
        const startDay = (weekNum - 1) * 7 + 1;
        const endDay = weekNum * 7;
        return `${minute} ${hour} ${startDay}-${endDay} * ${dayOfWeek}`;
        
      default:
        throw new Error(`Unsupported frequency: ${frequency}`);
    }
  }

  // Execute job with dependency checking
  async executeJob(jobType, config) {
    console.log(`🚀 Starting ${jobType} job...`);
    
    // Check dependencies
    if (config.dependsOn) {
      const dependencyMet = await this.checkDependency(config.dependsOn, config.delayAfterDependency);
      if (!dependencyMet) {
        console.log(`⏸️ ${jobType} delayed - waiting for ${config.dependsOn} to complete`);
        return;
      }
    }
    
    // Check frequency constraints (for fortnightly/monthly)
    if (!this.shouldRunNow(jobType, config)) {
      console.log(`⏭️ ${jobType} skipped - frequency constraint not met`);
      return;
    }
    
    try {
      // Execute the actual job
      await this.runJobFunction(jobType);
      
      // Mark completion for dependency tracking
      this.markJobComplete(jobType);
      this.scheduleConfig[jobType].lastRun = new Date();
      
      // Log to Events_Log and update in-memory systemState if callback registered
      if (typeof this.onJobComplete === 'function') {
        await this.onJobComplete(jobType).catch(e => console.warn('onJobComplete callback error:', e.message));
      }
      
      console.log(`✅ ${jobType} completed successfully`);
      
    } catch (error) {
      console.error(`❌ ${jobType} failed:`, error.message);
      // Could add retry logic here
    }
  }

  // Check if dependency is satisfied
  async checkDependency(dependsOn, delayMinutes = 0) {
    const dependency = this.dependencies.get(dependsOn);
    
    if (!dependency) {
      console.log(`⚠️ Dependency ${dependsOn} never run - proceeding anyway`);
      return true;
    }
    
    const requiredTime = new Date(dependency.completedAt.getTime() + (delayMinutes * 60000));
    const now = new Date();
    
    if (now >= requiredTime) {
      console.log(`✅ Dependency ${dependsOn} satisfied (completed ${delayMinutes}+ min ago)`);
      return true;
    }
    
    const waitMinutes = Math.ceil((requiredTime - now) / 60000);
    console.log(`⏳ Dependency ${dependsOn} not ready - need to wait ${waitMinutes} more minutes`);
    return false;
  }

  // Check frequency constraints for fortnightly/monthly jobs
  shouldRunNow(jobType, config) {
    if (config.frequency === 'weekly') {
      return true; // Weekly jobs always run when scheduled
    }
    
    const lastRun = config.lastRun;
    if (!lastRun) {
      return true; // First run
    }
    
    const now = new Date();
    const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
    
    switch (config.frequency) {
      case 'fortnightly':
        return daysSinceLastRun >= 13; // Allow slight tolerance
        
      case 'monthly':
        return daysSinceLastRun >= 27; // Allow slight tolerance
        
      default:
        return true;
    }
  }

  // Execute the actual job function
async runJobFunction(jobType) {
  switch (jobType) {
    case 'scraping':
      const { scrapeAllSources } = require('./scraper');
      const results = await scrapeAllSources();
      
      // Fix: Handle the correct response format
      const articles = results.articles || results || [];
      console.log(`📊 Scraping completed: ${articles.length} articles found`);
      
      // Save to Google Sheets if articles found
      if (articles.length > 0) {
        try {
          const SheetsManager = require('../config/sheets');
          const sheetsManager = new SheetsManager();
          await sheetsManager.initialize();
          await sheetsManager.saveArticles(articles);
          console.log(`💾 Articles saved to Google Sheets`);
        } catch (error) {
          console.error('⚠️ Failed to save to sheets:', error.message);
        }
      }
      break;
      
    case 'newsletter':
      const NewsletterGenerator = require('./generator');
      const generator = new NewsletterGenerator();
      
      try {
        // Generate both newsletters with error handling
        console.log('📧 Generating COR Intel Weekly...');
        await generator.generateNewsletter('pro', true);
        
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay
        
        console.log('📧 Generating Safe Freight Mate...');
        await generator.generateNewsletter('driver', true);
        
        console.log('✅ All newsletters sent successfully');
      } catch (error) {
        console.error('❌ Newsletter generation failed:', error.message);
        throw error; // Re-throw to trigger job failure handling
      }
      break;
      
    default:
      throw new Error(`Unknown job type: ${jobType}`);
  }
}

  // Mark job as complete for dependency tracking
  markJobComplete(jobType) {
    this.dependencies.set(jobType, {
      completedAt: new Date(),
      success: true
    });
  }

  // Restart specific job
  restartJob(jobType) {
    // Stop existing job
    if (this.cronJobs.has(jobType)) {
      this.cronJobs.get(jobType).stop();
      this.cronJobs.delete(jobType);
    }
    
    // Start new job if enabled
    const config = this.scheduleConfig[jobType];
    if (config.enabled) {
      this.createCronJob(jobType, config);
    }
  }

  // Stop all jobs
  stopAllJobs() {
    for (const [jobType, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();
  }

  // Get human-friendly schedule description
  describeFriendlySchedule(config) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[config.dayOfWeek];
    const time = `${config.hour.toString().padStart(2, '0')}:${config.minute.toString().padStart(2, '0')}`;
    
    switch (config.frequency) {
      case 'daily':
        return `Every day at ${time} AEST`;

      case 'weekly':
        return `Every ${dayName} at ${time} AEST`;
        
      case 'fortnightly':
        return `Every second ${dayName} at ${time} AEST`;
        
      case 'monthly':
        const weekNum = config.weekOfMonth || 1;
        const weekNames = ['', 'first', 'second', 'third', 'fourth'];
        return `${weekNames[weekNum]} ${dayName} of each month at ${time} AEST`;
        
      default:
        return `${config.frequency} at ${time} AEST`;
    }
  }

  // Get next run times
  getNextRunTimes() {
    const nextRuns = {};
    
    for (const [jobType, config] of Object.entries(this.scheduleConfig)) {
      if (config.enabled) {
        nextRuns[jobType] = this.calculateNextRun(config);
      } else {
        nextRuns[jobType] = 'Disabled';
      }
    }
    
    return nextRuns;
  }

  calculateNextRun(config) {
    // This is a simplified calculation - you might want to use a library like later.js for complex schedules
    const now = new Date();
    const next = new Date();
    
    // Set to next occurrence of day/time
    next.setHours(config.hour, config.minute, 0, 0);
    
    // Adjust day of week
    const daysUntilTarget = (config.dayOfWeek + 7 - next.getDay()) % 7;
    if (daysUntilTarget === 0 && next <= now) {
      next.setDate(next.getDate() + 7); // Next week
    } else {
      next.setDate(next.getDate() + daysUntilTarget);
    }
    
    // Apply frequency constraints
    if (config.frequency === 'fortnightly' && config.lastRun) {
      const daysSinceLastRun = (next - config.lastRun) / (1000 * 60 * 60 * 24);
      if (daysSinceLastRun < 13) {
        next.setDate(next.getDate() + 7); // Add another week
      }
    }
    
    return next.toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  // Get current configuration
  getConfiguration() {
    return {
      schedules: this.scheduleConfig,
      nextRuns: this.getNextRunTimes(),
      activeJobs: Array.from(this.cronJobs.keys()),
      dependencies: Object.fromEntries(this.dependencies)
    };
  }

  // Manual job trigger (for testing)
  async triggerJob(jobType) {
    console.log(`🔧 Manually triggering ${jobType}...`);
    const config = this.scheduleConfig[jobType];
    if (!config) {
      throw new Error(`Unknown job type: ${jobType}`);
    }
    
    await this.executeJob(jobType, config);
  }
}

// API endpoints for the advanced scheduler
function setupAdvancedSchedulingEndpoints(app, scheduler) {
  
  // Get current schedule configuration
  app.get('/api/schedule/advanced', (req, res) => {
    try {
      res.json({
        success: true,
        data: scheduler.getConfiguration()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Update schedule for specific job
  app.put('/api/schedule/:jobType', async (req, res) => {
    try {
      const { jobType } = req.params;
      const config = req.body;
      
      const updatedConfig = scheduler.updateSchedule(jobType, config);
      
      res.json({
        success: true,
        message: `${jobType} schedule updated successfully`,
        data: {
          schedule: updatedConfig,
          nextRun: scheduler.calculateNextRun(updatedConfig),
          description: scheduler.describeFriendlySchedule(updatedConfig)
        }
      });
      
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  // Manual job trigger
  app.post('/api/schedule/trigger/:jobType', async (req, res) => {
    try {
      const { jobType } = req.params;
      
      // Run job asynchronously
      scheduler.triggerJob(jobType).catch(error => {
        console.error(`Manual ${jobType} trigger failed:`, error.message);
      });
      
      res.json({
        success: true,
        message: `${jobType} job triggered manually`,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  // Enable/disable jobs
  app.post('/api/schedule/:jobType/:action', async (req, res) => {
    try {
      const { jobType, action } = req.params;
      
      if (!['enable', 'disable'].includes(action)) {
        return res.status(400).json({
          success: false,
          error: 'Action must be enable or disable'
        });
      }
      
      const enabled = action === 'enable';
      const updatedConfig = scheduler.updateSchedule(jobType, { enabled });
      
      res.json({
        success: true,
        message: `${jobType} ${action}d successfully`,
        data: updatedConfig
      });
      
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

// Get job status and dependencies
app.get('/api/schedule/status', (req, res) => {
  try {
    const config = scheduler.getConfiguration();
    const status = {
      scraping: {
        // Frontend needs these exact fields
        enabled: config.schedules.scraping.enabled,
        frequency: config.schedules.scraping.frequency,
        dayOfWeek: config.schedules.scraping.dayOfWeek,
        hour: config.schedules.scraping.hour,
        minute: config.schedules.scraping.minute,
        weekOfMonth: config.schedules.scraping.weekOfMonth,
        // Display fields
        nextRun: config.nextRuns.scraping,
        lastRun: config.schedules.scraping.lastRun,
        schedule: scheduler.describeFriendlySchedule(config.schedules.scraping),
        status: config.schedules.scraping.enabled ? 'active' : 'disabled'
      },
      newsletter: {
        // Frontend needs these exact fields
        enabled: config.schedules.newsletter.enabled,
        frequency: config.schedules.newsletter.frequency,
        dayOfWeek: config.schedules.newsletter.dayOfWeek,
        hour: config.schedules.newsletter.hour,
        minute: config.schedules.newsletter.minute,
        weekOfMonth: config.schedules.newsletter.weekOfMonth,
        delayAfterDependency: config.schedules.newsletter.delayAfterDependency,
        // Display fields
        nextRun: config.nextRuns.newsletter,
        lastRun: config.schedules.newsletter.lastRun,
        schedule: scheduler.describeFriendlySchedule(config.schedules.newsletter),
        dependsOn: config.schedules.newsletter.dependsOn,
        status: config.schedules.newsletter.enabled ? 'active' : 'disabled'
      },
      dependencies: config.dependencies
    };
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
}

module.exports = { AdvancedScheduler, setupAdvancedSchedulingEndpoints };
