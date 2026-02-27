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
      // Selector targets page-content links only, excludes PDF downloads and nav
      name: 'NHVR Safety Alerts',
      url: 'https://www.nhvr.gov.au/safety-accreditation-compliance/safety-alerts-and-bulletins',
      priority: 10,
      selector: '.field-items a[href*="/news/"], .field-item a[href*="/news/"], a[href*="/news/202"]',
      titleSelector: null,
      linkSelector: null,
      summarySelector: null,
      category: 'safety',
      enabled: true,
      // Exclude old PDF bulletins — only want recent web-based safety notices
      excludeTitlePatterns: [/^SB\d{4}/, /^SCA-\d{4}/, /vehicle standards bulletin/i, /COVID-19/i]
    },

    // ─────────────────────────────────────────────────────────────
    // TIER 2: Peak bodies — regulatory responses and submissions
    // ─────────────────────────────────────────────────────────────

    {
      // ATA has an RSS feed — most reliable scrape method
      // Falls back to HTML if RSS unavailable
      // requireKeywords: only save articles matching at least one compliance term
      name: 'ATA Media Releases',
      url: 'https://www.truck.net.au/rss.xml',
      priority: 9,
      selector: 'item',                   // RSS <item> elements
      titleSelector: 'title',
      linkSelector: 'link',
      summarySelector: 'description',
      category: 'regulatory',
      enabled: true,
      isRss: true,                        // flag for RSS parsing path
      requireKeywords: [                  // only save if title/summary contains one of these
        'compliance', 'enforcement', 'nhvr', 'hvnl', 'cor ', 'chain of responsibility',
        'fatigue', 'load restraint', 'mass', 'pbs', 'accreditation', 'safety',
        'regulation', 'standard', 'penalty', 'fine', 'licence', 'audit',
        'trucksafe', 'master code', 'submission', 'consultation', 'responds to',
        'welcomes', 'calls for', 'urges', 'warns', 'review'
      ]
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
      // VTA — Victorian Transport Association
      // media-releases page is JS-rendered; scrape news section instead
      name: 'VTA News',
      url: 'https://www.vta.com.au/news',
      priority: 8,
      selector: 'a[href*="/news/"], a[href*="/media-releases/"], a[href*="/post/"]',
      titleSelector: null,
      linkSelector: null,
      summarySelector: 'p',
      category: 'regulatory',
      enabled: false   // Disabled: HTTP 404 on every scrape
    },
    {
      // HVIA — Heavy Vehicle Industry Australia
      // /news/ page only shows nav — try posts feed
      name: 'HVIA News',
      url: 'https://hvia.asn.au/news/',
      priority: 8,
      selector: 'a[href*="/news/"], a[href*="/post/"], a[href*="/article/"], .entry-title a, h2.title a',
      titleSelector: null,
      linkSelector: null,
      summarySelector: '.entry-content p, .post-content p, p',
      category: 'regulatory',
      enabled: true
    },
    // ─────────────────────────────────────────────────────────────
    // TIER 2a: Legal sources — court decisions, prosecutions, WHS
    // ─────────────────────────────────────────────────────────────

    {
      // JADE (Judgments and Decisions Enhanced) — curated RSS alert for CoR/HVNL cases
      // Covers Federal Court, all state Supreme Courts, Fair Work Commission, AAT
      // Registered account: djenkins@level22.com.au — public URL, no auth required
      name: 'JADE Court Decisions',
      url: 'https://jade.io/link.do?alert,224268,-64850387',
      type: 'rss',
      priority: 10,   // Highest — court decisions are primary CoR intelligence
      category: 'enforcement',
      enabled: true,
      // requireKeywords filters out legislation updates, FWC unfair dismissal,
      // workers comp, and other noise — keeps prosecution/enforcement outcomes
      requireKeywords: [
        'sentence', 'sentenced', 'sentencing',
        'plea of guilty', 'convicted', 'conviction',
        'penalty', 'fine', 'infringement',
        'prosecution', 'prosecuted',
        'appeal', 'category 2', 'category 3',
        'nhvr', 'national heavy vehicle regulator',
        'improvement notice', 'prohibition notice',
        'scheduler', 'consignor', 'consignee', 'loading manager',
        'duty', 'breach', 'offence', 'offenses'
      ]
    },
    {
      // Federal Court of Australia — judgments RSS, fallback to JADE
      // Kept as secondary source in case JADE alert misses anything
      name: 'Federal Court Judgments',
      url: 'https://www.judgments.fedcourt.gov.au/rss/fca-judgments',
      type: 'rss',
      priority: 9,
      category: 'enforcement',
      enabled: true,
      requireKeywords: [
        'heavy vehicle', 'chain of responsibility', 'hvnl',
        'transport operator', 'truck', 'fatigue', 'road transport',
        'national heavy vehicle', 'nhvr', 'overloading',
        'consignor', 'consignee', 'scheduler', 'loading manager'
      ]
    },
    {
      // SafeWork NSW — prosecutions, safety alerts, enforceable undertakings
      // Covers WHS Act prosecutions involving transport operators in NSW
      name: 'SafeWork NSW',
      url: 'https://www.safework.nsw.gov.au/__data/assets/xml_file/0004/373975/safework-newsroom.xml',
      type: 'rss',
      priority: 8,
      category: 'enforcement',
      enabled: true,
      requireKeywords: [
        'transport', 'truck', 'driver', 'vehicle', 'freight',
        'prosecution', 'penalty', 'fatigue', 'load', 'chain of responsibility',
        'operator', 'worker', 'fatality', 'serious injury'
      ]
    },

    // ─────────────────────────────────────────────────────────────
    // TIER 2b: Driver wellbeing — mental fitness, health, support
    // These feed the Safe Freight Mate slot 4 wellbeing story
    // ─────────────────────────────────────────────────────────────

    {
      // Healthy Heads in Trucks & Sheds — dedicated transport mental health org
      name: 'Healthy Heads',
      url: 'https://www.healthyheads.org.au/resources/',
      priority: 9,
      selector: 'article, .post, .resource-item, .card, h2 a, h3 a',
      titleSelector: 'h2, h3, .entry-title, .card-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, .card-text, p',
      category: 'wellness',
      enabled: true,
      segmentTag: 'driver'    // Always tag as driver content
    },
    {
      // TWU — Transport Workers Union, member health and wellbeing news
      name: 'TWU News',
      url: 'https://www.twu.com.au/news/',
      priority: 7,
      selector: 'article, .post, h2 a, h3 a',
      titleSelector: 'h2, h3, .entry-title',
      linkSelector: 'a',
      summarySelector: '.excerpt, p',
      category: 'wellness',
      enabled: true,
      segmentTag: 'driver',
      requireKeywords: [
        'health', 'wellbeing', 'mental', 'fatigue', 'stress', 'support',
        'safety', 'driver', 'worker', 'injury', 'wellness', 'fit', 'sleep'
      ]
    },
    {
      // NTC — National Transport Commission: law reform, consultations
      // Disabled: consistently timing out (>30s). Re-enable when resolved.
      name: 'NTC News',
      url: 'https://www.ntc.gov.au/news-and-media/news',
      priority: 9,
      selector: 'article, .news-item, h2 a, h3 a, .views-row',
      titleSelector: 'h2, h3, .title',
      linkSelector: 'a',
      summarySelector: '.excerpt, .summary, p',
      category: 'regulatory',
      enabled: false
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
    'wellness': 10,      // Driver mental health, wellbeing — driver segment priority
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
    'westernroads.com.au',
    // Wellbeing sources
    'healthyheads.org.au',
    'twu.com.au',
    // Legal sources
    'jade.io',
    'judgments.fedcourt.gov.au',
    'safework.nsw.gov.au'
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
