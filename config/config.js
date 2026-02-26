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

    // ─────────────────────────────────────────────────────────────
    // TIER 1: NHVR — Primary regulator (highest priority)
    // ─────────────────────────────────────────────────────────────

    {
      // NHVR news articles: individual URLs follow /news/YYYY/MM/DD/slug
      // The listing page is JS-rendered (Drupal), so we target the
      // static link pattern directly from the homepage.
      name: 'NHVR Latest News',
      url: 'https://www.nhvr.gov.au/news-events/latest-news',
      priority: 10,
      selector: 'a[href*="/news/202"]',   // matches /news/2024/, /news/2025/, /news/2026/
      titleSelector: null,                // link text IS the title
      linkSelector: null,                 // the element itself is the <a>
      summarySelector: null,
      category: 'regulatory',
      enabled: true
    },
    {
      // NHVR "On the Road" newsletter — monthly, high compliance value
      // Lists each issue as a static anchor link
      name: 'NHVR On the Road Newsletter',
      url: 'https://www.nhvr.gov.au/news-events/on-the-road',
      priority: 10,
      selector: 'a[href*="on-the-road/issue"], a[href*="on-the-road/"]',
      titleSelector: null,
      linkSelector: null,
      summarySelector: null,
      category: 'regulatory',
      enabled: true
    },
    {
      // NHVR Safety Alerts and Bulletins — load restraint, defect notices, recalls
      name: 'NHVR Safety Alerts',
      url: 'https://www.nhvr.gov.au/safety-accreditation-compliance/safety-alerts-and-bulletins',
      priority: 10,
      selector: '.field-items a[href], .field-item a[href], a[href*="safety-alert"], a[href*="bulletin"]',
      titleSelector: null,
      linkSelector: null,
      summarySelector: null,
      category: 'safety',
      enabled: true
    },

    // ─────────────────────────────────────────────────────────────
    // TIER 2: Peak bodies — regulatory responses and submissions
    // ─────────────────────────────────────────────────────────────

    {
      // ATA has an RSS feed — most reliable scrape method
      // Falls back to HTML if RSS unavailable
      name: 'ATA Media Releases',
      url: 'https://www.truck.net.au/rss.xml',
      priority: 9,
      selector: 'item',                   // RSS <item> elements
      titleSelector: 'title',
      linkSelector: 'link',
      summarySelector: 'description',
      category: 'regulatory',
      enabled: true,
      isRss: true                         // flag for RSS parsing path
    },
    {
      // ATA frontpage HTML fallback if RSS fails
      name: 'ATA News',
      url: 'https://www.truck.net.au/frontpage',
      priority: 9,
      selector: 'h2 a[href*="/media/"], h3 a[href*="/media/"], h2 a[href*="/news/"], .view-frontpage h2 a',
      titleSelector: null,
      linkSelector: null,
      summarySelector: 'p',
      category: 'regulatory',
      enabled: true
    },
    {
      // VTA — Victorian Transport Association media releases
      name: 'VTA Media Releases',
      url: 'https://www.vta.com.au/media-releases',
      priority: 8,
      selector: 'article, .media-release, .news-item, h2 a, h3 a',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: true
    },
    {
      // HVIA — Heavy Vehicle Industry Australia
      name: 'HVIA News',
      url: 'https://hvia.asn.au/news/',
      priority: 8,
      selector: 'article, .news-item, .post, h2 a, h3 a',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: true
    },
    {
      // NTC — National Transport Commission: law reform, consultations
      name: 'NTC News',
      url: 'https://www.ntc.gov.au/news-and-media/news',
      priority: 9,
      selector: 'article, .news-item, h2 a, h3 a, .views-row',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: true
    },

    // ─────────────────────────────────────────────────────────────
    // TIER 3: Trade press — enforcement stories, industry context
    // Reduced priority — these feed From the Industry slot primarily
    // ─────────────────────────────────────────────────────────────

    {
      name: 'Big Rigs Magazine',
      url: 'https://bigrigs.com.au/',
      priority: 7,
      selector: 'article, .post, .news-story, .story-item',
      titleSelector: 'h2, h3, .story-title, .post-title',
      linkSelector: 'a',
      summarySelector: '.story-excerpt, .excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'PowerTorque Magazine',
      url: 'https://powertorque.com.au/',
      priority: 7,
      selector: 'article, .post, .news-item, .entry',
      titleSelector: 'h2, h3, .entry-title, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .entry-summary, .post-excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Owner Driver Magazine',
      url: 'https://www.ownerdriver.com.au/',
      priority: 7,
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
      priority: 6,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: true
    },
    {
      name: 'Fully Loaded Magazine',
      url: 'https://www.fullyloaded.com.au/',
      priority: 6,
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
      priority: 5,
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
      priority: 5,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: true
    },

    // ─────────────────────────────────────────────────────────────
    // DISABLED — QTA produces traffic alerts, not compliance news
    // Re-enable if a compliance-specific feed becomes available
    // ─────────────────────────────────────────────────────────────

    {
      name: 'Queensland Transport Authority',
      url: 'https://www.qta.com.au/news',
      priority: 3,
      selector: 'article, .news-item, .post, .content-item',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: false   // Disabled: produces road works/traffic alerts, not CoR content
    },
    {
      name: 'Western Roads Federation',
      url: 'https://westernroads.com.au/',
      priority: 4,
      selector: 'article, .post, .news-item',
      titleSelector: 'h2, h3, .post-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'industry',
      enabled: false   // Disabled: low compliance relevance, review before re-enabling
    }
  ],

  // Category-based relevance scoring
  categoryWeights: {
    'regulatory': 20,    // NHVR, NTC, peak bodies — primary source
    'enforcement': 15,   // Court decisions, prosecutions, blitzes
    'safety': 12,        // Safety alerts, incidents, recalls
    'technical': 8,      // Vehicle standards, maintenance
    'industry': 4        // General industry news — trade press filler
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
    // Regulator
    'nhvr.gov.au',
    'ntc.gov.au',
    // Peak bodies
    'truck.net.au',        // ATA
    'vta.com.au',
    'hvia.asn.au',
    'qta.com.au',
    // Trade press
    'powertorque.com.au',
    'bigrigs.com.au',
    'fullyloaded.com.au',
    'ownerdriver.com.au',
    'primemovermag.com.au',
    'trailermag.com.au',
    'truckandbus.net.au',
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
