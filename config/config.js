require('dotenv').config();

module.exports = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_ID
  },
  scraping: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeout: 30000,
    retryAttempts: 3,
    retryDelay: 2000,
    maxArticlesPerSource: 20,
    minContentLength: 100
  },
  sources: [
    // TIER 1: Government and Regulatory (Highest Priority)
    {
      name: 'NHVR Latest News',
      url: 'https://www.nhvr.gov.au/news-events/latest-news',
      priority: 10,
      selector: 'article, .news-item, .post-item, .view-content .views-row, .field-content a[href*="/news/"]',
      titleSelector: 'h2, h3, .field-title, .views-field-title',
      linkSelector: 'a',
      summarySelector: '.field-body, .views-field-body, p',
      category: 'regulatory',
      enabled: true
    },
    {
      name: 'Queensland Transport Authority',
      url: 'https://www.qta.com.au/news',
      priority: 8,
      selector: 'article, .news-item, .post, .content-item',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: true
    },
    {
      name: 'VTA Media Releases',
      url: 'https://www.vta.com.au/media-releases',
      priority: 8,
      selector: 'article, .media-release, .news-item',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: true
    },

    // TIER 2: Major Industry Publications (High Priority)
    {
      name: 'PowerTorque Magazine',
      url: 'https://powertorque.com.au/',
      priority: 9,
      selector: 'article, .post, .news-item, .entry',
      titleSelector: 'h2, h3, .entry-title, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .entry-summary, .post-excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Big Rigs Magazine',
      url: 'https://bigrigs.com.au/',
      priority: 9,
      selector: 'article, .post, .news-story, .story-item',
      titleSelector: 'h2, h3, .story-title, .post-title',
      linkSelector: 'a',
      summarySelector: '.story-excerpt, .excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Fully Loaded Magazine',
      url: 'https://www.fullyloaded.com.au/',
      priority: 8,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Owner Driver Magazine',
      url: 'https://www.ownerdriver.com.au/',
      priority: 8,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Prime Mover Magazine',
      url: 'https://primemovermag.com.au/',
      priority: 8,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Trailer Magazine',
      url: 'https://www.trailermag.com.au/',
      priority: 7,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'technical',
      enabled: true
    },
    {
      name: 'Truck & Bus News',
      url: 'https://www.truckandbus.net.au/',
      priority: 7,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Truck Net Australia',
      url: 'https://www.truck.net.au/frontpage',
      priority: 6,
      selector: 'article, .post, .news-item, .frontpage-item',
      titleSelector: 'h2, h3, .post-title, .item-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'industry',
      enabled: true
    },

    // TIER 3: Industry Associations (Medium Priority)
    {
      name: 'Heavy Vehicle Industry Australia',
      url: 'https://hvia.asn.au/news/',
      priority: 7,
      selector: 'article, .news-item, .post',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: true
    },
    {
      name: 'Western Roads Federation',
      url: 'https://westernroads.com.au/',
      priority: 6,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: true
    }
  ],

  // Category-based relevance scoring
  categoryWeights: {
    'regulatory': 15,    // NHVR, government agencies
    'enforcement': 12,   // Court decisions, prosecutions
    'safety': 10,        // Safety alerts, incidents
    'technical': 8,      // Vehicle standards, maintenance
    'industry': 6        // General industry news
  },

  // Content quality scoring keywords
  relevanceKeywords: {
    // High priority CoR terms
    'chain of responsibility': 15,
    'cor': 10,
    'hvnl': 15,
    'heavy vehicle national law': 15,
    'nhvr': 12,
    
    // Enforcement terms  
    'enforcement': 10,
    'compliance': 8,
    'penalty': 8,
    'court': 7,
    'prosecution': 9,
    'fine': 6,
    'sentenced': 8,
    'conviction': 7,
    
    // Safety terms
    'fatigue': 8,
    'mass': 6,
    'load restraint': 7,
    'maintenance': 5,
    'defect': 6,
    'roadworthy': 6,
    'safety alert': 10,
    'accident': 7,
    'incident': 6,
    
    // Vehicle terms
    'heavy vehicle': 6,
    'truck': 4,
    'trailer': 3,
    'prime mover': 4,
    'b-double': 5,
    'road train': 5,
    
    // Industry terms
    'transport': 3,
    'freight': 4,
    'logistics': 3,
    'carrier': 4,
    'operator': 3
  },

  // URL patterns to validate authentic sources
  allowedDomains: [
    'nhvr.gov.au',
    'powertorque.com.au', 
    'bigrigs.com.au',
    'fullyloaded.com.au',
    'ownerdriver.com.au',
    'primemovermag.com.au',
    'trailermag.com.au',
    'truckandbus.net.au',
    'truck.net.au',
    'hvia.asn.au',
    'qta.com.au',
    'vta.com.au',
    'westernroads.com.au'
  ],

  // Rate limiting configuration
  rateLimiting: {
    requestsPerSource: 20,
    delayBetweenSources: 3000, // 3 seconds
    delayBetweenRequests: 1000, // 1 second
    maxConcurrentSources: 3
  },

  // Content filtering
  contentFilters: {
    minTitleLength: 15,
    maxTitleLength: 200,
    minSummaryLength: 50,
    maxSummaryLength: 500,
    excludePatterns: [
      /advertisement/i,
      /sponsored/i,
      /classifieds/i,
      /job vacancy/i,
      /for sale/i
    ]
  }
};